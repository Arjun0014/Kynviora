# Stages and Phases

Status: Master implementation roadmap
Last reviewed: 2026-08-29

## How to use this roadmap

This roadmap is outcome-based. A phase is complete only when its expected output exists and
its exit criteria are met. Completing tickets or screens without the required safety,
security, data, accessibility, and operational behavior does not complete a phase.

Stages are ordered to reduce rework and progressively prove the Kynviora loop. Some backend,
clinical, design, and security work can run in parallel, but later stages should not depend on
undefined contracts from earlier ones.

The MVP is complete at the end of Stage 9.

---

# Stage 0 - Reset, Product Contract, and Engineering Foundation

## Stage objective

Start from a clean project with explicit product boundaries, reproducible tooling, shared
terminology, and the architecture needed to build safely. This stage prevents old prototype
assumptions from becoming hidden dependencies.

## Stage expected output

- New repository/application foundation.
- Approved MVP scope and product language.
- Shared domain vocabulary.
- Current architecture decisions recorded.
- Development, testing, linting, build, and secret-handling baseline.
- Initial design/accessibility tokens.
- No real health data.

### Phase 0.1 - Repository reset and toolchain

Goal:
Create a clean, reproducible application and backend workspace.

Expected output:

- New Git repository or clean rebuild branch with no copied prototype implementation.
- Expo SDK 57 / React Native 0.86 / strict TypeScript baseline, unless an ADR changes this.
- Package lock committed.
- Formatting, linting, type checking, unit-test runner, and CI skeleton.
- Environment variable validation.
- Development-build workflow for native testing.
- Conventional directory boundaries for app, features, repositories, domain, storage,
  backend, migrations, tests, and documentation.

Exit criteria:

- Clean clone installs and builds through documented commands.
- Android development build launches on emulator/device.
- CI fails on type, lint, or test errors.
- No secret is required in a public mobile environment variable.

### Phase 0.2 - Product and safety contract

Goal:
Turn the product promise into non-negotiable implementation rules.

Expected output:

- Approved MVP capability list.
- Explicit non-goals.
- Controlled terms for evidence level, urgency, match confidence, item verification, and
  review status.
- Safety-copy rules and forbidden claims.
- Initial hazard list for medicine and personal-care workflows.

Exit criteria:

- Product, engineering, and safety reviewers use the same terminology.
- Every planned MVP feature maps to the core Kynviora loop.
- No feature depends on an undefined "AI decides" behavior.

### Phase 0.3 - Design and accessibility foundation

Goal:
Establish the senior-first interface before feature screens multiply.

Expected output:

- Typography and spacing scale.
- Minimum touch-target rules.
- Semantic status components that never rely on color alone.
- Form, confirmation, error, loading, empty, offline, and permission-state patterns.
- Large-text and TalkBack acceptance checklist.
- Initial Today, Shelf, Safety, Care, and You navigation shell.

Exit criteria:

- Core components survive large system font scaling.
- Keyboard and screen-reader focus behavior is defined.
- No status component communicates meaning with color alone.

### Phase 0.4 - Domain contracts and data-classification baseline

Goal:
Define the records that later features will depend on.

Expected output:

- Core entity IDs and versioning rules.
- Provenance model.
- Soft-deletion and archival semantics.
- Sensitive-data classification.
- Local-versus-server authority table.
- Audit-event taxonomy.

Exit criteria:

- Medicine and personal-care items can share common ownership concepts without losing
  category-specific fields.
- Every sensitive record has an owner/access rule.
- Every safety assessment can eventually point to exact input versions.

---

# Stage 1 - Identity, Profiles, Consent, and Session Boundary

## Stage objective

Create the trusted person/household boundary before adding health and product data.

## Stage expected output

A user can securely sign in, create a profile, understand what information Kynviora stores,
and control consent. The app can determine which profile every future item belongs to.

### Phase 1.1 - Authentication and session lifecycle

Goal:
Implement production-shaped authentication without mixing identity logic into screens.

Expected output:

- Sign-up/sign-in/recovery flow.
- Email verification or approved identity method.
- Secure native session persistence.
- Session refresh and revocation.
- Sign-out that clears decrypted local projections and caches.
- Step-up authentication hook for future sensitive actions.

Exit criteria:

- Expired/revoked sessions cannot continue sensitive operations.
- Tokens are never stored in AsyncStorage/plain files.
- Auth failure, offline, and recovery states are accessible.

### Phase 1.2 - Household and profile creation

Goal:
Create the people model used by all future records.

Expected output:

- Household record.
- Personal and family-member profiles.
- Display identity, date of birth/age range, language, and optional emergency information.
- Clear distinction between account holder and managed profile.
- Profile switcher with persistent identity context.

Exit criteria:

- Every item created later must require a profile.
- Screens cannot accidentally display one profile's data under another profile identity.

### Phase 1.3 - Health-context facts and provenance

Goal:
Store only the narrow profile context required for MVP safety rules.

Expected output:

- Allergy/sensitivity records.
- Limited user-reported conditions only where approved rules require them.
- Provenance: user-reported, caregiver-entered, imported, or future verified source.
- Last reviewed date.
- Edit history/audit event.

Exit criteria:

- No OCR or inferred fact silently becomes a confirmed diagnosis.
- Rules can explicitly require a provenance level before using a fact.

### Phase 1.4 - Consent and privacy controls

Goal:
Make consent an actual product state rather than static policy text.

Expected output:

- Versioned consent receipts.
- Separate consent categories for profile data, notifications, caregiver sharing,
  diagnostics/analytics, and future connected-health data.
- Withdrawal flows.
- Initial export/deletion workflow shell.

Exit criteria:

- Revoking optional consent disables the associated behavior.
- Consent state is auditable and localizable.

---

# Stage 2 - Unified Health Shelf and Item Lifecycle

## Stage objective

Make medicines and personal-care products equally real in the product before introducing
advanced scanning or safety logic.

## Stage expected output

Users can create, view, update, archive, and review medicine and personal-care items with
clear verification status and evidence attachments.

### Phase 2.1 - Shared Shelf framework

Goal:
Create one inventory experience with category-specific detail models.

Expected output:

- Shelf list and item detail routes.
- Profile/category/verification/attention filters.
- Common item lifecycle: active, stopped, archived, deleted according to retention policy.
- First used, stopped, last reviewed, and last checked timestamps.
- Item verification badge/state.

Exit criteria:

- Medicine and personal-care items coexist without one being represented as a generic note.
- User can understand which items need verification or review.

### Phase 2.2 - Manual medicine entry

Goal:
Support complete medicine entry without depending on barcode or OCR.

Expected output:

- Brand/generic name fields.
- Strength and dosage form.
- Manufacturer/marketer and market where known.
- Product identifiers/barcode if available.
- Batch/lot, expiry, and pack evidence.
- Source/provenance and confidence.

Exit criteria:

- A user can create a clinically useful current medicine record entirely manually.
- Missing fields remain explicitly unknown rather than receiving defaults.

### Phase 2.3 - Manual personal-care entry

Goal:
Create an equally structured personal-care product record.

Expected output:

- Brand/product/category.
- Manufacturer/marketer and market.
- Barcode/product identifier.
- Formulation/label version state.
- Ingredient declaration text plus normalized ingredients when available.
- Batch/lot/expiry where printed.
- Front-label and ingredient-label evidence.

Exit criteria:

- Product detail makes identity versus formula confidence visible.
- Personal-care data is not reduced to name + barcode.

### Phase 2.4 - Product Trust Passport v1

Goal:
Expose the quality of Kynviora's knowledge about every item.

Expected output:

Each item shows:

- identity confidence;
- formulation confidence;
- batch confidence;
- ingredient/active-ingredient verification state;
- evidence sources;
- last user review;
- last safety check;
- current coverage limitations.

Exit criteria:

- A user can tell why two items with the same brand may have different trust states.
- "Unverified" remains useful and actionable rather than becoming an error dead end.

---

# Stage 3 - Guided Capture, Extraction, and Living Catalog Bootstrap

## Stage objective

Turn real medicine and personal-care packaging into structured, versioned product evidence while preserving the principle that capture technology proposes facts rather than silently declaring them true. Establish the first reusable Living Catalog path.

## Stage expected output

A user can capture a previously known or unknown item, verify extracted facts, create or reuse a formulation record, and understand whether the result is confirmed, corroborated, conflicting, or unverified.

### Phase 3.1 - Barcode capture and normalization

Goal:
Build robust machine-readable identity input before provider or AI research.

Expected output:

- Camera permission flow.
- Supported GTIN/UPC/EAN normalization.
- Check-digit and length validation.
- Dedicated barcode decoder rather than LLM barcode reading.
- Manual barcode fallback.
- Duplicate-scan handling.

Exit criteria:

- Invalid scans cannot create trusted item records.
- Camera denial does not block manual entry.

### Phase 3.2 - Guided package capture and quality gate

Goal:
Collect the smallest set of readable evidence needed for exact identity and formulation.

Expected output:

- Front/main panel capture.
- Ingredient/active-ingredient panel capture.
- Barcode/manufacturer/regulatory panel capture where separate.
- Batch/manufacture/expiry capture when applicable.
- Blur, glare, crop, orientation, and minimum-text-quality checks before expensive processing.
- Retake guidance.

Exit criteria:

- Unreadable evidence is rejected/retaken rather than guessed.
- Raw capture provenance is retained according to privacy/retention policy.

### Phase 3.3 - Dual extraction and field assertions

Goal:
Extract literal package facts with error detection.

Expected output:

- Conventional OCR/text extraction.
- Multimodal model structured extraction for supported fields.
- Field-level confidence and source-image region/reference.
- Schema validation.
- Deterministic validation for dates, units, GTINs, medicine strength/form, and other constrained fields.
- Agreement/disagreement state between extraction mechanisms.
- User confirmation of uncertain or safety-sensitive fields.

Exit criteria:

- A model cannot fill a missing field merely because it is likely.
- Every trusted field can be traced to package evidence, approved external evidence, or explicit user confirmation.

### Phase 3.4 - Cache-first resolver and source-grounded fallback

Goal:
Resolve known products cheaply and research unknown products without using model memory as truth.

Expected output:

Resolver sequence:

1. Kynviora Living Catalog;
2. approved licensed/official identity providers;
3. approved manufacturer/retailer sources;
4. legally approved public/community discovery sources;
5. source-grounded research agent for discovery/reconciliation when needed;
6. unresolved/manual evidence path.

Research-agent output is a **candidate** with source links/references. The backend independently fetches/validates allowed sources before shared catalog publication.

Exit criteria:

- Known formulations normally resolve without a model/research call.
- An LLM answer itself is never stored as product evidence.
- Provider/research failure degrades safely to user-confirmed/unverified state.

### Phase 3.5 - Living Catalog candidate creation and corroboration

Goal:
Allow the shared catalog to grow safely from real package observations.

Expected output:

- ProductObservation records.
- Candidate commercial identity and marketed formulation creation.
- Field assertions with provenance.
- Formulation fingerprint.
- candidate -> user-confirmed -> corroborated -> externally-verified lifecycle.
- independent-observation counting without exposing user identity.
- admin review for high-impact shared corrections.

Exit criteria:

- One user's submission cannot silently rewrite shared catalog truth.
- Repeated independent matching observations can increase corroboration.
- Shared catalog evidence remains separate from personal ownership/health context.

### Phase 3.6 - Formulation conflict and change detection

Goal:
Treat disagreement as information rather than destructive overwrite.

Expected output:

- deterministic ingredient/strength/form comparison;
- re-extraction on material conflict;
- source/provider comparison;
- possible-formulation-change review task;
- new formulation/version creation;
- first-seen/last-seen observations;
- affected-assessment recomputation hook.

Exit criteria:

- Same barcode plus materially different formula never silently overwrites the previous formula.
- Users can see when Kynviora needs a newer label rather than pretending certainty.

---

# Stage 4 - Medicine Care Workflows

## Stage objective

Make Kynviora useful every day for medicine organization while keeping medical decision
boundaries strict.

## Stage expected output

A user can manage a current medicine list, schedules, reminders, dose events, and refill
awareness reliably online or offline.

### Phase 4.1 - Medicine schedule model

Goal:
Represent common schedules without unsafe inference.

Expected output:

- Fixed-time schedules.
- Daily/selected-day patterns.
- Start/end dates.
- As-needed status separated from fixed reminders.
- Written instructions preserved as entered/source text.
- Time-zone handling rules.

Exit criteria:

- Schedule calculation has deterministic tests.
- Kynviora does not infer dose changes from adherence history.

### Phase 4.2 - Local reminder engine

Goal:
Deliver dependable medicine reminders without relying on server timing.

Expected output:

- Local notification scheduling.
- Restart/reboot recovery as platform allows.
- Permission handling.
- Generic lock-screen default.
- Quiet-hour behavior where appropriate.

Exit criteria:

- Reminder reliability is measured across process death and device restart scenarios.
- Sensitive medicine names are not shown on lock screen by default.

### Phase 4.3 - Dose events and adherence history

Goal:
Let users record what happened without gamifying or judging them.

Expected output:

- Taken.
- Skipped.
- Snoozed.
- Unable to take.
- Optional neutral note.
- Offline event creation and later sync.

Exit criteria:

- Copy avoids shame and unsafe treatment recommendations.
- Duplicate sync does not create duplicate dose events.

### Phase 4.4 - Refill awareness

Goal:
Help users notice likely refill needs without pretending exact inventory knowledge.

Expected output:

- Optional quantity and expected depletion estimate.
- User-adjustable assumptions.
- Refill reminder.
- Clear estimate language.

Exit criteria:

- Missed/taken events do not silently rewrite prescribed instructions.
- Refill estimates are labeled estimates.

---

# Stage 5 - Personal-Care Formulation Intelligence

## Stage objective

Make personal-care support substantively useful by turning package declarations into normalized, versioned formulations that can be reused and compared without pretending ingredient presence alone proves risk.

## Stage expected output

Kynviora can preserve raw label evidence, normalize supported ingredients, fingerprint formulations, detect change/conflict, and support the reviewed rules and Global Regulatory Lens.

### Phase 5.1 - Ingredient declaration model

Goal:
Preserve the label as evidence while enabling structured matching.

Expected output:

- Original declaration text and ordering.
- Parsed ingredient tokens.
- Normalized ingredient entity candidates.
- Alias/synonym mapping.
- Source-image references and extraction versions.
- User confirmation/correction state.

Exit criteria:

- Raw label evidence is never overwritten by normalization.
- Unknown ingredients remain unknown rather than guessed.

### Phase 5.2 - Canonical ingredient/substance normalization

Goal:
Map label terms to stable concepts used by rules and regulation adapters.

Expected output:

- canonical substance IDs;
- INCI/preferred names where applicable;
- CAS/EC/PubChem or other identifiers where legally/technically suitable;
- synonym provenance;
- exact versus ambiguous mapping state;
- human review queue for material unresolved mappings.

Exit criteria:

- A synonym/model suggestion cannot become a trusted canonical mapping without deterministic/source validation.
- Original label wording remains available beside normalized identity.

### Phase 5.3 - Formulation fingerprints and version history

Goal:
Recognize the same observed formula efficiently and detect meaningful change.

Expected output:

- deterministic fingerprint derived from normalized declaration plus relevant market/active/form data;
- market/manufacturer context;
- first-seen/last-seen timestamps;
- supersession/parallel-variant relation;
- collision/conflict safeguards.

Exit criteria:

- Two label versions can coexist under one commercial product identity.
- Fingerprints accelerate candidate matching but never replace evidence checks.

### Phase 5.4 - Narrow sensitivity/allergy vocabulary

Goal:
Build only the terminology required for the first reviewed personal-care rules.

Expected output:

- approved normalized substances/ingredient groups;
- user-facing names and aliases;
- exact versus group-match semantics;
- reviewer notes and rule eligibility.

Exit criteria:

- The matching vocabulary has clinical/product-safety review.
- Unsupported ingredients do not generate automated concern.

### Phase 5.5 - Personal-care verification and formula-change UX

Goal:
Help users understand identity, formula, corroboration, and conflict separately.

Expected output:

- "identity found, formula not verified" state;
- "single package observation" state;
- corroborated formulation state;
- externally verified formulation state;
- request-new-label flow;
- possible-formula-change task;
- Product Trust Passport integration.

Exit criteria:

- The app does not silently reuse an old formula when the user's current label conflicts or is uncertain.

---

# Stage 6 - Global Sources, Regulatory Registry, Evidence, and Safety Engine

## Stage objective

Build the defensible backend that turns official/legal source material and reviewed evidence into versioned regulatory facts and reproducible safety assessments.

## Stage expected output

Kynviora can monitor supported sources, preserve exact source versions, use AI only to propose structured candidate data, publish reviewed jurisdiction-specific regulatory records, and apply deterministic safety rules with replay/correction.

### Phase 6.1 - Source registry and authority hierarchy

Goal:
Know exactly what Kynviora monitors and what legal/evidentiary role each source is allowed to play.

Expected output:

- SourceRegistryEntry per regulator/feed/provider.
- jurisdiction and geographic scope;
- source class: primary law/regulation, official action registry, official guidance, scientific opinion, identity/normalization, community/commercial discovery;
- legal/license/redistribution review;
- expected refresh frequency;
- parser/adapter owner and version;
- source-health state;
- user-facing coverage statement.

Exit criteria:

- Kynviora can distinguish a legally binding source from an informational database or scientific opinion.
- Great Britain and Northern Ireland are separately modeled where applicable.

### Phase 6.2 - Immutable source preservation and change detection

Goal:
Make every published regulatory/evidence fact traceable to the exact material processed.

Expected output:

- allowed raw snapshot/reference preservation;
- checksums/version IDs;
- fetch timestamps;
- amendment/revision relation;
- structured source-diff trigger;
- outage/staleness monitoring.

Exit criteria:

- A later reviewer can reconstruct which official version produced a record.
- A source change cannot silently mutate previous facts.

### Phase 6.3 - AI-assisted discovery, extraction, and Citation Gate

Goal:
Use search-grounded models/LLMs to reduce research cost without making them evidence.

Expected output:

- source-discovery candidate queue;
- structured extraction for substance/product/status/conditions/dates;
- translation assistance;
- old-versus-new amendment comparison;
- canonical identifier reconciliation;
- schema and deterministic validators;
- **Citation Gate** requiring an allowed underlying source and traceable location/reference before shared publication.

Exit criteria:

- A model or search-engine answer cannot be cited as the regulatory source.
- Unsupported claims or missing official evidence remain candidate/rejected.
- High-impact/ambiguous records require human review.

### Phase 6.4 - Global Regulatory Registry

Goal:
Represent jurisdictional treatment without collapsing nuanced rules into red/green labels.

Initial adapter targets:

- India;
- European Union;
- Great Britain;
- Northern Ireland;
- United States;
- Japan.

Expected output:

- canonical substance/product mapping;
- jurisdiction-specific RegulatoryStatusRecord;
- prohibited/restricted/concentration/use/age/route/warning/positive-list conditions;
- product/batch recalls/withdrawals/actions;
- scientific-opinion records distinct from law;
- effective/publication dates;
- supersession;
- source provenance;
- regulatory-lens projection.

Exit criteria:

- "no matched restriction" is not represented as "approved" or "safe".
- Conditional restrictions are never simplified into prohibition.
- EU/GB/NI divergence can be represented.

### Phase 6.5 - Deterministic rule engine and assessment inputs

Goal:
Create versioned matching policy for personal safety conclusions separately from regulatory comparison.

Expected output:

- rule version entity;
- eligibility conditions;
- required evidence/provenance;
- identity/formulation/batch match requirements;
- profile-context requirements;
- evidence level and allowed urgency;
- explanation template reference;
- unit fixtures.

Exit criteria:

- Same input versions produce the same assessment.
- A foreign regulatory record does not automatically become a personalized warning.
- Generative model output is not required to reproduce a result.

### Phase 6.6 - Reviewer queue and publication controls

Goal:
Create human governance for ambiguous/high-impact regulatory and safety content.

Expected output:

- reviewer roles;
- source/evidence/legal-scope view;
- regulatory-record review;
- rule preview;
- two-person approval where policy requires it;
- publish/reject/return-for-correction;
- emergency withdrawal;
- immutable audit event.

Exit criteria:

- High-impact content cannot be published by an unauthorized single path.
- Publication is attributable, reversible, and scoped to the intended jurisdiction.

### Phase 6.7 - Shadow mode and replay

Goal:
Measure rule and regulatory-mapping behavior before broad user exposure.

Expected output:

- shadow-run mode against synthetic/historical datasets;
- affected product/formulation counts;
- potential-user-match counts;
- false-positive review samples;
- replay after source/rule/normalization change;
- before/after comparison.

Exit criteria:

- New high-impact rules can be evaluated without user notification.
- Regulatory data corrections can recompute dependent product views and assessments reproducibly.

---

# Stage 7 - Safety Watch and Global Regulatory Lens Experience

## Stage objective

Turn the evidence/regulatory engine into Kynviora's defining user experience: calm, exact, globally transparent, explainable, and actionable without conflating foreign regulation with personal medical advice.

## Stage expected output

Users can understand both (a) their reviewed Kynviora safety assessments and (b) how supported jurisdictions regulate the same ingredient/product, including uncertainty and corrections.

### Phase 7.1 - Assessment states and inbox

Goal:
Create the main Safety Watch information architecture.

Expected output:

- No current matched alert.
- Information.
- Review.
- Action required according to approved wording.
- Insufficient data.
- Resolved/corrected history.
- Filters by profile, urgency, and status.

Exit criteria:

- No state implies guaranteed safety.
- Evidence level and urgency are visibly separate.

### Phase 7.2 - Global Regulatory Lens

Goal:
Show jurisdiction-specific treatment accurately enough to be useful without fear-based simplification.

Expected output:

- jurisdiction cards for supported adapters;
- status label plus icon/text, not color alone;
- prohibited versus restricted versus concentration/use/warning conditions;
- product/batch official actions;
- scientific opinion distinctly labeled as non-law;
- source authority, legal/notice reference, effective date, last verified date;
- condition details such as product type, concentration, age, route, rinse-off/leave-on where source data supports them;
- coverage/unknown state;
- explanation that foreign status does not automatically change local legal status or prove harm.

Exit criteria:

- A user can distinguish "banned" from "restricted under conditions" in usability testing.
- US/no-rule states are not presented as FDA approval.
- GB and NI can display different results.

### Phase 7.3 - Alert detail and explainability

Goal:
Make every personalized alert independently understandable.

Expected output:

- affected person and exact item;
- match confidence;
- reason for match;
- evidence level;
- urgency;
- jurisdiction/source/date;
- source link/retained reference where allowed;
- next action;
- limitations;
- feedback/report-incorrect action.

Exit criteria:

- Usability participants can explain why they received a test alert.
- The UI reveals what is known versus inferred.

### Phase 7.4 - Evidence and Regulatory Diff

Goal:
Show what materially changed instead of forcing users to compare source versions.

Expected output:

- prior and new assessment/regulatory version;
- changed status/conditions/source scope;
- changed product/formulation/batch applicability;
- whether user action changed;
- correction versus new evidence/regulation distinction.

Exit criteria:

- Users can distinguish a new regulator action from a Kynviora correction.

### Phase 7.5 - Notification policy

Goal:
Notify without leaking health information or turning every foreign regulatory difference into alarm.

Expected output:

- generic lock-screen notifications by default;
- urgency-based delivery policy;
- foreign-regulatory informational update policy;
- deduplication identifiers;
- digest policy for lower urgency;
- quiet hours;
- current-state revalidation when opened.

Exit criteria:

- A new foreign restriction does not automatically produce a red/high-severity personal alert.
- Stale/corrected notifications cannot remain actionable without revalidation.

### Phase 7.6 - Resolution and Safety Receipt

Goal:
Let users complete the safety workflow and preserve what happened.

Expected output:

- reviewed/not applicable;
- returned/disposed/quarantined where relevant;
- discussed with pharmacist/clinician;
- corrected item identity;
- report incorrect match;
- versioned Safety Receipt with alert, source/rule version, action, and later corrections.

Exit criteria:

- Resolution does not erase historical assessment.
- Corrections remain visible and auditable.

---

# Stage 8 - Family Collaboration, Review Inbox, and Visit Pack

## Stage objective

Prove that Kynviora improves care coordination after information is organized or a safety
change occurs.

## Stage expected output

Families can share narrowly permitted information, resolve review tasks, and intentionally
prepare an accurate summary for a professional conversation.

### Phase 8.1 - Caregiver invitation and grants

Goal:
Implement explicit access rather than shared credentials.

Expected output:

- invite/accept flow;
- capability-level grants;
- profile scoping;
- expiration option;
- revoke flow;
- audit history;
- re-authentication for sensitive grant changes.

Exit criteria:

- Revocation takes effect on the next authenticated access and invalidates cached access.
- Unauthorized profiles never leak through list/cache behavior.

### Phase 8.2 - Caregiver alert delivery

Goal:
Share only the safety information the profile owner permitted.

Expected output:

- separate safety-alert permission;
- optional missed-dose permission;
- notification privacy controls;
- caregiver view of resolution state according to grant.

Exit criteria:

- Caregiver access is testable through deny-by-default authorization cases.

### Phase 8.3 - Household Review Inbox

Goal:
Collect non-urgent work that improves data quality and care readiness.

Expected output:

Review tasks such as:

- item not reviewed recently;
- batch missing;
- formula needs confirmation;
- OCR field unresolved;
- caregiver grant expiring;
- safety item awaiting user confirmation;
- refill estimate needs review.

Exit criteria:

- Review tasks are clearly different from safety alerts.
- Completing a task updates the relevant authoritative record.

### Phase 8.4 - Visit Pack

Goal:
Turn Kynviora's maintained data into a useful professional handoff.

Expected output:

- select profile;
- choose current medicines and relevant personal-care items;
- include allergies/sensitivities;
- unresolved safety items;
- recent medication changes/events if selected;
- questions and notes;
- generated-at time and data provenance note;
- share/print/export flow with explicit confirmation.

Exit criteria:

- Export never happens automatically.
- A user can review exactly what will be shared.

### Phase 8.5 - Medicine Reconciliation workflow v1

Goal:
Help families compare old versus new medication lists after a visit or discharge without
letting the app decide treatment.

Expected output:

- previous/current list comparison;
- added/removed/changed fields;
- unresolved differences;
- "confirm with clinician/pharmacist" workflow;
- source attachment.

Exit criteria:

- Kynviora never chooses which conflicting instruction is medically correct.

---

# Stage 9 - Production Hardening, Validation, and MVP Beta

## Stage objective

Turn the feature-complete system into a release candidate with measured safety, security,
accessibility, source coverage, and operational readiness.

## Stage expected output

A staged beta that demonstrates the full Kynviora vision across medicines and personal care
with explicit coverage limits and operational controls.

### Phase 9.1 - Data-quality and matching validation

Goal:
Measure whether the product identifies and matches supported items accurately enough to ship.

Expected output:

- labeled evaluation datasets;
- medicine identity precision/recall;
- personal-care formula match precision;
- formulation-fingerprint collision/change tests;
- independent-observation/corroboration tests;
- batch-match tests;
- OCR and multimodal field error/disagreement rates;
- Living Catalog cache-hit/fallback-research rates;
- cross-jurisdiction regulatory-status and condition extraction accuracy;
- Citation Gate false-accept/false-reject review;
- safety-rule false-positive/false-negative estimates;
- defined release thresholds.

Exit criteria:

- Release thresholds are approved, not merely measured.
- Known weak categories are disabled or disclosed.

### Phase 9.2 - Security and privacy hardening

Goal:
Validate the controls around real sensitive data.

Expected output:

- threat-model review;
- automated RLS/authorization tests;
- mobile security assessment aligned to OWASP MASVS/MASTG;
- secret/dependency/static/native scans;
- penetration test or independent review appropriate to launch;
- deletion/export tests;
- document/image malware and content controls where uploads exist.

Exit criteria:

- No unresolved critical release-blocking finding.
- Residual high risks have named owner, mitigation, and acceptance decision.

### Phase 9.3 - Clinical and content validation

Goal:
Validate safety rules and wording with qualified reviewers and representative users.

Expected output:

- rule sign-off;
- alert-language review;
- correction drill;
- false-positive investigation drill;
- emergency withdrawal drill;
- comprehension testing.

Exit criteria:

- Users understand urgency without overestimating certainty.
- Review/publishing responsibilities are operationally staffed.

### Phase 9.4 - Accessibility and senior usability validation

Goal:
Prove the app works for its primary audience.

Expected output:

- TalkBack suite;
- largest-font testing;
- older-adult usability sessions;
- caregiver usability sessions;
- low-connectivity/offline sessions;
- accessibility defect backlog and release gate.

Exit criteria:

- Critical journeys can be completed without hidden gestures or clipped actions.
- High-severity alerts are understandable in usability testing.

### Phase 9.5 - Store, policy, and legal readiness

Goal:
Prepare the implemented product, not a hypothetical description, for distribution.

Expected output:

- Google Play Health apps declaration.
- accurate Data safety disclosures.
- public privacy policy.
- medical/health functionality disclaimer/claims review as applicable.
- DPDP/privacy review for India-first launch.
- terms/support/security contact.
- final regulatory classification review for implemented behavior.

Exit criteria:

- Store declarations match actual code/data behavior.
- Required legal/clinical approvals are documented.

### Phase 9.6 - Staged beta and release observation

Goal:
Release gradually with the ability to detect and reverse harmful behavior.

Expected output:

- internal alpha;
- closed beta;
- monitored expansion;
- release health dashboard;
- source freshness dashboard;
- alert publication monitoring;
- feature/rule kill switches;
- rollback procedure;
- incident on-call ownership.

Exit criteria:

- Production behavior matches release thresholds.
- No unresolved safety incident blocks expansion.
- The team can demonstrate end-to-end correction and rollback under realistic conditions.

---

# After MVP - Expansion stages

These are intentionally not detailed implementation commitments until MVP evidence supports
them.

## Stage 10 - Deeper medicine intelligence

Potential phases:

- expanded reviewed duplicate/interaction rules;
- richer refill and reconciliation workflows;
- pharmacy/clinician handoff integrations;
- carefully selected Health Connect/HealthKit use cases.

## Stage 11 - Broader product and evidence coverage

Potential phases:

- supplements;
- broader cosmetics/personal-care categories;
- additional jurisdictions;
- manufacturer/retailer feeds;
- improved formulation change detection.

## Stage 12 - Advanced evidence monitoring

Potential phases:

- structured literature discovery;
- reviewer-assisted AI extraction;
- evidence synthesis workflow;
- limited user-visible emerging-signal experience only after governance proves safe.

## Stage 13 - iOS release and regional scale

Potential phases:

- iOS parity and VoiceOver validation;
- HealthKit only where justified;
- local-language research and localization;
- jurisdiction-specific source/governance adapters.

## Stage 14 - Lifestyle and preventive support

Only after strong product-market fit, clinical governance capacity, and a clear safety case.
This should not be allowed to dilute Safety Watch.
