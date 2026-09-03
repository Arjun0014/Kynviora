/**
 * Medicine schedule computation.
 *
 * Spec references: `04` Phase 4.1 and 4.4, `19` ("Schedule calculation has deterministic
 * tests"), `18` (no shaming), `09` (medication safety language).
 *
 * THE BOUNDARY THIS MODULE RESPECTS
 * `04` Phase 4.1: "Kynviora does not infer dose changes from adherence history." This module
 * computes **when a reminder is due** from what the user entered. It never derives a dose, never
 * adjusts a schedule from missed events, and never interprets adherence as a clinical signal.
 *
 * WHY TIME ZONES ARE HANDLED EXPLICITLY
 * A schedule is authored in local wall-clock time - "08:00 and 20:00" - and must keep firing at
 * those local times through a DST transition or a journey across zones. Storing a UTC instant
 * would silently shift a dose by an hour twice a year. So the schedule stores local times plus an
 * IANA zone, and occurrences are computed from them.
 */

import type { CalendarDate, Instant, IsoWeekday, ScheduleKind } from '@kynviora/domain';
import { calendarDate, instantFrom, parseLocalTime } from '@kynviora/domain';

// The vocabulary a person enters a schedule in lives in `@kynviora/domain`, because the client
// needs the same words and DEC-010 keeps this package off the phone. What is here is the half a
// phone has no business doing: turning a wall-clock pattern into instants.
export type { IsoWeekday, ScheduleKind };
export { parseLocalTime };

export interface MedicineSchedule {
  readonly id: string;
  readonly kind: ScheduleKind;
  /** Local wall-clock times, `HH:MM`, 24-hour. Empty for `AS_NEEDED`. */
  readonly timesLocal: readonly string[];
  /** Weekdays for `SELECTED_DAYS`. Null means every day. */
  readonly daysOfWeek: readonly IsoWeekday[] | null;
  /** IANA zone, e.g. `Asia/Kolkata`. */
  readonly timeZone: string;
  readonly startsOn: CalendarDate | null;
  readonly endsOn: CalendarDate | null;
  readonly active: boolean;
  /**
   * Written directions exactly as prescribed or printed.
   *
   * Preserved verbatim and never parsed into a schedule. `04` Phase 4.1 requires source text to
   * be kept as entered, and `09` forbids Kynviora from reinterpreting a prescription
   * instruction - "take with food, twice daily" is a clinician's wording, not an input to infer
   * dosing from.
   */
  readonly directionsText: string | null;
}

/** One computed reminder occurrence. */
export interface ScheduleOccurrence {
  readonly scheduleId: string;
  /** The exact instant the reminder is due. */
  readonly dueAt: Instant;
  /** The local date it belongs to, for grouping a "today" list. */
  readonly localDate: CalendarDate;
  /** The local time as authored, so the UI can show what the user entered. */
  readonly localTime: string;
}

/**
 * Resolve a local wall-clock time in a named zone to a UTC instant.
 *
 * Implemented with `Intl.DateTimeFormat` rather than a date library so there is no dependency to
 * drift, and so the behaviour is exactly what the platform's own zone database says.
 *
 * The approach: guess an instant, ask what local time that instant actually is in the zone,
 * and correct by the difference. One correction pass is sufficient for every real zone offset;
 * a second pass runs to settle the DST boundary case where the first correction crosses the
 * transition itself.
 */
export function localTimeToInstant(
  date: CalendarDate,
  localTime: string,
  timeZone: string,
): Instant {
  const { hours, minutes } = parseLocalTime(localTime);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];

  // First guess: treat the wall-clock time as if it were UTC.
  let guess = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);

  for (let pass = 0; pass < 2; pass += 1) {
    const offsetMs = zoneOffsetMs(guess, timeZone);
    const corrected = Date.UTC(year, month - 1, day, hours, minutes, 0, 0) - offsetMs;
    if (corrected === guess) break;
    guess = corrected;
  }

  return instantFrom(new Date(guess).toISOString());
}

/**
 * The zone's UTC offset in milliseconds at a given instant.
 *
 * Derived by formatting the instant in the target zone and comparing against the same fields
 * interpreted as UTC.
 */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  // `hour` can format as 24 for midnight under hour12:false in some engines.
  const hour = read('hour') % 24;

  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    hour,
    read('minute'),
    read('second'),
  );

  return asUtc - instantMs;
}

/** The ISO weekday of a calendar date in a given zone. */
export function isoWeekdayOf(date: CalendarDate, timeZone: string): IsoWeekday {
  const noon = localTimeToInstant(date, '12:00', timeZone);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
  const weekday = formatter.format(new Date(noon));
  const index: Record<string, IsoWeekday> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const resolved = index[weekday];
  if (resolved === undefined) {
    throw new Error(`Could not resolve weekday for ${date} in ${timeZone}`);
  }
  return resolved;
}

/** Add whole days to a calendar date. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return calendarDate(shifted.toISOString().slice(0, 10));
}

/**
 * Whether the schedule is active on a given local date.
 *
 * A schedule outside its start/end window produces no occurrences, and an `AS_NEEDED` schedule
 * produces none at all - `04` Phase 4.1 requires as-needed to be separated from fixed reminders,
 * so a reminder engine must never fire on one.
 */
export function isActiveOn(schedule: MedicineSchedule, date: CalendarDate): boolean {
  if (!schedule.active) return false;
  if (schedule.kind === 'AS_NEEDED') return false;
  if (schedule.startsOn !== null && date < schedule.startsOn) return false;
  if (schedule.endsOn !== null && date > schedule.endsOn) return false;

  if (schedule.kind === 'SELECTED_DAYS' && schedule.daysOfWeek !== null) {
    return schedule.daysOfWeek.includes(isoWeekdayOf(date, schedule.timeZone));
  }

  return true;
}

/**
 * Compute occurrences for one local date.
 *
 * Deterministic: the same schedule and date always produce the same instants, which is what `19`
 * requires and what makes a reminder reproducible after a device restart.
 */
export function occurrencesOn(
  schedule: MedicineSchedule,
  date: CalendarDate,
): readonly ScheduleOccurrence[] {
  if (!isActiveOn(schedule, date)) return [];

  return schedule.timesLocal
    .map((localTime) => ({
      scheduleId: schedule.id,
      dueAt: localTimeToInstant(date, localTime, schedule.timeZone),
      localDate: date,
      localTime,
    }))
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));
}

/**
 * Compute occurrences across an inclusive date range.
 *
 * @param maxDays - hard cap so a mistaken range cannot generate an unbounded list. `12` requires
 *        bounded memory on device, and 366 covers a year of reminders.
 */
export function occurrencesBetween(
  schedule: MedicineSchedule,
  from: CalendarDate,
  to: CalendarDate,
  maxDays = 366,
): readonly ScheduleOccurrence[] {
  if (to < from) return [];

  const occurrences: ScheduleOccurrence[] = [];
  let cursor = from;

  for (let day = 0; day <= maxDays; day += 1) {
    if (cursor > to) break;
    occurrences.push(...occurrencesOn(schedule, cursor));
    cursor = addDays(cursor, 1);
  }

  return occurrences;
}

/**
 * The next occurrence at or after a given instant.
 *
 * Returns `null` rather than throwing when a schedule has ended - a finished course is a normal
 * state, not an error.
 */
export function nextOccurrenceAfter(
  schedule: MedicineSchedule,
  after: Instant,
  searchDays = 90,
): ScheduleOccurrence | null {
  const startDate = calendarDate(after.slice(0, 10));

  for (let day = 0; day <= searchDays; day += 1) {
    const date = addDays(startDate, day);
    if (schedule.endsOn !== null && date > schedule.endsOn) return null;

    for (const occurrence of occurrencesOn(schedule, date)) {
      if (occurrence.dueAt > after) return occurrence;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Refill estimation
// ---------------------------------------------------------------------------

export interface RefillEstimateInput {
  readonly quantityRemaining: number;
  readonly dosesPerDay: number;
  readonly asOf: CalendarDate;
}

export interface RefillEstimate {
  readonly estimatedDepletionOn: CalendarDate;
  readonly daysRemaining: number;
  /**
   * Plain-language statement of what this is.
   *
   * `04` Phase 4.4 requires refill estimates to be labelled as estimates, and forbids presenting
   * them as pharmacy inventory truth.
   */
  readonly assumptionsNote: string;
}

/**
 * Estimate when a supply runs out.
 *
 * Deliberately simple arithmetic over what the user entered. It does **not** consult dose events:
 * `04` Phase 4.1 forbids inferring dose changes from adherence history, and an estimate that
 * silently adjusted itself from missed doses would be doing exactly that.
 */
export function estimateRefill(input: RefillEstimateInput): RefillEstimate {
  if (input.dosesPerDay <= 0) {
    throw new RangeError('dosesPerDay must be greater than zero to estimate depletion.');
  }
  if (input.quantityRemaining < 0) {
    throw new RangeError('quantityRemaining cannot be negative.');
  }

  // Floor, not round: an estimate that runs out a day early is a harmless prompt, while one that
  // runs out a day late could leave someone without a medicine they need.
  const daysRemaining = Math.floor(input.quantityRemaining / input.dosesPerDay);

  return {
    estimatedDepletionOn: addDays(input.asOf, daysRemaining),
    daysRemaining,
    assumptionsNote: `Estimated from ${input.quantityRemaining} remaining at ${input.dosesPerDay} per day. This is an estimate based on what you entered, not a record of what is left in the pack.`,
  };
}
