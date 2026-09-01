/**
 * The frame every primary destination shares.
 *
 * Spec references: `06` (five primary destinations, each defining its states), `18` (one heading
 * per screen, announced as a header; type scale and spacing from the tokens).
 *
 * Exists so the heading, the introduction and the safe-area handling are written once. Repeated
 * per screen they drift, and the thing that drifts first is the accessibility role on the
 * heading - which is invisible until somebody is navigating by headings.
 */

import { Text, StyleSheet, ScrollView, RefreshControl, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LIGHT_THEME, SPACING, FONT_SIZE, LINE_HEIGHT_MULTIPLIER } from '@kynviora/presentation';
import type { ReactNode } from 'react';

export interface ScreenProps {
  readonly title: string;
  /** One or two sentences saying what this screen is for. `18`: familiar words first. */
  readonly intro?: string;
  readonly children: ReactNode;
  /** Pull to refresh. Present only where there is something to refresh. */
  readonly onRefresh?: () => void;
  readonly refreshing?: boolean;
  readonly contentStyle?: ViewStyle;
}

export function Screen({
  title,
  intro,
  children,
  onRefresh,
  refreshing = false,
  contentStyle,
}: ScreenProps) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={[styles.content, contentStyle]}
        refreshControl={
          onRefresh === undefined ? undefined : (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          )
        }
      >
        <Text accessibilityRole="header" style={styles.heading}>
          {title}
        </Text>
        {intro === undefined ? null : <Text style={styles.intro}>{intro}</Text>}
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: LIGHT_THEME.surface.background },
  content: { padding: SPACING.lg, gap: SPACING.md },
  heading: {
    fontSize: FONT_SIZE.heading,
    fontWeight: '700',
    color: LIGHT_THEME.surface.foreground,
  },
  intro: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
