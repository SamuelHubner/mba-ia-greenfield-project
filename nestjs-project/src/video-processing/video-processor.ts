import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import uploadConfig from '../config/upload.config';
import { StorageObjectNotFound } from '../storage/exceptions/storage.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg/ffmpeg.service';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import {
  processingCauseOf,
  SourceNotFoundError,
} from './video-processing.errors';

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

export function thumbnailKeyFor(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}

/**
 * Consumer of `process-video` (Events/Messages → Processing steps). Runs in
 * the standalone worker app, never in the API process (phase-03-videos/TD-03).
 * Idempotent: every attempt re-probes, re-uploads the thumbnail and overwrites
 * the metadata; a video that is no longer `processing` is left untouched.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
    @Inject(uploadConfig.KEY)
    private readonly config: ConfigType<typeof uploadConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videos.findOne({ where: { id: videoId } });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.warn(
        `Skipping job ${job.id ?? '?'}: video ${videoId} is ${video?.status ?? 'missing'}`,
      );
      return;
    }

    const sizeBytes = await this.sourceSize(video.source_key);
    const { url } = await this.storage.presignInternalGetObject(
      video.source_key,
      this.config.streamUrlTtlSeconds,
    );

    const probe = await this.ffmpeg.probe(url);
    const frame = await this.ffmpeg.captureFrame(
      url,
      this.ffmpeg.thumbnailTimestamp(probe.durationSeconds),
    );
    const thumbnailKey = thumbnailKeyFor(video.id);
    await this.storage.putObject(thumbnailKey, frame, THUMBNAIL_CONTENT_TYPE);

    await this.videos.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        durationSeconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        videoCodec: probe.videoCodec,
        sizeBytes,
        thumbnail_key: thumbnailKey,
        processing_error: null,
        status: VideoStatus.READY,
        processed_at: new Date(),
      },
    );
    this.logger.log(`Video ${video.id} is ready (${probe.durationSeconds}s)`);
  }

  /**
   * Terminal failure only: intermediate attempts leave `processing` so the
   * queue retries with backoff (phase-03-videos/TD-07).
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) {
      return;
    }
    const attempts = job.opts.attempts ?? 1;
    const cause = processingCauseOf(error);
    if (job.attemptsMade < attempts) {
      this.logger.warn(
        `Job ${job.id ?? '?'} attempt ${job.attemptsMade}/${attempts} failed (${cause}); will retry`,
      );
      return;
    }

    this.logger.error(
      `Video ${job.data.videoId} failed permanently: ${cause} — ${error.message}`,
    );
    await this.videos.update(
      { id: job.data.videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.ERROR,
        processing_error: cause,
        processed_at: new Date(),
      },
    );
  }

  private async sourceSize(sourceKey: string): Promise<number> {
    try {
      const head = await this.storage.headObject(sourceKey);
      return head.contentLength;
    } catch (error) {
      if (error instanceof StorageObjectNotFound) {
        throw new SourceNotFoundError(sourceKey);
      }
      throw error;
    }
  }
}
