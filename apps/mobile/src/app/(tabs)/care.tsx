/**
 * Care screen.
 *
 * Spec references: `06` Journey 6 and the required screen states, `12` (repository behaviour, no
 * client-side authorization), `04` Phase 8.1.
 *
 * The caregiver access list is wired to a repository that does not exist yet, so this screen
 * renders the `loading` state rather than fabricating rows. `06` requires every critical route to
 * define its loading, empty, offline and error states, and showing invented caregivers would be
 * worse than showing none: on this screen a wrong row is a false statement about who can see a
 * person's health data.
 *
 * The list component itself is complete and typechecks against the real API contract; wiring it
 * to the network layer is the remaining work (see `IMPLEMENTATION_PLAN.md`, Phase 8.1 follow-up).
 */

import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LIGHT_THEME } from '@kynviora/presentation';
import {
  CaregiverAccessList,
  type CaregiverAccessRow,
} from '@/features/caregivers/CaregiverAccessList';

export default function CareScreen() {
  // No rows are invented while the repository is unwired. A caregiver list that shows people who
  // do not have access - or omits people who do - misinforms the person deciding whether to
  // remove someone.
  const rows: readonly CaregiverAccessRow[] = [];

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <CaregiverAccessList
        state="loading"
        rows={rows}
        onInvite={() => {
          // Navigation to the invite flow lands with the repository wiring.
        }}
        onRevoke={() => {
          // Revocation is a server operation behind step-up (`14`); the client never applies it
          // optimistically (`12`).
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: LIGHT_THEME.surface.background },
});
