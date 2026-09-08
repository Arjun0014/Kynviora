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
  attentionReasons,
  asTimeZone,
  CAREGIVER_CAPABILITIES,
  domainError,
  isErr,
  isItemLifecycleState,
  isItemVerification,
  isPersonalCareCategory,
  manualEntryLimits,
  normalizeItemUpdate,
  normalizeManualEntry,
  normalizeConsentDecision,
  consentStateFrom,
  consentEnforcement,
  CONSENT_POLICY_VERSION,
  normalizeHealthFactChange,
  normalizeHealthFactDraft,
  isEmptyHealthFactChange,
  provenanceForRelationship,
  normalizeHouseholdDraft,
  normalizeProfileDraft,
  DEFAULT_LANGUAGE_TAG,
  type DomainError,
  type Instant,
  type InviteTokenService,
  type ItemVerification,
  type Logger,
  type StoredItem,
  type UserId,
} from '@kynviora/domain';
import { itemDetailView, manualEntryOutcomeView } from '@kynviora/presentation';
import { projectLens, type SourceRegistryEntry } from '@kynviora/regulatory';
import type { DatabasePool, Principal, RequestContext } from './context.js';
import { createRequestContext } from './context.js';
import { resolveAccountState, type UnprovisionedRoute } from './account.js';
import { registerAccountRoutes, type AuthProvider } from './accountLifecycle.js';
import { toErrorResponse, statusForCode, uniqueViolationConstraint } from './errors.js';
import { nodeInviteTokenService, registerCaregiverRoutes } from './caregiver.js';
import { registerVisitPackRoutes, sha256ContentDigest } from './visitPack.js';
import { registerAlertDeliveryRoutes } from './alertDelivery.js';
import { registerReviewInboxRoutes } from './reviewInbox.js';
import { registerReconciliationRoutes } from './reconciliation.js';
import { registerAlertDetailRoutes } from './alertDetail.js';
import { registerSafetyReceiptRoutes } from './safetyReceipt.js';
import { resolveTermForProfile } from './substanceMapping.js';
import { registerReviewerConsoleRoutes } from './reviewerConsole.js';
import { registerOperationsRoutes } from './operations.js';
import { registerSafetyInboxRoutes } from './safetyInbox.js';
import { registerScheduleRoutes } from './schedule.js';
import { registerHealthRecordRoutes } from './healthRecords.js';
import { registerItemDeletionRoutes, registerProfileDeletionRoutes } from './itemDeletion.js';
import { registerPersonalExportRoutes } from './personalExport.js';
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
/**
 * Run a write that row-level security may refuse, and report the refusal as an absence.
 *
 * A policy that admits nothing on INSERT raises `42501` rather than returning no rows, so without
 * this a caller writing to a profile they do not hold gets a 500. `13` wants a profile ID to
 * narrow rather than to grant, and the answer for "not yours" has to be the answer for "not
 * there".
 *
 * Only the insufficient-privilege code is mapped. Anything else is a real failure and must not be
 * disguised as a missing profile - a bug hidden behind a plausible answer is worse than a 500.
 */
async function insertOrRefusal<T>(ctx: RequestContext, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (code === '42501' || /row-level security/i.test(message)) {
      ctx.logger.info('api.write_refused_by_policy', { correlationId: ctx.correlationId });
      return null;
    }
    throw cause;
  }
}

/**
 * Whether this caller owns the profile (`04` Phase 1.3).
 *
 * Read through the RLS-scoped connection, so a profile this caller cannot see answers "not the
 * owner". That is the safe direction: it produces the weaker of the two provenance values (`14`),
 * and it is never used to decide access - only to record where a fact came from.
 */
async function ownsProfileHere(ctx: RequestContext, profileId: string): Promise<boolean> {
  const res = await ctx.db((db) =>
    db.query<{ owner_user_id: string }>('SELECT owner_user_id FROM profile WHERE id = $1', [
      profileId,
    ]),
  );
  return res.rows[0]?.owner_user_id === (ctx.principal.userId as string);
}

/** Unknown means unverified. Never `CONFIRMED` - the reassuring member is never the fallback. */
function asItemVerification(raw: string): ItemVerification {
  return isItemVerification(raw) ? raw : 'UNVERIFIED';
}

/** The columns a change is applied to, as they come off the row. */
interface StoredItemRow {
  readonly id: string;
  readonly profile_id: string;
  readonly item_kind: string;
  readonly version: number;
  readonly lifecycle_state: string;
  readonly display_name: string;
  readonly brand: string | null;
  readonly manufacturer: string | null;
  readonly market: string | null;
  readonly recorded_gtin: string | null;
  readonly recorded_lot_code: string | null;
  readonly expires_on: Date | string | null;
  readonly started_on: Date | string | null;
  readonly stopped_on: Date | string | null;
  readonly notes: string | null;
  readonly strength_text: string | null;
  readonly dosage_form: string | null;
  readonly directions_text: string | null;
  readonly personal_care_category: string | null;
  readonly ingredient_declaration_raw: string | null;
  readonly label_version_note: string | null;
}

/**
 * The stored row, as the domain sees it.
 *
 * The two enumerated columns are narrowed rather than cast. A `lifecycle_state` this build did
 * not expect becomes `ARCHIVED` - the member that claims least about a live medicine, since
 * `shelfAttention` and the safety inbox both treat anything that is not `ACTIVE` as finished
 * with. Treating an unreadable state as `ACTIVE` would be the reassuring fallback, which is
 * exactly what `asItemVerification` above refuses to be.
 */
function storedItemFromRow(row: StoredItemRow): StoredItem {
  // Narrowed through a local rather than cast: the guard cannot see through a `??`, and a cast
  // here would let a category the schema stopped allowing reach the domain as a valid one.
  const category = row.personal_care_category;
  return {
    version: row.version,
    lifecycleState: isItemLifecycleState(row.lifecycle_state) ? row.lifecycle_state : 'ARCHIVED',
    stoppedOn: dateOrNull(row.stopped_on),
    itemKind: row.item_kind === 'MEDICINE' ? 'MEDICINE' : 'PERSONAL_CARE',
    displayName: row.display_name,
    brand: row.brand,
    manufacturer: row.manufacturer,
    market: row.market,
    recordedGtin: row.recorded_gtin,
    recordedLotCode: row.recorded_lot_code,
    expiresOn: dateOrNull(row.expires_on),
    startedOn: dateOrNull(row.started_on),
    notes: row.notes,
    strengthText: row.strength_text,
    dosageForm: row.dosage_form,
    directionsText: row.directions_text,
    personalCareCategory: category !== null && isPersonalCareCategory(category) ? category : null,
    ingredientDeclarationRaw: row.ingredient_declaration_raw,
    labelVersionNote: row.label_version_note,
  };
}

/** A `date` column, rendered as the date it is rather than as an instant. */
function dateOrNull(value: Date | string | null | undefined): string | null {
  const rendered = isoOrNull(value);
  return rendered === null ? null : (rendered.slice(0, 10) ?? null);
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** Maximum request body. `13` requires body-size limits; 1MB is ample for JSON payloads. */
export const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;

/** Default page size for cursor pagination. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * Which set of routes a process serves.
 *
 * `13` requires internal/admin APIs to be "separately authenticated/authorized and not exposed as
 * user APIs". Separate authorization was already true - a reviewer role is a stored row and the
 * refusal is a bare 404. Separate *exposure* was not: `/v1/reviewer/queue` was registered on the
 * same instance that serves `/v1/items`, so the only thing between a phone and the publication
 * tables was the check. Now it is the absence of a handler as well.
 *
 * There is no `BOTH`. A process that served both would make the boundary a runtime property of
 * how it was started, and the reason to have it at all is that it should not be one.
 */
export type ApiSurface = 'HOUSEHOLD' | 'STAFF';

/** Decorator key under which an instance records the paths it registered. */
const ROUTE_PATHS = 'kynvioraRoutePaths';

/**
 * The paths an instance serves.
 *
 * Exported so the surface boundary can be asserted over the instance itself. A test that lists
 * the routes it expects to be absent only ever catches the routes somebody thought of.
 */
export function registeredRoutePaths(app: FastifyInstance): readonly string[] {
  const paths = (app as unknown as Record<string, unknown>)[ROUTE_PATHS];
  return Array.isArray(paths) ? (paths as readonly string[]) : [];
}

export interface ServerOptions {
  /**
   * Which routes this instance registers. Required, deliberately.
   *
   * Defaulting it would silently place every future route on one side of a security boundary,
   * and the compiler is the only reviewer guaranteed to look at every call site.
   */
  readonly surface: ApiSurface;
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
  /**
   * The identity provider, where this deployment has one.
   *
   * `null` under the development authenticator, and the account routes say so rather than
   * inventing an unverified address: an `app_user` row whose email nobody confirmed is the one
   * thing DEC-118 asked registration to refuse.
   */
  readonly authProvider?: AuthProvider | null;
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
  /**
   * `04` Phase 2.1's verification and attention filters.
   *
   * Two parameters rather than one, because they answer different questions: `verification`
   * narrows by what Kynviora knows about the *product*, `attention` by whether anybody has looked
   * at the *record*. An unrecognised value is a validation failure rather than a silently ignored
   * one - a filter that quietly widened its own result set is the failure a safety-adjacent list
   * cannot have (trap 79).
   */
  verification: z
    .enum(['CONFIRMED', 'PROBABLE', 'PARTIAL', 'CONFLICTING', 'UNVERIFIED'])
    .optional(),
  attention: z.enum(['NEEDS_VERIFICATION', 'NEEDS_REVIEW', 'ANY']).optional(),
});

const itemParamsSchema = z.object({ itemId: uuidSchema });

/**
 * A device reporting where it is.
 *
 * `null` is accepted and is not the same as omitting the field: a device that cannot determine
 * its zone says so, and the stored value returns to unknown. Bounded at 64 because every field
 * length is bounded (`14`) and no IANA name approaches it.
 */
const timeZoneBodySchema = z.object({
  timeZone: z.string().max(64).nullable(),
});

/**
 * A consent decision (`04` Phase 1.4).
 *
 * `.strict()`, and note what is not here: no `userId`, no `policyVersion`, no `recordedAt`. The
 * first is the request context's and the RLS policy checks it; the second and third are the
 * server's, because a client that could name the policy version it agreed to could record
 * agreement to a text nobody showed them, and a client-set timestamp is an audit trail written by
 * the thing being audited.
 */
const consentBodySchema = z
  .object({
    purpose: z.string(),
    granted: z.boolean(),
    locale: z.string().nullish(),
  })
  .strict();

/** `04` Phase 1.3. */
const profileIdParamsSchema = z.object({ profileId: uuidSchema });
const factIdParamsSchema = z.object({ factId: uuidSchema });

/**
 * A reaction somebody is recording (`04` Phase 1.3).
 *
 * `.strict()`, and note what is not here: no `provenance`, no `substanceId`, no `profileId`. The
 * first is derived from who is asking and is the whole of the phase's first exit criterion; the
 * second is the catalog's business (`15` A11); the third is the path.
 */
const healthFactBodySchema = z
  .object({
    kind: z.string(),
    displayTerm: z.string(),
    certainty: z.string().nullish(),
    notedOn: z.string().nullish(),
  })
  .strict();

/**
 * A correction to one (`04` Phase 1.3).
 *
 * Absent is unchanged and `null` clears, the same distinction the item edit keeps. There is no
 * `provenance` here either: a person who could edit a fact into `REVIEWER_CONFIRMED` would have
 * found the way round the exit criterion the create path closes.
 */
const healthFactChangeBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    displayTerm: z.string().nullish(),
    certainty: z.string().nullish(),
    notedOn: z.string().nullish(),
    markReviewed: z.boolean().optional(),
  })
  .strict();

/**
 * A manually entered item (`04` Phases 2.2 and 2.3).
 *
 * Shape only. What the values may be is `normalizeManualEntry`'s question, in the domain, where a
 * refusal can say which field and why - and where the rule lives once rather than in every route
 * that ever accepts one.
 *
 * There is no field for a verification state, a confidence, a catalog identifier or a
 * corroboration. Their absence is what stops a hand-typed record claiming `CONFIRMED` or reaching
 * the shared catalog (`15` A11), and it is enforced by `.strict()` refusing anything else.
 */
const manualEntryBodySchema = z
  .object({
    profileId: uuidSchema,
    itemKind: z.enum(['MEDICINE', 'PERSONAL_CARE']),
    displayName: z.string(),
    brand: z.string().nullish(),
    manufacturer: z.string().nullish(),
    market: z.string().nullish(),
    recordedGtin: z.string().nullish(),
    recordedLotCode: z.string().nullish(),
    expiresOn: z.string().nullish(),
    startedOn: z.string().nullish(),
    notes: z.string().nullish(),
    strengthText: z.string().nullish(),
    dosageForm: z.string().nullish(),
    directionsText: z.string().nullish(),
    personalCareCategory: z.string().nullish(),
    ingredientDeclarationRaw: z.string().nullish(),
    labelVersionNote: z.string().nullish(),
  })
  .strict();

/**
 * A household somebody is creating (`04` Phase 1.2).
 *
 * One field, and `.strict()` so nothing else is accepted. There is deliberately no `ownerUserId`:
 * `household_insert` requires the owner to be the caller and a body that named one would be an
 * authorization statement arriving from the client, which is `13`'s first rule about profile IDs
 * applied to the row that contains them.
 */
const householdBodySchema = z.object({ displayName: z.string() }).strict();

/**
 * A profile somebody is creating (`04` Phase 1.2).
 *
 * `.strict()`, so a key this build does not know about is a refusal rather than one silently
 * ignored. There is no `selfUserId` and no `ownerUserId` for the same reason the household body
 * has none: both are decided by who is asking. `isSelf` is a claim the caller makes about
 * themselves, and it is the only identity statement this body can carry.
 *
 * `birthYear` arrives as a string rather than a number, because the domain refuses `58` rather
 * than reading it as `1958` and a number has already lost the difference between what was typed
 * and what was meant.
 */
const profileBodySchema = z
  .object({
    householdId: uuidSchema,
    displayName: z.string(),
    ageBand: z.string().nullish(),
    birthYear: z.string().nullish(),
    languageTag: z.string().nullish(),
    isSelf: z.boolean().optional(),
  })
  .strict();

/**
 * A change to an item that already exists (`04` Stage 2 - update, archive, review).
 *
 * `.strict()`, so a key this build does not know about is a refusal rather than one silently
 * ignored - a client that believed it had set a verification state would be the worst version of
 * that. Every field is `.nullish()`, which is what keeps "leave it alone" and "empty it" apart on
 * the wire: absent is unchanged and `null` clears.
 *
 * There is deliberately no field for a verification state, a catalog identifier, an item kind, or
 * a `lastReviewedAt`. See `itemUpdate.ts` - the absence is the enforcement.
 */
const itemUpdateBodySchema = z
  .object({
    // Required. `13` sets this entity's conflict policy to ASK_USER, so an edit that did not say
    // what it was editing could only be last-write-wins.
    expectedVersion: z.number().int().min(1),
    displayName: z.string().optional(),
    brand: z.string().nullish(),
    manufacturer: z.string().nullish(),
    market: z.string().nullish(),
    recordedGtin: z.string().nullish(),
    recordedLotCode: z.string().nullish(),
    expiresOn: z.string().nullish(),
    startedOn: z.string().nullish(),
    notes: z.string().nullish(),
    strengthText: z.string().nullish(),
    dosageForm: z.string().nullish(),
    directionsText: z.string().nullish(),
    personalCareCategory: z.string().nullish(),
    ingredientDeclarationRaw: z.string().nullish(),
    labelVersionNote: z.string().nullish(),
    lifecycleState: z.string().optional(),
    stoppedOn: z.string().nullish(),
    /** A request, never a timestamp. The server stamps the time. */
    markReviewed: z.boolean().optional(),
  })
  .strict();

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
  /**
   * What is not settled about this item (`04` Phase 2.1).
   *
   * On every row rather than behind the filter, because the exit criterion is that a person *can
   * understand* which items need something - and a list where that is only visible to somebody
   * who already knew to filter for it does not meet it.
   */
  attentionReasons: z.array(z.string()),
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

  // Every path this instance ends up serving, recorded as it is registered.
  //
  // The surface split is only worth something if it stays true, and a boundary kept by reading
  // two lists of `register*` calls is one that a new route joins the wrong side of. `onRoute`
  // fires once per registration, so the test can assert over what the instance *has* rather than
  // over a list somebody remembered to update.
  const registered: string[] = [];
  app.addHook('onRoute', (route) => {
    if (!registered.includes(route.path)) registered.push(route.path);
  });
  app.decorate(ROUTE_PATHS, registered);

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
   * A request whose shape this build does not accept.
   *
   * The reason code says which gate refused - `13` has clients branch on codes and never on
   * message text - and the message deliberately says nothing about which field, because a schema
   * refusal is about the envelope rather than about a value somebody chose. A domain refusal names
   * the field; this one cannot, and pretending otherwise would point a form at the wrong control.
   */
  function badRequest(reply: FastifyReply, ctx: RequestContext, reasonCode: string): FastifyReply {
    return fail(
      reply,
      domainError('VALIDATION_FAILED', 'Invalid request.', { reason_code: reasonCode }),
      ctx.correlationId,
    );
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
    unprovisioned?: UnprovisionedRoute,
  ): Promise<RequestContext | null> {
    const correlationId = correlationIdOf(request);
    const principal = await options.authenticate(request);

    if (!principal) {
      // Recorded, because the absence of this line was read as evidence.
      //
      // A token that does not verify produced a `401` and left nothing behind, so "the API log
      // has no 401s in it" was true of every run - including the ones where a phone was being
      // refused - and a device scenario was diagnosed against that silence. The route and the
      // method, never the token and never a subject: there is no verified subject to name here,
      // and `13` does not let this API become an oracle for which credentials exist. What the
      // line answers is only "did this process refuse anybody", which is the question an
      // operator was already asking it.
      options.logger.warn('api.request.unauthenticated', {
        method: request.method,
        route: request.routeOptions?.url ?? request.url.split('?')[0] ?? request.url,
        correlation_id: correlationId,
      });
      fail(reply, domainError('UNAUTHENTICATED', 'No valid session.'), correlationId);
      return null;
    }

    // A verified subject is not yet an account (DEC-124). This is what makes a deletion take
    // effect on the caller's very next request: a Supabase access token is verified locally
    // against a published key set, so nothing here can know its session was signed out, and the
    // token goes on verifying until `exp`. The server refusing a subject it no longer recognises
    // is the only thing that is immediate.
    //
    // One route is exempt and only one, because it is the route that creates the account.
    if (unprovisioned === undefined) {
      const state = await options.pool.withUser(principal.userId, resolveAccountState);
      if (state !== 'ACTIVE') {
        // The reason reaches the log and never the caller. `13` does not let this API be an
        // oracle, and "deleted" versus "never existed" is exactly the fact a deletion removes.
        options.logger.warn('api.account.refused', {
          reason: state,
          correlation_id: correlationId,
        });
        fail(reply, domainError('UNAUTHENTICATED', 'No valid session.'), correlationId);
        return null;
      }
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
  // The two surfaces
  // -------------------------------------------------------------------------
  // `13`: "Internal/admin APIs are separately authenticated/authorized and **not exposed as
  // user APIs**." Until this split they were separately authorized and served on one origin,
  // which is half the sentence. A staff route is now absent from a household process rather
  // than merely refused by it - the phone talks to an origin where `/v1/reviewer/queue` does
  // not exist, and answers 404 because there is no handler, not because a check declined.
  //
  // The surface is required rather than defaulted. A default would decide, for every future
  // route, which side of a security boundary it lands on - and it would decide silently.

  function registerHouseholdSurface(): void {
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
          household_id: string;
          display_name: string;
          age_band: string | null;
          is_managed: boolean;
          owner_user_id: string;
        }>(
          `SELECT id, household_id, display_name, age_band, is_managed, owner_user_id
           FROM profile
           WHERE deleted_at IS NULL
           ORDER BY created_at`,
        ),
      );

      return reply.send({
        profiles: result.rows.map((row) => ({
          id: row.id,
          // Which household this profile is in, so a person adding somebody else adds them to the
          // household they are already in rather than to a second one (`04` Phase 1.2). It
          // discloses nothing: an opaque ID, on a row row-level security already admitted, and a
          // caregiver who sent it to `POST /v1/profiles` would be refused by `profile_insert`
          // because they do not own the household.
          householdId: row.household_id,
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
    // GET /v1/profiles/:profileId/capabilities  (`DEV-074`, DEC-141)
    // -------------------------------------------------------------------------
    // What this caller may do on this profile, asked with the predicate the policies apply.
    //
    // WHY A ROUTE AND NOT AN INFERENCE
    // Every surface that offers a control already asks a version of this question, and each asks
    // only its own: `mayRecordDoses` on a shelf page, `mayEdit` and `mayDelete` on an item detail.
    // That is enough for a screen, which offers one thing at a time. It is not enough for Voice
    // Mode, which offers everything from one place and had to answer "what may this caller do"
    // out of whatever screens somebody had happened to open - so a caregiver who had not visited
    // an item detail was told to use the screen for a change they were fully entitled to make
    // (`DEV-074`). The alternative, assuming a capability and letting the route refuse, is a
    // person completing a spoken form for nothing, which is exactly what DEC-116's screen half
    // exists to prevent.
    //
    // THIS AUTHORISES NOTHING
    // It is a report, and every route checks again on the session against row-level security
    // (`11`, `13`). What it decides is only whether a control is **offered**, which is the job
    // `mayRecordDoses` has been doing on the shelf since DEC-116, generalised to a surface that
    // needs the whole set at once.
    //
    // WHY IT DISCLOSES NOTHING
    // Every answer is about the caller's own authorization, and `has_capability` consults
    // `kynviora.current_user_id()` - there is no parameter that could name somebody else. An
    // unknown ID and a profile with no grant are indistinguishable, both answering with an empty
    // list, which is the same thing an empty shelf page already tells them. `13`'s rule that the
    // API does not say "you are not allowed" is about a **refusal** carrying a reason; this is the
    // affirmative report the same chapter requires so a screen can withhold a control rather than
    // offer one the write would refuse.
    //
    // THE VISIBILITY READ IS NOT BELT AND BRACES
    // `has_capability` is `SECURITY DEFINER` and its owner branch filters `deleted_at IS NULL`
    // while its **grant** branch does not - grants are not revoked when a profile is soft-deleted,
    // only purged past `purge_floor()` (migration `0025`). So without this, a caregiver holding a
    // live grant on a profile the owner had deleted would get a populated list from here while
    // every other route on this surface answered empty, and diffing the two would distinguish
    // "deleted" from "never had access". Nothing else on this surface makes that distinction.
    //
    // Asked through the caller's own connection, so `profile_select` is what decides - the same
    // policy every other read on this profile goes through, rather than a second condition here
    // that could drift from it.

    app.get('/v1/profiles/:profileId/capabilities', async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const params = profileIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid profile id.', { reason_code: 'params_schema' }),
          ctx.correlationId,
        );
      }

      // One round trip over the whole vocabulary rather than one per capability. `unnest` keeps
      // the list in the query parameters, so a capability added to `CAREGIVER_CAPABILITIES` is
      // reported here without this route changing - and a capability removed from it stops being
      // reported, rather than lingering as a string nothing can grant.
      //
      // The visibility read is joined into the same statement rather than made as a second one:
      // two statements are two moments, and a profile deleted between them would be reported on.
      const held = await ctx.db((db) =>
        db.query<{ capability: string; held: boolean }>(
          `SELECT c AS capability, kynviora.has_capability($1, c) AS held
             FROM unnest($2::text[]) AS c
            WHERE EXISTS (SELECT 1 FROM profile WHERE id = $1)`,
          [params.data.profileId, [...CAREGIVER_CAPABILITIES]],
        ),
      );

      return reply.send({
        // Only what is held. A list of everything with a boolean beside it would be the same
        // information in a shape that invites a client to render "you cannot do this", which is
        // the sentence `14` and DEC-045 both keep off a screen.
        capabilities: held.rows.filter((row) => row.held).map((row) => row.capability),
        serverTime: ctx.now,
      });
    });

    // -------------------------------------------------------------------------
    // POST /v1/households
    // -------------------------------------------------------------------------
    // `04` Phase 1.2's first expected output. A household is the container every profile hangs
    // off, and until now the only ones that existed were seeded.
    //
    // No ownership is read from the body. `household_insert` requires `owner_user_id` to be the
    // caller, so the row's owner is decided by the request context and the database checks it -
    // there is no code path here that could get it wrong, which is `13`'s "never trust an
    // identifier in the request as proof of access" applied to the row rather than to a lookup.

    app.post('/v1/households', async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      // `13`: idempotency on a mutation that can be retried. Required rather than optional, for
      // the reason POST /v1/items requires it - a caller that may omit it is a caller that will,
      // and two households are worse than two rows on a list: every later record hangs off one,
      // so the copies collect separate items, caregivers and safety history and nothing merges
      // them.
      if (!ctx.operationId) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Idempotency-Key header is required.', {
            reason_code: 'idempotency_key_required',
          }),
          ctx.correlationId,
        );
      }

      const body = householdBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
          ctx.correlationId,
        );
      }

      const normalized = normalizeHouseholdDraft(body.data);
      if (isErr(normalized)) return fail(reply, normalized.error, ctx.correlationId);

      const inserted = await insertOrRefusal(ctx, () =>
        ctx.db((db) =>
          db.query<{ id: string }>(
            `INSERT INTO household (owner_user_id, display_name, client_operation_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (owner_user_id, client_operation_id)
               WHERE client_operation_id IS NOT NULL
               DO NOTHING
             RETURNING id`,
            [ctx.principal.userId, normalized.value.displayName, ctx.operationId],
          ),
        ),
      );

      if (inserted === null) {
        return fail(
          reply,
          domainError('PERMISSION_DENIED', 'You cannot create a household.'),
          ctx.correlationId,
        );
      }

      const created = inserted.rows[0]?.id;
      if (created !== undefined) {
        return reply.status(201).send({
          id: created,
          displayName: normalized.value.displayName,
          replayed: false,
          serverTime: ctx.now,
        });
      }

      // The key has been used by this user before, so this is the same create arriving twice.
      // The stored row is read back rather than the submission echoed, for the reason the item
      // route reads its row back: a retry carrying a changed name would otherwise be told what
      // the body it sent implies, when what exists is the first one.
      const existing = await ctx.db((db) =>
        db.query<{ id: string; display_name: string }>(
          `SELECT id, display_name FROM household
            WHERE owner_user_id = $1 AND client_operation_id = $2 AND deleted_at IS NULL`,
          [ctx.principal.userId, ctx.operationId],
        ),
      );

      const stored = existing.rows[0];
      if (stored === undefined) {
        return fail(
          reply,
          domainError('PERMISSION_DENIED', 'You cannot create a household.'),
          ctx.correlationId,
        );
      }

      return reply.status(200).header('idempotent-replay', 'true').send({
        id: stored.id,
        displayName: stored.display_name,
        replayed: true,
        serverTime: ctx.now,
      });
    });

    // -------------------------------------------------------------------------
    // POST /v1/profiles
    // -------------------------------------------------------------------------
    // `04` Phase 1.2's second expected output, and the thing that makes its first exit criterion
    // - "every item created later must require a profile" - true by construction rather than by
    // there being no profiles at all.
    //
    // `profile_insert` requires that the caller owns the profile *and* owns the household it
    // goes in, so a household ID that belongs to somebody else is refused by the database rather
    // than by a check this handler could forget. The refusal is answered as absence: a household
    // this caller may not write to and one that does not exist are the same answer, so the route
    // is not an oracle for either.

    app.post('/v1/profiles', async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      if (!ctx.operationId) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Idempotency-Key header is required.', {
            reason_code: 'idempotency_key_required',
          }),
          ctx.correlationId,
        );
      }

      const body = profileBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
          ctx.correlationId,
        );
      }

      const normalized = normalizeProfileDraft(body.data);
      if (isErr(normalized)) return fail(reply, normalized.error, ctx.correlationId);
      const draft = normalized.value;

      const inserted = await insertOrRefusal(ctx, () =>
        ctx.db((db) =>
          db.query<{ id: string }>(
            // `self_user_id` is the caller or nothing. There is no parameter that could carry
            // another user, so a profile cannot arrive asserting that somebody else is its
            // subject - `04` Phase 1.2's "clear distinction between account holder and managed
            // profile", made unrepresentable rather than validated.
            //
            // `language_tag` falls to the column default when absent, which is the household's
            // language rather than "no language" - the one place in this route where an absence
            // becomes a value, and it is a rendering choice with no safety meaning.
            `INSERT INTO profile
               (household_id, owner_user_id, self_user_id, display_name, birth_year, age_band,
                language_tag, is_managed, client_operation_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (household_id, client_operation_id)
               WHERE client_operation_id IS NOT NULL
               DO NOTHING
             RETURNING id`,
            [
              body.data.householdId,
              ctx.principal.userId,
              draft.isSelf ? ctx.principal.userId : null,
              draft.displayName,
              draft.birthYear,
              draft.ageBand,
              // The column is NOT NULL with a default, and the default lives in the domain as
              // well so the app and the database cannot render different languages for one
              // profile. A test reads the catalog default and asserts they agree.
              draft.languageTag ?? DEFAULT_LANGUAGE_TAG,
              // A profile somebody made for themselves is not managed; one they made for a
              // relative is. The two columns say different things and are set from the same
              // answer, which is the only place they may be derived from one another.
              !draft.isSelf,
              ctx.operationId,
            ],
          ),
        ),
      );

      if (inserted === null) {
        return fail(reply, domainError('NOT_FOUND', 'No such household.'), ctx.correlationId);
      }

      const created = inserted.rows[0]?.id;
      if (created !== undefined) {
        return reply.status(201).send({
          id: created,
          householdId: body.data.householdId,
          displayName: draft.displayName,
          ageBand: draft.ageBand,
          birthYear: draft.birthYear,
          isSelf: draft.isSelf,
          isManaged: !draft.isSelf,
          replayed: false,
          serverTime: ctx.now,
        });
      }

      const existing = await ctx.db((db) =>
        db.query<{
          id: string;
          display_name: string;
          age_band: string | null;
          birth_year: number | null;
          self_user_id: string | null;
          is_managed: boolean;
        }>(
          `SELECT id, display_name, age_band, birth_year, self_user_id, is_managed
             FROM profile
            WHERE household_id = $1 AND client_operation_id = $2 AND deleted_at IS NULL`,
          [body.data.householdId, ctx.operationId],
        ),
      );

      const stored = existing.rows[0];
      if (stored === undefined) {
        return fail(reply, domainError('NOT_FOUND', 'No such household.'), ctx.correlationId);
      }

      return reply
        .status(200)
        .header('idempotent-replay', 'true')
        .send({
          id: stored.id,
          householdId: body.data.householdId,
          displayName: stored.display_name,
          ageBand: stored.age_band,
          birthYear: stored.birth_year,
          isSelf: stored.self_user_id === (ctx.principal.userId as string),
          isManaged: stored.is_managed,
          replayed: true,
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

      const { profileId, itemKind, lifecycleState, verification, attention, limit, cursor } =
        parsed.data;

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
      if (verification) {
        // Any of the three axes in that state. `08` keeps them separate and this filter does not
        // merge them - it asks "is any facet of this item in this state", which is the question a
        // person filtering for CONFLICTING is actually asking.
        params.push(verification);
        const p = `$${params.length}`;
        conditions.push(
          `(identity_verification = ${p} OR formulation_verification = ${p} ` +
            `OR batch_verification = ${p})`,
        );
      }
      if (attention) {
        // Exactly the domain's rule, in SQL, because filtering in the page after paging would
        // return short pages that look like the end of the list. The two agree by construction:
        // both read the same columns against the same UNSETTLED_VERIFICATIONS, and a test asserts
        // the route and `attentionReasons` classify the same rows.
        const unsettled = `('CONFLICTING','UNVERIFIED')`;
        const needsVerification =
          `(identity_verification IN ${unsettled} ` +
          `OR formulation_verification IN ${unsettled} ` +
          `OR batch_verification IN ${unsettled})`;
        const needsReview = `(last_reviewed_at IS NULL OR last_safety_checked_at IS NULL)`;
        const clause =
          attention === 'NEEDS_VERIFICATION'
            ? needsVerification
            : attention === 'NEEDS_REVIEW'
              ? needsReview
              : `(${needsVerification} OR ${needsReview})`;
        // A stopped or archived item is never asked to be verified, matching the domain: nothing
        // about it is going to be used, and nagging about finished packs teaches people to ignore
        // the list that matters.
        conditions.push(`(lifecycle_state = 'ACTIVE' AND ${clause})`);
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
        // `04` Phase 2.1's second exit criterion, on the list rather than behind a filter. A
        // person has to be able to see which items need something without knowing to filter for
        // it, so every row carries its own reasons and the filter only narrows.
        attentionReasons: [
          ...attentionReasons({
            identityVerification: asItemVerification(row.identity_verification),
            formulationVerification: asItemVerification(row.formulation_verification),
            batchVerification: asItemVerification(row.batch_verification),
            lastReviewedAt: isoOrNull(row.last_reviewed_at),
            lastSafetyCheckedAt: isoOrNull(row.last_safety_checked_at),
            lifecycleState: row.lifecycle_state,
          }),
        ],
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

      // Whether this caller may record a dose on this profile (migration `0021`).
      //
      // ON THE PAGE, NOT ON EACH ROW. A capability is granted per profile and this list is
      // filtered to one, so a per-item answer would be the same boolean repeated and would invite
      // a screen to believe it could differ between two medicines belonging to one person.
      //
      // Asked separately rather than folded into the item query, because it is a fact about the
      // caller and the profile, not about a row - and a shelf with no items still has to answer
      // it. It confirms nothing an unreachable profile did not already reveal: a profile the
      // caller cannot see returns an empty page, and `has_capability` answers `false` for it.
      const permission = await ctx.db((db) =>
        db.query<{ may_record_doses: boolean }>(
          `SELECT kynviora.has_capability($1, 'RECORD_DOSES') AS may_record_doses`,
          [profileId],
        ),
      );

      return reply.send({
        items: validated.data,
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        mayRecordDoses: permission.rows[0]?.may_record_doses === true,
        serverTime: ctx.now,
      });
    });

    // -------------------------------------------------------------------------
    // POST /v1/items  (`04` Phases 2.2 and 2.3 - manual entry)
    // -------------------------------------------------------------------------
    // The only way anything in this build creates an `owned_item` from a user surface.
    //
    // Written through the caller's own connection, not the service role. `owned_item_insert`
    // requires `MANAGE_SHELF` for a personal-care item and `MANAGE_MEDICINES` for a medicine, and
    // routing this through the policy written for it means the route cannot create an item on a
    // profile the caller could not otherwise write to - the authorization is the policy rather
    // than a check somebody has to remember.
    //
    // WHAT THIS ROUTE WILL NOT DO
    // Touch the catalog. `product_identity_id`, `formulation_id` and `batch_id` are left NULL and
    // there is no code path here that could set one: a household typing a barcode is not the
    // catalog learning one, which is `15` A11 with the attacker replaced by an honest person
    // mis-reading a label. Promotion is `04` Phase 3.5's corroborated path and stays separate.
    //
    // It also will not set a verification state. The three axes keep migration `0004`'s
    // `UNVERIFIED` default, which is the vocabulary's word for "nobody has checked" rather than a
    // default answer - and `08` reserves `CONFIRMED` for something read off the pack.

    app.post('/v1/items', async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      // `13`: "Idempotency key on mutations that can be retried." A person who taps Save, sees
      // nothing, and taps again would otherwise write a second medicine record - and `04` Phase
      // 8.5 reconciles this shelf against a list somebody was handed, where two identical rows
      // read as two medicines they are taking. Required rather than optional, for the reason the
      // dose-event route requires it: a caller that may omit it is a caller that will.
      if (!ctx.operationId) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Idempotency-Key header is required.', {
            reason_code: 'idempotency_key_required',
          }),
          ctx.correlationId,
        );
      }

      const body = manualEntryBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
          ctx.correlationId,
        );
      }

      // The domain decides what the values may be, so a refusal names the field and the reason.
      const normalized = normalizeManualEntry(body.data);
      if (isErr(normalized)) return fail(reply, normalized.error, ctx.correlationId);
      const entry = normalized.value;

      // `owned_item_insert` refuses a profile this caller may not write to by raising, not by
      // returning no rows, so the refusal is caught here and answered as absence. Only the
      // insufficient-privilege code is mapped: anything else is a real failure and must not be
      // disguised as a missing profile, which would hide a bug behind a plausible answer.
      const inserted = await insertOrRefusal(ctx, () =>
        ctx.db((db) =>
          db.query<{ id: string }>(
            // Every value comes from the submission or is NULL. Nothing here supplies a fallback,
            // which is `04` Phase 2.2's second exit criterion in the one place it could be lost.
            `INSERT INTO owned_item
               (profile_id, item_kind, display_name, brand, manufacturer, market,
                recorded_gtin, recorded_lot_code, expires_on, started_on, notes,
                strength_text, dosage_form, directions_text,
                personal_care_category, ingredient_declaration_raw, label_version_note,
                client_operation_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                     $18)
             -- The index is inferred by its own columns and predicate rather than left bare. A
             -- bare ON CONFLICT DO NOTHING would also swallow a violation of some future
             -- constraint, and report it as a successful retry of something that never happened.
             ON CONFLICT (profile_id, client_operation_id)
               WHERE client_operation_id IS NOT NULL
               DO NOTHING
             RETURNING id`,
            [
              body.data.profileId,
              entry.itemKind,
              entry.displayName,
              entry.brand,
              entry.manufacturer,
              entry.market,
              entry.recordedGtin,
              entry.recordedLotCode,
              entry.expiresOn,
              entry.startedOn,
              entry.notes,
              entry.strengthText,
              entry.dosageForm,
              entry.directionsText,
              entry.personalCareCategory,
              entry.ingredientDeclarationRaw,
              entry.labelVersionNote,
              ctx.operationId,
            ],
          ),
        ),
      );

      if (inserted === null) {
        // Row-level security refused the write. A profile this caller cannot write to and one
        // that does not exist are the same answer, so the route is not an oracle for either.
        return fail(reply, domainError('NOT_FOUND', 'No such profile.'), ctx.correlationId);
      }

      const created = inserted.rows[0]?.id;
      if (created !== undefined) {
        const limits = manualEntryLimits(entry);
        return reply.status(201).send({
          id: created,
          // What this record cannot support, said now rather than the first time an alert fails
          // to arrive and nobody knows why (`10`).
          ...manualEntryOutcomeView([...limits]),
          limitCodes: limits,
          replayed: false,
          serverTime: ctx.now,
        });
      }

      // The key has been used on this profile before, so this is the same save arriving twice.
      // `13`: the server commits exactly once.
      //
      // The stored row is read back rather than the submission echoed. A retry that carried a
      // changed field would otherwise be told what the body it sent implies, when what exists is
      // the first one - and on a screen whose whole subject is what Kynviora does and does not
      // hold about a pack, describing a record nobody has is the failure this route is for.
      const existing = await ctx.db((db) =>
        db.query<{
          id: string;
          recorded_gtin: string | null;
          recorded_lot_code: string | null;
          ingredient_declaration_raw: string | null;
          expires_on: Date | string | null;
        }>(
          `SELECT id, recorded_gtin, recorded_lot_code, ingredient_declaration_raw, expires_on
             FROM owned_item
            WHERE profile_id = $1 AND client_operation_id = $2`,
          [body.data.profileId, ctx.operationId],
        ),
      );

      const stored = existing.rows[0];
      if (stored === undefined) {
        // The conflicting row belongs to a profile this caller cannot read. Answered as the same
        // absence, for the same reason: this route says nothing about what exists elsewhere.
        return fail(reply, domainError('NOT_FOUND', 'No such profile.'), ctx.correlationId);
      }

      const storedLimits = manualEntryLimits({
        ...entry,
        recordedGtin: stored.recorded_gtin,
        recordedLotCode: stored.recorded_lot_code,
        ingredientDeclarationRaw: stored.ingredient_declaration_raw,
        expiresOn: dateOrNull(stored.expires_on),
      });

      return reply
        .status(200)
        .header('idempotent-replay', 'true')
        .send({
          id: stored.id,
          ...manualEntryOutcomeView([...storedLimits]),
          limitCodes: storedLimits,
          replayed: true,
          serverTime: ctx.now,
        });
    });

    // -------------------------------------------------------------------------
    // GET /v1/items/:itemId  (`04` Phase 2.1 item detail)
    // -------------------------------------------------------------------------
    // One item, composed on the server for the same reason the alert detail is (`11`): the
    // copy that says what is not settled and what would settle it is approved wording, and a
    // client that assembled it would carry it in every shipped build.
    //
    // Row-level security is the whole authorization. `owned_item`'s policy requires
    // `VIEW_MEDICINES` or ownership, so an item belonging to somebody else and one that does not
    // exist are the same not-found and this route is not an oracle.

    app.get<{ Params: { itemId: string } }>('/v1/items/:itemId', async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const noSuchItem = domainError('NOT_FOUND', 'No such item.');

      const params = itemParamsSchema.safeParse(request.params);
      // A malformed identifier answers exactly as an unknown one does.
      if (!params.success) return fail(reply, noSuchItem, ctx.correlationId);

      const result = await ctx.db((db) =>
        db.query<{
          id: string;
          item_kind: string;
          display_name: string;
          brand: string | null;
          manufacturer: string | null;
          market: string | null;
          recorded_gtin: string | null;
          recorded_lot_code: string | null;
          lifecycle_state: string;
          version: number;
          may_edit: boolean;
          may_record_doses: boolean;
          may_delete: boolean;
          identity_verification: string;
          formulation_verification: string;
          batch_verification: string;
          strength_text: string | null;
          dosage_form: string | null;
          directions_text: string | null;
          personal_care_category: string | null;
          ingredient_declaration_raw: string | null;
          label_version_note: string | null;
          started_on: Date | string | null;
          stopped_on: Date | string | null;
          expires_on: Date | string | null;
          last_reviewed_at: Date | string | null;
          last_safety_checked_at: Date | string | null;
          notes: string | null;
        }>(
          // The five columns migration `0015` added are read here as well. A field a person can
          // type on the manual-entry form and never see again is one they entered into nothing,
          // and for the ingredient declaration that is Phase 2.3's second exit criterion failing
          // on the read path.
          `SELECT id, item_kind, display_name, brand, manufacturer, market,
                  recorded_gtin, recorded_lot_code, lifecycle_state, version,
                  identity_verification, formulation_verification, batch_verification,
                  strength_text, dosage_form, directions_text, personal_care_category,
                  ingredient_declaration_raw, label_version_note,
                  started_on, stopped_on, expires_on, last_reviewed_at, last_safety_checked_at,
                  notes,
                  -- Whether this caller may change it, evaluated with the same expression the
                  -- owned_item_update policy USING clause uses. Asked here so a screen can
                  -- withhold the control rather than offer one the write would refuse, and asked
                  -- as the policy own predicate so the screen and the policy cannot disagree.
                  kynviora.has_capability(
                    profile_id,
                    CASE WHEN item_kind = 'MEDICINE' THEN 'MANAGE_MEDICINES' ELSE 'MANAGE_SHELF' END
                  ) AS may_edit,
                  -- Whether this caller may record a dose against it, asked exactly as the
                  -- dose_event_insert policy asks it (migration 0021). A separate question from
                  -- may_edit and it has to be: the two capabilities are separate precisely so that
                  -- looking after somebody does not require the grant that can delete their
                  -- prescription (DEV-049).
                  --
                  -- The item kind is not in the predicate, for the same reason 0021's policy has
                  -- no branch - and the screen adds one anyway, because a dose is a medicine's
                  -- idea and buildDoseRecord refuses to build one for a shampoo.
                  kynviora.has_capability(profile_id, 'RECORD_DOSES') AS may_record_doses,
                  -- And whether they may delete it, which is not a capability question at all.
                  -- docs/RETENTION.md section 2: no caregiver capability authorises deletion, so
                  -- this asks about ownership rather than about a grant. owns_profile consults no
                  -- grant, which means there is no path through one - including a capability that
                  -- does not exist yet.
                  kynviora.owns_profile(profile_id) AS may_delete
             FROM owned_item
            WHERE id = $1 AND deleted_at IS NULL`,
          [params.data.itemId],
        ),
      );

      const row = result.rows[0];
      if (row === undefined) return fail(reply, noSuchItem, ctx.correlationId);

      const reasons = attentionReasons({
        identityVerification: asItemVerification(row.identity_verification),
        formulationVerification: asItemVerification(row.formulation_verification),
        batchVerification: asItemVerification(row.batch_verification),
        lastReviewedAt: isoOrNull(row.last_reviewed_at),
        lastSafetyCheckedAt: isoOrNull(row.last_safety_checked_at),
        lifecycleState: row.lifecycle_state,
      });

      return reply.status(200).send({
        ...itemDetailView({
          id: row.id,
          itemKind: row.item_kind,
          displayName: row.display_name,
          brand: row.brand,
          manufacturer: row.manufacturer,
          market: row.market,
          recordedGtin: row.recorded_gtin,
          recordedLotCode: row.recorded_lot_code,
          lifecycleState: row.lifecycle_state,
          identityVerification: row.identity_verification,
          formulationVerification: row.formulation_verification,
          batchVerification: row.batch_verification,
          strengthText: row.strength_text,
          dosageForm: row.dosage_form,
          directionsText: row.directions_text,
          personalCareCategory: row.personal_care_category,
          ingredientDeclarationRaw: row.ingredient_declaration_raw,
          labelVersionNote: row.label_version_note,
          startedOn: dateOrNull(row.started_on),
          stoppedOn: dateOrNull(row.stopped_on),
          expiresOn: dateOrNull(row.expires_on),
          lastReviewedAt: isoOrNull(row.last_reviewed_at),
          lastSafetyCheckedAt: isoOrNull(row.last_safety_checked_at),
          notes: row.notes,
          attentionReasons: reasons,
        }),
        attentionReasonCodes: reasons,
        // What an edit has to send back, and whether to offer one at all.
        version: row.version,
        mayEdit: row.may_edit,
        // And whether to offer the four dose controls at all. Withheld rather than disabled
        // (DEC-045), and withheld on the server's answer rather than the client's guess at what
        // the grant means - `11` puts the decision here, and the screen asking the same predicate
        // the policy applies is what keeps them from disagreeing.
        mayRecordDoses: row.may_record_doses,
        // And whether to offer the delete control. Withheld rather than disabled (DEC-045), and
        // asked as ownership rather than as a capability because deletion is not one: a
        // caregiver holding every capability there is still sees no control here, which is the
        // screen agreeing with `kynviora.delete_owned_item` rather than with a guess at it.
        mayDelete: row.may_delete,
        // The same values again, keyed as the manual-entry form keys them.
        //
        // Not duplication: `categoryFields` and `sharedFields` are presentation - labels, absent
        // notes, and which text is somebody else's words - and an editor needs none of that and
        // cannot use any of it. A form built from rendered labels would have to match on the
        // label text, which is the "branch on message text" `13` forbids one layer down.
        editableValues: {
          displayName: row.display_name,
          brand: row.brand,
          manufacturer: row.manufacturer,
          market: row.market,
          recordedGtin: row.recorded_gtin,
          recordedLotCode: row.recorded_lot_code,
          expiresOn: dateOrNull(row.expires_on),
          startedOn: dateOrNull(row.started_on),
          notes: row.notes,
          strengthText: row.strength_text,
          dosageForm: row.dosage_form,
          directionsText: row.directions_text,
          personalCareCategory: row.personal_care_category,
          ingredientDeclarationRaw: row.ingredient_declaration_raw,
          labelVersionNote: row.label_version_note,
        },
        stoppedOn: dateOrNull(row.stopped_on),
        serverTime: ctx.now,
      });
    });

    // -------------------------------------------------------------------------
    // PATCH /v1/items/:itemId  (`04` Stage 2 - update, archive, review)
    // -------------------------------------------------------------------------
    // Stage 2's expected output is "create, view, update, archive, and review". Phases 2.2 and
    // 2.3 are the first two words; this is the rest, and until it existed the manual-entry screen
    // told people they could "add anything missing later from the item itself" when no surface
    // could.
    //
    // WHY THE VERSION IS REQUIRED
    // `13` sets `owned_item`'s conflict policy to `ASK_USER` (`sync.ts`), so a stale edit must not
    // silently win. The write is conditional on the version the editor was looking at, and a
    // person whose copy has moved is told rather than told their save worked.
    //
    // WHAT ROW-LEVEL SECURITY DECIDES AND WHAT IT DOES NOT
    // `owned_item_update`'s USING clause requires `MANAGE_SHELF` or `MANAGE_MEDICINES`, so a
    // caregiver who may read an item and not change it updates no rows - it filters rather than
    // raising. That makes "refused" and "version moved" the same zero rows, which is why the
    // route re-reads to tell them apart: reporting a refusal as a conflict would send somebody
    // round a retry loop they can never win.

    app.patch<{ Params: { itemId: string } }>('/v1/items/:itemId', async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const noSuchItem = domainError('NOT_FOUND', 'No such item.');

      const params = itemParamsSchema.safeParse(request.params);
      if (!params.success) return fail(reply, noSuchItem, ctx.correlationId);
      const itemId = params.data.itemId;

      const body = itemUpdateBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
          ctx.correlationId,
        );
      }

      const readStored = () =>
        ctx.db((db) =>
          db.query<StoredItemRow>(
            `SELECT id, profile_id, item_kind, version, lifecycle_state, display_name, brand,
                    manufacturer, market, recorded_gtin, recorded_lot_code,
                    expires_on, started_on, stopped_on, notes,
                    strength_text, dosage_form, directions_text,
                    personal_care_category, ingredient_declaration_raw, label_version_note
               FROM owned_item
              WHERE id = $1 AND deleted_at IS NULL`,
            [itemId],
          ),
        );

      const before = (await readStored()).rows[0];
      // An item belonging to somebody else and one that does not exist are the same answer, so
      // this route is not an oracle for an owned-item ID.
      if (before === undefined) return fail(reply, noSuchItem, ctx.correlationId);

      const outcome = normalizeItemUpdate(storedItemFromRow(before), body.data);
      if (isErr(outcome)) return fail(reply, outcome.error, ctx.correlationId);
      const next = outcome.value;

      // The write, conditional on the version. `version` is bumped here rather than by a trigger
      // because the condition and the increment have to be one statement: two would be a race
      // that the whole point of this route is to close.
      const written = await ctx.db((db) =>
        db.query<{ version: number; last_reviewed_at: Date | string | null }>(
          `UPDATE owned_item
              SET display_name = $3,
                  brand = $4,
                  manufacturer = $5,
                  market = $6,
                  recorded_gtin = $7,
                  recorded_lot_code = $8,
                  expires_on = $9,
                  started_on = $10,
                  notes = $11,
                  strength_text = $12,
                  dosage_form = $13,
                  directions_text = $14,
                  personal_care_category = $15,
                  ingredient_declaration_raw = $16,
                  label_version_note = $17,
                  lifecycle_state = $18,
                  stopped_on = $19,
                  -- Stamped by the server, never supplied. A client-set timestamp would let a
                  -- screen claim somebody looked at a medicine at a moment they did not.
                  last_reviewed_at = CASE WHEN $20 THEN now() ELSE last_reviewed_at END,
                  version = version + 1
            WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING version, last_reviewed_at`,
          [
            itemId,
            body.data.expectedVersion,
            next.fields.displayName,
            next.fields.brand,
            next.fields.manufacturer,
            next.fields.market,
            next.fields.recordedGtin,
            next.fields.recordedLotCode,
            next.fields.expiresOn,
            next.fields.startedOn,
            next.fields.notes,
            next.fields.strengthText,
            next.fields.dosageForm,
            next.fields.directionsText,
            next.fields.personalCareCategory,
            next.fields.ingredientDeclarationRaw,
            next.fields.labelVersionNote,
            next.lifecycleState,
            next.stoppedOn,
            next.stampReviewed,
          ],
        ),
      );

      const committed = written.rows[0];
      if (committed === undefined) {
        // Zero rows is three different facts. Re-read to say which, because a refusal reported as
        // a conflict sends somebody round a retry loop they can never win, and a conflict
        // reported as absence tells them their own item is gone.
        const after = (await readStored()).rows[0];
        if (after === undefined) return fail(reply, noSuchItem, ctx.correlationId);

        if (after.version !== body.data.expectedVersion) {
          return fail(
            reply,
            domainError('VERSION_CONFLICT', 'This item changed while you had it open.', {
              reason_code: 'item_version',
              // The current version, so the client can re-read and try again against it. Never a
              // value from the row and never who changed it (`14`, DEC-076).
              currentVersion: after.version,
            }),
            ctx.correlationId,
          );
        }

        // Readable, unchanged, and the update policy admitted nothing: this caller may look and
        // not change. Answered as the same absence every other refusal gives - there is
        // deliberately no outcome in this API meaning "you are not allowed" (trap 89), and the
        // detail's `mayEdit` is what stops a screen offering the control in the first place.
        return fail(reply, domainError('PERMISSION_DENIED', 'No such item.'), ctx.correlationId);
      }

      // Append-only, and the only place the sequence of changes lives: `owned_item` holds one row
      // and this update overwrote the previous values. Field names only - `14` keeps the content
      // of somebody's medicine record out of a log, and "the strength changed" is what an access
      // history needs to be useful.
      await ctx.privileged('AUDIT_WRITE', (db) =>
        db.query(
          `INSERT INTO audit_event
             (actor_user_id, actor_role, action, target_kind, target_id, target_version,
              correlation_id, detail)
           VALUES ($1, 'kynviora_app', 'OWNED_ITEM_UPDATED', 'owned_item', $2, $3, $4, $5::jsonb)`,
          [
            ctx.principal.userId,
            itemId,
            String(committed.version),
            ctx.correlationId,
            JSON.stringify({
              changed_fields: next.changedFields,
              lifecycle_state: next.lifecycleState,
            }),
          ],
        ),
      );

      return reply.status(200).send({
        id: itemId,
        version: committed.version,
        lifecycleState: next.lifecycleState,
        changedFields: next.changedFields,
        lastReviewedAt: isoOrNull(committed.last_reviewed_at),
        serverTime: ctx.now,
      });
    });

    // -------------------------------------------------------------------------
    // Consent  (`04` Phase 1.4)
    // -------------------------------------------------------------------------
    //   GET /v1/consents  - what is in force, for every purpose
    //   PUT /v1/consents  - record a decision, by writing a new receipt
    //
    // STRICTLY THE CALLER'S OWN
    // `consent_select` and `consent_insert` both require `user_id = current_user_id()`, so neither
    // route takes a user and neither could accept one. Consent is the one thing in this product
    // that nobody may exercise on somebody else's behalf, not even a profile owner for a caregiver
    // - which is why these are not profile-scoped routes.
    //
    // WITHDRAWING WRITES A ROW, IT DOES NOT CHANGE ONE
    // `consent_receipt` is append-only by trigger and refuses UPDATE and DELETE to every role
    // including the database owner. A withdrawal is a **new** receipt with `granted = false` that
    // supersedes the previous one, so the history of what somebody agreed to and when is not
    // something a later version of this product can quietly rewrite. That is `04` Phase 1.4's
    // "auditable" half, and it is the database's property rather than this handler's promise.

    app.get('/v1/consents', async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const rows = await ctx.db((db) =>
        db.query<{
          purpose: string;
          granted: boolean;
          policy_version: string;
          locale: string;
          recorded_at: Date | string;
        }>(
          // Every receipt this caller has, newest last. The domain decides which one stands: it
          // reads the newest per purpose rather than following `supersedes_id`, because a chain
          // with a broken link would produce no answer, and "no answer" here means "not granted"
          // - the safe direction, but for the wrong reason.
          `SELECT purpose, granted, policy_version, locale, recorded_at
             FROM consent_receipt
            ORDER BY recorded_at`,
        ),
      );

      const state = consentStateFrom(
        rows.rows.map((row) => ({
          purpose: row.purpose,
          granted: row.granted,
          policyVersion: row.policy_version,
          locale: row.locale,
          recordedAt: isoOrNull(row.recorded_at) ?? ctx.now,
        })),
        CONSENT_POLICY_VERSION,
      );

      return reply.status(200).send({
        policyVersion: CONSENT_POLICY_VERSION,
        consents: state.map((standing) => ({
          purpose: standing.purpose,
          granted: standing.granted,
          everAnswered: standing.everAnswered,
          policyVersion: standing.policyVersion,
          recordedAt: standing.recordedAt,
          // Whether withdrawing it actually stops anything in this build. Reported rather than
          // assumed by a screen, so that when a purpose becomes enforceable the screen follows
          // without anybody remembering to edit it - and so that until then nobody is offered a
          // switch they believe does something (`10`).
          enforcement: standing.enforcement,
          optional: standing.enforcement !== 'REQUIRED',
          stale: standing.stale,
        })),
        serverTime: ctx.now,
      });
    });

    // -------------------------------------------------------------------------
    // PUT /v1/me/time-zone  (`04` Phase 7.5, DEC-119, `DEV-030`)
    // -------------------------------------------------------------------------
    // Where the caller is, so quiet hours can be read in their own night rather than in a
    // server's. Reported by the device, because the device is the only thing that knows - and
    // reported as an IANA zone rather than an offset, because an offset is a number that is wrong
    // twice a year and what it decides is whether somebody is woken at three in the morning.
    //
    // WHY IT IS `me` AND TAKES NO USER ID
    // `13`: a request never carries proof of whose it is. The row updated is the caller's, decided
    // by `app_user_self_update`'s USING clause rather than by anything in the body - so there is
    // no identifier to validate and none to get wrong.
    //
    // WHY NO STEP-UP
    // It is not a high-impact action under `14`: it changes when a notification arrives and
    // nothing about what is in it, and the worst a wrong value does is deliver at an inconvenient
    // hour or fail to hold. Requiring re-authentication for it would be friction on the one thing
    // a device should be able to keep current by itself.

    app.put('/v1/me/time-zone', async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const body = timeZoneBodySchema.safeParse(request.body ?? {});
      if (!body.success) return badRequest(reply, ctx, 'body_schema');

      // `null` is a real answer: a device that cannot determine its zone says so, and the stored
      // value goes back to unknown rather than staying at whatever was true last month. Silence
      // there would be a stale zone deciding somebody's night from a different continent.
      const zone = body.data.timeZone === null ? null : asTimeZone(body.data.timeZone);
      if (body.data.timeZone !== null && zone === null) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Not a time zone this system knows.', {
            reason_code: 'time_zone',
            field: 'timeZone',
          }),
          ctx.correlationId,
        );
      }

      // Row-level security is the whole authorization: `app_user_self_update` admits the caller's
      // own row and no other, so this statement cannot reach anybody else's whatever it says.
      const written = await ctx.db((db) =>
        db.query<{ time_zone: string | null }>(
          `UPDATE app_user
              SET time_zone = $1
            WHERE id = kynviora.current_user_id() AND deleted_at IS NULL
        RETURNING time_zone`,
          [zone],
        ),
      );

      if (written.rows.length === 0) {
        return fail(reply, domainError('NOT_FOUND', 'No such account.'), ctx.correlationId);
      }

      return reply.status(200).send({
        timeZone: written.rows[0]?.time_zone ?? null,
        // What the value is for, and what an absent one means. `18` asks a screen to be able to
        // say what a setting does; this is the sentence it says it with, and it is the server's
        // rather than a client's because the behaviour is the server's.
        quietHoursNote:
          written.rows[0]?.time_zone === null || written.rows[0]?.time_zone === undefined
            ? 'Kynviora does not know what time it is where you are, so nothing is held back overnight.'
            : 'Quiet hours are read in this time zone.',
        serverTime: ctx.now,
      });
    });

    app.put('/v1/consents', async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const body = consentBodySchema.safeParse(request.body ?? {});
      if (!body.success) return badRequest(reply, ctx, 'body_schema');

      const normalized = normalizeConsentDecision(body.data);
      if (isErr(normalized)) return fail(reply, normalized.error, ctx.correlationId);
      const decision = normalized.value;

      // The previous standing receipt for this purpose, so the new one can point at it. Read
      // through the RLS-scoped connection, so it can only ever be the caller's own.
      const previous = await ctx.db((db) =>
        db.query<{ id: string }>(
          `SELECT id FROM consent_receipt
            WHERE purpose = $1
            ORDER BY recorded_at DESC
            LIMIT 1`,
          [decision.purpose],
        ),
      );

      const written = await insertOrRefusal(ctx, () =>
        ctx.db((db) =>
          db.query<{ id: string; recorded_at: Date | string }>(
            // `user_id` comes from the request context and `policy_version` from the server. A
            // client that could name either could record agreement, on somebody's behalf, to a
            // text nobody showed them.
            `INSERT INTO consent_receipt
               (user_id, purpose, granted, policy_version, locale, supersedes_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, recorded_at`,
            [
              ctx.principal.userId,
              decision.purpose,
              decision.granted,
              CONSENT_POLICY_VERSION,
              decision.locale,
              previous.rows[0]?.id ?? null,
            ],
          ),
        ),
      );

      const receipt = written?.rows[0];
      if (receipt === undefined) {
        return fail(
          reply,
          domainError('PERMISSION_DENIED', 'That is not yours to answer.'),
          ctx.correlationId,
        );
      }

      // `04` Phase 1.4's "auditable". The purpose and the answer only - both are closed
      // vocabularies and neither says anything about anybody's health (`14`).
      await ctx.privileged('AUDIT_WRITE', (db) =>
        db.query(
          `INSERT INTO audit_event
             (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
           VALUES ($1, 'kynviora_app', $2, 'consent_receipt', $3, $4, $5::jsonb)`,
          [
            ctx.principal.userId,
            decision.granted ? 'CONSENT_GRANTED' : 'CONSENT_WITHDRAWN',
            receipt.id,
            ctx.correlationId,
            JSON.stringify({
              purpose: decision.purpose,
              policy_version: CONSENT_POLICY_VERSION,
              locale: decision.locale,
            }),
          ],
        ),
      );

      return reply.status(200).send({
        purpose: decision.purpose,
        granted: decision.granted,
        policyVersion: CONSENT_POLICY_VERSION,
        locale: decision.locale,
        recordedAt: isoOrNull(receipt.recorded_at) ?? ctx.now,
        // What this answer actually changes, said back rather than assumed by the screen.
        enforcement: consentEnforcement(decision.purpose),
        serverTime: ctx.now,
      });
    });

    // -------------------------------------------------------------------------
    // Health context  (`04` Phase 1.3)
    // -------------------------------------------------------------------------
    // Allergy and sensitivity records: the narrow profile context the MVP safety rules actually
    // consult, and the only profile data the rule engine personalises on.
    //
    // WHY NO ROUTE TAKES A PROVENANCE
    // Phase 1.3's first exit criterion is "no OCR or inferred fact silently becomes a confirmed
    // diagnosis". None of the bodies below has a `provenance` field and neither does the domain
    // draft, so there is nothing to validate: it is derived from whether the caller owns the
    // profile, and `provenanceForRelationship` can only ever answer `USER_REPORTED` or
    // `CAREGIVER_ENTERED`. `IMPORTED` and `REVIEWER_CONFIRMED` are in the column's vocabulary and
    // unreachable from this surface. The second exit criterion - "rules can explicitly require a
    // provenance level" - is already met by `requiredProfileProvenance` in the engine, and the two
    // only fit together because the first is enforced by absence.
    //
    // MANAGE_MEDICINES, NOT MANAGE_SHELF
    // The policies in migration `0004` say so, and the split is deliberate: `08.2` keeps a
    // caregiver's safety-alert permission separate from data access, and health context is the
    // most sensitive profile data there is. A caregiver who may add a shampoo to the shelf must
    // not thereby be able to read what somebody is allergic to.

    app.post<{ Params: { profileId: string } }>(
      '/v1/profiles/:profileId/health-facts',
      async (request, reply) => {
        const ctx = await contextFor(request, reply);
        if (!ctx) return;

        const params = profileIdParamsSchema.safeParse(request.params);
        if (!params.success) return badRequest(reply, ctx, 'params_schema');

        const body = healthFactBodySchema.safeParse(request.body ?? {});
        if (!body.success) return badRequest(reply, ctx, 'body_schema');

        const normalized = normalizeHealthFactDraft(body.data);
        if (isErr(normalized)) return fail(reply, normalized.error, ctx.correlationId);
        const draft = normalized.value;

        // Who is asking, which is the only thing that decides provenance. Read before the write
        // rather than after, because the value goes into the row.
        const provenance = provenanceForRelationship(
          (await ownsProfileHere(ctx, params.data.profileId)) ? 'OWNER' : 'CAREGIVER',
        );

        // `allergy_insert` requires MANAGE_MEDICINES on this profile and refuses by raising, so
        // the refusal is caught and answered as absence - a profile this caller may not write to
        // and one that does not exist are the same answer.
        // `04` Phase 5.2. The term is looked up in the seeded vocabulary and the outcome is
        // stored, so whether a rule can see this record is a fact on the row rather than something
        // a read path re-derives (DEC-098). Nothing here writes to the vocabulary: a household
        // typing "penicillin" is not the catalog learning a substance (`08`, `15` A11), and an
        // unresolved term stays unresolved, which is the honest state rather than a penalty.
        const mapping = await resolveTermForProfile(ctx, draft.displayTerm);

        const inserted = await insertOrRefusal(ctx, () =>
          ctx.db((db) =>
            db.query<{ id: string; version: number }>(
              // `substance_id` and the state are written together; migration `0019` refuses the
              // pair if they disagree, so a record cannot claim a rule can see it while carrying
              // no substance.
              `INSERT INTO allergy_record
                 (profile_id, record_kind, display_term, provenance, certainty, noted_on,
                  substance_id, substance_mapping_state)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING id, version`,
              [
                params.data.profileId,
                draft.kind,
                draft.displayTerm,
                provenance,
                draft.certainty,
                draft.notedOn,
                mapping.substanceId,
                mapping.mappingState,
              ],
            ),
          ),
        );

        const created = inserted?.rows[0];
        if (created === undefined) {
          return fail(reply, domainError('NOT_FOUND', 'No such profile.'), ctx.correlationId);
        }

        // `04` Phase 1.3 asks for an edit history. Field names and the derived provenance only -
        // `14` keeps the content of somebody's health record out of a log, and what an access
        // history needs is that a fact was added and where it was said to come from.
        await ctx.privileged('AUDIT_WRITE', (db) =>
          db.query(
            `INSERT INTO audit_event
               (actor_user_id, actor_role, action, target_kind, target_id, target_version,
                correlation_id, detail)
             VALUES ($1, 'kynviora_app', 'HEALTH_FACT_ADDED', 'allergy_record', $2, $3, $4,
                     $5::jsonb)`,
            [
              ctx.principal.userId,
              created.id,
              String(created.version),
              ctx.correlationId,
              // The mapping state as well: it decides whether a rule can act on this record, and
              // an access history that could not say when that changed would be missing the one
              // consequence. Never the term itself (`14`).
              JSON.stringify({
                record_kind: draft.kind,
                provenance,
                substance_mapping_state: mapping.mappingState,
              }),
            ],
          ),
        );

        return reply.status(201).send({
          id: created.id,
          version: created.version,
          kind: draft.kind,
          displayTerm: draft.displayTerm,
          certainty: draft.certainty,
          // Reported back so a screen can say where the fact came from rather than assume. It is
          // the server's answer about the caller, not an echo of anything they sent.
          provenance,
          notedOn: draft.notedOn,
          lastReviewedAt: null,
          // `04` Phase 5.2. Whether a rule can see this, and if not, which of the two reasons.
          substanceMappingState: mapping.mappingState,
          matchesCanonicalSubstance: mapping.mappingState === 'EXACT',
          serverTime: ctx.now,
        });
      },
    );

    app.get<{ Params: { profileId: string } }>(
      '/v1/profiles/:profileId/health-facts',
      async (request, reply) => {
        const ctx = await contextFor(request, reply);
        if (!ctx) return;

        const params = profileIdParamsSchema.safeParse(request.params);
        if (!params.success) return badRequest(reply, ctx, 'params_schema');

        // No capability check here. `allergy_select` requires VIEW_MEDICINES, so a caller without
        // it reads an empty list rather than a refusal - which is the same thing a profile with no
        // records looks like, and this route is not an oracle for either.
        const rows = await ctx.db((db) =>
          db.query<{
            id: string;
            record_kind: string;
            display_term: string;
            substance_id: string | null;
            substance_mapping_state: string;
            provenance: string;
            certainty: string;
            noted_on: Date | string | null;
            last_reviewed_at: Date | string | null;
            version: number;
          }>(
            `SELECT id, record_kind, display_term, substance_id, substance_mapping_state,
                    provenance, certainty, noted_on, last_reviewed_at, version
               FROM allergy_record
              WHERE profile_id = $1 AND deleted_at IS NULL
              ORDER BY created_at`,
            [params.data.profileId],
          ),
        );

        return reply.status(200).send({
          profileId: params.data.profileId,
          facts: rows.rows.map((row) => ({
            id: row.id,
            kind: row.record_kind,
            displayTerm: row.display_term,
            provenance: row.provenance,
            certainty: row.certainty,
            notedOn: dateOrNull(row.noted_on),
            lastReviewedAt: isoOrNull(row.last_reviewed_at),
            version: row.version,
            // Whether this fact can drive a rule that matches on canonical substances. Reported
            // rather than left for a screen to infer from a null: `04` Phase 5.2 makes the mapping
            // the catalog's business, and an unmapped term is a real state a person should see.
            matchesCanonicalSubstance: row.substance_id !== null,
            // And *why*, for the two ways of not being mapped. "Kynviora does not know that word"
            // is a gap in a licensed vocabulary and nothing the person can act on; "that word
            // means more than one thing here" is something they can fix by being more specific,
            // and telling them apart is what `10` asks for (DEC-098). Read from the column rather
            // than resolved again, because a re-resolution can disagree with the mapping actually
            // stored on the row - which is what `DEV-028` was closed for one level up.
            substanceMappingState: row.substance_mapping_state,
          })),
          serverTime: ctx.now,
        });
      },
    );

    // -------------------------------------------------------------------------
    // PATCH /v1/health-facts/:factId
    // -------------------------------------------------------------------------
    // Conditional on the version, for the reason the item edit is: `sync.ts` sets
    // `allergy_record`'s conflict policy to `ASK_USER`, and losing a recorded allergy to a stale
    // offline edit is the case that policy exists for.

    app.patch<{ Params: { factId: string } }>(
      '/v1/health-facts/:factId',
      async (request, reply) => {
        const ctx = await contextFor(request, reply);
        if (!ctx) return;

        const noSuchFact = domainError('NOT_FOUND', 'No such record.');

        const params = factIdParamsSchema.safeParse(request.params);
        if (!params.success) return fail(reply, noSuchFact, ctx.correlationId);
        const factId = params.data.factId;

        const body = healthFactChangeBodySchema.safeParse(request.body ?? {});
        if (!body.success) return badRequest(reply, ctx, 'body_schema');

        const normalized = normalizeHealthFactChange(body.data);
        if (isErr(normalized)) return fail(reply, normalized.error, ctx.correlationId);
        const change = normalized.value;

        if (isEmptyHealthFactChange(change)) {
          // An ordinary thing to do - open the form, change nothing, press save. Told apart by its
          // reason code rather than by message text (`13`), so a screen can show a plain note
          // instead of the panel a malformed date gets. Refused rather than committed because an
          // empty save moves the version and becomes somebody else's conflict.
          return fail(
            reply,
            domainError('VALIDATION_FAILED', 'Nothing was changed.', {
              reason_code: 'empty_change',
            }),
            ctx.correlationId,
          );
        }

        const readStored = () =>
          ctx.db((db) =>
            db.query<{ id: string; version: number }>(
              `SELECT id, version FROM allergy_record WHERE id = $1 AND deleted_at IS NULL`,
              [factId],
            ),
          );

        const before = (await readStored()).rows[0];
        if (before === undefined) return fail(reply, noSuchFact, ctx.correlationId);

        // `04` Phase 5.2. A new term is a new lookup, and it must be: a record whose wording
        // changed while keeping the mapping the old wording earned would drive a rule on a
        // substance nobody typed - which is the silent becoming Phase 1.3's exit criterion is
        // written against, one level down. Resolved only where the term actually changed, so
        // marking a record as checked is not a re-resolution against a vocabulary that has moved.
        const remapped =
          change.displayTerm === null ? null : await resolveTermForProfile(ctx, change.displayTerm);

        const written = await ctx.db((db) =>
          db.query<{
            version: number;
            last_reviewed_at: Date | string | null;
            substance_mapping_state: string;
          }>(
            `UPDATE allergy_record
                SET display_term = COALESCE($3, display_term),
                    certainty = COALESCE($4, certainty),
                    noted_on = CASE WHEN $5 THEN NULL
                                    WHEN $6::date IS NOT NULL THEN $6::date
                                    ELSE noted_on END,
                    -- Stamped by the server, never supplied. A client-set timestamp would let a
                    -- screen claim somebody checked an allergy at a moment they did not.
                    last_reviewed_at = CASE WHEN $7 THEN now() ELSE last_reviewed_at END,
                    -- Both together, or neither. Migration 0019 refuses the pair if they
                    -- disagree, so there is no ordering of these two assignments that can leave
                    -- the row claiming a rule can see it while carrying no substance.
                    substance_id = CASE WHEN $8 THEN $9::uuid ELSE substance_id END,
                    substance_mapping_state =
                      CASE WHEN $8 THEN $10 ELSE substance_mapping_state END,
                    version = version + 1
              WHERE id = $1 AND version = $2 AND deleted_at IS NULL
          RETURNING version, last_reviewed_at, substance_mapping_state`,
            [
              factId,
              body.data.expectedVersion,
              change.displayTerm,
              change.certainty,
              change.clearNotedOn,
              change.notedOn,
              change.markReviewed,
              remapped !== null,
              remapped?.substanceId ?? null,
              remapped?.mappingState ?? 'UNRESOLVED',
            ],
          ),
        );

        const committed = written.rows[0];
        if (committed === undefined) {
          // Zero rows is three facts. Re-read to say which: a refusal reported as a conflict sends
          // somebody round a retry loop they can never win, and a conflict reported as absence
          // tells them their own record is gone.
          const after = (await readStored()).rows[0];
          if (after === undefined) return fail(reply, noSuchFact, ctx.correlationId);

          if (after.version !== body.data.expectedVersion) {
            return fail(
              reply,
              domainError('VERSION_CONFLICT', 'This record changed while you had it open.', {
                reason_code: 'health_fact_version',
                currentVersion: after.version,
              }),
              ctx.correlationId,
            );
          }

          // Readable and not writable: VIEW_MEDICINES without MANAGE_MEDICINES. Answered as the
          // same absence every other refusal gives (trap 89).
          return fail(
            reply,
            domainError('PERMISSION_DENIED', 'No such record.'),
            ctx.correlationId,
          );
        }

        const changedFields = [
          ...(change.displayTerm === null ? [] : ['displayTerm']),
          ...(change.certainty === null ? [] : ['certainty']),
          ...(change.notedOn === null && !change.clearNotedOn ? [] : ['notedOn']),
        ];

        await ctx.privileged('AUDIT_WRITE', (db) =>
          db.query(
            `INSERT INTO audit_event
               (actor_user_id, actor_role, action, target_kind, target_id, target_version,
                correlation_id, detail)
             VALUES ($1, 'kynviora_app', 'HEALTH_FACT_UPDATED', 'allergy_record', $2, $3, $4,
                     $5::jsonb)`,
            [
              ctx.principal.userId,
              factId,
              String(committed.version),
              ctx.correlationId,
              // Field names, whether it was reviewed, and where the mapping ended up. Never the
              // term itself (`14`).
              JSON.stringify({
                changed_fields: changedFields,
                reviewed: change.markReviewed,
                substance_mapping_state: committed.substance_mapping_state,
              }),
            ],
          ),
        );

        return reply.status(200).send({
          id: factId,
          version: committed.version,
          changedFields,
          lastReviewedAt: isoOrNull(committed.last_reviewed_at),
          // Read back from the row rather than from `remapped`, so an edit that did not touch the
          // term reports what the record actually carries instead of a default this handler chose.
          substanceMappingState: committed.substance_mapping_state,
          matchesCanonicalSubstance: committed.substance_mapping_state === 'EXACT',
          serverTime: ctx.now,
        });
      },
    );

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
        //
        // Scoped to the item, which since `0030` is the scope the index enforces. A conflict now
        // means the same key on the same item, so the row this reads back is unambiguously the
        // caller's own - it used to mean "somebody, anywhere, used this UUID", and the read then
        // found nothing and reported a dose as recorded that was never recorded (`DEV-031`).
        //
        // `id: null` survives and now means one thing: already recorded, and not readable by this
        // caller. That is a real case since DEC-116 - a caregiver may hold `RECORD_DOSES` and not
        // the capability that admits `dose_event_select`.
        if (/duplicate key|dose_event_idempotency/i.test(message)) {
          const existing = await ctx.db((db) =>
            db.query<{ id: string }>(
              `SELECT id FROM dose_event WHERE owned_item_id = $1 AND client_operation_id = $2`,
              [ownedItemId, ctx.operationId],
            ),
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
    // Alert detail and explainability (spec 04 Phase 7.3)
    // -------------------------------------------------------------------------
    // A household route, and one of the few that composes approved safety wording server-side.
    // `11` puts safety composition on the server: a client that assembled the message would hold
    // the approved templates, the withheld-reference rule and the known-versus-inferred labelling
    // in every build that ever shipped.

    registerAlertDetailRoutes(app, {
      contextFor,
      fail,
      monitoredJurisdictions: async () => {
        const sources = await options.loadSources();
        const jurisdictions = new Set<string>();
        for (const source of sources.values()) {
          if (source.jurisdiction !== null && source.jurisdiction !== undefined) {
            jurisdictions.add(source.jurisdiction);
          }
        }
        // Sorted, so the coverage sentence does not change wording between two identical
        // deployments because a Map iterated differently.
        return [...jurisdictions].sort();
      },
    });

    // -------------------------------------------------------------------------
    // Resolution and the Safety Receipt (spec 04 Phase 7.6)
    // -------------------------------------------------------------------------
    // Recording a resolution writes one row into `safety_receipt` and touches nothing else, which
    // is Phase 7.6's first exit criterion as a shape rather than as a rule. The receipt read shows
    // corrections beside what a person recorded rather than instead of it, which is the second.

    registerSafetyReceiptRoutes(app, { contextFor, fail });

    // -------------------------------------------------------------------------
    // Safety Watch inbox route (spec 04 Phase 7.1)
    // -------------------------------------------------------------------------
    // A household route, and it sat in the staff block until the surfaces were separated.
    // `/v1/profiles/:profileId/safety-inbox` is what a person reads about their own shelf; it
    // was grouped under the reviewer comment by proximity rather than by boundary, and nothing
    // caught it because both surfaces were the same origin. Splitting them made the grouping a
    // compile-time question instead of a comment nobody re-read.

    registerSafetyInboxRoutes(app, { contextFor, fail });

    // -------------------------------------------------------------------------
    // Medicine schedules (spec 04 Phase 4.1)
    // -------------------------------------------------------------------------
    // The write path `medicine_schedule` never had. Migration 0004 built the table, its
    // constraints and its policies, and `@kynviora/safety` has computed occurrences from it since
    // Stage 4 - but no route wrote a row, so Phase 4.2's reminder engine had nothing to read
    // (`DEV-039`). Migration 0020 adds the idempotency key and the version these routes need, and
    // narrows the insert and update policies to `MANAGE_MEDICINES`: until then a caregiver granted
    // read-only access to a person's medicines could have set, moved or silently switched off
    // their reminders.

    registerScheduleRoutes(app, { contextFor, fail });

    // -------------------------------------------------------------------------
    // The Health record (`0032`, DEC-151, DEC-154)
    // -------------------------------------------------------------------------
    // Health became a primary destination when Safety stopped being one, and the four tables
    // behind it are the most sensitive personal data in the product. Nothing here checks a
    // capability: `0032`'s policies require `VIEW_HEALTH_RECORDS` to read and
    // `MANAGE_HEALTH_RECORDS` to write, no existing grant was backfilled either, and a handler
    // that re-checked would be a second opinion able to disagree with the first.

    registerHealthRecordRoutes(app, { contextFor, fail });

    // -------------------------------------------------------------------------
    // DELETE /v1/items/:itemId  (`16` deletion, DEC-117)
    // -------------------------------------------------------------------------
    // The other half of Stage 2. `PATCH` could already archive an item and `DEV-032` recorded
    // that this was being offered where deletion belonged - archiving is "I am done with this",
    // deletion is "I want this gone", and answering the second with the first tells somebody
    // their data was removed while it is still on every caregiver's shelf read.
    //
    // Kept in its own module because its authorization is unlike every other item route: the
    // profile owner alone, with fresh step-up, through a privileged write the app role cannot
    // make at all (`DEV-057`).

    // -------------------------------------------------------------------------
    // The account itself (`04` Phase 1.4, `16`, DEC-124, DEC-125, `DEV-062`)
    // -------------------------------------------------------------------------
    // The two routes that may run without an account: one creates it, the other finishes
    // removing it after an interruption. Everything else in this surface is refused for a
    // subject the server does not recognise.

    registerAccountRoutes(app, { contextFor, fail, provider: options.authProvider ?? null });

    registerItemDeletionRoutes(app, { contextFor, fail });
    registerProfileDeletionRoutes(app, { contextFor, fail });

    // -------------------------------------------------------------------------
    // GET /v1/export  (`04` Phase 1.4, `16` export)
    // -------------------------------------------------------------------------
    // The export half of `DEV-036`. Row-level security decides what is in it, so there is no
    // profile parameter and no ownership filter written here - `13` says a profile ID in a
    // request is never proof of access, and the way to honour that is not to take one.

    registerPersonalExportRoutes(app, {
      contextFor,
      fail,
      loadSources: () => options.loadSources(),
    });
  }

  function registerStaffSurface(): void {
    // -------------------------------------------------------------------------
    // Reviewer console routes (spec 04 Phase 6.6)
    // -------------------------------------------------------------------------
    // Staff software, not a user surface. Migration 0012 gives the app role no grant on any of
    // these tables, so every route here is privileged by construction and authorization is the
    // stored reviewer role rather than a claim in the request (spec 14).

    registerReviewerConsoleRoutes(app, { contextFor, fail });
    registerOperationsRoutes(app, { contextFor, fail });

    // -------------------------------------------------------------------------
    // Shadow-run and replay routes (spec 04 Phase 6.7)
    // -------------------------------------------------------------------------
    // The same trust boundary as the console: staff only, and every route privileged because
    // migration 0013 gives the app role no grant. A shadow run writes to shadow_run rather than
    // profile_assessment, so its results have no path to a notification.

    registerShadowModeRoutes(app, { contextFor, fail });
  }

  if (options.surface === 'HOUSEHOLD') registerHouseholdSurface();
  else registerStaffSurface();

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

    // A uniqueness rule refused the write (DEC-129, `DEV-068`). Handled here rather than in
    // `insertOrRefusal`, because a `23505` can come out of any statement and only some writes go
    // through that wrapper - the routes that answer their own duplicates, by reading the stored
    // row back under an idempotency key, never reach this at all because `ON CONFLICT DO NOTHING`
    // raises nothing.
    //
    // The constraint name is logged and never sent. A unique index is enforced over every row in
    // the table, including the rows row-level security hides from this caller, so naming the rule
    // that refused would say something about data they were never allowed to read. The driver's
    // `detail` field carries the offending value itself and is not read anywhere.
    const constraint = uniqueViolationConstraint(error);
    if (constraint !== null) {
      options.logger.info('api.write_refused_as_duplicate', {
        correlation_id: correlationId,
        constraint,
      });
      return fail(reply, domainError('ALREADY_EXISTS', 'This already exists.'), correlationId);
    }

    // Never surface an internal message: it may contain a query fragment or a value.
    options.logger.error('api.unhandled_error', { correlation_id: correlationId });
    return fail(reply, domainError('INTERNAL', 'Something went wrong.'), correlationId);
  });

  return app;
}

/** Re-exported so tests can assert against the same codes the routes use. */
export { isErr, type DomainError, type UserId };
