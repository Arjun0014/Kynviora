# Kynviora - Blockers

Classification per the operating brief: `EXTERNAL_CREDENTIAL`, `EXTERNAL_SERVICE`, `LICENSING`,
`LEGAL_REVIEW`, `CLINICAL_REVIEW`, `TECHNICAL`, `ENVIRONMENT`, `DATA_AVAILABILITY`.

A blocker does not stop the project. For each one: the interface exists, a safe local adapter is
implemented, the exact configuration required is documented, and independent work continues.

---

## BLK-001 - Managed Postgres / Supabase parity unverified

- **Class**: `EXTERNAL_SERVICE`
- **Status**: **RESOLVED 2026-09-05**

- **How it resolved.** `kynviora-dev` exists and every part of the workaround has been replaced by
  a measurement. Migrations `0001`-`0031` were applied **unmodified** through the repository's own
  migration runner to managed Postgres 17.6 behind Supavisor; the pooled managed runtime is real
  (`db/src/managed.ts`), with pinned TLS against a root fetched out of band; the parity and RLS
  suites run against that instance; the API and multiple concurrent retention workers were
  exercised on it; and `19`'s fourteenth device scenario drives a phone against it end to end.

  The privilege boundary is not documentation either. `app_user` is owned by `kynviora_migrate`
  and granted only to `kynviora_app` and `kynviora_service`; Supabase's own `postgres`, `anon`,
  `authenticated` and `service_role` hold **no privilege on any Kynviora table**, asserted through
  the catalog and again over the HTTP surface, where PostgREST answers
  `401 permission denied for table owned_item` to every one.

  Two things this deliberately does not claim: performance under load, which nothing here has
  measured, and Postgres version parity - the local harness is PGlite 18.3 and the managed instance
  is 17.6, which the parity suite exists to keep honest rather than to hide.

- **Historical detail follows.**
- **Status (historical)**: OPEN - worked around
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
- **Narrowed on 2026-09-05** (DEC-118). Phase 1.1 has chosen a provider - **Supabase Auth**, with
  verified email/password plus recovery for a household and mandatory TOTP at AAL2 for reviewers -
  and everything that does not need a project is built:

  | Built                                                                                                      | Still blocked                          |
  | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- |
  | Token verification behind the existing port: ES256/RS256, JWKS, key rotation, issuer and audience          | A project to fetch a key set from      |
  | `AuthenticationStrength` gains `SUPABASE_AAL2`, so the standing banner stops **because the value changed** | Any real session to carry that value   |
  | `createReviewerAuthenticator` refuses a verified AAL1 token outright                                       | Any reviewer to refuse                 |
  | Step-up read from the token's own `amr`, so a client cannot assert re-authentication it did not perform    | `19`'s sign-up/sign-in device scenario |
  | `ClientSession` gains a `BEARER` member carrying the token verbatim                                        | Account deletion (`DEV-062`)           |

  HS256 is refused, before a key is chosen. Supabase supports it and discourages it: a shared
  secret means every service that can check a token can also mint one.

  **What is not built, and why not:** no refresh loop, no session persistence, no sign-in screens.
  Each would be written against a provider nobody can reach and tested against a fixture of this
  build's own devising, and would look finished. Every test signs its own tokens with a locally
  generated key pair - which exercises the signature check, the algorithm gate, the key rotation
  path and the AAL modelling for real, and establishes nothing about what a Supabase project
  issues.

- **Narrowed again on 2026-09-06.** The project exists and a person signs in on a phone against
  it: `SIGN-4` passes - a Supabase-issued ES256 token, minted by somebody typing a password on the
  device, verified by the API against the published key set, resolved to an `app_user` row and used
  by row-level security to choose rows. `SIGN-1`, `SIGN-3`, `SIGN-7` and `SIGN-11` pass with it.

  The **service-role credential is no longer part of this blocker**. DEC-126 removes an identity
  through an Edge Function that holds the key inside Supabase, so no privileged credential enters
  this deployment; `can_remove_identity` is true, and `DEV-062` is now blocked on two ordinary
  defects rather than on a secret.

  | Still blocked                        | By what                                                                               |
  | ------------------------------------ | ------------------------------------------------------------------------------------- |
  | The email round trip                 | a mailbox, and a mailer that allows two an hour                                       |
  | An account created through the app   | the same quota - see trap 206; not yet attempted with `KYNVIORA_SIGNIN_PHASES=signup` |
  | A reviewer with a real second factor | `BLK-006`: nobody is staffed to hold one                                              |

  AAL2 itself is proven on a synthetic account (real TOTP factor, real RFC 6238 codes); what is
  missing is a _reviewer_, which is a person rather than a mechanism.

- **Narrowed a third time on 2026-09-06, and the reason it blocks sign-up was wrong.** Everything
  about a **session** is now proven on hardware, and the mailer quota turns out not to have been
  what stood in the way of sign-up.

  `verify:device:signin` in its session phase - `SIGN-1`, `SIGN-3` to `SIGN-9` - is **8/8 PASS** on
  one run against the real stack. A person signs in, the session is in the encrypted store and in
  no readable file, it survives the app being killed, it is **renewed** when its access token comes
  due, signing out ends it here and at the provider, and a session revoked from somewhere else
  signs the phone out. The last two are the pair that makes the fifth mean anything: under the same
  conditions, a live session renews and a revoked one does not.

  **Sign-up is refused for the address, not for the quota.** The provider's own auth log records
  what the app's sign-up got:

      400 email_address_invalid   Email address "kynviora-signin-...@kynviora.test" is invalid

  with an `auth_event` of `user_confirmation_requested` - GoTrue reached the point of sending a
  confirmation, could not, and rolled the user back. `kynviora.test` has no MX record;
  `example.com` and `example.org` publish a null MX (RFC 7505). And there is no
  `over_email_send_rate_limit` anywhere in the log for any run of this scenario: the two-an-hour
  quota is real and it never fired. A refusal for an undeliverable address costs none of it,
  because nothing is sent.

  So `SIGN-2` and `SIGN-10` are blocked by **this** blocker and not by a separate one, which is the
  useful half of the correction: one mailbox closes the confirmation round trip, the recovery round
  trip, and account creation through the app's own form. `KYNVIORA_SIGNIN_SIGNUP_DOMAIN` is where
  the address goes when there is one.

  | Still blocked                        | By what                                                    |
  | ------------------------------------ | ---------------------------------------------------------- |
  | The email round trip                 | a mailbox: a domain that accepts mail somebody can read    |
  | An account created through the app   | the same mailbox - the address is refused, not the attempt |
  | A reviewer with a real second factor | `BLK-006`: nobody is staffed to hold one                   |

- **To resolve**: custom SMTP or a mailbox on the project, and a named reviewer per `10`. The
  development authenticator is refused when the issuer is set, so there is no configuration where
  both are live.

## BLK-012 - No speech, language-model or speech-synthesis provider

- **Class**: `EXTERNAL_CREDENTIAL` + `LEGAL_REVIEW` (the `16` model and data privacy review)
- **Status**: OPEN - worked around
- **Blocks**: anything in Voice Mode actually listening or speaking; any claim that a real model
  routes a real sentence to the right tool; `17`'s AI evaluation suite for a conversational agent.
- **Detail**: Voice Mode needs three separate providers, and each of them would receive **health
  content spoken in somebody's home**:

  | Port                | What it would receive                        |
  | ------------------- | -------------------------------------------- |
  | `SpeechRecognizer`  | Audio of somebody naming their medicine      |
  | `ConversationAgent` | A transcript and the callable tool list      |
  | `SpeechSynthesizer` | Text that has already passed the Speech Gate |

  `16` requires a model and data privacy review before any provider sees health content, and `23`
  lists provider strategy among the decisions that are recorded rather than arrived at. Choosing
  one here to make progress would be exactly the fabrication the operating brief forbids.

- **Workaround in place**: everything that does not need a provider is built and tested. The tool
  registry, the six gates, the confirmation machine, the Speech Gate, the executor, the navigation
  and camera bridge and the screen are all real; `createScriptedAgent` is a **phrase matcher**,
  named for what it is, and it exercises the whole pipeline end to end in CI on a machine with no
  microphone. `NO_PROVIDERS` is the shipped configuration, and the screen says on itself that it
  cannot listen rather than appearing to.

  The fake had a gap of its own until 2026-09-08 and it is worth recording here rather than only in
  `DEV-095`, because it bounded what the workaround established. `demonstrationScript` was handed an
  empty item ID, so four of its rules - both doses, the missing-fields question and the reminder -
  were refused at gate 3 as malformed and spoken as "I cannot do that by voice." Every item-scoped
  journey was therefore **unexercised on hardware**, including the offline dose DEC-140 describes.
  The script now leaves out a rule it cannot fill, the item comes from
  `EXPO_PUBLIC_DEV_VOICE_ITEM_ID`, and `OFF-8`/`OFF-9` drive a full item-scoped write end to end.

- **What the fake establishes, and what it does not**: it establishes that a proposal for tool X
  with arguments Y is validated, confirmed, executed and reported correctly - including when the
  proposal is hostile, which several of its scripts are. It establishes **nothing** about whether a
  real model would propose that tool for that sentence. That half is unmeasured because there is no
  provider rather than because nobody looked.

- **What an implementation must promise** (`packages/agent/src/ports.ts` states it in the code):
  the agent gets tools and never data - `AgentTurnRequest` carries what was said, the conversation
  as plain lines, and the tool list, and there is no field on it for a session, a token, a profile
  or any record content. Its output is untrusted (`15`) and is validated against the registry
  regardless of which provider produced it.

- **To resolve**: complete the `16` model and data privacy review per provider, record the decision
  per `23`, obtain credentials, and implement the three adapters behind the existing ports. Nothing
  else about Voice Mode changes: the shell, the gates and the gate on speech are provider-independent
  by construction.

## BLK-011 - Which caregiver capability may record a dose has not been decided

- **Class**: `LEGAL_REVIEW` (product/consent scope, not law) - recorded here because it blocked a
  code change rather than because it needed a lawyer.
- **Status**: **RESOLVED 2026-09-04** (DEC-116)
- **Was blocking**: closing `DEV-049`; any claim that a caregiver grant means exactly what the
  screen says it means.
- **Detail (historical)**: a caregiver granted only `VIEW_MEDICINES` could write into the owner's
  dose history. `0004` and `0020` scoped `dose_event` writes by reachability, deliberately and in
  writing; the invitation screen grouped `VIEW_MEDICINES` under "viewing" and described it as
  allowing no changes, equally deliberately. Both positions were defensible and they contradicted
  each other. The three ways out - tighten the policy, change the copy, or add a `RECORD_DOSES`
  capability - each changed what an existing grant means, which is a product decision rather than
  an engineering one.
- **How it resolved**: the third way, decided as a product question and recorded as DEC-116.
  `VIEW_MEDICINES` stays strictly read-only, `MANAGE_MEDICINES` keeps managing medicines and
  schedules and is not a way in, and writing into a dose history is `RECORD_DOSES` - a new
  capability that **no existing grant acquired**, because migration `0021` widens the vocabulary
  and backfills nothing. An owner grants it explicitly or the write is refused.

  | Where            | What changed                                                                 |
  | ---------------- | ---------------------------------------------------------------------------- |
  | Vocabulary       | `RECORD_DOSES` between `VIEW_MEDICINES` and `MANAGE_MEDICINES`               |
  | Migration `0021` | `dose_event_insert` requires it; both capability CHECKs widened; no backfill |
  | API              | `mayRecordDoses` on the item detail and on the shelf page                    |
  | Screen           | its own checkbox, filed under what the caregiver may **change**              |
  | Device           | `npm run verify:device:doseaccess` - 7/7 PASS                                |

  What was never at risk is unchanged and still measured: a stranger, a revoked caregiver, and a
  revoked caregiver replaying an operation minted while their grant stood are all refused.
