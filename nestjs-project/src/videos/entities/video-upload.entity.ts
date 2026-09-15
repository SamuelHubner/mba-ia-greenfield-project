import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Video } from './video.entity';

/** One multipart session per draft video (phase-03-videos/TD-02). */
@Entity('video_uploads')
export class VideoUpload {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Uniqueness comes from the one-to-one relation constraint below. */
  @Column({ type: 'uuid' })
  video_id: string;

  /** S3/MinIO `UploadId` from `CreateMultipartUpload`. */
  @Column({ type: 'varchar', length: 255 })
  storage_upload_id: string;

  @Column({ type: 'integer' })
  part_size: number;

  @Column({ type: 'integer' })
  part_count: number;

  /** `initiatedAt + UPLOAD_SESSION_TTL_HOURS` (upload-policy/TD-05). */
  @Column({ name: 'upload_expires_at', type: 'timestamptz' })
  uploadExpiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  aborted_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @OneToOne(() => Video, (video) => video.upload, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'video_id' })
  video: Video;
}
