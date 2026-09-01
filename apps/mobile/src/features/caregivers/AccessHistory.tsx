/**
 * The access history.
 *
 * Spec references: `03` group H (audit event visibility), `06` Journey 6 step 5 (the owner sees
 * that a grant became active), `20` (an audit log answers who did what and never becomes a copy
 * of health content), `18` (plain language).
 *
 * WHY IT IS ON THIS SCREEN
 * The access list shows who can read the profile *now*. After a removal that list is exactly one
 * row shorter, which is the least informative possible confirmation - the row the owner was
 * looking at is gone and nothing says it was them who removed it. The history is where the
 * removal itself is visible, and `03` requires it to be visible at all.
 *
 * WHAT IT DELIBERATELY DOES NOT RENDER
 * The `detail` on each event. It is capability codes, counts and booleans, and turning them into
 * prose here would describe a grant a third time, in different words from the list and the
 * confirmation. An action this build has no sentence for is counted, not guessed at.
 */

import { View, Text, StyleSheet } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  CAREGIVER_COPY,
  REVOCATION_COPY,
  unreadableHistoryNote,
} from '@kynviora/presentation';
import type { AccessHistoryView } from '@kynviora/contracts';

export interface AccessHistoryProps {
  readonly history: AccessHistoryView;
}

export function AccessHistory({ history }: AccessHistoryProps) {
  if (history.lines.length === 0 && history.unreadableCount === 0) return null;

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {CAREGIVER_COPY.auditHeading}
      </Text>
      <Text style={styles.intro}>{REVOCATION_COPY.historyIntro}</Text>

      {history.lines.map((line) => (
        <View key={line.id} style={styles.line}>
          <Text style={styles.body}>{line.description}</Text>
          {/* The date only. A time to the second reads as precision about something the owner
              cannot check, and the question here is what happened, not exactly when. */}
          <Text style={styles.when}>{line.occurredAt.slice(0, 10)}</Text>
        </View>
      ))}

      {/* Counted, not hidden. Every word comes from the presentation layer: `apps/**` is
          excluded from the test run, so a string defined here is the one kind of user-visible
          copy no scan looks at (trap 39). */}
      {unreadableHistoryNote(history.unreadableCount) === null ? null : (
        <Text style={styles.body}>{unreadableHistoryNote(history.unreadableCount)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: SPACING.sm,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  heading: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  intro: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  line: { gap: SPACING.xxs },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.surface.foreground,
  },
  when: {
    fontSize: FONT_SIZE.caption,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
