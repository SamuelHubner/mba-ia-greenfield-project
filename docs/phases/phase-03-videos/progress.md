# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

### SI-03.1 — Infra: provisionar MinIO, Redis, ffmpeg e dependências
- **Status:** completed
- **Tests:** no tests (infra) — ACs verificados manualmente: minio/redis `healthy`, `/minio/health/live` 200, `redis-cli ping` PONG, ffmpeg/ffprobe 5.1.9 na imagem
- **Observations:**
  - A imagem `minio/minio` não existe mais no Docker Hub (pull access denied); usada a oficial `quay.io/minio/minio` no lugar — divergência do texto do plano, mesmo software.
  - Credenciais root do MinIO vêm de `${MINIO_ROOT_USER:-streamtube}` / `${MINIO_ROOT_PASSWORD:-streamtube123}` (interpolação do `.env` do Compose, com defaults); SI-03.2 deve alinhar `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` a esses valores.
  - `library-refs.md` só fixa os pacotes `@aws-sdk/*` (^3.1131.0, instalados no mesmo minor, `@smithy/core` deduplicado). Para a fila foram escolhidos `@nestjs/bullmq ^11.0.5` (major alinhado ao NestJS 11; a 12.0.0 também aceita Nest 11) e `bullmq ^6.3.4`.
  - `npm install` reporta 40 vulnerabilidades no `npm audit` (contagem anterior não medida); fora de escopo desta fase.

### SI-03.2 — Configurar storage, fila e política de upload
- **Status:** completed
- **Tests:** 23 passing (`upload.config.spec`, `storage.config.spec`, `queue.config.spec`, `env.validation.integration-spec` estendido); boot de `AppModule` com o `.env` real devolve `upload.partSizeBytes = 67108864` e a allowlist default
- **Observations:**
  - `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` passaram a ser obrigatórios no Joi, então o `.env` local (não versionado) também recebeu o bloco novo com `streamtube`/`streamtube123`, alinhado às credenciais root do MinIO do SI-03.1; sem isso os e2e existentes não bootariam.
  - Limites S3 (parte 5 MiB..5 GiB, objeto ≤ 5 TiB, presign ≤ 7 dias) ficaram como constantes nomeadas em `env.validation.ts`; a regra cruzada usa `Joi.object().custom()` com `helpers.error('any.custom')` (forma documentada no Joi 18).

### SI-03.4 — Modelar Video e VideoUpload (entidades, migration e url_id)
- **Status:** completed
- **Tests:** 36 passing (4 arquivos do SI + `migrations.integration-spec`, `channels.module.spec`, `channel.entity.integration-spec`, `users.service.integration-spec`, `auth.module.spec` como regressão); `migration:run` → `migration:revert` → `migration:run` aplicados sem erro no container
- **Observations:**
  - A relação inversa `Channel.videos` obriga o TypeORM a conhecer `Video`/`VideoUpload` em todo `DataSource`; as listas `ALL_ENTITIES` de 10 specs existentes (auth/users/channels) receberam as duas entidades — mudança mecânica, sem alteração de asserções.
  - `cleanAllTables` passou a apagar `video_uploads` e `videos` antes de `channels` (FK).
  - `migrations.integration-spec` estendido para a 3ª migration (6 tabelas, drop do enum `video_status`); o `beforeAll` fazia os `DROP TABLE CASCADE` em `Promise.all` e passou a deadlockar com a nova cadeia de FKs — drops serializados.
  - `video_id` ficou sem `unique: true` na coluna: o `@OneToOne` + `@JoinColumn` já gera a constraint `REL_` única, e manter os dois gerava constraint duplicada na migration.
  - Follow-up fora de escopo: `video_uploads.part_size` é `integer` (int4, máx ≈ 2 GiB) conforme o Data Model, mas o Joi aceita `UPLOAD_PART_SIZE_BYTES` até 5 GiB; um deploy com parte > 2 GiB falharia no insert. Alinhar (bigint na coluna ou teto de 2 GiB no Joi) numa task separada.

### SI-03.3 — Implementar StorageModule (S3 client, bucket e operações multipart/presign)
- **Status:** completed
- **Tests:** 21 passing (`storage.module.spec` 1, `storage.service.spec` 14, `storage.service.integration-spec` 6 contra o MinIO do Compose: ciclo multipart completo com PUT via `fetch`, etag inválido → `StoragePartError`, abort → `NoSuchUpload`, Range → 206, download com `Content-Disposition: attachment`, storage inacessível → `STORAGE_ERROR` 502)
- **Observations:**
  - **Pendência de decisão (TD-05 do upload-policy):** o MinIO community (`RELEASE.2025-09-07`) rejeita regras de lifecycle contendo só `AbortIncompleteMultipartUpload` (`InvalidArgument`) e descarta o elemento quando vem com `Expiration` — o AC "lifecycle rule presente após o boot" não é satisfazível localmente. Implementado o fallback previsto no `library-refs.md`: `ensureBucket` tenta a regra, e se o storage a rejeitar loga `WARN`, expõe `lifecycleRuleApplied = false` e segue o boot (no S3 real a regra é aplicada). Partes abandonadas em dev dependem do deadline de sessão + abort explícito (SI-03.6). Opção B do TD-05 (sweeper repetível no BullMQ) fica como decisão do usuário / task separada.
  - Testes que rodam dentro do container precisam de `STORAGE_PUBLIC_ENDPOINT=http://minio:9000` (localhost é o próprio container); o spec de integração seta isso via `process.env` antes do `ConfigModule` — o mesmo vale para os e2e dos SI-03.7/03.8.
  - `StoragePartError` e `StorageObjectNotFound` são erros tipados simples (não `DomainException`): o `VideosService` (SI-03.6) os mapeia para `INVALID_PARTS`/`UPLOAD_NOT_ACTIVE`/`VIDEO_NOT_FOUND`; só `StorageException` (502) chega ao filtro diretamente.
  - Integração usa o bucket separado `streamtube-media-test` (criado no `module.init()`), sem tocar o bucket da aplicação.

### SI-03.5 — Implementar fila de processamento (BullMQ producer)
- **Status:** completed
- **Tests:** 5 passing (`video-processing-queue.module.spec` 1, `video-processing.producer.spec` 2, `video-processing.producer.integration-spec` 2 contra o Redis do Compose: job `process-video` com `data.videoId`, `attempts 3`, backoff exponencial 5000 ms, dedup por `jobId` → 1 job em `waiting`)
- **Observations:**
  - `bullmq` 6 trata `ioredis` como peer opcional e não o instala; sem ele `new Queue()` falha no boot ("could not load the optional 'ioredis' package"). Adicionado `ioredis ^5.11.1` às `dependencies` — pacote além dos quatro listados no SI-03.1/`library-refs.md`.
  - AC "com redis parado o boot loga erro identificando `redis:6379`" coberto pela asserção de `queue.opts.connection = { host: 'redis', port: 6379 }` no compilation test (o erro do ioredis inclui host:porta); não foi simulado parando o serviço.
  - `VideoProcessingQueueModule` ainda não está importado no `AppModule`/`VideosModule` — a ligação acontece no SI-03.6/SI-03.7 conforme o plano.

### SI-03.6 — Implementar VideosService: ciclo de vida do upload
- **Status:** completed
- **Tests:** 35 passing (`videos.service.spec` 23, `videos.service.integration-spec` 7 contra DB + MinIO do Compose com producer mockado, `videos.module.spec` 1, `channels.service.integration-spec` 4 incl. o novo `findByUserId`)
- **Observations:**
  - O canal do usuário é resolvido por `ChannelsService.findByUserId(userId)` (método novo, com teste de integração) em vez de o `VideosModule` consultar a entidade `Channel` diretamente — mantém a lookup no módulo dono da entidade.
  - Mapeamento de `StoragePartError`: `NoSuchUpload` → `UPLOAD_NOT_ACTIVE` (sessão já não existe no storage); `InvalidPart`/`InvalidPartOrder`/`EntityTooSmall` → `INVALID_PARTS`. O texto do plano diz só "→ INVALID_PARTS"; a distinção segue a nota do SI-03.3. `abortMultipartUpload` tolera `NoSuchUpload`.
  - `getUploadStatus` aplica a expiração preguiçosa só quando o vídeo ainda é `draft`; fora de `draft` responde com `uploadedParts: []` sem tocar o storage (concilia o AC "consultar expirado → UPLOAD_EXPIRED" com o contrato do `GET /upload`, que só lista 404/502).
  - Compensação além do plano: se a transação de `initiateUpload` falhar depois do `CreateMultipartUpload`, o service aborta o multipart (best effort, WARN em falha) para não deixar sessão órfã no storage.
  - `VideosModule` passou a importar `ChannelsModule`, `StorageModule` e `VideoProcessingQueueModule`; `AppModule` agora abre conexão com MinIO (`ensureBucket` no init) e Redis ao bootar — os e2e existentes passam a depender dos serviços `minio`/`redis` do Compose (a confirmar no SI-03.7). `videos.module.spec` foi ajustado para registrar `storageConfig`/`queueConfig`/`uploadConfig`.
  - O spec de integração fixa `UPLOAD_PART_SIZE_BYTES = 5 MiB` (mínimo S3) para exercitar um upload real de 2 partes barato, e usa o bucket `streamtube-media-test` como o SI-03.3.

### SI-03.7 — Expor endpoints de upload (POST /videos e sub-recurso /upload)
- **Status:** completed
- **Tests:** 10 passing (`test/videos-upload.e2e-spec.ts` gerado do spec `videos-upload.plan.md`: 10 cenários contra AppModule real + MinIO + Redis, incluindo PUTs reais de 3×5 MiB + 1 KiB e job `process-video` em `waiting`)
- **Observations:**
  - **Desvio do spec (a fechar no SI-03.8):** o cenário 5.1 passo 2 lê o vídeo apagado via `GET /videos/:urlId`, rota que só nasce no SI-03.8; até lá o e2e usa `GET /videos/:urlId/upload` (mesmo `findOwnedOrThrow`) e deixa comentário no teste. SI-03.8 deve trocar para a rota do spec.
  - Os DTOs de request também receberam `@ApiProperty` explícito: `openapi:export` roda via ts-node, sem o plugin CLI do Swagger, e sem isso os schemas saem vazios (é o caso dos DTOs de auth já exportados, ex. `RegisterDto: {properties: {}}` — follow-up fora de escopo).
  - `openapi.json` regenerado (+727 linhas, só adições): `/videos`, `/videos/{urlId}/upload/parts`, `/videos/{urlId}/upload` (GET + DELETE), `/videos/{urlId}/upload/complete`; commit fica com o usuário.
  - O e2e fixa `STORAGE_PUBLIC_ENDPOINT=http://minio:9000`, `STORAGE_BUCKET=streamtube-media-test` e `UPLOAD_PART_SIZE_BYTES=64 MiB` via `process.env` antes de compilar o `AppModule`, e esvazia a fila (`obliterate`) em `beforeEach`/`afterAll`.
  - Suites e2e pré-existentes (`app`, `auth`, `swagger`) agora bootam com MinIO/Redis; não foram rodadas neste SI — ficam para a verificação final.

### SI-03.9 — Implementar FfmpegService (metadata via ffprobe e frame de thumbnail)
- **Status:** completed
- **Tests:** 13 passing (`ffmpeg.service.spec` 9 com `execFile` mockado, `ffmpeg.service.integration-spec` 3 com binários reais da imagem e fixture sintético via `file://`, `ffmpeg.module.spec` 1)
- **Observations:**
  - O `execFile` é injetado pelo token `FFMPEG_EXEC` (`exec-file.ts`, wrapper que mantém stdout/stderr na rejeição); o unit spec substitui o provider em vez de `jest.mock('node:child_process')`.
  - O `cause` das exceções guarda a **cauda** (últimos 500 chars) do stderr, pois ffmpeg/ffprobe imprimem o erro real no fim; um truncamento pela cabeça guardaria só o banner.
  - AC "probe sobre URL HTTP pré-assinada do MinIO sem baixar o objeto inteiro" não está na tabela de Tests deste SI; fica coberto funcionalmente pelo teste de integração do worker no SI-03.10 (probe via presign interno). A medição de tráfego permanece verificação manual.
  - `make-test-video.ts` acrescenta `-y -v error` aos args do plano para rodar silencioso e idempotente; o H.264 vem do libx264 da imagem Debian.

### SI-03.10 — Implementar o worker de processamento (app standalone + VideoProcessor)
- **Status:** completed
- **Tests:** 12 passing (`video-processor.spec` 8, `video-processor.integration-spec` 3 com DB + MinIO + ffmpeg reais e fixture sintético em `videos/{id}/source.mp4`, `worker.module.spec` 1); `nest build` emite `dist/worker.js`; `docker compose up -d video-worker` sobe e loga `Video worker consuming queue "video-processing"` sem erro
- **Observations:**
  - **Fila compartilhada entre dev e testes:** o `video-worker` do Compose consome a mesma fila Redis que as suítes e2e/integração enfileiram (mesmo DB, bucket diferente) — um job de teste seria pego pelo worker, falharia com `SOURCE_NOT_FOUND` e poderia marcar a linha como `error`. Para rodar as suítes com o worker de pé é preciso pará-lo (`docker compose stop video-worker`) ou isolar por prefixo de fila por ambiente (BullMQ `prefix`) — follow-up fora de escopo.
  - A imagem não tem `iproute2`, então o AC `ss -ltn` não é executável literalmente; verificado via `/proc/net/tcp`: o worker só escuta numa porta efêmera de loopback do `nest --watch`, nada em `3000`.
  - `video-worker` não tem `healthcheck` (não previsto no plano); `docker compose ps` mostra `Up`, não `healthy`.
  - API e worker compartilham o `dist/` do volume montado; `nest start --watch` nos dois ao mesmo tempo compete pelo `deleteOutDir`. Em dev o `nestjs-api` sobe com `tail -f`, então só há conflito se o `start:dev` da API for iniciado manualmente com o worker rodando.
  - `WorkerModule` duplica a factory do TypeORM do `AppModule` ("mesma factory", sem tocar o `AppModule`); extrair um builder comum é limpeza possível fora de escopo. `forFeature([Video, VideoUpload, Channel, User])` fecha o grafo de relações do `Video` sem carregar os tokens de auth.
  - O spec de integração chama `processor.process`/`onFailed` diretamente (sem Redis); a fiação BullMQ do worker é coberta pelo `worker.module.spec` (Queue resolvida) e pelo `video-processing.producer.integration-spec`. O caminho completo API → Redis → worker → `ready` fica para a verificação manual na final verification (com o dev server da API).
  - `@OnWorkerEvent('failed')` marca terminal quando `attemptsMade >= opts.attempts` (BullMQ incrementa `attemptsMade` antes de emitir o evento); `UNKNOWN` cobre erros fora de `SourceNotFoundError`/`FfmpegError`.

### SI-03.8 — Expor leitura, streaming e download do vídeo por url_id
- **Status:** completed
- **Tests:** 48 passing (`videos.service.spec` 31 = 23 anteriores + 8 novos de `getByUrlId`/`getStreamUrl`/`getDownloadUrl`; `test/videos-delivery.e2e-spec.ts` 7 cenários do spec com Range → 206 e `content-disposition` reais do MinIO; `test/videos-upload.e2e-spec.ts` 10, re-executado após trocar o 5.1 para `GET /videos/:urlId`)
- **Observations:**
  - Desvio do SI-03.7 fechado: o cenário 5.1 do e2e de upload voltou à rota do spec (`GET /videos/:urlId` → 404 `VIDEO_NOT_FOUND`).
  - `openapi.json` regenerado (+1081 linhas acumuladas na fase, só adições): 7 paths / 8 operações de `/videos` + `VideoResponseDto`, `StreamUrlResponseDto`, `DownloadUrlResponseDto`; commit fica com o usuário.
  - `getByUrlId` devolve o `VideoResponseDto` já com datas ISO (como o plano pede); `getStreamUrl`/`getDownloadUrl` devolvem `PresignedUrl` com `Date` e o controller serializa, no mesmo padrão dos part URLs.
  - O e2e semeia `ready`/`processing` direto no repositório + `StorageService.putObject` (JPEG mínimo de 22 bytes como thumbnail), sem depender do worker, conforme o spec; o caminho completo API → Redis → worker → `ready` fica para a verificação manual na final verification.
  - O `video-worker` foi parado (`docker compose stop video-worker`) antes dos e2e para não consumir os jobs de teste (ver SI-03.10); precisa ser religado depois da verificação final.

### Final verification — 2026-09-15
- **Checks:** `npm test -- --runInBand` 273/273 (44 suites); `npm run test:e2e` 69/69 (5 suites); `npx tsc --noEmit` código 0; `npm run lint` 0 erros (41 warnings pré-existentes/aceitos); `npm run build` emite `dist/main.js` + `dist/worker.js`; `openapi.json` regenerado com 7 paths / 8 operações de `/videos`; `docker compose ps` com `minio`, `redis` healthy e `video-worker` Up; `curl /minio/health/live` → 200. Smoke manual (não commitado): `POST /videos` → PUT → `complete` → worker → `GET /videos/:urlId` em `ready` com metadata, thumbnail JPEG e stream com Range → 206, em ~1 s.
- **Observations:**
  - **Correção fora de SI aplicada na verificação final:** o script `test:e2e` do `package.json` não tinha `--runInBand`, apesar de `nestjs-project/CLAUDE.md` afirmar "already configured"; com 5 suítes e2e rodando em paralelo no mesmo banco, 20 testes falharam por contaminação cruzada (FK em `cleanAllTables`, 401 por usuário truncado). Adicionado `--runInBand` ao script — o comando dos Deliverables passa a ser reprodutível.

