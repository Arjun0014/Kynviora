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

/**
 * A full theme: the seven original tone pairs plus the surfaces, the accent and the selection
 * colour the component set needs.
 *
 * The seven that were here first keep their names and their meanings, because
 * {@link ThemeToneToken} is what `status.ts` and `screenState.ts` map a state onto - a status
 * whose tone was renamed would be a safety statement rendered in the wrong colour, decided in a
 * file that has never heard of safety.
 */
export interface Theme {
  /** Which of the two this is. Read by tests and by anything that must not guess. */
  readonly name: ThemeName;
  readonly surface: ColorPair;
  readonly surfaceMuted: ColorPair;
  readonly neutral: ColorPair;
  readonly informational: ColorPair;
  readonly attention: ColorPair;
  readonly action: ColorPair;
  readonly positive: ColorPair;
  /** The ground a screen is painted on. A card sits **on** this and is not made of it. */
  readonly canvas: ColorPair;
  /** A sheet or a dialog: one step nearer than a card, so a card behind it reads as behind. */
  readonly raised: ColorPair;
  /** An inset well - a text field, a read-only block. One step further away than a card. */
  readonly sunken: ColorPair;
  /**
   * The primary action, and the one colour in this theme that carries no meaning.
   *
   * It is contrast rather than hue, deliberately: `18` reserves hue for state, and an accent that
   * happened to be green or amber would be a fourth thing on a screen already using green and
   * amber to say something about a medicine. So the primary button is near-black on light and
   * near-white on dark, and every hue on a Kynviora screen means something.
   */
  readonly accent: ColorPair;
  /**
   * Chosen, focused, currently-listening. The one hue that is about the interface rather than
   * about a product.
   *
   * Distinct from `informational` on purpose: "this is the tab you are on" and "here is a fact
   * about your medicine" must not be the same colour, or the second stops being noticeable.
   */
  readonly selection: ColorPair;
  readonly line: LinePalette;
}

export type ThemeName = 'LIGHT' | 'DARK';

/**
 * Lines that are not part of a tone.
 *
 * `hairline` separates and is decorative - it is allowed to be quiet, because the thing it
 * separates is already legible without it. `strong` is a real boundary and meets 3:1 against both
 * the canvas and a card in both themes, which is WCAG 1.4.11 for a non-text control. `focus` is
 * the keyboard and switch-access ring, and it is never the only indication of anything.
 */
export interface LinePalette {
  readonly hairline: string;
  readonly strong: string;
  readonly focus: string;
}

export const LIGHT_THEME: Theme = Object.freeze({
  name: 'LIGHT',
  surface: Object.freeze({ background: '#FFFFFF', foreground: '#16191D', border: '#D6DAE0' }),
  surfaceMuted: Object.freeze({ background: '#F4F6F8', foreground: '#3B424B', border: '#D6DAE0' }),
  // Semantic tones. Deliberately desaturated: `02` and `18` require a calm product that does not
  // optimise for alarm, and a saturated red on a safety screen does exactly that.
  neutral: Object.freeze({ background: '#EEF1F4', foreground: '#22272E', border: '#C3C9D1' }),
  informational: Object.freeze({ background: '#E8F0F8', foreground: '#123A5E', border: '#9DBBD6' }),
  attention: Object.freeze({ background: '#FBF1E3', foreground: '#5C3D0B', border: '#D9B47A' }),
  action: Object.freeze({ background: '#FAEAEA', foreground: '#661B1B', border: '#D89B9B' }),
  positive: Object.freeze({ background: '#E9F2EC', foreground: '#1D4A2E', border: '#9CC3AC' }),
  // The ground is a shade off white so that a white card reads as a card rather than as more
  // page. One step of separation, not two: `18` wants a calm surface, and a strongly tinted
  // ground under white cards is the look of a dashboard rather than of a health record.
  canvas: Object.freeze({ background: '#F7F9FB', foreground: '#16191D', border: '#DDE2E8' }),
  raised: Object.freeze({ background: '#FFFFFF', foreground: '#16191D', border: '#C9CFD7' }),
  sunken: Object.freeze({ background: '#EDF0F4', foreground: '#22272E', border: '#D0D6DE' }),
  accent: Object.freeze({ background: '#1B2530', foreground: '#FFFFFF', border: '#1B2530' }),
  selection: Object.freeze({ background: '#E2F3F5', foreground: '#0B4E55', border: '#8FC7CE' }),
  line: Object.freeze({ hairline: '#DDE2E8', strong: '#828B99', focus: '#0E7C86' }),
});

/**
 * The dark theme, at the same rank as the light one.
 *
 * WHY THE GROUND IS NOT BLACK
 * `#0E1116` rather than `#000000`, for two reasons that both point the same way. An elevation
 * ladder needs somewhere below the first step, and on black a card can only ever be lighter, so
 * "further away" stops being expressible. And pure white text on pure black is the highest-glare
 * pairing a screen can produce - halation, which is worse with the astigmatism and lens changes
 * that are ordinary after sixty, and this app's primary audience is older adults (`01`, `18`).
 * The near-black ground and the slightly-off-white text keep the ratio well past AA while taking
 * the glare off it.
 *
 * The seven tone pairs are the light ones inverted in **role**, not in value: a dark background
 * with a light foreground of the same hue family, at the same restraint. `attention` is still
 * amber and `action` is still red, because a person who has learned one theme has learned both.
 */
export const DARK_THEME: Theme = Object.freeze({
  name: 'DARK',
  surface: Object.freeze({ background: '#161A21', foreground: '#F2F5F8', border: '#2E3540' }),
  surfaceMuted: Object.freeze({ background: '#1D222B', foreground: '#B4BECC', border: '#333B47' }),
  neutral: Object.freeze({ background: '#232935', foreground: '#DCE3EC', border: '#3A4351' }),
  informational: Object.freeze({ background: '#152634', foreground: '#9FD0F5', border: '#2C4B66' }),
  attention: Object.freeze({ background: '#2B2213', foreground: '#F0C67C', border: '#5B4620' }),
  action: Object.freeze({ background: '#301A1C', foreground: '#F3A8A8', border: '#63302F' }),
  positive: Object.freeze({ background: '#152A1E', foreground: '#93D6AE', border: '#2A5540' }),
  canvas: Object.freeze({ background: '#0E1116', foreground: '#F2F5F8', border: '#232935' }),
  raised: Object.freeze({ background: '#20262F', foreground: '#F2F5F8', border: '#39424F' }),
  sunken: Object.freeze({ background: '#090C10', foreground: '#DCE3EC', border: '#232935' }),
  accent: Object.freeze({ background: '#E8EDF3', foreground: '#0E1116', border: '#E8EDF3' }),
  selection: Object.freeze({ background: '#0F2B2E', foreground: '#6FDCE4', border: '#1E5A60' }),
  line: Object.freeze({ hairline: '#232935', strong: '#677484', focus: '#5AD1DC' }),
});

/** Both themes, so a test can ask every question of each without naming them twice. */
export const THEMES: Readonly<Record<ThemeName, Theme>> = Object.freeze({
  LIGHT: LIGHT_THEME,
  DARK: DARK_THEME,
});

/**
 * The tone keys a status or a screen state may be rendered in.
 *
 * Narrowed to the seven semantic pairs rather than every key of {@link Theme}: `canvas`,
 * `accent`, `selection` and the rest are surfaces and interface colours, and a safety status
 * that resolved to one of them would be painted in a colour that means nothing.
 */
export const THEME_TONE_TOKENS = [
  'surface',
  'surfaceMuted',
  'neutral',
  'informational',
  'attention',
  'action',
  'positive',
] as const;

export type ThemeToneToken = (typeof THEME_TONE_TOKENS)[number];

/**
 * Every key of a theme that is a {@link ColorPair}.
 *
 * `name` is a string and `line` is not a pair, so a test wanting "every colour pair in this
 * theme" cannot get there from `Object.keys` any more. Listed rather than derived, so adding a
 * pair is a deliberate act that shows up in a diff beside the tests that will start covering it.
 */
export const THEME_PAIR_TOKENS = [
  ...THEME_TONE_TOKENS,
  'canvas',
  'raised',
  'sunken',
  'accent',
  'selection',
] as const;

export type ThemePairToken = (typeof THEME_PAIR_TOKENS)[number];

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

/**
 * Corner radii, in dp.
 *
 * A ladder rather than one value, because a radius is how a surface says how big it is: a chip
 * and a full-bleed sheet drawn at the same radius read as the same kind of object. `pill` is for
 * a control whose shape is its affordance and is never applied to a container.
 */
export const RADIUS = Object.freeze({
  none: 0,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
});
export type RadiusToken = keyof typeof RADIUS;

/**
 * How far a surface is from the ground.
 *
 * The number is Android's `elevation` and the shadow is what iOS draws for the same step, so a
 * component states its distance once and each platform renders it its own way. `12` keeps
 * platform difference behind an adapter; this is the same rule applied to a shadow.
 *
 * `0` is not an absence: a card at level 0 is drawn with its border and no shadow, which is what
 * the dark theme relies on - a shadow on a near-black ground is invisible, so **separation there
 * comes from the surface colour ladder rather than from a shadow**. That is why `canvas`,
 * `surface` and `raised` are three different colours in both themes instead of one colour lifted
 * by a shadow in each.
 */
export interface Elevation {
  readonly android: number;
  readonly shadowOpacity: number;
  readonly shadowRadius: number;
  readonly shadowOffsetY: number;
}

export const ELEVATION = Object.freeze({
  flat: Object.freeze({ android: 0, shadowOpacity: 0, shadowRadius: 0, shadowOffsetY: 0 }),
  card: Object.freeze({ android: 1, shadowOpacity: 0.06, shadowRadius: 6, shadowOffsetY: 2 }),
  raised: Object.freeze({ android: 3, shadowOpacity: 0.1, shadowRadius: 12, shadowOffsetY: 4 }),
  overlay: Object.freeze({ android: 8, shadowOpacity: 0.16, shadowRadius: 24, shadowOffsetY: 8 }),
} satisfies Record<string, Elevation>);
export type ElevationToken = keyof typeof ELEVATION;

/**
 * Motion durations, in milliseconds.
 *
 * Short. Motion here is for continuity - saying where a thing came from - and never for
 * decoration, because `18`'s audience includes people for whom a moving screen is harder to read
 * rather than more delightful. Nothing in this app animates a safety statement into view: a
 * sentence about a medicine is on screen or it is not.
 */
export const DURATION_MS = Object.freeze({
  /** No animation at all. What every duration collapses to under reduce-motion. */
  instant: 0,
  /** A press, a chip toggling, a control acknowledging a tap. */
  quick: 120,
  /** A card expanding, a section disclosing. */
  standard: 200,
  /** A sheet arriving, a screen replacing another. */
  deliberate: 320,
});
export type DurationToken = keyof typeof DURATION_MS;

/**
 * The duration to actually use.
 *
 * Every animation in the app goes through this, so honouring the system's reduce-motion setting
 * is one decision rather than forty. It collapses to zero rather than to something short: `18`
 * treats motion sensitivity as an accessibility setting rather than a preference, and a
 * "reduced" animation that still moves is one that still triggers.
 */
export function motionDuration(token: DurationToken, reduceMotion: boolean): number {
  return reduceMotion ? DURATION_MS.instant : DURATION_MS[token];
}

/**
 * What a haptic means, rather than which motor pattern it is.
 *
 * Named by intent so the platform adapter chooses the pattern (`12`). A component asking for
 * `confirm` gets Android's `EFFECT_HEAVY_CLICK` and iOS's notification-success without knowing
 * either exists, and a person who has turned haptics off gets nothing without any component
 * having to ask.
 *
 * There is no `error` that fires on its own. A refusal is a sentence on the screen first; a
 * buzz that is the only report of a failure is a failure nobody deaf to it can perceive, which
 * is `18`'s rule about a single channel applied to touch.
 */
export const HAPTIC_INTENTS = ['selection', 'confirm', 'warn', 'failure'] as const;
export type HapticIntent = (typeof HAPTIC_INTENTS)[number];

/**
 * A named role in the type system, rather than a bare size.
 *
 * A role carries weight and leading with its size, because those three together are what makes a
 * heading read as a heading - and separating them is how a "title" ends up bold in one file and
 * regular in the next. Sizes are still the {@link FONT_SIZE} scale, so `scaledFontSize` remains
 * the single place system font scaling is applied.
 */
export interface TypeRole {
  readonly size: FontSizeToken;
  readonly weight: '400' | '500' | '600' | '700';
  readonly leading: keyof typeof LINE_HEIGHT_MULTIPLIER;
  /** Letter spacing in dp at 1x. Negative tightens; used only on the two largest roles. */
  readonly tracking: number;
}

export const TYPE_ROLE = Object.freeze({
  /** One per screen, at most. A number or a name that is the whole point of the screen. */
  display: Object.freeze({ size: 'display', weight: '700', leading: 'tight', tracking: -0.5 }),
  /** The screen's own name, announced as a header. */
  heading: Object.freeze({ size: 'heading', weight: '700', leading: 'tight', tracking: -0.3 }),
  /** A card's subject - a medicine's name, a person's name. */
  title: Object.freeze({ size: 'title', weight: '600', leading: 'tight', tracking: 0 }),
  /** The one size up from body, for a sentence that has to be read rather than scanned. */
  bodyLarge: Object.freeze({ size: 'bodyLarge', weight: '400', leading: 'relaxed', tracking: 0 }),
  /** Everything a person reads. 17sp, because `01` and `18` name older adults first. */
  body: Object.freeze({ size: 'body', weight: '400', leading: 'normal', tracking: 0 }),
  /** A control's own text, and the name of a field. */
  label: Object.freeze({ size: 'body', weight: '600', leading: 'tight', tracking: 0 }),
  /** A qualification, a date, a limitation. Never the only place something important is said. */
  caption: Object.freeze({ size: 'caption', weight: '400', leading: 'relaxed', tracking: 0 }),
  /** A short all-caps section marker. Tracked out, because caps at small sizes set tight. */
  overline: Object.freeze({ size: 'caption', weight: '600', leading: 'tight', tracking: 0.8 }),
} satisfies Record<string, TypeRole>);
export type TypeRoleToken = keyof typeof TYPE_ROLE;

/** The resolved size, weight, line height and tracking for a role at a given system font scale. */
export function typeStyle(
  role: TypeRoleToken,
  systemFontScale: number,
): {
  readonly fontSize: number;
  readonly fontWeight: TypeRole['weight'];
  readonly lineHeight: number;
  readonly letterSpacing: number;
} {
  const spec = TYPE_ROLE[role];
  const fontSize = scaledFontSize(spec.size, systemFontScale);
  return {
    fontSize,
    fontWeight: spec.weight,
    lineHeight: Math.round(fontSize * LINE_HEIGHT_MULTIPLIER[spec.leading]),
    // Tracking scales with the text. A fixed value looks tight at 1x and loose at 2x, and at 2x
    // it is the size somebody chose because reading is hard.
    letterSpacing: spec.tracking * Math.max(1, Math.min(systemFontScale, MAX_SUPPORTED_FONT_SCALE)),
  };
}
