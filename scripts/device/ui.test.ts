/**
 * The parts of the UI driver that decide something, tested with no device attached (DEC-102).
 *
 * Finding a node by its accessible name is the only judgement here; everything else is `adb`
 * plumbing. It is worth testing because the wrong answer is silent: tapping a label instead of the
 * control it labels does nothing at all, and the run then reports what the screen did not do.
 */

import { describe, expect, it } from 'vitest';
import {
  centreOf,
  describeMatch,
  nameMatches,
  nodeNamed,
  nodeNamedBelow,
  selectedStateOf,
} from './ui.js';
import { clipRectsOf, isFullyVisible, parseUiHierarchy, type UiNode } from './accessibility.js';

const PACKAGE = 'com.kynviora.app';

function node(overrides: Partial<UiNode> = {}): UiNode {
  return {
    className: 'android.widget.TextView',
    packageName: PACKAGE,
    text: '',
    contentDescription: '',
    resourceId: '',
    clickable: false,
    longClickable: false,
    focusable: false,
    focused: false,
    enabled: true,
    scrollable: false,
    selected: false,
    checked: false,
    bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    depth: 1,
    parent: -1,
    raw: '',
    ...overrides,
  };
}

describe('centreOf', () => {
  it('is the middle of the node, which is where a tap has to land', () => {
    expect(centreOf(node({ bounds: { left: 76, top: 511, right: 731, bottom: 637 } }))).toEqual({
      x: 404,
      y: 574,
    });
  });

  it('rounds rather than truncating, so a one-pixel node still has a centre inside it', () => {
    expect(centreOf(node({ bounds: { left: 0, top: 0, right: 3, bottom: 3 } }))).toEqual({
      x: 2,
      y: 2,
    });
  });
});

describe('nodeNamed', () => {
  it('prefers the control over the label that carries the same name', () => {
    // The previous session's failure, exactly: a `Button` and the `TextView` drawn inside it both
    // announce "Save schedule", and tapping the text does nothing.
    const label = node({
      text: 'Save schedule',
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    const button = node({
      className: 'android.widget.Button',
      contentDescription: 'Save schedule',
      clickable: true,
      bounds: { left: 0, top: 100, right: 200, bottom: 200 },
    });

    expect(nodeNamed([label, button], 'Save schedule')).toBe(button);
  });

  it('still finds a field that is focusable rather than clickable', () => {
    // A `TextInput` reports itself focusable, not clickable, so a clickable-only search would miss
    // every text field in the app.
    const field = node({
      className: 'android.widget.EditText',
      contentDescription: 'Times 1',
      text: '08:00',
    });
    expect(nodeNamed([field], 'Times 1')).toBe(field);
  });

  it('ignores another app’s node with the same name', () => {
    // A screen reader's own chrome, or the stylus tutorial, is not this app's control.
    const foreign = node({ packageName: 'com.google.android.inputmethod', text: 'Cancel' });
    expect(nodeNamed([foreign], 'Cancel')).toBeNull();
  });

  it('matches the whole name rather than part of it', () => {
    const other = node({ text: 'Save schedule and close', clickable: true });
    expect(nodeNamed([other], 'Save schedule')).toBeNull();
  });

  it('reads a name out of a real hierarchy dump', () => {
    const xml =
      '<hierarchy><node class="android.widget.Button" package="com.kynviora.app" text="" ' +
      'content-desc="Add a schedule" clickable="true" enabled="true" scrollable="false" ' +
      'bounds="[76,1780][1004,1908]" /></hierarchy>';
    const found = nodeNamed(parseUiHierarchy(xml), 'Add a schedule');
    expect(found).not.toBeNull();
    expect(centreOf(found!)).toEqual({ x: 540, y: 1844 });
  });
});

describe('nameMatches', () => {
  it('demands the whole name when given a string', () => {
    expect(nameMatches('Save schedule', 'Save schedule')).toBe(true);
    expect(nameMatches('Save schedule and close', 'Save schedule')).toBe(false);
  });

  it('matches a prefix when asked to', () => {
    // Most controls announce a label followed by their own help sentence, which `18` requires and
    // which is expected to be reworded. Pinning the whole string makes a harness fail on an edit
    // that broke nothing.
    const announced =
      'Name. Whatever you call them. It is only ever shown to you and to people you invite.';
    expect(nameMatches(announced, { startsWith: 'Name.' })).toBe(true);
    expect(nameMatches(announced, { startsWith: 'Language.' })).toBe(false);
  });

  it('does not let a prefix match a different field that starts the same way', () => {
    expect(nameMatches('Names of your medicines', { startsWith: 'Name.' })).toBe(false);
  });

  it('reads as something a report can print', () => {
    expect(describeMatch('Done')).toBe('Done');
    expect(describeMatch({ startsWith: 'Name.' })).toBe('Name....');
  });
});

describe('nodeNamedBelow', () => {
  // Two shelf rows, each with an identically named control. Only the heading tells them apart.
  const firstHeading = node({ text: 'Synthetic Tablet A', bounds: rect(100, 200) });
  const firstButton = node({ text: 'Open this item', clickable: true, bounds: rect(300, 400) });
  const secondHeading = node({ text: 'Synthetic Lotion Q', bounds: rect(500, 600) });
  const secondButton = node({ text: 'Open this item', clickable: true, bounds: rect(700, 800) });
  const all = [firstHeading, firstButton, secondHeading, secondButton];

  it('picks the control belonging to the row that was asked for', () => {
    // A plain lookup opens whichever row is first in the hierarchy, so a run measures the wrong
    // medicine while reporting the right name.
    expect(nodeNamed(all, 'Open this item')).toBe(firstButton);
    expect(nodeNamedBelow(all, 'Open this item', 'Synthetic Lotion Q')).toBe(secondButton);
    expect(nodeNamedBelow(all, 'Open this item', 'Synthetic Tablet A')).toBe(firstButton);
  });

  it('finds nothing when the row heading is not on screen', () => {
    expect(nodeNamedBelow(all, 'Open this item', 'Synthetic Capsule B')).toBeNull();
  });

  it('finds nothing when the row is on screen and its control is below the fold', () => {
    // What a newly added item looks like: last on the shelf, its heading clipped to a few pixels
    // at the bottom edge, its button not drawn at all.
    const clipped = node({ text: 'Synthetic Lotion Q', bounds: rect(2135, 2145) });
    expect(
      nodeNamedBelow([firstHeading, firstButton, clipped], 'Open this item', {
        startsWith: 'Synthetic Lotion',
      }),
    ).toBeNull();
  });

  function rect(top: number, bottom: number) {
    return { left: 76, top, right: 1004, bottom };
  }
});

describe('a control that is only just on screen', () => {
  // The failure this rule exists for, and it cost a run. `scrollTo` stops as soon as a control is
  // anywhere on screen, and `uiautomator` reports visible bounds - so a Save button just entering
  // view is a thirty-pixel strip whose centre is under the tab bar. The tap lands on whatever is
  // drawn there, the form stays open, nothing errors, and the run reports a save that produced
  // nothing. It only surfaced when the scroll stopped flinging (trap 190): the overshoot had been
  // carrying every target well inside the viewport.
  const scroller = node({
    scrollable: true,
    bounds: { left: 0, top: 250, right: 1080, bottom: 2209 },
  });

  it('is recognised as cut off at the edge it touches', () => {
    const clipped = node({ text: 'Save', clickable: true, bounds: rect(2180, 2209) });
    expect(isFullyVisible(clipped, clipRectsOf([scroller, clipped]))).toBe(false);
  });

  it('is whole once it sits clear of both edges', () => {
    const whole = node({ text: 'Save', clickable: true, bounds: rect(1780, 1908) });
    expect(isFullyVisible(whole, clipRectsOf([scroller, whole]))).toBe(true);
  });

  function rect(top: number, bottom: number) {
    return { left: 76, top, right: 1004, bottom };
  }
});

describe('selectedStateOf', () => {
  const skinCare = node({ contentDescription: 'Skin care', clickable: true, selected: true });
  const sunscreen = node({ contentDescription: 'Sunscreen', clickable: true });

  it('reports which option a radio group has chosen', () => {
    expect(selectedStateOf([skinCare, sunscreen], 'Skin care')).toBe(true);
    expect(selectedStateOf([skinCare, sunscreen], 'Sunscreen')).toBe(false);
  });

  it('separates "not on screen" from "on screen and not chosen"', () => {
    // The two have different fixes - one is a harness that looked in the wrong place, the other is
    // an app that ignored a tap - so a boolean here would misreport the first as the second.
    expect(selectedStateOf([skinCare, sunscreen], 'Hair care')).toBeNull();
  });
});

describe('nodeNamed with a prefix', () => {
  it('finds the field whose announced name begins with the label', () => {
    const field = node({
      className: 'android.widget.EditText',
      contentDescription: 'Name. Whatever you call them.',
    });
    expect(nodeNamed([field], { startsWith: 'Name.' })).toBe(field);
  });
});
