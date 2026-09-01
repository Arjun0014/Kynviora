/**
 * The Safety Watch inbox route.
 *
 * Spec references: `04` Phase 7.1 (assessment states and inbox; filters by profile, urgency and
 * status; "no state implies guaranteed safety"), `09` (product states), `23` D-005 and D-014,
 * `13` (a profile ID narrows a result set and never grants access).
 *
 *   GET /v1/profiles/:profileId/safety-inbox   - one line per item on the shelf, with its state
 *
 * WHY IT IS ONE LINE PER ITEM AND NOT ONE PER ALERT
 * `GET /v1/alerts` and `GET /v1/profiles/:id/alerts` both list alerts, which means an item with no
 * alert does not appear at all - and a person reading that screen cannot tell "checked, nothing
 * matched" from "never checked". `23` D-014 is about an absence rendering as approval, and an
 * omission is the quietest way to do it. Every item on the shelf gets a line, and the line says
 * which of the two it is.
 *
 * ROW-LEVEL SECURITY DOES THE AUTHORIZATION, AS EVERYWHERE ELSE
 * The whole query runs on the caller's connection. `owned_item` admits what their grant admits,
 * `alert_publication` excludes withdrawn alerts by policy, and a profile the caller cannot see
 * produces an empty list rather than a refusal. There is no capability check in this file, and
 * there must not be one: `12` puts authorization in the database and `13` says a profile ID in a
 * request is never proof of access.
 *
 * WHAT THE ROUTE DOES NOT RETURN
 * A count per state, a "most urgent first" ordering, or a combined severity. `02` refuses the
 * alarm-optimising product a badge on this screen produces, and `23` D-005 forbids the aggregate.
 * The order is the shelf's own; the filters narrow, they do not rank.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ACTION_URGENCIES,
  PRODUCT_SAFETY_STATES,
  deriveItemSafetyState,
  domainError,
  filterSafetyInbox,
  type ActionUrgency,
  type DomainError,
  type Instant,
  type MatchConfidence,
  type ProductSafetyState,
  type SafetyInboxLine,
} from '@kynviora/domain';
import type { RequestContext } from './context.js';

export interface SafetyInboxRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
}

const paramsSchema = z.object({ profileId: z.string().uuid() });

/**
 * Filters, as a query string.
 *
 * Repeatable rather than comma-separated, because a comma-separated list of enum values is one
 * parsing mistake away from a filter that silently matches nothing - and a safety screen that
 * silently shows an empty list is the failure this whole route exists to prevent.
 */
const querySchema = z.object({
  state: z
    .union([z.enum(PRODUCT_SAFETY_STATES), z.array(z.enum(PRODUCT_SAFETY_STATES))])
    .optional(),
  urgency: z.union([z.enum(ACTION_URGENCIES), z.array(z.enum(ACTION_URGENCIES))]).optional(),
});

function asArray<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as T];
}

/** Trap 45: the driver hands back a `Date`, and a response schema validates before serialising. */
function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

interface InboxRow {
  owned_item_id: string;
  display_name: string;
  alert_publication_id: string | null;
  substances: { key: string; name: string; concentration: string | number | null }[] | null;
  alert_urgency: string | null;
  alert_evidence_level: string | null;
  alert_match_confidence: string | null;
  assessment_match_confidence: string | null;
  assessment_evaluated_at: Date | string | null;
}

export function registerSafetyInboxRoutes(app: FastifyInstance, deps: SafetyInboxRouteDeps): void {
  const { contextFor, fail } = deps;

  app.get<{ Params: { profileId: string } }>(
    '/v1/profiles/:profileId/safety-inbox',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return fail(
          reply,
          domainError('NOT_FOUND', 'No such profile.', { reason_code: 'params_schema' }),
          ctx.correlationId,
        );
      }

      const query = querySchema.safeParse(request.query);
      if (!query.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid query parameters.', {
            reason_code: 'query_schema',
          }),
          ctx.correlationId,
        );
      }

      const result = await ctx.db((db) =>
        db.query<InboxRow>(
          // One row per item, left-joined to its live alert and to its most recent non-shadow
          // assessment. Both joins are `LEFT` on purpose: an item with neither is the case this
          // route exists to make visible.
          //
          // `alert_publication` is filtered to PUBLISHED here as well as by policy. A withdrawn
          // alert leaving an item on ACTION_REQUIRED is the release-blocking defect class in `19`,
          // and it is worth being explicit about rather than inherited.
          `SELECT i.id            AS owned_item_id,
                  i.display_name  AS display_name,
                  -- The substances the Global Regulatory Lens can be asked about for this item.
                  -- Only ingredients whose mapping to a canonical concept is EXACT: an AMBIGUOUS
                  -- one would send the Lens a substance nobody confirmed is in the pack, and the
                  -- Lens answers about whatever it is given (spec 09, DEC-016).
                  (SELECT jsonb_agg(DISTINCT jsonb_build_object(
                            'key', ns.canonical_key,
                            'name', ns.preferred_name,
                            'concentration', fi.disclosed_concentration_percent))
                     FROM formulation_ingredient fi
                     JOIN normalized_substance ns ON ns.id = fi.substance_id
                    WHERE fi.formulation_id = i.formulation_id
                      AND fi.mapping_state = 'EXACT') AS substances,
                  pa_alert.alert_id         AS alert_publication_id,
                  pa_alert.urgency          AS alert_urgency,
                  pa_alert.evidence_level   AS alert_evidence_level,
                  pa_alert.match_confidence AS alert_match_confidence,
                  pa_last.match_confidence  AS assessment_match_confidence,
                  pa_last.evaluated_at      AS assessment_evaluated_at
             FROM owned_item i
             LEFT JOIN LATERAL (
               SELECT ap.id AS alert_id, a.urgency, a.evidence_level, a.match_confidence
                 FROM alert_publication ap
                 JOIN profile_assessment a ON a.id = ap.assessment_id
                WHERE ap.profile_id = i.profile_id
                  AND a.owned_item_id = i.id
                  AND ap.state = 'PUBLISHED'
                ORDER BY ap.published_at DESC
                LIMIT 1
             ) pa_alert ON true
             LEFT JOIN LATERAL (
               SELECT a.match_confidence, a.evaluated_at
                 FROM profile_assessment a
                WHERE a.owned_item_id = i.id
                  AND a.shadow_only = false
                ORDER BY a.evaluated_at DESC
                LIMIT 1
             ) pa_last ON true
            WHERE i.profile_id = $1
              AND i.lifecycle_state <> 'ARCHIVED'
            ORDER BY i.display_name, i.id`,
          [params.data.profileId],
        ),
      );

      const lines: (SafetyInboxLine & {
        readonly substances: readonly {
          readonly substanceKey: string;
          readonly preferredName: string;
          readonly disclosedConcentrationPercent: number | null;
        }[];
      })[] = result.rows.map((row) => {
        const derived = deriveItemSafetyState({
          publishedAlert:
            row.alert_urgency === null
              ? null
              : {
                  urgency: row.alert_urgency as ActionUrgency,
                  evidenceLevel: row.alert_evidence_level ?? 'U',
                  matchConfidence: (row.alert_match_confidence ?? 'NOT_MATCHED') as MatchConfidence,
                },
          latestAssessment:
            row.assessment_match_confidence === null
              ? null
              : {
                  matchConfidence: row.assessment_match_confidence as MatchConfidence,
                  evaluatedAt: (isoOrNull(row.assessment_evaluated_at) ?? ctx.now) as Instant,
                },
        });
        return {
          ownedItemId: row.owned_item_id,
          displayName: row.display_name,
          // The live alert this line came from, so a screen can open its detail. NULL on a line
          // with no live alert, which is most of them - and a null here is what keeps the control
          // absent rather than disabled (DEC-045). A withdrawn alert is filtered out by policy,
          // so this identifier never points at one.
          alertPublicationId: row.alert_publication_id,
          // Empty rather than absent where the item has no confirmed ingredient mapping, which
          // is every item until guided capture lands (`DEV-024`, `BLK-007`). A screen offers no
          // Lens control for an empty list, which is absent rather than disabled (DEC-045).
          substances: (row.substances ?? []).map((substance) => ({
            substanceKey: substance.key,
            preferredName: substance.name,
            disclosedConcentrationPercent:
              substance.concentration === null ? null : Number(substance.concentration),
          })),
          ...derived,
        };
      });

      const filtered = filterSafetyInbox(lines, {
        states: asArray<ProductSafetyState>(query.data.state),
        urgencies: asArray<ActionUrgency>(query.data.urgency),
      });

      return reply.send({
        profileId: params.data.profileId,
        lines: filtered,
        // What the filter narrowed from, so a screen can say "3 of 12 items" without computing a
        // count of anything urgent. `02` refuses the badge; this is the size of the shelf.
        totalItems: lines.length,
        serverTime: ctx.now,
      });
    },
  );
}
