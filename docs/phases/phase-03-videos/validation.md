---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-12 10:52:07.153375854"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-12 10:47:38.764724029"
  docs/decisions/technical-decisions-upload-policy.md: "2026-09-12 10:47:38.764349494"
issues:
  - id: AMB-1
    status: resolved
    summary: "'extração de duração e metadados' — metadata field set unspecified"
    resolved_by: phase-03-videos/TD-04 (revision)
  - id: AMB-2
    status: resolved
    summary: "Streaming/download access rules undefined while visibility only arrives in Fase 04"
    resolved_by: phase-03-videos/TD-06 (revision)
  - id: MD-1
    status: resolved
    summary: "Upload limits & presigned-URL policy (10GB cap, part size, TTLs) has no TD"
    resolved_by: upload-policy/TD-01..TD-06 (research 2026-09-12)
  - id: OQ-1
    status: resolved
    summary: "upload-policy/TD-01 pending — Where the 10 GB File-Size Cap Is Enforced"
    resolved_by: upload-policy/TD-01
  - id: OQ-2
    status: resolved
    summary: "upload-policy/TD-02 pending — Multipart Part-Size Contract"
    resolved_by: upload-policy/TD-02
  - id: OQ-3
    status: resolved
    summary: "upload-policy/TD-03 pending — Upload-Part Presigned URL Issuance and TTL"
    resolved_by: upload-policy/TD-03
  - id: OQ-4
    status: resolved
    summary: "upload-policy/TD-04 pending — Playback and Download Presigned URL TTLs"
    resolved_by: upload-policy/TD-04
  - id: OQ-5
    status: resolved
    summary: "upload-policy/TD-05 pending — Abandoned-Upload Cleanup Policy"
    resolved_by: upload-policy/TD-05
  - id: OQ-6
    status: resolved
    summary: "upload-policy/TD-06 pending — Accepted Video Formats at Initiation"
    resolved_by: upload-policy/TD-06
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._ (Every current-scope TD's `Capability:` cites a bullet present in `## Scope`; no two decided TDs imply mutually exclusive runtime behavior. The six decided `upload-policy` TDs refine phase-03-videos/TD-02, TD-06, TD-08 and TD-09 without contradiction — e.g., the TD-06 owner-only revision guards the API endpoint that issues presigned GETs, while upload-policy/TD-04 only fixes their TTLs; upload-policy/TD-06's validated `{ext}` feeds the TD-09 key layout. No TD has `Scope: Frontend`, so the Scope-Subsection orphan check has nothing to fire on.)

### Ambiguities

_None._ (AMB-1 and AMB-2 resolved on 2026-09-12 as Revisions on phase-03-videos/TD-04 and TD-06 — see Resolved Issues. No new boundary or edge-case ambiguity surfaced by the decided upload policy.)

### Missing Decisions

_None._ (All 9 capability bullets map to ≥1 decided TD in `## Capability Coverage`. Error response format is inherited from phase-02-auth/TD-07. The shared-types contract-sync check does not fire: the phase has no UI scope.)

### Dependency Gaps

_None._ (Channels exist since Fase 02 — the video entity's owner FK has its prerequisite; the global JWT guard inherited from Fase 02 supports the owner-only access rule fixed in TD-06's revision; worker and upload-policy config reuse the `registerAs` + Joi conventions from Fase 01. Within-phase ordering is implied by the upload flow: draft pre-registration → multipart → completion → queue → worker.)

### Inherited Constraint Conflicts

_None._ (All 15 decided current-scope TDs align with the inherited conventions: storage, queue and upload-policy values exposed through namespaced `registerAs` factories validated by Joi; request validation via class-validator per phase-02-auth/TD-06; rate limiting from phase-02-auth/TD-08 stays scoped to `AuthModule` and does not constrain the batched part-URL endpoint of upload-policy/TD-03.)

### Unresolved Open Questions

_None._ (No TD is `pending` — OQ-1..OQ-6 resolved on 2026-09-12; see Resolved Issues.)

### UI Coverage Gaps

_None._ (Phase has no UI scope — `## UI Inventory` is absent; backend-only per the assignment.)

## Resolved Issues

- **MD-1** _(resolved_by upload-policy/TD-01..TD-06 — `/research politica de upload`, 2026-09-12)_ — Upload limits & presigned-URL policy (10GB cap, part size, TTLs) had no TD. The ad-hoc decisions doc `docs/decisions/technical-decisions-upload-policy.md` (`related_phases: [3]`) now carries six TDs covering cap enforcement, part-size contract, upload-part URL TTL, playback/download TTLs, abandoned-upload cleanup and accepted formats. Their pending decisions are tracked as OQ-1..OQ-6.
- **AMB-1** _(resolved_by phase-03-videos/TD-04 — revision appended 2026-09-12)_ — Persisted metadata contract fixed: explicit typed columns `durationSeconds`, `width`, `height`, `videoCodec`, `sizeBytes` extracted by ffprobe; no JSONB blob. Rationale: closed, queryable persistence contract for the Data Model.
- **AMB-2** _(resolved_by phase-03-videos/TD-06 — revision appended 2026-09-12)_ — Phase 03 streaming/download access rule fixed as **owner-only** (JWT-guarded, owner must match); public access begins with Fase 04 visibility. Rationale: no video exposed before 'published' exists.
- **OQ-1** _(resolved_by upload-policy/TD-01)_ — Decision **A**: declare `fileSize` at initiation + verify real size at completion; cap 10 GiB.
- **OQ-2** _(resolved_by upload-policy/TD-02)_ — Decision **A**: server-fixed 64 MiB part size (configurable); API returns `partSize` + `partCount`.
- **OQ-3** _(resolved_by upload-policy/TD-03)_ — Decision **A**: on-demand batched part URLs, TTL 1 h; same endpoint serves resume.
- **OQ-4** _(resolved_by upload-policy/TD-04)_ — Decision **B**: per-purpose TTLs — stream 6 h, download 1 h.
- **OQ-5** _(resolved_by upload-policy/TD-05)_ — Decision **A**: bucket lifecycle aborts incomplete multiparts after 1 day + 24 h upload-session deadline on the draft.
- **OQ-6** _(resolved_by upload-policy/TD-06)_ — Decision **A**: extension + MIME allowlist (mp4, webm, mov, mkv, avi) at initiation; ffprobe authoritative in the worker.
