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
 * Phase 4.2's reminders need a device (`BLK-002`), so there is no schedule strip to hang it off -
 * and an item's own row is where a person looking for "the one I take in the morning" already is.
 * The control is offered on medicines only: a dose is a medicine's idea, and a recorded dose of
 * shampoo is a row nobody can read back meaningfully.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  manualEntryForm,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import { ITEM_KINDS, type DoseEventKind, type ItemKind } from '@kynviora/domain';
import {
  doseHistory,
  itemDetailScreenView,
  screenStateForFailure,
  shelfView,
  type DoseHistoryView,
  type ItemDetailScreenView,
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
import { AddItem } from '@/features/shelf/AddItem';
import { EditItem } from '@/features/shelf/EditItem';
import { ItemDetail } from '@/features/shelf/ItemDetail';

const EMPTY_HISTORY: DoseHistoryView = { lines: [], unreadableCount: 0, emptyMessage: '' };

export default function ShelfScreen() {
  const { client } = useApi();
  const { activeProfileId } = useProfiles();

  const [recording, setRecording] = useState<ShelfItemView | null>(null);
  const [recordState, setRecordState] = useState<ScreenStateKind | null>(null);
  const [recordMessage, setRecordMessage] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);

  /**
   * The item whose detail is open, or `null`.
   *
   * `04` Phase 2.1's detail is reached from the row rather than being its own destination, for
   * the reason the Lens and the alert detail are: an item detail with its own tab would be a
   * second list of the same things.
   */
  const [detailFor, setDetailFor] = useState<ShelfItemView | null>(null);

  /**
   * The category being added, or `null`.
   *
   * Holding the category rather than a boolean is what makes the form a form: `manualEntryForm`
   * decides which fields exist for which category, and a medicine asked for a "kind of product"
   * is the reduction to a generic note Phase 2.1's first exit criterion forbids.
   */
  const [adding, setAdding] = useState<ItemKind | null>(null);

  /**
   * Whether the open item is being edited.
   *
   * Reached from the detail rather than from the row, because a control on the list would let
   * somebody change a record they were not looking at - and the detail is where the three
   * verification chips say how much of it Kynviora actually knows.
   */
  const [editing, setEditing] = useState(false);

  /**
   * The filter, as the two questions it actually is.
   *
   * `null` is unfiltered, and that is what a person lands on. A shelf that opened pre-filtered
   * would hide items without saying it had - the Safety screen's rule, for the same reason.
   */
  const [attention, setAttention] = useState<'NEEDS_VERIFICATION' | 'NEEDS_REVIEW' | null>(null);

  const load = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () =>
            client.listItems({
              profileId: activeProfileId,
              ...(attention === null ? {} : { attention }),
            }),
    [client, activeProfileId, attention],
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
      : { projectionKey: `items:${activeProfileId}:${attention ?? 'all'}` }),
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

  if (adding !== null && activeProfileId !== null) {
    return (
      <Screen title="Shelf" intro="Only the name is needed.">
        <AddItem
          itemKind={adding}
          profileId={activeProfileId}
          onSaved={onRetry}
          onClose={() => {
            setAdding(null);
          }}
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
          onEdit={() => {
            setEditing(true);
          }}
          onClose={() => {
            setDetailFor(null);
            setEditing(false);
          }}
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

      {/* Above the filters and above the list, so it is reachable from the empty shelf as well -
          which is the state every new household starts in and the one where it matters most. */}
      {activeProfileId === null
        ? null
        : ITEM_KINDS.map((kind) => (
            <PrimaryButton
              key={kind}
              label={manualEntryForm(kind).heading}
              variant="secondary"
              onPress={() => {
                setAdding(kind);
              }}
            />
          ))}

      {/* Two filters, each named as the question it asks. They narrow and they do not rank -
          which of two people's medicines matters more is not a judgement this screen makes. */}
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
              <Text style={styles.filterLabel}>{active ? `${label} - on` : label}</Text>
            </Pressable>
          );
        })}
      </View>
      {attention === null ? null : (
        <Text style={styles.note}>
          This is a filtered list. Items Kynviora has nothing outstanding about are not shown.
        </Text>
      )}

      {view === null
        ? null
        : view.items.map((item) => (
            <ShelfRow
              key={item.id}
              item={item}
              onOpen={() => {
                setDetailFor(item);
              }}
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
  onOpen,
  onRecord,
}: {
  readonly item: ShelfItemView;
  readonly onOpen: () => void;
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

      {/* `04` Phase 2.1's second exit criterion, on the row. A person has to be able to see
          which items need something without knowing to filter for it, so the reasons are here
          rather than only behind the control above. No count and no badge (`02`). */}
      {item.attention.length === 0 ? null : (
        <View style={styles.attention}>
          {item.attention.map((line, index) => (
            <Text key={`attention-${String(index)}`} style={styles.note}>
              {line}
            </Text>
          ))}
        </View>
      )}

      <PrimaryButton label="Open this item" variant="secondary" onPress={onOpen} />

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
  attention: { gap: 2 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  filter: {
    minHeight: MIN_TOUCH_TARGET_DP,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  filterOn: {
    borderColor: LIGHT_THEME.informational.border,
    backgroundColor: LIGHT_THEME.informational.background,
  },
  filterLabel: {
    fontSize: FONT_SIZE.caption,
    color: LIGHT_THEME.surface.foreground,
  },
  note: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
