/**
 * Notification policy, in words.
 *
 * Spec references: `04` Phase 7.5 (urgency-based delivery policy; digest policy for lower urgency;
 * quiet hours; current-state revalidation when opened - with the exit criteria "a new foreign
 * restriction does not automatically produce a red/high-severity personal alert" and
 * "stale/corrected notifications cannot remain actionable without revalidation"), `09`, `02` (no
 * alarm optimisation), `18` (familiar words first, one idea per sentence), `16`.
 *
 * THE SETTINGS SAY WHAT THEY DO NOT DO
 * Every sentence here about a policy control says what setting it cannot achieve, because both of
 * these dials look like they do more than they do. Quiet hours do not silence a critical recall,
 * and the device-urgency floor cannot make a foreign regulatory difference reach a phone. A
 * person who believed either of the opposites would be relying on Kynviora for something it will
 * not do.
 *
 * A STALE NOTIFICATION IS EXPLAINED, NOT JUST DISARMED
 * `04`'s second exit criterion is about the actions, and disarming them silently would leave
 * somebody looking at a screen whose controls had vanished. Each outcome below says what changed
 * and what to do instead, and none of them says what to do about the medicine (`09`).
 */

import type { ActionUrgency } from '@kynviora/domain';
import { MAX_CHANNEL_FOR_URGENCY, type DeliveryChannel } from '@kynviora/domain';

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface ChannelPresentation {
  readonly label: string;
  readonly description: string;
}

/** One sentence per channel. A total record, so a new channel is copy somebody writes. */
export const CHANNEL_PRESENTATION: Readonly<Record<DeliveryChannel, ChannelPresentation>> =
  Object.freeze({
    INTERRUPT: {
      label: 'Sent to your device straight away',
      description:
        'A notification arrives when this happens. What it says on a locked screen depends on your own detail setting, which starts at the most private one.',
    },
    DIGEST: {
      label: 'Collected for a summary',
      description:
        'No notification when this happens. It is gathered with anything else at the same level and shown together.',
    },
    IN_APP_ONLY: {
      label: 'Kept in the app only',
      description:
        'Nothing reaches your device at all. It is recorded and waiting for you the next time you open Kynviora.',
    },
  });

export function presentChannel(channel: DeliveryChannel): ChannelPresentation {
  return CHANNEL_PRESENTATION[channel];
}

export interface UrgencyChannelLine {
  readonly urgency: ActionUrgency;
  readonly channelLabel: string;
  readonly channelDescription: string;
}

/**
 * What each urgency does, for a settings screen that explains itself.
 *
 * Read from the domain's ceiling rather than restated, so a screen cannot describe a policy the
 * server does not have. `16` asks for capabilities a person can read; a delivery policy nobody
 * can see the effect of has the same problem.
 */
export function urgencyChannelLines(
  urgencies: readonly ActionUrgency[],
): readonly UrgencyChannelLine[] {
  return urgencies.map((urgency) => {
    const channel = presentChannel(MAX_CHANNEL_FOR_URGENCY[urgency]);
    return {
      urgency,
      channelLabel: channel.label,
      channelDescription: channel.description,
    };
  });
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

export const QUIET_HOURS_COPY = Object.freeze({
  heading: 'Quiet hours',
  help:
    'Choose a window when Kynviora will not send notifications to your device. Anything it would ' +
    'have sent waits until the window ends and arrives then.',
  /** The one thing a person must know before relying on it. */
  exception:
    'One exception: a critical safety alert is still sent during quiet hours. If Kynviora has ' +
    'something that urgent about a medicine in this household, it will not wait until morning.',
  notSet: 'No quiet hours are set, so notifications can arrive at any time.',
  unknownLocalTime:
    'Kynviora does not know what time it is where you are, so quiet hours are not being applied ' +
    'yet. Nothing is being held back.',

  // ---------------------------------------------------------------------
  // Setting one
  // ---------------------------------------------------------------------
  // A 24-hour clock, typed. Not a locale-aware picker and not an am/pm control: `07:00` is never
  // seven in the evening, and the thing being decided is whether a phone lights up at three in
  // the morning. Refused rather than repaired, which is why each field says its format.

  startLabel: 'From',
  endLabel: 'Until',
  fieldHelp: 'A 24-hour time, like 22:00.',
  saveLabel: 'Save quiet hours',
  clearLabel: 'Turn quiet hours off',
  /**
   * What was recorded, never what will follow from it.
   *
   * "Kynviora will hold notifications during that window" is a promise this build does not keep -
   * `QUIET_HOURS_APPLIED` is `false` (`DEV-030`, `BLK-009`) - and it would be made at the exact
   * moment somebody has just decided to rely on it. The window is stored; whether anything is
   * held is a separate sentence, and {@link QUIET_HOURS_COPY.unknownLocalTime} is the one that
   * says it.
   */
  savedNote: 'Saved. Kynviora has recorded these hours.',
  clearedNote: 'Quiet hours are off. Notifications can arrive at any time.',
  /**
   * Said where a window is stored that this build cannot render as two editable times.
   *
   * The controls are absent rather than prefilled with nothing, because saving an empty form
   * would clear a window somebody set using a value Kynviora could not read. Both halves matter:
   * why there is no editor, and that nothing has been changed by saying so.
   */
  unreadableWindow:
    'Kynviora cannot show these hours in a form it can edit, so they cannot be changed here. Nothing has been altered.',
  /**
   * Said to a caregiver, who can read the window and not change it.
   *
   * Read rather than hidden, for `16`'s reason: somebody receiving nothing at 3am deserves to
   * know a window is doing that rather than a bug. The control is absent, not disabled.
   */
  ownerOnly:
    'The person whose profile this is sets these hours. You can see them because they decide when your device stays quiet.',
  /** `14` puts a change to what leaves the profile behind re-authentication. */
  stepUpPrompt: 'Confirm it is you before changing when notifications can arrive.',
});

/** Every sentence this module can put on a settings screen, for the copy scans. */
export const ALL_QUIET_HOURS_STRINGS: readonly string[] = Object.freeze(
  Object.values(QUIET_HOURS_COPY),
);

/**
 * The heading and the sentence above the urgency table.
 *
 * The table is a statement about what Kynviora does rather than a control: none of it is
 * settable, and saying so stops somebody hunting for the switch. `02` is why there is no switch -
 * a person who could raise every urgency to an interrupt would have built the alarm optimisation
 * the product refuses, one row at a time.
 */
export const URGENCY_CHANNEL_COPY = Object.freeze({
  heading: 'What reaches your device',
  intro:
    'Kynviora decides this by how urgent something is, and it is the same for everybody. It is here so you can see it rather than to be changed.',
  foreignNote:
    'A restriction from a regulator somewhere you do not get care is kept in the app. It is recorded and it is not a personal alert.',
});

/** A window as a person reads it. Minutes from local midnight, rendered as a local clock time. */
export function quietHoursLabel(startMinute: number, endMinute: number): string {
  return `${clock(startMinute)} to ${clock(endMinute)}`;
}

function clock(minute: number): string {
  const normalised = ((minute % 1440) + 1440) % 1440;
  const hours = Math.floor(normalised / 60);
  const minutes = normalised % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Revalidation
// ---------------------------------------------------------------------------

export interface RevalidationPresentation {
  readonly heading: string;
  readonly body: string;
}

/**
 * What a re-read found, said to the person who opened the notification.
 *
 * A total record over the domain's outcomes. `STILL_CURRENT` has no entry: a screen that
 * announced "this is still current" on every ordinary open would train people to skip the notice
 * on the one occasion it says something else.
 */
export const REVALIDATION_PRESENTATION: Readonly<Record<string, RevalidationPresentation>> =
  Object.freeze({
    WITHDRAWN: {
      heading: 'This alert has been withdrawn since you were told about it',
      body:
        'Kynviora is no longer making this claim about your product. It is kept here so you can ' +
        'see what you were told and when. There is nothing to act on, and nothing to report.',
    },
    SUPERSEDED: {
      heading: 'A newer assessment has replaced this one',
      body:
        'What you were notified about is no longer the current reading. Open the item on your ' +
        'shelf to see what Kynviora says about it now.',
    },
    CORRECTED_SINCE_NOTIFICATION: {
      heading: 'Kynviora corrected something after it notified you',
      body:
        'The notification you opened was based on what Kynviora knew at the time, and it has ' +
        'since recorded a correction. Read the correction on the receipt for this alert before ' +
        'relying on what you were told.',
    },
    NO_LONGER_VISIBLE: {
      heading: 'This alert is not available to you now',
      body:
        'Your access to this profile has changed since the notification was sent. If you think ' +
        'that is wrong, ask the person who owns the profile.',
    },
  });

/**
 * The notice for an outcome, or `null`.
 *
 * `null` for `STILL_CURRENT` and for an outcome this build does not recognise. The second is the
 * interesting one: an unknown outcome produces no notice **and** the caller has already withdrawn
 * the actions, because the domain decides actionability and this only describes it. A build that
 * invented a sentence here could describe the wrong change.
 */
export function revalidationNotice(outcome: string): RevalidationPresentation | null {
  return REVALIDATION_PRESENTATION[outcome] ?? null;
}
