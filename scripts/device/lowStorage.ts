/**
 * What the low-storage scenario's evidence means.
 *
 * Spec references: `19` ("low storage/network disruption"), `12` (the pending-operation journal; a
 * queued change is **visible** rather than assumed), `18` (say what happened, never something
 * softer than the truth), `04` Phase 4.3, `DEV-040`, DEC-102, DEC-111.
 *
 * Kept apart from the runner so the judgements run in `npm run verify` with nothing attached.
 *
 * WHAT "LOW STORAGE" IS BEING TAKEN TO MEAN, SAID PLAINLY
 * A device with no room left is a device whose apps cannot write. For this app that lands in one
 * place: the encrypted local store, which holds the projection and the offline journal. So the
 * condition the run produces is **the app cannot write to its own store**, and it produces it by
 * removing write permission from the store's directory inside the app's own sandbox.
 *
 * That is a stand-in and the report says so. It is not the same as `ENOSPC`: a full filesystem
 * also fails a temporary file, a log write and the keystore's own bookkeeping, and it makes
 * Android itself behave differently. What it is, is the same failure at the same layer - the point
 * at which SQLCipher's write returns an error - which is where every consequence this app can have
 * begins.
 *
 * It is also the version that can be undone. Filling a 10GB partition to zero to reach the same
 * error is reversible only while the run is alive to reverse it, and a harness that can wedge the
 * device it is measuring is one nobody will run twice. A `chmod` on one directory is restored by a
 * `chmod` back, and by the next run before it starts.
 *
 * THE FAILURE WORTH MEASURING IS A SENTENCE
 * Not the crash - a crash is loud and somebody would find it. What `12` is about is the quiet one:
 * a person records a dose with no signal, the journal cannot take it, and the screen tells them it
 * is kept on this phone. They stop thinking about it. Nothing has their record and nothing ever
 * will, and there is no moment at which they find out.
 */

import type { Check } from './analysis.js';

// ---------------------------------------------------------------------------
// LOW-0 - the control
// ---------------------------------------------------------------------------

export interface ControlEvidence {
  /** Whether the run drove the record-a-dose screen with storage untouched. */
  readonly driven: boolean;
  /** Whether the screen said the dose is kept on this phone, with the API unreachable. */
  readonly saidQueued: boolean;
  /** Events on the server before and after that attempt. It must not have reached one. */
  readonly serverBefore: number | null;
  readonly serverAfter: number | null;
}

/**
 * With storage working, an offline dose is queued and the screen says so.
 *
 * The positive control, and this scenario needs one more than most: every check below is about the
 * app **not** doing something, and an app that failed at everything - a broken drive, a screen
 * that never opened, a build that does not run - would satisfy all of them. This is the run
 * proving it can tell a working save from a refused one before it takes storage away.
 *
 * The server counts are the other half. A dose that reached the server was never queued, so the
 * queue was never the thing under test.
 */
export function controlCheck(evidence: ControlEvidence): Check {
  const title = 'With storage working, an offline dose is queued and the screen says so';
  if (!evidence.driven || evidence.serverBefore === null || evidence.serverAfter === null) {
    return {
      id: 'LOW-0',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The record-a-dose screen was never driven with storage untouched.',
    };
  }
  if (evidence.serverAfter !== evidence.serverBefore) {
    return {
      id: 'LOW-0',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `The server went from ${String(evidence.serverBefore)} to ` +
        `${String(evidence.serverAfter)} event(s), so the request reached it and the journal was ` +
        'never what handled this dose. The switch was supposed to be unreachable.',
    };
  }
  if (!evidence.saidQueued) {
    return {
      id: 'LOW-0',
      title,
      status: 'FAIL',
      detail:
        'The screen did not say the dose is kept on this phone, with storage working and the API ' +
        'unreachable. Either the queue is broken independently of this scenario, or the run did ' +
        'not reach the screen it thinks it did - and every check below would then be measuring ' +
        'an app that refuses everything.',
    };
  }
  return {
    id: 'LOW-0',
    title,
    status: 'PASS',
    detail:
      'The dose was queued and the screen said it is kept on this phone, with nothing reaching ' +
      'the server. The run can tell a queued save from a refused one.',
  };
}

// ---------------------------------------------------------------------------
// LOW-1 - the condition was actually produced
// ---------------------------------------------------------------------------

export interface ConditionEvidence {
  /** Whether the store's directory was made unwritable. */
  readonly applied: boolean;
  /** Whether a write into it was refused afterwards, tested directly rather than assumed. */
  readonly writeRefused: boolean | null;
}

/**
 * The store really could not be written.
 *
 * `chmod` on Android can succeed and change nothing - the app runs as its own user, some
 * filesystems ignore the mode, and a directory that is already open may keep working. So the run
 * tests the condition rather than trusting that it applied it: it tries to create a file in the
 * same directory, as the app's own user, and requires that to fail.
 *
 * Without this, every "the app did not claim success" result below would be equally true of a run
 * in which storage was never constrained at all (DEC-102).
 */
export function conditionCheck(evidence: ConditionEvidence): Check {
  const title = 'The app’s own store could not be written during the constrained run';
  if (!evidence.applied || evidence.writeRefused === null) {
    return {
      id: 'LOW-1',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The store could not be made unwritable, so no constrained run happened.',
    };
  }
  if (!evidence.writeRefused) {
    return {
      id: 'LOW-1',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The directory was changed and a write into it still succeeded, so the condition was ' +
        'never produced. Everything after this would be true of an unconstrained device.',
    };
  }
  return {
    id: 'LOW-1',
    title,
    status: 'PASS',
    detail:
      'A write into the store directory was refused as the app’s own user, so what follows was ' +
      'measured against a store that genuinely could not take a write.',
  };
}

// ---------------------------------------------------------------------------
// LOW-2 - and the app did not claim to have kept anything
// ---------------------------------------------------------------------------

export interface ClaimEvidence {
  /** Whether the constrained run reached the record-a-dose screen and pressed a control. */
  readonly attempted: boolean;
  /** Whether the screen said the dose is kept on this phone. */
  readonly saidQueued: boolean;
  /** Whether the screen said "Recorded." */
  readonly saidRecorded: boolean;
  /** Whether the screen said anything at all about the attempt. */
  readonly saidSomething: boolean;
}

/**
 * The one that matters. A record nothing kept must not be described as kept.
 *
 * `12` requires a queued change to be visible rather than assumed, and the sentence
 * `DOSE_COPY.offlineNote` is that promise in words: "Recorded on this phone. It will reach
 * Kynviora when you are back online." If the journal refused the write, both halves of that are
 * false, and the person has been told their dose is safe at the moment it was lost.
 *
 * "Recorded." is worse again, because it claims the server has it.
 *
 * Saying *nothing* is a third failure and a quieter one: a screen that neither confirms nor
 * refuses leaves somebody to guess, and `18` is explicit that a person must be able to tell what
 * happened.
 */
export function claimCheck(evidence: ClaimEvidence): Check {
  const title = 'A dose nothing could keep is not described as kept';
  if (!evidence.attempted) {
    return {
      id: 'LOW-2',
      title,
      status: 'INCONCLUSIVE',
      detail: 'No dose was attempted under the constrained store.',
    };
  }
  if (evidence.saidRecorded) {
    return {
      id: 'LOW-2',
      title,
      status: 'FAIL',
      detail:
        'The screen said "Recorded." while the store could not be written and the server was ' +
        'unreachable. That claims the server has a record nothing has.',
    };
  }
  if (evidence.saidQueued) {
    return {
      id: 'LOW-2',
      title,
      status: 'FAIL',
      detail:
        'The screen said the dose is kept on this phone and will be sent, and the journal had ' +
        'just refused to take it. Both halves of that sentence are false, and the person stops ' +
        'thinking about a record that does not exist (`12`).',
    };
  }
  if (!evidence.saidSomething) {
    return {
      id: 'LOW-2',
      title,
      status: 'FAIL',
      detail:
        'The screen said nothing at all. A person who pressed a control and was neither confirmed ' +
        'nor refused is left to guess whether their dose was recorded, which `18` does not allow.',
    };
  }
  return {
    id: 'LOW-2',
    title,
    status: 'PASS',
    detail:
      'The screen reported the attempt without claiming the dose was recorded or kept, which is ' +
      'the only true thing it could say.',
  };
}

// ---------------------------------------------------------------------------
// LOW-3 - and it did not fall over
// ---------------------------------------------------------------------------

export interface StabilityEvidence {
  /** Whether the app raised a fatal exception during the constrained run. */
  readonly crashed: boolean | null;
  /** Whether the app's process was still alive at the end of it. */
  readonly stillRunning: boolean;
  /**
   * Whether a promise rejected with nobody to catch it.
   *
   * A separate question from a crash and a more likely one. A store that will not take a write
   * makes every `expo-sqlite` call reject, and this app has several that are started and not
   * awaited - a projection write, a session purge - because their result is a cache rather than
   * somebody's data. Fire-and-forget without a `catch` turns each of those into an unhandled
   * rejection: in a development build React Native draws a banner across the app, and in a release
   * build the handler is whatever the platform's default is. Neither is the app deciding anything.
   *
   * This is the check that found `DEV-055`.
   */
  readonly uncaughtRejection: boolean | null;
}

export function stabilityCheck(evidence: StabilityEvidence): Check {
  const title = 'The app keeps running, and rejects nothing into the void, with no writable store';
  if (evidence.crashed === null || evidence.uncaughtRejection === null) {
    return {
      id: 'LOW-3',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The log could not be read, so a failure could neither be found nor ruled out.',
    };
  }
  if (evidence.crashed || !evidence.stillRunning) {
    return {
      id: 'LOW-3',
      title,
      status: 'FAIL',
      detail: evidence.crashed
        ? 'The app raised a fatal exception while its store was unwritable.'
        : 'The app’s process was gone by the end of the constrained run.',
    };
  }
  if (evidence.uncaughtRejection) {
    return {
      id: 'LOW-3',
      title,
      status: 'FAIL',
      detail:
        'A promise rejected with nothing to catch it while the store was unwritable. Every ' +
        'store call rejects under this condition, so any one that is started and not awaited ' +
        'becomes an unhandled rejection - a banner across the app in a development build, and ' +
        'the platform’s default handler in a release one. Neither is a decision this app made ' +
        '(`DEV-055`).',
    };
  }
  return {
    id: 'LOW-3',
    title,
    status: 'PASS',
    detail:
      'No fatal exception, no uncaught rejection, and the process was still alive at the end.',
  };
}

/**
 * Whether the log carries an unhandled promise rejection from this app.
 *
 * Matched on React Native's own wording rather than on the SQLite message, because the failure
 * being looked for is "nobody caught this" and the thing that went wrong underneath may be
 * anything the store does.
 */
export function uncaughtRejectionIn(log: string): boolean {
  return /Uncaught \(in promise/i.test(log) || /Possible Unhandled Promise Rejection/i.test(log);
}

// ---------------------------------------------------------------------------
// LOW-4 - and nothing was broken by it
// ---------------------------------------------------------------------------

export interface RecoveryEvidence {
  /** Whether write permission was restored. */
  readonly restored: boolean;
  /** Items the shelf showed after restoring, read off the device. `null` where it could not be read. */
  readonly itemsAfter: number | null;
  /** Items the shelf showed before the constrained run, for comparison. */
  readonly itemsBefore: number | null;
}

/**
 * The store still works afterwards, and still holds what it held.
 *
 * A database that a failed write left corrupt is the version of this failure nobody recovers from:
 * the app would come back to an unreadable store and, by DEC-100's rule, delete it. Somebody's
 * offline journal goes with it.
 *
 * Compared against what the shelf showed **before**, because "the shelf has items" is also true of
 * a shelf freshly refetched from the server over a store that was silently emptied.
 */
export function recoveryCheck(evidence: RecoveryEvidence): Check {
  const title = 'The store still works, and still holds what it held';
  if (!evidence.restored || evidence.itemsAfter === null || evidence.itemsBefore === null) {
    return {
      id: 'LOW-4',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The device could not be read on both sides of the constrained run.',
    };
  }
  if (evidence.itemsBefore === 0) {
    return {
      id: 'LOW-4',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The shelf was empty before the constrained run, so an empty shelf afterwards would be ' +
        'the same shelf rather than a loss.',
    };
  }
  if (evidence.itemsAfter < evidence.itemsBefore) {
    return {
      id: 'LOW-4',
      title,
      status: 'FAIL',
      detail:
        `The shelf showed ${String(evidence.itemsBefore)} item(s) before and ` +
        `${String(evidence.itemsAfter)} after. A failed write left the store in a state the app ` +
        'could not read back.',
    };
  }
  return {
    id: 'LOW-4',
    title,
    status: 'PASS',
    detail:
      `The shelf showed ${String(evidence.itemsAfter)} item(s) after write permission was ` +
      'restored, against ' +
      `${String(evidence.itemsBefore)} before.`,
  };
}
