/**
 * Visit Pack routes: propose, review, generate, retrieve, revoke.
 *
 * Spec references: `04` Phase 8.4, `06` Journey 8, `16` (Export), `14` (step-up for exports),
 * `13` (export generation is a privileged server-only operation, idempotency on retryable
 * mutations), `03` group I.
 *
 * THE SHAPE OF THE FLOW, AND WHY IT HAS FOUR STEPS RATHER THAN ONE
 *
 *   GET  /v1/visit-packs/candidates  - what Kynviora proposes, with a digest
 *   POST /v1/visit-packs             - generate, quoting the digest of what was reviewed
 *   GET  /v1/visit-packs/:id         - retrieve, rendered from live records
 *   POST /v1/visit-packs/:id/revoke  - end the pack early
 *
 * A single "export this profile" call would satisfy nobody: `04` Phase 8.4 requires that export
 * never happens automatically and that a user can review exactly what will be shared, and both
 * are properties of the *sequence*, not of any one handler. The candidates response carries a
 * digest; generation refuses unless the same digest still describes the live data. That is what
 * turns "the user reviewed it" from a claim about the client into a server-checked fact.
 *
 * Candidate building lives here rather than in the domain because it reads the database. Every
 * read goes through the RLS-scoped connection, so the candidate list can only ever contain
 * records the caller may already see - which is also why there is no authorization check on the
 * individual entries.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_VISIT_PACK_TTL_HOURS,
  MAX_VISIT_PACK_TTL_HOURS,
  MAX_VISIT_PACK_ENTRIES,
  VISIT_PACK_SECTIONS,
  digestSelection,
  domainError,
  evaluateGeneration,
  factCaveat,
  isErr,
  isVisitPackRetrievable,
  itemCaveat,
  renderVisitPack,
  unsafeId,
  visitPackAuditDetail,
  type ContentDigest,
  type DomainError,
  type Instant,
  type ItemVerification,
  type ProfileId,
  type ProvenanceKind,
  type VisitPackEntry,
  type VisitPackId,
  type VisitPackSection,
} from '@kynviora/domain';
import type { DatabaseConnection, RequestContext } from './context.js';
import { hasFreshStepUp } from './context.js';

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * SHA-256 over the canonical form.
 *
 * Not a security boundary against a forger - the server computes both sides - but a collision
 * would let a pack be generated from content nobody reviewed, so a real hash rather than a
 * cheap one.
 */
export function sha256ContentDigest(): ContentDigest {
  return {
    of: (canonical: string) => createHash('sha256').update(canonical, 'utf8').digest('hex'),
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

const candidatesQuerySchema = z.object({ profileId: uuidSchema });

const generateBodySchema = z.object({
  profileId: uuidSchema,
  /** Exactly the records the user ticked. There is no "everything" flag, by design. */
  selectedEntityIds: z.array(z.string().max(64)).max(MAX_VISIT_PACK_ENTRIES),
  reviewedDigest: z.string().regex(/^[0-9a-f]{64}$/),
  reviewedAt: z.string().datetime(),
  notes: z.array(z.string().min(1).max(500)).max(20).default([]),
  ttlHours: z.number().int().min(1).max(MAX_VISIT_PACK_TTL_HOURS).optional(),
});

// ---------------------------------------------------------------------------
// Candidate building
// ---------------------------------------------------------------------------

/** How recent an item change has to be to appear under "recent changes". */
const RECENT_CHANGE_WINDOW_DAYS = 90;

/**
 * Build every entry the caller could choose, from records RLS already admits.
 *
 * Ordering within a section is stable (by ID) so the canonical form and therefore the digest are
 * reproducible across calls.
 */
async function buildCandidates(
  db: DatabaseConnection,
  profileId: string,
  now: Instant,
): Promise<VisitPackEntry[]> {
  const entries: VisitPackEntry[] = [];

  const items = await db.query<{
    id: string;
    item_kind: string;
    display_name: string;
    brand: string | null;
    strength_text: string | null;
    dosage_form: string | null;
    directions_text: string | null;
    personal_care_category: string | null;
    identity_verification: string;
    lifecycle_state: string;
    started_on: string | null;
    stopped_on: string | null;
    version: number;
    updated_at: string;
  }>(
    `SELECT id, item_kind, display_name, brand, strength_text, dosage_form, directions_text,
            personal_care_category, identity_verification, lifecycle_state, started_on,
            stopped_on, version, updated_at
     FROM owned_item
     WHERE profile_id = $1 AND deleted_at IS NULL
     ORDER BY id`,
    [profileId],
  );

  for (const row of items.rows) {
    const caveat = itemCaveat(row.identity_verification as ItemVerification);
    const descriptor = [row.display_name, row.strength_text, row.dosage_form, row.brand]
      .filter((part): part is string => part !== null && part.length > 0)
      .join(', ');

    if (row.lifecycle_state === 'ACTIVE') {
      const lines = [descriptor];
      // Directions are reproduced verbatim. Spec 04 Phase 4.1: Kynviora never rewrites a
      // prescription instruction, and a paraphrase on a page a clinician reads is worse than
      // no line at all.
      if (row.directions_text) lines.push(`Directions as recorded: ${row.directions_text}`);
      if (row.started_on) lines.push(`Started ${row.started_on}`);

      entries.push({
        section: row.item_kind === 'MEDICINE' ? 'CURRENT_MEDICINES' : 'PERSONAL_CARE_ITEMS',
        entityKind: 'owned_item',
        entityId: row.id,
        version: row.version,
        lines,
        caveat,
      });
    }

    // A medicine that was stopped recently is often the single most useful line on the page, so
    // it is offered - never included by default, like everything else here.
    const changedRecently =
      Date.parse(row.updated_at) >=
      Date.parse(now) - RECENT_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (row.lifecycle_state === 'STOPPED' && changedRecently) {
      entries.push({
        section: 'RECENT_ITEM_CHANGES',
        entityKind: 'owned_item',
        entityId: `stopped:${row.id}`,
        version: row.version,
        lines: [`Stopped: ${descriptor}${row.stopped_on ? ` on ${row.stopped_on}` : ''}`],
        caveat,
      });
    }
  }

  const allergies = await db.query<{
    id: string;
    record_kind: string;
    display_term: string;
    provenance: string;
    certainty: string;
    version: number;
  }>(
    `SELECT id, record_kind, display_term, provenance, certainty, version
     FROM allergy_record
     WHERE profile_id = $1 AND deleted_at IS NULL
     ORDER BY id`,
    [profileId],
  );

  for (const row of allergies.rows) {
    entries.push({
      section: 'ALLERGIES_AND_SENSITIVITIES',
      entityKind: 'allergy_record',
      entityId: row.id,
      version: row.version,
      // The certainty is on the line itself, not only in the caveat: a reader scanning an
      // allergy list must not have to cross-reference a footnote to learn that an entry is
      // suspected rather than confirmed.
      lines: [
        `${row.record_kind === 'ALLERGY' ? 'Allergy' : 'Sensitivity'}: ${row.display_term}` +
          ` (${row.certainty.toLowerCase()})`,
      ],
      caveat: factCaveat(row.provenance as ProvenanceKind),
    });
  }

  const alerts = await db.query<{
    id: string;
    published_at: string;
    urgency: string;
    evidence_level: string;
    match_confidence: string;
    explanation_template_id: string;
  }>(
    `SELECT p.id, p.published_at, a.urgency, a.evidence_level, a.match_confidence,
            a.explanation_template_id
     FROM alert_publication p
     JOIN profile_assessment a ON a.id = p.assessment_id
     WHERE p.profile_id = $1
     ORDER BY p.id`,
    [profileId],
  );

  for (const row of alerts.rows) {
    entries.push({
      section: 'UNRESOLVED_SAFETY_ITEMS',
      entityKind: 'alert_publication',
      entityId: row.id,
      version: 1,
      // Urgency and evidence level are printed as two separate facts and are never combined
      // into one severity word (spec 23 D-005).
      lines: [
        `Open safety item from ${row.published_at.slice(0, 10)}`,
        `Suggested urgency: ${row.urgency}`,
        `Evidence level: ${row.evidence_level}`,
        `Match confidence: ${row.match_confidence}`,
      ],
      caveat:
        'Raised by Kynviora against published rules. It is not a diagnosis and not a ' +
        'clinical judgement.',
    });
  }

  const refills = await db.query<{
    id: string;
    display_name: string;
    estimated_depletion_on: string | null;
    assumptions_note: string | null;
  }>(
    `SELECT r.id, i.display_name, r.estimated_depletion_on, r.assumptions_note
     FROM refill_estimate r
     JOIN owned_item i ON i.id = r.owned_item_id
     WHERE i.profile_id = $1 AND i.deleted_at IS NULL
     ORDER BY r.id`,
    [profileId],
  );

  for (const row of refills.rows) {
    entries.push({
      section: 'ADHERENCE_AND_REFILL',
      entityKind: 'refill_estimate',
      entityId: row.id,
      version: 1,
      lines: [
        `${row.display_name}: estimated to run out ${row.estimated_depletion_on ?? 'unknown'}`,
      ],
      caveat:
        row.assumptions_note ??
        'An estimate from recorded quantity and schedule, not a measured count.',
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Manifest storage
// ---------------------------------------------------------------------------

interface ManifestEntry {
  readonly section: VisitPackSection;
  readonly entityKind: VisitPackEntry['entityKind'];
  readonly entityId: string;
  readonly version: number;
}

/** Only IDs and versions reach the database. See DEC-022 and the migration comment. */
function toManifest(entries: readonly VisitPackEntry[]): ManifestEntry[] {
  return entries
    .filter((entry) => entry.entityKind !== 'user_note')
    .map((entry) => ({
      section: entry.section,
      entityKind: entry.entityKind,
      entityId: entry.entityId,
      version: entry.version,
    }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface VisitPackRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
  readonly digest: ContentDigest;
}

export function registerVisitPackRoutes(app: FastifyInstance, deps: VisitPackRouteDeps): void {
  const { contextFor, fail, digest } = deps;

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
       VALUES ($1, 'kynviora_service', $2, 'visit_pack', $3, $4, $5::jsonb)`,
      [
        input.ctx.principal.userId,
        input.action,
        input.targetId,
        input.ctx.correlationId,
        JSON.stringify(input.detail),
      ],
    );
  }

  // -------------------------------------------------------------------------
  // GET /v1/visit-packs/candidates
  // -------------------------------------------------------------------------
  // `06` Journey 8 step 2: Kynviora *proposes*. Nothing here is selected; the response is a menu
  // and the `selected` field is absent from it entirely, so a client cannot mistake a proposal
  // for a choice.

  app.get('/v1/visit-packs/candidates', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const parsed = candidatesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid query parameters.', {
          reason_code: 'query_schema',
        }),
        ctx.correlationId,
      );
    }

    // RLS-scoped. A profile the caller cannot reach yields an empty candidate list rather than a
    // refusal, which is the same non-confirming behaviour as the shelf route.
    const entries = await ctx.db((db) => buildCandidates(db, parsed.data.profileId, ctx.now));

    return reply.send({
      profileId: parsed.data.profileId,
      sections: VISIT_PACK_SECTIONS,
      candidates: entries.map((entry) => ({
        section: entry.section,
        entityKind: entry.entityKind,
        entityId: entry.entityId,
        version: entry.version,
        lines: entry.lines,
        caveat: entry.caveat,
      })),
      // The digest of *everything available*, so a client that offers "select all" still quotes
      // a digest the server can check. A client selecting a subset recomputes locally from the
      // same canonical rule.
      availableDigest: digestSelection(entries, digest),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/visit-packs
  // -------------------------------------------------------------------------

  app.post('/v1/visit-packs', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    // Step-up is checked before anything else, including body validation. `14` treats an export
    // without re-authentication as *the* failure, whatever else is wrong with the request, and
    // checking it first means an un-stepped-up session never reaches the parser or the database.
    // `evaluateGeneration` asserts the same rule again, so the domain still states it.
    if (!hasFreshStepUp(ctx)) {
      return fail(
        reply,
        domainError('STEP_UP_REQUIRED', 'Confirm your identity before creating an export.'),
        ctx.correlationId,
      );
    }

    if (!ctx.operationId) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Idempotency-Key header is required.', {
          reason_code: 'idempotency_key_required',
        }),
        ctx.correlationId,
      );
    }

    const parsed = generateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
        ctx.correlationId,
      );
    }
    const body = parsed.data;

    const available = await ctx.db((db) => buildCandidates(db, body.profileId, ctx.now));

    const decision = evaluateGeneration({
      request: {
        profileId: unsafeId<ProfileId>(body.profileId),
        requestedByUserId: ctx.principal.userId,
        selectedEntityIds: body.selectedEntityIds,
        reviewedDigest: body.reviewedDigest,
        reviewedAt: body.reviewedAt as Instant,
        notes: body.notes,
        ttlHours: body.ttlHours ?? DEFAULT_VISIT_PACK_TTL_HOURS,
      },
      available,
      // `14`: step-up for exports. Decided in the domain so the rule is stated once, and checked
      // here against this session.
      stepUpFresh: hasFreshStepUp(ctx),
      now: ctx.now,
      digest,
    });

    if (isErr(decision)) return fail(reply, decision.error, ctx.correlationId);
    const plan = decision.value;

    try {
      const id = await ctx.privileged('EXPORT_GENERATION', async (db) => {
        await db.query('BEGIN');
        try {
          const inserted = await db.query<{ id: string }>(
            `INSERT INTO visit_pack
               (profile_id, created_by_user_id, manifest, content_digest, notes, generated_at,
                expires_at, client_operation_id)
             VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
              plan.profileId,
              ctx.principal.userId,
              JSON.stringify(toManifest(plan.entries)),
              plan.contentDigest,
              plan.notes,
              plan.generatedAt,
              plan.expiresAt,
              ctx.operationId,
            ],
          );
          const packId = inserted.rows[0]?.id ?? null;
          await writeAudit(db, {
            ctx,
            action: 'visitpack.generated',
            targetId: packId,
            detail: visitPackAuditDetail(plan),
          });
          await db.query('COMMIT');
          return packId;
        } catch (inner) {
          await db.query('ROLLBACK');
          throw inner;
        }
      });

      return reply.status(201).send({
        id,
        profileId: plan.profileId,
        generatedAt: plan.generatedAt,
        expiresAt: plan.expiresAt,
        entryCount: plan.entries.length,
        serverTime: ctx.now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (/visit_pack_operation_idx|duplicate key/i.test(message)) {
        const existing = await ctx.privileged('EXPORT_GENERATION', (db) =>
          db.query<{ id: string; generated_at: string; expires_at: string }>(
            `SELECT id, generated_at, expires_at FROM visit_pack WHERE client_operation_id = $1`,
            [ctx.operationId],
          ),
        );
        const row = existing.rows[0];
        return reply
          .status(200)
          .header('idempotent-replay', 'true')
          .send({
            id: row?.id ?? null,
            generatedAt: row?.generated_at ?? null,
            expiresAt: row?.expires_at ?? null,
            replayed: true,
            serverTime: ctx.now,
          });
      }

      ctx.logger.error('api.visit_pack_generate_failed', { correlation_id: ctx.correlationId });
      return fail(
        reply,
        domainError('INTERNAL', 'Could not create the Visit Pack.'),
        ctx.correlationId,
      );
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/visit-packs/:packId
  // -------------------------------------------------------------------------

  app.get<{ Params: { packId: string } }>('/v1/visit-packs/:packId', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const id = uuidSchema.safeParse(request.params.packId);
    if (!id.success) {
      return fail(reply, domainError('NOT_FOUND', 'No such Visit Pack.'), ctx.correlationId);
    }

    // RLS decides visibility. `visit_pack_select` admits the owner, the creator, and a
    // caregiver holding EXPORT_SUMMARY - deliberately not one who merely holds VIEW_MEDICINES.
    const found = await ctx.db((db) =>
      db.query<{
        id: string;
        profile_id: string;
        manifest: ManifestEntry[];
        content_digest: string;
        notes: string[];
        generated_at: string;
        expires_at: string;
        revoked_at: string | null;
      }>(
        `SELECT id, profile_id, manifest, content_digest, notes, generated_at, expires_at,
                  revoked_at
           FROM visit_pack WHERE id = $1`,
        [id.data],
      ),
    );
    const row = found.rows[0];
    if (!row) {
      return fail(reply, domainError('NOT_FOUND', 'No such Visit Pack.'), ctx.correlationId);
    }

    if (
      !isVisitPackRetrievable(
        { expiresAt: row.expires_at as Instant, revokedAt: row.revoked_at as Instant | null },
        ctx.now,
      )
    ) {
      // Evaluated against the clock on every retrieval, so an expiry needs no sweep to take
      // effect (`16` requires temporary export objects to expire).
      return fail(
        reply,
        domainError('EXPORT_EXPIRED', 'This Visit Pack is no longer available.'),
        ctx.correlationId,
      );
    }

    // Rendered from live records, not from a stored copy (DEC-022). The manifest selects; the
    // database supplies the content, under the same row-level security as any other read.
    const live = await ctx.db((db) => buildCandidates(db, row.profile_id, ctx.now));
    const byId = new Map(live.map((entry) => [entry.entityId, entry]));

    const entries: VisitPackEntry[] = [];
    let missing = 0;
    for (const manifestEntry of row.manifest) {
      const entry = byId.get(manifestEntry.entityId);
      if (entry) entries.push(entry);
      else missing += 1;
    }
    row.notes.forEach((line, index) => {
      entries.push({
        section: 'QUESTIONS_AND_NOTES',
        entityKind: 'user_note',
        entityId: `note:${String(index).padStart(4, '0')}`,
        version: 1,
        lines: [line],
        caveat: 'Written by the person or their caregiver.',
      });
    });

    const pack = renderVisitPack({
      id: unsafeId<VisitPackId>(row.id),
      profileId: unsafeId<ProfileId>(row.profile_id),
      generatedAt: row.generated_at as Instant,
      expiresAt: row.expires_at as Instant,
      storedDigest: row.content_digest,
      entries,
      digest,
    });

    // Viewing an export is itself an event worth recording: `16` requires an audit trail for
    // exports, and generation alone would not show that a pack was actually opened.
    await ctx.privileged('AUDIT_WRITE', (db) =>
      writeAudit(db, {
        ctx,
        action: 'visitpack.viewed',
        targetId: row.id,
        detail: { entry_count: entries.length, matches_generated: pack.matchesGeneratedContent },
      }),
    );

    return reply.send({
      id: pack.id,
      profileId: pack.profileId,
      generatedAt: pack.generatedAt,
      expiresAt: pack.expiresAt,
      // Always present, never per-pack text: `03` group I insists a pack is a communication
      // aid and not a clinician-authenticated record.
      limitation: pack.limitation,
      matchesGeneratedContent: pack.matchesGeneratedContent,
      removedSinceGeneration: missing,
      entries: pack.entries,
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/visit-packs/:packId/revoke
  // -------------------------------------------------------------------------

  app.post<{ Params: { packId: string } }>(
    '/v1/visit-packs/:packId/revoke',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const id = uuidSchema.safeParse(request.params.packId);
      if (!id.success) {
        return fail(reply, domainError('NOT_FOUND', 'No such Visit Pack.'), ctx.correlationId);
      }

      // No step-up. Revoking an export only ever reduces what is shared, and a person who has
      // realised they exported the wrong thing should not be held behind a second factor.
      const found = await ctx.db((db) =>
        db.query<{ id: string; revoked_at: string | null }>(
          'SELECT id, revoked_at FROM visit_pack WHERE id = $1',
          [id.data],
        ),
      );
      const row = found.rows[0];
      if (!row) {
        return fail(reply, domainError('NOT_FOUND', 'No such Visit Pack.'), ctx.correlationId);
      }

      const alreadyRevoked = row.revoked_at !== null;
      if (!alreadyRevoked) {
        await ctx.privileged('EXPORT_GENERATION', async (db) => {
          await db.query(
            `UPDATE visit_pack SET revoked_at = now(), revoked_by_user_id = $1
             WHERE id = $2 AND revoked_at IS NULL`,
            [ctx.principal.userId, row.id],
          );
          await writeAudit(db, {
            ctx,
            action: 'visitpack.revoked',
            targetId: row.id,
            detail: { reason_code: 'user_revoked' },
          });
        });
      }

      return reply.send({ status: 'REVOKED', alreadyRevoked, serverTime: ctx.now });
    },
  );
}
