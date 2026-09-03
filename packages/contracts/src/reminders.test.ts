import { describe, it, expect } from 'vitest';
import { deviceScheduleFrom, deviceSchedules } from './reminders.js';
import type { ProfileSchedulesResponse, ScheduleWithItem } from './client.js';
import { planReminders, instantFrom } from '@kynviora/domain';

/**
 * What a device is willing to plan a reminder from.
 *
 * The rule under test is one-directional and it is the important one on this path: **a row this
 * build cannot interpret produces no reminder.** Coercing a bad value would invent a time to tell
 * somebody to take a medicine, which is worse than not reminding them - they would have no reason
 * to doubt it.
 */

const ROW: ScheduleWithItem = {
  id: '00000000-0000-4000-8000-0000000000a1',
  ownedItemId: '00000000-0000-4000-8000-0000000000b1',
  scheduleKind: 'FIXED_TIMES',
  timesLocal: ['08:00', '20:00'],
  daysOfWeek: null,
  timeZone: 'Asia/Kolkata',
  startsOn: null,
  endsOn: null,
  active: true,
  version: 1,
  updatedAt: null,
  itemDisplayName: 'Synthetic Tablet',
};

function response(...rows: readonly ScheduleWithItem[]): ProfileSchedulesResponse {
  return {
    profileId: '00000000-0000-4000-8000-0000000000c1',
    profileDisplayName: 'Parent A',
    schedules: rows.length === 0 ? [ROW] : rows,
    serverTime: '2026-09-02T12:00:00.000Z',
  };
}

describe('a row this build understands', () => {
  it('becomes a schedule the planner can expand', () => {
    const schedule = deviceScheduleFrom(ROW);
    expect(schedule).not.toBeNull();
    expect(schedule?.kind).toBe('FIXED_TIMES');
    expect(schedule?.timesLocal).toEqual(['08:00', '20:00']);
    expect(schedule?.timeZone).toBe('Asia/Kolkata');
  });

  it('carries no directions text onto the device', () => {
    // `09`: the prescriber's wording stays on the item. A notification restating it would be
    // Kynviora reinterpreting a clinical instruction, on a lock screen, with no way to check it.
    expect(deviceScheduleFrom(ROW)?.directionsText).toBeNull();
  });

  it('keeps the start and end of a course as dates', () => {
    const schedule = deviceScheduleFrom({ ...ROW, startsOn: '2026-09-04', endsOn: '2026-09-20' });
    expect(schedule?.startsOn).toBe('2026-09-04');
    expect(schedule?.endsOn).toBe('2026-09-20');
  });

  it('keeps selected weekdays', () => {
    expect(
      deviceScheduleFrom({ ...ROW, scheduleKind: 'SELECTED_DAYS', daysOfWeek: [1, 3, 5] })
        ?.daysOfWeek,
    ).toEqual([1, 3, 5]);
  });

  it('keeps an as-needed row, which plans nothing on its own', () => {
    // Dropped by the planner rather than here, because `AS_NEEDED` is a kind this build knows -
    // and a screen that lists what the device is tracking should still see it.
    const schedule = deviceScheduleFrom({ ...ROW, scheduleKind: 'AS_NEEDED', timesLocal: [] });
    expect(schedule?.kind).toBe('AS_NEEDED');
  });
});

describe('a row this build cannot interpret is dropped, never repaired', () => {
  const badRows: readonly (readonly [string, ScheduleWithItem])[] = [
    ['a kind added by a later server', { ...ROW, scheduleKind: 'EVERY_OTHER_DAY' }],
    ['a time that is not a 24-hour clock', { ...ROW, timesLocal: ['8am'] }],
    ['a time out of range', { ...ROW, timesLocal: ['25:00'] }],
    ['a weekday out of range', { ...ROW, scheduleKind: 'SELECTED_DAYS', daysOfWeek: [0] }],
    ['a weekday that is not whole', { ...ROW, scheduleKind: 'SELECTED_DAYS', daysOfWeek: [1.5] }],
    // Not "every day": an empty selection is a schedule that never fires, which the server
    // refuses to store. Reaching here means something upstream is wrong, and the safe reading is
    // neither interpretation.
    ['an empty weekday list', { ...ROW, scheduleKind: 'SELECTED_DAYS', daysOfWeek: [] }],
    ['a start date that is not a date', { ...ROW, startsOn: 'next Tuesday' }],
    ['an end date that is not a date', { ...ROW, endsOn: '' }],
    ['no time zone at all', { ...ROW, timeZone: '' }],
  ];

  for (const [what, row] of badRows) {
    it(`drops ${what}`, () => {
      expect(deviceScheduleFrom(row)).toBeNull();
    });
  }

  it('counts what it dropped rather than swallowing it', () => {
    // So a screen can say the list is short, instead of showing a shorter one as though it were
    // the whole answer.
    const outcome = deviceSchedules(response(ROW, { ...ROW, id: 'x', timesLocal: ['8am'] }));
    expect(outcome.schedules).toHaveLength(1);
    expect(outcome.dropped).toBe(1);
  });

  it('never turns a bad row into a reminder at a time nobody chose', () => {
    // The property, stated end to end. A coerced weekday or a coerced kind would come out the
    // other side as an instant, and somebody would be told to take a medicine because of it.
    const outcome = deviceSchedules(
      response({ ...ROW, scheduleKind: 'SELECTED_DAYS', daysOfWeek: [0, 9] }),
    );
    const plan = planReminders({
      schedules: outcome.schedules,
      subjects: outcome.subjects,
      now: instantFrom('2026-09-02T02:00:00.000Z'),
      detailLevel: 'GENERIC',
    });
    expect(plan).toEqual([]);
  });
});

describe('what a reminder is about', () => {
  it('names the medicine and the profile from the one response', () => {
    const outcome = deviceSchedules(response());
    const subject = outcome.subjects.get(ROW.id);
    expect(subject?.ownedItemId).toBe(ROW.ownedItemId);
    expect(subject?.itemDisplayName).toBe('Synthetic Tablet');
    expect(subject?.profileDisplayName).toBe('Parent A');
  });

  it('carries a null profile name rather than a placeholder', () => {
    // A placeholder would end up in a notification body at the level that shows names.
    const outcome = deviceSchedules({ ...response(), profileDisplayName: null });
    expect(outcome.subjects.get(ROW.id)?.profileDisplayName).toBeNull();
  });

  it('produces nothing at all from an empty response', () => {
    const outcome = deviceSchedules({ ...response(), schedules: [] });
    expect(outcome.schedules).toEqual([]);
    expect(outcome.dropped).toBe(0);
  });
});
