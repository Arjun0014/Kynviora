import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_FOR_EVENT,
  DEFAULT_NOTIFICATION_DETAIL,
  DELIVERABLE_EVENT_KINDS,
  EXCLUSION_REASONS,
  GENERIC_NOTIFICATION_BODY,
  NOTIFICATION_DETAIL_LEVELS,
  defaultNotificationPolicy,
  deliveryAuditDetail,
  narrowerOf,
  notificationFor,
  resolutionViewFor,
  selectRecipients,
  type DeliverableEvent,
  type DeliveryCandidate,
  type NotificationDetailLevel,
  type NotificationSubject,
  type ProfileNotificationPolicy,
  type Recipient,
} from './alertDelivery.js';
import { instantFrom } from './ports.js';
import { isErr, isOk } from './result.js';
import { unsafeId, type ProfileId, type UserId } from './ids.js';

/**
 * Caregiver alert delivery decisions.
 *
 * Phase 8.2's exit criterion is that caregiver access is testable through deny-by-default
 * authorization cases, so most of this file is negative: each way a candidate can fail to
 * qualify, asserted separately, with the reported reason pinned. The disclosure half is tested
 * for what a notification does *not* contain as much as for what it does.
 */

const PROFILE = unsafeId<ProfileId>('44444444-4444-4444-8444-444444444444');
const OWNER = unsafeId<UserId>('11111111-1111-4111-8111-111111111111');
const CAREGIVER = unsafeId<UserId>('22222222-2222-4222-8222-222222222222');

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

const PERSON = 'Parent A (synthetic)';
const MEDICINE = 'Synthetic Tablet A';

function owner(overrides: Partial<DeliveryCandidate> = {}): DeliveryCandidate {
  return {
    userId: OWNER,
    relationship: 'OWNER',
    capabilities: [],
    grantAccepted: false,
    grantRevokedAt: null,
    grantExpiresAt: null,
    detailPreference: null,
    // Consented by default in these fixtures, so the tests below keep testing the grant rules
    // rather than accidentally testing consent. `04` Phase 1.4's own behaviour has its own block.
    notificationsConsented: true,
    caregiverSharingConsented: true,
    ...overrides,
  };
}

function caregiver(overrides: Partial<DeliveryCandidate> = {}): DeliveryCandidate {
  return {
    userId: CAREGIVER,
    relationship: 'CAREGIVER',
    capabilities: ['VIEW_SAFETY'],
    grantAccepted: true,
    grantRevokedAt: null,
    grantExpiresAt: null,
    detailPreference: null,
    notificationsConsented: true,
    caregiverSharingConsented: true,
    ...overrides,
  };
}

const SAFETY: DeliverableEvent = {
  kind: 'SAFETY_ALERT',
  profileId: PROFILE,
  alertState: 'PUBLISHED',
};
const MISSED: DeliverableEvent = { kind: 'MISSED_DOSE', profileId: PROFILE, alertState: null };

const OPEN_POLICY: ProfileNotificationPolicy = {
  profileId: PROFILE,
  maxCaregiverDetail: 'NAMED',
};

function plan(
  event: DeliverableEvent,
  candidates: readonly DeliveryCandidate[],
  policy: ProfileNotificationPolicy = OPEN_POLICY,
) {
  const result = selectRecipients(event, candidates, policy, NOW);
  expect(isOk(result)).toBe(true);
  if (!isOk(result)) throw new Error('unreachable');
  return result.value;
}

function recipientAt(level: NotificationDetailLevel): Recipient {
  return { userId: CAREGIVER, relationship: 'CAREGIVER', detailLevel: level };
}

const SUBJECT: NotificationSubject = {
  kind: 'SAFETY_ALERT',
  profileDisplayName: PERSON,
  itemDisplayName: MEDICINE,
};

// ---------------------------------------------------------------------------

describe('capability separation', () => {
  it('maps every deliverable event to exactly one capability', () => {
    for (const kind of DELIVERABLE_EVENT_KINDS) {
      expect(CAPABILITY_FOR_EVENT[kind]).toBeDefined();
    }
  });

  it('does not admit missed-dose notifications through the safety permission', () => {
    // 04 Phase 8.2 calls the missed-dose permission separate and optional. A caregiver watching
    // for a recall is not thereby entitled to know whether someone took their tablets.
    expect(CAPABILITY_FOR_EVENT.MISSED_DOSE).not.toBe(CAPABILITY_FOR_EVENT.SAFETY_ALERT);
    const result = plan(MISSED, [caregiver({ capabilities: ['VIEW_SAFETY'] })]);
    expect(result.recipients).toEqual([]);
    expect(result.excluded).toEqual([{ userId: CAREGIVER, reason: 'CAPABILITY_MISSING' }]);
  });

  it('does not admit safety notifications through the missed-dose permission', () => {
    const result = plan(SAFETY, [caregiver({ capabilities: ['RECEIVE_MISSED_DOSE'] })]);
    expect(result.recipients).toEqual([]);
    expect(result.excluded).toEqual([{ userId: CAREGIVER, reason: 'CAPABILITY_MISSING' }]);
  });

  it('admits a caregiver holding the matching capability', () => {
    const result = plan(MISSED, [caregiver({ capabilities: ['RECEIVE_MISSED_DOSE'] })]);
    expect(result.recipients.map((r) => r.userId)).toEqual([CAREGIVER]);
  });

  it('does not admit a caregiver holding neighbouring capabilities but not the right one', () => {
    // Shelf and medicine access are explicitly separate permissions in 03 group H.
    const result = plan(SAFETY, [
      caregiver({ capabilities: ['VIEW_SHELF', 'VIEW_MEDICINES', 'MANAGE_MEDICINES'] }),
    ]);
    expect(result.recipients).toEqual([]);
    expect(result.excluded).toEqual([{ userId: CAREGIVER, reason: 'CAPABILITY_MISSING' }]);
  });
});

describe('deny by default', () => {
  it('tells nobody when there are no candidates', () => {
    expect(plan(SAFETY, []).recipients).toEqual([]);
  });

  it('excludes a grant that has not been accepted', () => {
    const result = plan(SAFETY, [caregiver({ grantAccepted: false })]);
    expect(result.recipients).toEqual([]);
    expect(result.excluded).toEqual([{ userId: CAREGIVER, reason: 'GRANT_NOT_ACCEPTED' }]);
  });

  it('excludes a revoked grant even while its capabilities still read correctly', () => {
    // 15 A2: revocation takes effect immediately. A revoked grant that still carried the
    // capability array would otherwise keep delivering.
    const result = plan(SAFETY, [caregiver({ grantRevokedAt: NOW })]);
    expect(result.recipients).toEqual([]);
    expect(result.excluded).toEqual([{ userId: CAREGIVER, reason: 'GRANT_REVOKED' }]);
  });

  it('excludes an expired grant', () => {
    const result = plan(SAFETY, [
      caregiver({ grantExpiresAt: instantFrom('2026-08-29T11:59:59.000Z') }),
    ]);
    expect(result.excluded).toEqual([{ userId: CAREGIVER, reason: 'GRANT_EXPIRED' }]);
  });

  it('treats expiry as exclusive at the exact instant', () => {
    // A grant expiring "at" now has expired. The alternative delivers one notification after the
    // moment the owner chose as the end.
    const atNow = plan(SAFETY, [caregiver({ grantExpiresAt: NOW })]);
    expect(atNow.excluded).toEqual([{ userId: CAREGIVER, reason: 'GRANT_EXPIRED' }]);

    const later = plan(SAFETY, [
      caregiver({ grantExpiresAt: instantFrom('2026-08-29T12:00:01.000Z') }),
    ]);
    expect(later.recipients.map((r) => r.userId)).toEqual([CAREGIVER]);
  });

  it('reports the most fundamental reason when several apply', () => {
    // Revoked *and* lacking the capability reports revocation: the grant is gone, so what it
    // would have carried is not the interesting fact.
    const result = plan(SAFETY, [caregiver({ grantRevokedAt: NOW, capabilities: [] })]);
    expect(result.excluded).toEqual([{ userId: CAREGIVER, reason: 'GRANT_REVOKED' }]);
  });

  it('has a reason for every way a candidate can be dropped', () => {
    // Guards against an exclusion path being added without a name, which would make it invisible
    // in the audit detail.
    expect(new Set(EXCLUSION_REASONS).size).toBe(EXCLUSION_REASONS.length);
  });
});

describe('withdrawn alerts', () => {
  it('refuses to deliver an alert that is not published', () => {
    for (const state of ['WITHDRAWN', 'SUPERSEDED'] as const) {
      const result = selectRecipients(
        { kind: 'SAFETY_ALERT', profileId: PROFILE, alertState: state },
        [owner(), caregiver()],
        OPEN_POLICY,
        NOW,
      );
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.detail).toMatchObject({ reason_code: 'alert_not_deliverable' });
      }
    }
  });

  it('refuses rather than returning an empty plan, so nothing records a delivery', () => {
    // An empty plan would be written to the audit trail as a dispatch with zero recipients,
    // which reads as though the alert were live and simply had no audience.
    const result = selectRecipients(
      { kind: 'SAFETY_ALERT', profileId: PROFILE, alertState: 'WITHDRAWN' },
      [],
      OPEN_POLICY,
      NOW,
    );
    expect(isErr(result)).toBe(true);
  });

  it('refuses a missed-dose event that carries a publication state', () => {
    const result = selectRecipients(
      { kind: 'MISSED_DOSE', profileId: PROFILE, alertState: 'PUBLISHED' },
      [],
      OPEN_POLICY,
      NOW,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.detail).toMatchObject({ reason_code: 'missed_dose_has_no_publication' });
    }
  });
});

describe('the owner', () => {
  it('is always a recipient, holding no capabilities at all', () => {
    const result = plan(SAFETY, [owner()]);
    expect(result.recipients.map((r) => r.userId)).toEqual([OWNER]);
    expect(result.excluded).toEqual([]);
  });

  it('is not subject to the caregiver disclosure ceiling', () => {
    // The ceiling exists to limit what leaves the profile onto someone else's device. It is not
    // a restriction the owner places on themselves, so the same policy produces different levels
    // for the two relationships even when both asked for NAMED.
    const result = plan(
      SAFETY,
      [owner({ detailPreference: 'NAMED' }), caregiver({ detailPreference: 'NAMED' })],
      { profileId: PROFILE, maxCaregiverDetail: 'GENERIC' },
    );
    const byUser = new Map(result.recipients.map((r) => [r.userId, r.detailLevel]));
    expect(byUser.get(OWNER)).toBe('NAMED');
    expect(byUser.get(CAREGIVER)).toBe('GENERIC');
  });

  it('still defaults to generic when they have chosen nothing', () => {
    // Being exempt from the ceiling is not the same as being opted in.
    const result = plan(SAFETY, [owner({ detailPreference: null })], {
      profileId: PROFILE,
      maxCaregiverDetail: 'NAMED',
    });
    expect(result.recipients[0]?.detailLevel).toBe('GENERIC');
  });
});

describe('disclosure level', () => {
  it('defaults to generic', () => {
    expect(DEFAULT_NOTIFICATION_DETAIL).toBe('GENERIC');
    expect(NOTIFICATION_DETAIL_LEVELS[0]).toBe('GENERIC');
  });

  it('treats a missing preference as the default, never as permission', () => {
    const result = plan(SAFETY, [caregiver({ detailPreference: null })], {
      profileId: PROFILE,
      maxCaregiverDetail: 'NAMED',
    });
    expect(result.recipients[0]?.detailLevel).toBe('GENERIC');
  });

  it('uses the narrower of the owner ceiling and the recipient preference', () => {
    const cases: readonly [
      NotificationDetailLevel,
      NotificationDetailLevel,
      NotificationDetailLevel,
    ][] = [
      ['NAMED', 'NAMED', 'NAMED'],
      ['NAMED', 'CATEGORY', 'CATEGORY'],
      ['CATEGORY', 'NAMED', 'CATEGORY'],
      ['GENERIC', 'NAMED', 'GENERIC'],
      ['NAMED', 'GENERIC', 'GENERIC'],
    ];
    for (const [ceiling, preference, expected] of cases) {
      const result = plan(SAFETY, [caregiver({ detailPreference: preference })], {
        profileId: PROFILE,
        maxCaregiverDetail: ceiling,
      });
      expect(result.recipients[0]?.detailLevel).toBe(expected);
    }
  });

  it('never lets a recipient preference widen past the owner ceiling', () => {
    // The property the two dials exist to guarantee, asserted directly over every pair.
    for (const ceiling of NOTIFICATION_DETAIL_LEVELS) {
      for (const preference of NOTIFICATION_DETAIL_LEVELS) {
        const result = plan(SAFETY, [caregiver({ detailPreference: preference })], {
          profileId: PROFILE,
          maxCaregiverDetail: ceiling,
        });
        const effective = result.recipients[0]?.detailLevel as NotificationDetailLevel;
        expect(NOTIFICATION_DETAIL_LEVELS.indexOf(effective)).toBeLessThanOrEqual(
          NOTIFICATION_DETAIL_LEVELS.indexOf(ceiling),
        );
      }
    }
  });

  it('narrowerOf is commutative and idempotent', () => {
    for (const a of NOTIFICATION_DETAIL_LEVELS) {
      for (const b of NOTIFICATION_DETAIL_LEVELS) {
        expect(narrowerOf(a, b)).toBe(narrowerOf(b, a));
      }
      expect(narrowerOf(a, a)).toBe(a);
    }
  });

  it('defaults a profile with no configured policy to the generic ceiling', () => {
    expect(defaultNotificationPolicy(PROFILE).maxCaregiverDetail).toBe('GENERIC');
  });
});

describe('notification content', () => {
  it('reveals nothing at the generic level', () => {
    const notification = notificationFor(recipientAt('GENERIC'), SUBJECT);
    expect(notification.body).toBe(GENERIC_NOTIFICATION_BODY);
    expect(notification.revealsSubject).toBe(false);
    expect(notification.body).not.toContain(PERSON);
    expect(notification.body).not.toContain(MEDICINE);
  });

  it('names neither the person nor the product at the category level', () => {
    for (const kind of DELIVERABLE_EVENT_KINDS) {
      const notification = notificationFor(recipientAt('CATEGORY'), { ...SUBJECT, kind });
      expect(notification.body).not.toContain(PERSON);
      expect(notification.body).not.toContain(MEDICINE);
      expect(notification.revealsSubject).toBe(false);
      // Still says something useful, or the level would not be worth offering.
      expect(notification.body.length).toBeGreaterThan(0);
      expect(notification.body).not.toBe(GENERIC_NOTIFICATION_BODY);
    }
  });

  it('names the person and item only at the named level', () => {
    const notification = notificationFor(recipientAt('NAMED'), SUBJECT);
    expect(notification.body).toContain(PERSON);
    expect(notification.body).toContain(MEDICINE);
    expect(notification.revealsSubject).toBe(true);
  });

  it('omits the item when there is none, without leaving a dangling phrase', () => {
    const notification = notificationFor(recipientAt('NAMED'), {
      ...SUBJECT,
      itemDisplayName: null,
    });
    expect(notification.body).toContain(PERSON);
    expect(notification.body).not.toContain('null');
    expect(notification.body).not.toContain('undefined');
    expect(notification.body.trim()).toBe(notification.body);
  });

  it('keeps the title generic at every level, because the title is always visible', () => {
    // 15 A6 is about what a locked device shows. A title that varied by level would leak the
    // category even when the body was suppressed.
    const titles = new Set(
      NOTIFICATION_DETAIL_LEVELS.map((level) => notificationFor(recipientAt(level), SUBJECT).title),
    );
    expect(titles.size).toBe(1);
  });

  it('describes a missed dose without judging the person', () => {
    // 18 forbids shaming copy. The dose is "not recorded yet" - a fact about the record.
    for (const level of ['CATEGORY', 'NAMED'] as const) {
      const body = notificationFor(recipientAt(level), {
        kind: 'MISSED_DOSE',
        profileDisplayName: PERSON,
        itemDisplayName: MEDICINE,
      }).body;
      for (const shaming of ['failed', 'forgot', 'missed again', 'non-compliant', 'should have']) {
        expect(body.toLowerCase()).not.toContain(shaming);
      }
    }
  });

  it('reports revealsSubject consistently with what the body contains', () => {
    for (const level of NOTIFICATION_DETAIL_LEVELS) {
      const notification = notificationFor(recipientAt(level), SUBJECT);
      const mentionsSubject =
        notification.body.includes(PERSON) || notification.body.includes(MEDICINE);
      expect(notification.revealsSubject).toBe(mentionsSubject);
    }
  });
});

describe('resolution visibility', () => {
  const receipt = {
    resolution: 'REVIEWED',
    resolvedAt: NOW,
    note: 'Spoke to the pharmacist about this one.',
  };

  it('gives the owner the whole receipt', () => {
    const view = resolutionViewFor(receipt, { relationship: 'OWNER' });
    expect(view.note).toBe(receipt.note);
    expect(view.noteWithheld).toBe(false);
  });

  it('gives a caregiver the outcome but withholds the free-text note', () => {
    const view = resolutionViewFor(receipt, { relationship: 'CAREGIVER' });
    expect(view.resolution).toBe('REVIEWED');
    expect(view.resolvedAt).toBe(NOW);
    expect(view.note).toBeNull();
    expect(view.noteWithheld).toBe(true);
  });

  it('distinguishes a withheld note from an absent one', () => {
    // A blank where a note was withheld reads as "there is no note", which is a different and
    // misleading claim.
    const none = resolutionViewFor({ ...receipt, note: null }, { relationship: 'CAREGIVER' });
    expect(none.note).toBeNull();
    expect(none.noteWithheld).toBe(false);
  });

  it('reports an unresolved alert as unresolved for both', () => {
    const open = { resolution: null, resolvedAt: null, note: null };
    for (const relationship of ['OWNER', 'CAREGIVER'] as const) {
      const view = resolutionViewFor(open, { relationship });
      expect(view.resolution).toBeNull();
      expect(view.resolvedAt).toBeNull();
    }
  });
});

describe('audit detail', () => {
  it('records counts and levels but no recipient identity', () => {
    const result = plan(SAFETY, [
      owner(),
      caregiver({ detailPreference: 'CATEGORY' }),
      caregiver({
        userId: unsafeId<UserId>('33333333-3333-4333-8333-333333333333'),
        capabilities: [],
      }),
    ]);
    const detail = deliveryAuditDetail(result);

    expect(detail.recipient_count).toBe(2);
    expect(detail.excluded_count).toBe(1);
    expect(detail.excluded_capability_missing).toBe(1);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(OWNER);
    expect(serialized).not.toContain(CAREGIVER);
  });

  it('carries no notification body', () => {
    const result = plan(SAFETY, [caregiver({ detailPreference: 'NAMED' })]);
    const serialized = JSON.stringify(deliveryAuditDetail(result));
    expect(serialized).not.toContain(PERSON);
    expect(serialized).not.toContain(MEDICINE);
    expect(serialized).not.toContain(GENERIC_NOTIFICATION_BODY);
  });

  it('counts every level, including the ones nobody received', () => {
    const detail = deliveryAuditDetail(plan(SAFETY, [caregiver()]));
    for (const level of NOTIFICATION_DETAIL_LEVELS) {
      expect(detail[`count_${level.toLowerCase()}`]).toBeDefined();
    }
  });
});
