import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';

export class RequestPartUrlsDto {
  @ApiProperty({
    type: [Number],
    example: [1, 2, 3],
    description: 'Part numbers to presign (1..partCount, unique, ≤ 100 items)',
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
