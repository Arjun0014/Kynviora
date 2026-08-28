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
- **Status**: OPEN
- **Blocks**: `04` Phase 0.1 exit criterion ("Android development build launches on
  emulator/device"); `14` release gate ("encrypted local storage validated"); `19` device E2E
  suite; MASVS local-storage testing.
- **Detail**: No Android SDK, emulator, or physical device is available here. `expo-sqlite` with
  SQLCipher requires `npx expo prebuild` and a development build; it cannot run in Expo Go, and
  encryption at rest cannot be demonstrated without a device.
- **Workaround in place**: the storage strategy is decided and documented (DEC-012, R-002); the
  key-management design (per-install random key from `expo-crypto`, held in `expo-secure-store`)
  is specified. No claim is made that encryption at rest has been verified.
- **To resolve**: install the Android SDK, run `npx expo prebuild` and a development build, then
  execute the local-storage MASTG checks.

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
  false-merge/false-split *logic* is tested exhaustively. What cannot be produced is a
  **measured rate** against real packages.
- **To resolve**: assemble a labelled dataset under an approved study design, then run the
  evaluation harness. Note `22` also requires product/safety leadership to assign the numeric
  accept/reject thresholds - an approval decision, not an engineering one.
