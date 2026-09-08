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

import type { CaregiverAuditAction, CaregiverCapability } from '@kynviora/domain';
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
      meaning:
        'They can see the medicines recorded for this person, and when each one was taken. ' +
        'They cannot change anything.',
      allowsChanges: false,
      delegatesAdministration: false,
    },
    // Named separately from both of its neighbours, because it belongs to neither. Recording a
    // dose is a write, so this sentence cannot live under `VIEW_MEDICINES` - that was `DEV-049`,
    // where the screen said "viewing" over a grant that carried a write into somebody's dose
    // history. And it is not editing medicines: the person doing it most often is the person
    // sitting with somebody at breakfast, who has no business deleting a prescription.
    //
    // The second sentence is the one worth having. `04` Phase 4.3 keeps a record of what happened
    // and `dose_event` is append-only, so a correction is a further entry rather than a rewrite -
    // which means granting this hands over the ability to add to a history and never to tidy one.
    // Somebody approving access needs that in the sentence, because "correcting" sounds like the
    // smaller permission and is in fact the same one.
    RECORD_DOSES: {
      label: 'Record doses',
      meaning:
        'They can record that a medicine was taken, skipped or missed, and add a correction if ' +
        'they get one wrong. Nothing already recorded can be removed.',
      allowsChanges: true,
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
    // Kept apart from `VIEW_DOCUMENTS`, and the sentence has to say what it covers rather than
    // naming a screen. "Health" is the name of a tab; "lab results, medical records and
    // measurements" is what somebody is actually handing over, and a person approving access
    // reads the second one and not the first (`18`).
    VIEW_HEALTH_RECORDS: {
      label: 'Health records',
      meaning:
        'They can see lab results, medical records and health measurements recorded for this ' +
        'person, including the original documents. They cannot change anything.',
      allowsChanges: false,
      delegatesAdministration: false,
    },
    MANAGE_HEALTH_RECORDS: {
      label: 'Edit health records',
      meaning:
        'They can add, correct and remove health records, lab results and measurements for this ' +
        'person.',
      allowsChanges: true,
      delegatesAdministration: false,
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

/**
 * The three block headings the invitation review uses.
 *
 * Here rather than in the screen because {@link accessCoverage} needs the same three for a grant
 * that is live, and two lists of headings drift: the review would end up saying one thing about a
 * set of capabilities and the row afterwards another about the same set. Explicitly future,
 * because the review happens before anything is granted.
 */
export const INVITATION_HEADINGS = Object.freeze({
  seeing: 'They will be able to see',
  changing: 'They will be able to change',
  notIncluded: 'Not included',
});

/**
 * Whether access in this state is live: somebody can act on this profile now.
 *
 * One member today and written as a predicate rather than as `state === 'ACTIVE'` at four call
 * sites, because what the callers mean is "is this happening", and a state added later that is
 * also live has one place to be added.
 */
export function accessIsLive(state: CaregiverAccessState): boolean {
  return state === 'ACTIVE';
}

/**
 * What a card about one grant may say, given whether that grant is happening.
 *
 * WHY THIS IS NOT `summarizeAccess`
 * `summarizeAccess` composes the capability **meanings**, and every one of them is a present-tense
 * sentence: *"They can see the medicines recorded for this person, and when each one was taken."*
 * That is right where the access is live, and it is what the invitation review needs under an
 * explicitly future heading. `CaregiverRow` called it for every row regardless of state, so a
 * revoked grant carried that sentence directly under a chip reading *"Access removed. It stopped
 * straight away"* - a contradiction two lines apart, in the unsafe direction (`DEV-101`).
 *
 * The fix is not to rewrite the meanings. They are the definitions of the capabilities and they
 * are correct; they are simply not statements a card about ended access may make. So a row that is
 * not live states what the access **covered**, as capability **labels** - which carry no tense at
 * all - under a heading that carries it instead.
 *
 * WHY `subject` DECIDES BETWEEN "LET" AND "WOULD HAVE LET"
 * `EXPIRED` covers a lapsed grant and a lapsed invitation, and the reader does not need that
 * distinction as a word - but the two need different verbs, because one took effect and the other
 * never did. `subject` already says which: a grant exists only once an invitation was accepted.
 * Nothing about the record is put on screen; it only chooses the tense.
 *
 * WHY THE WITHHELD BLOCK DISAPPEARS
 * "Not shared with them" is a statement about a live grant: these are the things this person cannot
 * see *while they can see the rest*. On ended access everything is withheld, so listing a subset
 * would be the least informative possible sentence. `18` requires the limitation to be stated and
 * it is - by the status itself, whose description says the access stopped and that they can no
 * longer see anything.
 */
export interface AccessCoverageView {
  /** Whether this is a statement about access somebody has now. */
  readonly live: boolean;
  readonly seeingTitle: string;
  readonly changingTitle: string;
  /** `null` where the block would be meaningless, which is every state but a live one. */
  readonly notIncludedTitle: string | null;
  /** Full sentences while the access is live, capability labels otherwise. */
  readonly seeing: readonly string[];
  readonly changing: readonly string[];
  readonly notIncluded: readonly string[];
  /** Only ever present on a live grant, for the same reason the sentences are. */
  readonly administrationWarning: string | null;
}

export function accessCoverage(
  state: CaregiverAccessState,
  subject: 'GRANT' | 'INVITATION',
  capabilities: readonly CaregiverCapability[],
): AccessCoverageView {
  const summary = summarizeAccess(capabilities);
  const granted = new Set(capabilities);
  const labels = (allowsChanges: boolean): readonly string[] =>
    (Object.keys(CAPABILITY_DESCRIPTIONS) as CaregiverCapability[])
      .filter(
        (capability) =>
          granted.has(capability) &&
          CAPABILITY_DESCRIPTIONS[capability].allowsChanges === allowsChanges,
      )
      .map((capability) => CAPABILITY_DESCRIPTIONS[capability].label);

  if (accessIsLive(state)) {
    return {
      live: true,
      seeingTitle: 'What they can see',
      changingTitle: 'What they can change',
      notIncludedTitle: 'Not shared with them',
      seeing: summary.viewing,
      changing: summary.changing,
      notIncluded: summary.notIncluded,
      administrationWarning: summary.administrationWarning,
    };
  }

  if (state === 'INVITED') {
    // The review screen's own headings and the review screen's own sentences: this row is the same
    // statement about the same capabilities, made from the same function, a moment later.
    return {
      live: false,
      seeingTitle: INVITATION_HEADINGS.seeing,
      changingTitle: INVITATION_HEADINGS.changing,
      notIncludedTitle: INVITATION_HEADINGS.notIncluded,
      seeing: summary.viewing,
      changing: summary.changing,
      notIncluded: summary.notIncluded,
      administrationWarning: summary.administrationWarning,
    };
  }

  const tookEffect = subject === 'GRANT';
  return {
    live: false,
    seeingTitle: tookEffect ? 'What it let them see' : 'What it would have let them see',
    changingTitle: tookEffect ? 'What it let them change' : 'What it would have let them change',
    notIncludedTitle: null,
    seeing: labels(false),
    changing: labels(true),
    notIncluded: [],
    administrationWarning: null,
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
  // "and do", because some of what is on this list is not looking. It was already imprecise while
  // the list carried the editing capabilities, and `RECORD_DOSES` is what made it wrong: the whole
  // point of splitting that capability out is that choosing from this list is choosing what
  // somebody may write as much as what they may read (`DEV-049`). A screen that opens by calling
  // all of it "see" has understated the grant before the person has read a single row.
  inviteIntro:
    'Choose what this person can see and do. They will use their own account, not your sign-in.',
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

// ---------------------------------------------------------------------------
// Removing access
// ---------------------------------------------------------------------------

/**
 * Fixed copy for the removal flow.
 *
 * `18` requires a screen to say what it is about to do before it does it, and removing access is
 * the one caregiver action with no undo: the invitation token was stored only as a hash and
 * cannot be reissued (DEC-018), so restoring access means sending a new invitation and having it
 * accepted again. That sentence is on the confirmation, not discovered afterwards.
 *
 * The tone is deliberately not a warning. `15` wants removing access to be easy, and copy that
 * treats it as dangerous discourages the very thing the threat model relies on - which is why
 * `CAREGIVER_ACCESS_PRESENTATION.REVOKED` is neutral too.
 */
export const REVOCATION_COPY = Object.freeze({
  grantHeading: 'Remove their access',
  selfHeading: 'Remove your own access',
  invitationHeading: 'Withdraw this invitation',

  /** Matches the behaviour: `has_capability` re-evaluates the grant on every request (`15` A2). */
  immediate: 'This takes effect straight away.',
  selfImmediate: 'You will stop seeing this profile straight away.',
  invitationImmediate: 'The link stops working straight away.',

  /** What is lost, stated once. Both of these are about needing to start again, not about risk. */
  noUndo: 'You cannot undo this. To give access again, send a new invitation.',
  invitationNoUndo: 'Anyone still holding the old link will not be able to use it.',
  selfNoUndo: 'The person who owns this profile can invite you again.',

  stopsSeeingHeading: 'They will stop being able to see',
  stopsChangingHeading: 'They will stop being able to change',
  selfStopsSeeingHeading: 'You will stop being able to see',
  selfStopsChangingHeading: 'You will stop being able to change',

  /** The one case where the record on screen is not the record that carries the access. */
  alreadyAccepted:
    'They have already accepted. Remove their access from the list instead of the invitation.',
  nothingToRemove: 'This access has already ended. There is nothing to remove.',

  confirmLabel: 'Remove access',
  invitationConfirmLabel: 'Withdraw invitation',
  cancelLabel: 'Keep access as it is',
  doneLabel: 'Back to the list',
  historyIntro: 'Every change to who can see this profile is recorded here.',
});

/**
 * How many history entries this build cannot describe.
 *
 * `null` where there are none, so the screen has nothing to render rather than a sentence saying
 * zero. A function rather than a fixed string because singular and plural must both read
 * naturally, and because the count is the whole point: `03` group H is about the owner seeing
 * what happened, and a history that silently omitted rows would look complete while answering
 * the question wrongly.
 */
export function unreadableHistoryNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 more change was recorded. This version of the app cannot describe it.'
    : `${count} more changes were recorded. This version of the app cannot describe them.`;
}

/** What a removal confirmation says, assembled once so no screen has to phrase it. */
export interface RevocationDescription {
  readonly heading: string;
  /** When it happens. Always present, because immediacy is the fact people get wrong. */
  readonly immediate: string;
  /** What starting again would take. Two sentences at most. */
  readonly consequences: readonly string[];
  readonly seeingHeading: string;
  readonly changingHeading: string;
  readonly confirmLabel: string;
}

/**
 * Describe a removal in the words a person reads.
 *
 * `isSelf` changes every sentence rather than one, which is why this is a function and not a
 * template with a substituted pronoun: "they will stop seeing this profile" put in front of
 * someone removing their own access is not a wording problem, it is the wrong statement.
 */
export function describeRevocation(input: {
  readonly subject: 'GRANT' | 'INVITATION';
  readonly isSelf: boolean;
}): RevocationDescription {
  if (input.subject === 'INVITATION') {
    return {
      heading: REVOCATION_COPY.invitationHeading,
      immediate: REVOCATION_COPY.invitationImmediate,
      consequences: [REVOCATION_COPY.invitationNoUndo],
      seeingHeading: REVOCATION_COPY.stopsSeeingHeading,
      changingHeading: REVOCATION_COPY.stopsChangingHeading,
      confirmLabel: REVOCATION_COPY.invitationConfirmLabel,
    };
  }

  if (input.isSelf) {
    return {
      heading: REVOCATION_COPY.selfHeading,
      immediate: REVOCATION_COPY.selfImmediate,
      consequences: [REVOCATION_COPY.selfNoUndo],
      seeingHeading: REVOCATION_COPY.selfStopsSeeingHeading,
      changingHeading: REVOCATION_COPY.selfStopsChangingHeading,
      confirmLabel: REVOCATION_COPY.confirmLabel,
    };
  }

  return {
    heading: REVOCATION_COPY.grantHeading,
    immediate: REVOCATION_COPY.immediate,
    consequences: [REVOCATION_COPY.noUndo],
    seeingHeading: REVOCATION_COPY.stopsSeeingHeading,
    changingHeading: REVOCATION_COPY.stopsChangingHeading,
    confirmLabel: REVOCATION_COPY.confirmLabel,
  };
}

// ---------------------------------------------------------------------------
// The access history
// ---------------------------------------------------------------------------

/**
 * Each audit action as a person reads it.
 *
 * `03` group H requires audit event visibility, and an audit log a person cannot read does not
 * provide it. A total record over the domain's vocabulary rather than a lookup with a fallback:
 * a new caregiver audit action fails to compile here until somebody writes the sentence.
 *
 * Every line is about the access, never about the person. `20` forbids an audit log becoming a
 * verbose copy of health content, and the same reasoning applies to the screen that renders it.
 */
export const CAREGIVER_AUDIT_DESCRIPTIONS: Readonly<Record<CaregiverAuditAction, string>> =
  Object.freeze({
    'caregiver.invitation.created': 'An invitation was sent.',
    'caregiver.invitation.accepted': 'An invitation was accepted.',
    'caregiver.invitation.declined': 'An invitation was declined.',
    'caregiver.invitation.revoked': 'An invitation was withdrawn.',
    'caregiver.invitation.rejected': 'An invitation link was used and refused.',
    'caregiver.grant.created': 'Access was given.',
    'caregiver.grant.revoked': 'Access was removed.',
  });

/**
 * Describe an audit action, or refuse it.
 *
 * `null` rather than a fallback sentence, for the same reason a review task kind has none: an
 * action this build does not know about has no words anyone wrote, and inventing them would put
 * a statement about who could read a person's records next to a timestamp that makes it look
 * checked.
 */
export function describeAuditAction(action: string): string | null {
  return action in CAREGIVER_AUDIT_DESCRIPTIONS
    ? CAREGIVER_AUDIT_DESCRIPTIONS[action as CaregiverAuditAction]
    : null;
}

/** Every fixed string in this module, for the forbidden-claim test. */
export const ALL_CAREGIVER_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(CAREGIVER_COPY),
  ...Object.values(REVOCATION_COPY),
  ...Object.values(CAREGIVER_AUDIT_DESCRIPTIONS),
  invitationExpiryNote(1),
  invitationExpiryNote(7),
  unreadableHistoryNote(1) ?? '',
  unreadableHistoryNote(4) ?? '',
  ...Object.values(CAPABILITY_DESCRIPTIONS).flatMap((d) => [d.label, d.meaning]),
  ...Object.values(CAREGIVER_ACCESS_PRESENTATION).flatMap((p) => [
    p.label,
    p.description,
    p.accessibilityLabel,
  ]),
  // Every heading `accessCoverage` can produce, over the whole state vocabulary and both subjects.
  // Derived rather than listed, so a heading added for a state added later is checked by the copy
  // rules without anybody remembering to add it here.
  ...CAREGIVER_ACCESS_STATES.flatMap((state) =>
    (['GRANT', 'INVITATION'] as const).flatMap((subject) => {
      const coverage = accessCoverage(state, subject, []);
      return [coverage.seeingTitle, coverage.changingTitle, coverage.notIncludedTitle ?? ''];
    }),
  ),
]);
