---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-31
scope_description: "Video upload and processing backend: object storage usage (S3/MinIO), background processing queue, video worker (FFmpeg), 10GB upload strategy, unique URLs, streaming and download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (upload orchestration, video registry, unique URLs, streaming/download endpoints), the processing queue producer, and the video worker (FFmpeg) consuming it. All TDs in this document target this subproject; infrastructure additions (object storage, queue broker, worker container) land in its `compose.yaml`.
- `next-frontend/` — Frontend deferred: the assignment explicitly scopes Phase 03 as backend-only ("a interface de vídeo não faz parte do escopo desta fase"). Upload/streaming contracts are marked `Cross-layer` so the future video UI consumes them without renegotiation. No open frontend decision in this document.

> Object storage is **not** an open choice: the project plan and architecture (docs/diagrams/software-arch.mermaid) already fix S3-compatible storage — MinIO in local Docker, drop-in S3 in production. The TDs below decide **how** to use it (client library, upload protocol, bucket/key organization, delivery), not **which** storage to use.

---

## TD-01: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan leaves the queue technology explicitly "TBD" — this is the main open stack decision of the phase. The queue transports video-processing jobs (metadata extraction + thumbnail) from the API to the worker. Requirements: at-least-once delivery, retries with backoff (video processing fails for real-world reasons: corrupt files, codec issues), job state visibility, and a real broker service running in Docker Compose alongside the backend (an acceptance criterion of the phase).

**Options:**

### Option A: BullMQ + Redis
- Jobs are stored in Redis; `bullmq` provides queues/workers with retries, exponential backoff, concurrency control, and stalled-job recovery. Official NestJS integration via `@nestjs/bullmq` (`BullModule`, `@Processor`/`WorkerHost`), documented in the NestJS docs themselves.
- **Pros:** First-class job semantics (attempts, backoff, failed state) — exactly the video-processing shape; official NestJS module; the de-facto standard Node.js queue (~500K weekly downloads); Redis is a visible, dedicated queue service in Compose.
- **Cons:** Adds Redis as new infrastructure to operate; Redis persistence is weaker than Postgres (acceptable for re-runnable processing jobs).

### Option B: pg-boss (queue on PostgreSQL)
- Implements a job queue on the existing PostgreSQL using `SKIP LOCKED`; active project (v12.x, requires PG 13+, compatible with the project's PG 17). No new broker service.
- **Pros:** Zero new infrastructure; ACID guarantees — job enqueue can share the transaction that updates the video row; simple operations.
- **Cons:** No dedicated queue service visible in Compose — weakens the phase's explicit deliverable of "fila subindo via docker compose" (the queue would be invisible inside the `db` container); couples processing load to the transactional database; no official NestJS module (manual lifecycle wiring).

### Option C: RabbitMQ (AMQP broker)
- Full message broker; NestJS integration via `@nestjs/microservices` (RMQ transport) or `@golevelup/nestjs-rabbitmq`. Exchanges/queues/acks model.
- **Pros:** Real broker with strong delivery guarantees and management UI; language-agnostic (worker could be non-Node someday).
- **Cons:** Job semantics (retries with backoff, scheduled retry, job state) must be hand-built with DLX/TTL topologies — significant complexity for a single job type; heavier operational footprint than Redis for this use case.

**Recommendation:** **A (BullMQ + Redis)** — it is the only option that combines ready-made job semantics (attempts/backoff/failed state, which TD-07 consumes directly), an official NestJS 11 integration, and a dedicated queue service visibly running in Compose. RabbitMQ buys generality the phase doesn't need at the cost of hand-rolled retry topology; pg-boss buys simplicity at the cost of making the phase's queue deliverable invisible.

**Decision:** A (BullMQ + Redis)

---

## TD-02: 10GB Upload Strategy (without blocking the API)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Files up to 10GB must reach object storage without the bytes flowing through the NestJS process (an explicit auto-fail in the assignment). Hard constraint from the S3 API itself: a single `PutObject`/presigned PUT is capped at **5GB** — 10GB physically requires multipart upload. The project plan's "Pontos de Atenção" also asks for resumability on connection failure. The chosen handshake is a contract the future frontend uploader will consume (hence Cross-layer).

**Options:**

### Option A: API-orchestrated presigned multipart upload (S3 native)
- Client asks the API to start an upload → API pre-registers the video as draft, calls `CreateMultipartUpload`, and issues presigned URLs for each `UploadPart` (client uploads parts directly to MinIO/S3); client reports the ETags and the API calls `CompleteMultipartUpload`, then enqueues processing.
- **Pros:** Bytes never touch the API; native S3/MinIO (no extra service); resumable — un-uploaded parts can be re-requested/retried (`ListParts`); parts can upload in parallel; identical code against AWS S3 in production.
- **Cons:** Client-side coordination (part splitting, ETag collection) — more elaborate contract; presigned-URL clock/host details need care with MinIO (service-name host inside Docker vs localhost outside).

### Option B: tus resumable-upload protocol (dedicated upload server)
- Run a tus server (`@tus/server` with `@tus/s3-store`) as an upload front; clients speak the standardized tus protocol (offset-based resume), and the store writes to S3/MinIO via multipart under the hood.
- **Pros:** Best-in-class resumability as an open protocol; mature client libraries (Uppy) for the future frontend.
- **Cons:** A whole new server component to deploy, secure (auth integration with the JWT guard is non-trivial), and test; hides the S3 contract behind a third abstraction; heavier than the phase needs for a single upload flow.

### Option C: Single presigned PUT URL
- API pre-registers the draft and returns one presigned `PutObject` URL; client uploads the file in one request.
- **Pros:** Simplest possible contract; zero streaming through the API.
- **Cons:** **Invalid for the phase's headline requirement — presigned PUT caps at 5GB**, so 10GB files cannot be uploaded; no resume (a failure at 9GB restarts from zero). Included only to document why it is rejected.

**Recommendation:** **A (presigned multipart)** — the only option that satisfies 10GB + no-bytes-through-API + resumability using nothing but the storage already in the stack. tus adds a new trust boundary and infrastructure for resumability that multipart already provides at the granularity the phase needs.

**Decision:** A (API-orchestrated presigned multipart)

---

## TD-03: Worker Topology (how the video worker runs)

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail

**Context:** The architecture diagram defines the Video Worker as its own container consuming the queue, updating DB and storage. The decision is where its code lives and how it boots — it must not compete for CPU with the API during heavy FFmpeg work, and it needs the video entity/repository and storage service.

**Options:**

### Option A: NestJS standalone application in the same codebase, separate container
- A second entrypoint (e.g., `src/worker.ts`) boots a NestJS application context without HTTP, registering only the queue consumer + TypeORM + storage modules. Compose runs a `video-worker` service from the same image with a different command; FFmpeg installed in the image.
- **Pros:** Full reuse of entities, config namespaces, and the storage service (no duplication); independent scaling/isolation from the API (processing never blocks HTTP); one codebase to test with the existing Jest setup; NestJS DI works identically.
- **Cons:** API and worker share one deployable image (a worker-only dependency update redeploys both).

### Option B: Processor registered inside the API process
- The queue consumer runs in the same Nest process that serves HTTP (`@Processor` in the API app).
- **Pros:** Zero new entrypoint or container; simplest wiring.
- **Cons:** FFmpeg saturates CPU/IO of the API container — directly violates "sem impactar a performance do sistema" and the architecture diagram's separate Video Worker container; cannot scale processing independently.

### Option C: Independent worker project (separate package/repo dir)
- A minimal standalone Node/NestJS project just for the worker, with its own package.json.
- **Pros:** Hard isolation; smallest possible worker image.
- **Cons:** Duplicates entities, DB config, and storage client (or forces extracting a shared package — monorepo tooling the repo doesn't have); doubles test/CI setup; violates "continuidade, não retrabalho".

**Recommendation:** **A (standalone Nest app, same codebase, separate Compose service)** — matches the C4 diagram's separate Video Worker container while reusing every existing convention (config namespaces, TypeORM, testing), at the cost of a shared image that is irrelevant at this scale.

**Decision:** A (standalone Nest app, same codebase, separate container)

---

## TD-04: Metadata Extraction and Thumbnail Tooling (FFmpeg interface)

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must read duration/metadata and capture a frame as thumbnail. The classic Node wrapper `fluent-ffmpeg` was **deprecated and archived (May 2025)** — "no longer maintained and no longer works properly with recent ffmpeg versions" — so the real choice is how to invoke the ffmpeg/ffprobe binaries safely from Node.

**Options:**

### Option A: Direct invocation of ffprobe/ffmpeg via `child_process.execFile`, binaries installed in the container image
- The worker image installs `ffmpeg` (apt) — providing both `ffmpeg` and `ffprobe`. A thin internal service runs `ffprobe -print_format json -show_format -show_streams` for metadata and `ffmpeg -ss <t> -i <file> -frames:v 1` for the thumbnail, parsing JSON output. `execFile` (not `exec`) avoids shell injection.
- **Pros:** Zero abandoned dependencies; full control over flags; JSON output of ffprobe is a stable machine interface; container-first (matches the project's Docker discipline); trivially testable against real files in integration tests.
- **Cons:** ~15-30 lines of spawn/parse plumbing to own; flags live in our code rather than behind a typed API.

### Option B: `fluent-ffmpeg` wrapper
- The historically popular fluent API over ffmpeg.
- **Pros:** Familiar, expressive API; lots of examples.
- **Cons:** **Archived/unmaintained (2025)** and declared incompatible with recent ffmpeg versions — adopting it in a greenfield 2026 project is indefensible; still requires the binaries anyway.

### Option C: Static binary packages (`ffmpeg-static`, `@ffprobe-installer/ffprobe`) + direct spawn
- Same direct-spawn approach as A, but binaries come from npm packages instead of the image's package manager.
- **Pros:** No image customization; version pinned via package.json.
- **Cons:** Downloads large platform-specific binaries through npm (slow, brittle in CI); binary provenance/updates worse than distro packages; redundant when we already control the Dockerfile.

**Recommendation:** **A (direct `execFile` + ffmpeg installed in the image)** — the wrapper everyone would reach for is dead, the plumbing is small, and installing ffmpeg in the worker image is the natural move in a project where everything already runs in containers.

**Decision:** A (direct execFile + ffmpeg in the image)

**Revisions:**
- 2026-09-12 — Persisted metadata contract fixed (resolves plan-validate AMB-1): explicit typed columns `durationSeconds`, `width`, `height`, `videoCodec`, `sizeBytes`, all extracted by `ffprobe` in the worker; no free-form JSONB blob. Rationale: a fixed, typed column set is queryable/indexable (e.g., filtering by resolution in later phases) and gives `/plan-build` a closed persistence contract for the Data Model.

---

## TD-05: Unique Video URL Identifier Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, non-guessable public identifier for its URL (the project plan's "Pontos de Atenção" asks for "URL curta e única que nunca conflite"). The videos table already has a UUID primary key; the question is what the public URL identifier is. Note: the project compiles to CommonJS — `nanoid` v5+ is ESM-only, which matters for option A.

**Options:**

### Option A: `nanoid` with custom base62 alphabet (~11 chars)
- Generate a YouTube-style short id with a custom alphabet; store in a `url_id` column with a unique index.
- **Pros:** Battle-tested randomness/uniformity; tiny footprint; collision probability negligible (62^11).
- **Cons:** v5+ is ESM-only — in this CommonJS NestJS build it needs `nanoid@3` (older major) or dynamic-import workarounds; an external dependency for ~10 lines of logic.

### Option B: Crypto-based base62 generator implemented in-project (~11 chars)
- A small util using `node:crypto` (`randomBytes` + rejection sampling over a 62-char alphabet), same storage: `url_id` column, unique index, insert-retry on collision (pattern already proven in `channels/nickname.util.ts`).
- **Pros:** Zero dependencies and zero ESM/CJS friction; same statistical guarantees (uniform CSPRNG); mirrors an existing project pattern including the collision-retry idiom; trivially unit-testable.
- **Cons:** ~15 lines of code to own and get right (rejection sampling for uniformity).

### Option C: Expose the UUID primary key in the URL
- Use the existing `id` as the public URL identifier.
- **Pros:** Nothing new — uniqueness guaranteed by the PK.
- **Cons:** 36-char URLs fail the "URL curta" attention point; couples public contract to the internal PK; ugly for a video-platform UX.

**Recommendation:** **B (in-project crypto base62 util)** — equivalent guarantees to nanoid without inheriting its ESM-only packaging problem in a CommonJS build, reusing the collision-retry pattern the codebase already established for nicknames.

**Decision:** B (in-project crypto base62 util)

---

## TD-06: Streaming and Download Delivery Strategy

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file — in practice HTTP Range requests / `206 Partial Content`, which `<video>` players use natively. Download must deliver the file as an attachment. The question is who serves the bytes: the storage or the API. This is the contract the future frontend player will consume (Cross-layer).

**Options:**

### Option A: Presigned GET URLs served by the storage (API issues, MinIO/S3 streams)
- Playback endpoint resolves the video by `url_id` and returns (302 redirect or JSON payload) a short-lived presigned GET URL; MinIO/S3 natively honors `Range` headers → `206`. Download uses the same mechanism with `response-content-disposition=attachment` baked into the signed URL.
- **Pros:** Bytes bypass the API entirely (same principle as the upload decision — the API stays light); Range/206 comes free from the storage; attachment disposition is a signed query param, no extra code path; scales to CDN later.
- **Cons:** URLs expire (player may need to re-request on very long sessions); MinIO endpoint must be reachable by the browser (host-mapped port in dev — presign must use the public endpoint).

### Option B: API streams the object with Range handling (proxy)
- `GET /videos/:urlId/stream` reads the `Range` header, requests the byte range from S3 (`GetObject` with `Range`), and pipes it back with `206`/`Content-Range`.
- **Pros:** Single origin (no exposed storage endpoint, no URL expiry); full control over authorization per byte-range request.
- **Cons:** Every watched byte flows through Node — the same anti-pattern the upload decision exists to avoid; makes the API the bandwidth bottleneck for the platform's core activity; more code (range parsing) to get right.

### Option C: HLS transcoding (segmented adaptive streaming)
- Worker transcodes to HLS renditions; player fetches playlists/segments.
- **Pros:** Industry-grade adaptive streaming; segment caching.
- **Cons:** Massive scope expansion (transcoding pipeline, renditions, storage multiplication) for a phase whose deliverable is "streaming funcionando" via progressive playback; the plan's own player phase (Fase 05) assumes a simple `<video>` player.

**Recommendation:** **A (presigned GET, storage serves the bytes)** — consistent with the upload principle (API orchestrates, storage moves bytes), gets Range/206 and attachment download from S3 semantics for free, and keeps HLS as a clean future evolution rather than a phase-03 obligation.

**Decision:** A (presigned GET, storage serves bytes)

**Revisions:**
- 2026-09-12 — Phase 03 access rule fixed (resolves plan-validate AMB-2): streaming and download endpoints are **owner-only** — JWT-guarded, the authenticated user must own the video; no `@Public()` opt-out in this phase. Public/unlisted access starts when Fase 04 introduces visibility and publication. Rationale: no video is exposed before the concept of 'published' exists; the Authorization Matrix of the plan is owner-only for every video endpoint.

---

## TD-07: Video Status Lifecycle and Processing-Failure Policy

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The plan fixes the conceptual cycle "rascunho → processando → pronto/erro" and requires the status to be reflected in the database. Open points: how upload completion fits the cycle, what triggers each transition, and what happens when processing fails (retries? terminal error? partial results?).

**Options:**

### Option A: Four states with queue-driven retries — `draft → processing → ready | error`
- `draft` at pre-registration (upload start); on upload completion the API enqueues the job and moves the video to `processing`; the worker sets `ready` on success. On failure the queue retries with exponential backoff (e.g., 3 attempts); only after the final attempt does the worker set `error` (with a `processing_error` detail column). Re-processing an `error` video is a manual/future concern.
- **Pros:** Matches the plan's cycle literally; retry policy lives in the queue (TD-01's native semantics), not in domain code; transient failures (storage hiccup) self-heal invisibly; terminal state is unambiguous for the future UI.
- **Cons:** During retries the video sits in `processing` with no user-visible progress detail.

### Option B: Extended states exposing upload progress — `draft → uploading → uploaded → processing → ready | error`
- Adds explicit states for the multipart window and the enqueue gap.
- **Pros:** Finer-grained observability; the future UI could show "uploading" vs "processing" from the DB alone.
- **Cons:** More transitions to guard and test; `uploading`/`uploaded` duplicate information the multipart session already carries; the plan only mandates the four conceptual states — extra states are speculative for a backend-only phase.

### Option C: No retries — first failure is terminal `error`
- Any processing exception immediately marks the video `error`.
- **Pros:** Simplest worker logic; failures surface fast.
- **Cons:** Transient infrastructure errors (storage timeout) permanently fail videos that a retry would have saved; wastes the retry machinery every queue option provides natively.

**Recommendation:** **A (four states + queue-native retries with backoff, terminal `error` with recorded cause)** — implements the plan's cycle exactly, delegates failure handling to the queue's proven retry mechanics, and keeps state-machine surface minimal for the phase.

**Decision:** A (draft → processing → ready/error + queue retries)

---

## TD-08: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The backend needs an S3-compatible client for MinIO (dev) and S3 (prod): multipart lifecycle, presigned PUT-part/GET URLs, object existence checks. The choice constrains TD-02 and TD-06 mechanics.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Official modular AWS SDK; MinIO compatibility via `endpoint` + `forcePathStyle: true`. Presigning any command (including `UploadPartCommand` and `GetObjectCommand` with `ResponseContentDisposition`) through `getSignedUrl`.
- **Pros:** Production-parity — the same client talks to real S3 with only env changes (the architecture's stated goal); first-class presigned multipart support; TypeScript-native; per-command tree-shakeable packages.
- **Cons:** Verbose command-object API; large dependency graph (mitigated by modular packages).

### Option B: MinIO JavaScript SDK (`minio`)
- MinIO's own client, S3-compatible API surface.
- **Pros:** Simpler method-based API; made by the storage vendor we run in dev.
- **Cons:** Inverts the compatibility direction — the project targets S3 with MinIO as a stand-in, and the MinIO SDK's presigned multipart ergonomics (per-part presigning) are weaker/less documented than AWS SDK's; less standard in NestJS ecosystem examples.

**Recommendation:** **A (AWS SDK v3)** — the architecture explicitly frames MinIO as "same API as S3, swapped in production"; coding against the official S3 SDK keeps that swap to configuration only, and its presigner covers every URL TD-02/TD-06 need.

**Decision:** A (AWS SDK v3)

---

## TD-09: Bucket and Object-Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos and thumbnails must live in object storage with keys that the API (presigning), the worker (read source / write thumbnail), and tests all agree on — a cross-file contract. Also covers how the bucket comes to exist in dev (fresh `docker compose up` must work).

**Options:**

### Option A: Single bucket, per-video key prefix — `videos/{videoId}/source.{ext}` and `videos/{videoId}/thumbnail.jpg`
- One bucket (e.g., `streamtube-media`), all of a video's artifacts under its id prefix. Bucket ensured idempotently at application/worker bootstrap (`CreateBucket` if missing).
- **Pros:** One bucket to configure/ensure; a video's artifacts are colocated (trivial cleanup by prefix); key layout derivable from the entity alone; bootstrap-ensured bucket keeps `docker compose up` self-sufficient.
- **Cons:** Mixed content types in one bucket (irrelevant until per-type policies like public thumbnails appear).

### Option B: Two buckets — `videos` and `thumbnails`
- Artifacts split by type, same key `{videoId}.{ext}` in each.
- **Pros:** Per-type bucket policies (e.g., public-read thumbnails later) without key filtering.
- **Cons:** Two buckets to create/configure/point env vars at; a video's artifacts scatter; speculative benefit — no phase requirement distinguishes their access policies.

**Recommendation:** **A (single bucket, per-video prefix)** — the phase has one access pattern (presigned, private); colocated artifacts and single-bucket bootstrap are concretely simpler, and a future split remains possible behind the storage service abstraction.

**Decision:** A (single bucket, per-video prefix)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Processing Queue Technology | A (BullMQ + Redis) | **A** |
| TD-02 | Cross-layer | 10GB Upload Strategy | A (API-orchestrated presigned multipart) | **A** |
| TD-03 | Backend | Worker Topology | A (standalone Nest app, same codebase, separate container) | **A** |
| TD-04 | Backend | Metadata/Thumbnail Tooling | A (direct execFile + ffmpeg in the image) | **A** |
| TD-05 | Backend | Unique Video URL Identifier | B (in-project crypto base62 util) | **B** |
| TD-06 | Cross-layer | Streaming and Download Delivery | A (presigned GET, storage serves bytes) | **A** |
| TD-07 | Backend | Status Lifecycle & Failure Policy | A (draft → processing → ready/error + queue retries) | **A** |
| TD-08 | Backend | S3 Client Library | A (AWS SDK v3) | **A** |
| TD-09 | Backend | Bucket and Object-Key Organization | A (single bucket, per-video prefix) | **A** |
