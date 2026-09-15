---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-delivery.e2e-spec.ts
---

# Leitura, streaming e download por url_id — Test Plan

## Application Overview

As rotas de entrega tornam a URL única de cada vídeo um recurso consultável e entregam as URLs pré-assinadas de reprodução e download: `GET /videos/:urlId` devolve o registro do vídeo (status, metadados extraídos pelo worker, `thumbnailUrl` pré-assinada quando `ready`, `processingError` quando `error`); `GET /videos/:urlId/stream` devolve um `GET` pré-assinado de curta duração (`MEDIA_STREAM_URL_TTL_SECONDS`) para o `source_key`, com `Range`/`206` servido pelo próprio storage; `GET /videos/:urlId/download` devolve o mesmo mecanismo com `response-content-disposition=attachment; filename="<original_file_name>"` assinado na URL (`MEDIA_DOWNLOAD_URL_TTL_SECONDS`). Stream e download exigem `status = ready` (senão `409 VIDEO_NOT_READY`). Todas as rotas exigem JWT e são owner-only — `urlId` desconhecido ou de outro usuário retorna `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. GET /videos/:urlId

**Setup:** `beforeAll` compila `AppModule` real via `Test.createTestingModule`, reproduz a config global de `main.ts` (`ValidationPipe { whitelist, forbidNonWhitelisted, transform }` + `DomainExceptionFilter` + `ValidationExceptionFilter`) e chama `app.init()`; `afterAll` chama `app.close()`. `beforeEach` roda `cleanAllTables(dataSource)`. MinIO real via Compose. Helper `registerConfirmAndLogin(email)` (padrão de `test/auth.e2e-spec.ts`) devolve o `access_token`. Estados são semeados deterministicamente sem depender do worker: o draft nasce via `POST /videos`; o estado `ready` é obtido escrevendo um objeto de teste (≥ 2 KiB) em `source_key` via `StorageService.putObject`, um JPEG mínimo em `videos/{id}/thumbnail.jpg`, e atualizando a linha em `videos` pelo repositório (`status = ready`, `durationSeconds`, `width`, `height`, `videoCodec`, `sizeBytes`, `thumbnail_key`, `processed_at`); o estado `processing` é obtido atualizando só o `status`. O caminho completo via worker (SI-03.10) tem validação própria e não é reproduzido aqui.

#### 1.1. get-video-ready-com-metadata-e-thumbnail

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. GET /videos/:urlId com JWT do dono, vídeo semeado como `ready`
    - expect: status `200`
    - expect: `body.status === "ready"`, `body.originalFileName === "clip.mp4"`, `body.mimeType === "video/mp4"`
    - expect: `durationSeconds`, `width`, `height`, `videoCodec` e `sizeBytes` iguais aos valores semeados (não nulos)
    - expect: `body.thumbnailUrl` é string começando com `STORAGE_PUBLIC_ENDPOINT` e contendo `videos/<id>/thumbnail.jpg`
    - expect: `body.processingError === null` e `body.processedAt` é ISO-8601
  2. GET na `thumbnailUrl` via `fetch`
    - expect: o storage responde `200` com `content-type` `image/jpeg`

#### 1.2. get-video-draft-metadata-nula

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. GET /videos/:urlId com JWT do dono, vídeo recém-criado via `POST /videos` (status `draft`)
    - expect: status `200` com `body.status === "draft"`
    - expect: `durationSeconds`, `width`, `height`, `videoCodec` e `sizeBytes` são `null`
    - expect: `body.thumbnailUrl === null`, `body.processingError === null` e `body.processedAt === null`
    - expect: `body.createdAt` é ISO-8601 e `body.urlId` tem 11 caracteres

#### 1.3. get-video-inexistente-ou-de-outro-usuario-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. GET /videos/AAAAAAAAAAA (11 caracteres base62 sem vídeo correspondente) com JWT válido
    - expect: status `404` com `body.error === "VIDEO_NOT_FOUND"`
  2. GET /videos/:urlId de um vídeo do usuário `owner@test.com` usando o JWT de `other@test.com`
    - expect: status `404` com `body.error === "VIDEO_NOT_FOUND"`
    - expect: o body não contém nenhum campo do vídeo (`urlId`, `originalFileName`)

### 2. GET /videos/:urlId/stream

**Setup:** Mesmo bootstrap do grupo 1. Cenário 2.1 semeia `ready` com um objeto de 4 KiB em `source_key`; cenário 2.2 semeia `processing`.

#### 2.1. stream-ready-url-suporta-range-206

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. GET /videos/:urlId/stream com JWT do dono, vídeo `ready`
    - expect: status `200`
    - expect: `body.url` é string começando com `STORAGE_PUBLIC_ENDPOINT` e contendo o `source_key` do vídeo
    - expect: `body.url` NÃO contém `response-content-disposition`
    - expect: `body.expiresAt` é ISO-8601 e fica a até `MEDIA_STREAM_URL_TTL_SECONDS` (21600 s) no futuro
  2. GET na `body.url` via `fetch` com header `Range: bytes=0-1023`
    - expect: status `206 Partial Content`
    - expect: header `content-range` começa com `bytes 0-1023/` e o corpo tem 1024 bytes

#### 2.2. stream-processing-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. GET /videos/:urlId/stream com JWT do dono, vídeo semeado como `processing`
    - expect: status `409`
    - expect: `body.error === "VIDEO_NOT_READY"`

### 3. GET /videos/:urlId/download

**Setup:** Mesmo bootstrap do grupo 1. Cenário semeia `ready` com `original_file_name = "clip.mp4"`.

#### 3.1. download-url-attachment-com-filename

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. GET /videos/:urlId/download com JWT do dono, vídeo `ready`
    - expect: status `200`
    - expect: `body.fileName === "clip.mp4"`
    - expect: `body.url` contém `response-content-disposition=attachment` e o `filename` `clip.mp4` (URL-encoded)
    - expect: `body.expiresAt` é ISO-8601 e fica a até `MEDIA_DOWNLOAD_URL_TTL_SECONDS` (3600 s) no futuro
  2. GET na `body.url` via `fetch`
    - expect: status `200` com header `content-disposition` igual a `attachment; filename="clip.mp4"`

### 4. Authorization Matrix — JWT obrigatório

**Setup:** Mesmo bootstrap do grupo 1. Cenário semeia um vídeo `ready` e faz as chamadas sem header `Authorization`.

#### 4.1. tres-rotas-sem-token-401

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-12T14:18:15Z

**Steps:**
  1. GET /videos/:urlId sem `Authorization`
    - expect: status `401`
  2. GET /videos/:urlId/stream sem `Authorization`
    - expect: status `401`
  3. GET /videos/:urlId/download sem `Authorization`
    - expect: status `401`
    - expect: nenhuma das três respostas contém `url`, `urlId` ou `fileName`
