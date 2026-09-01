/**
 * What a request can come back as, and what a screen shows for it.
 *
 * Spec references: `12` (client error classes and what the user can do next), `13` (stable
 * machine-readable error codes; clients branch on `code`, never on message text), `14` (errors
 * leak nothing), `19` (no enumeration oracle), `06` (every route defines its states).
 *
 * THE ONE RULE THIS MODULE EXISTS TO KEEP
 * The API answers `PERMISSION_DENIED` with **404**, deliberately, so that a caller cannot learn
 * a resource exists by being refused it (`errors.ts`; trap 14 in `STATUS.md`). That decision is
 * only worth anything if the client honours it. There is therefore no outcome in this union
 * meaning "you are not allowed": a 404 becomes {@link ApiOutcome} `UNAVAILABLE`, which a screen
 * renders as absence. Adding a `FORBIDDEN` member here would hand back, on the screen, the exact
 * fact the status code was chosen to withhold.
 *
 * 403 IS STEP-UP AND FOUR OTHER THINGS
 * It is tempting to read 403 as "needs step-up", and wrong: `SHARED_WRITE_FORBIDDEN`,
 * `SOURCE_NOT_AUTHORIZED`, `PUBLICATION_NOT_PERMITTED` and `CAPABILITY_ESCALATION` are all 403
 * and none of them is fixed by re-authenticating. Mapping is by `code`, never by status - which
 * is what `13` means by "stable machine-readable error codes".
 */

import type { ScreenState } from '@kynviora/presentation';

/** The wire shape of an error body. Mirrors `services/api/src/errors.ts`. */
export interface WireError {
  readonly code: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
  readonly retryable: boolean;
  readonly correlationId: string;
}

/**
 * The result of one request.
 *
 * Closed, so a caller must say what it does in each case. Every member that a user could see
 * carries either a server-supplied message or nothing - this module never writes an explanation
 * of its own, because the server deliberately withholds the reason for the authorization classes
 * and a guess printed as a fact is worse than the generic copy.
 */
export type ApiOutcome<T> =
  | { readonly kind: 'OK'; readonly value: T; readonly correlationId: string | null }
  /** No session, or a session the server does not accept. */
  | { readonly kind: 'UNAUTHENTICATED' }
  /** A session that was valid and is not any more. Distinct because the user did nothing wrong. */
  | { readonly kind: 'AUTHORIZATION_LOST' }
  /** `14`: exports, caregiver administration and deletion need a fresh identity confirmation. */
  | { readonly kind: 'STEP_UP_REQUIRED' }
  /** 404. Genuine absence and refused access, deliberately indistinguishable. */
  | { readonly kind: 'UNAVAILABLE' }
  /**
   * A well-formed request the server declined, with a reason the user can act on.
   *
   * Carries the server's own message, which `errors.ts` has already made client-safe.
   */
  | {
      readonly kind: 'REFUSED';
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly correlationId: string | null;
    }
  /** The request never reached a server. */
  | { readonly kind: 'OFFLINE' }
  /** It reached one and the server could not answer. */
  | {
      readonly kind: 'SERVER_ERROR';
      readonly retryable: boolean;
      readonly correlationId: string | null;
    };

/**
 * Error codes that mean the session itself is the problem.
 *
 * `UNAUTHENTICATED` is "you are not signed in"; `AUTHORIZATION_LOST` is "you were, and now you
 * are not". `12` separates them because only the second is worth an apology.
 */
const SESSION_CODES = Object.freeze({
  UNAUTHENTICATED: 'UNAUTHENTICATED' as const,
  AUTHORIZATION_LOST: 'AUTHORIZATION_LOST' as const,
});

/**
 * Turn a status and a parsed error body into an outcome.
 *
 * Branches on `code` first and falls back to the status class, so an unrecognised code from a
 * newer server degrades to something sensible rather than to `OK`.
 */
export function classifyError(status: number, error: WireError | null): ApiOutcome<never> {
  const code = error?.code;
  const correlationId = error?.correlationId ?? null;

  if (code === SESSION_CODES.AUTHORIZATION_LOST) return { kind: 'AUTHORIZATION_LOST' };
  if (code === SESSION_CODES.UNAUTHENTICATED) return { kind: 'UNAUTHENTICATED' };
  if (code === 'STEP_UP_REQUIRED') return { kind: 'STEP_UP_REQUIRED' };

  // Before the status fallbacks, because PERMISSION_DENIED and NOT_FOUND must land in the same
  // place as each other and as an unrecognised 404.
  if (code === 'PERMISSION_DENIED' || code === 'NOT_FOUND') return { kind: 'UNAVAILABLE' };

  if (status === 401) return { kind: 'UNAUTHENTICATED' };
  if (status === 404) return { kind: 'UNAVAILABLE' };

  if (status >= 500) {
    return { kind: 'SERVER_ERROR', retryable: error?.retryable ?? true, correlationId };
  }

  if (error !== null) {
    return {
      kind: 'REFUSED',
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId,
    };
  }

  // A 4xx with no parseable body. Not attributed to the user, because we do not know.
  return { kind: 'SERVER_ERROR', retryable: false, correlationId };
}

/**
 * Whether an error body is shaped like the contract.
 *
 * Narrow explicitly rather than casting: this is untrusted input from the network, and
 * `Array.isArray` widening a readonly array is the trap `STATUS.md` records at 8.
 */
export function parseWireError(body: unknown): WireError | null {
  if (body === null || typeof body !== 'object') return null;
  const outer = body as Readonly<Record<string, unknown>>;
  const inner = outer['error'];
  if (inner === null || typeof inner !== 'object') return null;

  const fields = inner as Readonly<Record<string, unknown>>;
  const code = fields['code'];
  const message = fields['message'];
  const retryable = fields['retryable'];
  const correlationId = fields['correlationId'];

  if (typeof code !== 'string' || typeof message !== 'string') return null;

  return {
    code,
    message,
    retryable: typeof retryable === 'boolean' ? retryable : false,
    correlationId: typeof correlationId === 'string' ? correlationId : '',
  };
}

// ---------------------------------------------------------------------------
// Outcome to screen state
// ---------------------------------------------------------------------------

/**
 * The state a screen shows for an outcome.
 *
 * `OK` is not mapped here: whether a successful response is `READY` or `EMPTY` depends on what
 * came back, which only the caller knows. {@link resourceFor} makes that decision.
 */
export function screenStateForFailure(
  outcome: Exclude<ApiOutcome<unknown>, { kind: 'OK' }>,
): ScreenState {
  switch (outcome.kind) {
    case 'UNAUTHENTICATED':
      return 'UNAUTHENTICATED';
    case 'AUTHORIZATION_LOST':
      return 'AUTHORIZATION_LOST';
    case 'STEP_UP_REQUIRED':
      return 'STEP_UP_REQUIRED';
    case 'UNAVAILABLE':
      // Absence, never refusal. See the module note.
      return 'UNAVAILABLE';
    case 'OFFLINE':
      return 'OFFLINE';
    case 'REFUSED':
    case 'SERVER_ERROR':
      return 'RECOVERABLE_ERROR';
  }
}

/**
 * The message a screen shows, or `null` to use the state's own copy.
 *
 * Only a `REFUSED` outcome supplies one, because it is the only class where the server sends
 * something specific and safe. The authorization classes deliberately carry a generic message
 * (`errors.ts` suppresses the detail), and repeating it would tell the user nothing while
 * displacing copy written for them to read.
 */
export function messageForFailure(
  outcome: Exclude<ApiOutcome<unknown>, { kind: 'OK' }>,
): string | null {
  return outcome.kind === 'REFUSED' ? outcome.message : null;
}
