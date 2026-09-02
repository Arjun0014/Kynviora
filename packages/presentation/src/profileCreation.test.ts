import { describe, it, expect } from 'vitest';
import { AGE_BANDS } from '@kynviora/domain';
import {
  AGE_BAND_PRESENTATION,
  ALL_PROFILE_CREATION_STRINGS,
  HOUSEHOLD_COPY,
  PROFILE_COPY,
  PROFILE_LIMITS_COPY,
  ageBandOptions,
  presentAgeBand,
} from './profileCreation.js';

/**
 * The words on the first screen anybody sees.
 *
 * Every other surface needs a profile and none of them can make one, so this is the only screen a
 * person meets with nothing on it - and it has to explain what it is asking for with no fact about
 * a medicine to hang the explanation on.
 */

describe('the age bands', () => {
  it('has wording for every band the vocabulary has', () => {
    // Trap 109: a vocabulary that grew a member with no wording shipped a blank line where a
    // sentence belonged. A band added later fails here rather than reaching a form unlabelled.
    for (const band of AGE_BANDS) {
      const presented = presentAgeBand(band);
      expect(presented.band, band).toBe(band);
      expect(presented.label.length, band).toBeGreaterThan(0);
      expect(presented.description.length, band).toBeGreaterThan(0);
    }
    expect(Object.keys(AGE_BAND_PRESENTATION).sort()).toEqual([...AGE_BANDS].sort());
  });

  it('offers them in the vocabulary’s order', () => {
    // Youngest first, which is the order the schema lists them in and the order a person reads a
    // range in. Not sorted by anything the copy decides.
    expect(ageBandOptions().map((option) => option.band)).toEqual([...AGE_BANDS]);
  });

  it('never shows a band as its code', () => {
    for (const option of ageBandOptions()) {
      expect(option.label, option.band).not.toBe(option.band);
      expect(option.label, option.band).not.toMatch(/_/);
    }
  });

  it('says what each band lets Kynviora notice, not what to do about it', () => {
    // `09`. An age range beside somebody's medicine must never become advice about taking it.
    for (const option of ageBandOptions()) {
      expect(option.description, option.band).not.toMatch(
        /you should|we recommend|do not give|stop taking|is safe|is not safe|ask your doctor/i,
      );
    }
  });
});

describe('the household form', () => {
  it('says what a household is before asking for a name', () => {
    expect(HOUSEHOLD_COPY.intro).toMatch(/records live/i);
    expect(HOUSEHOLD_COPY.intro).toMatch(/add more at any time/i);
  });

  it('says the name is not health information', () => {
    // `16`. The first thing Kynviora ever asks for, and a person is entitled to know it is a
    // label rather than a disclosure.
    expect(HOUSEHOLD_COPY.privacyNote).toMatch(/not shared/i);
    expect(HOUSEHOLD_COPY.privacyNote).toMatch(/says nothing about anyone/i);
  });
});

describe('the profile form', () => {
  it('draws the account-holder distinction without the schema’s word', () => {
    // `04` Phase 1.2 asks for a clear distinction. "Managed" would make somebody wonder what
    // Kynviora thinks about their mother; "someone I look after" is the same fact in the words
    // they already use.
    expect(PROFILE_COPY.selfLabel).toBe('This is me');
    expect(PROFILE_COPY.otherLabel).toMatch(/look after/i);
    for (const sentence of ALL_PROFILE_CREATION_STRINGS) {
      expect(sentence, sentence).not.toMatch(/managed profile|is_managed/i);
    }
  });

  it('says a managed profile can be taken over later', () => {
    // The other half of the distinction: `self_user_id` is null until the person claims it, and a
    // screen that did not say so would look like a permanent judgement about who somebody is.
    expect(PROFILE_COPY.otherHelp).toMatch(/take it over later/i);
  });

  it('says why an age range is asked for, and that leaving it out costs nothing', () => {
    // `16`. The second sentence is what makes the field genuinely optional rather than nominally
    // so - "optional" with no consequence stated reads as "required, but we will let you off".
    expect(PROFILE_COPY.ageHelp).toMatch(/says something different/i);
    expect(PROFILE_COPY.ageHelp).toMatch(/leave it out/i);
    expect(PROFILE_COPY.ageHelp).toMatch(/nothing else changes/i);
    expect(PROFILE_COPY.ageSkipLabel).toMatch(/rather not say/i);
  });

  it('says why a range rather than a date of birth', () => {
    expect(PROFILE_COPY.privacyNote).toMatch(/rather than a date of birth/i);
    expect(PROFILE_COPY.privacyNote).toMatch(/enough for everything it does/i);
  });

  it('says the format for a year it will refuse rather than repair', () => {
    // The domain refuses `58`. The field says four digits before somebody types, so the refusal
    // is a correction rather than a surprise.
    expect(PROFILE_COPY.yearHelp).toMatch(/four digits/i);
    expect(PROFILE_COPY.yearHelp).toMatch(/1958/);
  });

  it('asks about a mismatched age and year rather than refusing the form', () => {
    // The domain agrees: `bandMatchesBirthYear` is deliberately not part of the validation.
    // Refusing would throw away the rest of what somebody typed over a correctable mistake.
    expect(PROFILE_COPY.ageMismatchNote).toMatch(/both will be saved/i);
    expect(PROFILE_COPY.ageMismatchNote).toMatch(/have a look/i);
    expect(PROFILE_COPY.ageMismatchNote).not.toMatch(/cannot|refused|invalid/i);
  });
});

describe('what these forms admit they do not do', () => {
  it('says Kynviora holds no emergency contact', () => {
    // `04` Phase 1.2 lists optional emergency information and this build has none (`DEV-034`). A
    // form that asked for everything else and silently omitted it would leave somebody assuming
    // Kynviora holds one - the kind of thing only discovered at the worst moment (`10`).
    expect(PROFILE_LIMITS_COPY.noEmergencyContact).toMatch(/does not hold emergency contact/i);
    expect(PROFILE_LIMITS_COPY.noEmergencyContact).toMatch(/somewhere else/i);
  });
});

describe('every sentence on these screens', () => {
  it('never tells anybody what to do about a medicine', () => {
    // `09`, over the whole module including the band descriptions.
    for (const sentence of ALL_PROFILE_CREATION_STRINGS) {
      expect(sentence, sentence).not.toMatch(
        /you should take|we recommend|stop taking|keep taking|talk to your doctor|is safe to/i,
      );
    }
  });

  it('never promises something this build does not do', () => {
    // `10`. The one claim that would be false is an emergency contact, and the limits copy states
    // the opposite - so no sentence here may imply Kynviora will reach anybody.
    for (const sentence of ALL_PROFILE_CREATION_STRINGS) {
      expect(sentence, sentence).not.toMatch(/we will call|contact them|alert your|notify your/i);
    }
  });

  it('has a label for every control it describes', () => {
    // `18`: a label is always present. A help sentence with no label beside it is a screen a
    // screen reader announces as an unnamed text field.
    for (const [label, help] of [
      [HOUSEHOLD_COPY.nameLabel, HOUSEHOLD_COPY.nameHelp],
      [PROFILE_COPY.nameLabel, PROFILE_COPY.nameHelp],
      [PROFILE_COPY.ageLabel, PROFILE_COPY.ageHelp],
      [PROFILE_COPY.yearLabel, PROFILE_COPY.yearHelp],
      [PROFILE_COPY.languageLabel, PROFILE_COPY.languageHelp],
      [PROFILE_COPY.selfLabel, PROFILE_COPY.selfHelp],
      [PROFILE_COPY.otherLabel, PROFILE_COPY.otherHelp],
    ] as const) {
      expect(label.length, label).toBeGreaterThan(0);
      expect(help.length, label).toBeGreaterThan(0);
    }
  });
});
