import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { DownloadUrlResponseDto } from './dto/download-url-response.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import { StreamUrlResponseDto } from './dto/stream-url-response.dto';
import { UploadCompletedResponseDto } from './dto/upload-completed-response.dto';
import { UploadStatusResponseDto } from './dto/upload-status-response.dto';
import { VideoCreatedResponseDto } from './dto/video-created-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

const ApiError = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  });

const ApiUrlIdParam = () =>
  ApiParam({
    name: 'urlId',
    description: 'Public 11-char base62 video identifier',
    example: 'AbC123xYz09',
  });

/**
 * HTTP wiring over `VideosService` for the presigned multipart upload
 * lifecycle. Every route requires a JWT (global guard); routes by `:urlId`
 * are owner-only and answer 404 to anyone else.
 */
@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a draft video and open its upload session',
    description:
      'Registers the video as draft in the caller’s channel and opens a multipart upload in the object storage. The bytes never pass through the API.',
  })
  @ApiCreatedResponse({ type: VideoCreatedResponseDto })
  @ApiError(400, 'Validation failed')
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(413, 'Declared size above the cap or too many parts')
  @ApiError(415, 'Extension not allowed or non-video mime type')
  @ApiError(502, 'Object storage unavailable')
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<VideoCreatedResponseDto> {
    const video = await this.videosService.initiateUpload(user.sub, dto);
    return {
      urlId: video.url_id,
      status: video.status,
      upload: {
        partSize: video.upload.part_size,
        partCount: video.upload.part_count,
        uploadExpiresAt: video.upload.uploadExpiresAt.toISOString(),
      },
    };
  }

  @Get(':urlId')
  @ApiUrlIdParam()
  @ApiOperation({
    summary: 'Get a video by its public id',
    description:
      'Registry entry with the metadata extracted by the worker, a presigned thumbnail URL once ready, and the processing error when it failed.',
  })
  @ApiOkResponse({ type: VideoResponseDto })
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'Video not found or not owned by the caller')
  @ApiError(502, 'Object storage unavailable')
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('urlId') urlId: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getByUrlId(user.sub, urlId);
  }

  @Get(':urlId/stream')
  @ApiUrlIdParam()
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Short-lived presigned GET for the source object; the storage serves Range/206. JSON instead of a redirect because the caller must send the bearer token.',
  })
  @ApiOkResponse({ type: StreamUrlResponseDto })
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'Video not found or not owned by the caller')
  @ApiError(409, 'Video is not ready yet')
  @ApiError(502, 'Object storage unavailable')
  async getStreamUrl(
    @CurrentUser() user: JwtPayload,
    @Param('urlId') urlId: string,
  ): Promise<StreamUrlResponseDto> {
    const presigned = await this.videosService.getStreamUrl(user.sub, urlId);
    return { url: presigned.url, expiresAt: presigned.expiresAt.toISOString() };
  }

  @Get(':urlId/download')
  @ApiUrlIdParam()
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Presigned GET with response-content-disposition=attachment signed into the URL, using the original file name.',
  })
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'Video not found or not owned by the caller')
  @ApiError(409, 'Video is not ready yet')
  @ApiError(502, 'Object storage unavailable')
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('urlId') urlId: string,
  ): Promise<DownloadUrlResponseDto> {
    const download = await this.videosService.getDownloadUrl(user.sub, urlId);
    return {
      url: download.url,
      expiresAt: download.expiresAt.toISOString(),
      fileName: download.fileName,
    };
  }

  @Post(':urlId/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiUrlIdParam()
  @ApiOperation({
    summary: 'Issue presigned PUT URLs for a batch of parts',
    description:
      'Also the resume path: ask again for any part that is missing or whose URL expired. Keep the ETag of each PUT for completion.',
  })
  @ApiOkResponse({ type: PartUrlsResponseDto })
  @ApiError(400, 'Validation failed or part numbers outside 1..partCount')
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'Video not found or not owned by the caller')
  @ApiError(409, 'Upload session is no longer active')
  @ApiError(410, 'Upload session expired (aborted, draft moved to error)')
  @ApiError(502, 'Object storage unavailable')
  async requestPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('urlId') urlId: string,
    @Body() dto: RequestPartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    const urls = await this.videosService.issuePartUrls(
      user.sub,
      urlId,
      dto.partNumbers,
    );
    return {
      urls: urls.map((part) => ({
        partNumber: part.partNumber,
        url: part.url,
        expiresAt: part.expiresAt.toISOString(),
      })),
    };
  }

  @Get(':urlId/upload')
  @ApiUrlIdParam()
  @ApiOperation({
    summary: 'Upload status for resume',
    description: 'Which parts the storage already holds for this session.',
  })
  @ApiOkResponse({ type: UploadStatusResponseDto })
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'Video not found or not owned by the caller')
  @ApiError(410, 'Upload session expired (aborted, draft moved to error)')
  @ApiError(502, 'Object storage unavailable')
  async getUploadStatus(
    @CurrentUser() user: JwtPayload,
    @Param('urlId') urlId: string,
  ): Promise<UploadStatusResponseDto> {
    const status = await this.videosService.getUploadStatus(user.sub, urlId);
    return {
      status: status.status,
      partSize: status.partSize,
      partCount: status.partCount,
      uploadExpiresAt: status.uploadExpiresAt.toISOString(),
      uploadedParts: status.uploadedParts,
    };
  }

  @Post(':urlId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiUrlIdParam()
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Finalizes the multipart upload, verifies the real size, moves the video to processing and enqueues the processing job.',
  })
  @ApiOkResponse({ type: UploadCompletedResponseDto })
  @ApiError(400, 'Validation failed or part list rejected')
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'Video not found or not owned by the caller')
  @ApiError(409, 'Upload session is no longer active')
  @ApiError(410, 'Upload session expired (aborted, draft moved to error)')
  @ApiError(413, 'Uploaded object exceeds the declared size or the cap')
  @ApiError(502, 'Object storage unavailable')
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('urlId') urlId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<UploadCompletedResponseDto> {
    const video = await this.videosService.completeUpload(
      user.sub,
      urlId,
      dto.parts,
    );
    return { urlId: video.url_id, status: video.status };
  }

  @Delete(':urlId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiUrlIdParam()
  @ApiOperation({
    summary: 'Abort the upload and discard the draft',
    description:
      'Aborts the multipart session in the storage and deletes the draft video.',
  })
  @ApiNoContentResponse({ description: 'Upload aborted and draft discarded' })
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'Video not found or not owned by the caller')
  @ApiError(409, 'Upload session is no longer active')
  @ApiError(502, 'Object storage unavailable')
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('urlId') urlId: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, urlId);
  }
}
