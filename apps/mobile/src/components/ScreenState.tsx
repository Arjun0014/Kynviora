/**
 * Screen state presenter.
 *
 * Spec references: `06` ("Every critical route must define: loading, empty, success,
 * partial/insufficient data, offline, permission denied, recoverable error, authorization lost,
 * stale data, corrected/superseded"), `24` (UX done criteria), `12` (error handling classes).
 *
 * Modelling these as a closed union means a screen cannot quietly ship with only a success path:
 * the switch must handle every state or it fails to compile.
 */

import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { LIGHT_THEME, SPACING, FONT_SIZE, LINE_HEIGHT_MULTIPLIER } from '@kynviora/presentation';
import { PrimaryButton } from './PrimaryButton';

export type ScreenStateKind =
  | 'loading'
  | 'empty'
  | 'partial'
  | 'offline'
  | 'permission-denied'
  | 'error'
  | 'authorization-lost'
  | 'stale';

export interface ScreenStateProps {
  readonly kind: ScreenStateKind;
  /** Overrides the default copy where a screen has something more specific to say. */
  readonly message?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}

/**
 * Default copy per state.
 *
 * Plain language, one idea per sentence, and never blaming the user - `18` requires familiar
 * words first and forbids shaming or fear-driven phrasing.
 */
const DEFAULT_COPY: Record<ScreenStateKind, string> = {
  loading: 'Loading.',
  empty: 'Nothing here yet.',
  partial: 'Some information is missing. What is shown may be incomplete.',
  offline:
    'You are offline. This shows what Kynviora last saved on this device, which may not be current.',
  'permission-denied':
    'Kynviora does not have permission for this. You can grant it in your device settings, or continue without it.',
  error: 'Something went wrong. You can try again.',
  'authorization-lost': 'You are no longer signed in. Sign in again to continue.',
  stale: 'This information may be out of date. Kynviora could not check for updates.',
};

export function ScreenState({ kind, message, onRetry, retryLabel }: ScreenStateProps) {
  const text = message ?? DEFAULT_COPY[kind];

  // An offline or stale screen is informational, not a failure: spec 12 requires low-risk work
  // to continue offline, so it uses a neutral surface rather than an error tone.
  const tone =
    kind === 'error' || kind === 'authorization-lost'
      ? LIGHT_THEME.attention
      : LIGHT_THEME.surfaceMuted;

  return (
    <View
      accessible
      // `polite` rather than `assertive`: spec 18 requires meaningful status changes to be
      // announced politely, not to interrupt what the user is already doing.
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      accessibilityLabel={text}
      style={[styles.container, { backgroundColor: tone.background, borderColor: tone.border }]}
    >
      {kind === 'loading' ? (
        <ActivityIndicator
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={styles.spinner}
        />
      ) : null}

      <Text style={[styles.message, { color: tone.foreground }]}>{text}</Text>

      {onRetry ? (
        <PrimaryButton
          label={retryLabel ?? 'Try again'}
          onPress={onRetry}
          variant="secondary"
          style={styles.retry}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: SPACING.lg,
    borderRadius: SPACING.sm,
    borderWidth: 1,
    alignItems: 'center',
  },
  spinner: {
    marginBottom: SPACING.md,
  },
  message: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    textAlign: 'center',
  },
  retry: {
    marginTop: SPACING.lg,
  },
});
