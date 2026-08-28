# Observability, Incidents, and Operations

Status: Production operations source of truth
Last reviewed: 2026-08-29

## Objective

Operate Kynviora without leaking sensitive user information and detect failures that affect
safety, source freshness, authorization, and product trust.

## Observability principles

- Measure system behavior, not sensitive content.
- Source freshness is a safety metric.
- Reviewer queue age is a safety metric.
- Assessment correction/withdrawal must be observable.
- Use correlation IDs across request/job/publication flow.
- Alerts to operators should contain identifiers/codes, not medicine names or diagnoses.

## Core service metrics

- API availability/latency/error rate.
- Auth/session failure classes.
- Database/queue/object-storage health.
- Sync success, lag, conflict, retry rate.
- Mobile crash-free sessions.
- Route performance without sensitive payload.
- Push publication/delivery classes where provider data permits.

## Safety operations metrics

- last successful check per source;
- expected versus actual source freshness;
- parser success/failure rate;
- quarantined source records;
- candidate review queue age;
- high-impact pending review count;
- assessment evaluation success/failure;
- shadow-rule match volume;
- alert publication/withdrawal/correction rate;
- user wrong-match reports;
- suspected missed-alert reports;
- stale notification revalidation failures.

## Catalog/data metrics

- resolver success by provider/category;
- unresolved rate;
- provider timeout/quota errors;
- formula verification rate;
- batch capture rate;
- user correction rate;
- provider conflict rate;
- OCR error/confirmation rate by field/category.

## Source Health Dashboard

Every approved source should display:

- operational owner;
- jurisdiction/category;
- expected refresh cadence;
- last attempted check;
- last successful check;
- last new record;
- parser version;
- recent failures;
- current stale/degraded status;
- linked incident if any;
- user coverage impact summary.

## Alerting

Operational alerts should trigger for defined thresholds such as:

- critical source stale beyond tolerated window;
- ingestion/parser failure spike;
- review queue SLA breach;
- assessment processing failures;
- auth/authorization anomaly;
- unexpected alert-volume spike after rule publication;
- object upload malware finding spike;
- deletion/export job stuck;
- production error-rate regression after release.

Exact thresholds must be documented before production.

## Incident categories

### Security incident

Unauthorized access, credential compromise, malicious upload exploitation, admin compromise,
secret exposure.

### Privacy incident

Unintended disclosure, wrong caregiver access, overbroad export, sensitive notification leak.

### Safety/content incident

Incorrect high-impact alert, missed supported alert, incorrect rule, stale actionable
withdrawn content, harmful wording.

### Data integrity incident

Corrupt sync, wrong product/formula mapping at scale, lost user records, failed migration.

### Availability/source incident

Backend outage, source outage, queue failure, push disruption, provider failure.

## Living Catalog operational signals

Monitor without exposing user health payloads:

- exact formulation cache-hit rate;
- unknown-product/new-formulation rate;
- OCR/vision disagreement rate;
- user correction rate;
- catalog conflict rate;
- suspicious duplicate/corroboration activity;
- time from candidate -> corroborated/external verification;
- research/model fallback rate and spend;
- provider quota/circuit-breaker state.

Alert on abnormal spikes that could indicate parser/model regression, coordinated poisoning, provider change, or abuse-driven cost.

## Global Regulatory Registry operational signals

Per source/jurisdiction track:

- last successful fetch;
- expected versus actual freshness;
- content hash/change detection;
- parser/extraction success;
- Citation Gate rejection reasons;
- candidate review queue age;
- published regulatory record count/change volume;
- mapping conflicts;
- superseded record still shown rate (target zero);
- Regulatory Lens projection lag after publication/correction.

Critical runbooks must cover:

- source becomes stale/unreachable;
- legal source changes structure;
- model/parser misclassifies restricted as prohibited;
- a foreign status was shown under the wrong jurisdiction;
- a compromised/poisoned catalog observation affected shared formula data;
- a regulatory correction requires mass product-view recomputation.

## Incident response flow

1. Detect/report.
2. Triage severity and user impact.
3. Contain using feature/rule/source/publication controls.
4. Preserve evidence/logs safely.
5. Identify affected users/items without broad unnecessary data access.
6. Correct/restore.
7. Communicate according to approved safety/privacy/legal policy.
8. Validate recovery.
9. Root cause analysis.
10. Add tests/runbook/control improvements.

## Safety-specific emergency actions

Operators must be able to:

- pause source publication;
- disable a rule;
- withdraw an alert version;
- suppress a bad notification publication;
- force recomputation;
- mark coverage degraded;
- display a controlled service notice;
- preserve old versions for investigation.

## Runbooks required before beta

- source stale/outage;
- parser malformed data;
- wrong product mapping;
- false high-severity alert;
- suspected missed official alert;
- caregiver authorization leak;
- account/session compromise;
- reviewer account compromise;
- production secret exposure;
- upload malware/parser attack;
- database restore;
- mobile release rollback;
- rule/publication rollback;
- data deletion failure.

## On-call ownership

Before public beta, every critical dashboard/alert must have:

- primary owner;
- backup owner;
- escalation path;
- response expectation;
- authority to execute containment.

Do not create alerts no one owns.

## Audit versus observability

Operational logs answer "is the system healthy?"
Audit logs answer "who performed a sensitive action and what version changed?"

Keep both, but do not turn audit records into verbose copies of health content.
