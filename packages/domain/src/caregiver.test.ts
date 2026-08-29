import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INVITATION_TTL_DAYS,
  MAX_INVITATION_TTL_DAYS,
  canDelegateCapabilities,
  caregiverAuditDetail,
  effectiveInvitationStatus,
  evaluateAcceptance,
  evaluateDecline,
  evaluateGrantRevocation,
  invitationExpiryFor,
  inviteToken,
  inviteTokenHash,
  isInviteToken,
  isInviteTokenHash,
  requiresStepUp,
  type AcceptingUser,
  type CaregiverAction,
  type CaregiverInvitationRecord,
  type CaregiverInvitationStatus,
  type InviterAuthority,
} from './caregiver.js';
import { instantFrom, type Instant } from './ports.js';
import { isErr, isOk } from './result.js';
import {
  unsafeId,
  type CaregiverGrantId,
  type CaregiverInvitationId,
  type ProfileId,
  type UserId,
} from './ids.js';

/**
 * Caregiver invitation and grant decisions.
 *
 * Spec 19 requires automated coverage of caregiver permission cases; spec 15 names the caregiver
 * relationship boundary and A2 (retained access) as high-impact. Everything here is pure, so
 * these are the cases where the *rule* is asserted - the database and API suites then assert the
 * rule is actually reachable and actually enforced.
 */

const OWNER = unsafeId<UserId>('11111111-1111-4111-8111-111111111111');
const CAREGIVER = unsafeId<UserId>('22222222-2222-4222-8222-222222222222');
const STRANGER = unsafeId<UserId>('33333333-3333-4333-8333-333333333333');
const PROFILE = unsafeId<ProfileId>('44444444-4444-4444-8444-444444444444');
const INVITATION = unsafeId<CaregiverInvitationId>('55555555-5555-4555-8555-555555555555');
const GRANT = unsafeId<CaregiverGrantId>('66666666-6666-4666-8666-666666666666');

const NOW = instantFrom('2026-08-29T12:00:00.000Z');
const LATER = instantFrom('2026-09-30T12:00:00.000Z');

const OWNER_AUTHORITY: InviterAuthority = { kind: 'PROFILE_OWNER' };

function invitation(overrides: Partial<CaregiverInvitationRecord> = {}): CaregiverInvitationRecord {
  return {
    id: INVITATION,
    profileId: PROFILE,
    invitedByUserId: OWNER,
    invitedEmailNormalized: null,
    capabilities: ['VIEW_SAFETY'],
    status: 'PENDING',
    expiresAt: instantFrom('2026-09-05T12:00:00.000Z'),
    grantExpiresAt: null,
    acceptedByUserId: null,
    acceptedGrantId: null,
    ...overrides,
  };
}

function acceptor(overrides: Partial<AcceptingUser> = {}): AcceptingUser {
  return { userId: CAREGIVER, emailNormalized: null, emailVerified: false, ...overrides };
}

function accept(
  invitationOverrides: Partial<CaregiverInvitationRecord> = {},
  acceptorOverrides: Partial<AcceptingUser> = {},
  extra: { now?: Instant; existingActiveGrantId?: CaregiverGrantId | null } = {},
) {
  return evaluateAcceptance({
    invitation: invitation(invitationOverrides),
    acceptor: acceptor(acceptorOverrides),
    now: extra.now ?? NOW,
    existingActiveGrantId: extra.existingActiveGrantId ?? null,
  });
}

// ---------------------------------------------------------------------------

describe('invite token shape', () => {
  const VALID = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

  it('accepts a 43-character base64url value', () => {
    expect(VALID).toHaveLength(43);
    expect(isInviteToken(VALID)).toBe(true);
    expect(inviteToken(VALID)).toBe(VALID);
  });

  it('rejects wrong lengths, padding and non-base64url characters', () => {
    for (const bad of [
      VALID.slice(0, 42),
      `${VALID}x`,
      `${VALID.slice(0, 42)}=`,
      `${VALID.slice(0, 42)}+`,
      `${VALID.slice(0, 42)}/`,
      '',
    ]) {
      expect(isInviteToken(bad)).toBe(false);
      expect(() => inviteToken(bad)).toThrow(TypeError);
    }
  });

  it('never repeats the rejected value in the error message', () => {
    // The value is a live credential. An exception that echoes it would put it in a stack trace
    // and from there into a log, which spec 14 forbids.
    const secret = 'S3CR3T-token-value-that-should-not-be-echoed';
    expect(() => inviteToken(secret)).toThrow(/^Invalid invite token format\.$/);
  });

  it('accepts only 64 lowercase hex characters as a hash', () => {
    const hash = 'a'.repeat(64);
    expect(isInviteTokenHash(hash)).toBe(true);
    expect(inviteTokenHash(hash)).toBe(hash);

    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
      expect(isInviteTokenHash(bad)).toBe(false);
    }
  });

  it('rejects a plaintext token written into the hash position', () => {
    // The most plausible storage mistake this shape check exists to catch.
    expect(isInviteTokenHash('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ')).toBe(false);
  });
});

describe('invitation expiry policy', () => {
  it('produces an instant the configured number of days ahead', () => {
    const result = invitationExpiryFor(NOW, DEFAULT_INVITATION_TTL_DAYS);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe('2026-09-05T12:00:00.000Z');
  });

  it('refuses a lifetime outside the permitted range', () => {
    for (const days of [0, -1, MAX_INVITATION_TTL_DAYS + 1, 1.5, Number.NaN]) {
      const result = invitationExpiryFor(NOW, days);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.detail?.['reason_code']).toBe('invitation_ttl_range');
    }
  });
});

describe('effective invitation status', () => {
  it('reports a stored PENDING row as EXPIRED once its expiry has passed', () => {
    // The point of the function: nothing sweeps these rows, so a stale PENDING must not be
    // redeemable simply because no job has run.
    const record = invitation({ expiresAt: instantFrom('2026-08-29T11:59:59.000Z') });
    expect(effectiveInvitationStatus(record, NOW)).toBe('EXPIRED');
  });

  it('treats the expiry instant itself as expired', () => {
    const record = invitation({ expiresAt: NOW });
    expect(effectiveInvitationStatus(record, NOW)).toBe('EXPIRED');
  });

  it('leaves terminal states untouched by the clock', () => {
    for (const status of ['ACCEPTED', 'DECLINED', 'REVOKED'] as CaregiverInvitationStatus[]) {
      const record = invitation({ status, expiresAt: instantFrom('2020-01-01T00:00:00.000Z') });
      expect(effectiveInvitationStatus(record, NOW)).toBe(status);
    }
  });
});

describe('capability delegation', () => {
  it('lets the profile owner grant anything', () => {
    const result = canDelegateCapabilities(OWNER_AUTHORITY, [
      'MANAGE_CAREGIVERS',
      'EXPORT_SUMMARY',
    ]);
    expect(isOk(result)).toBe(true);
  });

  it('removes duplicates so the audit count is truthful', () => {
    const result = canDelegateCapabilities(OWNER_AUTHORITY, [
      'VIEW_SAFETY',
      'VIEW_SAFETY',
      'VIEW_SHELF',
    ]);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual(['VIEW_SAFETY', 'VIEW_SHELF']);
  });

  it('refuses an empty capability set', () => {
    const result = canDelegateCapabilities(OWNER_AUTHORITY, []);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.detail?.['reason_code']).toBe('capabilities_empty');
  });

  it('lets a delegated administrator grant a subset of what they hold', () => {
    const authority: InviterAuthority = {
      kind: 'DELEGATED',
      capabilities: ['MANAGE_CAREGIVERS', 'VIEW_SAFETY', 'VIEW_SHELF'],
    };
    const result = canDelegateCapabilities(authority, ['VIEW_SAFETY']);
    expect(isOk(result)).toBe(true);
  });

  it('refuses a delegated administrator granting a capability they do not hold', () => {
    const authority: InviterAuthority = {
      kind: 'DELEGATED',
      capabilities: ['MANAGE_CAREGIVERS', 'VIEW_SAFETY'],
    };
    const result = canDelegateCapabilities(authority, ['VIEW_SAFETY', 'EXPORT_SUMMARY']);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('CAPABILITY_ESCALATION');
      expect(result.error.detail?.['reason_code']).toBe('exceeds_inviter_capabilities');
      expect(result.error.detail?.['exceeded_count']).toBe(1);
    }
  });

  it('never lets a delegated administrator mint another administrator', () => {
    // Spec 15: an overreaching caregiver building a network of further administrators would take
    // practical control of the profile away from its owner.
    const authority: InviterAuthority = {
      kind: 'DELEGATED',
      capabilities: ['MANAGE_CAREGIVERS'],
    };
    const result = canDelegateCapabilities(authority, ['MANAGE_CAREGIVERS']);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('CAPABILITY_ESCALATION');
      expect(result.error.detail?.['reason_code']).toBe('manage_caregivers_owner_only');
    }
  });

  it('does not leak which capabilities were refused', () => {
    const authority: InviterAuthority = { kind: 'DELEGATED', capabilities: ['VIEW_SAFETY'] };
    const result = canDelegateCapabilities(authority, ['EXPORT_SUMMARY', 'VIEW_DOCUMENTS']);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(JSON.stringify(result.error)).not.toMatch(/EXPORT_SUMMARY|VIEW_DOCUMENTS/);
    }
  });
});

describe('step-up policy', () => {
  it('requires re-authentication for every action that changes access', () => {
    for (const action of ['INVITE_CREATE', 'INVITE_REVOKE', 'GRANT_REVOKE'] as CaregiverAction[]) {
      expect(requiresStepUp(action)).toBe(true);
    }
  });

  it('does not require it for accepting, declining, listing or reading history', () => {
    for (const action of [
      'INVITE_ACCEPT',
      'INVITE_DECLINE',
      'GRANT_LIST',
      'AUDIT_READ',
    ] as CaregiverAction[]) {
      expect(requiresStepUp(action)).toBe(false);
    }
  });
});

describe('acceptance', () => {
  it('creates a grant carrying exactly the invited capabilities and profile', () => {
    const result = accept({ capabilities: ['VIEW_SAFETY', 'VIEW_MEDICINES'] });
    expect(isOk(result)).toBe(true);
    if (isOk(result) && result.value.kind === 'CREATE_GRANT') {
      expect(result.value.profileId).toBe(PROFILE);
      expect(result.value.granteeUserId).toBe(CAREGIVER);
      expect(result.value.grantedByUserId).toBe(OWNER);
      // Not a superset, not a default set: exactly what the owner chose.
      expect(result.value.capabilities).toEqual(['VIEW_SAFETY', 'VIEW_MEDICINES']);
    }
  });

  it('carries the optional grant expiry onto the grant', () => {
    const expiry = instantFrom('2026-12-01T00:00:00.000Z');
    const result = accept({ grantExpiresAt: expiry });
    expect(isOk(result)).toBe(true);
    if (isOk(result) && result.value.kind === 'CREATE_GRANT') {
      expect(result.value.grantExpiresAt).toBe(expiry);
    }
  });

  it('treats a repeat by the same user as an idempotent replay', () => {
    const result = accept({
      status: 'ACCEPTED',
      acceptedByUserId: CAREGIVER,
      acceptedGrantId: GRANT,
    });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.kind).toBe('ALREADY_ACCEPTED');
      if (result.value.kind === 'ALREADY_ACCEPTED') expect(result.value.grantId).toBe(GRANT);
    }
  });

  it('replays even after the invitation window has passed', () => {
    // The effect already happened. Reporting "expired" for a grant that exists would be wrong,
    // and would make a client retry look like a failure.
    const result = accept(
      { status: 'ACCEPTED', acceptedByUserId: CAREGIVER, acceptedGrantId: GRANT },
      {},
      { now: LATER },
    );
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.kind).toBe('ALREADY_ACCEPTED');
  });

  it('refuses a second person redeeming an already-used invitation', () => {
    const result = accept(
      { status: 'ACCEPTED', acceptedByUserId: STRANGER, acceptedGrantId: GRANT },
      { userId: CAREGIVER },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('INVITATION_ALREADY_RESOLVED');
      expect(result.error.detail?.['reason_code']).toBe('accepted_by_another_user');
    }
  });

  it('refuses a declined or revoked invitation', () => {
    for (const [status, reason] of [
      ['DECLINED', 'declined'],
      ['REVOKED', 'revoked'],
    ] as const) {
      const result = accept({ status });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe('INVITATION_ALREADY_RESOLVED');
        expect(result.error.detail?.['reason_code']).toBe(reason);
      }
    }
  });

  it('refuses an expired invitation', () => {
    const result = accept({}, {}, { now: LATER });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('INVITATION_EXPIRED');
  });

  it('refuses the sender accepting their own invitation', () => {
    const result = accept({}, { userId: OWNER });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.detail?.['reason_code']).toBe('self_grant');
    }
  });

  it('accepts an email-bound invitation from the matching verified account', () => {
    const result = accept(
      { invitedEmailNormalized: 'caregiver@example.test' },
      { emailNormalized: 'caregiver@example.test', emailVerified: true },
    );
    expect(isOk(result)).toBe(true);
  });

  it('refuses an email-bound invitation presented by a different account', () => {
    const result = accept(
      { invitedEmailNormalized: 'caregiver@example.test' },
      { emailNormalized: 'someone-else@example.test', emailVerified: true },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('INVITATION_INVALID');
  });

  it('refuses an email-bound invitation when the address is unverified', () => {
    // An unverified address proves nothing: anyone can claim one.
    const result = accept(
      { invitedEmailNormalized: 'caregiver@example.test' },
      { emailNormalized: 'caregiver@example.test', emailVerified: false },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('INVITATION_INVALID');
  });

  it('reports a recipient mismatch with the same code as an unknown invitation', () => {
    // A link that reached the wrong person must not confirm whose address it was sent to.
    const mismatch = accept(
      { invitedEmailNormalized: 'caregiver@example.test' },
      { emailNormalized: 'wrong@example.test', emailVerified: true },
    );
    expect(isErr(mismatch)).toBe(true);
    if (isErr(mismatch)) {
      expect(mismatch.error.code).toBe('INVITATION_INVALID');
      // The address is not in the error anywhere.
      expect(JSON.stringify(mismatch.error)).not.toMatch(/example\.test/);
    }
  });

  it('refuses when the account already holds an active grant on that profile', () => {
    // Neither widening nor narrowing an approved grant by link redemption. See the module note.
    const result = accept({}, {}, { existingActiveGrantId: GRANT });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('INVITATION_ALREADY_RESOLVED');
      expect(result.error.detail?.['reason_code']).toBe('active_grant_exists');
    }
  });

  it('checks the invitation state before the email binding', () => {
    // Ordering matters: a revoked invitation must report as revoked to its rightful recipient
    // rather than as an unknown link.
    const result = accept(
      { status: 'REVOKED', invitedEmailNormalized: 'caregiver@example.test' },
      { emailNormalized: 'caregiver@example.test', emailVerified: true },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('INVITATION_ALREADY_RESOLVED');
  });
});

describe('decline', () => {
  it('closes a pending invitation', () => {
    const result = evaluateDecline(invitation(), NOW);
    expect(isOk(result)).toBe(true);
  });

  it('is idempotent once declined', () => {
    const result = evaluateDecline(invitation({ status: 'DECLINED' }), NOW);
    expect(isOk(result)).toBe(true);
  });

  it('refuses to decline an accepted invitation', () => {
    const result = evaluateDecline(invitation({ status: 'ACCEPTED' }), NOW);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('INVITATION_ALREADY_RESOLVED');
  });

  it('refuses to decline an expired invitation', () => {
    const result = evaluateDecline(invitation(), LATER);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.detail?.['reason_code']).toBe('expired');
  });
});

describe('grant revocation', () => {
  const grant = {
    id: GRANT,
    profileId: PROFILE,
    granteeUserId: CAREGIVER,
    status: 'ACTIVE' as const,
  };

  it('lets the profile owner revoke', () => {
    const result = evaluateGrantRevocation(grant, {
      userId: OWNER,
      authority: OWNER_AUTHORITY,
    });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.alreadyRevoked).toBe(false);
  });

  it('lets a caregiver renounce their own access with no administrative capability', () => {
    // Access someone no longer wants is retained access, which is the A2 failure in slow motion.
    const result = evaluateGrantRevocation(grant, {
      userId: CAREGIVER,
      authority: { kind: 'DELEGATED', capabilities: [] },
    });
    expect(isOk(result)).toBe(true);
  });

  it('lets a delegated administrator revoke someone else', () => {
    const result = evaluateGrantRevocation(grant, {
      userId: STRANGER,
      authority: { kind: 'DELEGATED', capabilities: ['MANAGE_CAREGIVERS'] },
    });
    expect(isOk(result)).toBe(true);
  });

  it('refuses an unrelated caregiver revoking another grant', () => {
    const result = evaluateGrantRevocation(grant, {
      userId: STRANGER,
      authority: { kind: 'DELEGATED', capabilities: ['VIEW_SAFETY'] },
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('PERMISSION_DENIED');
  });

  it('reports an already-revoked grant as done rather than failing', () => {
    const result = evaluateGrantRevocation(
      { ...grant, status: 'REVOKED' },
      { userId: OWNER, authority: OWNER_AUTHORITY },
    );
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.alreadyRevoked).toBe(true);
  });
});

describe('audit detail', () => {
  it('records the capability codes, sorted, with a count', () => {
    const detail = caregiverAuditDetail({
      capabilities: ['VIEW_SHELF', 'EXPORT_SUMMARY'],
      emailBound: true,
      expires: false,
    });
    expect(detail['capabilities']).toBe('EXPORT_SUMMARY,VIEW_SHELF');
    expect(detail['capability_count']).toBe(2);
    expect(detail['email_bound']).toBe(true);
    expect(detail['expires']).toBe(false);
  });

  it('reduces the recipient to whether one was named, never to whom', () => {
    // Spec 20: audit answers who acted and what changed, and must not become a copy of personal
    // content.
    const detail = caregiverAuditDetail({
      capabilities: ['VIEW_SAFETY'],
      emailBound: true,
      expires: false,
    });
    expect(JSON.stringify(detail)).not.toMatch(/@/);
  });

  it('carries only scalars, so it cannot become a nested payload', () => {
    const detail = caregiverAuditDetail({
      capabilities: ['VIEW_SAFETY'],
      emailBound: false,
      expires: true,
      reasonCode: 'expired',
    });
    for (const value of Object.values(detail)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
    expect(detail['reason_code']).toBe('expired');
  });
});
