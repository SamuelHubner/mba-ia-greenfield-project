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
import { Video } from './video.entity';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  VideoUpload,
];

describe('VideoUpload entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let uploadRepository: Repository<VideoUpload>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    uploadRepository = dataSource.getRepository(VideoUpload);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createVideo(): Promise<Video> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `upload_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `upload_chan_${n}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        url_id: `upl${String(n).padStart(8, '0')}`,
        channel_id: channel.id,
        original_file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        source_ext: 'mp4',
        source_key: `videos/upl-${n}/source.mp4`,
        declared_size_bytes: 1024,
      }),
    );
  }

  function buildUpload(videoId: string, expiresAt = new Date()) {
    return uploadRepository.create({
      video_id: videoId,
      storage_upload_id: 'upload-id',
      part_size: 67108864,
      part_count: 4,
      uploadExpiresAt: expiresAt,
    });
  }

  it('should enforce one upload session per video', async () => {
    const video = await createVideo();
    await uploadRepository.save(buildUpload(video.id));

    await expect(uploadRepository.save(buildUpload(video.id))).rejects.toThrow(
      QueryFailedError,
    );
  });

  it('should cascade-delete the session when the video is removed', async () => {
    const video = await createVideo();
    const upload = await uploadRepository.save(buildUpload(video.id));

    await videoRepository.delete({ id: video.id });

    expect(await uploadRepository.findOneBy({ id: upload.id })).toBeNull();
  });

  it('should persist uploadExpiresAt with timezone precision', async () => {
    const video = await createVideo();
    const expiresAt = new Date('2026-09-15T18:30:45.123Z');

    const saved = await uploadRepository.save(buildUpload(video.id, expiresAt));
    const found = await uploadRepository.findOneByOrFail({ id: saved.id });

    expect(found.uploadExpiresAt).toBeInstanceOf(Date);
    expect(found.uploadExpiresAt.toISOString()).toBe(expiresAt.toISOString());
    expect(found.completed_at).toBeNull();
    expect(found.aborted_at).toBeNull();

    const [column] = await dataSource.query<{ data_type: string }[]>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'video_uploads' AND column_name = 'upload_expires_at'`,
    );
    expect(column.data_type).toBe('timestamp with time zone');
  });
});
