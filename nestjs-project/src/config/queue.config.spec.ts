import queueConfig from './queue.config';

const QUEUE_ENV_KEYS = [
  'REDIS_HOST',
  'REDIS_PORT',
  'VIDEO_PROCESSING_ATTEMPTS',
  'VIDEO_PROCESSING_BACKOFF_MS',
];

describe('queueConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of QUEUE_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it('should apply defaults pointing at the Compose redis service', () => {
    for (const key of QUEUE_ENV_KEYS) delete process.env[key];

    const config = queueConfig();

    expect(config.redisHost).toBe('redis');
    expect(config.redisPort).toBe(6379);
    expect(config.processingAttempts).toBe(3);
    expect(config.processingBackoffMs).toBe(5000);
  });

  it('should coerce port, attempts and backoff from env strings', () => {
    process.env.REDIS_HOST = 'cache';
    process.env.REDIS_PORT = '6380';
    process.env.VIDEO_PROCESSING_ATTEMPTS = '5';
    process.env.VIDEO_PROCESSING_BACKOFF_MS = '250';

    const config = queueConfig();

    expect(config.redisHost).toBe('cache');
    expect(config.redisPort).toBe(6380);
    expect(config.processingAttempts).toBe(5);
    expect(config.processingBackoffMs).toBe(250);
  });
});
