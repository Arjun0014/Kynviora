/**
 * Haptic feedback, behind an adapter, with nothing behind the adapter yet.
 *
 * Spec references: `12` (platform behaviour behind an adapter), `18` (meaning is never carried by
 * one channel), DEC-131, `DEV-070`.
 *
 * WHAT IS AND IS NOT HERE
 * The vocabulary, the dispatcher and every call site are real. **No engine is wired**, and the
 * default implementation records what it was asked for and does nothing - the same shape
 * `recordingTransport` has for notifications under `BLK-009`, and for the same reason: an
 * interface with an honest null implementation is testable and a fabricated one is not.
 *
 * Wiring one is a single file and a rebuild. React Native's own `Vibration` needs
 * `android.permission.VIBRATE` in the merged manifest, and `expo-haptics` is a native module that
 * needs `expo prebuild` and a fresh development build. Neither is a decision to take as a side
 * effect of a design pass: a new declared permission appears on the Play listing and in the
 * Data-safety form, which is a product decision (`DEV-070`).
 *
 * THE RULE THAT MATTERS MORE THAN THE ENGINE
 * A haptic is never the report of anything. `failure` accompanies a sentence on the screen; it is
 * not the sentence. A buzz that is the only report of a refusal is a report nobody who cannot
 * feel it receives, which is `18`'s single-channel rule applied to touch - and it is why there is
 * no `error` intent that a call site could fire on its own.
 */

import type { HapticIntent } from '@kynviora/presentation';

export type { HapticIntent };

/**
 * Something that can produce a haptic.
 *
 * Takes an intent rather than a pattern, so a call site cannot ask for a motor sequence and a
 * platform can answer in its own idiom.
 */
export interface HapticEngine {
  fire(intent: HapticIntent): void;
}

/**
 * The engine this build ships with: it remembers and does nothing.
 *
 * Exported so a test can assert that the right intent was requested at the right moment, which is
 * the half of this that can be measured without hardware.
 */
export function createRecordingHapticEngine(): HapticEngine & {
  readonly fired: readonly HapticIntent[];
  reset(): void;
} {
  const fired: HapticIntent[] = [];
  return {
    fired,
    fire(intent: HapticIntent): void {
      fired.push(intent);
    },
    reset(): void {
      fired.length = 0;
    },
  };
}

let engine: HapticEngine = createRecordingHapticEngine();

/**
 * Install an engine.
 *
 * One call, at the root, when there is something to install. Deliberately a module-level swap
 * rather than a context: a haptic has no visual consequence, so nothing re-renders when it
 * changes, and threading a provider through forty components to reach four call sites would be
 * machinery with no readers.
 */
export function installHapticEngine(next: HapticEngine): void {
  engine = next;
}

/**
 * Ask for a haptic.
 *
 * Never awaited and never checked: whether the phone buzzed is not a fact any screen should
 * branch on, and a component that waited on one would be blocking a press on a motor.
 */
export function haptic(intent: HapticIntent): void {
  engine.fire(intent);
}
