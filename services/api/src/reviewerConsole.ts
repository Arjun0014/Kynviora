/**
 * Reviewer console routes.
 *
 * Spec references: `04` Phase 6.6, `10` (separation of duties, emergency controls, governance
 * audit artifacts), `13` (reviewer console backend: least privilege, step-up for high-impact
 * publish/withdraw, immutable audit, no shared accounts), `14` (reviewer/admin security),
 * `15` (reviewer compromise creates false safety publications).
 *
 *   POST /v1/reviewer/requests                  - ask for a publication or a withdrawal
 *   GET  /v1/reviewer/queue                     - what is waiting, and how far along each is
 *   GET  /v1/reviewer/requests/:id              - one request, its approvals and its tally
 *   POST /v1/reviewer/requests/:id/decisions    - approve, reject, or return for correction
 *   POST /v1/reviewer/requests/:id/execute      - publish or withdraw. Step-up.
 *   POST /v1/reviewer/publication-block         - the global emergency stop. Step-up.
 *
 * WHY EVERY ROUTE HERE IS PRIVILEGED
 * The reviewer console is staff software. `0012` gives `kynviora_app` no grant on any of these
 * tables, so there is no row-level security to fall back on and authorization has to be
 * established explicitly: the caller must hold an ACTIVE row in `reviewer`. That is `14`'s
 * "admin/reviewer roles are not inferred from client claims" - the role comes from the database,
 * never from the request.
 *
 * WHAT THE ROUTES DO NOT DECIDE
 * The approval count, the separation of duties and the per-jurisdiction scope are decided by
 * `@kynviora/domain` and enforced *again* by triggers in `0012`. This module is the third layer,
 * not the only one: `14` requires that direct database editing of publication state is not a
 * normal workflow, and the way to mean that is for the database to refuse it too. A test
 * publishes a regulatory record that two reviewers approved and watches the Citation Gate refuse
 * it anyway, which is the shape of the whole design.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  APPROVAL_DECISIONS,
  JURISDICTIONS,
  PUBLICATION_ACTIONS,
  PUBLICATION_CHECKLIST,
  PUBLISHABLE_KINDS,
  REVIEWER_ROLES,
  ACTION_URGENCIES,
  EVIDENCE_LEVELS,
  domainError,
  checklistRequired,
  evaluateApproval,
  evaluatePublication,
  isErr,
  publicationAuditDetail,
  requiredApprovals,
  tallyByJurisdiction,
  unsafeId,
  type ActionUrgency,
  type DomainError,
  type EvidenceLevel,
  type Jurisdiction,
  type PublicationAction,
  type PublicationRequest,
  type PublishableKind,
  type RecordedApproval,
  type ReviewerRole,
  type UserId,
} from '@kynviora/domain';
import type { DatabaseConnection, RequestContext } from './context.js';
import { hasFreshStepUp } from './context.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const jurisdictionSchema = z.enum(JURISDICTIONS);

const createBodySchema = z.object({
  subjectKind: z.enum(PUBLISHABLE_KINDS),
  subjectId: z.string().uuid(),
  action: z.enum(PUBLICATION_ACTIONS),
  jurisdictions: z.array(jurisdictionSchema).min(1).max(JURISDICTIONS.length),
  maxUrgency: z.enum(ACTION_URGENCIES).optional(),
  evidenceLevel: z.enum(EVIDENCE_LEVELS).optional(),
  withdrawalReason: z.string().max(1000).optional(),
  note: z.string().max(2000).optional(),
});

const decisionBodySchema = z.object({
  decision: z.enum(APPROVAL_DECISIONS),
  role: z.enum(REVIEWER_ROLES),
  jurisdictions: z.array(jurisdictionSchema).max(JURISDICTIONS.length).default([]),
  // Spec 10's high-severity publication checklist. Empty is a valid body - the domain decides
  // whether this request needs it - so a low-impact approval is not made to tick ten boxes.
  checklist: z.array(z.enum(PUBLICATION_CHECKLIST)).default([]),
  note: z.string().max(2000).nullable().default(null),
});

const blockBodySchema = z.object({
  blocked: z.boolean(),
  reason: z.string().max(500).nullable().default(null),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface RequestRow {
  readonly id: string;
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly action: string;
  readonly jurisdictions: string[];
  readonly max_urgency: string | null;
  readonly evidence_level: string | null;
  readonly required_approvals: number;
  readonly state: string;
  readonly requested_by_user_id: string;
  readonly requested_at: Date;
  readonly withdrawal_reason: string | null;
  readonly decided_at: Date | null;
  readonly decided_by_user_id: string | null;
}

interface ApprovalRow {
  readonly id: string;
  readonly reviewer_user_id: string;
  readonly reviewer_role: string;
  readonly decision: string;
  readonly jurisdictions: string[];
  readonly note: string | null;
  readonly decided_at: Date;
}

function asJurisdictions(values: readonly string[]): readonly Jurisdiction[] {
  return values.filter((v): v is Jurisdiction => (JURISDICTIONS as readonly string[]).includes(v));
}

function toDomainRequest(row: RequestRow): PublicationRequest {
  return {
    subjectKind: row.subject_kind as PublishableKind,
    subjectId: row.subject_id,
    action: row.action as PublicationAction,
    jurisdictions: asJurisdictions(row.jurisdictions),
    impact:
      row.max_urgency === null || row.evidence_level === null
        ? null
        : {
            maxUrgency: row.max_urgency as ActionUrgency,
            evidenceLevel: row.evidence_level as EvidenceLevel,
          },
    requestedByUserId: unsafeId<UserId>(row.requested_by_user_id),
    state: row.state as PublicationRequest['state'],
    withdrawalReason: row.withdrawal_reason,
  };
}

function toRecordedApprovals(rows: readonly ApprovalRow[]): readonly RecordedApproval[] {
  return rows.map((row) => ({
    reviewerUserId: unsafeId<UserId>(row.reviewer_user_id),
    role: row.reviewer_role as ReviewerRole,
    decision: row.decision as RecordedApproval['decision'],
    jurisdictions: asJurisdictions(row.jurisdictions),
  }));
}

/** Everything a target write may need. Each statement takes only the parts it actually uses. */
interface TargetWriteInput {
  readonly reviewerUserId: string;
  readonly at: string;
  readonly approvedJurisdictions: readonly string[];
  readonly subjectId: string;
  readonly withdrawalReason: string | null;
}

interface TargetWrite {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * How each kind of content records that it was published or withdrawn.
 *
 * A closed map of literal statements, never assembled from request input. The four targets have
 * genuinely different shapes - a rule records its approved scope, an alert records a withdrawal
 * reason, a regulatory action records neither - and a single generic UPDATE would have had to
 * interpolate a column name from a request field to cope. Each entry builds its own parameter
 * list for the same reason: a shared list would have to pad every statement to the widest one.
 */
const TARGET_WRITES: Readonly<
  Record<
    PublishableKind,
    Readonly<Record<PublicationAction, (input: TargetWriteInput) => TargetWrite>>
  >
> = Object.freeze({
  assessment_rule_version: {
    // The approved scope is written here and nowhere else. A safety rule has no jurisdiction of
    // its own, so without this it would run everywhere the moment it was published.
    PUBLISH: (input) => ({
      sql: `UPDATE assessment_rule_version
               SET review_state = 'PUBLISHED', approved_by_reviewer_id = $1,
                   approved_at = $2, approved_jurisdictions = $3
             WHERE id = $4 AND review_state <> 'PUBLISHED'`,
      params: [input.reviewerUserId, input.at, [...input.approvedJurisdictions], input.subjectId],
    }),
    WITHDRAW: (input) => ({
      // Disabled as well as withdrawn: a rule left enabled would keep evaluating after the
      // publication that authorised it was taken back.
      sql: `UPDATE assessment_rule_version
               SET review_state = 'WITHDRAWN', enabled = false
             WHERE id = $1 AND review_state = 'PUBLISHED'`,
      params: [input.subjectId],
    }),
  },
  regulatory_rule_version: {
    PUBLISH: (input) => ({
      sql: `UPDATE regulatory_rule_version
               SET review_state = 'PUBLISHED', approved_by_reviewer_id = $1, approved_at = $2
             WHERE id = $3 AND review_state <> 'PUBLISHED'`,
      params: [input.reviewerUserId, input.at, input.subjectId],
    }),
    WITHDRAW: (input) => ({
      sql: `UPDATE regulatory_rule_version
               SET review_state = 'WITHDRAWN'
             WHERE id = $1 AND review_state = 'PUBLISHED'`,
      params: [input.subjectId],
    }),
  },
  product_regulatory_action: {
    PUBLISH: (input) => ({
      sql: `UPDATE product_regulatory_action
               SET review_state = 'PUBLISHED'
             WHERE id = $1 AND review_state <> 'PUBLISHED'`,
      params: [input.subjectId],
    }),
    WITHDRAW: (input) => ({
      sql: `UPDATE product_regulatory_action
               SET review_state = 'WITHDRAWN'
             WHERE id = $1 AND review_state = 'PUBLISHED'`,
      params: [input.subjectId],
    }),
  },
  alert_publication: {
    PUBLISH: (input) => ({
      sql: `UPDATE alert_publication
               SET state = 'PUBLISHED'
             WHERE id = $1 AND state <> 'PUBLISHED'`,
      params: [input.subjectId],
    }),
    WITHDRAW: (input) => ({
      // The withdrawal reason travels onto the alert itself, because that is where an incident
      // review looks - spec 10 retains it as a governance artifact.
      sql: `UPDATE alert_publication
               SET state = 'WITHDRAWN', withdrawn_at = $1, withdrawn_reason = $2
             WHERE id = $3 AND state = 'PUBLISHED'`,
      params: [input.at, input.withdrawalReason, input.subjectId],
    }),
  },
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface ReviewerConsoleRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
}

export function registerReviewerConsoleRoutes(
  app: FastifyInstance,
  deps: ReviewerConsoleRouteDeps,
): void {
  const { contextFor, fail } = deps;

  function badBody(reply: FastifyReply, correlationId: string) {
    return fail(
      reply,
      domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
      correlationId,
    );
  }

  /**
   * The caller's active reviewer roles.
   *
   * Empty means not a reviewer, and every route treats that as `NOT_FOUND` rather than `403`, so
   * the console is not an oracle for whether a given queue item exists.
   */
  async function activeRoles(ctx: RequestContext): Promise<readonly ReviewerRole[]> {
    return ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const res = await db.query<{ role: string }>(
        `SELECT role FROM reviewer WHERE user_id = $1 AND status = 'ACTIVE' ORDER BY role`,
        [ctx.principal.userId],
      );
      return res.rows.map((row) => row.role as ReviewerRole);
    });
  }

  const notAReviewer = domainError('PERMISSION_DENIED', 'Not found.');

  async function writeAudit(
    db: DatabaseConnection,
    input: {
      readonly ctx: RequestContext;
      readonly action: string;
      readonly targetId: string | null;
      readonly detail: Readonly<Record<string, string | number | boolean | null>>;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO audit_event
         (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
       VALUES ($1, 'kynviora_service', $2, 'publication_request', $3, $4, $5::jsonb)`,
      [
        input.ctx.principal.userId,
        input.action,
        input.targetId,
        input.ctx.correlationId,
        JSON.stringify(input.detail),
      ],
    );
  }

  async function loadRequest(ctx: RequestContext, id: string): Promise<RequestRow | null> {
    return ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const res = await db.query<RequestRow>(
        `SELECT id, subject_kind, subject_id, action, jurisdictions, max_urgency, evidence_level,
                required_approvals, state, requested_by_user_id, requested_at, withdrawal_reason,
                decided_at, decided_by_user_id
           FROM publication_request WHERE id = $1`,
        [id],
      );
      return res.rows[0] ?? null;
    });
  }

  async function loadApprovals(ctx: RequestContext, id: string): Promise<readonly ApprovalRow[]> {
    return ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const res = await db.query<ApprovalRow>(
        `SELECT id, reviewer_user_id, reviewer_role, decision, jurisdictions, note, decided_at
           FROM publication_approval WHERE request_id = $1 ORDER BY decided_at, id`,
        [id],
      );
      return res.rows;
    });
  }

  // -------------------------------------------------------------------------
  // POST /v1/reviewer/requests
  // -------------------------------------------------------------------------

  app.post('/v1/reviewer/requests', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const roles = await activeRoles(ctx);
    if (roles.length === 0) return fail(reply, notAReviewer, ctx.correlationId);

    const body = createBodySchema.safeParse(request.body);
    if (!body.success) return badBody(reply, ctx.correlationId);

    const impact =
      body.data.maxUrgency === undefined || body.data.evidenceLevel === undefined
        ? null
        : { maxUrgency: body.data.maxUrgency, evidenceLevel: body.data.evidenceLevel };

    if (body.data.action === 'PUBLISH' && impact === null) {
      // Spec 10 defines which urgency and evidence classes need two people. A request that
      // declared neither could not be classified at all, so it cannot be opened.
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Say what this content is.', {
          reason_code: 'publish_needs_declared_impact',
        }),
        ctx.correlationId,
      );
    }

    // Stored rather than recomputed at execution time, so a later change to the policy cannot
    // retroactively make an already-executed publication look under-reviewed.
    const needed = requiredApprovals(body.data.action, impact);

    const created = await ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const res = await db.query<{ id: string }>(
        `INSERT INTO publication_request
           (subject_kind, subject_id, action, jurisdictions, max_urgency, evidence_level,
            required_approvals, requested_by_user_id, requested_at, requested_note,
            withdrawal_reason, client_operation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          body.data.subjectKind,
          body.data.subjectId,
          body.data.action,
          body.data.jurisdictions,
          impact?.maxUrgency ?? null,
          impact?.evidenceLevel ?? null,
          needed,
          ctx.principal.userId,
          ctx.now,
          body.data.note ?? null,
          body.data.withdrawalReason ?? null,
          ctx.operationId ?? null,
        ],
      );
      const id = res.rows[0]?.id ?? null;
      if (id === null) return null;

      await writeAudit(db, {
        ctx,
        action: 'publication.requested',
        targetId: id,
        detail: publicationAuditDetail({
          action: body.data.action,
          subjectKind: body.data.subjectKind,
          jurisdictions: body.data.jurisdictions,
          requiredApprovals: needed,
          approverCount: 0,
          hadWithdrawalReason: body.data.withdrawalReason !== undefined,
        }),
      });
      return id;
    });

    if (created === null) {
      return fail(reply, domainError('INTERNAL', 'Could not open the request.'), ctx.correlationId);
    }

    return reply.status(201).send({
      requestId: created,
      requiredApprovals: needed,
      jurisdictions: body.data.jurisdictions,
      // Told at the point the request is opened, not discovered at the point of approval.
      checklistRequired: checklistRequired(body.data.action, impact),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/reviewer/queue
  // -------------------------------------------------------------------------

  app.get('/v1/reviewer/queue', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const roles = await activeRoles(ctx);
    if (roles.length === 0) return fail(reply, notAReviewer, ctx.correlationId);

    const rows = await ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const res = await db.query<RequestRow>(
        `SELECT id, subject_kind, subject_id, action, jurisdictions, max_urgency, evidence_level,
                required_approvals, state, requested_by_user_id, requested_at, withdrawal_reason,
                decided_at, decided_by_user_id
           FROM publication_request WHERE state = 'OPEN' ORDER BY requested_at, id`,
      );
      return res.rows;
    });

    const items = [];
    for (const row of rows) {
      const approvals = toRecordedApprovals(await loadApprovals(ctx, row.id));
      const domainRequest = toDomainRequest(row);
      items.push({
        requestId: row.id,
        subjectKind: row.subject_kind,
        subjectId: row.subject_id,
        action: row.action,
        jurisdictions: row.jurisdictions,
        maxUrgency: row.max_urgency,
        evidenceLevel: row.evidence_level,
        requiredApprovals: row.required_approvals,
        requestedAt: row.requested_at.toISOString(),
        // Per jurisdiction, because that is how the gate counts. A single "2 of 2" would hide a
        // scope nobody reviewed.
        tally: tallyByJurisdiction(domainRequest, approvals),
        // What this caller may do about it, so the console does not offer a control that the
        // database will refuse.
        youMayApprove:
          row.requested_by_user_id !== ctx.principal.userId || row.action === 'WITHDRAW',
      });
    }

    return reply.status(200).send({ items, serverTime: ctx.now });
  });

  // -------------------------------------------------------------------------
  // GET /v1/reviewer/requests/:id
  // -------------------------------------------------------------------------

  app.get('/v1/reviewer/requests/:id', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const roles = await activeRoles(ctx);
    if (roles.length === 0) return fail(reply, notAReviewer, ctx.correlationId);

    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return badBody(reply, ctx.correlationId);

    const row = await loadRequest(ctx, params.data.id);
    if (row === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such request.'), ctx.correlationId);
    }

    const approvalRows = await loadApprovals(ctx, row.id);

    return reply.status(200).send({
      requestId: row.id,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      action: row.action,
      jurisdictions: row.jurisdictions,
      maxUrgency: row.max_urgency,
      evidenceLevel: row.evidence_level,
      requiredApprovals: row.required_approvals,
      state: row.state,
      requestedByUserId: row.requested_by_user_id,
      requestedAt: row.requested_at.toISOString(),
      withdrawalReason: row.withdrawal_reason,
      decidedAt: row.decided_at === null ? null : row.decided_at.toISOString(),
      // Who reviewed what, in full. `10`'s governance audit artifacts, and the reason the
      // approval table is append-only.
      approvals: approvalRows.map((approval) => ({
        approvalId: approval.id,
        reviewerUserId: approval.reviewer_user_id,
        role: approval.reviewer_role,
        decision: approval.decision,
        jurisdictions: approval.jurisdictions,
        note: approval.note,
        decidedAt: approval.decided_at.toISOString(),
      })),
      tally: tallyByJurisdiction(toDomainRequest(row), toRecordedApprovals(approvalRows)),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/reviewer/requests/:id/decisions
  // -------------------------------------------------------------------------

  app.post('/v1/reviewer/requests/:id/decisions', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const roles = await activeRoles(ctx);
    if (roles.length === 0) return fail(reply, notAReviewer, ctx.correlationId);

    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return badBody(reply, ctx.correlationId);

    const body = decisionBodySchema.safeParse(request.body);
    if (!body.success) return badBody(reply, ctx.correlationId);

    const row = await loadRequest(ctx, params.data.id);
    if (row === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such request.'), ctx.correlationId);
    }

    // The role must be one this caller actually holds. `14`: the role in the body is a claim, and
    // a claim is not authorization.
    if (!roles.includes(body.data.role)) {
      return fail(
        reply,
        domainError('PERMISSION_DENIED', 'You do not hold that role.', {
          reason_code: 'role_not_held',
        }),
        ctx.correlationId,
      );
    }

    const domainRequest = toDomainRequest(row);
    // An approval with no stated scope reviews the whole request. Stated explicitly rather than
    // left implicit, because the narrower case is the one that matters and it must be deliberate.
    const jurisdictions =
      body.data.jurisdictions.length === 0 ? domainRequest.jurisdictions : body.data.jurisdictions;

    const decision = evaluateApproval(
      domainRequest,
      { userId: ctx.principal.userId, role: body.data.role, status: 'ACTIVE' },
      {
        decision: body.data.decision,
        jurisdictions,
        checklistConfirmed: body.data.checklist,
        note: body.data.note,
      },
      { now: ctx.now },
    );
    if (isErr(decision)) return fail(reply, decision.error, ctx.correlationId);
    const plan = decision.value;

    await ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      await db.query(
        `INSERT INTO publication_approval
           (request_id, reviewer_user_id, reviewer_role, decision, jurisdictions,
            checklist_confirmed, note, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          params.data.id,
          plan.reviewerUserId,
          plan.role,
          plan.decision,
          [...plan.jurisdictions],
          [...plan.checklistConfirmed],
          plan.note,
          plan.decidedAt,
        ],
      );

      // A rejection or a return closes the request there and then. Leaving it open would let a
      // later approval accumulate against an objection nobody withdrew.
      if (plan.decision !== 'APPROVE') {
        await db.query(
          `UPDATE publication_request
              SET state = $1, decided_at = $2, decided_by_user_id = $3
            WHERE id = $4 AND state = 'OPEN'`,
          [
            plan.decision === 'REJECT' ? 'REJECTED' : 'RETURNED_FOR_CORRECTION',
            plan.decidedAt,
            plan.reviewerUserId,
            params.data.id,
          ],
        );
      }

      await writeAudit(db, {
        ctx,
        action:
          plan.decision === 'APPROVE'
            ? 'publication.approved'
            : plan.decision === 'REJECT'
              ? 'publication.rejected'
              : 'publication.returned',
        targetId: params.data.id,
        detail: publicationAuditDetail({
          action: domainRequest.action,
          subjectKind: domainRequest.subjectKind,
          jurisdictions: plan.jurisdictions,
          requiredApprovals: row.required_approvals,
          approverCount: 1,
          hadWithdrawalReason: domainRequest.withdrawalReason !== null,
        }),
      });
    });

    const approvals = toRecordedApprovals(await loadApprovals(ctx, params.data.id));
    return reply.status(200).send({
      requestId: params.data.id,
      decision: plan.decision,
      jurisdictions: plan.jurisdictions,
      tally: tallyByJurisdiction(domainRequest, approvals),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/reviewer/requests/:id/execute
  // -------------------------------------------------------------------------

  app.post('/v1/reviewer/requests/:id/execute', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const roles = await activeRoles(ctx);
    if (roles.length === 0) return fail(reply, notAReviewer, ctx.correlationId);

    // `13` and `14`: step-up for high-impact publish/withdraw. Checked before anything is read,
    // so a stale session cannot even enumerate what it was about to publish.
    if (!hasFreshStepUp(ctx)) {
      return fail(
        reply,
        domainError('STEP_UP_REQUIRED', 'Confirm your identity to publish or withdraw.'),
        ctx.correlationId,
      );
    }

    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return badBody(reply, ctx.correlationId);

    const row = await loadRequest(ctx, params.data.id);
    if (row === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such request.'), ctx.correlationId);
    }

    const blocked = await ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const res = await db.query<{ publication_blocked: boolean }>(
        'SELECT publication_blocked FROM publication_control WHERE singleton',
      );
      return res.rows[0]?.publication_blocked ?? false;
    });

    const domainRequest = toDomainRequest(row);
    const approvals = toRecordedApprovals(await loadApprovals(ctx, params.data.id));

    const decision = evaluatePublication(
      domainRequest,
      approvals,
      { userId: ctx.principal.userId, now: ctx.now, isReviewer: true },
      { publicationBlocked: blocked },
    );
    if (isErr(decision)) return fail(reply, decision.error, ctx.correlationId);
    const outcome = decision.value;

    // The target write comes first. If it is refused - by the Citation Gate, by a rule that is
    // already published, by any constraint the reviewer console knows nothing about - the request
    // stays open rather than recording a publication that did not happen.
    const written = await ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const write = TARGET_WRITES[domainRequest.subjectKind][outcome.action]({
        reviewerUserId: ctx.principal.userId,
        at: ctx.now,
        approvedJurisdictions: outcome.approvedJurisdictions,
        subjectId: domainRequest.subjectId,
        withdrawalReason: domainRequest.withdrawalReason,
      });
      const res = await db.query(write.sql, write.params);
      return res.affectedRows ?? 0;
    });

    if (written === 0) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'The target could not be updated.', {
          reason_code: 'target_not_updated',
        }),
        ctx.correlationId,
      );
    }

    await ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      await db.query(
        `UPDATE publication_request
            SET state = 'EXECUTED', decided_at = $1, decided_by_user_id = $2
          WHERE id = $3 AND state = 'OPEN'`,
        [outcome.executedAt, outcome.executedByUserId, params.data.id],
      );
      await writeAudit(db, {
        ctx,
        action: 'publication.executed',
        targetId: params.data.id,
        detail: publicationAuditDetail({
          action: outcome.action,
          subjectKind: domainRequest.subjectKind,
          jurisdictions: outcome.approvedJurisdictions,
          requiredApprovals: outcome.requiredApprovals,
          approverCount: new Set(approvals.map((a) => a.reviewerUserId)).size,
          hadWithdrawalReason: domainRequest.withdrawalReason !== null,
        }),
      });
    });

    return reply.status(200).send({
      requestId: params.data.id,
      action: outcome.action,
      approvedJurisdictions: outcome.approvedJurisdictions,
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/reviewer/publication-block
  // -------------------------------------------------------------------------

  app.post('/v1/reviewer/publication-block', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const roles = await activeRoles(ctx);
    if (roles.length === 0) return fail(reply, notAReviewer, ctx.correlationId);

    if (!hasFreshStepUp(ctx)) {
      return fail(
        reply,
        domainError('STEP_UP_REQUIRED', 'Confirm your identity to change the publication block.'),
        ctx.correlationId,
      );
    }

    const body = blockBodySchema.safeParse(request.body);
    if (!body.success) return badBody(reply, ctx.correlationId);

    if (body.data.blocked && (body.data.reason === null || body.data.reason.trim().length === 0)) {
      // A block with no reason is indistinguishable from a bug, and it is the first thing an
      // incident review asks about.
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Say why publication is being blocked.', {
          reason_code: 'block_needs_a_reason',
        }),
        ctx.correlationId,
      );
    }

    await ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      await db.query(
        `UPDATE publication_control
            SET publication_blocked = $1,
                blocked_reason = $2,
                blocked_by_user_id = $3,
                blocked_at = $4
          WHERE singleton`,
        [
          body.data.blocked,
          body.data.blocked ? body.data.reason : null,
          body.data.blocked ? ctx.principal.userId : null,
          body.data.blocked ? ctx.now : null,
        ],
      );
      await writeAudit(db, {
        ctx,
        action: body.data.blocked ? 'publication.blocked' : 'publication.unblocked',
        targetId: null,
        detail: { blocked: body.data.blocked, reason_recorded: body.data.reason !== null },
      });
    });

    return reply.status(200).send({
      publicationBlocked: body.data.blocked,
      // Stated in the response so an operator sees it: blocking publication never blocks stopping
      // something. Spec 10 lists both as emergency controls, and one exists to undo the other.
      withdrawalStillAvailable: true,
      serverTime: ctx.now,
    });
  });
}
