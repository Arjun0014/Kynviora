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
- **Required future work**: move derivation behind a scheduler when one exists, and emit the
  queue-age metric `20` asks for. Until then a task is only ever raised when someone looks, so a
  notification about review work is not possible - which is consistent with the inbox being
  deliberately non-urgent.

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
