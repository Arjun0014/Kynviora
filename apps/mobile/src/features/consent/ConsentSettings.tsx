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
import { View, StyleSheet } from 'react-native';
import {
  RADIUS,
  SPACING,
  CONSENT_COPY,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import {
  messageForFailure,
  screenStateForFailure,
  type ConsentRowView,
  type ConsentView,
} from '@kynviora/contracts';
import { Card } from '@/components/Card';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { SectionHeader } from '@/components/SectionHeader';
import { Typography } from '@/components/Typography';
import { useApi } from '@/api/ApiProvider';
import { useThemedStyles } from '@/theme/ThemeProvider';

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
  const styles = useThemedStyles(makeStyles);
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
    <>
      <SectionHeader title={CONSENT_COPY.heading} explanation={CONSENT_COPY.intro} />

      {state !== null ? <ScreenState state={state} message={message} /> : null}
      {saved !== null && state === null ? (
        <Typography role="caption" colour="secondary" announce>
          {saved}
        </Typography>
      ) : null}

      {view.rows.map((row) => (
        <Card key={row.purpose}>
          <Typography role="title" heading>
            {row.label}
          </Typography>

          {/* Which of the switches actually does something. Text, never colour alone (`18`). */}
          {row.statusLabel === null ? null : (
            <Typography role="label" colour="secondary">
              {row.statusLabel}
            </Typography>
          )}

          <Typography role="body">{row.description}</Typography>

          {/* Above the control. See the module note - this is the sentence that matters most on
              the notifications row, and it is never under the button. A purpose that enforces
              something gets the informational panel; one that enforces nothing today gets a
              caption, because the two sentences are different claims and must not look alike. */}
          {row.enforcesSomething ? (
            <View style={styles.limitation}>
              <Typography role="caption" colour="informational">
                {row.withdrawalEffect}
              </Typography>
            </View>
          ) : (
            <Typography role="caption" colour="secondary">
              {row.withdrawalEffect}
            </Typography>
          )}

          {row.notYetNote === null ? null : (
            <Typography role="caption" colour="secondary">
              {row.notYetNote}
            </Typography>
          )}
          {row.neverAnsweredNote === null ? null : (
            <Typography role="caption" colour="secondary">
              {row.neverAnsweredNote}
            </Typography>
          )}
          {row.staleNote === null ? null : (
            <Typography role="caption" colour="secondary">
              {row.staleNote}
            </Typography>
          )}

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
        </Card>
      ))}

      {/* Taking a copy. What it contains and what it leaves out are both said before the control,
          because `16` asks an export to show what will be included and a person checks a copy
          once. */}
      <Card>
        <Typography role="title" heading>
          {CONSENT_COPY.exportHeading}
        </Typography>
        <Typography role="body">{CONSENT_COPY.exportIntro}</Typography>
        <Typography role="caption" colour="secondary">
          {CONSENT_COPY.exportOmissionsNote}
        </Typography>

        {exportState != null && exportState !== 'READY' ? (
          <ScreenState state={exportState} message={exportMessage} />
        ) : null}

        {/* Said only where a section actually failed. A standing caveat would train somebody to
            skip the sentence on the run where it matters. */}
        {exportIncomplete === true ? (
          <Typography role="body" announce>
            {CONSENT_COPY.exportIncompleteNote}
          </Typography>
        ) : null}

        {exportReady === true && exportIncomplete !== true ? (
          <Typography role="body" announce>
            {CONSENT_COPY.exportReadyNote}
          </Typography>
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
      </Card>

      {/* No button, because there is still nothing behind one. See the module note. */}
      <Card>
        <Typography role="title" heading>
          {CONSENT_COPY.deletionHeading}
        </Typography>
        <Typography role="caption" colour="secondary">
          {CONSENT_COPY.deletionNote}
        </Typography>
      </Card>
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // The sentence somebody has to read before pressing. `informational` rather than `attention`:
    // withdrawing consent is a right being exercised, not a warning about a medicine, and styling
    // it as an alarm would be friction placed on one side of a choice (`02`).
    limitation: {
      backgroundColor: theme.informational.background,
      borderColor: theme.informational.border,
      borderWidth: 1,
      borderRadius: RADIUS.md,
      padding: SPACING.md,
    },
  });
