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
