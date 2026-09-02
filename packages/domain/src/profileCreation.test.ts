import { describe, it, expect } from 'vitest';
import {
  AGE_BANDS,
  BIRTH_YEAR_MAX,
  BIRTH_YEAR_MIN,
  HOUSEHOLD_NAME_MAX,
  PROFILE_NAME_MAX,
  bandMatchesBirthYear,
  isAgeBand,
  normalizeHouseholdDraft,
  normalizeProfileDraft,
} from './index.js';

/**
 * `04` Phase 1.2 - the people model every other record hangs off.
 *
 * The rules that matter here are the ones a later record relies on: a profile always has a name,
 * an age band is one of a closed set or absent, and "this profile is me" is never true by
 * accident.
 */

describe('naming a household', () => {
  it('takes a name', () => {
    const result = normalizeHouseholdDraft({ displayName: '  The Nair household  ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.displayName).toBe('The Nair household');
  });

  it('refuses a blank name, and names the field', () => {
    // `household_name_not_blank` refuses the same thing. Without a domain rule the refusal would
    // arrive as a 500 rather than as a sentence pointing at the field to fix.
    for (const name of ['', '   ', '\t\n']) {
      const result = normalizeHouseholdDraft({ displayName: name });
      expect(result.ok, JSON.stringify(name)).toBe(false);
      if (!result.ok) {
        expect(result.error.detail?.['field']).toBe('displayName');
        expect(result.error.detail?.['reason_code']).toBe('profile_draft');
      }
    }
  });

  it('refuses a name longer than it will store', () => {
    const result = normalizeHouseholdDraft({ displayName: 'x'.repeat(HOUSEHOLD_NAME_MAX + 1) });
    expect(result.ok).toBe(false);
  });
});

describe('making a profile', () => {
  it('needs a name and nothing else', () => {
    // The whole point of the optional fields being optional. A person setting up a profile for a
    // relative may know their name and nothing more, and that is a complete record.
    const result = normalizeProfileDraft({ displayName: 'Amma' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      displayName: 'Amma',
      ageBand: null,
      birthYear: null,
      languageTag: null,
      isSelf: false,
    });
  });

  it('refuses a blank name, and names the field', () => {
    const result = normalizeProfileDraft({ displayName: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail?.['field']).toBe('displayName');
  });

  it('refuses a name longer than it will store', () => {
    const result = normalizeProfileDraft({ displayName: 'x'.repeat(PROFILE_NAME_MAX + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail?.['field']).toBe('displayName');
  });

  it('turns every blank optional field into an absence rather than an empty string', () => {
    // `16` and the same rule manual entry keeps: what is not entered is absent, never defaulted
    // and never stored as a value that renders as one.
    const result = normalizeProfileDraft({
      displayName: 'Amma',
      ageBand: '  ',
      birthYear: '',
      languageTag: '   ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ageBand).toBeNull();
    expect(result.value.birthYear).toBeNull();
    expect(result.value.languageTag).toBeNull();
  });
});

describe('the age band', () => {
  it('accepts every band the vocabulary offers', () => {
    for (const band of AGE_BANDS) {
      const result = normalizeProfileDraft({ displayName: 'Amma', ageBand: band });
      expect(result.ok, band).toBe(true);
      if (result.ok) expect(result.value.ageBand, band).toBe(band);
    }
  });

  it('refuses a band it does not know, rather than dropping it', () => {
    // Dropping it would accept a submission and store something the person did not send, and the
    // band is an input to the paediatric rules - a silently missing one changes what Kynviora can
    // say about a medicine.
    for (const band of ['ADULT', 'under_3', 'OLDER_ADULT', 'SENIOR']) {
      const result = normalizeProfileDraft({ displayName: 'Amma', ageBand: band });
      expect(result.ok, band).toBe(false);
      if (!result.ok) expect(result.error.detail?.['field'], band).toBe('ageBand');
    }
  });

  it('agrees with the constraint the database enforces', () => {
    // A band the domain offers and the database refuses is a form somebody fills in and cannot
    // submit. The list here is migration `0002`'s `profile_age_band_valid`, transcribed.
    const inSchema = ['UNDER_3', 'CHILD_3_12', 'TEEN_13_17', 'ADULT_18_64', 'OLDER_ADULT_65_PLUS'];
    expect([...AGE_BANDS]).toEqual(inSchema);
    for (const band of inSchema) expect(isAgeBand(band), band).toBe(true);
  });
});

describe('the birth year', () => {
  it('reads a four-digit year', () => {
    const result = normalizeProfileDraft({ displayName: 'Amma', birthYear: ' 1958 ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.birthYear).toBe(1958);
  });

  it('refuses a year it would have to guess at', () => {
    // `58` is not read as `1958`, for the reason `9:5` is not read as `09:05` (DEC-085): a value
    // Kynviora reinterpreted is one the person cannot check against what they meant.
    for (const year of ['58', '019 58', '1958-01-01', 'nineteen fifty eight', '19588']) {
      const result = normalizeProfileDraft({ displayName: 'Amma', birthYear: year });
      expect(result.ok, year).toBe(false);
      if (!result.ok) expect(result.error.detail?.['field'], year).toBe('birthYear');
    }
  });

  it('keeps the bounds the database keeps', () => {
    // `profile_birth_year_plausible` refuses the same range. Without this the refusal arrives as a
    // 500 rather than as a sentence naming the field - the failure DEC-084 closed for item dates.
    for (const year of [BIRTH_YEAR_MIN, BIRTH_YEAR_MAX]) {
      const inside = normalizeProfileDraft({ displayName: 'Amma', birthYear: String(year) });
      expect(inside.ok, String(year)).toBe(true);
    }
    for (const year of [BIRTH_YEAR_MIN - 1, BIRTH_YEAR_MAX + 1]) {
      const outside = normalizeProfileDraft({ displayName: 'Amma', birthYear: String(year) });
      expect(outside.ok, String(year)).toBe(false);
    }
  });
});

describe('the language', () => {
  it('takes a tag a formatter can read', () => {
    for (const tag of ['en', 'en-IN', 'ml', 'ml-IN', 'zh-Hans-CN', 'es-419']) {
      const result = normalizeProfileDraft({ displayName: 'Amma', languageTag: tag });
      expect(result.ok, tag).toBe(true);
      if (result.ok) expect(result.value.languageTag, tag).toBe(tag);
    }
  });

  it('refuses something that is obviously not a tag', () => {
    for (const tag of ['English', 'en_IN', 'e', '1234', 'en-in-extra-parts']) {
      const result = normalizeProfileDraft({ displayName: 'Amma', languageTag: tag });
      expect(result.ok, tag).toBe(false);
      if (!result.ok) expect(result.error.detail?.['field'], tag).toBe('languageTag');
    }
  });
});

describe('whether this profile is the person making it', () => {
  it('is false unless they said so', () => {
    // Deny by default (`14`) applied to a claim about identity. `self_user_id` is unique and
    // survives the owner's account, so asserting it by accident is not something the person it was
    // asserted about can undo.
    for (const draft of [
      { displayName: 'Amma' },
      { displayName: 'Amma', isSelf: undefined },
      { displayName: 'Amma', isSelf: false },
    ]) {
      const result = normalizeProfileDraft(draft);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.isSelf).toBe(false);
    }
  });

  it('is true only for the exact boolean', () => {
    const yes = normalizeProfileDraft({ displayName: 'Me', isSelf: true });
    expect(yes.ok).toBe(true);
    if (yes.ok) expect(yes.value.isSelf).toBe(true);

    // Not a string, not a number, not "on". A truthy value arriving over the wire must not become
    // an identity claim.
    const truthy = normalizeProfileDraft({
      displayName: 'Me',
      isSelf: 'true' as unknown as boolean,
    });
    expect(truthy.ok).toBe(true);
    if (truthy.ok) expect(truthy.value.isSelf).toBe(false);
  });

  it('has no way to name anybody else as the subject', () => {
    // The absence is the enforcement. A profile asserting that some other user is its subject
    // would be an authorization statement written by the wrong person.
    const result = normalizeProfileDraft({
      displayName: 'Amma',
      selfUserId: 'some-other-user',
    } as unknown as Parameters<typeof normalizeProfileDraft>[0]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.value)).not.toContain('some-other-user');
  });
});

describe('whether a band and a year could be the same person', () => {
  const YEAR = 2026;

  it('agrees where they agree', () => {
    for (const [band, birthYear] of [
      ['UNDER_3', 2025],
      ['CHILD_3_12', 2018],
      ['TEEN_13_17', 2010],
      ['ADULT_18_64', 1990],
      ['OLDER_ADULT_65_PLUS', 1958],
    ] as const) {
      expect(bandMatchesBirthYear(band, birthYear, YEAR), band).toBe(true);
    }
  });

  it('disagrees where they disagree', () => {
    expect(bandMatchesBirthYear('UNDER_3', 1958, YEAR)).toBe(false);
    expect(bandMatchesBirthYear('OLDER_ADULT_65_PLUS', 2020, YEAR)).toBe(false);
    expect(bandMatchesBirthYear('CHILD_3_12', 2026, YEAR)).toBe(false);
  });

  it('cannot disagree when only one was given', () => {
    expect(bandMatchesBirthYear(null, 1958, YEAR)).toBe(true);
    expect(bandMatchesBirthYear('ADULT_18_64', null, YEAR)).toBe(true);
    expect(bandMatchesBirthYear(null, null, YEAR)).toBe(true);
  });

  it('covers every band, so a new one fails rather than silently matching', () => {
    // A band added to the vocabulary with no arm here is a compile error, and this asserts the
    // runtime half: every member answers, and answering is not the same as agreeing.
    for (const band of AGE_BANDS) {
      const answers = [1900, 1958, 1990, 2010, 2018, 2025].map((year) =>
        bandMatchesBirthYear(band, year, YEAR),
      );
      expect(
        answers.some((answer) => answer),
        band,
      ).toBe(true);
      expect(
        answers.some((answer) => !answer),
        band,
      ).toBe(true);
    }
  });

  it('does not read the clock', () => {
    // DEC-024: a domain function that read the clock would give a different answer on replay.
    // The same band and year answer differently in different years, and that is the caller's
    // input rather than a hidden dependency.
    expect(bandMatchesBirthYear('OLDER_ADULT_65_PLUS', 1958, 2026)).toBe(true);
    expect(bandMatchesBirthYear('OLDER_ADULT_65_PLUS', 1958, 2010)).toBe(false);
  });
});
