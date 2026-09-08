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

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_TOUCH_TARGET_DP, MAX_SUPPORTED_FONT_SCALE } from '@kynviora/presentation';
import {
  PACKAGE,
  adb,
  densityDpi,
  dumpUiHierarchy,
  fontScale,
  isInstalled,
  screencapRaw,
  setFontScale,
  sleep,
} from './adb.js';
import {
  accessibleNameOf,
  clipRectsOf,
  crashedApp,
  dragAnchorAvoidingFields,
  hasDevelopmentOverlay,
  isInteractiveTarget,
  parseUiHierarchy,
  sizeInDp,
  checkScreen,
  type UiNode,
} from './accessibility.js';
import {
  describeOffender,
  foldDump,
  offendingNodes,
  sheetChecks,
  type OffendingNode,
  type SheetSurvey,
  type SurveyedControl,
} from './sheets.js';
import { captureFailure, scrollDown, scrollDownFrom, scrollUp, waitForAppReady } from './ui.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import { colourShares, decodeScreencap, judgeTheme, parseNightMode, readTheme } from './theme.js';

/** TalkBack's own package, which has its own runtime permission to ask for. */
const TALKBACK_PACKAGE = 'com.google.android.marvin.talkback';

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
  // Voice Mode (DEC-136). Surveyed as a sheet even though it is not one: it is a full screen
  // whose controls are sized by their content, which is the property that makes a sheet worth
  // surveying rather than the property of being a form.
  //
  // It is also the surface where the measurement matters most. `18`'s audience is the audience
  // Voice Mode exists for, its confirmation controls are the largest in the app on purpose, and
  // at twice the font size a screen holding a transcript, a state block, a confirmation and a
  // text field is the one most likely to push something below the fold.
  { label: 'Voice Mode', path: ['Talk to Kynviora'] },
];

/**
 * How many scroll steps a survey will take before giving up on reaching the bottom.
 *
 * A safety net, not a budget: a survey normally ends when a dump matches the previous one, which
 * is the sheet having stopped moving. Reaching this number instead means the survey **never saw
 * the end of the form**, and that is reported rather than treated as the end (see
 * {@link SheetSurvey.reachedEnd}).
 *
 * Twelve was too few. The invitation form at font scale 2 is six cards of scaled text, and a
 * survey that stopped part-way down reported its last control as one nobody can reach - which is
 * `DEV-079` exactly: a harness parameter too small for a form, rendered as a product defect. The
 * cost of a larger number is seconds on a run that converges long before it.
 */
const MAX_SURVEY_STEPS = 30;

/**
 * Where a retry drag may begin, as screen pixels.
 *
 * Above the tab bar, which is not part of the sheet, and below the heading, which does not scroll
 * with the content on every screen. The band is searched from its bottom upwards because a drag
 * started low travels furthest before running out of screen.
 */
const SHEET_DRAG_BAND = Object.freeze({ top: 700, bottom: 1_900 });

/**
 * The safety net on scrolling to find a control, not the budget.
 *
 * `pressNamed` stops when the screen stops moving, which is what actually decides; this only
 * bounds a screen that never settles. It is generous because the Care list grows by one revoked
 * grant per caregiver run and each row is tall at twice the font size.
 */
const MAX_SCROLL_TO_FIND = 60;

// ---------------------------------------------------------------------------
// Capturing an offending node while it is still on screen
// ---------------------------------------------------------------------------

/**
 * Where a capture goes. The same place `captureFailure` writes, which is where every other device
 * harness leaves its evidence.
 */
const CAPTURE_DIRECTORY = 'scratchpad';

/**
 * How many captures a whole run may take.
 *
 * A cap rather than a switch, because a survey that found a genuinely unnamed control on every
 * sheet at every scroll position would otherwise write a hundred screenshots - and the run this
 * exists for is one that finds a single node once. Eight is more than enough to characterise
 * something intermittent and small enough that a bad run costs a few megabytes.
 */
const MAX_OFFENDER_CAPTURES = 8;

let capturesTaken = 0;

/**
 * The kinds already captured, so a control that offends at every scroll position costs one capture.
 *
 * Keyed by what identifies a node rather than by where it was: a real control of the app's scrolls,
 * so its bounds differ in every dump while it is the same finding, and keying on bounds would spend
 * the whole budget on one control before a second kind was ever seen.
 */
const capturedKinds = new Set<string>();

function fileSafe(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Write down an offending node at the moment it is on screen, and say so on stdout.
 *
 * WHY AT THIS MOMENT AND NOT WHEN THE CHECK FAILS
 * Because there is nothing left to look at by then. A survey folds every dump into a set of
 * controls keyed by name, scrolls on, closes the sheet and relaunches the app before `SHEET-3` and
 * `SHEET-4` are ever evaluated - so the run that reported an unnamed 20x20dp node on the
 * invitation form could say only that it had counted one. It was re-run three times and passed
 * three times, which is precisely how an intermittent red result becomes a red result nobody acts
 * on.
 *
 * A screenshot, the raw hierarchy for that exact scroll position, and the node's own attributes on
 * stdout. The screenshot comes first inside `captureFailure`, which matters if the thing on screen
 * is a platform decoration that hides itself after a few seconds.
 */
function recordOffender(
  sheet: string,
  scale: number,
  step: number,
  nodes: readonly UiNode[],
  offender: OffendingNode,
  xml: string,
  density: number,
): void {
  const kind =
    `${offender.node.className}|${offender.node.resourceId}|` +
    `${accessibleNameOf(offender.node)}|${offender.offences.join(',')}`;
  if (capturedKinds.has(kind)) return;
  if (capturesTaken >= MAX_OFFENDER_CAPTURES) return;
  capturedKinds.add(kind);
  capturesTaken += 1;

  const label = `a11y-offender-${fileSafe(sheet)}-scale${String(scale)}-step${String(step)}`;
  const written = [...captureFailure(label, CAPTURE_DIRECTORY)];

  // The hierarchy exactly as it was read, rather than a fresh dump: a second dump is a second
  // moment, and a node that appears once in four runs is not guaranteed to still be there.
  const screenshot = written.find((path) => path.endsWith('.png'));
  const xmlPath =
    screenshot === undefined
      ? join(CAPTURE_DIRECTORY, `${label}-${String(Date.now())}.xml`)
      : `${screenshot.slice(0, -'.png'.length)}.xml`;
  try {
    writeFileSync(xmlPath, xml, 'utf8');
    written.push(xmlPath);
  } catch {
    // A capture that cannot be written is not a reason to stop surveying. The stdout block below
    // still carries the node's attributes, which is the part that answers what it was.
  }

  process.stdout.write(
    `\nA node that will fail a check was on screen during the "${sheet}" survey at font scale ` +
      `${String(scale)}, scroll position ${String(step)}:\n` +
      `${describeOffender(nodes, offender, density)}\n` +
      `  written:   ${written.join(', ')}\n\n`,
  );
}

/**
 * Start the app from dead and wait until it is drawing, rather than for a fixed time.
 *
 * It used to `sleep(30_000)`, with a comment naming the exact failure that eventually happened: "a
 * dump taken too early reports a screen with no controls - which the checks correctly refuse to
 * call a pass, and which is a wasted run." Thirty seconds is not a property of anything. A cold
 * start behind Metro takes fifteen to fifty seconds depending on whether the bundle is cached, and
 * at font scale 2 the layout pass costs more again - so on 2026-09-07, on an emulator that had been
 * driven for hours, the first sheet at scale 2 was surveyed against a blank screen and reported
 * `INCONCLUSIVE` (`DEV-080`).
 *
 * `waitForAppReady` waits for the thing actually being waited for - the tab bar - and its own
 * comment says it exists to replace this sleep. Bounded at ninety seconds; `false` means the app
 * did not draw, which is a condition the caller has to report rather than measure through.
 *
 * It is also **faster** on a healthy machine, which matters more than it sounds: a survey makes a
 * dozen relaunches, so a fixed thirty seconds is six minutes of a run spent waiting for something
 * that had already happened - and a survey nobody re-runs after a fix is a survey whose red
 * results stop being acted on.
 */
function relaunch(): boolean {
  adb(['shell', 'am', 'force-stop', PACKAGE]);
  adb(['shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`]);
  return waitForAppReady();
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
  // An app that never drew is not a sheet that would not open, and `sheetChecks` renders both as
  // `INCONCLUSIVE` - which is the right status and the wrong sentence. Reported as unopened here
  // because that is all this function can honestly say; what it could not do is start.
  if (!relaunch()) {
    return {
      label,
      fontScale: scale,
      opened: false,
      positions: 0,
      controls: [],
      developmentOverlaySeen: false,
      reachedEnd: false,
    };
  }

  for (const control of path) {
    if (!pressNamed(control)) {
      return {
        label,
        fontScale: scale,
        opened: false,
        positions: 0,
        controls: [],
        developmentOverlaySeen: false,
        reachedEnd: false,
      };
    }
  }

  for (let up = 0; up < MAX_SURVEY_STEPS; up += 1) scrollUp();
  sleep(1_500);

  const density = densityDpi();
  let controls: readonly SurveyedControl[] = [];
  let positions = 0;
  let previous = '';
  /** Whether LogBox was drawn over the sheet at any point. Reported on `SHEET-1`. */
  let developmentOverlaySeen = false;
  /** Whether the standard anchor has already failed to move this position. See the note below. */
  let retried = false;
  /** Whether the sheet stopped moving, rather than the survey running out of steps. */
  let reachedEnd = false;

  for (let step = 0; step <= MAX_SURVEY_STEPS; step += 1) {
    const xml = dumpUiHierarchy();
    if (xml === null) {
      sleep(1_500);
      continue;
    }
    const nodes = parseUiHierarchy(xml);
    const clips = clipRectsOf(nodes);
    // The five destinations are excluded: they are drawn over every sheet, they are not part of
    // one, and `checkScreen` measures them at both scales already.
    controls = foldDump(controls, nodes, clips, PACKAGE, density, TABS, step);
    if (hasDevelopmentOverlay(nodes)) developmentOverlaySeen = true;
    positions += 1;

    // Before scrolling on. Anything here would fail `SHEET-3` or `SHEET-4`, and this is the last
    // moment it can be looked at: the checks run after the sheet has been closed and the app
    // relaunched, so a finding they report has nothing behind it unless it was captured now.
    for (const offender of offendingNodes(
      nodes,
      clips,
      PACKAGE,
      density,
      MIN_TOUCH_TARGET_DP,
      TABS,
    )) {
      recordOffender(label, scale, step, nodes, offender, xml, density);
    }

    // A dump identical to the last one means the sheet has stopped moving, which is the honest end
    // of a survey - a fixed number of swipes would either stop early on a long form or waste a
    // minute on a short one.
    //
    // It means that **only if the swipe was actually applied**. A drag beginning inside a text
    // field is taken as text selection and the list does not move at all, so on a form at font
    // scale 2 - which is mostly fields, drawn tall - an unchanged dump was evidence the swipe had
    // been eaten rather than evidence the form had ended. That is how a survey reported "Save" as
    // never reachable on a sheet whose Save button sits 400px above the tab bar (`DEV-079`), which
    // is a false FAIL and the exact mirror of the false PASS `DEV-046` was about.
    //
    // So an unchanged dump is now a reason to swipe from somewhere else, once, before believing
    // it: `dragAnchorAvoidingFields` picks the lowest row on screen that no field occupies, and a
    // dump unchanged after **that** is a sheet that has genuinely stopped.
    const signature = nodes
      .map((node) => `${accessibleNameOf(node)}@${String(node.bounds.top)}`)
      .join('|');
    if (signature === previous) {
      if (retried) {
        reachedEnd = true;
        break;
      }
      retried = true;
      const anchor = dragAnchorAvoidingFields(nodes, PACKAGE, SHEET_DRAG_BAND);
      if (anchor === null) {
        reachedEnd = true;
        break;
      }
      scrollDownFrom(anchor);
      sleep(1_200);
      continue;
    }
    previous = signature;
    retried = false;

    scrollDown();
    sleep(1_200);
  }

  return {
    label,
    fontScale: scale,
    opened: true,
    positions,
    controls,
    developmentOverlaySeen,
    reachedEnd,
  };
}

function sheetsAt(scale: number): readonly Check[] {
  const checks: Check[] = [];
  for (const sheet of SHEETS) {
    if (ONLY_SHEET !== null && sheet.label !== ONLY_SHEET) continue;
    checks.push(...sheetChecks(surveySheet(sheet.label, sheet.path, scale), MIN_TOUCH_TARGET_DP));
  }
  return checks;
}

/**
 * What the phone actually paints, in both directions.
 *
 * WHY BOTH DIRECTIONS
 * `DEV-077` was an app stuck in light on a phone in dark mode, and a check that only put the
 * system into dark mode would pass just as happily over an app stuck in **dark**. What is being
 * asserted is that the app follows the system, and that needs the system moved twice.
 *
 * WHY THIS IS NOT A UNIT TEST
 * Because no unit test could have found what it is looking for. Both themes were asserted at AA
 * in Node, by tests that all passed, over a build in which one of them could not be reached from
 * a phone at all - the cause was `"userInterfaceStyle": "light"` in `app.json`, which is exactly
 * the kind of change every unit test passes through (DEC-137).
 *
 * The setting is read before it is moved and put back afterwards as itself, because `auto` and
 * `custom_schedule` are choices a person made and restoring `no` over one of them would be this
 * harness changing a device on its way out.
 */
function themeChecks(): readonly Check[] {
  const before = parseNightMode(adb(['shell', 'cmd', 'uimode', 'night']).stdout);
  const checks: Check[] = [];

  try {
    for (const [mode, expected] of [
      ['no', 'LIGHT'],
      ['yes', 'DARK'],
    ] as const) {
      adb(['shell', 'cmd', 'uimode', 'night', mode]);
      const applied = parseNightMode(adb(['shell', 'cmd', 'uimode', 'night']).stdout);

      if (applied !== mode) {
        checks.push({
          id: `THEME-1@${expected}`,
          title: `The device accepted ${expected} mode`,
          status: 'INCONCLUSIVE',
          detail:
            `\`cmd uimode night ${mode}\` left the setting at ` +
            `${applied ?? 'something this could not read'}, so nothing was measured about the ` +
            `${expected} theme. A reading taken now would be about the other one.`,
        });
        continue;
      }

      if (!relaunch()) {
        checks.push({
          id: `THEME-1@${expected}`,
          title: `The device accepted ${expected} mode and the app came back`,
          status: 'INCONCLUSIVE',
          detail:
            'The app did not draw its tab bar within ninety seconds of a cold start in ' +
            `${expected} mode, so the frame that would have been read is of nothing (DEC-102).`,
        });
        continue;
      }

      checks.push({
        id: `THEME-1@${expected}`,
        title: `The device accepted ${expected} mode and the app came back`,
        status: 'PASS',
        detail: `Night mode is ${mode} and the app relaunched into it.`,
      });

      // A configuration change restarts the activity and the first frames after it are a
      // transition. Reading one would report the theme the app was leaving.
      sleep(2_000);

      const raw = screencapRaw();
      const frame = raw === null ? null : decodeScreencap(raw);
      if (frame === null) {
        checks.push({
          id: `THEME-2@${expected}`,
          title: `The app painted its ground in ${expected}`,
          status: 'INCONCLUSIVE',
          detail:
            raw === null
              ? '`adb exec-out screencap` returned nothing, so no colour was read.'
              : `The framebuffer was ${String(raw.length)} bytes and matched neither header this ` +
                'decodes, so no colour was read. A guessed header would be a confident answer ' +
                'about the wrong bytes.',
        });
        continue;
      }

      const verdict = judgeTheme(readTheme(colourShares(frame)), expected);
      if (verdict.status !== 'PASS') captureFailure(`theme-${mode}`);
      checks.push({
        id: `THEME-2@${expected}`,
        title: `The app painted its ground in ${expected}`,
        status: verdict.status,
        detail: verdict.detail,
      });
    }
  } finally {
    if (before !== null) adb(['shell', 'cmd', 'uimode', 'night', before]);
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

  // Before enabling it. TalkBack asks for `POST_NOTIFICATIONS` the first time it starts, and its
  // dialog is a full-screen `permissioncontroller` window over whatever is behind it - so the
  // hierarchy read below contains no app node at all and the run reports the app as having no
  // controls. It is the same trap the camera harness records: a permission prompt from something
  // that is not the app under test eats the screen, and the failure reads as a defect in the app
  // (trap 201).
  //
  // Granted rather than dismissed, because dismissing it is a tap and `tapNamed` filters to the
  // app's own package by design.
  adb(['shell', 'pm', 'grant', TALKBACK_PACKAGE, 'android.permission.POST_NOTIFICATIONS']);

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

/**
 * Which part of the survey to run, and at which scales.
 *
 * A full survey is twenty-two checks over ten cold starts and takes the better part of an hour on
 * a healthy emulator - longer on one that has been driven all day. That is the right cost for a
 * regression round and the wrong cost for **re-running the one check a fix was about**: a survey
 * nobody re-runs after a fix is a survey whose red results stop being acted on, which is the habit
 * `DEV-079` is a warning about.
 *
 * So the same affordance `verifySignIn.ts` has for its own reason (`KYNVIORA_SIGNIN_PHASES`), for
 * a different one. The default is everything, so a plain `npm run verify:device:a11y` is unchanged
 * and no run is narrowed by accident.
 *
 *   KYNVIORA_A11Y_PARTS=sheets       destinations | sheets | talkback, comma-separated
 *   KYNVIORA_A11Y_SHEETS=Add a medicine     one sheet label, or all of them
 *   KYNVIORA_A11Y_SCALES=2           1 | 2 | 1,2
 *
 * A narrowed run says so in its report, because "7/7 PASS" over a seventh of the survey is not the
 * same claim as "7/7 PASS" and a reader two weeks later cannot tell them apart.
 */
/** Every part there is. Named, so an unrecognised one is a stop rather than a silent omission. */
const ALL_PARTS = ['destinations', 'sheets', 'talkback', 'theme'] as const;

/**
 * The parts asked for, or `null` where a name was not one.
 *
 * `null` rather than "ignore what I did not recognise": `KYNVIORA_A11Y_PARTS=destinations,sheets,x`
 * would otherwise run two parts of three while `PARTS.size === 3` reported a full survey, and a
 * typo would silently drop TalkBack from a regression round.
 */
const PARTS: ReadonlySet<string> | null = ((): ReadonlySet<string> | null => {
  const asked = (process.env.KYNVIORA_A11Y_PARTS ?? ALL_PARTS.join(','))
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (asked.some((part) => !(ALL_PARTS as readonly string[]).includes(part))) return null;
  return new Set(asked);
})();

/**
 * The scales asked for, de-duplicated.
 *
 * De-duplicated because the count is what says whether the run was narrowed, and
 * `KYNVIORA_A11Y_SCALES=1,1` is a run that never reaches font scale 2 - which is the half that
 * matters - while looking like a full one.
 */
const SCALES: readonly number[] = [
  ...new Set(
    (process.env.KYNVIORA_A11Y_SCALES ?? '1,2')
      .split(',')
      .map((entry) => Number(entry.trim()))
      .filter((entry) => entry === 1 || entry === 2),
  ),
].map((entry) => (entry === 2 ? MAX_SUPPORTED_FONT_SCALE : 1));

/** The sheet label to survey, or `null` for all of them. */
const ONLY_SHEET: string | null = process.env.KYNVIORA_A11Y_SHEETS?.trim() || null;

/**
 * Whether this run covered less than the whole survey.
 *
 * Measured against what was actually run rather than against what was asked for, which is the
 * distinction the first draft of this got wrong in both directions.
 */
function narrowed(): boolean {
  return (
    PARTS === null || PARTS.size !== ALL_PARTS.length || SCALES.length !== 2 || ONLY_SHEET !== null
  );
}

function main(): void {
  if (!isInstalled()) {
    process.stdout.write(`${PACKAGE} is not installed on the attached device.\n`);
    process.exitCode = 1;
    return;
  }

  if (PARTS === null) {
    process.stdout.write(
      `KYNVIORA_A11Y_PARTS named something that is not a part of this survey. ` +
        `The parts are: ${ALL_PARTS.join(', ')}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (SCALES.length === 0) {
    process.stdout.write('KYNVIORA_A11Y_SCALES named no scale this survey can run at.\n');
    process.exitCode = 1;
    return;
  }

  const density = densityDpi();
  const original = fontScale();
  const checks: Check[] = [];

  try {
    // Scale 2 is the largest the app claims to support - beyond it `typeStyle` clamps, so it is a
    // boundary rather than an arbitrary large number - and the sheets at that scale are the run
    // that matters. A form's rows are sized by their content, so that is where one stops fitting,
    // and `DEV-046` happened on a build reporting 34/34 over the five destinations alone.
    for (const scale of SCALES) {
      setFontScale(scale);
      // Reported, not measured through. `relaunch` answers `false` when the app never drew, and a
      // destination survey run against a blank screen reports "no control named Today was found"
      // - which reads as the app having lost its tab bar (DEC-102, `DEV-080`).
      if (!relaunch()) {
        checks.push({
          id: `A11Y-0@${String(scale)}`,
          title: `The app started at font scale ${String(scale)}`,
          status: 'INCONCLUSIVE',
          detail:
            'The app did not draw its tab bar within ninety seconds of a cold start, so nothing ' +
            'at this font scale was measured. A run that reported its controls would be ' +
            'describing a blank screen.',
        });
        continue;
      }
      if (PARTS.has('destinations')) checks.push(...screensAt(scale, density));
      if (PARTS.has('sheets')) checks.push(...sheetsAt(scale));
    }
  } finally {
    setFontScale(original);
  }

  if (PARTS.has('theme')) checks.push(...themeChecks());
  if (PARTS.has('talkback')) checks.push(...withTalkBack());

  process.stdout.write(`${formatReport(checks)}\n`);

  // Said after the report rather than before it, and said at all because a narrowed run's
  // "PASS" is a different claim from a whole survey's. A reader two weeks later has the
  // report and not the command line that produced it.
  if (narrowed()) {
    process.stdout.write(
      '\nThis was a NARROWED run and is not a full accessibility survey.\n' +
        `  parts:  ${[...(PARTS ?? [])].join(', ')}\n` +
        `  scales: ${SCALES.map((scale) => String(scale)).join(', ')}\n` +
        `  sheets: ${ONLY_SHEET ?? 'all'}\n` +
        'Run `npm run verify:device:a11y` with no KYNVIORA_A11Y_* set for the whole thing.\n',
    );
  }

  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

main();
