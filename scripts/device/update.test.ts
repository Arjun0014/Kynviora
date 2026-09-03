import { describe, it, expect } from 'vitest';
import {
  databaseSurvivedCheck,
  keySurvivedUpdateCheck,
  parseInstallIdentity,
  remindersSurvivedUpdateCheck,
  survivedLaunchCheck,
  updateNotReinstallCheck,
  type InstallIdentity,
} from './update.js';

/**
 * The rules that decide whether an update over an existing install kept somebody's data.
 *
 * Runnable with no device attached (DEC-102). The failure these guard against is total and silent:
 * a key that no longer derives, or a file the new build could not open, and everything a household
 * kept offline is gone with no error anybody would connect to the update.
 */

/** A real capture from `dumpsys package com.kynviora.app` on a Pixel 7 emulator, API 36. */
const PACKAGE_DUMP = `
    versionCode=1 minSdk=24 targetSdk=36
    versionName=0.1.0
    lastUpdateTime=2026-09-03 12:25:27
      firstInstallTime=2026-09-03 01:42:56
    User 0: ceDataInode=557556 installed=true stopped=false
`;

describe('reading what the package manager says about an install', () => {
  it('reads both times and the version', () => {
    const identity = parseInstallIdentity(PACKAGE_DUMP);
    expect(identity).toEqual({
      firstInstallTime: '2026-09-03 01:42:56',
      lastUpdateTime: '2026-09-03 12:25:27',
      versionCode: '1',
    });
  });

  it('returns null when a time is missing rather than defaulting it', () => {
    // Two absent values compare equal, and equal times are how a reinstall would be reported as
    // an update. Refusing to parse is the only safe answer.
    expect(parseInstallIdentity('versionCode=1\nlastUpdateTime=2026-09-03 12:25:27')).toBeNull();
    expect(parseInstallIdentity('')).toBeNull();
  });
});

describe('whether the app was updated or reinstalled', () => {
  const before: InstallIdentity = {
    firstInstallTime: '2026-09-03 01:42:56',
    lastUpdateTime: '2026-09-03 12:25:27',
    versionCode: '1',
  };
  const after: InstallIdentity = { ...before, lastUpdateTime: '2026-09-03 18:02:11' };

  it('passes when the first install held and the update time moved', () => {
    expect(updateNotReinstallCheck(before, after, true).status).toBe('PASS');
  });

  it('fails when the app was removed and installed again', () => {
    // The case that would make every later check pass for the wrong reason: a clean install also
    // produces a working app, with none of the person's data in it.
    const reinstalled: InstallIdentity = { ...after, firstInstallTime: '2026-09-03 18:02:11' };
    const check = updateNotReinstallCheck(before, reinstalled, true);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/removed and installed again/i);
  });

  it('is inconclusive when nothing was actually replaced', () => {
    expect(updateNotReinstallCheck(before, before, true).status).toBe('INCONCLUSIVE');
  });

  it('is inconclusive when the times could not be read', () => {
    expect(updateNotReinstallCheck(null, after, true).status).toBe('INCONCLUSIVE');
    expect(updateNotReinstallCheck(before, null, true).status).toBe('INCONCLUSIVE');
  });

  it('fails when the install command itself did not succeed', () => {
    expect(updateNotReinstallCheck(before, after, false).status).toBe('FAIL');
  });
});

describe('whether the encrypted database survived', () => {
  const bytes = (...values: number[]) => new Uint8Array(values);
  const path = '/data/data/com.kynviora.app/files/SQLite/kynviora.db';

  it('passes when the file is byte-identical', () => {
    const check = databaseSurvivedCheck(bytes(1, 2, 3, 4), bytes(1, 2, 3, 4), path);
    expect(check.status).toBe('PASS');
  });

  it('fails when the file is gone', () => {
    const check = databaseSurvivedCheck(bytes(1, 2, 3), null, path);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/went with it/i);
  });

  it('fails when a new build quietly wrote a fresh database', () => {
    // The failure that "the file exists" would call a pass: same path, plausible size, none of the
    // person's data in it.
    expect(databaseSurvivedCheck(bytes(1, 2, 3, 4), bytes(9, 9), path).status).toBe('FAIL');
  });

  it('fails on a same-length file whose contents changed', () => {
    const check = databaseSurvivedCheck(bytes(1, 2, 3, 4), bytes(1, 2, 9, 4), path);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/byte 2/);
  });

  it('refuses to call an empty or absent starting file a survival', () => {
    // An empty file survives everything. Reporting that as a pass is the whole class of mistake
    // this harness exists to avoid.
    expect(databaseSurvivedCheck(bytes(), bytes(), path).status).toBe('INCONCLUSIVE');
    expect(databaseSurvivedCheck(null, bytes(1), path).status).toBe('INCONCLUSIVE');
  });
});

describe('whether the key still opens what the previous build wrote', () => {
  it('passes when the offline read-back showed stored content', () => {
    const check = keySurvivedUpdateCheck({
      shownOffline: true,
      keyFailed: false,
      apiWasUnreachable: true,
    });
    expect(check.status).toBe('PASS');
  });

  it('fails when the app logged that it could not open the database', () => {
    expect(
      keySurvivedUpdateCheck({ shownOffline: false, keyFailed: true, apiWasUnreachable: true })
        .status,
    ).toBe('FAIL');
  });

  it('fails when nothing the store held came back', () => {
    expect(
      keySurvivedUpdateCheck({ shownOffline: false, keyFailed: false, apiWasUnreachable: true })
        .status,
    ).toBe('FAIL');
  });

  it('is inconclusive when the API could still have served the screen', () => {
    // Without this the check passes on a build whose key was destroyed, because the app simply
    // re-fetched everything and the screen looks identical.
    expect(
      keySurvivedUpdateCheck({ shownOffline: true, keyFailed: false, apiWasUnreachable: false })
        .status,
    ).toBe('INCONCLUSIVE');
  });
});

describe('whether the updated app runs at all', () => {
  it('passes when it launched and did not crash', () => {
    expect(survivedLaunchCheck(false, true).status).toBe('PASS');
  });

  it('fails when it crashed', () => {
    expect(survivedLaunchCheck(true, true).status).toBe('FAIL');
  });

  it('fails when it never started', () => {
    expect(survivedLaunchCheck(false, false).status).toBe('FAIL');
  });
});

describe('whether reminders survive the package being replaced', () => {
  it('passes when they came back', () => {
    const check = remindersSurvivedUpdateCheck(15, 15, true);
    expect(check.status).toBe('PASS');
  });

  it('fails when they did not', () => {
    // Android drops an app's alarms on package replace, and a person who updates the app is not
    // expecting to lose their medicine reminders. They would find out by missing a dose.
    const check = remindersSurvivedUpdateCheck(15, 0, true);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/missing a dose/i);
  });

  it('is inconclusive when nothing was pending beforehand', () => {
    expect(remindersSurvivedUpdateCheck(0, 0, true).status).toBe('INCONCLUSIVE');
  });

  it('is inconclusive when the dump could not be read', () => {
    expect(remindersSurvivedUpdateCheck(15, 15, false).status).toBe('INCONCLUSIVE');
  });
});
