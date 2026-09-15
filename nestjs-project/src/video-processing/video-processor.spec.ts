import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import uploadConfig from '../config/upload.config';
import { StorageObjectNotFound } from '../storage/exceptions/storage.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfprobeFailedError } from './ffmpeg/ffmpeg.errors';
import { FfmpegService } from './ffmpeg/ffmpeg.service';
import { ProcessVideoJobData } from './video-processing.constants';
import { SourceNotFoundError } from './video-processing.errors';
import { VideoProcessor } from './video-processor';

const VIDEO_ID = 'b7f1c9e0-0000-4000-8000-000000000001';
const SOURCE_KEY = `videos/${VIDEO_ID}/source.mp4`;
const SIGNED_URL = 'http://minio:9000/streamtube-media/videos/x/source.mp4?sig';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);

function buildVideo(status: VideoStatus): Video {
  return Object.assign(new Video(), {
    id: VIDEO_ID,
    status,
    source_key: SOURCE_KEY,
  });
}

function buildJob(
  overrides: Partial<Pick<Job, 'attemptsMade' | 'opts' | 'id'>> = {},
): Job<ProcessVideoJobData> {
  return {
    id: VIDEO_ID,
    name: 'process-video',
    data: { videoId: VIDEO_ID },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  let videos: { findOne: jest.Mock; update: jest.Mock };
  let storage: jest.Mocked<
    Pick<
      StorageService,
      'headObject' | 'presignInternalGetObject' | 'putObject'
    >
  >;
  let ffmpeg: jest.Mocked<
    Pick<FfmpegService, 'probe' | 'captureFrame' | 'thumbnailTimestamp'>
  >;

  beforeEach(async () => {
    videos = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = {
      headObject: jest.fn().mockResolvedValue({
        contentLength: 15_729_664,
        contentType: 'video/mp4',
      }),
      presignInternalGetObject: jest.fn().mockResolvedValue({
        url: SIGNED_URL,
        expiresAt: new Date(Date.now() + 21_600_000),
      }),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    ffmpeg = {
      probe: jest.fn().mockResolvedValue({
        durationSeconds: 125,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
      }),
      captureFrame: jest.fn().mockResolvedValue(JPEG),
      thumbnailTimestamp: jest.fn((d: number) => d * 0.1),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: videos },
        { provide: StorageService, useValue: storage },
        { provide: FfmpegService, useValue: ffmpeg },
        {
          provide: uploadConfig.KEY,
          useValue: { streamUrlTtlSeconds: 21_600 },
        },
      ],
    }).compile();
    processor = module.get(VideoProcessor);
  });

  describe('process', () => {
    it('should skip a video that is no longer processing without touching the storage', async () => {
      videos.findOne.mockResolvedValue(buildVideo(VideoStatus.READY));

      await processor.process(buildJob());

      expect(storage.headObject).not.toHaveBeenCalled();
      expect(ffmpeg.probe).not.toHaveBeenCalled();
      expect(videos.update).not.toHaveBeenCalled();
    });

    it('should skip a job whose video row no longer exists', async () => {
      videos.findOne.mockResolvedValue(null);

      await processor.process(buildJob());

      expect(storage.headObject).not.toHaveBeenCalled();
      expect(videos.update).not.toHaveBeenCalled();
    });

    it('should probe via an internal presigned URL, upload the thumbnail and mark the video ready', async () => {
      videos.findOne.mockResolvedValue(buildVideo(VideoStatus.PROCESSING));

      await processor.process(buildJob());

      expect(storage.headObject).toHaveBeenCalledWith(SOURCE_KEY);
      expect(storage.presignInternalGetObject).toHaveBeenCalledWith(
        SOURCE_KEY,
        21_600,
      );
      expect(ffmpeg.probe).toHaveBeenCalledWith(SIGNED_URL);
      expect(ffmpeg.captureFrame).toHaveBeenCalledWith(SIGNED_URL, 12.5);
      expect(storage.putObject).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/thumbnail.jpg`,
        JPEG,
        'image/jpeg',
      );
      expect(videos.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        {
          durationSeconds: 125,
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          sizeBytes: 15_729_664,
          thumbnail_key: `videos/${VIDEO_ID}/thumbnail.jpg`,
          processing_error: null,
          status: VideoStatus.READY,
          processed_at: expect.any(Date),
        },
      );
    });

    it('should raise SOURCE_NOT_FOUND when the source object is missing', async () => {
      videos.findOne.mockResolvedValue(buildVideo(VideoStatus.PROCESSING));
      storage.headObject.mockRejectedValue(
        new StorageObjectNotFound(SOURCE_KEY),
      );

      await expect(processor.process(buildJob())).rejects.toBeInstanceOf(
        SourceNotFoundError,
      );
      await expect(processor.process(buildJob())).rejects.toMatchObject({
        code: 'SOURCE_NOT_FOUND',
      });
      expect(ffmpeg.probe).not.toHaveBeenCalled();
      expect(videos.update).not.toHaveBeenCalled();
    });

    it('should propagate ffmpeg failures untouched so the queue retries', async () => {
      videos.findOne.mockResolvedValue(buildVideo(VideoStatus.PROCESSING));
      ffmpeg.probe.mockRejectedValue(
        new FfprobeFailedError('moov atom not found'),
      );

      await expect(processor.process(buildJob())).rejects.toBeInstanceOf(
        FfprobeFailedError,
      );
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(videos.update).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('should leave the video untouched while attempts remain', async () => {
      await processor.onFailed(
        buildJob({ attemptsMade: 1, opts: { attempts: 3 } }),
        new FfprobeFailedError('boom'),
      );

      expect(videos.update).not.toHaveBeenCalled();
    });

    it('should record status error with the cause on the last attempt', async () => {
      await processor.onFailed(
        buildJob({ attemptsMade: 3, opts: { attempts: 3 } }),
        new FfprobeFailedError('boom'),
      );

      expect(videos.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.ERROR,
          processing_error: 'FFPROBE_FAILED',
          processed_at: expect.any(Date),
        },
      );
    });

    it('should record UNKNOWN for unexpected errors and ignore events without a job', async () => {
      await processor.onFailed(undefined, new Error('lost'));
      expect(videos.update).not.toHaveBeenCalled();

      await processor.onFailed(
        buildJob({ attemptsMade: 3, opts: { attempts: 3 } }),
        new Error('ECONNRESET'),
      );
      expect(videos.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        expect.objectContaining({ processing_error: 'UNKNOWN' }),
      );
    });
  });
});
