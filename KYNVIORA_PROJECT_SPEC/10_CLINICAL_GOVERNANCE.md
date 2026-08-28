# Clinical and Safety Governance

Status: Required operating model before public safety alerts
Last reviewed: 2026-08-29

## Purpose

Kynviora's safety architecture is only trustworthy if qualified people, publication controls,
response times, and correction procedures exist in practice. This document defines the
minimum governance system required around user-facing safety content.

## Required roles

Before public Safety Watch alerts, assign named owners for:

- Clinical Safety Lead.
- Pharmacist/Medication Safety Reviewer.
- Product/Ingredient Safety Reviewer for supported personal-care rules.
- Regulatory Interpretation/Legal-Scope Reviewer for Global Regulatory Lens records where required.
- Regulatory and Source Operations Owner.
- Safety Content/Plain-Language Owner.
- Privacy and Security Owner.
- Incident Response Owner.
- Engineering Safety-System Owner.

One person may hold more than one role in an early team only if independence requirements for
high-impact approval are still met.

## Separation of duties

High-impact publication should not depend on one person performing all of:

- source ingestion;
- rule authoring;
- clinical approval;
- publication;
- post-publication correction approval.

Define which urgency/evidence classes require two-person approval.

## Source onboarding process

Before a source can influence user assessments:

1. Identify owner and jurisdiction.
2. Review authority and intended meaning of records.
3. Review legal/license/attribution/redistribution requirements.
4. Document update frequency and expected delay.
5. Document known field/data limitations.
6. Define parser validation fixtures.
7. Define source outage/staleness behavior.
8. Approve coverage statement.
9. Add monitoring and named operational owner.

## Global Regulatory Registry governance

Regulatory comparison is a separate publication responsibility from clinical safety assessment. Before a jurisdiction-specific status is user-visible, policy must define:

- which source classes may establish legal status;
- how primary law/regulation outranks informational databases/secondary summaries;
- how restrictions with concentration/product-type/age/route/warning conditions are represented;
- how scientific opinions are labeled separately from law;
- who reviews translations or AI-extracted legal conditions;
- how effective dates/amendments/supersession are tracked;
- what happens when a source is stale or a jurisdiction cannot be confidently mapped.

The review team must not publish a simple "banned" label when the actual source is conditional/restricted. Likewise, "no matched restriction" cannot be approved as "legal", "safe", or "regulator approved" without an authority that actually supports that claim.

Great Britain and Northern Ireland require separate scope review when applicable.

## Rule authoring process

Every rule needs:

- user safety problem;
- population/context;
- supported item categories;
- evidence sources;
- required profile/item provenance;
- exact matching criteria;
- exclusion criteria;
- evidence classification;
- allowed urgency;
- allowed user action language;
- limitations;
- reviewer(s);
- test fixtures;
- shadow-mode result where required;
- review/expiry date.

## Review states

Suggested workflow:

- Draft.
- Technical/data review.
- Clinical/product-safety review.
- Content review.
- Shadow validation.
- Approved.
- Published.
- Superseded/withdrawn.

## High-severity publication checklist

Before publication, reviewer must verify:

- source authenticity/current version;
- exact jurisdiction;
- affected product/formulation/batch identifiers;
- rule matching behavior;
- user action wording;
- medication boundary compliance;
- expected matched-user volume;
- notification policy;
- rollback/withdrawal readiness;
- support/incident owner.

## Operational response model

Define service objectives for:

- source check freshness;
- parser failure investigation;
- candidate high-impact alert review;
- user false-match reports;
- correction publication;
- emergency withdrawal;
- security/privacy escalation.

The exact times are a governance decision and must be measurable. Do not promise response
speeds publicly before the team can operationally meet them.

## False-positive investigation

When a user reports a wrong alert:

1. Preserve the report and affected assessment version.
2. Determine whether owned-item/profile input was wrong.
3. Check catalog/formulation/batch evidence.
4. Check source parsing.
5. Replay rule version.
6. Determine local-user correction versus shared-system defect.
7. Correct/recompute as needed.
8. Notify materially affected users according to correction policy.
9. Add regression fixture.

## Potential false-negative investigation

Treat reports that Kynviora missed an applicable official action as high priority.

Investigate:

- source coverage/outage;
- ingestion latency;
- parser failure;
- product identity coverage;
- batch normalization;
- rule eligibility;
- profile/item data quality;
- notification delivery versus assessment creation.

Do not hide missed coverage behind "the user entered the data wrong" without evidence.

## Safety incident levels

Define an internal incident classification distinct from user-facing alert urgency.

Examples requiring safety incident review:

- incorrect high/critical action sent;
- applicable official recall systematically missed;
- cross-profile data exposure affecting safety decisions;
- stale withdrawn alert remains actionable;
- rule publishes outside approved jurisdiction;
- reviewer account or publication pipeline compromised;
- material source parser corruption.

## Emergency controls

The system must support:

- disable one rule version;
- disable one source adapter;
- block publication globally;
- withdraw one alert publication;
- force assessment recomputation;
- invalidate stale notification deep links;
- show controlled service/coverage degradation message;
- preserve audit evidence.

## AI use in review

AI can assist with product/regulatory source discovery, extraction, translation drafts, deduplication, amendment comparison, and plain-language drafts. Reviewers must be able to inspect the underlying allowed source. Search/LLM output is an untrusted discovery artifact and cannot independently establish legal status, publish, set urgency, or manufacture missing product identity. A regulatory candidate must pass the Citation Gate before publication.

## Governance audit artifacts

Retain appropriate records of:

- who reviewed;
- source/evidence versions;
- rule version;
- approval timestamps;
- material edits between approval and publication;
- publication target/jurisdiction;
- correction/withdrawal reason;
- incident linkage;
- regression tests added.

## Scheduled governance review

At least periodically and before major expansion, review:

- rules older than their approved review interval;
- sources with recurring quality problems;
- alert false-positive/false-negative metrics;
- user comprehension;
- unresolved safety reports;
- changes in regulation/platform policy;
- whether a feature's implemented behavior still matches its approved intended use.
