# Kynviora - Research Record

Permanent record of external research that changed an engineering decision.

**Source classification used throughout this file** (mirrors `25_SOURCE_REGISTRY_AND_COVERAGE.md`):

- `PRIMARY_OFFICIAL` - law, regulation, official annex, or the vendor's own current documentation
- `AUTHORITATIVE_SECONDARY` - regulator explanation, standards body, established reference DB
- `COMMUNITY` - blogs, forums, aggregators
- `MODEL_INFERENCE` - reasoning by this agent, no external source

**Rule applied**: a search-engine or LLM answer is never itself the evidence. Where a claim
below is marked `COMMUNITY` or came from a search summary, it is flagged as **needs primary
verification** and is not permitted through the Citation Gate into published regulatory data.

---

## R-001 - Mobile baseline: Expo SDK 57 / React Native 0.86

- **Question**: Is the `11_SYSTEM_ARCHITECTURE.md` baseline (Expo SDK 57, RN 0.86, React 19.2)
  real and current, or aspirational?
- **Date**: 2026-08-29
- **Method**: npm registry query + Expo changelog search.
- **Findings**:
  - `npm view expo version` -> **57.0.18** (`PRIMARY_OFFICIAL`, npm registry).
  - Expo SDK 57 released 2026-06-30, ships React Native 0.86, React unchanged at 19.2.
    Positioned as a non-breaking upgrade from SDK 56 (`AUTHORITATIVE_SECONDARY`, Expo changelog
    via search; expo.dev/changelog/sdk-57).
  - A Hermes V1 memory regression affected early SDK 57 with `react-native-worklets` /
    `react-native-reanimated`; fixed in `expo@57.0.9` which moved to RN 0.86.2.
  - `npm view react-native version` -> 0.87.1 exists, but Expo SDK 57 pins the 0.86.x line.
- **Limitation**: Version currency verified at the registry/changelog level, not by building an
  Android binary in this environment (no Android SDK/emulator available here).
- **Decision**: Adopt the spec baseline unchanged. Pin via `npx expo install` so Expo resolves
  the SDK-compatible RN version rather than hand-pinning 0.87.x. Require `expo@>=57.0.9`.
  See `DEC-011`.

## R-002 - Encrypted local database under Expo SDK 57

- **Question**: What is the approved encrypted-SQLite strategy? (`23` open technical question,
  `12_MOBILE_ARCHITECTURE.md` requirement, release-gating in `14_SECURITY.md`.)
- **Date**: 2026-08-29
- **Findings**:
  - `expo-sqlite` supports **SQLCipher first-party** on Android/iOS/macOS. Enabled via a
    `useSQLCipher` config option in app config plus `npx expo prebuild`; the key is applied with
    `PRAGMA key = '...'` immediately after opening the database
    (`AUTHORITATIVE_SECONDARY`, Expo SQLite docs + expo/expo PR #30824 "custom sqlite and
    sqlcipher").
  - **Not supported in Expo Go** - a development build is mandatory. This matches Phase 0.1's
    "development-build workflow for native testing" requirement.
  - `op-sqlite` is a viable alternative also offering SQLCipher, but adds a non-Expo native
    dependency and drops web support.
- **Decision**: Use `expo-sqlite` + SQLCipher (first-party, fewer native dependencies, aligned
  with Expo config-plugin build strategy in `21_RELEASE_ENVIRONMENTS_AND_CICD.md`). Per-install
  random key generated with `expo-crypto`, stored in `expo-secure-store`
  (Keystore/Keychain-backed). See `DEC-012`.
- **Not yet verified in this environment**: actual on-device encryption-at-rest. Recorded as a
  blocker (`BLK-002`) because it requires an Android device/emulator.

## R-003 - Testing PostgreSQL migrations and RLS without Docker

- **Question**: The environment has no Docker. `19_TESTING_AND_QUALITY_STRATEGY.md` and
  `14_SECURITY.md` make deny-by-default RLS negative tests **release-gating**. How can RLS
  policies be genuinely executed and tested here?
- **Date**: 2026-08-29
- **Method**: Direct empirical test (not a search answer). Installed `@electric-sql/pglite`
  0.5.8 and ran a real policy scenario.
- **Findings** (`PRIMARY_OFFICIAL` - executed locally, output captured):
  - PGlite 0.5.8 reports `PostgreSQL 18.3 ... on wasm32-unknown-emscripten`. It is real
    Postgres compiled to WASM, not an emulation layer.
  - `CREATE ROLE`, `SET ROLE`, `RESET ROLE`, `GRANT`, `ENABLE/FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY`, and `current_setting('...', true)` all work.
  - Verified positive isolation: with `app.uid='alice'` the app role saw only Alice's row; with
    `app.uid='bob'` only Bob's row.
  - Verified negative case: `INSERT` with no `FOR INSERT` policy was rejected with
    _"new row violates row-level security policy"_.
  - **Critical caveat confirmed empirically**: querying as the default `postgres` role returned
    all rows even with `FORCE ROW LEVEL SECURITY`, because superusers bypass RLS entirely. This
    is the classic false-confidence trap described in the RLS literature
    (`AUTHORITATIVE_SECONDARY`, Bytebase "Postgres Row-Level Security Footguns").
- **Decision**: Use PGlite as the migration + authorization test harness. **All authorization
  tests must run under a dedicated non-superuser role** (`kynviora_app`) via `SET ROLE`; a
  harness guard asserts the test session is not a superuser and not the table owner, so a
  misconfigured test fails loudly instead of passing vacuously. See `DEC-004` and `DEC-005`.
- **Limitation**: PGlite is single-connection and lacks some extensions. It validates schema,
  constraints, and RLS logic - it does not validate managed-Postgres/Supabase-specific
  behaviour, connection pooling, or performance under load. Production parity remains
  unverified (`BLK-001`).

## R-004 - EU cosmetics regulatory structure and a verifiable Lens fixture

- **Question**: The Global Regulatory Lens needs at least one genuinely different, correctly
  _conditional_ cross-jurisdiction case that is not simplifiable to "banned"
  (`03_MVP_DEFINITION.md` demo step 9; `19` fixture requirements).
- **Date**: 2026-08-29
- **Findings**:
  - Legal instrument: **Regulation (EC) No 1223/2009** on cosmetic products. Annex II =
    prohibited substances; Annex III = restricted substances with conditions; Annex V =
    permitted preservatives (a positive list) (`PRIMARY_OFFICIAL`, EUR-Lex CELEX:32009R1223,
    cited in `26_EXTERNAL_REFERENCES.md`).
  - **Salicylic acid** sits at **Annex III entry 98**: permitted for non-preservative purposes
    up to **3.0% in rinse-off hair products** and **2.0% in other products**, with additional
    conditions - not in oral products, not in applications leading to lung exposure by
    inhalation, and not in products for **children under 3 years** (with stated exceptions such
    as body lotion, eye shadow, mascara, eyeliner, lipstick, roll-on deodorant). Separately it
    appears in **Annex V entry 3** as a preservative at **0.5%**.
    (Search summary consolidating legislation.gov.uk/eur/2009/1223/annex/III, EUR-Lex
    32019R1966, and COSlaw - **needs primary verification**, see below.)
  - The European Commission states **CosIng is informational and not legally binding**; the
    Regulation and its Annexes establish legal use conditions (`PRIMARY_OFFICIAL`, restated in
    `25_SOURCE_REGISTRY_AND_COVERAGE.md`).
- **Why salicylic acid is the right fixture**: it exercises `RESTRICTED` +
  `CONCENTRATION_LIMIT` + `USE_CONDITION` (rinse-off vs leave-on) + `AGE_OR_ROUTE_CONDITION`
  (under 3, inhalation, oral) **simultaneously** - which is exactly the multi-status case the
  domain model requires and the case that must never collapse to "banned". Because ingredient
  declarations rarely disclose concentration, it also naturally produces the
  `CONDITION_UNKNOWN` applicability state required by the `03` demo scenario.
- **Verification status**: `NEEDS_PRIMARY_VERIFICATION`. A direct fetch of
  `legislation.gov.uk/eur/2009/1223/annex/III` returned no extractable content through the
  available fetch tool, so the entry-98 conditions above rest on a search-result summary, not on
  a retrieved official document.
- **Decision**: Encode salicylic acid as a **fixture** for engine and UI tests, carrying
  `review_state = REVIEW_REQUIRED` and `verification = NEEDS_PRIMARY_VERIFICATION`. The Citation
  Gate must **reject** it for publication as trusted regulatory truth until an official snapshot
  is retrieved and a qualified reviewer approves it. This is enforced by a test, not by
  convention. See `DEV-001` and `BLK-004`.

## R-005 - United States cosmetics: the "absence is not approval" case

- **Question**: What does the US actually prohibit/restrict in cosmetics, and how must the Lens
  render the far more common "no matched rule" case?
- **Date**: 2026-08-29
- **Findings**:
  - FDA prohibits four halogenated salicylanilides - tribromsalan (TBS), dibromsalan (DBS),
    metabromsalan (MBS), tetrachlorosalicylanilide (TCSA) - at **21 CFR 700.15**.
  - **Mercury** at **21 CFR 700.13**: prohibited except trace amounts below 1 ppm, and except as
    an eye-area preservative up to 65 ppm.
  - **Methylene chloride** at **21 CFR 700.19**: a cosmetic containing it is deemed adulterated.
  - **Hexachlorophene**: not permitted where normal use applies it to mucous membranes; other
    cosmetic uses limited to no more than 0.1%.
  - FDA's own position is that cosmetics (apart from colour additives and specific
    prohibited/restricted ingredients) are **not FDA-approved before marketing** - "FDA-regulated,
    not FDA-approved" (`PRIMARY_OFFICIAL` position, restated in `25`/`26`).
  - **Salicylic acid has no matched US cosmetic prohibition.** (It is separately an OTC drug
    monograph acne active - a different regulatory framework, which is itself a useful
    illustration that frameworks do not map one-to-one.)
- **Why this matters to the build**: US + salicylic acid is the canonical
  `NO_MATCHED_RULE_WITHIN_COVERAGE` case. Rendering it as "permitted", "approved", "safe", or a
  green tick would be a **release-blocking misleading-simplification defect** per `24` and the
  guardrail metric in `22`. The engine must attach the coverage statement and the explicit
  "this is not FDA approval" limitation to this status.
- **Verification status**: the four halogenated salicylanilides, the mercury limits, and the
  CFR part numbers came from a search summary over eCFR/CIR material -
  `NEEDS_PRIMARY_VERIFICATION` before any publication. The direct FDA URL listed in
  `26_EXTERNAL_REFERENCES.md`
  (`fda.gov/cosmetics/cosmetics-laws-regulations/prohibited-restricted-ingredients-cosmetics`)
  returned **HTTP 404** on 2026-08-29 - the reference index is already stale, which is itself
  evidence for why source-freshness monitoring is a safety requirement (`20`).
- **Decision**: Same as R-004 - encode as `REVIEW_REQUIRED` fixtures, blocked at the Citation
  Gate. Record the dead FDA URL as a source-registry health finding (`BLK-004`).

## R-006 - GB / NI divergence

- **Question**: `D-013` requires GB and NI to be separate jurisdictions. Is that a real legal
  distinction or defensive over-modelling?
- **Date**: 2026-08-29
- **Findings**: Real. EU Regulation 1223/2009 was retained in GB domestic law after EU exit and
  GB can now diverge from subsequent EU amendments, while Northern Ireland continues to apply
  the EU Cosmetics Regulation under the Windsor Framework. GOV.UK publishes separate GB and NI
  guidance from a single landing page, and `legislation.gov.uk` hosts the retained GB version of
  the Regulation separately from the live EU text on EUR-Lex
  (`AUTHORITATIVE_SECONDARY`, GOV.UK/legislation.gov.uk, consistent with `25` and `26`).
- **Consequence**: A GB record and an NI record can legitimately show **different effective
  dates for the same substance** once the EU adopts an amendment that GB has not adopted. The
  data model therefore cannot store a single "UK" status, and copying a GB status into NI (or
  vice versa) without source-backed equivalence is a defect. Enforced by test.
- **Decision**: Jurisdiction is a closed enum including both `GB` and `NI` with no `UK` member,
  so the mistake is unrepresentable rather than merely discouraged. See `DEC-008`.

## R-007 - Identity and normalization sources

- **Question**: Which product-identity and substance-normalization sources are usable in an MVP?
- **Date**: 2026-08-29
- **Findings** (from `25`/`26` plus vendor documentation):
  - **GS1 / Verified by GS1** - useful for GTIN, company prefix, and basic product identity.
    Explicitly **does not prove current formulation**. Access is commercial and requires an
    agreement; API/terms review is required before production use.
  - **PubChem PUG REST** - usable for chemical identifiers and synonyms (CID, CAS, IUPAC). It is
    a **normalization/reference** source and explicitly **not a legal-regulatory status source**.
    Rate limits apply.
  - **CosIng** - useful for INCI naming and EU ingredient context; informational only.
  - **RxNorm / DailyMed / openFDA** - US-centric medicine normalization. `26` warns directly
    that a US medicine label is **not** proof of an Indian marketed formulation. For an
    India-first launch these can support vocabulary but not Indian product identity.
- **Consequence for the build**: every one of these requires either a commercial agreement, a
  license review, or is jurisdictionally mismatched with the India-first launch. None can be
  wired to live credentials in this environment.
- **Decision**: Define provider **ports** (interfaces) with an explicit declared authority scope
  per provider, ship deterministic local/test adapters, and record the exact configuration each
  real provider will need. A provider adapter declares which fields it may assert
  (`identity` / `normalization` / `regulatory` / `discovery-only`); the resolver refuses to
  accept a field from a provider not authorised to assert it. See `DEC-014`, `BLK-003`.

## R-008 - India (CDSCO) source machine-readability

- **Question**: Can the India-first regulatory adapter consume CDSCO material programmatically?
- **Date**: 2026-08-29
- **Findings**: `25` and `26` both flag Indian sources as **fragmented formats** with
  per-source licensing, structure, update cadence, and machine-readability requiring individual
  review. CDSCO publishes cosmetics rules, alerts, and NSQ (not-of-standard-quality) /
  spurious-drug actions as web pages and PDFs rather than as a stable structured feed. `26`
  explicitly instructs evaluating "the exact current official alert/NSQ/quality/action pages and
  machine-readable behavior before adapter implementation".
- **Decision**: Do not guess at a CDSCO schema. Build the adapter framework
  (fetch -> snapshot -> checksum -> change detect -> parse -> candidate -> Citation Gate ->
  review) with a **replayable fixture adapter** that reads from stored synthetic documents, so
  the whole ingestion and recomputation pipeline is genuinely exercised and tested without
  fabricating a live CDSCO integration. Record as `BLK-004`.

---

## Open research questions (deferred, not blocking current work)

| ID    | Question                                                          | Blocks                          | Why deferred                                                                     |
| ----- | ----------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| RQ-01 | Exact CDSCO alert/NSQ page structure and update cadence           | live IN adapter                 | Needs sustained observation of a live source; framework is source-agnostic       |
| RQ-02 | Whether EUR-Lex permits snapshot retention vs derived-fields-only | source preservation policy      | Legal review, not a technical question (`BLK-005`)                               |
| RQ-03 | Licensable Indian medicine normalization vocabulary               | medicine canonicalization depth | Commercial agreement required (`BLK-003`)                                        |
| RQ-04 | OCR/multimodal provider selection and per-field accuracy          | capture provider choice         | Port defined; measurable only against a labelled dataset that does not yet exist |
| RQ-05 | Numeric release thresholds (`22`)                                 | Stage 9 release gates           | Explicitly a product/safety leadership decision, not an engineering one          |
