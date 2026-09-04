/**
 * What somebody has agreed to, and changing their mind.
 *
 * Spec references: `04` Phase 1.4 (versioned consent receipts; separate consent categories;
 * withdrawal flows; export/deletion shell - with the exit criteria "revoking optional consent
 * disables the associated behavior" and "consent state is auditable and localizable"), `16`
 * (consent, data minimisation), `10` (state the limits where you state the findings), `18`
 * (48dp targets, one idea per sentence, say what a control will do before it does it), `02`,
 * `13`, `14`.
 *
 * THIS SCREEN COMPOSES NOTHING
 * Every sentence arrives from `@kynviora/presentation` by way of `consentView`, and so does every
 * decision about which control to offer - `statusLabel` and `actionLabel` are computed in
 * `@kynviora/contracts` rather than picked here. `apps/**` is outside the test run (`BLK-002`),
 * so a choice made in this file is a choice nothing ever checks, and the wrong one is a person
 * believing they turned something off.
 *
 * THE SENTENCE IS ABOVE THE CONTROL, NOT UNDER IT
 * Withdrawing notifications stops every notification, a critical safety alert included - quiet
 * hours let one through (DEC-078) and consent does not, because consent is the basis on which
 * Kynviora may contact somebody at all. That has to be readable before the button is pressed, and
 * it is also the button's accessibility hint so it is not sight-only. The same rule DEC-084 keeps
 * for archiving an item, which turns the safety watch off.
 *
 * THERE IS NO CONFIRMATION STEP, ON PURPOSE
 * Exercising a right is not a destructive action to be discouraged. `16` and `02` both point the
 * same way: friction placed on withdrawal, and not on granting, is a design that has taken a side.
 * The consequence is stated beforehand; that is the whole of what `18` asks for here.
 *
 * NOTHING IS APPLIED LOCALLY FIRST
 * A row never shows the new answer before the server has recorded it. The write is re-read, so
 * what the screen says is what `consent_receipt` holds - and a screen that showed a withdrawal
 * the server refused would be the one failure this whole phase exists to prevent.
 *
 * THE EXPORT ROW OPENS SOMETHING; THE DELETION ROW STILL DOES NOT
 * `04` Phase 1.4 asks for both, and a settings row that opens nothing tells somebody a control
 * exists - which is why neither was here until the thing behind it was (`DEV-036`). Taking a copy
 * is built, so it has a control. Removing a whole account is not, so it has a sentence, and the
 * sentence points at the item screen for the deletion that *is* built rather than saying "not
 * built yet" over both.
 */

import { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  CONSENT_COPY,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import {
  messageForFailure,
  screenStateForFailure,
  type ConsentRowView,
  type ConsentView,
} from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { useApi } from '@/api/ApiProvider';

export interface ConsentSettingsProps {
  readonly view: ConsentView;
  /** Called once the server has written a receipt, so the list re-reads rather than guessing. */
  readonly onChanged: () => void;
  /**
   * Take a copy.
   *
   * Owned by the caller, for the reason every step-up action in this app is: the elevated client
   * is built at the moment of the request and discarded, so the privileged session never outlives
   * the action, and this component never holds one. Absent where no copy can be taken, in which
   * case the control is withheld rather than drawn and refused (DEC-045).
   */
  readonly onExport?: () => void;
  readonly exportState?: ScreenStateKind | null;
  readonly exportMessage?: string | null;
  readonly exportReady?: boolean;
  /**
   * Whether a section of the copy could not be assembled.
   *
   * Separate from `exportReady` because a file that arrived and a file that is complete are
   * different facts, and this is the one where saying nothing is the failure: a missing section
   * looks exactly like a section that was empty.
   */
  readonly exportIncomplete?: boolean;
}

export function ConsentSettings({
  view,
  onChanged,
  onExport,
  exportState,
  exportMessage,
  exportReady,
  exportIncomplete,
}: ConsentSettingsProps) {
  const { client } = useApi();

  const [state, setState] = useState<ScreenStateKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Which row is being written, so only that row's control is disabled. */
  const [pending, setPending] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const onDecide = useCallback(
    (row: ConsentRowView) => {
      if (client === null || pending !== null) return;

      setState('LOADING');
      setMessage(null);
      setSaved(null);
      setPending(row.purpose);

      // No `policyVersion` and no `recordedAt`. There is no field for either, which is the point:
      // a client that could name the policy version it agreed to could record agreement to a text
      // nobody showed them.
      void client.recordConsent({ purpose: row.purpose, granted: !row.granted }).then(
        (outcome) => {
          setPending(null);
          if (outcome.kind === 'OK') {
            setState(null);
            setSaved(CONSENT_COPY.savedNote);
            // Re-read rather than patched. What is in force is the server's answer (`13`).
            onChanged();
            return;
          }
          setState(screenStateForFailure(outcome));
          setMessage(messageForFailure(outcome));
        },
        () => {
          setPending(null);
          setState('RECOVERABLE_ERROR');
          setMessage(null);
        },
      );
    },
    [client, pending, onChanged],
  );

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {CONSENT_COPY.heading}
      </Text>
      <Text style={styles.body}>{CONSENT_COPY.intro}</Text>

      {state !== null ? <ScreenState state={state} message={message} /> : null}
      {saved !== null && state === null ? <Text style={styles.help}>{saved}</Text> : null}

      {view.rows.map((row) => (
        <View key={row.purpose} style={styles.row}>
          <Text accessibilityRole="header" style={styles.rowLabel}>
            {row.label}
          </Text>

          {/* The chip that tells the two switches that do something from the five that do not.
              Text, never colour alone (`18`). */}
          {row.statusLabel === null ? null : (
            <Text style={styles.statusLabel}>{row.statusLabel}</Text>
          )}

          <Text style={styles.body}>{row.description}</Text>

          {/* Above the control. See the module note - this is the sentence that matters most on
              the notifications row, and it is never under the button. */}
          <Text style={row.enforcesSomething ? styles.limitation : styles.help}>
            {row.withdrawalEffect}
          </Text>

          {row.notYetNote === null ? null : <Text style={styles.help}>{row.notYetNote}</Text>}
          {row.neverAnsweredNote === null ? null : (
            <Text style={styles.help}>{row.neverAnsweredNote}</Text>
          )}
          {row.staleNote === null ? null : <Text style={styles.help}>{row.staleNote}</Text>}

          {row.actionLabel === null ? null : (
            <PrimaryButton
              label={row.actionLabel}
              // The consequence again, for somebody who is not reading the screen (`18`).
              accessibilityHint={row.withdrawalEffect}
              variant={row.granted ? 'secondary' : 'primary'}
              disabled={pending !== null}
              onPress={() => {
                onDecide(row);
              }}
            />
          )}
        </View>
      ))}

      {/* Taking a copy. What it contains and what it leaves out are both said before the control,
          because `16` asks an export to show what will be included and a person checks a copy
          once. */}
      <View style={styles.block}>
        <Text accessibilityRole="header" style={styles.subheading}>
          {CONSENT_COPY.exportHeading}
        </Text>
        <Text style={styles.body}>{CONSENT_COPY.exportIntro}</Text>
        <Text style={styles.help}>{CONSENT_COPY.exportOmissionsNote}</Text>

        {exportState != null && exportState !== 'READY' ? (
          <ScreenState state={exportState} message={exportMessage} />
        ) : null}

        {/* Said only where a section actually failed. A standing caveat would train somebody to
            skip the sentence on the run where it matters. */}
        {exportIncomplete === true ? (
          <Text accessibilityLiveRegion="polite" style={styles.body}>
            {CONSENT_COPY.exportIncompleteNote}
          </Text>
        ) : null}

        {exportReady === true && exportIncomplete !== true ? (
          <Text accessibilityLiveRegion="polite" style={styles.body}>
            {CONSENT_COPY.exportReadyNote}
          </Text>
        ) : null}

        {onExport === undefined ? null : (
          <PrimaryButton
            label={CONSENT_COPY.exportLabel}
            accessibilityHint={CONSENT_COPY.exportHint}
            variant="secondary"
            disabled={exportState === 'LOADING'}
            onPress={onExport}
          />
        )}
      </View>

      {/* No button, because there is still nothing behind one. See the module note. */}
      <View style={styles.block}>
        <Text accessibilityRole="header" style={styles.subheading}>
          {CONSENT_COPY.deletionHeading}
        </Text>
        <Text style={styles.help}>{CONSENT_COPY.deletionNote}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: SPACING.md },
  heading: {
    fontSize: FONT_SIZE.title,
    fontWeight: '700',
    color: LIGHT_THEME.surface.foreground,
  },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
  },
  help: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  // The sentence somebody has to read before pressing. `informational` rather than `attention`:
  // withdrawing consent is a right being exercised, not a warning about a medicine, and styling
  // it as an alarm would be friction placed on one side of a choice (`02`).
  limitation: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.informational.foreground,
    backgroundColor: LIGHT_THEME.informational.background,
    borderColor: LIGHT_THEME.informational.border,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    padding: SPACING.sm,
  },
  row: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  // The two sections below the purposes. Same surface as a consent row, because they are the same
  // kind of thing to the person reading them: something they may do with their own record.
  block: {
    gap: SPACING.sm,
    padding: SPACING.md,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  subheading: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  rowLabel: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  statusLabel: {
    fontSize: FONT_SIZE.caption,
    fontWeight: '600',
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
