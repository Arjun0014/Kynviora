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
  describeControl,
  describeOffender,
  foldDump,
  namedCheck,
  offendingNodes,
  reachabilityCheck,
  sheetChecks,
  sheetOpenedCheck,
  targetSizeCheck,
  type ControlEvidence,
  type SheetSurvey,
  type SurveyedControl,
} from './sheets.js';
import { parseUiHierarchy, type UiNode } from './accessibility.js';

const MIN_DP = 48;

function evidence(overrides: Partial<ControlEvidence> = {}): ControlEvidence {
  return {
    className: 'android.view.ViewGroup',
    packageName: 'com.kynviora.app',
    resourceId: '',
    text: '',
    contentDescription: 'Confirm and create the link',
    clickable: true,
    focusable: true,
    longClickable: false,
    focused: false,
    selected: false,
    bounds: { left: 76, top: 400, right: 1004, bottom: 547 },
    widthDp: 300,
    heightDp: 56,
    position: 0,
    firstSeenAtPosition: 0,
    ancestry: 'android.widget.FrameLayout > android.view.ViewGroup',
    raw: 'class="android.view.ViewGroup" bounds="[76,400][1004,547]"',
    ...overrides,
  };
}

function control(overrides: Partial<SurveyedControl> = {}): SurveyedControl {
  return {
    name: 'Confirm and create the link',
    everFullyVisible: true,
    widthDp: 300,
    heightDp: 56,
    evidence: evidence(),
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
    developmentOverlaySeen: false,
    ...overrides,
  };
}

function node(overrides: Partial<UiNode> = {}): UiNode {
  return {
    packageName: 'com.kynviora.app',
    className: 'android.widget.Button',
    text: '',
    contentDescription: 'Add a schedule',
    resourceId: '',
    clickable: true,
    longClickable: false,
    focusable: true,
    focused: false,
    enabled: true,
    scrollable: false,
    selected: false,
    bounds: { left: 76, top: 400, right: 1004, bottom: 530 },
    depth: 3,
    parent: -1,
    raw: 'class="android.widget.Button" bounds="[76,400][1004,530]"',
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

// ---------------------------------------------------------------------------
// Saying what was found, rather than how many
// ---------------------------------------------------------------------------

/**
 * The evidence a finding carries, and why it is not a nicety.
 *
 * The full survey reported `SHEET-3` "1 control(s) have no accessible name at all" and `SHEET-4`
 * "1 control(s) are under 48dp: (unnamed) 20x20dp" on the invitation form at font scale 2. Neither
 * sentence says what the node was, and by the time either check ran the sheet had been closed and
 * the app relaunched - so there was nothing left to go and look at. Three narrowed re-runs of the
 * same sheet passed, and an intermittent red result with nothing behind it is one people learn to
 * write off.
 */
describe('the evidence a surveyed control carries', () => {
  const clips = [{ left: 0, top: 0, right: 1080, bottom: 2145 }];

  it('keeps what the node was, not only how big it was', () => {
    const handle = node({
      className: 'android.widget.ImageView',
      resourceId: 'android:id/insertion_handle',
      contentDescription: '',
      bounds: { left: 516, top: 1040, right: 568, bottom: 1092 },
      raw: 'class="android.widget.ImageView" resource-id="android:id/insertion_handle"',
    });
    const folded = foldDump([], [handle], clips, 'com.kynviora.app', 420, [], 3);
    const found = folded[0]?.evidence;
    expect(found?.className).toBe('android.widget.ImageView');
    expect(found?.resourceId).toBe('android:id/insertion_handle');
    expect(found?.bounds).toEqual({ left: 516, top: 1040, right: 568, bottom: 1092 });
    expect(found?.position).toBe(3);
    expect(found?.raw).toContain('insertion_handle');
  });

  it('keeps the text and the content description apart', () => {
    // Which of the two carries the name is itself a finding: a control announced only by the text
    // its own child draws is one an `accessible` wrapper would silence.
    const folded = foldDump(
      [],
      [node({ text: 'Save', contentDescription: '' })],
      clips,
      'com.kynviora.app',
      420,
    );
    expect(folded[0]?.evidence.text).toBe('Save');
    expect(folded[0]?.evidence.contentDescription).toBe('');
  });

  it('remembers the position a name first appeared at, across a later measurement', () => {
    // "When did this appear" is a question about the name, and the answer survives the reading
    // being replaced when a later scroll position finally shows the control whole.
    const clipped = foldDump(
      [],
      [node({ bounds: { left: 76, top: 2115, right: 1004, bottom: 2145 } })],
      clips,
      'com.kynviora.app',
      420,
      [],
      1,
    );
    const later = foldDump(clipped, [node()], clips, 'com.kynviora.app', 420, [], 4);
    expect(later[0]?.evidence.firstSeenAtPosition).toBe(1);
    expect(later[0]?.evidence.position).toBe(4);
  });

  it('describes a control precisely enough to go and find it', () => {
    const line = describeControl(
      control({
        name: '',
        widthDp: 20,
        heightDp: 20,
        evidence: evidence({
          className: 'android.widget.ImageView',
          resourceId: 'android:id/insertion_handle',
          contentDescription: '',
          widthDp: 20,
          heightDp: 20,
          bounds: { left: 516, top: 1040, right: 568, bottom: 1092 },
          ancestry: 'android.widget.FrameLayout > android.widget.PopupWindow$PopupBackgroundView',
        }),
      }),
    );
    expect(line).toContain('(no accessible name)');
    expect(line).toContain('android.widget.ImageView#android:id/insertion_handle');
    expect(line).toContain('20x20dp');
    expect(line).toContain('[516,1040][568,1092]px');
    expect(line).toContain('PopupWindow');
  });
});

describe('SHEET-3 and SHEET-4 say what they found', () => {
  const unnamedHandle = control({
    name: '',
    widthDp: 20,
    heightDp: 20,
    evidence: evidence({
      className: 'android.widget.ImageView',
      resourceId: 'android:id/insertion_handle',
      contentDescription: '',
      widthDp: 20,
      heightDp: 20,
    }),
  });

  it('names the class and the id of an unnamed control', () => {
    const check = namedCheck(survey({ controls: [unnamedHandle] }));
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('android.widget.ImageView');
    expect(check.detail).toContain('android:id/insertion_handle');
  });

  it('names the class and the pixels of an undersized control', () => {
    const check = targetSizeCheck(survey({ controls: [unnamedHandle] }), MIN_DP);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('android.widget.ImageView');
    expect(check.detail).toContain('px');
  });

  it('still fails, which is the point of not weakening it', () => {
    // An unnamed sub-48dp clickable node is a real finding whatever it turns out to be. The
    // instrumentation exists to identify it, not to excuse it.
    expect(namedCheck(survey({ controls: [unnamedHandle] })).status).toBe('FAIL');
    expect(targetSizeCheck(survey({ controls: [unnamedHandle] }), MIN_DP).status).toBe('FAIL');
  });
});

describe('spotting an offending node while it is still on screen', () => {
  const clips = [{ left: 0, top: 0, right: 1080, bottom: 2145 }];
  const PACKAGE = 'com.kynviora.app';

  it('flags a clickable node with no name at all', () => {
    const found = offendingNodes(
      [node({ contentDescription: '', text: '' })],
      clips,
      PACKAGE,
      420,
      MIN_DP,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.offences).toEqual(['UNNAMED']);
  });

  it('flags a fully visible node under the minimum, and reports both offences at once', () => {
    const found = offendingNodes(
      [
        node({
          contentDescription: '',
          text: '',
          bounds: { left: 516, top: 1040, right: 568, bottom: 1092 },
        }),
      ],
      clips,
      PACKAGE,
      420,
      MIN_DP,
    );
    expect(found[0]?.offences).toEqual(['UNNAMED', 'UNDER_MINIMUM']);
  });

  it('does not call a clipped node too small', () => {
    // The same rule `targetSizeCheck` applies, and for the same reason: `uiautomator` reports
    // visible bounds, so measuring a node cut off at a container's edge invents a violation. A
    // capture rule merely *similar* to the check would fire on nodes no check minds.
    const found = offendingNodes(
      [node({ bounds: { left: 76, top: 2115, right: 1004, bottom: 2145 } })],
      clips,
      PACKAGE,
      420,
      MIN_DP,
    );
    expect(found).toHaveLength(0);
  });

  it('leaves the tab bar and other apps alone', () => {
    expect(
      offendingNodes(
        [node({ contentDescription: 'Today' }), node({ packageName: 'com.android.systemui' })],
        clips,
        PACKAGE,
        420,
        MIN_DP,
        ['Today'],
      ),
    ).toHaveLength(0);
  });

  it('says nothing about a control that is named and big enough', () => {
    expect(offendingNodes([node()], clips, PACKAGE, 420, MIN_DP)).toHaveLength(0);
  });

  it('prints the node’s own attributes and what it sits inside', () => {
    // The line written to stdout at the moment of the finding. `raw` is the part that answers
    // "what is that?" when the modelled attributes do not.
    const nodes = parseUiHierarchy(
      `<?xml version='1.0'?><hierarchy rotation="0">` +
        `<node class="android.widget.FrameLayout" package="${PACKAGE}" bounds="[0,0][1080,2400]">` +
        `<node class="android.widget.ImageView" package="${PACKAGE}" clickable="true" ` +
        `resource-id="android:id/insertion_handle" bounds="[516,1040][568,1092]" />` +
        `</node></hierarchy>`,
    );
    const found = offendingNodes(nodes, [], PACKAGE, 420, MIN_DP);
    const offender = found[0];
    expect(offender).toBeDefined();
    const described = describeOffender(
      nodes,
      offender ?? { index: 0, node: node(), offences: [] },
      420,
    );
    expect(described).toContain('UNNAMED');
    expect(described).toContain('20x20dp');
    expect(described).toContain('android.widget.FrameLayout');
    expect(described).toContain('resource-id="android:id/insertion_handle"');
  });
});
