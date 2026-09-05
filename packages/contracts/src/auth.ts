/**
 * Signing in, from a phone (DEC-118, DEC-124, DEC-125).
 *
 * Spec references: `13` (identity comes from an authenticated session; clients branch on codes,
 * never on message text), `14` (nothing secret in a mobile bundle; re-authentication for
 * high-impact actions), `18` (an older adult is a primary audience: one action per screen, and a
 * refusal says what to do next), `04` Phase 1.1, `19` (sign-up, sign-in, recovery), `BLK-010`.
 *
 * WHY THIS IS HERE AND NOT A LIBRARY
 * `@supabase/supabase-js` would bring a realtime client, a storage client, a PostgREST client and
 * a session manager that writes to `AsyncStorage` by default - which `14` names explicitly as not
 * approved for session data. What this app needs from an auth provider is six requests and a
 * refresh rule, all of which fit in one file that can be read in full and tested without a
 * network.
 *
 * WHAT THE CLIENT MAY NOT DO, AND THE ONE THAT MATTERS
 * **Parse the token.** DEC-118 part 6: a phone reading `exp` or `sub` out of a token it cannot
 * verify is a phone believing a string an attacker could have written. So expiry comes from the
 * provider's own `expires_at` field in the token response - a number the provider sent alongside
 * the token rather than one read out of it - and identity is never read at all. The phone carries
 * bytes; the server verifies them.
 *
 * WHY EVERY OUTCOME IS A CODE
 * `13` says clients branch on codes and never on message text, and this is where that rule earns
 * its keep: the provider's messages are English strings it may change, and three of them
 * ("Email not confirmed", "Invalid login credentials", "email rate limit exceeded") lead to three
 * entirely different screens. The mapping from provider code to Kynviora outcome is in one place
 * and is the only thing a screen sees.
 */

// The failure vocabulary lives in `@kynviora/domain`, because `@kynviora/presentation` has to
// word each member and cannot import this package - it is already a dependency of it.
import type { AuthFailure } from '@kynviora/domain';

export type { AuthFailure };

/** Where the provider lives and what identifies this project to it. Neither is a secret. */
export interface AuthEndpoint {
  /** `https://<ref>.supabase.co/auth/v1`, with no trailing slash. */
  readonly issuer: string;
  /** The publishable key. Identifies the project; grants nothing. */
  readonly anonKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * A session, as the provider handed it over.
 *
 * `expiresAtSeconds` is the provider's own `expires_at`, not something read out of the token.
 * That distinction is the whole of DEC-118 part 6 in one field.
 */
export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Unix seconds, as the provider reported. */
  readonly expiresAtSeconds: number;
}

/**
 * What can happen, as a closed set.
 *
 * Every member exists because a screen does something different about it. `EMAIL_UNCONFIRMED`
 * offers to send the confirmation again; `RATE_LIMITED` says to wait; `WRONG_CREDENTIALS` says
 * the email or the password is wrong and deliberately does not say which, because the provider
 * does not either and a client that guessed would be inventing an oracle.
 */

export type AuthOutcome<T> =
  | { readonly kind: 'OK'; readonly value: T }
  | { readonly kind: 'FAILED'; readonly reason: AuthFailure };

/**
 * Sign-up does not always produce a session.
 *
 * Where the project requires email confirmation - which `kynviora-dev` does - the provider
 * creates the account and returns no tokens at all. That is not a failure and a screen must not
 * render it as one: the next step is a mailbox, not a retry.
 */
export type SignUpResult =
  | { readonly state: 'SIGNED_IN'; readonly tokens: AuthTokens }
  | { readonly state: 'CONFIRMATION_REQUIRED' };

// ---------------------------------------------------------------------------
// Reading what the provider said
// ---------------------------------------------------------------------------

/**
 * The provider's error codes, mapped once.
 *
 * Taken from GoTrue's `error_code` field, which is a stable machine code - unlike `msg`, which is
 * prose. An unrecognised code becomes `UNAVAILABLE` rather than being guessed at, because the
 * safe reading of "the provider said something new" is that this build does not know what
 * happened.
 */
const FAILURE_BY_PROVIDER_CODE: Readonly<Record<string, AuthFailure>> = Object.freeze({
  invalid_credentials: 'WRONG_CREDENTIALS',
  email_not_confirmed: 'EMAIL_UNCONFIRMED',
  user_already_exists: 'EMAIL_ALREADY_REGISTERED',
  email_exists: 'EMAIL_ALREADY_REGISTERED',
  email_address_invalid: 'EMAIL_INVALID',
  validation_failed: 'EMAIL_INVALID',
  weak_password: 'PASSWORD_TOO_WEAK',
  over_email_send_rate_limit: 'RATE_LIMITED',
  over_request_rate_limit: 'RATE_LIMITED',
  mfa_verification_failed: 'SECOND_FACTOR_REQUIRED',
  insufficient_aal: 'SECOND_FACTOR_REQUIRED',
  refresh_token_not_found: 'SESSION_EXPIRED',
  refresh_token_already_used: 'SESSION_EXPIRED',
  session_not_found: 'SESSION_EXPIRED',
  session_expired: 'SESSION_EXPIRED',
  signup_disabled: 'SIGNUP_DISABLED',
  email_provider_disabled: 'SIGNUP_DISABLED',
});

function failureFor(status: number, body: Record<string, unknown>): AuthFailure {
  const code = typeof body['error_code'] === 'string' ? body['error_code'] : '';
  const mapped = FAILURE_BY_PROVIDER_CODE[code];
  if (mapped !== undefined) return mapped;
  // A status-only fallback, and only for the two that are unambiguous. 429 is a rate limit
  // whatever it says; 400 and 401 on a credential exchange are a refusal of the credential.
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 || status === 401 || status === 403) return 'WRONG_CREDENTIALS';
  return 'UNAVAILABLE';
}

/**
 * Read a token response.
 *
 * `null` where any of the three fields is missing, rather than a partial session: a session with
 * no refresh token cannot be renewed and would sign somebody out an hour later for no visible
 * reason, and one with no expiry would either never refresh or refresh constantly.
 */
export function readTokens(body: unknown): AuthTokens | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const accessToken = typeof record['access_token'] === 'string' ? record['access_token'] : '';
  const refreshToken = typeof record['refresh_token'] === 'string' ? record['refresh_token'] : '';
  if (accessToken === '' || refreshToken === '') return null;

  const expiresAt = record['expires_at'];
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    return { accessToken, refreshToken, expiresAtSeconds: expiresAt };
  }
  return null;
}

/**
 * How long before expiry a session is renewed.
 *
 * Sixty seconds. Long enough that a request started just before the margin still completes on a
 * valid token over a slow connection; short enough that it is not most of the session. A margin
 * of zero would mean every renewal races the expiry it is trying to avoid.
 */
export const REFRESH_MARGIN_SECONDS = 60;

/** Whether these tokens should be renewed now. */
export function needsRefresh(tokens: AuthTokens, nowSeconds: number): boolean {
  return tokens.expiresAtSeconds - REFRESH_MARGIN_SECONDS <= nowSeconds;
}

/**
 * Milliseconds until this session should be renewed, never negative.
 *
 * Clamped at zero so an already-stale session renews now rather than being scheduled into the
 * past - which a timer would run immediately anyway, but only by accident.
 */
export function msUntilRefresh(tokens: AuthTokens, nowSeconds: number): number {
  return Math.max(0, (tokens.expiresAtSeconds - REFRESH_MARGIN_SECONDS - nowSeconds) * 1000);
}

// ---------------------------------------------------------------------------
// The requests
// ---------------------------------------------------------------------------

async function post(
  endpoint: AuthEndpoint,
  path: string,
  body: Record<string, unknown>,
  bearer?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const doFetch = endpoint.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    apikey: endpoint.anonKey,
    'content-type': 'application/json',
  };
  if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`;

  const response = await doFetch(`${endpoint.issuer.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed };
}

/** Sign in with an email and a password. */
export async function signIn(
  endpoint: AuthEndpoint,
  credentials: { readonly email: string; readonly password: string },
): Promise<AuthOutcome<AuthTokens>> {
  let response;
  try {
    response = await post(endpoint, '/token?grant_type=password', {
      email: credentials.email.trim().toLowerCase(),
      password: credentials.password,
    });
  } catch {
    // A network failure is not a wrong password, and telling somebody their password is wrong
    // when their signal dropped is how they change a password that was fine.
    return { kind: 'FAILED', reason: 'UNAVAILABLE' };
  }

  if (response.status !== 200) {
    return { kind: 'FAILED', reason: failureFor(response.status, response.body) };
  }
  const tokens = readTokens(response.body);
  return tokens === null
    ? { kind: 'FAILED', reason: 'UNAVAILABLE' }
    : { kind: 'OK', value: tokens };
}

/**
 * Create an account.
 *
 * Where the project requires confirmation the provider returns a user and no session, which is
 * `CONFIRMATION_REQUIRED` rather than a failure.
 */
export async function signUp(
  endpoint: AuthEndpoint,
  credentials: { readonly email: string; readonly password: string },
): Promise<AuthOutcome<SignUpResult>> {
  let response;
  try {
    response = await post(endpoint, '/signup', {
      email: credentials.email.trim().toLowerCase(),
      password: credentials.password,
    });
  } catch {
    return { kind: 'FAILED', reason: 'UNAVAILABLE' };
  }

  if (response.status !== 200) {
    return { kind: 'FAILED', reason: failureFor(response.status, response.body) };
  }
  const tokens = readTokens(response.body);
  return {
    kind: 'OK',
    value: tokens === null ? { state: 'CONFIRMATION_REQUIRED' } : { state: 'SIGNED_IN', tokens },
  };
}

/**
 * Ask for a password-reset email.
 *
 * The outcome is deliberately the same whether or not the address has an account, which is what
 * the provider does too: an endpoint that answered differently would tell anybody with a browser
 * which of their contacts uses a medicines app.
 */
export async function requestPasswordRecovery(
  endpoint: AuthEndpoint,
  email: string,
): Promise<AuthOutcome<'SENT_IF_KNOWN'>> {
  let response;
  try {
    response = await post(endpoint, '/recover', { email: email.trim().toLowerCase() });
  } catch {
    return { kind: 'FAILED', reason: 'UNAVAILABLE' };
  }
  if (response.status === 200 || response.status === 204) {
    return { kind: 'OK', value: 'SENT_IF_KNOWN' };
  }
  return { kind: 'FAILED', reason: failureFor(response.status, response.body) };
}

/** Exchange a refresh token for a new session. */
export async function refreshSession(
  endpoint: AuthEndpoint,
  refreshToken: string,
): Promise<AuthOutcome<AuthTokens>> {
  let response;
  try {
    response = await post(endpoint, '/token?grant_type=refresh_token', {
      refresh_token: refreshToken,
    });
  } catch {
    return { kind: 'FAILED', reason: 'UNAVAILABLE' };
  }
  if (response.status !== 200) {
    return { kind: 'FAILED', reason: failureFor(response.status, response.body) };
  }
  const tokens = readTokens(response.body);
  return tokens === null
    ? { kind: 'FAILED', reason: 'UNAVAILABLE' }
    : { kind: 'OK', value: tokens };
}

/**
 * End the session at the provider.
 *
 * `scope` is `global` by default, which revokes every session this person holds anywhere. That is
 * the right default for a shared or lost device and it is the one a person means by "sign out"
 * when they are worried; `local` exists for the ordinary case of leaving one device.
 *
 * **It never reports failure to a caller**, and that is deliberate rather than lazy. Signing out
 * locally must happen whether or not the provider could be reached - a phone that refused to
 * forget its token because the network was down would be a phone that stays signed in exactly
 * when somebody most wants it not to be.
 */
export async function signOut(
  endpoint: AuthEndpoint,
  accessToken: string,
  scope: 'global' | 'local' = 'global',
): Promise<boolean> {
  try {
    const response = await post(endpoint, `/logout?scope=${scope}`, {}, accessToken);
    return response.status === 204 || response.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Read the provider from the app's public environment, or `null` where none is configured.
 *
 * Both values are safe to embed and `14`'s rule about secrets in a bundle does not bite: an
 * issuer is a URL, and the publishable key identifies the project and grants nothing. What it
 * *cannot* do is authorise anything - every request the app makes carries the person's own token,
 * and the key is only how the provider knows which project is being asked.
 *
 * `null` rather than a default. An app that fell back to some other project would be an app
 * signing people in somewhere nobody chose, and "no provider configured" is a state the sign-in
 * screen can say out loud.
 */
export function resolveAuthEndpoint(
  env: Readonly<Record<string, string | undefined>> = {},
): AuthEndpoint | null {
  const issuer = env['EXPO_PUBLIC_SUPABASE_AUTH_URL']?.trim();
  const anonKey = env['EXPO_PUBLIC_SUPABASE_ANON_KEY']?.trim();
  if (issuer === undefined || issuer === '' || anonKey === undefined || anonKey === '') {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    return null;
  }
  // `14`: a token is a bearer credential and a key set fetched over plaintext can be replaced in
  // transit. Loopback is allowed so a local Supabase stack can be pointed at, and an emulator
  // reaches the host through `10.0.2.2`, which is loopback from the device's point of view.
  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '10.0.2.2';
  if (parsed.protocol !== 'https:' && !loopback) return null;

  return { issuer: issuer.replace(/\/$/, ''), anonKey };
}
