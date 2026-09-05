/**
 * Assembling the digest: one pass over everybody whose morning has come round.
 *
 * Spec references: `04` Phase 7.5 (digest policy for lower urgency; revalidation before
 * inclusion), `09`, `13` (assembly spans every recipient and is a privileged server operation),
 * `16`, `20`, DEC-119, DEC-121, `DEV-033`, migration `0029`.
 *
 * WHAT THIS CLOSES
 * `MEDIUM` and `LOW` events have been classified onto the digest channel since `0014` and nothing
 * has ever gathered them. Since `0028` the channel is recorded per delivery, so there is finally a
 * candidate set to gather.
 *
 * THE READ THAT MATTERS IS DONE AS THE RECIPIENT, NOT AS THE SERVICE
 * Choosing **who** is due is privileged: it spans every recipient, and no single caller could ask
 * it. Deciding **what** each of them may still see is not - it is row-level security's question,
 * and asking it any other way would mean reimplementing the caregiver capability check inside a
 * background job, where nobody would ever look at it again.
 *
 * So the alert behind each candidate is re-read under `withUser(recipient)`. Three quite different
 * things then produce no row - the alert was withdrawn, it was superseded, or the reader's
 * caregiver grant was revoked since they were told - and all three arrive as
 * `NO_LONGER_VISIBLE`. That is deliberate: a digest that said "this was withdrawn" about an alert
 * the reader is no longer entitled to see would be answering from a position they do not occupy.
 *
 * WHAT IS NOT ASSEMBLED, AND WHY
 * Missed-dose deliveries. A `MISSED_DOSE` row has no publication, so there is no state to re-read
 * and nothing for `revalidate` to compare - including one would mean inventing a revalidation,
 * which is the one thing exit criterion 2 forbids. `DEV-011` records that automatic missed-dose
 * escalation is out of MVP, so none exists today; if it is built, this decision has to be revisited
 * rather than inherited.
 *
 * NO LEASE, AND THAT IS NOT AN OVERSIGHT
 * Unlike the purge (DEC-121), this job's idempotence is a **unique index rather than a lock**. Two
 * workers assembling the same recipient's digest for the same local date produce one row and one
 * loser, and `notification_digest_entry` admits a given delivery exactly once ever. A lease would
 * protect nothing that the schema does not already protect.
 */

import {
  assembleDigest,
  digestDue,
  type DigestCandidate,
  type Instant,
  type Logger,
} from '@kynviora/domain';
import type { PurgeConnection } from '@kynviora/db';

/** A connection, as either role. The same shape `@kynviora/db` exposes. */
export interface DigestDb {
  withService<T>(fn: (db: PurgeConnection) => Promise<T>): Promise<T>;
  withUser<T>(userId: string | null, fn: (db: PurgeConnection) => Promise<T>): Promise<T>;
}

export interface DigestRunDeps {
  readonly now: Instant;
  readonly logger: Logger;
  readonly correlationId: string;
}

/** What one pass did. Counts only (`20`); no recipient, no profile, no medicine. */
export interface DigestRunReport {
  /** Recipients with something waiting, before the cadence was consulted. */
  readonly considered: number;
  readonly assembled: number;
  readonly included: number;
  readonly dropped: number;
  /** Recipients not due, by reason. A digest nobody got is a fact somebody will ask about. */
  readonly skippedZoneUnknown: number;
  readonly skippedBeforeLocalHour: number;
  readonly skippedAlreadyAssembled: number;
  /** Recipients whose assembly lost a race to another worker. Expected, and worth counting. */
  readonly conflicts: number;
}

const EMPTY: DigestRunReport = Object.freeze({
  considered: 0,
  assembled: 0,
  included: 0,
  dropped: 0,
  skippedZoneUnknown: 0,
  skippedBeforeLocalHour: 0,
  skippedAlreadyAssembled: 0,
  conflicts: 0,
});

interface RecipientRow {
  readonly recipient_user_id: string;
  readonly time_zone: string | null;
  readonly last_local_date: string | null;
}

interface CandidateRow {
  readonly id: string;
  readonly delivered_at: Date | string;
  readonly alert_publication_id: string;
  readonly assessment_id: string;
}

function toIso(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

/**
 * Everybody with an un-considered digest delivery waiting, and what the cadence needs to know
 * about them.
 *
 * Privileged, and it has to be: it spans every recipient in the system. It reads three things and
 * none of them is content - an opaque user id, a time zone, and the date of their last digest.
 *
 * `MISSED_DOSE` is excluded here rather than filtered later, so the candidate set and the thing
 * this job claims to assemble are the same set.
 */
export async function recipientsWithDigestCandidates(
  db: PurgeConnection,
): Promise<readonly RecipientRow[]> {
  const result = await db.query<RecipientRow>(
    `SELECT d.recipient_user_id,
            u.time_zone,
            (SELECT to_char(g.local_date, 'YYYY-MM-DD')
               FROM notification_digest g
              WHERE g.recipient_user_id = d.recipient_user_id
              ORDER BY g.local_date DESC LIMIT 1) AS last_local_date
       FROM alert_delivery d
       JOIN app_user u ON u.id = d.recipient_user_id
      WHERE d.channel = 'DIGEST'
        AND d.event_kind = 'SAFETY_ALERT'
        AND NOT EXISTS (
          SELECT 1 FROM notification_digest_entry e WHERE e.alert_delivery_id = d.id
        )
      GROUP BY d.recipient_user_id, u.time_zone
      ORDER BY d.recipient_user_id`,
  );
  return result.rows;
}

/**
 * One recipient's candidates, re-read **as them**.
 *
 * The join to `alert_publication` is what row-level security acts on: `alert_read` admits
 * `state = 'PUBLISHED'` and the `VIEW_SAFETY` capability, so a withdrawn alert and a revoked grant
 * both produce no publication row. A LEFT join keeps the delivery in the result with a NULL state,
 * which is exactly the `currentState: null` that `revalidate` treats as `NO_LONGER_VISIBLE` - an
 * inner join would have dropped the candidate silently and left it to be reconsidered tomorrow.
 */
export async function candidatesFor(
  db: PurgeConnection,
  recipientUserId: string,
): Promise<readonly DigestCandidate[]> {
  const result = await db.query<
    CandidateRow & { alert_state: string | null; last_corrected_at: Date | string | null }
  >(
    `SELECT d.id,
            d.delivered_at,
            d.alert_publication_id,
            ap.state AS alert_state,
            (SELECT max(c.corrected_at)
               FROM assessment_correction c
              WHERE c.original_assessment_id = ap.assessment_id
                 OR c.corrected_assessment_id = ap.assessment_id) AS last_corrected_at
       FROM alert_delivery d
       LEFT JOIN alert_publication ap ON ap.id = d.alert_publication_id
      WHERE d.recipient_user_id = $1
        AND d.channel = 'DIGEST'
        AND d.event_kind = 'SAFETY_ALERT'
        AND NOT EXISTS (
          SELECT 1 FROM notification_digest_entry e WHERE e.alert_delivery_id = d.id
        )
      ORDER BY d.delivered_at`,
    [recipientUserId],
  );

  return result.rows.map((row) => ({
    alertDeliveryId: row.id,
    notifiedAt: toIso(row.delivered_at),
    currentState: row.alert_state,
    lastCorrectedAt: row.last_corrected_at === null ? null : toIso(row.last_corrected_at),
  }));
}

/** Postgres reports a unique violation as `23505`. Another worker got there first. */
function isConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === '23505';
}

/**
 * Assemble every digest that is due.
 *
 * Each recipient is independent: one failing does not stop the rest, on the same reasoning the
 * purge sweep isolates its categories. A conflict is not a failure - it is the other worker having
 * done the work - and is counted separately so an operator can tell the two apart.
 */
export async function runDigestAssembly(
  db: DigestDb,
  deps: DigestRunDeps,
): Promise<DigestRunReport> {
  const recipients = await db.withService((conn) => recipientsWithDigestCandidates(conn));
  if (recipients.length === 0) return EMPTY;

  const report: Record<keyof DigestRunReport, number> = { ...EMPTY, considered: recipients.length };

  for (const recipient of recipients) {
    const due = digestDue({
      at: deps.now,
      zone: recipient.time_zone,
      lastLocalDate: recipient.last_local_date,
    });

    if (!due.due) {
      if (due.reason === 'ZONE_UNKNOWN') report.skippedZoneUnknown += 1;
      else if (due.reason === 'BEFORE_LOCAL_HOUR') report.skippedBeforeLocalHour += 1;
      else report.skippedAlreadyAssembled += 1;
      continue;
    }

    // As the recipient. RLS decides what they may still see; nothing here re-implements it.
    const candidates = await db.withUser(recipient.recipient_user_id, (conn) =>
      candidatesFor(conn, recipient.recipient_user_id),
    );
    if (candidates.length === 0) continue;

    const assembled = assembleDigest(candidates);

    try {
      await db.withService(async (conn) => {
        // One transaction, so a digest and its entries are written together or not at all. The
        // counts are on the digest row and are computed before the write, which the schema
        // requires: `notification_digest_not_empty` refuses a summary of nothing.
        await conn.query('BEGIN');
        try {
          const inserted = await conn.query<{ id: string }>(
            `INSERT INTO notification_digest
               (recipient_user_id, local_date, time_zone, assembled_at,
                included_count, dropped_count)
             VALUES ($1, $2::date, $3, $4, $5, $6)
             RETURNING id`,
            [
              recipient.recipient_user_id,
              due.localDate,
              recipient.time_zone,
              deps.now,
              assembled.includedCount,
              assembled.droppedCount,
            ],
          );
          const digestId = inserted.rows[0]?.id;
          if (digestId === undefined) throw new Error('Inserting a digest returned no identifier.');

          for (const entry of assembled.entries) {
            await conn.query(
              `INSERT INTO notification_digest_entry
                 (digest_id, alert_delivery_id, outcome, included)
               VALUES ($1, $2, $3, $4)`,
              [digestId, entry.alertDeliveryId, entry.outcome, entry.included],
            );
          }
          await conn.query('COMMIT');
        } catch (error) {
          try {
            await conn.query('ROLLBACK');
          } catch {
            // Already out of the transaction. The original error is the one worth reporting.
          }
          throw error;
        }
      });

      report.assembled += 1;
      report.included += assembled.includedCount;
      report.dropped += assembled.droppedCount;
    } catch (error) {
      if (!isConflict(error)) throw error;
      // Another worker assembled this recipient's digest for this date while we were reading.
      // Expected under two workers and harmless: the schema, not a lock, is what made it so.
      report.conflicts += 1;
    }
  }

  // Counts, and only counts. Which person got a digest, and about what, is the one thing `20`
  // does not allow into operational output.
  deps.logger.info('digest.assembly.finished', {
    correlation_id: deps.correlationId,
    considered: report.considered,
    assembled: report.assembled,
    included: report.included,
    dropped: report.dropped,
    skipped_zone_unknown: report.skippedZoneUnknown,
    skipped_before_local_hour: report.skippedBeforeLocalHour,
    skipped_already_assembled: report.skippedAlreadyAssembled,
    conflicts: report.conflicts,
  });

  return Object.freeze(report);
}
