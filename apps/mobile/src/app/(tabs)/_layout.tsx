/**
 * Primary navigation.
 *
 * Spec 06: "Use five primary destinations - Today, Shelf, Safety, Care, You."
 *
 * Each tab carries a visible text label as well as an icon. Spec 18 forbids meaning carried by
 * an icon or colour alone, and an icon-only tab bar is unusable for the primary audience.
 *
 * WHY THE LABEL IS RENDERED RATHER THAN LEFT TO THE NAVIGATOR
 * `18`: "Support system font scaling without clipping critical content/actions." The navigator's
 * own label is one line and ellipsises, and on a 1080px screen at the 2x scale this app supports,
 * that turned Safety into "Safet...". A destination whose name is cut off is the icon-only tab bar
 * the rule above forbids, arrived at from a different direction.
 *
 * Wrapping does not fix it - the names are single words, and a single word does not break - and
 * the bar has five fixed slots that `06` will not let anything be removed from. So the label is
 * sized to the slot it has: it grows with the system scale up to the point where it would stop
 * fitting, and no further. That is a deliberate departure from the global font scale, on this one
 * surface, and it is the right trade twice over - a clipped name conveys less than a small one,
 * and the label is the third of three cues for the same thing, beside the icon and the screen's
 * own heading, which does scale the whole way.
 */

import { Tabs } from 'expo-router';
import { Text, useWindowDimensions, type ColorValue } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { FONT_SIZE, MAX_SUPPORTED_FONT_SCALE, SPACING } from '@kynviora/presentation';

/** `06` fixes five primary destinations, so the bar has five slots and cannot have four. */
const TAB_COUNT = 5;

/** Glyphs distinguishable by shape, standing in for a real icon set. */
const TAB_GLYPHS = {
  today: '◉',
  shelf: '▤',
  safety: '⛉',
  care: '♡',
  you: '☰',
} as const;

// `color` is what the navigator hands the icon, and its type is React Native's `ColorValue`
// rather than `string` - a platform colour is an opaque object. Narrowing it here would compile
// only until the navigator passed one, so the prop takes what the caller actually gives it.
function TabIcon({ glyph, color }: { glyph: string; color: ColorValue }) {
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ color, fontSize: FONT_SIZE.title }}
    >
      {glyph}
    </Text>
  );
}

/**
 * Roughly how wide a character is, as a fraction of the font size, in the system sans-serif.
 *
 * A measurement would need a layout pass and a second render, which is a lot of machinery for a
 * five-word problem. The number errs small on purpose: too low renders the label a little smaller
 * than it had to be, which is a worse-looking tab. Too high clips it, which is the thing `18`
 * forbids.
 */
const APPROXIMATE_GLYPH_WIDTH_RATIO = 0.62;

function TabLabel({ label, color }: { label: string; color: ColorValue }) {
  const { width, fontScale } = useWindowDimensions();
  const scale = Math.max(1, Math.min(fontScale, MAX_SUPPORTED_FONT_SCALE));

  // The width one of the five tabs has, less a little breathing room on each side.
  const slot = width / TAB_COUNT - SPACING.xs * 2;
  const fits = slot / (label.length * APPROXIMATE_GLYPH_WIDTH_RATIO);
  const fontSize = Math.max(FONT_SIZE.caption, Math.min(FONT_SIZE.caption * scale, fits));

  return (
    <Text
      // One line, and it always fits on it. `allowFontScaling` is off because the size above
      // already accounts for the system scale; leaving it on would apply it twice.
      numberOfLines={1}
      allowFontScaling={false}
      style={{ color, fontSize, textAlign: 'center' }}
    >
      {label}
    </Text>
  );
}

export default function TabLayout() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        tabBarActiveTintColor: theme.informational.foreground,
        tabBarInactiveTintColor: theme.surfaceMuted.foreground,
        // Labels are always shown. An icon-only tab bar communicates by shape alone, which the
        // primary audience should not have to decode.
        tabBarShowLabel: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Today',
          tabBarIcon: ({ color }) => <TabIcon glyph={TAB_GLYPHS.today} color={color} />,
          tabBarLabel: ({ color }) => <TabLabel label="Today" color={color} />,
        }}
      />
      <Tabs.Screen
        name="shelf"
        options={{
          title: 'Shelf',
          tabBarIcon: ({ color }) => <TabIcon glyph={TAB_GLYPHS.shelf} color={color} />,
          tabBarLabel: ({ color }) => <TabLabel label="Shelf" color={color} />,
        }}
      />
      <Tabs.Screen
        name="safety"
        options={{
          title: 'Safety',
          tabBarIcon: ({ color }) => <TabIcon glyph={TAB_GLYPHS.safety} color={color} />,
          tabBarLabel: ({ color }) => <TabLabel label="Safety" color={color} />,
        }}
      />
      <Tabs.Screen
        name="care"
        options={{
          title: 'Care',
          tabBarIcon: ({ color }) => <TabIcon glyph={TAB_GLYPHS.care} color={color} />,
          tabBarLabel: ({ color }) => <TabLabel label="Care" color={color} />,
        }}
      />
      <Tabs.Screen
        name="you"
        options={{
          title: 'You',
          tabBarIcon: ({ color }) => <TabIcon glyph={TAB_GLYPHS.you} color={color} />,
          tabBarLabel: ({ color }) => <TabLabel label="You" color={color} />,
        }}
      />
    </Tabs>
  );
}
