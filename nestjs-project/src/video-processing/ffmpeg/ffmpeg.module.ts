import { Module } from '@nestjs/common';
import { execFileAsync } from './exec-file';
import { FFMPEG_EXEC } from './ffmpeg.constants';
import { FfmpegService } from './ffmpeg.service';

/** Wraps the ffmpeg/ffprobe binaries shipped in the image (phase-03-videos/TD-04). */
@Module({
  providers: [{ provide: FFMPEG_EXEC, useValue: execFileAsync }, FfmpegService],
  exports: [FfmpegService],
})
export class FfmpegModule {}
