import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

const KIB = 1024;
const STREAM_TTL_SECONDS = 21600; // MEDIA_STREAM_URL_TTL_SECONDS default
const DOWNLOAD_TTL_SECONDS = 3600; // MEDIA_DOWNLOAD_URL_TTL_SECONDS default
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Smallest JPEG that still carries the FF D8 FF signature (SOI + APP0 + EOI). */
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

const SEEDED_METADATA = {
  durationSeconds: 2,
  width: 64,
  height: 64,
  videoCodec: 'h264',
};

describe('videos-delivery', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let publicEndpoint: string;
  const seededKeys: string[] = [];

  beforeAll(async () => {
    // Tests run inside the API container: presigned URLs must resolve here.
    process.env.STORAGE_PUBLIC_ENDPOINT = 'http://minio:9000';
    process.env.STORAGE_BUCKET = 'streamtube-media-test';
    process.env.MEDIA_STREAM_URL_TTL_SECONDS = String(STREAM_TTL_SECONDS);
    process.env.MEDIA_DOWNLOAD_URL_TTL_SECONDS = String(DOWNLOAD_TTL_SECONDS);
    publicEndpoint = process.env.STORAGE_PUBLIC_ENDPOINT;

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await Promise.all(seededKeys.map((key) => storage.deleteObject(key)));
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  // ---- helpers ---------------------------------------------------------

  async function captureConfirmationToken(
    email: string,
    password: string,
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  /** Draft via the public API — the channel is created on registration. */
  async function createDraft(accessToken: string): Promise<Video> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize: 4 * KIB })
      .expect(201);
    return videoRepository.findOneOrFail({
      where: { url_id: res.body.urlId as string },
    });
  }

  /** Seeds `ready` deterministically: source + thumbnail objects and the row. */
  async function seedReady(
    accessToken: string,
    sourceBytes = 4 * KIB,
  ): Promise<Video> {
    const video = await createDraft(accessToken);
    const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
    await storage.putObject(
      video.source_key,
      Buffer.alloc(sourceBytes, 7),
      'video/mp4',
    );
    await storage.putObject(thumbnailKey, MINIMAL_JPEG, 'image/jpeg');
    seededKeys.push(video.source_key, thumbnailKey);
    await videoRepository.update(
      { id: video.id },
      {
        ...SEEDED_METADATA,
        sizeBytes: sourceBytes,
        thumbnail_key: thumbnailKey,
        status: VideoStatus.READY,
        processed_at: new Date(),
      },
    );
    return videoRepository.findOneOrFail({ where: { id: video.id } });
  }

  async function seedProcessing(accessToken: string): Promise<Video> {
    const video = await createDraft(accessToken);
    await videoRepository.update(
      { id: video.id },
      { status: VideoStatus.PROCESSING },
    );
    return video;
  }

  function expectWithinTtl(expiresAt: string, ttlSeconds: number): void {
    expect(expiresAt).toMatch(ISO_DATE_REGEX);
    const delta = new Date(expiresAt).getTime() - Date.now();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(ttlSeconds * 1000);
  }

  // ---- 1. GET /videos/:urlId --------------------------------------------

  it('1.1 get-video-ready-com-metadata-e-thumbnail', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');
    const video = await seedReady(accessToken);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.url_id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.status).toBe('ready');
    expect(res.body.originalFileName).toBe('clip.mp4');
    expect(res.body.mimeType).toBe('video/mp4');
    expect(res.body).toMatchObject({ ...SEEDED_METADATA, sizeBytes: 4 * KIB });
    expect(typeof res.body.thumbnailUrl).toBe('string');
    expect((res.body.thumbnailUrl as string).startsWith(publicEndpoint)).toBe(
      true,
    );
    expect(res.body.thumbnailUrl).toContain(`videos/${video.id}/thumbnail.jpg`);
    expect(res.body.processingError).toBeNull();
    expect(res.body.processedAt).toMatch(ISO_DATE_REGEX);

    const thumbnail = await fetch(res.body.thumbnailUrl as string);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  });

  it('1.2 get-video-draft-metadata-nula', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');
    const video = await createDraft(accessToken);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.url_id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.status).toBe('draft');
    expect(res.body).toMatchObject({
      durationSeconds: null,
      width: null,
      height: null,
      videoCodec: null,
      sizeBytes: null,
      thumbnailUrl: null,
      processingError: null,
      processedAt: null,
    });
    expect(res.body.createdAt).toMatch(ISO_DATE_REGEX);
    expect(res.body.urlId).toHaveLength(11);
  });

  it('1.3 get-video-inexistente-ou-de-outro-usuario-404', async () => {
    const ownerToken = await registerConfirmAndLogin('owner@test.com');
    const otherToken = await registerConfirmAndLogin('other@test.com');
    const video = await createDraft(ownerToken);

    const unknown = await request(app.getHttpServer())
      .get('/videos/AAAAAAAAAAA')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
    expect(unknown.body.error).toBe('VIDEO_NOT_FOUND');

    const foreign = await request(app.getHttpServer())
      .get(`/videos/${video.url_id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    expect(foreign.body.error).toBe('VIDEO_NOT_FOUND');
    expect(foreign.body).not.toHaveProperty('urlId');
    expect(foreign.body).not.toHaveProperty('originalFileName');
  });

  // ---- 2. GET /videos/:urlId/stream -------------------------------------

  it('2.1 stream-ready-url-suporta-range-206', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');
    const video = await seedReady(accessToken, 4 * KIB);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.url_id}/stream`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const url = res.body.url as string;
    expect(url.startsWith(publicEndpoint)).toBe(true);
    expect(url).toContain(video.source_key);
    expect(url).not.toContain('response-content-disposition');
    expectWithinTtl(res.body.expiresAt as string, STREAM_TTL_SECONDS);

    const ranged = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
    expect((await ranged.arrayBuffer()).byteLength).toBe(1024);
  });

  it('2.2 stream-processing-409', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');
    const video = await seedProcessing(accessToken);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.url_id}/stream`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);

    expect(res.body.error).toBe('VIDEO_NOT_READY');
  });

  // ---- 3. GET /videos/:urlId/download -----------------------------------

  it('3.1 download-url-attachment-com-filename', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');
    const video = await seedReady(accessToken);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.url_id}/download`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.fileName).toBe('clip.mp4');
    const url = res.body.url as string;
    expect(url).toContain('response-content-disposition=attachment');
    expect(decodeURIComponent(url)).toContain('filename="clip.mp4"');
    expectWithinTtl(res.body.expiresAt as string, DOWNLOAD_TTL_SECONDS);

    const download = await fetch(url);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toBe(
      'attachment; filename="clip.mp4"',
    );
  });

  // ---- 4. Authorization Matrix — JWT obrigatório ------------------------

  it('4.1 tres-rotas-sem-token-401', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');
    const video = await seedReady(accessToken);

    const responses = await Promise.all([
      request(app.getHttpServer()).get(`/videos/${video.url_id}`).expect(401),
      request(app.getHttpServer())
        .get(`/videos/${video.url_id}/stream`)
        .expect(401),
      request(app.getHttpServer())
        .get(`/videos/${video.url_id}/download`)
        .expect(401),
    ]);

    for (const res of responses) {
      expect(res.body).not.toHaveProperty('url');
      expect(res.body).not.toHaveProperty('urlId');
      expect(res.body).not.toHaveProperty('fileName');
    }
  });
});
