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
 * An attached device with a build that **includes `expo-camera`**. That is a native module, so a
 * build made before it was added does not have it and this run will report `CAM-0` inconclusive -
 * correctly, because a scan screen that cannot mount is not a scan screen. `npx expo prebuild` and
 * a Gradle assemble are what fix that, and there is no way around it from here.
 *
 * WHAT IT DOES TO THE DEVICE
 * Revokes `android.permission.CAMERA` to establish a known starting state, drives the app to the
 * scan screen, presses the control, refuses the dialog, and reads `dumpsys package` at three
 * points. It records what the permission was before it started and puts it back in a `finally`.
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
  prepareDeviceForDriving,
  processId,
  scrollToAndTap,
  suppressStylusHandwriting,
  tapNamed,
} from './ui.js';

const CAMERA = 'android.permission.CAMERA';
const METRO_PORT = 8081;

function dumpsys(): string | null {
  const result = adb(['shell', 'dumpsys', 'package', PACKAGE]);
  return result.ok ? result.stdout : null;
}

function cameraIsGranted(): boolean | null {
  const output = dumpsys();
  return output === null ? null : grantedPermissions(output).includes(CAMERA);
}

function setCamera(granted: boolean): boolean {
  return adb(['shell', 'pm', granted ? 'grant' : 'revoke', PACKAGE, CAMERA]).ok;
}

/**
 * Whether Android's own permission dialog is on screen.
 *
 * Identified by the package that owns it rather than by its wording, which is localised and
 * changes between releases. `com.android.permissioncontroller` is the one that draws it on
 * everything this project targets.
 */
function permissionDialogVisible(): boolean {
  const result = adb(['shell', 'dumpsys', 'window', 'windows']);
  if (!result.ok) return false;
  return /permissioncontroller|GrantPermissionsActivity/i.test(result.stdout);
}

/**
 * Press the refusing button on Android's own permission dialog.
 *
 * Its wording differs by release and by whether the permission has been asked before - "Don't
 * allow", "Deny", and "Don't allow" again under a "Ask every time" variant - so several are tried
 * in order rather than one being assumed. `tapNamed` matches an accessible name exactly, which is
 * why these are literals rather than a pattern: the dialog is not this app's and guessing at its
 * text with a loose match risks pressing whichever button happens to contain the word.
 */
function refusePermissionDialog(): boolean {
  for (const label of ["Don't allow", 'Deny', 'DENY', "DON'T ALLOW"]) {
    if (tapNamed(label)) return true;
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

  try {
    // A known starting state. On a device where somebody already granted the camera, CAM-1's
    // answer would be yes for a reason that has nothing to do with this app.
    setCamera(false);

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
    if (grantedBefore !== null) setCamera(grantedBefore);
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
