/**
 * The engine behind the haptic adapter: React Native's own `Vibration`, on Android only.
 *
 * Spec references: `12` (platform behaviour behind an adapter; a platform this build has not run
 * on is not claimed), `18` (meaning is never carried by one channel), DEC-131, DEC-139, `DEV-070`.
 *
 * WHY THIS COULD BE WIRED, HAVING BEEN BLOCKED
 * `DEV-070` recorded the blocker as a manifest change: React Native's `Vibration` needs
 * `android.permission.VIBRATE`, a newly declared permission appears on the Play listing and in the
 * Data-safety form, and that is a product decision rather than something to take as a side effect
 * of a styling pass. The premise turned out to be false. `VIBRATE` is **already** declared - the
 * merger report attributes it to the app's own manifest, `expo-notifications` puts it there, and
 * `dumpsys package com.kynviora.app` lists it among the requested permissions of the build that is
 * installed right now. So nothing here adds a permission, a dependency or a prebuild step; the
 * declaration this was waiting on has been shipping since the first build.
 *
 * `VIBRATE` is a normal permission. It is granted at install and there is no runtime prompt, which
 * is why `verify:device:camera` has nothing to say about it and why it is not one of the eight
 * `CAM-3` counts.
 *
 * WHY iOS GETS NOTHING RATHER THAN SOMETHING
 * `Vibration.vibrate()` on iOS does not take a duration. Every call is the same full-length buzz,
 * and a `selection` tick - the most frequent intent by far - would be that buzz on every press of
 * every filter chip. iOS's actual answer is `UIImpactFeedbackGenerator`, which is a native module
 * this build does not have. So the adapter answers "no engine on this platform" rather than
 * substituting the wrong one: an absent haptic costs a little polish and nothing else (DEC-131),
 * and a wrong one is a product somebody turns off in settings. iOS is unverified either way
 * (`docs/design/DESIGN_SYSTEM.md` section 12) and this keeps the honest half of that true.
 *
 * WHY THE PATTERNS ARE SHORT AND WHY THEY ESCALATE BY COUNT
 * One pulse for a thing that happened, two for something to look at, three for something that did
 * not work. Count rather than length, because length alone is not distinguishable through a pocket
 * or by somebody with reduced sensation - and a long buzz reads as an alarm, which is the product
 * `02` and `18` refuse. Nothing here is over 30ms per pulse.
 *
 * `selection` and `confirm` are both one pulse and are **not** meant to be told apart by feel.
 * Both accompany something the person just did and can see; what has to be distinguishable is
 * "something went wrong" from "something happened", which is what the escalation carries. The two
 * differ in weight rather than in count, which is a nicety and is not load-bearing.
 *
 * WHAT THIS STILL IS NOT
 * A report. Every call site fires a haptic **beside** a sentence that is already on the screen or
 * already spoken, never instead of one - `18`'s single-channel rule applied to touch, and the
 * reason there is no `error` intent for a call site to reach for.
 */

import { Platform, Vibration } from 'react-native';
import type { HapticIntent } from '@kynviora/presentation';
import type { HapticEngine } from './haptics';

/**
 * What each intent feels like, as Android's `[wait, buzz, wait, buzz, …]` pattern.
 *
 * An array rather than a bare number even for the single pulses, because a number and an array
 * mean different things to `Vibration.vibrate` and one shape for all four is one thing to be wrong
 * about instead of two.
 */
const PATTERN: Readonly<Record<HapticIntent, readonly number[]>> = Object.freeze({
  /** A tick. A filter chip, a radio, a tab - the lightest thing the motor can say. */
  selection: [0, 12],
  /** One pulse: something you asked for happened, and the screen says what. */
  confirm: [0, 24],
  /** Two: there is something to look at. Never an alarm - `02` refuses the alarm-optimised app. */
  warn: [0, 20, 90, 20],
  /** Three: it did not work. The sentence saying why is already on the screen (DEC-131). */
  failure: [0, 24, 90, 24, 90, 24],
});

/**
 * The Android engine, or `null` on every other platform.
 *
 * `null` rather than a no-op engine, so the caller installs nothing and
 * `createRecordingHapticEngine` stays in place - which keeps the tests that assert call sites
 * measuring the same thing on every platform.
 */
export function createVibrationHapticEngine(): HapticEngine | null {
  if (Platform.OS !== 'android') return null;
  return {
    fire(intent: HapticIntent): void {
      // Never awaited and never checked (`haptics.ts`): whether the phone buzzed is not a fact any
      // screen should branch on. `repeat` is left at its default of `false` - a repeating pattern
      // would keep going until something cancelled it, and a haptic nobody can stop is an alarm.
      Vibration.vibrate([...PATTERN[intent]]);
    },
  };
}
