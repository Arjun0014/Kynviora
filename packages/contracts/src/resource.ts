/**
 * What a screen renders: a state, and possibly some content.
 *
 * Spec references: `06` (every critical route defines its states), `12` (client error classes),
 * `18` (never present uncertain information as certain).
 *
 * WHY A FAILURE DISCARDS THE VALUE
 * {@link resourceFor} returns content only for `OK`. A screen that keeps the previous list on
 * display under a red banner has told the user two things at once - "here is your medicine list"
 * and "this did not load" - and the first is louder. On a health product the resolution is not a
 * banner; it is either labelling the content as older than it looks ({@link staleResource}, which
 * says so in the state itself) or not showing it. The type makes the middle option unavailable.
 */

import { presentScreenState, type ScreenState } from '@kynviora/presentation';
import type { ApiOutcome } from './outcome.js';
import { messageForFailure, screenStateForFailure } from './outcome.js';

export interface Resource<T> {
  readonly state: ScreenState;
  /**
   * The content, or `null`.
   *
   * Non-null exactly when the state's `showsContent` is true. Asserted in the tests, because it
   * is the property the module note is about.
   */
  readonly value: T | null;
  /**
   * A server-supplied message, or `null` to use the state's own copy.
   *
   * Never written by this module. The authorization classes deliberately carry no reason (`14`),
   * and inventing one here would print a guess as a fact.
   */
  readonly message: string | null;
  /** `20`: carried so a developer can correlate a screen with a log line. Never shown by default. */
  readonly correlationId: string | null;
}

export function loadingResource<T>(): Resource<T> {
  return { state: 'LOADING', value: null, message: null, correlationId: null };
}

/**
 * Content that could not be refreshed.
 *
 * For the case where a screen already had something and the refetch failed. The state says the
 * content is older than it looks, which is the honest alternative to silently leaving it up.
 */
export function staleResource<T>(value: T): Resource<T> {
  return { state: 'STALE', value, message: null, correlationId: null };
}

export interface ResourceOptions<T> {
  /**
   * Whether a successful response is nothing at all.
   *
   * Supplied by the caller because only it knows the shape: an empty list, a zero count, an
   * absent record. Defaults to "there is something", so forgetting it renders content rather
   * than hiding it.
   */
  readonly isEmpty?: (value: T) => boolean;
  /**
   * Whether a successful response is missing part of what was asked for.
   *
   * `06` requires a partial state distinct from success. Where a screen composes several calls,
   * this is how "the shelf loaded and the alerts did not" reaches the user as a fact rather than
   * as a silently shorter page.
   */
  readonly isPartial?: (value: T) => boolean;
}

/**
 * Turn an outcome into what a screen shows.
 *
 * The empty and partial decisions happen here, and only for a successful response - a failed
 * request is not "empty", it is failed, and conflating them is how a permission problem starts
 * looking like an empty shelf.
 */
export function resourceFor<T>(
  outcome: ApiOutcome<T>,
  options: ResourceOptions<T> = {},
): Resource<T> {
  if (outcome.kind !== 'OK') {
    return {
      state: screenStateForFailure(outcome),
      value: null,
      message: messageForFailure(outcome),
      correlationId: correlationIdOf(outcome),
    };
  }

  const { value, correlationId } = outcome;

  if (options.isEmpty?.(value) === true) {
    return { state: 'EMPTY', value: null, message: null, correlationId };
  }
  if (options.isPartial?.(value) === true) {
    return { state: 'PARTIAL', value, message: null, correlationId };
  }
  return { state: 'READY', value, message: null, correlationId };
}

function correlationIdOf(outcome: Exclude<ApiOutcome<unknown>, { kind: 'OK' }>): string | null {
  switch (outcome.kind) {
    case 'REFUSED':
    case 'SERVER_ERROR':
      return outcome.correlationId;
    case 'UNAUTHENTICATED':
    case 'AUTHORIZATION_LOST':
    case 'STEP_UP_REQUIRED':
    case 'UNAVAILABLE':
    case 'OFFLINE':
      return null;
  }
}

/** The words a screen puts on the state: the server's message where there is one, else the copy. */
export function resourceDescription(resource: Resource<unknown>): string {
  return resource.message ?? presentScreenState(resource.state).description;
}

/** Whether a screen should offer a retry control for this resource. */
export function resourceRetryLabel(resource: Resource<unknown>): string | null {
  return presentScreenState(resource.state).retryLabel;
}

// ---------------------------------------------------------------------------
// Refreshing over content that is already on screen
// ---------------------------------------------------------------------------

/**
 * Whether a failed refresh may leave the previous content on screen.
 *
 * The rule is not "did the request fail" but **did the server say something about this caller's
 * access**. `OFFLINE` and `SERVER_ERROR` say nothing: the authorization check did not produce an
 * answer, so what is on screen is simply older than it looks and {@link staleResource} labels it
 * (DEC-041).
 *
 * Every other failure is an answer, and the answer is no. `15` A2 requires a revoked caregiver to
 * lose access on their very next authenticated access, and the server implements that exactly -
 * `has_capability` re-evaluates the grant per request. A client that kept the medicine list on
 * screen under a "not up to date" label would reintroduce the same threat one layer up: the
 * person whose access was removed would still be reading the content, and the label would not
 * take it away from them. `UNAVAILABLE` is the shape revocation actually arrives in, because
 * `PERMISSION_DENIED` is answered with 404 so the API is not an existence oracle (DEC-039).
 *
 * `REFUSED` retains nothing for a different reason: it is the one failure carrying a message the
 * server wrote for this user to act on, and burying it under stale content hides the only thing
 * that would tell them what to do.
 */
export function retainsPreviousContent(outcome: Exclude<ApiOutcome<unknown>, { kind: 'OK' }>) {
  switch (outcome.kind) {
    case 'OFFLINE':
    case 'SERVER_ERROR':
      return true;
    case 'UNAUTHENTICATED':
    case 'AUTHORIZATION_LOST':
    case 'STEP_UP_REQUIRED':
    case 'UNAVAILABLE':
    case 'REFUSED':
      return false;
  }
}

/**
 * What a screen shows after a refresh over content it already had.
 *
 * The whole decision, in one place, so a screen cannot half-implement it. A hook that inlined
 * this branch is how the retention rule above came to apply to every failure at once.
 *
 * @param previous The content currently on screen, or `null` if this is the first load.
 */
export function refreshedResource<T>(
  outcome: ApiOutcome<T>,
  previous: T | null,
  options: ResourceOptions<T> = {},
): Resource<T> {
  const next = resourceFor(outcome, options);
  if (outcome.kind === 'OK' || previous === null) return next;
  return retainsPreviousContent(outcome) ? staleResource(previous) : next;
}

// ---------------------------------------------------------------------------
// Content held on the device between sessions
// ---------------------------------------------------------------------------

/**
 * What a response does to a copy of the content kept on the device.
 *
 * `12` requires an encrypted local projection so the medicine list survives being offline
 * (`03` group J), and it requires two more things in the same breath: sign-out removes decrypted
 * projections, and **authorization loss invalidates local access**. The second is the one a cache
 * gets wrong. {@link retainsPreviousContent} already decides whether a failure may leave content
 * on _screen_; the same answer has to reach the _disk_, or a revoked caregiver closes the app,
 * reopens it offline, and reads a shelf the server would refuse them.
 *
 * So this is deliberately derived from `retainsPreviousContent` rather than written out again.
 * A future failure kind added to `ApiOutcome` gets its screen behaviour and its disk behaviour
 * from one decision, and the exhaustiveness check in that function is what makes somebody make it.
 */
export type ProjectionAction = 'WRITE' | 'KEEP' | 'FORGET';

export function projectionActionFor(outcome: ApiOutcome<unknown>): ProjectionAction {
  if (outcome.kind === 'OK') return 'WRITE';
  return retainsPreviousContent(outcome) ? 'KEEP' : 'FORGET';
}

/**
 * The key a screen's stored content lives under.
 *
 * Built rather than written by hand so the session can never be left out: a key without it is a
 * row one identity writes and another reads.
 *
 * **The encoding is length-prefixed, not separated.** The first version joined the two parts with
 * a NUL, which is the usual choice precisely because it cannot occur in either part. On a device
 * it silently destroyed both: `expo-sqlite` binds a TEXT parameter through C string handling, so
 * the key was truncated at the NUL and every read of every screen collided on one row - the
 * profile list read back the shelf, and the app crashed on the shape it did not expect. Reading
 * the stored keys off the emulator showed exactly one row, and its characters were the session
 * ID alone.
 *
 * A separator is only unambiguous if the store keeps it. A length prefix needs nothing of the
 * store: `36:<uuid>items:...` cannot be produced by any other pair, whatever characters the parts
 * contain, and it survives any transport that preserves ordinary text.
 */
export function projectionKey(sessionId: string, logical: string): string {
  return `${String(sessionId.length)}:${sessionId}${logical}`;
}
