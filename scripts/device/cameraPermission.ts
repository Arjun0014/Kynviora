/**
 * What the camera-and-file-permission scenario's evidence means.
 *
 * Spec references: `19` (its fourteen device scenarios include camera and file permissions),
 * `16` (request only permissions a visible feature needs, at the moment it is used; prominent
 * disclosure before a sensitive permission; no broad storage permission; the Play permissions and
 * Data-safety mapping), `09` and `17` (unconfirmed machine output never becomes trusted truth),
 * `04` Phase 2.2, `DEV-040`, DEC-102.
 *
 * Kept apart from the runner so the judgements run in `npm run verify` with nothing attached.
 *
 * WHAT THIS SCENARIO IS ACTUALLY FOR
 * Not "does the camera work". Three things, and each is a claim the app makes that only a device
 * can check:
 *
 *  1. **Nothing is asked for until somebody asks.** The manifest has declared
 *     `android.permission.CAMERA` since the first build, and a declared permission is one Android
 *     will happily prompt for at any moment the app chooses. `16` says the moment must be a
 *     visible feature being used. The evidence is a permission that is *not held* after a launch
 *     that never touched the scan control.
 *  2. **Declining leaves the app usable.** `04` Phase 2.2 makes manual entry the complete path,
 *     which means a refusal has to land on a form rather than on an apology - and the difference
 *     between a refusal it can retry and one it cannot has to reach the screen, because offering
 *     "try again" to somebody Android will not let the app ask is a button that does nothing.
 *  3. **No storage permission exists at all.** This is a subtraction and it is the check most
 *     likely to start failing by accident: a library added later for an unrelated reason can pull
 *     `READ_MEDIA_IMAGES` into the merged manifest, and nothing on any screen would change.
 *
 * WHY A REAL SCAN IS NOT ONE OF THEM
 * Holding a printed barcode in front of an emulator's virtual camera is not a thing a harness can
 * arrange, and the emulator's virtual scene is not a product pack. What a device run can honestly
 * measure is the permission behaviour and the screens on either side of it; what a real read of a
 * real symbol does is a manual check, and saying so is better than a green tick over a fixture.
 */

import type { Check } from './analysis.js';

/** Permissions that must never appear in the app's granted set. */
export const FORBIDDEN_PERMISSIONS = [
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.RECORD_AUDIO',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.READ_CONTACTS',
] as const;

/**
 * Which runtime permissions `dumpsys package` reports as granted.
 *
 * The output has two relevant shapes - `runtime permissions:` entries carrying `granted=true`, and
 * `install permissions:` entries carrying `granted=true` - and a parser that read only the first
 * would report a normal permission as absent. Both are scanned, and the name is taken from the
 * line rather than searched for, so a permission this file has never heard of is still reported.
 */
export function grantedPermissions(dumpsys: string): readonly string[] {
  const granted: string[] = [];
  for (const rawLine of dumpsys.split('\n')) {
    const line = rawLine.trim();
    const match = /^(android\.permission\.[A-Z_]+):\s*granted=(true|false)/.exec(line);
    if (match && match[2] === 'true' && match[1] !== undefined) granted.push(match[1]);
  }
  return granted;
}

/** Whether a permission appears in the app's manifest at all, granted or not. */
export function declaresPermission(dumpsys: string, permission: string): boolean {
  return new RegExp(`${permission.replace(/\./g, '\\.')}\\b`).test(dumpsys);
}

// ---------------------------------------------------------------------------
// CAM-0 - the control
// ---------------------------------------------------------------------------

export interface ControlEvidence {
  /** Whether the run reached the scan screen at all. */
  readonly reachedScanScreen: boolean;
  /** Whether the disclosure sentence was on screen there. */
  readonly showedDisclosure: boolean;
}

/**
 * The app can be driven to the scan screen, and it explains itself before asking.
 *
 * The positive control this scenario needs, for the reason `LOW-0` exists: every other check here
 * is about a permission **not** being held, and an app that crashed on launch, or a build with no
 * scan control at all, would satisfy all of them. This is the run proving there is a feature to
 * measure before it measures what the feature does not do.
 *
 * The disclosure is part of the control rather than a check of its own because `16` asks for it
 * *before* the system dialog, and the only way to observe that ordering is to see it on a screen
 * where the dialog has not appeared yet.
 */
export function controlCheck(evidence: ControlEvidence): Check {
  const title = 'The scan screen opens and says what the camera is for before asking';
  if (!evidence.reachedScanScreen) {
    return {
      id: 'CAM-0',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The scan screen was never reached, so nothing below is evidence about permissions - ' +
        'an app with no scan control passes every one of them.',
    };
  }
  if (!evidence.showedDisclosure) {
    return {
      id: 'CAM-0',
      title,
      status: 'FAIL',
      detail:
        'The scan screen opened without the disclosure. Android’s own dialog says only ' +
        '"take pictures and record video", which is true of a camera and useless about this ' +
        'feature (16).',
    };
  }
  return {
    id: 'CAM-0',
    title,
    status: 'PASS',
    detail: 'The disclosure was on screen with no system dialog shown.',
  };
}

// ---------------------------------------------------------------------------
// CAM-1 - nothing is asked for until somebody asks
// ---------------------------------------------------------------------------

export interface JustInTimeEvidence {
  /** Granted permissions after a launch that never touched the scan control. */
  readonly grantedAfterLaunch: readonly string[] | null;
  /** Granted permissions after the scan screen was opened and nothing pressed. */
  readonly grantedAfterOpeningScan: readonly string[] | null;
}

const CAMERA = 'android.permission.CAMERA';

/**
 * The camera permission is not held until somebody chooses to scan.
 *
 * Two readings rather than one, because the interesting failure is the second: a permission
 * requested when a *screen mounts* rather than when a control is pressed still looks just-in-time
 * from the launcher, and is exactly what a `useEffect` in the scan screen would produce.
 */
export function justInTimeCheck(evidence: JustInTimeEvidence): Check {
  const title = 'The camera permission is not held until somebody asks to scan';
  if (evidence.grantedAfterLaunch === null || evidence.grantedAfterOpeningScan === null) {
    return {
      id: 'CAM-1',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The granted permission set could not be read from dumpsys.',
    };
  }
  if (evidence.grantedAfterLaunch.includes(CAMERA)) {
    return {
      id: 'CAM-1',
      title,
      status: 'FAIL',
      detail:
        'CAMERA was granted after a launch that never touched the scan control. Something is ' +
        'requesting it outside the feature that needs it (16).',
    };
  }
  if (evidence.grantedAfterOpeningScan.includes(CAMERA)) {
    return {
      id: 'CAM-1',
      title,
      status: 'FAIL',
      detail:
        'CAMERA was granted merely by opening the scan screen. Opening a screen is not using a ' +
        'feature; pressing the control is.',
    };
  }
  return {
    id: 'CAM-1',
    title,
    status: 'PASS',
    detail: 'Not granted after launch, and not granted by opening the scan screen.',
  };
}

// ---------------------------------------------------------------------------
// CAM-2 - a refusal leaves the app usable
// ---------------------------------------------------------------------------

export interface RefusalEvidence {
  /** Whether the system permission dialog appeared after the control was pressed. */
  readonly dialogAppeared: boolean;
  /** Whether it was dismissed with a refusal. */
  readonly refused: boolean;
  /** Whether CAMERA is still ungranted afterwards. */
  readonly stillUngranted: boolean | null;
  /** Whether the manual-entry control was reachable on the screen that followed. */
  readonly manualPathOffered: boolean;
  /** Whether the app was still running. */
  readonly stillRunning: boolean;
}

/**
 * Declining the camera leaves a person able to finish.
 *
 * `04` Phase 2.2 makes manual entry the complete path, so this is not a graceful-degradation
 * nicety - it is the feature working as designed for somebody who said no. The check requires the
 * refusal to have actually happened (`stillUngranted`), because a dialog that was dismissed by
 * granting would make the rest of the evidence describe a different scenario.
 */
export function refusalCheck(evidence: RefusalEvidence): Check {
  const title = 'Declining the camera leaves the manual path available';
  if (!evidence.dialogAppeared) {
    return {
      id: 'CAM-2',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'No system permission dialog appeared after the control was pressed, so there was ' +
        'nothing to decline. Either the request was never made or the permission was already ' +
        'decided.',
    };
  }
  if (!evidence.refused || evidence.stillUngranted !== true) {
    return {
      id: 'CAM-2',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The dialog was not dismissed with a refusal, so this run measured a grant.',
    };
  }
  if (!evidence.stillRunning) {
    return {
      id: 'CAM-2',
      title,
      status: 'FAIL',
      detail: 'The app was not running after the refusal.',
    };
  }
  if (!evidence.manualPathOffered) {
    return {
      id: 'CAM-2',
      title,
      status: 'FAIL',
      detail:
        'The refusal left no way to type the number. 04 Phase 2.2 makes manual entry the ' +
        'complete path, and a scan is a shortcut into it.',
    };
  }
  return {
    id: 'CAM-2',
    title,
    status: 'PASS',
    detail: 'Refused, still running, and the manual path was on screen.',
  };
}

// ---------------------------------------------------------------------------
// CAM-3 - no storage permission, at all
// ---------------------------------------------------------------------------

export interface StorageEvidence {
  readonly granted: readonly string[] | null;
  /** The whole dumpsys output, so a *declared* permission is caught as well as a granted one. */
  readonly dumpsys: string | null;
}

/**
 * The app holds no permission over the device's photographs or files.
 *
 * A subtraction, and the check here most likely to start failing by accident: a library added
 * later for an unrelated reason can pull `READ_MEDIA_IMAGES` into the merged manifest, and nothing
 * on any screen would change. `16` names over-granting specifically, and reading digits off one
 * image is not a reason to hold a permission over every image on the device.
 *
 * Both granted **and declared** are checked. A declared-but-ungranted media permission still
 * appears on the Play listing and in the Data-safety form, which is the surface `16` cares about.
 */
export function storageCheck(evidence: StorageEvidence): Check {
  const title = 'The app holds no storage, media, audio or location permission';
  if (evidence.granted === null || evidence.dumpsys === null) {
    return {
      id: 'CAM-3',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The permission set could not be read from dumpsys.',
    };
  }

  const held = FORBIDDEN_PERMISSIONS.filter((permission) => evidence.granted?.includes(permission));
  if (held.length > 0) {
    return {
      id: 'CAM-3',
      title,
      status: 'FAIL',
      detail: `Granted: ${held.join(', ')}.`,
    };
  }

  const declared = FORBIDDEN_PERMISSIONS.filter((permission) =>
    declaresPermission(evidence.dumpsys ?? '', permission),
  );
  if (declared.length > 0) {
    return {
      id: 'CAM-3',
      title,
      status: 'FAIL',
      detail:
        `Declared in the merged manifest, though not granted: ${declared.join(', ')}. ` +
        'A declared permission appears on the Play listing and in the Data-safety form (16).',
    };
  }

  return {
    id: 'CAM-3',
    title,
    status: 'PASS',
    detail: `None of the ${String(FORBIDDEN_PERMISSIONS.length)} is granted or declared.`,
  };
}

// ---------------------------------------------------------------------------
// CAM-4 - the state the run found is the state it leaves
// ---------------------------------------------------------------------------

export interface RestorationEvidence {
  readonly cameraGrantedBefore: boolean | null;
  readonly cameraGrantedAfter: boolean | null;
}

/**
 * The run put the camera permission back the way it found it.
 *
 * Not housekeeping. This scenario revokes a permission to establish its starting state, and a
 * device left with the camera revoked makes the *next* run's `CAM-1` pass for the wrong reason -
 * a check that is green because a previous run broke something is worse than a red one.
 */
export function restorationCheck(evidence: RestorationEvidence): Check {
  const title = 'The camera permission was left as the run found it';
  if (evidence.cameraGrantedBefore === null || evidence.cameraGrantedAfter === null) {
    return {
      id: 'CAM-4',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The permission state before or after the run could not be read.',
    };
  }
  if (evidence.cameraGrantedBefore !== evidence.cameraGrantedAfter) {
    return {
      id: 'CAM-4',
      title,
      status: 'FAIL',
      detail:
        `CAMERA was ${evidence.cameraGrantedBefore ? 'granted' : 'not granted'} before and ` +
        `${evidence.cameraGrantedAfter ? 'granted' : 'not granted'} after. The next run would ` +
        'measure a device this one changed.',
    };
  }
  return {
    id: 'CAM-4',
    title,
    status: 'PASS',
    detail: `CAMERA ${evidence.cameraGrantedAfter ? 'granted' : 'not granted'}, as found.`,
  };
}
