/**
 * Prove - or fail to prove - that an edit made with no signal arrives later, exactly once.
 *
 * Spec references: `19` ("Offline create/edit/sync", "Low storage/network disruption"), `12`
 * (pending-operation journal, idempotency keys, a resolvable failure state), `13` (the operation
 * ID is the idempotency key; the server commits exactly once), `03` group J, `04` Phase 4.1,
 * `DEV-038`, `DEV-040`, `DEV-044`, DEC-111.
 *
 *   npm run verify:device:offline
 *
 * WHY THIS SCENARIO IS WORTH ITS OWN RUN
 * `verify:device` shows the store is encrypted, `verify:device:update` shows it survives an
 * install, `verify:device:reminders` shows the alarms survive a kill. None of them writes
 * anything. The journal is the one part of `12` that is about a person's change rather than about
 * a copy of the server's answer, and losing it is the failure they cannot detect: they set a
 * medicine time, the phone had no signal, and either it arrives or it does not, with nothing on
 * any screen either way (`DEV-038` - the queue is still invisible).
 *
 * WHAT IS ACTUALLY DONE TO THE DEVICE
 * Two runs of the same scenario, differing only in what the network does to one request.
 *
 *   Run A - the tunnel is switched off, a schedule is saved, the app's process is killed, the
 *           network comes back, and the app is launched **once**. The queued create must go out on
 *           that launch.
 *   Run B - the request is forwarded and its *answer* is destroyed. The server commits; the phone
 *           cannot tell that from being offline and queues. The replay must carry the same
 *           idempotency key and must leave exactly one schedule.
 *
 * Run B is the one that cannot be faked. A client that minted a fresh key on replay passes Run A
 * perfectly and leaves the person being told twice, at the same minute, to take the same tablet.
 *
 * WHAT THIS NEEDS
 * The seeded API on `127.0.0.1:3000` (`KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev`), a
 * Metro bundler, and an attached device with the app installed. It repoints `adb reverse tcp:3000`
 * at its own switch for the duration and puts it back afterwards. It deactivates the schedules it
 * creates, but it is a write scenario against a real database, so it belongs on the development
 * seed and nowhere else.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { PACKAGE, adb, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import { startApiSwitch, type ApiSwitch } from './apiSwitch.js';
import { DOSE_COPY } from '@kynviora/presentation';
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
} from './offlineWrites.js';
import {
  captureFailure,
  coldStart as startApp,
  collectScreenText,
  dismissKeyboard,
  killApp,
  launch,
  pressHome,
  prepareDeviceForDriving,
  screenShowsFailure,
  scrollToAndTap,
  scrollToAndTapBelow,
  tapNamed,
  typeInto,
} from './ui.js';

const API_PORT = 3000;
const SWITCH_PORT = 3999;

/** The development seed's household, profile and first medicine (`db/src/seed.ts`). */
const USER_ID = '00000000-0000-4000-8000-00000000d001';
const ITEM_ID = '00000000-0000-4000-8000-00000000d030';

/**
 * Times chosen to be ones nothing else uses.
 *
 * Distinct per run so that "the server has this time" cannot be satisfied by the other run's row,
 * and early enough in the morning that a reminder planned from them will not fire during the run.
 */
const RUN_A_TIME = '05:25';
const RUN_B_TIME = '04:10';

/** The seed's first medicine, by the name its row is headed with. */
const ITEM_NAME = 'Synthetic Tablet A';

/**
 * The note Run C writes, carrying this run's own suffix.
 *
 * `0004` grants the app role no DELETE on `dose_event` either, so every event any run ever
 * recorded is still there. A fixed note would let last week's run answer this week's question
 * about how many exist.
 */
const RUN_C_NOTE = `offline dose ${Date.now().toString(36).slice(-4).toUpperCase()}`;

interface ServerSchedule {
  readonly id: string;
  readonly timesLocal: readonly string[];
  readonly active: boolean;
  readonly version: number;
  readonly scheduleKind: string;
  readonly daysOfWeek: readonly number[] | null;
  readonly timeZone: string;
}

/**
 * Talk to the API, retrying once past a socket the pool kept and the server had already closed.
 *
 * `sleep` is synchronous on purpose - this harness is a sequence of device interactions and
 * interleaving them would make a failure impossible to attribute - so the event loop is blocked
 * for forty-five seconds at a time while the app starts. Fastify closes an idle keep-alive
 * connection long before that, and `fetch` cannot notice while nothing is running, so the next
 * call reuses a dead socket and fails with `ECONNRESET`. That is a fact about this harness's own
 * shape rather than anything about the app, and it must not be allowed to look like a verdict.
 *
 * `connection: close` asks for no reuse at all, and the retry covers the one already in the pool.
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(`http://127.0.0.1:${String(API_PORT)}${path}`, {
        ...init,
        headers: {
          'x-kynviora-dev-user': USER_ID,
          connection: 'close',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

/**
 * Read the medicine's schedules from the API directly, not through the switch.
 *
 * The harness must be able to see the server while the phone cannot, which is the entire point of
 * OFF-1 - so this talks to `API_PORT` and never to the switch.
 *
 * `null` means the server could not be read at all, which is different from "it has none" and has
 * to stay different: an unreachable API would otherwise report every check as a clean pass over an
 * empty result.
 */
async function doseEventsNoted(note: string): Promise<number | null> {
  const response = await apiFetch(`/v1/dose-events?ownedItemId=${ITEM_ID}`);
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as {
    readonly events?: readonly { readonly note: string | null }[];
  };
  return (body.events ?? []).filter((event) => event.note === note).length;
}

async function serverSchedules(): Promise<readonly ServerSchedule[] | null> {
  const response = await apiFetch(`/v1/items/${ITEM_ID}/schedules`);
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as { readonly schedules?: readonly ServerSchedule[] };
  return body.schedules ?? [];
}

const activeTimes = (schedules: readonly ServerSchedule[] | null): readonly string[] =>
  (schedules ?? [])
    .filter((schedule) => schedule.active)
    .flatMap((schedule) => schedule.timesLocal);

/** A check that reports the server could not be read, rather than a verdict drawn from silence. */
function unreadableServer(id: string, title: string): Check {
  return {
    id,
    title,
    status: 'INCONCLUSIVE',
    detail:
      `The API on 127.0.0.1:${String(API_PORT)} could not be read, so nothing here was measured. ` +
      'Is the seeded development server still running?',
  };
}

/**
 * Turn off every active schedule on the medicine.
 *
 * Run before each scenario, because OFF-0 refuses to judge a medicine that already had one - "the
 * server has a schedule afterwards" would then be true before anything was saved. `0004` grants
 * the app role no DELETE on this table, so this deactivates rather than removes.
 */
async function deactivateAll(): Promise<void> {
  for (const schedule of (await serverSchedules()) ?? []) {
    if (!schedule.active) continue;
    await apiFetch(`/v1/schedules/${schedule.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: schedule.version,
        scheduleKind: schedule.scheduleKind,
        timesLocal: schedule.timesLocal,
        daysOfWeek: schedule.daysOfWeek,
        timeZone: schedule.timeZone,
        active: false,
      }),
    });
  }
}

/**
 * Start the app and wait until it is actually the thing on screen.
 *
 * A launch that did not happen is "could not look", not "the app is broken", and the difference is
 * not academic: a run whose first launch failed reported the screen as having told somebody their
 * medicine time was lost. Metro rebuilds the bundle on every cold start here, and a hiccup leaves
 * the launcher on screen with no trace in the app at all - so the launch is confirmed and retried
 * once before anything is judged.
 */
function coldStart(): boolean {
  return startApp('offline');
}

/**
 * Open the "add a schedule" form for the first seeded medicine and put a time in it.
 *
 * Every step is by accessible name, and each returns whether it happened, because the ways this
 * goes wrong are all silent: a tap landing on a label rather than the button under it, a control
 * below the fold, a soft keyboard moving the field, and a stylus tutorial eating the typing.
 */
interface FormAttempt {
  readonly reached: boolean;
  readonly held: string | null;
  /** The step that did not happen, for a report somebody has to act on. */
  readonly failedAt: string | null;
}

function openScheduleFormWith(time: string): FormAttempt {
  // Named steps rather than a bare boolean. Four of them can fail and the screen looks much the
  // same afterwards, so "the form did not hold the time" without a step is a report that costs
  // another whole run to interpret - which it did, twice.
  const steps: readonly (readonly [string, () => boolean])[] = [
    ['open the Shelf tab', () => tapNamed('Shelf')],
    ['open the schedule editor', () => scrollToAndTap('When do you take this?')],
    ['open the new-schedule form', () => scrollToAndTap('Add a schedule')],
  ];

  for (const [what, run] of steps) {
    if (!run()) {
      const evidence = captureFailure(`offline-${what.replace(/[^a-z]+/gi, '-')}`);
      return { reached: false, held: null, failedAt: `${what} (see ${evidence.join(', ')})` };
    }
    sleep(4_000);
  }

  const typed = typeInto('Times 1', time);
  dismissKeyboard();
  if (typed.typed) return { reached: true, held: typed.held, failedAt: null };
  const evidence = captureFailure('offline-type-the-time');
  return {
    reached: false,
    held: typed.held,
    failedAt: `type the time into the form (see ${evidence.join(', ')})`,
  };
}

/** Save the open form, and report whether the screen then said anything went wrong. */
function saveTheForm(): { readonly saved: boolean; readonly showedError: boolean } {
  if (!scrollToAndTap('Save schedule')) return { saved: false, showedError: false };
  sleep(12_000);
  return { saved: true, showedError: screenShowsFailure() };
}

/**
 * Run A: no signal at all.
 *
 * The claim is not "it arrives eventually". It is that it goes out on the **first** launch after
 * the process died, because that is the launch the person actually makes and because getting it
 * wrong is invisible: the queue used to wait for a second foreground while the sender's screen
 * mounted, and nothing anywhere said so (`DEV-044`).
 */
async function runOffline(apiSwitch: ApiSwitch): Promise<readonly Check[]> {
  const checks: Check[] = [];
  await deactivateAll();

  apiSwitch.setMode('pass');
  apiSwitch.clear();
  coldStart();

  process.stdout.write('Run A: opening the schedule form...\n');
  const form = openScheduleFormWith(RUN_A_TIME);
  const before = await serverSchedules();
  const precondition =
    before === null
      ? unreadableServer('OFF-0', 'The app was ready to save a schedule nobody had saved yet')
      : preconditionCheck({
          formHeldTheTime: form.reached,
          timeInTheField: form.held,
          activeBefore: activeTimes(before).length,
        });
  checks.push(
    form.failedAt === null
      ? precondition
      : { ...precondition, detail: `${precondition.detail} Could not ${form.failedAt}.` },
  );

  process.stdout.write('Run A: cutting the API off and saving...\n');
  apiSwitch.setMode('offline');
  apiSwitch.clear();
  const saved = saveTheForm();
  const seenWhileOffline = apiSwitch.seen();
  const afterSave = await serverSchedules();
  checks.push(
    afterSave === null
      ? unreadableServer('OFF-1', 'An edit made with no signal is queued, not lost')
      : queuedRatherThanFailedCheck({
          requestsWhileOffline: seenWhileOffline,
          saveAttempted: form.reached && saved.saved,
          screenShowedError: saved.showedError,
          activeAfterSave: activeTimes(afterSave).length,
        }),
  );

  process.stdout.write('Run A: killing the process...\n');
  const killed = killApp();
  checks.push(
    processDiedCheck({
      pidBefore: killed.before,
      pidAfter: killed.after,
      backgroundedFirst: true,
    }),
  );

  process.stdout.write('Run A: reconnecting and launching once...\n');
  apiSwitch.setMode('pass');
  apiSwitch.clear();
  launch();
  sleep(55_000);
  const afterLaunch = await serverSchedules();
  checks.push(
    afterLaunch === null
      ? unreadableServer('OFF-3', 'The queued edit is sent on the first launch after the kill')
      : drainedOnFirstLaunchCheck({
          requestsOnFirstLaunch: apiSwitch.seen(),
          activeTimesAfter: activeTimes(afterLaunch),
          expectedTime: RUN_A_TIME,
        }),
  );

  // A committed operation has to leave the journal, or the phone replays it forever. Read from
  // outside because the store is SQLCipher-encrypted and no screen shows the queue (`DEV-038`).
  process.stdout.write('Run A: checking nothing is left waiting...\n');
  apiSwitch.clear();
  pressHome();
  launch();
  sleep(25_000);
  checks.push(nothingLeftWaitingCheck({ requestsAfterSettling: apiSwitch.seen() }));

  return checks;
}

/**
 * Run B: the request lands and the answer is lost.
 *
 * The whole run exists for one reading - the key on the replay, and the number of rows it left.
 */
async function runLostAnswer(apiSwitch: ApiSwitch): Promise<readonly Check[]> {
  await deactivateAll();

  // The same control OFF-0 is for Run A, and it is needed for the same reason. `0004` grants no
  // DELETE on this table, so every schedule any run ever created is still there - deactivated. If
  // one at this time were somehow still live, "exactly one live schedule" would be answered by the
  // history of this machine rather than by what the phone just did.
  const already = await serverSchedules();
  const liveAtThatTime =
    already === null
      ? null
      : already.filter((schedule) => schedule.active && schedule.timesLocal.includes(RUN_B_TIME))
          .length;
  if (liveAtThatTime === null || liveAtThatTime !== 0) {
    return [
      {
        id: 'OFF-4',
        title: 'A create whose answer was lost is committed once, under the key it first used',
        status: 'INCONCLUSIVE',
        detail:
          liveAtThatTime === null
            ? `The API on 127.0.0.1:${String(API_PORT)} could not be read before the run started.`
            : `${String(liveAtThatTime)} schedule(s) were already live at ${RUN_B_TIME}, so ` +
              '"exactly one" would have been true before the phone did anything.',
      },
    ];
  }

  apiSwitch.setMode('pass');
  apiSwitch.clear();
  coldStart();

  process.stdout.write('Run B: opening the schedule form...\n');
  const form = openScheduleFormWith(RUN_B_TIME);
  if (!form.reached) {
    return [
      {
        id: 'OFF-4',
        title: 'A create whose answer was lost is committed once, under the key it first used',
        status: 'INCONCLUSIVE',
        detail: 'The schedule form could not be filled in, so no create was ever made.',
      },
    ];
  }

  process.stdout.write('Run B: swallowing the answer and saving...\n');
  apiSwitch.setMode('swallow');
  apiSwitch.clear();
  saveTheForm();

  process.stdout.write('Run B: killing the process and reconnecting...\n');
  killApp();
  apiSwitch.setMode('pass');
  launch();
  sleep(55_000);

  const schedules = await serverSchedules();
  if (schedules === null) {
    return [
      unreadableServer(
        'OFF-4',
        'A create whose answer was lost is committed once, under the key it first used',
      ),
    ];
  }
  return [
    committedOnceCheck({
      creates: scheduleCreates(apiSwitch.seen()),
      activeRowsWithTime: schedules.filter(
        (schedule) => schedule.active && schedule.timesLocal.includes(RUN_B_TIME),
      ).length,
      expectedTime: RUN_B_TIME,
    }),
  ];
}

/**
 * Run C: a dose recorded with no signal, on the second entity type the queue carries.
 *
 * The scenario is Run B's - the request is forwarded and its answer destroyed - and it is that one
 * rather than a plain disconnection for a reason the check spells out. With no journal at all the
 * swallowed request still commits, so a run that merely counted rows afterwards would pass an app
 * that kept nothing. Two creates under one key, with the server answering `idempotent-replay` to
 * the second, is the shape only a replay produces.
 *
 * `04` Phase 4.3's exit criterion is exactly this: an event created offline may be uploaded more
 * than once, and a duplicate sync must not create a duplicate event. Until this session nothing in
 * the app queued a dose at all (`DEV-048`).
 */
async function runOfflineDose(apiSwitch: ApiSwitch): Promise<readonly Check[]> {
  const inconclusive = (id: string, title: string, detail: string): Check => ({
    id,
    title,
    status: 'INCONCLUSIVE',
    detail,
  });

  const before = await doseEventsNoted(RUN_C_NOTE);
  if (before === null || before !== 0) {
    const detail =
      before === null
        ? 'The dose history could not be read before the run started.'
        : `${String(before)} dose event(s) already carry this run's note, so "exactly one" would ` +
          'have been true before the phone did anything.';
    return [
      inconclusive(
        'OFF-6',
        'The person is told the dose is on this phone, not that it is saved',
        detail,
      ),
      inconclusive(
        'OFF-7',
        'A dose whose answer was lost is committed once, under the key it first used',
        detail,
      ),
    ];
  }

  apiSwitch.setMode('pass');
  apiSwitch.clear();
  coldStart();

  process.stdout.write('Run C: opening the record-a-dose screen...\n');
  // By the row's own heading: every shelf row draws an identically named "Record what happened",
  // and a plain lookup would record a dose against whichever medicine is first.
  if (!tapNamed('Shelf') || !scrollToAndTapBelow('Record what happened', ITEM_NAME)) {
    const evidence = captureFailure('offline-open-the-dose-screen');
    const detail = `The record-a-dose screen could not be opened (see ${evidence.join(', ')}).`;
    return [
      inconclusive(
        'OFF-6',
        'The person is told the dose is on this phone, not that it is saved',
        detail,
      ),
      inconclusive(
        'OFF-7',
        'A dose whose answer was lost is committed once, under the key it first used',
        detail,
      ),
    ];
  }
  sleep(6_000);

  const typed = typeInto(DOSE_COPY.noteLabel, RUN_C_NOTE);
  if (!typed.typed) {
    const evidence = captureFailure('offline-type-the-dose-note');
    const detail =
      `The note field held ${typed.held === null ? 'nothing readable' : JSON.stringify(typed.held)} ` +
      `rather than ${JSON.stringify(RUN_C_NOTE)} (see ${evidence.join(', ')}).`;
    return [
      inconclusive(
        'OFF-6',
        'The person is told the dose is on this phone, not that it is saved',
        detail,
      ),
      inconclusive(
        'OFF-7',
        'A dose whose answer was lost is committed once, under the key it first used',
        detail,
      ),
    ];
  }

  process.stdout.write('Run C: swallowing the answer and recording the dose...\n');
  apiSwitch.setMode('swallow');
  apiSwitch.clear();
  const recorded = scrollToAndTap('I took it');
  sleep(15_000);

  const checks: Check[] = [];
  checks.push(
    doseQueuedOnScreenCheck({
      screenText: recorded ? collectScreenText() : null,
      offlineSentence: DOSE_COPY.offlineNote,
      recordedSentence: DOSE_COPY.recordedDone,
    }),
  );

  process.stdout.write('Run C: killing the process and reconnecting...\n');
  killApp();
  apiSwitch.setMode('pass');
  launch();
  sleep(55_000);

  const after = await doseEventsNoted(RUN_C_NOTE);
  checks.push(
    after === null
      ? inconclusive(
          'OFF-7',
          'A dose whose answer was lost is committed once, under the key it first used',
          `The API on 127.0.0.1:${String(API_PORT)} could not be read after the relaunch.`,
        )
      : doseCommittedOnceCheck({
          creates: doseCreates(apiSwitch.seen()),
          rowsWithNote: after,
          note: RUN_C_NOTE,
        }),
  );
  return checks;
}

async function main(): Promise<void> {
  if (!isInstalled()) {
    process.stdout.write(
      `${PACKAGE} is not installed on the attached device.\n` +
        '  cd apps/mobile && npx expo run:android\n',
    );
    process.exitCode = 1;
    return;
  }

  const reachable = (await serverSchedules()) !== null;
  if (!reachable) {
    process.stdout.write(
      `No seeded API on 127.0.0.1:${String(API_PORT)}. This scenario writes through the real\n` +
        'route, so there has to be one:\n' +
        '  KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev\n',
    );
    process.exitCode = 1;
    return;
  }

  prepareDeviceForDriving();
  const apiSwitch = startApiSwitch({ port: SWITCH_PORT, upstreamPort: API_PORT });

  // The phone keeps addressing 127.0.0.1:3000, so the client's loopback rule still holds; only
  // what sits on the other end of the tunnel changes.
  adb(['reverse', '--remove', `tcp:${String(API_PORT)}`]);
  adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(SWITCH_PORT)}`]);

  const checks: Check[] = [];
  try {
    checks.push(...(await runOffline(apiSwitch)));
    checks.push(...(await runLostAnswer(apiSwitch)));
    checks.push(...(await runOfflineDose(apiSwitch)));
  } finally {
    await deactivateAll();
    apiSwitch.setMode('pass');
    apiSwitch.close();
    adb(['reverse', '--remove', `tcp:${String(API_PORT)}`]);
    adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(API_PORT)}`]);
  }

  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

void main();
