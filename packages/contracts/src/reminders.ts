/**
 * Turning what the server said about a profile's schedules into what a device can plan from.
 *
 * Spec references: `04` Phase 4.1 and 4.2, `12` (the client is a validated read projection),
 * `18` (never present uncertain information as certain), `09`.
 *
 * WHY THIS IS NOT IN `apps/**`
 * It looks like plumbing and it is not. It decides which rows a device will and will not fire a
 * reminder from, and `apps/**` is outside the test run - so a rule written there is a rule
 * nothing checks. The rule it holds is the one that matters most on this path: **a schedule this
 * build cannot interpret produces no reminder, never a reminder at a time nobody chose.**
 *
 * WHY A ROW IS DROPPED RATHER THAN REPAIRED
 * Every other read in this client casts the parsed body to the response type, and that is honest
 * because the row came from a response this client accepted. Here the values leave the wire's
 * vocabulary and enter the domain's - `ScheduleKind`, `IsoWeekday` - and a bad value would become
 * a time. Coercing an out-of-range weekday to Monday, or an unknown kind to fixed times, invents
 * a schedule; dropping it means one medicine is not reminded about, which is visible on the
 * screen that lists them and is the failure a person can act on.
 */

import {
  isScheduleKind,
  type CalendarDate,
  type IsoWeekday,
  type MedicineSchedule,
  type ReminderSubject,
} from '@kynviora/domain';
import type { ProfileSchedulesResponse, ScheduleWithItem } from './client.js';

export interface DeviceSchedules {
  readonly schedules: readonly MedicineSchedule[];
  /** What each schedule is about, keyed by schedule ID. */
  readonly subjects: ReadonlyMap<string, ReminderSubject>;
  /**
   * How many rows were dropped because this build could not interpret them.
   *
   * Reported rather than swallowed, so a screen can say the list is short instead of showing a
   * shorter one as though it were the whole answer (`06`, and the same choice the Review Inbox
   * makes for a task kind it does not recognise).
   */
  readonly dropped: number;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function asDate(value: string | null): CalendarDate | null | undefined {
  if (value === null) return null;
  return DATE_SHAPE.test(value) ? (value as CalendarDate) : undefined;
}

function asWeekdays(days: readonly number[] | null): readonly IsoWeekday[] | null | undefined {
  if (days === null) return null;
  // An empty list is not "every day" - it is a schedule that never fires, which the server refuses
  // to store. Arriving here means something upstream is wrong, and the safe reading is neither.
  if (days.length === 0) return undefined;
  for (const day of days) {
    if (!Number.isInteger(day) || day < 1 || day > 7) return undefined;
  }
  return days as readonly IsoWeekday[];
}

/** One row, or `null` where this build cannot say what it means. */
export function deviceScheduleFrom(row: ScheduleWithItem): MedicineSchedule | null {
  if (!isScheduleKind(row.scheduleKind)) return null;
  if (!row.timesLocal.every((time) => TIME_SHAPE.test(time))) return null;

  const daysOfWeek = asWeekdays(row.daysOfWeek);
  if (daysOfWeek === undefined) return null;

  const startsOn = asDate(row.startsOn);
  const endsOn = asDate(row.endsOn);
  if (startsOn === undefined || endsOn === undefined) return null;

  if (typeof row.timeZone !== 'string' || row.timeZone === '') return null;

  return {
    id: row.id,
    kind: row.scheduleKind,
    timesLocal: row.timesLocal,
    daysOfWeek,
    timeZone: row.timeZone,
    startsOn,
    endsOn,
    active: row.active,
    // Never carried to a device's reminder text and never parsed. `09`: the prescriber's wording
    // lives on the item, and a notification restating it would be Kynviora reinterpreting a
    // clinical instruction on a lock screen.
    directionsText: null,
  };
}

/** Everything a device needs to plan, from one response. */
export function deviceSchedules(response: ProfileSchedulesResponse): DeviceSchedules {
  const schedules: MedicineSchedule[] = [];
  const subjects = new Map<string, ReminderSubject>();
  let dropped = 0;

  for (const row of response.schedules) {
    const schedule = deviceScheduleFrom(row);
    if (schedule === null) {
      dropped += 1;
      continue;
    }
    schedules.push(schedule);
    subjects.set(schedule.id, {
      ownedItemId: row.ownedItemId,
      itemDisplayName: row.itemDisplayName,
      // The profile is named once on the response rather than repeated per row, and `null` where
      // the caller cannot read it. A placeholder here would end up in a notification body.
      profileDisplayName: response.profileDisplayName,
    });
  }

  return { schedules, subjects, dropped };
}
