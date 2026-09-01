/**
 * Household Review Inbox screen.
 *
 * Spec references: `04` Phase 8.3, `03` group G (the alert experience this must not resemble),
 * `18` (plain language, 48dp targets, limitations stated, no shaming), `02` (a calm product).
 *
 * THE ONE THING THIS SCREEN MUST NOT DO
 * It must not look like the alert inbox. The domain and the presentation layer already keep the
 * two apart - a review task has no urgency and may use only the calm tones - and this screen is
 * where that separation is either honoured or thrown away. So there is no coloured left bar, no
 * count badge, no "N need attention" header, and the list is in the order the server gave it
 * rather than ranked. A ranked list with a badge *is* an alert list, whatever the tokens say.
 *
 * The action button on each row is labelled with the work it does - "Add batch number", not
 * "Done". `04` Phase 8.3 requires completing a task to update the authoritative record, and a
 * button labelled Done promises a tick box the server will refuse to honour.
 */

import { View, Text, StyleSheet, ScrollView } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  REVIEW_INBOX_COPY,
  summarizeInbox,
} from '@kynviora/presentation';
import type { ReviewTaskKind } from '@kynviora/domain';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import type { ScreenState as ScreenStateKind } from '@kynviora/presentation';

export interface ReviewInboxTask {
  readonly taskId: string;
  readonly kind: ReviewTaskKind;
  readonly subjectLabel: string | null;
}

export interface ReviewInboxProps {
  readonly state: ScreenStateKind;
  readonly tasks: readonly ReviewInboxTask[];
  readonly onStartTask: (taskId: string) => void;
  readonly onRetry?: () => void;
}

export function ReviewInbox({ state, tasks, onStartTask, onRetry }: ReviewInboxProps) {
  if (state !== 'READY') {
    return <ScreenState state={state} {...(onRetry ? { onRetry } : {})} />;
  }

  const summary = summarizeInbox(tasks);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.heading}>
        {REVIEW_INBOX_COPY.heading}
      </Text>
      {/* Said before the list, not after it. Someone who opens this screen and sees work should
          learn immediately that none of it is urgent. */}
      <Text style={styles.intro}>{REVIEW_INBOX_COPY.intro}</Text>

      {summary.emptyMessage !== null ? (
        <ScreenState state="EMPTY" message={summary.emptyMessage} />
      ) : (
        summary.lines.map((line) => (
          <View key={line.taskId} style={styles.task}>
            <Text accessibilityRole="header" style={styles.taskLabel}>
              {line.label}
            </Text>
            {/* The subject is named separately from the task, so a screen reader announces what
                the work is before which record it is about. */}
            {line.subjectLabel !== null ? (
              <Text style={styles.subject}>{line.subjectLabel}</Text>
            ) : null}
            <Text style={styles.meaning}>{line.meaning}</Text>
            <PrimaryButton
              label={line.actionLabel}
              variant="secondary"
              accessibilityHint={REVIEW_INBOX_COPY.completionRequiresChange}
              onPress={() => onStartTask(line.taskId)}
            />
          </View>
        ))
      )}

      {/* Always shown, list or no list. An empty inbox means Kynviora has no maintenance work to
          suggest - a much smaller claim than "everything is fine". */}
      <Text style={styles.limitation}>{summary.limitation}</Text>
      <Text style={styles.limitation}>{REVIEW_INBOX_COPY.completionRequiresChange}</Text>
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
  task: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    // The neutral surface border, deliberately: no tone-coloured edge, which is the visual cue
    // that would make this read as an alert card.
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  taskLabel: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  subject: {
    fontSize: FONT_SIZE.caption,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  meaning: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.surface.foreground,
  },
  limitation: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
