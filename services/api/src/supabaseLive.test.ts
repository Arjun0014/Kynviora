import { describe, it, expect, beforeAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import {
  createReviewerAuthenticator,
  createSupabaseAuthenticator,
  httpJwks,
  verifyAccessToken,
  type JwksSource,
} from './supabaseAuth.js';
import { instantFrom, lastAuthenticatedAtSeconds, readClaims } from '@kynviora/domain';

/**
 * The verifier, against a real Supabase project (`BLK-010`, DEC-118).
 *
 * Spec references: `13` (identity comes from an authenticated session, never from the request),
 * `14` (strong MFA for reviewer accounts; re-authentication for high-impact actions; no secret in
 * a client), `19` (sign-up, sign-in and recovery), Phase 1.1.
 *
 * WHAT THIS ADDS THAT `supabaseAuth.test.ts` DID NOT
 * That file signs its own tokens with a key pair generated in `beforeAll`. It exercises the
 * signature check, the algorithm gate, the key-rotation path, the issuer and audience checks and
 * the AAL model **for real**, and DEC-118 said plainly what it establishes about a Supabase
 * project: nothing. Every claim shape in it came from a documentation page read on 2026-09-05,
 * and a reference is not a measurement.
 *
 * This one signs in to `kynviora-dev` and verifies what the provider actually issued, against the
 * key set the provider actually publishes. Four things could have been wrong and were not: the
 * signing algorithm, the claim names, the `amr` shape, and whether `aal` moves when a second
 * factor is used.
 *
 * WHAT IS STILL NOT PROVEN, SAID PLAINLY
 * **The email round trip.** The project requires confirmation (`mailer_autoconfirm: false`) and
 * its built-in sender is rate-limited to the point of refusing every attempt, so the synthetic
 * account was confirmed by an operator - which is exactly what the admin API's
 * `email_confirm: true` does, and is not evidence that anybody received a message or clicked a
 * link. What **is** proven either side of that: the provider refuses an unconfirmed address with
 * `email_not_confirmed`, and refuses a wrong password with `invalid_credentials`, in that order.
 *
 * The TOTP factor is genuinely enrolled and the codes are genuinely computed from its secret,
 * which is what an authenticator app does. Nothing about the second factor is simulated.
 *
 * HOW IT IS CREDENTIALLED
 * Entirely from the environment, and the suite skips as a whole without it. No credential is in
 * this file, in the repository, or in any test fixture.
 */

const ISSUER = process.env.KYNVIORA_SUPABASE_ISSUER?.trim() ?? '';
const ANON_KEY = process.env.KYNVIORA_SUPABASE_ANON_KEY?.trim() ?? '';
const EMAIL = process.env.KYNVIORA_SUPABASE_TEST_EMAIL?.trim() ?? '';
const PASSWORD = process.env.KYNVIORA_SUPABASE_TEST_PASSWORD ?? '';
const TOTP_SECRET = process.env.KYNVIORA_SUPABASE_TEST_TOTP_SECRET?.trim() ?? '';

const configured = ISSUER !== '' && ANON_KEY !== '' && EMAIL !== '' && PASSWORD !== '';
const runIfLive = configured ? describe : describe.skip;
const runIfMfa = configured && TOTP_SECRET !== '' ? describe : describe.skip;

// ---------------------------------------------------------------------------
// The provider, spoken to directly
// ---------------------------------------------------------------------------

interface AuthResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function auth(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<AuthResponse> {
  const headers: Record<string, string> = {
    apikey: ANON_KEY,
    'content-type': 'application/json',
  };
  if (init.token !== undefined) headers['authorization'] = `Bearer ${init.token}`;
  const response = await fetch(`${ISSUER}${path}`, { ...init, headers });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

/** RFC 6238, six digits, thirty seconds, SHA-1 - which is what an authenticator app computes. */
function totpCode(secretBase32: string, atMs: number = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secretBase32.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Math.floor(atMs / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', Buffer.from(bytes)).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    ((digest[offset + 1] as number) << 16) |
    ((digest[offset + 2] as number) << 8) |
    (digest[offset + 3] as number);
  return String(binary % 1_000_000).padStart(6, '0');
}

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function headerOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

/** A request carrying a bearer token, which is all the authenticators read. */
function bearer(token: string | null): FastifyRequest {
  return {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  } as unknown as FastifyRequest;
}

// ---------------------------------------------------------------------------

let aal1Token = '';
let aal2Token = '';
let refreshToken = '';
let jwks: JwksSource;

/**
 * One sign-in for the whole file.
 *
 * Supabase rate-limits token issuance per project, and a suite that signed in per test would
 * spend its budget proving the same thing repeatedly - and would then start failing for a reason
 * that has nothing to do with the code.
 */
beforeAll(async () => {
  if (!configured) return;
  jwks = httpJwks({ issuer: ISSUER, now: () => Date.now() });

  const signedIn = await auth('/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (signedIn.status !== 200) {
    throw new Error(
      `Sign-in to the live project failed with ${String(signedIn.status)}: ${JSON.stringify(signedIn.body).slice(0, 200)}`,
    );
  }
  aal1Token = signedIn.body['access_token'] as string;
  refreshToken = signedIn.body['refresh_token'] as string;

  if (TOTP_SECRET === '') return;

  // The enrolled factors come back on the user, not from a listing endpoint - `GET /factors` is
  // a 405. Worth saying, because "no AAL2 token" and "no factor enrolled" look identical from a
  // failing assertion.
  const user = await auth('/user', { token: aal1Token });
  const list = (user.body['factors'] ?? []) as {
    id: string;
    status: string;
    factor_type: string;
  }[];
  const verified = list.find(
    (factor) => factor.status === 'verified' && factor.factor_type === 'totp',
  );
  if (verified === undefined) return;

  const challenge = await auth(`/factors/${verified.id}/challenge`, {
    method: 'POST',
    token: aal1Token,
    body: '{}',
  });
  const stepped = await auth(`/factors/${verified.id}/verify`, {
    method: 'POST',
    token: aal1Token,
    body: JSON.stringify({ challenge_id: challenge.body['id'], code: totpCode(TOTP_SECRET) }),
  });
  if (stepped.status === 200) {
    aal2Token = stepped.body['access_token'] as string;
    refreshToken = stepped.body['refresh_token'] as string;
  }
}, 120_000);

// ---------------------------------------------------------------------------

runIfLive('what the provider actually issues', () => {
  it('signs with ES256 and names a key from the published set', async () => {
    const header = headerOf(aal1Token);
    // The decision that mattered most in DEC-118, and the one that could most easily have been
    // wrong: Supabase supports HS256 and this verifier refuses it before choosing a key. A project
    // issuing HS256 would have made the whole file fail at `ALGORITHM_REFUSED` - which would have
    // been the verifier working and the deployment unusable.
    expect(header['alg']).toBe('ES256');
    expect(typeof header['kid']).toBe('string');

    const keys = await jwks.keys();
    expect(keys.map((k) => k.kid)).toContain(header['kid']);
    // The key set carries public keys only. If a symmetric key were ever published here, every
    // service that can check a token could mint one.
    expect(keys.every((k) => k.kty === 'EC' || k.kty === 'RSA')).toBe(true);
    expect(keys.some((k) => 'd' in k)).toBe(false);
  });

  it('carries the claims this build reads, in the shapes it expects', () => {
    const claims = payloadOf(aal1Token);
    expect(claims['iss']).toBe(ISSUER);
    expect(claims['aud']).toBe('authenticated');
    expect(typeof claims['sub']).toBe('string');
    expect(claims['is_anonymous']).toBe(false);
    expect(claims['aal']).toBe('aal1');
    expect(typeof claims['session_id']).toBe('string');
    // `amr` as an array of `{ method, timestamp }`. DEC-118 took this from a documentation page;
    // this is the first time anything has looked at one.
    const amr = claims['amr'] as { method: string; timestamp: number }[];
    expect(Array.isArray(amr)).toBe(true);
    expect(amr[0]?.method).toBe('password');
    expect(typeof amr[0]?.timestamp).toBe('number');
  });

  it('is read by `readClaims` without loss', () => {
    const outcome = readClaims(payloadOf(aal1Token));
    expect(outcome.kind).toBe('CLAIMS');
    if (outcome.kind !== 'CLAIMS') return;
    expect(outcome.claims.assuranceLevel).toBe('aal1');
    expect(outcome.claims.isAnonymous).toBe(false);
    expect(outcome.claims.authenticationMethods).toHaveLength(1);
    expect(lastAuthenticatedAtSeconds(outcome.claims)).toBe(
      outcome.claims.authenticationMethods[0]?.timestamp,
    );
  });
});

runIfLive('verifying it, end to end, against the published key set', () => {
  it('accepts a token the project issued', async () => {
    const outcome = await verifyAccessToken(aal1Token, {
      issuer: ISSUER,
      audience: 'authenticated',
      jwks,
      now: () => instantFrom(new Date().toISOString()),
    });
    expect(outcome.kind).toBe('VERIFIED');
  });

  it('produces a principal whose identity is the token’s subject and nothing else', async () => {
    const authenticate = createSupabaseAuthenticator({
      issuer: ISSUER,
      audience: 'authenticated',
      jwks,
      now: () => instantFrom(new Date().toISOString()),
    });
    const principal = await authenticate(bearer(aal1Token));
    expect(principal).not.toBeNull();
    expect(principal?.userId).toBe(payloadOf(aal1Token)['sub']);
    // Step-up comes from `amr`, so signing in a moment ago is itself a step-up. DEC-118 states
    // that consequence rather than hiding it, and here it is on a real token.
    expect(principal?.stepUpVerifiedAt).not.toBeNull();
  });

  it('refuses the same token for another deployment’s issuer', async () => {
    // A perfectly well-formed token from another Supabase project is what an attacker with a free
    // account has, and the issuer check is the only thing that refuses it. Here the *same* token
    // is refused by changing only what this deployment will accept.
    const outcome = await verifyAccessToken(aal1Token, {
      issuer: 'https://someone-elses-project.supabase.co/auth/v1',
      audience: 'authenticated',
      jwks,
      now: () => instantFrom(new Date().toISOString()),
    });
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'WRONG_ISSUER' });
  });

  it('refuses the wrong audience', async () => {
    const outcome = await verifyAccessToken(aal1Token, {
      issuer: ISSUER,
      audience: 'service_role',
      jwks,
      now: () => instantFrom(new Date().toISOString()),
    });
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'WRONG_AUDIENCE' });
  });

  it('refuses it once it has expired, on the clock this deployment supplies', async () => {
    // A real token and an injected clock (DEC-003), rather than an hour of waiting. What is being
    // measured is that `exp` on a provider-issued token is read and acted on - and the token is
    // the provider's, not one this file signed.
    const exp = payloadOf(aal1Token)['exp'] as number;
    const outcome = await verifyAccessToken(aal1Token, {
      issuer: ISSUER,
      audience: 'authenticated',
      jwks,
      now: () => instantFrom(new Date((exp + 120) * 1000).toISOString()),
    });
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'EXPIRED' });
  });

  it('refuses a token whose payload was edited', async () => {
    // The subject changed to somebody else's, which is the attack the signature exists to stop.
    const [header, , signature] = aal1Token.split('.') as [string, string, string];
    const forged = { ...payloadOf(aal1Token), sub: '00000000-0000-4000-8000-00000000dead' };
    const tampered = `${header}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
    const outcome = await verifyAccessToken(tampered, {
      issuer: ISSUER,
      audience: 'authenticated',
      jwks,
      now: () => instantFrom(new Date().toISOString()),
    });
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'SIGNATURE_INVALID' });
  });

  it('refuses a token that names a key the project does not publish', async () => {
    const header = { ...headerOf(aal1Token), kid: '00000000-0000-0000-0000-000000000000' };
    const [, payload, signature] = aal1Token.split('.') as [string, string, string];
    const unknown = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${payload}.${signature}`;
    const outcome = await verifyAccessToken(unknown, {
      issuer: ISSUER,
      audience: 'authenticated',
      jwks,
      now: () => instantFrom(new Date().toISOString()),
    });
    // `KEY_UNKNOWN` rather than `SIGNATURE_INVALID`: the refusal happens before any key is used,
    // and the one refresh it allows itself found nothing either.
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'KEY_UNKNOWN' });
  });

  it('refuses an unsigned token claiming the same subject', async () => {
    // `alg: none`, the oldest JWT vulnerability there is, over a payload the provider really
    // issued - so everything about it is right except that nothing signed it.
    const [, payload] = aal1Token.split('.') as [string, string];
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`;
    const outcome = await verifyAccessToken(none, {
      issuer: ISSUER,
      audience: 'authenticated',
      jwks,
      now: () => instantFrom(new Date().toISOString()),
    });
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'ALGORITHM_REFUSED' });
  });
});

runIfMfa('the reviewer boundary, on a real second factor (spec 14)', () => {
  it('reaches AAL2 with a code computed from an enrolled factor', () => {
    expect(aal2Token, 'no AAL2 token - is a TOTP factor enrolled and verified?').not.toBe('');
    const claims = payloadOf(aal2Token);
    expect(claims['aal']).toBe('aal2');
    const amr = claims['amr'] as { method: string; timestamp: number }[];
    expect(amr.map((entry) => entry.method).sort()).toEqual(['password', 'totp']);
  });

  it('refuses a reviewer session that is only a password', async () => {
    const reviewer = createReviewerAuthenticator({
      issuer: ISSUER,
      audience: 'authenticated',
      jwks,
      now: () => instantFrom(new Date().toISOString()),
    });
    // No principal at all, rather than a weak one. DEC-118: a principal carrying "authenticated,
    // but only with a password" is a thing every staff route then has to remember to check, and
    // the one that forgot would be the one that publishes.
    expect(await reviewer(bearer(aal1Token))).toBeNull();
  });

  it('admits the same person once the second factor is used', async () => {
    const reviewer = createReviewerAuthenticator({
      issuer: ISSUER,
      audience: 'authenticated',
      jwks,
      now: () => instantFrom(new Date().toISOString()),
    });
    const principal = await reviewer(bearer(aal2Token));
    expect(principal).not.toBeNull();
    // The same person, refused a moment ago and admitted now, with only the assurance level
    // different. One identity, two sessions - which is what makes this a test of the boundary
    // rather than of two accounts.
    expect(principal?.userId).toBe(payloadOf(aal1Token)['sub']);
  });

  it('takes the step-up instant from the newest `amr` entry, which is the second factor', () => {
    const outcome = readClaims(payloadOf(aal2Token));
    expect(outcome.kind).toBe('CLAIMS');
    if (outcome.kind !== 'CLAIMS') return;
    const totp = outcome.claims.authenticationMethods.find((m) => m.method === 'totp');
    const password = outcome.claims.authenticationMethods.find((m) => m.method === 'password');
    expect(totp?.timestamp).toBeGreaterThan(password?.timestamp ?? 0);
    // `max`, not the first element. Supabase happens to order most-recent-first here, and DEC-118
    // declined to depend on that - this is the measurement that shows the ordering is real and
    // that not depending on it costs nothing.
    expect(lastAuthenticatedAtSeconds(outcome.claims)).toBe(totp?.timestamp);
  });
});

runIfLive('the session over time', () => {
  it('keeps the assurance level and the session across a refresh', async () => {
    const refreshed = await auth('/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    expect(refreshed.status).toBe(200);
    const token = refreshed.body['access_token'] as string;
    refreshToken = refreshed.body['refresh_token'] as string;

    const before = payloadOf(aal2Token === '' ? aal1Token : aal2Token);
    const after = payloadOf(token);
    // A refresh that silently dropped a reviewer to AAL1 would sign them out of the console
    // mid-review with no explanation, and a refresh that started a new session would break every
    // "same session, no sign-out" claim the caregiver and dose tests make.
    expect(after['aal']).toBe(before['aal']);
    expect(after['session_id']).toBe(before['session_id']);

    const outcome = await verifyAccessToken(token, {
      issuer: ISSUER,
      audience: 'authenticated',
      jwks,
      now: () => instantFrom(new Date().toISOString()),
    });
    expect(outcome.kind).toBe('VERIFIED');
  });

  it('stops issuing tokens once the session is signed out', async () => {
    const signedOut = await auth('/logout', {
      method: 'POST',
      token: aal2Token === '' ? aal1Token : aal2Token,
      body: '{}',
    });
    expect(signedOut.status).toBe(204);

    const afterwards = await auth('/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    expect(afterwards.status).toBe(400);
    expect(afterwards.body['error_code']).toBe('refresh_token_not_found');
  });

  it('leaves the access token cryptographically valid until it expires, and that is the point', async () => {
    // **The finding this file exists to record.** Sign-out revokes the *session*: the provider's
    // own `/user` answers `session_not_found` immediately. But a Supabase access token is verified
    // locally against a published key set, so nothing in this API's verification path can know the
    // session is gone - the token keeps verifying until `exp`, up to an hour later.
    //
    // That is not a defect in the verifier; it is what stateless verification means. It is
    // recorded here because it decides a design elsewhere: "invalidate sessions immediately" for
    // account deletion cannot be satisfied by the token, and has to be satisfied by the server
    // refusing a subject it no longer recognises.
    const token = aal2Token === '' ? aal1Token : aal2Token;

    const provider = await auth('/user', { token });
    expect(provider.status).toBe(403);
    expect(provider.body['error_code']).toBe('session_not_found');

    const local = await verifyAccessToken(token, {
      issuer: ISSUER,
      audience: 'authenticated',
      jwks,
      now: () => instantFrom(new Date().toISOString()),
    });
    expect(local.kind).toBe('VERIFIED');
  });
});

runIfLive('what the provider refuses before it issues anything', () => {
  it('refuses a wrong password', async () => {
    const refused = await auth('/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: 'definitely-not-the-password' }),
    });
    expect(refused.status).toBe(400);
    expect(refused.body['error_code']).toBe('invalid_credentials');
  });

  it('refuses an address nobody has', async () => {
    const refused = await auth('/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody-at-all@kynviora.test', password: 'whatever-this-is' }),
    });
    expect(refused.status).toBe(400);
    // The same code as a wrong password, which is correct: an authentication endpoint that
    // distinguished them would be an oracle for which addresses have accounts.
    expect(refused.body['error_code']).toBe('invalid_credentials');
  });
});
