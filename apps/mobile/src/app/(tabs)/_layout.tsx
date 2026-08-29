/**
 * Primary navigation.
 *
 * Spec 06: "Use five primary destinations - Today, Shelf, Safety, Care, You."
 *
 * Each tab carries a visible text label as well as an icon. Spec 18 forbids meaning carried by
 * an icon or colour alone, and an icon-only tab bar is unusable for the primary audience.
 */

import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { LIGHT_THEME, FONT_SIZE } from '@kynviora/presentation';

/** Glyphs distinguishable by shape, standing in for a real icon set. */
const TAB_GLYPHS = {
  today: '◉',
  shelf: '▤',
  safety: '⛉',
  care: '♡',
  you: '☰',
} as const;

function TabIcon({ glyph, color }: { glyph: string; color: string }) {
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

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        tabBarActiveTintColor: LIGHT_THEME.informational.foreground,
        tabBarInactiveTintColor: LIGHT_THEME.surfaceMuted.foreground,
        // Labels are always shown. An icon-only tab bar communicates by shape alone, which the
        // primary audience should not have to decode.
        tabBarShowLabel: true,
        tabBarLabelStyle: { fontSize: FONT_SIZE.caption },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Today',
          tabBarIcon: ({ color }) => <TabIcon glyph={TAB_GLYPHS.today} color={color} />,
        }}
      />
      <Tabs.Screen
        name="shelf"
        options={{
          title: 'Shelf',
          tabBarIcon: ({ color }) => <TabIcon glyph={TAB_GLYPHS.shelf} color={color} />,
        }}
      />
      <Tabs.Screen
        name="safety"
        options={{
          title: 'Safety',
          tabBarIcon: ({ color }) => <TabIcon glyph={TAB_GLYPHS.safety} color={color} />,
        }}
      />
      <Tabs.Screen
        name="care"
        options={{
          title: 'Care',
          tabBarIcon: ({ color }) => <TabIcon glyph={TAB_GLYPHS.care} color={color} />,
        }}
      />
      <Tabs.Screen
        name="you"
        options={{
          title: 'You',
          tabBarIcon: ({ color }) => <TabIcon glyph={TAB_GLYPHS.you} color={color} />,
        }}
      />
    </Tabs>
  );
}
