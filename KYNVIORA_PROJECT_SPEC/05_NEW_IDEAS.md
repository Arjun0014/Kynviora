# New Product Ideas

Status: Idea backlog - not automatically approved scope
Last reviewed: 2026-08-29

## Purpose

This file separates promising ideas from committed MVP requirements. Ideas should move into
MVP or roadmap scope only after product, safety, data, privacy, and technical review.

The best ideas strengthen Kynviora's differentiating loop: identity -> evidence -> personal
relevance -> understandable change -> safe action -> care coordination.

## Promoted into committed MVP architecture after 2026-08-29 review

The following are no longer merely backlog ideas. They are now part of the committed MVP/data architecture and should be tracked through `03_MVP_DEFINITION.md` and `04_STAGES_AND_PHASES.md`:

### Living Catalog

A sparse/near-empty shared product catalog can grow from user-confirmed package observations. The system stores field assertions, formulation fingerprints, provenance, corroboration, conflicts, first/last-seen observations, and external verification. Crowd evidence can confirm **what the package says**; it never establishes medical safety by consensus.

### Global Regulatory Lens

Show how supported jurisdictions treat the same ingredient/product while preserving the exact legal distinction: prohibited, restricted, concentration/use condition, warning requirement, positive-list treatment, product/batch action, scientific opinion, no matched rule, or unknown. Initial targets are India, EU, GB, NI, US, and Japan.

### Citation Gate

Search-grounded/LLM research may discover and structure official material, but no regulatory fact is published unless the underlying allowed source is independently retrieved, retained/referenced, mapped to a canonical item/substance, and passes deterministic/human validation.

### Formulation Corroboration

Repeated independent captures can increase confidence that a formulation exists in a given market/time period. A disagreement creates a candidate new formulation or conflict rather than majority-vote overwrite.

## Priority A - Ideas that strengthen the MVP story

### 1. Product Trust Passport

What it is:
A compact trust panel on every medicine/personal-care item showing how well Kynviora actually
knows the item.

Possible fields:

- identity: confirmed/probable/unverified;
- formula/strength: verified/unverified;
- batch: confirmed/missing;
- ingredients/active ingredients: confirmed/partial;
- source count/types;
- last user review;
- last safety check;
- current coverage statement.

Why it matters:
Most apps hide data uncertainty. Making it visible is both useful and differentiating.

MVP recommendation: Build v1.

### 2. Evidence Diff

What it is:
When an assessment changes, show what changed since the prior trusted version.

Examples:

- new affected batch;
- formula changed;
- regulator updated instructions;
- Kynviora corrected an earlier match;
- evidence level changed but urgency did not.

Why it matters:
It proves Kynviora is a monitoring system, not a static lookup tool.

MVP recommendation: Build a narrow version.

### 3. Household Review Inbox

What it is:
A non-alarmist task inbox for incomplete or stale care data.

Examples:

- confirm this product's current label;
- add batch number;
- medicine not reviewed in 90 days;
- OCR field needs confirmation;
- caregiver permission expires soon;
- refill estimate needs review.

Why it matters:
Data quality becomes an understandable family workflow rather than hidden backend debt.

MVP recommendation: Build basic version.

### 4. Safety Receipt

What it is:
A durable history for significant alerts showing:

- the alert/evidence version received;
- why it matched;
- what action the user recorded;
- whether Kynviora later corrected/superseded it;
- when the item was re-checked.

Why it matters:
Creates trust, accountability, and useful support/incident context.

MVP recommendation: Build basic version for material alerts.

### 5. Coverage Disclosure Card

What it is:
A clear, always-available explanation of what Kynviora currently monitors for the user's
market and categories.

Why it matters:
Prevents "no alert" from being interpreted as "guaranteed safe."

MVP recommendation: Required.

### 6. Safety Rule Shadow Mode

What it is:
Run new/changed rules against synthetic or historical data without sending user alerts.

Why it matters:
Lets the team inspect expected match volume, false positives, and unexpected category effects
before publication.

MVP recommendation: Internal requirement.

### 7. Source Health Dashboard

What it is:
Internal operational dashboard showing source freshness, parser errors, queue lag, failed
imports, and last successful check.

Why it matters:
For Kynviora, a stale regulator feed is a user-safety issue, not merely an uptime issue.

MVP recommendation: Internal requirement.

## Priority B - High-value near-term ideas

### 8. Medicine Reconciliation Mode

Compare a person's previous medicine list with a prescription/discharge/new list.
Kynviora highlights differences but does not decide which instruction is medically correct.

Value:
Strong caregiver and hospital-transition use case.

### 9. Doctor/Pharmacist Handoff QR

Generate a short-lived, user-approved QR/link that exposes a selected Visit Pack without
requiring the professional to create a Kynviora account.

Requirements:

- short expiry;
- revocable;
- minimum data;
- access log;
- no search-engine indexing;
- re-authentication before creation.

### 10. Product Timeline

One timeline per item:

- first added;
- formula/pack changes;
- user stopped/started;
- safety alerts;
- label photos;
- review dates;
- corrections.

Value:
Makes a complex versioned model understandable.

### 11. "Why am I seeing this?" Inspector

A reusable explanation view that explicitly lists which profile facts, item facts, evidence,
and rule version contributed to a result.

Value:
Excellent for trust and support investigations.

### 12. Safety Coverage Map

Show coverage by category/jurisdiction/source type rather than simply saying "we monitor
safety."

Example:

- official medicine quality alerts: monitored;
- selected cosmetic alerts: monitored;
- global formula changes: partial;
- emerging research: not user-alerting in current release.

### 13. Formula Change Watch

When a user rescans an ingredient label, compare it with the previously confirmed formula and
highlight additions/removals/reordering without declaring the change good or bad.

### 14. Family Role Modes

Instead of a single "caregiver" role, offer task-oriented presets that map to granular grants:

- safety viewer;
- medicine helper;
- appointment helper;
- full family administrator.

Presets are conveniences, not hard-coded authorization roles.

### 15. Offline Emergency Card

A user-selected minimal offline view for critical identity/contact/allergy/current medicine
information.

It must not automatically expose the full health profile on the lock screen.

## Priority C - Later differentiation opportunities

### 16. Pharmacist Review Request

Allow a user to package a specific unresolved medicine/item question for a participating
pharmacist service. This is a business/clinical integration, not an AI answer feature.

### 17. Manufacturer Evidence Channel

Verified manufacturers could submit formula/pack updates into a review queue, never directly
publish safety outcomes.

### 18. Community Correction Signals

Users can report wrong photos, variants, or catalog matches. Reports create review work rather
than automatically editing trusted catalog data.

### 19. Privacy-Preserving Household Insights

Examples:

- "3 items need verification";
- "1 medicine refill estimate needs review";
- "2 labels have not been reviewed in a year."

Avoid creating anxiety-driven scores.

### 20. Local-language Safety Packs

Human-reviewed localized explanations for high-impact safety templates, supported by language
research with older adults. Machine translation may assist drafting but cannot be the only
validation for critical content.

### 21. Source Reliability History

Internal scoring/metadata about parser stability, correction frequency, latency, and known
field limitations for each external source. This informs operations and review priority, not a
public scientific-quality score.

### 22. Evidence Snapshot Export

Allow users to attach the exact evidence/source summary behind an alert to a Visit Pack, so a
professional can see what Kynviora is referencing.

### 23. "Check this again" User Request

Let users request re-evaluation after replacing a product, confirming a batch, uploading a
new label, or correcting profile context.

### 24. Trusted Household Change Log

A human-readable audit view for family actions:

- medicine updated by user;
- caregiver added appointment;
- profile owner revoked document access;
- safety alert marked discussed.

Hide low-level system noise while preserving the authoritative audit trail separately.

### 25. Regulatory Divergence Timeline

For a substance/product, show when supported jurisdictions changed status over time and whether the change was a prohibition, restriction amendment, scientific opinion, or product action. This is powerful but should follow a stable Global Regulatory Registry because historical legal reconstruction is operationally expensive.

### 26. "Why do countries differ?" Evidence Explorer

A deeper educational view explaining that jurisdictions may classify products differently, use different concentration thresholds, update at different times, or rely on different statutory frameworks. It must describe the source-backed difference without ranking countries as simply strict/weak.

## Ideas to avoid or postpone

### Universal safety score

Avoid. It collapses evidence, personal applicability, uncertainty, and urgency into one number.

### Open-ended medical AI chat

Avoid in MVP. It creates an authority path that conflicts with Kynviora's deterministic,
reviewed safety model.

### Product replacement engine

Postpone. Personal-care alternatives may eventually be useful, but formula verification,
availability, sponsorship conflicts, and medical relevance make "best alternative" risky.
Prescription substitution remains prohibited.

### Lifestyle Coach

Postpone until core product-market fit and governance capacity are established. It is a
separate content and clinical-risk surface.

### Symptom causality engine

Do not build. User-reported symptom/product timing may be stored as a neutral timeline
observation, but temporal association must not become an automated causality conclusion.

## Idea promotion checklist

Before moving any idea into committed scope:

- What exact user problem does it solve?
- Which Kynviora differentiation pillar does it strengthen?
- What new sensitive data does it require?
- Does it create new clinical/regulatory behavior?
- What authoritative data/source is required?
- What can go wrong if the result is incorrect?
- How will uncertainty be displayed?
- How will it be tested?
- Can it be disabled or rolled back?
- What should be removed or delayed to make room for it?
