/**
 * What somebody agreed to, and what changing their mind actually does.
 *
 * Spec references: `04` Phase 1.4 (versioned consent receipts; separate consent categories;
 * withdrawal flows; export/deletion shell - with the exit criteria "revoking optional consent
 * disables the associated behavior" and "consent state is auditable and localizable"), `16`, `10`
 * (state the limits where you state the findings), `18` (familiar words first, one idea per
 * sentence), `02`, `09`.
 *
 * EVERY SWITCH SAYS WHAT TURNING IT OFF STOPS
 * A consent screen full of switches that all look alike is a screen where a person cannot tell the
 * two that do something from the five that do not. Each purpose below carries the sentence for
 * what withdrawing it stops **in this build** - and for five of the eight the honest sentence is
 * that nothing happens yet, because the behaviour they govern does not exist here. Saying that is
 * uncomfortable and it is the whole point: somebody who turned off "analytics" believing they had
 * stopped something would have been told a comforting untruth by a switch.
 *
 * WITHDRAWING NOTIFICATIONS STOPS ALL OF THEM, INCLUDING A CRITICAL ONE
 * The sentence is above the control, not under it. Quiet hours let a critical safety alert
 * through; consent does not, because consent is the basis on which Kynviora may contact somebody
 * at all. A person who believed a recall would still reach them would be relying on Kynviora for
 * something it will not do, and they would find out on the night it mattered - the same reason
 * DEC-084 puts "archiving turns the safety watch off" above the archive control.
 *
 * NOTHING HERE PERSUADES
 * No sentence recommends granting anything, none describes a withdrawal as a loss, and none says
 * "for the best experience". A consent screen that argues is a consent screen that has stopped
 * asking (`16`, `02`).
 */

import type { ConsentPurpose } from '@kynviora/domain';
import { CONSENT_PURPOSES } from '@kynviora/domain';

export interface ConsentPurposePresentation {
  readonly purpose: ConsentPurpose;
  /** What is being asked, as a thing rather than as a setting name. */
  readonly label: string;
  /** What agreeing to it lets Kynviora do. */
  readonly description: string;
  /**
   * What withdrawing it stops, in this build.
   *
   * Never empty, and never optimistic. Where the answer is "nothing yet", that is what it says.
   */
  readonly withdrawalEffect: string;
}

/** One entry per purpose. A total record, so a purpose added later is copy somebody writes. */
export const CONSENT_PRESENTATION: Readonly<Record<ConsentPurpose, ConsentPurposePresentation>> =
  Object.freeze({
    PROFILE_DATA: {
      purpose: 'PROFILE_DATA',
      label: 'Keeping your records',
      description:
        'The medicines, products and reactions you record, kept so Kynviora can show them back to you.',
      withdrawalEffect:
        'Kynviora cannot work without this, so it is not something you can turn off here. Removing your records is a separate thing, and it is not built yet.',
    },
    NOTIFICATIONS: {
      purpose: 'NOTIFICATIONS',
      label: 'Sending notifications to your device',
      description: 'Kynviora may send something to your device when it has something to tell you.',
      // The sentence a person must read before turning this off. See the module note.
      withdrawalEffect:
        'Nothing will be sent to your device at all - including a critical safety alert about a medicine in this household. Everything is still recorded and waiting when you open Kynviora.',
    },
    CAREGIVER_SHARING: {
      purpose: 'CAREGIVER_SHARING',
      label: 'Telling the people who look after you',
      description:
        'The people you have invited may be sent notifications about you, within what you have allowed them to see.',
      // Precise about the half it does not do. Stopping notifications is not removing access.
      withdrawalEffect:
        'They stop being sent anything about you. They can still see what you have already shared with them - to change that, remove their access on the Care screen.',
    },
    DIAGNOSTICS_ANALYTICS: {
      purpose: 'DIAGNOSTICS_ANALYTICS',
      label: 'Diagnostics about how the app runs',
      description: 'Information about crashes and errors, to find out what is broken.',
      withdrawalEffect: 'Nothing changes yet. Kynviora does not collect any of this at the moment.',
    },
    DOCUMENT_IMAGE_PROCESSING: {
      purpose: 'DOCUMENT_IMAGE_PROCESSING',
      label: 'Reading photographs of packaging',
      description: 'Photographs you take of a pack, read to fill in what is printed on it.',
      withdrawalEffect: 'Nothing changes yet. Kynviora cannot read a photograph at the moment.',
    },
    CATALOG_CONTRIBUTION: {
      purpose: 'CATALOG_CONTRIBUTION',
      label: 'Helping improve product information',
      description: 'What you record about a product, used to improve what Kynviora knows about it.',
      withdrawalEffect:
        'Nothing changes yet. What you type never reaches the shared product information, whichever way this is set.',
    },
    CONNECTED_HEALTH_DATA: {
      purpose: 'CONNECTED_HEALTH_DATA',
      label: 'Connecting other health records',
      description: 'Records from somewhere else, brought in so they sit alongside your own.',
      withdrawalEffect: 'Nothing changes yet. Kynviora connects to nothing at the moment.',
    },
    RESEARCH_PROGRAMME: {
      purpose: 'RESEARCH_PROGRAMME',
      label: 'Taking part in research',
      description: 'Taking part in research Kynviora runs or contributes to.',
      withdrawalEffect: 'Nothing changes yet. There is no research programme at the moment.',
    },
  });

export function presentConsentPurpose(purpose: ConsentPurpose): ConsentPurposePresentation {
  return CONSENT_PRESENTATION[purpose];
}

export function consentPurposeOptions(): readonly ConsentPurposePresentation[] {
  return CONSENT_PURPOSES.map((purpose) => CONSENT_PRESENTATION[purpose]);
}

export const CONSENT_COPY = Object.freeze({
  heading: 'What you have agreed to',
  intro:
    'Each of these is a separate choice and you can change any of them whenever you like. Kynviora keeps a record of what you chose and when.',

  /**
   * Said on every purpose that stops nothing in this build.
   *
   * `10`. A switch that stops nothing while the screen implies otherwise is worse than no switch,
   * and the person deserves to know which of these are real today.
   */
  notYetLabel: 'Nothing to turn off yet',
  notYetNote:
    'Kynviora does not do this at all at the moment. Your answer is recorded and will apply if it ever does.',

  /** Said on the one purpose that is not a choice. */
  requiredLabel: 'Needed for Kynviora to work',

  neverAnsweredNote: 'You have not answered this yet, so Kynviora treats it as not agreed.',

  /** `16`: which text somebody read is part of what they agreed to. */
  staleNote:
    'You agreed to this under an earlier version of the policy. Nothing has changed for you; have a look when you have a moment.',

  grantLabel: 'Agree',
  withdrawLabel: 'Turn this off',
  savedNote: 'Saved. Kynviora has recorded your answer.',

  /**
   * Taking a copy (`04` Phase 1.4, `16` export, DEC-117).
   *
   * This was a sentence saying no such control existed, because a row that opens nothing tells
   * somebody a control exists (`DEV-036`). It opens something now.
   */
  exportHeading: 'Your copy of everything',
  exportIntro:
    'Kynviora can put everything it holds about you into one file for you to keep. It includes your profiles, your medicines and products, what has been recorded against them, your allergies, who has access, and your consent answers.',
  /**
   * What the copy does **not** contain, said before it is taken rather than discovered inside it.
   *
   * `16` asks an export to show what will be included, and the harder half of that is what will
   * not. A person checks a copy once, and an absent section reads as "there was nothing".
   */
  exportOmissionsNote:
    'The file also names what is not in it, and why. Regulatory documents Kynviora consulted are named rather than copied, because they belong to the organisations that published them.',
  exportLabel: 'Take a copy',
  exportHint: 'Builds the file now. You will be asked to confirm your identity first.',
  exportReadyNote: 'Your copy is ready. Save it somewhere you can find it again.',
  /**
   * Said where a section of the copy could not be assembled.
   *
   * The alternative is silence, and silence is the one failure this feature cannot have: a missing
   * section looks exactly like a section that was empty.
   */
  exportIncompleteNote:
    'Part of this copy could not be assembled, and the file says which part. Try again, and do not treat this file as complete.',

  /**
   * Removing everything, which is still not built.
   *
   * Narrower than it was. Deleting a single item is built and lives on the item itself, where
   * somebody looking at a medicine can reach it; what has no control yet is removing an account
   * and everything in it. The sentence says which is which, because "not built yet" across both
   * would now be false - and a screen that understates what a product can already do sends
   * somebody looking for a control they have walked past.
   */
  deletionHeading: 'Removing your records',
  deletionNote:
    'You can delete any single medicine or product from its own screen. Removing your whole account and everything in it is not built yet, and Kynviora will not show a button that does nothing.',
});

/** Every sentence this module can put on a screen, for the copy scans. */
export const ALL_CONSENT_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(CONSENT_COPY),
  ...consentPurposeOptions().flatMap((option) => [
    option.label,
    option.description,
    option.withdrawalEffect,
  ]),
]);
