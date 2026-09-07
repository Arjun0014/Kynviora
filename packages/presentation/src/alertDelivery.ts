/**
 * Presentation for caregiver alert delivery: notification settings, and the caregiver alert view.
 *
 * Spec references: `04` Phase 8.2, `03` group H (generic notification content by default), `16`
 * (caregiver notifications reveal minimal information; grant capabilities are human-readable),
 * `15` A6 (a notification leaking health information to a lock screen), `18` (plain language, no
 * shaming, limitations stated).
 *
 * The hard part of this surface is not the words, it is that a privacy setting has to be
 * *believable*. Someone choosing how much their relative's phone shows on a locked screen is
 * making a judgement about a person they know, in a situation the product cannot see. So each
 * level is described by what it would actually show - {@link NOTIFICATION_LEVEL_DESCRIPTIONS}
 * carries a concrete example, not an adjective - and the example is the real string the domain
 * renders, so the description cannot drift from the behaviour.
 */

import {
  GENERIC_NOTIFICATION_BODY,
  NOTIFICATION_DETAIL_LEVELS,
  notificationFor,
  ownEntry,
  type NotificationDetailLevel,
  type Recipient,
  type UserId,
} from '@kynviora/domain';

// ---------------------------------------------------------------------------
// Detail levels
// ---------------------------------------------------------------------------

export interface NotificationLevelDescription {
  readonly label: string;
  /** What this level does and does not put on a lock screen. */
  readonly meaning: string;
  /** Whether choosing this level can put a person or product name on a locked device. */
  readonly revealsSubject: boolean;
}

export const NOTIFICATION_LEVEL_DESCRIPTIONS: Readonly<
  Record<NotificationDetailLevel, NotificationLevelDescription>
> = Object.freeze({
  GENERIC: {
    label: 'Nothing on the lock screen',
    meaning:
      'Notifications say only that Kynviora has an update. Nobody glancing at the phone learns anything.',
    revealsSubject: false,
  },
  CATEGORY: {
    label: 'The kind of update',
    meaning:
      'Notifications say whether it is a safety update or a dose reminder. No name, no product.',
    revealsSubject: false,
  },
  NAMED: {
    label: 'The person and the product',
    meaning:
      'Notifications can name who it is about and which product. Choose this only if the phone is private.',
    revealsSubject: true,
  },
});

export function describeNotificationLevel(
  level: NotificationDetailLevel,
): NotificationLevelDescription {
  return NOTIFICATION_LEVEL_DESCRIPTIONS[level];
}

/**
 * A concrete preview of what each level would put on a lock screen.
 *
 * Rendered through the same {@link notificationFor} the dispatcher uses, so the preview is the
 * behaviour rather than a description of it. A settings screen that showed hand-written examples
 * would be free to drift, and the thing it would drift about is exactly what `15` A6 is about.
 */
export function previewNotification(
  level: NotificationDetailLevel,
  subject: { readonly profileDisplayName: string; readonly itemDisplayName: string | null },
): string {
  const recipient: Recipient = {
    // The preview is about the text, not about a person; the ID is never rendered.
    userId: 'preview' as unknown as UserId,
    relationship: 'CAREGIVER',
    detailLevel: level,
  };
  return notificationFor(recipient, {
    kind: 'SAFETY_ALERT',
    profileDisplayName: subject.profileDisplayName,
    itemDisplayName: subject.itemDisplayName,
  }).body;
}

// ---------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------

export interface NotificationSettingsView {
  readonly levels: readonly {
    readonly level: NotificationDetailLevel;
    readonly label: string;
    readonly meaning: string;
    readonly selected: boolean;
    /** True when the owner's ceiling means choosing this would have no effect. */
    readonly unavailable: boolean;
  }[];
  readonly effective: NotificationDetailLevel;
  /** Present only when the owner's ceiling is reducing what this person asked for. */
  readonly capNote: string | null;
}

/**
 * `16` requires grant capabilities to be human-readable, and a setting whose effect its holder
 * cannot see is the same problem in a different place. Someone who chose "the person and the
 * product" and receives "Kynviora has an update" is owed an explanation that is not "bug".
 */
export const OWNER_CAP_NOTE =
  'The person you care for has limited how much caregiver notifications can show.';

export function notificationSettingsView(input: {
  readonly relationship: 'OWNER' | 'CAREGIVER';
  readonly maxCaregiverDetail: NotificationDetailLevel;
  readonly myPreference: NotificationDetailLevel | null;
  readonly effective: NotificationDetailLevel;
}): NotificationSettingsView {
  const chosen = input.myPreference ?? 'GENERIC';
  const ceilingIndex = NOTIFICATION_DETAIL_LEVELS.indexOf(input.maxCaregiverDetail);

  return {
    levels: NOTIFICATION_DETAIL_LEVELS.map((level) => {
      const description = NOTIFICATION_LEVEL_DESCRIPTIONS[level];
      return {
        level,
        label: description.label,
        meaning: description.meaning,
        selected: level === chosen,
        // An owner is not capped by their own caregiver ceiling, so nothing is unavailable to
        // them. For a caregiver, a level above the ceiling is shown but marked, rather than
        // hidden: a missing option is indistinguishable from a broken screen.
        unavailable:
          input.relationship === 'CAREGIVER' &&
          NOTIFICATION_DETAIL_LEVELS.indexOf(level) > ceilingIndex,
      };
    }),
    effective: input.effective,
    capNote:
      input.relationship === 'CAREGIVER' && input.effective !== chosen ? OWNER_CAP_NOTE : null,
  };
}

// ---------------------------------------------------------------------------
// Caregiver alert view
// ---------------------------------------------------------------------------

/**
 * How a resolved alert reads to someone who is not the profile owner.
 *
 * A caregiver sees the outcome and when it happened, but not the free-text note. The copy says
 * so explicitly, because a blank where a note was withheld reads as "there is no note" - a
 * different and misleading claim.
 */
export const RESOLUTION_NOTE_WITHHELD =
  'A private note was added. Only the person it is about can read it.';

/** Outcome labels. Neutral by design: `18` forbids copy that judges what someone decided. */
const RESOLUTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  REVIEWED: 'Reviewed',
  NOT_APPLICABLE: 'Marked as not applicable',
  RETURNED_OR_DISPOSED: 'Returned or disposed of',
  QUARANTINED: 'Set aside',
  DISCUSSED_WITH_PROFESSIONAL: 'Discussed with a health professional',
  ITEM_IDENTITY_CORRECTED: 'Product details corrected',
  REPORTED_INCORRECT_MATCH: 'Reported as an incorrect match',
});

export const UNRESOLVED_LABEL = 'Not resolved yet';

/**
 * The label for an outcome, or the neutral "Resolved" where this build has no words for it.
 *
 * An **own** property (DEC-146). `resolution` arrives off a caregiver alert response as an open
 * string, and a plain index answered `Object.prototype` names - so a row whose resolution this
 * build does not recognise rendered a function instead of falling back to the one neutral word
 * `18` allows here.
 */
export function describeResolution(resolution: string | null): string {
  if (resolution === null) return UNRESOLVED_LABEL;
  return ownEntry(RESOLUTION_LABELS, resolution) ?? 'Resolved';
}

export interface CaregiverAlertLine {
  readonly alertId: string;
  readonly itemDisplayName: string | null;
  readonly resolutionLabel: string;
  readonly noteLine: string | null;
  readonly resolved: boolean;
}

export function caregiverAlertLine(input: {
  readonly alertId: string;
  readonly itemDisplayName: string | null;
  readonly resolution: string | null;
  readonly resolutionNote: string | null;
  readonly resolutionNoteWithheld: boolean;
}): CaregiverAlertLine {
  return {
    alertId: input.alertId,
    itemDisplayName: input.itemDisplayName,
    resolutionLabel: describeResolution(input.resolution),
    noteLine: input.resolutionNoteWithheld ? RESOLUTION_NOTE_WITHHELD : input.resolutionNote,
    resolved: input.resolution !== null,
  };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const ALERT_DELIVERY_COPY = Object.freeze({
  settingsIntro:
    'Choose how much your notifications show before you open the app. This does not change what you can see inside Kynviora.',
  ownerPolicyIntro:
    'Choose the most any caregiver notification can show. Each caregiver can still choose to show less.',
  separatePermissions:
    'Safety alerts and dose reminders are separate permissions. Someone can have one without the other.',
  deliveryHistoryIntro: 'Notifications Kynviora has sent about this person.',
  ownDeliveryHistoryIntro: 'Notifications Kynviora has sent to you.',
  noDeliveries: 'No notifications have been sent yet.',
  // 18: the limitation is stated rather than implied. A caregiver reading a quiet inbox should
  // not conclude that nothing has happened.
  limitation:
    'This list shows what Kynviora sent. It is not a record of what was read or acted on.',
});

/** Every fixed string here, for the forbidden-claim test. */
export const ALL_ALERT_DELIVERY_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(ALERT_DELIVERY_COPY),
  ...Object.values(NOTIFICATION_LEVEL_DESCRIPTIONS).flatMap((d) => [d.label, d.meaning]),
  ...Object.values(RESOLUTION_LABELS),
  UNRESOLVED_LABEL,
  RESOLUTION_NOTE_WITHHELD,
  OWNER_CAP_NOTE,
  GENERIC_NOTIFICATION_BODY,
]);
