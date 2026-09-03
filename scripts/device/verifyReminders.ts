/**
 * Prove - or fail to prove - that a medicine reminder actually arrives on an attached device.
 *
 * Spec references: `04` Phase 4.2 exit criteria ("reminder reliability is measured across process
 * death and device restart scenarios"; "sensitive medicine names are not shown on lock screen by
 * default"), `15` A6, `19` (device E2E), `18`.
 *
 *   npm run verify:device:reminders
 *
 * WHAT MAKES THIS EVIDENCE RATHER THAN A RESTATEMENT OF THE CODE
 * Nothing here reads the app's own state. It creates a real schedule through the real API, kills
 * the app so nothing of Kynviora is running, and then asks the *platform* two questions: is an
 * alarm pending, and did a notification appear. Both answers come from `dumpsys`, which knows
 * nothing about this codebase.
 *
 * WHY THE KILL IS `am kill` AND NOT `am force-stop`
 * Because they are different things, and the first version of this file used the wrong one. On
 * Android, `force-stop` is the "Force stop" button in system settings: it puts the app in the
 * stopped state and **cancels every alarm it had registered**. Measured on this emulator: 28
 * pending alarms before, 0 after. So a harness that force-stops and then waits is measuring
 * Android's force-stop semantics, not whether a reminder survives the process dying - and it
 * reports a working engine as broken.
 *
 * `am kill` is process death: the process is gone (`pidof` returns nothing) and the alarms are
 * untouched (28 before, 28 after). That is what happens when the system reclaims memory or a
 * person swipes the app away, which is the scenario `04` Phase 4.2 names. `REM-3a` asserts both
 * halves - no process, alarms intact - because a delivery test after a kill that did not kill
 * proves nothing.
 *
 * WHY THE SCHEDULE IS CREATED THROUGH THE API AND NOT WRITTEN INTO THE DATABASE
 * The route, the RLS policy, the client and the planner are all on the path being measured. A row
 * inserted behind them would test the notification library and nothing else.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { PACKAGE, adb, isInstalled, sleep } from './adb.js';
import {
  alarmsHeldCheck,
  exactAlarmCheck,
  formatReminderReport,
  lockScreenDisclosureCheck,
  noDuplicateRemindersCheck,
  pendingAlarmsFor,
  postedNotifications,
  processDeathCheck,
  rebootRecoveryCheck,
  reminderArrivedCheck,
  remindersOverall,
  timeZoneShiftCheck,
  type Check,
} from './reminders.js';

const API_PORT = 3000;
const API = `http://127.0.0.1:${String(API_PORT)}`;

/** The development seed's identity, which is what the app is configured with. */
const DEV_USER_ID = '00000000-0000-4000-8000-00000000d001';
const SEED_PROFILE_ID = '00000000-0000-4000-8000-00000000d020';
const SEED_MEDICINE_ID = '00000000-0000-4000-8000-00000000d030';

/**
 * Strings that must never appear in a notification.
 *
 * The seed's own names (`db/src/seed.ts`). Passed to the check rather than hard-coded there, so
 * the harness fails on a device seeded differently instead of silently checking the wrong words.
 */
const FORBIDDEN_IN_NOTIFICATION = ['Synthetic Tablet A', 'Development profile'];

/**
 * How far ahead the test dose is set.
 *
 * Generous, because everything before the wait takes real time on an emulator - two launches, a
 * home press, a kill - and a dose that passed while the app was still being driven would be
 * cancelled by the next re-plan and then reported as "never arrived". Five minutes leaves room.
 */
const LEAD_SECONDS = 300;

/**
 * How long the boot receiver is given to put the alarms back.
 *
 * Generous on purpose. Measured at a little over two minutes on this emulator, and the thing being
 * judged is whether they come back at all - not how promptly a virtual device that has just booted
 * 113 broadcast receivers gets around to it. A real deadline still has to exist, because "not yet"
 * and "never" are otherwise the same reading.
 */
const REBOOT_RESTORE_TIMEOUT_MS = 420_000;

/**
 * Where the device is sent for the travel check.
 *
 * Far enough from the seed's `Asia/Calcutta` that a dose re-expanded in the device's zone lands on
 * a visibly different instant rather than within a rounding error, and on the other side of a DST
 * boundary so the offset is not a whole number of hours the arithmetic could get right by accident.
 * The fallback is used only if a device is already in the first one.
 */
const TRAVEL_ZONE = 'Europe/London';
const FALLBACK_TRAVEL_ZONE = 'America/New_York';

interface Fetched {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

/**
 * One request to the development API, retried once if the transport fails.
 *
 * WHY THE RETRY EXISTS
 * A run of this harness reported REM-5 as INCONCLUSIVE with "the API refused the schedule (0)" -
 * a device verdict decided by this file's HTTP client rather than by the device. The API was up
 * throughout: its own log shows a request from this same run succeeding twelve seconds later.
 *
 * The mechanism was not established, and the obvious theory is wrong: a blocking `sleep` was
 * suspected of leaving a pooled socket stale, but a keep-alive connection was measured surviving
 * the full 390-second dose window intact, and forcing `connection: close` made it *worse* -
 * ECONNRESET after a 100-second block. So the honest description is a transient failure against a
 * server that was answering before and after it, in a process that blocks its own event loop for
 * minutes at a time while spawning `adb` synchronously.
 *
 * Retrying is safe here because every call is either a read or carries its own `idempotency-key`,
 * and it is honest because two failures in a row are still a failure - a server that is genuinely
 * down must not be retried into looking fine. What it must not do is let the harness's own
 * plumbing decide whether a reminder survived a reboot.
 */
async function api(path: string, init: RequestInit = {}): Promise<Fetched> {
  const send = async (): Promise<Fetched> => {
    try {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          // The development identity header, the same one the app sends over the adb tunnel.
          'x-kynviora-dev-user': DEV_USER_ID,
          ...(init.headers ?? {}),
        },
      });
      return { ok: response.ok, status: response.status, body: await response.text() };
    } catch (error) {
      return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) };
    }
  };

  const first = await send();
  // Only a transport failure is retried. An API that answered and said no is an answer.
  if (first.status !== 0) return first;
  sleep(2_000);
  return send();
}

/**
 * The wall-clock time, in the device's own zone, `LEAD_SECONDS` from now.
 *
 * Computed from the device's clock rather than the host's. An emulator's clock can drift from its
 * host, and a dose scheduled against the wrong one would either fire before the app was killed or
 * never fire within the run - both of which look exactly like the failure being tested for.
 */
function deviceLocalTimeIn(
  seconds: number,
): { readonly time: string; readonly zone: string } | null {
  const epoch = adb(['shell', 'date', '+%s']).stdout.trim();
  const zone = adb(['shell', 'getprop', 'persist.sys.timezone']).stdout.trim();
  const parsed = Number(epoch);
  if (!Number.isFinite(parsed) || parsed <= 0 || zone === '') return null;

  const at = new Date((parsed + seconds) * 1000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return { time: `${read('hour')}:${read('minute')}`, zone };
}

function alarmDump(): { readonly text: string; readonly available: boolean } {
  const result = adb(['shell', 'dumpsys', 'alarm']);
  return { text: result.stdout, available: result.ok && result.stdout.length > 0 };
}

function notificationDump(): { readonly text: string; readonly available: boolean } {
  // `--noredact` prints the extras rather than their lengths. Without it the disclosure check
  // would pass by being unable to read what it was judging.
  const result = adb(['shell', 'dumpsys', 'notification', '--noredact']);
  return { text: result.stdout, available: result.ok && result.stdout.length > 0 };
}

function heldAlarms(): { readonly count: number; readonly available: boolean } {
  const dump = alarmDump();
  return { count: pendingAlarmsFor(dump.text, PACKAGE).length, available: dump.available };
}

function launch(): void {
  adb(['shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`]);
}

/** Whether the app has a running process. Empty output means it does not. */
function isRunning(): boolean {
  return adb(['shell', 'pidof', PACKAGE]).stdout.trim() !== '';
}

/**
 * Kill the app the way the system does.
 *
 * Home first, because `am kill` only kills processes it considers safe to kill and a foreground
 * activity is not one of them - without it the process survives and the delivery test measures an
 * app that was running the whole time.
 */
function killProcess(): void {
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
  sleep(3_000);
  adb(['shell', 'am', 'kill', PACKAGE]);
  sleep(5_000);
}

/** Grant notifications up front. Android 13+ refuses to post anything without it. */
function grantNotifications(): void {
  adb(['shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS']);
}

/** The device's own IANA zone. */
function deviceTimeZone(): string {
  return adb(['shell', 'getprop', 'persist.sys.timezone']).stdout.trim();
}

/**
 * Move the device to another time zone, and say whether it actually moved.
 *
 * `setprop persist.sys.timezone` needs root, which an emulator grants and a production device does
 * not, so this reports failure rather than assuming. The return value is the zone the device is in
 * afterwards - read back rather than echoed, because a `setprop` that silently did nothing and one
 * that worked are otherwise indistinguishable.
 */
function setDeviceTimeZone(zone: string): string {
  adb(['root']);
  adb(['wait-for-device']);
  sleep(3_000);
  adb(['shell', 'setprop', 'persist.sys.timezone', zone]);
  sleep(3_000);
  // `adb root` restarts adbd, which drops the reverse tunnels the app reaches the API through.
  adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(API_PORT)}`]);
  adb(['reverse', 'tcp:8081', 'tcp:8081']);
  return deviceTimeZone();
}

/** Every schedule this harness created, so a run does not leave the seed carrying test reminders. */
const created: string[] = [];

async function createTestSchedule(
  leadSeconds: number,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const local = deviceLocalTimeIn(leadSeconds);
  if (local === null) {
    return { ok: false, detail: 'The device clock or time zone could not be read.' };
  }

  const response = await api(`/v1/items/${SEED_MEDICINE_ID}/schedules`, {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({
      scheduleKind: 'FIXED_TIMES',
      timesLocal: [local.time],
      timeZone: local.zone,
    }),
  });

  if (!response.ok) {
    return { ok: false, detail: `The API refused the schedule (${String(response.status)}).` };
  }
  const id = (JSON.parse(response.body) as { schedule?: { id?: string } }).schedule?.id;
  if (typeof id === 'string') created.push(id);
  return { ok: true, detail: `A dose was scheduled for ${local.time} ${local.zone}.` };
}

/** Stop the reminders this run created. Deactivated, never deleted - the route has no delete. */
async function stopTestSchedules(): Promise<void> {
  const read = await api(`/v1/profiles/${SEED_PROFILE_ID}/schedules`);
  if (!read.ok) return;
  const parsed = JSON.parse(read.body) as {
    schedules?: readonly {
      id: string;
      version: number;
      timeZone: string;
      timesLocal: string[];
      active: boolean;
    }[];
  };
  for (const id of created) {
    const stored = parsed.schedules?.find((schedule) => schedule.id === id);
    if (stored === undefined || !stored.active) continue;
    await api(`/v1/schedules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        expectedVersion: stored.version,
        scheduleKind: 'FIXED_TIMES',
        timesLocal: stored.timesLocal,
        timeZone: stored.timeZone,
        active: false,
      }),
    });
  }
}

/** Wait for the device to finish booting. */
function waitForBoot(timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = adb(['shell', 'getprop', 'sys.boot_completed']).stdout.trim();
    if (ready === '1') return true;
    sleep(5_000);
  }
  return false;
}

/**
 * Wait for the boot receiver to put the alarms back, rather than guessing how long it takes.
 *
 * WHY THIS IS A POLL AND NOT A SLEEP
 * It used to be `sleep(30_000)` after `sys.boot_completed` flipped, and that reported a working
 * engine as broken: 0 alarms at the 30-second mark, **28** when the same device was asked again a
 * few minutes later, with the app still never launched. A false FAIL is worse than an inconclusive
 * - it sends somebody hunting a defect that is not there, and the next person to see it fails for
 * real learns nothing.
 *
 * `sys.boot_completed` is not the finish line. The property flips, then `BOOT_COMPLETED` is
 * broadcast to a queue - 113 receivers on this device, reported as 49s of completion latency - and
 * `expo-notifications` starts the app's process from its own receiver and re-registers each stored
 * notification. On this emulator the process was started at boot and then *frozen* by the activity
 * manager for over a minute before it got to finish.
 *
 * The elapsed time is returned and printed, because it is a real property worth knowing: a dose due
 * in the first minutes after a restart is one nothing is holding an alarm for.
 */
function waitForAlarmRestore(timeoutMs: number): {
  readonly count: number;
  readonly available: boolean;
  readonly waitedMs: number;
} {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last = heldAlarms();
  while (Date.now() < deadline) {
    last = heldAlarms();
    if (last.available && last.count > 0) {
      return { count: last.count, available: true, waitedMs: Date.now() - started };
    }
    sleep(10_000);
  }
  return { count: last.count, available: last.available, waitedMs: Date.now() - started };
}

async function main(): Promise<void> {
  if (!isInstalled()) {
    process.stdout.write(
      `${PACKAGE} is not installed on the attached device.\n` +
        'Build and install the development build first:\n' +
        '  cd apps/mobile && npx expo run:android\n',
    );
    process.exitCode = 1;
    return;
  }

  const health = await api('/health');
  if (!health.ok) {
    process.stdout.write(
      `The API at ${API} did not answer, so no schedule can be created.\n` +
        'Start it with `KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev` and try again.\n',
    );
    process.exitCode = 1;
    return;
  }

  grantNotifications();
  // A clean slate. `force-stop` is the right tool *here* and only here: it clears the app's
  // pending alarms, which is exactly what a run should start from.
  adb(['shell', 'am', 'force-stop', PACKAGE]);
  adb(['shell', 'cmd', 'notification', 'clear_data', PACKAGE]);
  sleep(3_000);

  const checks: Check[] = [];
  const scheduled = await createTestSchedule(LEAD_SECONDS);

  if (!scheduled.ok) {
    checks.push({
      id: 'REM-0',
      title: 'A schedule could be created through the API',
      status: 'FAIL',
      detail: scheduled.detail,
    });
    process.stdout.write(`${formatReminderReport(checks)}\n`);
    process.exitCode = 1;
    return;
  }

  checks.push({
    id: 'REM-0',
    title: 'A schedule could be created through the API',
    status: 'PASS',
    detail: scheduled.detail,
  });

  // The app has to be opened once, because the plan is built on the device. That is the feature,
  // not a shortcut: `04` Phase 4.2 says the reminder does not rely on server timing.
  process.stdout.write('Opening the app so it can plan...\n');
  launch();
  sleep(40_000);

  const afterPlanning = heldAlarms();
  const plannedDump = alarmDump();
  const plannedAlarms = pendingAlarmsFor(plannedDump.text, PACKAGE);
  checks.push(alarmsHeldCheck(plannedAlarms, 1, afterPlanning.available));
  checks.push(exactAlarmCheck(plannedAlarms, afterPlanning.available));

  // Re-planning must converge. Kill and relaunch, then compare.
  process.stdout.write('Relaunching to check the plan converges...\n');
  killProcess();
  launch();
  sleep(35_000);
  const afterRelaunch = heldAlarms();
  checks.push(
    noDuplicateRemindersCheck(afterPlanning.count, afterRelaunch.count, afterRelaunch.available),
  );

  // ---- Process death ------------------------------------------------------
  process.stdout.write('Killing the process...\n');
  killProcess();
  const afterKill = heldAlarms();
  checks.push(
    processDeathCheck({
      running: isRunning(),
      alarmsBefore: afterRelaunch.count,
      alarmsAfter: afterKill.count,
      available: afterKill.available,
    }),
  );

  process.stdout.write('Waiting for the scheduled dose to arrive...\n');
  sleep(LEAD_SECONDS * 1000 + 90_000);

  const afterDose = notificationDump();
  const posted = postedNotifications(afterDose.text, PACKAGE);
  checks.push(
    reminderArrivedCheck(posted, afterDose.available, 'after the process was killed', 'REM-3'),
  );
  checks.push(lockScreenDisclosureCheck(posted, FORBIDDEN_IN_NOTIFICATION, afterDose.available));

  // ---- Travelling ---------------------------------------------------------
  // `19`'s clock/time-zone-change scenario. A schedule is authored in local wall-clock time and
  // carries its own IANA zone, so flying from Kolkata to London must not move a dose by five and a
  // half hours - the zone that decides the instant is the schedule's, not the phone's.
  //
  // WHY THE APP IS WIPED BETWEEN THE TWO READINGS
  // Because otherwise this check passes without testing anything. Android stores an alarm as an
  // absolute instant, so alarms that merely *survive* a zone change are unchanged by definition;
  // and `expo-notifications` re-registers from its own store on launch, so even a force-stop and
  // relaunch can restore the old instants without the schedule being expanded again. `pm clear`
  // leaves nothing to survive or restore: every alarm read afterwards was computed from the
  // schedule row, in the new zone, on this launch. That is the only reading that can distinguish
  // the rule from the platform's memory of the last answer.
  const zoneBefore = deviceTimeZone();
  const travelBeforeDump = alarmDump();
  const travelBefore = pendingAlarmsFor(travelBeforeDump.text, PACKAGE);

  process.stdout.write(`Moving the device out of ${zoneBefore}...
`);
  adb(['shell', 'pm', 'clear', PACKAGE]);
  sleep(3_000);
  const zoneAfter = setDeviceTimeZone(
    zoneBefore === TRAVEL_ZONE ? FALLBACK_TRAVEL_ZONE : TRAVEL_ZONE,
  );
  grantNotifications();
  launch();
  sleep(45_000);

  const travelAfterDump = alarmDump();
  checks.push(
    timeZoneShiftCheck({
      before: travelBefore,
      after: pendingAlarmsFor(travelAfterDump.text, PACKAGE),
      zoneBefore,
      zoneAfter,
      available: travelBeforeDump.available && travelAfterDump.available,
    }),
  );

  // Put the device back where it was, whatever the check said. A harness that leaves a device in
  // another zone makes the next run's readings mean something different.
  setDeviceTimeZone(zoneBefore);

  // ---- Device restart -----------------------------------------------------
  // A second dose, so there is something pending to survive the reboot.
  const second = await createTestSchedule(LEAD_SECONDS);
  if (second.ok) {
    launch();
    sleep(40_000);
    const beforeReboot = heldAlarms();
    // Killed, not force-stopped: a force-stop here would cancel the alarms before the reboot and
    // the check would then measure nothing at all.
    killProcess();

    process.stdout.write('Rebooting the device...\n');
    adb(['reboot']);
    sleep(15_000);
    const booted = waitForBoot(300_000);

    if (!booted) {
      checks.push({
        id: 'REM-5',
        title: 'Reminders come back after the device restarts, without the app being opened',
        status: 'INCONCLUSIVE',
        detail: 'The device did not finish booting within five minutes.',
      });
    } else {
      // Deliberately not launched. An app the person has to open before their reminders come back
      // is an app whose reminders do not survive a restart.
      process.stdout.write('Waiting for the boot receiver to restore the alarms...\n');
      const afterReboot = waitForAlarmRestore(REBOOT_RESTORE_TIMEOUT_MS);
      checks.push(
        rebootRecoveryCheck(
          afterReboot.count,
          beforeReboot.count,
          afterReboot.available,
          afterReboot.waitedMs,
        ),
      );
    }
  } else {
    checks.push({
      id: 'REM-5',
      title: 'Reminders come back after the device restarts, without the app being opened',
      status: 'INCONCLUSIVE',
      detail: `A second dose could not be scheduled: ${second.detail}`,
    });
  }

  // The reverse tunnel does not survive a reboot, and the cleanup needs the API.
  adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(API_PORT)}`]);
  adb(['reverse', `tcp:8081`, `tcp:8081`]);
  await stopTestSchedules();

  process.stdout.write(`${formatReminderReport(checks)}\n`);
  process.exitCode = remindersOverall(checks) === 'PASS' ? 0 : 1;
}

void main();
