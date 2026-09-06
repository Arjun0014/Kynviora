/**
 * Text, in a role.
 *
 * Spec references: `18` (system font scaling without clipping; one heading per screen announced
 * as a header), DEC-130.
 *
 * WHY A ROLE RATHER THAN A SIZE
 * A role carries weight, leading and tracking with its size. Passed separately they drift: a
 * "title" ends up 600 in one file and 700 in the next, and nobody notices until two screens are
 * open beside each other. `typeStyle` in the tokens is the only place the system font scale is
 * applied, and this is the only component that calls it.
 *
 * WHY `allowFontScaling` IS LEFT ALONE
 * On by default in React Native, and it stays on. `typeStyle` applies the scale to the *design*
 * size - the point at which a role's proportions are decided - and React Native then applies the
 * platform's own scaling on top for the text itself. The tab bar is the one surface that opts out
 * of the second half, and DEC-103 says why it has to.
 */

import { Text, StyleSheet, useWindowDimensions, type TextStyle } from 'react-native';
import { typeStyle, type ThemeToneToken, type TypeRoleToken } from '@kynviora/presentation';
import type { ReactNode } from 'react';
import { useTheme } from '@/theme/ThemeProvider';

export interface TypographyProps {
  readonly role: TypeRoleToken;
  readonly children: ReactNode;
  /**
   * Which of the theme's foregrounds to use.
   *
   * `primary` is the surface's own foreground and `secondary` is the muted one. A semantic tone
   * is named explicitly where the text sits on that tone's background - never to colour a
   * sentence on a plain surface, which would be meaning carried by colour alone.
   */
  readonly colour?: 'primary' | 'secondary' | ThemeToneToken;
  /** Announce as a header, so screen-reader heading navigation works (`18`). */
  readonly heading?: boolean;
  readonly align?: TextStyle['textAlign'];
  readonly numberOfLines?: number;
  readonly style?: TextStyle;
  readonly accessibilityLabel?: string;
  /** Hide from screen readers where the text duplicates something already announced. */
  readonly decorative?: boolean;
}

export function Typography({
  role,
  children,
  colour = 'primary',
  heading = false,
  align,
  numberOfLines,
  style,
  accessibilityLabel,
  decorative = false,
}: TypographyProps) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const resolved = typeStyle(role, fontScale);

  const color =
    colour === 'primary'
      ? theme.surface.foreground
      : colour === 'secondary'
        ? theme.surfaceMuted.foreground
        : theme[colour].foreground;

  return (
    <Text
      {...(heading ? { accessibilityRole: 'header' as const } : {})}
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      {...(decorative
        ? { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const }
        : {})}
      {...(numberOfLines === undefined ? {} : { numberOfLines })}
      style={[
        resolved,
        { color },
        align === undefined ? null : { textAlign: align },
        role === 'overline' ? styles.overline : null,
        style,
      ]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  // Caps for a section marker, and only for a section marker. `18` wants familiar words first,
  // and a sentence in capitals is measurably slower to read.
  overline: { textTransform: 'uppercase' },
});
