/**
 * Design tokens.
 *
 * Spec references: `04` Phase 0.3, `18_ACCESSIBILITY_AND_CONTENT_DESIGN.md`.
 *
 * `18` treats senior accessibility as part of the product definition, not a theme. The values
 * here are therefore constraints rather than preferences: a minimum touch target, a type scale
 * that survives system font scaling, and contrast ratios that pass at the sizes actually used.
 *
 * Kept in a platform-neutral package so the same values drive React Native styles, any future
 * web surface, and the tests that assert them.
 */

/**
 * Minimum touch target in density-independent pixels.
 *
 * `18`: "Primary touch targets should be at least 48 x 48 density-independent pixels where
 * practical." Also the Android accessibility guideline minimum.
 */
export const MIN_TOUCH_TARGET_DP = 48;

/**
 * Spacing scale, in dp.
 *
 * A 4dp base with a 2x step at the larger end. Named rather than numeric so a layout cannot
 * quietly drift to an arbitrary value.
 */
export const SPACING = Object.freeze({
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
});
export type SpacingToken = keyof typeof SPACING;

/**
 * Type scale, in scale-independent pixels.
 *
 * `body` is 17sp rather than the more common 14-16sp. `01` and `18` name older adults as a
 * primary audience, and a larger default reduces how often a user must rely on system scaling
 * to read safety content at all.
 */
export const FONT_SIZE = Object.freeze({
  caption: 14,
  body: 17,
  bodyLarge: 19,
  title: 22,
  heading: 28,
  display: 34,
});
export type FontSizeToken = keyof typeof FONT_SIZE;

/**
 * Line heights as a multiplier of font size.
 *
 * Looser than typical for the same reason as the type scale: `18` requires safety copy to be
 * comfortably readable, and tight leading is one of the first things to fail at large text sizes.
 */
export const LINE_HEIGHT_MULTIPLIER = Object.freeze({
  tight: 1.25,
  normal: 1.45,
  relaxed: 1.6,
});

/**
 * Maximum font scale the layout is designed to accommodate.
 *
 * `18` requires supporting system font scaling "without clipping critical content/actions" and
 * requires testing at the largest supported size. Android allows up to 2.0x; this is the value
 * layout tests assert against.
 */
export const MAX_SUPPORTED_FONT_SCALE = 2.0;

/**
 * Compute a scaled font size.
 *
 * Clamped at {@link MAX_SUPPORTED_FONT_SCALE} rather than left unbounded, because beyond the
 * tested range a layout can clip a primary action - and `18` makes a clipped action in a critical
 * journey a release gate. Clamping degrades gracefully instead.
 */
export function scaledFontSize(token: FontSizeToken, systemFontScale: number): number {
  const scale = Math.max(1, Math.min(systemFontScale, MAX_SUPPORTED_FONT_SCALE));
  return Math.round(FONT_SIZE[token] * scale);
}

/**
 * Colour palette.
 *
 * Every semantic colour is paired with a foreground that meets contrast on it. `18` forbids
 * colour from being the only carrier of meaning, so these exist to *support* a text label and an
 * icon - never to replace them.
 */
export interface ColorPair {
  readonly background: string;
  readonly foreground: string;
  /** Border, so a surface remains distinguishable in high-contrast and greyscale modes. */
  readonly border: string;
}

export const LIGHT_THEME = Object.freeze({
  surface: Object.freeze({ background: '#FFFFFF', foreground: '#16191D', border: '#D6DAE0' }),
  surfaceMuted: Object.freeze({ background: '#F4F6F8', foreground: '#3B424B', border: '#D6DAE0' }),
  // Semantic tones. Deliberately desaturated: `02` and `18` require a calm product that does not
  // optimise for alarm, and a saturated red on a safety screen does exactly that.
  neutral: Object.freeze({ background: '#EEF1F4', foreground: '#22272E', border: '#C3C9D1' }),
  informational: Object.freeze({ background: '#E8F0F8', foreground: '#123A5E', border: '#9DBBD6' }),
  attention: Object.freeze({ background: '#FBF1E3', foreground: '#5C3D0B', border: '#D9B47A' }),
  action: Object.freeze({ background: '#FAEAEA', foreground: '#661B1B', border: '#D89B9B' }),
  positive: Object.freeze({ background: '#E9F2EC', foreground: '#1D4A2E', border: '#9CC3AC' }),
} satisfies Record<string, ColorPair>);

export type ThemeToneToken = keyof typeof LIGHT_THEME;

/**
 * Relative luminance per WCAG 2.x.
 *
 * Implemented here rather than pulled in, so the contrast assertions in the test suite are
 * checking the real formula against the real tokens.
 */
export function relativeLuminance(hex: string): number {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    throw new TypeError(`Expected a 6-digit hex colour, received: ${hex}`);
  }

  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }) as [number, number, number];

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two colours, 1:1 to 21:1. */
export function contrastRatio(a: string, b: string): number {
  const lumA = relativeLuminance(a);
  const lumB = relativeLuminance(b);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Minimum contrast for body text.
 *
 * WCAG AA is 4.5:1 for normal text. Applied to every tone pair by test, because `18` requires
 * sufficient contrast in both themes and a semantic tone that fails it would make safety copy
 * unreadable exactly where it matters most.
 */
export const MIN_BODY_CONTRAST_RATIO = 4.5;

/** Minimum contrast for large text (>=18.66px bold or >=24px regular). WCAG AA is 3:1. */
export const MIN_LARGE_TEXT_CONTRAST_RATIO = 3.0;
