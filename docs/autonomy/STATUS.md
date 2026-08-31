# Kynviora - Status

**Resume checkpoint.** Read this first on any autonomous restart, then `git log`, then the tail
of `WORKLOG.md`, then `BLOCKERS.md`.

Last updated: 2026-08-31

---

## Current position

|                    |                                        |
| ------------------ | -------------------------------------- |
| **Current stage**  | Stage 8 (family collaboration)         |
| **Current phase**  | Household Review Inbox (8.3)           |
| **Last completed** | Phase 8.2 caregiver alert delivery     |
| **Branch**         | `master`                               |
| **Latest commit**  | `feat(care): caregiver alert delivery` |
| **Baseline tag**   | `baseline-spec-only`                   |

## Verification state

- **1492 tests passing**, 0 failing, across 34 files.
- `npm run verify` runs typecheck, mobile typecheck, lint, format check and the full suite,
  chained with `&&` so no gate can be silently skipped.

```bash
npm run verify
```

- Database tests execute against real PostgreSQL 18.3 via PGlite as a non-superuser role.
- The mobile app typechecks against the real Expo SDK 57 / RN 0.86 / React 19.2 toolchain.

## What is genuinely built and tested

| Area                                                       | State                                       |
| ---------------------------------------------------------- | ------------------------------------------- |
| Domain vocabularies, IDs, provenance, untrusted quarantine | Complete, 94 tests                          |
| Database schema, 9 migrations, full RLS                    | Complete, 176 tests incl. threats A1/A2/A3  |
| Catalog engine, capture pipeline, Trust Passport           | Complete, 178 tests                         |
| Regulatory registry, Citation Gate, Lens                   | Complete, 72 tests                          |
| Safety rule engine with replay; schedule and refill        | Complete, 88 tests                          |
| Ingestion pipeline with hostile-source defences            | Complete, 37 tests                          |
| Presentation layer, accessibility tokens, safety copy      | Complete, 436 tests                         |
| API boundary (Fastify), RLS-scoped context                 | Complete, 37 tests                          |
| Offline sync protocol, per-entity conflict policy          | Complete, 43 tests                          |
| Caregiver invitation, acceptance, revocation, audit        | Complete, 150 tests                         |
| Visit Pack export, reviewed-content gate, expiry           | Complete, 100 tests                         |
| Caregiver alert delivery, notification privacy             | Complete, 126 tests; **not sent** (BLK-009) |
| End-to-end vertical slice, 7 required scenarios            | Complete, 36 tests                          |
| Mobile app shell, encrypted store, accessible primitives   | Typechecks; **not device-verified**         |
| Caregiver, Visit Pack, notification screens                | Typecheck; **not wired** (`DEV-007`)        |
| CI pipeline                                                | Written; not yet run on a real runner       |

Rows are areas, not a partition, and they do not sum to the total. The caregiver, Visit Pack and
alert-delivery rows each count tests that also appear in the database row, because those features
span every layer. The presentation and API rows count only their own general suites, not the
per-feature ones. Per-file counts are reproducible with `npx vitest run --reporter=json`.

## Known failing tests

None.

## Active blockers

See `BLOCKERS.md`. None of them stops further work; each has a port, a local adapter, and
documented configuration requirements.

| ID      | Class                               | Blocks                                        |
| ------- | ----------------------------------- | --------------------------------------------- |
| BLK-001 | `EXTERNAL_SERVICE`                  | Managed Postgres/Supabase parity              |
| BLK-002 | `ENVIRONMENT`                       | On-device encryption proof; all device E2E    |
| BLK-003 | `EXTERNAL_CREDENTIAL` + `LICENSING` | GS1/provider identity resolution              |
| BLK-004 | `DATA_AVAILABILITY`                 | Publishing any regulatory status as trusted   |
| BLK-005 | `LEGAL_REVIEW`                      | Source snapshot retention                     |
| BLK-006 | `CLINICAL_REVIEW` + `LEGAL_REVIEW`  | Publishing any safety rule; public beta       |
| BLK-007 | `EXTERNAL_CREDENTIAL`               | Real OCR/multimodal extraction                |
| BLK-008 | `DATA_AVAILABILITY`                 | Every numeric release threshold (Stage 9.1)   |
| BLK-009 | `EXTERNAL_CREDENTIAL`               | Actually sending any notification to a device |

## Immediate next task

**Household Review Inbox** (Phase 8.3). Collect non-urgent work that improves data quality and
care readiness - item not reviewed recently, batch missing, formula needs confirmation, OCR field
unresolved, caregiver grant expiring, safety item awaiting confirmation - and display it
_without_ safety-alert styling, which is the point of the phase rather than a detail of it. The
caregiver authorization model from Phase 8.1 and the presentation separation between evidence and
urgency both already exist; the new work is the task vocabulary, its lifecycle, and a surface that
cannot be mistaken for the alert inbox.

## Next three planned tasks

1. Reviewer console publication workflow (Phase 6.6): two-person approval where policy requires
   it, emergency withdrawal, and immutable audit.
2. Wire the Expo screens to the API contract, replacing the placeholder states with the Shelf,
   Trust Passport, Regulatory Lens, caregiver, Visit Pack and notification surfaces the
   presentation package supports (`DEV-007`).
3. Medicine Reconciliation workflow v1 (Phase 8.5).

## Recent decisions worth knowing

- **DEC-004/005** - PGlite is the migration and RLS harness. Authorization tests **must** run as
  the non-superuser `kynviora_app` role; the harness fails the test if they do not, because
  superusers bypass RLS even under `FORCE ROW LEVEL SECURITY`. Verified empirically (R-003).
- **DEC-007** - regulatory _status_ and regulatory _applicability_ are separate axes. There is no
  `EXCEEDS_LIMIT` or `NON_COMPLIANT` outcome anywhere.
- **DEC-016** - every shipped regulatory fixture is rejected by the Citation Gate, because the
  research behind them came from search summaries rather than retrieved official documents. A
  test asserts this. Do **not** "fix" it by promoting them.
- **DEC-010** - the rule engine is server-side only. The mobile client must never gain a
  rule-evaluation code path.
- The Citation Gate now exists at two layers: a pure function for explainable decisions, and
  CHECK constraints so a direct database write cannot bypass it.
- **DEC-018** - an invitation token is stored **only** as a SHA-256 hash and is unrecoverable
  after the create response. An idempotent retry therefore cannot re-issue it, and says so.
- **DEC-019/020** - acceptance never widens an existing grant, and only the profile owner may
  delegate `MANAGE_CAREGIVERS`. Both prevent an authorization change the owner would not observe.
- **DEC-021** - `token_hash` is protected by a column-level `GRANT`, not by RLS. Row-level
  security is row-shaped and cannot hide a column.
- **DEC-022** - a Visit Pack stores a _manifest_ (which records, at which version) and a content
  digest, never a copy of the content. A stored copy would outlive the record it came from and
  would have to be enumerated in the deletion workflow. Retrieval re-renders from live records and
  reports `matchesGeneratedContent` when they have moved on.
- **DEC-023** - generation quotes the digest of the content the user reviewed, and is refused with
  `EXPORT_CONTENT_CHANGED` if recomputing it from live data differs. This is what makes "a user
  can review exactly what will be shared" a property of the system rather than a claim about the
  client.
- **DEC-024** - an **authorization** predicate uses the real clock (`has_capability` keeps
  `expires_at > now()`), because an injectable clock must never resurrect an expired grant.
  **Written domain data** uses the injected clock, so rows stay replayable. Never put both inside
  one comparison - see trap 12.
- **DEC-025** - notification disclosure is two dials and the narrower wins: the owner's ceiling on
  what any caregiver notification may reveal, and each recipient's own setting for their own
  device. Both default to `GENERIC`, so a missing row is never permission. The owner is exempt
  from the ceiling, because it limits what leaves the profile onto someone else's device.
- **DEC-026** - `alert_delivery` records that a notification happened, to whom, and at which
  level. It has no body column, and it is append-only. The body is the string written to be read
  on a locked screen (`15` A6); storing it would outlive the alert's withdrawal.

## Traps to avoid on resume

1. Do not add a conversion between `EvidenceLevel` and `ActionUrgency`, or any aggregate score.
   Several tests assert none exists.
2. Do not add a `UK` jurisdiction. GB and NI are separate by design.
3. Do not promote a regulatory fixture to `PUBLISHED` outside the explicitly-named test helper.
4. Do not write an authorization test that runs as `postgres` - it will pass vacuously. The
   harness guard catches this, but only if you use `asUser`/`asService`.
5. Do not introduce `new Date()` in production code; the lint rule rejects it and it breaks
   assessment replay.
6. **Never pipe a checker into `tail` when verifying.** The pipe discards the exit code and turns
   a failing gate into a passing one. This happened once and let 34 lint errors reach a commit.
   Use `npm run verify`, which chains with `&&`.
7. Writing files with literal control characters or unusual Unicode via heredoc has repeatedly
   corrupted source files in this environment. Use `\uXXXX` escapes in source.
8. `Array.isArray` widens a `readonly T[]` to `any[]`. For untrusted input, type it as
   `Readonly<Record<string, unknown>>` and narrow each field explicitly.
9. Do not clear `audit_event` in a test fixture. The append-only trigger refuses the DELETE, which
   is correct. Scope audit assertions by target instead.
10. Do not merge two caregiver grants for the same pair. `has_capability` unions capabilities
    across grants, so a merge silently creates a permission set nobody approved. A partial unique
    index refuses it; do not drop that index to make a test pass.
11. The invitation token is a live credential. It belongs in a POST body only - never a URL, a log
    line, or an exception message. `inviteToken()` deliberately does not echo the value it
    rejected.
12. A CHECK constraint may only compare timestamps written from the **same** clock, so a column
    appearing in one must be written explicitly rather than left to `DEFAULT now()`. This already
    bit once: `caregiver_invitation` compared an injected-clock `expires_at` against a wall-clock
    `created_at`, and the shortest permitted lifetime became unsatisfiable the day after the test
    was written. If a time-related test starts failing on a date nobody changed anything on, look
    here first (DEC-024).
13. Heredocs in this environment collapse `\\` to `\`, so a `\uXXXX` escape written that way lands
    as a real control character - the corruption trap 7 warns about, arriving by a second route.
    Build such escapes with `String.fromCharCode(92)` instead, and re-scan afterwards.
14. `PERMISSION_DENIED` maps to **404**, not 403, so the API is not an existence oracle for IDs.
    A new test asserting 403 for an unauthorized caller is asserting the wrong thing. 403 belongs
    to `STEP_UP_REQUIRED` alone.
15. Do not give the owner a second notification dial. Every recipient already has a personal
    preference, so an `owner_detail` on the profile policy would be two answers to one question
    (DEC-025). The caregiver ceiling is about other people's devices and does not apply to them.
