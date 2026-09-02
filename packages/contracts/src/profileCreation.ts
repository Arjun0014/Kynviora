/**
 * The form that makes a person, and the switcher that says whose data is on screen.
 *
 * Spec references: `04` Phase 1.2 (household and profile creation; profile switcher with
 * persistent identity context - with the exit criteria "every item created later must require a
 * profile" and "screens cannot accidentally display one profile's data under another profile
 * identity"), `13` ("never trust a profile ID in the request as proof of access"), `14`, `16`,
 * `18`.
 *
 * THE SWITCHER IS AN EXIT CRITERION, NOT A CONVENIENCE
 * "Screens cannot accidentally display one profile's data under another profile identity" is a
 * property of what is on the screen, and the only place it can be decided once is here. A screen
 * that read `profiles.find(...)` for itself would be one more place to get it wrong, and the
 * failure is silent: somebody reads their mother's medicine list under their own name and there is
 * nothing on the screen that says otherwise.
 *
 * So {@link profileSwitcherView} answers three separate questions - which profile is selected,
 * whether the selection is still one the server offers, and what to say when it is not - and a
 * selection the server no longer offers becomes **no selection**, never a silently different one.
 * A caregiver grant can be revoked between launches, and the alternative is the screen quietly
 * moving to somebody else's profile with the heading unchanged.
 *
 * WHAT "PERSISTENT IDENTITY CONTEXT" DOES AND DOES NOT MEAN HERE
 * Phase 1.2 asks for a persistent one. It persists for the session and is re-derived from the
 * server's list on every launch rather than stored on the device (DEC-087). A stored selection
 * that outlived a revoked grant is exactly the code path `13` forbids, and there is no way for a
 * client to know a grant has gone without asking.
 */

import { isAgeBand, normalizeProfileDraft } from '@kynviora/domain';
import { presentAgeBand } from '@kynviora/presentation';
import type { ProfileBody, ProfileSummary } from './client.js';

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/**
 * What the profile form holds, keyed as a screen keys it.
 *
 * Every value is a string because that is what a text field holds, `isSelf` excepted - it is a
 * choice between two labelled options rather than something typed, and the domain refuses anything
 * that is not the exact boolean.
 */
export interface ProfileFormValues {
  readonly displayName: string;
  readonly ageBand: string;
  readonly birthYear: string;
  readonly languageTag: string;
  readonly isSelf: boolean;
}

/** An empty form. Nothing is prefilled, because nothing here has a safe default. */
export function emptyProfileForm(): ProfileFormValues {
  return { displayName: '', ageBand: '', birthYear: '', languageTag: '', isSelf: false };
}

/**
 * The body for a form.
 *
 * A blank field becomes `null` rather than an empty string: `16`'s "what is not entered is absent"
 * on the wire, and the route's schema would take `''` and the domain would turn it into `null`
 * anyway - sending it would only make the request describe something nobody typed.
 */
export function profileBodyFrom(householdId: string, values: ProfileFormValues): ProfileBody {
  const orNull = (value: string): string | null => {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };

  return {
    householdId,
    displayName: values.displayName,
    ageBand: orNull(values.ageBand),
    birthYear: orNull(values.birthYear),
    languageTag: orNull(values.languageTag),
    isSelf: values.isSelf,
  };
}

/**
 * Whether the form as it stands would be accepted, and what to say if not.
 *
 * The domain's answer, not a second copy of the rules. A screen that re-implemented "a name is
 * required" would be a second place for it to drift, and the field name in the refusal is what
 * lets the form point at the control rather than showing a sentence at the bottom.
 */
export function profileFormRefusal(
  values: ProfileFormValues,
): { readonly message: string; readonly field: string } | null {
  const result = normalizeProfileDraft({
    displayName: values.displayName,
    ageBand: values.ageBand,
    birthYear: values.birthYear,
    languageTag: values.languageTag,
    isSelf: values.isSelf,
  });
  if (result.ok) return null;

  const field = result.error.detail?.['field'];
  return { message: result.error.reason, field: typeof field === 'string' ? field : '' };
}

// ---------------------------------------------------------------------------
// The switcher
// ---------------------------------------------------------------------------

export interface ProfileSwitcherLine {
  readonly id: string;
  /** The household this profile is in, so adding somebody adds them beside this person. */
  readonly householdId: string;
  readonly displayName: string;
  /** The age band as a phrase, or `null` where none is recorded or this build cannot read it. */
  readonly ageLabel: string | null;
  /** Whether this is the caller's own profile rather than one they look after. */
  readonly isSelf: boolean;
  readonly isOwner: boolean;
  readonly isActive: boolean;
}

export interface ProfileSwitcherView {
  readonly lines: readonly ProfileSwitcherLine[];
  /** The selected profile, or `null`. Never a different one than was asked for. */
  readonly activeId: string | null;
  readonly activeName: string | null;
  /**
   * The household to add somebody to, or `null` where there is none to add to yet.
   *
   * The active profile's household where there is a selection, and otherwise the first profile's -
   * because "add someone" needs a household even when nobody is selected, and every profile this
   * caller can see is one the server already admitted. `null` only where the list is empty, which
   * is the case that genuinely needs a household created first.
   */
  readonly addToHouseholdId: string | null;
  /**
   * The server offered no profile at all.
   *
   * Distinct from "one was asked for and is gone": the first is somebody who has not set up yet
   * and needs the creation screen, the second is somebody whose access changed and needs to be
   * told. A screen that showed the same thing for both would invite a person to make a second
   * profile for a person who already has one.
   */
  readonly isEmpty: boolean;
  /**
   * A selection was asked for and the server does not offer it.
   *
   * `true` means the view dropped it. The screen says so rather than moving quietly to whoever is
   * first - "screens cannot accidentally display one profile's data under another profile
   * identity" is about exactly this moment.
   */
  readonly selectionDropped: boolean;
}

/**
 * The switcher, and which profile a screen is entitled to render under.
 *
 * `requested` is what the app currently has selected. It is honoured only if the server's list
 * still contains it; otherwise the view reports no selection and says it dropped one. Nothing here
 * falls back to the first profile - a fallback is how a screen ends up showing one person's
 * medicines under another person's name, and the whole point of this function is that it cannot.
 */
export function profileSwitcherView(
  profiles: readonly ProfileSummary[],
  requested: string | null,
): ProfileSwitcherView {
  const known = (profiles ?? []).filter(
    (profile) => typeof profile?.id === 'string' && profile.id !== '',
  );
  const match = requested === null ? null : (known.find((p) => p.id === requested) ?? null);

  const activeId = match === null ? null : match.id;

  return {
    lines: known.map((profile) => ({
      id: profile.id,
      householdId: profile.householdId,
      displayName: profile.displayName,
      ageLabel: ageLabelFor(profile.ageBand),
      // `isManaged` is about the person the profile is for; `isOwner` is about authority. Reading
      // one as the other produced a caregiver-invite screen offering the wrong capabilities, and
      // the switcher is where a person would notice the same confusion first.
      isSelf: profile.isManaged === false,
      isOwner: profile.isOwner === true,
      isActive: profile.id === activeId,
    })),
    activeId,
    activeName: match === null ? null : match.displayName,
    addToHouseholdId: householdOf(match) ?? householdOf(known[0] ?? null),
    isEmpty: known.length === 0,
    selectionDropped: requested !== null && match === null,
  };
}

/** A household ID, where the row carries a usable one. */
function householdOf(profile: ProfileSummary | null): string | null {
  if (profile === null) return null;
  return typeof profile.householdId === 'string' && profile.householdId !== ''
    ? profile.householdId
    : null;
}

/** A band as a phrase, or `null`. Never the code, and never a guess (trap 129). */
function ageLabelFor(band: string | null): string | null {
  if (band === null || !isAgeBand(band)) return null;
  return presentAgeBand(band).label;
}
