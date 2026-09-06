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
 */

import { View, Text, StyleSheet } from 'react-native';
import {
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  CAREGIVER_COPY,
  REVOCATION_COPY,
  describeRevocation,
  summarizeAccess,
  type ScreenState as ScreenStateKind,
  type Theme,
} from '@kynviora/presentation';
import type { RevocationTarget } from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';
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
      <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.heading}>
          {CAREGIVER_COPY.revokeDone}
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {removed.alreadyRemoved ? REVOCATION_COPY.nothingToRemove : words.immediate}
        </Text>
        <PrimaryButton label={REVOCATION_COPY.doneLabel} onPress={onCancel} />
      </View>
    );
  }

  if (state != null && state !== 'READY') {
    // Every failure renders as a state, including step-up. The one message shown is the server's
    // own, which `errors.ts` has already made client-safe - never a reason invented here.
    return (
      <View style={styles.container}>
        <ScreenState state={state} message={stateMessage} />
        <PrimaryButton label={REVOCATION_COPY.cancelLabel} variant="secondary" onPress={onCancel} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        {words.heading}
      </Text>
      <Text style={styles.name}>{target.displayName}</Text>

      {/* What stops, in the same words the access list and the invitation review used. Three
          screens describing one grant three ways is how a person ends up unsure what they
          approved. */}
      {summary.viewing.length > 0 ? (
        <>
          <Text style={styles.label}>{words.seeingHeading}</Text>
          {summary.viewing.map((line) => (
            <Text key={line} style={styles.body}>
              {line}
            </Text>
          ))}
        </>
      ) : null}

      {summary.changing.length > 0 ? (
        <>
          <Text style={styles.label}>{words.changingHeading}</Text>
          {summary.changing.map((line) => (
            <Text key={line} style={styles.body}>
              {line}
            </Text>
          ))}
        </>
      ) : null}

      {/* When it happens. `15` A2 is the behaviour and this is the sentence that matches it. */}
      <Text style={styles.body}>{words.immediate}</Text>

      {words.consequences.map((line) => (
        <Text key={line} style={styles.body}>
          {line}
        </Text>
      ))}

      {/* `14`: caregiver administration needs re-authentication. The confirmation is the step,
          and the caller performs it - this component never holds an elevated client. */}
      <Text style={styles.body}>{CAREGIVER_COPY.stepUpPrompt}</Text>

      <PrimaryButton
        label={words.confirmLabel}
        accessibilityHint={words.immediate}
        onPress={() => {
          onConfirm(target);
        }}
      />
      <PrimaryButton label={REVOCATION_COPY.cancelLabel} variant="secondary" onPress={onCancel} />
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
    name: {
      fontSize: FONT_SIZE.body,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    label: {
      fontSize: FONT_SIZE.body,
      fontWeight: '600',
      color: theme.surface.foreground,
    },
    body: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.normal,
      color: theme.surface.foreground,
    },
  });
