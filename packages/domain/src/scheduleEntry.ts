/**
 * When a medicine is meant to be taken, as somebody entered it.
 *
 * Spec references: `04` Phase 4.1 (fixed-time and selected-day patterns; start and end dates;
 * as-needed separated from fixed reminders; time-zone handling rules; "Kynviora does not infer
 * dose changes from adherence history"), `04` Phase 4.2, `09` (Kynviora does not reinterpret a
 * prescription instruction), `13` (validation at the boundary), DEC-010.
 *
 * WHY THIS VOCABULARY IS IN `domain` AND THE COMPUTATION IS NOT
 * `packages/safety` is server-side only (DEC-010): the client never evaluates a rule and must not
 * be able to. But a person setting a schedule needs the same words the server stores - the kinds,
 * the weekdays, what a local time looks like - so those live here, where both sides may read them.
 * Turning a schedule into instants stays in `@kynviora/safety/schedule.ts`, which is the half a
 * phone has no business doing.
 *
 * THERE IS NO DOSE FIELD, AND THERE MUST NOT BE ONE
 * A schedule says *when*, never *how much*. `09` forbids Kynviora reinterpreting a prescription
 * instruction, and `04` Phase 4.1 requires written directions to be preserved as entered - they
 * live on the item as `directions_text`, in the prescriber's words. A quantity here would be
 * Kynviora restating a clinician's instruction in its own structured form, which is the same
 * mistake as parsing it. A test asserts the submission has no such field.
 *
 * TIMES ARE LOCAL WALL-CLOCK PLUS A ZONE, NEVER AN INSTANT
 * `04` Phase 4.1's time-zone handling rule. "08:00" survives a daylight-saving transition and a
 * flight; an instant computed once does not, and would move a dose by an hour twice a year without
 * anybody touching it.
 */

import { isKnownTimeZone } from './timeZone.js';
import { domainError, err, ok, type DomainError, type Result } from './result.js';

/**
 * How a schedule repeats.
 *
 * `AS_NEEDED` is a member rather than a flag because `04` Phase 4.1 requires it to be separated
 * from fixed reminders: something taken when needed has no time for a reminder to fire at, and
 * modelling it as "fixed times, empty" is how it acquires one.
 */
export const SCHEDULE_KINDS = ['FIXED_TIMES', 'SELECTED_DAYS', 'AS_NEEDED'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export function isScheduleKind(value: string): value is ScheduleKind {
  return (SCHEDULE_KINDS as readonly string[]).includes(value);
}

/** ISO-8601 weekday: 1 = Monday through 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const ISO_WEEKDAYS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * How many times a day a schedule may carry.
 *
 * Bounded because `14` bounds every field length, and generous because six-times-daily regimens
 * exist. Beyond that a person is describing something this model does not represent, and refusing
 * says so rather than storing a list nobody can read on a screen.
 */
export const MAX_TIMES_PER_DAY = 12;

/** 24-hour `HH:MM`. The same shape migration `0004` enforces in a CHECK constraint. */
const LOCAL_TIME_SHAPE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** A calendar date. Not an instant: a course of treatment starts on a day, not at a moment. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalTime(value: string): boolean {
  return LOCAL_TIME_SHAPE.test(value);
}

/**
 * Split `HH:MM`.
 *
 * Throws rather than returning a result, because every caller has already been through
 * {@link normalizeScheduleEntry} or read a row the database's own CHECK constraint admitted. A
 * malformed value here is a broken invariant, not user input.
 */
export function parseLocalTime(value: string): { hours: number; minutes: number } {
  if (!isLocalTime(value)) {
    throw new TypeError(`Not a 24-hour HH:MM local time: ${JSON.stringify(value)}`);
  }
  const [hours, minutes] = value.split(':');
  return { hours: Number(hours), minutes: Number(minutes) };
}

/**
 * Whether a string names a time zone this runtime knows.
 *
 * Re-exported from `timeZone.ts` rather than defined here, and the consolidation fixed a real
 * defect rather than tidying two copies. This module's own version asked only whether ICU accepted
 * the string - and **ICU accepts `+05:30`**. A schedule stored with an offset instead of a zone
 * fires at the right minute today and an hour out after the next daylight-saving transition, which
 * for a medicine reminder means somebody being told to take a tablet an hour early twice a year.
 *
 * `04` Phase 4.1's whole reason for storing `times_local` plus a zone is to avoid exactly that, so
 * a validator that admitted an offset undid the decision it was there to enforce.
 */
export { isKnownTimeZone };

// ---------------------------------------------------------------------------
// What somebody submitted
// ---------------------------------------------------------------------------

export interface ScheduleEntry {
  readonly scheduleKind: string;
  /** Local wall-clock `HH:MM`, 24-hour. Empty or absent for `AS_NEEDED`. */
  readonly timesLocal?: readonly string[] | undefined;
  /** ISO weekdays for `SELECTED_DAYS`. Absent means every day. */
  readonly daysOfWeek?: readonly number[] | null | undefined;
  /** IANA zone. Required: a schedule without one cannot be turned into a time. */
  readonly timeZone: string;
  readonly startsOn?: string | null | undefined;
  readonly endsOn?: string | null | undefined;
}

/** The same, with every absence explicit and every list in one canonical order. */
export interface NormalizedScheduleEntry {
  readonly scheduleKind: ScheduleKind;
  readonly timesLocal: readonly string[];
  readonly daysOfWeek: readonly IsoWeekday[] | null;
  readonly timeZone: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
}

function invalid(reason: string, field: string): DomainError {
  return domainError('VALIDATION_FAILED', reason, { reason_code: 'schedule_entry', field });
}

function date(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Check and canonicalise a submitted schedule.
 *
 * Refuses rather than repairing, in every case where repairing would change what a person meant.
 * The one thing it does silently is put the times and the days in order and drop exact duplicates:
 * "08:00, 20:00" and "20:00, 08:00" are the same schedule, and two 08:00 entries are the same dose
 * written twice, not two doses - and a reminder engine reading the second interpretation would
 * tell somebody to take the same tablet twice at the same minute.
 */
export function normalizeScheduleEntry(
  entry: ScheduleEntry,
): Result<NormalizedScheduleEntry, DomainError> {
  const kind = entry.scheduleKind.trim();
  if (!isScheduleKind(kind)) {
    return err(
      invalid(`Not a schedule kind: ${JSON.stringify(entry.scheduleKind)}.`, 'scheduleKind'),
    );
  }

  const timeZone = entry.timeZone.trim();
  if (timeZone === '') return err(invalid('A time zone is required.', 'timeZone'));
  if (!isKnownTimeZone(timeZone)) {
    return err(
      invalid(`Not a time zone this system knows: ${JSON.stringify(timeZone)}.`, 'timeZone'),
    );
  }

  // Times ------------------------------------------------------------------
  const submittedTimes = entry.timesLocal ?? [];
  for (const time of submittedTimes) {
    if (!isLocalTime(time)) {
      return err(invalid(`Not a 24-hour HH:MM time: ${JSON.stringify(time)}.`, 'timesLocal'));
    }
  }
  // Sorted as strings, which for zero-padded `HH:MM` is chronological order.
  const timesLocal = [...new Set(submittedTimes)].sort();

  if (kind === 'AS_NEEDED' && timesLocal.length > 0) {
    // `04` Phase 4.1 separates as-needed from fixed reminders. A time on an as-needed medicine is
    // a reminder somebody did not ask for, about something they are meant to take only when they
    // need it - which is the precise shape of the nagging `18` forbids.
    return err(invalid('An as-needed medicine has no scheduled times.', 'timesLocal'));
  }
  if (kind !== 'AS_NEEDED' && timesLocal.length === 0) {
    return err(invalid('A scheduled medicine needs at least one time.', 'timesLocal'));
  }
  if (timesLocal.length > MAX_TIMES_PER_DAY) {
    return err(
      invalid(
        `A schedule may carry at most ${String(MAX_TIMES_PER_DAY)} times a day.`,
        'timesLocal',
      ),
    );
  }

  // Days -------------------------------------------------------------------
  const submittedDays = entry.daysOfWeek ?? null;
  let daysOfWeek: readonly IsoWeekday[] | null = null;

  if (submittedDays !== null) {
    if (kind !== 'SELECTED_DAYS') {
      // The kind and the data would otherwise disagree, and the row would be read by whichever of
      // them the reader happened to look at.
      return err(invalid('Only a selected-days schedule carries weekdays.', 'daysOfWeek'));
    }
    for (const day of submittedDays) {
      if (!ISO_WEEKDAYS.includes(day as IsoWeekday)) {
        return err(invalid(`Not an ISO weekday (1-7): ${String(day)}.`, 'daysOfWeek'));
      }
    }
    const unique = [...new Set(submittedDays)].sort((a, b) => a - b) as IsoWeekday[];
    if (unique.length === 0) {
      // Not the same as "every day": an empty selection is a schedule that never fires, which is
      // a medicine somebody believes they are being reminded about and is not.
      return err(
        invalid('Select at least one day, or leave it unset for every day.', 'daysOfWeek'),
      );
    }
    daysOfWeek = unique;
  }

  // Dates ------------------------------------------------------------------
  const startsOn = date(entry.startsOn);
  const endsOn = date(entry.endsOn);
  for (const [value, field] of [
    [startsOn, 'startsOn'],
    [endsOn, 'endsOn'],
  ] as const) {
    if (value !== null && !DATE_SHAPE.test(value)) {
      return err(invalid(`Not a calendar date (YYYY-MM-DD): ${JSON.stringify(value)}.`, field));
    }
  }
  if (startsOn !== null && endsOn !== null && endsOn < startsOn) {
    return err(invalid('The end date is before the start date.', 'endsOn'));
  }

  return ok({ scheduleKind: kind, timesLocal, daysOfWeek, timeZone, startsOn, endsOn });
}
