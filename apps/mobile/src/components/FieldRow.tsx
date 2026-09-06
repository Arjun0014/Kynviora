/**
 * A labelled value, and an explicit statement when there is no value.
 *
 * Spec references: `18` (uncertain and confirmed facts never get identical treatment; a
 * limitation travels with the fact it qualifies), `06` (partial data is visible as partial),
 * `09` (a missing field is a fact about coverage, not a blank; Kynviora never speaks a
 * prescriber's directions in its own voice).
 *
 * WHY AN ABSENT VALUE IS A SENTENCE AND NOT AN EMPTY LINE
 * A blank beside "Batch" reads as "no batch", and "no batch" reads as "nothing to worry about".
 * What is true is that nobody entered one, which is a different thing and is what the person can
 * act on. So `value` is `string | null` and `null` renders the row's own `absent` copy in the
 * muted foreground - present, quieter, and never mistaken for a value.
 *
 * The two are announced differently as well: a screen reader hears "Batch, not entered" rather
 * than "Batch" followed by silence.
 *
 * WHY `quoted` IS A PROP AND NOT A STYLE THE CALLER PASSES
 * Written directions and a household's own notes are somebody else's words. `09` forbids Kynviora
 * telling anybody how to take a medicine, and rendering prescribed directions in the same voice
 * as Kynviora's own copy is how that rule quietly fails on a screen. Making it a prop means the
 * decision is "is this a quotation", which a caller can answer, rather than "which border does
 * this get", which it cannot.
 */

import { View, StyleSheet } from 'react-native';
import { FIELD_ABSENT_NOTE, SPACING, type Theme } from '@kynviora/presentation';
import { useThemedStyles } from '@/theme/ThemeProvider';
import { Typography } from './Typography';

export interface FieldRowProps {
  readonly label: string;
  /** The recorded value, or `null` where nobody recorded one. */
  readonly value: string | null;
  /**
   * What to say when there is no value.
   *
   * Required rather than defaulted, because the honest sentence differs per field: "not entered"
   * for something a person types, "not on the package" for something a package may not carry, and
   * "not yet confirmed" for something waiting on evidence. A single default would put one of
   * those three next to all three.
   *
   * `null` is accepted because the wire type allows it - `absentNote` is null exactly when there
   * **is** a value, and nothing in the type says so. It falls back to the presentation layer's own
   * sentence rather than to a blank, which is the one thing this component exists to avoid.
   */
  readonly absent: string | null;
  /**
   * A qualification that belongs to this fact.
   *
   * Rendered under the value at `caption`, so it travels with the fact at every level rather than
   * living two taps away.
   */
  readonly note?: string;
  /** Somebody else's words, set apart so they never read as Kynviora's. */
  readonly quoted?: boolean;
}

export function FieldRow({ label, value, absent, note, quoted = false }: FieldRowProps) {
  const styles = useThemedStyles(makeStyles);
  const recorded = value !== null && value.trim() !== '';
  const shown = recorded ? value : (absent ?? FIELD_ABSENT_NOTE);

  return (
    <View
      accessible
      accessibilityLabel={note === undefined ? `${label}. ${shown}` : `${label}. ${shown}. ${note}`}
      style={styles.row}
    >
      <Typography role="overline" colour="secondary" decorative>
        {label}
      </Typography>
      <View style={recorded && quoted ? styles.quotation : null}>
        <Typography
          role={recorded ? 'bodyLarge' : 'body'}
          colour={recorded ? 'primary' : 'secondary'}
          decorative
          {...(recorded && quoted ? { style: styles.quoted } : {})}
        >
          {shown}
        </Typography>
      </View>
      {note === undefined ? null : (
        <Typography role="caption" colour="secondary" decorative>
          {note}
        </Typography>
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    row: { gap: SPACING.xxs, paddingVertical: SPACING.xs },
    quotation: {
      paddingLeft: SPACING.md,
      borderLeftWidth: 3,
      borderLeftColor: theme.line.strong,
    },
    quoted: { fontStyle: 'italic' },
  });
