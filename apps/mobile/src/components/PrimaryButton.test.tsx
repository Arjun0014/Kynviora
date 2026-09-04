/**
 * The one control every screen in this app is built out of.
 *
 * Spec references: `18` (a name a screen reader can announce; state never by colour alone; system
 * font scaling supported to a stated ceiling), `19`, DEC-103.
 *
 * WHAT IS BEING MEASURED HERE AND WHAT IS NOT
 * The decisions: that the label is always the accessible name, that `disabled` is announced as
 * well as dimmed, and that the size the component asks for grows with the font scale and stops at
 * the ceiling the presentation layer declares. Whether the result is actually 48dp on a screen is
 * `verify:device:a11y`'s question and it needs a layout engine; this is the half that is decided
 * in this file, and until now nothing looked at it at all (`DEV-043`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { MAX_SUPPORTED_FONT_SCALE, MIN_TOUCH_TARGET_DP } from '@kynviora/presentation';
import { resetWindowDimensions, setWindowDimensions } from '../../test/reactNativeStub.js';
import { findByName, press, renderScreen, textOf, type Rendered } from '../../test/render.js';
import { PrimaryButton } from './PrimaryButton';

afterEach(() => {
  resetWindowDimensions();
});

/** The flattened style the button asked for, which is what a layout engine would be given. */
function minHeightOf(rendered: Rendered, label: string): number {
  const node = findByName(rendered, label);
  const style = node?.props['style'] as readonly Record<string, unknown>[] | undefined;
  const entry = style?.find(
    (part) => part !== null && typeof part === 'object' && 'minHeight' in part,
  );
  return typeof entry?.['minHeight'] === 'number' ? entry['minHeight'] : 0;
}

describe('what a screen reader is told', () => {
  it('announces the label, as a button', () => {
    const rendered = renderScreen(
      <PrimaryButton label="Record what happened" onPress={() => undefined} />,
    );
    const node = findByName(rendered, 'Record what happened');
    expect(node).not.toBeNull();
    expect(node?.props['accessibilityRole']).toBe('button');
  });

  it('says it is disabled rather than only looking it', () => {
    // `18` forbids meaning through appearance alone. The opacity is the visible half; this is the
    // half a person who cannot see it depends on, and it is the half that is easy to forget.
    const rendered = renderScreen(
      <PrimaryButton label="Confirm and create the link" disabled onPress={() => undefined} />,
    );
    const node = findByName(rendered, 'Confirm and create the link');
    expect(node?.props['accessibilityState']).toEqual({ disabled: true });
    expect(node?.props['disabled']).toBe(true);
  });

  it('keeps the label as the visible text as well as the announced name', () => {
    // Two different props on two different nodes, and a change to either alone is a control whose
    // name and appearance disagree - which on a device reads as the wrong button.
    const rendered = renderScreen(<PrimaryButton label="I took it" onPress={() => undefined} />);
    expect(textOf(findByName(rendered, 'I took it')!)).toBe('I took it');
  });

  it('carries a hint only when one was given', () => {
    // Spread conditionally in the source, because an `accessibilityHint` of `undefined` is a prop
    // React Native still sees. Asserted because the conditional spread is the kind of thing a
    // tidy-up removes.
    const without = renderScreen(<PrimaryButton label="Back" onPress={() => undefined} />);
    expect(findByName(without, 'Back')?.props).not.toHaveProperty('accessibilityHint');

    const withHint = renderScreen(
      <PrimaryButton
        label="Back"
        accessibilityHint="Return to the shelf"
        onPress={() => undefined}
      />,
    );
    expect(findByName(withHint, 'Back')?.props['accessibilityHint']).toBe('Return to the shelf');
  });
});

describe('what happens when it is pressed', () => {
  it('calls onPress', () => {
    let pressed = 0;
    const rendered = renderScreen(
      <PrimaryButton
        label="Add a schedule"
        onPress={() => {
          pressed += 1;
        }}
      />,
    );
    press(rendered, 'Add a schedule');
    expect(pressed).toBe(1);
  });

  it('is not pressable while disabled', () => {
    // The prop and the state agree, so the platform refuses the press. Worth pinning because a
    // disabled control that still fires is the same defect as one that was never disabled, and it
    // is invisible from the screen.
    const rendered = renderScreen(
      <PrimaryButton label="Send" disabled onPress={() => undefined} />,
    );
    expect(findByName(rendered, 'Send')?.props['disabled']).toBe(true);
  });
});

describe('what it asks for as the font scale grows', () => {
  it('never asks for less than the minimum target', () => {
    const rendered = renderScreen(<PrimaryButton label="Shelf" onPress={() => undefined} />);
    expect(minHeightOf(rendered, 'Shelf')).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_DP);
  });

  it('grows with the scale', () => {
    setWindowDimensions({ fontScale: 2 });
    const rendered = renderScreen(<PrimaryButton label="Shelf" onPress={() => undefined} />);
    expect(minHeightOf(rendered, 'Shelf')).toBeGreaterThan(MIN_TOUCH_TARGET_DP);
  });

  it('stops at the ceiling the presentation layer declares', () => {
    // A person can set a scale beyond what this app supports, and `MAX_SUPPORTED_FONT_SCALE` is
    // where the design stops promising. Without the clamp a control would keep growing past the
    // screen - which is the same outcome as the clipping `18` forbids, reached from the other
    // direction.
    setWindowDimensions({ fontScale: MAX_SUPPORTED_FONT_SCALE });
    const atCeiling = renderScreen(<PrimaryButton label="Shelf" onPress={() => undefined} />);
    const heightAtCeiling = minHeightOf(atCeiling, 'Shelf');

    setWindowDimensions({ fontScale: MAX_SUPPORTED_FONT_SCALE + 3 });
    const beyond = renderScreen(<PrimaryButton label="Shelf" onPress={() => undefined} />);
    expect(minHeightOf(beyond, 'Shelf')).toBe(heightAtCeiling);
  });

  it('never shrinks below the minimum when the scale is below 1', () => {
    // Android allows a scale under 1. Multiplying through it would take the target under 48dp,
    // which is the floor `18` sets regardless of anybody's text preference.
    setWindowDimensions({ fontScale: 0.5 });
    const rendered = renderScreen(<PrimaryButton label="Shelf" onPress={() => undefined} />);
    expect(minHeightOf(rendered, 'Shelf')).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_DP);
  });
});
