import storageConfig from './storage.config';

const STORAGE_ENV_KEYS = [
  'STORAGE_ENDPOINT',
  'STORAGE_PUBLIC_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
  'STORAGE_BUCKET',
  'STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS',
];

describe('storageConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of STORAGE_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it('should apply defaults pointing at the Compose minio service', () => {
    for (const key of STORAGE_ENV_KEYS) delete process.env[key];
    process.env.STORAGE_ACCESS_KEY = 'key';
    process.env.STORAGE_SECRET_KEY = 'secret';

    const config = storageConfig();

    expect(config.endpoint).toBe('http://minio:9000');
    expect(config.publicEndpoint).toBe('http://localhost:9000');
    expect(config.region).toBe('us-east-1');
    expect(config.accessKeyId).toBe('key');
    expect(config.secretAccessKey).toBe('secret');
    expect(config.bucket).toBe('streamtube-media');
    expect(config.forcePathStyle).toBe(true);
    expect(config.abortIncompleteUploadDays).toBe(1);
  });

  it('should read overrides and coerce the lifecycle days to a number', () => {
    process.env.STORAGE_ENDPOINT = 'http://storage:9000';
    process.env.STORAGE_PUBLIC_ENDPOINT = 'https://media.example.com';
    process.env.STORAGE_REGION = 'sa-east-1';
    process.env.STORAGE_ACCESS_KEY = 'key';
    process.env.STORAGE_SECRET_KEY = 'secret';
    process.env.STORAGE_BUCKET = 'other-bucket';
    process.env.STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS = '3';

    const config = storageConfig();

    expect(config.endpoint).toBe('http://storage:9000');
    expect(config.publicEndpoint).toBe('https://media.example.com');
    expect(config.region).toBe('sa-east-1');
    expect(config.bucket).toBe('other-bucket');
    expect(config.abortIncompleteUploadDays).toBe(3);
  });
});
