/**
 * Today screen.
 *
 * Spec references: `06` (Today is a primary destination), `04` Phase 8.3 (the Review Inbox),
 * `03` group G (the alert experience this must not resemble), `18` (calm, no counts of anything
 * urgent), DEC-027.
 *
 * Today shows the household's review work: the things that would make what Kynviora can say a
 * little more exact. It deliberately does **not** carry a count badge, a ranking or a "needs
 * attention" header. A review task has no urgency in the database, no urgency in the API payload
 * and no urgency in the presentation tones, and a badge on this screen would reintroduce one at
 * the only layer where nobody would notice (trap 17).
 *
 * Starting a task opens the editor for that task's record kind, because completing one writes to
 * the authoritative record. There is no mark-done path here and there is not one to add: the
 * server refuses a completion with an empty change set, and a tick box on this screen would
 * promise something it would then have to take back.
 *
 * Dose reminders are not here because Phase 4.3 has not been built and Phase 4.2 needs a device
 * (`BLK-002`). An empty schedule strip would be a promise the app cannot keep.
 */

import { useCallback, useMemo, useState } from 'react';
import { Text, StyleSheet } from 'react-native';
import {
  LIGHT_THEME,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  type ScreenState as ScreenStateKind,
} from '@kynviora/presentation';
import {
  reviewInboxView,
  screenStateForFailure,
  type ReviewTaskCompletion,
  type ReviewTaskView,
} from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Screen } from '@/components/Screen';
import { ResourceState } from '@/components/ScreenState';
import { ReviewInbox } from '@/features/reviewInbox/ReviewInbox';
import { ReviewTaskEditor } from '@/features/reviewInbox/ReviewTaskEditor';
import { VisitPackFlow } from '@/features/visitPack/VisitPackFlow';
import { PrimaryButton } from '@/components/PrimaryButton';

export default function TodayScreen() {
  const { client } = useApi();
  const { activeProfile, activeProfileId } = useProfiles();

  const [editing, setEditing] = useState<ReviewTaskView | null>(null);
  // `06` Journey 8 lives here because Today is where an appointment belongs - the screen's own
  // introduction has always said "due medicines, appointments and anything that needs review".
  const [preparingPack, setPreparingPack] = useState(false);
  const [saving, setSaving] = useState<ScreenStateKind | null>(null);
  const [savingMessage, setSavingMessage] = useState<string | null>(null);

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

  const onStartTask = useCallback(
    (taskId: string) => {
      setSaving(null);
      setSavingMessage(null);
      setEditing(inbox.tasks.find((task) => task.taskId === taskId) ?? null);
    },
    [inbox.tasks],
  );

  /**
   * Send the completion, then reload from the server.
   *
   * Never applied optimistically. The record write happens first on the server and the task closes
   * as a consequence (DEC-027), so a client that removed the row before hearing back would show a
   * task as done that may not have been.
   */
  const onSubmit = useCallback(
    (completion: ReviewTaskCompletion) => {
      const task = editing;
      if (client === null || task === null) return;

      setSaving('LOADING');
      setSavingMessage(null);

      void client.completeReviewTask(task.taskId, completion).then(
        (outcome) => {
          if (outcome.kind === 'OK') {
            setEditing(null);
            setSaving(null);
            reload();
            return;
          }
          // The same mapping every read path uses, so a failed write reads the same as a failed
          // read. The server's own words where it sent any; the state's copy otherwise - nothing
          // is invented here, because `14` keeps the reason out of the authorization responses
          // on purpose.
          setSaving(screenStateForFailure(outcome));
          setSavingMessage(outcome.kind === 'REFUSED' ? outcome.message : null);
        },
        () => {
          setSaving('RECOVERABLE_ERROR');
          setSavingMessage(null);
        },
      );
    },
    [client, editing, reload],
  );

  const onCancel = useCallback(() => {
    setEditing(null);
    setSaving(null);
    setSavingMessage(null);
  }, []);

  return (
    <Screen title="Today" onRefresh={onRetry} refreshing={refreshing}>
      {activeProfile === null ? null : (
        <Text style={styles.profile}>{activeProfile.displayName}</Text>
      )}

      {preparingPack ? (
        <VisitPackFlow
          onClose={() => {
            setPreparingPack(false);
          }}
        />
      ) : editing !== null ? (
        <ReviewTaskEditor
          kind={editing.kind}
          subjectId={editing.subjectId}
          subjectLabel={editing.subjectLabel}
          // The server stamps the authoritative time; this is what the form records as the moment
          // the user confirmed, and it comes from the last response rather than from the device.
          now={resource.value?.serverTime ?? ''}
          onSubmit={onSubmit}
          onCancel={onCancel}
          state={saving}
          stateMessage={savingMessage}
          onRetry={onCancel}
        />
      ) : resource.state === 'READY' || resource.state === 'EMPTY' ? (
        // The inbox renders its own empty state, which says something more useful than the
        // generic one: nothing needs attention *here*, which is not a statement about safety.
        <ReviewInbox state="READY" tasks={inbox.tasks} onStartTask={onStartTask} />
      ) : (
        <ResourceState resource={resource} onRetry={onRetry} />
      )}

      {preparingPack || editing !== null ? null : (
        <PrimaryButton
          label="Prepare a summary for an appointment"
          variant="secondary"
          accessibilityHint="Choose what to share with a health professional. Nothing is included until you choose it."
          onPress={() => {
            setPreparingPack(true);
          }}
        />
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
