/** Causes recorded in `videos.processing_error` by the worker (phase-03-videos/TD-07). */
export type FfmpegErrorCode =
  | 'FFPROBE_FAILED'
  | 'UNREADABLE_MEDIA'
  | 'THUMBNAIL_FAILED';

/** Upper bound for the stderr excerpt kept in `cause` (fits `processing_error`). */
export const STDERR_MAX_CHARS = 500;

/** Keeps the tail of stderr — that is where ffmpeg/ffprobe print the actual error. */
export function truncateStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length <= STDERR_MAX_CHARS
    ? trimmed
    : trimmed.slice(trimmed.length - STDERR_MAX_CHARS);
}

export abstract class FfmpegError extends Error {
  abstract readonly code: FfmpegErrorCode;
  /** Truncated stderr (or a short reason) for `processing_error` diagnostics. */
  declare readonly cause: string;

  constructor(message: string, cause: string) {
    super(message, { cause: truncateStderr(cause) });
    this.name = this.constructor.name;
  }
}

/** `ffprobe` exited with a non-zero code or timed out. */
export class FfprobeFailedError extends FfmpegError {
  readonly code = 'FFPROBE_FAILED';
  constructor(cause: string) {
    super('ffprobe failed', cause);
  }
}

/** `ffprobe` ran but the output has no video stream, no duration or is not JSON. */
export class UnreadableMediaError extends FfmpegError {
  readonly code = 'UNREADABLE_MEDIA';
  constructor(cause: string) {
    super('Media is not a readable video', cause);
  }
}

/** `ffmpeg` could not produce the thumbnail frame. */
export class ThumbnailFailedError extends FfmpegError {
  readonly code = 'THUMBNAIL_FAILED';
  constructor(cause: string) {
    super('Thumbnail generation failed', cause);
  }
}
