# External References

Status: Reference index, not a substitute for release-time verification
Last reviewed: 2026-08-29

## Purpose

These resources inform the current technical, security, identity, and regulatory-source design. External rules, standards, APIs, and legal texts change. Re-check the current official version, applicability, and reuse/license terms before implementation and again before public release.

## Mobile platform

### Expo SDK reference
https://docs.expo.dev/versions/latest/

### Expo project creation
https://docs.expo.dev/get-started/create-a-project/

### Expo changelog
https://expo.dev/changelog

### React Native releases
https://reactnative.dev/blog

## Mobile security

### OWASP Mobile Application Security Testing Guide
https://mas.owasp.org/MASTG/

Use the current MASVS/MASTG version at review time.

## Google Play health policy

### Health Content and Services
https://support.google.com/googleplay/android-developer/answer/16679511

### Health apps declaration guidance
https://support.google.com/googleplay/android-developer/answer/14738291

## India privacy/regulatory

### MeitY Acts and Policies
https://www.meity.gov.in/documents/act-and-policies

### CDSCO Cosmetics Rules
https://cdsco.gov.in/opencms/opencms/en/Acts-and-rules/Cosmetics-Rules/

### CDSCO Alerts
https://www.cdsco.gov.in/opencms/opencms/en/Alerts/

Evaluate the exact current official alert/NSQ/quality/action pages and machine-readable behavior before adapter implementation.

### Bureau of Indian Standards
https://www.bis.gov.in/

Use exact applicable standards/current government references only after legal/source review; do not assume all BIS material is freely redistributable.

## European Union cosmetics and product safety

### Regulation (EC) No 1223/2009 on cosmetic products - EUR-Lex
https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32009R1223

Use current consolidated text and amendments. Annexes contain prohibited/restricted/positive-list conditions.

### European Commission CosIng
https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-ingredient-database_en

The Commission states that CosIng is informational/non-legally binding; Regulation 1223/2009 and its Annexes establish legal use conditions.

### EU Safety Gate
https://ec.europa.eu/safety-gate/

Official dangerous non-food product alert/action system.

### Scientific Committee on Consumer Safety (SCCS) opinions
https://health.ec.europa.eu/scientific-committees/scientific-committee-consumer-safety-sccs/sccs-opinions_en

Store SCCS opinions as scientific/expert evidence unless/until a corresponding legal instrument changes status.

## Great Britain and Northern Ireland cosmetics

### GOV.UK Cosmetic Products Enforcement Regulations guidance
https://www.gov.uk/government/publications/cosmetic-products-enforcement-regulations-2013

This page links separate Great Britain and Northern Ireland guidance. Treat GB and NI as separate internal jurisdictions where applicable.

### Great Britain cosmetics guidance
https://www.gov.uk/guidance/making-cosmetic-products-available-to-consumers-in-great-britain

### UK product safety alerts/reports/recalls
https://www.gov.uk/product-safety-alerts-reports-recalls

### UK legislation
https://www.legislation.gov.uk/

Use exact current statutory instruments/amendments for legal status rather than secondary summaries.

## United States cosmetics

### FDA prohibited/restricted cosmetics information
https://www.fda.gov/cosmetics/cosmetics-laws-regulations/prohibited-restricted-ingredients-cosmetics

### FDA Cosmetics Safety Q&A - prohibited ingredients
https://www.fda.gov/cosmetics/consumers/cosmetics-safety-qa-prohibited-ingredients

FDA notes that, apart from areas such as color additives and certain prohibited/restricted ingredients, most cosmetic ingredients/products are not simply "FDA approved" before market. Kynviora must not convert absence of a matched prohibition into approval.

### FDA Cosmetics laws/regulations landing area
https://www.fda.gov/cosmetics/cosmetics-laws-regulations

Use current official recall/enforcement sources selected during adapter implementation.

## Japan cosmetics

### MHLW cosmetics/quasi-drug information
https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/kenkou_iryou/iyakuhin/keshouhin/index.html

This official page links the Japanese Standards for Cosmetics and related notices.

### MHLW Standards for Cosmetics (English/provisional translation resource)
https://www.mhlw.go.jp/content/001257665.pdf

Primary Japanese material/current notices should be checked when legal interpretation matters; translation is reviewer assistance, not a replacement for the official source.

## Product and chemical identity

### GS1 Verified by GS1
https://www.gs1.org/services/verified-by-gs1

### GS1 Verified by GS1 information description
https://support.gs1.org/support/solutions/articles/43000734119-what-information-is-available-in-verified-by-gs1-

Useful for company/basic product identity. It does not prove current formulation; access/API/commercial terms require review.

### PubChem PUG REST
https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest

Useful for chemical identifiers/synonyms/reference normalization. Respect usage/rate limits and do not treat PubChem as a legal-regulatory status source.

## Medicine normalization/reference candidates

### RxNorm
https://www.nlm.nih.gov/research/umls/rxnorm/index.html

Useful medicine normalization terminology, especially for US-linked vocabularies; assess applicability to Indian marketed-product identity separately.

### DailyMed web services
https://dailymed.nlm.nih.gov/dailymed/app-support-web-services.cfm

US structured label reference; not proof that an Indian formulation/label is identical.

### openFDA drug label API
https://open.fda.gov/apis/drug/label/

US label/reference data; preserve jurisdiction limits.

## Reference-use rules

- Prefer the most authoritative current official source for legal/regulatory status.
- Informational databases may support identity/context but do not override primary law.
- Record source version/date/effective date and exact scope/conditions.
- Public availability does not grant unrestricted database copying or republication.
- Search/LLM output is discovery, not evidence.
- A user-facing regulatory record must pass the Citation Gate.
- Never infer "approved" or "safe" from absence of a matched rule.
- Re-check all URLs, currentness, applicability, and terms at implementation/release time.
