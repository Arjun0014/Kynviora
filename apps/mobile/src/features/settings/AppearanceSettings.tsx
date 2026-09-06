/**
 * Choosing light, dark, or the phone's own setting.
 *
 * Spec references: `18` (appearance is an accessibility setting; meaning never carried by colour
 * alone; 48dp targets; no swipe-only or long-press-only control), DEC-130.
 *
 * WHY THIS IS UNDER "YOU" AND NOT BEHIND A GESTURE
 * `06` puts accessibility on the You destination, and `18` forbids a core control that can only
 * be reached by a gesture. There is no theme toggle in a header, no long-press, and no shake.
 *
 * WHY THE OPTIONS SAY WHAT THEY DO AND NOT JUST WHAT THEY ARE CALLED
 * "Follow my phone" is the default and is a different state from having chosen whichever theme
 * the phone currently is - somebody following their phone in September is still following it in
 * October when it switches itself at dusk. That distinction is invisible unless it is written
 * down, so each option carries the sentence that makes it distinguishable.
 *
 * WHAT THE CHOSEN OPTION LOOKS LIKE
 * A `selection` outline **and** the word "chosen" in its accessible name, and the radio semantics
 * underneath. `18` forbids meaning carried by colour alone, and a theme picker is the one screen
 * where a person may be choosing precisely because colour is not working for them.
 */

import { View, Pressable, StyleSheet } from 'react-native';
import { MIN_TOUCH_TARGET_DP, RADIUS, SPACING, type Theme } from '@kynviora/presentation';
import { Card } from '@/components/Card';
import { SectionHeader } from '@/components/SectionHeader';
import { Typography } from '@/components/Typography';
import {
  APPEARANCE_CHOICES,
  useThemeContext,
  useThemedStyles,
  type AppearanceChoice,
} from '@/theme/ThemeProvider';
import { haptic } from '@/platform/haptics';

/** One sentence per choice, held here because this is the only screen that renders them. */
const OPTION_COPY: Readonly<Record<AppearanceChoice, { label: string; explanation: string }>> =
  Object.freeze({
    FOLLOW_SYSTEM: {
      label: 'Follow my phone',
      explanation: 'Changes when your phone changes, including on its own in the evening.',
    },
    LIGHT: {
      label: 'Light',
      explanation: 'Dark text on a pale background, whatever your phone is set to.',
    },
    DARK: {
      label: 'Dark',
      explanation: 'Pale text on a dark background, whatever your phone is set to.',
    },
  });

export function AppearanceSettings() {
  const styles = useThemedStyles(makeStyles);
  const { choice, setChoice, theme, reduceMotion } = useThemeContext();

  return (
    <>
      <SectionHeader
        title="Appearance"
        explanation="Text size comes from your phone's own settings and Kynviora follows it."
      />
      <Card>
        <View accessibilityRole="radiogroup" style={styles.group}>
          {APPEARANCE_CHOICES.map((option) => {
            const chosen = option === choice;
            const copy = OPTION_COPY[option];
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ checked: chosen, selected: chosen }}
                accessibilityLabel={
                  chosen
                    ? `${copy.label}, chosen. ${copy.explanation}`
                    : `${copy.label}. ${copy.explanation}`
                }
                onPress={() => {
                  haptic('selection');
                  setChoice(option);
                }}
                style={[styles.option, chosen ? styles.chosen : null]}
              >
                <Typography role="label" colour={chosen ? 'primary' : 'primary'} decorative>
                  {chosen ? `${copy.label} - chosen` : copy.label}
                </Typography>
                <Typography role="caption" colour="secondary" decorative>
                  {copy.explanation}
                </Typography>
              </Pressable>
            );
          })}
        </View>

        {/* What is actually on screen right now, which is not always what was chosen: "follow my
            phone" resolves to one of the two and a person cannot otherwise tell which. */}
        <Typography role="caption" colour="secondary">
          {theme.name === 'DARK' ? 'Showing the dark theme now.' : 'Showing the light theme now.'}
        </Typography>

        {/* Read from the platform rather than offered here. It is a system setting and Kynviora
            does not own it; saying that it is being honoured is what this screen can add. */}
        {reduceMotion ? (
          <Typography role="caption" colour="secondary">
            Your phone asks apps to reduce motion. Kynviora has turned its animations off.
          </Typography>
        ) : null}
      </Card>
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    group: { gap: SPACING.sm },
    option: {
      minHeight: MIN_TOUCH_TARGET_DP,
      justifyContent: 'center',
      gap: SPACING.xxs,
      paddingVertical: SPACING.md,
      paddingHorizontal: SPACING.lg,
      borderWidth: 1,
      borderRadius: RADIUS.md,
      borderColor: theme.line.strong,
      backgroundColor: theme.surface.background,
    },
    chosen: {
      borderColor: theme.selection.border,
      borderWidth: 2,
      backgroundColor: theme.selection.background,
    },
  });
