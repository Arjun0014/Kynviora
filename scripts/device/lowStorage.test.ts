/**
 * The low-storage judgements, run with nothing attached (DEC-102).
 *
 * Every check here except the control is about the app **not** doing something, which is the shape
 * that passes for the wrong reason more reliably than any other: an app that failed at everything
 * satisfies all of them, and so does a run that never reached a screen, and so does one where the
 * constraint was never applied. `LOW-0` and `LOW-1` are the two controls that rule those out, and
 * most of this file is about them.
 */

import { describe, expect, it } from 'vitest';
import {
  claimCheck,
  conditionCheck,
  controlCheck,
  recoveryCheck,
  stabilityCheck,
  uncaughtRejectionIn,
} from './lowStorage.js';

describe('LOW-0, the control', () => {
  it('fails when the queue did not work with storage untouched', () => {
    // Not inconclusive. If a dose cannot be queued on a working device, every "it did not claim to
    // have kept anything" below is true of an app that keeps nothing ever - which is a different
    // and larger defect, and reporting it as four passes would hide it.
    const check = controlCheck({
      driven: true,
      saidQueued: false,
      serverBefore: 3,
      serverAfter: 3,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('refuses everything');
  });

  it('is inconclusive when the dose reached the server after all', () => {
    // The switch was supposed to be unreachable. A dose that reached the server was never queued,
    // so the journal - the thing storage takes away - was never what handled it.
    const check = controlCheck({ driven: true, saidQueued: true, serverBefore: 3, serverAfter: 4 });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('unreachable');
  });

  it('is inconclusive when the screen was never driven', () => {
    const check = controlCheck({
      driven: false,
      saidQueued: false,
      serverBefore: null,
      serverAfter: null,
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('passes when the dose queued and nothing reached the server', () => {
    expect(
      controlCheck({ driven: true, saidQueued: true, serverBefore: 3, serverAfter: 3 }).status,
    ).toBe('PASS');
  });
});

describe('LOW-1, the condition', () => {
  it('is inconclusive when the write still succeeded', () => {
    // `chmod` on Android can succeed and change nothing. Trusting that it applied is how a run
    // reports four clean results about a device that was never constrained.
    const check = conditionCheck({ applied: true, writeRefused: false });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('unconstrained');
  });

  it('is inconclusive when it could not be applied at all', () => {
    expect(conditionCheck({ applied: false, writeRefused: null }).status).toBe('INCONCLUSIVE');
  });

  it('passes when a write was actually refused', () => {
    expect(conditionCheck({ applied: true, writeRefused: true }).status).toBe('PASS');
  });
});

describe('LOW-2, what the screen claimed', () => {
  const attempted = {
    attempted: true,
    saidRecorded: false,
    saidQueued: false,
    saidSomething: true,
  };

  it('fails when it said the dose is kept on this phone', () => {
    // The quiet failure, and the reason this scenario exists. Both halves of that sentence are
    // false, the person stops thinking about it, and there is no later moment at which they learn.
    const check = claimCheck({ ...attempted, saidQueued: true });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('stops thinking');
  });

  it('fails when it said "Recorded."', () => {
    const check = claimCheck({ ...attempted, saidRecorded: true });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('nothing has');
  });

  it('fails when it said nothing at all', () => {
    // A third failure and a quieter one. Neither confirmed nor refused leaves somebody guessing,
    // which `18` does not allow.
    const check = claimCheck({ ...attempted, saidSomething: false });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('left to guess');
  });

  it('is inconclusive when nothing was attempted', () => {
    expect(claimCheck({ ...attempted, attempted: false }).status).toBe('INCONCLUSIVE');
  });

  it('passes when it reported the attempt without claiming a record', () => {
    expect(claimCheck(attempted).status).toBe('PASS');
  });
});

describe('what an uncaught rejection looks like in a log', () => {
  it('recognises React Native’s own wording', () => {
    // Matched on the wording rather than on the SQLite message: what is being looked for is
    // "nobody caught this", and whatever went wrong underneath may be anything the store does.
    expect(
      uncaughtRejectionIn(
        "Uncaught (in promise, id: 0) Error: Call to function 'NativeStatement.finalizeAsync' " +
          'has been rejected. -> Caused by: attempt to write a readonly database',
      ),
    ).toBe(true);
    expect(uncaughtRejectionIn('Possible Unhandled Promise Rejection (id: 3)')).toBe(true);
  });

  it('is not fooled by an error somebody did catch', () => {
    // The distinction is the whole check. An error handled and reported is the app working.
    expect(uncaughtRejectionIn('W kynviora: projection write failed, keeping the older copy')).toBe(
      false,
    );
  });
});

describe('LOW-3, stability', () => {
  const alive = { crashed: false, uncaughtRejection: false, stillRunning: true };

  it('fails on a fatal exception', () => {
    expect(stabilityCheck({ ...alive, crashed: true }).status).toBe('FAIL');
  });

  it('fails when the process is gone', () => {
    expect(stabilityCheck({ ...alive, stillRunning: false }).status).toBe('FAIL');
  });

  it('fails on a promise that rejected with nobody to catch it', () => {
    // `DEV-055`. Every store call rejects under this condition, so any one that is started and
    // not awaited becomes an unhandled rejection - a banner across the app in a development build,
    // the platform's default handler in a release one, and a decision the app did not make either
    // way. This is the assertion that found it.
    const check = stabilityCheck({ ...alive, uncaughtRejection: true });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('DEV-055');
  });

  it('is inconclusive when the log could not be read', () => {
    // Not a pass. "No failure was found" and "nowhere was looked" are different statements.
    expect(stabilityCheck({ ...alive, crashed: null }).status).toBe('INCONCLUSIVE');
    expect(stabilityCheck({ ...alive, uncaughtRejection: null }).status).toBe('INCONCLUSIVE');
  });

  it('passes when it neither crashed, died, nor rejected into the void', () => {
    expect(stabilityCheck(alive).status).toBe('PASS');
  });
});

describe('LOW-4, recovery', () => {
  it('fails when the shelf lost items', () => {
    // A store a failed write left unreadable is deleted by the app on its next launch (DEC-100),
    // and somebody's offline journal goes with it.
    const check = recoveryCheck({ restored: true, itemsBefore: 7, itemsAfter: 0 });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('could not read back');
  });

  it('is inconclusive when the shelf was empty to begin with', () => {
    // An empty shelf afterwards would be the same shelf rather than a loss, so there is nothing to
    // compare and saying so is the honest answer.
    expect(recoveryCheck({ restored: true, itemsBefore: 0, itemsAfter: 0 }).status).toBe(
      'INCONCLUSIVE',
    );
  });

  it('passes when the shelf still holds what it held', () => {
    expect(recoveryCheck({ restored: true, itemsBefore: 7, itemsAfter: 7 }).status).toBe('PASS');
  });
});
