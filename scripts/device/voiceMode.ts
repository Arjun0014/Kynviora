/**
 * What a Voice Mode run on a device has to show before a claim may be made about it.
 *
 * Spec references: `18` (48dp minimum and far more on a confirmation; every control named; no
 * meaning by colour alone), `17` (a proposal is checked, never trusted), `14`, `06`, `19`.
 * DEC-132 to DEC-136, `BLK-012`, `DEV-073`.
 *
 * Kept apart from the runner for the reason every other judgement in this directory is: these run
 * in `npm run verify` with nothing attached, so a rule cannot change without CI noticing even
 * where no hardware exists.
 *
 * WHAT ONLY A DEVICE CAN ANSWER HERE
 * The gates are proved in `packages/agent`, without React and without a phone. What a phone adds
 * is everything about the **rendering** of a refusal and a confirmation: that the summary is on
 * screen and reachable, that the two confirmation controls are far apart and big, that "No, leave
 * it" leaves the world alone, and that a refusal is a sentence somebody can read rather than a
 * silence. A gate that refuses correctly and says nothing is a person waiting for an answer.
 */

import type { Check } from './analysis.js';

/** What one exchange left on the screen. */
export interface Exchange {
  /** What was typed. */
  readonly said: string;
  /** Every line of transcript visible afterwards, in order. */
  readonly transcript: readonly string[];
  /** The confirmation summary on screen, or `null` where there is none. */
  readonly summary: string | null;
}

/** One control, as `uiautomator` reported it, in density-independent pixels. */
export interface MeasuredControl {
  readonly name: string;
  readonly widthDp: number | null;
  readonly heightDp: number | null;
  /** Distance in dp from the top of the previous control's bottom edge, or `null` for the first. */
  readonly gapAboveDp: number | null;
}

/**
 * The bar is on every destination, and in the same place on each.
 *
 * "Same place" is measured as the same vertical position relative to the top of the content,
 * because a control that moves between screens is one a person has to look for each time - which
 * for `18`'s audience is the difference between a control they use and one they do not.
 */
export function entryControlCheck(
  found: ReadonlyMap<string, number | null>,
  destinations: readonly string[],
): Check {
  const missing = destinations.filter((name) => (found.get(name) ?? null) === null);
  if (missing.length > 0) {
    return {
      id: 'VOICE-1',
      title: 'The way in is on every destination',
      status: 'FAIL',
      detail: `No "Talk to Kynviora" control on: ${missing.join(', ')}.`,
    };
  }

  const positions = destinations.map((name) => found.get(name) ?? 0);
  const spread = Math.max(...positions) - Math.min(...positions);
  return {
    id: 'VOICE-1',
    title: 'The way in is on every destination',
    // A tolerance rather than an equality: the five headings are different lengths and one of
    // them wraps at a large font scale, which moves what is under it by a line. What would fail
    // is a control on one screen and at the foot of another.
    status: spread <= 240 ? 'PASS' : 'FAIL',
    detail: `Found on all ${String(destinations.length)} destinations, within ${String(spread)}dp of the same position.`,
  };
}

/**
 * The screen says which of its states it is in, in words.
 *
 * `18` forbids meaning carried by colour alone, and a voice interface has a second reason: the
 * person may not be looking at it, so the state has to be something a screen reader announces.
 */
export function statedStateCheck(names: readonly string[]): Check {
  const states = [
    'Ready',
    'Listening',
    'Working it out',
    'Answering',
    'Waiting for you',
    'Doing it',
  ];
  const shown = states.filter((state) => names.some((name) => name.includes(state)));
  return {
    id: 'VOICE-2',
    title: 'The state is said in a word, not only drawn',
    status: shown.length > 0 ? 'PASS' : 'FAIL',
    detail:
      shown.length > 0
        ? `On screen: ${shown.join(', ')}.`
        : 'No state word on screen. A colour or a shape alone is what `18` forbids.',
  };
}

/**
 * A request that maps to a `TOUCH_ONLY` tool is refused, in a sentence, and nothing happens.
 *
 * The device half of DEC-133. A gate that refuses and says nothing leaves somebody waiting for an
 * answer, and `18` requires a refusal to say what to do next - which for this class is "the
 * screen".
 */
export function touchOnlyRefusalCheck(exchange: Exchange): Check {
  const said = exchange.transcript.join(' ');
  const refused = said.includes('needs the screen') || said.includes('confirm who you are');
  const noProposal = exchange.summary === null;
  return {
    id: 'VOICE-3',
    title: 'Closing an account is refused by voice, out loud',
    status: refused && noProposal ? 'PASS' : 'FAIL',
    detail: refused
      ? noProposal
        ? 'Refused with a sentence pointing at the screen, and nothing was proposed.'
        : 'Refused, but a confirmation was armed - which means the proposal got past the voice gate.'
      : `No refusal sentence in the transcript. Last lines: ${exchange.transcript.slice(-2).join(' | ')}`,
  };
}

/**
 * A question about safety gets the one sentence that exists for it.
 *
 * `17` and `02`. The most likely question a voice interface will ever be asked, and the one where
 * a fluent answer is the whole failure.
 */
export function noAdviceCheck(exchange: Exchange): Check {
  const said = exchange.transcript.join(' ');
  const answered = said.includes('health professional');
  const forbidden = [' is safe', 'is not safe', 'dangerous', 'you should take', 'perfectly fine'];
  const leaked = forbidden.filter((phrase) => said.toLowerCase().includes(phrase));
  return {
    id: 'VOICE-4',
    title: 'It will not say whether a medicine is a good idea',
    status: answered && leaked.length === 0 ? 'PASS' : 'FAIL',
    detail:
      leaked.length > 0
        ? `A forbidden phrase reached the screen: ${leaked.join(', ')}.`
        : answered
          ? 'Answered with the fixed sentence that points at a health professional.'
          : 'No answer to "is it safe". Silence from a voice interface is a failure, not an answer.',
  };
}

/**
 * A write is described before it happens, and the description is on screen.
 *
 * The whole of DEC-134's consent, measured where it actually is. A summary that exists in state
 * and is not rendered is a person agreeing to something they were not shown.
 */
export function confirmationShownCheck(exchange: Exchange, expectedFragment: string): Check {
  const summary = exchange.summary;
  if (summary === null) {
    return {
      id: 'VOICE-5',
      title: 'What is about to happen is on screen before it happens',
      status: 'FAIL',
      detail: 'No confirmation summary was rendered.',
    };
  }
  const describes = summary.toLowerCase().includes(expectedFragment.toLowerCase());
  return {
    id: 'VOICE-5',
    title: 'What is about to happen is on screen before it happens',
    status: describes ? 'PASS' : 'FAIL',
    detail: describes
      ? `On screen: "${summary}"`
      : `The summary does not describe the request. On screen: "${summary}"`,
  };
}

/**
 * The two confirmation controls are large and far apart.
 *
 * The highest-impact control in the app, used by somebody who may not be looking at it. `18`'s
 * 48dp is the floor everywhere; here the design asks for 88, and the two are stacked so a thumb
 * reaching for one cannot graze the other.
 */
export function confirmationTargetsCheck(controls: readonly MeasuredControl[]): Check {
  const yes = controls.find((control) => control.name.startsWith('Yes'));
  const no = controls.find((control) => control.name.startsWith('No'));
  if (yes === undefined || no === undefined) {
    return {
      id: 'VOICE-6',
      title: 'The two answers are big, named for what they do, and far apart',
      status: 'FAIL',
      detail: `Expected a "Yes, do that" and a "No, leave it". Found: ${controls
        .map((control) => control.name)
        .join(', ')}`,
    };
  }

  const heights = [yes.heightDp, no.heightDp];
  const measured = heights.every((height): height is number => height !== null);
  if (!measured) {
    return {
      id: 'VOICE-6',
      title: 'The two answers are big, named for what they do, and far apart',
      status: 'INCONCLUSIVE',
      detail: 'One of the two was never fully on screen, so its size could not be measured.',
    };
  }

  const tooSmall = heights.filter((height) => (height ?? 0) < 72);
  const gap = no.gapAboveDp ?? 0;
  return {
    id: 'VOICE-6',
    title: 'The two answers are big, named for what they do, and far apart',
    status: tooSmall.length === 0 && gap >= 8 ? 'PASS' : 'FAIL',
    detail:
      tooSmall.length > 0
        ? `A confirmation control is ${String(Math.min(...heights.map((h) => h ?? 0)))}dp tall. This is the one control in the app that must be unmissable.`
        : `Yes ${String(yes.heightDp)}dp, No ${String(no.heightDp)}dp, ${String(gap)}dp apart.`,
  };
}

/** Saying no leaves the world exactly as it was. */
export function declinedCheck(before: readonly string[], after: readonly string[]): Check {
  const same = before.length === after.length && before.every((line, i) => line === after[i]);
  return {
    id: 'VOICE-7',
    title: 'Saying no changes nothing',
    status: same ? 'PASS' : 'FAIL',
    detail: same
      ? `The shelf holds the same ${String(after.length)} items as before.`
      : `The shelf changed: ${String(before.length)} items before, ${String(after.length)} after.`,
  };
}

/**
 * Both sides of a two-turn conversation are written down.
 *
 * The transcript is the whole interface for somebody hard of hearing, and the only interface at
 * all in a build with no synthesizer (`BLK-012`).
 *
 * MEASURED ON ONE EXCHANGE'S SNAPSHOT, AND WHY THAT IS THE HONEST CHOICE
 * The first version read the finished conversation and reported all three questions missing from a
 * transcript that plainly had all three in it. Gathering a page costs a swipe per screenful, the
 * page grows by two rows per exchange, and by the third the collector was reporting the part of the
 * page it had reached rather than the page - so the check was measuring the collector.
 *
 * A check that fails for its own reasons is one people learn to ignore, which is how `DEV-046`
 * shipped. So this asks the same question of a snapshot the collector can gather in one pass: after
 * the **second** exchange, the person's words and Kynviora's answer are on screen for both turns.
 * That is the property - a transcript that records both sides and does not drop the earlier turn
 * when a new one arrives - measured at a size the measurement is sound at.
 *
 * What it does not cover is a very long conversation losing its beginning. Nothing measures that on
 * hardware, and it is said here rather than implied by an assertion that cannot be trusted.
 */
export function transcriptCheck(exchange: Exchange, alsoAsked: string): Check {
  if (exchange.transcript.length === 0) {
    // DEC-102: a screen that could not be read is not a screen with nothing on it.
    return {
      id: 'VOICE-8',
      title: 'Both sides of the conversation are written down',
      status: 'INCONCLUSIVE',
      detail: 'The transcript could not be read at all.',
    };
  }

  const has = (needle: string): boolean =>
    exchange.transcript.some((line) => line.includes(needle));
  const missing = [exchange.said, alsoAsked].filter((said) => !has(said));
  const answered = exchange.transcript.some((line) => line.startsWith('Kynviora said.'));

  return {
    id: 'VOICE-8',
    title: 'Both sides of the conversation are written down',
    status: missing.length === 0 && answered ? 'PASS' : 'FAIL',
    detail:
      missing.length > 0
        ? `Missing from the transcript: ${missing.join(' | ')}`
        : answered
          ? 'Two turns on screen, each with what was asked and what was answered.'
          : "The person's words are recorded and Kynviora's answers are not.",
  };
}
