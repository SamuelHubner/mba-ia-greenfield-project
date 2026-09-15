---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload.e2e-spec.ts
---

# Upload de vídeo (POST /videos e sub-recurso /upload) — Test Plan

## Application Overview

O sub-recurso de upload expõe o ciclo de vida de um upload multipart orquestrado pela API sem que os bytes passem por ela: `POST /videos` cria o vídeo como `draft` no canal do usuário autenticado e abre a sessão multipart no MinIO (`partSize`, `partCount`, `uploadExpiresAt`); `POST /videos/:urlId/upload/parts` emite URLs `PUT` pré-assinadas em lote (também o caminho de resume); `GET /videos/:urlId/upload` lista as partes já recebidas pelo storage (`ListParts`); `POST /videos/:urlId/upload/complete` finaliza o multipart, verifica o tamanho real, move o vídeo para `processing` e enfileira o job `process-video`; `DELETE /videos/:urlId/upload` aborta a sessão e descarta o rascunho. Todas as rotas exigem JWT (guard global) e as rotas por `:urlId` são owner-only — não-dono recebe `404 VIDEO_NOT_FOUND` sem vazar existência. Erros de domínio seguem o `### Error Catalog` do plano via `DomainExceptionFilter`; erros de DTO seguem `VALIDATION_ERROR` via `ValidationExceptionFilter`.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeAll` compila `AppModule` real via `Test.createTestingModule`, reproduz a config global de `main.ts` (`ValidationPipe { whitelist, forbidNonWhitelisted, transform }` + `DomainExceptionFilter` + `ValidationExceptionFilter`) e chama `app.init()`; `afterAll` chama `app.close()`. `beforeEach` roda `cleanAllTables(dataSource)` e esvazia a fila `video-processing` (`queue.drain()` / `obliterate`). MinIO e Redis reais sobem via Compose (`STORAGE_*`, `REDIS_*` apontando para os service names). Helper `registerConfirmAndLogin(email)` (mesmo padrão de `test/auth.e2e-spec.ts`) devolve o `access_token` do usuário — o canal é criado no cadastro. Os `PUT`s de partes vão direto ao MinIO usando `fetch` global (Node ≥ 18) contra a `url` pré-assinada; o `ETag` da resposta é guardado para a conclusão. Assume `UPLOAD_PART_SIZE_BYTES` no default de 64 MiB (`67108864`), o que faz `fileSize: 209715200` render `partCount: 4`.

#### 1.1. create-video-sem-token-401

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. POST /videos sem header `Authorization` com body `{ fileName: "clip.mp4", mimeType: "video/mp4", fileSize: 209715200 }`
    - expect: status `401`
    - expect: nenhuma linha em `videos` nem em `video_uploads`

#### 1.2. create-video-abre-sessao-multipart

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. POST /videos com JWT válido e body `{ fileName: "clip.mp4", mimeType: "video/mp4", fileSize: 209715200 }`
    - expect: status `201`
    - expect: `body.urlId` é string de 11 caracteres base62 (`/^[A-Za-z0-9]{11}$/`)
    - expect: `body.status === "draft"`
    - expect: `body.upload.partSize === 67108864`, `body.upload.partCount === 4` e `body.upload.uploadExpiresAt` é ISO-8601 no futuro
  2. Consultar `videos` e `video_uploads` via `DataSource`
    - expect: existe 1 vídeo com `url_id === body.urlId`, `status = draft` e `channel_id` do canal do usuário
    - expect: existe 1 `video_uploads` ligado ao vídeo com `upload_id` não vazio e `part_count = 4`

#### 1.3. create-video-validation-error-400

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. POST /videos com JWT válido e body `{ fileName: "clip.mp4", mimeType: "video/mp4", fileSize: "abc" }`
    - expect: status `400`
    - expect: `body.error === "VALIDATION_ERROR"`
    - expect: `Array.isArray(body.message)` e alguma mensagem referencia `fileSize`
    - expect: nenhuma linha em `videos`

#### 1.4. create-video-formato-nao-suportado-415

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. POST /videos com JWT válido e body `{ fileName: "doc.pdf", mimeType: "video/mp4", fileSize: 1048576 }`
    - expect: status `415`
    - expect: `body.error === "UNSUPPORTED_VIDEO_FORMAT"`
    - expect: nenhuma linha em `videos`

### 2. POST /videos/:urlId/upload/parts

**Setup:** Mesmo bootstrap do grupo 1. Cada cenário cria um draft via `POST /videos` (`fileSize: 209715200` → 4 partes) com o JWT do usuário dono.

#### 2.1. part-urls-presign-e-aceitam-put

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. POST /videos/:urlId/upload/parts com JWT do dono e body `{ partNumbers: [1, 2] }`
    - expect: status `200`
    - expect: `body.urls` tem exatamente 2 itens com `partNumber` 1 e 2
    - expect: cada `url` começa com `STORAGE_PUBLIC_ENDPOINT` e contém `uploadId` e `partNumber` na query string
    - expect: cada `expiresAt` é ISO-8601 no futuro
  2. PUT de 5 MiB de bytes na `url` da parte 1 via `fetch` (sem headers extras)
    - expect: o storage responde `200` com header `ETag` não vazio

#### 2.2. part-urls-fora-do-intervalo-400

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. POST /videos/:urlId/upload/parts com JWT do dono e body `{ partNumbers: [99] }` num upload de 4 partes
    - expect: status `400`
    - expect: `body.error === "INVALID_PART_NUMBERS"`

### 3. GET /videos/:urlId/upload

**Setup:** Mesmo bootstrap do grupo 1. Cenário cria um draft, obtém a URL da parte 1 e faz o `PUT` de 5 MiB antes de consultar o status.

#### 3.1. upload-status-lista-partes-enviadas

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. GET /videos/:urlId/upload com JWT do dono, antes de qualquer `PUT`
    - expect: status `200` com `status === "draft"`, `partSize === 67108864`, `partCount === 4` e `uploadedParts` vazio
  2. PUT de 5 MiB na URL pré-assinada da parte 1 e nova chamada GET /videos/:urlId/upload
    - expect: status `200`
    - expect: `uploadedParts` contém um item com `partNumber === 1`, `etag` igual ao `ETag` devolvido pelo storage e `size === 5242880`

### 4. POST /videos/:urlId/upload/complete

**Setup:** Mesmo bootstrap do grupo 1. Cenário cria um draft de 4 partes e envia 4 partes ao storage: partes 1–3 com 5 MiB cada (mínimo S3 para partes não-finais) e parte 4 com 1 KiB — tamanho real (≈15 MiB) menor que o `fileSize` declarado, o que passa na verificação de tamanho. Guarda os `ETag`s para o body de conclusão.

#### 4.1. complete-move-para-processing-e-repeticao-409

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. POST /videos/:urlId/upload/complete com JWT do dono e body `{ parts: [{ partNumber: 1, etag }, …, { partNumber: 4, etag }] }`
    - expect: status `200`
    - expect: `body.urlId` igual ao do draft e `body.status === "processing"`
    - expect: a linha em `videos` está com `status = processing`
    - expect: a fila `video-processing` contém 1 job `process-video` com `data.videoId` igual ao `id` do vídeo e `jobId` igual a esse `id`
  2. Repetir o mesmo POST /videos/:urlId/upload/complete
    - expect: status `409`
    - expect: `body.error === "UPLOAD_NOT_ACTIVE"`
    - expect: a fila continua com 1 job (nenhuma duplicata)

### 5. DELETE /videos/:urlId/upload

**Setup:** Mesmo bootstrap do grupo 1. Cenário cria um draft ativo com o JWT do dono.

#### 5.1. abort-descarta-draft-204

**Covers AC:** #9
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. DELETE /videos/:urlId/upload com JWT do dono
    - expect: status `204` com body vazio
    - expect: as linhas em `videos` e `video_uploads` do draft não existem mais
  2. GET /videos/:urlId com o mesmo JWT
    - expect: status `404` com `body.error === "VIDEO_NOT_FOUND"`

### 6. Authorization Matrix — owner-only

**Setup:** Mesmo bootstrap do grupo 1. Cenário cadastra dois usuários (`owner@test.com` e `other@test.com`), cria um draft com o JWT do dono e usa o JWT do outro usuário nas chamadas.

#### 6.1. rotas-por-urlid-com-jwt-de-outro-usuario-404

**Covers AC:** #10
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. POST /videos/:urlId/upload/parts com JWT de outro usuário e body `{ partNumbers: [1] }`
    - expect: status `404` com `body.error === "VIDEO_NOT_FOUND"`
  2. GET /videos/:urlId/upload com JWT de outro usuário
    - expect: status `404` com `body.error === "VIDEO_NOT_FOUND"`
  3. POST /videos/:urlId/upload/complete com JWT de outro usuário e body `{ parts: [{ partNumber: 1, etag: "x" }] }`
    - expect: status `404` com `body.error === "VIDEO_NOT_FOUND"`
  4. DELETE /videos/:urlId/upload com JWT de outro usuário
    - expect: status `404` com `body.error === "VIDEO_NOT_FOUND"`
    - expect: o draft do dono continua existindo com `status = draft`
