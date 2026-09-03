import { describe, it, expect } from 'vitest';
import {
  localTimeToInstant,
  isoWeekdayOf,
  addDays,
  isActiveOn,
  occurrencesOn,
  occurrencesBetween,
  nextOccurrenceAfter,
  estimateRefill,
  type MedicineSchedule,
} from './schedule.js';
import { calendarDate, instantFrom } from './ports.js';
// The vocabulary moved to `scheduleEntry.ts` when the write path needed it on both sides. The
// block below stays here because it asserts the contract *this* module depends on: a time it
// cannot parse is a reminder that would fire at the wrong hour.
import { parseLocalTime } from './scheduleEntry.js';

const IN = 'Asia/Kolkata'; // UTC+05:30, no DST - the India-first default.
const UK = 'Europe/London'; // UTC+00:00 / +01:00 - has DST.
const NY = 'America/New_York'; // UTC-05:00 / -04:00 - has DST.

function schedule(overrides: Partial<MedicineSchedule> = {}): MedicineSchedule {
  return {
    id: 'sched-1',
    kind: 'FIXED_TIMES',
    timesLocal: ['08:00', '20:00'],
    daysOfWeek: null,
    timeZone: IN,
    startsOn: null,
    endsOn: null,
    active: true,
    directionsText: null,
    ...overrides,
  };
}

describe('parseLocalTime', () => {
  it('parses valid 24-hour times', () => {
    expect(parseLocalTime('00:00')).toEqual({ hours: 0, minutes: 0 });
    expect(parseLocalTime('08:30')).toEqual({ hours: 8, minutes: 30 });
    expect(parseLocalTime('23:59')).toEqual({ hours: 23, minutes: 59 });
  });

  it('rejects malformed times rather than coercing them', () => {
    // A coerced time would fire a medicine reminder at the wrong hour.
    for (const bad of ['24:00', '8:00', '08:60', '0800', 'morning', '', '08:00:00']) {
      expect(() => parseLocalTime(bad)).toThrow(TypeError);
    }
  });
});

describe('localTimeToInstant', () => {
  it('resolves a wall-clock time in a fixed-offset zone', () => {
    // 08:00 in Asia/Kolkata (UTC+05:30) is 02:30 UTC.
    const instant = localTimeToInstant(calendarDate('2026-08-29'), '08:00', IN);
    expect(instant).toBe('2026-08-29T02:30:00.000Z');
  });

  it('resolves midnight correctly', () => {
    // Midnight is where an hour24-vs-hour0 formatting difference would surface.
    const instant = localTimeToInstant(calendarDate('2026-08-29'), '00:00', IN);
    expect(instant).toBe('2026-08-28T18:30:00.000Z');
  });

  it('handles a zone west of UTC', () => {
    // 08:00 in New York during EDT (UTC-04:00) is 12:00 UTC.
    const instant = localTimeToInstant(calendarDate('2026-08-29'), '08:00', NY);
    expect(instant).toBe('2026-08-29T12:00:00.000Z');
  });

  it('keeps the same wall-clock time across a DST transition', () => {
    // THE CASE THAT MATTERS. UK clocks go forward on 2026-03-29. A schedule authored as "08:00"
    // must still mean 08:00 local on both sides - storing a UTC instant would shift the dose by
    // an hour twice a year.
    const beforeDst = localTimeToInstant(calendarDate('2026-03-28'), '08:00', UK);
    const afterDst = localTimeToInstant(calendarDate('2026-03-30'), '08:00', UK);

    expect(beforeDst).toBe('2026-03-28T08:00:00.000Z'); // GMT, UTC+0
    expect(afterDst).toBe('2026-03-30T07:00:00.000Z'); // BST, UTC+1

    // The UTC instants differ, which is exactly right: both are 08:00 local.
    expect(beforeDst).not.toBe(afterDst);
  });

  it('handles the autumn transition where an hour repeats', () => {
    // UK clocks go back on 2026-10-25. 08:00 local is unambiguous that day (the repeat is at
    // 01:00-02:00), so this asserts the resolution settles rather than oscillating.
    const instant = localTimeToInstant(calendarDate('2026-10-25'), '08:00', UK);
    expect(instant).toBe('2026-10-25T08:00:00.000Z');
  });

  it('is deterministic', () => {
    const a = localTimeToInstant(calendarDate('2026-08-29'), '08:00', IN);
    const b = localTimeToInstant(calendarDate('2026-08-29'), '08:00', IN);
    expect(a).toBe(b);
  });
});

describe('isoWeekdayOf', () => {
  it('returns ISO weekdays with Monday as 1', () => {
    // 2026-08-29 is a Saturday.
    expect(isoWeekdayOf(calendarDate('2026-08-29'), IN)).toBe(6);
    expect(isoWeekdayOf(calendarDate('2026-08-31'), IN)).toBe(1); // Monday
    expect(isoWeekdayOf(calendarDate('2026-08-30'), IN)).toBe(7); // Sunday
  });
});

describe('addDays', () => {
  it('advances within a month', () => {
    expect(addDays(calendarDate('2026-08-29'), 1)).toBe('2026-08-30');
  });

  it('crosses a month boundary', () => {
    expect(addDays(calendarDate('2026-08-31'), 1)).toBe('2026-09-01');
  });

  it('crosses a year boundary', () => {
    expect(addDays(calendarDate('2026-12-31'), 1)).toBe('2027-01-01');
  });

  it('handles a leap day', () => {
    expect(addDays(calendarDate('2028-02-28'), 1)).toBe('2028-02-29');
    expect(addDays(calendarDate('2028-02-29'), 1)).toBe('2028-03-01');
  });

  it('goes backwards with a negative offset', () => {
    expect(addDays(calendarDate('2026-03-01'), -1)).toBe('2026-02-28');
  });
});

describe('isActiveOn', () => {
  const date = calendarDate('2026-08-29');

  it('is active for a fixed schedule with no window', () => {
    expect(isActiveOn(schedule(), date)).toBe(true);
  });

  it('is inactive when the schedule is switched off', () => {
    expect(isActiveOn(schedule({ active: false }), date)).toBe(false);
  });

  it('never fires for an as-needed schedule', () => {
    // Spec 04 Phase 4.1: as-needed must be separated from fixed reminders. A reminder engine
    // firing on one would be prompting a dose nobody scheduled.
    expect(isActiveOn(schedule({ kind: 'AS_NEEDED', timesLocal: [] }), date)).toBe(false);
  });

  it('respects a start date', () => {
    expect(isActiveOn(schedule({ startsOn: calendarDate('2026-09-01') }), date)).toBe(false);
    expect(isActiveOn(schedule({ startsOn: calendarDate('2026-08-01') }), date)).toBe(true);
  });

  it('respects an end date', () => {
    expect(isActiveOn(schedule({ endsOn: calendarDate('2026-08-01') }), date)).toBe(false);
    expect(isActiveOn(schedule({ endsOn: calendarDate('2026-09-01') }), date)).toBe(true);
  });

  it('includes the boundary dates themselves', () => {
    expect(isActiveOn(schedule({ startsOn: date, endsOn: date }), date)).toBe(true);
  });

  it('filters by weekday for a selected-days schedule', () => {
    // 2026-08-29 is a Saturday (6).
    const weekdaysOnly = schedule({ kind: 'SELECTED_DAYS', daysOfWeek: [1, 2, 3, 4, 5] });
    expect(isActiveOn(weekdaysOnly, date)).toBe(false);
    expect(isActiveOn(weekdaysOnly, calendarDate('2026-08-31'))).toBe(true); // Monday
  });

  it('treats a null weekday list as every day', () => {
    expect(isActiveOn(schedule({ kind: 'SELECTED_DAYS', daysOfWeek: null }), date)).toBe(true);
  });
});

describe('occurrencesOn', () => {
  it('produces one occurrence per scheduled time, in order', () => {
    const occurrences = occurrencesOn(schedule(), calendarDate('2026-08-29'));
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]?.localTime).toBe('08:00');
    expect(occurrences[1]?.localTime).toBe('20:00');
    expect(occurrences[0]!.dueAt < occurrences[1]!.dueAt).toBe(true);
  });

  it('sorts times that were entered out of order', () => {
    const occurrences = occurrencesOn(
      schedule({ timesLocal: ['20:00', '08:00', '14:00'] }),
      calendarDate('2026-08-29'),
    );
    expect(occurrences.map((o) => o.localTime)).toEqual(['08:00', '14:00', '20:00']);
  });

  it('preserves the local time the user entered alongside the instant', () => {
    // The UI shows what the user typed; the instant is for the reminder engine.
    const occurrence = occurrencesOn(schedule(), calendarDate('2026-08-29'))[0]!;
    expect(occurrence.localTime).toBe('08:00');
    expect(occurrence.localDate).toBe('2026-08-29');
    expect(occurrence.dueAt).toBe('2026-08-29T02:30:00.000Z');
  });

  it('produces nothing for an inactive date', () => {
    expect(occurrencesOn(schedule({ active: false }), calendarDate('2026-08-29'))).toEqual([]);
  });

  it('is deterministic', () => {
    const date = calendarDate('2026-08-29');
    expect(occurrencesOn(schedule(), date)).toEqual(occurrencesOn(schedule(), date));
  });
});

describe('occurrencesBetween', () => {
  it('covers an inclusive range', () => {
    const occurrences = occurrencesBetween(
      schedule(),
      calendarDate('2026-08-29'),
      calendarDate('2026-08-31'),
    );
    // Three days, twice daily.
    expect(occurrences).toHaveLength(6);
    expect(occurrences[0]?.localDate).toBe('2026-08-29');
    expect(occurrences[5]?.localDate).toBe('2026-08-31');
  });

  it('returns nothing for an inverted range', () => {
    expect(
      occurrencesBetween(schedule(), calendarDate('2026-08-31'), calendarDate('2026-08-29')),
    ).toEqual([]);
  });

  it('skips days outside a selected-day pattern', () => {
    const weekdaysOnly = schedule({
      kind: 'SELECTED_DAYS',
      daysOfWeek: [1, 2, 3, 4, 5],
      timesLocal: ['09:00'],
    });
    // Sat 29th through Tue 1st: only Mon 31st and Tue 1st qualify.
    const occurrences = occurrencesBetween(
      weekdaysOnly,
      calendarDate('2026-08-29'),
      calendarDate('2026-09-01'),
    );
    expect(occurrences.map((o) => o.localDate)).toEqual(['2026-08-31', '2026-09-01']);
  });

  it('caps generation so a mistaken range cannot produce an unbounded list', () => {
    // Spec 12 requires bounded memory on device.
    const occurrences = occurrencesBetween(
      schedule({ timesLocal: ['08:00'] }),
      calendarDate('2026-01-01'),
      calendarDate('2036-01-01'),
      10,
    );
    expect(occurrences.length).toBeLessThanOrEqual(11);
  });

  it('keeps each occurrence at the same local time across a DST change', () => {
    const ukSchedule = schedule({ timeZone: UK, timesLocal: ['08:00'] });
    const occurrences = occurrencesBetween(
      ukSchedule,
      calendarDate('2026-03-28'),
      calendarDate('2026-03-30'),
    );

    expect(occurrences.map((o) => o.localTime)).toEqual(['08:00', '08:00', '08:00']);
    // The UTC instants shift by an hour across the transition, which is what keeps local time
    // constant.
    expect(occurrences[0]?.dueAt).toBe('2026-03-28T08:00:00.000Z');
    expect(occurrences[2]?.dueAt).toBe('2026-03-30T07:00:00.000Z');
  });
});

describe('nextOccurrenceAfter', () => {
  it('finds the next dose later the same day', () => {
    // 09:00 IST on the 29th = 03:30 UTC. The next dose is 20:00 IST = 14:30 UTC.
    const next = nextOccurrenceAfter(schedule(), instantFrom('2026-08-29T03:30:00.000Z'));
    expect(next?.localTime).toBe('20:00');
    expect(next?.localDate).toBe('2026-08-29');
  });

  it('rolls over to the next day after the last dose', () => {
    const next = nextOccurrenceAfter(schedule(), instantFrom('2026-08-29T16:00:00.000Z'));
    expect(next?.localDate).toBe('2026-08-30');
    expect(next?.localTime).toBe('08:00');
  });

  it('skips days a selected-day pattern excludes', () => {
    const weekdaysOnly = schedule({
      kind: 'SELECTED_DAYS',
      daysOfWeek: [1, 2, 3, 4, 5],
      timesLocal: ['09:00'],
    });
    // Saturday evening: the next dose is Monday morning.
    const next = nextOccurrenceAfter(weekdaysOnly, instantFrom('2026-08-29T18:00:00.000Z'));
    expect(next?.localDate).toBe('2026-08-31');
  });

  it('returns null once the schedule has ended', () => {
    // A finished course is a normal state, not an error.
    const ended = schedule({ endsOn: calendarDate('2026-08-01') });
    expect(nextOccurrenceAfter(ended, instantFrom('2026-08-29T00:00:00.000Z'))).toBeNull();
  });

  it('returns null for an as-needed schedule', () => {
    const asNeeded = schedule({ kind: 'AS_NEEDED', timesLocal: [] });
    expect(nextOccurrenceAfter(asNeeded, instantFrom('2026-08-29T00:00:00.000Z'))).toBeNull();
  });

  it('returns null rather than searching forever', () => {
    const inactive = schedule({ active: false });
    expect(nextOccurrenceAfter(inactive, instantFrom('2026-08-29T00:00:00.000Z'), 5)).toBeNull();
  });
});

describe('schedule never infers from adherence (spec 04 Phase 4.1)', () => {
  it('takes no dose-event input at all', () => {
    // Structural guarantee: the functions cannot adjust a schedule from adherence history
    // because they never receive it.
    const withDirections = schedule({
      directionsText: 'Take one tablet twice daily with food.',
    });
    const occurrences = occurrencesOn(withDirections, calendarDate('2026-08-29'));
    expect(occurrences).toHaveLength(2);
  });

  it('preserves written directions verbatim and never parses them', () => {
    // Spec 09 forbids reinterpreting a prescription instruction. The text is carried for display
    // only; the reminder times come from what the user explicitly entered.
    const directions = 'Take one tablet three times daily, after meals.';
    const s = schedule({ directionsText: directions, timesLocal: ['08:00', '20:00'] });

    expect(s.directionsText).toBe(directions);
    // The directions mention three times daily; the schedule still produces exactly the two
    // occurrences the user entered. Kynviora does not resolve the discrepancy on its own.
    expect(occurrencesOn(s, calendarDate('2026-08-29'))).toHaveLength(2);
  });
});

describe('estimateRefill (spec 04 Phase 4.4)', () => {
  it('estimates a depletion date', () => {
    const estimate = estimateRefill({
      quantityRemaining: 30,
      dosesPerDay: 2,
      asOf: calendarDate('2026-08-29'),
    });
    expect(estimate.daysRemaining).toBe(15);
    expect(estimate.estimatedDepletionOn).toBe('2026-09-13');
  });

  it('rounds down rather than up', () => {
    // An estimate that runs out a day early is a harmless prompt; one that runs out a day late
    // could leave someone without a medicine they need.
    const estimate = estimateRefill({
      quantityRemaining: 31,
      dosesPerDay: 2,
      asOf: calendarDate('2026-08-29'),
    });
    expect(estimate.daysRemaining).toBe(15);
  });

  it('labels the result as an estimate, not an inventory record', () => {
    const estimate = estimateRefill({
      quantityRemaining: 30,
      dosesPerDay: 1,
      asOf: calendarDate('2026-08-29'),
    });
    expect(estimate.assumptionsNote).toMatch(/estimate/i);
    expect(estimate.assumptionsNote).toMatch(/not a record of what is left/i);
  });

  it('states the assumptions it used', () => {
    const estimate = estimateRefill({
      quantityRemaining: 28,
      dosesPerDay: 4,
      asOf: calendarDate('2026-08-29'),
    });
    expect(estimate.assumptionsNote).toContain('28');
    expect(estimate.assumptionsNote).toContain('4');
  });

  it('handles an empty supply', () => {
    const estimate = estimateRefill({
      quantityRemaining: 0,
      dosesPerDay: 1,
      asOf: calendarDate('2026-08-29'),
    });
    expect(estimate.daysRemaining).toBe(0);
    expect(estimate.estimatedDepletionOn).toBe('2026-08-29');
  });

  it('rejects impossible inputs rather than producing a nonsense date', () => {
    expect(() =>
      estimateRefill({ quantityRemaining: 10, dosesPerDay: 0, asOf: calendarDate('2026-08-29') }),
    ).toThrow(RangeError);
    expect(() =>
      estimateRefill({ quantityRemaining: -1, dosesPerDay: 1, asOf: calendarDate('2026-08-29') }),
    ).toThrow(RangeError);
  });
});
