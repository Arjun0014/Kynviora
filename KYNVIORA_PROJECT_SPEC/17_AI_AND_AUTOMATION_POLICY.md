# AI, Research Agents, and Automation Policy

Status: Product/safety architecture policy
Last reviewed: 2026-08-29

## Principle

AI reduces manual work; it does not become the authority for product truth, legal/regulatory status, or health/safety conclusions. Kynviora trusts retained package evidence, approved external sources, deterministic validation/policy, and required human review.

A useful shorthand:

> **Models can propose. Sources and validated records prove. Rules/review decide.**

## Allowed AI-assisted uses

Subject to privacy/security/source-policy review:

- structured extraction from product/package images;
- OCR reconciliation;
- product/entity candidate recognition;
- ingredient/medicine synonym candidate mapping;
- web/source discovery for unknown products;
- web/source discovery for regulatory changes;
- translation of official material for reviewer assistance;
- extraction of candidate legal conditions, concentration limits, product types, dates, and references;
- comparison of old/new regulatory amendments;
- document classification/deduplication;
- literature relevance triage;
- draft plain-language explanation from approved structured facts;
- Evidence/Regulatory Diff summarization;
- support-ticket classification;
- synthetic test-fixture generation reviewed before use.

## Product research boundary

A top multimodal/search model may help answer "what product might this be?" or "where is an official ingredient list/manufacturer page?" but Kynviora must not store:

> "Model X says this product contains Y"

as the source of truth.

Instead:

1. model returns structured candidate facts plus underlying sources/evidence;
2. backend retrieves/validates allowed sources when applicable;
3. package/photo evidence remains independently available;
4. field assertions retain source and confidence;
5. user/reviewer/deterministic checks confirm material facts;
6. only then can the shared catalog state advance.

Model memory without a traceable source is insufficient for shared product facts.

## Dual extraction requirement for critical package fields

For safety-relevant fields such as ingredient declarations, active ingredients, strength, batch, manufacturing/expiry dates, use complementary mechanisms where feasible:

- conventional OCR/document extraction;
- structured multimodal model extraction;
- deterministic validation.

Agreement is evidence of extraction consistency, not absolute truth. Disagreement should trigger re-extraction/user confirmation, not model arbitration by confidence alone.

## Search-grounded research systems such as Perplexity-style tools

They are useful for:

- finding official regulator pages/PDFs;
- locating manufacturer evidence;
- discovering a changed regulation;
- tracing synonyms/CAS/INCI names across sources;
- finding an amendment that supersedes an older rule.

Their answer text is **not** a Kynviora source. The underlying official/approved material must be independently recorded/validated.

## Citation Gate for regulatory facts

Before a model-extracted regulatory candidate becomes shared truth, require:

- canonical substance/product match;
- jurisdiction;
- source authority/class;
- exact status;
- exact conditions/thresholds;
- effective/publication date;
- legal/notice reference where available;
- retained source/reference/checksum/version where allowed;
- traceable source location/context;
- schema/deterministic validation;
- required human/regulatory review.

If the source does not support a field, the model must not fill it.

## Conditionally allowed uses

Require strict schema and validation/review:

- ingredient normalization suggestions;
- medicine name/strength extraction;
- legal/regulatory status candidate extraction;
- translation affecting legal conditions;
- source claim extraction;
- product formula reconciliation;
- user free-text summarization for Visit Pack.

## Prohibited autonomous uses

AI cannot independently:

- diagnose;
- infer a new medical condition as confirmed fact;
- set evidence level or action urgency;
- publish/withdraw a safety alert;
- tell a user to start/stop/replace prescription medicine;
- recommend prescription substitution;
- declare a product universally safe/unsafe;
- declare an ingredient legally prohibited/restricted without validated source evidence;
- interpret "no matched rule" as "approved";
- invent product identity/formulation/batch/ingredient;
- invent/repair citations;
- directly write shared catalog/regulatory truth from a user prompt;
- resolve caregiver authorization;
- override rule/reviewer requirements.

## Structured processing boundary

Preferred flow:

1. Untrusted image/source enters isolated processing.
2. Model proposes structured candidates.
3. Schema validation.
4. Provenance attaches candidates to exact evidence/source.
5. Deterministic validators run.
6. User/human confirmation where required.
7. Catalog/regulatory candidate enters controlled lifecycle.
8. Reviewed deterministic safety rule creates assessment where applicable.
9. Publication policy/review controls user visibility.

Never parse a previously generated model paragraph later as the hidden source of truth.

## Prompt injection defense

Treat every uploaded package, PDF, webpage, regulatory document, and search result as untrusted data that may contain instructions to the model.

Controls:

- separate system/policy instructions from document content;
- least-privileged tools;
- no direct publish/write authority for research/extraction agents;
- allowlisted/validated network destinations where appropriate;
- no unnecessary secret access;
- structured outputs;
- independent source fetching/verification;
- reviewers inspect source evidence;
- high-impact decisions remain deterministic/human-controlled.

## Cost and caching policy

AI/research should not run on every lookup if the same trusted/corroborated formulation already exists.

Track and optimize:

- cache-hit rate;
- unknown-product rate;
- model fallback rate;
- average token/provider cost per new product;
- repeated-research suppression;
- abuse/budget limits.

The catalog may reduce average cost significantly with adoption, but long-tail products and reformulations mean cost never goes to zero.

## User-facing AI transparency

Do not say "AI verified this product" or "AI says this ingredient is banned." Attribute final facts to package evidence, regulator, manufacturer, provider, or reviewed Kynviora policy. Model assistance can be disclosed in methodology/help where useful.

## Model/data privacy

Before sending user data to a provider:

- minimize fields;
- remove unnecessary identifiers/metadata;
- review retention/training terms;
- configure no-training/no-retention where required/available;
- document processors/regions;
- obtain needed notice/consent;
- avoid sending profile health context for product/regulatory research that does not require it.

## AI evaluation

Evaluate by workflow, not generic model reputation:

- package-field extraction precision/recall;
- hallucinated field rate;
- abstention;
- OCR/model disagreement;
- low-quality/glare labels;
- regional brands/medicine names;
- multilingual labels;
- synonym/canonical mapping accuracy;
- regulatory condition extraction accuracy;
- translation preservation of concentration/negation/age/use conditions;
- fake/missing citation rate;
- prompt injection resistance;
- behavior after model version changes.

A model/provider version change is a production dependency change and may require revalidation.

## Kill switches

Independently disable/fallback:

- package multimodal extraction;
- research-agent discovery;
- regulatory AI extraction;
- auto-normalization suggestions;
- AI explanation drafting.

Disabling AI must not disable access to existing trusted catalog/regulatory/safety records.
