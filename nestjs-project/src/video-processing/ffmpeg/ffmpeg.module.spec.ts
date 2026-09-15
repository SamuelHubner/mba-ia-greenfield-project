import { Test } from '@nestjs/testing';
import { execFileAsync } from './exec-file';
import { FFMPEG_EXEC } from './ffmpeg.constants';
import { FfmpegModule } from './ffmpeg.module';
import { FfmpegService } from './ffmpeg.service';

describe('FfmpegModule', () => {
  it('should compile and resolve FfmpegService bound to the real execFile wrapper', async () => {
    const module = await Test.createTestingModule({
      imports: [FfmpegModule],
    }).compile();

    expect(module.get(FfmpegService)).toBeInstanceOf(FfmpegService);
    expect(module.get(FFMPEG_EXEC)).toBe(execFileAsync);
    await module.close();
  });
});
