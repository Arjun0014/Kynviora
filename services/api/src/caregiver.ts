/**
 * Caregiver invitation, acceptance, revocation and audit routes.
 *
 * Spec references: `04` Phase 8.1, `06` Journey 6, `13` (privileged server-only operations,
 * idempotency keys, no sensitive data in query strings), `14` (step-up, column-level controls,
 * logging policy), `15` (caregiver relationship boundary, A2), `03` group H.
 *
 * WHERE THE AUTHORIZATION LIVES
 * Reads go through the RLS-scoped connection, so a caller sees only invitations and grants the
 * policy admits. Writes go through `ctx.privileged('CAREGIVER_GRANT_FINALISATION')`, because
 * `13` lists grant creation and revocation finalisation as privileged server-only operations and
 * the app role holds no write grant on either table.
 *
 * That split creates one obligation this module must discharge by hand: a privileged connection
 * has no row-level security, so every route that writes first re-establishes the caller's
 * authority over the profile through the *user* connection, and refuses before reaching the
 * service role. {@link authorityOver} is that check, and it is the only place it is made.
 *
 * THE TOKEN
 * The plaintext invitation token exists in exactly two places: the response body of the create
 * route, and the request body of accept/decline. It is never stored (only its SHA-256 is), never
 * logged, and never placed in a URL - `13` forbids sensitive data in query strings, and a path
 * or query parameter would reach access logs and browser history.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CAREGIVER_CAPABILITIES,
  DEFAULT_INVITATION_TTL_DAYS,
  INVITE_TOKEN_BYTES,
  MAX_INVITATION_TTL_DAYS,
  canDelegateCapabilities,
  caregiverAuditDetail,
  domainError,
  evaluateAcceptance,
  evaluateDecline,
  evaluateGrantRevocation,
  inviteToken,
  inviteTokenHash,
  invitationExpiryFor,
  isErr,
  requiresStepUp,
  unsafeId,
  type CaregiverAuditAction,
  type CaregiverCapability,
  type CaregiverGrantId,
  type CaregiverInvitationId,
  type CaregiverInvitationRecord,
  type CaregiverInvitationStatus,
  type DomainError,
  type Instant,
  type InviteToken,
  type InviteTokenHash,
  type InviteTokenService,
  type InviterAuthority,
  type ProfileId,
  type UserId,
} from '@kynviora/domain';
import type { DatabaseConnection, RequestContext } from './context.js';
import { hasFreshStepUp } from './context.js';

// ---------------------------------------------------------------------------
// Token service
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Production token service.
 *
 * `randomBytes` rather than `Math.random`: this is a credential. base64url of 32 bytes is 43
 * characters with no padding and is URL-safe, so the token survives an email client without
 * escaping.
 */
export function nodeInviteTokenService(): InviteTokenService {
  return {
    issue() {
      const token = inviteToken(randomBytes(INVITE_TOKEN_BYTES).toString('base64url'));
      return { token, hash: inviteTokenHash(sha256Hex(token)) };
    },
    hash(token: InviteToken): InviteTokenHash {
      return inviteTokenHash(sha256Hex(token));
    },
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

/**
 * A token as it arrives from a client.
 *
 * Validated for shape before it is hashed so that a malformed value is a 400 rather than a
 * database round trip, which also removes the timing difference between "malformed" and "no
 * such invitation".
 */
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const createInvitationSchema = z.object({
  profileId: uuidSchema,
  capabilities: z.array(z.enum(CAREGIVER_CAPABILITIES)).min(1).max(CAREGIVER_CAPABILITIES.length),
  /**
   * Bind the invitation to a specific verified email, or omit for a link anyone holding it may
   * redeem. Present in the body, never a query parameter (`14` treats an address as personal
   * data and `13` forbids sensitive data in query strings).
   */
  invitedEmail: z.string().email().max(254).optional(),
  invitationTtlDays: z.number().int().min(1).max(MAX_INVITATION_TTL_DAYS).optional(),
  /** Optional expiry carried onto the resulting grant (`04` 8.1 "expiration option"). */
  grantExpiresAt: z.string().datetime().optional(),
});

const tokenBodySchema = z.object({ token: tokenSchema });

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface InvitationRow {
  id: string;
  profile_id: string;
  invited_by_user_id: string;
  invited_email_normalized: string | null;
  capabilities: string[];
  status: string;
  expires_at: string;
  grant_expires_at: string | null;
  accepted_by_user_id: string | null;
  accepted_grant_id: string | null;
}

const INVITATION_COLUMNS = `id, profile_id, invited_by_user_id, invited_email_normalized,
       capabilities, status, expires_at, grant_expires_at, accepted_by_user_id, accepted_grant_id`;

/** Adapt a database row to the domain record. `token_hash` is deliberately not among them. */
function toInvitationRecord(row: InvitationRow): CaregiverInvitationRecord {
  return {
    id: unsafeId<CaregiverInvitationId>(row.id),
    profileId: unsafeId<ProfileId>(row.profile_id),
    invitedByUserId: unsafeId<UserId>(row.invited_by_user_id),
    invitedEmailNormalized: row.invited_email_normalized,
    capabilities: row.capabilities as CaregiverCapability[],
    status: row.status as CaregiverInvitationStatus,
    expiresAt: row.expires_at as Instant,
    grantExpiresAt: row.grant_expires_at as Instant | null,
    acceptedByUserId:
      row.accepted_by_user_id === null ? null : unsafeId<UserId>(row.accepted_by_user_id),
    acceptedGrantId:
      row.accepted_grant_id === null ? null : unsafeId<CaregiverGrantId>(row.accepted_grant_id),
  };
}

/** Normalisation used for both storage and comparison. Case folding only; no alias stripping. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

/**
 * Establish what authority the caller holds over a profile, using the **user** connection.
 *
 * `kynviora.owns_profile` and `kynviora.has_capability` are SECURITY DEFINER helpers granted to
 * the app role, and they are the same functions every RLS policy calls. Asking them here means
 * the route and the policies cannot disagree about who administers a profile.
 *
 * Returns null when the caller has no administrative authority at all, which every caller
 * reports as `PERMISSION_DENIED` - rendered to clients as "Not found", so the response does not
 * confirm the profile exists.
 */
async function authorityOver(
  ctx: RequestContext,
  profileId: string,
): Promise<InviterAuthority | null> {
  return ctx.db(async (db) => {
    const owns = await db.query<{ owns: boolean }>('SELECT kynviora.owns_profile($1) AS owns', [
      profileId,
    ]);
    if (owns.rows[0]?.owns === true) return { kind: 'PROFILE_OWNER' as const };

    // An active grant is the only other source of authority. The predicate mirrors
    // `kynviora.has_capability` exactly - accepted, unrevoked and unexpired - so a revoked
    // caregiver loses administrative authority on their very next request (`15` A2).
    const grant = await db.query<{ capabilities: string[] }>(
      `SELECT capabilities FROM caregiver_grant
       WHERE profile_id = $1
         AND grantee_user_id = kynviora.current_user_id()
         AND status = 'ACTIVE'
         AND accepted_at IS NOT NULL
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [profileId],
    );
    const capabilities = grant.rows[0]?.capabilities;
    if (!capabilities || !capabilities.includes('MANAGE_CAREGIVERS')) return null;
    return { kind: 'DELEGATED' as const, capabilities: capabilities as CaregiverCapability[] };
  });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Append an audit event.
 *
 * Runs on the caller-supplied connection so that it commits or rolls back with the change it
 * describes. An audit row for a grant that was not created would be worse than no row at all.
 */
async function writeAudit(
  db: DatabaseConnection,
  input: {
    readonly actorUserId: UserId;
    readonly action: CaregiverAuditAction;
    readonly targetKind: 'caregiver_invitation' | 'caregiver_grant';
    readonly targetId: string | null;
    readonly correlationId: string;
    readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_event
       (actor_user_id, actor_role, action, target_kind, target_id, correlation_id, detail)
     VALUES ($1, 'kynviora_service', $2, $3, $4, $5, $6::jsonb)`,
    [
      input.actorUserId,
      input.action,
      input.targetKind,
      input.targetId,
      input.correlationId,
      JSON.stringify(input.detail),
    ],
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface CaregiverRouteDeps {
  // Declared as function-typed properties rather than methods so they can be destructured
  // without carrying an implicit `this`.
  /** Resolves the request context or writes the rejection itself, exactly as other routes do. */
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
  readonly tokens: InviteTokenService;
}

export function registerCaregiverRoutes(app: FastifyInstance, deps: CaregiverRouteDeps): void {
  const { contextFor, fail, tokens } = deps;

  /** Shared guard: `14` requires re-authentication for caregiver administration. */
  function stepUpMissing(ctx: RequestContext, action: Parameters<typeof requiresStepUp>[0]) {
    return requiresStepUp(action) && !hasFreshStepUp(ctx);
  }

  const stepUpError = domainError(
    'STEP_UP_REQUIRED',
    'Confirm your identity to change caregiver access.',
  );

  /** Both accept and decline resolve an invitation from a presented token. */
  async function invitationForToken(
    ctx: RequestContext,
    token: InviteToken,
  ): Promise<CaregiverInvitationRecord | null> {
    const hash = tokens.hash(token);
    // Privileged: the lookup is by secret, not by identity. The caller has no grant yet, so
    // there is no RLS predicate that could admit this row - which is precisely why acceptance is
    // a privileged server operation in `13`.
    const found = await ctx.privileged('CAREGIVER_GRANT_FINALISATION', (db) =>
      db.query<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM caregiver_invitation WHERE token_hash = $1`,
        [hash],
      ),
    );
    const row = found.rows[0];
    return row ? toInvitationRecord(row) : null;
  }

  // -------------------------------------------------------------------------
  // POST /v1/caregiver-invitations
  // -------------------------------------------------------------------------

  app.post('/v1/caregiver-invitations', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    if (stepUpMissing(ctx, 'INVITE_CREATE')) {
      return fail(reply, stepUpError, ctx.correlationId);
    }

    // `13`: idempotency key on retryable mutations. Without one, a retry after a dropped
    // response would mint a second live token for the same intent - two credentials where the
    // owner believes there is one.
    if (!ctx.operationId) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Idempotency-Key header is required.', {
          reason_code: 'idempotency_key_required',
        }),
        ctx.correlationId,
      );
    }

    const parsed = createInvitationSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
        ctx.correlationId,
      );
    }
    const body = parsed.data;

    const authority = await authorityOver(ctx, body.profileId);
    if (!authority) {
      return fail(
        reply,
        domainError('PERMISSION_DENIED', 'Profile not reachable.'),
        ctx.correlationId,
      );
    }

    const delegable = canDelegateCapabilities(authority, body.capabilities);
    if (isErr(delegable)) return fail(reply, delegable.error, ctx.correlationId);

    const expiry = invitationExpiryFor(
      ctx.now,
      body.invitationTtlDays ?? DEFAULT_INVITATION_TTL_DAYS,
    );
    if (isErr(expiry)) return fail(reply, expiry.error, ctx.correlationId);

    const { token, hash } = tokens.issue();
    const invitedEmail = body.invitedEmail === undefined ? null : normalizeEmail(body.invitedEmail);

    try {
      const created = await ctx.privileged('CAREGIVER_GRANT_FINALISATION', async (db) => {
        const inserted = await db.query<{ id: string }>(
          // `created_at` is written explicitly rather than left to its `DEFAULT now()`, because
          // `expires_at` is derived from the injected clock and the two are compared by
          // `caregiver_invitation_expiry_after_creation`. Letting the column default would put
          // the database wall clock on one side of that CHECK and the domain clock on the other,
          // so a short lifetime anchored at a fixed clock becomes unsatisfiable once real time
          // passes it - a row the domain considers valid, refused by the schema. Same clock on
          // both sides, for the same reason production code may not call `new Date()`.
          `INSERT INTO caregiver_invitation
             (profile_id, invited_by_user_id, invited_email_normalized, capabilities, token_hash,
              created_at, expires_at, grant_expires_at, client_operation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            body.profileId,
            ctx.principal.userId,
            invitedEmail,
            delegable.value,
            hash,
            ctx.now,
            expiry.value,
            body.grantExpiresAt ?? null,
            ctx.operationId,
          ],
        );
        const id = inserted.rows[0]?.id ?? null;
        await writeAudit(db, {
          actorUserId: ctx.principal.userId,
          action: 'caregiver.invitation.created',
          targetKind: 'caregiver_invitation',
          targetId: id,
          correlationId: ctx.correlationId,
          detail: caregiverAuditDetail({
            capabilities: delegable.value,
            emailBound: invitedEmail !== null,
            expires: body.grantExpiresAt !== undefined,
          }),
        });
        return id;
      });

      return reply.status(201).send({
        invitationId: created,
        // The only time this value is ever emitted. It is unrecoverable afterwards.
        token,
        expiresAt: expiry.value,
        capabilities: delegable.value,
        serverTime: ctx.now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (/caregiver_invitation_operation_idx|duplicate key/i.test(message)) {
        // A genuine retry. `13` requires the server to commit exactly once, so the original
        // invitation stands - but the token cannot be returned again, because only its hash was
        // kept. That is the intended consequence of DEC-018: the caller must revoke and reissue
        // if the first response was lost.
        const existing = await ctx.privileged('CAREGIVER_GRANT_FINALISATION', (db) =>
          db.query<{ id: string; expires_at: string }>(
            `SELECT id, expires_at FROM caregiver_invitation WHERE client_operation_id = $1`,
            [ctx.operationId],
          ),
        );
        const row = existing.rows[0];
        return reply
          .status(200)
          .header('idempotent-replay', 'true')
          .send({
            invitationId: row?.id ?? null,
            token: null,
            tokenRecoverable: false,
            expiresAt: row?.expires_at ?? null,
            replayed: true,
            serverTime: ctx.now,
          });
      }

      ctx.logger.error('api.caregiver_invitation_create_failed', {
        correlation_id: ctx.correlationId,
      });
      return fail(
        reply,
        domainError('INTERNAL', 'Could not create the invitation.'),
        ctx.correlationId,
      );
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/caregiver-invitations/accept
  // -------------------------------------------------------------------------

  app.post('/v1/caregiver-invitations/accept', async (request, reply) => {
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

    const parsed = tokenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      // Same code as an unknown token: a malformed value must not be distinguishable from a
      // wrong one, or the endpoint becomes an oracle for token shape.
      return fail(
        reply,
        domainError('INVITATION_INVALID', 'This invitation link is not valid.'),
        ctx.correlationId,
      );
    }

    const invitation = await invitationForToken(ctx, inviteToken(parsed.data.token));
    if (!invitation) {
      return fail(
        reply,
        domainError('INVITATION_INVALID', 'This invitation link is not valid.'),
        ctx.correlationId,
      );
    }

    // The acceptor reads their own account through the RLS-scoped connection: `app_user_self_select`
    // admits exactly one row, so this cannot become a user-lookup primitive.
    const account = await ctx.db((db) =>
      db.query<{ email_normalized: string | null; email_verified_at: string | null }>(
        `SELECT email_normalized, email_verified_at FROM app_user WHERE id = $1`,
        [ctx.principal.userId],
      ),
    );
    const accountRow = account.rows[0];
    if (!accountRow) {
      return fail(reply, domainError('UNAUTHENTICATED', 'No such account.'), ctx.correlationId);
    }

    // Privileged, and deliberately so: the decision must see whether a grant genuinely exists,
    // not whether this caller is allowed to see one. An RLS-filtered "no existing grant" would
    // let a second acceptance attempt through and hit the unique index as an opaque 500.
    const existing = await ctx.privileged('CAREGIVER_GRANT_FINALISATION', (db) =>
      db.query<{ id: string }>(
        `SELECT id FROM caregiver_grant
         WHERE profile_id = $1 AND grantee_user_id = $2 AND status = 'ACTIVE'`,
        [invitation.profileId, ctx.principal.userId],
      ),
    );
    const existingGrantId = existing.rows[0]?.id ?? null;

    const decision = evaluateAcceptance({
      invitation,
      acceptor: {
        userId: ctx.principal.userId,
        emailNormalized: accountRow.email_normalized,
        emailVerified: accountRow.email_verified_at !== null,
      },
      now: ctx.now,
      existingActiveGrantId:
        existingGrantId === null ? null : unsafeId<CaregiverGrantId>(existingGrantId),
    });

    if (isErr(decision)) {
      // A refused acceptance against a *valid* token is worth recording: repeated failures are
      // how a leaked or shared link shows up in the audit history (`20`).
      await ctx.privileged('AUDIT_WRITE', (db) =>
        writeAudit(db, {
          actorUserId: ctx.principal.userId,
          action: 'caregiver.invitation.rejected',
          targetKind: 'caregiver_invitation',
          targetId: invitation.id,
          correlationId: ctx.correlationId,
          detail: caregiverAuditDetail({
            capabilities: invitation.capabilities,
            emailBound: invitation.invitedEmailNormalized !== null,
            expires: invitation.grantExpiresAt !== null,
            reasonCode: String(decision.error.detail?.['reason_code'] ?? decision.error.code),
          }),
        }),
      );
      return fail(reply, decision.error, ctx.correlationId);
    }

    if (decision.value.kind === 'ALREADY_ACCEPTED') {
      return reply.status(200).header('idempotent-replay', 'true').send({
        grantId: decision.value.grantId,
        profileId: invitation.profileId,
        capabilities: invitation.capabilities,
        replayed: true,
        serverTime: ctx.now,
      });
    }

    const create = decision.value;

    try {
      const grantId = await ctx.privileged('CAREGIVER_GRANT_FINALISATION', async (db) => {
        // The grant, the invitation update and both audit rows are one unit. A grant without its
        // invitation marked accepted would leave the token live.
        await db.query('BEGIN');
        try {
          const inserted = await db.query<{ id: string }>(
            `INSERT INTO caregiver_grant
               (profile_id, grantee_user_id, granted_by_user_id, capabilities, status,
                invited_at, accepted_at, expires_at, invitation_id, client_operation_id)
             VALUES ($1, $2, $3, $4, 'ACTIVE', now(), now(), $5, $6, $7)
             RETURNING id`,
            [
              create.profileId,
              create.granteeUserId,
              create.grantedByUserId,
              create.capabilities,
              create.grantExpiresAt,
              create.invitationId,
              ctx.operationId,
            ],
          );
          const id = inserted.rows[0]?.id ?? null;

          await db.query(
            `UPDATE caregiver_invitation
             SET status = 'ACCEPTED', accepted_at = now(), accepted_by_user_id = $1,
                 accepted_grant_id = $2
             WHERE id = $3 AND status = 'PENDING'`,
            [create.granteeUserId, id, create.invitationId],
          );

          const detail = caregiverAuditDetail({
            capabilities: create.capabilities,
            emailBound: invitation.invitedEmailNormalized !== null,
            expires: create.grantExpiresAt !== null,
          });
          await writeAudit(db, {
            actorUserId: ctx.principal.userId,
            action: 'caregiver.invitation.accepted',
            targetKind: 'caregiver_invitation',
            targetId: create.invitationId,
            correlationId: ctx.correlationId,
            detail,
          });
          await writeAudit(db, {
            actorUserId: ctx.principal.userId,
            action: 'caregiver.grant.created',
            targetKind: 'caregiver_grant',
            targetId: id,
            correlationId: ctx.correlationId,
            detail,
          });

          await db.query('COMMIT');
          return id;
        } catch (inner) {
          await db.query('ROLLBACK');
          throw inner;
        }
      });

      return reply.status(201).send({
        grantId,
        profileId: create.profileId,
        capabilities: create.capabilities,
        expiresAt: create.grantExpiresAt,
        serverTime: ctx.now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Two acceptances of the same operation, or a race that lost the unique index. Both mean
      // the effect already happened exactly once, which is what the client needs to hear.
      if (
        /caregiver_grant_operation_idx|caregiver_grant_active_unique|duplicate key/i.test(message)
      ) {
        const settled = await ctx.privileged('CAREGIVER_GRANT_FINALISATION', (db) =>
          db.query<{ id: string }>(
            `SELECT id FROM caregiver_grant
             WHERE profile_id = $1 AND grantee_user_id = $2 AND status = 'ACTIVE'`,
            [create.profileId, create.granteeUserId],
          ),
        );
        return reply
          .status(200)
          .header('idempotent-replay', 'true')
          .send({
            grantId: settled.rows[0]?.id ?? null,
            profileId: create.profileId,
            capabilities: create.capabilities,
            replayed: true,
            serverTime: ctx.now,
          });
      }

      ctx.logger.error('api.caregiver_accept_failed', { correlation_id: ctx.correlationId });
      return fail(
        reply,
        domainError('INTERNAL', 'Could not accept the invitation.'),
        ctx.correlationId,
      );
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/caregiver-invitations/decline
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // GET /v1/caregiver-invitations
  // -------------------------------------------------------------------------
  // Invitations nobody has accepted yet.
  //
  // Without this the Care screen showed nothing after an invitation was sent - a grant row does
  // not exist until acceptance - so an owner would reasonably send a second one. That is not a
  // cosmetic gap: it mints a second live credential for one intent, which is exactly what the
  // idempotency key on the create route exists to prevent.
  //
  // `token_hash` is not selected and could not be: the app role holds a column-level GRANT that
  // omits it, so "the app role cannot read the secret" stays a database fact rather than a
  // property of how this query happens to be written (DEC-021).
  //
  // Visibility is `caregiver_invitation_select`: the profile owner, an administering caregiver,
  // and the account that accepted it. Deliberately not the intended recipient before acceptance -
  // they hold the token, and matching an invitation to an address they have not proven they
  // control would leak that the profile exists.

  app.get('/v1/caregiver-invitations', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const query = z.object({ profileId: uuidSchema.optional() }).safeParse(request.query);
    if (!query.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid query parameters.', {
          reason_code: 'query_schema',
        }),
        ctx.correlationId,
      );
    }

    const params: unknown[] = [];
    let where = "WHERE status = 'PENDING'";
    if (query.data.profileId) {
      params.push(query.data.profileId);
      where += ` AND profile_id = $${String(params.length)}`;
    }

    const result = await ctx.db((db) =>
      db.query<{
        id: string;
        profile_id: string;
        invited_by_user_id: string;
        capabilities: string[];
        status: string;
        created_at: Date | string;
        expires_at: Date | string;
        grant_expires_at: Date | string | null;
        invited_email_normalized: string | null;
      }>(
        `SELECT id, profile_id, invited_by_user_id, capabilities, status, created_at, expires_at,
                grant_expires_at, invited_email_normalized
           FROM caregiver_invitation ${where}
          ORDER BY created_at DESC, id`,
        params,
      ),
    );

    return reply.send({
      invitations: result.rows.map((row) => ({
        id: row.id,
        profileId: row.profile_id,
        invitedByUserId: row.invited_by_user_id,
        capabilities: row.capabilities,
        status: row.status,
        createdAt: asIso(row.created_at),
        expiresAt: asIso(row.expires_at),
        grantExpiresAt: row.grant_expires_at === null ? null : asIso(row.grant_expires_at),
        // Whether it is bound to one address, never the address itself. `14` treats an address as
        // personal data and this list may be read over someone's shoulder; whether the link is
        // open to anyone holding it is the fact the owner actually needs.
        boundToAddress: row.invited_email_normalized !== null,
      })),
      serverTime: ctx.now,
    });
  });

  app.post('/v1/caregiver-invitations/decline', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const parsed = tokenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(
        reply,
        domainError('INVITATION_INVALID', 'This invitation link is not valid.'),
        ctx.correlationId,
      );
    }

    const invitation = await invitationForToken(ctx, inviteToken(parsed.data.token));
    if (!invitation) {
      return fail(
        reply,
        domainError('INVITATION_INVALID', 'This invitation link is not valid.'),
        ctx.correlationId,
      );
    }

    const decision = evaluateDecline(invitation, ctx.now);
    if (isErr(decision)) return fail(reply, decision.error, ctx.correlationId);

    await ctx.privileged('CAREGIVER_GRANT_FINALISATION', async (db) => {
      await db.query(
        `UPDATE caregiver_invitation
         SET status = 'DECLINED', declined_at = now()
         WHERE id = $1 AND status = 'PENDING'`,
        [decision.value],
      );
      await writeAudit(db, {
        actorUserId: ctx.principal.userId,
        action: 'caregiver.invitation.declined',
        targetKind: 'caregiver_invitation',
        targetId: decision.value,
        correlationId: ctx.correlationId,
        detail: caregiverAuditDetail({
          capabilities: invitation.capabilities,
          emailBound: invitation.invitedEmailNormalized !== null,
          expires: invitation.grantExpiresAt !== null,
        }),
      });
    });

    return reply.status(200).send({ status: 'DECLINED', serverTime: ctx.now });
  });

  // -------------------------------------------------------------------------
  // POST /v1/caregiver-invitations/:invitationId/revoke
  // -------------------------------------------------------------------------

  app.post<{ Params: { invitationId: string } }>(
    '/v1/caregiver-invitations/:invitationId/revoke',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      if (stepUpMissing(ctx, 'INVITE_REVOKE')) {
        return fail(reply, stepUpError, ctx.correlationId);
      }

      const id = uuidSchema.safeParse(request.params.invitationId);
      if (!id.success) {
        return fail(reply, domainError('NOT_FOUND', 'No such invitation.'), ctx.correlationId);
      }

      // RLS-scoped: an invitation the caller cannot see does not exist as far as this route is
      // concerned, which keeps the response identical for "wrong id" and "someone else's id".
      const found = await ctx.db((db) =>
        db.query<InvitationRow>(
          `SELECT ${INVITATION_COLUMNS} FROM caregiver_invitation WHERE id = $1`,
          [id.data],
        ),
      );
      const row = found.rows[0];
      if (!row) {
        return fail(reply, domainError('NOT_FOUND', 'No such invitation.'), ctx.correlationId);
      }
      const invitation = toInvitationRecord(row);

      // Visibility is not authority. The acceptor of an invitation can see it under the policy
      // but must not be able to withdraw the record of their own grant.
      const authority = await authorityOver(ctx, invitation.profileId);
      if (!authority) {
        return fail(reply, domainError('NOT_FOUND', 'No such invitation.'), ctx.correlationId);
      }

      if (invitation.status === 'ACCEPTED') {
        // Revoking a spent invitation would be theatre: the access now lives in the grant.
        return fail(
          reply,
          domainError(
            'INVITATION_ALREADY_RESOLVED',
            'This invitation was accepted. Revoke the caregiver access instead.',
            { reason_code: 'already_accepted' },
          ),
          ctx.correlationId,
        );
      }

      await ctx.privileged('CAREGIVER_GRANT_FINALISATION', async (db) => {
        await db.query(
          `UPDATE caregiver_invitation
           SET status = 'REVOKED', revoked_at = now(), revoked_by_user_id = $1
           WHERE id = $2 AND status = 'PENDING'`,
          [ctx.principal.userId, invitation.id],
        );
        await writeAudit(db, {
          actorUserId: ctx.principal.userId,
          action: 'caregiver.invitation.revoked',
          targetKind: 'caregiver_invitation',
          targetId: invitation.id,
          correlationId: ctx.correlationId,
          detail: caregiverAuditDetail({
            capabilities: invitation.capabilities,
            emailBound: invitation.invitedEmailNormalized !== null,
            expires: invitation.grantExpiresAt !== null,
          }),
        });
      });

      return reply.status(200).send({ status: 'REVOKED', serverTime: ctx.now });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/caregiver-grants
  // -------------------------------------------------------------------------

  function asIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : value;
  }

  app.get('/v1/caregiver-grants', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const query = z.object({ profileId: uuidSchema.optional() }).safeParse(request.query);
    if (!query.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid query parameters.', {
          reason_code: 'query_schema',
        }),
        ctx.correlationId,
      );
    }

    // No authority check: `caregiver_grant_select` already restricts rows to the profile owner
    // and the grantee. A `profileId` here narrows, it does not authorise - the same property the
    // shelf route relies on.
    const params: unknown[] = [];
    let where = '';
    if (query.data.profileId) {
      params.push(query.data.profileId);
      where = 'WHERE profile_id = $1';
    }

    const result = await ctx.db((db) =>
      db.query<{
        id: string;
        profile_id: string;
        grantee_user_id: string;
        granted_by_user_id: string;
        capabilities: string[];
        status: string;
        invited_at: string;
        accepted_at: string | null;
        expires_at: string | null;
        revoked_at: string | null;
      }>(
        `SELECT id, profile_id, grantee_user_id, granted_by_user_id, capabilities, status,
                invited_at, accepted_at, expires_at, revoked_at
         FROM caregiver_grant ${where}
         ORDER BY invited_at DESC, id`,
        params,
      ),
    );

    return reply.send({
      grants: result.rows.map((row) => ({
        id: row.id,
        profileId: row.profile_id,
        granteeUserId: row.grantee_user_id,
        grantedByUserId: row.granted_by_user_id,
        capabilities: row.capabilities,
        status: row.status,
        invitedAt: row.invited_at,
        acceptedAt: row.accepted_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      })),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/caregiver-grants/:grantId/revoke
  // -------------------------------------------------------------------------

  app.post<{ Params: { grantId: string } }>(
    '/v1/caregiver-grants/:grantId/revoke',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      if (stepUpMissing(ctx, 'GRANT_REVOKE')) {
        return fail(reply, stepUpError, ctx.correlationId);
      }

      const id = uuidSchema.safeParse(request.params.grantId);
      if (!id.success) {
        return fail(reply, domainError('NOT_FOUND', 'No such grant.'), ctx.correlationId);
      }

      const found = await ctx.db((db) =>
        db.query<{
          id: string;
          profile_id: string;
          grantee_user_id: string;
          status: string;
        }>(`SELECT id, profile_id, grantee_user_id, status FROM caregiver_grant WHERE id = $1`, [
          id.data,
        ]),
      );
      const row = found.rows[0];
      if (!row) {
        return fail(reply, domainError('NOT_FOUND', 'No such grant.'), ctx.correlationId);
      }

      const authority = (await authorityOver(ctx, row.profile_id)) ??
        // A caregiver renouncing their own access holds no administrative authority, and should
        // not need any. `DELEGATED` with no capabilities carries nothing on its own; the
        // self-revocation branch in the domain is what admits this case.
        { kind: 'DELEGATED', capabilities: [] };

      const decision = evaluateGrantRevocation(
        {
          id: unsafeId<CaregiverGrantId>(row.id),
          profileId: unsafeId<ProfileId>(row.profile_id),
          granteeUserId: unsafeId<UserId>(row.grantee_user_id),
          status: row.status as 'ACTIVE',
        },
        { userId: ctx.principal.userId, authority },
      );
      if (isErr(decision)) return fail(reply, decision.error, ctx.correlationId);

      if (!decision.value.alreadyRevoked) {
        await ctx.privileged('CAREGIVER_GRANT_FINALISATION', async (db) => {
          await db.query(
            `UPDATE caregiver_grant
             SET status = 'REVOKED', revoked_at = now(), revoked_by_user_id = $1
             WHERE id = $2 AND status <> 'REVOKED'`,
            [ctx.principal.userId, row.id],
          );
          await writeAudit(db, {
            actorUserId: ctx.principal.userId,
            action: 'caregiver.grant.revoked',
            targetKind: 'caregiver_grant',
            targetId: row.id,
            correlationId: ctx.correlationId,
            detail: caregiverAuditDetail({
              capabilities: [],
              emailBound: false,
              expires: false,
              reasonCode: ctx.principal.userId === row.grantee_user_id ? 'self' : 'administrator',
            }),
          });
        });
      }

      // Idempotent by design: see `evaluateGrantRevocation`.
      return reply.status(200).send({
        status: 'REVOKED',
        alreadyRevoked: decision.value.alreadyRevoked,
        serverTime: ctx.now,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/profiles/:profileId/caregiver-audit
  // -------------------------------------------------------------------------
  // `03` group H requires audit event visibility, and `06` Journey 6 step 5 requires the owner
  // to see that a grant became active. The audit table has no app-role grant at all, so this is
  // the only read path, and it is scoped by the caller authority established above.

  app.get<{ Params: { profileId: string } }>(
    '/v1/profiles/:profileId/caregiver-audit',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const profileId = uuidSchema.safeParse(request.params.profileId);
      if (!profileId.success) {
        return fail(reply, domainError('NOT_FOUND', 'No such profile.'), ctx.correlationId);
      }

      const authority = await authorityOver(ctx, profileId.data);
      if (!authority) {
        return fail(reply, domainError('NOT_FOUND', 'No such profile.'), ctx.correlationId);
      }

      const events = await ctx.privileged('AUDIT_READ', (db) =>
        db.query<{
          id: string;
          occurred_at: string;
          actor_user_id: string | null;
          action: string;
          target_kind: string;
          target_id: string | null;
          detail: Record<string, unknown>;
        }>(
          // Scoped by joining back to the rows that belong to this profile. An audit event whose
          // target has been deleted drops out rather than leaking across profiles.
          `SELECT e.id, e.occurred_at, e.actor_user_id, e.action, e.target_kind, e.target_id,
                  e.detail
           FROM audit_event e
           WHERE e.action LIKE 'caregiver.%'
             AND (
               e.target_id IN (SELECT id FROM caregiver_invitation WHERE profile_id = $1)
               OR e.target_id IN (SELECT id FROM caregiver_grant WHERE profile_id = $1)
             )
           ORDER BY e.occurred_at DESC, e.id
           LIMIT 200`,
          [profileId.data],
        ),
      );

      return reply.send({
        events: events.rows.map((row) => ({
          id: row.id,
          occurredAt: row.occurred_at,
          actorUserId: row.actor_user_id,
          action: row.action,
          targetKind: row.target_kind,
          targetId: row.target_id,
          detail: row.detail,
        })),
        serverTime: ctx.now,
      });
    },
  );
}
