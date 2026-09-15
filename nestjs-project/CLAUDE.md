# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — Video Worker (same image and code as the API, `npm run start:worker:dev`), consumes the BullMQ queue `video-processing`; no HTTP port
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `minio` — S3-compatible object storage, API port `9000`, console `9001`
- `redis` — Redis 7, port `6379` (BullMQ broker)

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs video-worker   # queue consumer: "consuming queue \"video-processing\"" on boot, one line per processed video
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run start:worker:dev                 # Video Worker with hot-reload (what the video-worker service runs)
npm run start:worker                     # Run the compiled worker (dist/worker.js)
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos Module (Phase 03)

Upload, processing and delivery of videos. The bytes never pass through the API: the client uploads parts straight to the object storage through presigned URLs, and a separate worker process does the FFmpeg work.

### Source layout

- `src/videos/` — `VideosController` (routes below), `VideosService` (upload lifecycle + read/delivery rules, `findOwnedOrThrow` ownership check via `channel.user_id`), entities `Video` (`videos`) and `VideoUpload` (`video_uploads`), DTOs (`dto/`), domain exceptions (`exceptions/video.exceptions.ts`), `url-id.util.ts` (11-char base62 public id, collision retry)
- `src/storage/` — `StorageModule` / `StorageService`: sole owner of the AWS SDK v3 S3 client (MinIO locally, `forcePathStyle`). Bucket is ensured on boot; keys are `videos/{id}/source.{ext}` and `videos/{id}/thumbnail.jpg`. Two clients: internal endpoint (`STORAGE_ENDPOINT`, API/worker → MinIO) and public endpoint (`STORAGE_PUBLIC_ENDPOINT`, URLs handed to browsers)
- `src/video-processing/` — `VideoProcessingQueueModule` (BullMQ queue `video-processing`), `VideoProcessingProducer.enqueue(videoId)` (job `process-video`, `jobId = videoId`, 3 attempts, exponential backoff 5 s), `VideoProcessor` (the consumer), `ffmpeg/` (`FfmpegService`: `probe` via `ffprobe`, `captureFrame` via `ffmpeg`, binaries from the image)
- `src/worker/worker.module.ts` + `src/worker.ts` — the Video Worker: a Nest application context (no HTTP) importing config, TypeORM, queue, storage and ffmpeg; built to `dist/worker.js` by `nest build`
- `src/database/migrations/1789510612605-CreateVideos.ts` — tables `videos`, `video_uploads`, enum `video_status`
- `src/test/fixtures/make-test-video.ts` — renders a synthetic H.264 MP4 with the image's ffmpeg for integration tests

### Endpoints (all require a JWT; `:urlId` routes are owner-only → `404 VIDEO_NOT_FOUND` for anyone else)

| Method | Path | Purpose |
|---|---|---|
| POST | `/videos` | Create the draft video and open the multipart upload (`{ fileName, mimeType, fileSize }` → `{ urlId, status, upload: { partSize, partCount, uploadExpiresAt } }`) |
| POST | `/videos/:urlId/upload/parts` | Presigned PUT URLs for a batch of part numbers (also the resume path) |
| GET | `/videos/:urlId/upload` | Upload status: parts the storage already holds |
| POST | `/videos/:urlId/upload/complete` | Finalize the multipart upload, verify real size, move to `processing`, enqueue the job |
| DELETE | `/videos/:urlId/upload` | Abort the session and discard the draft (204) |
| GET | `/videos/:urlId` | Video registry entry: status, metadata, presigned `thumbnailUrl` when ready, `processingError` when failed |
| GET | `/videos/:urlId/stream` | Presigned GET (`MEDIA_STREAM_URL_TTL_SECONDS`); the storage serves Range/206 |
| GET | `/videos/:urlId/download` | Presigned GET with `attachment; filename="<original name>"` (`MEDIA_DOWNLOAD_URL_TTL_SECONDS`) |

Error codes (`DomainExceptionFilter` envelope `{ statusCode, error, message }`): `VIDEO_NOT_FOUND` 404, `FILE_TOO_LARGE` 413, `UNSUPPORTED_VIDEO_FORMAT` 415, `INVALID_PART_NUMBERS` 400, `INVALID_PARTS` 400, `UPLOAD_NOT_ACTIVE` 409, `UPLOAD_EXPIRED` 410, `VIDEO_NOT_READY` 409, `STORAGE_ERROR` 502. The full contract is in `openapi.json` (regenerate with `npm run openapi:export` after touching controllers/DTOs).

### Status cycle and the worker

`draft` (created at `POST /videos`) → `processing` (upload completed and verified) → `ready` | `error`. Only the worker writes `ready`; the API writes `error` itself when the session expires (`UPLOAD_EXPIRED`, 24 h) or the real size exceeds the declared one (`FILE_TOO_LARGE`). The worker (`VideoProcessor`) re-reads the row, skips anything not in `processing` (idempotent), `HeadObject`s the source, probes it through a presigned URL (`ffprobe` reads only headers), captures one JPEG frame at 10% of the duration, uploads the thumbnail and persists `durationSeconds`, `width`, `height`, `videoCodec`, `sizeBytes`, `thumbnail_key`, `processed_at`. After the last failed attempt it records `status = error` and `processing_error` ∈ `SOURCE_NOT_FOUND | FFPROBE_FAILED | UNREADABLE_MEDIA | THUMBNAIL_FAILED | UNKNOWN`.

### Environment variables (see `.env.example`)

- Storage: `STORAGE_ENDPOINT` (`http://minio:9000`), `STORAGE_PUBLIC_ENDPOINT` (`http://localhost:9000` for browsers on the host), `STORAGE_REGION`, `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` (must match the MinIO root credentials in `compose.yaml`), `STORAGE_BUCKET`, `STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS`
- Queue: `REDIS_HOST` (`redis`), `REDIS_PORT`, `VIDEO_PROCESSING_ATTEMPTS`, `VIDEO_PROCESSING_BACKOFF_MS`
- Upload policy: `UPLOAD_MAX_FILE_SIZE_BYTES` (10 GiB), `UPLOAD_PART_SIZE_BYTES` (64 MiB; S3 bounds 5 MiB..5 GiB), `UPLOAD_PART_URL_TTL_SECONDS`, `UPLOAD_SESSION_TTL_HOURS`, `UPLOAD_ALLOWED_EXTENSIONS`
- Delivery TTLs: `MEDIA_STREAM_URL_TTL_SECONDS`, `MEDIA_DOWNLOAD_URL_TTL_SECONDS`

### Testing notes specific to this module

- Integration and e2e suites talk to the real Compose `minio` and `redis`; nothing is mocked except the queue producer in `VideosService` integration tests. Tests running inside the container set `STORAGE_PUBLIC_ENDPOINT=http://minio:9000` (inside a container `localhost` is the container itself) and `STORAGE_BUCKET=streamtube-media-test`.
- The dev `video-worker` consumes the same Redis queue the suites enqueue into. Stop it before running the suites (`docker compose stop video-worker`) and start it again afterwards.
- MinIO community edition rejects the `AbortIncompleteMultipartUpload` lifecycle rule; `StorageService.ensureBucket` logs a WARN and continues (`lifecycleRuleApplied = false`). On real S3 the rule is applied.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
