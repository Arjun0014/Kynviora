import { describe, it, expect } from 'vitest';
import { MIN_TOUCH_TARGET_DP } from '@kynviora/presentation';
import {
  accessibleNameOf,
  ancestryOf,
  checkScreen,
  describeAncestry,
  hasDevelopmentOverlay,
  isDevelopmentOverlay,
  isInteractiveTarget,
  clipRectsOf,
  crashedApp,
  isFullyVisible,
  dragAnchorAvoidingFields,
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

  it('reads whether a node reports itself as chosen', () => {
    // The only read-back a radio has. The chosen option keeps its accessible name - the app puts
    // "- chosen" in a `Text` child that the `Pressable` swallows - so a harness looking for a
    // changed name would report a successful tap as one that did nothing.
    const chosen = subject(
      hierarchy(
        node({ 'content-desc': 'Skin care', selected: 'true', bounds: boundsFor(200, 48) }),
      ),
    );
    const notChosen = subject(
      hierarchy(node({ 'content-desc': 'Sunscreen', bounds: boundsFor(200, 48) })),
    );
    expect(chosen?.selected).toBe(true);
    expect(notChosen?.selected).toBe(false);
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

describe('where a drag may safely begin', () => {
  /**
   * Spec references: `19`, DEC-102, `DEV-079`.
   *
   * The failure this exists to prevent is a **false FAIL**, which is the mirror of the one
   * `DEV-046` was about and is just as bad in its own direction: a drag begun inside a text field
   * is taken as text selection, the list does not move, and a survey that reads "the screen did
   * not change" as "the screen has ended" reports every control below that point as unreachable -
   * on a form whose Save button sits 400px above the tab bar.
   */
  const BAND = { top: 700, bottom: 1_900 };

  function field(topPx: number, bottomPx: number, packageName = PACKAGE): string {
    return node({
      class: 'android.widget.EditText',
      package: packageName,
      bounds: `[40,${String(topPx)}][1040,${String(bottomPx)}]`,
    });
  }

  it('answers the bottom of the band where nothing is in the way', () => {
    const nodes = parseUiHierarchy(hierarchy(node({ bounds: '[40,200][300,300]' })));
    expect(dragAnchorAvoidingFields(nodes, PACKAGE, BAND)).toBe(BAND.bottom);
  });

  it('moves above a field that covers the bottom of the band', () => {
    const nodes = parseUiHierarchy(hierarchy(field(1_500, 2_000)));
    const anchor = dragAnchorAvoidingFields(nodes, PACKAGE, BAND);
    expect(anchor).not.toBeNull();
    expect(anchor as number).toBeLessThan(1_500);
    expect(anchor as number).toBeGreaterThanOrEqual(BAND.top);
  });

  it('finds the gap between two fields', () => {
    // The case a form at a large font scale actually produces: tall fields with a little air
    // between them, and the air is where a drag has to start.
    const nodes = parseUiHierarchy(hierarchy(field(700, 1_180), field(1_320, 1_900)));
    const anchor = dragAnchorAvoidingFields(nodes, PACKAGE, BAND);
    expect(anchor).not.toBeNull();
    expect(anchor as number).toBeGreaterThan(1_180);
    expect(anchor as number).toBeLessThan(1_320);
  });

  it('answers null rather than a row inside a field', () => {
    // A genuinely possible screen, and the caller has to answer for it rather than guess. Returning
    // the band's bottom anyway would be the same swipe again dressed as a retry.
    const nodes = parseUiHierarchy(hierarchy(field(600, 2_000)));
    expect(dragAnchorAvoidingFields(nodes, PACKAGE, BAND)).toBeNull();
  });

  it('ignores a field belonging to another app', () => {
    // A system dialog's own text box is not this app's list, and avoiding it would move the anchor
    // for no reason - the same reasoning `checkScreen` applies to every other measurement.
    const nodes = parseUiHierarchy(hierarchy(field(1_500, 2_000, 'com.android.systemui')));
    expect(dragAnchorAvoidingFields(nodes, PACKAGE, BAND)).toBe(BAND.bottom);
  });
});

// ---------------------------------------------------------------------------
// Identifying a node, rather than only measuring it
// ---------------------------------------------------------------------------

/**
 * The attributes added so a finding can say *what* it found.
 *
 * The full survey reported an unnamed 20x20dp clickable node on the invitation form and could say
 * nothing else about it, because the parser read only geometry and labelling and the survey threw
 * the node away as soon as it had folded it into a name. Three narrowed re-runs of that sheet found
 * nothing, which is exactly how an intermittent red result turns into one nobody acts on.
 *
 * `resource-id` is the attribute that decides. React Native gives its views no ids, so a node with
 * `android:id/...` on it is the platform's own decoration drawn into the app's window - and it
 * arrives under the app's package, which is why a package filter alone cannot tell the two apart.
 */
describe('what a node is, not just how big it is', () => {
  it('reads the attributes that identify a node rather than measure it', () => {
    const parsed = subject(
      hierarchy(
        node({
          class: 'android.widget.ImageView',
          'resource-id': 'android:id/insertion_handle',
          'long-clickable': 'true',
          focusable: 'false',
          focused: 'false',
          bounds: boundsFor(20, 20),
        }),
      ),
    );
    expect(parsed?.resourceId).toBe('android:id/insertion_handle');
    expect(parsed?.longClickable).toBe(true);
    expect(parsed?.focusable).toBe(false);
    expect(parsed?.focused).toBe(false);
  });

  it('keeps the element’s attributes exactly as the dump wrote them', () => {
    // Because the point of capturing something unexpected is that nobody knew in advance which
    // attribute would name it. Every attribute this file chose not to model is still in here.
    const parsed = subject(
      hierarchy(node({ class: 'android.view.View', index: '7', bounds: boundsFor(20, 20) })),
    );
    expect(parsed?.raw).toContain('index="7"');
    expect(parsed?.raw).not.toMatch(/\/$/);
  });

  it('defaults every identifying attribute rather than inventing one', () => {
    const parsed = subject(hierarchy(node({ bounds: boundsFor(48, 48) })));
    expect(parsed?.resourceId).toBe('');
    expect(parsed?.longClickable).toBe(false);
    expect(parsed?.focused).toBe(false);
  });
});

describe('where a node sits', () => {
  /** A container that holds its children, as a real dump writes one. */
  function container(attributes: Record<string, string>, ...children: string[]): string {
    const opening = node({ clickable: 'false', ...attributes }).replace(/\s*\/>$/, '>');
    return `${opening}${children.join('')}</node>`;
  }

  const dump =
    `<?xml version='1.0'?><hierarchy rotation="0">` +
    container(
      { class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' },
      container(
        {
          class: 'android.widget.PopupWindow$PopupBackgroundView',
          'resource-id': 'android:id/popup',
          bounds: '[500,1000][600,1100]',
        },
        node({
          class: 'android.widget.ImageView',
          'resource-id': 'android:id/insertion_handle',
          bounds: '[516,1040][568,1092]',
        }),
      ),
      node({ class: 'android.widget.Button', text: 'Cancel', bounds: '[76,400][1004,530]' }),
    ) +
    `</hierarchy>`;

  const nodes = parseUiHierarchy(dump);

  it('reads the nesting, not just the rectangles', () => {
    expect(nodes).toHaveLength(4);
    expect(nodes.map((entry) => entry.depth)).toEqual([0, 1, 2, 1]);
  });

  it('names what a node sits inside, innermost last', () => {
    // The question the survey could not answer: a 20x20dp unnamed clickable node is a defect if it
    // is a control of the app's and an artefact if it is a view inside a platform popup. Only its
    // ancestry distinguishes them, and ancestry is structural - a flat list of rectangles cannot
    // say it.
    const handle = nodes.findIndex((entry) => entry.resourceId.endsWith('insertion_handle'));
    expect(ancestryOf(nodes, handle).map((entry) => entry.className)).toEqual([
      'android.widget.FrameLayout',
      'android.widget.PopupWindow$PopupBackgroundView',
    ]);
    expect(describeAncestry(nodes, handle)).toBe(
      'android.widget.FrameLayout > android.widget.PopupWindow$PopupBackgroundView#android:id/popup',
    );
  });

  it('does not put a node inside its own elder sibling', () => {
    // The bug a stack gets wrong if it forgets that a self-closing element never closes. "Cancel"
    // is a child of the frame, not of the popup that preceded it.
    const cancel = nodes.findIndex((entry) => entry.text === 'Cancel');
    expect(ancestryOf(nodes, cancel).map((entry) => entry.className)).toEqual([
      'android.widget.FrameLayout',
    ]);
  });

  it('says so plainly when a node has no enclosing node', () => {
    expect(describeAncestry(nodes, 0)).toBe('(no enclosing node)');
  });

  it('keeps the stack in step when an element has no readable bounds', () => {
    // A node with no bounds is skipped, and it still has a closing tag. A parser that pushed only
    // what it kept would pop somebody else's frame and misparent the whole rest of the screen.
    const withBoundless =
      `<?xml version='1.0'?><hierarchy rotation="0">` +
      container(
        { class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' },
        `<node class="android.view.View" package="${PACKAGE}">` +
          node({ class: 'android.widget.TextView', text: 'Inside', bounds: '[0,0][10,10]' }) +
          `</node>`,
        node({ class: 'android.widget.Button', text: 'After', bounds: '[76,400][1004,530]' }),
      ) +
      `</hierarchy>`;
    const parsed = parseUiHierarchy(withBoundless);
    const after = parsed.findIndex((entry) => entry.text === 'After');
    expect(ancestryOf(parsed, after).map((entry) => entry.className)).toEqual([
      'android.widget.FrameLayout',
    ]);
  });

  it('is unmoved by markup it does not recognise', () => {
    expect(ancestryOf(parseUiHierarchy(''), 0)).toEqual([]);
    expect(describeAncestry(parseUiHierarchy(''), 0)).toBe('(no enclosing node)');
  });
});

/**
 * The node that failed the full survey on 2026-09-07, verbatim from the dump that caught it.
 *
 * Trimmed to the chain that matters - the LogBox banner, its unnamed dismiss control, and one
 * ordinary app control beside them so the tests can show the exclusion is not simply dropping
 * everything. The `NAF="true"` attribute is Android's own, and is exactly what it says: not
 * accessibility friendly.
 */
const LOGBOX_DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.kynviora.app" content-desc="" clickable="false" enabled="true" focusable="false" scrollable="false" long-clickable="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="" resource-id="" class="android.widget.Button" package="com.kynviora.app" content-desc="Done" clickable="true" enabled="true" focusable="true" scrollable="false" long-clickable="false" selected="false" bounds="[42,1936][1038,2062]" />
    <node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.kynviora.app" content-desc="!, Open debugger to view warnings." clickable="true" enabled="true" focusable="true" scrollable="false" long-clickable="false" selected="false" bounds="[26,2146][1054,2271]">
      <node NAF="true" index="5" text="" resource-id="" class="android.view.ViewGroup" package="com.kynviora.app" content-desc="" clickable="true" enabled="true" focusable="true" scrollable="false" long-clickable="false" selected="false" bounds="[970,2183][1022,2235]" />
    </node>
  </node>
</hierarchy>`;

describe('the LogBox overlay, which is not the product', () => {
  const nodes = parseUiHierarchy(LOGBOX_DUMP);

  it('finds the banner, its dismiss control and the app control beside them', () => {
    expect(nodes).toHaveLength(4);
  });

  it('recognises the banner itself', () => {
    const banner = nodes.findIndex((node) => node.contentDescription.includes('Open debugger'));
    expect(banner).toBeGreaterThan(-1);
    expect(isDevelopmentOverlay(nodes, banner)).toBe(true);
  });

  /** The one that failed `SHEET-3` and `SHEET-4`. It carries nothing of its own to be known by. */
  it('recognises the unnamed dismiss control by what it sits inside', () => {
    const dismiss = nodes.findIndex((node) => node.bounds.left === 970 && node.bounds.top === 2183);
    expect(dismiss).toBeGreaterThan(-1);
    expect(nodes[dismiss]?.contentDescription).toBe('');
    expect(nodes[dismiss]?.text).toBe('');
    expect(accessibleNameOf(nodes[dismiss] as UiNode)).toBe('');
    expect(isInteractiveTarget(nodes[dismiss] as UiNode)).toBe(true);
    expect(isDevelopmentOverlay(nodes, dismiss)).toBe(true);
  });

  /**
   * The control this must not swallow. An exclusion that answered `true` for anything unnamed, or
   * anything small, or anything intermittent would hide the defects these checks exist to find -
   * `DEV-046` was a real unreachable control on a real sheet.
   */
  it('does not exclude an ordinary app control', () => {
    const done = nodes.findIndex((node) => node.contentDescription === 'Done');
    expect(done).toBeGreaterThan(-1);
    expect(isDevelopmentOverlay(nodes, done)).toBe(false);
  });

  it('reports that the overlay was present at all', () => {
    expect(hasDevelopmentOverlay(nodes)).toBe(true);
  });

  it('and says so of a screen that has none', () => {
    const clean = parseUiHierarchy(
      `<hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.Button" package="com.kynviora.app" content-desc="Done" clickable="true" enabled="true" focusable="true" scrollable="false" long-clickable="false" selected="false" bounds="[42,1936][1038,2062]" /></hierarchy>`,
    );
    expect(hasDevelopmentOverlay(clean)).toBe(false);
    expect(isDevelopmentOverlay(clean, 0)).toBe(false);
  });

  it('checkScreen no longer fails on it, and says it was there', () => {
    const checks = checkScreen({
      label: 'Voice Mode',
      xml: LOGBOX_DUMP,
      packageName: 'com.kynviora.app',
      densityDpi: 420,
      fontScale: 1,
      minimumTouchTargetDp: 48,
    });
    const named = checks.find((check) => check.id === 'A11Y-3');
    const sized = checks.find((check) => check.id === 'A11Y-2');
    expect(named?.status).toBe('PASS');
    expect(sized?.status).toBe('PASS');
    const read = checks.find((check) => check.id === 'A11Y-1');
    expect(read?.detail).toContain('LogBox');
  });
});
