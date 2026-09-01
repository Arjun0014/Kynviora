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
 * RECORDING A DOSE LIVES HERE BECAUSE THE MEDICINE DOES
 * `04` Phase 4.3 is about recording what happened, and what happened, happened to one of these.
 * Phase 4.2's reminders need a device (`BLK-002`), so there is no schedule strip to hang it off -
 * and an item's own row is where a person looking for "the one I take in the morning" already is.
 * The control is offered on medicines only: a dose is a medicine's idea, and a recorded dose of
 * shampoo is a row nobody can read back meaningfully.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import type { DoseEventKind } from '@kynviora/domain';
import {
  doseHistory,
  screenStateForFailure,
  shelfView,
  type DoseHistoryView,
  type ShelfItemView,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Screen } from '@/components/Screen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ResourceState } from '@/components/ScreenState';
import { StatusChip } from '@/components/StatusChip';
import { RecordDose } from '@/features/doses/RecordDose';

const EMPTY_HISTORY: DoseHistoryView = { lines: [], unreadableCount: 0, emptyMessage: '' };

export default function ShelfScreen() {
  const { client } = useApi();
  const { activeProfileId } = useProfiles();

  const [recording, setRecording] = useState<ShelfItemView | null>(null);
  const [recordState, setRecordState] = useState<ScreenStateKind | null>(null);
  const [recordMessage, setRecordMessage] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);

  const load = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.listItems({ profileId: activeProfileId }),
    [client, activeProfileId],
  );

  const { resource, reload, refreshing } = useResource(load, {
    enabled: activeProfileId !== null,
    isEmpty: (value) => value.items.length === 0,
  });

  const view = useMemo(
    () =>
      resource.value === null ? null : shelfView(resource.value.items, resource.value.nextCursor),
    [resource.value],
  );

  /**
   * What has been recorded for the item being looked at.
   *
   * A separate resource, because it is a separate question and a separate failure: the shelf
   * loading and the history not is a real state, and folding them together would take the whole
   * screen down when one list did not arrive.
   */
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

  const onRetry = useCallback(() => {
    reload();
  }, [reload]);

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

      // Generated once for this attempt, so a retry of the same intent replays rather than
      // recording a second event. `04` Phase 4.3 makes that an exit criterion, because an event
      // created offline may be uploaded more than once - and a duplicated history is a false
      // record of what somebody did.
      const idempotencyKey = crypto.randomUUID();

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
          setRecordState(screenStateForFailure(outcome));
          setRecordMessage(outcome.kind === 'REFUSED' ? outcome.message : null);
        },
        () => {
          setRecordState('RECOVERABLE_ERROR');
          setRecordMessage(null);
        },
      );
    },
    [client, reloadHistory],
  );

  const onCloseRecord = useCallback(() => {
    setRecording(null);
    setRecordState(null);
    setRecordMessage(null);
    setRecorded(false);
  }, []);

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
        />
      </Screen>
    );
  }

  return (
    <Screen
      title="Shelf"
      intro="Medicines and personal-care products, with how well Kynviora knows each one."
      onRefresh={onRetry}
      refreshing={refreshing}
    >
      <ResourceState resource={resource} onRetry={onRetry} />

      {view === null
        ? null
        : view.items.map((item) => (
            <ShelfRow
              key={item.id}
              item={item}
              onRecord={() => {
                setRecording(item);
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

function ShelfRow({
  item,
  onRecord,
}: {
  readonly item: ShelfItemView;
  readonly onRecord: () => void;
}) {
  return (
    <View style={styles.item}>
      <Text accessibilityRole="header" style={styles.name}>
        {item.displayName}
      </Text>
      {item.brand === null ? null : <Text style={styles.brand}>{item.brand}</Text>}

      {/* Three chips, never one. `18`: "Product identity confirmed", "Formula confirmed from
          this label" and "Batch not entered" are different statements. */}
      <View style={styles.chips}>
        <StatusChip presentation={item.identity} />
        <StatusChip presentation={item.formulation} />
        <StatusChip presentation={item.batch} />
      </View>

      {/* Medicines only, and absent rather than disabled for everything else - a greyed-out
          control here would say a dose of shampoo is a thing Kynviora expects you to record. */}
      {item.itemKind === 'MEDICINE' ? (
        <PrimaryButton label="Record what happened" variant="secondary" onPress={onRecord} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  item: {
    gap: SPACING.sm,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  name: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  brand: {
    fontSize: FONT_SIZE.caption,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  chips: { gap: SPACING.xs },
  note: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
