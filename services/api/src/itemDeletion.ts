/**
 * Deleting an item from the shelf (`04` Stage 2, `16` deletion, DEC-117).
 *
 *   DELETE /v1/items/:itemId   - the owner removes a medicine or personal-care product
 *
 * Spec references: `16` (a person may have their data removed; the deletion workflow must
 * enumerate what goes and what is retained), `14` (re-authentication for high-impact actions;
 * least privilege), `13` (server-authoritative authorization, deletion orchestration is a
 * privileged operation, the API is not an oracle), `docs/RETENTION.md`, `DEV-032`, `DEV-057`.
 *
 * DELETION IS NOT ARCHIVING, AND THE DIFFERENCE IS THE POINT
 * `PATCH /v1/items/:itemId` can already move an item to `ARCHIVED`, and `DEV-032` recorded that
 * this was being offered where deletion belonged. They are different requests: archiving is "I am
 * done with this and want to keep the record", deletion is "I want this gone". A product that
 * answers the second with the first has told somebody their data was removed when it is still on
 * the shelf read of anybody they have ever granted access to.
 *
 * WHAT THE REQUEST GUARANTEES BY THE TIME IT ANSWERS
 * Revocation, in full, synchronously (`docs/RETENTION.md` section 1). When this route returns
 * `204` the item is gone from every read - the owner's, every caregiver's, the reminder plan, the
 * assessment reads and the Visit Pack candidate list - because every one of those predicates
 * already carries `deleted_at IS NULL` and the stamp is committed before the response is written.
 * Nothing waits on a job. The purge deadline in the matrix is about bytes, and this route makes no
 * claim about it.
 *
 * WHO MAY, AND WHY IT IS NOT A CAPABILITY
 * The profile **owner**, with **fresh step-up**. No caregiver capability authorizes deletion -
 * not `MANAGE_MEDICINES`, not `MANAGE_SHELF` - and deletion is deliberately not a member of the
 * capability set at all rather than a member nobody grants, because a capability that exists is
 * one a future screen can offer. `14` names deletion alongside export and caregiver administration
 * as a high-impact action for which a merely-valid session is not sufficient.
 *
 * WHY THE WRITE IS PRIVILEGED
 * Not because the route wants a wider hand. `DEV-057`: Postgres applies the SELECT policies to the
 * **new** row of an UPDATE that reads the table, and every read predicate here filters
 * `deleted_at IS NULL` - so the row a deletion produces is one the caller may not see, and the app
 * role is refused for the owner as much as for a stranger. `13` already names "deletion
 * orchestration" among privileged operations for this reason.
 *
 * The privilege is kept as narrow as the act. `kynviora.delete_owned_item` is granted to the
 * service role alone and re-evaluates ownership **in the statement that writes**, so the
 * privileged write cannot be wider than the check that authorised it and there is no window
 * between them. The route establishes authority first anyway, under row-level security, because a
 * caller who cannot see the item must be answered before anything privileged happens at all.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { domainError, type DomainError } from '@kynviora/domain';
import { hasFreshStepUp, type DatabaseConnection, type RequestContext } from './context.js';

export interface ItemDeletionRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
}

const itemParamsSchema = z.object({ itemId: z.string().uuid() });

/**
 * Append the audit event for a deletion.
 *
 * On the caller-supplied connection so it commits with the stamp it describes: an audit row for a
 * deletion that did not happen is worse than no row, and a deletion with no audit row is the one
 * `14` will not accept.
 *
 * `20` forbids audit events becoming copies of health content, so this records the item's ID, its
 * kind and its profile - never the display name, the brand, or anything a person typed. The item
 * kind is here because it is the one field that makes the record usable for an investigation
 * ("were medicines being removed?") without naming a medicine.
 */
async function writeDeletionAudit(
  db: DatabaseConnection,
  input: {
    readonly ctx: RequestContext;
    readonly itemId: string;
    readonly profileId: string;
    readonly itemKind: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_event
       (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
     VALUES ($1, 'kynviora_service', 'item.deleted', 'owned_item', $2, $3, $4::jsonb)`,
    [
      input.ctx.principal.userId,
      input.itemId,
      input.ctx.correlationId,
      JSON.stringify({ profile_id: input.profileId, item_kind: input.itemKind }),
    ],
  );
}

export function registerItemDeletionRoutes(
  app: FastifyInstance,
  deps: ItemDeletionRouteDeps,
): void {
  const { contextFor, fail } = deps;

  app.delete<{ Params: { itemId: string } }>('/v1/items/:itemId', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    // Every refusal that is not step-up answers as this. `13` does not let the API distinguish
    // "not yours" from "no such thing", and a deletion route that did would be the most useful
    // oracle in the system: it would confirm an item ID belongs to somebody.
    const noSuchItem = domainError('NOT_FOUND', 'No such item.');

    // Checked before anything else, including the parameter, for the reason the Visit Pack checks
    // it first: `14` treats a high-impact action without re-authentication as *the* failure
    // whatever else is wrong with the request, and an un-stepped-up session should never reach
    // the database at all.
    if (!hasFreshStepUp(ctx)) {
      return fail(
        reply,
        domainError('STEP_UP_REQUIRED', 'Confirm your identity before deleting this item.'),
        ctx.correlationId,
      );
    }

    const params = itemParamsSchema.safeParse(request.params);
    // A malformed identifier answers exactly as an unknown one does.
    if (!params.success) return fail(reply, noSuchItem, ctx.correlationId);
    const itemId = params.data.itemId;

    // Authority, established under row-level security before anything privileged happens. A
    // caller who cannot see the item is answered here and the service role is never reached.
    //
    // This read does *not* establish ownership - `owned_item_select` admits a caregiver with
    // `VIEW_MEDICINES` - and it is not asked to. It establishes that there is something to talk
    // about; ownership is decided by the database, in the statement that writes.
    const visible = await ctx.db((db) =>
      db.query<{ profile_id: string; item_kind: string }>(
        `SELECT profile_id, item_kind FROM owned_item WHERE id = $1 AND deleted_at IS NULL`,
        [itemId],
      ),
    );
    const item = visible.rows[0];
    if (item === undefined) return fail(reply, noSuchItem, ctx.correlationId);

    const deleted = await ctx.privileged('DATA_DELETION', async (db) => {
      const res = await db.query<{ deleted: boolean }>(
        `SELECT kynviora.delete_owned_item($1, $2) AS deleted`,
        [itemId, ctx.principal.userId],
      );
      const stamped = res.rows[0]?.deleted ?? false;

      // The audit is written only when something was actually deleted, and on this connection so
      // it commits with the stamp. A refused attempt is not an audit event about an item - it is
      // a caregiver being told no, which the response says and which `20` does not want a row for.
      if (stamped) {
        await writeDeletionAudit(db, {
          ctx,
          itemId,
          profileId: item.profile_id,
          itemKind: item.item_kind,
        });
      }
      return stamped;
    });

    // Not stamped means one of two things: this caller does not own the profile, or the item was
    // deleted between the read above and the write. Both are answered as absence, which is true
    // of the second and is the only thing `13` permits for the first.
    if (!deleted) return fail(reply, noSuchItem, ctx.correlationId);

    // `204` rather than a body. There is nothing left to describe, and a body describing what was
    // removed would be the one place in this API that hands back health content after being asked
    // to destroy it.
    return reply.status(204).send();
  });
}
