/**
 * Screen state presenter.
 *
 * Spec references: `06` (every critical route defines its states), `18` (meaning is never carried
 * by colour alone; status is announced politely), `12` (error handling classes), `24` (UX done
 * criteria).
 *
 * The union and every word in it live in `@kynviora/presentation`, not here. `apps/**` is
 * excluded from the test run and there is no renderer available (`BLK-002`), so copy defined in
 * this file would be the one family of user-visible strings in the codebase that no scan ever
 * looks at. This component renders; it decides nothing.
 */

import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import {
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  presentScreenState,
  screenStateAccessibilityLabel,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import type { Resource } from '@kynviora/contracts';
import { PrimaryButton } from './PrimaryButton';
import { useTheme } from '@/theme/ThemeProvider';

export interface ScreenStateProps {
  readonly state: ScreenStateKind;
  /**
   * Overrides the state's own description.
   *
   * Used for a server-supplied refusal message, which `errors.ts` has already made client-safe.
   * Never used to invent a reason the server withheld.
   */
  readonly message?: string | null | undefined;
  readonly onRetry?: () => void;
}

export function ScreenState({ state, message, onRetry }: ScreenStateProps) {
  const theme = useTheme();
  const presentation = presentScreenState(state);
  const tone = theme[presentation.tone];
  const description = message ?? presentation.description;

  return (
    <View
      accessible
      // `polite` rather than `assertive`: `18` requires meaningful status changes to be announced
      // without interrupting what the user is already doing.
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      accessibilityLabel={
        message === undefined || message === null
          ? screenStateAccessibilityLabel(state)
          : `${presentation.label}. ${message}`
      }
      style={[styles.container, { backgroundColor: tone.background, borderColor: tone.border }]}
    >
      {state === 'LOADING' ? (
        <ActivityIndicator
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={styles.spinner}
        />
      ) : null}

      {/* The label always renders. `18`: meaning is never carried by an icon or colour alone. */}
      <Text style={[styles.label, { color: tone.foreground }]}>{presentation.label}</Text>
      <Text style={[styles.message, { color: tone.foreground }]}>{description}</Text>

      {/* Offered only where the state says a retry could change the answer. */}
      {onRetry !== undefined && presentation.retryLabel !== null ? (
        <PrimaryButton
          label={presentation.retryLabel}
          onPress={onRetry}
          variant="secondary"
          style={styles.retry}
        />
      ) : null}
    </View>
  );
}

/**
 * Render a resource's state, or `null` when the resource is showing content on its own.
 *
 * `READY` is the one state with nothing to say: the content is the message. Every other state
 * either replaces the content or annotates it, and both need to be visible.
 */
export function ResourceState({
  resource,
  onRetry,
}: {
  readonly resource: Resource<unknown>;
  readonly onRetry?: () => void;
}) {
  if (resource.state === 'READY') return null;
  return (
    <ScreenState
      state={resource.state}
      message={resource.message}
      {...(onRetry === undefined ? {} : { onRetry })}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    padding: SPACING.lg,
    borderRadius: SPACING.sm,
    borderWidth: 1,
    alignItems: 'center',
    gap: SPACING.xs,
  },
  spinner: {
    marginBottom: SPACING.sm,
  },
  label: {
    fontSize: FONT_SIZE.bodyLarge,
    fontWeight: '600',
    textAlign: 'center',
  },
  message: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    textAlign: 'center',
  },
  retry: {
    marginTop: SPACING.md,
  },
});
