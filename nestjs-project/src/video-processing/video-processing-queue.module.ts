import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

/**
 * Wires BullMQ to the Compose `redis` service and registers the
 * `video-processing` queue. Imported by the API (producer) and by the
 * worker app (consumer) so both share the same connection settings.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (queue: ConfigType<typeof queueConfig>) => ({
        connection: { host: queue.redisHost, port: queue.redisPort },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [VideoProcessingProducer],
  exports: [BullModule, VideoProcessingProducer],
})
export class VideoProcessingQueueModule {}
