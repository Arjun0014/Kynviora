import { describe, it, expect } from 'vitest';
import { CONSENT_PURPOSES, consentEnforcement } from '@kynviora/domain';
import {
  ALL_CONSENT_STRINGS,
  CONSENT_COPY,
  CONSENT_PRESENTATION,
  consentPurposeOptions,
  presentConsentPurpose,
} from './consent.js';

/**
 * The words on the consent screen.
 *
 * The sentence that carries the most weight is the one saying withdrawing notifications stops a
 * critical alert too. The next is the one admitting five of the eight switches stop nothing.
 */

describe('the purposes', () => {
  it('has wording for every purpose the vocabulary has', () => {
    // Trap 109: a vocabulary that grew a member with no wording shipped a blank line where a
    // sentence belonged - here that would be an unlabelled switch on a consent screen.
    for (const purpose of CONSENT_PURPOSES) {
      const presented = presentConsentPurpose(purpose);
      expect(presented.label.length, purpose).toBeGreaterThan(0);
      expect(presented.description.length, purpose).toBeGreaterThan(0);
      expect(presented.withdrawalEffect.length, purpose).toBeGreaterThan(0);
    }
    expect(Object.keys(CONSENT_PRESENTATION).sort()).toEqual([...CONSENT_PURPOSES].sort());
  });

  it('never shows a purpose as its code', () => {
    for (const option of consentPurposeOptions()) {
      expect(option.label, option.purpose).not.toBe(option.purpose);
      expect(option.label, option.purpose).not.toMatch(/_/);
    }
  });

  it('says what withdrawing each one stops, matching what the code actually does', () => {
    // The copy and the enforcement are checked against each other, so a purpose that becomes
    // enforceable fails here rather than shipping with a sentence saying nothing happens.
    for (const purpose of CONSENT_PURPOSES) {
      const effect = presentConsentPurpose(purpose).withdrawalEffect;
      if (consentEnforcement(purpose) === 'NOTHING_TO_STOP') {
        expect(effect, purpose).toMatch(/nothing changes yet/i);
      } else {
        expect(effect, purpose).not.toMatch(/nothing changes yet/i);
      }
    }
  });
});

describe('the one that stops a critical alert', () => {
  it('says so, and says it plainly', () => {
    // Quiet hours let a critical safety alert through; consent does not, because consent is the
    // basis on which Kynviora may contact somebody at all. A person who believed a recall would
    // still reach them would find out on the night it mattered.
    const effect = presentConsentPurpose('NOTIFICATIONS').withdrawalEffect;
    expect(effect).toMatch(/nothing will be sent/i);
    expect(effect).toMatch(/including a critical safety alert/i);
  });

  it('says what still happens, so turning it off is not a leap in the dark', () => {
    // `10` cuts both ways: the limit *and* what remains true. Records are still kept and waiting.
    expect(presentConsentPurpose('NOTIFICATIONS').withdrawalEffect).toMatch(/still recorded/i);
  });
});

describe('the one about other people', () => {
  it('is precise about the half it does not do', () => {
    // Stopping notifications is not removing access, and a sentence that implied otherwise would
    // leave somebody believing they had cut off a caregiver they had not.
    const effect = presentConsentPurpose('CAREGIVER_SHARING').withdrawalEffect;
    expect(effect).toMatch(/stop being sent/i);
    expect(effect).toMatch(/can still see/i);
    // And it says where the other control is, rather than leaving them looking.
    expect(effect).toMatch(/care screen/i);
  });
});

describe('the five that stop nothing', () => {
  it('admits it rather than implying otherwise', () => {
    // `10`. Somebody who turned off "analytics" believing they had stopped something would have
    // been told a comforting untruth by a switch.
    expect(CONSENT_COPY.notYetNote).toMatch(/does not do this at all/i);
    // And says the answer is not thrown away, so recording it is not pointless.
    expect(CONSENT_COPY.notYetNote).toMatch(/recorded and will apply/i);
  });

  it('says why the required one is not a choice', () => {
    expect(presentConsentPurpose('PROFILE_DATA').withdrawalEffect).toMatch(/cannot work without/i);
    // And what the person would actually need instead, rather than only refusing.
    expect(presentConsentPurpose('PROFILE_DATA').withdrawalEffect).toMatch(/not built yet/i);
  });
});

describe('what the screen admits it does not have', () => {
  it('offers a copy, and says what the copy leaves out before it is taken', () => {
    // `16` asks an export to show what will be included, and the harder half of that is what will
    // not. A person checks a copy once, so an absent section discovered inside the file reads as
    // "there was nothing" rather than "this was not included".
    expect(CONSENT_COPY.exportLabel).toMatch(/copy/i);
    expect(CONSENT_COPY.exportOmissionsNote).toMatch(/names what is not in it/i);
    expect(CONSENT_COPY.exportOmissionsNote).toMatch(/named rather than copied/i);
  });

  it('still says account deletion is not built, and points at the deletion that is', () => {
    // A settings row that opens nothing is worse than no row: it tells somebody a control exists.
    // "Not built yet" over both halves would now be false in the other direction, which sends
    // somebody looking for a control they have already walked past (DEC-117).
    expect(CONSENT_COPY.deletionNote).toMatch(/not built yet/i);
    expect(CONSENT_COPY.deletionNote).toMatch(/button that does nothing/i);
    expect(CONSENT_COPY.deletionNote).toMatch(/delete any single medicine or product/i);
  });

  it('says an unanswered purpose is treated as not agreed', () => {
    // Deny by default, said out loud rather than left for somebody to discover.
    expect(CONSENT_COPY.neverAnsweredNote).toMatch(/not agreed/i);
  });

  it('says a stale answer changes nothing for the person', () => {
    // `16` asks for consent state to be localizable and auditable, not for a nag. "Have a look
    // when you have a moment" is information; a red banner would be pressure to re-agree.
    expect(CONSENT_COPY.staleNote).toMatch(/nothing has changed for you/i);
    expect(CONSENT_COPY.staleNote).not.toMatch(/must|required|action/i);
  });
});

describe('every sentence on this screen', () => {
  it('never argues for agreeing', () => {
    // A consent screen that persuades is a consent screen that has stopped asking. No sentence
    // recommends granting, describes a withdrawal as a loss, or promises a better experience.
    for (const sentence of ALL_CONSENT_STRINGS) {
      expect(sentence, sentence).not.toMatch(
        /we recommend|for the best|you will miss|recommended|please agree|keep this on|turning this off is not/i,
      );
    }
  });

  it('never tells anybody what to do about a medicine', () => {
    for (const sentence of ALL_CONSENT_STRINGS) {
      expect(sentence, sentence).not.toMatch(
        /you should take|stop taking|keep taking|talk to your doctor|is safe to/i,
      );
    }
  });

  it('says the record of what was chosen is kept', () => {
    // The "auditable" half of the exit criterion, in the words a person reads.
    expect(CONSENT_COPY.intro).toMatch(/record of what you chose and when/i);
    expect(CONSENT_COPY.intro).toMatch(/change any of them/i);
  });
});
