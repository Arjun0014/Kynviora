# MVP Definition

Status: Binding MVP scope
Last reviewed: 2026-08-29

## MVP objective

Build the smallest production-shaped version of Kynviora that fully demonstrates the core
vision across both medicines and personal-care products.

"Smallest" does not mean a generic reminder app with future safety features described in a
pitch deck. The MVP must contain a working end-to-end safety loop with intentionally narrow
coverage.

## Primary MVP user

An adult managing their own products or helping an older parent/relative, with explicit
consent and permissions.

## Supported MVP item classes

### Medicines

- Prescription medicines.
- Over-the-counter medicines.
- A limited supplement representation may exist for inventory, but advanced supplement
  interaction logic is outside the first safety-rule set unless clinically approved.

Required medicine fields include:

- generic and brand name when known;
- strength;
- dosage form;
- manufacturer/marketer when available;
- market/country;
- barcode/product identifiers when present;
- batch/lot and expiry when available;
- source evidence such as package/prescription photo;
- schedule and refill information;
- item-verification state.

### Personal-care products

Initial categories:

- skin care;
- sunscreen;
- shampoo/conditioner;
- soap/body wash;
- toothpaste/oral care;
- cosmetics/topical personal-care items where identity data is adequate.

Required personal-care fields include:

- brand and product name;
- category;
- manufacturer/marketer;
- country/market variant;
- barcode/product identifier;
- formulation version or label snapshot;
- ingredient declaration when available;
- batch/lot and expiry where printed;
- front-label and ingredient-label evidence;
- item-verification state.

## MVP capability groups

### A. Account, profile, and consent

Must have:

- secure account access;
- one or more profiles;
- user-reported allergies/sensitivities and limited conditions only where an approved MVP
  rule needs them;
- explicit provenance for profile facts;
- consent records;
- account export and deletion workflow design implemented to MVP release requirements.

### B. Unified Health Shelf

Must have:

- one shelf spanning medicines and personal care;
- filters by person, category, verification status, and attention needed;
- manual item creation;
- versioned item history;
- start/stop/archive state;
- product/medicine photo evidence;
- "last reviewed" and "last safety checked" timestamps.

### C. Capture and verification

Must have:

- barcode scanning where supported;
- manual search and manual fallback;
- front-label capture;
- ingredient/medicine-label capture;
- OCR proposal with confidence;
- user confirmation before low-confidence fields become trusted;
- country/market selection where identity is ambiguous;
- batch/lot and expiry capture;
- unresolved state when exact identity cannot be established.

### D. Medicine organization

Must have:

- dose schedule;
- local reminders;
- taken/skipped/snoozed/unable-to-take event capture;
- refill estimate or reminder;
- current medicine list;
- no autonomous prescription change advice.

### E. Personal-care understanding

Must have:

- ingredient-declaration capture and normalization for the narrow supported safety rules;
- formulation snapshot/version concept;
- visible distinction between "catalog identity found" and "formula verified";
- user correction and re-verification workflow.

### F. Safety Watch

Must have a deliberately narrow but real reviewed rule set covering both domains.

Required signal types for MVP:

- official medicine/product recall or regulator action where a supported source provides it;
- batch/lot matching when source data is sufficient;
- expiry warning;
- narrow reviewed allergy/sensitivity ingredient matching;
- duplicate active-ingredient warning for medicines only when validated reference data and
  clinical review support the rule;
- formulation/evidence change requiring review;
- insufficient-data state.

Every assessment must record:

- affected profile;
- item/formulation/batch identity used;
- source version;
- rule version;
- evidence level;
- action urgency;
- match confidence;
- explanation template version;
- publication/review state;
- creation and supersession metadata.

### G. Alert experience

Must have:

- calm alert inbox;
- exact person and item affected;
- why the match occurred;
- exact/probable/unconfirmed match label;
- evidence level distinct from urgency;
- source, jurisdiction, publication/effective date, and last checked date;
- safe next action;
- limitations and "what this does not mean" copy where needed;
- resolve/not-applicable/report-incorrect controls;
- correction/supersession behavior.

### H. Caregiver collaboration

Must have:

- invitation;
- explicit profile/capability grants;
- revocation;
- audit event visibility;
- separate permission for safety alerts, shelf, medicines, and exports;
- generic notification content by default.

### I. Visit Pack

Must have a user-controlled export/share view containing selected:

- current medicines;
- relevant allergies/sensitivities;
- recent item changes;
- unresolved safety items;
- recent adherence/refill issues if selected;
- user questions/notes;
- generation date and provenance caveat.

The pack is a communication aid, not a clinician-authenticated medical record.

### J. Offline essentials

Must keep usable without network:

- current medicine list;
- schedules/reminders;
- basic personal-care shelf;
- emergency/basic profile summary chosen for offline use;
- previously synchronized critical/high alerts and their timestamps;
- pending user edits with deterministic sync handling.

### K. Living Catalog and reuse economy

Must have:

- the shared product catalog may begin sparse/near-empty rather than pretending universal coverage;
- seeded ingredient/medicine normalization vocabularies and source registries exist before user safety use;
- user capture can create a **candidate** product/formulation when no reliable shared record exists;
- every shared field is backed by field assertions and provenance rather than an LLM paragraph;
- repeated independent observations can increase catalog corroboration confidence;
- a material ingredient/strength/form conflict creates a new formulation candidate or conflict state instead of overwriting history;
- formulation fingerprints support efficient same-formula reuse without claiming the barcode alone proves equivalence;
- shared catalog publication is server-authoritative and protected from direct user writes;
- database hits avoid unnecessary model/research calls; model calls are fallback processing, not the normal steady-state lookup.

### L. Global Regulatory Lens

The MVP must demonstrate cross-jurisdiction regulatory transparency for supported personal-care ingredients and selected product actions. Initial adapter targets are:

- India;
- European Union;
- Great Britain;
- Northern Ireland;
- United States;
- Japan.

The Lens must distinguish at minimum:

- prohibited;
- restricted;
- concentration limit;
- product/use/age/route condition;
- warning/label condition;
- positive-list-only treatment where applicable;
- product/batch recall, withdrawal, or other official action;
- scientific opinion/review that is not itself law;
- no matched rule found within monitored coverage;
- unknown/insufficient coverage.

Every displayed status must retain the jurisdiction, official source, legal/notice reference where available, effective/publication date, exact condition, source snapshot/version, and Kynviora last-verified date.

A foreign prohibition/restriction does **not** automatically become an Indian safety alert. It is normally regulatory information unless a reviewed Kynviora rule separately determines user relevance.

## Internal MVP systems required even if users never see them

- reviewed source registry with jurisdiction-specific source hierarchy;
- Global Regulatory Registry and regulatory status versioning;
- Citation Gate requiring traceable source evidence before shared regulatory publication;
- source-discovery/research queue where AI output remains untrusted candidate data;
- ingestion monitoring;
- Living Catalog admin tools, formulation conflict review, corroboration, and catalog correction;
- rule authoring/versioning;
- reviewer queue;
- publication approval controls;
- source and rule rollback;
- assessment replay/reproduction;
- audit log;
- support/correction workflow;
- safety-rule shadow mode;
- operational source-freshness dashboard.

Without these, Safety Watch is a demo rather than a trustworthy product system.

## Explicitly outside MVP

- autonomous diagnosis;
- symptom checker;
- prescription substitution;
- broad medicine-condition or medicine-supplement interaction engine;
- generalized AI medical assistant;
- lifestyle coach;
- direct pharmacy ordering;
- insurance claims;
- clinician EHR integration;
- generalized research alerts from unreviewed literature;
- every personal-care category worldwide;
- every barcode worldwide;
- unrestricted Health Connect/HealthKit ingestion;
- universal "safe/unsafe" scoring.

## MVP demonstration scenario

The MVP should support a complete scripted demonstration using synthetic data and reviewed
sample safety records:

1. Create a parent profile and record a confirmed allergy/sensitivity.
2. Add a medicine by scanning/searching and confirm strength, pack, batch, and schedule.
3. Capture a personal-care item that is not yet in the shared catalog using guided front, ingredient, barcode/manufacturer, and batch/date evidence as applicable.
4. Show image-quality gating, barcode decoding, OCR/vision extraction, field-level provenance, and user confirmation.
5. Create a candidate formulation, normalized ingredient links, and formulation fingerprint in the Living Catalog.
6. Scan/search the same confirmed formulation again and demonstrate a fast catalog reuse path without a new research call.
7. Capture a materially changed ingredient declaration and demonstrate a formulation conflict/new-version workflow rather than overwrite.
8. Show each item's Product Trust Passport and different confidence/corroboration states.
9. Open Global Regulatory Lens and show at least two genuinely different supported jurisdiction statuses from reviewed fixtures/official-source adapters, including one conditional/restricted case that is **not** simplified into "banned".
10. Receive an official/reviewed medicine batch alert that matches only the correct pack.
11. Receive a reviewed personal-care ingredient concern that explains the exact ingredient, profile fact, evidence, and limitation.
12. Show Evidence Diff after a source/rule/regulatory record is updated.
13. Correct one item identity and demonstrate deterministic assessment recomputation.
14. Give a caregiver safety-only permission and demonstrate authorized versus unauthorized views.
15. Generate a Visit Pack showing current medicines and unresolved safety items.

If this scenario cannot be performed reliably, the MVP does not yet prove Kynviora's vision.

## MVP release criteria

Public MVP/beta requires:

- measured item-matching precision for supported categories;
- defined acceptance thresholds for supported safety rules;
- clinical sign-off for high-impact wording and rule behavior;
- source freshness monitoring and incident runbooks;
- security review and penetration testing appropriate to the release;
- tested caregiver consent/revocation;
- tested export/deletion workflows;
- older-adult usability testing and TalkBack validation;
- generic lock-screen notification defaults;
- correction and rule rollback capability;
- clear in-product coverage disclosure;
- legal/privacy/regulatory review for the implemented launch scope.
