import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY!,
  secretAccessKey: process.env.STORAGE_SECRET_KEY!,
  bucket: process.env.STORAGE_BUCKET || 'streamtube-media',
  forcePathStyle: true,
  abortIncompleteUploadDays: parseInt(
    process.env.STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS || '1',
    10,
  ),
}));
