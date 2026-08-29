/**
 * Today screen.
 *
 * Placeholder pending the data layer. It renders the empty state deliberately rather than
 * nothing: spec 06 requires every critical route to define its loading, empty, offline and error
 * states, and a screen with only a success path is incomplete by that definition.
 */

import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LIGHT_THEME, SPACING, FONT_SIZE, LINE_HEIGHT_MULTIPLIER } from '@kynviora/presentation';
import { ScreenState } from '@/components/ScreenState';

export default function TodayScreen() {
  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.heading}>
          Today
        </Text>
        <Text style={styles.body}>
          Due medicines, appointments and anything that needs review appear here.
        </Text>

        <View style={styles.stateWrapper}>
          <ScreenState kind="empty" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: LIGHT_THEME.surface.background },
  content: { padding: SPACING.lg, gap: SPACING.md },
  heading: {
    fontSize: FONT_SIZE.heading,
    fontWeight: '700',
    color: LIGHT_THEME.surface.foreground,
  },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  stateWrapper: { marginTop: SPACING.lg },
});
