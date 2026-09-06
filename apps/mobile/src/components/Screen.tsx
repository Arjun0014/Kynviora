/**
 * The frame every primary destination shares.
 *
 * Spec references: `06` (five primary destinations, each defining its states), `18` (one heading
 * per screen, announced as a header; type scale and spacing from the tokens), DEC-130.
 *
 * Exists so the heading, the introduction and the safe-area handling are written once. Repeated
 * per screen they drift, and the thing that drifts first is the accessibility role on the
 * heading - which is invisible until somebody is navigating by headings.
 *
 * WHY THE GROUND IS `canvas` AND A CARD IS `surface`
 * So that a card reads as a card rather than as more page. On light that is one shade of
 * separation; on dark it is the whole mechanism, because a shadow on a near-black ground is
 * invisible (`docs/design/DESIGN_SYSTEM.md`, section 5).
 *
 * BOTH EDGES, NOT ONLY THE BOTTOM
 * The navigator drew a header until 2026-09-07 and that header was reserving the top inset. With
 * it gone - two headings saying "Today", one above the other, is `18`'s one-heading rule broken by
 * the navigator - the screen's first line was drawn under the status bar. The inset belongs to
 * whatever is outermost, and that is now this.
 *
 * WHAT `eyebrow` IS FOR
 * `06` requires any screen showing medicine, product, alert or care information to make the
 * current person clear. It sits **above** the heading rather than below it, because that is where
 * a person looks for whose screen this is, and it is announced as part of the heading so a screen
 * reader lands on "Shelf, for Anita" rather than on two unrelated fragments.
 */

import { StyleSheet, ScrollView, RefreshControl, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SPACING, type Theme } from '@kynviora/presentation';
import type { ReactNode } from 'react';
import { useThemedStyles } from '@/theme/ThemeProvider';
import { Typography } from './Typography';

export interface ScreenProps {
  readonly title: string;
  /** Whose screen this is. `06`: the current person is clear on every screen that shows care data. */
  readonly eyebrow?: string | null;
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
  eyebrow,
  intro,
  children,
  onRefresh,
  refreshing = false,
  contentStyle,
}: ScreenProps) {
  const styles = useThemedStyles(makeStyles);
  const named = eyebrow !== undefined && eyebrow !== null && eyebrow.trim() !== '';

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={[styles.content, contentStyle]}
        refreshControl={
          onRefresh === undefined ? undefined : (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          )
        }
      >
        <View style={styles.header}>
          {named ? (
            <Typography role="overline" colour="secondary" decorative>
              {eyebrow}
            </Typography>
          ) : null}
          <Typography
            role="heading"
            heading
            {...(named ? { accessibilityLabel: `${title}, for ${eyebrow}` } : {})}
          >
            {title}
          </Typography>
          {intro === undefined ? null : (
            <Typography role="body" colour="secondary">
              {intro}
            </Typography>
          )}
        </View>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: theme.canvas.background },
    content: { padding: SPACING.lg, gap: SPACING.lg, paddingBottom: SPACING.xxl },
    // The heading block is one idea, so its parts sit closer to each other than to what follows.
    header: { gap: SPACING.xxs, marginBottom: SPACING.xs },
  });
