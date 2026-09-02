# Kynviora - Status

**Resume checkpoint.** Read this first on any autonomous restart, then `git log`, then the tail
of `WORKLOG.md`, then `BLOCKERS.md`.

Last updated: 2026-09-02

---

## Current position

|                    |                                                       |
| ------------------ | ----------------------------------------------------- |
| **Current stage**  | Stage 5/6 (normalization, shadow measurement)         |
| **Current phase**  | Phase 5.2 complete; `DEV-018` and `DEV-028` closed    |
| **Last completed** | `DEV-018` - both halves of a substance match          |
| **Branch**         | `master`                                              |
| **Latest commit**  | `feat(safety): measuring a rule against a real shelf` |
| **Baseline tag**   | `baseline-spec-only`                                  |

## Verification state

- **3451 tests passing**, 0 failing, across 116 files.
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

### Running the staff surface and the reviewer console

Three origins. The household API serves no reviewer route and the staff API serves nothing else
(DEC-066), so both are needed and the console talks only to the second.

```bash
KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 KYNVIORA_STAFF_PORT=3100 npm run dev
```

```bash
KYNVIORA_STAFF_API_URL=http://127.0.0.1:3100 KYNVIORA_HOUSEHOLD_API_URL=http://127.0.0.1:3000 npm run dev:console
```

The console listens on `127.0.0.1:4100`. The staff listener is **off** unless `KYNVIORA_STAFF_PORT`
is set, and the console refuses to start against the household origin.

Every page is empty against the seed, and that is correct twice over: the seed grants no reviewer
role (DEC-038), and nothing shipped is publishable (`BLK-004`). Signing in with any UUID shows the
three standing blocker warnings and "nothing to show" - which is also what a stranger sees, because
the API will not distinguish them.

## What is genuinely built and tested

| Area                                                       | State                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| Domain vocabularies, IDs, provenance, untrusted quarantine | Complete, 94 tests                                         |
| Database schema, 19 migrations, full RLS                   | Complete, 311 tests incl. threats A1/A2/A3                 |
| Catalog engine, capture pipeline, Trust Passport           | Complete, 178 tests                                        |
| Regulatory registry, Citation Gate, Lens                   | Complete, 72 tests                                         |
| Safety rule engine with replay; schedule and refill        | Complete, 88 tests                                         |
| Ingestion pipeline with hostile-source defences            | Complete, 37 tests                                         |
| Presentation layer, accessibility tokens, safety copy      | Complete, 436 tests                                        |
| API boundary (Fastify), RLS-scoped context                 | Complete, 37 tests                                         |
| Offline sync protocol, per-entity conflict policy          | Complete, 43 tests                                         |
| Caregiver invitation, acceptance, revocation, audit        | Complete, 214 tests                                        |
| Visit Pack export, reviewed-content gate, expiry           | Complete, 100 tests                                        |
| Caregiver alert delivery, notification privacy             | Complete, 126 tests; **not sent** (BLK-009)                |
| Household Review Inbox, record-writing completion          | Complete, 95 tests                                         |
| Medicine Reconciliation, two lists and no chosen answer    | Complete, 109 tests                                        |
| Reviewer console: roles, two-person approval, withdrawal   | Complete, 116 tests; **publishes nothing** (BLK-006)       |
| Staff surface split, console package, console process      | Complete, 172 tests; **authenticates nobody** (BLK-010)    |
| Alert detail, explainability, report-incorrect             | Complete, 89 tests; **no alert to open** (BLK-006)         |
| Notification delivery policy, quiet hours, revalidation    | Complete, 139 tests; **holds nothing** (`DEV-030`)         |
| Household and profile creation, the profile switcher       | Complete, 90 tests; no emergency contact (`DEV-034`)       |
| Allergy and sensitivity records, provenance, review date   | Complete, 86 tests; no conditions (`DEV-035`)              |
| Consent state, withdrawal, and what withdrawing stops      | Complete, 87 tests; no export/deletion (`DEV-036`)         |
| Typed term mapped to a canonical substance                 | Complete, 27 tests; no review queue (`DEV-037`)            |
| Regulatory version diff and change attribution             | Complete, 27 tests; **no route yet** (BLK-004)             |
| Shadow runs, before/after comparison, assessment replay    | Complete, 74 tests; substance rules now measurable         |
| Manual entry: the write path, the form and the screen      | Complete, 105 tests; the only surface that creates an item |
| Item update, the three lifecycle states, mark-as-checked   | Complete, 105 tests; no deletion (`DEV-032`)               |
| End-to-end vertical slice, 7 required scenarios            | Complete, 36 tests                                         |
| Mobile app shell, encrypted store, accessible primitives   | Typechecks; **not device-verified**                        |
| Caregiver, export, inbox, reconciliation, add-an-item UI   | Wired; **not device-verified** (`DEV-007`)                 |
| CI pipeline                                                | Written; not yet run on a real runner                      |

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
| BLK-010 | `EXTERNAL_CREDENTIAL`               | Strong authentication for a reviewer account  |

## Immediate next task

**Phase 5.2 is finished**, and with it the recorded allergies Phase 1.3 introduced are things a rule
could see - where the vocabulary carries the word. `allergy_record.substance_id` had been nullable
since migration `0004` with nothing ever setting it, so every recorded allergy in this build was
invisible to `evaluateIngredientSensitivity` by construction. DEC-093 said so honestly on every row
a day ago; this is the cause, closed.

Five things about it are worth not undoing:

- **A typed term and a printed one go through the same function.** `resolveRecordedTerm` and
  `normalizeIngredients` both call `resolveLookupKey` and both key through `ingredientLookupKey`.
  The rule intersects a declaration's canonical keys with a profile fact's, so two resolvers become
  a rule that fires on one spelling of a substance and not another. A test asserts the two paths
  agree field for field (DEC-098).
- **Only a reviewed alias resolves - never a display name.** `substance_alias` carries provenance
  and an exact-versus-ambiguous state; `preferred_name` is a label. Matching on the label would let
  a rule fire on a mapping nobody reviewed, which is Phase 5.2's first exit criterion failing by the
  back door. `REJECTED` aliases count towards neither a match nor the ambiguity that blocks one.
- **Nothing a person types reaches the vocabulary.** The lookup is a SELECT with no insert branch,
  and a test counts both catalog tables across a write. `08` and threat A11, the same rule manual
  entry keeps for products.
- **The outcome is stored, not re-derived.** Migration `0019` adds `substance_mapping_state` with a
  biconditional CHECK against `substance_id`. Re-resolving on the read path would be `DEV-028`'s
  mistake one level up - the vocabulary can move, and a re-resolution can disagree with the mapping
  actually driving the rule.
- **A corrected term is re-resolved and an unrelated edit is not.** A record whose wording changed
  while keeping the old mapping would drive a rule on a substance nobody typed; a review stamp
  re-running the lookup would let a moved vocabulary change what a rule sees on an edit that never
  touched the word.

And a NULL is now two sentences rather than one. "Kynviora does not know that word" is a gap in a
licensed vocabulary (`BLK-003`) and nothing the person can act on; "that word means more than one
thing here" is something they can fix by being more specific. The second does not list the
candidates - offering them would be Kynviora suggesting what somebody is allergic to.

`DEV-037` records what Phase 5.2 does **not** include: the review queue for unresolved mappings.
There is nothing to map to until `BLK-003` clears, and the entries would be terms people typed about
their own bodies on a staff screen - which `DEC-066`'s split exists to prevent.

### What landed before it

**`DEV-028` - which ingredient matched which recorded sensitivity.** Migration `0018` freezes the
substance key and the profile fact ID at evaluation; the alert detail resolves both by that identity
under row-level security and never re-intersects the declaration with the profile's facts (DEC-097).

**Phase 1.4 - consent as a state rather than a log.** `CONSENT_ENFORCEMENT` answers for all eight
purposes; two enforce something and five say on their own row that they do not. Withdrawing
notifications stops every notification, a critical safety alert included, and nothing pierces it
(DEC-094 to DEC-096). No export or deletion shell (`DEV-036`).

**Phase 1.3 - allergy and sensitivity records.** Provenance derived from who is writing, with no
field to send it (DEC-091); certainty and provenance kept apart (DEC-092). No conditions
(`DEV-035`).

**Phase 1.2 - household and profile creation**, and **Phase 7.5, both halves**. **Stage 2 reads true
except for deletion.**

Next, in the order they build on each other:

1. **`DEV-033`'s notification digest**, the last piece of Phase 7.5. Unlike the missed-dose
   scheduler it needs no unmade product decision - `18` constrains the grouping rather than leaving
   it open - and it is the difference between a household with several alerts getting several
   interruptions and getting one.
2. **`DEV-018`'s remaining half.** Phase 5.2 gave the historical shadow dataset the _fact_ side of a
   substance match; the _item_ side is still missing, because the shelf join does not reach the
   confirmed declaration. Joining `marketed_formulation` and `formulation_ingredient` would let
   `INGREDIENT_SENSITIVITY` come off `HISTORICAL_UNSUPPORTED_KINDS` - and a rule nobody can measure
   against real data is one nobody can approve.
3. **Phase 2.5's item deletion**, the moment the retention matrix exists. `DEV-032` has been waiting
   on the same document as `DEV-036` and is the smallest thing that unblocks with it.

**Not next, and why.** The notification digest (`DEV-033`) is not the cheap win it looks like. A
digest is sent on a cadence, and nothing sends anything (`BLK-009`) or runs on a cadence. Every
question it has to answer - how often, what somebody sees if they open the app first, whether an
item resolved since it was collected still appears - is about a delivery that does not happen. It
also wants the local time `DEV-030` records as missing, and that is a product decision in disguise:
quiet hours live on the _profile_, so applying them means deciding whether a caregiver abroad is
held through the household's night or their own. `04` Phase 7.5 does not say, and inventing it
decides when somebody is woken.

The export-and-deletion shell (`DEV-036`) is a document, not a feature: "get
me a copy" and "remove it" cannot be answered without a retention matrix saying what is kept
regardless, and this build has records that must survive a deletion request with no approved
statement of which. Five deviations converge on that one missing document (`DEV-009`, `DEV-032`,
`DEV-034`, `DEV-035`, `DEV-036`), and it is a retention and disclosure decision rather than an
engineering one.

The substance review queue (`DEV-037`) is the same shape twice over: nothing to map to until
`BLK-003` clears, and a disclosure question - may a term somebody typed about their own body appear
on a staff screen - that `16` has no answer for.

A missed-dose scheduler (`DEV-011`) is blocked the same way: the grace window has no answer, and
`18` forbids shaming copy, so "how long before we tell a relative" is a question with a wrong answer
rather than a missing one.

Note what none of this clears: `BLK-006`. The reviewer console is the workflow a qualified reviewer
would use, the shadow run is what they would look at, and no qualified reviewer exists. Nothing in
the shipped fixtures is publishable and a test asserts that every one is refused.

## Next three planned tasks

1. `DEV-033`'s notification digest, the last piece of Phase 7.5.
2. `DEV-018`'s remaining half - the confirmed declaration in the historical shadow dataset.
3. Phase 2.5's item deletion, once the retention matrix exists.

## Recent decisions worth knowing

- **DEC-099** - a blast radius counts only mappings somebody made. Only `EXACT` ingredients
  contribute a canonical key to the historical shadow dataset, which is what makes a zero a measured
  one rather than a structural one. Both halves of a substance match landed together, because
  supplying one alone would have let the rule report zero with a straight face.
  `DUPLICATE_ACTIVE_INGREDIENT` stays refused for a different reason than it was refused for, and
  the comment says which.
- **DEC-098** - a typed term is mapped by the **same** function as a printed one, at write time,
  and only through a reviewed alias. Never a display name: `substance_alias` carries provenance and
  an exact-versus-ambiguous state, and matching on `preferred_name` would let a rule fire on a
  mapping nobody reviewed. Nothing a person types reaches the vocabulary. Ambiguity is represented
  rather than resolved, and the sentence about it does not list the candidates. The outcome is
  stored (migration `0019`, biconditional CHECK) rather than re-derived, and a corrected term is
  re-resolved while a review stamp is not.
- **DEC-097** - a match names its own inputs, and the read path **resolves** them rather than
  deriving them. `Assessment.matchedInputs` freezes the substance key and the profile fact ID at
  evaluation; migration `0018` stores them with three CHECKs. Re-intersecting the declaration with
  the profile's facts is a different computation over state that may have moved, so it could name a
  substance the rule did not match on (DEC-064's reasoning). No foreign key on the fact ID: the
  table is append-only, so no referential action could fire without tripping its trigger. The
  recorded term is version-gated against what the assessment froze; the substance name is not,
  because a rename is the catalog's and an edit is the person's.
- **DEC-094** - consent is a **state**, not a log. `CONSENT_ENFORCEMENT` answers for all eight
  purposes under a `satisfies Record<ConsentPurpose, ConsentEnforcement>`, so a purpose added later
  without an answer fails to compile. Two are `ENFORCED`, five govern behaviour this build does not
  have and say so on their own row, one is not offered as a choice at all. The server reports the
  enforcement; the client never infers it, and defaults an unrecognised value to "stops nothing" -
  the pessimistic reading. An absent receipt is not agreement, and "never answered" is a different
  sentence from "answered no".
- **DEC-095** - withdrawing notifications stops **every** notification, a critical safety alert
  included. The check sits first in `selectRecipients`, before the owner short-circuit and before
  every grant-shaped check, and nothing pierces it: quiet hours are a timing preference (DEC-078),
  consent is whether Kynviora may contact somebody at all. `CAREGIVER_SHARING` excludes caregivers
  and never the owner, is checked before the grant state, and does not revoke read access - the copy
  says which half it does not do. Two new exclusion reasons keep "they asked not to be contacted" out
  of `CAPABILITY_MISSING`.
- **DEC-096** - consent is strictly the caller's own and there is no step-up on it. Neither route
  takes a user and neither could; the body carries no policy version and no timestamp, because a
  client that could name the policy version it agreed to could record agreement to a text nobody
  showed them. No confirmation step either: friction on withdrawal and not on granting is a design
  that has taken a side. Withdrawing writes a row and never changes one.
- **DEC-091** - provenance is derived from **who is writing** and there is no field to send it. The
  draft has none, the body schema is `.strict()`, and `provenanceForRelationship` has two possible
  answers - so `IMPORTED` and `REVIEWER_CONFIRMED` are unreachable from a phone. Phase 1.3's first
  exit criterion enforced by absence, which is what makes the second one mean anything.
- **DEC-092** - certainty is the person's and provenance is Kynviora's, and neither implies the
  other. A person may say "I am sure"; the record still reads `USER_REPORTED`, and no shipped rule
  reads certainty at all. They are never combined into one word.
- **DEC-093** - an unmatched term says so on the record, in both halves: Kynviora cannot check your
  products against this **and** it is recorded and not lost. A review is stamped by the server only
  when somebody says they checked, never inferred from an edit, and shown as a fact rather than a
  nag.
- **DEC-087** - a profile the server no longer offers becomes **no selection**, never a different
  one. `profileSwitcherView` owns Phase 1.2's second exit criterion and never falls back to whoever
  is first; "the list is empty" and "your selection is gone" are separate states with separate
  sentences. It lives in `@kynviora/contracts` because `apps/**` is outside the test run.
- **DEC-088** - who a profile is _for_ is a claim the caller makes about themselves. No body field
  can name another user and there is no parameter one could reach if it did - the absence is the
  enforcement. The screen never says "managed"; it says "someone I look after", and says they can
  take it over later.
- **DEC-089** - an age **band**, not a date of birth (`16`), and every optional field says why it is
  asked for and that leaving it out costs nothing. A band that disagrees with a birth year is a
  question rather than a refusal: refusing would throw away everything else somebody typed.
- **DEC-090** - both creation routes require an idempotency key, scoped to the owner and to the
  household rather than globally (DEC-079's reasoning twice). Two households are not a duplicate
  row: every later record hangs off one, nothing merges them, and there is no delete control.
- **DEC-086** - the settings screen says quiet hours do not hold anything yet, **before** somebody
  sets their first window rather than after. The server reports it (`QUIET_HOURS_APPLIED`, checked
  against the dispatcher by a test, not trusted), `notificationPolicyView` turns it into the
  sentence, and a missing copy key falls back to the packaged wording rather than to silence -
  silence reads as "it works", which is the one reading that is false. The save confirmation says
  what was recorded, never what will follow from it.
- **DEC-085** - a typed clock time is **refused rather than repaired**: `9:5` is not read as
  `09:05`, `24:00` is not midnight, and the refusal names the field. Both bounds or neither, at
  three layers. And `setNotificationPolicy` sends the whole policy every time, because the route
  writes one row and a body carrying only the changed half would clear the other.
- **DEC-084** - every lifecycle state says what Kynviora **stops** doing. Archiving turns the
  safety watch off, and that sentence sits above the control rather than under it. The wording is
  checked against the code by a test that loops the vocabulary, so a state added later fails rather
  than shipping with a blank line where its consequence should be.
- **DEC-082/083** - an edit is conditional on `owned_item.version` and needs no idempotency key,
  because a conditional write is already exactly-once for its intent. `ASK_USER` on a screen means
  offering the saved version as a control and saying what pressing it costs - never replacing what
  somebody typed on their behalf.
- **DEC-079** - a manual entry's idempotency key is scoped to the **profile**, not globally. Under
  a global key another household's key makes the insert conflict, the replay read finds nothing
  under RLS, and the route answers success with no ID.
- **DEC-074** - a change is attributed from what was **recorded**, never from what the two versions
  look like. A regulator tightening a limit and Kynviora discovering it mis-extracted the old one
  are byte-identical, so `attributeChange` reads the correction row and the supersession link and
  inspects neither version. Four answers, and `NOT_STATED` is one of them.
- **DEC-070** - where a fact came from is a **type**. Every value on the alert detail carries a
  `FactBasis` and there is no constructor without one, so a new field cannot reach the screen
  unlabelled. Six bases, not two: a batch number read off the pack and one somebody typed are both
  "known" and are not the same evidence, and `NOT_KNOWN` and `WITHHELD_FROM_THIS_SESSION` are
  opposite facts.
- **DEC-071** - an explanation template this build does not have produces **no narrative**, and so
  does an approved template whose required context is missing. A generic sentence about somebody's
  medicine is content no reviewer approved.
- **DEC-072** - a caregiver holding `VIEW_SAFETY` and not `VIEW_MEDICINES` sees the alert with the
  item withheld, not a 404. The joins are `LEFT` so row-level security narrows rather than removes.
- **DEC-073** - a source's legal reference and its required attribution are shown only where the
  licence review is `APPROVED`. The publisher and the date are not restricted. `BLK-005`.
- **DEC-066** - a process serves **one** surface and the option is required. `createServer` has no
  `BOTH`, so a new route cannot land on the wrong side of a security boundary by default. Two
  listeners run in one development process only because PGlite is a single writer (DEC-037).
- **DEC-067** - the staff console shares nothing with the household client. Not
  `@kynviora/contracts`, not `@kynviora/presentation`: those ship in the Expo bundle and `13` asks
  for environment isolation. Its transport refuses query strings **entirely**, because no staff
  route takes one.
- **DEC-068** - the reviewer queue is never ordered by urgency, and this is a security property:
  `maxUrgency` is set by whoever opened the request, so sorting by it would let them choose how
  soon their own request is looked at. `views.ts` exports no comparator and a test asserts it.
- **DEC-069** - nothing in the console is preselected and the checklist is never offered in bulk.
  `ChecklistItemView.confirmed` is typed `false`, not `boolean`.
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

- **DEC-043** - the editor's field table is keyed by column name and checked against
  `COMPLETABLE_FIELDS` in both directions. Adding a completable field is a two-file change and the
  suite says so.
- **DEC-044** - `batch_id` and `formulation_id` are `uuid` references to catalog records, not
  strings off a pack. They are `REFERENCE` inputs the editor does not render, and their task kinds
  report `completableHere: false` and offer **no** fields - not even the paired `*_verification`,
  which would close "add the batch number" without one.

- **DEC-045** - the invite screen offers only capabilities the inviter may delegate. Absent, not
  disabled: a greyed-out control states that a capability exists and that this person is not
  trusted with it.
- **DEC-046** - the Care screen lists outstanding invitations as well as grants. Without it an
  owner sees no change after sending and reasonably sends a second, minting a second live
  credential for one intent.
- **DEC-047** - `GET /v1/profiles` carries `isOwner`. `isManaged` is about the person the profile
  is for and is **not** ownership; reading one as the other is a real mistake this field removes.

- **DEC-048** - the Visit Pack client hashes the candidates it **displayed** and never re-fetches
  before hashing. `canonicalizeSelection` and `toNoteEntries` come from the domain so both sides
  build the same string. An entry this client cannot canonicalise is refused, never coerced.

- **DEC-064** - the Lens opens from a safety line, once per substance, and only for a substance
  whose ingredient mapping is `EXACT`. It answers about whatever key it is given, and a confident
  answer about the wrong substance is worse than none because it looks like one.
- **DEC-065** - a Lens card carries no verdict and the cards are never ordered by severity. `09`
  forbids "strict country" framing and a severity-sorted list is that framing without the words.

- **DEC-062** - an item nobody has assessed is `INSUFFICIENT_DATA`, never
  `NO_CURRENT_MATCHED_ALERT`. The second claims a check ran and found nothing. Listing only alerts
  was the same claim made by omission, which is `23` D-014's quietest form.
- **DEC-063** - the safety inbox filters narrow and never rank, and carry no count of any state.
  `totalItems` is the size of the shelf, so a filtered screen can say what it is a subset of.

- **DEC-059** - an operational metric is a key from a closed vocabulary, a number and a unit.
  There is nowhere in the type for a profile, a medicine or a sentence, which is how `20`'s
  "measure system behaviour, not sensitive content" survives being forgotten.
- **DEC-060** - the projection reaches no verdict: no status, severity, health score or threshold
  breach. `20` requires exact thresholds to be documented before production and `BLK-008` records
  that none are. A source being past its own declared refresh cadence is the one comparison that
  is arithmetic rather than a new judgement.
- **DEC-061** - any ACTIVE reviewer may read the projection, not one role. Source freshness is a
  safety metric, and the snapshot carries no user content at all.

- **DEC-057** - the dose history is a list and carries no count, rate, streak or total of anything
  a person did. Enforced at the route as well as the view, because a `takenCount` on the response
  hands a screen everything it needs and the screen is where nobody would notice it.
- **DEC-058** - the four dose controls carry equal weight and the four recorded kinds share one
  neutral tone. An emphasised "I took it" is a preference about somebody's treatment, and a red
  chip on SKIPPED is a scorecard drawn in colour. The icons differ instead.

- **DEC-055** - `heldCapabilities` unions the caller's own active, unexpired grants, which is what
  `has_capability` does in SQL. An expired grant contributes nothing even where its stored status
  still says `ACTIVE`, compared against the response's own `serverTime`. Not an authorization
  predicate, so DEC-024 does not apply - it only stops the screen offering a refused control.
- **DEC-056** - a caregiver who may delegate nothing is not offered the invite control at all.
  DEC-045 one level up, and two conditions rather than one: holding only `MANAGE_CAREGIVERS`
  passes the server's authority check and still leaves nothing to offer (DEC-020).

- **DEC-050** - a failed refresh keeps content on screen only where the server said nothing about
  this caller's access: `OFFLINE` and `SERVER_ERROR` and nothing else. Every other failure is an
  answer, and the answer is no. `UNAVAILABLE` is the shape a revocation arrives in.
- **DEC-051** - an access-list row carries `subject` (`GRANT` or `INVITATION`), because the two
  have separate revocation routes and the wrong one answers 404 - which reads on screen as the row
  vanishing rather than as a bug.
- **DEC-052** - `GET /v1/caregiver-grants` returns `isSelf` per row, for the same reason
  `GET /v1/profiles` returns `isOwner`. Removing your own access and removing somebody else's are
  different sentences, and the alternative is reading identity back out of a session.
- **DEC-053** - revocation takes no idempotency key: it has one destination state, so a retry is
  the same request. A repeat returns 200 with `alreadyRevoked: true`.
- **DEC-054** - `revocationMessage` supplies the wording for `INVITATION_ALREADY_RESOLVED` and for
  no other code. Its client-safe message is shared with the acceptance path, where being specific
  would tell a stranger holding a link which of expired, declined or revoked applies.

- **DEC-049** - settling a reconciliation difference is **two** questions. Choosing a resolution
  does not say which value stands, and inferring it - defaulting a confirmation to the newer list -
  is the judgement Phase 8.5 forbids. Every settling resolution goes through `ResolutionPrompt`.

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
43. Do not offer `batch_id` or `formulation_id` as a text field. They are `uuid` foreign keys, the
    API casts them, and a typed lot code fails - the control would error for every real user.
    Creating the record from a typed string is worse: it puts a catalog row in with no provenance,
    no corroboration and no quality gate (DEC-044).
44. Do not let `BATCH_MISSING` be completed by writing `batch_verification` alone. It closes a task
    called "add the batch number" without one, which is trap 16 arriving by a different route.
45. A response schema validates **before** Fastify serialises, so a `Date` from the driver fails a
    `z.string()` even though the wire format would have been identical. Type a timestamp row as
    `Date | string | null` and pass it through `isoOrNull`. This shipped once as a 500 on the shelf
    for any item that had ever been reviewed, hidden because every fixture had the column null.
46. Do not "simplify" the seed by dropping the two-hundred-day-old item. Without it every derived
    review task is a `BATCH_MISSING`, which needs guided capture - a developer opening Today would
    see only work the app cannot do and would reasonably think the screen was broken.
47. The invitation token is returned once and is never stored, logged, put in a URL, or passed to
    a share sheet or clipboard helper. A test asserts `invitation.ts` does not contain the word.
    Do not add a "copy again" affordance: the server holds only a hash and has nothing to reissue.
48. Do not keep an elevated client. `elevate()` is called at the moment of a step-up-gated request
    and discarded; a client that stayed elevated makes `14`'s requirement decorative (DEV-025).
49. Do not read `isManaged` as ownership. It describes the person the profile is for. Use
    `isOwner` (DEC-047).
50. Do not return the invited email address from `GET /v1/caregiver-invitations`. It returns
    `boundToAddress` instead - whether the link is bound is the fact the owner needs, and the
    address is personal data on a screen someone else may be reading (`14`).
51. Do not re-fetch Visit Pack candidates before computing the digest. It would quote a digest of
    content the user never saw and silently disarm `EXPORT_CONTENT_CHANGED` - the request would
    succeed and the guarantee would be gone with nothing failing to say so (DEC-048).
52. Do not inline the user-note caveat or rebuild note entries by hand. The digest covers the
    notes, so `toNoteEntries` and `USER_NOTE_CAVEAT` are exported and used by both sides; a second
    spelling produces a refusal that reads as "your records changed" when nothing did.
53. Do not coerce an unrecognised Visit Pack section, entity kind or caveat to a default. The
    canonical form includes each verbatim, so a substitution produces a mismatched digest and
    `EXPORT_CONTENT_CHANGED` starts reporting a record change that did not happen.
54. Every mutation that mints something - a dose event, an invitation, a Visit Pack - takes an
    idempotency key as a **parameter**. A key generated inside the client is regenerated on retry,
    which is a second write rather than a replay. `createVisitPack` shipped without one and every
    generation failed with `VALIDATION_FAILED` until an end-to-end test posted a real request.
55. Do not infer which side a reconciliation resolution settles on. `fixedSide` is `null` for all
    three professional confirmations because a pharmacist may confirm the older dose, and
    defaulting to the newer list is exactly what Phase 8.5 forbids (DEC-049).
56. Do not trim, normalise or sentence-case a typed direction on the reconciliation path. `04`
    Phase 4.1 forbids rewriting a prescription instruction, and tidying one is rewriting it.
57. `POST /v1/reconciliations` returns the ID only. Read the differences back rather than
    assembling them from the create response - the derivation is the server's, and typing the
    response as the full record typechecks and fails at runtime.
58. A typed reconciliation line must carry the **shelf item's own ID** as its match key when the
    person says it is the same medicine. With a positional key nothing can correspond and every
    difference is `ONLY_IN_*` - the feature runs, passes, and compares nothing. Never match by
    name: two packs of one medicine at different strengths are two real records.
59. Do not drop `subject` from an access-list row, or route a removal by the row's state. Grants
    and invitations share the list and have separate routes; the wrong one answers 404, the client
    renders a 404 as absence (DEC-039), and the bug presents as the row quietly disappearing on
    the one screen where that is a statement about who can read someone's health data.
60. Do not make `refreshedResource` keep content for an authorization failure to "avoid a jarring
    empty screen". `UNAVAILABLE`, `AUTHORIZATION_LOST` and `UNAUTHENTICATED` are the server saying
    the content is not this caller's, and keeping it under a `STALE` label is `15` A2 reintroduced
    one layer above the database (DEC-050). Tests enumerate the failure union.
61. Do not add an idempotency key to either revoke route, and do not make a repeated revocation an
    error. Someone removing another person's access who is answered with a failure has been given
    a reason to doubt whether it worked (DEC-053).
62. Do not style the removal confirmation as a warning, and do not add a "this is dangerous" line.
    `15` wants removing access to be easy; copy that treats it as risky discourages the thing the
    threat model depends on. `CAREGIVER_ACCESS_PRESENTATION.REVOKED` is neutral for the same
    reason, and a test asserts the copy carries no risk word.
63. Do not "fix" `revocationMessage` by making the wire message for `INVITATION_ALREADY_RESOLVED`
    specific. The code is shared with acceptance, where the generic message is what stops a link
    that reached the wrong person from revealing whether it was expired, declined or revoked
    (DEC-054).
64. Do not record a revocation audit event with an empty capability list. It reads as "a grant with
    no capabilities was removed" rather than as "nobody wrote them down", on the one screen an
    owner has nothing else to check against. Found by running the flow, not by a test.
65. Do not hand `inviterAuthority` an empty `ownCapabilities` again, and do not derive the caller's
    own grant by matching a user ID read back out of the session. `isSelf` is on the row for this
    (DEC-052, DEC-055). The empty list is what made `DEV-026` a rule that was correct, tested, and
    reachable by nobody.
66. Do not count an expired grant toward what a caregiver may delegate on the strength of its
    `status` column. `status` and `expires_at` are separate and `has_capability` checks both.
67. Do not re-add "Invite someone" for a caregiver who may delegate nothing, and do not render it
    disabled. Its only reachable outcome is a 404 after a form has been filled in, and a disabled
    control states that the action exists and that this person is not trusted with it (DEC-056).
68. Do not add a count, rate, streak, percentage or total to the dose-event response, the history
    view, or a screen that renders it. `02` names gamified adherence scoring as an anti-feature and
    `23` D-005 forbids the aggregate; tests enumerate the response keys, the view keys and the
    module's exported names (DEC-057).
69. Do not collapse `SKIPPED` and `UNABLE_TO_TAKE` into "missed", and do not use that word for
    anything a person recorded. It belongs to a schedule that lapsed with nothing recorded, and the
    two kinds exist because they are different facts.
70. Do not make "I took it" the primary control or give `TAKEN` a positive tone. All four controls
    are one weight and all four kinds one neutral tone; the icons carry the distinction and a test
    asserts they differ (DEC-058). Praise is the other half of shame - the copy scan rejects
    "well done" and "keep it up" as well as the reproaches.
71. Do not add a `subject`, `label`, `profileId` or free-text field to a `MetricReading`, and do not
    report which profile holds the oldest open review task. `20` keeps medicine names and subjects
    out of operator output, and the type having nowhere to put one is what keeps it out (DEC-059).
72. Do not add a status, severity, health score or threshold breach to the operational snapshot or
    to a source row. `20` requires exact thresholds to be documented before production and
    `BLK-008` records that none exist; a verdict would invent one and an operator would act on it
    (DEC-060, trap 29 by another route).
73. Do not report a source that has never been checked successfully as zero milliseconds overdue.
    `neverSucceeded` is a separate field, because folding the two together hides the worst case
    inside the best-looking number.
74. Do not narrow `/v1/reviewer/operations` to `SOURCE_OPERATIONS_OWNER`. Source freshness is a
    safety metric a clinical lead needs, and the snapshot carries no user content (DEC-061). What
    must not be relaxed is the role coming from a stored row rather than a client claim.
75. Do not report an unassessed item as `NO_CURRENT_MATCHED_ALERT`, and do not go back to listing
    only alerts on the Safety screen. Both say a check ran and found nothing; one says it in a
    label and the other by leaving the row out (DEC-062, `23` D-014).
76. Do not read a withdrawn alert's assessment as a live state. The assessment still says the rule
    matched, so the publication state is what the join must filter on - a withdrawn alert leaving
    an item on ACTION_REQUIRED is `19`'s release-blocking defect class.
77. Do not add a count per safety state, a badge, or a sort by urgency to the safety inbox. `02`
    names alarm-optimised design as an anti-feature and ranking is a judgement about which of two
    people's medicines matters more (DEC-063).
78. Do not give a safety line a default urgency or evidence level. They are `null` together on a
    line with no live alert, and a substituted `INFORMATIONAL` or `U` is a chip nobody assigned.
79. Do not turn the inbox filters into one comma-separated parameter, and do not drop an
    unrecognised filter value. A silently empty list and a silently wider one are both the failure
    this screen exists to prevent; `buildUrl` takes repeated values and applies the same credential
    guard to them.
80. Do not add an overall verdict to the Lens view, and do not sort the jurisdiction cards by how
    prohibitive each answer is. `09` forbids "strict country" and "weak regulation" framing, and a
    severity-ordered list is that framing with the words left out (DEC-065).
81. Do not render a regulatory status this build cannot describe as a bare code, and do not hide
    it. It is dropped and counted, because a card that quietly lost a published status would
    understate what a regulator said.
82. Do not open the Lens on a substance whose ingredient mapping is not `EXACT`. The Lens answers
    about whatever key it is given, and an `AMBIGUOUS` mapping means nobody confirmed that
    substance is in the pack (DEC-064).
83. Backticks are still fatal inside a SQL template literal, and trap 18 fired again while writing
    the safety-inbox query. A `` `09` `` in a SQL comment surfaced as "decimals with leading zeros
    are not allowed" forty characters away. Write "spec 09" in SQL.
84. Do not give `createServer` a default `surface`, and do not add a `BOTH`. The option is
    required so a new route cannot land on the wrong side of a security boundary silently, and the
    boundary test reads the paths an instance actually registered rather than a list of forbidden
    ones (DEC-066).
85. Do not register a household route inside the staff block or the reverse. It happened once with
    `/v1/profiles/:profileId/safety-inbox`, grouped by proximity to a comment, and nothing caught
    it because both surfaces were one origin.
86. Do not make the staff console depend on `@kynviora/contracts` or `@kynviora/presentation`.
    Those ship in the Expo bundle, and `13` asks for environment isolation between a user surface
    and a staff one (DEC-067).
87. Do not sort the reviewer queue by `maxUrgency`, or add any comparator to the console's view
    models. The requester sets that field, and sorting by it hands them the review order (DEC-068).
88. Do not preselect a decision, pre-tick a checklist item, or add a "confirm all" control to the
    console. `ChecklistItemView.confirmed` is typed `false` so the compiler refuses (DEC-069).
89. Do not add an outcome, a page or a sentence to the console meaning "you are not a reviewer".
    The staff API answers that with a bare 404 so it is not an oracle, and a console that reported
    it would hand the fact back on the screen.
90. Do not assert `not.toContain('onerror=')` or `not.toContain('checked')` on rendered HTML. Both
    strings appear legitimately - the first as escaped, inert text, the second in the checklist
    copy. Assert the property: no surviving tag, and no `checked` **attribute**.
91. Do not reuse one rule across two console fixtures that both open a publication request.
    `publication_request_open_idx` allows one open request per target and action, so the second
    fails with a 500 that reads as a bug in the route.
92. Do not fill an approved safety template from data re-derived on the read path. The assessment
    stores versions and reason codes, not the identities it matched on (`DEV-028`), and joining
    the lists afresh can name a substance the rule did not match - DEC-064's failure with a
    different subject.
93. Do not add a generic fallback explanation for an unrecognised template identifier. The absence
    of a narrative is the design (DEC-071).
94. Do not turn a withheld half of an alert into a 404, and do not render it as `NOT_KNOWN`. The
    two are opposite facts, and the joins to `profile` and `owned_item` are `LEFT` for exactly
    this (DEC-072).
95. Do not show a source's legal reference or its attribution unless `license_review_state` is
    `APPROVED`. Today that is none of them (DEC-073, `BLK-005`).
96. Do not `.find()` a difference by kind alone in a reconciliation test. A named line with no
    dosage form produces two `FIELD_DIFFERS` rows and the order is not guaranteed; match on the
    field as well. It failed about one run in five and blamed the wrong thing.
97. Do not use `git add -A` to stage a commit in this repository. `docs/autonomy/
last_session_messeges.md` is untracked on purpose and was swept into a feature commit that
    way; stage paths explicitly.
98. Do not infer why a regulatory record changed from the two versions. There is no arithmetic
    that separates a regulator acting from Kynviora correcting itself, and every heuristic fails
    in the case that matters (DEC-074).
99. Do not default `NOT_STATED` to either side, and do not attribute an unrecognised correction
    kind to the regulator. Both directions are wrong and the second is the dangerous one.
100. Do not make `@kynviora/presentation` or `@kynviora/contracts` depend on
     `@kynviora/regulatory`. Those two are carried in the Expo bundle and the registry is not; the
     diff shape is declared structurally and pinned by a test in the regulatory suite.
101. Do not `String()` an `unknown` that reaches a screen. A condition shape this build did not
     expect would render as `[object Object]` beside somebody's medicine; narrow to scalars and
     report anything else as absent.
102. Do not add a resolution row to `safety_receipt`. `receipt_publication_idx` is UNIQUE on
     `alert_publication_id` and the app role holds UPDATE and no INSERT - one receipt per alert,
     resolved in place (DEC-075). An append-only design was half-written against this constraint
     and had to be unwound; read the migration before designing against a table.
103. Do not give a second route its own INSERT into `safety_receipt`. Phase 7.3's report-incorrect
     had one, so a household that recorded any resolution and then said "this is not my product"
     met the unique index and got a 500. Both routes go through `recordSafetyResolution`.
104. Do not put the receipt's history anywhere but the audit log. `audit_event` is refused to
     every role by a trigger - the service role and the owner role included, and a test asserts
     both - which is a stronger guarantee than an append-only receipt table could give, because
     that table would still be editable by whoever holds UPDATE on it.
105. Do not `DELETE FROM audit_event` in a test fixture. It is append-only and the trigger refuses
     even `asOwner`; scope audit assertions by target instead, since each test publishes its own
     alert.
106. Do not inner-join `assessment_rule_version` on a user read path. Its policy admits PUBLISHED
     only, so an alert whose rule was later superseded would 404 - a person's own receipt
     disappearing the day Kynviora revised the rule behind it, which is exit criterion 1 failing
     by another route. LEFT join, and say the name is unavailable while showing the identifier.
107. Do not put two role-scoped reads in one `Promise.all`. Each takes its own connection and sets
     its own role, and DEC-037 records that the development engine is a single writer - the role
     switches interleave rather than running in parallel, and the route 500s. Await them in turn.
108. Do not name the actor on a Safety Receipt. The audit rows carry one and
     `ReceiptHistoryEntry` deliberately has nowhere to put it: a caregiver holding `VIEW_SAFETY`
     reading "your daughter marked this reviewed" is a disclosure nobody added that permission for
     (DEC-076). Identity belongs on the caregiver-audit screen.
109. Do not let a resolution's copy stop at what recording it does. `QUARANTINED` said only what
     setting a pack aside means and not what it fails to do, and a test over the whole vocabulary
     is what found it - not review. Every description says what it does **not** do.
110. Do not put the uncertainty list at the foot of the receipt. A record of somebody having acted
     reads as a record of the matter being closed, so `10`'s limits go above the controls.
111. Do not have the client guess which control to withhold from a resolution code it does not
     recognise. It can hide the wrong one; the server sends `currentResolution` as a code so the
     client withholds by identity or withholds nothing.
112. `approved_jurisdictions` must be non-empty on a `PUBLISHED` rule
     (`rule_published_has_approved_scope`, migration `0012`). A fixture that publishes a rule
     without it fails in `beforeAll`, and the suite reports `app.close()` on undefined instead.
113. Do not add a delivery channel meaning "a quieter notification" and stop there. `04` Phase
     7.5's first exit criterion needs a channel that reaches no device at all, and two channels
     would make it "a foreign restriction produces a digest line" - a smaller version of the thing
     it forbids (DEC-077).
114. Do not give `DispatchInput` a default urgency. It decides how loudly Kynviora speaks about
     somebody's medicine: `INFORMATIONAL` would be silent and silently wrong, anything else a push
     nobody chose. Required, like `createServer`'s `surface` (DEC-066).
115. Do not downgrade a held alert to a digest item. It is still the urgency a reviewer approved
     and still an interrupt when the window ends; `23` D-005 forbids evaluation adjusting what a
     reviewer set, and the channel gets the same discipline (DEC-078).
116. Do not let `HIGH` pierce quiet hours. Only `CRITICAL` does. The two vocabularies are
     different lengths on purpose, and a phone lighting up at 3am about a pack expiring in three
     weeks is the alarm optimisation `02` refuses.
117. Do not hold a notification when nobody knows the recipient's local time. `localMinuteOfDay`
     is `null` everywhere today (`DEV-030`) and not holding is the safe direction - a `CRITICAL`
     recall waiting for a window that never closes is the worse failure.
118. Do not store a timezone offset on a profile to make quiet hours work. It is a number somebody
     invented and it is wrong twice a year. The window is local minutes and the local minute is
     supplied, not computed.
119. Do not make revalidation its own route. Exit criterion 2 is "cannot remain actionable
     **without** revalidation", and a separate route is one a client can skip. It belongs to the
     read that renders the screen, and `AlertDetailInput.revalidation` is required so the compiler
     refuses a caller that omits it.
120. Do not add a "still current" banner. A screen that announced it on every ordinary open would
     train people to skip the notice on the one occasion it says something else.
121. Do not turn a withdrawn alert into a revalidation notice on the detail route.
     `alert_publication`'s policy admits `PUBLISHED` only, so the row never arrives, and a caller
     cannot tell that from having lost access - which is the answer the server is willing to give
     (DEC-039).
122. Do not ship a decision layer without the caller that consults it. `deliveryDecision` was
     committed, tested at four layers, and reachable by nobody for exactly one commit. That is
     `DEV-026`'s failure and it nearly went into the plan as complete.
123. Do not add a digest queue table before something drains it. `BLK-009` means nothing is sent,
     and a table nobody would drain is speculative structure a later reader mistakes for a working
     mechanism.
124. Do not meet "a user can understand which items need verification or review" with a filter
     alone. A list where that is visible only to somebody who already knew to filter for it lets
     nobody understand anything; the reasons belong on the row, and the filter only narrows.
125. Do not add a "reviewed too long ago" reason to the shelf. It needs an interval, `BLK-008`
     records that every numeric threshold here is unset, and an invented ninety days is a
     threshold arriving through the back door on the screen a household reads most.
     `NEVER_REVIEWED` is the absence of a timestamp and is a different, honest statement.
126. Do not merge the three verification axes into one `NEEDS_VERIFICATION` reason. `08` keeps
     them separate and `02` forbids the aggregate; a merged reason is that aggregate with the
     number left off. Six members, one per facet per unsettled state.
127. Do not add a count of what needs attention, per item or per shelf. `02` forbids the aggregate
     and Phase 8.3 forbids the badge. The row says which, never how many.
128. Do not ask anything of a stopped or archived item. Nothing about it is going to be used, and
     a shelf that nags about finished packs teaches people to ignore the list that matters. The
     route enforces it in SQL as well as the domain, because filtering after paging returns short
     pages that read as the end of the list.
129. Do not render `personal_care_category` raw. It is a closed vocabulary in migration `0004`,
     and `BODY_CLEANSER` beside a bottle in somebody's bathroom is a field value, not a phrase. A
     CHECK constraint caught this in a fixture, not review.
130. Do not render a medicine's fields and a personal-care item's fields as one list with blanks.
     A medicine with an empty "kind of product" row reads as one somebody failed to fill in, which
     is exactly the reduction to a generic note Phase 2.1's first exit criterion forbids.
131. Do not put written directions in Kynviora's voice. `04` Phase 4.1 preserves the source text
     and `09` forbids Kynviora saying how to take a medicine; `ItemField.quoted` is what keeps a
     prescription instruction rendered as somebody else's words.
132. Do not let an unrecognised filter value through as "no filter". A silently widened result set
     and a silently narrowed one are both the failure a list about somebody's medicines cannot
     have - the same rule the safety inbox already keeps (trap 79).
133. Do not copy `dose_event`'s globally unique idempotency key onto a new table. A key another
     household already used makes the INSERT conflict, the replay read then finds nothing under
     row-level security, and the route answers success carrying no ID - their row dropped
     silently. Scope it to the profile (DEC-079); the existing one is `DEV-031`.
134. Do not write `ON CONFLICT DO NOTHING` without inferring the index. A bare form also swallows
     a violation of some future constraint and reports it as a successful retry of something that
     never happened. Name the columns and the predicate.
135. Do not echo the submitted body on an idempotent replay. A retry carrying a changed field
     would be told what its own body implies, when what exists is the first version. Re-read the
     stored row and describe that.
136. Do not regenerate the idempotency key on each press. One key per draft: a refused body wrote
     nothing and leaves the key free, so correcting a field and trying again has to be the same
     save rather than a second medicine record.
137. Do not add a field to `manualEntryForm` without a row for it on the item detail. Phase 2.1's
     detail predates migration `0015`, so five columns were writable and invisible - somebody
     could transcribe a whole back-of-bottle declaration into nothing. Four layers of unit tests
     passed; an end-to-end test through the shipped client is what found it (DEC-081).
138. Do not label a transcribed barcode "Barcode". These columns are the household's own record
     and corroborate nothing (`15` A11, `08`); a bare label above three unconfirmed chips reads as
     evidence Kynviora matched something. "as recorded here" is what prevents that, because the
     value cannot.
139. Do not let a client drop the `detail` a refusal carries. The domain names the field so a form
     can point at it, and `WireError.detail` was declared and never parsed for months - a form
     with eleven fields could only say "that is not a kind of product Kynviora knows". Scalars
     only, absent rather than empty, and never on an authorization outcome (DEC-080).
140. Do not give a form-field error the `action` tone. `action` is what a recall wears, and
     spending it on a mistyped barcode is the alarm optimisation `02` refuses - it makes the red
     mean less where it matters. `attention` is the tone for something a person can fix.
141. Do not trim, upper-case or strip a value on the client before sending it. Deciding a blank
     field is absent is not the same as altering a value: the first is what `04` Phase 2.2's
     second exit criterion asks for, the second is a value the person can no longer check against
     the pack in their hand. The domain refuses and names the field.
142. Do not read a background `npm run verify` as green because the task notification says exit 0. `npm run verify > log 2>&1; echo "EXIT=$?"` makes the wrapper succeed whatever verify did;
     the notification reports the wrapper. Grep the log for the vitest summary, or append the real
     code to the log. This nearly produced a commit on a failing format check.
143. Do not couple a form's field list to a screen by hand. `manualEntryDraft` reads
     `manualEntryForm`, so a value left behind when somebody changed their mind about what they
     were adding cannot be submitted; and a `satisfies Record<ManualEntryField, true>` map checks
     both directions at compile time - a form key the body cannot carry, and a body field no form
     asks for.
144. Do not add an idempotency key to a route whose write is already conditional on a version. A
     conditional write is exactly-once for the intent it describes; a key beside it is a second
     answer to the same question, and the two eventually disagree (DEC-082).
145. Do not read zero affected rows from an UPDATE as one fact. `owned_item_update`'s USING clause
     filters rather than raising, so "may not change it", "the version moved" and "it is gone" are
     the same empty result. Re-read to tell them apart: a refusal reported as a conflict sends
     somebody round a retry loop they can never win.
146. Do not compute "may this person edit" on the client from a capability list. The detail asks
     the database with `kynviora.has_capability`, the same predicate the update policy uses, so
     the screen and the policy cannot disagree. A screen that inferred it would eventually offer a
     control the write refuses.
147. Do not build an edit form from the rendered fields. `categoryFields` carries labels and
     phrases - the category renders "Hair care" where the column holds `HAIR_CARE` - so a form
     built from them sends a value the domain refuses, naming a field the person never edited.
     `editableValues` is keyed as the form is keyed (DEC-083).
148. Do not let the prefill and the form drift. Every field `manualEntryForm` offers has an entry
     in `editableValues`, and the whole prefill sent back unchanged must be refused as "nothing to
     change". Without both, a field with no entry opens blank, the person saves, and a value they
     never touched is cleared - with the write succeeding and the column legitimately nullable.
149. Do not treat blank the same way on creating and on editing. On creation blank means "not
     entered"; on an edit it has to mean "empty this", or a value typed by mistake is permanent.
     Absent and `null` are different answers and the patch type keeps them apart.
150. Do not accept a `lastReviewedAt` from a client. `markReviewed` is a boolean and the server
     stamps the time - a supplied timestamp would let a screen claim somebody reviewed a medicine
     at a moment they did not, on the value the Shelf's "not yet looked at" filter reads.
151. Do not write a second validator for an update. The patch is merged over the stored row and
     goes through `normalizeManualEntry`, so a field that could not be entered on the form cannot
     become enterable by editing. Two validators that agree today disagree later.
152. Do not describe a lifecycle state by what it records without saying what it stops. Archiving
     turns the safety watch off - the safety inbox filters `lifecycle_state <> 'ARCHIVED'` - and
     somebody who archived a medicine expecting to still hear about a recall is relying on
     something Kynviora stopped doing (DEC-084). Above the control, never under it.
153. Do not keep `stopped_on` when an item goes back into use. The column holds the current fact,
     not a history; "Stopped 1 June" on a medicine somebody is taking is a false statement on the
     screen a household reads most. The history is `audit_event`, which nobody can rewrite.
154. Do not leave a schema CHECK as the only enforcement of something a person can type.
     `owned_item_dates_ordered` refused a stopped date before the started date and the domain had
     no rule, so it arrived as a 500 instead of a sentence naming the field. An API test found it.
155. Do not put a backtick in a SQL comment inside a template literal. It closes the string, and
     the parse error lands lines away from the cause.
156. Do not assert an `audit_event` count against a fixture whose ID is reused across tests. The
     table is append-only and refuses DELETE to every role, the owner role included, so rows from
     the previous test are still there. Give each test its own target (trap 105, second time).
157. Do not answer an ordinary action with an error panel. A save that changed nothing is refused
     on purpose - an empty save moves the version and becomes a conflict for whoever else has the
     item open - but showing it in the state a malformed barcode gets teaches people that the
     screen fails, and that is how they stop reading the panel on the occasion it matters. Tell
     them apart by the reason code, never by the message text (`13`).
158. Do not tell somebody the screen shows the other person's version when the form still holds
     theirs. The first conflict copy did. Taking the saved version is a control the person
     presses, which says what it costs beforehand and says their draft was replaced afterwards -
     replacing it silently answers the question on their behalf, which is the same failure as
     overwriting the other change.
159. Do not leave a test that boots a whole process on the suite's default 30s timeout. A PGlite
     instance plus every migration plus the seed takes most of that alone, and under the full
     suite - files in parallel, several holding their own engine - it crosses the line: one run
     failed and the next passed with nothing changed. `main.test.ts` names the allowance and says
     why. The migration count only grows.
160. Do not treat an existing append-only table as a feature. `consent_receipt` had a trigger,
     supersession, RLS policies and its own authorization tests since Stage 1, and **nothing read
     it** - so the exit criterion "revoking optional consent disables the associated behavior" was
     zero per cent met by a table that looked finished. Grep for a reader before believing a status
     line. The same question is worth asking of every other table that has never appeared in a
     `SELECT` outside its own test.
161. Do not add a consent switch without saying what withdrawing it stops **in this build**. Five of
     the eight purposes govern behaviour that does not exist here; a screen where all eight look
     alike is a screen where somebody turns off "analytics" and believes they stopped something.
     `CONSENT_ENFORCEMENT` is a total record so the question cannot be skipped, and the sentence
     says both halves - nothing happens yet, **and** your answer is kept.
162. Do not let an urgency pierce consent the way it pierces quiet hours. A `CRITICAL` alert passes
     a quiet window (DEC-078) because that is a timing preference and the alert still arrives.
     Continuing to send to somebody who withdrew consent is not a safety feature; it is sending
     without consent. The check goes first in `selectRecipients`, before the owner short-circuit,
     and the owner is not exempt from their own answer about their own device.
163. Do not add a consent check without giving every existing fixture a receipt. Four dispatch
     suites went red at once and each failure read as "nobody was selected" - which is what a broken
     selector looks like too. That they went red is the enforcement working; a suite that stayed
     green would have meant the check was not on the path. And seed it in `beforeAll`, not
     `beforeEach`: `consent_receipt` refuses DELETE to every role, so there is no cleanup for
     anybody (trap 105, fifth time).
164. Do not compute "which sentence goes beside this control" in `apps/**`. The chip that says a
     switch stops nothing, and whether the button reads "Agree" or "Turn this off", are decisions
     with a wrong answer - and `apps/**` is outside the test run (`BLK-002`), so a decision made
     there is one nothing checks. Both moved into `consentRowView` and are asserted there.
165. Do not ship a request form for something nothing acts on. `04` Phase 1.4 asks for an export and
     deletion "shell", and a settings row that opens nothing tells somebody a control exists - on
     the screen where they would go looking for it in the situation that matters. The sentence
     saying it is not built is the honest version, and it is the same choice `04` Phase 1.1's
     missing account row already made (`DEV-036`).
166. Do not assume the surface partition test covers a verb it has never injected. It built its
     requests with `method === 'POST' ? {payload} : {}` and had only ever listed `GET` and `POST`,
     so the first `PUT` route in the codebase would have been checked against nothing. Extend the
     helper with the verb, not only the list.
167. Do not close a "we cannot say which" gap by deriving the answer on the read path. Intersecting
     the item's declaration with the profile's facts is a different computation from the one the
     rule ran, over state that may have moved since - so it can name a substance the rule did not
     match on, confidently and in approved wording. Freeze the identity where the versions are
     already frozen, and let a missing one refuse the template (DEC-097, DEC-064's reasoning).
168. Do not put a foreign key on an append-only table without checking that its referential action
     can fire. `profile_assessment` raises on UPDATE and DELETE unconditionally, so ON DELETE SET
     NULL and ON DELETE CASCADE would both trip the trigger and fail the _parent_ delete rather
     than tidy anything. `supersedes_assessment_id` already carries this shape from `0006`; do not
     copy it.
169. Do not resolve a person's own words by ID and show today's version. `display_term` is editable
     and the approved template quotes it as what the rule matched, so a corrected term quoted that
     way is a false statement about what happened. Gate it on the fact version the assessment
     froze, and show neither wording when they disagree. A catalog `preferred_name` is different:
     a rename is the catalog's and the canonical key did not move, which is why the key is what
     gets stored.
170. Do not resolve a person's typed term by a different function from the one that resolves a
     printed one. The sensitivity rule intersects a declaration's canonical keys with a profile
     fact's, so two resolvers become a rule that fires on one spelling of a substance and not
     another - a spelling test wearing a safety rule's clothes. One `resolveLookupKey`, one
     `ingredientLookupKey`, and a test that asserts the two paths agree field for field.
171. Do not resolve a term against a display name. `preferred_name` and `inci_name` are labels;
     `substance_alias` is a reviewed artifact with its own provenance and its own exact-versus-
     ambiguous state. Matching on a label would let a rule fire on a mapping nobody reviewed, which
     is Phase 5.2's first exit criterion failing by the back door - and a `REJECTED` alias must
     count towards neither a match nor the ambiguity that blocks one.
172. Do not leave a derived mapping behind when the thing it was derived from changes. An edited
     `display_term` that keeps the substance the old wording earned drives a rule on a substance
     nobody typed. Re-resolve on the term and only on the term: a review stamp is not a
     re-resolution, and re-running it there would let a moved vocabulary change what a rule sees on
     an edit that never touched the word.
173. Do not add a nullable derived column without a constraint tying it to the state that explains
     it. `substance_id` and `substance_mapping_state` are a biconditional CHECK, and it caught a
     fixture written an hour earlier that set one and not the other - a record that would have
     claimed a rule could see it while carrying no substance.
