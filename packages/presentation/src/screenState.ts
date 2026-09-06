/**
 * Screen states, as a closed union with its own copy.
 *
 * Spec references: `06` ("Every critical route must define: loading, empty, success,
 * partial/insufficient data, offline, permission denied, recoverable error, authorization lost,
 * stale data, corrected/superseded"), `12` (client error classes), `18` (plain language, no
 * shaming, no fear-driven phrasing), `24` (UX done criteria).
 *
 * WHY THIS IS HERE RATHER THAN IN THE REACT COMPONENT
 * It began as a `ScreenStateKind` union and a copy table inside `apps/mobile`. Vitest excludes
 * `apps/**` - there is no device and no React renderer available (`BLK-002`) - so every string a
 * user would actually read on a failed request sat outside the safety-copy scan that every other
 * user-visible string in this codebase passes through. Moving the union and its words here puts
 * them under `findForbiddenClaims` and under the exhaustiveness tests, and leaves the component
 * as a renderer.
 *
 * OFFLINE AND STALE ARE NOT THE SAME STATE
 * The original offline copy read "This shows what Kynviora last saved on this device", which is a
 * claim about a local cache. There is no cache behind these screens yet, so on an offline first
 * load that sentence described data the user was not looking at. The two states are now separate
 * and say only what is true of each: `OFFLINE` means the check did not happen and there is
 * nothing on screen, `STALE` means something older is on screen and could not be refreshed.
 * Neither names where the content came from, because the answer differs between a failed refetch
 * and a local store and the user does not need to know which. `18` requires Kynviora to be honest
 * about what it does not know, and a reassuring sentence about saved data the user does not have
 * is the exact failure that rule exists to prevent.
 */

import { LIGHT_THEME, type ColorPair, type Theme, type ThemeToneToken } from './tokens.js';
import type { IconName } from './status.js';

/**
 * Every state a data-bearing screen can be in.
 *
 * A closed union, so a screen cannot quietly ship with only a success path: a `switch` over this
 * must handle each member or it fails to compile.
 */
export const SCREEN_STATES = [
  'LOADING',
  'READY',
  'EMPTY',
  'PARTIAL',
  'OFFLINE',
  'STALE',
  'UNAUTHENTICATED',
  'AUTHORIZATION_LOST',
  'STEP_UP_REQUIRED',
  'RECOVERABLE_ERROR',
  'UNAVAILABLE',
] as const;
export type ScreenState = (typeof SCREEN_STATES)[number];

export interface ScreenStatePresentation {
  /** Short visible text. Always rendered - never replaced by a spinner or a colour. */
  readonly label: string;
  /** Plain-language explanation shown beneath the label. */
  readonly description: string;
  /** Supporting tone only. `18` forbids colour as the sole carrier of meaning. */
  readonly tone: ThemeToneToken;
  readonly iconName: IconName;
  /**
   * Label for a retry control, or `null` where retrying cannot help.
   *
   * Offering "Try again" on a state a retry cannot change teaches a user that the button does
   * nothing, which costs them the one case where it would have worked.
   */
  readonly retryLabel: string | null;
  /**
   * Whether the screen may still show data underneath this state.
   *
   * `STALE` and `PARTIAL` annotate content; every other state replaces it. A screen that renders
   * a failure banner *over* a list the user can still read has told them something useful; one
   * that renders it over data it has already discarded has not.
   */
  readonly showsContent: boolean;
}

/**
 * Copy per state.
 *
 * Plain language, one idea per sentence, and never blaming the user. `18` requires familiar words
 * first and forbids shaming or fear-driven phrasing; `12` requires each error class to say what
 * the user can do next, which is why several of these end with an action rather than a diagnosis.
 */
export const SCREEN_STATE_PRESENTATION: Readonly<Record<ScreenState, ScreenStatePresentation>> =
  Object.freeze({
    LOADING: Object.freeze({
      label: 'Loading',
      description: 'Getting this from Kynviora.',
      tone: 'surfaceMuted' as const,
      iconName: 'clock' as const,
      retryLabel: null,
      showsContent: false,
    }),

    READY: Object.freeze({
      label: 'Up to date',
      description: 'This is what Kynviora has right now.',
      tone: 'surfaceMuted' as const,
      iconName: 'check-circle' as const,
      retryLabel: null,
      showsContent: true,
    }),

    EMPTY: Object.freeze({
      label: 'Nothing here yet',
      description: 'There is nothing to show on this screen at the moment.',
      tone: 'surfaceMuted' as const,
      iconName: 'info-circle' as const,
      retryLabel: null,
      showsContent: false,
    }),

    PARTIAL: Object.freeze({
      label: 'Some information is missing',
      description: 'What is shown here may be incomplete. Kynviora could not get all of it.',
      tone: 'attention' as const,
      iconName: 'question-circle' as const,
      retryLabel: 'Try again',
      showsContent: true,
    }),

    OFFLINE: Object.freeze({
      label: 'No connection',
      // Says only what is true: the check did not happen. It does not promise saved data,
      // because on a first load there is none. See the module note.
      description: 'Kynviora could not reach the internet, so it could not check this.',
      tone: 'surfaceMuted' as const,
      iconName: 'eye-off' as const,
      retryLabel: 'Try again',
      showsContent: false,
    }),

    STALE: Object.freeze({
      label: 'Checked earlier',
      // Says what is true of the content actually on screen: it was fetched at some earlier
      // point and the refresh did not happen. True whether it came from a refetch that failed or
      // from a local store, which is why it does not name where it came from.
      description: 'Kynviora showed this earlier and could not check it again just now.',
      tone: 'attention' as const,
      iconName: 'clock' as const,
      retryLabel: 'Check again',
      showsContent: true,
    }),

    UNAUTHENTICATED: Object.freeze({
      label: 'Not signed in',
      description: 'Sign in to see this.',
      tone: 'informational' as const,
      iconName: 'shield' as const,
      retryLabel: null,
      showsContent: false,
    }),

    AUTHORIZATION_LOST: Object.freeze({
      label: 'Signed out',
      description: 'You are no longer signed in on this device. Sign in again to continue.',
      tone: 'attention' as const,
      iconName: 'shield-question' as const,
      retryLabel: null,
      showsContent: false,
    }),

    STEP_UP_REQUIRED: Object.freeze({
      label: 'Confirm it is you',
      description: 'This needs you to confirm your identity again before it can go ahead.',
      tone: 'informational' as const,
      iconName: 'shield' as const,
      retryLabel: null,
      showsContent: false,
    }),

    RECOVERABLE_ERROR: Object.freeze({
      label: 'Something went wrong',
      // No blame and no diagnosis. `14` keeps the reason out of the response, so inventing one
      // here would be a guess printed as a fact.
      description: 'Kynviora could not finish this. You can try again.',
      tone: 'attention' as const,
      iconName: 'alert-triangle' as const,
      retryLabel: 'Try again',
      showsContent: false,
    }),

    /**
     * The resource is not available to this account.
     *
     * Deliberately worded as absence rather than refusal. The API answers `PERMISSION_DENIED`
     * with **404** so that it is not an existence oracle (`19`, and trap 14 in `STATUS.md`); a
     * client that renders that 404 as "you do not have permission" hands back the exact fact the
     * status code was chosen to withhold, and does it on the screen rather than in the protocol.
     * There is no state in this union meaning "refused", and that is the point.
     */
    UNAVAILABLE: Object.freeze({
      label: 'Not available',
      description: 'Kynviora has nothing to show here.',
      tone: 'surfaceMuted' as const,
      iconName: 'info-circle' as const,
      retryLabel: null,
      showsContent: false,
    }),
  });

export function presentScreenState(state: ScreenState): ScreenStatePresentation {
  return SCREEN_STATE_PRESENTATION[state];
}

/**
 * The colour pair for a state's tone, in a given theme. Support for the label, never a
 * replacement for it.
 *
 * The theme is a parameter rather than a global since DEC-130: the same state is a different pair
 * of colours in the two themes, and a function that could only answer for one of them was a
 * dark-mode screen painted in light-mode colours.
 */
export function screenStateColors(state: ScreenState, theme: Theme = LIGHT_THEME): ColorPair {
  return theme[SCREEN_STATE_PRESENTATION[state].tone];
}

/**
 * What a screen reader announces for a state.
 *
 * Label then description, in that order: `18` requires status to be announced in a logical order
 * rather than as a colour change nobody hears.
 */
export function screenStateAccessibilityLabel(state: ScreenState): string {
  const presentation = SCREEN_STATE_PRESENTATION[state];
  return `${presentation.label}. ${presentation.description}`;
}

/** Every user-visible string in this module, for the copy scans. */
export const ALL_SCREEN_STATE_STRINGS: readonly string[] = Object.freeze(
  SCREEN_STATES.flatMap((state) => {
    const presentation = SCREEN_STATE_PRESENTATION[state];
    return presentation.retryLabel === null
      ? [presentation.label, presentation.description]
      : [presentation.label, presentation.description, presentation.retryLabel];
  }),
);

/** Exhaustiveness, asserted rather than assumed. */
export function everyScreenStatePresented(): boolean {
  return SCREEN_STATES.every((state) => SCREEN_STATE_PRESENTATION[state].label.length > 0);
}
