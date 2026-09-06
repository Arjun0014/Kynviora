/**
 * Closing an account, from the one screen a person would look for it on (`DEV-062`).
 *
 * Spec references: `16` (a person may have their data removed; the workflow enumerates what goes,
 * and the record *that* a deletion happened is retained), `14` (re-authentication for high-impact
 * actions), `12` (authorization loss invalidates local access), `18` (say what a control will do
 * before it does it; a refusal says what to do next), `13` (branch on codes, never on message
 * text), DEC-117, DEC-125.
 *
 * THE SHAPE, AND WHY IT IS NOT A DIALOG
 * Closed, it is one control. Opened, it is a list of what goes, a sentence about what is kept, and
 * a password field - on one screen, in that order. A confirmation dialog would ask "are you sure"
 * about a decision the person has not been given the facts for; `18` wants the consequence before
 * the control, and the consequence here is a list rather than a sentence.
 *
 * The password is on the same screen rather than behind a second step, because `14` requires
 * re-authentication and the honest framing is that the action and the proof arrive together. It is
 * also what stops a borrowed phone from closing somebody's account.
 *
 * WHY THE ADDRESS COMES FROM THE SERVER
 * Re-authenticating means signing in again, which needs the address. A **restored** session knows
 * its tokens and not the address behind them - deliberately, because an address on disk is one
 * more personal identifier at rest. So it is read from `GET /v1/me`: the server's own answer over
 * an authenticated request, fetched only when this screen is opened.
 *
 * WHAT EACH REFUSAL MEANS, AND WHY THEY ARE NOT ONE SENTENCE
 * `13` has clients branch on codes. Three outcomes look alike on the wire and mean opposite
 * things to the person reading them:
 *
 *   | Code                          | What is true                                    |
 *   | ----------------------------- | ----------------------------------------------- |
 *   | `PROVIDER_UNAVAILABLE`        | nothing was changed; this build cannot do it    |
 *   | `ACCOUNT_DELETION_INCOMPLETE` | the data **is gone**; press it again to finish  |
 *   | `STEP_UP_REQUIRED`            | the re-authentication did not take              |
 *
 * Reading the first sentence over the second state would tell somebody their medicines were still
 * there when they were not, which is why the code exists at all.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import {
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  DELETE_ACCOUNT_COPY,
  type Theme,
} from '@kynviora/presentation';
import { bearerSession } from '@kynviora/contracts';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useApi } from '@/api/ApiProvider';
import { useAuth } from '@/auth/AuthProvider';
import { useThemedStyles } from '@/theme/ThemeProvider';

type Stage =
  | { readonly kind: 'CLOSED' }
  | { readonly kind: 'ASKING' }
  | { readonly kind: 'WORKING' }
  | { readonly kind: 'REFUSED'; readonly message: string }
  | { readonly kind: 'DONE' };

export function DeleteAccount() {
  const styles = useThemedStyles(makeStyles);
  const { client, session } = useApi();
  const auth = useAuth();
  const [stage, setStage] = useState<Stage>({ kind: 'CLOSED' });
  const [password, setPassword] = useState('');
  /** The address this account has, as the server holds it. Never read from the device. */
  const [email, setEmail] = useState<string | null>(null);

  const open = stage.kind !== 'CLOSED' && stage.kind !== 'DONE';

  useEffect(() => {
    if (!open || client === null || email !== null) return;
    let live = true;
    void client
      .readAccount()
      .then((outcome) => {
        if (live && outcome.kind === 'OK') setEmail(outcome.value.account.email);
      })
      // `DEV-055`: an uncaught rejection here is a crash banner over a settings screen. The
      // address staying `null` is handled below, as its own refusal.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, client, email]);

  const submit = useCallback(() => {
    if (client === null || stage.kind === 'WORKING') return;
    setStage({ kind: 'WORKING' });

    void (async () => {
      // 1. Re-authenticate. `14` asks for it, and a new token is what a step-up **is** on this
      //    provider - the server reads freshness from the token's own `amr` (DEC-118 part 3), so
      //    there is no assertion a client could make instead.
      const proved = await auth.reauthenticate(password, email ?? undefined);
      if (proved.kind !== 'OK') {
        setStage({
          kind: 'REFUSED',
          message:
            proved.reason === 'WRONG_CREDENTIALS'
              ? DELETE_ACCOUNT_COPY.wrongPassword
              : DELETE_ACCOUNT_COPY.offline,
        });
        return;
      }

      // 2. And only then the deletion, on the client the new session produced.
      //
      //    **Built from the tokens `reauthenticate` returned, not read off the context.** `client`
      //    here is the one this callback closed over, and it carries the *pre*-re-authentication
      //    token: `ApiProvider` memoises the client on the access token, so the new one reaches
      //    this component on the next render, which is after this function has finished. Issuing
      //    the deletion on the closure's client sends the old token, the server reads step-up from
      //    its `amr` and finds it stale, and the refusal arrives as `STEP_UP_REQUIRED` - which
      //    this screen words as "that password was not right", about a password that was.
      //
      //    That is why `reauthenticate` returns the tokens rather than only reporting success: the
      //    proof and the thing it authorises are one step, and nothing has to wait for a render
      //    between them.
      const outcome = await client
        .withSession(bearerSession(proved.value.accessToken))
        .deleteAccount();
      if (outcome.kind === 'OK') {
        // Locally too. The session is already dead at the provider - the identity it belonged to
        // is gone - but `12` wants the decrypted copy on this phone gone with it, and that is
        // what `sessionLost` does without trying to revoke a session that no longer exists.
        setStage({ kind: 'DONE' });
        auth.sessionLost();
        return;
      }

      const code = outcome.kind === 'REFUSED' ? outcome.code : '';
      setStage({
        kind: 'REFUSED',
        message:
          code === 'ACCOUNT_DELETION_INCOMPLETE'
            ? DELETE_ACCOUNT_COPY.partial
            : code === 'PROVIDER_UNAVAILABLE'
              ? DELETE_ACCOUNT_COPY.unavailable
              : code === 'STEP_UP_REQUIRED'
                ? DELETE_ACCOUNT_COPY.wrongPassword
                : DELETE_ACCOUNT_COPY.offline,
      });
    })().catch(() => {
      setStage({ kind: 'REFUSED', message: DELETE_ACCOUNT_COPY.offline });
    });
  }, [auth, client, email, password, stage.kind]);

  const cancel = useCallback(() => {
    setPassword('');
    setStage({ kind: 'CLOSED' });
  }, []);

  // Absent, not disabled, where there is nothing to delete (DEC-045). A development session has no
  // provider behind it and the route would refuse; a control that always refuses is worse than no
  // control, because it tells somebody the thing exists.
  if (session.kind !== 'BEARER' || client === null) return null;

  if (stage.kind === 'DONE') {
    return (
      <View style={styles.block}>
        <Text accessibilityRole="header" style={styles.heading}>
          {DELETE_ACCOUNT_COPY.doneHeading}
        </Text>
        <Text style={styles.body}>{DELETE_ACCOUNT_COPY.doneBody}</Text>
      </View>
    );
  }

  if (stage.kind === 'CLOSED') {
    return (
      <View style={styles.block}>
        <PrimaryButton
          label={DELETE_ACCOUNT_COPY.openLabel}
          variant="secondary"
          onPress={() => {
            setStage({ kind: 'ASKING' });
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.block}>
      <Text accessibilityRole="header" style={styles.heading}>
        {DELETE_ACCOUNT_COPY.heading}
      </Text>
      <Text style={styles.body}>{DELETE_ACCOUNT_COPY.intro}</Text>

      {/* The consequence, before the control. A list rather than a sentence, because a sentence
          is skimmed and the point is that each of these is a separate thing somebody loses. */}
      {DELETE_ACCOUNT_COPY.removes.map((line) => (
        <Text key={line} style={styles.item}>
          {line}
        </Text>
      ))}

      <Text accessibilityRole="header" style={styles.subheading}>
        {DELETE_ACCOUNT_COPY.keptHeading}
      </Text>
      <Text style={styles.body}>{DELETE_ACCOUNT_COPY.keptBody}</Text>

      <Text style={styles.label}>{DELETE_ACCOUNT_COPY.passwordLabel}</Text>
      <Text style={styles.help}>{DELETE_ACCOUNT_COPY.passwordHelp}</Text>
      <TextInput
        accessibilityLabel={DELETE_ACCOUNT_COPY.passwordLabel}
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="current-password"
        textContentType="password"
        editable={stage.kind !== 'WORKING'}
      />

      {stage.kind === 'REFUSED' ? (
        <View style={styles.refusal}>
          <Text accessibilityRole="header" style={styles.refusalHeading}>
            {DELETE_ACCOUNT_COPY.refusalHeading}
          </Text>
          <Text style={styles.body}>{stage.message}</Text>
        </View>
      ) : null}

      <PrimaryButton
        label={
          stage.kind === 'WORKING' ? DELETE_ACCOUNT_COPY.working : DELETE_ACCOUNT_COPY.submitLabel
        }
        onPress={submit}
        disabled={stage.kind === 'WORKING' || password === ''}
      />
      <PrimaryButton
        label={DELETE_ACCOUNT_COPY.cancelLabel}
        variant="secondary"
        onPress={cancel}
        disabled={stage.kind === 'WORKING'}
      />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    block: { gap: SPACING.sm, marginTop: SPACING.lg },
    heading: {
      fontSize: FONT_SIZE.title,
      fontWeight: '700',
      color: theme.surface.foreground,
    },
    subheading: {
      fontSize: FONT_SIZE.body,
      fontWeight: '700',
      color: theme.surface.foreground,
      marginTop: SPACING.sm,
    },
    body: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surface.foreground,
    },
    item: {
      fontSize: FONT_SIZE.body,
      lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surface.foreground,
      paddingLeft: SPACING.sm,
    },
    label: {
      fontSize: FONT_SIZE.body,
      fontWeight: '700',
      color: theme.surface.foreground,
      marginTop: SPACING.sm,
    },
    help: {
      fontSize: FONT_SIZE.caption,
      lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
      color: theme.surfaceMuted.foreground,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.surfaceMuted.foreground,
      borderRadius: 8,
      padding: SPACING.sm,
      fontSize: FONT_SIZE.body,
      color: theme.surface.foreground,
      backgroundColor: theme.surface.background,
    },
    refusal: {
      gap: SPACING.xs,
      padding: SPACING.sm,
      borderRadius: 8,
      backgroundColor: theme.surfaceMuted.background,
    },
    refusalHeading: {
      fontSize: FONT_SIZE.body,
      fontWeight: '700',
      color: theme.surface.foreground,
    },
  });
