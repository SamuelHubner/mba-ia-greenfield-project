import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { FfmpegService } from '../video-processing/ffmpeg/ffmpeg.service';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing/video-processing.constants';
import { VideoProcessor } from '../video-processing/video-processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  beforeAll(() => {
    // Same env contract as the API (loaded from .env by jest's dotenv setup);
    // only the pieces that must point at Compose service names are pinned.
    process.env.STORAGE_ENDPOINT = 'http://minio:9000';
    process.env.REDIS_HOST = 'redis';
  });

  it('should compile and resolve VideoProcessor, StorageService, FfmpegService and the queue', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(FfmpegService)).toBeInstanceOf(FfmpegService);
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);

    await module.close();
  }, 30000);
});
