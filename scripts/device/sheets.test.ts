/**
 * The sheet-survey judgements, run with nothing attached (DEC-102).
 *
 * Three of the four are absence tests over a set the survey built, which is the shape that passes
 * for the wrong reason: a sheet that never opened has no controls, and "every control was
 * reachable" over an empty set is true and worthless. `SHEET-1` is the control that stops the
 * other three from being reported at all in that case, and most of this file is about it.
 */

import { describe, expect, it } from 'vitest';
import {
  foldDump,
  namedCheck,
  reachabilityCheck,
  sheetChecks,
  sheetOpenedCheck,
  targetSizeCheck,
  type SheetSurvey,
  type SurveyedControl,
} from './sheets.js';
import type { UiNode } from './accessibility.js';

const MIN_DP = 48;

function control(overrides: Partial<SurveyedControl> = {}): SurveyedControl {
  return {
    name: 'Confirm and create the link',
    everFullyVisible: true,
    widthDp: 300,
    heightDp: 56,
    ...overrides,
  };
}

function survey(overrides: Partial<SheetSurvey> = {}): SheetSurvey {
  return {
    label: 'Invite someone',
    fontScale: 2,
    opened: true,
    positions: 4,
    controls: [control()],
    ...overrides,
  };
}

function node(overrides: Partial<UiNode> = {}): UiNode {
  return {
    packageName: 'com.kynviora.app',
    className: 'android.widget.Button',
    text: '',
    contentDescription: 'Add a schedule',
    clickable: true,
    enabled: true,
    scrollable: false,
    selected: false,
    bounds: { left: 76, top: 400, right: 1004, bottom: 530 },
    ...overrides,
  };
}

describe('folding a dump into the survey', () => {
  const clips = [{ left: 0, top: 0, right: 1080, bottom: 2145 }];

  it('records a control that was fully on screen, with its size', () => {
    const folded = foldDump([], [node()], clips, 'com.kynviora.app', 420);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.everFullyVisible).toBe(true);
    expect(folded[0]?.heightDp).toBeGreaterThan(0);
  });

  it('records one that was clipped as not yet reachable', () => {
    // Entering view from the bottom: `uiautomator` reports visible bounds, so this is the sliver
    // trap 194 is about.
    const sliver = node({ bounds: { left: 76, top: 2115, right: 1004, bottom: 2145 } });
    const folded = foldDump([], [sliver], clips, 'com.kynviora.app', 420);
    expect(folded[0]?.everFullyVisible).toBe(false);
    expect(folded[0]?.widthDp).toBeNull();
  });

  it('upgrades it once a later scroll position shows it whole', () => {
    // The point of surveying rather than dumping once. A control below the fold at the top of a
    // form is reachable, and a check that judged the first dump would call the form broken.
    const clipped = foldDump(
      [],
      [node({ bounds: { left: 76, top: 2115, right: 1004, bottom: 2145 } })],
      clips,
      'com.kynviora.app',
      420,
    );
    const after = foldDump(clipped, [node()], clips, 'com.kynviora.app', 420);
    expect(after).toHaveLength(1);
    expect(after[0]?.everFullyVisible).toBe(true);
  });

  it('never downgrades one that was already seen whole', () => {
    // Scrolling past a control must not un-reach it.
    const seen = foldDump([], [node()], clips, 'com.kynviora.app', 420);
    const after = foldDump(
      seen,
      [node({ bounds: { left: 76, top: 0, right: 1004, bottom: 20 } })],
      clips,
      'com.kynviora.app',
      420,
    );
    expect(after[0]?.everFullyVisible).toBe(true);
  });

  it('ignores another app’s nodes', () => {
    // A screen reader's own chrome and the system navigation bar are not this app's findings.
    expect(
      foldDump([], [node({ packageName: 'com.android.systemui' })], clips, 'com.kynviora.app', 420),
    ).toHaveLength(0);
  });

  it('ignores a node nobody can act on', () => {
    // `isInteractiveTarget` is what decides, so a disabled control and a non-clickable label are
    // both out - and a survey that counted labels would report a form full of unreachable "text".
    expect(foldDump([], [node({ clickable: false })], clips, 'com.kynviora.app', 420)).toHaveLength(
      0,
    );
    expect(foldDump([], [node({ enabled: false })], clips, 'com.kynviora.app', 420)).toHaveLength(
      0,
    );
  });
});

describe('SHEET-1, the control', () => {
  it('is inconclusive when the sheet never opened', () => {
    // Everything after this would be describing whatever screen was underneath.
    const check = sheetOpenedCheck(survey({ opened: false, controls: [] }));
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('underneath');
  });

  it('is inconclusive when the sheet opened and had no controls', () => {
    const check = sheetOpenedCheck(survey({ controls: [] }));
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('passes when controls were found', () => {
    expect(sheetOpenedCheck(survey()).status).toBe('PASS');
  });
});

describe('SHEET-2, reachability', () => {
  it('fails on a control never seen whole', () => {
    // `DEV-046` as a check: the Care tab could not be scrolled, so the invitation sheet's controls
    // were drawn below the fold and nobody could finish giving a caregiver access.
    const check = reachabilityCheck(
      survey({
        controls: [
          control(),
          control({ name: 'Send', everFullyVisible: false, widthDp: null, heightDp: null }),
        ],
      }),
    );
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('DEV-046');
  });

  it('is inconclusive rather than passing when nothing was surveyed', () => {
    expect(reachabilityCheck(survey({ opened: false, controls: [] })).status).toBe('INCONCLUSIVE');
  });

  it('passes when every control was seen whole at some point', () => {
    expect(reachabilityCheck(survey()).status).toBe('PASS');
  });
});

describe('SHEET-3, names', () => {
  it('fails on a control with no accessible name', () => {
    const check = namedCheck(survey({ controls: [control({ name: '' })] }));
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('"button"');
  });

  it('passes when everything is announced', () => {
    expect(namedCheck(survey()).status).toBe('PASS');
  });
});

describe('SHEET-4, target size', () => {
  it('fails on a control under the minimum', () => {
    const check = targetSizeCheck(
      survey({ controls: [control({ name: 'Monday', widthDp: 40, heightDp: 40 })] }),
      MIN_DP,
    );
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('Monday');
  });

  it('allows half a dp of slack at the boundary', () => {
    // A rounded pixel boundary is not a finding, and `checkScreen` uses the same slack - two
    // checks disagreeing about 47.6dp would be worse than either answer.
    expect(
      targetSizeCheck(survey({ controls: [control({ widthDp: 47.6, heightDp: 47.6 })] }), MIN_DP)
        .status,
    ).toBe('PASS');
  });

  it('is inconclusive when nothing could be measured', () => {
    // Distinct from a failure: unmeasured is what `SHEET-2` reports on, and reporting it twice as
    // two different failures would double-count one problem.
    const check = targetSizeCheck(
      survey({ controls: [control({ everFullyVisible: false, widthDp: null, heightDp: null })] }),
      MIN_DP,
    );
    expect(check.status).toBe('INCONCLUSIVE');
  });
});

describe('the four together', () => {
  it('qualifies every id by the sheet and the scale', () => {
    // Ids repeat across sheets and across the two scales, and an unqualified one makes a report
    // where two failures look like one.
    const ids = sheetChecks(survey(), MIN_DP).map((check) => check.id);
    for (const id of ids) expect(id).toContain('Invite someone@2');
    expect(new Set(ids).size).toBe(4);
  });
});
