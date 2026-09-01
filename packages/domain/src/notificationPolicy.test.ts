import { describe, it, expect } from 'vitest';
import { ACTION_URGENCIES, type ActionUrgency } from './vocabulary.js';
import { instantFrom } from './ports.js';
import {
  CHANNEL_REASONS,
  DELIVERY_CHANNELS,
  MAX_CHANNEL_FOR_URGENCY,
  MINUTES_PER_DAY,
  REVALIDATION_OUTCOMES,
  URGENCIES_PIERCING_QUIET_HOURS,
  deliveryDecision,
  isValidQuietHours,
  regulatoryDifferenceUrgency,
  revalidate,
  withinQuietHours,
  type DeliveryTimingInput,
} from './notificationPolicy.js';

const NIGHT = { startMinute: 22 * 60, endMinute: 7 * 60 };

function timing(overrides: Partial<DeliveryTimingInput> = {}) {
  return deliveryDecision({
    urgency: 'HIGH',
    deliverable: true,
    alreadyDelivered: false,
    quietHours: null,
    localMinuteOfDay: null,
    ...overrides,
  });
}

describe('the channel an urgency may use', () => {
  it('has a ceiling for every urgency in the vocabulary', () => {
    for (const urgency of ACTION_URGENCIES) {
      expect(DELIVERY_CHANNELS).toContain(MAX_CHANNEL_FOR_URGENCY[urgency]);
    }
  });

  it('never lets a lower urgency reach further than a higher one', () => {
    // The vocabulary is ordered most urgent first, and the channels are ordered loudest first.
    // A ceiling that rose as urgency fell would be the alarm inversion `02` refuses.
    const loudness = DELIVERY_CHANNELS.map((c) => c);
    let previous = 0;
    for (const urgency of ACTION_URGENCIES) {
      const rank = loudness.indexOf(MAX_CHANNEL_FOR_URGENCY[urgency]);
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });

  it('keeps INFORMATIONAL off every device', () => {
    // Exit criterion 1 lives in this one row. A foreign regulatory difference defaults to
    // INFORMATIONAL, so it produces no push and no digest line - not merely a quieter one.
    expect(MAX_CHANNEL_FOR_URGENCY.INFORMATIONAL).toBe('IN_APP_ONLY');
  });

  it('lets only CRITICAL wake somebody', () => {
    expect(URGENCIES_PIERCING_QUIET_HOURS).toEqual(['CRITICAL']);
  });
});

describe('quiet hours', () => {
  it('accepts a window that wraps past midnight', () => {
    expect(isValidQuietHours(NIGHT)).toBe(true);
    expect(withinQuietHours(23 * 60, NIGHT)).toBe(true);
    expect(withinQuietHours(3 * 60, NIGHT)).toBe(true);
    expect(withinQuietHours(12 * 60, NIGHT)).toBe(false);
  });

  it('accepts one that does not', () => {
    const day = { startMinute: 9 * 60, endMinute: 17 * 60 };
    expect(withinQuietHours(12 * 60, day)).toBe(true);
    expect(withinQuietHours(3 * 60, day)).toBe(false);
  });

  it('is half-open, so the two halves of a day partition it', () => {
    // Start inside, end outside. Otherwise 22:00-07:00 and 07:00-22:00 would both claim 07:00.
    expect(withinQuietHours(22 * 60, NIGHT)).toBe(true);
    expect(withinQuietHours(7 * 60, NIGHT)).toBe(false);
  });

  it('refuses equal bounds rather than guessing which way to read them', () => {
    const ambiguous = { startMinute: 600, endMinute: 600 };
    expect(isValidQuietHours(ambiguous)).toBe(false);
    // And an invalid window is never quiet, so a malformed setting cannot silence anything.
    expect(withinQuietHours(600, ambiguous)).toBe(false);
  });

  it('refuses a bound outside the day', () => {
    expect(isValidQuietHours({ startMinute: -1, endMinute: 60 })).toBe(false);
    expect(isValidQuietHours({ startMinute: 0, endMinute: MINUTES_PER_DAY })).toBe(false);
    expect(isValidQuietHours({ startMinute: 1.5, endMinute: 60 })).toBe(false);
  });

  it('normalises a minute from outside the day rather than failing', () => {
    expect(withinQuietHours(23 * 60 + MINUTES_PER_DAY, NIGHT)).toBe(true);
    expect(withinQuietHours(-60, NIGHT)).toBe(true);
  });
});

describe('deciding when and how something is sent', () => {
  it('reports a reason on every decision, not only on refusals', () => {
    for (const urgency of ACTION_URGENCIES) {
      expect(CHANNEL_REASONS).toContain(timing({ urgency }).reason);
    }
  });

  it('sends nothing at all for a withdrawn alert', () => {
    // `19` treats a withdrawn alert that stays actionable as release-blocking, and a notification
    // already on a device is the least revocable form of that.
    const decision = timing({ urgency: 'CRITICAL', deliverable: false });
    expect(decision.channel).toBe('IN_APP_ONLY');
    expect(decision.reason).toBe('ALERT_NOT_DELIVERABLE');
    expect(decision.held).toBe(false);
  });

  it('sends nothing twice for the same concern', () => {
    const decision = timing({ urgency: 'CRITICAL', alreadyDelivered: true });
    expect(decision.channel).toBe('IN_APP_ONLY');
    expect(decision.reason).toBe('ALREADY_DELIVERED');
  });

  it('checks deliverability before deduplication', () => {
    // A withdrawn alert that was also already delivered reports the more fundamental reason, so
    // an operator reading the log is not told a suppression was a duplicate when it was a
    // withdrawal.
    const decision = timing({ deliverable: false, alreadyDelivered: true });
    expect(decision.reason).toBe('ALERT_NOT_DELIVERABLE');
  });

  it('holds a HIGH alert inside quiet hours rather than downgrading it', () => {
    const decision = timing({ urgency: 'HIGH', quietHours: NIGHT, localMinuteOfDay: 3 * 60 });
    // Held, not turned into a digest item: it is still the urgency a reviewer approved, and it is
    // still an interrupt when the window ends.
    expect(decision.channel).toBe('INTERRUPT');
    expect(decision.held).toBe(true);
    expect(decision.reason).toBe('HELD_FOR_QUIET_HOURS');
  });

  it('wakes somebody for a CRITICAL one', () => {
    const decision = timing({ urgency: 'CRITICAL', quietHours: NIGHT, localMinuteOfDay: 3 * 60 });
    expect(decision.held).toBe(false);
    expect(decision.reason).toBe('PIERCED_QUIET_HOURS');
  });

  it('does not hold a digest or an in-app record, which have no arrival time to move', () => {
    for (const urgency of ['MEDIUM', 'LOW', 'INFORMATIONAL'] as const) {
      const decision = timing({ urgency, quietHours: NIGHT, localMinuteOfDay: 3 * 60 });
      expect(decision.held).toBe(false);
      expect(decision.reason).toBe('URGENCY_CEILING');
    }
  });

  it('sends normally where nobody knows the recipient local time', () => {
    // `DEV-030`: no device reports one yet. Not holding is the safe direction - the failure it
    // avoids is a CRITICAL recall silently waiting for a window that never ends.
    const decision = timing({ urgency: 'HIGH', quietHours: NIGHT, localMinuteOfDay: null });
    expect(decision.held).toBe(false);
    expect(decision.channel).toBe('INTERRUPT');
  });

  it('cannot make anything louder than its urgency allows, in any combination', () => {
    const loudness = DELIVERY_CHANNELS.map((c) => c);
    for (const urgency of ACTION_URGENCIES) {
      for (const deliverable of [true, false]) {
        for (const alreadyDelivered of [true, false]) {
          for (const quietHours of [null, NIGHT]) {
            for (const localMinuteOfDay of [null, 3 * 60, 12 * 60]) {
              const decision = deliveryDecision({
                urgency,
                deliverable,
                alreadyDelivered,
                quietHours,
                localMinuteOfDay,
              });
              expect(loudness.indexOf(decision.channel)).toBeGreaterThanOrEqual(
                loudness.indexOf(MAX_CHANNEL_FOR_URGENCY[urgency]),
              );
            }
          }
        }
      }
    }
  });
});

describe('exit criterion 1 - a foreign restriction is not a personal alarm', () => {
  it('defaults a foreign difference to INFORMATIONAL', () => {
    const result = regulatoryDifferenceUrgency({
      observedIn: 'JP',
      profileMarkets: ['GB'],
      reviewedUrgencyForContext: null,
    });
    expect(result.isForeign).toBe(true);
    expect(result.urgency).toBe('INFORMATIONAL');
    expect(result.raisedByReviewedRule).toBe(false);
  });

  it('gives it a channel that reaches no device', () => {
    // The criterion end to end: a new foreign restriction produces no push and no digest line.
    const urgency = regulatoryDifferenceUrgency({
      observedIn: 'JP',
      profileMarkets: ['GB'],
      reviewedUrgencyForContext: null,
    }).urgency;
    const decision = deliveryDecision({
      urgency,
      deliverable: true,
      alreadyDelivered: false,
      quietHours: null,
      localMinuteOfDay: null,
    });
    expect(decision.channel).toBe('IN_APP_ONLY');
  });

  it('treats a profile with no recorded market as having nothing local', () => {
    // Everything is foreign until somebody says where care happens. The failure this avoids is
    // telling a person their own regulator has acted when a different one has.
    const result = regulatoryDifferenceUrgency({
      observedIn: 'GB',
      profileMarkets: [],
      reviewedUrgencyForContext: null,
    });
    expect(result.isForeign).toBe(true);
    expect(result.urgency).toBe('INFORMATIONAL');
  });

  it('raises it only where a reviewed rule said so, and says that is what happened', () => {
    // `09` allows a stronger action only when "a separate reviewed rule establishes" it.
    const result = regulatoryDifferenceUrgency({
      observedIn: 'JP',
      profileMarkets: ['GB'],
      reviewedUrgencyForContext: 'HIGH',
    });
    expect(result.urgency).toBe('HIGH');
    expect(result.isForeign).toBe(true);
    expect(result.raisedByReviewedRule).toBe(true);
  });

  it('does not invent an urgency for a local difference either', () => {
    // A local regulator acting is not automatically urgent for this person's pack either; the
    // reviewed rule is still what decides, and its absence is still INFORMATIONAL.
    const result = regulatoryDifferenceUrgency({
      observedIn: 'GB',
      profileMarkets: ['GB', 'EU'],
      reviewedUrgencyForContext: null,
    });
    expect(result.isForeign).toBe(false);
    expect(result.urgency).toBe('INFORMATIONAL');
    expect(result.raisedByReviewedRule).toBe(false);
  });

  it('never returns an urgency outside the vocabulary', () => {
    for (const reviewed of [null, ...ACTION_URGENCIES] as readonly (ActionUrgency | null)[]) {
      const result = regulatoryDifferenceUrgency({
        observedIn: 'JP',
        profileMarkets: ['GB'],
        reviewedUrgencyForContext: reviewed,
      });
      expect(ACTION_URGENCIES).toContain(result.urgency);
    }
  });
});

describe('exit criterion 2 - nothing stale stays actionable', () => {
  const NOTIFIED = instantFrom('2026-09-01T12:00:00.000Z');
  const AFTER = instantFrom('2026-09-02T12:00:00.000Z');
  const BEFORE = instantFrom('2026-08-31T12:00:00.000Z');

  it('has an outcome for still-current rather than treating it as the absence of the rest', () => {
    expect(REVALIDATION_OUTCOMES).toContain('STILL_CURRENT');
    const result = revalidate({
      notifiedAt: NOTIFIED,
      currentState: 'PUBLISHED',
      lastCorrectedAt: null,
    });
    expect(result.outcome).toBe('STILL_CURRENT');
    expect(result.actionable).toBe(true);
    expect(result.fromNotification).toBe(true);
  });

  it('withdraws the actions on a withdrawn alert', () => {
    const result = revalidate({
      notifiedAt: NOTIFIED,
      currentState: 'WITHDRAWN',
      lastCorrectedAt: null,
    });
    expect(result.outcome).toBe('WITHDRAWN');
    expect(result.actionable).toBe(false);
  });

  it('withdraws them on a superseded one', () => {
    const result = revalidate({
      notifiedAt: NOTIFIED,
      currentState: 'SUPERSEDED',
      lastCorrectedAt: null,
    });
    expect(result.outcome).toBe('SUPERSEDED');
    expect(result.actionable).toBe(false);
  });

  it('withdraws them where the session can no longer see the alert', () => {
    // A caregiver grant revoked between the notification and the tap. It must read as gone rather
    // than as fine.
    const result = revalidate({ notifiedAt: NOTIFIED, currentState: null, lastCorrectedAt: null });
    expect(result.outcome).toBe('NO_LONGER_VISIBLE');
    expect(result.actionable).toBe(false);
  });

  it('withdraws them where a correction landed after the notification', () => {
    const result = revalidate({
      notifiedAt: NOTIFIED,
      currentState: 'PUBLISHED',
      lastCorrectedAt: AFTER,
    });
    expect(result.outcome).toBe('CORRECTED_SINCE_NOTIFICATION');
    expect(result.actionable).toBe(false);
  });

  it('leaves them where the correction predates it', () => {
    const result = revalidate({
      notifiedAt: NOTIFIED,
      currentState: 'PUBLISHED',
      lastCorrectedAt: BEFORE,
    });
    expect(result.outcome).toBe('STILL_CURRENT');
    expect(result.actionable).toBe(true);
  });

  it('reports the more fundamental answer first', () => {
    // A withdrawn alert with an old correction is withdrawn, not still current; a hidden one is
    // hidden, not corrected.
    expect(
      revalidate({ notifiedAt: NOTIFIED, currentState: 'WITHDRAWN', lastCorrectedAt: AFTER })
        .outcome,
    ).toBe('WITHDRAWN');
    expect(
      revalidate({ notifiedAt: NOTIFIED, currentState: null, lastCorrectedAt: AFTER }).outcome,
    ).toBe('NO_LONGER_VISIBLE');
  });

  it('claims no notification where there was none', () => {
    // Opening an alert from inside the app is not a stale notification. Saying "this changed
    // since you were notified" to somebody who was never notified would be inventing an event.
    const result = revalidate({
      notifiedAt: null,
      currentState: 'PUBLISHED',
      lastCorrectedAt: AFTER,
    });
    expect(result.fromNotification).toBe(false);
    expect(result.outcome).toBe('STILL_CURRENT');
    expect(result.actionable).toBe(true);
  });

  it('still withdraws the actions on a withdrawn alert opened from inside the app', () => {
    const result = revalidate({
      notifiedAt: null,
      currentState: 'WITHDRAWN',
      lastCorrectedAt: null,
    });
    expect(result.outcome).toBe('WITHDRAWN');
    expect(result.actionable).toBe(false);
  });

  it('is actionable for exactly one outcome', () => {
    const actionable = REVALIDATION_OUTCOMES.filter((outcome) => {
      const state =
        outcome === 'NO_LONGER_VISIBLE'
          ? null
          : outcome === 'WITHDRAWN' || outcome === 'SUPERSEDED'
            ? outcome
            : 'PUBLISHED';
      return revalidate({
        notifiedAt: NOTIFIED,
        currentState: state,
        lastCorrectedAt: outcome === 'CORRECTED_SINCE_NOTIFICATION' ? AFTER : null,
      }).actionable;
    });
    expect(actionable).toEqual(['STILL_CURRENT']);
  });
});
