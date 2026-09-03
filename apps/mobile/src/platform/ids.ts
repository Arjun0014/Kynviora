/**
 * The one place this app asks the platform for a random identifier.
 *
 * Spec references: `07` (identifiers must be non-guessable), `13` (an idempotency key on a
 * mutation that can be retried), `12` (a queued operation's ID *is* its idempotency key),
 * `DEV-043`.
 *
 * WHY THIS FILE EXISTS AT ALL
 * Every call site used to read the global `crypto`, which typechecks under `lib: ["DOM"]` and
 * does not exist on Hermes. The result was that **no write needing an idempotency key had ever
 * worked on a device**: creating a schedule, recording a dose, adding a medicine, creating a
 * household or profile, exporting a Visit Pack and queueing an offline edit all threw
 * `Property 'crypto' doesn't exist` at the moment the person pressed Save. Nothing caught it,
 * because `apps/**` is outside the test run and outside the lint run (trap 164), and the mobile
 * typecheck was being told by Expo's base config that a phone is a browser.
 *
 * The typecheck now runs with no DOM and no Node globals (`tsconfig.json`), so reaching for an
 * ambient `crypto` is a compile error rather than a crash somebody has to reproduce on hardware.
 * This module is what the compiler leaves as the way through, and it is deliberately the only
 * one: a second binding is a second thing to get wrong on a platform nobody typechecks against.
 *
 * WHY `expo-crypto` AND NOT A UUID LIBRARY
 * `07` wants an identifier nobody can guess, and `expo-crypto` is backed by the platform's own
 * secure random source - the same module `secureDatabase.ts` derives the SQLCipher key with. A
 * `Math.random()` UUID has the right shape and none of the property that matters.
 */

import { randomUUID } from 'expo-crypto';

/**
 * A fresh idempotency key for one intent.
 *
 * Call this **once per intent, not once per attempt**. `13` puts the key on the request so that a
 * retry of a save lands once; a key regenerated on retry is not an idempotency key, and on
 * `medicine_schedule` a second row is not a duplicate on a list - it is being told twice, at the
 * same minute, to take the same tablet. The offline journal keeps the key the failed attempt used
 * for exactly this reason (DEC-111), so a key made here may be replayed tomorrow.
 */
export function newIdempotencyKey(): string {
  return randomUUID();
}
