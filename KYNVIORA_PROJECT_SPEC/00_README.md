# Kynviora Project Documentation

Status: Rebuild specification
Last reviewed: 2026-08-29
Primary delivery assumption: Android-first, India-first, English-first

## Purpose

This directory is the source-of-truth documentation for rebuilding Kynviora from scratch.
The documents are intentionally split by responsibility so product, design, engineering,
security, clinical review, and operations can evolve without turning one file into an
unmaintainable master specification.

Kynviora is not being designed as another medication reminder or generic health-record app.
The MVP must prove the full Kynviora loop:

1. Capture and identify the exact medicine or personal-care product a person actually has.
2. Preserve the package/label evidence and record confidence for identity, formulation, market, and batch.
3. Reuse a versioned Living Catalog when the same formulation has already been observed; create a candidate formulation when it has not.
4. Normalize medicines and ingredients against seeded reference vocabularies without inventing missing facts.
5. Connect the exact item to the correct person's relevant health context.
6. Monitor trusted regulatory, label, product-action, and reviewed evidence sources.
7. Compare material regulatory status across supported jurisdictions without treating one jurisdiction as universally authoritative.
8. Match meaningful changes to the correct product/formulation/batch and, separately, to the correct person when personalization is allowed.
9. Explain what changed, how certain the match is, which jurisdiction applies, and what Kynviora can and cannot conclude.
10. Offer a safe, bounded next action without pretending to diagnose or prescribe.
11. Help the person or authorized caregiver resolve, document, or discuss the issue.

Everything in the MVP exists to make this loop credible.

## MVP promise

Kynviora helps families keep an accurate picture of the medicines and personal-care
products they use, understand when trusted safety information changes, and take the next
reasonable action with clear evidence and visible uncertainty.

## Core product pillars

- Exact-item identity instead of barcode-only certainty.
- A Living Catalog that grows from verified package observations while preserving formulation history and conflicts.
- A Global Regulatory Lens that distinguishes prohibition, restriction, concentration/use conditions, product actions, scientific opinions, and unknown coverage by jurisdiction.
- Medicines and personal-care products are both first-class MVP domains.
- Evidence strength is separate from action urgency.
- Safety conclusions come from reviewed sources, deterministic policy, and required human
  review - not from generative AI. Search-grounded models may discover or structure evidence,
  but the underlying source is the evidence.
- Uncertainty is shown, not hidden.
- Caregiver access is explicit, granular, revocable, and audited.
- Senior accessibility is a default requirement.
- Offline access protects daily care workflows during poor connectivity.
- Privacy and security are release requirements, not later enhancements.

## Document map

- `01_PRODUCT_VISION.md` - product purpose, users, promise, long-term direction, exclusions.
- `02_DIFFERENTIATION_AND_PRODUCT_PRINCIPLES.md` - what makes Kynviora meaningfully different.
- `03_MVP_DEFINITION.md` - exact MVP scope and what must be demonstrably working.
- `04_STAGES_AND_PHASES.md` - implementation stages, phases, expected outputs, and exit criteria.
- `05_NEW_IDEAS.md` - new product ideas and when they should be considered.
- `06_USER_JOURNEYS_AND_INFORMATION_ARCHITECTURE.md` - primary flows and navigation model.
- `07_DOMAIN_MODEL.md` - core entities, state, provenance, and lifecycle concepts.
- `08_PRODUCT_IDENTITY_AND_CATALOG.md` - medicine/personal-care identity, formulation, OCR, barcode, and catalog design.
- `09_SAFETY_WATCH_AND_EVIDENCE_MODEL.md` - evidence levels, matching, assessments, alerts, corrections.
- `10_CLINICAL_GOVERNANCE.md` - review roles, publication controls, safety incidents, and operating rules.
- `11_SYSTEM_ARCHITECTURE.md` - system boundaries and major architectural decisions.
- `12_MOBILE_ARCHITECTURE.md` - React Native/Expo client architecture and offline design.
- `13_BACKEND_API_AND_SYNC.md` - backend modules, API contracts, sync, queues, and storage.
- `14_SECURITY.md` - security requirements and release controls.
- `15_THREAT_MODEL.md` - prioritized threats, abuse cases, trust boundaries, and mitigations.
- `16_PRIVACY_CONSENT_AND_COMPLIANCE.md` - consent, minimization, deletion, retention, and compliance workflow.
- `17_AI_AND_AUTOMATION_POLICY.md` - where AI can assist and where it is prohibited.
- `18_ACCESSIBILITY_AND_CONTENT_DESIGN.md` - senior-first interaction, accessibility, and safety copy.
- `19_TESTING_AND_QUALITY_STRATEGY.md` - functional, safety, accessibility, security, and data-quality testing.
- `20_OBSERVABILITY_INCIDENTS_AND_OPERATIONS.md` - production health, source freshness, incidents, and runbooks.
- `21_RELEASE_ENVIRONMENTS_AND_CICD.md` - environments, CI/CD, signing, rollouts, and rollback.
- `22_METRICS_VALIDATION_AND_EXPERIMENTS.md` - product proof, safety metrics, guardrails, and validation plans.
- `23_DECISIONS_RISKS_AND_OPEN_QUESTIONS.md` - explicit decisions, risk register, and unresolved choices.
- `24_DEFINITION_OF_DONE.md` - cross-functional completion criteria for every feature.
- `25_SOURCE_REGISTRY_AND_COVERAGE.md` - operational source inventory and coverage disclosure model.
- `26_EXTERNAL_REFERENCES.md` - current official technical, security, platform, and policy references.

## Recommended reading order

For product and leadership:

1. `01_PRODUCT_VISION.md`
2. `02_DIFFERENTIATION_AND_PRODUCT_PRINCIPLES.md`
3. `03_MVP_DEFINITION.md`
4. `04_STAGES_AND_PHASES.md`
5. `22_METRICS_VALIDATION_AND_EXPERIMENTS.md`

For engineering:

1. `03_MVP_DEFINITION.md`
2. `07_DOMAIN_MODEL.md`
3. `11_SYSTEM_ARCHITECTURE.md`
4. `12_MOBILE_ARCHITECTURE.md`
5. `13_BACKEND_API_AND_SYNC.md`
6. `08_PRODUCT_IDENTITY_AND_CATALOG.md`
7. `09_SAFETY_WATCH_AND_EVIDENCE_MODEL.md`

For safety, privacy, and release review:

1. `09_SAFETY_WATCH_AND_EVIDENCE_MODEL.md`
2. `10_CLINICAL_GOVERNANCE.md`
3. `14_SECURITY.md`
4. `15_THREAT_MODEL.md`
5. `16_PRIVACY_CONSENT_AND_COMPLIANCE.md`
6. `19_TESTING_AND_QUALITY_STRATEGY.md`
7. `20_OBSERVABILITY_INCIDENTS_AND_OPERATIONS.md`

## Source-of-truth rules

If two documents disagree, use this precedence until the conflict is formally resolved:

1. Release-blocking safety, privacy, or security requirements.
2. Approved product decisions in `23_DECISIONS_RISKS_AND_OPEN_QUESTIONS.md`.
3. MVP scope in `03_MVP_DEFINITION.md`.
4. Domain and architecture contracts.
5. Roadmap/stage planning.
6. Idea backlog.

Do not silently resolve contradictions in code. Record the decision.

## Change discipline

Every material change should answer:

- What user or safety problem does this solve?
- Does it expand regulated or clinically sensitive behavior?
- Does it collect new sensitive data?
- Does it change the meaning of a safety conclusion?
- Does it need a new source, license, reviewer, threat-model entry, or test?
- Can the feature be remotely disabled or safely rolled back if it fails?

## Legal and clinical note

These documents define product and engineering intent. They are not legal advice, medical
advice, regulatory approval, clinical validation, or a claim that Kynviora is outside any
medical-device or health-software regulation. Classification and obligations must be reviewed
for the actual implemented features, claims, data flows, and launch jurisdictions.
