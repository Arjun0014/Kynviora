# Kynviora - Blockers

Classification per the operating brief: `EXTERNAL_CREDENTIAL`, `EXTERNAL_SERVICE`, `LICENSING`,
`LEGAL_REVIEW`, `CLINICAL_REVIEW`, `TECHNICAL`, `ENVIRONMENT`, `DATA_AVAILABILITY`.

A blocker does not stop the project. For each one: the interface exists, a safe local adapter is
implemented, the exact configuration required is documented, and independent work continues.

---

## BLK-001 - Managed Postgres / Supabase parity unverified

- **Class**: `EXTERNAL_SERVICE`
- **Status**: OPEN - worked around
- **Blocks**: production deployment; Supabase-specific auth integration; connection pooling and
  performance validation.
- **Detail**: No Supabase project, no managed Postgres, and no Docker in this environment.
  Migrations and RLS policies are executed against PGlite (real PostgreSQL 18.3 in WASM), which
  validates schema, constraints, triggers and policy logic but not managed-platform behaviour,
  pooling, extensions, or performance under load.
- **Workaround in place**: migrations are written as portable SQL with no Supabase-only syntax,
  so they apply to any Postgres. The `TestDb` harness abstracts the connection.
- **To resolve**: provision a Postgres instance, set `KYNVIORA_DATABASE_URL`, run the migration
  runner against it, and re-run the authorization suite pointed at that instance.

## BLK-002 - Encrypted local storage unverified on device

- **Class**: `ENVIRONMENT`
- **Status**: **RESOLVED 2026-09-03**
- **Was blocking**: `04` Phase 0.1 exit criterion ("Android development build launches on
  emulator/device"); `14` release gate ("encrypted local storage validated"); `19` device E2E
  suite; MASVS local-storage testing.
- **Detail (historical)**: no Android SDK, emulator, or physical device was available. `expo-sqlite`
  with SQLCipher requires `npx expo prebuild` and a development build; it cannot run in Expo Go,
  and encryption at rest could not be demonstrated without a device.
- **How it resolved**: a full user-scope Android toolchain was installed (JDK 17, SDK Platform 36,
  Build-Tools 36.x, Platform-Tools, Emulator, NDK `27.0.12077973`, CMake 3.22.1, an Android 16
  system image and a Pixel 7 AVD). `npx expo prebuild` and `./gradlew :app:assembleDebug` produced
  a development build in 27 minutes across four ABIs, it installed and launched on the emulator,
  and `npm run verify:device` reports **PASS on all seven checks**:

  | Check       | What it showed                                                                     |
  | ----------- | ---------------------------------------------------------------------------------- |
  | `STORAGE-1` | 12,288 bytes read from `files/SQLite/kynviora.db` through `run-as`                 |
  | `STORAGE-2` | the file does not begin with `SQLite format 3` - SQLCipher encrypts the header too |
  | `STORAGE-3` | none of four strings the app had stored appears anywhere in the raw bytes          |
  | `KEY-1`     | no 256-bit hex key in either of the app's preference files                         |
  | `KEY-2`     | after a force-stop the app reopened the database and read back what it had stored  |
  | `BACKUP-1`  | the installed package does not carry `ALLOW_BACKUP`                                |
  | `STORAGE-4` | the read-back ran with the `adb reverse` tunnel removed, so nothing was refetched  |

  `KEY-2` and `STORAGE-4` are what make `STORAGE-3` mean anything: an absence test over an empty
  file passes trivially, so the run needs a positive control. The app is killed, the API is put out
  of reach, and it still shows "Synthetic Tablet A" - which can only have come out of that file.
  The file's entropy is 7.98 bits per byte and its first sixteen bytes are
  `125d7599a6019a7f38eed5fb105346ae`.

  The key is Keystore-wrapped rather than stored: `shared_prefs/SecureStore.xml` holds only
  `{"ct":"...","iv":"...","tlen":128,"scheme":"aes","keystoreAlias":"key_v1"}`.

- **What it did not resolve, and where that went**: `19`'s device E2E suite lists fourteen
  scenarios and this session exercised four of them. The rest are not waiting on hardware any more
  - each is now waiting on a named thing (`DEV-040`). Notably `04` Phase 4.2's reminder engine was
    recorded as blocked on this environment and is not: it is blocked on there being no way to
    create a schedule (`DEV-039`).

  Nothing here covers the other MASVS categories `14` lists - network communication, platform
  interaction, deep links, tampering. Only local data storage and key management were tested.

## BLK-003 - No commercial identity or normalization provider access

- **Class**: `EXTERNAL_CREDENTIAL` + `LICENSING`
- **Status**: OPEN - worked around
- **Blocks**: real GTIN-to-product resolution; Indian medicine normalization depth; provider
  conflict handling with live data.
- **Detail**: GS1 / Verified by GS1 requires a commercial agreement. PubChem is usable for
  chemical identifiers but is explicitly not a legal-status source. RxNorm/DailyMed/openFDA are
  US-centric and `26` warns directly that a US medicine label is not proof of an Indian marketed
  formulation. None can be wired here.
- **Workaround in place**: provider ports declare an `authorityScope` the resolver enforces
  (DEC-014), so a provider can never assert a field it is not authorised for. Deterministic local
  adapters back the ports.
- **To resolve**: complete licence review per source, obtain credentials, set the corresponding
  `KYNVIORA_*_PROVIDER_KEY`, and implement the adapter behind the existing port.

## BLK-004 - Regulatory fixtures are not verified against official documents

- **Class**: `DATA_AVAILABILITY`
- **Status**: OPEN - deliberately enforced
- **Blocks**: publishing any regulatory status as trusted, user-visible truth.
- **Detail**: research produced regulatory facts from **search-result summaries**, not retrieved
  official documents:
  - A direct fetch of `legislation.gov.uk/eur/2009/1223/annex/III` returned no extractable
    content through the available tool.
  - The FDA URL listed in `26_EXTERNAL_REFERENCES.md`
    (`.../prohibited-restricted-ingredients-cosmetics`) returned **HTTP 404** on 2026-08-29. The
    reference index is already stale - itself evidence for why source-freshness monitoring is a
    safety requirement (`20`).
- **Workaround in place**: every fixture carries `verification: NEEDS_PRIMARY_VERIFICATION` and
  `reviewState: IN_REVIEW`, and the Citation Gate **rejects** them. A test asserts that every
  shipped fixture is refused. The engine is fully exercised over honestly-labelled data.
- **To resolve**: retrieve the official documents, store snapshots with checksums where licensing
  permits, and have a qualified reviewer approve each record (see `BLK-006`).

## BLK-005 - Source licensing and redistribution review not performed

- **Class**: `LEGAL_REVIEW`
- **Status**: OPEN
- **Blocks**: source snapshot retention; any redistribution of source material; `25` source
  onboarding acceptance.
- **Detail**: `25` requires per-source review of legal/licence/attribution/redistribution terms
  before a source can influence user assessments. Whether EUR-Lex, GOV.UK, eCFR, CDSCO and MHLW
  material may be retained as snapshots versus referenced by derived fields is a legal question,
  not a technical one.
- **Workaround in place**: `SourceRegistryEntry.licenseReviewState` defaults to `NOT_REVIEWED`
  and `snapshotRetentionAllowed` to `false`; the Citation Gate refuses publication from a source
  whose licence review is incomplete. The system therefore fails closed pending review.
- **To resolve**: qualified legal review per source; record the outcome in the registry.

## BLK-006 - No qualified clinical, pharmacist or regulatory reviewer

- **Class**: `CLINICAL_REVIEW` + `LEGAL_REVIEW`
- **Status**: OPEN - permanent for this build
- **Blocks**: publishing any safety rule; publishing any regulatory status; `04` Phase 9.3;
  public beta.
- **Detail**: `10_CLINICAL_GOVERNANCE.md` requires named Clinical Safety Lead, Pharmacist/
  Medication Safety Reviewer, Product/Ingredient Safety Reviewer, and Regulatory Interpretation
  reviewer before public Safety Watch alerts, with two-person approval for high-impact content.
  No such people are available to this build, and the operating brief (section 39) forbids
  pretending otherwise.
- **Workaround in place**: the reviewer workflow, review states and approval requirements are
  implemented. Test-only helpers that simulate approval use the explicit reviewer id
  `synthetic-test-reviewer` so it can never be mistaken for a real approval. No rule or
  regulatory record ships in an approved state.
- **To resolve**: staff the governance roles defined in `10`.

## BLK-007 - No OCR or multimodal extraction provider

- **Class**: `EXTERNAL_CREDENTIAL`
- **Status**: OPEN - worked around
- **Blocks**: real package extraction; `09.1` field-accuracy measurement; the AI evaluation suite
  in `17`.
- **Detail**: the dual-extraction requirement (`17`) needs both a conventional OCR engine and a
  structured multimodal model. Neither is credentialed here, and `23` lists the provider strategy
  as a decision required before Stage 3 completion.
- **Workaround in place**: extraction is modelled behind ports; the pipeline consumes
  `ExtractionRun` records and `FieldAssertion`s regardless of which engine produced them. The
  agreement/disagreement logic and the "unconfirmed machine provenance is never trusted" rule are
  implemented and tested with synthetic extraction results. All AI kill switches default to
  `false` in `.env.example`, so the system runs without any provider.
- **To resolve**: select providers, complete the model/data privacy review in `16`, set the keys,
  and implement adapters behind the ports.

## BLK-008 - No labelled evaluation dataset

- **Class**: `DATA_AVAILABILITY`
- **Status**: OPEN
- **Blocks**: `04` Phase 9.1 entirely; every numeric release threshold in `22`.
- **Detail**: measuring identity precision/recall, formula-match precision, fingerprint
  false-merge and false-split rates, OCR field error rates and safety-rule false-positive rates
  requires labelled real-world packages. `21` forbids real health data outside production, and no
  ethically-sourced labelled dataset exists here.
- **Workaround in place**: synthetic fixtures exercise every code path, and the fingerprint
  false-merge/false-split _logic_ is tested exhaustively. What cannot be produced is a
  **measured rate** against real packages.
- **To resolve**: assemble a labelled dataset under an approved study design, then run the
  evaluation harness. Note `22` also requires product/safety leadership to assign the numeric
  accept/reject thresholds - an approval decision, not an engineering one.

## BLK-009 - No push notification credentials or delivery provider

- **Class**: `EXTERNAL_CREDENTIAL`
- **Status**: OPEN - worked around
- **Blocks**: delivery of any **server-originated** notification to a device - caregiver alerts,
  safety alerts, missed-dose nudges; delivery-failure and retry behaviour under a real provider;
  `15` A6 verification for those on a physical locked device.
- **Narrowed on 2026-09-03.** This used to say it blocked "actual delivery of any notification to a
  device" and "end-to-end verification that a lock-screen body renders as designed". Both are now
  too broad by exactly one case: a **local** notification needs no provider at all. Phase 4.2's
  reminder engine schedules through Android's own `AlarmManager`, and `npm run verify:device:reminders`
  reads what arrived out of `dumpsys notification --noredact` after killing the app's process - the
  posted text was "Kynviora" / "Kynviora has a reminder for you", naming neither the medicine nor
  the person. So the disclosure rule is verified end to end on a device for the one notification
  kind that can be. Everything the `NotificationTransport` port sends is still unverified on the
  wire, and that is what remains here.
- **Detail**: no FCM, APNs or Expo push credentials are available in this environment, and `14`
  lists notification server credentials among the secrets that must be held server-side. Nothing
  here can demonstrate that a device received a notification **that a server sent**.
- **Workaround in place**: delivery is decided, recorded and rendered behind a
  `NotificationTransport` port. The only implementation is `recordingTransport`, which records
  what it was asked to send and claims nothing about arrival. The recipient decision, the
  disclosure level and the exact body are therefore fully tested; the wire is not. Delivery rows
  are written before the transport is called, so a provider failure leaves a recorded delivery
  rather than an unrecorded arrival.
- **To resolve**: obtain provider credentials, set the corresponding `KYNVIORA_PUSH_*` values,
  implement the adapter behind the existing port, and re-run the delivery suite against it. `15` A6
  for a server-sent notification additionally needs a device, which now exists (`BLK-002`).

## BLK-010 - No strong authentication for a reviewer account

- **Class**: `EXTERNAL_CREDENTIAL`
- **Status**: OPEN - worked around
- **Blocks**: `13`'s reviewer console requirement of "MFA/passkey or approved strong
  authentication"; `14`'s "strong MFA/passkeys" and "no shared accounts" for reviewer/admin
  accounts; any claim that an action recorded in the console is attributable to a person.
- **Detail**: Phase 1.1 has not chosen an auth provider, so the only identity in this repository
  is the development header the API accepts behind `KYNVIORA_DEV_AUTH=1`. On a household surface
  that is a development convenience; on the reviewer console it is a claim to publication
  authority with nothing behind it, and `14` names reviewer compromise as the reason the whole
  governance chapter exists.
- **Workaround in place**: the console's sign-in page states that it is not an authentication
  step, and says so again in a standing banner on every page. `StaffSession.strength` is a closed
  union whose only member is `DEVELOPMENT_HEADER`, so a passkey provider lands as a second member
  and the banner stops appearing because the value changed rather than because somebody removed
  it. The strength grants nothing: authority is a stored `reviewer` row and always was, which an
  end-to-end test shows by signing the same person in twice with only that row changing. A
  development identity is refused outright over any non-loopback staff origin. Everything else
  `13` and `14` ask for is implemented: absolute and idle session expiry, step-up at publish and
  withdraw, an opaque server-side session, and an append-only audit of every privileged action.
- **To resolve**: complete Phase 1.1, add a `PASSKEY` (or equivalent) member to
  `AuthenticationStrength`, implement the challenge, and remove the development member from the
  console's accepted strengths.

## BLK-011 - Which caregiver capability may record a dose has not been decided

- **Class**: `LEGAL_REVIEW` (product/consent scope, not law) - recorded here because it blocks a
  code change rather than because it needs a lawyer.
- **Status**: OPEN - documented, behaviour pinned
- **Blocks**: closing `DEV-049`; any claim that a caregiver grant means exactly what the screen
  says it means.
- **Detail**: a caregiver granted only `VIEW_MEDICINES` can write into the owner's dose history.
  `0004` and `0020` scope `dose_event` writes by reachability, deliberately and in writing; the
  invitation screen groups `VIEW_MEDICINES` under "viewing" and describes it as allowing no
  changes, equally deliberately. Both positions are defensible and they contradict each other. The
  three ways out - tighten the policy, change the copy, or add a `RECORD_DOSES` capability - each
  change what an existing grant means, which is a product decision rather than an engineering one.
- **Workaround in place**: nothing is changed, and the behaviour is pinned by
  `services/api/src/doseAuthorization.test.ts`, which runs against the real database with row-level
  security in force. The same file measures what is **not** at risk: a stranger is refused, a
  revoked caregiver is refused, and a revoked caregiver replaying an operation minted while their
  grant stood is refused. So the exposure is bounded to somebody the owner chose to give access to.
- **To resolve**: choose one of the three, then write the reasoning where the test fails.
