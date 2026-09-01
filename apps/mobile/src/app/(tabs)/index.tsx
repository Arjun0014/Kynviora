/**
 * Today screen.
 *
 * Spec references: `06` (Today is a primary destination), `04` Phase 8.3 (the Review Inbox),
 * `03` group G (the alert experience this must not resemble), `18` (calm, no counts of anything
 * urgent).
 *
 * Today shows the household's review work: the things that would make what Kynviora can say a
 * little more exact. It deliberately does **not** carry a count badge, a ranking or a "needs
 * attention" header. A review task has no urgency in the database, no urgency in the API payload
 * and no urgency in the presentation tones, and a badge on this screen would reintroduce one at
 * the only layer where nobody would notice (trap 17).
 *
 * Dose reminders are not here because Phase 4.3 has not been built and Phase 4.2 needs a device
 * (`BLK-002`). An empty schedule strip would be a promise the app cannot keep.
 */

import { useCallback, useMemo } from 'react';
import { Text, StyleSheet } from 'react-native';
import { LIGHT_THEME, FONT_SIZE, LINE_HEIGHT_MULTIPLIER } from '@kynviora/presentation';
import { reviewInboxView } from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Screen } from '@/components/Screen';
import { ResourceState } from '@/components/ScreenState';
import { ReviewInbox } from '@/features/reviewInbox/ReviewInbox';

export default function TodayScreen() {
  const { client } = useApi();
  const { activeProfile, activeProfileId } = useProfiles();

  const load = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.reviewTasks(activeProfileId),
    [client, activeProfileId],
  );

  const { resource, reload, refreshing } = useResource(load, {
    enabled: activeProfileId !== null,
  });

  // A task kind this client does not recognise is dropped rather than rendered with a fallback
  // label, and the count of dropped rows comes back so the screen can say the list is short.
  // The presentation layer holds one description per kind and no default; inventing one would
  // put words next to somebody's medicine record that no reviewer wrote.
  const inbox = useMemo(() => reviewInboxView(resource.value?.tasks ?? []), [resource.value]);

  const onRetry = useCallback(() => {
    reload();
  }, [reload]);

  return (
    <Screen title="Today" onRefresh={onRetry} refreshing={refreshing}>
      {activeProfile === null ? null : (
        <Text style={styles.profile}>{activeProfile.displayName}</Text>
      )}

      {resource.state === 'READY' || resource.state === 'EMPTY' ? (
        // The inbox renders its own empty state, which says something more useful than the
        // generic one: nothing needs attention *here*, which is not a statement about safety.
        <ReviewInbox
          state="READY"
          tasks={inbox.tasks}
          onStartTask={() => {
            // Completing a task writes to the authoritative record (DEC-027). The editor for
            // each record kind is the remaining work; there is deliberately no mark-done path
            // to fall back on in the meantime.
          }}
        />
      ) : (
        <ResourceState resource={resource} onRetry={onRetry} />
      )}

      {/* `06` requires a partial result to be visible as one. A silently shorter list is the
          failure that state exists to prevent. */}
      {inbox.unrecognisedCount > 0 ? (
        <Text style={styles.partial}>
          Some entries could not be shown. This app may be older than the information it received.
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  profile: {
    fontSize: FONT_SIZE.body,
    lineHeight: FONT_SIZE.body * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
  partial: {
    fontSize: FONT_SIZE.caption,
    lineHeight: FONT_SIZE.caption * LINE_HEIGHT_MULTIPLIER.relaxed,
    color: LIGHT_THEME.surfaceMuted.foreground,
  },
});
