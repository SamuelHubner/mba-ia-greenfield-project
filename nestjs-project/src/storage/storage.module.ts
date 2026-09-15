import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

type StorageConfig = ConfigType<typeof storageConfig>;

function createS3Client(config: StorageConfig, endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: StorageConfig) =>
        createS3Client(config, config.endpoint),
    },
    {
      provide: S3_PUBLIC_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: StorageConfig) =>
        createS3Client(config, config.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
