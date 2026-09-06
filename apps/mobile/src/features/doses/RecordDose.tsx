/**
 * Recording what happened with a medicine, and reading it back.
 *
 * Spec references: `04` Phase 4.3 ("record what happened without gamifying or judging them"),
 * `02` (gamified adherence scoring is an anti-feature), `18` (no shame; a text label always
 * present; 48dp targets), `09` (never say what to do about a medicine), `13` (idempotency),
 * DEC-130.
 *
 * FOUR EQUAL CONTROLS
 * "I took it" is not styled as the primary action and the other three are not secondary. One
 * emphasised button is a preference, and a screen with a preference about whether somebody took
 * their medicine is judging them before they have answered. They are one list, in the
 * vocabulary's own order, all the same weight.
 *
 * This is the one screen in the app where the design system's "one primary action" rule is
 * deliberately not applied, and the reason is the rule above it. `18` asks for one obvious next
 * step on a **high-impact safety screen**; this is a screen where four steps are equally
 * legitimate and the app has no opinion about which. Making one of them the accent would be an
 * opinion. "Done" is the only accent here, and it closes the sheet.
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
  SPACING,
  RADIUS,
  FONT_SIZE,
  MIN_TOUCH_TARGET_DP,
  DOSE_COPY,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import type { DoseEventKind } from '@kynviora/domain';
import { buildDoseRecord, doseActions, type DoseHistoryView } from '@kynviora/contracts';
import { Card } from '@/components/Card';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { SectionHeader } from '@/components/SectionHeader';
import { StatusChip } from '@/components/StatusChip';
import { Typography } from '@/components/Typography';
import { useThemedStyles } from '@/theme/ThemeProvider';
import { haptic } from '@/platform/haptics';

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
  /**
   * Whether the dose is in the offline journal rather than on the server.
   *
   * A different promise from {@link recorded} and said in different words. "Recorded." means the
   * server has it; this one says where it actually is and when it will move, because a person who
   * was told their record was safe and then reinstalled the app would find it gone.
   */
  readonly queued?: boolean;
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
  queued,
}: RecordDoseProps) {
  const styles = useThemedStyles(makeStyles);
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <View style={styles.container}>
      <Card level="raised">
        <Typography role="title" heading>
          {DOSE_COPY.recordHeading}
        </Typography>
        <Typography role="bodyLarge">{displayName}</Typography>
        <Typography role="body" colour="secondary">
          {DOSE_COPY.recordIntro}
        </Typography>
        {/* The sentence that earns its place: somebody about to record a skipped dose is entitled
            to know nothing is keeping count, and an absent score cannot state itself. */}
        <Typography role="caption" colour="secondary">
          {DOSE_COPY.notScored}
        </Typography>
      </Card>

      <Card>
        <Typography role="label">{DOSE_COPY.noteLabel}</Typography>
        <Typography role="caption" colour="secondary">
          {DOSE_COPY.noteHelp}
        </Typography>
        <TextInput
          accessibilityLabel={DOSE_COPY.noteLabel}
          value={note}
          onChangeText={setNote}
          multiline
          style={styles.input}
        />

        {/* All four the same weight. An emphasised "I took it" is a preference about somebody's
            treatment, expressed in a button style. */}
        <View style={styles.actions}>
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
                  // Accompanies the sentence below; never instead of it (`18`).
                  haptic('warn');
                  setRefusal(draft.refusal?.message ?? null);
                  return;
                }
                haptic('confirm');
                setRefusal(null);
                onRecord(draft.body);
              }}
            />
          ))}
        </View>

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

        {/* Said instead of "Recorded.", never as well as it. The two are different promises, and
            the shorter one would be telling somebody the server has their record when a request
            has just failed. `12` requires a queued change to be visible rather than assumed. */}
        {queued === true ? (
          <Text accessibilityLiveRegion="polite" style={styles.body}>
            {DOSE_COPY.offlineNote}
          </Text>
        ) : null}

        {state != null && state !== 'READY' ? (
          <ScreenState state={state} message={stateMessage} />
        ) : null}
      </Card>

      <SectionHeader title={DOSE_COPY.historyHeading} />
      <Card>
        {historyState !== 'READY' && historyState !== 'EMPTY' ? (
          <ScreenState state={historyState} />
        ) : history.lines.length === 0 ? (
          // Not "well done" and not "nothing to report". Nothing recorded means nothing recorded.
          <Typography role="body" colour="secondary">
            {history.emptyMessage}
          </Typography>
        ) : (
          history.lines.map((line, index) => (
            <View key={line.id} style={[styles.line, index === 0 ? styles.firstLine : null]}>
              <StatusChip presentation={line.presentation} />
              <Typography role="caption" colour="secondary">
                {line.recordedOn}
              </Typography>
              {line.scheduledOn === null ? null : (
                <Typography role="caption" colour="secondary">
                  {DOSE_COPY.scheduledPrefix} {line.scheduledOn}
                </Typography>
              )}
              {/* Verbatim. It is what the person wrote about their own treatment. */}
              {line.note === null ? null : <Typography role="body">{line.note}</Typography>}
            </View>
          ))
        )}
      </Card>

      <PrimaryButton label="Done" onPress={onClose} />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { gap: SPACING.md },
    body: {
      fontSize: FONT_SIZE.body,
      color: theme.surface.foreground,
    },
    warning: {
      fontSize: FONT_SIZE.body,
      color: theme.attention.foreground,
    },
    input: {
      minHeight: MIN_TOUCH_TARGET_DP * 2,
      borderWidth: 1,
      borderRadius: RADIUS.md,
      borderColor: theme.line.strong,
      backgroundColor: theme.sunken.background,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
      fontSize: FONT_SIZE.body,
      color: theme.surface.foreground,
      textAlignVertical: 'top',
    },
    // The four are a set, so they are grouped and spaced away from the field above them.
    actions: { gap: SPACING.sm, marginTop: SPACING.sm },
    line: {
      gap: SPACING.xxs,
      paddingVertical: SPACING.md,
      borderTopWidth: 1,
      borderTopColor: theme.line.hairline,
      alignItems: 'flex-start',
    },
    // The first entry sits directly under the card's own padding; a rule above it would be a line
    // separating it from nothing.
    firstLine: { borderTopWidth: 0, paddingTop: 0 },
  });
