import { describe, it, expect } from 'vitest';
import {
  INVALID_EMAIL_MESSAGE,
  NOTHING_SELECTED_MESSAGE,
  buildInvitation,
  heldCapabilities,
  inviterAuthority,
  mayInvite,
  selectableCapabilities,
  type InviterAuthority,
} from './invitation.js';
import type { CaregiverGrant } from './client.js';
import { CAREGIVER_CAPABILITIES, type CaregiverCapability } from '@kynviora/domain';
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

describe('what the caller holds on this profile', () => {
  const grant = (over: Partial<CaregiverGrant> = {}): CaregiverGrant => ({
    id: 'g1',
    profileId: 'p1',
    granteeUserId: 'u2',
    grantedByUserId: 'u1',
    capabilities: ['VIEW_SHELF'],
    status: 'ACTIVE',
    invitedAt: '2026-08-01T00:00:00.000Z',
    acceptedAt: '2026-08-02T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    isSelf: true,
    ...over,
  });

  const NOW = '2026-09-01T00:00:00.000Z';

  it('reads only the grants the server said are the callers own', () => {
    // An administering caregiver sees other people's grants in the same listing. Counting those
    // would offer them capabilities they do not hold, and the server would refuse every one.
    const held = heldCapabilities(
      [grant(), grant({ id: 'g2', capabilities: ['MANAGE_MEDICINES'], isSelf: false })],
      NOW,
    );
    expect(held).toEqual(['VIEW_SHELF']);
  });

  it('unions across several grants, as has_capability does', () => {
    // `kynviora.has_capability` unions capabilities across a caller's active grants, and a
    // partial unique index refuses two active grants for one pair rather than merging them
    // (trap 10). The client mirrors the union rather than picking one row.
    const held = heldCapabilities(
      [
        grant({ profileId: 'p1', capabilities: ['VIEW_SHELF'] }),
        grant({ id: 'g2', profileId: 'p2', capabilities: ['VIEW_SAFETY'] }),
      ],
      NOW,
    );
    expect(held).toEqual(['VIEW_SAFETY', 'VIEW_SHELF']);
  });

  it('discounts a grant that is no longer active', () => {
    for (const over of [
      { status: 'REVOKED' },
      { status: 'EXPIRED' },
      { revokedAt: '2026-08-20T00:00:00.000Z' },
    ] as Partial<CaregiverGrant>[]) {
      expect(heldCapabilities([grant(over)], NOW)).toEqual([]);
    }
  });

  it('discounts a grant whose expiry has passed even where the status still says active', () => {
    // `has_capability` checks `expires_at` separately from `status`, so a stored status of
    // ACTIVE is not on its own evidence that the grant still carries anything.
    expect(heldCapabilities([grant({ expiresAt: '2026-08-31T00:00:00.000Z' })], NOW)).toEqual([]);
    expect(heldCapabilities([grant({ expiresAt: '2026-09-02T00:00:00.000Z' })], NOW)).toEqual([
      'VIEW_SHELF',
    ]);
  });

  it('drops a capability it does not recognise', () => {
    // Deny by default applied to a claim from the network. An unrecognised code offered as a
    // checkbox would be sent back to a server that refuses it.
    expect(heldCapabilities([grant({ capabilities: ['VIEW_SHELF', 'FLY_A_PLANE'] })], NOW)).toEqual(
      ['VIEW_SHELF'],
    );
  });

  it('holds nothing where the server sent no isSelf field', () => {
    // An older server must not make a caregiver look like the holder of every grant on the list.
    const legacy = { ...grant() } as Record<string, unknown>;
    delete legacy['isSelf'];
    expect(heldCapabilities([legacy as unknown as CaregiverGrant], NOW)).toEqual([]);
  });

  it('feeds the delegation rule without changing it', () => {
    // The whole point of the field. `selectableCapabilities` is unchanged; it just stops being
    // handed an empty list for every caregiver.
    const held = heldCapabilities(
      [grant({ capabilities: ['MANAGE_CAREGIVERS', 'VIEW_SHELF', 'MANAGE_MEDICINES'] })],
      NOW,
    );
    const authority = inviterAuthority({ isOwner: false, ownCapabilities: held });
    expect(selectableCapabilities(authority)).toEqual(['VIEW_SHELF', 'MANAGE_MEDICINES']);
  });
});

describe('whether the invite control is offered at all', () => {
  it('offers it to the profile owner', () => {
    expect(mayInvite(OWNER)).toBe(true);
  });

  it('offers it to a caregiver who administers access and holds something to share', () => {
    expect(
      mayInvite({ kind: 'CAREGIVER', capabilities: ['MANAGE_CAREGIVERS', 'VIEW_SHELF'] }),
    ).toBe(true);
  });

  it('withholds it from a caregiver who does not administer access', () => {
    // `authorityOver` answers PERMISSION_DENIED as a 404 for this caller, so the only reachable
    // outcome of the control is a refusal - after they have filled in a form.
    expect(mayInvite({ kind: 'CAREGIVER', capabilities: ['VIEW_SHELF', 'VIEW_SAFETY'] })).toBe(
      false,
    );
  });

  it('withholds it from a caregiver who administers access and holds nothing else', () => {
    // They pass the server's authority check and still have nothing to offer: DEC-020 forbids
    // them delegating caregiver administration itself. Two separate conditions, on purpose.
    expect(mayInvite({ kind: 'CAREGIVER', capabilities: ['MANAGE_CAREGIVERS'] })).toBe(false);
  });

  it('withholds it from a caregiver holding nothing at all', () => {
    expect(mayInvite({ kind: 'CAREGIVER', capabilities: [] })).toBe(false);
  });

  it('never contradicts what the invite screen would offer', () => {
    // Two independent conditions is how a control appears whose screen then has nothing on it.
    for (const capabilities of [
      [],
      ['VIEW_SHELF'],
      ['MANAGE_CAREGIVERS'],
      ['MANAGE_CAREGIVERS', 'VIEW_SHELF'],
    ] as CaregiverCapability[][]) {
      const authority: InviterAuthority = { kind: 'CAREGIVER', capabilities };
      if (mayInvite(authority)) expect(selectableCapabilities(authority).length).toBeGreaterThan(0);
    }
  });
});
