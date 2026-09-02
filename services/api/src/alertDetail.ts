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
 * source of truth (DEC-010).
 *
 * WHICH INGREDIENT, AND WHICH RECORDED SENSITIVITY
 * Since migration `0018` the assessment names both (`DEV-028`), so this route resolves them rather
 * than deriving them. The distinction is the whole of DEC-097: it looks each one up **by the
 * identity the rule froze**, and never re-intersects the declaration with the profile's facts -
 * that is a different computation over state that may have moved, and it could name a substance
 * the rule did not match on. A confident approved-looking sentence about the wrong ingredient is
 * worse than no sentence, which is what DEC-064 decided for the Lens.
 *
 * Both lookups are LEFT joins under row-level security, which is load-bearing rather than
 * incidental. `allergy_select` requires `VIEW_MEDICINES`, so a caregiver holding `VIEW_SAFETY`
 * alone reads the alert and **not** what the person is allergic to - `03` group H keeps the two
 * apart, and the narrative declines to render rather than the route refusing. An absent lookup is
 * the same honest outcome the route already had before the columns existed.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  domainError,
  instantFrom,
  revalidate,
  type DomainError,
  type Instant,
} from '@kynviora/domain';
import { alertDetailView, type AlertDetailInput } from '@kynviora/presentation';
import type { RequestContext } from './context.js';
import { recordSafetyResolution } from './safetyReceipt.js';

const paramsSchema = z.object({ alertId: z.string().uuid() });

/**
 * Opening from a notification.
 *
 * `notifiedAt` is what the notification claimed, reported by the client that is opening it. It is
 * not trusted as a fact about the world - nothing is decided from it except whether a recorded
 * correction post-dates it, and a client that lied would only ever disarm its own controls.
 */
const detailQuerySchema = z.object({
  notifiedAt: z.string().datetime().optional(),
});

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

  /** `DEV-028`. NULL on every assessment written before migration `0018`, and on every non-match. */
  readonly matched_substance_key: string | null;
  readonly matched_profile_fact_id: string | null;
  readonly profile_fact_versions: string[] | null;
  /** NULL where the catalog does not know the key, or where the fact is hidden from this caller. */
  readonly matched_substance_name: string | null;
  readonly matched_fact_term: string | null;
  readonly matched_fact_version: number | null;

  readonly reported_incorrect: boolean;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function instantOrNull(value: string | null): Instant | null {
  return value === null ? null : instantFrom(value);
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

                -- DEV-028. The identities the rule matched on, and the names they resolve to.
                a.matched_substance_key    AS matched_substance_key,
                a.matched_profile_fact_id  AS matched_profile_fact_id,
                a.profile_fact_versions    AS profile_fact_versions,
                ns.preferred_name          AS matched_substance_name,
                ar.display_term            AS matched_fact_term,
                ar.version                 AS matched_fact_version,

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
           -- DEV-028, both by the identity the assessment froze rather than by re-deriving it.
           -- LEFT for the reason above: allergy_select needs VIEW_MEDICINES, so a caregiver who
           -- may read the alert and not the medicine narrows this to NULL instead of losing the
           -- alert, and the catalog may equally not know a key from an older vocabulary.
           LEFT JOIN normalized_substance ns ON ns.canonical_key = a.matched_substance_key
           LEFT JOIN allergy_record ar       ON ar.id = a.matched_profile_fact_id
          WHERE ap.id = $1`,
        [alertId],
      ),
    );
    return result.rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // GET /v1/alerts/:alertId
  // -------------------------------------------------------------------------

  /**
   * When the assessment behind this alert was last corrected, if it ever was.
   *
   * Under row-level security, so a correction this caller may not read does not disarm their
   * controls with an explanation they cannot see. `correction_read` scopes it to the profile.
   */
  async function lastCorrectedAt(
    ctx: RequestContext,
    assessmentId: string,
  ): Promise<string | null> {
    const result = await ctx.db((db) =>
      db.query<{ corrected_at: Date | string }>(
        `SELECT corrected_at
           FROM assessment_correction
          WHERE original_assessment_id = $1 OR corrected_assessment_id = $1
          ORDER BY corrected_at DESC
          LIMIT 1`,
        [assessmentId],
      ),
    );
    const row = result.rows[0];
    return row === undefined ? null : isoOrNull(row.corrected_at);
  }

  app.get<{ Params: { alertId: string } }>('/v1/alerts/:alertId', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = paramsSchema.safeParse(request.params);
    // A malformed identifier answers exactly as an unknown one does, so a prober cannot learn
    // which of their guesses were well-formed.
    if (!params.success) return fail(reply, noSuchAlert, ctx.correlationId);

    const query = detailQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid query.', { reason_code: 'query_schema' }),
        ctx.correlationId,
      );
    }

    const row = await loadDetail(ctx, params.data.alertId);
    // A withdrawn alert and one this caller may not see are the same answer here, and that is
    // deliberate: `alert_publication`'s policy admits PUBLISHED only, so exit criterion 2's
    // withdrawn half is enforced by the row never arriving rather than by a notice. The client
    // opening from a notification reads this as NO_LONGER_VISIBLE, which is all it can honestly
    // conclude and all the server is willing to say (DEC-039).
    if (row === null) return fail(reply, noSuchAlert, ctx.correlationId);

    // `04` Phase 7.5 exit criterion 2: the read that renders the screen performs the
    // revalidation, so a client cannot skip it and still act. It runs on every open, not only on
    // one from a notification - a caller that could omit it would be a caller that could skip it,
    // and `AlertDetailInput` requires the field for the same reason.
    const revalidation = revalidate({
      notifiedAt: query.data.notifiedAt === undefined ? null : instantFrom(query.data.notifiedAt),
      currentState: row.alert_state,
      lastCorrectedAt: instantOrNull(await lastCorrectedAt(ctx, row.assessment_id)),
    });

    if (query.data.notifiedAt !== undefined) {
      await ctx.privileged('NOTIFICATION_REVALIDATION', async (db) => {
        await db.query(
          // What the re-read concluded, and nothing about the medicine. `20` keeps subjects out
          // of operational tables and `15` A6 keeps notification bodies out of durable ones.
          `INSERT INTO notification_revalidation
             (alert_publication_id, opened_by_user_id, notified_at, revalidated_at, outcome)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            row.alert_id,
            ctx.principal.userId,
            query.data.notifiedAt,
            ctx.now,
            revalidation.outcome,
          ],
        );
      });
    }

    const expiresOn = dateOrNull(row.item_expires_on);
    const nowDate = ctx.now.slice(0, 10);

    /**
     * The recorded sensitivity, but only if it still says what the rule matched (`DEV-028`).
     *
     * The identity is frozen; the *words* are not. `display_term` is the person's own account and
     * they may edit it, so quoting today's wording as what the rule matched would be a statement
     * about what happened that is not true. The assessment froze the fact's version alongside its
     * ID, so the comparison is cheap and the failure is the honest one: the template refuses and
     * the alert keeps its listed facts.
     *
     * The substance name is deliberately **not** gated the same way. A canonical key is a fixed
     * identity and a `preferred_name` change is the catalog renaming the same thing, not a person
     * changing what they said - which is why the key is what the assessment stores.
     */
    const factVersions = row.profile_fact_versions ?? [];
    const factUnchanged =
      row.matched_fact_version !== null && factVersions.includes(String(row.matched_fact_version));

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

      // Resolved from what the rule froze, never re-derived; see the module note and DEC-097.
      // `null` either way makes the sensitivity template refuse to render rather than name a
      // substance that may not be the one the rule matched.
      ingredientName: row.matched_substance_name,
      recordedTerm: factUnchanged ? row.matched_fact_term : null,
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
      revalidation,
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

      // A receipt, not a change to the alert or the assessment. `04` Phase 7.6 requires that
      // resolution never erases historical assessment, and the row this writes references both
      // rather than replacing either.
      //
      // Through Phase 7.6's writer rather than an INSERT of its own. `safety_receipt` admits one
      // row per alert (`receipt_publication_idx`), so a household that had already recorded a
      // resolution here used to meet the unique index and get a 500 - on the screen whose whole
      // subject is that Kynviora keeps what happened. It is idempotent for the same reason it was
      // before: there is one destination state and a repeat is the same request.
      const outcome = await recordSafetyResolution(
        ctx,
        { alertId: row.alert_id, assessmentId: row.assessment_id, profileId: row.profile_id },
        REPORT_INCORRECT,
        body.data.note ?? null,
        'alert.reported_incorrect',
      );

      if (outcome.alreadyRecorded) {
        return reply
          .status(200)
          .send({ recorded: true, alreadyReported: true, serverTime: ctx.now });
      }

      return reply
        .status(201)
        .send({ recorded: true, alreadyReported: false, serverTime: ctx.now });
    },
  );
}
