# Release, Environments, and CI/CD

Status: Engineering/release policy
Last reviewed: 2026-08-20

## Environment model

| Environment | Purpose | Data rule |
| --- | --- | --- |
| Local | Individual development | fictional/synthetic only |
| Development | Shared feature integration | synthetic only |
| Preview | PR/internal mobile builds | synthetic or explicitly approved test data |
| Staging | Production-like release rehearsal | production-like synthetic data |
| Production | Real users | full security/privacy/safety controls |

Use separate credentials, API endpoints, storage, notification projects, databases, and admin
access boundaries where appropriate.

## CI on every pull request

Minimum:

1. Clean dependency install.
2. TypeScript typecheck.
3. Lint/format verification.
4. Unit/component tests.
5. Runtime schema/contract tests where configured.
6. Expo project diagnostics.
7. Secret scan.
8. Dependency/security scan.
9. Database migration validation.
10. Targeted safety-rule fixtures for affected rule modules.

Add native/device workflows as the application reaches those stages.

## Protected branches and review

- No direct production branch pushes.
- Required review for security/safety/domain migrations.
- CODEOWNERS or equivalent for high-risk areas.
- Signed/protected release workflows where practical.
- Migration and rule changes include rollback/forward plan.

## Build strategy

Use reproducible development/preview/production builds. Native behavior is controlled through
app configuration/config plugins/custom Expo modules, not ad-hoc generated-directory edits.

Production signing credentials are protected from normal developer environments.

## Remote/OTA updates

Remote updates can be useful for UI/application fixes but require controlled runtime
compatibility.

Rules:

- fingerprint/runtime compatibility required;
- no server safety-rule publication depends on waiting for app update;
- high-risk app updates use staged rollout;
- ability to halt/rollback bad update;
- security/privacy/safety changes receive appropriate review;
- native permission/security behavior cannot be assumed updateable without store release.

## Database migrations

- Forward-only normal migration discipline.
- Tested against representative schema/data volume.
- Backup/restore plan before destructive transformations.
- Migration CI.
- Local database migrations also tested for interrupted/upgrade scenarios.
- Safety input history should not be destroyed by convenience schema changes.

## Rule/evidence publication release path

Safety content has a separate controlled publication lifecycle from app deployment.

Rule publication requires:

- immutable version;
- fixtures;
- review approvals;
- shadow result if required;
- expected impact;
- rollback/disable path;
- audit record.

## Feature flags/kill switches

Use for high-risk remote features such as:

- new safety rule category;
- new source adapter;
- AI-assisted extraction provider;
- caregiver notification behavior;
- new OCR/catalog provider;
- experimental personalization.

A feature flag is not a substitute for authorization.

## Release stages

### Internal alpha

Team/safety reviewers; synthetic data; workflow and operational drills.

### Closed beta

Small controlled real-user cohort only after legal/privacy/security/clinical approval. Tight
monitoring and support.

### Expanded beta

Increase cohort only after metrics and incidents remain within approved thresholds.

### Production

Staged percentage rollout with monitoring and rollback.

## Store readiness

Before Google Play release:

- package/signing final;
- privacy policy active/public;
- Data safety form accurate;
- Health apps declaration accurate;
- permissions match visible functionality;
- screenshots/demo data contain no real health information;
- support/security contact works;
- account deletion mechanism/store requirements implemented;
- legal/medical claims reviewed;
- accessibility/store descriptions accurate.

## Release checklist

Every production release has:

- release owner;
- change summary;
- migration status;
- high-risk feature/rule changes;
- test evidence;
- security scan status;
- known issues/accepted risks;
- monitoring dashboard link internally;
- rollback plan;
- on-call coverage.
