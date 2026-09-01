/**
 * The Kynviora API boundary.
 *
 * Spec references: `13` (API contract rules, authorization, sync), `14` (network/API security),
 * `11` (server-authoritative safety), `12` (client error classes).
 *
 * `13` requires: HTTPS only, runtime schema validation both directions, stable machine error
 * codes, cursor pagination, server time on sync-sensitive responses, idempotency keys on
 * retryable mutations, body-size limits, rate limits, and no sensitive data in query strings.
 *
 * Route handlers contain no SQL authorization logic. They receive a `RequestContext` bound to the
 * `kynviora_app` role and rely on row-level security, which `13` calls defence in depth and this
 * codebase treats as the primary mechanism for user-scoped reads.
 */

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import {
  domainError,
  isErr,
  type DomainError,
  type Instant,
  type InviteTokenService,
  type Logger,
  type UserId,
} from '@kynviora/domain';
import { projectLens, type SourceRegistryEntry } from '@kynviora/regulatory';
import type { DatabasePool, Principal, RequestContext } from './context.js';
import { createRequestContext } from './context.js';
import { toErrorResponse, statusForCode } from './errors.js';
import { nodeInviteTokenService, registerCaregiverRoutes } from './caregiver.js';
import { registerVisitPackRoutes, sha256ContentDigest } from './visitPack.js';
import { registerAlertDeliveryRoutes } from './alertDelivery.js';
import { registerReviewInboxRoutes } from './reviewInbox.js';
import { registerReconciliationRoutes } from './reconciliation.js';
import { registerReviewerConsoleRoutes } from './reviewerConsole.js';
import { registerOperationsRoutes } from './operations.js';
import { registerSafetyInboxRoutes } from './safetyInbox.js';
import { registerShadowModeRoutes } from './shadowMode.js';

/**
 * Normalise a timestamp column for the wire.
 *
 * The driver returns `timestamptz` as a `Date`, and the response schemas require a string because
 * that is what the contract says. Fastify would serialise a `Date` to the same ISO string, so this
 * looks redundant - it is not: `13` validates the response **before** serialisation, so a `Date`
 * reaching a `z.string()` fails contract validation and the route answers 500.
 *
 * It stayed hidden because every fixture had `last_reviewed_at` null. It surfaced the first time
 * an end-to-end test completed a review task and then re-read the shelf, which is the only order
 * of operations that produces a non-null value.
 */
function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** Maximum request body. `13` requires body-size limits; 1MB is ample for JSON payloads. */
export const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;

/** Default page size for cursor pagination. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface ServerOptions {
  readonly pool: DatabasePool;
  readonly logger: Logger;
  /** Resolves the authenticated principal. Injected so auth provider choice stays deferred. */
  authenticate(request: FastifyRequest): Promise<Principal | null>;
  /** Injected clock, so responses are reproducible in tests (DEC-003). */
  now(): Instant;
  readonly bodyLimitBytes?: number;
  /** Registered regulatory sources, for the Lens projection. */
  loadSources(): Promise<ReadonlyMap<string, SourceRegistryEntry>>;
  /**
   * Invite token issuance and hashing. Injected so a test can pin the token and assert the
   * hashed-only storage property; production uses the Node crypto implementation.
   */
  readonly tokens?: InviteTokenService;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
// `13`: runtime input/output schema validation. The same Zod schemas validate both directions,
// so a response that drifts from the contract fails in tests rather than in a client.

const uuidSchema = z.string().uuid();

const cursorQuerySchema = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const shelfQuerySchema = cursorQuerySchema.extend({
  profileId: uuidSchema,
  itemKind: z.enum(['MEDICINE', 'PERSONAL_CARE']).optional(),
  lifecycleState: z.enum(['ACTIVE', 'STOPPED', 'ARCHIVED']).optional(),
});

const lensQuerySchema = z.object({
  substanceKey: z.string().min(1).max(128),
  productUseType: z.enum(['RINSE_OFF', 'LEAVE_ON', 'ORAL', 'UNKNOWN']).default('UNKNOWN'),
  disclosedConcentrationPercent: z.coerce.number().min(0).max(100).optional(),
  intendedForAgeYears: z.coerce.number().int().min(0).max(120).optional(),
});

const doseEventBodySchema = z.object({
  ownedItemId: uuidSchema,
  eventKind: z.enum(['TAKEN', 'SKIPPED', 'SNOOZED', 'UNABLE_TO_TAKE']),
  scheduledFor: z.string().datetime().optional(),
  scheduleId: uuidSchema.optional(),
  note: z.string().max(500).optional(),
});

/**
 * How many dose events one request returns.
 *
 * A window, not a page. `04` Phase 4.3 wants a person to see what happened; scrolling back
 * through a year of it is not what the screen is for, and an unbounded query on an append-only
 * table is how one item's history becomes a slow request for everybody.
 */
const DEFAULT_DOSE_EVENT_LIMIT = 50;
const MAX_DOSE_EVENT_LIMIT = 200;

const doseEventQuerySchema = z.object({
  ownedItemId: uuidSchema,
  limit: z.coerce.number().int().min(1).max(MAX_DOSE_EVENT_LIMIT).optional(),
});

const shelfItemSchema = z.object({
  id: uuidSchema,
  profileId: uuidSchema,
  itemKind: z.enum(['MEDICINE', 'PERSONAL_CARE']),
  displayName: z.string(),
  brand: z.string().nullable(),
  lifecycleState: z.enum(['ACTIVE', 'STOPPED', 'ARCHIVED']),
  identityVerification: z.string(),
  formulationVerification: z.string(),
  batchVerification: z.string(),
  lastReviewedAt: z.string().nullable(),
  lastSafetyCheckedAt: z.string().nullable(),
});

export type ShelfItem = z.infer<typeof shelfItemSchema>;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({
    // Fastify's own logger is disabled: `14` forbids sensitive content in logs, and the default
    // request logger records full URLs and headers. Logging goes through the injected Logger,
    // which accepts only a machine code and pre-approved scalars.
    logger: false,
    bodyLimit: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    // Do not trust client-supplied forwarding headers unless a reviewed proxy sets them.
    trustProxy: false,
  });

  app.decorateRequest('kynviora', null);

  /** Attach a correlation ID to every request and response. `20` requires traceability. */
  app.addHook('onRequest', (request, reply, done) => {
    const correlationId = crypto.randomUUID();
    (request as FastifyRequest & { correlationId: string }).correlationId = correlationId;
    void reply.header('x-correlation-id', correlationId);

    // `14`: strict transport and no content sniffing.
    void reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('cache-control', 'no-store');
    done();
  });

  function correlationIdOf(request: FastifyRequest): string {
    return (request as FastifyRequest & { correlationId?: string }).correlationId ?? 'unknown';
  }

  function fail(reply: FastifyReply, error: DomainError, correlationId: string): FastifyReply {
    return reply.status(statusForCode(error.code)).send(toErrorResponse(error, correlationId));
  }

  /**
   * Resolve the request context, or reject.
   *
   * Every authenticated route calls this. There is no route that reaches the database without
   * going through it, so an unauthenticated request cannot reach user data.
   */
  async function contextFor(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<RequestContext | null> {
    const correlationId = correlationIdOf(request);
    const principal = await options.authenticate(request);

    if (!principal) {
      fail(reply, domainError('UNAUTHENTICATED', 'No valid session.'), correlationId);
      return null;
    }

    const rawOperationId = request.headers['idempotency-key'];
    const operationId =
      typeof rawOperationId === 'string' && uuidSchema.safeParse(rawOperationId).success
        ? (rawOperationId as unknown as RequestContext['operationId'])
        : undefined;

    const base = {
      pool: options.pool,
      principal,
      correlationId,
      now: options.now(),
      logger: options.logger,
    };

    return createRequestContext(operationId === undefined ? base : { ...base, operationId });
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  app.get('/health', (_request, reply) => reply.send({ status: 'ok' }));

  // -------------------------------------------------------------------------
  // GET /v1/profiles
  // -------------------------------------------------------------------------

  app.get('/v1/profiles', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    // No profile ID is accepted from the client. RLS returns exactly the profiles this user may
    // see, which is `13`'s "never trust a profile ID in the request as proof of access" applied
    // by construction rather than by a check.
    const result = await ctx.db((db) =>
      db.query<{
        id: string;
        display_name: string;
        age_band: string | null;
        is_managed: boolean;
        owner_user_id: string;
      }>(
        `SELECT id, display_name, age_band, is_managed, owner_user_id
         FROM profile
         WHERE deleted_at IS NULL
         ORDER BY created_at`,
      ),
    );

    return reply.send({
      profiles: result.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        ageBand: row.age_band,
        isManaged: row.is_managed,
        // Whether *this caller* owns the profile, not who does. It discloses nothing - a caller
        // who owns a profile already knows it - and it stops every screen that gates on ownership
        // inferring it from something else. `isManaged` is about the person the profile is for
        // and says nothing about who administers it; reading it as ownership was a real mistake
        // this field exists to remove.
        isOwner: row.owner_user_id === (ctx.principal.userId as string),
      })),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/items  (the Unified Health Shelf)
  // -------------------------------------------------------------------------

  app.get('/v1/items', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const parsed = shelfQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid query parameters.', {
          reason_code: 'query_schema',
        }),
        ctx.correlationId,
      );
    }

    const { profileId, itemKind, lifecycleState, limit, cursor } = parsed.data;

    // The profile ID narrows the result set; it does not grant access. If the user cannot see
    // that profile, RLS returns nothing and the response is an empty page - the same as a
    // profile with no items, which avoids confirming the profile exists.
    const conditions: string[] = ['deleted_at IS NULL', 'profile_id = $1'];
    const params: unknown[] = [profileId];

    if (itemKind) {
      params.push(itemKind);
      conditions.push(`item_kind = $${params.length}`);
    }
    if (lifecycleState) {
      params.push(lifecycleState);
      conditions.push(`lifecycle_state = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor);
      conditions.push(`id > $${params.length}`);
    }

    params.push(limit + 1);
    const limitParam = `$${params.length}`;

    const result = await ctx.db((db) =>
      db.query<{
        id: string;
        profile_id: string;
        item_kind: string;
        display_name: string;
        brand: string | null;
        lifecycle_state: string;
        identity_verification: string;
        formulation_verification: string;
        batch_verification: string;
        // Typed as they arrive from the driver, not as the contract states them. Claiming a
        // `string` here is what hid the bug `isoOrNull` exists to fix.
        last_reviewed_at: Date | string | null;
        last_safety_checked_at: Date | string | null;
      }>(
        `SELECT id, profile_id, item_kind, display_name, brand, lifecycle_state,
                identity_verification, formulation_verification, batch_verification,
                last_reviewed_at, last_safety_checked_at
         FROM owned_item
         WHERE ${conditions.join(' AND ')}
         ORDER BY id
         LIMIT ${limitParam}`,
        params,
      ),
    );

    const hasMore = result.rows.length > limit;
    const page = hasMore ? result.rows.slice(0, limit) : result.rows;

    const items: ShelfItem[] = page.map((row) => ({
      id: row.id,
      profileId: row.profile_id,
      itemKind: row.item_kind as ShelfItem['itemKind'],
      displayName: row.display_name,
      brand: row.brand,
      lifecycleState: row.lifecycle_state as ShelfItem['lifecycleState'],
      identityVerification: row.identity_verification,
      formulationVerification: row.formulation_verification,
      batchVerification: row.batch_verification,
      lastReviewedAt: isoOrNull(row.last_reviewed_at),
      lastSafetyCheckedAt: isoOrNull(row.last_safety_checked_at),
    }));

    // `13`: validate the response too, so a schema drift fails here and not in a client.
    const validated = z.array(shelfItemSchema).safeParse(items);
    if (!validated.success) {
      ctx.logger.error('api.response_schema_violation', { route: 'GET /v1/items' });
      return fail(
        reply,
        domainError('INTERNAL', 'Response failed contract validation.'),
        ctx.correlationId,
      );
    }

    return reply.send({
      items: validated.data,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/regulatory-lens
  // -------------------------------------------------------------------------

  app.get('/v1/regulatory-lens', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const parsed = lensQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid query parameters.', {
          reason_code: 'query_schema',
        }),
        ctx.correlationId,
      );
    }

    const { substanceKey, productUseType, disclosedConcentrationPercent, intendedForAgeYears } =
      parsed.data;

    // Only PUBLISHED rules are readable by the app role; the RLS policy enforces it, so an
    // unreviewed candidate cannot reach this projection even if the query forgot to filter.
    const rules = await ctx.db((db) =>
      db.query<{
        id: string;
        jurisdiction: string;
        substance_canonical_key: string;
        statuses: string[];
        conditions: Record<string, unknown>;
        legal_instrument: string | null;
        legal_reference: string | null;
        publication_date: string | null;
        effective_date: string | null;
        source_registry_entry_id: string;
        source_document_id: string | null;
        extraction_version: string;
        review_state: string;
        verification: string;
        approved_by_reviewer_id: string | null;
        approved_at: string | null;
        created_at: string;
      }>(`SELECT * FROM regulatory_rule_version WHERE substance_canonical_key = $1`, [
        substanceKey,
      ]),
    );

    const sources = await options.loadSources();

    const snapshot = projectLens({
      context: {
        substanceCanonicalKey: substanceKey,
        disclosedConcentrationPercent: disclosedConcentrationPercent ?? null,
        productUseType,
        productCategory: null,
        intendedForAgeYears: intendedForAgeYears ?? null,
        substancePresent: true,
      },
      jurisdictions: ['IN', 'EU', 'GB', 'NI', 'US', 'JP'],
      rules: rules.rows.map((row) => ({
        id: row.id,
        jurisdiction: row.jurisdiction as 'EU',
        substanceCanonicalKey: row.substance_canonical_key,
        statuses: row.statuses as never,
        conditions: row.conditions as never,
        legalInstrument: row.legal_instrument,
        legalReference: row.legal_reference,
        publicationDate: row.publication_date as never,
        effectiveDate: row.effective_date as never,
        sourceRegistryEntryId: row.source_registry_entry_id,
        sourceDocumentId: row.source_document_id,
        extractionVersion: row.extraction_version,
        reviewState: row.review_state as never,
        verification: row.verification as never,
        approvedByReviewerId: row.approved_by_reviewer_id,
        approvedAt: row.approved_at as never,
        supersedesRuleVersionId: null,
        createdAt: row.created_at as never,
      })),
      opinions: [],
      actions: [],
      sources,
      generatedAt: ctx.now,
    });

    return reply.send({ lens: snapshot, serverTime: ctx.now });
  });

  // -------------------------------------------------------------------------
  // POST /v1/dose-events
  // -------------------------------------------------------------------------

  app.post('/v1/dose-events', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    // `13`: "Idempotency key on mutations that can be retried." A dose event created offline may
    // be uploaded more than once, and a duplicate would corrupt the adherence history.
    if (!ctx.operationId) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Idempotency-Key header is required.', {
          reason_code: 'idempotency_key_required',
        }),
        ctx.correlationId,
      );
    }

    const parsed = doseEventBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid request body.', {
          reason_code: 'body_schema',
        }),
        ctx.correlationId,
      );
    }

    const { ownedItemId, eventKind, scheduledFor, scheduleId, note } = parsed.data;

    try {
      const inserted = await ctx.db((db) =>
        db.query<{ id: string }>(
          `INSERT INTO dose_event
             (owned_item_id, schedule_id, event_kind, scheduled_for, note, client_operation_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            ownedItemId,
            scheduleId ?? null,
            eventKind,
            scheduledFor ?? null,
            note ?? null,
            ctx.operationId,
          ],
        ),
      );

      if (inserted.rows.length === 0) {
        // RLS refused the insert: the user cannot reach that item. Reported as not-found rather
        // than forbidden, so the response does not confirm the item exists.
        return fail(
          reply,
          domainError('PERMISSION_DENIED', 'Item not reachable.'),
          ctx.correlationId,
        );
      }

      return reply.status(201).send({ id: inserted.rows[0]!.id, serverTime: ctx.now });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // A repeated operation ID is a retry, not a failure. `13`: "Server commits exactly once."
      if (/duplicate key|dose_event_idempotency/i.test(message)) {
        const existing = await ctx.db((db) =>
          db.query<{ id: string }>(`SELECT id FROM dose_event WHERE client_operation_id = $1`, [
            ctx.operationId,
          ]),
        );
        return reply
          .status(200)
          .header('idempotent-replay', 'true')
          .send({ id: existing.rows[0]?.id ?? null, replayed: true, serverTime: ctx.now });
      }

      if (/row-level security|permission denied/i.test(message)) {
        return fail(
          reply,
          domainError('PERMISSION_DENIED', 'Item not reachable.'),
          ctx.correlationId,
        );
      }

      ctx.logger.error('api.dose_event_failed', { correlation_id: ctx.correlationId });
      return fail(reply, domainError('INTERNAL', 'Could not record event.'), ctx.correlationId);
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/dose-events
  // -------------------------------------------------------------------------
  // `04` Phase 4.3: "let users record what happened without gamifying or judging them". The read
  // side of that is a list of what happened, in order.
  //
  // WHAT THIS ROUTE DELIBERATELY DOES NOT RETURN
  // A count, a rate, a streak, a percentage or a "missed" total. `02` lists gamified adherence
  // scoring as an anti-feature and `23` D-005 forbids the aggregate; a route returning
  // `takenCount` and `skippedCount` hands a screen everything it needs to draw a scorecard, and
  // the screen is where nobody would notice it had been reintroduced. The events are the answer.

  app.get('/v1/dose-events', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const query = doseEventQuerySchema.safeParse(request.query);
    if (!query.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid query parameters.', {
          reason_code: 'query_schema',
        }),
        ctx.correlationId,
      );
    }

    // The item ID narrows; `dose_event_select` decides. An item this caller cannot reach comes
    // back as an empty page rather than a refusal, exactly as the shelf does - so this route is
    // not an existence oracle for an owned item ID (`13`, DEC-039).
    const limit = query.data.limit ?? DEFAULT_DOSE_EVENT_LIMIT;
    const result = await ctx.db((db) =>
      db.query<{
        id: string;
        owned_item_id: string;
        schedule_id: string | null;
        event_kind: string;
        scheduled_for: Date | string | null;
        recorded_at: Date | string;
        note: string | null;
      }>(
        `SELECT id, owned_item_id, schedule_id, event_kind, scheduled_for, recorded_at, note
           FROM dose_event
          WHERE owned_item_id = $1
          ORDER BY recorded_at DESC, id
          LIMIT $2`,
        [query.data.ownedItemId, limit],
      ),
    );

    return reply.send({
      ownedItemId: query.data.ownedItemId,
      events: result.rows.map((row) => ({
        id: row.id,
        ownedItemId: row.owned_item_id,
        scheduleId: row.schedule_id,
        eventKind: row.event_kind,
        // Trap 45: the driver hands back a `Date`, and a response schema would validate before
        // Fastify serialises it.
        scheduledFor: isoOrNull(row.scheduled_for),
        recordedAt: isoOrNull(row.recorded_at) ?? ctx.now,
        note: row.note,
      })),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/alerts
  // -------------------------------------------------------------------------

  app.get('/v1/alerts', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    // Withdrawn alerts are excluded by the RLS policy, so a stale deep link cannot resurface
    // one - the release-blocking defect class in `19`.
    const result = await ctx.db((db) =>
      db.query<{
        id: string;
        profile_id: string;
        published_at: string;
        urgency: string;
        evidence_level: string;
        match_confidence: string;
        explanation_template_id: string;
        owned_item_id: string;
      }>(
        `SELECT p.id, p.profile_id, p.published_at,
                a.urgency, a.evidence_level, a.match_confidence,
                a.explanation_template_id, a.owned_item_id
         FROM alert_publication p
         JOIN profile_assessment a ON a.id = p.assessment_id
         ORDER BY p.published_at DESC
         LIMIT 100`,
      ),
    );

    return reply.send({
      alerts: result.rows.map((row) => ({
        id: row.id,
        profileId: row.profile_id,
        ownedItemId: row.owned_item_id,
        publishedAt: row.published_at,
        // Evidence level and urgency are returned as separate fields and are never combined
        // into a single severity by this API (spec 23 D-005).
        urgency: row.urgency,
        evidenceLevel: row.evidence_level,
        matchConfidence: row.match_confidence,
        explanationTemplateId: row.explanation_template_id,
      })),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // Caregiver invitation, grant and audit routes (spec 04 Phase 8.1)
  // -------------------------------------------------------------------------
  // Registered from a separate module because the flow carries its own authorization discipline:
  // reads under RLS, writes through the service role, and an explicit authority check in between.
  // Keeping it beside the shelf and lens handlers would blur that boundary.

  registerCaregiverRoutes(app, {
    contextFor,
    fail,
    tokens: options.tokens ?? nodeInviteTokenService(),
  });

  // -------------------------------------------------------------------------
  // Visit Pack routes (spec 04 Phase 8.4)
  // -------------------------------------------------------------------------
  // These replace the placeholder POST /v1/visit-packs that this file used to serve, so the
  // export flow has a single implementation. Their authorization is the same shape as the
  // caregiver routes: reads under RLS, generation through the service role, step-up in the
  // domain.

  registerVisitPackRoutes(app, { contextFor, fail, digest: sha256ContentDigest() });

  // -------------------------------------------------------------------------
  // Caregiver alert delivery routes (spec 04 Phase 8.2)
  // -------------------------------------------------------------------------
  // Notification settings and the caregiver alert view. Dispatch itself is deliberately not a
  // route - nothing user-facing triggers a notification - so it is exported as a function
  // instead and takes a transport port.

  registerAlertDeliveryRoutes(app, { contextFor, fail });

  // -------------------------------------------------------------------------
  // Household Review Inbox routes (spec 04 Phase 8.3)
  // -------------------------------------------------------------------------
  // Derivation runs privileged over the whole profile; the listing is filtered by row-level
  // security afterwards. Completion writes the authoritative record first and closes the task
  // as a consequence, so there is deliberately no mark-done endpoint.

  registerReviewInboxRoutes(app, { contextFor, fail });

  // -------------------------------------------------------------------------
  // Medicine Reconciliation routes (spec 04 Phase 8.5)
  // -------------------------------------------------------------------------
  // The comparison is a pure function over two lists and decides nothing. The only write to a
  // medicine happens when a person explicitly adopted the current value, and it goes through
  // RLS so the flow cannot change what the caller could not change directly.

  registerReconciliationRoutes(app, { contextFor, fail });

  // -------------------------------------------------------------------------
  // Reviewer console routes (spec 04 Phase 6.6)
  // -------------------------------------------------------------------------
  // Staff software, not a user surface. Migration 0012 gives the app role no grant on any of
  // these tables, so every route here is privileged by construction and authorization is the
  // stored reviewer role rather than a claim in the request (spec 14).

  registerReviewerConsoleRoutes(app, { contextFor, fail });
  registerOperationsRoutes(app, { contextFor, fail });
  registerSafetyInboxRoutes(app, { contextFor, fail });

  // -------------------------------------------------------------------------
  // Shadow-run and replay routes (spec 04 Phase 6.7)
  // -------------------------------------------------------------------------
  // The same trust boundary as the console: staff only, and every route privileged because
  // migration 0013 gives the app role no grant. A shadow run writes to shadow_run rather than
  // profile_assessment, so its results have no path to a notification.

  registerShadowModeRoutes(app, { contextFor, fail });

  // -------------------------------------------------------------------------
  // Fallbacks
  // -------------------------------------------------------------------------

  app.setNotFoundHandler((request, reply) =>
    fail(reply, domainError('NOT_FOUND', 'No such route.'), correlationIdOf(request)),
  );

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = correlationIdOf(request);

    // Fastify raises this when the body exceeds `bodyLimit` (spec 13 body-size limits).
    if (error.statusCode === 413) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Request body too large.', {
          reason_code: 'body_too_large',
        }),
        correlationId,
      );
    }

    if (error.statusCode === 400) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Malformed request.', { reason_code: 'malformed' }),
        correlationId,
      );
    }

    // Never surface an internal message: it may contain a query fragment or a value.
    options.logger.error('api.unhandled_error', { correlation_id: correlationId });
    return fail(reply, domainError('INTERNAL', 'Something went wrong.'), correlationId);
  });

  return app;
}

/** Re-exported so tests can assert against the same codes the routes use. */
export { isErr, type DomainError, type UserId };
