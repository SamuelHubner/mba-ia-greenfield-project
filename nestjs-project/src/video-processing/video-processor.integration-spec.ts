import { readFile, stat } from 'node:fs/promises';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { makeTestVideo } from '../test/fixtures/make-test-video';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoUpload } from '../videos/entities/video-upload.entity';
import { generateUrlId } from '../videos/url-id.util';
import { FfmpegModule } from './ffmpeg/ffmpeg.module';
import { ProcessVideoJobData } from './video-processing.constants';
import { SourceNotFoundError } from './video-processing.errors';
import { VideoProcessor } from './video-processor';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoUpload,
];
const TEST_BUCKET = 'streamtube-media-test';
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

function jobFor(videoId: string, attemptsMade = 0): Job<ProcessVideoJobData> {
  return {
    id: videoId,
    name: 'process-video',
    data: { videoId },
    attemptsMade,
    opts: { attempts: 3 },
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessor (integration — DB + MinIO + ffmpeg)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let processor: VideoProcessor;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let fixture: Buffer;
  let fixtureSize: number;

  beforeAll(async () => {
    process.env.STORAGE_BUCKET = TEST_BUCKET;

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig, uploadConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        FfmpegModule,
      ],
      providers: [VideoProcessor],
    }).compile();
    await module.init(); // ensureBucket

    dataSource = module.get(DataSource);
    processor = module.get(VideoProcessor);
    storage = module.get(StorageService);
    videoRepository = dataSource.getRepository(Video);

    const path = await makeTestVideo({ durationSeconds: 2, size: '64x64' });
    fixture = await readFile(path);
    fixtureSize = (await stat(path)).size;
  }, 60000);

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createProcessingVideo(uploadSource = true): Promise<Video> {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `worker_it_${Date.now()}_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: `w${counter}`,
        nickname: `worker_it_${Date.now()}_${counter}`,
        user_id: user.id,
      }),
    );
    const video = await videoRepository.save(
      videoRepository.create({
        url_id: generateUrlId(),
        channel_id: channel.id,
        status: VideoStatus.PROCESSING,
        original_file_name: 'fixture.mp4',
        mime_type: 'video/mp4',
        source_ext: 'mp4',
        source_key: `videos/${crypto.randomUUID()}/source.mp4`,
        declared_size_bytes: fixtureSize,
      }),
    );
    // Key follows the id only once it exists; align it with TD-09.
    video.source_key = `videos/${video.id}/source.mp4`;
    await videoRepository.save(video);
    if (uploadSource) {
      await storage.putObject(video.source_key, fixture, 'video/mp4');
    }
    return video;
  }

  it('should extract metadata, write the thumbnail and mark the video ready', async () => {
    const video = await createProcessingVideo();

    await processor.process(jobFor(video.id));

    const stored = await videoRepository.findOneOrFail({
      where: { id: video.id },
    });
    expect(stored).toMatchObject({
      status: VideoStatus.READY,
      durationSeconds: 2,
      width: 64,
      height: 64,
      videoCodec: 'h264',
      sizeBytes: fixtureSize,
      thumbnail_key: `videos/${video.id}/thumbnail.jpg`,
      processing_error: null,
    });
    expect(stored.processed_at).toBeInstanceOf(Date);

    const head = await storage.headObject(stored.thumbnail_key!);
    expect(head.contentType).toBe('image/jpeg');
    expect(head.contentLength).toBeGreaterThan(0);
    const { url } = await storage.presignInternalGetObject(
      stored.thumbnail_key!,
      60,
    );
    const jpeg = Buffer.from(await (await fetch(url)).arrayBuffer());
    expect(jpeg.subarray(0, 3)).toEqual(JPEG_SIGNATURE);

    await storage.deleteObject(stored.source_key);
    await storage.deleteObject(stored.thumbnail_key!);
  }, 60000);

  it('should not touch a video that is already ready (duplicate job)', async () => {
    const video = await createProcessingVideo();
    await processor.process(jobFor(video.id));
    const first = await videoRepository.findOneOrFail({
      where: { id: video.id },
    });
    const putSpy = jest.spyOn(storage, 'putObject');

    await processor.process(jobFor(video.id));

    const second = await videoRepository.findOneOrFail({
      where: { id: video.id },
    });
    expect(second.processed_at).toEqual(first.processed_at);
    expect(putSpy).not.toHaveBeenCalled();
    putSpy.mockRestore();

    await storage.deleteObject(video.source_key);
    await storage.deleteObject(second.thumbnail_key!);
  }, 60000);

  it('should fail with SOURCE_NOT_FOUND when the object is missing and record it on the last attempt', async () => {
    const video = await createProcessingVideo(false);

    const error = await processor
      .process(jobFor(video.id))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceNotFoundError);

    await processor.onFailed(jobFor(video.id, 1), error as Error);
    expect(
      (await videoRepository.findOneOrFail({ where: { id: video.id } })).status,
    ).toBe(VideoStatus.PROCESSING);

    await processor.onFailed(jobFor(video.id, 3), error as Error);
    const stored = await videoRepository.findOneOrFail({
      where: { id: video.id },
    });
    expect(stored.status).toBe(VideoStatus.ERROR);
    expect(stored.processing_error).toBe('SOURCE_NOT_FOUND');
    expect(stored.processed_at).toBeInstanceOf(Date);
  });
});
