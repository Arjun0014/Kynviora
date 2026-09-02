import { describe, it, expect } from 'vitest';
import { FACT_CERTAINTIES, HEALTH_FACT_KINDS, HOUSEHOLD_FACT_PROVENANCE } from '@kynviora/domain';
import {
  ALL_HEALTH_CONTEXT_STRINGS,
  CERTAINTY_PRESENTATION,
  HEALTH_CONTEXT_COPY,
  HEALTH_FACT_KIND_PRESENTATION,
  certaintyOptions,
  healthFactKindOptions,
  presentCertainty,
  presentHealthFactKind,
  presentProvenance,
} from './healthContext.js';

/**
 * The words on the only screen that asks for health information.
 *
 * Two sentences carry the weight: the one saying Kynviora cannot yet check anything against an
 * unmatched term, and the one that keeps "you are sure" apart from "a clinician said so".
 */

describe('the two kinds', () => {
  it('has wording for every kind the vocabulary has', () => {
    // Trap 109: a vocabulary that grew a member with no wording shipped a blank line where a
    // sentence belonged.
    for (const kind of HEALTH_FACT_KINDS) {
      const presented = presentHealthFactKind(kind);
      expect(presented.label.length, kind).toBeGreaterThan(0);
      expect(presented.description.length, kind).toBeGreaterThan(0);
    }
    expect(Object.keys(HEALTH_FACT_KIND_PRESENTATION).sort()).toEqual(
      [...HEALTH_FACT_KINDS].sort(),
    );
  });

  it('describes them as different things rather than as degrees of one', () => {
    // "I get a rash from this" and "this puts me in hospital" are different sentences. A screen
    // offering only "allergy" would collect the first under the second's name.
    expect(presentHealthFactKind('ALLERGY').description).toMatch(/serious|avoid/i);
    expect(presentHealthFactKind('SENSITIVITY').description).toMatch(/disagrees with you/i);
  });

  it('never shows a kind as its code', () => {
    for (const option of healthFactKindOptions()) {
      expect(option.label, option.kind).not.toBe(option.kind);
    }
  });
});

describe('how sure the person is', () => {
  it('has wording for every certainty the vocabulary has', () => {
    for (const certainty of FACT_CERTAINTIES) {
      const presented = presentCertainty(certainty);
      expect(presented.label.length, certainty).toBeGreaterThan(0);
      expect(presented.description.length, certainty).toBeGreaterThan(0);
    }
    expect(Object.keys(CERTAINTY_PRESENTATION).sort()).toEqual([...FACT_CERTAINTIES].sort());
  });

  it('phrases every option as the person’s own knowledge', () => {
    // The exit criterion in the copy. "Confirmed" says the person is sure; it must never read as
    // a clinician having said so, which is why each description names how they know.
    for (const option of certaintyOptions()) {
      expect(option.label, option.certainty).toMatch(/^I /);
      expect(option.description, option.certainty).toMatch(/you/i);
    }
  });

  it('never claims a clinician was involved', () => {
    for (const sentence of ALL_HEALTH_CONTEXT_STRINGS) {
      expect(sentence, sentence).not.toMatch(
        /diagnos|your doctor said|clinically confirmed|medically confirmed|prescriber/i,
      );
    }
  });

  it('says the record is the person’s own account whichever they pick', () => {
    expect(HEALTH_CONTEXT_COPY.certaintyHelp).toMatch(/your own account/i);
  });
});

describe('where a fact came from', () => {
  it('has a sentence for every provenance a household surface produces', () => {
    for (const provenance of HOUSEHOLD_FACT_PROVENANCE) {
      expect(presentProvenance(provenance), provenance).not.toBeNull();
    }
  });

  it('has one for the two it cannot produce, so an imported record is not a blank', () => {
    expect(presentProvenance('IMPORTED')).not.toBeNull();
    expect(presentProvenance('REVIEWER_CONFIRMED')).not.toBeNull();
  });

  it('returns nothing rather than a code it cannot read', () => {
    // Trap 129: a provenance beside somebody's allergy is a field value, not a phrase.
    for (const unknown of ['PACKAGE_OCR', 'SOMETHING_NEW', '', 'user_reported']) {
      expect(presentProvenance(unknown), unknown).toBeNull();
    }
  });

  it('says who put the record there, never how good it is', () => {
    // None of these is a judgement about the record's worth. A screen that ranked them would be
    // scoring somebody's account of their own body.
    for (const provenance of ['USER_REPORTED', 'CAREGIVER_ENTERED', 'IMPORTED']) {
      const sentence = presentProvenance(provenance);
      expect(sentence, provenance).not.toBeNull();
      expect(sentence ?? '', provenance).not.toMatch(/reliable|unreliable|weak|strong|unverified/i);
    }
  });
});

describe('what Kynviora says it cannot do with a record', () => {
  it('says an unmatched term is not being checked, and is not lost', () => {
    // `10`, on the record itself rather than in a footnote. A person typing "penicillin" has every
    // reason to assume it is checked against everything they own; discovering otherwise through an
    // alert that never arrives is the failure this sentence prevents.
    expect(HEALTH_CONTEXT_COPY.notMatchedNote).toMatch(/cannot check/i);
    expect(HEALTH_CONTEXT_COPY.notMatchedNote).toMatch(/not lost/i);
  });

  it('says plainly when it can', () => {
    expect(HEALTH_CONTEXT_COPY.matchedNote).toMatch(/can check/i);
  });

  it('states the review date as a fact rather than as a nag', () => {
    // `02`: no pressure, no count, no overdue badge. "Nobody has checked this" is information;
    // "please review 3 items" is the alarm optimisation the product refuses.
    expect(HEALTH_CONTEXT_COPY.neverReviewedNote).toMatch(/nobody has checked/i);
    for (const sentence of ALL_HEALTH_CONTEXT_STRINGS) {
      expect(sentence, sentence).not.toMatch(
        /overdue|out of date|you must review|action required/i,
      );
    }
  });
});

describe('every sentence on this screen', () => {
  it('never tells anybody what to do about a medicine', () => {
    // `09`. A recorded allergy is something somebody told Kynviora, and the copy around it must
    // not become advice.
    for (const sentence of ALL_HEALTH_CONTEXT_STRINGS) {
      expect(sentence, sentence).not.toMatch(
        /you should|we recommend|stop taking|keep taking|talk to your|is safe|is not safe|avoid this product/i,
      );
    }
  });

  it('says what Kynviora keeps and why, before asking for it', () => {
    // `16`. The only health information the product asks for, and the person is told that.
    expect(HEALTH_CONTEXT_COPY.intro).toMatch(/only health information/i);
    expect(HEALTH_CONTEXT_COPY.intro).toMatch(/point out/i);
  });

  it('has a label for every control it describes', () => {
    // `18`: a label is always present.
    for (const [label, help] of [
      [HEALTH_CONTEXT_COPY.termLabel, HEALTH_CONTEXT_COPY.termHelp],
      [HEALTH_CONTEXT_COPY.certaintyLabel, HEALTH_CONTEXT_COPY.certaintyHelp],
      [HEALTH_CONTEXT_COPY.notedOnLabel, HEALTH_CONTEXT_COPY.notedOnHelp],
    ] as const) {
      expect(label.length, label).toBeGreaterThan(0);
      expect(help.length, label).toBeGreaterThan(0);
    }
  });

  it('tells a conflict apart from a save that changed nothing', () => {
    // Two different things that both mean "nothing was saved", and a screen that said the same
    // sentence for both would teach people to ignore the one that matters.
    expect(HEALTH_CONTEXT_COPY.conflictNote).toMatch(/changed somewhere else/i);
    expect(HEALTH_CONTEXT_COPY.conflictNote).toMatch(/nothing you typed has been saved/i);
    expect(HEALTH_CONTEXT_COPY.unchangedNote).toMatch(/nothing was changed/i);
    expect(HEALTH_CONTEXT_COPY.unchangedNote).not.toMatch(/changed somewhere else/i);
  });
});
