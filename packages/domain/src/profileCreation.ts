/**
 * Making a household, and the people in it.
 *
 * Spec references: `04` Phase 1.2 (household record; personal and family-member profiles; display
 * identity, date of birth/age range, language, and optional emergency information; "clear
 * distinction between account holder and managed profile"; profile switcher with persistent
 * identity context - with the exit criteria "every item created later must require a profile" and
 * "screens cannot accidentally display one profile's data under another profile identity"), `07`
 * (household membership is not permission to read a profile), `16` (data minimisation), `13`,
 * `18`, `09`.
 *
 * A PROFILE IS THE THING EVERY OTHER RECORD HANGS OFF
 * Every route in this build takes a `profileId` and every test seeds one. Nothing has ever created
 * one from a screen, which makes Phase 1.2's first exit criterion true by accident rather than by
 * construction: items require a profile because there is no way to have anything at all. This is
 * the module that lets a person make one, and the rules below are the ones that stop a profile
 * arriving in a shape a later record cannot rely on.
 *
 * A BAND, NOT A BIRTHDAY
 * `16` asks for the narrowest thing that answers the question. The MVP safety rules draw
 * paediatric, adolescent, adult and older-adult distinctions, and the age bands are exactly those
 * - so a band is enough and a date of birth is a stronger identifier than the product needs. A
 * birth **year** is separately optional for the rules that want one, and giving neither is a
 * complete answer: a person setting up a profile for a relative may not know.
 *
 * "MANAGED" IS ABOUT WHO THE PROFILE IS FOR, NOT WHO ADMINISTERS IT
 * Phase 1.2 asks for a clear distinction between the account holder and a managed profile, and the
 * schema draws it with two columns: `owner_user_id` is who controls the profile and is always the
 * creator, `self_user_id` is set only where the profile *is* that person. An older adult using
 * Kynviora directly has both; a relative's profile has an owner and no `self_user_id` until they
 * claim it. Conflating them is the mistake `isOwner` was added to `GET /v1/profiles` to remove,
 * and this module keeps them apart by making `isSelf` a claim about the creator and nobody else -
 * there is no field here that names another user, because a profile asserting that somebody else
 * was its subject would be an authorization statement written by the wrong person.
 *
 * NO EMERGENCY INFORMATION
 * `04` Phase 1.2 lists "optional emergency information" and this module has no field for it. It is
 * a name and a phone number belonging to somebody who is not a Kynviora user and never consented
 * to being in it, and `profile` is readable by every caregiver holding any viewing capability - so
 * shipping the field would disclose a third party's contact details to everyone the owner ever
 * granted `VIEW_SHELF`. `DEV-034` records what it needs first.
 */

import { domainError, err, ok, type DomainError, type Result } from './result.js';
import { isAgeBand, type AgeBand } from './vocabulary.js';

/** How long a name somebody types may be. Generous, and bounded (`14`). */
export const PROFILE_NAME_MAX = 120;
/** The same, for a household. */
export const HOUSEHOLD_NAME_MAX = 120;

/**
 * The earliest birth year Kynviora will record, and the latest.
 *
 * The same bounds as `profile_birth_year_plausible` in migration `0002`, deliberately: a year the
 * domain accepts and the database refuses arrives as a 500 rather than as a sentence naming the
 * field, which is the failure `owned_item_dates_ordered` produced before DEC-084 closed it.
 */
export const BIRTH_YEAR_MIN = 1900;
export const BIRTH_YEAR_MAX = 2100;

/**
 * The language a profile gets when nobody chose one.
 *
 * The same value as `profile.language_tag`'s column default in migration `0002`, and a test reads
 * the default out of the catalog and asserts they agree - a default that drifted would mean the
 * app rendering one language and the database recording another for the same profile.
 *
 * This is the one place in profile creation where an absence becomes a value rather than staying
 * an absence. It is a rendering choice with no safety meaning: a profile with no language is not
 * an unknown fact about a person, it is a screen with nothing to format in.
 */
export const DEFAULT_LANGUAGE_TAG = 'en-IN';

/** What somebody typed to make a household. */
export interface HouseholdDraft {
  readonly displayName: string;
}

/** What somebody typed to make a profile. */
export interface ProfileDraft {
  readonly displayName: string;
  /** One of the age bands, or absent. Absent is a complete answer. */
  readonly ageBand?: string | null | undefined;
  /** A four-digit year, as typed. Absent is a complete answer. */
  readonly birthYear?: string | null | undefined;
  /** A BCP 47 tag. Absent means the household default rather than "no language". */
  readonly languageTag?: string | null | undefined;
  /** Whether this profile is the person creating it. */
  readonly isSelf?: boolean | undefined;
}

/** A household, checked. */
export interface NormalizedHouseholdDraft {
  readonly displayName: string;
}

/** A profile, checked, with every absence made explicit. */
export interface NormalizedProfileDraft {
  readonly displayName: string;
  readonly ageBand: AgeBand | null;
  readonly birthYear: number | null;
  readonly languageTag: string | null;
  readonly isSelf: boolean;
}

/** Trimmed, or `null`. A field of spaces is not an answer. */
function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function invalid(reason: string, field: string): DomainError {
  return domainError('VALIDATION_FAILED', reason, { reason_code: 'profile_draft', field });
}

/**
 * A BCP 47 language tag, loosely.
 *
 * Two or three letters, optionally a script and a region. Not a registry lookup: there is no IANA
 * subtag database in this build, and inventing one would refuse tags that are perfectly valid.
 * What this catches is the shape that is obviously not a tag, so a stored value at least reaches a
 * formatter as something it can read.
 */
const LANGUAGE_TAG_SHAPE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

/** A four-digit year, as typed. `98` is not read as `1998`, for the reason a clock time is not. */
const BIRTH_YEAR_SHAPE = /^\d{4}$/;

/**
 * Check a household name.
 *
 * The only field, and required: `household_name_not_blank` refuses a blank one, and a household
 * nobody can name is a container in a switcher with no label.
 */
export function normalizeHouseholdDraft(
  draft: HouseholdDraft,
): Result<NormalizedHouseholdDraft, DomainError> {
  const displayName = text(draft.displayName);
  if (displayName === null) {
    return err(invalid('A household needs a name.', 'displayName'));
  }
  if (displayName.length > HOUSEHOLD_NAME_MAX) {
    return err(invalid('That name is too long.', 'displayName'));
  }
  return ok({ displayName });
}

/**
 * Check a profile draft and make its absences explicit.
 *
 * Refuses rather than repairs, like every other input path here. A band that is not a band is not
 * dropped and a year of `98` is not read as `1998`: both are things the person typed, and a value
 * Kynviora quietly altered is one they can no longer check against what they meant. The only
 * normalization is trimming, and that only ever turns something into an absence.
 */
export function normalizeProfileDraft(
  draft: ProfileDraft,
): Result<NormalizedProfileDraft, DomainError> {
  const displayName = text(draft.displayName);
  if (displayName === null) {
    // The one required field. A profile with no name is a row in a switcher nobody can identify,
    // and Phase 1.2's second exit criterion is about a person knowing whose data they are looking
    // at - which starts with the name being there.
    return err(invalid('A profile needs a name.', 'displayName'));
  }
  if (displayName.length > PROFILE_NAME_MAX) {
    return err(invalid('That name is too long.', 'displayName'));
  }

  const bandRaw = text(draft.ageBand);
  if (bandRaw !== null && !isAgeBand(bandRaw)) {
    // Refused across the line rather than dropped. A route that dropped it would accept a
    // submission and store something the person did not send, and the band is an input to the
    // paediatric rules - a silently missing one changes what Kynviora can say.
    return err(invalid('That is not an age range Kynviora offers.', 'ageBand'));
  }

  const yearRaw = text(draft.birthYear);
  let birthYear: number | null = null;
  if (yearRaw !== null) {
    if (!BIRTH_YEAR_SHAPE.test(yearRaw)) {
      return err(invalid('A year is four digits, like 1958.', 'birthYear'));
    }
    birthYear = Number(yearRaw);
    if (birthYear < BIRTH_YEAR_MIN || birthYear > BIRTH_YEAR_MAX) {
      return err(
        invalid(
          'A year is between ' + BIRTH_YEAR_MIN + ' and ' + BIRTH_YEAR_MAX + '.',
          'birthYear',
        ),
      );
    }
  }

  const languageTag = text(draft.languageTag);
  if (languageTag !== null && !LANGUAGE_TAG_SHAPE.test(languageTag)) {
    return err(invalid('A language looks like en-IN.', 'languageTag'));
  }

  return ok({
    displayName,
    ageBand: bandRaw,
    birthYear,
    languageTag,
    // Absent is `false`: a profile is somebody else's unless the person says otherwise. Deny by
    // default (`14`) applied to a claim about identity - `self_user_id` is what makes a profile
    // survive its owner closing their account, and asserting it by accident is not something the
    // person it was asserted about can undo.
    isSelf: draft.isSelf === true,
  });
}

/**
 * Whether a birth year and an age band could describe the same person, given the current year.
 *
 * `true` where either is absent - two facts cannot disagree when only one was given - and this is
 * deliberately **not** part of {@link normalizeProfileDraft}. A person who knows a relative was
 * born in 1958 and picks the wrong band has made a correctable mistake, and refusing the whole
 * submission over it would lose the rest of what they typed. The screen asks; the record accepts
 * what they confirm.
 *
 * `currentYear` is passed rather than read, for DEC-024's reason: a domain function that read the
 * clock would give a different answer on replay.
 */
export function bandMatchesBirthYear(
  band: AgeBand | null,
  birthYear: number | null,
  currentYear: number,
): boolean {
  if (band === null || birthYear === null) return true;
  const age = currentYear - birthYear;
  switch (band) {
    case 'UNDER_3':
      return age >= 0 && age < 3;
    case 'CHILD_3_12':
      return age >= 3 && age <= 12;
    case 'TEEN_13_17':
      return age >= 13 && age <= 17;
    case 'ADULT_18_64':
      return age >= 18 && age <= 64;
    case 'OLDER_ADULT_65_PLUS':
      return age >= 65;
  }
}
