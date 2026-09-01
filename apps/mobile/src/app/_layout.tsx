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
 */

import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiProvider } from '@/api/ApiProvider';
import { ProfileProvider } from '@/api/ProfileProvider';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ApiProvider>
        <ProfileProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
          </Stack>
        </ProfileProvider>
      </ApiProvider>
    </SafeAreaProvider>
  );
}
