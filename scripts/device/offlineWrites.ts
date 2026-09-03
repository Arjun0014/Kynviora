/**
 * What the offline-write scenario's evidence means.
 *
 * Spec references: `12` (a pending-operation journal, idempotency keys, a resolvable failure
 * state), `13` (the operation ID *is* the idempotency key; the server commits exactly once),
 * `19` ("Offline create/edit/sync"), `03` group J, `DEV-038`, DEC-111, `DEV-044`.
 *
 * Kept apart from the runner so the judgements run in `npm run verify` with nothing attached
 * (DEC-102), which is the same split the storage, accessibility, reminder and update harnesses
 * use and for the same reason: a rule that only executes when an emulator happens to be plugged
 * in is a rule nothing checks.
 *
 * WHAT THE SCENARIO IS ACTUALLY FOR
 * Two questions, and only the second one needs hardware to be interesting.
 *
 *   1. Does an edit made with no signal survive the app's process dying and arrive afterwards?
 *   2. Does it arrive **once**?
 *
 * The second is the one DEC-111 exists for and the one a naive test cannot reach. `OFFLINE` says
 * the request never got to a server - but the client infers that from a failed fetch, which is
 * also exactly what a request that *arrived* and lost its answer looks like. So the harness
 * produces that case deliberately: the request is forwarded, the server commits, and the answer
 * is thrown away before the phone sees it. A replay under a fresh key would then make a second
 * schedule, and on this table a second schedule is not a duplicate row on a list - it is being
 * told twice, at the same minute, to take the same tablet.
 */

import type { Check } from './analysis.js';

/** One request the switch between the phone and the API saw go past. */
export interface ObservedRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** The `idempotent-replay` header the server answered with, where it did. */
  readonly replay: string | null;
  /** The `idempotency-key` header the phone sent, where it sent one. */
  readonly key: string | null;
  /**
   * The top-level `id` of a JSON answer, where there was one.
   *
   * **An identifier and nothing else.** The switch never records a response body: these answers
   * carry medicine names, and a harness that wrote them to disk would be making the copy the
   * scenarios exist to bound. What an id buys is the ability to read a created resource back -
   * a Visit Pack, which the app deliberately never names on screen (`19`, `16`).
   */
  readonly createdId: string | null;
}

/** Requests that created a schedule on the medicine under test. */
export function scheduleCreates(requests: readonly ObservedRequest[]): readonly ObservedRequest[] {
  return requests.filter(
    (request) => request.method === 'POST' && /\/v1\/items\/[^/]+\/schedules$/.test(request.path),
  );
}

// ---------------------------------------------------------------------------
// OFF-0 - the control
// ---------------------------------------------------------------------------

export interface PreconditionEvidence {
  /** Whether the form was reached and carried the time the run intends to save. */
  readonly formHeldTheTime: boolean;
  /** What the form actually held, for the report. */
  readonly timeInTheField: string | null;
  /** Active schedules on the medicine before anything was saved. */
  readonly activeBefore: number;
}

/**
 * The check that makes every later one mean something.
 *
 * Two ways this scenario passes while testing nothing, and both have happened here. A save that
 * never reached the form leaves the server unchanged, which is indistinguishable from a save that
 * was correctly queued. And a medicine that already had an active schedule at this time makes
 * "the server converged" true before the run started.
 */
export function preconditionCheck(evidence: PreconditionEvidence): Check {
  if (!evidence.formHeldTheTime) {
    return {
      id: 'OFF-0',
      title: 'The app was ready to save a schedule nobody had saved yet',
      status: 'INCONCLUSIVE',
      detail:
        `The schedule form did not hold the time this run intends to save (field held ` +
        `${evidence.timeInTheField === null ? 'nothing readable' : JSON.stringify(evidence.timeInTheField)}). ` +
        'Every later check would then pass over a save that never happened.',
    };
  }
  if (evidence.activeBefore !== 0) {
    return {
      id: 'OFF-0',
      title: 'The app was ready to save a schedule nobody had saved yet',
      status: 'INCONCLUSIVE',
      detail:
        `The medicine already had ${String(evidence.activeBefore)} active schedule(s), so "the ` +
        'server has one afterwards" would be true before the run began.',
    };
  }
  return {
    id: 'OFF-0',
    title: 'The app was ready to save a schedule nobody had saved yet',
    status: 'PASS',
    detail:
      `The form held ${JSON.stringify(evidence.timeInTheField)} and the medicine had no active ` +
      'schedule, so anything that appears on the server afterwards came from this save.',
  };
}

// ---------------------------------------------------------------------------
// OFF-1 - queued rather than refused
// ---------------------------------------------------------------------------

export interface QueuedEvidence {
  /** Requests the switch saw while the API was unreachable. Must be none. */
  readonly requestsWhileOffline: readonly ObservedRequest[];
  /** Whether the screen reported a failure to the person. */
  readonly screenShowedError: boolean;
  /** Active schedules on the server after the save. */
  readonly activeAfterSave: number;
}

/**
 * With no signal, a save is kept rather than lost - and rather than pretended.
 *
 * The absence of a request is the half that is easy to get wrong: removing `adb reverse` leaves
 * OkHttp's already-pooled connections working, so a write meant to be queued can reach the server
 * anyway. Measured here rather than assumed, which is why the runner puts a switch it controls in
 * the path instead of unplugging a tunnel and hoping.
 */
export function queuedRatherThanFailedCheck(evidence: QueuedEvidence): Check {
  const reached = evidence.requestsWhileOffline.length;
  if (reached > 0) {
    return {
      id: 'OFF-1',
      title: 'An edit made with no signal is queued, not lost',
      status: 'INCONCLUSIVE',
      detail:
        `${String(reached)} request(s) reached the API while it was supposed to be unreachable ` +
        `(${evidence.requestsWhileOffline.map((request) => `${request.method} ${request.path}`).join(', ')}), ` +
        'so the app was never offline and nothing was queued.',
    };
  }
  if (evidence.screenShowedError) {
    return {
      id: 'OFF-1',
      title: 'An edit made with no signal is queued, not lost',
      status: 'FAIL',
      detail:
        'The screen reported the save as failed. `12` allows a low-risk user-owned change to be ' +
        'kept and sent later, and telling somebody their medicine time was not saved when it is ' +
        'in the journal is the wrong half of that to show.',
    };
  }
  if (evidence.activeAfterSave !== 0) {
    return {
      id: 'OFF-1',
      title: 'An edit made with no signal is queued, not lost',
      status: 'FAIL',
      detail: 'The server gained a schedule while it was unreachable, which cannot have happened.',
    };
  }
  return {
    id: 'OFF-1',
    title: 'An edit made with no signal is queued, not lost',
    status: 'PASS',
    detail:
      'No request left the phone, the server was unchanged, and the screen showed the save as ' +
      'done rather than as failed - so it is in the journal.',
  };
}

// ---------------------------------------------------------------------------
// OFF-2 - the process really died
// ---------------------------------------------------------------------------

export interface ProcessDeathEvidence {
  readonly pidBefore: string | null;
  readonly pidAfter: string | null;
  /** Whether the app was put in the background before the kill was asked for. */
  readonly backgroundedFirst: boolean;
}

/**
 * The kill has to have happened, or the drain proves nothing about surviving one.
 *
 * `am kill` will not touch a process that is in the foreground - Android only kills what is
 * already killable - so the first attempt at this scenario reported a successful "survives process
 * death" while the pid never changed. The app is backgrounded first and the pid's absence is
 * asserted, and it is still `am kill` rather than `force-stop`, which additionally cancels every
 * alarm the app registered (`DEV-041`).
 */
export function processDiedCheck(evidence: ProcessDeathEvidence): Check {
  if (evidence.pidBefore === null) {
    return {
      id: 'OFF-2',
      title: 'The app’s process was killed, not merely asked to stop',
      status: 'INCONCLUSIVE',
      detail: 'There was no process to kill before the kill was asked for.',
    };
  }
  if (!evidence.backgroundedFirst) {
    return {
      id: 'OFF-2',
      title: 'The app’s process was killed, not merely asked to stop',
      status: 'INCONCLUSIVE',
      detail:
        'The app was not backgrounded first, and `am kill` does not kill a foreground process - ' +
        'so a surviving pid would say nothing either way.',
    };
  }
  if (evidence.pidAfter !== null) {
    return {
      id: 'OFF-2',
      title: 'The app’s process was killed, not merely asked to stop',
      status: 'INCONCLUSIVE',
      detail:
        `The process was still running afterwards (pid ${evidence.pidAfter}), so what follows ` +
        'would measure a journal that never had to survive anything.',
    };
  }
  return {
    id: 'OFF-2',
    title: 'The app’s process was killed, not merely asked to stop',
    status: 'PASS',
    detail:
      `pid ${evidence.pidBefore} was gone after \`am kill\`, so the journal that follows was read ` +
      'off disk by a new process.',
  };
}

// ---------------------------------------------------------------------------
// OFF-3 - it drains on the first launch after that
// ---------------------------------------------------------------------------

export interface DrainEvidence {
  readonly requestsOnFirstLaunch: readonly ObservedRequest[];
  /** The times the server has active on the medicine after that launch. */
  readonly activeTimesAfter: readonly string[];
  readonly expectedTime: string;
}

/**
 * The **first** launch, and that word is the whole check.
 *
 * The queue used to drain on the second foreground, never the first, and the reason was invisible
 * from the code: a sender belonged to the screen that knew the shape of the write, the store opens
 * before any tab beyond the first has mounted, and the single pass a cold launch runs therefore
 * found an empty registry. Every launch after a kill - the exact launch the journal exists for -
 * skipped the send and, worse, spent an attempt on it. A check that allowed "it arrived eventually"
 * would have called that behaviour correct (`DEV-044`).
 */
export function drainedOnFirstLaunchCheck(evidence: DrainEvidence): Check {
  const creates = scheduleCreates(evidence.requestsOnFirstLaunch);
  const converged = evidence.activeTimesAfter.includes(evidence.expectedTime);

  if (creates.length === 0) {
    return {
      id: 'OFF-3',
      title: 'The queued edit is sent on the first launch after the kill',
      status: 'FAIL',
      detail:
        'No schedule was created on the launch that followed the kill. The edit is still in the ' +
        'journal, and nothing on any screen says so.',
    };
  }
  if (!converged) {
    return {
      id: 'OFF-3',
      title: 'The queued edit is sent on the first launch after the kill',
      status: 'FAIL',
      detail:
        `The create was sent but the server does not have ${evidence.expectedTime} active ` +
        `(it has ${evidence.activeTimesAfter.join(', ') || 'nothing'}).`,
    };
  }
  return {
    id: 'OFF-3',
    title: 'The queued edit is sent on the first launch after the kill',
    status: 'PASS',
    detail:
      `${String(creates.length)} create(s) went out on that launch and the server now has ` +
      `${evidence.expectedTime} active. Nobody had to open a particular tab for it to happen.`,
  };
}

// ---------------------------------------------------------------------------
// OFF-4 - the same key, and exactly one row
// ---------------------------------------------------------------------------

export interface ReplayEvidence {
  /** Every create the switch saw across the whole replay scenario. */
  readonly creates: readonly ObservedRequest[];
  /**
   * **Active** schedules on the server at the time this scenario saved.
   *
   * Active, not every row, and the distinction is the difference between measuring the app and
   * measuring the history of the machine it runs on. `0004` grants the app role no DELETE on
   * `medicine_schedule`, so a schedule is ended by being deactivated and every run this harness has
   * ever done is still in the table. Counting rows made a previous run's leftovers read as this
   * run's duplicate.
   *
   * Counting the live ones is also the honest form of the claim. A duplicate created by a replay
   * under a fresh key would be **active** - a schedule is created active - so the failure this
   * check exists to catch is caught, while a row that reminds nobody of anything is not counted as
   * an instruction to take a medicine.
   */
  readonly activeRowsWithTime: number;
  readonly expectedTime: string;
}

/**
 * A create whose answer was lost is committed once, because the replay carries the key it used.
 *
 * This is the check with teeth, and the run is built to make it possible: the request is forwarded
 * to the server, the server commits, and the answer is destroyed before the phone reads it. The
 * phone cannot tell that from being offline - which is the whole point - so it queues. What
 * distinguishes a correct client from a broken one is what the replay carries.
 *
 * Two independent readings, and both are required, because either alone can be right by accident.
 * The key on the wire says the client kept it; the row count says the server acted on that. A
 * client that sent a fresh key against a server with no idempotency would show one key each and
 * two rows; one that sent a fresh key against this server would show two rows too.
 */
export function committedOnceCheck(evidence: ReplayEvidence): Check {
  const keys = new Set(evidence.creates.map((create) => create.key).filter((key) => key !== null));
  const replayed = evidence.creates.filter((create) => create.replay === 'true');

  if (evidence.creates.length < 2) {
    return {
      id: 'OFF-4',
      title: 'A create whose answer was lost is committed once, under the key it first used',
      status: 'INCONCLUSIVE',
      detail:
        `Only ${String(evidence.creates.length)} create(s) were seen, so there was no replay to ` +
        'judge. The answer was probably not swallowed.',
    };
  }
  if (keys.size !== 1) {
    return {
      id: 'OFF-4',
      title: 'A create whose answer was lost is committed once, under the key it first used',
      status: 'FAIL',
      detail:
        `The replay used a different idempotency key (${String(keys.size)} distinct keys across ` +
        `${String(evidence.creates.length)} creates). A fresh key on a replay is not an ` +
        'idempotency key, and on this table it is two reminders at the same minute (DEC-111).',
    };
  }
  if (evidence.activeRowsWithTime !== 1) {
    return {
      id: 'OFF-4',
      title: 'A create whose answer was lost is committed once, under the key it first used',
      status: 'FAIL',
      detail:
        `The server holds ${String(evidence.activeRowsWithTime)} active schedules at ` +
        `${evidence.expectedTime}. ` +
        'One save has become more than one instruction to take a medicine.',
    };
  }
  if (replayed.length === 0) {
    return {
      id: 'OFF-4',
      title: 'A create whose answer was lost is committed once, under the key it first used',
      status: 'INCONCLUSIVE',
      detail:
        'One row and one key, but the server never answered `idempotent-replay`, so the second ' +
        'request may not have reached it at all.',
    };
  }
  return {
    id: 'OFF-4',
    title: 'A create whose answer was lost is committed once, under the key it first used',
    status: 'PASS',
    detail:
      `${String(evidence.creates.length)} creates went out under one key, the server answered ` +
      `\`idempotent-replay\` to ${String(replayed.length)} of them, and exactly one live ` +
      `schedule exists at ${evidence.expectedTime}.`,
  };
}

// ---------------------------------------------------------------------------
// OFF-5 - nothing is left waiting
// ---------------------------------------------------------------------------

export interface SettledEvidence {
  /** Requests seen on a further background/foreground cycle, after the queue should be empty. */
  readonly requestsAfterSettling: readonly ObservedRequest[];
}

/**
 * A committed operation is removed from the journal rather than sent forever.
 *
 * Read from the outside because there is nothing to read from the inside: the store is
 * SQLCipher-encrypted, so `sqlite3` cannot open it, and no screen shows the queue (`DEV-038`).
 * What can be observed is that a later foreground sends nothing - which is what an empty journal
 * looks like, and is not what a journal whose rows are never deleted looks like.
 */
export function nothingLeftWaitingCheck(evidence: SettledEvidence): Check {
  const creates = scheduleCreates(evidence.requestsAfterSettling);
  if (creates.length > 0) {
    return {
      id: 'OFF-5',
      title: 'Nothing is left in the journal once the server has it',
      status: 'FAIL',
      detail:
        `A later foreground sent ${String(creates.length)} more create(s), so the committed ` +
        'operation was not removed and the phone will keep replaying it.',
    };
  }
  return {
    id: 'OFF-5',
    title: 'Nothing is left in the journal once the server has it',
    status: 'PASS',
    detail: 'A further background and foreground sent no schedule writes: the queue is empty.',
  };
}
