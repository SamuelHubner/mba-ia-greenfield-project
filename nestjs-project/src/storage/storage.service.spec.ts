import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  StorageException,
  StorageObjectNotFound,
  StoragePartError,
} from './exceptions/storage.exception';
import { StorageService } from './storage.service';

const config: ConfigType<typeof storageConfig> = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  bucket: 'test-bucket',
  forcePathStyle: true,
  abortIncompleteUploadDays: 1,
};

function sdkError(name: string, httpStatusCode = 400): S3ServiceException {
  return new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode },
    message: `${name} from storage`,
  });
}

describe('StorageService (error mapping)', () => {
  let send: jest.Mock;
  let service: StorageService;

  beforeEach(() => {
    send = jest.fn();
    const client = { send } as unknown as S3Client;
    service = new StorageService(client, client, config);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  it('should map a generic S3ServiceException to StorageException (502 STORAGE_ERROR)', async () => {
    send.mockRejectedValueOnce(sdkError('InternalError', 500));

    const promise = service.createMultipartUpload(
      'videos/x/source.mp4',
      'video/mp4',
    );

    await expect(promise).rejects.toBeInstanceOf(StorageException);
    await expect(promise).rejects.toMatchObject({
      errorCode: 'STORAGE_ERROR',
      httpStatus: 502,
      operation: 'CreateMultipartUpload',
      cause: 'InternalError',
    });
  });

  it('should map a connection failure (ECONNREFUSED) to StorageException', async () => {
    const networkError = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    send.mockRejectedValueOnce(networkError);

    await expect(
      service.putObject('k', Buffer.from('x'), 'text/plain'),
    ).rejects.toMatchObject({
      errorCode: 'STORAGE_ERROR',
      httpStatus: 502,
      operation: 'PutObject',
    });
  });

  it.each([
    'InvalidPart',
    'InvalidPartOrder',
    'EntityTooSmall',
    'NoSuchUpload',
  ] as const)('should rethrow %s as StoragePartError', async (name) => {
    send.mockRejectedValueOnce(sdkError(name));

    const promise = service.completeMultipartUpload('k', 'upload', [
      { partNumber: 1, etag: '"abc"' },
    ]);

    await expect(promise).rejects.toBeInstanceOf(StoragePartError);
    await expect(promise).rejects.toMatchObject({ code: name });
  });

  it('should rethrow NotFound from HeadObject as StorageObjectNotFound carrying the key', async () => {
    send.mockRejectedValueOnce(sdkError('NotFound', 404));

    const promise = service.headObject('videos/missing/source.mp4');

    await expect(promise).rejects.toBeInstanceOf(StorageObjectNotFound);
    await expect(promise).rejects.toMatchObject({
      key: 'videos/missing/source.mp4',
    });
  });

  it('should create the bucket when HeadBucket reports NotFound, then write the lifecycle rule', async () => {
    send
      .mockRejectedValueOnce(sdkError('NotFound', 404)) // HeadBucket
      .mockResolvedValueOnce({}) // CreateBucket
      .mockResolvedValueOnce({}); // PutBucketLifecycleConfiguration

    await service.ensureBucket();

    expect(send).toHaveBeenCalledTimes(3);
    const commandNames = send.mock.calls.map(
      ([command]: [{ constructor: { name: string } }]) =>
        command.constructor.name,
    );
    expect(commandNames).toEqual([
      'HeadBucketCommand',
      'CreateBucketCommand',
      'PutBucketLifecycleConfigurationCommand',
    ]);
  });

  it('should skip CreateBucket when the bucket already exists', async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({});

    await service.ensureBucket();

    const commandNames = send.mock.calls.map(
      ([command]: [{ constructor: { name: string } }]) =>
        command.constructor.name,
    );
    expect(commandNames).toEqual([
      'HeadBucketCommand',
      'PutBucketLifecycleConfigurationCommand',
    ]);
  });

  it('should tolerate a storage that rejects the AbortIncompleteMultipartUpload rule', async () => {
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
    send
      .mockResolvedValueOnce({}) // HeadBucket
      .mockRejectedValueOnce(sdkError('InvalidArgument')); // lifecycle

    await expect(service.ensureBucket()).resolves.toBeUndefined();

    expect(service.lifecycleRuleApplied).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('AbortIncompleteMultipartUpload'),
    );
  });

  it('should report lifecycleRuleApplied=true when the storage accepts the rule', async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({});

    await service.ensureBucket();

    expect(service.lifecycleRuleApplied).toBe(true);
  });

  it('should still fail the boot when the lifecycle call fails for another reason', async () => {
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(sdkError('AccessDenied', 403));

    await expect(service.ensureBucket()).rejects.toMatchObject({
      errorCode: 'STORAGE_ERROR',
      operation: 'PutBucketLifecycleConfiguration',
      cause: 'AccessDenied',
    });
  });

  it('should throw a missing UploadId as StorageException', async () => {
    send.mockResolvedValueOnce({});

    await expect(
      service.createMultipartUpload('k', 'video/mp4'),
    ).rejects.toMatchObject({
      errorCode: 'STORAGE_ERROR',
      cause: 'missing UploadId',
    });
  });

  it('should paginate ListParts until IsTruncated is false', async () => {
    send
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 1, ETag: '"a"', Size: 5 }],
        IsTruncated: true,
        NextPartNumberMarker: '1',
      })
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 2, ETag: '"b"', Size: 3 }],
        IsTruncated: false,
      });

    const parts = await service.listParts('k', 'upload');

    expect(parts).toEqual([
      { partNumber: 1, etag: '"a"', size: 5 },
      { partNumber: 2, etag: '"b"', size: 3 },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    const secondInput = (
      send.mock.calls[1][0] as { input: { PartNumberMarker?: string } }
    ).input;
    expect(secondInput.PartNumberMarker).toBe('1');
  });
});
