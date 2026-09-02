/**
 * The encrypted local projection, opened once for the app.
 *
 * Spec references: `12` (repository behaviour, sign-out removes projections), `14` (encrypted
 * structured local store), `03` group J, `BLK-002`.
 *
 * WHY A FAILURE TO OPEN IS A VALUE AND NOT A THROW
 * The same reason `ApiProvider` catches its configuration error: a throw at the root of an Expo
 * app is a blank screen. A device whose keystore refuses, or whose database file cannot be
 * decrypted, still has to show the app - it simply has no local copy, which is the state every
 * screen already handles because it is the state on first run.
 *
 * WHY IT IS CLEARED WHEN THE IDENTITY CHANGES
 * `12`: "Sign-out removes decrypted projections and caches." There is no sign-out yet (`04`
 * Phase 1.1), so the reachable form of it is the session changing to a different user or to
 * anonymous - and the rows are keyed by session anyway, so this is belt and braces rather than
 * the only defence.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ClientSession } from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { openProjection, type Projection } from './projection';

export interface ProjectionContextValue {
  /** `null` until it opens, and permanently where it could not. */
  readonly projection: Projection | null;
  /**
   * The identity every key written through this context is scoped to.
   *
   * Carried here rather than read from the API context at each call site, so a screen cannot
   * write a row without one - a key missing the session is a row one person writes and another
   * reads.
   */
  readonly sessionId: string;
  /** Why there is no local store, in words a developer can act on. Never shown to a user. */
  readonly error: string | null;
}

const ProjectionContext = createContext<ProjectionContextValue>({
  projection: null,
  sessionId: 'anonymous',
  error: null,
});

/** The stable identity a row is scoped to. Anonymous rows are still scoped, to their own bucket. */
export function sessionIdOf(session: ClientSession): string {
  return session.kind === 'ANONYMOUS' ? 'anonymous' : session.userId;
}

export function ProjectionProvider({ children }: { readonly children: ReactNode }) {
  // Read rather than passed in, so the store cannot be mounted against one identity while the
  // client sends another. There is one session and one place it comes from.
  const { session } = useApi();
  const [opened, setOpened] = useState<{
    readonly projection: Projection | null;
    readonly error: string | null;
  }>({ projection: null, error: null });
  const previousSessionId = useRef<string | null>(null);

  useEffect(() => {
    let live = true;

    void openProjection().then(
      (projection) => {
        if (!live) return;
        setOpened({ projection, error: null });
      },
      (reason: unknown) => {
        if (!live) return;
        setOpened({
          projection: null,
          error: reason instanceof Error ? reason.message : 'The local store could not be opened.',
        });
      },
    );

    return () => {
      live = false;
    };
  }, []);

  const sessionId = sessionIdOf(session);

  useEffect(() => {
    const previous = previousSessionId.current;
    previousSessionId.current = sessionId;
    // Only on an actual change of identity. The first render is not a sign-out.
    if (previous === null || previous === sessionId || opened.projection === null) return;
    void opened.projection.clear();
  }, [sessionId, opened.projection]);

  const contextValue = useMemo<ProjectionContextValue>(
    () => ({ projection: opened.projection, sessionId, error: opened.error }),
    [opened.projection, opened.error, sessionId],
  );

  return <ProjectionContext.Provider value={contextValue}>{children}</ProjectionContext.Provider>;
}

export function useProjection(): ProjectionContextValue {
  return useContext(ProjectionContext);
}
