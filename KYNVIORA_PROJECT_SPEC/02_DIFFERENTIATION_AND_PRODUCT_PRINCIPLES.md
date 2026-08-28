# Differentiation and Product Principles

Status: Product decision document
Last reviewed: 2026-08-29

## Why Kynviora must not become another medical helper app

Many health apps already offer reminders, document storage, symptom tracking, pill lists,
appointments, or generic AI chat. Kynviora can include some of those capabilities, but they
are supporting infrastructure rather than the reason the product should exist.

The product is differentiated by continuously connecting exact product identity, personal
context, trusted evidence, and a safe action workflow.

## Differentiation pillars

### 1. Exact-item identity with visible confidence

A barcode match is not treated as perfect knowledge. Medicine strength, dosage form, market,
manufacturer, product variant, formulation, lot/batch, label date, and user evidence can all
matter.

Kynviora must distinguish:

- confirmed;
- probable;
- incomplete;
- conflicting;
- unverified.

The user sees that state.

### 2. Medicines and personal care in one safety model

The MVP supports both categories properly. They share a common ownership, evidence, identity,
and alert framework while retaining category-specific fields and rules.

This is important to the product story: real people do not organize daily exposure according
to software industry categories.

### 3. Evidence-change monitoring

Kynviora is not just a static database lookup. It should remember what was known when an item
was reviewed and surface meaningful changes later.

### 3A. Living Catalog that improves with real package evidence

Kynviora's product database is not a flat barcode cache. New packages can create candidate identities and formulations from user-confirmed label evidence. Repeated independent observations can corroborate the same formulation, while conflicts create a new formulation candidate instead of overwriting history.

The crowd can help establish **what a package says**. It cannot vote an ingredient or medicine into being safe.

### 3B. Global Regulatory Lens

For supported ingredients/products, Kynviora compares jurisdiction-specific regulatory treatment and shows the exact category of difference: prohibition, restriction, concentration/use condition, required warning, positive-list rule, product/batch action, scientific opinion, no matched rule, or unknown coverage.

India, the EU, Great Britain, Northern Ireland, the United States, and Japan are separate regulatory contexts. Great Britain and Northern Ireland must not be collapsed into one internal jurisdiction where their applicable cosmetic rules diverge.

The product must never label a country "strict" or "unsafe" as a shortcut, and must never interpret "no matched restriction" as regulator approval.

### 4. Personal relevance without pretending certainty

A safety record becomes useful only after Kynviora can explain why it may apply to this person
and this exact item. Personalization must use only confirmed or properly qualified profile
facts and reviewed rules.

### 5. Evidence strength and urgency are separate

A weak signal is not automatically an urgent warning. A strong official batch recall can be
urgent even though it does not require a complex research interpretation.

The product must never compress these concepts into one misleading universal score.

### 6. Family coordination with consent

Kynviora supports care relationships without making caregivers silent owners. Permissions are
granular, visible, revocable, and audited.

### 7. Explainability as product functionality

Every material safety state should answer:

- What changed?
- Why was I matched?
- How exact is the match?
- How strong is the evidence?
- What source and jurisdiction apply?
- What should I do next?
- What should I not infer from this alert?

### 8. A trustworthy "unknown"

"Insufficient data" is a valid product result. Kynviora should earn trust by refusing false
certainty.

## Product principles

### Safety before engagement

Do not optimize alert volume, streaks, fear, or screen time. Optimize correct understanding
and appropriate action.

### Evidence before claims

Every user-facing safety conclusion has provenance, effective dates, jurisdiction, evidence
classification, review state, and reproducible policy logic.

### The source of truth is never an LLM output

Generative AI and search-grounded research models may extract a label, reconcile synonyms, discover official documents, translate source material, compare amendments, or draft explanations. They cannot independently become the authority for product facts, legal/regulatory status, severity, diagnosis, or treatment advice.

A model answer is a discovery artifact. The underlying retained package image, official regulation, regulator notice, manufacturer evidence, or other approved source is the evidence.

### Confirmation before personalization

Low-confidence OCR, inferred ingredients, ambiguous barcodes, and uncertain medicine matches
must be confirmed before they drive high-impact personalization.

### Personal data belongs to the user relationship

Caregiver access is explicit. Sensitive sharing is purposeful. Data is not monetized through
behavioral advertising.

### Accessible by default

Older adults are a primary audience, so large text, clear focus, low cognitive burden,
TalkBack/VoiceOver semantics, readable safety language, and offline essentials are baseline
requirements.

### Coverage must be disclosed

Kynviora should say what it monitors and what it does not. Silence is not proof of safety.

### Corrections are first-class

Sources change, parsers fail, products are reformulated, and humans make mistakes. Every
assessment and alert must support correction, withdrawal, supersession, and audit history.

## What the MVP must prove to be differentiated

The MVP is successful only if a reviewer can see the following without being told to imagine
future capability:

1. Medicine and personal-care items both exist as rich, versioned records.
2. Two visually similar items can have different verification confidence.
3. The app distinguishes a generic product match from an exact formulation or batch match.
4. A reviewed safety event can be matched to one relevant user/item and not another.
5. The alert explains why the match occurred and what evidence supports it.
6. A correction to evidence or product identity changes the assessment reproducibly.
7. The user can resolve or annotate the issue.
8. A permitted caregiver can see the right information while a non-permitted caregiver cannot.
9. A newly captured product can become a reusable catalog candidate without exposing another user's personal health data.
10. A later scan can reuse the existing verified/corroborated formulation without repeating expensive research.
11. A formula conflict creates a new version/candidate and visibly requests verification instead of silently replacing the old formula.
12. The Global Regulatory Lens can show materially different treatment across supported jurisdictions with the exact official source and scope.
13. The doctor/pharmacist summary reflects current items and unresolved safety context.

## Anti-features

Do not build these as product shortcuts:

- a single universal "safety score";
- red/green product judgments without context;
- AI chat that produces independent medication advice;
- automatic diagnosis from uploaded records or symptoms;
- "natural equals safe" or "chemical-free" claims;
- unverified replacement-product recommendations;
- prescription substitution;
- hidden caregiver access;
- notifications that reveal sensitive details on the lock screen by default;
- a scanner that silently converts a public catalog result into a trusted formulation record.

## Design test for every new feature

Before accepting a feature, ask:

1. Does this strengthen identity, evidence, relevance, action, or care coordination?
2. Does it make Kynviora more trustworthy or merely larger?
3. Can the product explain the feature's result?
4. What happens when the data is missing or wrong?
5. What safety, privacy, security, and accessibility obligations does it create?
6. Does it belong in the MVP, or does it distract from proving the differentiating loop?
