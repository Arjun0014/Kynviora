/**
 * What one upload attempt did, read from the answer the server gave.
 *
 * Spec references: `13` (per-entity conflict policy; stable machine-readable error codes; bounded
 * retry), `12` (pending-operation journal, idempotency keys, a resolvable failure state), `03`
 * group J (pending user edits with deterministic sync handling), `DEV-038`.
 *
 * WHY THIS IS A MODULE AND NOT A `switch` IN THE DRAIN LOOP
 * Because every branch is a decision about somebody's unsent edit, and three of them are wrong in
 * ways that look like working software:
 *
 *   - Retrying something the server *refused* burns the attempt budget and then reports "could not
 *     save" for an edit that was never going to save, hiding the message that named the problem.
 *   - **Not** retrying something transient throws away an edit for the duration of a tunnel.
 *   - Treating an authorization failure as retryable re-sends a revoked caregiver's write four more
 *     times, when `12` requires authorization loss to invalidate local access rather than persist
 *     through it.
 *
 * `apps/**` is outside the test run, so a branch written there is a branch nothing checks
 * (trap 164). The whole mapping lives here, exhaustively, over the closed {@link ApiOutcome} union
 * - so a member added later fails to compile until somebody decides what it means for an edit that
 * is already queued.
 *
 * WHAT THIS DELIBERATELY DOES NOT DECIDE
 * Whether an operation may be queued at all. That is `isOptimisticallyApplicable` in
 * `@kynviora/domain`, driven by `13`'s per-entity conflict policy, and it is asked before an
 * operation is written rather than after the server has answered.
 */

import { DOMAIN_ERROR_CODES, domainError, type DomainError } from '@kynviora/domain';
import type { ApiOutcome } from './outcome.js';

/**
 * The outcome shape `recordUploadOutcome` takes.
 *
 * `sync.ts` states this union inline in its own signature; naming it here is what lets the mapping
 * below be read as a table.
 */
export type UploadOutcome =
  | { readonly kind: 'COMMITTED' }
  | { readonly kind: 'CONFLICT'; readonly error: DomainError }
  | { readonly kind: 'REJECTED'; readonly error: DomainError }
  | { readonly kind: 'RETRYABLE'; readonly error: DomainError };

/**
 * The refusal codes that mean "the record moved underneath you", not "your edit was wrong".
 *
 * `13` distinguishes these because the resolutions differ entirely: a conflict is resolved against
 * `13`'s per-entity policy - which for a schedule or an allergy is `ASK_USER`, a person choosing
 * between two versions - while a rejection is an edit that cannot be saved as written. Retrying
 * neither helps; showing them the same way does harm.
 *
 * Matched on `code`, never on status. 409 also carries `INVITATION_ALREADY_RESOLVED` and
 * `EXPORT_CONTENT_CHANGED`, which are neither of these things, and `13` is explicit that clients
 * branch on codes rather than on statuses or message text.
 */
export const CONFLICT_REFUSAL_CODES: readonly string[] = Object.freeze([
  'VERSION_CONFLICT',
  'SYNC_CONFLICT',
  'FORMULATION_CONFLICT',
]);

export function isConflictRefusal(code: string): boolean {
  return CONFLICT_REFUSAL_CODES.includes(code);
}

/**
 * Whether a code off the wire is one this build's vocabulary knows.
 *
 * Narrowed, never cast - the same rule the notification detail level follows. `ApiOutcome`'s
 * `REFUSED` carries `code` as a plain `string` on purpose, so that a code a later server adds does
 * not fail the parse; and the only safe thing to do with one this build does not recognise is to
 * keep it as data rather than to assert it is something it may not be.
 */
function isDomainErrorCode(code: string): code is (typeof DOMAIN_ERROR_CODES)[number] {
  return (DOMAIN_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Turn a refusal into a domain error without inventing one.
 *
 * Where the server's code is in this build's vocabulary - which, for this build's own server, is
 * always, and `pendingUpload.test.ts` asserts it - the code is used as sent. Where it is not, the
 * outcome is still classified correctly from `isConflictRefusal` and the code is recorded in
 * `detail.serverCode` rather than thrown away, so a newer server's refusal reaches a person with
 * its own message intact and reaches a developer with its own code intact.
 *
 * `VALIDATION_FAILED` is the stand-in for that unreachable-today branch, and it is an
 * approximation rather than a fact: it says only that the request was declined as written, which
 * is the part every refusal shares.
 */
function refusalError(code: string, message: string): DomainError {
  return isDomainErrorCode(code)
    ? domainError(code, message)
    : domainError('VALIDATION_FAILED', message, { serverCode: code });
}

/**
 * Classify one upload attempt.
 *
 * The `REFUSED` split is the substance. A refusal carries a code the server chose and a message it
 * has already made client-safe, and the code is what says whether anything about retrying could
 * help. Nothing here writes an explanation of its own where the server wrote one: the server
 * withholds the reason for the authorization classes on purpose (`outcome.ts`), and an invented
 * reason printed as a fact is worse than the generic copy.
 *
 * Two members defer to the server rather than deciding for it. `13` puts `retryable` on the wire,
 * and it is the server saying whether sending the identical request again could succeed - so a 500
 * marked non-retryable is a rejection, and a refusal marked retryable is a retry. `RATE_LIMITED` is
 * the case that makes the second one matter: a 429 asks for a pause, and treating it as final would
 * fail somebody's edit permanently because they saved it during a burst.
 *
 * `UNAVAILABLE` is the subtlest member, and it is a rejection rather than a retry. 404 is genuine
 * absence *and* refused access, deliberately indistinguishable - so an operation that gets one is
 * either editing something that is no longer there or something the caller may not touch, and
 * neither improves by being sent again. `PERMISSION_DENIED` is the code because that is the one
 * the API itself answers 404 with, so the client is not inventing a second meaning for it.
 */
export function classifyUpload(outcome: ApiOutcome<unknown>): UploadOutcome {
  switch (outcome.kind) {
    case 'OK':
      return { kind: 'COMMITTED' };

    // The transient pair, and the only two. `retainsPreviousContent` calls these the failures that
    // say nothing about access - the same distinction, arrived at from the other direction.
    case 'OFFLINE':
      return {
        kind: 'RETRYABLE',
        error: domainError(
          'PROVIDER_UNAVAILABLE',
          'The device had no connection.',
          undefined,
          true,
        ),
      };
    // A 500 the server marks non-retryable is not retried. `13` puts `retryable` on the wire for
    // this exact purpose, and spending four more attempts against a server that has already said
    // they cannot succeed is the attempt budget being burned on the server's behalf.
    case 'SERVER_ERROR':
      return outcome.retryable
        ? {
            kind: 'RETRYABLE',
            error: domainError(
              'PROVIDER_UNAVAILABLE',
              'The server could not complete the request.',
              undefined,
              true,
            ),
          }
        : {
            kind: 'REJECTED',
            error: domainError(
              'PROVIDER_UNAVAILABLE',
              'The server could not complete the request, and said retrying will not help.',
            ),
          };

    // Authorization. Never retryable.
    case 'UNAUTHENTICATED':
      return {
        kind: 'REJECTED',
        error: domainError('UNAUTHENTICATED', 'The session is no longer valid.'),
      };
    case 'AUTHORIZATION_LOST':
      return {
        kind: 'REJECTED',
        error: domainError('AUTHORIZATION_LOST', 'Access to this record has ended.'),
      };
    case 'STEP_UP_REQUIRED':
      return {
        kind: 'REJECTED',
        error: domainError('STEP_UP_REQUIRED', 'This change needs a fresh identity confirmation.'),
      };
    case 'UNAVAILABLE':
      return {
        kind: 'REJECTED',
        error: domainError('PERMISSION_DENIED', 'The record this change was about is not there.'),
      };

    case 'REFUSED': {
      const error = refusalError(outcome.code, outcome.message);
      if (isConflictRefusal(outcome.code)) return { kind: 'CONFLICT', error };
      // A refusal the server marked retryable is retryable, and `RATE_LIMITED` is the one that
      // matters: it is a 429 asking for a pause, not a statement about the edit. Reading every
      // refusal as final would fail somebody's schedule change permanently because they saved it
      // during a burst.
      return outcome.retryable
        ? { kind: 'RETRYABLE', error: { ...error, retryable: true } }
        : { kind: 'REJECTED', error };
    }
  }
}
