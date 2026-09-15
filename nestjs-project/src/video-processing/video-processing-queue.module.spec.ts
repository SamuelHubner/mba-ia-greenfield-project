import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingQueueModule', () => {
  beforeAll(() => {
    process.env.REDIS_HOST = 'redis';
    process.env.REDIS_PORT = '6379';
  });

  it('should compile and resolve the video-processing queue and the producer', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [queueConfig],
        }),
        VideoProcessingQueueModule,
      ],
    }).compile();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBeInstanceOf(Queue);
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(queue.opts.connection).toMatchObject({ host: 'redis', port: 6379 });
    expect(module.get(VideoProcessingProducer)).toBeInstanceOf(
      VideoProcessingProducer,
    );

    await module.close();
  }, 15000);
});
