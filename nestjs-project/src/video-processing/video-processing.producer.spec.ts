import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

const config: ConfigType<typeof queueConfig> = {
  redisHost: 'redis',
  redisPort: 6379,
  processingAttempts: 3,
  processingBackoffMs: 5000,
};

describe('VideoProcessingProducer', () => {
  let add: jest.Mock;
  let producer: VideoProcessingProducer;

  beforeEach(() => {
    add = jest.fn().mockResolvedValue({ id: 'video-uuid' });
    producer = new VideoProcessingProducer(
      { add } as unknown as Queue<ProcessVideoJobData>,
      config,
    );
  });

  it('should add a process-video job keyed by the videoId with the retry policy from config', async () => {
    const jobId = await producer.enqueue('video-uuid');

    expect(jobId).toBe('video-uuid');
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      PROCESS_VIDEO_JOB,
      { videoId: 'video-uuid' },
      {
        jobId: 'video-uuid',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  });

  it('should propagate queue failures to the caller', async () => {
    add.mockRejectedValueOnce(new Error('connect ECONNREFUSED redis:6379'));

    await expect(producer.enqueue('video-uuid')).rejects.toThrow('redis:6379');
  });
});
