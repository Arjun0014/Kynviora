import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveApiContext } from './ApiProvider';

/**
 * Who the app is acting as, and which refusal is news (DEC-038, DEC-118, DEC-124).
 *
 * Spec references: `13` (every request derives authority from an authenticated session), `12`
 * (authorization loss invalidates local access), `14`, `19` SIGN-7.
 *
 * WHAT IS WORTH A TEST HERE
 * One rule, and it cost `19`'s seventh check a run. `sessionLost` does not only forget the session
 * on screen - it **deletes it from the encrypted store** - so which `401` may call it is a question
 * about whether a returning person keeps their session. A request that carried no credential
 * cannot report one lost: it says there was not one, which is not news and is true on every cold
 * start before the store has finished opening.
 */

const ENV = {
  EXPO_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3000',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every request refused, without a server. The wrapper under test calls the global `fetch`. */
function everythingRefused(): void {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 401 })));
}

describe('which 401 says a session was lost', () => {
  it('reports one for a request that carried a session', async () => {
    everythingRefused();
    let lost = 0;
    const resolved = resolveApiContext(ENV, {
      accessToken: 'header.payload.signature',
      onSessionLost: () => {
        lost += 1;
      },
    });
    expect(resolved.session.kind).toBe('BEARER');

    await resolved.client?.readAccount();
    expect(lost).toBe(1);
  });

  it('does not report one for a request that carried nothing', async () => {
    // `19` SIGN-7. On a cold start the providers above the gate mount before the stored session
    // has been read out of an encrypted database, so they ask with `ANONYMOUS` - and the `401`
    // that comes back used to call `sessionLost`, which clears the session from disk. A returning
    // person was signed out by their own app, and a phone that answered faster did it more often.
    everythingRefused();
    let lost = 0;
    const resolved = resolveApiContext(ENV, {
      accessToken: null,
      onSessionLost: () => {
        lost += 1;
      },
    });
    expect(resolved.session.kind).toBe('ANONYMOUS');

    await resolved.client?.readAccount();
    expect(lost).toBe(0);
  });

  it('does not report one for a development session either', async () => {
    // A development identity is a header the server refuses under `NODE_ENV=production`
    // (DEC-038). Its refusal is a configuration fact rather than a session that ended.
    everythingRefused();
    let lost = 0;
    const resolved = resolveApiContext(
      { ...ENV, EXPO_PUBLIC_DEV_USER_ID: '00000000-0000-4000-8000-00000000d001' },
      {
        accessToken: null,
        onSessionLost: () => {
          lost += 1;
        },
      },
    );
    expect(resolved.session.kind).toBe('DEVELOPMENT');

    await resolved.client?.readAccount();
    expect(lost).toBe(0);
  });
});
