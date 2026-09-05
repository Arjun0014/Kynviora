/**
 * You screen.
 *
 * Spec references: `06` (You is a primary destination), `15` A6 (what a notification may show on
 * a locked screen), DEC-025 (two dials, the narrower wins), `14` (no session secret on screen),
 * `04` Phase 1.1.
 *
 * The notification settings, the health context and the consent list are the live parts. What is
 * still absent - account, export and deletion - is gated on Phase 1.1 choosing an auth provider
 * and on a retention matrix nobody has written, and a settings row that opens nothing is worse
 * than no row: it tells the user a control exists. `ConsentSettings` says so in a sentence
 * instead of showing one (`DEV-036`).
 *
 * Consent is the only block here that is **not** profile-scoped. A receipt is the caller's own
 * answer about themselves - `consent_select` and `consent_insert` both require the row to be
 * theirs - so it renders whether or not a profile is selected, and switching person does not
 * change it.
 *
 * The identity strip names who the app is acting as, because with a development session there is
 * otherwise no way to tell - and "which account am I looking at" is the first question when a
 * screen shows less than expected. It shows the session kind and the profile, never a token.
 */

import { useCallback, useMemo, useState } from 'react';
import { Text, StyleSheet, Share } from 'react-native';
import {
  LIGHT_THEME,
  SPACING,
  FONT_SIZE,
  LINE_HEIGHT_MULTIPLIER,
  CONSENT_COPY,
} from '@kynviora/presentation';
import type { NotificationDetailLevel, QuietHours } from '@kynviora/domain';
import {
  asChosenDetailLevel,
  asNotificationDetailLevel,
  consentView,
  messageForFailure,
  healthContextView,
  notificationPolicyView,
  profileSwitcherView,
  screenStateForFailure,
} from '@kynviora/contracts';
import { QUIET_HOURS_COPY, type ScreenState as ScreenStateKind } from '@kynviora/presentation';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Screen } from '@/components/Screen';
import { ResourceState } from '@/components/ScreenState';
import { DeliveryPolicy } from '@/features/notifications/DeliveryPolicy';
import { NotificationSettings } from '@/features/notifications/NotificationSettings';
import { ConsentSettings } from '@/features/consent/ConsentSettings';
import { SignOutControl } from '@/features/auth/SignOutControl';
import { HealthContext } from '@/features/profiles/HealthContext';
import { ProfileSwitcher } from '@/features/profiles/ProfileSwitcher';
import { SetUpHousehold } from '@/features/profiles/SetUpHousehold';
import { PendingQueue } from '@/features/sync/PendingQueue';
import { usePendingSync } from '@/sync/PendingSyncProvider';

export default function YouScreen() {
  const { client, session, configurationError, elevate } = useApi();
  // Read here rather than inside `PendingQueue`, so the section is absent when the journal is empty
  // rather than rendering a heading over nothing.
  const { waiting: pendingWaiting, needsAttention: pendingNeedsAttention } = usePendingSync();
  const {
    activeProfile,
    activeProfileId,
    profiles,
    resource: profilesResource,
    select,
    reload: reloadProfiles,
  } = useProfiles();
  const [saving, setSaving] = useState(false);
  /** `04` Phase 1.2. Open where somebody is adding a person, closed the rest of the time. */
  const [addingPerson, setAddingPerson] = useState(false);
  const [exportState, setExportState] = useState<ScreenStateKind | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportReady, setExportReady] = useState(false);
  const [exportIncomplete, setExportIncomplete] = useState(false);
  const [policyState, setPolicyState] = useState<ScreenStateKind | null>(null);
  const [policyMessage, setPolicyMessage] = useState<string | null>(null);
  const [policySaved, setPolicySaved] = useState<string | null>(null);

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

  // `04` Phase 1.3. A separate read from the notification settings: they answer different
  // questions, and a screen that composed them into one request would show neither when one
  // failed - which `06` names as the partial state a page has to be able to express.
  const loadFacts = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.healthFacts(activeProfileId),
    [client, activeProfileId],
  );

  const { resource: factsResource, reload: reloadFacts } = useResource(loadFacts, {
    enabled: activeProfileId !== null,
  });

  // `04` Phase 1.4. Not profile-scoped and deliberately not keyed on `activeProfileId`: a receipt
  // is the caller's own answer about themselves, and re-reading it when somebody switches person
  // would imply it is a property of the profile they are looking at.
  const loadConsents = useMemo(() => (client === null ? null : () => client.consents()), [client]);

  const { resource: consentsResource, reload: reloadConsents } = useResource(loadConsents, {
    enabled: client !== null,
  });

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

  /**
   * Write the whole policy: the owner's ceiling and the window together.
   *
   * Sent through an elevated session, because `14` puts a change to when Kynviora may interrupt
   * somebody - and to what leaves the profile onto other people's devices - behind confirming who
   * you are. `elevate()` returns `null` for a session that cannot assert it, and a request that
   * went without it would come back `STEP_UP_REQUIRED`, which is the honest failure rather than a
   * silent one.
   *
   * The ceiling is re-sent unchanged. The route writes one row, so omitting it would leave it at
   * whatever it was - and omitting the window would clear one somebody had set.
   */
  const onSaveQuietHours = useCallback(
    (window: QuietHours | null) => {
      const settings = resource.value;
      if (client === null || activeProfileId === null || settings === null) return;

      const elevated = elevate();
      if (elevated === null) {
        setPolicyState('STEP_UP_REQUIRED');
        setPolicyMessage(null);
        setPolicySaved(null);
        return;
      }

      setPolicyState('LOADING');
      setPolicyMessage(null);
      setPolicySaved(null);

      void elevated
        .setNotificationPolicy(activeProfileId, {
          maxCaregiverDetail: settings.maxCaregiverDetail,
          quietHoursStartMinute: window === null ? null : window.startMinute,
          quietHoursEndMinute: window === null ? null : window.endMinute,
        })
        .then(
          (outcome) => {
            if (outcome.kind === 'OK') {
              setPolicyState(null);
              setPolicySaved(
                window === null ? QUIET_HOURS_COPY.clearedNote : QUIET_HOURS_COPY.savedNote,
              );
              // Re-read rather than patched. What is in force is the server's answer.
              reload();
              return;
            }
            setPolicyState(screenStateForFailure(outcome));
            setPolicyMessage(messageForFailure(outcome));
          },
          () => {
            setPolicyState('RECOVERABLE_ERROR');
            setPolicyMessage(null);
          },
        );
    },
    [client, activeProfileId, elevate, reload, resource.value],
  );

  const settings = resource.value;
  const policy = settings === null ? null : notificationPolicyView(settings);
  // `04` Phase 1.2. The view decides which profile a screen is entitled to render under, and it
  // never falls back to whoever is first - see `profileSwitcherView`.
  const switcher = profileSwitcherView(profiles, activeProfileId);

  /**
   * Whether the server has actually answered about profiles.
   *
   * `EMPTY` carries no value by design (`resource.ts`), and it is the state that most needs the
   * setup screen - so "has a value" is not the test. Anything else without one is loading or
   * failed, and offering to create a household there would invite somebody who already has one to
   * make a second, which nothing in this build merges.
   */
  const profilesLoaded = profilesResource.value !== null || profilesResource.state === 'EMPTY';

  /**
   * Take a copy of everything (`16` export, DEC-117).
   *
   * Elevated for this one request and discarded, exactly as every other step-up action here is
   * (`14`), so the privileged session never outlives the action.
   *
   * The copy is handed straight to the system share sheet and is never written to the encrypted
   * store or held in a ref beyond this call. It is the largest single collection of somebody's
   * health data this app can hold, and the safest place for it is nowhere: keeping it on the
   * device would give the app a second, unencrypted-by-nothing copy that outlives the request
   * that made it, for no purpose the person asked for.
   */
  const onExport = useCallback(() => {
    const elevated = elevate();
    if (elevated === null) {
      setExportState('STEP_UP_REQUIRED');
      return;
    }

    setExportState('LOADING');
    setExportMessage(null);
    setExportReady(false);
    setExportIncomplete(false);

    void elevated.exportPersonalData().then(
      (outcome) => {
        if (outcome.kind !== 'OK') {
          setExportState(screenStateForFailure(outcome));
          setExportMessage(messageForFailure(outcome));
          return;
        }

        // A section the server could not assemble is `-1`, which no successful read produces.
        // Reported before the copy is handed over, because a person who has already saved a file
        // has stopped reading the screen.
        const incomplete = outcome.value.manifest.sections.some((s) => s.count < 0);

        void Share.share({
          title: CONSENT_COPY.exportHeading,
          message: JSON.stringify(outcome.value, null, 2),
        }).then(
          () => {
            setExportState(null);
            setExportReady(true);
            setExportIncomplete(incomplete);
          },
          () => {
            // The copy was assembled and the sheet refused it. Not a failure of the export, and
            // not a success either - saying "ready" here would name a file nobody received.
            setExportState('RECOVERABLE_ERROR');
            setExportMessage(null);
          },
        );
      },
      () => {
        setExportState('RECOVERABLE_ERROR');
        setExportMessage(null);
      },
    );
  }, [elevate]);

  const onCreated = useCallback(() => {
    setAddingPerson(false);
    // Re-read rather than select what was just made. The selectable set is the server's answer
    // (`13`), and a client that selected a profile it had only just posted would be trusting its
    // own write rather than the authorisation behind it.
    reloadProfiles();
  }, [reloadProfiles]);

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

      {/* Near the top, and only when there is something in it. `12` requires a **resolvable**
          failure state, and a change the server refused is the one thing on this screen that is
          waiting on the person rather than describing a setting. It renders nothing when the
          journal is empty, so it is not a permanent reminder that syncing exists (`DEV-038`). */}
      {pendingWaiting + pendingNeedsAttention > 0 ? <PendingQueue /> : null}

      {/* `04` Phase 1.2. Above everything else on this screen: whose records these are is the
          question that has to be answered before any setting on the page means anything.

          Nothing is offered while the list is still loading. An empty list and a list that has
          not arrived look identical, and the setup screen for the second would invite somebody
          with a household to create a second one - which nothing in this build merges. */}
      {!profilesLoaded ? (
        <ResourceState resource={profilesResource} onRetry={reloadProfiles} />
      ) : addingPerson || switcher.isEmpty ? (
        <SetUpHousehold
          householdId={switcher.addToHouseholdId}
          onCreated={onCreated}
          onClose={
            switcher.isEmpty
              ? undefined
              : () => {
                  setAddingPerson(false);
                }
          }
        />
      ) : (
        <ProfileSwitcher
          view={switcher}
          onSelect={select}
          onAddPerson={() => {
            setAddingPerson(true);
          }}
        />
      )}

      {/* `04` Phase 1.4. Above the settings that depend on it: whether Kynviora may contact this
          person at all is the question that decides what the notification dials below mean.
          Outside the profile gate, because a receipt is the caller's own and not the profile's.

          Nothing is offered while it is still loading. A consent list that has not arrived and
          one where nobody has answered look identical, and rendering the second for the first
          would tell somebody they had never agreed to anything. */}
      {profilesLoaded && !switcher.isEmpty && !addingPerson ? (
        consentsResource.value === null ? (
          <ResourceState resource={consentsResource} onRetry={reloadConsents} />
        ) : (
          <ConsentSettings
            view={consentView(consentsResource.value)}
            onChanged={reloadConsents}
            onExport={onExport}
            exportState={exportState}
            exportMessage={exportMessage}
            exportReady={exportReady}
            exportIncomplete={exportIncomplete}
          />
        )
      ) : null}

      {activeProfileId === null || settings === null || policy === null ? (
        <ResourceState resource={resource} onRetry={onRetry} />
      ) : (
        <>
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

          {/* `04` Phase 1.3. The only health information Kynviora asks for, and it sits with the
              person it is about rather than with the notification settings. */}
          {factsResource.value === null ? (
            <ResourceState resource={factsResource} onRetry={reloadFacts} />
          ) : (
            <HealthContext
              view={healthContextView(factsResource.value)}
              profileId={activeProfileId}
              onChanged={reloadFacts}
            />
          )}

          {/* `04` Phase 7.5. Below the privacy dial because it answers a different question -
              that one is what a notification may say, this one is whether it arrives at all. */}
          <DeliveryPolicy
            view={policy}
            onSave={onSaveQuietHours}
            state={policyState}
            stateMessage={policyMessage}
            savedNote={policySaved}
          />
        </>
      )}

      {/* Last on the screen and outside every gate above it. Signing out must be reachable
          whatever else failed to load - a person whose profile list would not arrive is one of
          the people most likely to want it. */}
      <SignOutControl />
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
