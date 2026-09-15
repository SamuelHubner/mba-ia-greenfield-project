import { ApiProperty } from '@nestjs/swagger';

export class DownloadUrlResponseDto {
  @ApiProperty({
    description:
      'Presigned GET with response-content-disposition=attachment (TTL MEDIA_DOWNLOAD_URL_TTL_SECONDS)',
  })
  url: string;

  @ApiProperty({ example: '2026-09-15T13:00:00.000Z' })
  expiresAt: string;

  @ApiProperty({ example: 'clip.mp4', description: 'Original file name' })
  fileName: string;
}
