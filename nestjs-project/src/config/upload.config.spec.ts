import uploadConfig, { parseAllowedExtensions } from './upload.config';

const UPLOAD_ENV_KEYS = [
  'UPLOAD_MAX_FILE_SIZE_BYTES',
  'UPLOAD_PART_SIZE_BYTES',
  'UPLOAD_PART_URL_TTL_SECONDS',
  'UPLOAD_SESSION_TTL_HOURS',
  'UPLOAD_ALLOWED_EXTENSIONS',
  'MEDIA_STREAM_URL_TTL_SECONDS',
  'MEDIA_DOWNLOAD_URL_TTL_SECONDS',
];

describe('uploadConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of UPLOAD_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  describe('parseAllowedExtensions', () => {
    it('should trim, lower-case and drop empty entries', () => {
      expect(parseAllowedExtensions(' MP4, webm ,,Mov, ')).toEqual([
        'mp4',
        'webm',
        'mov',
      ]);
    });

    it('should return an empty array for a blank string', () => {
      expect(parseAllowedExtensions('  ')).toEqual([]);
    });
  });

  it('should apply numeric defaults and the default extension allowlist', () => {
    for (const key of UPLOAD_ENV_KEYS) delete process.env[key];

    const config = uploadConfig();

    expect(config.maxFileSizeBytes).toBe(10737418240);
    expect(config.partSizeBytes).toBe(67108864);
    expect(config.partUrlTtlSeconds).toBe(3600);
    expect(config.sessionTtlHours).toBe(24);
    expect(config.allowedExtensions).toEqual([
      'mp4',
      'webm',
      'mov',
      'mkv',
      'avi',
    ]);
    expect(config.streamUrlTtlSeconds).toBe(21600);
    expect(config.downloadUrlTtlSeconds).toBe(3600);
  });

  it('should coerce env strings to numbers and parse a custom allowlist', () => {
    process.env.UPLOAD_MAX_FILE_SIZE_BYTES = '1073741824';
    process.env.UPLOAD_PART_SIZE_BYTES = '5242880';
    process.env.UPLOAD_PART_URL_TTL_SECONDS = '600';
    process.env.UPLOAD_SESSION_TTL_HOURS = '12';
    process.env.UPLOAD_ALLOWED_EXTENSIONS = 'MP4, WEBM';
    process.env.MEDIA_STREAM_URL_TTL_SECONDS = '120';
    process.env.MEDIA_DOWNLOAD_URL_TTL_SECONDS = '60';

    const config = uploadConfig();

    expect(config.maxFileSizeBytes).toBe(1073741824);
    expect(config.partSizeBytes).toBe(5242880);
    expect(config.partUrlTtlSeconds).toBe(600);
    expect(config.sessionTtlHours).toBe(12);
    expect(config.allowedExtensions).toEqual(['mp4', 'webm']);
    expect(config.streamUrlTtlSeconds).toBe(120);
    expect(config.downloadUrlTtlSeconds).toBe(60);
  });
});
