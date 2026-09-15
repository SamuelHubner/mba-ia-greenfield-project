import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoUpload } from './video-upload.entity';

/** draft → processing → ready | error (phase-03-videos/TD-07). */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

/** pg returns bigint as string; sizes fit comfortably in a JS number (< 2^53). */
export const bigintToNumber: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('videos')
@Index(['channel_id'])
@Index(['status'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 11-char base62 public identifier (phase-03-videos/TD-05). */
  @Column({ type: 'varchar', length: 11, unique: true })
  url_id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'video_status',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_file_name: string;

  @Column({ type: 'varchar', length: 100 })
  mime_type: string;

  @Column({ type: 'varchar', length: 8 })
  source_ext: string;

  /** `videos/{id}/source.{ext}` (phase-03-videos/TD-09). */
  @Column({ type: 'varchar', length: 255, unique: true })
  source_key: string;

  /** `videos/{id}/thumbnail.jpg` once the worker writes it. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  declared_size_bytes: number;

  @Column({ name: 'duration_seconds', type: 'integer', nullable: true })
  durationSeconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ name: 'video_codec', type: 'varchar', length: 32, nullable: true })
  videoCodec: string | null;

  @Column({
    name: 'size_bytes',
    type: 'bigint',
    nullable: true,
    transformer: bigintToNumber,
  })
  sizeBytes: number | null;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  processed_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @OneToOne(() => VideoUpload, (upload) => upload.video)
  upload: VideoUpload | null;
}
