/**
 * Signing in, creating an account, and asking for a new password - one screen, three states.
 *
 * Spec references: `18` (48dp targets, a label always present, one primary action per screen, a
 * refusal that says what to do next, meaning never carried by colour alone), `16` (say why a
 * field is asked for), `13` (branch on codes, never on message text), `19`, DEC-118, DEC-125.
 *
 * WHY ONE SCREEN RATHER THAN THREE ROUTES
 * Because it is one task with three shapes, and a person who has just been told their password is
 * wrong is one tap from the third of them. Three routes would put a navigation transition between
 * "that did not work" and "then send me a link", which is the moment somebody gives up.
 *
 * It also keeps the whole of the signed-out surface in one file that can be read at once - which
 * matters more here than anywhere else in the app, because everything on it is reachable by
 * somebody who is not signed in.
 *
 * WHAT IT COMPOSES AND WHAT IT DECIDES
 * Every word comes from `@kynviora/presentation` and every refusal is `authRefusal(reason)`;
 * `apps/**` is outside the test run, so a sentence written here is one nothing scans. What the
 * screen decides is which state it is in and which control is primary - and the one design rule
 * it enforces by construction is that the button says what it will do rather than "Submit".
 */

import { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  MIN_TOUCH_TARGET_DP,
  AUTH_REFUSAL_HEADING,
  AUTH_UNCONFIGURED_COPY,
  RECOVERY_COPY,
  SIGN_IN_COPY,
  SIGN_UP_COPY,
  authRefusal,
  type AuthRefusal,
} from '@kynviora/presentation';
import { Screen } from '@/components/Screen';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useAuth } from '@/auth/AuthProvider';

type Mode = 'SIGN_IN' | 'SIGN_UP' | 'RECOVER';
type Done = 'CONFIRM_EMAIL' | 'RECOVERY_SENT';

export function SignInScreen() {
  const auth = useAuth();
  const [mode, setMode] = useState<Mode>('SIGN_IN');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<AuthRefusal | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  /** Switching mode clears the refusal, because it was about the previous question. */
  const go = useCallback((next: Mode) => {
    setMode(next);
    setRefusal(null);
    setDone(null);
  }, []);

  const wantsPassword = mode !== 'RECOVER';
  const incomplete = email.trim() === '' || (wantsPassword && password === '');

  const submit = useCallback(() => {
    // Guarded here as well as disabled on the control. The disabled state is what a person sees;
    // this is what makes a press that lands anyway - a screen reader activating a control, a
    // double tap racing a re-render - do nothing rather than ask the provider about a blank form.
    if (busy || incomplete) return;
    setBusy(true);
    setRefusal(null);

    const attempt = async (): Promise<void> => {
      if (mode === 'RECOVER') {
        const outcome = await auth.recover(email);
        if (outcome.kind === 'OK') setDone('RECOVERY_SENT');
        else setRefusal(authRefusal(outcome.reason));
        return;
      }
      if (mode === 'SIGN_UP') {
        const outcome = await auth.signUp(email, password);
        if (outcome.kind !== 'OK') {
          setRefusal(authRefusal(outcome.reason));
          return;
        }
        // A project that requires confirmation returns no session, and that is the end of the
        // flow rather than a failure: the next step is a mailbox. Rendering it as an error would
        // send somebody to try again at an account they have just made.
        if (outcome.value.state === 'CONFIRMATION_REQUIRED') setDone('CONFIRM_EMAIL');
        return;
      }
      const outcome = await auth.signIn(email, password);
      if (outcome.kind !== 'OK') setRefusal(authRefusal(outcome.reason));
      // Nothing on success: the tree above swaps this screen for the app.
    };

    // `DEV-055`'s rule: every rejection is caught, because an uncaught one on this screen is a
    // crash banner over the only way into the app.
    void attempt()
      .catch(() => {
        setRefusal(authRefusal('UNAVAILABLE'));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [auth, busy, email, incomplete, mode, password]);

  if (auth.state === 'UNCONFIGURED') {
    return (
      <Screen title={AUTH_UNCONFIGURED_COPY.heading}>
        <Text style={styles.body}>{AUTH_UNCONFIGURED_COPY.body}</Text>
      </Screen>
    );
  }

  if (done === 'CONFIRM_EMAIL') {
    return (
      <Screen title={SIGN_UP_COPY.confirmationHeading}>
        <Text style={styles.body}>{SIGN_UP_COPY.confirmationBody}</Text>
        <Text style={styles.help}>{SIGN_UP_COPY.confirmationNote}</Text>
        <PrimaryButton label={SIGN_UP_COPY.signInLabel} onPress={() => go('SIGN_IN')} />
      </Screen>
    );
  }

  if (done === 'RECOVERY_SENT') {
    return (
      <Screen title={RECOVERY_COPY.sentHeading}>
        <Text style={styles.body}>{RECOVERY_COPY.sentBody}</Text>
        <PrimaryButton label={RECOVERY_COPY.signInLabel} onPress={() => go('SIGN_IN')} />
      </Screen>
    );
  }

  const copy =
    mode === 'SIGN_IN' ? SIGN_IN_COPY : mode === 'SIGN_UP' ? SIGN_UP_COPY : RECOVERY_COPY;

  return (
    <Screen title={copy.heading} intro={copy.intro}>
      <View style={styles.field}>
        <Text nativeID="auth-email-label" style={styles.label}>
          {copy.emailLabel}
        </Text>
        {mode === 'SIGN_UP' ? <Text style={styles.help}>{SIGN_UP_COPY.emailHelp}</Text> : null}
        <TextInput
          accessibilityLabelledBy="auth-email-label"
          accessibilityLabel={copy.emailLabel}
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          editable={!busy}
        />
      </View>

      {wantsPassword ? (
        <View style={styles.field}>
          <Text nativeID="auth-password-label" style={styles.label}>
            {mode === 'SIGN_UP' ? SIGN_UP_COPY.passwordLabel : SIGN_IN_COPY.passwordLabel}
          </Text>
          {mode === 'SIGN_UP' ? <Text style={styles.help}>{SIGN_UP_COPY.passwordHelp}</Text> : null}
          <TextInput
            accessibilityLabelledBy="auth-password-label"
            accessibilityLabel={
              mode === 'SIGN_UP' ? SIGN_UP_COPY.passwordLabel : SIGN_IN_COPY.passwordLabel
            }
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType={mode === 'SIGN_UP' ? 'newPassword' : 'password'}
            editable={!busy}
          />
        </View>
      ) : null}

      {refusal === null ? null : (
        <View accessibilityRole="alert" style={styles.refusal}>
          <Text style={styles.refusalHeading}>{AUTH_REFUSAL_HEADING}</Text>
          <Text style={styles.refusalText}>{refusal.message}</Text>
          {refusal.nextStep === undefined ? null : (
            <Text style={styles.refusalText}>{refusal.nextStep}</Text>
          )}
        </View>
      )}

      <PrimaryButton
        label={busy ? copy.working : copy.submitLabel}
        onPress={submit}
        disabled={busy || incomplete}
      />

      {/* The other two ways out, always both present. A person who cannot sign in needs the one
          they were not offered. */}
      {mode !== 'SIGN_IN' ? (
        <PrimaryButton
          label={SIGN_UP_COPY.signInLabel}
          variant="secondary"
          onPress={() => go('SIGN_IN')}
          disabled={busy}
        />
      ) : null}
      {mode !== 'SIGN_UP' ? (
        <PrimaryButton
          label={SIGN_IN_COPY.createLabel}
          variant="secondary"
          onPress={() => go('SIGN_UP')}
          disabled={busy}
        />
      ) : null}
      {mode !== 'RECOVER' ? (
        <PrimaryButton
          label={SIGN_IN_COPY.forgotLabel}
          variant="secondary"
          onPress={() => go('RECOVER')}
          disabled={busy}
        />
      ) : null}

      {mode === 'SIGN_IN' ? <Text style={styles.help}>{SIGN_IN_COPY.privacyNote}</Text> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: SPACING.lg },
  label: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
    marginBottom: SPACING.xs,
  },
  help: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
    marginBottom: SPACING.sm,
  },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
    marginBottom: SPACING.md,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET_DP,
    borderWidth: 1,
    borderColor: LIGHT_THEME.surface.border,
    borderRadius: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    fontSize: FONT_SIZE.body,
    color: LIGHT_THEME.surface.foreground,
    backgroundColor: LIGHT_THEME.surfaceMuted.background,
  },
  refusal: {
    borderWidth: 1,
    borderColor: LIGHT_THEME.attention.border,
    backgroundColor: LIGHT_THEME.attention.background,
    borderRadius: SPACING.xs,
    padding: SPACING.sm,
    marginBottom: SPACING.md,
  },
  refusalHeading: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    fontWeight: '600',
    color: LIGHT_THEME.attention.foreground,
    marginBottom: SPACING.xs,
  },
  refusalText: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.attention.foreground,
  },
});
