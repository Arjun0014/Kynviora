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
