import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class UploadedPartResponseDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ example: '"9bb58f26192e4ba00f01e2e7b136bbd8"' })
  etag: string;

  @ApiProperty({ example: 67108864, description: 'Bytes stored for the part' })
  size: number;
}

export class UploadStatusResponseDto {
  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 67108864 })
  partSize: number;

  @ApiProperty({ example: 4 })
  partCount: number;

  @ApiProperty({ example: '2026-09-16T12:00:00.000Z' })
  uploadExpiresAt: string;

  @ApiProperty({
    type: [UploadedPartResponseDto],
    description: 'Parts the storage already holds; empty when not active',
  })
  uploadedParts: UploadedPartResponseDto[];
}
