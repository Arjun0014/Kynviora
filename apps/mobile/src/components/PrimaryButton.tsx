/**
 * An action.
 *
 * Spec references: `18` (48dp minimum touch target, no hidden gestures, one primary action on
 * high-impact safety screens, confirm destructive actions), DEC-130, DEC-131.
 *
 * The 48dp minimum is enforced by `minHeight`/`minWidth` rather than by a fixed height, so the
 * target grows with the system font scale instead of clipping its own label.
 *
 * THREE VARIANTS, AND WHAT EACH ONE CLAIMS
 * `primary` is the one action a screen is about, and it is the theme's accent - **contrast rather
 * than hue**, because `18` reserves hue for state and an accent that happened to be green or
 * amber would be a fourth thing on a screen already using both to say something about a medicine.
 * `secondary` is everything else a person may do here. `destructive` is `action`-toned and is the
 * only variant that carries a semantic colour, because the thing it does is the thing that colour
 * means; it still says what it does in words, and the confirmation is a separate screen.
 *
 * WHY THE HAPTIC IS HERE AND NOT AT THE CALL SITE
 * A press is a press. Putting it in the component means every control feels the same and no
 * screen has to remember; and because the engine is a recording no-op in this build (`DEV-070`),
 * what this actually buys today is that the call sites are correct for the day one is wired.
 */

import { Pressable, Text, StyleSheet, useWindowDimensions, type ViewStyle } from 'react-native';
import {
  MAX_SUPPORTED_FONT_SCALE,
  MIN_TOUCH_TARGET_DP,
  RADIUS,
  SPACING,
  typeStyle,
} from '@kynviora/presentation';
import { useTheme } from '@/theme/ThemeProvider';
import { haptic } from '@/platform/haptics';

export interface PrimaryButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  /**
   * Hint read after the label by a screen reader.
   *
   * Used where the outcome is not obvious from the label alone, which `18` requires for
   * high-impact actions.
   */
  readonly accessibilityHint?: string;
  readonly disabled?: boolean;
  readonly variant?: 'primary' | 'secondary' | 'destructive';
  readonly style?: ViewStyle;
}

export function PrimaryButton({
  label,
  onPress,
  accessibilityHint,
  disabled = false,
  variant = 'primary',
  style,
}: PrimaryButtonProps) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.max(1, Math.min(fontScale, MAX_SUPPORTED_FONT_SCALE));
  // A disabled control recedes rather than dimming. The accent is near-black on light and
  // near-white on dark, and half of either is a solid grey slab - which on a screen where it is the
  // only filled shape reads as the loudest thing there, saying "press me" about the one control
  // that cannot be pressed. Disabled takes the muted surface instead, which reads as "not yet".
  const tone = disabled
    ? theme.surfaceMuted
    : variant === 'primary'
      ? theme.accent
      : variant === 'destructive'
        ? theme.action
        : theme.surface;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        // `selection` rather than `confirm`: pressing a control is not the confirmation of
        // anything, and the two must not feel the same or the second stops meaning anything.
        haptic('selection');
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: tone.background,
          borderColor: disabled || variant === 'secondary' ? theme.line.strong : tone.border,
          // Dimmed as well as recessed, and announced by the `accessibilityState` above - never by
          // appearance alone (`18`). The dimming is lighter now that the colour is doing work.
          opacity: disabled ? 0.65 : pressed ? 0.85 : 1,
          minHeight: Math.max(MIN_TOUCH_TARGET_DP, MIN_TOUCH_TARGET_DP * scale * 0.75),
        },
        style,
      ]}
    >
      <Text style={[typeStyle('label', fontScale), styles.label, { color: tone.foreground }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: MIN_TOUCH_TARGET_DP,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    textAlign: 'center',
  },
});
