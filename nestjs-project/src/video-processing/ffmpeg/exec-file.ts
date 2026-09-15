import { execFile } from 'node:child_process';

export interface ExecFileOptions {
  timeout: number;
  maxBuffer: number;
  encoding: 'utf8' | 'buffer';
}

export interface ExecFileResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
}

/** Error shape thrown by {@link execFileAsync}: Node's error plus captured output. */
export interface ExecFileFailure extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<ExecFileResult>;

/**
 * `execFile` as a promise that keeps stdout/stderr on the rejection, so a
 * failing ffmpeg/ffprobe run still exposes its diagnostics.
 */
export const execFileAsync: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        encoding: options.encoding,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error as ExecFileFailure, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
