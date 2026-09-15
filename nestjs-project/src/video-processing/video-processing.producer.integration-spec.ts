import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import queueConfig from '../config/queue.config';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration — Redis)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        VideoProcessingQueueModule,
      ],
    }).compile();

    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  it('should create a process-video job carrying the videoId and the retry options', async () => {
    const videoId = randomUUID();

    const jobId = await producer.enqueue(videoId);

    expect(jobId).toBe(videoId);
    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
    expect(await job!.getState()).toBe('waiting');
  });

  it('should deduplicate by videoId: two enqueues leave exactly one waiting job', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
    expect(counts.waiting).toBe(1);
    expect(counts.delayed).toBe(0);
    expect(counts.active).toBe(0);
  });
});
