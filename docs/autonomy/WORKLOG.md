# Kynviora - Work Log

Chronological engineering journal. Meaningful activity only.

---

## 2026-08-29 - Session 1

### Reconnaissance and specification reading

- Repository contained only `KYNVIORA_PROJECT_SPEC/` (27 files, ~250KB). No prior implementation,
  no Git repository.
- Read all 27 specification files completely.
- Toolchain: Node 22.14, npm 10.9, Python 3.13, Git 2.46. **No Docker.** Windows 11.
- Created the Git repository and tagged `baseline-spec-only` before any change.

### Research (Step C)

Recorded in `RESEARCH.md`. Four findings changed the implementation:

- **R-001**: Expo SDK 57 / RN 0.86 confirmed real and current (`expo@57.0.18` on npm; SDK 57
  released 2026-06-30). The spec baseline is accurate, not aspirational. Adopted unchanged.
- **R-002**: `expo-sqlite` has first-party SQLCipher support via a `useSQLCipher` config flag.
  Chosen over `op-sqlite` for fewer native dependencies.
- **R-003**: **The most consequential finding.** Tested PGlite empirically rather than trusting a
  search answer. It runs genuine PostgreSQL 18.3 in WASM with full `CREATE ROLE`, `SET ROLE`,
  `GRANT`, and RLS support. Critically, the same test confirmed that querying as `postgres`
  returned **all rows despite `FORCE ROW LEVEL SECURITY`** - superusers bypass RLS entirely. That
  observation directly produced DEC-005 and the harness guard.
- **R-004/R-005**: Salicylic acid is an ideal Lens fixture - simultaneously RESTRICTED +
  CONCENTRATION_LIMIT + USE_CONDITION + AGE_OR_ROUTE_CONDITION in the EU, with no matched US
  cosmetic prohibition. It demonstrates both hard rules at once. **However**, the EU Annex fetch
  returned no extractable content and the FDA URL in spec `26` returned **HTTP 404**. The facts
  therefore rest on search summaries, which produced DEC-016 and `BLK-004`.

### Stage 0 - foundation

- npm workspaces monorepo, strict TypeScript, ESLint type-checked, Prettier, Vitest.
- Custom lint rule making a bare `new Date()` an error in production code, protecting assessment
  replay.
- Domain package with zero runtime dependencies: controlled vocabularies as closed unions,
  branded IDs across the eight product layers, append-only field assertions, `Untrusted<T>`
  quarantine.
- **Problem encountered**: writing files containing literal control characters via heredoc
  corrupted several source files (they became binary). Fixed by rewriting the affected lines with
  `\uXXXX` escapes via a small Node script. Noted in `STATUS.md` as a trap.
- 88 tests. Committed.

### Stage 1 - identity persistence and authorization

- Migrations `0001` (roles, request context, audit) and `0002` (users, households, profiles,
  caregiver grants, consent).
- Two non-superuser database roles: `kynviora_app` for user requests under full RLS, and
  `kynviora_service` for privileged operations. The app role holds no write grant on shared or
  privileged tables.
- PGlite harness with a guard that fails any test not running as the expected non-superuser role.
- **Finding while testing**: four tests failed because the GRANT layer denied UPDATE/DELETE
  _before_ the append-only trigger fired. This was better than expected - append-only is enforced
  at two independent layers. Rewrote the tests to assert both, running the trigger check as the
  table owner to bypass the grant layer and isolate it.
- **Finding**: a consent-withdrawal test was non-deterministic because both rows shared the same
  transaction `now()`. Corrected the test to order by the supersession link, which is the
  authoritative ordering and the reason DEC-013 stores it explicitly.
- 31 database tests including threats A1 and A2. Committed.

### Stage 3/5 - Living Catalog engine

- Migration `0003`: eight product layers as separate tables, shared catalog readable but not
  writable by the app role, evidence assets private to the contributor, a contributor-free
  corroboration view.
- GTIN validation, ingredient parsing and normalization, order-sensitive fingerprinting, conflict
  resolution, corroboration policy.
- **Bug found by test**: a comma-decimal concentration such as "1,5%" (common on European and
  Indian labels) was split on the comma as a list separator, producing a phantom ingredient _and_
  losing the concentration - the exact datum a concentration-limited rule needs. Fixed with a
  deterministic rule: a comma directly between two digits is a decimal separator.
- **Design gap found by test**: three conflict tests failed because a fingerprint match
  short-circuited to `REUSE_EXISTING` without checking scalar fields. For a _degraded_ medicine
  fingerprint (no structured strength extracted), two packs of different strengths can share a
  hash. Made the scalar cross-check load-bearing before reuse.
- **Modelling smell surfaced by lint**: `Jurisdiction | string` for market. Introduced
  `MarketCode` as a distinct branded type with `jurisdictionsForMarket()`, where GB maps to
  **both** GB and NI. Recorded as DEV-002.
- 91 catalog tests. Committed.

### Stage 6/7 - regulatory registry, Citation Gate, Lens

- Registry record types with multi-status rules, structured conditions, supersession, and
  scientific opinions as a structurally distinct type.
- Citation Gate as a pure function with 19 stable failure codes. Refuses informational databases
  and search/LLM output as legal-status sources, and refuses an APPROVED record with no named
  reviewer.
- Lens projection enforcing all four hard rules.
- Fixtures ship gate-rejected per DEC-016, with a test asserting every shipped fixture is refused.
- 72 tests, all passing first run. Committed.

### Stage 6.5 - safety rule engine

- Pure, versioned, replayable. `evaluationInstant` is an argument rather than a clock read, which
  is what makes expiry evaluation reproducible.
- Evidence level copied verbatim from the human-authored rule; `maxUrgency` is a ceiling that
  evaluation can lower but never raise. No `upgradeUrgency` export exists, and a test asserts it.
- Batch matching: a known-unaffected lot produces no alert at all; an unknown lot produces
  PROBABLE with reduced urgency.
- Unimplemented rule kinds return a non-match rather than shipping a placeholder that could fire.
- 42 tests. Committed.

### Section 47 vertical slice

- One executable test walking profile to capture to observation to formulation resolution to
  normalization to regulatory lookup to assessment to result, covering all seven section 31
  scenarios.
- **Bug found by scenario 5**: `limitationsFor` emitted "this package does not disclose the
  concentration" whenever applicability was CONDITION_UNKNOWN and a concentration limit existed -
  including when the concentration _was_ printed and the intended age was the actually-unknown
  condition. A factually wrong statement about the user's own package, on the screen spec `09`
  requires to be most precise.
  Fixed by making `determineApplicabilityDetailed` evaluate conditions exhaustively instead of
  short-circuiting, and report which specific conditions are unresolved. The Lens entry now
  exposes `unresolvedConditions` so a screen can prompt for the exact missing datum.
- **Also found**: the fixture GTINs were not check-digit valid; the barcode validator would have
  rejected them. Corrected to valid EAN-13 values using India's 890 GS1 prefix.
- 36 tests. Committed.

### State at end of session 1

388 tests passing, typecheck clean, lint clean, 6 commits plus the baseline tag.

**Next**: migrations `0004`-`0006` (owned items, source/regulatory persistence, assessments) with
RLS tests, then the ingestion adapter framework, then the API service, then the Expo app.

---

## 2026-08-29 - Session 1, continued

### Persistence completed

Migrations `0004` (shelf, health context, medicine care), `0005` (source registry, regulatory
registry) and `0006` (assessments, alerts, receipts), with 65 new authorization tests.

- **SQL error found on first run**: a CHECK constraint containing a subquery. Postgres does not
  permit that; replaced with a pure regex expression over the joined array. Also improved the
  harness so a migration failure reports the position and a short excerpt rather than letting the
  driver serialize an entire migration into the output.
- **Design decision recorded in the schema**: the Citation Gate now exists at two layers. The
  pure function makes decisions testable and explainable; CHECK constraints make the same
  requirements hold for a direct database write - an operator session, a mistaken migration, or a
  future service bug.
- Three test failures on the regulatory suite, all my own test-authoring errors. The most
  interesting: my `DELETE FROM regulatory_rule_version` was correctly blocked by the append-only
  trigger. The fix was to work with the invariant (scope queries by a unique substance key)
  rather than around it, and to add a test asserting the deletion is refused.

### Ingestion pipeline

Source retrieval with an origin allow-list, size and content-type limits, checksum-based change
detection, and a replayable fixture adapter.

- The origin check compares scheme, host and path-segment boundary. A `startsWith` check would
  accept `alerts.example.test.evil.test`, which is a different host entirely - covered by a test.
- **34 lint errors reached a commit** because my verification command piped eslint through
  `tail`, which discards the exit code. Fixed the root cause: `npm run verify` now chains every
  gate with `&&`, and the CI workflow comments call the hazard out explicitly. The lint errors
  themselves came from `Array.isArray` widening a `readonly T[]` to `any[]`; the fix was to type
  the untrusted document as `Readonly<Record<string, unknown>>` and narrow each field explicitly,
  which is the more honest model anyway.

### API boundary

Fastify with Zod, tested against the real database through PGlite with RLS in force.

The design property worth recording: `GET /v1/items` passes a client-supplied `profileId`
straight into the query. That is safe by construction - the ID narrows the result set, RLS
decides access - and a test asserts a foreign profile returns a response byte-identical to an
empty one, so the API never confirms a profile exists to someone not permitted to see it.

### Presentation layer

Design tokens, status presentation and safety copy, with 436 tests.

- **Two bugs found by tests.** The forbidden-claim detector flagged "This does not mean the
  product is safe", which spec 09 and 18 explicitly _require_ - a negation window fixed it, since
  the negation sits several words before the phrase. Separately, the danger rule missed "this
  product is not dangerous", which is itself the universal safety verdict spec 23 D-005 forbids;
  the pattern now catches both forms, which is why that rule is deliberately _not_
  negation-sensitive. The asymmetry is documented in the code.

### Mobile app

Expo SDK 57 shell. Versions verified rather than assumed: expo 57.0.18, react-native 0.86.2,
react 19.2.8. Typechecks against the real toolchain; nothing has run on a device (`BLK-002`).

An initial install failed because I pinned react 19.2.0 while RN 0.86.2 requires `^19.2.3` -
corrected to the version the SDK actually requires.

### Schedule, capture and Trust Passport

- Schedule computation stores local wall-clock times plus an IANA zone rather than UTC instants,
  because storing UTC silently shifts a dose by an hour twice a year. Tested across a
  spring-forward transition; the hand-computed UTC instants matched.
- Capture pipeline enforces the rule end to end: a machine-built assertion is UNCONFIRMED with
  OCR provenance, so even when both engines agree _and_ the validator passes,
  `isTrustedForSafetyUse` still returns false.
- Trust Passport has no aggregate field, and a test asserts none exists.

### Record correction

Two commit messages state test counts slightly higher than the actual run: one says 1010 where
the suite reported 1008, and one says 1060 where it reported 1047. I composed those messages
before running the suite. The counts in `STATUS.md` and in this log are taken from actual runs.
Git history is not rewritten, so the discrepancy is recorded here instead.

### State at end of session 1

1073 tests passing, typecheck clean, lint clean, format clean. 16 commits plus the baseline tag.
Fifteen spec phases marked `COMPLETE`; nine marked blocked on a device, a credential, a dataset,
or a qualified reviewer.

---

## Session 2

Resumed from `STATUS.md` at 1116 tests, 22 files, `npm run verify` clean. Baseline re-run before
touching anything and confirmed at exit 0.

### Phase 8.1 - caregiver invitation and grants

The grant model already existed and was tested. What was missing was everything around it: how an
invitation comes into being, how it is redeemed, and what stops it being redeemed by the wrong
person or twice.

**An invitation had to be its own entity.** `caregiver_grant.grantee_user_id` is `NOT NULL`, so a
grant cannot represent "an invitation to a person who has not signed up yet" - which is precisely
the window an invitation occupies. That constraint decided the schema rather than a preference:
migration `0007` adds `caregiver_invitation`, and it is the only one of the two records that
carries a secret.

**The token is the interesting part.** It is the one artefact in this flow that leaves the system,
and it is a bearer credential to another person's medicines and documents. Four things follow
(DEC-018, DEC-021):

- 32 bytes of `randomBytes`, base64url, stored only as `sha256`. The plaintext is returned exactly
  once and is unrecoverable afterwards - including on an idempotent retry, where the response says
  so explicitly rather than silently returning `null`.
- Acceptance looks the row up **by hash**. There is no code path that fetches a row and compares a
  presented token to a stored one, so a non-constant-time comparison cannot be written.
- The app role has a **column-level** `GRANT` that omits `token_hash`. Row-level security is
  row-shaped and cannot hide a column; without the column grant, "the app never reads the hash"
  would be a convention about query style that a later `SELECT *` would quietly break.
- A CHECK requires 64 lowercase hex. A base64url token is 43 characters with non-hex letters, so
  the most plausible storage mistake - writing the plaintext into the hash column - cannot commit.

**Two active grants had to be unrepresentable.** `kynviora.has_capability` unions capabilities
across matching grants, so two active grants for one pair would silently produce a permission set
nobody approved, at the policy layer, where no one would see it happen. A partial unique index on
`(profile_id, grantee_user_id) WHERE status = 'ACTIVE'` refuses it, and the domain refuses the
acceptance that would create it (DEC-019). Redeeming a second invitation therefore neither widens
nor narrows an existing grant - it is refused, and the owner revokes first, which keeps every
capability change an explicit audited act.

**`MANAGE_CAREGIVERS` is owner-only to delegate** (DEC-020). The obvious rule - a delegated
administrator may grant only what they hold - does not stop the interesting attack, because a
holder of `MANAGE_CAREGIVERS` _does_ hold it. Left there, the capability is self-propagating: one
caregiver appoints more administrators, who appoint more, and every individual step looks
legitimate in the audit log while the owner loses practical control of their own access list.

**Disclosure posture, decided per case.** Reaching the acceptance decision means the caller
already holds the token, so telling them "this invitation expired" discloses nothing and is much
better than a blank refusal. The exception is the email binding: a link that reached the wrong
person must not confirm whose address it was for, so a recipient mismatch returns the same code
and the same body as an unknown token. Tests assert the two responses are byte-identical apart
from the correlation ID, and that the address appears nowhere in either.

**Step-up is asymmetric, deliberately.** Creating, revoking an invitation, and revoking a grant
all require fresh re-authentication (`14`). Accepting and declining do not: the invitee is acting
on their own account and exposes none of their own data, and adding a second factor there would
put friction on the one step performed by the least technical participant. Revocation is included
even though it only reduces access, because an attacker with a hijacked session silencing a
caregiver is a real abuse of this feature rather than a safe direction.

### Things the tests caught

- **The append-only trigger refused my test fixture.** `beforeEach` tried to `DELETE FROM
audit_event`; `forbid_mutation` blocked it, which is DEC-013 working exactly as intended. The
  fix was to stop clearing the table and scope the audit assertions by target instead - the audit
  route already joins back to live invitation and grant rows, so events whose target was removed
  drop out on their own.
- **A failing shelf assertion was correct behaviour.** A caregiver granted `VIEW_SHELF` saw zero
  items for a profile whose only item is a medicine, because `owned_item_select` requires
  `VIEW_MEDICINES` for medicines. My assertion was wrong, not the policy. The test now asserts the
  separation directly, which is a property `03` group H requires and nothing had been covering: an
  invitation to the shelf is not an invitation to the medicines on it.
- **`isErr` never narrowed its false branch.** `if (isErr(r)) return;` left `r` un-narrowed, so
  `r.value` would not compile - the union arms were inline object literals, and a type predicate
  written against an inline literal does not subtract the matching arm. Every existing call site
  had worked around it by only using the positive branch. Naming the arms (`Ok`, `Err`) and
  declaring the guards against those names fixed it; nothing else changed and the suite passed
  unchanged (DEV-008).

### What is not done

The mobile screens are built, typecheck against the real contract and render every required
screen state, but the Care tab shows `loading` because the repository and navigation are not
wired (`DEV-007`). No caregiver rows are fabricated to make the screen look finished: on this
screen a wrong row is a false statement about who can see a person's health data. Device
verification remains blocked by `BLK-002`.

The 7-day invitation lifetime and 30-day maximum are engineering defaults, not approved product
thresholds (`DEV-006`).

### State at end of Phase 8.1

1265 tests passing across 26 files, up from 1116 across 22. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`. 149 new tests: 45 domain, 30 database, 49 API, 25
presentation.

### Phase 8.4 - Visit Pack

Two exit criteria, and both are about a _sequence_ rather than about any single handler: export
never happens automatically, and a user can review exactly what will be shared. A single
"export this profile" endpoint could not satisfy either, so the flow is four steps - propose,
choose, review, confirm - and the guarantees are encoded rather than asserted in a comment.

**Export never happens automatically.** There is no code path from a profile ID to a pack. The
request carries an explicit list of selected entity IDs; an empty one is refused, an ID that is
not on offer is refused, and no "include everything" flag exists to omit. The database agrees:
`visit_pack_not_empty` refuses a row with neither a manifest entry nor a note. Step-up is checked
before body parsing, so an export attempt with no re-authentication is refused identically
whatever else is wrong with it.

**A user can review exactly what will be shared** became the more interesting problem. The
honest version of that guarantee is not "we showed a screen" - it is "the bytes that get shared
are the bytes that were read". So the candidates response carries a digest of the proposal, the
generate request quotes the digest of whatever subset the user actually reviewed, and generation
recomputes it from live data and refuses on a mismatch (DEC-023). The failure this catches is not
an attacker - the user is exporting their own data - but a caregiver editing a medicine between
the review screen and the Generate button. Without the check, a line nobody read would end up in
a document handed to a clinician.

The digest covers the caveat as well as the content, so an item that became _verified_ since
review also counts as a change. That looked like over-strictness until I wrote the test: the
printed page genuinely differs, and "checked against the package" versus "entered by hand and not
checked" is exactly the distinction the page exists to carry.

**What is stored was the other real decision** (DEC-022). Rendering the pack once and storing the
result is the obvious implementation and the wrong one: it creates a second store of the most
sensitive data in the system, longer-lived than the original, surviving the user correcting or
deleting the record it came from, and adding a cached-export category to the deletion workflow
`16` requires be enumerated. So the row holds a manifest - section, entity kind, ID, version -
plus the digest, and retrieval re-renders from the live records under the same row-level
security as any other read. A deletion is then actually a deletion.

The cost is drift, and the design makes it visible instead of silent: `matchesGeneratedContent`
goes false when the live entries no longer hash to the stored digest, and `removedSinceGeneration`
counts records that have gone. A reader is told the pack no longer matches, rather than shown
different data under an old date. A test asserts that no medicine name, ingredient term or
directions text appears anywhere in the `visit_pack` table.

**Provenance is on the page, not in a footnote.** Every entry carries a required caveat, derived
from its verification state or provenance kind. `factCaveat` lists every provenance kind
explicitly - the lint rule demanded it, and the rule was right: a `default` branch would let a
newly added machine-extraction kind silently inherit "reported by the person", which for an OCR
result would be false on a page a clinician reads. Directions text is reproduced verbatim, never
paraphrased.

**Exports are a separate permission, and the tests prove it.** `visit_pack_select` admits the
owner, the creator, and a caregiver holding `EXPORT_SUMMARY` - deliberately not one holding
`VIEW_MEDICINES`. A caregiver who can read the medicines cannot see what was shared with a
clinician. `03` group H requires that separation; a test asserts it at the database and again
through the API.

### Things worth recording

- The placeholder `POST /v1/visit-packs` from the API phase returned 202 to anything with a fresh
  step-up. Replacing it broke three tests, correctly. Two now assert the step-up gate as before;
  the third asserted a 202 that no longer means anything, so it was rewritten to assert what is
  actually true - that once step-up passes, an empty request fails on its merits - plus a new
  case asserting the gate fires before body parsing.
- Writing U+001F and U+001E as literal characters in the source corrupted the file, exactly as
  trap 7 in `STATUS.md` warns. Fixed by escaping at the byte level and never re-introducing them.

### Resume verification, and a defect it found

The session ended at the weekly limit part-way through this log entry, so the phase was re-verified
from the repository state rather than trusted. Everything above was present and the code was
complete, but `npm run verify` no longer passed: `services/api/src/caregiver.test.ts > refuses an
expired invitation` failed, with invitation _creation_ returning 500.

The cause was a genuine defect in Phase 8.1, not a flaky test. `caregiver_invitation` derives
`expires_at` from the **injected** clock but let `created_at` fall through to its
`DEFAULT now()` - the **database wall** clock. The CHECK `expires_at > created_at` therefore
compared two different clocks. With the suite's clock frozen at 2026-08-29 and a one-day
lifetime, the row stayed insertable only while real time was behind 2026-08-30. It passed on the
day it was written and started failing the next day. Resuming on 2026-08-31 is what surfaced it.

The fix is to write `created_at` from `ctx.now`, so both sides of the constraint come from one
clock - the same reason production code may not call `new Date()`. `visit_pack` already passed
`generated_at` explicitly and was never affected; a comment on its constraint now says why, so the
next table does not rediscover this.

The distinction that makes this coherent is recorded as DEC-024: an **authorization** predicate
uses the real clock deliberately, because an injectable clock must never be able to resurrect an
expired grant, while **written domain data** uses the injected clock so it stays replayable.
`has_capability` is on the correct side of that line and was left alone. A test now names the
invariant directly by reading `created_at` back and asserting which clock wrote it, rather than
relying on the expired-invitation test to catch it as a side effect.

### State at end of Phase 8.4

1366 tests passing across 30 files, up from 1265 across 26. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`. 100 new tests for the phase: 34 domain, 18 database, 31 API
(including the two rewritten step-up cases), 17 presentation - plus the one regression test for
the clock defect above.

The mobile review screen is built and typechecks against the real contract - it derives every
count and section name from the same selection that will be sent, so it cannot describe an export
it is not about to make - but like the caregiver screens it is not wired to a repository
(`DEV-007`).

### Phase 8.2 - Caregiver alert delivery

The exit criterion is that caregiver access is testable through deny-by-default authorization
cases, which is really a statement about shape: a feature that decides who to notify by
accumulating reasons to include people cannot be tested that way, because there is no single place
where the "no" lives. So delivery is a filter over candidates. Each candidate is dropped unless
something affirmatively admits it, every drop carries a named reason, and the reasons are part of
the returned plan rather than a log line - which is what makes each one a test.

**Two questions, kept apart.** Who may be told is an authorization question, answered by
capabilities and nothing else. How much the notification says is a disclosure question, answered
by preferences. Conflating them is how caregiver features leak, so they are two functions:
`selectRecipients` cannot render text and `notificationFor` cannot add a recipient.

**The permissions really are separate.** `MISSED_DOSE` maps to `RECEIVE_MISSED_DOSE` and
deliberately not to `VIEW_SAFETY`. A caregiver watching for a recall is not thereby entitled to
know whether someone took their tablets this morning, and `03` group H requires that separation.
Both directions are asserted - safety access does not admit dose notifications, dose access does
not admit safety ones - at the domain, the database and the API.

**Disclosure is two dials and the narrower wins** (DEC-025). The owner sets a ceiling on what any
caregiver notification may show; each recipient sets their own preference for their own device.
Neither may override the other, so both apply. The interesting bug was one the tests found rather
than one I reasoned my way to: the first draft also gave the policy an `ownerDetail`, and the test
asserting "the owner is not subject to the caregiver ceiling" failed, because the owner then had
two dials that could disagree. Removing it was the fix - every recipient already has a personal
preference, and the ceiling is about other people's devices.

**What gets written down** (DEC-026). `alert_delivery` stores the recipient, the event, the
disclosure level and the time - never the body. The body is the one string in the system written
expressly to be readable on a locked screen, and storing it would put it in a durable table with a
different access path from the alert it describes, outliving that alert's withdrawal. Same
objection as DEC-022. A test dumps the whole table and asserts no medicine name and no person's
name appears in it.

The delivery row is written _before_ the transport is called. A crash between the two then leaves
a recorded delivery that never arrived, rather than an arrival nobody recorded - which is the
failure that re-notifies. That is the right direction for a notification and the wrong one for a
payment, so it is chosen deliberately and pinned by a test that injects a throwing transport.

**A withdrawn alert is refused, not quietly skipped.** Returning an empty plan would write an
audit record of a dispatch with zero recipients, which reads as though the alert were live and
simply had no audience. `19` lists "stale withdrawn alert still actionable" as release-blocking,
and a notification is the least revocable form of actionable.

**Resolution state is narrowed by column, not by row.** RLS already limits the caregiver alert
view to `VIEW_SAFETY` holders and published alerts. What row-level security cannot express is that
a caregiver sees the resolution _outcome_ but not the free-text note - the one field a user can
put anything into, possibly written for themselves. And a withheld note is reported as withheld
rather than left blank, because a blank reads as "there is no note", which is a different claim.

### Things worth recording

- Four API tests expected 403 and got 404. The code was right: `PERMISSION_DENIED` maps to 404
  deliberately so the API is not an existence oracle for profile IDs. The tests now assert that
  property directly - a real profile and an invented one return byte-identical bodies.
- `alert_delivery` is refused mutation by two independent mechanisms, and the first test asserted
  only whichever fired first. Split into three: the service role has no UPDATE or DELETE grant at
  all, and the append-only trigger refuses both even from a role that does hold the privilege.
  Asserting only the outer layer would let the inner one be dropped unnoticed.
- The heredoc collapse noted in the resume section bit again while escaping control characters -
  `\` became `\`, so `\u001F` written that way lands as a real control character. Building the
  escape with `String.fromCharCode(92)` is the reliable form. Recorded as trap 13.

### State at end of Phase 8.2

1492 tests passing across 34 files, up from 1366 across 30. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`. 126 new tests: 38 domain, 32 database, 36 API, 20
presentation.

Outstanding: no push provider exists, so nothing here claims a device received anything
(`BLK-009`) - delivery goes through a `NotificationTransport` port whose only implementation
records. Missed-dose dispatch is implemented and enforced but nothing calls it yet, because the
grace window that decides when a dose counts as unrecorded is an unmade product decision
(`DEV-011`). The notification settings screen typechecks and derives every example from the same
renderer the server dispatches with, but like the other screens it is not wired (`DEV-007`).

### Phase 8.3 - Household Review Inbox

Two exit criteria, and both are the kind that a working implementation can satisfy in appearance
while failing in fact.

**"Review tasks are clearly different from safety alerts."** The schema from `0004` had already
got this right - no urgency column, no evidence level - so the work was keeping it true through
three more layers. The domain type has no such field and a test asserts it over the object's own
keys. The API payload carries none of the vocabulary and a test greps the response body for it.
The presentation layer may use only `neutral` and `informational`; `action` and `attention` are
excluded by a closed union, and a test derives the alert tones from `presentUrgency` itself rather
than hard-coding them, so the exclusion cannot drift if the alert palette changes.

The place this is usually lost is the screen: the backend keeps the two apart, and then both
render as cards with a coloured left bar and become indistinguishable at a glance. So the mobile
screen has no tone-coloured edge, no count badge and no ranking - a ranked list with a badge _is_
an alert list, whatever the tokens say.

**"Completing a task updates the relevant authoritative record."** This was the real design
problem, because `review_task` already had a `state` column and a Done button would have been
both obvious and wrong (DEC-027). So closing is not expressible as a state change: the endpoint
takes the _change_, applies it to the record first, and closes the task only if that write
affected a row. Three layers enforce it - the domain refuses an empty change list, refuses a
change aimed at another record, and refuses a field outside the closed list for that kind; and
`review_task_closed_wrote_something` is a CHECK, so "mark done" is unwritable even by a direct
SQL statement that never touches the API.

"Not applicable" is not the exception it looks like. Deciding a task does not apply is itself a
fact about the record - "I looked at this pack and the details are right" is what
`last_reviewed_at` means - so both outcomes write and neither can write nothing.

**Derivation, not accumulation.** The tasks that should be open are a pure function of the record
state, so a task cannot outlive the condition that produced it. That also makes the refresh
idempotent, which the partial unique index over open tasks turns into a guarantee rather than a
convention. Derivation runs privileged over the whole profile, deliberately: under the caller's
row-level view, the _stored_ task list would depend on who last opened the inbox, and a caregiver
with narrow capabilities would silently shrink the owner's list by looking at it. The listing is
filtered afterwards by joining each task to its subject through the RLS-scoped connection - a
subject the caller cannot read comes back null and the task is dropped, so the existing policies
do the filtering and no new predicate was needed.

**The bug the tests found.** `COMPLETION_CAPABILITY` first mapped the owned-item kinds to
`MANAGE_SHELF`. Three API tests failed, and the reason was better than the fix: `owned_item_update`
narrows by `item_kind` - shelf for a personal-care product, medicines for a medicine - and a task
row names only the item's ID, so neither the domain nor the row-level policy can tell which
applies. Naming one made the domain disagree with the policy that actually decides. It is now
`COMPLETION_CAPABILITIES`, plural, listing both for those kinds, with the division of labour
stated: the domain checks that the caller holds a management capability at all, and the database -
which knows the item kind - makes the binding decision. A test pins the case where the domain
admits and the database refuses, and asserts the task stays open (DEC-028).

### Things worth recording

- Writing `` `03` `` inside a SQL template literal terminated the string and produced
  "Octal literals are not allowed" from a comment. Backticks are fine in a JSDoc block and fatal
  inside a template literal; the SQL comment now says "Spec 03".
- `DatabaseConnection.query` returns `affectedRows`, not `rowCount`. The whole "did the record
  write actually happen" mechanism depends on that value, so it is worth knowing which name the
  port uses.
- Migration `0010` made `subject_kind` NOT NULL, which broke a pre-existing `db/shelf.test.ts`
  insert that predated the column. Updated rather than worked around - the test now inserts the
  subject the way every other caller does.

### State at end of Phase 8.3

1587 tests passing across 38 files, up from 1492 across 34. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`. 95 new tests: 35 domain, 21 database, 21 API, 18
presentation.

Outstanding: derivation runs on read rather than on a schedule, because no scheduler exists yet
(`DEV-013`); the three intervals are engineering defaults awaiting product sign-off (`DEV-012`);
and the inbox screen typechecks but is not wired (`DEV-007`).

### Phase 8.5 - Medicine Reconciliation workflow v1

One exit criterion, and it is the sharpest one in the project: "Kynviora never chooses which
conflicting instruction is medically correct."

Reconciliation is exactly the feature where that is hardest to hold, because the user arrives with
two lists that disagree - the discharge summary says 10 mg, the pack at home says 5 mg - and the
single most helpful-seeming thing the software could do is say which one to follow. It is also the
one thing `09` forbids in terms. A rule saying "do not choose" would not survive contact with the
next feature request, so the criterion was built as a **shape** at four layers, each of which
makes choosing unrepresentable rather than merely disallowed.

**The schema has nowhere to put an answer.** `reconciliation_difference` stores `previous_value`
and `current_value` and no third column. A test enumerates `information_schema.columns` and
asserts that `suggested_value`, `preferred_value`, `correct_value`, `winner`, `confidence` and
`score` are absent, so the mechanism is checked against the real table rather than against a type
that a migration could quietly outgrow.

**The vocabulary cannot say it.** Every settled resolution names a human or a document. A CHECK
refuses `AUTO_RESOLVED`, `SYSTEM_CHOSE` and `RECOMMENDED`, and a second test reads
`pg_get_constraintdef` and asserts the constraint's own text contains no such token - because the
point is that no member exists, not that one spelling is refused.

**The difference kinds name the lists, not the medicine.** `04` Phase 8.5 says
"added/removed/changed", and those words are used on the screen but not in the vocabulary.
"Removed" is a claim about the medicine - it implies someone stopped it - while what Kynviora
knows is that a line is on one list and not the other. A medicine absent from a discharge summary
may have been stopped, or the summary may only have covered the admission, and those have
opposite correct actions. So the kinds are `ONLY_IN_PREVIOUS` / `ONLY_IN_CURRENT` /
`FIELD_DIFFERS` / `MATCHES`, and the `ONLY_IN_PREVIOUS` copy says outright that Kynviora cannot
tell which (DEC-029). `MATCHES` is reported rather than dropped: a list showing only problems
misrepresents the scale of what changed, which is the most reassuring part of a reconciliation.

**The design flaw the tests exposed.** `evaluateResolution` first treated
`CONFIRMED_WITH_PHARMACIST` as adopting the current list. Writing the test made both branches
collapse to the same result, which is usually a sign a real case is missing - and it was. A
pharmacist may confirm the _older_ dose, and frequently does: the new list may be a transcription
error, or may describe an intended change that never happened. Inferring `CURRENT` because the
current list is newer is precisely the judgement Phase 8.5 forbids, made on a heuristic that has
nothing to do with medicine. So every settling resolution must name the side, the person supplies
it, and `difference_settled_has_side` enforces it at the schema level too (DEC-030). A test pins
the case the whole design exists for: a prescriber confirming `PREVIOUS`, with the shelf
untouched.

**One row per differing field, not per medicine.** A medicine whose strength and directions both
differ produces two rows, because they are two questions with potentially different answers - a
pharmacist might confirm the new strength and the old directions. Collapsing them would force one
decision onto two facts, which is a quiet way of deciding for someone.

**Where it would actually have been lost.** By the time a difference reaches a screen the domain
and the schema have both refused to hold an answer, so the only way left to choose one is
_visually_, and it takes no code at all: bold the new value, grey the old one, pre-select "I'm
going with the new list". So both sides come from one `presentSide` function that returns the same
tone and an `emphasised: false` flag for each, the mobile screen renders them through a single
style object rather than two that happen to match, no resolution option carries a `recommended` or
`default` field, and a test asserts no such key exists rather than that none is currently set. The
user's own resolutions are written in the first person - "I'm going with the new list" - because
an imperative on a button is Kynviora telling someone what to do with a medicine.

**Unresolved is an outcome, not a failure.** `04` Phase 8.5 lists unresolved differences as
expected output. Someone who cannot reach their pharmacist today has a real state, and forcing a
choice to clear the screen is how a reconciliation produces a confidently wrong record. So
`canComplete` requires only that every difference has been _looked at_, `STILL_UNRESOLVED` records
that honestly, and the completion message reports the count without treating it as a problem.

**Privilege.** Creation and resolution recording are privileged, because the rows are about the
profile and the difference set must be identical whoever opens it. The one write to a medicine
deliberately is not: it goes through the RLS-scoped connection, so the flow cannot change what the
caller could not have changed on the medicine screen itself. Starting a reconciliation takes
`MANAGE_MEDICINES`, not `VIEW_MEDICINES` - a caregiver who may read the shelf may not rewrite it -
and `PERMISSION_DENIED` maps to 404 as everywhere else, with a test asserting the response for a
real profile is byte-identical to the one for an invented ID.

### Things worth recording

- `expectDenied` fires on whichever CHECK Postgres evaluates first, and an invented resolution
  violates two of them. Two tests were asserting the constraint they were _about_ rather than the
  one that happens to fire; the fix was to assert the refusal against either, and to check the
  vocabulary separately by reading the constraint definition. A test that names one constraint out
  of several that all refuse the same row is testing evaluation order, not behaviour.
- An arrow function passed to `expectDenied` is not async, so `expectDenied(() => f(await g()))`
  is a parse error rather than a type error. Hoist the setup above the call.

### State at end of Phase 8.5

1696 tests passing across 42 files, up from 1587 across 38. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 109 new tests: 30 domain, 28 database, 20 API, 31
presentation.

Stage 8 is now complete. Outstanding on this phase: matching is by a caller-supplied key rather
than by catalog identity (`DEV-014`), the current list is typed in rather than extracted from the
attached document (`DEV-015`, `BLK-007`), and the review screen typechecks but is not wired
(`DEV-007`).

### Phase 6.6 - Reviewer queue and publication controls

Two exit criteria, and the first one is a sentence with two load-bearing words:
"High-impact content cannot be published by an **unauthorized** **single** path."

_Unauthorized_ is about where the right to approve comes from. Before this phase,
`assessment_rule_version.approved_by_reviewer_id` was free text - a team name would have satisfied
it - and nothing established that the named reviewer existed or was entitled to approve what they
had approved. `14` says admin and reviewer roles are not inferred from client claims, so migration
`0012` adds a `reviewer` table keyed by user ID, with the roles `10` names, and the approval
trigger checks the claimed role against a stored ACTIVE grant. Nobody may grant themselves one: a
CHECK refuses a row whose grantee is its granter, because the ability to create an approver is the
two-person rule's weakest point.

_Single_ turned out to be four different failures rather than one, and each is refused separately:

- **Not a reviewer.** No stored role, no access - and the console returns 404, so it is not an
  oracle for which queue items exist.
- **Not that kind of reviewer.** `10` says regulatory comparison is a separate publication
  responsibility from clinical safety assessment, so a legal-scope reviewer cannot approve a safety
  rule and no clinical role can approve a legal status. Without this, "two-person approval" is
  satisfiable by two people neither of whom can judge the content (DEC-032).
- **Not enough people.** A UNIQUE constraint over request and reviewer makes one person one vote,
  and the gate counts distinct reviewers rather than rows - counting rows is the obvious way to
  satisfy a two-person rule with one person.
- **Not a second pair of hands.** The requester may neither approve nor execute their own
  publication. This is `10`'s separation of duties arriving by the most ordinary route: the person
  who wrote it also signs it off.

**The scope half of exit criterion 2.** "Scoped to the intended jurisdiction" is where a
two-person rule quietly becomes a one-person rule. A request naming GB and NI can collect two
approvals and still have a jurisdiction nobody reviewed, so the gate requires **each** jurisdiction
to reach the count on its own. `10` requires Great Britain and Northern Ireland to be reviewed
separately where applicable; here that is a count of distinct approvers per element of the array,
and the refusal names which scope fell short. A safety rule has no jurisdiction column of its own -
it would otherwise run everywhere - so publication writes the approved scope onto the rule, and a
CHECK makes a published rule with no scope unrepresentable.

**Why the checks live in the database.** `14` says there must be "no direct database editing of
publication state as normal workflow". A rule enforced only in the API makes it not a _normal_
workflow; making it not a workflow at all takes triggers. So the approval count, the separation of
duties, the role mapping and the scope are all enforced in `0012` as well as in the domain, and the
database tests exercise them by direct SQL with no API in the picture. The sharpest test of the
whole design is in the API suite, though: two qualified reviewers approve a regulatory record, and
the Citation Gate refuses it anyway because the record has no source document. Two governance
layers, and satisfying one does not satisfy the other.

**The asymmetry that took thinking about.** The obvious design gives withdrawal the same
governance as the publication it reverses. That is wrong, and stating the failure modes side by
side is what showed it: a wrongly-published alert tells a real person to act on Kynviora's
authority, while a wrongly-withdrawn one removes information - the state the product is in for
everything it does not cover. `15`'s reviewer-compromise threat is about _creating_ false
publications. So withdrawal needs one reviewer, the requester may be that reviewer, the global
publication block does not stop it, and `10`'s ten-item checklist is not asked for. A ten-item form
in front of an emergency stop is a reason the emergency stop does not get used (DEC-031).

**The checklist.** `10` lists ten things a reviewer must verify before high-severity publication.
Encoding them mattered because two people clicking approve is not the same as two people doing
those ten checks, and only the second is what the governance model asks for. They are recorded
**per approval**, not per request: the point of a second reviewer is that they check
independently, and letting the first one's confirmations stand for both would make the second
signature ceremonial. The threshold is the same one that requires two people, so "high-impact"
means one thing in the module. A rejection carries no checklist - demanding a reviewer confirm ten
things about content they are turning down would be asking them to vouch for it.

### Things worth recording

- The first execution gate returned early when the row was already executed, so a second update to
  EXECUTED was silently allowed and would have overwritten who published it. "Publication is
  attributable" would have held only until somebody wrote to the row again. A decided request is
  now final, and any further write is refused.
- Four database tests were asserting the append-only trigger and getting "permission denied"
  instead: the service role holds no DELETE or UPDATE grant, so the missing GRANT refuses before
  the trigger runs. Both layers are right. The tests now assert each separately - the grant as the
  service role, the trigger as the table owner - which is a better test than either.
- Migration `0012` broke two pre-existing assertions in `db/regulatory.test.ts`, both by firing
  before the constraint the test was about. Fixed by giving those fixtures a valid approved scope
  so the constraint under test is the only thing wrong with the row. This is the same lesson as
  Phase 8.5's: a test pinned to one constraint out of several that all refuse the row is testing
  evaluation order.
- A `Record<K, readonly V[]>` annotation does not flow into a nested `Object.freeze([...])` - the
  inner call widens to `string[]` and the outer annotation then fails. Dropping the inner freeze
  restores the contextual type. The same thing bites a nested frozen object of functions, where
  the parameters become implicitly `any`.
- Postgres refuses a statement supplied more parameters than it references, so a shared parameter
  list across four differently-shaped target writes fails at bind time rather than at typecheck.
  Each write now builds its own list.

### What this phase does not do

It does not make anything publishable. `BLK-006` is unchanged: this builds the workflow a
qualified reviewer would use, and no qualified reviewer exists. There is also no console
interface - the API is complete and there is deliberately no mobile screen, because `0012` gives
the app role no grant on any of these tables and the household app is not where staff software
belongs (`DEV-016`). "Rule preview" is deferred to Phase 6.7, because a preview worth trusting is
a shadow run and a weaker one would give a reviewer a second, less accurate answer to the same
question (`DEV-017`).

### State at end of Phase 6.6

1812 tests passing across 45 files, up from 1696 across 42. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 116 new tests: 43 domain, 44 database, 29 API.

### Phase 6.7 - Shadow mode and replay

Two exit criteria, and the first one is the kind that a boolean satisfies on paper and loses in
practice.

**"New high-impact rules can be evaluated without user notification."** The tempting
implementation is a flag: run the rule, then check `shadowOnly` before dispatching. That holds
until the day somebody adds a second notification path, which is how every "we did not mean to
send that" incident happens. So a shadow run produces a value **nothing can notify from**:
`ShadowRun` carries counts, a per-reason breakdown and a bounded sample; `ShadowSample` is a
projection of an assessment with the profile removed; and the profile identities are counted and
discarded inside the same expression, so at no point does the run hold a list of people (DEC-034).

Underneath, the results are written to `shadow_run`, which is not `profile_assessment` - and
`alert_publication` requires a `profile_assessment`. The tables do not connect. A test queries
`information_schema` for `alert_publication`'s foreign keys and asserts neither shadow table is
among them, so the guarantee is checked against the real schema rather than against a diagram.

**The thing that nearly made the feature useless.** `evaluateRule` refuses an unapproved or
disabled rule, correctly - an unapproved rule producing a match is threat A3's unauthorized
publication path. But the rule a shadow run exists to measure is precisely one nobody has approved:
6.7 is what a reviewer looks at _before_ approving. The first working version reported zero matches
for every candidate, which is not a small bug - a blast radius of zero reads as "this rule affects
nobody", the same failure mode this codebase refuses elsewhere.

The fix is a projection local to `runShadow`, which satisfies the approval gate for that evaluation
only. It is defensible because it is unreachable except through a function that has already
refused a non-shadow rule, because nothing it produces can become user-visible, and because the
stand-in reviewer ID is the literal string `SHADOW_RUN_NOT_A_REVIEWER`. `enabled: true` is
included for a less obvious reason: a rule an operator has just killed under `10`'s emergency
controls is exactly the one somebody needs to measure while working out what it did (DEC-035).

**"Regulatory data corrections can recompute dependent product views and assessments
reproducibly."** `replayAll` re-evaluates recorded assessments against re-supplied inputs and
reports, per assessment, whether it reproduced and which fields moved. The API route pairs the
recorded `profile_assessment` rows with the _current_ state of everything they were computed from,
which is what a correction actually is. Two tests carry the criterion: replay with the world
unchanged reproduces everything, and withdrawing the recall notice produces a diff naming both
affected items and the field that moved. A replay writes nothing back - `profile_assessment` is
append-only and a test asserts the rows are untouched. It is a diff somebody reads, not an apply.

The replay passes each assessment's own `evaluatedAt` back as the evaluation instant. Without
that, every expiry assessment would "change" on replay and a correction diff would be unreadable.

**What a historical run refuses to measure.** The historical dataset is assembled from the shelf,
and that join does not carry the confirmed ingredient declaration. So `INGREDIENT_SENSITIVITY` and
`DUPLICATE_ACTIVE_INGREDIENT` are refused rather than run: reporting fewer matches than the rule
would really produce is worse than reporting nothing, because a reviewer confirming
`EXPECTED_MATCH_VOLUME` against an under-count would be confirming something false (`DEV-018`).
Both kinds run normally against a synthetic dataset, where the caller supplies the substance keys
and nothing is being inferred from data the server does not have.

**Closing the loop with the reviewer console.** `DEV-017` recorded that Phase 6.6's checklist had
a reviewer confirm expected matched-user volume with nothing producing the number. Migration `0013`
adds `publication_request.shadow_run_id` and a trigger requiring it for any two-person safety-rule
publication - and requiring the run to be a run of _that_ rule, because attaching somebody else's
is the obvious way to satisfy such a requirement without meeting it (DEC-036). Publishing a
high-impact rule is now shadow run, then request, then two approvals.

**No verdict, anywhere.** There is deliberately no `recommendPublication`, no threshold and no
score. `22` requires release thresholds to be set by leadership against a labelled dataset and
`BLK-008` records that none exists; a function returning "safe to publish" would invent the
threshold that document says nobody has set, and a reviewer would read it as an answer. Tests
assert the absence over the run's own keys and over the API response body.

### Things worth recording

- `shadow_run_sample.match_confidence` first carried the `ItemVerification` vocabulary instead of
  `MatchConfidence`. Both contain `PROBABLE`, which is exactly why the fixture passed and the
  mistake survived to a second reading. It would have refused every real sample. There is now a
  test that inserts `CONFIRMED` - valid in the other vocabulary - and requires the constraint to
  refuse it.
- Postgres refuses a statement given more bind parameters than it references, so the four
  differently-shaped target writes in the reviewer console could not share one parameter list.
  Each builds its own.
- The catalog columns are `product_identity.gtin` and `batch_or_lot.lot_code_normalized`; there is
  no `primary_gtin` and no `verification` on either. Worth checking the migration rather than
  guessing from the domain type names.

### State at end of Phase 6.7

1881 tests passing across 48 files, up from 1812 across 45. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 69 new tests: 28 safety domain, 24 database,
17 API.

Stage 6 is now complete apart from 6.3 and 6.5, both of which are `IN_PROGRESS` on external
dependencies. Outstanding on this phase: a historical run cannot measure substance-matching rules
(`DEV-018`), and there is still no staff interface for any of it (`DEV-016`).

### Making it runnable

Not a spec phase. It closes the gap between "implemented" and "openable", which had grown wide
enough that the honest answer to "can I see it work" was no.

**What was actually missing.** `services/api/package.json` pointed `dev` at `src/main.ts` and that
file did not exist. There was no migration runner outside the test harness. Nothing produced a
`Principal`, so no route could be exercised by hand. Fifty test files proved the authorization
rules held and none of them proved the process could start.

**The database.** `BLK-001` says there is no managed Postgres and no Docker here, and that had
been read as "nothing can run until somebody provisions one". It does not have to be: PGlite -
already the migration and RLS engine under DEC-004 - persists to a directory, and it is genuine
PostgreSQL 18.3 rather than a mock. So `createRuntimeDb` opens a directory, applies migrations, and
hands out role-scoped connections with the same discipline the test harness uses, superuser guard
included. No service to provision, no connection string (DEC-037). `RuntimeDb` is the seam a pooled
implementation lands behind when `BLK-001` clears.

**The authenticator.** Phase 1.1 is unstarted because the provider is an unmade product decision,
and deciding it to unblock local development would be the wrong order. So there is a development
authenticator that turns a header into an ordinary principal, and the reason a backdoor is
acceptable is that it fails closed three independent ways, each tested: it needs
`KYNVIORA_DEV_AUTH=1` exactly, it **throws** under `NODE_ENV=production` rather than warning, and
with no header it returns `null`. It grants no reviewer role - a header is a client claim and `14`
says staff roles are never inferred from one - so the seeded owner gets 404 from the reviewer
queue, which is asserted (DEC-038).

The server also refuses to start when no authenticator is configured. A server that authenticates
nobody fails in a way that looks like a bug in every route, and one explicit error at startup is
worth more than fifty confusing 401s.

**Three bugs, all found by running it.**

- The entry-point check was `import.meta.url.endsWith(process.argv[1])`. On Windows the URL is
  percent-encoded and the argv path is not, so it never matched: the process started, did nothing,
  and exited zero. Now compared as resolved filesystem paths.
- `StartedServer.url` was built from the _requested_ port. With `port: 0` - how a test starts
  several servers at once - that produced `http://127.0.0.1:0` and a connect error naming neither
  the cause nor the port. Now read from `app.server.address()`.
- The seed was a standalone script, and PGlite is a single writer. Running it against the same
  directory as a live server does not share state, and whichever process exits last overwrites the
  other. It reported success against a database that stayed empty. Seeding now happens inside the
  API process on the connection it already holds, so the race is not reintroducible by running two
  commands in the wrong order.

**What the seed deliberately does not contain.** No safety rule, no regulatory record, no alert.
Publishing any of those needs a qualified reviewer (`BLK-006`) and retrieved official documents
(`BLK-004`), so the Safety and Regulatory Lens screens are empty against it - and a test asserts
they are. Seeding content to make those screens look populated would put exactly the material in
front of a developer that Phases 6.6 and 6.7 exist to keep out. Every product name begins with
"Synthetic".

**What the process test buys.** Every other suite injects a pool into `createServer`, which proves
the routes and proves nothing about the wiring beneath them. `main.test.ts` boots real processes on
real ports and asks the four questions a developer asks first: does it start, does it refuse me
when I am nobody, does it show me my own shelf, and does it show me somebody else's. The last one
is the one worth a process test - role switching, the request GUC and the RLS policies are all
doing their real jobs, and a mistake in the wiring between them would pass every other test in the
repository. A stranger gets 200 with an empty list, which is Phase 8.1's exit criterion in terms:
"an empty page - not a 403".

### Things worth recording

- Lint caught two `new Date()` calls in `main.ts`. The composition root felt like a legitimate
  exception; it is not, because `systemClock()` already exists as the single sanctioned source of
  ambient time. Opening a second one in the one file nobody injects into is how the rule starts
  eroding. The logger now takes the clock too.
- Migration loading moved from `db/harness/harness.ts` to `db/src/migrations.ts`, re-exported so
  every existing test import still works. The runtime needed it and importing it from a file called
  "harness" would have been misleading about what runs in production.

### State

1902 tests passing across 50 files, up from 1881 across 48. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 21 new tests: 12 for the development authenticator,
9 for the process.

`npm run dev` now starts a server against a persisted PostgreSQL with a synthetic household in it.
The remaining gap between that and holding the app on a phone is `DEV-007` - the Expo screens are
still placeholders - and `BLK-002`, which needs an Android SDK on a real machine.

### DEV-007 - wiring the Expo screens to the API

Every feature phase since Stage 7 left a screen that typechecked against the presentation package
and was connected to nothing. The API contract and the presentation layer both existed and were
tested; what did not exist was anything joining them, and the join is where the interesting
mistakes were waiting.

**The shape.** A new `@kynviora/contracts` package - which had existed as a `package.json` and an
empty directory since Stage 0 - now holds the configuration, the session, the transport, the typed
client, the outcome union and the view models. The Expo app holds a provider, a hook and the
components. The split is not tidiness: `apps/**` is excluded from the test run and there is no
renderer here (`BLK-002`), so anything decided inside a component is decided where nothing can
check it. Moving the decisions into a package put them under test; `DEV-021` records what that
does and does not buy.

**The decision this phase existed to get right.** The API answers `PERMISSION_DENIED` with 404 so
it is not an existence oracle. That is worth nothing if the client reads the code out of the body
and renders "you do not have permission" - which is the obvious thing to write, and which hands
back on the screen precisely the fact the status code was chosen to withhold. So the outcome union
has no member meaning refusal, `UNAVAILABLE` carries only its `kind`, and `EMPTY` and `UNAVAILABLE`
share their tone, their retry label and their content flag. Tests enumerate the union and assert
no member matches `/DENIED|FORBIDDEN|REFUSED/`, and the integration suite asks a stranger for a
real profile and for an invented one and compares the two resources (DEC-039).

**Two states that were one.** The mobile `offline` copy read "This shows what Kynviora last saved
on this device". There is no cache behind these screens, so on an offline first load that sentence
described data the user was not looking at. `OFFLINE` now means the check did not happen and there
is nothing on screen; `STALE` means something older is on screen and could not be refreshed.
Neither names where content came from, because the answer differs between a failed refetch and a
future local store and the reader does not need to know (DEC-041).

**What an unrecognised value means.** Seven vocabularies are narrowed out of responses and each
needed an answer for a value this client does not know. All of them fall back to the member that
asserts least - `UNVERIFIED` not `CONFIRMED`, `REVOKED` not `ACTIVE` - except urgency, which falls
back to `INFORMATIONAL` rather than to something louder, because "act now" raised by a parse
failure is a false alarm with a medicine's name on it. A review task kind and a caregiver
capability have no safe fallback at all, since the presentation layer holds one description per
member and no default, so those rows are dropped and counted (DEC-040).

**A bug found by running it.** `npm run dev` runs with `services/api` as its working directory and
`npm run migrate` runs with `db`, and `KYNVIORA_LOCAL_DB_DIR` defaulted to a relative path - so the
two commands opened different databases. PGlite is a single writer, so the second is not a second
connection, it is a separate empty database: migrating and then starting the server would have
shown an empty shelf and read as data loss. The same class of failure as the standalone seed
DEC-037 records, arriving by a different route. `resolveDataDir` now anchors at the workspace root
(DEC-042).

**Dogfooding it.** The shipped client was driven against a live `npm run dev` server rather than
only against a test fixture. The owner sees three items with three separate verification
statements; a stranger sees `EMPTY` with the same words as a genuinely empty shelf; an anonymous
caller sees `UNAUTHENTICATED`; Safety is `EMPTY` with its coverage sentence; an unreachable server
produces `OFFLINE`. That is the first time the whole path has been observed working rather than
asserted.

### Things worth recording

- The screen-state union and its copy moved from the React component into
  `@kynviora/presentation`. They were the one family of user-visible strings in the codebase that
  no scan looked at, because `apps/**` is excluded. They now pass `findForbiddenClaims` and a
  shaming-language check like every other string.
- The client refuses a development identity header to any non-loopback origin, mirroring
  `devAuth.ts` refusing under `NODE_ENV=production`. One side refusing is a control; both sides
  refusing is a boundary.
- `buildUrl` refuses a query parameter whose name looks like a credential, which makes trap 11 a
  runtime failure rather than a code review somebody has to remember.
- Trap 13 caught one more file. Writing `\\b` inside a heredoc collapsed to `\b`, which Python
  then wrote as a real backspace character - so a regex that should have had word boundaries had
  control characters instead, and the test passed for the wrong reason. Found by noticing the
  escape was missing from the file while the assertion still passed. Rebuilt with `chr(92)` and
  re-scanned the repository.

### State

2028 tests passing across 59 files, up from 1902 across 50. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 126 new tests: 14 for the screen states, 94 for the
contracts package (configuration, transport, outcomes, resources, client surface, view models),
14 for the client against a real server process, and 4 for the data directory.

`DEV-007` is not closed. Five destinations read real data; two things write. The invitation,
revocation, task-completion, Visit Pack and reconciliation flows each need a screen of their own,
and `DEV-022` records why each is a screen rather than a button.

### The review task editor - the first write flow

The first of the five `DEV-007` write flows, and the one worth doing first: it closes Phase 8.3's
loop. A review task is completed by writing to the record it is about, and until now nothing in the
app could do that - the Today screen listed tasks and its start handler was a comment.

**Where the form lives.** `COMPLETABLE_FIELDS` in the domain already says which fields each kind
may write. What it does not have is words: a label, a reason for asking, and what kind of control
to draw. Those went in `@kynviora/presentation` keyed by the same column names, with a test that
the two key sets are equal in both directions - a field added to a kind in the domain would
otherwise become a task nobody can complete, and one removed a control that always errors, both
silently (DEC-043). The payload builder went in `@kynviora/contracts`, and the same function that
builds it decides whether the button is enabled, so the control cannot say yes to something the
builder would refuse.

**Two bugs, both found by running the completion end to end.**

The first: the editor offered `batch_id` as a text box labelled "Batch or lot number". It is a
`uuid` referencing `batch_or_lot`, the API casts it with `::uuid`, and a printed lot code is not
one. The fix is not a better input - it is that finding or creating a batch record is guided
capture's job, with the provenance and corroboration that come with it. Accepting a typed string
would put a catalog record into the database with none of that on the way to closing a maintenance
task. So `REFERENCE` is now an input kind the editor does not render, and the two kinds whose
primary field is one show what they need instead of a form (DEC-044, `DEV-024`). Completing them by
writing only the paired `*_verification` field was the tempting alternative and is worse: it closes
a task called _add the batch number_ without one.

The second is the more serious. Completing a task succeeded, and the **next read of the shelf
returned 500**. The driver returns `timestamptz` as a `Date`; `13` validates the response before
serialisation; `shelfItemSchema` requires a string. Every fixture in the repository had
`last_reviewed_at` null, so nothing had ever read a shelf after a write - and Fastify would have
serialised the `Date` to the same ISO string, so it looks like a no-op until you notice the
validation runs first. Any user who had ever reviewed an item would have had a broken Shelf screen.
Fixed with `isoOrNull`, and the row type now says `Date | string | null` rather than claiming a
string it does not get, because claiming it is what hid this.

**A seed change that is a dogfooding fix.** The derivation only produced `BATCH_MISSING` against
the seed, because every seeded item was created moments earlier and none had been reviewed - so a
developer opening Today saw exclusively work the app cannot yet do, and would reasonably conclude
the screen was broken. One item is now seeded two hundred days old, past
`ITEM_REVIEW_INTERVAL_DAYS`, which is ordinary synthetic household data and makes the completion
path reachable by hand. The seed now takes the clock rather than leaving `created_at` to
`DEFAULT now()`, which is what DEC-024 asks for anyway.

**What is deliberately not there.** No "Done" button and no way to reach one. No `NOT_APPLICABLE`
outcome, because what it should record differs per kind and most kinds have no field that expresses
it - inventing one would be inventing a medical-record semantic (`DEV-023`). The safety-receipt
resolution offers it as a value, which is where the vocabulary already had the word.

### Things worth recording

- The editor's `required` flag started out meaning "this field must be filled in" and was wrong:
  several kinds offer alternatives rather than a set, and correcting any one of the four label
  fields completes an unresolved-extraction task. It refused completions the server would have
  accepted. Renamed to `primary`, meaning the field the form leads with and names when nothing has
  been entered at all.
- The safety resolution choices are asserted against the `receipt_resolution_valid` constraint, and
  a separate test asserts none of them means stopping a medicine. `09` forbids Kynviora from
  recording that it said so, and the absence of the word is what enforces it.

### State

2062 tests passing across 61 files, up from 2028 across 59. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 34 new tests: 15 for the form definitions, 16 for
the payload builder, and 3 end to end against a real server process.

Four `DEV-007` write flows remain: the caregiver invitation, the step-up prompt, the Visit Pack
selection, and the reconciliation difference resolution.

### The caregiver invitation - the second write flow

The `DEV-007` flow with a real security shape. Handing out a bearer credential is the most
consequential thing this app does, and three separate rules meet on one screen: step-up (`14`),
the delegation limit (DEC-020), and a token emitted exactly once and unrecoverable afterwards
(DEC-018).

**Three steps, in that order.** Choose, confirm, then the link. Choosing and confirming are
separate because `18` requires a screen to say what it is about to do before doing it, and the
review step renders `summarizeAccess` in full - including `notIncluded`, because someone reading
only what was granted will not notice what was withheld. The link comes last because it does not
exist until the request succeeds.

**What happens to the token.** Nothing. It is held in component state, rendered by a selectable
`Text`, and dropped when the screen closes. Not stored, not logged, not put in a URL, not passed to
a share sheet or a clipboard helper, and not touched by any code between the response and the
screen - which is the shortest way to keep a live credential out of a log. `buildUrl` refuses a
query parameter whose name looks like a credential, so trap 11 is a runtime failure rather than a
review someone has to remember, and a test asserts the invitation module's own source contains no
mention of a token at all.

**The screen offers only what can be delegated.** Not everything-with-some-disabled: a greyed-out
"manage caregivers" box tells a caregiver the capability exists and that they are not trusted with
it, on a screen about their family (DEC-045). The server decides again on the request; this only
keeps the screen from offering a control whose sole outcome is `CAPABILITY_ESCALATION`.

**Step-up is scoped to one request.** `elevate()` builds an elevated client at the moment of
sending; every other request on the screen uses the ordinary one, so the privileged session never
outlives the action. It asserts rather than proves, because Phase 1.1 has not chosen a provider -
`DEV-025` records that the shape is what is permanent here, and that the server checks freshness
independently either way.

**A gap that would have produced a second credential.** After sending an invitation the Care screen
showed nothing new, because `GET /v1/caregiver-grants` returns grants and a grant does not exist
until acceptance. An owner seeing no change reasonably sends a second invitation - which mints a
second live credential for one intent, exactly what the idempotency key on the create route exists
to prevent, defeated by the screen rather than by the protocol. `GET /v1/caregiver-invitations`
now returns outstanding invitations and the screen renders both lists as one (DEC-046).

The route needed no new authorization: `caregiver_invitation_select` already admits the owner, an
administering caregiver and the account that accepted, and deliberately not the intended recipient
before acceptance. The app role's column-level `GRANT` omits `token_hash` entirely, so the query
could not have selected it even if it had tried. The response says `boundToAddress` rather than the
address itself - `14` treats an address as personal data and this list is read on a screen someone
else may be looking at.

**A wrong inference, removed.** The invite screen gated on ownership by reading `isManaged`, which
is a different fact: it describes the person the profile is for, not who administers it, and an
owner may perfectly well own a managed profile. `GET /v1/profiles` now says `isOwner` outright
(DEC-047). It discloses nothing - a caller who owns a profile already knows - and it makes the
wrong inference unavailable rather than merely discouraged.

### Things worth recording

- A caregiver is currently offered nothing to delegate, because the grants listing does not
  identify which grant is the caller's own and reading identity out of a development session to
  make an authorization decision is the shape of mistake `13` exists to prevent. The rule is
  implemented and tested; only the input is missing (`DEV-026`). The failure is in the safe
  direction and it is visible.
- The Care screen makes two requests and combines them into one resource. When the invitations
  call fails and the grants call succeeds the result is `PARTIAL`, which says the list is
  incomplete rather than showing a shorter one as though it were the whole answer.

### State

2087 tests passing across 62 files, up from 2062 across 61. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 25 new tests: 15 for the invitation draft, 5 for the
merged access list, and 5 end to end against a real server process.

Two `DEV-007` write flows remain: the Visit Pack selection and the reconciliation difference
resolution. Revocation still has no screen.

### The Visit Pack - the third write flow

The flow whose exit criterion is a property of the request rather than of the screen. DEC-023 says
generation quotes the digest of the content the user reviewed and is refused if recomputing it from
live records differs, and that is what makes "a user can review exactly what will be shared" a fact
about the system instead of a promise about the client.

**So the client hashes what it displayed.** The candidates are fetched once and everything
downstream works from that list. Re-fetching before hashing would quote a digest of content the
user never saw and would silently disarm the refusal that makes the promise real - the request
would succeed and the guarantee would be gone, with nothing failing to say so.

`canonicalizeSelection` is imported from the domain unchanged. Only the hashing is a port, because
SHA-256 is asynchronous on every platform and comes from a different module on each.

**One duplication had to go first.** The note entries were built inline inside
`evaluateGeneration`, with the caveat as a string literal. The digest covers the notes too, so a
client spelling that caveat differently would compute a digest the server refuses - and the user
would be told their records had changed when nothing had. `toNoteEntries` and `USER_NOTE_CAVEAT`
are now exported and used by both sides (DEC-048).

**An entry this client cannot canonicalise is refused rather than coerced.** The canonical form
includes the section, the entity kind and the caveat verbatim, so a substituted default produces a
mismatched digest - and `EXPORT_CONTENT_CHANGED` would start reporting "your records moved" when
the truth is "this app is older than the server". The draft is refused with a message that says to
update the app.

**A bug found by running it.** `createVisitPack` on the client sent no idempotency key, and the
route requires one - so every generation attempt failed with `VALIDATION_FAILED` before the digest
was ever compared. It was invisible until an end-to-end test posted a real request. The key is now
a parameter, for the same reason it is on an invitation: regenerated on retry it produces a second
export of the same content, each with its own retrieval URL and its own expiry.

**The one refusal here that is not a mistake.** `EXPORT_CONTENT_CHANGED` means the records
genuinely moved between review and generation. The screen reloads and returns the user to the
selection rather than offering a retry, because retrying sends the same stale digest and a person
pressing "try again" three times deserves better than three identical refusals.

### Things worth recording

- The end-to-end test is the only place that could prove the two digests agree. A unit test on
  either side proves each computes _something_ consistently; only a live server rebuilding the
  selection from its own records proves they compute the _same_ thing. It caught the missing
  idempotency key on the way.
- The flow lives on Today. `06` Journey 8 has no destination of its own, and Today's introduction
  has always said "due medicines, appointments and anything that needs review" - an appointment
  summary belongs where the appointment does.

### State

2104 tests passing across 63 files, up from 2087 across 62. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 17 new tests: 13 for the pack builder and 4 end to
end against a real server process.

One `DEV-007` write flow remains - the reconciliation difference resolution - plus revocation,
which now has the step-up seam it needs.

### Reconciliation - the last write flow

Three steps: type in the list somebody handed you, see the differences, settle each one. The list
is typed because Kynviora has no other source for it - a discharge summary is a piece of paper -
and nothing on this path trims, normalises or sentence-cases what was entered. `04` Phase 4.1
forbids rewriting a prescription instruction, and "tidying" a direction is rewriting it.

**Settling a difference turned out to be two questions.** The existing review component offered the
six options and called back with one, which is half an answer: `evaluateResolution` refuses a
settling resolution that names no side, so every one of those callbacks would have produced a
server error. The obvious fix - infer the side, defaulting a confirmation to the newer list - is
precisely the judgement Phase 8.5 forbids. A pharmacist may confirm the older dose, and the
option's own `fixedSide` is `null` for all three confirmations because the answer is not knowable
from the choice. So there is a second step that asks, and every settling resolution goes through it
(DEC-049).

The prompt renders both values through `presentSide` from one style object. Neither is pre-selected
and neither is styled as primary: two styles that happen to match today are two styles that can
drift apart tomorrow, and the drift is the exit criterion.

**A shape mismatch found by running it.** `POST /v1/reconciliations` returns only the ID - the
differences are read back separately, because the derivation is the server's and the caller must
see what it actually produced rather than a copy assembled on the way out. The client had typed the
response as the full record, which typechecked and failed at runtime the first time an end-to-end
test read `differences[0]`.

**Nothing is applied locally.** The server records the resolution and writes the one medicine change
through row-level security, so the reconciliation cannot change what the caller could not have
changed on the medicine screen itself. The list is re-read afterwards rather than patched: what
happened is the server's answer, not the client's guess.

### `DEV-007` after five units

Five primary destinations read real data, and four write flows are wired end to end - completing a
review task, inviting a caregiver, generating a Visit Pack, and resolving a reconciliation
difference. Each is exercised against a real server process, and each of those tests found
something no unit test on either side could have: a 500 on the shelf after any review, a missing
idempotency key that made every Visit Pack fail before its digest was compared, a Care screen that
showed nothing after an invitation, and this response-shape mismatch.

Revocation remains, and it now has the step-up seam the invitation flow introduced.

### State

2123 tests passing across 64 files, up from 2104 across 63. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 19 new tests: 15 for the resolution builder and 4
end to end against a real server process.

### A reconciliation that compares nothing

Found by driving the whole app against a live server after the flow was committed. Every difference
came back as `ONLY_IN_PREVIOUS` or `ONLY_IN_CURRENT` and never as `FIELD_DIFFERS` - so the feature
ran, passed its tests, and reported only that the two lists were different, which is the one thing
the person already knew.

The cause is the match key. The shelf side of the comparison keys on the item's own ID, and the
screen was sending a positional `typed:0`, so nothing could ever correspond. The API's own comment
says what was intended - "the caller can name exactly which one a current line corresponds to" -
and the screen simply never asked.

So each typed row now offers the medicines already on the shelf and a "this one is new to me"
option. Never guessed from the name: two packs of the same medicine at different strengths are two
real records, and matching them by text would be Kynviora deciding which one the person meant. An
unmatched line is a real answer rather than an omission.

`medicationLine` holds the key rule and is tested, including that an unmatched key cannot take the
shape of a real item ID, and the end-to-end test now asserts that a matched line with a different
strength produces a field difference carrying both values and nothing naming a preferred one.

Worth recording as a kind of failure rather than a bug: nothing was broken. Every layer did what it
was asked, the tests passed, and the feature was useless. Only running it end to end and reading
the output showed that.

2129 tests across 64 files, verify exit 0.

### Removing access - the last caregiver action without a screen

The server side had been finished since Phase 8.1: both revoke routes exist, both are behind
step-up, both write audit events, and both are idempotent. What was missing was everything between
the button and the request - and one thing nobody had noticed on either side of it.

**The client was undoing A2.** `useResource` kept the previous content on screen for _any_ failed
refresh and labelled it `STALE`. Revocation is the case that makes that wrong: `15` A2 requires a
removed caregiver to lose access on their very next authenticated access, the server does exactly
that, and the app carried on showing them the medicine list under a caption saying it was not up to
date. The rule is not "did the request fail" but "did the server say something about this caller's
access" - `OFFLINE` and `SERVER_ERROR` did not, everything else did (DEC-050). It went in as its
own commit, because it is a security fix rather than part of a feature.

Worth recording that this was found by _designing_ the next feature rather than by testing the last
one. Nothing was failing.

**A row that could not say which record it was.** The Care screen shows grants and outstanding
invitations together, on purpose - they answer one question. They are two records with two routes,
and `onRevoke(id)` carried only an ID. The wrong route answers 404, the client correctly renders a
404 as absence, and the whole failure would have presented as the row quietly disappearing (DEC-051,
trap 47). `subject` now travels on the row and `buildRevocation` reads it.

**Two people, two sentences.** An administering caregiver sees their own grant beside the ones they
administer, and "they will stop seeing this profile" put in front of someone removing their own
access is not a wording problem - it is a statement about a different person. The alternative to
asking the server was comparing the grantee against an identity read back out of the session, which
in development is a header. `isSelf` now comes from the API for the same reason `isOwner` does
(DEC-052), and it is also the field `DEV-026` had named as its own required future work.

**Two dogfooding findings.** Driving the flow against a live server showed the removal audit event
recording `capability_count: 0` and an empty capability list, because the route passed `[]` rather
than reading the grant's own. On the history screen that reads as "a grant with no capabilities was
removed" rather than as "nobody wrote them down" - and it is the one entry an owner has nothing
else to check against. The route now selects `capabilities` for the audit record.

The second came from an end-to-end test asserting the message the screen would show. The route
writes "This invitation was accepted. Revoke the caregiver access instead," and `errors.ts` replaces
it on the wire with the client-safe message for `INVITATION_ALREADY_RESOLVED` - which is shared with
the acceptance path and says only that the invitation has been used. True, and a dead end for the
owner. Making the wire message specific would change what a stranger holding a link learns, so the
wording is supplied on the screen for that one code and nowhere else (DEC-054).

**What the confirmation says, and what it does not.** What stops, when, and what starting again
would take - the third being the surprise, because the invitation token was stored only as a hash
and cannot be reissued (DEC-018), so restoring access means sending a new invitation and having it
accepted. The tone is deliberately not a warning: `15` wants removing access to be easy, and copy
that treats it as dangerous discourages the thing the threat model relies on. That is the same
reason `CAREGIVER_ACCESS_PRESENTATION.REVOKED` is neutral.

**The access history is part of the flow, not a separate feature.** After a removal the list is
exactly one row shorter, which is the least informative possible confirmation: the row the owner
was looking at is gone and nothing says it was them. `03` group H requires audit event visibility,
and `GET /v1/profiles/:profileId/caregiver-audit` had existed since Phase 8.1 with no client method
and no screen. It reads alongside the list; a caller with no administrative authority gets a 404,
which drops the section rather than failing the screen.

### State

2185 tests passing across 65 files, up from 2129 across 64. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 56 new tests: 7 for the refresh-retention rule, 15
for the revocation builder and its wording, 5 for the access history view, 6 on the removal copy,
8 on the client surface, 1 on the API, and 14 end to end against a real server process - including
that the withdrawn invitation's token stops working, that a repeat reports `alreadyRevoked` rather
than an error, that a stranger cannot tell a real grant from an invented one, and that a caregiver
can renounce their own access holding no administrative capability at all.

### Giving the delegation rule its input - `DEV-026` closed

The rule had been right since Phase 8.1 and had never been handed anything. `selectableCapabilities`
implements "a caregiver may offer only what they hold, and never caregiver administration" exactly,
with its own tests, and the Care screen passed `ownCapabilities: []` to it - so every non-owner was
offered nothing and could invite nobody. The blocker was named in the deviation itself: picking the
caller's own grant out of a listing that includes other people's meant matching on a user ID the
client should not be reasoning about.

`isSelf` (DEC-052) removed that, so this is one function and its wiring. `heldCapabilities` unions
the capabilities across the caller's own active grants, which is what `kynviora.has_capability` does
in SQL - and the reason a merge of two grants for one pair is refused by a unique index rather than
tidied up (trap 10).

**An expired grant contributes nothing even where its status still says `ACTIVE`.** The two are
separate columns and `has_capability` checks both, so a stored status is not on its own evidence
that a grant still carries anything. The comparison uses the `serverTime` from the response the
grants arrived in, not the device clock. DEC-024 does not apply here - that rule is about an
authorization predicate, and this is a screen deciding which checkbox to draw.

**The control itself, not only its contents.** A caregiver who may delegate nothing was still shown
"Invite someone", and the only reachable outcome was a 404 after they had filled in a form.
`mayInvite` withholds the control instead, which is DEC-045's reasoning one level up: a greyed-out
control states that the action exists and that this person is not trusted with it. Two conditions
rather than one, on purpose - a caregiver holding only `MANAGE_CAREGIVERS` passes the server's
authority check and still has nothing to offer, because DEC-020 forbids them delegating caregiver
administration itself.

**None of it is the boundary.** `canDelegateCapabilities` runs server-side on every request. An
end-to-end test bypasses the screen entirely and confirms `CAPABILITY_ESCALATION` for a capability
the caregiver does not hold, and `UNAVAILABLE` for a caregiver with no administrative authority at
all - which is what makes withholding a control honest rather than merely tidy.

### State

2203 tests passing across 65 files, up from 2185. Typecheck, mobile typecheck, lint and format all
clean via `npm run verify`, exit 0. 18 new tests: 13 on the derivation and the control, and 5 end to
end against a real server process - including a caregiver actually sending an invitation, which was
unreachable before this.

### Phase 4.3 - recording what happened, without keeping score

The write route had existed since Phase 4.1 and nothing called it. What Phase 4.3 needed was the
other three quarters: a way to read the record back, the words, and a screen.

**The interesting decision is a number that is not there.** The obvious read side of a dose record
is a summary - taken 12, skipped 3, 80% this month - and Phase 4.3's goal sentence rules it out:
"without gamifying or judging them". Someone who skipped a dose because it made them ill has
recorded a decision about their own treatment, and a number telling them how often they do that has
told them the decision was wrong. That is medical advice arrived at by arithmetic, attributed to
nobody (DEC-057).

So `GET /v1/dose-events` returns events and no totals, `doseHistory` returns lines and one number -
how many events this build could not name - and three tests enumerate the response's keys, the
view's keys and the module's exported function names. The absence is enforced at the route as well
as the screen for the same reason urgency is kept off a review task at every layer: a `takenCount`
on the response hands a screen everything it needs, and the screen is where nobody would notice it
had appeared.

**Four controls of equal weight.** "I took it" is the common case and the natural primary action,
which is exactly why it is not styled as one: an emphasised button is a preference about somebody's
treatment. Every recorded kind carries the same neutral tone for the same reason - a red chip on
`SKIPPED` beside a green one on `TAKEN` is a scorecard drawn in colour. With one shared tone the
icon has to carry the distinction, so the four shapes must differ and a test asserts it (DEC-058).

**Praise is the other half of shame.** The copy scan rejects "well done" and "keep it up" alongside
the reproaches. The screen that congratulates you on Monday is the one with an opinion on Tuesday.
It also rejects "missed": `SKIPPED` and `UNABLE_TO_TAKE` are different facts, and the word that
covers both is the one the notification vocabulary uses for a schedule that lapsed with nothing
recorded at all.

**The exit criterion that needed a real server.** "Duplicate sync does not create duplicate dose
events" is a claim about what the database holds after the same intent arrives twice, and no unit
test on either side can make it. Driving it live: the second POST with the same key returns 200
with `replayed: true` and the same row ID, and the history is one line longer, not two.

**A trap caught itself.** Writing the copy test through a heredoc turned `\uXXXX` into a real
backspace character in the source - trap 13, arriving exactly as recorded. Repaired with
`chr(92)`, and a scan of every `.ts` and `.tsx` in the tree confirms no other control character
survives anywhere.

**Where it lives.** The Shelf, on the medicine's own row. Phase 4.2's reminders need a device
(`BLK-002`) so there is no schedule strip to hang it off, and an item's row is where a person
looking for "the one I take in the morning" already is. Medicines only: a dose is a medicine's idea,
and the control is absent rather than disabled on a personal-care product.

### State

2239 tests passing across 67 files, up from 2203 across 65. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 36 new tests: 14 on the copy, 14 on the builder and
the history view, and 8 end to end against a real server process.
