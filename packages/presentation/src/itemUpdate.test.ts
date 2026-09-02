import { describe, it, expect } from 'vitest';
import { ITEM_LIFECYCLE_STATES } from '@kynviora/domain';
import {
  ALL_LIFECYCLE_STRINGS,
  ITEM_UPDATE_COPY,
  lifecycleAction,
  lifecycleActions,
} from './itemUpdate.js';

/**
 * The words on the one screen where somebody turns part of Kynviora off.
 *
 * Archiving stops the safety watch. That is a consequence a person cannot see and would not
 * guess, and the whole point of these assertions is that no state can ever be described without
 * saying what Kynviora stops doing about it.
 */

describe('every state says what Kynviora stops doing', () => {
  it('has a description and a stops sentence for every member of the vocabulary', () => {
    // A loop over the whole vocabulary rather than three named cases. A state added later fails
    // here rather than shipping with a blank line where the consequence should be - which is how
    // trap 109 was found on the Safety Receipt, by a test and not by review.
    for (const state of ITEM_LIFECYCLE_STATES) {
      const action = lifecycleAction(state);
      expect(action.label.length, state).toBeGreaterThan(0);
      expect(action.description.length, state).toBeGreaterThan(0);
      expect(action.stops.length, state).toBeGreaterThan(0);
      expect(action.accessibilityHint.length, state).toBeGreaterThan(0);
    }
  });

  it('says out loud that archiving turns the safety watch off', () => {
    // The safety inbox filters on `lifecycle_state <> 'ARCHIVED'`. Somebody who archived a
    // medicine believing Kynviora would still tell them about a recall would be relying on it for
    // something it had stopped doing.
    const archived = lifecycleAction('ARCHIVED');
    expect(archived.stops).toMatch(/recall/i);
    expect(archived.accessibilityHint).toMatch(/safety watch/i);
  });

  it('says that stopping does not turn the safety watch off', () => {
    // The other half, and the one a person is more likely to get wrong: a stopped medicine is
    // still watched. Only archiving is not.
    const stopped = lifecycleAction('STOPPED');
    expect(stopped.stops).toMatch(/still tells you about recalls/i);
  });

  it('promises nothing is deleted, on both of the states that sound like it', () => {
    for (const state of ['STOPPED', 'ARCHIVED'] as const) {
      const action = lifecycleAction(state);
      expect(`${action.description} ${action.stops}`, state).toMatch(
        /stays on the record|nothing about it is deleted/i,
      );
    }
  });
});

describe('what the controls offer', () => {
  it('leaves out the state the item is already in', () => {
    // Absent rather than shown selected. A control that does nothing is one a person presses and
    // then wonders about (DEC-045, applied to a choice rather than to a permission).
    for (const state of ITEM_LIFECYCLE_STATES) {
      const offered = lifecycleActions(state).map((action) => action.state);
      expect(offered, state).not.toContain(state);
      expect(offered.length, state).toBe(ITEM_LIFECYCLE_STATES.length - 1);
    }
  });

  it('offers a way back into use from every state that is out of use', () => {
    // Nothing here is one-way. A person who archived something by mistake and could not undo it
    // would have lost a record Kynviora is meant to be keeping for them. An item already in use
    // has no way back to offer, which is why the loop skips it rather than the assertion being
    // written over the whole vocabulary.
    for (const state of ITEM_LIFECYCLE_STATES.filter((s) => s !== 'ACTIVE')) {
      expect(
        lifecycleActions(state).map((a) => a.state),
        state,
      ).toContain('ACTIVE');
    }
  });
});

describe('nothing here is a judgement about a medicine', () => {
  it('never tells anybody to start or stop taking something', () => {
    // `09`. The labels are what a person did, not what Kynviora thinks they should do.
    for (const sentence of ALL_LIFECYCLE_STRINGS) {
      expect(sentence, sentence).not.toMatch(
        /you should|we recommend|it is safe|it is not safe|stop taking|keep taking|talk to your/i,
      );
    }
  });

  it('phrases the labels as something the person did', () => {
    expect(lifecycleAction('STOPPED').label).toMatch(/^I have stopped/);
    expect(lifecycleAction('ACTIVE').label).toMatch(/^I am using/);
  });

  it('does not describe marking something looked at as confirming it', () => {
    // `08` reserves confirmation for something read off the pack. A person who thought pressing
    // this had verified the product would have a Trust Passport that means less than they think.
    expect(ITEM_UPDATE_COPY.reviewHelp).toMatch(/does not confirm/i);
  });
});

describe('a save that changed nothing', () => {
  it('is not phrased as a failure', () => {
    // Opening the form, changing nothing and pressing Save is an ordinary thing to do. Answering
    // it with the panel a malformed barcode gets teaches a person that this screen fails, and
    // that is how they stop reading the panel on the occasion it says something that matters.
    expect(ITEM_UPDATE_COPY.unchangedNote).not.toMatch(
      /error|failed|could not|invalid|sorry|problem/i,
    );
    expect(ITEM_UPDATE_COPY.unchangedNote).toMatch(/nothing to save/i);
  });
});

describe('the conflict message', () => {
  it('says nothing was saved, who changed it, and what is on screen', () => {
    // `13`'s `ASK_USER` policy on a screen. A message that said only "that did not save" would
    // leave somebody retyping over a change they never saw - and one that claimed the screen had
    // already updated would be describing a form that still holds what they typed.
    const body = `${ITEM_UPDATE_COPY.conflictHeading} ${ITEM_UPDATE_COPY.conflictBody}`;
    expect(body).toMatch(/nothing you typed has been saved/i);
    expect(body).toMatch(/somebody changed this/i);
    expect(body).toMatch(/still your version/i);
  });

  it('offers taking the other version as a choice rather than doing it', () => {
    // Asking means offering the choice. Replacing the form silently would answer the question on
    // the person's behalf, which is the same failure as overwriting somebody else's change.
    expect(ITEM_UPDATE_COPY.conflictLoadLabel.length).toBeGreaterThan(0);
    // And the control says what it costs before it is pressed, not after.
    expect(ITEM_UPDATE_COPY.conflictLoadHint).toMatch(/replaces what you have typed/i);
  });

  it('never discards what somebody typed without saying so', () => {
    expect(ITEM_UPDATE_COPY.conflictLoadedNote).toMatch(/replaced/i);
  });

  it('does not name who changed it', () => {
    // The same rule the Safety Receipt keeps (DEC-076): a caregiver's identity is on the
    // caregiver-audit screen and not attached to a record somebody is editing.
    expect(ITEM_UPDATE_COPY.conflictBody).not.toMatch(/your daughter|caregiver|they are called/i);
  });
});
