/**
 * Asking which value now stands.
 *
 * Spec references: `04` Phase 8.5, `09` (Kynviora never decides which conflicting instruction is
 * medically correct), `18` (never present a choice as though one answer were expected), DEC-030,
 * traps 19-21.
 *
 * THE SCREEN THAT EXISTS BECAUSE THE SYSTEM MUST NOT ANSWER
 * Choosing "a pharmacist confirmed it" does not say *which value* they confirmed - they may
 * perfectly well have confirmed the older dose - so this asks. Both sides come from `presentSide`,
 * which returns the same tone and `emphasised: false` for each, and they are rendered from one
 * style object: two styles that happen to match today are two styles that can drift apart
 * tomorrow, and the drift is the exit criterion.
 *
 * Neither button is pre-selected, neither is styled as primary, and there is no "recommended"
 * marker of any kind. A highlighted default is a recommendation whatever the label says, and on
 * this screen a recommendation is Kynviora choosing between two medical instructions.
 */

import { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native';
import {
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  RECONCILIATION_COPY,
  presentSide,
  resolutionOption,
  type Theme,
} from '@kynviora/presentation';
import type { AdoptableSide, ReconciliationResolution } from '@kynviora/domain';
import { buildResolution, type DifferenceResolution } from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useTheme, useThemedStyles } from '@/theme/ThemeProvider';

export interface ResolutionPromptProps {
  readonly resolution: ReconciliationResolution;
  readonly displayName: string;
  readonly previousValue: string | null;
  readonly currentValue: string | null;
  readonly onRecord: (body: DifferenceResolution) => void;
  readonly onCancel: () => void;
}

export function ResolutionPrompt({
  resolution,
  displayName,
  previousValue,
  currentValue,
  onRecord,
  onCancel,
}: ResolutionPromptProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const option = resolutionOption(resolution);
  const [side, setSide] = useState<AdoptableSide | null>(option.fixedSide);
  const [confirmedBy, setConfirmedBy] = useState('');
  const [note, setNote] = useState('');

  // The same function that builds the payload decides whether the button is enabled, so the
  // control cannot say yes to something the builder would refuse.
  const draft = useMemo(
    () => buildResolution({ resolution, adopt: side, confirmedBy, note }),
    [resolution, side, confirmedBy, note],
  );

  const sides = [presentSide('PREVIOUS', previousValue), presentSide('CURRENT', currentValue)];

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {displayName}
      </Text>
      <Text style={styles.body}>{option.label}</Text>
      <Text style={styles.help}>{option.meaning}</Text>

      {/* Said here as well as on the list. This is the moment a person might expect the app to
          have an opinion, and it is the moment it must be clearest that it does not. */}
      <Text style={styles.statement}>{RECONCILIATION_COPY.neitherIsChosen}</Text>

      {option.settles && option.fixedSide === null ? (
        <>
          <Text style={styles.label}>Which version now stands?</Text>
          {sides.map((view) => {
            const chosen = side === view.side;
            return (
              <Pressable
                key={view.side}
                accessibilityRole="radio"
                accessibilityState={{ selected: chosen }}
                accessibilityLabel={`${view.label}. ${view.value}`}
                onPress={() => {
                  setSide(view.side);
                }}
                // One style object for both sides. Bolding the newer value would choose for the
                // user without a sentence saying so (trap 21).
                style={[
                  styles.side,
                  {
                    backgroundColor: chosen
                      ? theme.informational.background
                      : theme[view.tone].background,
                    borderColor: chosen ? theme.informational.border : theme[view.tone].border,
                  },
                ]}
              >
                {/* The marker duplicates the accessibilityState, so the selection is never
                    carried by colour alone. */}
                <Text style={styles.sideLabel}>
                  {chosen ? '●  ' : '○  '}
                  {view.label}
                </Text>
                <Text style={styles.sideValue}>{view.value}</Text>
              </Pressable>
            );
          })}
        </>
      ) : null}

      {option.needsName ? (
        <>
          <Text style={styles.label}>Who confirmed it</Text>
          <Text style={styles.help}>
            A name or a practice. Kynviora records it so you can say later who told you.
          </Text>
          <TextInput
            accessibilityLabel="Who confirmed it"
            value={confirmedBy}
            onChangeText={setConfirmedBy}
            style={styles.input}
          />
        </>
      ) : null}

      <Text style={styles.label}>Anything worth remembering</Text>
      <TextInput
        accessibilityLabel="Anything worth remembering"
        value={note}
        onChangeText={setNote}
        multiline
        style={[styles.input, styles.noteInput]}
      />

      {/* Why the button is disabled, whenever it is. `12` requires the user to be told what they
          can do next rather than left to guess at a greyed-out control. */}
      {draft.ok ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.blocked}>
          {draft.refusal.message}
        </Text>
      )}

      <PrimaryButton
        label="Record this"
        disabled={!draft.ok}
        onPress={() => {
          if (draft.ok) onRecord(draft.body);
        }}
      />
      <PrimaryButton label="Back" variant="secondary" onPress={onCancel} />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      gap: SPACING.md,
      padding: SPACING.md,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.surface.border,
      backgroundColor: theme.surface.background,
    },
    heading: {
      fontSize: FONT_SIZE.title,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    body: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
      color: theme.surface.foreground,
    },
    statement: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    label: {
      fontSize: FONT_SIZE.body,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    help: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    side: {
      minHeight: MIN_TOUCH_TARGET_DP,
      gap: SPACING.xxs,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
    },
    sideLabel: {
      fontSize: FONT_SIZE.caption,
      color: theme.surfaceMuted.foreground,
    },
    sideValue: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
      color: theme.surface.foreground,
    },
    input: {
      minHeight: MIN_TOUCH_TARGET_DP,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.surface.border,
      paddingHorizontal: SPACING.md,
      fontSize: FONT_SIZE.body,
      color: theme.surface.foreground,
    },
    noteInput: {
      minHeight: MIN_TOUCH_TARGET_DP * 2,
      paddingVertical: SPACING.sm,
      textAlignVertical: 'top',
    },
    blocked: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.attention.foreground,
    },
  });
