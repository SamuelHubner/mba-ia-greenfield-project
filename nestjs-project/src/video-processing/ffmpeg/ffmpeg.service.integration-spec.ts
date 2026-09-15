import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Test } from '@nestjs/testing';
import { makeTestVideo } from '../../test/fixtures/make-test-video';
import { FfmpegError, STDERR_MAX_CHARS } from './ffmpeg.errors';
import { FfmpegModule } from './ffmpeg.module';
import { FfmpegService } from './ffmpeg.service';

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

describe('FfmpegService (integration — real ffmpeg/ffprobe binaries)', () => {
  let service: FfmpegService;
  let fixtureUrl: string;
  let fixturePath: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [FfmpegModule],
    }).compile();
    service = module.get(FfmpegService);

    fixturePath = await makeTestVideo({ durationSeconds: 2, size: '64x64' });
    fixtureUrl = pathToFileURL(fixturePath).href; // file:///tmp/…/fixture.mp4
  }, 60000);

  it('should probe the synthetic 2 s fixture into the TD-04 metadata contract', async () => {
    await expect(service.probe(fixtureUrl)).resolves.toEqual({
      durationSeconds: 2,
      width: 64,
      height: 64,
      videoCodec: 'h264',
    });
  });

  it('should fail with a processing cause and a bounded stderr on a text file named .mp4', async () => {
    const bogusPath = join(dirname(fixturePath), 'bogus.mp4');
    await writeFile(bogusPath, 'this is definitely not a video\n');

    const error = await service
      .probe(pathToFileURL(bogusPath).href)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegError);
    const { code, cause } = error as FfmpegError;
    expect(['FFPROBE_FAILED', 'UNREADABLE_MEDIA']).toContain(code);
    expect(cause.length).toBeGreaterThan(0);
    expect(cause.length).toBeLessThanOrEqual(STDERR_MAX_CHARS);
  });

  it('should capture a JPEG frame at 0.2 s', async () => {
    const frame = await service.captureFrame(fixtureUrl, 0.2);

    expect(frame.length).toBeGreaterThan(0);
    expect(frame.subarray(0, 3)).toEqual(JPEG_SIGNATURE);
  });
});
