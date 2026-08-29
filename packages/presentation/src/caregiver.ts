/**
 * Caregiver access presentation.
 *
 * Spec references: `18` (plain language, never meaning through colour alone, one idea per
 * sentence, no forbidden claims), `03` group H (explicit profile/capability grants, revocation,
 * audit visibility), `06` Journey 6, `15` (the caregiver relationship boundary depends on the
 * person actually understanding what they granted).
 *
 * WHY THE COPY LIVES HERE AND NOT IN A SCREEN
 * A capability is a machine code. `MANAGE_MEDICINES` tells a caregiver nothing, and a person
 * approving access has to understand what they are approving or the consent is not meaningful
 * (`16`). Turning codes into sentences is therefore a product-safety concern, not a rendering
 * detail, and it is stated once here so the invite screen, the review screen and the audit list
 * cannot describe the same capability three different ways.
 *
 * Each sentence is written from the caregiver's point of view and says what they will be able to
 * *see* or *do* - never what the profile owner "should" do. A test runs every string through the
 * forbidden-claim detector.
 */

import type { CaregiverCapability } from '@kynviora/domain';
import type { StatusPresentation } from './status.js';

// ---------------------------------------------------------------------------
// Capabilities in plain language
// ---------------------------------------------------------------------------

/** A capability as a person reads it. */
export interface CapabilityDescription {
  /** Short label for a list row. */
  readonly label: string;
  /** One sentence saying exactly what the caregiver can see or do. */
  readonly meaning: string;
  /**
   * Whether this capability lets the holder *change* something rather than only look at it.
   *
   * Surfaced separately so a review screen can group viewing and changing, which is the
   * distinction a person actually cares about when approving access.
   */
  readonly allowsChanges: boolean;
  /**
   * Whether granting it hands over administrative control of the access list itself.
   *
   * Only `MANAGE_CAREGIVERS` does. It is called out because it is the one capability whose
   * effect is not visible in the profile at all.
   */
  readonly delegatesAdministration: boolean;
}

/**
 * Every capability, described once.
 *
 * A total record rather than a lookup with a fallback: a new capability added to the vocabulary
 * fails to compile here until someone writes the sentence a user will read.
 */
export const CAPABILITY_DESCRIPTIONS: Readonly<Record<CaregiverCapability, CapabilityDescription>> =
  Object.freeze({
    VIEW_SAFETY: {
      label: 'Safety updates',
      meaning: 'They can see safety updates about this person and the items on their shelf.',
      allowsChanges: false,
      delegatesAdministration: false,
    },
    VIEW_SHELF: {
      label: 'Shelf',
      meaning: 'They can see the personal-care products on this shelf.',
      allowsChanges: false,
      delegatesAdministration: false,
    },
    MANAGE_SHELF: {
      label: 'Edit shelf',
      meaning: 'They can add, change and remove personal-care products on this shelf.',
      allowsChanges: true,
      delegatesAdministration: false,
    },
    VIEW_MEDICINES: {
      label: 'Medicines',
      meaning: 'They can see the medicines recorded for this person.',
      allowsChanges: false,
      delegatesAdministration: false,
    },
    MANAGE_MEDICINES: {
      label: 'Edit medicines',
      meaning: 'They can add, change and remove medicines and their schedules.',
      allowsChanges: true,
      delegatesAdministration: false,
    },
    VIEW_CARE: {
      label: 'Care tasks',
      meaning: 'They can see appointments and review tasks.',
      allowsChanges: false,
      delegatesAdministration: false,
    },
    MANAGE_CARE: {
      label: 'Edit care tasks',
      meaning: 'They can add and complete appointments and review tasks.',
      allowsChanges: true,
      delegatesAdministration: false,
    },
    VIEW_DOCUMENTS: {
      label: 'Documents',
      meaning: 'They can open saved photos and documents, including package labels.',
      allowsChanges: false,
      delegatesAdministration: false,
    },
    EXPORT_SUMMARY: {
      label: 'Exports',
      meaning: 'They can create a Visit Pack summary to share with a health professional.',
      allowsChanges: true,
      delegatesAdministration: false,
    },
    RECEIVE_MISSED_DOSE: {
      label: 'Missed dose alerts',
      meaning: 'They get a notification when a dose is recorded as missed.',
      allowsChanges: false,
      delegatesAdministration: false,
    },
    MANAGE_CAREGIVERS: {
      label: 'Manage caregivers',
      meaning: 'They can invite and remove other caregivers for this person.',
      allowsChanges: true,
      delegatesAdministration: true,
    },
  });

export function describeCapability(capability: CaregiverCapability): CapabilityDescription {
  return CAPABILITY_DESCRIPTIONS[capability];
}

/**
 * A summary of a grant, for the review screen shown before access is given.
 *
 * `16` requires consent to be a product state a person can understand and revisit, and `06`
 * Journey 6 puts an explicit review step before the grant exists. The summary is built from the
 * capability list rather than written per invitation, so it can never describe access that
 * differs from what will actually be granted.
 */
export interface AccessSummary {
  readonly viewing: readonly string[];
  readonly changing: readonly string[];
  /** Present only when the grant hands over administration. */
  readonly administrationWarning: string | null;
  /**
   * What this access does **not** include.
   *
   * `18` requires stating the limitation, and a person reading only the list of what was granted
   * will not notice what was withheld. Naming the omissions is what makes the grant legible.
   */
  readonly notIncluded: readonly string[];
}

export function summarizeAccess(capabilities: readonly CaregiverCapability[]): AccessSummary {
  const granted = new Set(capabilities);
  const viewing: string[] = [];
  const changing: string[] = [];
  const notIncluded: string[] = [];

  for (const capability of Object.keys(CAPABILITY_DESCRIPTIONS) as CaregiverCapability[]) {
    const description = CAPABILITY_DESCRIPTIONS[capability];
    if (granted.has(capability)) {
      (description.allowsChanges ? changing : viewing).push(description.meaning);
    } else {
      notIncluded.push(description.label);
    }
  }

  return {
    viewing,
    changing,
    administrationWarning: granted.has('MANAGE_CAREGIVERS')
      ? 'They can also invite and remove other caregivers. You can change this at any time.'
      : null,
    notIncluded,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle status presentation
// ---------------------------------------------------------------------------

/**
 * Statuses a person sees on the caregiver list.
 *
 * Deliberately not the raw database enum: `EXPIRED` covers both a lapsed invitation and a lapsed
 * grant, and the person reading the screen does not need that distinction.
 */
export const CAREGIVER_ACCESS_STATES = [
  'INVITED',
  'ACTIVE',
  'EXPIRED',
  'DECLINED',
  'REVOKED',
] as const;
export type CaregiverAccessState = (typeof CAREGIVER_ACCESS_STATES)[number];

/**
 * How each state is presented.
 *
 * Every entry carries a label and a shape-distinguishable icon, so the state is never conveyed
 * by tone alone (`18`). `REVOKED` and `DECLINED` are given neutral rather than alarming tones:
 * removing access is a normal, expected action, and styling it as a warning would discourage the
 * very thing `15` wants to be easy.
 */
export const CAREGIVER_ACCESS_PRESENTATION: Readonly<
  Record<CaregiverAccessState, StatusPresentation>
> = Object.freeze({
  INVITED: {
    label: 'Invited',
    iconName: 'clock',
    tone: 'informational',
    description: 'They have been invited and have not accepted yet. They have no access.',
    accessibilityLabel: 'Invited. Not accepted yet. This person has no access.',
  },
  ACTIVE: {
    label: 'Has access',
    iconName: 'shield',
    tone: 'informational',
    description: 'They accepted the invitation and can see what you allowed.',
    accessibilityLabel: 'Has access. They accepted the invitation.',
  },
  EXPIRED: {
    label: 'Expired',
    iconName: 'clock',
    tone: 'neutral',
    description: 'The access period ended. They can no longer see anything.',
    accessibilityLabel: 'Expired. The access period ended and they can no longer see anything.',
  },
  DECLINED: {
    label: 'Declined',
    iconName: 'eye-off',
    tone: 'neutral',
    description: 'They declined the invitation. They have no access.',
    accessibilityLabel: 'Declined. This person has no access.',
  },
  REVOKED: {
    label: 'Access removed',
    iconName: 'eye-off',
    tone: 'neutral',
    description: 'You removed their access. It stopped straight away.',
    accessibilityLabel: 'Access removed. It stopped straight away.',
  },
});

export function presentCaregiverAccess(state: CaregiverAccessState): StatusPresentation {
  return CAREGIVER_ACCESS_PRESENTATION[state];
}

// ---------------------------------------------------------------------------
// Flow copy
// ---------------------------------------------------------------------------

/**
 * Fixed copy for the invitation flow.
 *
 * `18` requires plain language and an explicit statement of what a screen will do before it does
 * it. The two most consequential sentences here are the ones about the link: a person handing
 * out a bearer credential needs to know it is one.
 */
export const CAREGIVER_COPY = Object.freeze({
  inviteIntro:
    'Choose what this person can see. They will use their own account, not your sign-in.',
  reviewHeading: 'Check what you are sharing',
  linkWarning:
    'Anyone who opens this link can accept the invitation. Send it only to the person you mean.',
  linkShownOnce:
    'This link is shown once. If you lose it, remove the invitation and send a new one.',
  stepUpPrompt: 'Confirm it is you before changing who has access.',
  revokeConfirm: 'Remove their access? They will stop seeing anything straight away.',
  revokeDone: 'Access removed.',
  acceptIntro: 'You have been invited to help look after someone.',
  acceptExpired: 'This invitation has expired. Ask them to send a new one.',
  acceptInvalid: 'This invitation link is not valid.',
  acceptUsed: 'This invitation has already been used.',
  emptyState: 'No one else has access to this profile.',
  auditHeading: 'Access history',
});

/**
 * How long the invitation stays usable, in a sentence.
 *
 * A function rather than a fixed string because the lifetime is configurable, and singular and
 * plural must both read naturally - `18` treats awkward machine-assembled phrasing as a defect
 * in a critical journey, not a cosmetic one.
 */
export function invitationExpiryNote(days: number): string {
  return days === 1
    ? 'The invitation stops working after 1 day.'
    : `The invitation stops working after ${days} days.`;
}

/** Every fixed string in this module, for the forbidden-claim test. */
export const ALL_CAREGIVER_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(CAREGIVER_COPY),
  invitationExpiryNote(1),
  invitationExpiryNote(7),
  ...Object.values(CAPABILITY_DESCRIPTIONS).flatMap((d) => [d.label, d.meaning]),
  ...Object.values(CAREGIVER_ACCESS_PRESENTATION).flatMap((p) => [
    p.label,
    p.description,
    p.accessibilityLabel,
  ]),
]);
