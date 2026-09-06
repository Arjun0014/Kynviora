import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import { Text } from 'react-native';
import type { AuthEndpoint, AuthTokens } from '@kynviora/contracts';
import { LocalStoreProvider, type LocalStoreContextValue } from '@/storage/LocalStoreProvider';
import type { SessionStore } from '@/auth/sessionStore';
import { AuthProvider, useAuth, type AuthContextValue } from './AuthProvider';
import { flush, renderScreen, screenNames, type Rendered } from '../../test/render.js';

/**
 * Keeping somebody signed in, and the two ways that goes wrong (`19` SIGN-8, SIGN-9, DEC-118).
 *
 * Spec references: `13` (identity comes from an authenticated session), `14` (session data in the
 * encrypted store), `12` (authorization loss invalidates local access), `03` group J.
 *
 * WHY THIS FILE EXISTS
 * Renewal was the one part of the session nothing measured. `19`'s fourteenth device scenario
 * found it - a session that signed itself out when its token came due, and a revoked one that went
 * on working - and neither is reachable from a screen test of the sign-in form. What is decidable
 * here, in Node, is the **rule**: which outcome adopts, which one forgets, which one is asked
 * again, and which one must not act at all because the session it named is no longer the session
 * on the phone.
 *
 * The timers are fake. A retry two seconds away is not a thing to wait for, and a test that waited
 * would be slow *and* flaky.
 */

const NOW = 1_788_607_662;

const CURRENT: AuthTokens = {
  accessToken: 'header.payload.signature',
  refreshToken: 'the-refresh-token',
  expiresAtSeconds: NOW + 3_600,
};

/** Inside the sixty-second margin, so a renewal is due the moment the session is restored. */
const DUE: AuthTokens = { ...CURRENT, expiresAtSeconds: NOW + 30 };

const RENEWED = {
  access_token: 'renewed.payload.signature',
  refresh_token: 'the-next-refresh-token',
  expires_in: 3_600,
};

/** The session store, in memory: it answers, and it records what was written to it. */
function sessionStore(initial: AuthTokens | null): {
  store: SessionStore;
  current: () => AuthTokens | null;
} {
  let held = initial;
  return {
    store: {
      read: () => Promise.resolve(held),
      write: (tokens) => {
        held = tokens;
        return Promise.resolve();
      },
      clear: () => {
        held = null;
        return Promise.resolve();
      },
    },
    current: () => held,
  };
}

function storeValue(session: SessionStore): LocalStoreContextValue {
  return { projection: null, pending: null, session, settled: true, error: null };
}

const ISSUER = 'https://project.supabase.co/auth/v1';
const ANON = 'sb_publishable_not_a_secret';

/** A provider whose answers are scripted, and which records the refresh tokens it was sent. */
function endpointAnswering(answers: readonly { status: number; body: unknown }[]): {
  endpoint: AuthEndpoint;
  refreshTokensSent: string[];
} {
  const refreshTokensSent: string[] = [];
  let turn = 0;
  const impl = ((url: string, init: RequestInit) => {
    if (url.includes('grant_type=refresh_token')) {
      // The client always sends a JSON string; narrowed rather than coerced, so a change that
      // started sending something else would be a failure here rather than "[object Object]".
      const raw = typeof init.body === 'string' ? init.body : '{}';
      const body = JSON.parse(raw) as { refresh_token: string };
      refreshTokensSent.push(body.refresh_token);
    }
    const answer = answers[Math.min(turn, answers.length - 1)];
    turn += 1;
    return Promise.resolve(
      new Response(JSON.stringify(answer?.body ?? {}), { status: answer?.status ?? 500 }),
    );
  }) as unknown as typeof fetch;

  return {
    endpoint: { issuer: ISSUER, anonKey: ANON, fetchImpl: impl, nowSeconds: () => NOW },
    refreshTokensSent,
  };
}

/** The state and the access token, as a screen under the provider sees them. */
function Probe({ capture }: { readonly capture?: (value: AuthContextValue) => void }) {
  const auth = useAuth();
  capture?.(auth);
  return <Text>{`${auth.state}:${auth.tokens?.accessToken ?? '-'}`}</Text>;
}

function stateOf(rendered: Rendered): string {
  return screenNames(rendered).find((name) => name.includes(':')) ?? '';
}

describe('renewing a session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renews a session that is due, and keeps the person signed in', async () => {
    const held = sessionStore(DUE);
    const provider = endpointAnswering([{ status: 200, body: RENEWED }]);
    const rendered = renderScreen(
      <LocalStoreProvider value={storeValue(held.store)}>
        <AuthProvider endpoint={provider.endpoint} nowSeconds={() => NOW}>
          <Probe />
        </AuthProvider>
      </LocalStoreProvider>,
    );
    await flush();

    expect(provider.refreshTokensSent).toEqual(['the-refresh-token']);
    expect(stateOf(rendered)).toBe('SIGNED_IN:renewed.payload.signature');
    // On disk as well as on screen. A renewal that reached only the state would leave the next
    // launch renewing from a token the provider has already rotated away from.
    expect(held.current()?.refreshToken).toBe('the-next-refresh-token');
  });

  it('asks once, not twice, for one session', async () => {
    // Two renewals racing the same refresh token is the shape a rotating provider punishes, and
    // it is exactly what a renewal loop would have hidden.
    const held = sessionStore(DUE);
    const provider = endpointAnswering([{ status: 200, body: RENEWED }]);
    renderScreen(
      <LocalStoreProvider value={storeValue(held.store)}>
        <AuthProvider endpoint={provider.endpoint} nowSeconds={() => NOW}>
          <Probe />
        </AuthProvider>
      </LocalStoreProvider>,
    );
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();

    expect(provider.refreshTokensSent).toEqual(['the-refresh-token']);
  });

  it('signs somebody out when the provider says the session is over', async () => {
    // `19` SIGN-9: revoked from somewhere else, and nothing local can know. The provider answers
    // `refresh_token_not_found`, measured against `kynviora-dev` on 2026-09-06.
    const held = sessionStore(DUE);
    const provider = endpointAnswering([
      { status: 400, body: { error_code: 'refresh_token_not_found' } },
    ]);
    const rendered = renderScreen(
      <LocalStoreProvider value={storeValue(held.store)}>
        <AuthProvider endpoint={provider.endpoint} nowSeconds={() => NOW}>
          <Probe />
        </AuthProvider>
      </LocalStoreProvider>,
    );
    await flush();

    expect(stateOf(rendered)).toBe('SIGNED_OUT:-');
    expect(held.current()).toBeNull();
  });

  it('asks again after an outage instead of leaving the session to die of a 401', async () => {
    // The defect `19` SIGN-8 is the shape of. A renewal that failed used to do nothing at all -
    // no retry, no reschedule - so one dropped packet at the moment a token came due left the app
    // holding an access token it would never replace, until an API call was refused and *that*
    // signed somebody out. Nothing here signs anybody out: an outage is not the end of a session.
    const held = sessionStore(DUE);
    const provider = endpointAnswering([
      { status: 503, body: {} },
      { status: 200, body: RENEWED },
    ]);
    const rendered = renderScreen(
      <LocalStoreProvider value={storeValue(held.store)}>
        <AuthProvider endpoint={provider.endpoint} nowSeconds={() => NOW}>
          <Probe />
        </AuthProvider>
      </LocalStoreProvider>,
    );
    await flush();
    expect(stateOf(rendered)).toBe('SIGNED_IN:header.payload.signature');
    expect(provider.refreshTokensSent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await flush();

    expect(provider.refreshTokensSent).toHaveLength(2);
    expect(stateOf(rendered)).toBe('SIGNED_IN:renewed.payload.signature');
  });

  it('stops asking rather than asking for ever', async () => {
    const held = sessionStore(DUE);
    const provider = endpointAnswering([{ status: 503, body: {} }]);
    const rendered = renderScreen(
      <LocalStoreProvider value={storeValue(held.store)}>
        <AuthProvider endpoint={provider.endpoint} nowSeconds={() => NOW}>
          <Probe />
        </AuthProvider>
      </LocalStoreProvider>,
    );
    await flush();

    // Two seconds, four, eight - four attempts in all - and then nothing. The backstop is the
    // API's `401`, which is the path that exists for everything a phone cannot predict.
    for (const step of [2_000, 4_000, 8_000, 16_000, 300_000]) {
      await vi.advanceTimersByTimeAsync(step);
      await flush();
    }
    expect(provider.refreshTokensSent).toHaveLength(4);
    // And still signed in. Four failed attempts are not evidence that a session ended.
    expect(stateOf(rendered)).toBe('SIGNED_IN:header.payload.signature');
  });

  it('does not restore a session that a sign-out ended while its renewal was in flight', async () => {
    // The one that matters for `12`. A renewal is a network round trip, and the session it was
    // started for can be gone before the answer lands: adopting it would write the session back to
    // disk and put somebody back into the app - on a phone they may have signed out of because
    // they were handing it to somebody else.
    const held = sessionStore(DUE);
    let release: ((value: Response) => void) | undefined;
    const blocked = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const impl = ((url: string) => {
      if (url.includes('grant_type=refresh_token')) return blocked;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;

    let captured: AuthContextValue | null = null;
    const rendered = renderScreen(
      <LocalStoreProvider value={storeValue(held.store)}>
        <AuthProvider
          endpoint={{ issuer: ISSUER, anonKey: ANON, fetchImpl: impl, nowSeconds: () => NOW }}
          nowSeconds={() => NOW}
        >
          <Probe
            capture={(value) => {
              captured = value;
            }}
          />
        </AuthProvider>
      </LocalStoreProvider>,
    );
    await flush();
    expect(stateOf(rendered)).toBe('SIGNED_IN:header.payload.signature');

    const auth = captured as AuthContextValue | null;
    await act(async () => {
      await auth?.signOut();
    });
    expect(stateOf(rendered)).toBe('SIGNED_OUT:-');

    release?.(new Response(JSON.stringify(RENEWED), { status: 200 }));
    await flush();

    expect(stateOf(rendered)).toBe('SIGNED_OUT:-');
    expect(held.current()).toBeNull();
  });
});
