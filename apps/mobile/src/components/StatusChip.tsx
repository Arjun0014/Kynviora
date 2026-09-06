/**
 * Status chip: the single component through which every status reaches a user.
 *
 * Spec references: `18` (never colour alone, minimum touch target, screen-reader semantics),
 * `12` (accessibility behaviour belongs in component APIs).
 *
 * The component takes a `StatusPresentation` rather than a colour and a string, so a caller
 * cannot construct a chip that carries meaning by colour alone - the label and icon come from
 * the presentation and are always rendered.
 */

import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import type { StatusPresentation } from '@kynviora/presentation';
import { useTheme } from '@/theme/ThemeProvider';
import {
  SPACING,
  RADIUS,
  FONT_SIZE,
  MAX_SUPPORTED_FONT_SCALE,
  typeStyle,
} from '@kynviora/presentation';

export interface StatusChipProps {
  readonly presentation: StatusPresentation;
  /** Show the longer description beneath the label. Used on detail screens. */
  readonly showDescription?: boolean;
}

/**
 * Glyphs standing in for a real icon set.
 *
 * Chosen so each is distinguishable by **shape** rather than colour, which is what makes the
 * status readable in greyscale and to a user who cannot distinguish the tones.
 */
const ICON_GLYPH: Record<StatusPresentation['iconName'], string> = {
  'check-circle': '✓',
  'info-circle': 'ℹ',
  'question-circle': '?',
  'alert-triangle': '⚠',
  'alert-octagon': '❗',
  clock: '⏱',
  shield: '⛉',
  'shield-question': '⍰',
  document: '≡',
  scales: '⚖',
  ban: '⊘',
  'eye-off': '∅',
};

export function StatusChip({ presentation, showDescription = false }: StatusChipProps) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  // Clamped for the same reason as `scaledFontSize`: beyond the tested range a chip can clip its
  // own label, and spec 18 makes clipped content in a critical journey a release gate.
  const scale = Math.max(1, Math.min(fontScale, MAX_SUPPORTED_FONT_SCALE));
  const tone = theme[presentation.tone];

  return (
    <View
      // The whole chip is one accessibility node with one announcement, rather than the icon and
      // label being read as two separate fragments.
      accessible
      accessibilityRole="text"
      accessibilityLabel={presentation.accessibilityLabel}
      style={[styles.container, { backgroundColor: tone.background, borderColor: tone.border }]}
    >
      <View style={styles.row}>
        <Text
          // The glyph duplicates information already in the label, so it is hidden from screen
          // readers to avoid announcing a meaningless symbol.
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={[styles.icon, { color: tone.foreground, fontSize: FONT_SIZE.body * scale }]}
        >
          {ICON_GLYPH[presentation.iconName]}
        </Text>

        <Text style={[typeStyle('label', scale), styles.label, { color: tone.foreground }]}>
          {presentation.label}
        </Text>
      </View>

      {showDescription ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={[typeStyle('caption', scale), styles.description, { color: tone.foreground }]}
        >
          {presentation.description}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: RADIUS.pill,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    // No fixed height: the chip must grow with the system font scale rather than clipping.
    alignSelf: 'flex-start',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // Wraps rather than truncating when the label is long at a large font scale.
    flexWrap: 'wrap',
  },
  icon: {
    marginRight: SPACING.sm,
    fontWeight: '600',
  },
  label: {
    flexShrink: 1,
  },
  description: {
    marginTop: SPACING.xs,
  },
});
