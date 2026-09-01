/**
 * Recording what happened with a medicine, and reading it back.
 *
 * Spec references: `04` Phase 4.3 ("let users record what happened without gamifying or judging
 * them"; "copy avoids shame and unsafe treatment recommendations"), `02` (gamified adherence
 * scoring is a named anti-feature), `18` (do not shame missed medicines; plain language; one idea
 * per sentence), `09` (never tell a user to take, stop, split or double a medicine), `23` D-005.
 *
 * WHAT IS NOT IN THIS FILE, AND WILL NOT BE
 * A percentage, a streak, a count, a rate, a grade, a colour scale from good to bad, or the word
 * "missed". Phase 4.3's goal is a record, not a report card, and every one of those turns the
 * record into one. The distinction is not decorative: someone who skipped a dose because it made
 * them ill has recorded a decision they made about their own treatment, and an app that scores it
 * has told them the decision was wrong - which is medical advice, given by arithmetic.
 *
 * `SKIPPED` and `UNABLE_TO_TAKE` are two kinds precisely because they are different facts, and
 * collapsing them into "missed" - the word the notification vocabulary uses for a schedule that
 * lapsed with nothing recorded - would lose the difference that matters. A person who could not
 * take a medicine and a person who chose not to have both told Kynviora something.
 *
 * NO SENTENCE HERE SAYS WHAT TO DO NEXT
 * `09` forbids instructing anyone to take, stop, split or double a medicine, and a history screen
 * is a tempting place to slip one in - "you have skipped this three times, ask your pharmacist" is
 * an instruction dressed as concern. The copy states what was recorded and stops.
 */

import { DOSE_EVENT_KINDS, type DoseEventKind } from '@kynviora/domain';
import type { StatusPresentation } from './status.js';

/** One recorded event, as a person reads it. */
export interface DoseEventDescription {
  /** The control's label, in the first person, because the person is recording their own action. */
  readonly actionLabel: string;
  /** How the event reads in a history line. Past tense, neutral, no judgement. */
  readonly recordedLabel: string;
  /** One sentence saying what recording it means. Never what to do about it. */
  readonly meaning: string;
  readonly accessibilityLabel: string;
}

/**
 * Every dose event kind, described once.
 *
 * A total record rather than a lookup with a fallback: a new kind in the vocabulary fails to
 * compile here until someone writes the sentence a person will read - which on this screen is the
 * whole exit criterion, not a finishing touch.
 */
export const DOSE_EVENT_DESCRIPTIONS: Readonly<Record<DoseEventKind, DoseEventDescription>> =
  Object.freeze({
    TAKEN: {
      actionLabel: 'I took it',
      recordedLabel: 'Taken',
      meaning: 'Recorded that this was taken.',
      accessibilityLabel: 'Record that you took this.',
    },
    SKIPPED: {
      actionLabel: 'I skipped it',
      recordedLabel: 'Skipped',
      meaning: 'Recorded that this was skipped.',
      accessibilityLabel: 'Record that you skipped this.',
    },
    SNOOZED: {
      actionLabel: 'Not yet',
      recordedLabel: 'Put off for now',
      meaning: 'Recorded that this was put off for now.',
      accessibilityLabel: 'Record that you have put this off for now.',
    },
    UNABLE_TO_TAKE: {
      actionLabel: 'I could not take it',
      recordedLabel: 'Could not take',
      meaning: 'Recorded that this could not be taken.',
      accessibilityLabel: 'Record that you could not take this.',
    },
  });

export function describeDoseEvent(kind: DoseEventKind): DoseEventDescription {
  return DOSE_EVENT_DESCRIPTIONS[kind];
}

/**
 * How a recorded event appears in the history.
 *
 * Every kind carries the same tone. That is the decision, not an oversight: a red chip on
 * `SKIPPED` next to a green one on `TAKEN` is a scorecard drawn in colour, and `18` forbids
 * meaning through colour alone in the other direction anyway. Four distinct shapes keep the kinds
 * apart with no tone doing any work, which is `18`'s rule read in the direction people forget.
 */
export const DOSE_EVENT_PRESENTATION: Readonly<Record<DoseEventKind, StatusPresentation>> =
  Object.freeze({
    TAKEN: {
      label: 'Taken',
      iconName: 'check-circle',
      tone: 'neutral',
      description: 'Recorded that this was taken.',
      accessibilityLabel: 'Taken.',
    },
    SKIPPED: {
      label: 'Skipped',
      iconName: 'ban',
      tone: 'neutral',
      description: 'Recorded that this was skipped.',
      accessibilityLabel: 'Skipped.',
    },
    SNOOZED: {
      label: 'Put off for now',
      iconName: 'clock',
      tone: 'neutral',
      description: 'Recorded that this was put off for now.',
      accessibilityLabel: 'Put off for now.',
    },
    UNABLE_TO_TAKE: {
      label: 'Could not take',
      iconName: 'info-circle',
      tone: 'neutral',
      description: 'Recorded that this could not be taken.',
      accessibilityLabel: 'Could not take.',
    },
  });

export function presentDoseEvent(kind: DoseEventKind): StatusPresentation {
  return DOSE_EVENT_PRESENTATION[kind];
}

/**
 * Fixed copy for recording and for the history.
 *
 * `18` requires plain language and one idea per sentence. The sentence that earns its place here
 * is `notScored`: a person about to record a skipped dose is entitled to know that nothing is
 * keeping count, and the absence of a score is not something an empty screen can state on its own.
 */
export const DOSE_COPY = Object.freeze({
  recordHeading: 'What happened?',
  recordIntro: 'Record what happened, in your own words if you want to.',
  notScored: 'Kynviora keeps this record for you. Nothing here is scored or counted.',
  noteLabel: 'Anything worth remembering',
  noteHelp: 'Optional. Only you and anyone you have given access can see it.',
  historyHeading: 'What you have recorded',
  historyEmpty: 'Nothing recorded for this medicine yet.',
  recordedDone: 'Recorded.',
  scheduledPrefix: 'For a dose due',
  offlineNote: 'Recorded on this phone. It will reach Kynviora when you are back online.',
});

/**
 * How the recorded time reads on a history line.
 *
 * The date, not a time to the second. A history line is a record of what happened, and precision
 * the person cannot check reads as certainty Kynviora does not have about a moment they may have
 * entered hours later.
 */
export function recordedOn(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/** Every fixed string in this module, for the forbidden-claim test. */
export const ALL_DOSE_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(DOSE_COPY),
  ...Object.values(DOSE_EVENT_DESCRIPTIONS).flatMap((d) => [
    d.actionLabel,
    d.recordedLabel,
    d.meaning,
    d.accessibilityLabel,
  ]),
  ...Object.values(DOSE_EVENT_PRESENTATION).flatMap((p) => [
    p.label,
    p.description,
    p.accessibilityLabel,
  ]),
]);

/** The vocabulary in the order the controls are offered. */
export const DOSE_EVENT_ORDER: readonly DoseEventKind[] = DOSE_EVENT_KINDS;
