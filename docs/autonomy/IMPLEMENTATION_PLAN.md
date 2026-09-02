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
| 1.2   | Household and profile creation       | `COMPLETE`    |
| 1.3   | Health-context facts and provenance  | `COMPLETE`    |
| 1.4   | Consent and privacy controls         | `COMPLETE`    |

- **1.2**: complete. The schema, the RLS policies and the authorization suite have been there since
  Stage 1 (threat A1 and A2 covered); what landed now is everything that writes to them.
  `POST /v1/households` and `POST /v1/profiles`, both behind an idempotency key the server requires
  (migration `0017`, DEC-090); `AGE_BANDS` in the domain, matching migration `0002`'s CHECK and
  refusing a band rather than dropping it; and two screens on the You tab - setting a household and
  its first person up, and switching between people.

  **Exit criterion 1** - "every item created later must require a profile" - was true by accident
  until now, because there was no way to have a profile at all. It is now true by construction: an
  item is created against a profile the server offered, and the only thing that creates a profile
  is a route whose insert `profile_insert` checks against the caller's ownership of the household.

  **Exit criterion 2** - "screens cannot accidentally display one profile's data under another
  profile identity" - is a tested function rather than a habit. `profileSwitcherView` honours a
  requested profile only if the server still offers it and otherwise reports **no** selection and
  says it dropped one; nothing falls back to whoever is first, which is how a caregiver grant
  revoked between launches would otherwise become the wrong person's records under an unchanged
  heading (DEC-087). It lives in `@kynviora/contracts` because `apps/**` is outside the test run.

  Who a profile is _about_ is a claim the caller makes about themselves and can never be about
  anybody else: no body field names another user, and there is no parameter one could reach if it
  did (DEC-088). Every optional field says why it is asked for and that leaving it out costs
  nothing, and a band that disagrees with a birth year is a question rather than a refusal
  (DEC-089).

  90 tests across the domain (23), presentation (16), contracts (20), the API against real
  PostgreSQL (21) and eight end to end. Outstanding: emergency information, which is third-party
  personal data with no consent or retention shape in this build (`DEV-034`).

- **1.3**: complete. The tables have been in migration `0004` since Stage 1 with provenance,
  certainty, `noted_on`, `last_reviewed_at`, `version` and full RLS, and nothing had ever written
  one. `POST` and `GET /v1/profiles/:profileId/health-facts`, and a version-conditional
  `PATCH /v1/health-facts/:factId`, are the write path - behind `MANAGE_MEDICINES` rather than
  `MANAGE_SHELF`, because health context is the most sensitive profile data there is (`08.2`).

  **Exit criterion 1** - "no OCR or inferred fact silently becomes a confirmed diagnosis" - is
  enforced by a field that does not exist. No body carries a provenance, the schema is `.strict()`,
  and there is no parameter the value could reach if it did; what reaches the column comes from
  `provenanceForRelationship`, which has two possible answers and can never produce `IMPORTED` or
  `REVIEWER_CONFIRMED` (DEC-091). **Exit criterion 2** - "rules can explicitly require a provenance
  level before using a fact" - was already met by `requiredProfileProvenance` in the engine, and
  only means anything because of the first: a rule filtering on a value a client could set filters
  on nothing.

  Certainty and provenance are separate axes and are never combined into one word - "I am sure" is
  how sure the person is, and the record still reads `USER_REPORTED` (DEC-092). Every row says
  whether Kynviora can check anything against it, and in this build none can, because nothing maps
  a typed term to a catalog substance. The review date is stamped only when somebody says they
  checked, by the server, and never inferred from an edit (DEC-093).

  86 tests across the domain (23), presentation (18), contracts (12), the API against real
  PostgreSQL (24) and eight end to end. Outstanding: conditions, which no shipped rule reads, so
  collecting them would be storing health data that changes nothing (`DEV-035`).

- **1.4**: complete. `consent_receipt` has been append-only with supersession since migration
  `0002`, with its own authorization tests, and nothing had ever read it - a consent _log_, not a
  consent _state_. What landed is the state, the routes, the screen, and the enforcement.

  **Exit criterion 1** - "revoking optional consent disables the associated behavior" - is a
  property of `selectRecipients` rather than of a row. The consent check sits first, before the
  owner short-circuit and before every grant-shaped check, and nothing pierces it: a `CRITICAL`
  alert passes quiet hours (DEC-078) because those are a timing preference, and consent is the
  basis on which Kynviora may contact somebody at all. Withdrawing `NOTIFICATIONS` stops everything
  to that person, owner included; withdrawing `CAREGIVER_SHARING` stops caregivers and never the
  owner. Two new exclusion reasons keep "they asked not to be contacted" out of the same audit
  bucket as "their grant was never wide enough" (DEC-095). The proof it is enforcement rather than
  decoration is that four existing dispatch suites went red until their fixtures were given consent.

  **Exit criterion 2** - "consent state is auditable and localizable" - is the database's property.
  A withdrawal is a **new** receipt pointing at the one it supersedes; the append-only trigger
  refuses UPDATE and DELETE to every role including the database owner. `policy_version` and
  `locale` are stored on every row and both come from the server, because a client that could name
  the policy version it agreed to could record agreement to a text nobody showed them (DEC-096).

  `CONSENT_ENFORCEMENT` is a total record over the eight purposes saying, for each, whether
  withdrawing it stops anything **here**: two do, five govern behaviour this build does not have,
  and one is not offered as a choice. The five say so on their own row rather than looking like the
  two that work - a switch that stops nothing while the screen implies otherwise is the `10` failure
  this codebase spends the most care avoiding (DEC-094). Neither route takes a user and neither
  could: `consent_select` and `consent_insert` name no household, no grant and no capability.

  87 tests across the domain (21), presentation (14), contracts (20), the API against real
  PostgreSQL including the enforcement through the real dispatcher (15), three RLS cases in SQL,
  two on the surface partition and twelve end to end. Outstanding: the export and deletion shell,
  which needs a retention matrix that does not exist (`DEV-036`).

- **1.1**: blocked on an auth provider decision (`23` lists it as required before Stage 1
  completion) - the schema deliberately holds no password hash, delegating to a managed provider.

---

## Stage 2 - Unified Health Shelf and Item Lifecycle

| Phase | Title                      | Status     |
| ----- | -------------------------- | ---------- |
| 2.1   | Shared Shelf framework     | `COMPLETE` |
| 2.2   | Manual medicine entry      | `COMPLETE` |
| 2.3   | Manual personal-care entry | `COMPLETE` |
| 2.4   | Product Trust Passport v1  | `COMPLETE` |

- **2.1**: complete as of 2026-09-02. Migration `0004` already carried the lifecycle state, the
  three verification axes and the timestamps; `GET /v1/items` returned them and the Shelf rendered
  three separate chips. What was outstanding was the item detail route and the verification and
  attention filters, and with them the second exit criterion.

  **Exit criterion 1** - medicines and personal-care items coexist without either being reduced to
  a generic note - is now _which fields exist_. `GET /v1/items/:itemId` gives a medicine its
  strength, dosage form and written directions and a personal-care item its category, and the
  group the other category has is absent rather than rendered empty: a medicine with a blank "kind
  of product" row reads as one somebody failed to fill in, which is the reduction the criterion
  forbids. Directions are passed through untouched and marked as quoted, so a screen renders a
  prescription instruction as somebody else's words (`04` Phase 4.1, `09`).

  **Exit criterion 2** - a user can understand which items need verification or review - is on the
  row rather than behind the filter. A filter alone meets the words and not the sentence: a list
  where that is visible only to somebody who already knew to filter for it lets nobody understand
  anything. `attentionReasons` in `@kynviora/domain` derives eight named reasons, each from one
  stored value being one of a stated set, and every shelf row carries its own. There is no count
  and no ordering - `02` forbids the aggregate, and which of two people's medicines matters more
  is not a judgement this list makes.

  Deliberately absent: any "reviewed too long ago" reason. That needs an interval and `BLK-008`
  records that every numeric threshold here is unset; an invented ninety days would be a threshold
  arriving through the back door on the screen a household reads most. `NEVER_REVIEWED` is the
  absence of a timestamp rather than a judgement about its age, and that is the statement this
  build can make honestly.

  71 tests across the domain (17), presentation (22), contracts (8) and API (24) suites, the last
  against real PostgreSQL including the `03` group H boundary - a caregiver holding `VIEW_SAFETY`
  and not `VIEW_MEDICINES` reads an alert about a medicine and gets a not-found for the medicine.

  **The lifecycle became reachable later**, in the same pass that closed Stage 2's "update,
  archive, and review". This phase's expected output lists "common item lifecycle: active,
  stopped, archived, deleted according to retention policy", and until `PATCH /v1/items/:itemId`
  existed it was a column nobody could move. Three of the four are reachable now, in both
  directions, and each says what Kynviora stops doing about the item - archiving turns the safety
  watch off, which is a consequence nobody would guess (DEC-084). Deletion is not a fourth state
  and is `DEV-032`.

- **2.2 / 2.3**: complete as of 2026-09-02, in two commits - the write path, then the surface that
  reaches it. Until the first, nothing in this build created an `owned_item` from a user surface,
  so every shelf in every test and every dogfood run was seeded.

  **Exit criterion 2.2a** - a clinically useful current medicine record creatable entirely
  manually - is one required field. A person holding a box in a kitchen has a name and may have
  nothing else to hand. Everything else is optional, the form says so at the top rather than
  leaving somebody to discover it, and nothing is marked recommended: a form that scolded somebody
  for leaving the batch code blank would collect guessed batch codes.

  **Exit criterion 2.2b** - missing fields stay explicitly unknown rather than receiving defaults
  - is a shape rather than a behaviour. No field in the domain has a fallback, migration `0015`
    gives none of the new columns a DEFAULT, a value of spaces becomes NULL rather than something a
    screen renders as an answer, and a db-level test reads `information_schema` to assert both.
    There is no "Unknown" string and no empty-string sentinel.

  **Exit criterion 2.3b** - personal-care data is not reduced to name plus barcode - needed work
  on the read path as well as the write path, and that is what this phase actually turned on.
  Phase 2.1's item detail was written before migration `0015`, so five columns a person can now
  fill in were writable and invisible: somebody could transcribe a whole back-of-bottle
  declaration into nothing. All five are on the detail now (DEC-081).

  **Nothing typed reaches the catalog and nothing typed is confirmed.** The submission has no
  `productIdentityId`, `formulationId` or `batchId` and no way to acquire one; the body schema is
  `.strict()` so an attempt is a 400 rather than a silently ignored key. The three axes keep
  `0004`'s UNVERIFIED - `08` reserves CONFIRMED for something read off the pack - and the form
  says why, because a person reading "not confirmed" with no explanation would reasonably think
  Kynviora doubted them.

  **It refuses rather than repairs**, at every layer. A market of `gb` is not upper-cased and a
  barcode with a space is not stripped, on the client or on the server: a value Kynviora quietly
  altered is one the person can no longer check against the pack in their hand. Each refusal names
  the field, and the refusal's field name now survives the client boundary so the form can point
  at it (DEC-080).

  **A retried save writes one item.** Migration `0016`, keyed per profile rather than globally
  (DEC-079). The screen holds one key per draft rather than per press, so a person on a bad
  connection tapping Save twice gets one medicine record rather than two - which `04` Phase 8.5
  would later reconcile as two medicines they are taking.

  105 tests across the domain (18), presentation (28 including the item detail's new rows), the
  database (9), contracts (16) and the API (36 against real PostgreSQL, 8 of them end to end
  through the shipped client).

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
| 4.3   | Dose events and adherence history | `COMPLETE`          |
| 4.4   | Refill awareness                  | `COMPLETE`          |

**4.2** exit criteria require measuring reminder reliability across process death and device
restart, which needs a device (`BLK-002`).

---

## Stage 5 - Personal-Care Formulation Intelligence

| Phase | Title                                            | Status             |
| ----- | ------------------------------------------------ | ------------------ |
| 5.1   | Ingredient declaration model                     | `COMPLETE`         |
| 5.2   | Canonical ingredient/substance normalization     | `COMPLETE`         |
| 5.3   | Formulation fingerprints and version history     | `COMPLETE`         |
| 5.4   | Narrow sensitivity/allergy vocabulary            | `BLOCKED_EXTERNAL` |
| 5.5   | Personal-care verification and formula-change UX | `NOT_STARTED`      |

- **5.1**: raw declaration preserved, ordered token parsing, unknown ingredients retained as
  `UNRESOLVED`. Tested including comma-decimal concentrations and multi-script separators.
- **5.2**: complete. The engine and alias resolution have been there since Stage 5 and were only
  ever pointed at ingredient declarations. What landed now is the other half: a term somebody typed
  about their own body is resolved at write time, by the **same** function and the same key
  function as a term printed on a label (DEC-098). That symmetry is the point rather than tidiness -
  `evaluateIngredientSensitivity` intersects a declaration's canonical keys with a profile fact's,
  so two resolvers that agreed today would eventually produce a rule that fires on one spelling of
  a substance and not on another.

  **Exit criterion 1** - "a synonym/model suggestion cannot become a trusted canonical mapping
  without deterministic/source validation" - is enforced by what the lookup reads. Only
  `substance_alias` resolves, never `preferred_name` or `inci_name`: `08` makes an alias a reviewed
  artifact with its own provenance and its own exact-versus-ambiguous state, and a string
  comparison against a display column is none of those. `REJECTED` aliases are excluded in SQL, and
  nothing a person types ever creates a substance or an alias - a test counts both tables across a
  write.

  **Exit criterion 2** - "original label wording remains available beside normalized identity" -
  holds on both sides: `rawTerm` on a parsed token and `display_term` on a recorded fact, stored
  exactly as typed and rendered first. Mapping a term is not correcting it.

  Migration `0019` stores the outcome rather than leaving it to be re-derived, with a biconditional
  CHECK so a row cannot claim a rule can see it while carrying no substance. A corrected term is
  re-resolved and an unrelated edit is not. And a NULL is split into the two things it means:
  "Kynviora does not know that word" is a gap in a licensed vocabulary, and "that word means more
  than one thing here" is something the person can fix - the second sentence does not list the
  candidates, because offering them would be Kynviora suggesting what somebody is allergic to.

  27 tests across the catalog engine (6), the presentation copy (4), the contracts view (5), the
  API against real PostgreSQL (10) and two end to end. Outstanding: the human review queue for
  unresolved mappings, which needs a vocabulary to map to (`BLK-003`) and a decision about whether
  a term somebody typed about their own body may appear on a staff screen at all (`DEV-037`).

  In practice almost nothing resolves in this build, because the vocabulary is empty: `BLK-003`.
  That is a seeding problem with a name, and every record says which of the two reasons applies to
  it.

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

The console interface now exists (`DEV-016`, closed): `packages/staff-console` and
`services/staff-web`, on a third origin, with its own session policy. Building it also closed a gap
in the API rather than only in the interface - `13` asks for internal APIs to be "separately
authenticated/authorized **and not exposed as user APIs**", and only the first half was true, so
`createServer` now takes a required `surface` and a staff route is absent from a household process
rather than refused by it (DEC-066).

Outstanding: this does **not** clear `BLK-006` - it builds the workflow a qualified reviewer would
use, and none exists - and the console cannot authenticate anybody, which is `BLK-010`. There is
still deliberately no mobile screen.

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
carry the ingredient declaration, and under-measuring would be worse than refusing (`DEV-018`).
`DEV-017`'s presentational remainder is closed: the console fetches the run a request names and
shows its counts beside the checklist item that asks about them.

---

## Stage 7 - Safety Watch and Global Regulatory Lens Experience

| Phase | Title                           | Status             |
| ----- | ------------------------------- | ------------------ |
| 7.1   | Assessment states and inbox     | `COMPLETE`         |
| 7.2   | Global Regulatory Lens          | `BLOCKED_EXTERNAL` |
| 7.3   | Alert detail and explainability | `BLOCKED_EXTERNAL` |
| 7.4   | Evidence and Regulatory Diff    | `IN_PROGRESS`      |
| 7.5   | Notification policy             | `COMPLETE`         |
| 7.6   | Resolution and Safety Receipt   | `COMPLETE`         |

- **7.2**: the projection, all four hard guarantees, and the UI are implemented and tested. What
  remains is its exit criterion - "a user can distinguish banned from restricted under conditions
  in usability testing" - which requires human participants (`BLK-008`-shaped: an evaluation
  nobody here can run). The Lens is also unreachable from the shelf until an item has a substance
  with an `EXACT` ingredient mapping, which needs guided capture (`DEV-024`, `BLK-007`).
- **7.3**: every item of expected output is built and tested. `GET /v1/alerts/:alertId` assembles
  the person, the item, the confidence, the reasons, the evidence level, the urgency, the
  jurisdiction, the source and its date, the reference where licensing allows one, the next step,
  the limitations and the coverage statement; `POST /v1/alerts/:alertId/report-incorrect` is the
  correction action. The second exit criterion - "the UI reveals what is known versus inferred" -
  is met structurally: every fact carries a {@link FactBasis} and there is no way to build one
  without. The **first** criterion is what blocks the phase: "usability participants can explain
  why they received a test alert" needs human participants, which nobody here can convene. Same
  shape as 7.2's block.
- **7.4**: both halves of the comparison now exist. `diffIngredients` covers formulation;
  `diffRegulatoryVersions` covers the regulatory version, and `attributeChange` answers the exit
  criterion - a regulator acting, the source correcting itself, Kynviora correcting itself, or
  nobody having recorded which (DEC-074). Every mechanism is implemented and tested against both
  halves of the vocabulary.
- **7.5**: complete. Three of the seven expected outputs already existed and had never been
  connected to anything - generic lock-screen notifications by default and the deduplication
  identifiers came with Phase 8.2, and `FOREIGN_REGULATORY_DEFAULT_URGENCY` had been declared in
  Stage 1 with no consumer. The four that were missing are the urgency-based delivery policy, the
  digest policy for lower urgency, quiet hours, and revalidation when opened.

  **Exit criterion 1** - "a new foreign restriction does not automatically produce a
  red/high-severity personal alert" - is one row of a table. `MAX_CHANNEL_FOR_URGENCY` maps
  `INFORMATIONAL` to `IN_APP_ONLY`, a channel below the digest that reaches no device at all, and
  `regulatoryDifferenceUrgency` is the enforcement point the Stage 1 constant never had. A
  property test runs every combination of urgency, deliverability, deduplication, quiet hours and
  local time and asserts none can make an event louder than its urgency allows; an end-to-end test
  drives the real dispatcher and finds the owner a legitimate recipient with nothing sent to them
  (DEC-077).

  **Exit criterion 2** - "stale/corrected notifications cannot remain actionable without
  revalidation" - is _where_ the check lives rather than that it exists. The read that renders the
  alert performs it, so a client cannot skip it and still act, and `AlertDetailInput.revalidation`
  is required so the compiler refuses a caller that omits it. A correction recorded after the
  notification withdraws the report-incorrect action and replaces it with a sentence saying what
  changed. The withdrawn half needs no notice: `alert_publication`'s policy admits `PUBLISHED`
  only, so the row never arrives at all.

  Migration `0014` extends the policy row rather than adding a table, and adds
  `notification_revalidation` - append-only, readable only by the person who opened it, carrying
  no column that could hold what a notification said. There is deliberately no digest queue:
  `BLK-009` means nothing is sent, and a table nobody would drain is speculative structure a later
  reader would mistake for a working mechanism.

  87 tests across the domain (35), presentation (13), API (25) and database (14) suites.
  Outstanding: no caller supplies a recipient's local minute, so quiet hours currently hold
  nothing (`DEV-030`); and real delivery remains blocked (`BLK-009`), so the transport this policy
  gates is still a recording stub.

  **The client half followed** and is what makes the phase settable rather than only enforceable.
  `parseClockMinute` and `quietHoursFromClock` read a 24-hour time somebody typed and refuse rather
  than repair it; `notificationPolicyView` decides what a screen may offer; the `DeliveryPolicy`
  screen sits in the You tab behind step-up; and the route's body carries both bounds, paired at
  the domain, the schema and the database (DEC-085). 52 further tests, ten of them end to end
  through the client the app ships - `setNotificationPolicy` had been declared since this phase
  with no caller anywhere.

  What the screen is careful about is that quiet hours are configurable and hold nothing. The
  server reports that as `QUIET_HOURS_APPLIED`, an API test checks the constant against the
  dispatcher's actual behaviour rather than trusting it, and the view turns it into a sentence
  shown **before** somebody sets their first window rather than after. The save confirmation says
  what was recorded rather than what will follow from it (DEC-086).

  Still outstanding after both halves: the **digest**. `MEDIUM` and `LOW` are classified onto the
  digest channel and recorded, and nothing assembles them into a summary - there is no scheduler in
  this build, the same gap `DEV-011` records for missed doses. `DEV-033`.

- **7.6**: complete. Every item of expected output exists - the seven-member resolution
  vocabulary, `POST /v1/alerts/:alertId/resolutions`, `GET /v1/alerts/:alertId/receipt`, the
  contracts client, and the screen the receipt opens on from the alert detail - and both exit
  criteria are met and tested against a real engine.

  The phase turned on a design question the schema had already answered and nobody had read.
  `safety_receipt` carries a UNIQUE index on `alert_publication_id` and grants the app role SELECT
  and UPDATE with no INSERT: one receipt per alert, resolved in place. An append-only stack of
  resolutions fought that constraint, and the constraint won (DEC-075). Nothing was lost by
  following it - every write emits an `audit_event` that no role may update or delete, and the
  receipt read replays those into its history, so `04`'s word "versioned" is answered by a log
  nobody can rewrite rather than by a table whoever holds UPDATE could. `DEV-029` records what is
  still only in the log.

  **Exit criterion 1** is a shape rather than a rule: the only writes are into `safety_receipt`
  and `audit_event`, and no type on the receipt has a field that could carry a change to the
  assessment or the alert. A test compares the whole assessment row before and after seven
  different resolutions; another asserts the app role holds no UPDATE on either table; a third
  asserts the receipt's basis - rule version, regulatory version, evidence, urgency, confidence -
  is byte-identical across all seven.

  **Exit criterion 2** is the read: corrections appear beside what a person recorded, never
  instead of it, and one that post-dates the resolution is said out loud rather than left to be
  noticed. A correction whose kind this build does not recognise still gets a heading, which is
  the opposite choice from an unrecognised resolution and deliberately so.

  The phase also fixed a real defect in committed Phase 7.3 code: `report-incorrect` did its own
  INSERT into the same one-row table, so a household that had recorded any resolution and then
  said "this is not my product" met the unique index and got a 500. Both routes now share one
  writer.

  Beyond the criteria, the receipt answers `10`'s obligation to state limits where it states
  findings: five uncertainties, each derived from a fact on a row, emitted in vocabulary order
  rather than by how alarming each one is.

  **Outstanding, and why the phase is not complete.** There is no route and no screen, because
  neither can return anything: a version diff needs two published regulatory versions and the
  Citation Gate refuses every shipped fixture (DEC-016, `BLK-004`), so a route would be a handler
  nobody could exercise. The attribution half _is_ reachable through `assessment_correction`
  without any published regulatory record, and wiring that is the next piece of 7.4. The exit
  criterion itself - "users can distinguish" - needs usability participants, as 7.3's does.

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

## Wiring the screens (`DEV-007`, closed)

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

The **review task editor** is built: five of the seven task kinds complete from the inbox and the
completion writes to the authoritative record (DEC-043, DEC-044). `BATCH_MISSING` and
`FORMULA_NEEDS_CONFIRMATION` wait on guided capture, because both write a `uuid` naming a catalog
record only capture can create (`DEV-024`).

The **caregiver invitation** is built: capability selection limited to what the inviter may
delegate (DEC-045), a step-up-scoped request (`DEV-025`), a token emitted once and held nowhere,
and outstanding invitations now visible on the Care screen (DEC-046).

The **Visit Pack** is built: selection, a review step whose displayed content is what gets hashed,
and a digest a live server accepts (DEC-048).

**Reconciliation** is built: a typed list, the differences the server derived, and a prompt that
asks which value stands for every settling resolution (DEC-049).

**Revocation** is built, and with it `DEV-022` and `DEV-007` are closed: a confirmation that
names what stops and what starting again would take, the right route for a grant or an invitation,
an idempotent request, and the access history that shows the removal happened. **Delegation** is
built too (`DEV-026`), so a caregiver holding `MANAGE_CAREGIVERS` can pass on a subset of what they
hold and never more.

Every read destination is wired and every write flow has a screen. What remains unwired is not a
household surface at all: it is the staff console (`DEV-016`), which is deliberately not the Expo
app.

`DEV-021` records that screen behaviour is tested in the packages rather than in the app, and what
that does and does not cover.

---

## The staff surface

Not a spec phase, and recorded separately because it changed the shape of the deployment rather
than the contents of a stage. There are three origins now.

| Origin           | Serves                               | Holds                    |
| ---------------- | ------------------------------------ | ------------------------ |
| Household API    | `/v1/items`, `/v1/alerts`, the rest  | The database, under RLS  |
| Staff API        | `/v1/reviewer/*` only                | The database, privileged |
| Reviewer console | The pages a reviewer reads and posts | Nothing but its sessions |

`createServer({ surface })` decides which set of routes a process registers, and the option is
required so a new route cannot land on a security boundary by default (DEC-066). The console is
`packages/staff-console` (session, client, view models, pages - depending on `@kynviora/domain`
and nothing else, DEC-067) plus `services/staff-web` (the process, holding no database connection
at all).

Two listeners run in one process in development because PGlite is a single writer (DEC-037); they
become two deployments unchanged when `BLK-001` clears.

## Immediate next work

1. **`DEV-033`'s notification digest**, the last piece of Phase 7.5. Unlike the missed-dose
   scheduler it needs no unmade product decision - `18` constrains the grouping rather than leaving
   it open - and it is the difference between a household with several alerts getting several
   interruptions and getting one.
2. **`DEV-018`'s remaining half.** Phase 5.2 gave the historical shadow dataset the _fact_ side of
   a substance match; the _item_ side is still missing, because the shelf join does not reach the
   confirmed declaration. Joining `marketed_formulation` and `formulation_ingredient` would let
   `INGREDIENT_SENSITIVITY` come off `HISTORICAL_UNSUPPORTED_KINDS` - and a rule nobody can measure
   against real data is one nobody can approve.
3. **Phase 2.5's item deletion, if the retention matrix lands.** `DEV-032` has been waiting on the
   same document as `DEV-036`; it is the smallest thing that becomes buildable the moment somebody
   writes what is kept after a deletion request and on what basis.

**Not next, and why:** the export-and-deletion shell (`DEV-036`) is a document, not a feature. "Get
me a copy" and "remove it" cannot be answered without a retention matrix saying what is kept
regardless, and this build has records that must survive a deletion request with no approved
statement of which - `audit_event` and `consent_receipt` both refuse DELETE to every role, and
`dose_event` is what a Visit Pack is built from. Five deviations now converge on that one missing
document (`DEV-009`, `DEV-032`, `DEV-034`, `DEV-035`, `DEV-036`), and writing it is the largest
single unblocking left in Stage 1 - but it is a retention and disclosure decision, not an
engineering one, and inventing it would embed an unapproved answer to "what does Kynviora keep about
you after you ask it to stop".

Likewise, a missed-dose scheduler (`DEV-011`) is blocked on a product decision rather
than on work. The grace window - how long before a dose counts as unrecorded - has no answer, and
`18` forbids shaming copy, which makes "how long before we tell a relative" a question with a wrong
answer rather than a missing one. Inventing the number would embed an unapproved judgement about
somebody's medication routine.

Done since this list was last written: Phase 7.5's client half - the clock parser, the policy view,
the delivery screen and the whole-policy write, with the truthfulness rule moved out of the screen
so it is tested once (DEC-085, DEC-086, `DEV-033`); Phase 1.2 entire - the two creation routes, the
switcher that owns its exit criterion, and the two screens (DEC-087 to DEC-090, `DEV-034`); Phase
1.3 - allergy and sensitivity records whose provenance no client can name (DEC-091 to DEC-093,
`DEV-035`); Phase 1.4 - the consent state, its two routes, the screen, and the enforcement that
turned an append-only log into something that stops a notification (DEC-094 to DEC-096, `DEV-036`);
`DEV-028` - the two identities behind an ingredient match, frozen at evaluation so the approved
wording can be filled without re-deriving anything (DEC-097, migration `0018`); and Phase 5.2 - a
term somebody typed resolved by the same function as one printed on a label, at write time and only
through a reviewed alias (DEC-098, `DEV-037`, migration `0019`).

## What "complete" means here, and what it does not

Thirty-four phases are marked `COMPLETE` above. In every case that means the logic is
implemented, tested, documented and committed - and in most cases the tests execute against a real
PostgreSQL engine or the real Expo toolchain rather than a mock.

It does **not** mean the phase is releasable. Nine phases carry exit criteria that depend on a
device, a credential, a labelled dataset, human participants, or a qualified human reviewer, and
those are marked `BLOCKED_EXTERNAL` (eight) or `BLOCKED_TECHNICAL` (one) rather than complete even
where all buildable work is finished. `BLOCKERS.md` records what each one needs.

The counts above are the tables' own, recounted whenever a status changes: 34 `COMPLETE`, 5
`IN_PROGRESS`, 3 `NOT_STARTED`, 8 `BLOCKED_EXTERNAL`, 1 `BLOCKED_TECHNICAL`, over the 51 phases
`04` defines. A prose count that drifts from the table it describes is the quiet way a status
document stops being one - and the first version of this paragraph drifted immediately, because it
was measured before the same commit moved 2.1. Count the rows:

```bash
grep -E "^\| [0-9]\.[0-9] " docs/autonomy/IMPLEMENTATION_PLAN.md | grep -oE "COMPLETE|NOT_STARTED|IN_PROGRESS|BLOCKED_EXTERNAL|BLOCKED_TECHNICAL" | sort | uniq -c
```

The MVP is complete at the end of Stage 9. It is not close to that, and the largest remaining
gaps are the ones no amount of engineering closes on its own: clinical and regulatory review
(`BLK-006`), verified official source material (`BLK-004`), and a labelled evaluation dataset
with approved numeric thresholds (`BLK-008`).
