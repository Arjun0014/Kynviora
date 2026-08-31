/**
 * Medicine Reconciliation review screen.
 *
 * Spec references: `04` Phase 8.5, `09` (never instruct a stop/start/split/replace), `18` (plain
 * language, 48dp targets, limitations stated), `02` (a calm product).
 *
 * THE ONE THING THIS SCREEN MUST NOT DO
 * It must not look like it knows the answer. The domain has nowhere to store one and the schema
 * has no column for one, so this screen is the last place the exit criterion can be lost - and
 * losing it here takes no code at all. Bolding the new value, greying the old one, putting them
 * in a "before / after" arrow, or pre-selecting "I'm going with the new list" would each tell the
 * user which version to follow without a sentence saying so.
 *
 * So the two sides share a single style object rather than two that happen to match, the options
 * are rendered in the order the presentation layer gives them with nothing pre-selected, and
 * {@link RECONCILIATION_COPY.neitherIsChosen} is shown above the list rather than buried at the
 * bottom - a person who scrolls no further should still have read it.
 */

import { View, Text, StyleSheet, ScrollView } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  RECONCILIATION_COPY,
  RESOLUTION_OPTIONS,
  completionMessage,
  summarizeComparison,
} from '@kynviora/presentation';
import type { DifferenceKind, ReconciliationResolution } from '@kynviora/domain';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState, type ScreenStateKind } from '@/components/ScreenState';

export interface ReconciliationDifferenceView {
  readonly differenceId: string;
  readonly kind: DifferenceKind;
  readonly displayName: string;
  readonly field: string | null;
  readonly previousValue: string | null;
  readonly currentValue: string | null;
  readonly resolution: ReconciliationResolution | null;
}

export interface ReconciliationReviewProps {
  readonly state: ScreenStateKind | 'ready';
  readonly differences: readonly ReconciliationDifferenceView[];
  readonly completedUnresolvedCount: number | null;
  readonly onChooseResolution: (differenceId: string, resolution: ReconciliationResolution) => void;
  readonly onRetry?: () => void;
}

export function ReconciliationReview({
  state,
  differences,
  completedUnresolvedCount,
  onChooseResolution,
  onRetry,
}: ReconciliationReviewProps) {
  if (state !== 'ready') {
    return <ScreenState kind={state} {...(onRetry ? { onRetry } : {})} />;
  }

  const summary = summarizeComparison(differences);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.heading}>
        {RECONCILIATION_COPY.heading}
      </Text>
      <Text style={styles.intro}>{RECONCILIATION_COPY.intro}</Text>
      {/* Above the list, deliberately. A person who reads nothing else should still learn that
          the app is not going to pick a version for them. */}
      <Text style={styles.statement}>{RECONCILIATION_COPY.neitherIsChosen}</Text>
      <Text style={styles.intro}>{RECONCILIATION_COPY.whoToAsk}</Text>

      {completedUnresolvedCount !== null ? (
        <Text style={styles.statement}>{completionMessage(completedUnresolvedCount)}</Text>
      ) : null}

      {summary.emptyMessage !== null ? (
        <ScreenState kind="empty" message={summary.emptyMessage} />
      ) : (
        summary.lines.map((line) => (
          <View key={line.differenceId} style={styles.difference}>
            <Text accessibilityRole="header" style={styles.medicine}>
              {line.displayName}
            </Text>
            <Text style={styles.kindHeading}>{line.heading}</Text>
            <Text style={styles.meaning}>{line.meaning}</Text>

            {line.fieldLabel !== null ? (
              <Text style={styles.fieldLabel}>{line.fieldLabel}</Text>
            ) : null}

            {/* Both sides, one style object. Two styles that happen to match today are two
                styles that can drift apart tomorrow, and the drift is the exit criterion. */}
            {line.sides.map((side) => (
              <View key={side.side} style={styles.side}>
                <Text style={styles.sideLabel}>{side.label}</Text>
                <Text style={styles.sideValue}>{side.value}</Text>
              </View>
            ))}

            {line.kind === 'MATCHES' ? null : line.resolution !== null ? (
              <Text style={styles.recorded}>Recorded.</Text>
            ) : (
              /* No option is pre-selected and none is styled as primary. A highlighted default
                 is a recommendation whatever the label says. */
              RESOLUTION_OPTIONS.map((option) => (
                <PrimaryButton
                  key={option.resolution}
                  label={option.label}
                  variant="secondary"
                  accessibilityHint={option.meaning}
                  onPress={() => onChooseResolution(line.differenceId, option.resolution)}
                />
              ))
            )}
          </View>
        ))
      )}

      <Text style={styles.limitation}>{RECONCILIATION_COPY.verbatimNote}</Text>
      <Text style={styles.limitation}>{RECONCILIATION_COPY.unresolvedIsFine}</Text>
      <Text style={styles.limitation}>{RECONCILIATION_COPY.sourcePrompt}</Text>
      {/* Always shown. Comparing two pieces of paper is not a check of whether either suits the
          person holding them, and the screen says so rather than leaving it to be assumed. */}
      <Text style={styles.limitation}>{summary.limitation}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: SPACING.lg, gap: SPACING.md },
  heading: {
    fontSize: FONT_SIZE.heading,
    fontWeight: '700',
    color: LIGHT_THEME.surface.foreground,
  },
  intro: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
  },
  statement: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.informational.foreground,
    backgroundColor: LIGHT_THEME.informational.background,
    borderWidth: 1,
    borderColor: LIGHT_THEME.informational.border,
    borderRadius: SPACING.sm,
    padding: SPACING.md,
  },
  difference: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    // The neutral surface border. A tone-coloured edge would make a list difference read as a
    // safety finding, which it is not.
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  medicine: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  kindHeading: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  meaning: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.surface.foreground,
  },
  fieldLabel: {
    fontSize: FONT_SIZE.caption,
    fontWeight: '600',
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  // One style for both sides. Neither is bold, neither is dimmed, neither comes first in
  // anything but reading order.
  side: {
    gap: SPACING.xs,
    padding: SPACING.sm,
    borderWidth: 1,
    borderColor: LIGHT_THEME.neutral.border,
    borderRadius: SPACING.xs,
    backgroundColor: LIGHT_THEME.neutral.background,
  },
  sideLabel: {
    fontSize: FONT_SIZE.caption,
    color: LIGHT_THEME.neutral.foreground,
  },
  sideValue: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.neutral.foreground,
  },
  recorded: {
    fontSize: FONT_SIZE.caption,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  limitation: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
