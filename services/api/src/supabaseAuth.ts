/**
 * The production authenticator: a verified Supabase access token, and nothing else (DEC-118).
 *
 * Spec references: `13` ("every request derives authority from authenticated user/session and
 * server-side grants; never trust a profile ID in the request as proof of access"), `14`
 * (re-authentication for high-impact actions; strong MFA for reviewer accounts; no secret in a
 * client), `11`, `21` (environments), `BLK-001`, `BLK-010`, Phase 1.1.
 *
 * WHAT IT REPLACES AND WHAT IT DOES NOT
 * `devAuth.ts` turns a header into a `Principal` and is refused outright under
 * `NODE_ENV=production`. This turns a **signed token** into one. Both satisfy the same port, which
 * is the whole reason the port exists - `createServer` takes an `authenticate` function and has
 * never known where a principal comes from.
 *
 * What it does not replace is authority. `14` says reviewer roles are never inferred from client
 * claims, and this reads no `role` claim at all: a `Principal` here is an ordinary user, exactly
 * as a development one is, and the reviewer console still requires a row in `reviewer`.
 *
 * ASYMMETRIC SIGNATURES ONLY, AND HS256 IS REFUSED
 * Supabase supports HS256, ES256 and RS256, and its own documentation strongly discourages the
 * first. A shared secret is verifiable by everything holding it, which means every service that
 * can *check* a token can also *mint* one - and `14`'s whole posture is that a compromised
 * component should not be able to manufacture identity. `ES256` and `RS256` verify with a public
 * key, so this process holds nothing worth stealing.
 *
 * The refusal is at the algorithm, before any key is chosen. An `alg` the verifier does not
 * recognise is the oldest JWT vulnerability there is, and the shape of it is always the same:
 * trusting the token to say how it should be checked.
 *
 * WHAT IS NOT VERIFIED HERE, AND WHY THAT IS HONEST
 * That any of this works against a real Supabase project. `BLK-010` is open: there are no
 * credentials, no project, and no issuer to fetch a key set from. Every test signs its own tokens
 * with a locally generated key pair, which exercises the signature check, the claim reading, the
 * issuer and audience checks and the AAL modelling for real - and proves nothing about a provider
 * nobody has provisioned. The device scenario `19` lists for sign-up and sign-in remains unrun.
 */

import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import {
  acceptToken,
  readClaims,
  lastAuthenticatedAtSeconds,
  meetsReviewerAssurance,
  unsafeId,
  type Instant,
  type TokenRejection,
  type UserId,
  type VerifiedClaims,
} from '@kynviora/domain';
import type { Principal } from './context.js';

/**
 * Algorithms this verifier accepts.
 *
 * A closed set, checked before a key is chosen. `none` and `HS256` are absent on purpose and the
 * absence is the control: a verifier that looked up a key first and checked the algorithm after
 * has already decided to trust the token's own description of itself.
 */
export const ACCEPTED_ALGORITHMS = ['ES256', 'RS256'] as const;
export type AcceptedAlgorithm = (typeof ACCEPTED_ALGORITHMS)[number];

function isAcceptedAlgorithm(value: unknown): value is AcceptedAlgorithm {
  return typeof value === 'string' && (ACCEPTED_ALGORITHMS as readonly string[]).includes(value);
}

export type VerificationFailure =
  | 'MALFORMED'
  | 'ALGORITHM_REFUSED'
  | 'KEY_UNKNOWN'
  | 'SIGNATURE_INVALID'
  /** Verified, and not strong enough for the surface it was presented to (`14`). */
  | 'ASSURANCE_INSUFFICIENT'
  | TokenRejection;

export type VerificationOutcome =
  | { readonly kind: 'VERIFIED'; readonly claims: VerifiedClaims }
  | { readonly kind: 'FAILED'; readonly reason: VerificationFailure };

/** A JSON Web Key, as the key set publishes it. */
export interface Jwk {
  readonly kid?: string;
  readonly alg?: string;
  readonly kty?: string;
  readonly [claim: string]: unknown;
}

/**
 * Where public keys come from.
 *
 * A port rather than a fetch, for the reason every other external dependency in this codebase is
 * one: a test that had to stand up an HTTPS server to check a signature would be testing the
 * server. {@link httpJwks} is the implementation that talks to a real project.
 */
export interface JwksSource {
  /** The keys, possibly cached. */
  keys(): Promise<readonly Jwk[]>;
  /**
   * The keys, ignoring any cache.
   *
   * Called once when a `kid` is not found. Supabase rotates signing keys and publishes the new
   * one before using it, but a cache that outlived a rotation would refuse every token until it
   * expired - so an unknown `kid` is a reason to look again rather than a reason to reject.
   * Exactly once, because an attacker who can choose a `kid` could otherwise make this process
   * fetch on every request.
   */
  refresh(): Promise<readonly Jwk[]>;
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Build a public key from a JWK.
 *
 * Node accepts a JWK directly, which is worth using rather than assembling a PEM: the conversion
 * is where a hand-rolled implementation gets curve parameters wrong, and getting them wrong tends
 * to fail open in ways that are hard to see.
 */
function publicKeyFrom(jwk: Jwk): KeyObject | null {
  try {
    return createPublicKey({ key: jwk as never, format: 'jwk' });
  } catch {
    return null;
  }
}

function verifyWith(
  algorithm: AcceptedAlgorithm,
  key: KeyObject,
  signingInput: string,
  signature: Buffer,
): boolean {
  try {
    if (algorithm === 'ES256') {
      // JWS carries an ECDSA signature as raw `r || s`; Node's default for EC is DER. Saying
      // which is required rather than optional - the DER reader rejects a raw signature, so
      // getting this wrong fails closed, which is the safe direction and also the confusing one.
      return verifySignature(
        'sha256',
        Buffer.from(signingInput),
        {
          key,
          dsaEncoding: 'ieee-p1363',
        },
        signature,
      );
    }
    return verifySignature('sha256', Buffer.from(signingInput), key, signature);
  } catch {
    return false;
  }
}

export interface VerifierOptions {
  /** The issuer this deployment accepts, e.g. `https://<ref>.supabase.co/auth/v1`. */
  readonly issuer: string;
  /** Supabase issues `authenticated` for a signed-in user. */
  readonly audience: string;
  readonly jwks: JwksSource;
  /** Injected, so a verification is reproducible (DEC-003). */
  now(): Instant;
}

/**
 * Verify one token, end to end.
 *
 * Order is deliberate and is the security of the whole file: shape, then **algorithm**, then key,
 * then signature, then claims, then this deployment's own checks. Every step before the signature
 * refuses without consulting the token's content, and the claim checks run only over bytes whose
 * signature has already been established.
 */
export async function verifyAccessToken(
  token: string,
  options: VerifierOptions,
): Promise<VerificationOutcome> {
  const parts = token.split('.');
  if (parts.length !== 3) return { kind: 'FAILED', reason: 'MALFORMED' };
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = decodeSegment(headerSegment);
  if (header === null || typeof header !== 'object') {
    return { kind: 'FAILED', reason: 'MALFORMED' };
  }
  const headerRecord = header as Record<string, unknown>;

  // Before a key is chosen. `none` and `HS256` end here.
  const algorithm = headerRecord['alg'];
  if (!isAcceptedAlgorithm(algorithm)) return { kind: 'FAILED', reason: 'ALGORITHM_REFUSED' };

  const kid = typeof headerRecord['kid'] === 'string' ? headerRecord['kid'] : null;
  if (kid === null) return { kind: 'FAILED', reason: 'MALFORMED' };

  let keys = await options.jwks.keys();
  let jwk = keys.find((candidate) => candidate.kid === kid);
  if (jwk === undefined) {
    // Once. A rotation publishes a new key before it is used, and refusing until the cache
    // expired would sign everybody out for ten minutes; refreshing per request would let anybody
    // choosing a `kid` drive this process's outbound traffic.
    keys = await options.jwks.refresh();
    jwk = keys.find((candidate) => candidate.kid === kid);
  }
  if (jwk === undefined) return { kind: 'FAILED', reason: 'KEY_UNKNOWN' };

  // A key that says which algorithm it is for must agree with the header. Without this, a key
  // published for one algorithm could be used to check a signature made with another.
  if (typeof jwk.alg === 'string' && jwk.alg !== algorithm) {
    return { kind: 'FAILED', reason: 'ALGORITHM_REFUSED' };
  }

  const key = publicKeyFrom(jwk);
  if (key === null) return { kind: 'FAILED', reason: 'KEY_UNKNOWN' };

  const signature = Buffer.from(signatureSegment, 'base64url');
  if (!verifyWith(algorithm, key, `${headerSegment}.${payloadSegment}`, signature)) {
    return { kind: 'FAILED', reason: 'SIGNATURE_INVALID' };
  }

  // Only now is the payload worth reading.
  const outcome = readClaims(decodeSegment(payloadSegment));
  if (outcome.kind === 'REJECTED') return { kind: 'FAILED', reason: outcome.reason };

  const accepted = acceptToken(outcome.claims, {
    issuer: options.issuer,
    audience: options.audience,
    now: Math.floor(Date.parse(options.now()) / 1000),
  });
  if (accepted.kind === 'REJECTED') return { kind: 'FAILED', reason: accepted.reason };

  return { kind: 'VERIFIED', claims: outcome.claims };
}

/**
 * The principal a verified token produces.
 *
 * `sub` and the last authentication instant, and nothing else. Every other field a token carries
 * is either irrelevant here or is a claim `14` forbids acting on.
 */
export function principalFrom(claims: VerifiedClaims): Principal {
  const lastAuth = lastAuthenticatedAtSeconds(claims);
  return {
    userId: unsafeId<UserId>(claims.sub),
    // `amr`'s most recent entry, which is when this person last proved something about
    // themselves. `hasFreshStepUp` compares it against its own window, so the mapping is stated
    // once here and applied by the rule that already existed.
    stepUpVerifiedAt:
      lastAuth === null ? null : (new Date(lastAuth * 1000).toISOString() as Instant),
  };
}

/**
 * A key set fetched over HTTPS and cached briefly.
 *
 * The cache is deliberately shorter than the ten minutes Supabase's edge already caches for. A
 * longer one would mean a rotated key is refused for longer than the provider expects, and the
 * symptom of that is every request failing at once.
 */
export function httpJwks(options: {
  readonly issuer: string;
  readonly cacheMs?: number;
  fetchImpl?: typeof fetch;
  now(): number;
}): JwksSource {
  const url = `${options.issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
  const cacheMs = options.cacheMs ?? 5 * 60 * 1000;
  const doFetch = options.fetchImpl ?? fetch;

  let cached: readonly Jwk[] = [];
  let fetchedAt = -Infinity;

  async function load(): Promise<readonly Jwk[]> {
    const response = await doFetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`JWKS fetch failed with ${String(response.status)}.`);
    const body = (await response.json()) as { readonly keys?: readonly Jwk[] };
    // Narrowed rather than trusted: a key set that is not an array is not "no keys yet", it is
    // a response this build did not expect, and treating it as empty is the safe reading.
    const keys: readonly Jwk[] = Array.isArray(body.keys) ? (body.keys as readonly Jwk[]) : [];
    cached = keys;
    fetchedAt = options.now();
    return keys;
  }

  return {
    async keys() {
      if (options.now() - fetchedAt < cacheMs) return cached;
      try {
        return await load();
      } catch {
        // The previous key set, if there is one. A transient network failure must not sign
        // everybody out; a first failure has nothing to fall back to and returns empty, which
        // becomes `KEY_UNKNOWN` rather than an accepted token.
        return cached;
      }
    },
    async refresh() {
      try {
        return await load();
      } catch {
        return cached;
      }
    },
  };
}

/**
 * Read the bearer token from a request.
 *
 * Case-insensitive on the scheme, because RFC 7235 says so and a client that sends `bearer` is
 * not an attacker. Nothing else is accepted: no query parameter, no cookie, no second header. A
 * token in a URL ends up in a log, a referrer and a browser history, which is why `14` keeps it
 * out of one.
 */
export function bearerTokenOf(request: FastifyRequest): string | null {
  const headers = request.headers as Record<string, string | string[] | undefined>;
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() ?? null;
}

export interface SupabaseAuthOptions extends VerifierOptions {
  /**
   * Told about every refusal, so a deployment can see authentication failing without the reason
   * reaching a client. `14` keeps the detail server-side; a caller gets `null` and the route
   * turns that into the same 401 every unauthenticated request gets.
   */
  onRefusal?(reason: VerificationFailure): void;
}

/**
 * The authenticator, satisfying the same port `devAuth` does.
 *
 * Returns `null` for every failure rather than throwing or distinguishing. A caller learning
 * *why* their token was refused learns whether a user ID exists, whether an issuer is right, and
 * whether a key is known - `13` does not let this API be an oracle, and an authentication
 * endpoint is the most valuable place for one.
 */
export function createSupabaseAuthenticator(
  options: SupabaseAuthOptions,
): (request: FastifyRequest) => Promise<Principal | null> {
  return async (request: FastifyRequest): Promise<Principal | null> => {
    const token = bearerTokenOf(request);
    if (token === null) return null;

    const outcome = await verifyAccessToken(token, options);
    if (outcome.kind === 'FAILED') {
      options.onRefusal?.(outcome.reason);
      return null;
    }
    return principalFrom(outcome.claims);
  };
}

/**
 * The reviewer console's authenticator (`14`, `BLK-010`, DEC-118).
 *
 * The household authenticator with one thing added and nothing removed: a token that is not AAL2
 * produces no principal at all.
 *
 * WHY REFUSAL RATHER THAN A WEAKER PRINCIPAL
 * `14` requires strong MFA for reviewer and admin accounts. A principal carrying "authenticated,
 * but only with a password" would be a thing every staff route then has to remember to check, and
 * the one that forgot would be the one that publishes. Refusing at the boundary means there is no
 * such principal to forget about.
 *
 * It also means the failure is legible. A reviewer who has not enrolled a second factor is not
 * partially signed in with some pages missing; they are signed out, on a surface that says why.
 *
 * WHAT THIS DOES NOT DO
 * Grant anything. `reviewerConsole.ts` reads a stored `reviewer` row and will continue to, because
 * `14` says a reviewer role is never inferred from a client claim - and `aal` is a claim. Holding
 * an AAL2 session and holding reviewer authority are two requirements, and neither substitutes for
 * the other.
 */
export function createReviewerAuthenticator(
  options: SupabaseAuthOptions,
): (request: FastifyRequest) => Promise<Principal | null> {
  return async (request: FastifyRequest): Promise<Principal | null> => {
    const token = bearerTokenOf(request);
    if (token === null) return null;

    const outcome = await verifyAccessToken(token, options);
    if (outcome.kind === 'FAILED') {
      options.onRefusal?.(outcome.reason);
      return null;
    }

    if (!meetsReviewerAssurance(outcome.claims)) {
      options.onRefusal?.('ASSURANCE_INSUFFICIENT');
      return null;
    }

    return principalFrom(outcome.claims);
  };
}
