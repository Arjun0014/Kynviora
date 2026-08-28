# Decisions, Risks, and Open Questions

Status: Living product/architecture decision register
Last reviewed: 2026-08-29

## Confirmed decisions for this rebuild

### D-001 - Rebuild from scratch

The new implementation should not copy old prototype structure by default. Prior work may
inform lessons, but every dependency/architecture decision is re-approved.

### D-002 - MVP includes medicines and personal care

Both are first-class domains. Personal care is not a future placeholder.

### D-003 - Safety Watch is the product differentiator

Reminder, Shelf, capture, caregiver, and Visit Pack features support the safety/evidence loop.

### D-004 - Exact identity confidence is visible

Barcode/catalog success alone does not equal verified formula/batch.

### D-005 - Evidence and urgency are separate dimensions

No universal product safety score.

### D-006 - AI is non-authoritative for safety

No autonomous severity, diagnosis, medication change, or alert publication.

### D-007 - Android-first, cross-platform architecture

Use React Native/Expo with iOS-capable boundaries while validating Android first.

### D-008 - India-first current launch assumption

Source, legal, localization, and policy work should use India as the initial operational
jurisdiction unless product leadership changes this before source implementation.

### D-009 - Modular monolith backend first

Use clear modules/workers before microservices.

### D-010 - Living Catalog bootstrap model

The shared product/formulation catalog may start sparse/near-empty and grow through confirmed package observations. Canonical ingredient/medicine vocabularies, regulatory sources, and reviewed safety rules are seeded independently and do **not** rely on crowd consensus.

### D-011 - Cache-first, source-grounded AI fallback

Known formulations resolve from Kynviora/provider data first. AI/research runs on unresolved/conflicting cases. Model memory/answer text is not source evidence; underlying allowed sources and package evidence are required.

### D-012 - Global Regulatory Lens is MVP scope

Initial regulatory adapter targets: India, EU, Great Britain, Northern Ireland, United States, Japan. The Lens is informational/regulatory transparency and is separate from personalized Safety Watch conclusions.

### D-013 - GB and NI are separate jurisdictions

Do not store one generic UK cosmetics status when applicable legal frameworks can diverge.

### D-014 - Absence is not approval

`NO_MATCHED_RULE_WITHIN_COVERAGE` and `UNKNOWN` are first-class states. Neither may be presented as legal approval, universal safety, or regulator endorsement.

### D-015 - Citation Gate required for shared regulatory facts

Search/LLM extraction may produce candidates, but shared regulatory publication requires source authority, exact scope/conditions, traceable official evidence, dates/version, canonical mapping, validation, and required review.

## Critical risks

| Risk | Impact | Initial mitigation | Owner |
| --- | --- | --- | --- |
| Wrong medicine/product match | False/missed safety relevance | confidence, market/formula/batch evidence, confirmation | Data/Product |
| Missing source coverage | False reassurance | coverage disclosure, source registry, freshness monitoring | Safety Ops |
| Personal-care formula drift | Wrong ingredient result | label versioning, rescans, formula confidence | Product/Data |
| Unsafe medication interpretation | User changes treatment incorrectly | constrained copy, clinical review, no autonomous stop/start | Clinical |
| Alert fatigue | Important alerts ignored | urgency/evidence separation, dedupe, digest | Product/Safety |
| Caregiver privacy abuse | Surveillance/unauthorized access | granular grants, audit, revocation | Privacy/Security |
| Reviewer compromise | Harmful publication | strong auth, least privilege, approval separation | Security/Safety |
| AI prompt injection/hallucination | Incorrect stored/published claims | non-authoritative AI boundary, source verification | AI/Security |
| OCR error | Wrong formula/medicine fields | field confidence, confirmation, raw evidence | Data/UX |
| Source parser failure | Missed/corrupt alerts | quarantine, health dashboard, fixtures | Safety Ops |
| Regulatory scope changes | Delay/reclassification | claims review, jurisdiction counsel | Legal/Product |
| Catalog poisoning/correlated fake observations | Wrong shared formula affects many users | candidate-only writes, independence/duplicate checks, review, external verification | Data/Security |
| LLM/search fabricates product/regulatory fact | False shared truth/legal claim | source-grounded retrieval, Citation Gate, no direct publication tools | AI/Safety Ops |
| Regulatory condition simplified incorrectly | "restricted" shown as "banned" or limit omitted | structured conditions, reviewed fixtures, legal-scope review | Regulatory/Product |
| Foreign regulation interpreted as local illegality/harm | Fear/unsafe action/legal misstatement | informational default, jurisdiction copy, comprehension testing | Product/Regulatory |
| Source licensing/redistribution conflict | Forced data removal or legal exposure | source registry legal review, store references/derived facts only as allowed | Legal/Data |
| MVP scope growth | Delayed proof of value | roadmap gates, idea backlog separate | Product |
| Local data encryption failure | Sensitive exposure/data loss | reviewed encrypted DB + recovery testing | Security/Mobile |
| Commercial conflict | Biased recommendation | no safety ranking sponsorship | Product/Legal |

## Decisions required before Stage 1 completion

- Primary authentication UX: email/password, email OTP, passkey-enabled flow, or approved
  combination.
- Account recovery model suitable for older adults.
- Production backend region/data-residency approach.
- Named privacy/security owner.

## Decisions required before Stage 3 completion

- Commercial/official medicine identity strategy for India.
- Personal-care identity sources and allowed licensing/use.
- OCR + multimodal extraction provider/hybrid strategy.
- Search-grounded research provider strategy and budget/rate limits.
- Evidence-image retention defaults and shared-catalog contribution privacy model.
- Corroboration policy: what qualifies as an independent observation and when a candidate becomes corroborated.
- Formulation-fingerprint algorithm/versioning approach.

## Decisions required before Stage 5 completion

- Exact personal-care categories in beta.
- First approved sensitivity/allergy vocabulary.
- Clinical/product-safety reviewer organization and credentials.
- Formula review/correction operating process.

## Decisions required before Stage 6 completion

- First official India source set.
- Exact initial EU, GB, NI, US, and Japan Global Regulatory Lens source adapters.
- Legal/source authority hierarchy and Citation Gate approval policy.
- Which regulatory statuses/conditions are supported in the first Lens release.
- Source update targets.
- Evidence-level definitions formally approved by reviewers.
- High-impact approval separation.
- Rule review/expiry intervals.
- User correction response expectations.

## Decisions required before Stage 9 beta

- Numeric release thresholds in metrics document.
- Exact retention schedule.
- Legal/regulatory classification opinion for implemented feature set.
- Play Store declarations and claims.
- Incident/on-call staffing.
- Public support/security contact.
- Beta cohort/consent model.

## Open product questions

- Should MVP personal care focus on skin care + sunscreen + oral care first, or include
  shampoo/body products from day one?
- Which profile facts are necessary for the first reviewed rules and which can be deferred?
- How much product verification work will users tolerate before the value becomes obvious?
- What is the best label for "no current matched alert" that users do not misread as "safe"?
- How much evidence detail should appear on the first alert screen versus deeper layers?
- Should caregiver grants expire by default or only optionally?
- Which Review Inbox tasks should be automatic versus user-created?

## Open data/regulatory questions

- Which canonical ingredient identifiers are licensed/appropriate for persistent use?
- Which commercial barcode/product provider materially improves India coverage beyond user package evidence?
- What source terms permit storing snapshots versus derived fields/references?
- What is the regulatory review SLA for new/changed jurisdiction records?
- How should historical regulation timelines be reconstructed when official consolidated text hides intermediate versions?
- What threshold/conditions require mandatory human review rather than deterministic publication?

## Open technical questions

- Exact encrypted SQLite solution under Expo SDK 57.
- API implementation style around Supabase/Edge Functions/service layer.
- Queue technology and retry semantics.
- Search/index need before MVP.
- OCR image-processing pipeline.
- Source document preservation/storage/licensing limits.
- Admin/reviewer console technology.

## Open business questions

- Consumer-only launch versus pharmacy/clinic partnership pilot.
- Family subscription packaging.
- Whether safety monitoring remains free as a trust/basic-safety layer.
- How catalog/provider costs scale per active item.
- Whether professional review cost supports the desired alert coverage/latency.

## Decision record format

When closing an open decision, record:

- ID/date;
- decision;
- owner/approvers;
- options considered;
- why chosen;
- safety/privacy/security impact;
- migration/reversal cost;
- review trigger/date.
