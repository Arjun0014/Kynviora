/**
 * A section marker, and the one line that says what the section is.
 *
 * Spec references: `18` (headings are announced as headings so somebody can navigate by them;
 * familiar words first), `06` (progressive disclosure).
 *
 * The explanation is part of the header rather than a first paragraph inside the section, because
 * a screen reader moving by headings should hear what the section is for at the moment it lands
 * there - not after the first card.
 */

import { View, StyleSheet } from 'react-native';
import { SPACING } from '@kynviora/presentation';
import { Typography } from './Typography';

export interface SectionHeaderProps {
  readonly title: string;
  /** One line. If it needs two, the section needs splitting. */
  readonly explanation?: string;
}

export function SectionHeader({ title, explanation }: SectionHeaderProps) {
  return (
    <View style={styles.header}>
      <Typography
        role="overline"
        colour="secondary"
        heading
        accessibilityLabel={explanation === undefined ? title : `${title}. ${explanation}`}
      >
        {title}
      </Typography>
      {explanation === undefined ? null : (
        <Typography role="caption" colour="secondary" decorative>
          {explanation}
        </Typography>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: SPACING.xxs, marginTop: SPACING.sm },
});
