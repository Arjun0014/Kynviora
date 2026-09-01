/**
 * Safety screen.
 *
 * Spec references: `09` (a coverage statement accompanies every result), `18` (never present an
 * absence of findings as reassurance), `23` D-005 (evidence level and urgency are never
 * combined), `11` and DEC-010 (safety is server-authoritative), `BLK-006`, DEC-016.
 *
 * THIS SCREEN IS CURRENTLY EMPTY, AND THAT IS THE DESIGN
 * Nothing is publishable. `BLK-006` means no safety rule reaches a user without a qualified
 * clinical or legal reviewer and none exists; DEC-016 means every shipped regulatory fixture is
 * deliberately rejected by the Citation Gate. So this screen shows no alerts against any profile,
 * and the coverage statement is on screen whether or not there are any - because "Kynviora found
 * nothing" and "there is nothing to find" are different sentences and only the first is true.
 *
 * Each alert shows urgency, evidence and match confidence as three separate chips. There is no
 * severity here, and no code path in this app that could compute one: the rule engine is
 * server-side (DEC-010) and this screen renders what a reviewer approved.
 */

import { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LIGHT_THEME, SPACING, FONT_SIZE, LINE_HEIGHT_MULTIPLIER } from '@kynviora/presentation';
import { safetyView, type AlertView } from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useResource } from '@/api/useResource';
import { Screen } from '@/components/Screen';
import { ResourceState } from '@/components/ScreenState';
import { StatusChip } from '@/components/StatusChip';

export default function SafetyScreen() {
  const { client } = useApi();

  // No profile parameter. The route returns exactly what row-level security admits, which is
  // `13`'s "never trust a profile ID as proof of access" applied by construction.
  const load = useMemo(() => (client === null ? null : () => client.listAlerts()), [client]);

  const { resource, reload, refreshing } = useResource(load, {
    isEmpty: (value) => value.alerts.length === 0,
  });

  const view = useMemo(() => safetyView(resource.value?.alerts ?? []), [resource.value]);

  const onRetry = useCallback(() => {
    reload();
  }, [reload]);

  return (
    <Screen
      title="Safety"
      intro="Reviewed safety assessments and how supported jurisdictions treat your products."
      onRefresh={onRetry}
      refreshing={refreshing}
    >
      <ResourceState resource={resource} onRetry={onRetry} />

      {view.alerts.map((alert) => (
        <AlertRow key={alert.id} alert={alert} />
      ))}

      {/* Rendered in every state, including the empty one. `09` requires the coverage statement
          to accompany the result rather than be inferred from its absence. */}
      <Text style={styles.coverage}>{view.coverageStatement}</Text>
    </Screen>
  );
}

function AlertRow({ alert }: { readonly alert: AlertView }) {
  return (
    <View style={styles.alert}>
      {/* Urgency, evidence and match, side by side and never merged. `23` D-005. */}
      <StatusChip presentation={alert.urgency} showDescription />
      <StatusChip presentation={alert.evidence} showDescription />
      <StatusChip presentation={alert.match} />
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
  coverage: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
