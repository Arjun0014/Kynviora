/**
 * What an update over an existing install is allowed to do to somebody's local data.
 *
 * Spec references: `19` ("Android install/update"), `12` (encrypted structured local store, the
 * keystore-held key), `14` ("encrypted local storage validated" as a release gate), `04` Phase 0.1.
 *
 * Kept apart from the file that talks to a device, so every judgement below runs under
 * `npm run verify` with no hardware attached (DEC-102).
 *
 * WHY THIS IS A SEPARATE SCENARIO FROM `verify:device`
 * The storage harness proves the database is encrypted and that its key survives process death.
 * Neither says anything about what happens when the app is *replaced*. An update is the one
 * routine event that runs new code against an old file, and the failure it produces is total and
 * silent: a key that no longer derives, or a schema the new build cannot read, and every medicine,
 * schedule and profile a household kept offline is gone with no error anybody would connect to the
 * update. `12` makes the local store the thing a person relies on when they have no signal, which
 * is exactly when they cannot re-fetch what an update threw away.
 *
 * THE CONTROL THAT MAKES THE REST MEAN ANYTHING
 * "The data survived" is trivially true of an app that had none, and it is also true of a *fresh*
 * install that simply re-fetched everything from the API. So two things are asserted before any
 * survival claim is allowed to count: the store held the known content beforehand, and the package
 * manager agrees this was an update rather than a reinstall - `firstInstallTime` unchanged and
 * `lastUpdateTime` moved. Without the second, `adb install -r` silently falling back to a clean
 * install would produce a green run that proves the opposite of what it claims.
 */

import type { Check } from './analysis.js';

/**
 * What the package manager says about when this app arrived and when it last changed.
 *
 * Both times are needed and neither is enough alone. `lastUpdateTime` moving says something
 * happened; `firstInstallTime` staying put says the app was not removed and re-added underneath
 * it, which is the case that would take the data directory with it.
 */
export interface InstallIdentity {
  readonly firstInstallTime: string;
  readonly lastUpdateTime: string;
  readonly versionCode: string;
}

/**
 * Read the install identity out of `dumpsys package <name>`.
 *
 * Returns `null` where either time is missing rather than defaulting them, because two absent
 * values compare equal and would report a reinstall as an update.
 */
export function parseInstallIdentity(dump: string): InstallIdentity | null {
  const first = /firstInstallTime=(\S+ \S+)/.exec(dump);
  const last = /lastUpdateTime=(\S+ \S+)/.exec(dump);
  const version = /versionCode=(\d+)/.exec(dump);
  if (first === null || last === null) return null;
  return {
    firstInstallTime: first[1] ?? '',
    lastUpdateTime: last[1] ?? '',
    versionCode: version?.[1] ?? '',
  };
}

/**
 * Whether what happened was an update over the existing install.
 *
 * This is the run's precondition rather than one of its findings. Every check after it is about
 * data surviving a replacement, and none of them means anything if the package manager took the
 * data directory away and put a clean one back - that path also produces a working app.
 */
export function updateNotReinstallCheck(
  before: InstallIdentity | null,
  after: InstallIdentity | null,
  installReported: boolean,
): Check {
  const id = 'UPD-1';
  const title = 'The package manager replaced the app rather than reinstalling it';

  if (before === null || after === null) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The install times could not be read from `dumpsys package`, so whether this was an ' +
        'update or a clean install is unknown - and a clean install passes every later check ' +
        'for the wrong reason.',
    };
  }
  if (!installReported) {
    return { id, title, status: 'FAIL', detail: 'The install command did not report success.' };
  }
  if (before.firstInstallTime !== after.firstInstallTime) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `\`firstInstallTime\` moved from ${before.firstInstallTime} to ${after.firstInstallTime}: ` +
        'the app was removed and installed again, which takes the data directory with it. ' +
        'Nothing after this is a statement about updates.',
    };
  }
  if (before.lastUpdateTime === after.lastUpdateTime) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        `\`lastUpdateTime\` did not move (${after.lastUpdateTime}), so the package may not have ` +
        'been replaced at all and the store was never asked to survive anything.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      `Installed over the existing app: \`firstInstallTime\` unchanged at ` +
      `${after.firstInstallTime}, \`lastUpdateTime\` moved to ${after.lastUpdateTime}.`,
  };
}

/**
 * Whether the encrypted database is still there, and still the same file.
 *
 * Byte equality rather than mere existence. A new build that could not open the old file and
 * quietly created a fresh one would leave a database at the same path, of a plausible size, that
 * a person's data is simply not in - and "the file exists" would call that a pass.
 */
export function databaseSurvivedCheck(
  before: Uint8Array | null,
  after: Uint8Array | null,
  path: string,
): Check {
  const id = 'UPD-2';
  const title = 'The encrypted database is the same file after the update';

  if (before === null) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: `Nothing could be read from ${path} before the update, so nothing had to survive it.`,
    };
  }
  if (before.length === 0) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: `${path} was empty before the update. An empty file survives everything.`,
    };
  }
  if (after === null) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: `${path} is gone after the update. Everything the household kept offline went with it.`,
    };
  }
  if (after.length !== before.length) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `${path} changed size across the update, ${String(before.length)} bytes to ` +
        `${String(after.length)}. The new build did not open the file it was given.`,
    };
  }

  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) {
      return {
        id,
        title,
        status: 'FAIL',
        detail: `${path} differs from the pre-update file at byte ${String(index)}.`,
      };
    }
  }

  return {
    id,
    title,
    status: 'PASS',
    detail: `${path} is byte-identical across the update, all ${String(after.length)} of them.`,
  };
}

/**
 * Whether the new build can still decrypt what the old one wrote.
 *
 * The claim the whole scenario exists for. `12` puts the key in the keystore under an alias rather
 * than in the app's own files, so an update should not touch it - but "should not" is what this
 * check refuses to accept, because an alias changed by a build, or a key regenerated on a failed
 * read, both produce a running app in front of an unreadable file.
 *
 * `heldContent` is what the app displayed with the API out of reach, so it can only have come out
 * of the local store. `keyFailed` is read from the log independently: an app that fell back to an
 * empty store shows an empty screen, which is not the same as a screen showing stale data and must
 * not be reported as one.
 */
export function keySurvivedUpdateCheck(input: {
  readonly shownOffline: boolean;
  readonly keyFailed: boolean;
  readonly apiWasUnreachable: boolean;
}): Check {
  const id = 'UPD-3';
  const title = 'The keystore key still opens the database the previous build wrote';

  if (!input.apiWasUnreachable) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The API was still reachable during the read-back, so anything on the screen may have ' +
        'been fetched rather than decrypted.',
    };
  }
  if (input.keyFailed) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'The app logged a failure to open the database after the update. The key did not survive ' +
        'the replacement, and every offline copy is unreadable.',
    };
  }
  return {
    id,
    title,
    status: input.shownOffline ? 'PASS' : 'FAIL',
    detail: input.shownOffline
      ? 'With the API out of reach, the updated app showed content that only the local store had.'
      : 'With the API out of reach, the updated app showed none of the content the store held ' +
        'before the update.',
  };
}

/**
 * Whether the updated app started at all.
 *
 * Separate from the data checks and reported separately, because a crash makes every one of them
 * inconclusive rather than failing: an app that did not run did not fail to read anything.
 */
export function survivedLaunchCheck(crashed: boolean, launched: boolean): Check {
  const id = 'UPD-4';
  const title = 'The updated app launches without crashing';
  if (!launched) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'The app had no running process after the update and a launch.',
    };
  }
  return {
    id,
    title,
    status: crashed ? 'FAIL' : 'PASS',
    detail: crashed
      ? 'The app crashed on its first launch after the update.'
      : 'The app launched and stayed running after the update.',
  };
}

/**
 * Whether the reminders somebody had set are still pending after the update.
 *
 * Android drops an app's alarms when its package is replaced. `expo-notifications` registers for
 * `MY_PACKAGE_REPLACED` and re-registers from its own store, which is the same mechanism that
 * restores them after a reboot - so this is that mechanism measured on the other event that
 * triggers it. A person who updates an app is not expecting to lose their medicine reminders, and
 * would not find out until a dose did not arrive.
 *
 * `before === 0` is inconclusive rather than a pass, for the same reason it is on the reboot
 * check: nothing pending is not evidence of recovery.
 */
export function remindersSurvivedUpdateCheck(
  before: number,
  after: number,
  available: boolean,
): Check {
  const id = 'UPD-5';
  const title = 'Reminders are still pending after the app is replaced';
  if (!available) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The alarm dump could not be read.' };
  }
  if (before === 0) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'No reminders were pending before the update, so none had to come back.',
    };
  }
  return {
    id,
    title,
    status: after > 0 ? 'PASS' : 'FAIL',
    detail:
      after > 0
        ? `${String(after)} of ${String(before)} pending alarm(s) are held after the package was replaced.`
        : `None of the ${String(before)} pending alarm(s) came back after the package was replaced. ` +
          'Somebody who updates the app stops being reminded, and finds out by missing a dose.',
  };
}
