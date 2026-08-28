# Source Registry, Global Regulatory Coverage, and Citation Gate

Status: Operational template and MVP source policy
Last reviewed: 2026-08-29

## Purpose

Kynviora must never vaguely claim to "monitor health information" or "check global bans." Every source has a precise jurisdiction, authority class, legal/reuse status, expected freshness, parser/adapter, and user-facing coverage limit.

The registry supports three distinct systems:

1. Living Catalog/product identity;
2. Global Regulatory Registry/Regulatory Lens;
3. Safety Watch evidence/rules.

A source may support one and be prohibited from influencing another.

## Source classes

### A. Primary legal/regulatory source

Law, regulation, official annex/schedule/amendment, or other primary material with direct legal effect. Preferred for legal status.

### B. Official regulator/government action registry

Official recalls, quality alerts, withdrawals, safety actions, enforcement notices, product alerts.

### C. Official guidance/explanatory source

Government/regulator explanation of the legal framework. Useful for interpretation but does not override primary law.

### D. Official scientific/expert opinion

Scientific committee or expert opinion. Must remain distinct from law/prohibition unless/until legal action implements it.

### E. Identity/normalization reference

GS1/product identity, medicine terminology, INCI/chemical reference, etc. Supports identity/normalization; not automatically a safety source.

### F. Manufacturer/brand evidence

Useful for product/formulation identity. It does not override regulator status.

### G. Community/commercial discovery source

Can help find candidate identity/formulation. Licensing and accuracy vary; treat as proposal unless independently trusted for the specific field.

### H. Search/LLM research result

Discovery artifact only. Never source-of-truth. Must resolve to an underlying allowed source.

## Registry fields

For every source/provider/feed:

- internal source ID;
- organization;
- source name;
- source class;
- jurisdiction/geographic scope;
- product categories;
- authority/legal role;
- canonical URL/endpoint internally recorded;
- legal/license/terms review status;
- allowed storage/snapshot/redistribution/derived-use behavior;
- required attribution;
- expected update cadence;
- Kynviora polling/ingestion cadence;
- parser/adapter version;
- raw preservation policy;
- checksum/versioning method;
- operational owner;
- regulatory/clinical owner;
- known limitations;
- current health status;
- last successful check;
- coverage statement text;
- allowed influence: identity / regulatory-lens / safety-rule / discovery only;
- human-review requirement.

## Legal-status authority hierarchy

When determining a regulatory status, prefer the most authoritative applicable current source. Informational databases and summaries cannot silently override primary legal text.

For example, the European Commission's CosIng database is useful for ingredient identity and contextual data, but the Commission itself states that CosIng is informational/non-legally binding; Regulation (EC) No 1223/2009 and its Annexes establish whether and under what conditions substances may be used in EU cosmetics.

## Citation Gate

No regulatory status is published unless the candidate has:

- canonical substance/product identity;
- jurisdiction;
- source authority/class;
- exact status;
- exact scope/conditions/thresholds;
- legal/notice/annex/reference where available;
- publication/effective date;
- source snapshot/reference/checksum/version where allowed;
- traceable source location/context;
- extraction/parser/model version;
- deterministic validation;
- required regulatory/human review;
- supersession/currentness relation.

If any critical field is unresolved, publish `UNKNOWN_OR_INSUFFICIENT` or keep the record internal rather than inventing a conclusion.

## Initial MVP regulatory adapter targets

### India

Candidate official sources include:

- CDSCO Cosmetics Rules and official cosmetics/drug regulatory publications;
- CDSCO alerts, NSQ/spurious/quality/product actions as applicable;
- BIS standards/references where legally/reliably usable and relevant.

Exact licensing/reuse, structure, update cadence, and machine-readability must be reviewed per source.

### European Union

Core legal source:

- Regulation (EC) No 1223/2009 on cosmetic products and current Annexes/amendments via EUR-Lex.

Supporting sources:

- European Commission CosIng for ingredient identity/context (informational; no legal value by itself);
- EU Safety Gate for official dangerous non-food product alerts/actions;
- Scientific Committee on Consumer Safety (SCCS) opinions as scientific-opinion records, not automatic bans.

### Great Britain

- current GB cosmetics regulation/guidance and amendments through GOV.UK/legislation.gov.uk;
- Office for Product Safety and Standards (OPSS) product safety alerts/reports/recalls.

Store GB separately from NI.

### Northern Ireland

- EU Cosmetics Regulation as applicable under the Windsor Framework plus current UK government NI guidance;
- applicable EU/NI product-action sources.

Do not copy a GB status into NI or vice versa without source-backed equivalence.

### United States

- FDA cosmetics prohibited/restricted ingredient material;
- FDA recalls/enforcement/product safety sources where applicable;
- other official FDA cosmetic legal/guidance material required for precise scope.

Important UX/data rule: because the US framework does not amount to premarket FDA approval of most cosmetic ingredients/products, "no matched federal prohibition" must not become "FDA approved."

### Japan

- Ministry of Health, Labour and Welfare (MHLW) Standards for Cosmetics and current related notices;
- official Japanese product/regulatory action sources selected during adapter implementation.

Japanese-language primary material may be translated/extracted by AI for reviewer assistance, but the Japanese official source remains authoritative.

## Initial identity/normalization sources to evaluate

### GS1 / Verified by GS1

Useful for GTIN/company/basic product identity where access/terms allow. Does not prove current formulation. Review API/access limits and commercial terms before production use.

### PubChem

Useful for chemical identifiers/synonyms through PUG REST/bulk resources. Treat it as normalization/reference data, not a legal-regulatory status database. Respect usage policies/rate limits.

### CosIng/INCI-related identity

Useful for cosmetic ingredient naming/context in the EU ecosystem, subject to its informational status and applicable terms.

### Medicine terminology/reference

Select legally usable medicine normalization/label sources appropriate to India and supported markets. Do not treat a US medicine label as authoritative proof of an Indian marketed formulation.

### Public/community product catalogs

May improve discovery coverage but require explicit license review. Public availability does not automatically grant unrestricted copying into a proprietary database.

## Living Catalog source policy

User package evidence is a first-class observation source for **package identity/formulation**. It is not a regulatory or safety authority.

Shared-state progression can use:

- single user-confirmed observation;
- independent corroborating observations;
- approved manufacturer evidence;
- approved identity-provider evidence;
- reviewer decision.

A user report cannot directly mutate shared catalog truth. Raw user images remain private/internal evidence by default.

## Search/LLM research policy

Research agents may:

- locate official documents;
- locate manufacturer pages;
- map synonyms/candidate identifiers;
- compare amendments;
- extract candidate tables/conditions;
- translate for review.

They may not:

- act as the cited source;
- publish a regulatory status;
- fill a missing concentration/condition;
- turn a blog/secondary summary into legal truth when an official source is required.

## Source status

- ACTIVE;
- DEGRADED;
- STALE;
- DISABLED;
- REVIEW_REQUIRED.

Publication policy must define what happens when a source needed for a current claim becomes stale.

## Coverage matrix template

| System | Category | Jurisdiction | Source | Authority class | Identity depth | Formula/batch/condition support | Update target | User influence | Known gaps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Regulatory Lens | Cosmetics ingredient law | EU | EUR-Lex regulation/annexes | primary legal | substance | conditions/concentration/product type | TBD | regulatory status | parsing/amendments |
| Regulatory Lens | Cosmetics ingredient law | GB | GOV.UK/legislation sources | primary/gov | substance | conditions vary | TBD | regulatory status | divergence/change tracking |
| Regulatory Lens | Cosmetics ingredient law | NI | EU law + NI guidance | primary/gov | substance | EU conditions | TBD | regulatory status | framework updates |
| Regulatory Lens | Cosmetics ingredient rules | US | FDA official sources | regulator/legal | substance | source-dependent | TBD | regulatory status | no universal premarket approval |
| Regulatory Lens | Cosmetics standards | JP | MHLW | primary/regulator | substance | restrictions/limits | TBD | regulatory status | translation/source evolution |
| Regulatory Lens/Safety | Official actions | IN | CDSCO | regulator action | product/batch | source-dependent | TBD | Lens + reviewed alerts | fragmented formats |
| Catalog | Product identity | Global/markets | GS1/approved provider | identity | GTIN/company/product | no formula proof | provider-specific | identity only | access/coverage |
| Normalization | Chemical identity | Global | PubChem | reference | substance | identifiers/synonyms | provider-specific | normalization only | not legal status |

Replace `TBD` before public coverage claims.

## User-facing coverage disclosure

Show:

- jurisdictions monitored;
- source categories;
- last check/freshness;
- product/formula/batch/condition match depth;
- known gaps;
- "no matched rule/alert" limitation;
- separate unknown/stale states.

Do not show a flag/color without written status and scope. Do not rank jurisdictions as simply stricter/weaker.

## Source onboarding acceptance tests

- official/provider origin verified;
- source class/authority recorded;
- legal/terms review recorded;
- representative normal/edge fixtures captured;
- parser handles empty/malformed/revision cases;
- dates/time zones/effective dates normalized;
- conditions/thresholds preserve units and boundaries;
- duplicate records are idempotent;
- correction/supersession behavior tested;
- source outage/staleness alert tested;
- Citation Gate tested;
- coverage copy approved.

## Source change management

Trigger review on endpoint/schema/terms changes, amendment/new legal version, abnormal parser errors, translation issues, organization publication changes, source outage, category/jurisdiction expansion, or new identifier semantics.
