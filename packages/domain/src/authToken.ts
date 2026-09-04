/**
 * What a verified access token says, and what may be concluded from it (Phase 1.1, DEC-118).
 *
 * Spec references: `13` ("every request derives authority from authenticated user/session and
 * server-side grants; never trust a profile ID in the request as proof of access"), `14`
 * (re-authentication for high-impact actions; reviewer/admin accounts require strong MFA;
 * reviewer roles are never inferred from client claims), `11` (server-authoritative
 * authorization), `BLK-010`.
 *
 * WHAT THIS MODULE IS
 * The **reading** of a token, with no cryptography in it. Verification - fetching a key,
 * checking a signature - is the API's job and depends on the network; deciding what a verified
 * token means is a rule, and a rule belongs where it can be tested exhaustively without one.
 *
 * The split matters more than it usually would. Every function here is total over untrusted
 * input, because the input is a JSON object an attacker chose: a claim of the wrong type, a claim
 * that is absent, a claim carrying an array where a string belongs. None of them may throw and
 * none of them may guess.
 *
 * THE ONE RULE EVERYTHING ELSE FOLLOWS FROM
 * `13`: identity is `sub`, from a token whose signature was checked, and nothing else. Not a
 * header, not a body field, not a query parameter. Nothing here takes a user ID as an argument,
 * so there is no function in this module a caller could hand one to.
 *
 * SHAPE FROM THE SUPABASE JWT CLAIMS REFERENCE, READ 2026-09-05
 * `iss`, `aud`, `exp`, `iat`, `sub`, `role`, `aal`, `session_id`, `email`, `phone` and
 * `is_anonymous` are documented as required; `amr`, `jti`, `nbf`, `app_metadata` and
 * `user_metadata` as optional. `aal` takes exactly `aal1` or `aal2`. `amr` is an array of
 * `{ method, timestamp }`. Nothing here assumes a claim is present because the documentation
 * calls it required - a token is what arrived, not what was promised.
 */

/** The only two values `aal` may take. Anything else is not a level, it is a stranger. */
export const ASSURANCE_LEVELS = ['aal1', 'aal2'] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

export function isAssuranceLevel(value: unknown): value is AssuranceLevel {
  return typeof value === 'string' && (ASSURANCE_LEVELS as readonly string[]).includes(value);
}

/** One authentication step, as `amr` records it. */
export interface AuthenticationMethod {
  readonly method: string;
  /** Unix seconds, as the claim carries it. */
  readonly timestamp: number;
}

/**
 * Claims this system reads.
 *
 * Deliberately not every claim a token may carry. `email` and `phone` are absent because nothing
 * in this system needs them from a token - the `app_user` row holds what is needed, and a profile
 * field read out of a client-presented token is a profile field an attacker chose. `role` is
 * absent for a sharper version of the same reason: `14` says reviewer roles are never inferred
 * from client claims, and a `role` claim is exactly such a claim.
 */
export interface VerifiedClaims {
  readonly sub: string;
  readonly iss: string;
  readonly aud: readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly assuranceLevel: AssuranceLevel;
  readonly sessionId: string | null;
  readonly isAnonymous: boolean;
  readonly authenticationMethods: readonly AuthenticationMethod[];
}

export type ClaimsRejection =
  | 'NOT_AN_OBJECT'
  | 'SUBJECT_MISSING'
  | 'ISSUER_MISSING'
  | 'AUDIENCE_MISSING'
  | 'EXPIRY_MISSING'
  | 'ISSUED_AT_MISSING'
  /** Present and not `aal1` or `aal2`. A level nobody defined is not a level to trust. */
  | 'ASSURANCE_UNKNOWN';

export type ClaimsOutcome =
  | { readonly kind: 'CLAIMS'; readonly claims: VerifiedClaims }
  | { readonly kind: 'REJECTED'; readonly reason: ClaimsRejection };

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * `aud` is documented as a string or an array of strings. Normalised to an array so callers have
 * one shape to check, and an empty result is a rejection rather than a permissive default.
 */
function asAudience(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

/**
 * `amr`, entry by entry, discarding anything malformed.
 *
 * Discarding rather than rejecting the whole token, and the direction is the point: a token whose
 * `amr` cannot be read has *fewer* authentication events than it claims, so it becomes less
 * privileged rather than more. An unreadable entry that was allowed to stand would be a step-up
 * granted by a malformed claim.
 */
function asMethods(value: unknown): readonly AuthenticationMethod[] {
  if (!Array.isArray(value)) return [];
  const methods: AuthenticationMethod[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const method = asString(record['method']);
    const timestamp = asFiniteNumber(record['timestamp']);
    if (method !== null && timestamp !== null) methods.push({ method, timestamp });
  }
  return methods;
}

/**
 * Read a verified token's payload.
 *
 * "Verified" is the caller's responsibility and this function cannot check it - which is why it
 * takes `unknown` and is named for what it does rather than for what it proves. Calling it on an
 * unverified payload produces a perfectly well-formed set of claims an attacker wrote.
 */
export function readClaims(payload: unknown): ClaimsOutcome {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: 'REJECTED', reason: 'NOT_AN_OBJECT' };
  }
  const record = payload as Record<string, unknown>;

  const sub = asString(record['sub']);
  if (sub === null) return { kind: 'REJECTED', reason: 'SUBJECT_MISSING' };

  const iss = asString(record['iss']);
  if (iss === null) return { kind: 'REJECTED', reason: 'ISSUER_MISSING' };

  const aud = asAudience(record['aud']);
  if (aud.length === 0) return { kind: 'REJECTED', reason: 'AUDIENCE_MISSING' };

  const exp = asFiniteNumber(record['exp']);
  if (exp === null) return { kind: 'REJECTED', reason: 'EXPIRY_MISSING' };

  const iat = asFiniteNumber(record['iat']);
  if (iat === null) return { kind: 'REJECTED', reason: 'ISSUED_AT_MISSING' };

  // Absent means `aal1`, which is what a token from a provider with no MFA configured carries.
  // Present-and-unrecognised is a rejection: a level nobody defined must not be read as the
  // lower one, because the next value anybody invents will be a higher one.
  const rawAal = record['aal'];
  if (rawAal !== undefined && !isAssuranceLevel(rawAal)) {
    return { kind: 'REJECTED', reason: 'ASSURANCE_UNKNOWN' };
  }

  return {
    kind: 'CLAIMS',
    claims: {
      sub,
      iss,
      aud,
      exp,
      iat,
      assuranceLevel: isAssuranceLevel(rawAal) ? rawAal : 'aal1',
      sessionId: asString(record['session_id']),
      // Deny by default: a token that does not say is treated as anonymous, and an anonymous
      // session is refused by `principalFrom`. The opposite default would let a malformed claim
      // produce a signed-in person.
      isAnonymous: record['is_anonymous'] !== false,
      authenticationMethods: asMethods(record['amr']),
    },
  };
}

// ---------------------------------------------------------------------------
// What may be concluded
// ---------------------------------------------------------------------------

export type TokenRejection =
  ClaimsRejection | 'EXPIRED' | 'NOT_YET_VALID' | 'WRONG_ISSUER' | 'WRONG_AUDIENCE' | 'ANONYMOUS';

/**
 * How much clock skew is tolerated between this server and the issuer.
 *
 * Thirty seconds. Long enough that an ordinary NTP drift does not sign people out mid-request,
 * short enough that an expired token is not usable for a meaningful period. Applied to `exp` and
 * to `iat`, in opposite directions.
 */
export const CLOCK_SKEW_SECONDS = 30;

export interface TokenAcceptance {
  readonly issuer: string;
  readonly audience: string;
  /** Unix seconds. Supplied rather than read from a clock, so a check is reproducible (DEC-003). */
  readonly now: number;
}

/**
 * Whether a verified token may be acted on at all.
 *
 * Separate from `readClaims` because these are checks against *this deployment* rather than
 * against the token's own shape: a perfectly well-formed token from another Supabase project is
 * exactly what an attacker with a free account has, and the issuer check is the only thing that
 * refuses it.
 */
export function acceptToken(
  claims: VerifiedClaims,
  acceptance: TokenAcceptance,
): { readonly kind: 'ACCEPTED' } | { readonly kind: 'REJECTED'; readonly reason: TokenRejection } {
  if (claims.iss !== acceptance.issuer) {
    return { kind: 'REJECTED', reason: 'WRONG_ISSUER' };
  }
  if (!claims.aud.includes(acceptance.audience)) {
    return { kind: 'REJECTED', reason: 'WRONG_AUDIENCE' };
  }
  if (claims.exp + CLOCK_SKEW_SECONDS <= acceptance.now) {
    return { kind: 'REJECTED', reason: 'EXPIRED' };
  }
  if (claims.iat - CLOCK_SKEW_SECONDS > acceptance.now) {
    return { kind: 'REJECTED', reason: 'NOT_YET_VALID' };
  }
  // An anonymous session is a real Supabase feature and this product has no use for one: every
  // route here is about a household somebody owns. Refusing it here means no route has to
  // remember to.
  if (claims.isAnonymous) {
    return { kind: 'REJECTED', reason: 'ANONYMOUS' };
  }
  return { kind: 'ACCEPTED' };
}

/**
 * When this session most recently proved who it was, or `null` where it never said.
 *
 * This is the mapping from Supabase's model onto `14`'s "re-authentication for high-impact
 * actions", and it is the one design decision in this file worth arguing about.
 *
 * `amr` records each authentication step with a timestamp, most recent first. The most recent
 * entry is therefore "the last time this person proved something about themselves", which is
 * exactly what a step-up window is asking about - and `supabase.auth.reauthenticate()` adds an
 * entry, so an explicit re-authentication moves it.
 *
 * The consequence, stated rather than hidden: somebody who signed in two minutes ago passes a
 * step-up check without doing anything further. That is correct. They authenticated two minutes
 * ago; asking again immediately would be ceremony, and `18` treats ceremony that changes nothing
 * as something people learn to click through.
 *
 * `max` rather than the first element, because "ordered most recent first" is a property of the
 * provider's serialisation and not of the type. Trusting the order would make the freshest
 * timestamp depend on a detail nobody here controls.
 */
export function lastAuthenticatedAtSeconds(claims: VerifiedClaims): number | null {
  if (claims.authenticationMethods.length === 0) return null;
  return Math.max(...claims.authenticationMethods.map((entry) => entry.timestamp));
}

/**
 * Whether a reviewer's session is strong enough to be one (`14`, `BLK-010`).
 *
 * `14` requires strong MFA for reviewer and admin accounts, and AAL2 is Supabase's name for
 * "verified with at least one second factor". This is the *session* half only: holding an AAL2
 * session grants nothing on its own, because authority is a row in `reviewer` and always has
 * been. Both are required and neither substitutes for the other.
 */
export function meetsReviewerAssurance(claims: VerifiedClaims): boolean {
  return claims.assuranceLevel === 'aal2';
}
