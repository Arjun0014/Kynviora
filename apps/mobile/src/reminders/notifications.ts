/**
 * The platform half of the reminder engine.
 *
 * Spec references: `04` Phase 4.2 (local notification scheduling, permission handling,
 * restart/reboot recovery, generic lock-screen default), `15` A6, `12`, `14`.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No decision. Not which occurrences are due, not how many the device may hold, not what the text
 * says, not what identity a reminder is filed under. All of that is `planReminders` and
 * `reconcileReminders` in `@kynviora/domain`, where it is tested without a device - `apps/**` is
 * outside the test run, and the rule at stake is whether a medicine name reaches a locked screen.
 * This module has three verbs: ask, read what is held, apply a difference.
 *
 * WHY THE CHANNEL IS CREATED EVERY TIME
 * `setNotificationChannelAsync` is idempotent, and an Android channel that does not exist yet
 * silently downgrades every notification posted to it. Creating it on each sync costs one call
 * and removes a class of "reminders fire but are never seen" that only appears on a fresh install.
 *
 * WHY THE CHANNEL IS `PRIVATE` AND THE CONTENT IS STILL GENERIC
 * Defence in depth, and the order matters. `lockscreenVisibility: PRIVATE` asks Android to hide
 * the content when the device is locked - but only where the person has told the system to hide
 * sensitive notifications, which is not the default on most devices. So it is not the guarantee.
 * The guarantee is that the text itself names nothing unless somebody chose otherwise, which is
 * `reminderContent`'s job and is asserted in `reminderPlan.test.ts`.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { PlannedReminder, ScheduledReminder } from '@kynviora/domain';

/**
 * The one channel Kynviora posts dose reminders to.
 *
 * Named separately from anything a safety alert would use, so a person can silence "am I due a
 * tablet" without silencing "this product has been recalled" - `08.2`'s separation, expressed in
 * the one place Android lets a person act on it.
 */
export const REMINDER_CHANNEL_ID = 'medicine-reminders';

/** Whether the device will show what it is asked to show. */
export interface ReminderPermission {
  readonly granted: boolean;
  /**
   * Whether the system will ask again.
   *
   * A person who has refused once must not be asked on every launch (`18`), and a screen that
   * offers a schedule control has to be able to say that reminders will not arrive.
   */
  readonly canAskAgain: boolean;
}

/**
 * Ask for permission to post notifications, once.
 *
 * `requestPermissionsAsync` is only called when the current status is undetermined. Android 13+
 * refuses a second prompt anyway, but asking is also how an app teaches somebody to dismiss it.
 */
export async function ensureReminderPermission(): Promise<ReminderPermission> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return { granted: true, canAskAgain: current.canAskAgain };
  if (!current.canAskAgain) return { granted: false, canAskAgain: false };

  const asked = await Notifications.requestPermissionsAsync();
  return { granted: asked.granted, canAskAgain: asked.canAskAgain };
}

/** Create the channel Android needs before a notification posted to it is visible. */
export async function ensureReminderChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
    name: 'Medicine reminders',
    description: 'Reminders for medicines you have scheduled.',
    // HIGH rather than DEFAULT: a dose reminder that arrives silently in the shade is one somebody
    // finds two hours later. It is not MAX - `18` refuses the full-screen intent, which is what
    // MAX buys and what an alarm clock uses.
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    // Not bypassed. Do Not Disturb is the person's own instruction about their own phone, and a
    // medicine app deciding it knows better is exactly the behaviour `18` refuses.
    bypassDnd: false,
    showBadge: false,
  });
}

/**
 * The reminders the device is currently holding, by key.
 *
 * Only Kynviora's own dose reminders: the identifier is what `reminderKey` produced, and anything
 * the platform holds that this app did not schedule under that shape is left alone. Filtering on
 * the channel would be Android-only and would still match a future notification of another kind.
 */
export async function heldReminders(): Promise<readonly ScheduledReminder[]> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  return scheduled
    .filter((request) => isReminderIdentifier(request.identifier))
    .map((request) => ({ key: request.identifier }));
}

/**
 * Whether an identifier is one of ours.
 *
 * `reminderKey` is length-prefixed: `<n>:<scheduleId of length n><m>:<date of length m><time>`.
 * Checking the shape rather than a prefix string means a reminder scheduled by a future version
 * with a different key layout is not silently adopted and then cancelled.
 */
function isReminderIdentifier(identifier: string): boolean {
  const match = /^(\d+):/.exec(identifier);
  if (match === null) return false;
  const length = Number(match[1]);
  const rest = identifier.slice(match[0].length);
  if (rest.length < length) return false;
  return /^(\d+):/.test(rest.slice(length));
}

export interface ReminderSyncOutcome {
  readonly scheduled: number;
  readonly cancelled: number;
  readonly unchanged: number;
  /** Keys the platform refused. Reported rather than thrown: one bad dose is not all of them. */
  readonly failed: readonly string[];
}

/**
 * Apply a difference the domain computed.
 *
 * Cancels first and schedules second, but only ever the keys that changed - the reminders that
 * are already correct are never taken away. A cancel-everything-then-reschedule would leave the
 * device holding nothing between the two calls, and a process killed in that window leaves a
 * person with no reminders at all and no sign of it (`04` Phase 4.2's reliability criterion).
 *
 * A single failed schedule is recorded and the rest continue. The alternative is that one dose
 * the platform would not accept silently costs somebody every other reminder they had.
 */
export async function applyReminders(
  difference: {
    readonly toCancel: readonly string[];
    readonly toSchedule: readonly PlannedReminder[];
    readonly unchanged: readonly string[];
  },
  channelId: string = REMINDER_CHANNEL_ID,
): Promise<ReminderSyncOutcome> {
  const failed: string[] = [];

  for (const key of difference.toCancel) {
    try {
      await Notifications.cancelScheduledNotificationAsync(key);
    } catch {
      // A cancel that fails because the reminder already fired is not a failure worth reporting;
      // the next sync will not see it held and will not try again.
    }
  }

  let scheduled = 0;
  for (const reminder of difference.toSchedule) {
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: reminder.key,
        content: {
          title: reminder.content.title,
          body: reminder.content.body,
          // What the app needs when somebody taps it. `14` keeps a medicine name out of a log and
          // this is not a log - it is local payload on the person's own device, and without the
          // item there is nothing to open.
          data: { scheduleId: reminder.scheduleId, ownedItemId: reminder.ownedItemId },
          ...(Platform.OS === 'android' ? {} : {}),
        },
        trigger: {
          // An absolute instant, not a repeat rule. The domain expanded the wall-clock time in the
          // schedule's own zone; a platform repeat would be re-evaluated in the device's zone and
          // would move the dose when somebody travels.
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(reminder.dueAt),
          channelId,
        },
      });
      scheduled += 1;
    } catch {
      failed.push(reminder.key);
    }
  }

  return {
    scheduled,
    cancelled: difference.toCancel.length,
    unchanged: difference.unchanged.length,
    failed,
  };
}

/**
 * How a reminder behaves when it arrives while the app is open.
 *
 * Shown rather than swallowed. The default in `expo-notifications` is to suppress a notification
 * that arrives in the foreground, which for a dose reminder means the one case where somebody is
 * definitely looking at their phone is the one case they are not told.
 */
export function installForegroundBehaviour(): void {
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
  });
}
