/**
 * You screen.
 *
 * Spec references: `06` (You is a primary destination), `15` A6 (what a notification may show on
 * a locked screen), DEC-025 (two dials, the narrower wins), `14` (no session secret on screen),
 * `04` Phase 1.1.
 *
 * The notification settings are the live part. Everything else on this screen - account, consent,
 * export and deletion - is gated on Phase 1.1 choosing an auth provider, and a settings row that
 * opens nothing is worse than no row: it tells the user a control exists.
 *
 * The identity strip names who the app is acting as, because with a development session there is
 * otherwise no way to tell - and "which account am I looking at" is the first question when a
 * screen shows less than expected. It shows the session kind and the profile, never a token.
 */

import { useCallback, useMemo, useState } from 'react';
import { Text, StyleSheet } from 'react-native';
import { LIGHT_THEME, SPACING, FONT_SIZE, LINE_HEIGHT_MULTIPLIER } from '@kynviora/presentation';
import type { NotificationDetailLevel } from '@kynviora/domain';
import { asChosenDetailLevel, asNotificationDetailLevel } from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Screen } from '@/components/Screen';
import { ResourceState } from '@/components/ScreenState';
import { NotificationSettings } from '@/features/notifications/NotificationSettings';

export default function YouScreen() {
  const { client, session, configurationError } = useApi();
  const { activeProfile, activeProfileId } = useProfiles();
  const [saving, setSaving] = useState(false);

  const load = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.notificationSettings(activeProfileId),
    [client, activeProfileId],
  );

  const { resource, reload, refreshing } = useResource(load, {
    enabled: activeProfileId !== null,
  });

  const onRetry = useCallback(() => {
    reload();
  }, [reload]);

  // The preference is written to the server and then re-read. Never applied locally first: this
  // dial decides what a notification may reveal on a locked screen, and a client that showed the
  // new value before the server accepted it would be describing a rule that is not in force.
  const onChoose = useCallback(
    (level: NotificationDetailLevel) => {
      if (client === null || activeProfileId === null || saving) return;
      setSaving(true);
      void client.setNotificationPreference(activeProfileId, level).then(
        () => {
          setSaving(false);
          reload();
        },
        () => {
          setSaving(false);
          reload();
        },
      );
    },
    [client, activeProfileId, reload, saving],
  );

  const settings = resource.value;

  return (
    <Screen
      title="You"
      intro="Account, privacy, consent, accessibility and notifications."
      onRefresh={onRetry}
      refreshing={refreshing}
    >
      {/* Who the app is acting as. Never a token, a header value or an email address (`14`). */}
      <Text style={styles.identity}>
        {session.kind === 'ANONYMOUS'
          ? 'Not signed in on this device.'
          : 'Signed in with a development identity.'}
      </Text>

      {configurationError === null ? null : (
        // A developer-facing sentence, deliberately not the message from the exception: that text
        // is written for whoever is running the app, and this is the screen a user sees.
        <Text style={styles.identity}>
          Kynviora is not set up to talk to a server on this device.
        </Text>
      )}

      {settings === null ? (
        <ResourceState resource={resource} onRetry={onRetry} />
      ) : (
        <NotificationSettings
          state="READY"
          relationship={settings.relationship}
          maxCaregiverDetail={asNotificationDetailLevel(settings.maxCaregiverDetail)}
          // Null means never chosen, which the settings view says out loud rather than showing
          // the default as though it were a decision somebody made (DEC-025).
          myPreference={asChosenDetailLevel(settings.myPreference)}
          effective={asNotificationDetailLevel(settings.effectiveDetail)}
          profileDisplayName={activeProfile?.displayName ?? 'this profile'}
          exampleItemName={null}
          onChoose={onChoose}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  identity: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
    paddingBottom: SPACING.xs,
  },
});
