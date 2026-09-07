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
  /**
   * Whether the save was actually driven.
   *
   * Separate from what the screen then said, because conflating the two is how this check reported
   * "the screen told the person their change was lost" about a run in which nothing was ever
   * pressed - a finding about the harness dressed as a finding about the app.
   */
  readonly saveAttempted: boolean;
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
  if (!evidence.saveAttempted) {
    return {
      id: 'OFF-1',
      title: 'An edit made with no signal is queued, not lost',
      status: 'INCONCLUSIVE',
      detail: 'The save was never driven, so nothing here was measured (see OFF-0).',
    };
  }
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

// ---------------------------------------------------------------------------
// OFF-6 and OFF-7 - a dose recorded with no signal
// ---------------------------------------------------------------------------

/**
 * Why the queue was extended to a second entity type, and why to this one.
 *
 * `13` resolves `dose_event` `MERGE_BY_ID` and the table's own comment says why: "offline-created
 * events with stable IDs. Merging by ID is what makes an offline retry safe." `04` Phase 4.3 goes
 * further and makes it an exit criterion - an event created offline may be uploaded more than once,
 * and a duplicate sync must not create a duplicate event. The route holds up its end already,
 * answering a repeated operation ID with the row it wrote the first time.
 *
 * So this was the one mutation the policy allows, the app has a feature for, and nothing had wired
 * (`DEV-048`). What it cost is specific: a person in a kitchen with no signal takes a tablet,
 * records it, is told Kynviora could not reach the server, and the record is gone - so the history
 * somebody reads later is missing a dose that was taken, with nothing saying so.
 */

/** Requests that recorded a dose. */
export function doseCreates(requests: readonly ObservedRequest[]): readonly ObservedRequest[] {
  return requests.filter(
    (request) => request.method === 'POST' && /\/v1\/dose-events$/.test(request.path),
  );
}

export interface DoseQueuedEvidence {
  /** Every accessible name on the screen after the save, or `null` where it could not be read. */
  readonly screenText: readonly string[] | null;
  /** What the app says when a dose is on the phone and not yet on the server. */
  readonly offlineSentence: string;
  /** What it says when the server has it. Must not be on screen at the same time. */
  readonly recordedSentence: string;
}

/**
 * The person is told where their record actually is.
 *
 * Both halves, because either alone passes a screen nobody should ship. A screen saying nothing
 * leaves somebody who has just recorded a dose unable to tell a save from a failure; a screen
 * saying "Recorded." over a request that failed is worse, because it is the sentence that stops
 * them recording it again. `12` requires a queued change to be visible rather than assumed, and
 * this is the moment the promise is made to the person rather than to the journal.
 */
export function doseQueuedOnScreenCheck(evidence: DoseQueuedEvidence): Check {
  const title = 'The person is told the dose is on this phone, not that it is saved';
  if (evidence.screenText === null) {
    return {
      id: 'OFF-6',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The screen could not be read after the dose was recorded.',
    };
  }
  const says = (fragment: string): boolean =>
    evidence.screenText?.some((text) => text.includes(fragment)) ?? false;

  if (says(evidence.recordedSentence) && !says(evidence.offlineSentence)) {
    return {
      id: 'OFF-6',
      title,
      status: 'FAIL',
      detail:
        'The screen said the dose was recorded, and the request had failed. That is the sentence ' +
        'that stops somebody recording it again.',
    };
  }
  if (!says(evidence.offlineSentence)) {
    return {
      id: 'OFF-6',
      title,
      status: 'FAIL',
      detail:
        `Nothing on the screen said ${JSON.stringify(evidence.offlineSentence)}. A person who has ` +
        'just recorded a dose cannot tell a save from a failure.',
    };
  }
  return {
    id: 'OFF-6',
    title,
    status: 'PASS',
    detail:
      'The screen says the dose is kept on this phone and will be sent when it can, and does not ' +
      'claim it is saved.',
  };
}

export interface DoseReplayEvidence {
  /** Every dose create the switch saw, across the swallowed attempt and the replay. */
  readonly creates: readonly ObservedRequest[];
  /** Dose events on the server carrying this run's own note. */
  readonly rowsWithNote: number;
  /** The note, for a report somebody has to read. */
  readonly note: string;
}

/**
 * A dose whose answer was lost is committed once, under the key it first used.
 *
 * The counting is what makes this hard to fake, and it is why the run swallows an answer rather
 * than simply going offline. If the phone had queued nothing at all, the swallowed request would
 * still have committed and the server would still hold exactly one event - so "one row" on its own
 * is passed by an app with no journal. Two creates under one key, with the server answering
 * `idempotent-replay` to the second, is the shape only a replay produces.
 */
export function doseCommittedOnceCheck(evidence: DoseReplayEvidence): Check {
  const title = 'A dose whose answer was lost is committed once, under the key it first used';
  const keys = new Set(evidence.creates.map((create) => create.key).filter((key) => key !== null));
  const replayed = evidence.creates.filter((create) => create.replay === 'true');

  if (evidence.creates.length < 2) {
    return {
      id: 'OFF-7',
      title,
      status: 'FAIL',
      detail:
        `Only ${String(evidence.creates.length)} dose create(s) were seen. The answer was ` +
        'destroyed, so the phone had every reason to queue and replay - one request means it ' +
        'kept nothing, and the dose exists only because the swallowed attempt happened to commit.',
    };
  }
  if (keys.size !== 1) {
    return {
      id: 'OFF-7',
      title,
      status: 'FAIL',
      detail:
        `The replay used a different idempotency key (${String(keys.size)} distinct keys across ` +
        `${String(evidence.creates.length)} creates). A fresh key on a replay is not an ` +
        'idempotency key: it is a second dose in a history somebody reads as a record of what ' +
        'they did (DEC-111).',
    };
  }
  if (evidence.rowsWithNote !== 1) {
    return {
      id: 'OFF-7',
      title,
      status: 'FAIL',
      detail:
        `The server holds ${String(evidence.rowsWithNote)} dose events noted ` +
        `${JSON.stringify(evidence.note)}. One recorded dose has become another number.`,
    };
  }
  if (replayed.length === 0) {
    return {
      id: 'OFF-7',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'One row and one key, but the server never answered `idempotent-replay`, so the second ' +
        'request may not have reached it at all.',
    };
  }
  return {
    id: 'OFF-7',
    title,
    status: 'PASS',
    detail:
      `${String(evidence.creates.length)} dose creates went out under one key, the server ` +
      `answered \`idempotent-replay\` to ${String(replayed.length)} of them, and exactly one ` +
      `event noted ${JSON.stringify(evidence.note)} exists.`,
  };
}

// ---------------------------------------------------------------------------
// OFF-8 and OFF-9 - the same journal, reached by voice
// ---------------------------------------------------------------------------

/**
 * What a transcript entry of Kynviora's is called, so its text can be told from the screen's.
 *
 * `VoiceScreen` announces each entry as `Kynviora said. <text>`, and the prefix is the whole point:
 * a screen carries sentences nobody spoke. The idle state's own hint is
 * "Ask Kynviora something, or press Done." - which contains `Done.` - so a check that searched
 * everything on screen for the sentence the shell speaks when a tool says nothing found it on
 * **every** run, whatever happened, and reported the one thing this check exists to catch.
 *
 * It did. `OFF-8` failed on a run where `OFF-9` had just proved the reminder queued and arrived,
 * which is the pair that made it obvious. This is trap 193 in a second place: compare the whole
 * announcement, which only a transcript line carries.
 */
const SAID_BY_KYNVIORA = 'Kynviora said. ';

export interface VoiceQueuedEvidence {
  /**
   * Everything on screen after the confirmation, or `null` if it could not be read.
   *
   * The whole screen rather than the transcript, because the whole screen is what a harness can
   * collect - and narrowing it to what Kynviora said is a rule, which belongs here where it is
   * tested rather than in the driver where it is not.
   */
  readonly transcript: readonly string[] | null;
  /** What the app says when it has kept a change here. `UTTERANCES.queued`. */
  readonly queuedSentence: string;
  /** What it says when a tool answered with nothing at all. `UTTERANCES.done`. */
  readonly doneSentence: string;
  /** What it says when the server could not be asked and nothing was kept. `UTTERANCES.offline`. */
  readonly offlineSentence: string;
  /** Requests that reached the API while it was supposed to be unreachable. */
  readonly requestsWhileOffline: readonly ObservedRequest[];
  /** Schedules the server has active on the medicine after the confirmation. */
  readonly activeAfterSave: number;
}

/**
 * A schedule set by voice with no signal is kept here, and said to be kept.
 *
 * WHY THIS IS A SEPARATE CHECK FROM `OFF-1`
 * `OFF-1` measures the schedule sheet, which draws a screen state; this measures a **sentence
 * somebody hears**, which is the only thing Voice Mode's audience gets. `01` names an older adult
 * first and `18` builds on that: a person who is not looking at the screen has nothing to go back
 * to, so the words are the whole of what they are told and there is no later moment at which a
 * wrong one is corrected.
 *
 * THE THREE WRONG ANSWERS, AND WHY THE FIRST IS THE ONE TO LOOK FOR
 * **"Done."** is the failure `DEV-085` and `DEV-090` are two halves of. The shell speaks it when a
 * tool answers with nothing at all, which is right for a write that succeeded quietly and is a
 * false statement about one that did not happen. It is checked first and by exact sentence,
 * because it is the one a person acts on: they stop thinking about a reminder that does not exist.
 *
 * **The offline sentence** promises nothing, which is honest and is the wrong half here - the
 * phone did keep it, and telling somebody it did not is the mirror failure: they set it again.
 *
 * **A request reaching the server** means the run never measured what it thinks it did, which is
 * an inconclusive rather than a failure (DEC-102).
 */
export function voiceQueuedOnScreenCheck(evidence: VoiceQueuedEvidence): Check {
  const id = 'OFF-8';
  const title = 'A reminder set by voice with no signal is kept, and said to be kept';

  if (evidence.transcript === null) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'The transcript could not be read after the confirmation.',
    };
  }
  const reached = evidence.requestsWhileOffline.length;
  if (reached > 0) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        `${String(reached)} request(s) reached the API while it was supposed to be unreachable ` +
        `(${evidence.requestsWhileOffline.map((request) => `${request.method} ${request.path}`).join(', ')}), ` +
        'so the app was never offline and nothing had to be queued.',
    };
  }

  const spoken = evidence.transcript
    .filter((line) => line.startsWith(SAID_BY_KYNVIORA))
    .map((line) => line.slice(SAID_BY_KYNVIORA.length));
  if (spoken.length === 0) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The screen was read and carried no line Kynviora had spoken, so either the exchange did ' +
        'not happen or the transcript was not on screen.',
    };
  }

  const says = (fragment: string): boolean => spoken.some((line) => line.includes(fragment));

  if (says(evidence.doneSentence)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `The transcript says ${JSON.stringify(evidence.doneSentence)}. That is what the shell ` +
        'speaks when a tool answers with nothing at all, and it is a statement that the reminder ' +
        'is set. It is not.',
    };
  }
  if (evidence.activeAfterSave !== 0) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'The server gained a schedule while it was unreachable, which cannot have happened.',
    };
  }
  if (says(evidence.offlineSentence) && !says(evidence.queuedSentence)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'The transcript says only that there is no connection, and the change was kept. A person ' +
        'told their reminder was not set will set it again, and the journal will send both.',
    };
  }
  if (!says(evidence.queuedSentence)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `Nothing in the transcript said ${JSON.stringify(evidence.queuedSentence)}. A person who ` +
        'has just asked for a reminder cannot tell a save from a failure.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      'No request left the phone, the server was unchanged, and the transcript says the change is ' +
      'kept here and will be sent - not that it is done.',
  };
}

export interface VoiceDrainEvidence {
  /** Every request the switch saw on the launch that followed the kill. */
  readonly requestsOnFirstLaunch: readonly ObservedRequest[];
  /** The times the server has active on the medicine after that launch. */
  readonly activeTimesAfter: readonly string[];
  readonly expectedTime: string;
}

/**
 * The reminder set by voice arrives on the first launch after the kill, exactly once.
 *
 * WHAT THIS ADDS OVER `OFF-3`, WHICH LOOKS THE SAME
 * The path into the journal, and that is the only difference on purpose. DEC-148's whole claim is
 * that voice reaches the journal the schedule sheet reaches rather than a second one - so what has
 * to be true is that a change queued by **speaking** is drained by the same pass, sent by the same
 * registered sender, and lands as one row. A voice-specific queue would pass every assertion in
 * `apps/mobile/src/voice` and be invisible here only if this check did not exist.
 *
 * The count is the half that cannot be faked. One create is a schedule; two is a person told twice,
 * at the same minute, to take the same tablet - which is what a fresh idempotency key on the replay
 * produces and what DEC-111 is about.
 */
export function voiceDrainedOnceCheck(evidence: VoiceDrainEvidence): Check {
  const id = 'OFF-9';
  const title = 'The reminder set by voice is sent on the first launch, and lands once';
  const creates = scheduleCreates(evidence.requestsOnFirstLaunch);
  const keys = new Set(creates.map((create) => create.key).filter((key) => key !== null));
  const matching = evidence.activeTimesAfter.filter((time) => time === evidence.expectedTime);

  if (creates.length === 0) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'No schedule was created on the launch that followed the kill. The change is still in the ' +
        'journal, and the person has been told it was kept.',
    };
  }
  if (keys.size > 1) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `${String(creates.length)} create(s) went out under ${String(keys.size)} distinct keys. A ` +
        'fresh key on a replay is not an idempotency key: on this table it is a second reminder ' +
        'for the same tablet at the same minute (DEC-111).',
    };
  }
  if (matching.length === 0) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `The create was sent and the server does not have ${evidence.expectedTime} active (it has ` +
        `${evidence.activeTimesAfter.join(', ') || 'nothing'}).`,
    };
  }
  if (matching.length > 1) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `The server has ${String(matching.length)} active schedules at ${evidence.expectedTime}. ` +
        'One request, two reminders.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      `${String(creates.length)} create(s) went out on that launch under one key, and the server ` +
      `has exactly one active schedule at ${evidence.expectedTime}. Voice and touch drained ` +
      'through the same pass.',
  };
}
