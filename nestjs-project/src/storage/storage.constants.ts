/** API-internal S3 client (Compose service endpoint). */
export const S3_CLIENT = Symbol('S3_CLIENT');
/** Client configured with the browser-reachable endpoint — presign only. */
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');

export const ABORT_INCOMPLETE_MULTIPART_RULE_ID = 'abort-incomplete-multipart';
export const VIDEOS_KEY_PREFIX = 'videos/';
