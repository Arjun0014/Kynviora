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
 * IT USES `Screen` NOW, LIKE EVERY OTHER DESTINATION (DEC-142)
 * It did not, and the stated reason was that `Screen` draws a destination heading and this tab had
 * never had one. That reason expired on 2026-09-07, when removing the navigator's header gave Care
 * a heading of its own (`DEV-076`) - and what was left was the one destination with a hand-rolled
 * frame: its own `SafeAreaView`, its own `ScrollView`, its own heading block, its own padding, and
 * a second `ScrollView` nested inside the first in `CaregiverAccessList`. Two scroll views in the
 * same direction is one of them eating the other's gestures, which is the shape of `DEV-046` and
 * is not something a test in this repository can see.
 *
 * REMOVING ACCESS IS THE SAME SHAPE, WITH ONE DIFFERENCE
 * It is a server operation behind step-up and is never applied optimistically (`12`, `14`) - a
 * row that disappears on a failed request is the same false statement again. The difference is
 * that the list holds two kinds of record, and the route depends on which. `buildRevocation`
 * makes that choice from the row the user is actually looking at, because a control handed only
 * an ID cannot: the wrong route answers 404, the client correctly renders that as absence, and
 * the bug would have looked like the row quietly vanishing.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ScreenState as ScreenStateKind } from '@kynviora/presentation';
import {
  ALREADY_ACCEPTED_CODE,
  accessHistory,
  accessList,
  buildRevocation,
  heldCapabilities,
  inviterAuthority,
  mayInvite,
  revocationMessage,
  screenStateForFailure,
  type InvitationCreated,
  type RevocationTarget,
} from '@kynviora/contracts';
import type { CaregiverCapability } from '@kynviora/domain';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { CaregiverAccessList } from '@/features/caregivers/CaregiverAccessList';
import { InviteCaregiver } from '@/features/caregivers/InviteCaregiver';
import { RemoveCaregiverAccess } from '@/features/caregivers/RemoveCaregiverAccess';
import { newIdempotencyKey } from '@/platform/ids';
import { Screen } from '@/components/Screen';
import { VoiceBar } from '@/voice/VoiceHost';

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
   * The removal in progress.
   *
   * A target rather than an ID, because the target carries which record it is - and so which
   * route answers. Cleared on close; nothing about a removal survives leaving the screen.
   */
  const [removing, setRemoving] = useState<RevocationTarget | null>(null);
  const [removeState, setRemoveState] = useState<ScreenStateKind | null>(null);
  const [removeMessage, setRemoveMessage] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ readonly alreadyRemoved: boolean } | null>(null);

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
            const [grants, invitations, audit] = await Promise.all([
              client.listCaregiverGrants({ profileId: activeProfileId }),
              client.listInvitations({ profileId: activeProfileId }),
              // `03` group H. Read alongside the list rather than behind a control, because
              // after a removal the list is exactly one row shorter and the history is the only
              // place the removal itself is visible. A caller with no administrative authority
              // gets 404 here, which drops the section rather than failing the screen.
              client.caregiverAudit(activeProfileId),
            ]);
            if (grants.kind !== 'OK') return grants;
            return {
              kind: 'OK' as const,
              correlationId: grants.correlationId,
              value: {
                grants: grants.value.grants,
                invitations: invitations.kind === 'OK' ? invitations.value.invitations : [],
                invitationsLoaded: invitations.kind === 'OK',
                history: audit.kind === 'OK' ? audit.value.events : [],
                // The clock that produced these rows, used to discount an expired grant when
                // working out what this caller may delegate. Never the device's.
                serverTime: grants.value.serverTime,
              },
            };
          },
    [client, activeProfileId],
  );

  const { resource, reload } = useResource(load, {
    enabled: activeProfileId !== null,
    // The history counts, and leaving it out was the same mistake the schedule editor made
    // (`DEV-045`): `EMPTY` sets `value` to `null`, so a household with no current access showed no
    // record of past access either - at the one moment somebody is most likely to be looking for
    // it, having just revoked the last caregiver. "Nobody has access" and "nobody has ever had
    // access" are different sentences and `08.2`'s audit trail is the difference.
    isEmpty: (value) =>
      value.grants.length === 0 && value.invitations.length === 0 && value.history.length === 0,
    isPartial: (value) => !value.invitationsLoaded,
  });

  const rows = useMemo(
    () => accessList(resource.value?.grants ?? [], resource.value?.invitations ?? []),
    [resource.value],
  );

  const history = useMemo(() => accessHistory(resource.value?.history ?? []), [resource.value]);

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
        // The union across the caller's own active grants, which is what `has_capability` does in
        // SQL. Their own grants are the ones the server marked `isSelf` (DEC-052); matching on a
        // user ID read back out of the session is the mistake `13` exists to prevent.
        ownCapabilities: heldCapabilities(
          resource.value?.grants ?? [],
          resource.value?.serverTime ?? '',
        ),
      }),
    [activeProfile, resource.value],
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
      const idempotencyKey = newIdempotencyKey();

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

  /**
   * Open the confirmation for a row.
   *
   * The row, not the ID. `buildRevocation` reads the subject and the state off the thing the
   * person is looking at, so a list that has moved on since it loaded produces a refusal here
   * rather than a request against the wrong record.
   */
  const onRevoke = useCallback(
    (id: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row === undefined) return;

      const draft = buildRevocation(row);
      if (!draft.ok || draft.target === null) {
        // Nothing to remove. Reload rather than explain: the row on screen is out of date, and
        // the accurate list is a better answer than a sentence about the stale one.
        reload();
        return;
      }
      setRemoved(null);
      setRemoveState(null);
      setRemoveMessage(null);
      setRemoving(draft.target);
    },
    [rows, reload],
  );

  /**
   * Perform the removal.
   *
   * Elevated for this one request and discarded, exactly as the invitation is (`14`). No
   * idempotency key: revocation has one destination state, so a retry is the same request rather
   * than a second one. Nothing is applied locally - the list is re-read, because what happened is
   * the server's answer and not this screen's guess (`12`).
   */
  const onConfirmRemoval = useCallback(
    (target: RevocationTarget) => {
      const elevated = elevate();
      if (elevated === null) {
        setRemoveState('STEP_UP_REQUIRED');
        return;
      }

      setRemoveState('LOADING');
      setRemoveMessage(null);

      const request =
        target.subject === 'GRANT'
          ? elevated
              .revokeGrant(target.id)
              .then((outcome) =>
                outcome.kind === 'OK'
                  ? ({ kind: 'OK', alreadyRemoved: outcome.value.alreadyRevoked === true } as const)
                  : ({ kind: 'FAILED', outcome } as const),
              )
          : elevated.revokeInvitation(target.id).then((outcome) =>
              outcome.kind === 'OK'
                ? // An invitation has no already-revoked case: the update is conditional on it
                  // still being pending, and an accepted one is refused rather than succeeding.
                  ({ kind: 'OK', alreadyRemoved: false } as const)
                : ({ kind: 'FAILED', outcome } as const),
            );

      void request.then(
        (result) => {
          if (result.kind === 'OK') {
            setRemoveState(null);
            setRemoved({ alreadyRemoved: result.alreadyRemoved });
            reload();
            return;
          }
          setRemoveState(screenStateForFailure(result.outcome));
          // The server's own message, except for the one code whose client-safe wording is
          // shared with the acceptance path and so cannot name what to do next.
          setRemoveMessage(revocationMessage(result.outcome));
          // The one refusal where the list itself is the correction: the invitation was accepted
          // and the access now lives in a grant, so the row to act on is a different row.
          if (result.outcome.kind === 'REFUSED' && result.outcome.code === ALREADY_ACCEPTED_CODE) {
            reload();
          }
        },
        () => {
          setRemoveState('RECOVERABLE_ERROR');
          setRemoveMessage(null);
        },
      );
    },
    [elevate, reload],
  );

  const onCloseRemoval = useCallback(() => {
    setRemoving(null);
    setRemoveState(null);
    setRemoveMessage(null);
    setRemoved(null);
  }, []);

  if (removing !== null) {
    return (
      <Screen title="Care" intro="Taking access back, and what that stops.">
        <RemoveCaregiverAccess
          target={removing}
          onConfirm={onConfirmRemoval}
          onCancel={onCloseRemoval}
          state={removeState}
          stateMessage={removeMessage}
          removed={removed}
        />
      </Screen>
    );
  }

  if (inviting && activeProfileId !== null) {
    return (
      <Screen title="Care" intro="Giving somebody access, and choosing exactly what they get.">
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
      </Screen>
    );
  }

  return (
    <Screen
      title="Care"
      eyebrow={activeProfile?.displayName ?? null}
      intro="Who is in this household, who may see what, and what you can share."
      onRefresh={onRetry}
    >
      {/* Only on the list, not over a sheet. A conversation started from inside a half-filled
          invitation form would lose the form; Voice Mode has no way to put it back. */}
      <VoiceBar />

      <CaregiverAccessList
        // EMPTY and PARTIAL both render the list: EMPTY so it can say "no one else has access to
        // this profile" rather than the generic "nothing here yet" - on this screen that
        // distinction is the whole answer to the question the person came to ask - and PARTIAL
        // because the rows that did load are still worth showing.
        state={
          resource.state === 'EMPTY' || resource.state === 'PARTIAL' ? 'READY' : resource.state
        }
        rows={rows}
        onRetry={onRetry}
        // DEC-045 one level up: a caregiver who may delegate nothing is not offered the control,
        // rather than being asked to fill in a form whose only outcome is a refusal. The server
        // decides again either way.
        onInvite={
          mayInvite(authority)
            ? () => {
                setInviting(true);
              }
            : null
        }
        // Never applied locally. `12` forbids optimistic authorization changes, and a row that
        // vanishes on a failed request misstates who can read this profile - so this opens a
        // confirmation, and the list only changes when the server says it has.
        onRevoke={onRevoke}
        history={history}
      />
    </Screen>
  );
}
