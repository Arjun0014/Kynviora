import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_PERMISSIONS,
  controlCheck,
  declaresPermission,
  grantedPermissions,
  justInTimeCheck,
  refusalCheck,
  restorationCheck,
  storageCheck,
} from './cameraPermission.js';

/**
 * The judgements the camera-permission scenario applies, exercised with no device attached.
 *
 * Spec references: `19`, `16`, `04` Phase 2.2, DEC-102 (a check that could not be performed is
 * `INCONCLUSIVE` and fails the run - "could not look" must never be recorded as "looked and it
 * was fine").
 *
 * These are here for the reason every device module's judgements are: the rules decide whether
 * somebody's permissions are being respected, and a rule that only runs where hardware is
 * attached is a rule CI cannot stop anybody changing.
 */

const DUMPSYS_CLEAN = `
Package [com.kynviora.app] (1a2b3c):
  requested permissions:
    android.permission.CAMERA
    android.permission.POST_NOTIFICATIONS
    android.permission.USE_EXACT_ALARM
  install permissions:
    android.permission.USE_EXACT_ALARM: granted=true
  runtime permissions:
    android.permission.CAMERA: granted=false, flags=[ USER_SET ]
    android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]
`;

const DUMPSYS_WITH_CAMERA = DUMPSYS_CLEAN.replace(
  'android.permission.CAMERA: granted=false',
  'android.permission.CAMERA: granted=true',
);

const DUMPSYS_WITH_MEDIA = `${DUMPSYS_CLEAN}
    android.permission.READ_MEDIA_IMAGES: granted=true, flags=[ USER_SET ]
`;

const DUMPSYS_DECLARING_MEDIA = DUMPSYS_CLEAN.replace(
  '    android.permission.POST_NOTIFICATIONS\n',
  '    android.permission.POST_NOTIFICATIONS\n    android.permission.READ_MEDIA_IMAGES\n',
);

describe('reading the permission set', () => {
  it('reports granted runtime and install permissions and no ungranted ones', () => {
    // Both shapes, because a parser that read only `runtime permissions:` would report a normal
    // permission as absent - and the storage check is a subtraction, so a false absence there
    // reads as a pass.
    const granted = grantedPermissions(DUMPSYS_CLEAN);
    expect(granted).toContain('android.permission.POST_NOTIFICATIONS');
    expect(granted).toContain('android.permission.USE_EXACT_ALARM');
    expect(granted).not.toContain('android.permission.CAMERA');
  });

  it('finds a permission that is declared but not granted', () => {
    expect(declaresPermission(DUMPSYS_CLEAN, 'android.permission.CAMERA')).toBe(true);
    expect(declaresPermission(DUMPSYS_CLEAN, 'android.permission.READ_MEDIA_IMAGES')).toBe(false);
  });
});

describe('CAM-0, the control', () => {
  it('is inconclusive where the scan screen was never reached', () => {
    // Without this, every check below is also satisfied by a build with no scan control at all.
    const check = controlCheck({ reachedScanScreen: false, showedDisclosure: false });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('fails where the screen opened without the disclosure', () => {
    const check = controlCheck({ reachedScanScreen: true, showedDisclosure: false });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/take pictures and record video/);
  });

  it('passes where both are true', () => {
    expect(controlCheck({ reachedScanScreen: true, showedDisclosure: true }).status).toBe('PASS');
  });
});

describe('CAM-1, just in time', () => {
  it('fails where the permission was held after a launch that never scanned', () => {
    const check = justInTimeCheck({
      grantedAfterLaunch: grantedPermissions(DUMPSYS_WITH_CAMERA),
      grantedAfterOpeningScan: grantedPermissions(DUMPSYS_WITH_CAMERA),
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/outside the feature that needs it/);
  });

  it('fails where merely opening the scan screen granted it', () => {
    // The interesting failure, and the one a `useEffect` in the scan screen produces: still
    // just-in-time from the launcher, and not from the control.
    const check = justInTimeCheck({
      grantedAfterLaunch: grantedPermissions(DUMPSYS_CLEAN),
      grantedAfterOpeningScan: grantedPermissions(DUMPSYS_WITH_CAMERA),
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/Opening a screen is not using a feature/);
  });

  it('passes where neither reading holds it', () => {
    const check = justInTimeCheck({
      grantedAfterLaunch: grantedPermissions(DUMPSYS_CLEAN),
      grantedAfterOpeningScan: grantedPermissions(DUMPSYS_CLEAN),
    });
    expect(check.status).toBe('PASS');
  });

  it('is inconclusive where dumpsys could not be read', () => {
    expect(justInTimeCheck({ grantedAfterLaunch: null, grantedAfterOpeningScan: [] }).status).toBe(
      'INCONCLUSIVE',
    );
  });
});

describe('CAM-2, a refusal', () => {
  const refused = {
    dialogAppeared: true,
    refused: true,
    stillUngranted: true,
    manualPathOffered: true,
    stillRunning: true,
  };

  it('passes where the app survives and offers the manual path', () => {
    expect(refusalCheck(refused).status).toBe('PASS');
  });

  it('fails where the refusal left nothing to do', () => {
    const check = refusalCheck({ ...refused, manualPathOffered: false });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/manual entry the complete path/);
  });

  it('fails where the app stopped running', () => {
    expect(refusalCheck({ ...refused, stillRunning: false }).status).toBe('FAIL');
  });

  it('is inconclusive where no dialog appeared', () => {
    // Nothing was declined, so nothing below it is evidence about declining.
    expect(refusalCheck({ ...refused, dialogAppeared: false }).status).toBe('INCONCLUSIVE');
  });

  it('is inconclusive where the dialog was answered with a grant', () => {
    // The run measured the opposite scenario. Reporting that as a pass would be the harness
    // marking its own homework with a different question.
    expect(refusalCheck({ ...refused, stillUngranted: false }).status).toBe('INCONCLUSIVE');
  });
});

describe('CAM-3, no storage permission', () => {
  it('passes over a clean permission set', () => {
    const check = storageCheck({
      granted: grantedPermissions(DUMPSYS_CLEAN),
      dumpsys: DUMPSYS_CLEAN,
    });
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain(String(FORBIDDEN_PERMISSIONS.length));
  });

  it('fails where a media permission is granted', () => {
    const check = storageCheck({
      granted: grantedPermissions(DUMPSYS_WITH_MEDIA),
      dumpsys: DUMPSYS_WITH_MEDIA,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/READ_MEDIA_IMAGES/);
  });

  it('fails where one is declared and not granted', () => {
    // The failure a library pulls in without changing any screen. A declared permission still
    // appears on the Play listing and in the Data-safety form, which is the surface `16` is about.
    const check = storageCheck({
      granted: grantedPermissions(DUMPSYS_DECLARING_MEDIA),
      dumpsys: DUMPSYS_DECLARING_MEDIA,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/Declared in the merged manifest/);
  });

  it('is inconclusive where nothing could be read', () => {
    expect(storageCheck({ granted: null, dumpsys: null }).status).toBe('INCONCLUSIVE');
  });
});

describe('CAM-4, restoration', () => {
  it('passes where the permission is as it was found', () => {
    expect(restorationCheck({ cameraGrantedBefore: false, cameraGrantedAfter: false }).status).toBe(
      'PASS',
    );
  });

  it('fails where the run changed it', () => {
    // A device left with the camera revoked makes the next run's CAM-1 pass for the wrong reason.
    const check = restorationCheck({ cameraGrantedBefore: true, cameraGrantedAfter: false });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/would\s+measure a device this one changed/);
  });

  it('is inconclusive where either reading is missing', () => {
    expect(restorationCheck({ cameraGrantedBefore: null, cameraGrantedAfter: false }).status).toBe(
      'INCONCLUSIVE',
    );
  });
});
