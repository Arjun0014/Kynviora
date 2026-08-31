/**
 * Household Review Inbox routes.
 *
 * Spec references: `04` Phase 8.3, `03` group G (the alert experience this must not resemble),
 * `13` (privileged server-only operations, idempotency), `14` (step-up for caregiver
 * administration), `16` (a caregiver acts under the capability they were granted).
 *
 *   GET  /v1/profiles/:profileId/review-tasks  - refresh derivation, then list what you may see
 *   POST /v1/review-tasks/:taskId/complete     - write the record, and close the task as a result
 *
 * WHY DERIVATION IS PRIVILEGED AND LISTING IS NOT
 * Derivation reads the whole profile: which items are overdue, which grants are near expiry,
 * which alerts are unconfirmed. If it ran under the caller's row-level view, the *stored* set of
 * tasks would depend on who last opened the inbox - a caregiver with narrow capabilities would
 * quietly delete work from the owner's list by looking at it. So derivation runs as the service
 * role over the full record set, and the listing is filtered afterwards by row-level security.
 *
 * The filtering is done by joining each task to its subject through the RLS-scoped connection. A
 * subject the caller may not read comes back null and the task is dropped, so a caregiver never
 * sees a task naming a record they have no grant on. That is deny-by-default and it costs nothing:
 * the policies that already govern those tables do the work.
 *
 * WHY THERE IS NO "MARK DONE"
 * `04` Phase 8.3 requires that completing a task updates the relevant authoritative record. The
 * completion endpoint therefore takes the *change*, applies it to the record, and closes the task
 * as a consequence - in that order, in one transaction. The record write goes through the
 * RLS-scoped connection wherever the app role has the privilege, so the inbox can never write
 * something the caller could not have written directly. It is not a permission side channel.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  COMPLETABLE_FIELDS,
  REVIEW_OUTCOMES,
  REVIEW_SUBJECT_KINDS,
  deriveTasks,
  domainError,
  evaluateCompletion,
  isErr,
  reviewTaskAuditAction,
  reviewTaskAuditDetail,
  unsafeId,
  type CompletionAuthority,
  type DomainError,
  type InboxSnapshot,
  type Instant,
  type ProfileId,
  type RecordChange,
  type ReviewSubjectKind,
  type ReviewTask,
  type ReviewTaskId,
  type ReviewTaskKind,
  type ReviewTaskState,
} from '@kynviora/domain';
import type { DatabaseConnection, RequestContext } from './context.js';
import { hasFreshStepUp } from './context.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const profileParamsSchema = z.object({ profileId: z.string().uuid() });
const taskParamsSchema = z.object({ taskId: z.string().uuid() });

const completeBodySchema = z.object({
  outcome: z.enum(REVIEW_OUTCOMES),
  changes: z
    .array(
      z.object({
        recordKind: z.enum(REVIEW_SUBJECT_KINDS),
        recordId: z.string().uuid(),
        field: z.string().min(1).max(64),
        value: z.string().max(2000).nullable(),
      }),
    )
    .max(8),
});

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface TaskRow {
  readonly id: string;
  readonly profile_id: string;
  readonly task_kind: string;
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly state: string;
  readonly created_at: Date;
}

interface VisibleTaskRow extends TaskRow {
  /** Null when row-level security hid the subject from this caller. */
  readonly subject_label: string | null;
}

function iso(value: Date): Instant {
  return value.toISOString() as Instant;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Read the whole profile and reconcile the stored open tasks with what should be open.
 *
 * Privileged, for the reason in the module header. Insertion relies on the partial unique index
 * over open tasks rather than on a read-then-write, so two refreshes racing cannot produce a
 * duplicate. Tasks whose condition has gone are **not** deleted here: a task is closed by writing
 * to the record, so the normal path already removes it, and deleting one out from under the user
 * would lose the record that the work was done. A task left open whose condition has cleared is
 * therefore possible - it is closed the next time someone completes it, which still writes.
 */
export async function refreshInbox(
  ctx: RequestContext,
  profileId: string,
): Promise<readonly TaskRow[]> {
  return ctx.privileged('REVIEW_TASK_DERIVATION', async (db) => {
    const snapshot = await loadSnapshot(db, unsafeId<ProfileId>(profileId));
    const derived = deriveTasks(snapshot, ctx.now);

    for (const task of derived) {
      await db.query(
        `INSERT INTO review_task
           (profile_id, owned_item_id, task_kind, subject_kind, subject_id, state, created_at)
         VALUES ($1, $2, $3, $4, $5, 'OPEN', $6)
         ON CONFLICT DO NOTHING`,
        [
          profileId,
          task.subjectKind === 'owned_item' ? task.subjectId : null,
          task.kind,
          task.subjectKind,
          task.subjectId,
          ctx.now,
        ],
      );
    }

    const stored = await db.query<TaskRow>(
      `SELECT id, profile_id, task_kind, subject_kind, subject_id, state, created_at
         FROM review_task
        WHERE profile_id = $1 AND state = 'OPEN'
        ORDER BY created_at ASC`,
      [profileId],
    );
    return stored.rows;
  });
}

async function loadSnapshot(db: DatabaseConnection, profileId: ProfileId): Promise<InboxSnapshot> {
  const items = await db.query<{
    id: string;
    item_kind: string;
    lifecycle_state: string;
    last_reviewed_at: Date | null;
    created_at: Date;
    batch_id: string | null;
    batch_verification: string;
    formulation_verification: string;
    unresolved_extraction: boolean;
  }>(
    `SELECT i.id, i.item_kind, i.lifecycle_state, i.last_reviewed_at, i.created_at,
            i.batch_id, i.batch_verification, i.formulation_verification,
            -- An extracted value the user has neither confirmed nor corrected, and which no
            -- later assertion has superseded. Spec 03 Phase 3.3 is explicit that unconfirmed
            -- machine provenance is never trusted, so this is exactly the state a user is being
            -- asked to resolve - and the provenance filter keeps a hand-typed value, which is
            -- already the user's own word, out of the inbox.
            EXISTS (
              SELECT 1 FROM field_assertion fa
               WHERE fa.confirmation = 'UNCONFIRMED'
                 AND fa.provenance IN ('PACKAGE_OCR', 'PACKAGE_VISION_MODEL')
                 AND (
                   fa.product_identity_id = i.product_identity_id
                   OR fa.formulation_id = i.formulation_id
                   OR fa.batch_id = i.batch_id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM field_assertion later WHERE later.supersedes_id = fa.id
                 )
            ) AS unresolved_extraction
       FROM owned_item i
      WHERE i.profile_id = $1`,
    [profileId],
  );

  const grants = await db.query<{ id: string; status: string; expires_at: Date | null }>(
    'SELECT id, status, expires_at FROM caregiver_grant WHERE profile_id = $1',
    [profileId],
  );

  const alerts = await db.query<{ id: string; state: string; resolution: string | null }>(
    `SELECT ap.id, ap.state, sr.resolution
       FROM alert_publication ap
       LEFT JOIN safety_receipt sr ON sr.alert_publication_id = ap.id
      WHERE ap.profile_id = $1`,
    [profileId],
  );

  const refills = await db.query<{
    id: string;
    computed_at: Date;
    estimated_depletion_on: Date | null;
  }>(
    `SELECT r.id, r.computed_at, r.estimated_depletion_on
       FROM refill_estimate r
       JOIN owned_item i ON i.id = r.owned_item_id
      WHERE i.profile_id = $1`,
    [profileId],
  );

  return {
    profileId,
    items: items.rows.map((row) => ({
      id: row.id,
      itemKind: row.item_kind === 'MEDICINE' ? ('MEDICINE' as const) : ('PERSONAL_CARE' as const),
      lifecycleState: row.lifecycle_state,
      lastReviewedAt: row.last_reviewed_at === null ? null : iso(row.last_reviewed_at),
      createdAt: iso(row.created_at),
      batchId: row.batch_id,
      batchVerification: row.batch_verification,
      formulationVerification: row.formulation_verification,
      hasUnresolvedExtraction: row.unresolved_extraction,
    })),
    grants: grants.rows.map((row) => ({
      id: row.id,
      status: row.status,
      expiresAt: row.expires_at === null ? null : iso(row.expires_at),
    })),
    alerts: alerts.rows.map((row) => ({
      id: row.id,
      state: row.state,
      resolution: row.resolution,
    })),
    refillEstimates: refills.rows.map((row) => ({
      id: row.id,
      computedAt: iso(row.computed_at),
      estimatedDepletionOn:
        row.estimated_depletion_on === null
          ? null
          : row.estimated_depletion_on.toISOString().slice(0, 10),
    })),
  };
}

// ---------------------------------------------------------------------------
// Applying a completion
// ---------------------------------------------------------------------------

/**
 * Where each field is written, and whether the app role may write it itself.
 *
 * `caregiver_grant` is the exception: `0002` gives the app role SELECT only, because `13` makes
 * grant finalisation a privileged operation. Renewing a grant from the inbox therefore goes
 * through the service role - and, like every other caregiver administration action, behind
 * step-up (`14`).
 */
const TABLE_FOR_SUBJECT: Readonly<Record<ReviewSubjectKind, string>> = Object.freeze({
  owned_item: 'owned_item',
  caregiver_grant: 'caregiver_grant',
  alert_publication: 'safety_receipt',
  refill_estimate: 'refill_estimate',
});

/** Subjects whose write the app role does not hold, and which must go through the service role. */
const PRIVILEGED_SUBJECTS: ReadonlySet<ReviewSubjectKind> = new Set(['caregiver_grant']);

/** Columns that must be written as a timestamp rather than as text. */
const TIMESTAMP_FIELDS: ReadonlySet<string> = new Set(['last_reviewed_at', 'expires_at']);
/** Columns that must be written as a uuid. */
const UUID_FIELDS: ReadonlySet<string> = new Set(['batch_id', 'formulation_id']);
/** Columns that must be written as a number. */
const NUMERIC_FIELDS: ReadonlySet<string> = new Set(['quantity_remaining', 'doses_per_day']);

function castFor(field: string): string {
  if (TIMESTAMP_FIELDS.has(field)) return '::timestamptz';
  if (UUID_FIELDS.has(field)) return '::uuid';
  if (NUMERIC_FIELDS.has(field)) return '::numeric';
  return '';
}

/**
 * Apply one change to its authoritative record.
 *
 * The field name is never interpolated from user input directly: it has already been checked
 * against {@link COMPLETABLE_FIELDS} for this task's kind by `evaluateCompletion`, which is a
 * closed allow-list of literals. The check is repeated here rather than assumed, because this
 * function builds SQL and a future caller that forgot the domain check would otherwise have an
 * injection point.
 */
async function applyChange(
  db: DatabaseConnection,
  kind: ReviewTaskKind,
  change: RecordChange,
  actor: { readonly userId: string; readonly now: Instant },
): Promise<number> {
  if (!COMPLETABLE_FIELDS[kind].includes(change.field)) {
    throw new Error(`field ${change.field} is not completable for ${kind}`);
  }
  const table = TABLE_FOR_SUBJECT[change.recordKind];

  if (change.recordKind === 'alert_publication') {
    // The receipt is the authoritative record for a resolution; the publication itself is
    // immutable. Resolving also stamps who and when, which `receipt_resolved_has_time` requires -
    // and the time comes from the injected clock, as every written timestamp does (DEC-024).
    const res = await db.query(
      `UPDATE safety_receipt
          SET resolution = $1, resolved_at = $2, resolved_by_user_id = $3
        WHERE alert_publication_id = $4`,
      [
        change.value,
        change.value === null ? null : actor.now,
        change.value === null ? null : actor.userId,
        change.recordId,
      ],
    );
    return res.affectedRows ?? 0;
  }

  const res = await db.query(
    `UPDATE ${table} SET ${change.field} = $1${castFor(change.field)} WHERE id = $2`,
    [change.value, change.recordId],
  );
  return res.affectedRows ?? 0;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface ReviewInboxRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
}

export function registerReviewInboxRoutes(app: FastifyInstance, deps: ReviewInboxRouteDeps): void {
  const { contextFor, fail } = deps;

  async function authorityOver(
    ctx: RequestContext,
    profileId: string,
  ): Promise<CompletionAuthority | null> {
    const res = await ctx.db((db) =>
      db.query<{ owner_user_id: string }>('SELECT owner_user_id FROM profile WHERE id = $1', [
        profileId,
      ]),
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    if (row.owner_user_id === ctx.principal.userId) return { isOwner: true, capabilities: [] };

    const grants = await ctx.db((db) =>
      db.query<{ capabilities: string[] }>(
        `SELECT capabilities FROM caregiver_grant
          WHERE profile_id = $1 AND grantee_user_id = $2 AND status = 'ACTIVE'`,
        [profileId, ctx.principal.userId],
      ),
    );
    // Union across grants, matching what has_capability does in the database.
    const capabilities = grants.rows.flatMap((g) => g.capabilities);
    return { isOwner: false, capabilities: capabilities as CompletionAuthority['capabilities'] };
  }

  // -------------------------------------------------------------------------
  // GET /v1/profiles/:profileId/review-tasks
  // -------------------------------------------------------------------------

  app.get('/v1/profiles/:profileId/review-tasks', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = profileParamsSchema.safeParse(request.params);
    if (!params.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid profile id.', { reason_code: 'params_schema' }),
        ctx.correlationId,
      );
    }

    // Reachability is decided by row-level security on review_task itself (VIEW_CARE). Asking
    // first means an unrelated caller never triggers a privileged derivation pass over a profile
    // they have nothing to do with.
    const reachable = await ctx.db(async (db) => {
      const res = await db.query('SELECT 1 FROM profile WHERE id = $1', [params.data.profileId]);
      return res.rows.length > 0;
    });
    if (!reachable) {
      return fail(
        reply,
        domainError('PERMISSION_DENIED', 'Profile not reachable.'),
        ctx.correlationId,
      );
    }

    await refreshInbox(ctx, params.data.profileId);

    // The listing joins each task to its subject through the RLS-scoped connection. A subject the
    // caller may not read comes back null, and the task is dropped - so the inbox never names a
    // record the caller has no grant on.
    const rows = await ctx.db(async (db) => {
      const res = await db.query<VisibleTaskRow>(
        `SELECT t.id, t.profile_id, t.task_kind, t.subject_kind, t.subject_id, t.state,
                t.created_at,
                COALESCE(
                  i.display_name,
                  CASE WHEN g.id IS NOT NULL THEN 'caregiver access' END,
                  CASE WHEN ap.id IS NOT NULL THEN 'safety item' END,
                  CASE WHEN r.id IS NOT NULL THEN 'refill estimate' END
                ) AS subject_label
           FROM review_task t
           LEFT JOIN owned_item i
                  ON t.subject_kind = 'owned_item' AND i.id = t.subject_id
           LEFT JOIN caregiver_grant g
                  ON t.subject_kind = 'caregiver_grant' AND g.id = t.subject_id
           LEFT JOIN alert_publication ap
                  ON t.subject_kind = 'alert_publication' AND ap.id = t.subject_id
           LEFT JOIN refill_estimate r
                  ON t.subject_kind = 'refill_estimate' AND r.id = t.subject_id
          WHERE t.profile_id = $1 AND t.state = 'OPEN'
          ORDER BY t.created_at ASC`,
        [params.data.profileId],
      );
      return res.rows;
    });

    const visible = rows.filter((row) => row.subject_label !== null);

    return reply.status(200).send({
      profileId: params.data.profileId,
      // Note what this response does not contain: no urgency, no evidence level, no severity and
      // no count of "critical" anything. Exit criterion 1 is a property of the payload, not only
      // of the screen that renders it.
      tasks: visible.map((row) => ({
        taskId: row.id,
        kind: row.task_kind,
        subjectKind: row.subject_kind,
        subjectId: row.subject_id,
        subjectLabel: row.subject_label,
        createdAt: iso(row.created_at),
      })),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/review-tasks/:taskId/complete
  // -------------------------------------------------------------------------

  app.post('/v1/review-tasks/:taskId/complete', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid task id.', { reason_code: 'params_schema' }),
        ctx.correlationId,
      );
    }

    const body = completeBodySchema.safeParse(request.body);
    if (!body.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
        ctx.correlationId,
      );
    }

    // Read the task under row-level security, so a task on a profile the caller cannot see is
    // simply not found rather than refused with a distinguishable error.
    const found = await ctx.db(async (db) => {
      const res = await db.query<TaskRow>(
        `SELECT id, profile_id, task_kind, subject_kind, subject_id, state, created_at
           FROM review_task WHERE id = $1`,
        [params.data.taskId],
      );
      return res.rows[0] ?? null;
    });
    if (found === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such task.'), ctx.correlationId);
    }

    const task: ReviewTask = {
      id: unsafeId<ReviewTaskId>(found.id),
      profileId: unsafeId<ProfileId>(found.profile_id),
      kind: found.task_kind as ReviewTaskKind,
      subjectKind: found.subject_kind as ReviewSubjectKind,
      subjectId: found.subject_id,
      state: found.state as ReviewTaskState,
      createdAt: iso(found.created_at),
    };

    const authority = await authorityOver(ctx, found.profile_id);
    if (authority === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such task.'), ctx.correlationId);
    }

    const decision = evaluateCompletion(task, body.data, authority, ctx.now);
    if (isErr(decision)) return fail(reply, decision.error, ctx.correlationId);
    const plan = decision.value;

    // `14`: caregiver administration needs re-authentication, and renewing a grant is caregiver
    // administration whichever surface it is reached from. Checked after the domain decision so a
    // caller who is not permitted at all is refused on that ground rather than being told to
    // re-authenticate for something they could never do.
    if (task.subjectKind === 'caregiver_grant' && !hasFreshStepUp(ctx)) {
      return fail(
        reply,
        domainError('STEP_UP_REQUIRED', 'Confirm your identity to change caregiver access.'),
        ctx.correlationId,
      );
    }

    const needsPrivilege = PRIVILEGED_SUBJECTS.has(task.subjectKind);

    // The record write comes first and the task closes as a consequence. Doing it the other way
    // round would let a failed record write leave a task marked done - the exact appearance of
    // maintenance without the fact.
    const applied = needsPrivilege
      ? await ctx.privileged('CAREGIVER_GRANT_FINALISATION', (db) =>
          applyAll(db, plan.kind, plan.changes, actorOf(ctx)),
        )
      : await ctx.db((db) => applyAll(db, plan.kind, plan.changes, actorOf(ctx)));

    if (applied === 0) {
      // Nothing was written, so nothing may be closed. This is the RLS layer refusing a write the
      // domain thought was permitted - a disagreement worth surfacing rather than swallowing.
      return fail(
        reply,
        domainError('PERMISSION_DENIED', 'That record could not be updated.'),
        ctx.correlationId,
      );
    }

    const fields = [...new Set(plan.changes.map((c) => c.field))].sort();

    const closed = await ctx.db(async (db) => {
      const res = await db.query(
        `UPDATE review_task
            SET state = $1, completed_at = $2, completed_by_user_id = $3, outcome = $4,
                completion_fields = $5
          WHERE id = $6 AND state = 'OPEN'`,
        [
          plan.resultingState,
          ctx.now,
          ctx.principal.userId,
          plan.outcome,
          fields,
          params.data.taskId,
        ],
      );
      return res.affectedRows ?? 0;
    });

    if (closed === 0) {
      // The record was updated but the task could not be closed - a concurrent completion, or the
      // per-kind UPDATE policy refusing. Reported rather than hidden: the record write stands and
      // the caller needs to know the task did not close.
      return fail(
        reply,
        domainError('VERSION_CONFLICT', 'The record was updated but the task was already closed.'),
        ctx.correlationId,
      );
    }

    await ctx.privileged('AUDIT_WRITE', (db) =>
      db.query(
        `INSERT INTO audit_event
           (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
         VALUES ($1, 'kynviora_service', $2, 'review_task', $3, $4, $5::jsonb)`,
        [
          ctx.principal.userId,
          reviewTaskAuditAction(plan.resultingState),
          params.data.taskId,
          ctx.correlationId,
          JSON.stringify(reviewTaskAuditDetail(plan)),
        ],
      ),
    );

    return reply.status(200).send({
      taskId: params.data.taskId,
      state: plan.resultingState,
      outcome: plan.outcome,
      changedFields: fields,
      serverTime: ctx.now,
    });
  });

  function actorOf(ctx: RequestContext) {
    return { userId: ctx.principal.userId as string, now: ctx.now };
  }

  async function applyAll(
    db: DatabaseConnection,
    kind: ReviewTaskKind,
    changes: readonly RecordChange[],
    actor: { readonly userId: string; readonly now: Instant },
  ): Promise<number> {
    let total = 0;
    for (const change of changes) {
      total += await applyChange(db, kind, change, actor);
    }
    return total;
  }
}
