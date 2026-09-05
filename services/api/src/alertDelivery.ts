/**
 * Caregiver alert delivery routes, and the dispatch that feeds them.
 *
 * Spec references: `04` Phase 8.2, `03` group H (separate permission for safety alerts; generic
 * notification content by default), `16` (caregiver notifications reveal minimal information by
 * default; grant capabilities are human-readable), `15` A6 (notification leaking to a lock
 * screen), `14` (step-up for caregiver administration), `13` (notification dispatch is a
 * privileged server-only operation), `09`/`19` (a withdrawn alert must stop being actionable).
 *
 *   GET  /v1/profiles/:profileId/notification-settings   - the ceiling, my preference, and why
 *   PUT  /v1/profiles/:profileId/notification-preference - my own device, my own setting
 *   PUT  /v1/profiles/:profileId/notification-policy     - the owner's ceiling (step-up)
 *   GET  /v1/profiles/:profileId/alerts                  - the caregiver alert view
 *   GET  /v1/profiles/:profileId/alert-deliveries        - what was sent, and to whom
 *
 * WHY DISPATCH IS NOT A ROUTE
 * {@link dispatchAlert} is an exported function rather than an endpoint, because nothing
 * user-facing triggers it: a notification goes out because an alert was published or a scheduled
 * dose passed its window, not because someone made a request. Giving it a URL would create an
 * authorization question that does not otherwise exist - who may cause a notification to be sent
 * to somebody else - and the safest answer to a question nobody needs asked is not to ask it.
 *
 * Every read below goes through the RLS-scoped connection, so a caller can only ever see rows
 * their grant already admits. Dispatch is the exception and says so: it runs privileged, because
 * deciding who to notify means reading grants belonging to people other than the caller.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CAPABILITY_FOR_EVENT,
  DEFAULT_NOTIFICATION_DETAIL,
  NOTIFICATION_DETAIL_LEVELS,
  defaultNotificationPolicy,
  deliveryAuditDetail,
  domainError,
  isErr,
  notificationFor,
  resolutionViewFor,
  selectRecipients,
  unsafeId,
  type DeliverableAlertState,
  type DeliverableEventKind,
  type DeliveryCandidate,
  type DeliveryPlan,
  type DomainError,
  type Notification,
  type NotificationDetailLevel,
  type NotificationSubject,
  type ProfileId,
  type ProfileNotificationPolicy,
  type UserId,
  ACTION_URGENCIES,
  deliveryDecision,
  recipientLocalMinute,
  isValidQuietHours,
  type ActionUrgency,
  type DeliveryTiming,
  type QuietHours,
} from '@kynviora/domain';
import { QUIET_HOURS_COPY, quietHoursLabel, urgencyChannelLines } from '@kynviora/presentation';
import type { DatabaseConnection, RequestContext } from './context.js';
import { hasFreshStepUp } from './context.js';

// ---------------------------------------------------------------------------
// Transport port
// ---------------------------------------------------------------------------

/**
 * Where a rendered notification goes.
 *
 * A port, because there is no push provider available here (`BLK-009`) and inventing one would
 * be the kind of fabricated integration the operating brief forbids. The local adapter records
 * what it was asked to send so tests can assert on it; nothing claims a device received anything.
 */
export interface NotificationTransport {
  send(notification: Notification): Promise<void>;
}

/** Records instead of sending. The only transport that exists until `BLK-009` is resolved. */
export function recordingTransport(): NotificationTransport & {
  readonly sent: readonly Notification[];
} {
  const sent: Notification[] = [];
  return {
    sent,
    send(notification: Notification) {
      sent.push(notification);
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const detailLevelSchema = z.enum(NOTIFICATION_DETAIL_LEVELS);

const profileParamsSchema = z.object({ profileId: z.string().uuid() });

const preferenceBodySchema = z.object({ detailLevel: detailLevelSchema });

/**
 * The owner's ceiling, plus the Phase 7.5 half: when a notification may arrive at all.
 *
 * Quiet hours are optional and are set or cleared together - `null` for both means none, and one
 * bound alone is a window whose other end somebody has to invent. The database refuses the same
 * shape (`notification_quiet_hours_paired`), so a request that got past this would still fail.
 */
const policyBodySchema = z
  .object({
    maxCaregiverDetail: detailLevelSchema,
    quietHoursStartMinute: z.number().int().min(0).max(1439).nullable().optional(),
    quietHoursEndMinute: z.number().int().min(0).max(1439).nullable().optional(),
  })
  .refine(
    (body) =>
      ((body.quietHoursStartMinute ?? null) === null) ===
      ((body.quietHoursEndMinute ?? null) === null),
    { message: 'Quiet hours are set or cleared together.' },
  )
  .refine(
    (body) =>
      body.quietHoursStartMinute === null ||
      body.quietHoursStartMinute === undefined ||
      body.quietHoursStartMinute !== body.quietHoursEndMinute,
    // Equal bounds are a zero-length window or a whole-day one depending on which way they are
    // read, and the thing being decided is whether a phone lights up at three in the morning.
    { message: 'Quiet hours must have two different bounds.' },
  );

/**
 * The window on a policy row, or `null`.
 *
 * Both bounds or neither, mirroring `notification_quiet_hours_paired`. A row that somehow held one
 * bound reads as no window rather than as a half-open one, which is the direction that holds
 * nothing back.
 */
function quietHoursFrom(
  row: {
    readonly quiet_hours_start_minute: number | null;
    readonly quiet_hours_end_minute: number | null;
  } | null,
): QuietHours | null {
  if (row === null) return null;
  const start = row.quiet_hours_start_minute;
  const end = row.quiet_hours_end_minute;
  if (start === null || end === null) return null;
  const window = { startMinute: start, endMinute: end };
  return isValidQuietHours(window) ? window : null;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PolicyRow {
  readonly max_caregiver_detail: string;
  readonly quiet_hours_start_minute: number | null;
  readonly quiet_hours_end_minute: number | null;
}

interface PreferenceRow {
  readonly detail_level: string;
}

interface CandidateRow {
  readonly user_id: string;
  readonly relationship: string;
  readonly capabilities: string[] | null;
  readonly grant_accepted: boolean;
  readonly grant_revoked_at: Date | null;
  readonly grant_expires_at: Date | null;
  readonly detail_level: string | null;
  /** `04` Phase 1.4. Never null in practice - the query COALESCEs - and typed as it comes back. */
  readonly notifications_consented: boolean | null;
  readonly caregiver_sharing_consented: boolean | null;
}

interface AlertRow {
  readonly id: string;
  readonly profile_id: string;
  readonly state: string;
  readonly published_at: Date;
  readonly resolution: string | null;
  readonly resolved_at: Date | null;
  readonly resolution_note: string | null;
  readonly item_display_name: string | null;
}

interface DeliveryRow {
  readonly id: string;
  readonly recipient_user_id: string;
  readonly event_kind: string;
  readonly detail_level: string;
  readonly delivered_at: Date;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function asDetailLevel(value: string | null): NotificationDetailLevel | null {
  return value !== null && (NOTIFICATION_DETAIL_LEVELS as readonly string[]).includes(value)
    ? (value as NotificationDetailLevel)
    : null;
}

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

/**
 * The profile's ceiling, or the default when none has been configured.
 *
 * Absence means the *most private* setting. `03` group H requires generic content by default, so
 * a missing row can never be read as permission - which is why this returns the default rather
 * than null and leaves the caller to decide.
 */
async function loadPolicy(
  db: DatabaseConnection,
  profileId: ProfileId,
): Promise<ProfileNotificationPolicy> {
  const res = await db.query<PolicyRow>(
    'SELECT max_caregiver_detail FROM profile_notification_policy WHERE profile_id = $1',
    [profileId],
  );
  const level = asDetailLevel(res.rows[0]?.max_caregiver_detail ?? null);
  if (level === null) return defaultNotificationPolicy(profileId);
  return { profileId, maxCaregiverDetail: level };
}

/** Whether the caller owns this profile. Used to decide who may set the ceiling. */
async function ownsProfile(ctx: RequestContext, profileId: string): Promise<boolean> {
  const res = await ctx.db((db) =>
    db.query<{ owner_user_id: string }>('SELECT owner_user_id FROM profile WHERE id = $1', [
      profileId,
    ]),
  );
  return res.rows[0]?.owner_user_id === ctx.principal.userId;
}

/**
 * Everyone who might be notified about this profile, with their raw grant and consent state.
 *
 * Privileged: choosing recipients means reading grants held by people other than the caller, and
 * there is no row-level predicate that would admit them - the same reason invitation acceptance
 * is privileged. The rows come back raw and the domain decides; nothing is filtered here.
 *
 * `04` Phase 1.4's exit criterion lives on the join below. Each candidate's own `NOTIFICATIONS`
 * standing is their newest receipt, and the profile owner's `CAREGIVER_SHARING` standing is read
 * once and carried on every row - it is a property of the profile rather than of the person being
 * considered. **No receipt is not consent** (`14`), which is why both are `COALESCE`d to `false`
 * rather than to `true`: a person with no row has never agreed to anything.
 */
async function loadCandidates(
  db: DatabaseConnection,
  profileId: ProfileId,
): Promise<readonly DeliveryCandidate[]> {
  const res = await db.query<CandidateRow>(
    // The newest receipt per user for one purpose. `DISTINCT ON` rather than a window function
    // because the answer is a single row per user and the index on
    // (user_id, purpose, recorded_at DESC) serves it directly.
    `WITH notif AS (
       SELECT DISTINCT ON (user_id) user_id, granted
         FROM consent_receipt
        WHERE purpose = 'NOTIFICATIONS'
        ORDER BY user_id, recorded_at DESC
     ),
     sharing AS (
       SELECT DISTINCT ON (cr.user_id) cr.user_id, cr.granted
         FROM consent_receipt cr
         JOIN profile p ON p.owner_user_id = cr.user_id
        WHERE cr.purpose = 'CAREGIVER_SHARING' AND p.id = $1
        ORDER BY cr.user_id, cr.recorded_at DESC
     )
     SELECT p.owner_user_id AS user_id,
            'OWNER'         AS relationship,
            NULL::text[]    AS capabilities,
            true            AS grant_accepted,
            NULL::timestamptz AS grant_revoked_at,
            NULL::timestamptz AS grant_expires_at,
            np.detail_level AS detail_level,
            COALESCE(n.granted, false) AS notifications_consented,
            COALESCE((SELECT granted FROM sharing), false) AS caregiver_sharing_consented
       FROM profile p
       LEFT JOIN notification_preference np
              ON np.profile_id = p.id AND np.user_id = p.owner_user_id
       LEFT JOIN notif n ON n.user_id = p.owner_user_id
      WHERE p.id = $1
      UNION ALL
     SELECT g.grantee_user_id AS user_id,
            'CAREGIVER'       AS relationship,
            g.capabilities    AS capabilities,
            (g.accepted_at IS NOT NULL) AS grant_accepted,
            g.revoked_at      AS grant_revoked_at,
            g.expires_at      AS grant_expires_at,
            np.detail_level   AS detail_level,
            COALESCE(n.granted, false) AS notifications_consented,
            COALESCE((SELECT granted FROM sharing), false) AS caregiver_sharing_consented
       FROM caregiver_grant g
       LEFT JOIN notification_preference np
              ON np.profile_id = g.profile_id AND np.user_id = g.grantee_user_id
       LEFT JOIN notif n ON n.user_id = g.grantee_user_id
      WHERE g.profile_id = $1`,
    [profileId],
  );

  return res.rows.map((row) => ({
    userId: unsafeId<UserId>(row.user_id),
    relationship: row.relationship === 'OWNER' ? ('OWNER' as const) : ('CAREGIVER' as const),
    capabilities: (row.capabilities ?? []) as DeliveryCandidate['capabilities'],
    grantAccepted: row.grant_accepted,
    grantRevokedAt: iso(row.grant_revoked_at) as DeliveryCandidate['grantRevokedAt'],
    grantExpiresAt: iso(row.grant_expires_at) as DeliveryCandidate['grantExpiresAt'],
    detailPreference: asDetailLevel(row.detail_level),
    // `=== true` rather than a truthy read: a driver returning `'t'` or `1` must not become
    // agreement, and neither must a null the COALESCE somehow missed.
    notificationsConsented: row.notifications_consented === true,
    caregiverSharingConsented: row.caregiver_sharing_consented === true,
  }));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchInput {
  readonly profileId: string;
  readonly eventKind: DeliverableEventKind;
  /** Required for `SAFETY_ALERT`, absent for `MISSED_DOSE`. */
  readonly alertPublicationId?: string;
  /** Required for `MISSED_DOSE`: identifies the occurrence, so a repeat does not re-notify. */
  readonly doseOccurrenceKey?: string;
  readonly subject: NotificationSubject;
  /**
   * The urgency this event carries, frozen on the assessment (`04` Phase 7.5).
   *
   * Required, with no default, for the reason `createServer`'s `surface` is required (DEC-066):
   * this decides how loudly Kynviora speaks about somebody's medicine, and a caller that could
   * omit it is a caller that could omit it by accident. A default of `INFORMATIONAL` would be
   * silent - safe, and silently wrong; a default of anything else would be a push nobody chose.
   */
  readonly urgency: ActionUrgency;
  /**
   * The recipient's current minute from local midnight, where anybody knows it.
   *
   * Nobody does yet (`DEV-030`), so quiet hours are computed and hold nothing. Passing `null`
   * rather than guessing is what keeps a CRITICAL recall from waiting for a window that never
   * ends.
   */
  readonly localMinuteOfDay?: number | null;
}

export interface DispatchResult {
  readonly plan: DeliveryPlan;
  readonly sent: readonly Notification[];
  /** Recipients skipped because this exact event had already been delivered to them. */
  readonly alreadyDelivered: readonly UserId[];
  /**
   * The channel and timing this event was allowed (`04` Phase 7.5).
   *
   * Reported rather than only acted on, so a caller and an audit reader can both see that a
   * foreign regulatory difference produced `IN_APP_ONLY` rather than a push that failed quietly.
   */
  readonly timing: DeliveryTiming;
  /** Recipients the timing decision kept off a device. Never silent - `04` asks for the policy. */
  readonly withheldFromDevice: readonly UserId[];
}

/**
 * Decide who is told, record it, and hand each notification to the transport.
 *
 * The order matters. The delivery row is written *before* the transport is called, so a crash
 * between the two produces a recorded delivery that never arrived rather than an arrival nobody
 * recorded - the failure that leaves an alert deliverable again and re-notifies. Deduplication is
 * a unique index rather than a read-then-write, because two dispatches racing would both read
 * "not yet delivered".
 */
/**
 * Whether a quiet-hours window that is set actually holds anything.
 *
 * `false`, and reported to the settings screen so a person who sets a window is not told it is
 * working when it is not. Two reasons, either of which alone is enough:
 *
 *  - Nothing supplies `localMinuteOfDay`. `deliveryDecision` takes the recipient's local minute
 *    rather than computing it, because Kynviora stores no timezone for anybody and a converted
 *    instant would be converted with a number somebody invented (`DEV-030`). With `null`, the
 *    decision does not hold - deliberately, since a `CRITICAL` recall waiting for a window that
 *    never closes is the worse failure.
 *  - Nothing calls {@link dispatchAlert} at all. `BLK-009` - no notification is sent, so there is
 *    nothing for a window to hold back.
 *
 * Flip it when a caller supplies a local minute **and** something dispatches. Flipping it early
 * would put "Kynviora will hold notifications during that window" in front of somebody as a
 * statement of fact, which is the `10` failure this codebase spends the most care avoiding.
 */
export const QUIET_HOURS_APPLIED = false;

export async function dispatchAlert(
  ctx: RequestContext,
  input: DispatchInput,
  transport: NotificationTransport,
): Promise<{ ok: true; value: DispatchResult } | { ok: false; error: DomainError }> {
  const profileId = unsafeId<ProfileId>(input.profileId);

  if (input.eventKind === 'SAFETY_ALERT' && input.alertPublicationId === undefined) {
    return {
      ok: false,
      error: domainError('VALIDATION_FAILED', 'A safety alert delivery needs a publication.', {
        reason_code: 'publication_required',
      }),
    };
  }
  if (input.eventKind === 'MISSED_DOSE' && input.doseOccurrenceKey === undefined) {
    return {
      ok: false,
      error: domainError('VALIDATION_FAILED', 'A missed-dose delivery needs an occurrence key.', {
        reason_code: 'occurrence_key_required',
      }),
    };
  }

  return ctx.privileged('NOTIFICATION_DISPATCH', async (db) => {
    let alertState: DeliverableAlertState | null = null;
    if (input.alertPublicationId !== undefined) {
      const found = await db.query<{ state: string; profile_id: string }>(
        'SELECT state, profile_id FROM alert_publication WHERE id = $1',
        [input.alertPublicationId],
      );
      const row = found.rows[0];
      if (row === undefined) {
        return {
          ok: false as const,
          error: domainError('NOT_FOUND', 'No such alert.'),
        };
      }
      if (row.profile_id !== input.profileId) {
        // Refuse rather than trust the caller's profile: the profile decides whose grants are
        // read, so a mismatch would notify one household about another's alert.
        return {
          ok: false as const,
          error: domainError('VALIDATION_FAILED', 'Alert does not belong to that profile.', {
            reason_code: 'alert_profile_mismatch',
          }),
        };
      }
      alertState = row.state as DeliverableAlertState;
    }

    const [policy, candidates] = await Promise.all([
      loadPolicy(db, profileId),
      loadCandidates(db, profileId),
    ]);

    const policyRow = await db.query<PolicyRow>(
      `SELECT max_caregiver_detail, quiet_hours_start_minute, quiet_hours_end_minute
         FROM profile_notification_policy WHERE profile_id = $1`,
      [profileId],
    );
    const policyQuietHours = quietHoursFrom(policyRow.rows[0] ?? null);

    const decision = selectRecipients(
      { kind: input.eventKind, profileId, alertState },
      candidates,
      policy,
      ctx.now,
    );
    if (isErr(decision)) return { ok: false as const, error: decision.error };
    const plan = decision.value;

    // `04` Phase 7.5. `selectRecipients` decided the audience and the level; this decides the
    // channel and whether to hold. The two are composed rather than merged - a quiet-hours
    // deferral cannot add a recipient and an urgency cannot raise a detail level - and this one
    // runs second so it can only ever quieten what the first allowed.
    //
    // The deduplication flag is `false` here and the unique index below is what actually enforces
    // it: two dispatches racing would both read "not yet delivered", so the constraint decides and
    // the decision reports the ceiling.
    //
    // WHY THIS IS PER RECIPIENT SINCE DEC-119
    // Quiet hours are read in the **recipient's** local time, and two recipients may be in two
    // places: a caregiver in London looking after somebody in Kolkata must not be woken at four in
    // the morning because the household's night is elsewhere. One decision for the whole dispatch
    // was correct only while nobody knew what time it was anywhere, which is what `DEV-030` was.
    //
    // The zones are read in one statement rather than per recipient, because a dispatch to six
    // people should not be six round trips - and read through the service role, which is the only
    // role that may see somebody else's zone at all (`app_user_self_select` is self-only).
    const zoneRows = await db.query<{ id: string; time_zone: string | null }>(
      `SELECT id, time_zone FROM app_user WHERE id = ANY($1::uuid[])`,
      [plan.recipients.map((recipient) => recipient.userId)],
    );
    const zoneOf = new Map(zoneRows.rows.map((row) => [row.id, row.time_zone]));

    /**
     * The decision for one recipient.
     *
     * `input.localMinuteOfDay` still wins where a caller supplied one, because a device reporting
     * its own clock knows better than a zone recorded weeks ago - somebody on a plane is the case
     * that distinguishes them. Where it is absent, the recipient's stored zone answers; where that
     * is unknown too, `recipientLocalMinute` returns `null` and nothing is held.
     */
    const timingFor = (userId: UserId): DeliveryTiming =>
      deliveryDecision({
        urgency: input.urgency,
        deliverable: input.eventKind !== 'SAFETY_ALERT' || alertState === 'PUBLISHED',
        alreadyDelivered: false,
        quietHours: policyQuietHours,
        localMinuteOfDay:
          input.localMinuteOfDay ??
          recipientLocalMinute({ at: ctx.now, zone: zoneOf.get(userId) ?? null }),
      });

    // The dispatch-level answer, for the audit line and the returned summary. It is the decision
    // for a recipient whose local time is unknown, which is the one that does not depend on who is
    // being told - so it reports the channel the urgency permits rather than any one person's
    // night.
    const timing = deliveryDecision({
      urgency: input.urgency,
      deliverable: input.eventKind !== 'SAFETY_ALERT' || alertState === 'PUBLISHED',
      alreadyDelivered: false,
      quietHours: policyQuietHours,
      localMinuteOfDay: input.localMinuteOfDay ?? null,
    });

    const sent: Notification[] = [];
    const alreadyDelivered: UserId[] = [];
    const withheldFromDevice: UserId[] = [];

    for (const recipient of plan.recipients) {
      // This recipient's own decision, in this recipient's own night (DEC-119), computed before
      // the row is written so the row can carry it. It used to be computed after, which is how
      // the channel survived only as a profile-level number in an audit blob - one answer for a
      // dispatch that may have made six different ones (`0028`).
      const recipientTiming = timingFor(recipient.userId);

      const inserted = await db.query<{ id: string }>(
        `INSERT INTO alert_delivery
           (profile_id, recipient_user_id, event_kind, alert_publication_id, dose_occurrence_key,
            detail_level, delivered_at, channel, channel_reason, held)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          input.profileId,
          recipient.userId,
          input.eventKind,
          input.alertPublicationId ?? null,
          input.doseOccurrenceKey ?? null,
          recipient.detailLevel,
          ctx.now,
          recipientTiming.channel,
          recipientTiming.reason,
          recipientTiming.held,
        ],
      );

      if (inserted.rows.length === 0) {
        // The unique index refused it: this person has already been told about this exact event.
        // `07.5` requires a repeated evaluation not to produce a second notification.
        alreadyDelivered.push(recipient.userId);
        continue;
      }

      // The delivery row is written either way: `04` Phase 7.5 asks for a digest policy, and a
      // digest is assembled from what was recorded rather than from what was pushed. What the
      // channel decides is whether anything reaches a device now.
      //
      // Exit criterion 1 arrives here: an INFORMATIONAL event - which is what a foreign
      // regulatory difference defaults to (`09`) - takes this branch and the transport is never
      // called, so there is no push and no digest line to mistake for a personal alert.
      if (recipientTiming.channel !== 'INTERRUPT' || recipientTiming.held) {
        withheldFromDevice.push(recipient.userId);
        continue;
      }

      const notification = notificationFor(recipient, input.subject);
      await transport.send(notification);
      sent.push(notification);
    }

    await db.query(
      `INSERT INTO audit_event
         (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
       VALUES ($1, 'kynviora_service', 'alert.delivery.dispatched', 'alert_delivery', $2, $3,
               $4::jsonb)`,
      [
        ctx.principal.userId,
        input.alertPublicationId ?? null,
        ctx.correlationId,
        // The channel and the reason beside the plan. `20` asks for operational evidence, and
        // "nothing was sent because the urgency was informational" is exactly what an operator
        // investigating a missing notification needs and cannot otherwise reconstruct.
        JSON.stringify({
          ...deliveryAuditDetail(plan),
          channel: timing.channel,
          channel_reason: timing.reason,
          held: timing.held,
          withheld_from_device: withheldFromDevice.length,
        }),
      ],
    );

    return {
      ok: true as const,
      value: { plan, sent, alreadyDelivered, timing, withheldFromDevice },
    };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface AlertDeliveryRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
}

export function registerAlertDeliveryRoutes(
  app: FastifyInstance,
  deps: AlertDeliveryRouteDeps,
): void {
  const { contextFor, fail } = deps;

  function badParams(reply: FastifyReply, correlationId: string) {
    return fail(
      reply,
      domainError('VALIDATION_FAILED', 'Invalid profile id.', { reason_code: 'params_schema' }),
      correlationId,
    );
  }

  // -------------------------------------------------------------------------
  // GET /v1/profiles/:profileId/notification-settings
  // -------------------------------------------------------------------------
  // The ceiling, this caller's own preference, and the level that results. `16` requires grant
  // capabilities to be human-readable, and a setting whose effect the holder cannot see is the
  // same problem: someone who chose NAMED and receives GENERIC deserves to know it is the
  // owner's ceiling doing that, not a bug.

  app.get('/v1/profiles/:profileId/notification-settings', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = profileParamsSchema.safeParse(request.params);
    if (!params.success) return badParams(reply, ctx.correlationId);
    const profileId = unsafeId<ProfileId>(params.data.profileId);

    // RLS decides visibility: the policy row is readable only by the owner or someone holding a
    // notification-bearing capability, so an unrelated caller sees nothing to reason about.
    const visible = await ctx.db(async (db) => {
      const res = await db.query<{ profile_id: string }>(
        `SELECT p.id AS profile_id FROM profile p WHERE p.id = $1`,
        [profileId],
      );
      return res.rows.length > 0;
    });
    if (!visible) {
      return fail(
        reply,
        domainError('PERMISSION_DENIED', 'Profile not reachable.'),
        ctx.correlationId,
      );
    }

    const owner = await ownsProfile(ctx, params.data.profileId);

    const { policy, quietHours, preference } = await ctx.db(async (db) => {
      const policyRow = await db.query<PolicyRow>(
        `SELECT max_caregiver_detail, quiet_hours_start_minute, quiet_hours_end_minute
           FROM profile_notification_policy WHERE profile_id = $1`,
        [profileId],
      );
      const prefRow = await db.query<PreferenceRow>(
        `SELECT detail_level FROM notification_preference
          WHERE profile_id = $1 AND user_id = $2`,
        [profileId, ctx.principal.userId],
      );
      return {
        policy:
          asDetailLevel(policyRow.rows[0]?.max_caregiver_detail ?? null) ??
          DEFAULT_NOTIFICATION_DETAIL,
        quietHours: quietHoursFrom(policyRow.rows[0] ?? null),
        preference: asDetailLevel(prefRow.rows[0]?.detail_level ?? null),
      };
    });

    const chosen = preference ?? DEFAULT_NOTIFICATION_DETAIL;
    // The owner is not capped by the caregiver ceiling; a caregiver is.
    const effective = owner
      ? chosen
      : NOTIFICATION_DETAIL_LEVELS.indexOf(chosen) <= NOTIFICATION_DETAIL_LEVELS.indexOf(policy)
        ? chosen
        : policy;

    return reply.status(200).send({
      profileId: params.data.profileId,
      relationship: owner ? 'OWNER' : 'CAREGIVER',
      maxCaregiverDetail: policy,
      // Null rather than the default, so a client can tell "never chosen" from "chose GENERIC".
      myPreference: preference,
      effectiveDetail: effective,
      cappedByOwner: !owner && effective !== chosen,
      levels: NOTIFICATION_DETAIL_LEVELS,
      // `04` Phase 7.5. Sent to every reader of the settings, not only the owner: a caregiver who
      // receives nothing at 3am deserves to know a window is doing that rather than a bug, which
      // is the same reason the ceiling is readable (`16`).
      quietHours,
      quietHoursLabel:
        quietHours === null ? null : quietHoursLabel(quietHours.startMinute, quietHours.endMinute),
      quietHoursCopy: QUIET_HOURS_COPY,
      // Whether a window that is set actually holds anything today. See the constant.
      quietHoursApplied: QUIET_HOURS_APPLIED,
      // What each urgency does, read from the domain ceiling rather than restated here, so a
      // screen cannot describe a policy the server does not have.
      urgencyChannels: urgencyChannelLines(ACTION_URGENCIES),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // PUT /v1/profiles/:profileId/notification-preference
  // -------------------------------------------------------------------------
  // Your own device, your own setting. No step-up: this cannot widen anyone's access, and the
  // worst it can do to the person changing it is show them less.

  app.put('/v1/profiles/:profileId/notification-preference', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = profileParamsSchema.safeParse(request.params);
    if (!params.success) return badParams(reply, ctx.correlationId);

    const body = preferenceBodySchema.safeParse(request.body);
    if (!body.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
        ctx.correlationId,
      );
    }

    // Written through the RLS-scoped connection on purpose. The INSERT policy requires both that
    // the row is yours and that you actually receive notifications for this profile, so a caller
    // with no relationship to it cannot leave a preference row behind - and the check is the
    // database's, not a condition this handler could forget.
    const written = await ctx
      .db(async (db) => {
        const res = await db.query<{ detail_level: string }>(
          `INSERT INTO notification_preference (user_id, profile_id, detail_level)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, profile_id)
         DO UPDATE SET detail_level = EXCLUDED.detail_level
         RETURNING detail_level`,
          [ctx.principal.userId, params.data.profileId, body.data.detailLevel],
        );
        return res.rows[0] ?? null;
      })
      .catch(() => null);

    if (written === null) {
      return fail(
        reply,
        domainError('PERMISSION_DENIED', 'You do not receive notifications for this profile.'),
        ctx.correlationId,
      );
    }

    return reply.status(200).send({
      profileId: params.data.profileId,
      detailLevel: written.detail_level,
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // PUT /v1/profiles/:profileId/notification-policy
  // -------------------------------------------------------------------------
  // The owner's ceiling. Owner only, and step-up, because raising it widens what leaves the
  // profile onto other people's devices - a change to what caregivers receive, which `14` puts
  // behind re-authentication. MANAGE_CAREGIVERS deliberately does not carry this: a caregiver
  // administrator who could raise the ceiling would change what every other caregiver sees
  // without the owner observing it, the escalation DEC-020 already refuses for delegation.

  app.put('/v1/profiles/:profileId/notification-policy', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    if (!hasFreshStepUp(ctx)) {
      return fail(
        reply,
        domainError('STEP_UP_REQUIRED', 'Confirm your identity to change notification settings.'),
        ctx.correlationId,
      );
    }

    const params = profileParamsSchema.safeParse(request.params);
    if (!params.success) return badParams(reply, ctx.correlationId);

    const body = policyBodySchema.safeParse(request.body);
    if (!body.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
        ctx.correlationId,
      );
    }

    if (!(await ownsProfile(ctx, params.data.profileId))) {
      return fail(
        reply,
        domainError('PERMISSION_DENIED', 'Only the profile owner can change this.'),
        ctx.correlationId,
      );
    }

    await ctx.privileged('NOTIFICATION_DISPATCH', async (db) => {
      await db.query(
        `INSERT INTO profile_notification_policy
           (profile_id, max_caregiver_detail, quiet_hours_start_minute, quiet_hours_end_minute,
            updated_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (profile_id)
         DO UPDATE SET max_caregiver_detail     = EXCLUDED.max_caregiver_detail,
                       quiet_hours_start_minute = EXCLUDED.quiet_hours_start_minute,
                       quiet_hours_end_minute   = EXCLUDED.quiet_hours_end_minute,
                       updated_by_user_id       = EXCLUDED.updated_by_user_id`,
        [
          params.data.profileId,
          body.data.maxCaregiverDetail,
          body.data.quietHoursStartMinute ?? null,
          body.data.quietHoursEndMinute ?? null,
          ctx.principal.userId,
        ],
      );
      await db.query(
        `INSERT INTO audit_event
           (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
         VALUES ($1, 'kynviora_service', 'notification.policy.changed', 'profile', $2, $3,
                 $4::jsonb)`,
        [
          ctx.principal.userId,
          params.data.profileId,
          ctx.correlationId,
          // Minutes of a day, which say nothing about anybody's health. The detail level is a
          // closed vocabulary and safe to record for the same reason.
          JSON.stringify({
            max_caregiver_detail: body.data.maxCaregiverDetail,
            quiet_hours_set: (body.data.quietHoursStartMinute ?? null) !== null,
          }),
        ],
      );
    });

    return reply.status(200).send({
      profileId: params.data.profileId,
      maxCaregiverDetail: body.data.maxCaregiverDetail,
      quietHours:
        (body.data.quietHoursStartMinute ?? null) === null
          ? null
          : {
              startMinute: body.data.quietHoursStartMinute,
              endMinute: body.data.quietHoursEndMinute,
            },
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/profiles/:profileId/alerts
  // -------------------------------------------------------------------------
  // `04` Phase 8.2: "caregiver view of resolution state according to grant". RLS already limits
  // this to holders of VIEW_SAFETY and to published alerts, so the authorization work here is
  // only the part row-level security cannot express: which *columns* of the resolution a
  // caregiver may read.

  app.get('/v1/profiles/:profileId/alerts', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = profileParamsSchema.safeParse(request.params);
    if (!params.success) return badParams(reply, ctx.correlationId);

    const owner = await ownsProfile(ctx, params.data.profileId);

    const rows = await ctx.db(async (db) => {
      const res = await db.query<AlertRow>(
        `SELECT ap.id, ap.profile_id, ap.state, ap.published_at,
                sr.resolution, sr.resolved_at, sr.resolution_note,
                oi.display_name AS item_display_name
           FROM alert_publication ap
           LEFT JOIN safety_receipt sr ON sr.alert_publication_id = ap.id
           LEFT JOIN profile_assessment pa ON pa.id = ap.assessment_id
           LEFT JOIN owned_item oi ON oi.id = pa.owned_item_id
          WHERE ap.profile_id = $1
          ORDER BY ap.published_at DESC`,
        [params.data.profileId],
      );
      return res.rows;
    });

    const relationship = owner ? ('OWNER' as const) : ('CAREGIVER' as const);

    return reply.status(200).send({
      profileId: params.data.profileId,
      relationship,
      alerts: rows.map((row) => {
        const view = resolutionViewFor(
          {
            resolution: row.resolution,
            resolvedAt: iso(row.resolved_at) as never,
            note: row.resolution_note,
          },
          { relationship },
        );
        return {
          alertId: row.id,
          state: row.state,
          publishedAt: row.published_at.toISOString(),
          itemDisplayName: row.item_display_name,
          resolution: view.resolution,
          resolvedAt: view.resolvedAt,
          resolutionNote: view.note,
          resolutionNoteWithheld: view.noteWithheld,
        };
      }),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/profiles/:profileId/alert-deliveries
  // -------------------------------------------------------------------------
  // What was sent, and to whom. RLS shows the owner every delivery for their profile and shows a
  // caregiver only their own: `16` forbids using "family" to justify broad hidden access, and one
  // relative's notification history is not another's business.

  app.get('/v1/profiles/:profileId/alert-deliveries', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = profileParamsSchema.safeParse(request.params);
    if (!params.success) return badParams(reply, ctx.correlationId);

    const rows = await ctx.db(async (db) => {
      const res = await db.query<DeliveryRow>(
        `SELECT id, recipient_user_id, event_kind, detail_level, delivered_at
           FROM alert_delivery
          WHERE profile_id = $1
          ORDER BY delivered_at DESC`,
        [params.data.profileId],
      );
      return res.rows;
    });

    return reply.status(200).send({
      profileId: params.data.profileId,
      deliveries: rows.map((row) => ({
        deliveryId: row.id,
        recipientUserId: row.recipient_user_id,
        eventKind: row.event_kind,
        detailLevel: row.detail_level,
        deliveredAt: row.delivered_at.toISOString(),
      })),
      serverTime: ctx.now,
    });
  });
}

/** Re-exported so a caller can state the capability a delivery needs without importing twice. */
export { CAPABILITY_FOR_EVENT };
