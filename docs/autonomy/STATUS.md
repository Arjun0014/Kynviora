# Kynviora - Status

**Resume checkpoint.** Read this first on any autonomous restart, then `git log`, then the tail
of `WORKLOG.md`, then `BLOCKERS.md`.

Last updated: 2026-09-01

---

## Current position

|                    |                                                |
| ------------------ | ---------------------------------------------- |
| **Current stage**  | Stage 6 (governance), after completing Stage 8 |
| **Current phase**  | Wiring the Expo screens to the API (DEV-007)   |
| **Last completed** | Making the stack runnable (not a spec phase)   |
| **Branch**         | `master`                                       |
| **Latest commit**  | `feat(dev): a runnable local stack`            |
| **Baseline tag**   | `baseline-spec-only`                           |

## Verification state

- **1902 tests passing**, 0 failing, across 50 files.
- `npm run verify` runs typecheck, mobile typecheck, lint, format check and the full suite,
  chained with `&&` so no gate can be silently skipped.

```bash
npm run verify
```

- Database tests execute against real PostgreSQL 18.3 via PGlite as a non-superuser role.
- The mobile app typechecks against the real Expo SDK 57 / RN 0.86 / React 19.2 toolchain.
- `main.test.ts` boots real API processes on real ports against a persisted database, so role
  switching, the request GUC and the RLS policies are exercised together rather than mocked.

### Running it

```bash
KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev
```

Migrates, seeds one synthetic household and listens on `127.0.0.1:3000`. The seed prints the user
ID to send as `x-kynviora-dev-user`. Safety and Regulatory Lens are **empty** against this seed on
purpose - `BLK-006` and DEC-016, not a configuration mistake.

## What is genuinely built and tested

| Area                                                       | State                                                |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| Domain vocabularies, IDs, provenance, untrusted quarantine | Complete, 94 tests                                   |
| Database schema, 13 migrations, full RLS                   | Complete, 293 tests incl. threats A1/A2/A3           |
| Catalog engine, capture pipeline, Trust Passport           | Complete, 178 tests                                  |
| Regulatory registry, Citation Gate, Lens                   | Complete, 72 tests                                   |
| Safety rule engine with replay; schedule and refill        | Complete, 88 tests                                   |
| Ingestion pipeline with hostile-source defences            | Complete, 37 tests                                   |
| Presentation layer, accessibility tokens, safety copy      | Complete, 436 tests                                  |
| API boundary (Fastify), RLS-scoped context                 | Complete, 37 tests                                   |
| Offline sync protocol, per-entity conflict policy          | Complete, 43 tests                                   |
| Caregiver invitation, acceptance, revocation, audit        | Complete, 150 tests                                  |
| Visit Pack export, reviewed-content gate, expiry           | Complete, 100 tests                                  |
| Caregiver alert delivery, notification privacy             | Complete, 126 tests; **not sent** (BLK-009)          |
| Household Review Inbox, record-writing completion          | Complete, 95 tests                                   |
| Medicine Reconciliation, two lists and no chosen answer    | Complete, 109 tests                                  |
| Reviewer console: roles, two-person approval, withdrawal   | Complete, 116 tests; **publishes nothing** (BLK-006) |
| Shadow runs, before/after comparison, assessment replay    | Complete, 69 tests                                   |
| End-to-end vertical slice, 7 required scenarios            | Complete, 36 tests                                   |
| Mobile app shell, encrypted store, accessible primitives   | Typechecks; **not device-verified**                  |
| Caregiver, export, notification, inbox, reconciliation UI  | Typecheck; **not wired** (`DEV-007`)                 |
| CI pipeline                                                | Written; not yet run on a real runner                |

Rows are areas, not a partition, and they do not sum to the total. The caregiver, Visit Pack,
alert-delivery, Review Inbox, reconciliation and reviewer-console rows each count tests that
also appear in the
database row, because those features span every layer. The presentation and API rows count only
their own general suites, not the per-feature ones. Per-file counts are reproducible with
`npx vitest run --reporter=json`.

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

**Finish the `DEV-007` write flows.** Today, Shelf, Safety, Care and You now read real data through
the shared client, and the only writes are the notification preference and a dose event. Five
flows remain, and each needs a screen rather than a button (`DEV-022`):

1. The **review task editor**, per record kind. Best first: it closes Phase 8.3's loop, and
   completing a task writes to the authoritative record rather than ticking a box (DEC-027).
2. The **caregiver invitation** screen. The token is shown once and is unrecoverable afterwards
   (DEC-018), and it must never reach a URL, a log or an exception (trap 11).
3. The **step-up prompt**, which revocation and export both need (`14`).
4. The **Visit Pack** selection and review flow, which quotes a digest of exactly what the user
   reviewed (DEC-023).
5. The **reconciliation** difference resolution, where the side is stated by a person (DEC-030).

Alternatively **Phase 4.3** (dose events and adherence history) or **Phase 7.1** (assessment states
and inbox), both fully implementable with no external dependency.

Note what the two governance phases did **not** do: they did not clear `BLK-006`. The reviewer
console is the workflow a qualified reviewer would use and the shadow run is what they would look
at; no qualified reviewer exists, and nothing in the shipped fixtures is publishable.

## Next three planned tasks

1. Observability projections (`20`), including the review-queue age that becomes measurable once
   inbox derivation moves behind a scheduler (`DEV-013`).
2. A staff reviewer console interface, on its own origin and session policy (`DEV-016`). It is
   deliberately not a screen in the Expo app.
3. Phase 7.1 assessment states and inbox, which the shadow and replay machinery now supports.

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
- **DEC-027** - a review task is closed by **writing to the authoritative record**, never by a
  state change. The endpoint applies the change first and closes the task only if it affected a
  row; a CHECK makes a closed task with no recorded field change unrepresentable. There is no
  mark-done path, and "not applicable" writes too.
- **DEC-028** - inbox authorization follows the _record_, not the inbox, so it cannot become a
  permission side channel. The owned-item kinds list both `MANAGE_SHELF` and `MANAGE_MEDICINES`
  because `owned_item_update` narrows by `item_kind` and a task row names only the item ID - the
  domain checks the coarse capability, the database makes the binding decision.

- **DEC-029** - the reconciliation difference vocabulary names a fact about the two _lists_, not a
  change to the medicine. There is no `ADDED`, `REMOVED` or `CHANGED`: "removed" implies someone
  stopped the medicine, and a line missing from a discharge summary may equally mean the summary
  only covered the admission. A CHECK refuses those words as difference kinds.
- **DEC-030** - which value now stands is **stated by a person**, never inferred from recency. A
  professional confirmation carries no side of its own, because a pharmacist may confirm the older
  dose; the screen has to ask. Refused by the domain, by the API and by
  `difference_settled_has_side`.

- **DEC-031** - withdrawal is deliberately cheaper than publication: one reviewer, the requester
  may be that reviewer, the global publication block does not stop it, and no checklist. A
  wrongly-published alert tells someone to act; a wrongly-withdrawn one only removes information.
  Do not "fix" the asymmetry.
- **DEC-032** - the right to approve is a stored `reviewer` row keyed by user ID, and clinical
  and regulatory approval are not interchangeable. A legal-scope reviewer cannot approve a safety
  rule; no clinical role can approve a legal status.
- **DEC-033** - inside the reviewer console, separation-of-duties and role-not-permitted are
  `VALIDATION_FAILED` (400), not `PERMISSION_DENIED`. The 404 rule is about a caller's standing
  to look at all, not about the pairing of a reviewer with a request they can already see.

- **DEC-034** - a shadow run carries counts and de-identified samples and **no recipients**, and
  its results live in `shadow_run` rather than `profile_assessment`. That is what makes "evaluated
  without user notification" structural rather than a flag somebody must remember to check.
- **DEC-035** - `runShadow` satisfies the approval and enabled gates with a _local_ projection,
  because the rule a shadow run measures is by definition one nobody has approved. Safe only
  because the function refuses a non-shadow rule and the output cannot become user-visible. Do not
  generalise it into a parameter on `evaluateRule`.
- **DEC-036** - a two-person safety-rule publication must name a shadow run **of that rule**. The
  trigger checks the pairing, not the presence.

- **DEC-037** - the development database is PGlite persisted to a directory, and the seed runs
  **inside** the API process. PGlite is a single writer: a standalone seed against the same
  directory as a running server does not share its state, and the last process to exit overwrites
  the other. That failed silently once. `RuntimeDb` is the seam a pooled implementation lands
  behind when `BLK-001` clears.
- **DEC-038** - the development authenticator turns a header into an ordinary principal and fails
  closed three ways: it needs `KYNVIORA_DEV_AUTH=1` exactly, it **throws** under
  `NODE_ENV=production`, and with no header it returns `null`. It grants **no** reviewer role,
  because a header is a client claim and `14` says staff roles are never inferred from one.

- **DEC-039** - the client has **no** outcome and the screen union has **no** state meaning "you
  are not allowed". A 404 becomes `UNAVAILABLE`, which carries only its `kind` and reads exactly
  like `EMPTY`. The API answers `PERMISSION_DENIED` with 404 so it is not an existence oracle, and
  a client that rendered "you do not have permission" would hand that fact back on the screen.
- **DEC-040** - an unrecognised value from the server claims **less**: `UNVERIFIED` not
  `CONFIRMED`, `REVOKED` not `ACTIVE`, `GENERIC` not `NAMED`. Urgency is the exception and falls
  back to `INFORMATIONAL`, because a false alarm with a medicine's name on it is the worse
  failure. A review task kind and a caregiver capability are dropped and counted instead, because
  the presentation layer has no default description to give them.
- **DEC-041** - `OFFLINE` and `STALE` are different states. `OFFLINE` means the check did not
  happen and nothing is on screen; `STALE` means older content is on screen and could not be
  refreshed. A failed refresh keeps the content and labels it. `resourceFor` never carries a value
  for a failed outcome, so a banner over discarded data is not expressible.
- **DEC-042** - `KYNVIORA_LOCAL_DB_DIR` is resolved against the workspace root, not the working
  directory, because `npm run dev` runs from `services/api` and `npm run migrate` runs from `db`.

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
16. Do not add a "mark done" path to the Review Inbox, and do not relax
    `review_task_closed_wrote_something` to make a test pass. Completing a task writes to the
    authoritative record; that is the phase's exit criterion, not an implementation detail
    (DEC-027).
17. Do not give a review task an urgency, evidence level, severity, priority or score, in the
    table, the domain type, the API payload or the tone. Tests assert the absence at every layer,
    and the presentation tone list is a closed union that excludes the alert tones on purpose.
18. Backticks are fatal inside a SQL template literal - `` `03` `` in a SQL comment terminates the
    string and surfaces as an unrelated parse error. Write "Spec 03" in SQL; keep the backticks
    for JSDoc.
19. Do not add a third value column to `reconciliation_difference`, or a `suggestedValue`,
    `preferred`, `confidence` or `score` field to the difference type, the API payload or the
    presentation view. Tests enumerate the real table's columns and the object's own keys. The
    absence is the exit criterion of Phase 8.5, not a gap somebody forgot to fill.
20. Do not make a professional confirmation adopt the current list. It reads like a shortcut and
    it is the exact judgement `04` Phase 8.5 forbids - the pharmacist may have confirmed the older
    dose. Every settling resolution takes an explicit side from the person (DEC-030).
21. Do not emphasise one side of a difference in a screen or a stylesheet. Both sides come from
    `presentSide`, which returns the same tone and `emphasised: false` for each, and a test
    compares them. Bolding the newer value chooses for the user without a sentence saying so.
22. When asserting that a CHECK refuses a row, remember Postgres reports whichever constraint it
    evaluates first. If several would refuse the same row, match on any of them, or assert the
    property directly by reading `pg_get_constraintdef`. A test pinned to one constraint name is
    testing evaluation order.
23. `expectDenied` takes a non-async arrow, so `expectDenied(() => f(await g()))` is a parse
    error, not a type error. Hoist the setup above the call.
24. Do not make emergency withdrawal need two people, a checklist, or an unblocked publication
    control. The asymmetry with publication is the design (DEC-031), and every one of those
    changes makes the fail-safe path slower than the dangerous one.
25. Do not add a single generic reviewer role, and do not let a clinical role approve a regulatory
    record or the reverse. `10` makes them separate publication responsibilities, and the mapping
    exists twice on purpose - `APPROVING_ROLES` in the domain and `kynviora.role_may_approve`
    in SQL (DEC-032).
26. Do not count approval _rows_. The gate counts `DISTINCT reviewer_user_id` per jurisdiction,
    which is what makes two-person approval mean two people and makes a GB approval not an NI one.
27. Phase 6.6 did **not** clear `BLK-006`. The console is the workflow a qualified reviewer would
    use; no qualified reviewer exists, and nothing in the shipped fixtures is publishable.
28. A published `assessment_rule_version` now needs a non-empty `approved_jurisdictions`. If an
    older fixture starts failing with `rule_published_has_approved_scope`, give it a scope rather
    than relaxing the constraint - a rule with no approved scope runs everywhere.
29. Do not add a recommendation, threshold, score or "safe to publish" field to a shadow run.
    `22` requires release thresholds to be set by leadership against a labelled dataset and
    `BLK-008` records that none exists; a verdict here would invent one and a reviewer would read
    it as an answer. Tests assert the absence over the run's keys and the API response.
30. Do not let a historical shadow run measure `INGREDIENT_SENSITIVITY` or
    `DUPLICATE_ACTIVE_INGREDIENT`. The shelf join carries no ingredient declaration, so the run
    would under-count - and an under-count reads as "this affects nobody" (`DEV-018`).
31. `MatchConfidence` (EXACT / PROBABLE / UNCONFIRMED / NOT_MATCHED) and `ItemVerification`
    (CONFIRMED / PROBABLE / PARTIAL / CONFLICTING / UNVERIFIED) both contain `PROBABLE`. A
    constraint written with the wrong list passes a fixture and refuses every real row. This
    happened once in `0013`.
32. A replay never writes back. `profile_assessment` is append-only and a replay is a diff
    somebody reads before anything reaches a user.
33. Do not run a seed or a migration as a separate process against a data directory a server has
    open. PGlite is a **single writer**: the two processes do not share state and the last one to
    exit overwrites the other, so the seed reports success against a database that stays empty.
    Seeding lives inside the API process for this reason (DEC-037).
34. Do not seed a safety rule, a regulatory record or an alert to make a screen look populated.
    The empty Safety and Regulatory Lens screens are `BLK-006` and DEC-016 working, and a
    developer looking at seeded safety content is exactly what Phases 6.6 and 6.7 exist to stop.
35. Do not compare `import.meta.url` to `process.argv[1]` by string suffix to detect an entry
    point. On Windows the URL is percent-encoded and the argv path is not, so it never matches and
    the process starts, does nothing and exits zero. Compare resolved filesystem paths.
36. Do not build a server URL from the **requested** port. `port: 0` asks the OS to pick, which is
    how a test starts several servers at once; read `app.server.address()` instead.
37. The composition root is not an exception to the `new Date()` ban. `systemClock()` is the one
    sanctioned source of ambient time, and opening a second one in the file nobody injects into is
    how the rule erodes. The logger takes the clock too.
38. Do not add a `FORBIDDEN`, `PERMISSION_DENIED` or `NO_ACCESS` member to `ApiOutcome` or to
    `ScreenState`, and do not make `UNAVAILABLE` carry a code, a message or a correlation ID.
    Tests enumerate both unions and compare the `UNAVAILABLE` and `EMPTY` presentations. The
    absence is what makes the 404 decision worth anything (DEC-039).
39. Do not put user-visible copy inside a React component in `apps/mobile`. `apps/**` is excluded
    from the test run, so a string defined there is the one kind of copy no scan looks at. Words
    live in `@kynviora/presentation`; components render them.
40. Do not give the client a method that evaluates a rule, computes a severity, or publishes
    anything. Tests enumerate the client's own keys and assert no name matches
    `/evaluate|assess|score|severity|publish|approve/`. DEC-010 keeps the rule engine server-side.
41. Do not have `useResource` discard content when a refresh fails. It returns `STALE` when there
    is previous content, which keeps a medicine list on screen and says it is older than it looks
    (DEC-041).
42. Do not read `process.env` at module scope in the Expo app. `EXPO_PUBLIC_*` values are inlined
    at build time and there is no `process.env` on a device; `ApiProvider` reads them once and
    hands the result down, which is also what makes the resolution testable.
