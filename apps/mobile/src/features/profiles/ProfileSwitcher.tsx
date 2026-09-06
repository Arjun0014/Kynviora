/**
 * Whose records are on screen, and changing whose.
 *
 * Spec references: `04` Phase 1.2 ("profile switcher with persistent identity context", and the
 * exit criterion "screens cannot accidentally display one profile's data under another profile
 * identity"), `13` ("never trust a profile ID in the request as proof of access"), `16`, `18`.
 *
 * THE NAME IS ALWAYS ON THE SCREEN
 * The exit criterion is about what a person can see. A switcher that only showed the list when
 * opened would leave every other screen unlabelled, and the failure is silent: somebody reads
 * their mother's medicine list under their own name and nothing contradicts them. So the active
 * profile's name is rendered whether or not the list is open.
 *
 * A SELECTION THE SERVER NO LONGER OFFERS BECOMES NO SELECTION
 * `profileSwitcherView` decides that, not this file. A caregiver grant can be revoked between
 * launches, and falling back to whoever is first is precisely the accident the criterion names.
 * When it happens the screen says so and asks for a choice, rather than moving quietly.
 *
 * SELECTING GRANTS NOTHING
 * Every request carries the profile as a filter and the server applies row-level security
 * regardless, so a stale selection produces an empty screen rather than somebody else's data.
 */

import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  PROFILE_COPY,
  type Theme,
} from '@kynviora/presentation';
import type { ProfileSwitcherView } from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useThemedStyles } from '@/theme/ThemeProvider';

export interface ProfileSwitcherProps {
  readonly view: ProfileSwitcherView;
  readonly onSelect: (profileId: string) => void;
  /** Opens the creation screen. Present wherever a person may add somebody. */
  readonly onAddPerson: () => void;
}

export function ProfileSwitcher({ view, onSelect, onAddPerson }: ProfileSwitcherProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        Who these records are for
      </Text>

      {/* Always rendered. See the module note - an unlabelled screen is the failure the exit
          criterion is about. */}
      <Text style={styles.active}>
        {view.activeName === null ? 'No one is selected.' : view.activeName}
      </Text>

      {view.selectionDropped ? (
        // Said, not silently corrected. Access can change between launches, and a person who is
        // not told will assume they are still looking at the same person.
        <Text style={styles.note}>
          The person you were looking at is not available to you now. Choose who to look at.
        </Text>
      ) : null}

      {view.lines.map((line) => (
        <Pressable
          key={line.id}
          accessibilityRole="radio"
          accessibilityState={{ checked: line.isActive }}
          accessibilityLabel={accessibilityLabelFor(line)}
          onPress={() => {
            onSelect(line.id);
          }}
          style={[styles.row, line.isActive ? styles.rowActive : null]}
        >
          {/* A mark as well as the border: meaning is never carried by colour alone (`18`). */}
          <Text style={styles.rowLabel}>
            {line.isActive ? '✓ ' : ''}
            {line.displayName}
          </Text>
          <Text style={styles.help}>
            {/* The schema's word is `is_managed`; a person reads "someone you look after". */}
            {line.isSelf ? PROFILE_COPY.selfLabel : PROFILE_COPY.otherLabel}
            {line.ageLabel === null ? '' : ` · ${line.ageLabel}`}
          </Text>
        </Pressable>
      ))}

      <PrimaryButton label="Add someone" variant="secondary" onPress={onAddPerson} />
    </View>
  );
}

/** The row read as one sentence, so a screen reader announces who and what before the state. */
function accessibilityLabelFor(line: ProfileSwitcherView['lines'][number]): string {
  const relationship = line.isSelf ? PROFILE_COPY.selfLabel : PROFILE_COPY.otherLabel;
  const age = line.ageLabel === null ? '' : `. ${line.ageLabel}`;
  return `${line.displayName}. ${relationship}${age}`;
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { gap: SPACING.sm },
    heading: {
      fontSize: FONT_SIZE.title,
      fontWeight: '700',
      color: theme.surface.foreground,
    },
    active: {
      fontSize: FONT_SIZE.body,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    help: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    note: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.attention.foreground,
      backgroundColor: theme.attention.background,
      borderColor: theme.attention.border,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      padding: SPACING.md,
    },
    row: {
      minHeight: MIN_TOUCH_TARGET_DP,
      gap: 2,
      padding: SPACING.md,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.surface.border,
      backgroundColor: theme.surface.background,
    },
    rowActive: {
      borderColor: theme.informational.border,
      backgroundColor: theme.informational.background,
    },
    rowLabel: {
      fontSize: FONT_SIZE.body,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
  });
