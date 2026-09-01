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

## DEV-016 - The reviewer console has a backend and no interface

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
- **Required future work**: a separate staff application, on its own origin and its own session
  policy, with the MFA/passkey and environment isolation `13` requires. It is deliberately not the
  Expo app.

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

## DEV-018 - A historical shadow run cannot measure substance-matching rules

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
