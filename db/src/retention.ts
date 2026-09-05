/**
 * The purge sweep (DEC-117, DEC-121, `docs/RETENTION.md`, migrations `0022`, `0023` and `0026`).
 *
 * Spec references: `16` (retention deadlines; a deletion workflow enumerates what goes),
 * `14` (least privilege), `20` (operations report what they did without copying health content).
 *
 * WHAT THIS IS AND IS NOT
 * It is the second half of a deletion: the bytes. The first half - revocation, which makes a
 * record inaccessible and stops all processing - happened synchronously in the request that
 * accepted the deletion, and this file has nothing to do with it. Nothing here affects what
 * anybody can see; by the time a row reaches this sweep it has been invisible for thirty days.
 *
 * WHAT MAKES IT SAFE
 * Not the SQL below. Every statement here runs as `kynviora_retention`, whose policies admit only
 * rows that are due, so the widest statement this file could contain is `DELETE FROM owned_item`
 * with no predicate - and that removes only items somebody deleted more than thirty days ago.
 * A bug in a `WHERE` clause here purges too little, never too much, and that asymmetry is the
 * whole design. The predicates are still written out, because a sweep that relied on the policy
 * alone would be one nobody reading it could check.
 *
 * ORDER MATTERS AND IS EXPLICIT
 * Children before parents, deepest first. Not because the foreign keys need it - they cascade -
 * but because a referential action runs as the owner of the referencing table rather than as the
 * session's role, which makes any role check inside a cascaded child's trigger measure the wrong
 * thing (`0023`). Deleting explicitly means every statement is issued by the role whose policies
 * are being relied on, and a child table added later fails loudly on the parent's `DELETE`
 * instead of being removed by a cascade nobody reviewed.
 *
 * WHY THE SWEEP IS A LIST AND NOT A FUNCTION BODY
 * It was a function body until the worker needed it not to be (`0026`). A recurring job has to be
 * able to say *which part* of a sweep failed, and it has to keep going afterwards: one category
 * raising must not stop the other six, and - the failure this shape exists to prevent - must not
 * let the run report success because most of it worked. So the statements are data, grouped into
 * {@link PURGE_CATEGORIES}, and the two callers consume them differently:
 *
 *  - {@link runPurgeSweep} runs every step in order and throws on the first failure. That is what
 *    `npm run purge` and the sweep's own tests want: one sweep, all of it, loudly.
 *  - The worker (`services/worker`) runs {@link runPurgeCategory} per category, each in its own
 *    transaction, recording an outcome for each. See `services/worker/src/retentionRun.ts`.
 *
 * The statements and their order are identical either way, which is the point of there being one
 * list.
 *
 * A CATEGORY IS A UNIT OF WORK, NOT A TABLE
 * The grouping is by what has to succeed together. `ITEM` is a medicine and everything hanging off
 * it, because purging the children and failing on the parent would leave a deleted medicine with
 * half a history - true of nothing anybody wants to read, and the reason the worker runs each
 * category in a transaction. The dependencies between categories are left as dependencies rather
 * than merged: `PROFILE` after `ITEM` because `dose_event` reaches its purge door through
 * `owned_item.deleted_at`, so a profile removed before its items would strand rows the sweep can
 * see and cannot delete. If `ITEM` fails, `PROFILE` fails on the foreign key - loudly, in its own
 * row, rather than silently doing nothing.
 */

export interface PurgeConnection {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: TRow[]; affectedRows?: number }>;
}

/**
 * What one sweep removed.
 *
 * Counts only. `20` keeps operational output free of health content, and a sweep that logged
 * which medicines it purged would be the one place a deleted record came back - written to a log
 * that outlives it.
 */
export interface PurgeReport {
  readonly doseEvents: number;
  readonly schedules: number;
  readonly refillEstimates: number;
  readonly usageEvidence: number;
  readonly reviewTasks: number;
  readonly assessments: number;
  readonly items: number;
  readonly reviewTasksByProfile: number;
  readonly allergies: number;
  readonly conditions: number;
  readonly alertDeliveries: number;
  readonly alertPublications: number;
  readonly safetyReceipts: number;
  readonly caregiverGrants: number;
  readonly reconciliations: number;
  readonly notificationPolicies: number;
  readonly notificationPreferences: number;
  readonly profiles: number;
  readonly visitPackContents: number;
  readonly invitations: number;
  readonly extractionRuns: number;
  readonly evidenceAssets: number;
  readonly auditEvents: number;
  readonly consentReceipts: number;
}

export const EMPTY_PURGE_REPORT: PurgeReport = Object.freeze({
  doseEvents: 0,
  schedules: 0,
  refillEstimates: 0,
  usageEvidence: 0,
  reviewTasks: 0,
  assessments: 0,
  items: 0,
  reviewTasksByProfile: 0,
  allergies: 0,
  conditions: 0,
  alertDeliveries: 0,
  alertPublications: 0,
  safetyReceipts: 0,
  caregiverGrants: 0,
  reconciliations: 0,
  notificationPolicies: 0,
  notificationPreferences: 0,
  profiles: 0,
  visitPackContents: 0,
  invitations: 0,
  extractionRuns: 0,
  evidenceAssets: 0,
  auditEvents: 0,
  consentReceipts: 0,
});

// ---------------------------------------------------------------------------
// The predicates
// ---------------------------------------------------------------------------
// Each repeats what the policy already enforces. Belt and braces, and the braces are the ones
// that hold: if a policy were dropped, these statements would still name only rows whose parent
// is thirty days gone.

const DUE_ITEM = `owned_item_id IN (
    SELECT id FROM owned_item
     WHERE deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor()
  )`;

const DUE_PROFILE = `profile_id IN (
    SELECT id FROM profile
     WHERE deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor()
  )`;

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** One statement, and the {@link PurgeReport} field its row count is added to. */
export interface PurgeStep {
  /**
   * A stable label for this statement.
   *
   * It reaches a database column and a log line when a category fails (`0026`), so it comes from
   * this codebase's own vocabulary rather than from a driver: an error message can quote the row
   * that caused it, and `20` does not allow that anywhere near operational output.
   */
  readonly step: string;
  readonly field: keyof PurgeReport;
  readonly sql: string;
}

export interface PurgeCategoryPlan {
  readonly category: PurgeCategory;
  readonly steps: readonly PurgeStep[];
}

/**
 * The categories, in the order they must run.
 *
 * The order is the dependency order and it is not an implementation detail; see the file
 * docstring for why `PROFILE` follows `ITEM`.
 */
export type PurgeCategory =
  | 'ITEM'
  | 'PROFILE'
  | 'VISIT_PACK_CONTENT'
  | 'CAREGIVER_INVITATION'
  | 'CAPTURE_ARTIFACT'
  | 'AUDIT_EVENT'
  | 'CONSENT_RECEIPT';

const PLAN = [
  // -------------------------------------------------------------------------
  // Items, children first.
  // -------------------------------------------------------------------------
  {
    category: 'ITEM',
    steps: [
      { step: 'dose_event', field: 'doseEvents', sql: `DELETE FROM dose_event WHERE ${DUE_ITEM}` },
      {
        step: 'medicine_schedule',
        field: 'schedules',
        sql: `DELETE FROM medicine_schedule WHERE ${DUE_ITEM}`,
      },
      {
        step: 'refill_estimate',
        field: 'refillEstimates',
        sql: `DELETE FROM refill_estimate WHERE ${DUE_ITEM}`,
      },
      {
        step: 'product_usage_evidence',
        field: 'usageEvidence',
        sql: `DELETE FROM product_usage_evidence WHERE ${DUE_ITEM}`,
      },
      {
        step: 'profile_assessment',
        field: 'assessments',
        sql: `DELETE FROM profile_assessment WHERE ${DUE_ITEM}`,
      },
      // `owned_item_id` is nullable here: a task can be about a profile rather than an item, and
      // one with no item belongs to the profile category below.
      {
        step: 'review_task.by_item',
        field: 'reviewTasks',
        sql: `DELETE FROM review_task WHERE owned_item_id IS NOT NULL AND ${DUE_ITEM}`,
      },
      {
        step: 'owned_item',
        field: 'items',
        sql: `DELETE FROM owned_item
               WHERE deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor()`,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Profiles, children first, after their items.
  // -------------------------------------------------------------------------
  // Ordered after the item category deliberately. `delete_profile` stamps every item at the same
  // instant as the profile, so by the time this runs the shelf and everything under it is already
  // gone - and `profile`'s own foreign keys are then only the ones listed here.
  {
    category: 'PROFILE',
    steps: [
      // A task about a profile rather than an item. Its item-scoped siblings went with the shelf.
      {
        step: 'review_task.by_profile',
        field: 'reviewTasksByProfile',
        sql: `DELETE FROM review_task WHERE owned_item_id IS NULL AND ${DUE_PROFILE}`,
      },
      {
        step: 'alert_delivery',
        field: 'alertDeliveries',
        sql: `DELETE FROM alert_delivery WHERE ${DUE_PROFILE}`,
      },
      {
        step: 'safety_receipt',
        field: 'safetyReceipts',
        sql: `DELETE FROM safety_receipt WHERE ${DUE_PROFILE}`,
      },
      // After the deliveries and receipts that reference it.
      {
        step: 'alert_publication',
        field: 'alertPublications',
        sql: `DELETE FROM alert_publication WHERE ${DUE_PROFILE}`,
      },
      {
        step: 'allergy_record',
        field: 'allergies',
        sql: `DELETE FROM allergy_record WHERE ${DUE_PROFILE}`,
      },
      {
        step: 'condition_record',
        field: 'conditions',
        sql: `DELETE FROM condition_record WHERE ${DUE_PROFILE}`,
      },
      {
        step: 'reconciliation',
        field: 'reconciliations',
        sql: `DELETE FROM reconciliation WHERE ${DUE_PROFILE}`,
      },
      {
        step: 'profile_notification_policy',
        field: 'notificationPolicies',
        sql: `DELETE FROM profile_notification_policy WHERE ${DUE_PROFILE}`,
      },
      {
        step: 'notification_preference',
        field: 'notificationPreferences',
        sql: `DELETE FROM notification_preference WHERE ${DUE_PROFILE}`,
      },
      {
        step: 'caregiver_grant',
        field: 'caregiverGrants',
        sql: `DELETE FROM caregiver_grant WHERE ${DUE_PROFILE}`,
      },
      // An invitation to a profile that is gone goes with it, whether or not it has expired -
      // which is a second reason on top of the expiry sweep below rather than a replacement for
      // it. Both land in the same report field.
      {
        step: 'caregiver_invitation.by_profile',
        field: 'invitations',
        sql: `DELETE FROM caregiver_invitation WHERE ${DUE_PROFILE}`,
      },
      {
        step: 'profile',
        field: 'profiles',
        sql: `DELETE FROM profile
               WHERE deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor()`,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Time-boxed artifacts, which expire on their own clock.
  // -------------------------------------------------------------------------
  // The Visit Pack's **content** goes and the row stays, so "a pack was created and has expired"
  // remains answerable without the pack being readable. Writing three columns rather than
  // deleting is what section 3.2 of the matrix asks for.
  {
    category: 'VISIT_PACK_CONTENT',
    steps: [
      {
        step: 'visit_pack',
        field: 'visitPackContents',
        sql: `UPDATE visit_pack
                 SET manifest = '[]'::jsonb,
                     notes = ARRAY[]::text[],
                     content_purged_at = now()
               WHERE expires_at <= now() - interval '24 hours'
                 AND content_purged_at IS NULL`,
      },
    ],
  },

  {
    category: 'CAREGIVER_INVITATION',
    steps: [
      {
        step: 'caregiver_invitation.expired',
        field: 'invitations',
        sql: `DELETE FROM caregiver_invitation WHERE expires_at <= now() - interval '30 days'`,
      },
    ],
  },

  // Extraction runs before their asset, for the reason the item's children go first: the cascade
  // would work and would not be issued by this role.
  {
    category: 'CAPTURE_ARTIFACT',
    steps: [
      {
        step: 'extraction_run',
        field: 'extractionRuns',
        sql: `DELETE FROM extraction_run
               WHERE evidence_asset_id IN (
                 SELECT id FROM evidence_asset
                  WHERE created_at <= now() - interval '7 days'
                    AND kynviora.evidence_is_unattached(id)
               )`,
      },
      {
        step: 'evidence_asset',
        field: 'evidenceAssets',
        sql: `DELETE FROM evidence_asset
               WHERE created_at <= now() - interval '7 days'
                 AND kynviora.evidence_is_unattached(id)`,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // The two tables that outlive a deletion, at 24 months.
  // -------------------------------------------------------------------------
  // A different deadline and a different reason, so a different floor function - `0023` keeps
  // them separate deliberately, because a single "floor" would have been the shortest possible
  // way to delete an audit log by accident.
  //
  // Two categories rather than one, because they are two different legal bases and a failure to
  // purge one says nothing about the other.
  {
    category: 'AUDIT_EVENT',
    steps: [
      {
        step: 'audit_event',
        field: 'auditEvents',
        sql: `DELETE FROM audit_event WHERE occurred_at <= kynviora.retention_floor()`,
      },
    ],
  },
  {
    category: 'CONSENT_RECEIPT',
    steps: [
      {
        step: 'consent_receipt',
        field: 'consentReceipts',
        sql: `DELETE FROM consent_receipt WHERE recorded_at <= kynviora.retention_floor()`,
      },
    ],
  },
] as const satisfies readonly PurgeCategoryPlan[];

/** Every category, in the order they must run. */
export const PURGE_CATEGORIES: readonly PurgeCategoryPlan[] = PLAN;

/** Every step label, as a closed set. What a failed category may name (`0026`). */
export type PurgeStepLabel = (typeof PLAN)[number]['steps'][number]['step'];

/** What one category removed: the fields it touched, and the total across them. */
export interface PurgeCategoryResult {
  readonly report: PurgeReport;
  readonly rowsPurged: number;
}

/**
 * Every field of a {@link PurgeReport}, derived from the empty one.
 *
 * So that adding a field to the report adds it to the total and to the merge, rather than to
 * neither - which would present as counts that are quietly too low.
 */
const PURGE_FIELDS = Object.keys(EMPTY_PURGE_REPORT) as (keyof PurgeReport)[];

/** The sum across every field, for a caller that wants one number. */
export function totalRowsPurged(report: PurgeReport): number {
  return PURGE_FIELDS.reduce((sum, field) => sum + report[field], 0);
}

/**
 * A step that raised, named.
 *
 * The worker records which statement failed and its SQLSTATE, and neither may come from the
 * driver's message: `20` keeps content out of operational output and a Postgres error carries
 * `detail` quoting the offending row's values verbatim. So the failure is re-thrown carrying the
 * step's own label - from the closed vocabulary above - with the original error as `cause`, which
 * the worker reads for a five-character code and nothing else.
 *
 * The message deliberately contains no part of the cause for the same reason.
 */
export class PurgeStepFailure extends Error {
  readonly category: PurgeCategory;
  readonly step: string;

  constructor(category: PurgeCategory, step: string, cause: unknown) {
    super(`Purge step ${category}/${step} failed.`, { cause });
    this.name = 'PurgeStepFailure';
    this.category = category;
    this.step = step;
  }
}

async function affected(db: PurgeConnection, sql: string): Promise<number> {
  const result = await db.query(sql);
  return result.affectedRows ?? 0;
}

/**
 * Run one category's statements, in order, accumulating counts.
 *
 * **This function does not open a transaction and does not catch anything.** Both are the
 * caller's decision, and they differ: the worker wraps each call in one so a category that raises
 * purges nothing at all, while `npm run purge` wants the first failure to stop the sweep. A
 * transaction opened here would have to be the same for both.
 */
export async function runPurgeCategory(
  db: PurgeConnection,
  plan: PurgeCategoryPlan,
): Promise<PurgeCategoryResult> {
  const report: Record<keyof PurgeReport, number> = { ...EMPTY_PURGE_REPORT };

  for (const step of plan.steps) {
    try {
      report[step.field] += await affected(db, step.sql);
    } catch (cause) {
      throw new PurgeStepFailure(plan.category, step.step, cause);
    }
  }

  return { report: Object.freeze(report), rowsPurged: totalRowsPurged(report) };
}

/** Add one report to another, field by field. */
export function mergePurgeReports(a: PurgeReport, b: PurgeReport): PurgeReport {
  const merged: Record<keyof PurgeReport, number> = { ...EMPTY_PURGE_REPORT };
  for (const field of PURGE_FIELDS) {
    merged[field] = a[field] + b[field];
  }
  return Object.freeze(merged);
}

/**
 * Purge everything past its deadline.
 *
 * Takes a connection already bound to `kynviora_retention`. It does not take a clock: every
 * deadline is evaluated by the database against `now()`, in the policy and again in the
 * statement, so there is no way for a caller to move a deadline by passing a different time. That
 * is the one parameter this function must not have.
 *
 * Every category, in order, stopping at the first failure. The worker does not use this - it
 * needs each category isolated - but `npm run purge` and the sweep's own tests do, and a single
 * function that runs the whole plan is what makes "the plan is complete" checkable in one place.
 */
export async function runPurgeSweep(db: PurgeConnection): Promise<PurgeReport> {
  let report = EMPTY_PURGE_REPORT;
  for (const plan of PURGE_CATEGORIES) {
    report = mergePurgeReports(report, (await runPurgeCategory(db, plan)).report);
  }
  return report;
}

/** Whether a sweep removed anything at all, for a caller deciding whether to report it. */
export function purgeReportIsEmpty(report: PurgeReport): boolean {
  return PURGE_FIELDS.every((field) => report[field] === 0);
}
