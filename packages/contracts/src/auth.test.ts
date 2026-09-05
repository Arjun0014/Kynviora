import { describe, it, expect } from 'vitest';
import {
  msUntilRefresh,
  needsRefresh,
  readTokens,
  refreshSession,
  requestPasswordRecovery,
  signIn,
  signOut,
  signUp,
  REFRESH_MARGIN_SECONDS,
  type AuthEndpoint,
  type AuthTokens,
} from './auth.js';

/**
 * Signing in, and every way it goes wrong.
 *
 * Spec references: `13` (clients branch on codes, never on message text), `14`, `18` (a refusal
 * says what to do next), `19` (sign-up, sign-in, recovery), DEC-118.
 *
 * WHAT THIS FILE IS FOR
 * The mapping, and only the mapping. That a real Supabase project issues ES256 tokens with the
 * claims this build reads is measured in `services/api/src/supabaseLive.test.ts`, against a real
 * project; what is decided here is what a **screen** does with each answer, and the reason that
 * is worth its own file is that three of the provider's refusals lead to three entirely different
 * screens and the provider distinguishes them only in a machine code.
 *
 * The response bodies below are the shapes the live suite observed on 2026-09-05, not invented
 * ones.
 */

const ENDPOINT = (impl: typeof fetch): AuthEndpoint => ({
  issuer: 'https://project.supabase.co/auth/v1',
  anonKey: 'sb_publishable_not_a_secret',
  fetchImpl: impl,
});

/** A fetch that answers once, and records what it was asked. */
function answering(
  status: number,
  body: unknown,
): { impl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    // 204 has no body by definition and `new Response('', { status: 204 })` throws, which the
    // client would then catch and report as an outage - a helper bug wearing the shape of a
    // finding.
    const payload = status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve(new Response(payload, { status }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function refusing(error: Error): typeof fetch {
  return () => Promise.reject(error);
}

const SESSION = {
  access_token: 'header.payload.signature',
  refresh_token: 'a-refresh-token',
  expires_in: 3600,
  expires_at: 1_788_611_262,
  token_type: 'bearer',
};

const TOKENS: AuthTokens = {
  accessToken: 'header.payload.signature',
  refreshToken: 'a-refresh-token',
  expiresAtSeconds: 1_788_611_262,
};

describe('reading a session the provider handed over', () => {
  it('takes the expiry the provider sent, never one read out of the token', () => {
    // DEC-118 part 6 in one assertion. The access token here is not a JWT at all and has no `exp`
    // to read; the session is still complete, because expiry is a field the provider sent
    // alongside the token rather than a claim inside it.
    expect(readTokens(SESSION)).toEqual(TOKENS);
  });

  it('refuses a partial session rather than returning half of one', () => {
    // A session with no refresh token cannot be renewed and signs somebody out an hour later for
    // no visible reason; one with no expiry either never refreshes or refreshes constantly.
    expect(readTokens({ ...SESSION, refresh_token: undefined })).toBeNull();
    expect(readTokens({ ...SESSION, access_token: '' })).toBeNull();
    expect(readTokens({ ...SESSION, expires_at: undefined })).toBeNull();
    expect(readTokens({ ...SESSION, expires_at: 'soon' })).toBeNull();
    expect(readTokens(null)).toBeNull();
    expect(readTokens('nope')).toBeNull();
  });
});

describe('when to renew', () => {
  const expiry = TOKENS.expiresAtSeconds;

  it('renews a minute before expiry, not at it', () => {
    expect(needsRefresh(TOKENS, expiry - REFRESH_MARGIN_SECONDS - 1)).toBe(false);
    expect(needsRefresh(TOKENS, expiry - REFRESH_MARGIN_SECONDS)).toBe(true);
  });

  it('says now for a session that has already expired', () => {
    // Not a negative delay. A timer would run it immediately anyway, but only by accident.
    expect(msUntilRefresh(TOKENS, expiry + 10_000)).toBe(0);
    expect(needsRefresh(TOKENS, expiry + 10_000)).toBe(true);
  });

  it('counts down as the clock moves and does not depend on when it was asked', () => {
    const first = msUntilRefresh(TOKENS, expiry - 600);
    const second = msUntilRefresh(TOKENS, expiry - 300);
    expect(first - second).toBe(300_000);
  });
});

describe('signing in', () => {
  it('sends the address lowercased and the password untouched', async () => {
    const { impl, calls } = answering(200, SESSION);
    await signIn(ENDPOINT(impl), { email: '  Person@Example.Test ', password: '  spaces  ' });

    const sent = JSON.parse((calls[0]?.init.body ?? '{}') as string) as Record<string, string>;
    expect(sent.email).toBe('person@example.test');
    // Trimming a password would silently change a credential somebody chose, and the one it
    // would break is the one with a deliberate trailing space.
    expect(sent.password).toBe('  spaces  ');
    expect(calls[0]?.url).toContain('/token?grant_type=password');
  });

  it('returns the session', async () => {
    const { impl } = answering(200, SESSION);
    expect(await signIn(ENDPOINT(impl), { email: 'a@b.test', password: 'x' })).toEqual({
      kind: 'OK',
      value: TOKENS,
    });
  });

  it.each([
    ['invalid_credentials', 400, 'WRONG_CREDENTIALS'],
    ['email_not_confirmed', 400, 'EMAIL_UNCONFIRMED'],
    ['over_request_rate_limit', 429, 'RATE_LIMITED'],
    ['session_not_found', 403, 'SESSION_EXPIRED'],
  ] as const)('maps %s to %s', async (code, status, reason) => {
    const { impl } = answering(status, { code: status, error_code: code, msg: 'anything' });
    expect(await signIn(ENDPOINT(impl), { email: 'a@b.test', password: 'x' })).toEqual({
      kind: 'FAILED',
      reason,
    });
  });

  it('does not read a wrong password out of a dropped connection', async () => {
    // Telling somebody their password is wrong when their signal dropped is how they change a
    // password that was fine.
    const outcome = await signIn(ENDPOINT(refusing(new Error('network'))), {
      email: 'a@b.test',
      password: 'x',
    });
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'UNAVAILABLE' });
  });

  it('treats a code it has never seen as "something happened", not as a refusal', async () => {
    // The safe reading of a code this build does not know is that it does not know what happened.
    // Guessing would put somebody on a screen about their password over an outage.
    const { impl } = answering(500, { error_code: 'something_new_entirely' });
    expect(await signIn(ENDPOINT(impl), { email: 'a@b.test', password: 'x' })).toEqual({
      kind: 'FAILED',
      reason: 'UNAVAILABLE',
    });
  });

  it('refuses a 200 that carried no session', async () => {
    const { impl } = answering(200, { user: { id: 'someone' } });
    expect(await signIn(ENDPOINT(impl), { email: 'a@b.test', password: 'x' })).toEqual({
      kind: 'FAILED',
      reason: 'UNAVAILABLE',
    });
  });
});

describe('signing up', () => {
  it('reports that a confirmation is needed rather than that something failed', async () => {
    // What `kynviora-dev` actually does: 200, a user, no session. A screen rendering that as an
    // error would send somebody to try again at an account that already exists - and the next
    // attempt says `user_already_exists`, which reads as "you already have an account" to
    // somebody who has just this second made one.
    const { impl } = answering(200, { id: 'a-user-id', email: 'a@b.test', identities: [] });
    expect(await signUp(ENDPOINT(impl), { email: 'a@b.test', password: 'x' })).toEqual({
      kind: 'OK',
      value: { state: 'CONFIRMATION_REQUIRED' },
    });
  });

  it('reports a session where the project does not require confirmation', async () => {
    const { impl } = answering(200, SESSION);
    expect(await signUp(ENDPOINT(impl), { email: 'a@b.test', password: 'x' })).toEqual({
      kind: 'OK',
      value: { state: 'SIGNED_IN', tokens: TOKENS },
    });
  });

  it.each([
    ['user_already_exists', 422, 'EMAIL_ALREADY_REGISTERED'],
    ['email_address_invalid', 400, 'EMAIL_INVALID'],
    ['weak_password', 422, 'PASSWORD_TOO_WEAK'],
    ['over_email_send_rate_limit', 429, 'RATE_LIMITED'],
    ['signup_disabled', 422, 'SIGNUP_DISABLED'],
  ] as const)('maps %s to %s', async (code, status, reason) => {
    const { impl } = answering(status, { error_code: code, msg: 'anything' });
    expect(await signUp(ENDPOINT(impl), { email: 'a@b.test', password: 'x' })).toEqual({
      kind: 'FAILED',
      reason,
    });
  });
});

describe('asking for a password reset', () => {
  it('answers the same whether or not the address has an account', async () => {
    // The provider does not distinguish them and neither does this. An endpoint that answered
    // differently would tell anybody with a browser which of their contacts uses a medicines app.
    const { impl } = answering(200, {});
    expect(await requestPasswordRecovery(ENDPOINT(impl), 'someone@example.test')).toEqual({
      kind: 'OK',
      value: 'SENT_IF_KNOWN',
    });
  });

  it('reports a rate limit, because that one a person can act on', async () => {
    const { impl } = answering(429, { error_code: 'over_email_send_rate_limit' });
    expect(await requestPasswordRecovery(ENDPOINT(impl), 'a@b.test')).toEqual({
      kind: 'FAILED',
      reason: 'RATE_LIMITED',
    });
  });
});

describe('renewing', () => {
  it('exchanges the refresh token for a new session', async () => {
    const next = { ...SESSION, access_token: 'new.token.here', expires_at: 1_788_614_862 };
    const { impl, calls } = answering(200, next);
    const outcome = await refreshSession(ENDPOINT(impl), 'a-refresh-token');

    expect(calls[0]?.url).toContain('grant_type=refresh_token');
    expect(outcome).toEqual({
      kind: 'OK',
      value: { ...TOKENS, accessToken: 'new.token.here', expiresAtSeconds: 1_788_614_862 },
    });
  });

  it('reports a spent refresh token as a session that has ended', async () => {
    // Measured against the real project: signing out invalidates the refresh token, and the next
    // renewal answers exactly this. It is the one failure that must reach a sign-in screen rather
    // than a retry.
    const { impl } = answering(400, { error_code: 'refresh_token_not_found' });
    expect(await refreshSession(ENDPOINT(impl), 'spent')).toEqual({
      kind: 'FAILED',
      reason: 'SESSION_EXPIRED',
    });
  });

  it('reports an outage as an outage, so a renewal can be retried', async () => {
    // The distinction that matters: `SESSION_EXPIRED` signs somebody out, `UNAVAILABLE` does not.
    // A dropped connection must not end a session that is still perfectly valid.
    expect(await refreshSession(ENDPOINT(refusing(new Error('offline'))), 'fine')).toEqual({
      kind: 'FAILED',
      reason: 'UNAVAILABLE',
    });
  });
});

describe('signing out', () => {
  it('revokes every session by default', async () => {
    // The right default for a shared or lost device, and what a worried person means by "sign
    // out". `local` exists for the ordinary case of leaving one device.
    const { impl, calls } = answering(204, '');
    expect(await signOut(ENDPOINT(impl), 'an-access-token')).toBe(true);
    expect(calls[0]?.url).toContain('scope=global');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer an-access-token',
    );
  });

  it('reports failure without throwing, so the phone can forget the token anyway', async () => {
    // A phone that refused to forget its token because the network was down would stay signed in
    // exactly when somebody most wants it not to be.
    expect(await signOut(ENDPOINT(refusing(new Error('offline'))), 'token')).toBe(false);
    const { impl } = answering(500, {});
    expect(await signOut(ENDPOINT(impl), 'token')).toBe(false);
  });
});
