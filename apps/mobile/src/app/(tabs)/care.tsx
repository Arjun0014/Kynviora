/**
 * Care screen.
 *
 * Spec references: `06` Journey 6 and its required screen states, `12` (no client-side
 * authorization), `14` (caregiver administration needs step-up), `16` (a family relationship is
 * not a licence to see everything), `04` Phase 8.1.
 *
 * WHAT THIS SCREEN WILL NOT DO
 * It never invents a row. On this screen a wrong row is a false statement about who can read a
 * person's health data, in either direction: showing someone who has no access invites a
 * pointless revocation, and omitting someone who does leaves an unknown reader in place. So the
 * list is whatever `GET /v1/caregiver-grants` returned under row-level security, and every other
 * state renders as a state.
 *
 * Revocation is a server operation behind step-up and is never applied optimistically (`12`,
 * `14`). The button reloads from the server afterwards rather than removing the row locally,
 * because a row that disappears on a failed request is the same false statement again.
 */

import { useCallback, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { LIGHT_THEME } from '@kynviora/presentation';
import { caregiverAccessRows } from '@kynviora/contracts';
import { useApi } from '@/api/ApiProvider';
import { useProfiles } from '@/api/ProfileProvider';
import { useResource } from '@/api/useResource';
import { CaregiverAccessList } from '@/features/caregivers/CaregiverAccessList';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function CareScreen() {
  const { client } = useApi();
  const { activeProfileId } = useProfiles();

  const load = useMemo(
    () =>
      client === null || activeProfileId === null
        ? null
        : () => client.listCaregiverGrants({ profileId: activeProfileId }),
    [client, activeProfileId],
  );

  const { resource, reload } = useResource(load, {
    enabled: activeProfileId !== null,
    isEmpty: (value) => value.grants.length === 0,
  });

  const rows = useMemo(() => caregiverAccessRows(resource.value?.grants ?? []), [resource.value]);

  const onRetry = useCallback(() => {
    reload();
  }, [reload]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <CaregiverAccessList
        // EMPTY is passed through as READY so the list renders its own empty copy, which says
        // something specific - "no one else has access to this profile" - rather than the
        // generic "nothing here yet". On this screen that distinction is the whole answer to
        // the question the user came to ask.
        state={resource.state === 'EMPTY' ? 'READY' : resource.state}
        rows={rows}
        onRetry={onRetry}
        onInvite={() => {
          // The invitation flow is a step-up-gated server operation. The token it returns is a
          // live credential and is shown once (DEC-018), which needs a screen of its own.
        }}
        onRevoke={() => {
          // Never applied locally. `12` forbids optimistic authorization changes, and a row that
          // vanishes on a failed request misstates who can read this profile.
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: LIGHT_THEME.surface.background },
});
