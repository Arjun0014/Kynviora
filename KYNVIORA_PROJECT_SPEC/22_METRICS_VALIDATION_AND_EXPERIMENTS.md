# Metrics, Validation, and Experiments

Status: Product/safety measurement source of truth
Last reviewed: 2026-08-29

## Objective

Prove that Kynviora creates a meaningful difference: users maintain better item information,
receive more relevant safety changes, understand why they matter, and coordinate appropriate
follow-up without increased unsafe action or alarm fatigue.

Do not use screen time or notification volume as the primary definition of success.

## North-star product outcome

Percentage of active supported items that are sufficiently verified and monitored such that a
material supported safety change could be matched and explained to the correct profile.

This should be broken down by medicines and personal care rather than hidden in one aggregate.

## Identity/data-quality metrics

- active item verification rate;
- exact medicine identity rate;
- medicine strength/form confirmation rate;
- personal-care formula verification rate;
- batch/lot capture rate where relevant;
- ingredient normalization coverage for supported rule vocabulary;
- OCR confirmation/correction rate;
- unresolved item rate;
- item review freshness;
- catalog provider conflict rate.

## Safety system metrics

- supported official records ingested successfully;
- source freshness/latency;
- assessment computation success;
- reviewed alert publication latency;
- match precision by rule/category;
- estimated false-negative rate on labeled test sets;
- false-positive user report rate;
- correction/withdrawal rate;
- high-impact review queue age;
- notification deduplication success.

## User understanding metrics

In usability studies measure whether users can answer:

- Which item/person is affected?
- Is the match exact or uncertain?
- How urgent is this?
- How strong/official is the evidence?
- What should I do next?
- Does this alert mean the product is unsafe for everyone?

Track comprehension separately from task completion.

## Care coordination metrics

- caregiver invitation acceptance;
- successful permission configuration;
- revocation success/time-to-effect;
- Review Inbox completion;
- Visit Pack generation and intentional sharing;
- medicine reconciliation completion;
- percentage of unresolved safety items addressed/annotated.

## Medicine utility metrics

- reminder scheduling reliability;
- reminder delivery after restart/reboot where platform permits;
- dose-event duplicate rate;
- refill-estimate review/use;
- medicine-list freshness.

Do not interpret adherence metrics as clinical success without appropriate study design.

## Personal-care utility metrics

- successful front/ingredient label capture;
- formula verification rate;
- formula change detection/correction rate;
- sensitivity-rule comprehension;
- rate of wrong-product/formula reports.

## Living Catalog proof metrics

Measure whether the crowd-seeded catalog actually creates leverage:

- exact formulation cache-hit rate by category/market;
- percentage of lookups requiring no model/research call;
- new product/formulation rate;
- time from first observation to corroborated/external verification;
- independent corroboration count distribution;
- formulation conflict rate;
- false-merge/false-split rate;
- shared correction rate;
- average processing/provider/model cost: known product versus new product;
- abuse-triggered processing rate.

Do not promise exponential cost decline. Validate the actual curve and long-tail behavior.

## Global Regulatory Lens proof metrics

Measure separately by jurisdiction/source class:

- regulatory status/condition extraction precision;
- canonical ingredient/product mapping precision;
- effective-date/supersession accuracy;
- source freshness;
- Citation Gate acceptance error rate;
- percentage of supported products/ingredients with at least one current jurisdiction record;
- percentage with complete condition data versus condition-unknown;
- time from official source update to reviewed Kynviora publication;
- user comprehension: banned vs restricted vs scientific opinion vs no-match;
- rate of users incorrectly interpreting foreign status as local illegality or proven harm.

A key guardrail is **misleading simplification rate**, especially restricted -> banned and no-rule -> approved.

## MVP validation experiments added

### New-product capture test
Can first-time users capture the required package sides with acceptable effort and understand why Kynviora sometimes asks for another image?

### Cache-reuse demonstration
Measure latency/cost difference between the first verified observation and later same-formulation lookups.

### Formula-change test
Can users understand "possible formulation change" without assuming fraud or danger?

### Regulatory Lens comprehension
Give representative users cases where EU/GB/JP/US/IN statuses differ. Test whether they can accurately explain the difference and whether the UI avoids fear amplification.

## Guardrail metrics

- users disabling all safety notifications after alerts;
- alert dismissal without comprehension;
- self-reported anxiety/confusion attributable to wording;
- unsafe medicine action reported after Kynviora content;
- caregiver privacy complaints;
- accidental sensitive lock-screen exposure;
- support cases caused by false certainty;
- unauthorized access/privacy incidents;
- stale-source time;
- high-impact review backlog.

## Required release thresholds

Before beta, product/safety leadership must assign numeric thresholds to at least:

- medicine exact-match precision;
- personal-care formula-match precision for supported flows;
- batch-match precision;
- OCR critical-field accuracy/confirmation rule;
- safety-rule precision on labeled fixtures;
- source freshness tolerance;
- high-impact review SLA;
- correction publication SLA;
- reminder reliability;
- critical journey accessibility completion;
- alert comprehension target.

A metric without an accept/reject threshold cannot act as a release gate.

## MVP validation studies

### Study 1 - Medicine setup reality test

Participants add real-world medicine packs using synthetic/de-identified study handling where
required.

Measure:

- time/effort;
- exact strength/form success;
- batch/expiry success;
- correction rate;
- confidence understanding.

### Study 2 - Personal-care formula test

Participants add sunscreen/skin-care/personal-care products.

Measure:

- barcode identity accuracy;
- ingredient-label capture;
- formula verification comprehension;
- unresolved-state acceptance.

### Study 3 - Safety alert comprehension

Present official-action, sensitivity match, insufficient-data, and correction scenarios.

Measure understanding of urgency/evidence/match confidence and intended next action.

### Study 4 - Caregiver boundary test

Observe invitation, permission choice, accessing two profiles, and revocation.

Measure whether users understand who can see what.

### Study 5 - Kynviora differentiation test

Show users a standard medication reminder flow versus the full Kynviora identity/evidence
flow. Ask what they believe Kynviora uniquely does and whether they trust the distinction.

Success condition:
Users describe safety/evidence monitoring and exact-item confidence without being coached.

## Experiment constraints

Do not A/B test safety-critical wording solely for engagement. Safety copy changes require
controlled review and comprehension outcomes.

Do not experiment with withholding important high-severity alerts from a control group unless
an approved ethical/clinical study design explicitly permits it.
