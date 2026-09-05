/**
 * The encrypted store, opened once for the whole app.
 *
 * Spec references: `12` (one encrypted structured local store), `14`, DEC-012, `BLK-002`.
 *
 * WHY THIS IS ITS OWN PROVIDER NOW
 * `ProjectionProvider` used to open it, which was right while the projection and the journal were
 * the only things in it. The session lives there too since DEC-118, and the session is needed
 * **above** the API client rather than below it - the client is built from it. Two providers
 * calling `openLocalStore()` would be two connections to one SQLCipher file racing each other's
 * schema creation, which is the exact failure `ProjectionProvider` has warned about since it was
 * written.
 *
 * So the opening moves up here, once, and everything that needs a table reads it from this
 * context. `ProjectionProvider` keeps the part that was actually its own: scoping rows to an
 * identity and clearing them when the identity changes.
 *
 * WHY A FAILURE TO OPEN IS A VALUE AND NOT A THROW
 * A throw at the root of an Expo app is a blank screen, which is the least informative failure
 * available. A device whose keystore refuses still has to show the app: it has no local copy and
 * no stored session, which is the state on first run and every screen already handles it.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Projection } from './projection';
import type { PendingOperationStore } from './pendingOperations';
import type { SessionStore } from '../auth/sessionStore';
import { openLocalStore } from './localStore';

export interface LocalStoreContextValue {
  /** `null` until it opens, and permanently where it could not. */
  readonly projection: Projection | null;
  readonly pending: PendingOperationStore | null;
  readonly session: SessionStore | null;
  /** Whether the attempt has finished, either way. */
  readonly settled: boolean;
  /** Why there is no local store, in words a developer can act on. Never shown to a user. */
  readonly error: string | null;
}

const EMPTY: LocalStoreContextValue = {
  projection: null,
  pending: null,
  session: null,
  settled: false,
  error: null,
};

const LocalStoreContext = createContext<LocalStoreContextValue>(EMPTY);

export interface LocalStoreProviderProps {
  readonly children: ReactNode;
  /** Injected for tests, which have no keystore and no SQLCipher. */
  readonly value?: LocalStoreContextValue;
}

export function LocalStoreProvider({ children, value }: LocalStoreProviderProps) {
  const [opened, setOpened] = useState<LocalStoreContextValue>(EMPTY);

  useEffect(() => {
    if (value !== undefined) return;
    let live = true;

    void openLocalStore().then(
      (store) => {
        if (!live) return;
        setOpened({
          projection: store.projection,
          pending: store.pending,
          session: store.session,
          settled: true,
          error: null,
        });
      },
      (reason: unknown) => {
        if (!live) return;
        setOpened({
          projection: null,
          pending: null,
          session: null,
          // Settled, and that matters: without it the app would wait forever for a store that is
          // never going to open, showing a spinner instead of a sign-in screen.
          settled: true,
          error: reason instanceof Error ? reason.message : 'The local store could not be opened.',
        });
      },
    );

    return () => {
      live = false;
    };
  }, [value]);

  const contextValue = useMemo(() => value ?? opened, [value, opened]);
  return <LocalStoreContext.Provider value={contextValue}>{children}</LocalStoreContext.Provider>;
}

export function useLocalStore(): LocalStoreContextValue {
  return useContext(LocalStoreContext);
}
