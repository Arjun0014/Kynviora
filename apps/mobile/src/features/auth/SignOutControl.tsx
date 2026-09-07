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
import { SIGN_OUT_COPY } from '@kynviora/presentation';
import { Card } from '@/components/Card';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Typography } from '@/components/Typography';
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
    <Card>
      {/* Above the control, never under it. It is the sentence that says signing out here signs
          out everywhere and removes the copy of the shelf kept on this phone - which is the part
          that would otherwise be a surprise (`12`). */}
      <Typography role="body" colour="secondary">
        {SIGN_OUT_COPY.hint}
      </Typography>
      <PrimaryButton
        label={busy ? SIGN_OUT_COPY.working : SIGN_OUT_COPY.label}
        onPress={press}
        accessibilityHint={SIGN_OUT_COPY.hint}
        variant="secondary"
        disabled={busy}
      />
    </Card>
  );
}
