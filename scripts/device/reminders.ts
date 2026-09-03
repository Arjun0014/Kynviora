/**
 * What a device has to show before "reminders are reliable" may be claimed.
 *
 * Spec references: `04` Phase 4.2 exit criteria - "reminder reliability is measured across process
 * death and device restart scenarios" and "sensitive medicine names are not shown on lock screen
 * by default" - plus `15` A6, `18`, `19` (device E2E), `12`.
 *
 * WHY THE JUDGEMENTS LIVE HERE AND THE DEVICE WORK DOES NOT
 * `verifyReminders.ts` runs `adb`; this file decides what its output means. Split that way, every
 * rule below is exercised by `reminders.test.ts` on a machine with no emulator attached, so the
 * checks are covered by `npm run verify` and only the evidence needs hardware (DEC-102).
 *
 * WHY THERE IS AN INCONCLUSIVE RESULT
 * The same reason the storage harness has one. A `dumpsys` that could not be read is not a pass,
 * and the most dangerous shape for a reliability check is one that reports success when it could
 * not look. {@link remindersOverall} refuses to call a run successful with an inconclusive check.
 */

export type CheckStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** What was actually observed. Never a restatement of the title. */
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

export interface PendingAlarm {
  /** `true` where the row shows an exact wake-up rather than a windowed one. */
  readonly exact: boolean;
  /** The alarm's tag, which is what says who scheduled it and for what. */
  readonly tag: string;
  /** The `origWhen` line as printed, so a failure can name the time it was looking at. */
  readonly when: string;
}

/**
 * The alarms `dumpsys alarm` says are pending for a package.
 *
 * Parsed rather than counted with `grep`, because the two things worth knowing are on different
 * lines: that an alarm exists at all, and whether it is exact. An inexact alarm can be deferred by
 * Doze for minutes or more, which for a dose reminder is not the same feature.
 *
 * WHAT AN ALARM RECORD ACTUALLY LOOKS LIKE
 * The first version of this read `Batch{...standalone}` headers, which is a real format and not
 * the one an API 36 emulator prints. What it prints is a header line naming the package, followed
 * by indented detail lines:
 *
 *     RTC_WAKEUP #2: Alarm{2ef432f type 0 origWhen 1788419520000 ... com.kynviora.app}
 *       tag=*walarm*:expo.modules.notifications.NOTIFICATION_EVENT
 *       type=RTC_WAKEUP origWhen=2026-09-03 12:42:00.000 window=0 exactAllowReason=policy_permission
 *
 * So exactness is `window=0` on the detail line, and the reason the platform allowed it is
 * `exactAllowReason` - which on this build reads `policy_permission`, the `USE_EXACT_ALARM`
 * declaration being honoured. Reading the batch header instead would have reported every one of
 * these as inexact, and the harness would have failed a working engine.
 */
export function pendingAlarmsFor(dump: string, packageName: string): readonly PendingAlarm[] {
  const alarms: PendingAlarm[] = [];
  const lines = dump.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index] ?? '';
    // A record header: a wake-up kind, an index, and an `Alarm{...}` whose braces carry the
    // package. Matching on the package alone would also catch the `operation=PendingIntent{...}`
    // line of the same record and count it twice.
    if (!/^\s*\w+ #\d+: Alarm\{/.test(header)) continue;
    if (!header.includes(packageName)) continue;

    let tag = '';
    let exact = false;
    let when = '';

    for (let detail = index + 1; detail < lines.length; detail += 1) {
      const line = lines[detail] ?? '';
      // The next record starts here, or the section ends.
      if (/^\s*\w+ #\d+: Alarm\{/.test(line) || /^\S/.test(line)) break;

      const tagMatch = /\btag=(\S+)/.exec(line);
      if (tagMatch !== null) tag = tagMatch[1] ?? '';

      const windowMatch = /\bwindow=(\d+)/.exec(line);
      if (windowMatch !== null && windowMatch[1] === '0') exact = true;
      if (/\bexactAllowReason=(?!--)\S+/.test(line)) exact = true;

      const whenMatch = /\borigWhen=([\d-]+ [\d:.]+)/.exec(line);
      if (whenMatch !== null) when = whenMatch[1] ?? '';
    }

    // The older format, kept because it is the one some builds print and because a harness that
    // only understood one device is a harness that reports a false failure on the next one.
    if (!exact && /standalone/.test(header)) exact = true;

    alarms.push({ exact, tag, when });
  }
  return alarms;
}

/**
 * Whether the device is holding at least `expected` reminders for the package.
 *
 * A count rather than an exact match: the platform may hold alarms this app did not schedule -
 * a work manager job, a job scheduler wake-up - and demanding an exact number would make the
 * check fail for a reason that has nothing to do with reminders.
 */
export function alarmsHeldCheck(
  alarms: readonly PendingAlarm[],
  expected: number,
  available: boolean,
): Check {
  if (!available) {
    return {
      id: 'REM-1',
      title: 'The device is holding the reminders the app planned',
      status: 'INCONCLUSIVE',
      detail: 'The alarm dump could not be read, so nothing about pending alarms was observed.',
    };
  }
  const held = alarms.length;
  return {
    id: 'REM-1',
    title: 'The device is holding the reminders the app planned',
    status: held >= expected ? 'PASS' : 'FAIL',
    detail:
      held >= expected
        ? `${String(held)} pending alarm(s) for the package, at least ${String(expected)} expected.`
        : `${String(held)} pending alarm(s) for the package, ${String(expected)} expected. A reminder that was never placed cannot fire.`,
  };
}

/**
 * Whether the reminders are exact.
 *
 * `USE_EXACT_ALARM` is declared precisely so they are. Without it Android 12+ falls back to
 * `setAndAllowWhileIdle`, which Doze may defer - and a dose reminder that arrives whenever the
 * system next feels like waking up is not the feature this phase describes. Reported as its own
 * check rather than folded into the previous one, because "no reminders" and "reminders that may
 * be late" are different failures with different fixes.
 */
export function exactAlarmCheck(alarms: readonly PendingAlarm[], available: boolean): Check {
  if (!available || alarms.length === 0) {
    return {
      id: 'REM-2',
      title: 'The reminders are exact rather than deferrable',
      status: 'INCONCLUSIVE',
      detail: available
        ? 'No pending alarm was found to inspect.'
        : 'The alarm dump could not be read.',
    };
  }
  const inexact = alarms.filter((alarm) => !alarm.exact);
  return {
    id: 'REM-2',
    title: 'The reminders are exact rather than deferrable',
    status: inexact.length === 0 ? 'PASS' : 'FAIL',
    detail:
      inexact.length === 0
        ? `All ${String(alarms.length)} pending alarm(s) are standalone wake-ups.`
        : `${String(inexact.length)} of ${String(alarms.length)} pending alarm(s) were batched, so Doze may defer them.`,
  };
}

// ---------------------------------------------------------------------------
// What actually arrived
// ---------------------------------------------------------------------------

export interface PostedNotification {
  readonly packageName: string;
  readonly title: string;
  readonly text: string;
  /** The Android visibility the channel asked for, where the dump reported one. */
  readonly visibility: string | null;
}

/**
 * The notifications `dumpsys notification --noredact` says are posted.
 *
 * `--noredact` matters: without it the dump prints the length of the text rather than the text,
 * and the check that matters most here is about the text. Using the redacted form would make the
 * disclosure check pass by being unable to read what it was judging.
 */
export function postedNotifications(
  dump: string,
  packageName: string,
): readonly PostedNotification[] {
  const posted: PostedNotification[] = [];
  // Records are separated by `NotificationRecord(` headers; each carries `pkg=<name>` and, further
  // down, `android.title=String (...)` and `android.text=String (...)`.
  const records = dump.split(/NotificationRecord\(/).slice(1);

  for (const record of records) {
    const pkg = /pkg=([\w.]+)/.exec(record)?.[1] ?? '';
    if (pkg !== packageName) continue;

    posted.push({
      packageName: pkg,
      title: extractExtra(record, 'android.title'),
      text: extractExtra(record, 'android.text'),
      visibility: /mVisibilityOverride|visibility=(-?\w+)/.exec(record)?.[1] ?? null,
    });
  }
  return posted;
}

/**
 * One `android.*` extra out of a notification record.
 *
 * The dump renders a string extra as `android.title=String (Kynviora)`. A `String (...)` wrapper
 * with no closing parenthesis on the same line means the value was truncated by the dump, which
 * is returned as the empty string rather than as a partial - a truncated body that happened to
 * cut before a medicine name would otherwise read as a notification that did not contain one.
 */
function extractExtra(record: string, key: string): string {
  const escaped = key.replace(/\./g, '\\.');
  const match = new RegExp(`${escaped}=String \\(([^\\n]*?)\\)\\s*(?:\\r?\\n|$)`).exec(record);
  return match?.[1] ?? '';
}

/**
 * Whether the process actually died, and whether the reminders survived it.
 *
 * The precondition for the delivery test meaning anything, and it exists because the first version
 * of this harness got it wrong in both directions at once. It used `am force-stop`, which on
 * Android is the "Force stop" button in system settings: it puts the app in the stopped state and
 * **cancels every alarm it had registered**. Measured on this emulator: 28 pending alarms before,
 * 0 after. The delivery check then failed, and it was measuring force-stop semantics rather than a
 * reminder engine.
 *
 * `am kill` is process death - `pidof` returns nothing and the alarm table is untouched - which is
 * what the system does under memory pressure and what a person does by swiping the app away. Both
 * halves are asserted here because each without the other is worthless: a kill that did not kill
 * makes the delivery test prove nothing, and a kill that took the alarms with it makes it fail for
 * a reason that is not about reliability.
 */
export function processDeathCheck(input: {
  readonly running: boolean;
  readonly alarmsBefore: number;
  readonly alarmsAfter: number;
  readonly available: boolean;
}): Check {
  const id = 'REM-3a';
  const title = 'The process is gone and the reminders it placed are still pending';

  if (!input.available) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The alarm dump could not be read.' };
  }
  if (input.running) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The app still has a running process, so anything that arrives next says nothing about ' +
        'surviving process death. `am kill` only kills processes it considers safe to kill, and a ' +
        'foreground activity is not one of them - press HOME first.',
    };
  }
  if (input.alarmsAfter < input.alarmsBefore) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `${String(input.alarmsBefore)} pending alarm(s) before the kill and ` +
        `${String(input.alarmsAfter)} after: the kill took the reminders with it.`,
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      `No process for the package, and ${String(input.alarmsAfter)} pending alarm(s) survived ` +
      `(${String(input.alarmsBefore)} before).`,
  };
}

/**
 * Whether a reminder arrived at all.
 *
 * The single most important observation in this file, because it is the one that cannot be
 * inferred from code: the process was killed, nothing was running, and the notification appeared.
 */
export function reminderArrivedCheck(
  posted: readonly PostedNotification[],
  available: boolean,
  scenario: string,
  id: string,
): Check {
  if (!available) {
    return {
      id,
      title: `A reminder arrives ${scenario}`,
      status: 'INCONCLUSIVE',
      detail: 'The notification dump could not be read, so nothing about delivery was observed.',
    };
  }
  return {
    id,
    title: `A reminder arrives ${scenario}`,
    status: posted.length > 0 ? 'PASS' : 'FAIL',
    detail:
      posted.length > 0
        ? `${String(posted.length)} notification(s) posted by the app ${scenario}.`
        : `No notification was posted by the app ${scenario}.`,
  };
}

/**
 * Whether what arrived names a medicine or a person.
 *
 * Phase 4.2's second exit criterion, measured against the strings the platform actually holds
 * rather than against the code that produced them. The forbidden values are passed in because
 * they are the fixture's, and a hard-coded list would pass on a device seeded differently.
 *
 * An empty dump is inconclusive, not a pass: "no medicine name was found" and "nothing was read"
 * are the same output and must not be the same verdict.
 */
export function lockScreenDisclosureCheck(
  posted: readonly PostedNotification[],
  forbidden: readonly string[],
  available: boolean,
): Check {
  const id = 'REM-4';
  const title = 'Nothing identifying reaches the lock screen by default';

  if (!available || posted.length === 0) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: available
        ? 'No notification was posted, so there was no text to judge.'
        : 'The notification dump could not be read.',
    };
  }

  const leaked: string[] = [];
  for (const notification of posted) {
    const haystack = `${notification.title} ${notification.text}`.toLowerCase();
    for (const term of forbidden) {
      const needle = term.trim().toLowerCase();
      if (needle.length > 0 && haystack.includes(needle)) leaked.push(term);
    }
  }

  return {
    id,
    title,
    status: leaked.length === 0 ? 'PASS' : 'FAIL',
    detail:
      leaked.length === 0
        ? `${String(posted.length)} notification(s) checked; none contained a medicine or profile name. Text seen: ${posted
            .map((n) => `"${n.title}" / "${n.text}"`)
            .join('; ')}`
        : `A notification contained: ${[...new Set(leaked)].join(', ')}.`,
  };
}

/**
 * Whether re-planning produced duplicates.
 *
 * The property that makes re-planning on every launch safe. Two reminders for one dose is not a
 * cosmetic bug: being told twice, at the same minute, to take the same tablet is how somebody
 * takes two.
 */
export function noDuplicateRemindersCheck(
  before: number,
  after: number,
  available: boolean,
): Check {
  const id = 'REM-6';
  const title = 'Re-planning converges rather than doubling the reminders';
  if (!available) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The alarm dump could not be read.' };
  }
  return {
    id,
    title,
    status: after <= before ? 'PASS' : 'FAIL',
    detail:
      after <= before
        ? `${String(before)} pending alarm(s) before a relaunch, ${String(after)} after.`
        : `${String(before)} pending alarm(s) before a relaunch and ${String(after)} after: the app scheduled the same doses again.`,
  };
}

/**
 * Whether the reminders survived a reboot.
 *
 * `04` Phase 4.2 says "restart/reboot recovery **as platform allows**", and what the platform
 * allows is a boot receiver: Android drops every alarm on reboot, and `expo-notifications`
 * re-registers them from its own store when `BOOT_COMPLETED` arrives. This measures whether that
 * actually happened on this device, with the app never opened after the reboot - because an app
 * the person has to launch before their reminders come back is an app whose reminders do not
 * survive a restart.
 */
export function rebootRecoveryCheck(
  heldAfterReboot: number,
  heldBeforeReboot: number,
  available: boolean,
  waitedMs?: number,
): Check {
  const id = 'REM-5';
  const title = 'Reminders come back after the device restarts, without the app being opened';
  if (!available) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The alarm dump could not be read.' };
  }
  if (heldBeforeReboot === 0) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'Nothing was pending before the reboot, so there was nothing to restore.',
    };
  }
  const took =
    waitedMs === undefined ? '' : ` It took ${String(Math.round(waitedMs / 1000))}s after boot.`;
  return {
    id,
    title,
    status: heldAfterReboot > 0 ? 'PASS' : 'FAIL',
    detail:
      heldAfterReboot > 0
        ? `${String(heldAfterReboot)} of ${String(heldBeforeReboot)} pending alarm(s) were restored by the boot receiver.${took}`
        : `None of the ${String(heldBeforeReboot)} pending alarm(s) came back within the time allowed. Reminders stop at the first restart.`,
  };
}

/**
 * The run's verdict.
 *
 * An inconclusive check is not a pass. A harness that reported success when it could not look is
 * worse than no harness, because somebody would stop looking themselves.
 */
export function remindersOverall(checks: readonly Check[]): CheckStatus {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'PASS';
}

/** The report, as text a person can paste into a document. */
export function formatReminderReport(checks: readonly Check[]): string {
  const lines = checks.map(
    (check) =>
      `${check.status.padEnd(12)} ${check.id}  ${check.title}\n${' '.repeat(14)}${check.detail}`,
  );
  return `${lines.join('\n\n')}\n\nOverall: ${remindersOverall(checks)}`;
}
