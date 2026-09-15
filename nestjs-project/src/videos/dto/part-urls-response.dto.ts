import { ApiProperty } from '@nestjs/swagger';

export class PartUrlResponseDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    example:
      'http://localhost:9000/streamtube-media/videos/…?partNumber=1&uploadId=…',
    description: 'Presigned PUT URL for the raw part bytes (no extra headers)',
  })
  url: string;

  @ApiProperty({ example: '2026-09-15T13:00:00.000Z' })
  expiresAt: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlResponseDto] })
  urls: PartUrlResponseDto[];
}
