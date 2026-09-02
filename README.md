# Kynviora

A family safety layer for medicines and personal-care products.

Kynviora knows what a person actually uses, monitors trusted changes around those exact items,
explains personal relevance with visible uncertainty, and helps take the next safe step.

**This is a rebuild in progress.** The source of truth is `KYNVIORA_PROJECT_SPEC/` (27 documents).
Current implementation state, blockers and next steps are in `docs/autonomy/STATUS.md`.

---

## Quick start

```bash
npm install
npm run verify
```

`verify` chains typecheck, mobile typecheck, lint, format check and the full test suite with
`&&`, so no gate can be silently skipped.

Individual gates:

```bash
npm run typecheck
```

```bash
npm test
```

---

## Running it

The API runs against a local PostgreSQL that the process owns - PGlite persisted to a directory,
which is genuine PostgreSQL 18.3 rather than a mock. There is no service to provision and no
connection string to set, which is how `BLK-001` is worked around for development.

```bash
KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev
```

That migrates, seeds one synthetic household, and listens on `127.0.0.1:3000`. The seed prints the
user ID to send as a header:

```bash
curl -H "x-kynviora-dev-user: 00000000-0000-4000-8000-00000000d001" http://127.0.0.1:3000/v1/profiles
```

**`KYNVIORA_DEV_AUTH` is a development backdoor.** Phase 1.1 has not chosen an auth provider, so
nothing yet produces a real session; this fills the gap so the app can be run at all. It refuses to
exist under `NODE_ENV=production`, it grants no reviewer role - a header is a client claim, and
`14` says staff roles are never inferred from one - and with no header every request is
unauthenticated. All three are tested.

Without the flag the server refuses to start rather than silently authenticating nobody. Set
`KYNVIORA_ALLOW_ANONYMOUS_START=1` if that is what you want.

### What will be empty, and why that is correct

The Safety and Regulatory Lens screens show nothing against the development seed. That is the
design working:

- **`BLK-006`** - no safety rule or regulatory record is publishable without a qualified clinical
  or legal reviewer, and none exists.
- **`DEC-016`** - every shipped regulatory fixture is deliberately rejected by the Citation Gate,
  because the research behind them came from search summaries rather than retrieved official
  documents. A test asserts they stay rejected.

Seeding content to make those screens look populated would put exactly the material in front of a
developer that the governance layers exist to keep out.

### On a phone or an emulator

The app needs a **development build**. Expo Go will not work and is not a fallback: the encrypted
local store is SQLCipher, which is compiled into the app by `expo-sqlite`'s config plugin, so it
only exists in a build made from the generated native project.

What has to be installed once:

- JDK 17 (the Gradle wrapper reads `JAVA_HOME`, so a newer JDK on `PATH` does not matter);
- the Android SDK with Platform 36, Build-Tools 36.x, Platform-Tools, the emulator, NDK
  `27.0.12077973` and CMake 3.22.1;
- an Android 16 (API 36) system image and an AVD, or a device with USB debugging on.

`ANDROID_HOME` and `JAVA_HOME` must be set. The exact package list and the Windows notes are in
`docs/autonomy/WORKLOG.md` under the session that first built this.

```bash
cd apps/mobile && npx expo prebuild --platform android --clean
```

```bash
cd apps/mobile && npx expo run:android
```

On an x86_64 emulator, building only the one architecture it can run cuts the first build from
about half an hour to a few minutes:

```bash
cd apps/mobile/android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64
```

`android/` and `ios/` are **not** committed. They are generated from `app.json`, and a committed
copy is a second source of truth that drifts from the config plugins - including the SQLCipher
one, whose entire effect is one line in a generated `gradle.properties`.

#### Pointing the app at the local API

Use `adb reverse` rather than the emulator's `10.0.2.2` host alias:

```bash
adb reverse tcp:3000 tcp:3000
```

The client refuses to send a development identity anywhere but a loopback origin, and refuses a
plaintext base URL that is not loopback - both mirroring the server's refusal under
`NODE_ENV=production`. `adb reverse` makes the host's API genuinely reachable at `127.0.0.1:3000`
_on the device_, so `EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3000` stays true rather than being
worked around. Put it in `apps/mobile/.env.local` along with `EXPO_PUBLIC_DEV_USER_ID` - see
`.env.example`.

#### Checking that local storage is really encrypted

```bash
npm run verify:device
```

Reads the app's own files through `adb run-as`, and fails if the database announces itself as
plaintext SQLite, if anything the app stored is readable in the raw bytes, if a 256-bit hex key
appears in the app's preferences, if the app cannot reopen its store after a force-stop, or if the
installed package still allows platform backup. A check that could not be performed reports
`INCONCLUSIVE`, and an inconclusive run exits non-zero - "we could not look" must never be
recorded as "we looked and it was fine".

Today, Shelf, Safety, Care and You read real data. The write flows - inviting a caregiver,
completing a review task, generating a Visit Pack, resolving a reconciliation difference - exist on
the client and do not have screens yet (`DEV-022`).

---

## What this is not

Two things Kynviora deliberately refuses to do, because they shape almost every design decision
in this repository:

- **It does not produce a universal safety score.** Evidence strength and action urgency are
  separate dimensions with separate vocabularies, and there is no function anywhere that converts
  between them. Several tests assert that none exists.
- **It does not treat an absence of findings as reassurance.** "No matched rule" is never rendered
  as approved, legal or safe, and every absence result carries a coverage statement saying what
  was and was not checked.

## Repository layout

```text
KYNVIORA_PROJECT_SPEC/   Source-of-truth specification (27 documents)
docs/autonomy/           Implementation plan, decisions, research, blockers, status
db/                      SQL migrations and the PGlite test harness
packages/
  domain/                Controlled vocabularies, branded IDs, provenance, untrusted quarantine
  catalog/               GTIN, ingredient normalization, fingerprinting, conflict, capture
  regulatory/            Registry records, Citation Gate, Global Regulatory Lens
  safety/                Deterministic rule engine, schedule computation
  ingestion/             Source retrieval, preservation, change detection
  presentation/          Design tokens, status presentation, safety copy
  fixtures/              Synthetic test data and the end-to-end vertical slice
services/api/            Fastify API boundary
apps/mobile/             Expo SDK 57 client
```

## Architecture in one page

**Dependency direction.** `domain` has zero runtime dependencies and performs no I/O. Everything
flows toward it: `domain <- {catalog, regulatory, safety, ingestion, presentation} <- services`.
The mobile app consumes shared packages from source, so a safety vocabulary cannot drift between
client and server.

**Authorization.** Two non-superuser database roles. `kynviora_app` carries user requests under
full row-level security; `kynviora_service` performs privileged operations with separate
credentials. A route handler's only database access is a connection already bound to the app role
with the caller's identity in a request GUC, so RLS applies to every query a handler can make.
Reaching the service role requires an explicit, named reason.

**Determinism.** Time and randomness are injected. A bare `new Date()` is a lint error in
production code, because assessment replay depends on it. Every assessment stores the exact
version of every input it consumed, and `replayAssessment` recomputes and reports which fields
moved.

**AI boundary.** Models propose; sources and deterministic validation prove; rules and review
decide. Untrusted external content is a distinct type that can only reach a model through a
sanitizer that emits an inert, delimited data block. Extraction agents hold no publish authority,
enforced by the grants they run with rather than by convention.

**The Citation Gate** exists at two layers: a pure function whose decisions are testable and
explainable, and CHECK constraints so a direct database write cannot bypass it.

## Testing

Tests run in-process with no external services:

- **Database and authorization tests** execute against real PostgreSQL 18.3 via PGlite. The
  harness asserts the session is the expected non-superuser role before any authorization
  assertion, because superusers bypass row-level security even under `FORCE ROW LEVEL SECURITY` -
  without that guard the whole suite would pass while testing nothing.
- **The vertical slice** (`packages/fixtures/src/verticalSlice.test.ts`) walks the full loop:
  profile, capture, observation, formulation resolution, normalization, regulatory lookup,
  assessment, result.

All test data is synthetic. No real patient or family health information appears anywhere in this
repository, and CI enforces that fixtures stay labelled as such.

## Honest limitations

These are tracked in full in `docs/autonomy/BLOCKERS.md`. The three that matter most to anyone
reading the code:

1. **No regulatory record is published.** Every shipped regulatory fixture is rejected by the
   Citation Gate, because the research behind them came from search-result summaries rather than
   retrieved official documents. A test asserts this. Promoting them would require a retained
   official snapshot with a checksum and a named qualified reviewer.
2. **No safety rule is approved.** The reviewer workflow and approval requirements are
   implemented; no qualified clinical or regulatory reviewer was available. Test helpers that
   simulate approval use the reviewer id `synthetic-test-reviewer` so they can never be mistaken
   for a real approval.
3. **Four of `19`'s fourteen device scenarios are covered.** The app builds and runs on an Android
   16 emulator and encryption at rest is demonstrated rather than described - `npm run
verify:device` kills the app, puts the API out of reach, and requires it to show content that
   can only have been decrypted from a file whose bytes contain no readable trace of it. What is
   not covered is not waiting on hardware: six scenarios are about features that do not exist and
   four are built and simply not yet driven on the emulator (`DEV-040`). Nothing can be created or
   edited offline (`DEV-038`), and there are no reminders (`DEV-039`).

## Licence

UNLICENSED. Not for distribution.

These documents and this code define product and engineering intent. They are not legal advice,
medical advice, regulatory approval, clinical validation, or a claim that Kynviora falls outside
any medical-device or health-software regulation.
