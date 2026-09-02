/**
 * Changing an item, and putting one out of use, in words.
 *
 * Spec references: `04` Stage 2 stage output ("create, view, update, archive, and review"), `04`
 * Phase 2.1 (common item lifecycle), `10` (state the limits where you state the findings), `18`
 * (familiar words first, one idea per sentence, a label is always present), `13` (conflict policy
 * `ASK_USER` for `owned_item`), `02`, `09`.
 *
 * EVERY STATE SAYS WHAT KYNVIORA STOPS DOING
 * A person choosing "stopped using this" is choosing something with consequences they cannot see:
 * the Shelf stops asking about it, the Review Inbox stops raising it, and a reconciliation stops
 * counting it. Archiving stops the safety watch as well. Somebody who archived a medicine
 * believing Kynviora would still tell them about a recall would be relying on it for something it
 * had stopped doing - which is the failure `10` exists to prevent, on the one screen where a
 * person makes the choice.
 *
 * The wording is checked against the code rather than written beside it: the consequences below
 * are `shelfAttention`'s `lifecycleState !== 'ACTIVE'`, `reviewInbox`'s same test,
 * `reconciliation`'s `lifecycle_state = 'ACTIVE'` and the safety inbox's
 * `lifecycle_state <> 'ARCHIVED'`.
 *
 * NOTHING HERE IS A JUDGEMENT ABOUT A MEDICINE
 * "Stopped using this" is a record of what somebody did. It is never advice, never a
 * recommendation to stop, and the copy never suggests either (`09`).
 */

import type { ItemLifecycleState } from '@kynviora/domain';
import { ITEM_LIFECYCLE_STATES } from '@kynviora/domain';

export interface LifecycleActionView {
  readonly state: ItemLifecycleState;
  /** The control's label, phrased as the thing a person did rather than as a system state. */
  readonly label: string;
  /** What choosing it records. */
  readonly description: string;
  /**
   * What Kynviora stops doing.
   *
   * Never empty. Every member of the vocabulary has one, including `ACTIVE` - a person putting an
   * item back into use is also choosing something, and "Kynviora starts asking about it again" is
   * the honest version of that.
   */
  readonly stops: string;
  /** Read after the label by a screen reader, where the label alone is not the whole action. */
  readonly accessibilityHint: string;
}

const LIFECYCLE_ACTIONS: Readonly<Record<ItemLifecycleState, LifecycleActionView>> = Object.freeze({
  ACTIVE: {
    state: 'ACTIVE',
    label: 'I am using this',
    description:
      'Puts it back among the things you are using. Anything Kynviora already knew about it is still there.',
    stops:
      'Kynviora starts asking about it again, and it comes back into medicine lists you put together.',
    accessibilityHint: 'Marks this as something you are using now.',
  },
  STOPPED: {
    state: 'STOPPED',
    label: 'I have stopped using this',
    description:
      'Records that you are not using it any more. It stays on the record, and so does everything Kynviora knew about it.',
    stops:
      'Kynviora stops asking you to check it and leaves it out of medicine lists you put together. It still tells you about recalls and other safety notices.',
    accessibilityHint: 'Records that you have stopped. It does not remove anything.',
  },
  ARCHIVED: {
    state: 'ARCHIVED',
    label: 'Put this away',
    description:
      'Files it away. It stays on the record and you can bring it back at any time, and nothing about it is deleted.',
    stops:
      'Kynviora stops watching it entirely - no recalls, no safety notices and nothing to check. This is the one that turns the safety watch off.',
    accessibilityHint:
      'Files it away and stops the safety watch. Nothing is deleted and you can undo it.',
  },
});

/**
 * The states an item can be moved to, excluding the one it is already in.
 *
 * The current state is absent rather than shown selected. A control that does nothing is one a
 * person presses and then wonders about, and DEC-045's rule - absent rather than disabled -
 * applies to a choice as much as to a permission.
 */
export function lifecycleActions(current: ItemLifecycleState): readonly LifecycleActionView[] {
  return ITEM_LIFECYCLE_STATES.filter((state) => state !== current).map(
    (state) => LIFECYCLE_ACTIONS[state],
  );
}

export function lifecycleAction(state: ItemLifecycleState): LifecycleActionView {
  return LIFECYCLE_ACTIONS[state];
}

/** Every sentence this module can put on a screen, for the copy scans. */
export const ALL_LIFECYCLE_STRINGS: readonly string[] = Object.freeze(
  ITEM_LIFECYCLE_STATES.flatMap((state) => {
    const action = LIFECYCLE_ACTIONS[state];
    return [action.label, action.description, action.stops, action.accessibilityHint];
  }),
);

/**
 * The rest of the editing copy.
 *
 * The conflict wording is the whole of `13`'s `ASK_USER` policy on a screen. It has to say three
 * things: that nothing was saved, that somebody else changed it, and that the person is looking
 * at the new version now - because a message that said only the first would leave them retyping
 * over a change they never saw.
 */
export const ITEM_UPDATE_COPY = Object.freeze({
  editHeading: 'Change what is recorded',
  editIntro:
    'Anything you leave blank stays blank. Kynviora will not fill it in or guess, and clearing a field is a real answer.',
  reviewLabel: 'I have checked this against the pack',
  reviewHelp:
    'Records that you looked at it today. It does not confirm anything about the product - that comes from reading the pack itself.',
  reviewedNote: 'Recorded. Kynviora will stop listing this as never looked at.',
  conflictHeading: 'Somebody changed this while you had it open',
  conflictBody:
    'Nothing you typed has been saved, and what is on screen is still your version. Load theirs to see what changed, then decide what you want the record to say.',
  /**
   * The way out of a conflict, as a control rather than as an instruction.
   *
   * `13`'s policy for this entity is `ASK_USER`, and asking means offering the choice: what
   * somebody typed is not thrown away, and taking the other version is something they do rather
   * than something that happens to them. Replacing the form silently would be answering the
   * question on their behalf, which is the same failure as overwriting theirs.
   */
  conflictLoadLabel: 'Load what the record says now',
  conflictLoadHint: 'Replaces what you have typed with the version that is saved.',
  conflictLoadedNote: 'This is what the record says now. Anything you had typed has been replaced.',
  savedNote: 'Saved.',
  /**
   * Said where the form matched what is already stored.
   *
   * Not an error, and deliberately not phrased as one. Opening the form, changing nothing and
   * pressing Save is an ordinary thing to do; answering it with the panel a malformed barcode gets
   * teaches a person that this screen fails, and that is how they stop reading the panel on the
   * occasion it says something that matters.
   */
  unchangedNote: 'Nothing was different, so there was nothing to save.',
  lifecycleHeading: 'Are you still using this?',
  /**
   * Above the controls, not below them.
   *
   * `10`'s placement rule, and the same choice the Safety Receipt makes with its uncertainty list:
   * a person who has already pressed something is not reading the paragraph underneath it.
   */
  lifecycleIntro:
    'Each of these changes what Kynviora does about this item. Nothing here deletes anything, and you can change it back.',
});
