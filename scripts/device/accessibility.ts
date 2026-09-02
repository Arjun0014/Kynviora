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
  readonly clickable: boolean;
  readonly enabled: boolean;
  readonly scrollable: boolean;
  /** Screen pixels, as `uiautomator` reports them - clipped to what is actually visible. */
  readonly bounds: Rect;
}

const NODE = /<node\b([^>]*)\/?>/g;
const ATTRIBUTE = /([a-zA-Z-]+)="([^"]*)"/g;
const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

/**
 * Read the nodes out of a `uiautomator dump`.
 *
 * Attribute-driven rather than structural: the hierarchy's nesting says which view contains which,
 * and every question here is about one node's own geometry and labelling.
 */
export function parseUiHierarchy(xml: string): readonly UiNode[] {
  const nodes: UiNode[] = [];
  for (const match of xml.matchAll(NODE)) {
    const attributes = new Map<string, string>();
    for (const attribute of (match[1] ?? '').matchAll(ATTRIBUTE)) {
      attributes.set(attribute[1] ?? '', attribute[2] ?? '');
    }
    const rawBounds = BOUNDS.exec(attributes.get('bounds') ?? '');
    if (rawBounds === null) continue;
    nodes.push({
      className: attributes.get('class') ?? '',
      packageName: attributes.get('package') ?? '',
      text: attributes.get('text') ?? '',
      contentDescription: attributes.get('content-desc') ?? '',
      clickable: attributes.get('clickable') === 'true',
      enabled: attributes.get('enabled') !== 'false',
      scrollable: attributes.get('scrollable') === 'true',
      bounds: {
        left: Number(rawBounds[1]),
        top: Number(rawBounds[2]),
        right: Number(rawBounds[3]),
        bottom: Number(rawBounds[4]),
      },
    });
  }
  return nodes;
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
  const nodes = all.filter(
    (node) => node.packageName === evidence.packageName && isInteractiveTarget(node),
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
      detail: `${String(nodes.length)} interactive node(s) in ${suffix}.`,
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
