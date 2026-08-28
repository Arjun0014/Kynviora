# Definition of Done

Status: Cross-functional feature completion checklist
Last reviewed: 2026-08-29

## Principle

A feature is not done because the happy-path screen works. It is done when behavior, data,
safety, security, privacy, accessibility, testing, observability, and rollback expectations are
satisfied for the feature's risk level.

## Product

- User problem and expected outcome are explicit.
- Feature belongs to approved MVP/roadmap scope.
- Success and failure states are defined.
- Unsupported behavior/non-goals are clear.
- Copy does not imply stronger certainty than data supports.

## UX/accessibility

- Loading, empty, success, partial, offline, permission-denied, and error states exist.
- Large text does not hide critical content/actions.
- TalkBack semantics/focus are verified.
- No color-only meaning.
- Core action does not depend on hidden gesture.
- Sensitive sharing/destructive actions have appropriate confirmation.
- Profile/person context is clear.

## Domain/data

- Stable typed contract.
- Runtime validation at input/persistence boundaries.
- Provenance stored for safety-relevant facts.
- Versioning/supersession defined.
- Missing/unknown values are represented honestly.
- Migration exists and is tested where storage changes.
- Deletion/retention behavior is defined.

## Backend/authorization

- Server-side authorization implemented.
- Negative authorization tests exist.
- Mutation idempotency/preconditions defined where retry/conflict is possible.
- Rate/body limits appropriate.
- Audit event created for sensitive/privileged actions.
- No sensitive data placed in URLs or unsafe logs.

## Offline/sync

If feature has durable mobile data:

- local authority/remote authority is defined;
- offline behavior exists;
- pending operation behavior exists;
- conflict policy exists;
- sign-out/revocation cleanup is correct;
- sync integration tests exist.

## Safety/clinical

If feature can influence health/safety understanding:

- hazard analysis updated;
- allowed/forbidden copy reviewed;
- evidence/rule requirements explicit;
- high-impact output is reproducible;
- uncertainty is visible;
- correction/withdrawal behavior exists;
- clinical/product-safety approval completed when required;
- no unauthorized AI authority introduced.

## Security/privacy

- Threat-model impact reviewed.
- Sensitive data classification updated.
- New secrets stay server-side.
- Third-party processor/SDK reviewed.
- consent/disclosure updated if needed.
- logs/analytics reviewed for leakage.
- upload/parser security implemented if accepting files.
- step-up auth considered for sensitive actions.

## Testing

- unit tests for core logic;
- component tests for states/accessibility;
- integration tests for API/storage;
- device/E2E path for critical journey;
- negative/error/offline tests;
- regression fixtures for known safety/data edge cases.

## Observability

- success/failure metrics exist where needed;
- errors have safe machine codes;
- operator ownership exists for actionable alerts;
- dashboards/alerts do not expose sensitive content;
- support/debug path can identify version/correlation without needing raw health data in logs.

## Release/rollback

- environment configuration defined;
- feature flag/kill switch exists if high risk;
- data migration rollback/recovery considered;
- release note/risk note prepared;
- operational runbook updated if failure needs special response.

## Category-specific done criteria

### Medicine feature

- Does not infer or alter prescription instructions.
- Schedule/time-zone behavior tested.
- Sensitive reminder privacy checked.

### Personal-care feature

- Product identity and formula identity remain separate.
- Original label evidence/provenance preserved.
- Unknown ingredients are not guessed into trusted matches.

### Capture/Living Catalog feature

- Package fields retain exact evidence/provenance.
- Image-quality/retake behavior exists.
- Dedicated barcode decoding and deterministic field validation are tested.
- OCR/model disagreement has an explicit state.
- Unknown fields are not guessed.
- User writes cannot directly publish shared catalog truth.
- Formulation fingerprint version is stored.
- Same-barcode/different-formula creates conflict/new formulation, not overwrite.
- Corroboration/duplicate-abuse behavior is tested.
- Raw contributor identity/health context is not exposed through shared catalog views.
- Cache hit avoids unnecessary model/research work.

### Global Regulatory Lens feature

- Jurisdiction is explicit and correct.
- GB/NI are not accidentally collapsed.
- Source authority/class is stored.
- Citation Gate passes.
- Prohibited/restricted/concentration/use/warning/product-action/scientific-opinion/no-match/unknown states are not conflated.
- Effective/publication dates and supersession are tested.
- Missing concentration/use data produces condition-unknown rather than an invented compliance judgment.
- "No matched rule" is not rendered as approved/safe.
- Foreign status does not automatically set personalized alert urgency.
- Regulatory correction/replay updates affected projections.

### AI/research-assisted feature

- Model output is a candidate, not the source of truth.
- Underlying evidence/source is independently retrievable/inspectable.
- Prompt-injection behavior is tested.
- Provider/model version is recorded.
- Fallback/kill switch exists.
- Cost/rate-limit/abuse controls exist for expensive research paths.

### Safety feature

- Rule/evidence/template versions stored.
- Evidence level and urgency separate.
- Match confidence visible.
- replay/correction/withdrawal tested.
- notification revalidates current state.

### Caregiver feature

- granular permission;
- revoke/expiry tested;
- no cross-profile cache leak;
- audit visibility.

## Final completion question

Could the team explain to a user, reviewer, and incident responder exactly what this feature
did, what data it used, how certain it was, who was allowed to see/change it, and how to undo
or correct it?

If not, the feature is not done.
