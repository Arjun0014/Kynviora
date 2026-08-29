# Kynviora - Work Log

Chronological engineering journal. Meaningful activity only.

---

## 2026-08-29 - Session 1

### Reconnaissance and specification reading

- Repository contained only `KYNVIORA_PROJECT_SPEC/` (27 files, ~250KB). No prior implementation,
  no Git repository.
- Read all 27 specification files completely.
- Toolchain: Node 22.14, npm 10.9, Python 3.13, Git 2.46. **No Docker.** Windows 11.
- Created the Git repository and tagged `baseline-spec-only` before any change.

### Research (Step C)

Recorded in `RESEARCH.md`. Four findings changed the implementation:

- **R-001**: Expo SDK 57 / RN 0.86 confirmed real and current (`expo@57.0.18` on npm; SDK 57
  released 2026-06-30). The spec baseline is accurate, not aspirational. Adopted unchanged.
- **R-002**: `expo-sqlite` has first-party SQLCipher support via a `useSQLCipher` config flag.
  Chosen over `op-sqlite` for fewer native dependencies.
- **R-003**: **The most consequential finding.** Tested PGlite empirically rather than trusting a
  search answer. It runs genuine PostgreSQL 18.3 in WASM with full `CREATE ROLE`, `SET ROLE`,
  `GRANT`, and RLS support. Critically, the same test confirmed that querying as `postgres`
  returned **all rows despite `FORCE ROW LEVEL SECURITY`** - superusers bypass RLS entirely. That
  observation directly produced DEC-005 and the harness guard.
- **R-004/R-005**: Salicylic acid is an ideal Lens fixture - simultaneously RESTRICTED +
  CONCENTRATION_LIMIT + USE_CONDITION + AGE_OR_ROUTE_CONDITION in the EU, with no matched US
  cosmetic prohibition. It demonstrates both hard rules at once. **However**, the EU Annex fetch
  returned no extractable content and the FDA URL in spec `26` returned **HTTP 404**. The facts
  therefore rest on search summaries, which produced DEC-016 and `BLK-004`.

### Stage 0 - foundation

- npm workspaces monorepo, strict TypeScript, ESLint type-checked, Prettier, Vitest.
- Custom lint rule making a bare `new Date()` an error in production code, protecting assessment
  replay.
- Domain package with zero runtime dependencies: controlled vocabularies as closed unions,
  branded IDs across the eight product layers, append-only field assertions, `Untrusted<T>`
  quarantine.
- **Problem encountered**: writing files containing literal control characters via heredoc
  corrupted several source files (they became binary). Fixed by rewriting the affected lines with
  `\uXXXX` escapes via a small Node script. Noted in `STATUS.md` as a trap.
- 88 tests. Committed.

### Stage 1 - identity persistence and authorization

- Migrations `0001` (roles, request context, audit) and `0002` (users, households, profiles,
  caregiver grants, consent).
- Two non-superuser database roles: `kynviora_app` for user requests under full RLS, and
  `kynviora_service` for privileged operations. The app role holds no write grant on shared or
  privileged tables.
- PGlite harness with a guard that fails any test not running as the expected non-superuser role.
- **Finding while testing**: four tests failed because the GRANT layer denied UPDATE/DELETE
  _before_ the append-only trigger fired. This was better than expected - append-only is enforced
  at two independent layers. Rewrote the tests to assert both, running the trigger check as the
  table owner to bypass the grant layer and isolate it.
- **Finding**: a consent-withdrawal test was non-deterministic because both rows shared the same
  transaction `now()`. Corrected the test to order by the supersession link, which is the
  authoritative ordering and the reason DEC-013 stores it explicitly.
- 31 database tests including threats A1 and A2. Committed.

### Stage 3/5 - Living Catalog engine

- Migration `0003`: eight product layers as separate tables, shared catalog readable but not
  writable by the app role, evidence assets private to the contributor, a contributor-free
  corroboration view.
- GTIN validation, ingredient parsing and normalization, order-sensitive fingerprinting, conflict
  resolution, corroboration policy.
- **Bug found by test**: a comma-decimal concentration such as "1,5%" (common on European and
  Indian labels) was split on the comma as a list separator, producing a phantom ingredient _and_
  losing the concentration - the exact datum a concentration-limited rule needs. Fixed with a
  deterministic rule: a comma directly between two digits is a decimal separator.
- **Design gap found by test**: three conflict tests failed because a fingerprint match
  short-circuited to `REUSE_EXISTING` without checking scalar fields. For a _degraded_ medicine
  fingerprint (no structured strength extracted), two packs of different strengths can share a
  hash. Made the scalar cross-check load-bearing before reuse.
- **Modelling smell surfaced by lint**: `Jurisdiction | string` for market. Introduced
  `MarketCode` as a distinct branded type with `jurisdictionsForMarket()`, where GB maps to
  **both** GB and NI. Recorded as DEV-002.
- 91 catalog tests. Committed.

### Stage 6/7 - regulatory registry, Citation Gate, Lens

- Registry record types with multi-status rules, structured conditions, supersession, and
  scientific opinions as a structurally distinct type.
- Citation Gate as a pure function with 19 stable failure codes. Refuses informational databases
  and search/LLM output as legal-status sources, and refuses an APPROVED record with no named
  reviewer.
- Lens projection enforcing all four hard rules.
- Fixtures ship gate-rejected per DEC-016, with a test asserting every shipped fixture is refused.
- 72 tests, all passing first run. Committed.

### Stage 6.5 - safety rule engine

- Pure, versioned, replayable. `evaluationInstant` is an argument rather than a clock read, which
  is what makes expiry evaluation reproducible.
- Evidence level copied verbatim from the human-authored rule; `maxUrgency` is a ceiling that
  evaluation can lower but never raise. No `upgradeUrgency` export exists, and a test asserts it.
- Batch matching: a known-unaffected lot produces no alert at all; an unknown lot produces
  PROBABLE with reduced urgency.
- Unimplemented rule kinds return a non-match rather than shipping a placeholder that could fire.
- 42 tests. Committed.

### Section 47 vertical slice

- One executable test walking profile to capture to observation to formulation resolution to
  normalization to regulatory lookup to assessment to result, covering all seven section 31
  scenarios.
- **Bug found by scenario 5**: `limitationsFor` emitted "this package does not disclose the
  concentration" whenever applicability was CONDITION_UNKNOWN and a concentration limit existed -
  including when the concentration _was_ printed and the intended age was the actually-unknown
  condition. A factually wrong statement about the user's own package, on the screen spec `09`
  requires to be most precise.
  Fixed by making `determineApplicabilityDetailed` evaluate conditions exhaustively instead of
  short-circuiting, and report which specific conditions are unresolved. The Lens entry now
  exposes `unresolvedConditions` so a screen can prompt for the exact missing datum.
- **Also found**: the fixture GTINs were not check-digit valid; the barcode validator would have
  rejected them. Corrected to valid EAN-13 values using India's 890 GS1 prefix.
- 36 tests. Committed.

### State at end of session 1

388 tests passing, typecheck clean, lint clean, 6 commits plus the baseline tag.

**Next**: migrations `0004`-`0006` (owned items, source/regulatory persistence, assessments) with
RLS tests, then the ingestion adapter framework, then the API service, then the Expo app.
