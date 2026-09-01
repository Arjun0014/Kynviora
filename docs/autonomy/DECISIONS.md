# Kynviora - Architecture and Engineering Decision Log

Format per task brief: Context / Options / Decision / Rationale / Consequences / Sources.
Spec decisions `D-001`..`D-015` in `23_DECISIONS_RISKS_AND_OPEN_QUESTIONS.md` are inherited as
binding and are not re-litigated here; entries below are _implementation_ decisions.

---

## DEC-001 - npm workspaces monorepo, no build-graph tool

**Context.** `11`/`12`/`13` require a mobile app, a modular-monolith API, async workers, a
reviewer console, and shared domain logic that must be **identical** across client and server
(controlled vocabularies, state machines, fingerprinting). Divergent copies of a safety
vocabulary between client and server is a correctness hazard, not a style issue.

**Options.** (a) Separate repos per surface. (b) npm workspaces monorepo. (c) Nx/Turborepo.

**Decision.** npm workspaces with TypeScript `paths` mapping `@kynviora/*` directly to package
source. No Nx/Turborepo, no per-package build step.

**Rationale.** One version of the domain vocabulary, atomic cross-cutting changes, and a single
CI gate. Mapping to source rather than to `dist/` removes build-ordering entirely - `vitest`
and `tsx` resolve TypeScript directly, and `tsc --noEmit` typechecks the whole graph in one
pass. A build orchestrator earns its complexity at a scale this project has not reached.

**Consequences.** Packages are not independently publishable (not required). The mobile app is
excluded from the root `tsconfig` because React Native needs its own compiler settings; it
consumes shared packages through Metro resolution instead.

---

## DEC-002 - Domain-pure core with dependency inversion

**Context.** `12` mandates dependencies point toward domain contracts and that route files
contain no SQL, authorization, credentials, safety rules, or evidence classification. `24`
requires safety logic to be reproducible and independently testable.

**Decision.** `packages/domain` has **zero runtime dependencies** and no I/O. Layering:
`domain <- contracts <- {catalog, regulatory, safety, ingestion} <- services/*`. Enforced by
an automated dependency-direction test, not by review discipline.

**Rationale.** Deterministic safety logic must be testable without a database, network, clock,
or provider. Making the rule engine a pure function of versioned inputs is what makes
"replaying the same versions reproduces the result" (`09`) mechanically true.

**Consequences.** All I/O enters through ports. Time and randomness are injected (`DEC-003`).

---

## DEC-003 - Injected `Clock` and `IdGenerator`; ambient `new Date()` is a lint error

**Context.** `09` requires assessment replay to reproduce results exactly. `07` requires
non-guessable IDs.

**Decision.** Every function whose output depends on time or identity takes a `Clock` and/or
`IdGenerator` port. A custom ESLint rule makes bare `new Date()` an **error** in production
code (allowed in tests/fixtures).

**Rationale.** Ambient time is the most common cause of irreproducible domain logic. A lint
rule catches it at authoring time rather than through a flaky test months later.

**Consequences.** Slightly heavier signatures; in exchange, replay tests can pin an exact
instant and assert byte-identical output. IDs use `crypto.randomUUID()` in production
(unguessable per `07`) and a deterministic counter in tests.

---

## DEC-004 - PGlite as the migration and RLS test harness

**Context.** No Docker in this environment. `14` and `19` make deny-by-default RLS negative
tests **release-gating**. Untested RLS is the single highest-impact authorization risk (`A1`
cross-household access in `15`).

**Options.** (a) Skip RLS tests, document as blocked. (b) Mock the database. (c) Require a
managed Postgres with live credentials. (d) PGlite (Postgres compiled to WASM).

**Decision.** PGlite. Migrations are plain SQL applied to a real PostgreSQL 18.3 engine
in-process; authorization tests execute genuine policies.

**Rationale.** (a) leaves the highest-risk control unverified. (b) would test the mock, not the
policy - actively misleading. (c) is unavailable and would fabricate an integration. (d) runs
the real engine and was verified empirically before adoption (see `RESEARCH.md` R-003).

**Consequences.** Schema, constraints, and RLS logic are genuinely tested. Managed-Postgres and
Supabase-specific behaviour, pooling, and performance remain unverified (`BLK-001`). Migrations
must stay portable SQL - no Supabase-only syntax in migration files.

---

## DEC-005 - Authorization tests run as a non-superuser role, enforced by a harness guard

**Context.** Empirically confirmed during R-003: querying as `postgres` returned **all rows**
despite `FORCE ROW LEVEL SECURITY`, because superusers bypass RLS. A test suite written
carelessly would pass while testing nothing.

**Decision.** The harness creates a dedicated non-superuser `kynviora_app` role with only the
grants the application needs. Before any authorization assertion, the harness asserts the
session is **not** superuser and **not** the table owner, and fails the test outright if it is.
Request identity is carried in `app.user_id` / `app.role` GUCs via `set_config`.

**Rationale.** Converts the classic RLS false-confidence trap from a review checklist item into
a mechanical failure. A vacuously-passing authorization test is worse than no test.

**Consequences.** Migrations must issue explicit `GRANT`s; a table with no grant is unreachable
by the app role, which is the correct deny-by-default posture.

---

## DEC-006 - Controlled vocabularies as exhaustively-checked closed unions

**Context.** `07` defines several controlled dimensions that must never collapse into one
another or into a universal score. `24` makes conflating them release-blocking.

**Decision.** Each dimension is a frozen `as const` tuple plus a derived union type, with
`@typescript-eslint/switch-exhaustiveness-check` enabled. Separate types per dimension -
`EvidenceLevel`, `ActionUrgency`, `MatchConfidence`, `ItemVerification`, `CatalogCorroboration`,
`RegulatoryStatus`, `ReviewState` - with **no** conversion function between evidence level and
urgency anywhere in the codebase.

**Rationale.** Constraint 1 and 2 (no universal score; evidence separate from urgency) are best
enforced by making the collapse _unrepresentable_. There is no `toSeverity()` to misuse because
none exists. Adding a status member breaks compilation at every switch that must handle it.

**Consequences.** Rendering must map each dimension independently. A dedicated test asserts no
module exports a function taking `EvidenceLevel` and returning `ActionUrgency`.

---

## DEC-007 - `RegulatoryApplicability` is separate from `RegulatoryStatus`

**Context.** `09` requires `CONDITION_UNKNOWN` when the law depends on a concentration or use
context the package does not disclose. The `03` demo scenario requires reporting
"restriction exists" + "compliance cannot be determined" rather than a violation claim.

**Options.** (a) Add `CONDITION_UNKNOWN` to the status enum. (b) Model applicability as a second
independent axis.

**Decision.** (b). A record carries a `status` (what the law says) **and** an `applicability`
(whether we can tell it bites for this package): `APPLIES`, `DOES_NOT_APPLY`,
`CONDITION_UNKNOWN`, `IDENTITY_UNCERTAIN`.

**Rationale.** They answer different questions and have different sources. Status comes from the
regulation; applicability comes from what the _package evidence_ does and does not disclose.
Folding them into one enum forces a lossy choice - exactly the "restricted rendered as banned"
failure mode in `A12`. A salicylic-acid restriction is `RESTRICTED` + `CONCENTRATION_LIMIT`
regardless of the package; whether the 2.0% limit is exceeded is `CONDITION_UNKNOWN` because
ingredient declarations list order, not percentages.

**Consequences.** The Lens always renders both axes. A test asserts a concentration-limited rule
with no disclosed concentration can never produce a compliance verdict.

---

## DEC-008 - Jurisdiction enum contains `GB` and `NI`, and no `UK`

**Context.** `D-013` and R-006. GB retained EU law and may diverge; NI applies EU rules under
the Windsor Framework.

**Decision.** `JURISDICTIONS = ['IN','EU','GB','NI','US','JP']`. No `UK` member exists. Copying
a status between GB and NI requires an explicit source-backed equivalence record.

**Rationale.** Makes the flattening error unrepresentable rather than merely discouraged.

**Consequences.** GB and NI need separately sourced records, correctly doubling ingestion work
for UK coverage - which reflects the actual legal reality.

---

## DEC-009 - Fastify + Zod for the API boundary

**Context.** `13` requires runtime input/output schema validation, stable machine-readable error
codes, idempotency keys, body-size limits, rate limiting, and cursor pagination.

**Options.** Express, Fastify, NestJS, Hono.

**Decision.** Fastify 5 with Zod 4 schemas, sharing the exact schema objects from
`@kynviora/contracts` used for persistence-boundary validation.

**Rationale.** Fastify has first-class schema validation, serialization, and body limits in the
core rather than bolted on; `13` requires validation on **both** directions and Fastify's
response serialization enforces the output contract. NestJS imposes a DI framework the modular
monolith does not need. One schema definition shared by API and persistence removes the
possibility of the two drifting.

**Consequences.** Contract tests can be generated from the same schemas; OpenAPI can be derived
later without a second source of truth.

---

## DEC-010 - Safety severity is server-authoritative; the client cannot compute or raise it

**Context.** `11`/`12` state the mobile app does not own safety severity. `A9` warns an OTA
update must not change safety behaviour.

**Decision.** The rule engine exists **only** in `packages/safety`, consumed exclusively by the
API and workers. The mobile app receives assessments as opaque validated read projections and
has no rule-evaluation code path. A malformed safety payload is rejected and the last trusted
assessment is preserved (`12` error-handling requirement).

**Rationale.** If rule code shipped in the bundle, an OTA update could silently change severity
for users - precisely `A9`. Keeping the engine server-side means rule publication follows the
reviewed lifecycle in `21`, independent of app releases.

**Consequences.** The client must handle "assessment not yet computed" as a real state. Shared
packages consumed by mobile are limited to vocabularies, contracts, and presentation helpers -
enforced by the dependency-direction test.

---

## DEC-011 - Adopt the Expo SDK 57 / RN 0.86 baseline unchanged, minimum `expo@57.0.9`

**Context.** R-001 confirmed the `11` baseline is real and current.

**Decision.** Adopt as specified. Install native packages via `npx expo install` so Expo
resolves SDK-compatible versions. Require `expo >= 57.0.9` to exclude the Hermes V1 memory
regression affecting Reanimated/Worklets.

**Rationale.** The spec baseline is current, not aspirational; deviating would create an
undocumented divergence for no benefit. Hand-pinning `react-native@0.87.x` would break Expo's
compatibility matrix.

**Consequences.** Version changes go through an ADR per `11`.

---

## DEC-012 - `expo-sqlite` + SQLCipher for the encrypted local store

**Context.** `12` and `14` require an encrypted structured local store with the key in
platform secure hardware; AsyncStorage is explicitly not approved for health data.

**Options.** `expo-sqlite` + SQLCipher, `op-sqlite` + SQLCipher, app-layer field encryption.

**Decision.** `expo-sqlite` with `useSQLCipher`. Per-install 256-bit random key from
`expo-crypto`, stored in `expo-secure-store` (Keystore/Keychain-backed), applied via
`PRAGMA key` immediately on open.

**Rationale.** First-party, fewest native dependencies, aligned with the config-plugin build
strategy in `21`. App-layer field encryption was rejected because it leaves indexes, table
names, and row counts in plaintext and makes queries unusable. `op-sqlite` is a reasonable
fallback if a specific need arises.

**Consequences.** Expo Go cannot run the app - a development build is mandatory, which `04`
Phase 0.1 already requires. On-device encryption-at-rest is **unverified in this environment**
(`BLK-002`).

---

## DEC-013 - Field assertions are append-only and superseded, never mutated

**Context.** `07`/`08` require field-level provenance with supersession history; `24` requires
that same-barcode/different-formula creates a conflict rather than an overwrite.

**Decision.** `FieldAssertion` rows are immutable. Correction inserts a new assertion pointing
at its predecessor via `supersedes_id`. The "current" value is a derived projection over the
non-superseded head. No `UPDATE` path exists on assertion values; the database enforces this
with a trigger, not only application code.

**Rationale.** Constraint 10 (corrections supersede, history never erased) and reproducible
replay both require the exact input version an assessment consumed to remain retrievable. A
mutable row destroys the ability to reproduce a past assessment, which `09` requires.

**Consequences.** Assertion tables grow monotonically and need a read projection for
performance. Worth it - this is the mechanism that makes the Safety Receipt and Evidence Diff
possible at all.

---

## DEC-014 - Provider ports declare an authority scope the resolver enforces

**Context.** `25` states a source may support one system and be prohibited from influencing
another - e.g. PubChem normalizes but is explicitly not a legal-status source; GS1 gives
identity but never proves formulation.

**Decision.** Every provider adapter declares `authorityScope`:
`identity` | `normalization` | `regulatory` | `discovery_only`. The resolver **rejects** a field
from a provider whose scope does not permit asserting it. `discovery_only` providers (including
all search/LLM research) can never contribute a stored field value - only a candidate reference
that must be independently retrieved.

**Rationale.** `25`'s hierarchy is a _runtime_ constraint, not documentation. Encoding it in the
port means "PubChem said this ingredient is banned in the EU" is rejected structurally rather
than depending on a developer remembering the rule.

**Consequences.** Adding a provider requires an explicit scope declaration. Tests assert an
out-of-scope assertion is refused.

---

## DEC-015 - Fingerprint is versioned, order-sensitive, and explicitly not proof of identity

**Context.** `08` requires a deterministic fingerprint that accelerates matching but is "not a
cryptographic proof that two physical products are identical", with a stored algorithm version.

**Decision.** `FormulationFingerprint` = SHA-256 over a canonical serialization of
`{algorithmVersion, market, productKind, normalizedIngredientSequence | activeIngredients+strength+form, manufacturerKey}`.
Ingredient **order is preserved** (INCI declarations are ordered by decreasing concentration, so
reordering is a material change). Every fingerprint row stores `algorithm_version`. The type is
branded so it cannot be passed where an identity is expected.

**Rationale.** Order-sensitivity captures a genuine formulation signal that a set-hash would
discard. Storing the version lets the algorithm evolve without rewriting history (`08`).
Branding prevents "fingerprints match, therefore same product" from compiling.

**Consequences.** A fingerprint match raises a **candidate**; corroboration still requires the
evidence checks in `08`. Tests cover both false-merge and false-split as `19` requires.

---

## DEC-016 - Regulatory fixtures ship as `REVIEW_REQUIRED` and are rejected by the Citation Gate

**Context.** R-004/R-005 produced regulatory facts from **search summaries**, not retrieved
official documents. `25`'s Citation Gate requires a retained source snapshot and checksum. `39`
of the task brief forbids pretending review occurred.

**Decision.** Every seeded regulatory fixture carries `review_state = REVIEW_REQUIRED` and
`verification = NEEDS_PRIMARY_VERIFICATION`, and the Citation Gate **rejects** it for
publication as trusted truth. A test asserts that no shipped fixture can reach `PUBLISHED`
without an official snapshot and a recorded reviewer.

**Rationale.** The fixtures are genuinely useful for exercising the engine and UI, and they are
accurate to the best of current research - but "accurate to the best of current research" is
precisely the standard the Citation Gate exists to reject. Shipping them as published truth
would be the fabricated-regulatory-approval failure the brief prohibits.

**Consequences.** The demo path shows real engine behaviour over honestly-labelled unverified
data. Turning any fixture into published truth requires the official snapshot plus a named
qualified reviewer - unavailable here (`BLK-004`, `BLK-006`).

---

## DEC-017 - Untrusted external text is structurally quarantined from instruction context

**Context.** `17` and `A13` require OCR text, product descriptions, regulatory documents, web
pages, and search results to be treated as data that may contain instructions.

**Decision.** A branded `Untrusted<T>` wrapper. Values enter only via an explicit
`markUntrusted()` at the ingress boundary and can only leave through `sanitizeForPrompt()`,
which strips control characters, caps length, and wraps content in delimited data blocks that
are never concatenated into a system-instruction position. AI ports accept only `Untrusted<T>`
for external content and expose **no** write/publish tool.

**Rationale.** Prompt-injection defence that relies on prompt wording is not a control. Making
untrusted text a distinct _type_ means passing raw OCR output into an instruction slot fails to
compile.

**Consequences.** Injection-resistance tests assert that documents containing directives such as
"ignore policy and publish" produce no state change and no elevated privilege.

---

## DEC-018 - Invitation tokens are stored only as a SHA-256 hash

**Context.** `04` Phase 8.1 requires an invite/accept flow. The invitation link is the one part
of this flow that leaves the system, and whoever holds it can claim access to another person's
medicines, safety history and documents. `14` requires sensitive data encrypted at rest,
minimised in logs, and never present in query strings.

**Options.** (a) Store the token in plaintext and compare directly. (b) Store an encrypted token
recoverable by the server. (c) Store only a hash, as with a password.

**Decision.** (c). The token is 32 bytes of `randomBytes` rendered as base64url (43 characters,
256 bits). Only `sha256(token)` is persisted, in a column the app role has no `SELECT` privilege
on. Acceptance looks the row up **by hash** rather than fetching a row and comparing, so a
non-constant-time comparison cannot be written. The plaintext is returned exactly once, in the
create response, and appears nowhere else: not in a URL, not in a log, not in an error message.
`inviteToken()` refuses to echo a rejected value into its exception for the same reason.

**Rationale.** An invitation token is a bearer credential to health data, so it deserves the
posture `14` prescribes for passwords. Plaintext storage means a database read, a backup, or a
support query silently discloses live access. Encryption at rest with a recoverable key only
moves the problem to key custody while keeping the token recoverable by anyone who reaches the
server.

**Consequences.** A retried create cannot re-issue the token; the replay response says so
explicitly (`tokenRecoverable: false`) and the owner must revoke and reissue if the first
response was lost. That is a real cost, accepted deliberately: the alternative is a credential
the system can hand out twice. A CHECK constraint requires 64 lowercase hex characters, which
rejects a plaintext token written into the hash column by mistake - the shape of a base64url
token cannot satisfy it. Tested at all three layers.

**Sources.** `14_SECURITY.md` (secret handling, logging policy, column-level controls);
`13_BACKEND_API_AND_SYNC.md` (no sensitive data in query strings).

---

## DEC-019 - Accepting an invitation never widens an existing grant

**Context.** A caregiver who already holds an active grant on a profile may be sent a second
invitation carrying a different capability set - by a different administrator, or by an owner who
forgot the first.

**Options.** (a) Merge the two capability sets. (b) Replace the old grant with the new one.
(c) Refuse, and require the owner to revoke first.

**Decision.** (c), enforced twice: `evaluateAcceptance` returns `INVITATION_ALREADY_RESOLVED`
with `reason_code: active_grant_exists`, and a partial unique index
(`caregiver_grant_active_unique` on `(profile_id, grantee_user_id) WHERE status = 'ACTIVE'`)
makes two active grants unrepresentable even under a race.

**Rationale.** (a) produces a permission set no one ever approved - and `kynviora.has_capability`
unions capabilities across matching grants, so a merge would happen silently at the policy layer
rather than as a visible decision. (b) silently drops access the owner had already approved.
Both change authorization through a link redemption, which is an action the owner does not
observe. Refusing keeps every capability change an explicit, audited act by the owner.

**Consequences.** Changing a caregiver's capabilities is revoke-then-reinvite rather than
re-invite. The index is partial on `ACTIVE`, so revoked and expired grants remain as history and
do not block a fresh invitation. An acceptance that loses the race is reported to the client as
an idempotent replay rather than an internal error.

**Sources.** `04_STAGES_AND_PHASES.md` Phase 8.1; `15_THREAT_MODEL.md` caregiver boundary.

---

## DEC-020 - Only the profile owner may delegate MANAGE_CAREGIVERS

**Context.** `MANAGE_CAREGIVERS` lets its holder invite and remove caregivers. `15` names
"malicious or overreaching caregiver" as a primary adversary and describes the risk as coercive
surveillance and retained access.

**Options.** (a) Any holder of `MANAGE_CAREGIVERS` may grant it onward. (b) A delegated
administrator may grant only capabilities they hold, which includes `MANAGE_CAREGIVERS`.
(c) Only the profile owner may grant `MANAGE_CAREGIVERS`, whoever else holds it.

**Decision.** (c), plus the subset rule from (b) for every other capability.

**Rationale.** Under (a) or (b), `MANAGE_CAREGIVERS` is self-propagating: one caregiver can
appoint further administrators, who appoint more, until the owner has lost practical control of
the access list for their own profile - and every individual step looks legitimate in the audit
log. The subset rule alone does not prevent this, because a holder of `MANAGE_CAREGIVERS` is
granting a capability they do hold.

**Consequences.** Adding a second administrator always requires the owner. This is a deliberate
friction on the one capability whose effect is invisible from inside the profile. The refusal
carries `CAPABILITY_ESCALATION` and does not name the refused capabilities, so the error is
uniform regardless of what was requested.

**Sources.** `15_THREAT_MODEL.md` (caregiver relationship boundary); `14_SECURITY.md`
(capability- and profile-scoped grants); `03_MVP_DEFINITION.md` group H.

---

## DEC-021 - A column-level GRANT protects the token hash, because RLS cannot

**Context.** The app role legitimately needs to list invitations for a profile it administers, so
the row must be readable. The token hash on that row must not be.

**Decision.** `GRANT SELECT (id, profile_id, ...)` enumerating every column _except_ `token_hash`,
rather than a table-level grant. `14` calls for exactly this: "Column-level or service-layer
controls protect immutable ownership/linkage fields."

**Rationale.** Row-level security is row-shaped. It has no way to hide a column from a row it
admits, so relying on it here would reduce "the app never reads the hash" to a convention about
how queries are written - and a `SELECT *` added later would quietly break it. A column-level
grant makes it a database fact: the query fails with `permission denied`.

**Consequences.** A new column on `caregiver_invitation` is invisible to the app role until it is
added to the grant list, which is the correct default. A test asserts that `SELECT token_hash` as
the app role is refused, and a separate test asserts every other column still reads.

**Sources.** `14_SECURITY.md` (authorization, column-level controls); `19` (negative
authorization tests).

---

## DEC-022 - A Visit Pack stores a manifest, not a copy of its content

**Context.** `07` calls a VisitPack a "generated selection/version snapshot". `16` requires
exports to expire, to be enumerable in the deletion workflow, and not to duplicate sensitive
content into logs. The obvious implementation is to render the pack once and store the result.

**Options.** (a) Store the rendered content. (b) Store a reference and re-render on retrieval.
(c) Store a manifest of selected record IDs and versions, plus a digest of the reviewed content,
and re-render from the live records.

**Decision.** (c). The `visit_pack` row holds `manifest` (section, entity kind, entity ID and
version per entry), `content_digest`, the user-written notes, `generated_at` and `expires_at`.
Retrieval rebuilds the entries from the live records through the RLS-scoped connection, then
recomputes the digest and reports `matchesGeneratedContent`.

**Rationale.** A stored copy would be a second store of exactly the data `16` classifies as most
sensitive - longer-lived than the original, reachable by a different path, and surviving the user
correcting or deleting the record it came from. It would also add a cached-export category to the
deletion workflow that `16` requires be enumerated. Re-rendering means a deletion is a deletion.

The notes are the deliberate exception: the user wrote them expressly to be shared, and they exist
nowhere else, so there is nothing to re-render them from.

**Consequences.** The underlying records can move on after generation. That is made visible
rather than silent: `matchesGeneratedContent` is false when the live entries no longer hash to
the stored digest, and `removedSinceGeneration` counts records that have gone. A reader is told
the pack no longer matches what was generated instead of being shown different data under an old
date. A test asserts no medicine name, ingredient term or direction text appears anywhere in the
`visit_pack` table.

**Sources.** `07_DOMAIN_MODEL.md` (VisitPack); `16_PRIVACY_CONSENT_AND_COMPLIANCE.md` (Export,
Deletion, retention matrix); `03_MVP_DEFINITION.md` group I.

---

## DEC-023 - Generation quotes the digest of what was reviewed, and is refused if it changed

**Context.** `04` Phase 8.4 exit criteria: "Export never happens automatically" and "A user can
review exactly what will be shared." Both are properties of a _sequence_ - propose, choose,
review, confirm - and a handler that only receives a final request cannot observe either one.

**Options.** (a) Trust the client to have shown a review screen. (b) Server-side session state
holding what was rendered. (c) Have the client quote a digest of the reviewed content, and
recompute it server-side at generation.

**Decision.** (c). `GET /v1/visit-packs/candidates` returns the proposal and a digest.
`POST /v1/visit-packs` carries `reviewedDigest`; `evaluateGeneration` rebuilds the selection from
live data, recomputes the digest, and returns `EXPORT_CONTENT_CHANGED` if it differs. Notes are
part of the digested content, so adding a question after the review is also a change. The
canonical form is a deterministic serialization over section, entity kind, entity ID, version,
every rendered line and the caveat, joined with U+001F and U+001E - control characters that
cannot survive the untrusted-input sanitiser, so content cannot forge a field boundary.

**Rationale.** (a) makes the exit criterion a claim about the client. (b) needs server state with
its own lifetime and expiry, for a guarantee a hash gives directly. The real failure this catches
is not an adversary - the user is exporting their own data - but _drift_: a caregiver editing a
medicine between the review screen and the Generate button would otherwise put a line into a
shared document that nobody read.

**Consequences.** Concurrent edits cause an export to fail rather than to silently differ, and
the user re-reviews. The digest includes the caveat, so an item that became verified since review
also counts as a change - correct, because the printed page differs. Step-up is checked before
everything else, including body parsing, so an un-authenticated export attempt is refused
identically whatever else is wrong with it.

**Sources.** `04_STAGES_AND_PHASES.md` Phase 8.4; `06` Journey 8; `14_SECURITY.md` (step-up for
exports); `16` (show what data will be included).

---

## DEC-024 - Authorization predicates use the real clock; written domain data uses the injected one

**Context.** Found while re-verifying Phase 8.4 on resume. `caregiver_invitation` wrote
`expires_at` from the injected clock but let `created_at` default to the database's `now()`, and
the two are compared by `caregiver_invitation_expiry_after_creation`. Once real time passed a
short lifetime anchored at the suite's frozen clock, the constraint became unsatisfiable and
creation returned 500. The test passed the day it was written and failed the next.

**Options.** (a) Move the frozen test clock forward periodically. (b) Drop the CHECK. (c) Give
every timestamp the injected clock. (d) Decide per column, by what the column is for.

**Decision.** (d), with an explicit rule. A timestamp that is **written domain data** comes from
the injected clock, so a row is reproducible and two values compared by a constraint are
commensurable. A timestamp used in an **authorization predicate** comes from the real clock,
because a clock the caller can influence must never be able to make an expired grant look live.

Concretely: `caregiver_invitation.created_at` and `visit_pack.generated_at` are supplied by the
writer from `ctx.now`. `kynviora.has_capability` keeps `g.expires_at > now()` and is deliberately
not converted.

**Rationale.** (a) is a maintenance trap that re-arms itself. (b) removes a real constraint to
hide a clock bug. (c) is wrong in the dangerous direction: routing an RLS expiry check through an
injectable clock would make revocation-by-expiry depend on a value the request supplies, which is
precisely the escalation `15` A2 exists to prevent. The bug was never that two clocks exist - it
is that both ended up inside a single comparison.

**Consequences.** A CHECK may only compare timestamps written from the same clock, and a column
participating in one may not rely on `DEFAULT now()`. The constraint in `0008` carries a comment
saying so. A test reads `created_at` back and asserts the injected clock wrote it, so the
invariant is named rather than caught incidentally by an expiry test.

**Sources.** `14_SECURITY.md`; `15` A2 (revocation takes effect immediately); DEC-010 and the
lint rule forbidding `new Date()` in production code.

---

## DEC-025 - Notification disclosure is two dials, and the narrower always wins

**Context.** `03` group H requires generic notification content by default; `16` requires
caregiver notifications to reveal minimal information and forbids using "family" to justify broad
hidden access. Two people have a legitimate say in what a caregiver's lock screen shows: the
profile owner, whose health information it is, and the caregiver, whose device it is.

**Options.** (a) Owner decides alone. (b) Recipient decides alone. (c) Owner sets a ceiling, the
recipient sets their own preference, and the effective level is the narrower of the two.

**Decision.** (c). `profile_notification_policy.max_caregiver_detail` is the owner's ceiling;
`notification_preference.detail_level` is each recipient's own setting. `selectRecipients` takes
`narrowerOf` the two. Levels are `GENERIC` (reveals nothing), `CATEGORY` (the kind of update, no
person or product), `NAMED` (may name both), ordered so the rule is literally "take the smaller
index". A missing row on either side means `GENERIC`, so absence is never read as permission.

The owner is exempt from the ceiling, because the ceiling limits what leaves the profile onto
somebody else's device and is not a restriction they place on themselves. Their own preference is
the only dial that applies to them - and it still defaults to `GENERIC`.

**Rationale.** (a) ignores that a caregiver may be on a shared or work phone the owner knows
nothing about. (b) lets a caregiver decide how much of someone else's health information appears
on a screen in a room the owner has never been in - which is exactly the "family justifies broad
access" pattern `16` names. Neither answer may override the other, so both apply.

The policy table deliberately holds **one** column. An earlier draft also gave it an `owner_detail`,
which a test caught: every recipient already has a personal preference, so a second owner-level
dial for the owner's own notifications was a duplicate answer to a question that has one, and the
two could disagree.

**Consequences.** A caregiver can be shown a level they did not choose, so the settings screen
says why (`OWNER_CAP_NOTE`) and marks unreachable levels rather than hiding them - a missing
option is indistinguishable from a broken screen. Raising the ceiling requires owner identity and
step-up; `MANAGE_CAREGIVERS` deliberately does not carry it, because an administrator who could
raise it would change what every other caregiver receives without the owner observing it.

**Sources.** `03` group H; `16` (caregiver privacy, data minimization); `15` A6; `04` Phase 8.2;
DEC-020 (delegation may not widen what the owner did not approve).

---

## DEC-026 - A delivery record stores that it happened, never what it said

**Context.** `04` Phase 8.2 needs a durable record of what was sent, for the owner's benefit and
for deduplication. The notification body is the one string in the system written expressly to be
readable on a locked screen (`15` A6).

**Options.** (a) Store the rendered body. (b) Store nothing and rely on the audit log. (c) Store
the recipient, the event, and the disclosure level - and re-render the text when needed.

**Decision.** (c). `alert_delivery` holds `recipient_user_id`, `event_kind`, the reference that
identifies the event, `detail_level` and `delivered_at`. No body column exists. The table is
append-only, and the app role holds no INSERT: `13` lists notification dispatch among the
privileged server-only operations.

**Rationale.** Storing the body would put the lock-screen string into a durable table with a
different access path from the alert it describes, outliving the alert's withdrawal - the same
objection as DEC-022 for Visit Packs. The level plus the event is enough to answer every question
the record exists for: was this person told, when, and how much did it show.

Deduplication is a unique index per `(event, recipient)` rather than a read-then-write, because
two dispatches racing would both read "not yet delivered". Per recipient rather than per alert, so
a caregiver whose grant is accepted after the first dispatch is still told exactly once.

**Consequences.** The delivery row is written _before_ the transport is called, so a crash between
the two leaves a recorded delivery that never arrived rather than an arrival nobody recorded - the
failure that re-notifies. That is the safer direction for a notification and the wrong one for a
payment; it is chosen deliberately, and a test pins it. Audit detail carries counts and levels
only, with no recipient identity and no body.

**Sources.** `04` Phase 8.2; `13` (privileged operations, idempotency); `15` A6; `16` (audit
without duplicating sensitive content); `07.5` (a repeated evaluation must not re-notify).

---

## DEC-027 - A review task is closed by writing to the record, not by a state change

**Context.** `04` Phase 8.3 exit criterion: "Completing a task updates the relevant authoritative
record." `review_task` already had a `state` column from migration `0004`, so the obvious
implementation - a Done button that sets `state = 'COMPLETED'` - was available and would have
satisfied the criterion in appearance while violating it in fact.

**Options.** (a) A `state` change, trusting the client to have also written the record.
(b) Two endpoints, one to write the record and one to close the task. (c) One endpoint that takes
the _change_, applies it to the authoritative record, and closes the task as a consequence.

**Decision.** (c), enforced at three layers. `evaluateCompletion` refuses a completion with no
changes, refuses a change targeting anything but the task's own subject, and refuses a field
outside `COMPLETABLE_FIELDS` for that kind. The route applies the record write **first** and
closes the task only if it affected a row. And `review_task_closed_wrote_something` is a CHECK
constraint: a row that is `COMPLETED` or `DISMISSED` with an empty `completion_fields` cannot
exist, so "mark done" is unwritable even by a direct SQL statement that bypasses the API.

`NOT_APPLICABLE` is not an exception. Deciding a task does not apply is itself information about
the record - "I looked at this pack and the details are right" is exactly what `last_reviewed_at`
means - so both outcomes write and neither can write nothing.

**Rationale.** (a) makes the exit criterion a claim about the client. (b) leaves the two writes
separable, so the failure mode is a task closed over a record that never changed. The whole point
of the criterion is that a to-do list about someone's medicines is worse than no list: it produces
the feeling of having maintained the data without the fact.

The field allow-list is what makes the criterion say "the **relevant** record". Without it a
completion could satisfy "change something" by touching an unrelated column, and the inbox would
be a general-purpose write endpoint that happens to close a task.

**Consequences.** The completion payload is larger than a tick, and the UI must offer the actual
change. That is the intended cost. If the record write is refused - by row-level security, or
because the row is gone - nothing closes and the task stays open, which is the correct outcome
and is asserted by a test. The user-facing copy says so out loud: "Kynviora does not keep a
separate tick list."

**Sources.** `04_STAGES_AND_PHASES.md` Phase 8.3; `16` (audit without duplicating content);
DEC-022 (the same instinct: record the event, not a second copy of the thing).

---

## DEC-028 - Inbox authorization follows the record, and the database has the last word

**Context.** `review_task` had an UPDATE policy requiring `MANAGE_CARE`. Completing a task writes
to an owned item, a caregiver grant, a safety receipt or a refill estimate - none of which
`MANAGE_CARE` governs.

**Options.** (a) Keep a single inbox permission. (b) Require the capability of the underlying
record, named per task kind. (c) Derive it dynamically from the subject row.

**Decision.** (b). `COMPLETION_CAPABILITIES` maps each kind to the capabilities that admit it, and
the `review_task_complete` policy repeats the mapping in SQL. A single inbox permission would be a
privilege side channel: someone with care access could correct a medicine, or renew their own
caregiver grant, by going through a task instead of the surface that governs it.
`CAREGIVER_GRANT_EXPIRING` maps to `MANAGE_CAREGIVERS` alone, and renewing a grant additionally
requires step-up, because it is caregiver administration whichever surface it is reached from.

**The refinement a test forced.** The owned-item kinds list **both** `MANAGE_SHELF` and
`MANAGE_MEDICINES`. `owned_item_update` narrows by `item_kind` - shelf for a personal-care
product, medicines for a medicine - and a task row names only the item's ID, so neither the domain
function nor the row-level policy can tell which applies. The first draft named `MANAGE_SHELF`
alone and the API tests failed: the domain said yes where the database said no. Listing one would
be too strict for half the items and misleadingly permissive for the other half.

**Rationale.** So the division of labour is explicit: the domain checks "you hold a management
capability at all", and `owned_item_update` - which knows the item kind - makes the binding
decision. The route attempts the record write first, and a write that affects no row closes
nothing and returns `PERMISSION_DENIED`. The database is the authority, as `13` intends, and the
domain never claims an authority it cannot exercise.

**Consequences.** A caregiver holding `MANAGE_SHELF` on a profile can open a medicine task and be
refused at the point of writing rather than at the point of listing. That is slightly later than
ideal and exactly correct: the alternative is a domain that disagrees with the policy that
decides. A test pins the case, including that the task stays open.

**Sources.** `04` Phase 8.3; `03` group H (separate permissions); `13` (RLS as defence in depth);
`14` (step-up for caregiver administration); DEC-020.

---

## DEC-029 - The difference vocabulary names a fact about the lists, not a change to the medicine

**Context.** `04` Phase 8.5 lists the expected output as "added/removed/changed fields". Those are
the natural words, and they are the words the screen uses in prose. The question was whether they
should also be the vocabulary - the enum stored in the database and carried through the API.

**Options.** (a) `ADDED` / `REMOVED` / `CHANGED`, matching the spec's wording exactly.
(b) `ONLY_IN_CURRENT` / `ONLY_IN_PREVIOUS` / `FIELD_DIFFERS` / `MATCHES`, naming what was
observed. (c) The spec's words with a comment explaining they do not mean what they say.

**Decision.** (b). "Removed" is a claim about the medicine - it implies someone stopped it. What
Kynviora actually knows is a fact about two documents: this line is on one list and not the other.
A medicine on the old list and absent from a discharge summary may have been stopped, or the
summary may only have covered the admission. Those are different situations with opposite correct
actions, and nothing in the system can tell them apart.

**Rationale.** The exit criterion is that Kynviora never chooses which conflicting instruction is
medically correct. A vocabulary that says `REMOVED` has already chosen, before any screen is
written, and every layer above it inherits the claim. `MATCHES` is in the list for the opposite
reason: a comparison that showed only problems would misrepresent the scale of what changed, which
is the most reassuring thing a reconciliation can get right.

**Consequences.** The presentation layer carries the burden of saying this in words - the
`ONLY_IN_PREVIOUS` copy states that Kynviora cannot tell why the medicine is absent - and three
tests assert the absence of "stopped", "discontinued" and "no longer" from the API body, the
domain vocabulary and the screen copy. A database CHECK refuses `ADDED`, `REMOVED`, `CHANGED` and
`STOPPED` as difference kinds, so the words cannot return through a direct write.

**Sources.** `04` Phase 8.5; `09` (never instruct a stop); `18` (state limitations); `07`.

---

## DEC-030 - Which value now stands is stated by a person, never inferred from recency

**Context.** `evaluateResolution` first treated `CONFIRMED_WITH_PHARMACIST` as adopting the
current list, on the reasoning that a professional confirming a difference must mean the newer
document is right. Writing the tests exposed that the two branches of the function collapsed to
the same result, which is usually a sign that a real case is missing. It was: a pharmacist may
confirm the _older_ dose, and frequently does - the new list may be a transcription error, or may
describe an intended change that never happened.

**Options.** (a) Infer the side from the resolution: a confirmation adopts the current list.
(b) Require the person to say which value was confirmed, for every settling resolution.
(c) Require it only where the resolution does not name a side itself.

**Decision.** (b), implemented as (c)'s shape: `USER_KEPT_PREVIOUS` and `USER_ADOPTED_CURRENT`
name their own side and a CHECK requires the stored `adopted_side` to agree with them, while the
three confirmations carry no side and the caller must supply one. `STILL_UNRESOLVED` may carry
none at all.

**Rationale.** Inferring `CURRENT` because the current list is newer is precisely the judgement
Phase 8.5 forbids: it is the software deciding which of two conflicting instructions is medically
correct, on the basis of a heuristic that has nothing to do with medicine. "Confirmed with
pharmacist" does not say what was confirmed, and a record that assumed would be wrong in exactly
the cases where the reconciliation mattered most.

**Consequences.** The API refuses a settling resolution with no side (`resolution_needs_a_side`),
and `difference_settled_has_side` refuses it at the schema level too. The presentation layer's
`optionsNeedingASide()` returns the three confirmations, so the screen has to ask rather than
assume. A professional confirmation landing on `PREVIOUS` changes nothing on the shelf and is
recorded as a decision, not as an absence of one - and a test asserts the shelf is untouched.

**Sources.** `04` Phase 8.5; `09`; `07` (provenance and attribution); DEC-024.

---

## DEC-031 - Withdrawal is deliberately cheaper than publication

**Context.** Phase 6.6 requires two-person approval for high-impact publication and an emergency
withdrawal control. The obvious symmetry - the same governance in both directions - is wrong, and
it took stating the failure modes side by side to see why.

**Options.** (a) Withdrawal needs the same approvals as the publication it reverses.
(b) Withdrawal needs one reviewer, and the person who asked may be that reviewer.
(c) Withdrawal needs no reviewer at all.

**Decision.** (b). `requiredApprovals` returns 1 for `WITHDRAW` whatever the content's declared
urgency; the separation-of-duties rule that forbids a requester approving or executing their own
request applies to `PUBLISH` only; the global publication block does not stop a withdrawal; and
`10`'s high-severity checklist is not asked for.

**Rationale.** The two failure modes are not symmetric. A wrongly-published alert tells a real
person to do something on Kynviora's authority. A wrongly-withdrawn one removes information, which
is the state the product is in for every item it does not cover anyway. `15`'s reviewer-compromise
threat is about _creating_ false publications. Making the safe direction the slow one would mean a
live wrong alert stays up while somebody hunts for a second reviewer, and a ten-item form in front
of an emergency stop is a reason the emergency stop does not get used.

(c) was rejected because attribution survives either way and costs nothing: a withdrawal still
names who did it and still requires a stated reason, which is what an incident review needs.

**Consequences.** A single compromised reviewer account can un-publish content. That is accepted:
the damage is the absence of information, which is recoverable by re-publishing through the full
two-person path, and it is bounded by the audit trail. The reverse - one account publishing a
false CRITICAL alert - remains impossible, which is the asymmetry the design is buying.

**Sources.** `04` Phase 6.6; `10` (emergency controls); `13`; `14`; `15`.

---

## DEC-032 - The right to approve is a stored role, and clinical is not regulatory

**Context.** Before this phase, `assessment_rule_version.approved_by_reviewer_id` and its
regulatory equivalents were free-text columns. Anything could be written into them, including a
team name, and nothing established that the named reviewer existed or was entitled to approve
what they had approved.

**Options.** (a) Keep the free-text reviewer name and validate it in the API. (b) A `reviewer`
table keyed by user, with a single generic reviewer role. (c) A `reviewer` table with the named
roles `10` requires, and a mapping from content kind to the roles that may approve it.

**Decision.** (c). `14` says admin/reviewer roles are not inferred from client claims, and `13`
forbids shared accounts, so a role is held by a user ID in a stored row. The role a reviewer acts
in is recorded on each approval, because a person may hold two and which one they used is part of
what makes the decision attributable.

**Rationale.** (b) would satisfy "two-person approval" with two people neither of whom can judge
the content in front of them, which reads as governance and is not. `10` is explicit that
regulatory comparison is a separate publication responsibility from clinical safety assessment,
so `REGULATORY_LEGAL_REVIEWER` cannot approve a safety rule and no clinical role can approve a
legal status. `CONTENT_PLAIN_LANGUAGE_OWNER` may approve an alert publication and nothing else:
reviewing the wording is not reviewing the finding.

**Consequences.** The mapping exists twice - as `APPROVING_ROLES` in the domain and as
`kynviora.role_may_approve` in SQL - for the same reason the Citation Gate exists twice. `14`
requires that direct database editing of publication state is not a normal workflow, and the way
to mean that is for the database to refuse it too. A test inserts an approval directly and watches
the trigger refuse it.

**Sources.** `10` (required roles, separation of duties); `13`; `14`; `04` Phase 6.6.

---

## DEC-033 - A 404 is about standing, not about the pairing

**Context.** `PERMISSION_DENIED` maps to 404 everywhere in this API so it is not an existence
oracle (trap 14). The first draft of the reviewer console returned it for "you may not approve
your own request" and "that role cannot judge this kind of content", and the tests showed what
that costs: a bare 404 with no reason, to a caller who can already see the request in their queue.

**Options.** (a) Keep `PERMISSION_DENIED` for consistency. (b) Classify the two pairing rules as
`VALIDATION_FAILED`, keeping `PERMISSION_DENIED` for questions of standing.

**Decision.** (b). Not holding any reviewer role, and holding a role one does not actually have,
stay `PERMISSION_DENIED` and 404 - those are about whether the caller belongs here at all, and the
404 is doing real work. Separation of duties and role-not-permitted-for-kind become 400 with their
reason codes.

**Rationale.** The 404 rule exists to stop the API confirming that a given ID exists. Inside the
reviewer console the caller is an established reviewer and the queue lists these requests by
design, so there is nothing left to hide - and what is wrong is the _pairing_ of this reviewer
with this request, not their standing to be looking at it. A silent 404 there costs the reviewer
the reason and buys nothing.

**Consequences.** The console can tell a reviewer why a control is unavailable, and the queue
reports `youMayApprove` per item so it does not offer a control the database will refuse. Trap 14
still holds everywhere else, and the two error classes now mean different things rather than one
of them meaning both.

**Sources.** `13`; `14`; trap 14; `04` Phase 6.6.

---

## DEC-034 - A shadow run has no recipients, so it cannot notify

**Context.** `04` Phase 6.7's first exit criterion is that a new high-impact rule can be evaluated
without user notification. The obvious implementation is a boolean: run the rule, then check
`shadowOnly` before dispatching.

**Options.** (a) A flag on the assessment, checked before every notification. (b) A separate
result type carrying counts and de-identified samples, with no recipients in it at all. (c) Both.

**Decision.** (b), and the flag survives as belt and braces. `ShadowRun` holds counts, per-reason
breakdowns and a bounded sample; `ShadowSample` is a projection of an assessment with the profile
removed. The results are written to `shadow_run`, which is not `profile_assessment` -
and `alert_publication` requires a `profile_assessment`, so the tables do not connect.

**Rationale.** A flag checked before notifying holds until the day somebody adds a second
notification path, which is how every "we did not mean to send that" incident happens. A value
with no recipients in it does not have that failure mode: code that wanted to notify from a shadow
run has nothing to read. The profile identities are counted and discarded inside `runShadow`, so
there is no point at which the run holds a list of people.

**Consequences.** A reviewer investigating a suspected false positive gets the item, the reasons,
the confidence and the rule version, which is what `10`'s procedure needs - and not the person.
Tests assert the absence over the sample's own keys and over the real table's columns, because the
guarantee has to survive somebody adding a field for a good reason.

**Sources.** `04` Phase 6.7; `09`; `10` (false-positive investigation); `15`; `16`.

---

## DEC-035 - A shadow run satisfies the approval gate locally, and that is not a bypass

**Context.** `evaluateRule` refuses an unapproved or disabled rule - correctly, because an
unapproved rule producing a match is threat A3's unauthorized publication path. But the rule a
shadow run exists to measure is precisely one nobody has approved: `04` Phase 6.7 is what a
reviewer looks at _before_ approving. Run under the live gates, every candidate reported zero
matches.

**Options.** (a) Require a rule to be approved before it can be shadow-run. (b) Add a
`reviewGate: 'ENFORCED' | 'SHADOW'` parameter to `evaluateRule`. (c) Build a local projection
inside `runShadow` that satisfies the gate for that evaluation only.

**Decision.** (c). `runShadow` evaluates `{ ...rule, reviewState: 'APPROVED',
approvedByReviewerId: SHADOW_EVALUATION_MARKER, enabled: true }`. The projection is local, the
caller's rule is unchanged, and the marker is `SHADOW_RUN_NOT_A_REVIEWER` - not a user ID and not
resembling one.

**Rationale.** (a) makes the feature useless: a candidate reporting zero matches reads as "this
rule affects nobody", which is the most dangerous wrong answer a blast-radius number can give, and
it is the same failure this codebase refuses elsewhere. (b) adds a way to disable the gate from
anywhere in the codebase, which is exactly what the gate is protecting against. (c) is
unreachable except through a function that has already refused a non-shadow rule, and nothing it
produces can become user-visible.

`enabled: true` is included for a less obvious reason: a rule an operator has just killed under
`10`'s emergency controls is exactly the one somebody needs to measure while working out what it
did, and refusing would remove the investigation tool at the moment it is needed.

**Consequences.** The safety of this rests entirely on three things holding together - the
shadow-mode refusal, the separate table, and the absent recipients - so all three are tested, and
the module header says so. A test asserts the caller's rule is not mutated, and another that
`evaluateRule` itself still refuses an unapproved rule.

**Sources.** `04` Phase 6.7; `10` (emergency controls); `15` A3; `09`.

---

## DEC-036 - A high-impact rule publication must name a shadow run of that rule

**Context.** Phase 6.6 shipped `10`'s high-severity checklist, in which a reviewer confirms the
expected matched-user volume and the rule matching behaviour. Until Phase 6.7 those confirmations
rested on a judgement: nothing produced the numbers, and `DEV-017` recorded the gap.

**Options.** (a) Leave the checklist item as a judgement and rely on the reviewer. (b) Record an
optional link to a shadow run. (c) Require the link for any safety-rule publication that needs two
approvals, and require the run to be a run of that rule.

**Decision.** (c). Migration `0013` adds `publication_request.shadow_run_id` and a trigger that
refuses a two-person `assessment_rule_version` publication without one, and refuses one naming a
run of a different rule.

**Rationale.** (b) would have been decoration - an optional field on a governance record is a
field that is empty when it matters. The pairing check is the part that does the work: attaching
somebody else's run is the obvious way to satisfy a requirement like this without meeting it, so
the trigger checks the pairing rather than the presence, exactly as the approval trigger checks
distinct reviewers rather than approval rows.

The threshold is deliberately the same one that requires two people, so "high-impact" keeps
meaning one thing across the console.

**Consequences.** Publishing a high-impact safety rule is now a three-step workflow - shadow run,
request, two approvals - and the Phase 6.6 API tests had to grow a shadow-run fixture. That churn
is the point: the console now demands the evidence its checklist claims was reviewed. `DEV-017` is
closed by this and by the run itself.

**Sources.** `04` Phase 6.6 and 6.7; `10` (rule authoring: shadow-mode result where required;
high-severity publication checklist); `22`.

---

## DEC-037 - The development database is PGlite on disk, and the seed lives inside the server

**Context.** Everything in this repository was verifiable and none of it was runnable. There was no
`main.ts`, no migration runner outside the test harness, and nothing that produced a `Principal` -
so the authorization rules could be proven and the app could not be opened. `BLK-001` records that
there is no managed Postgres and no Docker here, which is why the gap had persisted.

**Options.** (a) Wait for `BLK-001`: require a provisioned Postgres before anything can run.
(b) Add a `pg` driver and a connection string, and document that a database must be provided.
(c) Run against PGlite persisted to a directory - the same engine the authorization suite already
uses, with a `dataDir` instead of memory.

**Decision.** (c). `createRuntimeDb` opens a directory and applies migrations, and the API process
owns it. No service to provision, no connection string, no Docker.

**Rationale.** PGlite is genuine PostgreSQL 18.3, so the roles, the `FORCE ROW LEVEL SECURITY`
policies and the triggers all behave exactly as the test suite proves they do - which is the whole
reason DEC-004 chose it. (a) leaves the project in the state that prompted this: correct and
unopenable. (b) is the right production answer and the wrong development one, because it makes
"can I see it work" depend on somebody else's infrastructure.

The `RuntimeDb` interface is the seam. When `BLK-001` is resolved a second implementation lands
behind it and the API does not change.

**The mistake worth recording.** The seed was a standalone script first. PGlite is a **single
writer**: a seed process opening the same directory as a running server does not share its state,
and whichever exits last writes its snapshot over the other's. The seed reported success against a
database that stayed empty. So seeding now happens inside the API process on the connection it
already holds, behind `KYNVIORA_DEV_SEED=1` - one writer, one path, and the race cannot be
reintroduced by running two commands in the wrong order.

**Consequences.** Requests are serialised, because there is one connection. That is fine for
development and is stated in the module rather than discovered later. `main.test.ts` starts real
processes on real ports and asserts the authorization boundary against the real engine, which is
the first test in the repository that exercises role switching, the request GUC and the policies
together.

**Sources.** `BLK-001`; DEC-004/005; `13`; `14`; `21`.

---

## DEC-038 - A development authenticator, and the three ways it fails closed

**Context.** Phase 1.1 is `NOT_STARTED` deliberately - the schema holds no password hash because
the auth provider is an unmade product decision. Every route derives its authority from a
`Principal`, and nothing produced one, so no route could be exercised by hand.

**Options.** (a) Decide the auth provider now to unblock running the app. (b) A development
authenticator behind a flag. (c) Leave it, and accept that the app cannot be run until Phase 1.1.

**Decision.** (b). `createDevAuthenticator` reads a UUID from `x-kynviora-dev-user` and produces an
ordinary principal.

**Rationale.** (a) is deciding a product question for an engineering convenience, which is the
wrong order. (c) is what had already happened and is why this was needed.

The reason a backdoor is acceptable here is that it fails closed in three independent directions,
each of which is tested: it does not exist unless `KYNVIORA_DEV_AUTH` is exactly `1`; it **throws**
rather than warning under `NODE_ENV=production`, because a copied `.env` is the ordinary way a
development flag reaches a deployment; and with no header it returns `null`, which every route
already treats as unauthenticated.

**What it deliberately does not grant.** No reviewer role. `14` says admin and reviewer roles are
not inferred from client claims, and a header is a client claim - so the reviewer console still
requires a row in `reviewer`, which the seed does not create. A test asserts the seeded owner gets
404 from `/v1/reviewer/queue`. Handing out staff access through a header would be exactly the shape
of the thing Phases 6.6 and 6.7 spent their time refusing.

Step-up is a separate header and off by default, so the paths that require it can be exercised in
both directions rather than being permanently satisfied.

**Consequences.** The server refuses to start when no authenticator is configured, rather than
coming up and rejecting everything - a server that authenticates nobody fails in a way that looks
like a bug in every route, and the distinction is worth one explicit error at startup.
`KYNVIORA_ALLOW_ANONYMOUS_START=1` opts into it deliberately.

**Sources.** `04` Phase 1.1; `13`; `14`; DEC-032.

---

## DEC-039 - The client has no outcome meaning "you are not allowed"

**Context.** `errors.ts` maps `PERMISSION_DENIED` to **404**, deliberately, so the API is not an
existence oracle: a caller must not learn that a resource exists by being refused it (`19`; trap
14). Wiring the screens meant deciding what a client does with that 404, and the obvious reading -
"the server said no, so tell the user they lack permission" - would have undone the whole decision
at the layer a person actually reads.

**Options.** (a) Distinguish `PERMISSION_DENIED` from `NOT_FOUND` in the client, since the code is
right there in the body. (b) Map both to one outcome and let each screen decide. (c) Map both to
one outcome and give the union no member that could mean refusal.

**Decision.** (c). `classifyError` maps 404 - with `PERMISSION_DENIED`, with `NOT_FOUND`, or with
no parseable body at all - to a single `UNAVAILABLE` outcome carrying **only** its `kind`. There
is no code, no message and no correlation ID on it, because anything that appears for one case and
not the other is a side channel. `ScreenState` likewise has no `PERMISSION_DENIED` member.

**Rationale.** (a) hands back on the screen exactly the fact the status code was chosen to
withhold. (b) leaves the decision to every screen separately, which means it is made correctly
until somebody writes the next screen. (c) makes the safe answer the only expressible one: a test
enumerates the union and asserts no member matches `/DENIED|FORBIDDEN|REFUSED|NO_ACCESS/`, and
another asserts the `UNAVAILABLE` and `EMPTY` presentations share their tone, their retry label
and their content flag - so the two are indistinguishable to a reader as well as to a `switch`.

**Consequences.** A developer debugging a legitimately missing record gets no help from the screen
and has to read a server log. That is the cost, and it is the right way round: the alternative
spends a stranger's privacy to save a developer a minute. The integration suite asserts the
property end to end - a stranger asking for a real profile and for an invented one gets identical
resources.

**Sources.** `13`; `14`; `19`; `errors.ts`; DEC-021.

---

## DEC-040 - An unrecognised value from the server claims less, never more

**Context.** The client narrows several vocabularies out of responses: verification state, match
confidence, evidence level, urgency, caregiver grant status, notification detail, review task
kind. A value this client does not recognise means a newer server, a proxy rewriting a body, or a
bug - and every one of those needed an answer.

**Decision.** Each narrowing falls back to the member that **asserts least**: `UNVERIFIED` not
`CONFIRMED`, `NOT_MATCHED` not `EXACT`, evidence `U` not `A`, grant status `REVOKED` not `ACTIVE`,
notification detail `GENERIC` not `NAMED`. A review task kind and a caregiver capability have no
safe fallback at all, because the presentation layer holds one description per member and no
default - so an unrecognised one is **dropped**, and the count of dropped rows is returned so the
screen can say the list is short (`06`'s partial state).

**The one that goes the other way.** `asActionUrgency` falls back to `INFORMATIONAL` - the
_quietest_ value, not the most cautious. `02` and `18` require a product that does not optimise
for alarm, and "act now" raised because a string failed to parse is a false alarm with a
medicine's name attached to it. `09` sets the same default for a foreign regulatory difference, so
this is the existing rule rather than a new one.

**Rationale.** Deny by default (`14`) is usually stated about access; it applies identically to
claims about a medicine. The asymmetry makes the direction obvious in each case: reading an
unknown grant status as `ACTIVE` would state, in words on a screen, that somebody can see a
person's health data when nobody knows whether they can, while reading it as `REVOKED` costs one
unnecessary re-invitation.

**Consequences.** A server that adds a vocabulary member shows conservative values in older
clients rather than crashing or lying. Every fallback is tested by name.

**Sources.** `14`; `18`; `02`; `09`; `06`; DEC-025.

---

## DEC-041 - A failed refresh keeps the content and labels it, rather than discarding it

**Context.** The screens needed a rule for what happens when a refetch fails while something is
already on screen. The original mobile `offline` copy read "This shows what Kynviora last saved on
this device" - a claim about a local cache that does not exist behind these screens, so on an
offline first load it described data the user was not looking at.

**Decision.** `OFFLINE` and `STALE` are separate states and each says only what is true of itself.
`OFFLINE` means the check did not happen and there is nothing on screen. `STALE` means something
older is on screen and could not be refreshed. `useResource` returns `STALE` when a refetch fails
and there is previous content, and the failure state otherwise. `resourceFor` never carries a
value for a failed outcome, so "failure banner over discarded data" is not expressible.

**Rationale.** The three available behaviours on a failed refresh are: discard the content, leave
it up silently, or keep it and say it is older than it looks. The first takes away a medicine list
somebody was reading because a network call timed out. The second presents old information as
current, which `18` forbids. Neither state names _where_ the content came from, because the answer
differs between a failed refetch and a future local store and the reader does not need to know.

**Consequences.** `showsContent` on the presentation is the invariant: a resource carries a
non-null value exactly when its state says a screen may show one, and a test asserts they agree.

**Sources.** `06`; `12`; `18`; `24`.

---

## DEC-042 - The local database directory is anchored at the workspace root

**Context.** `npm run dev` runs with `services/api` as its working directory and `npm run migrate`
runs with `db`. `KYNVIORA_LOCAL_DB_DIR` defaulted to the relative `.kynviora-data`, so the two
commands opened **different databases** - and found this out by running them.

**Decision.** `resolveDataDir` anchors a relative value at the workspace root and honours an
absolute one as given. Both entry points use it.

**Rationale.** PGlite is a single writer (DEC-037), so the second directory is not a second
connection to one database - it is a separate, empty one. Running the migration CLI and then the
server would have shown an empty shelf against a database that had just been migrated, which reads
as data loss rather than as a path bug. This is the same class of failure as the standalone seed
that DEC-037 records, arriving by a different route: two things that look like one database.

**Consequences.** The same `.env` value means the same directory whichever script reads it. Four
tests assert it, including that an absolute path is left alone.

**Sources.** DEC-037; `21`; `BLK-001`.

---

## DEC-043 - The editor's field table is checked against the domain in both directions

**Context.** Completing a review task writes to the record it is about, and `COMPLETABLE_FIELDS`
names exactly which fields each kind may write. The editor needs a label, a reason and an input
kind per field - none of which the domain has, because they are words rather than rules.

**Options.** (a) Derive the form from the domain and label fields by prettifying the column name.
(b) Write the form per kind by hand. (c) Key a table of labels by column name and check it against
`COMPLETABLE_FIELDS` both ways.

**Decision.** (c). `FIELD_DEFINITIONS` is keyed by the column the API expects, `taskForm` builds a
kind's form by mapping over `COMPLETABLE_FIELDS[kind]`, and `everyCompletableFieldEditable`
asserts the two key sets are equal.

**Rationale.** (a) produces "Batch id" and "Directions text" as labels and no reason at all, and
`18` requires the reason for a request to be stated rather than assumed. (b) drifts: a field added
to a kind in the domain becomes a task nobody can complete, and one removed becomes a control that
always errors - both silent. The two-way check turns either into a failing test.

**Consequences.** Adding a completable field is a two-file change and the suite says so. The form
also carries the completion note on every kind, because someone expecting a tick box needs to know
why the screen is asking for something instead.

**Sources.** `04` Phase 8.3; `18`; DEC-027.

---

## DEC-044 - A field that names another record is not something to type

**Context.** The editor offered `batch_id` as a text box labelled "Batch or lot number". Running it
end to end failed: `batch_id` is a `uuid` referencing `batch_or_lot`, the API casts the value with
`::uuid`, and a printed lot code is not one. `formulation_id` is the same shape.

**Options.** (a) Accept a lot code as text and have the API resolve or create the batch record.
(b) Offer only the other field of the pair - complete `BATCH_MISSING` by setting
`batch_verification` alone. (c) Model these as a `REFERENCE` input the editor does not render, and
mark the whole kind as not completable here.

**Decision.** (c). `FIELD_INPUTS` gains `REFERENCE`; `taskForm` reports `completableHere: false`
when a kind's **primary** field is one, offers no fields at all in that case, and carries a
sentence saying what is actually needed. `buildCompletion` refuses such a kind before it looks at
any value.

**Rationale.** (a) creates a catalog record from a typed string with no provenance, no
corroboration and no quality gate - which is precisely what the catalog layer is built to prevent,
and it would do it on the way to closing a maintenance task. (b) is worse than it looks: it lets
someone record "I am not sure where this came from" and close a task called _add the batch
number_. That is a mark-done path wearing a different label, and trap 16 exists because the
temptation to add one recurs.

Offering no fields rather than the non-primary ones is the part worth keeping. A form showing one
control that cannot complete the task invites exactly the wrong completion.

**Consequences.** Five of the seven task kinds are completable from the inbox; `BATCH_MISSING` and
`FORMULA_NEEDS_CONFIRMATION` show what they need and wait for guided capture (`DEV-024`). The
development seed now ages one item past the review interval, because otherwise every derived task
was a `BATCH_MISSING` and a developer opening Today would see only work the app cannot do.

**Sources.** `04` Phase 8.3 and Phase 3.2; `07`; `08`; DEC-027; trap 16.

---

## DEC-045 - A capability the inviter cannot delegate is absent, not disabled

**Context.** The invite screen has to choose what to offer. `canDelegateCapabilities` is the
authority and lives in the domain: a profile owner may grant anything; a caregiver may grant only
what they hold, and never `MANAGE_CAREGIVERS` (DEC-020).

**Options.** (a) Offer everything and let the server refuse with `CAPABILITY_ESCALATION`. (b) Offer
everything, disabling what cannot be granted. (c) Offer only what can be granted.

**Decision.** (c). `selectableCapabilities` mirrors the delegation rule and returns a list;
`buildInvitation` refuses anything outside it before a request is built.

**Rationale.** This is a usability decision rather than a security one - the server refuses either
way - and the difference is what the screen teaches. (a) sends a request whose refusal tells a
caregiver something about the permission model by being refused. (b) is worse: a greyed-out
"manage caregivers" box states that the capability exists and that this person is not trusted with
it, on a screen about someone's family.

The mirroring is deliberate duplication and is documented as such in the module: the domain
decides, this only keeps the screen from offering a control whose sole outcome is a refusal.

**Consequences.** A caregiver whose own capabilities the client does not yet know is offered
nothing rather than something that might be refused - the safe direction, and visible rather than
silent. `GET /v1/caregiver-grants` does not return the caller's own capabilities, so that is where
it stays until it does.

**Sources.** `04` Phase 8.1; `16`; `18`; DEC-019/020.

---

## DEC-046 - The Care screen lists outstanding invitations, not only grants

**Context.** `GET /v1/caregiver-grants` returns `caregiver_grant` rows, and a grant does not exist
until someone accepts. So after sending an invitation the Care screen showed exactly what it had
shown before: nothing.

**Options.** (a) Leave it, and have the invite screen say the invitation was sent. (b) Return
pending invitations from the grants route. (c) Add `GET /v1/caregiver-invitations` and render both
lists as one.

**Decision.** (c).

**Rationale.** (a) is not a cosmetic gap. An owner who sees no change reasonably sends a second
invitation, which mints a second live credential for one intent - precisely what the idempotency
key on the create route exists to prevent, defeated by the screen rather than by the protocol.
(b) conflates two records with different lifecycles and different visibility rules.

The route needed no new authorization: `caregiver_invitation_select` already admits the profile
owner, an administering caregiver and the account that accepted, and deliberately not the intended
recipient before acceptance - they hold the token, and matching an invitation to an address they
have not proven they control would leak that the profile exists. The app role's column-level
`GRANT` omits `token_hash` entirely, so "the app role cannot read the secret" stays a database fact
rather than a property of how this query happens to be written (DEC-021).

**What the response deliberately omits.** The invited address. It returns `boundToAddress: true`
instead - whether the link is bound to one person or open to anyone holding it, which is the fact
an owner needs. `14` treats an address as personal data and this list is read on a screen someone
else may be looking at.

**Consequences.** The Care screen makes two requests and combines them. If the invitations call
fails and the grants call succeeds the resource is `PARTIAL`, which says the list is incomplete
rather than showing a shorter one as though it were the whole answer.

**Sources.** `04` Phase 8.1; `13`; `14`; `16`; DEC-018; DEC-021.

---

## DEC-047 - `GET /v1/profiles` says whether the caller owns each profile

**Context.** The invite screen gates on ownership, and the profiles response carried only
`isManaged`. It was read as ownership, which is wrong: `isManaged` describes the person the profile
is for - somebody being looked after - and says nothing about who administers it. An owner may
perfectly well own a managed profile.

**Decision.** The response carries `isOwner`, computed as `owner_user_id = current principal`.

**Rationale.** It discloses nothing: a caller who owns a profile already knows they own it, and the
field says nothing about anyone else. The alternative was for every screen that gates on ownership
to infer it - from `isManaged`, which is a different fact, or from a second request to a route that
happens to return a `relationship`. Both are ways of getting the right answer by accident.

**Consequences.** One field, and the wrong inference is unavailable rather than merely discouraged.

**Sources.** `13`; `16`; `04` Phase 8.1.

---

## DEC-048 - The client hashes what it displayed, and the canonical form has one definition

**Context.** DEC-023 makes "a user can review exactly what will be shared" a property of the system
rather than a claim about the client: generation quotes the digest of the reviewed content, and the
server rebuilds the selection from live records, recomputes the digest, and refuses with
`EXPORT_CONTENT_CHANGED` if it differs. Wiring the screen meant deciding where the client's digest
comes from.

**Decision.** The screen fetches candidates **once** and everything downstream works from that
list. `buildVisitPack` hashes exactly those entries and never re-fetches. `canonicalizeSelection`
is imported from the domain unchanged, so the two sides cannot disagree about what is being hashed;
only the hashing itself is a port, because SHA-256 is asynchronous on every platform and comes from
a different module on each - `expo-crypto` on a device, `node:crypto` in a test.

**The duplication that had to be removed.** The note entries were built inline inside
`evaluateGeneration`, with the caveat as a string literal. The digest covers the notes as well as
the records, so a client that spelled that caveat differently - or omitted the notes - would
compute a digest the server refuses, and the user would be told the content had changed when
nothing had. `toNoteEntries` and `USER_NOTE_CAVEAT` are now exported and used by both sides.

**An unrecognised entry is refused, not coerced.** The canonical form includes the section, the
entity kind and the caveat verbatim. Substituting a default for a value this client does not
recognise produces a digest that differs from the server's, so `EXPORT_CONTENT_CHANGED` would start
firing for a reason it was not built to report - and the user would be told their records moved
when the app was simply older than the server. `toEntry` returns `null` and the draft is refused
with a message about updating the app.

**Consequences.** `EXPORT_CONTENT_CHANGED` is handled as the one refusal on this path that is not a
mistake: the screen reloads and returns the user to the list rather than retrying, because retrying
sends the same stale digest and a person pressing "try again" three times deserves better than
three identical refusals.

**Sources.** `04` Phase 8.4; `06` Journey 8; `14`; DEC-022; DEC-023.

---

## DEC-049 - Settling a difference is two questions, and the screen asks both

**Context.** `ReconciliationReview` offered the six resolution options and called back with one:
`onChooseResolution(differenceId, resolution)`. That is half an answer. `evaluateResolution`
refuses a settling resolution with no side, so every one of those callbacks would have produced a
server error - and the obvious way to "fix" it is the one Phase 8.5 forbids.

**Options.** (a) Infer the side from the resolution, defaulting a confirmation to the current
list because it is newer. (b) Send with no side and surface the server's refusal. (c) A second
step that asks which value stands, for every settling resolution.

**Decision.** (c). `ResolutionPrompt` renders both values through `presentSide`, collects the side
and, where the option requires one, the name of who confirmed it.

**Rationale.** (a) is exactly the judgement `04` Phase 8.5 forbids: a pharmacist may confirm the
older dose, so "a pharmacist confirmed it" does not say which value they confirmed. The option's
own `fixedSide` is `null` for all three confirmations precisely because the answer is not knowable
from the choice. (b) makes the rule visible only as an error, after the user believed they had
answered.

**What the prompt does not do.** No option is pre-selected for a confirmation and neither side is
styled as primary; both come from `presentSide`, which returns the same tone and
`emphasised: false` for each, rendered from one style object. Two styles that happen to match today
are two styles that can drift apart tomorrow, and the drift is the exit criterion (trap 21).

**Consequences.** `USER_KEPT_PREVIOUS` and `USER_ADOPTED_CURRENT` carry their own side, so the
prompt does not ask - it would be asking a question the person already answered by choosing. The
same builder decides whether the button is enabled and what gets sent, so a control cannot enable
something the builder would refuse.

**Sources.** `04` Phase 8.5; `09`; `18`; DEC-029; DEC-030.

## DEC-050 - A failed refresh keeps content only where the server said nothing about access

**Context.** `useResource` returned `STALE` with the previous content for **any** failed refresh.
Designing revocation exposed what that means: `15` A2 requires a revoked caregiver to lose access
on their very next authenticated access, and the server does exactly that. The client undid it. The
person whose access had just been removed carried on reading the medicine list, under a label
saying it was not up to date.

**Options.** (a) Clear the content on every failure. (b) Keep the rule and special-case the
caregiver screens. (c) Decide by what the failure _says_.

**Decision.** (c). `retainsPreviousContent` returns true for `OFFLINE` and `SERVER_ERROR` only.
`refreshedResource` holds the whole decision and the hook makes none of its own.

**Rationale.** The question is not "did the request fail" but "did the server answer about this
caller's access". `OFFLINE` and `SERVER_ERROR` did not answer, so the content is genuinely older
than it looks and DEC-041's label is the honest response. Every other failure is an answer, and the
answer is no. (a) would take a medicine list away because a refresh timed out, which DEC-041
already rejected. (b) puts the security property on the screens somebody remembered.

**`UNAVAILABLE` is the shape revocation actually arrives in.** `PERMISSION_DENIED` is answered with
404 so the API is not an existence oracle (DEC-039), so the outcome that means "your access ended"
is the same one that means "there is nothing here". Both must clear the screen, which they now do.
Note the two shapes a revoked caller meets: an RLS-filtered list route answers `OK` with nothing,
and a profile-scoped route answers 404. A rule handling only the first would leave the caregiver's
notification settings on screen.

**`REFUSED` retains nothing either, for a different reason.** It is the one failure carrying a
message the server wrote for this user to act on, and stale content on top of it hides the only
thing that would tell them what to do.

**Consequences.** An empty success now clears the retained value too, so a later offline refresh
cannot resurrect a list the server has already said is gone.

**Sources.** `15` A2; `12`; `18`; DEC-039; DEC-041.

## DEC-051 - The access list tags each row with the record it came from

**Context.** The Care screen deliberately shows accepted grants and outstanding invitations
together, because they answer one question: who can read this profile. They are two records with
two revocation routes, and `onRevoke(id)` carried only an ID.

**Options.** (a) Try the grant route and fall back to the invitation route. (b) Guess from the
row's state. (c) Carry the record kind on the row.

**Decision.** (c). `CaregiverAccessRowView.subject` is `GRANT` or `INVITATION`, and
`buildRevocation` reads it from the row the person is looking at.

**Rationale.** The failure mode of getting this wrong is quiet. The wrong route answers 404, the
client correctly renders a 404 as absence (DEC-039), and the screen would have looked like the row
vanishing rather than like a bug - on the one screen where a row disappearing is a statement about
who can read someone's health data. (a) sends an authenticated write to a record the caller did not
name. (b) works today only because no grant is ever `INVITED` and no invitation is ever `ACTIVE`,
which is a coincidence of the current status vocabulary.

**Sources.** `04` Phase 8.1; `12`; DEC-039; trap 14.

## DEC-052 - Whose grant it is comes from the server, not from the session

**Context.** Removing your own access and removing somebody else's are different sentences, and an
administering caregiver sees both kinds of row in one list. The screen needed to know which.

**Options.** (a) Compare `granteeUserId` against the identity in the client session. (b) Ask the
API. (c) Write copy that works for both.

**Decision.** (b). `GET /v1/caregiver-grants` returns `isSelf` per row, exactly as
`GET /v1/profiles` returns `isOwner` (DEC-047).

**Rationale.** (a) reads identity back out of a session to decide what to put on screen, which is
the shape `13` and `DEV-026` both warn about - and in development that identity is a header, which
is a client claim. (c) is not achievable honestly: "they will stop seeing this profile" in front of
someone removing their own access is not a wording problem, it is a statement about a different
person.

**Deny by default applies to the narrowing too.** A response with no `isSelf` produces `false`, so
an older server cannot make the screen say "remove your own access" to somebody removing another
person's.

**Consequences.** This is also the field `DEV-026` names as required future work: an administering
caregiver's own capabilities can now be picked out of the grants listing without matching on a
user ID the client should not be reasoning about.

**Sources.** `04` Phase 8.1; `13`; `16`; DEC-047; `DEV-026`.

## DEC-053 - Revocation takes no idempotency key, and a repeat reports success

**Context.** Every other caregiver mutation carries an idempotency key. Revocation does not.

**Decision.** No key, and a repeated revocation returns `200` with `alreadyRevoked: true`.

**Rationale.** A key exists because a retry could commit a second write. Creating an invitation
mints a credential, so a key regenerated on retry mints a second live token for one intent.
Revocation has one destination state: arriving at it twice is arriving at it once, and there is no
second thing for a key to prevent. The domain already made the repeat succeed rather than fail
(`evaluateGrantRevocation`), because someone removing another person's access who is answered with
an error has been given a reason to doubt whether it worked.

**The two are still different sentences.** `alreadyRevoked` is reported, and the screen says "this
access had already ended" rather than crediting the person with a change they did not make.

**Sources.** `13`; `15` A2; `04` Phase 8.1.

## DEC-054 - The removal screen supplies the wording for one refusal code

**Context.** Withdrawing an invitation that has already been accepted is refused. The route writes
"This invitation was accepted. Revoke the caregiver access instead." - and `errors.ts` replaces it
on the wire with the client-safe message for `INVITATION_ALREADY_RESOLVED`, which is shared with
the acceptance path: "This invitation has already been used." True, and a dead end for an owner who
is looking at the list and wants the access gone. Found by an end-to-end test asserting the
specific message and getting the generic one.

**Options.** (a) Make the wire message specific. (b) Show the generic message. (c) Supply the
wording on the screen, for this code only.

**Decision.** (c). `revocationMessage` returns the server's own message for every outcome except
`INVITATION_ALREADY_RESOLVED`, where it returns `REVOCATION_COPY.alreadyAccepted`.

**Rationale.** (a) changes what an acceptance failure tells a stranger holding a link, where the
message is generic on purpose - the same code covers expired, declined and revoked, and the
recipient must not learn which. (b) leaves the owner told only that something is spent.

**This is not the client inventing a reason.** The rule is that the client never supplies a reason
the server withheld, and the server withheld nothing here: it sent the code, and its `detail`
carries `reason_code: already_accepted` because a 409 is not one of the suppressed classes. What is
missing on the wire is wording, and both sentences make the same claim - only one of them says what
to do next.

**Sources.** `12`; `13`; `14`; `18`; DEC-039.

## DEC-055 - What a caregiver may delegate is the union of their own active grants

**Context.** `selectableCapabilities` had implemented "only what they hold, and never caregiver
administration" since Phase 8.1, correctly and with its own tests, and had never been handed
anything but an empty list. `DEV-026` recorded why: picking the caller's own grant out of a listing
that includes other people's meant matching on a user ID the client should not be reasoning about.
DEC-052 removed that obstacle.

**Decision.** `heldCapabilities(grants, asOf)` unions the capabilities across the grants the server
marked `isSelf`, discounting any that is not `ACTIVE`, is revoked, or has expired.

**Rationale for the union.** It is what `kynviora.has_capability` does in SQL, and the reason a
merge of two grants for one pair is refused by a partial unique index rather than tidied up
(trap 10). Picking one row would disagree with the server about what this person holds.

**An expired grant contributes nothing even where its status still says `ACTIVE`.** `status` and
`expires_at` are separate columns and `has_capability` checks both, so the stored status is not on
its own evidence that a grant still carries anything.

**The clock is the response's `serverTime`, not the device's.** DEC-024 reserves the real clock for
authorization predicates, and this is not one - the server decides again on the request. Using the
clock that produced the rows keeps the screen consistent with the answer it is rendering, and the
worst case of getting it wrong is a control the server refuses rather than an access decision.

**This is not the boundary.** `canDelegateCapabilities` runs server-side on every request. An
end-to-end test bypasses the screen and confirms `CAPABILITY_ESCALATION`.

**Sources.** `04` Phase 8.1; `16`; DEC-020; DEC-024; DEC-052; `DEV-026`; trap 10.

## DEC-056 - A caregiver who may delegate nothing is offered no invite control

**Context.** The Care screen showed "Invite someone" to every caller. For a caregiver with no
administrative authority the only reachable outcome was a 404 - after they had chosen capabilities
and typed an address.

**Options.** (a) Leave it and let the server refuse. (b) Show it disabled. (c) Withhold it.

**Decision.** (c). `mayInvite` returns true for the profile owner, and for a caregiver only where
they hold `MANAGE_CAREGIVERS` **and** have something left to offer.

**Rationale.** This is DEC-045's reasoning one level up: a greyed-out control states that the action
exists and that this person is not trusted with it, which is a fact about the permission model they
did not need. (a) spends a form on a refusal.

**Two conditions, not one.** A caregiver holding only `MANAGE_CAREGIVERS` passes the server's
authority check and still has nothing to offer, because DEC-020 forbids them delegating caregiver
administration itself. Collapsing the two would show them a screen with no capabilities on it.

**Still a usability decision.** `authorityOver` answers `PERMISSION_DENIED` as a 404 regardless, and
a test asserts that the server refuses the request the withheld control would have made - which is
what makes hiding it honest rather than merely tidy.

**Sources.** `04` Phase 8.1; `12`; `16`; DEC-020; DEC-045; DEC-055.

## DEC-057 - The dose history is a list, and carries no number about what a person did

**Context.** Phase 4.3's goal is "let users record what happened without gamifying or judging
them". The obvious read side of a dose record is a summary: taken 12, skipped 3, 80% this month.

**Options.** (a) Per-kind counts. (b) A rate or streak. (c) The events, in order, and nothing else.

**Decision.** (c). `GET /v1/dose-events` returns the events; `doseHistory` returns lines and one
number - how many events this build could not name. Tests enumerate the response's keys, the
view's keys and the module's exported names.

**Rationale.** Someone who skipped a dose because it made them ill has recorded a decision about
their own treatment. A number telling them how often they do that has told them the decision was
wrong, which is medical advice arrived at by arithmetic and attributed to nobody. `02` lists
gamified adherence scoring as a named anti-feature and `23` D-005 forbids the aggregate.

**Why the absence is enforced at the route as well as the screen.** A `takenCount` on the response
hands a screen everything it needs to draw a scorecard, and the screen is the layer where nobody
would notice it had been reintroduced - the same reasoning that keeps urgency off a review task at
every layer rather than only in the tone list (trap 17).

**`SKIPPED` and `UNABLE_TO_TAKE` stay two kinds.** They are different facts, and "missed" - the
word the notification vocabulary uses for a schedule that lapsed with nothing recorded - loses the
difference. A person who could not take a medicine and a person who chose not to have both told
Kynviora something.

**Sources.** `04` Phase 4.3; `02`; `09`; `18`; `23` D-005.

## DEC-058 - Every dose control carries the same weight, and every recorded kind the same tone

**Context.** "I took it" is the common case and the natural primary action.

**Decision.** Four controls of equal weight in the vocabulary's order, and one shared `neutral`
tone across all four recorded kinds. The icons differ so the kinds stay distinguishable.

**Rationale.** An emphasised "I took it" is a preference about somebody's treatment expressed in a
button style, and a red chip on `SKIPPED` beside a green one on `TAKEN` is a scorecard drawn in
colour. `18` forbids meaning through colour alone, which is usually read as "add a label" - here it
is read in the other direction: with one tone, the shape has to carry the distinction, so the four
icons must differ and a test asserts they do.

**Praise is the other half of shame.** The copy scan rejects "well done" and "keep it up" as well as
the reproaches, because the screen that congratulates you on Monday is the one with an opinion on
Tuesday.

**Sources.** `04` Phase 4.3; `18`; `02`.

## DEC-059 - An operational metric is a key from a closed vocabulary and a number

**Context.** `20`'s first observability principle is "measure system behavior, not sensitive
content", and its alerting section says operator output should carry "identifiers/codes, not
medicine names or diagnoses". A projection is exactly where somebody would helpfully attach "which
profile" to make a number actionable.

**Decision.** `MetricReading` is `{ key, value, unit }` - the key from `OPERATIONAL_METRICS`, the
value a `number`. There is no `label`, `subject`, `profileId` or `note`, and there is nowhere in
the type to put one.

**Rationale.** The rule survives being forgotten. A projection that wanted to report which profile
holds the oldest review task could not express it, so the reviewer who would have caught that in
code review does not need to be there. The route's test walks a real response and asserts no
profile, user, item or household ID appears anywhere in it.

**Why the queues stay separate.** `reviewer_queue_*` counts publication requests and
`review_tasks_*` counts the household inbox. They are different queues with different owners, and
only the first is staff workload; reporting either as the other makes an SLA meaningless.

**Sources.** `20`; `14`; `16`.

## DEC-060 - The projection reports what is true and reaches no verdict

**Context.** `20` lists the conditions worth alerting on - critical source stale, ingestion failure
spike, review queue SLA breach - and then says "exact thresholds must be documented before
production". None are documented, and `BLK-008` records that no labelled dataset exists to set them
against.

**Decision.** No `status`, `severity`, `healthScore`, `degraded` or `alertLevel` anywhere in the
snapshot or on a source row. Tests assert the absence over the reading keys, the source row keys
and the module's exported names.

**Rationale.** The same reasoning trap 29 applies to a shadow run: a verdict here would invent a
threshold, and an operator would read it as an answer. The numbers are what the system knows; the
thresholds go beside them when somebody with the authority to set them has done so.

**The one comparison that is not a threshold.** A source is overdue when the elapsed time since its
last successful check exceeds `expected_refresh_interval_ms` - the cadence that source itself
declares on its registry row, approved when it was registered. That is arithmetic against an
existing decision, not a new one. `overdueByMs` is reported; "critically stale" is not.

**Never checked is not zero overdue.** They are separate fields, because a source that has never
succeeded is not comfortably inside its window, and folding it in would hide the worst case inside
the best-looking number.

**Sources.** `20`; `22`; `BLK-008`; trap 29.

## DEC-061 - Any active reviewer may read the operational projection

**Context.** `13` asks for least privilege on staff routes, and the obvious reading is that
operational metrics belong to `SOURCE_OPERATIONS_OWNER` alone.

**Decision.** Any ACTIVE row in `reviewer` admits the caller. Everyone else gets the same bare
not-found the console gives.

**Rationale.** `20` calls source freshness a **safety** metric, and a clinical safety lead deciding
whether a published rule should stay published needs to know the source behind it has not been
checked in a fortnight. Narrowing the read by role would keep a safety signal from the people whose
job is to act on one. The usual reason to narrow a staff read does not apply here either: the
snapshot contains no user content at all - counts, ages, and the public identity of regulators.

**What is not relaxed.** The role still comes from a stored row and never from a client claim
(`14`), a suspended reviewer is refused, and the refusal is a 404 so the route is not an oracle for
its own existence.

**Sources.** `13`; `14`; `20`; DEC-032; `DEV-016`.

## DEC-062 - An item nobody has checked is INSUFFICIENT_DATA, never NO_CURRENT_MATCHED_ALERT

**Context.** Phase 7.1 needed the five product states actually derived. `PRODUCT_SAFETY_STATES` had
existed in the vocabulary since Stage 0 and had been presented since the presentation layer was
written; nothing computed it. The Safety screen listed published alerts, so an item with no alert
was simply absent - and a person reading that screen could not tell "checked, nothing matched" from
"never checked".

**Options.** (a) Keep listing alerts. (b) Give every item a line, and call an unassessed item
`NO_CURRENT_MATCHED_ALERT`. (c) Give every item a line, and call an unassessed item
`INSUFFICIENT_DATA`.

**Decision.** (c).

**Rationale.** (a) is `23` D-014 arriving by omission: an absence rendering as approval, with the
absence being the row itself. It is the quietest possible version of the failure, because there is
no wrong label to review. (b) fixes the omission and reintroduces the claim: "no current matched
alert" means a check ran within current coverage and found nothing, which for an unassessed item is
a reassurance nobody earned. `INSUFFICIENT_DATA` claims only that Kynviora cannot check it yet,
which is true - and its shipped description already says exactly that.

**The rest of the derivation is `09` read literally.** "Action required - approved action wording
based on urgency" gives CRITICAL and HIGH; "review - user should confirm item/context or discuss"
gives MEDIUM and LOW; "information - relevant update without immediate action" gives INFORMATIONAL;
"insufficient data - item/context cannot be matched reliably" gives `UNCONFIRMED` and `NOT_MATCHED`.
`STATE_FOR_URGENCY` is a total record, so a new urgency is a decision somebody makes rather than one
a fallthrough makes for them.

**A withdrawn alert falls back rather than persisting.** The assessment behind a withdrawn alert
still says the rule matched, so anything reading assessments alone would keep the item on
ACTION_REQUIRED. `19` treats a withdrawn alert resurfacing as release-blocking; the join filters on
the publication state, and a database test with a real withdrawn row is what proves it.

**Sources.** `04` Phase 7.1; `09`; `19`; `23` D-005 and D-014; DEC-034.

## DEC-063 - The inbox filters narrow and never rank, and carry no count of any state

**Context.** Phase 7.1 names filters by profile, urgency and status. The obvious companion is a
count per state, or "most urgent first".

**Decision.** Filters narrow. There is no sort by urgency, no count per state, and no badge.
`totalItems` is the size of the shelf, so a filtered screen can say what it is a subset of.

**Rationale.** `02` names alarm-optimised design as an anti-feature, and ranking is a judgement
about which of two people's medicines matters more. A count per state is the same product with a
number instead of an order. Tests enumerate the response keys, the view keys and the module's
exported function names, because both are one line to add and hard to notice afterwards.

**A line with no urgency is excluded by an urgency filter rather than included by default.** Asking
for CRITICAL and being shown items with no alert at all would make the filter meaningless.

**The filter values repeat rather than being comma-separated.** `?state=A&state=B`, because a list
parsed out of one string is a mistake away from a filter that silently matches nothing - and on
this screen a silently empty list is the failure the whole route exists to prevent. An unrecognised
value is refused rather than dropped, for the same reason in the other direction.

**Sources.** `04` Phase 7.1; `02`; `23` D-005; `13`.
