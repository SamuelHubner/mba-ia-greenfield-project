import { Test } from '@nestjs/testing';
import type { ExecFileFailure, ExecFileResult } from './exec-file';
import {
  FFMPEG_EXEC,
  FFMPEG_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  MAX_OUTPUT_BUFFER_BYTES,
} from './ffmpeg.constants';
import {
  FfprobeFailedError,
  STDERR_MAX_CHARS,
  ThumbnailFailedError,
  UnreadableMediaError,
} from './ffmpeg.errors';
import { FfmpegService } from './ffmpeg.service';

const SOURCE_URL = 'http://minio:9000/streamtube-media/videos/v1/source.mp4';

function probeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    streams: [
      { codec_type: 'audio', codec_name: 'aac' },
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    ],
    format: { duration: '125.874000' },
    ...overrides,
  });
}

function execFailure(stderr: string, code = 1): ExecFileFailure {
  return Object.assign(new Error(`Command failed with exit code ${code}`), {
    code,
    stderr,
    stdout: '',
  });
}

describe('FfmpegService', () => {
  let service: FfmpegService;
  let exec: jest.Mock<Promise<ExecFileResult>>;

  beforeEach(async () => {
    exec = jest.fn();
    const module = await Test.createTestingModule({
      providers: [FfmpegService, { provide: FFMPEG_EXEC, useValue: exec }],
    }).compile();
    service = module.get(FfmpegService);
  });

  describe('probe', () => {
    it('should call ffprobe with the exact JSON-format arguments', async () => {
      exec.mockResolvedValue({ stdout: probeJson(), stderr: '' });

      await service.probe(SOURCE_URL);

      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          SOURCE_URL,
        ],
        {
          timeout: FFPROBE_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BUFFER_BYTES,
          encoding: 'utf8',
        },
      );
    });

    it('should pick the first video stream and floor the duration', async () => {
      exec.mockResolvedValue({ stdout: probeJson(), stderr: '' });

      await expect(service.probe(SOURCE_URL)).resolves.toEqual({
        durationSeconds: 125,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
      });
    });

    it('should reject media without a video stream as UNREADABLE_MEDIA', async () => {
      exec.mockResolvedValue({
        stdout: probeJson({
          streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
        }),
        stderr: '',
      });

      await expect(service.probe(SOURCE_URL)).rejects.toMatchObject({
        code: 'UNREADABLE_MEDIA',
        cause: 'no video stream found',
      });
    });

    it('should reject non-JSON output as UNREADABLE_MEDIA', async () => {
      exec.mockResolvedValue({ stdout: 'not json', stderr: '' });

      await expect(service.probe(SOURCE_URL)).rejects.toBeInstanceOf(
        UnreadableMediaError,
      );
    });

    it('should map a non-zero exit to FFPROBE_FAILED with stderr truncated to 500 chars', async () => {
      const longStderr = `${'x'.repeat(800)}Invalid data found when processing input`;
      exec.mockRejectedValue(execFailure(longStderr));

      const error = await service.probe(SOURCE_URL).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FfprobeFailedError);
      const { code, cause } = error as FfprobeFailedError;
      expect(code).toBe('FFPROBE_FAILED');
      expect(cause).toHaveLength(STDERR_MAX_CHARS);
      expect(cause.endsWith('Invalid data found when processing input')).toBe(
        true,
      );
    });
  });

  describe('captureFrame', () => {
    it('should call ffmpeg with the exact single-frame-to-stdout arguments', async () => {
      exec.mockResolvedValue({
        stdout: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        stderr: Buffer.from(''),
      });

      const frame = await service.captureFrame(SOURCE_URL, 12.5);

      expect(frame.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(exec).toHaveBeenCalledWith(
        'ffmpeg',
        [
          '-ss',
          '12.5',
          '-i',
          SOURCE_URL,
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
      );
    });

    it('should map a non-zero exit to THUMBNAIL_FAILED carrying stderr', async () => {
      exec.mockRejectedValue(
        execFailure('Output file is empty, nothing was encoded'),
      );

      await expect(service.captureFrame(SOURCE_URL, 0)).rejects.toMatchObject({
        code: 'THUMBNAIL_FAILED',
        cause: 'Output file is empty, nothing was encoded',
      });
    });

    it('should treat an empty stdout as THUMBNAIL_FAILED', async () => {
      exec.mockResolvedValue({
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(''),
      });

      await expect(service.captureFrame(SOURCE_URL, 0)).rejects.toBeInstanceOf(
        ThumbnailFailedError,
      );
    });
  });

  describe('thumbnailTimestamp', () => {
    it('should be 10% of the duration, clamped at 0', () => {
      expect(service.thumbnailTimestamp(0)).toBe(0);
      expect(service.thumbnailTimestamp(125)).toBeCloseTo(12.5);
      expect(service.thumbnailTimestamp(-5)).toBe(0);
    });
  });
});
