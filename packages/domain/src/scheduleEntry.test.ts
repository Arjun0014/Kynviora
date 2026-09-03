import { describe, it, expect } from 'vitest';
import {
  ISO_WEEKDAYS,
  MAX_TIMES_PER_DAY,
  SCHEDULE_KINDS,
  isKnownTimeZone,
  isLocalTime,
  isScheduleKind,
  normalizeScheduleEntry,
  parseLocalTime,
  type ScheduleEntry,
} from './scheduleEntry.js';
import { isOk, isErr } from './result.js';

const BASE: ScheduleEntry = {
  scheduleKind: 'FIXED_TIMES',
  timesLocal: ['08:00'],
  timeZone: 'Asia/Kolkata',
};

function normalized(entry: ScheduleEntry) {
  const result = normalizeScheduleEntry(entry);
  if (!isOk(result)) throw new Error(`expected ok, got ${result.error.reason}`);
  return result.value;
}

function refusalField(entry: ScheduleEntry): string {
  const result = normalizeScheduleEntry(entry);
  if (!isErr(result)) throw new Error('expected a refusal');
  return String(result.error.detail?.field ?? '');
}

describe('the schedule vocabulary', () => {
  it('has exactly the three kinds migration 0004 admits', () => {
    // The database CHECK constraint names the same three. A fourth added here without one there
    // becomes a constraint violation at runtime instead of a refusal a person can read.
    expect([...SCHEDULE_KINDS]).toEqual(['FIXED_TIMES', 'SELECTED_DAYS', 'AS_NEEDED']);
  });

  it('recognises its own members and nothing else', () => {
    for (const kind of SCHEDULE_KINDS) expect(isScheduleKind(kind)).toBe(true);
    expect(isScheduleKind('DAILY')).toBe(false);
    expect(isScheduleKind('')).toBe(false);
  });

  it('numbers the weekdays the way ISO-8601 does', () => {
    // 1 = Monday. The column stores these directly, and a Sunday-first convention here would move
    // every selected-day schedule by a day without anything failing.
    expect([...ISO_WEEKDAYS]).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('a local time', () => {
  it('is a 24-hour HH:MM', () => {
    expect(isLocalTime('00:00')).toBe(true);
    expect(isLocalTime('23:59')).toBe(true);
    expect(isLocalTime('08:30')).toBe(true);
  });

  it('is not anything else', () => {
    for (const bad of ['8:30', '24:00', '23:60', '0800', '08:00:00', '', ' 08:00']) {
      expect(isLocalTime(bad)).toBe(false);
    }
  });

  it('throws when parsed after failing that test, because reaching there is a broken invariant', () => {
    expect(() => parseLocalTime('24:00')).toThrow(TypeError);
    expect(parseLocalTime('08:05')).toEqual({ hours: 8, minutes: 5 });
  });
});

describe('a time zone', () => {
  it('is checked against the runtime rather than a bundled list', () => {
    expect(isKnownTimeZone('Asia/Kolkata')).toBe(true);
    expect(isKnownTimeZone('Europe/London')).toBe(true);
    expect(isKnownTimeZone('UTC')).toBe(true);
  });

  it('is refused when the runtime does not know it', () => {
    // A zone nothing can compute with is a schedule that can never produce a reminder.
    expect(isKnownTimeZone('Mars/Olympus')).toBe(false);
    expect(refusalField({ ...BASE, timeZone: 'Mars/Olympus' })).toBe('timeZone');
    expect(refusalField({ ...BASE, timeZone: '  ' })).toBe('timeZone');
  });
});

describe('normalising what somebody entered', () => {
  it('keeps a fixed-time schedule as given', () => {
    const value = normalized({ ...BASE, timesLocal: ['08:00', '20:00'] });
    expect(value.scheduleKind).toBe('FIXED_TIMES');
    expect(value.timesLocal).toEqual(['08:00', '20:00']);
    expect(value.daysOfWeek).toBeNull();
    expect(value.startsOn).toBeNull();
    expect(value.endsOn).toBeNull();
  });

  it('puts the times in order, so two ways of writing one schedule are one schedule', () => {
    expect(normalized({ ...BASE, timesLocal: ['20:00', '08:00'] }).timesLocal).toEqual([
      '08:00',
      '20:00',
    ]);
  });

  it('drops an exact duplicate time', () => {
    // Two 08:00 entries are one dose written twice. Stored as two, a reminder engine tells
    // somebody to take the same tablet twice at the same minute.
    expect(normalized({ ...BASE, timesLocal: ['08:00', '08:00'] }).timesLocal).toEqual(['08:00']);
  });

  it('refuses a malformed time rather than repairing it', () => {
    // Repairing "8:00" to "08:00" is a guess about a medicine's timing.
    expect(refusalField({ ...BASE, timesLocal: ['8:00'] })).toBe('timesLocal');
  });

  it('refuses more times than the model represents', () => {
    const many = Array.from(
      { length: MAX_TIMES_PER_DAY + 1 },
      (_, index) => `${String(index).padStart(2, '0')}:00`,
    );
    expect(refusalField({ ...BASE, timesLocal: many })).toBe('timesLocal');
  });
});

describe('as-needed is separated from a fixed reminder', () => {
  it('carries no times', () => {
    const value = normalized({ scheduleKind: 'AS_NEEDED', timeZone: 'Asia/Kolkata' });
    expect(value.timesLocal).toEqual([]);
  });

  it('refuses times outright', () => {
    // `04` Phase 4.1 separates the two, and a time on an as-needed medicine is a reminder nobody
    // asked for about something meant to be taken only when needed.
    expect(
      refusalField({ scheduleKind: 'AS_NEEDED', timeZone: 'UTC', timesLocal: ['08:00'] }),
    ).toBe('timesLocal');
  });

  it('is the only kind that may have none', () => {
    expect(refusalField({ ...BASE, timesLocal: [] })).toBe('timesLocal');
    expect(refusalField({ scheduleKind: 'SELECTED_DAYS', timeZone: 'UTC', timesLocal: [] })).toBe(
      'timesLocal',
    );
  });
});

describe('selected days', () => {
  it('are ordered and de-duplicated', () => {
    const value = normalized({
      scheduleKind: 'SELECTED_DAYS',
      timeZone: 'UTC',
      timesLocal: ['09:00'],
      daysOfWeek: [3, 1, 1],
    });
    expect(value.daysOfWeek).toEqual([1, 3]);
  });

  it('mean every day when they are absent', () => {
    const value = normalized({
      scheduleKind: 'SELECTED_DAYS',
      timeZone: 'UTC',
      timesLocal: ['09:00'],
    });
    expect(value.daysOfWeek).toBeNull();
  });

  it('are refused when the list is empty, which is not the same as every day', () => {
    // A schedule that fires on no day is a medicine somebody believes they are being reminded
    // about and is not.
    expect(
      refusalField({
        scheduleKind: 'SELECTED_DAYS',
        timeZone: 'UTC',
        timesLocal: ['09:00'],
        daysOfWeek: [],
      }),
    ).toBe('daysOfWeek');
  });

  it('are refused outside 1-7', () => {
    for (const day of [0, 8, -1, 1.5]) {
      expect(
        refusalField({
          scheduleKind: 'SELECTED_DAYS',
          timeZone: 'UTC',
          timesLocal: ['09:00'],
          daysOfWeek: [day],
        }),
      ).toBe('daysOfWeek');
    }
  });

  it('are refused on a kind that is not selected days', () => {
    // Otherwise the kind and the data disagree, and the row means whichever the reader looked at.
    expect(refusalField({ ...BASE, daysOfWeek: [1] })).toBe('daysOfWeek');
    expect(refusalField({ scheduleKind: 'AS_NEEDED', timeZone: 'UTC', daysOfWeek: [1] })).toBe(
      'daysOfWeek',
    );
  });
});

describe('start and end dates', () => {
  it('are kept when they are calendar dates', () => {
    const value = normalized({ ...BASE, startsOn: '2026-09-01', endsOn: '2026-09-10' });
    expect(value.startsOn).toBe('2026-09-01');
    expect(value.endsOn).toBe('2026-09-10');
  });

  it('treat blank as absent rather than as a value', () => {
    expect(normalized({ ...BASE, startsOn: '   ', endsOn: null }).startsOn).toBeNull();
  });

  it('are refused when they are not calendar dates', () => {
    expect(refusalField({ ...BASE, startsOn: '2026-09-01T00:00:00Z' })).toBe('startsOn');
    expect(refusalField({ ...BASE, endsOn: '01/09/2026' })).toBe('endsOn');
  });

  it('are refused when the course ends before it starts', () => {
    expect(refusalField({ ...BASE, startsOn: '2026-09-10', endsOn: '2026-09-01' })).toBe('endsOn');
  });

  it('allow a single-day course', () => {
    expect(normalized({ ...BASE, startsOn: '2026-09-01', endsOn: '2026-09-01' }).endsOn).toBe(
      '2026-09-01',
    );
  });
});

describe('what a schedule cannot say', () => {
  it('has no field for a dose, a quantity or an instruction', () => {
    // `09` forbids Kynviora reinterpreting a prescription instruction and `04` Phase 4.1 requires
    // written directions to be preserved as entered - they live on the item, in the prescriber's
    // words. A structured quantity here would be Kynviora restating a clinician, which is the same
    // mistake as parsing one. The absence is the enforcement, so it is asserted rather than
    // trusted.
    const value = normalized({ ...BASE, startsOn: '2026-09-01' });
    const keys = Object.keys(value).sort();
    expect(keys).toEqual([
      'daysOfWeek',
      'endsOn',
      'scheduleKind',
      'startsOn',
      'timeZone',
      'timesLocal',
    ]);
  });

  it('refuses a kind it does not have', () => {
    expect(refusalField({ ...BASE, scheduleKind: 'EVERY_OTHER_DAY' })).toBe('scheduleKind');
  });
});
