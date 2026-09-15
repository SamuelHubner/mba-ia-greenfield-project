import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  StorageException,
  StorageObjectNotFound,
  StoragePartError,
  StoragePartErrorCode,
} from './exceptions/storage.exception';
import {
  ABORT_INCOMPLETE_MULTIPART_RULE_ID,
  S3_CLIENT,
  S3_PUBLIC_CLIENT,
  VIDEOS_KEY_PREFIX,
} from './storage.constants';

export interface PresignedUrl {
  url: string;
  expiresAt: Date;
}

export interface StoredPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectHead {
  contentLength: number;
  contentType: string | null;
}

export interface PresignGetOptions {
  /** When set, the URL serves the object as `attachment; filename="..."`. */
  attachmentFileName?: string;
}

const PART_ERROR_NAMES: ReadonlySet<string> = new Set<StoragePartErrorCode>([
  'NoSuchUpload',
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
]);

const NOT_FOUND_NAMES: ReadonlySet<string> = new Set(['NotFound', 'NoSuchKey']);

/** Error code MinIO returns when the lifecycle XML carries an action it does not implement. */
const LIFECYCLE_UNSUPPORTED_ERROR = 'InvalidArgument';

interface SdkErrorLike {
  name?: string;
  message?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number };
}

/**
 * Sole owner of the AWS SDK: every other module talks to object storage
 * through this service (phase-03-videos/TD-08, TD-09).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucket: string;

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicS3: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /**
   * True once the storage accepted the `AbortIncompleteMultipartUpload` rule.
   * False when the storage rejects it (MinIO community edition does not
   * implement that lifecycle action) — abandoned parts then rely on the
   * API-side session deadline + explicit abort only (upload-policy/TD-05).
   */
  get lifecycleRuleApplied(): boolean {
    return this.lifecycleApplied;
  }

  private lifecycleApplied = false;

  /** Idempotent: creates the bucket when missing and (re)writes the lifecycle rule set. */
  async ensureBucket(): Promise<void> {
    const exists = await this.bucketExists();
    if (!exists) {
      await this.run('CreateBucket', () =>
        this.s3.send(new CreateBucketCommand({ Bucket: this.bucket })),
      );
      this.logger.log(`Bucket "${this.bucket}" created`);
    }

    this.lifecycleApplied = await this.applyAbortIncompleteRule();
  }

  private async applyAbortIncompleteRule(): Promise<boolean> {
    try {
      await this.run('PutBucketLifecycleConfiguration', () =>
        this.s3.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: this.bucket,
            LifecycleConfiguration: {
              Rules: [
                {
                  ID: ABORT_INCOMPLETE_MULTIPART_RULE_ID,
                  Status: 'Enabled',
                  Filter: { Prefix: VIDEOS_KEY_PREFIX },
                  AbortIncompleteMultipartUpload: {
                    DaysAfterInitiation: this.config.abortIncompleteUploadDays,
                  },
                },
              ],
            },
          }),
        ),
      );
      return true;
    } catch (error) {
      if (
        error instanceof StorageException &&
        error.cause === LIFECYCLE_UNSUPPORTED_ERROR
      ) {
        this.logger.warn(
          `Storage rejected the "${ABORT_INCOMPLETE_MULTIPART_RULE_ID}" lifecycle rule ` +
            '(AbortIncompleteMultipartUpload is not implemented by this storage — MinIO community edition); ' +
            'abandoned multipart parts will not be purged automatically (upload-policy/TD-05)',
        );
        return false;
      }
      throw error;
    }
  }

  // ---- multipart upload -----------------------------------------------

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.run('CreateMultipartUpload', () =>
      this.s3.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: contentType,
        }),
      ),
    );
    if (!result.UploadId) {
      throw new StorageException('CreateMultipartUpload', 'missing UploadId');
    }
    return result.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<PresignedUrl> {
    return this.presign(
      'PresignUploadPart',
      this.publicS3,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      ttlSeconds,
    );
  }

  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    const parts: StoredPart[] = [];
    let marker: number | undefined;

    do {
      const page = await this.run('ListParts', () =>
        this.s3.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker?.toString(),
          }),
        ),
      );
      for (const part of page.Parts ?? []) {
        if (part.PartNumber === undefined || part.ETag === undefined) continue;
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size ?? 0,
        });
      }
      marker =
        page.IsTruncated && page.NextPartNumberMarker
          ? Number(page.NextPartNumberMarker)
          : undefined;
    } while (marker !== undefined);

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.run('CompleteMultipartUpload', () =>
      this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      ),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.run('AbortMultipartUpload', () =>
      this.s3.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      ),
    );
  }

  async headObject(key: string): Promise<ObjectHead> {
    const head = await this.run(
      'HeadObject',
      () =>
        this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })),
      key,
    );
    return {
      contentLength: head.ContentLength ?? 0,
      contentType: head.ContentType ?? null,
    };
  }

  // ---- delivery & writes ----------------------------------------------

  /** Browser-facing GET URL (streaming with Range/206, or download when `attachmentFileName` is set). */
  async presignGetObject(
    key: string,
    ttlSeconds: number,
    options: PresignGetOptions = {},
  ): Promise<PresignedUrl> {
    return this.presign(
      'PresignGetObject',
      this.publicS3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.attachmentFileName !== undefined && {
          ResponseContentDisposition: `attachment; filename="${sanitizeFileName(options.attachmentFileName)}"`,
        }),
      }),
      ttlSeconds,
    );
  }

  /** GET URL on the API-internal endpoint — for the worker's ffprobe/ffmpeg. */
  async presignInternalGetObject(
    key: string,
    ttlSeconds: number,
  ): Promise<PresignedUrl> {
    return this.presign(
      'PresignInternalGetObject',
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      ttlSeconds,
    );
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    await this.run('PutObject', () =>
      this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      ),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.run('DeleteObject', () =>
      this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })),
    );
  }

  // ---- internals -------------------------------------------------------

  private async bucketExists(): Promise<boolean> {
    try {
      await this.run('HeadBucket', () =>
        this.s3.send(new HeadBucketCommand({ Bucket: this.bucket })),
      );
      return true;
    } catch (error) {
      if (error instanceof StorageObjectNotFound) return false;
      throw error;
    }
  }

  private async presign(
    operation: string,
    client: S3Client,
    command: Parameters<typeof getSignedUrl>[1],
    ttlSeconds: number,
  ): Promise<PresignedUrl> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const url = await this.run(operation, () =>
      getSignedUrl(client, command, { expiresIn: ttlSeconds }),
    );
    return { url, expiresAt };
  }

  /** Runs an SDK call, translating failures into the storage error types. */
  private async run<T>(
    operation: string,
    fn: () => Promise<T>,
    key = '',
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.mapError(operation, error, key);
    }
  }

  private mapError(operation: string, error: unknown, key: string): Error {
    const sdkError = (error ?? {}) as SdkErrorLike;
    const name = sdkError.name ?? sdkError.code ?? 'UnknownError';

    if (PART_ERROR_NAMES.has(name)) {
      return new StoragePartError(
        name as StoragePartErrorCode,
        sdkError.message,
      );
    }
    if (
      NOT_FOUND_NAMES.has(name) ||
      sdkError.$metadata?.httpStatusCode === 404
    ) {
      return new StorageObjectNotFound(key || this.bucket);
    }

    if (
      !(
        operation === 'PutBucketLifecycleConfiguration' &&
        name === LIFECYCLE_UNSUPPORTED_ERROR
      )
    ) {
      this.logger.error(
        `${operation} failed: ${name}${sdkError.message ? ` — ${sdkError.message}` : ''}`,
      );
    }
    return new StorageException(operation, name);
  }
}

/** Keeps the header parseable: no quotes, backslashes or line breaks in the filename. */
function sanitizeFileName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, '_');
}
