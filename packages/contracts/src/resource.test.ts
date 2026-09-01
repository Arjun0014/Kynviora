import { describe, it, expect } from 'vitest';
import {
  loadingResource,
  resourceDescription,
  resourceFor,
  resourceRetryLabel,
  staleResource,
} from './resource.js';
import type { ApiOutcome } from './outcome.js';
import { SCREEN_STATE_PRESENTATION, presentScreenState } from '@kynviora/presentation';

interface List {
  readonly items: readonly string[];
}

const ok = (items: readonly string[]): ApiOutcome<List> => ({
  kind: 'OK',
  value: { items },
  correlationId: 'c-1',
});

const isEmpty = (value: List): boolean => value.items.length === 0;

describe('a successful response', () => {
  it('is ready when there is something', () => {
    const resource = resourceFor(ok(['a']), { isEmpty });
    expect(resource.state).toBe('READY');
    expect(resource.value).toEqual({ items: ['a'] });
    expect(resource.correlationId).toBe('c-1');
  });

  it('is empty when there is nothing', () => {
    const resource = resourceFor(ok([]), { isEmpty });
    expect(resource.state).toBe('EMPTY');
    expect(resource.value).toBeNull();
  });

  it('renders content when no emptiness test is given', () => {
    // Forgetting the predicate must show the response, not hide it.
    expect(resourceFor(ok([])).state).toBe('READY');
  });

  it('is partial when part of what was asked for is missing', () => {
    // `06` requires a partial state distinct from success, so "the shelf loaded and the alerts
    // did not" reaches the user as a fact rather than as a silently shorter page.
    const resource = resourceFor(ok(['a']), { isEmpty, isPartial: () => true });
    expect(resource.state).toBe('PARTIAL');
    expect(resource.value).toEqual({ items: ['a'] });
  });

  it('prefers empty over partial', () => {
    // Nothing at all is not "some of it".
    expect(resourceFor(ok([]), { isEmpty, isPartial: () => true }).state).toBe('EMPTY');
  });
});

describe('a failure discards the content', () => {
  it('carries no value for any failure', () => {
    // A screen that keeps the previous list under a failure banner has told the user two things
    // at once, and "here is your medicine list" is the louder one.
    const failures: ApiOutcome<List>[] = [
      { kind: 'UNAUTHENTICATED' },
      { kind: 'AUTHORIZATION_LOST' },
      { kind: 'STEP_UP_REQUIRED' },
      { kind: 'UNAVAILABLE' },
      { kind: 'OFFLINE' },
      { kind: 'REFUSED', code: 'X', message: 'm', retryable: false, correlationId: 'c' },
      { kind: 'SERVER_ERROR', retryable: true, correlationId: 'c' },
    ];
    for (const failure of failures) {
      expect(resourceFor(failure, { isEmpty }).value).toBeNull();
    }
  });

  it('agrees with the presentation about whether content is on screen', () => {
    // The invariant the module note is about: a non-null value exactly when the state says a
    // screen may show one.
    const cases: { outcome: ApiOutcome<List>; hasValue: boolean }[] = [
      { outcome: ok(['a']), hasValue: true },
      { outcome: ok([]), hasValue: false },
      { outcome: { kind: 'OFFLINE' }, hasValue: false },
      { outcome: { kind: 'UNAVAILABLE' }, hasValue: false },
    ];
    for (const { outcome, hasValue } of cases) {
      const resource = resourceFor(outcome, { isEmpty });
      expect(resource.value !== null).toBe(hasValue);
      expect(SCREEN_STATE_PRESENTATION[resource.state].showsContent).toBe(hasValue);
    }
  });

  it('does not distinguish an unavailable resource from any other unavailable one', () => {
    // Whatever the reason for the 404, the screen gets the same thing. Trap 14.
    expect(resourceFor<List>({ kind: 'UNAVAILABLE' })).toEqual({
      state: 'UNAVAILABLE',
      value: null,
      message: null,
      correlationId: null,
    });
  });
});

describe('the words on the state', () => {
  it('uses the server message for a refusal', () => {
    const resource = resourceFor<List>({
      kind: 'REFUSED',
      code: 'EXPORT_EXPIRED',
      message: 'This Visit Pack has expired. Create a new one to share it again.',
      retryable: false,
      correlationId: 'c',
    });
    expect(resourceDescription(resource)).toBe(
      'This Visit Pack has expired. Create a new one to share it again.',
    );
  });

  it('falls back to the state copy where the server said nothing specific', () => {
    // `14` keeps the reason out of the authorization responses, so there is nothing to show and
    // inventing one would print a guess as a fact.
    const resource = resourceFor<List>({ kind: 'OFFLINE' });
    expect(resourceDescription(resource)).toBe(presentScreenState('OFFLINE').description);
  });

  it('offers a retry only where the state does', () => {
    expect(resourceRetryLabel(resourceFor<List>({ kind: 'OFFLINE' }))).toBe('Try again');
    expect(resourceRetryLabel(resourceFor(ok([]), { isEmpty }))).toBeNull();
    expect(resourceRetryLabel(resourceFor<List>({ kind: 'UNAVAILABLE' }))).toBeNull();
  });
});

describe('the other constructors', () => {
  it('starts loading with nothing', () => {
    expect(loadingResource<List>()).toEqual({
      state: 'LOADING',
      value: null,
      message: null,
      correlationId: null,
    });
  });

  it('keeps content that could not be refreshed, and says so', () => {
    // The honest alternative to silently leaving older content up: the state itself carries the
    // fact that it is older than it looks.
    const resource = staleResource<List>({ items: ['a'] });
    expect(resource.state).toBe('STALE');
    expect(resource.value).toEqual({ items: ['a'] });
    expect(SCREEN_STATE_PRESENTATION.STALE.showsContent).toBe(true);
  });
});
