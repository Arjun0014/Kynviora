/**
 * Shelf screen.
 *
 * Spec references: `06` (Shelf is a primary destination and defines every state), `18` (identity,
 * formula and batch certainty stay distinct), `02` (no aggregate trust score), `13` (a profile ID
 * narrows a result set and never grants access).
 *
 * Each item carries three separate status chips because they are three separate statements. A
 * single "verified" badge would be the aggregate Trust Passport score `02` forbids, with the
 * number left off - and it would say "this product is fine" using evidence that only covers
 * whether Kynviora recognised the barcode.
 *
 * The list is exactly what the server returned. The profile ID in the request narrows it; row-
 * level security decides it. A profile this account cannot see comes back as an empty page rather
 * than a refusal, which is why an empty shelf and an unauthorised one look the same here.
 */

import { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LIGHT_THEME, SPACING, FONT_SIZE, LINE_HEIGHT_MULTIPLIER } from '@kynviora/presentation';
import { shelfView, type ShelfItemView } from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Screen } from '@/components/Screen';
import { ResourceState } from '@/components/ScreenState';
import { StatusChip } from '@/components/StatusChip';

export default function ShelfScreen() {
  const { client } = useApi();
  const { activeProfileId } = useProfiles();

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

  const onRetry = useCallback(() => {
    reload();
  }, [reload]);

  return (
    <Screen
      title="Shelf"
      intro="Medicines and personal-care products, with how well Kynviora knows each one."
      onRefresh={onRetry}
      refreshing={refreshing}
    >
      <ResourceState resource={resource} onRetry={onRetry} />

      {view === null ? null : view.items.map((item) => <ShelfRow key={item.id} item={item} />)}

      {view !== null && view.hasMore ? (
        <Text style={styles.note}>
          This is the first page. Kynviora has more products on this shelf.
        </Text>
      ) : null}
    </Screen>
  );
}

function ShelfRow({ item }: { readonly item: ShelfItemView }) {
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
