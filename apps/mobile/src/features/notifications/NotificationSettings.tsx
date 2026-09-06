/**
 * Notification settings screen.
 *
 * Spec references: `04` Phase 8.2, `03` group H (generic notification content by default), `16`
 * (caregiver notifications reveal minimal information; capabilities are human-readable), `15` A6
 * (a notification leaking health information to a lock screen), `18` (plain language, 48dp
 * targets, limitations stated).
 *
 * THE ONE THING THIS SCREEN MUST NOT DO
 * It must not let someone believe they are getting less than they are. Each option shows the
 * actual notification text that level produces, rendered through the same function the server
 * dispatches with, so the example cannot drift from the behaviour. A hand-written example would
 * be free to describe a level as private while the renderer printed a name.
 *
 * When the profile owner's ceiling reduces what a caregiver chose, the screen says so. `16` makes
 * capabilities human-readable for the same reason: a setting whose effect its holder cannot see
 * is indistinguishable from a bug, and someone who quietly concludes the app is broken stops
 * trusting the settings that are working.
 */

import { Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import {
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  ALERT_DELIVERY_COPY,
  notificationSettingsView,
  previewNotification,
  type Theme,
} from '@kynviora/presentation';
import type { NotificationDetailLevel } from '@kynviora/domain';
import { ScreenState } from '@/components/ScreenState';
import type { ScreenState as ScreenStateKind } from '@kynviora/presentation';
import { useThemedStyles } from '@/theme/ThemeProvider';

export interface NotificationSettingsProps {
  readonly state: ScreenStateKind;
  readonly relationship: 'OWNER' | 'CAREGIVER';
  readonly maxCaregiverDetail: NotificationDetailLevel;
  /** Null when this person has never chosen, which is not the same as choosing GENERIC. */
  readonly myPreference: NotificationDetailLevel | null;
  readonly effective: NotificationDetailLevel;
  /** Used only to render the example text. Never sent anywhere. */
  readonly profileDisplayName: string;
  readonly exampleItemName: string | null;
  readonly onChoose: (level: NotificationDetailLevel) => void;
  readonly onRetry?: () => void;
}

export function NotificationSettings({
  state,
  relationship,
  maxCaregiverDetail,
  myPreference,
  effective,
  profileDisplayName,
  exampleItemName,
  onChoose,
  onRetry,
}: NotificationSettingsProps) {
  const styles = useThemedStyles(makeStyles);
  if (state !== 'READY') {
    return <ScreenState state={state} {...(onRetry ? { onRetry } : {})} />;
  }

  const view = notificationSettingsView({
    relationship,
    maxCaregiverDetail,
    myPreference,
    effective,
  });

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.heading}>
        Notifications
      </Text>
      <Text style={styles.intro}>{ALERT_DELIVERY_COPY.settingsIntro}</Text>

      {view.capNote !== null ? <Text style={styles.capNote}>{view.capNote}</Text> : null}

      {view.levels.map((option) => {
        const example = previewNotification(option.level, {
          profileDisplayName,
          itemDisplayName: exampleItemName,
        });
        return (
          <Pressable
            key={option.level}
            accessibilityRole="radio"
            accessibilityState={{ selected: option.selected, disabled: option.unavailable }}
            // The example is part of the label rather than a separate node: a screen reader user
            // choosing a privacy level needs to hear what it would say, not only its name.
            accessibilityLabel={`${option.label}. ${option.meaning} For example: ${example}`}
            disabled={option.unavailable}
            onPress={() => onChoose(option.level)}
            style={[
              styles.option,
              option.selected ? styles.optionSelected : null,
              option.unavailable ? styles.optionUnavailable : null,
            ]}
          >
            <Text style={styles.optionLabel}>{option.label}</Text>
            <Text style={styles.optionMeaning}>{option.meaning}</Text>
            {/* The real string, from the real renderer. */}
            <Text style={styles.example}>{example}</Text>
            {option.unavailable ? (
              <Text style={styles.unavailableNote}>
                Not available while the ceiling is set lower.
              </Text>
            ) : null}
          </Pressable>
        );
      })}

      {/* 03 group H, said out loud rather than only enforced on the server. */}
      <Text style={styles.limitation}>{ALERT_DELIVERY_COPY.separatePermissions}</Text>
    </ScrollView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    content: { padding: SPACING.lg, gap: SPACING.md },
    heading: {
      fontSize: FONT_SIZE.heading,
      fontWeight: '700',
      color: theme.surface.foreground,
    },
    intro: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surface.foreground,
    },
    capNote: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.informational.foreground,
      backgroundColor: theme.informational.background,
      borderColor: theme.informational.border,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      padding: SPACING.md,
    },
    option: {
      // 48dp minimum target (spec 18). Padding plus three lines of text clears it comfortably.
      minHeight: SPACING.xxxl,
      padding: SPACING.md,
      gap: SPACING.xs,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.surface.border,
      backgroundColor: theme.surface.background,
    },
    optionSelected: { borderWidth: 2, borderColor: theme.surface.foreground },
    // Marked rather than hidden: a missing option is indistinguishable from a broken screen.
    optionUnavailable: { backgroundColor: theme.surfaceMuted.background },
    optionLabel: {
      fontSize: FONT_SIZE.title,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    optionMeaning: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    example: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
      color: theme.surface.foreground,
    },
    unavailableNote: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    limitation: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
  });
