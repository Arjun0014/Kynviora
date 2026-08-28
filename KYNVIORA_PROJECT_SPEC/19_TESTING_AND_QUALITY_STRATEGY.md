# Testing and Quality Strategy

Status: Engineering and release quality policy
Last reviewed: 2026-08-29

## Objective

Test not only whether screens work, but whether Kynviora gives the correct person the correct
information from the correct item/evidence version under realistic failure conditions.

## Test pyramid

### Unit tests

Cover:

- barcode validation/normalization;
- medicine strength/form parsing rules;
- ingredient normalization for approved vocabulary;
- evidence/match/urgency state transitions;
- deterministic safety rules;
- explanation-template selection;
- schedule/time-zone calculations;
- refill estimates;
- authorization policy helpers;
- sync/idempotency/conflict logic;
- migration/crypto envelope utilities;
- redaction functions.

### Component tests

Cover:

- accessible names/roles/states;
- large-text layout;
- verification review screens;
- alert detail fields;
- permission/error/offline states;
- caregiver capability UI;
- no color-only meaning;
- destructive/export confirmations.

### Integration tests

Cover:

- repository local/remote behavior;
- auth/session refresh/revocation;
- RLS/API authorization;
- catalog resolver/provider fallback;
- upload validation;
- assessment creation from exact versioned inputs;
- correction/replay;
- notification deep-link revalidation;
- export/deletion jobs.

### Device E2E tests

Cover:

- Android install/update;
- sign-up/sign-in/recovery;
- profile creation;
- medicine add/scan/manual path;
- personal-care add/scan/OCR/confirm path;
- medicine reminder after process death/restart;
- offline create/edit/sync;
- safety alert open/resolution;
- caregiver invite/revoke;
- Visit Pack export;
- camera/file permissions;
- TalkBack smoke suite;
- clock/time-zone change;
- low storage/network disruption.

## Safety rule testing

Every production rule version requires:

- positive fixture;
- negative fixture;
- boundary/ambiguous fixture;
- wrong-market fixture where relevant;
- wrong-formulation fixture;
- wrong-batch fixture where relevant;
- insufficient-data fixture;
- correction/replay fixture;
- expected evidence level/urgency/template.

Fixtures are reviewed and versioned.

## Product identity evaluation

Build labeled evaluation sets separately for:

- prescription medicines;
- OTC medicines;
- personal-care categories;
- difficult labels;
- multiple market variants;
- reformulated products;
- poor images;
- duplicate/similar names.

Measure:

- exact product precision/recall;
- strength/form accuracy;
- formula match accuracy;
- batch extraction accuracy;
- OCR field accuracy;
- unresolved/abstention rate;
- false confirmation rate.

The system should be rewarded for abstaining when certainty is insufficient, not only for
maximizing match rate.

## Living Catalog and extraction validation

Build labeled datasets that include:

- readable and intentionally poor/glared/blurry package images;
- multiple views of the same package;
- same barcode/same formula;
- same barcode/changed formula;
- visually similar variants;
- regional variants;
- intentional OCR/vision disagreement;
- invalid dates/GTINs/medicine strengths;
- duplicated/manipulated contribution attempts.

Measure field-level OCR and multimodal precision/recall separately. Test formulation fingerprints for false merges and false splits. Test corroboration policy so duplicate accounts/images cannot cheaply promote an incorrect shared formulation.

## Global Regulatory Registry validation

For each supported jurisdiction, maintain reviewed fixtures for:

- prohibited substance;
- restricted substance;
- concentration-limited rule;
- product-type/use/age/route condition;
- warning requirement;
- product/batch action;
- scientific opinion that is not law;
- no matched rule within known coverage;
- unknown/stale source.

Test that the UI/API never converts restricted -> banned, no-match -> approved, scientific opinion -> legal prohibition, or foreign status -> automatic high-severity personal alert.

Regulatory extraction tests must include negation, tables, units, threshold boundaries, effective dates, superseded amendments, and translation-sensitive wording. Every published fixture must pass Citation Gate checks.

## AI/research-agent evaluation

Test:

- source discovery precision for official/approved domains;
- fabricated/nonexistent citation rate;
- ability to abstain;
- malicious prompt injection in webpages/PDFs;
- condition/threshold extraction;
- synonym/canonical mapping;
- source-grounding completeness;
- cost/budget behavior on cache miss;
- safe degradation when model/provider unavailable.

## Authorization/security tests

Automate cases for:

- unrelated households;
- valid caregiver with narrow permission;
- caregiver missing capability;
- revoked caregiver;
- expired grant;
- old session;
- client-supplied foreign profile ID;
- direct object storage access attempt;
- admin/user role confusion;
- enumeration/rate-limit behavior.

## Privacy tests

Verify:

- analytics events contain no sensitive payload;
- logs redact protected fields;
- notification defaults are generic;
- export requires intentional action;
- deletion reaches documented stores;
- sign-out clears local sensitive projection;
- camera metadata/temp files follow policy;
- permissions requested only when feature needs them.

## Resilience tests

Inject:

- source timeout;
- source malformed response;
- provider quota limit;
- partial sync;
- duplicate requests;
- DB transaction rollback;
- queue retry;
- corrupt local database/migration failure;
- object upload interruption;
- assessment payload schema failure;
- push delivery delay;
- withdrawn alert opened from stale notification.

Expected behavior should fail safe, preserve last trusted data, and expose clear user/operator
status.

## Accessibility and usability validation

Automated checks are insufficient. Run moderated sessions with older adults and caregivers on:

- adding a medicine;
- adding a personal-care item;
- understanding verified versus unverified;
- understanding an alert's urgency and evidence;
- correcting a bad match;
- caregiver grant/revocation;
- Visit Pack creation.

Track task completion and comprehension, not subjective aesthetics alone.

## Performance targets

Define measurable targets before beta for:

- app startup/local Today load;
- Shelf query;
- profile switch;
- scan-to-candidate response;
- sync latency;
- notification open-to-current-alert;
- source ingestion latency;
- review queue age;
- assessment recomputation throughput.

## Regression policy

Any production safety, privacy, security, data-quality, or authorization incident produces:

- root-cause record;
- regression test/fixture where technically possible;
- runbook/update if process contributed;
- risk review for similar paths.

## Release-blocking defect classes

Block release for unresolved issues such as:

- cross-profile/household exposure;
- incorrect high-impact action path;
- non-reproducible assessment;
- safety result based on unconfirmed fields contrary to rule policy;
- stale withdrawn alert still actionable;
- critical accessibility barrier in core journey;
- active production secret exposure;
- broken deletion/consent revocation where required;
- data corruption/loss without recovery path.
