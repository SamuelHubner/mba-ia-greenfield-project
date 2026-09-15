import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VIDEO_PROCESSING_QUEUE } from './video-processing/video-processing.constants';
import { WorkerModule } from './worker/worker.module';

/** Video Worker entry point: a Nest application context without an HTTP server. */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log(
    `Video worker consuming queue "${VIDEO_PROCESSING_QUEUE}"`,
    'Worker',
  );
}
void bootstrap();
