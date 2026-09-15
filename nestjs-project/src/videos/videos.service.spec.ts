import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import uploadConfig from '../config/upload.config';
import { StoragePartError } from '../storage/exceptions/storage.exception';
import { StorageService } from '../storage/storage.service';
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
import { URL_ID_REGEX } from './url-id.util';
import {
  FILE_TOO_LARGE_CAUSE,
  UPLOAD_EXPIRED_CAUSE,
  VideosService,
} from './videos.service';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const config = {
  maxFileSizeBytes: 10 * GIB,
  partSizeBytes: 64 * MIB,
  partUrlTtlSeconds: 3600,
  sessionTtlHours: 24,
  allowedExtensions: ['mp4', 'webm', 'mov', 'mkv', 'avi'],
  streamUrlTtlSeconds: 21600,
  downloadUrlTtlSeconds: 3600,
};

const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const URL_ID = 'AbC123xYz09';
const UPLOAD_ID = 'storage-upload-id';

function buildVideo(overrides: Partial<Video> = {}): Video {
  const video = new Video();
  video.id = 'video-1';
  video.url_id = URL_ID;
  video.channel_id = CHANNEL_ID;
  video.status = VideoStatus.DRAFT;
  video.original_file_name = 'clip.mp4';
  video.mime_type = 'video/mp4';
  video.source_ext = 'mp4';
  video.source_key = 'videos/video-1/source.mp4';
  video.declared_size_bytes = 200 * MIB;
  video.durationSeconds = null;
  video.width = null;
  video.height = null;
  video.videoCodec = null;
  video.sizeBytes = null;
  video.thumbnail_key = null;
  video.processing_error = null;
  video.processed_at = null;

  const upload = new VideoUpload();
  upload.id = 'upload-1';
  upload.video_id = video.id;
  upload.storage_upload_id = UPLOAD_ID;
  upload.part_size = 64 * MIB;
  upload.part_count = 4;
  upload.uploadExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  upload.completed_at = null;
  upload.aborted_at = null;
  video.upload = upload;

  return Object.assign(video, overrides);
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    findOne: jest.Mock;
    existsBy: jest.Mock;
    delete: jest.Mock;
  };
  let uploadRepository: { create: jest.Mock };
  let manager: { save: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let channelsService: jest.Mocked<Pick<ChannelsService, 'findByUserId'>>;
  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'createMultipartUpload'
      | 'presignUploadPart'
      | 'listParts'
      | 'completeMultipartUpload'
      | 'abortMultipartUpload'
      | 'headObject'
      | 'deleteObject'
      | 'presignGetObject'
    >
  >;
  let producer: jest.Mocked<Pick<VideoProcessingProducer, 'enqueue'>>;

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((partial: Partial<Video>) =>
        Object.assign(new Video(), partial),
      ),
      findOne: jest.fn(),
      existsBy: jest.fn().mockResolvedValue(false),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    uploadRepository = {
      create: jest.fn((partial: Partial<VideoUpload>) =>
        Object.assign(new VideoUpload(), partial),
      ),
    };
    manager = { save: jest.fn().mockImplementation((_, entity) => entity) };
    dataSource = {
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
        cb(manager),
      ),
    };
    channelsService = {
      findByUserId: jest
        .fn()
        .mockResolvedValue({ id: CHANNEL_ID, user_id: USER_ID }),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue(UPLOAD_ID),
      presignUploadPart: jest.fn().mockImplementation((_k, _u, partNumber) =>
        Promise.resolve({
          url: `http://minio/part/${partNumber}`,
          expiresAt: new Date(Date.now() + 3600 * 1000),
        }),
      ),
      listParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn(),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      presignGetObject: jest.fn().mockImplementation((key: string) =>
        Promise.resolve({
          url: `http://minio/${key}?signed`,
          expiresAt: new Date(Date.now() + 3600 * 1000),
        }),
      ),
    };
    producer = { enqueue: jest.fn().mockResolvedValue('video-1') };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        {
          provide: getRepositoryToken(VideoUpload),
          useValue: uploadRepository,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingProducer, useValue: producer },
        { provide: uploadConfig.KEY, useValue: config },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    const validInput = {
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      fileSize: 200 * MIB,
    };

    it('should reject an extension outside the allowlist without touching storage or DB', async () => {
      await expect(
        service.initiateUpload(USER_ID, { ...validInput, fileName: 'a.exe' }),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('should reject a non-video mime type', async () => {
      await expect(
        service.initiateUpload(USER_ID, {
          ...validInput,
          mimeType: 'image/png',
        }),
      ).rejects.toMatchObject({ errorCode: 'UNSUPPORTED_VIDEO_FORMAT' });
    });

    it('should reject a declared size above the cap as FILE_TOO_LARGE', async () => {
      await expect(
        service.initiateUpload(USER_ID, {
          ...validInput,
          fileSize: 10 * GIB + 1,
        }),
      ).rejects.toBeInstanceOf(FileTooLargeException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('should reject a file that would need more than 10 000 parts', async () => {
      const module = await Test.createTestingModule({
        providers: [
          VideosService,
          { provide: getRepositoryToken(Video), useValue: videoRepository },
          {
            provide: getRepositoryToken(VideoUpload),
            useValue: uploadRepository,
          },
          { provide: DataSource, useValue: dataSource },
          { provide: ChannelsService, useValue: channelsService },
          { provide: StorageService, useValue: storage },
          { provide: VideoProcessingProducer, useValue: producer },
          {
            provide: uploadConfig.KEY,
            useValue: { ...config, partSizeBytes: 1 * MIB },
          },
        ],
      }).compile();

      await expect(
        module
          .get(VideosService)
          .initiateUpload(USER_ID, { ...validInput, fileSize: 10_001 * MIB }),
      ).rejects.toMatchObject({ errorCode: 'FILE_TOO_LARGE' });
    });

    it('should compute partCount as ceil(fileSize / partSize) and persist draft + session', async () => {
      const before = Date.now();

      const video = await service.initiateUpload(USER_ID, {
        ...validInput,
        fileSize: 200 * MIB, // 3.125 parts of 64 MiB → 4
      });

      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.url_id).toMatch(URL_ID_REGEX);
      expect(video.channel_id).toBe(CHANNEL_ID);
      expect(video.source_ext).toBe('mp4');
      expect(video.source_key).toBe(`videos/${video.id}/source.mp4`);
      expect(video.upload.part_size).toBe(64 * MIB);
      expect(video.upload.part_count).toBe(4);
      expect(video.upload.storage_upload_id).toBe(UPLOAD_ID);
      const ttlMs = 24 * 60 * 60 * 1000;
      expect(video.upload.uploadExpiresAt.getTime()).toBeGreaterThanOrEqual(
        before + ttlMs,
      );
      expect(video.upload.uploadExpiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + ttlMs,
      );

      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        video.source_key,
        'video/mp4',
      );
      expect(manager.save).toHaveBeenCalledWith(Video, video);
      expect(manager.save).toHaveBeenCalledWith(VideoUpload, video.upload);
    });

    it('should retry url_id generation on collision', async () => {
      videoRepository.existsBy
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const video = await service.initiateUpload(USER_ID, validInput);

      expect(videoRepository.existsBy).toHaveBeenCalledTimes(2);
      const [first, second] = videoRepository.existsBy.mock.calls;
      expect(first[0]).not.toEqual(second[0]);
      expect(video.url_id).toEqual((second[0] as { url_id: string }).url_id);
    });

    it('should not persist anything when the storage fails', async () => {
      storage.createMultipartUpload.mockRejectedValueOnce(
        new Error('minio down'),
      );

      await expect(service.initiateUpload(USER_ID, validInput)).rejects.toThrow(
        'minio down',
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('should abort the multipart session when the DB transaction fails', async () => {
      dataSource.transaction.mockRejectedValueOnce(new Error('db down'));

      await expect(service.initiateUpload(USER_ID, validInput)).rejects.toThrow(
        'db down',
      );

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source\.mp4$/),
        UPLOAD_ID,
      );
    });
  });

  describe('findOwnedOrThrow', () => {
    it('should reject an urlId that is not 11 base62 chars without querying', async () => {
      await expect(
        service.findOwnedOrThrow(USER_ID, 'not-valid'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect(videoRepository.findOne).not.toHaveBeenCalled();
    });

    it("should hide another user's video behind VIDEO_NOT_FOUND", async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOwnedOrThrow('other-user', URL_ID),
      ).rejects.toMatchObject({
        errorCode: 'VIDEO_NOT_FOUND',
        httpStatus: 404,
      });

      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { url_id: URL_ID, channel: { user_id: 'other-user' } },
        relations: { channel: true, upload: true },
      });
    });
  });

  describe('issuePartUrls', () => {
    it('should reject part numbers outside 1..partCount or repeated', async () => {
      videoRepository.findOne.mockResolvedValue(buildVideo());

      await expect(
        service.issuePartUrls(USER_ID, URL_ID, [0]),
      ).rejects.toBeInstanceOf(InvalidPartNumbersException);
      await expect(
        service.issuePartUrls(USER_ID, URL_ID, [5]),
      ).rejects.toBeInstanceOf(InvalidPartNumbersException);
      await expect(
        service.issuePartUrls(USER_ID, URL_ID, [1, 1]),
      ).rejects.toBeInstanceOf(InvalidPartNumbersException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should presign one URL per requested part with the configured TTL', async () => {
      const video = buildVideo();
      videoRepository.findOne.mockResolvedValue(video);

      const urls = await service.issuePartUrls(USER_ID, URL_ID, [2, 4]);

      expect(urls).toEqual([
        {
          partNumber: 2,
          url: 'http://minio/part/2',
          expiresAt: expect.any(Date),
        },
        {
          partNumber: 4,
          url: 'http://minio/part/4',
          expiresAt: expect.any(Date),
        },
      ]);
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        video.source_key,
        UPLOAD_ID,
        2,
        3600,
      );
    });

    it('should reject a video that is no longer draft as UPLOAD_NOT_ACTIVE', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.issuePartUrls(USER_ID, URL_ID, [1]),
      ).rejects.toBeInstanceOf(UploadNotActiveException);
    });

    it('should abort the session and mark the draft as error when it has expired', async () => {
      const video = buildVideo();
      video.upload!.uploadExpiresAt = new Date(Date.now() - 1000);
      videoRepository.findOne.mockResolvedValue(video);

      await expect(
        service.issuePartUrls(USER_ID, URL_ID, [1]),
      ).rejects.toBeInstanceOf(UploadExpiredException);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        video.source_key,
        UPLOAD_ID,
      );
      expect(video.status).toBe(VideoStatus.ERROR);
      expect(video.processing_error).toBe(UPLOAD_EXPIRED_CAUSE);
      expect(video.upload!.aborted_at).toBeInstanceOf(Date);
      expect(manager.save).toHaveBeenCalledWith(Video, video);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });
  });

  describe('getUploadStatus', () => {
    it('should list the stored parts while the session is active', async () => {
      const video = buildVideo();
      videoRepository.findOne.mockResolvedValue(video);
      storage.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"a"', size: 64 * MIB },
      ]);

      const status = await service.getUploadStatus(USER_ID, URL_ID);

      expect(status).toEqual({
        status: VideoStatus.DRAFT,
        partSize: 64 * MIB,
        partCount: 4,
        uploadExpiresAt: video.upload!.uploadExpiresAt,
        uploadedParts: [{ partNumber: 1, etag: '"a"', size: 64 * MIB }],
      });
    });

    it('should return an empty part list without calling the storage when not active', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.READY }),
      );

      const status = await service.getUploadStatus(USER_ID, URL_ID);

      expect(status.status).toBe(VideoStatus.READY);
      expect(status.uploadedParts).toEqual([]);
      expect(storage.listParts).not.toHaveBeenCalled();
    });

    it('should expire a stale draft on query', async () => {
      const video = buildVideo();
      video.upload!.uploadExpiresAt = new Date(Date.now() - 1);
      videoRepository.findOne.mockResolvedValue(video);

      await expect(
        service.getUploadStatus(USER_ID, URL_ID),
      ).rejects.toMatchObject({ errorCode: 'UPLOAD_EXPIRED', httpStatus: 410 });
      expect(video.processing_error).toBe(UPLOAD_EXPIRED_CAUSE);
    });
  });

  describe('completeUpload', () => {
    const fullParts = [1, 2, 3, 4].map((partNumber) => ({
      partNumber,
      etag: `"etag-${partNumber}"`,
    }));

    it('should reject an incomplete or out-of-order part list as INVALID_PARTS', async () => {
      videoRepository.findOne.mockResolvedValue(buildVideo());

      await expect(
        service.completeUpload(USER_ID, URL_ID, fullParts.slice(0, 3)),
      ).rejects.toBeInstanceOf(InvalidPartsException);
      await expect(
        service.completeUpload(USER_ID, URL_ID, [
          fullParts[1],
          fullParts[0],
          fullParts[2],
          fullParts[3],
        ]),
      ).rejects.toBeInstanceOf(InvalidPartsException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should map a storage part rejection to INVALID_PARTS', async () => {
      videoRepository.findOne.mockResolvedValue(buildVideo());
      storage.completeMultipartUpload.mockRejectedValueOnce(
        new StoragePartError('InvalidPart'),
      );

      await expect(
        service.completeUpload(USER_ID, URL_ID, fullParts),
      ).rejects.toMatchObject({ errorCode: 'INVALID_PARTS', httpStatus: 400 });
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should delete the object and mark FILE_TOO_LARGE when the real size exceeds the declared size', async () => {
      const video = buildVideo();
      videoRepository.findOne.mockResolvedValue(video);
      storage.headObject.mockResolvedValue({
        contentLength: video.declared_size_bytes + 1,
        contentType: 'video/mp4',
      });

      await expect(
        service.completeUpload(USER_ID, URL_ID, fullParts),
      ).rejects.toBeInstanceOf(FileTooLargeException);

      expect(storage.deleteObject).toHaveBeenCalledWith(video.source_key);
      expect(video.status).toBe(VideoStatus.ERROR);
      expect(video.processing_error).toBe(FILE_TOO_LARGE_CAUSE);
      expect(manager.save).toHaveBeenCalledWith(Video, video);
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should move the video to processing, record the real size and enqueue the job', async () => {
      const video = buildVideo();
      videoRepository.findOne.mockResolvedValue(video);
      storage.headObject.mockResolvedValue({
        contentLength: 199 * MIB,
        contentType: 'video/mp4',
      });

      const result = await service.completeUpload(USER_ID, URL_ID, fullParts);

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        video.source_key,
        UPLOAD_ID,
        fullParts,
      );
      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.sizeBytes).toBe(199 * MIB);
      expect(video.upload!.completed_at).toBeInstanceOf(Date);
      expect(manager.save).toHaveBeenCalledWith(VideoUpload, video.upload);
      expect(producer.enqueue).toHaveBeenCalledWith(video.id);
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('abortUpload', () => {
    it('should abort in the storage and delete the draft rows', async () => {
      const video = buildVideo();
      videoRepository.findOne.mockResolvedValue(video);

      await service.abortUpload(USER_ID, URL_ID);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        video.source_key,
        UPLOAD_ID,
      );
      expect(videoRepository.delete).toHaveBeenCalledWith({ id: video.id });
    });

    it('should reject aborting a video that is no longer draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(service.abortUpload(USER_ID, URL_ID)).rejects.toBeInstanceOf(
        UploadNotActiveException,
      );
      expect(videoRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('getByUrlId', () => {
    it('should presign the thumbnail only for a ready video with a thumbnail key', async () => {
      const video = buildVideo({
        status: VideoStatus.READY,
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
        durationSeconds: 125,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        sizeBytes: 199 * MIB,
        created_at: new Date('2026-09-15T12:00:00.000Z'),
        processed_at: new Date('2026-09-15T12:01:30.000Z'),
      });
      videoRepository.findOne.mockResolvedValue(video);

      const result = await service.getByUrlId(USER_ID, URL_ID);

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
        config.streamUrlTtlSeconds,
      );
      expect(result).toEqual({
        urlId: URL_ID,
        status: VideoStatus.READY,
        originalFileName: 'clip.mp4',
        mimeType: 'video/mp4',
        durationSeconds: 125,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        sizeBytes: 199 * MIB,
        thumbnailUrl: 'http://minio/videos/video-1/thumbnail.jpg?signed',
        processingError: null,
        createdAt: '2026-09-15T12:00:00.000Z',
        processedAt: '2026-09-15T12:01:30.000Z',
      });
    });

    it('should return null metadata and no thumbnail for a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ created_at: new Date(), processed_at: null }),
      );

      const result = await service.getByUrlId(USER_ID, URL_ID);

      expect(storage.presignGetObject).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: VideoStatus.DRAFT,
        durationSeconds: null,
        sizeBytes: null,
        thumbnailUrl: null,
        processingError: null,
        processedAt: null,
      });
    });

    it('should expose processingError only when the video is in error', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({
          status: VideoStatus.ERROR,
          processing_error: 'FFPROBE_FAILED',
          created_at: new Date(),
          processed_at: new Date(),
        }),
      );

      const result = await service.getByUrlId(USER_ID, URL_ID);

      expect(result.processingError).toBe('FFPROBE_FAILED');
      expect(result.thumbnailUrl).toBeNull();
    });

    it("should hide another user's video behind VIDEO_NOT_FOUND", async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getByUrlId('other-user', URL_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('getStreamUrl / getDownloadUrl', () => {
    it('should reject a video that is not ready as VIDEO_NOT_READY', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.getStreamUrl(USER_ID, URL_ID),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
      await expect(
        service.getDownloadUrl(USER_ID, URL_ID),
      ).rejects.toMatchObject({
        errorCode: 'VIDEO_NOT_READY',
        httpStatus: 409,
      });
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    });

    it('should presign the stream URL with the stream TTL and no disposition', async () => {
      const video = buildVideo({ status: VideoStatus.READY });
      videoRepository.findOne.mockResolvedValue(video);

      const result = await service.getStreamUrl(USER_ID, URL_ID);

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        video.source_key,
        config.streamUrlTtlSeconds,
      );
      expect(result.url).toBe(`http://minio/${video.source_key}?signed`);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('should presign the download URL with the download TTL and the original file name', async () => {
      const video = buildVideo({
        status: VideoStatus.READY,
        original_file_name: 'My Holiday.mp4',
      });
      videoRepository.findOne.mockResolvedValue(video);

      const result = await service.getDownloadUrl(USER_ID, URL_ID);

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        video.source_key,
        config.downloadUrlTtlSeconds,
        { attachmentFileName: 'My Holiday.mp4' },
      );
      expect(result.fileName).toBe('My Holiday.mp4');
      expect(result.url).toBe(`http://minio/${video.source_key}?signed`);
    });

    it("should not presign another user's video", async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getStreamUrl('other-user', URL_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    });
  });
});
