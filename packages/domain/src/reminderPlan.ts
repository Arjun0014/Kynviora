/**
 * What a device should schedule, so a person is reminded to take a medicine.
 *
 * Spec references: `04` Phase 4.2 (local notification scheduling, restart/reboot recovery,
 * permission handling, generic lock-screen default, quiet-hour behaviour "where appropriate";
 * exit criteria: reliability measured across process death and device restart, and no sensitive
 * medicine name on the lock screen by default), `15` A6 (a notification leaking health
 * information to a lock screen), `18` (no nagging, no shaming), `12` (bounded memory on device),
 * `09` (Kynviora does not reinterpret a prescription instruction).
 *
 * WHY THE PLAN IS A PURE FUNCTION AND THE PLATFORM IS NOT
 * Everything that decides *what a person sees and when* is here, where it is tested without a
 * device: which occurrences are in range, how many the platform may hold, what the text says at
 * each disclosure level, and what identity each reminder is filed under. `apps/**` is outside the
 * test run, so a rule that lived there would be a rule nothing checks - and the rule at stake is
 * whether a medicine name reaches a locked screen. The mobile side is left with three verbs:
 * ask permission, cancel everything, schedule this list.
 *
 * WHY IT PLANS ABSOLUTE INSTANTS RATHER THAN A REPEATING RULE
 * A platform repeat ("every day at 08:00") is evaluated by the operating system against the
 * device's current zone, so a person who flies to another country would be woken by a dose that
 * had silently moved. The schedule stores a wall-clock time plus an IANA zone (`04` Phase 4.1),
 * and this expands it into instants in that zone. The cost is that the list has to be rebuilt
 * periodically; the benefit is that the dose stays where the person put it.
 *
 * WHY QUIET HOURS DO NOT HOLD A DOSE REMINDER
 * `04` Phase 4.2 asks for quiet-hour behaviour "where appropriate", and this is the case where it
 * is not. Quiet hours exist so Kynviora does not wake somebody for something *Kynviora* decided
 * to say - a safety alert, a missed-dose nudge to a caregiver (`04` Phase 7.5, DEC-078). A dose
 * reminder is not Kynviora interrupting: it is the person's own alarm, at a time they typed, on
 * a medicine they take. Holding an 22:00 dose until 07:00 because the window says so would move
 * the dose - which is the one thing this whole stage refuses to do - and would do it silently, on
 * the night they were relying on it. So there is no quiet-hours parameter on {@link planReminders}
 * and there must not be one; what quiet hours govern is documented on the settings screen that
 * sets them.
 */

import type { CalendarDate, Instant } from './ports.js';
import { GENERIC_NOTIFICATION_TITLE, type NotificationDetailLevel } from './alertDelivery.js';
import { addDays, localDateIn, occurrencesOn, type MedicineSchedule } from './schedule.js';

/**
 * How far ahead a device plans.
 *
 * Long enough that a phone which never opens the app for a fortnight still fires its reminders,
 * short enough that a schedule edited today is not competing with a month of stale alarms. The
 * app re-plans on every launch and after every schedule change, so this is the floor on how long
 * an unopened app keeps working, not the interval between plans.
 */
export const REMINDER_HORIZON_DAYS = 14;

/**
 * The most reminders a device is asked to hold.
 *
 * Android's alarm scheduling degrades well before this becomes a memory question, and `12`
 * requires bounded memory on device regardless. The bound is applied to the merged, time-ordered
 * list rather than per schedule, so a person with six medicines gets the next N doses across all
 * of them rather than a fortnight of the first one and nothing of the rest - which is the failure
 * a per-schedule cap produces, and it is invisible until the medicine that was dropped mattered.
 */
export const MAX_PLANNED_REMINDERS = 64;

/** What a reminder says, at each disclosure level. */
export interface ReminderContent {
  readonly title: string;
  readonly body: string;
  /** Carried explicitly so a test can assert the negative directly (`alertDelivery.ts`'s rule). */
  readonly revealsSubject: boolean;
}

/**
 * A dose reminder that names nothing.
 *
 * The default, and the reason Phase 4.2's second exit criterion holds by construction rather than
 * by a setting somebody remembered to leave alone. It says a reminder exists and stops there: no
 * medicine, no person, no dose, no condition. `15` A6 is a notification leaking health
 * information to a lock screen, and this is the string that makes the default case safe.
 */
export const GENERIC_REMINDER_BODY = 'Kynviora has a reminder for you.';

/** The kind of thing, still naming nobody and nothing. */
export const CATEGORY_REMINDER_BODY = 'A scheduled dose is due.';

/**
 * What one reminder says at a given level.
 *
 * Total over the level, and the exhaustiveness is checked: a level added later must state its own
 * disclosure rule here rather than inheriting whichever branch happened to be last. There is no
 * dose or instruction in any branch - `09` forbids Kynviora restating a prescriber's instruction,
 * and a notification that said "take two" would be doing exactly that on a lock screen.
 */
export function reminderContent(
  level: NotificationDetailLevel,
  subject: { readonly itemDisplayName: string | null; readonly profileDisplayName: string | null },
): ReminderContent {
  switch (level) {
    case 'GENERIC':
      return {
        title: GENERIC_NOTIFICATION_TITLE,
        body: GENERIC_REMINDER_BODY,
        revealsSubject: false,
      };
    case 'CATEGORY':
      return {
        title: GENERIC_NOTIFICATION_TITLE,
        body: CATEGORY_REMINDER_BODY,
        revealsSubject: false,
      };
    case 'NAMED': {
      // A name is only shown when there is one. Falling back to the category wording rather than
      // to a blank keeps the promise the level makes: it never renders "Time for  for ."
      if (subject.itemDisplayName === null) {
        return {
          title: GENERIC_NOTIFICATION_TITLE,
          body:
            subject.profileDisplayName === null
              ? CATEGORY_REMINDER_BODY
              : `A scheduled dose for ${subject.profileDisplayName} is due.`,
          revealsSubject: subject.profileDisplayName !== null,
        };
      }
      return {
        title: GENERIC_NOTIFICATION_TITLE,
        body:
          subject.profileDisplayName === null
            ? `Time for ${subject.itemDisplayName}.`
            : `Time for ${subject.itemDisplayName} for ${subject.profileDisplayName}.`,
        revealsSubject: true,
      };
    }
  }
}

/** One reminder a device is asked to schedule. */
export interface PlannedReminder {
  /** Stable across re-plans, so the same dose is not scheduled twice. See {@link reminderKey}. */
  readonly key: string;
  readonly scheduleId: string;
  readonly ownedItemId: string;
  readonly dueAt: Instant;
  /** The local date and time as authored, so a screen can show what the person entered. */
  readonly localDate: CalendarDate;
  readonly localTime: string;
  readonly content: ReminderContent;
}

/**
 * The identity one dose reminder is filed under.
 *
 * Length-prefixed rather than separated, for the reason `projectionKey` is: a separator is only
 * unambiguous if every store on the way keeps it, and the last time a key in this codebase was
 * built with a NUL the device's SQLite truncated it and every read collided on one row.
 *
 * **Every variable part carries its own length, not just the first.** Prefixing only the schedule
 * ID left the other boundary open, and a test found the collision immediately: the date
 * `2026-09-0308` with the time `:00` produces the same string as `2026-09-03` with `08:00`. Those
 * two are not reachable from a validated schedule - a date is always ten characters and a time
 * always five - but "the callers happen to be well-formed" is not a property of the key, and it
 * is the assumption every collision of this kind was built on.
 *
 * Deterministic on purpose. A re-plan computes the same key for the same dose, so cancelling by
 * key and rescheduling is idempotent - and after a restart the device can tell a reminder it
 * already holds from one it has not scheduled yet, which is what makes recovery not duplicate
 * everything (Phase 4.2's first exit criterion, on the restart half).
 */
export function reminderKey(scheduleId: string, localDate: string, localTime: string): string {
  return `${String(scheduleId.length)}:${scheduleId}${String(localDate.length)}:${localDate}${localTime}`;
}

export interface ReminderSubject {
  readonly ownedItemId: string;
  readonly itemDisplayName: string | null;
  readonly profileDisplayName: string | null;
}

export interface ReminderPlanInput {
  /** Every schedule the device knows about. Inactive and as-needed ones plan nothing. */
  readonly schedules: readonly MedicineSchedule[];
  /** Which medicine each schedule belongs to, and what may be named at `NAMED`. */
  readonly subjects: ReadonlyMap<string, ReminderSubject>;
  /** Now. Reminders at or before it are past and are never scheduled. */
  readonly now: Instant;
  /** The person's answer about what may appear on a lock screen. `GENERIC` is the default. */
  readonly detailLevel: NotificationDetailLevel;
  readonly horizonDays?: number;
  readonly limit?: number;
}

/**
 * Expand every active schedule into the reminders a device should hold.
 *
 * Deterministic: the same input always produces the same list in the same order, which is what
 * makes a re-plan after a restart converge on what is already scheduled instead of doubling it.
 *
 * A dose exactly at `now` is treated as past. Firing a notification for an instant that has
 * already arrived is how a re-plan produces a burst of reminders for doses somebody has taken -
 * `18` calls that nagging, and it is the behaviour that makes people turn reminders off.
 */
export function planReminders(input: ReminderPlanInput): readonly PlannedReminder[] {
  const horizonDays = input.horizonDays ?? REMINDER_HORIZON_DAYS;
  const limit = input.limit ?? MAX_PLANNED_REMINDERS;
  if (horizonDays < 0 || limit <= 0) return [];

  const planned: PlannedReminder[] = [];

  for (const schedule of input.schedules) {
    const subject = input.subjects.get(schedule.id);
    // A schedule whose medicine the device does not know about is skipped rather than scheduled
    // anonymously. A reminder that cannot say which medicine it is about - even to the app that
    // opens when it is tapped - is one somebody cannot act on.
    if (subject === undefined) continue;

    // The window is per schedule, because each carries its own zone. Deriving one calendar window
    // from the device's zone would drop the first or last day of a schedule authored elsewhere.
    const first = localDateIn(input.now, schedule.timeZone);

    for (let day = 0; day <= horizonDays; day += 1) {
      const date = addDays(first, day);
      for (const occurrence of occurrencesOn(schedule, date)) {
        if (occurrence.dueAt <= input.now) continue;
        planned.push({
          key: reminderKey(schedule.id, occurrence.localDate, occurrence.localTime),
          scheduleId: schedule.id,
          ownedItemId: subject.ownedItemId,
          dueAt: occurrence.dueAt,
          localDate: occurrence.localDate,
          localTime: occurrence.localTime,
          content: reminderContent(input.detailLevel, {
            itemDisplayName: subject.itemDisplayName,
            profileDisplayName: subject.profileDisplayName,
          }),
        });
      }
    }
  }

  // Sorted by when, then by key so two doses at the same instant have a stable order. Truncated
  // after the merge, so the cap takes the next N doses across every medicine rather than
  // exhausting itself on the first schedule in the list.
  planned.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.key < b.key ? -1 : 1));
  return planned.slice(0, limit);
}

/** What a device is holding, as far as the platform will say. */
export interface ScheduledReminder {
  readonly key: string;
}

/**
 * What to cancel and what to add, given what the device already holds.
 *
 * The difference matters on every launch. Cancelling everything and rescheduling would work, but
 * between the two calls the device holds no reminders at all - and a process killed in that
 * window leaves a person with none, silently, which is the exact failure Phase 4.2's first exit
 * criterion measures. Adding only what is missing means the reminders that are already correct
 * are never taken away.
 */
export interface ReminderReconciliation {
  readonly toCancel: readonly string[];
  readonly toSchedule: readonly PlannedReminder[];
  readonly unchanged: readonly string[];
}

export function reconcileReminders(
  held: readonly ScheduledReminder[],
  plan: readonly PlannedReminder[],
): ReminderReconciliation {
  const wanted = new Map(plan.map((reminder) => [reminder.key, reminder]));
  const holding = new Set(held.map((reminder) => reminder.key));

  return {
    // Anything the device holds that the plan no longer wants: a dose that has passed, a schedule
    // deactivated, a time moved. Cancelled by key, so a reminder Kynviora did not schedule - or
    // one belonging to another feature - is never touched.
    toCancel: [...holding].filter((key) => !wanted.has(key)).sort(),
    toSchedule: plan.filter((reminder) => !holding.has(reminder.key)),
    unchanged: [...holding].filter((key) => wanted.has(key)).sort(),
  };
}

/**
 * Whether a pass over queued work may start now, and what happens to one that arrives while
 * another is already running.
 *
 * Named for the shape rather than for reminders, because there are now two callers: the reminder
 * reconciliation this was written for, and the pending-operation drain (`DEV-038`), which has the
 * identical problem - React effect inputs that arrive in stages, and a request that must not be
 * lost because it was made while an earlier one was still in flight.
 *
 * WHY THIS IS HERE AND NOT IN THE COMPONENT THAT USES IT
 * Because it is a rule with a wrong answer, and the wrong answer was shipped and measured on a
 * device. The reminder provider guarded its sync with a plain "already running, do nothing"
 * boolean. That is correct about the thing it was defending - two overlapping reconciliations read
 * the same held set and each schedules what the other has not yet placed - and wrong about
 * everything else, because the request it refused was never run.
 *
 * On a cold start the provider's inputs arrive in stages: the API client, then the active profile,
 * then the encrypted projection. The sync that began without the projection was superseded a
 * moment later by one that had it, and that one was dropped. Nothing re-triggered it, so a cold
 * launch reconciled nothing at all: measured on a Pixel 7 / Android 16 emulator as 0 alarms held
 * after three consecutive cold launches with an active schedule, against 15 after a single
 * background-and-return. A schedule somebody created was not applied until they happened to leave
 * the app and come back, and after a reboot the repair pass ran on no launch at all.
 *
 * The rule is that a request may be **deferred but never dropped**: what is in flight was computed
 * from inputs that have since moved, so the answer it produces is already stale, and the request
 * that superseded it is the one that matters. Deferring collapses any number of them into one
 * re-run, because they would all read the same state by the time it happened.
 */
export interface SyncPassGate {
  /** Whether a reconciliation is in flight. */
  readonly running: boolean;
  /** Whether one was asked for while that was true, and so is owed a run when it finishes. */
  readonly deferred: boolean;
}

/** Nothing running, nothing owed. */
export const IDLE_SYNC_PASS: SyncPassGate = { running: false, deferred: false };

/**
 * Ask for a reconciliation.
 *
 * `start` is whether the caller should begin one now. When it is false the request is not refused,
 * it is remembered: `finishSyncPass` will hand it back.
 */
export function requestSyncPass(gate: SyncPassGate): {
  readonly gate: SyncPassGate;
  readonly start: boolean;
} {
  if (gate.running) return { gate: { running: true, deferred: true }, start: false };
  return { gate: { running: true, deferred: false }, start: true };
}

/**
 * Report that the reconciliation finished, however it finished.
 *
 * `rerun` is true when a request arrived while it was running. Called from a `finally`, so a sync
 * that threw still releases the gate - a failed reconciliation that left `running` true would stop
 * every later one, which is the original defect made permanent.
 */
export function finishSyncPass(gate: SyncPassGate): {
  readonly gate: SyncPassGate;
  readonly rerun: boolean;
} {
  return { gate: IDLE_SYNC_PASS, rerun: gate.deferred };
}
