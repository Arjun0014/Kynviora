import { describe, it, expect } from 'vitest';
import {
  INVALID_EMAIL_MESSAGE,
  NOTHING_SELECTED_MESSAGE,
  buildInvitation,
  inviterAuthority,
  selectableCapabilities,
  type InviterAuthority,
} from './invitation.js';
import { CAREGIVER_CAPABILITIES } from '@kynviora/domain';
import { findForbiddenClaims } from '@kynviora/presentation';

const PROFILE = '00000000-0000-4000-8000-00000000d020';
const OWNER: InviterAuthority = { kind: 'OWNER' };

describe('what an inviter may offer', () => {
  it('lets the profile owner offer everything', () => {
    expect(selectableCapabilities(OWNER)).toEqual(CAREGIVER_CAPABILITIES);
  });

  it('lets a caregiver offer only what they hold', () => {
    // `16`: a caregiver gets exactly what they were granted, and can pass on no more.
    const authority: InviterAuthority = {
      kind: 'CAREGIVER',
      capabilities: ['VIEW_SHELF', 'VIEW_SAFETY'],
    };
    expect(selectableCapabilities(authority)).toEqual(['VIEW_SAFETY', 'VIEW_SHELF']);
  });

  it('never lets a caregiver offer caregiver administration', () => {
    // DEC-020. A delegated administrator could otherwise widen access in a direction the profile
    // owner would never observe.
    const authority: InviterAuthority = {
      kind: 'CAREGIVER',
      capabilities: ['MANAGE_CAREGIVERS', 'VIEW_SHELF'],
    };
    expect(selectableCapabilities(authority)).toEqual(['VIEW_SHELF']);
  });

  it('omits what cannot be offered rather than showing it disabled', () => {
    // A greyed-out "manage caregivers" box tells a caregiver the capability exists and that they
    // are not permitted to delegate it - a fact about the permission model they did not need.
    const offered = selectableCapabilities({ kind: 'CAREGIVER', capabilities: ['VIEW_SHELF'] });
    expect(offered).not.toContain('MANAGE_CAREGIVERS');
    expect(offered).toHaveLength(1);
  });

  it('reads an authority from the grants the server returned', () => {
    expect(inviterAuthority({ isOwner: true, ownCapabilities: [] })).toEqual({ kind: 'OWNER' });
    expect(
      inviterAuthority({ isOwner: false, ownCapabilities: ['VIEW_SHELF', 'FLY_A_PLANE'] }),
    ).toEqual({ kind: 'CAREGIVER', capabilities: ['VIEW_SHELF'] });
  });
});

describe('building the request', () => {
  it('sends what the owner chose, without duplicates', () => {
    // Duplicates would make the audit record misleading about how many capabilities were granted.
    const result = buildInvitation({
      profileId: PROFILE,
      authority: OWNER,
      selected: ['VIEW_SHELF', 'VIEW_SHELF', 'VIEW_SAFETY'],
    });
    expect(result.ok).toBe(true);
    expect(result.body?.capabilities).toEqual(['VIEW_SHELF', 'VIEW_SAFETY']);
  });

  it('refuses an empty selection, and says why in the user’s terms', () => {
    const result = buildInvitation({ profileId: PROFILE, authority: OWNER, selected: [] });
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('NOTHING_SELECTED');
    expect(NOTHING_SELECTED_MESSAGE).toMatch(/at least one/i);
  });

  it('cannot produce a request the server would call an escalation', () => {
    // The screen never offers it, and the builder refuses it anyway - a request reaching the
    // server as CAPABILITY_ESCALATION would teach the caller something about the permission
    // model by being refused.
    const result = buildInvitation({
      profileId: PROFILE,
      authority: { kind: 'CAREGIVER', capabilities: ['VIEW_SHELF'] },
      selected: ['MANAGE_CAREGIVERS'],
    });
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('NOT_OFFERABLE');
    expect(result.body).toBeNull();
  });

  it('refuses a capability the caregiver does not hold', () => {
    const result = buildInvitation({
      profileId: PROFILE,
      authority: { kind: 'CAREGIVER', capabilities: ['VIEW_SHELF'] },
      selected: ['VIEW_SHELF', 'MANAGE_MEDICINES'],
    });
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('NOT_OFFERABLE');
  });

  it('omits the address entirely when there is none', () => {
    // An absent field, not an empty string: the server treats a bound invitation and an open link
    // as different things, and `""` is neither.
    const result = buildInvitation({
      profileId: PROFILE,
      authority: OWNER,
      selected: ['VIEW_SHELF'],
      invitedEmail: '   ',
    });
    expect(result.ok).toBe(true);
    expect(result.body).not.toHaveProperty('invitedEmail');
  });

  it('carries an address in the body, trimmed', () => {
    const result = buildInvitation({
      profileId: PROFILE,
      authority: OWNER,
      selected: ['VIEW_SHELF'],
      invitedEmail: '  someone@example.test  ',
    });
    expect(result.body?.invitedEmail).toBe('someone@example.test');
  });

  it('catches a typo without pretending to validate an address', () => {
    // Deliberately loose. Refusing a real address because a client-side pattern was too strict is
    // a worse failure than sending one the server rejects.
    const result = buildInvitation({
      profileId: PROFILE,
      authority: OWNER,
      selected: ['VIEW_SHELF'],
      invitedEmail: 'not an address',
    });
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('INVALID_EMAIL');

    for (const address of ['a@b.co', 'first.last+tag@sub.example.test']) {
      expect(
        buildInvitation({
          profileId: PROFILE,
          authority: OWNER,
          selected: ['VIEW_SHELF'],
          invitedEmail: address,
        }).ok,
      ).toBe(true);
    }
  });
});

describe('the token is never handled here', () => {
  it('has no function that takes or returns one', () => {
    // DEC-018 and trap 11: the token is a live credential emitted exactly once. The shortest way
    // to keep one out of a log is for no code between the response and the screen to touch it.
    const source = [
      selectableCapabilities.toString(),
      buildInvitation.toString(),
      inviterAuthority.toString(),
    ].join('\n');
    expect(source.toLowerCase()).not.toContain('token');
  });

  it('never puts an address or a capability in anything URL-shaped', () => {
    // `13` forbids sensitive data in a query string and `14` treats an address as personal data.
    // The request body is the only place either appears.
    const result = buildInvitation({
      profileId: PROFILE,
      authority: OWNER,
      selected: ['VIEW_SHELF'],
      invitedEmail: 'someone@example.test',
    });
    expect(Object.keys(result.body ?? {}).sort()).toEqual([
      'capabilities',
      'invitedEmail',
      'profileId',
    ]);
  });
});

describe('the words', () => {
  it('makes no forbidden claim and does not blame', () => {
    for (const text of [NOTHING_SELECTED_MESSAGE, INVALID_EMAIL_MESSAGE]) {
      expect(findForbiddenClaims(text)).toEqual([]);
      expect(text.toLowerCase()).not.toMatch(/you (failed|forgot|did not|didn't)|invalid input/);
    }
  });
});
