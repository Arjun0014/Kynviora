/**
 * What the haptic engine asks the platform for, and on which platform it asks at all.
 *
 * Spec references: `12` (platform behaviour behind an adapter; nothing platform-specific in a
 * screen), `18` (meaning is never carried by one channel), DEC-131, DEC-139, `DEV-070`.
 *
 * WHAT THIS CAN AND CANNOT MEASURE
 * There is no motor in Node, so the question is what the engine **requested** - which is the half
 * `createRecordingHapticEngine` was written to make measurable and the half that can regress
 * silently. Whether a phone in somebody's hand actually buzzes is a device question and stays one.
 *
 * The rule worth protecting here is not the pattern itself but that "it did not work" stays
 * **distinguishable from "it happened" by pulse count**. Length alone is not distinguishable
 * through a pocket or by somebody with reduced sensation, so an escalation expressed only in
 * milliseconds is one nobody receives - and that is invisible in a diff and invisible on a screen.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HAPTIC_INTENTS } from '@kynviora/presentation';
// From the stub by path, as `PrimaryButton.test.tsx` imports its own helpers: the mobile
// typecheck resolves `react-native` to the real package's types, where none of these exist.
import {
  Platform,
  recordedVibrations,
  resetVibrations,
  setPlatformOS,
} from '../../test/reactNativeStub.js';
import { createVibrationHapticEngine } from './vibrationHaptics';

beforeEach(() => {
  resetVibrations();
  setPlatformOS('android');
});

afterEach(() => {
  setPlatformOS('android');
});

describe('on Android', () => {
  it('answers with an engine', () => {
    expect(createVibrationHapticEngine()).not.toBeNull();
  });

  it('asks the platform for something for every intent the vocabulary has', () => {
    // Looped over `HAPTIC_INTENTS` rather than listing four names, so an intent added later fails
    // here instead of shipping as a silent no-op.
    const engine = createVibrationHapticEngine();
    expect(engine).not.toBeNull();
    for (const intent of HAPTIC_INTENTS) engine?.fire(intent);
    expect(recordedVibrations()).toHaveLength(HAPTIC_INTENTS.length);
  });

  it('escalates the pulse count from "it happened" to "it did not work"', () => {
    // The property that matters, and it is an ordering rather than four distinct values.
    // `selection` and `confirm` do not need to be told apart by feel - both accompany something
    // the person just did and can see. What must be distinguishable is **something went wrong**
    // from **something happened**, and that is carried by count, because length alone is not
    // distinguishable through a pocket or by somebody with reduced sensation.
    const engine = createVibrationHapticEngine();
    const pulsesFor = (intent: (typeof HAPTIC_INTENTS)[number]): number => {
      resetVibrations();
      engine?.fire(intent);
      const pattern = recordedVibrations()[0];
      // An `[wait, buzz, …]` pattern has one pulse per pair, so the count is the length halved.
      return Array.isArray(pattern) ? pattern.length / 2 : 0;
    };
    expect(pulsesFor('selection')).toBe(1);
    expect(pulsesFor('confirm')).toBe(1);
    expect(pulsesFor('warn')).toBeGreaterThan(pulsesFor('confirm'));
    expect(pulsesFor('failure')).toBeGreaterThan(pulsesFor('warn'));
  });

  it('never asks for a pulse long enough to read as an alarm', () => {
    // `02` and `18` refuse the alarm-optimised product, and a long buzz is that product expressed
    // through the motor. Every buzz is the odd-indexed member of the pattern; the even ones are
    // waits and are not bounded by this.
    const engine = createVibrationHapticEngine();
    for (const intent of HAPTIC_INTENTS) engine?.fire(intent);
    for (const pattern of recordedVibrations()) {
      if (!Array.isArray(pattern)) continue;
      const buzzes = pattern.filter((_value, index) => index % 2 === 1);
      for (const buzz of buzzes) expect(buzz).toBeLessThanOrEqual(30);
    }
  });

  it('sends a copy, so the pattern it holds cannot be edited by the platform', () => {
    const engine = createVibrationHapticEngine();
    engine?.fire('selection');
    const first = recordedVibrations()[0];
    if (Array.isArray(first)) (first as number[])[1] = 9_999;
    resetVibrations();
    engine?.fire('selection');
    const second = recordedVibrations()[0];
    expect(second).toEqual([0, 12]);
  });
});

describe('on a platform with no engine', () => {
  it('answers null rather than substituting the wrong feeling', () => {
    // iOS's `Vibration.vibrate()` takes no duration: every call is the same full-length buzz, so a
    // `selection` tick would be that buzz on every press of every chip. `null` leaves the recording
    // engine installed, which costs a little polish and no information (DEC-131) - and iOS is
    // unverified either way, which this keeps honest rather than papering over.
    setPlatformOS('ios');
    expect(createVibrationHapticEngine()).toBeNull();
  });

  it('asks the platform for nothing at all', () => {
    setPlatformOS('ios');
    const engine = createVibrationHapticEngine();
    expect(engine).toBeNull();
    expect(recordedVibrations()).toEqual([]);
    // The branch is on the platform rather than on a capability check, so this is also the
    // assertion that the stub is being moved and the Android case above is not passing by default.
    expect(Platform.OS).toBe('ios');
  });
});
