/**
 * When the next sweep is due.
 *
 * Spec references: `16` (retention deadlines), `20` (a job's schedule is observable), DEC-121.
 *
 * PURE, AND DURABLE BECAUSE IT IS PURE
 * There is no timer state in this module and none in the worker either. "When is the next sweep
 * due" is answered from the **run history in the database**, which is what makes the schedule
 * survive a restart: a worker that is redeployed every five minutes does not sweep every five
 * minutes, and a worker that has been down for a week sweeps immediately when it comes back.
 * An in-memory `setInterval` gets both of those wrong, and gets them wrong silently.
 *
 * A RUN THAT DID NOT SUCCEED IS RETRIED SOONER
 * The three outcomes that are not `SUCCEEDED` all mean the same thing to a schedule: some part of
 * the matrix was not swept. Waiting a full interval to try again would turn one transient failure
 * into a whole interval of missed deadline, so they use the retry interval instead. An **open**
 * run - one with no outcome yet - is treated the same way: either a sweep is genuinely in
 * progress, in which case the lease will refuse the next one anyway, or the worker that opened it
 * died, in which case retrying soon is exactly right.
 */

import { compareInstants, type Instant } from '@kynviora/domain';
import type { RetentionWorkerConfig } from './config.js';

/**
 * The four states a recorded run can end in. `PARTIAL` is deliberately not `SUCCEEDED`.
 *
 * An array rather than a bare union, so the vocabulary exists at runtime and can be compared with
 * the CHECK constraint that enforces the same set in the schema (`db/schemaVocabulary.test.ts`).
 * A union alone is invisible to a test, which is how two closed vocabularies drift apart.
 */
export const RETENTION_RUN_OUTCOMES = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'ABANDONED'] as const;
export type RetentionRunOutcome = (typeof RETENTION_RUN_OUTCOMES)[number];

/** The most recent run, as the schedule needs to see it. */
export interface LastRetentionRun {
  readonly startedAt: Instant;
  /** `null` while the run is still open. */
  readonly outcome: RetentionRunOutcome | null;
}

/** How long after the last run the next one is due. */
export function delayAfter(
  last: LastRetentionRun,
  config: Pick<RetentionWorkerConfig, 'intervalMs' | 'retryIntervalMs'>,
): number {
  return last.outcome === 'SUCCEEDED' ? config.intervalMs : config.retryIntervalMs;
}

/**
 * Milliseconds until the next sweep, or `0` if one is due now.
 *
 * No previous run means due now. That is the case a fresh deployment is in, and it is the one
 * where waiting an interval before the first sweep would be worst: everything the matrix governs
 * is already as old as the data.
 *
 * THE INTERVAL IS A CEILING, NOT THE SCHEDULE (DEC-123, `DEV-063`)
 * `nextDeadline` is when the earliest **row** becomes purgeable, read from the data by
 * `kynviora.next_purge_due()`. Where there is one, the sweep is scheduled at it rather than after
 * an interval, so a row is removed at its deadline rather than up to an interval past it. The
 * interval survives as a heartbeat, which is what covers eligibility no clock can predict - an
 * evidence asset detached long after it was created, a digest emptied by another category's
 * purge.
 *
 * The earlier of the two wins, which is the only combination that is safe in both directions: a
 * heartbeat sooner than the next deadline is a sweep that purges nothing, and a deadline sooner
 * than the heartbeat is the whole point.
 */
export function msUntilDue(
  last: LastRetentionRun | null,
  config: Pick<RetentionWorkerConfig, 'intervalMs' | 'retryIntervalMs'>,
  now: Instant,
  nextDeadline?: Instant | null,
): number {
  const heartbeat =
    last === null
      ? 0
      : Math.max(0, delayAfter(last, config) - compareInstants(now, last.startedAt));

  if (nextDeadline === undefined || nextDeadline === null) return heartbeat;

  // A deadline already past is a row that should have gone and did not - eligibility that arrived
  // between two sweeps, or a category that failed. Either way it is due now, and clamping at zero
  // rather than going negative is what makes that true rather than merely early.
  const untilDeadline = Math.max(0, compareInstants(nextDeadline, now));
  return Math.min(heartbeat, untilDeadline);
}
