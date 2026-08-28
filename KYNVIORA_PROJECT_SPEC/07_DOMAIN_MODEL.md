# Domain Model

Status: Architecture contract
Last reviewed: 2026-08-29

## Domain rules

Every durable entity uses a non-guessable ID, timestamps, version/revision, lifecycle state, and provenance where the value can affect safety, regulation display, catalog sharing, or access. Safety-sensitive and regulatory historical inputs are versioned rather than overwritten.

The model deliberately separates **what a package says**, **what a regulator says**, **what Kynviora concludes**, and **what a person uses**. Those are different facts with different authority.

## Identity and access domain

### User
Authenticated account identity, assurance level, sessions, and account lifecycle.

### Household
Container for profiles and access relationships. Household membership is not automatic permission to read every profile.

### Profile
Person whose products/care data are organized.

### CaregiverGrant
Explicit authorization linking a user to profiles/capabilities such as VIEW_SAFETY, VIEW_SHELF, MANAGE_SHELF, VIEW_MEDICINES, MANAGE_MEDICINES, VIEW_CARE, MANAGE_CARE, VIEW_DOCUMENTS, EXPORT_SUMMARY, RECEIVE_MISSED_DOSE, and MANAGE_CAREGIVERS.

### ConsentReceipt
Versioned purpose, policy, locale, actor, time, and withdrawal record.

### AuditEvent
Append-only security/safety/regulatory publication event for privileged actions.

## Profile context domain

### AllergyOrSensitivityRecord
Stores the user-facing term, normalized concept when available, provenance, certainty, noted date, last reviewed date, and optional supporting evidence.

### ConditionRecord
MVP stores only conditions needed for approved workflows. User-reported information is never silently promoted to clinician-confirmed status.

### EmergencyProfileSummary
User-selected offline/emergency projection; not an unrestricted public record.

## User-owned item domain

### OwnedItem
Links a profile to the medicine/personal-care item they use. Key fields include profile_id, item_kind, started/stopped dates, active state, notes, last reviewed, and verification summary.

### ProductUsageEvidence
Links the owned item to the package/formulation/batch evidence the user confirmed. This is distinct from the shared catalog observation so changing shared catalog knowledge does not silently change what package the user actually recorded.

## Living Catalog domain

### ProductIdentity
Commercial identity independent of a user's ownership: brand, display name, manufacturer/marketer, category, identifiers, and market scope.

### MarketedFormulation
Versioned market-specific medicine strength/form or personal-care ingredient declaration. Multiple formulations may coexist under one product identity.

### BatchOrLot
Normalized batch/lot information attached to the relevant product/formulation context.

### CaptureSession
A guided package-capture session with requested panels, quality status, device/app processing versions, and completion state.

### ProductEvidenceAsset
Front label, ingredient/active panel, barcode/manufacturer panel, batch/date image, prescription/label evidence, or approved external product evidence. Includes access scope, purpose, capture/source time, processing state, retention/deletion state, and security validation state.

### ExtractionRun
One OCR/vision/parser execution over an evidence asset. Stores engine/model version, schema version, processing metadata, and candidate outputs. Model output itself is not shared catalog truth.

### FieldAssertion
Provenance-bearing claim for one field. Stores field path, candidate/confirmed value, source asset/provider, source region/reference where available, confidence, extractor/actor, confirmation state, and supersession relation.

### ProductObservation
An observation that a particular package/formulation was seen in a market at a time, derived from confirmed evidence. It may be tied privately to a user submission but shared catalog projections must not expose the contributing user's identity/health context.

### FormulationFingerprint
Deterministic comparison artifact built from normalized material fields such as ingredient order, active ingredients/strength/form, market, and relevant manufacturer/variant context. It is an acceleration/candidate-matching tool, not proof of identity by itself.

### CatalogCorroboration
Records that independent observations support the same formulation candidate. Suggested confidence states:

- CANDIDATE;
- USER_CONFIRMED;
- CORROBORATED;
- EXTERNALLY_VERIFIED;
- CONFLICTING;
- RETIRED.

Corroboration establishes package/formulation evidence quality, not medical safety.

### CatalogConflict
Structured disagreement between observations/providers, with conflict type, affected fields, re-extraction results, review state, and resolution/new-formulation linkage.

### CatalogCorrection
Shared correction/split/merge action with reason, reviewer, affected assertions, and recomputation impact.

## Medicine care domain

### MedicineSchedule
User-entered instructions and normalized reminder schedule stored separately.

### DoseEvent
Offline-idempotent event: taken, skipped, snoozed, unable_to_take.

### RefillEstimate
Estimate with assumptions/timestamp; not pharmacy inventory authority.

### MedicineReconciliation
Versioned comparison session between lists/sources. Kynviora never decides which conflicting prescription instruction is clinically correct.

## Care domain

### Appointment
User-organized appointment metadata/preparation notes.

### ReviewTask
Non-safety work item for data/care quality.

### VisitPack
Generated selection/version snapshot for a controlled export/handoff.

## Source and evidence domain

### SourceRegistryEntry
Defines organization, source, source class, jurisdiction, authority/legal role, terms/license status, expected freshness, parser/adapter, preservation policy, and coverage statement.

### SourceDocument
Immutable/preserved source version or reference with checksum/version metadata where allowed.

### SourceDiscoveryCandidate
Untrusted candidate found by a search engine, LLM/research agent, or analyst. It cannot influence shared regulatory/safety state until the underlying allowed source is independently fetched/validated and the Citation Gate passes.

### EvidenceClaim
Structured candidate/reviewed statement extracted from an approved source.

### NormalizedSubstance
Canonical ingredient/drug/chemical concept with aliases and external identifiers where appropriate.

### ScientificOpinionRecord
Structured scientific committee/expert opinion. It is explicitly distinct from law/regulation and from a Kynviora safety conclusion.

## Global Regulatory Registry domain

### Jurisdiction
Stable code and scope. Initial targets include IN, EU, GB, NI, US, and JP. GB and NI remain separable because applicable frameworks may diverge.

### RegulatoryRuleVersion
Versioned legal/regulatory rule or condition linked to official source evidence. Stores jurisdiction, scope, affected canonical substance/product concepts, product category/use/route/age conditions, concentration thresholds where defined, warnings, legal reference, effective dates, supersession, and review state.

### RegulatoryStatusRecord
Normalized projection of a rule for a substance/product context. Controlled status family includes:

- PROHIBITED;
- RESTRICTED;
- CONCENTRATION_LIMIT;
- USE_CONDITION;
- AGE_OR_ROUTE_CONDITION;
- WARNING_REQUIRED;
- POSITIVE_LIST_ONLY;
- PRODUCT_ACTION;
- SCIENTIFIC_OPINION;
- NO_MATCHED_RULE_WITHIN_COVERAGE;
- UNKNOWN_OR_INSUFFICIENT.

A single jurisdiction may have multiple applicable records. Do not force one oversimplified status if the legal conditions are multidimensional.

### ProductRegulatoryAction
Official action targeting a product, variant, batch, manufacturer, or category: recall, withdrawal, marketing prohibition, quality failure, warning, etc. Stores exact scope and authority.

### RegulatoryLensSnapshot
Versioned read projection for one product/formulation/ingredient across supported jurisdictions, including source freshness and coverage. It is informational and not itself a personalized safety assessment.

### CitationGateDecision
Records whether a candidate regulatory fact has an allowed underlying source, canonical mapping, exact scope, dates, traceable reference/location, validation results, and required human approval. Failed candidates never become published registry truth.

## Safety assessment domain

### AssessmentRuleVersion
Immutable deterministic policy defining required inputs, eligibility, match logic, output limits, and explanation template.

### ProductAssessment
Assessment about product/formulation/batch independent of a person's profile when appropriate.

### ProfileAssessment
Personalized assessment linking exact profile facts and owned-item/formulation/batch versions used.

### AlertPublication
User-visible publication derived from approved assessment state.

### AssessmentCorrection
Correction/supersession relation with reason/reviewer metadata.

### SafetyReceipt
Durable user-facing record of what was delivered, which versions were used, what resolution occurred, and later correction/withdrawal.

## Controlled dimensions

Do not collapse these into one score:

### Item/formulation verification
CONFIRMED, PROBABLE, PARTIAL, CONFLICTING, UNVERIFIED.

### Catalog corroboration
CANDIDATE, USER_CONFIRMED, CORROBORATED, EXTERNALLY_VERIFIED, CONFLICTING, RETIRED.

### Match confidence
EXACT, PROBABLE, UNCONFIRMED, NOT_MATCHED.

### Regulatory status
Use the status family above plus exact conditions; never reduce to universal red/green safety.

### Evidence level and action urgency
Defined separately in `09_SAFETY_WATCH_AND_EVIDENCE_MODEL.md`.

### Review/publication state
CANDIDATE, IN_REVIEW, APPROVED, PUBLISHED, REJECTED, SUPERSEDED, WITHDRAWN.

## Deletion, sharing, and historical integrity

User deletion rights and safety/audit integrity require explicit retention rules. Shared catalog/regulatory truth must not rely on retaining personal identifiers longer than necessary. Product observations used for corroboration should be separable from the user's health profile and should not expose raw user images to other users by default.

Derived data must maintain enough linkage for correction/reproduction while honoring approved privacy, consent, legal, and retention policy.
