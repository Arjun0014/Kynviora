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
 *
 * ONE EVENT PER CARD, AND ITS OWN SECTION (DEC-142)
 * It used to be one bordered box containing a heading, an introduction and every event as two
 * lines of text - which on a household with any history at all is a wall inside a card, and a card
 * is supposed to be one idea. Each event is now a card, under a section marker a screen reader can
 * navigate to directly: "who can read this now" and "what has happened to that" are two questions,
 * and somebody who came for the second should not have to pass through the first.
 */

import { View, StyleSheet } from 'react-native';
import {
  SPACING,
  CAREGIVER_COPY,
  REVOCATION_COPY,
  unreadableHistoryNote,
} from '@kynviora/presentation';
import type { AccessHistoryView } from '@kynviora/contracts';
import { Card } from '@/components/Card';
import { SectionHeader } from '@/components/SectionHeader';
import { Typography } from '@/components/Typography';

export interface AccessHistoryProps {
  readonly history: AccessHistoryView;
}

export function AccessHistory({ history }: AccessHistoryProps) {
  if (history.lines.length === 0 && history.unreadableCount === 0) return null;

  return (
    <>
      {/* Its own section rather than a heading inside a card: it answers a different question from
          the list above it - that one is who can read this now, this one is what has happened -
          and a screen reader navigating by headings should be able to land on the second without
          passing through the first. */}
      <SectionHeader
        title={CAREGIVER_COPY.auditHeading}
        explanation={REVOCATION_COPY.historyIntro}
      />

      {history.lines.map((line) => (
        <Card key={line.id}>
          <Typography role="body">{line.description}</Typography>
          {/* The date only. A time to the second reads as precision about something the owner
              cannot check, and the question here is what happened, not exactly when. */}
          <Typography role="caption" colour="secondary">
            {line.occurredAt.slice(0, 10)}
          </Typography>
        </Card>
      ))}

      {/* Counted, not hidden. Every word comes from the presentation layer: `apps/**` is
          excluded from the test run, so a string defined here is the one kind of user-visible
          copy no scan looks at (trap 39). */}
      {unreadableHistoryNote(history.unreadableCount) === null ? null : (
        <View style={styles.note}>
          <Typography role="body" colour="secondary">
            {unreadableHistoryNote(history.unreadableCount)}
          </Typography>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // Not a card. A card is one idea and this is a qualification on the whole list, so it sits in
  // the page's own rhythm rather than pretending to be another event.
  note: { paddingHorizontal: SPACING.xs },
});
