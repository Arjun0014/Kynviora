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

## DEC-064 - The Lens opens from an item, and only for a substance confirmed to be in it

**Context.** Phase 7.2's UI needed somewhere to live. `09` says a regulatory status is shown
"beside, not substituted for" the safety state, which rules out a destination of its own and points
at the safety line.

**Decision.** One control per substance on a safety line, and none where the item has none. The
substances offered are only those whose ingredient mapping is `EXACT`.

**Rationale.** The Lens answers about whatever key it is given. An `AMBIGUOUS` mapping means nobody
has confirmed that substance is in the pack, so opening the Lens on it would produce a confident,
sourced, entirely applicable-looking answer about the wrong substance - which is worse than no
answer, because it looks like one. `EXACT` is the only mapping state that says somebody resolved it.

**Absent rather than disabled.** Nothing in the shipped seed has an exact mapping, so no control
appears anywhere today. That is DEC-045's reasoning again: a greyed-out control would say a Lens
answer exists and is being withheld.

**The request carries the context, not just the key.** `09` makes the answer depend on the
disclosed concentration, so asking about a substance without the concentration it was found at
would give a less applicable answer than the item deserves - and `CONDITION_UNKNOWN` exists
precisely to say when that context is missing.

**Sources.** `04` Phase 7.2; `09`; DEC-007; DEC-045; `DEV-024`; `BLK-007`.

## DEC-065 - A Lens card never carries a verdict, and the cards are never ordered by severity

**Context.** Six jurisdiction cards invite two summaries: an overall answer, and an order that puts
the strictest first.

**Decision.** Neither. `lensView` has no verdict field, the card order is the projection's own, and
the module exports no function whose name suggests a comparison. Tests assert all three.

**Rationale.** `09` forbids value judgements such as "strict country" or "weak regulation", and a
list sorted by how prohibitive each answer is expresses exactly that judgement without using the
words. An overall verdict is the same thing collapsed to one line, and would have to decide what
six different legal systems jointly mean - which nobody has the standing to do.

**Statuses stay a list.** `07` forbids collapsing several applicable statuses into one, so a card
renders one presentation per status. A status this build cannot describe is dropped and counted
rather than rendered as a bare code: the presentation layer holds one description per status and no
default, and inventing one would put a legal claim on screen that no reviewer approved.

**An empty card says why it is empty.** `LENS_NO_STATUS` is on any card with no describable status,
because an empty box reads as "fine here" - `23` D-014 drawn rather than written.

**Sources.** `04` Phase 7.2; `07`; `09`; `23` D-014; trap 2.

## DEC-066 - A process serves one surface, and the surface is required

**Context.** `13` requires internal/admin APIs to be "separately authenticated/authorized and not
exposed as user APIs". Separate authorization was already true - a reviewer role is a stored row
and the refusal is a bare 404 - and separate exposure was not: `/v1/reviewer/queue` was registered
on the same Fastify instance that serves `/v1/items`.

**Decision.** `createServer` takes a required `surface` of `HOUSEHOLD` or `STAFF`. A household
process registers no reviewer route; a staff process registers nothing else. There is no `BOTH`.

**Rationale.** The only thing between a phone and the publication tables was a check. It is now
also the absence of a handler, so the 404 arrives before any authorization runs - which a test
proves with a database pool that throws on any query. The option is required rather than defaulted
because a default decides, for every future route, which side of a security boundary it lands on,
and decides it silently. The tests assert over the paths an instance actually registered rather
than over a list of forbidden paths, so a new route on the wrong side fails.

**Two listeners, one process, in development only.** `main.ts` binds a second instance on
`KYNVIORA_STAFF_PORT` when one is set, sharing the process and the database. Two processes are the
deployment shape and cannot be the development shape: PGlite is a single writer (DEC-037), and a
separate staff process pointed at the same data directory overwrites it. The staff listener is off
unless asked for.

**Sources.** `13`; `14`; `DEV-016`; DEC-037.

## DEC-067 - The staff console is its own package, and shares nothing with the household client

**Context.** `@kynviora/contracts` already has a transport, an outcome union and a session type,
and the console needs all three.

**Decision.** `@kynviora/staff-console` implements its own, and depends on `@kynviora/domain` and
nothing else. Neither `@kynviora/contracts` nor `@kynviora/presentation` is a dependency.

**Rationale.** `13` asks for environment isolation between a user surface and a staff one. Reusing
the household transport would need either a `STAFF` member on `ClientSession` - shipping reviewer
session code in the Expo bundle, and making one union the place where two trust boundaries meet -
or a refactor that widens the household client for the staff client's benefit. The presentation
package is excluded for the reason `DEV-016` already gave: its copy rules are about what Kynviora
says to a household, and reviewer-facing strings are not that.

**The duplication buys a stronger rule.** The household transport refuses query parameters whose
names look like credentials. The staff transport refuses query strings **entirely**, because no
staff route takes one - a rule with no exceptions cannot be applied inconsistently later. Every
identifier is checked as a UUID before it becomes a path segment.

**Sources.** `13`; `14`; `DEV-016`.

## DEC-068 - The reviewer queue is never ordered by urgency

**Context.** A publication request carries `maxUrgency` and `evidenceLevel`, and a queue invites an
order.

**Decision.** The console renders the queue in the order the API returned it - oldest first - and
`views.ts` exports no function that compares two requests. A test asserts the module has no export
whose name suggests one.

**Rationale.** On the household side `02` forbids alarm-optimised design. Here the argument is
different and stronger: `maxUrgency` is stated by whoever _opened_ the request. Sorting by it would
let a requester choose how soon their own request is looked at, by claiming an urgency - which is a
governance control defeated from inside the workflow it protects. Oldest-first is also what `20`
measures as queue age, so the screen and the metric describe the same thing.

**The tally is per jurisdiction and never summed.** Migration `0012` requires each requested
jurisdiction to reach the approval count on its own. A single "2 of 4" would read as half-done and
names no quantity that exists; the shortfall is a list of jurisdictions, not a number.

**Sources.** `02`; `04` Phase 6.6; `10`; `20`; migration `0012`.

## DEC-069 - Nothing in the console is preselected, and the checklist is never offered in bulk

**Context.** The decision form has three options and ten checklist items, and every one of them
could have a default.

**Decision.** No decision option is preselected, no checklist item renders ticked, no option
carries a `recommended` or `default` field, and there is no control that ticks the checklist
together. `ChecklistItemView.confirmed` is typed `false` rather than `boolean`.

**Rationale.** `10` makes the second reviewer worth something because they check independently. A
pre-ticked box, a "confirm all" control, or a remembered previous answer each turn ten judgements
into one click, and the record afterwards is indistinguishable from ten real ones. A default of
Approve would collect approvals from people who pressed the button that was already pressed. This
is DEC-030's reasoning on a different surface: the software does not have an opinion, and a
preselected control is an opinion nobody signed.

**Absent, not disabled.** A control this caller may not use is not rendered, and a sentence states
which rule removed it. On a separation-of-duties refusal a greyed-out Approve would be the
requester learning their own request is waiting for somebody (DEC-045, one level up).

**Sources.** `04` Phase 6.6; `10`; DEC-030; DEC-045.

## DEC-070 - Where a fact came from is a type, not a sentence

**Context.** `04` Phase 7.3's second exit criterion is "the UI reveals what is known versus
inferred".

**Decision.** Every value on the alert detail is an `AlertFact` carrying a `FactBasis`, and there
is no constructor that produces one without a basis. The bases are `RECORDED_BY_A_PERSON`,
`READ_FROM_THE_PACK`, `PUBLISHED_BY_A_SOURCE`, `COMPUTED_BY_KYNVIORA`, `NOT_KNOWN` and
`WITHHELD_FROM_THIS_SESSION`.

**Rationale.** A sentence saying "some of this is inferred" is a claim about the screen rather
than a property of it, and it goes stale the first time a field moves. A type means a new field
cannot arrive on the screen unlabelled.

**Six bases rather than two.** "Known" is not one thing: a batch number somebody typed and a batch
number read off the label are both known and are not the same evidence for a recall, which is the
field a recall turns on. `NOT_KNOWN` and `WITHHELD_FROM_THIS_SESSION` are opposite facts - the
first says the data is missing, the second says it exists and this session may not have it - and
collapsing them would make an access decision look like ignorance.

**A missing value is never reported as recorded.** `fact()` forces `NOT_KNOWN` when the value is
absent, whatever basis the caller passed, so an absent batch number cannot be presented as
something a person entered.

**Sources.** `04` Phase 7.3; `18`; DEC-026; DEC-064.

## DEC-071 - An explanation this build cannot write is not written

**Context.** `assessment_rule_version.explanation_template_id` is free text, frozen onto the
assessment at evaluation time. The presentation layer holds three approved templates.

**Decision.** An identifier outside the approved list - or an approved one whose required context
is missing - produces **no narrative at all**. The detail shows the facts, the states, the reasons
and the source, and says plainly that Kynviora will not write an explanation of its own.

**Rationale.** The alternative is a generic sentence, and a generic sentence about somebody's
medicine is content no reviewer approved - which is the thing `10`'s content review exists to
prevent. `23` D-014's rule ("an absence must never render as something else") applied to prose.

**Missing context counts as much as an unknown identifier.** `batchRecallMessage` will happily
produce "null published a notice about specific batches" from an absent authority. A sourceless
claim about a recall is worse than no narrative, so the required fields are checked before the
template is called.

**Sources.** `04` Phase 7.3; `10`; `23` D-014.

## DEC-072 - A caregiver who may see the alert and not the item is shown the alert

**Context.** `03` group H makes safety access and shelf access separate permissions. A caregiver
holding `VIEW_SAFETY` and not `VIEW_MEDICINES` is entitled to an alert about a medicine whose name
they may not have.

**Decision.** The detail route joins `profile` and `owned_item` with `LEFT JOIN`, so row-level
security narrows them to NULL rather than removing the alert. The view marks those facts
`WITHHELD_FROM_THIS_SESSION`, renders no narrative (every approved template names both the person
and the item in its first two sentences), and states which half is being withheld.

**Rationale.** An inner join would answer 404 - an alert this person is entitled to read, reported
as though it did not exist. A blank would read as Kynviora not knowing. DEC-026 had already
settled the shape for the caregiver alert view: the withholding is reported rather than shown as a
blank.

**It is not the "cannot explain" state.** Kynviora can explain this alert perfectly well and is
not showing all of it to this session. Rendering `UNEXPLAINABLE` would blame the build for an
access decision.

**The other direction really is absence.** Without `VIEW_SAFETY` the alert row itself is invisible,
so there is nothing to withhold half of, and the answer is the same 404 a stranger gets.

**Sources.** `03` group H; `04` Phase 7.3; DEC-026; DEC-039.

## DEC-073 - A source reference is withheld until its licence review is done

**Context.** `04` Phase 7.3 asks for a "source link/retained reference **where allowed**".

**Decision.** The legal reference and the required attribution are shown only where
`source_registry_entry.license_review_state` is `APPROVED`. Otherwise the detail says the reference
is withheld pending licence review and names `BLK-005`. The publisher, the jurisdiction and the
publication date are not restricted and stay.

**Rationale.** `25` makes redistribution a per-source legal question, `license_review_state`
defaults to `NOT_REVIEWED`, and `BLK-005` records that no review has been performed for any source.
A silent gap would read as "there is no source", which is the one direction this line must not fail
in - a person taking an alert to a pharmacist needs to know a regulator is behind it even when the
citation cannot be reproduced.

**Attribution travels with the reference.** Attribution names the licence, so showing it while
withholding what it licenses would disclose the thing the review is about.

**Sources.** `04` Phase 7.3; `25`; `BLK-005`.

## DEC-074 - A change is attributed from what was recorded, never from what it looks like

**Context.** `04` Phase 7.4's exit criterion is that users can distinguish a new regulator action
from a Kynviora correction.

**Decision.** `attributeChange` reads two recorded facts - whether an `assessment_correction` row
exists and what kind it names, and whether the new regulatory version supersedes an earlier one -
and returns one of `REGULATOR_ACTED`, `SOURCE_CORRECTED_ITSELF`, `KYNVIORA_CORRECTED_ITSELF` or
`NOT_STATED`. It inspects neither version's contents.

**Rationale.** The two cases the criterion separates produce identical evidence. A regulator
tightening a concentration limit and Kynviora discovering it had mis-extracted the old limit both
look like a new version superseding the old with a different `maxConcentrationPercent`. Any
heuristic over the version pair is wrong in exactly the cases that matter - "the effective date
moved, so the regulator acted" fails the moment a correction carries a new date - and a wrong
answer here tells somebody the law changed when in fact the software was wrong about their
medicine. DEC-030's shape on a different subject: which of two readings stands is stated, not
derived.

**Four members, not two.** A source correcting its own publication is neither of the two `04`
names, and a reader deciding how much to trust what they were told before needs it apart from
both. `NOT_STATED` is a member rather than a fallback: defaulting an unattributed change to a
regulator action would hand Kynviora's mistakes to the regulator, and defaulting it to a
correction would claim a mistake nobody found.

**An unrecognised correction kind attributes to Kynviora.** The criterion exists so a reader can
tell when the software was wrong; a value this build does not recognise becoming "the law changed"
is the one direction it must not fail in.

**The diff reaches no verdict.** No "stricter", "relaxed" or severity delta anywhere. `09` forbids
value judgements between jurisdictions, and between two versions of one rule the same holds:
whether a narrowed limit matters depends on what the reader is doing with the substance. Statuses
added and removed are two lists rather than one replacement, because "RESTRICTED became
PROHIBITED" is a sentence about severity that nobody wrote.

**Whether the action changed is a separate question, separately answered.** It is read from the
two assessments' frozen urgency and template rather than derived from the rule diff, because a
regulator can narrow a limit without altering what a household should do about a pack they already
own.

**Sources.** `04` Phase 7.4; `07`; `09`; DEC-007; DEC-030; DEC-065.

---

## DEC-075 - The receipt is one row, and the sequence lives in the audit log

**Date:** 2026-09-02
**Phase:** 7.6
**Status:** Accepted

`04` Phase 7.6 asks for a "versioned Safety Receipt". The first implementation read that as an
append-only stack of resolutions and was written that way; migration `0006` disagrees. It puts a
UNIQUE index on `safety_receipt (alert_publication_id)` and grants the app role SELECT and UPDATE
and no INSERT. Two designs met on a constraint that had been in the schema since Stage 2, and the
schema won.

**One receipt per alert, holding what currently stands.** A person who marked an alert reviewed and
has since set the pack aside has one current answer, not two competing ones. The row is updated in
place and a later resolution replaces the one before it.

**The sequence is not lost, and is not off the screen.** Every write emits an `audit_event`, which
`14` requires and which no role may update or delete - a trigger refuses it to the service role and
to the owner role alike, and a test asserts that. The receipt read replays those rows into
`history`, so "versioned" is answered by the log rather than by the table: what stands is one row,
what happened is a chain nobody can rewrite, and both are on the receipt.

**This is a better answer than the stack would have been, not a worse one accepted under duress.**
An append-only receipt table is editable by whoever holds UPDATE on it; the audit log is editable
by nobody. The history a household reads is now the same history a regulator would be shown.

**What it costs.** The row itself carries no chain, so a reader of `safety_receipt` alone sees only
the current answer. `DEV-029` records that and what closing it would take.

**One writer follows from it.** Two routes record a resolution - Phase 7.3's report-incorrect and
7.6's resolutions route - and both now go through `recordSafetyResolution`. Two independent INSERT
statements against a table that admits one row is a 500 the first time a household uses both
screens, and it was a real defect in the committed 7.3 code rather than a hypothetical one.

**Sources.** `04` Phase 7.6; `14`; migration `0006`; DEC-013; `DEV-029`.

---

## DEC-076 - A receipt says what was done, never who did it

**Date:** 2026-09-02
**Phase:** 7.6
**Status:** Accepted

The receipt's history is replayed from `audit_event`, whose rows carry `actor_user_id`. It would
have cost nothing to render it, and the screen deliberately does not.

**Identity has a screen already.** `03` group H puts audit visibility on the caregiver-audit
surface, where an owner is looking at who holds access to a profile and what they did with it. A
Safety Receipt is a record about an alert, and a household member reading one is asking what was
decided about a pack of medicine.

**"Your daughter marked this reviewed" is a different disclosure.** A caregiver holding
`VIEW_SAFETY` can currently read a receipt. Naming the actor on it would let every such caregiver
see which household member responded to which alert and when, on a surface nobody added that
permission for. The `ReceiptHistoryEntry` type has no actor field, so it cannot be leaked by a
later change to a query, and a test asserts no user identifier appears in the response.

**The fact is not lost.** `safety_receipt.resolved_by_user_id` and the audit row both hold it, and
a reviewer or an operator with the right access can read either. It is not on this screen.

**Sources.** `03` group H; `14`; DEC-026; DEC-072.

---

## DEC-077 - There is a channel below the digest, and INFORMATIONAL uses it

**Date:** 2026-09-02
**Phase:** 7.5
**Status:** Accepted

`04` Phase 7.5 asks for an "urgency-based delivery policy" and a "digest policy for lower
urgency", which reads as two channels: a notification now, or a notification later. There are
three, and the third is the one the phase's first exit criterion turns on.

**`IN_APP_ONLY` means nothing reaches a device at all.** No push, no digest line, nothing until
somebody opens Kynviora of their own accord. `MAX_CHANNEL_FOR_URGENCY` maps `INFORMATIONAL` to it.

**That single row is exit criterion 1.** "A new foreign restriction does not automatically produce
a red/high-severity personal alert." A foreign regulatory difference defaults to `INFORMATIONAL`
(`09`, and `FOREIGN_REGULATORY_DEFAULT_URGENCY` has said so since Stage 1), so it now produces
silence rather than a quieter alarm. Two channels would have made the criterion "a foreign
restriction produces a _digest line_", which is a smaller version of the thing it forbids.

**No setting raises it.** The criterion says "does not automatically", and a default somebody can
flip is a default. `min_urgency_for_device` exists on the policy row and can only quieten.

**The escape is a reviewed rule and nothing else.** `09` permits a stronger action where "a
separate reviewed rule establishes" one for the user's context. `regulatoryDifferenceUrgency`
takes that as an input and reports `raisedByReviewedRule` on the result, so a caller cannot
mistake a reviewed decision for a computed one.

**A profile with no recorded market has nothing local.** Everything is foreign until somebody says
where care happens. The failure that avoids is telling a person their own regulator has acted when
a different one has, which is worse than under-stating a real local change.

**Sources.** `04` Phase 7.5; `09`; `02`; `07`; `24`.

---

## DEC-078 - Quiet hours hold, and exactly one urgency pierces them

**Date:** 2026-09-02
**Phase:** 7.5
**Status:** Accepted

Two decisions inside one feature, and both could reasonably have gone the other way.

**Held, not downgraded.** A `HIGH` alert inside quiet hours stays `HIGH` and stays an interrupt;
it arrives when the window ends. Turning it into a digest item would report a lower urgency than a
reviewer approved, and `23` D-005 forbids evaluation adjusting what a reviewer set. The channel is
the loudest thing Kynviora controls and it gets the same discipline.

**`CRITICAL` pierces and `HIGH` does not.** A recall on a medicine somebody is taking tonight is
the case quiet hours must not swallow. A pack expiring in three weeks is not, and a phone lighting
up at 3am about it is exactly the alarm optimisation `02` names as an anti-feature. The two
vocabularies - which urgencies interrupt, and which interrupt _through_ quiet hours - are
deliberately different lengths, and that difference is the whole content of
`URGENCIES_PIERCING_QUIET_HOURS`.

**The copy says the exception out loud.** A person who believed quiet hours silenced everything
would be relying on Kynviora for something it will not do, and the settings screen is where that
is corrected before they rely on it rather than after.

**Not knowing the time sends rather than holds.** No device reports a timezone yet (`DEV-030`), so
`localMinuteOfDay` is `null` and nothing is held. The alternative failure - a `CRITICAL` recall
waiting for a window that never ends because nobody could tell it the window had closed - is
strictly worse than a notification arriving at an inconvenient hour.

**Sources.** `04` Phase 7.5; `02`; `23` D-005; `DEV-030`.

---

## DEC-079 - A manual entry's idempotency key is scoped to the profile, not global

**Date:** 2026-09-02
**Phase:** 2.2 / 2.3
**Status:** Accepted

`13` requires an idempotency key on a mutation that can be retried, and until the screen existed
`POST /v1/items` had none - every caller was a test that submits once. A person on a train tapping
Save, seeing nothing and tapping again is the retry, and without a key that is a second medicine
record on the shelf `04` Phase 8.5 later reconciles against a list somebody was handed, where two
identical rows read as two medicines they are taking.

The precedent was `dose_event.client_operation_id`, which migration `0004` made **globally**
unique. Migration `0016` deliberately does not copy it. Under a global key, a value another
household already used makes this INSERT conflict; the replay read then runs under row-level
security, finds nothing, and the route answers a success carrying no ID - so the second household's
item is silently dropped. Scoping the uniqueness to `(profile_id, client_operation_id)` makes that
unreachable: a collision can only happen inside a scope the caller can actually read back, which is
the only scope where a replay is a real replay. A test writes the same key on two profiles and
asserts both rows exist.

**The index is inferred explicitly.** `ON CONFLICT (profile_id, client_operation_id) WHERE
client_operation_id IS NOT NULL DO NOTHING`, not a bare `ON CONFLICT DO NOTHING` - which would also
swallow a violation of some future constraint and report it as a successful retry of something that
never happened.

**A replay describes the stored row, not the body that arrived.** The route re-reads the four
columns the limits are derived from rather than echoing the submission. A retry carrying a changed
field would otherwise be told what its own body implies, when what exists is the first version -
and on a screen whose entire subject is what Kynviora does and does not hold about a pack,
describing a record nobody has is the failure the route exists to prevent.

**A refusal does not consume the key.** A body the domain rejected wrote nothing, so the corrected
submission reuses the key the screen already generated. The alternative - a new key after every
validation error - would mean the one path where a person retries most often is the one path with
no protection.

**Sources.** `13`; `04` Phases 2.2, 2.3 and 8.5; migrations `0004` and `0016`; `DEV-031`.

---

## DEC-080 - A refusal's field name reaches the client; an authorization refusal still says nothing

**Date:** 2026-09-02
**Phase:** 2.2 / 2.3
**Status:** Accepted

`normalizeManualEntry` names the field it refused - that is why it returns `detail.field` rather
than only a sentence - and `errors.ts` passes `detail` through for client-correctable classes. The
client dropped it: `WireError.detail` was declared and never parsed, so `ApiOutcome`'s `REFUSED`
carried a message and nothing structured. A form with eleven fields that can only say "that is not
a kind of product Kynviora knows" is one where the person has to find the field themselves.

`parseWireError` now reads it and `classifyError` carries it onto `REFUSED` only. Three properties
hold and are tested:

- **Scalars only.** Each entry is narrowed value by value; a nested object or an array is dropped.
  Trap 101 on the error path - a shape this build did not expect would render as `[object Object]`
  beside somebody's medicine.
- **Absent rather than empty** where the server sent none, so "the server said nothing" and "the
  server said this is about no particular field" stay different facts.
- **Nowhere to put one on an authorization outcome.** `UNAVAILABLE` has no `detail` field, so a
  server that started sending one on a 404 could not leak it through this client. `errors.ts`
  suppresses it on that side; the union's shape is the same rule stated again where a future change
  would have to notice it.

The screen branches on `detail.field`, never on the message text (`13`).

**Sources.** `13`; `12`; `14`; `errors.ts`; trap 101.

---

## DEC-081 - The manual-entry form owns the field list, and the item detail must show all of it

**Date:** 2026-09-02
**Phase:** 2.2 / 2.3
**Status:** Accepted

Which fields a category has is decided in exactly one place - `manualEntryForm` in
`@kynviora/presentation` - and two consumers are held to it by tests rather than by care.

**The request builder reads the form.** `manualEntryDraft` in `@kynviora/contracts` copies only the
fields the form for that category offers, so a value left behind when somebody changed their mind
about what they were adding cannot be submitted and refused with a message about a field no longer
on their screen. A `satisfies Record<ManualEntryField, true>` map checks both directions at compile
time: a field name the body cannot carry fails, and a field the body carries that no form asks for
fails too - the second being `DEV-026`'s failure in miniature, a value only a test could ever set.

**The item detail shows everything the form collects.** This is the rule the phase actually turned
on. Phase 2.1's detail was written before migration `0015` added `manufacturer`, `recorded_gtin`,
`recorded_lot_code`, `ingredient_declaration_raw` and `label_version_note`, so the form collected
five fields that no screen ever showed back. A person could transcribe a whole back-of-bottle
declaration into nothing - which is Phase 2.3's "not reduced to name + barcode" failing on the read
path instead of on the write path, and it is invisible from either side alone. An end-to-end test
through the shipped client found it; four layers of unit tests had not.

**A recorded barcode is labelled as one.** "Barcode as recorded here", not "Barcode". These columns
are the household's own transcription and they corroborate nothing (`15` A11, `08`); a bare label
sitting above three unconfirmed verification chips would read as evidence that Kynviora had matched
something. The label is what prevents that, because the value cannot.

**The ingredient declaration is quoted.** Same treatment as a written direction: it is the
manufacturer's words off the pack, kept exactly as printed and never normalized (`05.1`).

**Sources.** `04` Phases 2.1, 2.2 and 2.3; `05.1`; `08`; `15` A11; `DEV-026`; migration `0015`.

---

## DEC-082 - An edit is conditional on the version, and needs no idempotency key

**Date:** 2026-09-02
**Phase:** Stage 2 (update, archive, review)
**Status:** Accepted

`13` sets `owned_item`'s conflict policy to `ASK_USER` - `sync.ts` has held that value since Stage
1 - and `owned_item.version` has existed since migration `0004` with nothing reading it. This is
the route that makes both real. `expectedVersion` is required on the body, the write is
`WHERE id = $1 AND version = $2`, and `version = version + 1` is in the same statement, because a
condition and an increment in two statements is the race the whole mechanism exists to close.

**No idempotency key, and that is not an omission.** A conditional write is already exactly-once
for the intent it describes: a retry either lands or comes back as a conflict. Adding a key beside
it would be a second answer to the same question, and the two would eventually disagree.
`POST /v1/items` needs one because creation has no prior state to condition on; this does.

**Zero rows is three different facts.** `owned_item_update`'s USING clause filters rather than
raising, so a caregiver who may read an item and not change it produces the same empty result as a
version that has moved and as an item that is gone. The route re-reads to tell them apart. Getting
this wrong in either direction is worse than a generic failure: a refusal reported as a conflict
sends somebody round a retry loop they can never win, and a conflict reported as absence tells them
their own medicine record has disappeared.

**The refusal is still a 404.** There is no outcome in this API meaning "you are not allowed"
(trap 89), and this route does not become the exception. What prevents a person meeting it is
`mayEdit` on the item detail: computed on the server with the _same predicate_ the update policy
uses - `kynviora.has_capability(profile_id, CASE WHEN item_kind = 'MEDICINE' THEN
'MANAGE_MEDICINES' ELSE 'MANAGE_SHELF' END)` - so the screen and the policy cannot disagree. The
control is absent rather than disabled (DEC-045).

**The conflict says three things.** That nothing was saved, that somebody else changed it, and that
the person is now looking at the new version. A message with only the first would leave them
retyping over a change they never saw. It does not say _who_ changed it: the same rule the Safety
Receipt keeps (DEC-076), because a caregiver's identity belongs on the caregiver-audit screen.

**Sources.** `13`; `12`; `04` Stage 2 stage output; `sync.ts`; migration `0004`; DEC-045; DEC-076.

---

## DEC-083 - What an edit may not do, and the prefill that lets a form do the rest

**Date:** 2026-09-02
**Phase:** Stage 2 (update, archive, review)
**Status:** Accepted

**An update is validated as the record it would produce.** The patch is merged over the stored
values and the whole thing goes through `normalizeManualEntry`. There is deliberately no second
set of rules: a field that could not be entered on the form must not become enterable by editing,
and two validators that agree today are two validators that disagree later. It is why giving a
medicine a personal-care category is refused by the same message on both paths.

**Absent and `null` are different answers.** Absent leaves a field alone; `null` clears it, and
clearing stores an absence rather than an empty string. Collapsing them would mean either that
nothing can ever be un-entered - so a value typed by mistake is permanent - or that every save
wipes every field the screen did not happen to send.

**Nothing here can claim something was checked.** `ItemUpdate` has no field for a verification
state, a catalog identifier, a match confidence or an `itemKind`, and the body schema is
`.strict()`, so an attempt is a refusal rather than a key that is quietly ignored. Editing a
record is not evidence about a pack (`08`); `itemKind` is absent for a second reason, that a
medicine which became a shampoo would take its strength and its written directions with it.

**And no timestamp asserting somebody did something.** `markReviewed` is a boolean and the server
stamps `now()`. A client-supplied `lastReviewedAt` would let a screen claim a person reviewed a
medicine at a moment they did not - on the exact value the Shelf's "not yet looked at" filter
reads. The copy on the control also says it confirms nothing about the product, because a person
who believed otherwise would have a Trust Passport that means less than they think.

**`editableValues` is a second representation, and that is deliberate.** `categoryFields` and
`sharedFields` are presentation - labels, absent notes, and which text is somebody else's words -
and an editor can use none of it. A form built from rendered labels would have to match on the
label text, which is the "branch on message text" `13` forbids one layer down; and the category
renders as "Hair care" where the field holds `HAIR_CARE`, so such a form would send a value the
domain refuses, naming a field the person never edited. Two representations for two purposes.

The agreement between them is a test, not care: every field `manualEntryForm` offers has an entry
in `editableValues`, and the whole prefill sent back unchanged must be refused as "nothing to
change". The failure that catches is silent - a field with no entry opens blank, the person saves,
and a value they never touched is cleared, with the write succeeding and the column legitimately
nullable.

**Sources.** `04` Phases 2.1, 2.2, 2.3; `08`; `13`; `14`; `manualEntry.ts`.

---

## DEC-084 - Every lifecycle state says what Kynviora stops doing

**Date:** 2026-09-02
**Phase:** Stage 2 (update, archive, review)
**Status:** Accepted

`04` Phase 2.1 lists the lifecycle as expected output and migration `0004` has carried the column
since; nothing had ever changed it. The states are the schema's three - deletion is not a fourth
here, because it is a retention decision with its own rules (`DEV-032`).

**Each one is described by its consequence, not only by what it records.** A person choosing
"I have stopped using this" is choosing something they cannot see: the Shelf stops asking about it
(`shelfAttention` returns nothing for a non-`ACTIVE` item), the Review Inbox stops raising it, and
a reconciliation stops counting it. **Archiving stops the safety watch as well** - the safety inbox
filters on `lifecycle_state <> 'ARCHIVED'` - and somebody who archived a medicine believing
Kynviora would still tell them about a recall would be relying on it for something it had stopped
doing. That sentence is on the screen, above the control rather than under it (`10`).

The wording is checked against the code rather than written beside it, and a test loops the whole
vocabulary: a state added later fails rather than shipping with a blank line where its consequence
should be. That is trap 109's lesson, applied before it could happen again.

**Nothing is one-way.** Every state out of use offers a way back. A person who archived something
by mistake and could not undo it would have lost a record Kynviora is meant to be keeping.

**The stopped date is not invented and is cleared on return.** Stopping without a date is allowed,
because "missing fields remain explicitly unknown rather than receiving defaults" applies to
somebody who stopped a medicine months ago and does not remember when. And moving back to `ACTIVE`
clears it: the column holds the current fact, not a history, and "Stopped 1 June" on a medicine
somebody is taking is a false statement on the screen a household reads most. The history is in
`audit_event`, which is append-only by trigger and refused to every role.

**A date before the started date is refused by the domain, not only by the engine.**
`owned_item_dates_ordered` has always said so, and without a domain rule the refusal arrived as a
500 rather than as a sentence naming the field. An API test found it; nothing in the domain had
covered it.

**The labels are what the person did.** "I have stopped using this", not "Mark as discontinued".
`09` forbids Kynviora saying anything about whether to take a medicine, and a test asserts no
sentence in the vocabulary reads as advice.

**Sources.** `04` Phase 2.1; `02`; `09`; `10`; `shelfAttention.ts`; `safetyInbox.ts`; migrations
`0004` and `0001`; trap 109.

---

## DEC-085 - A typed time is refused rather than repaired, and the whole policy is written every time

**Date:** 2026-09-02
**Phase:** 7.5 (the client half)

**Status:** Accepted

Phase 7.5 shipped quiet hours as minutes from local midnight, stored, applied by
`deliveryDecision` and readable through the settings route. Nothing let anybody set one. This is
the half that does, and both halves of the decision are about not guessing.

**A 24-hour clock, typed, and no am/pm control.** `07:00` is never seven in the evening. A
locale-aware picker plus a meridiem toggle is a second thing to get wrong, on a screen whose whole
subject is whether a phone lights up at three in the morning. `18` asks for familiar words first,
and a 24-hour time is the one format that means the same thing to everybody who reads it.

**`9:5` is not read as `09:05`, and `24:00` is not read as midnight.** `parseClockMinute` refuses
both, and names the field it refused so the form can point at it. A window Kynviora quietly
reinterpreted is one a person cannot check against what they meant - the same rule the manual-entry
form keeps for a barcode, applied where the consequence is being woken up rather than a wrong
match.

**Both bounds or neither.** One alone is a window whose other end somebody has to invent. The
domain refuses it, the route's schema refuses it, and `notification_quiet_hours_paired` refuses it
in the database, so no layer is the only thing standing between a half-window and storage. Two
identical bounds are refused for the reason `isValidQuietHours` already refused them: a zero-length
window and a whole-day one are the same two numbers, and a rule whose meaning depends on the reader
has no place deciding whether somebody is woken up.

**Clearing is emptying both fields, not a separate switch.** There is one representation of "no
quiet hours" - two nulls - and one path that produces it. A separate off state is a second thing
that can disagree with the first.

**The whole policy goes on every write.** `setNotificationPolicy` takes the owner's ceiling **and**
the window together, because the route writes one row: a body carrying only the changed half would
leave the other at whatever the caller last sent, which for quiet hours means a request that never
mentioned the window silently clearing one somebody set. The screen re-sends the ceiling unchanged
for exactly that reason. The client method changed shape from a bare `maxCaregiverDetail` string to
a body, which cost nothing because it had no callers at all.

**Step-up, and the prompt is on the screen.** `14` puts a change to what leaves the profile behind
re-authentication, and changing when Kynviora may interrupt somebody is the same class of change.
The screen says so before the control rather than leaving a 403 to explain itself.

**Sources.** `04` Phase 7.5; `13`; `14`; `18`; migration `0014`'s
`notification_quiet_hours_paired`; DEC-078; `DEV-030`.

---

## DEC-086 - The screen says quiet hours do not hold yet, before somebody sets one

**Date:** 2026-09-02
**Phase:** 7.5 (the client half)

**Status:** Accepted

`DEV-030` records that no caller supplies `localMinuteOfDay`, so a stored window holds nothing, and
`BLK-009` records that nothing dispatches a notification at all. Building the screen that sets a
window without saying either would be the `10` failure this codebase spends the most care avoiding:
a person deciding to rely on Kynviora for something it does not do.

**The server reports it; the screen does not assume it.** `QUIET_HOURS_APPLIED` is a constant on
the API beside the dispatcher, `false`, with both reasons written next to it, and the settings
response carries it. A screen that hard-coded the same `false` would be a second place to remember
on the day it becomes true. An API test checks the constant against the behaviour rather than
trusting it - with no local minute, a `HIGH` alert inside the window is not held.

**Said whether or not a window is set.** The first version showed the sentence only where a window
already existed, which is exactly backwards: the person who most needs it is the one about to set
their first, and telling them afterwards is telling them too late. `notificationPolicyView` returns
the sentence itself, so the rule is tested once in `@kynviora/contracts` rather than once per
surface that renders it, and a missing copy key falls back to the packaged wording rather than to
silence - silence here is indistinguishable from "it works", which is the one reading that is
false.

**The confirmation says what was recorded, not what will follow.** "Saved. Kynviora will hold
notifications during that window" is a promise this build does not keep, made at the moment
somebody has just decided to rely on it. It now reads "Saved. Kynviora has recorded these hours."
A test asserts the confirmation never claims holding, so the sentence cannot drift back.

**A window this build cannot read is a third state, not "none".** If the stored numbers do not
narrow - equal bounds, out of range, not numbers - the view reports `quietHoursUnreadable` rather
than `null`, the label the server composed still shows, and the editor is absent. An editor
prefilled with nothing would clear a real window the moment somebody pressed save. Deny by default
(`14`) applied to a control, with the reason on the screen.

**A caregiver reads the window and changes nothing.** `16`: somebody receiving nothing at 3am
deserves to know a window is doing that rather than a bug. The control is absent, not disabled, and
a sentence says whose decision it is.

**The urgency table is a statement, not a control.** Nothing about which urgency reaches a device
is settable, and the copy says so rather than leaving somebody hunting for the switch. `02` is why
there is no switch: a person who could raise every urgency to an interrupt would have rebuilt the
alarm optimisation the product refuses, one row at a time. The rows are read from the domain's own
ceiling on the server, so a client cannot describe a policy the server does not have, and an
urgency the client cannot read is dropped rather than rendered as its code (trap 129).

**Sources.** `04` Phase 7.5; `02`; `10`; `14`; `16`; DEC-078; `DEV-030`; `BLK-009`; trap 129.

---

## DEC-087 - A profile a person no longer has access to becomes no selection, never a different one

**Date:** 2026-09-02
**Phase:** 1.2

**Status:** Accepted

`04` Phase 1.2's second exit criterion is "screens cannot accidentally display one profile's data
under another profile identity". It is a property of what is on a screen, and there is exactly one
place it can be decided.

**A selection the server does not offer is dropped, and said.** `profileSwitcherView` honours the
requested profile only if the server's list still contains it. Nothing falls back to the first one.
A caregiver grant can be revoked between launches, and a fallback is precisely how a screen ends up
showing one person's medicines under another person's name with the heading unchanged - the failure
is silent, which is what makes it the one worth building the type around.

**The decision lives in `@kynviora/contracts`, not in a screen.** `apps/**` is outside the test run
(`BLK-002`), so a screen that did `profiles.find(...)` for itself would hold an untested
authorization-shaped decision in the one place nothing scans. The view answers four separate
questions - which profile is selected, whether a selection was dropped, whether the list is empty at
all, and which household to add somebody to - and each of them is a different sentence on the
screen.

**"Empty" and "your selection is gone" are different states.** The first is somebody who has not set
up yet and needs the creation screen; the second is somebody whose access changed and needs telling.
One screen for both would invite a person to create a second profile for somebody who already has
one.

**"Persistent identity context" persists for the session and is re-derived on launch.** Phase 1.2
asks for a persistent one and the `ProfileProvider` has never stored the selection on the device.
That is kept: a stored "last used profile" that outlived a revoked grant is exactly the code path
`13` forbids, and a client cannot know a grant has gone without asking. Persistence here means the
selection survives navigation, not that it survives an authorization change nobody re-checked.

**The name is on the screen whether or not the switcher is open.** A switcher that only labelled
things while it was open would leave every other screen unlabelled, which is the criterion's own
failure with an extra step.

**Sources.** `04` Phase 1.2; `13`; `16`; `BLK-002`; `ProfileProvider.tsx`.

---

## DEC-088 - Who a profile is for is the caller's claim about themselves, and nothing else

**Date:** 2026-09-02
**Phase:** 1.2

**Status:** Accepted

`04` Phase 1.2 asks for "a clear distinction between account holder and managed profile". The schema
has drawn it since migration `0002` with two columns, and until now nothing wrote either.

**`owner_user_id` is who controls it; `self_user_id` is who it is about.** An older adult using
Kynviora directly has both set to themselves. A relative's profile has an owner and no
`self_user_id` until they claim it - null rather than the owner, because "this is my mother's
profile" and "this is mine" are different facts and the second must not be produced by the first.
Conflating the two is the mistake `isOwner` was added to `GET /v1/profiles` to remove.

**There is no field that can name anybody else.** The route's body has no `selfUserId` and no
`ownerUserId`, `.strict()` refuses both, and there is no query parameter they could reach if it did
not. A profile asserting that another user is its subject would be an authorization statement
written by the wrong person - and `self_user_id` is unique, so it would also take a name that person
could never claim. The absence is the enforcement, and a test asserts the built body's key set.

**`isSelf` is `false` unless the exact boolean arrived.** Deny by default (`14`) applied to a claim
about identity. A truthy `'true'` over the wire does not become one.

**The screen never says "managed".** It asks "This is me" or "Someone I look after", and says the
second can be taken over later. A person setting up a profile for their mother is not administering
a managed entity, and the word would make them wonder what else Kynviora thinks about her. A copy
test asserts no sentence in the module contains it.

**Sources.** `04` Phase 1.2; `13`; `14`; `16`; `18`; migration `0002`; DEC-052.

---

## DEC-089 - The age band is the narrowest thing that answers the question, and every field says why

**Date:** 2026-09-02
**Phase:** 1.2

**Status:** Accepted

`04` Phase 1.2 lists "date of birth/age range" as expected output, and `16` asks for the narrowest
thing that answers the question. The MVP safety rules draw paediatric, adolescent, adult and
older-adult distinctions, so a band answers it and a date of birth is a stronger identifier than the
product needs.

**A band, and separately an optional year.** `AGE_BANDS` is the domain vocabulary and it is exactly
migration `0002`'s CHECK constraint - a test transcribes the constraint and asserts they agree, and
an API test posts every band, because a band the form offers and the database refuses is a 500 in
front of somebody setting up their family. A birth **year** stays available for the rules that want
one. Neither is required: a person setting up a profile for a relative may know a name and nothing
else, and that is a complete record.

**Every optional field says why it is being asked for and what leaving it out costs.** "Optional"
with no consequence stated reads as "required, but we will let you off". The age help says Kynviora
uses it to notice when a medicine says something different for someone that age, and then says
leaving it out changes nothing else. "Rather not say" is a control, not the absence of one, and it
stays reachable after somebody has already picked a band.

**A band that disagrees with the year is a question, not a refusal.** `bandMatchesBirthYear` exists
and is deliberately not part of `normalizeProfileDraft`. Somebody who knows their mother was born in
1958 and taps the wrong band has made a correctable mistake, and refusing the submission would throw
away everything else they typed. The screen shows a note saying both will be saved as entered; the
domain function takes the current year as a parameter rather than reading the clock, for DEC-024's
reason.

**A year is refused, not repaired.** `58` is not read as `1958`, the same rule DEC-085 applies to a
clock time, and the field states the format before somebody types.

**The default language lives in the domain and matches the column default.** One value, and an API
test reads `information_schema` and asserts they agree - the app rendering one language while the
database recorded another for the same profile is the kind of drift nobody notices until a screen is
in the wrong script.

**Sources.** `04` Phase 1.2; `16`; `18`; `09`; migration `0002`; DEC-024; DEC-085.

---

## DEC-090 - Creating a household and creating a person are two writes, and each commits once

**Date:** 2026-09-02
**Phase:** 1.2

**Status:** Accepted

**Both routes require an idempotency key.** `13` asks for one on a mutation that can be retried, and
this is the retry: a person on a train taps "Create", sees nothing, and taps again. Two households
are not a duplicate row on a list. Every later record hangs off a profile, so two households collect
their own items, caregivers and safety history, nothing in this build merges them, and there is no
delete control to undo it (`DEV-032`). Required rather than optional, for the reason the item route
requires it - a caller that may omit it is a caller that will.

**Each key is scoped, not global.** DEC-079's reasoning twice over: `household` on
`(owner_user_id, client_operation_id)` and `profile` on `(household_id, client_operation_id)`. Under
a global index a key another user already used makes the insert conflict, the replay read then runs
under row-level security and finds nothing, and the caller is answered with a success carrying no
row. Each scope above is one the caller is guaranteed to be able to read back, and a test drives two
users through the same key. `dose_event` stays globally unique (`DEV-031`).

**A replay answers with the row that exists, not with the body that was re-sent.** A retry carrying
a changed name would otherwise be told what its second body implies while the first one is what is
stored.

**Two steps on the screen, because they are two writes.** One form would mean either holding a
half-finished household while somebody fills in a name, or writing both on one press with no honest
answer when the second fails. The household step is skipped entirely where the caller already has
one: `GET /v1/profiles` now carries `householdId`, so "add someone" adds them beside the person
already there. That field discloses nothing - an opaque ID on a row RLS already admitted, and a
caregiver who posted it back would be refused by `profile_insert` because they do not own the
household.

**Ownership is never read from a body.** `household_insert` requires `owner_user_id` to be the
caller and `profile_insert` requires both that the caller owns the profile and that they own the
household it goes in. A household belonging to somebody else is refused by the database and answered
as absence, so the route is not an oracle for whether it exists.

**Sources.** `04` Phase 1.2; `13`; migration `0017`; migration `0002`'s `household_insert` and
`profile_insert`; DEC-079; `DEV-031`; `DEV-032`.

---

## DEC-091 - Provenance is derived from who is writing, and there is no field to send it

**Date:** 2026-09-02
**Phase:** 1.3

**Status:** Accepted

`04` Phase 1.3's first exit criterion is "no OCR or inferred fact silently becomes a confirmed
diagnosis". It is a sentence about what cannot happen, and the way to make it true is to leave the
field out rather than to validate it.

**No body carries a provenance, and neither does the domain draft.** `HealthFactDraft` has `kind`,
`displayTerm`, `certainty` and `notedOn` and nothing else; the route's schema is `.strict()`, so a
request naming one is refused as a malformed body rather than silently ignored; and there is no
parameter the value could reach if the schema let it through. What reaches the column comes from
`provenanceForRelationship`, a function with **two** possible answers.

**Two of the four the column allows.** `USER_REPORTED` when the caller owns the profile,
`CAREGIVER_ENTERED` otherwise. `IMPORTED` needs an import path that does not exist and
`REVIEWER_CONFIRMED` needs a reviewer, which `BLK-006` records there is none of. A test enumerates
every reachable output and asserts the set is exactly those two, and another asserts the list is a
strict subset of the column's - so widening the schema later does not silently widen what a client
can assert.

**An unrecognised relationship gets the weaker answer.** Deny by default (`14`).
`CAREGIVER_ENTERED` claims less about how directly the fact was observed, and a caller this build
cannot classify must not be treated as the person themselves.

**Editing cannot change it either.** `HealthFactChange` has no provenance field for the same
reason: a person who could correct a fact into `REVIEWER_CONFIRMED` would have found the way round
the criterion the create path closes.

**This is what makes the second criterion mean anything.** "Rules can explicitly require a
provenance level before using a fact" was already met - `requiredProfileProvenance` has been in the
rule engine since Stage 6 - but a rule filtering on a value a client could set would be filtering on
nothing. The two criteria are one mechanism, and only the first has teeth.

**Sources.** `04` Phase 1.3; `13`; `14`; `15` A5; `17`; migration `0004`'s
`allergy_provenance_valid`; `rules.ts`; `BLK-006`.

---

## DEC-092 - Certainty is the person's; provenance is Kynviora's; neither implies the other

**Date:** 2026-09-02
**Phase:** 1.3

**Status:** Accepted

The schema has carried both columns since migration `0004` and nothing had ever written either, so
what each one means was still open.

**Certainty is how sure the person is.** "I have been told this", "I think so", "I am sure" - the
labels are all first-person, and a test asserts every one of them is. Provenance is where the fact
came from, which for anything typed into this app is `USER_REPORTED` however sure they are.

**So a person may say `CONFIRMED`.** Refusing it from a household surface would throw away real
information: somebody hospitalised for a penicillin reaction knows something worth recording, and a
product that only let them say "I think so" would be second-guessing their account of their own
body. What the exit criterion forbids is that becoming a _confirmed diagnosis_, and it does not -
the provenance still reads `USER_REPORTED`, the schema has no `CLINICIAN_CONFIRMED` provenance at
all, and no shipped rule reads certainty.

**They are never combined into one word.** There is no function anywhere that derives one from the
other and no screen that merges them; the row shows two separate phrases. The same separation
DEC-007 keeps between regulatory status and applicability, for the same reason - collapsing two axes
is how a confident sentence gets built out of thin evidence.

**The default is the weakest of the three.** `REPORTED`, matching the column default. A record that
defaulted to `CONFIRMED` would put a stronger claim on somebody's file than they made.

**A provenance is described by who put the record there, never by how good it is.** A test asserts
no provenance sentence contains "reliable", "weak", "unverified" or their opposites: ranking them
would be scoring somebody's account of their own body on a screen they read.

**Sources.** `04` Phase 1.3; `09`; `18`; migration `0004`; DEC-007.

---

## DEC-093 - An unmatched term says so on the record, and a review is never inferred

**Date:** 2026-09-02
**Phase:** 1.3

**Status:** Accepted

Two things a person would otherwise assume, and both would be wrong.

**Kynviora cannot check anything against a term it has not matched.** `allergy_record.substance_id`
is nullable and this route never sets it: a household typing "penicillin" is not the catalog
learning a substance, which is the rule manual entry already keeps (`15` A11), and `04` Phase 5.2
makes the mapping the catalog's business. So in this build **every** hand-entered fact is unmatched,
and a rule that matches on canonical substances cannot see any of them.

The response reports `matchesCanonicalSubstance` rather than leaving a screen to infer it from a
missing field, and `healthFactRowView` turns it into one of two sentences that appear on every row.
The unmatched one says both halves - Kynviora cannot check your products against this **and** it is
recorded and not lost - because "not being used" without "not lost" reads as the record having been
rejected. A person who typed an allergy and assumed it was being watched would find out through an
alert that never arrived, which is the `10` failure this whole feature is most exposed to.

**A review is something somebody did, not something an edit implies.** `last_reviewed_at` is
stamped only when the change says `markReviewed`, and it is stamped by the server: a client-set
timestamp would let a screen claim somebody checked an allergy at a moment they did not. Correcting
a typo leaves it alone, because a review date Kynviora inferred would make a stale record look
checked - the same "silently becomes" the phase's exit criterion is about, one level up from the
fact itself.

**And it is a fact on the screen, not a nag.** "Nobody has checked this since it was added" is
information. There is no count of unreviewed records, no badge, no ordering by staleness, and a copy
test asserts no sentence in the module says "overdue" or "action required" - `02` names that as the
anti-feature, and this is somebody's own account of their own body.

**An edit is conditional on the version.** `sync.ts` has set `allergy_record`'s conflict policy to
`ASK_USER` since Stage 1 with no reader; losing a recorded allergy to a stale offline edit is
exactly the case that policy exists for. A save that changes nothing is refused with its own reason
code rather than committed, because an empty save moves the version and becomes somebody else's
conflict.

**Sources.** `04` Phase 1.3; `04` Phase 5.2; `02`; `10`; `15` A11; `sync.ts`; migration `0004`;
DEC-082.

---

## DEC-094 - Consent is a state, and the screen says which of the eight switches do anything

**Date:** 2026-09-02
**Phase:** 1.4

**Status:** Accepted

`04` Phase 1.4's exit criterion is "revoking optional consent disables the associated behavior".
Writing a row does not satisfy it. `consent_receipt` had been append-only, superseding and tested
since migration `0002` and **nothing had ever read it** - which is a consent _log_, not a consent
_state_.

**What makes it a state is a total record over the vocabulary.** `CONSENT_ENFORCEMENT` gives every
one of the eight purposes one of three answers: `ENFORCED` (something in the code path checks it),
`NOTHING_TO_STOP` (the behaviour it would govern does not exist in this build), or `REQUIRED` (the
product cannot run without it, so it is not offered as a choice at all). It is `satisfies
Readonly<Record<ConsentPurpose, ConsentEnforcement>>`, so a purpose added to the vocabulary without
an answer here fails to compile rather than shipping as a switch nobody classified.

**Two of the eight enforce something, and the screen says so on the row.** `NOTIFICATIONS` and
`CAREGIVER_SHARING` change what `selectRecipients` does. The other five govern behaviour this build
does not have - no analytics, no OCR (`BLK-007`), no connected-health integration, no research
programme, and manual entry never reaches the shared catalog by construction (`15` A11). Offering a
person a switch that stops nothing while the screen implies otherwise is the `10` failure this
codebase spends the most care avoiding: they would believe they had turned something off. Each such
row carries "Kynviora does not do this at all at the moment. Your answer is recorded and will apply
if it ever does" - both halves, because the first alone reads as the answer being discarded.

**The server reports the enforcement; the client never infers it.** `ConsentStandingLine.enforcement`
comes off the wire and `consentRowView` reads it, defaulting an unrecognised value to
`NOTHING_TO_STOP` - the pessimistic reading. A screen that computed this would keep saying "nothing
happens yet" on the day a purpose became enforceable, and a client that guessed optimistically would
tell somebody they had stopped something they had not. An end-to-end test asserts the server's
answer equals `consentEnforcement()` for every purpose, so the two cannot drift.

**Deny by default, and "never answered" is not "answered no".** An absent receipt is `granted:
false` for every purpose including the required one - "required" is a statement about what the
product needs, not a licence to assume an answer - and `everAnswered` is reported separately so the
screen can say "you have not answered this yet, so Kynviora treats it as not agreed" instead of
letting somebody discover it. `PROFILE_DATA` is not exempt.

**The standing answer is the newest receipt, not the end of the supersession chain.** The table
records `supersedes_id` and `consentStateFrom` deliberately does not follow it: a chain with a
broken link would produce no answer at all, and "no answer" here means "not granted" - the safe
direction, but for the wrong reason. Reading the newest row by `recorded_at` stays correct when the
chain does not. A tie goes to the **withdrawal**, because somebody who both granted and withdrew at
the same instant has said something Kynviora must not resolve in its own favour.

**Sources.** `04` Phase 1.4; `16`; `14`; `10`; `02`; `15` A11; migration `0002`; DEC-045; `BLK-007`.

---

## DEC-095 - Withdrawing notifications stops every notification, a critical safety alert included

**Date:** 2026-09-02
**Phase:** 1.4

**Status:** Accepted

This is the decision on this phase that could reasonably have gone the other way, and it did not.

**Consent is checked first in `selectRecipients`, before the owner short-circuit and before every
grant-shaped check.** A `CRITICAL` alert pierces quiet hours (DEC-078) because quiet hours are a
_timing_ preference - the alert still arrives, later or on another channel. Consent is the basis on
which Kynviora may contact somebody **at all**, and continuing to send to a person who said stop is
not a safety feature; it is sending without consent. So there is no urgency that pierces it, and the
check is not grant-shaped: the profile owner is not exempt from their own answer, because it is
their own device and their own decision about it.

**The sentence is above the control, not under it.** "Nothing will be sent to your device at all -
including a critical safety alert about a medicine in this household. Everything is still recorded
and waiting when you open Kynviora." Both halves, and before the button, which is the same rule
DEC-084 keeps for archiving an item (archiving turns the safety watch off). It is also the button's
accessibility hint, so it is not sight-only. A person who believed a recall would still reach them
would find out on the night it mattered.

**`CAREGIVER_SHARING` is the profile owner's answer about their information reaching other people,
and it excludes caregivers only.** It is carried on every candidate because that is where the
decision is made, but it is a property of the profile rather than of the person being considered -
withdrawing it is "stop telling other people about me", never "stop telling me". It is checked
before the grant state, because "I have stopped sharing" is a stronger statement than "your grant
expired", and reporting the weaker one would describe the wrong thing in the audit trail.

**It does not revoke read access, and the copy says so.** "They stop being sent anything about you.
They can still see what you have already shared with them - to change that, remove their access on
the Care screen." Stopping notifications is not removing access; a sentence implying otherwise would
leave somebody believing they had cut off a caregiver they had not. Removing access is a separate
control that is behind step-up (`14`), and this one names it rather than leaving them looking.

**Two new exclusion reasons rather than one, and neither is `CAPABILITY_MISSING`.**
`CONSENT_WITHDRAWN` and `CAREGIVER_SHARING_WITHDRAWN` are distinct from each other and from every
existing reason. Reporting a person who exercised a right in the same audit bucket as one whose
grant was never wide enough would make the delivery record unable to answer the only question anyone
would ask it afterwards.

**No receipt is not consent, in SQL as well as in the domain.** `loadCandidates` `COALESCE`s both
values to `false` and the mapper reads `=== true` rather than truthily, so a driver returning `'t'`
or `1` cannot become agreement. Every existing dispatch fixture had to be given consent rows before
its recipient assertions meant anything again - which is the enforcement working, found by four
suites going red at once.

**Sources.** `04` Phase 1.4; `14`; `16`; `10`; `02`; DEC-078; DEC-084; `15` A6.

---

## DEC-096 - Consent is strictly the caller's own, and no step-up stands between a person and withdrawing it

**Date:** 2026-09-02
**Phase:** 1.4

**Status:** Accepted

**Neither route takes a user, and neither could accept one.** `consent_select` and `consent_insert`
have required `user_id = kynviora.current_user_id()` since migration `0002`, with no relationship
clause of any kind - no household, no grant, no capability. So `GET /v1/consents` needs no `WHERE`
at all and `PUT /v1/consents` takes `user_id` from the request context. Consent is the one thing in
this product nobody may exercise or read on somebody else's behalf: not a profile owner for a
caregiver, not a caregiver holding every capability there is for the person they look after. Three
SQL-level tests assert it at the table, so a future route that named a user would fail there rather
than succeed quietly.

**The body carries no policy version and no timestamp.** Both are the server's. A client that could
name the policy version it agreed to could record agreement to a text nobody showed them, and a
client-set `recorded_at` is an audit trail written by the thing being audited. The schema is
`.strict()`, so `userId`, `policyVersion` and `recordedAt` are all refused rather than ignored - and
an end-to-end test sends each of the three and then asserts nothing was written.

**There is no step-up on consent, and that is deliberate.** `14` puts _caregiver administration_
behind re-authentication, and this is not that: withdrawing is the safe direction, and granting
widens nothing on its own, because the grant that would carry information to another person is
itself behind step-up. Friction placed on withdrawal and not on granting is a design that has taken
a side, which `16` and `02` both forbid. For the same reason there is no confirmation step: the
consequence is stated before the control, and that is the whole of what `18` asks for here.

**Withdrawing writes a row; it never changes one.** The route reads the previous standing receipt
and points the new one at it through `supersedes_id`, and the append-only trigger refuses UPDATE and
DELETE to **every** role, the database owner included. That is the "auditable" half of the second
exit criterion, and it is the database's property rather than a handler's promise. It is also why
the API and dispatch suites seed consent once in `beforeAll` rather than cleaning up per test: there
is no cleanup available, to anybody (trap 105, again).

**The audit event names the purpose and the answer, and nothing else.** `CONSENT_GRANTED` or
`CONSENT_WITHDRAWN` against the receipt ID, with the purpose, the policy version and the locale.
Both are closed vocabularies and neither says anything about anybody's health (`14`).

**A purpose this build does not know is refused rather than stored.** A receipt naming a purpose
nothing can enforce is a record of agreement to something undefined, which is worse than no record.
And `granted` is not coerced: "yes" and "on" are not answers to a consent question, and a truthy
value arriving over the wire must not become agreement.

**Sources.** `04` Phase 1.4; `14`; `16`; `18`; `02`; `19`; migration `0002`; DEC-013; DEC-045.

---

## DEC-097 - The match names its own inputs, and the read path resolves them rather than deriving them

**Date:** 2026-09-02
**Phase:** 7.3 (`DEV-028`)

**Status:** Accepted

`profile_assessment` has stored `reasons`, `profile_fact_versions` and `formulation_version` since
migration `0006`. A version says **what state** an evaluation ran against; it does not say **which
row** out of that state was the reason. So the alert detail could say that a substance in the
declaration matched a recorded fact and could not say which - and the approved
`tpl.ingredient_sensitivity` wording, which names the exact ingredient and the exact recorded
sensitivity, refused to render rather than guess.

**The identity is frozen at evaluation, beside the versions that were already frozen there.**
`Assessment.matchedInputs` carries the canonical substance key and the profile fact ID the rule
matched on, written by `evaluateRule` and nothing else. Migration `0018` adds the two columns, with
three CHECKs: both or neither (either alone renders as a sentence with a hole in it), never on a
non-match (a sentence about something that did not happen), and no blank key.

**The alternative was to re-derive it on the read path, and that is the decision.** Joining the
item's formulation to the profile's allergy records and taking the intersection is a _different
computation_ from the one the rule ran: the declaration and the facts may both have moved, so it
could name a substance the rule did not match on. A confident, specific, approved-looking sentence
about the wrong ingredient is worse than no sentence - which is exactly what DEC-064 decided for the
Lens, and what `DEV-028` recorded as the reason for leaving the gap open rather than closing it
badly.

**No foreign key on the fact ID, for two reasons.** The first is mechanical: `profile_assessment`
carries a BEFORE UPDATE OR DELETE trigger that raises unconditionally (DEC-013), so no referential
action can fire - `ON DELETE SET NULL` would attempt an UPDATE and `ON DELETE CASCADE` a DELETE, and
both would trip the trigger and fail the parent delete instead of tidying anything. `ON DELETE
RESTRICT` would work and would make an allergy record undeletable forever, which is a retention
decision this build has not made (`DEV-036`). The second is the point of the column: this records
what the rule _saw_, and a reference a later event can null or cascade is one a later event can
quietly rewrite. A dangling ID resolves to no name and the template declines, which is the same
honest outcome as never having had one.

**Both lookups are LEFT joins under row-level security, and that is load-bearing.**
`allergy_select` requires `VIEW_MEDICINES`, so a caregiver holding `VIEW_SAFETY` alone reads the
alert and **not** what the person is allergic to - `03` group H keeps the two apart, and the
narrative declines rather than the route refusing. It is the same shape the withheld person and item
names already have (DEC-026).

**The recorded term is version-gated; the substance name is not.** `display_term` is the person's
own account and they may edit it, so quoting today's wording as what the rule matched would be a
statement about what happened that is not true - the assessment froze the fact's version alongside
its ID, and a mismatch drops the narrative rather than quoting either version. A `preferred_name`
change is the catalog renaming the same identity, not a person changing what they said, which is why
the assessment stores the **key** rather than the substance row's ID.

**A replay must reproduce the matched inputs too.** `replayAssessment` compares them, so a
recomputation that reached the same verdict while naming a different recorded sensitivity is a
_difference_ rather than a reproduction. It reached the same conclusion for another reason, and the
sentence a person reads is built from exactly these two values.

**Nothing in this build writes an assessment in production**, and that does not change here.
`evaluateRule` is called by the shadow runner and the replay route; `profile_assessment` is written
only by fixtures, because `BLK-006` means no rule is publishable. What has changed is that whatever
eventually persists one cannot forget these two fields: they are required on the type, and the
schema refuses the half-filled pair.

**Sources.** `04` Phase 7.3; `09`; `10`; `03` group H; DEC-013; DEC-026; DEC-064; `DEV-028`;
`DEV-036`; migrations `0006` and `0018`.

---

## DEC-098 - A typed term is mapped by the same function as a printed one, at write time, and only through a reviewed alias

**Date:** 2026-09-02
**Phase:** 5.2

**Status:** Accepted

`allergy_record.substance_id` has been nullable since migration `0004` and **nothing had ever set
it**, so every recorded allergy in this build was invisible to the one rule that would use it -
`evaluateIngredientSensitivity` filters profile facts to those carrying a canonical key. The
normalization engine that would map it has existed since Stage 5 and was only ever pointed at
ingredient declarations. DEC-093 described the consequence honestly on every row; this is the cause.

**The same function, deliberately.** `resolveRecordedTerm` and `normalizeIngredients` both go
through `resolveLookupKey` and both key through `ingredientLookupKey`. That is not tidiness: the
rule intersects a declaration's canonical keys with a profile fact's, so two resolvers that agreed
today would eventually produce a rule that fires on one spelling of a substance and not on another -
a spelling test wearing a safety rule's clothes. A test asserts a typed term and a label token with
the same key resolve identically, field for field.

**Only a reviewed alias resolves - not a display name.** The lookup reads `substance_alias` and
nothing else, not `preferred_name` and not `inci_name`. `08` makes an alias a reviewed artifact
carrying its own provenance and its own exact-versus-ambiguous state; a string comparison against a
display column is none of those things, and it would let a rule fire on a match nobody reviewed -
which is Phase 5.2's first exit criterion ("a synonym/model suggestion cannot become a trusted
canonical mapping without deterministic/source validation") failing by the back door. `REJECTED`
aliases are excluded in SQL: a mapping a reviewer refused must not count towards a match, nor
towards the ambiguity that blocks one.

The practical consequence today is that almost nothing resolves, because the vocabulary needs a
licensed source (`BLK-003`). That is a seeding problem with a name, not a reason to lower the bar
for what counts as a match.

**Nothing a person types ever reaches the vocabulary.** The lookup is a SELECT. There is no branch
that inserts a substance or an alias, and a test counts both tables across a write to prove it -
`08` and threat A11, the same rule manual entry already keeps for products. An unrecognised term
stays unrecognised and the row says so.

**Ambiguity is represented, never resolved.** A term resolving to more than one substance maps to
none of them. Picking the first would decide, on somebody's behalf, which of two substances they
react to. Two aliases pointing at the _same_ substance is one answer rather than an ambiguity, so
the candidates are deduplicated by substance before the count is taken.

**The state is stored, not derived.** Migration `0019` adds `substance_mapping_state` with a
biconditional CHECK against `substance_id`, so a row cannot claim a rule can see it while carrying
no substance. Re-resolving on the read path would be the mistake `DEV-028` was closed for one level
up: the vocabulary may have moved, so a re-resolution can disagree with the mapping that is actually
on the row and driving the rule.

**And a NULL is two different things to be told.** "Kynviora does not know that word" is a gap in a
licensed vocabulary and nothing the person can act on. "That word means more than one thing here" is
something they can fix in ten seconds by being more specific. A single sentence for both hides the
half that has a next step (`10`). The ambiguous sentence does **not** list the candidates: offering
them would be Kynviora suggesting what somebody is allergic to, and a record picked from a list
Kynviora offered is a different record from one they wrote. A copy test asserts it never says "did
you mean".

**A corrected term is re-resolved; anything else is not.** A record whose wording changed while
keeping the mapping the old wording earned would drive a rule on a substance nobody typed - Phase
1.3's "silently becomes" one level down. Equally, marking a record as checked is not a
re-resolution: a vocabulary that moved between the two moments must not silently change what a rule
can see on an edit that never touched the word. Both are tested.

**No client can set any of it.** There is no `substanceId`, no `substanceMappingState` and no
`canonicalKey` on either body, the schemas are `.strict()`, and a screen that could claim a match
would be claiming a rule watches something it does not - the same absence that keeps provenance out
of a client's hands (DEC-091).

**The original wording is untouched.** Phase 5.2's second exit criterion. `display_term` is stored
exactly as typed and rendered first on the row; mapping a term is not correcting it.

**Sources.** `04` Phase 5.2; `04` Phase 1.3; `08`; `15` A11; `10`; `14`; DEC-091; DEC-093; DEC-097;
`DEV-028`; `BLK-003`; migrations `0003`, `0004` and `0019`.

---

## DEC-099 - A blast radius counts only mappings somebody made, and a rule nobody wrote is still refused

**Date:** 2026-09-02
**Phase:** 6.7 (`DEV-018`)

**Status:** Accepted

The historical shadow dataset reached `owned_item`, `batch_or_lot` and `product_identity` and
stopped there, so `INGREDIENT_SENSITIVITY` was refused rather than measured (`DEV-018`). Refusing
was right while it lasted: reporting fewer matches than a rule really produces reads as "this
affects nobody" on the screen a reviewer approves from, and a reviewer confirming an expected match
volume against an under-count would be confirming something false.

**Both halves, or neither.** Phase 5.2 supplied the fact side and the item side was still missing,
and supplying one alone would have been worse than supplying neither - a rule matching on the
intersection would have reported zero with a straight face. Both landed together: the declaration's
canonical keys aggregated per item, and the profile fact's key joined through `substance_id`.

**Only `EXACT` ingredients contribute a key.** An `AMBIGUOUS` or `UNRESOLVED` ingredient resolved to
no substance, and counting it would be matching on a mapping nobody made - the same discipline
`evaluateIngredientSensitivity` already keeps on the profile side, and the same one DEC-098 keeps at
the point a term is recorded. A measured zero and a structural zero are different statements, and
this is what makes the number the first kind.

**`DUPLICATE_ACTIVE_INGREDIENT` stays refused, for a different reason than it was refused for.** The
dataset can feed it now; the engine cannot evaluate it. `09` requires validated reference data and
clinical review before that rule may exist at all (`BLK-006`), so `evaluateRule` returns a non-match
for every item - and measuring it would produce a confident zero about a rule nobody has written.
The refusal is the same code path and the comment says which of the two reasons applies, because a
list whose entries are there for different reasons is a list somebody eventually clears wrongly.

**The aggregation is a correlated subquery, not a second round trip.** One row per item is what the
dataset builder expects, and a per-item query over a whole installation's shelf is the shape that
stops being viable first. `array_agg` returns `NULL` rather than an empty array when nothing
matched, which the mapper coalesces - an item with no formulation never reaches the subquery at all.

**Sources.** `04` Phase 6.7; `09`; `DEV-018`; DEC-098; `BLK-003`; `BLK-006`.

---

## DEC-099 - A blast radius counts only mappings somebody made, and a rule nobody wrote is still refused

**Date:** 2026-09-02
**Phase:** 6.7 (`DEV-018`)

**Status:** Accepted

The historical shadow dataset reached `owned_item`, `batch_or_lot` and `product_identity` and
stopped there, so `INGREDIENT_SENSITIVITY` was refused rather than measured (`DEV-018`). Refusing
was right while it lasted: reporting fewer matches than a rule really produces reads as "this
affects nobody" on the screen a reviewer approves from, and a reviewer confirming an expected match
volume against an under-count would be confirming something false.

**Both halves, or neither.** Phase 5.2 supplied the fact side and the item side was still missing,
and supplying one alone would have been worse than supplying neither - a rule matching on the
intersection would have reported zero with a straight face. Both landed together: the declaration's
canonical keys aggregated per item, and the profile fact's key joined through `substance_id`.

**Only `EXACT` ingredients contribute a key.** An `AMBIGUOUS` or `UNRESOLVED` ingredient resolved to
no substance, and counting it would be matching on a mapping nobody made - the same discipline
`evaluateIngredientSensitivity` already keeps on the profile side, and the same one DEC-098 keeps at
the point a term is recorded. A measured zero and a structural zero are different statements, and
this is what makes the number the first kind.

**`DUPLICATE_ACTIVE_INGREDIENT` stays refused, for a different reason than it was refused for.** The
dataset can feed it now; the engine cannot evaluate it. `09` requires validated reference data and
clinical review before that rule may exist at all (`BLK-006`), so `evaluateRule` returns a non-match
for every item - and measuring it would produce a confident zero about a rule nobody has written.
The refusal is the same code path and the comment says which of the two reasons applies, because a
list whose entries are there for different reasons is a list somebody eventually clears wrongly.

**The aggregation is a correlated subquery, not a second round trip.** One row per item is what the
dataset builder expects, and a per-item query over a whole installation's shelf is the shape that
stops being viable first. `array_agg` returns `NULL` rather than an empty array when nothing
matched, which the mapper coalesces - an item with no formulation never reaches the subquery at all.

**Sources.** `04` Phase 6.7; `09`; `DEV-018`; DEC-098; `BLK-003`; `BLK-006`.

---

## DEC-100 - The local projection is the last thing the server said, and an access failure deletes it

**Date:** 2026-09-03
**Phase:** 12 / `04` Phase 0.1 (`BLK-002`)

**Status:** Accepted

**Context.** `secureDatabase.ts` had existed since Stage 0 with the SQLCipher key path written and
**nothing in the app calling it**. No screen opened the database, so no database file was ever
created - which meant `14`'s "encrypted local storage validated" release gate could not be
attempted even with a device attached: there was nothing on disk to inspect. `03` group J
separately requires the current medicine list and the basic personal-care shelf to stay usable
with no network, and neither did.

**Options.** (a) A development-only diagnostics screen that opens the database so a MASTG check
has a file to look at. (b) A per-entity local schema mirroring the server's tables. (c) One table
of API responses, opted into per call site.

**Decision.** (c). `projected_read_v1(key, body)` inside the SQLCipher database, written by
`useResource` for the reads that name a `projectionKey` - currently the profile list and the
shelf.

**Rationale.**

- **(a) would have proved the wrong thing.** A screen that opens a database so it can be inspected
  demonstrates that the harness's own write was encrypted. `14` gates a release on the app's data
  being encrypted, and the only honest evidence is a file the app filled while somebody used it.
- **(b) is a second copy of the server's shape, maintained by hand.** It drifts every time a
  response gains a field, and it drifts silently, because nothing compares the two. What is stored
  is exactly what the client already treats as the response type, so there is one shape and the
  server owns it. The cost is that no local query narrows a row, which is acceptable while the
  projection serves whole screens.
- **Opt-in per call site, not a cache layer.** What may live on a device is a decision about that
  content, not about caching in general. A screen has to name what it keeps.

**The part that is a security decision rather than a caching one.** `12` requires
"authorization loss invalidates local access" and `15` A2 lists "local projection purge on loss of
grant" among its mitigations. `retainsPreviousContent` already decides whether a failed refresh
may leave content on the _screen_; `projectionActionFor` derives the answer for the _disk_ from it
rather than restating it. `OFFLINE` and `SERVER_ERROR` keep the row, because neither is an answer
about access. Everything else deletes it. Without that, a revoked caregiver loses the shelf from
the screen, closes the app, reopens it offline and reads it again.

Deriving rather than duplicating matters because the two rules must never disagree: a failure kind
added to `ApiOutcome` gets both behaviours from one exhaustiveness check, and a test asserts the
two agree for every member of the union.

**Local content arrives as `STALE`, never `READY`.** It is what the server said last time, not an
answer to this load, and `18` forbids presenting uncertain information as certain. `12`'s "screens
read local state immediately" is satisfied by showing it at once - the honesty is in the label,
not in a delay. A stored response that is empty is not shown at all: `STALE` over nothing would
put "this is older than it looks" on a screen with nothing on it.

**The key carries the session.** `projectionKey(sessionId, logical)` is the only way to build one,
so a row cannot be written without the identity that fetched it. Two people on one device get two
sets of rows, and changing identity clears the store as well - `12`'s "sign-out removes decrypted
projections", in the only form reachable before Phase 1.1.

**Consequences.** The app now creates `kynviora.db` on first launch, which is what makes
`npm run verify:device` able to look at anything at all. The write half of `12`'s repository - the
pending-operation journal, offline creates and edits - is **not** built (`DEV-038`).

**Sources.** `12` (repository behaviour, offline storage, sign-out); `03` group J; `15` A2; `14`;
`18`; DEC-012; DEC-041; `BLK-002`.

---

## DEC-101 - The mobile dependency set is what Expo SDK 57 actually resolves, and the app commits to light

**Date:** 2026-09-03
**Phase:** 0.1 (`BLK-002`)

**Status:** Accepted

**Context.** `04` Phase 0.1 fixes the baseline at "Expo SDK 57 / React Native 0.86". The
repository pinned `react-native-screens@~4.11.0`, `react-native-safe-area-context@~5.4.0`,
`expo-router@~6.0.0`, `expo-sqlite@~16.0.0`, `expo-secure-store@~15.0.0` and
`expo-crypto@~15.0.0` - versions from an earlier SDK line. All of them typechecked, and
`npm run verify` was green on them for the whole life of the project, because **nothing had ever
compiled the native side**. The first real Gradle build failed on
`react-native-screens ... Unresolved reference 'CSSBackgroundDrawable'`, a class React Native 0.86
moved.

**Decision.** Align to what `expo install --check` resolves for the installed Expo: the four
`expo-*` modules onto the unified `~57.x` line, `react-native` to `0.86.3`,
`react-native-screens` to `~4.26.0`, `react-native-safe-area-context` to `~5.7.0`. Add
`expo-system-ui`, which is what makes a declared `userInterfaceStyle` take effect at all.

**TypeScript is deliberately left at 5.9.** `expo install --check` also asks for `~6.0.3`. That is
a compiler change across every package in the monorepo, orthogonal to getting a device build to
run, and taking it in the same change would mix "the app builds now" with "every test was
recompiled by a new major". It is recorded rather than done.

**`userInterfaceStyle` moved from `automatic` to `light`.** The claim was never true: there is no
`DARK_THEME` in `@kynviora/presentation` and thirty-four files import `LIGHT_THEME` directly. On
Android 16, where edge-to-edge is mandatory, `automatic` means the system chrome follows the
device into dark while every surface stays light - worst for exactly the audience `01` names.
Committing to light is the honest description of what the app does, and it is a smaller thing to
correct later than a dark mode nobody implemented.

**`edgeToEdgeEnabled` was removed** because Android 16 makes edge-to-edge mandatory and the option
no longer exists; prebuild warned about it on every run.

**Consequences.** `react-native-reanimated`, `react-native-worklets` and
`react-native-gesture-handler` arrive as transitive dependencies of the newer
`react-native-screens`. A four-ABI debug build takes roughly half an hour on this machine;
`-PreactNativeArchitectures=x86_64` builds only the one an x86_64 emulator needs.

**Sources.** `04` Phase 0.1; `01`; `18`; the Gradle failure recorded in this session's WORKLOG
entry; `BLK-002`.

---

## DEC-102 - A check that could not look reports INCONCLUSIVE, and an inconclusive run fails

**Date:** 2026-09-03
**Phase:** 0.1 / `14` security release gates (`BLK-002`)

**Status:** Accepted

**Context.** `14` puts "encrypted local storage validated" behind a release gate and asks for
MASVS/MASTG coverage of local data storage and key management. A harness for that is a piece of
code somebody will eventually point at and say "it passed".

**Decision.** `scripts/device/analysis.ts` returns `PASS | FAIL | INCONCLUSIVE` per check, and
`overallStatus` returns `INCONCLUSIVE` - which the runner exits non-zero on - if a single check
could not be performed.

**Rationale.** The dangerous shape for a security check is one that reports success because it
could not look. Two of these are _absence_ tests: the database must not contain a stored medicine
name in plaintext, and the installed package must not carry `ALLOW_BACKUP`. An absence test over
an empty input passes trivially, so `adb` failing, `run-as` being refused, or a `dumpsys` line
not being found would each read as evidence of security. Each is a distinct `INCONCLUSIVE`, and
there is a test for every one of them.

**The judgements are separated from the device work on purpose.** `analysis.ts` decides what
output means; `verifyLocalStorage.ts` runs `adb`. The rules are exercised on a machine with no
emulator attached, so `npm run verify` covers the checks and only the evidence needs hardware.

**Nothing is written into the app to be found.** The strings searched for are the development
seed's own synthetic product names, which the app stored through `useResource` while somebody
used it. A canary the harness inserted would only show that the harness's write was encrypted.

**Sources.** `14` (mobile security validation; release gates); `12`; `19`; OWASP MASVS-STORAGE;
`BLK-002`.

---

## DEC-103 - A tab label is sized to the slot it has, because a clipped name is worth less than a small one

**Date:** 2026-09-03
**Phase:** 0.1 / `18` (`BLK-002`)

**Status:** Accepted

**Context.** `18` requires the app to "support system font scaling without clipping critical
content/actions", and `MAX_SUPPORTED_FONT_SCALE` is 2.0, so 2x is what the app claims to survive.
On the emulator at 2x it did not: the navigator's own tab label is one line and ellipsises, and
Safety rendered as "Safet...". This had never been visible because nothing had ever been laid out
on a screen.

**Options.** (a) Leave it: an ellipsis at least signals truncation, and the screen's own heading
names the destination. (b) Wrap to two lines. (c) Size the label so it fits.

**Decision.** (c), and only on the tab bar. The label grows with the system scale up to the point
where it would stop fitting its fifth of the screen, and no further.

**Rationale.**

- **(a) is the thing the rule names.** A destination whose name is cut off is the icon-only tab bar
  `18` forbids, arrived at from a different direction - and `01` names older adults as the primary
  audience, who are the people most likely to have set 2x in the first place.
- **(b) does not work, and trying it made things worse.** The five names are single words and a
  single word does not break, so `numberOfLines={2}` changed a label with an ellipsis into a label
  clipped with no ellipsis at all. That was measured, not reasoned about.
- **There is no fourth option of showing fewer tabs.** `06` fixes five primary destinations.

**What is given up, and why it is the right thing to give up.** A person who set 2x does not get
2x on this one label. That is a real cost and it is smaller than the alternative: a name that is
cut off conveys less than the same name a size smaller, and this label is the third of three cues
for the same thing - the icon is beside it and the screen's own heading is above it, and that
heading does scale the whole way.

**The width heuristic is deliberate.** The size comes from an approximate glyph-width ratio rather
than from measuring the rendered text, which would need a layout pass and a second render for a
five-word problem. The constant errs small: too low renders a label smaller than it had to be,
which is untidy, and too high clips it, which is the failure the whole decision is about.

**Sources.** `18` (font scaling without clipping; meaning never carried by an icon alone); `06`
(five primary destinations); `01`; `04` Phase 9.4; the 2x screenshots in this session's WORKLOG
entry.

---

## DEC-104 - Schedule occurrence computation moved into `domain`, because a phone has to expand its own reminders

**Date:** 2026-09-03
**Phase:** 4.2 (local reminder engine)

**Status:** Accepted

**Context.** `packages/safety/src/schedule.ts` had held `localTimeToInstant`, `isActiveOn`,
`occurrencesOn` and `occurrencesBetween` since Stage 4. `packages/safety` is server-side only
(DEC-010): the client never evaluates a safety rule and must not be able to.

**Decision.** The file moved to `packages/domain/src/schedule.ts`. `packages/safety` no longer
exports it, and the two callers now read it from `@kynviora/domain`.

**Rationale.** `04` Phase 4.2 requires reminders "without relying on server timing", and a phone
that has been offline for a week still has to fire them. That is not a preference about
architecture - it is the phase. A device cannot expand a schedule it is not allowed to compute
with, so the alternatives were to move this, or to have the server send a list of instants, which
is the thing the phase forbids.

**What DEC-010 actually protects, and why this does not touch it.** The boundary is _rule
evaluation_: deciding that a substance interacts with a condition, and how urgent that is. A client
that could do that could raise a severity, or claim an assessment nobody produced. Turning "08:00
in Asia/Kolkata" into an instant is calendar arithmetic over a time the person typed themselves. It
was in `safety` because the first caller was the server, not because it was ever a rule - and the
file's own comment already said `12` required bounded memory on device, which is a sentence about a
phone.

`rules.ts` and `shadow.ts` stay where they are. This is the only file that moved, and the package's
index says why in the place where the export used to be.

**Sources.** `04` Phase 4.2 ("without relying on server timing"); DEC-010; `12`; `03` group J.

---

## DEC-105 - Quiet hours do not hold a dose reminder the person scheduled themselves

**Date:** 2026-09-03
**Phase:** 4.2 (local reminder engine)

**Status:** Accepted

**Context.** `04` Phase 4.2 lists "quiet-hour behavior where appropriate" as expected output.
`profile_notification_policy` already stores a quiet window, `withinQuietHours` and
`deliveryDecision` apply it, and `04` Phase 7.5 is where it was built.

**Decision.** `planReminders` takes no quiet-hours parameter and there must not be one. A scheduled
dose reminder fires at the time it was set, and is neither held nor silenced.

**Rationale.** "Where appropriate" is doing real work in that sentence, and this is the case where
it is not appropriate. Quiet hours exist so Kynviora does not wake somebody for something
_Kynviora_ decided to say - a safety alert, a missed-dose nudge to a caregiver. A dose reminder is
not Kynviora interrupting: it is the person's own alarm, at a time they typed, on a medicine they
take.

Holding a 22:00 dose until 07:00 because a window says so **moves the dose**, which is the one
thing this whole stage refuses to do - and it moves it silently, on the night somebody was relying
on it. Firing it silently is the same failure with a quieter symptom. A person who does not want to
be woken for a medicine sets the medicine's time, which is a control they already have and which
says exactly what it does.

The asymmetry with DEC-078 is deliberate and points the other way from the obvious reading. There,
a `CRITICAL` alert _pierces_ a quiet window because the window is a timing preference and the alert
still has to arrive. Here the reminder is not piercing anything, because the window was never about
the person's own alarms.

**What this costs, and where it is said.** Somebody who sets a 03:00 dose is woken at 03:00. That
is correct, and the settings screen already describes quiet hours in terms of what Kynviora sends
rather than as a global mute.

**Sources.** `04` Phase 4.2 ("quiet-hour behavior where appropriate"); `04` Phase 7.5; DEC-078;
`18`; `09`.

---

## DEC-106 - `USE_EXACT_ALARM` is declared, and the harness measures that it was honoured

**Date:** 2026-09-03
**Phase:** 4.2 (local reminder engine)

**Status:** Accepted

**Context.** `expo-notifications` calls `setExactAndAllowWhileIdle` when
`AlarmManager.canScheduleExactAlarms()` is true and `setAndAllowWhileIdle` otherwise. On Android 12
and later the answer is false unless the app declares an exact-alarm permission, so the default is
an alarm Doze may defer.

**Decision.** `apps/mobile/app.json` declares `android.permission.USE_EXACT_ALARM`, and
`scripts/device/reminders.ts` has its own check (`REM-2`) asserting the alarms the device is
actually holding are exact.

**Rationale.** An inexact alarm can be deferred by minutes or considerably longer in Doze. For a
notification saying "there is a safety update to review", that is fine. For "take this tablet now"
it is a different feature: the value of a dose reminder is almost entirely in its punctuality, and
one that arrives at an unpredictable time teaches somebody to stop trusting it, which is worse than
not having it.

`USE_EXACT_ALARM` rather than `SCHEDULE_EXACT_ALARM`: the latter is denied by default on Android 13
and later and has to be granted in a system settings screen, so relying on it means most people
silently get the deferred version. `USE_EXACT_ALARM` is the permission Android added for apps whose
core function is timed reminders, and it is granted at install.

**What this commits Kynviora to.** A Play Store policy declaration: `USE_EXACT_ALARM` is restricted
to apps whose core functionality is alarms or reminders, and using it obliges the listing to say so.
Medicine reminders are a named part of `03`'s MVP and of `04` Stage 4, so the claim is true - but it
is a commitment, not a free flag, and it is recorded here so that a later build which drops
reminders knows to drop the permission with them.

**Why it is measured rather than assumed.** Declaring a permission is not the same as the platform
honouring it, and the failure mode is invisible: reminders still arrive, just late. `REM-2` reads
`window=0` and `exactAllowReason` out of `dumpsys alarm`, so the claim is checked against the device
on every run. On this emulator the reason reads `policy_permission`, which is the declaration being
honoured.

**Sources.** `04` Phase 4.2 (reminder reliability); `12`; `18`; the `dumpsys alarm` capture in
`scripts/device/reminders.test.ts`.

---

## DEC-107 - Writing a medicine schedule needs `MANAGE_MEDICINES`, and the policy says which item kind it is for

**Date:** 2026-09-03
**Phase:** 4.1 (medicine schedule model)

**Status:** Accepted

**Context.** Migration `0004` gave `medicine_schedule` these policies:

    schedule_insert: WITH CHECK (EXISTS (SELECT 1 FROM owned_item i WHERE i.id = owned_item_id))
    schedule_update: the same, on both sides

The subquery runs under `owned_item_select`, so the whole condition reduces to `VIEW_MEDICINES`.
That was invisible for sixteen migrations because no route ever wrote a row.

**Decision.** Migration `0020` replaces both with a check requiring
`kynviora.has_capability(i.profile_id, 'MANAGE_MEDICINES')` and `i.item_kind = 'MEDICINE'`.
`schedule_select` is left exactly as it was.

**Rationale.** Building the write path is what made the gap real: with a route, a caregiver granted
read-only access to somebody's medicines could create their reminders, move them, or set
`active = false` so no reminder ever arrived again. The last of those is the one a person would
never see - no error, no reminder, and a medicine they believe they are being told about. `08.2`
requires caregiver capabilities to be scoped separately, and every sibling table already got this
right: `review_task` writes need `MANAGE_CARE`, `allergy` writes need `MANAGE_MEDICINES`.
`dose_event` is reachability-scoped on purpose and is a different kind of thing - a record of
something that happened, not a decision about the future.

**Why the item kind is in the policy.** The capability governing a personal-care item is
`MANAGE_SHELF`, so a policy naming only `MANAGE_MEDICINES` over any kind would check the wrong
capability for a shampoo. Rather than branch, the write path says what the table's name has always
said. No row anywhere is affected: the table was empty, because until `0020` nothing could write
one.

**Reading stays where it was.** A caregiver who can see a medicine may see when it is taken. The
asymmetry between reading and writing is the point of a capability model, and there is a test that
holds both halves against the same caller.

**Sources.** `08.2`; `04` Phase 4.1; `12` (authorization in the database); `13`; migration `0004`;
`db/medicineSchedule.test.ts`.

---

## DEC-108 - A reconciliation refused while another is running is deferred, never dropped

**Date:** 2026-09-03
**Phase:** 4.2 (local reminder engine)

**Status:** Accepted

**Context.** `ReminderProvider` runs one reconciliation at a time, because two overlapping passes
read the same held set and each schedules what the other has not yet placed. The first version
enforced that with a plain boolean: if a sync was in flight, the new request returned and did
nothing.

**What the device said.** With one active schedule, three consecutive cold launches held **0**
pending alarms. A single background-and-return then held **15**. The reminder engine did nothing at
all on a cold start, and had done nothing on a cold start since it was written.

Instrumenting the effect and reading `logcat` gave the mechanism exactly, rather than a plausible
story about it:

    effect { client: true,  activeProfileId: null, projection: false } -> returned early
    effect { client: true,  activeProfileId: set,  projection: false } -> started a sync
    cleanup: live=false                                                 (projection arrived)
    effect { client: true,  activeProfileId: set,  projection: true  } -> DROPPED by syncing guard

The provider's inputs arrive in stages - the API client, then the active profile, then the
encrypted projection. The pass that began without the projection was superseded a moment later by
the one that had it, and that one was refused. Nothing re-triggered it. The `AppState` listener
only fires on a _change_ to `active`, and a cold launch is already active, so the one path that
could have repaired it never ran either.

**Decision.** The rule moved into `packages/domain/src/reminderPlan.ts` as `requestReminderSync` /
`finishReminderSync` over a two-field `ReminderSyncGate`, with seven tests. A request that cannot
start now is **deferred**, and the `finally` that releases the gate re-triggers the effect.

**Rationale for where it lives.** This is a rule with a wrong answer, and the wrong answer shipped -
which is trap 164 arriving from a new direction. `apps/**` is outside the test run, so a decision
made there is one nothing checks; a `useRef` boolean read in a `useEffect` is not reviewable as a
rule. As a pure function it is, and the tests state the four properties directly: one at a time,
deferred not dropped, any number collapse into one re-run, and the gate releases even when the run
it was holding threw.

**Why deferral is the right rule and not just the safe one.** What is in flight was computed from
inputs that have since moved, so its answer is already stale; the request that superseded it is the
one that matters. Collapsing several into a single re-run is not a shortcut either - by the time it
happens they would all read the same state, and each extra pass is a full read of what the device
holds plus a write of the difference.

**What was measured after the change**, on a wiped app so nothing could be restored from
`expo-notifications`' own store, and with no background-and-return anywhere in it:

| Cold launch only                            | Pending alarms          |
| ------------------------------------------- | ----------------------- |
| Schedule at 22:10                           | 15, all exact, at 22:10 |
| Retimed to 20:45 while the process was dead | 15, all exact, at 20:45 |
| Deactivated while the process was dead      | 0                       |

The second and third rows are Phase 4.2's edit and cancellation paths, and before this fix both
were silently a launch behind.

**Sources.** `04` Phase 4.2; trap 164; `12`; the `logcat` capture above; `reminderPlan.test.ts`.
