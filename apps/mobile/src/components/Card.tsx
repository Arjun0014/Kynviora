/**
 * One idea, on one surface.
 *
 * Spec references: `18` (one primary action on a high-impact screen; meaning never carried by
 * colour alone), `02` (no aggregate score, nothing ranked), `06` (a card is complete enough to
 * act on), DEC-130.
 *
 * WHY A CARD TAKES A TONE AND NOT A COLOUR
 * Same reason `StatusChip` takes a presentation: a caller that could pass a colour could paint a
 * card in a hue that means something without saying what, and the seven tones are the closed set
 * that mean anything at all. `tone` defaults to the plain surface, which is what almost every
 * card should be - a card that is coloured is saying something, and most cards are not.
 *
 * WHY THE SHADOW IS DECLARED AND NOT DRAWN ON DARK
 * A shadow on a near-black ground is invisible; the dark theme separates its levels by colour
 * instead (`docs/design/DESIGN_SYSTEM.md`, section 5). So the elevation is applied only in the
 * light theme, and in the dark one the surface colour and the border are doing the work. Both are
 * asserted by test - the ladder is four distinct colours on dark, and adjacent levels differ in
 * background or border in either theme.
 */

import { View, StyleSheet, type ViewStyle } from 'react-native';
import {
  ELEVATION,
  RADIUS,
  SPACING,
  type ChangeToneToken,
  type Theme,
} from '@kynviora/presentation';
import type { ReactNode } from 'react';
import { useTheme } from '@/theme/ThemeProvider';

export interface CardProps {
  readonly children: ReactNode;
  /**
   * Which tone this card is painted in.
   *
   * Absent means the plain surface, which is what a card that is not saying anything should be.
   *
   * `ChangeToneToken` rather than `ThemeToneToken`, so a card *about a difference between two
   * records* can carry the change tint the design language asks for. That widening is safe here
   * and deliberately not safe in `StatusChip`: a card is a container and says whatever its
   * contents say, while a chip renders a `StatusPresentation` whose tone is the codomain of a
   * **safety status** - and a safety status drawn in the change colour would be announcing a
   * difference where the screen asked what state a product is in (DEC-153).
   */
  readonly tone?: ChangeToneToken;
  /** How far off the ground. `card` is a card; `raised` is a sheet standing over one. */
  readonly level?: 'card' | 'raised';
  /**
   * Announce the card and its contents as one node.
   *
   * Off by default. A card is usually a container whose children are each worth announcing; a
   * card that is one statement should say so, and then it needs a label.
   */
  readonly accessibilityLabel?: string;
  readonly style?: ViewStyle;
}

export function Card({ children, tone, level = 'card', accessibilityLabel, style }: CardProps) {
  const theme = useTheme();
  const pair =
    tone === undefined ? (level === 'raised' ? theme.raised : theme.surface) : theme[tone];
  const elevation = ELEVATION[level];
  const lit = theme.name === 'LIGHT';

  return (
    <View
      {...(accessibilityLabel === undefined ? {} : { accessible: true, accessibilityLabel })}
      style={[
        styles.card,
        {
          backgroundColor: pair.background,
          borderColor: pair.border,
        },
        lit
          ? {
              elevation: elevation.android,
              shadowColor: '#000000',
              shadowOpacity: elevation.shadowOpacity,
              shadowRadius: elevation.shadowRadius,
              shadowOffset: { width: 0, height: elevation.shadowOffsetY },
            }
          : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    // Between the lines of one idea. Two ideas belong in two cards.
    gap: SPACING.sm,
  },
});

/** The card's own surface colours, for a child that has to match them. */
export function cardSurface(theme: Theme, tone?: ChangeToneToken) {
  return tone === undefined ? theme.surface : theme[tone];
}
