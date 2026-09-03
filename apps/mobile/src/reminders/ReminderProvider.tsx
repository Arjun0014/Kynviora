/**
 * The reminder engine, mounted once for the app.
 *
 * Spec references: `04` Phase 4.2 (local notification scheduling, restart/reboot recovery,
 * permission handling, generic lock-screen default; exit criteria: reliability across process
 * death and device restart, and no medicine name on a lock screen by default), `12` (screens read
 * local state immediately; the offline projection), `03` group J, `18`, `15` A6.
 *
 * WHAT THIS COMPONENT DOES AND WHAT IT REFUSES TO DECIDE
 * It gathers three things - the profile's schedules, what the person allowed on a lock screen,
 * and what the device is already holding - and hands them to `planReminders` and
 * `reconcileReminders` in `@kynviora/domain`. Every decision is there, where it is tested without
 * a device. What is here is sequencing and failure handling.
 *
 * WHY IT RE-PLANS ON EVERY FOREGROUND
 * Because that is what makes the two exit criteria hold, and each for a different reason.
 *
 *   - **Process death.** Android keeps alarms scheduled through a process being killed, so the
 *     reminders already placed still fire. What is lost is the ability to place more, and the
 *     horizon is finite - so an app that only planned at install would go quiet a fortnight later
 *     with no sign of it. Re-planning on foreground extends the horizon every time somebody looks
 *     at the app.
 *   - **Device restart.** Android drops every alarm on reboot. `expo-notifications` registers a
 *     boot receiver that restores them, which is what "as platform allows" in `04` Phase 4.2
 *     means - but a reboot that happened while the device was off the network, or a restore that
 *     the platform declined, leaves a device holding fewer than the plan wants. Reconciling
 *     against what is actually held repairs that on the next launch without duplicating what
 *     survived.
 *
 * WHY THE SCHEDULES ARE KEPT IN THE ENCRYPTED STORE
 * `03` group J and `12`: a person whose phone has no signal must still be reminded. The last
 * successful response is written to the SQLCipher projection and read back when the request
 * fails, so a device that has been offline for a week re-plans from what it last knew rather than
 * from nothing. It is written through the same `projectionActionFor` rule every other screen
 * uses, so an authorization failure removes it rather than leaving a revoked caregiver's copy on
 * the disk (`15` A2).
 *
 * WHY A FAILURE HERE IS NEVER A THROW
 * A throw at the root of an Expo app is a blank screen. A device that cannot schedule reminders
 * still has to show the medicine list, and the state is reported so a screen can say reminders
 * are not arriving rather than implying they are.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  DEFAULT_NOTIFICATION_DETAIL,
  IDLE_SYNC_PASS,
  finishSyncPass,
  instantFrom,
  isNotificationDetailLevel,
  planReminders,
  reconcileReminders,
  requestSyncPass,
  type NotificationDetailLevel,
  type SyncPassGate,
} from '@kynviora/domain';
import {
  deviceSchedules,
  projectionActionFor,
  projectionKey,
  type ApiOutcome,
  type ProfileSchedulesResponse,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useProjection } from '@/storage/ProjectionProvider';
import {
  applyReminders,
  ensureReminderChannel,
  ensureReminderPermission,
  heldReminders,
  installForegroundBehaviour,
  type ReminderSyncOutcome,
} from './notifications';

/** Where a profile's schedules live in the encrypted store. Varies by profile, as the read does. */
export function scheduleProjectionName(profileId: string): string {
  return `schedules:${profileId}`;
}

export type ReminderStatus =
  | 'STARTING'
  /** Working: the device holds what the plan asked for. */
  | 'ACTIVE'
  /** The person declined notifications, or the system will not ask again. */
  | 'NOT_PERMITTED'
  /** Nothing to remind anybody about. Not a failure. */
  | 'NOTHING_SCHEDULED'
  /** Something went wrong and reminders may not arrive. Never presented as working. */
  | 'UNAVAILABLE';

export interface ReminderContextValue {
  readonly status: ReminderStatus;
  /** How many reminders the device is holding after the last sync. */
  readonly held: number;
  /** Whether the last plan was built from the stored copy rather than a fresh response. */
  readonly fromStoredCopy: boolean;
  /** Re-run the sync. Safe to call after a schedule changes. */
  readonly resync: () => void;
}

const ReminderContext = createContext<ReminderContextValue>({
  status: 'STARTING',
  held: 0,
  fromStoredCopy: false,
  resync: () => undefined,
});

export function ReminderProvider({ children }: { readonly children: ReactNode }) {
  const { client } = useApi();
  const { activeProfileId } = useProfiles();
  const { projection, sessionId } = useProjection();

  const [status, setStatus] = useState<ReminderStatus>('STARTING');
  const [held, setHeld] = useState(0);
  const [fromStoredCopy, setFromStoredCopy] = useState(false);
  const [generation, setGeneration] = useState(0);

  const resync = useCallback(() => {
    setGeneration((n) => n + 1);
  }, []);

  // Once for the process. A handler installed per sync would replace itself harmlessly, but this
  // is a property of the app rather than of a profile.
  useEffect(() => {
    installForegroundBehaviour();
  }, []);

  /**
   * Re-plan when the app comes back to the foreground.
   *
   * This is the restart-recovery path as much as the horizon-extension one: after a reboot the
   * first foreground is when the device can compare what the platform restored against what the
   * plan wants, and repair the difference.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') resync();
    });
    return () => {
      subscription.remove();
    };
  }, [resync]);

  const gate = useRef<SyncPassGate>(IDLE_SYNC_PASS);

  useEffect(() => {
    if (client === null || activeProfileId === null) return;

    // One sync at a time, and a request refused while one is running is deferred rather than
    // dropped. `requestSyncPass` is where that rule lives and is tested; dropping it is what
    // made a cold launch reconcile nothing at all, because the inputs arrive in stages and the
    // only request carrying all of them was the one refused.
    const asked = requestSyncPass(gate.current);
    gate.current = asked.gate;
    if (!asked.start) return;

    let live = true;

    const run = async (): Promise<void> => {
      const permission = await ensureReminderPermission();
      if (!live) return;
      if (!permission.granted) {
        setStatus('NOT_PERMITTED');
        return;
      }
      await ensureReminderChannel();

      const storedName = scheduleProjectionName(activeProfileId);
      const key = projection === null ? null : projectionKey(sessionId, storedName);

      const outcome: ApiOutcome<ProfileSchedulesResponse> =
        await client.profileSchedules(activeProfileId);
      if (!live) return;

      // The same rule every screen uses: a failure that says nothing about access may fall back to
      // what was stored; one that says the caller lost access removes it (`15` A2).
      if (projection !== null && key !== null) {
        const action = projectionActionFor(outcome);
        if (action === 'WRITE' && outcome.kind === 'OK') await projection.write(key, outcome.value);
        if (action === 'FORGET') await projection.forget(key);
      }
      if (!live) return;

      let response: ProfileSchedulesResponse | null = outcome.kind === 'OK' ? outcome.value : null;
      let usedStored = false;

      if (response === null && projection !== null && key !== null) {
        // Offline, or the server was unreachable. `03` group J: the reminders a person already
        // has must keep working, and the plan they were built from is the last thing the server
        // said. Only reached where the failure did not concern access, because `FORGET` above
        // has already removed the row in the case that did.
        response = await projection.read<ProfileSchedulesResponse>(key);
        usedStored = response !== null;
      }
      if (!live) return;

      if (response === null) {
        // Nothing to plan from, and no stored copy. The reminders already on the device are left
        // exactly as they are: cancelling them because one request failed would take away the
        // thing a person on a bad connection most needs to keep working.
        setStatus('UNAVAILABLE');
        setFromStoredCopy(false);
        return;
      }

      const detailLevel = await readDetailLevel(client, activeProfileId);
      if (!live) return;

      // Mapped in `@kynviora/contracts`, not here. Deciding which rows a device will fire a
      // reminder from is a rule, and `apps/**` is outside the test run.
      const { schedules, subjects } = deviceSchedules(response);
      const plan = planReminders({
        schedules,
        subjects,
        // The device's own clock. There is no server involved in when a local reminder fires -
        // that is the whole point of `04` Phase 4.2 - and a stored `serverTime` would be from
        // whenever the copy was written, which offline is the wrong answer by days.
        now: instantFrom(new Date().toISOString()),
        detailLevel,
      });

      const currentlyHeld = await heldReminders();
      if (!live) return;

      const outcomeOfApply: ReminderSyncOutcome = await applyReminders(
        reconcileReminders(currentlyHeld, plan),
      );
      if (!live) return;

      setHeld(plan.length - outcomeOfApply.failed.length);
      setFromStoredCopy(usedStored);
      setStatus(
        outcomeOfApply.failed.length > 0
          ? 'UNAVAILABLE'
          : plan.length === 0
            ? 'NOTHING_SCHEDULED'
            : 'ACTIVE',
      );
    };

    void run()
      .catch(() => {
        if (live) setStatus('UNAVAILABLE');
      })
      .finally(() => {
        const done = finishSyncPass(gate.current);
        gate.current = done.gate;
        // A request arrived while this one was working, so it read inputs this run did not have.
        // Bumping the generation re-enters the effect with whatever the current ones are.
        if (done.rerun) setGeneration((n) => n + 1);
      });

    return () => {
      live = false;
    };
  }, [client, activeProfileId, projection, sessionId, generation]);

  const value = useMemo<ReminderContextValue>(
    () => ({ status, held, fromStoredCopy, resync }),
    [status, held, fromStoredCopy, resync],
  );

  return <ReminderContext.Provider value={value}>{children}</ReminderContext.Provider>;
}

/**
 * What the person allowed on a lock screen.
 *
 * `GENERIC` when the settings cannot be read, which is `DEFAULT_NOTIFICATION_DETAIL` and is the
 * safe direction to fail in: a failed settings read must never widen what a notification says.
 * Phase 4.2's second exit criterion holds through this branch as much as through the happy one.
 */
async function readDetailLevel(
  client: NonNullable<ReturnType<typeof useApi>['client']>,
  profileId: string,
): Promise<NotificationDetailLevel> {
  try {
    const settings = await client.notificationSettings(profileId);
    if (settings.kind !== 'OK') return DEFAULT_NOTIFICATION_DETAIL;
    // Narrowed, never cast. The wire type is `string` so a level a later server adds does not
    // fail the parse, and the only safe thing to do with one this build does not recognise is to
    // say less rather than more.
    const level = settings.value.effectiveDetail;
    return isNotificationDetailLevel(level) ? level : DEFAULT_NOTIFICATION_DETAIL;
  } catch {
    return DEFAULT_NOTIFICATION_DETAIL;
  }
}

export function useReminders(): ReminderContextValue {
  return useContext(ReminderContext);
}
