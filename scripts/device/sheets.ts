/**
 * What a sheet's accessibility survey means.
 *
 * Spec references: `18` (48dp minimum target; every control carries a name a screen reader can
 * announce; system font scaling supported without clipping a critical action), `04` Phase 9.4,
 * `19`, `DEV-046`, DEC-102, DEC-103.
 *
 * Kept apart from the runner so the judgements run in `npm run verify` with nothing attached.
 *
 * WHY THE FIVE DESTINATIONS WERE NOT ENOUGH
 * `verify:device:a11y` measured the five primary destinations at two font scales and reported
 * 34/34, and `DEV-046` happened anyway: the Care tab could not be scrolled, so the controls of a
 * sheet three taps in were drawn below the fold with no way to reach them and nobody could finish
 * inviting a caregiver. "Every control is reachable" was being measured exactly where the controls
 * are fewest and the screen is shortest.
 *
 * A destination is one screen's worth of chrome. A sheet is a form, and a form at twice the font
 * size is the thing that stops fitting.
 *
 * REACHABILITY IS THE MEASUREMENT, NOT VISIBILITY
 * `checkScreen` measures what is fully on screen and counts the rest as unmeasured, which is right
 * for a destination and wrong for a form: a Save button below the fold is not a control with an
 * unknown size, it is either something a person can scroll to or something they cannot use. So a
 * sheet is surveyed - scrolled from top to bottom, dumped at each step - and every control is
 * judged on whether it was *ever* fully visible.
 *
 * A control seen only as a sliver is `DEV-046` and trap 194 in one: `uiautomator` reports visible
 * bounds, so a button entering view from the bottom is a thirty-pixel strip whose centre is under
 * the tab bar, and a tap on it lands on whatever is drawn there.
 */

import type { Check } from './analysis.js';
import type { Rect, UiNode } from './accessibility.js';
import {
  accessibleNameOf,
  describeAncestry,
  isDevelopmentOverlay,
  isFullyVisible,
  isInteractiveTarget,
  sizeInDp,
} from './accessibility.js';

/**
 * What a node actually was, kept from the moment it was looked at.
 *
 * WHY THIS EXISTS
 * The survey used to keep four fields per control - a name, whether it was ever whole, and its two
 * dimensions - and threw everything else away. That is enough to decide, and not enough to report:
 * the full survey found an unnamed 20x20dp clickable node on the invitation form at font scale 2,
 * and all `SHEET-3` and `SHEET-4` could say was "1 control(s)" and "(unnamed) 20x20dp". By the
 * time a check runs, the survey has scrolled on, the sheet has been closed and the app relaunched,
 * so nothing can go back and look. Three narrowed re-runs found nothing, which is exactly the
 * shape of finding that gets written off as noise and then keeps happening.
 *
 * So a control now carries the reading it came from. `raw` in particular is not redundant with the
 * modelled fields: the point of capturing something unexpected is that nobody knew in advance
 * which attribute would name it.
 */
export interface ControlEvidence {
  readonly className: string;
  readonly packageName: string;
  /** `''` for anything React Native drew. Anything else is the platform's own view. */
  readonly resourceId: string;
  /** Kept apart, because which of the two carries the name is itself the finding sometimes. */
  readonly text: string;
  readonly contentDescription: string;
  readonly clickable: boolean;
  readonly focusable: boolean;
  readonly longClickable: boolean;
  readonly focused: boolean;
  readonly selected: boolean;
  /** Screen pixels, as the dump reported them - which is what a screenshot can be checked against. */
  readonly bounds: Rect;
  readonly widthDp: number;
  readonly heightDp: number;
  /** The scroll position this reading was taken at. */
  readonly position: number;
  /** The first scroll position anything with this name was seen at. */
  readonly firstSeenAtPosition: number;
  /** What it sits inside, innermost last. */
  readonly ancestry: string;
  /** Its attributes exactly as the dump wrote them. */
  readonly raw: string;
}

/** One control, as the survey accumulated it across every scroll position. */
export interface SurveyedControl {
  /** The accessible name, or `''` where the control has none - which is itself a finding. */
  readonly name: string;
  /** Whether it was fully on screen at any point in the survey. */
  readonly everFullyVisible: boolean;
  /** Its size in dp when it was, or `null` where it never was. */
  readonly widthDp: number | null;
  readonly heightDp: number | null;
  /**
   * The reading these numbers came from: the whole sighting where there was one, and the first
   * sighting otherwise. A check that fails has something to show for it either way.
   */
  readonly evidence: ControlEvidence;
}

/** Everything about one sighting of a node, for a control the survey is about to record. */
function evidenceFor(
  nodes: readonly UiNode[],
  index: number,
  densityDpi: number,
  position: number,
  firstSeenAtPosition: number,
): ControlEvidence {
  const node = nodes[index];
  if (node === undefined) throw new RangeError(`no node at index ${String(index)}`);
  const { width, height } = sizeInDp(node, densityDpi);
  return {
    className: node.className,
    packageName: node.packageName,
    resourceId: node.resourceId,
    text: node.text,
    contentDescription: node.contentDescription,
    clickable: node.clickable,
    focusable: node.focusable,
    longClickable: node.longClickable,
    focused: node.focused,
    selected: node.selected,
    bounds: node.bounds,
    widthDp: width,
    heightDp: height,
    position,
    firstSeenAtPosition,
    ancestry: describeAncestry(nodes, index),
    raw: node.raw,
  };
}

/** One line naming a control precisely enough that somebody can go and find it. */
export function describeControl(control: SurveyedControl): string {
  const evidence = control.evidence;
  const { left, top, right, bottom } = evidence.bounds;
  return (
    `${control.name === '' ? '(no accessible name)' : JSON.stringify(control.name)} ` +
    `${evidence.className}` +
    `${evidence.resourceId === '' ? '' : `#${evidence.resourceId}`} ` +
    `${String(Math.round(evidence.widthDp))}x${String(Math.round(evidence.heightDp))}dp ` +
    `at [${String(left)},${String(top)}][${String(right)},${String(bottom)}]px ` +
    `package=${evidence.packageName} ` +
    `text=${JSON.stringify(evidence.text)} content-desc=${JSON.stringify(evidence.contentDescription)} ` +
    `clickable=${String(evidence.clickable)} focusable=${String(evidence.focusable)} ` +
    `long-clickable=${String(evidence.longClickable)} focused=${String(evidence.focused)} ` +
    `first seen at scroll position ${String(evidence.firstSeenAtPosition)} ` +
    `(measured at ${String(evidence.position)}), inside ${evidence.ancestry}`
  );
}

export interface SheetSurvey {
  /** The sheet, in the words the report uses. */
  readonly label: string;
  readonly fontScale: number;
  /** Whether the run actually reached the sheet. */
  readonly opened: boolean;
  /** How many scroll positions were dumped. One is a sheet that did not scroll. */
  readonly positions: number;
  readonly controls: readonly SurveyedControl[];
  /**
   * Whether a development-only overlay was drawn over the sheet during the survey.
   *
   * Reported rather than silently excluded. LogBox appears only once something has logged a
   * warning, so this being true says the build warned about something while the run was under
   * way - which is worth knowing on its own, and is the whole explanation of an intermittent
   * failure that cost three sessions.
   */
  readonly developmentOverlaySeen: boolean;
  /**
   * Whether the survey saw the sheet stop moving, rather than running out of scroll steps.
   *
   * `SHEET-2` asks whether every control can be brought into view, and a survey that stopped
   * part-way down cannot answer it: "never fully on screen" and "further down than we looked" are
   * the same reading. Reported so the check can refuse to decide (DEC-102) instead of calling the
   * last control unreachable, which is `DEV-079`'s failure - a harness parameter rendered as a
   * product defect.
   */
  readonly reachedEnd: boolean;
}

/**
 * Fold one dump into the running survey.
 *
 * Keyed by accessible name. Where two controls truly share a name they are folded together, which
 * understates rather than overstates: the survey then says the *name* was reachable, and a name
 * nobody can reach is what the check is about.
 *
 * WHY ANYTHING IS EXCLUDED
 * The tab bar is on screen over every sheet and is not part of one. It also cannot pass this
 * check by construction: `isFullyVisible` treats an edge coinciding with its container's as
 * clipped, which is right when measuring whether a control is safe to tap and wrong for the
 * leftmost and rightmost tabs, whose left and right edges *are* the screen's. A survey that
 * counted them reported "Today" and "You" as unreachable on every sheet in the app, which is a
 * statement about the harness.
 *
 * They are not going unmeasured: `checkScreen` measures all five destinations at both font
 * scales, which is what that check is for.
 */
export function foldDump(
  accumulated: readonly SurveyedControl[],
  nodes: readonly UiNode[],
  clips: readonly Rect[],
  packageName: string,
  densityDpi: number,
  excludedNames: readonly string[] = [],
  /** Which scroll position this dump is, so a finding can say where in the survey it appeared. */
  position = 0,
): readonly SurveyedControl[] {
  const byName = new Map(accumulated.map((control) => [control.name, control]));
  const excluded = new Set(excludedNames);

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    if (node.packageName !== packageName || !isInteractiveTarget(node)) continue;
    if (excluded.has(accessibleNameOf(node))) continue;
    // LogBox is drawn into this app's window and is not this app. Excluded by identity, and
    // reported on `SHEET-1` rather than swallowed - see {@link isDevelopmentOverlay}.
    if (isDevelopmentOverlay(nodes, index)) continue;

    const name = accessibleNameOf(node);
    const whole = isFullyVisible(node, clips);
    const existing = byName.get(name);

    if (existing !== undefined && existing.everFullyVisible) continue;

    // Where the name has been seen before, that first sighting is what "first seen at" means -
    // the evidence is replaced when a later position measures the control properly, and the
    // question "when did this appear" is about the name, not about the reading.
    const firstSeen = existing?.evidence.firstSeenAtPosition ?? position;
    const evidence = evidenceFor(nodes, index, densityDpi, position, firstSeen);

    if (whole) {
      byName.set(name, {
        name,
        everFullyVisible: true,
        widthDp: evidence.widthDp,
        heightDp: evidence.heightDp,
        evidence,
      });
    } else if (existing === undefined) {
      byName.set(name, {
        name,
        everFullyVisible: false,
        widthDp: null,
        heightDp: null,
        evidence,
      });
    }
  }

  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// Capturing the node, at the moment it is on screen
// ---------------------------------------------------------------------------

/** Why a node on screen right now would make a check fail. */
export type Offence = 'UNNAMED' | 'UNDER_MINIMUM';

/** A node worth writing a screenshot and a hierarchy down for, and why. */
export interface OffendingNode {
  /** Its position in the array it was parsed from, which is what {@link describeAncestry} takes. */
  readonly index: number;
  readonly node: UiNode;
  readonly offences: readonly Offence[];
}

/**
 * The nodes in this dump that `namedCheck` or `targetSizeCheck` would fail on.
 *
 * The same predicates as the two checks, deliberately: a capture rule that was merely *similar* to
 * the check would either miss the failure it exists to explain or fire on nodes no check minds.
 * `UNNAMED` does not depend on visibility, because `namedCheck` does not; `UNDER_MINIMUM` applies
 * only to a node that is fully on screen, because a node clipped at a container's edge is reported
 * at the size that is showing and measuring that is how a harness invents a 48dp violation.
 *
 * This is a lookup over one dump rather than over the survey, and that is the whole point. By the
 * time the survey's checks run, the offending node has been scrolled away, the sheet closed and
 * the app relaunched - so evidence has to be taken while it is still there.
 */
export function offendingNodes(
  nodes: readonly UiNode[],
  clips: readonly Rect[],
  packageName: string,
  densityDpi: number,
  minimumDp: number,
  excludedNames: readonly string[] = [],
): readonly OffendingNode[] {
  const excluded = new Set(excludedNames);
  const found: OffendingNode[] = [];

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    if (node.packageName !== packageName || !isInteractiveTarget(node)) continue;
    const name = accessibleNameOf(node);
    if (excluded.has(name)) continue;

    const offences: Offence[] = [];
    if (name === '') offences.push('UNNAMED');
    if (isFullyVisible(node, clips)) {
      const { width, height } = sizeInDp(node, densityDpi);
      if (width + 0.5 < minimumDp || height + 0.5 < minimumDp) offences.push('UNDER_MINIMUM');
    }
    if (offences.length > 0) found.push({ index, node, offences });
  }

  return found;
}

/**
 * What one offending node reads as, for the line printed while it is still on screen.
 *
 * Separate from {@link describeControl} because it is describing a node rather than a surveyed
 * control - there is no "ever fully visible" yet, and no measurement to report where the node is
 * clipped - and because it prints the raw attributes, which is the part that answers "what is
 * that?" when nothing else does.
 */
export function describeOffender(
  nodes: readonly UiNode[],
  offender: OffendingNode,
  densityDpi: number,
): string {
  const node = offender.node;
  const { width, height } = sizeInDp(node, densityDpi);
  const { left, top, right, bottom } = node.bounds;
  return (
    `  offences:  ${offender.offences.join(', ')}\n` +
    `  size:      ${String(Math.round(width))}x${String(Math.round(height))}dp ` +
    `([${String(left)},${String(top)}][${String(right)},${String(bottom)}] in device pixels)\n` +
    `  inside:    ${describeAncestry(nodes, offender.index)}\n` +
    `  node:      <node ${node.raw} />`
  );
}

// ---------------------------------------------------------------------------
// SHEET-1 - the sheet was reached
// ---------------------------------------------------------------------------

/**
 * The control that makes every other judgement mean something.
 *
 * A sheet that never opened has no controls, and "every control was reachable" over an empty set
 * is true and worthless - the same trivially-passing absence `verify:device`'s storage checks need
 * a positive control for. A survey that found no controls at all gets the same answer: the run
 * looked at something, and it was not this sheet.
 */
export function sheetOpenedCheck(survey: SheetSurvey): Check {
  const id = `SHEET-1/${survey.label}@${String(survey.fontScale)}`;
  const title = `The ${survey.label} sheet was reached at font scale ${String(survey.fontScale)}`;

  if (!survey.opened) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The taps that open this sheet did not land, so nothing about it was measured. A run ' +
        'that reported its controls as fine would be describing whatever screen was underneath.',
    };
  }
  if (survey.controls.length === 0) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The sheet opened and the survey found no interactive control on it at any scroll ' +
        'position. A screen with no controls is not evidence that its controls are reachable.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      `${String(survey.controls.length)} control(s) found across ` +
      `${String(survey.positions)} scroll position(s).` +
      // Said on the PASS, because this is the one place a reader will see it. An overlay that is
      // excluded and never mentioned is indistinguishable from one nobody thought about.
      (survey.developmentOverlaySeen
        ? ' A development-only overlay (LogBox) was on screen during this survey and its controls' +
          ' were excluded: it is not part of the product and does not exist in a release build.' +
          ' Its presence means something logged a warning while the run was under way - most' +
          " often Expo's dev client reporting that it has lost the dev server, in which case this" +
          ' survey was measuring a degraded app (`DEV-088`).'
        : ''),
  };
}

// ---------------------------------------------------------------------------
// SHEET-2 - every control can be brought fully into view
// ---------------------------------------------------------------------------

/**
 * `DEV-046`, as a check rather than as a bug report.
 *
 * A control that is never fully on screen at any scroll position is one a person cannot press.
 * That is not a smaller version of "the target is a bit tight" - it is the feature being
 * unreachable, and on the invitation sheet it meant nobody could finish giving a caregiver access.
 */
export function reachabilityCheck(survey: SheetSurvey): Check {
  const id = `SHEET-2/${survey.label}@${String(survey.fontScale)}`;
  const title = `Every control on ${survey.label} can be brought fully into view`;

  if (!survey.opened || survey.controls.length === 0) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The sheet was not surveyed.' };
  }

  const unreachable = survey.controls.filter((control) => !control.everFullyVisible);

  // A survey that ran out of scroll steps never saw the bottom of the form, and "never fully on
  // screen" then means "further down than we looked". Those are different findings and only one
  // of them is the product's. Refusing to decide is the honest answer and it fails the run
  // (DEC-102), so it is not a way of passing quietly - it says the survey needs more steps.
  if (unreachable.length > 0 && !survey.reachedEnd) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        `The survey stopped after ${String(survey.positions)} scroll position(s) without the ` +
        'sheet having stopped moving, so it never saw the end of the form. ' +
        `${String(unreachable.length)} control(s) had not been seen whole by then: ` +
        `${JSON.stringify(unreachable.map((control) => control.name || '(unnamed)'))}. ` +
        'That is not evidence they cannot be reached - it is evidence the survey ran out of ' +
        'steps, which is `DEV-079`: a harness parameter reported as a product defect. Raise ' +
        'MAX_SURVEY_STEPS and run it again.',
    };
  }

  if (unreachable.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `${String(unreachable.length)} control(s) were never fully on screen at any scroll ` +
        `position: ${JSON.stringify(unreachable.map((control) => control.name || '(unnamed)'))}. ` +
        'A control drawn below the fold with no way to scroll to it is the feature it belongs to ' +
        'being unusable (`DEV-046`), and a control only ever seen as a sliver is one whose tap ' +
        'lands on whatever is drawn over it (trap 194).',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail: `All ${String(survey.controls.length)} control(s) were fully on screen at some point.`,
  };
}

// ---------------------------------------------------------------------------
// SHEET-3 - and is announced
// ---------------------------------------------------------------------------

/**
 * `18`: a control a screen reader cannot name is a control somebody cannot use.
 *
 * Measured on a sheet rather than only on a destination because a form is where unnamed controls
 * appear: a destination's controls are buttons with visible words on them, and a form's are
 * fields, toggles and radio rows whose meaning is in a label drawn beside them.
 */
export function namedCheck(survey: SheetSurvey): Check {
  const id = `SHEET-3/${survey.label}@${String(survey.fontScale)}`;
  const title = `Every control on ${survey.label} carries a name`;

  if (!survey.opened || survey.controls.length === 0) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The sheet was not surveyed.' };
  }

  const unnamed = survey.controls.filter((control) => control.name.trim() === '');
  if (unnamed.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `${String(unnamed.length)} control(s) have no accessible name at all. A screen reader ` +
        'announces such a control as "button", which is the same thing it announces for every ' +
        'other one on the sheet. What was seen: ' +
        // Named rather than counted. "1 control(s) have no accessible name" is a report nobody
        // can act on and nobody can dismiss: three re-runs of this sheet found nothing, and with
        // only a count there was no way to tell an unlabelled control of the app's from a
        // selection handle the platform raised over it.
        unnamed.map((control) => `\n  - ${describeControl(control)}`).join(''),
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail: `All ${String(survey.controls.length)} control(s) are announced by name.`,
  };
}

// ---------------------------------------------------------------------------
// SHEET-4 - at a size somebody can hit
// ---------------------------------------------------------------------------

/**
 * The 48dp floor, applied where font scaling actually pushes against it.
 *
 * The five destinations pass this by construction: their controls are sized in `dp` and the tab
 * bar is a fixed height. A form's rows are sized by their content, so at twice the font size a row
 * grows and a toggle beside it may not - and `18` sets the floor regardless of anybody's text
 * preference.
 */
export function targetSizeCheck(survey: SheetSurvey, minimumDp: number): Check {
  const id = `SHEET-4/${survey.label}@${String(survey.fontScale)}`;
  const title = `Every control on ${survey.label} meets the ${String(minimumDp)}dp minimum`;

  if (!survey.opened || survey.controls.length === 0) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The sheet was not surveyed.' };
  }

  const measured = survey.controls.filter(
    (control) => control.widthDp !== null && control.heightDp !== null,
  );
  if (measured.length === 0) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'No control was ever fully on screen, so none could be measured.',
    };
  }

  // Half a dp of slack, as `checkScreen` uses: a rounded pixel boundary should not be a finding.
  const tooSmall = measured.filter(
    (control) =>
      (control.widthDp ?? 0) + 0.5 < minimumDp || (control.heightDp ?? 0) + 0.5 < minimumDp,
  );
  if (tooSmall.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `${String(tooSmall.length)} control(s) are under ${String(minimumDp)}dp: ` +
        // The size and the name were all this used to say, which for an unnamed control is
        // "(unnamed) 20x20dp" - a measurement of something nobody can identify. The class, the id
        // and what it sits inside are what say whether it is a control of this app's at all.
        tooSmall.map((control) => `\n  - ${describeControl(control)}`).join(''),
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail: `All ${String(measured.length)} measured control(s) meet ${String(minimumDp)}dp.`,
  };
}

/** Every judgement about one surveyed sheet, in the order the report should read them. */
export function sheetChecks(survey: SheetSurvey, minimumDp: number): readonly Check[] {
  return [
    sheetOpenedCheck(survey),
    reachabilityCheck(survey),
    namedCheck(survey),
    targetSizeCheck(survey, minimumDp),
  ];
}
