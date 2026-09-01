/**
 * Inviting someone to help.
 *
 * Spec references: `04` Phase 8.1, `14` (caregiver administration needs re-authentication; an
 * address is personal data), `16` (a caregiver gets exactly what they were granted), `18` (say
 * what a screen will do before it does it), DEC-018, DEC-020, trap 11.
 *
 * THREE STEPS, AND THE ORDER MATTERS
 * Choose, confirm, then the link. Choosing and confirming are separate because `18` requires a
 * screen to state what it is about to do before doing it, and handing out a bearer credential is
 * the most consequential thing this app can do. The link comes last because it does not exist
 * until the request succeeds - the server mints it, stores only a SHA-256 hash, and never emits it
 * again (DEC-018).
 *
 * WHAT HAPPENS TO THE TOKEN HERE
 * It is held in component state, rendered, and dropped when the screen closes. It is never
 * written to storage, never logged, never put in a URL, never included in an error, and never
 * passed to any function other than the `Text` that displays it. `14` and trap 11 are about a live
 * credential, and the way to keep one out of a log is for no code between the response and the
 * screen to touch it.
 *
 * The capabilities offered are only ever the ones this inviter may delegate. A caregiver is not
 * shown a disabled "manage caregivers" box: DEC-020 forbids them delegating it, and a greyed-out
 * control would tell them the capability exists and that they are not trusted with it.
 */

import { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  CAREGIVER_COPY,
  describeCapability,
  invitationExpiryNote,
  summarizeAccess,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import type { CaregiverCapability } from '@kynviora/domain';
import {
  buildInvitation,
  selectableCapabilities,
  type InvitationCreated,
  type InviterAuthority,
} from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ScreenState } from '@/components/ScreenState';

export interface InviteCaregiverProps {
  readonly profileId: string;
  readonly authority: InviterAuthority;
  readonly invitationTtlDays: number;
  /** Performed with an elevated client. The caller owns the step-up, not this component. */
  readonly onSend: (body: {
    readonly profileId: string;
    readonly capabilities: readonly CaregiverCapability[];
    readonly invitedEmail?: string;
  }) => void;
  readonly onClose: () => void;
  /** Set once the request has succeeded. The only place the token is ever held. */
  readonly created?: InvitationCreated | null;
  readonly state?: ScreenStateKind | null;
  readonly stateMessage?: string | null;
}

export function InviteCaregiver({
  profileId,
  authority,
  invitationTtlDays,
  onSend,
  onClose,
  created,
  state,
  stateMessage,
}: InviteCaregiverProps) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [email, setEmail] = useState('');
  const [confirming, setConfirming] = useState(false);

  const offerable = useMemo(() => selectableCapabilities(authority), [authority]);
  const draft = useMemo(
    () => buildInvitation({ profileId, authority, selected, invitedEmail: email }),
    [profileId, authority, selected, email],
  );

  // The link exists. Nothing else on this screen matters until it has been read.
  if (created != null) return <InvitationLink created={created} onClose={onClose} />;

  if (state != null && state !== 'READY') {
    return <ScreenState state={state} message={stateMessage} />;
  }

  if (confirming) {
    const summary = summarizeAccess(draft.body?.capabilities ?? []);
    return (
      <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.heading}>
          {CAREGIVER_COPY.reviewHeading}
        </Text>
        {/* Exactly what is being shared, in the words the access list uses, so the review and the
            list afterwards cannot describe the same grant differently. */}
        {summary.viewing.length > 0 ? (
          <Text style={styles.label}>They will be able to see</Text>
        ) : null}
        {summary.viewing.map((line) => (
          <Text key={line} style={styles.body}>
            {line}
          </Text>
        ))}

        {summary.changing.length > 0 ? (
          <Text style={styles.label}>They will be able to change</Text>
        ) : null}
        {summary.changing.map((line) => (
          <Text key={line} style={styles.body}>
            {line}
          </Text>
        ))}

        {summary.administrationWarning === null ? null : (
          <Text style={styles.warning}>{summary.administrationWarning}</Text>
        )}

        {/* `18` requires the limitation to be stated. Someone reading only what was granted will
            not notice what was withheld, and naming the omissions is what makes a grant legible. */}
        {summary.notIncluded.length > 0 ? (
          <>
            <Text style={styles.label}>Not included</Text>
            <Text style={styles.help}>{summary.notIncluded.join(', ')}</Text>
          </>
        ) : null}
        {draft.body?.invitedEmail === undefined ? (
          <Text style={styles.warning}>{CAREGIVER_COPY.linkWarning}</Text>
        ) : null}
        <Text style={styles.body}>{invitationExpiryNote(invitationTtlDays)}</Text>

        {/* `14`: caregiver administration needs re-authentication. The confirmation is the step,
            and the caller performs it - this component never holds an elevated client. */}
        <Text style={styles.body}>{CAREGIVER_COPY.stepUpPrompt}</Text>

        <PrimaryButton
          label="Confirm and create the link"
          onPress={() => {
            if (draft.body !== null) onSend(draft.body);
          }}
        />
        <PrimaryButton
          label="Back"
          variant="secondary"
          onPress={() => {
            setConfirming(false);
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        Invite someone
      </Text>
      <Text style={styles.body}>{CAREGIVER_COPY.inviteIntro}</Text>

      {offerable.map((capability) => {
        const description = describeCapability(capability);
        const chosen = selected.includes(capability);
        return (
          <Pressable
            key={capability}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: chosen }}
            accessibilityLabel={description.label}
            accessibilityHint={description.meaning}
            onPress={() => {
              setSelected((current) =>
                chosen ? current.filter((c) => c !== capability) : [...current, capability],
              );
            }}
            style={[
              styles.capability,
              {
                backgroundColor: chosen
                  ? LIGHT_THEME.informational.background
                  : LIGHT_THEME.surface.background,
                borderColor: chosen ? LIGHT_THEME.informational.border : LIGHT_THEME.surface.border,
              },
            ]}
          >
            {/* The tick duplicates the accessibilityState. `18`: never colour alone. */}
            <Text style={styles.capabilityLabel}>
              {chosen ? '☑  ' : '☐  '}
              {description.label}
            </Text>
            <Text style={styles.help}>{description.meaning}</Text>
          </Pressable>
        );
      })}

      <Text style={styles.label}>Their email address, if you have it</Text>
      <Text style={styles.help}>
        Adding it means only that address can accept. Leave it blank to send a link anyone holding
        it can use.
      </Text>
      <TextInput
        accessibilityLabel="Their email address, if you have it"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        style={styles.input}
      />

      {draft.ok ? null : selected.length === 0 && email.trim() === '' ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.warning}>
          {draft.refusal?.message}
        </Text>
      )}

      <PrimaryButton
        label="Review what you are sharing"
        disabled={!draft.ok}
        onPress={() => {
          setConfirming(true);
        }}
      />
      <PrimaryButton label="Cancel" variant="secondary" onPress={onClose} />
    </View>
  );
}

/**
 * The link, shown once.
 *
 * There is no "copy again later" and there cannot be: the server stored a hash and has nothing to
 * re-issue (DEC-018). The sentence saying so is on screen before the value, not after it, because
 * someone who has already navigated away has not read it.
 */
function InvitationLink({
  created,
  onClose,
}: {
  readonly created: InvitationCreated;
  readonly onClose: () => void;
}) {
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        Send this link
      </Text>
      <Text style={styles.warning}>{CAREGIVER_COPY.linkShownOnce}</Text>
      <Text style={styles.warning}>{CAREGIVER_COPY.linkWarning}</Text>

      {/* Selectable so it can be copied by hand. Not passed to a share sheet, a clipboard helper
          or anything else that could put a live credential somewhere this screen cannot see. */}
      <Text selectable style={styles.token} accessibilityLabel="Invitation link">
        {created.token}
      </Text>

      <PrimaryButton label="I have sent it" onPress={onClose} />
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
  capability: {
    minHeight: MIN_TOUCH_TARGET_DP,
    gap: SPACING.xxs,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  capabilityLabel: {
    fontSize: FONT_SIZE.body,
    fontWeight: '600',
    color: LIGHT_THEME.surface.foreground,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET_DP,
    borderWidth: 1,
    borderRadius: SPACING.sm,
    borderColor: LIGHT_THEME.surface.border,
    paddingHorizontal: SPACING.md,
    fontSize: FONT_SIZE.body,
    color: LIGHT_THEME.surface.foreground,
  },
  token: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
    backgroundColor: LIGHT_THEME.surfaceMuted.background,
    borderWidth: 1,
    borderColor: LIGHT_THEME.surfaceMuted.border,
    borderRadius: SPACING.sm,
    padding: SPACING.md,
  },
});
