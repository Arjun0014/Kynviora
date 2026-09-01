/**
 * Resolution and the Safety Receipt.
 *
 * Spec references: `04` Phase 7.6 (the resolution vocabulary; a versioned receipt with the alert,
 * the source and rule version, the action, and later corrections; "resolution does not erase
 * historical assessment"; "corrections remain visible and auditable"), `09`, `10`, `13`, `14`.
 *
 *   POST /v1/alerts/:alertId/resolutions - record what a person did
 *   GET  /v1/alerts/:alertId/receipt     - what stands, what was recorded before, what changed
 *
 * EXIT CRITERION 1 IS A SHAPE, NOT A RULE
 * "Resolution does not erase historical assessment" is not enforced by remembering not to write to
 * `profile_assessment`. It is enforced by there being no statement here that touches it: the only
 * writes are into `safety_receipt` and `audit_event`, both of which reference the assessment and
 * modify neither it nor the alert. `0006` helps twice over - `profile_assessment` is append-only
 * and the app role holds no UPDATE on it at all.
 *
 * EXIT CRITERION 2 IS THE READ
 * "Corrections remain visible and auditable" means the receipt shows corrections **beside** what
 * the person recorded, never instead of it, including corrections that arrived afterwards. The
 * read joins `assessment_correction` and reports whether the most recent correction post-dates the
 * resolution that stands, which is the case the criterion exists for: somebody marked an alert
 * reviewed and Kynviora later corrected the assessment behind it.
 *
 * ONE ROW, AND WHERE THE SEQUENCE LIVES
 * `receipt_publication_idx` is UNIQUE on `alert_publication_id`, so there is one receipt per alert
 * and a later resolution replaces the one that stood (DEC-075). The sequence is not lost: every
 * write emits an append-only `audit_event` that no role may update or delete, and the read replays
 * those into the receipt's `history`. So what stands is a row, what happened is a chain nobody can
 * rewrite, and `04`'s word "versioned" is answered by the log rather than by the table.
 *
 * WHY THE FIRST WRITE IS PRIVILEGED AND THE SECOND IS NOT
 * `0006` grants the app role SELECT and UPDATE on `safety_receipt` and deliberately no INSERT - a
 * person may resolve a receipt that exists, not create rows naming whichever alert and assessment
 * they like - so creating one is privileged and changing one goes through `receipt_resolve`, the
 * policy written for exactly that. Either way {@link recordSafetyResolution} reads the alert under
 * row-level security first, so a caller who cannot see it cannot resolve it and gets the same
 * not-found.
 *
 * ONE WRITER, BECAUSE THE UNIQUE INDEX ADMITS ONLY ONE
 * `recordSafetyResolution` is exported and `alertDetail.ts` uses it for report-incorrect. Two
 * routes writing this table with their own INSERT is how a household reaches a 500: the second
 * one to run hits `receipt_publication_idx` and fails, on a screen whose entire subject is that
 * Kynviora keeps what happened.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SAFETY_RESOLUTIONS,
  buildReceipt,
  domainError,
  type DomainError,
  type ReceiptCorrection,
  type ReceiptEntry,
  type ReceiptHistoryEntry,
  type SafetyResolution,
} from '@kynviora/domain';
import {
  LICENSE_STATES_ALLOWING_REFERENCE,
  safetyReceiptView,
  type SafetyReceiptViewInput,
} from '@kynviora/presentation';
import type { RequestContext } from './context.js';

const paramsSchema = z.object({ alertId: z.string().uuid() });

const resolutionBodySchema = z.object({
  resolution: z.enum(SAFETY_RESOLUTIONS),
  /** Optional free text. Stored, kept out of the audit detail, and never shown to a caregiver. */
  note: z.string().max(1000).optional(),
});

/**
 * The audit actions that record a resolution.
 *
 * Two, because the two routes that write one describe different intents and `14` wants a log a
 * person can read. Both carry the same detail shape, so the history replay reads either.
 */
export const RESOLUTION_AUDIT_ACTIONS = [
  'alert.resolution_recorded',
  'alert.reported_incorrect',
] as const;
export type ResolutionAuditAction = (typeof RESOLUTION_AUDIT_ACTIONS)[number];

/**
 * The alert a resolution is recorded against, read under row-level security.
 *
 * Everything a write needs and nothing a read does: the identity columns plus the versions the
 * receipt row references. The full basis for the receipt read comes from {@link loadBasis}.
 */
export interface ResolvableAlert {
  readonly alertId: string;
  readonly assessmentId: string;
  readonly profileId: string;
}

interface AlertRow {
  readonly alert_id: string;
  readonly assessment_id: string;
  readonly profile_id: string;
}

interface BasisRow {
  readonly alert_id: string;
  readonly assessment_id: string;
  readonly profile_id: string;
  readonly alert_published_at: Date | string;
  readonly evaluated_at: Date | string;
  readonly rule_version_id: string;
  readonly rule_key: string | null;
  readonly rule_version: string | null;
  readonly regulatory_rule_version_id: string | null;
  readonly evidence_level: string;
  readonly urgency: string;
  readonly match_confidence: string;
  readonly normalization_version: string;
  readonly source_organization: string | null;
  readonly source_name: string | null;
  readonly source_jurisdiction: string | null;
  readonly license_review_state: string | null;
  readonly required_attribution: string | null;
  readonly legal_reference: string | null;
  readonly publication_date: Date | string | null;
  readonly effective_date: Date | string | null;
}

interface ReceiptRow {
  readonly id: string;
  readonly resolution: string | null;
  readonly resolution_note: string | null;
  readonly resolved_at: Date | string | null;
}

interface CorrectionRow {
  readonly id: string;
  readonly correction_kind: string;
  readonly reason: string;
  readonly corrected_at: Date | string;
  readonly reviewer_id: string | null;
  readonly corrected_assessment_id: string | null;
}

interface HistoryRow {
  readonly occurred_at: Date | string;
  readonly detail: { readonly resolution?: unknown; readonly replaced?: unknown } | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** A `date` column, rendered as the date it is rather than as an instant. */
function dateOrNull(value: Date | string | null | undefined): string | null {
  const rendered = isoOrNull(value);
  return rendered === null ? null : (rendered.slice(0, 10) ?? null);
}

/** The one not-found these routes produce. Absence and refusal, deliberately identical. */
const noSuchAlert = (): DomainError => domainError('NOT_FOUND', 'No such alert.');

/**
 * Load the alert under row-level security.
 *
 * This is the authorization for every path here and for report-incorrect. `alert_publication`'s
 * policy admits PUBLISHED only and requires `VIEW_SAFETY`, so a withdrawn alert and one belonging
 * to somebody else are the same answer. No join to `owned_item`: resolving an alert does not
 * require seeing the shelf, and requiring it would make the resolution controls depend on a
 * permission `03` group H keeps separate.
 */
export async function loadResolvableAlert(
  ctx: RequestContext,
  alertId: string,
): Promise<ResolvableAlert | null> {
  const result = await ctx.db((db) =>
    db.query<AlertRow>(
      `SELECT ap.id         AS alert_id,
              a.id          AS assessment_id,
              ap.profile_id AS profile_id
         FROM alert_publication ap
         JOIN profile_assessment a ON a.id = ap.assessment_id
        WHERE ap.id = $1`,
      [alertId],
    ),
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    alertId: row.alert_id,
    assessmentId: row.assessment_id,
    profileId: row.profile_id,
  };
}

/**
 * The resolution that currently stands, if there is one.
 *
 * One row, because `receipt_publication_idx` is UNIQUE on `alert_publication_id`. The row may
 * exist with a NULL resolution - the schema allows a receipt created before anybody resolved
 * anything - so an unresolved row reads as no current resolution rather than as one.
 */
async function loadCurrent(
  ctx: RequestContext,
  alertId: string,
): Promise<{ readonly rowExists: boolean; readonly entry: ReceiptEntry | null }> {
  const result = await ctx.db((db) =>
    db.query<ReceiptRow>(
      `SELECT sr.id, sr.resolution, sr.resolution_note, sr.resolved_at
         FROM safety_receipt sr
        WHERE sr.alert_publication_id = $1`,
      [alertId],
    ),
  );

  const row = result.rows[0];
  if (row === undefined) return { rowExists: false, entry: null };
  if (row.resolution === null || row.resolved_at === null) return { rowExists: true, entry: null };

  return {
    rowExists: true,
    entry: {
      receiptId: row.id,
      resolution: row.resolution as SafetyResolution,
      note: row.resolution_note,
      resolvedAt: iso(row.resolved_at),
    },
  };
}

export interface RecordResolutionOutcome {
  /** True where the resolution asked for was already the one that stood. Nothing was written. */
  readonly alreadyRecorded: boolean;
  /** True where a different resolution stood and this replaced it. */
  readonly replaced: boolean;
}

/**
 * Record what a person did about an alert.
 *
 * The single writer for `safety_receipt`. Both the resolution route and report-incorrect go
 * through it, because the table admits one row per alert and two independent INSERT statements
 * would meet on the unique index the first time a household used both screens.
 *
 * The caller must have loaded `alert` through {@link loadResolvableAlert} - that read under
 * row-level security is the authorization, and this function performs none of its own.
 */
export async function recordSafetyResolution(
  ctx: RequestContext,
  alert: ResolvableAlert,
  resolution: SafetyResolution,
  note: string | null,
  auditAction: ResolutionAuditAction,
): Promise<RecordResolutionOutcome> {
  const existing = await loadCurrent(ctx, alert.alertId);

  if (existing.entry?.resolution === resolution) {
    // Idempotent rather than refused. Recording the same thing twice changes nothing and the
    // person did nothing wrong, so this says so rather than failing validation.
    return { alreadyRecorded: true, replaced: false };
  }

  const replaced = existing.entry !== null;

  if (existing.rowExists) {
    // Through row-level security, as the app role. Migration `0006` grants it UPDATE on this table
    // and no INSERT, with a policy requiring `VIEW_SAFETY`, and its comment says why: this is the
    // only safety-domain write a person makes. Doing it as the service role would work and would
    // move the authorization out of the policy written for it.
    await ctx.db((db) =>
      db.query(
        `UPDATE safety_receipt
            SET resolution = $1, resolution_note = $2, resolved_at = $3, resolved_by_user_id = $4
          WHERE alert_publication_id = $5`,
        [resolution, note, ctx.now, ctx.principal.userId, alert.alertId],
      ),
    );
  } else {
    await ctx.privileged('SAFETY_RECEIPT', async (db) => {
      await db.query(
        // One INSERT, into one table. Nothing here writes to `alert_publication` or
        // `profile_assessment`, which is exit criterion 1 as a shape rather than as a rule.
        `INSERT INTO safety_receipt
           (profile_id, alert_publication_id, assessment_id, resolution, resolution_note,
            resolved_at, resolved_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          alert.profileId,
          alert.alertId,
          alert.assessmentId,
          resolution,
          note,
          ctx.now,
          ctx.principal.userId,
        ],
      );
    });
  }

  await ctx.privileged('AUDIT_WRITE', async (db) => {
    await db.query(
      `INSERT INTO audit_event
         (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
       VALUES ($1, 'kynviora_app', $2, 'alert_publication', $3, $4, $5::jsonb)`,
      [
        ctx.principal.userId,
        auditAction,
        alert.alertId,
        ctx.correlationId,
        // The resolution is a closed vocabulary and safe to record; the note is free text about
        // somebody's medicine and `14` keeps that out of a log.
        //
        // This row is where the *sequence* lives. `safety_receipt` holds one row per alert and a
        // later resolution overwrites the previous one; `audit_event` is append-only and no role
        // may update or delete it, so the chain the receipt replays cannot be rewritten by the
        // household, by a caregiver, or by this service (DEC-075).
        JSON.stringify({
          resolution,
          replaced,
          note_recorded: note !== null,
        }),
      ],
    );
  });

  return { alreadyRecorded: false, replaced };
}

export interface SafetyReceiptRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
}

export function registerSafetyReceiptRoutes(
  app: FastifyInstance,
  deps: SafetyReceiptRouteDeps,
): void {
  const { contextFor, fail } = deps;

  /**
   * Everything the receipt rests on, read under row-level security.
   *
   * The regulatory joins are LEFT: an expiry alert rests on no external source at all, and one
   * whose regulatory record was superseded to NULL is still worth reading. Requiring them would
   * turn "Kynviora knows less than usual" into "not found" - Phase 7.3's reasoning, and the same
   * failure would be worse here, on the record a person keeps.
   */
  async function loadBasis(ctx: RequestContext, alertId: string): Promise<BasisRow | null> {
    const result = await ctx.db((db) =>
      db.query<BasisRow>(
        `SELECT ap.id                       AS alert_id,
                ap.published_at             AS alert_published_at,
                a.id                        AS assessment_id,
                ap.profile_id               AS profile_id,
                a.evaluated_at              AS evaluated_at,
                a.rule_version_id           AS rule_version_id,
                rv.rule_key                 AS rule_key,
                rv.version                  AS rule_version,
                a.regulatory_rule_version_id AS regulatory_rule_version_id,
                a.evidence_level            AS evidence_level,
                a.urgency                   AS urgency,
                a.match_confidence          AS match_confidence,
                a.normalization_version     AS normalization_version,
                s.organization              AS source_organization,
                s.source_name               AS source_name,
                s.jurisdiction              AS source_jurisdiction,
                s.license_review_state      AS license_review_state,
                s.required_attribution      AS required_attribution,
                rr.legal_reference          AS legal_reference,
                rr.publication_date         AS publication_date,
                rr.effective_date           AS effective_date
           FROM alert_publication ap
           JOIN profile_assessment a ON a.id = ap.assessment_id
           -- LEFT, and this one matters. The assessment_rule_read policy admits PUBLISHED rules
           -- only, so a rule that has since been superseded or withdrawn is invisible to the app
           -- role while the alert it raised is still published. An inner join would make a
           -- person's own receipt disappear the day Kynviora revised the rule behind it, which is
           -- exit criterion 1 failing by another route. The version identifier is on the
           -- assessment either way, so the receipt keeps what it has to keep.
           LEFT JOIN assessment_rule_version rv ON rv.id = a.rule_version_id
           LEFT JOIN regulatory_rule_version rr ON rr.id = a.regulatory_rule_version_id
           LEFT JOIN source_registry_entry s    ON s.id = rr.source_registry_entry_id
          WHERE ap.id = $1`,
        [alertId],
      ),
    );
    return result.rows[0] ?? null;
  }

  async function loadCorrections(
    ctx: RequestContext,
    assessmentId: string,
  ): Promise<readonly ReceiptCorrection[]> {
    const result = await ctx.db((db) =>
      db.query<CorrectionRow>(
        // Corrections against the assessment this alert rests on, in either direction: a
        // correction may name it as the original or as the replacement, and a person reading
        // their own receipt needs both. `correction_read` is the policy that decides which of
        // them this caller sees, and it is not restated here.
        `SELECT id, correction_kind, reason, corrected_at, reviewer_id, corrected_assessment_id
           FROM assessment_correction
          WHERE original_assessment_id = $1 OR corrected_assessment_id = $1
          ORDER BY corrected_at, id`,
        [assessmentId],
      ),
    );

    return result.rows.map((row) => ({
      correctionId: row.id,
      correctionKind: row.correction_kind,
      reason: row.reason,
      correctedAt: iso(row.corrected_at),
      reviewerId: row.reviewer_id,
      // Only a replacement that is not this assessment counts as superseding it. A correction
      // naming this row as the replacement is what *made* it current, and reading that as "you
      // are looking at a stale assessment" would be exactly backwards.
      replacementAssessmentId:
        row.corrected_assessment_id === null || row.corrected_assessment_id === assessmentId
          ? null
          : row.corrected_assessment_id,
    }));
  }

  /**
   * The chain of what was recorded, replayed out of the append-only log.
   *
   * Privileged, because the app role holds no grant on `audit_event` at all - `14` keeps the log
   * off every ordinary connection. The authorization is the alert read under row-level security
   * that happened first, exactly as the caregiver-audit route establishes authority over a
   * profile before reading its events.
   *
   * The actor is deliberately not selected. See {@link ReceiptHistoryEntry}: identity belongs on
   * the caregiver-audit screen, and a household receipt is not the place to introduce it.
   */
  async function loadHistory(
    ctx: RequestContext,
    alertId: string,
  ): Promise<readonly ReceiptHistoryEntry[]> {
    const result = await ctx.privileged('AUDIT_READ', (db) =>
      db.query<HistoryRow>(
        `SELECT e.occurred_at, e.detail
           FROM audit_event e
          WHERE e.target_kind = 'alert_publication'
            AND e.target_id = $1
            AND e.action = ANY($2::text[])
          ORDER BY e.occurred_at, e.id
          LIMIT 200`,
        [alertId, [...RESOLUTION_AUDIT_ACTIONS]],
      ),
    );

    return result.rows.flatMap((row) => {
      const resolution = row.detail?.resolution;
      // A log row written before the detail carried a resolution is skipped rather than guessed
      // at. A history line naming the wrong action is worse than a shorter history.
      if (typeof resolution !== 'string') return [];
      return [
        {
          recordedAt: iso(row.occurred_at),
          resolution: resolution as SafetyResolution,
          replacedPrevious: row.detail?.replaced === true,
        },
      ];
    });
  }

  // -------------------------------------------------------------------------
  // POST /v1/alerts/:alertId/resolutions
  // -------------------------------------------------------------------------

  app.post<{ Params: { alertId: string } }>(
    '/v1/alerts/:alertId/resolutions',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const params = paramsSchema.safeParse(request.params);
      // A malformed identifier answers exactly as an unknown one does, so a prober cannot learn
      // which of their guesses were well-formed.
      if (!params.success) return fail(reply, noSuchAlert(), ctx.correlationId);

      const body = resolutionBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
          ctx.correlationId,
        );
      }

      const alert = await loadResolvableAlert(ctx, params.data.alertId);
      if (alert === null) return fail(reply, noSuchAlert(), ctx.correlationId);

      const outcome = await recordSafetyResolution(
        ctx,
        alert,
        body.data.resolution,
        body.data.note ?? null,
        'alert.resolution_recorded',
      );

      return reply.status(outcome.alreadyRecorded ? 200 : 201).send({
        recorded: true,
        alreadyRecorded: outcome.alreadyRecorded,
        replaced: outcome.replaced,
        serverTime: ctx.now,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/alerts/:alertId/receipt
  // -------------------------------------------------------------------------
  // Composed on the server, like the alert detail. The licence gate on a source reference is a
  // `25` obligation and `BLK-005` says no source has cleared review; sending the raw reference and
  // trusting a client to hide it would put that obligation in the one place nobody can audit.

  app.get<{ Params: { alertId: string } }>(
    '/v1/alerts/:alertId/receipt',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return fail(reply, noSuchAlert(), ctx.correlationId);

      const basis = await loadBasis(ctx, params.data.alertId);
      if (basis === null) return fail(reply, noSuchAlert(), ctx.correlationId);

      // Sequential, not `Promise.all`. Each of these takes its own role-scoped connection - two
      // under row-level security and one privileged - and DEC-037 records that the development
      // engine is a single writer, so overlapping them interleaves the role switches rather than
      // running in parallel. Three small reads on one alert do not need the concurrency.
      const current = await loadCurrent(ctx, basis.alert_id);
      const corrections = await loadCorrections(ctx, basis.assessment_id);
      const history = await loadHistory(ctx, basis.alert_id);

      const source: SafetyReceiptViewInput['source'] = {
        organization: basis.source_organization,
        sourceName: basis.source_name,
        jurisdiction: basis.source_jurisdiction,
        legalReference: basis.legal_reference,
        publicationDate: dateOrNull(basis.publication_date),
        effectiveDate: dateOrNull(basis.effective_date),
        licenseReviewState: basis.license_review_state,
        requiredAttribution: basis.required_attribution,
      };

      // The same test `sourceLineView` applies, asked once here so the domain can report the
      // withholding as an uncertainty rather than leaving it as a gap on the source line only.
      const referenceWithheld =
        basis.legal_reference !== null &&
        !(
          basis.license_review_state !== null &&
          LICENSE_STATES_ALLOWING_REFERENCE.includes(basis.license_review_state)
        );

      const receipt = buildReceipt({
        alertPublicationId: basis.alert_id,
        assessmentId: basis.assessment_id,
        basis: {
          assessedAt: iso(basis.evaluated_at),
          alertPublishedAt: iso(basis.alert_published_at),
          ruleVersionId: basis.rule_version_id,
          ruleKey: basis.rule_key,
          ruleVersion: basis.rule_version,
          regulatoryRuleVersionId: basis.regulatory_rule_version_id,
          evidenceLevel: basis.evidence_level,
          urgency: basis.urgency,
          matchConfidence: basis.match_confidence,
          normalizationVersion: basis.normalization_version,
        },
        current: current.entry,
        history,
        corrections,
        sourceReferenceWithheld: referenceWithheld,
      });

      return reply.status(200).send({
        ...safetyReceiptView({
          basis: receipt.basis,
          current:
            receipt.current === null
              ? null
              : {
                  resolution: receipt.current.resolution,
                  note: receipt.current.note,
                  resolvedAt: receipt.current.resolvedAt,
                },
          history: receipt.history,
          corrections: receipt.corrections,
          correctedSinceResolution: receipt.correctedSinceResolution,
          uncertainties: receipt.uncertainties,
          source,
        }),
        alertPublicationId: receipt.alertPublicationId,
        assessmentId: receipt.assessmentId,
        // The codes beside the sentences, so a client can reason about them without parsing prose.
        uncertaintyCodes: receipt.uncertainties,
        currentResolution: receipt.current?.resolution ?? null,
        serverTime: ctx.now,
      });
    },
  );
}
