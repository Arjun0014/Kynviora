/**
 * Household Review Inbox screen.
 *
 * Spec references: `04` Phase 8.3, `03` group G (the alert experience this must not resemble),
 * `18` (plain language, 48dp targets, limitations stated, no shaming), `02` (a calm product),
 * DEC-130, DEC-142.
 *
 * THE ONE THING THIS SCREEN MUST NOT DO
 * It must not look like the alert inbox. The domain and the presentation layer already keep the
 * two apart - a review task has no urgency and may use only the calm tones - and this screen is
 * where that separation is either honoured or thrown away. So there is no coloured left bar, no
 * count badge, no "N need attention" header, and the list is in the order the server gave it
 * rather than ranked. A ranked list with a badge *is* an alert list, whatever the tokens say.
 *
 * That is also why every task is a plain `Card` with no tone. A card that is coloured is saying
 * something, and there is nothing here to say: a task is work that would make Kynviora's answers
 * more exact, and a tinted edge would be an urgency invented at the one layer where nobody would
 * notice it had been.
 *
 * The action button on each row is labelled with the work it does - "Add batch number", not
 * "Done". `04` Phase 8.3 requires completing a task to update the authoritative record, and a
 * button labelled Done promises a tick box the server will refuse to honour.
 *
 * WHY IT NO LONGER SCROLLS ITSELF (DEC-142)
 * It held its own `ScrollView` inside the one `Screen` already draws on Today - two scroll views
 * nested in the same direction, which on Android is one of them eating the other's gestures. That
 * is the shape of `DEV-046`: a control that is on screen, below the fold, with no reliable way to
 * reach it. It renders content now and the frame does the scrolling, exactly as every other
 * feature block on a destination does.
 */

import { SPACING, REVIEW_INBOX_COPY, summarizeInbox } from '@kynviora/presentation';
import type { ReviewTaskKind } from '@kynviora/domain';
import { View, StyleSheet } from 'react-native';
import { Card } from '@/components/Card';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { SectionHeader } from '@/components/SectionHeader';
import { Typography } from '@/components/Typography';
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
    <>
      {/* A section marker rather than a second screen heading. `Screen` already announces "Today",
          and two headings at the same rank is `18`'s one-heading rule broken by a feature block -
          which is what DEC-142 took out of Care and DEC-143 out of You. */}
      <SectionHeader title={REVIEW_INBOX_COPY.heading} />

      {/* Said before the list, not after it, and at `bodyLarge` rather than as the marker's own
          caption: someone who opens this screen and sees work should learn immediately that none
          of it is urgent, and that sentence is a limitation. A limitation never moves down a
          layer, and a caption under an overline is a layer down from the cards it qualifies. */}
      <Typography role="bodyLarge">{REVIEW_INBOX_COPY.intro}</Typography>

      {summary.emptyMessage !== null ? (
        <ScreenState state="EMPTY" message={summary.emptyMessage} />
      ) : (
        summary.lines.map((line) => (
          <Card key={line.taskId}>
            <Typography role="title" heading>
              {line.label}
            </Typography>
            {/* The subject is named separately from the task, so a screen reader announces what
                the work is before which record it is about. */}
            {line.subjectLabel === null ? null : (
              <Typography role="caption" colour="secondary">
                {line.subjectLabel}
              </Typography>
            )}
            <Typography role="body">{line.meaning}</Typography>
            <PrimaryButton
              label={line.actionLabel}
              variant="secondary"
              accessibilityHint={REVIEW_INBOX_COPY.completionRequiresChange}
              onPress={() => onStartTask(line.taskId)}
            />
          </Card>
        ))
      )}

      {/* Always shown, list or no list. An empty inbox means Kynviora has no maintenance work to
          suggest - a much smaller claim than "everything is fine". Kept out of a card so it reads
          as a statement about the whole list rather than about whatever card it sat in. */}
      <View style={styles.limitations}>
        <Typography role="caption" colour="secondary">
          {summary.limitation}
        </Typography>
        <Typography role="caption" colour="secondary">
          {REVIEW_INBOX_COPY.completionRequiresChange}
        </Typography>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  limitations: { gap: SPACING.sm },
});
