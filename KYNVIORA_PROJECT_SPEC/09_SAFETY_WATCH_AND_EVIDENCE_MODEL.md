# Safety Watch, Global Regulatory Lens, and Evidence Model

Status: Safety/product architecture source of truth
Last reviewed: 2026-08-29

## Purpose

Kynviora maintains two related but distinct user-facing knowledge paths:

1. **Global Regulatory Lens** - what supported regulators/laws/actions say about a substance/product in their own jurisdiction.
2. **Safety Watch** - reviewed, reproducible Kynviora assessments that determine whether an item/person needs attention and what bounded action language is allowed.

A foreign prohibition/restriction is evidence/context. It is not automatically a personalized medical conclusion for a user in another jurisdiction.

## Core rule: regulation, scientific opinion, and safety assessment are different

Never collapse:

- law/regulation;
- official product recall/withdrawal/action;
- official guidance;
- scientific committee opinion;
- peer-reviewed evidence;
- product label statement;
- Kynviora personalized assessment.

Each has its own authority and scope.

## Global Regulatory Lens statuses

The registry/UI must support conditions rather than a single red/green flag. Controlled examples:

- `PROHIBITED` - official source prohibits the substance/product for the relevant scope.
- `RESTRICTED` - permitted only under specified conditions.
- `CONCENTRATION_LIMIT` - maximum/minimum concentration rule applies.
- `USE_CONDITION` - product type, rinse-off/leave-on, professional use, etc. matters.
- `AGE_OR_ROUTE_CONDITION` - age group, oral/mucosal, skin/route, or similar condition matters.
- `WARNING_REQUIRED` - required wording/label condition.
- `POSITIVE_LIST_ONLY` - category/function allowed only if listed/authorized under that framework.
- `PRODUCT_ACTION` - recall, withdrawal, marketing restriction, quality action, batch action, etc.
- `SCIENTIFIC_OPINION` - official/expert scientific opinion that is not itself the legal status.
- `NO_MATCHED_RULE_WITHIN_COVERAGE` - monitored sources checked; no applicable record matched.
- `UNKNOWN_OR_INSUFFICIENT` - source coverage, mapping, concentration, product use, or currentness is insufficient.

Multiple statuses/conditions may apply simultaneously.

## Initial regulatory jurisdictions

MVP adapter targets:

- India (`IN`);
- European Union (`EU`);
- Great Britain (`GB`);
- Northern Ireland (`NI`);
- United States (`US`);
- Japan (`JP`).

GB and NI are separate internal jurisdictions. NI may follow EU cosmetics rules in areas where the Windsor Framework applies; GB can diverge. Do not flatten them into a single UK status.

## Important interpretation rules

### "Restricted" is not "banned"

A restriction may depend on concentration, product type, route, age, warning, or other condition. If the package does not disclose the needed concentration/context, the correct output is normally "cannot determine compliance from available package data," not "banned."

### "No matched rule" is not "approved"

Especially in frameworks where most cosmetic ingredients do not receive premarket approval, absence of a matched prohibition/restriction must never render as regulator approval or universal safety.

### Foreign status is not local legal advice

Show the exact foreign regulatory fact and date, plus the user's/home market status where supported. Avoid value judgments such as "strict country" or "weak regulation."

## Regulatory source hierarchy

For legal status, prefer:

1. primary/consolidated law/regulation and official amendments;
2. official regulator rules/databases that have legal effect;
3. official government guidance explaining the rule;
4. official scientific committee opinions (separate status);
5. secondary discovery sources only to locate the official material.

Example principle: an informational ingredient database may help normalize names, but the binding annex/regulation determines legal status.

## Citation Gate

No shared regulatory status is published unless the candidate has, as applicable:

- canonical substance/product identity;
- jurisdiction;
- source organization;
- source class/authority;
- exact status;
- exact scope/conditions;
- legal/notice reference;
- publication/effective date;
- retained source snapshot/reference/checksum where allowed;
- parser/extraction version;
- validation/review state;
- supersession/currentness relation.

A search engine, Perplexity-style answer, or LLM output can help **find** or **extract** this information. It cannot itself satisfy the source requirement.

## MVP Safety Watch signal types

### Medicines

- official recall/safety/quality action from supported source;
- exact/probable batch or product match;
- expiry;
- narrow approved allergy-related rule where reference quality permits;
- narrow duplicate active-ingredient rule after clinical validation;
- product/label information change requiring review;
- insufficient identity/data.

### Personal care

- official recall/safety/quality/product action;
- batch/product match when available;
- expiry where relevant;
- narrow reviewed ingredient sensitivity/allergy matching;
- formulation/ingredient declaration change requiring review;
- reviewed safety rule based on approved evidence;
- insufficient identity/formula data.

Foreign regulatory changes may appear as **informational regulatory updates**. They become personalized Safety Watch warnings only through an approved rule/policy.

## Evidence levels

Evidence strength and action urgency remain separate:

- A - Official action.
- B - Established authoritative guidance/label/monograph reviewed for the rule.
- C - Strong reviewed evidence.
- D - Limited evidence suitable for review, not alarm.
- E - Emerging signal, normally internal monitoring in MVP.
- U - Unknown/insufficient.

A regulatory status record should also retain its **source authority class**; evidence level alone should not erase the difference between law, scientific opinion, and literature.

## Action urgency

- CRITICAL - time-sensitive approved action for potential serious harm.
- HIGH - prompt professional/official action needed.
- MEDIUM - review soon.
- LOW - preventive/non-urgent follow-up.
- INFORMATIONAL - relevant update, no immediate action.

A foreign ingredient restriction should normally default to INFORMATIONAL unless a separate reviewed rule establishes a stronger action for the user's context.

## Match confidence

- EXACT;
- PROBABLE;
- UNCONFIRMED;
- NOT_MATCHED.

Regulatory applicability may also require a separate `CONDITION_UNKNOWN` when concentration/use details needed by the law are absent.

## Product states

Avoid universal safe/unsafe:

- No current matched alert - no applicable reviewed Kynviora alert found within current coverage.
- Information - relevant update without immediate action.
- Review - user should confirm item/context or discuss appropriately.
- Action required - approved action wording based on urgency.
- Insufficient data - item/context cannot be matched reliably.

Global Regulatory Lens statuses are shown beside, not substituted for, this safety state.

## Source-to-registry pipeline

1. Approved source adapter fetches material.
2. Preserve/reference exact source version and checksum where allowed.
3. Detect material change.
4. AI/parser may extract structured **candidate** rules/actions and translate/compare amendments.
5. Canonical substance/product/market mapping.
6. Schema/deterministic validation.
7. Citation Gate.
8. Human/regulatory review according to risk.
9. Publish versioned regulatory record.
10. Recompute affected Regulatory Lens projections.
11. Trigger Safety Watch rule reevaluation only where a reviewed dependency exists.

## Safety assessment pipeline

1. Select approved evidence/rule versions.
2. Select exact owned item/formulation/batch/profile versions.
3. Check required provenance and identity confidence.
4. Apply deterministic rule.
5. Create immutable assessment version.
6. Apply publication policy/review.
7. Publish alert/version.
8. Synchronize minimal notification signal.
9. Support correction, supersession, withdrawal, and replay.

## Assessment requirements

Store exact references to profile facts, owned item, product/formulation/batch, source/evidence, regulatory record if used, rule, normalization version, match confidence, evidence level, urgency, explanation template, reviewer/publication state. Replaying the same versions must reproduce the result.

## Global Regulatory Lens user requirements

For each supported jurisdiction show:

- jurisdiction name/flag as supplemental visual, with text label;
- status and exact condition;
- ingredient/product matched;
- match confidence/identity used;
- authority/source;
- legal/notice/annex reference where available;
- publication/effective date;
- Kynviora last-verified/source-freshness date;
- whether concentration/use data are missing;
- what the result does **not** mean.

Example safe copy patterns:

- "Restricted in EU cosmetics under specified conditions. Your package does not disclose the concentration required to determine whether this limit is exceeded."
- "No matched federal prohibition found in Kynviora's monitored US cosmetic-ingredient sources. This is not FDA approval or a guarantee of safety."
- "A scientific committee opinion exists; Kynviora has not identified a corresponding legal prohibition in the monitored sources as of the stated check date."

## Personalized alert requirements

Show affected person/item, reason, match confidence, evidence level, urgency, source/jurisdiction/date, safe next action, limitations, source details, report-incorrect, and resolution controls.

## Medication safety language

Never tell a user to stop/start/split/replace a prescription medicine based solely on Kynviora. Present reviewed jurisdiction-specific official action language when applicable and direct the user to the appropriate professional/official channel.

## Personal-care language

Do not generalize an ingredient regulatory difference into "this brand is dangerous" or "unsafe for everyone." Explain the exact ingredient/formulation, jurisdiction, conditions, evidence, personal relevance (if any), and uncertainty.

## Evidence and Regulatory Diff

Version changes may include:

- legal status changed;
- concentration/use/age/warning condition changed;
- amendment became effective;
- product/batch action changed;
- scientific opinion published/updated;
- product formulation changed;
- canonical mapping corrected;
- source parser corrected;
- Kynviora rule/evidence/urgency changed.

UI must distinguish "regulator changed the rule" from "Kynviora corrected our interpretation."

## Corrections and withdrawal

Preserve original history, state what changed, recompute dependent lenses/assessments, invalidate stale actionable notifications, notify materially affected users according to policy, and generate audit/Safety Receipt history.

## Coverage disclosure

Expose supported jurisdictions, source categories, last successful checks, unsupported categories, known gaps, and the rule that absence of a matched concern/restriction does not prove universal safety or legality.
