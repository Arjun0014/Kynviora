/**
 * Client configuration and the client-side session.
 *
 * Spec references: `13` (HTTPS only; never trust a profile ID as proof of access), `14` (mobile
 * bundle carries no secret; deny by default), `21` (environments), `04` Phase 1.1
 * (authentication, unstarted), DEC-038.
 *
 * THE SESSION IS A CLOSED UNION, AND THAT IS THE POINT
 * Phase 1.1 has not chosen an auth provider, so the only identity that exists today is the
 * development header the API accepts behind `KYNVIORA_DEV_AUTH=1`. Modelling it as one member of
 * {@link ClientSession} rather than as an optional `devUserId` field means the real session lands
 * as a second member and {@link authHeaders} is the single function that changes - and until then
 * every screen already handles "signed out" because the compiler makes it.
 *
 * THE DEVELOPMENT IDENTITY REFUSES THE SAME WAY THE SERVER DOES
 * `devAuth.ts` throws under `NODE_ENV=production` rather than warning, because a copied `.env` is
 * the ordinary way a development flag reaches a deployment. The client mirrors it: a development
 * session over a non-loopback `https` origin is refused when it is built, not silently sent. One
 * side refusing is a control; both sides refusing is a boundary.
 */

/** Header carrying the development identity. Must match `services/api/src/devAuth.ts`. */
export const DEV_USER_HEADER = 'x-kynviora-dev-user';

/** Header asserting the session has completed step-up. */
export const DEV_STEP_UP_HEADER = 'x-kynviora-dev-step-up';

/** `13`: idempotency key on retryable mutations. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** `20`: correlation, echoed by the server on every response. */
export const CORRELATION_HEADER = 'x-correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Who the client is acting as.
 *
 * `ANONYMOUS` is a real member rather than `null`, so a screen switching over this has to say
 * what it does when nobody is signed in instead of falling through a nullish check.
 */
export type ClientSession =
  | { readonly kind: 'ANONYMOUS' }
  | {
      readonly kind: 'DEVELOPMENT';
      readonly userId: string;
      /**
       * Whether to assert step-up on every request.
       *
       * Off by default. Step-up gates exports, caregiver administration and deletion (`14`), and
       * a client that always asserts it turns those gates into decoration - the paths could then
       * only ever be exercised in the satisfied direction.
       */
      readonly stepUp: boolean;
    }
  | {
      readonly kind: 'BEARER';
      /**
       * A Supabase access token, verbatim.
       *
       * Never parsed on this side. See {@link bearerSession}.
       */
      readonly accessToken: string;
    };

export const ANONYMOUS: ClientSession = Object.freeze({ kind: 'ANONYMOUS' });

/**
 * A signed-in session (DEC-118).
 *
 * The access token and nothing derived from it. A client that parsed the token to read a user ID,
 * an expiry or an assurance level would be deciding those things itself, and `13` puts every one
 * of them on the server: the API verifies a signature and reads the claims, and this side carries
 * the bytes.
 *
 * That is not a simplification. A phone reading `exp` out of a token it cannot verify is a phone
 * that believes a clock and a string an attacker could have written, and the failure it produces -
 * treating an invalid token as valid - is the one this whole boundary exists to prevent.
 */
export function bearerSession(accessToken: string): ClientSession {
  const token = accessToken.trim();
  if (token === '') {
    throw new SessionRefused(
      'An empty access token is not a session. The API would answer 401, which reads as a broken ' +
        'session rather than as a missing one.',
    );
  }
  return { kind: 'BEARER', accessToken: token };
}

export class SessionRefused extends Error {}

/**
 * Build a development session, or refuse.
 *
 * Refuses a malformed user ID, because a header the server will reject produces a 401 that reads
 * like a broken session rather than like a typo.
 */
export function developmentSession(
  userId: string,
  options: { readonly stepUp?: boolean } = {},
): ClientSession {
  if (!UUID.test(userId)) {
    throw new SessionRefused(
      'A development user ID must be a UUID. The API validates the header and would answer 401, ' +
        'which reads as a broken session rather than as a mistyped ID.',
    );
  }
  return { kind: 'DEVELOPMENT', userId, stepUp: options.stepUp ?? false };
}

/**
 * Request headers for a session.
 *
 * The one place identity becomes a header. When Phase 1.1 lands, a `BEARER` member is added here
 * and nothing else in the client changes.
 */
export function authHeaders(session: ClientSession): Readonly<Record<string, string>> {
  switch (session.kind) {
    case 'ANONYMOUS':
      // Deny by default: no header at all, not a header with an empty value. The server treats
      // an absent principal as unauthenticated, which is what this is.
      return {};
    case 'DEVELOPMENT':
      return session.stepUp
        ? { [DEV_USER_HEADER]: session.userId, [DEV_STEP_UP_HEADER]: '1' }
        : { [DEV_USER_HEADER]: session.userId };
    case 'BEARER':
      // The whole of it. No step-up header: the server reads freshness from the token's own
      // `amr` claim (DEC-118), so a client cannot assert re-authentication it did not perform -
      // which is what the development header does, and why it is a development header.
      return { authorization: `Bearer ${session.accessToken}` };
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ApiConfig {
  /** Origin of the API, with no trailing slash. */
  readonly baseUrl: string;
  /** How long a request may take before it is treated as unreachable, in milliseconds. */
  readonly timeoutMs: number;
}

/** Ten seconds. Long enough for a slow connection, short enough to fail a screen rather than hang it. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export class ConfigRefused extends Error {}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1'
  );
}

/**
 * Validate and normalise a base URL.
 *
 * `13` requires HTTPS. Loopback is the exception and only the exception: a development server on
 * `127.0.0.1` has no transport to intercept, and requiring a certificate for it would make the
 * rule something people turn off rather than something they keep.
 */
export function resolveBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigRefused(`API base URL is not a URL: ${JSON.stringify(raw)}.`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigRefused(`API base URL must be http or https, not ${url.protocol}.`);
  }
  if (url.protocol === 'http:' && !isLoopback(url)) {
    throw new ConfigRefused(
      `Refusing a plaintext API base URL that is not loopback: ${url.origin}. Spec 13 requires ` +
        'HTTPS, and health data over http on a network is exactly what that rule is about.',
    );
  }
  if (url.username !== '' || url.password !== '') {
    // Credentials in a URL end up in logs, crash reports and screenshots.
    throw new ConfigRefused('API base URL must not carry credentials.');
  }

  return url.origin;
}

/**
 * Refuse a development identity anywhere it could reach a real deployment.
 *
 * The mirror of `devAuth.ts` refusing under `NODE_ENV=production`. A development session is a
 * bearer of authority with no proof behind it; over a remote origin it is a request to be
 * somebody, sent to a server that may or may not decline.
 */
export function assertSessionAllowed(session: ClientSession, baseUrl: string): void {
  if (session.kind !== 'DEVELOPMENT') return;

  const url = new URL(baseUrl);
  if (!isLoopback(url)) {
    throw new SessionRefused(
      `Refusing to send a development identity header to ${url.origin}. Header-based identity ` +
        'carries no proof and belongs on a loopback development server only (DEC-038).',
    );
  }
}

export interface ResolveConfigOptions {
  /**
   * Environment to read from.
   *
   * Passed in rather than read from `process.env`, because Expo inlines `EXPO_PUBLIC_*` at build
   * time and there is no `process.env` to read at runtime on a device.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

/**
 * Read the client configuration from the environment.
 *
 * Only `EXPO_PUBLIC_*` names are read. `14` requires that nothing secret reaches a mobile bundle,
 * and the prefix is the convention that makes "is this shipped to a phone?" answerable by reading
 * the name.
 */
export function resolveApiConfig(options: ResolveConfigOptions = {}): ApiConfig {
  const env = options.env ?? {};
  const raw = env['EXPO_PUBLIC_API_BASE_URL'];

  if (raw === undefined || raw.trim() === '') {
    throw new ConfigRefused(
      'EXPO_PUBLIC_API_BASE_URL is not set. There is no default: a client that silently points ' +
        'at localhost in a shipped build fails in a way nobody can see from the code.',
    );
  }

  return {
    baseUrl: resolveBaseUrl(raw.trim()),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Read the development session from the environment, if one is configured.
 *
 * Returns {@link ANONYMOUS} when the variable is absent, which is the correct default: an app
 * with no identity configured is signed out, not signed in as somebody.
 */
export function resolveSession(
  env: Readonly<Record<string, string | undefined>> = {},
): ClientSession {
  const userId = env['EXPO_PUBLIC_DEV_USER_ID'];
  if (userId === undefined || userId.trim() === '') return ANONYMOUS;
  return developmentSession(userId.trim(), { stepUp: env['EXPO_PUBLIC_DEV_STEP_UP'] === '1' });
}
