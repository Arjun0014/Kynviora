/**
 * Medicine Reconciliation routes.
 *
 * Spec references: `04` Phase 8.5, `09` ("Never tell a user to stop/start/split/replace a
 * prescription medicine based solely on Kynviora"), `13` (privileged operations, idempotency),
 * `16` (source attachment), `03` group H (medicines are a separate permission).
 *
 *   POST /v1/reconciliations                          - start one, supplying the current list
 *   GET  /v1/reconciliations/:id                      - the comparison, both sides intact
 *   POST /v1/reconciliations/:id/differences/:diffId  - record how a person settled one
 *   POST /v1/reconciliations/:id/complete             - close it, unresolved differences and all
 *
 * WHAT THIS MODULE DOES NOT DO
 * It does not decide anything. The comparison is a pure function over two lists; the resolution
 * endpoint takes the person's decision and records it; and the only write to a medicine happens
 * when a person explicitly adopted the current value. There is no path from "the lists disagree"
 * to "the shelf changed" that does not pass through a human choice, which is the Phase 8.5 exit
 * criterion expressed as a call graph.
 *
 * The previous list is read from the shelf under row-level security, so a caller can only ever
 * reconcile medicines they may already see. The current list arrives in the request body: it comes
 * from a discharge summary or a printed list the person is holding, and Kynviora has no source for
 * it other than them.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ADOPTABLE_SIDES,
  PROFESSIONALLY_CONFIRMED,
  RECONCILED_FIELDS,
  RECONCILIATION_RESOLUTIONS,
  canComplete,
  diffMedicationLists,
  domainError,
  evaluateResolution,
  isErr,
  reconciliationAuditDetail,
  unsafeId,
  type Difference,
  type DomainError,
  type Instant,
  type MedicationLine,
  type OwnedItemId,
  type ProfileId,
  type ReconciledField,
} from '@kynviora/domain';
import type { DatabaseConnection, RequestContext } from './context.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const lineSchema = z.object({
  matchKey: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  strengthText: z.string().max(120).nullable().default(null),
  dosageForm: z.string().max(120).nullable().default(null),
  // Reproduced verbatim. `04` Phase 4.1 forbids rewriting a prescription instruction, so nothing
  // here trims, normalises or sentence-cases it.
  directionsText: z.string().max(1000).nullable().default(null),
});

const startBodySchema = z.object({
  profileId: z.string().uuid(),
  sourceKind: z.enum(['VISIT', 'DISCHARGE', 'PHARMACY', 'OTHER']).default('OTHER'),
  sourceEvidenceAssetId: z.string().uuid().optional(),
  sourceNote: z.string().max(500).optional(),
  /** The list the person is holding. Kynviora has no other source for it. */
  currentList: z.array(lineSchema).max(200),
});

const resolveBodySchema = z.object({
  resolution: z.enum(RECONCILIATION_RESOLUTIONS),
  adopt: z.enum(ADOPTABLE_SIDES).nullable().default(null),
  confirmedBy: z.string().max(200).nullable().default(null),
  note: z.string().max(1000).nullable().default(null),
});

const idParamsSchema = z.object({ id: z.string().uuid() });
const differenceParamsSchema = z.object({ id: z.string().uuid(), diffId: z.string().uuid() });

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ReconciliationRow {
  readonly id: string;
  readonly profile_id: string;
  readonly state: string;
  readonly source_kind: string;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly unresolved_count: number | null;
}

interface DifferenceRow {
  readonly id: string;
  readonly reconciliation_id: string;
  readonly difference_kind: string;
  readonly match_key: string;
  readonly display_name: string;
  readonly owned_item_id: string | null;
  readonly field_path: string | null;
  readonly previous_value: string | null;
  readonly current_value: string | null;
  readonly resolution: string | null;
  readonly adopted_side: string | null;
  readonly confirmed_by: string | null;
  readonly resolution_note: string | null;
  readonly resolved_at: Date | null;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The shelf column each reconciled field lives in. A closed map, never interpolated from input. */
const COLUMN_FOR_FIELD: Readonly<Record<ReconciledField, string>> = Object.freeze({
  displayName: 'display_name',
  strengthText: 'strength_text',
  dosageForm: 'dosage_form',
  directionsText: 'directions_text',
});

function asReconciledField(value: string | null): ReconciledField | null {
  return value !== null && (RECONCILED_FIELDS as readonly string[]).includes(value)
    ? (value as ReconciledField)
    : null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface ReconciliationRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
}

export function registerReconciliationRoutes(
  app: FastifyInstance,
  deps: ReconciliationRouteDeps,
): void {
  const { contextFor, fail } = deps;

  function badBody(reply: FastifyReply, correlationId: string) {
    return fail(
      reply,
      domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
      correlationId,
    );
  }

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
       VALUES ($1, 'kynviora_service', $2, 'reconciliation', $3, $4, $5::jsonb)`,
      [
        input.ctx.principal.userId,
        input.action,
        input.targetId,
        input.ctx.correlationId,
        JSON.stringify(input.detail),
      ],
    );
  }

  /**
   * The shelf side of the comparison, read under row-level security.
   *
   * Active medicines only. A stopped one is not part of "what you are taking now", and including
   * it would produce a difference on every reconciliation for as long as the record existed.
   */
  async function previousList(
    ctx: RequestContext,
    profileId: string,
  ): Promise<readonly MedicationLine[]> {
    const res = await ctx.db((db) =>
      db.query<{
        id: string;
        display_name: string;
        strength_text: string | null;
        dosage_form: string | null;
        directions_text: string | null;
      }>(
        `SELECT id, display_name, strength_text, dosage_form, directions_text
           FROM owned_item
          WHERE profile_id = $1 AND item_kind = 'MEDICINE' AND lifecycle_state = 'ACTIVE'`,
        [profileId],
      ),
    );
    return res.rows.map((row) => ({
      ownedItemId: unsafeId<OwnedItemId>(row.id),
      // The shelf side keys on the item's own ID, so two packs of the same medicine stay distinct
      // and the caller can name exactly which one a current line corresponds to.
      matchKey: row.id,
      displayName: row.display_name,
      strengthText: row.strength_text,
      dosageForm: row.dosage_form,
      directionsText: row.directions_text,
    }));
  }

  // -------------------------------------------------------------------------
  // POST /v1/reconciliations
  // -------------------------------------------------------------------------

  app.post('/v1/reconciliations', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const body = startBodySchema.safeParse(request.body);
    if (!body.success) return badBody(reply, ctx.correlationId);

    // Reachability under RLS. A caller with no medicines capability sees no items and would
    // otherwise start an empty reconciliation on a profile they cannot read.
    const reachable = await ctx.db(async (db) => {
      const res = await db.query(
        `SELECT 1 FROM profile WHERE id = $1 AND kynviora.has_capability(id, 'MANAGE_MEDICINES')`,
        [body.data.profileId],
      );
      return res.rows.length > 0;
    });
    if (!reachable) {
      return fail(
        reply,
        domainError('PERMISSION_DENIED', 'Profile not reachable.'),
        ctx.correlationId,
      );
    }

    const previous = await previousList(ctx, body.data.profileId);
    const current: readonly MedicationLine[] = body.data.currentList.map((line) => ({
      ownedItemId: null,
      matchKey: line.matchKey,
      displayName: line.displayName,
      strengthText: line.strengthText,
      dosageForm: line.dosageForm,
      directionsText: line.directionsText,
    }));

    const differences = diffMedicationLists(previous, current);

    const created = await ctx.privileged('RECONCILIATION', async (db) => {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO reconciliation
           (profile_id, started_by_user_id, state, source_kind, source_evidence_asset_id,
            source_note, started_at, client_operation_id)
         VALUES ($1, $2, 'OPEN', $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          body.data.profileId,
          ctx.principal.userId,
          body.data.sourceKind,
          body.data.sourceEvidenceAssetId ?? null,
          body.data.sourceNote ?? null,
          ctx.now,
          ctx.operationId ?? null,
        ],
      );
      const id = inserted.rows[0]?.id ?? null;
      if (id === null) return null;

      for (const difference of differences) {
        await insertDifference(db, id, difference);
      }

      await writeAudit(db, {
        ctx,
        action: 'reconciliation.started',
        targetId: id,
        detail: {
          source_kind: body.data.sourceKind,
          previous_count: previous.length,
          current_count: current.length,
          difference_count: differences.filter((d) => d.kind !== 'MATCHES').length,
        },
      });
      return id;
    });

    if (created === null) {
      return fail(reply, domainError('INTERNAL', 'Could not start.'), ctx.correlationId);
    }

    return reply.status(201).send({
      reconciliationId: created,
      profileId: body.data.profileId,
      serverTime: ctx.now,
    });
  });

  /**
   * One row per difference, and one row per differing *field*.
   *
   * A medicine whose strength and directions both differ produces two rows, because they are two
   * separate questions with potentially different answers - a pharmacist might confirm the new
   * strength and the old directions. Collapsing them into one row would force a single decision
   * onto two facts, which is a quiet way of deciding for the user.
   */
  async function insertDifference(
    db: DatabaseConnection,
    reconciliationId: string,
    difference: Difference,
  ): Promise<void> {
    if (difference.kind !== 'FIELD_DIFFERS') {
      await db.query(
        `INSERT INTO reconciliation_difference
           (reconciliation_id, difference_kind, match_key, display_name, owned_item_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          reconciliationId,
          difference.kind,
          difference.matchKey,
          difference.displayName,
          difference.ownedItemId,
        ],
      );
      return;
    }

    for (const field of difference.fields) {
      await db.query(
        `INSERT INTO reconciliation_difference
           (reconciliation_id, difference_kind, match_key, display_name, owned_item_id,
            field_path, previous_value, current_value)
         VALUES ($1, 'FIELD_DIFFERS', $2, $3, $4, $5, $6, $7)`,
        [
          reconciliationId,
          difference.matchKey,
          difference.displayName,
          difference.ownedItemId,
          field.field,
          field.previousValue,
          field.currentValue,
        ],
      );
    }
  }

  // -------------------------------------------------------------------------
  // GET /v1/reconciliations/:id
  // -------------------------------------------------------------------------

  app.get('/v1/reconciliations/:id', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return badBody(reply, ctx.correlationId);

    const found = await ctx.db(async (db) => {
      const res = await db.query<ReconciliationRow>(
        `SELECT id, profile_id, state, source_kind, started_at, completed_at, unresolved_count
           FROM reconciliation WHERE id = $1`,
        [params.data.id],
      );
      return res.rows[0] ?? null;
    });
    if (found === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such reconciliation.'), ctx.correlationId);
    }

    const rows = await ctx.db(async (db) => {
      const res = await db.query<DifferenceRow>(
        `SELECT id, reconciliation_id, difference_kind, match_key, display_name, owned_item_id,
                field_path, previous_value, current_value, resolution, adopted_side, confirmed_by,
                resolution_note, resolved_at
           FROM reconciliation_difference
          WHERE reconciliation_id = $1
          ORDER BY created_at, id`,
        [params.data.id],
      );
      return res.rows;
    });

    return reply.status(200).send({
      reconciliationId: found.id,
      profileId: found.profile_id,
      state: found.state,
      sourceKind: found.source_kind,
      startedAt: found.started_at.toISOString(),
      completedAt: iso(found.completed_at),
      unresolvedCount: found.unresolved_count,
      // Both values on every row, and no field naming a preferred one. The response shape is the
      // exit criterion: a client has nothing to render as "the right answer".
      differences: rows.map((row) => ({
        differenceId: row.id,
        kind: row.difference_kind,
        displayName: row.display_name,
        ownedItemId: row.owned_item_id,
        field: row.field_path,
        previousValue: row.previous_value,
        currentValue: row.current_value,
        resolution: row.resolution,
        adoptedSide: row.adopted_side,
        confirmedBy: row.confirmed_by,
        note: row.resolution_note,
        resolvedAt: iso(row.resolved_at),
      })),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/reconciliations/:id/differences/:diffId
  // -------------------------------------------------------------------------

  app.post('/v1/reconciliations/:id/differences/:diffId', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = differenceParamsSchema.safeParse(request.params);
    if (!params.success) return badBody(reply, ctx.correlationId);

    const body = resolveBodySchema.safeParse(request.body);
    if (!body.success) return badBody(reply, ctx.correlationId);

    const row = await ctx.db(async (db) => {
      const res = await db.query<DifferenceRow & { state: string; profile_id: string }>(
        `SELECT d.id, d.reconciliation_id, d.difference_kind, d.match_key, d.display_name,
                d.owned_item_id, d.field_path, d.previous_value, d.current_value, d.resolution,
                d.adopted_side, d.confirmed_by, d.resolution_note, d.resolved_at,
                r.state, r.profile_id
           FROM reconciliation_difference d
           JOIN reconciliation r ON r.id = d.reconciliation_id
          WHERE d.id = $1 AND d.reconciliation_id = $2`,
        [params.data.diffId, params.data.id],
      );
      return res.rows[0] ?? null;
    });
    if (row === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such difference.'), ctx.correlationId);
    }
    if (row.state !== 'OPEN') {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'This reconciliation is closed.', {
          reason_code: 'reconciliation_closed',
        }),
        ctx.correlationId,
      );
    }

    // Resolving writes to a medicine, so it takes the management capability, not the read one.
    const mayManage = await ctx.db(async (db) => {
      const res = await db.query(
        `SELECT 1 FROM profile WHERE id = $1 AND kynviora.has_capability(id, 'MANAGE_MEDICINES')`,
        [row.profile_id],
      );
      return res.rows.length > 0;
    });
    if (!mayManage) {
      return fail(
        reply,
        domainError('PERMISSION_DENIED', 'You cannot change medicines for this person.'),
        ctx.correlationId,
      );
    }

    const field = asReconciledField(row.field_path);
    const difference: Difference = {
      kind: row.difference_kind as Difference['kind'],
      matchKey: row.match_key,
      displayName: row.display_name,
      ownedItemId: row.owned_item_id === null ? null : unsafeId<OwnedItemId>(row.owned_item_id),
      fields:
        field === null
          ? []
          : [{ field, previousValue: row.previous_value, currentValue: row.current_value }],
    };

    const decision = evaluateResolution(difference, body.data, {
      userId: ctx.principal.userId,
      now: ctx.now,
    });
    if (isErr(decision)) return fail(reply, decision.error, ctx.correlationId);
    const plan = decision.value;

    // The one place a reconciliation touches a medicine, and only because a person said to. The
    // write goes through the RLS-scoped connection, so it can never write what the caller could
    // not have written directly on the medicine screen.
    if (plan.adopt === 'CURRENT' && field !== null && row.owned_item_id !== null) {
      const column = COLUMN_FOR_FIELD[field];
      const updated = await ctx.db(async (db) => {
        const res = await db.query(`UPDATE owned_item SET ${column} = $1 WHERE id = $2`, [
          row.current_value,
          row.owned_item_id,
        ]);
        return res.affectedRows ?? 0;
      });
      if (updated === 0) {
        return fail(
          reply,
          domainError('PERMISSION_DENIED', 'That medicine could not be updated.'),
          ctx.correlationId,
        );
      }
    }

    await ctx.privileged('RECONCILIATION', async (db) => {
      await db.query(
        `UPDATE reconciliation_difference
            SET resolution = $1, adopted_side = $2, confirmed_by = $3, resolution_note = $4,
                resolved_at = $5, resolved_by_user_id = $6
          WHERE id = $7`,
        [
          plan.resolution,
          body.data.adopt,
          plan.confirmedBy,
          plan.note,
          plan.resolvedAt,
          plan.resolvedByUserId,
          params.data.diffId,
        ],
      );
      await writeAudit(db, {
        ctx,
        action: 'reconciliation.difference.resolved',
        targetId: params.data.id,
        detail: reconciliationAuditDetail({
          resolution: plan.resolution,
          fields: field === null ? [] : [field],
          professionallyConfirmed: PROFESSIONALLY_CONFIRMED.includes(plan.resolution),
        }),
      });
    });

    return reply.status(200).send({
      differenceId: params.data.diffId,
      resolution: plan.resolution,
      adoptedSide: body.data.adopt,
      shelfUpdated: plan.adopt === 'CURRENT',
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/reconciliations/:id/complete
  // -------------------------------------------------------------------------

  app.post('/v1/reconciliations/:id/complete', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return badBody(reply, ctx.correlationId);

    const found = await ctx.db(async (db) => {
      const res = await db.query<ReconciliationRow>(
        `SELECT id, profile_id, state, source_kind, started_at, completed_at, unresolved_count
           FROM reconciliation WHERE id = $1`,
        [params.data.id],
      );
      return res.rows[0] ?? null;
    });
    if (found === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such reconciliation.'), ctx.correlationId);
    }
    if (found.state !== 'OPEN') {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'This reconciliation is already closed.', {
          reason_code: 'reconciliation_closed',
        }),
        ctx.correlationId,
      );
    }

    const rows = await ctx.db(async (db) => {
      const res = await db.query<{ difference_kind: string; resolution: string | null }>(
        'SELECT difference_kind, resolution FROM reconciliation_difference WHERE reconciliation_id = $1',
        [params.data.id],
      );
      return res.rows;
    });

    const decision = canComplete(
      rows.map((row) => ({
        kind: row.difference_kind as Difference['kind'],
        resolution: row.resolution,
      })),
    );
    if (isErr(decision)) return fail(reply, decision.error, ctx.correlationId);

    await ctx.privileged('RECONCILIATION', async (db) => {
      await db.query(
        `UPDATE reconciliation
            SET state = 'COMPLETED', completed_at = $1, unresolved_count = $2
          WHERE id = $3 AND state = 'OPEN'`,
        [ctx.now, decision.value.unresolvedCount, params.data.id],
      );
      await writeAudit(db, {
        ctx,
        action: 'reconciliation.completed',
        targetId: params.data.id,
        detail: { unresolved_count: decision.value.unresolvedCount },
      });
    });

    return reply.status(200).send({
      reconciliationId: params.data.id,
      state: 'COMPLETED',
      // Reported plainly. `04` Phase 8.5 lists unresolved differences as expected output, so
      // finishing with open questions is a normal outcome and the response says how many.
      unresolvedCount: decision.value.unresolvedCount,
      serverTime: ctx.now,
    });
  });
}

/** Re-exported so the server can state the clock type without a second import. */
export type { Instant, ProfileId };
