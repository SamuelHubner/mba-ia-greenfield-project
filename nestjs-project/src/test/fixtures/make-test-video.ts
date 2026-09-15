import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TestVideoOptions {
  /** Seconds of synthetic footage (default 2). */
  durationSeconds?: number;
  /** `WxH` (default `64x64`). */
  size?: string;
  /** Frames per second (default 10). */
  rate?: number;
  fileName?: string;
}

/**
 * Renders a small synthetic H.264 MP4 with the ffmpeg binary from the image
 * into a fresh temp directory and returns its absolute path. Integration
 * suites use it as a real media fixture without committing binaries.
 */
export async function makeTestVideo(
  options: TestVideoOptions = {},
): Promise<string> {
  const {
    durationSeconds = 2,
    size = '64x64',
    rate = 10,
    fileName = 'fixture.mp4',
  } = options;
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-video-'));
  const path = join(dir, fileName);

  await execFileAsync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${size}:rate=${rate}`,
    '-pix_fmt',
    'yuv420p',
    path,
  ]);

  return path;
}
