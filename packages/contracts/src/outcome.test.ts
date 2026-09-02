import { describe, it, expect } from 'vitest';
import {
  classifyError,
  messageForFailure,
  parseWireError,
  screenStateForFailure,
  type ApiOutcome,
  type WireError,
} from './outcome.js';
import { SCREEN_STATES } from '@kynviora/presentation';

function wire(code: string, overrides: Partial<WireError> = {}): WireError {
  return {
    code,
    message: 'Not found.',
    retryable: false,
    correlationId: 'c-1',
    ...overrides,
  };
}

describe('classification branches on the code, not the status', () => {
  it('separates "not signed in" from "no longer signed in"', () => {
    // Both are 401. `12` separates them because only the second is worth an apology, and only
    // the second means the user did nothing wrong.
    expect(classifyError(401, wire('UNAUTHENTICATED')).kind).toBe('UNAUTHENTICATED');
    expect(classifyError(401, wire('AUTHORIZATION_LOST')).kind).toBe('AUTHORIZATION_LOST');
  });

  it('does not read 403 as "needs step-up"', () => {
    // SHARED_WRITE_FORBIDDEN, SOURCE_NOT_AUTHORIZED, PUBLICATION_NOT_PERMITTED and
    // CAPABILITY_ESCALATION are all 403 and none of them is fixed by re-authenticating. A client
    // that offered "confirm your identity" for them would send the user round a loop that cannot
    // end.
    expect(classifyError(403, wire('STEP_UP_REQUIRED')).kind).toBe('STEP_UP_REQUIRED');

    for (const code of [
      'SHARED_WRITE_FORBIDDEN',
      'SOURCE_NOT_AUTHORIZED',
      'PUBLICATION_NOT_PERMITTED',
      'CAPABILITY_ESCALATION',
    ]) {
      expect(classifyError(403, wire(code)).kind).toBe('REFUSED');
    }
  });

  it('reports a 5xx as a server error and carries the retryable flag', () => {
    expect(classifyError(500, wire('INTERNAL', { retryable: false }))).toEqual({
      kind: 'SERVER_ERROR',
      retryable: false,
      correlationId: 'c-1',
    });
    expect(classifyError(503, wire('PROVIDER_UNAVAILABLE', { retryable: true })).kind).toBe(
      'SERVER_ERROR',
    );
  });

  it('carries a refusal the user can act on, with the server’s own words', () => {
    // `errors.ts` has already made these messages client-safe, and it is the only place that
    // knows which reasons are safe to state.
    const outcome = classifyError(
      409,
      wire('EXPORT_CONTENT_CHANGED', {
        message: 'This information changed since you reviewed it. Check it again before sharing.',
      }),
    );
    expect(outcome).toEqual({
      kind: 'REFUSED',
      code: 'EXPORT_CONTENT_CHANGED',
      message: 'This information changed since you reviewed it. Check it again before sharing.',
      retryable: false,
      correlationId: 'c-1',
    });
  });

  it('degrades an unrecognised code rather than treating it as success', () => {
    expect(classifyError(418, wire('SOMETHING_NEWER')).kind).toBe('REFUSED');
    expect(classifyError(500, null).kind).toBe('SERVER_ERROR');
    // A 4xx with no parseable body is not attributed to the user, because we do not know.
    expect(classifyError(400, null).kind).toBe('SERVER_ERROR');
  });
});

describe('the API is not an existence oracle, and neither is the client', () => {
  it('maps a refusal and a genuine absence to the same outcome', () => {
    // The whole reason PERMISSION_DENIED is 404 (`errors.ts`; `19`; trap 14) is that a caller
    // must not learn a resource exists by being refused it. If the client distinguished them,
    // the protocol would have withheld the fact and the screen would have handed it back.
    expect(classifyError(404, wire('PERMISSION_DENIED')).kind).toBe('UNAVAILABLE');
    expect(classifyError(404, wire('NOT_FOUND')).kind).toBe('UNAVAILABLE');
    expect(classifyError(404, null).kind).toBe('UNAVAILABLE');

    expect(classifyError(404, wire('PERMISSION_DENIED'))).toEqual(
      classifyError(404, wire('NOT_FOUND')),
    );
  });

  it('carries no code, message or correlation ID out of an unavailable outcome', () => {
    // Anything distinguishing the two cases is a side channel, including a correlation ID that
    // only appears for one of them.
    const outcome = classifyError(404, wire('PERMISSION_DENIED'));
    expect(Object.keys(outcome)).toEqual(['kind']);
  });

  it('has no outcome anywhere in the union meaning "refused for permission"', () => {
    const kinds: ApiOutcome<unknown>['kind'][] = [
      'OK',
      'UNAUTHENTICATED',
      'AUTHORIZATION_LOST',
      'STEP_UP_REQUIRED',
      'UNAVAILABLE',
      'REFUSED',
      'OFFLINE',
      'SERVER_ERROR',
    ];
    for (const kind of kinds) {
      expect(kind).not.toMatch(/DENIED|FORBIDDEN|NO_ACCESS|NOT_PERMITTED/);
    }
  });
});

describe('parsing an untrusted error body', () => {
  it('reads the contract shape', () => {
    expect(
      parseWireError({
        error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, correlationId: 'x' },
      }),
    ).toEqual({ code: 'NOT_FOUND', message: 'Not found.', retryable: false, correlationId: 'x' });
  });

  it('returns null for anything else, rather than half a value', () => {
    // Untrusted input from the network. `STATUS.md` trap 8 is the widening mistake this avoids by
    // narrowing each field explicitly.
    for (const body of [null, undefined, 'text', 42, [], {}, { error: null }, { error: 'x' }]) {
      expect(parseWireError(body)).toBeNull();
    }
    expect(parseWireError({ error: { code: 1, message: 'x' } })).toBeNull();
    expect(parseWireError({ error: { code: 'X' } })).toBeNull();
  });

  it('defaults the optional fields rather than trusting their types', () => {
    const parsed = parseWireError({ error: { code: 'X', message: 'y', retryable: 'yes' } });
    expect(parsed).toEqual({ code: 'X', message: 'y', retryable: false, correlationId: '' });
  });
});

describe('the state a screen shows', () => {
  it('maps every failure to a real state', () => {
    const failures: Exclude<ApiOutcome<unknown>, { kind: 'OK' }>[] = [
      { kind: 'UNAUTHENTICATED' },
      { kind: 'AUTHORIZATION_LOST' },
      { kind: 'STEP_UP_REQUIRED' },
      { kind: 'UNAVAILABLE' },
      { kind: 'OFFLINE' },
      { kind: 'REFUSED', code: 'X', message: 'm', retryable: false, correlationId: null },
      { kind: 'SERVER_ERROR', retryable: true, correlationId: null },
    ];
    for (const failure of failures) {
      expect(SCREEN_STATES).toContain(screenStateForFailure(failure));
    }
  });

  it('shows absence for an unavailable resource', () => {
    expect(screenStateForFailure({ kind: 'UNAVAILABLE' })).toBe('UNAVAILABLE');
  });

  it('uses the server’s message only where the server sent a real one', () => {
    // The authorization classes carry a deliberately generic message because `errors.ts`
    // suppresses the detail; repeating it would tell the user nothing and displace copy written
    // for them to read.
    expect(
      messageForFailure({
        kind: 'REFUSED',
        code: 'EXPORT_EXPIRED',
        message: 'This Visit Pack has expired. Create a new one to share it again.',
        retryable: false,
        correlationId: null,
      }),
    ).toBe('This Visit Pack has expired. Create a new one to share it again.');

    for (const outcome of [
      { kind: 'UNAVAILABLE' },
      { kind: 'UNAUTHENTICATED' },
      { kind: 'AUTHORIZATION_LOST' },
      { kind: 'OFFLINE' },
      { kind: 'SERVER_ERROR', retryable: true, correlationId: 'c' },
    ] satisfies Exclude<ApiOutcome<unknown>, { kind: 'OK' }>[]) {
      expect(messageForFailure(outcome)).toBeNull();
    }
  });
});

describe('a refusal keeps the field it names', () => {
  /**
   * The domain names the field a refusal is about so a form can point at it, and until now the
   * client dropped it on the floor - `WireError.detail` was declared and never parsed. A form
   * with eleven fields that can only say "that is not a kind of product Kynviora knows" is one
   * where the person has to find it themselves.
   */

  it('carries the detail through to a REFUSED outcome', () => {
    const outcome = classifyError(
      400,
      parseWireError({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'An item needs a name.',
          detail: { reason_code: 'manual_entry', field: 'displayName' },
          retryable: false,
          correlationId: 'c1',
        },
      }),
    );

    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') expect(outcome.detail?.['field']).toBe('displayName');
  });

  it('leaves the detail absent when the server sent none', () => {
    // Absent rather than empty: "the server said nothing" and "the server said this is about no
    // particular field" are different facts.
    const outcome = classifyError(
      400,
      parseWireError({
        error: { code: 'VALIDATION_FAILED', message: 'No.', retryable: false, correlationId: 'c' },
      }),
    );

    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind === 'REFUSED') expect('detail' in outcome).toBe(false);
  });

  it('drops a detail entry that is not a scalar', () => {
    // Trap 101 on the error path. A nested object rendered beside somebody's medicine would read
    // as `[object Object]`, so a value this build cannot read is treated as one nobody sent.
    const parsed = parseWireError({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'No.',
        detail: {
          field: 'market',
          nested: { a: 1 },
          list: [1, 2],
          count: 2,
          ok: false,
          gone: null,
        },
        retryable: false,
        correlationId: 'c',
      },
    });

    expect(parsed?.detail).toEqual({ field: 'market', count: 2, ok: false, gone: null });
  });

  it('ignores a detail that is not an object at all', () => {
    for (const detail of ['a string', 42, ['a', 'b'], null]) {
      const parsed = parseWireError({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'No.',
          detail,
          retryable: false,
          correlationId: 'c',
        },
      });
      expect(parsed?.detail).toBeUndefined();
    }
  });

  it('never carries a detail on an authorization outcome', () => {
    // The server suppresses it for those classes, and there is nowhere on those outcomes to put
    // one - which is the shape of the rule rather than a promise about the server.
    const outcome = classifyError(
      404,
      parseWireError({
        error: {
          code: 'NOT_FOUND',
          message: 'Not found.',
          detail: { field: 'profileId' },
          retryable: false,
          correlationId: 'c',
        },
      }),
    );

    expect(outcome).toEqual({ kind: 'UNAVAILABLE' });
  });
});
