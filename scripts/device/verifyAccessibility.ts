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
  crashedApp,
  isInteractiveTarget,
  parseUiHierarchy,
  checkScreen,
} from './accessibility.js';
import { formatReport, overallStatus, type Check } from './analysis.js';

const TALKBACK_SERVICE =
  'com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService';

/** The five primary destinations (`06`). */
const TABS = ['Today', 'Shelf', 'Safety', 'Care', 'You'] as const;

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

    // The largest scale the app claims to support. Beyond it `scaledFontSize` clamps, so this is
    // the boundary rather than an arbitrary large number.
    setFontScale(MAX_SUPPORTED_FONT_SCALE);
    relaunch();
    checks.push(...screensAt(MAX_SUPPORTED_FONT_SCALE, density));
  } finally {
    setFontScale(original);
  }

  checks.push(...withTalkBack());

  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

main();
