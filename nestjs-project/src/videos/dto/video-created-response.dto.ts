import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class UploadSessionResponseDto {
  @ApiProperty({ example: 67108864, description: 'Part size in bytes' })
  partSize: number;

  @ApiProperty({ example: 4, description: 'ceil(fileSize / partSize)' })
  partCount: number;

  @ApiProperty({
    example: '2026-09-16T12:00:00.000Z',
    description: 'ISO-8601 deadline to complete the upload',
  })
  uploadExpiresAt: string;
}

export class VideoCreatedResponseDto {
  @ApiProperty({ example: 'AbC123xYz09', minLength: 11, maxLength: 11 })
  urlId: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ type: UploadSessionResponseDto })
  upload: UploadSessionResponseDto;
}
