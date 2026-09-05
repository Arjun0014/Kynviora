/**
 * The purge sweep (DEC-117, `docs/RETENTION.md`, migrations `0022` and `0023`).
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
 * NOTHING HERE IS SCHEDULED
 * There is no worker process in this build and no deployment to run one in. `runPurgeSweep` is a
 * function and `npm run purge` calls it once. The thirty-day deadline is therefore a commitment
 * the code can keep and the operation cannot yet, which is stated in `docs/RETENTION.md` rather
 * than implied by a job that does not exist.
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

async function count(db: PurgeConnection, sql: string): Promise<number> {
  const result = await db.query(sql);
  return result.affectedRows ?? 0;
}

/**
 * Purge everything past its deadline.
 *
 * Takes a connection already bound to `kynviora_retention`. It does not take a clock: every
 * deadline is evaluated by the database against `now()`, in the policy and again in the
 * statement, so there is no way for a caller to move a deadline by passing a different time. That
 * is the one parameter this function must not have.
 */
export async function runPurgeSweep(db: PurgeConnection): Promise<PurgeReport> {
  // ---------------------------------------------------------------------
  // Items, children first.
  // ---------------------------------------------------------------------
  // Each predicate repeats what the policy already enforces. Belt and braces, and the braces are
  // the ones that hold: if a policy were dropped, these statements would still name only rows
  // whose item is thirty days gone.
  const dueItem = `owned_item_id IN (
    SELECT id FROM owned_item
     WHERE deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor()
  )`;

  const doseEvents = await count(db, `DELETE FROM dose_event WHERE ${dueItem}`);
  const schedules = await count(db, `DELETE FROM medicine_schedule WHERE ${dueItem}`);
  const refillEstimates = await count(db, `DELETE FROM refill_estimate WHERE ${dueItem}`);
  const usageEvidence = await count(db, `DELETE FROM product_usage_evidence WHERE ${dueItem}`);
  const assessments = await count(db, `DELETE FROM profile_assessment WHERE ${dueItem}`);
  // `owned_item_id` is nullable here: a task can be about a profile rather than an item, and one
  // with no item belongs to the profile block below.
  const reviewTasks = await count(
    db,
    `DELETE FROM review_task WHERE owned_item_id IS NOT NULL AND ${dueItem}`,
  );

  const items = await count(
    db,
    `DELETE FROM owned_item
      WHERE deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor()`,
  );

  // ---------------------------------------------------------------------
  // Profiles, children first, after their items.
  // ---------------------------------------------------------------------
  // Ordered after the item block deliberately. `delete_profile` stamps every item at the same
  // instant as the profile, so by the time this runs the shelf and everything under it is already
  // gone - and `profile`'s own foreign keys are then only the ones listed here.
  //
  // The one that would bite if this ran first is `dose_event`: it reaches its purge door through
  // `owned_item.deleted_at`, so removing a profile before its items would leave rows the sweep can
  // see and cannot delete.
  const dueProfile = `profile_id IN (
    SELECT id FROM profile
     WHERE deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor()
  )`;

  // A task about a profile rather than an item. Its item-scoped siblings went with the shelf.
  const reviewTasksByProfile = await count(
    db,
    `DELETE FROM review_task WHERE owned_item_id IS NULL AND ${dueProfile}`,
  );

  const alertDeliveries = await count(db, `DELETE FROM alert_delivery WHERE ${dueProfile}`);
  const safetyReceipts = await count(db, `DELETE FROM safety_receipt WHERE ${dueProfile}`);
  // After the deliveries and receipts that reference it.
  const alertPublications = await count(db, `DELETE FROM alert_publication WHERE ${dueProfile}`);

  const allergies = await count(db, `DELETE FROM allergy_record WHERE ${dueProfile}`);
  const conditions = await count(db, `DELETE FROM condition_record WHERE ${dueProfile}`);
  const reconciliations = await count(db, `DELETE FROM reconciliation WHERE ${dueProfile}`);
  const notificationPolicies = await count(
    db,
    `DELETE FROM profile_notification_policy WHERE ${dueProfile}`,
  );
  const notificationPreferences = await count(
    db,
    `DELETE FROM notification_preference WHERE ${dueProfile}`,
  );
  const caregiverGrants = await count(db, `DELETE FROM caregiver_grant WHERE ${dueProfile}`);
  // An invitation to a profile that is gone goes with it, whether or not it has expired - which is
  // a second reason on top of the expiry sweep above rather than a replacement for it.
  const profileInvitations = await count(
    db,
    `DELETE FROM caregiver_invitation WHERE ${dueProfile}`,
  );

  const profiles = await count(
    db,
    `DELETE FROM profile
      WHERE deleted_at IS NOT NULL AND deleted_at <= kynviora.purge_floor()`,
  );

  // ---------------------------------------------------------------------
  // Time-boxed artifacts, which expire on their own clock.
  // ---------------------------------------------------------------------
  // The Visit Pack's **content** goes and the row stays, so "a pack was created and has expired"
  // remains answerable without the pack being readable. Writing three columns rather than
  // deleting is what section 3.2 of the matrix asks for.
  const visitPackContents = await count(
    db,
    `UPDATE visit_pack
        SET manifest = '[]'::jsonb,
            notes = ARRAY[]::text[],
            content_purged_at = now()
      WHERE expires_at <= now() - interval '24 hours'
        AND content_purged_at IS NULL`,
  );

  const invitations = await count(
    db,
    `DELETE FROM caregiver_invitation WHERE expires_at <= now() - interval '30 days'`,
  );

  // Extraction runs before their asset, for the reason the item's children go first: the cascade
  // would work and would not be issued by this role.
  const extractionRuns = await count(
    db,
    `DELETE FROM extraction_run
      WHERE evidence_asset_id IN (
        SELECT id FROM evidence_asset
         WHERE created_at <= now() - interval '7 days'
           AND kynviora.evidence_is_unattached(id)
      )`,
  );

  const evidenceAssets = await count(
    db,
    `DELETE FROM evidence_asset
      WHERE created_at <= now() - interval '7 days'
        AND kynviora.evidence_is_unattached(id)`,
  );

  // ---------------------------------------------------------------------
  // The two tables that outlive a deletion, at 24 months.
  // ---------------------------------------------------------------------
  // A different deadline and a different reason, so a different floor function - `0023` keeps
  // them separate deliberately, because a single "floor" would have been the shortest possible
  // way to delete an audit log by accident.
  const auditEvents = await count(
    db,
    `DELETE FROM audit_event WHERE occurred_at <= kynviora.retention_floor()`,
  );
  const consentReceipts = await count(
    db,
    `DELETE FROM consent_receipt WHERE recorded_at <= kynviora.retention_floor()`,
  );

  return {
    doseEvents,
    schedules,
    refillEstimates,
    usageEvidence,
    reviewTasks,
    assessments,
    items,
    reviewTasksByProfile,
    allergies,
    conditions,
    alertDeliveries,
    alertPublications,
    safetyReceipts,
    caregiverGrants,
    reconciliations,
    notificationPolicies,
    notificationPreferences,
    profiles,
    visitPackContents,
    invitations: invitations + profileInvitations,
    extractionRuns,
    evidenceAssets,
    auditEvents,
    consentReceipts,
  };
}

/** Whether a sweep removed anything at all, for a caller deciding whether to report it. */
export function purgeReportIsEmpty(report: PurgeReport): boolean {
  return Object.values(report).every((value) => value === 0);
}
