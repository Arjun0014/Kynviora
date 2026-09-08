/**
 * Shelf screen.
 *
 * Spec references: `06` (Shelf is a primary destination and defines every state), `18` (identity,
 * formula and batch certainty stay distinct), `02` (no aggregate trust score), `13` (a profile ID
 * narrows a result set and never grants access), `04` Phase 4.3 (dose events).
 *
 * Each item carries three separate status chips because they are three separate statements. A
 * single "verified" badge would be the aggregate Trust Passport score `02` forbids, with the
 * number left off - and it would say "this product is fine" using evidence that only covers
 * whether Kynviora recognised the barcode.
 *
 * The list is exactly what the server returned. The profile ID in the request narrows it; row-
 * level security decides it. A profile this account cannot see comes back as an empty page rather
 * than a refusal, which is why an empty shelf and an unauthorised one look the same here.
 *
 * ADDING AN ITEM LIVES HERE BECAUSE THE SHELF IS WHAT IT JOINS
 * `04` Phases 2.2 and 2.3. Two controls rather than one, because which of the two a person is
 * adding decides which fields they are asked for - a single "Add" that asked the category as its
 * first question would be the same two paths with a step in front of them. The labels are the
 * forms' own headings: this screen writes no copy.
 *
 * RECORDING A DOSE LIVES HERE BECAUSE THE MEDICINE DOES
 * `04` Phase 4.3 is about recording what happened, and what happened, happened to one of these.
 * An item's own row is where a person looking for "the one I take in the morning" already is. The
 * control is offered on medicines only: a dose is a medicine's idea, and a recorded dose of
 * shampoo is a row nobody can read back meaningfully.
 *
 * SO DOES SETTING WHEN IT IS TAKEN
 * `04` Phase 4.1, on the same row and for the same reason. The times belong to one medicine, and
 * a separate "schedules" destination would be a second list of the medicines that already have a
 * list. Medicines only, again: `medicine_schedule` is scoped to `MANAGE_MEDICINES` and a schedule
 * on a shampoo is refused by the database as well as by this screen.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  SPACING,
  RADIUS,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  SHELF_COLLECTION_ORDER,
  manualEntryForm,
  presentShelfCollection,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import {
  DEFAULT_NOTIFICATION_DETAIL,
  ITEM_KINDS,
  type ShelfCollection,
  isNotificationDetailLevel,
  type DoseEventKind,
  type ItemKind,
} from '@kynviora/domain';
import {
  doseHistory,
  itemDetailScreenView,
  messageForFailure,
  screenStateForFailure,
  shelfView,
  type DoseHistoryView,
  type ItemDetailScreenView,
  type ScheduleBody,
  type ScheduleChangeBody,
  type ShelfItemView,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Screen } from '@/components/Screen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ResourceState } from '@/components/ScreenState';
import { StatusChip } from '@/components/StatusChip';
import { Card } from '@/components/Card';
import { Typography } from '@/components/Typography';
import { RecordDose } from '@/features/doses/RecordDose';
import { AddItem } from '@/features/shelf/AddItem';
import { ScanBarcode } from '@/features/shelf/ScanBarcode';
import { EditItem } from '@/features/shelf/EditItem';
import { DeleteItem } from '@/features/shelf/DeleteItem';
import { ItemDetail } from '@/features/shelf/ItemDetail';
import { MedicineSchedules } from '@/features/schedules/MedicineSchedules';
import { useReminders } from '@/reminders/ReminderProvider';
import { usePendingSync } from '@/sync/PendingSyncProvider';
import { newIdempotencyKey } from '@/platform/ids';
import { useThemedStyles } from '@/theme/ThemeProvider';
import { TalkBar } from '@/voice/TalkBar';
import { useDeclareScreen, type ScreenActionBinding } from '@/voice/ScreenContextProvider';
import { useRouter } from 'expo-router';

const EMPTY_HISTORY: DoseHistoryView = { lines: [], unreadableCount: 0, emptyMessage: '' };

export default function ShelfScreen() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { client, elevate } = useApi();
  const { activeProfile, activeProfileId } = useProfiles();
  // Read rather than inferred: whether a reminder will actually arrive is the platform's answer,
  // and a screen that offered a schedule without saying notifications are off would promise
  // something the phone has already refused.
  const { status: reminderStatus, resync: resyncReminders } = useReminders();
  const { queue: queueEdit } = usePendingSync();

  const [recording, setRecording] = useState<ShelfItemView | null>(null);
  const [recordState, setRecordState] = useState<ScreenStateKind | null>(null);
  const [recordMessage, setRecordMessage] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);
  /**
   * Whether the dose went into the journal rather than to the server.
   *
   * Held apart from `recorded`, because the two are different promises. "Recorded." means the
   * server has it; a queued dose is on this phone and nowhere else yet, and saying the shorter
   * sentence would be telling somebody their record is safe on the strength of a failed request.
   */
  const [recordQueued, setRecordQueued] = useState(false);

  /**
   * The item whose detail is open, or `null`.
   *
   * `04` Phase 2.1's detail is reached from the row rather than being its own destination, for
   * the reason the Lens and the alert detail are: an item detail with its own tab would be a
   * second list of the same things.
   */
  const [detailFor, setDetailFor] = useState<ShelfItemView | null>(null);

  /**
   * The medicine whose schedule is open, or `null`.
   *
   * `04` Phase 4.1. Reached from the row, like recording a dose, because the times belong to one
   * medicine and this screen is where that medicine already is.
   */
  const [scheduling, setScheduling] = useState<ShelfItemView | null>(null);
  const [scheduleState, setScheduleState] = useState<ScreenStateKind | null>(null);
  const [scheduleMessage, setScheduleMessage] = useState<string | null>(null);

  /**
   * The category being added, or `null`.
   *
   * Holding the category rather than a boolean is what makes the form a form: `manualEntryForm`
   * decides which fields exist for which category, and a medicine asked for a "kind of product"
   * is the reduction to a generic note Phase 2.1's first exit criterion forbids.
   */
  const [adding, setAdding] = useState<ItemKind | null>(null);

  /**
   * Whether the scan screen is open, and what it has handed back.
   *
   * A scan is a shortcut into the same form manual entry uses, not a second way to create an
   * item - so the barcode is carried into `AddItem` as a prefill and the item is created by
   * exactly one path. `04` Phase 2.2 makes the manual form the complete route, and two create
   * paths would be two places for a required field to be forgotten.
   */
  const [scanning, setScanning] = useState(false);
  const [scannedGtin, setScannedGtin] = useState<string | null>(null);

  /**
   * Whether the open item is being edited.
   *
   * Reached from the detail rather than from the row, because a control on the list would let
   * somebody change a record they were not looking at - and the detail is where the three
   * verification chips say how much of it Kynviora actually knows.
   */
  const [editing, setEditing] = useState(false);

  /**
   * Whether the open item is being deleted.
   *
   * Reached from the detail rather than from the row, and for a sharper version of the reason
   * editing is: a control on the list would put an irreversible action one tap from a scroll, on
   * a screen where the rows look alike. The detail is where the item is named.
   */
  const [deleting, setDeleting] = useState(false);
  const [deleteState, setDeleteState] = useState<ScreenStateKind | null>(null);
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  /**
   * The filter, as the two questions it actually is.
   *
   * `null` is unfiltered, and that is what a person lands on. A shelf that opened pre-filtered
   * would hide items without saying it had - the Safety screen's rule, for the same reason.
   */
  const [attention, setAttention] = useState<'NEEDS_VERIFICATION' | 'NEEDS_REVIEW' | null>(null);

  /**
   * Which collection is on screen (`0033`, DEC-160).
   *
   * Always one of the two, never both. A collection is what a person is looking at rather than a
   * filter over one list - which is why this does not follow the `attention` rule above it: an
   * unfiltered shelf that mixed the two would show somebody the shampoo they are thinking about
   * beside the one they use, and the whole reason the column exists is that those are different
   * facts about a product.
   *
   * `IN_USE` on open, and nothing disappears by that: every row that existed before `0033` is in
   * it, and the switcher names the collection on screen at all times.
   */
  const [collection, setCollection] = useState<ShelfCollection>('IN_USE');

  const load = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () =>
            client.listItems({
              profileId: activeProfileId,
              collection,
              ...(attention === null ? {} : { attention }),
            }),
    [client, activeProfileId, attention, collection],
  );

  const { resource, reload, refreshing } = useResource(load, {
    enabled: activeProfileId !== null,
    isEmpty: (value) => value.items.length === 0,
    // `03` group J: the current medicine list and the basic personal-care shelf have to be usable
    // with no network. The key carries the filter as well as the profile, because a filtered list
    // and an unfiltered one are different answers and a key that dropped the filter would show
    // one as the other.
    ...(activeProfileId === null
      ? {}
      : { projectionKey: `items:${activeProfileId}:${collection}:${attention ?? 'all'}` }),
  });

  const view = useMemo(
    () =>
      resource.value === null
        ? null
        : shelfView(resource.value.items, resource.value.nextCursor, resource.value.mayRecordDoses),
    [resource.value],
  );

  /**
   * What has been recorded for the item being looked at.
   *
   * A separate resource, because it is a separate question and a separate failure: the shelf
   * loading and the history not is a real state, and folding them together would take the whole
   * screen down when one list did not arrive.
   */
  const loadDetail = useMemo(
    () => (client === null || detailFor === null ? null : () => client.itemDetail(detailFor.id)),
    [client, detailFor],
  );

  const { resource: detailResource, reload: reloadDetail } = useResource(loadDetail, {
    enabled: detailFor !== null,
  });

  const detailView: ItemDetailScreenView | null = useMemo(
    () => (detailResource.value === null ? null : itemDetailScreenView(detailResource.value)),
    [detailResource.value],
  );

  const loadHistory = useMemo(
    () =>
      client === null || recording === null
        ? null
        : () => client.doseEvents({ ownedItemId: recording.id }),
    [client, recording],
  );

  const { resource: historyResource, reload: reloadHistory } = useResource(loadHistory, {
    enabled: recording !== null,
    isEmpty: (value) => value.events.length === 0,
  });

  const history = useMemo(
    () =>
      historyResource.value === null ? EMPTY_HISTORY : doseHistory(historyResource.value.events),
    [historyResource.value],
  );

  /**
   * The schedules on the medicine being scheduled, and what a reminder may say.
   *
   * Two requests, because they are two questions with two failures: the schedule list not loading
   * and the disclosure preference not loading are different states, and folding them together
   * would take the screen down when one of them did not arrive. The disclosure falls back to
   * `GENERIC` - the safe direction, and what the engine itself falls back to.
   */
  const loadSchedules = useMemo(
    () =>
      client === null || scheduling === null || activeProfileId === null
        ? null
        : async () => {
            const [schedules, settings, detail] = await Promise.all([
              client.schedules(scheduling.id),
              client.notificationSettings(activeProfileId),
              // For the prescriber's own words. The shelf row does not carry them, and it should
              // not: `04` Phase 4.1 preserves them as source text on the item, and a list that
              // carried every medicine's directions would be putting clinical wording on a screen
              // nobody opened to read it.
              client.itemDetail(scheduling.id),
            ]);
            if (schedules.kind !== 'OK') return schedules;
            return {
              kind: 'OK' as const,
              correlationId: schedules.correlationId,
              value: {
                schedules: schedules.value.schedules,
                detailLevel:
                  settings.kind === 'OK'
                    ? settings.value.effectiveDetail
                    : DEFAULT_NOTIFICATION_DETAIL,
                // The stored value, not a rendered label. `null` where nobody recorded any, and
                // `null` where the detail did not load - never a placeholder, and never this
                // screen's guess at what the prescription said.
                directionsText:
                  detail.kind === 'OK'
                    ? (detail.value.editableValues['directionsText'] ?? null)
                    : null,
                mayEdit: detail.kind === 'OK' ? detail.value.mayEdit : false,
              },
            };
          },
    [client, scheduling, activeProfileId],
  );

  /**
   * Deliberately **not** declared empty when there are no schedules.
   *
   * `EMPTY` sets `value` to `null` (`resourceFor`), and this payload is not one list: it carries
   * the notification detail level, the prescriber's directions and `mayEdit` alongside the
   * schedules. Calling it empty discarded all four, so `mayEdit` fell back to `false` and the
   * "Add a schedule" button was not drawn - on exactly the medicines that had no schedule yet.
   * A medicine could therefore never be given its first one, which is the only state a newly added
   * medicine is ever in (`DEV-045`).
   *
   * There is nothing to gain by declaring it either: the editor renders "Nothing is scheduled for
   * this medicine." from `schedules.length === 0` itself, and `ScreenState` is not shown for
   * `EMPTY` anyway. `isEmpty` answers a question about a whole payload, and this one is empty in
   * one field only.
   */
  const { resource: scheduleResource, reload: reloadSchedules } = useResource(loadSchedules, {
    enabled: scheduling !== null,
  });

  const onRetry = useCallback(() => {
    reload();
  }, [reload]);

  /**
   * What Kynviora can do on Shelf (DEC-157).
   *
   * The two filters this screen already has, plus the way out of them, plus the Coverage Center -
   * which is here because it is the one thing V3 moved off the tab bar, and a person who used to
   * find Safety by looking at the row of tabs should be able to ask for it by name.
   *
   * "Show only toothpaste" from the V3 brief is **not** here yet, and its absence is deliberate
   * rather than an omission: this shelf has no category filter to drive, so an action offering one
   * would be a sentence that does nothing. It arrives with the category grouping.
   */
  const screenActions = useMemo<readonly ScreenActionBinding[]>(
    () => [
      {
        id: 'shelf.needsVerification',
        label: 'Show what is not yet confirmed',
        says: 'Showing the items that are not yet confirmed.',
        run: () => {
          setAttention('NEEDS_VERIFICATION');
        },
      },
      {
        id: 'shelf.needsReview',
        label: 'Show what is not yet looked at',
        says: 'Showing the items nobody has looked at yet.',
        run: () => {
          setAttention('NEEDS_REVIEW');
        },
      },
      {
        id: 'shelf.all',
        label: 'Show everything',
        says: 'Showing everything on the shelf.',
        run: () => {
          setAttention(null);
        },
      },
      {
        id: 'shelf.coverage',
        label: 'What Kynviora has checked',
        says: 'Opening what Kynviora has checked.',
        run: () => {
          router.push('/safety');
        },
      },
    ],
    [router],
  );

  useDeclareScreen(
    useMemo(
      () => ({
        route: 'SHELF' as const,
        profileId: activeProfileId,
        // The item whose detail is open, as an identifier. Never its name.
        focusId: detailFor?.id ?? null,
        actions: screenActions,
        // The three places the design language says the bar leaves, as this screen reaches them.
        capturing: scanning,
        sheetOpen: adding !== null || recording !== null || scheduling !== null,
      }),
      [activeProfileId, detailFor, screenActions, scanning, adding, recording, scheduling],
    ),
  );

  const onRecord = useCallback(
    (body: {
      readonly ownedItemId: string;
      readonly eventKind: DoseEventKind;
      readonly note?: string;
    }) => {
      if (client === null) return;

      setRecordState('LOADING');
      setRecordMessage(null);
      setRecorded(false);
      setRecordQueued(false);

      // Generated once for this attempt, so a retry of the same intent replays rather than
      // recording a second event. `04` Phase 4.3 makes that an exit criterion, because an event
      // created offline may be uploaded more than once - and a duplicated history is a false
      // record of what somebody did.
      const idempotencyKey = newIdempotencyKey();

      void client.recordDoseEvent(body, idempotencyKey).then(
        (outcome) => {
          if (outcome.kind === 'OK') {
            setRecordState(null);
            setRecorded(true);
            // Re-read rather than append. What was recorded is the server's answer, and a line
            // this screen drew itself would survive a failure it did not notice.
            reloadHistory();
            return;
          }
          if (outcome.kind === 'OFFLINE') {
            // The dose a person is most likely to record is one they took at home, and a kitchen
            // is where a phone has least signal. Before this, the answer was "Kynviora could not
            // reach the server" and the record was gone - so the history a doctor reads was
            // missing a dose that was taken, and nothing said so.
            //
            // Under the key the failed attempt used, never a fresh one. `OFFLINE` is inferred from
            // a failed fetch, which is also what a request that arrived and lost its answer looks
            // like - and `13` resolves this table `MERGE_BY_ID` precisely so the replay lands on
            // the row that already exists (DEC-111).
            void queueEdit({
              entityType: 'dose_event',
              entityId: body.ownedItemId,
              mutation: 'CREATE',
              payload: body,
              baseVersion: null,
              operationId: idempotencyKey,
            }).then((queued) => {
              setRecordState(queued ? null : screenStateForFailure(outcome));
              setRecordMessage(null);
              setRecordQueued(queued);
            });
            return;
          }
          setRecordState(screenStateForFailure(outcome));
          setRecordMessage(outcome.kind === 'REFUSED' ? outcome.message : null);
        },
        () => {
          setRecordState('RECOVERABLE_ERROR');
          setRecordMessage(null);
        },
      );
    },
    [client, reloadHistory, queueEdit],
  );

  /** What the last move said, or `null`. Cleared when the detail is closed. */
  const [moveNote, setMoveNote] = useState<string | null>(null);

  /**
   * Move the open item to the shelf's other collection (`0033`, DEC-160).
   *
   * The same three outcomes every write on this screen has, and the middle one is the reason this
   * is not two lines: `12` and DEC-148 require a change made with no signal to be kept rather than
   * lost, and a move that silently vanished would put a product back among the ones somebody uses
   * without saying it had.
   *
   * `owned_item` resolves `ASK_USER` under `13`, so the queued payload carries the version this
   * screen read - a replay either lands once or comes back as a conflict, and the conflict is
   * shown rather than merged.
   */
  const onMoveCollection = useCallback(
    (to: ShelfCollection) => {
      if (client === null || detailView === null) return;
      const body = { expectedVersion: detailView.version, shelfCollection: to };
      setMoveNote(null);

      void client.updateItem(detailView.id, body).then(
        (outcome) => {
          if (outcome.kind === 'OK') {
            // Re-read rather than patched: what stands after a write is the server's answer, and
            // the version this screen holds has moved. Both lists, because the shelf now shows a
            // different collection's worth of rows than it did a moment ago.
            reloadDetail();
            reload();
            return;
          }
          if (outcome.kind === 'OFFLINE') {
            void queueEdit({
              entityType: 'owned_item',
              entityId: detailView.id,
              mutation: 'UPDATE',
              payload: body,
              baseVersion: body.expectedVersion,
            }).then((queued) => {
              setMoveNote(
                queued
                  ? 'This move is on this phone and will be sent when Kynviora can reach the ' +
                      'server.'
                  : messageForFailure(outcome),
              );
            });
            return;
          }
          setMoveNote(outcome.kind === 'REFUSED' ? outcome.message : messageForFailure(outcome));
        },
        () => {
          setMoveNote(messageForFailure({ kind: 'UNAVAILABLE' }));
        },
      );
    },
    [client, detailView, reload, reloadDetail, queueEdit],
  );

  /**
   * Delete the open item.
   *
   * Elevated for this one request and discarded, exactly as the caregiver removal is (`14`), so
   * the privileged session never outlives the action. No idempotency key and no version: deleting
   * an item that is already deleted is refused as not-found rather than repeated, so a retry
   * cannot produce a second deletion.
   *
   * Nothing is applied locally. `12` forbids the client deciding what happened, and a row that
   * vanished on a failed request would be a false statement about somebody's health record in the
   * direction that reassures. The shelf is re-read instead.
   */
  const onConfirmDelete = useCallback(() => {
    if (client === null || detailFor === null) return;

    const elevated = elevate();
    if (elevated === null) {
      setDeleteState('STEP_UP_REQUIRED');
      return;
    }

    const itemId = detailFor.id;
    setDeleteState('LOADING');
    setDeleteMessage(null);

    void elevated.deleteItem(itemId).then(
      (outcome) => {
        if (outcome.kind === 'OK') {
          setDeleteState(null);
          setDeleted(true);
          // The shelf, not the detail. The detail is about to be closed and re-reading it would
          // be asking for a row the deletion just made unreadable - a 404 the screen would then
          // have to explain away.
          reload();
          return;
        }
        setDeleteState(screenStateForFailure(outcome));
        setDeleteMessage(messageForFailure(outcome));
      },
      () => {
        setDeleteState('RECOVERABLE_ERROR');
        setDeleteMessage(null);
      },
    );
  }, [client, detailFor, elevate, reload]);

  /** Leave the deletion screen, whichever way it ended. */
  const onCloseDelete = useCallback(() => {
    const wasDeleted = deleted;
    setDeleting(false);
    setDeleteState(null);
    setDeleteMessage(null);
    setDeleted(false);
    // A deleted item has no detail left to return to, so the shelf is where "Back" goes. Leaving
    // the detail open would show the 404 the deletion just created.
    if (wasDeleted) {
      setDetailFor(null);
      setEditing(false);
    }
  }, [deleted]);

  const onCreateSchedule = useCallback(
    (body: ScheduleBody) => {
      if (client === null || scheduling === null) return;
      setScheduleState('LOADING');
      setScheduleMessage(null);

      // One key for this attempt, kept across retries of the same intent - including a retry that
      // happens tomorrow out of the offline journal. Two schedules on one medicine is not a
      // duplicate row on a list: it is being told twice, at the same minute, to take the same
      // tablet.
      const idempotencyKey = newIdempotencyKey();
      const itemId = scheduling.id;

      void client.createSchedule(itemId, body, idempotencyKey).then(
        (outcome) => {
          if (outcome.kind === 'OK') {
            setScheduleState(null);
            reloadSchedules();
            // The device holds the reminders, so the plan has to be rebuilt now rather than at
            // the next launch - otherwise somebody saves a schedule, closes the app, and is not
            // reminded until they happen to open it again.
            resyncReminders();
            return;
          }
          if (outcome.kind === 'OFFLINE') {
            // The same key the failed attempt used. `OFFLINE` means the request never reached a
            // server, but that is inferred from a failed fetch - which is also what a request that
            // arrived and lost its answer looks like. Under a fresh key the replay would create a
            // second schedule.
            void queueEdit({
              entityType: 'medicine_schedule',
              entityId: itemId,
              mutation: 'CREATE',
              payload: body,
              baseVersion: null,
              operationId: idempotencyKey,
            }).then((queued) => {
              setScheduleState(queued ? null : screenStateForFailure(outcome));
              setScheduleMessage(null);
              if (queued) reloadSchedules();
            });
            return;
          }
          setScheduleState(screenStateForFailure(outcome));
          setScheduleMessage(outcome.kind === 'REFUSED' ? outcome.message : null);
        },
        () => {
          setScheduleState('RECOVERABLE_ERROR');
          setScheduleMessage(null);
        },
      );
    },
    [client, scheduling, reloadSchedules, resyncReminders, queueEdit],
  );

  const onUpdateSchedule = useCallback(
    (scheduleId: string, body: ScheduleChangeBody) => {
      if (client === null) return;
      setScheduleState('LOADING');
      setScheduleMessage(null);

      // No idempotency key, and that is not an omission: the write is conditional on the version,
      // so a retry either lands once or comes back as a conflict.
      void client.updateSchedule(scheduleId, body).then(
        (outcome) => {
          if (outcome.kind === 'OK') {
            setScheduleState(null);
            reloadSchedules();
            resyncReminders();
            return;
          }
          // Offline is the one failure worth keeping the edit for. Everything else is an answer:
          // a refusal names something to change, and an authorization failure must not be retried
          // at all (`12`). `queue` can still refuse - the store may not be open - and then the
          // original failure is what the person is told, which is the honest outcome.
          if (outcome.kind === 'OFFLINE') {
            void queueEdit({
              entityType: 'medicine_schedule',
              entityId: scheduleId,
              mutation: 'UPDATE',
              payload: body,
              baseVersion: body.expectedVersion,
            }).then((queued) => {
              setScheduleState(queued ? null : screenStateForFailure(outcome));
              setScheduleMessage(null);
              if (queued) reloadSchedules();
            });
            return;
          }
          setScheduleState(screenStateForFailure(outcome));
          setScheduleMessage(outcome.kind === 'REFUSED' ? outcome.message : null);
        },
        () => {
          setScheduleState('RECOVERABLE_ERROR');
          setScheduleMessage(null);
        },
      );
    },
    [client, reloadSchedules, resyncReminders, queueEdit],
  );

  const onCloseSchedule = useCallback(() => {
    setScheduling(null);
    setScheduleState(null);
    setScheduleMessage(null);
  }, []);

  const onCloseRecord = useCallback(() => {
    setRecording(null);
    setRecordState(null);
    setRecordMessage(null);
    setRecorded(false);
    setRecordQueued(false);
  }, []);

  if (scanning && adding !== null) {
    return (
      <Screen title="Shelf" intro="Reading the number under the barcode.">
        <ScanBarcode
          onConfirmed={(gtin) => {
            // Into the form, never straight into a record. `09`: the number is unverified
            // observed data and the person has already confirmed reading it - what they have not
            // done is finish entering the medicine.
            setScannedGtin(gtin);
            setScanning(false);
          }}
          onEnterManually={() => {
            setScannedGtin(null);
            setScanning(false);
          }}
          onCancel={() => {
            setScanning(false);
            setAdding(null);
            setScannedGtin(null);
          }}
        />
      </Screen>
    );
  }

  if (adding !== null && activeProfileId !== null) {
    return (
      <Screen title="Shelf" intro="Only the name is needed.">
        <AddItem
          itemKind={adding}
          profileId={activeProfileId}
          onSaved={onRetry}
          {...(scannedGtin === null ? {} : { initialValues: { recordedGtin: scannedGtin } })}
          {...(adding === 'MEDICINE'
            ? {
                onScan: () => {
                  setScanning(true);
                },
              }
            : {})}
          onClose={() => {
            setAdding(null);
            setScannedGtin(null);
          }}
        />
      </Screen>
    );
  }

  if (detailFor !== null && deleting) {
    return (
      <Screen title="Shelf" intro={detailFor.displayName}>
        <DeleteItem
          displayName={detailFor.displayName}
          itemKind={detailFor.itemKind}
          onConfirm={onConfirmDelete}
          onCancel={onCloseDelete}
          state={deleteState}
          stateMessage={deleteMessage}
          deleted={deleted}
          {...(detailView?.mayEdit === true && !deleted
            ? {
                onArchiveInstead: () => {
                  setDeleting(false);
                  setEditing(true);
                },
              }
            : {})}
        />
      </Screen>
    );
  }

  if (detailFor !== null && editing && detailView !== null) {
    return (
      <Screen title="Shelf" intro={detailView.displayName}>
        <EditItem
          view={detailView}
          onChanged={() => {
            // Both lists. The detail carries the version the next change is sent against, and the
            // shelf row carries the state and the attention reasons a lifecycle change moves.
            reloadDetail();
            reload();
          }}
          onClose={() => {
            setEditing(false);
          }}
        />
      </Screen>
    );
  }

  if (detailFor !== null) {
    return (
      <Screen title="Shelf" intro="What Kynviora has for this item, and what is still missing.">
        <ItemDetail
          view={detailView}
          state={detailResource.state}
          onMove={onMoveCollection}
          moveNote={moveNote}
          onEdit={() => {
            setEditing(true);
          }}
          {...(detailView?.mayDelete === true
            ? {
                onDelete: () => {
                  setDeleted(false);
                  setDeleteState(null);
                  setDeleteMessage(null);
                  setDeleting(true);
                },
              }
            : {})}
          onClose={() => {
            setDetailFor(null);
            setEditing(false);
            setMoveNote(null);
          }}
        />
      </Screen>
    );
  }

  if (scheduling !== null) {
    const level = scheduleResource.value?.detailLevel ?? DEFAULT_NOTIFICATION_DETAIL;
    return (
      <Screen title="Shelf" intro={scheduling.displayName}>
        <MedicineSchedules
          displayName={scheduling.displayName}
          // The prescriber's own words, from the detail this row already carries. `null` where
          // nobody recorded any - never a placeholder, and never Kynviora's reading of them.
          directionsText={scheduleResource.value?.directionsText ?? null}
          schedules={scheduleResource.value?.schedules ?? []}
          listState={scheduleResource.state}
          detailLevel={isNotificationDetailLevel(level) ? level : DEFAULT_NOTIFICATION_DETAIL}
          remindersPermitted={reminderStatus !== 'NOT_PERMITTED'}
          // The device's own zone as the starting point for a new schedule. The person can change
          // it: a schedule authored for somewhere else is exactly what `04` Phase 4.1's time-zone
          // rule exists for.
          deviceTimeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
          // The server's own answer, evaluated with the same expression the update policy uses.
          // A caregiver who may read a medicine and not change it sees the times and no controls
          // (DEC-045) - and the database refuses the write regardless (migration 0020).
          mayEdit={scheduleResource.value?.mayEdit ?? false}
          onCreate={onCreateSchedule}
          onUpdate={onUpdateSchedule}
          onClose={onCloseSchedule}
          state={scheduleState}
          stateMessage={scheduleMessage}
        />
      </Screen>
    );
  }

  if (recording !== null) {
    return (
      <Screen title="Shelf" intro={recording.displayName}>
        <RecordDose
          ownedItemId={recording.id}
          itemKind={recording.itemKind}
          displayName={recording.displayName}
          onRecord={onRecord}
          onClose={onCloseRecord}
          history={history}
          historyState={historyResource.state}
          state={recordState}
          stateMessage={recordMessage}
          recorded={recorded}
          queued={recordQueued}
        />
      </Screen>
    );
  }

  return (
    <Screen
      title="Shelf"
      eyebrow={activeProfile?.displayName ?? null}
      intro="Medicines and personal-care products, with how well Kynviora knows each one."
      onRefresh={onRetry}
      refreshing={refreshing}
      footer={<TalkBar />}
    >
      <ResourceState resource={resource} onRetry={onRetry} />

      {/*
        The Coverage Center (DEC-151).

        Safety stopped being a tab on 2026-09-08 and this is one of the addresses it gained
        instead. It is on Shelf because that is where somebody is when the question occurs to
        them - they are looking at their things and want to know what has been checked about them
        - and the alternative, leaving the screen reachable only by URL, would have been the
        decision quietly turning into a removal.

        A control rather than a row in the list: it is about the whole shelf, and putting it among
        the items would make it look like one of them. The label is the question it answers,
        because "Coverage Center" is a place and "what has Kynviora checked" is what a person
        wants - and it is the label rather than a separate accessibility name, so a screen reader
        and the screen say the same words (`18`).
      */}
      <PrimaryButton
        label="What Kynviora has checked"
        variant="secondary"
        onPress={() => {
          router.push('/safety');
        }}
      />

      {/* Above the filters and above the list, so it is reachable from the empty shelf as well -
          which is the state every new household starts in and the one where it matters most.
          Side by side: they are two halves of one choice, and stacking them made the second read
          as an afterthought. They wrap at a large font scale rather than clipping. */}
      {activeProfileId === null ? null : (
        <View style={styles.addRow}>
          {ITEM_KINDS.map((kind) => (
            <PrimaryButton
              key={kind}
              label={manualEntryForm(kind).heading}
              variant="secondary"
              style={styles.addButton}
              onPress={() => {
                setAdding(kind);
              }}
            />
          ))}
        </View>
      )}

      {/* The two collections (`0033`, DEC-160). A switcher rather than a filter, and above the
          filters because it decides what the filters are narrowing: one is what somebody has and
          the other is what they are thinking about, and the two answer different questions about
          the same product.

          The collection on screen is named whether or not it is the default, because the other
          one is not empty from here - it is elsewhere, and `18` will not let that pass as an
          absence. */}
      <View style={styles.filters}>
        {SHELF_COLLECTION_ORDER.map((value) => {
          const presented = presentShelfCollection(value);
          const active = collection === value;
          return (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={
                active
                  ? `${presented.label}, showing. ${presented.meaning}`
                  : `${presented.label}. ${presented.meaning}`
              }
              onPress={() => {
                setCollection(value);
              }}
              style={[styles.filter, active ? styles.filterOn : null]}
            >
              {/* The state is in the label as well as in the styling (`18`). */}
              <Text style={[styles.filterLabel, active ? styles.filterLabelOn : null]}>
                {active ? `${presented.label} - showing` : presented.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Two filters, each named as the question it asks. They narrow and they do not rank -
          which of two people's medicines matters more is not a judgement this screen makes.
          A chosen filter carries `selection`, which is the one hue in this app that is about the
          interface rather than about a product. */}
      <View style={styles.filters}>
        {(
          [
            ['NEEDS_VERIFICATION', 'Not yet confirmed'],
            ['NEEDS_REVIEW', 'Not yet looked at'],
          ] as const
        ).map(([value, label]) => {
          const active = attention === value;
          return (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={
                active ? `${label} filter, on. Press to show everything.` : `${label} filter, off.`
              }
              onPress={() => {
                setAttention(active ? null : value);
              }}
              style={[styles.filter, active ? styles.filterOn : null]}
            >
              {/* The state is in the label as well as in the styling. `18` forbids meaning
                  carried by colour alone. */}
              <Text style={[styles.filterLabel, active ? styles.filterLabelOn : null]}>
                {active ? `${label} - on` : label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {attention === null ? null : (
        <Text style={styles.note}>
          This is a filtered list. Items Kynviora has nothing outstanding about are not shown.
        </Text>
      )}

      {/* An empty collection says which one it is. "Nothing here yet" over both would describe a
          person who has recorded nothing and a person who is evaluating nothing as the same
          situation - and only one of those is a shelf somebody needs to do something about. */}
      {view !== null && view.items.length === 0 && attention === null ? (
        <Text style={styles.note}>{presentShelfCollection(collection).emptyNote}</Text>
      ) : null}

      {view === null
        ? null
        : view.items.map((item) => (
            <ShelfRow
              key={item.id}
              item={item}
              mayRecordDoses={view.mayRecordDoses}
              onOpen={() => {
                setDetailFor(item);
              }}
              onRecord={() => {
                setRecording(item);
              }}
              onSchedule={() => {
                setScheduling(item);
              }}
            />
          ))}

      {view !== null && view.hasMore ? (
        <Text style={styles.note}>
          This is the first page. Kynviora has more products on this shelf.
        </Text>
      ) : null}
    </Screen>
  );
}

/**
 * One row of the shelf.
 *
 * Exported so it can be rendered on its own. It decides which controls a person is offered for one
 * item - which is a product decision with two capability rules in it (DEC-116, and medicines-only
 * for a dose) - and reaching it through the whole screen would mean standing up four providers and
 * a network client to ask a question about a ternary. The screen is not exported and does not need
 * to be; this is.
 */
export function ShelfRow({
  item,
  mayRecordDoses,
  onOpen,
  onRecord,
  onSchedule,
}: {
  readonly item: ShelfItemView;
  /**
   * Whether this person may write into the dose history at all (migration `0021`).
   *
   * The server's answer for the profile, not a guess made here. `11` puts the decision on the
   * server and this is only what stops the screen offering a control the write would refuse.
   */
  readonly mayRecordDoses: boolean;
  readonly onOpen: () => void;
  readonly onRecord: () => void;
  readonly onSchedule: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const medicine = item.itemKind === 'MEDICINE';

  return (
    <Card>
      {/* The name and the brand are one idea, so they sit tight against each other and the rest
          of the card is spaced away from them. */}
      <View style={styles.identity}>
        <Typography role="title" heading>
          {item.displayName}
        </Typography>
        {item.brand === null ? null : (
          <Typography role="caption" colour="secondary">
            {item.brand}
          </Typography>
        )}
      </View>

      {/* Three chips, never one. `18`: "Product identity confirmed", "Formula confirmed from
          this label" and "Batch not entered" are different statements. */}
      <View style={styles.chips}>
        <StatusChip presentation={item.identity} />
        <StatusChip presentation={item.formulation} />
        <StatusChip presentation={item.batch} />
      </View>

      {/* `04` Phase 2.1's second exit criterion, on the row. A person has to be able to see
          which items need something without knowing to filter for it, so the reasons are here
          rather than only behind the control above. No count and no badge (`02`).

          Inside a sunken well, which is the design system saying "this is about the record" -
          the same treatment a read-only block gets everywhere else, rather than a tone, because
          a tone here would be a colour claiming something about the medicine. */}
      {item.attention.length === 0 ? null : (
        <View style={styles.attention}>
          {item.attention.map((line, index) => (
            <Typography key={`attention-${String(index)}`} role="caption" colour="secondary">
              {line}
            </Typography>
          ))}
        </View>
      )}

      {/* One primary action per card - opening the item - and the two shortcuts beside it.
          `18` wants one obvious next step, and "open" is the one that always exists. */}
      <View style={styles.actions}>
        <PrimaryButton label="Open this item" onPress={onOpen} />

        {/* Medicines only, and absent rather than disabled for everything else - a greyed-out
            control here would say a dose of shampoo is a thing Kynviora expects you to record. */}
        {medicine ? (
          <View style={styles.shortcuts}>
            {/* And absent again for a caregiver who was not granted `RECORD_DOSES`, which is a
                different absence for a different reason: the first says a dose of shampoo is not
                a thing, this one says the write would be refused (migration 0021). Both are
                withheld rather than drawn and disabled (DEC-045) - a greyed-out control on
                somebody else's medicine tells a caregiver what they are not trusted with, which
                is a fact about the permission model they did not need. */}
            {mayRecordDoses ? (
              <PrimaryButton
                label="Record what happened"
                variant="secondary"
                style={styles.shortcut}
                onPress={onRecord}
              />
            ) : null}
            {/* `04` Phase 4.1. Medicines only, for the same reason and one more: migration 0020
                refuses a schedule on a personal-care item outright. */}
            <PrimaryButton
              label="When do you take this?"
              variant="secondary"
              style={styles.shortcut}
              onPress={onSchedule}
            />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    addRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
    addButton: { flexGrow: 1, flexBasis: 150 },
    identity: { gap: SPACING.xxs },
    chips: { gap: SPACING.xs, alignItems: 'flex-start' },
    // A sunken well: "this is about the record". Deliberately not a tone - a coloured panel here
    // would be a colour claiming something about the medicine rather than about the row.
    attention: {
      gap: SPACING.xxs,
      padding: SPACING.md,
      borderRadius: RADIUS.md,
      backgroundColor: theme.sunken.background,
    },
    actions: { gap: SPACING.sm, marginTop: SPACING.xs },
    // Side by side where they fit and wrapped where they do not, which at a large font scale is
    // most of the time. `flexBasis` rather than a fixed width so a long label takes the row it
    // needs instead of clipping (`18`).
    shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
    shortcut: { flexGrow: 1, flexBasis: 150 },
    filters: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
    filter: {
      minHeight: MIN_TOUCH_TARGET_DP,
      justifyContent: 'center',
      paddingHorizontal: SPACING.lg,
      borderWidth: 1,
      borderRadius: RADIUS.pill,
      borderColor: theme.line.strong,
      backgroundColor: theme.surface.background,
    },
    filterOn: {
      borderColor: theme.selection.border,
      backgroundColor: theme.selection.background,
    },
    filterLabel: {
      fontSize: FONT_SIZE.caption,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    filterLabelOn: {
      color: theme.selection.foreground,
    },
    note: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
  });
