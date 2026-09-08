/**
 * The persistent Talk to Kynviora bar: eight states, each of them a word.
 *
 * Spec references: `18` (meaning never carried by colour alone; a control says what it does; one
 * announcement per node), `06` (Voice Mode is an action available from every destination, not a
 * sixth destination), `17` (the agent's reach is the app's reach), DEC-130 (`selection` is the one
 * hue about the interface), DEC-136, DEC-156.
 *
 * WHAT V3 CHANGED, AND WHY IT IS A PRESENTATION CONCERN
 * V2's control was a button that opened an overlay. V3 keeps it a full-width bar and makes it
 * **stateful**: it sits above the navigation on every destination, it reports what the agent is
 * doing, and the design language states the rule that makes this a module rather than a style -
 * *the bar's label is the state, so nothing rests on the animation, and the sub-line says what
 * happens next rather than what is happening now*.
 *
 * Both halves matter. A bar that only pulses while thinking is a bar that says nothing to somebody
 * with reduce-motion on, to somebody not looking at it, and to a screen reader. And a sub-line
 * reading "Working..." beside a label reading "Working" is one idea printed twice.
 *
 * THE EIGHT ARE NOT THE SIX
 * `VoiceState` has six members and describes what the conversation is *doing*. Three of the eight
 * bar states - Done, Could not do that, Needs more information - are what the last turn *came to*,
 * and every one of them is `IDLE` by the time it is true. So the bar is a function of the state
 * **and** the outcome, and `TurnOutcome` exists for that.
 *
 * WHY IT IS IN THIS PACKAGE AND NOT IN `@kynviora/presentation`
 * Because `@kynviora/agent` depends on `@kynviora/presentation` and not the other way round, and
 * this needs `VoiceState`. Putting it there would be a cycle. It is also the more natural home:
 * the bar is a rendering of the agent's own state machine, and the only thing it borrows from the
 * design system is a tone token.
 */

import { ownEntry } from '@kynviora/domain';
import type { ThemeToneToken } from '@kynviora/presentation';
import type { TurnOutcome, VoiceState } from './session.js';

/**
 * The eight states the bar shows, in the order the design language names them.
 *
 * A closed set with one presentation each, so a bar cannot show a label nobody wrote.
 */
export const TALK_BAR_STATES = [
  'IDLE',
  'LISTENING',
  'UNDERSTANDING',
  'WORKING',
  'NEEDS_CONFIRMATION',
  'DONE',
  'COULD_NOT',
  'NEEDS_MORE',
] as const;
export type TalkBarState = (typeof TALK_BAR_STATES)[number];

export interface TalkBarPresentation {
  readonly state: TalkBarState;
  /** The visible label. Always the state, in words. */
  readonly label: string;
  /**
   * One line under the label saying **what happens next**, not what is happening now.
   *
   * The distinction is the design language's and it is worth keeping: "Listening" over "Say what
   * you want" tells somebody the two things they need; "Listening" over "Kynviora is listening"
   * tells them one thing twice.
   */
  readonly subline: string;
  /**
   * The supporting tone. Never the only carrier of anything.
   *
   * `selection` while the person is driving it, because that is the one hue in this app about the
   * interface rather than about a product (DEC-130). Never `action` - a bar that turned red on a
   * refusal would be dramatising a "I cannot do that by voice", which `02` refuses.
   */
  readonly tone: ThemeToneToken;
  /**
   * Whether something is genuinely happening right now.
   *
   * What an animation may be driven from - and only that. A component reading this to decide
   * whether to pulse is drawing a live state; one reading it to decide what to say would be
   * putting meaning in the animation, which is what `18` forbids.
   */
  readonly live: boolean;
  /** Whether a stop control belongs on the bar. */
  readonly stoppable: boolean;
  readonly accessibilityLabel: string;
}

const PRESENTATIONS: Readonly<Record<TalkBarState, Omit<TalkBarPresentation, 'state'>>> =
  Object.freeze({
    IDLE: {
      label: 'Talk to Kynviora',
      subline: 'Ask for something on this screen.',
      tone: 'surface',
      live: false,
      stoppable: false,
      accessibilityLabel: 'Talk to Kynviora. Ask for something on this screen.',
    },
    LISTENING: {
      label: 'Listening',
      subline: 'Say what you want, then stop.',
      tone: 'surfaceMuted',
      live: true,
      stoppable: true,
      accessibilityLabel: 'Listening. Say what you want, then stop.',
    },
    UNDERSTANDING: {
      label: 'Understanding',
      subline: 'Working out what you asked for.',
      tone: 'surfaceMuted',
      live: true,
      stoppable: true,
      accessibilityLabel: 'Understanding. Working out what you asked for.',
    },
    WORKING: {
      label: 'Working',
      subline: 'Doing what you confirmed.',
      tone: 'surfaceMuted',
      live: true,
      stoppable: false,
      accessibilityLabel: 'Working. Doing what you confirmed.',
    },
    NEEDS_CONFIRMATION: {
      label: 'Needs your confirmation',
      // The one state where the next step is a decision rather than a wait, and the sub-line says
      // which decision. `18` wants a person to know what they are agreeing to before they agree.
      subline: 'Read what it will do, then say yes or no.',
      tone: 'attention',
      live: false,
      stoppable: false,
      accessibilityLabel: 'Needs your confirmation. Read what it will do, then say yes or no.',
    },
    DONE: {
      label: 'Done',
      subline: 'The result is on the screen.',
      // `positive` marks a completed operation and never a product (`18`). What was completed is
      // an action somebody asked for; nothing here says anything about a medicine.
      tone: 'positive',
      live: false,
      stoppable: false,
      accessibilityLabel: 'Done. The result is on the screen.',
    },
    COULD_NOT: {
      label: 'Could not do that',
      // Where the control is, rather than an apology. A refusal that ends the exchange without
      // saying what would have worked is a dead end (DEC-136).
      subline: 'The transcript says why, and where the control is.',
      tone: 'neutral',
      live: false,
      stoppable: false,
      accessibilityLabel: 'Could not do that. The transcript says why, and where the control is.',
    },
    NEEDS_MORE: {
      label: 'Needs more information',
      subline: 'Answer the question and it will carry on.',
      tone: 'informational',
      live: false,
      stoppable: false,
      accessibilityLabel: 'Needs more information. Answer the question and it will carry on.',
    },
  });

/**
 * Which of the eight a session is in.
 *
 * The outcome is consulted **only** in `IDLE`, and that is the whole rule. Every turn passes
 * through `IDLE` at its end, so an outcome read in any other state would be reporting the previous
 * turn over the top of the current one.
 */
export function talkBarStateFor(session: {
  readonly state: VoiceState;
  readonly lastOutcome: TurnOutcome | null;
}): TalkBarState {
  switch (session.state) {
    case 'LISTENING':
      return 'LISTENING';
    case 'THINKING':
      return 'UNDERSTANDING';
    case 'WORKING':
      return 'WORKING';
    case 'AWAITING_CONFIRMATION':
      return 'NEEDS_CONFIRMATION';
    // `SPEAKING` is a turn still in progress: something is being read out and the person has not
    // been given the outcome yet. Reporting Done here would put the word on screen before the
    // sentence it summarises had finished being said.
    case 'SPEAKING':
      return 'UNDERSTANDING';
    case 'IDLE':
      if (session.lastOutcome === 'COMPLETED') return 'DONE';
      if (session.lastOutcome === 'REFUSED') return 'COULD_NOT';
      if (session.lastOutcome === 'NEEDS_MORE') return 'NEEDS_MORE';
      return 'IDLE';
  }
}

export function talkBarPresentation(state: TalkBarState): TalkBarPresentation {
  // DEC-147: an own-property read, so a state that arrived from somewhere untyped cannot resolve
  // a function through the prototype and be printed on a bar.
  const found = ownEntry(PRESENTATIONS, state) ?? PRESENTATIONS.IDLE;
  return { state: ownEntry(PRESENTATIONS, state) === null ? 'IDLE' : state, ...found };
}

/**
 * Above this system font scale, the sub-line is announced and not drawn.
 *
 * Measured rather than chosen: at font scale 2 on a Pixel 7 (1080x2400) the bar with both lines
 * occupies **452 pixels** - `[42,1672][1038,2124]` from a hierarchy dump - which is 19% of the
 * screen, on every destination, permanently. The people who set the scale to 2 are the people
 * `18` names first, and taking a fifth of their screen for supporting text is the wrong trade.
 *
 * What is dropped is the sub-line only, and only from the **visible** bar: it stays in
 * `accessibilityLabel`, so a screen reader still announces "Listening. Say what you want, then
 * stop." The label is the state and is never dropped, because that is the half `18` requires to
 * be visible and the half the design language says nothing may rest on an animation for.
 *
 * 1.5 rather than 2.0, because the bar is already two lines at 1.5 on a narrow phone and the
 * threshold should sit where the second line starts costing rather than where it becomes extreme.
 */
export const TALK_BAR_SUBLINE_MAX_SCALE = 1.5;

/**
 * Whether the sub-line is drawn at this system font scale.
 *
 * A function rather than a comparison at the call site, so the threshold and its measurement live
 * together and a screen cannot quietly pick a different one.
 */
export function talkBarShowsSubline(fontScale: number): boolean {
  return fontScale <= TALK_BAR_SUBLINE_MAX_SCALE;
}

/**
 * Whether the bar belongs on screen at all.
 *
 * The design language names the three places it leaves: camera capture, an open sheet, and
 * selection mode - "where the space belongs to the task". A fourth is added here and is not in the
 * design: a **critical confirmation**, because a bar offering a second way to act sitting under a
 * screen whose whole purpose is one decision is `18`'s one-primary-action rule broken by furniture.
 */
export function talkBarIsVisible(context: {
  readonly capturing: boolean;
  readonly sheetOpen: boolean;
  readonly selecting: boolean;
  readonly confirming: boolean;
}): boolean {
  return !context.capturing && !context.sheetOpen && !context.selecting && !context.confirming;
}
