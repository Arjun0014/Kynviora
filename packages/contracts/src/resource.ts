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
