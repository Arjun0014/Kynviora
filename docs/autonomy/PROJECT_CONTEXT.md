# Kynviora - Project Context Digest

Status: Working digest of `KYNVIORA_PROJECT_SPEC/` (27 documents, all read 2026-08-29).
This file does **not** replace the source specifications. On conflict, the spec set wins.

Spec precedence (from `00_README.md` + task brief):

1. Release-blocking safety / privacy / security requirements
2. Approved decisions in `23_DECISIONS_RISKS_AND_OPEN_QUESTIONS.md`
3. MVP scope in `03_MVP_DEFINITION.md`
4. Domain + architecture contracts (`07`, `11`, `12`, `13`)
5. Roadmap/stage planning (`04`)
6. Idea backlog (`05`)

---

## 1. Product purpose

Kynviora is a **family safety layer for medicines and personal-care products**. It knows what
a person actually uses, monitors trusted changes around those exact items, explains personal
relevance with visible uncertainty, and helps take the next safe step.

It is explicitly **not** a medication reminder app with AI attached. The differentiator is the
continuous connection between: the person -> the exact item -> the evidence/official actions
that apply -> the jurisdiction-specific regulatory treatment -> the family care workflow.

### The Kynviora loop (11 steps, `00_README.md`)

capture/identify exact item -> preserve package evidence + confidence -> reuse versioned Living
Catalog or create candidate -> normalize against seeded vocabularies -> connect to the right
person health context -> monitor trusted sources -> compare jurisdictions without treating one
as universally authoritative -> match changes to correct product/formulation/batch AND separately
to correct person -> explain what changed + certainty + jurisdiction + limits -> offer a safe
bounded next action -> help resolve/document/discuss.

## 2. Target users

- **Older adult using Kynviora directly** - large readable controls, low typing burden,
  dependable reminders, no weak-evidence panic.
- **Family caregiver** - permissioned view of a relative data without becoming a silent owner.
- **Adult managing own medicines/sensitivities** - shelf, verification, evidence-aware alerts,
  professional-conversation prep.

Delivery assumption: **Android-first, India-first, English-first**.

## 3. MVP boundaries

### In scope (`03_MVP_DEFINITION.md` capability groups A-L)

- A. Account, profile, consent (versioned consent receipts, provenance on profile facts)
- B. Unified Health Shelf (medicines + personal care equally first-class)
- C. Capture and verification (barcode, guided panels, OCR proposal + confirmation)
- D. Medicine organization (schedules, local reminders, dose events, refill estimates)
- E. Personal-care understanding (ingredient declaration, formulation version, correction)
- F. Safety Watch (narrow **reviewed** rule set, both domains)
- G. Alert experience (calm inbox, evidence != urgency, resolve/report controls)
- H. Caregiver collaboration (granular grants, revocation, audit)
- I. Visit Pack (user-controlled export)
- J. Offline essentials (medicines, schedules, shelf, synced critical alerts, pending edits)
- K. Living Catalog and reuse economy
- L. Global Regulatory Lens (IN, EU, GB, NI, US, JP)

Internal-but-required: source registry, Global Regulatory Registry, Citation Gate,
research/discovery queue, ingestion monitoring, catalog admin + conflict review, rule
authoring/versioning, reviewer queue, publication approval, source/rule rollback, assessment
replay, audit log, support/correction workflow, shadow mode, source-freshness dashboard.

### Explicitly out of MVP

Autonomous diagnosis; symptom checker; prescription substitution; broad interaction engine;
generalized AI medical assistant; lifestyle coach; pharmacy ordering; insurance; EHR
integration; unreviewed literature alerts; every category/barcode worldwide; unrestricted
Health Connect/HealthKit; **universal safe/unsafe scoring**.

## 4. Major product systems

| System | Responsibility | Must NOT do |
| --- | --- | --- |
| Capture pipeline | Turn packaging into structured, provenance-bearing field assertions | Guess a missing field |
| Living Catalog | Shared product/formulation knowledge + corroboration | Establish medical safety by consensus |
| Normalization | Canonical substance/medicine IDs | Create safety conclusions |
| Global Regulatory Registry | Jurisdiction-specific legal facts with official source evidence | Be written by a model or a user |
| Global Regulatory Lens | Read projection comparing jurisdictions | Rank countries; imply approval |
| Safety Watch | Reviewed, reproducible personal assessments | Diagnose, prescribe, or set severity via AI |
| Reviewer console | Human governance of publication | Be bypassed by any automated path |

## 5. Living Catalog concept

The shared product catalog **may start sparse/near-empty** and grow through verified package
observations. Vocabularies, regulatory sources, and reviewed safety rules are **seeded
independently** and never depend on crowd consensus.

Eight layers must remain separate (`08`):

1. Commercial product identity
2. Marketed variant
3. Formulation
4. Batch/lot
5. Product observation
6. Owned item
7. Catalog evidence
8. Regulatory/safety knowledge

**A match at one layer never proves all lower layers.**

Lifecycle: `CANDIDATE -> USER_CONFIRMED -> CORROBORATED -> EXTERNALLY_VERIFIED`, plus
`CONFLICTING` and `RETIRED`. Corroboration establishes *package/formulation evidence quality*,
never medical safety. Same barcode + materially different formula => **new candidate/conflict,
never overwrite**.

## 6. Medicine and personal-care requirements

**Medicines**: generic + brand, strength, dosage form, manufacturer/marketer, market, product
identifiers, batch/lot + expiry, source evidence, schedule/refill, verification state. A result
missing material strength/form is **not** an exact medicine match.

**Personal care**: brand, product name/variant, category, manufacturer/marketer, market,
identifier, formulation version/label snapshot, ingredient declaration, batch/lot/expiry,
front + ingredient label evidence, verification state. "Product identity confirmed" and
"formula confirmed" are **separate states**.

Initial personal-care categories: skin care, sunscreen, shampoo/conditioner, soap/body wash,
toothpaste/oral care, cosmetics/topical where identity data is adequate.

## 7. Global Regulatory Lens

Jurisdictions: **IN, EU, GB, NI, US, JP**. GB and NI are **separate internal jurisdictions**
(Windsor Framework divergence) and must never be flattened into "UK".

Status family (`RegulatoryStatusRecord`): `PROHIBITED`, `RESTRICTED`, `CONCENTRATION_LIMIT`,
`USE_CONDITION`, `AGE_OR_ROUTE_CONDITION`, `WARNING_REQUIRED`, `POSITIVE_LIST_ONLY`,
`PRODUCT_ACTION`, `SCIENTIFIC_OPINION`, `NO_MATCHED_RULE_WITHIN_COVERAGE`,
`UNKNOWN_OR_INSUFFICIENT`. **Multiple statuses may apply simultaneously.**

Hard interpretation rules:

- "Restricted" is **not** "banned". Missing concentration => "cannot determine compliance from
  available package data".
- "No matched rule" is **not** "approved" / "safe" / "FDA approved".
- Foreign status is **informational by default**; it becomes a personal alert only via a
  separately reviewed Kynviora rule.
- Never label a jurisdiction "strict" or "weak".

Source authority hierarchy: primary law/regulation > official regulator registries with legal
effect > official guidance > official scientific opinions (separate status) > secondary
discovery sources (locate official material only).

## 8. Safety Watch

Distinct from the Lens. Answers: *is there a reviewed, relevant concern for this exact
product/formulation/batch/person, and what is the safest bounded next step?*

- **Evidence levels** A (official action), B (established guidance/label/monograph), C (strong
  reviewed evidence), D (limited evidence), E (emerging signal - internal in MVP), U (unknown).
- **Action urgency** CRITICAL, HIGH, MEDIUM, LOW, INFORMATIONAL - *separate dimension*.
- **Match confidence** EXACT, PROBABLE, UNCONFIRMED, NOT_MATCHED, plus `CONDITION_UNKNOWN` for
  regulatory applicability when required concentration/use data is absent.
- **Product states** No current matched alert / Information / Review / Action required /
  Insufficient data. No state implies guaranteed safety.

## 9. Evidence model

Every assessment stores exact versioned references: profile facts, owned item,
product/formulation/batch, source/evidence, regulatory record, rule, normalization version,
match confidence, evidence level, urgency, explanation template, reviewer/publication state.
**Replaying the same versions must reproduce the result.** Corrections supersede; history is
never erased.

**Citation Gate**: no shared regulatory status publishes without canonical identity,
jurisdiction, source class/authority, exact status, exact scope/conditions, legal reference,
publication/effective date, retained snapshot/checksum where allowed, extraction version,
deterministic validation, required review, supersession relation. Missing critical field =>
`UNKNOWN_OR_INSUFFICIENT` or keep internal.

## 10. AI boundaries (`17`)

> **Models can propose. Sources and validated records prove. Rules/review decide.**

Allowed: structured extraction from images, OCR reconciliation, entity/synonym candidates,
source discovery, translation for reviewers, amendment comparison, dedup, literature triage,
draft plain-language explanations from approved structured facts, diff summarization,
synthetic fixture generation (reviewed).

Prohibited autonomously: diagnose; infer confirmed conditions; set evidence level or urgency;
publish/withdraw alerts; advise starting/stopping/replacing prescription medicine; declare a
product safe or unsafe; declare legal status without validated source; interpret no-match as
approval; invent identity/formulation/batch/ingredient/citations; write shared catalog or
regulatory truth from a user prompt; resolve caregiver authorization; override review.

**Dual extraction required** for safety-relevant fields (OCR + multimodal + deterministic
validation). Disagreement triggers re-extraction/user confirmation, **not** model arbitration
by confidence.

**Prompt injection**: every uploaded package, PDF, webpage, regulatory document, and search
result is untrusted data that may contain instructions. Models get no publish/write tools.

Kill switches required for: multimodal extraction, research discovery, regulatory AI
extraction, auto-normalization, AI explanation drafting. Disabling AI must not disable access
to existing trusted records.

## 11. Security and privacy

Deny by default; least privilege; defense in depth; short-lived authority; no secrets in the
mobile bundle; encrypted at rest + in transit; minimal logs; re-auth for high-impact actions;
privileged publication separate from normal user access.

- **Never in the mobile bundle**: DB password, service-role keys, signing keys, provider
  secrets, notification credentials, master encryption keys, reviewer credentials.
- **Local storage**: encrypted SQLite; key in Keystore/Keychain; AsyncStorage **not approved**
  for health/safety/consent/session data; temp capture artifacts deleted promptly.
- **Never logged**: diagnoses, medicine names tied to a profile, document names/content, full
  alert explanations, tokens, raw profile identifiers, label images.
- **Notifications**: generic lock-screen by default ("Kynviora has an important update").
- **Uploads**: MIME + magic byte validation, size/dimension/page limits, metadata stripping,
  malware scan, isolated parsing, safe previews, no active content, authorization on every
  download.
- **RLS deny-by-default** on every application table, independently tested with negative cases
  (unrelated household, partial caregiver, revoked, expired, stale session, foreign profile ID).
- India **DPDP** applies; qualified legal review required (cannot be satisfied by this build).
- Do **not** declare Kynviora "not a medical device" merely via a disclaimer.

## 12. Accessibility (`18`)

Senior accessibility is part of the product definition. Touch targets at least 48dp; system font
scaling without clipping; **never communicate meaning by color alone**; one primary action on
high-impact safety screens; no swipe-only/long-press-only core actions; permission denial is a
supported state; TalkBack semantics verified; safety copy follows the 8-part structure
(what happened / who+what / match exactness / recommended next step / why flagged /
evidence+source+date / limitation / correction action).

Forbidden copy: "This product is safe", "This medicine is dangerous", "AI detected a harmful
ingredient", unsanctioned "stop taking this medicine now".

## 13. Implementation stages (`04`)

| Stage | Title | MVP |
| --- | --- | --- |
| 0 | Reset, product contract, engineering foundation | yes |
| 1 | Identity, profiles, consent, session boundary | yes |
| 2 | Unified Health Shelf and item lifecycle | yes |
| 3 | Guided capture, extraction, Living Catalog bootstrap | yes |
| 4 | Medicine care workflows | yes |
| 5 | Personal-care formulation intelligence | yes |
| 6 | Global sources, regulatory registry, evidence, safety engine | yes |
| 7 | Safety Watch and Global Regulatory Lens experience | yes |
| 8 | Family collaboration, review inbox, Visit Pack | yes |
| 9 | Production hardening, validation, MVP beta | yes |
| 10-14 | Post-MVP expansion | no |

**MVP is complete at the end of Stage 9.**

## 14. Non-negotiable constraints

1. No universal safe/unsafe score. Ever.
2. Evidence level and action urgency are separate dimensions.
3. Absence of a matched rule is never approval or safety.
4. "Restricted" is never rendered as "banned".
5. GB and NI are separate jurisdictions.
6. AI output is a candidate; sources and deterministic validation are the evidence.
7. Same barcode + different formula => new formulation/conflict, never overwrite.
8. A user write can never directly mutate shared catalog or regulatory truth.
9. Assessments must be reproducible from stored versioned inputs.
10. Corrections supersede and remain auditable; history is never erased.
11. No autonomous instruction to start/stop/split/replace a prescription medicine.
12. Server is authoritative for safety severity and caregiver authorization.
13. Deny by default; RLS on every application table; negative authorization tests required.
14. Generic lock-screen notifications by default.
15. Real health data is never used in development or testing - synthetic fixtures only.
16. Never fabricate credentials, clinical review, legal approval, licensing, or integrations.
