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
