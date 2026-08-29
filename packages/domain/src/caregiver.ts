/**
 * Caregiver invitation and grant lifecycle.
 *
 * Spec references: `04` Phase 8.1 (invite/accept flow, capability-level grants, profile scoping,
 * expiration option, revoke flow, audit history, re-authentication for sensitive grant changes),
 * `06` Journey 6, `07` (CaregiverGrant), `14` (authorization, step-up, column-level controls),
 * `15` ("malicious or overreaching caregiver", A2 "revoked caregiver keeps cached access"),
 * `03` group H (invitation, explicit grants, revocation, audit event visibility).
 *
 * WHY AN INVITATION IS A SEPARATE ENTITY FROM A GRANT
 * `caregiver_grant.grantee_user_id` is `NOT NULL`, because a grant is an authorization and an
 * authorization without a subject is meaningless. An invitation, however, exists precisely in
 * the window where the subject is *not yet known* - the owner is inviting a person, who may not
 * have an account. The two are therefore different records with different lifetimes, and the
 * invitation is the only one of them that carries a secret.
 *
 * WHAT THIS MODULE DOES AND DOES NOT DO
 * Everything here is pure. It decides; it does not read, write, hash or generate randomness.
 * Token issuance and hashing arrive through {@link InviteTokenService} so that the domain stays
 * dependency-free (DEC-002) and so an acceptance decision replays identically (DEC-003).
 */

import type { CaregiverGrantId, CaregiverInvitationId, ProfileId, UserId } from './ids.js';
import type { Instant } from './ports.js';
import type { CaregiverCapability } from './vocabulary.js';
import type { DomainError, Result } from './result.js';
import { failure, ok } from './result.js';

// ---------------------------------------------------------------------------
// Lifecycle states
// ---------------------------------------------------------------------------

/**
 * Stored grant status. Mirrors the `caregiver_grant_status_valid` CHECK in migration `0002`.
 *
 * `PENDING` remains meaningful for a grant created directly for a user who already has an
 * account. An invitation-created grant is `ACTIVE` from the moment it exists, because the act
 * that creates it *is* the acceptance.
 */
export const CAREGIVER_GRANT_STATUSES = [
  'PENDING',
  'ACTIVE',
  'REVOKED',
  'EXPIRED',
  'DECLINED',
] as const;
export type CaregiverGrantStatus = (typeof CAREGIVER_GRANT_STATUSES)[number];

/** Stored invitation status. */
export const CAREGIVER_INVITATION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'REVOKED',
  'EXPIRED',
] as const;
export type CaregiverInvitationStatus = (typeof CAREGIVER_INVITATION_STATUSES)[number];

/**
 * Invitation statuses from which no further transition is possible.
 *
 * `EXPIRED` is deliberately absent: expiry is *derived from the clock* on every read (see
 * {@link effectiveInvitationStatus}), so a stored `PENDING` row whose `expiresAt` has passed is
 * treated as expired without anyone having run a sweep. This is the same discipline as
 * `kynviora.has_capability`, which re-evaluates `expires_at > now()` per access rather than
 * trusting a stored flag - the mitigation `15` A2 requires.
 */
const TERMINAL_INVITATION_STATUSES: readonly CaregiverInvitationStatus[] = Object.freeze([
  'ACCEPTED',
  'DECLINED',
  'REVOKED',
]);

// ---------------------------------------------------------------------------
// Invite tokens
// ---------------------------------------------------------------------------

/**
 * The secret in an invitation link. A bearer credential: whoever holds it can claim the grant.
 *
 * 32 random bytes rendered as base64url, so 43 characters and 256 bits of entropy. Sized so that
 * guessing is not a threat worth further mitigation, which matters because an invitation URL is
 * the one part of this flow that travels outside the system.
 */
export type InviteToken = string & { readonly __inviteToken: unique symbol };

/** SHA-256 of an {@link InviteToken}, lowercase hex. The only form ever persisted (DEC-018). */
export type InviteTokenHash = string & { readonly __inviteTokenHash: unique symbol };

const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVITE_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Token entropy in bytes. 32 bytes of base64url is exactly 43 characters with no padding. */
export const INVITE_TOKEN_BYTES = 32;

export function inviteToken(value: string): InviteToken {
  if (!INVITE_TOKEN_PATTERN.test(value)) {
    // The value is never interpolated into the message: it is a live credential (`14` logging).
    throw new TypeError('Invalid invite token format.');
  }
  return value as InviteToken;
}

export function isInviteToken(value: unknown): value is InviteToken {
  return typeof value === 'string' && INVITE_TOKEN_PATTERN.test(value);
}

export function inviteTokenHash(value: string): InviteTokenHash {
  if (!INVITE_TOKEN_HASH_PATTERN.test(value)) {
    throw new TypeError('Invalid invite token hash format (expected 64 lowercase hex characters).');
  }
  return value as InviteTokenHash;
}

export function isInviteTokenHash(value: unknown): value is InviteTokenHash {
  return typeof value === 'string' && INVITE_TOKEN_HASH_PATTERN.test(value);
}

/**
 * Port for issuing and hashing invite tokens.
 *
 * Separated from the domain for the same reason as the clock: randomness and hashing are
 * effects. A test injects a deterministic implementation and an acceptance decision then
 * replays exactly.
 */
export interface InviteTokenService {
  /** Mint a new token and its hash. The plaintext is returned exactly once, to the caller. */
  issue(): { readonly token: InviteToken; readonly hash: InviteTokenHash };
  /** Hash a presented token so it can be compared against stored hashes. */
  hash(token: InviteToken): InviteTokenHash;
}

// ---------------------------------------------------------------------------
// Expiry policy
// ---------------------------------------------------------------------------

/**
 * How long an unaccepted invitation remains usable.
 *
 * Seven days by default, thirty at most. These are **engineering defaults, not approved product
 * thresholds** (see DEV-006): an invitation is a bearer credential to health data, and a link
 * that stays live indefinitely in an inbox is the realistic leak path.
 */
export const DEFAULT_INVITATION_TTL_DAYS = 7;
export const MAX_INVITATION_TTL_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function invitationExpiryFor(now: Instant, ttlDays: number): Result<Instant, DomainError> {
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > MAX_INVITATION_TTL_DAYS) {
    return failure('VALIDATION_FAILED', 'Invitation lifetime out of range.', {
      reason_code: 'invitation_ttl_range',
      max_days: MAX_INVITATION_TTL_DAYS,
    });
  }
  return ok(new Date(Date.parse(now) + ttlDays * MS_PER_DAY).toISOString() as Instant);
}

// ---------------------------------------------------------------------------
// Delegation policy
// ---------------------------------------------------------------------------

/**
 * Who is issuing an invitation, and with what authority.
 *
 * The profile owner is unconstrained. A caregiver acting under `MANAGE_CAREGIVERS` is not: `15`
 * names "malicious or overreaching caregiver" as a primary adversary, and an administrator
 * capability that can mint capabilities its holder does not have is a privilege-escalation
 * primitive.
 */
export type InviterAuthority =
  | { readonly kind: 'PROFILE_OWNER' }
  | { readonly kind: 'DELEGATED'; readonly capabilities: readonly CaregiverCapability[] };

/**
 * Whether an inviter may grant the requested capabilities.
 *
 * Two rules, both deliberately strict:
 *
 *  1. A delegated inviter may grant only capabilities they themselves hold. Otherwise
 *     `MANAGE_CAREGIVERS` would be a universal capability generator.
 *  2. **Only the profile owner may grant `MANAGE_CAREGIVERS`.** Without this, a caregiver could
 *     appoint further administrators and the owner would lose practical control of the access
 *     list for their own profile - coercive surveillance by an accumulating network of grants,
 *     which is the risk the caregiver relationship boundary in `15` describes.
 */
export function canDelegateCapabilities(
  inviter: InviterAuthority,
  requested: readonly CaregiverCapability[],
): Result<readonly CaregiverCapability[], DomainError> {
  if (requested.length === 0) {
    return failure('VALIDATION_FAILED', 'An invitation must grant at least one capability.', {
      reason_code: 'capabilities_empty',
    });
  }

  // Duplicates are a client bug, not an attack, but they would make the audit record misleading
  // about how many capabilities were granted.
  const unique = Array.from(new Set(requested));

  if (inviter.kind === 'PROFILE_OWNER') return ok(unique);

  if (unique.includes('MANAGE_CAREGIVERS')) {
    return failure(
      'CAPABILITY_ESCALATION',
      'Only the profile owner may delegate caregiver administration.',
      { reason_code: 'manage_caregivers_owner_only' },
    );
  }

  const held = new Set(inviter.capabilities);
  const exceeded = unique.filter((capability) => !held.has(capability));
  if (exceeded.length > 0) {
    return failure(
      'CAPABILITY_ESCALATION',
      'Cannot grant a capability the inviter does not hold.',
      {
        reason_code: 'exceeds_inviter_capabilities',
        // A count, not the list: the codes themselves are safe, but the count is all a client
        // needs and keeps the error uniform regardless of how much was requested.
        exceeded_count: exceeded.length,
      },
    );
  }

  return ok(unique);
}

// ---------------------------------------------------------------------------
// Step-up policy
// ---------------------------------------------------------------------------

/** Actions on the caregiver surface, for the step-up decision. */
export const CAREGIVER_ACTIONS = [
  'INVITE_CREATE',
  'INVITE_REVOKE',
  'INVITE_ACCEPT',
  'INVITE_DECLINE',
  'GRANT_REVOKE',
  'GRANT_LIST',
  'AUDIT_READ',
] as const;
export type CaregiverAction = (typeof CAREGIVER_ACTIONS)[number];

/**
 * Whether an action requires a recent re-authentication.
 *
 * `14`: "step-up authentication for exports, caregiver administration, account deletion". `06`
 * Journey 6 step 3 places the re-authentication on the *granting* side.
 *
 * Acceptance and decline are deliberately **not** step-up actions. The invitee is acting on
 * their own account and the action exposes none of their data; requiring a second factor there
 * would add friction to the one step in this flow performed by the least technical participant
 * (`18`), without protecting anything. Revocation *is* included even though it only ever reduces
 * access, because an attacker with a hijacked session silencing a caregiver is a real abuse of
 * this feature, not a safe direction.
 */
export function requiresStepUp(action: CaregiverAction): boolean {
  return action === 'INVITE_CREATE' || action === 'INVITE_REVOKE' || action === 'GRANT_REVOKE';
}

// ---------------------------------------------------------------------------
// Invitation records and effective status
// ---------------------------------------------------------------------------

/**
 * An invitation as stored, minus the token hash.
 *
 * The hash is excluded on purpose: nothing in this module needs it. Comparison happens by
 * *looking the row up* by hash, so a mistaken `record.tokenHash === presented` comparison -
 * which would be non-constant-time and would put a credential into a domain value - cannot be
 * written.
 */
export interface CaregiverInvitationRecord {
  readonly id: CaregiverInvitationId;
  readonly profileId: ProfileId;
  readonly invitedByUserId: UserId;
  /** Normalised email this invitation is bound to, or null for a link anyone may redeem. */
  readonly invitedEmailNormalized: string | null;
  readonly capabilities: readonly CaregiverCapability[];
  readonly status: CaregiverInvitationStatus;
  /** When the invitation itself stops being redeemable. */
  readonly expiresAt: Instant;
  /** Optional expiry placed on the resulting grant (`04` 8.1 "expiration option"). */
  readonly grantExpiresAt: Instant | null;
  readonly acceptedByUserId: UserId | null;
  readonly acceptedGrantId: CaregiverGrantId | null;
}

/**
 * The status an invitation actually has right now.
 *
 * Never trust the stored value alone for expiry. A row can sit at `PENDING` past its expiry
 * because nothing has touched it since; treating that as redeemable would resurrect a dead
 * invitation.
 */
export function effectiveInvitationStatus(
  record: Pick<CaregiverInvitationRecord, 'status' | 'expiresAt'>,
  now: Instant,
): CaregiverInvitationStatus {
  if (TERMINAL_INVITATION_STATUSES.includes(record.status)) return record.status;
  return Date.parse(record.expiresAt) <= Date.parse(now) ? 'EXPIRED' : 'PENDING';
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

/** Who is presenting the token, and what the server already knows about them. */
export interface AcceptingUser {
  readonly userId: UserId;
  readonly emailNormalized: string | null;
  /** Whether that email has been verified. An unverified address proves nothing. */
  readonly emailVerified: boolean;
}

export type AcceptanceDecision =
  /** Create a grant with exactly these capabilities. */
  | {
      readonly kind: 'CREATE_GRANT';
      readonly invitationId: CaregiverInvitationId;
      readonly profileId: ProfileId;
      readonly granteeUserId: UserId;
      readonly grantedByUserId: UserId;
      readonly capabilities: readonly CaregiverCapability[];
      readonly grantExpiresAt: Instant | null;
    }
  /**
   * The same user already redeemed this invitation. Return the grant they already have.
   *
   * `13` requires a retryable mutation to commit exactly once; a caregiver tapping an emailed
   * link twice, or a client retrying after a dropped response, must not be an error.
   */
  | {
      readonly kind: 'ALREADY_ACCEPTED';
      readonly invitationId: CaregiverInvitationId;
      readonly grantId: CaregiverGrantId | null;
    };

/** State the caller must supply about grants that already exist for this pair. */
export interface AcceptanceContext {
  readonly invitation: CaregiverInvitationRecord;
  readonly acceptor: AcceptingUser;
  readonly now: Instant;
  /**
   * An existing **active** grant for this (profile, user) pair, if any.
   *
   * Acceptance never merges into it. See {@link evaluateAcceptance} for why.
   */
  readonly existingActiveGrantId: CaregiverGrantId | null;
}

/**
 * Decide what accepting an invitation should do.
 *
 * DISCLOSURE POSTURE
 * Reaching this function means the presented token matched a stored hash, so the caller already
 * holds the secret. Telling them "this invitation expired" is therefore not a disclosure and is
 * far better than a blank refusal (`18`). The one exception is the email binding: a link
 * delivered to the wrong person must not confirm *whose* address it was meant for, so a mismatch
 * is reported with the same generic code as an unknown token.
 *
 * WHY AN EXISTING ACTIVE GRANT IS REFUSED RATHER THAN WIDENED
 * If the pair already has an active grant, redeeming a second invitation could only either widen
 * or narrow it. Widening by link-redemption is a privilege change the owner would not see
 * happen; narrowing would silently drop access the owner had already approved. Both are worse
 * than refusing and asking the owner to revoke first, which leaves the change visible in the
 * audit history that `03` group H requires.
 */
export function evaluateAcceptance(
  context: AcceptanceContext,
): Result<AcceptanceDecision, DomainError> {
  const { invitation, acceptor, now, existingActiveGrantId } = context;

  // Idempotent replay comes first: it must win over every later check, including expiry. An
  // invitation accepted last week and retried today has already had its effect, and reporting
  // "expired" for a grant that exists would be wrong.
  if (invitation.status === 'ACCEPTED') {
    if (invitation.acceptedByUserId === acceptor.userId) {
      return ok({
        kind: 'ALREADY_ACCEPTED',
        invitationId: invitation.id,
        grantId: invitation.acceptedGrantId,
      });
    }
    return failure('INVITATION_ALREADY_RESOLVED', 'This invitation has already been used.', {
      reason_code: 'accepted_by_another_user',
    });
  }

  if (invitation.status === 'DECLINED' || invitation.status === 'REVOKED') {
    return failure('INVITATION_ALREADY_RESOLVED', 'This invitation is no longer available.', {
      reason_code: invitation.status === 'REVOKED' ? 'revoked' : 'declined',
    });
  }

  if (effectiveInvitationStatus(invitation, now) === 'EXPIRED') {
    return failure('INVITATION_EXPIRED', 'This invitation has expired.', {
      reason_code: 'expired',
    });
  }

  // The database CHECK forbids grantee = granter, but a constraint violation surfaces as an
  // opaque write failure. Deciding it here produces an explainable outcome.
  if (invitation.invitedByUserId === acceptor.userId) {
    return failure('VALIDATION_FAILED', 'An invitation cannot be accepted by its sender.', {
      reason_code: 'self_grant',
    });
  }

  if (invitation.invitedEmailNormalized !== null) {
    const matches =
      acceptor.emailVerified &&
      acceptor.emailNormalized !== null &&
      acceptor.emailNormalized === invitation.invitedEmailNormalized;
    if (!matches) {
      // Generic on purpose - see the disclosure note above.
      return failure('INVITATION_INVALID', 'This invitation is not valid for this account.', {
        reason_code: 'recipient_mismatch',
      });
    }
  }

  if (existingActiveGrantId !== null) {
    return failure(
      'INVITATION_ALREADY_RESOLVED',
      'This account already has access to this profile.',
      { reason_code: 'active_grant_exists' },
    );
  }

  return ok({
    kind: 'CREATE_GRANT',
    invitationId: invitation.id,
    profileId: invitation.profileId,
    granteeUserId: acceptor.userId,
    grantedByUserId: invitation.invitedByUserId,
    capabilities: invitation.capabilities,
    grantExpiresAt: invitation.grantExpiresAt,
  });
}

/**
 * Decide whether an invitation may be declined.
 *
 * Declining is separate from ignoring: it closes the invitation so the token stops working,
 * which is the correct response to a link a person did not expect.
 */
export function evaluateDecline(
  invitation: CaregiverInvitationRecord,
  now: Instant,
): Result<CaregiverInvitationId, DomainError> {
  const status = effectiveInvitationStatus(invitation, now);
  if (status === 'DECLINED') return ok(invitation.id);
  if (status !== 'PENDING') {
    return failure('INVITATION_ALREADY_RESOLVED', 'This invitation is no longer available.', {
      reason_code: status.toLowerCase(),
    });
  }
  return ok(invitation.id);
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/** A grant as far as revocation is concerned. */
export interface RevocableGrant {
  readonly id: CaregiverGrantId;
  readonly profileId: ProfileId;
  readonly granteeUserId: UserId;
  readonly status: CaregiverGrantStatus;
}

/**
 * Decide whether a revocation may proceed.
 *
 * Revoking an already-revoked grant succeeds rather than failing. Revocation is the safety
 * direction of this feature: a person trying to remove someone else's access who gets an error
 * has been given a reason to doubt whether it worked. Repeating it changes nothing, so it is
 * reported as done.
 */
export function evaluateGrantRevocation(
  grant: RevocableGrant,
  revoker: { readonly userId: UserId; readonly authority: InviterAuthority },
): Result<{ readonly alreadyRevoked: boolean }, DomainError> {
  const isOwner = revoker.authority.kind === 'PROFILE_OWNER';
  const isSelf = grant.granteeUserId === revoker.userId;
  const administers =
    revoker.authority.kind === 'DELEGATED' &&
    revoker.authority.capabilities.includes('MANAGE_CAREGIVERS');

  // A caregiver may always renounce their own access, whatever else they hold. Access someone no
  // longer wants is retained access, which is the A2 failure in a slower form.
  if (!isOwner && !isSelf && !administers) {
    return failure('PERMISSION_DENIED', 'Not permitted to revoke this grant.');
  }

  return ok({ alreadyRevoked: grant.status === 'REVOKED' });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Audit actions for the caregiver surface (`03` group H "audit event visibility").
 *
 * `20` requires audit logs to answer "who performed a sensitive action and what version changed"
 * and explicitly forbids them from becoming verbose copies of health content. These are machine
 * codes; the detail attached to them is scalars only.
 */
export const CAREGIVER_AUDIT_ACTIONS = [
  'caregiver.invitation.created',
  'caregiver.invitation.accepted',
  'caregiver.invitation.declined',
  'caregiver.invitation.revoked',
  'caregiver.invitation.rejected',
  'caregiver.grant.created',
  'caregiver.grant.revoked',
] as const;
export type CaregiverAuditAction = (typeof CAREGIVER_AUDIT_ACTIONS)[number];

/** Audit detail: capability codes, counts and booleans. No names, no emails, no tokens. */
export type CaregiverAuditDetail = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Build the audit detail for a grant or invitation change.
 *
 * Capability codes are included because "audit event visibility" in `03` is worthless if it
 * cannot say *what* was granted, and the codes are a closed vocabulary carrying no personal
 * content. The invited email is reduced to a boolean: whether the invitation was addressed, not
 * to whom.
 */
export function caregiverAuditDetail(input: {
  readonly capabilities: readonly CaregiverCapability[];
  readonly emailBound: boolean;
  readonly expires: boolean;
  readonly reasonCode?: string;
}): CaregiverAuditDetail {
  const detail: Record<string, string | number | boolean | null> = {
    // Sorted so two audit records granting the same set compare equal.
    capabilities: [...input.capabilities].sort().join(','),
    capability_count: input.capabilities.length,
    email_bound: input.emailBound,
    expires: input.expires,
  };
  if (input.reasonCode !== undefined) detail['reason_code'] = input.reasonCode;
  return detail;
}
