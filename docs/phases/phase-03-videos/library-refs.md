---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1131.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-12T10:52:07-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1131.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-12T10:52:07-03:00"
sources_mtime:
  docs/decisions/technical-decisions-upload-policy.md: "2026-09-12 10:47:38.764349494"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-12 10:47:38.764724029"
---

# Library References — Phase 03 (upload policy surfaces)

_Distilled from Context7 (`/aws/aws-sdk-js-v3`) on the surfaces the decided TDs actually use. Versions are the latest published at fetch time; neither package is installed in `nestjs-project/package.json` yet — `/implement` adds them. Both packages ship from the same monorepo and must be pinned to the **same** minor to avoid duplicate `@smithy/*` trees._

### @aws-sdk/client-s3

**Used by:** phase-03-videos/TD-08 (client choice), TD-09 (bucket ensure), upload-policy/TD-01 (size verification), TD-03 (multipart lifecycle), TD-05 (lifecycle rule).

**Client construction for MinIO (dev) / S3 (prod)** — the only knobs that differ between environments are config values, never code:

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: 'http://minio:9000',      // Compose service name inside Docker; omit for real S3
  region: 'us-east-1',                // required by the signer even for MinIO
  forcePathStyle: true,               // bucket in the path, not as a DNS subdomain — mandatory for MinIO
  credentials: { accessKeyId, secretAccessKey },
});
```

`forcePathStyle` defaults to `false` (virtual-hosted `bucket.endpoint`); with `true` the URL becomes `endpoint/bucket/key`. Presigned URLs inherit this, so **the endpoint used for presigning must be the one the browser can reach** (host-mapped port in dev), which may differ from the one the API uses internally — plan for a separate `publicEndpoint` config when presigning.

**Multipart lifecycle (TD-02 of the phase + upload-policy TD-01..TD-03):**

| Step | Command | Notes |
|------|---------|-------|
| initiate | `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `{ UploadId }` | Key = `videos/{videoId}/source.{ext}` (TD-09) |
| per-part URL | presign `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` | `PartNumber` is 1..10000; the client PUTs the bytes to the URL and receives an `ETag` header |
| resume / status | `ListPartsCommand({ Bucket, Key, UploadId })` → `Parts[]{ PartNumber, ETag, Size }`, `IsTruncated`, `NextPartNumberMarker` | Also returns `AbortDate` / `AbortRuleId` when a lifecycle abort rule applies (TD-05) |
| complete | `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` | Parts must be in ascending `PartNumber` order; response carries `ETag`, `Location`, `Key` |
| abort | `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` | Used on size violation (TD-01) and on session expiry (TD-05) |
| verify size | `HeadObjectCommand({ Bucket, Key })` → `ContentLength`, `ContentType`, `ETag`, `LastModified` | Post-completion check against declared `fileSize` and the 10 GiB cap (TD-01); alternative: sum `ListParts[].Size` before completing |

S3 multipart constraints every option respects: part size ≥ 5 MiB except the last, ≤ 5 GiB per part, ≤ 10,000 parts, ≤ 5 TiB object. With the decided 64 MiB part, 10 GiB = 160 parts.

**Bucket bootstrap + lifecycle rule (TD-09 + upload-policy TD-05):**

```typescript
import { HeadBucketCommand, CreateBucketCommand, PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

// idempotent ensure: HeadBucket 404/NotFound → CreateBucket
await s3.send(new PutBucketLifecycleConfigurationCommand({
  Bucket,
  LifecycleConfiguration: {
    Rules: [{
      ID: 'abort-incomplete-multipart',
      Status: 'Enabled',
      Filter: { Prefix: 'videos/' },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },   // STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS
    }],
  },
}));
```

`AbortIncompleteMultipartUpload.DaysAfterInitiation` is the model field that makes S3 (and MinIO, which implements the same lifecycle XML) purge parts of uploads never completed. `PutBucketLifecycleConfiguration` replaces the whole configuration, so write the full rule set each time (bootstrap is idempotent by construction). **Validate against the local MinIO during `/implement`**: if MinIO rejects the element, fall back to upload-policy TD-05 Option B (sweeper job).

### @aws-sdk/s3-request-presigner

**Used by:** phase-03-videos/TD-02 (part URLs), TD-06 (playback/download), upload-policy/TD-03 (part TTL), TD-04 (media TTLs).

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';

// upload part — TTL 1 h (UPLOAD_PART_URL_TTL_SECONDS)
const partUrl = await getSignedUrl(s3, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });

// streaming — TTL 6 h (MEDIA_STREAM_URL_TTL_SECONDS); storage honors Range → 206
const streamUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 21600 });

// download — TTL 1 h (MEDIA_DOWNLOAD_URL_TTL_SECONDS); attachment disposition is signed into the URL
const downloadUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: `attachment; filename="${safeName}"` }),
  { expiresIn: 3600 },
);
```

- `expiresIn` is in **seconds** and **defaults to 900** (15 min) when omitted — always pass it explicitly from config. SigV4 caps a presigned URL at 7 days (604 800 s); MinIO enforces the same ceiling.
- `getSignedUrl(client, command, options)` works for any command; the signed URL embeds the command's query-string-able inputs (`ResponseContentDisposition`, `ResponseContentType`, `partNumber`, `uploadId`). Headers the client must send (e.g. `Content-Length` on the part PUT) are **not** signed unless listed — keep the part PUT header-free beyond what the browser adds.
- Expiry is checked **at request time**: an in-flight download is never cut, but each Range seek from a `<video>` element is a new request and gets 403 after expiry — the player must re-request the playback URL (TD-04 rationale).
- The presigner reuses the client's `endpoint` + `forcePathStyle`; to sign URLs the **browser** can reach in dev, presign with a client configured for the public endpoint (e.g. `http://localhost:9000`) while API-internal calls use the Compose service name.
