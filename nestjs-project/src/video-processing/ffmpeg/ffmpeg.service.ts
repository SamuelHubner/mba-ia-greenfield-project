import { Inject, Injectable } from '@nestjs/common';
import type { ExecFileFailure, ExecFileFn } from './exec-file';
import {
  FFMPEG_BIN,
  FFMPEG_EXEC,
  FFMPEG_TIMEOUT_MS,
  FFPROBE_BIN,
  FFPROBE_TIMEOUT_MS,
  MAX_OUTPUT_BUFFER_BYTES,
  THUMBNAIL_POSITION_RATIO,
} from './ffmpeg.constants';
import {
  FfprobeFailedError,
  ThumbnailFailedError,
  UnreadableMediaError,
} from './ffmpeg.errors';

/** Metadata contract fixed by phase-03-videos/TD-04 (revision). */
export interface VideoProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string | number };
}

/**
 * The only place in the codebase that talks to the ffmpeg/ffprobe binaries
 * (phase-03-videos/TD-04). Sources are URLs or paths; ffprobe reads only the
 * headers, so a presigned HTTP URL never downloads the whole object.
 */
@Injectable()
export class FfmpegService {
  constructor(@Inject(FFMPEG_EXEC) private readonly exec: ExecFileFn) {}

  async probe(sourceUrl: string): Promise<VideoProbeResult> {
    let stdout: string;
    try {
      const result = await this.exec(
        FFPROBE_BIN,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          sourceUrl,
        ],
        {
          timeout: FFPROBE_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BUFFER_BYTES,
          encoding: 'utf8',
        },
      );
      stdout = String(result.stdout);
    } catch (error) {
      throw new FfprobeFailedError(stderrOf(error));
    }

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch {
      throw new UnreadableMediaError('ffprobe output is not valid JSON');
    }

    const video = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    if (!video) {
      throw new UnreadableMediaError('no video stream found');
    }
    const duration = Number(parsed.format?.duration);
    if (!Number.isFinite(duration)) {
      throw new UnreadableMediaError('format.duration is missing');
    }
    if (
      !Number.isInteger(video.width) ||
      !Number.isInteger(video.height) ||
      !video.codec_name
    ) {
      throw new UnreadableMediaError('video stream lacks width/height/codec');
    }

    return {
      durationSeconds: Math.floor(duration),
      width: video.width!,
      height: video.height!,
      videoCodec: video.codec_name,
    };
  }

  /** One JPEG frame at `atSeconds`, returned from ffmpeg's stdout. */
  async captureFrame(sourceUrl: string, atSeconds: number): Promise<Buffer> {
    let stdout: string | Buffer;
    try {
      ({ stdout } = await this.exec(
        FFMPEG_BIN,
        [
          '-ss',
          String(atSeconds),
          '-i',
          sourceUrl,
          '-frames:v',
          '1',
          '-q:v',
          '2',
          '-f',
          'image2',
          'pipe:1',
        ],
        {
          timeout: FFMPEG_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BUFFER_BYTES,
          encoding: 'buffer',
        },
      ));
    } catch (error) {
      throw new ThumbnailFailedError(stderrOf(error));
    }

    const frame = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    if (frame.length === 0) {
      throw new ThumbnailFailedError('ffmpeg produced an empty frame');
    }
    return frame;
  }

  /** Where the thumbnail is taken: 10% into the video, never negative. */
  thumbnailTimestamp(durationSeconds: number): number {
    return Math.max(0, durationSeconds * THUMBNAIL_POSITION_RATIO);
  }
}

function stderrOf(error: unknown): string {
  const failure = (error ?? {}) as ExecFileFailure;
  const stderr =
    failure.stderr === undefined ? '' : String(failure.stderr).trim();
  if (stderr) {
    return stderr;
  }
  if (failure.killed) {
    return `process killed (${failure.signal ?? 'timeout'})`;
  }
  return failure.message ?? 'unknown error';
}
