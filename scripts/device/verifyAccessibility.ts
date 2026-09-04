/**
 * Measure the rendered app against `18`'s accessibility rules, at two font scales.
 *
 * Spec references: `18` (48dp minimum target, every control named, no meaning by colour alone),
 * `04` Phase 9.4, `19` (TalkBack smoke suite), `BLK-002`.
 *
 *   npm run verify:device:a11y
 *
 * WHY TWICE
 * At the default scale a layout sized in `dp` passes by construction. `MAX_SUPPORTED_FONT_SCALE`
 * is 2.0 and the presentation layer clamps to it, so 2.0 is the largest thing the app claims to
 * support - and it is where a control sized in `dp` and a label sized in scaled pixels stop
 * agreeing. Running only at 1.0 tests the arithmetic in `tokens.ts`, which already has tests.
 *
 * WHAT TALKBACK IS AND IS NOT USED FOR
 * The run enables TalkBack, walks the tabs, and requires the app to keep running and keep
 * rendering named controls. That is a smoke test in the sense `19` uses the word: it shows the
 * app does not fall over under a screen reader and that what a screen reader would find has
 * names. It is not a substitute for somebody listening to it, and the report says so.
 *
 * The scale is restored afterwards whatever happens, and so is TalkBack.
 */

import { MIN_TOUCH_TARGET_DP, MAX_SUPPORTED_FONT_SCALE } from '@kynviora/presentation';
import {
  PACKAGE,
  adb,
  densityDpi,
  dumpUiHierarchy,
  fontScale,
  isInstalled,
  setFontScale,
  sleep,
} from './adb.js';
import {
  accessibleNameOf,
  clipRectsOf,
  crashedApp,
  isInteractiveTarget,
  parseUiHierarchy,
  sizeInDp,
  checkScreen,
  type UiNode,
} from './accessibility.js';
import { foldDump, sheetChecks, type SheetSurvey, type SurveyedControl } from './sheets.js';
import { scrollDown, scrollUp } from './ui.js';
import { formatReport, overallStatus, type Check } from './analysis.js';

const TALKBACK_SERVICE =
  'com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService';

/** The five primary destinations (`06`). */
const TABS = ['Today', 'Shelf', 'Safety', 'Care', 'You'] as const;

/**
 * The sheets and forms, and how each is reached.
 *
 * Chosen for what they are rather than for being convenient: each is a **form**, each is at least
 * two taps in, and between them they cover every kind of control this app has - a text field, a
 * radio row, a day toggle, a checkbox list, and a screen whose whole purpose is one confirmation.
 *
 * A destination is one screen's worth of chrome and its controls are sized in `dp`; at twice the
 * font size they pass by construction. A form's rows are sized by their content, and it is the
 * thing that stops fitting - `DEV-046` was a sheet three taps in whose controls were drawn below
 * the fold with no way to scroll to them, on a build reporting 34/34.
 *
 * "Invite someone" is first because it is the one that broke, and because it is longer now than
 * when it was last measured: DEC-116 added a capability row to it.
 */
const SHEETS: readonly {
  readonly label: string;
  /** The controls to press, in order, from a freshly launched app. */
  readonly path: readonly string[];
}[] = [
  { label: 'Invite someone', path: ['Care', 'Invite someone'] },
  { label: 'Record what happened', path: ['Shelf', 'Record what happened'] },
  { label: 'The schedule editor', path: ['Shelf', 'When do you take this?', 'Add a schedule'] },
  { label: 'Add a medicine', path: ['Shelf', 'Add a medicine'] },
];

/** How many scroll steps a survey will take before deciding it has seen the whole sheet. */
const MAX_SURVEY_STEPS = 12;

/**
 * The safety net on scrolling to find a control, not the budget.
 *
 * `pressNamed` stops when the screen stops moving, which is what actually decides; this only
 * bounds a screen that never settles. It is generous because the Care list grows by one revoked
 * grant per caregiver run and each row is tall at twice the font size.
 */
const MAX_SCROLL_TO_FIND = 60;

function relaunch(): void {
  adb(['shell', 'am', 'force-stop', PACKAGE]);
  adb(['shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`]);
  // A cold start plus a keystore round trip plus a first fetch. At the larger font scale the
  // layout pass costs more again, and a dump taken too early reports a screen with no controls -
  // which the checks correctly refuse to call a pass, and which is a wasted run.
  sleep(30_000);
}

/**
 * Tap a tab by finding it, rather than by a coordinate.
 *
 * The first version used fixed coordinates for a 1080-wide screen. At font scale 2 the tab bar is
 * taller, every tap landed somewhere else, and four of the five screens were reported against a
 * hierarchy that was still Today - which read as four inconclusive results rather than as the
 * harness missing.
 */
function openTab(label: string): boolean {
  const xml = dumpUiHierarchy();
  if (xml === null) return false;

  const target = parseUiHierarchy(xml).find(
    (node) =>
      node.packageName === PACKAGE && isInteractiveTarget(node) && accessibleNameOf(node) === label,
  );
  if (target === undefined) return false;

  const x = Math.round((target.bounds.left + target.bounds.right) / 2);
  const y = Math.round((target.bounds.top + target.bounds.bottom) / 2);
  adb(['shell', 'input', 'tap', String(x), String(y)]);
  sleep(8_000);
  return true;
}

function screensAt(scale: number, density: number): readonly Check[] {
  const checks: Check[] = [];
  for (const label of TABS) {
    if (!openTab(label)) {
      checks.push({
        id: `A11Y-0/${label}@${String(scale)}`,
        title: `The ${label} destination could be opened`,
        status: 'INCONCLUSIVE',
        detail:
          `No control named "${label}" was found to tap at font scale ${String(scale)}, so the ` +
          'screen was never reached and nothing about it was measured.',
      });
      continue;
    }
    const perScreen = checkScreen({
      label,
      packageName: PACKAGE,
      xml: dumpUiHierarchy(),
      densityDpi: density,
      fontScale: scale,
      minimumTouchTargetDp: MIN_TOUCH_TARGET_DP,
    });
    // Ids repeat across screens, so each is qualified by what it was looking at.
    checks.push(
      ...perScreen.map((check) => ({ ...check, id: `${check.id}/${label}@${String(scale)}` })),
    );
  }
  return checks;
}

/** What the screen looks like now, for deciding whether a scroll moved anything. */
function signatureOf(nodes: readonly UiNode[]): string {
  return nodes.map((node) => `${accessibleNameOf(node)}@${String(node.bounds.top)}`).join('|');
}

/**
 * Press a control by its accessible name, scrolling until it is found or the screen stops moving.
 *
 * By name and not by coordinate, for `openTab`'s reason: a coordinate that is right at font scale
 * 1 is wrong at 2, and a tap that lands somewhere else reports the screen underneath.
 *
 * WHY IT SCROLLS UNTIL THE SCREEN STOPS RATHER THAN A FIXED NUMBER OF TIMES
 * Because the screens it starts from grow. Every caregiver run leaves a revoked grant behind - on
 * purpose, because `08.2` wants the audit trail - so the Care list is longer after every run, and
 * at twice the font size each row is enormous. A fixed budget of twelve swipes reached the bottom
 * for a while and then quietly stopped, and the run reported "the taps that open this sheet did
 * not land", which reads as the app having lost a control it still has.
 *
 * Stopping when a dump matches the previous one is the honest end: the list has stopped moving, so
 * the control is not on it. The cap is a safety net for a screen that never settles, not the
 * measurement.
 */
function pressNamed(label: string): boolean {
  let previous = '';

  for (let step = 0; step <= MAX_SCROLL_TO_FIND; step += 1) {
    const xml = dumpUiHierarchy();
    if (xml !== null) {
      const nodes = parseUiHierarchy(xml);
      const target = nodes.find(
        (node) =>
          node.packageName === PACKAGE &&
          isInteractiveTarget(node) &&
          accessibleNameOf(node) === label &&
          // Big enough to be safe to press. Not `isFullyVisible`: that treats an edge coinciding
          // with a container's as clipped, which is right for measuring and wrong here - the
          // leftmost and rightmost tabs touch the screen's own edges by design. What trap 194 is
          // actually about is a control reduced to a sliver, and its rendered size says that.
          sizeInDp(node, densityDpi()).height + 0.5 >= MIN_TOUCH_TARGET_DP,
      );
      if (target !== undefined) {
        const x = Math.round((target.bounds.left + target.bounds.right) / 2);
        const y = Math.round((target.bounds.top + target.bounds.bottom) / 2);
        adb(['shell', 'input', 'tap', String(x), String(y)]);
        sleep(6_000);
        return true;
      }
      const now = signatureOf(nodes);
      if (now === previous) return false;
      previous = now;
    }
    scrollDown();
    sleep(1_200);
  }
  return false;
}

/**
 * Open a sheet and survey it from top to bottom.
 *
 * The survey is the measurement. `checkScreen` asks what is on screen now, which is right for a
 * destination; a form has to be asked whether each of its controls can be brought into view *at
 * all*, because a Save button below the fold is not a control of unknown size - it is either
 * something a person can reach or something they cannot use (`DEV-046`).
 *
 * It scrolls back to the top first. A control above the current position is as invisible as one
 * below it, and the sheet may have been left part-way down by the taps that opened it.
 */
function surveySheet(label: string, path: readonly string[], scale: number): SheetSurvey {
  relaunch();

  for (const control of path) {
    if (!pressNamed(control)) {
      return { label, fontScale: scale, opened: false, positions: 0, controls: [] };
    }
  }

  for (let up = 0; up < MAX_SURVEY_STEPS; up += 1) scrollUp();
  sleep(1_500);

  const density = densityDpi();
  let controls: readonly SurveyedControl[] = [];
  let positions = 0;
  let previous = '';

  for (let step = 0; step <= MAX_SURVEY_STEPS; step += 1) {
    const xml = dumpUiHierarchy();
    if (xml === null) {
      sleep(1_500);
      continue;
    }
    const nodes = parseUiHierarchy(xml);
    // The five destinations are excluded: they are drawn over every sheet, they are not part of
    // one, and `checkScreen` measures them at both scales already.
    controls = foldDump(controls, nodes, clipRectsOf(nodes), PACKAGE, density, TABS);
    positions += 1;

    // A dump identical to the last one means the sheet has stopped moving, which is the honest end
    // of a survey - a fixed number of swipes would either stop early on a long form or waste a
    // minute on a short one.
    const signature = nodes
      .map((node) => `${accessibleNameOf(node)}@${String(node.bounds.top)}`)
      .join('|');
    if (signature === previous) break;
    previous = signature;

    scrollDown();
    sleep(1_200);
  }

  return { label, fontScale: scale, opened: true, positions, controls };
}

function sheetsAt(scale: number): readonly Check[] {
  const checks: Check[] = [];
  for (const sheet of SHEETS) {
    checks.push(...sheetChecks(surveySheet(sheet.label, sheet.path, scale), MIN_TOUCH_TARGET_DP));
  }
  return checks;
}

function withTalkBack(): readonly Check[] {
  const previous = adb([
    'shell',
    'settings',
    'get',
    'secure',
    'enabled_accessibility_services',
  ]).stdout.trim();

  const enabled = adb([
    'shell',
    'settings',
    'put',
    'secure',
    'enabled_accessibility_services',
    TALKBACK_SERVICE,
  ]).ok;
  adb(['shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1']);

  try {
    if (!enabled) {
      return [
        {
          id: 'TALKBACK-1',
          title: 'The app runs with a screen reader turned on',
          status: 'INCONCLUSIVE',
          detail: 'TalkBack could not be enabled on this device, so nothing was exercised.',
        },
      ];
    }

    adb(['logcat', '-c']);
    relaunch();

    // Deliberately no tapping. TalkBack takes over touch for exploration, so a synthetic single
    // tap is an explore gesture rather than an activation - navigation does not happen, and
    // driving its state machine with injected events crashed TalkBack itself on the first run.
    // What this can honestly show is that the app starts under a screen reader and that what a
    // screen reader would find still has names.
    const xml = dumpUiHierarchy();
    const crashed = crashedApp(adb(['logcat', '-d', '-s', 'AndroidRuntime:E']).stdout, PACKAGE);

    if (xml === null) {
      return [
        {
          id: 'TALKBACK-1',
          title: 'The app runs with a screen reader turned on',
          status: 'INCONCLUSIVE',
          detail: 'No view hierarchy could be captured while TalkBack was on.',
        },
      ];
    }

    return [
      {
        id: 'TALKBACK-1',
        title: 'The app runs with a screen reader turned on',
        status: crashed ? 'FAIL' : 'PASS',
        detail: crashed
          ? 'The app raised a fatal exception while TalkBack was enabled.'
          : 'The app started with TalkBack enabled and kept running, and its accessibility tree ' +
            'was still readable. This is a smoke test: it does not stand in for somebody ' +
            'listening to it, and it does not exercise navigation, because TalkBack intercepts ' +
            'touch and a synthetic tap is an explore gesture rather than an activation.',
      },
      ...checkScreen({
        label: 'the first screen with TalkBack on',
        packageName: PACKAGE,
        xml,
        densityDpi: densityDpi(),
        fontScale: fontScale(),
        minimumTouchTargetDp: MIN_TOUCH_TARGET_DP,
      }).map((check) => ({ ...check, id: `${check.id}/talkback` })),
    ];
  } finally {
    adb([
      'shell',
      'settings',
      'put',
      'secure',
      'enabled_accessibility_services',
      previous === '' || previous === 'null' ? 'null' : previous,
    ]);
    adb(['shell', 'settings', 'put', 'secure', 'accessibility_enabled', '0']);
  }
}

function main(): void {
  if (!isInstalled()) {
    process.stdout.write(`${PACKAGE} is not installed on the attached device.\n`);
    process.exitCode = 1;
    return;
  }

  const density = densityDpi();
  const original = fontScale();
  const checks: Check[] = [];

  try {
    setFontScale(1);
    relaunch();
    checks.push(...screensAt(1, density));
    checks.push(...sheetsAt(1));

    // The largest scale the app claims to support. Beyond it `scaledFontSize` clamps, so this is
    // the boundary rather than an arbitrary large number.
    setFontScale(MAX_SUPPORTED_FONT_SCALE);
    relaunch();
    checks.push(...screensAt(MAX_SUPPORTED_FONT_SCALE, density));
    // The sheets at the ceiling, which is the run that matters. A form's rows are sized by their
    // content, so this is where one stops fitting - and `DEV-046` happened on a build reporting
    // 34/34 over the five destinations alone.
    checks.push(...sheetsAt(MAX_SUPPORTED_FONT_SCALE));
  } finally {
    setFontScale(original);
  }

  checks.push(...withTalkBack());

  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

main();
