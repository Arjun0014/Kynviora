/**
 * HTTP error mapping.
 *
 * Spec references: `13` ("stable machine-readable error codes", "safe error messages"),
 * `14` (logging policy), `12` (client error classes).
 *
 * Two rules shape this module:
 *
 *  1. **Stable codes, not prose.** The client branches on `code`, never on message text, so an
 *     error string can be reworded without breaking a client.
 *
 *  2. **Errors leak nothing.** `14` forbids diagnoses, profile-linked medicine names, document
 *     names and tokens from reaching logs; the same applies to responses. `detail` is
 *     constrained to non-sensitive scalars by the `DomainError` type, and this module never
 *     interpolates a value into a message.
 */

import type { DomainError, DomainErrorCode } from '@kynviora/domain';

/** The wire shape of an error response. */
export interface ErrorResponse {
  readonly error: {
    readonly code: DomainErrorCode;
    readonly message: string;
    readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
    readonly retryable: boolean;
    readonly correlationId: string;
  };
}

/**
 * HTTP status for each domain error code.
 *
 * `404` is used for authorization failures on a specific resource as well as genuine absence:
 * distinguishing them would confirm the resource exists to someone not permitted to see it,
 * which is the enumeration weakness `19` requires a test for.
 */
const STATUS_BY_CODE: Readonly<Record<DomainErrorCode, number>> = Object.freeze({
  // Input and validation
  VALIDATION_FAILED: 400,
  INVALID_IDENTIFIER: 400,
  INVALID_BARCODE: 400,
  INVALID_DATE: 400,
  INVALID_STRENGTH: 400,
  UNSUPPORTED_UNIT: 400,

  // Identity and resolution - not errors so much as outcomes, but they are 422 because the
  // request was well-formed and could not be fulfilled.
  IDENTITY_UNRESOLVED: 422,
  FORMULATION_UNRESOLVED: 422,
  AMBIGUOUS_MATCH: 422,

  // Evidence and provenance
  INSUFFICIENT_PROVENANCE: 422,
  EVIDENCE_MISSING: 422,
  EXTRACTION_DISAGREEMENT: 422,
  CONFIRMATION_REQUIRED: 422,
  QUALITY_GATE_FAILED: 422,

  // Catalog integrity
  FORMULATION_CONFLICT: 409,
  CORROBORATION_INSUFFICIENT: 422,
  SHARED_WRITE_FORBIDDEN: 403,

  // Regulatory
  CITATION_GATE_FAILED: 422,
  SOURCE_NOT_AUTHORIZED: 403,
  SOURCE_STALE: 503,
  JURISDICTION_UNSUPPORTED: 422,

  // Safety engine
  RULE_NOT_ELIGIBLE: 422,
  RULE_INPUT_VERSION_MISSING: 422,
  ASSESSMENT_NOT_REPRODUCIBLE: 500,
  PUBLICATION_NOT_PERMITTED: 403,

  // Authorization and session
  UNAUTHENTICATED: 401,
  AUTHORIZATION_LOST: 401,
  PERMISSION_DENIED: 404,
  EMAIL_NOT_VERIFIED: 403,
  ACCOUNT_CLOSED: 409,
  // 500 rather than 503: the data really was removed and the caller's retry is what finishes the
  // job, so this is a partial success to be completed rather than a dependency to wait on.
  ACCOUNT_DELETION_INCOMPLETE: 500,
  STEP_UP_REQUIRED: 403,

  // Caregiver invitation. 410 for an expired invitation because the resource genuinely existed
  // and is now permanently gone, which is exactly what Gone means and what lets a client offer
  // to request a fresh link without retrying the old one.
  INVITATION_INVALID: 404,
  INVITATION_EXPIRED: 410,
  INVITATION_ALREADY_RESOLVED: 409,
  CAPABILITY_ESCALATION: 403,

  // Export. 409 because the request conflicts with the current state and the resolution is to
  // re-read and retry; 410 because an expired pack existed and is now permanently gone.
  EXPORT_CONTENT_CHANGED: 409,
  EXPORT_EXPIRED: 410,

  // Concurrency and sync
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_REPLAY: 200,
  SYNC_CONFLICT: 409,
  // 409 because the request conflicts with the current state of the collection, which is exactly
  // what Conflict means. Not 400: the body is well-formed and there is no field to correct.
  ALREADY_EXISTS: 409,

  // Infrastructure
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
  BUDGET_EXCEEDED: 429,
  INTEGRITY_FAILURE: 500,
  NOT_FOUND: 404,
  INTERNAL: 500,
});

export function statusForCode(code: DomainErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * Client-safe messages.
 *
 * Deliberately generic where the specific reason would help an attacker. `PERMISSION_DENIED`
 * reads as "not found" for the enumeration reason above.
 */
const MESSAGE_BY_CODE: Partial<Record<DomainErrorCode, string>> = Object.freeze({
  UNAUTHENTICATED: 'Authentication is required.',
  AUTHORIZATION_LOST: 'This session is no longer authorised. Sign in again.',
  PERMISSION_DENIED: 'Not found.',
  NOT_FOUND: 'Not found.',
  STEP_UP_REQUIRED: 'This action requires you to confirm your identity again.',
  // Deliberately identical for an unknown token and for a token presented by the wrong account,
  // so a link that reached the wrong person does not confirm whose address it was sent to.
  INVITATION_INVALID: 'This invitation link is not valid.',
  INVITATION_EXPIRED: 'This invitation has expired. Ask for a new one.',
  INVITATION_ALREADY_RESOLVED: 'This invitation has already been used.',
  CAPABILITY_ESCALATION: 'You cannot grant permissions you do not hold yourself.',
  EXPORT_CONTENT_CHANGED:
    'This information changed since you reviewed it. Check it again before sharing.',
  EXPORT_EXPIRED: 'This Visit Pack has expired. Create a new one to share it again.',
  // Deliberately says nothing about *which* rule refused, and nothing about the conflicting row.
  // A unique index is enforced across every row in the table, including rows row-level security
  // hides from this caller, so a message naming the constraint or the existing record would be
  // an oracle for data the caller was never allowed to read (`19`, no enumeration oracle). The
  // constraint name goes to the log, where an operator can read it against the correlation ID.
  ALREADY_EXISTS: 'This already exists. Check what is there before adding it again.',
  RATE_LIMITED: 'Too many requests. Try again shortly.',
  BUDGET_EXCEEDED: 'This request exceeds the current processing budget. Try again later.',
  INTERNAL: 'Something went wrong.',
  INTEGRITY_FAILURE: 'Something went wrong.',
  ASSESSMENT_NOT_REPRODUCIBLE: 'Something went wrong.',
  PROVIDER_UNAVAILABLE: 'An upstream service is temporarily unavailable.',
  SOURCE_STALE: 'The information needed for this request is not currently up to date.',
});

/**
 * Convert a domain error into a wire response.
 *
 * `detail` is passed through only for client-correctable classes. For authorization, integrity
 * and internal failures it is dropped, because the detail could describe why access was refused.
 */
export function toErrorResponse(error: DomainError, correlationId: string): ErrorResponse {
  const status = statusForCode(error.code);
  const suppressDetail = status === 401 || status === 403 || status === 404 || status >= 500;

  const message = MESSAGE_BY_CODE[error.code] ?? error.reason;

  const body: ErrorResponse['error'] = {
    code: error.code,
    message,
    retryable: error.retryable ?? false,
    correlationId,
  };

  return suppressDetail || error.detail === undefined
    ? { error: body }
    : { error: { ...body, detail: error.detail } };
}

/**
 * The SQLSTATE Postgres raises for a unique-constraint violation.
 *
 * Named rather than written at the comparison, because `23505` and `23503` (foreign key) differ
 * by one character and mean opposite things about whose mistake it was.
 */
const UNIQUE_VIOLATION = '23505';

/**
 * Constraint names are schema identifiers, and nothing else is accepted as one.
 *
 * The name is written by a migration in this repository, so this can only ever fail if a driver
 * put something unexpected in the field. It is validated anyway: this value is about to be
 * written to a log, and a value that reached a log unchecked is how a log becomes an injection
 * surface. Anything else is reported as an unnamed constraint rather than passed through.
 */
const CONSTRAINT_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The unique constraint a failed write violated, or `null` if it did not violate one.
 *
 * WHY THE MESSAGE IS PARSED AS WELL AS THE FIELD READ
 * `pg` and PGlite both populate `constraint` on a `23505`, and both were checked. The message
 * fallback is not for them: it is for the day a pooler or a wrapper re-raises the error with the
 * fields flattened, which would otherwise turn a refusal back into a 500 silently. Both drivers
 * also carry a `detail` reading `Key (column)=(value) already exists.` - **that** field carries
 * the value somebody submitted and is deliberately never read here.
 */
export function uniqueViolationConstraint(cause: unknown): string | null {
  if (cause === null || typeof cause !== 'object') return null;
  const error = cause as { code?: unknown; constraint?: unknown; message?: unknown };
  if (error.code !== UNIQUE_VIOLATION) return null;

  if (typeof error.constraint === 'string' && CONSTRAINT_NAME.test(error.constraint)) {
    return error.constraint;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  const named = /violates unique constraint "([^"]*)"/.exec(message);
  const parsed = named?.[1];
  return parsed !== undefined && CONSTRAINT_NAME.test(parsed) ? parsed : UNNAMED_CONSTRAINT;
}

/**
 * What is logged when a unique violation arrives without a usable constraint name.
 *
 * A distinct value rather than an empty string, so "the driver told us nothing" and "the field
 * was blank" read differently to whoever is holding the correlation ID at 3am.
 */
export const UNNAMED_CONSTRAINT = 'unnamed';

/**
 * Fields that must never appear in a log line or an error response.
 *
 * Used by {@link assertNoSensitiveFields} to catch a leak in tests rather than in production.
 */
export const FORBIDDEN_LOG_FIELDS: readonly string[] = Object.freeze([
  'medicineName',
  'medicine_name',
  'diagnosis',
  'condition',
  'allergy',
  'displayName',
  'display_name',
  'email',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'password',
  'documentName',
  'document_name',
  'explanation',
  'ingredientDeclaration',
  'ingredient_declaration',
]);

/**
 * Assert a payload carries no field name from the forbidden list.
 *
 * A structural check, not a content one: it catches the common mistake of attaching a whole
 * record to an error or a log line. Spec 14's logging policy is the requirement.
 */
export function assertNoSensitiveFields(payload: unknown, path = '$'): void {
  if (payload === null || typeof payload !== 'object') return;

  if (Array.isArray(payload)) {
    payload.forEach((entry, index) => {
      assertNoSensitiveFields(entry, `${path}[${index}]`);
    });
    return;
  }

  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_LOG_FIELDS.includes(key)) {
      throw new Error(
        `Sensitive field "${key}" found at ${path}. Spec 14 forbids this in logs and error ` +
          'responses. Use a machine code or a correlation ID instead.',
      );
    }
    assertNoSensitiveFields(value, `${path}.${key}`);
  }
}
