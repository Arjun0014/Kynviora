/**
 * The thing that makes retention recurring.
 *
 * Spec references: `16` (retention deadlines), `20` (a job says when it started and stopped),
 * DEC-121, `DEV-063`.
 *
 * WHAT MAKES IT DURABLE
 * Nothing in this loop remembers anything. Each pass asks the database when the next sweep is due
 * (`readLastRetentionRun` + `msUntilDue`) and sleeps until then, so the schedule is a property of
 * the run history rather than of this process's uptime. A worker restarted every minute sweeps on
 * schedule; a worker that was down for a week sweeps the moment it comes back; two workers
 * pointed at one database sweep once between them, because the lease says so.
 *
 * WHY IT DOES NOT SPIN
 * Three things can leave a sweep un-run with the clock still saying "due now": the lease is held,
 * the run raised, or reading the schedule raised. All three sleep for the retry interval rather
 * than looping, because a `while` over a condition nothing in the loop can change is the classic
 * way a background worker becomes a busy one.
 *
 * SLEEPING IS INJECTED
 * Not for elegance - so the tests can drive hundreds of passes without waiting hours, and so
 * stopping is immediate rather than "after the current sleep". The default implementation is at
 * the bottom and does exactly what it looks like.
 */

import type { PurgeConnection } from '@kynviora/db';
import type { Clock, IdGenerator, Logger } from '@kynviora/domain';
import type { RetentionWorkerConfig } from './config.js';
import { msUntilDue } from './schedule.js';
import {
  executeRetentionRun,
  readLastRetentionRun,
  sqlstateOf,
  type RetentionRunResult,
} from './retentionRun.js';

/** The only thing the loop needs from a database: a connection as the retention role. */
export interface RetentionDb {
  withRetention<T>(fn: (db: PurgeConnection) => Promise<T>): Promise<T>;
}

/** Interruptible sleep. Resolves early when the signal aborts. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface RetentionLoopDeps {
  readonly db: RetentionDb;
  readonly config: RetentionWorkerConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Source of the worker's own identity and of each run's correlation ID. */
  readonly ids: IdGenerator;
  readonly sleep?: Sleep;
  /**
   * Stop after this many passes.
   *
   * For tests, which otherwise have no way to observe a loop that is meant never to end. Absent
   * means never - the production case.
   */
  readonly maxPasses?: number;
}

export interface RetentionLoop {
  /** This worker's opaque identity - the value written to the lease and to each run. */
  readonly holder: string;
  /** Resolves when the loop has exited. */
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export function startRetentionLoop(deps: RetentionLoopDeps): RetentionLoop {
  const sleep = deps.sleep ?? timerSleep;
  const holder = deps.ids.next();
  const controller = new AbortController();
  let passes = 0;

  async function pass(): Promise<void> {
    let waitMs: number;
    try {
      const last = await deps.db.withRetention((db) => readLastRetentionRun(db));
      waitMs = msUntilDue(last, deps.config, deps.clock.now());
    } catch (error) {
      // The schedule is unreadable, which means the database is. Retry rather than sweep: a run
      // attempted against a database that cannot be read is a run that will fail in every
      // category and fill the history with it.
      deps.logger.error('retention.loop.schedule_unreadable', {
        holder,
        sqlstate: sqlstateOf(error),
      });
      await sleep(deps.config.retryIntervalMs, controller.signal);
      return;
    }

    if (waitMs > 0) {
      await sleep(waitMs, controller.signal);
      return;
    }

    let result: RetentionRunResult;
    try {
      result = await deps.db.withRetention((db) =>
        executeRetentionRun(db, {
          holder,
          leaseMs: deps.config.leaseMs,
          clock: deps.clock,
          logger: deps.logger,
          correlationId: deps.ids.next(),
        }),
      );
    } catch (error) {
      // A sweep whose bookkeeping failed. The run row it opened is left open on purpose and the
      // next pass records it as ABANDONED, which is a truer description than anything this
      // handler could write.
      deps.logger.error('retention.run.errored', { holder, sqlstate: sqlstateOf(error) });
      await sleep(deps.config.retryIntervalMs, controller.signal);
      return;
    }

    // A skipped attempt changes nothing the schedule reads, so without this the next pass would
    // find the same "due now" and try again immediately, forever.
    if (!result.ran) await sleep(deps.config.retryIntervalMs, controller.signal);
  }

  const done = (async () => {
    deps.logger.info('retention.loop.started', {
      holder,
      interval_ms: deps.config.intervalMs,
      retry_ms: deps.config.retryIntervalMs,
      lease_ms: deps.config.leaseMs,
    });

    while (!controller.signal.aborted) {
      if (deps.maxPasses !== undefined && passes >= deps.maxPasses) break;
      passes += 1;
      await pass();
    }

    deps.logger.info('retention.loop.stopped', { holder, passes });
  })();

  return {
    holder,
    done,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

/**
 * Sleep, wakeable.
 *
 * Not `unref`'d: while the loop is running this process has work to do, and a timer that lets
 * Node exit underneath it would make the worker stop for no stated reason.
 */
export function timerSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
