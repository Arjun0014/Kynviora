/**
 * When Kynviora is allowed to interrupt somebody, and what reaches a device at all.
 *
 * Spec references: `04` Phase 7.5 (urgency-based delivery policy; quiet hours), `10` (state the
 * limits where you state the findings), `16` (a setting whose effect its holder cannot see is
 * indistinguishable from a bug), `14` (step-up for a change to what leaves the profile), `18`,
 * `02`, `09`.
 *
 * THIS SCREEN COMPOSES NOTHING
 * Every sentence is either the server's - the channel descriptions and the window label, which it
 * reads from the domain's own ceiling - or `@kynviora/presentation`'s, which is the same module
 * the server reads them from. Nothing here is assembled from parts. A client that built the
 * urgency table would be describing a policy the server does not have, in every build that ever
 * shipped.
 *
 * THE EXCEPTION IS NOT A FOOTNOTE
 * Quiet hours do not silence a critical safety alert. That sits with the heading rather than
 * under the controls, because a person who believed the opposite would be relying on Kynviora for
 * something it will not do - and they would find out on the night it mattered.
 *
 * AND NEITHER IS "THIS IS NOT WORKING YET"
 * `quietHoursApplied` comes from the server and is `false` in this build (`DEV-030`, `BLK-009`).
 * A screen that let somebody set a window and said nothing would be making a promise the build
 * does not keep. Which sentence to show is `notificationPolicyView`'s answer, not this file's, so
 * the rule is tested once rather than once per surface - and it is shown whether or not a window
 * is set, because the person who most needs it is the one about to set their first.
 *
 * THE TABLE IS NOT A CONTROL
 * Nothing about which urgency reaches a device is settable, and the copy says so. A person who
 * could raise every urgency to an interrupt would have rebuilt the alarm optimisation `02`
 * refuses, one row at a time.
 */

import { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import {
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  QUIET_HOURS_COPY,
  URGENCY_CHANNEL_COPY,
  presentUrgency,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import { quietHoursFromClock, type QuietHours } from '@kynviora/domain';
import type { NotificationPolicyView } from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { useThemedStyles } from '@/theme/ThemeProvider';

export interface DeliveryPolicyProps {
  readonly view: NotificationPolicyView;
  /** `null` clears the window. The caller sends the whole policy, ceiling included. */
  readonly onSave: (window: QuietHours | null) => void;
  readonly state: ScreenStateKind | null;
  readonly stateMessage: string | null;
  /** What was recorded, said after the fact. `null` while nothing has been. */
  readonly savedNote: string | null;
}

/** Minutes from local midnight, as a 24-hour clock. The inverse of what the domain parses. */
function clockText(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function DeliveryPolicy({
  view,
  onSave,
  state,
  stateMessage,
  savedNote,
}: DeliveryPolicyProps) {
  const styles = useThemedStyles(makeStyles);
  const [start, setStart] = useState(
    view.quietHours === null ? '' : clockText(view.quietHours.startMinute),
  );
  const [end, setEnd] = useState(
    view.quietHours === null ? '' : clockText(view.quietHours.endMinute),
  );
  /** The domain's refusal, which names the field a person has to correct. */
  const [refusal, setRefusal] = useState<{ message: string; field: string } | null>(null);

  const submit = useCallback(
    (nextStart: string, nextEnd: string) => {
      setRefusal(null);
      const parsed = quietHoursFromClock(nextStart, nextEnd);
      if (!parsed.ok) {
        // Refused here rather than at the server, because the server takes minutes and this is
        // the only layer that sees what somebody typed. The message and the field are the
        // domain's; nothing is invented.
        const field = parsed.error.detail?.['field'];
        setRefusal({
          message: parsed.error.reason,
          field: typeof field === 'string' ? field : '',
        });
        return;
      }
      onSave(parsed.value);
    },
    [onSave],
  );

  return (
    <View style={styles.container}>
      {/* ------------------------------------------------------------------ */}
      {/* What reaches a device. A statement, not a control.                  */}
      {/* ------------------------------------------------------------------ */}
      <Text accessibilityRole="header" style={styles.heading}>
        {URGENCY_CHANNEL_COPY.heading}
      </Text>
      <Text style={styles.body}>{URGENCY_CHANNEL_COPY.intro}</Text>

      {view.urgencyChannels.map((line) => (
        <View key={line.urgency} style={styles.row}>
          {/* The urgency as a phrase. Never its code beside somebody's medicine (trap 129). */}
          <Text style={styles.rowLabel}>{presentUrgency(line.urgency).label}</Text>
          <Text style={styles.body}>{line.channelLabel}</Text>
          <Text style={styles.help}>{line.channelDescription}</Text>
        </View>
      ))}

      <Text style={styles.help}>{URGENCY_CHANNEL_COPY.foreignNote}</Text>

      {/* ------------------------------------------------------------------ */}
      {/* Quiet hours.                                                        */}
      {/* ------------------------------------------------------------------ */}
      <Text accessibilityRole="header" style={styles.heading}>
        {QUIET_HOURS_COPY.heading}
      </Text>
      <Text style={styles.body}>{QUIET_HOURS_COPY.help}</Text>
      {/* With the heading, not under the controls. See the module note. */}
      <Text style={styles.exception}>{QUIET_HOURS_COPY.exception}</Text>

      <Text style={styles.body}>
        {view.quietHoursLabel === null ? QUIET_HOURS_COPY.notSet : view.quietHoursLabel}
      </Text>

      {/* Said whether or not a window is set. The person who most needs it is the one about to
          set their first one; the view decides, so no surface can forget (see the module note). */}
      {view.limitationNote === null ? null : (
        <Text style={styles.limitation}>{view.limitationNote}</Text>
      )}

      {state !== null ? <ScreenState state={state} message={stateMessage} /> : null}
      {savedNote === null ? null : <Text style={styles.saved}>{savedNote}</Text>}

      {view.mayChangePolicy ? (
        view.quietHoursUnreadable ? (
          // The server reported a window whose numbers this build could not read. Offering an
          // editor prefilled with nothing would clear it the moment somebody pressed save, so the
          // controls are absent and the label above still shows what is set.
          <Text style={styles.limitation}>{QUIET_HOURS_COPY.unreadableWindow}</Text>
        ) : (
          <>
            <View style={styles.field}>
              <Text style={styles.rowLabel}>{QUIET_HOURS_COPY.startLabel}</Text>
              <Text style={styles.help}>{QUIET_HOURS_COPY.fieldHelp}</Text>
              <TextInput
                accessibilityLabel={`${QUIET_HOURS_COPY.startLabel}. ${QUIET_HOURS_COPY.fieldHelp}`}
                value={start}
                onChangeText={setStart}
                autoCorrect={false}
                autoCapitalize="none"
                placeholder="22:00"
                style={[
                  styles.input,
                  refusal?.field === 'quietHoursStart' ? styles.inputRefused : null,
                ]}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.rowLabel}>{QUIET_HOURS_COPY.endLabel}</Text>
              <Text style={styles.help}>{QUIET_HOURS_COPY.fieldHelp}</Text>
              <TextInput
                accessibilityLabel={`${QUIET_HOURS_COPY.endLabel}. ${QUIET_HOURS_COPY.fieldHelp}`}
                value={end}
                onChangeText={setEnd}
                autoCorrect={false}
                autoCapitalize="none"
                placeholder="07:00"
                style={[
                  styles.input,
                  refusal?.field === 'quietHoursEnd' ? styles.inputRefused : null,
                ]}
              />
            </View>

            {refusal === null ? null : <Text style={styles.refusal}>{refusal.message}</Text>}

            <Text style={styles.help}>{QUIET_HOURS_COPY.stepUpPrompt}</Text>

            <PrimaryButton
              label={QUIET_HOURS_COPY.saveLabel}
              disabled={state === 'LOADING'}
              onPress={() => {
                submit(start, end);
              }}
            />

            {/* Absent where there is nothing to turn off, rather than a control that does
                nothing. Clearing is emptying both fields, so it goes through the same path. */}
            {view.quietHours === null ? null : (
              <PrimaryButton
                label={QUIET_HOURS_COPY.clearLabel}
                variant="secondary"
                disabled={state === 'LOADING'}
                onPress={() => {
                  setStart('');
                  setEnd('');
                  submit('', '');
                }}
              />
            )}
          </>
        )
      ) : (
        // A caregiver reads the window and changes nothing. Said, rather than left as a screen
        // with no controls on it - `16`: a setting whose effect its holder cannot see is
        // indistinguishable from a bug.
        <Text style={styles.limitation}>{QUIET_HOURS_COPY.ownerOnly}</Text>
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { gap: SPACING.md },
    heading: {
      fontSize: FONT_SIZE.title,
      fontWeight: '700',
      color: theme.surface.foreground,
    },
    body: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surface.foreground,
    },
    help: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    // The one sentence a person must read before relying on quiet hours, given its own weight.
    exception: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.informational.foreground,
      backgroundColor: theme.informational.background,
      borderColor: theme.informational.border,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      padding: SPACING.md,
    },
    limitation: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    saved: {
      fontSize: FONT_SIZE.body,
      color: theme.positive.foreground,
    },
    refusal: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.attention.foreground,
    },
    row: {
      gap: 2,
      padding: SPACING.md,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.surface.border,
      backgroundColor: theme.surface.background,
    },
    rowLabel: {
      fontSize: FONT_SIZE.body,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    field: { gap: SPACING.xs },
    input: {
      minHeight: MIN_TOUCH_TARGET_DP,
      paddingHorizontal: SPACING.sm,
      paddingVertical: SPACING.sm,
      borderWidth: 1,
      borderRadius: SPACING.sm,
      borderColor: theme.surface.border,
      backgroundColor: theme.surfaceMuted.background,
      fontSize: FONT_SIZE.body,
      color: theme.surface.foreground,
    },
    // `attention`, not `action`. A mistyped time is something to fix, not a recall.
    inputRefused: {
      borderColor: theme.attention.border,
      backgroundColor: theme.attention.background,
    },
  });
