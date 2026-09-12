---
scope_type: ad-hoc
related_phases: [3]
status: decided
date: 2026-09-12
scope_description: "Upload policy for Phase 03: where the 10GB cap is enforced, multipart part-size contract, presigned-URL issuance and TTLs (upload parts, streaming, download), abandoned-upload cleanup, and accepted video formats."
---

# Technical Decisions — Upload Policy (limits, part contract, presigned TTLs)

_Subprojects in scope:_

- `nestjs-project/` — backend that owns the upload orchestration (phase-03-videos/TD-02), the presigner (TD-06/TD-08), the bucket bootstrap (TD-09) and the worker (TD-03/TD-04). Every TD below lands here: DTO validation, config factory + Joi schema, presigner parameters, bucket lifecycle configuration, error catalog entries.
- `next-frontend/` — Frontend deferred: Phase 03 is backend-only per the assignment. TDs whose values the future uploader/player must honor (declared size, part contract, URL TTLs, accepted formats) are marked `Cross-layer` so the Fase 04/05 UI consumes them without renegotiation. No open frontend decision in this document.

> This document does **not** reopen phase-03-videos/TD-02 (presigned multipart), TD-06 (presigned GET delivery), TD-08 (AWS SDK v3) or TD-09 (single bucket, `videos/{videoId}/source.{ext}`). It fixes the **numbers and rules** those decisions left open — raised as `MD-1` by `/plan-validate 03`. Hard limits of the S3 multipart API that every option must respect: part size ≥ 5 MiB (except the last part), ≤ 5 GiB per part, ≤ 10,000 parts per upload, ≤ 5 TiB per object; SigV4 presigned URLs live at most 7 days; `@aws-sdk/s3-request-presigner` defaults `expiresIn` to 900 s. MinIO honors the same limits and the same 7-day ceiling.

> **Env contract convention (inherited from phase-01/TD-01..TD-03):** every value fixed here is exposed through a namespaced `registerAs('upload', …)` / `registerAs('storage', …)` factory, validated in `src/config/env.validation.ts` (Joi, with the defaults below) and mirrored in `compose.yaml` + `.env.example`. Defaults are the decided values; envs exist so tests and ops can tighten them without code changes.

---

## TD-01: Where the 10 GB File-Size Cap Is Enforced

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** With presigned multipart (phase-03-videos/TD-02) the bytes never pass through the API, so the API cannot count them. A presigned `UploadPart` URL carries no size condition (the `content-length-range` policy exists only for browser POST forms), and neither S3 nor MinIO offers a per-upload quota. The 10 GB cap is cited by the initiation DTO, the part planner (TD-02 below), the completion step, the worker and the e2e suite — a cross-component rule that must be decided once. The future uploader must also know the cap to fail fast client-side.

**Options:**

### Option A: Declare-and-verify — client declares `fileSize` at initiation; API rejects > cap, then verifies the real size at completion
- The initiation DTO requires `fileSize` (bytes) and rejects values above the cap with a typed 4xx (error catalog). The API derives the part plan from the declared size. On `CompleteMultipartUpload` the API sums the `ListParts` sizes (or `HeadObject`s the result); if the real size exceeds the declared size or the cap, it aborts/deletes the object and moves the draft to `error` (TD-07 semantics).
- **Pros:** Fails fast before any byte is uploaded; a malicious or buggy client cannot land an oversized object; the declared size makes the part plan deterministic and testable; the only place that needs the number is the API.
- **Cons:** Two checks (declaration + completion) instead of one; the client must know the file size up front (always true for `File` objects in browsers).

### Option B: Verify at completion only (trust the client until `Complete`)
- No size in the initiation DTO. After `CompleteMultipartUpload` the API checks the object size and deletes it when > cap.
- **Pros:** Thinner initiation contract; one check.
- **Cons:** A 12 GB upload runs to the end, burning bandwidth and storage, before being rejected; no deterministic part plan (the client picks part sizes); the failure is detected where it is most expensive to handle.

### Option C: Storage-side enforcement (bucket policy / quota)
- Rely on the storage to refuse oversized uploads.
- **Pros:** Zero application code.
- **Cons:** **Not available for presigned multipart** — no S3/MinIO primitive caps the total size of a multipart upload issued via presigned `UploadPart` URLs; MinIO bucket quotas are bucket-wide, not per object. Documented only to record why it is rejected.

**Recommendation:** **A (declare-and-verify)** — the only option that both fails fast and closes the hole, using nothing beyond the SDK already decided in TD-08. Cap value: **10 GiB = 10 737 418 240 bytes** (`UPLOAD_MAX_FILE_SIZE_BYTES`, the assignment's "10GB" read as binary so a 10.0 GB file on any OS fits).

**Decision:** A (declare `fileSize` at initiation + verify at completion; cap 10 GiB = `UPLOAD_MAX_FILE_SIZE_BYTES`)
**Libraries:** @aws-sdk/client-s3

---

## TD-02: Multipart Part-Size Contract

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** S3 accepts parts between 5 MiB and 5 GiB, at most 10,000 per upload. Someone has to pick the part size: it fixes how many presigned URLs exist per upload (TD-03), how much is re-sent after a connection drop (the plan's resumability requirement), and what the e2e tests assert. Because the client slices the file, the rule is part of the upload contract the future frontend consumes. Depends on TD-01 (the declared size feeds the part plan).

**Options:**

### Option A: Server-fixed part size, configurable — API returns `partSize` and `partCount` at initiation
- A single configured part size (default **64 MiB**); `partCount = ceil(fileSize / partSize)`; the last part may be smaller. 10 GiB → 160 parts; a 40 MB clip → 1 part. The API rejects initiation if the plan would exceed 10,000 parts (impossible under the TD-01 cap with 64 MiB, but guarded).
- **Pros:** One number to reason about, tune and test; deterministic URL count; 64 MiB balances retry cost on a drop (at most 64 MiB re-sent) against request count (160 requests for the maximum file); the client does no arithmetic beyond slicing.
- **Cons:** Small files still go through the multipart handshake (1 part) — accepted for a uniform code path; not adaptive to the client's bandwidth.

### Option B: Client-chosen part size within server-validated bounds
- The client proposes `partSize`; the API validates `5 MiB ≤ partSize ≤ 5 GiB` and `partCount ≤ 10,000`, then issues URLs accordingly.
- **Pros:** Lets an adaptive uploader (e.g., Uppy-style) tune chunk size to the network.
- **Cons:** More validation surface and error cases; part plan differs per client, so tests must cover the bounds matrix; no frontend exists in this phase to benefit from the flexibility.

### Option C: Server-computed adaptive part size (target part count, clamped to bounds)
- The API computes `partSize = clamp(ceil(fileSize / TARGET_PARTS), 8 MiB, 5 GiB)` so every upload has roughly the same number of parts.
- **Pros:** Uniform URL count regardless of file size.
- **Cons:** Part size varies per file, which is harder to reason about in logs and tests; a 10 GiB file at 100 target parts yields ~107 MiB parts — larger re-send cost on failure than Option A; the added logic buys nothing the phase needs.

**Recommendation:** **A (server-fixed 64 MiB, configurable via `UPLOAD_PART_SIZE_BYTES`)** — simplest contract that satisfies the resumability requirement with a bounded retry cost; the Joi schema enforces `min(5 MiB)` so a misconfiguration can never violate the S3 minimum.

**Decision:** A (server-fixed part size, 64 MiB default via `UPLOAD_PART_SIZE_BYTES`; API returns `partSize` + `partCount`)

---

## TD-03: Upload-Part Presigned URL Issuance and TTL

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** phase-03-videos/TD-02 says the API "issues presigned URLs for each `UploadPart`" but not **when** (all at initiation vs on demand) nor **for how long**. TTL and issuance mode are coupled: URLs issued up front must outlive the whole upload (10 GiB on a 50 Mbps link ≈ 30 min; on a slow link, hours), while on-demand URLs can be short-lived. The plan also requires resuming after a connection failure, which needs a "which parts are already there, give me fresh URLs" path anyway. Depends on TD-02 (part count).

**Options:**

### Option A: On-demand batches with short TTL — `POST …/upload/parts` takes a list of part numbers and returns presigned URLs; TTL 1 hour
- The client requests URLs for the parts it is about to send (any subset, e.g., 10 at a time) and re-requests on expiry or after a resume. A companion `GET …/upload/status` (backed by `ListParts`) tells which parts already exist. Each URL lives **3600 s** (`UPLOAD_PART_URL_TTL_SECONDS`).
- **Pros:** Resume and initial issuance are the **same endpoint** — no special resume code path; short TTL limits the blast radius of a leaked URL; the response for a 160-part upload stays small; the TTL is decoupled from total upload duration.
- **Cons:** One extra round-trip per batch; the client must handle 403 from the storage by re-requesting the URL (a well-understood pattern).

### Option B: All part URLs issued at initiation with a long TTL (24 h)
- Initiation returns 1..N presigned URLs at once; TTL **86 400 s** so slow uploads finish. Resume requires a separate "reissue" endpoint because the original URLs may have expired.
- **Pros:** Fewest round-trips; the simplest client loop.
- **Cons:** A 160-URL payload per initiation; long-lived URLs widen the exposure window; still needs a reissue path for resume, so it does not actually remove the second endpoint; a 24 h ceiling silently fails uploads on very slow links.

### Option C: One URL per part, fetched individually just before sending it
- `GET …/upload/parts/:partNumber` per part, TTL 15 min (SDK default).
- **Pros:** Minimal TTL; trivially stateless.
- **Cons:** 160 API calls for the maximum file with no batching; parallel part uploads are throttled by URL fetching; the phase-02 rate limiter (phase-02-auth/TD-08) would need a carve-out. Strictly worse than A.

**Recommendation:** **A (on-demand batches, 1 h TTL)** — it is the only option where resumability falls out of the normal flow instead of being a bolt-on, and 1 h comfortably covers a batch of 64 MiB parts on any realistic link while staying far below the 7-day SigV4 ceiling. The batch size limit (e.g., ≤ 100 part numbers per request) is a DTO detail left to `implement`.

**Decision:** A (on-demand batches via `POST …/upload/parts`; TTL 1 h via `UPLOAD_PART_URL_TTL_SECONDS`)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-04: Playback and Download Presigned URL TTLs

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** phase-03-videos/TD-06 delivers video through presigned GET URLs (storage serves bytes, Range/206) and download through the same URL with `response-content-disposition=attachment`. It lists "URLs expire (player may need to re-request on very long sessions)" as a con without fixing the expiry. S3 checks expiry **at request time**: a download already streaming is never cut, but every seek in a `<video>` element is a new Range request that fails with 403 once the URL has expired. The value is consumed by the Fase 05 player and by the e2e assertions.

**Options:**

### Option A: One shared TTL for streaming and download (1 h)
- A single `MEDIA_URL_TTL_SECONDS = 3600` used for both presigned GETs.
- **Pros:** One knob; one code path.
- **Cons:** A viewer who pauses a feature-length video for over an hour hits 403 on the next seek; a download only needs to **start** within the window, so 1 h is oversized for download and undersized for playback — one number cannot fit both.

### Option B: Per-purpose TTLs — streaming 6 h, download 1 h
- `MEDIA_STREAM_URL_TTL_SECONDS = 21 600` covers the longest plausible single viewing session including pauses and seeks; `MEDIA_DOWNLOAD_URL_TTL_SECONDS = 3600` is enough to start the download (the in-flight transfer is unaffected by expiry). Both well under the 7-day ceiling. The player may still re-request the playback URL on 403.
- **Pros:** Each value matches its purpose; the download URL (the one most likely to be copied around) stays short-lived; two env keys, zero extra logic.
- **Cons:** Two knobs to document; 6 h is a judgment call rather than a derivation.

### Option C: Duration-aware streaming TTL — `max(1 h, 2 × video.duration)`; download fixed 1 h
- The API reads the duration extracted by the worker (TD-04 of the phase) and sizes the playback URL accordingly.
- **Pros:** "Provably" long enough for one uninterrupted play-through.
- **Cons:** Ties URL issuance to processed metadata (what about `processing` drafts being previewed by their owner?); pauses are not bounded by duration, so the formula does not actually remove 403 handling from the player; more logic for no removed failure mode.

**Recommendation:** **B (per-purpose TTLs: stream 6 h, download 1 h)** — separates the two access patterns TD-06 already distinguishes, keeps the download link short-lived, and costs nothing beyond two config keys. The player must handle 403-on-seek by re-fetching the URL regardless of option, so the simplest fixed values win.

**Decision:** B (per-purpose TTLs: stream 6 h `MEDIA_STREAM_URL_TTL_SECONDS`, download 1 h `MEDIA_DOWNLOAD_URL_TTL_SECONDS`)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-05: Abandoned-Upload Cleanup Policy

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Every initiation creates a `draft` video row and an open multipart upload on the storage. Uploads the user never finishes leave invisible part data behind — at 10 GiB scale this is the storage-cost concern the plan's "Pontos de Atenção — Armazenamento" calls out. Something must define when an unfinished upload is dead and who removes the parts and the draft. The rule touches bucket bootstrap (TD-09 of the phase), the draft entity and the upload endpoints — a cross-file contract.

**Options:**

### Option A: Storage lifecycle rule aborts stale multiparts + API enforces an upload-session deadline on the draft
- At bucket bootstrap (where TD-09 already runs `CreateBucket`) the API also puts a lifecycle configuration with `AbortIncompleteMultipartUpload.DaysAfterInitiation = 1` (supported by S3 and MinIO; `ListParts` exposes the resulting `AbortDate`). The draft stores `uploadExpiresAt = initiatedAt + UPLOAD_SESSION_TTL_HOURS (24)`; part-URL and complete requests after that instant are rejected with a typed error and the draft is marked `error` (or deleted) lazily, on the rejected call.
- **Pros:** The storage cleans its own garbage with zero application scheduling — same behavior on MinIO and S3; the session deadline gives the client a clear, documented contract ("finish within 24 h"); no cron/repeatable job to test in this phase.
- **Cons:** Draft rows that are never touched again are not physically removed until someone calls them (a listing filter on `status`/`uploadExpiresAt` hides them); two knobs must stay coherent (`DaysAfterInitiation ≥ session TTL`).

### Option B: Application-side scheduled sweeper (BullMQ repeatable job)
- A repeatable job (phase-03-videos/TD-01 queue) lists open multipart uploads and stale drafts and aborts/deletes them.
- **Pros:** One place removes both the parts and the draft row; fully under application control and observable in logs.
- **Cons:** New scheduled component to run in the worker and to test (time-dependent logic); duplicates a capability the storage already provides; a sweeper bug can abort live uploads.

### Option C: No cleanup in Phase 03 (defer)
- Accept orphaned parts/drafts until a later phase.
- **Pros:** Zero work now.
- **Cons:** Orphaned 10 GiB uploads accumulate silently in dev and prod; contradicts the plan's explicit storage-growth warning; the lifecycle rule is a few lines at a bootstrap point the phase already writes.

**Recommendation:** **A (lifecycle abort after 1 day + 24 h upload-session deadline on the draft)** — storage-native cleanup with no scheduler, a documented client deadline, and the periodic draft sweep left as an explicit future task once Fase 04's video management defines what the owner sees. Values: `UPLOAD_SESSION_TTL_HOURS = 24`, `STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS = 1` (Joi: days × 24 ≥ session TTL).

**Decision:** A (bucket lifecycle `AbortIncompleteMultipartUpload` after 1 day + 24 h upload-session deadline on the draft)
**Libraries:** @aws-sdk/client-s3

---

## TD-06: Accepted Video Formats at Initiation

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** phase-03-videos/TD-09 stores the source as `videos/{videoId}/source.{ext}` — the API must know the extension **at initiation**, before any byte exists. The worker (TD-04 of the phase) runs `ffprobe`, which will fail on non-video input and route the video to `error` (TD-07). The open question is whether the API filters formats up front, and on what evidence (the client-declared filename/MIME is unverifiable until the worker reads the object). The accepted list is part of the client contract and of the error catalog.

**Options:**

### Option A: Extension + declared-MIME allowlist at initiation; `ffprobe` in the worker remains the authoritative check
- The initiation DTO requires `fileName` and `mimeType`; the API accepts only a configured allowlist (default **mp4, webm, mov, mkv, avi** ↔ `video/*` MIME family) and derives `{ext}` from it; anything else gets a typed 4xx. The worker still treats an `ffprobe` failure as a processing error — the allowlist is fail-fast UX, not security.
- **Pros:** Users learn about an unsupported file before uploading 10 GiB; the `{ext}` for the TD-09 key comes from a validated value; the allowlist is one env-backed constant cited by DTO, key builder and tests.
- **Cons:** Declared MIME is spoofable (mitigated by the worker check); the allowlist must be maintained as formats are added.

### Option B: Accept any file; rely solely on the worker's `ffprobe`
- No format validation at initiation; `{ext}` taken verbatim from the declared filename (sanitized).
- **Pros:** Nothing to maintain; the single source of truth is the real probe.
- **Cons:** A user uploads 10 GiB of the wrong file and only learns at processing time; unsanitized extensions leak into object keys; the error surfaces asynchronously (status `error`) instead of as an HTTP 4xx.

### Option C: Strict container allowlist — mp4 and webm only (browser-native playback)
- Same mechanism as A but restricted to the two containers every browser plays natively via `<video>`.
- **Pros:** Guarantees that what is stored is what Fase 05's player can play without transcoding (TD-06 of the phase rejected HLS/transcoding).
- **Cons:** Rejects common camera/editor outputs (mov, mkv) that users will reasonably try; the phase's deliverable is "upload + processamento + streaming", not browser-playability of every source — and that concern can tighten the same allowlist later without a new TD.

**Recommendation:** **A (allowlist at initiation, worker stays authoritative)** — fail-fast on the cheap signal, keep `ffprobe` as the truth, and derive the TD-09 extension from a validated value. The default list (`mp4, webm, mov, mkv, avi`) is exposed as `UPLOAD_ALLOWED_EXTENSIONS` so Fase 05 can narrow it to browser-native containers as a Revision, not a Supersede.

**Decision:** A (extension + declared-MIME allowlist `mp4,webm,mov,mkv,avi` at initiation; ffprobe in the worker stays authoritative)

---

## Notes — policy block at a glance

All six TDs were decided on 2026-09-12 (every recommendation accepted via `/plan-resolve 03`); the values below are the decided defaults.

| Env key | Default | Fixed by | Bound / rationale |
|---------|---------|----------|-------------------|
| `UPLOAD_MAX_FILE_SIZE_BYTES` | 10 737 418 240 (10 GiB) | TD-01 | assignment cap; ≤ 5 TiB S3 object limit |
| `UPLOAD_PART_SIZE_BYTES` | 67 108 864 (64 MiB) | TD-02 | Joi min 5 MiB, max 5 GiB; 10 GiB → 160 parts ≤ 10 000 |
| `UPLOAD_PART_URL_TTL_SECONDS` | 3600 | TD-03 | ≤ 604 800 (7-day SigV4 ceiling) |
| `MEDIA_STREAM_URL_TTL_SECONDS` | 21 600 | TD-04 | ≤ 604 800 |
| `MEDIA_DOWNLOAD_URL_TTL_SECONDS` | 3600 | TD-04 | ≤ 604 800 |
| `UPLOAD_SESSION_TTL_HOURS` | 24 | TD-05 | client must complete within this window |
| `STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS` | 1 | TD-05 | Joi: days × 24 ≥ `UPLOAD_SESSION_TTL_HOURS` |
| `UPLOAD_ALLOWED_EXTENSIONS` | `mp4,webm,mov,mkv,avi` | TD-06 | drives `{ext}` in the TD-09 object key |

Dependencies: TD-02 depends on TD-01 (declared size → part plan); TD-03 depends on TD-02 (part count); TD-05's two values are coupled; all TDs refine phase-03-videos/TD-02, TD-06, TD-08 and TD-09 without reopening them. No new library is introduced — everything uses `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (TD-08) and the inherited config stack (Joi + `registerAs`).

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Cross-layer | Where the 10 GB cap is enforced | A (declare at initiation + verify at completion; 10 GiB) | **A** |
| TD-02 | Cross-layer | Multipart part-size contract | A (server-fixed 64 MiB, configurable) | **A** |
| TD-03 | Cross-layer | Upload-part URL issuance and TTL | A (on-demand batches, 1 h TTL) | **A** |
| TD-04 | Cross-layer | Playback and download URL TTLs | B (stream 6 h, download 1 h) | **B** |
| TD-05 | Backend | Abandoned-upload cleanup | A (lifecycle abort 1 day + 24 h session deadline) | **A** |
| TD-06 | Cross-layer | Accepted video formats at initiation | A (allowlist mp4/webm/mov/mkv/avi; ffprobe authoritative) | **A** |
