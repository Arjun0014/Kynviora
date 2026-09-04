/**
 * Deleting an item, in words (`16`, `18`, DEC-117, `docs/RETENTION.md`).
 *
 * Spec references: `16` (a deletion workflow must enumerate what goes and what is retained; do
 * not claim immediate universal erasure while retained records have a specified lifecycle),
 * `18` (confirm a destructive action; say what a screen will do before it does it; a person must
 * be able to understand what they are agreeing to), `10` (the placement rule: what matters goes
 * above the control, not under it), `14`.
 *
 * WHY THIS IS COPY AND NOT A DIALOG WITH A YES BUTTON
 * The same argument `RemoveCaregiverAccess` makes. The consequential fact is not "are you sure":
 * it is **what goes**, **what stays**, and **when**. Two of those are surprising - a dose history
 * goes with the medicine, and the record that the deletion happened does not go at all - and a
 * two-button alert has nowhere to say either.
 *
 * WHY IT SAYS WHAT IS KEPT
 * Because it is true, and because `16` forbids the alternative. `audit_event` and
 * `consent_receipt` survive a deletion for 24 months on an approved basis (DEC-117). A screen
 * that said "this removes everything" would be a product telling somebody their data is gone
 * while two tables still hold rows about them. The honest sentence is worse-sounding and is the
 * only one available.
 *
 * WHAT IT DOES NOT SAY
 * A purge date. The 30-day deadline in the matrix is an operational commitment about bytes and
 * this build has no backup system to state a restore lifecycle for; naming a date a person could
 * hold the product to, from a screen, would be a promise made by a sentence rather than by a job
 * that exists.
 */

import type { ItemKind } from '@kynviora/domain';

export const ITEM_DELETION_COPY = Object.freeze({
  /** On the item screen, beside the other controls. */
  openLabel: 'Delete this from the shelf',

  medicineHeading: 'Delete this medicine',
  personalCareHeading: 'Delete this product',

  /**
   * The distinction the control exists for.
   *
   * `DEV-032` was archiving being offered where deletion belonged. Now that both exist, the
   * screen has to say which is which, or a person picks the destructive one because it is the
   * one that sounds final.
   */
  archiveAlternative:
    'If you only want Kynviora to stop asking about this, mark it as no longer used instead. That keeps the record.',

  goesHeading: 'What is removed',
  /** `16`'s enumeration requirement, in the order a person will care about it. */
  medicineGoes: Object.freeze([
    'This medicine, and everything recorded against it.',
    'Every dose recorded for it, including ones a caregiver recorded.',
    'Its reminders. Nothing further will be scheduled for it.',
    'It stops appearing in a Visit Pack you create afterwards.',
  ]),
  personalCareGoes: Object.freeze([
    'This product, and everything recorded against it.',
    'Anything recorded about how it has been used.',
    'It stops appearing in a Visit Pack you create afterwards.',
  ]),

  /** When, said as plainly as the behaviour warrants. */
  immediate:
    'This happens straight away, for you and for anyone you have given access to. Nobody has to wait for anything.',

  staysHeading: 'What is kept',
  /**
   * The sentence `16` requires and the one a product is most tempted to leave out.
   *
   * Two facts, not one: that a record of the deletion is kept, and why. Without the second it
   * reads as a caveat somebody forgot to remove.
   */
  staysNote:
    'Kynviora keeps a record that this was deleted, and by whom, for two years. That record does not include what was on the item or anything you wrote about it. It exists so a change to somebody’s health information can be traced later, and it is kept whether or not anything goes wrong.',

  /** Caregivers, said explicitly, because the shelf is shared and the screen is not obviously so. */
  caregiverNote:
    'Anyone with access to this profile will no longer see it, and will not be told that it was deleted.',

  noUndo: 'You cannot undo this. Adding it again means entering it again.',

  confirmLabel: 'Delete it',
  cancelLabel: 'Keep it',
  doneHeading: 'Deleted',
  doneNote: 'It has been removed from the shelf.',
  doneLabel: 'Back to the shelf',

  /**
   * Shown where the server refused.
   *
   * Deliberately not "you are not allowed". `13` does not let the API distinguish a refusal from
   * an absence, so the client genuinely does not know which happened, and a screen that guessed
   * would be inventing the more alarming of the two. What is true either way is that it is not
   * there now.
   */
  goneNote: 'This is not on the shelf. It may already have been deleted.',

  /**
   * `14`: deletion is a high-impact action and needs re-authentication. Said before the button,
   * so nobody presses it expecting to be finished.
   */
  stepUpPrompt: 'You will be asked to confirm your identity first.',
});

export interface ItemDeletionWords {
  readonly heading: string;
  readonly goesHeading: string;
  readonly goes: readonly string[];
  readonly immediate: string;
  readonly staysHeading: string;
  readonly stays: string;
  readonly caregiverNote: string;
  readonly archiveAlternative: string;
  readonly noUndo: string;
  readonly stepUpPrompt: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

/**
 * What deleting this particular item removes.
 *
 * The two lists differ because the two kinds of item genuinely have different children: a
 * personal-care product has no doses and no reminders, and listing them anyway would be the
 * screen describing something that was never there. `04` Phase 2.1's first exit criterion is
 * that the two coexist without either being reduced to a generic note, and a shared list would
 * reduce both.
 */
export function describeItemDeletion(itemKind: ItemKind): ItemDeletionWords {
  const isMedicine = itemKind === 'MEDICINE';
  return {
    heading: isMedicine
      ? ITEM_DELETION_COPY.medicineHeading
      : ITEM_DELETION_COPY.personalCareHeading,
    goesHeading: ITEM_DELETION_COPY.goesHeading,
    goes: isMedicine ? ITEM_DELETION_COPY.medicineGoes : ITEM_DELETION_COPY.personalCareGoes,
    immediate: ITEM_DELETION_COPY.immediate,
    staysHeading: ITEM_DELETION_COPY.staysHeading,
    stays: ITEM_DELETION_COPY.staysNote,
    caregiverNote: ITEM_DELETION_COPY.caregiverNote,
    archiveAlternative: ITEM_DELETION_COPY.archiveAlternative,
    noUndo: ITEM_DELETION_COPY.noUndo,
    stepUpPrompt: ITEM_DELETION_COPY.stepUpPrompt,
    confirmLabel: ITEM_DELETION_COPY.confirmLabel,
    cancelLabel: ITEM_DELETION_COPY.cancelLabel,
  };
}
