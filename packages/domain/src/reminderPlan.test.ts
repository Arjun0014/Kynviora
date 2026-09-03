import { describe, it, expect } from 'vitest';
import {
  CATEGORY_REMINDER_BODY,
  GENERIC_REMINDER_BODY,
  IDLE_SYNC_PASS,
  MAX_PLANNED_REMINDERS,
  REMINDER_HORIZON_DAYS,
  finishSyncPass,
  planReminders,
  reconcileReminders,
  reminderContent,
  reminderKey,
  requestSyncPass,
  type ReminderSubject,
} from './reminderPlan.js';
import { GENERIC_NOTIFICATION_TITLE } from './alertDelivery.js';
import type { MedicineSchedule } from './schedule.js';
import { calendarDate, instantFrom } from './ports.js';

/**
 * What a device is asked to schedule (`04` Phase 4.2).
 *
 * Phase 4.2's second exit criterion - "sensitive medicine names are not shown on lock screen by
 * default" - is decided entirely in this file, because `apps/**` is outside the test run. So is
 * the property that makes the first one measurable: a re-plan after a restart converges on what
 * the device already holds instead of doubling it.
 */

const IN = 'Asia/Kolkata'; // UTC+05:30, no DST.
const UK = 'Europe/London'; // has DST.

const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000a1';
const ITEM_ID = '00000000-0000-4000-8000-0000000000b1';

function schedule(overrides: Partial<MedicineSchedule> = {}): MedicineSchedule {
  return {
    id: SCHEDULE_ID,
    kind: 'FIXED_TIMES',
    timesLocal: ['08:00', '20:00'],
    daysOfWeek: null,
    timeZone: IN,
    startsOn: null,
    endsOn: null,
    active: true,
    directionsText: null,
    ...overrides,
  };
}

const SUBJECT: ReminderSubject = {
  ownedItemId: ITEM_ID,
  itemDisplayName: 'Synthetic Tablet',
  profileDisplayName: 'Parent A',
};

function subjects(...entries: readonly (readonly [string, ReminderSubject])[]) {
  return new Map(entries.length === 0 ? [[SCHEDULE_ID, SUBJECT] as const] : entries);
}

/** Just before 08:00 in Kolkata on 2 September 2026. */
const NOW = instantFrom('2026-09-02T02:00:00.000Z');

// ---------------------------------------------------------------------------

describe('what a reminder is allowed to say', () => {
  it('names nothing at all by default', () => {
    // Phase 4.2's second exit criterion. `GENERIC` is `DEFAULT_NOTIFICATION_DETAIL`, so this is
    // what a person who has changed no setting sees on a locked screen.
    const content = reminderContent('GENERIC', {
      itemDisplayName: 'Synthetic Tablet',
      profileDisplayName: 'Parent A',
    });
    expect(content.title).toBe(GENERIC_NOTIFICATION_TITLE);
    expect(content.body).toBe(GENERIC_REMINDER_BODY);
    expect(content.revealsSubject).toBe(false);
    expect(content.body).not.toContain('Synthetic Tablet');
    expect(content.body).not.toContain('Parent A');
  });

  it('names the kind of thing but nobody, one level up', () => {
    const content = reminderContent('CATEGORY', {
      itemDisplayName: 'Synthetic Tablet',
      profileDisplayName: 'Parent A',
    });
    expect(content.body).toBe(CATEGORY_REMINDER_BODY);
    expect(content.revealsSubject).toBe(false);
    expect(content.body).not.toContain('Synthetic Tablet');
  });

  it('names the medicine and the person only when asked to', () => {
    const content = reminderContent('NAMED', {
      itemDisplayName: 'Synthetic Tablet',
      profileDisplayName: 'Parent A',
    });
    expect(content.body).toBe('Time for Synthetic Tablet for Parent A.');
    expect(content.revealsSubject).toBe(true);
  });

  it('falls back rather than rendering a sentence with a hole in it', () => {
    // A name is only shown when there is one. "Time for  for ." is what a template does when the
    // value is missing, and it would be the first thing a person sees at the level they chose
    // precisely because they wanted to know which medicine.
    expect(reminderContent('NAMED', { itemDisplayName: null, profileDisplayName: null }).body).toBe(
      CATEGORY_REMINDER_BODY,
    );
    expect(
      reminderContent('NAMED', { itemDisplayName: null, profileDisplayName: 'Parent A' }).body,
    ).toBe('A scheduled dose for Parent A is due.');
  });

  it('never states a dose or an instruction at any level', () => {
    // `09`: Kynviora does not reinterpret a prescription instruction. A notification that said
    // "take two" would be doing exactly that, on a lock screen, with no way to check it.
    for (const level of ['GENERIC', 'CATEGORY', 'NAMED'] as const) {
      const body = reminderContent(level, {
        itemDisplayName: 'Synthetic Tablet',
        profileDisplayName: 'Parent A',
      }).body;
      expect(body).not.toMatch(/\btake (one|two|\d)/i);
      expect(body).not.toMatch(/\bmg\b/i);
      expect(body).not.toMatch(/tablet(s)? with/i);
    }
  });
});

describe('expanding a schedule into reminders', () => {
  it('plans every dose in the window, in time order', () => {
    const plan = planReminders({
      schedules: [schedule()],
      subjects: subjects(),
      now: NOW,
      detailLevel: 'GENERIC',
      horizonDays: 1,
    });

    // 08:00 IST on the 2nd is 02:30Z, which is after `now`; 20:00 is 14:30Z. Then the 3rd.
    expect(plan.map((r) => String(r.dueAt))).toEqual([
      '2026-09-02T02:30:00.000Z',
      '2026-09-02T14:30:00.000Z',
      '2026-09-03T02:30:00.000Z',
      '2026-09-03T14:30:00.000Z',
    ]);
    expect(plan.every((r) => r.ownedItemId === ITEM_ID)).toBe(true);
  });

  it('never plans a dose that has already arrived', () => {
    // A re-plan that scheduled the past would fire a burst of reminders for doses somebody has
    // taken. `18` calls that nagging, and it is what makes people turn reminders off.
    const justAfterEight = instantFrom('2026-09-02T02:30:00.000Z');
    const plan = planReminders({
      schedules: [schedule()],
      subjects: subjects(),
      now: justAfterEight,
      detailLevel: 'GENERIC',
      horizonDays: 0,
    });
    expect(plan.map((r) => r.localTime)).toEqual(['20:00']);
  });

  it('plans nothing for an as-needed medicine', () => {
    // `04` Phase 4.1 separates as-needed from fixed reminders. Something taken when it is needed
    // has no time for a reminder to fire at, and firing one is telling somebody to take a
    // medicine they have not decided they need.
    expect(
      planReminders({
        schedules: [schedule({ kind: 'AS_NEEDED', timesLocal: [] })],
        subjects: subjects(),
        now: NOW,
        detailLevel: 'GENERIC',
      }),
    ).toEqual([]);
  });

  it('plans nothing for a schedule somebody switched off', () => {
    expect(
      planReminders({
        schedules: [schedule({ active: false })],
        subjects: subjects(),
        now: NOW,
        detailLevel: 'GENERIC',
      }),
    ).toEqual([]);
  });

  it('respects the start and end of a course', () => {
    const plan = planReminders({
      schedules: [
        schedule({
          timesLocal: ['08:00'],
          startsOn: calendarDate('2026-09-04'),
          endsOn: calendarDate('2026-09-05'),
        }),
      ],
      subjects: subjects(),
      now: NOW,
      detailLevel: 'GENERIC',
      horizonDays: 10,
    });
    expect(plan.map((r) => r.localDate)).toEqual(['2026-09-04', '2026-09-05']);
  });

  it('plans only the selected days', () => {
    // 2026-09-02 is a Wednesday (ISO 3).
    const plan = planReminders({
      schedules: [schedule({ kind: 'SELECTED_DAYS', timesLocal: ['08:00'], daysOfWeek: [1, 3] })],
      subjects: subjects(),
      now: NOW,
      detailLevel: 'GENERIC',
      horizonDays: 6,
    });
    expect(plan.map((r) => r.localDate)).toEqual(['2026-09-02', '2026-09-07']);
  });

  it('expands from the schedules own zone, not the devices', () => {
    // A phone that had crossed a date line would otherwise drop the first day of a schedule
    // authored elsewhere - and the person would find out by not being reminded.
    const nearMidnightInLondon = instantFrom('2026-09-02T23:30:00.000Z');
    const plan = planReminders({
      schedules: [schedule({ timeZone: UK, timesLocal: ['08:00'] })],
      subjects: subjects(),
      now: nearMidnightInLondon,
      detailLevel: 'GENERIC',
      horizonDays: 0,
    });
    // 23:30Z is 00:30 on the 3rd in London, so the window opens on the 3rd and 08:00 is 07:00Z.
    expect(plan.map((r) => String(r.dueAt))).toEqual(['2026-09-03T07:00:00.000Z']);
  });

  it('keeps firing at the same wall-clock time across a daylight-saving change', () => {
    // The reason a plan is instants rather than a platform repeat rule. Britain leaves summer
    // time on 25 October 2026: 08:00 local is 07:00Z before and 08:00Z after.
    const plan = planReminders({
      schedules: [schedule({ timeZone: UK, timesLocal: ['08:00'] })],
      subjects: subjects(),
      now: instantFrom('2026-10-23T00:00:00.000Z'),
      detailLevel: 'GENERIC',
      horizonDays: 3,
    });
    expect(plan.map((r) => String(r.dueAt))).toEqual([
      '2026-10-23T07:00:00.000Z',
      '2026-10-24T07:00:00.000Z',
      '2026-10-25T08:00:00.000Z',
      '2026-10-26T08:00:00.000Z',
    ]);
    expect(plan.every((r) => r.localTime === '08:00')).toBe(true);
  });

  it('skips a schedule whose medicine the device does not know about', () => {
    // Rather than scheduling it anonymously. A reminder that cannot say which medicine it is
    // about - even to the app that opens when it is tapped - is one nobody can act on.
    expect(
      planReminders({
        schedules: [schedule()],
        subjects: new Map(),
        now: NOW,
        detailLevel: 'GENERIC',
      }),
    ).toEqual([]);
  });
});

describe('what the device is asked to hold is bounded', () => {
  it('stops at the limit', () => {
    const plan = planReminders({
      schedules: [schedule({ timesLocal: ['08:00'] })],
      subjects: subjects(),
      now: NOW,
      detailLevel: 'GENERIC',
      horizonDays: 90,
    });
    expect(plan).toHaveLength(MAX_PLANNED_REMINDERS);
  });

  it('takes the next doses across every medicine rather than exhausting one', () => {
    // The failure a per-schedule cap produces: a fortnight of the first medicine and nothing of
    // the second, invisible until the one that was dropped mattered.
    const second = '00000000-0000-4000-8000-0000000000a2';
    const secondItem = '00000000-0000-4000-8000-0000000000b2';
    const plan = planReminders({
      schedules: [
        schedule({ timesLocal: ['08:00'] }),
        schedule({ id: second, timesLocal: ['09:00'] }),
      ],
      subjects: subjects(
        [SCHEDULE_ID, SUBJECT] as const,
        [second, { ...SUBJECT, ownedItemId: secondItem }] as const,
      ),
      now: NOW,
      detailLevel: 'GENERIC',
      horizonDays: 90,
      limit: 4,
    });
    expect(plan.map((r) => r.localTime)).toEqual(['08:00', '09:00', '08:00', '09:00']);
    expect(new Set(plan.map((r) => r.ownedItemId)).size).toBe(2);
  });

  it('plans a fortnight by default, so an unopened app keeps working', () => {
    expect(REMINDER_HORIZON_DAYS).toBe(14);
  });

  it('plans nothing at all when asked for nothing', () => {
    expect(
      planReminders({
        schedules: [schedule()],
        subjects: subjects(),
        now: NOW,
        detailLevel: 'GENERIC',
        limit: 0,
      }),
    ).toEqual([]);
  });
});

describe('the identity one reminder is filed under', () => {
  it('is the same for the same dose every time it is planned', () => {
    const first = planReminders({
      schedules: [schedule()],
      subjects: subjects(),
      now: NOW,
      detailLevel: 'GENERIC',
      horizonDays: 2,
    });
    const again = planReminders({
      schedules: [schedule()],
      subjects: subjects(),
      now: NOW,
      detailLevel: 'GENERIC',
      horizonDays: 2,
    });
    expect(first.map((r) => r.key)).toEqual(again.map((r) => r.key));
  });

  it('does not collide across two doses however the parts run together', () => {
    // Length-prefixed rather than separated, for the reason `projectionKey` is: the last key in
    // this codebase built with a separator was truncated by the device's SQLite and every read
    // collided on one row.
    const keys = new Set([
      reminderKey('a', '2026-09-0308', ':00'),
      reminderKey('a', '2026-09-03', '08:00'),
      reminderKey('a2026-09-03', '08:00', ''),
    ]);
    expect(keys.size).toBe(3);
  });

  it('is unchanged when the disclosure level changes', () => {
    // Otherwise raising the level would cancel and re-add every reminder, and a process killed
    // between the two would leave the person with none.
    const generic = planReminders({
      schedules: [schedule()],
      subjects: subjects(),
      now: NOW,
      detailLevel: 'GENERIC',
      horizonDays: 1,
    });
    const named = planReminders({
      schedules: [schedule()],
      subjects: subjects(),
      now: NOW,
      detailLevel: 'NAMED',
      horizonDays: 1,
    });
    expect(generic.map((r) => r.key)).toEqual(named.map((r) => r.key));
    expect(generic[0]?.content.body).not.toBe(named[0]?.content.body);
  });
});

describe('reconciling a plan against what a device already holds', () => {
  const plan = planReminders({
    schedules: [schedule()],
    subjects: subjects(),
    now: NOW,
    detailLevel: 'GENERIC',
    horizonDays: 1,
  });

  it('adds everything when the device holds nothing', () => {
    const outcome = reconcileReminders([], plan);
    expect(outcome.toSchedule).toHaveLength(plan.length);
    expect(outcome.toCancel).toEqual([]);
  });

  it('changes nothing when the device already holds the plan', () => {
    // The property that makes a restart safe. Re-planning on every launch must converge, or a
    // person who opens the app twice a day accumulates duplicate reminders for every dose.
    const held = plan.map((reminder) => ({ key: reminder.key }));
    const outcome = reconcileReminders(held, plan);
    expect(outcome.toSchedule).toEqual([]);
    expect(outcome.toCancel).toEqual([]);
    expect(outcome.unchanged).toHaveLength(plan.length);
  });

  it('leaves the reminders that are still correct in place', () => {
    // Rather than cancelling everything and rescheduling. Between those two calls the device
    // holds no reminders at all, and a process killed in that window leaves a person with none -
    // silently, which is the failure Phase 4.2 measures.
    const held = plan.slice(0, 2).map((reminder) => ({ key: reminder.key }));
    const outcome = reconcileReminders(held, plan);
    expect(outcome.unchanged).toHaveLength(2);
    expect(outcome.toSchedule).toHaveLength(plan.length - 2);
    expect(outcome.toCancel).toEqual([]);
  });

  it('cancels a dose the plan no longer wants', () => {
    const held = [...plan.map((r) => ({ key: r.key })), { key: 'a-dose-that-was-moved' }];
    const outcome = reconcileReminders(held, plan);
    expect(outcome.toCancel).toEqual(['a-dose-that-was-moved']);
  });

  it('cancels every reminder when a schedule is switched off', () => {
    const held = plan.map((reminder) => ({ key: reminder.key }));
    const outcome = reconcileReminders(held, []);
    expect(outcome.toCancel).toHaveLength(plan.length);
    expect(outcome.toSchedule).toEqual([]);
  });
});

/**
 * The rule that decides whether a reconciliation runs at all (`04` Phase 4.2).
 *
 * These are regression tests for a defect that was measured on a device rather than reasoned
 * about: a cold launch held 0 alarms with an active schedule, three times running, because the
 * only request that carried the complete set of inputs was refused by a guard and never retried.
 */
describe('the sync pass gate', () => {
  it('lets the first request start', () => {
    const asked = requestSyncPass(IDLE_SYNC_PASS);
    expect(asked.start).toBe(true);
    expect(asked.gate.running).toBe(true);
    expect(asked.gate.deferred).toBe(false);
  });

  it('does not start a second request while one is running', () => {
    // The thing the original guard was right about. Two overlapping reconciliations read the same
    // held set, and each schedules what the other has not yet placed.
    const first = requestSyncPass(IDLE_SYNC_PASS);
    const second = requestSyncPass(first.gate);
    expect(second.start).toBe(false);
  });

  it('defers that second request rather than dropping it', () => {
    // The defect. A request refused while another is in flight was computed from inputs that have
    // since moved, so it is the one that matters - and it was thrown away.
    const first = requestSyncPass(IDLE_SYNC_PASS);
    const second = requestSyncPass(first.gate);
    expect(second.gate.deferred).toBe(true);
    expect(finishSyncPass(second.gate).rerun).toBe(true);
  });

  it('asks for no re-run when nothing arrived while it was working', () => {
    const first = requestSyncPass(IDLE_SYNC_PASS);
    const done = finishSyncPass(first.gate);
    expect(done.rerun).toBe(false);
    expect(done.gate).toEqual(IDLE_SYNC_PASS);
  });

  it('collapses any number of deferred requests into one re-run', () => {
    // Three inputs arriving in three renders must not cost three reconciliations: by the time the
    // re-run happens they would all read the same state, and each extra pass is a full read of
    // what the device holds plus a write of the difference.
    let gate = requestSyncPass(IDLE_SYNC_PASS).gate;
    for (let i = 0; i < 5; i += 1) gate = requestSyncPass(gate).gate;
    const done = finishSyncPass(gate);
    expect(done.rerun).toBe(true);
    expect(done.gate).toEqual(IDLE_SYNC_PASS);
  });

  it('releases the gate even when the run it was holding failed', () => {
    // Called from a `finally`. A reconciliation that threw and left `running` true would refuse
    // every later one for the life of the process - the original defect, made permanent.
    const first = requestSyncPass(IDLE_SYNC_PASS);
    expect(finishSyncPass(first.gate).gate.running).toBe(false);
    expect(requestSyncPass(finishSyncPass(first.gate).gate).start).toBe(true);
  });

  it('runs the deferred request and then settles, rather than re-running forever', () => {
    // The re-run is a single pass. A gate that re-armed itself would reconcile in a loop, which on
    // a device is a wake-up every few hundred milliseconds.
    const first = requestSyncPass(IDLE_SYNC_PASS);
    const deferred = requestSyncPass(first.gate);
    const done = finishSyncPass(deferred.gate);
    expect(done.rerun).toBe(true);

    const rerun = requestSyncPass(done.gate);
    expect(rerun.start).toBe(true);
    expect(finishSyncPass(rerun.gate).rerun).toBe(false);
  });
});
