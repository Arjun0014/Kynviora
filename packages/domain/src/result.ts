/**
 * Explicit result type for operations that can fail in a domain-meaningful way.
 *
 * `12_MOBILE_ARCHITECTURE.md` enumerates error classes that must be distinguishable
 * (recoverable network, user-correctable input, permission denied, authorization lost, sync
 * conflict, integrity failure, safety payload validation failure). `13` requires "stable
 * machine-readable error codes".
 *
 * Domain code returns `Result` rather than throwing so that a caller cannot accidentally ignore
 * a failure, and so that error codes are part of the type signature. Exceptions remain for
 * genuine programmer errors (invariant violations), not for expected outcomes.
 */

export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}

export function mapResult<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

export function flatMapResult<T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return r.ok ? fn(r.value) : r;
}

/**
 * Unwrap or throw. Only for tests and for call sites that have already proven success.
 */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`Attempted to unwrap a failed Result: ${JSON.stringify(r.error)}`);
}

/** Collect a list of results, failing on the first error. */
export function allResults<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return ok(values);
}

/**
 * Stable machine-readable error codes (`13`).
 *
 * Codes are safe to log and to return to clients: none of them embeds health content, and the
 * `detail` field is constrained to non-sensitive scalars.
 */
export const DOMAIN_ERROR_CODES = [
  // Input and validation
  'VALIDATION_FAILED',
  'INVALID_IDENTIFIER',
  'INVALID_BARCODE',
  'INVALID_DATE',
  'INVALID_STRENGTH',
  'UNSUPPORTED_UNIT',

  // Identity and resolution
  'IDENTITY_UNRESOLVED',
  'FORMULATION_UNRESOLVED',
  'AMBIGUOUS_MATCH',

  // Evidence and provenance
  'INSUFFICIENT_PROVENANCE',
  'EVIDENCE_MISSING',
  'EXTRACTION_DISAGREEMENT',
  'CONFIRMATION_REQUIRED',
  'QUALITY_GATE_FAILED',

  // Catalog integrity
  'FORMULATION_CONFLICT',
  'CORROBORATION_INSUFFICIENT',
  'SHARED_WRITE_FORBIDDEN',

  // Regulatory
  'CITATION_GATE_FAILED',
  'SOURCE_NOT_AUTHORIZED',
  'SOURCE_STALE',
  'JURISDICTION_UNSUPPORTED',

  // Safety engine
  'RULE_NOT_ELIGIBLE',
  'RULE_INPUT_VERSION_MISSING',
  'ASSESSMENT_NOT_REPRODUCIBLE',
  'PUBLICATION_NOT_PERMITTED',

  // Authorization and session
  'UNAUTHENTICATED',
  'AUTHORIZATION_LOST',
  'PERMISSION_DENIED',
  'STEP_UP_REQUIRED',

  // Concurrency and sync
  'VERSION_CONFLICT',
  'IDEMPOTENCY_REPLAY',
  'SYNC_CONFLICT',

  // Infrastructure
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'BUDGET_EXCEEDED',
  'INTEGRITY_FAILURE',
  'NOT_FOUND',
  'INTERNAL',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/**
 * A domain error.
 *
 * `detail` deliberately accepts only scalars so an error cannot become a channel for leaking
 * health content into logs or API responses (`14` logging policy). `reason` is a short,
 * developer-facing, non-sensitive explanation.
 */
export interface DomainError {
  readonly code: DomainErrorCode;
  readonly reason: string;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
  /**
   * Whether retrying the identical request could succeed. Drives client retry policy and
   * distinguishes `12`'s "recoverable network" class from user-correctable input.
   */
  readonly retryable?: boolean;
}

export function domainError(
  code: DomainErrorCode,
  reason: string,
  detail?: DomainError['detail'],
  retryable = false,
): DomainError {
  return detail === undefined
    ? { code, reason, retryable }
    : { code, reason, detail, retryable };
}

export function failure<T = never>(
  code: DomainErrorCode,
  reason: string,
  detail?: DomainError['detail'],
  retryable = false,
): Result<T, DomainError> {
  return err(domainError(code, reason, detail, retryable));
}
