/**
 * The offline-write judgements, run with nothing attached.
 *
 * These are the rules the device harness applies to what it saw. They run in `npm run verify`
 * (DEC-102) so that a rule cannot change without CI noticing, including on a machine with no
 * Android SDK - which is the state every machine but this one has been in.
 *
 * Each test names the wrong answer it exists to prevent, because most of them were produced by
 * this scenario before they were prevented.
 */

import { describe, expect, it } from 'vitest';
import {
  committedOnceCheck,
  drainedOnFirstLaunchCheck,
  nothingLeftWaitingCheck,
  preconditionCheck,
  processDiedCheck,
  queuedRatherThanFailedCheck,
  scheduleCreates,
  type ObservedRequest,
} from './offlineWrites.js';

const ITEM = '00000000-0000-4000-8000-00000000d030';

function create(overrides: Partial<ObservedRequest> = {}): ObservedRequest {
  return {
    method: 'POST',
    path: `/v1/items/${ITEM}/schedules`,
    status: 201,
    replay: null,
    key: 'aaaaaaaa-0000-4000-8000-000000000001',
    ...overrides,
  };
}

const read: ObservedRequest = {
  method: 'GET',
  path: `/v1/items/${ITEM}/schedules`,
  status: 200,
  replay: null,
  key: null,
};

describe('scheduleCreates', () => {
  it('counts only the creates, not the reads the same path serves', () => {
    expect(scheduleCreates([read, create(), read])).toHaveLength(1);
  });

  it('does not count a write to some other collection', () => {
    expect(
      scheduleCreates([
        { ...create(), path: '/v1/items' },
        { ...create(), path: '/v1/dose-events' },
      ]),
    ).toEqual([]);
  });
});

describe('OFF-0, the control', () => {
  it('is inconclusive when the form never held the time', () => {
    // The failure that produced this check: a mis-aimed tap left the field empty, the save never
    // happened, and "the server is unchanged" read as a correctly queued edit.
    const check = preconditionCheck({
      formHeldTheTime: false,
      timeInTheField: '08:00',
      activeBefore: 0,
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('never happened');
  });

  it('is inconclusive when the medicine already had an active schedule', () => {
    const check = preconditionCheck({
      formHeldTheTime: true,
      timeInTheField: '05:25',
      activeBefore: 1,
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('passes when there is a save to make and nothing already there', () => {
    expect(
      preconditionCheck({ formHeldTheTime: true, timeInTheField: '05:25', activeBefore: 0 }).status,
    ).toBe('PASS');
  });
});

describe('OFF-1, queued rather than lost', () => {
  it('is inconclusive when a request got through anyway', () => {
    // Removing `adb reverse` leaves OkHttp's pooled connections working, and a write meant to be
    // queued reached the server. The run was not offline, so it measured nothing.
    const check = queuedRatherThanFailedCheck({
      requestsWhileOffline: [create()],
      screenShowedError: false,
      activeAfterSave: 1,
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('never offline');
  });

  it('fails when the screen told the person the save did not happen', () => {
    const check = queuedRatherThanFailedCheck({
      requestsWhileOffline: [],
      screenShowedError: true,
      activeAfterSave: 0,
    });
    expect(check.status).toBe('FAIL');
  });

  it('fails when the server gained a schedule it could not have received', () => {
    const check = queuedRatherThanFailedCheck({
      requestsWhileOffline: [],
      screenShowedError: false,
      activeAfterSave: 1,
    });
    expect(check.status).toBe('FAIL');
  });

  it('passes when nothing left the phone and the screen showed it as saved', () => {
    expect(
      queuedRatherThanFailedCheck({
        requestsWhileOffline: [],
        screenShowedError: false,
        activeAfterSave: 0,
      }).status,
    ).toBe('PASS');
  });
});

describe('OFF-2, the kill', () => {
  it('is inconclusive when the pid did not change', () => {
    // `am kill` does not touch a foreground process. The first run of this scenario reported a
    // journal surviving process death while the process had never died.
    const check = processDiedCheck({
      pidBefore: '4537',
      pidAfter: '4537',
      backgroundedFirst: true,
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('still running');
  });

  it('is inconclusive when the app was never backgrounded first', () => {
    const check = processDiedCheck({ pidBefore: '4537', pidAfter: null, backgroundedFirst: false });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('is inconclusive when there was no process to kill', () => {
    expect(
      processDiedCheck({ pidBefore: null, pidAfter: null, backgroundedFirst: true }).status,
    ).toBe('INCONCLUSIVE');
  });

  it('passes when a real pid is gone afterwards', () => {
    expect(
      processDiedCheck({ pidBefore: '6194', pidAfter: null, backgroundedFirst: true }).status,
    ).toBe('PASS');
  });
});

describe('OFF-3, the first launch', () => {
  it('fails when nothing was sent on that launch', () => {
    // The measured defect: the queue drained on the second foreground because the sender belonged
    // to a tab that had not mounted. "It arrived eventually" would have called that correct.
    const check = drainedOnFirstLaunchCheck({
      requestsOnFirstLaunch: [read],
      activeTimesAfter: [],
      expectedTime: '05:25',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('still in the journal');
  });

  it('fails when the create was sent but the server did not converge', () => {
    const check = drainedOnFirstLaunchCheck({
      requestsOnFirstLaunch: [create({ status: 500 })],
      activeTimesAfter: [],
      expectedTime: '05:25',
    });
    expect(check.status).toBe('FAIL');
  });

  it('passes when the create went out and the server has the time', () => {
    expect(
      drainedOnFirstLaunchCheck({
        requestsOnFirstLaunch: [read, create(), read],
        activeTimesAfter: ['05:25'],
        expectedTime: '05:25',
      }).status,
    ).toBe('PASS');
  });
});

describe('OFF-4, committed once', () => {
  const key = 'e100ecb7-0000-4000-8000-000000000001';

  it('is inconclusive when there was no replay to judge', () => {
    const check = committedOnceCheck({
      creates: [create({ key })],
      activeRowsWithTime: 1,
      expectedTime: '04:10',
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('fails when the replay carried a fresh key', () => {
    // The whole reason DEC-111 exists. `OFFLINE` is inferred from a failed fetch, which is also
    // what a request that arrived and lost its answer looks like.
    const check = committedOnceCheck({
      creates: [create({ key }), create({ key: 'bbbbbbbb-0000-4000-8000-000000000002' })],
      activeRowsWithTime: 2,
      expectedTime: '04:10',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('not an idempotency key');
  });

  it('fails on two live rows even when the key was kept', () => {
    // One key and two rows would mean the server ignored it, which is the other half of the claim.
    const check = committedOnceCheck({
      creates: [create({ key }), create({ key, status: 201 })],
      activeRowsWithTime: 2,
      expectedTime: '04:10',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('more than one instruction');
  });

  it('is inconclusive when one live row and one key came with no replay answer', () => {
    const check = committedOnceCheck({
      creates: [create({ key }), create({ key, status: 201 })],
      activeRowsWithTime: 1,
      expectedTime: '04:10',
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('passes on one key, an idempotent replay and exactly one row', () => {
    const check = committedOnceCheck({
      creates: [create({ key }), create({ key, status: 200, replay: 'true' })],
      activeRowsWithTime: 1,
      expectedTime: '04:10',
    });
    expect(check.status).toBe('PASS');
  });
});

describe('OFF-5, nothing left waiting', () => {
  it('fails when a later foreground sends the create again', () => {
    const check = nothingLeftWaitingCheck({ requestsAfterSettling: [create()] });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('keep replaying');
  });

  it('passes when a later foreground sends no schedule write', () => {
    expect(nothingLeftWaitingCheck({ requestsAfterSettling: [read] }).status).toBe('PASS');
  });
});
