/**
 * The queue of edits made with no network, and the pass that sends them.
 *
 * Spec references: `12` ("Repository behavior" - a pending-operation journal, idempotency keys, a
 * resolvable failure state; authorization loss invalidates local access), `13` (per-entity conflict
 * policy; bounded retry), `03` group J ("pending user edits with deterministic sync handling"),
 * `DEV-038`.
 *
 * WHAT IS HERE AND WHAT IS DELIBERATELY NOT
 * Sequencing and failure handling. Every decision belongs to a tested module and is called rather
 * than restated: whether a change of this kind may be queued at all is `isOptimisticallyApplicable`
 * (`13`'s per-entity policy), what order the queue goes in is `uploadOrder`, what an answer meant is
 * `classifyUpload`, what it does to a row is `recordUploadOutcome`, and when to stop sending is
 * `drainPendingOperations`. `apps/**` is outside the test run, so a rule written here is one nothing
 * checks (trap 164).
 *
 * WHY THE POLICY GATE IS A REFUSAL AND NOT A WARNING
 * `13`'s conflict policy is per entity type, and `12` allows only low-risk user-owned changes to be
 * applied before the server has agreed. A caregiver grant or a safety publication queued offline
 * would be an authorization or safety outcome shown as done on the strength of nothing - so `queue`
 * returns `false` for those types and the caller reports the failure it already had. That is the
 * whole reason this shipped as one entity rather than as a generic replay: `DEV-038` says queueing
 * writes without wiring the per-entity policy produces exactly the global last-write-wins the
 * specification refuses.
 *
 * WHY THE DRAIN RUNS ON FOREGROUND
 * Because that is when a connection has usually come back, and because it is the one moment the app
 * is certain to be running. There is no background task: `12` bounds what may run in the background
 * and none is declared, which is the same limit the reminder horizon lives with (`DEV-041`).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  IDLE_SYNC_PASS,
  finishSyncPass,
  instantFrom,
  isOptimisticallyApplicable,
  needsUserAttention,
  requestSyncPass,
  unsafeId,
  type OperationId,
  type PendingOperation,
  type SyncEntityType,
  type SyncPassGate,
} from '@kynviora/domain';
import { drainPendingOperations, type ApiOutcome } from '@kynviora/contracts';
import { useProjection } from '@/storage/ProjectionProvider';
import { newIdempotencyKey } from '@/platform/ids';

/** One change a screen could not send. */
export interface QueueRequest {
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly mutation: PendingOperation['mutation'];
  readonly payload: unknown;
  /** The version the screen had, or `null` for a create (`13`'s precondition). */
  readonly baseVersion: number | null;
  /**
   * The idempotency key the screen already used, where it used one.
   *
   * **This is not an optimisation.** `OFFLINE` says the request never reached a server, but the
   * client learns that from a failed fetch - which is also what a request that *did* reach the
   * server and lost its response looks like. Queueing a create under a fresh key would then commit
   * it a second time, and on `medicine_schedule` a duplicate is not a duplicate row on a list: it
   * is being told twice, at the same minute, to take the same tablet.
   *
   * So one intent keeps one key, whether it goes now or later. Omitted for a mutation that carries
   * no key - an update is conditional on `expectedVersion` instead, and a replay of one either
   * lands once or comes back as a conflict.
   */
  readonly operationId?: string;
}

/** How one queued operation is sent when the drain reaches it. */
export type Sender = (operation: PendingOperation) => Promise<ApiOutcome<unknown>>;

export interface PendingSyncContextValue {
  /**
   * Queue a change, or refuse it.
   *
   * `false` means the change was not queued and the caller must keep reporting its own failure:
   * either the store is not open, or `13`'s policy does not allow this entity type to be applied
   * before the server has seen it.
   */
  readonly queue: (request: QueueRequest) => Promise<boolean>;
  /** How many edits are waiting to be sent. */
  readonly waiting: number;
  /** How many have stopped retrying and need somebody to look (`12`'s resolvable failure state). */
  readonly needsAttention: number;
  /** Register how an entity type is uploaded. Screens own their own wire calls. */
  readonly registerSender: (entityType: SyncEntityType, send: Sender) => void;
  /** Try to send what is queued now. */
  readonly drain: () => void;
  /** Everything in the journal, for the screen that shows it (`12`, `DEV-038`). */
  readonly list: () => Promise<readonly PendingOperation[]>;
  /**
   * Put one operation back in the queue.
   *
   * The attempt count is reset, which is the whole point: an operation that stopped retrying has
   * spent its budget, and a person choosing "try again" is saying the reason it failed may have
   * gone. Without the reset the button would be a no-op that looks like one.
   */
  readonly retry: (operationId: OperationId) => Promise<void>;
  /**
   * Remove one operation, unsent.
   *
   * The only action in this app that destroys a change somebody made, so it is never taken on
   * anybody's behalf: `12` forbids discarding an edit silently, and this is only ever called from a
   * control the person pressed.
   */
  readonly discard: (operationId: OperationId) => Promise<void>;
}

const PendingSyncContext = createContext<PendingSyncContextValue>({
  queue: () => Promise.resolve(false),
  waiting: 0,
  needsAttention: 0,
  registerSender: () => undefined,
  drain: () => undefined,
  list: () => Promise.resolve([]),
  retry: () => Promise.resolve(),
  discard: () => Promise.resolve(),
});

export function PendingSyncProvider({ children }: { readonly children: ReactNode }) {
  const { pending, sessionId } = useProjection();
  const [counts, setCounts] = useState({ waiting: 0, needsAttention: 0 });
  const [generation, setGeneration] = useState(0);

  /**
   * How each entity type is sent.
   *
   * A ref rather than state: registering a sender must not re-run the drain, and the drain must
   * see whatever is registered at the moment it runs rather than a render-old copy.
   */
  const senders = useRef(new Map<SyncEntityType, Sender>());

  const drain = useCallback(() => {
    setGeneration((n) => n + 1);
  }, []);

  /**
   * Register how an entity type is sent, and try the queue again if this is the first way to send
   * one.
   *
   * The re-drain is the point, and leaving it out was a real defect measured on a device. The
   * store opens before any tab beyond the first has mounted, so the single pass a cold launch runs
   * happens while this map is still empty - and the launch after a person's phone killed the app
   * is exactly the launch their queued edit was waiting for. Without this, that edit sat until the
   * person happened to background and foreground the app again, with nothing on any screen to say
   * so (`DEV-044`).
   *
   * Only a genuinely new type re-drains. Re-registering the same type on a re-render would
   * otherwise ask for a pass on every render of the screen that owns it, and `requestSyncPass`
   * would dutifully defer and re-run them.
   */
  const registerSender = useCallback(
    (entityType: SyncEntityType, send: Sender) => {
      const isNew = !senders.current.has(entityType);
      senders.current.set(entityType, send);
      if (isNew) drain();
    },
    [drain],
  );

  const queue = useCallback(
    async (request: QueueRequest): Promise<boolean> => {
      if (pending === null) return false;
      // `13`'s per-entity policy, asked before anything is written. Not a warning: a type this
      // refuses is one whose queued change would be an authorization or safety outcome shown as
      // done on the strength of nothing.
      if (!isOptimisticallyApplicable(request.entityType)) return false;

      const operation: PendingOperation = {
        // The idempotency key, stable across every retry (`13`). Reused from the attempt that
        // failed where the screen had one, because a fresh key on a create is how one edit becomes
        // two rows when the original landed and its answer did not come back.
        operationId: unsafeId<OperationId>(request.operationId ?? newIdempotencyKey()),
        entityType: request.entityType,
        entityId: request.entityId,
        mutation: request.mutation,
        payload: request.payload,
        baseVersion: request.baseVersion,
        createdAt: instantFrom(new Date().toISOString()),
        state: 'PENDING',
        attemptCount: 0,
        lastError: null,
      };
      await pending.put(sessionId, operation);
      drain();
      return true;
    },
    [pending, sessionId, drain],
  );

  // Re-drain when the app comes back, which is when a connection usually has.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') drain();
    });
    return () => {
      subscription.remove();
    };
  }, [drain]);

  const gate = useRef<SyncPassGate>(IDLE_SYNC_PASS);

  useEffect(() => {
    if (pending === null) return;

    // Deferred, never dropped. The same rule the reminder reconciliation uses, and for the same
    // reason: this effect's inputs arrive in stages, and the request that carries all of them is
    // the one a plain "already running" guard would refuse (DEC-108, trap 174).
    const asked = requestSyncPass(gate.current);
    gate.current = asked.gate;
    if (!asked.start) return;

    let live = true;

    const run = async (): Promise<void> => {
      const queued = await pending.list(sessionId);
      if (!live) return;

      const result = await drainPendingOperations(
        queued,
        async (operation) => {
          const send = senders.current.get(operation.entityType);
          // Unreachable given `canSend` below, and kept as the honest answer rather than a throw:
          // a sender removed between the check and the call is a race nobody has to reason about
          // if the reply is "nothing was asked of the server".
          if (send === undefined) return { kind: 'OFFLINE' };
          return send(operation);
        },
        // No registered sender means the screen that knows how to send this type has not mounted.
        // That is not a failed attempt, and reporting it as one used to spend an attempt on the
        // operation and end the pass - so the queue was charged for the app having been opened.
        { canSend: (entityType) => senders.current.has(entityType) },
      );
      if (!live) return;

      for (const operationId of result.committed) await pending.remove(sessionId, operationId);
      for (const operation of result.updated) await pending.put(sessionId, operation);
      if (!live) return;

      const after = await pending.list(sessionId);
      if (!live) return;
      setCounts({
        waiting: after.filter((operation) => !needsUserAttention(operation)).length,
        needsAttention: after.filter(needsUserAttention).length,
      });
    };

    void run()
      .catch(() => {
        // A failed pass is not a lost edit: every row is still in the journal, and the next
        // foreground tries again. Nothing is surfaced here because nothing about the queue changed.
      })
      .finally(() => {
        const done = finishSyncPass(gate.current);
        gate.current = done.gate;
        if (done.rerun) setGeneration((n) => n + 1);
      });

    return () => {
      live = false;
    };
  }, [pending, sessionId, generation]);

  const list = useCallback(async (): Promise<readonly PendingOperation[]> => {
    if (pending === null) return [];
    return pending.list(sessionId);
  }, [pending, sessionId]);

  const retry = useCallback(
    async (operationId: OperationId): Promise<void> => {
      if (pending === null) return;
      const found = (await pending.list(sessionId)).find(
        (operation) => operation.operationId === operationId,
      );
      if (found === undefined) return;
      // Back to `PENDING` with a fresh budget. `isUploadable` refuses a `CONFLICTED` or `REJECTED`
      // row and refuses a `FAILED_RETRYABLE` one at the cap, so anything the screen offers to retry
      // is in a state the drain would otherwise pass over for ever.
      await pending.put(sessionId, {
        ...found,
        state: 'PENDING',
        attemptCount: 0,
        lastError: null,
      });
      drain();
    },
    [pending, sessionId, drain],
  );

  const discard = useCallback(
    async (operationId: OperationId): Promise<void> => {
      if (pending === null) return;
      await pending.remove(sessionId, operationId);
      // Not to send anything - there is nothing new to send - but to recount, so the screen and the
      // badge agree with the journal immediately rather than at the next foreground.
      drain();
    },
    [pending, sessionId, drain],
  );

  const value = useMemo<PendingSyncContextValue>(
    () => ({
      queue,
      waiting: counts.waiting,
      needsAttention: counts.needsAttention,
      registerSender,
      drain,
      list,
      retry,
      discard,
    }),
    [queue, counts.waiting, counts.needsAttention, registerSender, drain, list, retry, discard],
  );

  return <PendingSyncContext.Provider value={value}>{children}</PendingSyncContext.Provider>;
}

export function usePendingSync(): PendingSyncContextValue {
  return useContext(PendingSyncContext);
}
