/**
 * Drive Voice Mode on a real device, and measure what only a device can answer.
 *
 * Spec references: `19` (device E2E), `18`, `17`, `14`, `06`. DEC-132 to DEC-136, `BLK-012`,
 * `DEV-073`.
 *
 *   npm run verify:device:voice
 *
 * WHAT THIS ADDS TO THE SUITE THAT ALREADY EXISTS
 * `packages/agent` proves the six gates, the confirmation machine and the Speech Gate, in Node,
 * without React. `apps/mobile/src/voice` proves the wiring. Neither can answer the questions this
 * scenario is about, all of which are about **rendering**: is the way in on every destination and
 * in the same place; is the state said in a word rather than drawn in a colour; is a refusal a
 * sentence somebody can read; is the summary of a write on screen before the write; and are the
 * two confirmation controls big enough and far enough apart to be pressed by somebody who is not
 * looking at them.
 *
 * WHAT IT NEEDS, AND WHY THE FLAG IS NOT A CHEAT
 * `EXPO_PUBLIC_DEV_VOICE_SCRIPT=1` and `EXPO_PUBLIC_DEV_VOICE_ITEM_ID=<the seed's first medicine>`
 * in `apps/mobile/.env.local`. The second is not optional and its absence is silent: without it
 * `demonstrationScript` leaves out every item-scoped rule, so a harness asking for a dose or a
 * reminder gets "I did not catch that" and reads it as the app refusing (`DEV-095`). With no
 * speech provider
 * (`BLK-012`) the app understands nothing, so the only thing a device could otherwise show is that
 * a screen renders. The flag installs `createScriptedAgent` - a list of regular expressions, named
 * for what it is - which turns a typed sentence into a proposal. **Every proposal it makes goes
 * through the same six gates as any other**, which is precisely what this scenario measures: the
 * most useful scripts in it are the ones that misbehave.
 *
 * It also needs the seeded API on `127.0.0.1:3000` and a Metro bundler, like every other scenario
 * here, and it establishes its own `adb reverse` tunnels - a phone that cannot reach the API draws
 * "No connection" on every screen, and a check looking for a control reads that as the control
 * having been withheld (trap 197).
 *
 * WHAT IT LEAVES BEHIND
 * Nothing. It confirms one thing - opening the camera - which writes no row, and it declines the
 * rest. `VOICE-7` is the check that says so, by counting the shelf either side.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { PACKAGE, adb, densityDpi, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import { accessibleNameOf, isInteractiveTarget, sizeInDp, type UiNode } from './accessibility.js';
import {
  centreOf,
  coldStart,
  collectScreenText,
  currentNodes,
  dismissKeyboard,
  forInputText,
  prepareDeviceForDriving,
  scrollToClickableNamed,
  scrollTo,
  tapAt,
  waitForNamed,
} from './ui.js';
import {
  confirmationShownCheck,
  confirmationTargetsCheck,
  declinedCheck,
  entryControlCheck,
  noAdviceCheck,
  statedStateCheck,
  touchOnlyRefusalCheck,
  transcriptCheck,
  type Exchange,
  type MeasuredControl,
} from './voiceMode.js';

const TABS = ['Today', 'Shelf', 'Safety', 'Care', 'You'] as const;

/** The seeded household, as every other harness here names it. */
const USER_ID = '00000000-0000-4000-8000-00000000d001';
const PROFILE_ID = '00000000-0000-4000-8000-00000000d020';
const ENTRY = 'Talk to Kynviora';
const FIELD = 'Type what you would say';
const ASK = 'Ask Kynviora';

function step(label: string): void {
  process.stdout.write(`  ${new Date().toISOString().slice(11, 19)}  ${label}\n`);
}

/** Both tunnels, and whether they came back. A phone with no route to the API draws nothing. */
function establishTunnels(): boolean {
  adb(['reverse', 'tcp:3000', 'tcp:3000']);
  adb(['reverse', 'tcp:8081', 'tcp:8081']);
  const listed = adb(['reverse', '--list']).stdout;
  return listed.includes('tcp:3000') && listed.includes('tcp:8081');
}

/**
 * Start the app from dead and wait until it is actually drawing.
 *
 * `coldStart` rather than a fixed sleep, and this is `DEV-080` arriving on a second harness. It
 * slept thirty seconds; a cold start behind Metro takes anywhere between fifteen and fifty
 * depending on whether the bundle is cached, so on a freshly booted emulator with a first-time
 * bundle the reads that follow were taken off an app that had not drawn yet. `VOICE-1` then
 * reported the way into Voice Mode as **missing from Today, Shelf and Safety** on a build where it
 * is on all five - the three it happened to try first, before the app finished starting. The same
 * run passed on Care and You, which is what made it look like a property of those screens
 * (`DEV-094`).
 *
 * `false` means the app did not start twice running, and every caller says so rather than
 * describing what a screen did - a launch that did not happen must never be reported as a finding
 * about the app (trap 195, DEC-102).
 */
function relaunch(): boolean {
  return coldStart('voice');
}

function pressNamed(name: string): boolean {
  const node = scrollTo(name) ?? waitForNamed(name);
  if (node === null) return false;
  tapAt(centreOf(node));
  sleep(3_000);
  return true;
}

/** Where, in pixels from the top, the entry control sits on the destination currently open. */
function entryPositionHere(): number | null {
  const nodes = currentNodes();
  if (nodes === null) return null;
  const node = nodes.find(
    (candidate) =>
      candidate.packageName === PACKAGE && accessibleNameOf(candidate).startsWith(ENTRY),
  );
  if (node === undefined) return null;
  return Math.round((node.bounds.top / densityDpi()) * 160);
}

function openTab(label: string): boolean {
  const nodes = currentNodes();
  if (nodes === null) return false;
  const target = nodes.find(
    (node) =>
      node.packageName === PACKAGE && isInteractiveTarget(node) && accessibleNameOf(node) === label,
  );
  if (target === undefined) return false;
  tapAt(centreOf(target));
  sleep(6_000);
  return true;
}

/**
 * Every line of the Voice Mode transcript and its state block, top to bottom.
 *
 * A generous swipe budget rather than a tidy one. The page grows by two rows per exchange, and a
 * collector that ran out of swipes reported the earlier half of a conversation as missing - which
 * reads as the app having lost it.
 */
function screenLines(): readonly string[] {
  // Eight, measured rather than chosen: a hand-driven probe of the same three exchanges gathered
  // every row at this budget, and raising it to 25 made a page it had been reading whole come back
  // in pieces - a long swipe sequence spends most of its time dumping a screen mid-fling, and an
  // unreadable dump contributes nothing to the union.
  return collectScreenText(8) ?? [];
}

/**
 * The card's own announcement, imported from the screen rather than retyped.
 *
 * The whole card is one accessibility node carrying `${ARMED_MARKER}. ${summary}`, so the summary
 * is read off that name instead of being guessed at from a position in a list - which is what the
 * first version did, and what returned the state glyph on one run.
 */
const ARMED_MARKER = 'Nothing has happened yet';

/**
 * The confirmation card: its summary, and the two controls, from one dump.
 *
 * Read out of the hierarchy rather than out of the collected text, and the difference matters.
 * `collectScreenText` returns a **de-duplicated set in encounter order**, so "the line after the
 * marker" is whatever happened to be gathered next - which on one run was the state glyph. The
 * summary is the node directly below the marker by its top edge, which is what it actually is.
 *
 * It scrolls to the marker first. The card sits above the transcript, and every step before this
 * leaves the screen at the bottom.
 */
function confirmationCard(): {
  readonly summary: string | null;
  readonly controls: readonly MeasuredControl[];
} {
  if (scrollTo({ startsWith: ARMED_MARKER }) === null) return { summary: null, controls: [] };

  const density = densityDpi();
  const nodes = (currentNodes() ?? []).filter((node) => node.packageName === PACKAGE);
  const card = nodes.find((node) => accessibleNameOf(node).startsWith(ARMED_MARKER));
  if (card === undefined) return { summary: null, controls: [] };

  const answers = nodes
    .filter((node) => {
      const name = accessibleNameOf(node);
      return node.clickable && (name.startsWith('Yes') || name.startsWith('No, '));
    })
    .sort((left, right) => left.bounds.top - right.bounds.top);

  return {
    // Everything after the marker and its full stop: the sentence a person is being asked to
    // agree to, as the card announces it.
    summary: accessibleNameOf(card)
      .slice(ARMED_MARKER.length + 2)
      .trim(),
    controls: answers.map((node: UiNode, index): MeasuredControl => {
      const size = sizeInDp(node, density);
      const previous = answers[index - 1];
      return {
        name: accessibleNameOf(node),
        widthDp: size.width,
        heightDp: size.height,
        gapAboveDp:
          previous === undefined
            ? null
            : Math.round(((node.bounds.top - previous.bounds.bottom) / density) * 160),
      };
    }),
  };
}

/**
 * Ask something, and report what the screen said back.
 *
 * The field is **scrolled to** rather than assumed on screen. It is the last thing on the page and
 * the transcript grows above it, so by the third exchange it is below the fold - which the first
 * version of this harness answered by scrolling **up**, away from it, and then reported two
 * exchanges that never happened as two silent refusals.
 */
function ask(said: string): Exchange {
  // Always scrolled to, never merely waited for. `waitForNamed` answers about what is on screen
  // **now**, and by the third exchange the transcript has pushed the field below the fold - so a
  // run that only waited found the field's own **visible label**, which carries the same words,
  // tapped it, and typed into nothing.
  //
  // Hiding the label from a screen reader was the right fix for a person and no fix at all here:
  // `uiautomator` dumps the view hierarchy rather than the accessibility tree, so a node marked
  // `importantForAccessibility="no"` is still in it with its text. The field is the **clickable**
  // one of the two, which is what `clickableNamed` picks.
  const field = scrollToClickableNamed(FIELD);
  if (field === null) return { said, transcript: [], summary: null };
  tapAt(centreOf(field));
  sleep(1_500);
  adb(['shell', 'input', 'text', forInputText(said)]);
  sleep(1_500);
  dismissKeyboard();

  if (!pressNamed(ASK)) return { said, transcript: [], summary: null };
  sleep(4_000);

  const lines = screenLines();
  return { said, transcript: lines, summary: confirmationCard().summary };
}

/**
 * What is on the shelf, read from the API rather than off the screen.
 *
 * `VOICE-7` is a subtraction - saying no must change nothing - and a subtraction needs a count it
 * can trust. Read off the screen, every row's control carries the same name, so the text collector
 * folds them to one line and the check compares one against one however many items there are. The
 * server has the real answer and every other harness here asks it the same way.
 */
async function shelfContents(): Promise<readonly string[]> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(
        `http://127.0.0.1:3000/v1/items?profileId=${encodeURIComponent(PROFILE_ID)}`,
        // `connection: close` for the reason every other harness needs it: `sleep` blocks the
        // event loop for most of a run, so a pooled connection is dead by the time it is reused
        // (trap 188).
        { headers: { 'x-kynviora-dev-user': USER_ID, connection: 'close' } },
      );
      if (!response.ok) return [];
      const body = (await response.json()) as {
        readonly items?: readonly { readonly id: string }[];
      };
      return (body.items ?? []).map((item) => item.id).sort();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return [];
}

async function run(): Promise<readonly Check[]> {
  const checks: Check[] = [];

  if (!isInstalled()) {
    return [
      {
        id: 'VOICE-0',
        title: 'The app is installed',
        status: 'INCONCLUSIVE',
        detail: `${PACKAGE} is not installed on the attached device.`,
      },
    ];
  }

  step('establishing tunnels');
  if (!establishTunnels()) {
    return [
      {
        id: 'VOICE-0',
        title: 'The phone can reach the API and Metro',
        status: 'INCONCLUSIVE',
        detail:
          'adb reverse did not report both tunnels. A phone that cannot reach the API draws "No connection", and a check looking for a control reads that as the control being withheld.',
      },
    ];
  }
  checks.push({
    id: 'VOICE-0',
    title: 'The phone can reach the API and Metro',
    status: 'PASS',
    detail: 'Both adb reverse tunnels are established.',
  });

  prepareDeviceForDriving();

  step('reading the shelf before anything is asked');
  const before = await shelfContents();

  step('looking for the way in, on each destination');
  const positions = new Map<string, number | null>();
  if (!relaunch()) {
    return [
      ...checks,
      {
        id: 'VOICE-1',
        title: 'The way in is on every destination',
        status: 'INCONCLUSIVE',
        detail:
          'The app did not start, so no destination was read. Every check below depends on this ' +
          'one having been driven.',
      },
    ];
  }
  for (const tab of TABS) {
    if (!openTab(tab)) {
      positions.set(tab, null);
      continue;
    }
    positions.set(tab, entryPositionHere());
  }
  checks.push(entryControlCheck(positions, [...TABS]));

  step('opening Voice Mode');
  if (!relaunch() || !pressNamed(ENTRY)) {
    checks.push({
      id: 'VOICE-2',
      title: 'The state is said in a word, not only drawn',
      status: 'INCONCLUSIVE',
      detail: 'Voice Mode could not be opened, so nothing below it could be measured.',
    });
    return checks;
  }

  const opened = screenLines();
  checks.push(statedStateCheck(opened));

  step('asking for something voice may not carry');
  const refusal = ask('delete my account');
  checks.push(touchOnlyRefusalCheck(refusal));

  step('asking the question it will not answer');
  const advice = ask('is it safe');
  checks.push(noAdviceCheck(advice));

  step('asking for something that has to be confirmed');
  const proposal = ask('photograph the box');
  const card = confirmationCard();
  checks.push(confirmationShownCheck({ ...proposal, summary: card.summary }, 'front of the pack'));
  checks.push(confirmationTargetsCheck(card.controls));

  step('declining it');
  if (pressNamed('No, leave it')) {
    sleep(2_000);
  }
  const after = await shelfContents();
  checks.push(declinedCheck(before, after));

  // Read once, at the end, over the finished conversation.
  // The second exchange's own snapshot: two turns, both sides of each, at a size the collector can
  // gather in one pass. `voiceMode.ts` says why the finished conversation is not the subject.
  checks.push(transcriptCheck(advice, refusal.said));

  return checks;
}

const results = await run();
process.stdout.write(`\n${formatReport(results)}\n`);
process.exit(overallStatus(results) === 'PASS' ? 0 : 1);
