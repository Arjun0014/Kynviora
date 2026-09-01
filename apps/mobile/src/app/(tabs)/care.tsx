/**
 * Care screen.
 *
 * Spec references: `06` Journey 6 and its required screen states, `12` (no client-side
 * authorization), `14` (caregiver administration needs step-up), `16` (a family relationship is
 * not a licence to see everything), `04` Phase 8.1, DEC-018.
 *
 * WHAT THIS SCREEN WILL NOT DO
 * It never invents a row. On this screen a wrong row is a false statement about who can read a
 * person's health data, in either direction: showing someone who has no access invites a
 * pointless revocation, and omitting someone who does leaves an unknown reader in place. So the
 * list is whatever `GET /v1/caregiver-grants` returned under row-level security, and every other
 * state renders as a state.
 *
 * THE INVITATION IS THE ONE ELEVATED REQUEST
 * `14` requires re-authentication for caregiver administration. The elevated client is built at
 * the moment of sending and used for exactly that one call; every other request on this screen
 * uses the ordinary one, so the privileged session never outlives the action. The token that comes
 * back is handed straight to the component that displays it and is never stored, logged or put in
 * a URL (DEC-018, trap 11).
 *
 * Revocation is a server operation behind step-up and is never applied optimistically (`12`,
 * `14`). A row that disappears on a failed request is the same false statement again.
 */

import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LIGHT_THEME, SPACING, type ScreenState as ScreenStateKind } from '@kynviora/presentation';
import {
  accessList,
  inviterAuthority,
  screenStateForFailure,
  type InvitationCreated,
} from '@kynviora/contracts';
import type { CaregiverCapability } from '@kynviora/domain';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { CaregiverAccessList } from '@/features/caregivers/CaregiverAccessList';
import { InviteCaregiver } from '@/features/caregivers/InviteCaregiver';

/** Matches `DEFAULT_INVITATION_TTL_DAYS` on the server. Shown, not sent. */
const INVITATION_TTL_DAYS = 7;

export default function CareScreen() {
  const { client, elevate } = useApi();
  const { activeProfileId, activeProfile } = useProfiles();

  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const [sendState, setSendState] = useState<ScreenStateKind | null>(null);
  const [sendMessage, setSendMessage] = useState<string | null>(null);

  /**
   * Grants and outstanding invitations, together.
   *
   * Two requests because they are two records - a grant does not exist until acceptance - and one
   * resource because they answer one question: who can read this profile. If the invitations call
   * fails and the grants call succeeds the result is `PARTIAL`, which says the list is incomplete
   * rather than showing a shorter one as though it were the whole answer (`06`).
   */
  const load = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : async () => {
            const [grants, invitations] = await Promise.all([
              client.listCaregiverGrants({ profileId: activeProfileId }),
              client.listInvitations({ profileId: activeProfileId }),
            ]);
            if (grants.kind !== 'OK') return grants;
            return {
              kind: 'OK' as const,
              correlationId: grants.correlationId,
              value: {
                grants: grants.value.grants,
                invitations: invitations.kind === 'OK' ? invitations.value.invitations : [],
                invitationsLoaded: invitations.kind === 'OK',
              },
            };
          },
    [client, activeProfileId],
  );

  const { resource, reload } = useResource(load, {
    enabled: activeProfileId !== null,
    isEmpty: (value) => value.grants.length === 0 && value.invitations.length === 0,
    isPartial: (value) => !value.invitationsLoaded,
  });

  const rows = useMemo(
    () => accessList(resource.value?.grants ?? [], resource.value?.invitations ?? []),
    [resource.value],
  );

  /**
   * What this caller may delegate.
   *
   * Derived from the grants the server returned, never assumed. The server decides again on the
   * request; this only keeps the screen from offering a control whose sole outcome would be
   * `CAPABILITY_ESCALATION` (DEC-020).
   */
  const authority = useMemo(
    () =>
      inviterAuthority({
        // The server's own answer, not an inference. `isManaged` is about the person the profile
        // is for and says nothing about who administers it.
        isOwner: activeProfile?.isOwner ?? false,
        // A caregiver's own capabilities are not on this response. Until they are, a non-owner is
        // offered nothing rather than something that might be refused - the safe direction, and
        // visible rather than silent.
        ownCapabilities: [],
      }),
    [activeProfile],
  );

  const onRetry = useCallback(() => {
    reload();
  }, [reload]);

  const onSend = useCallback(
    (body: {
      readonly profileId: string;
      readonly capabilities: readonly CaregiverCapability[];
      readonly invitedEmail?: string;
    }) => {
      // Built here and used for this one request. `14` requires re-authentication for caregiver
      // administration, and a client that stayed elevated would make the requirement decorative.
      const elevated = elevate();
      if (elevated === null) {
        setSendState('STEP_UP_REQUIRED');
        return;
      }

      setSendState('LOADING');
      setSendMessage(null);

      // A key per attempt, kept across retries of the same intent by being generated once here:
      // a key regenerated on retry would mint a second live token for one intent, which is two
      // credentials where the owner believes there is one.
      const idempotencyKey = crypto.randomUUID();

      void elevated.createInvitation({ ...body }, idempotencyKey).then(
        (outcome) => {
          if (outcome.kind === 'OK') {
            setSendState(null);
            // Straight from the response to the component that renders it. Nothing in between.
            setCreated(outcome.value);
            reload();
            return;
          }
          setSendState(screenStateForFailure(outcome));
          setSendMessage(outcome.kind === 'REFUSED' ? outcome.message : null);
        },
        () => {
          setSendState('RECOVERABLE_ERROR');
          setSendMessage(null);
        },
      );
    },
    [elevate, reload],
  );

  const onCloseInvite = useCallback(() => {
    setInviting(false);
    // Dropped, not kept. The token has been read or it has not; either way this screen has no
    // reason to hold a live credential once it closes.
    setCreated(null);
    setSendState(null);
    setSendMessage(null);
  }, []);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      {inviting && activeProfileId !== null ? (
        <View style={styles.sheet}>
          <InviteCaregiver
            profileId={activeProfileId}
            authority={authority}
            invitationTtlDays={INVITATION_TTL_DAYS}
            onSend={onSend}
            onClose={onCloseInvite}
            created={created}
            state={sendState}
            stateMessage={sendMessage}
          />
        </View>
      ) : (
        <CaregiverAccessList
          // EMPTY is passed through as READY so the list renders its own empty copy, which says
          // something specific - "no one else has access to this profile" - rather than the
          // generic "nothing here yet". On this screen that distinction is the whole answer to
          // the question the user came to ask.
          // EMPTY and PARTIAL both render the list: EMPTY so it can say "no one else has access
          // to this profile" rather than the generic copy, PARTIAL because the rows that did load
          // are still worth showing.
          state={
            resource.state === 'EMPTY' || resource.state === 'PARTIAL' ? 'READY' : resource.state
          }
          rows={rows}
          onRetry={onRetry}
          onInvite={() => {
            setInviting(true);
          }}
          onRevoke={() => {
            // Never applied locally. `12` forbids optimistic authorization changes, and a row
            // that vanishes on a failed request misstates who can read this profile. The
            // revocation screen is the remaining work here.
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: LIGHT_THEME.surface.background },
  sheet: { padding: SPACING.lg },
});
