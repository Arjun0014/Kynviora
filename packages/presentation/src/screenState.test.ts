import { describe, it, expect } from 'vitest';
import {
  SCREEN_STATES,
  SCREEN_STATE_PRESENTATION,
  ALL_SCREEN_STATE_STRINGS,
  everyScreenStatePresented,
  presentScreenState,
  screenStateAccessibilityLabel,
  screenStateColors,
  type ScreenState,
} from './screenState.js';
import { findForbiddenClaims } from './copy.js';
import { ICON_NAMES } from './status.js';
import { LIGHT_THEME, contrastRatio } from './tokens.js';

/**
 * The states a screen can be in, and the words a user reads in each.
 *
 * These strings only existed inside a React component before, where `apps/**` is excluded from
 * the test run and no renderer is available (`BLK-002`) - so they were the one family of
 * user-visible copy in the codebase that no scan looked at. That is what this file is for.
 */

describe('the state union', () => {
  it('covers every state spec 06 requires a route to define', () => {
    // "loading, empty, success, partial/insufficient data, offline, permission denied,
    // recoverable error, authorization lost, stale data, corrected/superseded."
    for (const required of [
      'LOADING',
      'READY',
      'EMPTY',
      'PARTIAL',
      'OFFLINE',
      'STALE',
      'AUTHORIZATION_LOST',
      'RECOVERABLE_ERROR',
    ] satisfies ScreenState[]) {
      expect(SCREEN_STATES).toContain(required);
    }
  });

  it('presents every member', () => {
    expect(everyScreenStatePresented()).toBe(true);
    expect(Object.keys(SCREEN_STATE_PRESENTATION).sort()).toEqual([...SCREEN_STATES].sort());
  });

  it('gives every state a visible label and a real icon', () => {
    for (const state of SCREEN_STATES) {
      const presentation = presentScreenState(state);
      // `18`: meaning is never carried by colour or an icon alone, so a label is not optional.
      expect(presentation.label.trim().length).toBeGreaterThan(0);
      expect(presentation.description.trim().length).toBeGreaterThan(0);
      expect(ICON_NAMES).toContain(presentation.iconName);
    }
  });

  it('announces the label before the description', () => {
    const announced = screenStateAccessibilityLabel('OFFLINE');
    expect(announced.indexOf('No connection')).toBeLessThan(announced.indexOf('could not reach'));
  });
});

describe('the words', () => {
  it('makes no forbidden claim', () => {
    for (const text of ALL_SCREEN_STATE_STRINGS) {
      expect(findForbiddenClaims(text)).toEqual([]);
    }
  });

  it('never blames the user', () => {
    // `18` forbids shaming. "You did not", "you failed", "you forgot" are the phrasings that
    // creep into error copy first.
    for (const text of ALL_SCREEN_STATE_STRINGS) {
      expect(text.toLowerCase()).not.toMatch(/you (failed|forgot|did not|didn't|should have)/);
    }
  });

  it('does not promise saved data in the offline state', () => {
    // The state that means "the check did not happen" must not describe a local cache. There is
    // no cache behind these screens yet, so on a first load the sentence would describe data the
    // user is not looking at - and even with one, a claim about saved content belongs on the
    // state that is actually showing it.
    const offline = presentScreenState('OFFLINE');
    expect(offline.description).not.toMatch(/saved|stored|last seen|on this device/i);
    expect(offline.showsContent).toBe(false);

    // STALE is the state that may describe older content, and it still does not claim a
    // storage location: the same words have to be true for a refetch that failed and for a
    // local store, and the user does not need to know which one they are looking at.
    const stale = presentScreenState('STALE');
    expect(stale.description).toMatch(/earlier/i);
    expect(stale.description).not.toMatch(/saved|stored/i);
    expect(stale.showsContent).toBe(true);
  });

  it('offers a retry only where retrying could change the answer', () => {
    // A "Try again" that cannot work teaches the user the button does nothing, which costs them
    // the one case where it would have helped.
    expect(presentScreenState('OFFLINE').retryLabel).not.toBeNull();
    expect(presentScreenState('RECOVERABLE_ERROR').retryLabel).not.toBeNull();
    expect(presentScreenState('STALE').retryLabel).not.toBeNull();

    expect(presentScreenState('LOADING').retryLabel).toBeNull();
    expect(presentScreenState('EMPTY').retryLabel).toBeNull();
    expect(presentScreenState('UNAVAILABLE').retryLabel).toBeNull();
    expect(presentScreenState('AUTHORIZATION_LOST').retryLabel).toBeNull();
    expect(presentScreenState('STEP_UP_REQUIRED').retryLabel).toBeNull();
  });
});

describe('the unavailable state is not an existence oracle', () => {
  it('has no state anywhere in the union that means "refused"', () => {
    // The API answers PERMISSION_DENIED with 404 precisely so a caller cannot learn that a
    // resource exists (`19`; trap 14). A screen that renders that 404 as "you do not have
    // permission to see this" hands back the fact the status code was chosen to withhold - and
    // does it in the place a person actually reads. The absence of the state is the guarantee.
    for (const state of SCREEN_STATES) {
      expect(state).not.toMatch(/DENIED|FORBIDDEN|REFUSED|NO_ACCESS/);
    }
  });

  it('words absence as absence, never as refusal', () => {
    const unavailable = presentScreenState('UNAVAILABLE');
    for (const text of [unavailable.label, unavailable.description]) {
      expect(text.toLowerCase()).not.toMatch(
        /permission|not allowed|denied|forbidden|no access|not authoris|not authoriz/,
      );
    }
  });

  it('reads the same as the empty state to a user', () => {
    // Both mean "there is nothing for you here", which is the whole point: a caller must not be
    // able to tell "this profile has no items" from "this profile is not yours" by reading the
    // screen either.
    const unavailable = presentScreenState('UNAVAILABLE');
    const empty = presentScreenState('EMPTY');
    expect(unavailable.tone).toBe(empty.tone);
    expect(unavailable.showsContent).toBe(empty.showsContent);
    expect(unavailable.retryLabel).toBe(empty.retryLabel);
  });
});

describe('tone', () => {
  it('uses a calm tone for states that are not failures', () => {
    // `02` and `18` require a product that does not optimise for alarm. Being offline, or having
    // nothing on a screen, is not an emergency.
    for (const state of ['LOADING', 'EMPTY', 'OFFLINE', 'UNAVAILABLE', 'READY'] as const) {
      expect(presentScreenState(state).tone).toBe('surfaceMuted');
    }
  });

  it('never uses the action tone', () => {
    // `action` is reserved for safety content that asks a person to do something. A failed fetch
    // is not that, and borrowing the tone would make an infrastructure problem look like a
    // medicine problem.
    for (const state of SCREEN_STATES) {
      expect(presentScreenState(state).tone).not.toBe('action');
    }
  });

  it('meets the contrast floor in every state', () => {
    for (const state of SCREEN_STATES) {
      const colors = screenStateColors(state);
      // 4.5:1, the WCAG AA floor for body text, at the sizes this copy is actually rendered.
      expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
      expect(Object.values(LIGHT_THEME)).toContain(colors);
    }
  });
});
