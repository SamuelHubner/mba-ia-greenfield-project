import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Length, Matches, Min } from 'class-validator';

export class CreateVideoDto {
  @ApiProperty({
    example: 'clip.mp4',
    description:
      'Original file name; the extension must be in UPLOAD_ALLOWED_EXTENSIONS',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @Length(1, 255)
  @Matches(/\.[A-Za-z0-9]+$/, { message: 'fileName must have an extension' })
  fileName: string;

  @ApiProperty({ example: 'video/mp4', pattern: '^video/[a-z0-9.+-]+$' })
  @Matches(/^video\/[a-z0-9.+-]+$/, {
    message: 'mimeType must be a video/* media type',
  })
  mimeType: string;

  @ApiProperty({
    example: 209715200,
    description: 'Declared size in bytes (≤ UPLOAD_MAX_FILE_SIZE_BYTES)',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  fileSize: number;
}
