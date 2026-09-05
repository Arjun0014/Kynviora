/**
 * The operational projection route.
 *
 * Spec references: `20` (observability principles, safety operations metrics, the Source Health
 * Dashboard, audit versus observability), `13` (least privilege; staff routes), `14` (staff roles
 * are never inferred from a client claim), `DEV-016`.
 *
 *   GET /v1/reviewer/operations   - the snapshot, and one row per registered source
 *
 * WHY IT LIVES UNDER THE REVIEWER PREFIX
 * It is staff software, on the same trust boundary as the console: `0012` gives `kynviora_app` no
 * grant on the publication tables, and the source registry is not a user surface either. The
 * authorization is the same stored `reviewer` row, and the same bare not-found for anyone else -
 * so this route does not tell a stranger that an operations surface exists.
 *
 * WHY ANY ACTIVE REVIEWER MAY READ IT, RATHER THAN ONE ROLE
 * `13` asks for least privilege and the obvious reading is `SOURCE_OPERATIONS_OWNER` only. That
 * would be wrong here for a specific reason: `20` calls source freshness a **safety** metric, and
 * a clinical safety lead deciding whether a rule should stay published needs to know the source
 * behind it has not been checked in a fortnight. The snapshot contains no user content of any
 * kind - it is counts, ages and the public identity of regulators - so the usual reason to narrow
 * a staff read does not apply, and narrowing it would keep a safety signal from the people whose
 * job it is to act on one.
 *
 * WHY THE QUERIES ARE PRIVILEGED
 * They span every profile and every source, and the app role holds no grant on most of what they
 * count. That means row-level security is not the boundary here - the reviewer check above is -
 * which is the same shape the console and the audit read already have.
 *
 * WHAT THIS ROUTE WILL NOT RETURN
 * A status, a severity, a threshold breach, or the identity of any subject behind a number. The
 * projection has nowhere to put them (`observability.ts`), and this route adds nothing to what it
 * returns. `20` requires exact thresholds to be documented before production and `BLK-008` records
 * that none are; a "degraded" here would be an invented answer an operator would act on.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  projectOperationalSnapshot,
  type DomainError,
  type Instant,
  type OperationalCounts,
  type SourceHealthInput,
} from '@kynviora/domain';
import type { RequestContext } from './context.js';
import { activeReviewerRoles, NOT_A_REVIEWER } from './reviewerConsole.js';

export interface OperationsRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
}

/** Postgres `count(*)` comes back as a string. A silent `NaN` here would read as zero activity. */
function toCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toInstant(value: Date | string | null | undefined): Instant | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

/**
 * Gather the raw counts.
 *
 * Exported so the projection can be exercised against a real database without a route, and so the
 * queries are one thing to read rather than a block inside a handler. Counting is the database's
 * job; deciding what a count means is the domain's.
 */
export async function gatherOperationalCounts(ctx: RequestContext): Promise<OperationalCounts> {
  return ctx.privileged('REVIEWER_CONSOLE', async (db) => {
    const queue = await db.query<{ open_requests: string; oldest_open_at: Date | string | null }>(
      `SELECT count(*) AS open_requests, min(requested_at) AS oldest_open_at
         FROM publication_request WHERE state = 'OPEN'`,
    );

    // Open requests that have one approval and need two. `20` calls this the high-impact pending
    // review count, and it is the one an SLA is usually written against.
    const awaiting = await db.query<{ awaiting: string }>(
      `SELECT count(*) AS awaiting FROM publication_request r
        WHERE r.state = 'OPEN'
          AND r.required_approvals = 2
          AND (SELECT count(DISTINCT a.reviewer_user_id)
                 FROM publication_approval a
                WHERE a.request_id = r.id AND a.decision = 'APPROVE') = 1`,
    );

    const alerts = await db.query<{ published: string; withdrawn: string }>(
      `SELECT count(*) FILTER (WHERE state = 'PUBLISHED')  AS published,
              count(*) FILTER (WHERE state = 'WITHDRAWN') AS withdrawn
         FROM alert_publication`,
    );

    const corrections = await db.query<{ total: string }>(
      `SELECT count(*) AS total FROM assessment_correction`,
    );

    const shadow = await db.query<{ total: string }>(`SELECT count(*) AS total FROM shadow_run`);

    const extraction = await db.query<{ succeeded: string; failed: string; abstained: string }>(
      `SELECT count(*) FILTER (WHERE outcome = 'SUCCEEDED')  AS succeeded,
              count(*) FILTER (WHERE outcome = 'FAILED')     AS failed,
              count(*) FILTER (WHERE outcome = 'ABSTAINED')  AS abstained
         FROM extraction_run`,
    );

    const conflicts = await db.query<{ total: string }>(
      `SELECT count(*) AS total FROM catalog_conflict WHERE resolved_at IS NULL`,
    );

    // The household inbox, across every profile. A count, never a list: which profile has the
    // oldest open task is a fact about a person, and `20` keeps that out of operator output.
    const tasks = await db.query<{ open_tasks: string; oldest_open_at: Date | string | null }>(
      `SELECT count(*) AS open_tasks, min(created_at) AS oldest_open_at
         FROM review_task WHERE state = 'OPEN'`,
    );

    const control = await db.query<{ publication_blocked: boolean }>(
      `SELECT publication_blocked FROM publication_control WHERE singleton`,
    );

    // Retention (DEC-121, `0027`). Through a `SECURITY DEFINER` function rather than a table
    // grant: the answer is five numbers and the tables it comes from are the run history of a
    // role that exists to empty other tables. The service role learns the aggregates and gains no
    // way to read a row.
    const retention = await db.query<{
      last_successful_run_at: Date | string | null;
      categories_failing: number;
      runs_unfinished: number;
      rows_purged_last_run: number;
    }>(`SELECT * FROM kynviora.retention_health()`);

    const sources = await db.query<{
      id: string;
      organization: string;
      source_name: string;
      jurisdiction: string | null;
      status: string;
      parser_version: string;
      operational_owner: string | null;
      expected_refresh_interval_ms: string;
      last_attempted_check_at: Date | string | null;
      last_successful_check_at: Date | string | null;
      last_new_record_at: Date | string | null;
      consecutive_failure_count: number;
    }>(
      `SELECT id, organization, source_name, jurisdiction, status, parser_version,
              operational_owner, expected_refresh_interval_ms,
              last_attempted_check_at, last_successful_check_at, last_new_record_at,
              consecutive_failure_count
         FROM source_registry_entry
        ORDER BY organization, source_name`,
    );

    const sourceRows: SourceHealthInput[] = sources.rows.map((row) => ({
      sourceId: row.id,
      organization: row.organization,
      sourceName: row.source_name,
      jurisdiction: row.jurisdiction,
      status: row.status,
      parserVersion: row.parser_version,
      operationalOwner: row.operational_owner,
      expectedRefreshIntervalMs: toCount(row.expected_refresh_interval_ms),
      lastAttemptedCheckAt: toInstant(row.last_attempted_check_at),
      lastSuccessfulCheckAt: toInstant(row.last_successful_check_at),
      lastNewRecordAt: toInstant(row.last_new_record_at),
      consecutiveFailureCount: toCount(row.consecutive_failure_count),
    }));

    return {
      reviewerQueueOpenRequests: toCount(queue.rows[0]?.open_requests),
      reviewerQueueOldestOpenAt: toInstant(queue.rows[0]?.oldest_open_at),
      reviewerQueueAwaitingSecondApproval: toCount(awaiting.rows[0]?.awaiting),
      alertsPublished: toCount(alerts.rows[0]?.published),
      alertsWithdrawn: toCount(alerts.rows[0]?.withdrawn),
      assessmentCorrections: toCount(corrections.rows[0]?.total),
      shadowRunsRecorded: toCount(shadow.rows[0]?.total),
      extractionRunsSucceeded: toCount(extraction.rows[0]?.succeeded),
      extractionRunsFailed: toCount(extraction.rows[0]?.failed),
      extractionRunsAbstained: toCount(extraction.rows[0]?.abstained),
      catalogConflictsOpen: toCount(conflicts.rows[0]?.total),
      reviewTasksOpen: toCount(tasks.rows[0]?.open_tasks),
      reviewTasksOldestOpenAt: toInstant(tasks.rows[0]?.oldest_open_at),
      publicationBlocked: control.rows[0]?.publication_blocked === true,
      // `null` where no sweep has ever succeeded, which the projection turns into
      // `retention_never_swept` rather than into an age of zero.
      retentionLastSuccessfulRunAt: toInstant(retention.rows[0]?.last_successful_run_at),
      retentionCategoriesFailing: toCount(retention.rows[0]?.categories_failing),
      retentionRunsUnfinished: toCount(retention.rows[0]?.runs_unfinished),
      retentionRowsPurgedLastRun: toCount(retention.rows[0]?.rows_purged_last_run),
      sources: sourceRows,
    };
  });
}

export function registerOperationsRoutes(app: FastifyInstance, deps: OperationsRouteDeps): void {
  const { contextFor, fail } = deps;

  app.get('/v1/reviewer/operations', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    // `14`: staff roles come from a stored row, never from a client claim. A caller holding none
    // gets a bare not-found, so the route is not an oracle for its own existence.
    const roles = await activeReviewerRoles(ctx);
    if (roles.length === 0) return fail(reply, NOT_A_REVIEWER, ctx.correlationId);

    const snapshot = projectOperationalSnapshot(await gatherOperationalCounts(ctx), ctx.now);

    // `20`: use correlation IDs across request, job and publication flow. Emitting the snapshot to
    // the log as well as the response is what makes the projection usable by whatever collects
    // operational output, without a second code path that could drift from this one.
    ctx.logger.info('api.operational_snapshot', {
      correlation_id: ctx.correlationId,
      metric_count: snapshot.metrics.length,
      source_count: snapshot.sources.length,
    });

    return reply.send({ ...snapshot, serverTime: ctx.now });
  });
}
