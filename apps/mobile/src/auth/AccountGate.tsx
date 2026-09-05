/**
 * Turning a signed-in subject into an account, before anything asks for data (DEC-124, DEC-125).
 *
 * Spec references: `13` (a verified subject is not authority on its own), `16` (a person's account
 * is a record they can see and remove), `18` (a refusal says what to do next), `12`, DEC-118.
 *
 * WHY THIS IS A GATE AND NOT A BACKGROUND CALL
 * Since DEC-124 a verified subject with no `app_user` row reaches nothing: every route answers the
 * same `401` an unauthenticated request gets. `POST /v1/me` is one of exactly two routes exempt
 * from that, because it is the route that creates the row.
 *
 * So the ordering is not a preference. A screen that asked for a shelf while registration was in
 * flight would get a `401`, and the transport watches for exactly that and reports the session
 * lost - which would sign somebody out one second after they signed in, for a reason that no
 * longer applies by the time they read it. Registering **first**, with nothing else mounted
 * behind it, is what makes that race impossible rather than unlikely.
 *
 * WHY IT DOES NOTHING ON A DEVELOPMENT SESSION
 * There is no provider to read an address from, so `POST /v1/me` refuses - correctly, because an
 * `app_user` row carrying an email nobody confirmed is what DEC-118 asked registration to prevent.
 * Development accounts come from the seed. The gate is therefore scoped to a `BEARER` session and
 * passes everything else straight through.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  ACCOUNT_SETUP_COPY,
} from '@kynviora/presentation';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useApi } from '@/api/ApiProvider';
import { useAuth } from './AuthProvider';

type Progress =
  | { readonly kind: 'WORKING' }
  | { readonly kind: 'READY' }
  /** Something the person can act on: confirm an address, or sign in as somebody else. */
  | { readonly kind: 'REFUSED'; readonly message: string; readonly canRetry: boolean };

export function AccountGate({ children }: { readonly children: ReactNode }) {
  const { client, session } = useApi();
  const auth = useAuth();
  const [progress, setProgress] = useState<Progress>({ kind: 'WORKING' });
  const [attempt, setAttempt] = useState(0);

  const applies = session.kind === 'BEARER' && client !== null;

  useEffect(() => {
    if (!applies || client === null) return;
    let live = true;
    setProgress({ kind: 'WORKING' });

    void client
      .registerAccount()
      .then((outcome) => {
        if (!live) return;
        if (outcome.kind === 'OK') {
          setProgress({ kind: 'READY' });
          return;
        }
        if (outcome.kind === 'REFUSED' && outcome.code === 'EMAIL_NOT_VERIFIED') {
          setProgress({
            kind: 'REFUSED',
            message: ACCOUNT_SETUP_COPY.emailNotConfirmed,
            // Retrying is worth offering: the person may confirm the address in another app and
            // come back, and nothing about the session has to change for that to work.
            canRetry: true,
          });
          return;
        }
        if (outcome.kind === 'REFUSED' && outcome.code === 'ACCOUNT_CLOSED') {
          setProgress({ kind: 'REFUSED', message: ACCOUNT_SETUP_COPY.closed, canRetry: false });
          return;
        }
        setProgress({ kind: 'REFUSED', message: ACCOUNT_SETUP_COPY.unavailable, canRetry: true });
      })
      .catch(() => {
        // `DEV-055`'s rule. An uncaught rejection here is a crash banner over the first screen
        // somebody sees after signing in.
        if (live) {
          setProgress({ kind: 'REFUSED', message: ACCOUNT_SETUP_COPY.unavailable, canRetry: true });
        }
      });

    return () => {
      live = false;
    };
  }, [applies, client, attempt]);

  const retry = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  const signOut = useCallback(() => {
    void auth.signOut().catch(() => undefined);
  }, [auth]);

  if (!applies) return <>{children}</>;
  if (progress.kind === 'READY') return <>{children}</>;

  if (progress.kind === 'WORKING') {
    return (
      <View style={styles.centred}>
        <ActivityIndicator accessibilityLabel={ACCOUNT_SETUP_COPY.working} />
        <Text style={styles.body}>{ACCOUNT_SETUP_COPY.working}</Text>
      </View>
    );
  }

  return (
    <View style={styles.centred}>
      <Text accessibilityRole="header" style={styles.heading}>
        {ACCOUNT_SETUP_COPY.heading}
      </Text>
      <Text style={styles.body}>{progress.message}</Text>
      {progress.canRetry ? (
        <PrimaryButton label={ACCOUNT_SETUP_COPY.retryLabel} onPress={retry} />
      ) : null}
      {/* Always offered. Whatever went wrong, signing out is a thing the person can do about it,
          and a screen with no way off it is a screen somebody force-quits. */}
      <PrimaryButton
        label={ACCOUNT_SETUP_COPY.signOutLabel}
        variant="secondary"
        onPress={signOut}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
    padding: SPACING.lg,
    backgroundColor: LIGHT_THEME.surface.background,
  },
  heading: {
    fontSize: FONT_SIZE.title,
    fontWeight: '700',
    color: LIGHT_THEME.surface.foreground,
  },
  body: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surface.foreground,
    textAlign: 'center',
  },
});
