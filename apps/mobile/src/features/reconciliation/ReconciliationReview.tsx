/**
 * Medicine Reconciliation review screen.
 *
 * Spec references: `04` Phase 8.5, `09` (never instruct a stop/start/split/replace), `18` (plain
 * language, 48dp targets, limitations stated), `02` (a calm product), DEC-130, DEC-142.
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
 *
 * THE TWO SIDES SIT IN A SUNKEN WELL, AND THAT IS NOT DECORATION
 * A well is what this app draws round a record - something written down, rather than something
 * Kynviora is saying. The alternative was a tone, and every tone available carries a meaning: a
 * coloured panel round one of two versions of a dose is Kynviora having an opinion about which,
 * expressed in the one channel `18` will not let carry meaning on its own. Both sides get the same
 * well, from one style object, for the same reason they always shared one.
 *
 * WHY IT NO LONGER SCROLLS ITSELF (DEC-142)
 * It held its own `ScrollView`, inside the one `Screen` draws on Today, inside the flow's own
 * container. Two scroll views in the same direction is one of them eating the other's gestures -
 * the shape of `DEV-046`, and on a screen whose whole content is below the fold at twice the font
 * size. It renders content now; the frame scrolls.
 */

import { View, StyleSheet } from 'react-native';
import {
  RADIUS,
  SPACING,
  RECONCILIATION_COPY,
  RESOLUTION_OPTIONS,
  completionMessage,
  summarizeComparison,
  type Theme,
} from '@kynviora/presentation';
import type { DifferenceKind, ReconciliationResolution } from '@kynviora/domain';
import { Card } from '@/components/Card';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { Typography } from '@/components/Typography';
import type { ScreenState as ScreenStateKind } from '@kynviora/presentation';
import { useThemedStyles } from '@/theme/ThemeProvider';

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
  readonly state: ScreenStateKind;
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
  const styles = useThemedStyles(makeStyles);
  if (state !== 'READY') {
    return <ScreenState state={state} {...(onRetry ? { onRetry } : {})} />;
  }

  const summary = summarizeComparison(differences);

  return (
    <>
      <Card>
        <Typography role="title" heading>
          {RECONCILIATION_COPY.heading}
        </Typography>
        <Typography role="body">{RECONCILIATION_COPY.intro}</Typography>
      </Card>

      {/* Above the list, deliberately, and in `informational` - a statement of what Kynviora will
          not do, which is a fact about its coverage rather than a warning about a medicine. A
          person who reads nothing else should still learn that the app is not going to pick a
          version for them. */}
      <Card tone="informational">
        <Typography role="bodyLarge" colour="informational">
          {RECONCILIATION_COPY.neitherIsChosen}
        </Typography>
        <Typography role="body" colour="informational">
          {RECONCILIATION_COPY.whoToAsk}
        </Typography>
      </Card>

      {completedUnresolvedCount !== null ? (
        <Card tone="informational">
          <Typography role="bodyLarge" colour="informational" announce>
            {completionMessage(completedUnresolvedCount)}
          </Typography>
        </Card>
      ) : null}

      {summary.emptyMessage !== null ? (
        <ScreenState state="EMPTY" message={summary.emptyMessage} />
      ) : (
        summary.lines.map((line) => (
          // A plain surface. A tone-coloured card would make a list difference read as a safety
          // finding, which it is not - and would be the app leaning on one of the two versions.
          <Card key={line.differenceId}>
            <Typography role="title" heading>
              {line.displayName}
            </Typography>
            <Typography role="label">{line.heading}</Typography>
            <Typography role="body">{line.meaning}</Typography>

            {line.fieldLabel === null ? null : (
              <Typography role="overline" colour="secondary">
                {line.fieldLabel}
              </Typography>
            )}

            {/* Both sides, one style object. Two styles that happen to match today are two
                styles that can drift apart tomorrow, and the drift is the exit criterion. */}
            {line.sides.map((side) => (
              <View
                key={side.side}
                // One node, one announcement: "What Kynviora had, 500 mg" rather than two
                // fragments a listener has to pair up. Both sides are announced the same way for
                // the same reason they are drawn the same way.
                accessible
                accessibilityLabel={`${side.label}. ${side.value}`}
                style={styles.side}
              >
                <Typography role="overline" colour="secondary" decorative>
                  {side.label}
                </Typography>
                <Typography role="bodyLarge" decorative>
                  {side.value}
                </Typography>
              </View>
            ))}

            {line.kind === 'MATCHES' ? null : line.resolution !== null ? (
              <Typography role="caption" colour="secondary">
                Recorded.
              </Typography>
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
          </Card>
        ))
      )}

      {/* The limitations, together and after the list they qualify. Always shown - comparing two
          pieces of paper is not a check of whether either suits the person holding them, and the
          screen says so rather than leaving it to be assumed. */}
      <View style={styles.limitations}>
        <Typography role="caption" colour="secondary">
          {RECONCILIATION_COPY.verbatimNote}
        </Typography>
        <Typography role="caption" colour="secondary">
          {RECONCILIATION_COPY.unresolvedIsFine}
        </Typography>
        <Typography role="caption" colour="secondary">
          {RECONCILIATION_COPY.sourcePrompt}
        </Typography>
        <Typography role="caption" colour="secondary">
          {summary.limitation}
        </Typography>
      </View>
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // One well for both sides. Neither is bold, neither is dimmed, neither comes first in
    // anything but reading order. Announced as one node so a screen reader hears "What Kynviora
    // had, 500 mg" rather than two fragments it has to pair up itself.
    side: {
      gap: SPACING.xxs,
      padding: SPACING.md,
      borderRadius: RADIUS.md,
      backgroundColor: theme.sunken.background,
    },
    limitations: { gap: SPACING.sm },
  });
