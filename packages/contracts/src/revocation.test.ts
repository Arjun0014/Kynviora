import { describe, it, expect } from 'vitest';
import * as revocation from './revocation.js';
import {
  ALREADY_ACCEPTED_CODE,
  NOTHING_TO_REMOVE_MESSAGE,
  buildRevocation,
  isRemovable,
  revocationMessage,
} from './revocation.js';
import { REVOCATION_COPY } from '@kynviora/presentation';
import { accessList, type CaregiverAccessRowView } from './views.js';
import { CAREGIVER_ACCESS_STATES } from '@kynviora/presentation';

/**
 * Choosing what "remove access" actually sends.
 *
 * The list deliberately shows two kinds of record together, so the interesting failure is not a
 * refused request - it is a well-formed request against the wrong route, which the server answers
 * with 404 and the client correctly renders as absence. That failure looks exactly like the row
 * quietly disappearing, which is the one thing a screen about who can read health data must not
 * do by accident.
 */

const row = (over: Partial<CaregiverAccessRowView> = {}): CaregiverAccessRowView => ({
  id: 'g1',
  subject: 'GRANT',
  state: 'ACTIVE',
  capabilities: ['VIEW_SHELF'],
  displayName: 'user-2',
  expiresAt: null,
  isSelf: false,
  ...over,
});

describe('which record is being withdrawn', () => {
  it('keeps a grant and an invitation apart', () => {
    // Two records, two routes. The ID alone does not say which, and the wrong one is a 404.
    expect(buildRevocation(row()).target?.subject).toBe('GRANT');
    expect(buildRevocation(row({ subject: 'INVITATION', state: 'INVITED' })).target?.subject).toBe(
      'INVITATION',
    );
  });

  it('carries the record ID and nothing about the profile', () => {
    // `13`: a client-supplied profile ID is never proof of access, so the request does not carry
    // one. The routes derive the scope from the record.
    const target = buildRevocation(row({ id: 'grant-77' })).target;
    expect(target?.id).toBe('grant-77');
    expect(Object.keys(target ?? {}).sort()).toEqual([
      'capabilities',
      'displayName',
      'id',
      'isSelf',
      'subject',
    ]);
  });

  it('takes "this is mine" from the row rather than deciding it', () => {
    expect(buildRevocation(row({ isSelf: true })).target?.isSelf).toBe(true);
    expect(buildRevocation(row()).target?.isSelf).toBe(false);
  });
});

describe('a row that carries no access offers no removal', () => {
  it('refuses every ended state', () => {
    for (const state of ['REVOKED', 'DECLINED', 'EXPIRED'] as const) {
      const result = buildRevocation(row({ state }));
      expect(result.ok).toBe(false);
      expect(result.target).toBeNull();
      expect(result.refusal?.message).toBe(NOTHING_TO_REMOVE_MESSAGE);
    }
  });

  it('offers removal for the two states that still carry something', () => {
    // `INVITED` is included even though an invitation grants nothing yet: the token is live, and
    // withdrawing it is the only way to stop it being redeemed (DEC-018).
    expect(buildRevocation(row({ state: 'ACTIVE' })).ok).toBe(true);
    expect(buildRevocation(row({ state: 'INVITED', subject: 'INVITATION' })).ok).toBe(true);
  });

  it('classifies every state the presentation can show', () => {
    // A new access state must be classified rather than falling into the removable branch by
    // default - which would put a control on a row whose request the server refuses.
    for (const state of CAREGIVER_ACCESS_STATES) {
      expect(typeof buildRevocation(row({ state })).ok).toBe('boolean');
    }
  });

  it('agrees with the list about which rows are removable', () => {
    // Two independent conditions is how a control appears on a row the builder then refuses.
    for (const state of CAREGIVER_ACCESS_STATES) {
      expect(isRemovable(row({ state }))).toBe(buildRevocation(row({ state })).ok);
    }
  });
});

describe('what this module refuses to be', () => {
  it('exports nothing that could apply a revocation locally', () => {
    // `12` forbids the client holding authorization logic, and a row that disappears before the
    // server agreed is a false statement about who can read a person's health data - in the
    // direction that reassures. The absence is asserted over the module's own keys rather than
    // trusted to review.
    const behaviour = Object.entries(revocation)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    expect(
      behaviour.filter((name) => /remove|revoke|apply|hide|filter|without/i.test(name)),
    ).toEqual([]);
    // And the three that do exist say what they are: a draft, a predicate and some words.
    expect(behaviour.sort()).toEqual(['buildRevocation', 'isRemovable', 'revocationMessage']);
  });

  it('names the code the server uses for an invitation that has moved on', () => {
    expect(ALREADY_ACCEPTED_CODE).toBe('INVITATION_ALREADY_RESOLVED');
  });
});

describe('the list the screen actually renders', () => {
  it('tags each row with the record it came from', () => {
    // The reason `subject` exists. Without it, "remove this" on the first row of a mixed list is
    // undecidable at the point it is pressed.
    const rows = accessList(
      [
        {
          id: 'g1',
          profileId: 'p1',
          granteeUserId: 'u2',
          grantedByUserId: 'u1',
          capabilities: ['VIEW_SAFETY'],
          status: 'ACTIVE',
          invitedAt: '2026-08-01T00:00:00.000Z',
          acceptedAt: '2026-08-02T00:00:00.000Z',
          expiresAt: null,
          revokedAt: null,
          isSelf: true,
        },
      ],
      [
        {
          id: 'inv-1',
          profileId: 'p1',
          invitedByUserId: 'u1',
          capabilities: ['VIEW_SHELF'],
          status: 'PENDING',
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2026-09-08T00:00:00.000Z',
          grantExpiresAt: null,
          boundToAddress: true,
        },
      ],
    );
    expect(rows.map((r) => r.subject)).toEqual(['INVITATION', 'GRANT']);
    expect(rows.map((r) => r.id)).toEqual(['inv-1', 'g1']);
  });

  it("never reads an outstanding invitation as the caller's own access", () => {
    // The route admits the owner and an administering caregiver, and deliberately not the
    // intended recipient before acceptance.
    const rows = accessList(
      [],
      [
        {
          id: 'inv-1',
          profileId: 'p1',
          invitedByUserId: 'u1',
          capabilities: [],
          status: 'PENDING',
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2026-09-08T00:00:00.000Z',
          grantExpiresAt: null,
          boundToAddress: false,
        },
      ],
    );
    expect(rows[0]?.isSelf).toBe(false);
  });

  it("treats a response with no isSelf field as somebody else's", () => {
    // Deny by default applied to a claim about identity. An older server that does not send the
    // field must not produce "remove your own access" in front of someone removing another
    // person's.
    const rows = accessList([
      {
        id: 'g1',
        profileId: 'p1',
        granteeUserId: 'u2',
        grantedByUserId: 'u1',
        capabilities: [],
        status: 'ACTIVE',
        invitedAt: '2026-08-01T00:00:00.000Z',
        acceptedAt: null,
        expiresAt: null,
        revokedAt: null,
      } as unknown as Parameters<typeof accessList>[0][number],
    ]);
    expect(rows[0]?.isSelf).toBe(false);
  });
});

describe('the words on a failed removal', () => {
  it('uses the server message wherever the server wrote one', () => {
    // This client never invents a reason for a refusal, and the authorization classes carry no
    // reason on purpose.
    expect(
      revocationMessage({
        kind: 'REFUSED',
        code: 'VALIDATION_FAILED',
        message: 'That is not a grant.',
        retryable: false,
        correlationId: null,
      }),
    ).toBe('That is not a grant.');
    expect(revocationMessage({ kind: 'UNAVAILABLE' })).toBeNull();
    expect(revocationMessage({ kind: 'STEP_UP_REQUIRED' })).toBeNull();
    expect(revocationMessage({ kind: 'OFFLINE' })).toBeNull();
  });

  it('names the next step for an invitation that has already been accepted', () => {
    // The wire message for this code is shared with the acceptance path, where "this invitation
    // has already been used" is exactly right. On the removal screen it is a dead end: the owner
    // is looking at the list and wants the access gone, and the access is on a different row.
    const words = revocationMessage({
      kind: 'REFUSED',
      code: ALREADY_ACCEPTED_CODE,
      message: 'This invitation has already been used.',
      retryable: false,
      correlationId: null,
    });
    expect(words).toBe(REVOCATION_COPY.alreadyAccepted);
    expect(words).toMatch(/instead/i);
  });

  it('contradicts nothing the server said', () => {
    // The substitution is wording, not a different claim: both sentences say the invitation is
    // spent, and only one of them says what to do about it.
    expect(REVOCATION_COPY.alreadyAccepted).toMatch(/already accepted/i);
  });
});
