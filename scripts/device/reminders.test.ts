import { describe, it, expect } from 'vitest';
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
} from './reminders.js';

/**
 * The rules that decide whether a reminder run passed.
 *
 * Runnable with no device attached, which is the point of the split (DEC-102): every judgement
 * below is covered by `npm run verify`, and only the evidence needs an emulator. The rule that
 * matters most is the one about not looking - a check that reports success because it could not
 * read the dump is worse than no check, because somebody would stop looking themselves.
 */

const PACKAGE = 'com.kynviora.app';

/**
 * A real capture from a Pixel 7 emulator on API 36, trimmed to the records that matter.
 *
 * Kept verbatim rather than idealised, because the first version of the parser was written
 * against a `Batch{...standalone}` format this device does not print - it read every one of these
 * exact alarms as inexact, and would have failed a working engine. What this build prints is
 * `window=0` and `exactAllowReason=policy_permission` on the detail line, the latter being the
 * `USE_EXACT_ALARM` declaration being honoured.
 *
 * The Google Play Services record is the negative control and is left in on purpose: it is a
 * genuinely inexact alarm (`window=+1m20s0ms`, no `exactAllowReason`) belonging to another
 * package, so it exercises both the ownership filter and the exactness rule at once.
 */
const ALARM_DUMP = `
  57 pending alarms: 
    ELAPSED_WAKEUP #1: Alarm{3fc72d type 2 origWhen 42745525 whenElapsed 42745525 com.google.android.gms}
      tag=*walarm*:com.google.android.location.ALARM_WAKEUP_ACTIVITY_DETECTION
      type=ELAPSED_WAKEUP origWhen=-31s98ms window=+1m20s0ms repeatInterval=0 count=0 flags=0x0
      policyWhenElapsed: requester=-31s98ms app_standby=-4m29s191ms device_idle=-- battery_saver=--
    RTC_WAKEUP #2: Alarm{2ef432f type 0 origWhen 1788419520000 whenElapsed 42731645 com.kynviora.app}
      tag=*walarm*:expo.modules.notifications.NOTIFICATION_EVENT
      type=RTC_WAKEUP origWhen=2026-09-03 12:42:00.000 window=0 exactAllowReason=policy_permission repeatInterval=0 count=0 flags=0x5
      policyWhenElapsed: requester=+1m42s567ms app_standby=-54s377ms device_idle=-- battery_saver=--
      operation=PendingIntent{bb21d3c: PendingIntentRecord{826eac5 com.kynviora.app broadcastIntent}}
    RTC_WAKEUP #35: Alarm{d782c1a type 0 origWhen 1788505920000 whenElapsed 129131645 com.kynviora.app}
      tag=*walarm*:expo.modules.notifications.NOTIFICATION_EVENT
      type=RTC_WAKEUP origWhen=2026-09-04 12:42:00.000 window=0 exactAllowReason=policy_permission repeatInterval=0 count=0 flags=0x5
      operation=PendingIntent{fb6e34b: PendingIntentRecord{121d128 com.kynviora.app broadcastIntent}}
`;

describe('reading the alarms a device is holding', () => {
  it('finds the ones belonging to the package', () => {
    const alarms = pendingAlarmsFor(ALARM_DUMP, PACKAGE);
    // Two records, not four. The `operation=PendingIntent{... com.kynviora.app ...}` line names
    // the package as well, so a parser matching on the name alone counts every alarm twice - and
    // would then report that re-planning had duplicated them.
    expect(alarms).toHaveLength(2);
    expect(alarms.every((alarm) => alarm.tag.includes('expo.modules.notifications'))).toBe(true);
    expect(alarms.map((alarm) => alarm.when)).toEqual([
      '2026-09-03 12:42:00.000',
      '2026-09-04 12:42:00.000',
    ]);
  });

  it("ignores another app's alarms", () => {
    expect(pendingAlarmsFor(ALARM_DUMP, 'com.example.other')).toEqual([]);
  });

  it('reads a zero window as exact', () => {
    // An inexact alarm can be deferred by Doze for minutes or more. For a dose reminder that is
    // not the same feature, so it is measured on the device rather than assumed from the manifest.
    expect(pendingAlarmsFor(ALARM_DUMP, PACKAGE).every((alarm) => alarm.exact)).toBe(true);
  });

  it("reads another package's windowed alarm as not exact", () => {
    // The negative control, from the same real capture: a genuinely inexact alarm with no
    // `exactAllowReason`. Without one of these in the fixture, a parser that returned `exact:
    // true` unconditionally would pass every test above.
    const others = pendingAlarmsFor(ALARM_DUMP, 'com.google.android.gms');
    expect(others).toHaveLength(1);
    expect(others[0]?.exact).toBe(false);
  });

  it('still reads the older batch format, so a different build does not fail falsely', () => {
    const batched = `
  Batch{a9 num=4 start=+10m end=+25m}:
    RTC_WAKEUP #0: Alarm{bb type 0 com.kynviora.app}
`;
    expect(pendingAlarmsFor(batched, PACKAGE)[0]?.exact).toBe(false);
  });

  it('reads a standalone batch as exact, in that older format', () => {
    const standalone = `
  Batch{a1 num=1 start=+1m0s end=+1m0s standalone}:
    RTC_WAKEUP #0: Alarm{b1 type 0 com.kynviora.app standalone}
`;
    expect(pendingAlarmsFor(standalone, PACKAGE)[0]?.exact).toBe(true);
  });
});

describe('whether the device is holding what was planned', () => {
  const alarms = pendingAlarmsFor(ALARM_DUMP, PACKAGE);

  it('passes when at least as many are held as expected', () => {
    expect(alarmsHeldCheck(alarms, 1, true).status).toBe('PASS');
  });

  it('does not demand an exact count', () => {
    // The platform may hold alarms this app did not schedule. Demanding a number would make the
    // check fail for a reason that has nothing to do with reminders.
    expect(alarmsHeldCheck([...alarms, ...alarms], 1, true).status).toBe('PASS');
  });

  it('fails when nothing was placed', () => {
    const check = alarmsHeldCheck([], 2, true);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/cannot fire/i);
  });

  it('is inconclusive when the dump could not be read', () => {
    expect(alarmsHeldCheck([], 2, false).status).toBe('INCONCLUSIVE');
  });
});

describe('whether the reminders are exact', () => {
  it('passes when every batch is standalone', () => {
    expect(exactAlarmCheck(pendingAlarmsFor(ALARM_DUMP, PACKAGE), true).status).toBe('PASS');
  });

  it('fails when one was coalesced', () => {
    const check = exactAlarmCheck(
      [{ exact: false, tag: 'x', when: '2026-09-03 12:42:00.000' }],
      true,
    );
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/Doze may defer/i);
  });

  it('is inconclusive with nothing to inspect, rather than vacuously passing', () => {
    expect(exactAlarmCheck([], true).status).toBe('INCONCLUSIVE');
  });
});

const NOTIFICATION_DUMP = `
  NotificationRecord(0x1: pkg=com.kynviora.app user=UserHandle{0} id=0 tag=null
    channel=medicine-reminders
    extras={
      android.title=String (Kynviora)
      android.text=String (Kynviora has a reminder for you.)
    }
  NotificationRecord(0x2: pkg=com.android.systemui user=UserHandle{0} id=1 tag=null
    extras={
      android.title=String (Charging)
      android.text=String (Synthetic Tablet A)
    }
`;

describe('reading what actually arrived', () => {
  it("finds the app's own notifications and nobody else's", () => {
    const posted = postedNotifications(NOTIFICATION_DUMP, PACKAGE);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.title).toBe('Kynviora');
    expect(posted[0]?.text).toBe('Kynviora has a reminder for you.');
  });

  it("does not attribute another package's text to this one", () => {
    // The system UI record in the fixture carries a medicine name on purpose. A parser that
    // scanned the whole dump would report a leak this app did not cause - and, worse, would make
    // somebody go looking in the wrong place.
    const posted = postedNotifications(NOTIFICATION_DUMP, PACKAGE);
    expect(posted.some((n) => n.text.includes('Synthetic Tablet A'))).toBe(false);
  });
});

describe('whether a reminder arrived', () => {
  it('passes when one was posted', () => {
    const posted = postedNotifications(NOTIFICATION_DUMP, PACKAGE);
    expect(reminderArrivedCheck(posted, true, 'after the app was killed', 'REM-3').status).toBe(
      'PASS',
    );
  });

  it('fails when none was', () => {
    expect(reminderArrivedCheck([], true, 'after the app was killed', 'REM-3').status).toBe('FAIL');
  });

  it('is inconclusive when the dump could not be read', () => {
    expect(reminderArrivedCheck([], false, 'after a reboot', 'REM-5').status).toBe('INCONCLUSIVE');
  });
});

describe('what reaches a lock screen', () => {
  const posted = postedNotifications(NOTIFICATION_DUMP, PACKAGE);
  const FORBIDDEN = ['Synthetic Tablet A', 'Development profile'];

  it('passes when nothing identifying is in the text', () => {
    // Phase 4.2's second exit criterion, measured against the strings the platform holds rather
    // than against the code that produced them.
    const check = lockScreenDisclosureCheck(posted, FORBIDDEN, true);
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('Kynviora has a reminder for you.');
  });

  it('fails when a medicine name is in the text', () => {
    const leaking = [
      {
        packageName: PACKAGE,
        title: 'Kynviora',
        text: 'Time for Synthetic Tablet A.',
        visibility: null,
      },
    ];
    const check = lockScreenDisclosureCheck(leaking, FORBIDDEN, true);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('Synthetic Tablet A');
  });

  it('matches whatever the case', () => {
    const leaking = [
      {
        packageName: PACKAGE,
        title: 'Kynviora',
        text: 'time for synthetic tablet a.',
        visibility: null,
      },
    ];
    expect(lockScreenDisclosureCheck(leaking, FORBIDDEN, true).status).toBe('FAIL');
  });

  it('is inconclusive when nothing was posted', () => {
    // "No medicine name was found" and "nothing was read" are the same output and must not be the
    // same verdict.
    expect(lockScreenDisclosureCheck([], FORBIDDEN, true).status).toBe('INCONCLUSIVE');
  });

  it('ignores a blank forbidden term rather than matching everything', () => {
    expect(lockScreenDisclosureCheck(posted, ['', '  '], true).status).toBe('PASS');
  });
});

describe('whether re-planning duplicates', () => {
  it('passes when the count did not grow', () => {
    expect(noDuplicateRemindersCheck(4, 4, true).status).toBe('PASS');
  });

  it('passes when doses passed and the count fell', () => {
    expect(noDuplicateRemindersCheck(4, 3, true).status).toBe('PASS');
  });

  it('fails when the app scheduled the same doses again', () => {
    const check = noDuplicateRemindersCheck(4, 8, true);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/same doses again/i);
  });
});

describe('whether reminders survive a restart', () => {
  it('passes when the boot receiver restored them', () => {
    const check = rebootRecoveryCheck(4, 4, true);
    expect(check.status).toBe('PASS');
    expect(check.detail).toMatch(/boot receiver/i);
  });

  it('fails when none came back', () => {
    const check = rebootRecoveryCheck(0, 4, true);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/stop at the first restart/i);
  });

  it('is inconclusive when there was nothing to restore', () => {
    // Zero before and zero after is not evidence of recovery, and calling it a pass would let a
    // completely broken engine report success.
    expect(rebootRecoveryCheck(0, 0, true).status).toBe('INCONCLUSIVE');
  });

  it('says how long the restore took', () => {
    // Not decoration. A run once read 0 alarms thirty seconds after `sys.boot_completed` flipped
    // and reported a working engine as broken; the same device held 28 a few minutes later with
    // the app still never launched. The number is what stops the next person re-deriving that,
    // and it is a real property: a dose due in the first minutes after a restart has nothing
    // holding an alarm for it.
    const check = rebootRecoveryCheck(28, 29, true, 132_000);
    expect(check.status).toBe('PASS');
    expect(check.detail).toMatch(/132s after boot/);
  });

  it('says nothing about timing when it was not measured', () => {
    expect(rebootRecoveryCheck(4, 4, true).detail).not.toMatch(/after boot/);
  });

  it('blames the time allowed rather than the app when nothing came back', () => {
    // The wording matters because the previous version's did not: "reminders stop at the first
    // restart" read as a finding about the engine when it was a finding about a 30-second sleep.
    expect(rebootRecoveryCheck(0, 4, true, 420_000).detail).toMatch(/within the time allowed/i);
  });
});

describe('the run verdict', () => {
  const pass = { id: 'A', title: 't', status: 'PASS' as const, detail: 'd' };
  const fail = { id: 'B', title: 't', status: 'FAIL' as const, detail: 'd' };
  const unknown = { id: 'C', title: 't', status: 'INCONCLUSIVE' as const, detail: 'd' };

  it('is a pass only when every check passed', () => {
    expect(remindersOverall([pass, pass])).toBe('PASS');
  });

  it('is not a pass when something could not be looked at', () => {
    expect(remindersOverall([pass, unknown])).toBe('INCONCLUSIVE');
  });

  it('reports a failure ahead of an inconclusive', () => {
    expect(remindersOverall([unknown, fail])).toBe('FAIL');
  });

  it('renders every check and the verdict', () => {
    const report = formatReminderReport([pass, fail]);
    expect(report).toContain('PASS');
    expect(report).toContain('FAIL');
    expect(report).toContain('Overall: FAIL');
  });
});

describe('whether the process actually died', () => {
  it('passes when nothing is running and the alarms survived', () => {
    const check = processDeathCheck({
      running: false,
      alarmsBefore: 28,
      alarmsAfter: 28,
      available: true,
    });
    expect(check.status).toBe('PASS');
  });

  it('is inconclusive when the app is still running', () => {
    // A delivery test after a kill that did not kill proves nothing, so this must never read as a
    // pass. `am kill` only kills processes it considers safe to kill, and a foreground activity is
    // not one of them.
    const check = processDeathCheck({
      running: true,
      alarmsBefore: 28,
      alarmsAfter: 28,
      available: true,
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toMatch(/press HOME first/i);
  });

  it('fails when the kill took the reminders with it', () => {
    // What `am force-stop` does, measured on this emulator: 28 alarms before, 0 after. The first
    // version of this harness used it and reported a working engine as broken.
    const check = processDeathCheck({
      running: false,
      alarmsBefore: 28,
      alarmsAfter: 0,
      available: true,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toMatch(/took the reminders with it/i);
  });

  it('is inconclusive when the dump could not be read', () => {
    expect(
      processDeathCheck({ running: false, alarmsBefore: 1, alarmsAfter: 1, available: false })
        .status,
    ).toBe('INCONCLUSIVE');
  });
});
