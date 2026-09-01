/**
 * Safety screen.
 *
 * Spec references: `04` Phase 7.1 (assessment states and inbox; filters by profile, urgency and
 * status), `09` (product states; a coverage statement accompanies every result), `18` (never
 * present an absence of findings as reassurance), `23` D-005 (evidence level and urgency are never
 * combined) and D-014 (an absence of a matched rule must never render as approval), `11` and
 * DEC-010 (safety is server-authoritative), `BLK-006`, DEC-016.
 *
 * ONE LINE PER ITEM, NOT ONE PER ALERT
 * This screen used to list published alerts, which meant an item with no alert did not appear at
 * all - and a person reading it could not tell "checked, nothing matched" from "never checked".
 * `23` D-014 is about an absence rendering as approval, and an omission is the quietest way to do
 * it. Every item now has a line, and the line says which of the two it is.
 *
 * NOTHING IS PUBLISHABLE, AND THAT IS STILL THE DESIGN
 * `BLK-006` means no safety rule reaches a user without a qualified clinical or legal reviewer and
 * none exists; DEC-016 means every shipped regulatory fixture is deliberately rejected by the
 * Citation Gate. So every line here currently reads "not enough information", which is the honest
 * answer, and the coverage statement is on screen in every state - because "Kynviora found
 * nothing" and "there is nothing to find" are different sentences and only the first is true.
 *
 * NO COUNT, NO BADGE, NO RANKING
 * The filters narrow; they do not rank. There is no "3 items need action" anywhere on this screen
 * and no code path in this app that could compute a severity: the rule engine is server-side
 * (DEC-010) and this screen renders what a reviewer approved.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  presentSafetyState,
} from '@kynviora/presentation';
import { PRODUCT_SAFETY_STATES, type ProductSafetyState } from '@kynviora/domain';
import { safetyInboxView, type SafetyInboxLineView } from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Screen } from '@/components/Screen';
import { ResourceState } from '@/components/ScreenState';
import { StatusChip } from '@/components/StatusChip';

const EMPTY = { lines: [], totalItems: 0 } as const;

export default function SafetyScreen() {
  const { client } = useApi();
  const { activeProfileId } = useProfiles();

  /**
   * The state filter, as a set the user toggles.
   *
   * Held here rather than sent as a default, so an unfiltered screen is the one a person lands on.
   * A safety screen that opened pre-filtered would hide items without saying it had.
   */
  const [states, setStates] = useState<readonly ProductSafetyState[]>([]);

  const load = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.safetyInbox(activeProfileId, { states }),
    [client, activeProfileId, states],
  );

  const { resource, reload, refreshing } = useResource(load, {
    enabled: activeProfileId !== null,
    // Not empty when the shelf is empty - empty when this profile has no items at all. A filter
    // that matches nothing is a different screen from a profile with nothing on its shelf, and
    // the second is the only one the generic empty copy describes.
    isEmpty: (value) => value.totalItems === 0,
  });

  const view = useMemo(() => safetyInboxView(resource.value ?? EMPTY), [resource.value]);

  const onRetry = useCallback(() => {
    reload();
  }, [reload]);

  return (
    <Screen
      title="Safety"
      intro="Every item on this shelf, and what Kynviora can say about it today."
      onRefresh={onRetry}
      refreshing={refreshing}
    >
      <ResourceState resource={resource} onRetry={onRetry} />

      {/* Filters, offered as the five states rather than as "show me the bad ones". Each is a
          toggle with its own label and accessibility state, never colour alone (`18`). */}
      <View style={styles.filters}>
        {PRODUCT_SAFETY_STATES.map((state) => {
          const chosen = states.includes(state);
          const presentation = presentSafetyState(state);
          return (
            <Pressable
              key={state}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: chosen }}
              accessibilityLabel={presentation.label}
              accessibilityHint={presentation.description}
              onPress={() => {
                setStates((current) =>
                  chosen ? current.filter((s) => s !== state) : [...current, state],
                );
              }}
              style={[
                styles.filter,
                {
                  backgroundColor: chosen
                    ? LIGHT_THEME.informational.background
                    : LIGHT_THEME.surface.background,
                  borderColor: chosen
                    ? LIGHT_THEME.informational.border
                    : LIGHT_THEME.surface.border,
                },
              ]}
            >
              <Text style={styles.filterLabel}>
                {chosen ? '☑  ' : '☐  '}
                {presentation.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Says the list is a subset without counting anything urgent. `02` refuses the badge; this
          is the size of the shelf, which is a fact about the shelf. */}
      {view.filtered ? (
        <Text style={styles.coverage}>
          Showing {view.lines.length} of {view.totalItems} items on this shelf.
        </Text>
      ) : null}

      {view.lines.map((line) => (
        <SafetyRow key={line.ownedItemId} line={line} />
      ))}

      {/* Rendered in every state, including the empty one. `09` requires the coverage statement
          to accompany the result rather than be inferred from its absence. */}
      <Text style={styles.coverage}>{view.coverageStatement}</Text>
    </Screen>
  );
}

function SafetyRow({ line }: { readonly line: SafetyInboxLineView }) {
  return (
    <View style={styles.alert}>
      <Text accessibilityRole="header" style={styles.name}>
        {line.displayName}
      </Text>

      {/* The state, and beside it - never merged with it - urgency and evidence. `23` D-005, and
          Phase 7.1's second exit criterion. A line with no live alert shows neither, because it
          has neither: a default chip would be a claim nobody made. */}
      <StatusChip presentation={line.state} showDescription />
      {line.urgency === null ? null : <StatusChip presentation={line.urgency} showDescription />}
      {line.evidence === null ? null : <StatusChip presentation={line.evidence} showDescription />}

      {/* When it was last looked at, or that it never has been. The absence is the point: an item
          Kynviora has never assessed must not read like one it checked this morning. */}
      <Text style={styles.coverage}>
        {line.lastAssessedAt === null
          ? 'Kynviora has not assessed this item.'
          : `Last assessed ${line.lastAssessedAt.slice(0, 10)}.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  alert: {
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
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  filter: {
    minHeight: MIN_TOUCH_TARGET_DP,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  filterLabel: {
    fontSize: FONT_SIZE.caption,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  coverage: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
