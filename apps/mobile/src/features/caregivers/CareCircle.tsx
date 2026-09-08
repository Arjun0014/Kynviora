/**
 * The Care Circle: the household read as people rather than as a policy table.
 *
 * Spec references: `06` Journey 6, `08.2` (viewing and changing are separately scoped), `16` (a
 * family relationship is not a licence to see everything), `18` (never colour alone; a limitation
 * travels with the fact it qualifies), `02` (no ranking), DEC-138, DEC-142, DEC-159.
 *
 * WHAT THIS IS AND WHAT IT IS NOT
 * It is the first surface: a card per person, with who they are, what their access covers on two
 * lines, its status, and when it ends. It is **not** the permissions matrix - V3 is explicit that
 * a giant grid must not be the first screen - and it is not a control: every change to access
 * still goes through `CaregiverAccessList`, behind step-up, applied only when the server confirms.
 *
 * THE STATEMENT IS FIRST AND IS IN EVERY STATE
 * DEC-138's reasoning, on the screen `16` decides something on. A circle with nobody in it invites
 * the reading that nobody *could* be in it, and a circle with three people in it invites the
 * reading that being in the household is what put them there. The sentence says otherwise, above
 * the cards, always.
 */

import { View, StyleSheet } from 'react-native';
import {
  RADIUS,
  SPACING,
  careCircle,
  CARE_CIRCLE_STATEMENT,
  type CareCircleCardView,
  type Theme,
} from '@kynviora/presentation';
import type { CaregiverAccessRowView } from '@kynviora/contracts';
import { Card } from '@/components/Card';
import { SectionHeader } from '@/components/SectionHeader';
import { Typography } from '@/components/Typography';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';

export function CareCircle({
  rows,
  now,
}: {
  readonly rows: readonly CaregiverAccessRowView[];
  /**
   * The clock, injected.
   *
   * Every clock in this repository is, and here it decides whether somebody is told their
   * caregiver's access ends next week - which is not a thing to compute from ambient time in a
   * component nothing can test.
   */
  readonly now: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const circle = careCircle(rows, now);

  return (
    <View style={styles.stack}>
      <SectionHeader
        title="Who is in this circle"
        explanation="Everybody with access to this person's records, and what each one covers."
      />

      {/* First, at the same rank as the cards, in every state (DEC-138). */}
      <Card tone="informational">
        <Typography role="body" colour="informational">
          {CARE_CIRCLE_STATEMENT}
        </Typography>
      </Card>

      {circle.current.length === 0 ? (
        <Card>
          <Typography role="body">
            Nobody else has access to this person&rsquo;s records. Nothing is shared until somebody
            is invited and accepts.
          </Typography>
        </Card>
      ) : (
        circle.current.map((card) => <CircleCard key={`${card.subject}:${card.id}`} card={card} />)
      )}

      {/*
        Access that has ended is a **count** here and a full row in the list below. Measured on a
        Pixel 7 at font scale 2: one card is 1,587 pixels, and this development profile carries
        seven revoked grants - drawn as cards they put `Invite someone` about eleven thousand
        pixels below the fold, which is a primary action nobody reaches.

        It is a count and not an omission. The sentence is on screen whenever there is one, and
        every row it counts is enumerated directly beneath in the access list, which is the surface
        that exists to say what happened. `18` will not let an absence pass unlabelled.
      */}
      {circle.endedSentence === null ? null : (
        <Card>
          <Typography role="body" colour="secondary">
            {circle.endedSentence}
          </Typography>
        </Card>
      )}
    </View>
  );
}

function CircleCard({ card }: { readonly card: CareCircleCardView }) {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();
  const tone = theme[card.statusTone];

  return (
    <Card accessibilityLabel={card.accessibilityLabel}>
      <View style={styles.head}>
        <Typography role="title" decorative style={styles.name}>
          {card.displayName}
        </Typography>
        {/*
          The status as a word on a tint, never as a tint alone (`18`). The two ordinary states -
          Active and Expiring - are deliberately close in colour, because they are both ordinary;
          the word is what tells them apart.
        */}
        <View style={[styles.chip, { backgroundColor: tone.background, borderColor: tone.border }]}>
          <Typography role="caption" style={{ color: tone.foreground }} decorative>
            {card.statusLabel}
          </Typography>
        </View>
      </View>

      <Typography role="caption" colour="secondary" decorative>
        {card.statusMeaning}
      </Typography>

      {/*
        Two lines, never merged. `08.2` scopes viewing and changing separately, and a card that
        ran them together would be describing one permission where there are two - which is the
        `DEV-049` shape, arriving through a summary rather than through a policy.
      */}
      <View style={styles.lines}>
        <Typography role="caption" colour="secondary" decorative>
          {card.canSee.length === 0 ? 'Can see: nothing' : `Can see: ${card.canSee.join(' · ')}`}
        </Typography>
        <Typography role="caption" colour="secondary" decorative>
          {card.canChange.length === 0
            ? 'Can change: nothing'
            : `Can change: ${card.canChange.join(' · ')}`}
        </Typography>
      </View>

      {card.expirySentence === null ? null : (
        <Typography role="caption" colour="secondary" decorative>
          {card.expirySentence}
        </Typography>
      )}

      {card.isSelf ? (
        <Typography role="caption" colour="secondary" decorative>
          This is your own access.
        </Typography>
      ) : null}
    </Card>
  );
}

const makeStyles = (_theme: Theme) =>
  StyleSheet.create({
    stack: { gap: SPACING.lg },
    head: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: SPACING.sm,
    },
    name: { flexShrink: 1 },
    chip: {
      borderWidth: 1,
      borderRadius: RADIUS.pill,
      paddingVertical: SPACING.xs,
      paddingHorizontal: SPACING.sm,
    },
    lines: { gap: SPACING.xxs },
  });
