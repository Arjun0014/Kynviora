# Kynviora - Implementation Plan

Backbone: `04_STAGES_AND_PHASES.md`. Every phase in that document appears here; none is omitted.
Technical ordering is adjusted for dependency reasons where noted (see `DEV-004`).

**Status values**: `NOT_STARTED` / `IN_PROGRESS` / `BLOCKED_EXTERNAL` / `BLOCKED_TECHNICAL` /
`COMPLETE`

`COMPLETE` means implemented **and** tested **and** documented **and** committed. A phase whose
exit criteria depend on a device, a credential, a labelled dataset, or a qualified human reviewer
is marked `BLOCKED_EXTERNAL` even when all buildable work is finished - it is not marked complete.

---

## Stage 0 - Reset, Product Contract, Engineering Foundation

| Phase | Title                                             | Status        |
| ----- | ------------------------------------------------- | ------------- |
| 0.1   | Repository reset and toolchain                    | `COMPLETE`    |
| 0.2   | Product and safety contract                       | `COMPLETE`    |
| 0.3   | Design and accessibility foundation               | `IN_PROGRESS` |
| 0.4   | Domain contracts and data-classification baseline | `COMPLETE`    |

### 0.1 - Repository reset and toolchain

- **Done**: npm workspaces monorepo; strict TypeScript (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`); ESLint type-checked with a custom rule
  banning ambient `new Date()`; Prettier; Vitest; `.env.example` separating server secrets from
  `EXPO_PUBLIC_` config; directory boundaries for domain / contracts / catalog / regulatory /
  safety / ingestion / fixtures / services / db.
- **Outstanding**: CI workflow file; Expo app scaffold; development-build workflow.
- **Exit criteria blocked**: "Android development build launches on emulator/device" - `BLK-002`.

### 0.2 - Product and safety contract

- Controlled vocabularies implemented as closed unions with exhaustiveness checking. Evidence
  level and action urgency are separate types with no conversion between them anywhere in the
  codebase. No feature depends on an undefined "AI decides" behaviour: `17`'s boundary is encoded
  as the `Untrusted<T>` type plus the Citation Gate.
- **Evidence**: `packages/domain/src/vocabulary.ts` and its 40+ tests.

### 0.3 - Design and accessibility foundation

- **Not started.** Typography/spacing scale, 48dp touch targets, status components that never
  rely on colour alone, and the Today/Shelf/Safety/Care/You navigation shell.

### 0.4 - Domain contracts and data-classification baseline

- Branded entity IDs across all eight product layers; provenance model with append-only field
  assertions and supersession; audit event taxonomy; local-vs-server authority recorded in
  `DEC-010`; sensitive-data classification encoded in the RLS grants.

---

## Stage 1 - Identity, Profiles, Consent, Session Boundary

| Phase | Title                                | Status        |
| ----- | ------------------------------------ | ------------- |
| 1.1   | Authentication and session lifecycle | `NOT_STARTED` |
| 1.2   | Household and profile creation       | `IN_PROGRESS` |
| 1.3   | Health-context facts and provenance  | `NOT_STARTED` |
| 1.4   | Consent and privacy controls         | `IN_PROGRESS` |

- **1.2**: schema, RLS policies and the full authorization test suite are complete
  (threat A1 and A2 covered). API and UI surfaces outstanding.
- **1.4**: `consent_receipt` is append-only with supersession-based withdrawal and is tested.
  Consent _enforcement_ wiring and the export/deletion shell are outstanding.
- **1.1**: blocked on an auth provider decision (`23` lists it as required before Stage 1
  completion) - the schema deliberately holds no password hash, delegating to a managed provider.

---

## Stage 2 - Unified Health Shelf and Item Lifecycle

| Phase | Title                      | Status        |
| ----- | -------------------------- | ------------- |
| 2.1   | Shared Shelf framework     | `NOT_STARTED` |
| 2.2   | Manual medicine entry      | `NOT_STARTED` |
| 2.3   | Manual personal-care entry | `NOT_STARTED` |
| 2.4   | Product Trust Passport v1  | `COMPLETE`    |

Depends on the owned-item schema (migration `0004`, not yet written) and the mobile shell (0.3).
The Trust Passport's underlying data - identity/formulation/batch verification kept separate,
corroboration state, coverage statement - already exists in the domain and catalog layers.

---

## Stage 3 - Guided Capture, Extraction, Living Catalog Bootstrap

| Phase | Title                                               | Status        |
| ----- | --------------------------------------------------- | ------------- |
| 3.1   | Barcode capture and normalization                   | `COMPLETE`    |
| 3.2   | Guided package capture and quality gate             | `COMPLETE`    |
| 3.3   | Dual extraction and field assertions                | `COMPLETE`    |
| 3.4   | Cache-first resolver and source-grounded fallback   | `NOT_STARTED` |
| 3.5   | Living Catalog candidate creation and corroboration | `COMPLETE`    |
| 3.6   | Formulation conflict and change detection           | `COMPLETE`    |

- **3.1**: GTIN validation with GS1 check digits is complete and tested. Camera permission flow
  and duplicate-scan handling await the mobile shell.
- **3.3**: the assertion model, agreement/disagreement state, and the rule that unconfirmed
  machine provenance is never trusted are complete and tested. Actual OCR/vision engines are
  `BLK-007`.
- **3.5 / 3.6**: complete as pure logic with full test coverage, including the reformulation
  scenario that must never overwrite history, and A11 poisoning resistance.

---

## Stage 4 - Medicine Care Workflows

| Phase | Title                             | Status              |
| ----- | --------------------------------- | ------------------- |
| 4.1   | Medicine schedule model           | `COMPLETE`          |
| 4.2   | Local reminder engine             | `BLOCKED_TECHNICAL` |
| 4.3   | Dose events and adherence history | `NOT_STARTED`       |
| 4.4   | Refill awareness                  | `COMPLETE`          |

**4.2** exit criteria require measuring reminder reliability across process death and device
restart, which needs a device (`BLK-002`).

---

## Stage 5 - Personal-Care Formulation Intelligence

| Phase | Title                                            | Status             |
| ----- | ------------------------------------------------ | ------------------ |
| 5.1   | Ingredient declaration model                     | `COMPLETE`         |
| 5.2   | Canonical ingredient/substance normalization     | `IN_PROGRESS`      |
| 5.3   | Formulation fingerprints and version history     | `COMPLETE`         |
| 5.4   | Narrow sensitivity/allergy vocabulary            | `BLOCKED_EXTERNAL` |
| 5.5   | Personal-care verification and formula-change UX | `NOT_STARTED`      |

- **5.1**: raw declaration preserved, ordered token parsing, unknown ingredients retained as
  `UNRESOLVED`. Tested including comma-decimal concentrations and multi-script separators.
- **5.2**: normalization engine and alias resolution complete; the seeded vocabulary itself needs
  a licensed source (`BLK-003`).
- **5.4**: exit criterion is "The matching vocabulary has clinical/product-safety review" -
  `BLK-006`.

---

## Stage 6 - Global Sources, Regulatory Registry, Evidence, Safety Engine

| Phase | Title                                              | Status        |
| ----- | -------------------------------------------------- | ------------- |
| 6.1   | Source registry and authority hierarchy            | `COMPLETE`    |
| 6.2   | Immutable source preservation and change detection | `COMPLETE`    |
| 6.3   | AI-assisted discovery, extraction, Citation Gate   | `IN_PROGRESS` |
| 6.4   | Global Regulatory Registry                         | `COMPLETE`    |
| 6.5   | Deterministic rule engine and assessment inputs    | `IN_PROGRESS` |
| 6.6   | Reviewer queue and publication controls            | `NOT_STARTED` |
| 6.7   | Shadow mode and replay                             | `NOT_STARTED` |

- **6.1**: source classes, per-source `allowedInfluence`, licence review state and coverage
  statements; GB and NI modelled separately. Tested.
- **6.3**: the Citation Gate is complete and tested (32 cases). Discovery queue and extraction
  adapters outstanding (`BLK-007`).
- **6.4**: registry types, multi-status records, conditions, supersession, and the Lens
  projection are complete with 40 tests.

---

## Stage 7 - Safety Watch and Global Regulatory Lens Experience

| Phase | Title                           | Status        |
| ----- | ------------------------------- | ------------- |
| 7.1   | Assessment states and inbox     | `NOT_STARTED` |
| 7.2   | Global Regulatory Lens          | `IN_PROGRESS` |
| 7.3   | Alert detail and explainability | `NOT_STARTED` |
| 7.4   | Evidence and Regulatory Diff    | `IN_PROGRESS` |
| 7.5   | Notification policy             | `NOT_STARTED` |
| 7.6   | Resolution and Safety Receipt   | `NOT_STARTED` |

- **7.2**: the projection and all four hard guarantees are implemented and tested. The UI is
  outstanding. Its exit criterion ("A user can distinguish banned from restricted under
  conditions in usability testing") additionally requires human participants.
- **7.4**: `diffIngredients` provides the formulation half; the regulatory-version diff is
  outstanding.

---

## Stage 8 - Family Collaboration, Review Inbox, Visit Pack

| Phase | Title                               | Status        |
| ----- | ----------------------------------- | ------------- |
| 8.1   | Caregiver invitation and grants     | `COMPLETE`    |
| 8.2   | Caregiver alert delivery            | `NOT_STARTED` |
| 8.3   | Household Review Inbox              | `NOT_STARTED` |
| 8.4   | Visit Pack                          | `NOT_STARTED` |
| 8.5   | Medicine Reconciliation workflow v1 | `NOT_STARTED` |

**8.1**: complete. Migration `0007` adds `caregiver_invitation` with hash-only token storage
(DEC-018), a column-level `GRANT` that keeps the hash unreadable by the app role (DEC-021), and a
partial unique index making two active grants for one pair unrepresentable (DEC-019). The domain
module decides acceptance, decline, delegation and revocation as pure functions; the API exposes
create / accept / decline / revoke-invitation / list-grants / revoke-grant / audit-history, with
step-up on every action that changes access and idempotency keys on create and accept.

Both exit criteria are asserted directly: revocation takes effect on the caregiver next
authenticated request with no sync or token refresh, and a caregiver granted access to one profile
sees an empty page - not a 403 - for another. 149 tests across the domain, database, API and
presentation suites.

Outstanding: the mobile screens are built and typecheck but are not wired to a repository
(`DEV-007`), and the invitation lifetime defaults await product sign-off (`DEV-006`).

---

## Stage 9 - Production Hardening, Validation, MVP Beta

| Phase | Title                                         | Status             |
| ----- | --------------------------------------------- | ------------------ |
| 9.1   | Data-quality and matching validation          | `BLOCKED_EXTERNAL` |
| 9.2   | Security and privacy hardening                | `IN_PROGRESS`      |
| 9.3   | Clinical and content validation               | `BLOCKED_EXTERNAL` |
| 9.4   | Accessibility and senior usability validation | `BLOCKED_EXTERNAL` |
| 9.5   | Store, policy, and legal readiness            | `BLOCKED_EXTERNAL` |
| 9.6   | Staged beta and release observation           | `BLOCKED_EXTERNAL` |

- **9.1**: `BLK-008` - needs a labelled dataset, and `22` requires leadership to set the numeric
  thresholds.
- **9.2**: RLS negative tests are automated and passing. Penetration testing, dependency/secret
  scanning in CI, and MASVS device testing are outstanding.
- **9.3 / 9.4**: require qualified reviewers (`BLK-006`) and human usability participants.
- **9.5**: requires legal and regulatory-classification review.

---

## Immediate next work

1. **Household Review Inbox** (Phase 8.3), which the caregiver grant surface now has the
   authorization model to support.
2. **Visit Pack generation** (Phase 8.4) with explicit content selection, a review screen showing
   exactly what will be shared, step-up before generation, and an audit event that records the
   export without duplicating its contents into logs.
3. **Reviewer console publication workflow** (Phase 6.6): two-person approval where policy
   requires it, emergency withdrawal, and immutable audit.
4. Wire the Expo screens to the API contract, replacing the placeholder empty states with the
   Shelf, Trust Passport and Regulatory Lens surfaces the presentation package already supports.
5. Observability projections (`20`): review-queue age, ingestion failure rate, catalog
   cache-hit rate, assessment recomputation throughput.

## What "complete" means here, and what it does not

Sixteen phases are marked `COMPLETE` above. In every case that means the logic is implemented,
tested, documented and committed - and in most cases the tests execute against a real PostgreSQL
engine or the real Expo toolchain rather than a mock.

It does **not** mean the phase is releasable. Nine phases carry exit criteria that depend on a
device, a credential, a labelled dataset, or a qualified human reviewer, and those are marked
`BLOCKED_EXTERNAL` or `BLOCKED_TECHNICAL` rather than complete even where all buildable work is
finished. `BLOCKERS.md` records what each one needs.

The MVP is complete at the end of Stage 9. It is not close to that, and the largest remaining
gaps are the ones no amount of engineering closes on its own: clinical and regulatory review
(`BLK-006`), verified official source material (`BLK-004`), and a labelled evaluation dataset
with approved numeric thresholds (`BLK-008`).
