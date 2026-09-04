/**
 * The privacy-leakage and platform judgements, run with nothing attached (DEC-102).
 *
 * Three of these are absence tests, which is the shape that passes for the wrong reason more often
 * than any other: an empty capture, a run that never opened a screen, or a link that never started
 * the app all produce a clean result about nothing. Each has a control, and the controls are what
 * most of this file is about.
 */

import { describe, expect, it } from 'vitest';
import {
  KNOWN_COMPONENTS,
  appLogCheck,
  captureControlCheck,
  componentSurfaceCheck,
  deepLinkCheck,
  leaksIn,
  systemLogCheck,
  withoutInstrumentation,
  type SensitiveStrings,
} from './privacyLeakage.js';

const STRINGS: SensitiveStrings = {
  medicineNames: ['Synthetic Tablet A', 'Synthetic Capsule B'],
  profileName: 'Parent (synthetic)',
  doseNote: 'privacy run 4F2A',
};

describe('what counts as a leak', () => {
  it('finds a medicine name anywhere in a line', () => {
    const found = leaksIn(
      ['I ReactNative: response {"displayName":"Synthetic Tablet A"}'],
      STRINGS,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.value).toBe('Synthetic Tablet A');
  });

  it('does not treat an identifier as content', () => {
    // `20` asks for a correlation ID on a log line and `16` distinguishes the two kinds of thing.
    // A check that flagged identifiers would make the useful half of logging unreportable.
    expect(
      leaksIn(['I kynviora: api.dose_event_failed correlation_id=7c9f-...'], STRINGS),
    ).toHaveLength(0);
  });

  it('removes the instrumentation that only exists because the run is happening', () => {
    // `uiautomator dump` writes every visible view to logcat, medicine names included. The first
    // version of this measurement found 204 such lines and none of them were the app's.
    const lines = [
      'I AccessibilityNodeInfoDumper: Skipping invisible child: ... text: Synthetic Tablet A; ...',
      'W unknown:BridgelessReact: ReactHost{0}.onHostResume()',
    ];
    const kept = withoutInstrumentation(lines);
    expect(kept).toHaveLength(1);
    expect(leaksIn(kept, STRINGS)).toHaveLength(0);
  });
});

describe('PRIV-0, the control', () => {
  it('is inconclusive when the capture is empty', () => {
    // An absence test over an empty input passes trivially, so this has to stop the run rather
    // than let three clean results be reported about nothing.
    const check = captureControlCheck({ appLines: [], driven: true });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('empty');
  });

  it('is inconclusive when the screens were never opened', () => {
    // A run that never reached the shelf never asked the app to handle a medicine, so a clean log
    // is a statement about the run (trap 195's shape).
    const check = captureControlCheck({ appLines: ['W ReactNative: something'], driven: false });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('passes when the app wrote something and the screens were driven', () => {
    expect(
      captureControlCheck({ appLines: ['W ReactNative: something'], driven: true }).status,
    ).toBe('PASS');
  });
});

describe('PRIV-1, what the app wrote', () => {
  it('fails on a medicine name in the app’s own log', () => {
    const check = appLogCheck({
      appLines: ['I ReactNativeJS: loaded Synthetic Tablet A'],
      strings: STRINGS,
    });
    expect(check.status).toBe('FAIL');
    // The reason matters as much as the finding: the log is outside every storage guarantee.
    expect(check.detail).toContain('keystore');
  });

  it('fails on a note somebody typed during the run', () => {
    // Included because the seed's names could conceivably be in a bundle string; a note written
    // minutes ago can only have come from the running app handling somebody's input.
    const check = appLogCheck({
      appLines: ['I ReactNativeJS: body={"note":"privacy run 4F2A"}'],
      strings: STRINGS,
    });
    expect(check.status).toBe('FAIL');
  });

  it('passes over ordinary framework noise', () => {
    expect(
      appLogCheck({
        appLines: [
          'W unknown:BridgelessReact: ReactHost{0}.onHostPause(activity)',
          'W unknown:BridgelessReact: ReactHost{0}.ReactContext.onHostResume()',
        ],
        strings: STRINGS,
      }).status,
    ).toBe('PASS');
  });
});

describe('PRIV-2, what anything else wrote', () => {
  it('fails when another process carried it', () => {
    // The app's own pid is not the whole question: a crash reporter or a system service handed a
    // string is the same exposure by a different route.
    const check = systemLogCheck({
      systemLines: ['E AndroidRuntime: at render(Synthetic Capsule B)'],
      instrumentationLines: 0,
      strings: STRINGS,
    });
    expect(check.status).toBe('FAIL');
  });

  it('passes and says how much instrumentation it removed', () => {
    // Reported rather than silently dropped, because "clean" over a log that was mostly filtered
    // away is a different claim from "clean".
    const check = systemLogCheck({
      systemLines: ['I ActivityTaskManager: START u0 com.kynviora.app/.MainActivity'],
      instrumentationLines: 204,
      strings: STRINGS,
    });
    expect(check.status).toBe('PASS');
    expect(check.detail).toContain('204');
  });
});

describe('PLAT-1, the package’s surface', () => {
  it('fails on a component nobody here decided to expose', () => {
    const check = componentSurfaceCheck({
      components: [...KNOWN_COMPONENTS, 'com.kynviora.app/com.example.SomeExportedActivity'],
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('SomeExportedActivity');
  });

  it('is inconclusive when a known component has gone missing', () => {
    // Not a pass. The list and the package having drifted means an unexpected component could be
    // hiding behind a stale expectation, which is the failure this check exists to prevent.
    const check = componentSurfaceCheck({ components: KNOWN_COMPONENTS.slice(1) });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('passes over exactly the known set', () => {
    expect(componentSurfaceCheck({ components: [...KNOWN_COMPONENTS] }).status).toBe('PASS');
  });

  it('lists the launcher activity as the only component this project wrote', () => {
    const ours = KNOWN_COMPONENTS.filter(
      (component) => !/androidx|firebase|expo\.modules/i.test(component),
    );
    expect(ours).toEqual(['com.kynviora.app/.MainActivity']);
  });
});

describe('PLAT-2, what a link can decide', () => {
  const SHELF = ['Synthetic Tablet A', 'Synthetic Capsule B'];

  it('is inconclusive when the link never started the app', () => {
    // The control. A link that does nothing decides nothing, and an unchanged shelf would report
    // that as the property holding.
    const check = deepLinkCheck({
      runningBefore: false,
      opened: false,
      ordinary: SHELF,
      afterLink: SHELF,
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('is inconclusive when the app was already running', () => {
    const check = deepLinkCheck({
      runningBefore: true,
      opened: true,
      ordinary: SHELF,
      afterLink: SHELF,
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('is inconclusive when the ordinary launch showed nothing to compare', () => {
    const check = deepLinkCheck({
      runningBefore: false,
      opened: true,
      ordinary: [],
      afterLink: [],
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('fails when the link changed which medicines were shown', () => {
    const check = deepLinkCheck({
      runningBefore: false,
      opened: true,
      ordinary: SHELF,
      afterLink: ['Somebody Else’s Tablet'],
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('decided which person');
  });

  it('passes when the link started the app and changed nothing', () => {
    const check = deepLinkCheck({
      runningBefore: false,
      opened: true,
      ordinary: SHELF,
      // Same set, different order - the shelf's order is not what is being measured.
      afterLink: [...SHELF].reverse(),
    });
    expect(check.status).toBe('PASS');
  });
});
