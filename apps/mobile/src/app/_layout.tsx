/**
 * Root layout.
 *
 * Spec 06 defines five primary destinations: Today, Shelf, Safety, Care, You. Scan/add is an
 * action available from Today and Shelf, deliberately not a sixth destination.
 *
 * The API client and the profile list are provided here rather than per screen, so that every
 * route sees the same session and the same authorised profile set. `13` requires authority to
 * come from the session rather than from a profile ID in a request, and one provider at the root
 * is what makes "which profile am I looking at" a single answer instead of a per-screen guess.
 *
 * The encrypted local store is opened here for the same reason: `12` requires one projection per
 * install, keyed to the identity that filled it, and a store opened per screen would be several
 * connections to one SQLCipher file racing each other's schema creation.
 *
 * The reminder engine is mounted here rather than on a screen because `04` Phase 4.2 requires
 * reminders to survive the app being killed and the device restarting. A sync that only ran when
 * somebody opened a particular tab would stop extending the horizon the moment they stopped
 * visiting it, and the person would find out by not being reminded.
 */

import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiProvider } from '@/api/ApiProvider';
import { ProfileProvider } from '@/api/ProfileProvider';
import { ProjectionProvider } from '@/storage/ProjectionProvider';
import { ReminderProvider } from '@/reminders/ReminderProvider';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ApiProvider>
        {/* Inside the API provider because the store is scoped to the identity that filled it,
            and outside the profile provider because the profile list is one of the things kept
            (`03` group J). */}
        <ProjectionProvider>
          <ProfileProvider>
            {/* Inside the profile provider because reminders are planned for the profile being
                looked at, and inside the projection provider because a device with no signal
                still has to be reminded - it re-plans from the last response the store kept
                (`03` group J, `04` Phase 4.2). */}
            <ReminderProvider>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(tabs)" />
              </Stack>
            </ReminderProvider>
          </ProfileProvider>
        </ProjectionProvider>
      </ApiProvider>
    </SafeAreaProvider>
  );
}
