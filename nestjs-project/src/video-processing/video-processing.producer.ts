import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';

/** Single entry point for enqueueing `process-video` jobs (phase-03-videos/TD-01, TD-07). */
@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  /**
   * `jobId = videoId` so a retried HTTP completion cannot enqueue the same
   * video twice while the job is still pending. Returns the job id.
   */
  async enqueue(videoId: string): Promise<string> {
    const job = await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      {
        jobId: videoId,
        attempts: this.config.processingAttempts,
        backoff: {
          type: 'exponential',
          delay: this.config.processingBackoffMs,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    return job.id ?? videoId;
  }
}
