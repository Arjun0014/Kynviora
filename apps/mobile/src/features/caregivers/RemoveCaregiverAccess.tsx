/**
 * Removing someone's access.
 *
 * Spec references: `04` Phase 8.1, `14` (caregiver administration needs re-authentication),
 * `15` A2 (revocation takes effect on the next authenticated access), `12` (no client-side
 * authorization, no optimistic change to a grant), `18` (say what a screen will do before it does
 * it; confirm a destructive action), `03` group H.
 *
 * WHY THIS IS A SCREEN AND NOT A DIALOG WITH A YES BUTTON
 * The consequential fact is not "are you sure". It is *what stops*, *when*, and *what starting
 * again would take* - and the third one is the surprise: the invitation token was stored only as
 * a hash and cannot be reissued (DEC-018), so restoring access means sending a new invitation and
 * having it accepted. A two-button alert has nowhere to say that.
 *
 * IT NEVER APPLIES THE CHANGE ITSELF
 * There is no local state here meaning "removed", and this component does not touch the list.
 * `12` forbids the client holding authorization logic, and a row that disappears before the
 * server agreed is a false statement about who can read a person's health data - in the direction
 * that reassures. The caller performs the request with an elevated client and reloads.
 *
 * THE COPY IS NOT A WARNING
 * `15` wants removing access to be easy, and styling it as dangerous discourages exactly the
 * thing the threat model relies on. The one attention-toned line is the accepted-invitation
 * refusal, which is a real correction: the record on screen is not the record carrying the
 * access.
 *
 * WHY THE SUBJECT AND THE CONSEQUENCES ARE TWO CARDS (DEC-142)
 * They are two ideas and a card is one. The first says who this is about and what they can
 * currently do; the second says what happens when the control below is pressed. Run together in one
 * box - which is what this was - the person's name, the two capability lists, the timing sentence,
 * the consequences and the step-up prompt are eleven lines of the same weight, and the one that
 * surprises people (the token cannot be reissued, so restoring access means a new invitation) is
 * indistinguishable from the four around it.
 */

import { View, StyleSheet } from 'react-native';
import {
  RADIUS,
  SPACING,
  CAREGIVER_COPY,
  REVOCATION_COPY,
  describeRevocation,
  summarizeAccess,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import type { RevocationTarget } from '@kynviora/contracts';
import { Card } from '@/components/Card';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
import { Typography } from '@/components/Typography';
import { useThemedStyles } from '@/theme/ThemeProvider';

export interface RemoveCaregiverAccessProps {
  /** What is being removed. Built by `buildRevocation`, which chose the route. */
  readonly target: RevocationTarget;
  /** Performed with an elevated client. The caller owns the step-up, not this component. */
  readonly onConfirm: (target: RevocationTarget) => void;
  readonly onCancel: () => void;
  readonly state?: ScreenStateKind | null;
  readonly stateMessage?: string | null;
  /**
   * Set once the server has answered.
   *
   * Distinct from `state === 'READY'` because there is a second sentence to say: an access that
   * had already ended is a different fact from one this request ended, and reporting the second
   * for the first would credit the person with a change they did not make.
   */
  readonly removed?: { readonly alreadyRemoved: boolean } | null;
}

export function RemoveCaregiverAccess({
  target,
  onConfirm,
  onCancel,
  state,
  stateMessage,
  removed,
}: RemoveCaregiverAccessProps) {
  const styles = useThemedStyles(makeStyles);
  const words = describeRevocation({ subject: target.subject, isSelf: target.isSelf });
  const summary = summarizeAccess(target.capabilities);

  if (removed != null) {
    return (
      <Card>
        <Typography role="title" heading>
          {CAREGIVER_COPY.revokeDone}
        </Typography>
        <Typography role="bodyLarge" announce>
          {removed.alreadyRemoved ? REVOCATION_COPY.nothingToRemove : words.immediate}
        </Typography>
        <PrimaryButton label={REVOCATION_COPY.doneLabel} onPress={onCancel} />
      </Card>
    );
  }

  if (state != null && state !== 'READY') {
    // Every failure renders as a state, including step-up. The one message shown is the server's
    // own, which `errors.ts` has already made client-safe - never a reason invented here.
    return (
      <Card>
        <ScreenState state={state} message={stateMessage} />
        <PrimaryButton label={REVOCATION_COPY.cancelLabel} variant="secondary" onPress={onCancel} />
      </Card>
    );
  }

  return (
    <>
      {/* Who this is about, and what they can currently do. */}
      <Card>
        <Typography role="title" heading>
          {words.heading}
        </Typography>
        <Typography role="bodyLarge">{target.displayName}</Typography>

        {/* What stops, in the same words the access list and the invitation review used. Three
            screens describing one grant three ways is how a person ends up unsure what they
            approved. */}
        {summary.viewing.length === 0 ? null : (
          <View style={styles.block}>
            <Typography role="label" colour="secondary" heading>
              {words.seeingHeading}
            </Typography>
            {summary.viewing.map((line) => (
              <Typography key={line} role="body">
                {line}
              </Typography>
            ))}
          </View>
        )}

        {summary.changing.length === 0 ? null : (
          <View style={styles.block}>
            <Typography role="label" colour="secondary" heading>
              {words.changingHeading}
            </Typography>
            {summary.changing.map((line) => (
              <Typography key={line} role="body">
                {line}
              </Typography>
            ))}
          </View>
        )}
      </Card>

      {/* What pressing the control does. A second card, because it is a second idea - and because
          the sentence people are surprised by is in here rather than eleventh in a list. */}
      <Card>
        {/* When it happens. `15` A2 is the behaviour and this is the sentence that matches it. */}
        <Typography role="bodyLarge">{words.immediate}</Typography>

        {words.consequences.map((line) => (
          <Typography key={line} role="body" colour="secondary">
            {line}
          </Typography>
        ))}

        {/* `14`: caregiver administration needs re-authentication. The confirmation is the step,
            and the caller performs it - this component never holds an elevated client. */}
        <Typography role="body" colour="secondary">
          {CAREGIVER_COPY.stepUpPrompt}
        </Typography>
      </Card>

      <PrimaryButton
        label={words.confirmLabel}
        accessibilityHint={words.immediate}
        onPress={() => {
          onConfirm(target);
        }}
      />
      <PrimaryButton label={REVOCATION_COPY.cancelLabel} variant="secondary" onPress={onCancel} />
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // The same sunken well the access list draws its three capability blocks in, so a grant looks
    // like the same object wherever it is described.
    block: {
      gap: SPACING.xxs,
      padding: SPACING.md,
      borderRadius: RADIUS.md,
      backgroundColor: theme.sunken.background,
    },
  });
