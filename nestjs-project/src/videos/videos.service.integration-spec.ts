import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import {
  StorageException,
  StorageObjectNotFound,
} from '../storage/exceptions/storage.exception';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoUpload } from './entities/video-upload.entity';
import {
  FileTooLargeException,
  UploadExpiredException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { URL_ID_REGEX } from './url-id.util';
import {
  FILE_TOO_LARGE_CAUSE,
  UPLOAD_EXPIRED_CAUSE,
  VideosService,
} from './videos.service';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoUpload,
];

const TEST_BUCKET = 'streamtube-media-test';
const MIB = 1024 * 1024;
/** Smallest S3 part size, so a two-part upload stays cheap in tests. */
const PART_SIZE = 5 * MIB;

describe('VideosService (integration — DB + MinIO)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let uploadRepository: Repository<VideoUpload>;
  const producer = { enqueue: jest.fn().mockResolvedValue('job') };

  beforeAll(async () => {
    // Tests run inside the API container: presigned URLs must resolve here.
    process.env.STORAGE_PUBLIC_ENDPOINT = 'http://minio:9000';
    process.env.STORAGE_BUCKET = TEST_BUCKET;
    process.env.UPLOAD_PART_SIZE_BYTES = String(PART_SIZE);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig, uploadConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, VideoUpload]),
        ChannelsModule,
        StorageModule,
      ],
      providers: [
        VideosService,
        { provide: VideoProcessingProducer, useValue: producer },
      ],
    }).compile();
    await module.init(); // ensureBucket

    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
    channelsService = module.get(ChannelsService);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    uploadRepository = dataSource.getRepository(VideoUpload);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    producer.enqueue.mockClear();
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUserWithChannel(): Promise<User> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${Date.now()}_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelsService.createChannel(user.id, user.email);
    return user;
  }

  async function putPart(
    userId: string,
    urlId: string,
    partNumber: number,
    body: Buffer<ArrayBuffer>,
  ): Promise<{ partNumber: number; etag: string }> {
    const [part] = await service.issuePartUrls(userId, urlId, [partNumber]);
    const response = await fetch(part.url, { method: 'PUT', body });
    expect(response.status).toBe(200);
    return { partNumber, etag: response.headers.get('etag')! };
  }

  describe('initiateUpload', () => {
    it('should persist a draft Video + VideoUpload and open a real multipart session', async () => {
      const user = await createUserWithChannel();
      const before = Date.now();

      const video = await service.initiateUpload(user.id, {
        fileName: 'Clip.MP4',
        mimeType: 'video/mp4',
        fileSize: PART_SIZE + 1024,
      });

      const stored = await videoRepository.findOneOrFail({
        where: { id: video.id },
        relations: { upload: true, channel: true },
      });
      expect(stored.status).toBe(VideoStatus.DRAFT);
      expect(stored.url_id).toMatch(URL_ID_REGEX);
      expect(stored.channel.user_id).toBe(user.id);
      expect(stored.source_ext).toBe('mp4');
      expect(stored.source_key).toBe(`videos/${video.id}/source.mp4`);
      expect(stored.declared_size_bytes).toBe(PART_SIZE + 1024);
      expect(stored.upload).toMatchObject({
        part_size: PART_SIZE,
        part_count: 2,
        completed_at: null,
        aborted_at: null,
      });
      expect(stored.upload!.uploadExpiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 24 * 60 * 60 * 1000,
      );

      // The session exists in the storage (ListParts succeeds, no parts yet).
      await expect(
        storage.listParts(stored.source_key, stored.upload!.storage_upload_id),
      ).resolves.toEqual([]);

      await service.abortUpload(user.id, video.url_id);
    });

    it('should leave no rows when the storage rejects the multipart creation', async () => {
      const user = await createUserWithChannel();
      jest
        .spyOn(storage, 'createMultipartUpload')
        .mockRejectedValueOnce(
          new StorageException('CreateMultipartUpload', 'ECONNREFUSED'),
        );

      await expect(
        service.initiateUpload(user.id, {
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
          fileSize: 1024,
        }),
      ).rejects.toBeInstanceOf(StorageException);

      expect(await videoRepository.count()).toBe(0);
      expect(await uploadRepository.count()).toBe(0);
    });
  });

  describe('ownership', () => {
    it("should not expose another user's video", async () => {
      const owner = await createUserWithChannel();
      const intruder = await createUserWithChannel();
      const video = await service.initiateUpload(owner.id, {
        fileName: 'clip.webm',
        mimeType: 'video/webm',
        fileSize: 1024,
      });

      await expect(
        service.getUploadStatus(intruder.id, video.url_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.getUploadStatus(owner.id, video.url_id),
      ).resolves.toMatchObject({ status: VideoStatus.DRAFT });

      await service.abortUpload(owner.id, video.url_id);
    });
  });

  describe('completeUpload', () => {
    it('should record the real size and completed_at after real PUTs and enqueue the job', async () => {
      const user = await createUserWithChannel();
      const video = await service.initiateUpload(user.id, {
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        fileSize: PART_SIZE + 1024,
      });
      const parts = [
        await putPart(user.id, video.url_id, 1, Buffer.alloc(PART_SIZE, 1)),
        await putPart(user.id, video.url_id, 2, Buffer.alloc(1024, 2)),
      ];

      const status = await service.getUploadStatus(user.id, video.url_id);
      expect(status.uploadedParts.map((p) => p.partNumber)).toEqual([1, 2]);

      const completed = await service.completeUpload(
        user.id,
        video.url_id,
        parts,
      );

      expect(completed.status).toBe(VideoStatus.PROCESSING);
      const stored = await videoRepository.findOneOrFail({
        where: { id: video.id },
        relations: { upload: true },
      });
      expect(stored.status).toBe(VideoStatus.PROCESSING);
      expect(stored.sizeBytes).toBe(PART_SIZE + 1024);
      expect(stored.upload!.completed_at).toBeInstanceOf(Date);
      expect(producer.enqueue).toHaveBeenCalledWith(video.id);

      const head = await storage.headObject(stored.source_key);
      expect(head.contentLength).toBe(PART_SIZE + 1024);
      await storage.deleteObject(stored.source_key);
    });

    it('should delete the object and mark FILE_TOO_LARGE when more bytes than declared were uploaded', async () => {
      const user = await createUserWithChannel();
      const video = await service.initiateUpload(user.id, {
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        fileSize: 1024,
      });
      const parts = [
        await putPart(user.id, video.url_id, 1, Buffer.alloc(2048, 7)),
      ];

      await expect(
        service.completeUpload(user.id, video.url_id, parts),
      ).rejects.toBeInstanceOf(FileTooLargeException);

      const stored = await videoRepository.findOneOrFail({
        where: { id: video.id },
      });
      expect(stored.status).toBe(VideoStatus.ERROR);
      expect(stored.processing_error).toBe(FILE_TOO_LARGE_CAUSE);
      expect(producer.enqueue).not.toHaveBeenCalled();
      await expect(
        storage.headObject(stored.source_key),
      ).rejects.toBeInstanceOf(StorageObjectNotFound);
    });
  });

  describe('lazy expiry', () => {
    it('should abort the session and mark the draft as error when uploadExpiresAt has passed', async () => {
      const user = await createUserWithChannel();
      const video = await service.initiateUpload(user.id, {
        fileName: 'clip.mkv',
        mimeType: 'video/x-matroska',
        fileSize: 1024,
      });
      await uploadRepository.update(
        { video_id: video.id },
        { uploadExpiresAt: new Date(Date.now() - 1000) },
      );

      await expect(
        service.getUploadStatus(user.id, video.url_id),
      ).rejects.toBeInstanceOf(UploadExpiredException);

      const stored = await videoRepository.findOneOrFail({
        where: { id: video.id },
        relations: { upload: true },
      });
      expect(stored.status).toBe(VideoStatus.ERROR);
      expect(stored.processing_error).toBe(UPLOAD_EXPIRED_CAUSE);
      expect(stored.upload!.aborted_at).toBeInstanceOf(Date);
      await expect(
        storage.listParts(stored.source_key, stored.upload!.storage_upload_id),
      ).rejects.toMatchObject({ code: 'NoSuchUpload' });
    });
  });

  describe('abortUpload', () => {
    it('should remove the rows and the multipart session', async () => {
      const user = await createUserWithChannel();
      const video = await service.initiateUpload(user.id, {
        fileName: 'clip.mov',
        mimeType: 'video/quicktime',
        fileSize: 1024,
      });
      const { source_key, upload } = await videoRepository.findOneOrFail({
        where: { id: video.id },
        relations: { upload: true },
      });

      await service.abortUpload(user.id, video.url_id);

      expect(await videoRepository.count()).toBe(0);
      expect(await uploadRepository.count()).toBe(0);
      await expect(
        storage.listParts(source_key, upload!.storage_upload_id),
      ).rejects.toMatchObject({ code: 'NoSuchUpload' });
    });
  });
});
