import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ example: 'AbC123xYz09' })
  urlId: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ example: 'clip.mp4' })
  originalFileName: string;

  @ApiProperty({ example: 'video/mp4' })
  mimeType: string;

  @ApiProperty({ type: Number, nullable: true, example: 125 })
  durationSeconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  videoCodec: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 15729664 })
  sizeBytes: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Presigned GET for videos/{id}/thumbnail.jpg (TTL MEDIA_STREAM_URL_TTL_SECONDS); null until ready',
  })
  thumbnailUrl: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'FFPROBE_FAILED',
    description: 'Populated only when status = error',
  })
  processingError: string | null;

  @ApiProperty({ example: '2026-09-15T12:00:00.000Z' })
  createdAt: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-09-15T12:01:30.000Z',
  })
  processedAt: string | null;
}
