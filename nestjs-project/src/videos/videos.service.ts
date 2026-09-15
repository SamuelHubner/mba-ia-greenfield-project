import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import uploadConfig from '../config/upload.config';
import { StoragePartError } from '../storage/exceptions/storage.exception';
import {
  CompletedPart,
  PresignedUrl,
  StorageService,
  StoredPart,
} from '../storage/storage.service';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoUpload } from './entities/video-upload.entity';
import {
  FileTooLargeException,
  InvalidPartNumbersException,
  InvalidPartsException,
  UnsupportedVideoFormatException,
  UploadExpiredException,
  UploadNotActiveException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { generateUrlId, URL_ID_REGEX } from './url-id.util';

/** S3 hard limit on parts per multipart upload (upload-policy/TD-02). */
export const MAX_PART_COUNT = 10_000;
const URL_ID_MAX_ATTEMPTS = 5;
const VIDEO_MIME_PREFIX = 'video/';

/** Causes recorded in `videos.processing_error` by the API (phase-03-videos/TD-07). */
export const UPLOAD_EXPIRED_CAUSE = 'UPLOAD_EXPIRED';
export const FILE_TOO_LARGE_CAUSE = 'FILE_TOO_LARGE';

export interface InitiateUploadInput {
  fileName: string;
  mimeType: string;
  fileSize: number;
}

export interface PartUrl {
  partNumber: number;
  url: string;
  expiresAt: Date;
}

export interface UploadStatus {
  status: VideoStatus;
  partSize: number;
  partCount: number;
  uploadExpiresAt: Date;
  uploadedParts: StoredPart[];
}

export interface DownloadUrl extends PresignedUrl {
  fileName: string;
}

/** A video whose one-to-one upload session is loaded. */
export type VideoWithUpload = Video & { upload: VideoUpload };

/**
 * Orchestrates the presigned multipart upload lifecycle as pure business
 * rules (phase-03-videos/TD-02): the bytes never touch the API.
 */
@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    @InjectRepository(VideoUpload)
    private readonly uploads: Repository<VideoUpload>,
    private readonly dataSource: DataSource,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly producer: VideoProcessingProducer,
    @Inject(uploadConfig.KEY)
    private readonly config: ConfigType<typeof uploadConfig>,
  ) {}

  /**
   * Validates the declared file against the upload policy, opens the
   * multipart upload and persists the draft `Video` + `VideoUpload` in one
   * transaction. Nothing is persisted when the storage call fails.
   */
  async initiateUpload(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<VideoWithUpload> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const ext = extractExtension(input.fileName);
    if (
      !ext ||
      !this.config.allowedExtensions.includes(ext) ||
      !input.mimeType.toLowerCase().startsWith(VIDEO_MIME_PREFIX)
    ) {
      throw new UnsupportedVideoFormatException();
    }

    if (input.fileSize > this.config.maxFileSizeBytes) {
      throw new FileTooLargeException();
    }
    const partSize = this.config.partSizeBytes;
    const partCount = Math.ceil(input.fileSize / partSize);
    if (partCount > MAX_PART_COUNT) {
      throw new FileTooLargeException(
        `File would need more than ${MAX_PART_COUNT} parts`,
      );
    }

    const urlId = await this.allocateUrlId();
    const id = randomUUID();
    const sourceKey = `videos/${id}/source.${ext}`;

    const uploadId = await this.storage.createMultipartUpload(
      sourceKey,
      input.mimeType,
    );

    const now = new Date();
    const video = this.videos.create({
      id,
      url_id: urlId,
      channel_id: channel.id,
      status: VideoStatus.DRAFT,
      original_file_name: input.fileName,
      mime_type: input.mimeType,
      source_ext: ext,
      source_key: sourceKey,
      declared_size_bytes: input.fileSize,
    });
    const upload = this.uploads.create({
      video_id: id,
      storage_upload_id: uploadId,
      part_size: partSize,
      part_count: partCount,
      uploadExpiresAt: new Date(
        now.getTime() + this.config.sessionTtlHours * 60 * 60 * 1000,
      ),
    });

    try {
      await this.persist(video, upload);
    } catch (error) {
      // Compensate: never leave a multipart session without its DB rows.
      await this.abortInStorage(video, upload).catch((abortError: Error) =>
        this.logger.warn(
          `Could not abort multipart ${uploadId} after DB failure: ${abortError.message}`,
        ),
      );
      throw error;
    }

    video.upload = upload;
    return video as VideoWithUpload;
  }

  /**
   * Resolves a video by public id scoped to the caller's channel. Any miss
   * (bad format, unknown id, other owner) is `VIDEO_NOT_FOUND`.
   */
  async findOwnedOrThrow(userId: string, urlId: string): Promise<Video> {
    if (!URL_ID_REGEX.test(urlId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videos.findOne({
      where: { url_id: urlId, channel: { user_id: userId } },
      relations: { channel: true, upload: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /**
   * Guards the upload sub-resource: the video must still be `draft` and the
   * session must not have passed its deadline (lazy expiry — the multipart
   * upload is aborted and the draft moves to `error`).
   */
  async assertActiveUpload(video: Video): Promise<VideoWithUpload> {
    if (video.status !== VideoStatus.DRAFT) {
      throw new UploadNotActiveException();
    }
    const upload = this.requireUpload(video);
    await this.expireIfNeeded(video, upload);
    return video as VideoWithUpload;
  }

  /** Presigned `UploadPart` URLs for a batch of part numbers (upload-policy/TD-03). */
  async issuePartUrls(
    userId: string,
    urlId: string,
    partNumbers: number[],
  ): Promise<PartUrl[]> {
    const video = await this.assertActiveUpload(
      await this.findOwnedOrThrow(userId, urlId),
    );
    const { upload } = video;

    const seen = new Set<number>();
    for (const partNumber of partNumbers) {
      if (
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > upload.part_count ||
        seen.has(partNumber)
      ) {
        throw new InvalidPartNumbersException();
      }
      seen.add(partNumber);
    }

    return Promise.all(
      partNumbers.map(async (partNumber) => {
        const presigned = await this.storage.presignUploadPart(
          video.source_key,
          upload.storage_upload_id,
          partNumber,
          this.config.partUrlTtlSeconds,
        );
        return { partNumber, ...presigned };
      }),
    );
  }

  /** Resume information: which parts the storage already holds (empty when not active). */
  async getUploadStatus(userId: string, urlId: string): Promise<UploadStatus> {
    const video = await this.findOwnedOrThrow(userId, urlId);
    const upload = this.requireUpload(video);

    let uploadedParts: StoredPart[] = [];
    if (video.status === VideoStatus.DRAFT) {
      await this.expireIfNeeded(video, upload);
      try {
        uploadedParts = await this.storage.listParts(
          video.source_key,
          upload.storage_upload_id,
        );
      } catch (error) {
        throw this.mapPartError(error);
      }
    }

    return {
      status: video.status,
      partSize: upload.part_size,
      partCount: upload.part_count,
      uploadExpiresAt: upload.uploadExpiresAt,
      uploadedParts,
    };
  }

  /**
   * Completes the multipart upload, verifies the real object size against
   * the declared size and the cap (upload-policy/TD-01), moves the video to
   * `processing` and enqueues the `process-video` job.
   */
  async completeUpload(
    userId: string,
    urlId: string,
    parts: CompletedPart[],
  ): Promise<Video> {
    const video = await this.assertActiveUpload(
      await this.findOwnedOrThrow(userId, urlId),
    );
    const { upload } = video;

    if (parts.length !== upload.part_count) {
      throw new InvalidPartsException(
        `Expected ${upload.part_count} parts, received ${parts.length}`,
      );
    }
    parts.forEach((part, index) => {
      // Full, strictly ascending and unique ⇔ part i is exactly i + 1.
      if (part.partNumber !== index + 1 || !part.etag) {
        throw new InvalidPartsException();
      }
    });

    try {
      await this.storage.completeMultipartUpload(
        video.source_key,
        upload.storage_upload_id,
        parts,
      );
    } catch (error) {
      throw this.mapPartError(error);
    }

    const head = await this.storage.headObject(video.source_key);
    if (
      head.contentLength > video.declared_size_bytes ||
      head.contentLength > this.config.maxFileSizeBytes
    ) {
      await this.storage.deleteObject(video.source_key);
      video.status = VideoStatus.ERROR;
      video.processing_error = FILE_TOO_LARGE_CAUSE;
      await this.persist(video, upload);
      throw new FileTooLargeException(
        'Uploaded object exceeds the declared file size',
      );
    }

    video.sizeBytes = head.contentLength;
    video.status = VideoStatus.PROCESSING;
    upload.completed_at = new Date();
    await this.persist(video, upload);

    await this.producer.enqueue(video.id);
    return video;
  }

  /** Client cancel: aborts the multipart session and discards the draft rows. */
  async abortUpload(userId: string, urlId: string): Promise<void> {
    const video = await this.findOwnedOrThrow(userId, urlId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new UploadNotActiveException();
    }
    const upload = this.requireUpload(video);

    await this.abortInStorage(video, upload);
    // `video_uploads.video_id` cascades on delete.
    await this.videos.delete({ id: video.id });
  }

  // ---- read / delivery (phase-03-videos/TD-05, TD-06) ------------------

  /** Registry entry by public id; `thumbnailUrl` is presigned only once `ready`. */
  async getByUrlId(userId: string, urlId: string): Promise<VideoResponseDto> {
    const video = await this.findOwnedOrThrow(userId, urlId);

    let thumbnailUrl: string | null = null;
    if (video.status === VideoStatus.READY && video.thumbnail_key) {
      const presigned = await this.storage.presignGetObject(
        video.thumbnail_key,
        this.config.streamUrlTtlSeconds,
      );
      thumbnailUrl = presigned.url;
    }

    return {
      urlId: video.url_id,
      status: video.status,
      originalFileName: video.original_file_name,
      mimeType: video.mime_type,
      durationSeconds: video.durationSeconds,
      width: video.width,
      height: video.height,
      videoCodec: video.videoCodec,
      sizeBytes: video.sizeBytes,
      thumbnailUrl,
      processingError:
        video.status === VideoStatus.ERROR ? video.processing_error : null,
      createdAt: video.created_at.toISOString(),
      processedAt: video.processed_at?.toISOString() ?? null,
    };
  }

  /** Short-lived presigned GET; the storage serves Range/206 (upload-policy/TD-04). */
  async getStreamUrl(userId: string, urlId: string): Promise<PresignedUrl> {
    const video = await this.findReadyOrThrow(userId, urlId);
    return this.storage.presignGetObject(
      video.source_key,
      this.config.streamUrlTtlSeconds,
    );
  }

  /** Same mechanism with an attachment disposition signed into the URL. */
  async getDownloadUrl(userId: string, urlId: string): Promise<DownloadUrl> {
    const video = await this.findReadyOrThrow(userId, urlId);
    const presigned = await this.storage.presignGetObject(
      video.source_key,
      this.config.downloadUrlTtlSeconds,
      { attachmentFileName: video.original_file_name },
    );
    return { ...presigned, fileName: video.original_file_name };
  }

  // ---- internals -------------------------------------------------------

  private async findReadyOrThrow(
    userId: string,
    urlId: string,
  ): Promise<Video> {
    const video = await this.findOwnedOrThrow(userId, urlId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async allocateUrlId(): Promise<string> {
    for (let attempt = 0; attempt < URL_ID_MAX_ATTEMPTS; attempt++) {
      const candidate = generateUrlId();
      if (!(await this.videos.existsBy({ url_id: candidate }))) {
        return candidate;
      }
    }
    throw new Error(
      `Could not allocate a unique url_id after ${URL_ID_MAX_ATTEMPTS} attempts`,
    );
  }

  private requireUpload(video: Video): VideoUpload {
    if (!video.upload) {
      throw new UploadNotActiveException();
    }
    return video.upload;
  }

  private async expireIfNeeded(
    video: Video,
    upload: VideoUpload,
  ): Promise<void> {
    const now = new Date();
    if (upload.uploadExpiresAt.getTime() > now.getTime()) {
      return;
    }
    await this.abortInStorage(video, upload);
    upload.aborted_at = now;
    video.status = VideoStatus.ERROR;
    video.processing_error = UPLOAD_EXPIRED_CAUSE;
    await this.persist(video, upload);
    throw new UploadExpiredException();
  }

  /** Aborts in the storage, tolerating a session the storage already dropped. */
  private async abortInStorage(
    video: Video,
    upload: VideoUpload,
  ): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(
        video.source_key,
        upload.storage_upload_id,
      );
    } catch (error) {
      if (error instanceof StoragePartError && error.code === 'NoSuchUpload') {
        return;
      }
      throw error;
    }
  }

  private mapPartError(error: unknown): Error {
    if (error instanceof StoragePartError) {
      return error.code === 'NoSuchUpload'
        ? new UploadNotActiveException()
        : new InvalidPartsException(
            `Storage rejected the parts: ${error.code}`,
          );
    }
    return error as Error;
  }

  private async persist(video: Video, upload: VideoUpload): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.save(Video, video);
      await manager.save(VideoUpload, upload);
    });
  }
}

/** Lower-cased extension after the last dot, or `null` when there is none. */
function extractExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) {
    return null;
  }
  return fileName.slice(dot + 1).toLowerCase();
}
