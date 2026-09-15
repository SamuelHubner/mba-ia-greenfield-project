import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoUpload } from './video-upload.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoUpload,
];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `video_chan_${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    const n = ++counter;
    return videoRepository.create({
      url_id: `url${String(n).padStart(8, '0')}`,
      channel_id: channelId,
      original_file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      source_ext: 'mp4',
      source_key: `videos/${n}/source.mp4`,
      declared_size_bytes: 1024,
      ...overrides,
    });
  }

  it('should default status to draft and leave worker metadata null', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.durationSeconds).toBeNull();
    expect(found.width).toBeNull();
    expect(found.height).toBeNull();
    expect(found.videoCodec).toBeNull();
    expect(found.sizeBytes).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.processing_error).toBeNull();
    expect(found.processed_at).toBeNull();
  });

  it('should enforce the unique constraint on url_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      buildVideo(channel.id, { url_id: 'AAAAAAAAAAA' }),
    );

    await expect(
      videoRepository.save(buildVideo(channel.id, { url_id: 'AAAAAAAAAAA' })),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should enforce the unique constraint on source_key', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      buildVideo(channel.id, { source_key: 'videos/dup/source.mp4' }),
    );

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { source_key: 'videos/dup/source.mp4' }),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should reject a channel_id that does not exist', async () => {
    await expect(
      videoRepository.save(buildVideo('00000000-0000-4000-8000-000000000000')),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should round-trip bigint sizes as numbers', async () => {
    const channel = await createChannel();
    const tenGiB = 10 * 1024 * 1024 * 1024;

    const saved = await videoRepository.save(
      buildVideo(channel.id, {
        declared_size_bytes: tenGiB,
        sizeBytes: tenGiB - 1,
      }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(typeof found.declared_size_bytes).toBe('number');
    expect(found.declared_size_bytes).toBe(tenGiB);
    expect(typeof found.sizeBytes).toBe('number');
    expect(found.sizeBytes).toBe(tenGiB - 1);
  });

  it('should load the owning channel through the relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { channel: true },
    });

    expect(found.channel.id).toBe(channel.id);
  });
});
