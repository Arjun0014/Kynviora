/**
 * Telling Kynviora what time it is here (DEC-119, `DEV-030`).
 *
 * Spec references: `04` Phase 7.5 (quiet hours), `04` Phase 4.1 (a local wall clock plus a zone,
 * never an offset), `16` (data minimisation), `12` (no client-side authorization; the server
 * decides).
 *
 * WHY THE DEVICE REPORTS IT
 * Because the device is the only thing that knows. A server can guess from an IP address, which is
 * wrong for anybody on a VPN and is a location lookup nobody consented to; a person can be asked,
 * which is a settings screen for a value their phone already has correct.
 *
 * WHAT IS SENT
 * An IANA zone name and nothing else. Not a location, not an offset, not a coordinate. A zone is
 * coarse - hundreds of millions of people share one - and it is sent for one stated purpose, which
 * is deciding whether a notification waits until morning.
 *
 * WHEN
 * Once per app lifetime, and again whenever the zone changes while the app is running - which is
 * what a flight looks like from in here. Not on every render and not on a timer: the value changes
 * rarely, and a request per foreground would be a request per foreground for nothing.
 *
 * WHAT IT DOES WHEN IT FAILS
 * Nothing, quietly. A failed report leaves the stored zone as it was, and an unknown zone means
 * quiet hours do not hold - so the failure mode is a notification arriving that might have waited,
 * which is the direction `DEV-030` chose deliberately. There is no screen for this and no error to
 * show: a person did not ask for it and cannot act on it.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useApi } from '@/api/ApiProvider';

/**
 * The zone this device believes it is in, or `null`.
 *
 * `resolvedOptions().timeZone` is what the platform says; an environment without a zone database
 * answers something unusable, and `null` is the honest reading of that rather than a string the
 * server will refuse.
 */
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.trim() !== '' ? zone : null;
  } catch {
    return null;
  }
}

export function TimeZoneReporter({ children }: { readonly children: ReactNode }) {
  const { client } = useApi();
  /** The last value successfully sent, so an unchanged zone costs no request. */
  const reported = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (client === null) return;

    const report = (): void => {
      const zone = deviceTimeZone();
      if (reported.current === zone) return;

      void client.reportTimeZone(zone).then(
        (outcome) => {
          // Recorded only on success, so a failed report is retried on the next foreground rather
          // than being remembered as done.
          if (outcome.kind === 'OK') reported.current = zone;
        },
        () => {
          // Deliberately swallowed. See the module note: there is nothing a person could do with
          // this, and the failure leaves quiet hours not holding, which is the safe direction.
        },
      );
    };

    report();

    // A zone changes when somebody flies, and from in here that looks like the app returning to
    // the foreground somewhere else. Checked on every return rather than subscribed to, because
    // React Native has no zone-change event and the check is a string comparison.
    const subscription = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') report();
    });
    return () => {
      subscription.remove();
    };
  }, [client]);

  return <>{children}</>;
}
