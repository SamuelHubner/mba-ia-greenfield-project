import { FfmpegError } from './ffmpeg/ffmpeg.errors';

/** Causes the worker records in `videos.processing_error` (phase-03-videos/TD-07). */
export type ProcessingCause =
  | 'SOURCE_NOT_FOUND'
  | 'FFPROBE_FAILED'
  | 'UNREADABLE_MEDIA'
  | 'THUMBNAIL_FAILED'
  | 'UNKNOWN';

/** The source object is gone from the bucket (Events/Messages step 2). */
export class SourceNotFoundError extends Error {
  readonly code = 'SOURCE_NOT_FOUND';

  constructor(public readonly key: string) {
    super(`Source object not found in storage: ${key}`);
    this.name = 'SourceNotFoundError';
  }
}

/** Machine-readable cause for a job failure; anything unexpected is `UNKNOWN`. */
export function processingCauseOf(error: unknown): ProcessingCause {
  if (error instanceof SourceNotFoundError || error instanceof FfmpegError) {
    return error.code;
  }
  return 'UNKNOWN';
}
