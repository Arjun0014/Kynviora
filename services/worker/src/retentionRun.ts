/**
 * One retention run: take the lease, sweep each category, record what happened, give the lease
 * back.
 *
 * Spec references: `16` (retention deadlines are deadlines), `14` (least privilege - everything
 * here runs as `kynviora_retention` and nothing else), `20` (a job reports start, end, outcome,
 * duration and counts, with a correlation ID and without content), DEC-121, migration `0026`.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT
 * A sweep that raises in one category, stops, and is recorded - or not recorded - as a job that
 * "ran". `docs/RETENTION.md` makes twenty-four separate promises about twenty-four kinds of row,
 * and a single exception used to abandon all of them at whichever one raised first. So each
 * category is attempted independently, each gets its own row in `retention_run_category`, and the
 * run's own outcome is `PARTIAL` when any of them failed. **`PARTIAL` is not `SUCCEEDED`** - not
 * in the schema, not in the schedule, and not in the log line.
 *
 * WHY EACH CATEGORY IS A TRANSACTION
 * So that a category which failed purged **nothing**, and its recorded count of zero is true
 * rather than "however far it got". Half a purged item - the doses gone, the medicine still there
 * - is a state no reader wants and no test can pin down, and the alternative to a transaction is
 * to describe it in a comment and hope.
 *
 * WHAT MAY BE WRITTEN DOWN ABOUT A FAILURE
 * The step label, from this codebase's own vocabulary, and the five-character SQLSTATE. Not the
 * driver's message: `detail` on a constraint violation quotes the offending row verbatim, and
 * `20` does not allow a health record to reach a log by being inside an error. `PurgeStepFailure`
 * exists to carry the label so that this rule costs nothing in diagnosability.
 */

import {
  EMPTY_PURGE_REPORT,
  PURGE_CATEGORIES,
  PurgeStepFailure,
  mergePurgeReports,
  runPurgeCategory,
  type PurgeCategory,
  type PurgeCategoryPlan,
  type PurgeConnection,
  type PurgeReport,
} from '@kynviora/db';
import { compareInstants, type Clock, type Instant, type Logger } from '@kynviora/domain';
import type { LastRetentionRun, RetentionRunOutcome } from './schedule.js';

/** What one category did, exactly as it is written to `retention_run_category`. */
export interface RetentionCategoryOutcome {
  readonly category: PurgeCategory;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly rowsPurged: number;
  readonly durationMs: number;
  readonly failureStep: string | null;
  readonly failureSqlstate: string | null;
}

export type RetentionRunResult =
  /** Somebody else holds the lease. Not a failure, and deliberately not recorded as a run. */
  | { readonly ran: false; readonly skipped: 'LEASE_HELD' }
  | {
      readonly ran: true;
      readonly runId: string;
      readonly outcome: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
      readonly report: PurgeReport;
      readonly categories: readonly RetentionCategoryOutcome[];
      readonly rowsPurged: number;
      readonly durationMs: number;
    };

export interface RetentionRunDeps {
  /**
   * This worker's opaque identity, for the lease and the run row.
   *
   * Opaque on purpose: `20` keeps operational rows free of content, and the only question it has
   * to answer is "is the lease still mine". A hostname would answer a question nobody asked.
   */
  readonly holder: string;
  readonly leaseMs: number;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly correlationId: string;
}

/**
 * The SQLSTATE a driver reported, or `XX000` when it reported none.
 *
 * Five characters and nothing else. Everything richer on a Postgres error - `message`, `detail`,
 * `where` - can contain values from the row that caused it.
 */
export function sqlstateOf(error: unknown): string {
  const code: unknown = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'XX000';
}

/** Non-negative elapsed milliseconds. A clock stepped backwards must not produce a negative one. */
function elapsedMs(clock: Clock, since: Instant): number {
  return Math.max(0, compareInstants(clock.now(), since));
}

/**
 * The run's outcome, from its categories.
 *
 * Three states and the middle one is the point. A run where one category raised has not swept the
 * matrix, and calling that a success is precisely how a table stops being purged for a year while
 * a dashboard stays green.
 */
export function retentionRunOutcome(
  categories: readonly RetentionCategoryOutcome[],
): 'SUCCEEDED' | 'PARTIAL' | 'FAILED' {
  const failed = categories.filter((c) => c.outcome === 'FAILED').length;
  if (failed === 0) return 'SUCCEEDED';
  return failed === categories.length ? 'FAILED' : 'PARTIAL';
}

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

/**
 * Take the lease if it is free or expired.
 *
 * One conditional `UPDATE`, which is atomic, so two workers issuing it concurrently produce one
 * winner and one row count of zero. The expiry is the recovery path: a worker killed mid-sweep
 * releases nothing, and the lease becomes claimable again by itself.
 */
export async function acquireRetentionLease(
  db: PurgeConnection,
  holder: string,
  leaseMs: number,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE retention_lease
        SET holder = $1,
            acquired_at = now(),
            expires_at = now() + make_interval(secs => $2::double precision)
      WHERE singleton AND (holder IS NULL OR expires_at <= now())`,
    [holder, leaseMs / 1000],
  );
  return (result.affectedRows ?? 0) === 1;
}

/** Give it back, and only if it is still ours. */
export async function releaseRetentionLease(db: PurgeConnection, holder: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE retention_lease
        SET holder = NULL, acquired_at = NULL, expires_at = NULL
      WHERE singleton AND holder = $1`,
    [holder],
  );
  return (result.affectedRows ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

/**
 * Close every run left open longer than a lease could have covered it.
 *
 * The lease duration is the threshold because it is the same question: past it, nothing was
 * protecting that run, so whoever opened it is gone. The summary counts come from the category
 * rows the dead worker did manage to write, which is why an `ABANDONED` run still reports what it
 * purged and why it has no `duration_ms` - nobody measured one.
 */
export async function reapAbandonedRuns(db: PurgeConnection, leaseMs: number): Promise<number> {
  const result = await db.query(
    `UPDATE retention_run r
        SET finished_at = now(),
            outcome = 'ABANDONED',
            categories_attempted =
              (SELECT count(*)::integer FROM retention_run_category c WHERE c.run_id = r.id),
            categories_failed =
              (SELECT count(*)::integer FROM retention_run_category c
                WHERE c.run_id = r.id AND c.outcome = 'FAILED'),
            rows_purged =
              (SELECT coalesce(sum(c.rows_purged), 0)::integer
                 FROM retention_run_category c WHERE c.run_id = r.id)
      WHERE r.finished_at IS NULL
        AND r.started_at <= now() - make_interval(secs => $1::double precision)`,
    [leaseMs / 1000],
  );
  return result.affectedRows ?? 0;
}

/** The most recent run, for the schedule. */
export async function readLastRetentionRun(db: PurgeConnection): Promise<LastRetentionRun | null> {
  const result = await db.query<{ started_at: Date | string; outcome: string | null }>(
    `SELECT started_at, outcome FROM retention_run ORDER BY started_at DESC, id DESC LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  const startedAt = (
    row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at
  ) as Instant;
  return { startedAt, outcome: row.outcome as RetentionRunOutcome | null };
}

async function openRun(db: PurgeConnection, holder: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO retention_run (holder) VALUES ($1) RETURNING id`,
    [holder],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error('Opening a retention run returned no identifier.');
  }
  return id;
}

async function recordCategory(
  db: PurgeConnection,
  runId: string,
  outcome: RetentionCategoryOutcome,
): Promise<void> {
  await db.query(
    `INSERT INTO retention_run_category
       (run_id, category, outcome, rows_purged, duration_ms, failure_step, failure_sqlstate)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      runId,
      outcome.category,
      outcome.outcome,
      outcome.rowsPurged,
      outcome.durationMs,
      outcome.failureStep,
      outcome.failureSqlstate,
    ],
  );
}

/**
 * Close the run.
 *
 * The three summary counts are computed from the category rows rather than carried in from the
 * process. Two counters incremented in two places drift, and the one in the database is the one
 * an operator reads.
 */
async function closeRun(
  db: PurgeConnection,
  runId: string,
  outcome: 'SUCCEEDED' | 'PARTIAL' | 'FAILED',
  durationMs: number,
): Promise<void> {
  await db.query(
    `UPDATE retention_run r
        SET finished_at = now(),
            outcome = $2,
            duration_ms = $3,
            categories_attempted =
              (SELECT count(*)::integer FROM retention_run_category c WHERE c.run_id = r.id),
            categories_failed =
              (SELECT count(*)::integer FROM retention_run_category c
                WHERE c.run_id = r.id AND c.outcome = 'FAILED'),
            rows_purged =
              (SELECT coalesce(sum(c.rows_purged), 0)::integer
                 FROM retention_run_category c WHERE c.run_id = r.id)
      WHERE r.id = $1 AND r.finished_at IS NULL`,
    [runId, outcome, durationMs],
  );
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Undo the category's transaction without letting the undo become the failure.
 *
 * After a statement raises, the transaction is aborted and every command but `ROLLBACK` is
 * refused - so this must run, and if the connection is in a state where even `ROLLBACK` fails
 * there is nothing useful to say about it that the original error does not already say better.
 */
async function rollbackQuietly(db: PurgeConnection): Promise<void> {
  try {
    await db.query('ROLLBACK');
  } catch {
    // Already outside a transaction, or the connection is gone. Either way the caller's error is
    // the one worth reporting.
  }
}

async function runOneCategory(
  db: PurgeConnection,
  plan: PurgeCategoryPlan,
  deps: RetentionRunDeps,
): Promise<{ outcome: RetentionCategoryOutcome; report: PurgeReport | null }> {
  const startedAt = deps.clock.now();

  try {
    await db.query('BEGIN');
    const { report, rowsPurged } = await runPurgeCategory(db, plan);
    await db.query('COMMIT');

    return {
      report,
      outcome: {
        category: plan.category,
        outcome: 'SUCCEEDED',
        rowsPurged,
        durationMs: elapsedMs(deps.clock, startedAt),
        failureStep: null,
        failureSqlstate: null,
      },
    };
  } catch (error) {
    await rollbackQuietly(db);

    // `PurgeStepFailure` names the statement; anything else came from `BEGIN` or `COMMIT`, which
    // belong to no step. Both labels are ours, neither is the driver's.
    const failureStep = error instanceof PurgeStepFailure ? error.step : 'transaction';
    const failureSqlstate = sqlstateOf(error instanceof PurgeStepFailure ? error.cause : error);

    deps.logger.error('retention.category.failed', {
      correlation_id: deps.correlationId,
      category: plan.category,
      step: failureStep,
      sqlstate: failureSqlstate,
    });

    return {
      report: null,
      outcome: {
        category: plan.category,
        outcome: 'FAILED',
        // Zero, because the transaction rolled back. Not "however far it got" - there is no such
        // quantity, and the schema refuses to record one.
        rowsPurged: 0,
        durationMs: elapsedMs(deps.clock, startedAt),
        failureStep,
        failureSqlstate,
      },
    };
  }
}

/**
 * Sweep once, under the lease, recording everything.
 *
 * Takes a connection already bound to `kynviora_retention`; it never switches role itself, for
 * the reason `purgeCli.ts` gives - the safety of every statement below is entirely in that role's
 * policies, so who the caller is is not something this function should be able to decide.
 *
 * Returns without running, and without recording a run, when the lease is held. A skipped attempt
 * is not a sweep and must not look like one in the history: an operator counting runs per day is
 * counting sweeps, and a row saying "another worker had it" would be indistinguishable from a
 * sweep that purged nothing because nothing was due.
 */
export async function executeRetentionRun(
  db: PurgeConnection,
  deps: RetentionRunDeps,
): Promise<RetentionRunResult> {
  // Before the lease, so a run left open by a worker that died is closed by whoever comes next
  // rather than staying open forever and reading as a sweep still in progress.
  const abandoned = await reapAbandonedRuns(db, deps.leaseMs);
  if (abandoned > 0) {
    deps.logger.warn('retention.run.abandoned', {
      correlation_id: deps.correlationId,
      runs: abandoned,
    });
  }

  if (!(await acquireRetentionLease(db, deps.holder, deps.leaseMs))) {
    deps.logger.info('retention.run.skipped', {
      correlation_id: deps.correlationId,
      reason: 'LEASE_HELD',
    });
    return { ran: false, skipped: 'LEASE_HELD' };
  }

  try {
    const runId = await openRun(db, deps.holder);
    const startedAt = deps.clock.now();

    deps.logger.info('retention.run.started', {
      correlation_id: deps.correlationId,
      run_id: runId,
      categories: PURGE_CATEGORIES.length,
    });

    const categories: RetentionCategoryOutcome[] = [];
    let report = EMPTY_PURGE_REPORT;

    for (const plan of PURGE_CATEGORIES) {
      const attempt = await runOneCategory(db, plan, deps);
      categories.push(attempt.outcome);
      if (attempt.report !== null) report = mergePurgeReports(report, attempt.report);
      // Outside the category's own transaction, so a rollback cannot take the record of the
      // rollback with it.
      await recordCategory(db, runId, attempt.outcome);
    }

    const outcome = retentionRunOutcome(categories);
    const durationMs = elapsedMs(deps.clock, startedAt);
    const rowsPurged = categories.reduce((sum, c) => sum + c.rowsPurged, 0);

    await closeRun(db, runId, outcome, durationMs);

    // Counts, an outcome and a duration. `20` allows exactly this and no more: which medicines
    // were purged is the one thing a deleted record could come back as.
    deps.logger.info('retention.run.finished', {
      correlation_id: deps.correlationId,
      run_id: runId,
      outcome,
      duration_ms: durationMs,
      categories_attempted: categories.length,
      categories_failed: categories.filter((c) => c.outcome === 'FAILED').length,
      rows_purged: rowsPurged,
    });

    return { ran: true, runId, outcome, report, categories, rowsPurged, durationMs };
  } finally {
    // Always. A lease held by a process that has moved on blocks every sweep until it expires,
    // which is a retention outage caused by bookkeeping.
    if (!(await releaseRetentionLease(db, deps.holder))) {
      deps.logger.warn('retention.lease.lost', { correlation_id: deps.correlationId });
    }
  }
}
