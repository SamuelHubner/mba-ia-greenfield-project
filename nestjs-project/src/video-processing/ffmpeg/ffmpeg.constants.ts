/** Injection token for the `execFile` wrapper (mockable in unit tests). */
export const FFMPEG_EXEC = Symbol('FFMPEG_EXEC');

export const FFPROBE_BIN = 'ffprobe';
export const FFMPEG_BIN = 'ffmpeg';

/** ffprobe only reads headers/moov; a minute covers slow object storage. */
export const FFPROBE_TIMEOUT_MS = 60_000;
/** Seeking + decoding one frame from a remote source. */
export const FFMPEG_TIMEOUT_MS = 120_000;
/** Bounds stdout (ffprobe JSON or one JPEG frame) and stderr. */
export const MAX_OUTPUT_BUFFER_BYTES = 64 * 1024 * 1024;

/** Thumbnail frame taken at 10% of the duration (Events/Messages step 4). */
export const THUMBNAIL_POSITION_RATIO = 0.1;
