import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import mailConfig from '../config/mail.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import swaggerConfig from '../config/swagger.config';
import uploadConfig from '../config/upload.config';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { FfmpegModule } from '../video-processing/ffmpeg/ffmpeg.module';
import { VideoProcessingQueueModule } from '../video-processing/video-processing-queue.module';
import { VideoProcessor } from '../video-processing/video-processor';
import { Video } from '../videos/entities/video.entity';
import { VideoUpload } from '../videos/entities/video-upload.entity';

/**
 * Root module of the Video Worker: same codebase and configuration as the
 * API, but no HTTP layer — only the queue consumer and what it needs
 * (phase-03-videos/TD-03).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        swaggerConfig,
        storageConfig,
        queueConfig,
        uploadConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // Video's relation graph: Video → Channel → User (+ VideoUpload).
    TypeOrmModule.forFeature([Video, VideoUpload, Channel, User]),
    VideoProcessingQueueModule,
    StorageModule,
    FfmpegModule,
  ],
  providers: [VideoProcessor],
})
export class WorkerModule {}
