import { registerAs } from '@nestjs/config';

export const DEFAULT_ALLOWED_EXTENSIONS = 'mp4,webm,mov,mkv,avi';

export function parseAllowedExtensions(raw: string): string[] {
  return raw
    .split(',')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.length > 0);
}

export default registerAs('upload', () => ({
  maxFileSizeBytes: parseInt(
    process.env.UPLOAD_MAX_FILE_SIZE_BYTES || '10737418240',
    10,
  ),
  partSizeBytes: parseInt(process.env.UPLOAD_PART_SIZE_BYTES || '67108864', 10),
  partUrlTtlSeconds: parseInt(
    process.env.UPLOAD_PART_URL_TTL_SECONDS || '3600',
    10,
  ),
  sessionTtlHours: parseInt(process.env.UPLOAD_SESSION_TTL_HOURS || '24', 10),
  allowedExtensions: parseAllowedExtensions(
    process.env.UPLOAD_ALLOWED_EXTENSIONS || DEFAULT_ALLOWED_EXTENSIONS,
  ),
  streamUrlTtlSeconds: parseInt(
    process.env.MEDIA_STREAM_URL_TTL_SECONDS || '21600',
    10,
  ),
  downloadUrlTtlSeconds: parseInt(
    process.env.MEDIA_DOWNLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
}));
