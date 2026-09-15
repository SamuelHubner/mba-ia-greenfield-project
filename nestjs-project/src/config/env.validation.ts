import * as Joi from 'joi';

/** S3 multipart limits: part size 5 MiB..5 GiB, object up to 5 TiB. */
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PART_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_OBJECT_SIZE_BYTES = 5 * 1024 * 1024 * 1024 * 1024;
/** SigV4 presigned URLs are valid for at most 7 days. */
const MAX_PRESIGN_TTL_SECONDS = 7 * 24 * 60 * 60;

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  // Object storage (S3/MinIO) — phase-03-videos/TD-08, TD-09; upload-policy/TD-05
  STORAGE_ENDPOINT: Joi.string().uri().default('http://minio:9000'),
  STORAGE_PUBLIC_ENDPOINT: Joi.string().uri().default('http://localhost:9000'),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_ACCESS_KEY: Joi.string().required(),
  STORAGE_SECRET_KEY: Joi.string().required(),
  STORAGE_BUCKET: Joi.string().default('streamtube-media'),
  STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS: Joi.number()
    .integer()
    .min(1)
    .default(1),
  // Queue (BullMQ on Redis) — phase-03-videos/TD-01, TD-07
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  VIDEO_PROCESSING_ATTEMPTS: Joi.number().integer().min(1).default(3),
  VIDEO_PROCESSING_BACKOFF_MS: Joi.number().integer().min(0).default(5000),
  // Upload policy — upload-policy/TD-01..TD-06 (S3 multipart bounds)
  UPLOAD_MAX_FILE_SIZE_BYTES: Joi.number()
    .integer()
    .min(1)
    .max(MAX_OBJECT_SIZE_BYTES)
    .default(10737418240),
  UPLOAD_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(MIN_PART_SIZE_BYTES)
    .max(MAX_PART_SIZE_BYTES)
    .default(67108864),
  UPLOAD_PART_URL_TTL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(MAX_PRESIGN_TTL_SECONDS)
    .default(3600),
  UPLOAD_SESSION_TTL_HOURS: Joi.number().integer().min(1).default(24),
  UPLOAD_ALLOWED_EXTENSIONS: Joi.string().default('mp4,webm,mov,mkv,avi'),
  MEDIA_STREAM_URL_TTL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(MAX_PRESIGN_TTL_SECONDS)
    .default(21600),
  MEDIA_DOWNLOAD_URL_TTL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(MAX_PRESIGN_TTL_SECONDS)
    .default(3600),
}).custom((env: Record<string, unknown>, helpers) => {
  const abortDays = Number(env.STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS);
  const sessionTtlHours = Number(env.UPLOAD_SESSION_TTL_HOURS);
  if (abortDays * 24 < sessionTtlHours) {
    return helpers.error('any.custom', {
      error: new Error(
        'STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS * 24 must be >= UPLOAD_SESSION_TTL_HOURS ' +
          '(the storage lifecycle rule must not purge parts of a still-active upload session)',
      ),
    });
  }
  return env;
}, 'upload session vs lifecycle rule');
