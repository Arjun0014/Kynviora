import { describe, it, expect } from 'vitest';
import {
  emptyProfileForm,
  profileBodyFrom,
  profileFormRefusal,
  profileSwitcherView,
  type ProfileFormValues,
} from './profileCreation.js';
import type { ProfileSummary } from './client.js';

/**
 * `04` Phase 1.2's client half.
 *
 * The switcher carries an exit criterion - "screens cannot accidentally display one profile's data
 * under another profile identity" - and the failure it prevents is silent: somebody reads their
 * mother's medicine list under their own name and nothing on the screen says otherwise.
 */

function form(overrides: Partial<ProfileFormValues> = {}): ProfileFormValues {
  return { ...emptyProfileForm(), displayName: 'Amma', ...overrides };
}

function profile(overrides: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id: 'p1',
    householdId: 'h1',
    displayName: 'Amma',
    ageBand: 'OLDER_ADULT_65_PLUS',
    isManaged: true,
    isOwner: true,
    ...overrides,
  };
}

describe('the form', () => {
  it('starts with nothing filled in', () => {
    // Nothing here has a safe default. An age band prefilled to "18 to 64" would be a fact about
    // somebody that nobody stated.
    expect(emptyProfileForm()).toEqual({
      displayName: '',
      ageBand: '',
      birthYear: '',
      languageTag: '',
      isSelf: false,
    });
  });

  it('sends an absence as an absence, not as an empty string', () => {
    const body = profileBodyFrom('h1', form());
    expect(body).toEqual({
      householdId: 'h1',
      displayName: 'Amma',
      ageBand: null,
      birthYear: null,
      languageTag: null,
      isSelf: false,
    });
  });

  it('sends what was filled in', () => {
    const body = profileBodyFrom('h1', {
      displayName: '  Amma  ',
      ageBand: 'OLDER_ADULT_65_PLUS',
      birthYear: '1958',
      languageTag: 'ml-IN',
      isSelf: true,
    });
    expect(body.ageBand).toBe('OLDER_ADULT_65_PLUS');
    expect(body.birthYear).toBe('1958');
    expect(body.languageTag).toBe('ml-IN');
    expect(body.isSelf).toBe(true);
  });

  it('carries no field naming anybody else', () => {
    // The absence is the enforcement, at the layer that builds the request. A body that could
    // name another user as the subject would be an authorization statement written by the wrong
    // person, and `self_user_id` is unique - so it would take a name they could never claim.
    const body = profileBodyFrom('h1', form({ isSelf: true }));
    expect(Object.keys(body).sort()).toEqual([
      'ageBand',
      'birthYear',
      'displayName',
      'householdId',
      'isSelf',
      'languageTag',
    ]);
  });
});

describe('what the form refuses before it is sent', () => {
  it('accepts a name and nothing else', () => {
    expect(profileFormRefusal(form())).toBeNull();
  });

  it('names the field for a missing name', () => {
    const refusal = profileFormRefusal(form({ displayName: '   ' }));
    expect(refusal?.field).toBe('displayName');
    expect(refusal?.message).toMatch(/needs a name/i);
  });

  it('names the field for a year it would have to guess at', () => {
    // The domain's answer, not a second copy of the rules. A screen re-implementing them would be
    // a second place for them to drift from what the server actually accepts.
    const refusal = profileFormRefusal(form({ birthYear: '58' }));
    expect(refusal?.field).toBe('birthYear');
  });

  it('names the field for a band it does not know', () => {
    const refusal = profileFormRefusal(form({ ageBand: 'SENIOR' }));
    expect(refusal?.field).toBe('ageBand');
  });

  it('does not refuse an age range that disagrees with the year', () => {
    // A correctable mistake, not a refusal. Refusing would throw away the rest of what somebody
    // typed - the domain agrees, and `bandMatchesBirthYear` is deliberately not part of it.
    expect(profileFormRefusal(form({ ageBand: 'UNDER_3', birthYear: '1958' }))).toBeNull();
  });
});

describe('the switcher', () => {
  it('reports the selection the server still offers', () => {
    const view = profileSwitcherView(
      [profile(), profile({ id: 'p2', displayName: 'Achan' })],
      'p2',
    );
    expect(view.activeId).toBe('p2');
    expect(view.activeName).toBe('Achan');
    expect(view.selectionDropped).toBe(false);
    expect(view.lines.map((line) => line.isActive)).toEqual([false, true]);
  });

  it('drops a selection the server no longer offers, rather than moving to another', () => {
    // The exit criterion, at the moment it is decided. A caregiver grant can be revoked between
    // launches, and falling back to the first profile is how a screen ends up showing one
    // person's medicines under another person's name with the heading unchanged.
    const view = profileSwitcherView([profile()], 'gone');
    expect(view.activeId).toBeNull();
    expect(view.activeName).toBeNull();
    expect(view.selectionDropped).toBe(true);
    expect(view.lines.every((line) => !line.isActive)).toBe(true);
  });

  it('never selects anything on its own', () => {
    // No selection is a real state and this view will not resolve it. Choosing is the caller's,
    // because a default chosen here would be invisible on every screen that renders it.
    const view = profileSwitcherView([profile(), profile({ id: 'p2' })], null);
    expect(view.activeId).toBeNull();
    expect(view.selectionDropped).toBe(false);
  });

  it('offers the active profile’s household to add somebody to', () => {
    // Adding a second person adds them beside the first. A screen that created a household every
    // time would leave a family split across two, and nothing in this build merges them.
    const view = profileSwitcherView([profile(), profile({ id: 'p2', householdId: 'h2' })], 'p2');
    expect(view.addToHouseholdId).toBe('h2');
  });

  it('offers a household even when nothing is selected', () => {
    // "Add someone" has to work before a selection exists, and every profile in the list is one
    // the server already admitted.
    expect(profileSwitcherView([profile()], null).addToHouseholdId).toBe('h1');
    expect(profileSwitcherView([profile()], 'gone').addToHouseholdId).toBe('h1');
  });

  it('offers no household where there is not one yet', () => {
    // The only case that genuinely needs a household created first.
    expect(profileSwitcherView([], null).addToHouseholdId).toBeNull();
    expect(
      profileSwitcherView([{ ...profile(), householdId: '' }], null).addToHouseholdId,
    ).toBeNull();
  });

  it('tells an empty list apart from a dropped selection', () => {
    // The first is somebody who has not set up yet and needs the creation screen; the second is
    // somebody whose access changed and needs telling. One screen for both would invite a person
    // to make a second profile for somebody who already has one.
    const empty = profileSwitcherView([], null);
    expect(empty.isEmpty).toBe(true);
    expect(empty.selectionDropped).toBe(false);

    const dropped = profileSwitcherView([profile()], 'gone');
    expect(dropped.isEmpty).toBe(false);
    expect(dropped.selectionDropped).toBe(true);
  });

  it('reads whose profile it is from the right column', () => {
    // `isManaged` is about the person the profile is for; `isOwner` is about authority. Reading
    // one as the other produced a caregiver-invite screen offering the wrong capabilities.
    const mine = profileSwitcherView([profile({ isManaged: false, isOwner: true })], null).lines[0];
    expect(mine?.isSelf).toBe(true);
    expect(mine?.isOwner).toBe(true);

    const theirs = profileSwitcherView([profile({ isManaged: true, isOwner: false })], null)
      .lines[0];
    expect(theirs?.isSelf).toBe(false);
    expect(theirs?.isOwner).toBe(false);
  });

  it('shows an age band as a phrase, or not at all', () => {
    // Trap 129: a code beside somebody's medicine is a field value, not a phrase. An unreadable
    // band loses a line of detail; a rendered one puts `OLDER_ADULT_65_PLUS` in front of them.
    expect(profileSwitcherView([profile()], null).lines[0]?.ageLabel).toBe('65 or older');
    for (const band of [null, 'SENIOR', '', 'older_adult_65_plus']) {
      const line = profileSwitcherView([profile({ ageBand: band })], null).lines[0];
      expect(line?.ageLabel, String(band)).toBeNull();
    }
  });

  it('survives a response that carries no profiles at all', () => {
    const view = profileSwitcherView(undefined as unknown as readonly ProfileSummary[], 'anything');
    expect(view.lines).toEqual([]);
    expect(view.isEmpty).toBe(true);
    // A selection was asked for and cannot be honoured, which is still a dropped selection.
    expect(view.selectionDropped).toBe(true);
  });

  it('drops a row with no usable identifier rather than rendering it', () => {
    // A row a screen could select but never send is a control that does nothing.
    const view = profileSwitcherView(
      [profile(), { ...profile(), id: '' }, { ...profile(), id: 42 as unknown as string }],
      null,
    );
    expect(view.lines).toHaveLength(1);
  });
});
