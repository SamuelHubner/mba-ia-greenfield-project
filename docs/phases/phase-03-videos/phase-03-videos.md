---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-12 10:52:07.153375854"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-12 10:52:07.126010737"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-12 10:47:38.764724029"
  docs/decisions/technical-decisions-upload-policy.md: "2026-09-12 10:47:38.764349494"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-31 18:45:05.152857678"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver, in `nestjs-project/`, upload de até 10GB funcional without the bytes flowing through the API (API-orchestrated presigned multipart to S3/MinIO, with pré-cadastro automático do vídeo como rascunho ao iniciar o upload), processamento automático do vídeo in a separate FFmpeg worker fed by a BullMQ queue (extração de duração e metadados + geração automática de thumbnail), URL única por vídeo, and streaming funcionando plus download do vídeo through presigned GET URLs — owner-only in this phase.

---

## Step Implementations

### SI-03.1 — Infra: provisionar MinIO, Redis, ffmpeg e dependências

**Description:** Coloca no Compose e na imagem tudo que a fase consome como infraestrutura — object storage S3-compatível, broker da fila, binários ffmpeg/ffprobe e os pacotes npm — para que os SIs seguintes só escrevam código.

**Technical actions:**

1. Adicionar serviço `minio` em `nestjs-project/compose.yaml` — imagem `minio/minio` com `server /data --console-address ":9001"`, portas `9000:9000` (API S3) e `9001:9001` (console), volume nomeado `minio-data`, credenciais via `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, healthcheck `mc ready local` ou `curl -f http://localhost:9000/minio/health/live`; `nestjs-api` passa a depender dele com `condition: service_healthy` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`)
2. Adicionar serviço `redis` em `compose.yaml` — imagem `redis:7-alpine`, porta `6379:6379`, healthcheck `redis-cli ping`; `nestjs-api` depende dele com `condition: service_healthy` (per `phase-03-videos/TD-01`)
3. Instalar `ffmpeg` (que inclui `ffprobe`) em `nestjs-project/Dockerfile.dev` via `apt install -y ffmpeg` no mesmo `RUN` existente — a imagem é compartilhada por API e worker (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
4. Instalar dependências dentro do container (`docker compose exec nestjs-api npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @nestjs/bullmq bullmq`) fixando `@aws-sdk/*` no mesmo minor (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`; versões em `library-refs.md`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `minio` e `redis` com status `healthy` em `docker compose ps`
- `curl -f http://localhost:9000/minio/health/live` responde `200` a partir do host
- `docker compose exec redis redis-cli ping` responde `PONG`
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` retornam exit code `0`
- `nestjs-project/package.json` lista `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@nestjs/bullmq` e `bullmq` em `dependencies`

---

### SI-03.2 — Configurar storage, fila e política de upload

**Description:** Materializa o contrato de variáveis de ambiente da fase nas factories `registerAs` + Joi herdadas da Fase 01, para que storage, fila, upload e worker leiam valores tipados e validados no boot.

**Technical actions:**

1. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` com `endpoint` (`STORAGE_ENDPOINT`, default `http://minio:9000`), `publicEndpoint` (`STORAGE_PUBLIC_ENDPOINT`, default `http://localhost:9000` — usado só para presign consumido pelo navegador), `region` (`STORAGE_REGION`, default `us-east-1`), `accessKeyId`/`secretAccessKey` (`STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`), `bucket` (`STORAGE_BUCKET`, default `streamtube-media`), `forcePathStyle: true`, `abortIncompleteUploadDays` (`STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS`, default `1`) (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`, `upload-policy/TD-05`)
2. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` com `redisHost` (`REDIS_HOST`, default `redis`), `redisPort` (`REDIS_PORT`, default `6379`), `processingAttempts` (`VIDEO_PROCESSING_ATTEMPTS`, default `3`), `processingBackoffMs` (`VIDEO_PROCESSING_BACKOFF_MS`, default `5000`) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`)
3. Criar `src/config/upload.config.ts` — `registerAs('upload', ...)` com `maxFileSizeBytes` (`UPLOAD_MAX_FILE_SIZE_BYTES`, default `10737418240`), `partSizeBytes` (`UPLOAD_PART_SIZE_BYTES`, default `67108864`), `partUrlTtlSeconds` (`UPLOAD_PART_URL_TTL_SECONDS`, default `3600`), `sessionTtlHours` (`UPLOAD_SESSION_TTL_HOURS`, default `24`), `allowedExtensions` (`UPLOAD_ALLOWED_EXTENSIONS`, default `mp4,webm,mov,mkv,avi`, parseado para array lower-case), `streamUrlTtlSeconds` (`MEDIA_STREAM_URL_TTL_SECONDS`, default `21600`), `downloadUrlTtlSeconds` (`MEDIA_DOWNLOAD_URL_TTL_SECONDS`, default `3600`) (per `upload-policy/TD-01`, `TD-02`, `TD-03`, `TD-04`, `TD-05`, `TD-06`)
4. Estender `src/config/env.validation.ts` com as chaves acima e os limites do `### API Contracts → Validation Rules`: `UPLOAD_PART_SIZE_BYTES` entre `5242880` e `5368709120`; `UPLOAD_MAX_FILE_SIZE_BYTES` ≤ `5497558138880`; todo `*_TTL_SECONDS` ≤ `604800`; `STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS * 24 >= UPLOAD_SESSION_TTL_HOURS` via `Joi.object().custom(...)`; `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` obrigatórios (per `upload-policy/TD-02`, `TD-05`; convenção Joi de `phase-01-configuracao-base/TD-02`)
5. Registrar as três factories em `ConfigModule.forRoot({ load: [...] })` de `src/app.module.ts`, adicionar as chaves em `nestjs-project/.env.example` (valores shell-safe, sem espaços) e em `environment` do `nestjs-api` no `compose.yaml` (`STORAGE_ENDPOINT=http://minio:9000`, `REDIS_HOST=redis`, nunca `localhost` — nomes de serviço Compose)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: defaults aplicados, limites rejeitam `UPLOAD_PART_SIZE_BYTES=1048576`, regra cruzada `abortDays*24 >= sessionTtlHours` | `src/config/env.validation.integration-spec.ts` (estender) |
| `uploadConfig` | Unit: parse de `UPLOAD_ALLOWED_EXTENSIONS` (trim, lower-case, remove vazios) e defaults numéricos | `src/config/upload.config.spec.ts` |
| `storageConfig` / `queueConfig` | Unit: defaults e coerção numérica de porta/dias | `src/config/storage.config.spec.ts`, `src/config/queue.config.spec.ts` |

**Dependencies:** SI-03.1 — as variáveis apontam para os serviços `minio` e `redis` criados lá

**Acceptance criteria:**

- Boot da aplicação com `.env` sem `STORAGE_ACCESS_KEY` falha na validação Joi citando a chave ausente
- Boot com `UPLOAD_PART_SIZE_BYTES=1048576` (1 MiB) falha na validação Joi por violar o mínimo de 5 MiB
- Boot com `UPLOAD_SESSION_TTL_HOURS=48` e `STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS=1` falha na validação Joi pela regra cruzada
- Boot com `.env.example` copiado para `.env` sobe sem erro de validação e `ConfigService.get('upload.partSizeBytes')` retorna `67108864`
- `ConfigService.get('upload.allowedExtensions')` retorna `['mp4','webm','mov','mkv','avi']` a partir do default em string

---

### SI-03.3 — Implementar StorageModule (S3 client, bucket e operações multipart/presign)

**Description:** Encapsula todo o acesso ao object storage num módulo único — cliente AWS SDK v3 apontado para o MinIO, bucket garantido com regra de lifecycle no boot, e as operações de multipart e presign que upload, leitura e worker consomem — para que nenhum outro módulo toque o SDK diretamente.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` com dois providers de `S3Client` a partir de `storageConfig` (`ConfigType` + `@Inject(storageConfig.KEY)`): `S3_CLIENT` (`endpoint`, `region`, `forcePathStyle: true`, `credentials`) para chamadas internas e `S3_PUBLIC_CLIENT` (mesma config com `publicEndpoint`) exclusivo para presign consumido pelo navegador; exportar `StorageService` (per `phase-03-videos/TD-08`; `library-refs.md → @aws-sdk/client-s3`)
2. Criar `src/storage/storage.service.ts` com `ensureBucket()` em `onModuleInit`: `HeadBucketCommand` → em `NotFound` executa `CreateBucketCommand`; em seguida `PutBucketLifecycleConfigurationCommand` idempotente com a regra `abort-incomplete-multipart` (`Filter.Prefix: 'videos/'`, `AbortIncompleteMultipartUpload.DaysAfterInitiation = storage.abortIncompleteUploadDays`, `Status: 'Enabled'`) (per `phase-03-videos/TD-09`, `upload-policy/TD-05`)
3. Implementar no `StorageService` as operações de upload: `createMultipartUpload(key, contentType) → uploadId`, `presignUploadPart(key, uploadId, partNumber, ttlSeconds) → { url, expiresAt }` via `getSignedUrl(S3_PUBLIC_CLIENT, new UploadPartCommand(...), { expiresIn })`, `listParts(key, uploadId) → { partNumber, etag, size }[]` (paginando `NextPartNumberMarker`), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `headObject(key) → { contentLength, contentType }` (per `phase-03-videos/TD-02`, `upload-policy/TD-01`, `TD-03`; `library-refs.md → @aws-sdk/s3-request-presigner`)
4. Implementar as operações de entrega e escrita: `presignGetObject(key, ttlSeconds, { attachmentFileName? })` com `ResponseContentDisposition: attachment; filename="..."` quando informado (via `S3_PUBLIC_CLIENT`), `presignInternalGetObject(key, ttlSeconds)` (via `S3_CLIENT`, para o worker), `putObject(key, body, contentType)`, `deleteObject(key)` (per `phase-03-videos/TD-06`, `upload-policy/TD-04`)
5. Criar `src/storage/exceptions/storage.exception.ts` — `StorageException extends DomainException` com `errorCode 'STORAGE_ERROR'`, `httpStatus 502`; o `StorageService` converte falhas do SDK (`S3ServiceException`, timeouts, `ECONNREFUSED`) nessa exceção, exceto `NoSuchUpload`/`InvalidPart`/`InvalidPartOrder`/`EntityTooSmall`/`NotFound`, que são relançadas tipadas (`StoragePartError`, `StorageObjectNotFound`) para o `VideosService` mapear (per `### Error Catalog → STORAGE_ERROR`; envelope de `phase-02-auth/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test com `storageConfig` de teste — resolve `StorageService` e os dois clients | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration (MinIO real do Compose): `ensureBucket` idempotente em 2 chamadas; lifecycle rule presente via `GetBucketLifecycleConfiguration`; ciclo create → presign part → PUT com `fetch` → listParts → complete → headObject com `contentLength` correto; abort remove partes; presign GET com disposition inclui `response-content-disposition` na URL | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` (mapeamento de erros) | Unit: SDK lançando `S3ServiceException` genérica → `StorageException`; `InvalidPart` → `StoragePartError`; `NotFound` → `StorageObjectNotFound` | `src/storage/storage.service.spec.ts` |

**Dependencies:** SI-03.2 — consome `storageConfig`

**Acceptance criteria:**

- Após o boot da API com bucket inexistente, `docker compose exec minio mc ls local/streamtube-media` (ou `HeadBucket` via SDK) confirma que o bucket existe
- Após o boot, a configuração de lifecycle do bucket contém uma regra `Enabled` com `AbortIncompleteMultipartUpload.DaysAfterInitiation = 1` e prefixo `videos/`
- Um segundo boot com o bucket já existente não falha nem duplica regras de lifecycle
- Uma URL de `presignUploadPart` aceita um `PUT` do host (`http://localhost:9000/...`) e o `ETag` retornado aparece em `listParts`
- Uma URL de `presignGetObject` com `attachmentFileName` serve o objeto com header `Content-Disposition: attachment; filename="..."`
- Com o serviço `minio` parado, qualquer operação do `StorageService` resulta em `StorageException` com `errorCode STORAGE_ERROR` e `httpStatus 502`

---

### SI-03.4 — Modelar Video e VideoUpload (entidades, migration e url_id)

**Description:** Cria o registro de vídeos e da sessão de upload conforme o `### Data Model`, mais o gerador de identificador público único, deixando o `VideosModule` registrado e pronto para receber serviço e controller.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com os campos do `### Data Model → Video` (`url_id` varchar(11) unique, `channel_id` uuid + `@ManyToOne(() => Channel)`/`@JoinColumn({ name: 'channel_id' })`, enum `video_status` via `VideoStatus` (`draft|processing|ready|error`, default `draft`), `original_file_name`, `mime_type`, `source_ext`, `source_key` unique, `thumbnail_key` nullable, `declared_size_bytes` bigint, `durationSeconds`/`width`/`height`/`videoCodec`/`sizeBytes` nullable com `@Column({ name: 'duration_seconds' })` etc., `processing_error` text nullable, `processed_at` nullable, `created_at`/`updated_at`); `bigint` mapeado com `transformer` para `number` (per `phase-03-videos/TD-07`, `TD-09`; revisão de `phase-03-videos/TD-04`; `upload-policy/TD-01`)
2. Criar `src/videos/entities/video-upload.entity.ts` — `@Entity('video_uploads')` com `video_id` uuid unique + `@OneToOne(() => Video, { onDelete: 'CASCADE' })`, `storage_upload_id`, `part_size`, `part_count`, `uploadExpiresAt` (`@Column({ name: 'upload_expires_at', type: 'timestamptz' })`), `completed_at`/`aborted_at` nullable, `created_at` (per `phase-03-videos/TD-02`; `upload-policy/TD-02`, `TD-05`)
3. Gerar a migration `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` dentro do container e revisar: tipo enum `video_status`, FKs para `channels` e `videos`, índices unique em `url_id`, `source_key`, `video_id` e índices em `channel_id` e `status` (per `### Data Model → Indexes`)
4. Criar `src/videos/url-id.util.ts` — `generateUrlId(length = 11)` com `crypto.randomBytes` mapeado para o alfabeto base62 `[0-9A-Za-z]` sem viés de módulo (rejection sampling), exportando também `URL_ID_REGEX = /^[0-9A-Za-z]{11}$/` para validar path params (per `phase-03-videos/TD-05`)
5. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video, VideoUpload])` e registrar em `AppModule`; acrescentar `@OneToMany(() => Video, (video) => video.channel) videos: Video[]` em `Channel` (relação inversa, sem coluna nova) (per `### Data Model → Relations`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `status = draft`; unique em `url_id` e `source_key` viola com `QueryFailedError`; FK `channel_id` inexistente rejeitada; colunas de metadata aceitam `null`; `sizeBytes` bigint round-trip como `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideoUpload` | Integration: unique em `video_id`; cascade delete ao remover o `Video`; `uploadExpiresAt` persiste como `timestamptz` | `src/videos/entities/video-upload.entity.integration-spec.ts` |
| `generateUrlId` | Unit: comprimento 11, alfabeto base62, 10 000 gerações sem repetição, `URL_ID_REGEX` rejeita `-`/`_`/tamanho ≠ 11 | `src/videos/url-id.util.spec.ts` |
| `VideosModule` | Unit: compilation test resolve os dois repositórios | `src/videos/videos.module.spec.ts` |

**Dependencies:** none — usa apenas TypeORM e a entidade `Channel` já existentes

**Acceptance criteria:**

- `npm run migration:run` aplica a migration e cria as tabelas `videos` e `video_uploads` e o tipo `video_status`; `npm run migration:revert` remove tudo sem erro
- Inserir dois vídeos com o mesmo `url_id` falha com violação de unique constraint
- Inserir um vídeo com `channel_id` inexistente falha com violação de FK
- Remover um `Video` remove em cascata sua linha em `video_uploads`
- Um vídeo inserido sem `status` é lido com `status = 'draft'` e metadata (`durationSeconds`, `width`, `height`, `videoCodec`, `sizeBytes`) nula

---

### SI-03.5 — Implementar fila de processamento (BullMQ producer)

**Description:** Liga a API ao Redis via BullMQ e expõe um producer único que enfileira o job `process-video` conforme o `### Events/Messages`, isolando a tecnologia de fila do `VideosService`.

**Technical actions:**

1. Criar `src/video-processing/video-processing-queue.module.ts` — `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (q) => ({ connection: { host: q.redisHost, port: q.redisPort } }) })` + `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, exportando o `BullModule` registrado (per `phase-03-videos/TD-01`; convenção `forRootAsync` de `phase-01-configuracao-base/TD-01`)
2. Criar `src/video-processing/video-processing.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'` e o tipo `ProcessVideoJobData = { videoId: string }` (per `### Events/Messages → video-processing / process-video`)
3. Criar `src/video-processing/video-processing.producer.ts` — `VideoProcessingProducer.enqueue(videoId)` com `@InjectQueue(VIDEO_PROCESSING_QUEUE)`: `queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId, attempts: queue.processingAttempts, backoff: { type: 'exponential', delay: queue.processingBackoffMs }, removeOnComplete: true, removeOnFail: false })`; exportar o producer pelo módulo (per `phase-03-videos/TD-01`, `TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingQueueModule` | Unit: compilation test com `queueConfig` de teste — `BullModule.registerQueue()` resolve o token `BullQueue_video-processing` (DI wiring de import configurado) | `src/video-processing/video-processing-queue.module.spec.ts` |
| `VideoProcessingProducer` | Unit: `queue.add` mockado recebe nome `process-video`, payload `{ videoId }`, `jobId = videoId` e as opções de retry do config | `src/video-processing/video-processing.producer.spec.ts` |
| `VideoProcessingProducer` | Integration (Redis real do Compose): `enqueue` duas vezes com o mesmo `videoId` resulta em um único job na fila (`getJobCounts`) | `src/video-processing/video-processing.producer.integration-spec.ts` |

**Dependencies:** SI-03.1 — serviço `redis`; SI-03.2 — `queueConfig`

**Acceptance criteria:**

- Com o Redis do Compose ativo, `enqueue('<uuid>')` cria na fila `video-processing` um job de nome `process-video` com `data.videoId` igual ao argumento
- Duas chamadas de `enqueue` com o mesmo `videoId` deixam exatamente um job em `waiting` (deduplicação por `jobId`)
- O job criado carrega `opts.attempts = 3` e `opts.backoff = { type: 'exponential', delay: 5000 }` com o `.env.example`
- Com o serviço `redis` parado, o boot da API falha ou loga erro de conexão identificando `redis:6379` (nunca `localhost`)

---

### SI-03.6 — Implementar VideosService: ciclo de vida do upload

**Description:** Implementa a orquestração do upload multipart pré-assinado como regra de negócio pura (iniciar, emitir URLs de parte, consultar status, concluir com verificação de tamanho, abortar), com o dono resolvido via canal e a política de limites aplicada — sem HTTP, para que o controller do SI seguinte seja só fiação.

**Technical actions:**

1. Criar `src/videos/exceptions/video.exceptions.ts` — subclasses de `DomainException` para cada linha do `### Error Catalog` de domínio: `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `FileTooLargeException` (`FILE_TOO_LARGE`, 413), `UnsupportedVideoFormatException` (`UNSUPPORTED_VIDEO_FORMAT`, 415), `InvalidPartNumbersException` (`INVALID_PART_NUMBERS`, 400), `InvalidPartsException` (`INVALID_PARTS`, 400), `UploadNotActiveException` (`UPLOAD_NOT_ACTIVE`, 409), `UploadExpiredException` (`UPLOAD_EXPIRED`, 410), `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) (per `phase-02-auth/TD-07`)
2. Criar `src/videos/videos.service.ts` com `initiateUpload(userId, { fileName, mimeType, fileSize })`: resolve o `Channel` do usuário (`channelsService`/repositório por `user_id`); valida extensão ∈ `upload.allowedExtensions` e `mimeType` `video/*` (→ `UNSUPPORTED_VIDEO_FORMAT`), `fileSize ≤ upload.maxFileSizeBytes` e `partCount = ceil(fileSize / partSizeBytes) ≤ 10000` (→ `FILE_TOO_LARGE`); gera `url_id` com retry em colisão (`generateUrlId`), monta `source_key = videos/{id}/source.{ext}`, chama `storage.createMultipartUpload`, e persiste `Video` (`draft`) + `VideoUpload` (`uploadExpiresAt = now + sessionTtlHours`) na mesma transação; em falha do storage nada é persistido (per `phase-03-videos/TD-02`, `TD-05`, `TD-09`; `upload-policy/TD-01`, `TD-02`, `TD-05`, `TD-06`)
3. Implementar `findOwnedOrThrow(userId, urlId)` (join `channel` e compara `channel.user_id`; qualquer falha → `VIDEO_NOT_FOUND`, inclusive `urlId` fora de `URL_ID_REGEX`) e `assertActiveUpload(video)`: `status ≠ draft` → `UPLOAD_NOT_ACTIVE`; `uploadExpiresAt < now` → aborta no storage, marca `aborted_at`, `status = error`, `processing_error = 'UPLOAD_EXPIRED'` e lança `UPLOAD_EXPIRED` (expiração preguiçosa) (per revisão de `phase-03-videos/TD-06`; `upload-policy/TD-05`)
4. Implementar `issuePartUrls(userId, urlId, partNumbers)` (valida `1..part_count` e unicidade → `INVALID_PART_NUMBERS`; presign em paralelo com `upload.partUrlTtlSeconds`) e `getUploadStatus(userId, urlId)` (`listParts` quando ativo; lista vazia caso contrário) conforme `### API Contracts → POST /videos/:urlId/upload/parts` e `GET /videos/:urlId/upload` (per `upload-policy/TD-03`)
5. Implementar `completeUpload(userId, urlId, parts)` — valida lista (tamanho = `part_count`, ascendente, única → `INVALID_PARTS`), chama `completeMultipartUpload` (erros `StoragePartError` → `INVALID_PARTS`), verifica `headObject().contentLength` ≤ `declared_size_bytes` e ≤ cap (violação → `deleteObject`, `status = error`, `processing_error = 'FILE_TOO_LARGE'`, lança `FILE_TOO_LARGE`), grava `sizeBytes`, `completed_at`, `status = processing` e chama `videoProcessingProducer.enqueue(video.id)`; e `abortUpload(userId, urlId)` — `abortMultipartUpload` + remoção de `Video`/`VideoUpload` (per `upload-policy/TD-01`; `phase-03-videos/TD-01`, `TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit (repos, `StorageService`, producer e clock mockados): formato não permitido → `UNSUPPORTED_VIDEO_FORMAT`; `fileSize` acima do cap → `FILE_TOO_LARGE`; `partCount` calculado = `ceil`; colisão de `url_id` faz retry; `urlId` de outro usuário → `VIDEO_NOT_FOUND`; sessão expirada → abort + `UPLOAD_EXPIRED`; `partNumbers` fora do range → `INVALID_PART_NUMBERS`; `parts` incompleta → `INVALID_PARTS`; `contentLength` > declarado → delete + `FILE_TOO_LARGE`; sucesso → `status processing` + `enqueue(video.id)` | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration (DB + MinIO reais; producer mockado): `initiateUpload` persiste `Video` draft + `VideoUpload` e abre um multipart real; falha simulada do storage não deixa linhas; `completeUpload` após PUT real das partes grava `sizeBytes` e `completed_at`; `abortUpload` remove linhas e o multipart (`listParts` falha com `NoSuchUpload`) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3 — `StorageService`; SI-03.4 — entidades e `generateUrlId`; SI-03.5 — `VideoProcessingProducer`

**Acceptance criteria:**

- `initiateUpload` com `fileName "a.exe"` ou `mimeType "image/png"` não cria nenhuma linha e resulta em `errorCode UNSUPPORTED_VIDEO_FORMAT`
- `initiateUpload` com `fileSize = 10737418241` não cria nenhuma linha e resulta em `errorCode FILE_TOO_LARGE`
- `initiateUpload` válido de 200 MiB deixa um `Video` `draft` com `url_id` de 11 chars base62 e um `VideoUpload` com `part_count = 4` e `uploadExpiresAt` 24 h à frente
- Consultar ou completar um upload cujo `uploadExpiresAt` já passou resulta em `errorCode UPLOAD_EXPIRED` e deixa o vídeo em `status error` com `processing_error UPLOAD_EXPIRED`
- Completar com lista de partes válida deixa o vídeo em `status processing`, `sizeBytes` igual ao tamanho real do objeto, e um job `process-video` com `jobId = video.id` na fila
- Completar quando o objeto real excede `declared_size_bytes` apaga o objeto, deixa o vídeo em `status error` com causa `FILE_TOO_LARGE` e nenhum job é enfileirado
- Qualquer operação sobre um `urlId` pertencente ao canal de outro usuário resulta em `errorCode VIDEO_NOT_FOUND`

---

### SI-03.7 — Expor endpoints de upload (POST /videos e sub-recurso /upload)

**Route:** POST /videos · POST /videos/:urlId/upload/parts · GET /videos/:urlId/upload · POST /videos/:urlId/upload/complete · DELETE /videos/:urlId/upload
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (JWT global); operações sobre `:urlId` são owner-only (não-dono → `404 VIDEO_NOT_FOUND`)

**Description:** Fia o `VideosService` ao HTTP com DTOs `class-validator`, rotas REST conforme o `### API Contracts` e documentação Swagger, deixando o contrato de upload consumível pelo futuro frontend e registrado no `openapi.json`.

**Technical actions:**

1. Criar os DTOs em `src/videos/dto/`: `CreateVideoDto` (`fileName` `@IsString @Length(1,255) @Matches(/\.[A-Za-z0-9]+$/)`, `mimeType` `@Matches(/^video\/[a-z0-9.+-]+$/)`, `fileSize` `@IsInt @Min(1)`), `RequestPartUrlsDto` (`partNumbers` `@IsArray @ArrayMinSize(1) @ArrayMaxSize(100) @IsInt({ each: true }) @Min(1, { each: true })`), `CompleteUploadDto` (`parts` array de `CompletedPartDto { partNumber: @IsInt @Min(1); etag: @IsString @IsNotEmpty }` com `@ValidateNested({ each: true }) @Type(() => CompletedPartDto)`) — regras do `### API Contracts → Validation Rules` (per `phase-02-auth/TD-06`; `upload-policy/TD-01`, `TD-02`, `TD-03`, `TD-06`)
2. Criar os DTOs de resposta com `@ApiProperty`: `VideoCreatedResponseDto { urlId, status, upload: { partSize, partCount, uploadExpiresAt } }`, `PartUrlsResponseDto { urls: { partNumber, url, expiresAt }[] }`, `UploadStatusResponseDto { status, partSize, partCount, uploadExpiresAt, uploadedParts }`, `UploadCompletedResponseDto { urlId, status }` — nomes de campo verbatim do `### API Contracts` (per `openapi-docs-nestjs/TD-01`)
3. Criar `src/videos/videos.controller.ts` (`@Controller('videos')`) com `@Post()` → 201, `@Post(':urlId/upload/parts')` → 200, `@Get(':urlId/upload')` → 200, `@Post(':urlId/upload/complete')` → 200, `@Delete(':urlId/upload')` → `@HttpCode(204)`; cada handler recebe `@CurrentUser() user: JwtPayload` e delega `user.sub` + `urlId` ao `VideosService`; sem `@Public()` (per revisão de `phase-03-videos/TD-06`; `phase-02-auth/TD-02`)
4. Documentar com `@ApiTags('videos')`, `@ApiBearerAuth('access-token')`, `@ApiOperation`, `@ApiOkResponse`/`@ApiCreatedResponse`/`@ApiNoContentResponse` tipados e `@ApiResponse({ status, type: ApiErrorEnvelope })` para cada código do `### Error Catalog` aplicável à rota (400, 401, 404, 409, 410, 413, 415, 502) (per `openapi-docs-nestjs/TD-01`, `TD-03`)
5. Registrar `VideosController` e `VideosService` em `VideosModule` (importando `StorageModule`, `VideoProcessingQueueModule`, `ChannelsModule`), então regenerar o artefato com `docker compose exec nestjs-api npm run openapi:export` e commitar `nestjs-project/openapi.json` atualizado (per `openapi-docs-nestjs/TD-02`)

**Tests:** _(empty — controller wiring; DTO validation + fluxo HTTP são E2E autorais em /plan-test-specs; regras de negócio testadas em SI-03.6)_

**Dependencies:** SI-03.6 — o controller é fiação sobre o `VideosService`

**Acceptance criteria:**

- `POST /videos` sem `Authorization` retorna `401`
- `POST /videos` com `{ fileName: "clip.mp4", mimeType: "video/mp4", fileSize: 209715200 }` e JWT válido retorna `201` com `urlId` (11 chars), `status: "draft"` e `upload.partCount: 4`
- `POST /videos` com `fileSize: "abc"` retorna `400` com `error: "VALIDATION_ERROR"` e `message` em array
- `POST /videos` com `fileName: "doc.pdf"` retorna `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
- `POST /videos/:urlId/upload/parts` com `{ partNumbers: [1, 2] }` retorna `200` com dois itens em `urls`, cada `url` apontando para `STORAGE_PUBLIC_ENDPOINT` e aceitando um `PUT`
- `POST /videos/:urlId/upload/parts` com `{ partNumbers: [99] }` num upload de 4 partes retorna `400` com `error: "INVALID_PART_NUMBERS"`
- `GET /videos/:urlId/upload` após o PUT de uma parte retorna `200` com `uploadedParts` contendo `partNumber: 1` e seu `etag`
- `POST /videos/:urlId/upload/complete` com as 4 partes retorna `200` com `status: "processing"`; repetir a chamada retorna `409` com `error: "UPLOAD_NOT_ACTIVE"`
- `DELETE /videos/:urlId/upload` num draft ativo retorna `204` e `GET /videos/:urlId` em seguida retorna `404`
- Qualquer rota `/videos/:urlId/...` com JWT de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.8 — Expor leitura, streaming e download do vídeo por url_id

**Route:** GET /videos/:urlId · GET /videos/:urlId/stream · GET /videos/:urlId/download
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (JWT global); owner-only (não-dono → `404 VIDEO_NOT_FOUND`)

**Description:** Entrega a URL única por vídeo como recurso consultável e as URLs pré-assinadas de reprodução (Range/206 servido pelo storage) e download (attachment), com TTLs por finalidade — fechando os entregáveis "streaming funcionando" e "URLs únicas geradas".

**Technical actions:**

1. Estender `VideosService` com `getByUrlId(userId, urlId)` → `VideoResponseDto` (campos do `### API Contracts → GET /videos/:urlId`, incluindo `thumbnailUrl` presignado com `upload.streamUrlTtlSeconds` quando `thumbnail_key` existe e `status = ready`, senão `null`; `processingError` só quando `status = error`) reutilizando `findOwnedOrThrow` (per `phase-03-videos/TD-05`; revisão de `TD-04`, `TD-06`)
2. Estender `VideosService` com `getStreamUrl(userId, urlId)` e `getDownloadUrl(userId, urlId)`: ambos exigem `status = ready` (senão `VIDEO_NOT_READY`); stream usa `storage.presignGetObject(source_key, upload.streamUrlTtlSeconds)`; download usa `presignGetObject(source_key, upload.downloadUrlTtlSeconds, { attachmentFileName: original_file_name })`; retornam `{ url, expiresAt }` (+ `fileName` no download) (per `phase-03-videos/TD-06`; `upload-policy/TD-04`)
3. Criar os DTOs de resposta com `@ApiProperty`: `VideoResponseDto` (`urlId`, `status`, `originalFileName`, `mimeType`, `durationSeconds`, `width`, `height`, `videoCodec`, `sizeBytes`, `thumbnailUrl`, `processingError`, `createdAt`, `processedAt`), `StreamUrlResponseDto { url, expiresAt }`, `DownloadUrlResponseDto { url, expiresAt, fileName }` — nomes verbatim do `### API Contracts` (per `openapi-docs-nestjs/TD-01`)
4. Adicionar em `VideosController` as rotas `@Get(':urlId')`, `@Get(':urlId/stream')`, `@Get(':urlId/download')` (todas 200, `@CurrentUser()`), documentadas com `@ApiOkResponse` tipado e `@ApiResponse({ type: ApiErrorEnvelope })` para 401, 404, 409 (`VIDEO_NOT_READY`) e 502; sem `@Public()` (per revisão de `phase-03-videos/TD-06`)
5. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export` no container e commitar (per `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (leitura/entrega) | Unit (repo + `StorageService` mockados): `getByUrlId` monta `thumbnailUrl` só quando `ready` com `thumbnail_key`; `processingError` só em `error`; `getStreamUrl` em `processing` → `VIDEO_NOT_READY`; TTLs passados ao storage são `streamUrlTtlSeconds` (stream) e `downloadUrlTtlSeconds` (download); download repassa `original_file_name` como `attachmentFileName`; vídeo de outro usuário → `VIDEO_NOT_FOUND` | `src/videos/videos.service.spec.ts` (estender) |

**Dependencies:** SI-03.7 — reutiliza `VideosController`, `findOwnedOrThrow` e o fluxo que leva um vídeo a `ready` via worker (SI-03.10) para validação ponta a ponta

**Acceptance criteria:**

- `GET /videos/:urlId` de um vídeo `ready` retorna `200` com `durationSeconds`, `width`, `height`, `videoCodec`, `sizeBytes` preenchidos e `thumbnailUrl` apontando para `videos/{id}/thumbnail.jpg`
- `GET /videos/:urlId` de um vídeo `draft` retorna `200` com metadata nula, `thumbnailUrl: null` e `processingError: null`
- `GET /videos/:urlId/stream` de um vídeo `ready` retorna `200` com `url` que, requisitada com `Range: bytes=0-1023`, responde `206 Partial Content`
- `GET /videos/:urlId/stream` de um vídeo `processing` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/:urlId/download` retorna `200` com `fileName` igual ao nome original e `url` contendo `response-content-disposition=attachment`
- `GET /videos/<11 chars inexistentes>` e `GET /videos/<urlId de outro usuário>` retornam `404` com `error: "VIDEO_NOT_FOUND"`
- Sem `Authorization`, as três rotas retornam `401`

---

### SI-03.9 — Implementar FfmpegService (metadata via ffprobe e frame de thumbnail)

**Description:** Isola a interface com os binários `ffprobe`/`ffmpeg` num serviço testável que extrai o contrato de metadata fixado no TD-04 e gera o JPEG da thumbnail a partir de uma URL, sem baixar o arquivo inteiro — a única parte da fase que toca processos externos.

**Technical actions:**

1. Criar `src/video-processing/ffmpeg/ffmpeg.service.ts` com `probe(sourceUrl) → VideoProbeResult { durationSeconds, width, height, videoCodec }`: executa `execFile('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', sourceUrl], { timeout, maxBuffer })` via `node:child_process` promisificado, faz `JSON.parse`, seleciona o primeiro stream `codec_type === 'video'` (`width`, `height`, `codec_name` → `videoCodec`) e `Math.floor(Number(format.duration))` → `durationSeconds` (per `phase-03-videos/TD-04` e sua revisão)
2. Implementar `captureFrame(sourceUrl, atSeconds) → Buffer` no mesmo serviço: `execFile('ffmpeg', ['-ss', String(atSeconds), '-i', sourceUrl, '-frames:v','1','-q:v','2','-f','image2','pipe:1'], { encoding: 'buffer', maxBuffer })` e retorna o stdout como JPEG; expor `thumbnailTimestamp(durationSeconds) = Math.max(0, durationSeconds * 0.1)` (per `### Events/Messages → Processing steps 4`)
3. Criar `src/video-processing/ffmpeg/ffmpeg.errors.ts` — `FfprobeFailedError` (`FFPROBE_FAILED`), `UnreadableMediaError` (`UNREADABLE_MEDIA`, sem stream de vídeo ou JSON inválido), `ThumbnailFailedError` (`THUMBNAIL_FAILED`), todas carregando `cause` com stderr truncado (≤ 500 chars) para o `processing_error` (per `phase-03-videos/TD-07`)
4. Criar `src/video-processing/ffmpeg/ffmpeg.module.ts` exportando `FfmpegService`, e o helper de teste `src/test/fixtures/make-test-video.ts` que gera um MP4 sintético de 2 s (`ffmpeg -f lavfi -i testsrc=duration=2:size=64x64:rate=10 -pix_fmt yuv420p`) em `tmpdir` para as suítes de integração (per `phase-03-videos/TD-04` — binários na imagem)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Unit (`execFile` mockado): args passados ao `ffprobe`/`ffmpeg` são exatamente os esperados; JSON sem stream de vídeo → `UnreadableMediaError`; exit code ≠ 0 → `FfprobeFailedError`/`ThumbnailFailedError` com stderr truncado; `durationSeconds` é `floor`; `thumbnailTimestamp(0) = 0` | `src/video-processing/ffmpeg/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration (binários reais da imagem, fixture sintético servido via `file://`): `probe` retorna `durationSeconds 2`, `width 64`, `height 64`, `videoCodec 'h264'`; `captureFrame` retorna `Buffer` iniciando com assinatura JPEG `FF D8 FF` | `src/video-processing/ffmpeg/ffmpeg.service.integration-spec.ts` |
| `FfmpegModule` | Unit: compilation test resolve `FfmpegService` | `src/video-processing/ffmpeg/ffmpeg.module.spec.ts` |

**Dependencies:** SI-03.1 — `ffmpeg`/`ffprobe` instalados na imagem

**Acceptance criteria:**

- `probe` sobre o fixture sintético de 2 s retorna exatamente `{ durationSeconds: 2, width: 64, height: 64, videoCodec: 'h264' }`
- `probe` sobre um arquivo de texto renomeado para `.mp4` resulta em erro com causa `FFPROBE_FAILED` ou `UNREADABLE_MEDIA` e stderr truncado a 500 chars
- `captureFrame(url, 0.2)` sobre o fixture retorna um `Buffer` não vazio cujos 3 primeiros bytes são `FF D8 FF`
- `probe` sobre uma URL HTTP pré-assinada do MinIO funciona sem baixar o objeto inteiro (tráfego observado muito menor que o tamanho do arquivo para um fixture de dezenas de MB)

---

### SI-03.10 — Implementar o worker de processamento (app standalone + VideoProcessor)

**Description:** Entrega o Video Worker do diagrama C4 como segunda aplicação Nest do mesmo codebase, rodando em container próprio, que consome a fila, extrai metadata, gera a thumbnail e fecha o ciclo `processing → ready | error` — o processamento pesado nunca roda no processo da API.

**Technical actions:**

1. Criar `src/worker/worker.module.ts` importando `ConfigModule.forRoot` (mesmo `load` + `validationSchema` do `AppModule`), `TypeOrmModule.forRootAsync` (mesma factory de `databaseConfig`, `autoLoadEntities: true`), `VideoProcessingQueueModule`, `StorageModule`, `FfmpegModule` e registrando `VideoProcessor`; criar `src/worker.ts` que faz `NestFactory.createApplicationContext(WorkerModule)` com `enableShutdownHooks()` (sem servidor HTTP) (per `phase-03-videos/TD-03`; convenções de `phase-01-configuracao-base/TD-01`, `TD-04`)
2. Criar `src/video-processing/video-processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE) class VideoProcessor extends WorkerHost` com `process(job: Job<ProcessVideoJobData>)` seguindo `### Events/Messages → Processing steps`: carrega `Video` (status ≠ `processing` → retorna sem efeito), `storage.headObject(source_key)` (ausente → lança `SOURCE_NOT_FOUND`), `presignInternalGetObject(source_key, upload.streamUrlTtlSeconds)`, `ffmpeg.probe(url)`, `ffmpeg.captureFrame(url, thumbnailTimestamp(durationSeconds))`, `storage.putObject('videos/{id}/thumbnail.jpg', jpeg, 'image/jpeg')`, e persiste `durationSeconds`, `width`, `height`, `videoCodec`, `sizeBytes`, `thumbnail_key`, `status = ready`, `processed_at = now()` (per `phase-03-videos/TD-04`, `TD-07`, `TD-09`)
3. Tratar falha terminal no mesmo processor: `@OnWorkerEvent('failed')` verifica `job.attemptsMade >= job.opts.attempts` e então grava `status = error`, `processing_error = <código da causa: SOURCE_NOT_FOUND | FFPROBE_FAILED | UNREADABLE_MEDIA | THUMBNAIL_FAILED | UNKNOWN>`, `processed_at = now()`; falhas intermediárias só relançam para o retry com backoff do BullMQ (per `phase-03-videos/TD-07`)
4. Adicionar scripts em `nestjs-project/package.json`: `"start:worker": "node dist/worker"`, `"start:worker:dev": "nest start --watch --entryFile worker"` (ou `nest start --watch -c nest-cli.worker.json` se o `entryFile` exigir projeto dedicado), mantendo `nest build` emitindo `dist/worker.js` (per `phase-03-videos/TD-03`)
5. Adicionar serviço `video-worker` em `compose.yaml` — mesmo `build` e `volumes` do `nestjs-api`, `command: npm run start:worker:dev`, mesmas variáveis de ambiente, `depends_on` `db`/`redis`/`minio` com `condition: service_healthy`; documentar em `nestjs-project/CLAUDE.md` (seção Services + logs) que `video-worker` existe e como inspecioná-lo (`docker compose logs video-worker`) (per `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit (repo, `StorageService`, `FfmpegService` mockados): vídeo `ready` → retorna sem tocar storage; caminho feliz persiste os cinco campos de metadata + `thumbnail_key` e `status ready`; `headObject` `NotFound` → lança erro com causa `SOURCE_NOT_FOUND`; `failed` com `attemptsMade < attempts` não altera o vídeo; `failed` na última tentativa grava `status error` + `processing_error` com a causa | `src/video-processing/video-processor.spec.ts` |
| `WorkerModule` | Unit: compilation test — resolve `VideoProcessor`, `StorageService`, `FfmpegService` com config de teste | `src/worker/worker.module.spec.ts` |
| `VideoProcessor` | Integration (DB, MinIO, Redis e ffmpeg reais): upload do fixture sintético para `videos/{id}/source.mp4`, vídeo em `processing`, `processor.process(job)` direto → linha fica `ready` com `durationSeconds 2`, `width 64`, `height 64`, `videoCodec 'h264'`, `sizeBytes` = tamanho do fixture e objeto `videos/{id}/thumbnail.jpg` existente no bucket | `src/video-processing/video-processor.integration-spec.ts` |

**Dependencies:** SI-03.3 — `StorageService`; SI-03.4 — entidade `Video`; SI-03.5 — fila e constantes; SI-03.9 — `FfmpegService`

**Acceptance criteria:**

- `docker compose up -d` sobe `video-worker` e `docker compose logs video-worker` mostra o worker conectado à fila `video-processing` sem erro
- Após `POST /videos/:urlId/upload/complete` de um MP4 real, em até 30 s `GET /videos/:urlId` passa de `status "processing"` para `"ready"` com `durationSeconds`, `width`, `height`, `videoCodec`, `sizeBytes` preenchidos e `thumbnailUrl` não nulo
- O objeto `videos/{id}/thumbnail.jpg` existe no bucket e é uma imagem JPEG válida
- Completar o upload de um arquivo `.mp4` que não é mídia válida leva o vídeo, após as 3 tentativas, a `status "error"` com `processingError` igual a `FFPROBE_FAILED` ou `UNREADABLE_MEDIA`
- Reprocessar um job para um vídeo já `ready` não altera `processed_at` nem reenvia a thumbnail
- Com o serviço `video-worker` parado, vídeos completados permanecem em `processing` e são processados assim que o worker volta (job persistido no Redis)
- O processo do worker não abre porta HTTP (`docker compose exec video-worker ss -ltn` não lista `3000`)

---

## Technical Specifications

### Data Model

_Naming rule for this phase: property names that a TD fixes verbatim (`durationSeconds`, `width`, `height`, `videoCodec`, `sizeBytes` — phase-03-videos/TD-04 revision; `uploadExpiresAt` — upload-policy/TD-05) are kept byte-verbatim as entity properties; every other column follows the existing snake_case convention of `users` / `channels` (`user_id`, `created_at`). Where a verbatim property differs from snake_case, the DB column is mapped explicitly (`@Column({ name: 'duration_seconds' })`)._

#### Video (`videos`)

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| url_id | varchar(11) | unique, not null — base62 identifier generated in-project with collision retry (phase-03-videos/TD-05); the public identifier used in every `/videos/:urlId` route |
| channel_id | uuid | FK → `channels.id`, not null — the owning channel (owner = `channel.user_id`, compared against `JwtPayload.sub`) |
| status | enum `video_status` (`draft`, `processing`, `ready`, `error`) | not null, default `draft` (phase-03-videos/TD-07) |
| original_file_name | varchar(255) | not null — `fileName` declared at initiation (upload-policy/TD-06); reused as the download attachment name |
| mime_type | varchar(100) | not null — `mimeType` declared at initiation, validated against `video/*` + allowlist (upload-policy/TD-06) |
| source_ext | varchar(8) | not null — extension from the allowlist (`mp4`, `webm`, `mov`, `mkv`, `avi`); feeds the object key |
| source_key | varchar(255) | unique, not null — `videos/{id}/source.{ext}` (phase-03-videos/TD-09) |
| thumbnail_key | varchar(255) | nullable — `videos/{id}/thumbnail.jpg` once the worker writes it (phase-03-videos/TD-09) |
| declared_size_bytes | bigint | not null — `fileSize` declared at initiation, ≤ `UPLOAD_MAX_FILE_SIZE_BYTES` (upload-policy/TD-01) |
| durationSeconds | integer | nullable — set by the worker from `ffprobe` (TD-04 revision); null while `draft`/`processing` |
| width | integer | nullable — worker (TD-04 revision) |
| height | integer | nullable — worker (TD-04 revision) |
| videoCodec | varchar(32) | nullable — worker (TD-04 revision), e.g. `h264` |
| sizeBytes | bigint | nullable — real object size verified at completion via `HeadObject`/`ListParts` (upload-policy/TD-01; TD-04 revision) |
| processing_error | text | nullable — cause recorded on terminal `error` (phase-03-videos/TD-07) |
| processed_at | timestamptz | nullable — set when the worker reaches `ready` or `error` |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | auto-updated |

**Relations:** `Channel` has many `Video` (one-to-many via `channel_id`); `Video` has one `VideoUpload` (one-to-one, see below). No relation to `User` directly — ownership is resolved through `Channel.user_id`.
**Indexes:** unique on `url_id`; unique on `source_key`; index on `channel_id`; index on `status` (worker/lazy-expiry lookups).

#### VideoUpload (`video_uploads`)

One row per multipart session; created together with the draft `Video` at initiation (phase-03-videos/TD-02).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| video_id | uuid | FK → `videos.id`, unique, not null, on delete cascade |
| storage_upload_id | varchar(255) | not null — the S3/MinIO `UploadId` returned by `CreateMultipartUpload` |
| part_size | integer | not null — `partSize` applied to this session, copied from `UPLOAD_PART_SIZE_BYTES` at initiation (upload-policy/TD-02) |
| part_count | integer | not null — `partCount = ceil(fileSize / partSize)`, ≤ 10 000 (upload-policy/TD-02) |
| uploadExpiresAt | timestamptz | not null — `initiatedAt + UPLOAD_SESSION_TTL_HOURS` (upload-policy/TD-05); part-URL / complete requests after this instant are rejected |
| completed_at | timestamptz | nullable — set by `CompleteMultipartUpload` success |
| aborted_at | timestamptz | nullable — set by explicit abort or by lazy expiry handling |
| created_at | timestamptz | default now() |

**Relations:** `VideoUpload` belongs to `Video` (one-to-one, owning side holds `video_id`).
**Indexes:** unique on `video_id`.

#### Enum `video_status`

`draft` → `processing` → `ready` | `error` (phase-03-videos/TD-07). `draft` is entered at initiation; `processing` when `CompleteMultipartUpload` succeeds and the job is enqueued; `ready`/`error` are written only by the worker (or by the API when completion fails the size check / the session expires — `error` with a recorded cause).

---

### API Contracts

_All endpoints live under `/videos` in `nestjs-project/` and require `Authorization: Bearer <access token>` (global `JwtAuthGuard`; no `@Public()` in this phase — phase-03-videos/TD-06 revision). Wire field names are camelCase as fixed by the upload-policy TDs (`fileName`, `mimeType`, `fileSize`, `partSize`, `partCount`). Error bodies use the inherited envelope `{ statusCode, error, message }` (phase-02-auth/TD-07). Every endpoint is documented with `@nestjs/swagger` decorators and lands in the exported `openapi.json` (openapi-docs-nestjs/TD-01..TD-03)._

#### POST /videos (SI-03.7)

Creates the draft video and opens the multipart upload session (phase-03-videos/TD-02; upload-policy/TD-01, TD-02, TD-06).

**Request headers:**
- Authorization: Bearer <access token>
- Content-Type: application/json

**Request body:**
- fileName: string, required — 1..255 chars; extension (case-insensitive) must be in `UPLOAD_ALLOWED_EXTENSIONS`
- mimeType: string, required — must start with `video/` and be consistent with the extension's allowlist entry
- fileSize: integer, required — 1 ≤ fileSize ≤ `UPLOAD_MAX_FILE_SIZE_BYTES` (10 GiB default)

**Response 201:**
- urlId: string — 11-char base62 public identifier
- status: `"draft"`
- upload:
  - partSize: integer (bytes) — `UPLOAD_PART_SIZE_BYTES`
  - partCount: integer — `ceil(fileSize / partSize)`
  - uploadExpiresAt: string (ISO-8601) — deadline to complete the upload

**Error responses:**
- 400 VALIDATION_ERROR: body fails schema validation (missing field, non-integer size, fileSize ≤ 0)
- 413 FILE_TOO_LARGE: `fileSize` > `UPLOAD_MAX_FILE_SIZE_BYTES`, or the derived `partCount` would exceed 10 000
- 415 UNSUPPORTED_VIDEO_FORMAT: extension not in the allowlist or `mimeType` not `video/*`
- 401 Unauthorized: missing/invalid bearer token (global guard)
- 502 STORAGE_ERROR: `CreateMultipartUpload` failed — no draft is persisted

---

#### POST /videos/:urlId/upload/parts (SI-03.7)

Issues presigned `UploadPart` URLs on demand, in batches (upload-policy/TD-03). Also the resume path: the client asks again for any part that is missing or whose URL expired.

**Request headers:**
- Authorization: Bearer <access token>
- Content-Type: application/json

**Request body:**
- partNumbers: integer[], required — 1..100 items, each 1 ≤ partNumber ≤ `partCount`, no duplicates

**Response 200:**
- urls: array of
  - partNumber: integer
  - url: string — presigned PUT URL, valid for `UPLOAD_PART_URL_TTL_SECONDS` (3600)
  - expiresAt: string (ISO-8601)

The client PUTs the raw part bytes to each `url` (no extra headers) and keeps the `ETag` response header for completion.

**Error responses:**
- 400 VALIDATION_ERROR: `partNumbers` missing, empty, > 100 items, or non-integer
- 400 INVALID_PART_NUMBERS: a part number is outside `1..partCount` or repeated
- 404 VIDEO_NOT_FOUND: `urlId` unknown, or the video is not owned by the caller's channel
- 409 UPLOAD_NOT_ACTIVE: the video is no longer `draft` (already completed or aborted)
- 410 UPLOAD_EXPIRED: `uploadExpiresAt` has passed — the session is aborted and the draft moves to `error` (upload-policy/TD-05)
- 502 STORAGE_ERROR: presigning failed

---

#### GET /videos/:urlId/upload (SI-03.7)

Upload status for resume (upload-policy/TD-03): which parts the storage already holds.

**Request headers:**
- Authorization: Bearer <access token>

**Response 200:**
- status: `"draft" | "processing" | "ready" | "error"`
- partSize: integer
- partCount: integer
- uploadExpiresAt: string (ISO-8601)
- uploadedParts: array of `{ partNumber: integer, etag: string, size: integer }` — from `ListParts`; empty when none uploaded or when the session is no longer active

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `urlId` or not owned by the caller
- 502 STORAGE_ERROR: `ListParts` failed

---

#### POST /videos/:urlId/upload/complete (SI-03.7)

Finalizes the multipart upload, verifies the real size (upload-policy/TD-01), moves the video to `processing` and enqueues the processing job (phase-03-videos/TD-01, TD-07).

**Request headers:**
- Authorization: Bearer <access token>
- Content-Type: application/json

**Request body:**
- parts: array, required — exactly `partCount` items, each `{ partNumber: integer (1..partCount), etag: string (non-empty) }`, ascending `partNumber`, no duplicates

**Response 200:**
- urlId: string
- status: `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: body shape invalid
- 400 INVALID_PARTS: part list incomplete / out of order / an `etag` does not match the storage (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall` from S3)
- 404 VIDEO_NOT_FOUND: unknown `urlId` or not owned by the caller
- 409 UPLOAD_NOT_ACTIVE: the video is no longer `draft`
- 410 UPLOAD_EXPIRED: `uploadExpiresAt` has passed — session aborted, draft moves to `error`
- 413 FILE_TOO_LARGE: real size (`HeadObject.ContentLength` after completion, or the `ListParts` sum before) exceeds the declared `fileSize` or the cap — the object is deleted / the upload aborted and the draft moves to `error` with cause `FILE_TOO_LARGE`
- 502 STORAGE_ERROR: `CompleteMultipartUpload` / `HeadObject` failed

---

#### DELETE /videos/:urlId/upload (SI-03.7)

Aborts an active upload session and discards the draft (client cancel). Frees the parts immediately instead of waiting for the lifecycle rule (upload-policy/TD-05).

**Request headers:**
- Authorization: Bearer <access token>

**Response 204:** No content. The multipart upload is aborted (`AbortMultipartUpload`) and the `Video` + `VideoUpload` rows are deleted.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `urlId` or not owned by the caller
- 409 UPLOAD_NOT_ACTIVE: the video is no longer `draft`
- 502 STORAGE_ERROR: `AbortMultipartUpload` failed

---

#### GET /videos/:urlId (SI-03.8)

Reads the video registry entry by its unique URL identifier (phase-03-videos/TD-05). Owner-only in this phase (TD-06 revision).

**Request headers:**
- Authorization: Bearer <access token>

**Response 200:**
- urlId: string
- status: `"draft" | "processing" | "ready" | "error"`
- originalFileName: string
- mimeType: string
- durationSeconds: integer | null
- width: integer | null
- height: integer | null
- videoCodec: string | null
- sizeBytes: integer | null
- thumbnailUrl: string | null — presigned GET for `videos/{id}/thumbnail.jpg`, TTL `MEDIA_STREAM_URL_TTL_SECONDS`; null until `ready`
- processingError: string | null — populated only when `status = "error"`
- createdAt: string (ISO-8601)
- processedAt: string (ISO-8601) | null

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `urlId` or not owned by the caller

---

#### GET /videos/:urlId/stream (SI-03.8)

Returns a short-lived presigned GET URL; the storage serves the bytes with `Range`/`206` support (phase-03-videos/TD-06; upload-policy/TD-04). JSON payload (not a 302) because the caller must send the bearer token, which a `<video src>` cannot do.

**Request headers:**
- Authorization: Bearer <access token>

**Response 200:**
- url: string — presigned GET for `source_key`, TTL `MEDIA_STREAM_URL_TTL_SECONDS` (21 600)
- expiresAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `urlId` or not owned by the caller
- 409 VIDEO_NOT_READY: `status` is not `ready`
- 502 STORAGE_ERROR: presigning failed

---

#### GET /videos/:urlId/download (SI-03.8)

Same mechanism with `response-content-disposition=attachment` signed into the URL (phase-03-videos/TD-06; upload-policy/TD-04).

**Request headers:**
- Authorization: Bearer <access token>

**Response 200:**
- url: string — presigned GET with `ResponseContentDisposition: attachment; filename="<original_file_name>"`, TTL `MEDIA_DOWNLOAD_URL_TTL_SECONDS` (3600)
- expiresAt: string (ISO-8601)
- fileName: string — `original_file_name`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `urlId` or not owned by the caller
- 409 VIDEO_NOT_READY: `status` is not `ready`
- 502 STORAGE_ERROR: presigning failed

---

#### Validation Rules — videos module DTOs

- `fileName`: required, string, 1..255 chars, must contain an extension; extension lower-cased and checked against `UPLOAD_ALLOWED_EXTENSIONS` (default `mp4,webm,mov,mkv,avi`); the bare name is sanitized (no path separators, no control chars) before being stored as `original_file_name`
- `mimeType`: required, string, matches `^video/[a-z0-9.+-]+$`
- `fileSize`: required, integer, 1 ≤ value ≤ `UPLOAD_MAX_FILE_SIZE_BYTES`
- `partNumbers`: required, integer array, 1..100 items, each 1..`partCount`, unique
- `parts`: required, array of `{ partNumber, etag }`, length = `partCount`, `partNumber` ascending and unique, `etag` non-empty string
- `urlId` path param: 11-char base62 string; anything else is a `404 VIDEO_NOT_FOUND` (never a 400 — the identifier space is opaque)
- Config bounds (Joi, phase-01 conventions): `UPLOAD_PART_SIZE_BYTES` ≥ 5 242 880 (5 MiB) and ≤ 5 GiB; `UPLOAD_MAX_FILE_SIZE_BYTES` ≤ 5 TiB; every `*_TTL_SECONDS` ≤ 604 800 (7 days); `STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS × 24 ≥ UPLOAD_SESSION_TTL_HOURS`

---

### Authorization Matrix

_Owner = the authenticated user whose channel owns the video (`video.channel.user_id === JwtPayload.sub`). Non-owners receive `404 VIDEO_NOT_FOUND` (no existence leak) — public access arrives with Fase 04 visibility (phase-03-videos/TD-06 revision). Anonymous requests are rejected by the global guard with 401._

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ (401) | ✓ (creates a video in the caller's own channel) | ✓ |
| POST /videos/:urlId/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:urlId/upload | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:urlId/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| DELETE /videos/:urlId/upload | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:urlId | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:urlId/stream | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:urlId/download | ✗ (401) | ✗ (404) | ✓ |

The presigned URLs themselves are bearer credentials: whoever holds one can PUT/GET for the TTL. TTLs are therefore short (upload-policy/TD-03, TD-04) and URLs are never persisted or logged.

---

### Error Catalog

_Error shape inherited from phase-02-auth/TD-07: `{ statusCode, error, message }` emitted by `DomainExceptionFilter` for `DomainException` subclasses; `400 VALIDATION_ERROR` with `message: string[]` comes from the existing `ValidationExceptionFilter`. New codes below are `DomainException` subclasses declared in the videos module._

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `urlId` does not exist, or the video belongs to another user's channel (owner-only phase) |
| FILE_TOO_LARGE | 413 | Declared `fileSize` above `UPLOAD_MAX_FILE_SIZE_BYTES`, derived `partCount` > 10 000, or real size at completion exceeds the declared size / the cap (upload aborted, draft → `error`) |
| UNSUPPORTED_VIDEO_FORMAT | 415 | `fileName` extension not in `UPLOAD_ALLOWED_EXTENSIONS` or `mimeType` not `video/*` |
| INVALID_PART_NUMBERS | 400 | A requested part number is outside `1..partCount` or repeated |
| INVALID_PARTS | 400 | Completion list incomplete, out of order, or an `etag` rejected by the storage (`InvalidPart` / `InvalidPartOrder` / `EntityTooSmall`) |
| UPLOAD_NOT_ACTIVE | 409 | Upload sub-resource called on a video that is not `draft` (already completed, aborted, or errored) |
| UPLOAD_EXPIRED | 410 | Upload sub-resource called after `uploadExpiresAt`; the API aborts the multipart upload and sets the draft to `error` with cause `UPLOAD_EXPIRED` |
| VIDEO_NOT_READY | 409 | `/stream` or `/download` requested while `status` ≠ `ready` |
| STORAGE_ERROR | 502 | S3/MinIO call (create/presign/list/complete/abort/head) failed or timed out; no partial state is persisted for creation |
| VALIDATION_ERROR | 400 | Request body/params fail DTO validation (inherited, `ValidationExceptionFilter`) |

Worker-side failures are not HTTP errors: they are recorded in `videos.processing_error` as a short machine-readable cause (`FFPROBE_FAILED`, `THUMBNAIL_FAILED`, `SOURCE_NOT_FOUND`, `UNREADABLE_MEDIA`) and surfaced through `GET /videos/:urlId` → `processingError` (phase-03-videos/TD-07).

---

### Events/Messages

_Queue technology: BullMQ on Redis (phase-03-videos/TD-01), producer in the API, consumer in the standalone worker app built from the same codebase (TD-03). Redis and the worker are Compose services addressed by service name._

#### video-processing / process-video

Queue `video-processing`, job name `process-video`.

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (API) — right after `CompleteMultipartUpload` succeeds, the size check passes and `status` is set to `processing` (per `phase-03-videos/TD-01`, `TD-07`; `upload-policy/TD-01`). `jobId = videoId` so a retried HTTP completion cannot enqueue the same video twice.
**Consumer:** `VideoProcessor` (worker app, `WorkerModule` bootstrapped via `NestFactory.createApplicationContext`) (per `phase-03-videos/TD-03`, `TD-04`).
**Trigger:** a video's upload was completed and verified; the payload carries only the id — the worker re-reads the `Video` row (source key, extension) from the database.
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-07`). Job options fixed by this plan (TD-07 leaves the numbers open): `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: false`. The processor is idempotent: it overwrites `durationSeconds`/`width`/`height`/`videoCodec`/`sizeBytes`/`thumbnail_key` and re-uploads `videos/{id}/thumbnail.jpg` on every attempt.
**Processing steps (consumer):**
1. Load `Video`; if `status` is not `processing` → acknowledge and exit (stale/duplicate job).
2. `HeadObject(source_key)` → confirm existence and record `sizeBytes`; missing object → cause `SOURCE_NOT_FOUND`.
3. Presign an internal GET URL (API-internal endpoint, TTL `MEDIA_STREAM_URL_TTL_SECONDS`) and run `ffprobe -v error -print_format json -show_format -show_streams <url>` via `execFile` (phase-03-videos/TD-04) → `durationSeconds` (floor of `format.duration`), first video stream's `width`, `height`, `codec_name` → `videoCodec`. Non-zero exit → cause `FFPROBE_FAILED`; no video stream → `UNREADABLE_MEDIA`.
4. Run `ffmpeg -ss <t> -i <url> -frames:v 1 -q:v 2 -f image2 pipe:1` with `t = durationSeconds × 0.1` (clamped to ≥ 0) and `PutObject` the JPEG to `videos/{id}/thumbnail.jpg` (TD-09). Failure → cause `THUMBNAIL_FAILED`.
5. Persist metadata + `thumbnail_key`, set `status = ready`, `processed_at = now()`.
**On final failure** (all attempts exhausted — BullMQ `failed` event with `attemptsMade === attempts`): set `status = error`, `processing_error = <cause>`, `processed_at = now()` (phase-03-videos/TD-07). Intermediate failures leave `status = processing` and let the queue retry.

---

## Dependency Map

SI-03.1 (root) — Infra: MinIO, Redis, ffmpeg, dependências
├── SI-03.2 — depends on SI-03.1 (config aponta para os serviços minio/redis)
│   ├── SI-03.3 — depends on SI-03.2 (StorageModule consome storageConfig)
│   └── SI-03.5 — depends on SI-03.1 + SI-03.2 (fila precisa do redis e do queueConfig)
└── SI-03.9 — depends on SI-03.1 (FfmpegService precisa dos binários na imagem)
SI-03.4 (root, independent) — Video + VideoUpload + url_id (só TypeORM e Channel existentes)
SI-03.6 — depends on SI-03.3 + SI-03.4 + SI-03.5 (VideosService usa storage, entidades e producer)
└── SI-03.7 — depends on SI-03.6 (controller de upload é fiação sobre o service)
    └── SI-03.8 — depends on SI-03.7 (reutiliza controller e findOwnedOrThrow; validação ponta a ponta precisa de SI-03.10)
SI-03.10 — depends on SI-03.3 + SI-03.4 + SI-03.5 + SI-03.9 (worker usa storage, entidade, fila e ffmpeg)

Ordem de execução sugerida: SI-03.1 → SI-03.2 → SI-03.4 → SI-03.3 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.9 → SI-03.10 → SI-03.8. Paralelizáveis: SI-03.4 com SI-03.2/SI-03.3; SI-03.9 com SI-03.3..SI-03.7.

---

## Deliverables

- [ ] SI-03.1 — Infra: provisionar MinIO, Redis, ffmpeg e dependências
- [ ] SI-03.2 — Configurar storage, fila e política de upload
- [ ] SI-03.3 — Implementar StorageModule (S3 client, bucket e operações multipart/presign)
- [ ] SI-03.4 — Modelar Video e VideoUpload (entidades, migration e url_id)
- [ ] SI-03.5 — Implementar fila de processamento (BullMQ producer)
- [ ] SI-03.6 — Implementar VideosService: ciclo de vida do upload
- [ ] SI-03.7 — Expor endpoints de upload (POST /videos e sub-recurso /upload)
- [ ] SI-03.8 — Expor leitura, streaming e download do vídeo por url_id
- [ ] SI-03.9 — Implementar FfmpegService (metadata via ffprobe e frame de thumbnail)
- [ ] SI-03.10 — Implementar o worker de processamento (app standalone + VideoProcessor)

**Full test suites** _(todo comando roda dentro do container, conforme `nestjs-project/CLAUDE.md`; integração e e2e compartilham o banco de teste e exigem `--runInBand`)_:

- [ ] Backend unit + integration tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build` — emite `dist/main.js` e `dist/worker.js`)
- [ ] `nestjs-project/openapi.json` regenerado (`docker compose exec nestjs-api npm run openapi:export`) e commitado com as 8 rotas de `/videos`
- [ ] Infra verificada no host: `docker compose ps` mostra `minio`, `redis` e `video-worker` saudáveis; `curl -f http://localhost:9000/minio/health/live` retorna `200`
