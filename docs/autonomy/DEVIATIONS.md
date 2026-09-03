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

---

## DEV-031 - `dose_event`'s idempotency key is still globally unique

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
- **Required future work**: a migration replacing `dose_event_idempotency` with a unique index on
  `(owned_item_id, client_operation_id)` or on the profile, whichever the dose route can scope to
  without a second query, and the same replay-read behaviour `POST /v1/items` now has. The route
  change is small; the migration is the part that needs care.

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

---

## DEV-033 - A digest is classified and never assembled

- **Affected specification**: `04` Phase 7.5 lists "digest policy for lower urgency" among the
  expected outputs.
- **Expected behaviour**: `MEDIUM` and `LOW` events do not interrupt anybody; they are collected
  and shown together, so a household sees them without a phone lighting up for each one.
- **Implemented behaviour**: the first half only. `MAX_CHANNEL_FOR_URGENCY` maps `MEDIUM` and `LOW`
  to `DIGEST`, `deliveryDecision` returns the channel with its reason, `dispatchAlert` records the
  plan and the channel on `alert_delivery` and sends nothing for any channel that is not
  `INTERRUPT`, and the settings screen says in words what each urgency does. Nothing gathers the
  digest-channel rows into a summary, and there is no route, no schedule and no screen for one.
- **Reason**: a digest is a thing that is _sent_ on a cadence, and nothing sends anything
  (`BLK-009`) or runs on a cadence at all - there is no scheduler in this build, which is the same
  gap `DEV-011` records for missed doses. Assembling a summary nothing can deliver would be
  building the half that cannot be checked against reality: the questions it has to answer -
  how often, what a person sees if they open the app before it arrives, whether an item resolved
  since it was collected still appears - are all about a delivery that does not happen.
- **Temporary or permanent**: temporary.
- **Risk**: low, and the safe direction. Nothing is lost: the events are recorded, and every one of
  them is already reachable in the app through the Safety Inbox and the Shelf, which is what
  `IN_APP_ONLY` and `DIGEST` both mean today. The failure it leaves is that a household must open
  Kynviora to see a `MEDIUM` finding rather than being told, and `02` treats not interrupting as
  the default rather than a degradation.
- **Required future work**: a scheduler, which `DEV-011` also needs, then a digest assembler that
  reads `alert_delivery` rows planned onto the digest channel and revalidates each one at assembly
  time - `revalidate` already exists, and a summary that reported a withdrawn alert as current
  would breach `04` Phase 7.5's own second exit criterion. Quiet hours and the digest want the same
  missing input, a local time (`DEV-030`), so the two are best done together.

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

## DEV-038 - Offline writes exist for schedules and item edits, and the ones still open are not waiting on engineering

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
  - **Nothing shows a person the queue.** `needsUserAttention` counts the operations that have
    stopped retrying and the count is exposed, but no screen acts on it - so a conflicted schedule
    edit is held safely and is not yet resolvable by the person it belongs to. That is the half of
    `12`'s "resolvable failure state" that is still a state and not yet resolvable.

    It is also why `DEV-044` could only be found on a device and only by watching the wire: with no
    screen showing what is waiting, "the edit was queued and not sent" and "the edit was sent" look
    identical from inside the app, and the store is SQLCipher-encrypted so `sqlite3` cannot answer
    it either. The queue screen is the first thing that would make the journal observable to the
    person whose edit is in it, and to anyone verifying that it moved.
- **Temporary or permanent**: temporary, and now partial rather than absent.
- **Risk**: low and visible, and lower than it was. Somebody offline can set a medicine time and it
  arrives when the connection does. What they cannot yet do is see that it is waiting, or act on one
  that came back as a conflict - so the failure mode is a change that stays queued longer than they
  expect, not one that is lost: nothing is ever discarded, and `drainPendingOperations` leaves
  untried operations with a full attempt budget rather than spending it on a dead tunnel (DEC-109).
- **Required future work**: a screen for the queue and for resolving a conflicted operation; then
  `dose_event` and `owned_item` once the phases they depend on can carry them.

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

## DEV-040 - Eight of `19`'s fourteen device scenarios are covered, and the other six are not waiting on a device

- **Affected specification**: `19` "Device E2E tests" lists fourteen scenarios that must be
  covered.
- **Expected behaviour**: all fourteen exercised on a device.
- **Implemented behaviour**: eight, plus five automated harnesses that re-run them
  (`npm run verify:device`, `npm run verify:device:a11y`, `npm run verify:device:reminders`,
  `npm run verify:device:update`, `npm run verify:device:offline`).

  | `19` scenario                         | State                                                       |
  | ------------------------------------- | ----------------------------------------------------------- |
  | Android install/update                | **Covered** - data, key and reminders survive a replace     |
  | Sign-up/sign-in/recovery              | No authentication exists (`BLK-010`, Phase 1.1)             |
  | Profile creation                      | Built and untested on device                                |
  | Medicine add/scan/manual path         | Manual path built; no scanner (`04` Phase 2.2)              |
  | Personal-care add/scan/OCR/confirm    | No OCR provider (`BLK-007`)                                 |
  | Medicine reminder after process death | **Covered**, and after a device restart as well             |
  | Offline create/edit/sync              | **Covered** - queued, survives a kill, arrives exactly once |
  | Safety alert open/resolution          | Nothing is publishable (`BLK-006`)                          |
  | Caregiver invite/revoke               | Built and untested on device                                |
  | Visit Pack export                     | Built and untested on device                                |
  | Camera/file permissions               | Notification permission covered; camera/file untested       |
  | TalkBack smoke suite                  | **Covered**                                                 |
  | Clock/time-zone change                | **Covered** - a dose does not move when the phone does      |
  | Low storage/network disruption        | **Network disruption covered.** Low storage untested        |

- **Reason**: the environment blocker is gone, and what is left divides into two kinds. Four
  scenarios are about a feature that does not exist, and each names the blocker or deviation that
  explains why. Three are about features that do exist and simply have not been driven on a device
  yet - which is work, not a decision. Nothing here is waiting on hardware.

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
- **Required future work**: drive the three built-but-untested flows on the emulator and add them
  to a harness - profile creation, caregiver invite/revoke, and Visit Pack export. All three are
  now worth driving in a way they were not before: each one creates something through a route that
  needed an idempotency key, so each was crashing on `crypto` until this session (`DEV-043`). The
  other three unblock with the blockers they name.

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
