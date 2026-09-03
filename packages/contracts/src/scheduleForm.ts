/**
 * The schedule form: what a person typed, and what gets sent.
 *
 * Spec references: `04` Phase 4.1, `13` (validation at the boundary; the client sends what it was
 * given), `18` (a refusal names the field and says what to do), `09`.
 *
 * WHY THE FORM IS STRINGS AND THE BODY IS NOT
 * A time control on a phone produces a string, and `08:0` on the way to `08:00` is a state the
 * form has to hold without deciding it is wrong. The body is built once, at save, and the domain
 * decides then - so a person is not told off mid-keystroke, and nothing is repaired behind them.
 *
 * NOTHING HERE REPAIRS A VALUE
 * `8:00` is not read as `08:00` and `24:00` is not read as midnight. A time Kynviora quietly
 * reinterpreted is one a person cannot check against what they meant, and what it decides is when
 * they are told to take a medicine. `normalizeScheduleEntry` refuses and names the field; this
 * turns that into the sentence beside it.
 *
 * THE ONE THING IT DOES DECIDE
 * Which fields are even sent. Choosing "only when I need it" clears the times and the days rather
 * than sending them, because `04` Phase 4.1 separates as-needed from fixed reminders and a body
 * carrying both is a schedule whose meaning depends on which half the reader looks at.
 */

import {
  isErr,
  normalizeScheduleEntry,
  type IsoWeekday,
  type ScheduleKind,
} from '@kynviora/domain';
import type { Schedule, ScheduleBody, ScheduleChangeBody } from './client.js';

export interface ScheduleFormValues {
  readonly scheduleKind: ScheduleKind;
  /** One string per time, exactly as typed. Empty strings are dropped at save, not while typing. */
  readonly timesLocal: readonly string[];
  readonly daysOfWeek: readonly IsoWeekday[];
  readonly timeZone: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

/**
 * A blank form.
 *
 * One empty time rather than none, so the control a person needs is already there - and
 * `FIXED_TIMES` rather than a prompt to choose, because it is what most medicines are and the
 * other two are one tap away.
 *
 * The zone is passed in rather than guessed here. It is the device's, and a package with no I/O
 * has no business asking the platform for it (DEC-002).
 */
export function emptyScheduleForm(timeZone: string): ScheduleFormValues {
  return {
    scheduleKind: 'FIXED_TIMES',
    timesLocal: [''],
    daysOfWeek: [],
    timeZone,
    startsOn: '',
    endsOn: '',
  };
}

/** The form filled from a schedule that already exists, for an edit. */
export function scheduleFormFrom(schedule: Schedule): ScheduleFormValues {
  return {
    scheduleKind: schedule.scheduleKind as ScheduleKind,
    timesLocal: schedule.timesLocal.length === 0 ? [''] : [...schedule.timesLocal],
    daysOfWeek: (schedule.daysOfWeek ?? []) as readonly IsoWeekday[],
    timeZone: schedule.timeZone,
    startsOn: schedule.startsOn ?? '',
    endsOn: schedule.endsOn ?? '',
  };
}

/**
 * What to send.
 *
 * Blank lines are dropped: an empty time control is a control somebody has not filled in yet, not
 * a time they meant. Everything that survives is sent exactly as typed.
 */
export function scheduleBodyFrom(values: ScheduleFormValues): ScheduleBody {
  const asNeeded = values.scheduleKind === 'AS_NEEDED';
  const times = values.timesLocal.map((time) => time.trim()).filter((time) => time !== '');

  return {
    scheduleKind: values.scheduleKind,
    // Cleared rather than sent, so the kind and the data cannot disagree.
    timesLocal: asNeeded ? [] : times,
    // Sent whenever the kind is selected-days, **including when it is empty**. Falling back to
    // `null` there would send "every day" - so somebody who chose "on certain days" and picked
    // none would be reminded seven days a week, silently, because Kynviora answered a question
    // they had not answered. The domain refuses an empty selection and names the field.
    daysOfWeek:
      values.scheduleKind === 'SELECTED_DAYS' ? [...values.daysOfWeek].sort((a, b) => a - b) : null,
    timeZone: values.timeZone,
    startsOn: values.startsOn.trim() === '' ? null : values.startsOn.trim(),
    endsOn: values.endsOn.trim() === '' ? null : values.endsOn.trim(),
  };
}

export function scheduleChangeBodyFrom(
  values: ScheduleFormValues,
  expectedVersion: number,
  active?: boolean,
): ScheduleChangeBody {
  return {
    ...scheduleBodyFrom(values),
    expectedVersion,
    ...(active === undefined ? {} : { active }),
  };
}

export interface ScheduleFormRefusal {
  /** The field to put the sentence beside, or `null` where it belongs to the form as a whole. */
  readonly field: string | null;
  readonly message: string;
}

/**
 * Why this form cannot be saved yet, or `null`.
 *
 * The same function the server runs, over the same values - so the refusal a person reads before
 * they press Save is the refusal they would have got afterwards, in the same words and about the
 * same field. Running a second, looser copy here is how a client comes to accept something the
 * server then rejects with a sentence nobody wrote.
 */
export function scheduleFormRefusal(values: ScheduleFormValues): ScheduleFormRefusal | null {
  const outcome = normalizeScheduleEntry(scheduleBodyFrom(values));
  if (!isErr(outcome)) return null;
  const field = outcome.error.detail?.['field'];
  return {
    field: typeof field === 'string' ? field : null,
    message: outcome.error.reason,
  };
}

/** Whether Save should be offered at all. */
export function scheduleFormComplete(values: ScheduleFormValues): boolean {
  return scheduleFormRefusal(values) === null;
}

/** Add a blank time line. */
export function withTimeAdded(values: ScheduleFormValues): ScheduleFormValues {
  return { ...values, timesLocal: [...values.timesLocal, ''] };
}

/** Remove one time line, keeping at least one control on the screen to type into. */
export function withTimeRemoved(values: ScheduleFormValues, index: number): ScheduleFormValues {
  const remaining = values.timesLocal.filter((_, i) => i !== index);
  return { ...values, timesLocal: remaining.length === 0 ? [''] : remaining };
}

export function withTimeChanged(
  values: ScheduleFormValues,
  index: number,
  time: string,
): ScheduleFormValues {
  return {
    ...values,
    timesLocal: values.timesLocal.map((existing, i) => (i === index ? time : existing)),
  };
}

/** Toggle a weekday. */
export function withDayToggled(values: ScheduleFormValues, day: IsoWeekday): ScheduleFormValues {
  const has = values.daysOfWeek.includes(day);
  return {
    ...values,
    daysOfWeek: has
      ? values.daysOfWeek.filter((existing) => existing !== day)
      : [...values.daysOfWeek, day].sort((a, b) => a - b),
  };
}

/**
 * Change the kind.
 *
 * The times and the days are kept in the form rather than cleared, so somebody who taps
 * "only when I need it" to read what it means and taps back has not lost what they typed. What is
 * *sent* is decided by {@link scheduleBodyFrom}, which is the only place it matters.
 */
export function withKindChanged(
  values: ScheduleFormValues,
  scheduleKind: ScheduleKind,
): ScheduleFormValues {
  return { ...values, scheduleKind };
}
