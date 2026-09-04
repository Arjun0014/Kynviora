import { describe, it, expect, beforeAll } from 'vitest';
import {
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  sign as signRaw,
  type KeyObject,
} from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { instantFrom, type Instant } from '@kynviora/domain';
import {
  ACCEPTED_ALGORITHMS,
  bearerTokenOf,
  createReviewerAuthenticator,
  createSupabaseAuthenticator,
  httpJwks,
  principalFrom,
  verifyAccessToken,
  type Jwk,
  type JwksSource,
} from './supabaseAuth.js';
import { hasFreshStepUp, type RequestContext } from './context.js';

/**
 * The production authenticator, against tokens signed here.
 *
 * Spec references: `13` (identity from an authenticated session; the API is not an oracle),
 * `14` (re-authentication for high-impact actions; reviewer roles never inferred from client
 * claims; no secret in a verifier), `BLK-010`, DEC-118.
 *
 * WHAT THESE TESTS ARE AND ARE NOT EVIDENCE OF
 * Every token below is signed with a key pair generated in `beforeAll`, so the signature check,
 * the algorithm gate, the key lookup, the claim reading, the issuer and audience checks and the
 * step-up mapping are all exercised for real. What none of it establishes is that a **Supabase**
 * project issues tokens of this shape, because there is no project (`BLK-010`). The shape comes
 * from the published JWT claims reference, read on 2026-09-05, and a reference is not a
 * measurement.
 *
 * THE FOUR ATTACKS WORTH WRITING DOWN
 *
 *  1. **`alg: none`, and `alg: HS256`.** The oldest JWT vulnerability there is, and it always has
 *     the same shape: the verifier trusting the token to say how it should be checked.
 *  2. **A valid token from another project.** An attacker with a free Supabase account has one.
 *     The issuer check is the only thing that refuses it, and nothing else in the system would.
 *  3. **A token whose payload was edited after signing.** The reason the signature is checked
 *     before the payload is read at all.
 *  4. **A `kid` nobody published.** Which must cost one refresh and then a refusal, not a fetch
 *     per request.
 */

const ISSUER = 'https://synthetic-project.supabase.co/auth/v1';
const AUDIENCE = 'authenticated';
const SUBJECT = '00000000-0000-4000-8000-000000000001';
const NOW = instantFrom('2026-09-05T12:00:00.000Z');
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);

let esKey: { privateKey: KeyObject; publicJwk: Jwk };
let rsaKey: { privateKey: KeyObject; publicJwk: Jwk };

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

interface TokenParts {
  readonly header?: Record<string, unknown>;
  readonly payload?: Record<string, unknown>;
  readonly key?: KeyObject;
  readonly algorithm?: 'ES256' | 'RS256';
  /** Replace the payload after signing, without re-signing. */
  readonly tamperPayload?: Record<string, unknown>;
}

function defaultPayload(): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: SUBJECT,
    exp: NOW_SECONDS + 3600,
    iat: NOW_SECONDS - 60,
    role: 'authenticated',
    aal: 'aal1',
    session_id: '11111111-1111-4111-8111-111111111111',
    is_anonymous: false,
    amr: [{ method: 'password', timestamp: NOW_SECONDS - 60 }],
  };
}

/** Mint a token. Everything is overridable, because every part of one is an attack surface. */
function mint(parts: TokenParts = {}): string {
  const algorithm = parts.algorithm ?? 'ES256';
  const key = parts.key ?? (algorithm === 'ES256' ? esKey.privateKey : rsaKey.privateKey);
  const header = parts.header ?? {
    alg: algorithm,
    typ: 'JWT',
    kid: algorithm === 'ES256' ? 'es-key-1' : 'rsa-key-1',
  };
  const payload = parts.payload ?? defaultPayload();

  const headerSegment = base64url(JSON.stringify(header));
  const payloadSegment = base64url(JSON.stringify(payload));
  const signingInput = `${headerSegment}.${payloadSegment}`;

  let signature: Buffer;
  if (algorithm === 'ES256') {
    signature = signRaw('sha256', Buffer.from(signingInput), {
      key,
      dsaEncoding: 'ieee-p1363',
    });
  } else {
    const signer = createSign('sha256');
    signer.update(signingInput);
    signature = signer.sign(key);
  }

  // The tamper case: a signature over one payload, presented with another.
  const presented =
    parts.tamperPayload === undefined
      ? payloadSegment
      : base64url(JSON.stringify(parts.tamperPayload));

  return `${headerSegment}.${presented}.${signature.toString('base64url')}`;
}

function staticJwks(keys: readonly Jwk[]): JwksSource & { readonly refreshes: () => number } {
  let refreshes = 0;
  return {
    keys: () => Promise.resolve(keys),
    refresh: () => {
      refreshes += 1;
      return Promise.resolve(keys);
    },
    refreshes: () => refreshes,
  };
}

function verifierOptions(jwks: JwksSource, now: Instant = NOW) {
  return { issuer: ISSUER, audience: AUDIENCE, jwks, now: (): Instant => now };
}

beforeAll(() => {
  const es = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  esKey = {
    privateKey: createPrivateKey(es.privateKey.export({ format: 'pem', type: 'pkcs8' })),
    publicJwk: { ...es.publicKey.export({ format: 'jwk' }), kid: 'es-key-1', alg: 'ES256' },
  };

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  rsaKey = {
    privateKey: createPrivateKey(rsa.privateKey.export({ format: 'pem', type: 'pkcs8' })),
    publicJwk: { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-key-1', alg: 'RS256' },
  };
});

// ---------------------------------------------------------------------------

describe('a well-formed token', () => {
  it('is accepted when signed with ES256', async () => {
    const jwks = staticJwks([esKey.publicJwk]);
    const outcome = await verifyAccessToken(mint(), verifierOptions(jwks));
    expect(outcome.kind).toBe('VERIFIED');
    if (outcome.kind === 'VERIFIED') {
      expect(outcome.claims.sub).toBe(SUBJECT);
      expect(outcome.claims.assuranceLevel).toBe('aal1');
      expect(outcome.claims.isAnonymous).toBe(false);
    }
  });

  it('is accepted when signed with RS256', async () => {
    const jwks = staticJwks([rsaKey.publicJwk]);
    const outcome = await verifyAccessToken(mint({ algorithm: 'RS256' }), verifierOptions(jwks));
    expect(outcome.kind).toBe('VERIFIED');
  });

  it('produces a principal carrying the subject and nothing chosen by the client', async () => {
    // `13`: identity is `sub`, from a token whose signature was checked. The `role` claim in the
    // payload above is deliberately present and deliberately ignored - `14` says reviewer roles
    // are never inferred from client claims, and a `role` claim is exactly such a claim.
    const jwks = staticJwks([esKey.publicJwk]);
    const outcome = await verifyAccessToken(mint(), verifierOptions(jwks));
    if (outcome.kind !== 'VERIFIED') throw new Error('expected a verified token');

    const principal = principalFrom(outcome.claims);
    expect(principal.userId).toBe(SUBJECT);
    expect(Object.keys(principal).sort()).toEqual(['stepUpVerifiedAt', 'userId']);
  });
});

describe('the algorithm gate', () => {
  it('refuses `alg: none` before it looks at a key', async () => {
    // The oldest JWT vulnerability there is. `KEY_UNKNOWN` here would mean the verifier had gone
    // looking for a key first, which is the wrong order even when the outcome matches.
    const jwks = staticJwks([esKey.publicJwk]);
    const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'es-key-1' }));
    const payload = base64url(JSON.stringify(defaultPayload()));
    const outcome = await verifyAccessToken(`${header}.${payload}.`, verifierOptions(jwks));
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'ALGORITHM_REFUSED' });
  });

  it('refuses HS256, which Supabase supports and discourages', async () => {
    // A shared secret is verifiable by everything holding it, so every service that can check a
    // token can also mint one. `14`'s posture is that a compromised component must not be able to
    // manufacture identity.
    const jwks = staticJwks([esKey.publicJwk]);
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'es-key-1' }));
    const payload = base64url(JSON.stringify(defaultPayload()));
    const outcome = await verifyAccessToken(
      `${header}.${payload}.c2lnbmF0dXJl`,
      verifierOptions(jwks),
    );
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'ALGORITHM_REFUSED' });
  });

  it('accepts exactly two algorithms', () => {
    expect([...ACCEPTED_ALGORITHMS]).toEqual(['ES256', 'RS256']);
  });

  it('refuses a key published for a different algorithm than the header claims', async () => {
    // Without this, a key published for one algorithm could be used to check a signature made
    // with another - which is the same confusion `alg: none` exploits, one level down.
    const jwks = staticJwks([{ ...esKey.publicJwk, alg: 'RS256' }]);
    const outcome = await verifyAccessToken(mint(), verifierOptions(jwks));
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'ALGORITHM_REFUSED' });
  });
});

describe('the signature', () => {
  it('refuses a payload edited after signing', async () => {
    // The reason the signature is checked before the payload is read at all.
    const jwks = staticJwks([esKey.publicJwk]);
    const token = mint({
      tamperPayload: { ...defaultPayload(), sub: '00000000-0000-4000-8000-0000000000ff' },
    });
    const outcome = await verifyAccessToken(token, verifierOptions(jwks));
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'SIGNATURE_INVALID' });
  });

  it('refuses a token signed with a key that is not the published one', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwks = staticJwks([esKey.publicJwk]);
    const token = mint({
      key: createPrivateKey(other.privateKey.export({ format: 'pem', type: 'pkcs8' })),
    });
    const outcome = await verifyAccessToken(token, verifierOptions(jwks));
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'SIGNATURE_INVALID' });
  });

  it('refuses a malformed token without throwing', async () => {
    const jwks = staticJwks([esKey.publicJwk]);
    for (const token of ['', 'not-a-token', 'a.b', 'a.b.c.d', '...']) {
      const outcome = await verifyAccessToken(token, verifierOptions(jwks));
      expect(outcome.kind).toBe('FAILED');
    }
  });
});

describe('the key set', () => {
  it('refreshes exactly once for an unknown kid, then refuses', async () => {
    // A rotation publishes a new key before it is used, so an unknown `kid` is a reason to look
    // again. Refreshing per request would let anybody choosing a `kid` drive this process's
    // outbound traffic.
    const jwks = staticJwks([esKey.publicJwk]);
    const token = mint({ header: { alg: 'ES256', typ: 'JWT', kid: 'never-published' } });
    const outcome = await verifyAccessToken(token, verifierOptions(jwks));
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'KEY_UNKNOWN' });
    expect(jwks.refreshes()).toBe(1);
  });

  it('does not refresh when the kid is already known', async () => {
    const jwks = staticJwks([esKey.publicJwk]);
    await verifyAccessToken(mint(), verifierOptions(jwks));
    expect(jwks.refreshes()).toBe(0);
  });

  it('serves a cached key set and keeps the last one through a network failure', async () => {
    // A transient failure must not sign everybody out. What it must also not do is accept
    // anything: with no previous key set there is nothing to fall back to, and an empty set
    // becomes `KEY_UNKNOWN`.
    let calls = 0;
    let failing = false;
    let clock = 0;
    const source = httpJwks({
      issuer: ISSUER,
      cacheMs: 1000,
      now: () => clock,
      fetchImpl: (): Promise<Response> => {
        calls += 1;
        if (failing) return Promise.reject(new Error('network'));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ keys: [esKey.publicJwk] }),
        } as unknown as Response);
      },
    });

    expect(await source.keys()).toHaveLength(1);
    expect(calls).toBe(1);
    // Inside the cache window: no second call.
    expect(await source.keys()).toHaveLength(1);
    expect(calls).toBe(1);

    clock += 2000;
    failing = true;
    expect(await source.keys()).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('asks the right URL', async () => {
    let requested: string | null = null;
    const source = httpJwks({
      issuer: `${ISSUER}/`,
      now: () => 0,
      fetchImpl: ((url: string): Promise<Response> => {
        requested = url;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ keys: [] }) } as Response);
      }) as unknown as typeof fetch,
    });
    await source.keys();
    expect(requested).toBe('https://synthetic-project.supabase.co/auth/v1/.well-known/jwks.json');
  });
});

describe('this deployment’s own checks', () => {
  it('refuses a perfectly valid token from another project', async () => {
    // What an attacker with a free Supabase account has. The issuer check is the only thing in
    // the system that refuses it - the signature is genuine and every claim is well-formed.
    const jwks = staticJwks([esKey.publicJwk]);
    const token = mint({
      payload: { ...defaultPayload(), iss: 'https://someone-elses.supabase.co/auth/v1' },
    });
    const outcome = await verifyAccessToken(token, verifierOptions(jwks));
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'WRONG_ISSUER' });
  });

  it('refuses the wrong audience', async () => {
    const jwks = staticJwks([esKey.publicJwk]);
    const token = mint({ payload: { ...defaultPayload(), aud: 'anon' } });
    const outcome = await verifyAccessToken(token, verifierOptions(jwks));
    expect(outcome).toEqual({ kind: 'FAILED', reason: 'WRONG_AUDIENCE' });
  });

  it('refuses an expired token, with a little skew', async () => {
    const jwks = staticJwks([esKey.publicJwk]);
    const expired = mint({ payload: { ...defaultPayload(), exp: NOW_SECONDS - 31 } });
    expect(await verifyAccessToken(expired, verifierOptions(jwks))).toEqual({
      kind: 'FAILED',
      reason: 'EXPIRED',
    });

    // Inside the skew allowance: an ordinary NTP drift must not sign somebody out mid-request.
    const justExpired = mint({ payload: { ...defaultPayload(), exp: NOW_SECONDS - 10 } });
    expect((await verifyAccessToken(justExpired, verifierOptions(jwks))).kind).toBe('VERIFIED');
  });

  it('refuses an anonymous session', async () => {
    // A real Supabase feature this product has no use for: every route here is about a household
    // somebody owns. Refused once, so no route has to remember to.
    const jwks = staticJwks([esKey.publicJwk]);
    const token = mint({ payload: { ...defaultPayload(), is_anonymous: true } });
    expect(await verifyAccessToken(token, verifierOptions(jwks))).toEqual({
      kind: 'FAILED',
      reason: 'ANONYMOUS',
    });
  });

  it('treats a missing is_anonymous claim as anonymous', async () => {
    // Deny by default. The opposite would let a malformed claim produce a signed-in person.
    const jwks = staticJwks([esKey.publicJwk]);
    const payload = { ...defaultPayload() };
    delete payload['is_anonymous'];
    expect(await verifyAccessToken(mint({ payload }), verifierOptions(jwks))).toEqual({
      kind: 'FAILED',
      reason: 'ANONYMOUS',
    });
  });

  it('refuses an assurance level nobody defined', async () => {
    // Not read as the lower one. The next value anybody invents will be a higher one.
    const jwks = staticJwks([esKey.publicJwk]);
    const token = mint({ payload: { ...defaultPayload(), aal: 'aal3' } });
    expect(await verifyAccessToken(token, verifierOptions(jwks))).toEqual({
      kind: 'FAILED',
      reason: 'ASSURANCE_UNKNOWN',
    });
  });
});

describe('step-up, mapped onto amr', () => {
  /** The rule that already existed, asked of a principal this file produced. */
  function freshFor(principal: { stepUpVerifiedAt: Instant | null }): boolean {
    return hasFreshStepUp({ principal, now: NOW } as unknown as RequestContext);
  }

  it('reads the most recent authentication as the step-up instant', async () => {
    const jwks = staticJwks([esKey.publicJwk]);
    const outcome = await verifyAccessToken(mint(), verifierOptions(jwks));
    if (outcome.kind !== 'VERIFIED') throw new Error('expected a verified token');
    expect(freshFor(principalFrom(outcome.claims))).toBe(true);
  });

  it('takes the newest entry rather than the first', async () => {
    // "Ordered most recent first" is a property of the provider's serialisation, not of the type.
    // Trusting the order would make the freshest timestamp depend on a detail nobody here
    // controls - and would read an hour-old sign-in as a step-up when a recent one exists.
    const jwks = staticJwks([esKey.publicJwk]);
    const token = mint({
      payload: {
        ...defaultPayload(),
        amr: [
          { method: 'password', timestamp: NOW_SECONDS - 7200 },
          { method: 'totp', timestamp: NOW_SECONDS - 60 },
        ],
      },
    });
    const outcome = await verifyAccessToken(token, verifierOptions(jwks));
    if (outcome.kind !== 'VERIFIED') throw new Error('expected a verified token');
    expect(freshFor(principalFrom(outcome.claims))).toBe(true);
  });

  it('is not fresh for a session that last authenticated hours ago', async () => {
    const jwks = staticJwks([esKey.publicJwk]);
    const token = mint({
      payload: {
        ...defaultPayload(),
        amr: [{ method: 'password', timestamp: NOW_SECONDS - 7200 }],
      },
    });
    const outcome = await verifyAccessToken(token, verifierOptions(jwks));
    if (outcome.kind !== 'VERIFIED') throw new Error('expected a verified token');
    expect(freshFor(principalFrom(outcome.claims))).toBe(false);
  });

  it('is not fresh for a token with no amr at all', async () => {
    // Deny by default: a token that does not say when somebody authenticated has not said they
    // authenticated recently.
    const jwks = staticJwks([esKey.publicJwk]);
    const payload = { ...defaultPayload() };
    delete payload['amr'];
    const outcome = await verifyAccessToken(mint({ payload }), verifierOptions(jwks));
    if (outcome.kind !== 'VERIFIED') throw new Error('expected a verified token');
    expect(principalFrom(outcome.claims).stepUpVerifiedAt).toBeNull();
    expect(freshFor(principalFrom(outcome.claims))).toBe(false);
  });

  it('discards a malformed amr entry rather than trusting it', async () => {
    // The direction is the point: an unreadable entry makes a token *less* privileged, never
    // more. An entry allowed to stand would be a step-up granted by a malformed claim.
    const jwks = staticJwks([esKey.publicJwk]);
    const token = mint({
      payload: {
        ...defaultPayload(),
        amr: [{ method: 'totp' }, { timestamp: NOW_SECONDS }, 'password', null],
      },
    });
    const outcome = await verifyAccessToken(token, verifierOptions(jwks));
    if (outcome.kind !== 'VERIFIED') throw new Error('expected a verified token');
    expect(principalFrom(outcome.claims).stepUpVerifiedAt).toBeNull();
  });
});

describe('the request boundary', () => {
  const requestWith = (headers: Record<string, string>) =>
    ({ headers }) as unknown as FastifyRequest;

  it('reads a bearer token case-insensitively', () => {
    expect(bearerTokenOf(requestWith({ authorization: 'Bearer abc.def.ghi' }))).toBe('abc.def.ghi');
    expect(bearerTokenOf(requestWith({ authorization: 'bearer abc.def.ghi' }))).toBe('abc.def.ghi');
  });

  it('reads a token from nowhere else', () => {
    // A token in a URL ends up in a log, a referrer and a browser history.
    expect(bearerTokenOf(requestWith({ authorization: 'Basic abc' }))).toBeNull();
    expect(bearerTokenOf(requestWith({ cookie: 'token=abc.def.ghi' }))).toBeNull();
    expect(bearerTokenOf(requestWith({}))).toBeNull();
  });

  it('answers every refusal identically, and tells the deployment which it was', async () => {
    // `13` does not let this API be an oracle, and an authentication endpoint is the most valuable
    // place for one: a caller learning *why* learns whether a user exists, whether an issuer is
    // right, and whether a key is known. The reason goes to the server's own log instead.
    const reasons: string[] = [];
    const authenticate = createSupabaseAuthenticator({
      ...verifierOptions(staticJwks([esKey.publicJwk])),
      onRefusal: (reason) => reasons.push(reason),
    });

    expect(await authenticate(requestWith({ authorization: 'Bearer nonsense' }))).toBeNull();
    expect(
      await authenticate(
        requestWith({
          authorization: `Bearer ${mint({ payload: { ...defaultPayload(), iss: 'https://elsewhere.test' } })}`,
        }),
      ),
    ).toBeNull();

    expect(reasons).toEqual(['MALFORMED', 'WRONG_ISSUER']);
  });

  it('produces a principal for a good token', async () => {
    const authenticate = createSupabaseAuthenticator(
      verifierOptions(staticJwks([esKey.publicJwk])),
    );
    const principal = await authenticate(requestWith({ authorization: `Bearer ${mint()}` }));
    expect(principal?.userId).toBe(SUBJECT);
  });

  it('returns null with no header at all, rather than a default identity', async () => {
    const authenticate = createSupabaseAuthenticator(
      verifierOptions(staticJwks([esKey.publicJwk])),
    );
    expect(await authenticate(requestWith({}))).toBeNull();
  });
});

describe('the reviewer surface', () => {
  const requestWith = (headers: Record<string, string>) =>
    ({ headers }) as unknown as FastifyRequest;

  function reviewerAuth(onRefusal?: (reason: string) => void) {
    return createReviewerAuthenticator({
      ...verifierOptions(staticJwks([esKey.publicJwk])),
      ...(onRefusal === undefined ? {} : { onRefusal }),
    });
  }

  it('refuses a verified AAL1 session outright', async () => {
    // `14` requires strong MFA for a reviewer account. A principal carrying "authenticated, but
    // only with a password" would be a thing every staff route then has to remember to check, and
    // the one that forgot would be the one that publishes.
    const reasons: string[] = [];
    const authenticate = reviewerAuth((reason) => reasons.push(reason));

    const principal = await authenticate(requestWith({ authorization: `Bearer ${mint()}` }));
    expect(principal).toBeNull();
    expect(reasons).toEqual(['ASSURANCE_INSUFFICIENT']);
  });

  it('admits an AAL2 session', async () => {
    const authenticate = reviewerAuth();
    const token = mint({
      payload: {
        ...defaultPayload(),
        aal: 'aal2',
        amr: [
          { method: 'password', timestamp: NOW_SECONDS - 120 },
          { method: 'totp', timestamp: NOW_SECONDS - 60 },
        ],
      },
    });
    const principal = await authenticate(requestWith({ authorization: `Bearer ${token}` }));
    expect(principal?.userId).toBe(SUBJECT);
  });

  it('admits the same session the household surface would, and no more', async () => {
    // The strength grants nothing. An AAL2 principal is an ordinary user here exactly as it is
    // there; `reviewerConsole.ts` reads a stored `reviewer` row, because `14` says a reviewer role
    // is never inferred from a client claim - and `aal` is a claim.
    const token = mint({ payload: { ...defaultPayload(), aal: 'aal2' } });
    const household = await createSupabaseAuthenticator(
      verifierOptions(staticJwks([esKey.publicJwk])),
    )(requestWith({ authorization: `Bearer ${token}` }));
    const reviewer = await reviewerAuth()(requestWith({ authorization: `Bearer ${token}` }));
    expect(reviewer).toEqual(household);
  });

  it('applies every other refusal before it looks at the level', async () => {
    // A token from another project must fail on the issuer, not on its assurance level: reporting
    // the second would tell an attacker their token was otherwise acceptable.
    const reasons: string[] = [];
    const authenticate = reviewerAuth((reason) => reasons.push(reason));
    const token = mint({
      payload: { ...defaultPayload(), aal: 'aal2', iss: 'https://elsewhere.test' },
    });
    await authenticate(requestWith({ authorization: `Bearer ${token}` }));
    expect(reasons).toEqual(['WRONG_ISSUER']);
  });
});
