/**
 * Who is signed in, and keeping them so (DEC-118, DEC-124, DEC-125).
 *
 * Spec references: `13` (identity comes from an authenticated session), `14` (session data in the
 * encrypted store; re-authentication for high-impact actions), `12` (authorization loss
 * invalidates local access), `18` (a refusal says what to do next), `04` Phase 1.1, `19`.
 *
 * FOUR THINGS, AND THE LAST ONE IS THE ONE THAT GETS SKIPPED
 *
 * **Restore.** The stored session is read once, at launch, before anything renders a screen -
 * `LOADING` is a real state so that a signed-in person does not see a sign-in screen flash past
 * on every cold start.
 *
 * **Renew.** One timer, computed from the provider's own `expires_at` and rescheduled whenever
 * the session changes. Not an interval: an interval that fires while the app is backgrounded
 * bunches up, and one that fires too rarely lets a session expire under a request already in
 * flight.
 *
 * **Sign out.** Locally first and unconditionally, then at the provider. A phone that refused to
 * forget its token because the network was down would stay signed in exactly when somebody most
 * wants it not to be.
 *
 * **Lose authorization.** The one that gets skipped. A token can stop working while it is still
 * perfectly valid on its face - the account was deleted, the session was revoked from another
 * device, the person's access was withdrawn - and the phone finds out from a `401`, not from a
 * clock. `supabaseLive.test.ts` measured why this cannot be inferred locally: after a sign-out
 * the provider refuses the token immediately and it goes on verifying against the published key
 * set until it expires. So the API's answer is what decides, and `sessionLost` is how it says so.
 *
 * WHAT RE-AUTHENTICATION IS, CONCRETELY
 * `14` requires it for exports, caregiver administration and deletion. Supabase records each
 * authentication step in `amr` and the server reads step-up from the newest one (DEC-118 part 3),
 * so a password re-entry that produces a **new token** is a real step-up - there is no separate
 * ceremony to perform and no client-side assertion to make. That is why `reauthenticate` takes a
 * password and returns nothing: what it changes is the session.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  msUntilRefresh,
  needsRefresh,
  refreshSession,
  requestPasswordRecovery,
  resolveAuthEndpoint,
  signIn as providerSignIn,
  signOut as providerSignOut,
  signUp as providerSignUp,
  type AuthEndpoint,
  type AuthOutcome,
  type AuthTokens,
  type SignUpResult,
} from '@kynviora/contracts';
import { useLocalStore } from '@/storage/LocalStoreProvider';

export type AuthState =
  /** The stored session has not been read yet. Not the same as signed out. */
  | 'LOADING'
  | 'SIGNED_OUT'
  | 'SIGNED_IN'
  /** No provider is configured. The app cannot sign anybody in and says so. */
  | 'UNCONFIGURED';

/**
 * Properties carrying function types rather than method shorthand, for the reason
 * `ApiContextValue.elevate` gives: a method signature makes `this` meaningful, and every screen
 * that destructures one off the context is then an `unbound-method` error over something that was
 * never a method.
 */
export interface AuthContextValue {
  readonly state: AuthState;
  /** The current session, or `null`. The access token is carried, never parsed. */
  readonly tokens: AuthTokens | null;
  readonly signIn: (email: string, password: string) => Promise<AuthOutcome<AuthTokens>>;
  readonly signUp: (email: string, password: string) => Promise<AuthOutcome<SignUpResult>>;
  readonly recover: (email: string) => Promise<AuthOutcome<'SENT_IF_KNOWN'>>;
  /**
   * A password re-entry, which produces a new token and therefore a fresh step-up (`14`).
   *
   * `email` is for the case this provider deliberately cannot answer on its own: a **restored**
   * session knows its tokens and not the address they belong to, because an address on disk is
   * one more personal identifier at rest for a convenience. The caller supplies it - the account
   * screens read it from `GET /v1/me`, which is the server's own answer over an authenticated
   * request rather than anything kept on the phone.
   */
  readonly reauthenticate: (password: string, email?: string) => Promise<AuthOutcome<AuthTokens>>;
  /** Forget the session here, then revoke it everywhere. */
  readonly signOut: () => Promise<void>;
  /**
   * The API said this session is no longer accepted.
   *
   * Not a sign-out request from the person: nothing is revoked at the provider, because there may
   * be nothing left to revoke. The phone forgets what it is holding, which is the only part still
   * under its control.
   */
  readonly sessionLost: () => void;
}

const UNCONFIGURED: AuthContextValue = {
  state: 'UNCONFIGURED',
  tokens: null,
  signIn: () => Promise.resolve({ kind: 'FAILED', reason: 'UNAVAILABLE' }),
  signUp: () => Promise.resolve({ kind: 'FAILED', reason: 'UNAVAILABLE' }),
  recover: () => Promise.resolve({ kind: 'FAILED', reason: 'UNAVAILABLE' }),
  reauthenticate: () => Promise.resolve({ kind: 'FAILED', reason: 'UNAVAILABLE' }),
  signOut: () => Promise.resolve(),
  sessionLost: () => undefined,
};

const AuthContext = createContext<AuthContextValue>(UNCONFIGURED);

export interface AuthProviderProps {
  readonly children: ReactNode;
  /** Injected for tests and for a device harness that needs a known provider. */
  readonly endpoint?: AuthEndpoint | null;
  readonly value?: AuthContextValue;
  /** Injected so a renewal test does not wait an hour (DEC-003 applied to a phone). */
  readonly nowSeconds?: () => number;
}

/** The email this account signed in with, remembered only to re-authenticate with it. */
interface Signed {
  readonly tokens: AuthTokens;
  readonly email: string;
}

export function AuthProvider({ children, endpoint, value, nowSeconds }: AuthProviderProps) {
  const store = useLocalStore();
  const clock = nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  // Read through a ref rather than captured, so the endpoint below is not rebuilt on every render
  // by a clock whose identity changes each time. What the endpoint needs is the *current* clock at
  // the moment a response arrives, which is exactly what a ref gives it.
  const clockRef = useRef(clock);
  clockRef.current = clock;

  const resolved = useMemo(() => {
    const base =
      endpoint ??
      resolveAuthEndpoint({
        EXPO_PUBLIC_SUPABASE_AUTH_URL: process.env.EXPO_PUBLIC_SUPABASE_AUTH_URL,
        EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
      });
    // The same clock the renewal rule reads. A session dated by one clock and renewed against
    // another is the skew defect `readTokens` documents, reintroduced one layer up.
    return base === null ? null : { ...base, nowSeconds: () => clockRef.current() };
  }, [endpoint]);

  const [signed, setSigned] = useState<Signed | null>(null);
  const [restored, setRestored] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Persist and adopt, in that order: a session on screen and not on disk is one a restart loses. */
  const adopt = useCallback(
    async (tokens: AuthTokens, email: string): Promise<void> => {
      // Caught rather than propagated, for `DEV-055`'s reason: a store that cannot be written is
      // a session that will not survive a restart, and that is a worse day rather than a reason
      // to refuse a sign-in that has already happened.
      await store.session?.write(tokens).catch(() => undefined);
      setSigned({ tokens, email });
    },
    [store.session],
  );

  const forget = useCallback((): void => {
    setSigned(null);
    void store.session?.clear().catch(() => undefined);
  }, [store.session]);

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (value !== undefined || resolved === null) {
      setRestored(true);
      return;
    }
    if (!store.settled) return;
    let live = true;

    void (async () => {
      const stored = await store.session?.read().catch(() => null);
      if (!live) return;
      if (stored === null || stored === undefined) {
        setRestored(true);
        return;
      }
      // The email is not stored, so a restored session cannot re-authenticate until the person
      // signs in again in this run. That is a deliberate omission rather than a gap: an address
      // on disk is one more personal identifier at rest for a convenience, and the step-up path
      // asks for a password anyway.
      setSigned({ tokens: stored, email: '' });
      setRestored(true);
    })();

    return () => {
      live = false;
    };
  }, [store.settled, store.session, value, resolved]);

  // -------------------------------------------------------------------------
  // Renew
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (resolved === null || signed === null) return;

    const endpointNow = resolved;
    const current = signed;

    const renew = (): void => {
      void refreshSession(endpointNow, current.tokens.refreshToken).then((outcome) => {
        if (outcome.kind === 'OK') {
          void adopt(outcome.value, current.email);
          return;
        }
        // Only a definite end signs somebody out. An outage must not: the session is still valid
        // and the next attempt may well succeed, and signing out over a dropped connection loses
        // an offline shelf somebody may be relying on (`03` group J).
        if (outcome.reason === 'SESSION_EXPIRED') forget();
      });
    };

    if (needsRefresh(current.tokens, clock())) {
      renew();
      return;
    }
    timer.current = setTimeout(renew, msUntilRefresh(current.tokens, clock()));

    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    // `clock` is stable per render by construction and is deliberately not a dependency: a new
    // function identity each render would reschedule the timer on every render, which is a
    // renewal loop rather than a renewal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, signed, adopt, forget]);

  // -------------------------------------------------------------------------
  // The actions
  // -------------------------------------------------------------------------
  const contextValue = useMemo<AuthContextValue>(() => {
    if (resolved === null) return UNCONFIGURED;
    const endpointNow = resolved;

    return {
      state: !restored ? 'LOADING' : signed === null ? 'SIGNED_OUT' : 'SIGNED_IN',
      tokens: signed?.tokens ?? null,

      signIn: async (email, password) => {
        const outcome = await providerSignIn(endpointNow, { email, password });
        if (outcome.kind === 'OK') await adopt(outcome.value, email.trim().toLowerCase());
        return outcome;
      },

      signUp: async (email, password) => {
        const outcome = await providerSignUp(endpointNow, { email, password });
        // A project that requires confirmation returns no session, and that is not a failure -
        // the next step is a mailbox. Only the signed-in shape adopts anything.
        if (outcome.kind === 'OK' && outcome.value.state === 'SIGNED_IN') {
          await adopt(outcome.value.tokens, email.trim().toLowerCase());
        }
        return outcome;
      },

      recover: (email) => requestPasswordRecovery(endpointNow, email),

      reauthenticate: async (password, suppliedEmail) => {
        // The session's own address where it has one, and the caller's where it does not - a
        // restored session knows its tokens and not the address behind them.
        const email = (signed?.email ?? '') || (suppliedEmail?.trim().toLowerCase() ?? '');
        if (email === '') {
          // `UNAVAILABLE`, and emphatically **not** `WRONG_CREDENTIALS`, which is what this used
          // to answer. Nothing was checked, so calling the password wrong is untrue - and it is
          // untrue in the direction that matters: `18` asks a refusal to say what to do next, and
          // "that password was not right" sends somebody to change a password that was fine.
          // Every restored session hit this, so re-authentication was impossible after a restart
          // and the screen blamed the person for it.
          return { kind: 'FAILED', reason: 'UNAVAILABLE' };
        }
        const outcome = await providerSignIn(endpointNow, { email, password });
        if (outcome.kind === 'OK') await adopt(outcome.value, email);
        return outcome;
      },

      signOut: async () => {
        const token = signed?.tokens.accessToken;
        // Locally first and unconditionally. Revoking at the provider is the part that can fail,
        // and it must not be the part that decides whether this phone is signed out.
        forget();
        if (token !== undefined) await providerSignOut(endpointNow, token);
      },

      sessionLost: forget,
    };
  }, [resolved, restored, signed, adopt, forget]);

  return <AuthContext.Provider value={value ?? contextValue}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
