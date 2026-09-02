/**
 * Prove - or fail to prove - encrypted local storage on an attached Android device.
 *
 * Spec references: `14` ("encrypted local storage validated" is a release gate; MASVS/MASTG local
 * data storage and key management), `12` (encrypted structured local store, keystore-held key,
 * backup behaviour reviewed), `03` group J, `19` (device E2E), `15` A2. `BLK-002`.
 *
 *   npm run verify:device
 *
 * WHAT MAKES THE ABSENCE CHECKS MEAN ANYTHING
 * "The medicine name is not in the file" is trivially true of an empty file. So the run needs a
 * positive control, and it has one: the app is killed, the API is put out of reach, and it is
 * relaunched. What it then shows can only have come out of the encrypted database. The same
 * strings are then searched for in that database's bytes. One check says the content is there;
 * the other says it is not readable. Neither alone is evidence.
 *
 * WHAT IT DOES NOT DO
 * It writes nothing into the app. Every string it looks for is content the app stored through its
 * own code path while somebody used it. A canary this script inserted would only show that this
 * script's write was encrypted, which is not the claim `14` gates a release on.
 *
 * WHY `run-as` AND NOT ROOT
 * `run-as` is the debuggable-build equivalent of the app reading its own files, so what it sees is
 * what the app's sandbox holds. Reading the same path as root would also show the file and would
 * prove nothing about what leaves the sandbox, which is what MASTG's local-storage tests are for.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { PACKAGE, adb, adbBytes, dumpUiHierarchy, isInstalled, sleep } from './adb.js';
import {
  checkBackupPolicy,
  checkDatabaseIsEncrypted,
  checkKeyHandling,
  formatReport,
  overallStatus,
  type Check,
} from './analysis.js';

/** Where `expo-sqlite` puts a database opened by name. */
const DATABASE_RELATIVE_PATH = 'files/SQLite/kynviora.db';

/**
 * Strings the app is known to have stored.
 *
 * From the development seed (`db/src/seed.ts`), which is what a developer running
 * `KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev` has on the shelf. Every one is
 * synthetic; no real product name is ever written into a committed check.
 */
const KNOWN_STORED_CONTENT = [
  'Synthetic Tablet A',
  'Synthetic Capsule B',
  'Synthetic Moisturiser C',
  'Development profile',
];

/** The API port the app is pointed at over `adb reverse`. */
const API_PORT = 3000;

function readDatabase(): Uint8Array | null {
  return adbBytes(['exec-out', 'run-as', PACKAGE, 'cat', DATABASE_RELATIVE_PATH]);
}

function readAppTextFiles(directory: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  const listing = adb(['exec-out', 'run-as', PACKAGE, 'ls', directory]);
  if (!listing.ok) return files;

  for (const name of listing.stdout.split('\n').map((line) => line.trim())) {
    if (name === '') continue;
    const content = adb(['exec-out', 'run-as', PACKAGE, 'cat', `${directory}/${name}`]);
    if (content.ok) files.set(`${directory}/${name}`, content.stdout);
  }
  return files;
}

/**
 * Kill the app, cut it off from the API, and see what it can still show.
 *
 * Both halves matter. Killing it exercises `12`'s requirement that the key outlives the process -
 * it lives in the keystore, not in memory. Cutting the API off is what makes the content on the
 * screen evidence: with nothing to fetch, anything rendered was decrypted from the local store.
 *
 * The reverse tunnel is restored afterwards whatever happens, so a failed run does not leave a
 * developer with an app that cannot reach its server and no idea why.
 */
function relaunchOfflineAndReadBack(): { readonly restored: boolean; readonly shown: boolean } {
  const removed = adb(['reverse', '--remove', `tcp:${String(API_PORT)}`]).ok;

  try {
    adb(['shell', 'am', 'force-stop', PACKAGE]);
    adb(['logcat', '-c']);
    adb(['shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`]);

    // Long enough for the store to open - a keystore round trip - and the first screen to settle.
    sleep(30_000);

    const log = adb(['logcat', '-d', '-s', 'ReactNativeJS:E', 'AndroidRuntime:E']).stdout;
    const keyFailed = /file is not a database|Refusing to open the database|SQLITE_NOTADB/i.test(
      log,
    );

    const xml = dumpUiHierarchy();
    const shown =
      xml !== null && KNOWN_STORED_CONTENT.some((value) => xml.includes(value)) && !keyFailed;

    return { restored: removed, shown };
  } finally {
    if (removed) adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(API_PORT)}`]);
  }
}

function main(): void {
  if (!isInstalled()) {
    process.stdout.write(
      `${PACKAGE} is not installed on the attached device.\n` +
        'Build and install the development build first:\n' +
        '  cd apps/mobile && npx expo run:android\n',
    );
    process.exitCode = 1;
    return;
  }

  // The read-back runs first: it is what puts content in the store's reach and what proves the
  // key survived. The bytes are then read from the file it just decrypted.
  const readBack = relaunchOfflineAndReadBack();

  const databasePath = `/data/data/${PACKAGE}/${DATABASE_RELATIVE_PATH}`;
  const bytes = readDatabase();

  const flags = adb(['shell', 'dumpsys', 'package', PACKAGE]).stdout;
  const flagLine = flags.split('\n').find((line) => line.includes('flags=[')) ?? null;

  const checks: Check[] = [
    ...checkDatabaseIsEncrypted({
      bytes,
      path: databasePath,
      knownContent: KNOWN_STORED_CONTENT,
    }),
    ...checkKeyHandling({
      files: readAppTextFiles('shared_prefs'),
      reopenedAfterProcessDeath: readBack.shown,
    }),
    ...checkBackupPolicy(flagLine),
  ];

  if (!readBack.restored) {
    checks.push({
      id: 'STORAGE-4',
      title: 'The read-back happened with the API genuinely out of reach',
      status: 'INCONCLUSIVE',
      detail:
        `No \`adb reverse tcp:${String(API_PORT)}\` tunnel was in place to remove, so the app may ` +
        'have refetched rather than decrypted. Point the app at the API over `adb reverse` and ' +
        'run this again.',
    });
  } else {
    checks.push({
      id: 'STORAGE-4',
      title: 'The read-back happened with the API genuinely out of reach',
      status: 'PASS',
      detail:
        `The \`adb reverse tcp:${String(API_PORT)}\` tunnel was removed for the relaunch and ` +
        'restored afterwards, so anything the app showed came out of the local store.',
    });
  }

  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

main();
