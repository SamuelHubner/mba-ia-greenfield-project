/** Queue + job names fixed by the plan's `### Events/Messages` (phase-03-videos/TD-01). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

/** The payload carries only the id — the worker re-reads the `Video` row. */
export interface ProcessVideoJobData {
  videoId: string;
}
