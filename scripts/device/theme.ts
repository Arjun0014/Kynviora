/**
 * Which theme the app is actually rendering in, read off the framebuffer.
 *
 * Spec references: `18` (both themes at AA), `19` (a device scenario measures what only a device
 * can show), DEC-102, DEC-137, `DEV-077`.
 *
 * WHY THIS EXISTS
 * `DEV-077` was one line of `app.json` - `"userInterfaceStyle": "light"` - which makes Expo call
 * `setDefaultNightMode(MODE_NIGHT_NO)` at every activity create, so `useColorScheme()` returned
 * `'light'` on a phone in dark mode and `FOLLOW_SYSTEM` could only ever resolve to light. Both
 * themes were asserted at AA in Node, by tests that all passed, over a build in which one of them
 * was unreachable. No unit test could see it and none ever will: the theme is a property of what
 * a phone draws.
 *
 * It was measured by hand on 2026-09-07 - one `adb shell cmd uimode night yes`, a screencap, a
 * pixel read - and a measurement nothing repeats is not a check. This is that measurement written
 * down.
 *
 * WHY THE FRAMEBUFFER AND NOT THE HIERARCHY
 * `uiautomator dump` reports bounds, names and flags. It reports no colour at all, so the one
 * question this asks - what did the phone actually paint - is not answerable from it.
 *
 * WHY A SHARE AND NOT ONE PIXEL
 * A pixel read needs somewhere to read, and "somewhere the ground shows through" moves with the
 * screen, the font scale and the data. Counting instead is indifferent to all three: the app's
 * own surfaces are flat token colours, so the most common colour on a screen **is** a token, and
 * which theme that token belongs to is the answer. The share of each theme is reported alongside
 * it, because "the ground was dark and a tenth of the screen was light-theme colours" is a
 * different finding from "the app is in dark mode".
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * Decode PNG. `adb exec-out screencap -p` would need a decoder this repository does not have and
 * does not want; the raw form is a header and packed pixels, which is arithmetic.
 */

import { LIGHT_THEME, DARK_THEME, type Theme, type ThemeName } from '@kynviora/presentation';

/**
 * The night-mode setting from `cmd uimode night`, lowercased, or `null` where it did not answer.
 *
 * The value is returned rather than a boolean because it has to be **put back**, and `auto` and
 * `custom_schedule` are settings a person chose that a harness must not quietly replace with `no`.
 */
export function parseNightMode(raw: string): string | null {
  const match = /Night mode:\s*(\S+)/i.exec(raw);
  return match === null ? null : (match[1] as string).toLowerCase();
}

/** A decoded frame: RGBA, four bytes per pixel, row-major, no stride padding. */
export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** Android's `PIXEL_FORMAT_RGBA_8888`, the only format this reads. */
export const PIXEL_FORMAT_RGBA_8888 = 1;

/**
 * Decode the raw output of `adb exec-out screencap`.
 *
 * The header is three or four little-endian 32-bit words - width, height, pixel format, and since
 * Android 13 a colour space - and which one it is depends on the platform rather than on anything
 * this harness can ask a device. So it is not guessed: the length is arithmetic, and the header is
 * whichever size makes `bytes.length - header === width * height * 4`. A buffer that satisfies
 * neither, or that announces a format this cannot read, comes back `null` rather than as pixels,
 * because a misread header is a confident colour reading about the wrong bytes.
 */
export function decodeScreencap(bytes: Uint8Array): Frame | null {
  if (bytes.length < 16) return null;
  const words = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = words.getUint32(0, true);
  const height = words.getUint32(4, true);
  const format = words.getUint32(8, true);
  if (width === 0 || height === 0 || format !== PIXEL_FORMAT_RGBA_8888) return null;

  const expected = width * height * 4;
  const header = [12, 16].find((size) => bytes.length - size === expected);
  if (header === undefined) return null;

  return { width, height, pixels: bytes.subarray(header) };
}

/** `#RRGGBB` for the pixel at (x, y), or `null` outside the frame. Alpha is ignored. */
export function pixelAt(frame: Frame, x: number, y: number): string | null {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null;
  const offset = (y * frame.width + x) * 4;
  const red = frame.pixels[offset];
  const green = frame.pixels[offset + 1];
  const blue = frame.pixels[offset + 2];
  if (red === undefined || green === undefined || blue === undefined) return null;
  return `#${[red, green, blue].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** A colour and how much of the sampled area it covered. */
export interface ColourShare {
  readonly colour: string;
  readonly count: number;
  readonly share: number;
}

/** How the frame is sampled. */
export interface SampleOptions {
  /** Every nth pixel in each direction. */
  readonly step: number;
  /**
   * Fraction of the frame's height skipped at the top and at the bottom.
   *
   * The status bar and the gesture bar are the system's, not the app's, and on a phone in dark
   * mode they are dark whatever the app does - so counting them would let a light-themed app
   * borrow the system's answer.
   */
  readonly verticalInset: number;
}

export const DEFAULT_SAMPLE: SampleOptions = Object.freeze({ step: 8, verticalInset: 0.12 });

/** The colours of a frame, sampled on a grid, most common first. */
export function colourShares(
  frame: Frame,
  options: SampleOptions = DEFAULT_SAMPLE,
): readonly ColourShare[] {
  const top = Math.floor(frame.height * options.verticalInset);
  const bottom = frame.height - top;
  const counts = new Map<string, number>();
  let sampled = 0;

  for (let y = top; y < bottom; y += options.step) {
    for (let x = 0; x < frame.width; x += options.step) {
      const colour = pixelAt(frame, x, y);
      if (colour === null) continue;
      counts.set(colour, (counts.get(colour) ?? 0) + 1);
      sampled += 1;
    }
  }
  if (sampled === 0) return [];

  return [...counts.entries()]
    .map(([colour, count]) => ({ colour, count, share: count / sampled }))
    .sort((left, right) => right.count - left.count || left.colour.localeCompare(right.colour));
}

/** Every colour a theme paints a surface, a border or a line with. */
export function coloursOf(theme: Theme): ReadonlySet<string> {
  const found = new Set<string>();
  for (const value of Object.values(theme)) {
    if (typeof value !== 'object') continue;
    for (const colour of Object.values(value as Record<string, string>)) {
      if (typeof colour === 'string' && colour.startsWith('#')) found.add(colour.toUpperCase());
    }
  }
  return found;
}

/** What the screen said about which theme it is in. */
export interface ThemeReading {
  /** The most common colour in the sampled area. */
  readonly ground: string;
  /** The theme that colour belongs to, or `null` where it belongs to neither. */
  readonly groundTheme: ThemeName | null;
  readonly lightShare: number;
  readonly darkShare: number;
  /** The three most common colours, for a report that has to say what was there. */
  readonly top: readonly ColourShare[];
}

/**
 * Read a theme off a frame's colours.
 *
 * Returns `null` for an empty sample rather than a reading about nothing - a frame nothing could
 * be sampled from is "could not look", which DEC-102 refuses to record as an answer.
 */
export function readTheme(shares: readonly ColourShare[]): ThemeReading | null {
  const ground = shares[0];
  if (ground === undefined) return null;

  const light = coloursOf(LIGHT_THEME);
  const dark = coloursOf(DARK_THEME);
  const shareOf = (palette: ReadonlySet<string>): number =>
    shares.reduce((total, entry) => (palette.has(entry.colour) ? total + entry.share : total), 0);

  return {
    ground: ground.colour,
    groundTheme: dark.has(ground.colour) ? 'DARK' : light.has(ground.colour) ? 'LIGHT' : null,
    lightShare: shareOf(light),
    darkShare: shareOf(dark),
    top: shares.slice(0, 3),
  };
}

/**
 * How much of the other theme is allowed on screen before the reading stops being one.
 *
 * Not zero, because a screenshot is not a paint program: antialiased text and a shadow produce
 * colours near a token, and one of them can land exactly on a token of the other theme by
 * coincidence. One percent of a sampled screen is far more than that and far less than a surface.
 */
export const OPPOSITE_THEME_TOLERANCE = 0.01;

export interface ThemeVerdict {
  readonly status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  readonly detail: string;
}

/** Round a share for a report, where three decimal places is noise. */
function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function describeTop(reading: ThemeReading): string {
  return reading.top.map((entry) => `${entry.colour} ${percent(entry.share)}`).join(', ');
}

/**
 * Judge a reading against the theme the system was put into.
 *
 * A reading that could not be taken is `INCONCLUSIVE`; a screen painted in the other theme's
 * colours is the `DEV-077` failure and is `FAIL`; a ground belonging to neither theme is also
 * `FAIL`, and says what was there instead, because an app painting something else is a finding
 * whatever the cause.
 */
export function judgeTheme(reading: ThemeReading | null, expected: ThemeName): ThemeVerdict {
  if (reading === null) {
    return {
      status: 'INCONCLUSIVE',
      detail: 'No pixels could be sampled, so nothing was read about the theme.',
    };
  }

  const opposite = expected === 'DARK' ? reading.lightShare : reading.darkShare;
  const shares = `${percent(reading.darkShare)} of the sampled screen is DARK theme colours and ${percent(reading.lightShare)} is LIGHT theme colours; most common: ${describeTop(reading)}`;

  if (reading.groundTheme === null) {
    return {
      status: 'FAIL',
      detail:
        `The system was in ${expected} mode and the most common colour on screen, ` +
        `${reading.ground}, belongs to neither theme - ${shares}.`,
    };
  }

  if (reading.groundTheme !== expected) {
    return {
      status: 'FAIL',
      detail:
        `The system was in ${expected} mode and the app painted its ground in ` +
        `${reading.groundTheme}: ${reading.ground} - ${shares}. This is \`DEV-077\`'s shape: a ` +
        'theme asserted at AA in Node that a phone cannot reach.',
    };
  }

  if (opposite > OPPOSITE_THEME_TOLERANCE) {
    return {
      status: 'FAIL',
      detail:
        `The ground is ${expected} (${reading.ground}) but ${percent(opposite)} of the sampled ` +
        `screen is the other theme's colours, which is more than a shadow or an antialiased ` +
        `edge - ${shares}.`,
    };
  }

  return {
    status: 'PASS',
    detail: `The app painted its ground in ${expected}: ${reading.ground} - ${shares}.`,
  };
}
