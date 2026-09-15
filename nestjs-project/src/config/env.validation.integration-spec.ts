import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY: 'access-key',
  STORAGE_SECRET_KEY: 'secret-key',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage / queue / upload policy', () => {
  it('should reject when STORAGE_ACCESS_KEY is missing', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, STORAGE_ACCESS_KEY: undefined },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY');
  });

  it('should reject when STORAGE_SECRET_KEY is missing', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, STORAGE_SECRET_KEY: undefined },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_SECRET_KEY');
  });

  it('should apply the storage, queue and upload defaults', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://minio:9000');
    expect(value.STORAGE_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
    expect(value.STORAGE_BUCKET).toBe('streamtube-media');
    expect(value.STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS).toBe(1);
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.VIDEO_PROCESSING_ATTEMPTS).toBe(3);
    expect(value.VIDEO_PROCESSING_BACKOFF_MS).toBe(5000);
    expect(value.UPLOAD_MAX_FILE_SIZE_BYTES).toBe(10737418240);
    expect(value.UPLOAD_PART_SIZE_BYTES).toBe(67108864);
    expect(value.UPLOAD_PART_URL_TTL_SECONDS).toBe(3600);
    expect(value.UPLOAD_SESSION_TTL_HOURS).toBe(24);
    expect(value.UPLOAD_ALLOWED_EXTENSIONS).toBe('mp4,webm,mov,mkv,avi');
    expect(value.MEDIA_STREAM_URL_TTL_SECONDS).toBe(21600);
    expect(value.MEDIA_DOWNLOAD_URL_TTL_SECONDS).toBe(3600);
  });

  it('should reject UPLOAD_PART_SIZE_BYTES below the 5 MiB S3 minimum', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject UPLOAD_PART_SIZE_BYTES above the 5 GiB S3 maximum', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '5368709121' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject UPLOAD_MAX_FILE_SIZE_BYTES above the 5 TiB S3 object limit', () => {
    const { error } = validate({ UPLOAD_MAX_FILE_SIZE_BYTES: '5497558138881' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_MAX_FILE_SIZE_BYTES');
  });

  it.each([
    'UPLOAD_PART_URL_TTL_SECONDS',
    'MEDIA_STREAM_URL_TTL_SECONDS',
    'MEDIA_DOWNLOAD_URL_TTL_SECONDS',
  ])('should reject %s above 7 days (604800 s)', (key) => {
    const { error } = validate({ [key]: '604801' });
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject when the lifecycle rule would purge parts before the upload session expires', () => {
    const { error } = validate({
      UPLOAD_SESSION_TTL_HOURS: '48',
      STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS: '1',
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS');
    expect(error!.message).toContain('UPLOAD_SESSION_TTL_HOURS');
  });

  it('should accept a lifecycle rule that covers the whole upload session', () => {
    const { error } = validate({
      UPLOAD_SESSION_TTL_HOURS: '48',
      STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS: '2',
    });
    expect(error).toBeUndefined();
  });
});
