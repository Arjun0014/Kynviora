/**
 * Setting up a household, and adding the people in it, in words.
 *
 * Spec references: `04` Phase 1.2 (household record; personal and family-member profiles; display
 * identity, date of birth/age range, language; "clear distinction between account holder and
 * managed profile"; profile switcher - with the exit criteria "every item created later must
 * require a profile" and "screens cannot accidentally display one profile's data under another
 * profile identity"), `16` (data minimisation), `18` (familiar words first, one idea per sentence,
 * a label is always present), `10`, `09`, `02`.
 *
 * THIS IS THE FIRST SCREEN ANYBODY SEES
 * Every other surface in this build needs a profile and none of them can make one. That makes this
 * the only screen a person meets with nothing on it, which is a specific obligation: it has to say
 * what it is asking for and why, without a single fact about a medicine to hang the explanation
 * on.
 *
 * EVERY OPTIONAL FIELD SAYS WHY IT IS BEING ASKED FOR
 * `16` asks for the narrowest thing that answers the question, and a person handing over a
 * relative's age has a right to know what it does. Each optional field below carries the reason
 * Kynviora wants it and what happens if it is left out - and "nothing is lost" is the honest
 * answer for all of them, because none of them is required for a record to exist.
 *
 * "MANAGED" IS NEVER SAID TO A PERSON
 * The schema calls it `is_managed` and the screen calls it "someone you look after". A person
 * setting up a profile for their mother is not administering a managed entity, and the word would
 * make them wonder what else Kynviora thinks about her.
 */

import type { AgeBand } from '@kynviora/domain';
import { AGE_BANDS } from '@kynviora/domain';

// ---------------------------------------------------------------------------
// The age bands, as phrases
// ---------------------------------------------------------------------------

export interface AgeBandPresentation {
  readonly band: AgeBand;
  /** The control's label. */
  readonly label: string;
  /** What choosing it lets Kynviora do, said in terms of the person rather than of the rules. */
  readonly description: string;
}

/**
 * One entry per band. A total record, so a band added later is copy somebody writes.
 *
 * Trap 109's lesson: a vocabulary that grew a member with no wording shipped a blank line where a
 * sentence belonged. A test loops {@link AGE_BANDS} against this.
 */
export const AGE_BAND_PRESENTATION: Readonly<Record<AgeBand, AgeBandPresentation>> = Object.freeze({
  UNDER_3: {
    band: 'UNDER_3',
    label: 'Under 3',
    description:
      'Many medicines say something different for a child this young, and some say not to give them at all.',
  },
  CHILD_3_12: {
    band: 'CHILD_3_12',
    label: '3 to 12',
    description: 'Children this age often have their own dose, separate from an adult one.',
  },
  TEEN_13_17: {
    band: 'TEEN_13_17',
    label: '13 to 17',
    description: 'A few medicines are still restricted below 18, and Kynviora can point that out.',
  },
  ADULT_18_64: {
    band: 'ADULT_18_64',
    label: '18 to 64',
    description: 'The ordinary adult wording applies.',
  },
  OLDER_ADULT_65_PLUS: {
    band: 'OLDER_ADULT_65_PLUS',
    label: '65 or older',
    description:
      'Some medicines carry a separate note for older adults, and Kynviora can show it when it is there.',
  },
});

export function presentAgeBand(band: AgeBand): AgeBandPresentation {
  return AGE_BAND_PRESENTATION[band];
}

/** Every band as a phrase, in the vocabulary's order, for a screen that offers all of them. */
export function ageBandOptions(): readonly AgeBandPresentation[] {
  return AGE_BANDS.map((band) => AGE_BAND_PRESENTATION[band]);
}

// ---------------------------------------------------------------------------
// The words on the two forms
// ---------------------------------------------------------------------------

export const HOUSEHOLD_COPY = Object.freeze({
  heading: 'Set up your household',
  intro:
    'A household is the place your family’s records live. You will add the people in it next, and you can add more at any time.',
  nameLabel: 'What do you want to call it?',
  nameHelp: 'Anything you will recognise, like “Home” or your family name.',
  saveLabel: 'Create household',
  /** `16`. A household name is not health information, and saying so removes a worry. */
  privacyNote:
    'This name is only a label. It is not shared with anyone and it says nothing about anyone’s health.',
});

export const PROFILE_COPY = Object.freeze({
  heading: 'Who is this for?',
  intro:
    'Kynviora keeps each person’s medicines and products separate, so nothing gets mixed up between them.',

  nameLabel: 'Name',
  nameHelp: 'Whatever you call them. It is only ever shown to you and to people you invite.',

  /**
   * The account-holder distinction, as a question rather than as a system word.
   *
   * `04` Phase 1.2 asks for a clear distinction between the account holder and a managed profile.
   * "Managed" is the schema's word and would make somebody wonder what Kynviora thinks about their
   * mother; "someone you look after" is the same fact in the words a person already uses.
   */
  selfLabel: 'This is me',
  selfHelp: 'Choose this for your own medicines and products.',
  otherLabel: 'Someone I look after',
  otherHelp:
    'A child, a parent, anyone whose medicines you keep track of. They can take it over later if they start using Kynviora themselves.',

  ageLabel: 'Roughly how old are they?',
  /**
   * Why the band is asked for, and that skipping it costs nothing.
   *
   * `16`: a person handing over a relative's age has a right to know what it does. The second
   * sentence is the one that makes the field genuinely optional rather than nominally so.
   */
  ageHelp:
    'Kynviora uses this to notice when a medicine says something different for someone that age. You can leave it out, and nothing else changes.',
  ageSkipLabel: 'Rather not say',

  yearLabel: 'Year they were born',
  yearHelp:
    'Only if you know it and want to give it. A few medicines set their limits by year rather than by age range. Four digits, like 1958.',

  languageLabel: 'Language',
  languageHelp: 'What Kynviora shows this person’s information in.',

  saveLabel: 'Add this person',

  /**
   * Said where a band and a year do not describe the same person.
   *
   * A question, not a refusal. Somebody who knows their mother was born in 1958 and taps the wrong
   * band has made a correctable mistake, and refusing the whole form over it would throw away the
   * rest of what they typed. The domain agrees: `bandMatchesBirthYear` is deliberately not part of
   * the validation.
   */
  ageMismatchNote:
    'The age range and the year do not look like the same person. Both will be saved as you entered them - have a look before you go on.',

  /** `16` again, at the point where somebody is about to enter another person's details. */
  privacyNote:
    'Kynviora asks for an age range rather than a date of birth, because a range is enough for everything it does.',
});

/**
 * What Kynviora cannot do here yet, said on the screen that would otherwise imply it can.
 *
 * `04` Phase 1.2 lists optional emergency information among its expected output and this build has
 * no field for it (`DEV-034`). A form that asked for everything else and silently omitted it would
 * leave somebody assuming Kynviora holds an emergency contact - which is exactly the thing they
 * would only find out was untrue at the worst moment. It is stated rather than left out.
 */
export const PROFILE_LIMITS_COPY = Object.freeze({
  noEmergencyContact:
    'Kynviora does not hold emergency contact details yet. If you need someone reachable in an emergency, keep that somewhere else as well.',
});

/** Every sentence these forms can put on a screen, for the copy scans. */
export const ALL_PROFILE_CREATION_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(HOUSEHOLD_COPY),
  ...Object.values(PROFILE_COPY),
  ...Object.values(PROFILE_LIMITS_COPY),
  ...ageBandOptions().flatMap((option) => [option.label, option.description]),
]);
