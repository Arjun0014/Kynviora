/**
 * Shadow-run and replay routes.
 *
 * Spec references: `04` Phase 6.7, `09` (replay reproduces), `10` (shadow-mode result where
 * required; false-positive investigation), `13` (privileged operations), `22` (measured
 * validation), `BLK-008` (no approved thresholds exist).
 *
 *   POST /v1/reviewer/shadow-runs             - evaluate a candidate rule against a dataset
 *   GET  /v1/reviewer/shadow-runs/:id         - the report, its counts and its samples
 *   POST /v1/reviewer/shadow-runs/:id/compare - before/after against another run
 *   POST /v1/reviewer/replays                 - recompute recorded assessments after a change
 *
 * WHY THE ROUTE CANNOT NOTIFY ANYBODY
 * `04` Phase 6.7's first exit criterion is that a new high-impact rule can be evaluated without
 * user notification. That is carried by three things, none of which is a flag:
 *
 *  - {@link runShadow} refuses a rule that is not in shadow mode;
 *  - the results are written to `shadow_run`, which is not `profile_assessment` - and
 *    `alert_publication` requires a `profile_assessment`, so the tables do not connect;
 *  - the run holds counts and de-identified samples, so even code that wanted to notify has no
 *    recipient to read.
 *
 * WHY A HISTORICAL RUN IS REFUSED FOR SOME RULES
 * The historical dataset is assembled from the shelf, and the shelf join here does not carry the
 * confirmed ingredient declaration. A rule that matches on substances would therefore under-count
 * against real data, and an under-count is worse than no answer: it reads as "this affects
 * nobody". So those rule kinds are refused rather than silently mis-measured (`DEV-018`).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  domainError,
  instantFrom,
  type ActionUrgency,
  type DomainError,
  type EvidenceLevel,
  type Instant,
  type ItemVerification,
  type ProvenanceKind,
} from '@kynviora/domain';
import {
  compareShadowRuns,
  replayAll,
  runShadow,
  type ActionSignal,
  type Assessment,
  type AssessmentRuleVersion,
  type MatchReason,
  type OwnedItemSnapshot,
  type ProfileFact,
  type ShadowDatasetRow,
  type ShadowRun,
  type ShadowSample,
} from '@kynviora/safety';
import type { DatabaseConnection, RequestContext } from './context.js';
import { NOT_A_REVIEWER, activeReviewerRoles } from './reviewerConsole.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const syntheticRowSchema = z.object({
  ownedItemId: z.string().uuid(),
  profileId: z.string().uuid(),
  productIdentityId: z.string().uuid().nullable().default(null),
  formulationId: z.string().uuid().nullable().default(null),
  formulationVersion: z.string().max(64).nullable().default(null),
  batchId: z.string().uuid().nullable().default(null),
  lotCode: z.string().max(64).nullable().default(null),
  gtin: z.string().max(20).nullable().default(null),
  expiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  identityVerification: z.enum(['CONFIRMED', 'PROBABLE', 'PARTIAL', 'CONFLICTING', 'UNVERIFIED']),
  formulationVerification: z.enum([
    'CONFIRMED',
    'PROBABLE',
    'PARTIAL',
    'CONFLICTING',
    'UNVERIFIED',
  ]),
  batchVerification: z.enum(['CONFIRMED', 'PROBABLE', 'PARTIAL', 'CONFLICTING', 'UNVERIFIED']),
  substanceKeys: z.array(z.string().max(200)).max(200).default([]),
  isActive: z.boolean().default(true),
});

const startBodySchema = z.object({
  ruleVersionId: z.string().uuid(),
  datasetKind: z.enum(['SYNTHETIC', 'HISTORICAL']),
  datasetLabel: z.string().min(1).max(200),
  // Bounded: a run is a review artefact, not a bulk import.
  dataset: z.array(syntheticRowSchema).max(500).default([]),
  sampleLimit: z.number().int().min(1).max(100).default(20),
});

const compareBodySchema = z.object({ againstRunId: z.string().uuid() });

const replayBodySchema = z.object({
  ruleVersionId: z.string().uuid(),
  changeKind: z.enum([
    'SOURCE_CORRECTION',
    'RULE_VERSION',
    'NORMALIZATION_VERSION',
    'ROUTINE_VERIFICATION',
  ]),
  changeNote: z.string().min(1).max(1000),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

/**
 * Rule kinds a historical dataset cannot feed faithfully.
 *
 * `INGREDIENT_SENSITIVITY` came off this list when `DEV-018` closed: the dataset now carries both
 * halves of a substance match - the confirmed declaration's canonical keys and the profile fact's
 * - so a run over it reports what the rule would really produce. Where that is zero it is a
 * measured zero, which is a different statement from a structural one and is the whole reason the
 * refusal existed.
 *
 * `DUPLICATE_ACTIVE_INGREDIENT` stays, and for a different reason than it was put here for. The
 * dataset can now feed it; `evaluateRule` cannot evaluate it - `09` requires validated reference
 * data and clinical review before that rule may exist at all (`BLK-006`), so the engine returns a
 * non-match for every item. Measuring it would produce a confident zero about a rule that has not
 * been written, which is worse than refusing.
 */
const HISTORICAL_UNSUPPORTED_KINDS: readonly string[] = Object.freeze([
  'DUPLICATE_ACTIVE_INGREDIENT',
]);

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface RuleRow {
  readonly id: string;
  readonly rule_kind: string;
  readonly version: string;
  readonly evidence_level: string;
  readonly max_urgency: string;
  readonly required_item_verification: string[];
  readonly required_profile_provenance: string[];
  readonly explanation_template_id: string;
  readonly review_state: string;
  readonly approved_by_reviewer_id: string | null;
  readonly approved_at: Date | null;
  readonly shadow_mode: boolean;
  readonly enabled: boolean;
}

function toRule(row: RuleRow): AssessmentRuleVersion {
  return {
    id: row.id,
    kind: row.rule_kind as AssessmentRuleVersion['kind'],
    version: row.version,
    evidenceLevel: row.evidence_level as EvidenceLevel,
    maxUrgency: row.max_urgency as ActionUrgency,
    requiredItemVerification: row.required_item_verification as ItemVerification[],
    requiredProfileProvenance: row.required_profile_provenance as ProvenanceKind[],
    explanationTemplateId: row.explanation_template_id,
    reviewState: row.review_state as AssessmentRuleVersion['reviewState'],
    approvedByReviewerId: row.approved_by_reviewer_id,
    approvedAt:
      row.approved_at === null ? null : (row.approved_at.toISOString() as unknown as Instant),
    shadowMode: row.shadow_mode,
    enabled: row.enabled,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface ShadowModeRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
}

export function registerShadowModeRoutes(app: FastifyInstance, deps: ShadowModeRouteDeps): void {
  const { contextFor, fail } = deps;

  function badBody(reply: FastifyReply, correlationId: string) {
    return fail(
      reply,
      domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
      correlationId,
    );
  }

  async function loadRule(ctx: RequestContext, id: string): Promise<AssessmentRuleVersion | null> {
    return ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const res = await db.query<RuleRow>(
        `SELECT id, rule_kind, version, evidence_level, max_urgency, required_item_verification,
                required_profile_provenance, explanation_template_id, review_state,
                approved_by_reviewer_id, approved_at, shadow_mode, enabled
           FROM assessment_rule_version WHERE id = $1`,
        [id],
      );
      const row = res.rows[0];
      return row === undefined ? null : toRule(row);
    });
  }

  /**
   * Assemble a dataset from the shelf.
   *
   * Privileged and cross-profile by necessity - a blast-radius number that only covered the
   * households one caller may read would be worse than no number. Nothing about a person leaves
   * this function: the rows go straight into {@link runShadow}, which counts and discards them.
   */
  async function historicalDataset(ctx: RequestContext): Promise<readonly ShadowDatasetRow[]> {
    return ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const items = await db.query<{
        id: string;
        profile_id: string;
        product_identity_id: string | null;
        formulation_id: string | null;
        batch_id: string | null;
        lot_code: string | null;
        gtin: string | null;
        expires_on: Date | null;
        identity_verification: string;
        formulation_verification: string;
        batch_verification: string;
        lifecycle_state: string;
        formulation_version: string | null;
        substance_keys: string[] | null;
      }>(
        // `DEV-028`'s sibling, `DEV-018`: the confirmed declaration, which this join did not reach
        // until now. Only `EXACT` ingredients contribute a key - an ambiguous one resolved to no
        // substance and a rule that counted it would be matching on a mapping nobody made, which
        // is the same discipline `evaluateIngredientSensitivity` keeps on the profile side.
        //
        // Aggregated in SQL rather than in a second query and a join in memory: one row per item
        // is what the dataset builder below expects, and a per-item round trip over a whole
        // installation's shelf is the shape that stops being viable first.
        `SELECT oi.id, oi.profile_id, oi.product_identity_id, oi.formulation_id, oi.batch_id,
                b.lot_code, pi.gtin, oi.expires_on,
                oi.identity_verification, oi.formulation_verification, oi.batch_verification,
                oi.lifecycle_state,
                mf.version_label AS formulation_version,
                (SELECT array_agg(DISTINCT ns.canonical_key)
                   FROM formulation_ingredient fi
                   JOIN normalized_substance ns ON ns.id = fi.substance_id
                  WHERE fi.formulation_id = oi.formulation_id
                    AND fi.mapping_state = 'EXACT') AS substance_keys
           FROM owned_item oi
           LEFT JOIN batch_or_lot b ON b.id = oi.batch_id
           LEFT JOIN product_identity pi ON pi.id = oi.product_identity_id
           LEFT JOIN marketed_formulation mf ON mf.id = oi.formulation_id
          WHERE oi.deleted_at IS NULL
          ORDER BY oi.id`,
      );

      const facts = await db.query<{
        id: string;
        profile_id: string;
        record_kind: string;
        display_term: string;
        provenance: string;
        version: number;
        created_at: Date;
        canonical_key: string | null;
      }>(
        // `04` Phase 5.2 put a mapping on `substance_id`; this is what reads it. `allergy_select`
        // is not in play - this runs privileged and cross-profile, because a blast-radius number
        // that only covered the households one caller may read would be worse than no number.
        `SELECT ar.id, ar.profile_id, ar.record_kind, ar.display_term, ar.provenance, ar.version,
                ar.created_at, ns.canonical_key
           FROM allergy_record ar
           LEFT JOIN normalized_substance ns ON ns.id = ar.substance_id
          WHERE ar.deleted_at IS NULL`,
      );

      const signals = await db.query<{
        id: string;
        gtin: string | null;
        formulation_id: string | null;
        batch_codes: string[];
        summary: string;
      }>(
        `SELECT id, gtin, formulation_id, batch_codes, summary
           FROM product_regulatory_action WHERE review_state = 'PUBLISHED'`,
      );

      const actionSignals: readonly ActionSignal[] = signals.rows.map((row) => ({
        id: row.id,
        version: row.id,
        gtin: row.gtin,
        formulationId: row.formulation_id,
        batchCodes: row.batch_codes,
        summary: row.summary,
      }));

      const factsByProfile = new Map<string, ProfileFact[]>();
      for (const row of facts.rows) {
        const list = factsByProfile.get(row.profile_id) ?? [];
        list.push({
          id: row.id,
          kind: row.record_kind as ProfileFact['kind'],
          // `DEV-018`, the fact half. Null where the term is unmapped, which in this build is
          // almost everywhere: the vocabulary needs a licensed source (`BLK-003`). That is a
          // measured zero rather than a structural one, which is the whole difference this
          // deviation was about.
          substanceCanonicalKey: row.canonical_key,
          displayTerm: row.display_term,
          provenance: row.provenance as ProvenanceKind,
          recordedAt: instantFrom(row.created_at.toISOString()),
          version: String(row.version),
        });
        factsByProfile.set(row.profile_id, list);
      }

      return items.rows.map((row) => ({
        item: {
          ownedItemId: row.id,
          profileId: row.profile_id,
          productIdentityId: row.product_identity_id,
          formulationId: row.formulation_id,
          formulationVersion: row.formulation_version,
          batchId: row.batch_id,
          lotCode: row.lot_code,
          gtin: row.gtin,
          expiresOn: row.expires_on === null ? null : row.expires_on.toISOString().slice(0, 10),
          identityVerification: row.identity_verification as ItemVerification,
          formulationVerification: row.formulation_verification as ItemVerification,
          batchVerification: row.batch_verification as ItemVerification,
          // `DEV-018`, the item half. `array_agg` returns NULL rather than an empty array when
          // nothing matched, and an item with no formulation never reaches the subquery at all.
          substanceKeys: row.substance_keys ?? [],
          isActive: row.lifecycle_state === 'ACTIVE',
        },
        profileFacts: factsByProfile.get(row.profile_id) ?? [],
        actionSignals,
      }));
    });
  }

  async function writeAudit(
    db: DatabaseConnection,
    input: {
      readonly ctx: RequestContext;
      readonly action: string;
      readonly targetKind: string;
      readonly targetId: string | null;
      readonly detail: Readonly<Record<string, string | number | boolean | null>>;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO audit_event
         (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
       VALUES ($1, 'kynviora_service', $2, $3, $4, $5, $6::jsonb)`,
      [
        input.ctx.principal.userId,
        input.action,
        input.targetKind,
        input.targetId,
        input.ctx.correlationId,
        JSON.stringify(input.detail),
      ],
    );
  }

  // -------------------------------------------------------------------------
  // POST /v1/reviewer/shadow-runs
  // -------------------------------------------------------------------------

  app.post('/v1/reviewer/shadow-runs', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const roles = await activeReviewerRoles(ctx);
    if (roles.length === 0) return fail(reply, NOT_A_REVIEWER, ctx.correlationId);

    const body = startBodySchema.safeParse(request.body);
    if (!body.success) return badBody(reply, ctx.correlationId);

    const rule = await loadRule(ctx, body.data.ruleVersionId);
    if (rule === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such rule version.'), ctx.correlationId);
    }

    if (!rule.shadowMode) {
      // The domain throws for this too. Refusing here as well means the caller gets an error they
      // can act on rather than a 500.
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'That rule is not in shadow mode.', {
          reason_code: 'rule_not_in_shadow_mode',
        }),
        ctx.correlationId,
      );
    }

    if (
      body.data.datasetKind === 'HISTORICAL' &&
      HISTORICAL_UNSUPPORTED_KINDS.includes(rule.kind)
    ) {
      // An under-count reads as "this affects nobody", which is the most dangerous wrong answer
      // a blast-radius number can give.
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'A historical run cannot measure this rule kind yet.', {
          reason_code: 'historical_dataset_incomplete_for_rule',
          rule_kind: rule.kind,
        }),
        ctx.correlationId,
      );
    }

    const dataset =
      body.data.datasetKind === 'HISTORICAL'
        ? await historicalDataset(ctx)
        : // A synthetic row is the item and nothing else: profile facts and action signals for
          // invented data would be invented too, and the rule kinds that need them are the ones a
          // historical run refuses for the same reason.
          body.data.dataset.map((row) => ({
            item: row,
            profileFacts: [],
            actionSignals: [],
          }));

    let run: ShadowRun;
    try {
      run = runShadow({
        rule,
        dataset,
        normalizationVersion: 'norm-1',
        evaluationInstant: ctx.now,
        sampleLimit: body.data.sampleLimit,
      });
    } catch {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'The run could not be performed.', {
          reason_code: 'shadow_run_refused',
        }),
        ctx.correlationId,
      );
    }

    const created = await ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO shadow_run
           (rule_version_id, dataset_kind, dataset_label, dataset_size, matched_items,
            affected_products, affected_formulations, potential_user_matches, reason_counts,
            evaluation_instant, normalization_version, run_by_user_id, run_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $10)
         RETURNING id`,
        [
          rule.id,
          body.data.datasetKind,
          body.data.datasetLabel,
          run.datasetSize,
          run.matchedItems,
          run.affectedProducts,
          run.affectedFormulations,
          run.potentialUserMatches,
          JSON.stringify(run.reasonCounts),
          ctx.now,
          run.normalizationVersion,
          ctx.principal.userId,
        ],
      );
      const id = inserted.rows[0]?.id ?? null;
      if (id === null) return null;

      let order = 0;
      for (const sample of run.samples) {
        await db.query(
          `INSERT INTO shadow_run_sample
             (shadow_run_id, owned_item_id, matched, match_confidence, reasons, evidence_level,
              urgency, sample_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            sample.ownedItemId,
            sample.matched,
            sample.matchConfidence,
            [...sample.reasons],
            sample.evidenceLevel,
            sample.urgency,
            order,
          ],
        );
        order += 1;
      }

      await writeAudit(db, {
        ctx,
        action: 'shadow.run',
        targetKind: 'shadow_run',
        targetId: id,
        detail: {
          rule_version_id: rule.id,
          dataset_kind: body.data.datasetKind,
          dataset_size: run.datasetSize,
          matched_items: run.matchedItems,
          potential_user_matches: run.potentialUserMatches,
        },
      });
      return id;
    });

    if (created === null) {
      return fail(reply, domainError('INTERNAL', 'Could not record the run.'), ctx.correlationId);
    }

    return reply.status(201).send({
      shadowRunId: created,
      datasetSize: run.datasetSize,
      matchedItems: run.matchedItems,
      affectedProducts: run.affectedProducts,
      affectedFormulations: run.affectedFormulations,
      potentialUserMatches: run.potentialUserMatches,
      reasonCounts: run.reasonCounts,
      // No verdict. `22` requires release thresholds to be set by leadership against a labelled
      // dataset and `BLK-008` records that none exists, so the numbers go to a person.
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/reviewer/shadow-runs/:id
  // -------------------------------------------------------------------------

  interface StoredRun {
    readonly id: string;
    readonly rule_version_id: string;
    readonly dataset_kind: string;
    readonly dataset_label: string;
    readonly dataset_size: number;
    readonly matched_items: number;
    readonly affected_products: number;
    readonly affected_formulations: number;
    readonly potential_user_matches: number;
    readonly reason_counts: Record<string, number>;
    readonly evaluation_instant: Date;
    readonly normalization_version: string;
    readonly run_at: Date;
  }

  interface StoredSample {
    readonly owned_item_id: string;
    readonly matched: boolean;
    readonly match_confidence: string;
    readonly reasons: string[];
    readonly evidence_level: string;
    readonly urgency: string;
    readonly sample_order: number;
  }

  async function loadRun(
    ctx: RequestContext,
    id: string,
  ): Promise<{ run: StoredRun; samples: readonly StoredSample[] } | null> {
    return ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const runs = await db.query<StoredRun>(
        `SELECT id, rule_version_id, dataset_kind, dataset_label, dataset_size, matched_items,
                affected_products, affected_formulations, potential_user_matches, reason_counts,
                evaluation_instant, normalization_version, run_at
           FROM shadow_run WHERE id = $1`,
        [id],
      );
      const run = runs.rows[0];
      if (run === undefined) return null;

      const samples = await db.query<StoredSample>(
        `SELECT owned_item_id, matched, match_confidence, reasons, evidence_level, urgency,
                sample_order
           FROM shadow_run_sample WHERE shadow_run_id = $1 ORDER BY sample_order`,
        [id],
      );
      return { run, samples: samples.rows };
    });
  }

  /** Rebuild the domain shape from stored rows, so comparison uses one implementation. */
  function asShadowRun(stored: { run: StoredRun; samples: readonly StoredSample[] }): ShadowRun {
    const samples: ShadowSample[] = stored.samples.map((sample) => ({
      ownedItemId: sample.owned_item_id,
      matched: sample.matched,
      matchConfidence: sample.match_confidence as ShadowSample['matchConfidence'],
      reasons: sample.reasons as MatchReason[],
      evidenceLevel: sample.evidence_level as EvidenceLevel,
      urgency: sample.urgency as ActionUrgency,
    }));
    return {
      ruleId: stored.run.rule_version_id,
      ruleVersion: stored.run.normalization_version,
      datasetSize: stored.run.dataset_size,
      matchedItems: stored.run.matched_items,
      affectedProducts: stored.run.affected_products,
      affectedFormulations: stored.run.affected_formulations,
      potentialUserMatches: stored.run.potential_user_matches,
      reasonCounts: stored.run.reason_counts,
      samples,
      evaluationInstant: instantFrom(stored.run.evaluation_instant.toISOString()),
      normalizationVersion: stored.run.normalization_version,
    };
  }

  app.get('/v1/reviewer/shadow-runs/:id', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const roles = await activeReviewerRoles(ctx);
    if (roles.length === 0) return fail(reply, NOT_A_REVIEWER, ctx.correlationId);

    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return badBody(reply, ctx.correlationId);

    const stored = await loadRun(ctx, params.data.id);
    if (stored === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such run.'), ctx.correlationId);
    }

    return reply.status(200).send({
      shadowRunId: stored.run.id,
      ruleVersionId: stored.run.rule_version_id,
      datasetKind: stored.run.dataset_kind,
      datasetLabel: stored.run.dataset_label,
      datasetSize: stored.run.dataset_size,
      matchedItems: stored.run.matched_items,
      affectedProducts: stored.run.affected_products,
      affectedFormulations: stored.run.affected_formulations,
      potentialUserMatches: stored.run.potential_user_matches,
      reasonCounts: stored.run.reason_counts,
      runAt: stored.run.run_at.toISOString(),
      // Samples for `10`'s false-positive review. The item, the reasons and the rule version -
      // and no person.
      samples: stored.samples.map((sample) => ({
        ownedItemId: sample.owned_item_id,
        matched: sample.matched,
        matchConfidence: sample.match_confidence,
        reasons: sample.reasons,
        evidenceLevel: sample.evidence_level,
        urgency: sample.urgency,
      })),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/reviewer/shadow-runs/:id/compare
  // -------------------------------------------------------------------------

  app.post('/v1/reviewer/shadow-runs/:id/compare', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const roles = await activeReviewerRoles(ctx);
    if (roles.length === 0) return fail(reply, NOT_A_REVIEWER, ctx.correlationId);

    const params = idParamsSchema.safeParse(request.params);
    const body = compareBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return badBody(reply, ctx.correlationId);

    const after = await loadRun(ctx, params.data.id);
    const before = await loadRun(ctx, body.data.againstRunId);
    if (after === null || before === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such run.'), ctx.correlationId);
    }

    const comparison = compareShadowRuns(asShadowRun(before), asShadowRun(after));

    return reply.status(200).send({
      beforeRunId: before.run.id,
      afterRunId: after.run.id,
      // Reported rather than silently intersected: comparing two runs over different datasets is
      // usually a mistake, and hiding it would let a reviewer read a diff that means nothing.
      onlyInBefore: comparison.onlyInBefore,
      onlyInAfter: comparison.onlyInAfter,
      newlyMatched: comparison.newlyMatched,
      noLongerMatched: comparison.noLongerMatched,
      changed: comparison.changed,
      unchanged: comparison.unchanged,
      entries: comparison.entries,
      countDeltas: {
        matchedItems: after.run.matched_items - before.run.matched_items,
        potentialUserMatches: after.run.potential_user_matches - before.run.potential_user_matches,
        affectedProducts: after.run.affected_products - before.run.affected_products,
      },
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/reviewer/replays
  // -------------------------------------------------------------------------

  app.post('/v1/reviewer/replays', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const roles = await activeReviewerRoles(ctx);
    if (roles.length === 0) return fail(reply, NOT_A_REVIEWER, ctx.correlationId);

    const body = replayBodySchema.safeParse(request.body);
    if (!body.success) return badBody(reply, ctx.correlationId);

    const rule = await loadRule(ctx, body.data.ruleVersionId);
    if (rule === null) {
      return fail(reply, domainError('NOT_FOUND', 'No such rule version.'), ctx.correlationId);
    }

    // The recorded assessments, and the current state of everything they were computed from. That
    // pairing is the whole point: replaying against current state is what a correction *is*.
    const originals = await ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const res = await db.query<{
        owned_item_id: string;
        profile_id: string;
        matched: boolean;
        match_confidence: string;
        reasons: string[];
        evidence_level: string;
        urgency: string;
        explanation_template_id: string;
        normalization_version: string;
        evaluated_at: Date;
        matched_substance_key: string | null;
        matched_profile_fact_id: string | null;
      }>(
        // `DEV-028`. The matched identities are read back with everything else, because
        // `replayAssessment` compares them: without them every recomputed ingredient match would
        // report a difference against an original that simply had not been asked for its reasons.
        `SELECT owned_item_id, profile_id, matched, match_confidence, reasons, evidence_level,
                urgency, explanation_template_id, normalization_version, evaluated_at,
                matched_substance_key, matched_profile_fact_id
           FROM profile_assessment WHERE rule_version_id = $1 ORDER BY owned_item_id`,
        [rule.id],
      );
      return res.rows;
    });

    const dataset = await historicalDataset(ctx);
    const byItem = new Map(dataset.map((row) => [row.item.ownedItemId, row]));

    const assessments: Assessment[] = originals
      .filter((row) => byItem.has(row.owned_item_id))
      .map((row) => ({
        ruleId: rule.id,
        ruleVersion: rule.version,
        ownedItemId: row.owned_item_id,
        profileId: row.profile_id,
        matched: row.matched,
        matchConfidence: row.match_confidence as Assessment['matchConfidence'],
        reasons: row.reasons as MatchReason[],
        evidenceLevel: row.evidence_level as EvidenceLevel,
        urgency: row.urgency as ActionUrgency,
        explanationTemplateId: row.explanation_template_id,
        inputVersions: {
          formulationVersion: null,
          normalizationVersion: row.normalization_version,
          profileFactVersions: [],
          actionSignalVersions: [],
        },
        // Both or neither, which the schema constraint also enforces. A half-filled record here
        // would compare unequal to a whole one and report a difference that is this mapper's,
        // not the rule's.
        matchedInputs:
          row.matched_substance_key === null || row.matched_profile_fact_id === null
            ? null
            : {
                substanceKey: row.matched_substance_key,
                profileFactId: row.matched_profile_fact_id,
              },
        shadowOnly: false,
        evaluatedAt: instantFrom(row.evaluated_at.toISOString()),
      }));

    const report = replayAll(assessments, (original) => {
      const row = byItem.get(original.ownedItemId);
      return {
        rule,
        item: row?.item ?? ({} as OwnedItemSnapshot),
        profileFacts: row?.profileFacts ?? [],
        actionSignals: row?.actionSignals ?? [],
        normalizationVersion: original.inputVersions.normalizationVersion,
        // The instant the assessment was computed for, not today. Without this every expiry
        // assessment would "change" on replay and a correction diff would be unreadable.
        evaluationInstant: original.evaluatedAt,
      };
    });

    const recorded = await ctx.privileged('REVIEWER_CONSOLE', async (db) => {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO replay_run
           (change_kind, change_note, assessments_replayed, reproduced, changed,
            difference_counts, run_by_user_id, run_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING id`,
        [
          body.data.changeKind,
          body.data.changeNote,
          report.total,
          report.reproduced,
          report.changed,
          JSON.stringify(report.differenceCounts),
          ctx.principal.userId,
          ctx.now,
        ],
      );
      const id = inserted.rows[0]?.id ?? null;
      if (id !== null) {
        await writeAudit(db, {
          ctx,
          action: 'replay.run',
          targetKind: 'replay_run',
          targetId: id,
          detail: {
            rule_version_id: rule.id,
            change_kind: body.data.changeKind,
            replayed: report.total,
            reproduced: report.reproduced,
            changed: report.changed,
          },
        });
      }
      return id;
    });

    return reply.status(201).send({
      replayRunId: recorded,
      replayed: report.total,
      reproduced: report.reproduced,
      changed: report.changed,
      // The question `09` actually asks. Nothing moving means the correction changed nothing
      // anybody was told, which is the common and reassuring case.
      fullyReproduced: report.fullyReproduced,
      differenceCounts: report.differenceCounts,
      // Which items moved, so the diff is readable rather than a headline number. No profile.
      changedItems: report.entries
        .filter((entry) => !entry.reproduced)
        .map((entry) => ({ ownedItemId: entry.ownedItemId, differences: entry.differences })),
      serverTime: ctx.now,
    });
  });
}
