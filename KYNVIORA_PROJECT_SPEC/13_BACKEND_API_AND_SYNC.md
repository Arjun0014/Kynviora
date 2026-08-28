# Backend, API, and Sync Architecture

Status: Engineering source of truth
Last reviewed: 2026-08-29

## Backend strategy

Start with a modular monolith plus asynchronous workers.

Recommended infrastructure baseline:

- PostgreSQL through a dedicated Supabase project or equivalent managed PostgreSQL.
- Managed authentication.
- Private object storage.
- Edge/server functions or API service for privileged operations.
- Managed job queue for ingestion/processing/replay.
- Optional search index only for non-authoritative discovery.

Do not introduce microservices until workload, ownership, scaling, or isolation requirements
justify them.

## Mobile-to-backend boundary

Expose a versioned authenticated API contract for product behavior. Supabase RLS remains an
important database authorization layer, but the application should not rely on broad direct
table access for safety-sensitive or privileged workflows.

Example resources:

```text
/v1/session
/v1/households
/v1/profiles
/v1/profile-facts
/v1/items
/v1/medicines
/v1/personal-care
/v1/catalog/resolve
/v1/catalog/observations
/v1/formulations
/v1/regulatory-lens
/v1/schedules
/v1/dose-events
/v1/review-tasks
/v1/caregiver-grants
/v1/assessments
/v1/alerts
/v1/visit-packs
/v1/evidence-assets
/v1/sync
```

Internal/admin APIs are separately authenticated/authorized and not exposed as user APIs.

## API contract rules

- HTTPS only.
- OpenAPI-described where practical.
- Runtime input/output schema validation.
- Stable machine-readable error codes.
- Cursor pagination.
- Server time returned for sync-sensitive responses.
- Idempotency key on mutations that can be retried.
- Version/ETag/precondition for mutable records.
- Request/body size limits.
- Rate limits per account/device/IP where appropriate.
- No access tokens, diagnoses, medicine names, warnings, or document filenames in URL query
  strings when avoidable.

## Authorization

Every request derives authority from authenticated user/session and server-side grants.
Never trust a profile ID in the request as proof of access.

Database RLS policies should be deny-by-default and independently tested with:

- unrelated households;
- caregiver with partial permissions;
- revoked caregiver;
- expired grant;
- profile removed from grant;
- old cached token/session;
- staff/admin boundaries.

## Privileged server-only operations

Examples:

- caregiver grant creation/revocation finalization;
- shared catalog approval;
- source/rule publication;
- safety assessment publication;
- audit-event creation for privileged actions;
- export generation involving cross-record aggregation;
- account deletion orchestration;
- provider credential use;
- notification dispatch.

## Sync protocol

Use per-household or per-profile cursors with stable change sequence.

Client write flow:

1. Create local pending operation with UUID/idempotency key.
2. Apply optimistic local change only if low risk.
3. Upload on authenticated connectivity.
4. Server validates authorization, precondition/version, and payload.
5. Server commits exactly once.
6. Client marks operation committed or enters resolvable failure state.

Pull flow:

1. Request changes after committed cursor.
2. Validate response.
3. Apply all changes in one local transaction/bounded batch.
4. Commit local database.
5. Advance cursor.

## Conflict policy

Define by entity type.

Examples:

- dose events: merge by event ID;
- user notes: version conflict can request user resolution;
- profile facts: do not silently last-write-wins if clinically relevant;
- caregiver grants: server wins;
- safety assessments/publications: server wins;
- product confirmation: create new assertion/version rather than overwriting history;
- catalog formulation conflict: create separate candidate/conflict and preserve both histories;
- regulatory status: server-authoritative versioned publication; clients never merge competing legal records locally.

## Source ingestion workers

Workers:

- fetch only approved registry sources;
- enforce timeouts/body limits/content-type checks;
- store raw reference/checksum where permitted;
- parse in isolated workflow;
- mark parser/version/confidence;
- quarantine invalid records;
- deduplicate idempotently;
- never directly send user alerts from parser output.

## Catalog provider integration

All commercial/public provider keys are server-side. Implement:

- provider adapters;
- quotas/rate limits;
- retry with bounded backoff;
- circuit breakers;
- cache with provenance;
- field-level source mapping;
- provider conflict handling;
- observability without logging sensitive user context.

## Product capture and Living Catalog processing

Unknown-product processing is asynchronous/structured rather than one monolithic LLM request.

Suggested server flow:

1. Accept private evidence asset metadata/upload reference after authorization.
2. Run image security and quality gates.
3. Decode barcode with dedicated decoder.
4. Run OCR and structured multimodal extraction under a strict schema.
5. Create field assertions with source locations/confidence.
6. Run deterministic validators.
7. Query Living Catalog and approved identity sources.
8. If unresolved, optionally run a source-grounded research/discovery agent.
9. Independently retrieve/validate allowed discovered sources before using them.
10. Return a review payload to the user for material confirmation.
11. Create/link ProductObservation, formulation fingerprint, and catalog candidate.
12. Run conflict/corroboration workflow.

The mobile client never receives a model paragraph and treats it as catalog truth.

### Cache/cost behavior

Known, sufficiently current formulations should resolve from the database/provider cache without invoking expensive research. Track hit/miss/fallback rates and enforce per-user/per-device abuse limits so attackers cannot force unbounded model spend by submitting random products.

## Global Regulatory Registry workers

Separate workers handle:

- official source fetching/versioning;
- source change detection;
- AI/parser candidate extraction and translation;
- canonical substance/product reconciliation;
- Citation Gate validation;
- reviewer queue;
- versioned regulatory publication;
- affected-product Regulatory Lens recomputation;
- Safety Watch reevaluation only for rules that explicitly depend on the changed record.

A research/search model can discover a candidate source URL/reference but cannot write directly to the registry.

### Regulatory Lens API

The user-facing projection should return structured status per jurisdiction including:

- jurisdiction;
- status code;
- conditions/thresholds;
- canonical ingredient/product matched;
- match/applicability state;
- authority/source class;
- legal/notice reference;
- effective/publication date;
- last verified/freshness;
- coverage limitation;
- current version ID.

Do not infer `APPROVED` from absence of a rule.

## Evidence and rule engine

Keep the rule engine deterministic.

Inputs are immutable/versioned references. Outputs are assessment versions. A separate
publication policy determines whether/how an assessment becomes user-visible.

Required capabilities:

- evaluate one item/profile;
- evaluate affected population after new evidence;
- shadow run;
- replay historical version;
- diff results between rule versions;
- withdraw/supersede;
- record exact reason path for explainability.

## Reviewer console backend

Require stronger controls:

- MFA/passkey or approved strong authentication;
- role-based least privilege;
- step-up for high-impact publish/withdraw;
- immutable audit logs;
- no shared accounts;
- session expiration;
- environment isolation;
- two-person approval where policy requires.

## Object storage

Private buckets separated by purpose where useful:

- user evidence;
- generated exports;
- preserved source documents;
- internal review artifacts.

Validate uploads using:

- declared MIME type;
- magic bytes;
- extension mismatch detection;
- size/dimension/page limits;
- image metadata policy;
- malware/content scanning appropriate to file type;
- generated safe preview rather than rendering arbitrary active content directly.

## Export/delete jobs

Exports and deletion are asynchronous workflows with explicit status.

Deletion must cover:

- primary records;
- derived search/cache projections;
- object storage;
- queued jobs;
- device sync tombstones;
- documented backup expiration policy;
- retention exceptions required by approved legal/audit policy.

## Backups

Require:

- encrypted backup;
- point-in-time recovery where appropriate;
- restore testing;
- environment separation;
- documented RPO/RTO targets before production;
- deletion/retention policy that accounts for backups.
