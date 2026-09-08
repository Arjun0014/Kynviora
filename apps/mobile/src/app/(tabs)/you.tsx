/**
 * You screen.
 *
 * Spec references: `06` (You is a primary destination, and its own hierarchy - account,
 * accessibility, privacy, notifications, data), `15` A6 (what a notification may show on a locked
 * screen), DEC-025 (two dials, the narrower wins), `14` (no session secret on screen), `04`
 * Phase 1.1, DEC-130, DEC-143.
 *
 * WHY IT IS SECTIONED (DEC-143)
 * It was a flat stack of eight feature blocks with nothing saying where one subject ended and the
 * next began - which reads as an admin form, and this is the screen holding consent, what leaves
 * the device and how to close an account. `06` names five subjects for this destination and they
 * are now five markers a screen reader can navigate by, which is the half of "sectioned" that is
 * not decoration.
 *
 * The order inside them is unchanged where a comment already gave a reason, and those reasons are
 * still beside the blocks they belong to. Appearance stays above everything that needs a network
 * answer; the person stays above every setting that is about them; consent stays above the
 * notification dials it decides the meaning of; and the two irreversible things stay last.
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
import { Pressable, Share, StyleSheet } from 'react-native';
import {
  ACCOUNT_CENTER_INTRO,
  CONSENT_COPY,
  IRREVERSIBLE_ROW_NOTE,
  MIN_TOUCH_TARGET_DP,
  settingsGroupPresentation,
  settingsGroupRows,
  type SettingsGroup,
  type Theme,
} from '@kynviora/presentation';
import type { NotificationDetailLevel, QuietHours } from '@kynviora/domain';
import {
  asChosenDetailLevel,
  asNotificationDetailLevel,
  consentView,
  messageForFailure,
  healthContextView,
  healthSourceView,
  notificationPolicyView,
  profileSwitcherView,
  screenStateForFailure,
} from '@kynviora/contracts';
import { QUIET_HOURS_COPY, type ScreenState as ScreenStateKind } from '@kynviora/presentation';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { Card } from '@/components/Card';
import { Screen } from '@/components/Screen';
import { SectionHeader } from '@/components/SectionHeader';
import { ResourceState } from '@/components/ScreenState';
import { Typography } from '@/components/Typography';
import { DeliveryPolicy } from '@/features/notifications/DeliveryPolicy';
import { NotificationSettings } from '@/features/notifications/NotificationSettings';
import { ConsentSettings } from '@/features/consent/ConsentSettings';
import { AppearanceSettings } from '@/features/settings/AppearanceSettings';
import { SignOutControl } from '@/features/auth/SignOutControl';
import { DeleteAccount } from '@/features/auth/DeleteAccount';
import { HealthContext } from '@/features/profiles/HealthContext';
import { ProfileSwitcher } from '@/features/profiles/ProfileSwitcher';
import { SetUpHousehold } from '@/features/profiles/SetUpHousehold';
import { PendingQueue } from '@/features/sync/PendingQueue';
import { usePendingSync } from '@/sync/PendingSyncProvider';
import { TalkBar } from '@/voice/TalkBar';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SourceRow } from '@/features/health/HealthPieces';
import { useThemedStyles } from '@/theme/ThemeProvider';
import { useDeclareScreen, type ScreenActionBinding } from '@/voice/ScreenContextProvider';

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
  /**
   * Which of the eight groups is open, or `null` for the home screen (DEC-158).
   *
   * Held here rather than as a route, for the reason every sheet in this app is held in state:
   * `06` fixes five destinations, and eight settings pages as eight routes would be eight things
   * a deep link could land on with no way back to the person picker above them.
   */
  const [openGroup, setOpenGroup] = useState<SettingsGroup | null>(null);

  /**
   * Where health data could come from for the chosen person.
   *
   * Read only while Connections is open. A settings page nobody has opened should not be adding a
   * request to every cold start, and this one answers a question that is only asked here.
   */
  const loadSources = useMemo(
    () =>
      client === null || activeProfileId === null || openGroup !== 'CONNECTIONS'
        ? null
        : () => client.healthSources(activeProfileId),
    [client, activeProfileId, openGroup],
  );
  const { resource: sourcesResource, reload: reloadSources } = useResource(loadSources, {
    enabled: loadSources !== null,
  });
  const sourceViews = useMemo(
    () => (sourcesResource.value?.sources ?? []).map(healthSourceView),
    [sourcesResource.value],
  );
  const closeGroup = useCallback(() => {
    setOpenGroup(null);
  }, []);
  const styles = useThemedStyles(makeStyles);

  /**
   * What Kynviora can do on You (DEC-157).
   *
   * Opening each of the eight groups, and getting back out. Deliberately **nothing else**: signing
   * out, closing an account and taking a copy of the data are touch-only and need a fresh sign-in
   * (DEC-132), and an action that navigated straight to one of them would be the agent doing the
   * approach work for a decision it is not allowed to make.
   *
   * The labels are the group titles, so what the panel offers and what the row says are the same
   * words - a person who read one and says the other is understood.
   */
  const screenActions = useMemo<readonly ScreenActionBinding[]>(
    () => [
      ...settingsGroupRows().map((row) => ({
        id: `you.open.${row.group}`,
        label: `Open ${row.title}`,
        says: `Opening ${row.title}.`,
        run: () => {
          setOpenGroup(row.group);
        },
      })),
      {
        id: 'you.home',
        label: 'Back to You',
        says: 'Back to You.',
        run: () => {
          setOpenGroup(null);
        },
      },
    ],
    [],
  );

  useDeclareScreen(
    useMemo(
      () => ({
        route: 'YOU' as const,
        profileId: activeProfileId,
        actions: screenActions,
        // The person picker and the setup form are the sheet-shaped things on this screen.
        sheetOpen: addingPerson,
      }),
      [activeProfileId, screenActions, addingPerson],
    ),
  );

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

  /**
   * The identity strip, which is on the home screen and inside Account Center.
   *
   * `06` requires the current person to be clear on every screen showing care information, and
   * "which account am I looking at" is the first question when a screen shows less than expected.
   * Never a token, a header value or an email address (`14`).
   */
  const identity = (
    <Card>
      <Typography role="body">
        {session.kind === 'ANONYMOUS'
          ? 'Not signed in on this device.'
          : 'Signed in with a development identity.'}
      </Typography>
      {configurationError === null ? null : (
        // A developer-facing sentence, deliberately not the message from the exception: that text
        // is written for whoever is running the app, and this is the screen a user sees.
        <Typography role="caption" colour="secondary">
          Kynviora is not set up to talk to a server on this device.
        </Typography>
      )}
    </Card>
  );

  const personIsChosen =
    activeProfileId !== null && profilesLoaded && !switcher.isEmpty && !addingPerson;

  // ---------------------------------------------------------------------------
  // One group, open
  // ---------------------------------------------------------------------------
  if (openGroup !== null) {
    const presentation = settingsGroupPresentation(openGroup);
    return (
      <Screen
        title={presentation.title}
        intro={openGroup === 'ACCOUNT' ? ACCOUNT_CENTER_INTRO : presentation.summary}
        onRefresh={onRetry}
        refreshing={refreshing}
        footer={<TalkBar />}
      >
        <PrimaryButton label="Back to You" variant="secondary" onPress={closeGroup} />

        {openGroup === 'ACCOUNT' ? (
          <>
            {identity}
            {/* Reversible first. Signing out is what most people came for, and it must be
                reachable whatever else failed to load - a person whose profile list would not
                arrive is one of the people most likely to want it. */}
            <SectionHeader
              title="This device"
              explanation="Signing out here, and leaving the account itself alone."
            />
            <SignOutControl />
            {/* Last on its own page, which is what V3 asks for and where `16` is satisfied:
                the control exists and is findable, and it is now something somebody went to find
                rather than something they scrolled past looking for the notification settings
                (DEC-158). */}
            <SectionHeader
              title="Closing this account"
              explanation="Everything Kynviora holds for you, removed. This cannot be undone."
            />
            <DeleteAccount />
          </>
        ) : null}

        {openGroup === 'PRIVACY' ? (
          !profilesLoaded || switcher.isEmpty || addingPerson ? (
            <Card>
              <Typography role="body">
                Choose who this is about on the You screen first. What you have agreed to is
                recorded against your account, and a copy of your data is about the people in it.
              </Typography>
            </Card>
          ) : consentsResource.value === null ? (
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

        {openGroup === 'NOTIFICATIONS' ? (
          activeProfileId === null || settings === null || policy === null ? (
            <ResourceState resource={resource} onRetry={onRetry} />
          ) : (
            <>
              <NotificationSettings
                state="READY"
                relationship={settings.relationship}
                maxCaregiverDetail={asNotificationDetailLevel(settings.maxCaregiverDetail)}
                // Null means never chosen, which the settings view says out loud rather than
                // showing the default as though it were a decision somebody made (DEC-025).
                myPreference={asChosenDetailLevel(settings.myPreference)}
                effective={asNotificationDetailLevel(settings.effectiveDetail)}
                profileDisplayName={activeProfile?.displayName ?? 'this profile'}
                exampleItemName={null}
                onChoose={onChoose}
              />
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
          )
        ) : null}

        {openGroup === 'ACCESSIBILITY' || openGroup === 'APPEARANCE' ? (
          <>
            {/* One component behind two rows, and that is not a shortcut. Text size, motion and
                theme are the same three controls whichever question brought somebody here, and
                splitting them so each row had something unique of its own would put "reduce
                motion" in one place and "dark mode" in another - which is the flat list V3 is
                replacing, arriving through the fix for it. */}
            <AppearanceSettings />
            {openGroup === 'ACCESSIBILITY' ? (
              <Card>
                <Typography role="label" heading>
                  How Kynviora talks to you
                </Typography>
                <Typography role="body">
                  Talk to Kynviora sits above the navigation on every screen. This phone has no
                  speech recogniser and no voice, so it is driven by choosing or typing rather than
                  by speaking, and it says so on itself.
                </Typography>
                <Typography role="caption" colour="secondary">
                  Text size comes from your phone&rsquo;s own settings and Kynviora follows it, up
                  to twice the ordinary size.
                </Typography>
              </Card>
            ) : null}
          </>
        ) : null}

        {openGroup === 'CONNECTIONS' ? (
          !personIsChosen ? (
            <Card>
              <Typography role="body">
                Choose who this is about on the You screen first. Connections are per person.
              </Typography>
            </Card>
          ) : (
            <>
              <ResourceState resource={sourcesResource} onRetry={reloadSources} />
              <Card>
                <Typography role="body">
                  Nothing is connected automatically. Every source below says what it actually is,
                  and one that has not been built says so rather than offering a button that does
                  nothing.
                </Typography>
              </Card>
              {sourceViews.length === 0 ? (
                <Card>
                  <Typography role="body">No sources are recorded for this person yet.</Typography>
                </Card>
              ) : (
                <Card>
                  {sourceViews.map((source) => (
                    <SourceRow key={source.id} source={source} />
                  ))}
                </Card>
              )}
            </>
          )
        ) : null}

        {openGroup === 'AGENT' ? (
          <>
            <Card>
              <Typography role="label" heading>
                What it can do
              </Typography>
              <Typography role="body">
                Kynviora can record a dose, set or change a reminder, open a screen and start guided
                capture. Anything it is about to change is shown and read out before it happens, and
                nothing happens until you say yes.
              </Typography>
            </Card>
            <Card>
              <Typography role="label" heading>
                What it will not do
              </Typography>
              {/* Not a disclaimer. These are the four refusals the gates actually enforce
                  (DEC-132 to DEC-134), and a person is entitled to know the shape of them before
                  they start rather than by being refused. */}
              <Typography role="body">
                It will not say whether a medicine is a good idea, close your account, revoke
                somebody&rsquo;s access or export your data. Those are touch-only and need you to
                sign in again.
              </Typography>
              <Typography role="caption" colour="secondary">
                Nothing you say is sent to a speech service or a language model in this build. There
                is no recogniser and no voice wired up at all.
              </Typography>
            </Card>
          </>
        ) : null}

        {openGroup === 'HELP' ? (
          <>
            <Card>
              <Typography role="label" heading>
                About this build
              </Typography>
              <Typography role="body">
                Kynviora is a family safety layer for medicines and personal-care products. This is
                a development build: it talks to a server on this machine and holds no real clinical
                data.
              </Typography>
            </Card>
            <Card>
              <Typography role="label" heading>
                If something looks wrong
              </Typography>
              <Typography role="body">
                A safety line you disagree with can be reported from the item it is about. Kynviora
                records that somebody disagrees; it does not change what a reviewer decided.
              </Typography>
            </Card>
          </>
        ) : null}
      </Screen>
    );
  }

  // ---------------------------------------------------------------------------
  // The home screen: a person, and eight rows
  // ---------------------------------------------------------------------------
  return (
    <Screen
      title="You"
      eyebrow={activeProfile?.displayName ?? null}
      intro="Your account, and the settings for the people in this household."
      onRefresh={onRetry}
      refreshing={refreshing}
      footer={<TalkBar />}
    >
      {identity}

      {/* Near the top, and only when there is something in it. `12` requires a **resolvable**
          failure state, and a change the server refused is the one thing on this screen that is
          waiting on the person rather than describing a setting. It renders nothing when the
          journal is empty, so it is not a permanent reminder that syncing exists (`DEV-038`). */}
      {pendingWaiting + pendingNeedsAttention > 0 ? <PendingQueue /> : null}

      {/* `04` Phase 1.2. Above the eight rows: whose records these are is the question that has
          to be answered before any of them means anything, and V3 asks for a profile header on
          this screen for the same reason.

          Nothing is offered while the list is still loading. An empty list and a list that has
          not arrived look identical, and the setup screen for the second would invite somebody
          with a household to create a second one - which nothing in this build merges. */}
      <SectionHeader
        title="Who this is about"
        explanation="The people in this household, and the one these settings apply to."
      />
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

      {/* `04` Phase 1.3. Allergies and sensitivities stay on this screen rather than moving to
          Health, and the reason is that they are the one thing here a **rule** reads: they are
          entered beside the person they are about, and Health shows them as recorded facts. Moving
          the editor would put the writing surface two destinations away from the person picker.

          Gated on its own read. It used to sit inside the notification-settings guard, so a
          household whose notification settings would not load lost a health context that had
          arrived perfectly well - a partial state rendered as an absence, which is exactly the
          failure `06` names that state to prevent. */}
      {!personIsChosen ? null : (
        <>
          <SectionHeader
            title="Health context"
            explanation="Allergies and sensitivities, and where each one came from."
          />
          {factsResource.value === null ? (
            <ResourceState resource={factsResource} onRetry={reloadFacts} />
          ) : (
            <HealthContext
              view={healthContextView(factsResource.value)}
              profileId={activeProfileId}
              onChanged={reloadFacts}
            />
          )}
        </>
      )}

      {/* The eight groups (DEC-158). No switches, no destructive control, nothing needing a
          decision - each row is a subject and a sentence saying what is inside it, and the one
          group holding something irreversible says so in words rather than in a colour. */}
      <SectionHeader title="Settings" explanation="Eight places, each saying what is inside it." />
      {settingsGroupRows().map((row) => (
        <Pressable
          key={row.group}
          accessibilityRole="button"
          accessibilityLabel={`${row.title}. ${row.summary}${
            row.containsIrreversible ? ` ${IRREVERSIBLE_ROW_NOTE}.` : ''
          }`}
          onPress={() => {
            setOpenGroup(row.group);
          }}
          style={styles.groupRow}
        >
          <Card>
            <Typography role="title" decorative>
              {row.title}
            </Typography>
            <Typography role="body" colour="secondary" decorative>
              {row.summary}
            </Typography>
            {row.containsIrreversible ? (
              <Typography role="caption" colour="secondary" decorative>
                {IRREVERSIBLE_ROW_NOTE}
              </Typography>
            ) : null}
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}

const makeStyles = (_theme: Theme) =>
  StyleSheet.create({
    groupRow: { minHeight: MIN_TOUCH_TARGET_DP },
  });
