/**
 * Prove - or fail to prove - that the camera is asked for only when somebody asks to scan, that
 * declining it leaves the app usable, and that no permission over the device's files exists at all.
 *
 * Spec references: `19` (camera and file permissions, the thirteenth of its fourteen device
 * scenarios), `16` (request only permissions a visible feature needs, at the moment it is used;
 * prominent disclosure; no broad storage permission), `04` Phase 2.2 (manual entry is the complete
 * path), `09`, `DEV-040`, DEC-102.
 *
 *   npm run verify:device:camera
 *
 * WHAT IT NEEDS
 * The seeded API on `127.0.0.1:3000`, a Metro bundler, and an attached device with a build that
 * **includes `expo-camera`**. That is a native module, so a build made before it was added does not
 * have it and this run reports `CAM-0` inconclusive - correctly, because a scan screen that cannot
 * mount is not a scan screen. `npx expo prebuild` and a Gradle assemble are what fix that.
 *
 * WHAT IT DOES TO THE DEVICE
 * Runs `pm reset-permissions`, which returns **every app's** runtime permissions to their
 * default state - see `resetPermissionState` for why nothing narrower works - then drives the app
 * to the scan screen, presses the control, refuses the dialog, and reads `dumpsys package` at
 * three points. It records what the camera permission was before it started and puts it back in a
 * `finally`, and dismisses any dialog it left open.
 *
 * That device-wide reset is the one thing here that reaches outside this app. It is acceptable on
 * a dedicated test emulator and would not be on a phone somebody uses.
 *
 * WHY REVOKING IS PART OF THE MEASUREMENT
 * `CAM-1` asks whether the app holds the camera permission after a launch that never scanned, and
 * on a device where somebody already granted it the answer is yes for a reason that has nothing to
 * do with this app's behaviour. Revoking first is what makes the question about the app.
 *
 * WHAT IT CANNOT MEASURE, SAID RATHER THAN IMPLIED
 * A real read of a real symbol. Holding a printed barcode in front of an emulator's virtual camera
 * is not a thing a harness can arrange, and the emulator's virtual scene is not a product pack. So
 * this run covers the permission behaviour and the screens on either side of it; that a camera
 * pointed at a box produces the digits underneath it is a manual check, and a green tick over a
 * fixture would be worse than saying so.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { PACKAGE, adb, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import { SCAN_COPY } from '@kynviora/presentation';
import {
  controlCheck,
  grantedPermissions,
  justInTimeCheck,
  refusalCheck,
  restorationCheck,
  storageCheck,
} from './cameraPermission.js';
import {
  captureFailure,
  coldStart,
  collectScreenText,
  currentNodes,
  prepareDeviceForDriving,
  processId,
  scrollToAndTap,
  suppressStylusHandwriting,
  tapNamed,
} from './ui.js';

const CAMERA = 'android.permission.CAMERA';
/**
 * Not what this scenario measures, and exactly what gets in its way.
 *
 * `pm reset-permissions` is device-wide, so it clears this one too - and the app asks for it at
 * launch, which is correct for a reminder feature and fatal for a run trying to drive the app to a
 * different screen. A notification dialog on top of the shelf makes every tap land on it, and the
 * report then reads "the scan screen was never reached", which is a fact about this permission
 * rather than about the camera.
 *
 * So it is granted for the duration and put back afterwards. Granting is the neutral choice: a
 * granted permission shows no dialog, and this run has nothing to say about notifications.
 */
const NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS';

/**
 * The other package on this device that asks for notifications the moment it is reset.
 *
 * `pm reset-permissions` is device-wide, which the comment above already says - and the
 * consequence is not confined to this app. The Accessibility Suite asks at once, and its dialog is
 * a full-screen `permissioncontroller` window over whatever is behind it, so the app never becomes
 * ready and the run reports "the scan screen was never reached" - which is a fact about a dialog
 * belonging to a different app (trap 201).
 *
 * Granted for the duration alongside this app's, for the same reason and with the same
 * neutrality: a granted permission shows no dialog, and this run has nothing to say about
 * notifications.
 */
const ACCESSIBILITY_SUITE = 'com.google.android.marvin.talkback';
const METRO_PORT = 8081;

function dumpsys(): string | null {
  const result = adb(['shell', 'dumpsys', 'package', PACKAGE]);
  return result.ok ? result.stdout : null;
}

function cameraIsGranted(): boolean | null {
  const output = dumpsys();
  return output === null ? null : grantedPermissions(output).includes(CAMERA);
}

function setPermission(permission: string, granted: boolean, pkg: string = PACKAGE): boolean {
  return adb(['shell', 'pm', granted ? 'grant' : 'revoke', pkg, permission]).ok;
}

function setCamera(granted: boolean): boolean {
  return setPermission(CAMERA, granted);
}

function isGranted(permission: string): boolean | null {
  const output = dumpsys();
  return output === null ? null : grantedPermissions(output).includes(permission);
}

/**
 * Put every runtime permission back to "not yet asked".
 *
 * **`pm revoke` is not enough, and finding that out cost three runs.** Revoking clears the grant
 * and leaves the `USER_SET` and `USER_FIXED` flags, so a permission a person has refused twice
 * stays permanently refused - Android will not show a dialog for it again. A run that revoked to
 * establish a clean baseline therefore established a *blocked* one, and the app correctly drew
 * "The camera is switched off for Kynviora" while `CAM-0` reported the disclosure missing.
 *
 * The reading is worth keeping: the harness was refusing the dialog on every run, which is
 * exactly how a person reaches "don't ask again" - so this scenario poisons its own precondition
 * by doing its job.
 *
 * `pm reset-permissions` is the only command that clears the flags, and it is **device-wide**:
 * every app's runtime permissions return to their default state, this one's included. That is
 * acceptable on a dedicated test emulator and would not be on a phone somebody uses, which is why
 * it is said here rather than left in a script.
 */
function resetPermissionState(): boolean {
  return adb(['shell', 'pm', 'reset-permissions']).ok;
}

/**
 * Whether Android's own permission dialog is the window with focus.
 *
 * Identified by the package that owns it rather than by its wording, which is localised and
 * changes between releases - but read from `mCurrentFocus` rather than from the window **list**,
 * and that distinction cost a run. `dumpsys window windows` mentions `permissioncontroller` in
 * twenty-six places on an idle device sitting on the launcher, because the list includes window
 * tokens and cached activity records. A check over it is true essentially always, so `CAM-2`
 * reported "the dialog was not dismissed with a refusal" - the branch for a dialog that appeared
 * and was answered with a grant - when no dialog had ever appeared.
 *
 * The failure is worth naming because of its direction: it made a check that could not run look
 * like a check that ran and found something else.
 */
function permissionDialogVisible(): boolean {
  const result = adb(['shell', 'dumpsys', 'window']);
  if (!result.ok) return false;
  const focus = /mCurrentFocus=.*/.exec(result.stdout)?.[0] ?? '';
  return /permissioncontroller|GrantPermissions/i.test(focus);
}

/**
 * Leave no dialog on screen, whatever happened.
 *
 * A refusal that fails to find its button leaves Android's dialog up, and it belongs to
 * `permissioncontroller` rather than to this app - so `am force-stop` does not remove it and the
 * **next** run's `coldStart` launches the app underneath it. Every tap then lands on the dialog,
 * and `CAM-0` reports the scan screen as missing its disclosure, which is a fact about the
 * previous run rather than about the app.
 *
 * Called before the run as well as after it, for the reason `verify:device:lowstorage` restores
 * write permission before it starts: the run that leaves a mess is the one that crashed, and it is
 * not around to clean up.
 */
function dismissAnyPermissionDialog(): void {
  for (let attempt = 0; attempt < 3 && permissionDialogVisible(); attempt += 1) {
    if (!refusePermissionDialog()) adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    sleep(1500);
  }
}

/**
 * Press the refusing button on Android's own permission dialog.
 *
 * **The apostrophe is not an apostrophe.** Android 16 renders the button as `Don’t allow`
 * with U+2019, and an ASCII `Don't allow` matches nothing at all - which presents as `CAM-2`
 * reporting that the dialog "was not dismissed with a refusal", indistinguishable from a dialog
 * that never appeared. It cost a run to find, and the fix is one character.
 *
 * Several forms are tried because this dialog belongs to Android rather than to this app, and its
 * wording changes by release and by whether the permission has been asked before.
 *
 * `tapNamed` matches an accessible name exactly, which is deliberate here rather than convenient:
 * the Android 16 dialog offers "While using the app", "Only this time" and "Don’t allow", and
 * a loose match risks pressing whichever button happens to contain the word - two of those three
 * grant the permission this check exists to refuse.
 */
const REFUSE_LABELS = ['Don’t allow', "Don't allow", 'Deny', 'DENY', 'DON’T ALLOW'];

/** The package that draws the runtime-permission dialog on every release this project targets. */
const PERMISSION_UI = 'com.google.android.permissioncontroller';

/**
 * Tap a control **in the permission dialog**, which `tapNamed` structurally cannot do.
 *
 * `nodeNamed` filters to `packageName === PACKAGE`, and that filter is a safety property rather
 * than an oversight: a harness that could tap anything on screen is one that can press a button in
 * whatever notification, system dialog or other app happens to be in front, and report the result
 * as the app's behaviour. Every other scenario in this directory wants exactly that restriction.
 *
 * This one has to reach outside it, so it opts out **explicitly and narrowly**: only nodes owned
 * by `com.google.android.permissioncontroller`, only by exact name. Loosening the shared helper
 * would have given every scenario the ability by accident.
 *
 * It cost a run to find, because the symptom is indistinguishable from the dialog not being there:
 * `tapNamed` returns `false` for "no such node" and for "the node belongs to somebody else".
 */
function tapInPermissionDialog(label: string): boolean {
  const nodes = currentNodes();
  if (nodes === null) return false;
  const match = nodes.find(
    (node) =>
      node.packageName === PERMISSION_UI &&
      (node.text === label || node.contentDescription === label),
  );
  if (match === undefined) return false;
  adb([
    'shell',
    'input',
    'tap',
    String(Math.round((match.bounds.left + match.bounds.right) / 2)),
    String(Math.round((match.bounds.top + match.bounds.bottom) / 2)),
  ]);
  sleep(1500);
  return true;
}

function refusePermissionDialog(): boolean {
  for (const label of REFUSE_LABELS) {
    if (tapInPermissionDialog(label)) return true;
  }
  return false;
}

/** Drive the app to the scan screen, without pressing the camera control. */
function openScanScreen(label: string): boolean {
  if (!coldStart(`camera-${label}`)) return false;
  if (!tapNamed('Shelf')) {
    captureFailure(`camera-${label}-shelf`);
    return false;
  }
  sleep(10_000);
  if (!scrollToAndTap('Add a medicine')) {
    captureFailure(`camera-${label}-add`);
    return false;
  }
  sleep(6_000);
  if (!scrollToAndTap(SCAN_COPY.openLabel)) {
    captureFailure(`camera-${label}-scan`);
    return false;
  }
  sleep(4_000);
  return true;
}

function main(): void {
  if (!isInstalled()) {
    process.stdout.write(`${PACKAGE} is not installed on the attached device.\n`);
    process.exitCode = 1;
    return;
  }

  adb(['reverse', `tcp:${String(METRO_PORT)}`, `tcp:${String(METRO_PORT)}`]);
  prepareDeviceForDriving();
  suppressStylusHandwriting();

  const checks: Check[] = [];
  const grantedBefore = cameraIsGranted();
  const notificationsBefore = isGranted(NOTIFICATIONS);

  // Before anything is measured. A crashed earlier run is exactly the one that left a dialog up.
  dismissAnyPermissionDialog();

  try {
    // A known starting state, and "known" has to mean the flags too rather than only the grant.
    // See `resetPermissionState`: revoking alone leaves a permission this harness has already
    // refused twice permanently refused, and every check below then measures that instead of the
    // app.
    resetPermissionState();
    // Out of the way. See `NOTIFICATIONS` - its dialog would otherwise eat every tap this makes -
    // and `ACCESSIBILITY_SUITE` for the same reason, because the reset above is device-wide and
    // that is the other package that asks immediately.
    setPermission(NOTIFICATIONS, true);
    setPermission(NOTIFICATIONS, true, ACCESSIBILITY_SUITE);

    // ---- after a launch that never scanned ---------------------------------
    process.stdout.write('Launching without touching the scan control...\n');
    const launched = coldStart('camera-launch');
    sleep(8_000);
    const afterLaunch = launched ? dumpsys() : null;

    // ---- the scan screen, opened and not pressed ---------------------------
    process.stdout.write('Opening the scan screen...\n');
    const reached = openScanScreen('open');
    const scanScreen = reached ? (collectScreenText() ?? []) : [];
    const afterOpening = reached ? dumpsys() : null;

    checks.push(
      controlCheck({
        reachedScanScreen: reached,
        showedDisclosure: scanScreen.some((line) => line.includes(SCAN_COPY.disclosure)),
      }),
    );

    checks.push(
      justInTimeCheck({
        grantedAfterLaunch: afterLaunch === null ? null : grantedPermissions(afterLaunch),
        grantedAfterOpeningScan: afterOpening === null ? null : grantedPermissions(afterOpening),
      }),
    );

    // ---- the control, pressed and refused ----------------------------------
    process.stdout.write('Pressing the camera control and refusing...\n');
    const pressed = reached && scrollToAndTap(SCAN_COPY.requestLabel);
    sleep(4_000);
    const dialogAppeared = pressed && permissionDialogVisible();
    const refused = dialogAppeared && refusePermissionDialog();
    sleep(5_000);

    const afterRefusal = refused ? (collectScreenText() ?? []) : [];
    checks.push(
      refusalCheck({
        dialogAppeared,
        refused,
        stillUngranted: refused ? cameraIsGranted() === false : null,
        manualPathOffered: afterRefusal.some((line) => line.includes(SCAN_COPY.manualLabel)),
        stillRunning: processId() !== null,
      }),
    );

    // ---- the subtraction ---------------------------------------------------
    const finalDump = dumpsys();
    checks.push(
      storageCheck({
        granted: finalDump === null ? null : grantedPermissions(finalDump),
        dumpsys: finalDump,
      }),
    );
  } finally {
    // Whatever happened. A device left with the camera revoked makes the next run's CAM-1 pass
    // for the wrong reason.
    dismissAnyPermissionDialog();
    if (grantedBefore !== null) setCamera(grantedBefore);
    if (notificationsBefore !== null) setPermission(NOTIFICATIONS, notificationsBefore);
    adb(['shell', 'am', 'force-stop', PACKAGE]);
  }

  checks.push(
    restorationCheck({
      cameraGrantedBefore: grantedBefore,
      cameraGrantedAfter: cameraIsGranted(),
    }),
  );

  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

main();
