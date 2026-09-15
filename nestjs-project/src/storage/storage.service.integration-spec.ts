import {
  GetBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  StorageException,
  StorageObjectNotFound,
  StoragePartError,
} from './exceptions/storage.exception';
import {
  ABORT_INCOMPLETE_MULTIPART_RULE_ID,
  S3_CLIENT,
} from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const TEST_BUCKET = 'streamtube-media-test';
const FIVE_MIB = 5 * 1024 * 1024;

describe('StorageService (integration — MinIO)', () => {
  let module: TestingModule;
  let service: StorageService;
  let s3: S3Client;
  let counter = 0;
  const key = () => `videos/it-${Date.now()}-${++counter}/source.mp4`;

  beforeAll(async () => {
    // Tests run inside the API container: the "public" endpoint must be
    // reachable from here, so point it at the Compose service name.
    process.env.STORAGE_PUBLIC_ENDPOINT = 'http://minio:9000';
    process.env.STORAGE_BUCKET = TEST_BUCKET;

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();
    await module.init(); // triggers StorageService.onModuleInit → ensureBucket

    service = module.get(StorageService);
    s3 = module.get<S3Client>(S3_CLIENT);
  });

  afterAll(async () => {
    await module.close();
  });

  it('should be idempotent on ensureBucket and apply the lifecycle rule where the storage supports it', async () => {
    await service.ensureBucket();
    await service.ensureBucket();

    if (service.lifecycleRuleApplied) {
      // Real S3 (or a MinIO build that implements AbortIncompleteMultipartUpload)
      const lifecycle = await s3.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: TEST_BUCKET }),
      );
      expect(lifecycle.Rules).toHaveLength(1);
      expect(lifecycle.Rules?.[0]).toMatchObject({
        ID: ABORT_INCOMPLETE_MULTIPART_RULE_ID,
        Status: 'Enabled',
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      });
      const rule = lifecycle.Rules?.[0];
      expect(rule?.Filter?.Prefix ?? rule?.Prefix).toBe('videos/');
    } else {
      // MinIO community edition rejects abort-only lifecycle rules (InvalidArgument):
      // the boot must survive and leave the bucket without a lifecycle configuration.
      await expect(
        s3.send(
          new GetBucketLifecycleConfigurationCommand({ Bucket: TEST_BUCKET }),
        ),
      ).rejects.toMatchObject({ name: 'NoSuchLifecycleConfiguration' });
    }
  });

  it('should run the multipart cycle: create → presign → PUT → listParts → complete → headObject', async () => {
    const objectKey = key();
    const uploadId = await service.createMultipartUpload(
      objectKey,
      'video/mp4',
    );
    expect(uploadId).toEqual(expect.any(String));

    const part1 = await service.presignUploadPart(objectKey, uploadId, 1, 600);
    const part2 = await service.presignUploadPart(objectKey, uploadId, 2, 600);
    expect(part1.url).toContain('http://minio:9000/');
    expect(part1.url).toContain(`uploadId=${encodeURIComponent(uploadId)}`);
    expect(part1.url).toContain('partNumber=1');
    expect(part1.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const body1 = Buffer.alloc(FIVE_MIB, 1);
    const body2 = Buffer.alloc(1024, 2);
    const put1 = await fetch(part1.url, { method: 'PUT', body: body1 });
    const put2 = await fetch(part2.url, { method: 'PUT', body: body2 });
    expect(put1.status).toBe(200);
    expect(put2.status).toBe(200);
    const etag1 = put1.headers.get('etag');
    const etag2 = put2.headers.get('etag');
    expect(etag1).toBeTruthy();

    const listed = await service.listParts(objectKey, uploadId);
    expect(listed).toEqual([
      { partNumber: 1, etag: etag1, size: FIVE_MIB },
      { partNumber: 2, etag: etag2, size: 1024 },
    ]);

    await service.completeMultipartUpload(objectKey, uploadId, [
      { partNumber: 1, etag: etag1! },
      { partNumber: 2, etag: etag2! },
    ]);

    const head = await service.headObject(objectKey);
    expect(head.contentLength).toBe(FIVE_MIB + 1024);
    expect(head.contentType).toBe('video/mp4');

    await service.deleteObject(objectKey);
    await expect(service.headObject(objectKey)).rejects.toBeInstanceOf(
      StorageObjectNotFound,
    );
  });

  it('should reject completion with a wrong etag as StoragePartError', async () => {
    const objectKey = key();
    const uploadId = await service.createMultipartUpload(
      objectKey,
      'video/mp4',
    );
    const part = await service.presignUploadPart(objectKey, uploadId, 1, 600);
    await fetch(part.url, { method: 'PUT', body: Buffer.alloc(1024) });

    await expect(
      service.completeMultipartUpload(objectKey, uploadId, [
        { partNumber: 1, etag: '"deadbeef"' },
      ]),
    ).rejects.toBeInstanceOf(StoragePartError);

    await service.abortMultipartUpload(objectKey, uploadId);
  });

  it('should drop uploaded parts on abort (listParts → NoSuchUpload)', async () => {
    const objectKey = key();
    const uploadId = await service.createMultipartUpload(
      objectKey,
      'video/mp4',
    );
    const part = await service.presignUploadPart(objectKey, uploadId, 1, 600);
    const put = await fetch(part.url, {
      method: 'PUT',
      body: Buffer.alloc(2048),
    });
    expect(put.status).toBe(200);
    expect(await service.listParts(objectKey, uploadId)).toHaveLength(1);

    await service.abortMultipartUpload(objectKey, uploadId);

    await expect(service.listParts(objectKey, uploadId)).rejects.toMatchObject({
      name: 'StoragePartError',
      code: 'NoSuchUpload',
    });
  });

  it('should presign GET URLs that stream with Range and download as attachment', async () => {
    const objectKey = key();
    await service.putObject(objectKey, Buffer.alloc(4096, 7), 'video/mp4');

    const stream = await service.presignGetObject(objectKey, 600);
    expect(stream.url).not.toContain('response-content-disposition');
    const ranged = await fetch(stream.url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-1023\/4096$/);
    expect((await ranged.arrayBuffer()).byteLength).toBe(1024);

    const download = await service.presignGetObject(objectKey, 600, {
      attachmentFileName: 'my "clip".mp4',
    });
    expect(download.url).toContain('response-content-disposition=');
    const downloaded = await fetch(download.url);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-disposition')).toBe(
      'attachment; filename="my _clip_.mp4"',
    );

    const internal = await service.presignInternalGetObject(objectKey, 600);
    expect(internal.url).toContain('http://minio:9000/');
    expect((await fetch(internal.url)).status).toBe(200);

    await service.deleteObject(objectKey);
  });

  it('should surface an unreachable storage as StorageException (502 STORAGE_ERROR)', async () => {
    const unreachable = new S3Client({
      endpoint: 'http://minio:1',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'k', secretAccessKey: 's' },
      maxAttempts: 1,
    });
    const offline = new StorageService(unreachable, unreachable, {
      ...storageConfig(),
      bucket: TEST_BUCKET,
    });
    jest.spyOn(offline['logger'], 'error').mockImplementation(() => undefined);

    const promise = offline.headObject('videos/any/source.mp4');
    await expect(promise).rejects.toBeInstanceOf(StorageException);
    await expect(promise).rejects.toMatchObject({
      errorCode: 'STORAGE_ERROR',
      httpStatus: 502,
    });
    unreachable.destroy();
  }, 20000);
});
