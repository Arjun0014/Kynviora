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
  isFullyVisible,
  isInteractiveTarget,
  sizeInDp,
} from './accessibility.js';

/** One control, as the survey accumulated it across every scroll position. */
export interface SurveyedControl {
  /** The accessible name, or `''` where the control has none - which is itself a finding. */
  readonly name: string;
  /** Whether it was fully on screen at any point in the survey. */
  readonly everFullyVisible: boolean;
  /** Its size in dp when it was, or `null` where it never was. */
  readonly widthDp: number | null;
  readonly heightDp: number | null;
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
): readonly SurveyedControl[] {
  const byName = new Map(accumulated.map((control) => [control.name, control]));
  const excluded = new Set(excludedNames);

  for (const node of nodes) {
    if (node.packageName !== packageName || !isInteractiveTarget(node)) continue;
    if (excluded.has(accessibleNameOf(node))) continue;

    const name = accessibleNameOf(node);
    const whole = isFullyVisible(node, clips);
    const existing = byName.get(name);

    if (existing !== undefined && existing.everFullyVisible) continue;

    if (whole) {
      const { width, height } = sizeInDp(node, densityDpi);
      byName.set(name, { name, everFullyVisible: true, widthDp: width, heightDp: height });
    } else if (existing === undefined) {
      byName.set(name, { name, everFullyVisible: false, widthDp: null, heightDp: null });
    }
  }

  return [...byName.values()];
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
      `${String(survey.positions)} scroll position(s).`,
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
        'other one on the sheet.',
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
        tooSmall
          .map(
            (control) =>
              `${control.name || '(unnamed)'} ` +
              `${String(Math.round(control.widthDp ?? 0))}x${String(Math.round(control.heightDp ?? 0))}dp`,
          )
          .join(', '),
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
