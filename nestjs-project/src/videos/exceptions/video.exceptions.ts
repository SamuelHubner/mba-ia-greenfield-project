import { DomainException } from '../../common/exceptions/domain.exception';

/** Unknown `urlId`, or the video belongs to another user's channel (no existence leak). */
export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

/** Declared size above the cap, too many parts, or real size above the declared size. */
export class FileTooLargeException extends DomainException {
  constructor(message = 'File exceeds the maximum allowed size') {
    super('FILE_TOO_LARGE', 413, message);
  }
}

/** Extension outside the allowlist or a non-`video/*` mime type. */
export class UnsupportedVideoFormatException extends DomainException {
  constructor() {
    super('UNSUPPORTED_VIDEO_FORMAT', 415, 'Unsupported video format');
  }
}

/** A requested part number is outside `1..partCount` or repeated. */
export class InvalidPartNumbersException extends DomainException {
  constructor() {
    super(
      'INVALID_PART_NUMBERS',
      400,
      'Part numbers must be unique and within 1..partCount',
    );
  }
}

/** Completion list incomplete, out of order, or an etag rejected by the storage. */
export class InvalidPartsException extends DomainException {
  constructor(message = 'Part list is incomplete, out of order or invalid') {
    super('INVALID_PARTS', 400, message);
  }
}

/** Upload sub-resource called on a video that is no longer `draft`. */
export class UploadNotActiveException extends DomainException {
  constructor() {
    super('UPLOAD_NOT_ACTIVE', 409, 'Upload session is not active');
  }
}

/** Upload sub-resource called after `uploadExpiresAt` (session aborted lazily). */
export class UploadExpiredException extends DomainException {
  constructor() {
    super('UPLOAD_EXPIRED', 410, 'Upload session has expired');
  }
}

/** `/stream` or `/download` requested while the video is not `ready`. */
export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready yet');
  }
}
