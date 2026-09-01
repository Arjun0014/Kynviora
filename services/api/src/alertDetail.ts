/**
 * One alert, assembled.
 *
 * Spec references: `04` Phase 7.3 (alert detail and explainability), `09` (evidence model,
 * coverage statements), `13` (a profile ID narrows a result set and never grants access),
 * `19` (a withdrawn alert must stop being actionable immediately), `25` (source licensing),
 * `DEV-028`.
 *
 *   GET  /v1/alerts/:alertId                  - everything one alert rests on
 *   POST /v1/alerts/:alertId/report-incorrect - the correction action Phase 7.3 requires
 *
 * WHY THE READ IS ONE QUERY UNDER ROW-LEVEL SECURITY
 * Every table it touches carries its own policy, and `alert_publication`'s is the one that
 * matters: it admits `state = 'PUBLISHED'` only, and only to a caller holding `VIEW_SAFETY` on
 * the profile. So a withdrawn alert is **not found** here rather than found-and-labelled, which
 * is `19`'s release-blocking defect class handled by the policy rather than by this handler
 * remembering to filter. A caller without the capability gets the same not-found, so this route
 * is not an oracle for which alerts exist.
 *
 * WHAT THIS ROUTE WILL NOT DO
 * Re-evaluate anything. The assessment froze the confidence, the evidence level, the urgency and
 * the template identifier at evaluation time precisely so a later rule revision cannot change
 * what somebody was told, and a detail screen that recomputed any of them would be a second
 * source of truth (DEC-010). It also will not derive *which* ingredient or which recorded
 * sensitivity produced an ingredient match: the assessment does not record them, and joining the
 * two lists afresh would risk naming a substance the rule did not match on - which is the failure
 * DEC-064 refuses for the Lens. `DEV-028` records the gap and the fix.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { domainError, type DomainError } from '@kynviora/domain';
import { alertDetailView, type AlertDetailInput } from '@kynviora/presentation';
import type { RequestContext } from './context.js';

const paramsSchema = z.object({ alertId: z.string().uuid() });

/**
 * What a person may say about an alert from the detail screen.
 *
 * One member. Phase 7.6 owns the rest of `safety_receipt`'s vocabulary, and accepting `REVIEWED`
 * or `RETURNED_OR_DISPOSED` here would be that phase built early through a route whose name says
 * something else.
 */
const REPORT_INCORRECT = 'REPORTED_INCORRECT_MATCH';

const reportBodySchema = z.object({
  /** Optional free text. Stored, and never shown to a caregiver (DEC-026's reasoning). */
  note: z.string().max(1000).optional(),
});

interface DetailRow {
  readonly alert_id: string;
  readonly alert_state: string;
  readonly published_at: Date | string;
  readonly withdrawn_at: Date | string | null;
  readonly withdrawn_reason: string | null;

  readonly assessment_id: string;
  readonly profile_id: string;
  /** NULL where row-level security hid the profile from this caller, not where it is missing. */
  readonly person_name: string | null;
  readonly item_name: string | null;
  readonly item_brand: string | null;
  readonly owned_item_id: string;

  readonly match_confidence: string;
  readonly evidence_level: string;
  readonly urgency: string;
  readonly reasons: string[];
  readonly explanation_template_id: string;
  readonly evaluated_at: Date | string;

  readonly lot_code: string | null;
  readonly batch_verification: string | null;
  readonly formulation_verification: string | null;
  readonly item_expires_on: Date | string | null;

  readonly source_organization: string | null;
  readonly source_name: string | null;
  readonly source_jurisdiction: string | null;
  readonly license_review_state: string | null;
  readonly required_attribution: string | null;
  readonly legal_reference: string | null;
  readonly publication_date: Date | string | null;
  readonly effective_date: Date | string | null;

  readonly reported_incorrect: boolean;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** A `date` column, rendered as the date it is rather than as an instant. */
function dateOrNull(value: Date | string | null | undefined): string | null {
  const iso = isoOrNull(value);
  return iso === null ? null : (iso.slice(0, 10) ?? null);
}

export interface AlertDetailRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
  /** The jurisdictions Kynviora monitors, for the coverage statement `09` requires. */
  readonly monitoredJurisdictions: () => Promise<readonly string[]>;
}

export function registerAlertDetailRoutes(app: FastifyInstance, deps: AlertDetailRouteDeps): void {
  const { contextFor, fail, monitoredJurisdictions } = deps;

  /** The one not-found this route ever produces. Absence and refusal, deliberately identical. */
  const noSuchAlert = domainError('NOT_FOUND', 'No such alert.');

  async function loadDetail(ctx: RequestContext, alertId: string): Promise<DetailRow | null> {
    const result = await ctx.db((db) =>
      db.query<DetailRow>(
        // Every join is filtered by its own policy. `alert_publication` admits PUBLISHED only, so
        // a withdrawn alert produces no row at all - see the module note.
        //
        // `batch_or_lot` and the regulatory tables are LEFT joins: an alert about an expiry rests
        // on neither, and an alert whose regulatory record was superseded to NULL is still worth
        // reading. Requiring them would turn "Kynviora knows less than usual" into "not found".
        `SELECT ap.id                      AS alert_id,
                ap.state                   AS alert_state,
                ap.published_at            AS published_at,
                ap.withdrawn_at            AS withdrawn_at,
                ap.withdrawn_reason        AS withdrawn_reason,

                a.id                       AS assessment_id,
                a.profile_id               AS profile_id,
                p.display_name             AS person_name,
                i.display_name             AS item_name,
                i.brand                    AS item_brand,
                a.owned_item_id            AS owned_item_id,

                a.match_confidence         AS match_confidence,
                a.evidence_level           AS evidence_level,
                a.urgency                  AS urgency,
                a.reasons                  AS reasons,
                a.explanation_template_id  AS explanation_template_id,
                a.evaluated_at             AS evaluated_at,

                b.lot_code                 AS lot_code,
                i.batch_verification       AS batch_verification,
                i.formulation_verification AS formulation_verification,
                i.expires_on               AS item_expires_on,

                s.organization             AS source_organization,
                s.source_name              AS source_name,
                s.jurisdiction             AS source_jurisdiction,
                s.license_review_state     AS license_review_state,
                s.required_attribution     AS required_attribution,
                rr.legal_reference         AS legal_reference,
                rr.publication_date        AS publication_date,
                rr.effective_date          AS effective_date,

                EXISTS (
                  SELECT 1 FROM safety_receipt sr
                   WHERE sr.alert_publication_id = ap.id
                     AND sr.resolution = 'REPORTED_INCORRECT_MATCH'
                ) AS reported_incorrect
           FROM alert_publication ap
           JOIN profile_assessment a ON a.id = ap.assessment_id
           -- LEFT, both of them, and that is the interesting part. Spec 03 group H keeps safety
           -- access separate from shelf access, so a caregiver holding VIEW_SAFETY and not
           -- VIEW_MEDICINES can see this alert and not the medicine it is about. An inner join
           -- would turn that into a not-found - an alert they are entitled to read, reported as
           -- though it did not exist. Row-level security narrows these to NULL instead, and the
           -- view reports the withholding rather than showing a blank (DEC-026's shape).
           LEFT JOIN profile p       ON p.id = ap.profile_id
           LEFT JOIN owned_item i    ON i.id = a.owned_item_id
           LEFT JOIN batch_or_lot b  ON b.id = i.batch_id
           LEFT JOIN regulatory_rule_version rr ON rr.id = a.regulatory_rule_version_id
           LEFT JOIN source_registry_entry s    ON s.id = rr.source_registry_entry_id
          WHERE ap.id = $1`,
        [alertId],
      ),
    );
    return result.rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // GET /v1/alerts/:alertId
  // -------------------------------------------------------------------------

  app.get<{ Params: { alertId: string } }>('/v1/alerts/:alertId', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = paramsSchema.safeParse(request.params);
    // A malformed identifier answers exactly as an unknown one does, so a prober cannot learn
    // which of their guesses were well-formed.
    if (!params.success) return fail(reply, noSuchAlert, ctx.correlationId);

    const row = await loadDetail(ctx, params.data.alertId);
    if (row === null) return fail(reply, noSuchAlert, ctx.correlationId);

    const expiresOn = dateOrNull(row.item_expires_on);
    const nowDate = ctx.now.slice(0, 10);

    const input: AlertDetailInput = {
      alertPublicationId: row.alert_id,
      state: row.alert_state,
      publishedAt: isoOrNull(row.published_at) ?? ctx.now,
      withdrawnAt: isoOrNull(row.withdrawn_at),
      withdrawnReason: row.withdrawn_reason,

      personName: row.person_name,
      itemName: row.item_name,
      itemBrand: row.item_brand,

      matchConfidence: row.match_confidence,
      evidenceLevel: row.evidence_level,
      urgency: row.urgency,
      reasons: row.reasons,
      explanationTemplateId: row.explanation_template_id,
      evaluatedAt: isoOrNull(row.evaluated_at) ?? ctx.now,

      lotCode: row.lot_code,
      // `18` keeps the three verification axes apart, and this is the batch one. A lot code on a
      // pack nobody confirmed is something a person typed, and the detail says which.
      lotFromLabel: row.batch_verification === 'CONFIRMED',
      expiresOn,
      hasExpired: expiresOn !== null && expiresOn <= nowDate,

      // Not derivable from the assessment; see the module note and `DEV-028`. Passing `null`
      // makes the sensitivity template refuse to render rather than name a substance that may
      // not be the one the rule matched.
      ingredientName: null,
      recordedTerm: null,
      formulationConfirmedFromLabel: row.formulation_verification === 'CONFIRMED',

      source: {
        organization: row.source_organization,
        sourceName: row.source_name,
        jurisdiction: row.source_jurisdiction,
        legalReference: row.legal_reference,
        publicationDate: dateOrNull(row.publication_date),
        effectiveDate: dateOrNull(row.effective_date),
        licenseReviewState: row.license_review_state,
        requiredAttribution: row.required_attribution,
      },

      monitoredJurisdictions: await monitoredJurisdictions(),
      alreadyReportedIncorrect: row.reported_incorrect,
    };

    // The view is built server-side and sent whole. The alternative - sending the row and letting
    // each client compose the message - would put the approved wording, the withheld reference
    // and the known-versus-inferred labelling in every client that ever exists, and `11` puts
    // safety composition on the server for exactly that reason.
    return reply.status(200).send({
      ...alertDetailView(input),
      profileId: row.profile_id,
      ownedItemId: row.owned_item_id,
      publishedAt: input.publishedAt,
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/alerts/:alertId/report-incorrect
  // -------------------------------------------------------------------------

  app.post<{ Params: { alertId: string } }>(
    '/v1/alerts/:alertId/report-incorrect',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return fail(reply, noSuchAlert, ctx.correlationId);

      const body = reportBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
          ctx.correlationId,
        );
      }

      // Read under RLS first. The write goes through the service role, so this read is the
      // authorization: a caller who cannot see the alert cannot report on it, and gets the same
      // not-found they would get for one that does not exist.
      const row = await loadDetail(ctx, params.data.alertId);
      if (row === null) return fail(reply, noSuchAlert, ctx.correlationId);

      if (row.reported_incorrect) {
        // Idempotent by nature rather than by key: there is one destination state and a repeat is
        // the same request. Saying so beats a second row that would double-count the feedback.
        return reply
          .status(200)
          .send({ recorded: true, alreadyReported: true, serverTime: ctx.now });
      }

      await ctx.privileged('SAFETY_RECEIPT', async (db) => {
        await db.query(
          // A receipt, not a change to the alert or the assessment. `04` Phase 7.6 requires that
          // resolution never erases historical assessment, and the row this writes references
          // both rather than replacing either.
          `INSERT INTO safety_receipt
             (profile_id, alert_publication_id, assessment_id, resolution, resolution_note,
              resolved_at, resolved_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            row.profile_id,
            row.alert_id,
            row.assessment_id,
            REPORT_INCORRECT,
            body.data.note ?? null,
            ctx.now,
            ctx.principal.userId,
          ],
        );

        await db.query(
          `INSERT INTO audit_event
             (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
           VALUES ($1, 'kynviora_app', 'alert.reported_incorrect', 'alert_publication', $2, $3,
                   $4::jsonb)`,
          [
            ctx.principal.userId,
            row.alert_id,
            ctx.correlationId,
            // No note text in the audit detail. `14` forbids sensitive content in a log and a
            // free-text note about somebody's medicine is exactly that.
            JSON.stringify({ note_recorded: body.data.note !== undefined }),
          ],
        );
      });

      return reply
        .status(201)
        .send({ recorded: true, alreadyReported: false, serverTime: ctx.now });
    },
  );
}
