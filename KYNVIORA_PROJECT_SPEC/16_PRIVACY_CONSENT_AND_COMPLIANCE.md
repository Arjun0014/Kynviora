# Privacy, Consent, and Compliance

Status: Product/privacy requirements
Last reviewed: 2026-08-29

## Purpose

Kynviora should collect the minimum data required to deliver enabled features and give users
clear control over sensitive sharing. Compliance is jurisdiction-specific and must be reviewed
against the implemented product before launch.

India is the current MVP market assumption. The team must obtain qualified legal review of
the Digital Personal Data Protection Act/rules and other applicable health, consumer,
cybersecurity, and sector obligations rather than relying on this document as legal advice.

## Privacy principles

- Purpose limitation.
- Data minimization.
- User-visible consent and sharing controls.
- Separate permissions for separate purposes.
- No behavioral advertising using health data.
- No generalized-model training on user health data without a separate explicit legally
  reviewed opt-in.
- Export/correction/deletion are product workflows.
- Caregiver access never implies ownership.
- Sensitive analytics are avoided rather than "anonymized later" where possible.

## Data categories

### Account data

Examples: email/identifier, authentication/security metadata.

### Profile data

Name/display name, age/DOB range, language, emergency/contact information if enabled.

### Health-context data

Allergies, sensitivities, limited conditions, medicines, adherence events.

### Product-use data

Personal-care items, formula/ingredient evidence, usage history.

### Care relationship data

Caregiver grants, invitations, audit history.

### Evidence/documents

Label photos, prescriptions, user-selected documents, generated Visit Packs.

### Safety data

Assessments, alerts, resolution actions, correction history.

### Operational telemetry

Pseudonymous error/performance/sync/source-health information that excludes sensitive payload.

## Purpose-specific consent

Maintain separate consent/choice where required or product-appropriate for:

- account/profile data;
- caregiver sharing;
- notifications;
- optional diagnostics/analytics;
- document/image processing;
- future Health Connect/HealthKit data by data type/purpose;
- optional research/product-improvement programs.

Consent receipt records:

- purpose/capability;
- policy/notice version;
- actor;
- profile where relevant;
- locale;
- timestamp;
- withdrawal timestamp/state.

## Living Catalog contribution privacy

A package observation submitted by a user serves two separable purposes:

1. private item management for that user's/profile's shelf;
2. potential improvement of shared product/formulation knowledge.

The implementation must not expose the contributing user's identity, health context, household, usage history, or raw private image to other users merely because structured product facts contribute to catalog corroboration.

Rules:

- separate shared catalog entities from `OwnedItem`/Profile ownership;
- strip unnecessary EXIF/location/device metadata;
- keep raw user package images private/internal evidence by default;
- store only the contributor linkage necessary for abuse/correction/retention under approved policy;
- define whether shared structured product contribution is required for service operation or optional, with clear notice/choice where law/product policy requires it;
- deletion behavior must specify what happens to private raw assets, personal linkage, and non-personal shared product assertions already independently corroborated;
- never use shared catalog contribution as a backdoor to build behavioral advertising profiles.

## AI/model processing privacy

Before sending label/package images or extracted text to an external model/research provider:

- minimize/remediate visible personal information;
- do not send profile health context unless the specific approved task requires it;
- configure retention/training controls;
- document processor/subprocessor and transfer obligations;
- enforce purpose-specific access and deletion;
- keep model/research provider response IDs out of user analytics where they would become sensitive identifiers.

Global Regulatory Lens source monitoring itself should normally operate on public/official source material and does not require sending user health data to the research model. Product-to-regulation matching should use canonical product/substance IDs wherever possible.

## Caregiver privacy

- Profile owner/admin sees active grants.
- Grant capabilities are human-readable.
- Sensitive actions are audited.
- Revocation is easy and takes effect promptly.
- Caregiver notifications reveal minimal information by default.
- The product should not use "family" as justification for broad hidden access.

## Data minimization examples

- Ask for condition data only when a supported feature needs it.
- Do not require complete medical history for a recall/product-safety MVP.
- Strip unnecessary image metadata.
- Do not upload a label image if on-device/manual entry can satisfy the user and they decline.
- Do not collect contacts/address book merely to invite a caregiver; use user-entered/contact
  picker mechanisms with minimum scope if implemented.

## Analytics policy

Allowed examples:

- screen/route performance without profile payload;
- scan success/failure reason classes;
- OCR confirmation error classes without label text;
- sync latency;
- alert comprehension survey response detached/minimized according to study design;
- source freshness and assessment queue metrics.

Prohibited examples:

- analytics event containing medicine name plus user ID;
- diagnosis in event property;
- full free text note;
- document filename/content;
- alert source/details tied to an advertising identifier.

## Export

Export should:

- require intentional user action;
- show what data will be included;
- re-authenticate where required;
- use secure generated file/link handling;
- expire temporary export objects;
- create an audit event without duplicating sensitive content into logs.

## Correction

Users can correct their owned/profile data. Shared catalog or reviewed evidence corrections
follow review workflow. The UI should distinguish these cases.

## Deletion

Account/profile deletion workflow must enumerate:

- device local data;
- primary database records;
- object storage;
- derived projections/indexes;
- queued jobs;
- cached exports;
- notification tokens;
- future analytics linkage where applicable;
- backups and their expiry/restore behavior;
- records that must be retained under an approved legal/safety/audit basis.

Do not claim immediate universal erasure if backups or required retained records have a
specified lifecycle.

## Retention matrix

Define before production for each category:

| Data category | Default retention | User deletion behavior | Required exception | Owner |
| --- | --- | --- | --- | --- |
| Account | TBD | delete/deidentify | legal/security TBD | Privacy |
| Profile health | TBD | delete | approved exception only | Privacy/Product |
| Product evidence | TBD | delete | unresolved safety incident TBD | Privacy/Safety |
| Audit | TBD | restricted retention | security/legal basis | Security/Legal |
| Assessments | TBD | de-link/delete per policy | reproducibility/legal basis | Safety/Privacy |
| Backups | TBD | expire through backup policy | documented | Infrastructure |

No `TBD` may remain before public production.

## Store/platform compliance

Google Play health apps require accurate Health apps declarations and privacy disclosures for
health functionality. The product must also comply with sensitive-data/permissions policies
and request only permissions needed by a visible feature.

Maintain a pre-release mapping from:

- implemented feature;
- data collected;
- runtime permission;
- Play declaration category;
- Data safety disclosure;
- privacy-policy section;
- consent/prominent disclosure screen.

## Regulatory classification

Do not declare Kynviora "not a medical device" merely because the product includes a
disclaimer. Classification depends on actual intended use, claims, behavior, target users, and
jurisdiction. Review every material safety feature/claim before launch and when expanded.

## Privacy review triggers

Mandatory review for:

- new sensitive data field;
- new third-party SDK/provider;
- new sharing recipient;
- new country;
- new analytics event involving care behavior;
- connected-health data;
- new document type;
- AI processing of user data;
- product research/study;
- retention change;
- staff/admin access expansion.
