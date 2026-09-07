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
import { View, TextInput, StyleSheet } from 'react-native';
import {
  MIN_TOUCH_TARGET_DP,
  RADIUS,
  SPACING,
  QUIET_HOURS_COPY,
  URGENCY_CHANNEL_COPY,
  presentUrgency,
  typeStyle,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import { quietHoursFromClock, type QuietHours } from '@kynviora/domain';
import type { NotificationPolicyView } from '@kynviora/contracts';
import { Card } from '@/components/Card';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { SectionHeader } from '@/components/SectionHeader';
import { Typography } from '@/components/Typography';
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
    <>
      {/* ------------------------------------------------------------------ */}
      {/* What reaches a device. A statement, not a control.                  */}
      {/* ------------------------------------------------------------------ */}
      <SectionHeader
        title={URGENCY_CHANNEL_COPY.heading}
        explanation={URGENCY_CHANNEL_COPY.intro}
      />

      {view.urgencyChannels.map((line) => (
        <Card key={line.urgency}>
          {/* The urgency as a phrase. Never its code beside somebody's medicine (trap 129). */}
          <Typography role="title" heading>
            {presentUrgency(line.urgency).label}
          </Typography>
          <Typography role="body">{line.channelLabel}</Typography>
          <Typography role="caption" colour="secondary">
            {line.channelDescription}
          </Typography>
        </Card>
      ))}

      <Typography role="caption" colour="secondary">
        {URGENCY_CHANNEL_COPY.foreignNote}
      </Typography>

      {/* ------------------------------------------------------------------ */}
      {/* Quiet hours.                                                        */}
      {/* ------------------------------------------------------------------ */}
      <SectionHeader title={QUIET_HOURS_COPY.heading} explanation={QUIET_HOURS_COPY.help} />

      <Card>
        {/* With the heading, not under the controls. See the module note. */}
        <View style={styles.exception}>
          <Typography role="body" colour="informational">
            {QUIET_HOURS_COPY.exception}
          </Typography>
        </View>

        <Typography role="bodyLarge">
          {view.quietHoursLabel === null ? QUIET_HOURS_COPY.notSet : view.quietHoursLabel}
        </Typography>

        {/* Said whether or not a window is set. The person who most needs it is the one about to
            set their first one; the view decides, so no surface can forget (see the module
            note). */}
        {view.limitationNote === null ? null : (
          <Typography role="caption" colour="secondary">
            {view.limitationNote}
          </Typography>
        )}

        {state !== null ? <ScreenState state={state} message={stateMessage} /> : null}
        {savedNote === null ? null : (
          <Typography role="body" colour="positive" announce>
            {savedNote}
          </Typography>
        )}

        {view.mayChangePolicy ? (
          view.quietHoursUnreadable ? (
            // The server reported a window whose numbers this build could not read. Offering an
            // editor prefilled with nothing would clear it the moment somebody pressed save, so
            // the controls are absent and the label above still shows what is set.
            <Typography role="caption" colour="secondary">
              {QUIET_HOURS_COPY.unreadableWindow}
            </Typography>
          ) : (
            <>
              <View style={styles.field}>
                <Typography role="label">{QUIET_HOURS_COPY.startLabel}</Typography>
                <Typography role="caption" colour="secondary">
                  {QUIET_HOURS_COPY.fieldHelp}
                </Typography>
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
                <Typography role="label">{QUIET_HOURS_COPY.endLabel}</Typography>
                <Typography role="caption" colour="secondary">
                  {QUIET_HOURS_COPY.fieldHelp}
                </Typography>
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

              {refusal === null ? null : (
                <Typography role="body" colour="attention" announce>
                  {refusal.message}
                </Typography>
              )}

              <Typography role="caption" colour="secondary">
                {QUIET_HOURS_COPY.stepUpPrompt}
              </Typography>

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
          <Typography role="caption" colour="secondary">
            {QUIET_HOURS_COPY.ownerOnly}
          </Typography>
        )}
      </Card>
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // The one sentence a person must read before relying on quiet hours, given its own weight.
    exception: {
      backgroundColor: theme.informational.background,
      borderColor: theme.informational.border,
      borderWidth: 1,
      borderRadius: RADIUS.md,
      padding: SPACING.md,
    },
    field: { gap: SPACING.xs },
    // A `TextInput` is not `Typography` and cannot be: the text style has to be on the input
    // itself. The size comes from the same role the label uses, resolved at 1x - React Native
    // scales the rendered text on top, as it does everywhere else.
    input: {
      ...typeStyle('body', 1),
      minHeight: MIN_TOUCH_TARGET_DP,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
      borderWidth: 1,
      borderRadius: RADIUS.md,
      borderColor: theme.surface.border,
      // A sunken well, like every other inset field in this app.
      backgroundColor: theme.sunken.background,
      color: theme.surface.foreground,
    },
    // `attention`, not `action`. A mistyped time is something to fix, not a recall.
    inputRefused: {
      borderColor: theme.attention.border,
      backgroundColor: theme.attention.background,
    },
  });
