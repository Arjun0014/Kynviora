/**
 * The parts of the design system that are decisions rather than colours.
 *
 * Spec references: `18` (font scaling without clipping; motion is an accessibility setting;
 * meaning never carried by one channel), `12` (platform behaviour behind an adapter), DEC-130.
 *
 * The colour assertions live in `presentation.test.ts`, next to the contrast arithmetic they
 * belong to. What is here is the type scale, the elevation ladder, motion and the haptic
 * vocabulary - the things that make two screens look like one product, and which drift silently
 * because nothing renders them.
 */

import { describe, it, expect } from 'vitest';
import {
  DURATION_MS,
  ELEVATION,
  FONT_SIZE,
  HAPTIC_INTENTS,
  LINE_HEIGHT_MULTIPLIER,
  MAX_SUPPORTED_FONT_SCALE,
  MIN_TOUCH_TARGET_DP,
  RADIUS,
  SPACING,
  TYPE_ROLE,
  motionDuration,
  typeStyle,
  type ElevationToken,
  type TypeRoleToken,
} from './tokens.js';

const ROLES = Object.keys(TYPE_ROLE) as readonly TypeRoleToken[];

describe('the type scale', () => {
  it('gives every role a size that exists on the scale', () => {
    for (const role of ROLES) {
      expect(FONT_SIZE[TYPE_ROLE[role].size]).toBeGreaterThan(0);
    }
  });

  it('keeps body at 17sp, which is the decision the audience was chosen for', () => {
    // `01` and `18` name older adults first, and a larger default is how often somebody has to
    // reach for system scaling to read a sentence about their medicine at all.
    expect(typeStyle('body', 1).fontSize).toBe(17);
  });

  it('scales every role with the system font setting, and stops where the layout was tested', () => {
    for (const role of ROLES) {
      const base = typeStyle(role, 1).fontSize;
      expect(typeStyle(role, 1.5).fontSize).toBeGreaterThan(base);
      // Clamped rather than unbounded: past the tested range a layout clips its own primary
      // action, and `18` makes that a release gate. Degrading gracefully beats clipping.
      expect(typeStyle(role, 4).fontSize).toBe(typeStyle(role, MAX_SUPPORTED_FONT_SCALE).fontSize);
    }
  });

  it('never scales below 1, so a system set smaller does not shrink safety copy', () => {
    for (const role of ROLES) {
      expect(typeStyle(role, 0.5).fontSize).toBe(typeStyle(role, 1).fontSize);
    }
  });

  it('gives every role a line height at least as tall as its text', () => {
    for (const role of ROLES) {
      const style = typeStyle(role, 1);
      expect(style.lineHeight).toBeGreaterThanOrEqual(style.fontSize);
      const spec = TYPE_ROLE[role];
      expect(style.lineHeight).toBe(
        Math.round(style.fontSize * LINE_HEIGHT_MULTIPLIER[spec.leading]),
      );
    }
  });

  it('scales tracking with the text rather than leaving it fixed', () => {
    // A fixed letter-spacing looks tight at 1x and loose at 2x - and 2x is the size somebody
    // chose because reading is already hard.
    expect(typeStyle('heading', 2).letterSpacing).toBeCloseTo(
      typeStyle('heading', 1).letterSpacing * 2,
      5,
    );
    expect(typeStyle('body', 2).letterSpacing).toBe(0);
  });

  it('descends: display is the largest role and caption the smallest', () => {
    const sizes = ROLES.map((role) => typeStyle(role, 1).fontSize);
    expect(Math.max(...sizes)).toBe(typeStyle('display', 1).fontSize);
    expect(Math.min(...sizes)).toBe(typeStyle('caption', 1).fontSize);
  });

  it('distinguishes a label from body text by weight rather than by size', () => {
    // A control's text and a sentence are the same size on purpose: `18` wants one readable size,
    // and a control that shrank its own name to look like a control would be the wrong trade.
    expect(typeStyle('label', 1).fontSize).toBe(typeStyle('body', 1).fontSize);
    expect(Number(typeStyle('label', 1).fontWeight)).toBeGreaterThan(
      Number(typeStyle('body', 1).fontWeight),
    );
  });
});

describe('spacing, radius and the touch target', () => {
  it('keeps the spacing scale ascending with no duplicates', () => {
    const values = Object.values(SPACING);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keeps the radius ladder ascending', () => {
    const values = Object.values(RADIUS);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it('keeps a pill unreachable by a container radius', () => {
    // A pill is a shape that says "press me". A card drawn at the same radius would be claiming
    // the same thing, so the value is far enough away that nothing lands on it by arithmetic.
    expect(RADIUS.pill).toBeGreaterThan(RADIUS.xl * 10);
  });

  it('holds the 48dp minimum `18` requires', () => {
    expect(MIN_TOUCH_TARGET_DP).toBe(48);
  });
});

describe('the elevation ladder', () => {
  const LEVELS: readonly ElevationToken[] = ['flat', 'card', 'raised', 'overlay'];

  it('ascends on every dimension at once', () => {
    for (let i = 1; i < LEVELS.length; i += 1) {
      const below = ELEVATION[LEVELS[i - 1] as ElevationToken];
      const above = ELEVATION[LEVELS[i] as ElevationToken];
      expect(above.android).toBeGreaterThan(below.android);
      expect(above.shadowOpacity).toBeGreaterThan(below.shadowOpacity);
      expect(above.shadowRadius).toBeGreaterThan(below.shadowRadius);
      expect(above.shadowOffsetY).toBeGreaterThan(below.shadowOffsetY);
    }
  });

  it('makes flat genuinely flat rather than nearly flat', () => {
    // The dark theme relies on it: a shadow on a near-black ground is invisible, so separation
    // there is the surface colour ladder and a residual shadow would be dirt on the screen.
    expect(ELEVATION.flat).toEqual({
      android: 0,
      shadowOpacity: 0,
      shadowRadius: 0,
      shadowOffsetY: 0,
    });
  });
});

describe('motion', () => {
  it('collapses every duration to zero under reduce-motion', () => {
    // Zero rather than something short. `18` treats motion sensitivity as an accessibility
    // setting rather than a preference, and a reduced animation that still moves still triggers.
    for (const token of Object.keys(DURATION_MS) as (keyof typeof DURATION_MS)[]) {
      expect(motionDuration(token, true)).toBe(0);
    }
  });

  it('keeps every duration short enough not to be waited on', () => {
    for (const value of Object.values(DURATION_MS)) {
      expect(value).toBeLessThanOrEqual(320);
    }
  });

  it('ascends from a press to a screen', () => {
    expect(DURATION_MS.instant).toBeLessThan(DURATION_MS.quick);
    expect(DURATION_MS.quick).toBeLessThan(DURATION_MS.standard);
    expect(DURATION_MS.standard).toBeLessThan(DURATION_MS.deliberate);
  });
});

describe('haptics', () => {
  it('names intents rather than patterns', () => {
    // A component asking for `confirm` must not know which motor pattern that is on which
    // platform (`12`), and must not be able to ask for a pattern directly.
    expect([...HAPTIC_INTENTS]).toEqual(['selection', 'confirm', 'warn', 'failure']);
  });

  it('has no intent that fires on its own as the report of a failure', () => {
    // A buzz that is the only report of a refusal is a report nobody who cannot feel it receives,
    // which is `18`'s single-channel rule applied to touch. `failure` accompanies a sentence; it
    // is never the sentence.
    expect(HAPTIC_INTENTS).not.toContain('error');
  });
});
