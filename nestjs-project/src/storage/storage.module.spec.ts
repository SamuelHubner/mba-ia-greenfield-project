import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  beforeAll(() => {
    process.env.STORAGE_ACCESS_KEY = 'test-key';
    process.env.STORAGE_SECRET_KEY = 'test-secret';
    process.env.STORAGE_ENDPOINT = 'http://minio:9000';
    process.env.STORAGE_PUBLIC_ENDPOINT = 'http://localhost:9000';
  });

  it('should compile and resolve StorageService plus both S3 clients', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    expect(module.get(StorageService)).toBeInstanceOf(StorageService);

    const internal = module.get<S3Client>(S3_CLIENT);
    const pub = module.get<S3Client>(S3_PUBLIC_CLIENT);
    expect(internal).toBeInstanceOf(S3Client);
    expect(pub).toBeInstanceOf(S3Client);
    expect(internal).not.toBe(pub);

    const internalEndpoint = await internal.config.endpoint?.();
    const publicEndpoint = await pub.config.endpoint?.();
    expect(internalEndpoint?.hostname).toBe('minio');
    expect(publicEndpoint?.hostname).toBe('localhost');
    expect(internal.config.forcePathStyle).toBe(true);

    await module.close();
  }, 15000);
});
