/**
 * Driving the app by its accessible names, rather than by coordinates somebody wrote down.
 *
 * Spec references: `18` (every control has a name a screen reader can announce - which is what
 * makes this possible at all), `19` (device E2E), DEC-102.
 *
 * WHY BY NAME AND NOT BY PIXEL
 * A harness that taps fixed coordinates is a harness that passes until the day a paragraph gets
 * one line longer. Every control this app draws already has to carry a name for `18`'s sake, and
 * the accessibility harness measures that it does - so the names are both stable and independently
 * guaranteed. Tapping the middle of the node that carries the name is then a lookup rather than a
 * measurement.
 *
 * WHAT THIS FILE HAS LEARNED THE HARD WAY, AND WHY EACH GUARD IS HERE
 *
 *   - **A dump can come back empty.** `uiautomator` returns no root while a transition is running,
 *     and an empty hierarchy means "not found" for every name in it. Reads are retried rather than
 *     believed the first time.
 *   - **`input text` goes to whatever holds the input connection, which is not always the app.**
 *     Android's stylus-handwriting tutorial opened over the form and swallowed two attempts at
 *     typing a time; the field stayed empty and the run looked like a save that produced nothing.
 *     `typeInto` reads the field back and says whether the text arrived.
 *   - **The soft keyboard changes the layout under you.** The node found before the keyboard opens
 *     is not where it is afterwards, so a scroll-then-tap sequence has to re-read between steps.
 *   - **A control below the fold is not absent.** `scrollTo` looks, scrolls, and looks again, a
 *     bounded number of times, rather than assuming a fixed number of swipes lands anywhere.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE, adb, adbBytes, dumpUiHierarchy, sleep } from './adb.js';
import { accessibleNameOf, parseUiHierarchy, type UiNode } from './accessibility.js';

/** A point on the screen, in device pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The middle of a node, which is where a tap goes. */
export function centreOf(node: UiNode): Point {
  return {
    x: Math.round((node.bounds.left + node.bounds.right) / 2),
    y: Math.round((node.bounds.top + node.bounds.bottom) / 2),
  };
}

/**
 * How a control is asked for.
 *
 * A plain string is the whole accessible name. `{ startsWith }` is for the many controls whose name
 * is a label followed by its own help sentence - a form field announces "Name. Whatever you call
 * them. It is only ever shown to you and to people you invite." - where pinning the exact string
 * would make this harness fail on a wording change that broke nothing (`18` requires the help to be
 * announced, and it is expected to be edited).
 */
export type NameMatch = string | { readonly startsWith: string };

export function nameMatches(actual: string, wanted: NameMatch): boolean {
  return typeof wanted === 'string' ? actual === wanted : actual.startsWith(wanted.startsWith);
}

/** How a match reads in a report. */
export function describeMatch(wanted: NameMatch): string {
  return typeof wanted === 'string' ? wanted : `${wanted.startsWith}...`;
}

/**
 * The node carrying this accessible name, preferring one that can be tapped.
 *
 * A label and the control it labels often carry the same name - the label is drawn text, the
 * control is what responds - and tapping the label does nothing at all. That was the previous
 * session's failure, so the clickable candidate wins and the first match is only a fallback for
 * fields like a `TextInput`, which reports itself as focusable rather than clickable.
 */
export function nodeNamed(nodes: readonly UiNode[], name: NameMatch): UiNode | null {
  const matches = nodes.filter(
    (node) => node.packageName === PACKAGE && nameMatches(accessibleNameOf(node), name),
  );
  return matches.find((node) => node.clickable) ?? matches[0] ?? null;
}

/**
 * The node with this name that belongs to the row headed by `anchor`.
 *
 * A list draws one identically-named control per row - every shelf row carries "Open this item" -
 * so a plain lookup opens whichever row happens to be first in the hierarchy, and a run then
 * measures the wrong medicine while reporting the right name. The row is identified by the only
 * thing that distinguishes it, which is its heading, and the control is the nearest match below
 * that heading.
 *
 * "Below" is by the top edge, not by containment: `uiautomator` reports a flat list of rectangles
 * and a row is a visual grouping rather than a node anybody can ask about. Both have to be on
 * screen at once for this to answer, which is why the callers scroll to the anchor first.
 */
export function nodeNamedBelow(
  nodes: readonly UiNode[],
  name: NameMatch,
  anchor: NameMatch,
): UiNode | null {
  const mine = nodes.filter((node) => node.packageName === PACKAGE);
  const anchorNode = mine.find((node) => nameMatches(accessibleNameOf(node), anchor));
  if (anchorNode === undefined) return null;
  const below = mine
    .filter(
      (node) =>
        nameMatches(accessibleNameOf(node), name) && node.bounds.top >= anchorNode.bounds.top,
    )
    .sort((left, right) => left.bounds.top - right.bounds.top);
  return below.find((node) => node.clickable) ?? below[0] ?? null;
}

/** Every node this app is currently drawing, or `null` where the screen could not be read. */
export function currentNodes(attempts = 5): readonly UiNode[] | null {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const xml = dumpUiHierarchy();
    if (xml !== null) return parseUiHierarchy(xml);
    sleep(1_500);
  }
  return null;
}

export function tapAt(point: Point): void {
  adb(['shell', 'input', 'tap', String(point.x), String(point.y)]);
}

/** Tap the control with this name. `false` where it was not on screen. */
export function tapNamed(name: NameMatch): boolean {
  const nodes = currentNodes();
  if (nodes === null) return false;
  const node = nodeNamed(nodes, name);
  if (node === null) return false;
  tapAt(centreOf(node));
  sleep(1_500);
  return true;
}

/**
 * One step through a list.
 *
 * **The step is deliberately much shorter than the screen.** A swipe the height of the viewport
 * moves the content by a whole screenful, so a control that sits between two consecutive views is
 * never seen at all - and `scrollTo` then reports it as absent, which is how a run declared the
 * time field missing from a form that plainly had one. Roughly a third of the screen leaves every
 * view overlapping the last, at the cost of a few more swipes.
 */
const SCROLL_STEP_PX = 800;
const SCROLL_ANCHOR_Y = 1_900;

export function scrollDown(): void {
  adb([
    'shell',
    'input',
    'swipe',
    '540',
    String(SCROLL_ANCHOR_Y),
    '540',
    String(SCROLL_ANCHOR_Y - SCROLL_STEP_PX),
    '250',
  ]);
  // Long enough for the fling to settle. A dump taken while it is still moving comes back with no
  // root, which is indistinguishable from a screen with nothing on it.
  sleep(1_500);
}

export function scrollUp(): void {
  adb([
    'shell',
    'input',
    'swipe',
    '540',
    String(SCROLL_ANCHOR_Y - SCROLL_STEP_PX),
    '540',
    String(SCROLL_ANCHOR_Y),
    '250',
  ]);
  sleep(1_500);
}

/**
 * Scroll until a named control is on screen, and report whether it ever was.
 *
 * Bounded, and it scrolls back to the top first: a control above the current position is as
 * invisible as one below it, and a run that only ever scrolls one way finds the second one and
 * misses the first.
 */
export function scrollTo(name: NameMatch, maxSwipes = 30): UiNode | null {
  // Back to the top first: a control above the current position is as invisible as one below it,
  // and a run that only scrolls one way finds the second and misses the first. Stops as soon as
  // the screen stops changing, so a short list does not cost twenty swipes.
  let previous = signatureOfScreen();
  for (let up = 0; up < maxSwipes; up += 1) {
    scrollUp();
    const now = signatureOfScreen();
    if (now !== null && now === previous) break;
    previous = now;
  }

  for (let down = 0; down <= maxSwipes; down += 1) {
    const nodes = currentNodes();
    if (nodes !== null) {
      const node = nodeNamed(nodes, name);
      if (node !== null) return node;
    }
    // The screen that was just read, rather than a second dump of the same screen.
    const before = nodes === null ? null : signatureOf(nodes);
    scrollDown();
    // The bottom of the list. One more look has already happened above, so there is nothing left
    // to reveal and continuing would just repeat it.
    //
    // A screen that could not be read is `null` and never matches, so an unreadable dump reads as
    // "keep going" rather than as "the list ended". It is the commoner of the two by far - a dump
    // taken while a fling is still settling comes back with no root - and treating it as the end
    // stopped this function one swipe into a form, reporting a field that was plainly there as
    // missing.
    const after = signatureOfScreen();
    if (after !== null && after === before) break;
  }

  // The last look, for a control that was revealed by the final swipe.
  const nodes = currentNodes();
  return nodes === null ? null : nodeNamed(nodes, name);
}

/**
 * Everything this app is saying, gathered by scrolling the whole screen.
 *
 * A viewport is not a screen. Three safety lines and a coverage statement do not fit on a Pixel 7,
 * and a check that read only what was showing would report the sentence at the bottom as missing -
 * which is the same answer it gives for a screen that genuinely dropped it, and the more alarming
 * of the two. So this walks from the top to the end of the list and keeps the union.
 *
 * `null` only where not a single read succeeded. An empty array is a real answer: it means the app
 * drew nothing with a name on it.
 */
export function collectScreenText(maxSwipes = 30): readonly string[] | null {
  let previous = signatureOfScreen();
  for (let up = 0; up < maxSwipes; up += 1) {
    scrollUp();
    const now = signatureOfScreen();
    if (now !== null && now === previous) break;
    previous = now;
  }

  const seen = new Set<string>();
  let everRead = false;
  for (let down = 0; down <= maxSwipes; down += 1) {
    const nodes = currentNodes();
    if (nodes !== null) {
      everRead = true;
      for (const node of nodes) {
        if (node.packageName !== PACKAGE) continue;
        const name = accessibleNameOf(node);
        if (name !== '') seen.add(name);
      }
    }
    const before = nodes === null ? null : signatureOf(nodes);
    scrollDown();
    const after = signatureOfScreen();
    if (after !== null && after === before) break;
  }
  return everRead ? [...seen] : null;
}

/**
 * Enough of the screen to tell whether a swipe moved anything.
 *
 * Names and vertical positions, which is what scrolling changes. Used to find the end of a list
 * rather than assuming a swipe count, because the schedule editor's length depends on how many
 * schedules the seed happens to have accumulated.
 */
function signatureOf(nodes: readonly UiNode[]): string {
  return nodes
    .filter((node) => node.packageName === PACKAGE)
    .map((node) => `${accessibleNameOf(node)}@${String(node.bounds.top)}`)
    .join('|');
}

/**
 * The signature of what is on screen now, or `null` where it could not be read.
 *
 * Every call is a `uiautomator dump`, which is by far the most expensive thing this file does -
 * so the loops below reuse the nodes they have already read rather than asking twice for the same
 * screen. A scroll of a long form was three dumps per swipe and is now two, which is the
 * difference between a twenty-minute run and a ten-minute one.
 */
function signatureOfScreen(): string | null {
  const nodes = currentNodes(2);
  return nodes === null ? null : signatureOf(nodes);
}

/**
 * Scroll to a control, waiting for it to exist.
 *
 * Every screen here fills from a real API, and several draw fewer controls until it answers - the
 * schedule editor decides whether to offer "Add a schedule" from the `mayEdit` the server sends, so
 * for the first seconds after it opens the button is not merely below the fold, it is not there.
 * A harness that only scrolled reported it missing, correctly and uselessly, about a screen that
 * had it a second later.
 *
 * Absence is therefore a deadline rather than a single reading. `null` still means absent - it just
 * means absent for long enough that waiting is not the answer.
 */
export function waitForNamed(name: NameMatch, timeoutMs = 45_000): UiNode | null {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const node = scrollTo(name);
    if (node !== null) return node;
    if (Date.now() >= deadline) return null;
    sleep(2_000);
  }
}

/**
 * Scroll to a row's heading and tap the named control belonging to that row.
 *
 * Two steps rather than one, because the heading is what identifies the row and the control is
 * what responds.
 *
 * The loop is not defensive padding. `scrollTo` stops the moment the heading is anywhere on
 * screen, and "anywhere" includes ten clipped pixels at the very bottom - which is exactly where a
 * newly added item lands, since it is last on the shelf. The heading is then present, its control
 * is not drawn at all, and a single reading reports the row as having no control. One step down
 * brings the control into view and leaves the heading above it, which is the arrangement this
 * needs.
 *
 * `false` where the heading never appeared, where the list stopped moving before the control was
 * drawn, or where a scroll carried the heading off the top - the last because a control matched
 * without its heading on screen might belong to any row.
 */
export function scrollToAndTapBelow(
  name: NameMatch,
  anchor: NameMatch,
  timeoutMs = 45_000,
  maxSteps = 6,
): boolean {
  if (waitForNamed(anchor, timeoutMs) === null) return false;

  for (let step = 0; step < maxSteps; step += 1) {
    const nodes = currentNodes();
    if (nodes !== null) {
      const node = nodeNamedBelow(nodes, name, anchor);
      if (node !== null) {
        tapAt(centreOf(node));
        sleep(1_500);
        return true;
      }
      if (nodeNamed(nodes, anchor) === null) return false;
    }
    const before = nodes === null ? null : signatureOf(nodes);
    scrollDown();
    const after = signatureOfScreen();
    if (after !== null && after === before) return false;
  }
  return false;
}

/** Scroll a control into view - waiting for it to appear - and tap it. */
export function scrollToAndTap(name: NameMatch, timeoutMs = 45_000): boolean {
  const node = waitForNamed(name, timeoutMs);
  if (node === null) return false;
  tapAt(centreOf(node));
  sleep(1_500);
  return true;
}

/**
 * Whether the control with this name reports itself as chosen, or `null` where it is not there.
 *
 * Separated from the device call so the rule is testable: given a hierarchy, this is a lookup.
 * The three-valued answer matters - "not on screen" and "on screen and not chosen" are different
 * failures, and a boolean would report the first as the second, which reads as an app that
 * ignored a tap rather than a harness that looked in the wrong place.
 */
export function selectedStateOf(nodes: readonly UiNode[], name: NameMatch): boolean | null {
  const node = nodeNamed(nodes, name);
  return node === null ? null : node.selected;
}

/**
 * Whether the option with this name is chosen, scrolling to find it first.
 *
 * The read-back for a radio. The chosen option keeps the same accessible name - the app renders
 * its state into a `Text` child, which the `Pressable` swallows once it claims the accessibility
 * element - so `selected` is the only thing that changes when a tap lands.
 */
export function isSelected(name: NameMatch): boolean | null {
  const node = waitForNamed(name, 10_000);
  if (node === null) return null;
  // Re-read: `waitForNamed` scrolled, and the node it returned was parsed before the last scroll
  // settled. What is wanted is the state now.
  const nodes = currentNodes();
  return nodes === null ? null : selectedStateOf(nodes, name);
}

/** What a text field currently holds, or `null` where no field carries that name. */
export function textFieldValue(name: NameMatch): string | null {
  const nodes = currentNodes();
  if (nodes === null) return null;
  const node = nodeNamed(nodes, name);
  return node === null ? null : node.text;
}

/**
 * Type into the field with this name, and say whether the text arrived.
 *
 * The read-back is the point. `input text` delivers to whatever holds the input connection, and
 * on this emulator that turned out to be Android's stylus-handwriting tutorial rather than the
 * app - twice, silently, leaving a form that looked untouched. A `false` here is the difference
 * between "the app refused the value" and "the value never reached the app".
 *
 * An empty field reports its placeholder as its text, so the value is compared rather than merely
 * checked for being non-empty.
 */
export function typeInto(
  name: NameMatch,
  value: string,
): { readonly typed: boolean; readonly held: string | null } {
  // Waited for as well as scrolled to. A form opens wherever its scroll position happens to leave
  // it, and the field this harness needs is usually not the part on screen - which is how a run
  // reported "the form did not hold the time" about a field it never reached.
  const field = waitForNamed(name);
  if (field === null) return { typed: false, held: null };

  tapAt(centreOf(field));
  sleep(2_500);
  adb(['shell', 'input', 'text', forInputText(value)]);
  sleep(2_000);

  // Read back from where the keyboard has left it. The focused field is on screen by definition,
  // so a plain look comes first; the keyboard is only dismissed if that fails, because dismissing
  // it moves everything again.
  let held = textFieldValue(name);
  if (held === null) {
    dismissKeyboard();
    held = scrollTo(name)?.text ?? null;
  }

  // Always closed before returning. A caller's next step is the button that saves the form, and
  // the keyboard covers the bottom third of the screen - so leaving it open turned "Add this
  // person" into a control the harness could not find (and, with a `waitForNamed` deadline, into
  // forty-five seconds of looking for it).
  dismissKeyboard();
  return { typed: held === value, held };
}

/**
 * Encode a value for `adb shell input text`.
 *
 * A space ends the argument as far as the device's shell is concerned, so `input text` receives
 * only the first word - which is how "Synthetic Relative D" reached a form as "Synthetic" and the
 * run reported a field the app had refused. `input` reads `%s` as a space, which is the documented
 * way through, and single quotes keep the rest of the string away from the shell.
 */
export function forInputText(value: string): string {
  return `'${value.replace(/'/g, String.fromCharCode(39, 92, 39, 39)).replace(/ /g, '%s')}'`;
}

/** Close the soft keyboard, so the control underneath it can be found again. */
export function dismissKeyboard(): void {
  adb(['shell', 'input', 'keyevent', '111']);
  sleep(1_500);
}

/**
 * Turn off the stylus-handwriting tutorial, which opens over a text field and eats what is typed.
 *
 * Done once at the start of a run rather than recovered from, because recovering means noticing -
 * and what it looks like from the outside is a form that ignored two attempts at typing.
 */
export function suppressStylusHandwriting(): void {
  adb(['shell', 'settings', 'put', 'secure', 'stylus_handwriting_enabled', '0']);
}

/**
 * Wake the screen and stop it going off again.
 *
 * An emulator left alone between runs turns its display off, and a display that is off has no view
 * hierarchy: `uiautomator dump` answers "null root node" for every read. Nothing about that says
 * "the screen is off" - it is the same answer a dump gives during a transition - so `scrollTo`
 * treats it as "keep going", `waitForNamed` waits out its whole deadline, and a run spends twenty
 * minutes concluding that a control is missing from a screen nobody was looking at. The first
 * check to fail then reads as a finding about the app.
 *
 * `stayon true` is the emulator setting a harness wants and a phone's owner would not: it belongs
 * with the seeded database and the development identity, on a device nobody is using.
 */
export function keepScreenAwake(): void {
  adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  adb(['shell', 'svc', 'power', 'stayon', 'true']);
  sleep(1_000);
}

/**
 * Everything a run needs done to the device before it drives anything.
 *
 * One call, so a new harness cannot forget half of it. Both members are here because a run once
 * failed without them and the failure looked like the app's fault in both cases.
 */
export function prepareDeviceForDriving(): void {
  keepScreenAwake();
  suppressStylusHandwriting();
}

/**
 * Wait until the app is drawing its tab bar, and say whether it ever did.
 *
 * Replaces a fixed sleep. A cold start behind Metro takes anywhere between fifteen and fifty
 * seconds depending on whether the bundle is cached, so a fixed wait is either a run that fails on
 * a slow start or forty-five seconds added to every run that did not need them. Waiting on a
 * control the app only draws once it is up is both faster and the thing actually being waited for.
 */
export function waitForAppReady(timeoutMs = 90_000): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const nodes = currentNodes(2);
    if (nodes !== null && nodeNamed(nodes, 'Shelf') !== null) return true;
    if (Date.now() >= deadline) return false;
    sleep(2_000);
  }
}

export function pressHome(): void {
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
  sleep(3_000);
}

export function launch(): void {
  adb(['shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`]);
}

/** The app's process id, or `null` where it is not running. */
export function processId(): string | null {
  const pid = adb(['shell', 'pidof', PACKAGE]).stdout.trim();
  return pid === '' ? null : pid;
}

/**
 * Kill the app's process.
 *
 * `am kill`, never `force-stop`: force-stop additionally cancels every alarm the app registered
 * and puts it in the stopped state, which is a different scenario and one that breaks reminders
 * (`DEV-041`). The app is backgrounded first because `am kill` will not touch a foreground
 * process - Android kills only what is already killable - and a run that skips this reports a
 * journal surviving a death that never happened.
 */
export function killApp(): { readonly before: string | null; readonly after: string | null } {
  const before = processId();
  pressHome();
  adb(['shell', 'am', 'kill', PACKAGE]);
  sleep(5_000);
  return { before, after: processId() };
}

/** Whether anything on screen is telling the person something went wrong. */
export function screenShowsFailure(): boolean {
  const nodes = currentNodes();
  if (nodes === null) return false;
  return nodes.some((node) => {
    if (node.packageName !== PACKAGE) return false;
    const text = accessibleNameOf(node);
    return /not saved|could not be saved|Uncaught Error|went wrong/i.test(text);
  });
}

/**
 * What the screen looked like when a step could not be taken.
 *
 * A device harness that stops has to say more than "the control was not there". Reproducing a
 * failure costs a full run - fifteen minutes of launching, scrolling and killing - and the run
 * that reproduces it may not fail the same way. So the screen is written down at the moment it
 * mattered: a screenshot for a person, and the accessible names for whoever is deciding what the
 * harness should have looked for.
 *
 * Returns the paths, so the check that failed can name them in its own report.
 */
export function captureFailure(label: string, directory = 'scratchpad'): readonly string[] {
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    return [];
  }

  const stamp = `${label}-${String(Date.now())}`;
  const written: string[] = [];

  const png = adbBytes(['exec-out', 'screencap', '-p']);
  if (png !== null) {
    const path = join(directory, `${stamp}.png`);
    writeFileSync(path, png);
    written.push(path);
  }

  const nodes = currentNodes();
  const path = join(directory, `${stamp}.txt`);
  writeFileSync(
    path,
    nodes === null
      ? 'The hierarchy could not be read at all.\n'
      : nodes
          .filter((node) => node.packageName === PACKAGE)
          .map(
            (node) =>
              `${node.clickable ? 'TAP ' : '    '}${node.className.padEnd(30)} ` +
              `[${String(node.bounds.left)},${String(node.bounds.top)}]` +
              `[${String(node.bounds.right)},${String(node.bounds.bottom)}] ` +
              JSON.stringify(accessibleNameOf(node)),
          )
          .join('\n') + '\n',
    'utf8',
  );
  written.push(path);

  return written;
}
