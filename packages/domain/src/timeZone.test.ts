import { describe, it, expect } from 'vitest';
import {
  asTimeZone,
  isKnownTimeZone,
  localMinuteOfDayIn,
  recipientLocalMinute,
} from './timeZone.js';
import { MINUTES_PER_DAY, deliveryDecision } from './notificationPolicy.js';

/**
 * What time it is where somebody is.
 *
 * Spec references: `04` Phase 7.5 (quiet hours), `04` Phase 4.1 (a local wall clock plus a zone,
 * never a stored offset), DEC-119, `DEV-030`.
 *
 * THE TWO THINGS THAT MATTER MOST HERE
 *
 * 1. **An unknown zone answers `null`, and `null` means do not hold.** The biased direction, and
 *    the bias is deliberate: the failure it avoids is a `CRITICAL` recall waiting for a window
 *    that never ends. Every path that could return a guess instead is tested for the `null`.
 * 2. **The daylight-saving transition is the whole reason a zone is stored rather than an
 *    offset.** A number written down in January is wrong in July, and the thing it decides is
 *    whether somebody is woken up.
 */

/** India, which is +05:30 all year and therefore the case an offset would get right. */
const KOLKATA = 'Asia/Kolkata';
/** London, which is not, and is therefore the case an offset gets wrong twice a year. */
const LONDON = 'Europe/London';

describe('recognising a zone', () => {
  it('accepts real IANA names', () => {
    for (const zone of [KOLKATA, LONDON, 'UTC', 'America/New_York', 'Australia/Eucla']) {
      expect(isKnownTimeZone(zone)).toBe(true);
    }
  });

  it('refuses anything this runtime does not know', () => {
    // Asked of the runtime rather than matched against a pattern: a pattern accepts `Foo/Bar` and
    // rejects `UTC`, and there is no list to check against.
    for (const zone of ['', '   ', 'Foo/Bar', 'GMT+5:30', 'Mars/Olympus_Mons']) {
      expect(isKnownTimeZone(zone)).toBe(false);
    }
  });

  it('refuses an offset written where a zone belongs, which ICU would accept', () => {
    // A genuine surprise, and the reason the refusal is explicit rather than inherited: modern ICU
    // formats happily against `+05:30`. Storing one is storing a fact about a place *and a date*
    // as though it were a fact about a place - correct today, an hour wrong after the next
    // transition, and what it decides is whether somebody is woken at three in the morning.
    for (const offset of ['+05:30', '-0800', '+07', '-5']) {
      expect(isKnownTimeZone(offset)).toBe(false);
      expect(asTimeZone(offset)).toBeNull();
    }
  });

  it('narrows an untrusted value to a zone or to nothing', () => {
    expect(asTimeZone(` ${KOLKATA} `)).toBe(KOLKATA);
    for (const value of [null, undefined, 42, {}, [], 'Nowhere/Real']) {
      expect(asTimeZone(value)).toBeNull();
    }
  });
});

describe('the local minute', () => {
  it('converts an instant into the minute of the local day', () => {
    // 18:30 UTC is midnight in Kolkata: minute 0, the boundary a quiet-hours window most often
    // straddles.
    expect(localMinuteOfDayIn('2026-09-05T18:30:00.000Z', KOLKATA)).toBe(0);
    expect(localMinuteOfDayIn('2026-09-05T00:00:00.000Z', KOLKATA)).toBe(5 * 60 + 30);
  });

  it('reads midnight as 0 rather than as 1440', () => {
    // `hour12: false` produces `24` for midnight in several locales, and a window evaluated at
    // minute 1440 stops matching at exactly the hour it matters most. `hourCycle: 'h23'` is the
    // reason this is 0.
    const midnight = localMinuteOfDayIn('2026-09-05T00:00:00.000Z', 'UTC');
    expect(midnight).toBe(0);
    expect(midnight).toBeLessThan(MINUTES_PER_DAY);
  });

  it('follows a daylight-saving transition, which is why a zone is stored and not an offset', () => {
    // The same instant, in the same place, six months apart. An offset written down in winter is
    // an hour wrong in summer - and what it decides is whether a phone lights up at three in the
    // morning.
    const winter = localMinuteOfDayIn('2026-01-15T23:30:00.000Z', LONDON);
    const summer = localMinuteOfDayIn('2026-07-15T23:30:00.000Z', LONDON);
    expect(winter).toBe(23 * 60 + 30);
    expect(summer).toBe(30);
    expect(summer).not.toBe(winter);
  });

  it('answers null for a zone it does not know and an instant it cannot read', () => {
    expect(localMinuteOfDayIn('2026-09-05T12:00:00.000Z', 'Nowhere/Real')).toBeNull();
    expect(localMinuteOfDayIn('not-an-instant', KOLKATA)).toBeNull();
    expect(localMinuteOfDayIn('', KOLKATA)).toBeNull();
  });
});

describe('the one function a dispatcher calls', () => {
  it('answers the recipient’s own minute', () => {
    expect(recipientLocalMinute({ at: '2026-09-05T18:30:00.000Z', zone: KOLKATA })).toBe(0);
  });

  it('answers null for every shape of unknown, in one place', () => {
    // The rule lives here so a caller cannot forget it. A caller that checked the zone itself is
    // one that can omit the check, and omitting it means either inventing a local time or holding
    // a critical alert.
    for (const zone of [null, undefined, '', 'Nowhere/Real', 42]) {
      expect(recipientLocalMinute({ at: '2026-09-05T18:30:00.000Z', zone })).toBeNull();
    }
  });
});

describe('what it means for a delivery', () => {
  /** 22:00 to 07:00, the ordinary overnight window. */
  const NIGHT = { startMinute: 22 * 60, endMinute: 7 * 60 };

  function decideAt(instant: string, zone: unknown) {
    return deliveryDecision({
      // HIGH, not MEDIUM: only an interrupt can be held, so a MEDIUM alert would report
      // `held: false` whatever the zone said and the test would pass over a broken conversion.
      urgency: 'HIGH',
      deliverable: true,
      alreadyDelivered: false,
      quietHours: NIGHT,
      localMinuteOfDay: recipientLocalMinute({ at: instant, zone }),
    });
  }

  it('holds a notification inside the recipient own night', () => {
    // 20:00 UTC is 01:30 in Kolkata, which is inside 22:00-07:00. The same instant is 21:00 in
    // London, which is not - so the window is being read in the recipient's day rather than the
    // server's, which is the whole of DEV-030.
    expect(decideAt('2026-09-05T20:00:00.000Z', KOLKATA).held).toBe(true);
    expect(decideAt('2026-09-05T20:00:00.000Z', LONDON).held).toBe(false);
  });

  it('does not hold when the zone is unknown', () => {
    // The approved rule, at the layer that acts on it. Not holding is the safe direction: the
    // failure it avoids is an alert waiting for a window that never ends.
    expect(decideAt('2026-09-05T20:00:00.000Z', null).held).toBe(false);
    expect(decideAt('2026-09-05T20:00:00.000Z', 'Nowhere/Real').held).toBe(false);
  });

  it('never holds a CRITICAL alert, whatever the zone says', () => {
    // The rule that outranks the window. A recall does not wait for morning.
    const critical = deliveryDecision({
      urgency: 'CRITICAL',
      deliverable: true,
      alreadyDelivered: false,
      quietHours: NIGHT,
      localMinuteOfDay: recipientLocalMinute({ at: '2026-09-05T20:00:00.000Z', zone: KOLKATA }),
    });
    expect(critical.held).toBe(false);
    expect(critical.reason).toBe('PIERCED_QUIET_HOURS');
  });
});
