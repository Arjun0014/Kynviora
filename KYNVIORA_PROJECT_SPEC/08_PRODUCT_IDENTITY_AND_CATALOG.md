# Product Identity and Living Catalog

Status: Data/product architecture contract
Last reviewed: 2026-08-29

## Objective

Kynviora must know **what it knows, how it knows it, and when the evidence may no longer apply**. Product identification is therefore a provenance/versioning problem rather than a barcode lookup or an LLM question.

The shared product catalog may begin sparse/near-empty. It should become more useful as verified package observations accumulate, while canonical medicine/ingredient vocabularies and regulatory/safety sources are seeded independently.

## Data layers that must remain separate

1. Commercial product identity - brand/product concept.
2. Marketed variant - country/market/package-specific identity.
3. Formulation - medicine strength/form or personal-care ingredient version.
4. Batch/lot - manufacturing scope where available.
5. Product observation - what a real package showed at a particular time/market.
6. Owned item - the item a specific profile uses.
7. Catalog evidence - package/provider/manufacturer evidence supporting fields.
8. Regulatory/safety knowledge - maintained separately; a catalog observation cannot create it.

A match at one layer never proves all lower layers.

## Bootstrap strategy

### What can start sparse

- shared commercial product records;
- formulation records;
- market/package observations.

### What must be seeded before safety use

- canonical ingredient/substance vocabulary needed by MVP rules;
- medicine normalization/reference vocabulary needed by MVP medicine flows;
- units/forms/identifier dictionaries;
- approved source registry;
- initial regulatory source adapters;
- reviewed safety rules.

This gives Kynviora the economics of a growing catalog without making early users responsible for inventing the medical/regulatory knowledge base.

## Barcode rules

- Validate supported GTIN/UPC/EAN formats and check digits.
- Record symbology/source.
- Use a dedicated barcode decoder.
- Never treat barcode as proof of formula, batch, expiry, or current label.
- Preserve market and evidence context because a barcode may persist across formulation/packaging changes.
- Support manual fallback.

## Guided package capture

For unknown/uncertain products, guide the user through the evidence actually required rather than accepting one arbitrary photo. Typical personal-care capture:

1. front/main panel;
2. ingredient declaration;
3. barcode + manufacturer/marketer/regulatory information when separate;
4. batch/MFG/expiry area when applicable.

Medicines use an equivalent category-specific set for brand/generic, strength, dosage form, manufacturer/marketer, pack, batch/expiry, and written directions where relevant.

### Quality gate

Before expensive model processing, check for:

- blur;
- glare/overexposure;
- crop/edge loss;
- orientation;
- minimum text readability;
- duplicate images.

Unreadable fields should trigger a retake/manual path, not a guess.

## Extraction architecture

Use complementary mechanisms:

- dedicated barcode decoder;
- conventional OCR/document text extraction;
- structured multimodal model extraction;
- deterministic field validators.

For important fields, independent disagreement is a confidence signal. Examples:

- OCR and vision model agree -> confidence may rise subject to validation;
- OCR and vision model disagree -> require reprocessing/user confirmation;
- date fails deterministic validation -> reject candidate;
- medicine strength/unit is malformed -> reject/confirm;
- ingredient normalization is ambiguous -> keep unresolved.

### Field-level provenance

Each candidate field should be a `FieldAssertion` with:

- raw/normalized value;
- source asset/provider;
- source image region/text location when available;
- extractor/model/parser version;
- confidence;
- deterministic validation result;
- user/reviewer confirmation state;
- supersession history.

The user-facing structured UI is generated from these fields. Do not store an LLM paragraph as the hidden product record.

## Cache-first resolver

Recommended sequence:

1. Kynviora Living Catalog.
2. Approved licensed/official product identity provider.
3. Approved manufacturer/retailer evidence.
4. Legally approved public/community discovery data.
5. Source-grounded research agent for discovery/reconciliation when needed.
6. User-confirmed/manual unresolved path.

Provider/model credentials remain server-side.

### Research fallback rule

A web-enabled model or research system may search for candidate product identity/formulation evidence, but:

- model memory is not a source;
- a generated answer is not evidence;
- the returned underlying source must be independently fetched/validated where possible;
- manufacturer/regulator/approved provider evidence outranks generic web pages;
- fields remain candidate/unverified if evidence is missing or conflicting.

This allows Perplexity-style or other research models to reduce human search work without becoming Kynviora's source of truth.

## Medicine identity

Minimum exact-match target:

- brand when applicable;
- normalized active/generic ingredient;
- strength;
- dosage form;
- manufacturer/marketer;
- market;
- pack/product identifier;
- batch/lot and expiry where available.

A result missing material strength/form information is not an exact medicine match.

## Personal-care identity

Minimum target:

- brand;
- product name/variant;
- category;
- manufacturer/marketer;
- market;
- package/identifier;
- ingredient declaration;
- formulation version/observation;
- batch/lot/expiry where applicable.

"Product identity confirmed" and "formula confirmed" remain separate states.

## Ingredient/substance normalization

Store the original declaration and ordering. Canonical mapping may use approved reference systems such as INCI terminology and chemical identifiers where appropriate.

For each mapping retain:

- raw label term;
- parsed term;
- normalized substance ID;
- preferred/INCI name where available;
- CAS/EC/PubChem/other identifier where appropriate;
- alias/synonym provenance;
- confidence/review state;
- normalization version.

An LLM may propose a mapping but cannot invent/confirm a canonical identity without validation.

## Formulation fingerprint

Create a deterministic fingerprint from material fields used for candidate matching, for example:

- normalized ingredient list/order for personal care;
- active ingredients + strength + dosage form for medicine;
- market;
- manufacturer/variant context where required.

The fingerprint is not a cryptographic proof that two physical products are identical. It is a fast signal for "these observations appear to describe the same formulation."

Store fingerprint version so the algorithm can evolve without rewriting history.

## Living Catalog lifecycle

Suggested shared-state progression:

1. `CANDIDATE` - one unreviewed/limited observation.
2. `USER_CONFIRMED` - package facts confirmed by the contributing user.
3. `CORROBORATED` - sufficiently consistent independent observations support the same formulation under policy.
4. `EXTERNALLY_VERIFIED` - approved manufacturer/authoritative/provider evidence supports it.
5. `CONFLICTING` - material disagreement remains unresolved.
6. `RETIRED` - historical formulation no longer treated as current candidate for new packages.

Confidence transitions must be policy-driven. Do not expose a fake mathematical certainty score simply because many users submitted the same record.

## Independent corroboration

Repeated observations can verify **what labels/packages say**. They cannot determine health safety.

Corroboration controls should consider:

- independence of observations;
- duplicate/perceptual-image detection;
- market/time distribution;
- barcode/brand/manufacturer consistency;
- exact normalized formulation match;
- suspicious account/device patterns;
- external evidence when available.

Raw user identities and health profiles are never exposed as catalog corroboration evidence to other users.

## Formulation conflict and change detection

If a new observation has the same apparent product/GTIN but a materially different formula/strength/form:

1. do not overwrite the old formulation;
2. re-run extraction on the relevant region;
3. compare independent OCR/vision outputs;
4. compare approved manufacturer/provider evidence;
5. compare other recent observations from the same market;
6. create a separate candidate formulation/conflict;
7. record first-seen/last-seen dates;
8. review/current-formula status according to policy;
9. recompute affected assessments only when their referenced inputs change.

This is the foundation for Formula Change Watch and Evidence/Formula Diff.

## User corrections versus shared corrections

- A user may correct their own owned-item assertion after confirmation.
- A user report against the shared catalog creates a correction candidate.
- One user cannot directly rewrite global shared catalog truth.
- Shared merge/split/formulation correction requires policy/review/corroboration appropriate to impact.

## Product Trust Passport

Derived sections:

- Identity: confirmed/probable/unverified.
- Formula/strength: confirmed/partial/conflicting/unverified.
- Observation state: single package/corroborated/externally verified.
- Batch: confirmed/missing/not applicable.
- Evidence: package/provider/manufacturer/reviewer classes.
- Market and formulation version.
- First/last observed.
- Last reviewed.
- Last safety/regulatory check.
- Coverage statement.

Do not turn these into one universal safety score.

## Shared catalog privacy boundary

The shared catalog stores product/formulation knowledge, not the fact that a named person uses that product. Separate catalog observations from profile ownership. Raw user-contributed package images are private/internal evidence by default and are not exposed to other users unless a separately reviewed explicit sharing model exists. Remove unnecessary metadata and minimize contributor linkage.

## Cost model and caching

The economic goal is for expensive extraction/research calls to become exceptions as coverage grows. Track:

- Living Catalog hit rate;
- exact formulation hit rate;
- research/model fallback rate;
- new formulation rate;
- conflict/reverification rate;
- average processing cost per unknown product versus known product;
- provider/model cost by category/market.

Do not describe cost decline as guaranteed exponential decay; long-tail products, reformulations, and regional variants persist.

## Data-quality metrics

Track separately for medicines and personal care:

- exact identity precision/recall;
- strength/form precision;
- market-variant precision;
- formulation verification rate;
- fingerprint false-match/false-split rate;
- batch capture/match rate;
- OCR field error rate;
- multimodal field error rate;
- OCR/model disagreement rate;
- unresolved rate;
- user-correction rate;
- catalog conflict rate;
- corroboration false-positive rate;
- time from first observation to corroborated/external verification;
- cache-hit and fallback-research rates.

Coverage must be reported by category and market, not as one global percentage.
