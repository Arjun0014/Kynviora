/**
 * Operational projections.
 *
 * Spec references: `20` (observability principles, core service metrics, safety operations
 * metrics, the Source Health Dashboard, alerting, audit versus observability), `14` (operator
 * output leaks nothing), `22` and `BLK-008` (release thresholds are set by leadership against a
 * labelled dataset).
 *
 * THE ONE RULE THIS MODULE EXISTS TO KEEP
 * `20`: "Measure system behavior, not sensitive content", and "alerts to operators should contain
 * identifiers/codes, not medicine names or diagnoses". That is implemented structurally rather
 * than remembered: a {@link MetricReading} carries a key from a closed vocabulary and a `number`,
 * and there is nowhere in the type to put a medicine name, a profile ID, a user ID or free text.
 * A projection that wanted to say *which* profile has the oldest review task could not express it.
 *
 * WHY THERE IS NO STATUS, SEVERITY OR VERDICT
 * `20` lists the alerting conditions and then says "exact thresholds must be documented before
 * production". None are documented, and `BLK-008` records that no labelled dataset exists to set
 * them against. A `status: 'DEGRADED'` field here would invent one, and an operator would read it
 * as an answer - the same mistake trap 29 keeps off a shadow run. This module reports what is
 * true and stops; the thresholds go beside the numbers when somebody with the authority to set
 * them has done so.
 *
 * THE ONE COMPARISON THAT IS NOT A THRESHOLD
 * A source is overdue when the time since its last successful check exceeds
 * `expected_refresh_interval_ms` - the cadence that source itself declares, stored on its registry
 * row. That is not a judgement this module invents; it is arithmetic against a number a reviewer
 * already approved when the source was registered. Reporting `overdueByMs` is honest; adding
 * "critically stale" beside it would not be.
 *
 * AUDIT IS NOT OBSERVABILITY
 * `20` keeps them apart: operational logs answer "is the system healthy?", audit logs answer "who
 * performed a sensitive action". Nothing here reads `audit_event`, and nothing here is an audit
 * record. A count of publications is a health signal; who published them is an audit question and
 * has its own route.
 */

import type { Instant } from './ports.js';

// ---------------------------------------------------------------------------
// The metric vocabulary
// ---------------------------------------------------------------------------

/**
 * Every metric this system reports, named once.
 *
 * A closed vocabulary rather than free-form keys, so an operator dashboard cannot acquire a metric
 * nobody defined and so the "no sensitive content" rule has something to be checked against. The
 * grouping mirrors `20`'s own headings.
 */
export const OPERATIONAL_METRICS = [
  // `20` safety operations: "candidate review queue age", "high-impact pending review count".
  'reviewer_queue_open_requests',
  'reviewer_queue_oldest_open_age_ms',
  'reviewer_queue_awaiting_second_approval',

  // `20`: "assessment evaluation success/failure", "alert publication/withdrawal/correction rate".
  'alerts_published',
  'alerts_withdrawn',
  'assessment_corrections',

  // `20`: "shadow-rule match volume".
  'shadow_runs_recorded',

  // `20` safety operations: source freshness is a safety metric.
  'sources_registered',
  'sources_never_successfully_checked',
  'sources_overdue',
  'sources_with_consecutive_failures',

  // `20` catalog/data: parser and extraction outcomes, and quarantined material.
  'extraction_runs_succeeded',
  'extraction_runs_failed',
  'extraction_runs_abstained',
  'catalog_conflicts_open',

  // The household review inbox. Not the reviewer queue - two different queues, and conflating
  // them would report staff workload as user workload or the reverse.
  'review_tasks_open',
  'review_tasks_oldest_open_age_ms',

  // `20` core service: publication is blocked or it is not. A boolean reported as 0 or 1, because
  // a metric stream carries numbers and an operator alert on "publication has been stopped" is
  // exactly the kind `20` asks for.
  'publication_blocked',

  // Retention (DEC-121). A background job's health, which `20` treats as operational rather than
  // as audit - what was purged is a count, who deleted it is an audit question with its own route.
  //
  // `retention_never_swept` is a separate metric rather than an extreme value of the age beside
  // it, because "never" and "just now" are the two ends of that number and an age of zero is what
  // both would report. `sources_never_successfully_checked` exists for the same reason.
  'retention_never_swept',
  'retention_last_successful_run_age_ms',
  // How many categories' most recent attempt failed. Self-clearing: non-zero exactly while some
  // promise in `docs/RETENTION.md` is not being kept, back to zero when that category next
  // succeeds. It is why a run outcome of PARTIAL needs no window to be alertable.
  'retention_categories_failing',
  // Runs opened and never closed. Normally zero, briefly one; persistently above zero is a worker
  // dying mid-sweep.
  'retention_runs_unfinished',
  'retention_rows_purged_last_run',
] as const;
export type MetricKey = (typeof OPERATIONAL_METRICS)[number];

/**
 * What a number means.
 *
 * Carried explicitly because "42" and "42 milliseconds" are different facts and a dashboard that
 * guessed from the metric name would guess wrong the first time somebody renamed one.
 */
export const METRIC_UNITS = ['COUNT', 'MILLISECONDS', 'BOOLEAN'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/**
 * The unit of every metric, declared once.
 *
 * A total record: a new metric key fails to compile until its unit is stated.
 */
export const METRIC_UNIT: Readonly<Record<MetricKey, MetricUnit>> = Object.freeze({
  reviewer_queue_open_requests: 'COUNT',
  reviewer_queue_oldest_open_age_ms: 'MILLISECONDS',
  reviewer_queue_awaiting_second_approval: 'COUNT',
  alerts_published: 'COUNT',
  alerts_withdrawn: 'COUNT',
  assessment_corrections: 'COUNT',
  shadow_runs_recorded: 'COUNT',
  sources_registered: 'COUNT',
  sources_never_successfully_checked: 'COUNT',
  sources_overdue: 'COUNT',
  sources_with_consecutive_failures: 'COUNT',
  extraction_runs_succeeded: 'COUNT',
  extraction_runs_failed: 'COUNT',
  extraction_runs_abstained: 'COUNT',
  catalog_conflicts_open: 'COUNT',
  review_tasks_open: 'COUNT',
  review_tasks_oldest_open_age_ms: 'MILLISECONDS',
  publication_blocked: 'BOOLEAN',
  retention_never_swept: 'BOOLEAN',
  retention_last_successful_run_age_ms: 'MILLISECONDS',
  retention_categories_failing: 'COUNT',
  retention_runs_unfinished: 'COUNT',
  retention_rows_purged_last_run: 'COUNT',
});

/**
 * One number, and what it is.
 *
 * There is no `label`, `message`, `subject`, `profileId` or `note` here and there must not be.
 * `20` forbids operator output carrying medicine names or diagnoses, and the way to keep them out
 * is for the type to have nowhere to put them.
 */
export interface MetricReading {
  readonly key: MetricKey;
  readonly value: number;
  readonly unit: MetricUnit;
}

// ---------------------------------------------------------------------------
// Source health
// ---------------------------------------------------------------------------

/**
 * One source's registry row, as the dashboard reads it.
 *
 * The strings here are the source's own public identity - the organization that publishes it, its
 * jurisdiction, its parser version, its operational owner. `20`'s Source Health Dashboard requires
 * exactly these, and none of them is user content: a regulator's name is a public fact.
 */
export interface SourceHealthInput {
  readonly sourceId: string;
  readonly organization: string;
  readonly sourceName: string;
  readonly jurisdiction: string | null;
  readonly status: string;
  readonly parserVersion: string;
  readonly operationalOwner: string | null;
  readonly expectedRefreshIntervalMs: number;
  readonly lastAttemptedCheckAt: Instant | null;
  readonly lastSuccessfulCheckAt: Instant | null;
  readonly lastNewRecordAt: Instant | null;
  readonly consecutiveFailureCount: number;
}

export interface SourceHealthRow extends SourceHealthInput {
  /**
   * How far past its own declared cadence this source is, or `null`.
   *
   * `null` where it is not overdue **and** where it has never been checked successfully - two
   * different facts, kept apart by {@link SourceHealthRow.neverSucceeded}. A source that has never
   * succeeded is not "0ms overdue", and reporting it as such would hide the worst case inside the
   * best-looking number.
   */
  readonly overdueByMs: number | null;
  readonly neverSucceeded: boolean;
  /**
   * Whether nobody is named as responsible for this source.
   *
   * `20`: "do not create alerts no one owns", and the Source Health Dashboard requires an
   * operational owner. An unowned source is a real operational finding, and it is one this
   * projection can make without a threshold.
   */
  readonly unowned: boolean;
}

/**
 * Project one source's health.
 *
 * The clock is injected, like every other clock in this codebase (DEC-003/024). This is not an
 * authorization predicate - nothing is granted or refused on the answer - so the injected clock is
 * correct here and makes the projection replayable.
 */
export function projectSourceHealth(input: SourceHealthInput, now: Instant): SourceHealthRow {
  const neverSucceeded = input.lastSuccessfulCheckAt === null;

  let overdueByMs: number | null = null;
  if (!neverSucceeded) {
    const elapsed = Date.parse(now) - Date.parse(input.lastSuccessfulCheckAt);
    const over = elapsed - input.expectedRefreshIntervalMs;
    overdueByMs = over > 0 ? over : null;
  }

  return {
    ...input,
    overdueByMs,
    neverSucceeded,
    unowned: input.operationalOwner === null || input.operationalOwner.trim() === '',
  };
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/**
 * The raw counts a snapshot is built from.
 *
 * Gathered by the caller, because counting is the database's job and deciding what a count means
 * is this module's. Splitting them is what lets the projection be tested without a server and the
 * queries be tested without a projection.
 */
export interface OperationalCounts {
  readonly reviewerQueueOpenRequests: number;
  readonly reviewerQueueOldestOpenAt: Instant | null;
  readonly reviewerQueueAwaitingSecondApproval: number;
  readonly alertsPublished: number;
  readonly alertsWithdrawn: number;
  readonly assessmentCorrections: number;
  readonly shadowRunsRecorded: number;
  readonly extractionRunsSucceeded: number;
  readonly extractionRunsFailed: number;
  readonly extractionRunsAbstained: number;
  readonly catalogConflictsOpen: number;
  readonly reviewTasksOpen: number;
  readonly reviewTasksOldestOpenAt: Instant | null;
  readonly publicationBlocked: boolean;
  /**
   * When a retention sweep last ended `SUCCEEDED`, or `null` if one never has (DEC-121).
   *
   * `null` is a fact rather than a missing value, and it is the reason `retention_never_swept`
   * exists: {@link ageMs} answers zero for `null`, which is correct for "nothing is waiting in a
   * queue" and exactly backwards for "no sweep has ever completed".
   *
   * `PARTIAL` deliberately does not count. A sweep that skipped a category did not keep that
   * category's deadline, and an operator asking when retention last worked is asking about all
   * of it - `retentionCategoriesFailing` is where the detail lives.
   */
  readonly retentionLastSuccessfulRunAt: Instant | null;
  readonly retentionCategoriesFailing: number;
  readonly retentionRunsUnfinished: number;
  readonly retentionRowsPurgedLastRun: number;
  readonly sources: readonly SourceHealthInput[];
}

export interface OperationalSnapshot {
  readonly at: Instant;
  readonly metrics: readonly MetricReading[];
  readonly sources: readonly SourceHealthRow[];
}

/** Age in milliseconds, or zero where there is nothing waiting. */
function ageMs(from: Instant | null, now: Instant): number {
  if (from === null) return 0;
  const elapsed = Date.parse(now) - Date.parse(from);
  return elapsed > 0 ? elapsed : 0;
}

/**
 * Build the snapshot.
 *
 * Every metric is present on every snapshot, including the zeroes. A dashboard that only receives
 * a metric when it is non-zero cannot tell "nothing happened" from "the projection stopped
 * running", and `20` treats a silent failure of the observability path as an incident of its own.
 */
export function projectOperationalSnapshot(
  counts: OperationalCounts,
  now: Instant,
): OperationalSnapshot {
  const sources = counts.sources.map((source) => projectSourceHealth(source, now));

  const values: Readonly<Record<MetricKey, number>> = {
    reviewer_queue_open_requests: counts.reviewerQueueOpenRequests,
    reviewer_queue_oldest_open_age_ms: ageMs(counts.reviewerQueueOldestOpenAt, now),
    reviewer_queue_awaiting_second_approval: counts.reviewerQueueAwaitingSecondApproval,
    alerts_published: counts.alertsPublished,
    alerts_withdrawn: counts.alertsWithdrawn,
    assessment_corrections: counts.assessmentCorrections,
    shadow_runs_recorded: counts.shadowRunsRecorded,
    sources_registered: sources.length,
    sources_never_successfully_checked: sources.filter((s) => s.neverSucceeded).length,
    sources_overdue: sources.filter((s) => s.overdueByMs !== null).length,
    sources_with_consecutive_failures: sources.filter((s) => s.consecutiveFailureCount > 0).length,
    extraction_runs_succeeded: counts.extractionRunsSucceeded,
    extraction_runs_failed: counts.extractionRunsFailed,
    extraction_runs_abstained: counts.extractionRunsAbstained,
    catalog_conflicts_open: counts.catalogConflictsOpen,
    review_tasks_open: counts.reviewTasksOpen,
    review_tasks_oldest_open_age_ms: ageMs(counts.reviewTasksOldestOpenAt, now),
    publication_blocked: counts.publicationBlocked ? 1 : 0,
    // Derived here rather than gathered, so the boolean and the age cannot disagree about whether
    // a sweep has ever happened.
    retention_never_swept: counts.retentionLastSuccessfulRunAt === null ? 1 : 0,
    retention_last_successful_run_age_ms: ageMs(counts.retentionLastSuccessfulRunAt, now),
    retention_categories_failing: counts.retentionCategoriesFailing,
    retention_runs_unfinished: counts.retentionRunsUnfinished,
    retention_rows_purged_last_run: counts.retentionRowsPurgedLastRun,
  };

  return {
    at: now,
    metrics: OPERATIONAL_METRICS.map((key) => ({
      key,
      value: values[key],
      unit: METRIC_UNIT[key],
    })),
    sources,
  };
}

/**
 * Metrics as a flat record, for a log line or an exporter.
 *
 * `20` wants operational output usable by whatever collects it. Deliberately loses the units,
 * which is why {@link OperationalSnapshot} keeps them: this shape is for a sink that already knows
 * what it is scraping, and the snapshot is for a reader who does not.
 */
export function metricsAsRecord(
  snapshot: OperationalSnapshot,
): Readonly<Record<MetricKey, number>> {
  const out = {} as Record<MetricKey, number>;
  for (const reading of snapshot.metrics) out[reading.key] = reading.value;
  return out;
}
