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
import type { Projection } from './projection';
import type { PendingOperationStore } from './pendingOperations';
import { openLocalStore } from './localStore';

export interface ProjectionContextValue {
  /** `null` until it opens, and permanently where it could not. */
  readonly projection: Projection | null;
  /**
   * The journal of edits made with no network (`12`, `DEV-038`).
   *
   * Opened on the same connection as the projection, and `null` in exactly the same circumstances
   * - a device that cannot open its store cannot queue a write either, and a screen that offered
   * to save offline against a store that is not there would promise something nothing can keep.
   */
  readonly pending: PendingOperationStore | null;
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
  pending: null,
  sessionId: 'anonymous',
  error: null,
});

/**
 * The stable identity a row is scoped to. Anonymous rows are still scoped, to their own bucket.
 *
 * A bearer session is scoped by a **hash of the token**, not by the subject inside it. Reading
 * `sub` here would mean parsing a token this side cannot verify (DEC-118), and the value is only
 * ever compared to itself - what it has to be is stable for one session and different for the
 * next, which a digest of the token is and a claim read out of it would also be, with the
 * additional property of being attacker-chosen.
 *
 * A refresh produces a new token and therefore a new bucket, which is a real cost: the projection
 * is rebuilt on the first read after a refresh. That is the safe direction - a cache re-fetched is
 * a slow screen, and a cache shared across identities is somebody's medicines on the wrong
 * account.
 */
export function sessionIdOf(session: ClientSession): string {
  switch (session.kind) {
    case 'ANONYMOUS':
      return 'anonymous';
    case 'DEVELOPMENT':
      return session.userId;
    case 'BEARER':
      return `bearer:${fingerprintOf(session.accessToken)}`;
  }
}

/**
 * A short, stable, non-reversible label for a token.
 *
 * FNV-1a over the token's characters. Not a security boundary and not claimed as one - it is a
 * cache key, it never leaves the device, and the store it names is already encrypted. What it must
 * not be is the token itself, because a bucket name ends up in a filename and a log line.
 */
function fingerprintOf(token: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function ProjectionProvider({ children }: { readonly children: ReactNode }) {
  // Read rather than passed in, so the store cannot be mounted against one identity while the
  // client sends another. There is one session and one place it comes from.
  const { session } = useApi();
  const [opened, setOpened] = useState<{
    readonly projection: Projection | null;
    readonly pending: PendingOperationStore | null;
    readonly error: string | null;
  }>({ projection: null, pending: null, error: null });
  const previousSessionId = useRef<string | null>(null);

  useEffect(() => {
    let live = true;

    void openLocalStore().then(
      (store) => {
        if (!live) return;
        setOpened({ projection: store.projection, pending: store.pending, error: null });
      },
      (reason: unknown) => {
        if (!live) return;
        setOpened({
          projection: null,
          pending: null,
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
    void opened.projection.clear().catch(() => undefined);
    // The queue goes with it. `12` requires an identity change to invalidate local access, and an
    // unsent write is local access with a delayed effect - draining the previous person's edit
    // under the new person's session is the same leak as showing them the previous shelf. The
    // previous identity's rows are the ones removed, not the new one's.
    // Caught for `DEV-055`'s reason. A purge that cannot run leaves rows belonging to a session
    // that has ended, which matters - but an unhandled rejection does not fix it and does put a
    // crash banner over the app.
    if (opened.pending !== null) void opened.pending.clear(previous).catch(() => undefined);
  }, [sessionId, opened.projection, opened.pending]);

  const contextValue = useMemo<ProjectionContextValue>(
    () => ({
      projection: opened.projection,
      pending: opened.pending,
      sessionId,
      error: opened.error,
    }),
    [opened.projection, opened.pending, opened.error, sessionId],
  );

  return <ProjectionContext.Provider value={contextValue}>{children}</ProjectionContext.Provider>;
}

export function useProjection(): ProjectionContextValue {
  return useContext(ProjectionContext);
}
