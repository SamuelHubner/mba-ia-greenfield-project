import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class UploadCompletedResponseDto {
  @ApiProperty({ example: 'AbC123xYz09' })
  urlId: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;
}
