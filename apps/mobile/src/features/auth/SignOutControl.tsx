/**
 * Signing out, from the one screen a person would look for it on.
 *
 * Spec references: `12` ("Sign-out removes decrypted projections and caches"; authorization loss
 * invalidates local access), `14` (session data in the encrypted store), `18` (say what a control
 * will do before it does it), DEC-118.
 *
 * WHAT IT SAYS BEFORE IT DOES IT
 * Two things, and both are consequences somebody would want to know: it signs them out
 * **everywhere**, not only here, and it removes the copy of their medicines kept on this phone.
 * The second is `12`'s rule and is the one that would otherwise be a surprise - somebody
 * expecting to sign out and still see their shelf offline.
 *
 * WHY IT IS ABSENT RATHER THAN DISABLED WHERE THERE IS NO PROVIDER
 * A development build has no session to end, and a disabled "Sign out" is a control that tells
 * somebody a thing exists and then refuses it. DEC-045's rule: absent, not disabled.
 */

import { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  SIGN_OUT_COPY,
} from '@kynviora/presentation';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useAuth } from '@/auth/AuthProvider';

export function SignOutControl() {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);

  const press = useCallback(() => {
    if (busy) return;
    setBusy(true);
    // Caught rather than propagated (`DEV-055`): signing out locally has already happened by the
    // time the provider is asked, so a rejection here would put a crash banner over an app that
    // is already signed out.
    void auth
      .signOut()
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
      });
  }, [auth, busy]);

  if (auth.state !== 'SIGNED_IN') return null;

  return (
    <View style={styles.block}>
      <Text style={styles.hint}>{SIGN_OUT_COPY.hint}</Text>
      <PrimaryButton
        label={busy ? SIGN_OUT_COPY.working : SIGN_OUT_COPY.label}
        onPress={press}
        accessibilityHint={SIGN_OUT_COPY.hint}
        variant="secondary"
        disabled={busy}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: SPACING.sm, marginTop: SPACING.lg },
  hint: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
