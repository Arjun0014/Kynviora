# Security Requirements

Status: Release-gating security policy
Last reviewed: 2026-08-20

## Security objective

Kynviora processes highly sensitive health, family, medication, product-use, and evidence data.
Security is a release requirement. The product should assume mobile devices can be lost,
accounts can be attacked, external data can be malicious, and authorization bugs can expose
another person's information.

## Security principles

- Deny by default.
- Least privilege.
- Defense in depth.
- Short-lived authority.
- Explicit trust boundaries.
- No secrets in mobile public configuration.
- Encrypt sensitive data in transit and at rest.
- Minimize sensitive logs/analytics.
- Re-authenticate for high-impact user actions.
- Privileged publication is separate from normal user access.
- Security findings are risk-assessed, not hidden by tooling noise.

## Secret handling

Mobile/public configuration may contain only non-secret identifiers and origins explicitly
approved for exposure.

Never ship in the mobile bundle:

- database password;
- Supabase service-role/secret keys;
- JWT/private signing keys;
- commercial catalog credentials;
- OCR/provider secret keys;
- notification server credentials;
- encryption master keys;
- reviewer/admin credentials.

Use environment-specific server secret management.

## Authentication

Requirements:

- secure verified identity method;
- rate-limited sign-in/recovery;
- session revocation;
- short-lived access token design;
- rotating refresh/session credentials where supported;
- native credentials in Keychain/Keystore-backed storage;
- MFA/passkey/strong auth for reviewer/admin accounts;
- step-up authentication for exports, caregiver administration, account deletion, and other
  sensitive actions;
- device biometrics treated as local convenience, not server identity proof.

## Authorization

- Check authenticated user and grants on every server request.
- RLS on every application table where Supabase/PostgreSQL client paths exist.
- No anonymous application-table access.
- Column-level or service-layer controls protect immutable ownership/linkage fields.
- Caregiver grants are capability- and profile-scoped.
- Revocation takes effect immediately on server and invalidates cached authorization.
- Admin/reviewer roles are not inferred from client claims.

## Mobile data protection

- Encrypted structured local store.
- Database key protected by platform secure hardware/keystore mechanisms where available.
- Sensitive files independently protected.
- Plain AsyncStorage not approved for health/safety/consent/session data.
- Temporary images/OCR artifacts deleted promptly.
- Sensitive views consider app switcher/screenshot policy where justified.
- Backup behavior explicitly reviewed.
- Sign-out removes decrypted projections and cached sensitive data.

## Network/API security

- HTTPS only with valid certificate chain.
- Strict endpoint allow-list/origin validation.
- API authentication/authorization at every request.
- Body size/field length limits.
- Rate limiting and abuse controls.
- Idempotency for retried mutations.
- Safe error messages.
- No sensitive tokens/medical details in URLs.
- Provider timeouts/circuit breakers.

## Upload security

Treat user labels, prescriptions, PDFs, images, and external source content as untrusted.

Controls:

- file size/page/dimension limits;
- MIME and magic-byte validation;
- metadata stripping where unnecessary;
- malware scanning/content validation appropriate to type;
- no execution of embedded scripts/macros;
- isolated parsing;
- safe generated previews;
- resource/time limits for parsers;
- object paths not user-guessable/public;
- authorization on every download/preview.

## Logging and telemetry

Never intentionally place in logs/analytics:

- diagnoses/conditions;
- medicine names tied to identifiable profile;
- personal-care use tied to identifiable profile when not essential;
- document names/content;
- full alert explanations;
- access/refresh tokens;
- raw profile names/contact details;
- label images.

Use correlation IDs, redacted error codes, route/module performance, sync outcome classes, and
pseudonymous operational identifiers.

## Reviewer/admin security

Because reviewer compromise can create false safety publications:

- strong MFA/passkeys;
- separate admin roles;
- least privilege;
- session timeout;
- step-up for publish/withdraw;
- two-person approval where defined;
- audit every privileged action;
- production access from managed/approved environments where feasible;
- no direct database editing of publication state as normal workflow.

## Supply chain

CI should include:

- lockfile integrity;
- dependency scanning;
- secret scanning;
- static analysis;
- native binary/dependency inspection as appropriate;
- provenance/approval for build workflows;
- protected production signing credentials;
- review of untrusted asset/build inputs.

Do not blindly run forceful dependency remediation that downgrades or breaks the supported
runtime. Risk-assess findings and document mitigations until a compatible fix exists.

## Mobile security validation

Use OWASP MASVS controls and MASTG testing as a baseline, including the current MASTG v2 test
model available in 2026.

Test at minimum:

- local data storage;
- cryptography/key management;
- authentication/session;
- network communication;
- platform interaction;
- code quality/build hardening;
- privacy leakage;
- deep links/notifications;
- backup/app switcher/logging;
- tampering/rooted-device behavior according to threat model.

## Security release gates

Before real sensitive production data:

- threat model complete for MVP flows;
- authorization/RLS automated negative tests;
- secret scan clean of active secrets;
- critical dependency risks assessed;
- encrypted local storage validated;
- upload/parser controls validated;
- account export/deletion tested;
- backup restore tested;
- incident response rehearsed;
- independent penetration/security review appropriate to release;
- no unresolved critical security finding;
- high findings have named owner and explicit release decision.

## Vulnerability reporting

Maintain a private security contact and disclosure process. Reports must not require users to
send real patient/family health data.
