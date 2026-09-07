# Kynviora - Specification Deviations

Every meaningful difference between the specification set and the implementation. Per the
operating brief: a deviation is not inherently a failure; an undocumented deviation is.

---

## DEV-001 - Regulatory fixtures ship unpublished and gate-rejected

- **Affected specification**: `03` MVP demo scenario step 9 ("show at least two genuinely
  different supported jurisdiction statuses from reviewed fixtures/official-source adapters");
  `04` Phase 6.4.
- **Expected behaviour**: the Global Regulatory Lens displays reviewed jurisdiction statuses.
- **Implemented behaviour**: the Lens is fully implemented and demonstrably renders materially
  different EU / GB / NI / US statuses, but every shipped fixture carries
  `verification: NEEDS_PRIMARY_VERIFICATION` and `reviewState: IN_REVIEW`, so the Citation Gate
  rejects it. Publishing requires a test-only helper.
- **Reason**: research produced these facts from search-result summaries, not retrieved official
  documents (`RESEARCH.md` R-004/R-005; `BLK-004`). `25` and `23` D-015 require a retained
  official source and a named reviewer. Shipping them as published truth would be fabricating
  regulatory approval, which the operating brief prohibits.
- **Temporary or permanent**: temporary. Resolved by retrieving official documents and obtaining
  qualified review.
- **Risk**: the demo shows real engine behaviour over honestly-labelled unverified data rather
  than over approved data. The risk of the alternative - shipping unverified regulatory claims as
  truth - is materially worse.
- **Required future work**: `BLK-004`, `BLK-005`, `BLK-006`.

## DEV-002 - `MarketCode` introduced as a type distinct from `Jurisdiction`

- **Affected specification**: `07` domain model, which uses "market" and "jurisdiction" without
  formally separating them.
- **Expected behaviour**: implied single notion of market/jurisdiction.
- **Implemented behaviour**: `MarketCode` (ISO 3166-1 alpha-2, where a package was bought) is a
  separate branded type from `Jurisdiction` (a regulatory context Kynviora monitors), with an
  explicit `jurisdictionsForMarket()` mapping.
- **Reason**: they are genuinely different. `EU` is a jurisdiction and not a market code; a
  package bought in Brazil has a valid market and no monitored jurisdiction; and a `GB` market
  maps to **both** the GB and NI jurisdictions, which is what surfaces the Windsor Framework
  divergence `23` D-013 requires instead of hiding it. Conflating them would let an unmonitored
  market silently masquerade as a consulted regulator, undermining `23` D-014.
- **Temporary or permanent**: permanent. This strengthens the spec's intent rather than departing
  from it.
- **Risk**: low. Additive.
- **Required future work**: none. The EU member-state market list should be reviewed if
  membership changes.

## DEV-003 - `RegulatoryApplicability` added as a second axis

- **Affected specification**: `09`, which lists `CONDITION_UNKNOWN` alongside the match-confidence
  values (`EXACT`, `PROBABLE`, `UNCONFIRMED`, `NOT_MATCHED`).
- **Expected behaviour**: `CONDITION_UNKNOWN` as an additional match-confidence member.
- **Implemented behaviour**: a separate `RegulatoryApplicability` axis
  (`APPLIES`, `DOES_NOT_APPLY`, `CONDITION_UNKNOWN`, `IDENTITY_UNCERTAIN`) carried alongside the
  status list, with `MatchConfidence` left intact for its own purpose.
- **Reason**: status and applicability answer different questions from different sources - the
  regulation says what the rule is, the package evidence determines whether it can be evaluated.
  Folding applicability into match confidence forces a lossy choice and makes the
  "restricted rendered as banned" failure (`A12`) easier to reach. See DEC-007.
- **Temporary or permanent**: permanent.
- **Risk**: low. Presentation must render both axes; tests enforce this.
- **Required future work**: none.

## DEV-004 - Implementation order departs from strict stage sequence

- **Affected specification**: `04` stage ordering.
- **Expected behaviour**: Stage 0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9.
- **Implemented behaviour**: Stage 0, then Stage 1 persistence and authorization, then the
  Stage 3/5 catalog engine and Stage 6/7 regulatory engine as pure logic, ahead of the Stage 2
  and Stage 4 user-facing surfaces.
- **Reason**: `04` states "Some backend, clinical, design, and security work can run in parallel",
  and the operating brief section 47 requires prioritising one end-to-end vertical slice over
  many half-built systems. The deterministic engines are where the safety-critical correctness
  lives and are fully verifiable in this environment, whereas the mobile surfaces cannot be
  device-tested here (`BLK-002`). No phase is omitted; the ordering within the dependency graph
  is adjusted.
- **Temporary or permanent**: temporary - an ordering choice, not a scope change.
- **Risk**: low. Tracked in `IMPLEMENTATION_PLAN.md`, where every phase retains an explicit
  status.
- **Required future work**: complete the deferred Stage 2 and Stage 4 surfaces.

## DEV-005 - Corroboration threshold set to three independent groups

- **Affected specification**: `08` "Independent corroboration", which requires a policy-driven
  transition without specifying a number. `23` lists corroboration policy as a decision required
  before Stage 3 completion.
- **Expected behaviour**: an approved product threshold.
- **Implemented behaviour**: an engineering default of three independent contribution groups,
  with duplicate rejection by content and perceptual hash.
- **Reason**: two groups would let a single attacker with one spare account reach the threshold
  (`A11`). Three plus duplicate rejection makes cheap promotion substantially harder. The value
  is configurable via `CorroborationPolicy`.
- **Temporary or permanent**: temporary. It is an engineering default, **not an approved product
  threshold**, and is documented as such in the code.
- **Risk**: the number has not been validated against real contribution patterns and may be too
  strict (slow catalog growth) or too lenient (poisoning).
- **Required future work**: product and data-safety sign-off; validation against the metrics in
  `22`.

## DEV-006 - Invitation lifetime defaults set without product approval

- **Affected specification**: `04` Phase 8.1 lists an "expiration option" without specifying a
  default or a maximum. `23` lists retention and lifetime policy as decisions requiring approval.
- **Expected behaviour**: an approved invitation lifetime policy.
- **Implemented behaviour**: an engineering default of 7 days with a hard maximum of 30, enforced
  by `invitationExpiryFor` and by a NOT NULL `expires_at` column - an invitation that never
  expires cannot be represented.
- **Reason**: an invitation is a bearer credential to health data sitting in an inbox, so an
  unbounded lifetime is the realistic leak path. Some bound had to be chosen to ship the flow;
  7 days is long enough for a non-technical recipient to act without becoming a standing
  credential.
- **Temporary or permanent**: temporary. These are **not approved product thresholds** and are
  documented as such in the code.
- **Risk**: low to moderate. Too short creates support burden for older recipients; too long
  widens the leak window. Neither is a safety defect.
- **Required future work**: product sign-off on the default and the maximum, and a decision on
  whether an owner may issue a non-expiring invitation at all.

## DEV-007 - Caregiver screens are built but not wired to the network layer

- **Affected specification**: `04` Phase 8.1 expected output includes the user-facing flow;
  `06` Journey 6 describes the full screen sequence.
- **Expected behaviour**: a working invite, review, accept and revoke journey on a device.
- **Implemented behaviour**: the API contract, the domain decisions and the presentation layer
  are complete and tested. `CaregiverAccessList` renders every required screen state and
  typechecks against the real contract, but the Care tab renders the `loading` state because the
  mobile repository and navigation for this flow are not built.
- **Reason**: the mobile app cannot be run or verified in this environment (`BLK-002`), and `06`
  requires each critical route to define its loading, empty, offline and error states. Rendering
  fabricated caregiver rows to make the screen look finished would be worse than rendering none:
  on this screen a wrong row is a false statement about who can see a person's health data.
- **Temporary or permanent**: temporary.
- **Risk**: low. Nothing depends on the unwired screen, and the authorization it would display is
  server-side and fully tested.
- **Required future work**: the mobile repository, invite/review/accept navigation, and the
  device-level verification `BLK-002` blocks.

## DEV-008 - Result guards changed to named union arms

- **Affected specification**: none directly; `12` requires distinguishable error classes and this
  is the mechanism that makes them usable.
- **Expected behaviour**: `if (isErr(r)) return ...` narrows `r` to the success arm afterwards.
- **Implemented behaviour**: it did not. `Result` was a union of two inline object literals, and
  a type predicate written against an inline literal does not subtract the matching arm, so
  `r.value` failed to compile after an early return and every existing call site checked `r.ok`
  by hand instead.
- **Reason**: found while writing the caregiver routes. The arms are now named interfaces (`Ok`,
  `Err`) and the guards are declared in terms of them, which narrows both branches. No behaviour
  changed and no call site needed updating.
- **Temporary or permanent**: permanent.
- **Risk**: low. Purely a type-level change; the full suite passed unchanged immediately after.
- **Required future work**: none.

## DEV-009 - Visit Pack retention set without an approved retention policy

- **Affected specification**: `16` requires temporary export objects to expire and requires a
  retention matrix to be defined before production, without naming a value. `23` lists retention
  policy as a decision requiring approval.
- **Expected behaviour**: an approved retention period for generated exports.
- **Implemented behaviour**: an engineering default of 72 hours with a maximum of 14 days,
  enforced by `visitPackExpiryFor` and by a NOT NULL `expires_at` with a CHECK that it follows
  generation - a pack that never expires cannot be represented.
- **Reason**: 72 hours covers "generated the night before an appointment" without leaving a
  shareable view of someone's medicines alive indefinitely. A value was needed to ship the flow.
- **Temporary or permanent**: temporary. Documented in the code as an engineering default, not an
  approved retention policy.
- **Risk**: low. Expiry is evaluated against the clock on every retrieval, so changing the value
  needs no migration and no sweep.
- **Required future work**: the retention matrix `16` requires, and a decision on whether a pack
  should be retained (revoked but readable) or removed at expiry.
- **Resolved 2026-09-05** (DEC-117). The matrix is `docs/RETENTION.md` and it **approves the values
  already implemented**: 72 hours by default, 14 days maximum, never permanent. Nothing in the code
  changed, which is the outcome worth noting - the engineering default was the right one, and the
  deviation was about it being unapproved rather than about it being wrong.

  The open question is answered too, and the answer is neither of the two this entry offered: **the
  content goes and the row stays.** The manifest and the notes are purged within 24 hours of
  expiry, so nothing readable survives; the row survives to the profile's own boundary, so "a pack
  was created and has expired" is still answerable. Retaining a revoked-but-readable pack would
  leave a shareable view of somebody's medicines alive past its deadline; removing the row entirely
  would make an export somebody took unaccountable.

  Implemented in `0023`, swept by `runPurgeSweep`, measured by `db/purge.test.ts`.

- **Status**: **RESOLVED 2026-09-05**.

## DEV-010 - Recent-item-changes section is time-windowed by an unapproved threshold

- **Affected specification**: `03` group I and `04` Phase 8.4 list "recent item changes" and
  "recent medication changes/events if selected" without defining recent.
- **Expected behaviour**: a product-defined window.
- **Implemented behaviour**: 90 days, applied to stopped items, as `RECENT_CHANGE_WINDOW_DAYS`.
- **Reason**: a stopped medicine is often the single most useful line on a handoff page, and an
  unbounded window would eventually make the section unreadable. 90 days spans a typical review
  interval.
- **Temporary or permanent**: temporary.
- **Risk**: low. The section is never included unless the user selects it, and the window only
  affects what is offered.
- **Required future work**: product sign-off, ideally informed by what clinicians say is useful.

## DEV-011 - Missed-dose delivery has no scheduler behind it yet

- **Affected specification**: `04` Phase 8.2 lists an optional missed-dose permission; `04` Phase
  4.3 owns dose recording, and nothing in either phase defines when a scheduled dose becomes
  "not recorded yet".
- **Expected behaviour**: a scheduler that observes a passed occurrence and dispatches.
- **Implemented behaviour**: `dispatchAlert` accepts `MISSED_DOSE` with a caller-supplied
  `doseOccurrenceKey`, enforces `RECEIVE_MISSED_DOSE`, renders non-judgemental copy and dedupes
  per occurrence per recipient. No component currently calls it with a real occurrence: the
  grace window that decides when a dose counts as unrecorded is a product decision nobody has
  made, and `18` forbids shaming copy, which makes "how long before we tell a relative" a
  question with a wrong answer rather than a missing one.
- **Reason**: the authorization and disclosure half of the feature is complete and testable
  without it, and inventing a grace window would embed an unapproved judgement about somebody's
  medication routine.
- **Temporary or permanent**: temporary.
- **Risk**: low. The permission is enforced and tested; nothing is delivered that should not be.
  The gap is that nothing is delivered at all until a window is chosen.
- **Required future work**: a product decision on the grace window, then a scheduler that derives
  occurrence keys from `medicine_schedule` and calls the existing dispatch.

## DEV-012 - Review Inbox intervals are engineering defaults

- **Affected specification**: `04` Phase 8.3 names the task kinds - "item not reviewed recently",
  "caregiver grant expiring", "refill estimate needs review" - without defining recently, soon or
  stale. `23` lists these as product decisions.
- **Expected behaviour**: product-defined intervals, ideally informed by what people actually find
  useful rather than annoying.
- **Implemented behaviour**: `ITEM_REVIEW_INTERVAL_DAYS = 180`, `GRANT_EXPIRY_NOTICE_DAYS = 14`,
  `REFILL_ESTIMATE_STALE_DAYS = 30`, each a named constant in `reviewInbox.ts` rather than a
  literal inside a query.
- **Reason**: 180 days is roughly a medication-review interval and long enough that a shelf of
  twenty items does not generate a wall of work. 14 days gives time to arrange a renewal without
  the notice sitting around so long it becomes furniture. 30 days matches the outer edge of a
  typical supply cycle. All three are judgement, not evidence.
- **Temporary or permanent**: temporary.
- **Risk**: low, and asymmetric in the safe direction - the failure mode of a wrong interval is a
  list that is too long or too short, never a missed safety alert. The inbox is explicitly not a
  safety surface and its copy says so.
- **Required future work**: product sign-off on all three. Changing any of them is a one-line
  edit by construction; a test asserts each is a positive integer so a change cannot silently
  disable a task kind.

## DEV-013 - Inbox derivation runs on read rather than on a schedule

- **Affected specification**: `04` Phase 8.3 does not say when review tasks are generated. `20`
  expects background work to be observable.
- **Expected behaviour**: a scheduled pass that keeps the inbox current, with the metrics `20`
  wants.
- **Implemented behaviour**: `GET /v1/profiles/:profileId/review-tasks` refreshes derivation
  before listing. Derivation is pure and idempotent, and a partial unique index over open tasks
  makes a repeat harmless, so refreshing on read is safe.
- **Reason**: no scheduler exists in this codebase yet, and adding one for a single consumer would
  be infrastructure ahead of need. Deriving on read also means the list is never stale, which a
  periodic job would not guarantee.
- **Temporary or permanent**: temporary. The derivation function takes a snapshot and a clock, so
  a scheduler can call it unchanged.
- **Risk**: low now, growing with profile size - the read does four queries over one profile.
  Acceptable at MVP scale and worth measuring before it is not.
- **Required future work**: move derivation behind a scheduler when one exists. Until then a task
  is only ever raised when someone looks, so a notification about review work is not possible -
  which is consistent with the inbox being deliberately non-urgent.
- **Partly addressed**: the queue-age metric `20` asks for now exists.
  `GET /v1/reviewer/operations` reports `review_tasks_oldest_open_age_ms` alongside the reviewer
  queue's own age (DEC-059). It measures a derived-on-read list rather than a scheduled one, which
  makes it a lower bound: a task nobody has looked for has not been raised, so it cannot be old
  yet. That is worth knowing before the number is read as an SLA.

## DEV-014 - Reconciliation matches two lists by a caller-supplied key, not by catalog identity

- **Affected specification**: `04` Phase 8.5 lists "previous/current list comparison" without
  saying how a line on one list is recognised as the same medicine on the other.
- **Expected behaviour**: Kynviora recognises that "Synthetic Tablet A 500mg" on a discharge
  summary is the shelf item the household already holds, using catalog normalization.
- **Implemented behaviour**: `diffMedicationLists` matches on a `matchKey` supplied by the caller
  and on nothing else. The shelf side keys on the owned item's own ID, so two packs of the same
  medicine stay distinct; the current side must state which shelf line each entry corresponds to.
- **Reason**: deciding that two differently-named lines are the same medicine is an identity
  judgement, and the catalog layer is where the normalization, the provenance and the ability to
  say how sure it is already live. Inventing a second, weaker matcher inside reconciliation would
  produce a confident-looking comparison built on a guess - and a wrong match here does not
  produce a missing row, it produces a **fabricated disagreement between two real medicines**,
  which is the worst possible output of this screen.
- **Temporary or permanent**: temporary in scope, permanent in shape. Reconciliation should keep
  taking a supplied key; the automatic proposal of that key belongs in the catalog resolver
  (Phase 3.4).
- **Risk**: usability, not safety. A user who does not pair the lines sees every medicine reported
  as `ONLY_IN_PREVIOUS` plus `ONLY_IN_CURRENT`, which is noisy but not wrong - and the copy for
  those kinds already says Kynviora cannot tell why a line is absent.
- **Required future work**: cache-first resolver (Phase 3.4) proposes a pairing, the user confirms
  it, and the confirmed pairing becomes the match key. The confirmation step is not optional: an
  unconfirmed automatic pairing would reintroduce exactly the guess this deviation avoids.

## DEV-015 - The current list is typed in, not read from the attached source

- **Affected specification**: `04` Phase 8.5 lists "source attachment" as expected output, and the
  workflow is framed around a discharge summary or printed list.
- **Expected behaviour**: the household photographs the new list and Kynviora extracts the lines
  from it, with field-level assertions and a confirmation step as `04` Phase 3.3 describes.
- **Implemented behaviour**: `reconciliation.source_evidence_asset_id` references an existing
  `evidence_asset`, so the document travels with the comparison and a later reader can see what
  was being compared against. The lines themselves arrive in the request body, entered by the
  person holding the document.
- **Reason**: `BLK-007` - no OCR or multimodal extraction engine is available, and Phase 3.3's
  rule is that unconfirmed machine provenance is never trusted anyway. A human-entered current
  list is the confirmed case, not a degraded one.
- **Temporary or permanent**: temporary for the capture step, permanent for the confirmation. Even
  with extraction, `09` and Phase 3.3 require the person to confirm each field before it is
  compared, because a mis-read strength would manufacture a disagreement that does not exist.
- **Risk**: low. Typing is slower, and a typo produces a visible difference the user is looking
  straight at rather than a silent one.
- **Required future work**: route the attached asset through the Phase 3.3 extraction pipeline
  once `BLK-007` clears, presenting each extracted line for confirmation before it enters the
  comparison.

## DEV-016 - The reviewer console has a backend and no interface (CLOSED)

- **Affected specification**: `04` Phase 6.6 lists a "source/evidence/legal-scope view" and a
  reviewer queue among its expected output, which implies a screen.
- **Expected behaviour**: a staff web console where a reviewer sees the queue, opens a candidate
  alongside its source documents and legal scope, works the checklist, and approves or returns it.
- **Implemented behaviour**: the API those screens would call, in full - queue, single-request view
  with every approval and a per-jurisdiction tally, decisions, execution, and the global block -
  plus the governance rules at three layers. No interface.
- **Reason**: there is no staff web application in this repository, and there should not be a
  reviewer screen in the mobile app: `0012` gives `kynviora_app` no grant on any of these tables
  precisely because the console is not a user surface (`14`). Building the household app's first
  staff screen would have contradicted the boundary this phase exists to draw. The presentation
  package is likewise untouched - its copy rules and forbidden-claim scans are about what
  Kynviora says to a household, and reviewer-facing strings are not that.
- **Temporary or permanent**: temporary. The API is the contract a console would build against.
- **Risk**: low. Nothing is publishable today regardless (`BLK-006`), and the workflow is fully
  exercised by tests rather than by a screen.
- **Required future work**: ~~a separate staff application, on its own origin and its own session
  policy~~ **done**. `packages/staff-console` holds the session, the client, the view models and
  the pages; `services/staff-web` is the process. It runs on a third origin - the household API,
  the staff API and the console are three - holds no database connection, and depends on neither
  `@kynviora/contracts` nor `@kynviora/presentation`, because those are the household client and
  the household's copy rules and `13` asks for environment isolation between the two surfaces.

  Closing this also surfaced a genuine gap in the API rather than only in the interface. `13` asks
  for internal APIs to be "separately authenticated/authorized **and not exposed as user APIs**",
  and only the first half was true: `/v1/reviewer/*` was registered on the instance that serves
  `/v1/items`. `createServer` now takes a required `surface`, so a staff route is absent from a
  household process rather than refused by it.

  What remains is not this deviation: the MFA/passkey half of `13`'s reviewer requirement is
  `BLK-010`, and it is a credential, not an interface.

## DEV-017 - Rule preview is deferred to shadow mode (CLOSED by Phase 6.7)

- **Affected specification**: `04` Phase 6.6 lists "rule preview" among its expected output.
- **Expected behaviour**: before approving a rule, a reviewer sees what it would do - which
  products and formulations it matches, how many users it would reach, and a sample of the
  matches - so the approval is informed rather than nominal.
- **Implemented behaviour**: the checklist records that the reviewer verified rule matching
  behaviour, expected matched-user volume and affected identifiers (`10`), and a high-severity
  approval is refused without those confirmations. What the reviewer looks at to make them is not
  produced by this phase.
- **Reason**: a preview worth trusting is a shadow run, and `04` Phase 6.7 is exactly that -
  shadow-run mode against synthetic and historical datasets, affected product counts,
  potential-user-match counts and false-positive samples. Building a weaker preview here would
  have produced a second, less accurate answer to the same question, and a reviewer comparing two
  numbers is worse off than one with none.
- **Temporary or permanent**: temporary. The checklist item is the placeholder and names the
  obligation.
- **Risk**: moderate, and it is why this is written down. A reviewer confirming
  `EXPECTED_MATCH_VOLUME` today is confirming a judgement rather than a computed figure, and the
  system records the confirmation either way.
- **Required future work**: ~~Phase 6.7~~ **done**. Phase 6.7 shipped shadow runs, and migration
  `0013` requires a two-person safety-rule publication to name a run of that rule (DEC-036), so
  `EXPECTED_MATCH_VOLUME` is now confirmed against a computed figure rather than a judgement. What
  remains is presentational: the single-request view returns `shadowRunId` and a reviewer must
  fetch the run separately, which a staff console would join up (`DEV-016`).

## DEV-018 - A historical shadow run cannot measure substance-matching rules — RESOLVED 2026-09-02

- **Affected specification**: `04` Phase 6.7 lists shadow-run mode "against synthetic/historical
  datasets" without qualifying which rules can be measured against which.
- **Expected behaviour**: any rule kind can be shadow-run against the real shelf, and the counts
  are what that rule would actually produce.
- **Implemented behaviour**: the historical dataset builder assembles items from `owned_item`
  joined to `batch_or_lot` and `product_identity`, and profile facts from `allergy_record`. It
  does **not** carry the confirmed ingredient declaration or the canonical substance key, so
  `INGREDIENT_SENSITIVITY` and `DUPLICATE_ACTIVE_INGREDIENT` are **refused** for a historical run
  with `historical_dataset_incomplete_for_rule`. Both kinds run normally against a synthetic
  dataset, where the caller supplies the substance keys.
- **Reason**: the alternative was to run them anyway and report fewer matches than the rule would
  really produce. An under-count on a blast-radius screen reads as "this affects nobody", which is
  the most dangerous wrong answer that number can give - and a reviewer confirming
  `EXPECTED_MATCH_VOLUME` against it would be confirming something false. Refusing is honest;
  under-measuring is not.
- **Temporary or permanent**: temporary. The join is the missing piece, not the design.
- **Risk**: low, and bounded by the refusal. The visible cost is that a sensitivity rule cannot yet
  be measured against real data, which is worth knowing when Phase 5.4 unblocks.
- **Required future work**: join the confirmed formulation declaration and the normalized
  substance keys into the historical dataset, then remove both kinds from
  `HISTORICAL_UNSUPPORTED_KINDS`. `BLK-003` gates the substance vocabulary those keys come from,
  so this is downstream of it.

### Resolved, 2026-09-02

Both halves, in the order the deviation required them: the _fact_ side came with `04` Phase 5.2
(DEC-098), and the _item_ side is the join this deviation named.

- `historicalDataset` now aggregates the confirmed declaration's canonical keys per item through
  `formulation_ingredient`, taking only `EXACT` ingredients - an ambiguous one resolved to no
  substance, and counting it would be matching on a mapping nobody made (DEC-099). It also carries
  `marketed_formulation.version_label`, which the assessment records and which was `null`.
- The profile fact's key is joined through `allergy_record.substance_id`, which Phase 5.2 made
  meaningful.
- `INGREDIENT_SENSITIVITY` is off `HISTORICAL_UNSUPPORTED_KINDS`. A run over it now reports what the
  rule would really produce, and where that is zero it is a measured zero rather than a structural
  one - which is the whole distinction this deviation was written about.
- `DUPLICATE_ACTIVE_INGREDIENT` stays on the list **for a different reason**, stated in the comment:
  the dataset can feed it and `evaluateRule` cannot evaluate it, because `09` requires validated
  reference data and clinical review before that rule may exist at all (`BLK-006`). A confident zero
  about a rule nobody has written is worse than a refusal.

Five tests, including one that runs the rule against a real shelf with a mapped ingredient and a
mapped recorded sensitivity and finds exactly the one household, one that asserts the run still
writes no assessment and names nobody, and one that holds an unmapped term to a measured zero.

## DEV-019 - A development authenticator stands in for Phase 1.1

- **Affected specification**: `04` Phase 1.1 (authentication and session lifecycle), `13` and `14`
  (reviewer console requires MFA/passkey, session expiration, no shared accounts).
- **Expected behaviour**: a real auth provider issues sessions; the API derives a `Principal` from
  a verified token; reviewer access additionally requires strong authentication.
- **Implemented behaviour**: `createDevAuthenticator` turns an `x-kynviora-dev-user` header into an
  ordinary principal, behind `KYNVIORA_DEV_AUTH=1`. It throws under `NODE_ENV=production`, returns
  `null` with no header, and grants **no** reviewer role - the console still requires a stored
  `reviewer` row, and a test asserts the seeded owner is refused by it.
- **Reason**: Phase 1.1 is unstarted because the provider is an unmade product decision, and the
  schema deliberately holds no password hash. Deciding it to unblock local development would be
  settling a product question for an engineering convenience. Without something, nothing produced a
  `Principal` and no route could be exercised by hand at all.
- **Temporary or permanent**: temporary, and structurally so - `ServerOptions.authenticate` was
  always an injected port precisely so this choice stayed deferred. The real authenticator drops
  into the same slot.
- **Risk**: low, and bounded by three tested refusals plus the absence of any staff authority. The
  residual risk is somebody running with the flag on a machine reachable from a network, which is
  why the server binds `127.0.0.1` by default.
- **Required future work**: Phase 1.1. When it lands, delete `devAuth.ts` and its test rather than
  leaving both paths available - a backdoor kept "just for development" beside a real
  authenticator is one that eventually runs somewhere else.

## DEV-020 - The local database is single-writer and development-only

- **Affected specification**: `13` (connection pooling), `21` (environments), `11` (system
  architecture).
- **Expected behaviour**: the API talks to a managed PostgreSQL over a pool, sized and measured.
- **Implemented behaviour**: `createRuntimeDb` opens PGlite against a directory. It is real
  PostgreSQL 18.3, so every constraint, trigger and RLS policy behaves as tested - but it is one
  connection, so requests are serialised, and two processes opening the same directory do not share
  state.
- **Reason**: `BLK-001`. There is no managed Postgres and no Docker here, and requiring one before
  anything could run is what had kept the project unopenable.
- **Temporary or permanent**: temporary. `RuntimeDb` is the interface a pooled implementation lands
  behind without the API changing.
- **Risk**: it measures nothing about pooling, extensions or performance under load, and it must
  not be read as having done so. The single-writer property already caused one silent failure (a
  standalone seed that reported success against an empty database), which is why seeding moved
  inside the server process (DEC-037).
- **Required future work**: resolve `BLK-001`, add a pooled implementation, and re-run the
  authorization suite against it - the suite is the thing that has to pass unchanged for the swap
  to be trustworthy.

## DEV-021 - Screen behaviour is tested in a package, not in the app

- **Affected specification**: `04` Phase 0.3 and `24` (UX done criteria), `06` (every critical
  route defines its states).
- **Expected behaviour**: the screens are tested as screens - rendered, interacted with, and
  asserted against.
- **Implemented behaviour**: every decision a screen makes lives in `@kynviora/contracts` or
  `@kynviora/presentation` and is tested there in Node: the state union and its copy, the mapping
  from an API outcome to a state, the view models, and every vocabulary narrowing. The React
  components take those results as props and render them. The Expo app itself is covered by `tsc`
  only.
- **Reason**: `BLK-002`. There is no Android SDK, no emulator and no device here, and `apps/**` is
  excluded from the test run. A React renderer could be added, but it would test the components
  rather than the app - and the decisions worth checking are not "does this `View` appear", they
  are "does a 404 read as a refusal" and "what does an unknown verification value claim". Those
  are now checked, where before they lived inside a component nothing looked at.
- **Temporary or permanent**: partly permanent, and deliberately. Keeping the logic out of the
  components is better design regardless of the blocker. What is temporary is the absence of any
  render test at all, and of any device verification of the accessibility behaviour `18` requires.
- **Risk**: a component could render the right data in the wrong place, use a token it should not,
  or break a touch target, and nothing here would catch it. The accessibility properties in
  particular - announcement order, font scaling, 48dp targets - are asserted about the tokens and
  not about a rendered tree.
- **Required future work**: resolve `BLK-002`, then add render tests for the five primary
  destinations and run the `18` accessibility checks on a device. Until then, treat "the app
  typechecks and its logic is tested" as exactly that claim and not as "the screens work".

## DEV-022 - The Expo screens read, and write only two things (CLOSED)

- **Affected specification**: `04` Phases 8.1, 8.3, 8.4, 8.5 (caregiver, inbox, Visit Pack,
  reconciliation), `06` Journeys.
- **Expected behaviour**: each feature's screen performs that feature's whole workflow.
- **Implemented behaviour**: the five primary destinations are wired to real reads - profiles,
  shelf, alerts, review tasks, caregiver grants, notification settings - and every write flow has a
  screen: completing a review task, inviting a caregiver, delegating as a caregiver, removing
  access, generating a Visit Pack, resolving a reconciliation difference, and recording a dose
  event with the history to read it back.
- **Reason**: each of those writes needs a screen of its own with a real interaction behind it. An
  invitation returns a token shown once and unrecoverable afterwards (DEC-018); a revocation is
  behind step-up (`14`); completing a review task writes to the authoritative record and so needs
  the editor for that record kind (DEC-027); a Visit Pack quotes a digest of exactly what the user
  reviewed (DEC-023). Wiring a button to each without those screens would produce controls that
  fail in ways the user cannot act on.
- **Temporary or permanent**: temporary.
- **Status**: CLOSED. Every read destination is wired and every write flow has a screen.
- **Risk**: none remaining. The invite and revoke controls used to be present and do nothing, which
  teaches a user they are broken; both now perform their flow.
- **Required future work**: none. What is left in this area is not wiring: Phase 4.2 reminders need
  a device (`BLK-002`), and `DEV-023` and `DEV-024` are a product decision and guided capture.

## DEV-023 - The task editor offers only the RESOLVED outcome

- **Affected specification**: `04` Phase 8.3 (`REVIEW_OUTCOMES` contains `RESOLVED` and
  `NOT_APPLICABLE`, and both write).
- **Expected behaviour**: a user can close a review task either by fixing the record or by saying
  the task does not apply to it.
- **Implemented behaviour**: the editor sends `RESOLVED` always. The API and the domain accept
  `NOT_APPLICABLE` and are unchanged.
- **Reason**: "not applicable" still has to write something - deciding a task does not apply is
  itself information about the record - and _what_ it writes differs per kind. For most kinds no
  existing field expresses it: there is no `batch_verification` member meaning "checked, this pack
  has no batch number printed on it". Adding one would be inventing a medical-record semantic,
  which is a product decision rather than an implementation detail. The one kind whose vocabulary
  already has the word offers it where it belongs: `NOT_APPLICABLE` is a value on a safety
  receipt's `resolution` field, and the editor offers it there.
- **Temporary or permanent**: temporary, and blocked on a product decision rather than on code.
- **Risk**: low. A user who genuinely cannot act on a task leaves it open, and the inbox carries no
  urgency, no count and no badge, so an open task exerts no pressure. The failure mode of the
  alternative is worse: a "not applicable" button that writes an invented value would put a
  statement about someone's medicine into the record that nobody chose.
- **Required future work**: decide, per task kind, what "this does not apply" records. Then add the
  outcome to the editor. `REVIEW_OUTCOMES` and the API need no change.

## DEV-024 - Two task kinds cannot be completed from the inbox

- **Affected specification**: `04` Phase 8.3 (a review task is completed by updating the relevant
  authoritative record), Phase 3.2 (guided package capture).
- **Expected behaviour**: every derived review task can be completed from the inbox.
- **Implemented behaviour**: `BATCH_MISSING` and `FORMULA_NEEDS_CONFIRMATION` render what they need
  and no form. The other five kinds complete normally. `taskForm` reports `completableHere: false`
  for them and `buildCompletion` refuses them before reading any value.
- **Reason**: both write a `uuid` naming another record - `batch_or_lot` and
  `marketed_formulation`. Finding or creating one is guided capture's job, with its provenance,
  corroboration and quality gate. Accepting a typed lot code and creating a batch row from it would
  put a catalog record into the database with none of those, on the way to closing a maintenance
  task. Completing them by writing only the paired `*_verification` field would be worse still: it
  closes a task called "add the batch number" without a batch number, which is a mark-done path
  under another name (trap 16).
- **Temporary or permanent**: temporary. It needs the capture flow, not a decision.
- **Risk**: two of the seven kinds accumulate in the inbox. Visible rather than hidden - the screen
  says what they need - and the inbox is deliberately unranked and uncounted, so an accumulating
  task does not become pressure. It was caught by running the completion end to end; a text box
  there would have failed for every real user with a server error.
- **Required future work**: Phase 3.2 capture, then a picker that resolves a scanned or typed code
  to a `batch_or_lot` record. At that point set `input` back from `REFERENCE` for both fields and
  the form becomes completable with no other change.

## DEV-025 - Step-up is a confirmation screen with no proof behind it

- **Affected specification**: `14` (re-authentication for exports, caregiver administration and
  account deletion; MFA or passkey), `04` Phase 1.1.
- **Expected behaviour**: a high-impact action prompts for a passkey or a second factor, and the
  session carries a verified step-up the server can trust.
- **Implemented behaviour**: `ApiProvider.elevate()` returns a client whose development session
  asserts step-up via a header. The invite screen shows a confirmation step and the caller builds
  the elevated client at the moment of sending, uses it for exactly that one request, and discards
  it. The server checks freshness independently - `hasFreshStepUp` compares the assertion against a
  fifteen-minute window on the request's own clock.
- **Reason**: Phase 1.1 has not chosen an auth provider, so there is no re-authentication to
  perform. A header is a client claim (DEC-038, `DEV-019`), and this asserts rather than proves.
- **Temporary or permanent**: temporary. What is permanent is the **shape**: a screen that states
  what is about to happen, an elevated client scoped to one request, and an ordinary client for
  everything else - so the privileged session never outlives the action. When Phase 1.1 lands,
  `elevate()` performs the real prompt and no calling code changes.
- **Risk**: bounded by the same three refusals as `DEV-019` - the development authenticator does
  not exist without the flag, throws under `NODE_ENV=production`, and grants no staff role. On a
  machine running with the flag, step-up is not a barrier; nowhere else does the header mean
  anything at all.
- **Required future work**: Phase 1.1, then `elevate()` performs the real re-authentication.
  Delete the header path at the same time as `devAuth.ts` rather than leaving both available.

## DEV-026 - A caregiver is offered no capabilities to delegate (CLOSED)

- **Affected specification**: `04` Phase 8.1, `16` (a caregiver may pass on only what they hold).
- **Expected behaviour**: a caregiver holding `MANAGE_CAREGIVERS` can invite someone else and offer
  any capability they hold themselves, except caregiver administration (DEC-020).
- **Status**: CLOSED. `GET /v1/caregiver-grants` returns `isSelf` per row (DEC-052), and
  `heldCapabilities` unions the caller's own active, unexpired grants into the input
  `inviterAuthority` always wanted. `selectableCapabilities` is unchanged - it had implemented the
  rule correctly the whole time and had never been handed anything but an empty list.
- **Implemented behaviour** (was): the Care screen passed `ownCapabilities: []`, so a non-owner was
  offered nothing.
- **Reason**: the grants listing returns every grant the caller may see, which for an administering
  caregiver includes other people's. Picking out their own means matching on the grantee's user ID,
  and the client does not carry the authenticated user's ID as a first-class value - the session
  does, but reading identity out of a development session to make an authorization decision is the
  shape of mistake `13` exists to prevent.
- **Temporary or permanent**: temporary, and now resolved.
- **Risk**: none remaining. The derivation is a usability decision and never the boundary:
  `canDelegateCapabilities` runs server-side on every request, and an end-to-end test bypasses the
  screen to confirm `CAPABILITY_ESCALATION` for a capability the caregiver does not hold.
- **What closing it also changed**: a caregiver who may delegate nothing is no longer offered the
  invite control at all. DEC-045 keeps a capability they cannot delegate absent rather than
  disabled; the same reasoning one level up, because the only reachable outcome of that control
  was a 404 after they had filled in a form.

## DEV-027 - The staff session lifetimes are engineering defaults

- **Affected specification**: `13` requires "session expiration" of the reviewer console and `14`
  requires a "session timeout"; neither states a number, and `14` requires step-up at publish and
  withdraw without saying how long one stays fresh.
- **Expected behaviour**: lifetimes set by whoever owns the security policy for staff access,
  informed by how reviewers actually work.
- **Implemented behaviour**: three constants in `packages/staff-console/src/session.ts` - an
  eight-hour absolute lifetime, a thirty-minute idle window, and a five-minute step-up freshness -
  each enforced independently and each with a stated reason. The absolute bound is what limits a
  stolen session; the idle window is what limits an abandoned desk; the step-up window is short
  because `14` asks for the confirmation _at_ the action, and one that lasted the session would be
  the control deleted and its name kept.
- **Reason**: no product or security owner exists to set them, and a console with no expiry at all
  would be worse than one with a defensible default. They are separated rather than collapsed into
  one number precisely so that changing one does not silently change the others.
- **Temporary or permanent**: temporary.
- **Risk**: low, and in the safe direction - all three are shorter than a policy is likely to
  choose. The API enforces its own step-up window and is the authority; the console's copy of it
  only decides whether to send an assertion it already knows is stale.
- **Required future work**: a security owner sets the three values; they move to configuration if
  they need to differ per environment.

## DEV-028 - An assessment does not record which inputs produced the match — RESOLVED 2026-09-02

- **Affected specification**: `04` Phase 7.3 requires an alert to be independently understandable,
  and the approved ingredient-sensitivity template names the exact ingredient and the exact
  recorded sensitivity. `09` requires the reason for a match to be explainable.
- **Expected behaviour**: an alert about an ingredient sensitivity says which ingredient matched
  which recorded sensitivity, in the approved wording.
- **Implemented behaviour**: `profile_assessment` stores `reasons` (machine codes),
  `profile_fact_versions` and `formulation_version` - versions and codes, not identities. So the
  detail route can say _that_ a substance in the declaration matched a recorded fact, and cannot
  say _which_. `explanationFor` refuses to render the sensitivity template without them, and the
  alert shows every fact, the reasons, the states and the source with no narrative.
- **Reason**: the alternative was to re-derive it on the read path by joining the item's
  formulation to the profile's allergy records and taking the intersection. That is a different
  computation from the one the rule ran - the formulation and the facts may both have moved since
  - so it could name a substance the rule did not match on. A confident, specific, approved-looking
    sentence about the wrong ingredient is worse than no sentence, which is exactly what DEC-064
    decided for the Lens.
- **Temporary or permanent**: temporary.
- **Risk**: moderate, and it is why this was written down. The affected alerts were readable but
  less useful than the spec intends, and the gap was invisible until an ingredient rule is actually
  published - which `BLK-006` currently prevents, so nobody had seen it.
- **Required future work**: add the matched identifiers to `profile_assessment` - the substance
  key and the profile fact ID the rule matched on - written by `evaluateRule` at evaluation time
  and frozen like every other field on that row. It is a migration, a change to the `Assessment`
  type, and a change to every fixture that builds one; it is not a read-path change, and it must
  not become one.

### Resolved, 2026-09-02

Exactly as the paragraph above specified, and it did not become a read-path change (DEC-097).

- Migration `0018` adds `matched_substance_key` and `matched_profile_fact_id` to
  `profile_assessment`, with three CHECKs: both or neither, never on a non-match, and no blank key.
  No foreign key on the fact ID - the table's append-only trigger means no referential action could
  fire without tripping it, and a reference a later delete could rewrite is not a frozen record.
- `Assessment.matchedInputs` is a required field, so every future writer carries it and a rule with
  nothing of this shape to name reports `null` rather than inheriting a neighbour's shape.
  `evaluateIngredientSensitivity` fills it from the fact its own filter selected.
- `replayAssessment` compares it: a recomputation that reached the same verdict while naming a
  different recorded sensitivity is a difference, not a reproduction.
- The alert detail resolves both by the frozen identity, under row-level security, so a caregiver
  holding `VIEW_SAFETY` and not `VIEW_MEDICINES` still gets no narrative. The recorded term is
  version-gated against the fact version the assessment froze; the substance name is not, because a
  canonical key is a fixed identity and a rename is the catalog's, not the person's.

Still true, and unchanged by this: nothing in this build writes an assessment in production, because
`BLK-006` means no rule is publishable. The columns are exercised by fixtures and by the replay
route.

---

## DEV-029 - The receipt table holds one row, so "versioned" is answered by the audit log

- **Affected specification**: `04` Phase 7.6 asks for "a versioned Safety Receipt carrying the
  alert, the source and rule version, the action and later corrections".
- **Expected behaviour**: read literally, a receipt is a versioned record - each thing a person
  recorded readable as its own version of the receipt, from the receipt table.
- **Implemented behaviour**: `safety_receipt` has a UNIQUE index on `alert_publication_id`
  (migration `0006`), so it holds one row per alert carrying the resolution that currently stands.
  Every write emits an append-only `audit_event`, and `GET /v1/alerts/:alertId/receipt` replays
  those into the receipt's `history` - so the chain is on the receipt as read, and it is not in
  the receipt as stored.
- **Reason**: the constraint predates Phase 7.6 by six migrations and the grant beside it says the
  same thing twice - the app role holds UPDATE and no INSERT, which only makes sense for a row that
  is resolved in place. Rewriting the schema to append would have been a migration, an RLS
  rewrite, and a new policy for a table whose current policy set is tested against threats A1-A3,
  in exchange for a property the audit log already provides more strongly: `audit_event` is
  refused to every role by a trigger, where an append-only receipt table would still be editable
  by whoever holds UPDATE on it. See DEC-075.
- **Temporary or permanent**: temporary, and possibly permanent. It becomes a real gap only if
  something other than the receipt route needs the chain.
- **Risk**: low. The history is on the surface a person reads, it cannot be rewritten, and the
  current answer is the one the schema was built to hold. The visible consequence is that a
  consumer reading `safety_receipt` directly - an export, a reviewer tool, a future projection -
  sees only what stands, and would have to join the audit log to see the rest.
- **Required future work**: if a second consumer needs the chain, add `safety_receipt_entry`
  (receipt ID, resolution, note, recorded at, actor) written in the same transaction as the audit
  row, with `safety_receipt` keeping the current answer as a denormalised head. That is additive:
  no existing policy, grant or index changes, and the route keeps one writer.

---

## DEV-030 - Nobody supplies a local time, so quiet hours hold nothing

- **Affected specification**: `04` Phase 7.5 lists quiet hours as expected output.
- **Expected behaviour**: notifications a household would rather not receive overnight wait until
  morning, in the household's own overnight rather than in a server's.
- **Implemented behaviour**: the window is stored as minutes from local midnight on
  `profile_notification_policy`, `withinQuietHours` and `deliveryDecision` apply it, and every
  layer is tested. What no caller supplies is `localMinuteOfDay`: `dispatchAlert` takes it as an
  input and every current caller passes `null`, so quiet hours currently hold nothing.
- **Reason**: Kynviora stores no timezone for anybody. There is no column for one, no device has
  ever reported one (`BLK-002`), and a stored UTC offset would be a number somebody invented that
  is wrong twice a year across a DST boundary. Converting an instant to a local minute without
  one would be inventing the answer at the moment it decides whether a person is woken up.
- **Temporary or permanent**: temporary.
- **Risk**: low, and deliberately biased. Not holding is the safe direction: the failure it avoids
  is a `CRITICAL` recall waiting for a window that never ends. The settings screen says so - the
  copy for an unknown local time reads "Nothing is being held back" rather than leaving an empty
  state that would read as "quiet hours are working" (DEC-078). That screen now exists: a person
  can set a window from the You tab, and the sentence is shown **before** they set one rather than
  after, because the person about to rely on quiet hours is the one who needs it. The API reports
  the fact as `QUIET_HOURS_APPLIED` and `notificationPolicyView` turns it into the sentence, so the
  day this deviation closes there is one constant to flip and no screen to remember (DEC-086).
- **Required future work**: the client reports its own local minute on the request that triggers a
  dispatch, or the profile records an IANA zone and the server converts. The second is better and
  costs a column, a migration and a zone database; the first is cheaper and puts the value in the
  hands of the device that actually knows it. Either way `deliveryDecision` does not change - it
  already takes the value rather than computing it, which is why this is a wiring gap rather than
  a design one.
- **Resolved 2026-09-05** (DEC-119). Both halves this entry offered, and a third it did not:

  - The **recipient** records an IANA zone on `app_user`, reported by their device through
    `PUT /v1/me/time-zone`. Not the profile - a caregiver in London looking after somebody in
    Kolkata has their own night.
  - A device-supplied minute still wins where a caller passes one, because a phone reporting its
    own clock knows better than a zone recorded weeks ago.
  - And the part neither option anticipated: **the decision had to move inside the recipient
    loop.** One `deliveryDecision` for a whole dispatch cannot express two recipients in two
    places, and it was correct only while nobody knew what time it was anywhere. That is the
    change that makes "recipient-local" mean something.

  `deliveryDecision` did not change, exactly as this entry predicted.

  The safe direction is unchanged and is now real rather than incidental: an unknown zone, an
  unrecognised one, an offset written where a zone belongs, or an unreadable instant all answer
  `null`, and `null` does not hold.

- **Status**: **RESOLVED 2026-09-05**.

---

## DEV-031 - `dose_event`'s idempotency key is still globally unique - RESOLVED

- **Affected specification**: `13` ("idempotency key on mutations that can be retried"; "server
  commits exactly once").
- **Expected behaviour**: a retried write commits once, and a key chosen by one household has no
  effect on another household's write.
- **Implemented behaviour**: true for `owned_item` as of migration `0016`, where
  `owned_item_idempotency` is UNIQUE on `(profile_id, client_operation_id)`. Not true for
  `dose_event`, where migration `0004` made `dose_event_idempotency` UNIQUE on
  `client_operation_id` alone. Under that shape, a key another household has already used makes
  the INSERT conflict; the route's replay read then runs under row-level security, finds nothing,
  and answers `200` with `{ id: null, replayed: true }` - a success for a dose event that was never
  recorded.
- **Reason**: the collision needs a client to reuse a UUID another household generated, which does
  not happen by accident and gains an attacker nothing they could not do by not sending the request
  at all - the row they suppress is their own. Changing the shape of a shipped idempotency
  guarantee is not something to do in passing while finishing a different phase, and doing it
  properly means a migration that drops and rebuilds a unique index on a table that already has
  rows, plus a re-read of the route's error branch.
- **Temporary or permanent**: temporary.
- **Risk**: low. The failure is self-inflicted and silent rather than cross-household: nobody reads
  or writes another household's row, and the `id: null` in the response is already the signal that
  nothing was returned. It is on this list because "the two idempotency guarantees in this codebase
  have different shapes" is exactly the kind of inconsistency a later reader resolves by copying the
  wrong one.
- **Required future work**: none.
- **Status**: **RESOLVED 2026-09-05**, by migration `0030`.

  `dose_event_idempotency` is now UNIQUE on `(owned_item_id, client_operation_id)`. The item rather
  than the profile, because the item is the identifier the dose route actually has - the request
  names `ownedItemId`, so the replay read can be scoped to exactly what the caller asked about, and
  the narrower the scope the smaller the set of writes one key can refuse.

  Narrowing a unique index cannot fail on existing rows: a set that was globally unique is unique
  within every item by construction. The reverse would not be, which is why this direction needed no
  data audit and the opposite one would have.

  The route's replay read is scoped to the item as well. `{ id: null, replayed: true }` survives and
  now means exactly one thing - already recorded, and not readable by this caller - which is a real
  case since DEC-116 gave `RECORD_DOSES` its own capability: somebody may be entitled to record a
  dose and not to read the shelf it belongs to.

  **Proved by reverting.** The cross-household test was run against the old global index before the
  fix was restored, and failed with `expected 200 to be 201` - the false replay this deviation
  describes, reproduced rather than reasoned about.

---

## DEV-032 - An item can be archived and not deleted

- **Affected specification**: `04` Phase 2.1 lists the common item lifecycle as "active, stopped,
  archived, deleted according to retention policy"; `16` requires deletion and export controls.
- **Expected behaviour**: a person can have an item removed, and what "removed" means is governed
  by an approved retention policy.
- **Implemented behaviour**: three of the four. `ACTIVE`, `STOPPED` and `ARCHIVED` are reachable
  from the item detail, in both directions, and every one of them says what Kynviora stops doing
  (DEC-084). `owned_item.deleted_at` exists, every read path already excludes a row that has one,
  and nothing sets it: there is no route and no control.
- **Reason**: deletion is not a fourth lifecycle state, it is a retention decision, and the
  retention matrix `16` requires does not exist - `DEV-009` records the same gap for Visit Packs
  and `23` lists retention and lifetime policy among the decisions needing approval. The questions
  a delete control has to answer are all unanswered: whether the row goes at once or after a
  window, whether the audit rows about it survive it (they are append-only and refused to every
  role, so they do), and whether a caregiver who could add an item can remove one. Shipping a
  control that guessed would put an irreversible action on somebody's medicine record on the
  strength of a number nobody approved.
- **Temporary or permanent**: temporary.
- **Risk**: low, and the safe direction. Archiving is reversible and loses nothing; the failure it
  leaves is that a person who wants a record gone cannot yet make it gone, which is a privacy
  obligation deferred rather than a safety one broken. It matters more once `04` Phase 1.4's
  export-and-deletion shell lands, because that is where a person expects to find it.
- **Required future work**: the retention matrix, then a delete route that sets `deleted_at`, an
  audit row, and copy that says plainly what survives - the audit log does, and a person told
  "deleted" while a row about them remains has been misled. `04` Phase 1.4 is the natural home.
- **Resolved 2026-09-05** (DEC-117). The retention matrix exists (`docs/RETENTION.md`) and each
  question this deviation listed as unanswered now has an answer:

  | Question                             | Answer                                                                           |
  | ------------------------------------ | -------------------------------------------------------------------------------- |
  | At once, or after a window?          | **Both.** Revocation is synchronous and total; purge follows within 30 days.     |
  | Do the audit rows survive it?        | **Yes**, 24 months, and the screen says so rather than claiming everything went. |
  | May a caregiver who can add, remove? | **No.** No capability authorises deletion, `MANAGE_MEDICINES` named explicitly.  |

  `DELETE /v1/items/:itemId` sets `deleted_at` through `kynviora.delete_owned_item`, writes the
  audit row on the same connection, and requires fresh step-up. The screen is `DeleteItem`, which
  enumerates what goes, says what is kept and why, points at archiving for the case that is
  actually archiving, and never claims anything before the server has answered.

  What the implementation added to the matrix rather than following from it is `DEV-057`: the app
  role cannot write `deleted_at` at all, so the stamp is a privileged operation for a reason that
  has nothing to do with wanting a wider hand.

- **Status**: **RESOLVED 2026-09-05**.

---

## DEV-033 - A digest is classified and never assembled - CLOSED

- **Affected specification**: `04` Phase 7.5 lists "digest policy for lower urgency" among the
  expected outputs.
- **Expected behaviour**: `MEDIUM` and `LOW` events do not interrupt anybody; they are collected
  and shown together, so a household sees them without a phone lighting up for each one.
- **Implemented behaviour**: the first half only. `MAX_CHANNEL_FOR_URGENCY` maps `MEDIUM` and `LOW`
  to `DIGEST`, `deliveryDecision` returns the channel with its reason, `dispatchAlert` sends
  nothing for any channel that is not `INTERRUPT`, and the settings screen says in words what each
  urgency does. Since `0028` the channel, its reason and whether the event was held are recorded
  **per recipient on `alert_delivery`**, so the rows a digest would be assembled from are now
  identifiable. Nothing gathers them into a summary, and there is no route, no schedule and no
  screen for one.
- **Reason**: two reasons were recorded and only one of them is still true.

  **No longer true:** "nothing runs on a cadence at all - there is no scheduler in this build".
  `services/worker` is one (DEC-121), and it keeps a durable schedule from run history rather than
  from a timer, which is exactly what an 09:00 recipient-local cadence needs. `DEV-030`, the other
  half of that argument, closed with DEC-119: a recipient's local time is known where they have
  reported a zone.

  **Still true:** nothing sends anything (`BLK-009`). A digest that is assembled and recorded is
  most of the feature and is the half `04` Phase 7.5 specifies; a digest that is _delivered_ needs
  push credentials that do not exist.

  What that changes is the shape of the remaining work rather than whether it can be done. The
  questions this deviation said were unanswerable - how often, what a person sees if they open the
  app first, whether an item resolved since collection still appears - are answerable now: the
  cadence is approved, the app already shows every one of these events through the Safety Inbox,
  and `revalidate` is what decides the third.

- **Temporary or permanent**: temporary.
- **Risk**: low, and the safe direction. Nothing is lost: the events are recorded, and every one of
  them is already reachable in the app through the Safety Inbox and the Shelf, which is what
  `IN_APP_ONLY` and `DIGEST` both mean today. The failure it leaves is that a household must open
  Kynviora to see a `MEDIUM` finding rather than being told, and `02` treats not interrupting as
  the default rather than a degradation.
- **Required future work**: none. The assembler exists (DEC-122): `services/worker` gathers each
  recipient's `DIGEST`-channel deliveries at 09:00 in their own local morning, revalidates every
  one of them **as that recipient** so row-level security decides what they may still see, keeps
  only what is still current, and records what it dropped and why.
- **Status**: **CLOSED**. The thing this deviation named - events classified for a digest and never
  gathered into one - no longer happens.

  Two things it did not cover, recorded separately rather than left inside a closed deviation:
  **sending** a digest stays on `BLK-009`, and **showing** one is `DEV-064`.

---

## DEV-034 - A profile holds no emergency information

- **Affected specification**: `04` Phase 1.2 lists "display identity, date of birth/age range,
  language, and optional emergency information" among its expected output.
- **Expected behaviour**: a profile can optionally carry whatever a household would want reachable
  in an emergency - typically a name and a phone number for somebody to call.
- **Implemented behaviour**: everything else. Display name, age band, birth year and language are
  writable from a screen and stored on `profile`; there is no emergency-information column, no
  field on the form, and no route that would accept one. The profile form says so in words
  (`PROFILE_LIMITS_COPY.noEmergencyContact`), because a form that asked for everything else and
  silently omitted it would leave somebody assuming Kynviora holds one.
- **Reason**: it is personal data about a **third party**. An emergency contact is a name and a
  phone number belonging to somebody who is not a Kynviora user, never consented to being in it,
  and has no way to ask for it to be removed - `16`'s consent model has no shape for a person who
  is not an account holder, and `DEV-009` and `DEV-032` already record that the retention matrix
  `16` requires does not exist. The disclosure question is worse than the collection one: `profile`
  is readable by every caregiver holding any viewing capability, so shipping the column as it
  stands would send a third party's contact details to everybody the owner ever granted
  `VIEW_SHELF`. There is no column-level grant on `profile` and no policy that narrows a subset of
  its columns, so "store it but show it to fewer people" is not a small change.
- **Temporary or permanent**: temporary.
- **Risk**: low, and stated rather than hidden. Nothing about the safety rules depends on it, and
  the failure it leaves is a person believing Kynviora holds a contact it does not - which is why
  the copy says the opposite on the screen where they would otherwise assume it, and a test asserts
  no sentence in the module implies Kynviora would reach anybody.
- **Required future work**: a decision on third-party personal data in a profile (who may see it,
  how long it is kept, and how somebody who is not a user asks for it to go), then a column with
  its own grant or its own table with its own policy, then the field. The consent and retention half
  belongs with `04` Phase 1.4, which is where the export-and-deletion shell lands.

---

## DEV-035 - No condition is recorded, because no approved rule requires one

- **Affected specification**: `04` Phase 1.3 lists "limited user-reported conditions only where
  approved rules require them" among its expected output.
- **Expected behaviour**: a household can record the narrow set of conditions the MVP safety rules
  need in order to be about a particular person.
- **Implemented behaviour**: the table exists and nothing writes to it. `condition_record` has been
  in migration `0004` since Stage 1 with its provenance, certainty, review date, version and full
  RLS; `ProfileFact` in the rule engine carries a `CONDITION` kind; and there is no route, no
  domain draft and no screen. Allergies and sensitivities are built in full.
- **Reason**: the spec's own qualifier is not met. **No shipped rule consults a condition.**
  `evaluateIngredientSensitivity` is the only rule that reads profile facts and it filters to
  `ALLERGY` and `SENSITIVITY`; nothing anywhere reads `CONDITION`. Collecting a condition today
  would be storing health data about somebody that changes nothing, which is precisely what `16`'s
  data minimisation forbids - and the wording "only where approved rules require them" is that
  requirement written into the phase. `BLK-006` compounds it: no rule in this build is publishable
  at all, so there is no approved rule that could require one.
- **Temporary or permanent**: temporary, and gated on somebody else's decision rather than on work.
- **Risk**: low, and the safe direction. The failure it leaves is that a rule which one day needs a
  condition has no data to run on - which is a gap that appears at the same moment the rule does,
  rather than one that silently degrades an existing feature. The opposite failure, collecting
  conditions "so they are there", is unbounded and irreversible: a person cannot un-tell a product
  their diagnoses.
- **Required future work**: a reviewer-approved rule that names the conditions it needs, then a
  closed vocabulary of exactly those (free text is not acceptable here - an open condition field is
  a diagnosis box, which `04` Phase 1.3's first exit criterion is written against), then the same
  four layers allergies now have. The provenance mechanism (DEC-091) transfers unchanged.

---

## DEV-036 - There is no export or deletion control, and the screen says so instead of showing one

- **Affected specification**: `04` Phase 1.4 lists "initial data export / deletion request workflow
  shell" among its expected output, and `16` requires a person to be able to get a copy of what is
  held about them and to have it removed.
- **Expected behaviour**: a row on the consent screen that starts a request for a copy of
  everything, and a row that starts a request for it all to be removed - even if the fulfilment
  behind them is manual at this stage.
- **Implemented behaviour**: neither row exists. The consent screen carries one sentence in its
  place: "Getting a copy of everything, or having it removed, is not built yet. Kynviora will not
  pretend otherwise by showing a button that does nothing." Everything else in Phase 1.4 - the
  eight purposes, the append-only receipts, the withdrawal path, and the enforcement in
  `selectRecipients` - is built and tested.
- **Reason**: a shell needs a retention matrix, and there is not one. **Four existing deviations
  converge on the same missing document**: `DEV-009` (Visit Pack retention), `DEV-032` (no item
  delete), `DEV-034` (emergency information - third-party personal data with no retention shape),
  and the retention question `DEV-035` inherits. "Delete my data" cannot be answered without saying
  what is kept regardless, and this build has records that must survive a deletion request and no
  approved statement of which: `audit_event` refuses DELETE to every role including the database
  owner (DEC-013), `consent_receipt` does the same, and `dose_event` is the evidential record a
  Visit Pack is built from. A shell that collected the request and left those tables untouched
  would tell somebody their data was removed when the parts that matter most were not.

  The export half is narrower but not free: `16` asks for a portable copy, and what a household
  holds spans profile facts, items, dose events, assessments and receipts, several of which quote
  source material whose redistribution is `BLK-004`'s open question. A shell that exported "some of
  it" is worse than none, because a person checks a copy once.

  What made a row genuinely unshippable rather than merely unfinished is `04`'s own word: a _shell_
  is a control that opens something. A settings row that opens nothing tells somebody a control
  exists, and this is the screen where they would go looking for it in the situation that matters -
  the same reason the You screen has never shown an account row (`04` Phase 1.1).

- **Temporary or permanent**: temporary, and blocked on a written decision rather than on work.
- **Risk**: low, stated, and in the safe direction. The failure it leaves is a person having to ask
  by some other means for something Kynviora cannot yet do - which the sentence tells them
  explicitly. The opposite failure, a request form that records an intention nothing acts on, is a
  product telling somebody their data has been dealt with when nothing has happened; a copy test
  asserts the sentence says "not built yet" and names the reason rather than promising a date.
- **Required future work**: the retention matrix `16` requires - for each table, what is kept after
  a deletion request and on what basis, with the append-only tables named explicitly. Then the
  export shape, then the two controls. This is the same document `DEV-009`, `DEV-032`, `DEV-034` and
  `DEV-035` are all waiting on, and writing it is the largest single unblocking left in Stage 1.
- **Partly resolved 2026-09-05** (DEC-117). The matrix exists as `docs/RETENTION.md`, and the two
  halves this deviation named have separated:

  **The export is built.** `GET /v1/export` assembles everything the caller may read - fourteen
  sections, scoped entirely by row-level security - and the consent screen has a control that
  opens it. The three things `DEV-036` said made a shell unshippable are all answered:

  | Objection                                   | How it is answered                                                                                                                                 |
  | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
  | "A copy of some of it is worse than none"   | The manifest lists **every** section including the empty ones, and a section that failed to read is `-1` - which no successful read produces.      |
  | "Several sections quote source material"    | Sources are **referenced**: identifier, publisher, coverage statement, last check. No source content is in the file, so `BLK-005` stays untouched. |
  | "A shell is a control that opens something" | It opens the export. The screen also says what the copy leaves out, before it is taken.                                                            |

  There is no artifact and no link. The copy is assembled per request and handed to the system
  share sheet, so nothing with a lifetime exists on the server - which satisfies the approved
  24-hour cap by construction rather than by a sweep, and is the safer of the two designs.

  **Account deletion is not.** Deleting a single item is built (`DEV-032`) and lives on the item
  screen. Removing a whole account is not, and the consent screen still says so - but it now says
  which of the two is which, because "not built yet" over both would be false in the other
  direction and would send somebody looking for a control they have walked past.

- **Status**: **PARTLY RESOLVED 2026-09-05.** The export half and the item-deletion half are
  built; account deletion remains open and is what this entry now tracks.

---

## DEV-037 - There is no review queue for unresolved substance mappings

- **Affected specification**: `04` Phase 5.2 lists "human review queue for material unresolved
  mappings" among its expected output.
- **Expected behaviour**: a reviewer surface listing terms that did not resolve, or resolved
  ambiguously, so somebody qualified can decide what they should map to.
- **Implemented behaviour**: the mapping states exist, are stored, and are reported (DEC-098), and
  nothing collects them into a queue. Both of Phase 5.2's exit criteria hold and are tested; this
  is the one item of its expected output that does not.
- **Reason**: two things are missing, and only one of them is engineering.

  **There is nothing to map to.** The substance vocabulary needs a licensed source (`BLK-003`), so
  in this build a reviewer opening such a queue would find that every item's only available action
  is "cannot map this". A queue whose entries have no possible resolution is a worklist that
  teaches its user to ignore it.

  **And the entries would be somebody's health data on a staff screen.** An unresolved mapping is a
  term a person typed about their own body. Putting it in front of a reviewer is a disclosure
  decision - who may see it, whether it can be shown detached from the profile, and whether a
  household is told - and `16` has no answer for it. `08.2` and `20` both keep subjects out of
  operational and staff surfaces, and the reviewer console has deliberately never carried a single
  household's data: `DEC-066` splits the staff API from the household one precisely so a reviewer
  account cannot read the records it reviews. A queue of typed allergy terms would be the first
  thing to cross that line, and it would cross it for a queue that cannot act.

  The queue is also the item of expected output least load-bearing for the exit criteria. Neither
  criterion mentions it: the first is about a suggestion not becoming a trusted mapping without
  validation, which is enforced by only ever resolving through a reviewed alias, and the second is
  about the original wording surviving, which it does.

- **Temporary or permanent**: temporary, and gated on a licensed vocabulary plus a privacy decision
  rather than on work.
- **Risk**: low, and the safe direction. The failure it leaves is that an ambiguous or unknown term
  stays unmapped until somebody seeds the vocabulary - which the person is told on the record
  itself, in a sentence that says which of the two it is and, where they can act, what to do. The
  opposite failure - a staff queue of household health terms, or a resolution mechanism that maps a
  term without a reviewed alias - is irreversible in the way this whole codebase is built to avoid.
- **Required future work**: a licensed substance vocabulary (`BLK-003`), then a decision on whether
  an unresolved term may be shown to a reviewer and in what form - de-identified, aggregated by
  term, or with household consent - then the queue on the staff surface. The mapping states this
  build now stores are exactly what such a queue would select on, so it is a read over data that
  already exists rather than new collection.

---

## DEV-038 - Offline writes are visible and resolvable, and what is still open is not waiting on engineering

- **Affected specification**: `12` "Repository behavior" lists a pending-operation journal,
  idempotency keys, conflict status and sync metadata alongside local query/write; `03` group J
  requires "pending user edits with deterministic sync handling"; `13` defines the sync protocol
  and `packages/domain/src/sync.ts` implements all of it.
- **Expected behaviour**: a person with no network can add an item, record a dose or correct a
  record, and the change uploads later exactly once.
- **Implemented behaviour**: the read half, and the write half for **medicine schedules** (both
  CREATE and UPDATE) and for **item edits** (UPDATE).

  The journal is built and wired: `pending_operation_v1` is a table in the same SQLCipher database
  as the projection, scoped to the session like every projection row; `drainPendingOperations`
  sends what is queued on every foreground; and `classifyUpload` reads each answer against `13`'s
  codes. An eligible write that fails as `OFFLINE` is queued and lands on the next connection.

  The create path preserves the idempotency key the failed attempt used (DEC-111) - a fresh key on
  a replay is how one CREATE becomes two rows when the original arrived and its answer did not come
  back. UPDATE queues do not need this because the write is conditional on `expectedVersion`, so a
  replay either lands once or comes back as a conflict.

  Every other write still goes straight to the API and fails as `OFFLINE`, exactly as before - and
  deliberately, per the reason below.

- **Reason**: the journal is not the missing piece; a decision about each entity is. `13`'s
  conflict policy is **per entity type**, `sync.ts` encodes it, and `isOptimisticallyApplicable`
  already says which mutations may be shown before the server has seen them - "Do not
  optimistically change caregiver grants or safety severity/publication state". Queueing writes
  without wiring that per-entity policy into each screen would produce exactly the global
  last-write-wins the specification refuses, and the first entity it would be wrong for is the
  profile fact somebody recorded about their own allergy.

  Two of the entities also have no offline story yet for a reason that is not engineering. A dose
  event created offline needs `04` Phase 4.3's duplicate-suppression against the same idempotency
  key, which exists on the server and has no client that retries. An item created offline reaches
  Phase 8.5's reconciliation, where two of the same medicine read as two medicines somebody is
  taking.

  Writing the read half alone is the split that leaves nothing half-true: what is on the screen
  is either confirmed by the server or labelled as older than it looks, and nothing is queued
  that could later be applied under a policy nobody chose.

- **What closed, and what the policy gate does**: `queue` asks `isOptimisticallyApplicable` before
  writing anything and **refuses** the types `13` resolves `SERVER_WINS` - caregiver grants,
  assessments, publications (DEC-110). A refusal rather than a warning, because a warning is a
  decision handed to whoever wires the next call site, in `apps/**`, where nothing tests it.

  **The queue is now visible and resolvable**, which is the other half of `12`'s sentence and the
  half this deviation had been open on. `PendingQueue` lists what is waiting, in the words a person
  uses - "A change to when a medicine is taken", not `medicine_schedule` - and offers what each row
  can honestly support: both "try again" and "remove" on a conflict, because `13` says the person
  decides; **only** "remove" on a rejection, because the server has read the change and retrying is
  the same refusal later; and nothing at all on one that is simply waiting, because a change about
  to be sent is not a question. Those decisions live in `pendingQueueView` where they are tested;
  the screen renders them (trap 164).

  Driven on the device: an edit saved with the API switched off appears as "1 change is waiting to
  be sent", and the section is gone after the next foreground, with the server holding the change.

  It is also why `DEV-044` could only be found by watching the wire. With nothing showing what was
  waiting, "queued and not sent" and "sent" looked identical from inside the app, and the store is
  SQLCipher-encrypted so `sqlite3` could not answer it either.

  `medicine_schedule` was wired first because Phase 4.1's route already carries both halves a
  replay needs: an idempotency key scoped to the item, and `expectedVersion` as a precondition. A
  retry either lands once or comes back as a conflict, with no third outcome to design.

- **What is still open, and why it is not engineering**:
  - **`owned_item` CREATE** reaches Phase 8.5's reconciliation, where two copies of one medicine
    read as two medicines somebody is taking - which is why only the UPDATE path is wired.
  - **`dose_event`** needs Phase 4.3's duplicate suppression to have a client that retries.
  - **`allergy_record` and `condition_record`** are `ASK_USER` under `13` and technically eligible.
    Their call sites (`HealthContext.tsx`) are not yet wired, because the conflict-resolution
    screen `12` calls "a resolvable failure state" is not built - and offering to queue a change
    the person cannot then resolve is worse than saying "not saved" upfront on this class of fact.
  - **`allergy_record` CREATE** stays unwired for a reason that is now specific rather than
    structural: `addHealthFact` deliberately carries no idempotency key, on the contract's
    reasoning that a retried create makes a second allergy row which is "visible on the list,
    correctable, and harmless". That reasoning is about a person tapping twice. A journal replays
    on its own, after an answer was lost, with nobody watching - and a second row appearing
    unbidden is a different proposition from one somebody caused. The **review** of a fact is
    wired, because it is conditional on `expectedVersion`.
  - **`condition_record`** is not wired because there is no such feature to queue from
    (`DEV-035`) - a better reason than the one this deviation used to give.
- **Temporary or permanent**: temporary, and now partial rather than absent.
- **Risk**: low and visible, and lower than it was. Somebody offline can set a medicine time and it
  arrives when the connection does. What they cannot yet do is see that it is waiting, or act on one
  that came back as a conflict - so the failure mode is a change that stays queued longer than they
  expect, not one that is lost: nothing is ever discarded, and `drainPendingOperations` leaves
  untried operations with a full attempt budget rather than spending it on a dead tunnel (DEC-109).
- **Required future work**: `dose_event` and `owned_item` CREATE once the phases they depend on
  can carry them, and `allergy_record` CREATE if that route ever takes an idempotency key. What the
  queue screen does not yet show is the two versions of a conflicted record side by side - it says
  a person decides and lets them keep or discard their own change, which is `13`'s outcome, but
  choosing between two texts they can both read would be better.

---

## DEV-039 - Phase 4.2 has no schedule to remind anybody about

- **Status**: **Closed on 2026-09-03.** Phase 4.1's write path and Phase 4.2's reminder engine both
  exist, and the engine has been measured on a device. What follows is kept because the shape of
  the gap is worth remembering: a phase recorded as blocked on the environment, whose real blocker
  was underneath and had nothing to do with hardware.
- **Affected specification**: `04` Phase 4.2 (local reminder engine): local notification
  scheduling, restart/reboot recovery, permission handling, generic lock-screen default,
  quiet-hour behaviour. Its exit criteria are reminder reliability measured across process death
  and device restart, and no sensitive medicine name on the lock screen by default.
- **Expected behaviour**: reminders fire at the times a person entered, survive the app being
  killed and the device restarting, and say nothing identifying on a locked screen.
- **Implemented behaviour at the time**: nothing. `expo-notifications` was not a dependency and no
  reminder was scheduled.
- **Reason at the time**: the phase was recorded as `BLOCKED_TECHNICAL` on `BLK-002` because
  measuring reliability across process death needs a device. That was already false when it was
  written - a device existed, and `KEY-2` in the storage harness exercised process death against
  it. What blocked Phase 4.2 was something else, and it had been underneath the environment blocker
  the whole time: **there was no way to create a medicine schedule.**

  `medicine_schedule` had existed since migration `0004` with full row-level security, and
  `packages/safety/src/schedule.ts` computed occurrences from it with deterministic tests -
  Phase 4.1's model, complete. What did not exist was any route that wrote or read a row. A dose
  event could reference a `scheduleId`, and nothing could produce one.

  A reminder engine over an empty table would have scheduled nothing, and its exit criterion -
  measured reliability across restart - would have been measured against zero reminders.

- **How it was closed**:
  - Migration `0020` added the idempotency key and the version a write path needs, and narrowed
    `schedule_insert` and `schedule_update` to `MANAGE_MEDICINES` (DEC-107). The narrowing was a
    second defect the write path exposed: 0004's policies asked only whether the caller could _see_
    the item, so a read-only caregiver could have set, moved or silently switched off somebody's
    reminders.
  - `POST`/`GET /v1/items/:itemId/schedules`, `PATCH /v1/schedules/:scheduleId` and
    `GET /v1/profiles/:profileId/schedules` - the last being what a device plans from, in one
    request rather than one per medicine.
  - `scheduleEntry.ts` in `domain` (the vocabulary both sides need), `scheduleForm.ts` in
    `contracts` (what a person typed and what gets sent), `schedule.ts` in `presentation` (the
    words), and a schedule editor on the medicine's own row on the Shelf.
  - Phase 4.2 itself: `reminderPlan.ts` in `domain`, `reminders.ts` in `contracts`,
    `expo-notifications` behind a thin adapter, and a `ReminderProvider` that re-plans on every
    foreground.
- **Temporary or permanent**: closed.
- **What replaced it**: `DEV-041`, which records what the reminder engine does _not_ do.

---

## DEV-040 - Thirteen of `19`'s fourteen device scenarios have something measured on a device, five of them only in part

- **Affected specification**: `19` "Device E2E tests" lists fourteen scenarios that must be
  covered.
- **Expected behaviour**: all fourteen exercised on a device.
- **Implemented behaviour**: thirteen have something measured, and ten automated harnesses re-run
  it (`npm run verify:device`, `npm run verify:device:a11y`, `npm run verify:device:reminders`,
  `npm run verify:device:update`, `npm run verify:device:offline`,
  `npm run verify:device:profile`, `npm run verify:device:caregiver`,
  `npm run verify:device:visitpack`, `npm run verify:device:personalcare`,
  `npm run verify:device:safety`).

  **"Thirteen" is not "thirteen scenarios done", and the table is what to read rather than the
  number.** Five of the thirteen are partial, each because a named half of the scenario does not
  exist in this build - a scanner, an OCR provider, a camera feature, a device with no space left,
  or a published alert nobody is allowed to approve. What every one of the thirteen does have is a
  run on a phone that would fail if the half that _is_ built stopped working. The fourteenth has
  nothing at all, and it is the one whose feature has not been chosen yet.

  | `19` scenario                         | State                                                              |
  | ------------------------------------- | ------------------------------------------------------------------ |
  | Android install/update                | **Covered** - data, key and reminders survive a replace            |
  | Sign-up/sign-in/recovery              | **Nothing measured.** No authentication exists (`BLK-010`)         |
  | Profile creation                      | **Covered** - a person is added, once, and shows up                |
  | Medicine add/scan/manual path         | Manual path built; no scanner (`04` Phase 2.2)                     |
  | Personal-care add/scan/OCR/confirm    | **Manual path and "confirm" covered**; no scan, no OCR (`BLK-007`) |
  | Medicine reminder after process death | **Covered**, and after a device restart as well                    |
  | Offline create/edit/sync              | **Covered** - queued, survives a kill, arrives exactly once        |
  | Safety alert open/resolution          | **Having nothing to say covered**; publishing needs `BLK-006`      |
  | Caregiver invite/revoke               | **Covered** - and revocation measured as immediate                 |
  | Visit Pack export                     | **Covered** - what was ticked, and nothing that was not            |
  | Camera/file permissions               | Notification permission covered; camera/file untested              |
  | TalkBack smoke suite                  | **Covered**                                                        |
  | Clock/time-zone change                | **Covered** - a dose does not move when the phone does             |
  | Low storage/network disruption        | **Network disruption covered.** Low storage untested               |

- **Reason**: the environment blocker is gone, and what is left is one scenario with nothing
  measured and five with a named half missing. Nothing here is waiting on hardware, and almost
  nothing is waiting on work either: every gap but one now names a decision or a credential
  somebody outside this build has to supply.

  The five worth being explicit about, because their state is easy to misread:

  **"Medicine reminder after process death" is now genuinely covered, and getting there found a
  measurement error worth remembering.** The harness first used `am force-stop`, which cancels an
  app's pending alarms outright - so it reported a working engine as broken. `am kill` is process
  death; `force-stop` is the settings button. `REM-3a` now asserts both halves of the precondition
  (no process, alarms intact) before the delivery check is allowed to mean anything, and what
  force-stop costs a real person is recorded as `DEV-041`.

  **"Offline create/edit/sync" is now covered, and getting there found two defects that every
  other gate was green over.** `npm run verify:device:offline` saves a schedule with the API
  switched off, kills the app's process, reconnects, and launches once: the queued create must go
  out on **that** launch. Then it does the same thing again with the request forwarded and its
  _answer_ destroyed, so the server commits and the phone cannot tell that from being offline - the
  replay must carry the same idempotency key and leave exactly one schedule.

  The second run is the one that cannot be faked, and it is what DEC-111 was written for. Measured:
  one key across both creates, `idempotent-replay: true` on the second, one row. A client minting a
  fresh key would pass the first run perfectly and leave somebody being told twice, at the same
  minute, to take the same tablet.

  What it took to get there was not the harness. It was `crypto.randomUUID()` in eight write paths
  that cannot run on Hermes (`DEV-043`) - so no write from the app had ever worked on a device - and
  a drain whose senders lived on tab screens, so the launch after a kill was the one launch
  guaranteed not to send (`DEV-044`).

  **The TalkBack suite is a smoke test and the report says so.** It shows the app starts under a
  screen reader, keeps running, and exposes controls with names. It does not navigate: TalkBack
  takes over touch for exploration, so an injected single tap is an explore gesture rather than an
  activation - and driving its state machine with synthetic events crashed TalkBack itself on the
  first run, which the harness then wrongly reported as Kynviora crashing. Whether the
  announcements are any good is a question for somebody listening, which `04` Phase 9.4 already
  says needs people this build does not have.

  **"Android install/update" is covered, and what it measures is narrower than its name.**
  `npm run verify:device:update` fills the store by using the app, reads the encrypted file out
  through `run-as`, installs over the existing app, and reads it again - byte-identical, the
  keystore key still opens it, no crash, and 15 of 15 reminders back after the package replace. The
  control that makes those mean anything is `UPD-1`: `firstInstallTime` unchanged and
  `lastUpdateTime` moved, because a clean install would also produce a working app with none of the
  person's data in it, and would pass every other check. What it does not cover is a build whose
  _local schema_ differs from the one on disk, because no second shape exists yet - `DEV-042`.

  **"Clock/time-zone change" is covered, and getting it to mean anything took more than changing
  the clock.** `REM-7` moves the device from `Asia/Calcutta` to `Europe/London` and asserts every
  pending dose is still at the same absolute instant - the rule being that a schedule carries its
  own zone, so the phone's zone must not decide when a dose fires (`schedule.ts`; DEC-104).

  Two things had to be true before that reading was worth having. The comparison is on the
  `origWhen` epoch from the dump's header, never on the rendered time: `dumpsys` prints every alarm
  in the device's _current_ zone, so a check comparing the printed strings would fail every row for
  a reason that is not about alarms. And the app is wiped between the two readings, because
  otherwise the check passes without testing anything - Android stores an alarm as an absolute
  instant, so alarms that merely survive a zone change are unchanged by definition, and
  `expo-notifications` re-registers from its own store on launch even after a force-stop. After
  `pm clear` every alarm read was expanded from the schedule row, in the new zone, on that launch
  (trap 177).

- **Temporary or permanent**: temporary.
- **Risk**: low, and the shape of it is known rather than hidden. The claim being avoided is "the
  device suite passes", which would read as fourteen scenarios when it is seven.
  **"Profile creation" and "Caregiver invite/revoke" are now covered, and neither was the tidying-up
  exercise the old wording implied.** Profile creation could not have worked at all - both of its
  idempotency keys came from a `crypto` Hermes does not have (`DEV-043`). The caregiver flow could
  not be **finished**: the Care tab was the only one whose sheets were not inside a `ScrollView`, so
  the review and confirm controls were drawn below the fold with no way to reach them (`DEV-046`).
  Two of the three "built and untested" scenarios turned out to be broken rather than untested,
  which is the argument for driving the third.

  What the caregiver run measures that no API test can is the pair: the invitation is created from
  the phone, carrying only the one capability that was ticked, and the removal is confirmed on the
  phone - and the caregiver's very next request, on the session that was working a moment earlier,
  returns nothing. `12` requires authorization loss to invalidate access and the app tells the
  person doing it that this "takes effect straight away". Measured: 2 of the owner's 3 items while
  granted - the two medicines, not the personal-care product, which is `08.2`'s scoping - and 0
  immediately afterwards.

  **"Visit Pack export" is covered, and the check that matters is a subtraction.** An export is
  the one thing in this app that leaves it: a copy of somebody's medicines handed to a person
  Kynviora knows nothing about, and `16` rests that on the promise the screen makes twice - nothing
  is included until you choose it. A run that ticked everything would confirm the promise and test
  none of it, so the harness ticks one of two medicines and asks about the other. Measured: one
  entry, the one that was ticked, and not the one that was not. It also found a third defect
  (`DEV-047`): the export's idempotency key was minted when the button was pressed rather than when
  the export was decided, so a retry after a slow request made a second copy with its own expiry
  that the person would not know about.

  All three of the "built and untested" scenarios turned out to be broken rather than untested. The
  phrase was doing more work than it could carry.

  **"Personal-care add/scan/OCR/confirm" now has its manual half measured, and the "confirm" step
  inverts.** `npm run verify:device:personalcare` types a product in by hand, chooses a category
  from the radio group, pastes an ingredient declaration, and saves. What comes back is compared
  character for character: `09` reads a declaration in printed order, so a list this app had
  tidied would be a different list from the one on the pack.

  Two of its checks are the ones worth having. `PC-4` is a subtraction - the barcode, the batch
  code and the expiry are left blank and the declaration is filled in, so three limits have to be
  stated afterwards and the fourth must not be. A screen printing the same four sentences whatever
  somebody typed passes every other reading of "the limits are stated", and is telling a person
  their ingredient list is missing while it is on file. `PC-5` is the confirm step as this build
  can have it: with no extraction there is nothing for anybody to confirm, so what has to be true
  is that a record somebody typed is **never** presented as confirmed. Measured on the phone, on
  the item's own screen: "Product not verified" and "Formula not verified", over a record the
  server holds as `UNVERIFIED` on both. Last run **6/6 PASS**.

  **"Safety alert open/resolution" now has the half that can exist measured, and the other half is
  refused on purpose.** Opening a published alert needs a publication, and nothing in this build
  can produce one: `BLK-006` has no qualified reviewer and DEC-016 has every shipped regulatory
  fixture refused by the Citation Gate. Seeding an approval to make a device test go green is the
  precise failure the governance chapter exists to prevent, so `npm run verify:device:safety` does
  not, and says so in its own report.

  What it measures instead is the state every profile in this build is in, and that most items in
  any build will be in: Kynviora has nothing to say and has to say so without that reading as an
  all-clear. `23` D-014 is a safety requirement in its own right, and it is the one a person is
  exposed to today. Seven checks: every item on the shelf has a line (an omission is the quietest
  way to render an absence as approval), every line announces the limitation with its
  qualification attached, the coverage statement is on screen, no control offers to explain an
  alert that does not exist (DEC-045 - absent, not disabled), nothing counts or ranks what needs
  attention (`02`), and a filter matching nothing still says it is showing none of five and still
  carries the coverage statement underneath. That last is where somebody would most reasonably
  conclude their shelf had been cleared. Last run **7/7 PASS**.

- **Required future work**: what is left now names a decision or a credential rather than a task.
  Authentication needs Phase 1.1's provider chosen (`BLK-010`); the scanner needs building (`04`
  Phase 2.2); OCR needs a credentialed provider (`BLK-007`); opening an alert needs a reviewer
  (`BLK-006`). Camera and file permissions need a feature that uses them. A low-storage run needs
  nothing but time and is the one genuinely unblocked piece of work remaining here.

---

## DEV-041 - Four things the reminder engine does not do, and the one a person could not find out

- **Affected specification**: `04` Phase 4.2 (local reminder engine).
- **Expected behaviour**: reminders arrive at the times a person set, for as long as those times
  are set.
- **Implemented behaviour**: they do, and the device harness measures it. Four limits are worth
  writing down rather than discovering later, and they are listed in order of how badly a person
  would be served by not knowing.

### 1. "Force stop" silently ends the reminders, and nothing says so

Pressing **Force stop** in Android's app settings does not merely kill the process. It puts the app
in the stopped state and **cancels every alarm it had registered** - measured on this emulator as 28
pending alarms before and 0 after - and Android will not let a stopped app re-register anything
until a person launches it again. So somebody who force-stops Kynviora to "close it properly" gets
no reminders, indefinitely, with no error and nothing on any screen to say so.

This is the one on the list that a person could not find out for themselves, which is why it is
first. Ordinary process death is fine and is measured: `am kill` leaves the alarms intact and the
reminder still arrives. Swiping the app away from recents behaves like `am kill`, not like force
stop.

**Required future work**: the schedule screen should say what a force stop costs, in the same
sentence style as `SCHEDULE_COPY.reliability`. That is copy plus a place to put it, not a mechanism

- there is no way for an app to detect that it was force-stopped, so the honest move is to warn
  rather than to recover.

### 2. An app left unopened for more than a fortnight runs out of reminders

`REMINDER_HORIZON_DAYS` is 14 and the plan is a list of absolute instants, so a device that is never
opened again stops being reminded on day fifteen. The horizon exists because a platform repeat rule
is re-evaluated in the device's _current_ zone, which would move a dose when somebody travels -
`04` Phase 4.1's time-zone rule is what forbids the cheaper option.

The app re-plans on every foreground, so this only bites somebody who has stopped opening it
entirely. **Required future work**: a background task that re-plans without a launch. `12` bounds
what may run in the background and no such task exists yet, so this is deliberate rather than
missed.

### 3. Nothing is reconciled against what was actually taken

A reminder fires whether or not the dose it is about was already recorded as taken. Phase 4.3's
dose events exist and the engine does not read them.

This is deliberate and it is not an oversight to be tidied up later: suppressing a reminder because
an event exists is Kynviora deciding somebody has already taken a medicine, and the record it would
be deciding from is one a person can create by tapping the wrong row. `02` names gamified adherence
as an anti-feature and `04` Phase 4.1 forbids inferring dose changes from adherence history. Being
reminded about something already taken costs a glance; not being reminded about something not taken
costs the dose.

### 4. iOS is entirely unverified

`expo-notifications` covers both platforms and every rule in `reminderPlan.ts` is platform-neutral,
but nothing here has run on an iOS device. iOS has no equivalent of `USE_EXACT_ALARM` (DEC-106) and
its own limit on pending local notifications, which is lower than Android's and which
`MAX_PLANNED_REMINDERS` was not chosen against. No claim is made about iOS reminder reliability.

- **Temporary or permanent**: 1 and 2 are temporary. 3 is permanent by decision. 4 is temporary and
  needs hardware this build has never had.
- **Risk**: 1 is the material one - a person who believes they are being reminded and is not.
  2 is bounded by a fortnight of not opening the app at all. 3 is a small annoyance in the direction
  that fails safe. 4 is an unmade claim rather than a broken promise.

---

## DEV-042 - The local store has no schema migration, and an update that changes its shape abandons the offline copy

- **Affected specification**: `12` "Repository behavior" (the encrypted structured local store);
  `03` group J (a person with no signal still sees their medicines); `19` ("Android
  install/update"); `14` and `21` (data minimisation - keeping no more health data than is needed).
- **Expected behaviour**: an app update carries a person's offline copy forward, whatever changed
  in how it is stored.
- **Implemented behaviour**: it carries it forward only while the shape does not change. The
  projection writes to `projected_read_v1` and the table name **is** the version
  (`apps/mobile/src/storage/projection.ts`), so a shape change means a new table created empty by
  `CREATE TABLE IF NOT EXISTS`. Nothing migrates the rows, and nothing removes them.
- **What is verified, and what this is not**: `npm run verify:device:update` passes 6/6 - the
  encrypted database is byte-identical across an `install -r`, the keystore key still opens it, the
  app does not crash, and 15 of 15 pending reminders come back. All of that is the platform's
  replace path and the app's key handling, and all of it holds. What it does not exercise is a
  build whose local schema differs from the one on disk, because no second shape exists yet.
- **The two consequences, in order of who they hurt**:
  1. **Somebody offline loses their copy at exactly the wrong moment.** A shape change lands with
     an app update; the new table is empty until a successful fetch; and a person with no signal is
     the one who cannot make that fetch. The failure is silent and reads as "the app forgot my
     medicines" - `03` group J is the requirement it breaks.
  2. **The abandoned table is never dropped.** Its rows hold medicine and profile names, and after
     a shape change nothing reads them and nothing removes them. `14` and `21` ask for no more
     health data retained than is needed, and an orphaned table is the definition of more.
- **Why it is not fixed here, which is a decision rather than an omission**: the obvious fix -
  dropping every `projected_read_v%` table that is not the current one, on open - would foreclose
  the better fix. A build that wanted to _migrate_ v1 rows into v2 needs them to still be there,
  and a cleanup that runs on open destroys its input before the migration can be written. Choosing
  between "migrate" and "discard" is a decision about somebody's data that belongs to the change
  that introduces v2, where the shapes are both known. Guessing it now, against a v2 nobody has
  designed, is how the wrong one gets locked in.
- **Temporary or permanent**: temporary, and dormant. Nothing is wrong today: there is one shape,
  and it survives an update byte for byte.
- **Risk**: none while one shape exists. On the day a second one lands, both consequences arrive
  together and unannounced unless this is read first.
- **Required future work**: with the v2 shape in hand, decide migrate-or-discard for the v1 rows,
  implement it on open, drop the old table once its rows have been dealt with either way, and
  extend `verify:device:update` to install a build whose local schema differs - which is the only
  version of this scenario that measures the thing rather than the platform underneath it.

---

## DEV-043 - Every write needing an idempotency key was broken on a device, and every gate was green

- **Affected specification**: `07` (non-guessable identifiers), `13` (an idempotency key on a
  mutation that can be retried), `12` (a queued operation's ID is its idempotency key), `04`
  Phase 2.1, 4.1, 4.3, `08.2`, `19` (device E2E).
- **Expected behaviour**: a person can create a schedule, record a dose, add a medicine, set up a
  household and profile, export a Visit Pack, and queue an edit made offline.
- **Implemented behaviour before this session**: none of those worked on a phone. Every one of them
  called `crypto.randomUUID()`, and there is no global `crypto` on Hermes. The result was an
  uncaught `Property 'crypto' doesn't exist` at the instant somebody pressed Save - a red screen in
  development and a crash in a release build - on eight call sites across six files:

  | File                                        | What a person was doing               |
  | ------------------------------------------- | ------------------------------------- |
  | `app/(tabs)/shelf.tsx` (x2)                 | creating a schedule; recording a dose |
  | `app/(tabs)/care.tsx`                       | inviting a caregiver                  |
  | `features/shelf/AddItem.tsx`                | adding a medicine by hand             |
  | `features/profiles/SetUpHousehold.tsx` (x2) | creating a household and a profile    |
  | `features/visitPack/VisitPackFlow.tsx`      | exporting a Visit Pack                |
  | `sync/PendingSyncProvider.tsx`              | queueing an edit made with no signal  |

- **Reason it survived every gate**, which is the part worth keeping:
  - **`apps/**` is outside the test run.** `vitest.config.ts` excludes it, so none of the 3,808
    tests ever loaded these files.
  - **`apps/**` is outside the lint run.** `eslint.config.js` ignores it, so no lint rule this
    project relies on ever saw them.
  - **The mobile typecheck is therefore the only gate over the app - and it was being told a phone
    is a browser.** `expo/tsconfig.base` sets `lib: ["DOM", "ESNext"]`, and the monorepo's hoisted
    `@types/node` was picked up ambiently. Between them, `crypto` was declared twice over.

  So the code was wrong in the one tree nothing checks, in a way the one checker it had was
  configured not to see. `04` Phase 9's release gates would have been signed off against a suite
  that had never executed a line of it.

  The four device harnesses did not catch it either, and that is not an oversight in them: storage,
  accessibility, reminders and update **only read**. `verify:device:reminders` creates its schedule
  through the API from the host, never through the app. Nothing had ever driven a write on a
  device, so nothing had ever run this line.

- **What was done**: `apps/mobile/src/platform/ids.ts` is now the one place the app asks for a
  random identifier, bound to `expo-crypto` - the same secure source `secureDatabase.ts` derives
  the SQLCipher key from. All eight call sites use it. `cryptoIdGenerator` in
  `packages/domain/src/ports.ts` no longer reads an ambient `globalThis.crypto` either; it takes
  its source as a parameter, so the platform binding is something a reader can see.

  Two gates were closed behind it, because one fix to eight lines is not a fix to the reason:
  - **The mobile typecheck compiles with `lib: ["ESNext"]` and `types: []`** (DEC-112). Reaching
    for `crypto`, `document` or `localStorage` is now a compile error. Run against the code as it
    stood, it named all eight lines and nothing else.
  - **`scripts/checks/mobileGlobals.test.ts` reads the real `apps/mobile/src` tree** and fails the
    suite on any of them. It is the only test in `npm run verify` that looks at app source at all,
    and it exists because a `tsconfig` is one line away from being convenient again.

- **Temporary or permanent**: fixed.
- **Risk now**: low, and the class is closed rather than the instance. What remains is that
  `apps/**` is still untested and unlinted - the new check covers a list of names, not behaviour.
- **Required future work**: the honest one is that the app tree needs tests, not more scanning.
  `04` Phase 9.4 already says the screens need people; what it does not yet say is that nothing
  automated executes them either.

---

## DEV-044 - A queued edit was not sent on the launch it had been waiting for

- **Affected specification**: `12` ("Repository behavior" - a pending-operation journal that syncs
  deterministically), `13` (bounded retry), `03` group J, `19` ("Offline create/edit/sync").
- **Expected behaviour**: an edit made with no signal is sent when the app next comes to the front
  with a connection.
- **Implemented behaviour before this session**: it was sent on the _second_ foreground, and only
  if the person happened to visit the tab that owned the write - and each intervening launch spent
  one of its retry attempts.

  Both halves came from one decision. A sender was registered by the screen that knew the shape of
  the write (`shelf.tsx` for a schedule, `EditItem.tsx` for an item edit), and the registry was
  consulted inside the drain. But the encrypted store opens at the root, before any tab beyond the
  first has mounted, so the single pass a cold launch runs found an empty registry. With no sender,
  the provider reported the operation as `OFFLINE` - and `classifyUpload` reads `OFFLINE` as
  `RETRYABLE`, so `recordUploadOutcome` incremented the attempt count, marked the row
  `FAILED_RETRYABLE`, and `endsTheDrain` stopped the pass.

  The consequence is the failure `12` is written to prevent, arriving by a route nobody would look
  down. The launch after a person's phone killed the app is exactly the launch their queued
  medicine time was waiting for; it was the one launch guaranteed not to send it. Repeat over
  enough launches and the edit reaches `MAX_UPLOAD_ATTEMPTS` and is "waiting for somebody to look
  at it" - with no screen that shows it (`DEV-038`) - having never been sent once.

- **How it was found**: by driving it. The chain was queued offline, `am kill`ed, reconnected and
  relaunched, and the server did not change. It changed on the next background-and-foreground.
  Nothing in either file reads as wrong; the ordering between a provider and a tab is not visible
  in either one.

- **What was done**:
  - **`drainPendingOperations` takes a `canSend` predicate** and reports what it skipped
    (DEC-114). An operation nothing can carry is not attempted, keeps its full attempt budget and
    its `PENDING` state, and does not stop the operations behind it - a schedule with no sender
    must not hold up an item edit that has one.
  - **Senders are registered for the app's lifetime, not a screen's** (DEC-113). `PendingSenders`
    is mounted at the root next to the reminder engine, whose comment already made this exact
    argument: "a sync that only ran when somebody opened a particular tab would stop extending the
    horizon the moment they stopped visiting it, and the person would find out by not being
    reminded."
  - **`registerSender` re-drains when a type becomes sendable for the first time**, so a registry
    that fills after the store opens does not leave the queue waiting for the next foreground.
  - **`npm run verify:device:offline`** measures it, and `OFF-3` asserts the **first** launch
    specifically. A check that accepted "it arrived eventually" would have called the old
    behaviour correct.

- **Temporary or permanent**: fixed.
- **Risk now**: low. What is still true is that a person cannot see the queue at all (`DEV-038`),
  so any future variant of this is again something only a device run would find.
- **Required future work**: the queue-review screen `DEV-038` names. It is also the only way the
  attempt count and `needsUserAttention` become observable from the app rather than inferred from
  what a proxy saw.

---

## DEV-045 - A medicine with no schedule could never be given one

- **Affected specification**: `04` Phase 4.1 (a person sets when a medicine is taken), `08.2`
  (capability scoping), `12`, `19` ("Offline create/edit/sync", which needs a create to exist).
- **Expected behaviour**: the schedule editor offers "Add a schedule" to anybody who may manage
  medicines, and absent it to anybody who may only look (DEC-045).
- **Implemented behaviour before this session**: the button was drawn only when the medicine
  **already had** a schedule. On every medicine with none - which is the only state a newly added
  medicine is ever in - the editor said "Nothing is scheduled for this medicine." and offered no way
  to schedule one. Phase 4.1's create route was therefore unreachable from the app in exactly the
  case it exists for.

- **Cause**, which is worth stating precisely because it is a pattern rather than a typo. The
  screen's payload is not one list:

  ```
  { schedules, detailLevel, directionsText, mayEdit }
  ```

  It was loaded with `isEmpty: (value) => value.schedules.length === 0`, and `resourceFor` answers
  `EMPTY` by setting **`value` to `null`** - correctly, because `EMPTY` means "there is nothing to
  show". But `isEmpty` is a question about a whole payload and this one was empty in a single
  field, so an empty schedule list discarded the notification detail level, the prescriber's
  directions and `mayEdit` along with it. `mayEdit` then fell back to its safe default of `false`,
  and a control that is deliberately **absent rather than disabled** for a caller who may only look
  (DEC-045) was absent for everybody.

  Every gate was green over it. `apps/**` is outside the test run and the lint run (`DEV-043`), the
  server was right, `resourceFor` was right and is tested, and both halves read correctly on their
  own.

- **How it was found**: the offline-write harness picked a medicine by name rather than by
  coordinates, landed on the seed's second medicine - which had no schedules - and reported that it
  could not fill in the form. Every earlier attempt had been driven by hand against the first
  medicine, which previous sessions had left fifteen schedules on.

- **What was done**: the schedule editor's resource no longer declares itself empty. There was
  nothing to gain by it - the editor renders "Nothing is scheduled for this medicine." from
  `schedules.length === 0` itself, and `ScreenState` is not shown for `EMPTY` anyway.

  The same shape was found once more and fixed with it: the Care screen called itself empty when
  there were no grants and no invitations, discarding the **access history** in the same move. A
  household that has just revoked its last caregiver would see no record that anybody ever had
  access - at the moment somebody is most likely to be looking for exactly that. "Nobody has
  access" and "nobody has ever had access" are different sentences, and `08.2`'s audit trail is
  the difference. Its emptiness test now includes the history.

  The four remaining `isEmpty` call sites were checked and are sound: their payloads are read only
  through the field the test asks about, or through a defaulted fallback.

- **Temporary or permanent**: fixed.
- **Risk now**: low for these two. The class is not closed - nothing prevents the next composite
  payload being declared empty on one field - and the honest guard would be a test over the app
  tree, which does not exist (`DEV-043`).
- **Required future work**: driving the remaining `DEV-040` scenarios will exercise the other
  screens' empty states, which is the only way this class is currently found.

---

## DEV-046 - The Care screen did not scroll, so nobody could finish inviting a caregiver

- **Affected specification**: `04` Phase 8.1 (caregiver invitation and revocation), `06` Journey 6,
  `18` (every control must stay usable at font scale 2), `19` ("Caregiver invite/revoke").
- **Expected behaviour**: a person ticks what a caregiver may see, reviews it, and creates the
  link.
- **Implemented behaviour before this session**: the ticking worked. Nothing below it could be
  reached. `care.tsx` was the only tab rendering its sheets in a plain `View` under a
  `SafeAreaView`, instead of inside `Screen` - whose `ScrollView` is what makes the other four
  scroll. On a 1080x2400 device the invitation form's six capability rows already fill the screen,
  so the email field, "Review what you are sharing" and "Cancel" were drawn past the bottom with
  nothing able to bring them into view. `uiautomator` reported the container as
  `scrollable=false`; a person could not send an invitation at all, and could not cancel out of the
  form either.

  The removal sheet is in the same branch and had the same problem waiting for it, on a longer list
  of capabilities than this seed happens to grant.

- **Reason it was not found**: nothing had ever opened the screen on a device. `DEV-040` recorded
  the caregiver flow as "built and untested", and the four device harnesses in existence read
  rather than wrote. The accessibility harness measures the five destinations at font scale 1 and
  2 - it visits the Care **list**, which is short and fits, and not the sheets, which do not.

  It is also invisible from the code unless the four tabs are compared side by side: each screen's
  own file looks reasonable, and the missing thing is a wrapper three of its siblings have.

- **What was done**: each branch of `care.tsx` renders inside a `ScrollView` with the same padding
  and gap `Screen` uses. Not `Screen` itself, because `Screen` also draws a destination heading and
  this tab has never had one - adding it is a design change, and what was wrong here is that a
  screen could not be finished.

- **Temporary or permanent**: fixed.
- **Risk now**: low for this screen, and the class is worth naming: any screen not built on
  `Screen` can grow past the viewport without anybody noticing, and font scale 2 makes every screen
  taller. `18`'s requirement is measured for the five destinations and not for the sheets they
  open.
- **Required future work**: extend `verify:device:a11y` to open the sheets rather than only the
  destinations, so "every control is reachable" is measured where the controls actually are.

---

## DEV-047 - A Visit Pack's idempotency key was minted when the button was pressed, not when the export was decided

- **Affected specification**: `13` (an idempotency key on a mutation that can be retried), `04`
  Phase 8.3, `16` (Kynviora never shares anything on its own), `21` (no more health data retained
  than is needed), DEC-111.
- **Expected behaviour**: one export per intent, however many times the person presses.
- **Implemented behaviour before this session**: `VisitPackFlow` called
  `createVisitPack(draft.body, newIdempotencyKey())` - generating the key **at the moment of the
  call**. Every press was a different intent as far as the server could tell.

  The screen replaces the button with its own state while a request is in flight, so a double tap in
  one instant was never the risk. The ordinary case was: a slow request, a failure the person is
  invited to retry, a second press - and a second Visit Pack, with its own expiry, holding a copy of
  the same medicines. The person knows about one of them. `21` asks for no more health data retained
  than is needed and this is a second copy nobody chose to make.

  `AddItem.tsx` gets this right - `useState(() => newIdempotencyKey())` - which is what makes the
  difference a decision rather than a convention nobody had settled.

- **Reason it was not found**: `apps/**` is outside the test run and the lint run (`DEV-043`), and
  the API tests cover what the server does with a repeated key rather than whether the client sends
  the same one twice. On a device it is invisible unless something is watching the wire, which is
  what the export harness now does.

- **What was done**: the key is minted when the **review step is entered** and reused for every
  attempt at that export. A fresh one each time the review is re-entered, because going back and
  changing the selection makes it a different export - replaying the old key there would hand
  somebody the pack they had rejected.

- **Temporary or permanent**: fixed.
- **Risk now**: low. What is not proven on the device is the replay itself: the route checks the
  reviewed-content digest before it reaches its duplicate branch, so a harness cannot repeat the
  create without reconstructing a body it never saw. `PACK-1` measures that a key was sent; that the
  server commits once under a repeated one is covered by the API suite.
- **Required future work**: none for this route. The general question - which creates mint per
  intent and which per press - is worth a sweep, and the two known-correct examples are `AddItem`
  and now this.

---

## DEV-048 - Which mutations may be made with no signal, taken one table at a time

- **Affected specification**: `12` (a pending-operation journal; "only low-risk user-owned changes"
  may be applied before the server has agreed), `13` (conflict policy per entity type), `03` group
  J (what has to work with no network), `04` Phase 4.3.
- **Expected behaviour**: every change a person can make offline is either queued and delivered
  exactly once, or refused at the time with the reason said out loud. Nothing is kept that cannot
  be sent, and nothing is dropped that could have been.
- **Implemented behaviour**: four of the twelve sync entity types carry a sender. This entry is the
  audit that decided the other eight, because "not wired" was doing the work of four different
  reasons and only one of them was a gap.

  | Entity type            | `13` policy        | Queued?           | Why                                                                                           |
  | ---------------------- | ------------------ | ----------------- | --------------------------------------------------------------------------------------------- |
  | `medicine_schedule`    | ASK_USER           | CREATE, UPDATE    | Driven end to end on a device (`verify:device:offline`, Runs A and B)                         |
  | `owned_item`           | ASK_USER           | UPDATE only       | A queued CREATE reaches Phase 8.5 as a second copy of one medicine (`DEV-038`)                |
  | `allergy_record`       | ASK_USER           | UPDATE only       | `addHealthFact` carries no idempotency key by design, so a replay makes a second row unbidden |
  | `dose_event`           | MERGE_BY_ID        | **CREATE, now**   | The gap this audit found. There is no edit or delete route and none is wanted                 |
  | `condition_record`     | ASK_USER           | No feature        | Conditions are not built (`DEV-035`)                                                          |
  | `field_assertion`      | CREATE_NEW_VERSION | No feature        | Produced by extraction, which has no provider (`BLK-007`)                                     |
  | `marketed_formulation` | CREATE_NEW_VERSION | No feature        | Catalog-side; no client write path exists                                                     |
  | `profile`              | ASK_USER           | Refused (DEC-115) | A client-minted profile id is one every read route answers as absent                          |
  | `review_task`          | SERVER_WINS        | Refused by policy | `queue` refuses it before writing anything (DEC-110)                                          |
  | `caregiver_grant`      | SERVER_WINS        | Refused by policy | Authorization is the server's (`11`, `12`)                                                    |
  | `profile_assessment`   | SERVER_WINS        | Refused by policy | Safety is the server's (DEC-010)                                                              |
  | `alert_publication`    | SERVER_WINS        | Refused by policy | Nothing may be published from a phone (`BLK-006`)                                             |

- **Reason**: the audit was asked for as "wire only the mutations the policy allows", and the useful
  finding was how few that leaves. Four types are refused by `13` itself and `PendingSyncProvider`
  already turns them away before writing a row. Three have no feature to queue from. Two are wired
  for the mutation that is safe and deliberately not for the one that is not. That left `profile`,
  which needed a decision rather than a rule (DEC-115), and `dose_event`, which was simply missing.

  **`dose_event` was the gap, and it is the one with a person on the other end of it.** `13`
  resolves it `MERGE_BY_ID` and the table's own comment says why: "offline-created events with
  stable IDs. Merging by ID is what makes an offline retry safe." `04` Phase 4.3 goes further and
  makes it an exit criterion - an event created offline may be uploaded more than once, and a
  duplicate sync must not create a duplicate event. The route had held up its end since it was
  written, answering a repeated operation ID with the row it already had.

  The client had not. `onRecord` treated `OFFLINE` as an answer, so somebody in a kitchen with no
  signal took a tablet, recorded it, was told Kynviora could not reach the server, and the record
  was gone. The history a doctor reads was then missing a dose that was taken, with nothing
  anywhere saying so - and the sentence for the case had been written and never used:
  `DOSE_COPY.offlineNote`, "Recorded on this phone. It will reach Kynviora when you are back
  online", sat unreferenced in the presentation package.

  It is queued under the key the failed attempt used rather than a fresh one, for DEC-111's reason.
  `OFFLINE` is inferred from a failed fetch, which is also what a request that arrived and lost its
  answer looks like - and a second dose in a history somebody reads as a record of what they did is
  a false record, not a duplicate row.

  **What now stops a sender being registered for a table it must not be.** `PendingSyncProvider`
  refuses a `SERVER_WINS` type at `queue`, which means a sender registered for `caregiver_grant`
  would queue nothing today and fail nothing - it would sit there looking correct until somebody
  relaxed the refusal for an unrelated reason. `scripts/checks/queueableSenders.test.ts` reads
  `PendingSenders.tsx` and refuses a registration for any type whose policy is `SERVER_WINS`, for
  a name that is not an entity type at all, and for the same type registered twice. It runs in
  `npm run verify`, which `apps/**` otherwise does not.

- **Temporary or permanent**: the table is permanent as a record of the reasoning; three of its
  rows move when the features they name are built.
- **Risk**: low. The four wired types are the four `12` describes as low-risk and user-owned, and
  three of the four are now measured on a device.
- **Required future work**: `condition_record` when Phase 3 builds conditions (`DEV-035`);
  `field_assertion` when an extraction provider exists (`BLK-007`); `profile` if and when the app
  can render a person the server has not seen (DEC-115). `owned_item` CREATE stays refused until
  Phase 8.5's reconciliation can tell a queued create from a duplicate medicine.

---

## DEV-049 - A grant the screen lists under "viewing" lets somebody write into a dose history

- **Affected specification**: `07` (the caregiver capability vocabulary and what each grant means),
  `11` and `12` (access control is server-authoritative; a grant is a specific set of
  capabilities), `18` (a person must be able to understand what they are approving), `04` Phase 4.3.
- **Expected behaviour**: what the invitation screen tells somebody they are granting is what the
  database permits.
- **Implemented behaviour**: a caregiver granted only `VIEW_MEDICINES` can `POST /v1/dose-events`
  and write into the owner's dose history. The invitation review screen puts that capability under
  **viewing** and leaves **changing** empty, because `CAPABILITY_DESCRIPTIONS.VIEW_MEDICINES`
  carries `allowsChanges: false` and its sentence is "They can see the medicines recorded for this
  person."

  Measured, not inferred: `services/api/src/doseAuthorization.test.ts` runs against the real
  database with row-level security in force and records both halves - the read a view-only
  caregiver is supposed to have, and the write they are not supposed to.

- **Reason**: two deliberate decisions made in different places and never put side by side.

  `0004` scoped every child of `owned_item` by reachability - "child records inherit reachability
  from their owned item, so there is exactly one place where shelf access is decided" - and `0020`
  restated it for this table specifically while tightening the one next to it: "`dose_event` is a
  record of something that happened and is reachability-scoped on purpose, but `review_task` writes
  need MANAGE_CARE and `allergy` writes need MANAGE_MEDICINES."

  That is a coherent position. A person looking after somebody, who can see their medicines,
  recording that a tablet was taken is the ordinary case of caregiving, and requiring an "edit
  medicines" grant for it would make the common thing need the dangerous permission.

  The screen takes the opposite position, equally deliberately: it groups capabilities into viewing
  and changing "because that is the distinction a person actually cares about when approving
  access". Under that grouping, `VIEW_MEDICINES` promises no writes.

  Both cannot be right, and the gap is not academic - a dose history is what somebody hands a
  doctor, and an entry nobody made is a false record of what a person did.

- **Why it is being documented rather than fixed**: the resolution is a product decision with three
  defensible answers, and inventing one in passing is exactly what the operating brief forbids.

  1. **Tighten the policy** so a dose write needs a capability marked `allowsChanges: true`. The
     screen becomes true and the common caregiving case needs "edit medicines".
  2. **Change the copy** so `VIEW_MEDICINES` says it also permits recording a dose. The policy is
     untouched and the grant stops claiming to be read-only.
  3. **Add a capability** - `RECORD_DOSES` - so the thing a caregiver most often does has a name of
     its own. Cleanest, and the largest change: a new member of `CAREGIVER_CAPABILITIES`, the
     `CHECK` constraint in `0002`, a migration, and copy.

  Whichever is chosen changes what an existing grant means, which is why it is not a change to make
  while passing through.

- **Temporary or permanent**: temporary. It was a decision waiting to be made, not a limit of the
  environment.
- **Risk (historical)**: moderate and bounded. It required an accepted, unrevoked grant - a stranger
  was refused and so was a revoked caregiver, both measured - so the exposure was to somebody the
  owner chose to give access to, doing something the screen did not say they could. No safety rule
  and no authorization decision depends on a dose event, and nothing about the medicine record
  changed.
- **Status**: **RESOLVED 2026-09-04** by the third option (DEC-116, `BLK-011` closed).

  `RECORD_DOSES` is its own capability, sitting between `VIEW_MEDICINES` and `MANAGE_MEDICINES` in
  the vocabulary and in what it permits. Migration `0021` replaces `dose_event_insert` to require
  it, widens both capability CHECK constraints, and **backfills nothing** - so an existing
  view-only caregiver loses the write, which is the point, and no grant silently acquires a
  capability nobody granted. `MANAGE_MEDICINES` is not a way in either: the capabilities are a set,
  not a ladder.

  The screen half moved with it. `VIEW_MEDICINES` now says it allows no changes, `RECORD_DOSES` is
  its own checkbox filed under what the caregiver may **change**, and the invitation's opening line
  says "see and do" rather than "see" - it was already imprecise while the list carried the editing
  capabilities, and this is what made it wrong.

  Measured three ways: `db/doseEvent.test.ts` against real RLS as the non-superuser role,
  `doseAuthorization.test.ts` rewritten from pinning the contradiction to measuring the resolution,
  and `npm run verify:device:doseaccess` at **7/7 PASS** on a Pixel 7 / Android 16 emulator -
  including the same request answering 404 without the capability and 201 with it, on one session
  with no sign-out.

---

## DEV-050 - A harness guard that counted grants was reading a field the API has never sent

- **Affected specification**: `19` (device E2E coverage of caregiver invite/revoke), DEC-102 (a
  check that could not look reports `INCONCLUSIVE`).
- **Expected behaviour**: `CAR-0` refuses to run when a grant from an earlier run is still live,
  and `CAR-3` confirms revocation by counting what is left.
- **Implemented behaviour**: both read zero, always. `verifyCaregiverAccess.ts` declared
  `readonly caregiverUserId?: string` on its `Grant` interface where `GET /v1/caregiver-grants`
  sends `granteeUserId`, so every comparison evaluated `undefined !== CAREGIVER_ID`,
  `activeGrantsFor` counted nothing whatever the database held, and `clearPreviousRuns` skipped
  every row it was written to revoke.
- **How it was found**: by writing a second harness against the same route. `verify:device:doseaccess`
  needs two grants in sequence for one caregiver, so its cleanup has to work - and its second run
  found a live `VIEW_MEDICINES` grant its first run had created and believed it had revoked.
- **Reason**: the field was **optional**, so TypeScript had nothing to say about a name that had
  never existed. A required field would have been a compile error the day it was written.
- **Risk**: the two checks were vacuous, not wrong. `CAR-4` measures access loss by counting items
  the caregiver can see and is a real measurement, and the revocation it measures is driven on the
  device - so the harness was still testing revocation. What it was not doing was noticing a grant
  left behind by a crashed run, which is the state that would make the whole scenario measure
  nothing.
- **Fix**: `granteeUserId`, required, in both harnesses, with the reasoning written where the
  interface is. `verify:device:caregiver` re-runs **5/5 PASS** with `CAR-0` and `CAR-3` now reading
  real counts.
- **Status**: **RESOLVED 2026-09-04**.

---

## DEV-051 - A shelf read from a projection written by an older build offers no dose control

- **Affected specification**: `12` (screens read local state immediately), `04` Phase 4.3, `14`
  (deny by default), DEC-116.
- **Expected behaviour**: an owner offline can record a dose, which is `DEV-048`'s whole point.
- **Implemented behaviour**: after an update, and before the first successful `GET /v1/items`, an
  owner reading the shelf from the encrypted projection sees no "Record what happened" control.
  The stored body is the last thing the server said, and a body written by the previous build
  carries no `mayRecordDoses` - which `shelfView` narrows to `false`.
- **Reason**: deliberate, and the alternative is worse. Treating an absent flag as permission would
  draw the control for every view-only caregiver reading a stale projection, and the write is then
  queued and refused hours later by the drain - a dose somebody was told had been saved,
  disappearing without their knowing, which is the exact failure `DEV-048` exists to prevent. Deny
  by default costs a control for a bounded window; the opposite costs a record.
- **Risk**: low and self-healing. The window closes at the first shelf read with signal, the app
  fetches the shelf on open, and the owner's own recording path through the server is unaffected -
  `verify:device:doseaccess` `DOSE-6` measures it at 7 events to 8.
- **Required future work**: none proposed. It would be closed by versioning the projection payload
  so a row from an older shape is discarded rather than partially trusted, which is a change worth
  making when a second field needs it rather than for this one.

---

## DEV-052 - The app registers a browsable deep-link scheme that no feature uses

- **Affected specification**: `14` ("platform interaction", "deep links/notifications"), `15`
  (threat model), `04` Phase 9.2, `04` Phase 1.1.
- **Expected behaviour**: the surface a package exposes to other apps is the surface a feature
  needs.
- **Implemented behaviour**: the installed package declares `kynviora://` on `MainActivity` with
  `android.intent.category.BROWSABLE`, so any web page or installed app can open Kynviora. Fired
  from another app's context it lands on the shelf, showing the household's medicines. No code in
  `apps/mobile/src` reads a deep-link parameter, and no product feature sends such a link.
- **Reason**: Expo Router registers the scheme from `app.json` by default. Nobody chose it and
  nobody chose against it.
- **What is measured, and is not at risk**: `verify:device:privacy` `PLAT-2` fires the link from
  the shell - another app as far as Android is concerned - carrying a profile ID that is not this
  household's, and the shelf shows exactly what an ordinary launch shows. `shelf.tsx` takes the
  profile from `ProfileProvider` and never from route params, so what the link carries decides
  nothing. `PLAT-1` confirms the launcher activity is the only component this project declares.

  Nor is it a bypass of anything today: there is no authentication to bypass, because Phase 1.1 has
  not chosen a provider (`BLK-010`) and the app opens on the shelf when launched normally too.

- **Why it is being documented rather than removed**: the decision is a product one and it is
  entangled with the phase that is missing. An invitation already hands somebody a link - the
  screen warns that anyone opening it can accept - and whether that link is `kynviora://`, an
  HTTPS App Link, or something a chosen authentication provider supplies cannot be settled before
  Phase 1.1 settles. Removing the scheme now would foreclose the first of those without anybody
  having weighed the three, and keeping it is not free: an unused browsable entry point is surface
  that grows a consequence the moment a screen starts reading a parameter from it.
- **Risk**: low today and conditional on Phase 1.1. What makes it worth writing down is the
  condition: the day a screen reads a route parameter, this stops being an unused declaration and
  becomes an input from an untrusted caller, and `PLAT-2` is the check that would notice.
- **Required future work**: decide it with Phase 1.1 - either scope the scheme to the routes a
  feature needs and validate what it carries, or remove it and use an App Link. Whichever is
  chosen, `PLAT-2` is where the reasoning goes.

---

## DEV-053 - A save held the version of `queue` that existed before the store opened

- **Affected specification**: `12` (a pending-operation journal; a queued change must survive),
  `13` (the operation ID is the idempotency key), `04` Phase 2.5, `DEV-044`'s family.
- **Expected behaviour**: an edit made with no signal is queued and sent later.
- **Implemented behaviour**: `EditItem`'s `onSave` was a `useCallback` over
  `[client, view.id, onChanged]` and called `queueEdit`, which is not in that list. `queueEdit` is
  itself a `useCallback` over `[pending, sessionId, drain]`, and both of the first two move at
  runtime - `pending` is `null` until the encrypted store finishes opening, and `sessionId` changes
  when the session does, which `ProjectionProvider` handles explicitly rather than hypothetically.

  A save holding the first version calls a `queue` that returns `false` before writing anything,
  so the screen reports the edit as failed and drops it. Holding a stale `sessionId` is worse: the
  operation is written into the previous session's queue, where this session's drain never looks.

- **How it was found**: `eslint-plugin-react-hooks` `exhaustive-deps`, on the first run of ESLint
  over `apps/**` ever. It was one of 22 findings and the only one that was a defect rather than a
  style or a declaration issue.
- **Reason**: `apps/**` was in ESLint's ignore list, so no rule had ever looked at this tree. That
  is the other half of `DEV-043`'s explanation - the mobile typecheck was closed by DEC-112, and
  the lint half stayed open.
- **Risk**: real but narrow, and it is the narrowness that kept it hidden. `EditItem` is several
  taps in, so by the time it mounts the store is normally open and `queueEdit` is already the
  working version. The reachable path is a session change while the screen is mounted.
- **Fix**: `queueEdit` added to the dependency list, with the reasoning written beside it.
  `exhaustive-deps` is now an error over `apps/mobile/**`, so the next one fails the build.
- **Status**: **RESOLVED 2026-09-04**.

---

## DEV-054 - A test file in the route directory stopped the app from starting

- **Affected specification**: `12` (the mobile architecture), `19`, `04` Phase 0.1; the same gap
  `DEV-043` names.
- **Expected behaviour**: adding a test does not change what the app does.
- **Implemented behaviour**: `ShelfRow.test.tsx` was written next to the component it tests, which
  is `apps/mobile/src/app/(tabs)/`. Expo Router enumerates that directory with `require.context`,
  so **every** file under it is a route and every file under it is bundled. The test imported the
  render helpers, those import `react-test-renderer`, that is not a dependency of the app, and the
  bundle failed. The phone showed Metro's red overlay and nothing ran.
- **How it was found**: eighteen minutes into a device run, as **every** check reporting
  `INCONCLUSIVE` - including the five destination checks that had reported 34/34 for weeks. The
  report was right and the app was not there.
- **Reason, and the part worth keeping**: no gate this project runs could see it. `npm run verify`
  typechecks, lints and runs four thousand tests without ever bundling the app, so all of them were
  green over a build that could not start. That is `DEV-043`'s shape exactly, arriving on the one
  tree that had just been given tests - and it arrived _because_ it had been given tests.
- **Risk**: total while it lasted, and invisible. The app does not start.
- **Fix**: the test moved to `apps/mobile/src/features/shelf/ShelfRow.test.tsx` and imports the
  screen module by path. `scripts/checks/routeDirectory.test.ts` reads the real route directory and
  fails if anything in it is not a route, so the next attempt fails in CI rather than on a phone.
- **Status**: **RESOLVED 2026-09-04**.

---

## DEV-055 - A store that cannot be written rejected into the void, and a screen said the dose was kept

- **Affected specification**: `12` (a queued change is **visible** rather than assumed; the
  pending-operation journal), `18` (a person must be able to tell what happened), `19` (low
  storage), `04` Phase 4.3, DEC-100.
- **Expected behaviour**: a device with no room left produces a comprehensible refusal, and a dose
  nothing could keep is never described as kept.
- **Implemented behaviour**: two failures, one loud and one quiet.

  The loud one: four store calls were started and not awaited - `projection.write`,
  `projection.forget`, and two `clear()`s on a session change - because their result is a cache
  rather than somebody's data. With the store unwritable every one of them rejects, and with no
  `catch` each became an unhandled rejection. On the device that drew React Native's error banner
  **across the tab bar**, so the app could not be navigated at all.

  The quiet one, and the one `12` is actually about: `PendingSyncProvider.queue` did
  `await pending.put(...)` and let the rejection escape. Every caller renders "Recorded on this
  phone. It will reach Kynviora when you are back online." on `true` and a failure on `false`, and
  a rejection is neither - so the caller learned nothing about an edit that had not been kept.

- **How it was found**: by implementing `19`'s low-storage scenario. `LOW-2` is the check that
  names it: a dose the journal refused must not be described as kept, because the person then stops
  thinking about a record that does not exist and there is no later moment at which they learn.
- **Reason**: `void somePromise()` reads as "this does not matter enough to wait for", and for a
  cache write that is true. It is not the same as "this cannot fail".
- **Risk**: on the queue, high and silent - somebody's dose, told to them as saved. On the
  projection, low in itself and disruptive in effect: in a development build the banner blocks the
  UI, and in a release build the handler is whatever the platform's default is. Neither is a
  decision this app made.
- **Fix**: every fire-and-forget store call carries a `catch` that swallows, with the reason beside
  it - the content on screen is the server's own answer and is still correct, and the next launch
  simply has an older copy. `queue` returns `false` when the write is refused, so the screen says
  what happened. `PendingSyncProvider.test.tsx` pins the second half in CI, and
  `verify:device:lowstorage` `LOW-3` now fails a run on any uncaught rejection at all - which is
  the check that would have found this without a person reading a log.
- **Verified**: `npm run verify:device:lowstorage` **5/5 PASS** on a Pixel 7 / Android 16 emulator.
- **Status**: **RESOLVED 2026-09-04**.

---

## DEV-056 - Three schema paths contradict the retention policy, and one of them survives a purge

- **Affected specification**: `16` (retention matrix, deletion enumeration), `14` (least
  privilege), DEC-117.
- **Expected behaviour**: after a household's data is purged, nothing personal to that household
  remains outside the two tables retained on an approved basis, and those two are not themselves
  destroyed by the purge they are meant to outlive.
- **Implemented behaviour**: three contradictions, found by inventorying the schema against the
  approved policy rather than by assuming the schema already matched it.

  1. **`consent_receipt` dies with its subject.** `user_id -> app_user ON DELETE CASCADE` and
     `profile_id -> profile ON DELETE CASCADE`. The policy keeps consent receipts for 24 months
     **after** deletion; the foreign keys delete them at the moment of purge. The receipt that
     proves somebody withdrew consent is destroyed by the deletion that withdrawing it led to.
  2. **`shadow_run_sample.owned_item_id` outlives the item.** It is a bare `uuid` with no foreign
     key, in a staff-readable table. A purged household item's identifier stays behind in a shadow
     run indefinitely. Nothing dereferences it once the item is gone, which is why it is a linkage
     rather than a leak of content - and a linkage is what section 3.4 of `docs/RETENTION.md` says
     must be purged.
  3. **`assessment_correction` blocks the purge it should yield to.** Both references are
     `ON DELETE RESTRICT`, so a corrected assessment cannot be purged at all while the correction
     stands, and the correction is staff-operational data with no reason to hold personal data
     hostage.

- **How it was found**: by the table-by-table inventory DEC-117 required. None of the three is
  reachable by any existing test, because no test deletes anything - `DEV-032` is the reason there
  was nothing to delete.
- **Reason**: each foreign key was written before there was a retention policy, and each is locally
  correct. `ON DELETE CASCADE` from `app_user` to `consent_receipt` is the obvious choice for a
  child row when nobody has yet said the child outlives the parent. `shadow_run_sample` deliberately
  has no foreign key so that a shadow run over a dataset does not pin the dataset; the cost of that
  is the linkage, and the linkage was not priced.
- **Risk**: (1) is the highest - it destroys evidence of consent at the one moment it is most
  likely to be asked for, and the destruction is silent. (2) is low and durable: a UUID with no
  dereferenceable target, retained forever, in a table household users cannot read. (3) is an
  availability rather than a privacy failure: the purge does not complete, which is discovered
  when the deadline is missed.
- **Fix**: migration `0022`. (1) `profile_id` becomes `ON DELETE SET NULL` and `user_id` becomes
  nullable and un-cascaded, so the receipt keeps its purpose, decision and policy version while its
  subject is de-linked. (2) `owned_item_id` becomes nullable and is de-linked by the purge path.
  (3) both references become `ON DELETE SET NULL`.
- **Verified**: `db/retention.test.ts`.
- **Status**: **RESOLVED 2026-09-05**.

---

## DEV-057 - A soft delete cannot be written by the role that owns the data, and nothing said so

- **Affected specification**: `14` (deny by default, row-level security as the authorization
  layer), `13` (server-authoritative authorization, privileged operations), DEC-117.
- **Expected behaviour**: an owner deleting their own item writes `owned_item.deleted_at` under
  row-level security, the same way they write every other column of that row.
- **Implemented behaviour**: the write is refused, for the owner as much as for a stranger, with
  `new row violates row-level security policy for table "owned_item"`.

  The cause is a Postgres rule rather than a policy anybody wrote. An `UPDATE` whose `WHERE`
  clause reads a column of the table requires `SELECT` rights on it, and the `SELECT` policies are
  then applied **to the new row as well as the old**. `owned_item_select` filters
  `deleted_at IS NULL`. So the row a soft delete produces is one the caller may not see, and the
  statement fails - **because the deletion worked**, not because it was unauthorized.

  Every soft-deletable table in this schema has that shape: `profile`, `household`, `app_user`,
  `allergy_record`, `condition_record`, `evidence_asset`, `owned_item`. `deleted_at` has existed
  on all of them since `0002` and `0004`, filtered by every read, and unwritable by the app role
  the entire time.

- **How it was found**: by writing the deletion policy DEC-117 requires and watching the owner be
  refused by it. The first reading was that the new restrictive policy was too strict; dropping it
  changed nothing, which is what turned the question from "is my policy wrong" into "what else is
  refusing". Isolated by removing only the `deleted_at` filter from `owned_item_select`, leaving
  everything else in place: the same statement then succeeded.
- **Reason**: the two halves are each correct and were written years apart in project time.
  `deleted_at IS NULL` in the SELECT policy is what makes revocation immediate and total - it is
  the mechanism the whole of `docs/RETENTION.md` section 1 rests on. Postgres applying SELECT
  policies to the new row is what stops an UPDATE being used to make a row invisible to its owner
  and visible to somebody else. Neither is wrong; together they mean a soft delete cannot be an
  app-role UPDATE.
- **Risk**: none realised, because nothing wrote the column. The risk it would have carried is the
  one worth naming: the obvious fix is to relax the SELECT policy so the new row is visible, which
  makes deleted rows readable and turns revocation into a filter the application is trusted to
  apply. That is the failure this deviation exists to make expensive.
- **Fix**: the stamp goes through the service role, which `13` already names for "deletion
  orchestration" and whose `owned_item_service` policy admits the new row. The rule stays in the
  database as `kynviora.delete_owned_item(item, actor)`, granted to the service role alone, which
  re-evaluates ownership in the same statement that writes - so the privileged write cannot be
  wider than the check that authorised it, and there is no window between them. Ownership is
  `kynviora.profile_owned_by`, which is `owns_profile`'s body with the user supplied rather than
  read from the request GUC; `owns_profile` now calls it, so there is one definition and the rule
  cannot drift between the policy and the purge.

  `owned_item_delete_is_owner_only` stays as well, restrictive, saying the rule out loud. Today it
  cannot fire, because the SELECT policy refuses first - which is precisely why it is worth having
  and why it is tested under the condition that would make it load-bearing: a "recently deleted"
  list or an undo needs an owner to see a row after deleting it, and the moment `owned_item_select`
  relaxes for that, `MANAGE_MEDICINES` becomes a delete capability again. `db/retention.test.ts`
  builds that future explicitly and asks the question again there, because a guard tested only
  where something else already refuses is a guard nobody has seen fire.

- **Verified**: `db/retention.test.ts` - the direct path refused for owner and caregiver alike, the
  function admitting only the owner, and the restrictive policy refusing a caregiver by name once
  the SELECT filter is relaxed.
- **Status**: **RESOLVED 2026-09-05**.

---

## DEV-058 - A deleted item could not be purged, because its children refuse to be deleted

- **Affected specification**: `16` (retention deadlines), DEC-013 (append-only), DEC-117,
  `docs/RETENTION.md` section 3.1.
- **Expected behaviour**: an item somebody deleted thirty days ago, and everything recorded
  against it, stops existing.
- **Implemented behaviour**: the `DELETE` raises `Table dose_event is append-only` - from a table
  the statement never mentioned.

  `dose_event` and `product_usage_evidence` are append-only by trigger and cascade from
  `owned_item`. A hard delete of a purgeable item therefore fires a cascade into two tables whose
  trigger refuses every `DELETE` by every role, and the whole statement rolls back. The
  thirty-day deadline `docs/RETENTION.md` commits to was **unmeetable by construction**, and
  nothing said so: no test deleted anything, because until DEC-117 there was nothing to delete.

  `profile_assessment` is the third and would have surfaced next.

- **How it was found**: by writing the sweep the matrix requires. It is the same shape as
  `DEV-056` (1) one layer down - an append-only invariant and a retention deadline, each correct,
  meeting at a foreign key nobody had walked.
- **Reason**: the cascades were written when `deleted_at` was a column nothing wrote, so no
  statement had ever reached them. `ON DELETE CASCADE` from `owned_item` is right - a dose without
  its medicine is not a record of anything - and the append-only trigger is right, because a
  correction to a dose history must be a further event. Neither is wrong; together they made a
  deletion impossible to finish.
- **Risk**: the deadline, silently missed. A person told their data would be gone in thirty days,
  with the deletion visible and total from their side and the bytes still present indefinitely.
  Nothing was exposed - revocation is complete and synchronous - so the failure is a broken
  promise rather than a leak.
- **Fix**: migration `0023` gives `forbid_mutation` a third door, as narrow as the other two: a
  `DELETE`, by `kynviora_retention`, of a row whose **parent** carries a revocation stamp at or
  before the purge floor. The child's own age is deliberately not consulted - a dose recorded this
  morning against a medicine deleted five weeks ago is due, because what is being removed is the
  medicine and everything about it.

  The sweep does **not** use the cascades. A referential action runs as the owner of the
  referencing table rather than as the session's role, so `current_user` inside a cascaded child's
  trigger is not the role that issued the statement - which makes any role check there measure the
  wrong thing, and measure it differently depending on how the database was provisioned
  (`BLK-001`). `runPurgeSweep` deletes children explicitly, deepest first, so every statement is
  issued by the role whose policies are being relied on.

  Two further things fell out of building it, both worth keeping:

  - **`DEV-057` recurred.** The Visit Pack content purge is an `UPDATE`, and its first SELECT
    policy carried `content_purged_at IS NULL` - so Postgres applied that predicate to the new row
    and refused the statement that sets it. Any policy pair where the SELECT predicate mentions the
    column the UPDATE writes has this defect.
  - **A dispatch keyed on argument count silently un-purged a table.** `0023` rewrote the trigger
    and matched door one on `TG_NARGS = 1`; `consent_receipt` carries three arguments for door
    two's sake, so it fell through to the blanket refusal and stopped being purgeable. Caught by
    `db/purge.test.ts`, which is the only place anything deletes from it. The dispatch is keyed on
    the first argument now.

- **Verified**: `db/purge.test.ts` - 12 checks, including the widest statement the retention role
  can express issued with no predicate at all, and a live shelf surviving it.
- **Status**: **RESOLVED 2026-09-05**.

---

## DEV-059 - The scan path is built and its device scenario has not been run on a device (RESOLVED)

- **Affected specification**: `19` (camera and file permissions, the thirteenth of its fourteen
  device scenarios), `04` Phase 2.2 (scan-assisted entry), `16`.
- **Expected behaviour**: `npm run verify:device:camera` runs against an attached device and
  reports five checks.
- **Implemented behaviour**: everything except the run. The screen, the permission state machine,
  the GTIN check-digit arithmetic, the copy and the harness's judgements are built and measured in
  CI - 45 tests across the domain, the screen and the device module. What has not happened is the
  run itself.
- **Reason**: `expo-camera` is a native module, so the development build on the emulator predates
  it and a scan screen that cannot mount is not a scan screen. `npx expo prebuild` and a Gradle
  assemble are what fix that, and both are minutes of wall-clock rather than a decision.
- **Temporary or permanent**: temporary, and it is work rather than a blocker - no credential, no
  reviewer and no external service is involved.
- **Risk**: low and narrow. What CI cannot answer is exactly what the harness's own docstring
  says: that Android's dialog appears when the control is pressed rather than at launch, that
  declining leaves the app usable, and that the merged manifest carries no media permission. Each
  is a claim the code makes and none has been observed.
- **Required future work**: rebuild and run `npm run verify:device:camera`.

  **A real read of a real symbol is separately out of scope, and permanently so for a harness.**
  Holding a printed barcode in front of an emulator's virtual camera is not something a script can
  arrange, and the emulator's virtual scene is not a product pack. That check is manual, and
  `verifyCameraPermission.ts` says so rather than putting a green tick over a fixture.

- **Resolved 2026-09-05.** `npx expo prebuild` and a Gradle assemble produced a build carrying
  `expo-camera`, and `npm run verify:device:camera` reports **5/5 PASS** on a Pixel 7 / Android 16
  emulator: the scan screen opens with its disclosure and no system dialog, the camera permission
  is not held after a launch that never scanned nor merely by opening the screen, declining it
  leaves the app running with the manual path on screen, none of eight storage, media, audio,
  location or contacts permissions is granted or declared, and the run left the permission as it
  found it.

  It took four runs, and each failure was a defect rather than flakiness - three in the harness
  and one in the app (`DEV-060`). The harness ones are worth naming because each made a check that
  **could not run** look like a check that ran and found something:

  | What was wrong                                                                                   | How it presented                                                                               |
  | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
  | `dumpsys window windows` names permissioncontroller 26 times on an idle launcher                 | `CAM-2`: "the dialog was not dismissed with a refusal" - the branch for a dialog that appeared |
  | Android renders the button as `Don’t allow` with U+2019                                          | `tapNamed` matched nothing, indistinguishable from no dialog                                   |
  | `nodeNamed` filters to the app's own package, by design                                          | the same, for a second reason, on the same line                                                |
  | `pm revoke` leaves `USER_FIXED`, so the harness's own refusals permanently denied the permission | `CAM-0`: the disclosure "missing" from a screen correctly showing the blocked state            |

  The real read of a real symbol remains out of scope for a harness, permanently: an emulator's
  virtual scene is not a product pack. That check is manual and the runner says so.

- **Status**: **RESOLVED 2026-09-05.**

---

## DEV-060 - A first-time user was told the camera was switched off before ever being asked

- **Affected specification**: `16` (request a permission by a visible feature at the moment it is
  used; prominent disclosure), `18` (a control that cannot work must not be offered, and a person
  must be able to tell what happened), `04` Phase 2.2.
- **Expected behaviour**: somebody opening the scan screen for the first time sees the disclosure
  and a control that asks for the camera.
- **Implemented behaviour**: they saw **"The camera is switched off for Kynviora. Android will not
  let Kynviora ask again."** with no way to ask, on a device where nothing had ever been asked.

  `cameraPermissionState` mapped a response of `granted: false, canAskAgain: false` to `BLOCKED`,
  which is correct after somebody has chosen "don't ask again" and wrong before anything has
  happened at all. `canAskAgain` comes from Android's `shouldShowRequestPermissionRationale`, and
  **that returns `false` in both situations**: before the first request ever, and after a permanent
  refusal. The platform does not distinguish them, and neither did this.

- **How it was found**: `npm run verify:device:camera`, on hardware, and by nothing else. Every
  unit test passed throughout, because every one of them supplied a response the app would only
  ever see _after_ asking - which is the shape of assumption a device run exists to break. The
  first three failing runs were harness defects (`DEV-059`); this was underneath them.
- **Reason**: the state machine was written from the four states a permission can be in, which is
  the right model, and given the response as its only input - which is the wrong input, because
  one of the four is not derivable from it.
- **Risk**: high for the feature and zero for anything else. It made the scan path unreachable for
  every new user on Android, on their first attempt, with copy telling them to go to Settings and
  turn on a permission that was not off. Nothing else in the app is affected and no data is at
  risk; what was lost is the feature, silently, for exactly the people meeting it for the first
  time.
- **Fix**: `cameraPermissionState` takes `hasRequested`, and `ScanBarcode` holds it. Before a
  request, a not-yet-granted permission is `UNDETERMINED` whatever the response says; after one,
  the response means what it says. Screen-local rather than persisted, so somebody returning
  tomorrow is offered the ask again.
- **Verified**: `packages/domain/src/barcodeScan.test.ts` pins both readings of the identical
  response; `ScanBarcode.test.tsx` reaches the refusal states by **pressing** rather than by
  loading, which is what the old tests were not doing; `npm run verify:device:camera` **5/5 PASS**.
- **Status**: **RESOLVED 2026-09-05**.

---

## DEV-061 - A medicine schedule would have accepted an offset where a time zone belongs

- **Affected specification**: `04` Phase 4.1 (time-zone handling: "08:00" survives a daylight-saving
  transition and a flight; an instant computed once does not), `04` Phase 4.2, DEC-119.
- **Expected behaviour**: `normalizeScheduleEntry` refuses anything that is not a named IANA zone,
  because the whole reason a schedule stores `times_local` plus `timezone` is that an offset is
  wrong twice a year.
- **Implemented behaviour**: `isKnownTimeZone` asked only whether `Intl.DateTimeFormat` accepted the
  string - and **modern ICU accepts `+05:30`**. A schedule submitted with an offset was stored, and
  would have fired at the right minute until the next transition and an hour out afterwards. For a
  medicine reminder that is somebody being told to take a tablet an hour early, twice a year,
  indefinitely.
- **How it was found**: by writing the same validator a second time for `DEV-030` and testing it
  against the values a device might report. `+05:30` was in the list of things expected to be
  refused; it was not refused; and the existing implementation had the same hole.
- **Reason**: "ask the platform rather than keep a list" is the right instinct and the original
  comment says so - a bundled list of IANA zones goes stale. What it missed is that the platform is
  answering a wider question than the one being asked: `Intl` accepts anything it can format
  against, and an offset is something it can format against.
- **Risk**: unrealised. Nothing in this build submits an offset - the mobile schedule editor sends
  `Intl.DateTimeFormat().resolvedOptions().timeZone`, which is always a named zone - so no stored
  schedule has one. What it left open is any future client, or any hand-written request, putting a
  reminder an hour out for half the year with nothing refusing it.
- **Fix**: one validator, in `timeZone.ts`, refusing offset shapes explicitly before asking ICU.
  `scheduleEntry.ts` re-exports it, so the schedule path and the quiet-hours path cannot drift and
  the fix applies to both.
- **Verified**: `packages/domain/src/timeZone.test.ts` refuses `+05:30`, `-0800`, `+07` and `-5`
  through both `isKnownTimeZone` and `asTimeZone`; `scheduleEntry.test.ts` passes unchanged, which
  is the point - the narrowing rejects nothing a real client sends.
- **Status**: **RESOLVED 2026-09-05**.

---

## DEV-062 - Account deletion is built and does not yet complete on a device (resolved)

- **Affected specification**: `16` (a person can have their data removed; the deletion workflow
  enumerates device local data, primary records, object storage, derived projections, queued jobs,
  cached exports, notification tokens and backups), `04` Phase 1.4, DEC-120.
- **Expected behaviour**: a person can remove their account and everything in it.
- **Implemented behaviour**: they can remove any item and any profile, which between them is
  every health record the system holds about them. What they cannot remove is the account itself -
  the `app_user` row, the consent receipts, and the identity at the auth provider.
- **Reason**: the identity is not Kynviora's to delete. Removing `app_user` while Supabase still
  holds the account produces somebody who can sign in successfully to a row that is gone, which is
  a worse state than not having deleted anything - and removing the other half needs the Supabase
  admin API and credentials that do not exist (`BLK-010`).
- **Temporary or permanent**: temporary, and blocked on a credential rather than on work. The
  server side of it is three statements; what is missing is the account to delete them alongside.
- **Risk**: low and bounded, and the boundary is where a person would want it. Everything about
  their health - profiles, medicines, doses, allergies, assessments, alerts, caregiver access -
  is removable today, immediately and completely. What remains is an email address, a consent
  history retained on an approved basis for 24 months (DEC-117), and an audit trail that says the
  deletions happened.

  The screen says so and says which is which, rather than "not built yet" over both halves - which
  would now understate what exists and send somebody looking for a control they have walked past.

- **Required future work**: a Supabase project and service-role credentials. Then
  `DELETE /v1/me`: stamp `app_user`, delete the auth user through the admin API, invalidate every
  session, and let the purge take the rest. The order matters and is the reason this cannot be
  half-built - the auth user must go first, so a failure part-way leaves an account that still
  works rather than one that cannot be reached and cannot be removed.
- **Status**: OPEN, and **no longer blocked on a credential** (2026-09-06).

- **What changed, 2026-09-06.** The credential objection is gone. DEC-126 removes the identity
  through the `close-identity` Edge Function, so no service-role key enters this process at all,
  and the API reports `can_remove_identity: true` for the first time. The function was smoke-tested
  against a throwaway identity end to end: 401 with no token, 405 on `GET`, 204 on `POST`, and the
  identity genuinely gone afterwards - the provider answers `invalid_credentials` to credentials
  that worked one second before.

  The screen exists and two of its six device checks pass against the real stack:

  | Check   | Result | What it showed                                                             |
  | ------- | ------ | -------------------------------------------------------------------------- |
  | `DEL-1` | PASS   | the screen names all four things the deletion removes, and what is kept    |
  | `DEL-2` | PASS   | a wrong password deleted nothing - verified in the database, not on screen |
  | `DEL-3` | FAIL   | the real deletion was refused                                              |
  | `DEL-4` | FAIL   | follows from DEL-3: the identity is still there                            |
  | `DEL-5` | INCONC | the account owned nothing, so nothing had to go with it                    |
  | `DEL-6` | FAIL   | follows from DEL-3: no `account.deleted` record                            |

- **Why it is still open, precisely.** Two faults, both in code written on 2026-09-06 and neither
  in the deletion itself.

  1. **The screen calls `deleteAccount()` on a client captured before re-authentication.**
     `reauthenticate` produces a _new_ token - that is what a step-up **is** on this provider - and
     the client in the callback's closure still carries the old one, so the server sees a stale
     step-up and refuses. The API log shows no deletion request completing, which is consistent.
     The fix is to issue the deletion on the client the new session produces.
  2. **The scenario seeds nothing to lose.** `POST /v1/households` answered 400, so the request
     shape in `verifyDeleteAccount.ts` is wrong, and `DEL-5` cannot show that anything went with
     the account because nothing was under it.

- **Risk**: unchanged and low. The route refuses rather than half-completing, which is the property
  DEC-125 was built around and which `DEL-2` measured directly: a wrong password left the account
  and its rows untouched. Nothing is deleted that should not be; what does not work yet is the
  deletion succeeding.
- **Required future work**: the two fixes above, then a clean `npm run verify:device:delete`.

- **Resolved 2026-09-06.** Both faults are fixed and `npm run verify:device:delete` is **6/6 PASS**
  against the real stack - the app on an emulator, the API on `kynviora-dev`'s pooler with
  `dev_auth:false`, and the identity removed by the `close-identity` Edge Function.

  | Check   | What it showed                                                                                       |
  | ------- | ---------------------------------------------------------------------------------------------------- |
  | `DEL-1` | the screen names all four things the deletion removes, and what is kept, before offering the control |
  | `DEL-2` | a wrong password deleted nothing - the account and its profile untouched, read in the database       |
  | `DEL-3` | the app returned to the sign-in screen with none of the account's content on it                      |
  | `DEL-4` | credentials that signed in moments earlier are refused as unknown - the identity is gone             |
  | `DEL-5` | the profile and the account are both stamped; nothing is hard-deleted (DEC-117)                      |
  | `DEL-6` | `account.registered`, `account.deleted`, `account.identity_removed`, and no row carries the address  |

  The first fault was one line, and the file's own comment had already said what to do about it.
  `DeleteAccount.tsx` issued the deletion on the client captured in the callback's closure, which
  carries the **pre**-re-authentication token: `ApiProvider` memoises the client on the access
  token, so the new one arrives on the next render, which is after the callback has finished. The
  server read step-up from the stale `amr`, refused, and the screen worded that as "that password
  was not right" - about a password that was. It is built from the tokens `reauthenticate` returns
  now, which is why that function returns them.

  The second was the harness. `idempotencyKey` went in the body, where the API reads
  `Idempotency-Key` as a **header** validated as a UUID and the body schemas are `.strict()` - so
  the request failed twice over, nothing was seeded, and `DEL-5` had nothing under the account to
  measure.

- **Status**: **RESOLVED 2026-09-06.** What a green run does not cover is written into the scenario
  itself: the account it deletes was created and confirmed by an operator, because confirming an
  address needs a mailbox (`BLK-010`), and a deletion that passes is not evidence about sign-up.

---

## DEV-063 - The sweep interval was the overshoot past every deadline (resolved)

- **Affected specification**: `16` (retention deadlines: personal data purged **within** 30 days,
  Visit Pack content **within** 24 hours of expiry, unattached capture artifacts **within** 7
  days), `docs/RETENTION.md` sections 3.1, 3.2 and 8.3, DEC-117, DEC-121.
- **Expected behaviour**: a row is physically gone by its deadline.
- **Implemented behaviour**: a row is physically gone somewhere in
  `[deadline, deadline + sweep interval]`. With the default interval that is up to one hour past a
  thirty-day promise, and up to one hour past a twenty-four hour one.
- **Reason**: every eligibility floor in `0023` sits **exactly on** its deadline -
  `purge_floor()` is `now() - interval '30 days'`, and Visit Pack content becomes purgeable at
  `expires_at + 24 hours`. A row therefore becomes eligible at the deadline and is removed by the
  next sweep after it. Sweeping is discrete and the promise is not, so **no finite interval closes
  this** - it can only be made small.

  Worth naming precisely, because it is easy to read the worker as having closed the gap DEC-121
  was about. It closed the large one: nothing ran at all, and the deadline was unbounded. What is
  left is bounded, stated and configurable.

- **Temporary or permanent**: temporary, and it is a decision rather than work. Two ways to close
  it:
  1. **A margin in the floors.** Purge at `deadline - interval`, so the promise is kept at the
     deadline rather than shortly after it. Three lines of SQL - and it changes what the RLS
     policies admit, which is a change to the security boundary `0023` is careful about, so it
     wants deciding rather than doing. It is also the only direction that is safe to get wrong:
     purging slightly early is more protective, not less.
  2. **A continuous sweep.** Does not exist, and would be a much larger change for a smaller
     benefit than (1).

- **Risk**: low, bounded, and in the protective direction. A row in the overshoot window has
  already been **inaccessible** for the whole of its deadline - revocation is synchronous
  (`docs/RETENTION.md` section 1), so nothing reads it, no reminder plans from it, no export
  includes it and no caregiver reaches it. What persists an hour longer than promised is bytes
  nobody can address.

  The bound is enforced rather than documented: `readRetentionWorkerConfig` refuses an interval
  above 24 hours, which is the shortest deadline in the matrix, because an interval longer than a
  deadline could more than double the life of the content it governs.

- **Required future work**: none. See below.
- **Status**: **RESOLVED 2026-09-05** (DEC-123), and by neither of the two ways above.

  The third way was to stop scheduling from an interval at all. `kynviora.next_purge_due()`
  (migration `0031`) returns the earliest instant at which any row becomes purgeable, and the
  worker sleeps until whichever comes first, that or the heartbeat. **No floor moved and no policy
  changed** - which was the objection to (1) - and nothing is removed a second before it is due.
  The matrix in `docs/RETENTION.md` 3.1 and 3.2 is unchanged to the microsecond, and
  `purgeDeadline.test.ts` still measures it.

  | Before                                            | After                                |
  | ------------------------------------------------- | ------------------------------------ |
  | `[deadline, deadline + interval]`, default 1 hour | `[deadline, deadline + one sweep]`   |
  | The interval was the overshoot                    | The interval is a heartbeat          |
  | Worst case 4% of the 24-hour Visit Pack deadline  | Worst case the duration of one sweep |

  What the heartbeat still covers is recorded separately as `DEV-065`, because it is a different
  thing: eligibility that arrives by a **state change** rather than by a clock, which no deadline
  function can name in advance.

  The test that matters is not that the function computes thirty days. It is that it agrees with
  the **policy**: in one transaction, a row stamped at `purge_floor()` is visible to
  `kynviora_retention`, one stamped a microsecond later is not, and `next_purge_due()` names that
  microsecond (`db/nextPurgeDue.test.ts`).

---

## DEV-065 - Eligibility that arrives by a state change has no deadline to schedule against

- **Affected specification**: `16` (unattached capture artifacts purged **within** 7 days),
  `docs/RETENTION.md` sections 3.3 and 8.3, DEC-122, DEC-123, migration `0031`.
- **Expected behaviour**: a row is physically gone by its deadline.
- **Implemented behaviour**: for the two categories whose eligibility depends on something other
  than a clock, a row is gone somewhere in `[eligible, eligible + heartbeat]` - up to one hour by
  default, capped at 24.
- **Reason**: `next_purge_due()` can only name an instant that is computable now. Two cases are
  not:

  1. **A capture artifact detached later.** An evidence asset becomes purgeable seven days after
     creation **and while unattached**. One attached today and detached next month is already past
     seven days at the moment it is detached, so its eligibility instant is the detachment - which
     nothing schedules and nothing signals.
  2. **A digest emptied by another category.** `notification_digest` is purgeable once it has no
     entries left, and its entries go with the `alert_delivery` rows in the profile block of the
     same sweep. It becomes eligible during a sweep rather than at a time.

  Case 2 is almost always resolved within the same run, because `DIGEST` runs after `PROFILE` in
  the plan. Case 1 is the real one.

- **Temporary or permanent**: temporary in principle, and closing it needs a signal rather than a
  schedule - the moment an asset is detached is a moment the application knows about, so a stamp
  written then would make the deadline computable. That is a schema change to a table the capture
  pipeline writes and it is not worth making before `BLK-007` decides what that pipeline is.
- **Risk**: low, and smaller than what `DEV-063` carried. It is one hour by default on a
  seven-day promise, and only for artifacts that were attached at their seventh day and detached
  afterwards - which requires a correction, since nothing else detaches one. A row in that window
  has been unreachable throughout: an unattached asset is referenced by nothing, so no screen, no
  export and no assessment can reach it.
- **Required future work**: a `detached_at` stamp written where an asset is detached, and one more
  subquery in `next_purge_due()`. Or nothing, and the heartbeat continues to cover it.
- **Status**: OPEN, not blocked.

---

## DEV-064 - A digest is assembled and nobody can read one

- **Affected specification**: `04` Phase 7.5 (digest policy for lower urgency), `02` (not
  interrupting is the default rather than a degradation), DEC-122.
- **Expected behaviour**: a household sees the low-urgency events that accumulated, together,
  without a phone having lit up for each one.
- **Implemented behaviour**: the digest is **assembled**, revalidated at assembly time and
  recorded, once per recipient per recipient-local day at 09:00 (DEC-122). There is no route that
  returns one and no screen that shows one, so the only way to read a digest today is to query the
  database.
- **Reason**: two halves, one of which is blocked and one of which is not.

  **Blocked:** sending it. `BLK-009` - no push credentials, so nothing is delivered, and
  `notification_digest.delivered_at` will stay NULL until they exist.

  **Not blocked:** showing it. That is ordinary work, and it was left out of DEC-122 deliberately
  rather than forgotten: a digest screen overlaps the Safety Inbox, which already shows every one
  of these events, so what a digest surface should be **instead of** the inbox is a product
  question rather than an engineering one. Building a second list of the same rows before that
  question is answered would be inventing a design nobody asked for, in the surface where `02`
  cares most about not adding noise.

- **Temporary or permanent**: temporary.
- **Risk**: low. Nothing is lost and nothing is claimed: every event in a digest is already
  reachable in the app through the Safety Inbox and the Shelf, which is what `DIGEST` and
  `IN_APP_ONLY` have both meant all along. No screen promises a digest, so no screen is wrong.
  The failure it leaves is the one `DEV-033` named and did not close - a household must open
  Kynviora to see a `MEDIUM` finding rather than being told - and `02` treats not interrupting as
  the default rather than a degradation.
- **Required future work**: a decision on what a digest surface is for given the Safety Inbox
  exists, then `GET /v1/notifications/digest` returning the most recent digest and its included
  entries under the same disclosure rules a live read uses, and a screen. Delivery stays on
  `BLK-009` and is independent of both.
- **Status**: OPEN, not blocked for the read surface; the delivery half is blocked on `BLK-009`.

---

## DEV-066 - Anybody with their own token can remove their own identity without Kynviora knowing

- **Affected specification**: `16` (the deletion workflow removes an account and everything under
  it), `14`, DEC-120 (the ordering that stops a half-deletion), DEC-125, DEC-126.
- **Expected behaviour**: an identity is removed only as the last step of a Kynviora deletion, so
  the rows the identity owned are always stamped first.
- **Implemented behaviour**: the `close-identity` Edge Function can be invoked directly by any
  caller presenting a valid access token, and it will remove that token's own identity. A person
  who did so would leave an `app_user` row - and every profile, medicine and dose under it - live
  and permanently unreachable, because nothing can authenticate as that subject again.
- **Reason**: the check that would prevent it cannot be made where it would have to be made. The
  function would have to know that Kynviora had already stamped the account, and it cannot look:
  Kynviora's tables are owned by `kynviora_migrate` and granted only to `kynviora_app`,
  `kynviora_service` and `kynviora_retention`, so Supabase's own `service_role` has **no privilege
  on `app_user` at all**. That was measured, not assumed, and it is a property worth keeping - the
  parity suite asserts a version of it - rather than a gap to widen by granting a platform role
  access to health data so that one function can read one column.

  The alternative check is a shared secret only Kynviora's API holds, and the function already
  implements it: `KYNVIORA_DELETION_SECRET`, required in `x-kynviora-deletion` when the function
  has one and ignored when it does not, compared in constant time. Setting it needs
  `supabase secrets set` - the CLI with a project access token, or the dashboard - and neither is
  reachable from this environment, which has the MCP connector's deploy verb and no secret verb.

- **Temporary or permanent**: temporary, and closed by one command rather than by any code change.
  The function checks the secret already; setting it on both sides is the whole of the work.
- **Risk**: low, and self-inflicted rather than reachable by anybody else. The worst outcome is
  that a person removes **their own** sign-in and orphans **their own** rows - there is no
  parameter naming a user, so no token can be used against a second account, which is the failure
  that would matter. It requires deliberately calling an undocumented function URL with one's own
  bearer token; the app never does it, and the ordinary path through `DELETE /v1/me` stamps first
  and always has.

  What it costs if it happens is retention rather than exposure: the orphaned rows stay behind
  their own row-level security, unreadable by every role and every session, until the purge
  windows take them. Nobody sees anything they should not; some bytes outlive their owner's
  intention.

- **Required future work**: `supabase secrets set KYNVIORA_DELETION_SECRET=<value>` on the project,
  and the same value in `KYNVIORA_SUPABASE_DELETION_SECRET` for the API. No redeploy of either
  side is needed - the function reads it at request time and the API sends the header when it has
  one.
- **Status**: OPEN, blocked on tooling rather than on a decision.

---

## DEV-067 - A signed-out app asked the API for things, and one refusal signed a returning person out (resolved)

- **Affected specification**: `13` (every request derives authority from an authenticated session),
  `12` (authorization loss invalidates local access), `04` Phase 1.1, DEC-118, DEC-124, `19`.
- **Expected behaviour**: nothing asks the API anything until it is known who is asking.
- **Implemented behaviour (historical)**: `ProfileProvider` and `TimeZoneReporter` sit under
  `AccountGate` and above `AuthGate`, and each fires a request on mount. On a cold start the stored
  session has not been read yet - it lives in an encrypted database and opening one is a keystore
  round trip - so `GET /v1/profiles` and `PUT /v1/me/time-zone` went out with no credential on
  them.
- **Why it mattered, which was not obvious**: the transport watches for a `401` and reports the
  session lost, and `sessionLost` does not only forget the session on screen - it **deletes it from
  disk**. So the app signed the person out on its own cold start and erased their session, and a
  phone that answered faster did it more reliably. `19` `SIGN-7` failed on a fresh emulator and
  passed on a warm one, which is what a race looks like from the outside; `SIGN-8` and `SIGN-6`
  then failed downstream, because there was no session left to renew or to revoke.
- **How it was found**: `api.request.unauthenticated`, added the same day. The API had never
  recorded a refusal, so "the API log has zero 401s" had been true of every run there has ever
  been - including the ones where a phone was being refused - and the previous session's diagnosis
  rested on that silence.
- **Status**: **RESOLVED 2026-09-06**, twice over. Only a request that carried a session may report
  one lost, which is the invariant and would be right on its own; and `AccountGate` holds the whole
  subtree while the auth state is `LOADING`, so those requests are not made at all. `LOADING` is
  not "signed out" and it is not "nobody" either - it is a database being opened.
- **Risk now**: none known. What remains untested is what was untested before: a device whose
  keystore refuses, where the store never opens. `LocalStoreProvider` settles either way so the
  gate resolves, and nothing measures that on hardware.

---

## DEV-068 - A second self-profile answers 500 rather than a refusal

- **Affected specification**: `13` (clients branch on codes; a refusal says which gate refused),
  `18` (a refusal says what to do next), `04` Phase 1.2.
- **Expected behaviour**: `POST /v1/profiles` with `isSelf`, for an account that already has a live
  self-profile, is refused with a code a screen can act on.
- **Implemented behaviour**: `profile_self_user_unique` raises, `insertOrRefusal` handles only the
  row-level-security refusal (`42501`), and the unique violation reaches the error handler as
  `INTERNAL` - `{"code":"INTERNAL","message":"Something went wrong.","retryable":false}` - with
  `api.unhandled_error` in the log and no reason in it.
- **How it was found**: `verify:device:delete` seeds a profile through the real route, and the
  second run against the same account got a 500 where the first had succeeded.
- **Reason it is open**: the constraint is right and the refusal is missing. Mapping `23505` to a
  domain refusal is small, but which code it should carry is a decision about the vocabulary -
  `VALIDATION_FAILED` with a reason code, or a new `CONFLICT` - and the same question applies to
  every other unique index a route can hit. The item and household idempotency indexes already
  answer it differently, by reading the stored row back instead of refusing. Doing one and not the
  others would leave the shape inconsistent in exactly the way `13` is about.
- **Workaround in place**: the deletion scenario no longer asks for `isSelf`. What `DEL-5` needs is
  a profile, not this account's own.
- **Risk**: low, and not a safety boundary. Nothing is written that should not be - the constraint
  holds - and the caller is told the write failed. What they are not told is why, so a screen
  cannot offer a next step, and an operator reading the log sees only that something threw.
- **Required future work**: none.
- **Status**: **RESOLVED 2026-09-06** (DEC-129).

  The vocabulary decision went to a new `ALREADY_EXISTS` at 409, and the mapping went to the
  **Fastify error handler** rather than to `insertOrRefusal` - which is a wrapper over five call
  sites, while a `23505` can come out of any statement. Every route inherits it, and the routes
  that answer their own duplicates by reading the stored row back under an idempotency key never
  reach it at all, because `ON CONFLICT DO NOTHING` raises nothing.

  The half worth recording is what the refusal may not say. A unique index is enforced over every
  row in the table, **including rows row-level security hides from this caller**, so naming the
  constraint or describing the conflicting row would be an oracle for data they were never allowed
  to read. The message is generic, there is no `detail`, and the driver's own `detail` field -
  which reads `Key (self_user_id)=(<uuid>) already exists.` - is read nowhere. The constraint name
  goes to the log as `api.write_refused_as_duplicate`, validated against an identifier pattern
  first.

  The deletion scenario's workaround is left in place. `DEL-5` needs a profile rather than this
  account's own, so asking for `isSelf` was never what that check was about.

---

## DEV-069 - An account cannot be created through the app's own form without a mailbox

- **Affected specification**: `04` Phase 1.1 (sign-up), `19` scenario 14 (`SIGN-2`, `SIGN-10`),
  `BLK-010`.
- **Expected behaviour**: the fourteenth device scenario creates an account through the app's own
  sign-up form, and shows that an address nobody has confirmed cannot be signed in to.
- **Implemented behaviour**: the app asks, and the provider refuses the **address**:

      400 email_address_invalid   Email address "kynviora-signin-...@kynviora.test" is invalid

  carrying an `auth_event` of `user_confirmation_requested` - so GoTrue got as far as sending the
  confirmation, could not, and rolled the user back. No account exists, and `SIGN-10` has nothing
  to be refused.

- **Reason**: `kynviora.test` has **no MX record**, and `example.com` and `example.org` publish a
  **null MX** (RFC 7505), which is a domain saying in the DNS that it accepts no mail. This project
  will not create an account it cannot send a confirmation to.
- **What this corrects**: four runs recorded these two checks as blocked by the built-in mailer's
  quota - two messages an hour, spent by an attempt rather than by a delivery. The quota is real
  and it never fired: there is no `over_email_send_rate_limit` anywhere in the provider's log for
  any of those runs, and a refusal for an undeliverable address costs none of it, because nothing
  is sent. The diagnosis was wrong, and wrong in the direction that wastes an hour at a time.
- **Workaround in place**: `KYNVIORA_SIGNIN_SIGNUP_DOMAIN` selects the domain the app signs up
  with. The default is unchanged, so nothing moves silently, and the run reports honestly that the
  provider refused the address.
- **Risk**: none to the product. What the app does on this path is measured as far as it can be -
  `SIGN-1` and `SIGN-3` show the form and its refusals - and what is not measured is said.
- **Required future work**: a domain whose mail somebody can receive. That is `BLK-010` and not a
  separate blocker, which is the useful half of this finding.
- **Status**: OPEN, blocked on `BLK-010`.

---

## DEV-070 - Haptics are designed, wired and not felt (resolved)

- **Affected specification**: `18` (feedback channels), `12` (platform behaviour behind an
  adapter), DEC-131.
- **Expected behaviour**: pressing a control, confirming a dose and being refused each produce the
  platform's own haptic.
- **Implemented behaviour**: the intent vocabulary, the adapter and every call site are real. The
  installed engine records what it was asked for and does nothing, so no phone vibrates.
- **Reason**: there is no haptic engine in this build's dependency set and adding one is not a
  design decision. React Native's own `Vibration` needs `android.permission.VIBRATE` in the merged
  manifest, and `expo-haptics` is a native module needing `expo prebuild` and a fresh development
  build. A newly declared permission appears on the Play listing and in the Data-safety form, which
  is a product decision rather than a side effect of a styling pass - and `verify:device:camera`
  exists precisely because a permission can arrive in a merged manifest with no screen changing.
- **Workaround in place (historical)**: `createRecordingHapticEngine` was installed by default and
  `installHapticEngine` took a real one in a single call at the root. The call sites were asserted
  by test, so the half that can be measured without hardware was measured.
- **Risk**: none. Nothing in this app reports anything through touch alone (DEC-131), so an absent
  haptic cost a small amount of polish and no information.
- **How it resolved**: **the stated reason was false, and checking it took one command.**
  `android.permission.VIBRATE` is already declared - the manifest merger report attributes it to the
  app's own `AndroidManifest.xml`, where `expo-notifications`' config plugin puts it, and
  `dumpsys package com.kynviora.app` lists it among the requested permissions of the build installed
  on the emulator today. So React Native's own `Vibration` needed no new permission, no new
  dependency and no prebuild, and `createVibrationHapticEngine` is installed at the root (DEC-139).

  It is Android only. `Vibration.vibrate()` on iOS takes no duration, so every call is the same
  full-length buzz and a `selection` tick would be that buzz on every press of every chip; the
  adapter answers `null` there and the recording engine stays installed, which is the honest version
  of "iOS is unverified" rather than a wrong feeling shipped as a right one.

  **What being wrong about this cost**: a designed, wired and tested feature nobody could feel,
  because the blocker was recorded as a fact and never re-measured. The lesson is narrow and worth
  having: a blocker whose premise is a property of the build should be re-checked against the build,
  not against the note that first described it.

- **Still true**: a haptic is never the report of anything. Every call site fires one beside a
  sentence already on the screen (DEC-131), and there is still no `error` intent to reach for.
- **Status**: **RESOLVED 2026-09-07** (DEC-139).

---

## DEV-071 - A dose recorded by voice with no signal is not queued (resolved)

- **Affected specification**: `12` (a queued change is visible rather than assumed), `03` group J,
  DEC-111, DEC-132.
- **Expected behaviour**: recording a dose through Voice Mode with no network writes it into the
  offline journal under the key the attempt minted, exactly as the dose sheet does.
- **Implemented behaviour**: the request is made, it fails, and Voice Mode says the phone has no
  connection. Nothing is queued, so the dose is lost rather than delayed.
- **Reason**: the journal is reached through `usePendingSync`, which the dose sheet holds and the
  voice executor does not. Wiring it is small; what it needs first is a decision about **what the
  queue does to a conversation** - a queued dose is a promise about a later moment, and the
  confirmation a person just gave was for "record this", not for "keep this here and send it when
  you can". Making that change without saying it in the summary would be confirming one sentence
  and performing another, which is the failure DEC-134 exists to prevent.
- **Workaround in place (historical)**: the honest sentence. Voice Mode said the phone had no
  connection and said nothing about having kept anything - the same distinction the dose sheet draws
  between "Recorded." and the queued wording, which `OFF-6` measures on a device.
- **Risk**: low, and in the safe direction. A person was told the record was not made, which was
  true. The opposite failure - saying it was kept when nothing was - is the one `OFF-6` exists for.
- **How it resolved**: DEC-140 settles the semantic question the wiring was waiting on. **A
  confirmation is for the record, not for the transport**: what somebody agreed to when they said
  "record that I took it" is the record being made, and whether it travels now or in ten minutes is
  a fact about the phone's radio. So the summary is unchanged and describes the intent; the
  **report** says what happened, using `UTTERANCES.queued` - which already existed and is exactly
  this sentence - instead of "Done.", never as well.

  The queue is the one that already exists. `usePendingSync().queue`, `dose_event`, `CREATE`, under
  the key the failed attempt already spent (DEC-111) - so the drain, `13`'s per-entity policy, the
  retry budget and `PendingSenders`' wire call are all the ones `OFF-6` and `OFF-7` already exercise
  on hardware. Voice adds no sync mechanism; it reaches the one that exists.

  A `false` from the journal is a real answer - the store may not be open, or the device may have no
  room (`DEV-055`) - and it produces the "no connection" sentence rather than the queued one,
  because a person told their dose was kept when nothing kept it stops thinking about a record that
  does not exist.

- **What it found on the way**: `DEV-078`. Every failure had been reported as "no connection",
  including the ones where a server had answered and declined.
- **Status**: **RESOLVED 2026-09-07** (DEC-140).

---

## DEV-072 - Fifty suites boot a database in parallel, and 60 seconds stopped covering it

- **Affected specification**: `19` (a test that could not run is not a pass), `21`.
- **Expected behaviour**: `npm run verify` fails only when something is wrong.
- **Implemented behaviour (before the fix)**: two files timed out in `beforeAll` on one run and a
  different one on the next, each passing in seconds when run alone. `Hook timed out in 60000ms`,
  with nothing wrong in any of them.
- **Reason**: fifty test files open their own PGlite instance in `beforeAll`, each costing an engine
  plus every migration, and they run in parallel - so the cost of one is a function of how many
  others are booting at the same moment. The suite grew past the point where 60s covered it: this
  session added 8 files and 165 tests, and the failures started.
- **How it resolved**: the server project's `hookTimeout` is 180s. `main.test.ts` and
  `clientIntegration.test.ts` had already reached that number and set it per file; this is the same
  decision applied where the cause actually is. These tests are not slow by accident - they boot a
  real database on purpose - and a timeout that fires on load rather than on a hang teaches people
  to re-run rather than to look.
- **Risk**: a genuinely hung `beforeAll` now takes three minutes to report instead of one. Accepted:
  a hang is rare and loud, and a flake is common and quiet.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-073 - A scripted agent behind a flag, because a device run had nothing to drive

- **Affected specification**: `19` (a device scenario measures what only a device can show), `17`
  (no provider is chosen), `14` (a development affordance grants nothing). DEC-136, `BLK-012`.
- **Situation**: with no speech or language provider, the app understands nothing, so the only
  thing a device could show about Voice Mode was that a screen renders. The confirmation flow, the
  touch-only refusal and the very large controls - the parts worth measuring on hardware - were all
  unreachable.
- **What was done**: `EXPO_PUBLIC_DEV_VOICE_SCRIPT=1` installs `createScriptedAgent`, a list of
  regular expressions, in a development build. Absent in every ordinary run, and the recogniser and
  synthesizer stay `null` either way - a fake microphone would be a fake measurement.
- **Why it is not a cheat**: it grants nothing. Every proposal it makes goes through the same six
  gates as any other, which is exactly what `verify:device:voice` measures - and the most useful
  scripts in it are the ones that **misbehave**: a proposal to close the account, one to change a
  dose, one carrying an argument no tool declares. What the run establishes is that those are
  refused on real hardware and that the refusal is a sentence somebody can read.
- **What it does not establish**: that a real model would propose the right tool for a real
  sentence. That half is unmeasured because there is no provider (`BLK-012`), not because nobody
  looked, and the scenario's own header says so.
- **Risk**: low. The flag defaults to off; nothing listens, so there is no path from a person's
  speech to it; and it cannot reach anything the app's own screens cannot.
- **Required future work**: delete it when a provider lands, or keep it as the deterministic agent
  CI drives - which is what it already is in `packages/agent`.
- **Status**: OPEN, by design.

---

## DEV-074 - Voice offers a caregiver less than they may actually do (resolved)

- **Affected specification**: `11` and `13` (the server decides), `14` (deny by default), DEC-116,
  DEC-132.
- **Expected behaviour**: a caregiver granted `MANAGE_MEDICINES` can set a reminder time by voice,
  as they can by touch.
- **Implemented behaviour**: they are told to use the screen. `capabilitiesFor` gives an owner
  everything and gives a caregiver the read capabilities plus whatever the server has actually
  reported - `mayRecordDoses` from a shelf page, `mayEdit` from an item detail. There is no route
  that answers "what may this caller do on this profile", so anything not reported is not offered.
- **Reason**: the alternative is assuming a capability and letting the route refuse, which is a
  person completing a spoken form for nothing - the failure DEC-116's screen half exists to prevent,
  arriving through a different door.
- **How much less it actually offered, once somebody looked.** More than this entry said.
  `VoiceProvider` called `capabilitiesFor({ isOwner: owns })` and passed **neither** of the two
  answers the app already had, so a caregiver was offered the three read capabilities and nothing
  else, in every session, whatever their grant said. Three tool capabilities were unreachable by
  voice and reachable by touch: `RECORD_DOSES`, `MANAGE_MEDICINES` and `MANAGE_PERSONAL_CARE`.
- **Workaround in place (historical)**: the refusal said what to do next and the screen it pointed
  at worked. An owner - which is who Voice Mode is for first - was unaffected.
- **Risk**: none to safety, and it was in the safe direction. What it cost was a caregiver's
  convenience.
- **How it resolved**: the first of the two routes this entry named, not the second (DEC-141).
  `GET /v1/profiles/:profileId/capabilities` answers with `kynviora.has_capability` over
  `CAREGIVER_CAPABILITIES`, and `capabilities.ts` maps that vocabulary onto the agent's with a
  lookup that has no default. The second option - threading the shelf's and the item detail's
  answers into the dispatch context - is smaller and was rejected: it makes what voice may offer
  depend on which tabs somebody happened to open, which is the defect `PendingSenders` was moved off
  the screens to avoid (`DEV-044`), and it still leaves `MANAGE_PERSONAL_CARE` answerable only by
  opening a personal-care item.
- **The audit, since this entry asked for one.** Every difference between what a caregiver may do
  and what voice offers, and what each one now is:

  | Tool capability        | Grant capability   | Touch                   | Voice, before | Voice, now |
  | ---------------------- | ------------------ | ----------------------- | ------------- | ---------- |
  | `VIEW_MEDICINES`       | `VIEW_MEDICINES`   | shelf rows, under RLS   | offered       | offered    |
  | `VIEW_PERSONAL_CARE`   | `VIEW_SHELF`       | shelf rows, under RLS   | offered       | offered    |
  | `VIEW_ALERTS`          | `VIEW_SAFETY`      | safety lines, under RLS | offered       | offered    |
  | `RECORD_DOSES`         | `RECORD_DOSES`     | `mayRecordDoses`        | **withheld**  | offered    |
  | `MANAGE_MEDICINES`     | `MANAGE_MEDICINES` | `mayEdit` on a medicine | **withheld**  | offered    |
  | `MANAGE_PERSONAL_CARE` | `MANAGE_SHELF`     | `mayEdit` on a product  | **withheld**  | offered    |
  | `OWNER_ONLY`           | none               | owner only              | owner only    | owner only |

  What remains narrower by voice is **not** about capabilities and is in the registry rather than in
  this mapping, and each has a reason that is about voice: `14` requires a fresh **typed** identity
  for the Visit Pack, the data export, caregiver administration and closing an account, and nothing
  in this build can re-authenticate by voice; `delete_item` removes a health record on a misheard
  word; `record_consent` records that somebody read a specific versioned text, and a voice interface
  cannot show anybody a text. All are `TOUCH_ONLY`, enforced twice - the agent is never told they
  exist, and the dispatcher refuses one that arrives anyway - and all are still listed, so the agent
  can say **where the control is** rather than that the capability does not exist.

- **Status**: **RESOLVED 2026-09-07** (DEC-141).

---

## DEV-075 - Voice Mode did not scroll, and a device run found it on its first day (resolved)

- **Affected specification**: `18` (a control below the fold with no way to reach it is a control
  nobody can use), `19`, `DEV-046`.
- **Expected behaviour**: a conversation grows and the field and the two buttons stay reachable.
- **Implemented behaviour**: by the third exchange the transcript had pushed the field and both
  buttons past the bottom of the screen with nothing able to bring them into view.
- **Reason**: Voice Mode is drawn **instead of** the navigator (`VoiceHost`), so unlike every other
  screen in this app it was not inside a container the navigator had already given a height. Its
  `ScrollView` therefore sized itself to its content, which grows with the transcript, and stopped
  being a scroll view at all.
- **How it resolved**: `flex: 1` on the ScrollView and a flex container in `VoiceHost` where the
  navigator would have been. `verify:device:voice` is the check that found it and the check that
  keeps it fixed: two of its exchanges are unreachable without a scroll.
- **What this is a repeat of**: `DEV-046`, exactly - a form three taps in whose controls were drawn
  below the fold on a build reporting 34/34. That one was found by adding sheets to the
  accessibility survey; this one by writing the device scenario for a new surface **before**
  claiming the surface worked.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-076 - Two headings said "Today", and removing one left the first line under the status bar (resolved)

- **Affected specification**: `18` (one heading per screen, announced as a header), `06`.
- **Implemented behaviour**: the tab navigator drew a header carrying the destination's name, and
  every destination then drew its own heading through `Screen` - so a screen reader navigating by
  headings heard "Today" twice, and ninety pixels of a screen whose audience reads it at twice the
  font size went to a duplicate.
- **How it resolved**: `headerShown: false`. Three consequences had to be handled, and the second
  was found by looking at the screen rather than by a test:
  1. **Care had no heading of its own** - it is the one destination that does not use `Screen` -
     so it gained one, which `18` had been going unmet on for that screen.
  2. **The top inset had been reserved by the header.** Without it the first line of every screen
     was drawn under the status bar. `Screen`, Care and Voice Mode take `edges={['top','bottom']}`
     now; the inset belongs to whatever is outermost and that is no longer the navigator.
  3. **The tab bar was white in both themes**, because the navigator paints its own and does not
     know about the theme - a strip of daylight under a dark screen. It takes the theme's surface
     and hairline now, and the chosen destination carries `selection` rather than `informational`,
     which is the colour a fact about somebody's medicine is drawn in.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-077 - The dark theme was unreachable from the default appearance setting (resolved)

- **Affected specification**: `18` (appearance is an accessibility setting, not decoration), `01`
  (older adults are the primary audience), DEC-101, DEC-130, DEC-137.
- **Expected behaviour**: `FOLLOW_SYSTEM` is the default appearance choice, so a phone in dark mode
  draws the app in the dark theme.
- **Implemented behaviour**: it drew the light theme. `useColorScheme()` returned `'light'`
  regardless of what the phone was set to, so `FOLLOW_SYSTEM` could only ever resolve to `LIGHT`.
  The dark theme was reachable only by going to You, then Accessibility, and choosing `DARK`.
- **Reason**: `apps/mobile/app.json` carried `"userInterfaceStyle": "light"` from DEC-101, written
  when there was no `DARK_THEME` at all. That is not inert configuration: `expo-system-ui`'s config
  plugin writes it into `res/values/strings.xml`, and its activity lifecycle listener calls
  `AppCompatDelegate.setDefaultNightMode(MODE_NIGHT_NO)` on every activity create - which forces the
  `Configuration.uiMode` that `useColorScheme()` reads.
- **How it was found**: by reading `app.json` while checking what a rebuild would regenerate for the
  haptics work, not by a test. Nothing in this repository could have caught it: the theme resolution
  is unit-tested and correct, the tokens are contrast-tested and correct, and the one thing that was
  wrong lived in a platform configuration file three layers below either.
- **How it resolved**: `"userInterfaceStyle": "automatic"` (DEC-137), which the same plugin maps to
  `MODE_NIGHT_FOLLOW_SYSTEM`.
- **What it says about the coverage**: the whole design system was asserted in Node and none of it
  was asserted against a phone whose system theme had been moved. That gap is now closed by a device
  check rather than by a test - `verify:device:a11y` reads both destinations under a system dark
  mode, and the run that found this fixed is the evidence.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-078 - A dose refused by the server was reported to a voice user as "no connection" (resolved)

- **Affected specification**: `12` (a queued change is visible rather than assumed; error handling
  classes are distinct), `13` (clients branch on codes, never on message text), `18` (a refusal says
  what to do next), DEC-134, DEC-140.
- **Expected behaviour**: a dose the server answered and declined is reported as a refusal.
- **Implemented behaviour**: every non-success outcome from `recordDoseEvent` produced
  `UTTERANCES.offline` - "this phone has no connection at the moment". So a caregiver whose grant had
  been revoked, a session that had expired, and a genuinely offline phone were all told the same
  thing, and two of the three were told to try again later when a retry would be refused identically.
- **Reason**: the executor's `record_dose` had two branches - `OK` and everything else - and the
  everything-else branch was written when nothing could be queued, so "the server did not take it"
  and "no server was reached" had not yet had to be different sentences.
- **How it was found**: while wiring `DEV-071`. Adding the queue forced the question of _which_
  failures may be queued, and the answer - only `OFFLINE`, because a refusal replayed by a journal is
  refused again - showed that the existing single branch was answering two questions with one
  sentence.
- **How it resolved**: more than two answers (DEC-140), and a total function over the rest
  (DEC-144). `OFFLINE` queues and says so, and is excluded from the failure mapping because it is
  not a failure of this kind. `utteranceForWriteFailure` then maps `STEP_UP_REQUIRED` to
  `needsIdentity`, which points at the screen where a password can be typed; `UNAVAILABLE` to
  `notAvailable`, because it is a `404` and `13` makes absence and refused access indistinguishable
  on purpose, so saying "you do not have access" out loud would disclose by ear what the response
  body was written not to say; and `UNAUTHENTICATED`, `AUTHORIZATION_LOST`, `REFUSED` and
  `SERVER_ERROR` to `didNotGoThrough`, which reports that nothing was kept. `notAllowed` is
  deliberately not on this path at all - it stays for the dispatcher's own capability gate, where
  this app's own report says the caller does not hold the capability. None of them invents a
  reason.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-079 - The accessibility survey reported a reachable control as unreachable (resolved)

- **Affected specification**: `18` (a control below the fold with no way to reach it is a control
  nobody can use), `19` (a check that could not look is not a finding), DEC-102, DEC-145.
- **Expected behaviour**: `SHEET-2/Add a medicine@2` passes, because "Save" can be scrolled to.
- **Implemented behaviour**: it failed - "1 control(s) were never fully on screen at any scroll
  position: ["Save"]".
- **What was actually true**: driving the same sheet by hand put `Save` at y1633 and `Cancel` at
  y1863, with the tab bar starting at y2209. Four hundred pixels of clearance. The control was
  reachable and the survey said it was not.
- **Reason**: `surveySheet` ends when a dump is identical to the previous one, on the reasoning
  that a screen that did not change has stopped moving. `SCROLL_ANCHOR_Y` is a fixed 1900, and at
  font scale 2 the manual-entry form is almost entirely `TextInput`s drawn tall - so the drag began
  inside an `EditText`, which took it as text selection and passed nothing to the list. The swipe
  happened, nothing moved, the dump matched, and the survey stopped three fields from the bottom.
- **How it was found**: by not believing the FAIL. The first reading was that a redesign had cost
  something, and the second was that the tab bar was covering the button. Both were wrong, and
  measuring the actual bounds took two minutes - which is the whole lesson here. A red result is
  evidence about the **measurement and the product together**, and this project has an entry
  (`DEV-046`) about exactly the same mistake in the other direction.
- **How it resolved**: DEC-145. An unchanged dump now triggers one retry from an anchor no text
  field occupies (`dragAnchorAvoidingFields`), and only a dump unchanged after **that** ends the
  survey. Five tests in `accessibility.test.ts`, so the judgement runs in `npm run verify` with
  nothing attached.
- **What it says about the coverage**: the harness had a fixed drag anchor and no way to notice
  when a drag was consumed rather than applied. The same anchor is used by `scrollDown` everywhere,
  so any other long form of text fields could have produced the same false FAIL - and none had,
  because until this session no sheet survey had ever met a form that tall at 2x.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-080 - A survey at font scale 2 measured a screen that had not drawn yet (resolved)

- **Affected specification**: `19` (a check that could not look is not a finding), DEC-102, DEC-145.
- **Expected behaviour**: the first sheet surveyed after a font-scale change is surveyed against
  the app.
- **Implemented behaviour**: `SHEET-1/Invite someone@2` reported `INCONCLUSIVE` - "the taps that
  open this sheet did not land" - against an app that was still starting.
- **Reason**: `relaunch()` force-stopped the app, started it, and `sleep(30_000)`. Thirty seconds
  is not a property of anything. Measured on the emulator this session, a cold start at font scale
  2 took **longer than that**: sixteen seconds gave a hierarchy containing nothing but frame
  layouts, and content appeared somewhere before forty. The function's own comment had named the
  failure in advance - "a dump taken too early reports a screen with no controls - which the checks
  correctly refuse to call a pass, and which is a wasted run" - and then slept for a fixed time
  anyway.
- **How it resolved**: `waitForAppReady()`, which already existed in `ui.ts` for exactly this and
  whose own comment says it "replaces a fixed sleep". It waits on the tab bar, bounded at ninety
  seconds, and `relaunch` now answers whether the app drew. `surveySheet` reports a false as a
  sheet it could not open; `main` reports it as a scale it could not measure, rather than surveying
  a blank screen and calling the missing controls accessibility defects.
- **A second benefit that is not incidental**: it is faster. A full survey makes a dozen
  relaunches, so a fixed thirty seconds is six minutes of a run spent waiting for something that
  had already happened - and a survey nobody re-runs after a fix is a survey whose red results stop
  being acted on, which is what `DEV-079` is about.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-081 - The Speech Gate would say anything named after a property of `Object.prototype` (resolved)

- **Affected specification**: `17` (a model completion is untrusted input that may carry
  instructions; the agent never establishes a fact), `15`, `18` (forbidden claims), DEC-135,
  DEC-144.
- **Expected behaviour**: every word Kynviora speaks either came out of a tool result or is one of
  about fifteen sentences written in this repository. `docs/design/VOICE_MODE.md` section 6 states
  it as an absolute: "there is no path, including a jailbroken or prompt-injected one, by which a
  sentence about somebody's medicine reaches their ears without having been composed here."
- **Implemented behaviour**: `gateSpeech` resolved an utterance key by indexing `UTTERANCES` and
  refused only when the result was `undefined`. **`Object.freeze` does not remove a prototype**, so
  `UTTERANCES['toString']` is `Object.prototype.toString` rather than `undefined` - and
  `pieces.join(' ')` stringifies it. Measured:

  ```
  toString    => function toString() { [native code] }
  constructor => function Object() { [native code] }
  __proto__   => [object Object]
  nope        => UNDEFINED (refused)
  ```

  `findForbiddenClaims` does not match any of it, so the gate returned `ok: true`.

- **Why it was reachable rather than theoretical**: the key is not this repository's to choose. An
  agent turn of kind `SAY` carries `utterance` as a **raw string off a model completion**
  (`ports.ts`), and `VoiceProvider` cast it with `as keyof typeof UTTERANCES` - a cast changes the
  type and checks nothing. A model returning `{ kind: 'SAY', utterance: 'toString' }` had
  `"function toString() { [native code] }"` spoken by the synthesizer and written into the
  transcript.
- **What it could and could not do**: bounded. A model picks from roughly a dozen prototype names,
  not arbitrary prose, and none of the strings says anything about a medicine. What it broke is the
  property itself, which is the thing that made the rest of the design defensible - a gate with one
  hole is a gate whose other claims have to be re-argued.
- **How it was found**: not by a test and not by a device. A review of the session's diff asked
  whether the new `utterances` channel could smuggle text, found that it could not, and then asked
  the same question of the **existing** resolution path.
- **How it resolved**: `utteranceFor` resolves through `Object.hasOwn` and requires the value to be
  a string; `isUtteranceKey` is exported so the one place a model supplies a key narrows it instead
  of casting; an unrecognised key is reported as something Kynviora did not understand, which is
  true and is not the person's mistake. Four tests loop the inherited names, one asserts no
  assembled sentence can contain `native code`, and a positive control asserts every real key still
  passes - because a gate that refused everything would satisfy the first three.
- **The same shape, found and closed with it**: `FROM_GRANT` in
  `apps/mobile/src/voice/capabilities.ts` was an object literal indexed with names from a server
  response, so `FROM_GRANT['constructor']` was a function rather than `undefined`. Inert - none of
  those values is a `ToolCapability`, and `holdsCapability` only ever asks for a real one - but it
  made the file's "an unknown name contributes nothing" false. It is a `Map` now.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-082 - The capability report answered for a profile its caller could no longer see (resolved)

- **Affected specification**: `13` (absence and refused access are deliberately indistinguishable),
  `15` A2, DEC-141.
- **Expected behaviour**: `GET /v1/profiles/:id/capabilities` tells a caller nothing they could not
  learn from any other route on the surface.
- **Implemented behaviour**: for a **deleted** profile it told a caregiver more.
- **Reason**: `kynviora.has_capability` short-circuits on ownership through `owns_profile`, which
  filters `deleted_at IS NULL` - but its caregiver-grant branch does not, and migration `0025`
  soft-deletes a profile **without revoking the grants hanging off it** (they are purged later,
  past `purge_floor()`). So a caregiver's grant outlives the profile's visibility by the length of
  the retention window. Measured directly: after `kynviora.delete_profile`, the caregiver's own
  connection reports `has_capability = true` and `SELECT count(*) FROM profile WHERE id = $1` = 0.
- **What that disclosed**: a caller who compared this route's answer with any other would
  distinguish "the owner deleted this profile" from "your access was revoked" - the second answers
  with an empty list, the first did not. Nothing else on this surface makes that distinction, and
  `13` makes it deliberately unavailable. The owner of the same deleted profile got an empty list,
  so the asymmetry was caregiver-only.
- **How it was found**: a review of the session's diff, checking the route's own claim that it
  "discloses nothing" rather than accepting it.
- **How it resolved**: the query gained `WHERE EXISTS (SELECT 1 FROM profile WHERE id = $1)`,
  evaluated on the caller's own connection so `profile_select` is what decides - the same policy
  every other read on the profile goes through, rather than a second condition here that could
  drift from it. In the same statement rather than a second one, because two statements are two
  moments and a profile deleted between them would still be reported on. Three tests, including
  that an owner and a stranger now get identical answers.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-083 - One profile's capabilities could be applied to another (resolved)

- **Affected specification**: `13` (a profile ID narrows a result set and never grants access),
  `14` (deny by default), DEC-141.
- **Expected behaviour**: the capabilities Voice Mode reads are the ones the server reported **for
  the profile being looked at**.
- **Implemented behaviour**: `granted` was `capabilityResource.value?.capabilities`, and
  `useResource` keeps its last successful value when a later read fails - deliberately, because
  `18` would rather show content labelled stale than take it away. Right for a medicine list;
  wrong for an authorization report.
- **The failure**: a caregiver holds `MANAGE_MEDICINES` on one profile and only `VIEW_MEDICINES` on
  another. Voice Mode open on the first; switch person with no signal; the refetch answers
  `OFFLINE`; the resource goes `STALE` holding the first profile's list. The agent then offers
  `add_medicine`, `update_item` and `create_schedule` on the second profile until a read succeeds -
  which is a person completing a spoken form for nothing, the exact failure DEC-141 exists to
  prevent, arriving from the other side of it.
- **How it was found**: a review of the session's diff. No test covered a profile change; every
  test in `VoiceProvider.test.tsx` uses one profile.
- **How it resolved**: the answer carries the profile it was asked about, and a mismatch reads as
  no answer - which narrows to the empty set, which is a person told to use the screen. `13`'s rule
  that a profile ID narrows rather than grants, applied to the report as well as to the request.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-084 - Six tools the agent is offered and the executor cannot run

- **Affected specification**: `17`, `docs/design/VOICE_MODE.md` sections 3 and 8, DEC-136.
- **Expected behaviour**: "the agent's reach is the app's reach". The registry is the list a
  provider is handed - `voiceCallableTools()` - so a tool in it that is not `blockedBy` anything
  is a capability Voice Mode is claiming.
- **Implemented behaviour**: `createToolExecutor` defines **15 of the 30** tools. Seven of the
  fifteen absences are correct (`TOUCH_ONLY`, refused at gate 2 before any executor is consulted)
  and two are correct (`read_extracted_fields` and `confirm_extracted_item`, refused on
  `BLK-007`). The remaining **six are offered, unblocked and unrunnable**:

  | Tool                    | The client method that already exists |
  | ----------------------- | ------------------------------------- |
  | `list_safety_state`     | `profileAlerts` / `safetyInbox`       |
  | `describe_alert`        | `alertDetail`                         |
  | `list_caregiver_access` | `listCaregiverGrants`                 |
  | `update_item`           | `updateItem`                          |
  | `update_schedule`       | `updateSchedule`                      |
  | `list_pending_changes`  | the local journal, not the client     |

- **The failure**: `dispatch` reaches its last step, finds no executor, and returns `BLOCKED` with
  **no blocker identifier** - so the agent says "that part of Kynviora is not finished yet" for a
  capability the registry and the design document both present as working. `list_safety_state` is
  the one that matters: "is there anything I should know about my medicines" is a journey Voice
  Mode exists for, and it is answered with a refusal that names nothing.
- **How it was found**: diffing `TOOL_NAMES` against the keys of `createToolExecutor`. Nothing had
  ever compared the two - `everyToolNameIsDefined()` asserts the registry is complete against
  itself, and no test looked at the executor at all.
- **Risk**: low and in the safe direction. It is a refusal, never a wrong action; nothing is
  written, nothing is spoken that did not pass the Speech Gate, and no capability is exceeded.
  What it costs is a person being told a thing does not work when the app can do it by touch.
- **Temporary or permanent**: temporary. It is not a capability gap - every client method exists -
  so the work is wiring, a summary sentence for the two writes, and a decision about whether
  `update_item` and `update_schedule` queue or stay `ONLINE_ONLY` (the registry currently says
  `queues` for `update_schedule` and `online` for `update_item`).
- **Required future work**: wire the four reads first, which need no confirmation and no offline
  decision, then the two writes with device verification through `verify:device:voice`.
- **Interim**: `apps/mobile/src/voice/executor.test.ts` asserts the two lists agree, with these six
  named as a known gap. It fails the day a seventh appears, and it fails if one of the six is
  wired without being taken off the list - so the allowlist cannot quietly become a list of things
  that used to be broken.
- **How it resolved**: all six are wired, and `KNOWN_UNWIRED` in that test is now empty. The four
  reads go through the same view functions their screens use, so every spoken line is still
  composed by the presentation layer and still passes the Speech Gate. Two things needed deciding
  rather than typing:

  **`update_schedule` gained an `itemId`.** `ScheduleChangeBody` is whole-document and conditional
  on `expectedVersion`, and no client method reads one schedule by its own ID - so the row has to
  be found through `schedules(itemId)`. The agent has it already: a `scheduleId` can only have come
  from `list_schedules`, which takes an `itemId`.

  **`create_schedule` and `update_schedule` are `ONLINE_ONLY` now**, and both said `QUEUES`. Only
  `record_dose` reaches the journal (DEC-140), and a change conditional on a version is not
  something a replay can carry unchanged anyway. Declaring `QUEUES` meant gate 5 let them through
  with no connection so the write could fail and be reported - honest since `DEV-085`, but a round
  trip to say what the gate already knew. The registry now describes the build.

- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-085 - A write that never happened was spoken as "Done."

- **Affected specification**: `18` (a person is told what actually happened), `12` (a queued change
  is visible rather than assumed), `13`, `docs/design/VOICE_MODE.md` section 8, DEC-140.
- **Expected behaviour**: the report says what happened. `queued` where the phone kept it, a
  refusal where it did not, and "Done." only where the write actually landed.
- **Implemented behaviour**: `VoiceProvider.run` speaks `done` when a tool returns no sentences at
  all -

  ```ts
  speak(parts.length === 0 ? [{ kind: 'UTTERANCE', key: 'done' }] : parts, lines);
  ```

  which is right for a tool that succeeded quietly. Three of the four writes -
  `create_schedule`, `add_medicine` and `add_personal_care_item` - returned `{ spoken: [] }` for
  **every** non-OK outcome: offline, refused, unavailable, server error, session lost, step-up
  required. So each of those was spoken as **"Done."**

- **The failure**: "set a reminder for my tablet at eight o'clock" with no signal. Gate 5 does not
  refuse it - the registry declares `create_schedule` as `QUEUES`, so being offline is not a
  reason to stop - the request fails, nothing is queued, nothing is created, and Kynviora says
  "Done." The person stops thinking about it. There is no later moment at which they find out, and
  what is missing is a medication reminder.

  This is the exact failure `OFF-6` measures on hardware for the dose sheet - "Recorded." versus
  the offline note, where the shorter sentence is the one that stops somebody recording it again -
  arriving on a different surface.

- **Why the harnesses did not catch it**: `record_dose` was the only write wired correctly, and it
  is the one the device scenarios drive. `utteranceForWriteFailure` already existed in the same
  file and had exactly one caller.
- **How it was found**: reading the executor against `run` while auditing Voice Mode for places
  where it reports success before the authoritative operation succeeded.
- **How it resolved**: all three now answer with `utteranceForWriteFailure` for a failure and
  `offline` for no connection. `offline` rather than `queued`, because **nothing queues a schedule
  by voice**: "This phone has no connection at the moment, so I cannot ask the server about that"
  promises nothing, and `queued` would promise something no journal is holding.
- **What this does not close**: the registry still declares `create_schedule` and `update_schedule`
  as `QUEUES` while only `record_dose` reaches the journal. The touch path does queue schedules
  (`OFF-1` to `OFF-5` measure it), so the mechanism exists and voice does not use it. Wiring it is
  the work; until then the person is told honestly that it did not happen rather than being told
  it did.
- **Risk before the fix**: high for `create_schedule` and low for the two creates, which are
  `ONLINE_ONLY` and therefore refused by gate 5 when the app knows it is offline - they were
  reachable only when a request failed for another reason, or when the network dropped between the
  gate and the send.
- **Tests**: 22 assertions in `apps/mobile/src/voice/executor.test.ts`, run against the old code
  first and failing there - three tools by seven failure kinds, plus that offline is reported as no
  connection rather than as kept, plus a positive control that a successful write still says
  nothing so `run` still says "Done."
- **Status**: **RESOLVED 2026-09-07**. The `QUEUES` mismatch is carried under `DEV-084`.

---

## DEV-086 - A migrated form padded twice, and a survey that stopped before the end of it

- **Affected specification**: `18` (system font scaling supported without clipping a critical
  action; 48dp minimum), `docs/design/DESIGN_SYSTEM.md` section 4, `DEV-046`, `DEV-079`, DEC-102.
- **Expected behaviour**: every control on the invitation form can be brought fully into view at
  font scale 2, and the survey that says so has seen the whole form.
- **Implemented behaviour**: `SHEET-2/Invite someone@2` reported **two** controls - "Medicines" and
  "Missed dose alerts" - as never fully on screen at any scroll position. It reproduced on every
  run, narrowed or full.

- **Two causes, and only one of them was the product's.**

  **The product's.** The migrated screen put the capability rows inside a `Card`, which applies
  `padding: SPACING.lg` of its own, and kept `paddingHorizontal: SPACING.lg` and
  `paddingVertical: SPACING.md` on each row. Every row was therefore padded twice. At font scale 2,
  where each row is already two lines of scaled text, that was enough that the survey never caught
  the first and last rows wholly inside the viewport. Reduced to `sm`/`md`, which is what the
  pre-migration screen used; the 48dp floor is `minHeight` and is untouched.

  **The harness's.** `MAX_SURVEY_STEPS` was 12 and the survey reported 13 positions - it had
  exited on the loop bound, not on the sheet having stopped moving, so it had **never seen the
  bottom of the form**. With the budget raised it takes 20 positions and finds **13 controls where
  it used to find 10**: three of the form's controls had never been surveyed at all, and one of
  them was being reported as unreachable.

- **How it was found**: the full survey, on the design migration made in the same session. The
  regression was confirmed by checking out the pre-migration file and re-running the same narrowed
  survey, which passed 4/4 - so the failure was this session's and not pre-existing.
- **How it resolved**: both. Neither alone was sufficient - the padding fix took it from two
  unreachable controls to one, and the scroll budget took it to none.
- **What it changed structurally, and this is the durable part**: `SHEET-2` can no longer report a
  false FAIL of this shape. `SheetSurvey.reachedEnd` records whether the survey ended because the
  sheet stopped moving or because it ran out of steps, and an unreachable control found by a survey
  that never reached the end is now `INCONCLUSIVE` rather than `FAIL` - because "never fully on
  screen" and "further down than we looked" are the same reading, and choosing between them is
  precisely what the harness cannot do (DEC-102). An inconclusive check still fails the run, so it
  is not a quiet pass; it says the survey needs more steps rather than blaming a screen.
- **Risk**: the padding was a real defect at 2x and a real one for `18`'s audience. The harness half
  was a false FAIL, which is the more expensive kind - `DEV-079` cost a session, and an intermittent
  red result is what teaches people to ignore red results.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-087 - A field the server omitted came back `undefined` from a type that says `null`

- **Affected specification**: `11` (safety composition is server-side; a client must not rebuild
  it), `13`, `18`.
- **Expected behaviour**: `alertDetailScreenView` returns what its type declares.
- **Implemented behaviour**: four of its fields - `withdrawnNotice`, `message`, `unexplainable`
  and `withheldNotice` - are declared `| null` and were **passed straight through** from the
  response. A response that omits one therefore yielded `undefined` from a function whose type
  says it cannot.
- **The failure**: every consumer written against the declared type tests `=== null`.
  `AlertDetail.tsx:112` does exactly that and then reads `.heading`, so an omitted `unexplainable`
  is a **crash on the alert screen** rather than an absent block. The Voice Mode `describe_alert`
  tool wired in the same session had the identical guard and the identical exposure.
- **How it was found**: writing the `describe_alert` executor test. The fixture omitted fields a
  real response carries, which is exactly what an older or newer server does.
- **Reachable today**: no. `BLK-006` means nothing is publishable, so there is no alert to open.
  That is a reason to fix it now rather than to leave it - the first real publication is a bad
  moment to find out.
- **How it resolved**: `?? null` at the boundary, so the declared type is true for every reader.
  The alternative is each consumer remembering that these four are really `| null | undefined`,
  which is the kind of thing one of them will forget.
- **The general shape**: the same class as DEC-147 - a value that crossed a trust boundary wearing
  a type that was decided locally. `?? null` is the narrowing equivalent of `ownEntry`: it makes
  the declaration true rather than asking every caller to distrust it.
- **Tests**: three in `packages/contracts/src/views.test.ts`, run against the old code first and
  failing there - including one written in the exact shape of `AlertDetail.tsx`'s guard.
- **Status**: **RESOLVED 2026-09-07**.

---

## DEV-088 - The warning behind the LogBox banner was Expo's dev client, not Kynviora

- **Affected specification**: none. This is a finding about the harness environment.
- **Background**: `DEV-086` established that the intermittent `SHEET-3`/`SHEET-4` failure was
  React Native's LogBox notification, and that LogBox only appears once something has logged a
  warning. Nobody had read the warning: the logcat buffer had rolled over by the time it was
  looked for, and it does not fire at launch.
- **What it is**, reproduced on 2026-09-07 by killing Metro while the app was running and driving
  the tabs:

  ```
  W/ReactNativeJS: Cannot connect to Expo CLI.
  W/ReactNativeJS: URL: 10.0.2.2:8081
  ```

  Expo's **dev client** reporting that it has lost the dev server. Not Kynviora code, and not a
  defect in the app.

- **What was ruled out first**, each by measurement rather than by argument: a full sheet survey at
  font scale 2 with the stack healthy produces **no** JS warning and no banner (20/20 PASS, zero
  `ReactNativeJS` warnings in a captured logcat); visiting all five destinations produces none;
  opening Voice Mode produces none; and making the **API** unreachable by removing its `adb
reverse` tunnel produces none either - the app has offline states and uses them. Only the dev
  server dying produced it.
- **Why it cannot ship**: `expo-dev-client` is not in `apps/mobile/package.json`'s dependencies,
  and LogBox is compiled out when `__DEV__` is false. There is no release build in which this
  banner or this warning exists.
- **What this explains**: the run that first showed the banner was measuring an app whose dev
  server had died underneath it - which is what was found afterwards, along with a dead API and a
  hung emulator. It is also why it never reproduced: every narrowed re-run was made on a healthy
  stack.
- **What was done about it**: nothing in the app, because there is nothing in the app to fix, and
  suppressing a dev-tooling warning would remove the one visible signal that a run was degraded.
  `SHEET-1` and `A11Y-1` now name this as the usual cause when they report the overlay, so the
  next person reading a survey with the banner in it knows to check the dev server before
  believing anything else in the report.
- **Status**: **RESOLVED 2026-09-07** - identified, and correctly not fixed in the app.

---

## DEV-089 - A schedule change was kept if it was typed and lost if it was spoken

- **Affected specification**: `12` ("Repository behavior" - a pending-operation journal; a queued
  change is visible rather than assumed), `13` (per-entity conflict policy; the operation ID is the
  idempotency key), `03` group J ("pending user edits with deterministic sync handling"), `14`
  (which capabilities are deliberately touch-only), `docs/design/VOICE_MODE.md` section 3,
  DEC-111, DEC-132, DEC-140.
- **Expected behaviour**: "the agent's reach is the app's reach" (DEC-132). Where touch queues a
  change with no signal, voice queues the same change, into the same journal, under the same key
  and the same precondition. `14` names the capabilities voice is deliberately narrower on -
  the Visit Pack, the export, caregiver administration, closing an account, deleting an item,
  recording consent - and a medicine schedule is in none of those groups.
- **Implemented behaviour**: `create_schedule` and `update_schedule` were `ONLINE_ONLY`. Gate 5
  refused both with no connection, so the person heard "This phone has no connection at the moment"
  and nothing was kept - while the identical change made on the schedule sheet, on the same phone,
  in the same second, went into the journal and was sent on the next drain.

- **The failure**: "set a reminder for my tablet at eight o'clock" in a kitchen with no signal.
  Refused, honestly, and gone. The person has to remember to do it again, and a medication reminder
  is the thing they were asking for because they do not want to have to remember.

  It is `DEV-085`'s failure one step further back. That one was a schedule reported as created when
  nothing was created; this is a schedule the app could have kept and declined to.

- **Why it was not simply wired**: because the honest value in the registry was the _right_ answer
  for the build as it stood, and the reason it stood that way was a real unresolved question rather
  than a missing line. `record_dose` queues because `13` resolves `dose_event` `MERGE_BY_ID` and an
  idempotency key makes a replay land once. A schedule **update** is conditional on
  `expectedVersion`, and a replay minted while the row was at version 3 must not silently win
  against a row that has since moved to 4. `DEV-084` recorded that as the remaining work and
  declaring `ONLINE_ONLY` made the gap visible rather than closing it.

- **How it was found**: the operating brief named it. `DEV-084` and STATUS had both recorded it as
  the immediate next task.

- **How it resolved**: DEC-148. A create queues under the key the attempt spent; an update queues
  **only where a version was actually read**, conditional on that version. The journal, the entity
  types, the entity IDs, the senders and the drain are the ones the shelf already uses - there is
  no voice-specific sync path and no second mechanism.

  The condition is the substance. Schedules are not in the local projection, so with no connection
  the read that would supply `expectedVersion` fails too, and the two ways to send an update
  without one are both refused by `13`: unconditionally, which is a silent overwrite of a row that
  may have moved, or with a guess, which is the same overwrite with a lottery in front of it. So a
  failed read queues nothing and promises nothing.

- **Risk before the fix**: moderate and in the safe direction - a refusal rather than a wrong
  action, and honest since `DEV-085`. What it cost is a reminder somebody set and did not get.

- **Tests**: 11 in `apps/mobile/src/voice/executor.test.ts` and 5 in
  `apps/mobile/src/voice/VoiceProvider.test.tsx`, and each is about something wiring alone gets
  wrong rather than about the wiring: that the create keeps the key the request carried rather than
  a fresh one (asserted as an identity against the key the client was given, because a fresh UUID
  on the queue side passes every other reading of "it queued"); that the queued body is the body
  that was sent rather than a second reading of the arguments; that the update carries the version
  the read returned; that a failed read queues nothing and never attempts the write; that a server
  that answered and declined is never queued and never spoken as a transport problem; and that a
  journal which refused the write produces the sentence that promises nothing.

  Four in `services/api/src/schedule.test.ts` for what a replay meets at the route: a revoked
  caregiver's create and change both refused as absence with the stored times unchanged, a stale
  precondition answered `VERSION_CONFLICT` with the version that now stands and the server's own
  times still in place, and a revoked caregiver replaying a create made under a key minted while
  the grant stood refused **without** the stored row coming back wearing a replay header - which
  is what a route that looked the key up before checking authorization would return.

- **What this does not close**: `DEV-092`. A conflicted queued change is now reachable by two
  surfaces rather than one, and what the Pending Changes screen offers for one is a control that
  cannot succeed.
- **Status**: **RESOLVED 2026-09-08**.

---

## DEV-090 - A question Kynviora could not answer was answered "Done."

- **Affected specification**: `18` (a person is told what actually happened; the audience `01`
  names first is not looking at the screen), `12` (offline is a state, not a silence), `13`,
  `docs/design/VOICE_MODE.md` section 8, DEC-144.
- **Expected behaviour**: a read that could not be answered says so. "Done." means an action
  completed and belongs to a write that succeeded quietly.
- **Implemented behaviour**: `VoiceProvider.run` speaks `done` when a tool answers with nothing on
  either channel -

  ```ts
  speak(parts.length === 0 ? [{ kind: 'UTTERANCE', key: 'done' }] : parts, lines);
  ```

  and **every one of the eleven read executors** answered `{ spoken: [] }` for every non-OK
  outcome. Several also answered `{ spoken: [] }` for a successful read of an empty list.

- **The failure**: "what medicines am I taking" in a room with no signal. Kynviora says **"Done."**
  The same word answers a 404, a lost session, a server error, and an empty shelf on a new account.

  A person looking at the screen sees the shelf and can work it out. The audience Voice Mode exists
  for is the one that is not looking, and what they hear is a word meaning an action completed in
  reply to a question about their medicines - with no later moment at which they find out nothing
  was read.

- **Why it survived `DEV-085`**: that fix was scoped to the writes and named them - `create_schedule`,
  `add_medicine`, `add_personal_care_item` - because a write reporting success it did not have is
  the obviously dangerous shape. A failed read looks harmless from the executor's side: nothing was
  written, so nothing was lost. What is lost is the question, and that is only visible from the
  shell. Neither file was wrong on its own; the defect was in the seam, which is why the
  regression test for it runs both.
- **How it was found**: reading `run` against the executor while auditing the registry's `offline`
  declarations (`DEV-091`). The two are the same investigation - `LOCAL_PROJECTION` is what let a
  read be attempted with no connection in the first place.
- **How it resolved**: `utteranceForReadFailure`, a total function over the failure kinds, and
  `readResult`, which names the empty case. Two utterances were added to the closed set:
  `couldNotRead` ("I could not read that just now, so there is nothing I can tell you") and
  `nothingRecorded` ("There is nothing recorded there").

  The four kinds with sentences of their own keep them: `offline` for no connection, `notAvailable`
  for a 404 - never `notAllowed`, because `13` makes absence and refused access deliberately
  indistinguishable and naming a refusal asserts the reading the server declined to give
  (DEC-144) - and `needsIdentity` for step-up. `couldNotRead` rather than `didNotGoThrough` for the
  rest, because that sentence's second half is "Kynviora has not kept it", which is a statement
  about a write and says nothing about a question.

  `readResult` filters blank lines with the identical test `run` applies, so the helper and the
  shell cannot disagree about what "nothing" means.

- **Risk before the fix**: moderate. Nothing wrong was written and nothing wrong was spoken about a
  medicine - the Speech Gate saw to that. What was wrong is that a person could not tell an
  unanswered question from an answered one.
- **Tests**: a sweep in `apps/mobile/src/voice/executor.test.ts` over every read the executor
  defines by every failure kind, asserting the condition `run` actually applies rather than a
  sentence - `utterances.length + spoken.length > 0`; an empty-list case for the four list reads;
  and three in `apps/mobile/src/voice/VoiceProvider.test.tsx` that run the shell and the executor
  together, because that is where the defect lived. Each was run against the old code first:
  reverting `list_medicines` alone turns the sweep red with
  `list_medicines on OFFLINE would have been spoken as "Done."`.
- **Status**: **RESOLVED 2026-09-08**.

---

## DEV-091 - Nine tools declared they worked offline through a projection they never touched

- **Affected specification**: `17` ("the agent's reach is the app's reach"), `12` (a read
  projection, and `STALE` is a state a person is shown), `03` group J, DEC-100,
  `docs/design/VOICE_MODE.md` section 3.
- **Expected behaviour**: `offline` is one of the eight answers the registry demands of every tool,
  and `LOCAL_PROJECTION` means "it can be answered from the last thing the server said". A tool
  declaring it must be answerable with no connection.
- **Implemented behaviour**: `list_medicines`, `list_personal_care`, `describe_item`,
  `explain_what_is_missing`, `list_schedules`, `read_dose_history`, `list_safety_state`,
  `describe_alert` and `list_people` all declared `LOCAL_PROJECTION`. **The projection is applied
  by `useResource`**, a hook a screen calls with a `projectionKey`; a tool executes by calling the
  `KynvioraClient` method directly, and the client contains no reference to a projection at all
  (`grep -c projection packages/contracts/src/client.ts` is 0). Only two resources are projected in
  any case - the profile list and the shelf.

- **The failure**: the declaration is load-bearing. `LOCAL_PROJECTION` is what makes gate 5 let a
  call through with no connection, so each of the nine was attempted, failed, and returned nothing
  - which the shell speaks as "Done." (`DEV-090`). The registry over-claimed and the person paid
    for it in a word.
- **How it was found**: the operating brief asked for the offline declarations to be audited
  against actual executor and client behaviour. `executor.test.ts` had compared the registry's
  **list** with the executor's keys since `DEV-084` and nothing had ever compared a field.
- **How it resolved**: the nine are `ONLINE_ONLY`, which is what they are. Gate 5 refuses them with
  no connection and the person hears that the server could not be asked - the same sentence, one
  round trip earlier, and now the registry describes the build.

  Three still declare `LOCAL_PROJECTION` and all three earn it: `open_screen` and `open_item` touch
  nothing, and `list_pending_changes` reads this phone's own journal, which is the whole reason it
  can answer a question about this phone.

- **What this does not close**: reading the shelf **by voice** with no signal. `03` group J's
  offline requirement is met by the shelf screen, which reads the projection and labels it `STALE`
  (DEC-100), and voice has no way to label anything - a spoken sentence carries no staleness badge,
  and reading out medicine names from a cached copy without saying how old it is is a worse failure
  than saying the server could not be asked. Doing it properly needs a sentence in the closed set
  that says when the copy is from, which is a product decision rather than a wiring one.
  Recorded as `DEV-093`.
- **Tests**: `apps/mobile/src/voice/executor.test.ts` drives every `LOCAL_PROJECTION` tool against a
  client where every method answers `OFFLINE` and requires that none of them replies that it has no
  connection; asserts every `ONLINE_ONLY` tool is refused at gate 5 by `checkCall` rather than by an
  executor that happens to cope; and asserts every `QUEUES` tool is let through. Re-declaring
  `list_medicines` as `LOCAL_PROJECTION` turns the first red with
  `list_medicines says LOCAL_PROJECTION and answered that it has no connection`.
  `packages/agent/src/registry.test.ts` pinned the old claim and now pins the list of three plus the
  rule that none of them is a `WRITE`.
- **Status**: **RESOLVED 2026-09-08**.

---

## DEV-092 - A conflicted queued change offers a "Try again" that cannot succeed

- **Affected specification**: `12` ("Repository behavior" - a **resolvable** failure state), `13`
  (`medicine_schedule`, `owned_item`, `allergy_record` and `profile` all resolve `ASK_USER`), `18`,
  DEC-148.
- **Expected behaviour**: `13` resolves these types `ASK_USER`, and the question a person is asked
  has to be one they can answer. `pendingQueue.ts` states the rule itself, about rejections: "a
  'try again' there is a button that produces the same refusal and teaches a person to distrust
  every other one."
- **Implemented behaviour**: `actionsFor('CONFLICTED')` returns `['RETRY', 'DISCARD']`, and
  `PendingSyncProvider.retry` puts the operation back as `PENDING` with the attempt count reset and
  **the payload unchanged** - including the `expectedVersion` the server has just refused.

- **The failure**: every conflict this build can produce is a conditional write. `VERSION_CONFLICT`
  is answered by comparing the stored version against `expectedVersion`, so re-sending the same
  bytes gets the same 409 for ever. Worse than the rejection case the same file guards against:
  retry resets the budget, so there is no attempt cap to end it, and the row sits in "needs you to
  decide" while the only control that looks like a decision does nothing.

  What the copy promises is not what the screen offers, either. "Somebody else changed this after
  you did. Kynviora will not choose between the two, so this one is yours to decide" describes a
  choice between two versions; the person is shown neither and offered neither.

- **How it was found**: reading the resolution path while wiring DEC-148, because a queued schedule
  change is now reachable from two surfaces rather than one.
- **Risk**: low in the safe direction - nothing is overwritten and nothing is merged, which are the
  two failures `13` is protecting against. What it costs is the second half of `12`'s sentence: the
  change is kept and visible and **not** resolvable.
- **How the futile half resolved**: `actionsFor('CONFLICTED')` offers `DISCARD` only, and the copy
  says the two things the person actually needs - that their change was **not saved**, which
  "Kynviora will not choose between the two" left open, and that the way to apply it is to make it
  again against what is there now.

  The rule is stated over the vocabulary rather than over one member: `RETRY` may only be offered
  where the identical request could produce a different answer. That is true of a run of retries
  that gave up, because what stopped it may have gone, and false of both states where the server
  has already read the change and answered about its content.

  **Rebasing was considered and refused.** Re-sending under whatever version now stands applies
  somebody's change on top of content they have not seen - hours later, with nobody watching -
  which is the silent overwrite `13` resolves `medicine_schedule` `ASK_USER` to prevent. A
  precondition only means anything if it names a state somebody actually had.

  The change is not discarded on anybody's behalf either: it stays in the journal, the row stays
  under "needs you to decide", and the badge goes on counting it until the person acts.

- **What is still open, and it is the half worth having**: the person is told to make the change
  again and is shown neither what they asked for nor what the record now says. The full resolution
  is a review - the record as it stands, beside the queued change, and a choice made while looking
  at both - and that is a two-version comparison surface rather than a control on an existing row.
  **It is a good candidate for the Claude Design implementation pass**, because it is the same
  question the `STALE` badge answers on a screen and the one `DEV-093` asks about a spoken sentence:
  how does this app say "what you are looking at is not the current state"?
- **Risk now**: lower than before and in the same direction. Nothing is overwritten, nothing is
  merged, nothing is discarded unasked, and no control claims to do something it cannot. What it
  costs is that re-making the change is done from memory.
- **Tests**: 3 in `packages/presentation/src/pendingQueue.test.ts`, including the rule over the
  whole state vocabulary rather than the two members it happens to catch today.
- **Status**: **PARTIALLY RESOLVED 2026-09-08**. The control that could not work is gone; the
  review that would let somebody keep their change is open.

---

## DEV-093 - Voice cannot read the shelf with no signal, and the shelf can

- **Affected specification**: `03` group J (offline essentials: medicines, schedules, shelf),
  `12` (a read projection; `STALE` is a state a person is shown), DEC-100, `DEV-091`.
- **Expected behaviour**: DEC-132 - the agent's reach is the app's reach.
- **Implemented behaviour**: the shelf screen reads the encrypted projection through `useResource`
  and renders it labelled `STALE`. A tool calls the client, which has no projection, so every voice
  read needs the network. Until `DEV-091` the registry claimed otherwise; it no longer does.
- **Why this is not simply wired**: because `12` does not merely allow a local copy to be read, it
  requires the person to be told it is one. A screen has a badge; a spoken sentence has nothing,
  and reading out a list of medicines from a cached copy without saying when it is from is a worse
  failure than saying the server could not be asked - it is a set of current-sounding facts about
  somebody's medicines.

  So closing this needs a sentence in the Speech Gate's closed set that says how old the copy is,
  and that sentence needs the projection to record when it was written, which it does not. Both are
  product decisions about what an old answer sounds like out loud rather than wiring.

- **Risk**: low. A refusal, and an honest one since `DEV-091`.
- **Status**: **OPEN**. Not blocked on anything external; waiting on a decision about the wording,
  which is a good candidate for the Claude Design pass since it is the same question the `STALE`
  badge answers on a screen.

---

## DEV-094 - A fixed thirty-second launch, and the control it reported missing from three screens

- **Affected specification**: `19` (a device scenario measures what only a device can show), DEC-102
  ("could not look" is never "looked and it was fine"), `DEV-080`, trap 195, trap 205.
- **Expected behaviour**: a harness waits for a **determinate state** before reading a screen, and
  reports a launch that did not happen as a launch that did not happen.
- **Implemented behaviour**: `verifyVoiceMode.ts`'s `relaunch()` was

  ```ts
  adb(['shell', 'am', 'force-stop', PACKAGE]);
  adb(['shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`]);
  sleep(30_000);
  ```

  a fixed wait, with no check that anything had started and no way for the caller to know.

- **The failure**: on a freshly booted emulator with a first-time Metro bundle, `VOICE-1` reported
  **"No 'Talk to Kynviora' control on: Today, Shelf, Safety"** - on a build where `VoiceBar` is
  rendered by all five destinations and was verified present by hand on the same device minutes
  later.

  Thirty seconds was short of the cold start. The loop walks the destinations in order, so the
  three it tried first were read off an app that had not drawn yet, and by Care and You - each
  several seconds further in - it had. That the two that passed were the two most recently migrated
  screens (DEC-142, DEC-143) made it look like a property of the migration.

  This is exactly what `DEV-080` was, on a different harness: `verifyAccessibility.ts` slept a
  fixed thirty seconds, a cold start at font scale 2 took longer, and the result was reported as an
  `INCONCLUSIVE` about the app. That fix waited on the tab bar "which its own helper existed for" -
  and the helper it grew, `coldStart` in `ui.ts`, was never adopted here.

- **How it was found**: `VOICE-1` failed on a run whose only code changes were in the voice
  executor and the tool registry, neither of which touches the entry control. A hand-driven probe
  of the same device found the control present, and the harness's own log showed one second between
  the API read and the first destination read.
- **Risk**: none to the product and high to the record. It is a false FAIL, which is the more
  expensive direction: a green run that should be red hides a defect once, and a red run that
  should be green sends somebody looking for one that does not exist - here, at three screens, one
  of which had just been migrated.
- **How it resolved**: `relaunch()` is `coldStart('voice')`, which force-stops, launches, waits up
  to ninety seconds for the tab bar, retries one launch that did not happen, and **answers whether
  it started**. Both callers act on that answer: `VOICE-1` reports `INCONCLUSIVE` naming the launch
  rather than the screens, and the Voice Mode step folds into the refusal it already had.

  `scrollToClickable` moved to `ui.ts` as `scrollToClickableNamed` in the same change, because
  `verifyOfflineWrites.ts` now needs it too and a second copy of a helper that exists to avoid a
  trap is how the trap comes back.

- **Tests**: none, and deliberately. The judgement `entryControlCheck` was always right - it was
  given a reading taken too early. What changed is the driving, which is the half `19` puts on
  hardware; `scripts/device/ui.test.ts` covers `coldStart`'s contract already.
- **Confirmed on hardware**: `verify:device:voice` is **9/9 PASS** after the change, with `VOICE-1`
  reporting "Found on all 5 destinations, within 20dp of the same position". The step that failed
  now takes three minutes rather than thirty seconds, which is how long the cold start actually is.
- **Status**: **RESOLVED 2026-09-08**.

---

## DEV-095 - The scripted agent was never given an item, so four of its rules could not run

- **Affected specification**: `19` (a device scenario measures what only a device can show), `17`,
  `docs/design/VOICE_MODE.md` section 3, DEC-136, DEC-140, DEC-148, `DEV-073`.
- **Expected behaviour**: `demonstrationScript`'s identifiers "come from the app's own state, so
  the scripted proposals name rows that actually exist - a proposal naming a fixture ID would be
  refused by the route rather than by the gate under test, which is the wrong measurement passing
  for the right one." That comment is in `devScript.ts` and describes what was intended.
- **Implemented behaviour**: `VoiceProvider` called
  `resolveVoiceProviders({...}, activeProfileId, null)` - the item was a **literal `null`** - and
  `resolveVoiceProviders` turned it into `''` before handing it to `demonstrationScript`.

  `validateArguments` refuses an empty required string, deliberately, because "an empty string is a
  missing value wearing the right type". So every item-scoped rule was refused at gate 3 as
  `INVALID_ARGUMENTS`, which `utteranceForRefusal` maps to `cannotDoThat`: **"I cannot do that by
  voice. You can do it on the screen, and I can take you there."**

- **The failure**: four of the script's rules had never been able to run - "what else do you need"
  (`explain_what_is_missing`), both dose rules (`record_dose`), and "remind me at eight"
  (`create_schedule`). A device harness driving any of them is told, in the app's own words, that
  Voice Mode cannot do a thing Voice Mode does.

  It is not a product defect: the flag is off in every ordinary build and nothing here ships. It is
  worse than a harness bug in one respect, though, and that is why it has a number. DEC-140 records
  that a dose recorded by voice with no signal goes into the app's own journal "the identical path
  the dose sheet uses, which `OFF-6` and `OFF-7` already measure on hardware" - and `OFF-6`/`OFF-7`
  measure the **dose sheet**. Recording a dose by voice has never been driven on a device at all,
  and could not have been.

- **Why nothing noticed**: none of `verify:device:voice`'s nine checks drives an item-scoped tool
  that has to **succeed**. `VOICE-3` is `delete_account`, which takes no arguments and is refused a
  gate earlier for being `TOUCH_ONLY`; `VOICE-4` is a fixed sentence; `VOICE-5` and `VOICE-7` use
  `start_package_capture`, which takes a `profileId` and no item. The one refusal the suite does
  assert is `touchOnly`, and this defect produces `cannotDoThat` - a different sentence nothing was
  looking at.
- **How it was found**: `verify:device:offline`'s new Run D reported `OFF-8` and `OFF-9`
  `INCONCLUSIVE` - "the confirmation was never offered" - and the captured hierarchy showed the
  transcript: `"You said. remind me at eight"` answered by `"I cannot do that by voice."` The
  refusal identifies itself: `cannotDoThat` is reachable only from `UNKNOWN_TOOL`,
  `INVALID_ARGUMENTS`, `UNEXPECTED_ARGUMENT` and `CONFIRMATION_REQUIRED`, and the tool exists.
- **How it resolved**: two changes, and the second is the one that matters.

  `demonstrationScript` takes `string | null` and **leaves out** a rule whose identifier it does not
  have, rather than emitting one that can only be refused. The filter reads the arguments each rule
  actually carries rather than a list of tool names, so a rule added later is covered.

  The item comes from `EXPO_PUBLIC_DEV_VOICE_ITEM_ID`, alongside `EXPO_PUBLIC_DEV_USER_ID` and for
  the same reason: reading it from the shelf would be a request on every launch of every build to
  serve a flag that is off in all of them, and `VoiceProvider` deliberately does not depend on which
  tab somebody last opened.

  It is documented as a requirement in both harness headers, because `.env.local` is not tracked
  and its absence is otherwise silent - the run reports a confirmation it never saw rather than a
  variable nobody set.

- **Tests**: 4 in `packages/agent/src/conversation.test.ts`, including the property rather than the
  list: over all four combinations of present and absent identifiers, no rule may carry an empty
  string argument. The `CONFIRM` and `CANCEL` rules survive a script stripped of everything else,
  because a script that cannot answer a confirmation cannot drive anything.
- **Status**: **RESOLVED 2026-09-08**.
