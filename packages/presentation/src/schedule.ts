/**
 * Setting when a medicine is taken, and what a reminder will say, in words.
 *
 * Spec references: `04` Phase 4.1 (fixed-time and selected-day patterns, start and end dates,
 * as-needed separated from fixed reminders, written directions preserved as entered), `04` Phase
 * 4.2 (the reminder engine and its lock-screen default), `18` (familiar words first, one idea per
 * sentence, a label is always present, no shame), `09` (Kynviora does not reinterpret a
 * prescription instruction), `15` A6, `16`.
 *
 * THE SCREEN SAYS WHEN AND NEVER HOW MUCH
 * There is no field here for a dose and no wording that could carry one. The directions a
 * prescriber wrote are shown on this screen as they were entered, quoted and attributed - because
 * `04` Phase 4.1 requires them preserved as source text and `09` forbids Kynviora restating them.
 * A person reading "One tablet twice a day" and setting two times is doing the interpreting, which
 * is the only place it may happen.
 *
 * A PERSON SETTING A REMINDER IS ENTITLED TO KNOW WHAT IT WILL SAY
 * Phase 4.2 puts nothing identifying on a lock screen by default, and that promise is worth
 * nothing if it is only kept in code. {@link REMINDER_DISCLOSURE_COPY} is the sentence that says
 * it, on the screen where somebody decides whether to rely on this at all - and it is worded per
 * level so raising the level cannot leave the reassurance behind.
 *
 * AND WHAT IT WILL NOT DO
 * A reminder is not a promise that the phone will be heard, and it is not a second alarm clock a
 * person can stop setting. `18` refuses the confident wording; {@link SCHEDULE_COPY.reliability}
 * is the honest one.
 */

import type { IsoWeekday, NotificationDetailLevel, ScheduleKind } from '@kynviora/domain';
import { ISO_WEEKDAYS, NOTIFICATION_DETAIL_LEVELS, SCHEDULE_KINDS } from '@kynviora/domain';

export interface ScheduleKindPresentation {
  readonly kind: ScheduleKind;
  readonly label: string;
  /** What choosing it means for whether a reminder arrives. */
  readonly description: string;
}

/**
 * One entry per kind. A total record, so a kind added later is copy somebody writes.
 *
 * Trap 109: a vocabulary that grew a member with no wording shipped a blank line where a sentence
 * belonged. A test loops {@link SCHEDULE_KINDS} against this.
 */
export const SCHEDULE_KIND_PRESENTATION: Readonly<Record<ScheduleKind, ScheduleKindPresentation>> =
  Object.freeze({
    FIXED_TIMES: {
      kind: 'FIXED_TIMES',
      label: 'At set times every day',
      description: 'Kynviora will remind you at each time you add, every day.',
    },
    SELECTED_DAYS: {
      kind: 'SELECTED_DAYS',
      label: 'On certain days',
      description: 'Kynviora will remind you at those times, but only on the days you choose.',
    },
    AS_NEEDED: {
      kind: 'AS_NEEDED',
      // Not "no reminders", which sounds like something is switched off. It is a different kind of
      // medicine, not a reminder somebody failed to set.
      label: 'Only when I need it',
      description:
        'No reminders. Kynviora will not tell you to take this, because when to take it is your decision at the time.',
    },
  });

export function presentScheduleKind(kind: ScheduleKind): ScheduleKindPresentation {
  return SCHEDULE_KIND_PRESENTATION[kind];
}

export function scheduleKindOptions(): readonly ScheduleKindPresentation[] {
  return SCHEDULE_KINDS.map((kind) => SCHEDULE_KIND_PRESENTATION[kind]);
}

export interface WeekdayPresentation {
  readonly day: IsoWeekday;
  /** The control's label. */
  readonly label: string;
  /** Spoken by a screen reader, because "Mon" is read aloud as a word rather than a day. */
  readonly accessibilityLabel: string;
}

/** ISO order, Monday first. The number is what the column stores; the label is what a person reads. */
export const WEEKDAY_PRESENTATION: Readonly<Record<IsoWeekday, WeekdayPresentation>> =
  Object.freeze({
    1: { day: 1, label: 'Mon', accessibilityLabel: 'Monday' },
    2: { day: 2, label: 'Tue', accessibilityLabel: 'Tuesday' },
    3: { day: 3, label: 'Wed', accessibilityLabel: 'Wednesday' },
    4: { day: 4, label: 'Thu', accessibilityLabel: 'Thursday' },
    5: { day: 5, label: 'Fri', accessibilityLabel: 'Friday' },
    6: { day: 6, label: 'Sat', accessibilityLabel: 'Saturday' },
    7: { day: 7, label: 'Sun', accessibilityLabel: 'Sunday' },
  });

export function weekdayOptions(): readonly WeekdayPresentation[] {
  return ISO_WEEKDAYS.map((day) => WEEKDAY_PRESENTATION[day]);
}

/**
 * What a reminder will actually put on a locked screen, at each level.
 *
 * Written from the person's side rather than the system's: not "detail level GENERIC" but what
 * somebody standing next to them would be able to read. A total record over the vocabulary, so a
 * level added later cannot appear on this screen without somebody deciding what to promise about
 * it.
 */
export const REMINDER_DISCLOSURE_COPY: Readonly<Record<NotificationDetailLevel, string>> =
  Object.freeze({
    GENERIC:
      'Reminders will say only that Kynviora has a reminder for you. Nobody who sees your locked screen will learn which medicine it is, or that it is a medicine at all.',
    CATEGORY:
      'Reminders will say a scheduled dose is due. Somebody who sees your locked screen will know you take a medicine, but not which one.',
    NAMED:
      'Reminders will name the medicine and the person. Somebody who sees your locked screen will be able to read both.',
  });

export const SCHEDULE_COPY = Object.freeze({
  heading: 'When do you take this?',
  intro:
    'Kynviora will remind you at the times you set. It does not decide the times, and it does not change them.',

  /**
   * The directions, quoted.
   *
   * `04` Phase 4.1 keeps source text as entered and `09` forbids Kynviora restating it, so this
   * label attributes the words rather than presenting them as Kynviora's own reading of them.
   */
  directionsLabel: 'What the label or prescription says',
  directionsHelp:
    'Shown exactly as it was written down. Kynviora does not work the times out from it - that part is yours.',
  directionsMissing: 'No directions were recorded for this medicine.',

  patternLabel: 'How often',

  timesLabel: 'Times',
  timesHelp: 'Use a 24-hour clock, like 08:00 or 20:30. Add one line for each time of day.',
  addTimeLabel: 'Add a time',
  removeTimeLabel: 'Remove this time',

  daysLabel: 'Which days',
  daysHelp: 'Choose at least one. Leaving them all off would mean no reminder ever arrives.',

  timeZoneLabel: 'Time zone',
  timeZoneHelp:
    'The times stay where you put them. If you travel, 08:00 still means 08:00 where you set it, until you change it here.',

  startsOnLabel: 'First day (optional)',
  startsOnHelp: 'Leave it empty if you are already taking it.',
  endsOnLabel: 'Last day (optional)',
  endsOnHelp: 'For a course that ends. Leave it empty if you take it ongoing.',

  saveLabel: 'Save schedule',
  updateLabel: 'Save changes',
  stopLabel: 'Stop reminders',
  /**
   * What stopping does, before it is pressed.
   *
   * It does not delete anything, and saying so matters: a dose recorded against this schedule
   * stays readable, and somebody who expected the record to go with it should find out here.
   */
  stopHelp:
    'Reminders stop. What you have already recorded about this medicine stays, and you can start the reminders again.',
  stoppedLabel: 'Reminders are off for this schedule.',

  /**
   * The honest sentence about reliability.
   *
   * `18` refuses the confident version. A phone can be silent, off, or out of battery, and a
   * person who stopped setting their own alarm because an app promised to remind them is worse off
   * than before they installed it.
   */
  reliability:
    'Reminders come from this phone, so they arrive even without a connection. They cannot arrive if the phone is off or silent, so keep any alarm you already rely on.',

  /** Shown when the person has not allowed notifications. Never phrased as their mistake. */
  notPermitted:
    'This phone is not allowing Kynviora to show reminders, so none will arrive. You can turn notifications on in your phone’s settings.',

  /** Shown when the app could not work out what to schedule. Never presented as working. */
  unavailable:
    'Kynviora could not set up reminders for this medicine. What you have saved is kept, and it will try again next time you open the app.',

  asNeededNote:
    'Nothing is scheduled for a medicine you take only when you need it, so no reminder will arrive for it.',
});

/**
 * One line describing a stored schedule, for a list.
 *
 * A sentence rather than a row of fields, because "08:00, 20:00 · Mon Wed Fri" is a format
 * somebody has to learn and this screen is read once every few months.
 */
export function describeSchedule(input: {
  readonly kind: ScheduleKind;
  readonly timesLocal: readonly string[];
  readonly daysOfWeek: readonly IsoWeekday[] | null;
  readonly active: boolean;
}): string {
  if (input.kind === 'AS_NEEDED') return SCHEDULE_KIND_PRESENTATION.AS_NEEDED.description;

  const times = input.timesLocal.join(', ');
  const when =
    input.daysOfWeek === null || input.kind !== 'SELECTED_DAYS'
      ? 'every day'
      : `on ${input.daysOfWeek.map((day) => WEEKDAY_PRESENTATION[day].accessibilityLabel).join(', ')}`;

  const sentence = `${times} ${when}.`;
  // The stopped state is said first, not appended. Somebody scanning a list must not read the
  // times and stop there, on a schedule that is firing nothing.
  return input.active ? sentence : `${SCHEDULE_COPY.stoppedLabel} ${sentence}`;
}

/** Every level's promise, in the vocabulary's order, for a screen that shows the current one. */
export function reminderDisclosureOptions(): readonly {
  readonly level: NotificationDetailLevel;
  readonly promise: string;
}[] {
  return NOTIFICATION_DETAIL_LEVELS.map((level) => ({
    level,
    promise: REMINDER_DISCLOSURE_COPY[level],
  }));
}
