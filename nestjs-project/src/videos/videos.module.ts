import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { VideoProcessingQueueModule } from '../video-processing/video-processing-queue.module';
import { Video } from './entities/video.entity';
import { VideoUpload } from './entities/video-upload.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, VideoUpload]),
    ChannelsModule,
    StorageModule,
    VideoProcessingQueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [TypeOrmModule, VideosService],
})
export class VideosModule {}
