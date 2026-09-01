/**
 * Visit Pack review screen.
 *
 * Spec references: `06` Journey 8 step 4 ("Review screen shows content and sensitive-sharing
 * warning"), `04` Phase 8.4 (a user can review exactly what will be shared; export never happens
 * automatically), `16` (show what data will be included, re-authenticate), `18` (state the
 * limitation, 48dp targets, plain language).
 *
 * THE ONE THING THIS SCREEN MUST NOT DO
 * It must not describe an export different from the one about to be made. Every count and every
 * section name comes from {@link summarizeSelection} applied to the same entries that will be
 * sent, so the summary cannot drift from the selection. The screen holds no list of its own.
 *
 * It also never generates anything by itself. The confirm button is the only path forward, it is
 * disabled until something is selected, and the request it triggers carries the digest of exactly
 * what is rendered here - the server refuses if that no longer matches the live data.
 */

import { View, Text, StyleSheet, ScrollView } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  VISIT_PACK_COPY,
  summarizeSelection,
} from '@kynviora/presentation';
import type { VisitPackSection } from '@kynviora/domain';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import type { ScreenState as ScreenStateKind } from '@kynviora/presentation';

/** An entry as the review screen needs it: enough to summarise, enough to show. */
export interface ReviewEntry {
  readonly entityId: string;
  readonly section: VisitPackSection;
  readonly lines: readonly string[];
  readonly caveat: string;
}

export interface VisitPackReviewProps {
  readonly state: ScreenStateKind;
  /** Exactly what will be sent. The summary is derived from this and nothing else. */
  readonly selected: readonly ReviewEntry[];
  /** True once the content changed under the user and the selection must be reviewed again. */
  readonly changedSinceReview: boolean;
  readonly onConfirm: () => void;
  readonly onBack: () => void;
  readonly onRetry?: () => void;
}

export function VisitPackReview({
  state,
  selected,
  changedSinceReview,
  onConfirm,
  onBack,
  onRetry,
}: VisitPackReviewProps) {
  if (state !== 'READY') {
    return <ScreenState state={state} {...(onRetry ? { onRetry } : {})} />;
  }

  const summary = summarizeSelection(selected);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.heading}>
        {VISIT_PACK_COPY.reviewHeading}
      </Text>

      {changedSinceReview ? (
        // Not an error state: nothing failed, the information moved. The user re-reads and
        // continues, which is the whole point of the digest check on the server.
        <Text style={styles.changed}>{VISIT_PACK_COPY.changedSinceReview}</Text>
      ) : null}

      {summary.included.length === 0 ? (
        <ScreenState state="EMPTY" message={VISIT_PACK_COPY.emptySelection} />
      ) : (
        summary.included.map((line) => (
          <View key={line.section} style={styles.section}>
            <Text accessibilityRole="header" style={styles.sectionHeading}>
              {line.label}
            </Text>
            {/* The count is announced with the heading rather than as a bare number, so a screen
                reader does not read "3" adrift from what it counts. */}
            <Text
              style={styles.count}
              accessibilityLabel={`${line.label}: ${line.count} item${line.count === 1 ? '' : 's'}`}
            >
              {line.count} included
            </Text>

            {selected
              .filter((entry) => entry.section === line.section)
              .map((entry) => (
                <View key={entry.entityId} style={styles.entry}>
                  {entry.lines.map((text) => (
                    <Text key={text} style={styles.entryLine}>
                      {text}
                    </Text>
                  ))}
                  {/* Every entry carries its caveat here, exactly as it will on the pack. A
                      reader must not discover the provenance only after sharing. */}
                  <Text style={styles.caveat}>{entry.caveat}</Text>
                </View>
              ))}
          </View>
        ))
      )}

      {summary.omitted.length > 0 ? (
        <Text style={styles.limitation}>
          Not included: {summary.omitted.join(', ').toLowerCase()}.
        </Text>
      ) : null}

      {summary.sensitiveWarning !== null ? (
        <Text style={styles.warning}>{summary.sensitiveWarning}</Text>
      ) : null}

      {/* Always shown, never varied. Spec 03 group I. */}
      <Text style={styles.limitation}>{summary.limitation}</Text>
      <Text style={styles.limitation}>{VISIT_PACK_COPY.notAutomatic}</Text>

      <PrimaryButton
        label="Create the pack"
        accessibilityHint={VISIT_PACK_COPY.stepUpPrompt}
        disabled={summary.totalEntries === 0 || changedSinceReview}
        onPress={onConfirm}
      />
      <PrimaryButton label="Change what is included" variant="secondary" onPress={onBack} />
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
  changed: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.attention.foreground,
    backgroundColor: LIGHT_THEME.attention.background,
    borderColor: LIGHT_THEME.attention.border,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    padding: SPACING.md,
  },
  section: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
  },
  sectionHeading: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  count: { fontSize: FONT_SIZE.caption, color: LIGHT_THEME.surfaceMuted.foreground },
  entry: { marginTop: SPACING.sm, gap: SPACING.xxs },
  entryLine: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.surface.foreground,
  },
  caveat: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  warning: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.informational.foreground,
    backgroundColor: LIGHT_THEME.informational.background,
    borderColor: LIGHT_THEME.informational.border,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    padding: SPACING.md,
  },
  limitation: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
