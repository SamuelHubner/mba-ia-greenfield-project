---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-31 18:45:05.156498176"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-12 10:47:38.764724029"
  docs/decisions/technical-decisions-upload-policy.md: "2026-09-12 10:47:38.764349494"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-31 18:45:05.152857678"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-31 18:45:05.155015090"
  docs/phases/phase-02-auth/context.md: "2026-08-31 18:45:05.155857461"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-31 18:45:05.155093237"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-31 18:45:04.994869091"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-12 10:52:07.126010737"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None explicitly named._ The phase block mentions no subproject path and has no `Subprojetos:` line (not inferred by plan-reader). The decisions docs in scope declare `nestjs-project/` as the only subproject with open TDs and `next-frontend/` as deferred.

**Deferred subprojects:** _None explicitly named in project-plan.md._ (Decisions docs defer `next-frontend/` — video UI belongs to later phases.)

**Sequencing notes:** `> Depende de: Fase 01, Fase 02` — intro sentence: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — `> Depende de: Fase 01`
- **Phase 04:** Gerenciamento de Vídeos e Canal — `> Depende de: Fase 02, Fase 03`

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Background Processing Queue Technology | decided | A | — |
| phase-03-videos/TD-02 | phase | Cross-layer | 10GB Upload Strategy (without blocking the API) | decided | A | — |
| phase-03-videos/TD-03 | phase | Backend | Worker Topology (how the video worker runs) | decided | A | — |
| phase-03-videos/TD-04 | phase | Backend | Metadata Extraction and Thumbnail Tooling (FFmpeg interface) | decided | A | — |
|     └─ Last revision: 2026-09-12 — Persisted metadata contract fixed (resolves plan-validate AMB-1): explicit type… | | | | | | |
| phase-03-videos/TD-05 | phase | Backend | Unique Video URL Identifier Strategy | decided | B | — |
| phase-03-videos/TD-06 | phase | Cross-layer | Streaming and Download Delivery Strategy | decided | A | — |
|     └─ Last revision: 2026-09-12 — Phase 03 access rule fixed (resolves plan-validate AMB-2): streaming and… | | | | | | |
| phase-03-videos/TD-07 | phase | Backend | Video Status Lifecycle and Processing-Failure Policy | decided | A | — |
| phase-03-videos/TD-08 | phase | Backend | S3 Client Library | decided | A | — |
| phase-03-videos/TD-09 | phase | Backend | Bucket and Object-Key Organization | decided | A | — |
| upload-policy/TD-01 | ad-hoc | Cross-layer | Where the 10 GB File-Size Cap Is Enforced | decided | A | @aws-sdk/client-s3 |
| upload-policy/TD-02 | ad-hoc | Cross-layer | Multipart Part-Size Contract | decided | A | — |
| upload-policy/TD-03 | ad-hoc | Cross-layer | Upload-Part Presigned URL Issuance and TTL | decided | A | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| upload-policy/TD-04 | ad-hoc | Cross-layer | Playback and Download Presigned URL TTLs | decided | B | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| upload-policy/TD-05 | ad-hoc | Backend | Abandoned-Upload Cleanup Policy | decided | A | @aws-sdk/client-s3 |
| upload-policy/TD-06 | ad-hoc | Cross-layer | Accepted Video Formats at Initiation | decided | A | — |

`Renders in` column omitted: no TD in the kept set carries an explicit `**Renders in:**` field (all values would be `—`).

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])
- upload-policy — `docs/decisions/technical-decisions-upload-policy.md` (scope_type: ad-hoc, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-08, phase-03-videos/TD-09, upload-policy/TD-05 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, upload-policy/TD-01, upload-policy/TD-02, upload-policy/TD-03, upload-policy/TD-06 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-07, upload-policy/TD-01, upload-policy/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-07, upload-policy/TD-06 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06, upload-policy/TD-04 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06, upload-policy/TD-04 |

_Built by cross-referencing each TD's `Capability:` field with the capabilities above. phase-03-videos/TD-03 is `Transversal — covers:` three bullets and is listed under each. All 15 TDs are `decided` as of 2026-09-12 (the six upload-policy TDs were filled by `/plan-resolve 03`)._

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** it is the only option that combines ready-made job semantics (attempts/backoff/failed state, which TD-07 consumes directly), an official NestJS 11 integration, and a dedicated queue service visibly running in Compose. RabbitMQ buys generality the phase doesn't need at the cost of hand-rolled retry topology; pg-boss buys simplicity at the cost of making the phase's queue deliverable invisible.
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** the only option that satisfies 10GB + no-bytes-through-API + resumability using nothing but the storage already in the stack. tus adds a new trust boundary and infrastructure for resumability that multipart already provides at the granularity the phase needs.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** matches the C4 diagram's separate Video Worker container while reusing every existing convention (config namespaces, TypeORM, testing), at the cost of a shared image that is irrelevant at this scale.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** the wrapper everyone would reach for is dead, the plumbing is small, and installing ffmpeg in the worker image is the natural move in a project where everything already runs in containers.
**Libraries:** —

**Revisions:**
- 2026-09-12 — Persisted metadata contract fixed (resolves plan-validate AMB-1): explicit typed columns `durationSeconds`, `width`, `height`, `videoCodec`, `sizeBytes`, all extracted by `ffprobe` in the worker; no free-form JSONB blob. Rationale: a fixed, typed column set is queryable/indexable (e.g., filtering by resolution in later phases) and gives `/plan-build` a closed persistence contract for the Data Model.

### phase-03-videos/TD-05

**Recommendation:** equivalent guarantees to nanoid without inheriting its ESM-only packaging problem in a CommonJS build, reusing the collision-retry pattern the codebase already established for nicknames.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** consistent with the upload principle (API orchestrates, storage moves bytes), gets Range/206 and attachment download from S3 semantics for free, and keeps HLS as a clean future evolution rather than a phase-03 obligation.
**Libraries:** —

**Revisions:**
- 2026-09-12 — Phase 03 access rule fixed (resolves plan-validate AMB-2): streaming and download endpoints are **owner-only** — JWT-guarded, the authenticated user must own the video; no `@Public()` opt-out in this phase. Public/unlisted access starts when Fase 04 introduces visibility and publication. Rationale: no video is exposed before the concept of 'published' exists; the Authorization Matrix of the plan is owner-only for every video endpoint.

### phase-03-videos/TD-07

**Recommendation:** implements the plan's cycle exactly, delegates failure handling to the queue's proven retry mechanics, and keeps state-machine surface minimal for the phase.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** the architecture explicitly frames MinIO as "same API as S3, swapped in production"; coding against the official S3 SDK keeps that swap to configuration only, and its presigner covers every URL TD-02/TD-06 need.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** the phase has one access pattern (presigned, private); colocated artifacts and single-bucket bootstrap are concretely simpler, and a future split remains possible behind the storage service abstraction.
**Libraries:** —

### upload-policy/TD-01

**Recommendation:** the only option that both fails fast and closes the hole, using nothing beyond the SDK already decided in TD-08. Cap value: **10 GiB = 10 737 418 240 bytes** (`UPLOAD_MAX_FILE_SIZE_BYTES`, the assignment's "10GB" read as binary so a 10.0 GB file on any OS fits).
**Libraries:** @aws-sdk/client-s3

### upload-policy/TD-02

**Recommendation:** simplest contract that satisfies the resumability requirement with a bounded retry cost; the Joi schema enforces `min(5 MiB)` so a misconfiguration can never violate the S3 minimum.
**Libraries:** —

### upload-policy/TD-03

**Recommendation:** it is the only option where resumability falls out of the normal flow instead of being a bolt-on, and 1 h comfortably covers a batch of 64 MiB parts on any realistic link while staying far below the 7-day SigV4 ceiling. The batch size limit (e.g., ≤ 100 part numbers per request) is a DTO detail left to `implement`.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### upload-policy/TD-04

**Recommendation:** separates the two access patterns TD-06 already distinguishes, keeps the download link short-lived, and costs nothing beyond two config keys. The player must handle 403-on-seek by re-fetching the URL regardless of option, so the simplest fixed values win.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### upload-policy/TD-05

**Recommendation:** storage-native cleanup with no scheduler, a documented client deadline, and the periodic draft sweep left as an explicit future task once Fase 04's video management defines what the owner sees. Values: `UPLOAD_SESSION_TTL_HOURS = 24`, `STORAGE_ABORT_INCOMPLETE_UPLOAD_DAYS = 1` (Joi: days × 24 ≥ session TTL).
**Libraries:** @aws-sdk/client-s3

### upload-policy/TD-06

**Recommendation:** fail-fast on the cheap signal, keep `ffprobe` as the truth, and derive the TD-09 extension from a validated value. The default list (`mp4, webm, mov, mkv, avi`) is exposed as `UPLOAD_ALLOWED_EXTENSIONS` so Fase 05 can narrow it to browser-native containers as a Revision, not a Supersede.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions:... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. [TD refs: —] |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. [TD refs: —] |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. [TD refs: phase-02-auth-frontend/TD-07] |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. [TD refs: phase-02-auth-frontend/TD-01, phase-02-auth-frontend/TD-05] |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. [TD refs: phase-02-auth-frontend/TD-07] |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. [TD refs: phase-02-auth-frontend/TD-01, phase-02-auth-frontend/TD-04] |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Additional guide notes relevant to this phase: module DI wiring tests must cover configured imports such as `BullModule.registerQueue()`; service-to-external-system contracts (storage uploads, queue publishing) are worth integration tests against the real Compose services; race conditions on concurrent video uploads are explicitly listed as worth testing._

### next-frontend

_Deferred subproject — no work in this phase; testing requirements will apply when video UI phases begin._
