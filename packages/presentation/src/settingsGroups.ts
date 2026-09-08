/**
 * You, as eight groups rather than as a page of controls.
 *
 * Spec references: `06` (You is a primary destination and its own hierarchy - account, privacy,
 * consent, accessibility, notifications, exports/deletion), `16` (the export and the deletion
 * control must exist and be findable), `18` (one idea per row; familiar words first; a control
 * says what it does), `14` (re-authentication before the irreversible things), DEC-143, DEC-158.
 *
 * WHAT V3 CHANGED
 * DEC-143 sectioned this screen by subject, which fixed the flat stack it had been. V3 goes a step
 * further and says why: *the You home should be a beautifully grouped settings hub, not a long list
 * of raw controls* - no switches on the first surface, and nothing that needs a decision. What a
 * person meets is a profile header and eight rows, each naming a subject and saying in one line
 * what is inside it.
 *
 * The single most consequential move is `Close this account`. It sat last on the home screen,
 * beneath sign-out, where DEC-143 put it deliberately - the irreversible thing after the reversible
 * one. V3 asks for it to be *inside* Account Center: "deep enough that it is intentional but still
 * discoverable". That is a better answer to the same question, and the reason is not depth for its
 * own sake: on the home screen it is a destructive control a person scrolls past while looking for
 * something else, and one surface in it is a destructive control somebody went to find.
 *
 * WHY THE GROUPS ARE DATA AND NOT EIGHT COMPONENTS
 * Because the home screen is a list, the order is part of the design, and the one-line description
 * is user-visible copy - which trap 39 says is the thing nothing checks when it is written inline.
 * As a closed set with a test over it, a group cannot be added without a name, a sentence and a
 * shape, and the order cannot drift.
 */

import { ownEntry } from '@kynviora/domain';
import type { IconName } from './status.js';

/**
 * The eight, in the order the home screen lists them.
 *
 * The order is deliberate and not alphabetical. `ACCOUNT` first because "which account am I in"
 * is the question that makes every other row mean something; `APPEARANCE` and `ACCESSIBILITY`
 * above `CONNECTIONS` and `AGENT` because they are the ones a person on a phone that cannot reach
 * the server can still use; `HELP` last because it is where somebody goes when the rest did not
 * work.
 */
export const SETTINGS_GROUPS = [
  'ACCOUNT',
  'PRIVACY',
  'NOTIFICATIONS',
  'ACCESSIBILITY',
  'APPEARANCE',
  'CONNECTIONS',
  'AGENT',
  'HELP',
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export function isSettingsGroup(value: unknown): value is SettingsGroup {
  return typeof value === 'string' && (SETTINGS_GROUPS as readonly string[]).includes(value);
}

export interface SettingsGroupPresentation {
  readonly group: SettingsGroup;
  /** The row's name. A subject, not a verb. */
  readonly title: string;
  /**
   * One line saying what is inside.
   *
   * Names the *contents*, not the category again. "Signing in, this device, and closing your
   * account" tells somebody whether to open it; "Manage your account" does not.
   */
  readonly summary: string;
  readonly iconName: IconName;
  /**
   * Whether this group contains something irreversible.
   *
   * Shown as a word on the row rather than as a colour, and used by nothing else: the group is
   * not tinted, not moved and not made harder to reach. `18` forbids meaning by colour alone, and
   * `02` forbids alarm - a row painted red because deletion is somewhere inside it would be both.
   */
  readonly containsIrreversible: boolean;
}

const PRESENTATIONS: Readonly<Record<SettingsGroup, Omit<SettingsGroupPresentation, 'group'>>> =
  Object.freeze({
    ACCOUNT: {
      title: 'Account Center',
      summary: 'Signing in, this device, and closing your account.',
      iconName: 'shield',
      containsIrreversible: true,
    },
    PRIVACY: {
      title: 'Privacy and data',
      summary: 'What you have agreed to, and taking a copy of your data.',
      iconName: 'document',
      containsIrreversible: false,
    },
    NOTIFICATIONS: {
      title: 'Notifications and reminders',
      summary: 'What arrives, when, and how much it says on a locked screen.',
      iconName: 'clock',
      containsIrreversible: false,
    },
    ACCESSIBILITY: {
      title: 'Accessibility',
      summary: 'Text size, motion, and how Kynviora talks to you.',
      iconName: 'eye-off',
      containsIrreversible: false,
    },
    APPEARANCE: {
      title: 'Appearance',
      summary: 'Light, dark, or whatever your phone is set to.',
      iconName: 'info-circle',
      containsIrreversible: false,
    },
    CONNECTIONS: {
      title: 'Connections',
      summary: 'Where health data could come from, and what is actually connected.',
      iconName: 'scales',
      containsIrreversible: false,
    },
    AGENT: {
      title: 'Kynviora Agent',
      summary: 'What Talk to Kynviora can do, and what it will not do.',
      iconName: 'question-circle',
      containsIrreversible: false,
    },
    HELP: {
      title: 'Help and about',
      summary: 'What this build is, and where to report something wrong.',
      iconName: 'shield-question',
      containsIrreversible: false,
    },
  });

export function settingsGroupPresentation(group: SettingsGroup): SettingsGroupPresentation {
  // DEC-147: an own-property read, so a stored value from outside cannot resolve a function
  // through the prototype and become a row title.
  const found = ownEntry(PRESENTATIONS, group);
  return found === null ? { group: 'ACCOUNT', ...PRESENTATIONS.ACCOUNT } : { group, ...found };
}

export function settingsGroupRows(): readonly SettingsGroupPresentation[] {
  return SETTINGS_GROUPS.map(settingsGroupPresentation);
}

/**
 * The word a row carries when something inside it cannot be undone.
 *
 * A word, on the row, in the ordinary text colour. `18` will not let the fact live in a tint, and
 * `02` will not let it live in alarm - so it lives in the sentence, which is the one place it
 * cannot be missed and cannot be mistaken for a warning about the person's health.
 */
export const IRREVERSIBLE_ROW_NOTE = 'Includes something that cannot be undone';

/**
 * What the Account Center says above its own contents.
 *
 * Stated here rather than on the screen for trap 39's reason: user-visible copy written inline is
 * the text nothing checks. `16` requires the deletion control to exist and be findable, and this
 * is the sentence that makes it findable without making it the first thing anybody sees.
 */
export const ACCOUNT_CENTER_INTRO =
  'How you sign in on this device, and how to close the account for good. Closing an account is ' +
  'at the bottom of this page.';
