import { ApiProperty } from '@nestjs/swagger';

export class StreamUrlResponseDto {
  @ApiProperty({
    description:
      'Presigned GET for the source object (TTL MEDIA_STREAM_URL_TTL_SECONDS); the storage serves Range/206',
  })
  url: string;

  @ApiProperty({ example: '2026-09-15T18:00:00.000Z' })
  expiresAt: string;
}
