# Kynviora - Status

**Resume checkpoint.** Read this first on any autonomous restart, then `git log`, then the tail
of `WORKLOG.md`, then `BLOCKERS.md`.

Last updated: 2026-08-29

---

## Current position

|                          |                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------- |
| **Current stage**        | Stage 6 (sources, registry, evidence, safety engine)                             |
| **Current phase**        | 6.2 - immutable source preservation and change detection                         |
| **Last completed phase** | 6.5 - deterministic rule engine; plus the section 47 vertical slice              |
| **Branch**               | `master`                                                                         |
| **Latest commit**        | `feat(fixtures): end-to-end vertical slice proving all seven required scenarios` |
| **Baseline tag**         | `baseline-spec-only` (spec-only state before the rebuild)                        |

## Verification state

- **388 tests passing**, 0 failing, across 13 files.
- `npx tsc --noEmit` clean under strict TypeScript.
- `npx eslint .` clean.
- Database tests execute against real PostgreSQL 18.3 via PGlite, as a non-superuser role.

Run everything with:

```bash
npm run verify
```

## What is genuinely built and tested

| Area                                                                       | State                                      |
| -------------------------------------------------------------------------- | ------------------------------------------ |
| Domain vocabularies, IDs, provenance, untrusted quarantine                 | Complete, 88 tests                         |
| Identity/household/profile/consent schema + RLS                            | Complete, 31 tests incl. threats A1 and A2 |
| Living Catalog schema                                                      | Complete (migration `0003`)                |
| Catalog engine (GTIN, normalization, fingerprint, conflict, corroboration) | Complete, 91 tests                         |
| Regulatory registry, Citation Gate, Lens projection                        | Complete, 72 tests                         |
| Deterministic safety rule engine with replay                               | Complete, 42 tests                         |
| End-to-end vertical slice, 7 required scenarios                            | Complete, 36 tests                         |

## Known failing tests

None.

## Active blockers

See `BLOCKERS.md` for detail. Summary:

| ID      | Class                               | Blocks                                                   |
| ------- | ----------------------------------- | -------------------------------------------------------- |
| BLK-001 | `EXTERNAL_SERVICE`                  | Managed Postgres/Supabase parity                         |
| BLK-002 | `ENVIRONMENT`                       | On-device encrypted storage verification; all device E2E |
| BLK-003 | `EXTERNAL_CREDENTIAL` + `LICENSING` | GS1/provider identity resolution                         |
| BLK-004 | `DATA_AVAILABILITY`                 | Publishing any regulatory status as trusted              |
| BLK-005 | `LEGAL_REVIEW`                      | Source snapshot retention                                |
| BLK-006 | `CLINICAL_REVIEW` + `LEGAL_REVIEW`  | Publishing any safety rule; public beta                  |
| BLK-007 | `EXTERNAL_CREDENTIAL`               | Real OCR/multimodal extraction                           |
| BLK-008 | `DATA_AVAILABILITY`                 | Every numeric release threshold (Stage 9.1)              |

None of these stops further work; each has a port, a local adapter, and documented
configuration requirements.

## Immediate next task

**Migration `0004`** - owned items and the Shelf, plus `0005` for source/regulatory persistence
and `0006` for safety assessments, each with RLS policies and negative authorization tests
following the pattern already established in `db/migrations.test.ts`.

## Next three planned tasks

1. Ingestion adapter framework (Phase 6.2): fetch -> snapshot -> checksum -> change detection ->
   candidate extraction, with a replayable fixture adapter so the pipeline is exercised without
   fabricating a live CDSCO integration.
2. API service (`services/api`): Fastify + Zod implementing the `13` resource contract, with
   authorization, idempotency keys, body limits and cursor pagination.
3. Expo mobile app: accessibility foundation first (Phase 0.3 - typography scale, 48dp targets,
   status components that never rely on colour alone), then the Shelf and Safety surfaces.

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

## Traps to avoid on resume

1. Do not add a conversion between `EvidenceLevel` and `ActionUrgency`, or any aggregate score.
   Several tests assert none exists.
2. Do not add a `UK` jurisdiction. GB and NI are separate by design.
3. Do not promote a regulatory fixture to `PUBLISHED` outside the explicitly-named test helper.
4. Do not write an authorization test that runs as `postgres` - it will pass vacuously. The
   harness guard catches this, but only if you use `asUser`/`asService`.
5. Do not introduce `new Date()` in production code; the lint rule will reject it and it breaks
   assessment replay.
6. Writing files with literal control characters or unusual Unicode via heredoc has repeatedly
   corrupted source files in this environment. Use `\uXXXX` escapes in source.
