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
