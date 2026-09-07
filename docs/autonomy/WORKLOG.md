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

### Observability projections - the numbers, and nothing beside them

`20` asks for two things that pull in opposite directions: enough signal to run the system, and
operator output that carries no medicine name, no diagnosis and no subject. The way to have both is
for the type to have nowhere to put the second.

A `MetricReading` is a key from a closed vocabulary, a number, and a unit. A projection that wanted
to report _which_ profile holds the oldest review task could not express it, which means the
reviewer who would have caught that in code review does not have to be there (DEC-059). The route's
test walks a real response and asserts that no profile, user, item or household ID appears anywhere
in it - a real assertion, because the fixture has all four.

**The harder discipline is the verdict that is not there.** `20` lists the alerting conditions and
then says "exact thresholds must be documented before production". None are, and `BLK-008` records
that no labelled dataset exists to set them against. So there is no `status`, no `severity`, no
`degraded`, and no threshold breach anywhere - the same reasoning trap 29 applies to a shadow run,
because an operator reads a verdict as an answer (DEC-060).

**One comparison survives that rule, and it is worth naming why.** A source is overdue when the
time since its last successful check exceeds `expected_refresh_interval_ms` - the cadence that
source itself declares on its registry row, approved when it was registered. That is arithmetic
against an existing decision rather than a new one. `overdueByMs` is reported; "critically stale" is
not. And "never successfully checked" is a separate field rather than an infinite overdue, because
folding it in would hide the worst case inside the best-looking number.

**Two queues that are not one queue.** `reviewer_queue_*` counts publication requests and
`review_tasks_*` counts the household inbox. Different queues, different owners, and only the first
is staff workload - reporting either as the other makes an SLA meaningless. It also means
`DEV-013`'s queue-age metric now exists for the reviewer queue, which has a real scheduler-shaped
lifecycle, while the household inbox age is reported as what it is: a derived-on-read number.

**Who may read it.** Any ACTIVE reviewer, not one role. Least privilege points the other way and is
wrong here for a specific reason: `20` calls source freshness a safety metric, and a clinical safety
lead deciding whether a published rule should stay published needs to know the source behind it has
gone quiet. The snapshot contains no user content, so the usual reason to narrow a staff read does
not apply, and narrowing it would keep a safety signal from the people whose job is to act on one
(DEC-061). Everything else holds: the role is a stored row, a suspended reviewer is refused, and the
refusal is a 404.

Confirmed by hand against a live server: an ordinary authenticated user gets the bare not-found, and
an unauthenticated one gets a 401. The development seed grants no reviewer role, so there is no way
to see a snapshot through the dev authenticator at all - which is DEC-038 working rather than a gap.

### State

2270 tests passing across 69 files, up from 2239 across 67. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 31 new tests: 20 on the projection and 11 on the
route against a real PostgreSQL engine, including the three source-freshness cases and the four
ways the staff boundary can be approached.

### Phase 7.1 - the Safety Watch inbox, and the row that was not there

The five product states had existed in the vocabulary since Stage 0 and had been presented since
the presentation layer was written. Nothing computed them. The Safety screen listed published
alerts, which meant an item with no alert did not appear at all - and a person reading that screen
could not tell "checked, nothing matched" from "never checked".

That is `23` D-014 arriving by omission. It is the quietest possible version of the failure, because
there is no wrong label for anybody to review: the screen is simply empty, and an empty safety
screen reads as good news. Fixing it by giving every item a line and calling the unassessed ones
"nothing matched" would have replaced a quiet claim with a loud one, so an item nobody has checked
is `INSUFFICIENT_DATA` - which claims only that Kynviora cannot check it yet, and whose shipped
description already said exactly that (DEC-062).

**The rest of the derivation is `09` read literally**, and it is worth saying that the spec had
already made every one of these decisions: "action required - approved action wording based on
urgency", "review - user should confirm item/context or discuss appropriately", "information -
relevant update without immediate action", "insufficient data - item/context cannot be matched
reliably". `STATE_FOR_URGENCY` is a total record, so a new urgency is a decision somebody makes
rather than one a fallthrough makes for them.

**The test that needed a database.** The assessment behind a withdrawn alert still says the rule
matched, so anything reading assessments alone keeps the item on "action needed". `19` treats a
withdrawn alert resurfacing as a release-blocking defect, and `state = 'PUBLISHED'` in a join is
exactly the kind of clause that reads correct and is not. There is now a real withdrawn row in a
real PostgreSQL engine asserting the item falls back to what its assessment actually found.

**Filters narrow; they never rank.** No sort by urgency, no count per state, no badge - `02` names
alarm-optimised design as an anti-feature, and ranking is a judgement about which of two people's
medicines matters more. `totalItems` is the size of the shelf, so a filtered screen can say what it
is a subset of without counting anything urgent (DEC-063). The values repeat in the query string
rather than being comma-separated, because a list parsed out of one string is a mistake away from a
filter that silently matches nothing - and on this screen a silently empty list is the failure the
whole route exists to prevent. That needed one small transport change, and the credential guard was
extended to the repeated shape rather than duplicated beside it.

**What the screen now says against the seed.** Three items, all "not enough information", the
coverage statement underneath, and no urgency or evidence chip anywhere - because there is no alert
to have either. That is `BLK-006` and DEC-016 working, and it now says so on the screen instead of
by being blank.

**One false alarm worth recording.** Dogfooding returned a 500 on the first attempt. The cause was
an orphaned `tsx watch` process from an earlier run still holding port 3000 and pointing at a data
directory that had since been deleted - not a defect. The new server had failed to bind with
`EADDRINUSE` and the old one answered. Killing by port rather than by command line is the reliable
way to clear it.

### State

2317 tests passing across 71 files, up from 2270 across 69. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 47 new tests: 17 on the derivation and the filters,
8 on the view model, 14 against a real PostgreSQL engine with real published and withdrawn alerts,
and 8 end to end against a live server process.

### Phase 7.2's UI - six cards, no verdict, no order

The projection and its four hard guarantees had been done for some time; the plan recorded the UI
as the outstanding half. Typing the response was the first step and the largest: `LensResponse`
carried `lens: unknown`, which meant every guarantee the projection makes was invisible to the
client and to the compiler.

**The two summaries that are not there.** Six jurisdiction cards invite an overall answer and an
order that puts the strictest first. `09` forbids value judgements such as "strict country" or
"weak regulation", and a list sorted by how prohibitive each answer is expresses that judgement
without using the words. An overall verdict is the same thing collapsed to a line, and it would
have to decide what six different legal systems jointly mean. So the card order is the
projection's, there is no verdict field, and a test asserts the module exports no function whose
name suggests a comparison (DEC-065).

**A status this build cannot describe is dropped and counted.** The presentation layer holds one
description per status and no default, so an unknown one has no sentence anybody wrote about what
it permits or forbids - and a bare `POSITIVE_LIST_ONLY` on a screen is worse than an omission the
card admits to. The count is shown, because a card that quietly dropped a published status would
understate what a regulator said, which is the one direction this screen cannot fail in.

**An empty card says why it is empty.** `23` D-014 is usually read as a labelling rule; on a
jurisdiction card it is a layout one, because an empty box reads as "fine here".

**Where it opens from.** `09` says a regulatory status is shown "beside, not substituted for" the
safety state, which rules out a destination of its own. So it opens from a safety line, once per
substance, and only for substances whose ingredient mapping is `EXACT`: the Lens answers about
whatever key it is given, and an `AMBIGUOUS` mapping means nobody has confirmed that substance is
in the pack. A confident, sourced, applicable-looking answer about the wrong substance is worse
than no answer, because it looks like one (DEC-064). Nothing in the seed has an exact mapping, so
the control appears nowhere - absent rather than disabled, which is DEC-045 again.

**Trap 18 arrived exactly as recorded.** A backtick in a SQL comment - `` `09` `` - terminated the
template literal and surfaced as "decimals with leading zeros are not allowed" forty characters
away. The trap list said to write "spec 09" in SQL, and that is the fix.

**What the live server says.** Six cards, GB and NI separate, each carrying its own coverage
statement and two or three limitations, all reporting no matched rule within coverage. That is
DEC-016 and `BLK-004` working: every shipped fixture is rejected at the Citation Gate because the
research behind it came from search summaries rather than retrieved official documents. The screen
now says so in six sentences instead of by being blank.

### State

2341 tests passing across 72 files, up from 2317 across 71. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 24 new tests: 18 on the view model and its copy, and
6 end to end against a real server process.

## 2026-09-01 - Session resumed

### Reconciling the plan against the repository

Before any new work, the phase statuses in `IMPLEMENTATION_PLAN.md` were checked against what the
repository actually contains rather than against what the last session remembered writing. Four
entries had gone stale, and one of them was stale in the direction that matters.

**Phase 2.1 was marked `NOT_STARTED` and is not.** The note under the Stage 2 table said the phase
"depends on the owned-item schema (migration `0004`, not yet written)". Migration `0004` has been
written since Stage 2 was first planned: `owned_item` carries the lifecycle state, the three
verification axes and the four timestamps the phase asks for, `GET /v1/items` returns them, and the
Shelf screen renders the axes as three separate chips. The first exit criterion - medicine and
personal-care items coexisting without one being a generic note - is met. What is genuinely absent
is the item **detail** route and the four filters, so the phase is `IN_PROGRESS`. This is the
direction of drift worth catching: a phase recorded as not started is a phase nobody looks at
again, and half of this one was already shipped.

**`DEV-007` was headed "partly done" and is closed.** The section still listed revocation as "the
one caregiver action without a screen"; revocation shipped in `f13fe45` and delegation in `f182357`.

**The prose count disagreed with the tables it described.** The plan said nineteen phases were
`COMPLETE` and nine blocked. Counting the rows gives 25 `COMPLETE`, 8 `IN_PROGRESS`, 10
`NOT_STARTED`, 7 `BLOCKED_EXTERNAL` and 1 `BLOCKED_TECHNICAL` across the 51 phases `04` defines.
The paragraph now says where the numbers come from, because a count kept by hand is one that drifts
again.

Nothing was promoted. No phase moved to `COMPLETE` in this pass, and 2.1 moved to the weaker of the
two honest answers available to it.

### Baseline confirmed

`npm run verify` exit 0: 2341 tests across 72 files, typecheck, mobile typecheck, lint and format
all clean. That matches the recorded baseline exactly, so the tree resumed from is the tree the last
session committed.

### The staff surface, and the half of a sentence nobody had read

`DEV-016` had recorded a reviewer console backend with no interface, and building the interface
started by re-reading what `13` actually asks for:

> Internal/admin APIs are separately authenticated/authorized **and not exposed as user APIs**.

The first clause was true and had been for two phases: a reviewer role is a stored row, the app
database role holds no grant on any publication table, and a caller with no row gets a bare
not-found. The second clause was not true at all. `/v1/reviewer/queue` was registered on the same
Fastify instance that serves `/v1/items`, so the only thing between a phone and the publication
tables was the check - correct, tested, and the only thing.

`createServer` now takes a required `surface`. Required rather than defaulted, because a default
decides for every future route which side of a security boundary it lands on and decides it
silently; making it required meant the compiler listed all eleven call sites and each one had to
say which surface it was. The test that matters does not name a route: it reads the paths an
instance actually registered and asserts the partition, so a new route on the wrong side fails
rather than a list somebody forgot to update. The pool those tests use throws on any query, which
is how "the handler is absent" is distinguished from "the handler declined".

**It found a real misplacement immediately.** `/v1/profiles/:profileId/safety-inbox` had sat inside
the reviewer registration block since Phase 7.1, grouped by proximity to a comment rather than by
boundary. It is a household route. Nothing had caught it because both surfaces were one origin, so
the grouping had no consequence - which is exactly the condition under which this kind of mistake
accumulates.

**And it weakened a test that had been claiming too much.** `main.test.ts` asserted that the seeded
owner "gets no staff access at all" by hitting `/v1/reviewer/queue` and expecting 404. That still
passes and now proves less: on the household origin the route does not exist. The reviewer-row
check is asserted on the staff origin instead, where it can fail.

### Three origins, not two

The console could have been served from the staff API's origin. It is not, and the reason is worth
writing down: its session cookie would then be sent to the API on every call, so any XSS anywhere
in the console would carry publication authority directly. On the household origin it would be
worse - shared cookies, shared CORS policy, shared everything - so `resolveStaffApiBaseUrl` refuses
to start against it, and says why in the error.

In development all three are one process short of that: PGlite is a single writer (DEC-037), so a
separate staff API process pointed at the same data directory would overwrite the household one.
Two Fastify instances in one process is the honest version of the same boundary here, and becomes
two deployments unchanged when `BLK-001` clears.

### What the console refuses to do

**Authenticate anybody.** `13` and `14` both require MFA or a passkey for a reviewer account and no
provider exists, so the sign-in page says it is not an authentication step rather than looking like
a login, and every page carries the gap in a banner that cannot be dismissed. `BLK-010` records it.
`AuthenticationStrength` is a closed union with one member, so a passkey provider lands as a second
member and the banner stops appearing because the value changed - not because somebody deleted it.

**Order the queue by urgency.** This one is a security property rather than a taste one.
`maxUrgency` is set by whoever _opened_ the request; sorting by it would let a requester choose how
soon their own request is looked at, by claiming an urgency. The queue is oldest-first, which is
also what `20` measures, and the module exports no comparator (DEC-068).

**Preselect anything.** No decision option, no checklist item, and no control that ticks the
checklist together. `10`'s second reviewer is worth something because they check independently, and
a pre-ticked box turns ten judgements into one click that is indistinguishable afterwards from ten
real ones (DEC-069).

**Say why something is unavailable.** The staff API answers "no such request", "not yours" and "you
hold no reviewer role" identically on purpose. One `outcomePage` renders all three, so no page can
invent a more helpful sentence.

### The join `DEV-017` left behind

Phase 6.7 made `EXPECTED_MATCH_VOLUME` confirmable against a computed figure rather than a
judgement, and left a presentational remainder: the request detail returns a `shadowRunId` and a
reviewer had to go and fetch the run. The console does the join, and puts the run's counts beside
the checklist item that asks about them - including "People this would reach", named the way the
checklist names it rather than the way the database does.

### Two locks on the forms

`SameSite=Strict` on the session cookie stops a cross-site post in any browser that honours it, and
a per-session form token is the second. On a surface that can publish safety content, one control
that an old browser or a proxy can undo is not enough. The token is bound to the session, so it
cannot be lifted from a page an attacker was allowed to see and replayed against a different one -
a test signs two reviewers in and tries exactly that.

The cookie itself carries 256 bits of opaque randomness and nothing else. Everything about the
session - who, when it began, when it was last used, when identity was last confirmed - is
server-side, so its holder cannot extend it, claim a step-up they did not perform, or survive a
sign-out the server performed.

### Three test bugs worth recording, because they all had the same shape

The page tests initially asserted `not.toContain('onerror=')` on escaped output. The escaping was
working: `onerror=&quot;` is inert prose, and the string is still there. Likewise
`not.toContain('checked')` failed on the checklist copy "I checked the shadow run", and a
before/after ordering assertion compared against the word "content" in the viewport meta tag. Every
one was a test looking for a scary-looking substring instead of the property it meant. The fixes
assert the property: no surviving tag, no `checked` **attribute**, and distinctive markers.

### State

2513 tests passing across 78 files, up from 2341 across 72. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 172 new tests: 21 on the surface boundary, 6 against
real processes on two origins, 123 on the console package, and 22 driving the real console against
the real staff API over a real PostgreSQL engine.

Confirmed by hand: both API origins healthy and each answering 404 for the other's routes, the
console refusing to start against the household origin with the reason in the message, and a
signed-in caller holding no reviewer row seeing "nothing to show" above three standing blocker
warnings rather than a permission error.

### Phase 7.3 - why you are seeing this

The approved message templates had existed since the presentation layer was written and nothing
rendered them. `alert_publication` carried an `explanation_template_id` that no code read, and the
Safety screen listed a state per item with no way to ask what was behind it.

**The exit criterion that shaped the design.** "The UI reveals what is known versus inferred" can
be satisfied by a sentence, and a sentence would be a claim about the screen rather than a property
of it - true on the day it was written and stale the first time a field moved. So it is a type:
every value is an `AlertFact` carrying a `FactBasis`, and there is no constructor that makes one
without.

Six bases rather than two, and the extra four are the interesting part. "Known" is not one thing -
a batch number somebody typed and a batch number read from the label are both known, and for a
recall they are not remotely the same evidence. And `NOT_KNOWN` and `WITHHELD_FROM_THIS_SESSION`
are opposite facts: one says the data is missing, the other says it exists and this session may not
have it. Collapsing them would make an access decision look like ignorance.

**The case that needed a decision rather than a fix.** A caregiver holding `VIEW_SAFETY` and not
`VIEW_MEDICINES` is entitled to an alert about a medicine whose name they may not have - `03` group
H makes those separate permissions and both facts are true at once. The first version inner-joined
`owned_item` and answered 404, which reports an alert somebody may read as though it did not exist.
The fix was already written down: DEC-026 settled that the caregiver alert view narrows _by column_
and reports the withholding. So the joins are `LEFT`, row-level security narrows the item to NULL,
and the view says which half is being kept back. It is deliberately not the "cannot explain" state,
because Kynviora can explain that alert perfectly well and is choosing not to show all of it.

**Two refusals worth keeping.** An explanation template this build does not have produces no
narrative at all - a generic "a safety rule matched this item" is a sentence about somebody's
medicine that no reviewer wrote. And an _approved_ template whose required context is missing gets
the same treatment, because `batchRecallMessage` will happily render "null published a notice about
specific batches" from an absent authority, and a sourceless claim about a recall is worse than
none.

**What the licence review costs, on screen.** `04` asks for the source reference "where allowed";
`25` makes that a per-source legal question and `BLK-005` records that no review has happened. So
every alert today withholds the reference and says so, while keeping the publisher and the date,
which are not restricted. A silent gap would read as "there is no source" - the one direction this
line must not fail in, because a person taking an alert to a pharmacist needs to know a regulator
is behind it even when the citation cannot be reproduced.

**What it exposed and did not fix.** The ingredient-sensitivity template names the exact ingredient
and the exact recorded sensitivity, and the assessment records neither - only reason codes and
input versions. Re-deriving them on the read path would mean intersecting the item's formulation
with the profile's allergy records, which is a different computation from the one the rule ran and
can name a substance the rule did not match on. That is DEC-064's failure with a different subject,
so those alerts render without a narrative and `DEV-028` names the write-path fix.

**A latent flake, found and fixed.** One integration test took the first `FIELD_DIFFERS` from the
reconciliation response. A named line with no dosage form produces two, the order is not
guaranteed, and it failed about one run in five with `expected null to be '999 mg'` - which names
the strength and is caused by the dosage form. It now matches on the field as well as the kind.

**And a self-inflicted one.** The phase-count paragraph written earlier this session drifted
immediately: it was measured before the same commit moved 2.1 from `NOT_STARTED` to `IN_PROGRESS`.
The paragraph now carries the command that counts the rows.

### State

2602 tests passing across 81 files, up from 2513 across 78. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 89 new tests: 42 on the view model and its copy, 27
against a real PostgreSQL engine through the real route including the caregiver-withholding case,
14 on the client's narrowing, and 6 end to end against a live server process.

Nothing here is visible against the seed, and that is correct: no rule is approved (`BLK-006`) and
no regulatory record passes the Citation Gate (`BLK-004`), so every safety line has a null alert
identifier and the "why am I seeing this?" control appears nowhere. Absent rather than disabled,
which is the same rule the Lens control already followed on that screen.

### Phase 7.4's regulatory half - the question that has no arithmetic

`diffIngredients` had covered formulation since Stage 3. The regulatory-version diff was recorded
as the outstanding half, and writing it turned out to be mostly one decision.

**The exit criterion cannot be computed.** "Users can distinguish a new regulator action from a
Kynviora correction" sounds like a rendering problem and is not. The two cases produce identical
evidence: a regulator tightening a concentration limit and Kynviora discovering it had
mis-extracted the old limit both appear as a new version superseding the old with a different
`maxConcentrationPercent`. Every heuristic over the pair fails in the case that matters - "the
effective date moved, so the regulator acted" is wrong the moment a correction carries a new date -
and being wrong here means telling somebody the law changed when in fact the software was wrong
about their medicine.

So `attributeChange` inspects neither version. It reads whether an `assessment_correction` row
exists and what kind it names, and whether the new version supersedes an earlier one. That is
DEC-030 again on a different subject: which of two readings stands is stated by somebody, not
derived from recency.

**Four answers rather than two.** `04` names two and there is a third that is neither - the source
correcting its own publication - and a fourth that must not be folded into any of them.
`NOT_STATED` is a member of the union: defaulting an unattributed change to a regulator action
hands Kynviora's mistakes to the regulator, and defaulting it to a correction claims a mistake
nobody found. An unrecognised correction kind attributes to Kynviora, because a value this build
has never seen becoming "the law changed" is the one direction this must not fail in.

**The copy is deliberately blunt.** "Kynviora corrected itself" rather than "this alert has been
updated". `02` names trustworthiness as the product, and the euphemism is the sentence that makes
a person distrust everything else on the screen at the moment they work out what it meant.

**A boundary held.** The first draft had `@kynviora/presentation` importing `RegulatoryDiff` from
`@kynviora/regulatory`. Presentation is carried in the Expo bundle and the registry is not - no
household package has ever imported it. The vocabulary moved to `@kynviora/domain`, where closed
vocabularies live, and presentation declares the diff shape structurally. Structural mirrors drift,
so the regulatory suite - the one place both packages are present - assigns a real diff to the
declared shape and fails if they part company.

**A lint rule caught a real one.** `String(value)` over an `unknown` condition would have rendered
`[object Object]` on a safety screen for any condition shape this build did not expect. It now
narrows to string, number and boolean and reports anything else as absent, which is the honest
answer and the one a screen can say out loud.

**What is not built, and why.** No route and no screen. A version diff needs two published
regulatory versions, and the Citation Gate refuses every shipped fixture (DEC-016, `BLK-004`), so
a route would be a handler nobody could exercise and a screen would be a page nobody could reach.
The attribution half is reachable through `assessment_correction` without any published regulatory
record, and that is the next piece.

### State

2629 tests passing across 82 files, up from 2602 across 81. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 27 new tests, including every member of both
vocabularies through the attribution and the cross-package pin.

---

## 2026-09-02 - Session resumed

### Where this picked up

Mid-refactor. The previous session ended inside Phase 7.6 with the domain, presentation and route
rewritten to a one-receipt-per-alert model and the tests still written against the append-only one
it replaced. `npm run verify` failed at typecheck with eight errors in a single file, so the
repository was not green and `STATUS.md` was describing a state that no longer existed.

Reconciling it took reading the four Phase 7.6 files rather than trusting the plan: domain,
presentation and the API route had all been converted; the test file had not been touched; a stray
debug edit was sitting in `console.test.ts` from a session before that, turning an assertion into a
throw. That was reverted rather than kept.

### Phase 7.6 - resolution and the Safety Receipt

**The design mismatch was real and the schema was right.** `safety_receipt` has carried a UNIQUE
index on `alert_publication_id` since migration `0006`, six migrations before this phase, and the
grant beside it says the same thing twice: the app role holds SELECT and UPDATE and no INSERT,
which only makes sense for a row resolved in place. `04` asks for a "versioned Safety Receipt" and
the first implementation read that as an append-only stack. Two designs met on a constraint older
than both, and the constraint won (DEC-075).

**Following it cost nothing and gained something.** Every resolution already emitted an
`audit_event`, and `audit_event` is append-only by trigger - refused to the service role and to
the owner role alike, which a test now asserts in both directions. So the receipt read replays the
log into a `history`, and `04`'s word "versioned" is answered by a record nobody can rewrite rather
than by a table whoever holds UPDATE on it could. An append-only receipt table would have been the
weaker guarantee. `DEV-029` records the one thing that is still only in the log: a consumer reading
`safety_receipt` directly sees what stands and not the chain.

**A real defect fell out of it.** Phase 7.3's `report-incorrect` - committed, green, in the
repository for a day - did its own INSERT into the same one-row table. A household that recorded
any resolution and then said "this is not my product" met the unique index and got a 500, on the
screen whose entire subject is that Kynviora keeps what happened. Nothing caught it because the two
phases had never been exercised against one alert. Both routes now go through
`recordSafetyResolution`, and there are tests for the sequence in both directions.

**A second one, from a join.** The receipt's first draft inner-joined `assessment_rule_version` to
name the rule. That policy admits `PUBLISHED` only, so a rule Kynviora later superseded would have
made a person's own receipt 404 - exit criterion 1 failing by the route nobody would look at. It is
a LEFT join now: the version identifier is on the assessment and survives, the rule's name does
not, and the receipt says which of the two happened rather than leaving a gap. There is a fixture
rule in `SUPERSEDED` state whose only job is to hold that open.

**A third, from concurrency.** Three role-scoped reads in one `Promise.all` - two under row-level
security and one privileged - interleave their `SET ROLE` statements against a single-writer engine
(DEC-037). Twenty tests failed with a 500 that looked like a query bug. They are awaited in turn.

**What the receipt actually says.** Four sections, because a receipt loses one of them first: what
the alert rested on, what the person did, what changed since, and what is still not settled. The
fourth is the one that disappears, because a record of somebody having acted reads as a record of
the matter being closed - so `10`'s limits sit above the controls rather than at the foot of the
page. Five uncertainties, each derived from a fact on a row: an inexact match, a reference the
licence review withholds, a correction since, a report nothing has come back on, a superseded
assessment. Emitted in vocabulary order, because ranking them is ranking one person's doubts
against another's.

**Identity stayed off it (DEC-076).** The audit rows carry an actor and it would have cost nothing
to render. `ReceiptHistoryEntry` has nowhere to put one, because a caregiver holding `VIEW_SAFETY`
reading "your daughter marked this reviewed" is a disclosure nobody added that permission for. The
fact is still on `resolved_by_user_id` and in the log; it is not on this screen, and tests on both
the server and the client assert no user identifier appears.

**A test found a copy gap review had missed.** Every resolution's description is supposed to say
what recording it does _not_ do - that is where a person marking something "not applicable" learns
it will not go away. `QUARANTINED` said only what setting a pack aside means. A loop over the whole
vocabulary found it; nobody reading the file had.

**The client half.** The receipt opens from the alert detail rather than from the inbox, because a
separate list of receipts is a second place to look for the same thing. Seven controls, one weight,
actions before feedback, nothing preselected, description above each control. The one that
currently stands is withheld; an unrecognised code withholds nothing, because a client guessing
which control to hide can hide the wrong one. Recording reloads rather than patching local state,
since what stands after a write is the server's answer.

### State

2733 tests passing across 87 files, up from 2629 across 82. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 104 new tests across five suites - domain,
presentation, contracts, API against real PostgreSQL, and the database schema itself - plus seven
end-to-end over a real connection.

Phase 7.6 is `COMPLETE` rather than blocked. Both exit criteria are structural and both are met;
unlike 7.2 and 7.3 neither of them needs a human participant. The screen is unreachable in practice
for the usual reason - `BLK-006` means nothing is publishable, so there is no alert to resolve -
but that is a blocker on the data, not on the phase.

### Phase 7.5 - notification policy

Started from an audit of what already existed rather than from the spec's list, and three of the
seven expected outputs turned out to be built already: generic lock-screen notifications and the
deduplication identifiers came with Phase 8.2, and `FOREIGN_REGULATORY_DEFAULT_URGENCY` had been
sitting in `vocabulary.ts` since Stage 1 with exactly one consumer - its own test. A constant
nothing reads is a decision nobody made.

**The first exit criterion needed a third channel.** "A new foreign restriction does not
automatically produce a red/high-severity personal alert" reads like a severity question and is a
channel question. With two channels - now or later - the best a foreign restriction could do is
produce a digest line, which is a smaller version of the thing the criterion forbids. So there are
three, and `IN_APP_ONLY` means nothing reaches a device at all. `MAX_CHANNEL_FOR_URGENCY` maps
`INFORMATIONAL` to it, and that single row is the criterion (DEC-077).

`regulatoryDifferenceUrgency` is the enforcement point the Stage 1 constant never had. The only
escape is a reviewed rule that named this context, which `09` explicitly permits, and the result
reports `raisedByReviewedRule` so nobody can mistake a reviewed decision for a computed one. A
profile with no recorded market has nothing local: everything is foreign until somebody says where
care happens, because telling a person their own regulator has acted when a different one has is
the worse direction to fail in.

**The second exit criterion was about where the check lives.** "Stale/corrected notifications
cannot remain actionable without revalidation." A revalidation route would have satisfied the
words and not the sentence - a client can skip a route. It belongs to the read that renders the
screen, and `AlertDetailInput.revalidation` is required rather than optional, so the compiler
refuses a caller that omits it. Making it required broke two call sites immediately, which is the
type system doing the job the criterion describes.

The withdrawn half needs no notice at all. `alert_publication`'s policy admits `PUBLISHED` only,
so the row never arrives, and the caller cannot distinguish that from having lost access - which
is exactly what DEC-039 says the server is willing to say.

**Two decisions that could have gone either way.** A held alert stays `HIGH` rather than becoming
a digest item, because turning it into one would report a lower urgency than a reviewer approved
and `23` D-005 forbids exactly that elsewhere. And only `CRITICAL` pierces quiet hours: a recall
on a medicine somebody is taking tonight is the case quiet hours must not swallow, and a pack
expiring in three weeks is not (DEC-078). The settings copy says the exception out loud, because a
person who believed quiet hours silenced everything would be relying on Kynviora for something it
will not do.

**No timezone, and that is the honest version.** Quiet hours are minutes from local midnight and
the recipient's local minute is supplied by the caller. Storing an offset would be storing a number
somebody invented that is wrong twice a year, and converting an instant without one would be
inventing the answer at the moment it decides whether a person is woken. Nobody supplies the value
yet, so quiet hours currently hold nothing (`DEV-030`) - and not holding is the safe direction,
because a `CRITICAL` recall waiting for a window that never closes is worse than an inconvenient
hour.

**The near-miss.** The decision layer was committed, tested at four layers, and called by nothing.
It was one commit from being written into the plan as complete - which is `DEV-026`'s failure
exactly: a rule that was correct, tested, and reachable by nobody. `dispatchAlert` now runs
`deliveryDecision` after `selectRecipients`, and the end-to-end test that proves criterion 1 finds
the owner a legitimate recipient with nothing sent to them. "Nobody was entitled" and "nothing was
loud enough" are different facts and `withheldFromDevice` reports the second, so neither can be
read as the other.

**What is deliberately not built.** No digest queue table. `BLK-009` means nothing is sent, and a
table whose rows nobody would ever drain is speculative structure a later reader mistakes for a
working mechanism. The delivery row is still written when the channel is quiet, because a digest
is assembled from what was recorded rather than from what was pushed - so when the dispatcher
arrives, the data is already there.

### State

2820 tests passing across 91 files, up from 2733 across 87. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 87 new tests across four suites.

Stage 7's buildable work is finished. 7.1, 7.4, 7.5 and 7.6 are `COMPLETE`; 7.2 and 7.3 are
`BLOCKED_EXTERNAL` on usability participants nobody here can convene, with every item of their
expected output built and tested.

### Phase 2.1 - the item detail and the shelf filters

Stage 7's buildable work finished, so this went back for the oldest outstanding gap rather than
forward into Stage 9. Phase 2.1's second exit criterion - "a user can understand which items need
verification or review" - was reachable only through the Today inbox, which is to say not from the
Shelf the criterion is about.

**The criterion is not a filter.** A filter meets the words: a person who selects "needs
verification" gets the items that do. It does not meet the sentence, because somebody who does not
already know to filter learns nothing, and the criterion is about understanding rather than about
querying. So every row carries its own reasons and the filter only narrows. That is one design
decision and it drove the rest of the phase.

**Every reason is a column, never a judgement.** Eight members, each decided by one stored value
being one of a stated set. Nothing derived from how long ago something happened, how many axes are
unconfirmed, or what kind of item it is. Six of the eight are one facet in one unsettled state -
merging them into a single `NEEDS_VERIFICATION` would be the aggregate `02` forbids with the
number left off, and it would lose the distinction between "two sources disagreed about what this
is" and "nobody has checked", which call for different actions.

**The reason that is deliberately missing.** "Reviewed too long ago" is the obvious ninth member
and it needs an interval. `BLK-008` records that every numeric threshold in this build is unset
pending real data, and an invented ninety days would be a threshold arriving through the back door
on the screen a household reads most often. `NEVER_REVIEWED` is the absence of a timestamp - a
different statement, and the one this build can make honestly.

**A stopped item is asked nothing.** Unverified in every way, never reviewed, and flagged by
nothing. A shelf that kept nagging about packs somebody has finished with is the alarm
optimisation `02` refuses, and worse, it teaches people to ignore the list that matters. The route
enforces the same rule in SQL rather than filtering the page afterwards, because post-filtering a
paged query returns short pages that read as the end of the list.

**Exit criterion 1 turned out to be about which fields exist.** Not about having both categories
on one screen - that was already true - but about a medicine's detail not carrying an empty "kind
of product" row. A blank field of the other category's shape reads as a record somebody failed to
fill in, which is precisely the reduction to a generic note. So the two groups are typed
separately and the one that does not apply is not rendered at all.

**A constraint caught what review had not.** `personal_care_category` is a closed vocabulary in
migration `0004`, and the first draft rendered it straight through - `BODY_CLEANSER` beside a
bottle in somebody's bathroom. The fixture failed on the CHECK, which is the only reason anybody
looked. It now renders as a phrase, and a category this build has no phrase for reads as "Not
recorded" rather than as its code.

**Written directions are quoted.** `04` Phase 4.1 preserves the source text and `09` forbids
Kynviora saying how to take a medicine. Passing the text through is not enough on a screen: it has
to be visibly somebody else's words, or the rule fails in the rendering rather than in the data.
`ItemField.quoted` carries that, and the detail screen sets those lines apart.

### State

2891 tests passing across 95 files, up from 2820 across 91. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 71 new tests across four suites.

Phase 2.1 is `COMPLETE`. The honest remainder is one layer down: nothing in this build creates an
`owned_item` from a user surface, so every shelf so far has been seeded. That is Phases 2.2 and
2.3, and it is the next thing worth doing.

### Phases 2.2 and 2.3 - the surface, and the five fields nothing showed back

The previous session ended on a usage limit immediately after committing the write path, with the
note "then the client and screen". That is what this one finished. The baseline was re-established
first rather than trusted: `npm run verify` at `8726c44` gave 2955 tests across 98 files, exit 0,
which matched the commit message, so nothing was half-applied this time.

**The route had no idempotency key, and until there was a screen nothing needed one.** Every
caller was a test that submits once. A person on a train tapping Save, seeing nothing and tapping
again is the retry, and without a key that is a second medicine record - which `04` Phase 8.5
later reconciles against a list somebody was handed, where two identical rows read as two
medicines they are taking. That is a false statement about somebody's treatment produced by a
dropped connection, and it is the reason migration `0016` is part of this phase rather than a
later tidy-up.

**It is scoped to the profile, and `dose_event`'s is not.** Copying the precedent would have been
the obvious move and is wrong. Under a globally unique key, a value another household already used
makes the INSERT conflict; the replay read then runs under row-level security, finds nothing, and
the route answers `200` with no ID - their item dropped silently, reported as success. Scoped to
`(profile_id, client_operation_id)`, the collision can only happen inside a scope the caller can
read back, which is the only scope where a replay is a real replay (DEC-079). The existing
dose-event shape was left alone rather than changed in passing, and is `DEV-031`.

**A replay describes the row that exists.** The first draft echoed the submission, which is wrong
for the same reason the whole feature is careful: a retry carrying a changed field would be told
what its own body implies, when what exists is the first version. On a screen whose entire subject
is what Kynviora does and does not hold about a pack, describing a record nobody has is the
failure the key was added to prevent.

**The refusal's field name was being thrown away at the client boundary.** `normalizeManualEntry`
returns `detail.field` precisely so a form can point at the field it refused, and `errors.ts`
passes `detail` through for client-correctable classes - and `parseWireError` never read it.
`WireError.detail` had been declared and unparsed since the module was written. A form with eleven
fields that can only say "that is not a kind of product Kynviora knows" makes the person hunt for
it. It is threaded onto `REFUSED` only, narrowed scalar by scalar (trap 101 on the error path),
absent rather than empty where the server sent none, and with nowhere to put one on an
authorization outcome - so a server that started sending `detail` on a 404 could not leak it
through this client (DEC-080).

**The end-to-end test found what four layers of unit tests had not.** Phase 2.1's item detail was
written before migration `0015` existed, so `manufacturer`, `recorded_gtin`, `recorded_lot_code`,
`ingredient_declaration_raw` and `label_version_note` were writable and invisible. A person could
transcribe a whole back-of-bottle declaration and never see it again. That is Phase 2.3's "not
reduced to name + barcode" failing on the read path rather than on the write path, and it is
invisible from either side alone: the write tests assert the columns are stored, the read tests
assert the fields they know about are rendered, and neither notices a column nobody joined them
over. The suite that caught it drives the shipped client against a real server and compares what a
person typed with what comes back.

The rule that came out of it is in DEC-081: a field on `manualEntryForm` has a row on the item
detail, asserted over the whole form rather than field by field so a field added later is covered
without anybody remembering to.

**A barcode is labelled as the household's own record.** "Barcode as recorded here", not
"Barcode". These columns corroborate nothing (`15` A11, `08`), and a bare label sitting above three
unconfirmed verification chips would read as evidence Kynviora had matched something. The label is
the only thing that prevents it, because the value looks identical either way.

**Two smaller choices.** A form-field error wears `attention`, not `action` - `action` is what a
recall wears, and spending it on a mistyped barcode is the alarm optimisation `02` refuses. And
the client sends what was typed, untouched: deciding a blank field is absent is not the same as
altering a value, and the second is what makes a record uncheckable against the pack in somebody's
hand.

**The near-miss.** The first full verify came back from the background runner reporting exit 0, and
it had not passed: `npm run verify > log 2>&1; echo "EXIT=$?"` makes the wrapper succeed whatever
verify did, and the notification reports the wrapper. The format check had failed on twelve files.
Trap 142 records it, because the failure mode is a commit on red that every other gate would have
been reported as green.

### State

3000 tests passing across 100 files, up from 2955 across 98. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 45 new tests across five suites - the database
schema itself, presentation, contracts, the API against real PostgreSQL, and eight end to end
through the client the app ships.

Phases 2.2 and 2.3 are `COMPLETE`. Neither has an exit criterion needing a device, a credential or
a human reviewer, and the screen is reachable in a way the safety surfaces are not: a person
running the dev seed can add a medicine and see it on their own shelf. Stage 2 has no unblocked
phase left.

### Stage 2's other three words - update, archive, review

Phases 2.2 and 2.3 closed "create". Reading Stage 2's expected output back afterwards - "users can
create, view, update, archive, and review medicine and personal-care items" - made the next gap
obvious: nothing in the build had ever changed an `owned_item` after it was written. Phase 2.1 was
marked `COMPLETE` on the strength of a schema that carried `lifecycle_state`, `version` and
`stopped_on`, and a detail screen that rendered them. Nothing moved any of them.

The manual-entry screen had also just started telling people "you can add anything missing later
from the item itself", which was not true of any surface. A promise the product makes and cannot
keep is worse than a missing feature.

**The mechanism was already specified and unread.** `sync.ts` has set `owned_item`'s conflict
policy to `ASK_USER` since Stage 1, and `owned_item.version` has existed since migration `0004`
with no reader. So the write is conditional on the version the editor was looking at, and the
increment is in the same statement as the condition - two statements would be the race the
mechanism exists to close. No idempotency key: a conditional write is already exactly-once for the
intent it describes, and a key beside it would be a second answer to the same question (DEC-082).

**Zero affected rows turned out to be three different facts.** `owned_item_update`'s USING clause
filters rather than raising, so a caregiver who may read an item and not change it produces the
same empty result as a version that has moved and as an item that is gone. Both wrong answers are
worse than a generic failure: a refusal reported as a conflict sends somebody round a retry loop
they can never win, and a conflict reported as absence tells them their own medicine record has
disappeared. The route re-reads and says which.

**The refusal is still a 404, and the screen is what stops anybody meeting it.** There is no
outcome in this API meaning "you are not allowed" (trap 89) and this route did not become the
exception. The item detail reports `mayEdit`, computed with the same predicate the update policy
uses, so the screen and the policy cannot disagree - and the control is absent rather than
disabled.

**The edit form needed a second representation of the row, which is not duplication.**
`categoryFields` and `sharedFields` are presentation: labels, absent notes, and which text is
somebody else's words. An editor can use none of it, and the category renders as "Hair care" where
the column holds `HAIR_CARE` - so a form prefilled from the rendered fields would send a value the
domain refuses, naming a field the person never edited. `editableValues` is keyed as the form is
keyed, and two tests hold them together: every form field has an entry, and the whole prefill sent
back unchanged must be refused as "nothing to change". That second one matters because the failure
it catches is silent - a field with no entry opens blank, the person saves, and a value they never
touched is cleared, with the write succeeding and the column legitimately nullable.

**Blank means different things on the two forms.** On creation it means "not entered". On an edit
it has to mean "empty this", or a value typed by mistake is permanent. Absent and `null` stay
different answers all the way down, and there is a test for each direction.

**No second validator.** The patch is merged over the stored row and goes through
`normalizeManualEntry`, so a field that could not be entered on the form cannot become enterable
by editing - and giving a medicine a personal-care category is refused with the same sentence on
both paths. Two validators that agree today are two validators that disagree later.

**Marking something looked at is a request, not a timestamp.** `markReviewed` is a boolean and the
server stamps `now()`. A client-supplied `lastReviewedAt` would let a screen claim a person
reviewed a medicine at a moment they did not, on the exact value the Shelf's "not yet looked at"
filter reads. The copy also says it confirms nothing about the product, because `08` reserves that
for something read off the pack and a person who believed otherwise would have a Trust Passport
that means less than they think.

**The lifecycle copy is the part worth the most care.** Every state says what Kynviora stops
doing, not only what it records. Stopping ends the Shelf's questions, the Review Inbox's tasks and
the reconciliation's count. **Archiving ends the safety watch** - the safety inbox filters
`lifecycle_state <> 'ARCHIVED'` - and somebody who archived a medicine believing Kynviora would
still tell them about a recall would be relying on it for something it had stopped doing. That
sentence sits above the control rather than under it, and a test loops the whole vocabulary so a
state added later fails rather than shipping with a blank line where its consequence belongs. That
is trap 109's lesson applied before it could happen a second time.

Nothing is one-way, the stopped date is not invented, and it is cleared when an item goes back into
use: the column holds the current fact and "Stopped 1 June" on a medicine somebody is taking is a
false statement on the screen a household reads most. The history is in `audit_event`, which is
append-only by trigger and refused to every role.

**Two defects the tests found and review had not.** `owned_item_dates_ordered` has always refused a
stopped date before the started date, and the domain had no rule at all - so it arrived as a 500
rather than as a sentence naming the field somebody has to correct. And an audit-count assertion
passed locally and failed in the suite because `audit_event` refuses DELETE to every role and the
fixture reused one item ID across tests: trap 105 for the second time, in a different file.

**What is deliberately not built.** Deletion. `04` Phase 2.1 lists it as the fourth lifecycle
state and it is not one - it is a retention decision, and the matrix `16` requires does not exist
(`DEV-032`, alongside `DEV-009`). Every question a delete control has to answer is unanswered, and
shipping one that guessed would put an irreversible action on somebody's medicine record on the
strength of a number nobody approved. Archiving is reversible and loses nothing, which is the
honest half of the lifecycle this build can offer.

**A conflict does not throw away what somebody typed.** The first version of the copy said the
screen already showed the other person's change; it did not, because the form still held what the
person had entered. Rather than replacing their work silently - which answers the question on
their behalf, the same failure as overwriting the other change - the panel offers loading the
saved version as a control, says what pressing it costs before it is pressed, and says afterwards
that their draft was replaced. That is what `ASK_USER` means on a screen.

**A save that changed nothing is not an error.** Opening the form, changing nothing and pressing
Save is an ordinary thing to do, and the route refuses it deliberately - an empty save moves the
version and becomes a conflict for whoever else has the item open. The screen tells them apart by
the reason code rather than by the message text (`13`): a plain note, not the red panel a
malformed barcode gets. A screen that failed on an ordinary action teaches people to stop reading
the panel on the occasion it says something that matters.

**A flake, and what it actually was.** The full suite failed once on
`main.test.ts > starts with no authenticator when that is stated explicitly` - a 30-second timeout

- and passed on a re-run with nothing changed. Not a regression, and not nothing either: that test
  boots a whole process, and booting one now costs a PGlite instance plus sixteen migrations, which
  takes most of thirty seconds on its own. Under the full suite, with files in parallel and several
  holding their own engine, it crosses the line. The two tests that boot a process in their own body
  now name their allowance and say why, rather than the suite failing one run in some number.

### State

3088 tests passing across 103 files, up from 3000 across 100. Typecheck, mobile typecheck, lint
and format all clean via `npm run verify`, exit 0. 88 new tests across six suites - domain,
presentation, the database schema, contracts, the API against real PostgreSQL, and ten end to end
through the client the app ships.

Stage 2's expected output now reads true except for deletion. `04` Phase 2.1's "common item
lifecycle" is a thing a person can actually move an item through rather than a column.

---

### Phase 7.5's client half - setting the window, and saying it does nothing yet

**Where this picked up.** Mid-phase, with ten files modified and three untracked. `npm run verify`
against that working tree came back exit **1** - typecheck, mobile typecheck and lint all clean,
`format:check` failing on three test files. Nothing was half-written: the domain parser, the
contracts view, the route's response, the screen, the wiring into the You tab and five suites of
tests were all there and all passing. What had not happened was the formatting gate, the docs and
the commit.

**What Phase 7.5 already had.** The window has been stored on `profile_notification_policy` since
migration `0014`, `withinQuietHours` and `deliveryDecision` have applied it since the phase's first
half, and `GET /notification-settings` has reported it. Nothing let anybody set one, and
`setNotificationPolicy` had sat on the client since 7.5 with no caller anywhere - a method nothing
had ever run against a real server.

**What this half adds.** `parseClockMinute` and `quietHoursFromClock` in the domain: a 24-hour time
somebody typed, refused rather than repaired, naming the field to correct. A `NotificationPolicyView`
in contracts that decides what a screen may offer. A `DeliveryPolicy` screen in the You tab, behind
step-up. The route's body grew the two bounds, paired at three layers. Ten end-to-end tests through
the client the app ships (DEC-085).

**The gap that mattered, and it was in the words.** Quiet hours are configurable and hold nothing -
`DEV-030`, because no caller supplies a local minute, and `BLK-009`, because nothing dispatches at
all. The build already reported that honestly in one place and contradicted it in two others:

- The save confirmation read "Saved. Kynviora will hold notifications during that window." That is
  a promise this build does not keep, made at the exact moment somebody has just decided to rely on
  it. It now says what was recorded - "Saved. Kynviora has recorded these hours." - and a test
  asserts no confirmation ever claims holding.
- The sentence saying quiet hours are not being applied showed **only where a window was already
  set**, which is backwards. The person who most needs it is the one about to set their first.

The fix moved the decision out of the screen: `notificationPolicyView` now returns the sentence
itself, present whenever the server says the window does not hold, absent when it does. The rule is
tested once in contracts instead of once per surface, and a missing copy key falls back to the
packaged wording rather than to silence - silence reads as "it works", which is the one reading
that is false (DEC-086).

**One more sentence the screen was composing.** The note explaining why a window this build cannot
read has no editor was written inline in the `.tsx`, under a module comment claiming the screen
composes nothing. It moved to `QUIET_HOURS_COPY`, which puts it inside the copy scan that asserts
no sentence in the module claims quiet hours silence everything.

**A cross-reference that was wrong.** A test comment cited `DEV-026` for "a client method with no
caller"; `DEV-026` is about a caregiver being offered no capabilities to delegate. Corrected to say
the thing plainly rather than to point at the wrong record.

**What is deliberately not built.** The digest. `04` Phase 7.5 asks for a digest policy for lower
urgency, and `MEDIUM` and `LOW` are classified onto the digest channel, recorded on
`alert_delivery`, and never assembled into anything. There is no scheduler in this build - the same
gap `DEV-011` records for missed doses - and a summary nothing can deliver cannot be checked against
reality. Recorded as `DEV-033`, alongside the note that quiet hours and the digest want the same
missing input.

**On the tooling trap that nearly repeated.** Trap 142 is that `npm run verify > log 2>&1; echo
"EXIT=$?"` makes the wrapper succeed whatever verify did. Every verify this session wrote `$?` to
its own file and that file was read rather than the task notification - which is how the opening
baseline was correctly read as exit 1 while the notification said 0.

### State

3140 tests passing across 104 files, up from 3088 across 103. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 52 new tests across four suites - the domain's clock
parser, the presentation copy, the contracts view, the API against real PostgreSQL, and ten end to
end through the client the app ships.

`04` Phase 7.5's deduplication, quiet hours and revalidation-on-open are complete and settable. Its
digest is not, and `DEV-033` says why. Quiet hours are configured and enforce nothing, which the
screen states in the place a person reads before deciding to depend on them.

---

### Phase 1.2 - the people every other record hangs off

**Why this and not something else.** `04` defines fifty-one phases and Phase 1.2 was the oldest one
with an unbuilt surface. Every route in the build takes a `profileId` and every test seeds one;
nothing had ever created a household or a profile from a screen. That made Phase 1.2's first exit
criterion - "every item created later must require a profile" - true by accident rather than by
construction: items require a profile because there was no way to have anything at all.

**What landed.** Two routes, `POST /v1/households` and `POST /v1/profiles`, both behind an
idempotency key the server requires; migration `0017` for the two keys; `AGE_BANDS` in the domain,
with a clock-parser-shaped validator that refuses rather than repairs; a `profileSwitcherView` in
contracts; the copy in presentation; and two screens - setting up, and switching between people -
wired into the You tab above everything else on it.

**The exit criterion is a function, not a screen.** "Screens cannot accidentally display one
profile's data under another profile identity" is a property of what is rendered, and the failure is
silent: somebody reads their mother's medicine list under their own name and nothing contradicts
them. So `profileSwitcherView` owns it. A requested profile is honoured only if the server's list
still contains it, and otherwise the view reports **no** selection and says it dropped one - it
never falls back to whoever is first, which is exactly how a caregiver grant revoked between
launches turns into the wrong person's records under an unchanged heading (DEC-087). `apps/**` is
outside the test run (`BLK-002`), so leaving that decision in a `.tsx` would have put an
authorization-shaped choice in the one place nothing scans.

**Who a profile is about is a claim about the caller, and cannot be about anybody else.** The schema
has had `owner_user_id` and `self_user_id` since migration `0002` and nothing had ever written
either. The body has no field that could name another user, `.strict()` refuses one, and there is no
parameter it could reach if it did not: a profile asserting somebody else as its subject would be an
authorization statement written by the wrong person, and `self_user_id` is unique, so it would also
take a name that person could never claim (DEC-088).

**A caught mistake, in the wiring rather than in a rule.** The first version of the setup screen
always created a household before asking for a name, so "Add someone" from the switcher would have
made a second household every time - and a family split across two collects separate items,
caregivers and safety history, with nothing in this build merging them and no delete control to undo
it. `GET /v1/profiles` now carries `householdId` and the switcher hands it to the screen, so the
household step happens only when there is no household at all. The field discloses nothing: an
opaque ID on a row RLS already admitted, and a caregiver who posted it back would be refused by
`profile_insert`.

**Every optional field says why it is being asked for.** `16` asks for the narrowest thing that
answers the question, and a person handing over a relative's age is entitled to know what it does.
The age help says what Kynviora notices with it and then says leaving it out changes nothing else -
"optional" with no stated consequence reads as "required, but we will let you off". "Rather not say"
is a control rather than the absence of one, and it stays reachable after somebody has picked a
band.

**A band that disagrees with the year is a question, not a refusal.** `bandMatchesBirthYear` exists
and is deliberately outside the validator. Somebody who knows their mother was born in 1958 and taps
the wrong band has made a correctable mistake; refusing the submission would throw away everything
else they typed (DEC-089).

**What is deliberately not built.** Emergency information. `04` Phase 1.2 lists it and it is
personal data about a **third party** - a name and a number belonging to somebody who is not a
Kynviora user, never consented, and has no way to ask for it to be removed. `profile` is readable by
every caregiver holding any viewing capability and has no column-level grant, so shipping the column
would send a stranger's contact details to everybody the owner ever granted `VIEW_SHELF`. `DEV-034`,
and the form says out loud that Kynviora does not hold one - a form that asked for everything else
and silently omitted it would leave somebody assuming otherwise.

**Two small things worth recording.** The API fixture's `beforeEach` failed with "permission denied
for table profile" until it cleaned up as the database owner: neither application role holds DELETE,
which is trap 105 for the third time in a different file. And lint caught two `as AgeBand`
assertions that TypeScript had already narrowed - harmless, but the kind of cast that later hides a
real widening.

### State

3230 tests passing across 108 files, up from 3140 across 104. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 90 new tests across five suites - the domain's draft
validator, the presentation copy, the contracts switcher and form, the API against real PostgreSQL,
and eight end to end through the client the app ships.

`04` Phase 1.2's expected output now reads true except for emergency information. Both exit criteria
hold, and the second one holds as a tested function rather than as a habit.

---

### Phase 1.3 - the only health information Kynviora asks for

**Why this and not the scheduler.** The plan's next item was a missed-dose scheduler, and it is not
implementable: `DEV-011` records that the grace window - how long before a dose counts as unrecorded

- is a product decision nobody has made, and `18` forbids shaming copy, which makes "how long before
  we tell a relative" a question with a wrong answer rather than a missing one. Inventing the number
  would embed an unapproved judgement about somebody's medication routine. Phase 1.3 was the next
  thing that could actually be built, and it follows directly from 1.2: profiles now exist, so the
  context that makes a rule about a particular person is the natural next write path.

**What was already there.** All of it except the writing. `allergy_record` and `condition_record`
have been in migration `0004` since Stage 1 with provenance, certainty, `noted_on`,
`last_reviewed_at`, `version` and full RLS; `sync.ts` has set the conflict policy to `ASK_USER` with
no reader; and `requiredProfileProvenance` in the rule engine has met the phase's **second** exit
criterion since Stage 6. What did not exist was any way to put a fact in.

**The first exit criterion is enforced by an absent field.** "No OCR or inferred fact silently
becomes a confirmed diagnosis" is a sentence about what cannot happen, so the draft has no
`provenance`, the body schema is `.strict()`, and there is no parameter the value could reach if it
let one through. What reaches the column comes from `provenanceForRelationship`, which has two
possible answers: `USER_REPORTED` if the caller owns the profile, `CAREGIVER_ENTERED` otherwise.
`IMPORTED` and `REVIEWER_CONFIRMED` are in the column's vocabulary and unreachable from a phone. A
test enumerates every reachable output and asserts the set is exactly those two (DEC-091).

That is also what makes the second criterion mean anything. A rule filtering on a provenance a
client could set would be filtering on nothing; the two criteria are one mechanism and only the
first has teeth.

**Certainty and provenance are kept apart, deliberately.** "I am sure" is how sure the _person_ is;
`USER_REPORTED` is where the fact came from. A person may say `CONFIRMED` - refusing it would throw
away real information from somebody hospitalised for a reaction, and would be second-guessing their
account of their own body - and it still does not claim a clinician said so, because the provenance
does not move and the schema has no `CLINICIAN_CONFIRMED` at all. Every certainty label is
first-person, and a test asserts it (DEC-092).

**The limit is on every row.** `substance_id` is never set by this route - a household typing
"penicillin" is not the catalog learning a substance (`15` A11) - so in this build _every_
hand-entered fact is unmatched and no rule can see any of them. Each row says which it is, and the
unmatched sentence says both halves: Kynviora cannot check your products against this, **and** it is
recorded and not lost. "Not being used" without "not lost" reads as the record having been rejected,
and a person who assumed an allergy was being watched would find out through an alert that never
arrived (DEC-093).

**A review is something somebody did.** `last_reviewed_at` is stamped only when the change asks for
it, and by the server - a client-set timestamp would let a screen claim somebody checked an allergy
at a moment they did not. Correcting a typo leaves it alone. And it is a fact on the screen rather
than a nag: no count of unreviewed records, no badge, no ordering by staleness, with a copy test
asserting no sentence says "overdue" or "action required".

**What is deliberately not built.** Conditions. `04` Phase 1.3 lists them, qualified - "only where
approved rules require them" - and no shipped rule reads a `CONDITION` fact at all;
`evaluateIngredientSensitivity` filters to `ALLERGY` and `SENSITIVITY`, and `BLK-006` means no rule
is publishable anyway. Collecting conditions today would be storing health data that changes
nothing, which is what `16` forbids and what the spec's own qualifier says. `DEV-035`, with a note
that the eventual field must be a closed vocabulary rather than free text - an open condition box is
a diagnosis box, which the phase's first exit criterion is written against.

**Two small things.** Lint caught a `string | 'CLEAR' | null` union where the literal is swallowed
by `string`; it became a separate `clearNotedOn` flag, which is better anyway, because a sentinel
inside `string` is a value somebody could type into the date box. And the API fixture needed the
database owner for its `beforeEach` cleanup again - neither application role holds DELETE, which is
trap 105 for the fourth time.

### State

3316 tests passing across 112 files, up from 3230 across 108. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0. 86 new tests across five suites - the domain draft
and change validators, the presentation copy, the contracts row and list views, the API against
real PostgreSQL, and eight end to end through the client the app ships.

`04` Phase 1.3's expected output now reads true except for conditions, and both exit criteria hold.
The first is enforced by a field that does not exist rather than by a check, which is what makes the
second - already met by the rule engine - mean anything at all.

### Phase 1.4 - the log that became a state

`consent_receipt` has been in migration `0002` since Stage 1: append-only by trigger, superseding
through `supersedes_id`, refusing UPDATE and DELETE to every role including the database owner, with
a policy pair requiring the row to be the caller's own and its own authorization tests. And nothing
had ever read it. That is a consent **log**, and `04` Phase 1.4's exit criterion - "revoking optional
consent disables the associated behavior" - is about a consent **state**. Writing a row satisfies
none of it.

**What makes it a state is a total record over the vocabulary.** `CONSENT_ENFORCEMENT` gives each of
the eight purposes one of three answers - `ENFORCED`, `NOTHING_TO_STOP`, `REQUIRED` - under a
`satisfies Readonly<Record<ConsentPurpose, ConsentEnforcement>>`, so a purpose added later without an
answer fails to compile rather than shipping as a switch nobody classified. Two are `ENFORCED`. Five
govern behaviour this build does not have. One is not a choice.

**The five that stop nothing say so, on their own row.** No analytics, no OCR (`BLK-007`), no
connected-health integration, no research programme, and manual entry never reaches the shared
catalog whichever way the switch is set (`15` A11). A consent screen where all eight switches look
alike is a screen where somebody turns off "analytics", believes they have stopped something, and
has been told a comforting untruth by a control. Each of those rows carries both halves - Kynviora
does not do this at all at the moment, **and** your answer is recorded and will apply if it ever does

- because the first alone reads as the answer being discarded (DEC-094).

**The enforcement comes off the wire.** The client never computes it. A screen that did would still
be saying "nothing happens yet" on the day a purpose became enforceable, and one that guessed
optimistically would tell somebody they had stopped something they had not; `consentRowView` defaults
an unrecognised value to `NOTHING_TO_STOP`, which is the pessimistic reading and the safe one. An end
to end test asserts the server's answer equals `consentEnforcement()` for every purpose, so the two
cannot drift apart quietly.

**Withdrawing notifications stops all of them, a critical alert included.** This is the decision that
could have gone the other way. A `CRITICAL` alert pierces quiet hours (DEC-078) because quiet hours
are a timing preference - it still arrives. Consent is the basis on which Kynviora may contact
somebody at all, and continuing to send to a person who said stop is not a safety feature, it is
sending without consent. So the check sits first in `selectRecipients`, before the owner
short-circuit and before every grant-shaped check, and the owner is not exempt from their own answer
about their own device. The sentence saying so is above the control and is also the button's
accessibility hint - the same rule DEC-084 keeps for archiving an item (DEC-095).

**`CAREGIVER_SHARING` excludes caregivers and never the owner.** It is the profile owner's answer
about their information reaching other people, read once and carried on every candidate, checked
before the grant state - "I have stopped sharing" is a stronger statement than "your grant expired",
and reporting the weaker one would put the wrong thing in the delivery record. It does not revoke
read access, and the copy says which half it does not do and where the other control is, rather than
leaving somebody believing they had cut a caregiver off.

**Two new exclusion reasons, and neither is `CAPABILITY_MISSING`.** Putting a person who exercised a
right into the same audit bucket as one whose grant was never wide enough would make the delivery
record unable to answer the only question anybody asks it afterwards.

**No receipt is not consent, in SQL as much as in the domain.** `loadCandidates` reads the newest
receipt per user with `DISTINCT ON` - the index on `(user_id, purpose, recorded_at DESC)` serves it
directly - and `COALESCE`s both values to `false`, with the mapper reading `=== true` rather than
truthily so a driver returning `'t'` cannot become agreement. The proof that this is enforcement
rather than decoration is that four existing suites went red at once: every dispatch fixture in the
repository had to be given consent rows before its recipient assertions meant anything again.

**Nobody answers for anybody else.** `consent_select` and `consent_insert` name no household, no
grant and no capability - only `user_id = kynviora.current_user_id()` - so `GET /v1/consents` needs
no `WHERE` clause and `PUT` takes the user from the request context. Three new SQL-level tests assert
it at the table: a caregiver holding every capability there is still cannot record that the person
they look after agreed to something. That is the one write in this product with no delegation path at
all, and it has to be impossible rather than audited, because a receipt written in somebody's name
leaves no trace distinguishable from the real thing (DEC-096).

**The body carries no policy version and no timestamp**, and the schema is `.strict()` so all three
of `userId`, `policyVersion` and `recordedAt` are refused rather than ignored. A client that could
name the policy version it agreed to could record agreement to a text nobody showed them; a
client-set timestamp is an audit trail written by the thing being audited.

**No step-up, and no confirmation step.** `14` puts caregiver administration behind
re-authentication and this is not that. Withdrawing is the safe direction, and granting widens
nothing on its own because the grant that carries information to another person is itself behind
step-up. Friction placed on withdrawal and not on granting is a design that has taken a side, which
`16` and `02` both forbid; the consequence is stated before the control, and that is what `18` asks
for here.

**What is deliberately not built.** The export and deletion shell. `04` asks for one and there is no
row, because a shell is a control that opens something and a settings row that opens nothing tells
somebody a control exists - on the screen where they would look for it in exactly the situation that
matters. The blocker underneath it is that "delete my data" cannot be answered without a retention
matrix, and this build has records that must survive a deletion request with no approved statement of
which: `audit_event` and `consent_receipt` both refuse DELETE to every role, and `dose_event` is what
a Visit Pack is built from. `DEV-036` records it, and notes that the same missing document is what
`DEV-009`, `DEV-032`, `DEV-034` and `DEV-035` are all waiting on - the largest single unblocking left
in Stage 1.

**Three small things.** The two label decisions on a consent row - the chip that says "nothing to
turn off yet" and whether the button reads "Agree" or "Turn this off" - moved out of the Expo screen
into `consentRowView`, because `apps/**` is outside the test run (`BLK-002`) and a choice made there
is a choice nothing checks. The surface partition test grew a `PUT` case, since it had only ever
injected `GET` and `POST` and the consent write is neither. And an `as unknown as` cast in an end to
end test was unnecessary and lint said so: a spread is not excess-property checked, so the body a
client could send by accident is exactly the body the test now sends.

### State

3403 tests passing across 116 files, up from 3316 across 112. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0 read from the log rather than from a wrapper (trap
142 - the first run this session reported exit 0 to the task notification and 1 in the log, on a
format check).

87 new tests across seven suites: the domain state machine and decision validator (21), the
presentation copy (14), the contracts row and list views (20), the API against real PostgreSQL
including the enforcement through the real dispatcher (15), three RLS cases in SQL, two on the
surface partition, and twelve end to end through the client the app ships.

`04` Phase 1.4's expected output now reads true except for the export and deletion shell, and both
exit criteria hold. The first - "revoking optional consent disables the associated behavior" - is a
property of `selectRecipients` rather than of a row, asserted through the real dispatcher against
real receipts. The second - "consent state is auditable and localizable" - is the append-only trigger
and the stored `policy_version` and `locale`, which are the database's properties rather than this
phase's promises.

### `DEV-028` - which ingredient, and which recorded sensitivity

`profile_assessment` has stored `reasons`, `profile_fact_versions` and `formulation_version` since
migration `0006`. A version says **what state** an evaluation ran against; it does not say **which
row** out of that state was the reason. So the alert detail could say that a substance in the
declaration matched a recorded fact and could not say which, and the approved
`tpl.ingredient_sensitivity` wording - which names the exact ingredient and the exact recorded
sensitivity - refused to render rather than guess. That refusal was the right call and it left the
most explainable alert type in the build as a list of codes.

**The identity is frozen at evaluation, beside the versions that were already frozen there.**
`Assessment.matchedInputs` carries the canonical substance key and the profile fact ID, written by
`evaluateRule` and by nothing else. It is a required field on the type, so a future writer cannot
omit it and a rule with nothing of this shape to name has to say `null` rather than inherit a
neighbouring rule's shape. Migration `0018` adds the two columns with three CHECKs: both or neither,
never on a non-match, and no blank key.

**The alternative was the read path, and refusing it is the decision.** Joining the item's
formulation to the profile's allergy records and taking the intersection is a _different
computation_ from the one the rule ran - both may have moved since - so it could name a substance
the rule did not match on. A confident, specific, approved-looking sentence about the wrong
ingredient is worse than no sentence, which is what DEC-064 already decided for the Lens (DEC-097).
The test that matters here is the one with two eligible facts and one of them in the declaration:
re-deriving would be right today and wrong the moment either list moved.

**No foreign key on the fact ID.** The mechanical reason is that `profile_assessment` carries a
BEFORE UPDATE OR DELETE trigger that raises unconditionally, so no referential action could fire -
`ON DELETE SET NULL` would attempt an UPDATE and `ON DELETE CASCADE` a DELETE, and both would trip
the trigger and fail the parent delete instead of tidying anything. `ON DELETE RESTRICT` would work
and would make an allergy record undeletable forever, which is a retention decision this build has
not made (`DEV-036`, a day old). The better reason is the column's purpose: a reference a later
event can rewrite is not a frozen record.

**Row-level security does the disclosure work, and it does it by accident of being right.** Both
lookups are LEFT joins on the caller's own connection, and `allergy_select` requires
`VIEW_MEDICINES` - so a caregiver holding `VIEW_SAFETY` alone reads the alert and not what the
person is allergic to. `03` group H asks for exactly that separation, and the narrative declines
rather than the route refusing, which is the shape the withheld person and item names already have.

**The recorded term is version-gated; the substance name is not.** `display_term` is the person's
own account and Phase 1.3 lets them edit it, so quoting today's wording as what the rule matched
would be a false statement about what happened. The assessment froze the fact's version beside its
ID, so the check is cheap and the failure is honest: neither the old wording nor the new one, since
the point is that Kynviora cannot say which the rule matched. A `preferred_name` change is the
catalog renaming a fixed identity, which is why the assessment stores the **key** and not the
substance row's ID.

**A replay has to reproduce it too.** `replayAssessment` compares the matched identities, so a
recomputation that reached the same verdict while naming a different recorded sensitivity is a
difference rather than a reproduction - it got there for another reason, and the sentence a person
reads is built from those two values. The replay route reads the columns back for the same reason:
without them every recomputed ingredient match would have reported a difference against an original
that had simply never been asked.

**Two things this does not change.** Nothing in this build writes an assessment in production -
`BLK-006` means no rule is publishable, so `profile_assessment` is written by fixtures and read by
the replay route. And trap 155 caught a backtick in a SQL comment inside a template literal for the
second time, with the parse error landing forty lines from the cause exactly as it says it does.

### State

3419 tests passing across 116 files, up from 3403. Typecheck, mobile typecheck, lint and format all
clean via `npm run verify`, exit 0 read from the log.

16 new tests: five on the rule engine, including the two-eligible-facts case and the replay
difference; five on the alert detail against real PostgreSQL, including a caregiver who may read the
alert and not the sensitivity, and a term the person edited after the fact; and six on the schema,
including that neither new column can be edited afterwards.

`DEV-028` is closed. The remaining gap it named - that nothing publishes an ingredient rule - is
`BLK-006` and is not an engineering one.

### Phase 5.2 - the half of normalization that was never pointed at a person

`allergy_record.substance_id` has been nullable since migration `0004` and **nothing had ever set
it**. So every recorded allergy in this build was invisible to the one rule that would use it -
`evaluateIngredientSensitivity` filters profile facts to those carrying a canonical key - and the
normalization engine that would have mapped one has existed since Stage 5, pointed exclusively at
ingredient declarations. DEC-093 described the consequence honestly on every row a day ago. This is
the cause.

**The same function, and that is the point.** `resolveRecordedTerm` and `normalizeIngredients` both
go through `resolveLookupKey` and both key through `ingredientLookupKey`. The rule intersects a
declaration's canonical keys with a profile fact's, so two resolvers that agreed today would
eventually produce a rule that fires on one spelling of a substance and not on another - a spelling
test wearing a safety rule's clothes. A test asserts a typed term and a label token with the same
key resolve identically, field for field, and four spellings of the same substance land on one key.

**Only a reviewed alias resolves.** The lookup reads `substance_alias` and nothing else - not
`preferred_name`, not `inci_name`. `08` makes an alias a reviewed artifact carrying its own
provenance and its own exact-versus-ambiguous state; a string comparison against a display column is
none of those, and it would let a rule fire on a match nobody reviewed. That is Phase 5.2's first
exit criterion, and it would have failed by the back door. `REJECTED` aliases are excluded in SQL -
a mapping somebody looked at and refused must not become a match, nor block one by counting towards
ambiguity.

The practical consequence is that almost nothing resolves in this build, because the vocabulary
needs a licensed source (`BLK-003`). That is a seeding problem with a name, not a reason to lower the
bar for what counts as a match.

**Nothing a person types reaches the vocabulary.** The lookup is a SELECT with no insert branch, and
a test counts `normalized_substance` and `substance_alias` across a write to prove it - `08` and
threat A11, the same rule manual entry already keeps for products. An unrecognised term stays
unrecognised, and the row says so.

**A NULL was two different things, so it is now two.** "Kynviora does not know that word" is a gap in
a licensed vocabulary and nothing the person can act on; "that word means more than one thing here"
is something they can fix in ten seconds by being more specific. One sentence for both hides the half
with a next step. The ambiguous sentence deliberately does not list the candidates - offering them
would be Kynviora suggesting what somebody is allergic to, and a record picked from a list Kynviora
offered is a different record from one they wrote. A copy test asserts it never says "did you mean"
(DEC-098).

**The state is stored, not derived.** Migration `0019` adds `substance_mapping_state` with a
biconditional CHECK against `substance_id`, so a row cannot claim a rule can see it while carrying no
substance. Re-resolving on the read path would be `DEV-028`'s mistake one level up: the vocabulary
may have moved, and a re-resolution can disagree with the mapping that is actually on the row and
driving the rule. The constraint earned itself immediately - the `alertDetail` fixture written an
hour earlier set a `substance_id` and no state, and failed at the table rather than shipping a record
claiming a rule could see it.

**A corrected term is re-resolved; an unrelated edit is not.** A record whose wording changed while
keeping the mapping the old wording earned would drive a rule on a substance nobody typed - Phase
1.3's "silently becomes" one level down. And marking a record as checked is not a re-resolution: a
vocabulary that moved between the two moments must not silently change what a rule can see on an edit
that never touched the word. Both directions are tested, and both assignments happen in one UPDATE so
no ordering can leave the pair disagreeing.

**What is deliberately not built.** The human review queue for unresolved mappings. Two things are
missing and only one is engineering: there is nothing to map _to_ until `BLK-003` clears, so every
item's only available action would be "cannot map this"; and the entries would be terms people typed
about their own bodies, on a staff screen. `DEC-066` split the staff API from the household one
precisely so a reviewer account cannot read the records it reviews, and a queue of typed allergy
terms would be the first thing to cross that line - for a queue that cannot act. `DEV-037`, with the
note that the states this build now stores are exactly what such a queue would select on, so it is a
read over existing data rather than new collection.

**Half of `DEV-018` cleared, and it stays open.** The historical shadow dataset now has the _fact_
side of a substance match available; the _item_ side does not, because the shelf join does not reach
the confirmed declaration. Supplying one half would let a rule matching on the intersection report
zero matches with a straight face, which is the under-count that deviation exists to refuse. Both
stay empty and `INGREDIENT_SENSITIVITY` stays on `HISTORICAL_UNSUPPORTED_KINDS`.

### State

3446 tests passing across 116 files, up from 3419. Typecheck, mobile typecheck, lint and format all
clean via `npm run verify`, exit 0 read from the log.

27 new tests: six on the catalog engine including the symmetry between a typed term and a label
token, four on the copy, five on the contracts view, ten on the API against real PostgreSQL -
covering the re-resolution on edit, the untouched vocabulary, the refused alias and the absence of
any client field - and two end to end.

`04` Phase 5.2's expected output now reads true except for the review queue, and both exit criteria
hold. The first is enforced by what the lookup is allowed to read rather than by a check on what it
returns.

### `DEV-018` - the other half of a substance match

Phase 5.2 gave the historical shadow dataset the _fact_ side of a substance match and the _item_
side was still missing, so `INGREDIENT_SENSITIVITY` stayed refused. That refusal was right while it
lasted: a run reporting fewer matches than the rule really produces reads as "this affects nobody"
on the screen a reviewer approves from, and supplying one half without the other would have made
the rule report zero with a straight face.

**Both halves landed together.** The item side aggregates the confirmed declaration's canonical keys
per item through `formulation_ingredient`, and the fact side joins `allergy_record.substance_id`,
which Phase 5.2 made meaningful an hour earlier. The formulation's `version_label` came with it - it
had been `null` on every historical assessment and the row records it.

**Only `EXACT` ingredients contribute a key.** An ambiguous ingredient resolved to no substance, and
counting it would be matching on a mapping nobody made - the same discipline the rule already keeps
on the profile side and the same one DEC-098 keeps at the point a term is recorded. That is what
makes a zero here a _measured_ zero rather than a structural one, which is the whole distinction the
deviation was written about (DEC-099).

**`DUPLICATE_ACTIVE_INGREDIENT` stays refused, for a different reason than it was put there for.**
The dataset can feed it now; `evaluateRule` cannot evaluate it, because `09` requires validated
reference data and clinical review before that rule may exist at all. A confident zero about a rule
nobody has written is worse than a refusal, and the comment says which of the two reasons applies -
a list whose entries are there for different reasons is one somebody eventually clears wrongly.

**The aggregation is a correlated subquery.** One row per item is what the dataset builder expects,
and a per-item round trip over a whole installation's shelf is the shape that stops being viable
first. `array_agg` returns `NULL` rather than an empty array when nothing matched, which the mapper
coalesces.

The new test block runs last in its file on purpose: it adds a fourth item to the shelf, and the
counts every earlier block asserts are the counts of a three-item shelf.

### State

3451 tests passing across 116 files, up from 3446. Typecheck, mobile typecheck, lint and format all
clean via `npm run verify`, exit 0 read from the log.

Five tests: one that runs the sensitivity rule against a real shelf carrying a mapped ingredient and
a mapped recorded sensitivity and finds exactly the one household, one that reads the breakdown for
the three that did not match, one that holds an unmapped term to a measured zero, one that asserts
the run still writes no assessment and names nobody, and the split refusal case.

`DEV-018` is closed. What it was waiting on turned out to be two things, and Phase 5.2 was the first.

---

## 2026-09-03 - Session: a device, and what it found

### The toolchain, installed rather than described

`BLK-002` had been open since Stage 0 with one sentence behind it: no Android SDK. This session
installed one, and everything below follows from having done that rather than from reasoning about
it.

Nothing needed elevation, a reboot, or a firmware change. Every install is user-scoped:

| Component      | Version                             | Where                                    |
| -------------- | ----------------------------------- | ---------------------------------------- |
| JDK            | Temurin 17.0.20.1+1                 | `%USERPROFILE%\.jdks\jdk-17.0.20.1+1`    |
| Android Studio | 2026.1.4.7 (zip, no installer)      | `%LOCALAPPDATA%\Programs\android-studio` |
| Command-line   | `cmdline-tools;latest` 22.0         | `%LOCALAPPDATA%\Android\Sdk`             |
| Platform       | `platforms;android-36`              | Android 16                               |
| Build-Tools    | `36.0.0`, `36.1.0`                  |                                          |
| Platform-Tools | 37.0.1 (`adb` 1.0.41)               |                                          |
| Emulator       | 37.1.11                             |                                          |
| NDK            | `27.0.12077973` and `27.1.12297006` | the first is what Expo SDK 57 pins       |
| CMake          | `3.22.1`                            | needed: `expo-sqlite` compiles SQLCipher |
| System image   | `android-36;google_apis;x86_64`     | Android 16, API 36                       |
| AVD            | `Kynviora_Pixel_7_API_36`           | Pixel 7, 2 GB, `hw.gpu.mode=host`        |

`JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` and the four `PATH` entries are set at user scope.
All seven SDK licences are accepted.

**Hardware acceleration works and did not need anything from BIOS.** The machine is an AMD Ryzen
5 4600H with `VirtualizationFirmwareEnabled` true and a hypervisor already running for VBS, so
`emulator -accel-check` reports `WHPX(10.0.26200) is installed and usable`. The AMD-specific AEHD
driver, which would have required disabling Hyper-V, is not needed.

**One thing to know about `java`.** The machine has JDK 26 on the _machine_ `PATH` via Oracle's
`javapath`, which precedes any user entry, so `java -version` still reports 26. Nothing breaks:
`gradlew` reads `JAVA_HOME` first and every SDK tool does the same. Removing the machine entry
would need elevation and is not worth it.

**`ndk.dir` in `local.properties` is a trap.** Setting it to the NDK that happened to be installed
made the build fail with `[CXX1104] ... disagrees with android.ndkVersion`. The generated project
asks for a specific NDK by version; the right answer is to install that one and let AGP find it.

### The app launches

`npx expo prebuild --platform android --clean` then `./gradlew :app:assembleDebug`:
**BUILD SUCCESSFUL in 27m 11s**, 383 tasks, four ABIs, `app-debug.apk` at 254 MB. Installed on the
emulator, pointed at the local API with `adb reverse tcp:3000 tcp:3000`, and it renders the seeded
household: Today's review tasks, the Shelf with three items and three separate verification chips
each.

`04` Phase 0.1's exit criterion "Android development build launches on emulator/device" is met.

**The project path contains a space** (`C:\Web UI\KYNVIORA`) and it did not matter. CMake and Ninja
quote correctly; the historic failures were `ndk-build`, which nothing here uses.

**`adb reverse`, not `10.0.2.2`.** The client refuses a plaintext base URL that is not loopback and
refuses to send a development identity to a non-loopback origin (`config.ts`). Both rules are right
and neither needed weakening: `adb reverse` makes the host's API genuinely reachable at
`127.0.0.1:3000` on the device, so `EXPO_PUBLIC_API_BASE_URL` stays loopback and the refusals stay
in force. The emulator alias would have required turning one of them off.

### Three defects that only a build could find

`npm run verify` had been green on every one of these for the life of the project, because the
native side had never been compiled and Metro had never been run.

**The mobile dependencies were from an earlier SDK line.** `react-native-screens@~4.11.0` against
React Native 0.86 fails on `Unresolved reference 'CSSBackgroundDrawable'` - a class 0.86 moved.
`expo-router`, `expo-sqlite`, `expo-secure-store` and `expo-crypto` were all on pre-57 majors.
Aligned to what `expo install --check` resolves (DEC-101). TypeScript is deliberately left at 5.9.

**Metro could not resolve the workspace packages at all.** They are TypeScript source with
ESM-style relative imports - `export * from './tokens.js'` - which `verbatimModuleSyntax` requires
and which tsc, vitest and eslint all resolve. Metro looked for `tokens.js`, did not find it, and
failed the bundle with a red screen. `metro.config.js` now rewrites a `.js` specifier to its
extensionless form **only for files inside `packages/`**, because a `.js` import in `node_modules`
really does mean a `.js` file.

**A tab icon's `color` prop was typed `string`.** The newer navigator types hand it React Native's
`ColorValue`, which a platform colour object also inhabits. Narrowed types compile until something
passes the other member.

### Encrypted local storage, demonstrated

`secureDatabase.ts` had been written since Stage 0 and **nothing called it**. No screen opened the
database, so no file existed - which meant `14`'s "encrypted local storage validated" gate could
not be attempted even with a device attached. There was nothing to inspect.

What landed is the read half of `12`'s repository: an encrypted projection holding the last
successful profile list and shelf, opted into per call site (DEC-100). `03` group J asks for
exactly those two things to stay usable with no network.

**The security rule is derived, not restated.** `projectionActionFor` reads its answer from
`retainsPreviousContent`, which already decides whether a failed refresh may leave content on the
screen. `OFFLINE` and `SERVER_ERROR` keep the row; every other failure deletes it - `15` A2's
"local projection purge on loss of grant". A test asserts the two agree for every member of the
outcome union, so a new failure kind cannot get one behaviour and not the other.

**Local content arrives as `STALE`.** On the device it renders as "Checked earlier - Kynviora
showed this earlier and could not check it again just now", with a Check again control. Not
`READY`, because it is what the server said last time.

### Two more defects, both only reachable on a device

**The projection key was truncated, and every screen collided on one row.** The key joined the
session ID and the screen's name with a NUL - the usual choice, because it cannot occur in either
part. `expo-sqlite` binds a TEXT parameter through C string handling and cut it at the NUL. The
symptom was `TypeError: Cannot read property 'length' of undefined` and a red box on the second
launch: the profile list read back the shelf. Reading the stored keys off the emulator showed one
row whose characters were the session ID alone. The encoding is now length-prefixed, which asks
nothing of the store, and it lives in `@kynviora/contracts` where it is tested for injectivity.

**Two races between the request and the store, and the store lost both.** Opening a SQLCipher
database is a round trip through the keystore; a request to a loopback server that is not there
fails in milliseconds. So on a device the response routinely arrives first, and:

- the **write** was dropped, because the store was still `null` when the response landed. The very
  first fill never happened, leaving an empty store that looked like a working one. The write is
  now handed to an effect that also runs when the store opens.
- the **stored copy was suppressed**, because it was only applied while the resource was still
  `LOADING` - and by then it was `OFFLINE`. Whether a stored copy may be shown is the same question
  as whether a failure may leave content up, so it is now the same function, and both orders
  converge on the same answer.

A third, smaller one: an interpretation failure on a stored body rejected a promise nothing was
handling. A body the screen cannot read is now discarded, which is what a build that changed a
response shape would need.

### The harness

`scripts/device/` verifies rather than asserts. The judgements are separated from the `adb` work so
they run in CI with no device attached (DEC-102), and a check that could not be performed reports
`INCONCLUSIVE`, which fails the run - two of the checks are absence tests, and an absence test over
an empty input passes trivially.

`npm run verify:device`, against the emulator, all seven **PASS**:

```
STORAGE-1  read 12288 bytes from /data/data/com.kynviora.app/files/SQLite/kynviora.db
STORAGE-2  the first sixteen bytes are not SQLite's magic
STORAGE-3  none of four stored strings appears in the raw file
KEY-1      no 256-bit hex key in either of the app's preference files
KEY-2      after a force-stop the app reopened the database and read back what it had stored
BACKUP-1   the installed package does not carry ALLOW_BACKUP
STORAGE-4  the read-back ran with the adb reverse tunnel removed
```

**What makes the absence checks mean anything is `KEY-2` and `STORAGE-4` together.** The app is
killed, the API is put out of reach, and it is relaunched - and it still shows "Synthetic Tablet
A". That string can only have come out of the encrypted file. The same file's 12,288 bytes were
then scanned: entropy 7.98 bits per byte, first sixteen bytes `125d7599a6019a7f38eed5fb105346ae`,
and no occurrence of any seeded name, of `projected_read_v1`, or of `SQLite format 3`.

The key is Keystore-wrapped, not stored: `shared_prefs/SecureStore.xml` holds only
`{"ct":"...","iv":"...","tlen":128,"scheme":"aes","keystoreAlias":"key_v1"}`.

### The rendered screen, measured

`MIN_TOUCH_TARGET_DP` has been asserted in `packages/presentation` since Stage 0 and
`PrimaryButton` has applied it since. Both were true while nothing had ever been laid out. A style
that sets `minHeight` is a claim about what the layout engine will do; the hierarchy Android built
is what it did.

`npm run verify:device:a11y` walks all five destinations at font scale 1 and at 2 - the ceiling
`MAX_SUPPORTED_FONT_SCALE` sets and clamps to, so it is the boundary rather than an arbitrary large
number - and reads the rendered hierarchy back. Thirty screen checks, all **PASS**: every control
is at least 48dp in both directions and every one carries a name a screen reader can announce.

**It found one violation of `18`, and it took three attempts to be right about it.**

The first run reported the shelf's "Open this item" as 354x40dp. It is not: `uiautomator` reports
**visible** bounds, and that button's bottom edge was the ScrollView's bottom edge at
`[0,304][1080,2145]`. The harness had invented a 48dp violation out of a button that was simply
scrolled. A node whose edge coincides with a clipping rectangle is now counted and named as not
measured, rather than measured wrongly - four checks cover that, including the one that refuses to
call a screen a pass when nothing on it could be measured.

The first run also reported the app crashing under TalkBack. It was not the app: the crash was
TalkBack's own process, an `IllegalStateException` in its touch-exploration state machine,
provoked by the harness's own synthetic taps. Two lessons landed as code. `crashedApp` reads the
`Process:` line rather than matching `FATAL EXCEPTION` anywhere, and the screen-reader test no
longer taps at all - TalkBack takes over touch, so an injected single tap is an explore gesture
rather than an activation, and navigation was never happening anyway. What it can honestly show is
that the app starts under a screen reader, keeps running, and exposes named controls, and the
report says exactly that.

Also fixed in the harness: tabs are found by name and tapped at their centre, because the first
version used fixed coordinates for a 1080-wide screen and at font scale 2 the taller tab bar made
every tap land somewhere else - which read as four inconclusive screens rather than as the harness
missing.

**The real finding was in the app.** At 2x the tab bar rendered Safety as "Safet...". `18` requires
font scaling "without clipping critical content/actions", and a destination whose name is cut off
is the icon-only tab bar the same document forbids, reached from a different direction - for
exactly the audience `01` names, who are the people most likely to have set 2x.

Wrapping does not fix it, and trying it made things worse: the five names are single words, a
single word does not break, and `numberOfLines={2}` turned an ellipsised label into one clipped
with no ellipsis at all. That was measured on the device, not reasoned about. The label is now
sized to the fifth of the screen it has - it grows with the system scale until it would stop
fitting, and no further (DEC-103). All five names render in full at 2x.

### The other blockers, checked rather than assumed

Every remaining blocker was tested against this environment rather than restated. Nothing was
found, and nothing was invented to fill the gap:

- **`BLK-001`** - no `KYNVIORA_DATABASE_URL`, no Supabase project, no Postgres binary or service on
  this machine, and no `.env` holding either. Managed-Postgres parity stays unverified. PGlite
  remains what the tests run against.
- **`BLK-003`** - no `KYNVIORA_CATALOG_PROVIDER_KEY`. No GS1 or product-provider access was
  fabricated.
- **`BLK-004`, `BLK-005`, `BLK-006`** - unchanged, and unchangeable from here. No regulatory
  document was retrieved, no licence review performed, and no reviewer exists. Nothing shipped
  moved to an approved state.
- **`BLK-007`** - no `KYNVIORA_OCR_PROVIDER_KEY` or `KYNVIORA_VISION_PROVIDER_KEY`, so no adapter
  was written behind the extraction ports. Every AI kill switch stays `false`.
- **`BLK-008`** - no labelled dataset appeared, so no numeric threshold was measured or assigned.
- **`BLK-009`** - no push credentials. A device now exists, which is half of what `15` A6's
  lock-screen assertion needs, and the other half is a provider that can send to it.
  `recordingTransport` is still the only transport.
- **`BLK-010`** - unchanged. The development header is still a development header; a device does
  not make it authentication.

### State

3521 tests passing across 118 files, up from 3451 across 116. Typecheck, mobile typecheck, lint and
format all clean via `npm run verify`, exit 0 read from the log.

Two device harnesses, both green against a Pixel 7 / Android 16 emulator:
`npm run verify:device` 7/7 and `npm run verify:device:a11y` 34/34. Their judgements are covered by
61 tests that need no device, so `npm run verify` fails if a rule changes even where no hardware is
attached.

`BLK-002` is resolved. `04` Phase 0.1's four exit criteria hold, Phase 0.3 is complete, and `14`'s
"encrypted local storage validated" release gate has evidence behind it for the first time.

---

## 2026-09-03 - Session: reminders, and the launch that planned nothing

Resumed on the Phase 4.2 reminder engine, which the previous session had left substantially
written, entirely uncommitted, and verified only by a harness run that was interrupted. The
starting position was reconciled against the repository rather than the handoff note: `npm run
verify` was green on the working tree at 3733 tests across 126 files, so the code was sound as
written. What had never been established was whether any of it worked on a phone.

### What the emulator said about the engine, before any harness ran

Three schedules left over from the previous session were deactivated through the API. The app was
launched. The device was still holding **42 pending alarms** for reminders that no longer existed.

That is the whole session in one observation. The engine's own unit tests are exhaustive and they
were all passing; `reconcileReminders` cancels what the plan no longer wants and there is a test
that says so. None of it had ever run on a cold start.

Pressing HOME and returning cancelled all 42 immediately, which is what made the shape of the
defect visible: the reconciliation was correct and was not being reached. With one active schedule,
three consecutive cold launches held **0** alarms. A single background-and-return held **15**.

The mechanism was read out of the device rather than guessed at. Temporary `console.log` calls in
the effect, and `logcat`:

    effect { client: true,  activeProfileId: null, projection: false } -> returned early
    effect { client: true,  activeProfileId: set,  projection: false } -> started a sync
    cleanup: live=false                                                 (projection arrived)
    effect { client: true,  activeProfileId: set,  projection: true  } -> DROPPED by syncing guard

`ReminderProvider` guarded its sync with "already running, do nothing". Its inputs arrive in stages

- the API client, then the active profile, then the encrypted projection - so the pass that began
  without the projection was superseded by the one that had it, and that one was refused. Nothing
  re-triggered it. The `AppState` listener could not save it either: it fires on a _change_ to
  `active`, and a cold launch is already active.

The rule moved into `packages/domain` as `requestReminderSync` / `finishReminderSync` with seven
tests (DEC-108). It is a rule with a wrong answer and the wrong answer had shipped, which is
trap 164 arriving from a new direction: a `useRef` boolean inside a `useEffect` is not reviewable
as a rule, and `apps/**` is outside the test run. A refused request is now deferred and re-run from
the `finally`.

Measured after the change, on a wiped app so nothing could be restored from `expo-notifications`'
own store, with no background-and-return anywhere in it:

| Cold launch only                            | Pending alarms          |
| ------------------------------------------- | ----------------------- |
| Schedule at 22:10                           | 15, all exact, at 22:10 |
| Retimed to 20:45 while the process was dead | 15, all exact, at 20:45 |
| Deactivated while the process was dead      | 0                       |

The second and third rows are Phase 4.2's edit and cancellation paths. Both had been silently a
launch behind since the day they were written.

### The harness, which was wrong twice before it was right

`npm run verify:device:reminders` creates a schedule through the real route, lets the app plan,
kills the process, and asks `dumpsys` what the platform is holding and what it posted. Three runs
were needed and the two failures were both the harness's.

**A transport failure decided a device verdict.** The first run reported REM-5 `INCONCLUSIVE` with
"the API refused the schedule (0)" while the API was up throughout - its own log shows a request
from that same run succeeding twelve seconds later. The obvious theory was wrong and was tested
rather than assumed: a keep-alive socket was suspected of going stale across the harness's
390-second blocking sleep, but a connection was measured surviving that intact, and forcing
`connection: close` made things _worse_ (ECONNRESET after a 100-second block). So the fix is a
single retry on a transport failure and the comment says only what was established. Two failures in
a row are still a failure.

**A thirty-second sleep reported a working engine as broken.** The second run failed REM-5 outright:
"None of the 29 pending alarm(s) came back. Reminders stop at the first restart." They had come
back. Asked again a few minutes later, the same device held **28**, with the app never launched -
`dumpsys activity` showed no `MainActivity`, and the process had been started by the boot receiver.
`sys.boot_completed` is not the finish line: the property flips, then `BOOT_COMPLETED` goes to a
queue of 113 receivers (49s of reported completion latency), and the activity manager had _frozen_
the app's process for over a minute before it finished re-registering.

A false FAIL is worse than an inconclusive - it sends somebody hunting a defect that is not there.
The settle is now a poll with a deadline, and it reports how long the restore took, because that is
a real property: a dose due in the first minutes after a restart has nothing holding an alarm for
it.

### Four processes on one database

`npm run dev` failed with `EADDRINUSE` against an API that was answering, which is how four
`tsx watch` servers from previous sessions were found holding the same PGlite directory. The port
check does not catch this: the losers exit their listener and keep watching. The first edit to a
shared package restarted all of them onto that directory at once and PGlite died with `Aborted()`,
taking the development database with it. It was recreated from the synthetic seed - traps 175 and
176 record this and the `expo-notifications` restore that makes a post-force-stop alarm count
meaningless as evidence.

### What the device now says about Phase 4.2

`npm run verify:device:reminders`, eight checks, **8/8 PASS**, exit 0:

| Check    | What the device showed                                                               |
| -------- | ------------------------------------------------------------------------------------ |
| `REM-0`  | a schedule was created through the real route, for 16:37 Asia/Calcutta               |
| `REM-1`  | 15 pending alarms after the app planned, from one schedule over the 14-day horizon   |
| `REM-2`  | all 15 exact - `window=0`, `exactAllowReason=policy_permission` (DEC-106 honoured)   |
| `REM-6`  | 15 before a relaunch and 15 after: re-planning converges rather than doubling        |
| `REM-3a` | no process for the package, and all 15 alarms survived the `am kill`                 |
| `REM-3`  | a notification was posted after the process was killed                               |
| `REM-4`  | its text was "Kynviora" / "Kynviora has a reminder for you" - no medicine, no person |
| `REM-5`  | 29 of 29 alarms restored by the boot receiver, 31s after boot, the app never opened  |

The two that could not be inferred from reading the code are REM-3 and REM-4: the process was gone,
nothing of Kynviora was running, and a notification arrived saying "Kynviora has a reminder for
you" - naming neither the medicine nor the person. That is Phase 4.2's second exit criterion
measured against what the platform actually held, not against the function that produced it.

### State

**3743 tests passing across 126 files**, up from 3603 across 121 at the last commit. Typecheck,
mobile typecheck, lint and format all clean via `npm run verify`, exit 0 read from the log. Ten of
the new tests are this session's: seven for the sync gate (DEC-108) and three for the reboot check's
timing, both written against defects the device found rather than ahead of them.

Three device harnesses, all green against a Pixel 7 / Android 16 emulator: `npm run verify:device`
7/7, `npm run verify:device:a11y` 34/34, and `npm run verify:device:reminders` 8/8. Their judgements
are covered by 101 tests that need no device.

`04` Stage 4 is complete. What the engine does not do is `DEV-041`, unchanged by this session:
force-stop ends reminders silently, an app unopened for more than a fortnight runs out of them,
nothing is reconciled against recorded doses (by decision), and iOS is unverified.

### Then the next unblocked thing: what happens when somebody travels

`DEV-040` named this as the scenario that had just become worth doing, and for a specific reason: a
schedule carries its own IANA zone and the device expands it, so moving the clock across a zone
boundary is a test with a right answer rather than an observation. The rule is `schedule.ts`'s and
predates the reminder engine - a schedule is authored in local wall-clock time and keeps firing at
those local times "through a DST transition or a journey across zones". What was untested was the
device honouring it.

`REM-7` moves the emulator from `Asia/Calcutta` to `Europe/London` and asserts every pending dose is
still at the same absolute instant. **All 14 were**, and the run is 9/9.

Two things had to be right before that reading was worth having, and both are the same mistake in
different clothes - a check that passes for a reason unrelated to what it claims.

**The comparison is on the epoch, not on what the dump prints.** `dumpsys` renders `origWhen` in the
device's _current_ zone, so every row's printed time changes when the zone does while nothing has
moved. `PendingAlarm` now carries `epochMs`, read from the header's `origWhen 1788419520000` rather
than the detail line's rendering. A check on the strings would have failed every row and looked like
a real finding.

**The app is wiped between the two readings.** This is the one that would have been easy to ship.
Android stores an alarm as an absolute instant, so alarms that merely _survive_ a zone change are
unchanged by definition - and `expo-notifications` re-registers from its own store on launch, so
even a force-stop and relaunch restores the old instants without the schedule being expanded again.
Either way the check passes on a build that gets the rule completely wrong. After `pm clear` there
is nothing to survive and nothing to restore: every alarm read afterwards was computed from the
schedule row, in the new zone, on that launch. Trap 177.

Seven tests cover the judgement without a device, taking the reminder harness's own suite to
47 and the three device harnesses to 108, including the case that matters most - a dose
re-expanded in the device's zone, where 08:00 Kolkata becomes 08:00 London and somebody's morning
tablet is silently due at lunchtime.

Getting the parser there cost one detour worth recording: the regex landed in the file with literal
`0x08` bytes where `\b` was intended, which is the same escaping trap the previous session hit.
Every file touched this session was then scanned for stray control characters; there are none.

**State after this piece.** 3750 tests across 126 files, `npm run verify` exit 0.
`npm run verify:device:reminders` 9/9. `19`'s device scenarios go from five covered to six, and the
remaining eight divide into four waiting on features that do not exist and four that are built and
simply have not been driven on a device yet (`DEV-040`).

---

## 2026-09-03 - Session: what an update is allowed to take with it

Resumed with the tree clean at 3750 tests across 126 files and `npm run verify` exit 0, which the
run reproduced before anything was changed.

**Two API servers were holding the same PGlite directory again.** `ListAgents` showed every
Kynviora peer session offline, so this session is the only writer - but two `tsx watch src/main.ts`
supervisors were alive, one of them the loser of an earlier `EADDRINUSE` that had exited its
listener and kept watching. That is trap 175 exactly, and it is worth noting that the port check
does not catch it: only one of them was listening. The stale process tree was killed and the live
one left alone, which is the distinction the resume brief asks for.

### Update over an existing install

`19`'s "Android install/update" row had said "install covered; update over an existing install
untested" since the device work began. It is the one routine event that runs new code against an
old file, and the failure it produces is total and silent: a key that no longer derives, or a schema
the new build will not open, and everything a household kept offline is gone with no error anybody
would connect to the update. `12` makes that store the thing somebody depends on precisely when
they have no signal to re-fetch with.

`npm run verify:device:update` fills the store by _using_ the app, reads the encrypted file out
through `run-as`, installs the APK over the existing app, and reads it again. **6/6 PASS:**

| Check   | What the device showed                                                                |
| ------- | ------------------------------------------------------------------------------------- |
| `UPD-0` | the app rendered seeded content first, so there was something for the update to lose  |
| `UPD-1` | `firstInstallTime` unchanged, `lastUpdateTime` moved - a replace, not a reinstall     |
| `UPD-2` | the database is byte-identical across the update, all 12,288 of them                  |
| `UPD-3` | with the API out of reach, the updated app still showed what only the local store had |
| `UPD-4` | it launched and stayed running                                                        |
| `UPD-5` | 15 of 15 pending alarms held after the package was replaced                           |

**`UPD-1` is the check the scenario is built around, and it is the one that is easy to leave out.**
A clean install also produces a working app - it just has none of the person's data in it, and it
would pass `UPD-2` through `UPD-5` by re-fetching everything. `adb install -r` silently falling back
to a clean install would then produce a green run proving the opposite of its claim. Both times are
read and both are required: `lastUpdateTime` moving says something happened, `firstInstallTime`
holding says the data directory was not taken away underneath it. `parseInstallIdentity` returns
`null` rather than defaulting a missing time, because two absent values compare equal and equal
times are how a reinstall reports itself as an update.

`UPD-2` is byte equality rather than existence for the same reason. A new build that could not open
the old file and quietly created a fresh one leaves a database at the same path, of a plausible
size, that a person's data is simply not in - and "the file is there" calls that a pass.

`UPD-5` came out of the reminder work: Android drops an app's alarms when its package is replaced,
and `expo-notifications` re-registers from its own store on `MY_PACKAGE_REPLACED`. That is the same
mechanism the reboot check measures, on the other event that triggers it, and it is polled rather
than read once - for the reason `REM-5` had to become a poll.

**What this does not cover, and it is narrower than the row's name.** Nothing here installs a build
whose _local schema_ differs from the one on disk, because no second shape exists. The projection
writes to `projected_read_v1` and the table name is the version, so a shape change means a new table
created empty and old rows that nothing reads and nothing removes. Two consequences follow and they
arrive together: somebody offline loses their copy at exactly the moment they cannot re-fetch it,
and a table full of medicine names is retained with no reader, which is what `14` and `21` call more
data than is needed.

The obvious fix - drop every `projected_read_v%` that is not current, on open - is deliberately not
written, because it forecloses the better one. A build that wanted to _migrate_ v1 rows into v2
needs them still there, and a cleanup that runs on open destroys its input first. Choosing between
migrating and discarding somebody's data belongs to the change that introduces v2, where both shapes
are known. That is `DEV-042`.

### The dependency gate, actually run

`04` Phase 9.2 lists dependency and secret scanning in CI among its outstanding items, and
`STATUS` has said "CI pipeline: written; not yet run on a real runner" throughout. The audit gate
was run here directly: `npm audit --audit-level=high` **exits 0**, over 13 moderate findings and no
high ones, all of them in the Expo prebuild toolchain rather than in anything that ships. Recorded
because a gate nobody has executed is a gate nobody knows the state of - and the exit code was
captured directly rather than through a pipe, which is the mistake `ci.yml`'s own header warns
about and which the first attempt here made.

### State

3773 tests across 126 files, `npm run verify` exit 0. Four device harnesses, all green against a
Pixel 7 / Android 16 emulator: `verify:device` 7/7, `verify:device:a11y` 34/34,
`verify:device:reminders` 9/9, `verify:device:update` 6/6. Their judgements are covered by 131 tests
that need no device. `19`'s device scenarios go from six covered to seven.

### Then the backend track: edits that survive having no signal

`DEV-038` had been the largest genuinely unblocked gap in the MVP: `12` requires a
pending-operation journal, `13` defines the conflict policy, `sync.ts` had implemented all of it
since Stage 1 - and **nothing had ever queued a row**. The read half shipped alone on purpose,
because the deviation's own reasoning was that the journal was not the missing piece; a decision
about each entity was.

Three modules, and the two that matter are both in tested packages rather than in `apps/**`:

**`classifyUpload`** reads one answer. The `REFUSED` split is the substance - a conflict is
resolved by a person under `13`'s per-entity policy, a rejection is an edit that cannot be saved as
written, and retrying either is useless. Two answers turned out to belong to the server rather than
to me, and the first version got both wrong: `13` puts `retryable` on the wire, so a 500 the server
marks final must not be retried four more times, and a refusal marked retryable **must** be -
`RATE_LIMITED` is a 429 asking for a pause, and reading it as final permanently fails somebody's
schedule change because they happened to save it during a burst.

**`drainPendingOperations`** decides when to stop, which is the only decision the loop owns.
`OFFLINE` and authorization loss end the pass; everything else continues. Without that, one dropped
tunnel spends an attempt on every queued edit and a person who reconnects finds their changes marked
as needing attention rather than sent. `SERVER_ERROR` is the near-miss and deliberately does not
stop it: a 500 is about the request that caused it. `endsTheDrain` lists every `ApiOutcome` member
rather than using a `default`, so a member added later cannot silently acquire "keep going" - the
linter asked for that and was right (DEC-109).

**The policy gate is a refusal, not a warning.** `queue` asks `isOptimisticallyApplicable` before
writing anything and returns `false` for the types `13` resolves `SERVER_WINS`. A queued caregiver
grant would show as active while offline, and the person who acted on it would believe somebody has
access they do not. A warning would hand that decision to whoever wires the next call site, in
`apps/**`, where nothing tests it (DEC-110).

`medicine_schedule` is the one type wired, and it was chosen rather than defaulted to: Phase 4.1's
route already carries both halves a replay needs - an idempotency key scoped to the item, and
`expectedVersion` as a precondition - so a retry either lands once or comes back as a conflict, with
no third outcome to design. `owned_item` and `dose_event` stay unwired for the non-engineering
reasons `DEV-038` gave and which have not changed.

**On the device.** The storage refactor is the risky part - the journal is a second table, so
`openLocalStore` opens the SQLCipher file once and builds both on that handle rather than calling
`openSecureDatabase` twice, which is the race `ProjectionProvider` already warned about (trap 180).
One SIGSEGV was seen on the first launch after the change and did not reproduce in five subsequent
cold launches; it came while Metro was still rebuilding and no crash has been seen since, so it is
recorded as observed rather than diagnosed. What is verified is what the refactor put at risk: with
the reverse tunnel removed, the app still renders "Development profile" out of the encrypted store.

**What is still open and is said rather than implied.** No screen shows the queue or resolves a
conflicted operation. `needsUserAttention` counts them and the count is exposed; the screen is not
written. That is the half of `12`'s "resolvable failure state" that is still a state.

### State

3802 tests across 129 files, `npm run verify` exit 0.

---

## 2026-09-04 - Driving the offline write, and the three things in the way

The previous session wired the pending-operation journal and left one thing undone: nobody had
watched a queued edit make the journey. Queue with no signal, kill the process, reconnect, and see
it land - once. That was the task. Getting there took three defects out of the app, and none of
them was visible from any gate this project runs.

### The first write anybody ever made on a device

The chain got as far as pressing Save and produced a red screen:

```
Uncaught Error
Property 'crypto' doesn't exist
  shelf.tsx (316:30)   const idempotencyKey = crypto.randomUUID();
```

There is no global `crypto` on Hermes. `crypto.randomUUID()` was in **eight call sites across six
files**, and it is the first line of every write that needs an idempotency key: creating a
schedule, recording a dose, adding a medicine, setting up a household, creating a profile, inviting
a caregiver, exporting a Visit Pack, and queueing an edit made offline. Every one of them threw at
the moment somebody pressed Save. Nothing the app writes had ever worked on a phone.

**Why every gate was green over it** is the part worth keeping, because the gap is structural.
`vitest.config.ts` excludes `apps/**` and `eslint.config.js` ignores it, so the 3,808 tests and
every lint rule had never seen these files. That leaves the mobile typecheck as the only automated
gate over the one tree whose code runs on a person's phone - and it was being told a phone is a
browser: `expo/tsconfig.base` sets `lib: ["DOM", "ESNext"]`, and the monorepo's hoisted
`@types/node` was picked up ambiently. `crypto` was declared twice over.

The four existing device harnesses could not have caught it either, and that is not a fault in
them: storage, accessibility, reminders and update **only read**. `verify:device:reminders` creates
its schedule through the API from the host. No harness had ever driven a write.

The fix is one binding (`apps/mobile/src/platform/ids.ts`, on `expo-crypto` - the same secure source
`secureDatabase.ts` derives the SQLCipher key from) and two gates behind it. The mobile project now
compiles with `lib: ["ESNext"]` and `types: []` (DEC-112): run against the code as it stood, it
named all eight lines and nothing else, because everything the app genuinely uses - `fetch`,
`console`, timers, `URL` - comes from React Native's own types through imports.
`scripts/checks/mobileGlobals.test.ts` states the same rule where the suite can run it, and reads
the real `apps/mobile/src` tree; it is the only test in `npm run verify` that looks at app source at
all. Pointed at the previous commit's `shelf.tsx` it reports lines 282 and 316, which are exactly
right (`DEV-043`).

### The launch a queued edit had been waiting for

With writes working, the chain ran: save offline, `am kill`, reconnect, relaunch. The server did
not change. It changed on the **next** background-and-foreground.

A sender was registered by the screen that knew the shape of the write, and the encrypted store
opens at the root, before any tab beyond the first has mounted. So the single drain pass a cold
launch runs found an empty registry - and the launch after a person's phone killed the app is
precisely the launch their queued medicine time was waiting for.

It was worse than waiting. With no sender the provider answered `OFFLINE`, `classifyUpload` reads
that as `RETRYABLE`, and `recordUploadOutcome` increments the attempt count and marks the row
`FAILED_RETRYABLE`. Every launch spent an attempt on an operation nothing had asked a server about,
and enough launches would leave a person's edit "needing attention" on a screen that does not exist
(`DEV-038`) having never been sent once. That is the same failure DEC-109 refused - one dropped
tunnel spending everybody's budget - arriving through a different door.

`drainPendingOperations` now asks `canSend` before `send`, and reports what it passed over in a
`skipped` list: untouched, full budget, still `PENDING`, and not blocking the operations behind it
(DEC-114). Senders moved to `PendingSenders`, mounted at the root (DEC-113) - which is the argument
`_layout.tsx` already made about the reminder engine, in as many words: "a sync that only ran when
somebody opened a particular tab would stop... and the person would find out by not being
reminded." (`DEV-044`.)

### A medicine with no schedule could never be given one

The harness picks controls by accessible name rather than by coordinates, so it landed on the
seed's _second_ medicine - which had no schedules - and reported that it could not open the
new-schedule form. It was right. There was no button.

The editor's payload is `{ schedules, detailLevel, directionsText, mayEdit }`, and it was loaded
with `isEmpty: (value) => value.schedules.length === 0`. `EMPTY` sets `value` to `null`, correctly,
because `EMPTY` means there is nothing to show - so an empty schedule list discarded `mayEdit` with
it, and a control that is deliberately **absent rather than disabled** for a caller who may only
look (DEC-045) was absent for everybody. Phase 4.1's create route was unreachable from the app in
the only state a newly added medicine is ever in.

Every gate was green over this one too, and every part was individually right: the server, the
screen, and `resourceFor`, which is tested. The bug is that `isEmpty` asks about a whole payload
and this one was empty in a single field. Every other call site was checked; one more had the same
shape - the Care screen called itself empty with no grants and no invitations, discarding the
**access history**, so a household that had just revoked its last caregiver would see no record
that anybody ever had access (`DEV-045`).

Only by hand did this stay hidden: the first seeded medicine had fifteen schedules left over from
earlier sessions.

### The harness, and what it took to make it honest

`npm run verify:device:offline` - **6/6 PASS**:

| Check   | What the device showed                                                                           |
| ------- | ------------------------------------------------------------------------------------------------ |
| `OFF-0` | the form held the time and the medicine had no live schedule - so anything after it is this save |
| `OFF-1` | with the API switched off, no request left the phone and the screen did not call it a failure    |
| `OFF-2` | pid gone after `am kill`, so the journal was read off disk by a new process                      |
| `OFF-3` | the create went out on the **first** launch, and the server has the new time                     |
| `OFF-4` | 3 creates under **one** key, `idempotent-replay` on two, and exactly one live schedule           |
| `OFF-5` | a further foreground sent nothing: the committed operation left the journal                      |

`OFF-4` is the one that cannot be faked, and the run is built to make it possible. `13` says the
operation ID _is_ the idempotency key, and DEC-111 keeps the key a failed attempt used - because
`OFFLINE` is inferred from a failed fetch, which is also exactly what a request that **arrived and
lost its answer** looks like. So the switch forwards the request, waits for the server to commit,
and destroys the socket before the answer reaches the phone. Under a fresh key the replay makes a
second schedule, and on this table that is not a duplicate row on a list: it is being told twice,
at the same minute, to take the same tablet.

Four things had to be true before any of those readings was worth having, and each was learned by
getting it wrong first.

**Removing `adb reverse` does not put a device offline.** adbd's listener goes, but OkHttp's
already-established connections keep working, so the write meant to be queued went straight to the
server. The scenario reported a successful save, which was true and was not the claim. Hence a
switch this harness controls, which cuts live sockets as well as refusing new ones (trap 183).

**That switch cannot live in the harness process.** `sleep` is `Atomics.wait` - synchronous on
purpose, so a failure is attributable to the step that caused it - and it blocks the event loop for
forty-five seconds at a time while an app starts. A server sharing that loop accepts nothing during
almost the entire run: the phone rendered "No connection. Kynviora could not reach the internet" on
a launch the harness believed was online, and requests made while it was supposed to be _offline_
were served later, when it was passing them again, and recorded as having got through. Both
readings are wrong and both look like findings about the app. `apiSwitchServer.ts` is its own
process, controlled through files, because `readFileSync` needs no event loop.

**`am kill` does not kill a foreground process.** The first run reported a journal surviving process
death while the pid never changed. The app is backgrounded first and the pid's absence is asserted -
and it is still `am kill`, never `force-stop`, which cancels every alarm (`DEV-041`, trap 182).

**Counting rows is not counting schedules.** `0004` grants the app role no DELETE, so every
schedule this harness has ever created is still in the table, deactivated. `OFF-4` counts the
**live** ones - which is also the honest form of the claim, since a duplicate created by a replay
would be active, and a row that reminds nobody of anything is not an instruction to take a medicine.

Two smaller ones, both about the emulator rather than the app: Android's stylus-handwriting tutorial
opens over a text field and swallows `input text`, leaving a form that looks ignored (trap 185); and
an empty Android field reports its **placeholder** as its text, so "the field is non-empty" is
always true (trap 186). `typeInto` reads the value back and compares it.

And one about `adb` itself that cost most of an hour: `adb reverse` registered successfully and
forwarded nothing, because the adb server had been started before the emulator. The app reported
`isMetroRunning(): false` and died with "Unable to load script" while Metro was plainly running.
`adb kill-server && adb start-server` with the device already up fixes it. The false trail was
`printf ... | nc`, which closes the socket at stdin EOF before the response arrives - so a working
tunnel looks broken too (trap 184).

### State

3863 tests across 133 files, `npm run verify` exit 0. Five device harnesses green against a
Pixel 7 / Android 16 emulator: `verify:device` 7/7, `verify:device:a11y` 34/34,
`verify:device:reminders` 9/9, `verify:device:update` 6/6, `verify:device:offline` 6/6. Their
judgements are covered by 173 tests that need no device. `19`'s device scenarios go from seven
covered to eight.

### Then the three flows nobody had driven, which were not untested but broken

`DEV-040` listed three scenarios as "built and untested on device", which read like a queue of easy
work. All three turned out to be broken, and each in a different way that no gate here could see.

**Profile creation** could not have worked at all - both of its idempotency keys came from a
`crypto` Hermes does not have (`DEV-043`). `npm run verify:device:profile` is **4/4 PASS**, and its
control is the one worth keeping: profiles cannot be deleted, so every earlier run is still in the
household and a fixed name would let last week's run answer this week's question. Each run creates
a name with its own suffix. `PRO-3` is the half no API test can reach - a row nobody can see is not,
to the person who made it, a profile that was created; they would add the same person again.

**Caregiver invite/revoke** could not be _finished_. The Care tab was the only one rendering its
sheets in a plain `View` rather than inside `Screen`, whose `ScrollView` is what makes the other
four reachable. Six capability rows fill a 1080x2400 screen on their own, so the email field, the
review control and Cancel were drawn past the bottom with nothing able to bring them into view -
`uiautomator` reported the container as `scrollable=false`. Nobody could send an invitation, or
cancel out of the form (`DEV-046`). `npm run verify:device:caregiver` is **5/5 PASS**.

The measurement there is a count and not a status code, on purpose. `13` does not let the route say
whether a profile exists, so "you may not" and "there is nothing" are both `200` with an empty list;
a check written against status codes would pass identically before the invitation, after acceptance
and after revocation. Measured: 2 of the owner's 3 items while granted - the two medicines, not the
personal-care product, which is `08.2`'s scoping doing its job - and **0 on the very next request**
after the removal, on the session that was working a moment earlier. That is `12`'s "authorization
loss invalidates local access", and it is the sentence the app itself puts on the screen of the
person doing it: "This takes effect straight away."

**Visit Pack export** worked, and its harness found the third defect. `DEV-047`: the export's
idempotency key was minted at the moment of the press rather than when the export was decided. The
screen replaces the button with its own state while a request is in flight, so a double tap was
never the risk - the ordinary one was, a slow request and a retry the person is invited to make,
producing a second copy of their medicines with its own expiry that they would not know about.
`npm run verify:device:visitpack` is **5/5 PASS**, and the check that matters is a subtraction: an
export is the only thing in this app that leaves it, `16` rests that on the promise the screen makes
twice, and a run that ticked everything would confirm the promise and test none of it. One of two
medicines is ticked; `PACK-3` asks about the other. One entry, the one that was ticked.

Finding the pack afterwards took a decision worth recording. The app deliberately shows nothing
identifying when it is done and there is no route that lists packs - a list of somebody's exports is
itself a record of who they have discussed their health with. So the switch records the top-level
`id` of a JSON answer and **only** that: never a body, because these bodies carry medicine names and
a harness that wrote them to disk would be making exactly the copy these scenarios exist to bound. A
replay of the create was tried first and abandoned honestly - the route checks the reviewed-content
digest before it reaches its duplicate branch, so a repeat with a body the harness never saw is
refused as a bad digest and says nothing about idempotency.

### And then the half of `12` that was still a state

`12` asks for a pending-operation journal **and a resolvable failure state**, and the app had the
first. `needsUserAttention` has counted the operations that stopped retrying since the journal
shipped, and nothing has ever shown them - so an edit held safely was indistinguishable, from
outside, from an edit that was saved. It is also why `DEV-044` could only be found by watching the
wire: the store is SQLCipher-encrypted, so `sqlite3` cannot answer it either.

`PendingQueue` lists them in the words a person uses - "A change to when a medicine is taken", not
`medicine_schedule` - and offers each row only what it can honestly support:

- **a conflict** gets both "try again" and "remove", because `13` says the person decides and
  offering only "remove" would discard their change because somebody else got there first;
- **a rejection** gets only "remove", because the server has read the change and will not take it
  as written, and a "try again" there produces the same refusal and teaches a person to distrust
  every other button on the screen;
- **a change that is simply waiting** gets nothing at all - it is not a question, and offering to
  discard it invites throwing away an edit seconds from being saved.

Those decisions are `pendingQueueView`'s, in `@kynviora/presentation`, where they are tested. The
screen renders them and calls the provider, which gained `list`, `retry` and `discard`. Retry resets
the attempt count, which is the point: an operation that stopped retrying has spent its budget and
`isUploadable` would pass over it for ever, so without the reset the button is a no-op that looks
like one.

It unblocks the entity `DEV-038` was holding for exactly this reason. The **review** of an allergy
or sensitivity now queues offline - `13` resolves `allergy_record` `ASK_USER` and the write is
conditional on `expectedVersion`, so a replay lands once or comes back as a conflict somebody can
now resolve. **Adding** a fact stays unwired, and the reason is now specific rather than
structural: that route deliberately carries no idempotency key, on the contract's reasoning that a
retried create makes a visible, correctable duplicate - and that reasoning is about a person tapping
twice, not about a journal replaying on its own after an answer was lost with nobody watching.
`condition_record` stays unwired because there is no such feature to queue from (`DEV-035`), which
is a better reason than the one `DEV-038` used to give.

Driven on the device: a schedule saved with the API switched off appears as "1 change is waiting to
be sent" with no controls, and the section is gone after the next foreground with the server holding
the change. It renders only when there is something in it, so it is not a permanent reminder that
syncing exists.

### One harness defect, kept because it is the kind that matters

A run failed at its first step with the launcher on screen: Metro rebuilds the bundle on every cold
start and one hiccup leaves the app never started. The harness reported that as **`OFF-1` FAIL - the
screen told the person their change was lost**, about a run in which nothing had been pressed. A
finding about the harness wearing a finding about the app is the exact failure `DEC-102` exists to
prevent, so `coldStart` now confirms the app is on screen and retries once, and `OFF-1` distinguishes
"the save was never driven" from "the screen said it failed".

### State

3932 tests across 137 files, `npm run verify` exit 0. Eight device harnesses green against a
Pixel 7 / Android 16 emulator: `verify:device` 7/7, `verify:device:a11y` 34/34,
`verify:device:reminders` 9/9, `verify:device:update` 6/6, `verify:device:offline` 6/6,
`verify:device:profile` 4/4, `verify:device:caregiver` 5/5, `verify:device:visitpack` 5/5. Their
judgements are covered by 226 tests that need no device. `19`'s device scenarios go from seven
covered at the start of this session to eleven.

Six defects were fixed, and the common thread is worth stating once: every one of them was in
`apps/**`, which is excluded from the test run and ignored by the lint config, and five of the six
were invisible from reading the code. What found them was driving the app.

---

## 2026-09-04 - The two scenarios that were never waiting on hardware, and the dose nobody kept

Resumed from a clean tree at `974d7d5` with `npm run verify` green at 3933/137. One API, one Metro,
one adb server, no emulator - booted one, and killed an orphaned `node scratchpad/probe.mjs` left
over from the previous session so the process count stayed honest (trap 175's discipline).

### The device scenarios, and what "the remaining three" turned out to mean

`DEV-040` listed eleven of `19`'s fourteen device scenarios as covered and the remaining three as
blocked. Reading them one at a time, that was one scenario's worth of truth and two scenarios'
worth of imprecision.

**Personal care** was recorded as blocked on `BLK-007`, and the scan and OCR halves genuinely are.
The manual half is Phase 2.3, is built, and had never been driven on a phone. `PC-4` is the check
worth having: the barcode, the batch code and the expiry are left blank and the ingredient
declaration is filled in, so three limits have to be stated afterwards and the fourth must not be.
A screen printing the same four sentences whatever somebody typed passes every other reading of
"the limits are stated", while telling a person their ingredient list is missing when it is on
file. `PC-5` is `19`'s "confirm" step as this build can have it, and it inverts: with no extraction
there is nothing to confirm, so what has to be true is that a typed record is never presented as
confirmed. Measured on the item's own screen against a record the server holds as `UNVERIFIED`.
6/6 PASS.

**Safety alert open/resolution** was recorded as blocked on `BLK-006`, and half of it is. Opening a
published alert needs a publication, and seeding one to make a device test go green is the exact
failure the governance chapter exists to prevent - so `verify:device:safety` does not, and says so
in its own report. What it drives instead is `23` D-014, which is a safety requirement in its own
right and the one a person is exposed to today: Kynviora has nothing to say about this shelf and
has to say so without that reading as an all-clear. Seven checks, including the two that were
wrong first - a state chip looked for by its bare label is answered by the filter of the same name,
and a "no counting" rule that rejected any digit fails the screen for its own legitimate "Showing 0
of 5 items on this shelf." 7/7 PASS.

`19` now reads thirteen of fourteen with something measured, and `DEV-040` says at length what that
number is not: five of the thirteen are partial, each with the missing half named, and the
fourteenth has nothing at all because Phase 1.1 has not chosen an auth provider.

### The offline mutation audit, taken one table at a time

The instruction was to wire only what `13`'s conflict policy allows, and the useful finding was how
little that leaves. Of twelve sync entity types: four are `SERVER_WINS` and `PendingSyncProvider`
refuses them before writing a row; three have no client feature to queue from; two are wired for
the mutation that is safe and deliberately not for the one that is not; one needed a decision
rather than a rule. That left `dose_event`. The whole table and its reasoning is `DEV-048`.

**`profile` was the one that needed deciding** (DEC-115). Its policy is `ASK_USER`, so the journal
would have accepted it, and there is a feature. But a conflict policy answers who wins when two
versions disagree; it does not answer whether the client can show the result, and for a create
those are different questions. A queued profile exists under an identifier this phone invented, and
every read in the app is the server's answer - so the person would appear in the switcher, be
selectable, and have every screen behind them permanently empty. That is worse than the refusal it
would replace.

**`dose_event` was simply missing, and it is the one with a person on the other end.** `13` resolves
it `MERGE_BY_ID` and the table's own comment says why. `04` Phase 4.3 makes it an exit criterion:
an event created offline may be uploaded more than once, and a duplicate sync must not create a
duplicate event. The route had held up its end since it was written. The client had not - `onRecord`
treated `OFFLINE` as an answer, so somebody in a kitchen with no signal recorded a dose, was told
Kynviora could not reach the server, and the record was gone. The sentence for the case had been
written and never used: `DOSE_COPY.offlineNote` sat unreferenced in the presentation package.

Run C of `verify:device:offline` swallows the answer rather than cutting the network, and the check
says why: with no journal at all the swallowed request still commits, so a run that merely counted
rows afterwards would pass an app that kept nothing. Measured: three dose creates under one key,
`idempotent-replay` on two, exactly one event. The harness is now 8/8.

`scripts/checks/queueableSenders.test.ts` is the gate that keeps the audit true. `queue` already
refuses a `SERVER_WINS` type, which is exactly why a sender registered for `caregiver_grant` would
fail nothing today - it would sit there looking correct until somebody relaxed the refusal for an
unrelated reason. The check reads `PendingSenders.tsx`, which `npm run verify` otherwise never
looks at.

### A grant that says "viewing" and permits a write

Wiring `dose_event` to the offline queue changed who can reach that table and when: a queued
operation is replayed by a drain days later, against whatever the grant says at the moment it
lands. `11` puts that decision on the server, so the question was whether the **route** refuses -
and `services/api/src/doseAuthorization.test.ts` now measures it against the real database with
row-level security in force.

Three of the four answers are the right ones. A stranger is refused, a revoked caregiver is
refused, and a revoked caregiver replaying an operation whose key was minted while their grant
still stood is refused - which is the exact shape an offline journal produces.

The fourth is not. A caregiver granted only `VIEW_MEDICINES` can write into the owner's dose
history, and the invitation screen puts that capability under **viewing** with **changing** empty,
because its description carries `allowsChanges: false`. Two deliberate decisions, made in different
places, that contradict each other: `0004` scoped every child of `owned_item` by reachability and
`0020` restated it for this table in as many words - "`dose_event` is a record of something that
happened and is reachability-scoped on purpose" - while the screen groups capabilities into viewing
and changing "because that is the distinction a person actually cares about when approving access".

Both positions are defensible and the resolution changes what an existing grant means, so it is
`DEV-049` and `BLK-011` rather than a policy edited in passing. The three ways out are to tighten
the policy, to change the copy, or to give the thing a caregiver most often does a capability of
its own. The test pins today's behaviour, so whichever is chosen fails that file first - which is
where the reasoning should be written.

### Four harness defects, and two that had been wrong from the beginning

**The emulator's screen goes off.** A display that is off has no view hierarchy, and
`uiautomator dump` answers "null root node" to every read - byte for byte what it answers
mid-transition. So `scrollTo` reads it as "keep going", `waitForNamed` waits out its deadline, and
a run spends twenty minutes deciding a control is missing from a screen nobody was looking at. The
first check to fail then reads as a finding about the app. `prepareDeviceForDriving` now wakes the
screen and keeps it awake (trap 189).

**A short `input swipe` is a fling.** This one had been wrong since `ui.ts` was written. The file
says its step is "deliberately much shorter than the screen" so consecutive views overlap; measured,
an 800px swipe over 250ms moved the shelf about 1400px, so the step was longer than the screen and
the guarantee had never held. A control between two views is never seen, and - the failure that
found it - a row's heading is carried off the top in the same movement that reveals its own
controls. An 800ms swipe is a drag and moves the distance it says (trap 190).

**Every shelf row draws an identically named control.** A plain lookup for "Record what happened"
opens whichever row is first in the hierarchy, so a run records a dose against the wrong medicine
while reporting the right name. `nodeNamedBelow` scopes a control to its row heading, and
`scrollToAndTapBelow` brings that heading to the top before looking, because a shelf row is taller
than any fixed step (trap 192).

**A control that is only just on screen is not a control you can press**, and this one was hiding
behind the fling. `scrollTo` stops the moment a name is anywhere in the hierarchy, and
`uiautomator` reports visible bounds - so a Save button entering view from the bottom is a
thirty-pixel strip whose centre is under the tab bar. The tap goes to whatever is drawn there, the
form stays open, nothing errors, and the run reports **FAIL - the form accepted every value and the
save produced nothing** about an app that saves perfectly well when the button is pressed. It only
appeared once the scroll stopped overshooting, which is the uncomfortable part: the harness had been
relying on a bug in its own scrolling to hit its targets. `scrollToAndTap` now checks
`isFullyVisible` - the reading the accessibility harness already uses - and nudges the control clear
of the edge it is cut off at (trap 194).

`AddItem` gives its `TextInput` the same accessible name as the label above it, unlike
`SetUpHousehold`, whose input announces "Name. <help>" against a label of "Name". It happens to work
because `nodeNamed` prefers a clickable node and an Android `EditText` reports itself clickable, but
it is luck rather than design (trap 191).

And one repeat worth naming as such: a launch Metro dropped was reported as **a save that produced
nothing**, by a check that only read the server afterwards. The previous session fixed the same
shape in the offline harness. It is now a parameter rather than a habit - `coldStart` retries once
and lives in `ui.ts`, and `personalCareCreatedCheck` takes a `submitted` flag so a run that never
reached the form says so instead of describing what a screen did (trap 195).

### State

4018 tests across 141 files, `npm run verify` exit 0. All ten device harnesses re-run against a
Pixel 7 / Android 16 emulator after the scroll change, and all ten green: `verify:device` 7/7,
`verify:device:a11y` 34/34, `verify:device:reminders` 9/9, `verify:device:update` 6/6,
`verify:device:offline` 8/8, `verify:device:profile` 4/4, `verify:device:caregiver` 5/5,
`verify:device:visitpack` 5/5, `verify:device:personalcare` 6/6, `verify:device:safety` 7/7. Their
judgements are covered by 305 tests that need no device.

One thing that reads like a regression and is not, recorded as trap 196: `verify:device:update`
run straight after `verify:device:offline` or `verify:device:reminders` reports `UPD-5` as
inconclusive, because the first deactivates every schedule in its cleanup and the second ends with
a `pm clear`. There are then no pending alarms for the update to preserve. Given an active schedule
it is 6/6, which is what the numbers above are.

What the session did not do, and why. `19`'s sign-up/sign-in/recovery stays at nothing measured,
because Phase 1.1 has not chosen an authentication provider (`BLK-010`) and inventing one is not
engineering. The remaining genuinely unblocked device work in that section is a low-storage run.
And the dose-write authorization conflict is documented rather than resolved (`DEV-049`,
`BLK-011`): three answers are defensible, each changes what an existing grant means, and choosing
one in passing is the thing the operating brief forbids.

---

## 2026-09-04 - The grant that said one thing and permitted another

Resumed from a clean tree at `15d997d` with `npm run verify` green at 4018 tests across 141 files -
the stated baseline, confirmed rather than assumed. No Kynviora process was running: no `tsx watch`
API, no Metro, no adb server, no emulator (trap 175's count came back zero rather than four). One
repo writer, one branch, nothing to reconcile. Booted the Pixel 7 emulator, and restarted the adb
server **after** it was up, because a server started first registers reverse tunnels that forward
nothing (trap 184).

### The decision, and the part of it that was easy to get wrong

`BLK-011` / `DEV-049`: a caregiver granted only `VIEW_MEDICINES` could write into somebody's dose
history, while the invitation screen listed that grant under "viewing" and said it allowed no
changes. Two decisions, both deliberate, both in writing, contradicting each other - `0004` and
`0020` scoping `dose_event` by reachability on purpose, and `caregiver.ts` grouping capabilities by
whether they change anything on purpose.

The product decision resolves it the third way `DEV-049` set out, and it has four parts. Three are
ordinary: `VIEW_MEDICINES` stays read-only, `RECORD_DOSES` becomes its own capability, and
`MANAGE_MEDICINES` keeps managing medicines. The fourth is the one worth reading twice - **no
existing grant acquires it**.

That part is a non-event and it took the most care to get right, because every instinct about a
migration says to keep working software working. Backfilling `RECORD_DOSES` onto every grant
holding `VIEW_MEDICINES` would have kept every existing caregiver recording doses, and it would
have been `DEV-049` all over again, arriving by migration instead of by policy: a capability in
somebody's grant that they never granted. It is also unsound in a way no later fix repairs, because
the set of owners who _would_ have ticked it is not derivable from a list that never offered it. So
`0021` widens the vocabulary, replaces one policy, and writes to no row of `caregiver_grant` - and
`db/doseEvent.test.ts` asserts each grant's capabilities whole rather than counting who holds the
new one, because a count would also pass if a migration had taken something away.

The mirror of that is `MANAGE_MEDICINES` not implying `RECORD_DOSES`, which looks wrong until you
say it out loud: nesting them would make the policy read a capability nobody ticked. Capabilities
are a set, not a ladder, and both tests say so.

### Where the change actually had to reach

The policy is four lines. What took the session is that a refusal the screen does not know about is
a person filling in a form for nothing - and `13` will not let the API say "you are not allowed",
so the refusal arrives as the same 404 an unknown item gives (trap 89). The screen therefore has to
be told separately, with the predicate the policy applies rather than a guess: `mayRecordDoses` on
`GET /v1/items/:id`, and on `GET /v1/items` as **one boolean for the page**, because a capability
is granted per profile and the list is filtered to one. A per-item answer would be the same value
repeated and would invite a screen to believe two medicines belonging to one person could differ.

The client narrows an absent value to `false`, and that has a real cost worth naming: a projection
row written by the previous build carries no `mayRecordDoses`, so an owner who updates and then
goes offline sees no dose control until the first shelf read with signal (`DEV-051`). The opposite
default would draw the control for every view-only caregiver reading a stale projection, queue the
write, and have the drain refuse it hours later - a dose somebody was told had been saved,
vanishing without their knowing, which is precisely what `DEV-048` exists to prevent. Deny by
default costs a control for a bounded window. The other way costs a record.

### What a device found that nothing else would have

`verify:device:doseaccess` is a new harness, seven checks, and it drives the half that lives on a
screen: the invitation form has to _offer_ the narrower choice, and the review step has to file it
under what the caregiver may **change**. A correct policy with no checkbox is not a fix - it leaves
an owner able to express "record doses" only by also granting "edit medicines", which is the
over-granting the split exists to avoid. `DOSE-2` is measured positionally, by where the sentence
falls relative to the heading, because both headings are on the same screen and a check for the
words is answered by the wrong one.

Its first run reported `DOSE-6` as **the dose control missing from the owner's own shelf row**,
which is exactly the regression this change could most plausibly cause. It was not. The device had
lost its `adb reverse` tunnel to the `adb kill-server` earlier in the session, every screen said
"No connection", and a check looking for a control read that as the control having been withheld.
The harness now establishes both tunnels itself and refuses to run if it cannot - a precondition
nobody should have to remember, and one whose absence produces a finding about the app.

Its second run found something real, and in shipped code. `verifyCaregiverAccess.ts` declares
`readonly caregiverUserId?: string` on its grant type where the route sends `granteeUserId`, so
every comparison evaluated `undefined !== CAREGIVER_ID`: `activeGrantsFor` counted **zero** whatever
the database held, `CAR-0`'s guard against a grant left behind by a crashed run could never fire,
`CAR-3` confirmed revocation by reading the same zero, and `clearPreviousRuns` revoked nothing
(`DEV-050`). The field being _optional_ is why TypeScript never said anything. It is required in
both harnesses now, so the next rename is a compile error rather than a check that quietly stops
looking - and `verify:device:caregiver` re-runs 5/5 with `CAR-0` and `CAR-3` reading real counts
for the first time.

The way it surfaced is worth keeping: it took a second harness against the same route to find it,
because this scenario needs two grants in sequence for one caregiver and therefore needs the
cleanup to actually work. A guard that never fires is invisible to the run it is guarding.

### State

4062 tests across 143 files, `npm run verify` exit 0.

`verify:device:doseaccess` **7/7 PASS** on a Pixel 7 / Android 16 emulator: the owner records
(`DOSE-0`), a caregiver granted only "Medicines" reads six events and is refused with 404
(`DOSE-4`), the form offers both choices separately (`DOSE-1`), the review screen files recording
under "able to change" (`DOSE-2`), the invitation carries exactly what was ticked (`DOSE-3`), the
same request answers 404 without the capability and 201 with it on one session with no sign-out
(`DOSE-5`), and the owner's own control still moves the history from 7 events to 8 (`DOSE-6`).

`verify:device:caregiver` 5/5 after the `DEV-050` fix, with `CAR-0` and `CAR-3` reading real grant
counts for the first time.

`verify:device:offline` **8/8 PASS**, which is the regression that mattered most: a dose recorded
with no signal still goes out under the key it first used, the server answers `idempotent-replay`
to two of three creates, and exactly one event exists. Tightening the insert policy did not disturb
the queue it protects.

`BLK-011` is closed and `DEV-049` with it. `DEV-050` and `DEV-051` are new and both are recorded
with what they cost.

### Then: what leaves the app without going through any of its guarantees

With `BLK-011` closed, the plan's three "immediate next work" items all need a decision or a
credential - the retention matrix, a licensed substance vocabulary (`BLK-003`), and Phase 5.5's
second observation (`BLK-007`) - so none of them is mine to take. Phase 9.2 is `IN_PROGRESS` and
names four MASVS categories as outstanding, two of which need neither: privacy leakage with
logging, and platform interaction with deep links.

`verify:device:privacy` is those two, and the first one is worth the run on its own. `verify:device`
proves the local database is encrypted, that its key is keystore-wrapped, and that four strings the
app stored appear nowhere in its bytes. A medicine name written to logcat walks around every one of
those: the log is readable by the platform and by anyone with a debug bridge, and nothing in this
repository governs it. The app's own source contains not one `console.*` call, which took thirty
seconds to check and proves nothing - what reaches the log is written by React Native, by Expo's
modules, and by whatever a library does with a response body it could not parse.

**The measurement lied before the app did.** The first scan found 204 lines carrying seeded medicine
names and not one of them was the app's: `uiautomator dump` writes the entire view hierarchy to
logcat as `AccessibilityNodeInfoDumper`, so every screen the harness read put its contents on the
log. A naive version of this harness would have opened with a security finding about an app that is
clean, which is a worse outcome than not having run it. The app's own pid is now scanned separately,
the system-wide pass names and excludes that instrumentation, and the report says how many lines it
removed - "clean" over a log that was mostly filtered away is a different claim from "clean" (trap
199).

The result is a genuine and useful negative: 241 lines from the app's own process and 26,825 from
everything else, none carrying a medicine name, a profile name, or a dose note minted minutes
earlier and typed in during the run. The note matters - the seeded names could conceivably sit in a
bundle string, but a note written in this run can only have come from the app handling somebody's
input.

`PLAT-2` fires the app's `BROWSABLE` `kynviora://` scheme from the shell, which Android treats as
another app, carrying a profile ID that is not this household's. It opens the app onto the shelf,
and the shelf shows exactly what an ordinary launch shows, because `shelf.tsx` takes the profile
from its provider and never from route params. That the scheme exists at all is `DEV-052`: Expo
Router registers it by default, nobody chose it, no feature uses it, and whether it should be
scoped or replaced by an App Link is entangled with the authentication provider Phase 1.1 has not
selected. Recorded rather than removed - removing it now would foreclose one of three options
nobody has weighed - and the condition worth remembering is that the day a screen reads a route
parameter, this stops being an unused declaration and becomes an input from an untrusted caller.

One more harness bug, and it is the same shape as the last one: the "ordinary launch" baseline was
read from wherever the previous step had left the app, which was the dose-recording screen, whose
heading names one medicine. Seven medicines compared against that one, and the run reported a deep
link as having changed which person's medicines were rendered. A comparison needs both sides
driven, and the baseline is the side nobody thinks to drive (trap 200).

`verify:device:privacy` 5/5 PASS on a Pixel 7 / Android 16 emulator.

### State, after both pieces

4082 tests across 144 files, `npm run verify` exit 0. Twelve device harnesses, of which four were
run this session against a Pixel 7 / Android 16 emulator: `verify:device:doseaccess` 7/7,
`verify:device:caregiver` 5/5, `verify:device:offline` 8/8, `verify:device:privacy` 5/5. Their
judgements are covered by 350 tests that need no hardware.

Closed: `BLK-011`, `DEV-049`, `DEV-050`. Opened: `DEV-051` (the bounded cost of deny-by-default on
a stale projection) and `DEV-052` (a browsable deep-link scheme nobody chose). New decisions:
DEC-116. New traps: 197 through 200, three of which are about a harness measuring itself.

What this session did not do, and why. The plan's three "immediate next work" items - the retention
matrix, a licensed substance vocabulary, Phase 5.5's second observation - each need a decision or a
credential, and inventing any of them is what the operating brief forbids. Phase 9.2's other two
outstanding MASVS categories are left for the same kind of reason rather than for effort: network
communication has no production endpoint to verify a certificate chain against (`BLK-001`), and
`14` scopes tampering "per the threat model" while `15` names no posture for it.

---

## 2026-09-04 - Three tasks off the list, and the four defects they turned up

Resumed from a clean tree at `0713b06` with `npm run verify` green at 4082/144. The three tasks
STATUS had named were taken in order. All three are done; what they cost is the interesting part.

### One: the tree nothing had ever checked

`apps/**` was outside the test run and outside the lint run, and the mobile typecheck was the whole
of its automated coverage. That is `DEV-043`'s standing explanation for eight call sites reaching
for `crypto.randomUUID()` on an engine with no `crypto`, and for every defect found since - all of
them by driving the app for twelve minutes at a time.

**Linting first, because it found a defect.** Twenty-two findings on the first run of ESLint over
that tree, ever. Twenty-one were declarations, redundant assertions, a disable comment for a rule
nothing runs, and three `new Date()` calls that are legitimately device-local and now say so per
site rather than by exempting the tree. The twenty-second is `DEV-053`: `EditItem`'s `onSave` closed
over `queueEdit` without listing it, and `queueEdit` changes identity when the encrypted store opens
and again when the session does. A save holding the first version calls a `queue` that returns
`false` before writing anything, and the edit is reported as failed and dropped.

**Then rendering.** A second Vitest project, because the two trees are two runtimes: React Native's
source is Flow-annotated JavaScript esbuild cannot parse and expects a native bridge Node does not
have, so `react-native` and the Expo modules resolve to stubs. What each substitutes and what it
therefore cannot measure is written at the top of it, and the platform stubs throw if anything calls
them - a test in Node that reached the keystore would be claiming coverage of what only
`verify:device` can measure.

The queries mirror `scripts/device/ui.ts` on purpose. `findByName` resolves an accessible name the
way `nodeNamed` does, prefers an interactive node the way `nodeNamed` prefers a clickable one, and
counts only host elements - a React component is not a view and has no counterpart on a device. The
two are then asking one question rather than two that happen to agree.

55 tests over the five places the device runs kept finding things.

### Two: measuring reachability where the controls actually are

`verify:device:a11y` reported 34/34 over the five destinations while `DEV-046` was a sheet three
taps in whose controls were below the fold with no way to reach them. "Every control is reachable"
was being measured exactly where the controls are fewest and the screen is shortest.

Four sheets now, at both font scales, surveyed rather than dumped: scrolled top to bottom with every
control judged on whether it was _ever_ fully visible. **66/66 PASS**, up from 34.

**The first run of it found `DEV-054`, and it was mine.** Eighteen minutes in, every check reported
`INCONCLUSIVE` - including the five destination ones that had passed for weeks. The app was not on
screen at all: the new `ShelfRow.test.tsx` had been written next to the component it tests, which is
inside Expo Router's route directory, and that directory is enumerated with `require.context`. The
test was a route, it was bundled, it imported `react-test-renderer`, and the bundle failed.

No gate could see it. `npm run verify` typechecks, lints and runs four thousand tests without ever
bundling the app, so everything was green over a build that could not start. `DEV-043`'s shape
exactly, arriving on the one tree that had just been given tests, and arriving _because_ it had.

Two further harness faults, both the shape of `DEV-050`: a fixed budget of twelve swipes that had
quietly stopped reaching the bottom of the Care list - which grows by one revoked grant per
caregiver run, on purpose, because `08.2` wants the audit trail - and a full-visibility requirement
before tapping that no tab bar can ever satisfy, since the outer tabs' edges _are_ the screen's.

### Three: a dose nothing could keep, described as kept

`19`'s low-storage scenario, and the last item on that list needing neither a credential nor a
decision. The condition is produced by removing write permission from the store's directory inside
the app's own sandbox, and proven by trying a write and requiring a refusal. It is a stand-in and
the harness says so: a full filesystem also fails a temporary file and Android's own bookkeeping.
It is the version that can be undone, which matters more - a harness that can wedge the device it is
measuring is one nobody runs twice.

It found `DEV-055`, in two halves. The loud one: four store calls started and not awaited, because
their result is a cache rather than somebody's data. Every one rejects under this condition, and
with no `catch` each became an unhandled rejection - which on the device drew React Native's error
banner **across the tab bar**, so the app could not be navigated at all.

The quiet one is what `12` is about. `queue` awaited `pending.put` and let the rejection escape.
Every caller renders "Recorded on this phone. It will reach Kynviora when you are back online." on
`true` and a failure on `false`, and a rejection is neither - so a person records a dose with no
signal, is told it is safe, and stops thinking about it. Nothing has their record and nothing ever
will.

`LOW-3` fails a run on **any** uncaught rejection now, which is the check that finds the next one
without a person reading a log. **5/5 PASS.**

### State

4184 tests across 152 files, `npm run verify` exit 0. Thirteen device harnesses; three run this
session on a Pixel 7 / Android 16 emulator - `verify:device:a11y` 66/66,
`verify:device:lowstorage` 5/5, and the earlier `verify:device:doseaccess` 7/7 still standing.

`DEV-043` is closed. `DEV-053`, `DEV-054` and `DEV-055` are new and resolved. Traps 201 and 202.

**What is next is nothing, and that is the finding.** Every remaining item in the plan's own
"immediate next work" waits on the retention matrix, a licensed substance vocabulary (`BLK-003`) or
an OCR provider (`BLK-007`). Every remaining `19` device scenario waits on an authentication
provider (`BLK-010`), Phase 2.2, or `BLK-007` - except camera and file permissions, which is small
ordinary work and is the one thing a next session could pick up without asking anybody anything.
Phase 9.2's last two MASVS categories are decision-shaped too: there is no production endpoint to
verify a certificate chain against (`BLK-001`), and `15` names no posture for tampering.

---

## 2026-09-05 - The sweep that ran itself, and the hour it is still late by

Resumed from a clean tree at `e5bdac3` with `npm run verify` green at 4403/165, reconciled against
git, STATUS, DECISIONS, DEVIATIONS, BLOCKERS and `docs/RETENTION.md` before anything was changed.
Everything the handoff claimed held, including the one detail worth checking rather than trusting:
`services/worker` existed as an empty, untracked directory. Nothing scheduled the purge.

That was the task, and it was the right one. `runPurgeSweep` had been correct and measured since
`0023`; it had simply never been called by anything but a person at a terminal. So the thirty-day
deadline in `docs/RETENTION.md` - and the twenty-four hour one, and the seven-day one - were
commitments the code could keep and the operation could not. It was the only place in this system
where a promise made to a person outran what the system does; everything else outstanding is a
feature that is absent and says so.

### What the worker had to be, rather than what a worker usually is

Four decisions, each of which had a shorter wrong answer.

**The schedule is in the database, not in a timer.** Every pass reads the last run out of
`retention_run` and computes how long to wait. A `setInterval` would have been two lines and would
have been wrong three ways at once: a worker redeployed every five minutes would sweep every five
minutes, a worker down for a week would wait a full interval after coming back, and neither failure
announces itself. The property that follows is the one worth naming - **restarting the process does
not restart the countdown** - and it gets its own test, twice, once as arithmetic and once as two
consecutive loops against one database agreeing on when the next sweep is.

**The lock is a lease row, not `pg_try_advisory_lock`.** The advisory lock is shorter and is wrong
twice over. It is session-scoped, so it is re-entrant within a session, which makes it exactly
untestable against a single-connection database (DEC-037) - the test would have proved nothing and
looked like it proved something. And it is invisible: an operator asking why no sweep has run for
two days cannot query it. A row can be read, can be contended in a test by writing somebody else's
holder into it, and expires by itself, so a worker killed mid-sweep recovers without anybody
logging in.

Worth being clear about what the lease is **not**. It is not what makes the purge safe. `0023` is:
every deadline is a policy attached to `kynviora_retention`, so two concurrent sweeps would delete
the same due rows twice and the second would find none. A bug in the lease wastes work; it cannot
widen what may be deleted. That asymmetry is why a lease was proportionate and a distributed lock
service would not have been.

**Each of the seven categories is a transaction, and PARTIAL is not SUCCEEDED.** The sweep used to
be a function body: twenty-four statements in order, and the first one to raise abandoned the other
twenty-three. So it became data - `PURGE_CATEGORIES`, grouped by what has to succeed together -
with two consumers. `npm run purge` still runs the whole plan and stops at the first failure, which
is what a person at a terminal wants. The worker runs each category in its own transaction and
records an outcome for each.

The outcome vocabulary is where the actual protection is. A run in which one category raised is
`PARTIAL`, and `PARTIAL` is not `SUCCEEDED` - not in the schema, not in the schedule (it retries in
five minutes rather than an hour), and not in the log line. A job that reported success because most
of it worked is precisely how a table quietly stops being purged for a year while a dashboard stays
green, and that failure mode gets the most explicit test in the file: a category is made to fail by
**revoking a grant**, so the `42501` is a real one from a real statement, and the assertion is that
the run is recorded as `PARTIAL` and specifically not as `SUCCEEDED` - while the other six
categories are proved to have purged what was due.

**What a failure may say is a step label and a SQLSTATE.** Not the driver's message. `detail` on a
Postgres constraint violation quotes the offending row's values verbatim, and a retention job's
output outlives the record it is about - it is the last place a deleted medicine could come back,
into a table nobody would think to look in. So `PurgeStepFailure` carries the step's own label from
the sweep's closed vocabulary, the code is five characters from an alphabet the column checks, and
a test dumps every row of both history tables and asserts that neither medicine name, the owner ID
or the profile ID appears anywhere in them.

### Fail-closed, for a failure that is silent

A missing authenticator is loud: every request fails, and `main.ts` has refused to start without one
since Stage 7. A missing sweep is silent, and stays silent for exactly as long as it takes somebody
to ask why a table has grown. So `KYNVIORA_RETENTION` is `worker`, `external` or `none`, it defaults
to `none` so that the check has something to catch, and `none` in production without
`KYNVIORA_ALLOW_UNSWEPT_START=1` is a startup failure naming all three ways out.

The acknowledgement is not a loophole to be embarrassed about. There are real reasons to run without
a sweep - a read-only replica, a staging copy, a migration window - and none of them should require
pretending one is happening somewhere.

### Where it runs, and where it is honest about not running

Two arrangements, one of which works today. PGlite is a single writer (DEC-037), so a separate
worker process against the API's data directory would purge from a stale copy and then write that
copy back over everything the API had done - which has already silently destroyed data in this
repository once. `KYNVIORA_RETENTION=worker` therefore hosts the loop on the connection the API
already holds, which is the same reasoning that put the staff surface in one process, and it becomes
two deployments unchanged when `BLK-001` clears.

`npm run worker` exists and **refuses** a local data directory without an explicit override, with an
error that names the reason rather than the flag.

There is no cloud scheduler and nothing here pretends there is one. The worker keeps its own
schedule, which is the shape that works with or without an orchestrator in front of it - and if one
is later added, the lease and the schedule make a duplicate invocation a no-op rather than a second
sweep.

Run as a real process against a scratch database with a five-second interval, it swept every five
seconds for forty-six seconds: `retention.loop.started`, then eight `run.started`/`run.finished`
pairs at 22.970, 27.989, 33.001, 38.011, 43.023, 48.030, 53.052 and 58.064. `outcome: SUCCEEDED`,
`categories_attempted: 7`, `categories_failed: 0`, `rows_purged: 0`, a real `duration_ms`, and not
one field that is not a count, a code or an identifier.

### Two defects, and one of them was a test doing its job

**The grant invariant had been right for the wrong reason.** `db/retention.test.ts` asserted that
the retention role holds INSERT on none of its tables, and the worker's run history needs INSERT to
exist at all. The easy move was to add an exception. The right one was to notice what the rule was
actually protecting: its own comment says "a role that could INSERT could manufacture the history it
is trusted to remove", and that danger is about tables the role can **delete from**. The invariant
is now that no table grants this role both INSERT and DELETE - which catches the original threat,
still holds on all twenty-six tables, and keeps holding if a fourth bookkeeping table appears. The
worker's three tables are also spelled out privilege by privilege, because "the worker needs to
write things" is how a bookkeeping table quietly acquires DELETE.

**A blocked UPDATE is a miss, not a refusal.** A test asserting that a closed run cannot be
rewritten was written with `expectDenied` and failed - correctly. The RLS `USING` clause makes a
closed row invisible to the statement, so Postgres reports zero rows changed rather than raising,
which is exactly what the harness's own docstring says about SELECT and UPDATE. The assertion is now
on the row count and on the row still saying `PARTIAL` afterwards, which would also catch the policy
having been dropped entirely - the error-shaped version would not have.

### The gap that is left, written down rather than rounded off

`DEV-063`. Every eligibility floor in `0023` sits **exactly on** its deadline: `purge_floor()` is
`now() - interval '30 days'`, Visit Pack content becomes purgeable at `expires_at + 24 hours`. So a
discrete sweep purges a row somewhere in `[deadline, deadline + interval]`, and **no finite interval
makes the upper end of that equal the deadline**. Sweeping is discrete; the promise is not.

It would have been easy to leave that implicit behind a small default and call the deadline kept.
The interval is instead named as what it is - the size of the gap between what the matrix promises
and what the system does - defaulted to an hour, and **capped at 24 hours by the config reader**,
because that is the shortest deadline in the matrix and an interval longer than a deadline could
more than double the life of the content it governs.

Closing it properly means giving the floors a margin, which changes what the RLS policies admit -
a change to the security boundary `0023` is careful about, and one that wants deciding rather than
doing. The arithmetic is in `docs/RETENTION.md` section 8.3 so the choice is not made by whoever
next edits a default.

### The deadlines, finally measured at the microsecond

`db/purgeDeadline.test.ts`. `purge.test.ts` proves the sweep purges what is due with fixtures at 31
days and 3 days - comfortably either side. This asks where the line is, because "within 30 days" is
a number somebody will be held to and `<=` versus `<` is the whole of it.

`now()` is constant within a transaction, so a fixture inserted at `kynviora.purge_floor()` and read
back in the same transaction is exactly on the line rather than a few milliseconds past it, and a
sibling one microsecond later is exactly off it. `SET LOCAL ROLE kynviora_retention` inside that
transaction makes the answer come from the **policy** rather than from a predicate the test wrote,
and the role and its non-superuser status are asserted first, because a superuser bypasses RLS and
every boundary would read as inclusive (DEC-005). Six deadlines, both sides of each.

The same file finally states the two halves of a deletion in one place and in order: an owner
deletes a medicine, cannot see it or its dose history in the very next statement, **and the row is
still physically there** - a sweep that day removes nothing, and only once `deleted_at` reaches the
floor do the medicine and its doses go. Inaccessible is not gone, the matrix promises both at
different times, and conflating them is how a product tells somebody their data is deleted while it
is on disk with no stated end date.

### Then: observability nobody could observe

`0026` granted the run history to `kynviora_retention` alone. That role is `NOLOGIN` and is used
by exactly one process, so a sweep that had not run for a week, or a category failing every night,
was recorded perfectly and visible to nobody. It was observability in the sense that a black box
nobody recovers is a flight recorder, and it was worth fixing in the same session rather than
noting as future work - the previous unit's own claim to be observable depended on it.

**A function rather than a grant.** The obvious fix is `GRANT SELECT ON retention_run TO
kynviora_service` and it is wider than the question: the operations surface needs five numbers,
and a table grant would let every service operation in the system read every run row forever,
because a grant with one consumer is still a grant. `kynviora.retention_health()` is
`SECURITY DEFINER` and returns five aggregates, which is the same reasoning `0023` gives for
`evidence_is_unattached` and applies for the same reason - the answer is small and the table it
comes from is not.

**Two of the five metrics are the whole point.**

`retention_never_swept` is a separate metric rather than an extreme value of the age beside it,
and it exists because of a trap the projection already had: `ageMs` answers **zero** for `null`,
which is right for "the queue is empty" and exactly backwards for "no sweep has ever completed".
An operator alerting on `retention_last_successful_run_age_ms > threshold` would read a system
that has never purged anything as one that just did. `sources_never_successfully_checked` exists
for the same reason and this follows it.

`retention_categories_failing` counts categories whose **most recent** attempt failed. It is
self-clearing - non-zero exactly while some promise in `docs/RETENTION.md` is not being kept, back
to zero by itself when that category next succeeds - which is what makes a `PARTIAL` run alertable
with no window and no threshold. That matters here specifically: `BLK-008` records that no
threshold is approved, so a metric needing one would have been a metric nobody could act on.

And `retention_last_successful_run_age_ms` counts only `SUCCEEDED` runs. A later `PARTIAL` sweep
must not reset the age and hide the gap, because a sweep that skipped a category did not keep that
category's deadline - which gets its own test, with a `SUCCEEDED` run at 09:00 and a `PARTIAL` one
at 11:00, asserting the age is still three hours rather than one.

### A third defect, in the console

The staff console renders metrics generically by key, so the new ones appear with no console
change - which is how the defect arrived. `metricValueText` renders a millisecond metric of zero
as **"nothing waiting"**, queue wording that is right for the two queue ages and reads as all-clear
beside a retention age, where zero means either "no sweep has ever completed" or "one started
within this minute".

Zero is now a property of the metric rather than of its unit:
`retention_last_successful_run_age_ms` renders as "never, or just now", and the
`retention_never_swept` reading in the same table resolves which. Worth catching, because the page
would have been reassuring and wrong at exactly the moment it mattered most.

### Result

`npm run verify` exit 0. 4510 tests across 170 files. Migration `0027` adds one function and no
tables, and the service role that reads it still cannot select a row from any of `0026`'s three.

---

## 2026-09-05 - The channel a delivery took, which nothing wrote down

The next task STATUS names is the digest (`DEV-033`), and reading it turned up a prerequisite that
is worth having on its own.

`DEV-033` says a digest is assembled from "`alert_delivery` rows planned onto the digest channel".
There were no such rows to find. `deliveryDecision` has decided a channel **per recipient** since
DEC-119 - a caregiver in London looking after somebody in Kolkata must not be woken at four in the
morning because the household's night is elsewhere - and `dispatchAlert` acted on that decision and
then discarded it. The row recorded that a delivery happened; it did not record whether anything
reached a device.

The only surviving trace was a profile-level summary inside an `audit_event` detail blob: **one**
channel for a dispatch that may have made six different decisions. So the question a person
actually asks - "why was I not notified?" - had no answer at the granularity it is asked at, and
the digest had no candidate set.

`0028` adds `channel`, `channel_reason` and `held` to `alert_delivery`, and `dispatchAlert`
computes each recipient's own decision **before** writing their row rather than after.

**Nullable, and that is the honest choice.** Rows written before this migration took a channel
nobody wrote down, and there is no value to backfill them with. `IN_APP_ONLY` would be a guess that
reads as a fact, and a default is precisely how a guess becomes one. NULL means "written before the
channel was recorded", the three columns are absent together, and a reader looking for digest
material asks for `channel = 'DIGEST'` - which excludes them without needing to know why.

**Two constraints move an invariant out of control flow and into the schema.** Only an interrupt
can be **held**, and a hold has exactly one reason. Both are true today as properties of which
branch of `deliveryDecision` returned, which means they are true only for as long as nobody edits
that function without reading it. Holding a digest line is meaningless - there is no moment it was
going to appear - and a held digest would be a lower urgency wearing the language of a deferred
alert.

**The test that justifies the column being per row** puts one recipient in Kolkata and one in
London, sets the profile's quiet hours to 22:00-07:00, and dispatches a `HIGH` alert at 20:00 UTC -
01:30 in one place and 21:00 in the other. Two rows, two answers: one held, one not. The
profile-level audit detail could not have expressed that even in principle.

### Result

`npm run verify` exit 0. 4524 tests across 170 files. `DEV-033` is updated rather than closed: one
of its two stated reasons - "there is no scheduler in this build" - is no longer true, and the
other, `BLK-009`, still is. What remains of it is an assembler, and every input it needs now
exists.

---

## 2026-09-05 - The digest, gathered in the recipient's own morning

`DEV-033` has been open since Stage 7: `MEDIUM` and `LOW` events are classified onto the digest
channel and nothing gathers them. It recorded two reasons and both were true when it was written -
nothing runs on a cadence, and nobody knows what time it is where anybody is. Both stopped being
true this session and the one before it, so the deviation closes.

### Four decisions, and one of them points the opposite way to its own precedent

**09:00, in the recipient's own morning.** The hour is theirs rather than a server's, for the
reason DEC-119 gives about quiet hours: a caregiver in London looking after somebody in Kolkata has
their own morning.

**And somebody whose zone nobody knows gets no digest at all.** That is the opposite of DEC-119's
rule for the same missing input. For quiet hours, unknown means "do not hold" - erring toward
delivering, because an alert waiting for a window that never ends is the worse failure. For a
digest, unknown means "do not assemble", because assembling at a guessed hour would mean telling
somebody "here is your morning" at four in the morning, and because their events are already
reachable in the app either way. Both rules err away from the harm specific to their own mechanism,
which is why they differ - and it is worth saying out loud, because "be consistent with DEC-119"
would have produced the wrong answer here.

**The re-read that decides is done as the recipient.** Choosing who is due spans every recipient
and is privileged. Deciding what each of them may still see is row-level security's question, and
answering it any other way would have meant reimplementing the caregiver capability check inside a
background job where nobody would look at it again. So the alert behind each candidate is re-read
under `withUser(recipient)`, and `alert_read` - which admits `state = 'PUBLISHED'` plus
`VIEW_SAFETY` - does the rest.

The consequence is that a withdrawn alert, a superseded one and one whose reader's grant was
revoked all arrive as `NO_LONGER_VISIBLE`. That is accepted rather than worked around: a digest
that said "this was withdrawn" about an alert the reader is no longer entitled to see would be
answering from a position they do not occupy. Both cases are tested by revoking the real thing -
the publication, then the grant - rather than by handing the assembler a state, because a stub
would have measured the stub.

**A row per candidate considered, not per item included.** "Why is this not in my digest" is a
question a digest generates and is unanswerable from a list of what survived. And it is what stops
a dropped item being reconsidered every morning for the rest of time: an alert withdrawn on Tuesday
is still withdrawn on Wednesday, and a candidate query asking only "which deliveries are in no
digest" would re-answer a settled question daily and grow without bound. `UNIQUE
(alert_delivery_id)` makes considered-once a property of the schema, and the test for it asserts
that the recipient is not even **considered** on the second day.

### No lease, and the contrast with the purge is the point

The purge needed one (DEC-121) because its idempotence comes from policies rather than constraints:
two sweeps racing would both issue the same statements. The digest's idempotence is a **unique
index**. Two workers assembling the same recipient's digest for the same local date produce one row
and one loser, and a delivery is admitted to exactly one digest ever - so a lease would protect
nothing the schema does not already protect, and a conflict is counted as a conflict rather than
treated as a failure.

The two jobs therefore share a worker **pass** rather than a lease, each with its own try/catch. A
purge that failed does not stop a digest being assembled, and neither can hold the other's
resources.

### Retention is inherited rather than invented

A digest is a derived projection of `alert_delivery`, so it is purged from it: an entry goes with
the delivery it references, and the digest goes once it has no entries left. Giving it a period of
its own would have meant a threshold nobody approved sitting beside a table of thresholds somebody
did.

Two details fell out of that. The entry must be deleted **before** the delivery it references,
because the foreign key would otherwise cascade and a cascade is issued by the referencing table's
owner rather than by the retention role (`0023`). And `digest_is_empty` is `SECURITY DEFINER` for
the reason `evidence_is_unattached` is: a subquery inside a policy runs as the caller and would be
filtered by the entry table's own retention policy, so a digest whose entries all belong to live
profiles would look empty and be deleted - wrong in the direction that loses data, and wrong
silently.

A digest with nothing in it is never created, and that is a schema constraint rather than a
convention: the purge removes a digest once it has no entries, so an empty one would be created and
deleted on the same day for two entirely unrelated reasons.

### One defect, in two test files

Adding a foreign key to an append-only table breaks the only reset those tests have.
`alert_delivery` refuses every `DELETE`, so both suites clear it with `TRUNCATE` - which is
permitted precisely because it is neither an `UPDATE` nor a `DELETE` - and a `notification_digest_entry` referencing it made that statement fail with "cannot truncate a table referenced in a
foreign key constraint". Sixty-one tests, none of them about digests.

Fixed by naming both tables rather than adding `CASCADE`, so a child table added later fails
loudly in the same place instead of being silently emptied - which is the reasoning the purge sweep
already gives for not using the cascades it has.

### What is left, and where it is recorded

`DEV-033` is **closed**: events classified for a digest and never gathered into one no longer
happens. Two things it did not cover are recorded separately rather than hidden inside a closed
deviation. Sending a digest stays on `BLK-009`. Showing one is `DEV-064`, and it is deliberately
not next: the Safety Inbox already shows every one of these events, so what a digest surface should
be **instead of** it is a product question, and building a second list of the same rows before that
is answered would be inventing a design nobody asked for.

### Result

`npm run verify` exit 0. 4561 tests across 172 files, up from 4524 across 170. Migration `0029`
adds two tables holding nothing renderable - a reference, a revalidation outcome and two counts -
readable by the recipient and by nobody else, not even the profile owner whose household the events
came from.

---

## 2026-09-05 - A dose reported as recorded that was never recorded

`DEV-031` has been on the list since `0016` gave `owned_item` a per-profile idempotency key and
said in writing that changing `dose_event`'s shipped one was not a thing to do in passing. This is
that change, done on its own.

`0004` made `dose_event_idempotency` UNIQUE on `client_operation_id` **alone**, across every
household in the system. So a UUID one household had already used made another household's INSERT
conflict; the route read the conflict as a retry, re-read the row under row-level security, found
nothing - the row belongs to somebody it cannot see - and answered `200` with
`{ id: null, replayed: true }`.

**A person is told their dose was recorded and no dose is recorded.** Nothing leaks and nothing of
anybody else's changes: the row suppressed is the caller's own. But it is the same class of failure
as `DEV-055`, where a screen said a dose was kept over a store that could not keep it, and this
codebase does not leave that class open on the grounds that it is hard to trigger.

`0030` narrows the index to `(owned_item_id, client_operation_id)`. The **item** rather than the
profile, because the item is the identifier the dose route actually has - the request names
`ownedItemId`, so the replay read can be scoped to exactly what the caller asked about, and the
narrower the scope the smaller the set of writes one key can refuse.

Worth saying, because rebuilding a unique index on a populated table is usually the risky part:
**narrowing one cannot fail on existing rows.** A set that was globally unique is unique within
every item by construction. The reverse would not be, which is why this direction needs no data
audit and the opposite one would have.

The route's replay read is scoped to the item too. `{ id: null, replayed: true }` survives and now
means exactly one thing rather than two: already recorded, and not readable by this caller. That is
a real case since DEC-116 gave `RECORD_DOSES` its own capability - somebody may be entitled to
record a dose and not to read the shelf it belongs to - and it used to be indistinguishable from
"somebody else's key blocked you".

### The test was run against the old index before it was trusted

A regression test that passes before the fix proves nothing. So the migration was temporarily
reverted to the global index and the cross-household test re-run: it failed with
`expected 200 to be 201`, which is the false replay this deviation describes, reproduced rather
than reasoned about. Then the fix was restored and it passed.

The schema-level assertion reads `pg_indexes` rather than behaviour, so a future migration that
widened the index back fails in `db/shelf.test.ts` rather than in a route six months later.

### Result

`npm run verify` exit 0. 4567 tests across 172 files. `DEV-031` resolved - the two idempotency
guarantees in this codebase now have the same shape, which was the reason it was on the list at all.

---

## 2026-09-05 - Four closed vocabularies that existed twice with nothing checking they agreed

Housekeeping on the three migrations this session added, and it is not cosmetic.

`retention_run_category.category`, `retention_run.outcome`, `alert_delivery.channel`,
`alert_delivery.channel_reason` and `notification_digest_entry.outcome` are each declared **twice**:
a `const` array in TypeScript and a `CHECK` constraint in SQL. The duplication is deliberate - the
constraint is what makes the set true of the data rather than true of the code that happens to
write it - and it has exactly one failure mode, which is that the two stop agreeing.

The direction that hurts is silent in a specific way. Adding a member to the TypeScript array
without adding it to the constraint compiles, typechecks, and raises `23514` at run time - in a
background job, on the one category or outcome nothing happened to exercise. Adding one to the
constraint without adding it to the array is quieter still: nothing fails at all, and a value the
database accepts is one no reader knows about.

`db/schemaVocabulary.test.ts` reads `pg_get_constraintdef` and compares the literals in it with the
array. Reading the constraint rather than attempting an insert per value is what catches the quiet
direction too: an insert-based check can only find members the constraint refuses, never members
nobody declared. `packages/domain/src/observability.test.ts` already does this for metric units,
one file over; this is the same guard where the second declaration is in SQL.

Two vocabularies had to become runtime arrays to be checkable at all. `RetentionRunOutcome` and
`PurgeCategory` were bare unions - invisible to a test, which is how two closed vocabularies drift
apart in the first place. Both are now `as const` arrays with the type derived from them, which is
the pattern every other vocabulary in this codebase already used.

**Verified by drifting it.** A category was added to the TypeScript array without touching the
migration, and both checks fired - the vocabulary comparison and the separate one asserting that
every declared category has steps behind it. Then it was removed and they passed.

### Result

`npm run verify` exit 0. 4573 tests across 173 files.

---

## 2026-09-05 - The database stopped being a workaround

`BLK-001` has been open since Stage 0 and said the same thing throughout: migrations and policies
run against PGlite, which is genuine PostgreSQL 18.3 in WASM, and that validates schema,
constraints, triggers and policy logic but **not** managed-platform behaviour, pooling or
extensions. A Supabase project now exists - `kynviora-dev`, under Luna Luce, Postgres 17.6 in
ap-south-1 - so this is the first session where that sentence could be tested rather than
repeated.

**All thirty migrations applied on the first attempt, unmodified.** That is the one part of this
that was not work: the portability claim in `BLK-001`'s workaround ("written as portable SQL with
no Supabase-only syntax") held exactly as written, across a two-major-version gap in the other
direction from the one anybody plans for - 18.3 in the tests, 17.6 on the platform.

Everything else was work, and three of the four findings are things a single-connection engine
cannot have.

### The migration credential is not the platform's, and that is a security property

Supabase ships default privileges keyed to the **creating role**: every table `postgres` creates
in `public` grants `arwdDxtm` - all of them - to `anon`, `authenticated` and `service_role`. The
first of those is the role behind the project's publishable key, and PostgREST serves `public`.

So the obvious way to do this - apply the migrations with the platform's own credential, which is
what the management connector uses and what every quickstart shows - would have **published
fifty-seven health tables to the anonymous API key**. Deny-by-default RLS would have refused the
rows, and `schema_migration` has no RLS to refuse with. A defence in depth doing all the depth on
its own is not one.

Default privileges are per-creator, so a table created by `kynviora_migrate` inherits none of
them. `db/managedParity.test.ts` asserts the outcome rather than the intent, in two halves: every
table in `public` is owned by a Kynviora role, and no PostgREST role holds `SELECT`, `INSERT`,
`UPDATE` or `DELETE` on any of them. Measured: **0 of 58 tables reachable**.

### Two credentials, and no fallback between them

`KYNVIORA_DATABASE_URL` is a `NOINHERIT` login role that holds nothing of its own and is a member
of `kynviora_app`, `kynviora_service` and `kynviora_retention`, so every statement must `SET ROLE`
into one of them first. `KYNVIORA_MIGRATE_DATABASE_URL` is a separate role that owns every object
and is used by one command. There is deliberately no fallback from either to the other, because a
fallback collapses them into one credential holding both powers.

`NOINHERIT` is the half worth arguing for. With `INHERIT` the login role would carry the union of
all three on every connection, and a statement that forgot to switch would run with all three
while looking perfectly ordinary.

**The runtime adapter does not apply migrations.** `createRuntimeDb` does, because PGlite is one
process opening one directory. A shared database migrated by whichever replica booted first is a
schema change racing N processes, and the runtime credential could not do it anyway.

### The pool is the part that could go wrong quietly

Identity here is a session GUC and privilege is a session role. Both belong to a **connection**,
and a pool hands connections to other people.

- A connection is reset in a `finally` - `ROLLBACK`, then `RESET ROLE`, then the GUC - and
  **destroyed rather than returned if the reset itself failed**. Whether the callback failed is
  deliberately not consulted: a failed callback on a resettable connection is ordinary, and a
  failed reset never is.
- The `ROLLBACK` is unconditional and is not tidiness. The callbacks in this codebase open their
  own transactions (`caregiver.ts`, `visitPack.ts`, `retentionRun.ts`, `digestRun.ts`), so the
  adapter must **not** wrap them in one - a nested `BEGIN` is a warning and the inner `COMMIT`
  would commit the outer scope. A callback that threw mid-transaction would otherwise hand back a
  connection holding an open transaction, whose work the next request could commit.
- `statement_timeout` and `idle_in_transaction_session_timeout` are set per physical connection,
  so a connection that escapes the checkout path is still bounded.

### Transaction pooling was configured, and the adapter refused rather than served

The first parity run pointed at Supavisor's **transaction** mode (port 6543) and the adapter
raised `Expected role kynviora_app but the session is kynviora_runtime` - which is exactly right,
and is the finding worth recording.

Under transaction pooling a different server connection may serve each statement, so `SET ROLE`
is gone by the next one. Every policy would then evaluate against the login role, which is a
member of nothing it has switched into - so every read returns **nothing**, which on a screen is
indistinguishable from an empty household. That is the failure this had to not have.

Two defences, and only one of them is deterministic. `assertSessionScoped` runs at startup, sets a
role in one round trip and reads it back in another - but with one connection and no contention
Supavisor may keep the same backend, so it passed. **The per-request check is the guarantee**:
`SET ROLE`, then a second round trip that sets the identity and reads back `current_user`,
`rolsuper` and `rolbypassrls` together. It cannot be fooled by luck, and it fails closed.

`rolbypassrls` is new here and is a managed-platform concern specifically. It is one statement
away, it is invisible in every policy, and it makes every negative authorization test in this
repository pass while asserting nothing. Supabase grants it to `postgres` by default.

### TLS is pinned rather than turned off

Supabase's pooler presents a chain rooted at _Supabase Root 2021 CA_, a private root, so
`rejectUnauthorized: true` fails against the public trust store and the widespread answer is
`rejectUnauthorized: false` - encryption without authentication, which makes an interception
undetectable. The root was fetched over a publicly-trusted channel and its SHA-256 compared with
the chain the pooler actually presents; they match
(`8070:25AD:50D4:...:07D0:7B72:E6CA:FA`). It is committed as
`db/certs/supabase-prod-ca-2021.crt` and verification stays on.

### Two things the parity suite got wrong before it got them right

**The retention role can read `owned_item`, and that is correct.** The first version asserted a
permission error and got a result set. `DELETE ... WHERE deleted_at < purge_floor()` reads the
column it filters on, so the grant has to be there. What bounds the role is the **policy**, and
the test now asserts the thing that is actually true and actually protective: a live item is
invisible to the retention role, and a `DELETE` naming it by primary key removes **0 rows**. The
grant is asserted separately, so the two are not confused again.

**There is no privileged teardown, on purpose.** Nothing reachable from the runtime credential can
delete the suite's fixtures: `kynviora_service` holds no `DELETE` on any of them (DEC-117 -
removal is revocation then purge), and the retention policies admit only rows past a thirty-day
deadline. Every available cleanup - a `BYPASSRLS` role for tests, a temporary `NO FORCE`, the
platform's own credential - would weaken the exact boundary the suite exists to prove. The fixture
is **idempotent** instead: fixed IDs in a UUID namespace nothing else uses, inserted with
`ON CONFLICT DO NOTHING`, so a second run reuses the first run's household rather than adding one.

### Result

`npm run verify` exit 0: 4,573 passed, **32 skipped** - the parity suite, which skips as a whole
file without `KYNVIORA_DATABASE_URL` so there is no half-run. Against `kynviora-dev`:
**32 passed**, covering schema and checksum parity for all thirty migrations, RLS enabled **and
forced** on all 57 application tables, at least one policy on each, 188 policies in total, the
three roles' privilege boundaries, seven RLS negative cases, and six properties that only exist
once connections are pooled.

`BLK-001` is not closed. What it now says is much narrower: the API and the worker have not yet
been run against this database, and no extension, backup or load behaviour has been touched.

---

## 2026-09-05 - Two processes on one database, which is what the lease was written for

`retention_lease` has existed since `0026` and has never had two workers. PGlite is a single
writer (DEC-037), so the only arrangement that could sweep the development database was the loop
running **inside** the API process - and a lease protecting one process from itself has not been
contended. `docs/RETENTION.md` 8.2 said as much in a table: "its own process ... when `BLK-001`
clears".

It has cleared. This is the deployment shape running for real.

### One place decides which database a process opens

`openRuntimeDb` - `KYNVIORA_DATABASE_URL` set means managed, absent means the local directory.
The switch is the connection string rather than the data directory, because the data directory has
a default and so can never mean "no local database".

Both entry points log which they chose, before serving anything:

```
{"code":"api.database.opened","kind":"MANAGED_POSTGRES","target":"aws-0-…pooler.supabase.com:5432/postgres"}
{"code":"worker.database.opened","kind":"MANAGED_POSTGRES","target":"aws-0-…pooler.supabase.com:5432/postgres"}
```

The credential never appears; the host and database do. A process that quietly opened an empty
local database when it was meant to reach a managed one looks exactly like a database with no data
in it, which is the slowest possible way to find out.

**The worker's single-writer refusal is now scoped to the case it is about.** It used to fire on
"this process has a data directory configured", which is always true. It fires on "this process
has a _local_ data directory and nothing said it may", which is the actual hazard.

**`MainConfig.databaseUrl` is required rather than optional**, so all three test configs had to say
`databaseUrl: null` out loud. That is deliberate: a test that reached the real project would write
synthetic households into it and read another run's rows back.

### What was run, not simulated

`npm run dev` and two `npm run worker` processes, all three against `kynviora-dev` at once.

- The API seeded its synthetic household into Supabase, served `/v1/profiles` and `/v1/items` for
  the owner, returned **`{"items":[]}`** to a stranger asking about the same profile, and **401**
  with no header at all.
- Worker one swept every five seconds: eight categories per run, `SUCCEEDED`, real durations
  between 3.1 and 4.9 seconds - which is what eight transactions to Mumbai and back cost.
- Worker two, started forty seconds later, wrote `retention.run.skipped` /
  `reason: LEASE_HELD` on the passes it lost and swept on the ones it won. Two holders,
  interleaved, in the run history.

**Zero overlapping runs across the entire history.** Asked of every executed run in the database
rather than of the pair a test started:

```sql
SELECT count(*) FROM retention_run a JOIN retention_run b
  ON a.id < b.id AND a.started_at < b.finished_at AND b.started_at < a.finished_at
 WHERE a.outcome IN ('SUCCEEDED','PARTIAL','FAILED') AND b.outcome IN (...);
```

`ABANDONED` runs are excluded, and the exclusion is not a convenience: a reaped run's
`finished_at` is when somebody **noticed** it was dead, not when it stopped, so its recorded span
deliberately overstates. A test asserting the invariant over those would be asserting something
false about a column that is doing its job. The suite also asserts more than one distinct holder,
because "no two runs overlapped" is trivially true of a history written by one worker - which is
every history this project had until today.

### The run history cannot be rewritten, and that cost a test two attempts

The overdue-sweep test wanted "the last sweep was three hours ago" and tried to backdate the run
rows. `0026` refuses: `retention_run_close` admits only `USING (finished_at IS NULL)`, so a
finished run cannot be re-dated, re-outcomed or quietly recounted, and there is no DELETE policy at
all. That is the schema working - a worker may not write history for a sweep it did not perform
when it claims to have performed it, which is exactly what makes the schedule trustworthy.

So the interval moves instead of the clock. "Overdue" is `elapsed > interval`, and both directions
are reached from the same real history by asking for a different one: with a one-second interval
the loop sweeps having slept **nothing at all**, and with an hour it sleeps ~59.9 minutes and
writes no run. A worker scheduling from its own uptime would sleep the interval before its first
sweep in both cases, so the empty list is what separates them.

**Sleeping is injected so a wait is recorded rather than taken.** The first version of this test
did not do that and hung for the full three-minute timeout rather than failing - twice - because a
loop that decided to wait an hour is indistinguishable from one still working.

### The lease under real contention

Twelve concurrent acquisitions, one winner: the conditional `UPDATE` is atomic, which was true by
inspection and is now true by measurement on a real server. An expired lease is claimable and the
expiry is what makes a killed worker recoverable without anybody unblocking it by hand - and
setting up that test has to move `acquired_at` too, because
`retention_lease_expiry_after_acquisition` will not accept a lease that expired before it was
taken.

### A purge that removed something

An item stamped deleted forty days ago - past `purge_floor()` - is visible to the retention role,
invisible to it the day it was deleted, and `rows_purged: 1` on the sweep that removed it. The very
next sweep purges nothing, which is what makes the first count a deletion rather than a match. It
is also this suite's only cleanup, and the honest kind: the fixture leaves by the mechanism the
product uses to remove it.

### Result

`npm run verify` exit 0: 4,573 passed, 45 skipped across two managed suites. Against
`kynviora-dev`: **45 passed** (32 parity + 13 worker).

---

## 2026-09-05 - The sweep stopped being late, without moving a single deadline

`DEV-063` has been on the list since DEC-121 built the worker, and it was recorded as a decision
rather than as work: every eligibility floor sits **exactly on** its deadline, so a periodic sweep
removed a row somewhere in `[deadline, deadline + interval]` and no finite interval closed that.

The two ways out it named were both wrong, and the brief for this session ruled out the first
explicitly. A margin in the floors - purging at `deadline - interval` - moves every deadline
earlier and changes what the RLS policies admit, which is a security boundary and not something to
move to make a schedule tidy. A continuous sweep does not exist and would be more work for a worse
result.

**The third way asks the data.** `kynviora.next_purge_due()` returns the earliest instant at which
any row becomes purgeable, and the worker sleeps until whichever comes first, that or the
heartbeat. No floor moved. No policy changed. Nothing is removed a second before it is due. What
the sweep overshoots by is now the time one sweep takes rather than a configured number - and on
the twenty-four hour Visit Pack deadline, which is the case that actually mattered, that is the
difference between four per cent of the promise and a rounding error.

### One timestamp, and the reason it is only one

Not a count, not a table, not whose. A schedule needs an instant, and the role that runs on it is
one whose entire design is that it cannot see what it deletes. "Something becomes purgeable at
04:12" says nothing about anybody.

`SECURITY DEFINER`, for a reason that is almost a paradox: the retention role's policies admit only
rows that are **already** due, which is exactly right, and makes the question unanswerable from
inside them. The role that sweeps cannot see its own queue. Executable by `kynviora_retention` and
nothing else - a definer function inherits the definer's rights, so an over-broad grant on one is a
way around a policy.

### Every subquery looks only at the future, and the second reason is the important one

It keeps each scan on the small end of an index. And it means an already-eligible row **cannot pin
the answer in the past** and turn the worker into a busy loop, which is exactly what a plain
`min(deleted_at) + 30 days` would do the first time one row failed to purge.

The predicates are the floor functions rearranged - `deleted_at > purge_floor()` is
`deleted_at + 30 days > now()` - so the period cannot drift from the policy that enforces it, even
though the expression is now written twice.

### The test that would have been worthless

Not "the function computes thirty days". That passes over a schedule that has drifted from the
deadline it schedules for, which is the entire hazard of declaring a period twice.

The sharp one is that the function agrees with the **policy**. In one transaction, where `now()` is
constant: a row stamped exactly at `purge_floor()` is visible to `kynviora_retention`, one stamped
a microsecond later is not, and `next_purge_due()` names that microsecond - to nine decimal places
of a second. Same technique `purgeDeadline.test.ts` uses for the boundaries themselves.

The Visit Pack pair is the other one worth having. A pack expiring in an hour is due in twenty-five
and beats two items twenty and twenty-nine days out; a pack whose content has already been emptied
stops counting, because without that predicate it would name a deadline nothing would act on and
the worker would wake for it forever.

### A failed read answers null, and that is a direction rather than a default

`readNextPurgeDue` catches and returns `null`, which makes `msUntilDue` fall back to the heartbeat

- the schedule this worker had yesterday. Answering a **wrong** instant would be a worker sleeping
  past a deadline. The two failures are not symmetric and the code picks the one that keeps the
  guarantee there already was.

### What is left, named for what causes it

`DEV-065`. Two categories become eligible by a **state change** rather than by a clock, so no
function can name their instant in advance: an evidence asset attached today and detached next
month is already past seven days at the moment it is detached, and a digest becomes empty when
another category purges its last entry. The heartbeat covers both, exactly as it used to cover
everything. Closing it needs a `detached_at` stamp written where the detachment happens, which is a
schema change to a table `BLK-007` has not settled the shape of.

### One thing that was a flake and not a defect

Three suites timed out in their `beforeAll` at exactly 60,000 ms on one `npm run verify` -
`caregiver`, `reviewerConsole` and `reviewInbox`, all of them `createTestDb()`. Re-run in
isolation: 101 passed in 20 seconds. Re-run as the whole suite: exit 0. It is `createTestDb`
applying thirty-one migrations in each of several parallel workers on a machine that had just been
running two Postgres-bound processes, and it is the same resource-contention shape `main.test.ts`
already documents at its `PROCESS_BOOT_TIMEOUT_MS`. Recorded because a timeout that only happens
under load is the kind of thing that gets rediscovered as a mystery.

### Result

`npm run verify` exit 0. **4,585 passed**, 46 skipped, across 174 files plus the two managed suites.
Migration `0031` applied to `kynviora-dev`; both managed suites re-run green there (46 passed).
`DEV-063` resolved, `DEV-065` opened, DEC-123 recorded, `docs/RETENTION.md` 8.3 rewritten from "the
gap that remains" into the schedule.

---

## 2026-09-05 - A real token, and the thing it cannot tell you

`BLK-010` has said the same thing since Stage 7: the only identity in this repository is a
development header. DEC-118 chose Supabase Auth and built everything that did not need a project -
verification, the claim model, the AAL and step-up mapping, the transport - and said in writing
what that established about a Supabase project: **nothing**. Every test signed its own tokens.
Every claim shape came from a documentation page read the same day, and a reference is not a
measurement.

There is a project now. `supabaseLive.test.ts` signs in to it and verifies what it actually issues.

### Four things could have been wrong and were not

| Modelled from documentation                | Measured                                     |
| ------------------------------------------ | -------------------------------------------- |
| ES256 or RS256; HS256 refused before a key | `alg: ES256`, `kid` in the published key set |
| `iss`, `aud`, `sub`, `aal`, `session_id`   | All present, `aud: "authenticated"`          |
| `amr` is `[{ method, timestamp }]`         | Exactly that, `password` on sign-in          |
| `aal` moves to `aal2` on a second factor   | It does, with `totp` added to `amr`          |

The key set publishes public keys only, which is checked rather than assumed: a symmetric key
there would mean every service that can check a token can mint one.

The refusals are measured on the **same real token**, which is what makes them worth having. It is
refused for another deployment's issuer, for the wrong audience, once expired on a clock this
deployment supplies (DEC-003 - a real token, an injected clock, rather than an hour of waiting),
with its payload edited to somebody else's `sub`, naming a `kid` the project does not publish, and
carrying `alg: none` over a payload the provider really issued.

### AAL2 is real, and nothing about the second factor is simulated

A TOTP factor was genuinely enrolled through `/factors`, and the codes are computed from its
secret by RFC 6238 - which is what an authenticator app does. `createReviewerAuthenticator`
refuses the AAL1 token and admits the AAL2 one **for the same person, on one identity**, which is
what makes it a test of the boundary rather than of two accounts.

`amr` came back most-recent-first, so DEC-118's `max` was unnecessary - and taking it with `max`
anyway cost nothing and does not depend on a serialisation detail nobody here controls.

### What is still not proven, and it is not the part anybody would guess

**The email round trip.** The project requires confirmation and its built-in sender answers
`over_email_send_rate_limit` to every attempt, so the synthetic account was confirmed by an
operator - which is exactly what the admin API's `email_confirm: true` does and is not evidence
that anybody received a message or clicked a link. That sentence is in the test file, in
`BLK-010`, and here.

What **is** proven either side of it, against the real provider, is worth more than it sounds:
a right password on an unconfirmed address is refused with `email_not_confirmed`, and a wrong
password with `invalid_credentials` - in that order, which is how you know the bcrypt hash is
genuinely being checked rather than short-circuited by the confirmation gate. An address nobody
has gets the same `invalid_credentials`, which is correct: an endpoint that distinguished them
would be an oracle for which addresses have accounts.

### The finding: a signed-out token keeps verifying

Sign out. The provider's own `/user` answers `session_not_found` immediately. The same token keeps
verifying here until `exp`, up to an hour later.

Nothing is wrong with the verifier - that is what stateless verification **means**, and it is the
benefit of asymmetric signing rather than a cost of it. But `16` requires account deletion to
invalidate sessions immediately, and it follows directly that the token cannot be what does it.

So DEC-124: **a verified subject is not yet an account.** Every request resolves the subject to a
live `app_user` row, at `contextFor`, which is the one path from a request to a connection. One
indexed read, as the caller, under the self-select policy that admits exactly their own row.

Absent, deleted and suspended all answer the same `UNAUTHENTICATED` as no token at all - byte for
byte apart from the correlation ID, which a test asserts. `13` does not let this API be an oracle,
and the difference between "deleted" and "never existed" is exactly the fact a deletion removes.
The reason reaches the log instead.

**It changed a behaviour two suites asserted**, and the change is the interesting part. "A stranger
sees an empty page, not a refusal" is `04` Phase 8.1's exit criterion and is still true - of the
case it was written for, which is a **person with an account** and no access to this household.
The suites were using a bare user ID nobody had an account for, which since DEC-124 is a different
question. Both now use a seeded account with nothing in it: a sharper stranger, and the criterion
measured where it applies.

### Registering, which the API has never had

`POST /v1/me`, taking no fields at all. The subject is the identity, so it is idempotent by nature
rather than by an idempotency key, and the body is `.strict()` and empty because anything in it
would be a caller describing themselves.

**The email is read from the provider**, server to server, with the caller's own token. DEC-118
reads `sub` and nothing else, and registration needs two things a token does not carry: an address
(`email_normalized` is `NOT NULL UNIQUE` and is what an emailed invitation binds to) and whether
it is **verified**, which no claim says. An unverified address is refused - which is the check
that makes DEC-118's "verified email and password" a rule rather than an intention.

A closed account is not revived. `ACCOUNT_CLOSED`, 409: the row is retained until the purge takes
it (DEC-117), and reviving it would resurrect everything that hung off it.

### Deleting, and the order DEC-120 got right for a reason that no longer applies

DEC-120 said the auth identity must go first, so a failure part-way leaves an account that still
works rather than one that cannot be reached and cannot be removed. The premise was that stamping
locally first leaves "somebody who can sign in successfully to a row that is gone". DEC-124
removed that premise: a stamped account produces no session at all.

And the two orders have different worst cases. **Local first**: data gone, sessions gone, identity
lingering, and the person still holding a token that verifies - so they can ask again.
**Identity first**: identity gone, data not stamped, and the person with no way to ask for
anything ever again. Only one is recoverable by the person it happened to.

So the order is reversed, every step is idempotent, and step zero is the one that matters:
**can this deployment finish?** Checking the capability before anything is written is what makes
DEC-120's refused half-measure impossible rather than merely discouraged. A deployment with no
service-role credential does not stamp the data and then discover it cannot close the account - it
answers `PROVIDER_UNAVAILABLE` having changed nothing, and a test asserts that both profiles are
still there afterwards.

The global sign-out is the half that needs no privilege - `logout?scope=global` is authenticated by
the caller's own token - and is therefore the half that can be exercised against a real project.

### Result

`npm run verify` exit 0. **4,605 passed**, 66 skipped across three live suites. Against
`kynviora-dev`: **66 passed** - 32 parity, 13 worker, 21 auth.

`DEV-062` moves from "not built" to "built, and needs one credential":
`KYNVIORA_SUPABASE_SERVICE_KEY`. `BLK-010` narrows to that key and to the email round trip, and
neither is a decision.

---

## 2026-09-05 - The phone can sign somebody in

Everything before this could verify a token. Nothing could get one. The app's only identity was
`EXPO_PUBLIC_DEV_USER_ID`, inlined into a bundle at build time, and `19`'s sign-up/sign-in/recovery
scenario had nothing to drive.

### The provider client is six requests, not a library

`@supabase/supabase-js` brings a realtime client, a storage client, a PostgREST client and a
session manager that writes to `AsyncStorage` **by default** - which `14` names explicitly as not
approved for session data. What this app needs is six requests and a refresh rule, and those fit
in one file that can be read in full and tested without a network.

**Expiry comes from the provider's `expires_at`, never from the token.** DEC-118 part 6 in one
field. The test that pins it uses an access token that is not a JWT at all: it has no `exp` to
read, and the session is still complete - which it could not be if anything were parsing.

**Every outcome is a code, and the mapping is one table.** `13` says clients branch on codes and
never on message text, and this is where that earns its keep: `invalid_credentials`,
`email_not_confirmed` and `over_email_send_rate_limit` lead to three entirely different screens and
the provider distinguishes them only in `error_code`. A code this build has never seen becomes
`UNAVAILABLE` rather than being guessed at - because the safe reading of "the provider said
something new" is that we do not know what happened, and guessing would put somebody on a screen
about their password during an outage.

The response shapes in the test are the ones `supabaseLive.test.ts` observed against the real
project, not invented ones.

### Where a session is kept, and where it is not

In the **encrypted SQLite store**, as a table beside the projection and the journal. Not
`AsyncStorage`, which `14` rules out in the same sentence as health data. And not `SecureStore`
either, which is the tempting answer and is where the **database key** already lives - a refresh
token there would sit beside the key protecting everything else and share its failure modes.

One row, because a phone has one signed-in person. A table that could hold two would need a rule
for which is current, and that rule would be the bug: `12` requires an identity change to
invalidate local access, and the way to guarantee it is for there to be nowhere for the previous
identity to still be.

**The store moved up a level.** `ProjectionProvider` used to open it, which was right while it held
only the projection and the journal; the session is needed **above** the API client, because the
client is built from it. Two providers calling `openLocalStore()` would be two connections racing
one SQLCipher file, which is the failure `ProjectionProvider` has warned about since it was
written. So a `LocalStoreProvider` opens it once at the root and `ProjectionProvider` keeps the
part that was actually its own - scoping rows to an identity and clearing them when the identity
changes.

### Four things, and the fourth is the one that gets skipped

**Restore** reads the stored session before anything renders, and `LOADING` is a real state - a
gate treating "not yet known" as "signed out" flashes a sign-in screen past every returning person
on every cold start, and some of them tap it.

**Renew** is one timer computed from `expires_at`, rescheduled when the session changes. Not an
interval: one that fires while the app is backgrounded bunches up. Only `SESSION_EXPIRED` signs
somebody out - an outage must not, because the session is still valid and signing out over a
dropped connection takes away an offline shelf somebody may be relying on.

**Sign out** happens locally first and unconditionally, then at the provider, globally. A phone
that refused to forget its token because the network was down would stay signed in exactly when
somebody most wants it not to be.

**Losing authorization** is the fourth. A token can stop being accepted while it is still perfectly
valid on its face - the account was deleted, the session was revoked from another device - and
`supabaseLive.test.ts` measured that nothing local can know. So the API's answer decides: one
`fetch` wrapper in `ApiProvider` watches for a `401` and tells the auth provider the session is
gone. Once, on the transport, rather than in each of forty screens. `403` is deliberately not
watched - that is a step-up or a permission - and neither is `404`, which `13` makes
indistinguishable from a refusal on purpose.

### Re-authentication turned out to need no ceremony

`14` requires it for exports, caregiver administration and deletion. Supabase records each
authentication step in `amr` and the server reads step-up from the newest (DEC-118 part 3), so a
password re-entry producing a **new token** _is_ a step-up. `elevate()` on a bearer session
therefore returns the ordinary client and adds nothing - a client that could assert freshness would
be asserting a re-authentication it did not perform, which is exactly what the development header
does and why it is a development header.

### The copy is in `presentation`, and the tests are about what it must not say

`apps/**` is outside the test run, so a sentence in a component is the one family of user-visible
strings nothing scans - and these are read by somebody who has just failed to get into their own
account.

The refusal for a wrong credential is about the **pair**: "that email address and password do not
go together". Asserted, along with the absence of "no account", "not registered" and "we don't
know" - the provider does not distinguish them and a screen that did would be an oracle for which
addresses have accounts, readable by anybody with a phone. The recovery screen goes further and
explains its own silence, because somebody who gets no email needs to know that "nothing arrived"
does not mean "you typed it wrong".

`AUTH_FAILURES` moved to `@kynviora/domain` for a structural reason: `presentation` has to word
each member and cannot import `contracts`, which already depends on it. A closed vocabulary two
packages both need is a domain vocabulary - and a test now asserts the copy table covers it
exactly, so a failure added later cannot reach a screen as `undefined`.

### The screen is one screen

Sign in, create an account and ask for a new password, with all three ways out present at once. A
person who has just been told their password is wrong is one tap from the third of them; three
routes would put a navigation transition between "that did not work" and "then send me a link",
which is the moment somebody gives up.

**Sign-up ends at a mailbox, not at an error.** `kynviora-dev` requires confirmation, so the
provider returns a user and no session - and a screen rendering that as a failure would send
somebody to try again at an account they made one second ago, where the next attempt says the
address is already registered.

Two defects were caught by writing the tests. `submit` was guarded only by a disabled button, and
a press that lands anyway - a screen reader activating a control, a double tap racing a re-render -
would have asked the provider about a blank form; it is guarded in the handler now as well. And
the refusal box was a tinted box with no heading, which `18` forbids: meaning carried by colour
alone is no meaning at all to somebody who cannot see the colour.

### Result

`npm run verify` exit 0. **4,655 passed**, 66 skipped. The mobile project is 102 tests, up from 91.

What this does **not** do is prove any of it on a device or against the real provider from a phone:
that is the next thing, and `19`'s sign-up/sign-in scenario is what it is for.

---

## 2026-09-05/06 - The fourteenth scenario on a real stack, and a renewal that got worse when it got right

Three commits: `6e8897b`, `615bb50`, `c251142`. `npm test` **4,747 passed / 180 files**, up from
4,573 / 173. Typecheck, mobile typecheck, lint and format all clean.

### Where the session started

The previous one ended mid-run: `SIGN-4` had failed and the cause was found - an old dev-auth API
still owning port 3000, so the app's Bearer token reached a process that only accepts a development
header, got a 401, and the transport correctly reported the session lost. Not an auth defect. The
first job was to make that impossible rather than unlikely.

`taskkill /F /IM node.exe` was the fix the previous session reached for and it is wrong twice over.
It does not reliably kill the listeners - Metro held 8081 and the API held 3000 across two attempts,
both silently - and it kills **every** node process on the machine, which here included MCP servers
and an unrelated dev server on 5173 belonging to somebody else's work. Ports are freed by owning
process now, and the phase script refuses to continue if either is still held, if the API did not
bind, if it bound with `dev_auth:true`, if it is not on the managed database, or if Metro started
without the provider in its environment. Every one of those failures is silent in the way that
matters (trap 207).

With that, the API came up on `kynviora-dev`'s pooler with `dev_auth:false`, and the scenario ran
end to end for the first time.

### What the device proved

`SIGN-4` **passes**: a Supabase-issued ES256 token, minted by a person typing a password into the
phone, carried by the app, verified by the API against the published key set, resolved to an
`app_user` row, and used by row-level security to choose rows. Six components, one assertion, and
it is the thing `BLK-010` existed to block.

`SIGN-1`, `SIGN-3`, `SIGN-7` and `SIGN-11` pass with it: a signed-out app that offers all three
ways in with nothing behind them; a wrong password refused by the provider and rendered as the
sentence the app's own mapping produces; a session that survives the process being killed; and a
recovery request that reaches the provider and is reported honestly rather than as a message that
is not coming.

### The defect the clock trick found, and the one it may have caused

Two checks are about a session that has run out of access token, and the provider issues them with
an hour's life. Waiting is not a strategy, so the run moves the emulator's clock past the lifetime
and restarts the app.

The first time it did, the app renewed **in a loop**. `readTokens` stored the provider's absolute
`expires_at` and the renewal rule compares it against `Date.now()` on the phone - two clocks, equal
only when the device's is right. A device an hour fast holds a session already past its expiry the
moment it arrives; an hour slow never renews in time and finds out from a 401. Expiry is a duration
now, measured from the receiving device's own clock, so a constant offset cancels out.

**And `SIGN-8` regressed from PASS to FAIL across that change, which is not resolved.** With the old
absolute-expiry code the app renewed in a loop and stayed signed in; with the duration it asked for
a sign-in instead - which means `refreshSession` returned `SESSION_EXPIRED` and the app signed
itself out. The API log has **zero** 401s for the whole run, so nothing was refused by Kynviora:
the refusal came from the provider. `SIGN-9` failed in the mirror image on the same run - the
session was revoked and the phone stayed signed in - which is the opposite of what a working
renewal produces, so the two are likely one fault rather than two.

It is recorded as unresolved rather than explained. The candidate worth checking first is refresh
token rotation: Supabase invalidates the previous token on each refresh, and two renewals racing
the same token answer `refresh_token_already_used`, which maps to `SESSION_EXPIRED` and signs
somebody out. That is a real defect if it is happening, and it is exactly the shape a loop would
have hidden.

### Three harness faults, each of which read as a finding about the app

`SIGN-5` reported "no encrypted database was found" over a device holding 32,768 bytes of one.
`adb shell` joins its arguments back into one string for the device's shell without re-quoting, so
the `<` inside `sh -c 'wc -c < files/SQLite/kynviora.db'` was consumed by the **outer** shell, in a
working directory that is not the app's (trap 204).

`SIGN-7` reported the app coming back signed in with none of its data. A cold start rebundles and
then fetches, and thirty-five seconds was a few short of it; the identical restart at forty-five
passed. It waits for a determinate state now - the account's data or the sign-in control, both of
which are answers - and returns the reading it settled on, so waiting and looking cannot disagree
(trap 205).

`SIGN-5`, `SIGN-6` and `SIGN-9` all went inconclusive together on one run, for a reason none of
them named: a single direct sign-in that failed silently. Instrumented, it said "the provider could
not be reached", which is trap 187 - `fetch` across the forty-five-second synchronous sleeps this
suite is made of, reusing a socket the provider closed long ago. `connection: close` and a retry,
which every other harness here has had for weeks and the new one did not.

### Sign-up, and the quota that a probe spends

`SIGN-2` used to make its **own** sign-up to a second address and infer that the app's went the
same way. That reasons about a different request, and worse: `kynviora-dev`'s built-in mailer
allows two messages an hour and the quota is spent by an **attempt**, not a delivery - so the probe
could take the last of it and hand the app the rate limit it then reported as the provider's usual
behaviour. The app goes first now and the provider is asked about that exact address with a password
sign-in: `email_not_confirmed` is an account that exists and cannot be used yet,
`invalid_credentials` is one that was never created. Neither needs a privilege.

Four consecutive runs answered `NOT_CREATED`, because a full run makes three email-triggering calls
and each one pushes the window out again (trap 206). `KYNVIORA_SIGNIN_PHASES=signup` exists for
that: it runs `SIGN-1`, `SIGN-2` and `SIGN-10` and makes exactly one such call - the app's own -
after an hour of asking for nothing. That has not been run yet, so **no account has been created
through the app's own form** and `SIGN-10` is untested.

### Account deletion, and a credential that never arrives

`DEV-062` was blocked on a service-role key. The key is not obtainable here - the JWT secret is not
exposed to the `postgres` role, which was checked - and it is the wrong shape anyway: it bypasses
row-level security on everything Supabase owns, and `DELETE /v1/me` needs one capability from it.

So the removal is an Edge Function, `close-identity`, deployed to the project, and this API holds no
privileged credential at all (DEC-126). Supabase injects the service key into the function's own
environment. The function takes **no user id** - it reads `sub` from claims the gateway has already
verified, which was measured: a token with real-looking claims and a signature the project never
issued is refused at the edge with `UNAUTHORIZED_LEGACY_JWT` before the function runs. Smoke-tested
against a throwaway identity: 401 with no token, 405 on `GET`, 204 on `POST`, and the identity
genuinely gone afterwards - the provider answers `invalid_credentials` to credentials that worked
one second earlier.

The API reports `can_remove_identity: true` for the first time.

That cost an ordering, for a reason DEC-124 already measured. The function authenticates as the
caller and a global sign-out invalidates that token immediately, so signing out first left the
removal unable to authenticate - on a route whose whole design is that it can be called again. Local,
then identity, then sessions. And on failure the session is deliberately kept: it is the only
credential the person has left to finish with, and it grants nothing.

A least-privilege result worth recording came out of the same investigation. Kynviora's tables are
owned by `kynviora_migrate` and granted only to `kynviora_app`, `kynviora_service` and
`kynviora_retention`. Supabase's own `postgres`, `anon`, `authenticated` and `service_role` have
**no privilege on `app_user` at all** - which is why the function cannot check that Kynviora stamped
the account first, and why that gap is closed by a secret instead (`DEV-066`) rather than by
granting a platform role access to health data.

### What is not proven

- **No account has been created through the app's own sign-up form.** The mailer quota refused every
  attempt. `SIGN-10` (an unconfirmed address cannot be signed in to) is untested as a result.
- **`SIGN-8` and `SIGN-9` fail**, and the renewal path is the suspect. Nothing about a device
  session should be treated as settled until that is understood.
- **The deletion scenario has not produced a clean run.** Its first attempt seeded no profile -
  `POST /v1/households` answered 400, so the request shape is wrong - which leaves `DEL-5` unable
  to show that anything went with the account.
- **The email round trip** remains untestable without a mailbox (`BLK-010`), unchanged.

Section 19's device coverage is therefore **not** 14/14. The fourteenth scenario exists, runs
against the real stack, and proves six of its eleven checks; it is not green, and an inconclusive
check is not a pass.

---

## 2026-09-06 - The renewal was never measured, and four other things nobody could see

### What the last session concluded, and why it could not have been right

`SIGN-8` failed and `SIGN-9` failed in the mirror image on one run, and the note left behind named
refresh token rotation as the first suspect: Supabase invalidates the previous refresh token on
each renewal, two renewals racing one answer `refresh_token_already_used`, and that maps to
`SESSION_EXPIRED`, which signs somebody out.

It is measured now, against `kynviora-dev` itself, and it is not that. A refresh token that has
already been exchanged answers **`200`** on this project - immediately, and again fifteen seconds
later, past any reuse interval. `refresh_token_already_used` is not reachable here. The suspect
had an alibi.

Two other things the same probe settled:

- a refresh token the provider will not parse answers `400 validation_failed`, "Refresh token is
  not valid" - and the shared code table maps `validation_failed` to `EMAIL_INVALID`, because on a
  sign-up that is what it means;
- a session revoked by a global sign-out answers `400 refresh_token_not_found`, which does map to
  `SESSION_EXPIRED`. So `SIGN-9`'s premise was sound and its failure was not about the mapping.

### The one fault, and it was in the harness

`advanceDeviceClock` calls `adb root`, because `date` is not something an unprivileged shell may
set. **`adb root` restarts adbd, and every `adb reverse` mapping dies with it.** Measured directly:
`adb reverse --list` names both ports before it and is empty after.

`SIGN-8` and `SIGN-9` are the only two checks that run after the clock moves. Both of them were
therefore measuring an app that had no route to Metro and no route to the API - and neither said
so. It is also why the API log had no `401`s in it for the whole run, which the previous session
read as evidence that the refusal came from Supabase: no request reached the API to be refused.

`verifyReminders.ts` has put both tunnels back after its own `adb root` since it was written. The
lesson was in this directory and the newest harness in it did not have it (trap 208).

### The API refused people silently

`contextFor` answered `401` for a token that does not verify and **wrote nothing**. So "the API log
has zero 401s" was true of every run there has ever been, including the ones where a phone was
being refused, and a device scenario was diagnosed against that silence.

`api.request.unauthenticated` now records the method and the route - never the token, and there is
no verified subject to name. It found something within a minute of existing: a **signed-out** app
still calls `GET /v1/profiles` and `PUT /v1/me/time-zone`, because `ProfileProvider` and
`TimeZoneReporter` sit above `AuthGate` in the root layout and mount for a signed-out person
(`DEV-067`).

### Two real defects in the renewal, found by looking rather than by the device

**A renewal that failed did nothing at all.** No retry, no reschedule: one dropped packet at the
moment a token came due left the app holding an access token it would never replace, and it went on
using it until the API refused it - and _that_ signed somebody out. A phone in a lift for ten
seconds, an hour later, back at the sign-in screen. The old absolute-expiry code hid it, which is
why it surfaced when that was corrected: a clock-skewed device renewed continuously, so every
failure was retried a moment later by accident.

**A renewal in flight could act on a session that was no longer there.** `adopt` after a sign-out
writes the session back to disk and puts somebody back into the app - on a phone they may have
signed out of because they were handing it to somebody else. `forget` after a new sign-in signs the
new session out for the old one's sake. Both are one liveness flag, and both are pinned by tests.

And `validation_failed` on a renewal now reads as `SESSION_EXPIRED` rather than `EMAIL_INVALID`,
which was a screen telling somebody their email address was wrong about an address nobody typed -
and, worse, one that did not sign them out, so the phone kept a session it could never renew.

### `SIGN-10` was never about the mailer quota

Four runs recorded "no account was created" and blamed a rate limit of two messages an hour spent
by an attempt. The provider's own auth log says otherwise. The app's sign-up to
`kynviora-signin-...@kynviora.test` answered:

    400 email_address_invalid   Email address "..." is invalid

carrying an `auth_event` of `user_confirmation_requested` - GoTrue got as far as sending the
confirmation, could not, and rolled the user back. `kynviora.test` has **no MX record**;
`example.com` and `example.org` publish a **null MX** (RFC 7505), which is a domain saying in the
DNS that it accepts no mail. And there is no `over_email_send_rate_limit` anywhere in the log for
any of those runs: the quota never fired.

So creating an account through the app's own form needs an address at a domain that accepts mail,
which is a mailbox - `BLK-010`, the same blocker as confirmation and recovery, rather than a
separate one. `KYNVIORA_SIGNIN_SIGNUP_DOMAIN` is the knob; the default is left alone so nothing
changes silently.

### Three ways a run could stop and say nothing

- **`withManagedClient` had no statement timeout.** The pooled path has had one since it was
  written; this one bounded getting a connection and nothing after it. Two API processes left over
  from earlier sessions were still holding pooler connections, and `verify:device:delete` blocked
  on its first database read - thirty minutes of a device run for one line of output.
- **`adb()` had no timeout at all.** Every device call is synchronous by design, so one wedged
  `uiautomator dump` is a harness that never ends. 180 seconds now, and `adb install` carries its
  own.
- **`verifyDeleteAccount` printed two lines and then nothing** for the whole of the device work, so
  a run that stalled looked exactly like one being thorough. Step markers with the clock on them.

### The deletion

`DeleteAccount.tsx` issued the deletion on the client captured in the callback's closure, which
carries the **pre**-re-authentication token: `ApiProvider` memoises the client on the access token,
so the new one arrives on the next render, which is after the callback has finished. The server
read step-up from the old token's `amr`, found it stale, and refused - and the screen worded that
as "that password was not right", about a password that was. It is built from the tokens
`reauthenticate` returns now, which is why that function returns them.

`verifyDeleteAccount` seeded nothing because it sent `idempotencyKey` in the body. The API reads
`Idempotency-Key` as a **header**, validated as a UUID, and the body schemas are `.strict()` - so
the request failed twice over. `POST /v1/profiles` also takes `householdId` and `isSelf`, and there
is no `relationship` field.

### What a run costs, and the three reasons it used to cost more

Two device runs on 2026-09-06 produced one line of output each and sat for half an hour. Neither
was stuck on anything to do with Kynviora.

The first was the database: two API processes left over from earlier sessions were still holding
pooler connections, `withManagedClient` bounded getting a connection and nothing after it, and the
scenario's first read after the screen work waited for ever. The second was `scrollTo`, which does
up to sixty `uiautomator` dumps per call - three seconds each on a healthy emulator and fifteen on
one that has been up for hours, so a single `scrollToAndTap` took eight minutes and looked exactly
like a hang. Restarting the emulator took a full scenario from fifty minutes to fifteen.

And `adb()` had no timeout at all, which is the one that could have gone on for ever rather than
merely long. Every device call is synchronous by design; one wedged `uiautomator dump` is a harness
that never ends.

The deletion scenario now says where it is, with the clock on each step. It used to print two lines
and then nothing for the whole of its device work, so a run that stalled and a run being thorough
looked identical.

### The thing that made the fourteenth scenario green

`SIGN-7` - a session surviving the app being killed - failed on a freshly restarted emulator and
had passed on a warm one. That is a race, and it was a real one.

`ProfileProvider` and `TimeZoneReporter` sit under `AccountGate` and above `AuthGate`, and each
asks the API something on mount. On a cold start the stored session has not been read yet: it lives
in an encrypted database and opening one is a keystore round trip. So two requests went out with no
credential on them, the API refused them, and the transport read that `401` as the session having
been lost - and `sessionLost` deletes the session **from disk**. The app signed a returning person
out on its own cold start, and the faster their phone answered the more reliably it happened.
`SIGN-8` and `SIGN-6` failed downstream of it, because there was nothing left to renew or revoke.

Two changes, and the first would be right without the second (DEC-128). Only a request that carried
a session may report one lost. And nothing under the gate asks anything until it is known who is
asking - which is the argument the top of `AccountGate` already made about registration, one state
earlier, and had not been applied to the session itself.

### Result

`npm run verify` exit **0**. **4,764 passed / 182 files**, up from 4,747 / 180. Migrations
unchanged at `0030`.

On hardware, against the real provider and the real managed database:

| Scenario                               | Result                                                     |
| -------------------------------------- | ---------------------------------------------------------- |
| `verify:device:delete`                 | **6/6 PASS** - `DEV-062` closed                            |
| `verify:device:signin`                 | **10 PASS, 1 INCONCLUSIVE** - only `SIGN-10`, on `BLK-010` |
| `verify:device:signin` (session phase) | **8/8 PASS** - the whole session half on one run           |

`SIGN-8` and `SIGN-9` pass together, which is what makes either of them worth anything: under the
same conditions - the clock moved past the token's lifetime, the app restarted - a live session is
renewed and a revoked one signs the phone out.

### What is not proven

- **No account has been created through the app's own sign-up form.** `SIGN-10` is inconclusive and
  Section 19 therefore stays at **13/14**: an inconclusive check is not a pass. What blocks it is a
  mailbox (`BLK-010`, `DEV-069`) rather than anything about the app.
- **The email round trip** is unchanged: no confirmation link and no recovery link has been
  followed, because nothing here can receive one.
- **A unique-constraint violation still answers 500** rather than a refusal (`DEV-068`), found by
  the deletion scenario seeding a second self-profile.
- **A device whose keystore refuses** is still untested. The gate now holds while the store opens,
  and `LocalStoreProvider` settles either way, so it resolves - but nothing measures that on
  hardware.

---

## 2026-09-07 - Two themes, a golden path, and an agent that proposes

**Where this started.** `npm run verify` at 4,764 tests over 182 files, exit 0, and a clean tree.
`DEV-068` open: a second self-profile answered 500. Section 19 at 13/14 on a mailbox. The product
direction was new: a premium consumer UI layer, and Voice Mode as a product architecture rather
than a microphone.

### The duplicate that said "something went wrong"

`profile_self_user_unique` was right and the refusal was missing, so a person pressing a button
twice got `INTERNAL` with `api.unhandled_error` in the log and no reason in it. The vocabulary
question `DEV-068` was really about got an answer (DEC-129): `ALREADY_EXISTS` at 409, and not
`VALIDATION_FAILED` - nothing was malformed and there is no field to point at - and not
`VERSION_CONFLICT`, which means "re-read and retry" about something that never succeeds.

Mapped in the **error handler** rather than in `insertOrRefusal`. That wrapper covers five call
sites and a `23505` can come out of any statement; in the handler every route inherits it, and the
routes that answer their own duplicates by reading the stored row back never reach it at all,
because `ON CONFLICT DO NOTHING` raises nothing.

The half worth carrying: **a unique index is enforced over every row in the table, including rows
row-level security hides from the caller.** So the refusal names no constraint, carries no
`detail`, and the driver's own `Key (self_user_id)=(<uuid>) already exists` is read nowhere. The
constraint name goes to the log, validated against an identifier pattern first.

### Both themes, at the same rank

The app committed to light because thirty-four files imported the palette directly (DEC-101). All
43 of them read it from a context now (DEC-130), because a half-converted app is white text on
white for exactly the person who turned dark mode on because they needed it.

The dark ground is `#0E1116` and not black, twice over. An elevation ladder needs somewhere below
its first step, and on black a card can only ever be lighter - "further away" stops being
expressible. And white on black is the highest-glare pairing a screen can produce, which matters
most for the audience `01` names first.

**Hue is reserved for state.** The primary action is contrast - near-black on light, near-white on
dark - so an accent does not become a fourth colour on a screen already using amber and red to say
something about a medicine. One teal carries focus and selection and nothing else.

What keeps it honest: contrast asserted at 4.5:1 for every pair in **both** themes, `line.strong`
and `line.focus` at 3:1 against both grounds, and the dark elevation ladder asserted as four
distinct colours - because a shadow on a near-black ground is invisible and colour is the only
mechanism left there.

### The golden path, and three things looking at it found

Today, Shelf, the item detail and recording a dose, rebuilt on `Card`, `Typography`, `FieldRow`
and `SectionHeader`. Then the app was run and looked at, which found what tests did not:

- **Two headings said "Today"** - the navigator drew one and every screen drew its own. Removing
  the navigator's left the first line under the status bar, because that header had been reserving
  the top inset; and it revealed that **Care had no heading at all**, which is `18`'s
  heading-navigation requirement going unmet on one destination out of five (`DEV-076`).
- **The tab bar was white in both themes.** The navigator paints its own and does not know about
  the theme - a strip of daylight under a dark screen.
- **A disabled primary action was the loudest thing on the screen.** Half of a near-black accent is
  a solid grey slab saying "press me" about the one control that cannot be pressed. Disabled takes
  the muted surface now and recedes.

### Voice Mode: an agent that proposes, and six gates that decide

`packages/agent` - platform-neutral, no React, no database. Thirty tools over the existing client,
each answering six questions with no defaults, so a new tool cannot compile without an answer to
all six.

**What `17` forbids has no name to be called by.** There is no tool for prescribing, changing a
dose, stopping, splitting, replacing or recommending, because no such capability exists in Kynviora
for a tool to name - asserted by word, so adding one fails a test rather than passing a review.
Closing an account, sharing a health record, giving somebody access and recording consent are
`TOUCH_ONLY`, each for its own reason, and listed anyway so the agent can say where the control is.

**The Speech Gate** is the Citation Gate applied to speech: every fact spoken came out of a tool
result, **exactly**, and every other word from about fifteen fixed sentences. Exact matching rather
than substring, because "no matched rule was found within coverage" becoming "no rule found" loses
the words doing the work. The whole assembled sentence is scanned again, because a combination can
say something neither half said.

**A confirmation names its proposal**, expires at ninety seconds on a clock the caller supplies,
and is disarmed by anything that is not it. The summary is composed by this repository rather than
by the model, because "shall I record that you took it" is one word from "shall I record that you
skipped it" and both are fluent.

No provider is chosen (`BLK-012`). A deterministic phrase matcher drives the whole pipeline in CI -
including hostile proposals - and is named for what it is.

### What a device found that nothing else could

`verify:device:voice`, nine checks, and its **first run found a real defect**: Voice Mode did not
scroll. It is drawn instead of the navigator, so unlike every other screen it was not inside a
container with a height, and its ScrollView sized itself to its content. By the third exchange the
field and both buttons were below the fold with no way to reach them - `DEV-046` again, on a new
surface, found this time by writing the scenario before claiming the surface worked (`DEV-075`).

Four things about the harness itself were wrong, and each made a check that could not run look like
one that ran and found something:

- It scrolled **up** to reach a field that is at the bottom of the page.
- `scrollTo` returned the field's own **visible label**, which carries the same words - and hiding
  that label from a screen reader was the right fix for a person and no fix at all here, because
  `uiautomator` dumps the view hierarchy rather than the accessibility tree.
- The confirmation summary was read as "the line after the marker" out of a **de-duplicated set**,
  which on one run returned the state glyph. It is read off the card's own accessible name now -
  and the card is one announced node, which is better for a screen reader too.
- The state hint and the confirmation card said the same sentence, which is bad copy and made the
  marker ambiguous.

Final: **9/9 PASS**, including the touch-only refusal spoken out loud, the one sentence that exists
for "is it safe", the composed summary on screen before anything happens, and two 88dp answers
16dp apart.

### Also

`npm run verify` failed twice on hook timeouts with nothing wrong. **Fifty test files open their
own PGlite instance in `beforeAll`**, in parallel, and the suite grew past what 60s covered - two
files on one run, a different one on the next, each passing in seconds alone. 180s now, which is
the number `main.test.ts` reached first and set per file (`DEV-072`).

### Result

`npm run verify` exit **0**. **4,980 passed / 192 files**, up from 4,764 / 182. Migrations
unchanged at `0031`.

On hardware, against the seeded stack, on a Pixel 7 / Android 16 emulator:

| Scenario                   | Result                                                         |
| -------------------------- | -------------------------------------------------------------- |
| `verify:device:voice`      | **9/9 PASS** - new, and it found `DEV-075` on its first run    |
| `verify:device:a11y`       | **74/74 PASS** - the golden path and Voice Mode, scale 1 and 2 |
| `verify:device:camera`     | **5/5 PASS** - no permission arrived with the new package      |
| `verify:device:doseaccess` | **7/7 PASS** - the redesigned shelf row and dose sheet         |

One thing worth recording about the last full run before this one: a vitest worker died of a heap
allocation failure with 191 files passing, on a machine also running an emulator, Metro, an API and
a gradle daemon. Nothing was wrong with the code - the same suite is green with those stopped - but
it is the second resource-shaped failure of `npm run verify` this session, after `DEV-072`, and
both were quiet. A worker that dies takes its file's results with it and the run still prints a
count.

## 2026-09-07 (later) - A reference Safety screen, and three blockers that were not

### What the session was asked for, and what it found

Carry the design system into Safety, Care and You; close the two Voice Mode parity gaps; close
DEV-070 if it was genuinely unblocked. All of that happened. What was not expected is that **all
three of the deviations named in the brief had premises that were simply false**, and checking each
took one command.

### Safety

The screen is on the shared components now, and one change is the whole point of it.

**The coverage statement moved from under the list to a card above it** (DEC-138). `09` requires it
to accompany the result, and the old layout satisfied that literally. It did not satisfy it in
practice: on a shelf of five identical "not enough information" lines the conclusion is formed
**while scanning**, so a qualification arriving underneath arrives after the thing it qualifies -
and on a longer shelf it is below the fold, which for a sentence whose whole job is to stop a
misreading is the same as absent. The design system's own rule is that a limitation never moves
down a layer, and below the fold is a layer.

**Urgency and evidence sit in their own block, under two questions.** `23` D-005 forbids merging
them and three chips in a row is how they get merged anyway - a person reads a strip of adjacent
chips as one compound verdict. They are now in a sunken well under "How soon" and "How well
established", with a sentence saying neither answers the other, and the block is **absent** rather
than empty where there is no live alert.

That branch is unreachable on hardware today (`BLK-006` means nothing is publishable), so the
device scenario has only ever measured the absent half. `SafetyRow.test.tsx` measures the other
one - twelve tests, including that no node's announcement carries both dimensions, which is what
would break the moment somebody wrapped the pair in one `accessible` container to tidy up a screen
reader's output.

The chosen filter also stopped being `informational`, which is the colour a fact about somebody's
medicine is drawn in. It carries `selection` now - the one hue in this app about the interface.

### The three blockers

**`DEV-070` - haptics.** Recorded as blocked on declaring `android.permission.VIBRATE`, because a
newly declared permission appears on the Play listing and in the Data-safety form. The permission
is already declared: the manifest merger report attributes it to the app's own manifest, where
`expo-notifications`' plugin puts it, and `dumpsys package com.kynviora.app` lists it among the
requested permissions of the build that was installed at the time. React Native's own `Vibration`
needed no dependency, no permission and no prebuild (DEC-139).

Android only, and that is the adapter working rather than failing: `Vibration.vibrate()` on iOS
takes no duration, so every call is the same full-length buzz and a `selection` tick would be that
buzz on every press of every chip. The engine answers `null` there.

**`DEV-071` - a dose recorded by voice with no signal.** The wiring was small and was never the
blocker. The question was whether queueing performs a different act from the one confirmed, and the
answer (DEC-140) is that **a confirmation is for the record, not the transport**. What somebody
agreed to when they said "record that I took it" is the record being made; whether it travels now
or in ten minutes is a fact about the phone's radio. So the summary describes the intent and the
report says what happened - `UTTERANCES.queued`, which already existed and is exactly this
sentence, spoken instead of "Done." and never as well.

It goes into the identical journal the dose sheet uses: same entity type, same mutation, same key,
same drain, same `PendingSenders` wire call. Voice adds no sync mechanism.

**`DEV-074` - voice offering a caregiver less than touch.** Worse than the entry said.
`VoiceProvider` called `capabilitiesFor({ isOwner: owns })` and passed **neither** of the two
answers the app already had, so a caregiver was offered three read capabilities in every session
whatever their grant carried. Three tool capabilities were reachable by touch and not by voice.

`GET /v1/profiles/:profileId/capabilities` answers it with `kynviora.has_capability` over the grant
vocabulary, in one query, returning only what is held (DEC-141). It authorises nothing - every
route checks again on the session - and it discloses nothing, because a profile the caller cannot
see answers with an empty list, which is what an empty shelf page already tells them.

The entry proposed a smaller fix: thread the shelf's and the item detail's answers into the
dispatch context. That was rejected for the reason `PendingSenders` was moved off the screens
(`DEV-044`) - it makes what an interface may offer depend on which tabs somebody happened to open.

### Two defects found on the way

**`DEV-077` - the dark theme was unreachable from the default appearance setting.** `app.json` still
carried `"userInterfaceStyle": "light"` from DEC-101, written when there was no `DARK_THEME` at all.
That is not inert: `expo-system-ui`'s plugin writes it into a string resource and its lifecycle
listener calls `AppCompatDelegate.setDefaultNightMode(MODE_NIGHT_NO)` on every activity create,
which forces the `Configuration.uiMode` that `useColorScheme()` reads. So `FOLLOW_SYSTEM` - the
default - could only ever resolve to light, and the dark theme was reachable only by choosing it
explicitly.

**Every unit was correct.** `resolveThemeName` is tested and right; the tokens are contrast-tested
and right; the whole design system is asserted in Node. The one thing that was wrong lived in a
platform configuration file three layers below any of them, and nothing in this repository could
have caught it. It was found by reading `app.json` while checking what a rebuild would regenerate.

**`DEV-078` - a refusal reported as "no connection".** Found while wiring `DEV-071`. Adding the
queue forced the question of which failures may be queued, and the answer - only `OFFLINE`, because
a refusal replayed by a journal is refused again - showed that the existing single failure branch
was answering two questions with one sentence. A caregiver whose grant had been revoked was told to
try again later.

### Care and You

**Care goes through `Screen` like the other four destinations** (DEC-142). It was the one with a
hand-rolled frame - its own safe area, scroll view, heading and padding - with a **second** scroll
view nested inside the first, in `CaregiverAccessList`. Two scroll views in the same direction is
one of them eating the other's gestures, which is the shape of `DEV-046` and is not something any
test here can see. The stated reason for the exception had expired the same day it was written:
`Screen` draws a heading, and Care had gained one when the navigator's header was removed.

Care also painted `surface` as its ground, so every card was the same colour as the page behind it.

**A grant is three blocks now**: what they can see, what they can change, and what is not shared.
They are separately granted (DEC-116) and the third is the one somebody actually came to check - it
used to be a lowercased caption under a row of grey chips.

**You is sectioned by the five subjects `06` names** (DEC-143), each a heading a screen reader can
navigate to. The order inside them is unchanged wherever a comment already gave a reason. One thing
moved for a reason that is a defect fix rather than a preference: the health context sat inside the
notification-settings guard, so a household whose **notification settings** would not load lost a
health context that had arrived perfectly well - a partial state rendered as an absence.

### One more channel out of a tool, and why

`ToolResult` gained `utterances`. `spoken` is checked against `composedFrom`, and the caller passes
the executor's own `spoken` array as `composedFrom` - so a string written in the executor cited
itself and passed. Every one of them happened to come from the presentation layer and nothing was
enforcing it. A key cannot cite itself: `gateSpeech` resolves it against `UTTERANCES` and refuses
one this build does not have.

### The device round, and the one red result

Safety **7/7**, Voice Mode **9/9**, dose access **7/7**, caregiver access **5/5**, camera **5/5** -
and `CAM-3` still finds none of the eight permissions granted or declared, which is the check most
likely to start failing by accident and the one that matters after wiring a haptic engine.

The accessibility survey came back **70 PASS, 1 FAIL, 1 INCONCLUSIVE**, and the FAIL is the part
worth writing down. All five destinations passed at both font scales, including the three redesigned
ones - so the redesign cost nothing `18` asks for. What failed was `SHEET-2/Add a medicine@2`:
"Save" never fully on screen at any scroll position.

**The first two readings were both wrong.** That a redesign had cost something - but nothing in this
session touched `AddItem.tsx` or `Screen`. That the tab bar was covering the button - plausible, and
false. Measuring it took two minutes: `Save` at y1633, `Cancel` at y1863, tab bar starting at y2209.
Four hundred pixels of clearance. **The control was reachable and the survey said it was not.**

The cause is `SCROLL_ANCHOR_Y`, a fixed 1900. At font scale 2 the manual-entry form is almost
entirely `TextInput`s drawn tall, so the drag began inside an `EditText` - which takes it as text
selection and passes nothing to the list. The swipe happened, nothing moved, the dump matched the
last one, and `surveySheet`'s "an unchanged screen means the sheet has stopped" ended the survey
three fields from the bottom (`DEV-079`, DEC-145).

An unchanged dump now buys one retry from an anchor no text field occupies, and only a dump
unchanged after **that** ends a survey. `dragAnchorAvoidingFields` lives in `accessibility.ts` with
five tests, so it runs in CI with nothing attached (DEC-102).

**This is `DEV-046` mirrored.** That one was a false PASS - 34/34 over a form nobody could finish -
and the fix was to measure reachability rather than visibility. This one is a false FAIL: a
traversal that stopped early and reported the gap as a defect in the thing it was measuring. Both
make a report untrustworthy, and the second also teaches people to disbelieve a red result, which is
the more expensive habit.

The INCONCLUSIVE is `A11Y-1/talkback`: with TalkBack on, the first dump held no enabled, laid-out
clickable node. That is a check that could not look, which DEC-102 makes a fail rather than a pass -
correctly. It is not investigated here and is named rather than explained away.

### And a refusal that was saying the wrong thing

Wiring `DEV-071` produced a first draft that mapped a `404` to "You do not have access to that."
`13` makes absence and refused access **deliberately** indistinguishable, and the screen renders the
same outcome as "Kynviora has nothing to show here" - so the spoken sentence was committing to the
reading the server declined to give. A voice interface saying out loud what the API refuses to put
in a body is the same disclosure through a different channel.

Two more sentences in the closed set (DEC-144): `notAvailable` for a `404`, and `didNotGoThrough`
for everything else that reached a server and did not land. The second half of that one -
"Kynviora has not kept it. Nothing has changed." - is the part that matters, because a person using
Voice Mode is often not looking at the screen, and one who is not told nothing was kept stops
thinking about a record that does not exist.

`notAllowed` stays for the case it was written for: the dispatcher's own capability gate, which is
this app's statement about itself rather than an inference about a server's silence.

### The dark theme, measured rather than argued

`adb shell cmd uimode night yes`, relaunch, screencap, read the pixel: `#0E1116`, which is
`DARK_THEME.canvas.background`, with the appearance setting left at its default. Before today the
same phone drew `#F7F9FB`, because `app.json` said `light` and Expo turns that into
`AppCompatDelegate.setDefaultNightMode(MODE_NIGHT_NO)` (`DEV-077`).

### What a review found that nothing in this repository could have

Two read-only reviews of the session's diff, one for correctness and security and one for
documentation consistency. Between them they found seven things, and the first of them is the most
important thing in this session.

**`DEV-081` - the Speech Gate would say anything named after a property of `Object.prototype`.**

`gateSpeech` resolved an utterance key by indexing `UTTERANCES` and refusing only on `undefined`.
**`Object.freeze` does not remove a prototype.** Measured:

```
toString    => function toString() { [native code] }
constructor => function Object() { [native code] }
__proto__   => [object Object]
nope        => UNDEFINED (refused)
```

It was reachable rather than theoretical, and that is the part worth carrying. An agent turn of
kind `SAY` carries `utterance` as a **raw string off a model completion** (`ports.ts`), and
`VoiceProvider` cast it with `as keyof typeof UTTERANCES` - a cast changes the type and checks
nothing. A model returning `{ kind: 'SAY', utterance: 'toString' }` had
`"function toString() { [native code] }"` spoken by the synthesizer and written into the transcript,
and `findForbiddenClaims` matched none of it.

The harm is bounded: a dozen prototype names, none of them about a medicine. What it broke is the
**property**, which is the thing that makes the rest of the design defensible. `docs/design/
VOICE_MODE.md` section 6 says there is "no path, including a jailbroken or prompt-injected one" -
and there was one, in the resolution step, since the file was written.

`Object.hasOwn` and a `typeof`, `isUtteranceKey` exported so the one place a model supplies a key
narrows instead of casting, and five tests: four looping the inherited names, one asserting no
assembled sentence can contain `native code` - the harm rather than the mechanism - and a positive
control that every real key still passes, because a gate that refused everything would satisfy the
other four. `FROM_GRANT` in `capabilities.ts` had the same shape over names from a server response;
it is a `Map` now (DEC-146).

**How it was found is the generalisable part.** Nothing here could have caught it: the gate is
tested and every test used a real key. The review asked whether the **new** channel could smuggle
text, established that it could not, and then asked the same question of the path that had been
there all along.

**`DEV-082` - the capability report answered for a profile its caller could no longer see.** The new
route's own comment claimed it disclosed nothing. `kynviora.has_capability` short-circuits on
ownership through `owns_profile`, which filters `deleted_at IS NULL` - and its **caregiver-grant**
branch does not, while `0025` soft-deletes a profile without revoking the grants hanging off it.
Measured directly on the caller's own connection after a delete: `held = true`, `visible rows = 0`.
So a caregiver could distinguish "the owner deleted this profile" from "your access was revoked",
which nothing else on this surface allows and which `13` makes deliberately unavailable. One
`WHERE EXISTS` in the same statement, and three tests including that an owner and a stranger now
get identical answers.

**`DEV-083` - one profile's capabilities could be applied to another.** `useResource` keeps its last
successful value when a later read fails, which is right for a medicine list and wrong for an
authorization report: switch person with no signal and the previous profile's grant stands. The
answer carries the profile it is about now, and a mismatch reads as no answer.

**And the read capabilities stopped being unconditional.** They were added to every caregiver on the
reasoning that offering a read costs nothing, because row-level security answers an ungranted one
with an empty page. True - and not the rule the file now claims. A caregiver holding only
`VIEW_SHELF` was offered `list_medicines` and `describe_alert` and told there was nothing there
about medicines that exist.

**Two of the harness fixes were themselves defective**, which is the second lesson. `narrowed()`
called a run full when an unknown part name had silently dropped TalkBack, and `main()` discarded
`relaunch()`'s answer - so the very failure the new return value exists to report would have been
surveyed through.

**`DEV-080` - a fixed sleep, and the comment that predicted it.** `relaunch()` slept thirty seconds.
Measured this session, a cold start at font scale 2 gave a hierarchy of nothing but frame layouts at
sixteen seconds and content somewhere before forty. Its own comment had named the failure - "a dump
taken too early reports a screen with no controls" - and then slept for a fixed time anyway.
`waitForAppReady` already existed for this, and its comment says so. It is also six minutes faster
over a full survey, which matters for the reason `DEV-079` matters: a survey nobody re-runs after a
fix is a survey whose red results stop being acted on.

The documentation review found eleven factual errors, including a test count two sessions stale, a
table saying thirty migrations over a directory holding thirty-one, a planned task this session had
already done, a byte-identical duplicate of DEC-099, and - worst - `DEV-078`'s "how it resolved"
describing the draft that was **rejected** rather than what shipped.

### An operational trap worth writing down

Killing a stalled harness with `taskkill //F` orphaned several `tsx watch src/main.ts` processes,
all contending for `.kynviora-data` - which PGlite opens as a single writer (DEC-037). The next API
start aborted with `Failed: Aborted()`, which says nothing about why. A stale `postmaster.pid` was
part of it and removing that was not enough; the store had been killed mid-write and had to be
recreated, which the dev command does on its own because it migrates and seeds at start.

Two things follow. The abort is silent about its cause, so the first hypothesis is always the wrong
one - a device run reading a shelf of **zero** items reported a Voice Mode failure that was entirely
the dead API. And a run that force-kills a process holding a single-writer store should expect to
recreate it; the store is synthetic and gitignored, and treating it as precious costs more than
rebuilding it.

### The full survey did finish, and it left one question open

With both harness fixes in, `npm run verify:device:a11y` ran end to end for the first time since the
redesign: **72 PASS, 2 FAIL, no `INCONCLUSIVE`** over 74 checks. The TalkBack pass came back green -
it had been inconclusive because `relaunch()`'s fixed sleep left it reading a blank screen
(`DEV-080`).

The two failures are both on `Invite someone@2` and both describe one node: no accessible name, and
20x20dp. **They do not reproduce.** That sheet run on its own, immediately afterwards, is 4/4 PASS;
so was the run of all five sheets at scale 2 taken before the full survey. Three narrowed runs pass
and one full run fails, which makes it state-dependent rather than a property of the screen - and
`InviteCaregiver.tsx` has no unlabelled control in it.

A 20x20dp unnamed clickable node is the shape of a text-selection handle, which Android raises when
a drag begins inside a field, and the survey now retries a stalled scroll from a different anchor on
a form that is mostly fields. That is a mechanism, not a reading: nobody captured the node.

Left open deliberately, and named as the first thing to do next. The temptation is to call it noise
because three runs disagree with it, and that is the wrong instinct twice over: a check that fails
one run in four is a check nobody will trust, and this session already spent an hour on `DEV-079`
learning what a red result nobody believes costs. `captureFailure` already writes a screenshot and a
hierarchy dump beside a failing check; pointing it at this one turns the hypothesis into evidence.

---

## 2026-09-07 (later) - the node, four more lookups, and a write that lied

Four tracks were started as subagents. Three were killed mid-run by a session rate limit and the
fourth stopped when its parent process exited. Nothing was lost - the work was in the tree and the
evidence was on disk - and what follows is partly theirs and partly the recovery, which is worth
saying because two of the findings came out of files a dead agent left behind.

### The intermittent accessibility failure was LogBox

The hypothesis this repository had recorded - an Android text-selection handle raised by a drag
beginning inside a field - was wrong. The node was captured and it is **React Native's LogBox
warning banner**, specifically its dismiss button, which Android's own dump marks `NAF="true"`. It
is in `com.kynviora.app` because LogBox renders inside the app's process, which is why filtering by
package never removed it.

Everything that made it look like noise follows from that. LogBox is on screen only once something
has logged a warning, so **whether** it appears depends on what the run did before, and **which**
sheet it lands on is whichever one was being surveyed at the time - `Invite someone@2` once,
`Voice Mode@1` the next. It was never a property of either sheet.

The instrumentation is the half worth keeping. The survey folded each dump into four fields per
control and discarded the node, and by the time a check runs the sheet is closed and the app
relaunched - so a failure had nothing behind it and three narrowed re-runs could only ever disagree
with it. A control now carries its whole reading, and an offender is written out with a screenshot
and a hierarchy dump **at the moment it is on screen**.

Excluded by identity, and reported rather than swallowed. Excluding it for being small, or unnamed,
or intermittent would have hidden the defects those two checks exist to find.

### Four more lookups keyed from outside, and one that failed open

DEC-146 predicted a third. There were four more, and the rule is now one function - `ownEntry` in
`packages/domain/src/lookup.ts` - rather than five copies of `Object.hasOwn`.

The one that matters is `describeUnresolvedCondition`. `lens.ts` drops a condition it has no
approved sentence for by testing `=== null`, and its own comment says why: a generic sentence
"reads as a complete answer when it is not". A prototype name resolved to a **function**, which is
not null, so it was not dropped - the Global Regulatory Lens rendered
`function toString() { [native code] }` as its explanation of why a rule could not be resolved. The
key arrives on a `LensEntryResponse`. `presentProvenance` did the same beside somebody's allergy;
`describeResolution` to a caregiver alert's outcome; and `authFailureFor` - keyed by the
**provider's** own `error_code`, the one key in this repository Kynviora does not choose - returned
a function from a signature promising an `AuthFailure`, which `authRefusal` turned into `undefined`
and the sign-in screen dereferenced.

The triage discipline mattered more than the fixes. About thirty sibling lookups were read and left
alone, because they take a narrowed union the caller has already guarded. The distinguishing
property is an **open `string` key with a load-bearing `??`** - those functions genuinely do not
know whether the key is one of the table's, which is what the fallback is for.

And one finding that was not about prototypes at all. `isOptimisticallyApplicable` was
`conflictPolicyFor(entityType) !== 'SERVER_WINS'`, and an unrecognised type is not `'SERVER_WINS'`

- so `12`'s prohibition answered **yes** for every input nobody had enumerated. A rule stated as a
  prohibition has to fail closed.

Every fix has a test that was run against the old code first: 15 failures in domain and
presentation, 17 in contracts. A regression test that never failed proves nothing.

### A write that never happened was spoken as "Done."

`VoiceProvider.run` speaks `done` when a tool returns no sentences, which is right for a tool that
succeeded quietly. `create_schedule`, `add_medicine` and `add_personal_care_item` returned
`{ spoken: [] }` for **every** non-OK outcome. So "set a reminder for my tablet at eight" with no
signal created nothing, queued nothing, and answered "Done." - and there is no later moment at
which the person finds out.

`record_dose` was the only write wired correctly, and it is the one the device scenarios drive.
`utteranceForWriteFailure` already existed in the same file with exactly one caller. 22 assertions,
failing against the old code.

`offline` rather than `queued`, because nothing queues a schedule by voice. The registry says it
does; only the dose reaches the journal. That gap is `DEV-084`.

### And six tools the agent is offered and cannot run

`createToolExecutor` defines 15 of 30. Seven absences are correct (`TOUCH_ONLY`) and two are
correct (`BLK-007`). Six are offered, unblocked and unrunnable - `list_safety_state` among them,
which is a journey Voice Mode exists for. Nothing had ever compared the registry to the executor;
`everyToolNameIsDefined()` checks the registry against itself. A test compares them now, with the
six named, and it fails both when a seventh appears and when one is wired without being removed
from the list.

### Environment, honestly

Two full survey runs were lost to the environment rather than to the code: Metro and the API had
died with an earlier session, so the app could not load its bundle and reported `INCONCLUSIVE` at
both font scales, and later the emulator hung under memory pressure with 4GB free on an 11GB
machine. `npm run verify` also failed twice with heap exhaustion while Metro was running, and
passed cleanly at 5183/197 once it was stopped. None of that is a finding about the product, and
none of it is recorded as one.

### The survey went green, and found a regression on the way

Three full runs were needed and the first two measured almost nothing, for reasons that were the
environment rather than the code: Metro and the API had died with an earlier session so the app
could not load its bundle, and then the emulator hung under memory pressure and had to be
reprovisioned. Both were reported as `INCONCLUSIVE` by the harness, which is the right answer and
is why they were not mistaken for results.

The third run, on a clean stack, found something real: `SHEET-2/Invite someone@2` reported two
controls as unreachable, deterministically. Checking out the pre-migration file and re-running the
same narrowed survey passed 4/4, so it was this session's regression and not something older.

Two causes, and only one was the product's. The migration put the capability rows inside a `Card`,
which applies `SPACING.lg` of its own, and left `lg` horizontal padding on each row - every row
padded twice, which at font scale 2 was enough to matter. And `MAX_SURVEY_STEPS` was 12 while the
survey reported 13 positions, meaning it had exited on the loop bound rather than on the sheet
having stopped moving: it had never seen the bottom of the form. With the budget raised it takes
20 positions and finds **13 controls where it used to find 10**. Three of that form's controls had
never been surveyed at all.

`SHEET-2` can no longer make that mistake. A survey that ran out of steps records the fact, and an
unreachable control found by one is `INCONCLUSIVE` rather than `FAIL`, because "never fully on
screen" and "further down than we looked" are the same reading and the harness cannot tell them
apart. It still fails the run - it says the survey needs more steps rather than blaming a screen.

**74 PASS, 0 FAIL, 0 INCONCLUSIVE** afterwards, which the survey has never reported before.

### The device round

| Harness      | Result    | What it covered                                                       |
| ------------ | --------- | --------------------------------------------------------------------- |
| `a11y`       | **74/74** | full and unnarrowed, five destinations and five sheets at 1x and 2x   |
| `doseaccess` | **7/7**   | `DOSE-2`, the ordering the migrated invitation form could have broken |
| `voice`      | **9/9**   | the executor changed under it                                         |
| `offline`    | **8/8**   | the queue gate that now fails closed on an unknown entity type        |
| `safety`     | **7/7**   | unchanged, re-run because the design layer moved                      |
| `caregiver`  | **5/5**   | unchanged                                                             |
| `camera`     | **5/5**   | the check most likely to break by accident, and did not               |

`offline` took two runs. The first came back with `OFF-6` and `OFF-7` inconclusive because the
harness typed "offline dose WCRR" and read back "Offline dose WCRR" - the note field has no
`autoCapitalize`, so React Native's `"sentences"` default applies. That is not a defect in the
field: capitalisation is part of what the person typed and they can backspace it. The harness was
assuming otherwise, and it only surfaced because the emulator had been reprovisioned and came back
with the platform default. A nonce that already starts with a capital has nothing left to disagree
about.
