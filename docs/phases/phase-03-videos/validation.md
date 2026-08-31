---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 3
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-31 20:29:39.103266043"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31 20:24:50.774774364"
issues:
  - id: AMB-1
    status: open
    summary: "'extração de duração e metadados' — metadata field set unspecified"
  - id: AMB-2
    status: open
    summary: "Streaming/download access rules undefined while visibility only arrives in Fase 04"
  - id: MD-1
    status: open
    summary: "Upload limits & presigned-URL policy (10GB cap, part size, TTLs) has no TD"
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — The capability "Processamento automático do vídeo após upload (extração de duração e **metadados**)" does not specify which metadata fields must be extracted and persisted. `ffprobe` exposes dozens (codec, resolution, bitrate, framerate, container format, size…); the persistence requirement only names "duração e metadados". A plan-build Data Model cannot be written without fixing the set. Explicit choice: define the persisted metadata contract — either an explicit column set (e.g., duration + width/height + codec + size) or a typed `metadata` JSONB column with a documented minimum set; record it as a revision on phase-03-videos/TD-04 (or in the Data Model inputs) via /plan-resolve 03.
- **AMB-2** — "Reprodução via streaming" and "Download do vídeo pelo usuário" do not state **who** may stream/download in this phase. Public/unlisted visibility and the publication flow only arrive in Fase 04, and anonymous viewing is a Fase 05 concern — yet Phase 03 videos end the phase as `ready` without a publication state. Boundary question a reasonable implementer must ask: are Phase 03 streaming/download endpoints owner-only (JWT-guarded), or already public via the global-guard `@Public()` opt-out? This determines the Authorization Matrix of the plan. Explicit choice: fix the Phase 03 access rule (recommended: owner-only in Phase 03; public access starts when Fase 04 introduces visibility) via /plan-resolve 03, recorded as a revision on phase-03-videos/TD-06.

### Missing Decisions

- **MD-1** — The upload flow (phase-03-videos/TD-02) has no decision fixing its **limits and policies**, which are technical business rules cited cross-component (DTO validation + presigner + worker + tests): maximum accepted file size (the 10GB cap must be enforced somewhere — S3 policy? API validation at initiation?), multipart part-size bounds (S3 minimum 5MiB / part count ≤10,000 constrains the client contract), and presigned-URL expiry for upload parts (TD-02) and playback/download (TD-06). Explicit choice: fix these values as a policy block — via /plan-resolve 03 as revisions on TD-02/TD-06 (or a new TD if preferred) — so plan-build can write API Contracts and the Error Catalog against concrete limits.

### Dependency Gaps

_None._ (Channels exist since Fase 02 — the video entity's owner FK has its prerequisite; the global JWT guard and `@Public()` decorator inherited from Fase 02 support whichever access rule AMB-2 fixes; worker reuses config/TypeORM conventions from Fase 01.)

### Inherited Constraint Conflicts

_None._ (TD-08/TD-09 storage config and TD-01 Redis config align with the namespaced `registerAs` convention; no current TD contradicts inherited TDs.)

### Unresolved Open Questions

_None._ (All 9 current-scope TDs are `decided`.)

### UI Coverage Gaps

_None._ (Phase has no UI scope — backend-only per the assignment.)

## Resolved Issues

_No issues resolved yet._
