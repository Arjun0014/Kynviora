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
import { DOSE_COPY } from '@kynviora/presentation';
import { UTTERANCES } from '@kynviora/agent';
import {
  committedOnceCheck,
  doseCommittedOnceCheck,
  doseCreates,
  doseQueuedOnScreenCheck,
  drainedOnFirstLaunchCheck,
  nothingLeftWaitingCheck,
  preconditionCheck,
  processDiedCheck,
  queuedRatherThanFailedCheck,
  scheduleCreates,
  voiceDrainedOnceCheck,
  voiceQueuedOnScreenCheck,
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
    createdId: null,
    ...overrides,
  };
}

const read: ObservedRequest = {
  method: 'GET',
  path: `/v1/items/${ITEM}/schedules`,
  status: 200,
  replay: null,
  key: null,
  createdId: null,
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
      saveAttempted: true,
      screenShowedError: false,
      activeAfterSave: 1,
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('never offline');
  });

  it('fails when the screen told the person the save did not happen', () => {
    const check = queuedRatherThanFailedCheck({
      requestsWhileOffline: [],
      saveAttempted: true,
      screenShowedError: true,
      activeAfterSave: 0,
    });
    expect(check.status).toBe('FAIL');
  });

  it('fails when the server gained a schedule it could not have received', () => {
    const check = queuedRatherThanFailedCheck({
      requestsWhileOffline: [],
      saveAttempted: true,
      screenShowedError: false,
      activeAfterSave: 1,
    });
    expect(check.status).toBe('FAIL');
  });

  it('is inconclusive when the save was never driven', () => {
    // The run whose first launch failed reported the screen as having told somebody their medicine
    // time was lost. Nothing had been pressed at all.
    const check = queuedRatherThanFailedCheck({
      requestsWhileOffline: [],
      saveAttempted: false,
      screenShowedError: false,
      activeAfterSave: 0,
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('never driven');
  });

  it('passes when nothing left the phone and the screen showed it as saved', () => {
    expect(
      queuedRatherThanFailedCheck({
        requestsWhileOffline: [],
        saveAttempted: true,
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

describe('recognising a dose create', () => {
  it('picks out the dose route and nothing else', () => {
    const dose: ObservedRequest = { ...create(), path: '/v1/dose-events' };
    expect(doseCreates([dose, create(), read])).toEqual([dose]);
  });

  it('does not mistake the read for a write', () => {
    const list: ObservedRequest = { ...read, path: '/v1/dose-events' };
    expect(doseCreates([list])).toEqual([]);
  });
});

describe('OFF-6, what the person is told about a queued dose', () => {
  const sentences = {
    offlineSentence: DOSE_COPY.offlineNote,
    recordedSentence: DOSE_COPY.recordedDone,
  };

  it('passes when the screen says the dose is on this phone', () => {
    const check = doseQueuedOnScreenCheck({
      screenText: ['What happened?', DOSE_COPY.offlineNote],
      ...sentences,
    });
    expect(check.status).toBe('PASS');
  });

  it('fails a screen claiming the dose was saved when the request failed', () => {
    // The worse of the two failures: "Recorded." is the sentence that stops somebody recording
    // it again, so a false one loses the dose and hides that it was lost.
    const check = doseQueuedOnScreenCheck({
      screenText: ['What happened?', DOSE_COPY.recordedDone],
      ...sentences,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('recording it again');
  });

  it('fails a screen that says nothing at all', () => {
    const check = doseQueuedOnScreenCheck({ screenText: ['What happened?'], ...sentences });
    expect(check.status).toBe('FAIL');
  });

  it('is inconclusive rather than passing when the screen could not be read', () => {
    expect(doseQueuedOnScreenCheck({ screenText: null, ...sentences }).status).toBe('INCONCLUSIVE');
  });
});

describe('OFF-7, a dose whose answer was lost', () => {
  const KEY = 'bbbbbbbb-0000-4000-8000-000000000001';
  const dose = (overrides: Partial<ObservedRequest> = {}): ObservedRequest => ({
    ...create({ key: KEY }),
    path: '/v1/dose-events',
    ...overrides,
  });

  it('passes on two creates under one key, a replay answer, and one row', () => {
    const check = doseCommittedOnceCheck({
      creates: [dose(), dose({ status: 200, replay: 'true' })],
      rowsWithNote: 1,
      note: 'offline dose QQ1',
    });
    expect(check.status).toBe('PASS');
  });

  it('fails when only one create was seen, however tidy the server looks', () => {
    // The reason this run swallows an answer instead of going offline. With no journal at all the
    // swallowed request still commits, so "exactly one row" is passed by an app that kept nothing.
    const check = doseCommittedOnceCheck({
      creates: [dose()],
      rowsWithNote: 1,
      note: 'offline dose QQ1',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('kept nothing');
  });

  it('fails a replay sent under a fresh key', () => {
    const check = doseCommittedOnceCheck({
      creates: [dose(), dose({ key: 'cccccccc-0000-4000-8000-000000000002', status: 201 })],
      rowsWithNote: 2,
      note: 'offline dose QQ1',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('not an idempotency key');
  });

  it('fails when the history gained a second dose', () => {
    const check = doseCommittedOnceCheck({
      creates: [dose(), dose({ status: 201 })],
      rowsWithNote: 2,
      note: 'offline dose QQ1',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('another number');
  });

  it('is inconclusive when the server never said it was a replay', () => {
    const check = doseCommittedOnceCheck({
      creates: [dose(), dose()],
      rowsWithNote: 1,
      note: 'offline dose QQ1',
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });
});

describe('OFF-8, what a person hears when a reminder is kept rather than set', () => {
  const sentences = {
    queuedSentence: UTTERANCES.queued,
    doneSentence: UTTERANCES.done,
    offlineSentence: UTTERANCES.offline,
  };

  /** A screen line as `VoiceScreen` announces one of Kynviora's turns. */
  const said = (text: string): string => `Kynviora said. ${text}`;

  /**
   * The screen's own idle hint, verbatim.
   *
   * It ends "or press Done." and it is on screen after every exchange, so a check that searched
   * everything for `Done.` found it whatever happened. That is what this file's first version did
   * and it turned a passing run red (trap 209).
   */
  const IDLE_HINT = 'Ask Kynviora something, or press Done.';

  it('passes when the transcript says it is kept here and will be sent', () => {
    const check = voiceQueuedOnScreenCheck({
      transcript: [said(UTTERANCES.queued)],
      ...sentences,
      requestsWhileOffline: [],
      activeAfterSave: 0,
    });
    expect(check.status).toBe('PASS');
  });

  it('fails on "Done.", which is the sentence a person acts on', () => {
    // The failure `DEV-085` and `DEV-090` are two halves of. Checked before everything else,
    // because it is the one that stops somebody thinking about a reminder that does not exist.
    const check = voiceQueuedOnScreenCheck({
      transcript: [said(UTTERANCES.done)],
      ...sentences,
      requestsWhileOffline: [],
      activeAfterSave: 0,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('nothing at all');
  });

  it('fails when it says only that there is no connection', () => {
    // The mirror failure. The phone did keep it, and a person told otherwise sets it again - so
    // the journal sends both and they are reminded twice.
    const check = voiceQueuedOnScreenCheck({
      transcript: [said(UTTERANCES.offline)],
      ...sentences,
      requestsWhileOffline: [],
      activeAfterSave: 0,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('set it again');
  });

  it('fails when the transcript says nothing about it at all', () => {
    const check = voiceQueuedOnScreenCheck({
      transcript: [said('Something else entirely.')],
      ...sentences,
      requestsWhileOffline: [],
      activeAfterSave: 0,
    });
    expect(check.status).toBe('FAIL');
  });

  it('is inconclusive when a request reached the server it was supposed not to', () => {
    // Not a failure: the app was never offline, so nothing here measured what it claims to
    // (DEC-102). Reporting it as a defect would send somebody looking at the app.
    const check = voiceQueuedOnScreenCheck({
      transcript: [said(UTTERANCES.queued)],
      ...sentences,
      requestsWhileOffline: [create()],
      activeAfterSave: 0,
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('never offline');
  });

  it('fails when the server gained a schedule while it was unreachable', () => {
    const check = voiceQueuedOnScreenCheck({
      transcript: [said(UTTERANCES.queued)],
      ...sentences,
      requestsWhileOffline: [],
      activeAfterSave: 1,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('cannot have happened');
  });

  it('is inconclusive when the transcript could not be read', () => {
    expect(
      voiceQueuedOnScreenCheck({
        transcript: null,
        ...sentences,
        requestsWhileOffline: [],
        activeAfterSave: 0,
      }).status,
    ).toBe('INCONCLUSIVE');
  });

  /**
   * The screen's own words are not Kynviora's, and this check cost a device run to learn it.
   *
   * `OFF-8` failed on a run where `OFF-9` had just proved the same reminder queued and arrived,
   * because the idle hint on the screen ends "or press Done." and the check searched everything on
   * screen. Trap 193 in a second place: compare the whole announcement, which only a transcript
   * line carries.
   */
  it('does not read the screen’s own hint as something Kynviora said', () => {
    const check = voiceQueuedOnScreenCheck({
      transcript: [IDLE_HINT, 'Ready', said(UTTERANCES.queued), 'Done'],
      ...sentences,
      requestsWhileOffline: [],
      activeAfterSave: 0,
    });
    expect(check.status).toBe('PASS');
  });

  it('still catches "Done." when Kynviora is the one who said it', () => {
    // The other direction, so narrowing to the transcript has not made the check unable to fail.
    const check = voiceQueuedOnScreenCheck({
      transcript: [IDLE_HINT, said(UTTERANCES.done)],
      ...sentences,
      requestsWhileOffline: [],
      activeAfterSave: 0,
    });
    expect(check.status).toBe('FAIL');
  });

  it('is inconclusive when the screen carried nothing Kynviora had said', () => {
    // A screen full of controls and no transcript is a run that did not happen, not a passing one.
    const check = voiceQueuedOnScreenCheck({
      transcript: [IDLE_HINT, 'Ready', 'Ask Kynviora'],
      ...sentences,
      requestsWhileOffline: [],
      activeAfterSave: 0,
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });
});

describe('OFF-9, the reminder set by voice arriving once', () => {
  it('passes on one create under one key leaving one active time', () => {
    const check = voiceDrainedOnceCheck({
      requestsOnFirstLaunch: [create()],
      activeTimesAfter: ['08:00'],
      expectedTime: '08:00',
    });
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('same pass');
  });

  it('fails when nothing was sent on the launch that followed the kill', () => {
    // The change is in the journal and the person has already been told it was kept, which is the
    // asymmetry that makes this worse than a plain failure to save.
    const check = voiceDrainedOnceCheck({
      requestsOnFirstLaunch: [read],
      activeTimesAfter: [],
      expectedTime: '08:00',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('told it was kept');
  });

  it('fails a replay sent under a fresh key', () => {
    const check = voiceDrainedOnceCheck({
      requestsOnFirstLaunch: [create(), create({ key: 'cccccccc-0000-4000-8000-000000000002' })],
      activeTimesAfter: ['08:00', '08:00'],
      expectedTime: '08:00',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('not an idempotency key');
  });

  it('fails when the create went out and the server does not have the time', () => {
    const check = voiceDrainedOnceCheck({
      requestsOnFirstLaunch: [create()],
      activeTimesAfter: ['20:00'],
      expectedTime: '08:00',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('does not have 08:00 active');
  });

  it('fails on two active schedules at the same minute', () => {
    // One request, two reminders. The shape a duplicate produces on this table, and the reason
    // the count is here rather than a presence test.
    const check = voiceDrainedOnceCheck({
      requestsOnFirstLaunch: [create()],
      activeTimesAfter: ['08:00', '08:00'],
      expectedTime: '08:00',
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('One request, two reminders');
  });
});
