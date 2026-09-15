import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoUpload } from './entities/video-upload.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoUpload,
];

describe('VideosModule', () => {
  beforeAll(() => {
    process.env.STORAGE_ACCESS_KEY ??= 'test-key';
    process.env.STORAGE_SECRET_KEY ??= 'test-secret';
    process.env.STORAGE_ENDPOINT ??= 'http://minio:9000';
    process.env.STORAGE_PUBLIC_ENDPOINT ??= 'http://localhost:9000';
    process.env.REDIS_HOST ??= 'redis';
  });

  it('should compile and resolve VideosService plus the Video and VideoUpload repositories', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig, queueConfig, uploadConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    expect(
      module.get<Repository<Video>>(getRepositoryToken(Video)),
    ).toBeDefined();
    expect(
      module.get<Repository<VideoUpload>>(getRepositoryToken(VideoUpload)),
    ).toBeDefined();
    await module.close();
  }, 30000);
});
