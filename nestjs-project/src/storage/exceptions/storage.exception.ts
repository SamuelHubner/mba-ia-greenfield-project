import { DomainException } from '../../common/exceptions/domain.exception';

/** Any S3/MinIO failure the caller cannot act on (Error Catalog → STORAGE_ERROR). */
export class StorageException extends DomainException {
  constructor(
    public readonly operation: string,
    public readonly cause?: string,
  ) {
    super('STORAGE_ERROR', 502, `Storage operation failed: ${operation}`);
  }
}

export type StoragePartErrorCode =
  | 'NoSuchUpload'
  | 'InvalidPart'
  | 'InvalidPartOrder'
  | 'EntityTooSmall';

/** Multipart-specific rejection — VideosService maps it to INVALID_PARTS / UPLOAD_NOT_ACTIVE. */
export class StoragePartError extends Error {
  constructor(
    public readonly code: StoragePartErrorCode,
    message?: string,
  ) {
    super(message ?? `Multipart upload rejected: ${code}`);
    this.name = 'StoragePartError';
  }
}

/** HeadObject/GetObject on a missing key — VideosService decides how to surface it. */
export class StorageObjectNotFound extends Error {
  constructor(public readonly key: string) {
    super(`Object not found in storage: ${key}`);
    this.name = 'StorageObjectNotFound';
  }
}
