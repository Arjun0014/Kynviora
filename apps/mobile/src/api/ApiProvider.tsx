/**
 * The API client, and who the app is acting as.
 *
 * Spec references: `13` (every request derives authority from an authenticated session), `14`
 * (nothing secret in a mobile bundle), `04` Phase 1.1 (authentication, unstarted), DEC-038.
 *
 * WHY CONFIGURATION FAILURE IS A STATE AND NOT A CRASH
 * `resolveApiConfig` throws when `EXPO_PUBLIC_API_BASE_URL` is missing or unsafe, deliberately -
 * a client that silently defaults to localhost in a shipped build fails in a way nobody can see
 * from the code. But a thrown error at the root of an Expo app is a blank screen, which is the
 * least informative failure available. So the provider catches it once, here, and hands every
 * screen a client that is `null` plus the reason - which the screens already know how to render,
 * because "there is nothing to show and here is why" is a state they all have.
 *
 * THE SESSION IS READ ONCE
 * `EXPO_PUBLIC_*` values are inlined at build time, so there is no `process.env` to re-read on a
 * device. Reading them at module scope would also make them untestable; reading them here, once,
 * keeps the provider the only place that knows the app has an environment at all.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  ANONYMOUS,
  createClient,
  developmentSession,
  resolveApiConfig,
  resolveSession,
  type ClientSession,
  type KynvioraClient,
} from '@kynviora/contracts';

export interface ApiContextValue {
  /** `null` when the app is not configured to talk to anything. */
  readonly client: KynvioraClient | null;
  readonly session: ClientSession;
  /** Why there is no client, in words a developer can act on. Never shown to a user verbatim. */
  readonly configurationError: string | null;
  /**
   * A client whose session asserts step-up, or `null` where none can be produced.
   *
   * `14` requires re-authentication for exports, caregiver administration and account deletion,
   * and the server checks freshness independently - `hasFreshStepUp` compares the assertion
   * against a fifteen-minute window on the request's own clock.
   *
   * **This is a development stand-in, and it proves nothing.** Phase 1.1 has not chosen an auth
   * provider, so there is no re-authentication to perform; the development authenticator turns a
   * header into an assertion and a header is a client claim (DEC-038, `DEV-019`). What is real
   * here is the *shape*: a screen asks the user to confirm, an elevated client makes exactly the
   * one request that needs it, and the ordinary client is used for everything else - so the
   * privileged session never outlives the action. When Phase 1.1 lands, this function performs
   * the real prompt and nothing else changes.
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
 * Build the context from the environment.
 *
 * Exported so a test can exercise the resolution without a React tree.
 */
export function resolveApiContext(
  env: Readonly<Record<string, string | undefined>>,
): ApiContextValue {
  const session = safeSession(env);

  try {
    const config = resolveApiConfig({ env });
    const client = createClient({ config, session: session.session });
    const current = session.session;
    return {
      client,
      session: current,
      configurationError: session.error,
      elevate: () =>
        current.kind === 'DEVELOPMENT'
          ? client.withSession(developmentSession(current.userId, { stepUp: true }))
          : null,
    };
  } catch (error) {
    return {
      client: null,
      session: ANONYMOUS,
      configurationError: error instanceof Error ? error.message : String(error),
      // Nothing to elevate. An anonymous session asserting step-up would be asserting that
      // somebody confirmed being nobody.
      elevate: () => null,
    };
  }
}

/**
 * Resolve the session, treating a malformed development user ID as "signed out".
 *
 * Deny by default: a session that cannot be constructed is not a reason to fall back to some
 * other identity, and the app being signed out is both safe and visible.
 */
function safeSession(env: Readonly<Record<string, string | undefined>>): {
  session: ClientSession;
  error: string | null;
} {
  try {
    return { session: resolveSession(env), error: null };
  } catch (error) {
    return { session: ANONYMOUS, error: error instanceof Error ? error.message : String(error) };
  }
}

export function ApiProvider({ children, value }: ApiProviderProps) {
  const resolved = useMemo(
    () =>
      value ??
      resolveApiContext({
        EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
        EXPO_PUBLIC_DEV_USER_ID: process.env.EXPO_PUBLIC_DEV_USER_ID,
        EXPO_PUBLIC_DEV_STEP_UP: process.env.EXPO_PUBLIC_DEV_STEP_UP,
      }),
    [value],
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
