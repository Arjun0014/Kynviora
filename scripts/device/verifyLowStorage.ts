/**
 * Prove - or fail to prove - that a dose nothing could keep is never described as kept.
 *
 * Spec references: `19` ("low storage/network disruption" - the last of its fourteen device
 * scenarios that needed neither a credential nor a decision), `12` (the pending-operation journal;
 * a queued change is visible rather than assumed), `18`, `04` Phase 4.3, `DEV-040`, DEC-100,
 * DEC-102, DEC-111.
 *
 *   npm run verify:device:lowstorage
 *
 * WHAT "LOW STORAGE" IS TAKEN TO MEAN HERE, AND WHY
 * A device with no room left is a device whose apps cannot write, and for this app that lands in
 * one place: the encrypted local store, which holds the projection and the offline journal. The
 * run produces that condition by removing write permission from the store's directory **inside the
 * app's own sandbox**, and then proves it produced it by trying a write and requiring a refusal.
 *
 * It is a stand-in and this is where that is written down. A genuinely full filesystem also fails
 * a temporary file, a log line and Android's own bookkeeping, and the system behaves differently
 * under it. What this reproduces is the same failure at the same layer - the point at which
 * SQLCipher's write returns an error - which is where every consequence this app can have begins.
 *
 * WHY NOT ACTUALLY FILL THE DISK
 * Because a harness that can wedge the device it is measuring is one nobody runs twice. Filling a
 * 10GB partition to zero is reversible only while the run is alive to reverse it; a `chmod` on one
 * directory is restored by a `chmod` back, and by the next run before it starts. Nothing outside
 * the app's sandbox is touched either way.
 *
 * WHAT IS ACTUALLY DONE TO THE DEVICE
 * Three passes over the same action - recording a dose with the API unreachable, which is the one
 * path that has nowhere to go but the journal.
 *
 *   The control - storage untouched. The dose must queue and the screen must say it is kept on
 *                 this phone, with nothing reaching the server. Without this every check below is
 *                 also true of an app that refuses everything.
 *   Constrained - the store's directory made unwritable, the refusal proven, the same dose
 *                 attempted. The screen must not say it was recorded and must not say it is kept.
 *   Recovery    - permission restored, the app relaunched, the shelf compared with what it showed
 *                 before.
 *
 * WHAT IT NEEDS
 * The seeded API on `127.0.0.1:3000` (`KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev`), a
 * Metro bundler, and an attached device with the app installed. It repoints `adb reverse tcp:3000`
 * at its own switch for the duration and puts it back afterwards.
 *
 * WHAT IT LEAVES BEHIND
 * The store's directory writable, whatever happened - restored in a `finally`, and restored again
 * by the next run before it starts, because a crashed run is exactly the one that leaves it
 * unwritable. One dose event on the server from the recovery pass, which is append-only by design.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { PACKAGE, adb, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import { crashedApp } from './accessibility.js';
import { startApiSwitch, type ApiSwitch } from './apiSwitch.js';
import { DOSE_COPY, DOSE_EVENT_DESCRIPTIONS } from '@kynviora/presentation';
import {
  claimCheck,
  conditionCheck,
  controlCheck,
  recoveryCheck,
  stabilityCheck,
  uncaughtRejectionIn,
} from './lowStorage.js';
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
const SWITCH_PORT = 3999;
const MEDICINE_ID = '00000000-0000-4000-8000-00000000d030';
const MEDICINE_NAME = 'Synthetic Tablet A';
const OWNER_ID = '00000000-0000-4000-8000-00000000d001';

/** Where `openSecureDatabase` puts the encrypted store, inside the app's own sandbox. */
const STORE_DIR = 'files/SQLite';
/** A file the run creates and deletes, purely to find out whether a write is refused. */
const PROBE = `${STORE_DIR}/.kynviora-storage-probe`;

function pointPhoneAtHost(port: number): boolean {
  return adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(port)}`]).ok;
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

/** How many events the medicine's history holds, asked of the real API from the host. */
async function serverEvents(): Promise<number | null> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${String(API_PORT)}/v1/dose-events?ownedItemId=${MEDICINE_ID}`,
      { headers: { 'x-kynviora-dev-user': OWNER_ID, connection: 'close' } },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { readonly events?: readonly unknown[] };
    return body.events?.length ?? 0;
  } catch {
    return null;
  }
}

/** Run a command inside the app's sandbox as the app's own user. */
function asApp(command: string): { readonly ok: boolean; readonly stdout: string } {
  const result = adb(['shell', `run-as ${PACKAGE} sh -c ${JSON.stringify(command)}`]);
  return { ok: result.ok, stdout: result.stdout };
}

function setStoreWritable(writable: boolean): boolean {
  return asApp(`chmod ${writable ? '700' : '500'} ${STORE_DIR}`).ok;
}

/**
 * Whether a write into the store directory is refused, asked rather than assumed.
 *
 * `chmod` can succeed and change nothing - a filesystem may ignore the mode, and a directory that
 * is already open may keep working - so the condition is tested directly. The probe is removed
 * either way; a leftover file in the store directory is not something a later run should inherit.
 */
function writeIsRefused(): boolean {
  asApp(`rm -f ${PROBE}`);
  const created = asApp(`touch ${PROBE} && echo created`);
  const refused = !created.stdout.includes('created');
  asApp(`rm -f ${PROBE}`);
  return refused;
}

/**
 * Drive the shelf to the record-a-dose screen, cut the network, and press "I took it".
 *
 * The switch is flipped **between** opening the screen and pressing the control, and the order is
 * the whole reason this works. Going offline first leaves nothing to press: the shelf renders the
 * server's answer, and under this scenario the local copy of that answer is exactly what has been
 * taken away - so a run that cut the network at the start would find an empty screen and report a
 * control it could not reach, which is a fact about the harness rather than about the app.
 *
 * The same shape is used for the control pass, so the two are comparable in the only way that
 * matters: identical up to whether the store could be written.
 */
function recordADose(label: string, apiSwitch: ApiSwitch): boolean {
  apiSwitch.setMode('pass');
  if (!coldStart(`lowstorage-${label}`)) return false;
  if (!tapNamed('Shelf')) {
    captureFailure(`lowstorage-${label}-shelf`);
    return false;
  }
  sleep(10_000);
  if (!scrollToAndTapBelow('Record what happened', MEDICINE_NAME)) {
    captureFailure(`lowstorage-${label}-open`);
    return false;
  }
  sleep(6_000);

  apiSwitch.setMode('offline');
  if (!scrollToAndTap(DOSE_EVENT_DESCRIPTIONS.TAKEN.actionLabel)) {
    captureFailure(`lowstorage-${label}-press`);
    return false;
  }
  sleep(12_000);
  return true;
}

/** How many medicines the shelf shows, read off the device with the network up. */
function shelfItems(): number | null {
  if (!coldStart('lowstorage-shelf')) return null;
  if (!tapNamed('Shelf')) return null;
  sleep(12_000);
  const text = collectScreenText();
  if (text === null) return null;
  return text.filter((line) => /^Synthetic /.test(line)).length;
}

async function main(): Promise<void> {
  if (!isInstalled()) {
    process.stdout.write(`${PACKAGE} is not installed on the attached device.\n`);
    process.exitCode = 1;
    return;
  }
  if (!(await apiReachable())) {
    process.stdout.write(
      `No seeded API on 127.0.0.1:${String(API_PORT)}:\n` +
        '  KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev\n',
    );
    process.exitCode = 1;
    return;
  }

  // A crashed earlier run is exactly the one that left the store unwritable, so this is undone
  // before anything is measured rather than only afterwards.
  setStoreWritable(true);
  adb(['reverse', `tcp:${String(METRO_PORT)}`, `tcp:${String(METRO_PORT)}`]);

  const checks: Check[] = [];
  let apiSwitch: ApiSwitch | null = null;

  prepareDeviceForDriving();
  suppressStylusHandwriting();

  try {
    const itemsBefore = shelfItems();

    apiSwitch = startApiSwitch({ port: SWITCH_PORT, upstreamPort: API_PORT });
    pointPhoneAtHost(SWITCH_PORT);
    apiSwitch.setMode('offline');

    // ---- LOW-0, the control ------------------------------------------------
    process.stdout.write('Recording a dose with no signal, storage untouched...\n');
    const controlBefore = await serverEvents();
    const controlDriven = recordADose('control', apiSwitch);
    const controlScreen = controlDriven ? (collectScreenText() ?? []) : [];
    checks.push(
      controlCheck({
        driven: controlDriven,
        saidQueued: controlScreen.some((line) => line.includes(DOSE_COPY.offlineNote)),
        serverBefore: controlBefore,
        serverAfter: await serverEvents(),
      }),
    );

    // ---- LOW-1, the condition ----------------------------------------------
    process.stdout.write('Making the store unwritable...\n');
    adb(['logcat', '-c']);
    const applied = setStoreWritable(false);
    const refused = applied ? writeIsRefused() : null;
    checks.push(conditionCheck({ applied, writeRefused: refused }));

    // ---- LOW-2 and LOW-3, the constrained run -------------------------------
    process.stdout.write('Recording a dose with no signal and no writable store...\n');
    const attempted =
      refused === true && apiSwitch !== null ? recordADose('constrained', apiSwitch) : false;
    const constrainedScreen = attempted ? (collectScreenText() ?? []) : [];

    checks.push(
      claimCheck({
        attempted,
        saidQueued: constrainedScreen.some((line) => line.includes(DOSE_COPY.offlineNote)),
        saidRecorded: constrainedScreen.some((line) => line.includes(DOSE_COPY.recordedDone)),
        // Anything at all about the attempt: a failure state, a message, or a refusal. The screen
        // renders one of `ScreenState`'s messages, so its presence is the signal.
        saidSomething: constrainedScreen.length > 0,
      }),
    );

    // Read once, so the two questions are asked of the same log rather than of two.
    const log = attempted ? adb(['logcat', '-d']).stdout : null;
    checks.push(
      stabilityCheck({
        crashed: log === null ? null : crashedApp(log, PACKAGE),
        uncaughtRejection: log === null ? null : uncaughtRejectionIn(log),
        stillRunning: processId() !== null,
      }),
    );

    // ---- LOW-4, recovery ----------------------------------------------------
    process.stdout.write('Restoring write permission and looking again...\n');
    const restored = setStoreWritable(true);
    apiSwitch.setMode('pass');
    pointPhoneAtHost(API_PORT);
    checks.push(
      recoveryCheck({
        restored,
        itemsBefore,
        itemsAfter: restored ? shelfItems() : null,
      }),
    );
  } finally {
    // Whatever happened. An unwritable store left behind is an app somebody else cannot use.
    setStoreWritable(true);
    asApp(`rm -f ${PROBE}`);
    apiSwitch?.close();
    pointPhoneAtHost(API_PORT);
    adb(['shell', 'am', 'force-stop', PACKAGE]);
  }

  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

void main();
