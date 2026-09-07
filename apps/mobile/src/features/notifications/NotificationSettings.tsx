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

import { View, StyleSheet, Pressable } from 'react-native';
import {
  MIN_TOUCH_TARGET_DP,
  RADIUS,
  SPACING,
  ALERT_DELIVERY_COPY,
  notificationSettingsView,
  previewNotification,
  type Theme,
} from '@kynviora/presentation';
import type { NotificationDetailLevel } from '@kynviora/domain';
import { ScreenState } from '@/components/ScreenState';
import { Typography } from '@/components/Typography';
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
    <>
      <Typography role="body" colour="secondary">
        {ALERT_DELIVERY_COPY.settingsIntro}
      </Typography>

      {view.capNote === null ? null : (
        <View style={styles.capNote}>
          <Typography role="body" colour="informational">
            {view.capNote}
          </Typography>
        </View>
      )}

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
            {/* The mark is in the text as well as in the border, because `18` forbids meaning
                carried by colour alone - and a chosen privacy level is the one setting on this
                screen a person most needs to be sure about. */}
            <Typography role="title" decorative>
              {option.selected ? '\u2713  ' : ''}
              {option.label}
            </Typography>
            <Typography role="caption" colour="secondary" decorative>
              {option.meaning}
            </Typography>
            {/* The real string, from the real renderer, in a sunken well - it is a quotation of
                what a locked screen would show rather than something Kynviora is saying now. */}
            <View style={styles.example}>
              <Typography role="body" decorative>
                {example}
              </Typography>
            </View>
            {option.unavailable ? (
              <Typography role="caption" colour="secondary" decorative>
                Not available while the ceiling is set lower.
              </Typography>
            ) : null}
          </Pressable>
        );
      })}

      {/* 03 group H, said out loud rather than only enforced on the server. */}
      <Typography role="caption" colour="secondary">
        {ALERT_DELIVERY_COPY.separatePermissions}
      </Typography>
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    capNote: {
      backgroundColor: theme.informational.background,
      borderColor: theme.informational.border,
      borderWidth: 1,
      borderRadius: RADIUS.md,
      padding: SPACING.md,
    },
    // A card a person can press. Drawn here rather than wrapping `Card`, because a `Card` is a
    // `View` and this has to be the pressable node itself - one announced control, not a control
    // inside a container that also announces.
    option: {
      // 48dp minimum target (`18`). Padding plus three lines of text clears it comfortably, and
      // `minHeight` rather than `height` so it grows with the font scale instead of clipping.
      minHeight: MIN_TOUCH_TARGET_DP,
      padding: SPACING.lg,
      gap: SPACING.sm,
      borderWidth: 1,
      borderRadius: RADIUS.lg,
      borderColor: theme.surface.border,
      backgroundColor: theme.surface.background,
    },
    // `selection`, which is the one hue in this app about the interface rather than about a
    // product (DEC-130). The tick in the label is what carries it for somebody who cannot see the
    // colour.
    optionSelected: { borderWidth: 2, borderColor: theme.selection.border },
    // Marked rather than hidden: a missing option is indistinguishable from a broken screen.
    optionUnavailable: { backgroundColor: theme.surfaceMuted.background },
    example: {
      padding: SPACING.md,
      borderRadius: RADIUS.md,
      backgroundColor: theme.sunken.background,
    },
  });
