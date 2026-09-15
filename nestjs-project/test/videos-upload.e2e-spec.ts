import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../src/video-processing/video-processing.constants';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VideoUpload } from '../src/videos/entities/video-upload.entity';

const MIB = 1024 * 1024;
const PART_SIZE = 64 * MIB; // UPLOAD_PART_SIZE_BYTES default
const FOUR_PART_FILE_SIZE = 200 * MIB; // 209715200 → partCount 4
const FIVE_MIB = 5 * MIB; // S3 minimum for non-final parts
const URL_ID_REGEX = /^[A-Za-z0-9]{11}$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('videos-upload', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let uploadRepository: Repository<VideoUpload>;
  let queue: Queue<ProcessVideoJobData>;
  let throttlerStorage: ThrottlerStorageService;
  let publicEndpoint: string;

  beforeAll(async () => {
    // Tests run inside the API container: presigned URLs must resolve here.
    process.env.STORAGE_PUBLIC_ENDPOINT = 'http://minio:9000';
    process.env.STORAGE_BUCKET = 'streamtube-media-test';
    process.env.UPLOAD_PART_SIZE_BYTES = String(PART_SIZE);
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
    uploadRepository = dataSource.getRepository(VideoUpload);
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
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

  /** Registers, confirms and logs in — the channel is created on registration. */
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

  async function createDraft(
    accessToken: string,
    fileSize = FOUR_PART_FILE_SIZE,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize })
      .expect(201);
    return res.body.urlId as string;
  }

  async function presign(
    accessToken: string,
    urlId: string,
    partNumbers: number[],
  ): Promise<{ partNumber: number; url: string; expiresAt: string }[]> {
    const res = await request(app.getHttpServer())
      .post(`/videos/${urlId}/upload/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumbers })
      .expect(200);
    return res.body.urls;
  }

  /** PUTs raw bytes straight to the storage and returns the ETag. */
  async function putPart(
    url: string,
    bytes: number,
    fill = 1,
  ): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: Buffer.alloc(bytes, fill),
    });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  }

  // ---- 1. POST /videos --------------------------------------------------

  it('1.1 create-video-sem-token-401', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send({
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        fileSize: FOUR_PART_FILE_SIZE,
      })
      .expect(401);

    expect(await videoRepository.count()).toBe(0);
    expect(await uploadRepository.count()).toBe(0);
  });

  it('1.2 create-video-abre-sessao-multipart', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        fileSize: FOUR_PART_FILE_SIZE,
      })
      .expect(201);

    expect(res.body.urlId).toMatch(URL_ID_REGEX);
    expect(res.body.status).toBe('draft');
    expect(res.body.upload.partSize).toBe(PART_SIZE);
    expect(res.body.upload.partCount).toBe(4);
    expect(res.body.upload.uploadExpiresAt).toMatch(ISO_DATE_REGEX);
    expect(new Date(res.body.upload.uploadExpiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const videos = await videoRepository.find({
      relations: { channel: true, upload: true },
    });
    expect(videos).toHaveLength(1);
    expect(videos[0].url_id).toBe(res.body.urlId);
    expect(videos[0].status).toBe(VideoStatus.DRAFT);
    expect(videos[0].channel.user_id).toBeDefined();
    const [{ user_id: channelOwner }] = await dataSource.query(
      'SELECT user_id FROM "channels" WHERE id = $1',
      [videos[0].channel_id],
    );
    const [{ id: userId }] = await dataSource.query(
      'SELECT id FROM "users" WHERE email = $1',
      ['owner@test.com'],
    );
    expect(channelOwner).toBe(userId);
    expect(videos[0].upload!.storage_upload_id).not.toBe('');
    expect(videos[0].upload!.part_count).toBe(4);
  });

  it('1.3 create-video-validation-error-400', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize: 'abc' })
      .expect(400);

    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.message)).toBe(true);
    expect(
      (res.body.message as string[]).some((m) => m.includes('fileSize')),
    ).toBe(true);
    expect(await videoRepository.count()).toBe(0);
  });

  it('1.4 create-video-formato-nao-suportado-415', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fileName: 'doc.pdf', mimeType: 'video/mp4', fileSize: MIB })
      .expect(415);

    expect(res.body.error).toBe('UNSUPPORTED_VIDEO_FORMAT');
    expect(await videoRepository.count()).toBe(0);
  });

  // ---- 2. POST /videos/:urlId/upload/parts ------------------------------

  it('2.1 part-urls-presign-e-aceitam-put', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');
    const urlId = await createDraft(accessToken);

    const res = await request(app.getHttpServer())
      .post(`/videos/${urlId}/upload/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumbers: [1, 2] })
      .expect(200);

    const urls = res.body.urls as {
      partNumber: number;
      url: string;
      expiresAt: string;
    }[];
    expect(urls).toHaveLength(2);
    expect(urls.map((u) => u.partNumber)).toEqual([1, 2]);
    for (const part of urls) {
      expect(part.url.startsWith(publicEndpoint)).toBe(true);
      const query = new URL(part.url).searchParams;
      expect(query.get('uploadId')).toBeTruthy();
      expect(query.get('partNumber')).toBe(String(part.partNumber));
      expect(part.expiresAt).toMatch(ISO_DATE_REGEX);
      expect(new Date(part.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }

    const etag = await putPart(urls[0].url, FIVE_MIB);
    expect(etag).not.toBe('');
  });

  it('2.2 part-urls-fora-do-intervalo-400', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');
    const urlId = await createDraft(accessToken);

    const res = await request(app.getHttpServer())
      .post(`/videos/${urlId}/upload/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumbers: [99] })
      .expect(400);

    expect(res.body.error).toBe('INVALID_PART_NUMBERS');
  });

  // ---- 3. GET /videos/:urlId/upload -------------------------------------

  it('3.1 upload-status-lista-partes-enviadas', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');
    const urlId = await createDraft(accessToken);

    const before = await request(app.getHttpServer())
      .get(`/videos/${urlId}/upload`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(before.body).toMatchObject({
      status: 'draft',
      partSize: PART_SIZE,
      partCount: 4,
      uploadedParts: [],
    });

    const [part1] = await presign(accessToken, urlId, [1]);
    const etag = await putPart(part1.url, FIVE_MIB);

    const after = await request(app.getHttpServer())
      .get(`/videos/${urlId}/upload`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(after.body.uploadedParts).toEqual([
      { partNumber: 1, etag, size: FIVE_MIB },
    ]);
  });

  // ---- 4. POST /videos/:urlId/upload/complete ---------------------------

  it('4.1 complete-move-para-processing-e-repeticao-409', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');
    const urlId = await createDraft(accessToken);
    const urls = await presign(accessToken, urlId, [1, 2, 3, 4]);
    const parts: { partNumber: number; etag: string }[] = [];
    for (const part of urls) {
      const bytes = part.partNumber === 4 ? 1024 : FIVE_MIB;
      parts.push({
        partNumber: part.partNumber,
        etag: await putPart(part.url, bytes, part.partNumber),
      });
    }

    const res = await request(app.getHttpServer())
      .post(`/videos/${urlId}/upload/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts })
      .expect(200);

    expect(res.body.urlId).toBe(urlId);
    expect(res.body.status).toBe('processing');
    const video = await videoRepository.findOneOrFail({
      where: { url_id: urlId },
    });
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.sizeBytes).toBe(3 * FIVE_MIB + 1024);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
    expect(jobs[0].id).toBe(video.id);
    expect(jobs[0].data).toEqual({ videoId: video.id });

    const again = await request(app.getHttpServer())
      .post(`/videos/${urlId}/upload/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts })
      .expect(409);
    expect(again.body.error).toBe('UPLOAD_NOT_ACTIVE');
    expect(await queue.getJobs(['waiting', 'delayed', 'active'])).toHaveLength(
      1,
    );
  });

  // ---- 5. DELETE /videos/:urlId/upload ----------------------------------

  it('5.1 abort-descarta-draft-204', async () => {
    const accessToken = await registerConfirmAndLogin('owner@test.com');
    const urlId = await createDraft(accessToken);

    const res = await request(app.getHttpServer())
      .delete(`/videos/${urlId}/upload`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);
    expect(res.body).toEqual({});
    expect(await videoRepository.count()).toBe(0);
    expect(await uploadRepository.count()).toBe(0);

    const after = await request(app.getHttpServer())
      .get(`/videos/${urlId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);
    expect(after.body.error).toBe('VIDEO_NOT_FOUND');
  });

  // ---- 6. Authorization Matrix — owner-only -----------------------------

  it('6.1 rotas-por-urlid-com-jwt-de-outro-usuario-404', async () => {
    const ownerToken = await registerConfirmAndLogin('owner@test.com');
    const otherToken = await registerConfirmAndLogin('other@test.com');
    const urlId = await createDraft(ownerToken);

    const parts = await request(app.getHttpServer())
      .post(`/videos/${urlId}/upload/parts`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ partNumbers: [1] })
      .expect(404);
    expect(parts.body.error).toBe('VIDEO_NOT_FOUND');

    const status = await request(app.getHttpServer())
      .get(`/videos/${urlId}/upload`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    expect(status.body.error).toBe('VIDEO_NOT_FOUND');

    const complete = await request(app.getHttpServer())
      .post(`/videos/${urlId}/upload/complete`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ parts: [{ partNumber: 1, etag: 'x' }] })
      .expect(404);
    expect(complete.body.error).toBe('VIDEO_NOT_FOUND');

    const abort = await request(app.getHttpServer())
      .delete(`/videos/${urlId}/upload`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    expect(abort.body.error).toBe('VIDEO_NOT_FOUND');

    const video = await videoRepository.findOneOrFail({
      where: { url_id: urlId },
    });
    expect(video.status).toBe(VideoStatus.DRAFT);
  });
});
