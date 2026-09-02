import { describe, it, expect } from 'vitest';
import { MIN_TOUCH_TARGET_DP } from '@kynviora/presentation';
import {
  accessibleNameOf,
  checkScreen,
  isInteractiveTarget,
  clipRectsOf,
  crashedApp,
  isFullyVisible,
  parseUiHierarchy,
  sizeInDp,
  type UiNode,
} from './accessibility.js';
import { overallStatus } from './analysis.js';

/** The emulator this was first run against: a Pixel 7 at 420dpi, so 2.625 device pixels per dp. */
const DENSITY = 420;

const PACKAGE = 'com.kynviora.app';

function node(attributes: Record<string, string>): string {
  const merged = {
    class: 'android.view.View',
    package: PACKAGE,
    clickable: 'true',
    enabled: 'true',
    ...attributes,
  };
  const rendered = Object.entries(merged)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  return `<node ${rendered} />`;
}

/**
 * A box of a given dp size at 420dpi, placed away from every screen edge.
 *
 * The offset is the point. `uiautomator` reports visible bounds, so a node touching a clipping
 * edge may have been cut there - and the checks treat such a node as unmeasured. A fixture at the
 * origin would be testing that path rather than the one it names.
 */
function boundsFor(widthDp: number, heightDp: number, leftPx = 40, topPx = 400): string {
  const scale = DENSITY / 160;
  return (
    `[${String(leftPx)},${String(topPx)}]` +
    `[${String(leftPx + Math.round(widthDp * scale))},${String(topPx + Math.round(heightDp * scale))}]`
  );
}

/**
 * A dump with a root frame around the nodes.
 *
 * The root is what `clipRectsOf` treats as the screen edge, so a test that left it out would be
 * measuring against no clip rectangle at all - which is not the shape a real dump has.
 */
function hierarchy(...nodes: string[]): string {
  const root = node({
    class: 'android.widget.FrameLayout',
    clickable: 'false',
    bounds: '[0,0][1080,2400]',
  });
  return `<?xml version='1.0'?><hierarchy rotation="0">${root}${nodes.join('')}</hierarchy>`;
}

/** The node a fixture is about, which is the one after the root frame. */
function subject(xml: string): UiNode | undefined {
  return parseUiHierarchy(xml).at(-1);
}

describe('reading a uiautomator dump', () => {
  it('reads the attributes each check depends on', () => {
    const parsed = subject(
      hierarchy(
        node({
          class: 'android.widget.TextView',
          text: 'Open this item',
          'content-desc': '',
          bounds: boundsFor(200, 48),
        }),
      ),
    );
    expect(parsed?.className).toBe('android.widget.TextView');
    expect(parsed?.text).toBe('Open this item');
    expect(parsed?.clickable).toBe(true);
    expect(parsed?.bounds.right).toBe(565);
  });

  it('ignores a node with no bounds rather than inventing them', () => {
    // A parser that defaulted a missing rectangle to zero would report every such node as a
    // control too small to press, which is a finding nobody can act on.
    expect(parseUiHierarchy('<node class="x" clickable="true" />')).toHaveLength(0);
  });

  it('reads nothing out of markup it does not recognise', () => {
    expect(parseUiHierarchy('<not-a-hierarchy />')).toHaveLength(0);
  });
});

describe('which nodes are worth judging', () => {
  const parse = subject;

  it('counts an enabled clickable node with area', () => {
    const parsed = parse(hierarchy(node({ bounds: boundsFor(48, 48) })));
    expect(parsed !== undefined && isInteractiveTarget(parsed)).toBe(true);
  });

  it('skips a disabled control', () => {
    // Not a target somebody is expected to hit.
    const parsed = parse(hierarchy(node({ enabled: 'false', bounds: boundsFor(20, 20) })));
    expect(parsed !== undefined && isInteractiveTarget(parsed)).toBe(false);
  });

  it('skips a node the layout has not placed', () => {
    const parsed = parse(hierarchy(node({ bounds: '[0,0][0,0]' })));
    expect(parsed !== undefined && isInteractiveTarget(parsed)).toBe(false);
  });

  it('skips a node that is not clickable', () => {
    const parsed = parse(hierarchy(node({ clickable: 'false', bounds: boundsFor(10, 10) })));
    expect(parsed !== undefined && isInteractiveTarget(parsed)).toBe(false);
  });
});

describe('the accessible name', () => {
  const parse = subject;

  it('prefers the content description, which is what a screen reader announces', () => {
    const parsed = parse(
      hierarchy(
        node({
          text: 'On',
          'content-desc': 'Not yet confirmed filter, on.',
          bounds: boundsFor(48, 48),
        }),
      ),
    );
    expect(parsed !== undefined && accessibleNameOf(parsed)).toBe('Not yet confirmed filter, on.');
  });

  it('falls back to the visible text', () => {
    const parsed = parse(hierarchy(node({ text: 'Open this item', bounds: boundsFor(48, 48) })));
    expect(parsed !== undefined && accessibleNameOf(parsed)).toBe('Open this item');
  });

  it('treats whitespace as no name at all', () => {
    const parsed = parse(hierarchy(node({ text: '   ', bounds: boundsFor(48, 48) })));
    expect(parsed !== undefined && accessibleNameOf(parsed)).toBe('');
  });
});

describe('measuring a target', () => {
  it('converts screen pixels to dp at the device density', () => {
    const parsed = subject(hierarchy(node({ bounds: boundsFor(48, 48) })));
    const size = parsed === undefined ? null : sizeInDp(parsed, DENSITY);
    expect(size?.width).toBeCloseTo(48, 0);
    expect(size?.height).toBeCloseTo(48, 0);
  });
});

describe('the screen checks', () => {
  const base = {
    label: 'Shelf',
    packageName: PACKAGE,
    densityDpi: DENSITY,
    fontScale: 1,
    minimumTouchTargetDp: MIN_TOUCH_TARGET_DP,
  };

  it('are inconclusive rather than passing when nothing was captured', () => {
    expect(overallStatus(checkScreen({ ...base, xml: null }))).toBe('INCONCLUSIVE');
  });

  it('are inconclusive rather than passing when the screen has no controls', () => {
    // The pass is "no control is too small", which an empty screen satisfies trivially. A blank
    // capture is the ordinary way this harness would silently stop testing anything.
    expect(overallStatus(checkScreen({ ...base, xml: hierarchy() }))).toBe('INCONCLUSIVE');
  });

  it('pass a screen whose controls are large enough and named', () => {
    const xml = hierarchy(
      node({ text: 'Open this item', bounds: boundsFor(300, 48) }),
      node({ 'content-desc': 'Not yet confirmed filter, off.', bounds: boundsFor(160, 48) }),
    );
    expect(overallStatus(checkScreen({ ...base, xml }))).toBe('PASS');
  });

  it('fail a control that is under the minimum in one direction only', () => {
    // Height is where font scaling breaks a row first, so a check on area or on the larger side
    // would pass exactly the regression it exists to catch.
    const xml = hierarchy(node({ text: 'Save', bounds: boundsFor(300, 40) }));
    const checks = checkScreen({ ...base, xml });
    expect(checks.find((check) => check.id === 'A11Y-2')?.status).toBe('FAIL');
    expect(checks.find((check) => check.id === 'A11Y-2')?.detail).toContain('Save');
  });

  it('allow a half-dp of rounding', () => {
    // `uiautomator` reports whole pixels, so a 48dp target at 2.625x lands on 126 exactly - but a
    // one-pixel rounding elsewhere must not read as a violation.
    const scale = DENSITY / 160;
    const almost = Math.round(48 * scale) - 1;
    const xml = hierarchy(
      node({
        text: 'Save',
        bounds: `[40,400][${String(40 + almost)},${String(400 + almost)}]`,
      }),
    );
    expect(checkScreen({ ...base, xml }).find((check) => check.id === 'A11Y-2')?.status).toBe(
      'PASS',
    );
  });

  it('fail a control a screen reader would announce as nothing', () => {
    const xml = hierarchy(node({ class: 'android.view.ViewGroup', bounds: boundsFor(300, 48) }));
    const checks = checkScreen({ ...base, xml });
    expect(checks.find((check) => check.id === 'A11Y-3')?.status).toBe('FAIL');
  });

  it('name the font scale in every detail, because that is what the run was about', () => {
    const xml = hierarchy(node({ text: 'Save', bounds: boundsFor(300, 48) }));
    const checks = checkScreen({ ...base, xml, fontScale: 2 });
    expect(checks.every((check) => check.detail.includes('font scale 2'))).toBe(true);
  });
});

describe('a control that is only partly on screen', () => {
  // The finding that made this exist: the shelf's "Open this item" sat at the bottom of a
  // ScrollView whose bounds were [0,304][1080,2145], and `uiautomator` reported the button as
  // 354x40dp because that is how much of it was visible. Measuring that as its size invents a
  // 48dp violation out of a button that is simply scrolled.
  const scroller = node({
    class: 'android.widget.ScrollView',
    clickable: 'false',
    scrollable: 'true',
    bounds: '[0,304][1080,2145]',
  });

  const clipped = node({ text: 'Open this item', bounds: '[76,2040][1004,2145]' });
  const whole = node({ text: 'Add a medicine', bounds: '[42,653][1038,782]' });

  const base = {
    label: 'Shelf',
    packageName: PACKAGE,
    densityDpi: DENSITY,
    fontScale: 1,
    minimumTouchTargetDp: MIN_TOUCH_TARGET_DP,
  };

  it('is recognised by an edge that coincides with a scroll container', () => {
    const nodes = parseUiHierarchy(hierarchy(scroller, clipped, whole));
    const clips = clipRectsOf(nodes);
    const [, , cut, full] = nodes;
    expect(cut !== undefined && isFullyVisible(cut, clips)).toBe(false);
    expect(full !== undefined && isFullyVisible(full, clips)).toBe(true);
  });

  it('is not counted as a control that is too small', () => {
    const checks = checkScreen({ ...base, xml: hierarchy(scroller, clipped, whole) });
    const size = checks.find((check) => check.id === 'A11Y-2');
    expect(size?.status).toBe('PASS');
    expect(size?.detail).toContain('1 more were cut off and not measured');
  });

  it('is still judged on whether a screen reader could announce it', () => {
    // Naming has nothing to do with geometry, so being scrolled is no excuse for being silent.
    const anonymous = node({
      class: 'android.widget.LinearLayout',
      bounds: '[76,2040][1004,2145]',
    });
    const checks = checkScreen({ ...base, xml: hierarchy(scroller, anonymous, whole) });
    expect(checks.find((check) => check.id === 'A11Y-3')?.status).toBe('FAIL');
  });

  it('leaves the size check inconclusive when nothing at all could be measured', () => {
    // Rather than passing. Every control cut off is not evidence that they are big enough.
    const checks = checkScreen({ ...base, xml: hierarchy(scroller, clipped) });
    expect(checks.find((check) => check.id === 'A11Y-2')?.status).toBe('INCONCLUSIVE');
  });
});

describe('another app on the screen', () => {
  // TalkBack draws its own chrome, and its first run puts a tutorial dialog on top. Two unnamed
  // `LinearLayout`s from it were reported as Kynviora failing `18` until this filter existed.
  const base = {
    label: 'You',
    packageName: PACKAGE,
    densityDpi: DENSITY,
    fontScale: 1,
    minimumTouchTargetDp: MIN_TOUCH_TARGET_DP,
  };

  it('is not this app’s finding', () => {
    const xml = hierarchy(
      node({ text: 'Save', bounds: boundsFor(300, 48) }),
      node({
        class: 'android.widget.LinearLayout',
        package: 'com.google.android.marvin.talkback',
        bounds: boundsFor(300, 20, 40, 900),
      }),
    );
    expect(overallStatus(checkScreen({ ...base, xml }))).toBe('PASS');
  });

  it('does not make a screen look inspected when only it is present', () => {
    const xml = hierarchy(
      node({
        class: 'android.widget.LinearLayout',
        package: 'com.google.android.marvin.talkback',
        bounds: boundsFor(300, 48),
      }),
    );
    expect(overallStatus(checkScreen({ ...base, xml }))).toBe('INCONCLUSIVE');
  });
});

describe('whose crash it was', () => {
  // Verbatim from the run that first reported this: TalkBack's own touch-exploration state
  // machine died under synthetic taps, and the harness blamed Kynviora for it.
  const TALKBACK_CRASH = [
    '--------- beginning of crash',
    'E AndroidRuntime: FATAL EXCEPTION: main',
    'E AndroidRuntime: Process: com.google.android.marvin.talkback, PID: 3744',
    'E AndroidRuntime: java.lang.IllegalStateException:',
    'E AndroidRuntime:   at com.google.android.accessibility.talkback.TouchInteractionMonitor',
  ].join('\n');

  const OWN_CRASH = [
    'E AndroidRuntime: FATAL EXCEPTION: main',
    'E AndroidRuntime: Process: com.kynviora.app, PID: 5595',
    'E AndroidRuntime: java.lang.RuntimeException: something of ours',
  ].join('\n');

  it('is not this app when another process died', () => {
    expect(crashedApp(TALKBACK_CRASH, PACKAGE)).toBe(false);
  });

  it('is this app when it did', () => {
    expect(crashedApp(OWN_CRASH, PACKAGE)).toBe(true);
  });

  it('finds this app’s crash even alongside another one', () => {
    expect(crashedApp(`${TALKBACK_CRASH}\n${OWN_CRASH}`, PACKAGE)).toBe(true);
  });

  it('is false for a quiet log', () => {
    expect(crashedApp('', PACKAGE)).toBe(false);
    expect(crashedApp('I ReactNativeJS: Running "main"', PACKAGE)).toBe(false);
  });

  it('does not match a package that merely starts the same', () => {
    const other = OWN_CRASH.replace('com.kynviora.app', 'com.kynviora.apples');
    expect(crashedApp(other, PACKAGE)).toBe(false);
  });
});
