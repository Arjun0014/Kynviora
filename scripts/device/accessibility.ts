/**
 * What a rendered screen has to show before an accessibility claim may be made about it.
 *
 * Spec references: `18` (minimum touch target; meaning never carried by colour or shape alone;
 * every control has a name), `04` Phase 9.4, `19` (TalkBack smoke suite), `BLK-002`.
 *
 * WHY THIS READS A UI DUMP RATHER THAN THE SOURCE
 * `MIN_TOUCH_TARGET_DP` is asserted in `packages/presentation`, and `PrimaryButton` applies it -
 * both of which were already true while nothing had ever been laid out. A style that sets
 * `minHeight` is a claim about what the layout engine will do; the hierarchy Android actually
 * built is what it did. Font scaling is where the two come apart: a control sized in `dp` and a
 * label sized in scaled pixels grow differently, and at 2x the label is what pushes a row past
 * its container.
 *
 * The parsing is deliberately small and total. A `uiautomator` dump is a flat XML tree with
 * attributes this file cares about and many it does not; anything unrecognised is ignored rather
 * than treated as a finding, because a parser that invents findings from markup it did not expect
 * is one people learn to ignore.
 */

import type { Check } from './analysis.js';

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface UiNode {
  readonly className: string;
  /** The app the node belongs to. A screen reader's own chrome is not this app's finding. */
  readonly packageName: string;
  readonly text: string;
  readonly contentDescription: string;
  /**
   * The view's id, where anything gave it one, and `''` where nothing did.
   *
   * The single most identifying attribute a dump carries, and the reason it is read at all: React
   * Native gives its views no ids, so a node with `android:id/...` on it is **the platform's own**
   * - a selection handle, an insertion handle, a magnifier, a popup background - drawn into the
   * app's window and therefore reported under the app's package. A finding against a node with a
   * platform id is a finding about the harness or about Android, not about a control anybody wrote.
   */
  readonly resourceId: string;
  readonly clickable: boolean;
  /**
   * Whether a long press does something separate.
   *
   * Diagnostic in the same way `focusable` is: the app's controls are `Pressable`s, which are
   * focusable and not long-clickable, and the platform's decorations are neither.
   */
  readonly longClickable: boolean;
  readonly focusable: boolean;
  readonly focused: boolean;
  readonly enabled: boolean;
  readonly scrollable: boolean;
  /**
   * Whether the node reports itself as chosen.
   *
   * `accessibilityState={{ selected }}` on a React Native `Pressable` arrives here as
   * `selected="true"`, and it is the only read-back a radio has. The label of a chosen option is
   * unchanged - the app puts the state in a `Text` child, which is not exposed separately once the
   * `Pressable` has claimed the accessibility element - so a harness that tapped an option and
   * then looked for a different name would find nothing and conclude the tap had failed.
   */
  readonly selected: boolean;
  /** Screen pixels, as `uiautomator` reports them - clipped to what is actually visible. */
  readonly bounds: Rect;
  /** How deeply the element was nested. The outermost `<node>` is 0; `<hierarchy>` is not a node. */
  readonly depth: number;
  /**
   * Where this node's nearest enclosing node sits in the array it was parsed into, or `-1`.
   *
   * An index rather than a reference, so a `UiNode` stays a plain readonly record that a test can
   * write down and `JSON.stringify` can print. It is only meaningful against the array
   * `parseUiHierarchy` returned it in, which is what {@link ancestryOf} takes.
   */
  readonly parent: number;
  /**
   * The element's attributes exactly as the dump wrote them, minus the closing slash.
   *
   * Kept because every attribute this file chose not to model is still in here, and the point of
   * capturing an unexpected node is that nobody knew in advance which attribute would identify it.
   */
  readonly raw: string;
}

/**
 * Class names of nodes that eat a vertical drag instead of passing it to the list.
 *
 * A React Native `TextInput` is an `EditText`, and a drag that begins inside one is taken as text
 * selection rather than as a scroll - so the swipe happens, the list does not move, and a survey
 * that treats "the screen did not change" as "the screen has reached its end" stops in the middle
 * of a form (`DEV-079`). `AutoCompleteTextView` is the same widget under another name.
 */
const SWALLOWS_A_DRAG: readonly string[] = ['android.widget.EditText'];

/**
 * A y coordinate a drag can start at without a text field taking it, or `null`.
 *
 * Searched from the bottom of the candidate band upwards, because a drag started low travels
 * furthest before running out of screen. `null` means every candidate row is inside a field - a
 * genuinely possible screen, and one the caller has to answer for rather than guess at.
 *
 * `bounds` from `uiautomator` are already clipped to what is visible, so a field scrolled half off
 * the top is avoided over the half that is still there, which is the half a drag would land in.
 */
export function dragAnchorAvoidingFields(
  nodes: readonly UiNode[],
  packageName: string,
  band: { readonly top: number; readonly bottom: number },
  step = 60,
): number | null {
  const fields = nodes.filter(
    (node) => node.packageName === packageName && SWALLOWS_A_DRAG.includes(node.className),
  );
  for (let y = band.bottom; y >= band.top; y -= step) {
    const inside = fields.some((field) => y >= field.bounds.top && y <= field.bounds.bottom);
    if (!inside) return y;
  }
  return null;
}

/** An opening `<node ...>` (self-closing or not) or a closing `</node>`. */
const ELEMENT = /<node\b([^>]*)>|<\/node\s*>/g;
const ATTRIBUTE = /([a-zA-Z-]+)="([^"]*)"/g;
const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

/**
 * Read the nodes out of a `uiautomator dump`.
 *
 * Mostly attribute-driven: every judgement in this file is about one node's own geometry and
 * labelling, and a flat list is what the callers want to filter.
 *
 * WHY IT TRACKS NESTING AT ALL
 * Because a flat list cannot answer "what is that?". The full accessibility survey reported an
 * unnamed 20x20dp clickable node on the invitation form and the report could say nothing else
 * about it - `foldDump` keys controls by accessible name and discards node identity, so by the
 * time the check ran the node was three scroll positions gone. A node's class and its id say what
 * it is; **what it sits inside** says whose it is, and that is a structural question. A view drawn
 * into a `PopupWindow` over a form is not a control of the form's, however its package reads.
 *
 * The nesting is tracked with a stack that holds an entry for **every** opening element, including
 * ones with no readable bounds, so a skipped node does not put every closing tag after it out of
 * step and misparent the rest of the screen. `parent` is the nearest enclosing element that was
 * itself kept.
 */
export function parseUiHierarchy(xml: string): readonly UiNode[] {
  const nodes: UiNode[] = [];
  /** One entry per open element: the index it was kept at, or `-1` where it was skipped. */
  const open: number[] = [];

  for (const match of xml.matchAll(ELEMENT)) {
    const attributeText = match[1];
    if (attributeText === undefined) {
      open.pop();
      continue;
    }
    const selfClosing = attributeText.trimEnd().endsWith('/');

    const attributes = new Map<string, string>();
    for (const attribute of attributeText.matchAll(ATTRIBUTE)) {
      attributes.set(attribute[1] ?? '', attribute[2] ?? '');
    }
    const rawBounds = BOUNDS.exec(attributes.get('bounds') ?? '');

    let kept = -1;
    if (rawBounds !== null) {
      kept = nodes.length;
      nodes.push({
        className: attributes.get('class') ?? '',
        packageName: attributes.get('package') ?? '',
        text: attributes.get('text') ?? '',
        contentDescription: attributes.get('content-desc') ?? '',
        resourceId: attributes.get('resource-id') ?? '',
        clickable: attributes.get('clickable') === 'true',
        longClickable: attributes.get('long-clickable') === 'true',
        focusable: attributes.get('focusable') === 'true',
        focused: attributes.get('focused') === 'true',
        enabled: attributes.get('enabled') !== 'false',
        scrollable: attributes.get('scrollable') === 'true',
        selected: attributes.get('selected') === 'true',
        bounds: {
          left: Number(rawBounds[1]),
          top: Number(rawBounds[2]),
          right: Number(rawBounds[3]),
          bottom: Number(rawBounds[4]),
        },
        depth: open.length,
        parent: open.findLast((entry) => entry >= 0) ?? -1,
        raw: attributeText.trim().replace(/\/$/, '').trim(),
      });
    }
    if (!selfClosing) open.push(kept);
  }
  return nodes;
}

/**
 * The nodes a node sits inside, outermost first.
 *
 * Guarded against a cycle it cannot have - `parent` is always an earlier index - because a walk
 * over parsed input should end whatever the input was, and a harness that hangs on a malformed
 * dump is worse than one that reports a short ancestry.
 */
export function ancestryOf(nodes: readonly UiNode[], index: number): readonly UiNode[] {
  const chain: UiNode[] = [];
  const seen = new Set<number>();
  let at = nodes[index]?.parent ?? -1;
  while (at >= 0 && !seen.has(at)) {
    seen.add(at);
    const parent = nodes[at];
    if (parent === undefined) break;
    chain.push(parent);
    at = parent.parent;
  }
  return chain.reverse();
}

/**
 * React Native's LogBox notification, which is drawn into this app's window and is not this app.
 *
 * WHAT THIS IS AND WHY IT IS NOT AN ALLOWLIST
 * The full survey failed `SHEET-3` and `SHEET-4` on an unnamed 20x20dp clickable node, three
 * narrowed re-runs of the same sheet passed, and the standing hypothesis was an Android
 * text-selection handle raised by a drag beginning inside a field. It was captured on
 * 2026-09-07 and it is neither: it is the **dismiss button of the LogBox warning banner**, and
 * Android's own dump marks it `NAF="true"`.
 *
 * ```
 * content-desc="!, Open debugger to view warnings."   <- the banner
 *   ...
 *   <node NAF="true" class="android.view.ViewGroup" clickable="true" focusable="true"
 *         content-desc="" bounds="[970,2183][1022,2235]" />   <- the dismiss control
 * ```
 *
 * That explains every property of the failure that made it look like noise. LogBox appears only
 * once something has logged a warning, so **whether** it is on screen depends on what the run did
 * before - which is the state-dependence - and **which** sheet it lands on is simply whichever one
 * was being surveyed at the time. It was reported against `Invite someone@2` once and
 * `Voice Mode@1` the next time, and it was never a property of either sheet.
 *
 * It is excluded because it is not part of the product: LogBox does not exist in a release build,
 * so a survey that failed on it would be reporting a defect nobody can ship and nobody can fix on
 * the screen it was blamed on. It is **not** excluded by being small, or unnamed, or intermittent
 * - each of those would hide the real defects these two checks exist to find. It is excluded by
 * identity, and its presence is **reported** rather than swallowed (`SHEET-1`, `A11Y-1`), because
 * a warning firing during a survey is a fact about the build worth knowing.
 *
 * WHAT THE WARNING ACTUALLY WAS, MEASURED
 * Reproduced on 2026-09-07 by killing Metro while the app was running and driving the tabs:
 *
 * ```
 * W/ReactNativeJS: Cannot connect to Expo CLI.
 * W/ReactNativeJS: URL: 10.0.2.2:8081
 * ```
 *
 * Expo's **dev client** reporting that it has lost the dev server - not Kynviora code. The app's
 * own source contains no `console.*` call, and a full sheet survey at font scale 2 with the stack
 * healthy produces no JS warning at all and no banner. So the run that first showed this was
 * measuring an app whose dev server had died underneath it, which is exactly what was found
 * afterwards (`DEV-088`).
 *
 * That is worth more than an explanation. **A survey whose dev server has gone is not measuring
 * the product**, and this banner is the one visible symptom of it - which is why its presence is
 * printed on `SHEET-1` and `A11Y-1` rather than quietly dropped.
 */
const DEVELOPMENT_OVERLAY = /open debugger to view|logbox/i;

/**
 * Whether a node is part of a development-only overlay drawn over the app.
 *
 * Answered structurally rather than by the node's own attributes, because the node that gives the
 * overlay away is the container and the node that fails a check is a descendant of it with no
 * attributes at all.
 */
export function isDevelopmentOverlay(nodes: readonly UiNode[], index: number): boolean {
  const node = nodes[index];
  if (node === undefined) return false;
  if (DEVELOPMENT_OVERLAY.test(node.contentDescription)) return true;
  return ancestryOf(nodes, index).some((ancestor) =>
    DEVELOPMENT_OVERLAY.test(ancestor.contentDescription),
  );
}

/** Whether any development-only overlay is on screen at all, for a report to say so. */
export function hasDevelopmentOverlay(nodes: readonly UiNode[]): boolean {
  return nodes.some((node) => DEVELOPMENT_OVERLAY.test(node.contentDescription));
}

/**
 * A node's ancestry as one line, nearest containers last.
 *
 * Only the innermost few, and each named by its id where it has one. A dump on this device is
 * fifteen levels of `FrameLayout` before anything interesting, and an ancestry that printed all of
 * them would bury the one container that answers the question - which is the innermost.
 */
export function describeAncestry(nodes: readonly UiNode[], index: number, depth = 4): string {
  const chain = ancestryOf(nodes, index).slice(-depth);
  if (chain.length === 0) return '(no enclosing node)';
  return chain
    .map((node) =>
      node.resourceId === '' ? node.className : `${node.className}#${node.resourceId}`,
    )
    .join(' > ');
}

/** Density-independent size of a node, given the device's reported density bucket. */
export function sizeInDp(
  node: UiNode,
  densityDpi: number,
): { readonly width: number; readonly height: number } {
  const scale = densityDpi / 160;
  return {
    width: (node.bounds.right - node.bounds.left) / scale,
    height: (node.bounds.bottom - node.bounds.top) / scale,
  };
}

/**
 * Whether a node is one this file has anything to say about.
 *
 * Only enabled, clickable, non-empty nodes. A disabled control is not a target somebody is
 * expected to hit, and a zero-area node is one the layout has not placed - counting either would
 * fill a report with findings nobody can act on.
 */
export function isInteractiveTarget(node: UiNode): boolean {
  return (
    node.clickable &&
    node.enabled &&
    node.bounds.right > node.bounds.left &&
    node.bounds.bottom > node.bounds.top
  );
}

/**
 * The rectangles a node's reported bounds may have been cut down to.
 *
 * `uiautomator` reports **visible** bounds, so a control half-scrolled past the bottom of a list
 * is reported at the height that is on screen. Measuring that as its size is how a harness invents
 * a 48dp rule violation out of a button that is simply not fully in view - which is exactly what
 * this one did on its first run, against a shelf row whose bottom edge was the ScrollView's.
 */
export function clipRectsOf(nodes: readonly UiNode[]): readonly Rect[] {
  const rects = nodes.filter((node) => node.scrollable).map((node) => node.bounds);
  const root = nodes[0];
  return root === undefined ? rects : [root.bounds, ...rects];
}

/**
 * Whether a node's reported size is its real size.
 *
 * An edge that coincides exactly with a clipping rectangle's edge is the tell: the node either
 * ends there or was cut there, and nothing in the dump distinguishes the two. Treating it as
 * unmeasured is the honest reading - a node that really does end at the container's edge is
 * measured on its next appearance further up the list.
 */
export function isFullyVisible(node: UiNode, clips: readonly Rect[]): boolean {
  return !clips.some(
    (clip) =>
      node.bounds.top === clip.top ||
      node.bounds.bottom === clip.bottom ||
      node.bounds.left === clip.left ||
      node.bounds.right === clip.right,
  );
}

/** A node's accessible name, which is what a screen reader announces. */
export function accessibleNameOf(node: UiNode): string {
  return node.contentDescription.trim() !== '' ? node.contentDescription.trim() : node.text.trim();
}

export interface ScreenEvidence {
  /** What the screen was, for the report. */
  readonly label: string;
  readonly xml: string | null;
  /** Only this app's own nodes are judged. A screen reader's own chrome is not its finding. */
  readonly packageName: string;
  readonly densityDpi: number;
  /** The system font scale in force when the dump was taken. */
  readonly fontScale: number;
  /** Minimum target, in dp. Supplied by the caller so `presentation` stays the one definition. */
  readonly minimumTouchTargetDp: number;
}

export function checkScreen(evidence: ScreenEvidence): readonly Check[] {
  const suffix = `${evidence.label} at font scale ${String(evidence.fontScale)}`;

  if (evidence.xml === null || !evidence.xml.includes('<node')) {
    return [
      {
        id: 'A11Y-1',
        title: 'The screen could be read for inspection',
        status: 'INCONCLUSIVE',
        detail: `No view hierarchy was captured for ${suffix}.`,
      },
    ];
  }

  const all = parseUiHierarchy(evidence.xml);
  const clips = clipRectsOf(all);
  // The same exclusion the sheet survey makes, for the same reason: LogBox is drawn into this
  // app's window, so the package filter does not remove it, and it is not part of the product.
  // A destination is as able to have it drawn over it as a sheet is.
  const overlaySeen = hasDevelopmentOverlay(all);
  const nodes = all.filter(
    (node, index) =>
      node.packageName === evidence.packageName &&
      isInteractiveTarget(node) &&
      !isDevelopmentOverlay(all, index),
  );
  if (nodes.length === 0) {
    return [
      {
        id: 'A11Y-1',
        title: 'The screen could be read for inspection',
        status: 'INCONCLUSIVE',
        detail:
          `The hierarchy for ${suffix} contains no enabled, laid-out clickable node. ` +
          'A screen with no controls is not evidence that its controls are large enough.',
      },
    ];
  }

  // Only what was fully on screen can be measured. The rest is counted and named, so nobody
  // reads a pass as coverage of the whole screen.
  const measurable = nodes.filter((node) => isFullyVisible(node, clips));
  const clipped = nodes.length - measurable.length;

  const tooSmall = measurable.filter((node) => {
    const { width, height } = sizeInDp(node, evidence.densityDpi);
    return (
      width + 0.5 < evidence.minimumTouchTargetDp || height + 0.5 < evidence.minimumTouchTargetDp
    );
  });

  // Naming does not depend on geometry, so a clipped control is still judged on it.
  const unnamed = nodes.filter((node) => accessibleNameOf(node) === '');

  return [
    {
      id: 'A11Y-1',
      title: 'The screen could be read for inspection',
      status: 'PASS',
      detail:
        `${String(nodes.length)} interactive node(s) in ${suffix}.` +
        (overlaySeen
          ? ' A development-only overlay (LogBox) was on screen and its controls were excluded:' +
            ' it is not part of the product and does not exist in a release build. Its presence' +
            " means something logged a warning - most often Expo's dev client reporting that it" +
            ' has lost the dev server, in which case this run was measuring a degraded app' +
            ' (`DEV-088`).'
          : ''),
    },
    {
      id: 'A11Y-2',
      title: `Every control is at least ${String(evidence.minimumTouchTargetDp)}dp in both directions`,
      status: measurable.length === 0 ? 'INCONCLUSIVE' : tooSmall.length === 0 ? 'PASS' : 'FAIL',
      detail:
        measurable.length === 0
          ? `Every interactive node in ${suffix} was cut off by a scroll container or the screen ` +
            'edge, so none could be measured.'
          : tooSmall.length === 0
            ? `All ${String(measurable.length)} fully visible interactive node(s) meet the ` +
              `minimum in ${suffix}` +
              (clipped === 0 ? '.' : `; ${String(clipped)} more were cut off and not measured.`)
            : tooSmall
                .map((node) => {
                  const { width, height } = sizeInDp(node, evidence.densityDpi);
                  const name = accessibleNameOf(node);
                  return `${name === '' ? node.className : name} is ${width.toFixed(0)}x${height.toFixed(0)}dp`;
                })
                .join('; '),
    },
    {
      id: 'A11Y-3',
      title: 'Every control has a name a screen reader can announce',
      status: unnamed.length === 0 ? 'PASS' : 'FAIL',
      detail:
        unnamed.length === 0
          ? `All ${String(nodes.length)} interactive node(s) carry text or a content description in ${suffix}.`
          : `${String(unnamed.length)} interactive node(s) announce nothing: ${unnamed
              .map((node) => node.className)
              .join(', ')}.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Whose crash was it
// ---------------------------------------------------------------------------

/**
 * Whether a logcat excerpt contains a fatal crash **of this app**.
 *
 * `FATAL EXCEPTION` on its own is not the question. The first run of the screen-reader smoke test
 * reported the app as crashing under TalkBack; the crash was TalkBack's own
 * (`Process: com.google.android.marvin.talkback`, an `IllegalStateException` in its touch
 * exploration state machine, provoked by synthetic taps). Reporting that as a Kynviora failure is
 * the same mistake as measuring another app's views - a harness that blames the wrong process
 * teaches people to disbelieve it.
 */
export function crashedApp(logcat: string, packageName: string): boolean {
  // Compared rather than pattern-matched, so a package name is never read as a regular
  // expression and `com.kynviora.apples` is never mistaken for `com.kynviora.app`.
  const namesThisApp = (line: string): boolean => {
    const marker = line.indexOf('Process:');
    if (marker === -1) return false;
    const named = line.slice(marker + 'Process:'.length).trim();
    return (
      named === packageName ||
      named.startsWith(`${packageName},`) ||
      named.startsWith(`${packageName} `)
    );
  };

  // The first chunk is whatever preceded the first crash, so it is not a crash block.
  return logcat
    .split('FATAL EXCEPTION')
    .slice(1)
    .some((block) => block.split('\n').some(namesThisApp));
}
