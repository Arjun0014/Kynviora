/**
 * The API client, and who the app is acting as.
 *
 * Spec references: `13` (every request derives authority from an authenticated session), `14`
 * (nothing secret in a mobile bundle), `12` (authorization loss invalidates local access),
 * `04` Phase 1.1, DEC-038, DEC-118, DEC-124.
 *
 * WHY CONFIGURATION FAILURE IS A STATE AND NOT A CRASH
 * `resolveApiConfig` throws when `EXPO_PUBLIC_API_BASE_URL` is missing or unsafe, deliberately -
 * a client that silently defaults to localhost in a shipped build fails in a way nobody can see
 * from the code. But a thrown error at the root of an Expo app is a blank screen, which is the
 * least informative failure available. So the provider catches it once, here, and hands every
 * screen a client that is `null` plus the reason - which the screens already know how to render,
 * because "there is nothing to show and here is why" is a state they all have.
 *
 * TWO WAYS TO BE SOMEBODY, AND THE REAL ONE WINS
 * A `BEARER` session from {@link AuthProvider} where a person has signed in, and the development
 * header otherwise. Not a fallback in the dangerous direction: a signed-in session is never
 * replaced by a development identity, because that would be a real person's requests going out as
 * a fixture. The development path exists only where no provider is configured at all, and the
 * server refuses it under `NODE_ENV=production` regardless (DEC-038).
 *
 * THE 401 THE PHONE CANNOT PREDICT
 * A token can stop being accepted while it is still perfectly valid on its face: the account was
 * deleted (DEC-124), the session was revoked from another device, access was withdrawn. Nothing
 * local can know - `supabaseLive.test.ts` measured that a signed-out token keeps verifying
 * against the published key set until it expires - so the API's answer is what decides. Every
 * response passes through one wrapper here, and a `401` tells the auth provider the session is
 * gone. Once, on the transport, rather than in each of forty screens.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  ANONYMOUS,
  bearerSession,
  createClient,
  developmentSession,
  resolveApiConfig,
  resolveSession,
  type ClientSession,
  type KynvioraClient,
} from '@kynviora/contracts';
import { useAuth } from '@/auth/AuthProvider';

export interface ApiContextValue {
  /** `null` when the app is not configured to talk to anything. */
  readonly client: KynvioraClient | null;
  readonly session: ClientSession;
  /** Why there is no client, in words a developer can act on. Never shown to a user verbatim. */
  readonly configurationError: string | null;
  /**
   * A client whose session satisfies step-up, or `null` where none can be produced.
   *
   * `14` requires re-authentication for exports, caregiver administration and account deletion,
   * and the server checks freshness independently.
   *
   * **The two paths are not the same kind of thing.** On a `BEARER` session the answer is the
   * ordinary client: the server reads freshness from the token's own `amr` claim (DEC-118), so
   * there is no assertion for a client to make and no header to add - a person who signed in
   * moments ago already satisfies it, and one who did not is refused with `STEP_UP_REQUIRED` and
   * re-enters their password, which mints a token with a newer `amr` entry. On a development
   * session it is a header, it proves nothing, and it says so.
   */
  // A property carrying a function type rather than method shorthand, for the reason
  // `ProfileContextValue` gives: a method signature makes `this` meaningful, and every screen
  // that destructures this off the context is then an `unbound-method` error over something that
  // was never a method.
  readonly elevate: () => KynvioraClient | null;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export interface ApiProviderProps {
  readonly children: ReactNode;
  /**
   * Overrides for tests and for a future in-app profile switcher.
   *
   * Present so that "act as somebody else" does not require rebuilding the app, and absent from
   * the production path so that nothing can inject an identity at runtime.
   */
  readonly value?: ApiContextValue;
}

/**
 * Build the context from the environment and from whoever is signed in.
 *
 * Exported so a test can exercise the resolution without a React tree.
 */
export function resolveApiContext(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    /** The signed-in access token, where there is one. Takes precedence over everything. */
    readonly accessToken?: string | null;
    /** Told when the API refuses this session. Wired to the auth provider. */
    readonly onSessionLost?: () => void;
  } = {},
): ApiContextValue {
  const resolvedSession = safeSession(env, options.accessToken ?? null);

  try {
    const config = resolveApiConfig({ env });
    const current = resolvedSession.session;
    const client = createClient({
      config,
      session: current,
      fetch: watchingForRefusal(options.onSessionLost),
    });
    return {
      client,
      session: current,
      configurationError: resolvedSession.error,
      elevate: () => {
        switch (current.kind) {
          case 'BEARER':
            // Nothing to add. Freshness is the token's own, and a client that could assert it
            // would be a client asserting a re-authentication it did not perform.
            return client;
          case 'DEVELOPMENT':
            return client.withSession(developmentSession(current.userId, { stepUp: true }));
          case 'ANONYMOUS':
            // An anonymous session asserting step-up would be asserting that somebody confirmed
            // being nobody.
            return null;
        }
      },
    };
  } catch (error) {
    return {
      client: null,
      session: ANONYMOUS,
      configurationError: error instanceof Error ? error.message : String(error),
      elevate: () => null,
    };
  }
}

/**
 * A fetch that notices a refused session on the way past.
 *
 * The response is returned untouched - this reads a status and reports it, and every existing
 * outcome mapping downstream is unchanged. `401` only: a `403` is a step-up or a permission and
 * is a different conversation, and a `404` is deliberately indistinguishable from a refusal
 * (`13`) so it cannot be read as one here either.
 */
function watchingForRefusal(onSessionLost?: () => void): typeof fetch {
  return async (input: RequestInfo, init?: RequestInit) => {
    // React Native's `fetch` types take `RequestInfo` rather than the DOM's `RequestInfo | URL`,
    // and the client only ever passes a string. Narrowed rather than cast, so a caller passing a
    // URL object would be a compile error here instead of a runtime one on a device.
    const response = await fetch(input, init);
    if (response.status === 401) onSessionLost?.();
    return response;
  };
}

/**
 * Resolve the session, treating a malformed development user ID as "signed out".
 *
 * Deny by default: a session that cannot be constructed is not a reason to fall back to some
 * other identity, and the app being signed out is both safe and visible.
 */
function safeSession(
  env: Readonly<Record<string, string | undefined>>,
  accessToken: string | null,
): {
  session: ClientSession;
  error: string | null;
} {
  if (accessToken !== null && accessToken !== '') {
    try {
      return { session: bearerSession(accessToken), error: null };
    } catch (error) {
      return { session: ANONYMOUS, error: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    return { session: resolveSession(env), error: null };
  } catch (error) {
    return { session: ANONYMOUS, error: error instanceof Error ? error.message : String(error) };
  }
}

export function ApiProvider({ children, value }: ApiProviderProps) {
  const auth = useAuth();
  const accessToken = auth.tokens?.accessToken ?? null;
  const { sessionLost } = auth;

  const resolved = useMemo(
    () =>
      value ??
      resolveApiContext(
        {
          EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
          EXPO_PUBLIC_DEV_USER_ID: process.env.EXPO_PUBLIC_DEV_USER_ID,
          EXPO_PUBLIC_DEV_STEP_UP: process.env.EXPO_PUBLIC_DEV_STEP_UP,
        },
        { accessToken, onSessionLost: sessionLost },
      ),
    [value, accessToken, sessionLost],
  );

  return <ApiContext.Provider value={resolved}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiContextValue {
  const context = useContext(ApiContext);
  if (context === null) {
    throw new Error('useApi was called outside ApiProvider. Wrap the route tree in <ApiProvider>.');
  }
  return context;
}
