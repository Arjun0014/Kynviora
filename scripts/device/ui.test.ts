/**
 * The parts of the UI driver that decide something, tested with no device attached (DEC-102).
 *
 * Finding a node by its accessible name is the only judgement here; everything else is `adb`
 * plumbing. It is worth testing because the wrong answer is silent: tapping a label instead of the
 * control it labels does nothing at all, and the run then reports what the screen did not do.
 */

import { describe, expect, it } from 'vitest';
import { centreOf, nodeNamed } from './ui.js';
import { parseUiHierarchy, type UiNode } from './accessibility.js';

const PACKAGE = 'com.kynviora.app';

function node(overrides: Partial<UiNode> = {}): UiNode {
  return {
    className: 'android.widget.TextView',
    packageName: PACKAGE,
    text: '',
    contentDescription: '',
    clickable: false,
    enabled: true,
    scrollable: false,
    bounds: { left: 0, top: 0, right: 100, bottom: 100 },
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
