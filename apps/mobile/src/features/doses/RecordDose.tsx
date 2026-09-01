/**
 * Recording what happened with a medicine, and reading it back.
 *
 * Spec references: `04` Phase 4.3 ("record what happened without gamifying or judging them"),
 * `02` (gamified adherence scoring is an anti-feature), `18` (no shame; a text label always
 * present; 48dp targets), `09` (never say what to do about a medicine), `13` (idempotency).
 *
 * FOUR EQUAL CONTROLS
 * "I took it" is not styled as the primary action and the other three are not secondary. One
 * emphasised button is a preference, and a screen with a preference about whether somebody took
 * their medicine is judging them before they have answered. They are one list, in the
 * vocabulary's own order, all the same weight.
 *
 * WHAT THE HISTORY DOES NOT SHOW
 * A count, a rate, a streak, a percentage, or a run of green ticks. `doseHistory` returns no
 * number that could become one, so there is nothing here to render even by accident - which is
 * the point of the decision living in the contracts package rather than in this file.
 *
 * The note is the person's own account and is rendered exactly as it was typed.
 */

import { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  DOSE_COPY,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import type { DoseEventKind } from '@kynviora/domain';
import { buildDoseRecord, doseActions, type DoseHistoryView } from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { StatusChip } from '@/components/StatusChip';

export interface RecordDoseProps {
  readonly ownedItemId: string;
  readonly itemKind: string;
  readonly displayName: string;
  /** Performed by the caller, which owns the idempotency key for the attempt. */
  readonly onRecord: (body: {
    readonly ownedItemId: string;
    readonly eventKind: DoseEventKind;
    readonly note?: string;
  }) => void;
  readonly onClose: () => void;
  readonly history: DoseHistoryView;
  readonly historyState: ScreenStateKind;
  readonly state?: ScreenStateKind | null;
  readonly stateMessage?: string | null;
  readonly recorded?: boolean;
}

export function RecordDose({
  ownedItemId,
  itemKind,
  displayName,
  onRecord,
  onClose,
  history,
  historyState,
  state,
  stateMessage,
  recorded,
}: RecordDoseProps) {
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {DOSE_COPY.recordHeading}
      </Text>
      <Text style={styles.name}>{displayName}</Text>
      <Text style={styles.body}>{DOSE_COPY.recordIntro}</Text>
      {/* The sentence that earns its place: somebody about to record a skipped dose is entitled
          to know nothing is keeping count, and an absent score cannot state itself. */}
      <Text style={styles.help}>{DOSE_COPY.notScored}</Text>

      <Text style={styles.label}>{DOSE_COPY.noteLabel}</Text>
      <Text style={styles.help}>{DOSE_COPY.noteHelp}</Text>
      <TextInput
        accessibilityLabel={DOSE_COPY.noteLabel}
        value={note}
        onChangeText={setNote}
        multiline
        style={styles.input}
      />

      {/* All four the same weight. An emphasised "I took it" is a preference about somebody's
          treatment, expressed in a button style. */}
      {doseActions().map((action) => (
        <PrimaryButton
          key={action.kind}
          label={action.label}
          variant="secondary"
          accessibilityHint={action.accessibilityLabel}
          onPress={() => {
            const draft = buildDoseRecord({
              ownedItemId,
              itemKind,
              eventKind: action.kind,
              note,
            });
            if (!draft.ok || draft.body === null) {
              setRefusal(draft.refusal?.message ?? null);
              return;
            }
            setRefusal(null);
            onRecord(draft.body);
          }}
        />
      ))}

      {refusal === null ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.warning}>
          {refusal}
        </Text>
      )}

      {recorded === true ? (
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {DOSE_COPY.recordedDone}
        </Text>
      ) : null}

      {state != null && state !== 'READY' ? (
        <ScreenState state={state} message={stateMessage} />
      ) : null}

      <Text accessibilityRole="header" style={styles.heading}>
        {DOSE_COPY.historyHeading}
      </Text>

      {historyState !== 'READY' && historyState !== 'EMPTY' ? (
        <ScreenState state={historyState} />
      ) : history.lines.length === 0 ? (
        // Not "well done" and not "nothing to report". Nothing recorded means nothing recorded.
        <Text style={styles.body}>{history.emptyMessage}</Text>
      ) : (
        history.lines.map((line) => (
          <View key={line.id} style={styles.line}>
            <StatusChip presentation={line.presentation} />
            <Text style={styles.when}>{line.recordedOn}</Text>
            {line.scheduledOn === null ? null : (
              <Text style={styles.when}>
                {DOSE_COPY.scheduledPrefix} {line.scheduledOn}
              </Text>
            )}
            {/* Verbatim. It is what the person wrote about their own treatment. */}
            {line.note === null ? null : <Text style={styles.body}>{line.note}</Text>}
          </View>
        ))
      )}

      <PrimaryButton label="Done" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: SPACING.md,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  heading: {
    fontSize: FONT_SIZE.title,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  name: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.surface.foreground,
  },
  label: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  help: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  warning: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
    color: LIGHT_THEME.attention.foreground,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET_DP,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: FONT_SIZE.body,
    color: LIGHT_THEME.surface.foreground,
  },
  line: {
    gap: SPACING.xxs,
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: LIGHT_THEME.surface.border,
  },
  when: {
    fontSize: FONT_SIZE.caption,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
