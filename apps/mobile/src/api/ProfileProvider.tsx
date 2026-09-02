/**
 * Which profile the app is looking at.
 *
 * Spec references: `13` ("Never trust a profile ID in the request as proof of access"), `14`
 * (deny by default), `16` (a caregiver relationship is not a licence to see everything).
 *
 * WHY THE LIST COMES FROM THE SERVER AND IS NEVER TYPED IN
 * `GET /v1/profiles` accepts no profile ID and returns exactly what row-level security admits.
 * That makes the selectable set the authorised set by construction: there is no code path in this
 * app that can name a profile the server did not first offer. A stored "last used profile" that
 * survived a revoked caregiver grant would be exactly such a path, which is why the selection is
 * held in memory and re-derived from the server's list on every launch rather than persisted.
 *
 * Selecting a profile still grants nothing. Every request carries it as a filter and the server
 * applies RLS regardless, so a stale selection produces an empty screen rather than someone
 * else's data.
 *
 * THE LIST IS KEPT ON THE DEVICE; THE SELECTION IS STILL NOT
 * `03` group J requires a basic profile summary to survive being offline, and without one the
 * shelf cannot be read offline either - every shelf request is keyed on a profile ID. So the
 * server's answer is written to the encrypted projection and read back on a cold launch, where
 * it arrives as `STALE`. What has not changed is that the selection is still derived from a list
 * rather than stored: the app cannot name a profile that was never in a list the server sent.
 * And `15` A2's fourth mitigation is what makes the copy safe to hold - the next authenticated
 * read that comes back as an access failure deletes the row rather than labelling it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ProfileSummary, Resource } from '@kynviora/contracts';
import { useApi } from './ApiProvider';
import { useResource } from './useResource';

export interface ProfileContextValue {
  readonly resource: Resource<{ readonly profiles: readonly ProfileSummary[] }>;
  readonly profiles: readonly ProfileSummary[];
  /** `null` until the server has offered at least one. Never invented locally. */
  readonly activeProfileId: string | null;
  readonly activeProfile: ProfileSummary | null;
  select(profileId: string): void;
  reload(): void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { readonly children: ReactNode }) {
  const { client } = useApi();
  const [selected, setSelected] = useState<string | null>(null);

  const load = useMemo(() => (client === null ? null : () => client.listProfiles()), [client]);

  const { resource, reload } = useResource(load, {
    isEmpty: (value) => value.profiles.length === 0,
    // The request takes no parameters, so the key needs nothing but its name - the session is
    // added by the store.
    projectionKey: 'profiles',
  });

  const profiles = resource.value?.profiles ?? [];

  // Default to the first profile the server offered, and drop a selection the server no longer
  // offers - a caregiver grant can be revoked between launches, and the selection must follow
  // the server rather than outlive it.
  useEffect(() => {
    if (profiles.length === 0) {
      if (selected !== null) setSelected(null);
      return;
    }
    if (selected === null || !profiles.some((profile) => profile.id === selected)) {
      setSelected(profiles[0]?.id ?? null);
    }
  }, [profiles, selected]);

  const select = useCallback((profileId: string) => {
    setSelected(profileId);
  }, []);

  const value = useMemo<ProfileContextValue>(
    () => ({
      resource,
      profiles,
      activeProfileId: selected,
      activeProfile: profiles.find((profile) => profile.id === selected) ?? null,
      select,
      reload,
    }),
    [resource, profiles, selected, select, reload],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfiles(): ProfileContextValue {
  const context = useContext(ProfileContext);
  if (context === null) {
    throw new Error('useProfiles was called outside ProfileProvider.');
  }
  return context;
}
