/**
 * What the app shows when nobody is signed in (DEC-118, DEC-124).
 *
 * Spec references: `13` (identity comes from an authenticated session), `12` (authorization loss
 * invalidates local access), `18` (a screen says which state it is in), `04` Phase 1.1, DEC-038.
 *
 * THREE STATES, AND THE FIRST ONE IS THE ONE THAT GETS FORGOTTEN
 * `LOADING` is not "signed out". The stored session is read from an encrypted database, which
 * means a keystore round trip - so a gate that treated "not yet known" as "not signed in" would
 * flash a sign-in screen past every returning person on every cold start, and some of them would
 * tap it.
 *
 * WHY IT DOES NOT GATE THE DEVELOPMENT PATH
 * When no provider is configured the app is in its development arrangement: identity is a header
 * from `EXPO_PUBLIC_DEV_USER_ID`, which the server refuses under `NODE_ENV=production` and which
 * has no session to be signed out of. Putting a sign-in screen in front of it would break every
 * device harness for a screen nothing could get past. `UNCONFIGURED` therefore renders the app,
 * and the *sign-out control* is what disappears - because there is nothing to sign out of.
 */

import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { LIGHT_THEME } from '@kynviora/presentation';
import { useAuth } from './AuthProvider';
import { SignInScreen } from '@/features/auth/SignInScreen';

export function AuthGate({ children }: { readonly children: ReactNode }) {
  const { state } = useAuth();

  if (state === 'LOADING') {
    return (
      <View style={styles.waiting}>
        {/* No words. Nothing has happened yet, and a sentence here would be read on every launch
            by somebody who is about to be signed in anyway. */}
        <ActivityIndicator accessibilityLabel="Opening Kynviora" />
      </View>
    );
  }

  if (state === 'SIGNED_OUT') return <SignInScreen />;

  // SIGNED_IN, and UNCONFIGURED - see the note above on why the latter is not gated.
  return <>{children}</>;
}

const styles = StyleSheet.create({
  waiting: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LIGHT_THEME.surface.background,
  },
});
