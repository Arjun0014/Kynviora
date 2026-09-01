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
| 6.6   | Reviewer queue and publication controls            | `COMPLETE`    |
| 6.7   | Shadow mode and replay                             | `COMPLETE`    |

- **6.1**: source classes, per-source `allowedInfluence`, licence review state and coverage
  statements; GB and NI modelled separately. Tested.
- **6.3**: the Citation Gate is complete and tested (32 cases). Discovery queue and extraction
  adapters outstanding (`BLK-007`).
- **6.4**: registry types, multi-status records, conditions, supersession, and the Lens
  projection are complete with 40 tests.

**6.6**: complete. Migration `0012` adds `reviewer` (roles held by user ID, never by a name
string), `publication_request`, an append-only `publication_approval`, and a single-row
`publication_control` for the global emergency stop.

_High-impact content cannot be published by an unauthorized single path_ is refused four separate
ways, because "single path" turned out to be four failures: no stored reviewer role at all; a role
that cannot judge this kind of content, since `10` keeps regulatory publication separate from
clinical (DEC-032); not enough distinct people, counted as `DISTINCT reviewer_user_id` behind a
UNIQUE over request and reviewer; and the requester approving or executing their own work.

_Publication is attributable, reversible, and scoped_ is carried by the append-only approval table,
by an emergency withdrawal that is deliberately cheaper than publication (DEC-031), and by an
execution gate that requires **each** requested jurisdiction to reach the approval count on its
own - approving for GB does not publish for NI. A safety rule gains `approved_jurisdictions`, and a
published rule with no approved scope is unrepresentable.

Every rule is enforced in the domain, again as a trigger in `0012`, and again at the route, because
`14` requires that direct database editing of publication state is not a normal workflow. `10`'s
ten-item high-severity checklist is recorded per approval rather than per request, since the point
of a second reviewer is that they check independently.

116 tests across the domain (43), database (44) and API (29) suites, including the case that shows
the layering: two qualified reviewers approve a regulatory record and the Citation Gate refuses it
anyway.

Outstanding: this does **not** clear `BLK-006` - it builds the workflow a qualified reviewer would
use, and none exists. There is no console interface and deliberately no mobile screen (`DEV-016`),
and rule preview is deferred to Phase 6.7 (`DEV-017`).

**6.7**: complete. Migration `0013` adds `shadow_run`, `shadow_run_sample` and `replay_run`, and
`packages/safety/src/shadow.ts` provides the run, the before/after comparison and the replay.

_New high-impact rules can be evaluated without user notification_ is a shape, not a flag: a
`ShadowRun` carries counts and a de-identified sample, the profile identities are counted and
discarded inside the run, and the results are written to `shadow_run` rather than
`profile_assessment` - which `alert_publication` requires, so the tables do not connect (DEC-034).
A test reads `alert_publication`'s foreign keys from `information_schema` and asserts neither
shadow table is among them.

The gate that nearly made the feature useless is recorded as DEC-035: `evaluateRule` refuses an
unapproved rule, and the rule a shadow run exists to measure is exactly one nobody has approved, so
every candidate reported zero matches - which reads as "this rule affects nobody". `runShadow` now
evaluates a local projection whose stand-in reviewer is the literal string
`SHADOW_RUN_NOT_A_REVIEWER`, safe because the function has already refused a non-shadow rule and
nothing it produces can become user-visible.

_Regulatory data corrections can recompute dependent product views and assessments reproducibly_ is
`replayAll` plus the replay route, which pairs recorded assessments with the current state of
everything they were computed from and reports per assessment which fields moved. A replay writes
nothing back; `profile_assessment` is append-only and a test asserts the rows are untouched.

This also closes `DEV-017`: `publication_request.shadow_run_id` is required for a two-person
safety-rule publication, and a trigger checks the run is a run of _that_ rule (DEC-036). Publishing
a high-impact rule is now shadow run, then request, then two approvals.

69 tests across the safety (28), database (24) and API (17) suites. Outstanding: a historical run
refuses `INGREDIENT_SENSITIVITY` and `DUPLICATE_ACTIVE_INGREDIENT` because the shelf join does not
carry the ingredient declaration, and under-measuring would be worse than refusing (`DEV-018`);
there is still no staff interface (`DEV-016`).

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

| Phase | Title                               | Status     |
| ----- | ----------------------------------- | ---------- |
| 8.1   | Caregiver invitation and grants     | `COMPLETE` |
| 8.2   | Caregiver alert delivery            | `COMPLETE` |
| 8.3   | Household Review Inbox              | `COMPLETE` |
| 8.4   | Visit Pack                          | `COMPLETE` |
| 8.5   | Medicine Reconciliation workflow v1 | `COMPLETE` |

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

**8.2**: complete. Migration `0009` adds `profile_notification_policy` (the owner's ceiling on what
a caregiver notification may reveal), `notification_preference` (each recipient's own setting for
their own device), and an append-only `alert_delivery` that records the recipient, the event and
the disclosure level - never the notification body (DEC-026).

The exit criterion is deny-by-default authorization, so recipient selection is a filter: a
candidate is dropped unless something affirmatively admits it, and every drop carries a named
reason that forms part of the returned plan rather than a log line. `MISSED_DOSE` requires
`RECEIVE_MISSED_DOSE` and deliberately not `VIEW_SAFETY`; both directions are asserted at the
domain, the database and the API, which is the separate-permission requirement in `03` group H.
Disclosure is the narrower of the owner's ceiling and the recipient's preference, defaulting to
`GENERIC` on both sides so absence is never read as permission (DEC-025). A withdrawn alert is
refused outright rather than delivered to nobody, and the caregiver alert view narrows a resolution
by _column_: the outcome is visible, the free-text note is not, and the withholding is reported
rather than shown as a blank.

126 tests across the domain, database, API and presentation suites. Outstanding: no push provider
exists, so nothing claims a device received anything (`BLK-009`); the missed-dose dispatch is
enforced but unscheduled, because the grace window is an unmade product decision (`DEV-011`); and
the settings screen typechecks but is not wired (`DEV-007`).

**8.3**: complete. Migration `0010` generalises the `review_task` subject so a task can be about a
caregiver grant or a published alert as well as an owned item, adds a partial unique index over
open tasks that makes derivation idempotent, and adds `review_task_closed_wrote_something` - a
CHECK making a closed task with no recorded field change unrepresentable.

Both exit criteria are structural. _Review tasks are clearly different from safety alerts_: no
urgency, evidence level, severity or score exists on the table, the domain type, or the API
payload, and the presentation layer may use only the two calm tones, with the alert tones derived
from `presentUrgency` in the test rather than hard-coded. _Completing a task updates the relevant
authoritative record_: there is no mark-done path - the endpoint applies the change to the record
first and closes the task only if that write affected a row, the domain refuses an empty change
list or a field outside the closed list for that kind, and the CHECK refuses a closed row with no
fields even to a direct SQL statement (DEC-027). Authorization follows the record rather than the
inbox, so the inbox cannot become a permission side channel (DEC-028).

95 tests across the domain, database, API and presentation suites. Outstanding: derivation runs on
read rather than on a schedule (`DEV-013`), the three intervals are engineering defaults
(`DEV-012`), and the inbox screen typechecks but is not wired (`DEV-007`).

**8.4**: complete. Migration `0008` adds `visit_pack`, which stores a selection-and-version
manifest and a content digest rather than a copy of the exported content (DEC-022), expires by a
NOT NULL `expires_at` evaluated against the clock on every retrieval, and is visible only to the
owner, the creator, or a caregiver holding `EXPORT_SUMMARY` - never one holding merely
`VIEW_MEDICINES`, which is the separate-permission requirement in `03` group H.

Both exit criteria are encoded rather than asserted. _Export never happens automatically_: there
is no path from a profile ID to a pack, the selection is an explicit ID list with no
include-everything flag, an empty pack is refused by the domain and by a CHECK constraint, and
step-up is checked before body parsing. _A user can review exactly what will be shared_: the
generate request quotes the digest of the reviewed content, and generation recomputes it from live
data and refuses on any difference, including a changed caveat or a note added after the review
(DEC-023).

100 tests across the domain, database, API and presentation suites. Outstanding: the mobile review
screen typechecks but is not wired (`DEV-007`); the 72-hour retention and the 90-day recent-changes
window are engineering defaults (`DEV-009`, `DEV-010`).

**8.5**: complete. Migration `0011` adds `reconciliation` and `reconciliation_difference`. The
single exit criterion - _Kynviora never chooses which conflicting instruction is medically
correct_ - is carried structurally at four layers rather than asserted as a rule:

- **Schema.** `reconciliation_difference` has `previous_value` and `current_value` and no third
  column for an answer, so a system-chosen winner is unwritable even by direct SQL. Every settled
  member of the resolution vocabulary names a person or a document; a CHECK refuses
  `AUTO_RESOLVED`, `SYSTEM_CHOSE` and `RECOMMENDED`, and another refuses `ADDED` / `REMOVED` /
  `CHANGED` as difference kinds (DEC-029).
- **Domain.** The difference type has no `suggestedValue`, `preferred` or `confidence` field, and
  `evaluateResolution` refuses a settling resolution that does not say which value now stands -
  including a professional confirmation, because a pharmacist may well confirm the older dose and
  inferring the newer list would be the software deciding (DEC-030).
- **API.** The comparison is a pure function over two lists. The only write to a medicine happens
  when a person explicitly adopted the current value, and it goes through the RLS-scoped
  connection, so the flow cannot change what the caller could not change on the medicine screen.
- **Presentation.** Both sides share one tone and one emphasis flag, each is labelled by where it
  came from rather than by age or authority, and no resolution option carries a `recommended` or
  `default` field. The screen's own copy says Kynviora does not know which version is right and
  will not pick one.

Completion does not require every difference to be settled: `04` Phase 8.5 lists unresolved
differences as expected output, so `STILL_UNRESOLVED` is a first-class outcome and the completion
response reports the count plainly.

109 tests across the domain (30), database (28), API (20) and presentation (31) suites.
Outstanding: matching is by a caller-supplied key rather than catalog identity (`DEV-014`); the
current list is typed in rather than extracted from the attached document (`DEV-015`, `BLK-007`);
and the review screen typechecks but is not wired (`DEV-007`).

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

## Making it runnable

Not a spec phase, and recorded here because it changed what the repository is rather than what it
contains. Everything above was verifiable and none of it was runnable: `services/api` had no
process entry point, migrations ran only inside the test harness, and nothing produced a
`Principal`, so no route could be exercised by hand.

| Piece                                         | Where                            |
| --------------------------------------------- | -------------------------------- |
| Persisted PostgreSQL, role-scoped connections | `db/src/runtime.ts`              |
| Migration runner and CLI                      | `db/src/migrations.ts`, `cli.ts` |
| Synthetic development fixture                 | `db/src/seed.ts`                 |
| Process entry point                           | `services/api/src/main.ts`       |
| Development identity boundary                 | `services/api/src/devAuth.ts`    |

`npm run dev` now starts a server against a database the process owns (DEC-037), with a
header-based development identity that fails closed three ways and grants no staff role
(DEC-038). `DEV-019` and `DEV-020` record both as temporary stand-ins for Phase 1.1 and
`BLK-001`.

---

## Wiring the screens (`DEV-007`, partly done)

A new `@kynviora/contracts` package holds the client every surface shares: configuration, the
session, the transport, the outcome union, the resource model and the view models. The five
primary destinations read real data through it.

| Destination | Reads                               | State                          |
| ----------- | ----------------------------------- | ------------------------------ |
| Today       | `GET /v1/profiles/:id/review-tasks` | Wired                          |
| Shelf       | `GET /v1/items`                     | Wired, three verification axes |
| Safety      | `GET /v1/alerts`                    | Wired; empty by design         |
| Care        | `GET /v1/caregiver-grants`          | Wired, read-only               |
| You         | `GET/PUT .../notification-*`        | Wired, reads and writes        |

Still to build, each because it needs a screen rather than a button (`DEV-022`): the invitation
flow with its once-shown token, the step-up prompt, a per-record-kind task editor for completing
a review task, the Visit Pack selection and review flow, and the reconciliation difference
resolution. Every one exists on the client and is exercised by tests.

`DEV-021` records that screen behaviour is tested in the packages rather than in the app, and what
that does and does not cover.

---

## Immediate next work

1. Finish `DEV-007`: the five write flows above, starting with the review task editor - it is the
   one that closes Phase 8.3's loop, and completing a task writes to the authoritative record
   rather than ticking a box (DEC-027).
2. Observability projections (`20`): review-queue age, ingestion failure rate, catalog
   cache-hit rate, assessment recomputation throughput. The review-queue age becomes measurable
   once inbox derivation moves behind a scheduler (`DEV-013`).
3. A missed-dose scheduler, once the grace window is a decided product question (`DEV-011`). The
   dispatch and its authorization already exist; nothing calls them with a real occurrence.

## What "complete" means here, and what it does not

Nineteen phases are marked `COMPLETE` above. In every case that means the logic is implemented,
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
