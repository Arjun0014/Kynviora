/**
 * The queue of edits made with no network, and the pass that sends them.
 *
 * Spec references: `12` (a pending-operation journal; authorization loss invalidates access; a
 * queued change is visible rather than assumed), `13` (idempotency key on retryable mutations;
 * per-entity conflict policy; the server commits exactly once), `DEV-038`, `DEV-044`, `DEV-053`,
 * DEC-109, DEC-111, DEC-113, DEC-114, trap 174, `19`.
 *
 * WHY THIS FILE IS THE MOST VALUABLE ONE IN THE TREE
 * Every defect the device runs have found in the sync path was here or one call away, and none of
 * them was visible from the code. `DEV-044` is a queued edit not going out on the launch it was
 * waiting for. `DEV-053` is a screen holding a `queue` from before the store opened. DEC-109 is
 * one dropped connection spending five people's retry budget. DEC-114 is an operation nothing
 * could send being charged an attempt for the app having been opened.
 *
 * Each of those costs a real person a change they believed they had made, and each took a
 * twelve-minute device run to notice. They are all reachable from here in milliseconds.
 *
 * THE APP-STATE LISTENER IS DELIBERATELY NOT USED TO SET THESE UP
 * Trap 174: pressing HOME and returning repairs state that a cold launch got wrong, so a check
 * that backgrounds the app before measuring reports a working engine over a broken one. These
 * tests drive the cold-launch path and call `emitAppState` only where the *listener itself* is
 * what is under test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useEffect } from 'react';
import type { PendingOperationStore } from '@/storage/pendingOperations';
import type { ApiOutcome } from '@kynviora/contracts';
import {
  CONFLICT_POLICY_BY_ENTITY,
  SYNC_ENTITY_TYPES,
  type PendingOperation,
} from '@kynviora/domain';
import { emitAppState, resetAppState } from '../../test/reactNativeStub.js';
import { flush, renderScreen } from '../../test/render.js';

const SESSION = 'session-a';

/** The store, in memory. The real one is SQLCipher and is not what any of this is about. */
function fakeStore(): PendingOperationStore & { readonly rows: Map<string, PendingOperation> } {
  const rows = new Map<string, PendingOperation>();
  return {
    rows,
    list: (sessionId) =>
      Promise.resolve(
        [...rows.values()].filter((operation) => sessionKey(operation) === sessionId),
      ),
    put: (sessionId, operation) => {
      rows.set(`${sessionId}:${operation.operationId}`, operation);
      sessions.set(operation.operationId, sessionId);
      return Promise.resolve();
    },
    remove: (sessionId, operationId) => {
      rows.delete(`${sessionId}:${operationId}`);
      return Promise.resolve();
    },
    clear: (sessionId) => {
      for (const key of [...rows.keys()]) if (key.startsWith(`${sessionId}:`)) rows.delete(key);
      return Promise.resolve();
    },
  };
}

const sessions = new Map<string, string>();
function sessionKey(operation: PendingOperation): string {
  return sessions.get(operation.operationId) ?? SESSION;
}

let store = fakeStore();
let currentSession = SESSION;

vi.mock('@/storage/ProjectionProvider', () => ({
  useProjection: () => ({
    projection: null,
    pending: store,
    error: null,
    sessionId: currentSession,
  }),
  sessionIdOf: () => currentSession,
}));

const { PendingSyncProvider, usePendingSync } = await import('./PendingSyncProvider');

beforeEach(() => {
  store = fakeStore();
  sessions.clear();
  currentSession = SESSION;
  resetAppState();
});

/**
 * Render the provider with a child that hands the context back out.
 *
 * `senders` are registered from an effect, which is where a real screen registers them - and the
 * timing of that registration is the whole of `DEV-044`.
 */
function harness(options: {
  readonly senders?: Readonly<
    Record<string, (operation: PendingOperation) => Promise<ApiOutcome<unknown>>>
  >;
  readonly registerLate?: boolean;
}) {
  const api: { current: ReturnType<typeof usePendingSync> | null } = { current: null };
  const attempts: string[] = [];

  function Child() {
    const sync = usePendingSync();
    api.current = sync;
    const { registerSender } = sync;
    useEffect(() => {
      if (options.registerLate === true) return;
      for (const [entityType, send] of Object.entries(options.senders ?? {})) {
        registerSender(entityType as never, (operation) => {
          attempts.push(`${entityType}:${operation.operationId}`);
          return send(operation);
        });
      }
    }, [registerSender]);
    return null;
  }

  const rendered = renderScreen(
    <PendingSyncProvider>
      <Child />
    </PendingSyncProvider>,
  );
  return { rendered, api, attempts };
}

function operationBody(
  overrides: Partial<Parameters<NonNullable<ReturnType<typeof usePendingSync>>['queue']>[0]> = {},
) {
  return {
    entityType: 'owned_item' as const,
    entityId: 'item-1',
    mutation: 'UPDATE' as const,
    payload: { displayName: 'Synthetic Tablet A' },
    baseVersion: 1,
    ...overrides,
  };
}

const ok: ApiOutcome<unknown> = { kind: 'OK', value: {}, correlationId: null };
const offline: ApiOutcome<unknown> = { kind: 'OFFLINE' };

describe('what may be queued at all', () => {
  it('refuses every entity type the conflict policy resolves SERVER_WINS', async () => {
    // `12`: only low-risk user-owned changes may be applied optimistically. A client that queued a
    // `caregiver_grant` would be showing an **authorization** outcome the server has not agreed
    // to, and `alert_publication` or `profile_assessment` would be showing a **safety** one. The
    // check is asked before anything is written, so the refusal is a refusal rather than a warning.
    //
    // Driven from the domain's own table rather than a list written here, so a type added later
    // and resolved SERVER_WINS is covered the day it exists.
    const { api } = harness({});
    await flush();

    const refused = SYNC_ENTITY_TYPES.filter(
      (entityType) => CONFLICT_POLICY_BY_ENTITY[entityType] === 'SERVER_WINS',
    );
    expect(refused.length).toBeGreaterThan(0);

    for (const entityType of refused) {
      expect(await api.current!.queue(operationBody({ entityType }))).toBe(false);
    }
    expect(store.rows.size).toBe(0);
  });

  it('accepts one the policy does permit, so the refusal above is about the policy', async () => {
    // The control. Without it, a `queue` that refused everything would pass the test above and
    // would have removed the offline journal rather than scoped it.
    const { api } = harness({});
    await flush();
    expect(await api.current!.queue(operationBody({ entityType: 'owned_item' }))).toBe(true);
    expect(store.rows.size).toBe(1);
  });

  it('keeps the idempotency key the failed attempt already used', async () => {
    // DEC-111. `OFFLINE` is inferred from a failed fetch, which is also what a request that
    // arrived and lost its answer looks like - so a fresh key on the replay is how one edit
    // becomes two rows, and for a dose that is somebody being told twice to take a tablet.
    const { api } = harness({});
    await flush();
    await api.current!.queue(operationBody({ operationId: 'key-from-the-first-attempt' }));
    const stored = [...store.rows.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.operationId).toBe('key-from-the-first-attempt');
  });

  it('reports an edit the store could not take as not queued', async () => {
    // `DEV-055`, found by `19`'s low-storage scenario. A device with no room left is a device
    // whose store will not take a write, and `pending.put` then rejects. Before this it escaped:
    // the caller learned nothing, an uncaught-promise banner went over the app, and the person was
    // looking at a screen that had told them their change was safe.
    //
    // `12` is explicit that a queued change is visible rather than assumed, so an edit nothing
    // kept has to be reported as an edit nothing kept - which for this function means `false`.
    const failing = fakeStore();
    store = {
      ...failing,
      rows: failing.rows,
      put: () => Promise.reject(new Error('attempt to write a readonly database')),
    };

    const { api } = harness({});
    await flush();
    await expect(api.current!.queue(operationBody())).resolves.toBe(false);
    expect(store.rows.size).toBe(0);
  });

  it('mints one where the screen had none', async () => {
    const { api } = harness({});
    await flush();
    await api.current!.queue(operationBody());
    expect([...store.rows.values()][0]?.operationId).toMatch(/[0-9a-f-]{16,}/i);
  });
});

describe('the launch a queued edit was waiting for (DEV-044)', () => {
  it('sends it once a sender for its type registers, with nobody backgrounding the app', async () => {
    // The defect exactly. The encrypted store opens before any tab beyond the first has mounted,
    // so the single pass a cold launch runs happens while the sender map is still empty - and the
    // launch after a person's phone killed the app is the launch their edit was waiting for.
    // Without the re-drain the edit sits until they happen to background and foreground the app,
    // with nothing on any screen to say so.
    //
    // No `emitAppState` here, on purpose: that is the repair path trap 174 warns about, and using
    // it would report a working engine over a broken one.
    const sent: string[] = [];
    store.rows.set(`${SESSION}:op-1`, {
      operationId: 'op-1',
      entityType: 'owned_item',
      entityId: 'item-1',
      mutation: 'UPDATE',
      payload: {},
      baseVersion: 1,
      createdAt: '2026-09-04T09:00:00.000Z',
      state: 'PENDING',
      attemptCount: 0,
      lastError: null,
    } as unknown as PendingOperation);

    harness({
      senders: {
        owned_item: (operation) => {
          sent.push(operation.operationId);
          return Promise.resolve(ok);
        },
      },
    });
    await flush(6);

    expect(sent).toEqual(['op-1']);
    expect(store.rows.size).toBe(0);
  });

  it('does not charge an attempt for a type nothing can send yet', async () => {
    // DEC-114: an operation nothing can send has not been attempted. There is no `ApiOutcome`
    // meaning "nothing was asked", and answering `OFFLINE` charged an attempt for the app having
    // been opened - so a person who opened the app five times found their edit needing attention.
    store.rows.set(`${SESSION}:op-2`, {
      operationId: 'op-2',
      entityType: 'owned_item',
      entityId: 'item-1',
      mutation: 'UPDATE',
      payload: {},
      baseVersion: 1,
      createdAt: '2026-09-04T09:00:00.000Z',
      state: 'PENDING',
      attemptCount: 0,
      lastError: null,
    } as unknown as PendingOperation);

    harness({ registerLate: true });
    await flush(6);

    const after = [...store.rows.values()][0];
    expect(after?.attemptCount).toBe(0);
    expect(after?.state).toBe('PENDING');
  });
});

describe('one dropped connection (DEC-109)', () => {
  it('stops the pass and leaves the untried operations untouched', async () => {
    // A drain that keeps going after `OFFLINE` gives every remaining queued edit an attempt it
    // could never have succeeded at - five queued edits plus one tunnel drop is five operations
    // pushed towards the attempt ceiling, so the person who reconnects finds their changes marked
    // as needing attention rather than simply sent.
    for (const id of ['op-a', 'op-b', 'op-c']) {
      store.rows.set(`${SESSION}:${id}`, {
        operationId: id,
        entityType: 'owned_item',
        entityId: 'item-1',
        mutation: 'UPDATE',
        payload: {},
        baseVersion: 1,
        createdAt: '2026-09-04T09:00:00.000Z',
        state: 'PENDING',
        attemptCount: 0,
        lastError: null,
      } as unknown as PendingOperation);
    }

    const { attempts } = harness({
      senders: { owned_item: () => Promise.resolve(offline) },
    });
    await flush(6);

    expect(attempts).toHaveLength(1);
    const untouched = [...store.rows.values()].filter(
      (operation) => operation.operationId !== attempts[0]?.split(':')[1],
    );
    for (const operation of untouched) expect(operation.attemptCount).toBe(0);
  });
});

describe('coming back to the app', () => {
  it('re-drains when the app becomes active again', async () => {
    // The listener is the repair path, and it is a real one: a connection usually comes back while
    // the app is in the background. Tested here as itself rather than relied on above.
    const sent: string[] = [];
    let reachable = false;

    harness({
      senders: {
        owned_item: (operation) => {
          if (!reachable) return Promise.resolve(offline);
          sent.push(operation.operationId);
          return Promise.resolve(ok);
        },
      },
    });
    await flush(4);

    store.rows.set(`${SESSION}:op-3`, {
      operationId: 'op-3',
      entityType: 'owned_item',
      entityId: 'item-1',
      mutation: 'UPDATE',
      payload: {},
      baseVersion: 1,
      createdAt: '2026-09-04T09:00:00.000Z',
      state: 'PENDING',
      attemptCount: 0,
      lastError: null,
    } as unknown as PendingOperation);
    reachable = true;

    emitAppState('active');
    await flush(6);

    expect(sent).toEqual(['op-3']);
  });
});
