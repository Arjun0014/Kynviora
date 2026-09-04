/**
 * Prove - or fail to prove - that somebody's medicines do not reach the system log, and that
 * another app cannot decide what this one shows.
 *
 * Spec references: `14` ("Mobile security validation": privacy leakage, logging, platform
 * interaction, deep links/notifications), `15` (threat model), `16`, `20`, `19`, `04` Phase 9.2.
 *
 *   npm run verify:device:privacy
 *
 * WHY THESE TWO TOGETHER
 * `04` Phase 9.2 records MASVS local storage and key management as covered by `verify:device` and
 * the install path by `verify:device:update`, and lists network communication, platform
 * interaction, deep links and tampering as outstanding. These are the two of those that this build
 * can answer without a credential or a decision: what the running app puts on the log, and what a
 * link from another app can make it do.
 *
 * THE LOG IS OUTSIDE EVERY GUARANTEE THE REST OF THE BUILD MAKES
 * `verify:device` proves the local database is encrypted, that its key is keystore-wrapped, and
 * that four strings the app stored appear nowhere in the file's bytes. A medicine name written to
 * logcat walks around all of it: the log is readable by the platform and by anyone with a debug
 * bridge, and nothing in this repository governs it. The app's own source contains not one
 * `console.*` call, which is easy to check and proves nothing - what reaches the log is written by
 * React Native, by Expo's modules, and by whatever a library does with a response it could not
 * parse.
 *
 * WHAT IS ACTUALLY DONE TO THE DEVICE
 * The log is cleared, the app is force-stopped and cold-started, and it is driven through the
 * shelf, an item's own screen and its dose history - the three places a medicine name is on
 * screen. A dose is recorded with a note minted for this run, so the scan covers something the app
 * handled minutes ago rather than only strings that could have come from a bundle. Then the log is
 * read twice: once for the app's own process, and once for everything else.
 *
 * Afterwards the app is force-stopped again and a `kynviora://` link is fired from the shell,
 * which is another app's context as far as Android is concerned. It carries a profile ID that is
 * not this household's, and the shelf it lands on must show what an ordinary launch shows.
 *
 * WHAT IT NEEDS
 * The seeded API on `127.0.0.1:3000` (`KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev`), a
 * Metro bundler, and an attached device with the app installed. It establishes its own `adb
 * reverse` tunnels and refuses to run without them (trap 197).
 *
 * WHAT IT LEAVES BEHIND
 * One dose event, which is append-only by design, and a cleared log buffer.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { PACKAGE, adb, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import {
  appLogCheck,
  captureControlCheck,
  componentSurfaceCheck,
  deepLinkCheck,
  systemLogCheck,
  withoutInstrumentation,
  type SensitiveStrings,
} from './privacyLeakage.js';
import {
  captureFailure,
  coldStart,
  collectScreenText,
  prepareDeviceForDriving,
  processId,
  scrollToAndTap,
  scrollToAndTapBelow,
  suppressStylusHandwriting,
  tapNamed,
} from './ui.js';

const API_PORT = 3000;
const METRO_PORT = 8081;
const PROFILE_ID = '00000000-0000-4000-8000-00000000d020';
const MEDICINE_NAME = 'Synthetic Tablet A';

/**
 * A profile ID that is not this household's.
 *
 * Well-formed on purpose. A malformed one would be refused by a schema somewhere and the run would
 * measure input validation rather than whether a link can choose a profile.
 */
const FOREIGN_PROFILE_ID = '00000000-0000-4000-8000-0000000000ff';

/** What must not appear on the log, resolved once so the report and the scan agree. */
function sensitiveStrings(note: string): SensitiveStrings {
  return {
    medicineNames: ['Synthetic Tablet A', 'Synthetic Capsule B'],
    profileName: 'Parent (synthetic)',
    doseNote: note,
  };
}

function pointPhoneAtHost(): boolean {
  const api = adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(API_PORT)}`]).ok;
  const metro = adb(['reverse', `tcp:${String(METRO_PORT)}`, `tcp:${String(METRO_PORT)}`]).ok;
  return api && metro;
}

async function apiReachable(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(API_PORT)}/health`, {
      headers: { connection: 'close' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Every line logcat attributes to `pid`, or `null` where it could not be read. */
function logLinesForPid(pid: string): readonly string[] | null {
  const result = adb(['shell', 'logcat', '-d', '-v', 'threadtime', `--pid=${pid}`]);
  if (!result.ok) return null;
  return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
}

function systemLogLines(): readonly string[] | null {
  const result = adb(['shell', 'logcat', '-d', '-v', 'threadtime']);
  if (!result.ok) return null;
  return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
}

/** Every component the installed package declares, as `package/class`. */
function declaredComponents(): readonly string[] | null {
  const result = adb(['shell', 'dumpsys', 'package', PACKAGE]);
  if (!result.ok) return null;
  const matches = result.stdout.match(
    new RegExp(`${PACKAGE}/[A-Za-z0-9_.$]+`.replace(/\./g, '\\.'), 'g'),
  );
  if (matches === null) return null;
  return [...new Set(matches)].sort();
}

/**
 * The medicine names visible on the shelf.
 *
 * Read off the screen rather than from the API, because what is being compared is what the phone
 * rendered - a link that changed the request but not the render would be a different finding, and
 * a link that changed the render is the one that matters to the person holding the phone.
 */
function medicinesOnShelf(): readonly string[] | null {
  const text = collectScreenText();
  if (text === null) return null;
  return text.filter((line) => /^Synthetic /.test(line));
}

/**
 * The same read, after giving the list time to arrive.
 *
 * The shelf renders before its request answers, so a read taken the instant a screen appears sees
 * an empty list - which on one side of a comparison is a difference and on the other is an
 * `INCONCLUSIVE`. Neither is a fact about a deep link.
 */
function shelfAfterSettling(): readonly string[] | null {
  sleep(10_000);
  return medicinesOnShelf();
}

function main(): void {
  if (!isInstalled()) {
    process.stdout.write(`${PACKAGE} is not installed on the attached device.\n`);
    process.exitCode = 1;
    return;
  }
  if (!pointPhoneAtHost()) {
    process.stdout.write(
      `Could not establish \`adb reverse\` for tcp:${String(API_PORT)} and ` +
        `tcp:${String(METRO_PORT)} (trap 197).\n`,
    );
    process.exitCode = 1;
    return;
  }

  const checks: Check[] = [];
  // Minted per run and typed into a dose note, so the scan covers a string the app handled minutes
  // ago rather than only ones that could have been compiled into a bundle.
  const note = `privacy run ${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
  const strings = sensitiveStrings(note);

  prepareDeviceForDriving();
  suppressStylusHandwriting();

  // ---- Drive the app over real data, with a clean log -----------------------
  process.stdout.write('Clearing the log and driving the app over its own data...\n');
  adb(['shell', 'am', 'force-stop', PACKAGE]);
  sleep(2_000);
  adb(['logcat', '-c']);

  const driven = coldStart('privacy-drive');
  let reachedShelf = false;

  if (driven && tapNamed('Shelf')) {
    sleep(8_000);
    reachedShelf = medicinesOnShelf() !== null;

    // The item's own screen, which renders the name, the strength and the directions.
    if (scrollToAndTapBelow('Open this item', MEDICINE_NAME)) {
      sleep(6_000);
      if (!scrollToAndTap('Back')) captureFailure('privacy-item-back');
      sleep(4_000);
    } else {
      captureFailure('privacy-open-item');
    }

    // And a dose, so a string minted for this run passes through a write path and a history.
    if (scrollToAndTapBelow('Record what happened', MEDICINE_NAME)) {
      sleep(6_000);
      if (scrollToAndTap('I took it')) {
        sleep(10_000);
      } else {
        captureFailure('privacy-took-it');
      }
    } else {
      captureFailure('privacy-record');
    }
  }

  const pid = processId();
  const appLines = pid === null ? null : logLinesForPid(pid);
  const allLines = systemLogLines();
  const systemLines = allLines === null ? null : withoutInstrumentation(allLines);
  const instrumentationLines =
    allLines === null || systemLines === null ? 0 : allLines.length - systemLines.length;

  checks.push(captureControlCheck({ appLines, driven: driven && reachedShelf }));
  checks.push(appLogCheck({ appLines, strings }));
  checks.push(systemLogCheck({ systemLines, instrumentationLines, strings }));

  // ---- What the package exposes --------------------------------------------
  checks.push(componentSurfaceCheck({ components: declaredComponents() }));

  // ---- What a link from another app can decide ------------------------------
  // The baseline is read from its own cold start rather than from wherever the drive above left
  // the app. Taking it from the screen already open reads whatever that screen happened to name -
  // the first version of this read one medicine off the dose-recording screen's heading and then
  // reported the shelf as having changed under a link that changed nothing.
  process.stdout.write('Reading the shelf after an ordinary launch...\n');
  adb(['shell', 'am', 'force-stop', PACKAGE]);
  sleep(3_000);
  const ordinary = coldStart('privacy-ordinary') && tapNamed('Shelf') ? shelfAfterSettling() : null;

  process.stdout.write('Firing a link from another app’s context...\n');
  adb(['shell', 'am', 'force-stop', PACKAGE]);
  sleep(3_000);
  const runningBefore = processId() !== null;

  // `am start` runs as the shell's uid, which is another app as far as Android is concerned. The
  // link carries a profile ID that is not this household's.
  adb([
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-c',
    'android.intent.category.BROWSABLE',
    '-d',
    `kynviora://shelf?profileId=${FOREIGN_PROFILE_ID}`,
  ]);
  sleep(50_000);

  const opened = processId() !== null;
  // No `tapNamed('Shelf')` here. Where the link lands is part of what is being measured, and
  // navigating first would hide a link that opened somewhere else entirely.
  const afterLink = opened ? shelfAfterSettling() : null;
  if (afterLink === null && opened) captureFailure('privacy-deeplink-shelf');

  checks.push(deepLinkCheck({ runningBefore, opened, ordinary, afterLink }));

  adb(['shell', 'am', 'force-stop', PACKAGE]);

  process.stdout.write(
    `Scanned for ${String(strings.medicineNames.length + 2)} sensitive strings; ` +
      `the profile queried was ${PROFILE_ID}.\n`,
  );
  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

void (async () => {
  if (!(await apiReachable())) {
    process.stdout.write(
      `No seeded API on 127.0.0.1:${String(API_PORT)}:\n` +
        '  KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev\n',
    );
    process.exitCode = 1;
    return;
  }
  main();
})();
