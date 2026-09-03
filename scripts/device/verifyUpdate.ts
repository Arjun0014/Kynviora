/**
 * Prove - or fail to prove - that updating the app over an existing install keeps somebody's data.
 *
 * Spec references: `19` ("Android install/update"), `12` (encrypted structured local store,
 * keystore-held key), `14` ("encrypted local storage validated"), `04` Phase 0.1, `04` Phase 4.2.
 *
 *   npm run verify:device:update
 *
 * WHY THIS SCENARIO IS WORTH ITS OWN RUN
 * `verify:device` shows the database is encrypted and that its key outlives the process.
 * `verify:device:reminders` shows the alarms outlive a reboot. Neither says anything about the app
 * being *replaced*, which is the one routine event that runs new code against an old file. The
 * failure it produces is total and silent - a key that no longer derives, or a schema the new build
 * will not open - and `12` makes that store the thing a person depends on precisely when they have
 * no signal to re-fetch with.
 *
 * WHAT IS ACTUALLY DONE TO THE DEVICE
 * The app is driven until it has stored something, the encrypted file is read out through
 * `run-as`, the same APK is installed with `adb install -r`, and then the file is read again and
 * the app is relaunched with the API out of reach. Nothing is written into the app by this script:
 * every string it looks for is content the app stored through its own code path.
 *
 * WHY THE SAME APK RATHER THAN TWO BUILDS
 * Because what is being measured is the platform's replace path and the app's own key and schema
 * handling across it, and both run identically whether the bytes changed. A second build would add
 * a schema-migration dimension the local store does not have yet - `projected_read_v1` is versioned
 * in its name, so a shape change starts a new table rather than migrating one (`projection.ts`) -
 * and that is recorded rather than pretended (`DEV-042`).
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { join } from 'node:path';
import { PACKAGE, adb, adbBytes, dumpUiHierarchy, isInstalled, sleep } from './adb.js';
import { crashedApp } from './accessibility.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import { pendingAlarmsFor } from './reminders.js';
import {
  databaseSurvivedCheck,
  keySurvivedUpdateCheck,
  parseInstallIdentity,
  remindersSurvivedUpdateCheck,
  survivedLaunchCheck,
  updateNotReinstallCheck,
} from './update.js';

/** Where `expo-sqlite` puts a database opened by name. */
const DATABASE_RELATIVE_PATH = 'files/SQLite/kynviora.db';
const DATABASE_PATH = `/data/data/${PACKAGE}/${DATABASE_RELATIVE_PATH}`;

/** The debug APK `npx expo run:android` produces. */
const APK_PATH = join(
  process.cwd(),
  'apps',
  'mobile',
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk',
);

const API_PORT = 3000;

/**
 * Strings the app is known to have stored, from the development seed (`db/src/seed.ts`).
 *
 * Every one is synthetic; no real product name is ever written into a committed check.
 */
const KNOWN_STORED_CONTENT = [
  'Synthetic Tablet A',
  'Synthetic Capsule B',
  'Synthetic Moisturiser C',
  'Development profile',
];

function readDatabase(): Uint8Array | null {
  return adbBytes(['exec-out', 'run-as', PACKAGE, 'cat', DATABASE_RELATIVE_PATH]);
}

function installIdentity(): ReturnType<typeof parseInstallIdentity> {
  return parseInstallIdentity(adb(['shell', 'dumpsys', 'package', PACKAGE]).stdout);
}

function heldAlarms(): { readonly count: number; readonly available: boolean } {
  const result = adb(['shell', 'dumpsys', 'alarm']);
  return {
    count: pendingAlarmsFor(result.stdout, PACKAGE).length,
    available: result.ok && result.stdout.length > 0,
  };
}

function launch(): void {
  adb(['shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`]);
}

function isRunning(): boolean {
  return adb(['shell', 'pidof', PACKAGE]).stdout.trim() !== '';
}

/**
 * Fill the store, by using the app rather than by writing into it.
 *
 * The projection is written on a successful read, so a launch with the API reachable is what puts
 * the seed's content where the rest of this run can ask whether it survived.
 */
function primeTheStore(): boolean {
  adb(['shell', 'am', 'force-stop', PACKAGE]);
  launch();
  sleep(40_000);
  const xml = dumpUiHierarchy();
  return xml !== null && KNOWN_STORED_CONTENT.some((value) => xml.includes(value));
}

/**
 * Relaunch with the API out of reach and report what the app could still show.
 *
 * Both halves matter, and they are the same pair the storage harness uses: killing the app
 * exercises the key outliving the process, and cutting the API off is what makes anything on the
 * screen evidence rather than a re-fetch. The tunnel is restored afterwards whatever happens.
 */
function readBackOffline(): {
  readonly apiWasUnreachable: boolean;
  readonly shown: boolean;
  readonly keyFailed: boolean;
  readonly crashed: boolean;
  readonly launched: boolean;
} {
  const removed = adb(['reverse', '--remove', `tcp:${String(API_PORT)}`]).ok;
  try {
    adb(['shell', 'am', 'force-stop', PACKAGE]);
    adb(['logcat', '-c']);
    launch();
    sleep(35_000);

    const log = adb(['logcat', '-d']).stdout;
    const keyFailed = /file is not a database|Refusing to open the database|SQLITE_NOTADB/i.test(
      log,
    );
    const xml = dumpUiHierarchy();
    return {
      apiWasUnreachable: removed,
      shown: xml !== null && KNOWN_STORED_CONTENT.some((value) => xml.includes(value)),
      keyFailed,
      crashed: crashedApp(log, PACKAGE),
      launched: isRunning(),
    };
  } finally {
    if (removed) adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(API_PORT)}`]);
  }
}

function main(): void {
  if (!isInstalled()) {
    process.stdout.write(
      `${PACKAGE} is not installed on the attached device.\n` +
        'This scenario is about replacing an existing install, so there has to be one:\n' +
        '  cd apps/mobile && npx expo run:android\n',
    );
    process.exitCode = 1;
    return;
  }

  const checks: Check[] = [];

  // ---- Before -------------------------------------------------------------
  process.stdout.write('Using the app so the store has something to lose...\n');
  const primed = primeTheStore();
  checks.push({
    id: 'UPD-0',
    title: 'The local store held content before the update',
    status: primed ? 'PASS' : 'INCONCLUSIVE',
    detail: primed
      ? 'The app rendered seeded content, so the projection was written and there is something ' +
        'for the update to preserve.'
      : 'The app showed none of the seeded content before the update, so nothing had to survive ' +
        'it and every later check would pass over an empty store. Is the seeded API running and ' +
        '`adb reverse tcp:3000 tcp:3000` in place?',
  });

  const identityBefore = installIdentity();
  const databaseBefore = readDatabase();
  const alarmsBefore = heldAlarms();

  // ---- The update ---------------------------------------------------------
  process.stdout.write('Installing over the existing app...\n');
  const install = adb(['install', '-r', APK_PATH]);
  const installed = install.ok && /Success/i.test(install.stdout + install.stderr);
  sleep(5_000);

  const identityAfter = installIdentity();
  checks.push(updateNotReinstallCheck(identityBefore, identityAfter, installed));

  // ---- After --------------------------------------------------------------
  const databaseAfter = readDatabase();
  checks.push(databaseSurvivedCheck(databaseBefore, databaseAfter, DATABASE_PATH));

  process.stdout.write('Relaunching with the API out of reach...\n');
  const readBack = readBackOffline();
  checks.push(
    keySurvivedUpdateCheck({
      shownOffline: readBack.shown,
      keyFailed: readBack.keyFailed,
      apiWasUnreachable: readBack.apiWasUnreachable,
    }),
  );
  checks.push(survivedLaunchCheck(readBack.crashed, readBack.launched));

  // The package-replace broadcast is handled asynchronously, like the boot one - so this is a
  // poll rather than a single reading, for the reason `REM-5` had to become one.
  const alarmDeadline = Date.now() + 180_000;
  let alarmsAfter = heldAlarms();
  while (Date.now() < alarmDeadline && alarmsAfter.available && alarmsAfter.count === 0) {
    sleep(10_000);
    alarmsAfter = heldAlarms();
  }
  checks.push(
    remindersSurvivedUpdateCheck(
      alarmsBefore.count,
      alarmsAfter.count,
      alarmsBefore.available && alarmsAfter.available,
    ),
  );

  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

main();
