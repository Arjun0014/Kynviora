# Kynviora - Status

**Resume checkpoint.** Read this first on any autonomous restart, then `git log`, then the tail
of `WORKLOG.md`, then `BLOCKERS.md`.

Last updated: 2026-08-29

---

## Current position

|                    |                                                               |
| ------------------ | ------------------------------------------------------------- |
| **Current stage**  | Stage 4 (medicine care workflows)                             |
| **Current phase**  | 4.1 - medicine schedule model                                 |
| **Last completed** | Mobile app shell; presentation layer; API boundary; ingestion |
| **Branch**         | `master`                                                      |
| **Latest commit**  | `feat(mobile): Expo SDK 57 app shell with encrypted store...` |
| **Baseline tag**   | `baseline-spec-only`                                          |

## Verification state

- **962 tests passing**, 0 failing, across 19 files.
- `npm run verify` runs typecheck, mobile typecheck, lint, format check and the full suite,
  chained with `&&` so no gate can be silently skipped.

```bash
npm run verify
```

- Database tests execute against real PostgreSQL 18.3 via PGlite as a non-superuser role.
- The mobile app typechecks against the real Expo SDK 57 / RN 0.86 / React 19.2 toolchain.

## What is genuinely built and tested

| Area                                                        | State                                     |
| ----------------------------------------------------------- | ----------------------------------------- |
| Domain vocabularies, IDs, provenance, untrusted quarantine  | Complete, 94 tests                        |
| Database schema, 6 migrations, full RLS                     | Complete, 96 tests incl. threats A1/A2/A3 |
| Catalog engine (GTIN, normalization, fingerprint, conflict) | Complete, 91 tests                        |
| Regulatory registry, Citation Gate, Lens                    | Complete, 72 tests                        |
| Deterministic safety rule engine with replay                | Complete, 42 tests                        |
| Ingestion pipeline with hostile-source defences             | Complete, 37 tests                        |
| Presentation layer, accessibility tokens, safety copy       | Complete, 436 tests                       |
| API boundary (Fastify), RLS-scoped context                  | Complete, 36 tests                        |
| End-to-end vertical slice, 7 required scenarios             | Complete, 36 tests                        |
| Mobile app shell, encrypted store, accessible primitives    | Typechecks; **not device-verified**       |
| CI pipeline                                                 | Written; not yet run on a real runner     |

## Known failing tests

None.

## Active blockers

See `BLOCKERS.md`. None of them stops further work; each has a port, a local adapter, and
documented configuration requirements.

| ID      | Class                               | Blocks                                      |
| ------- | ----------------------------------- | ------------------------------------------- |
| BLK-001 | `EXTERNAL_SERVICE`                  | Managed Postgres/Supabase parity            |
| BLK-002 | `ENVIRONMENT`                       | On-device encryption proof; all device E2E  |
| BLK-003 | `EXTERNAL_CREDENTIAL` + `LICENSING` | GS1/provider identity resolution            |
| BLK-004 | `DATA_AVAILABILITY`                 | Publishing any regulatory status as trusted |
| BLK-005 | `LEGAL_REVIEW`                      | Source snapshot retention                   |
| BLK-006 | `CLINICAL_REVIEW` + `LEGAL_REVIEW`  | Publishing any safety rule; public beta     |
| BLK-007 | `EXTERNAL_CREDENTIAL`               | Real OCR/multimodal extraction              |
| BLK-008 | `DATA_AVAILABILITY`                 | Every numeric release threshold (Stage 9.1) |

## Immediate next task

**Medicine schedule engine** (Phase 4.1). Spec 19 requires "Schedule calculation has
deterministic tests", and spec 04 Phase 4.1 requires fixed-time and selected-day patterns,
as-needed separated from fixed reminders, written instructions preserved as source text, and
explicit time-zone handling. The schema already constrains the shape (migration `0004`); the
computation is the missing piece.

## Next three planned tasks

1. Sync protocol (`13`): pending-operation journal, cursor pull, per-entity conflict policy.
   Dose events merge by event ID; caregiver grants and safety assessments are server-wins;
   product confirmation creates a new assertion rather than overwriting.
2. Caregiver invite/accept/revoke service (Phase 8.1) with step-up on sensitive grant changes,
   plus Visit Pack generation (Phase 8.4).
3. Reviewer console publication workflow (Phase 6.6): two-person approval, emergency withdrawal,
   immutable audit.

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
