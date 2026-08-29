/**
 * Primary action button.
 *
 * Spec references: `18` (48dp minimum touch target, no hidden gestures, one primary action on
 * high-impact safety screens, confirm destructive actions).
 *
 * The 48dp minimum is enforced by `minHeight`/`minWidth` rather than by a fixed height, so the
 * target grows with the system font scale instead of clipping its own label.
 */

import { Pressable, Text, StyleSheet, useWindowDimensions, type ViewStyle } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  MIN_TOUCH_TARGET_DP,
  MAX_SUPPORTED_FONT_SCALE,
} from '@kynviora/presentation';

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
  readonly variant?: 'primary' | 'secondary';
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
  const { fontScale } = useWindowDimensions();
  const scale = Math.max(1, Math.min(fontScale, MAX_SUPPORTED_FONT_SCALE));
  const tone = variant === 'primary' ? LIGHT_THEME.informational : LIGHT_THEME.surfaceMuted;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: tone.background,
          borderColor: tone.border,
          // Disabled state is conveyed by opacity AND the accessibilityState above, never by
          // colour alone (spec 18).
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
          minHeight: Math.max(MIN_TOUCH_TARGET_DP, MIN_TOUCH_TARGET_DP * scale * 0.75),
        },
        style,
      ]}
    >
      <Text style={[styles.label, { color: tone.foreground, fontSize: FONT_SIZE.body * scale }]}>
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
    borderRadius: SPACING.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontWeight: '600',
    textAlign: 'center',
  },
});
