/**
 * The rule, in Node, so a device is needed to take the reading and not to decide what it means.
 *
 * `DEV-040`'s requirement: every judgement a device harness makes runs in CI, because the hardware
 * does not. What only hardware can do here is produce the frame; what this file covers is the
 * decoding of it and the verdict that follows, including the two ways a reading can be wrong in
 * the reassuring direction - a ground that belongs to neither theme, and a ground in the right
 * theme with the other theme's colours all over the screen.
 */

import { describe, expect, it } from 'vitest';
import { DARK_THEME, LIGHT_THEME } from '@kynviora/presentation';
import {
  DEFAULT_SAMPLE,
  OPPOSITE_THEME_TOLERANCE,
  PIXEL_FORMAT_RGBA_8888,
  colourShares,
  coloursOf,
  decodeScreencap,
  judgeTheme,
  parseNightMode,
  pixelAt,
  readTheme,
  type Frame,
} from './theme.js';

/** `#RRGGBB` to the three bytes a framebuffer holds it as. */
function bytesOf(colour: string): readonly [number, number, number] {
  const value = Number.parseInt(colour.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** A frame painted a single colour, with optional rows of a second one at the very top. */
function frameOf(
  width: number,
  height: number,
  colour: string,
  bands: readonly {
    readonly fromRow: number;
    readonly toRow: number;
    readonly colour: string;
  }[] = [],
): Frame {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const band = bands.find((entry) => y >= entry.fromRow && y < entry.toRow);
    const [red, green, blue] = bytesOf(band?.colour ?? colour);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 0xff;
    }
  }
  return { width, height, pixels };
}

/** The bytes `adb exec-out screencap` would produce for a frame, with a header of the given size. */
function screencapBytes(
  frame: Frame,
  headerWords: 3 | 4,
  format = PIXEL_FORMAT_RGBA_8888,
): Uint8Array {
  const header = new Uint8Array(headerWords * 4);
  const words = new DataView(header.buffer);
  words.setUint32(0, frame.width, true);
  words.setUint32(4, frame.height, true);
  words.setUint32(8, format, true);
  if (headerWords === 4) words.setUint32(12, 0, true);
  const out = new Uint8Array(header.length + frame.pixels.length);
  out.set(header, 0);
  out.set(frame.pixels, header.length);
  return out;
}

describe('reading the night-mode setting back', () => {
  it('reads what the device answered', () => {
    expect(parseNightMode('Night mode: yes\n')).toBe('yes');
    expect(parseNightMode('Night mode: no\n')).toBe('no');
  });

  it('keeps a setting somebody chose rather than reducing it to on or off', () => {
    // `auto` and `custom_schedule` have to be put back as themselves; a harness that restored
    // `no` would be changing a person's device on its way out.
    expect(parseNightMode('Night mode: auto\n')).toBe('auto');
    expect(parseNightMode('Night mode: custom_schedule\n')).toBe('custom_schedule');
  });

  it('answers null when the device said something else entirely', () => {
    expect(parseNightMode('')).toBeNull();
    expect(parseNightMode('cmd: Can’t find service: uimode\n')).toBeNull();
  });
});

describe('decoding what screencap actually sends', () => {
  const frame = frameOf(4, 3, '#0E1116');

  it('reads a three-word header', () => {
    const decoded = decodeScreencap(screencapBytes(frame, 3));
    expect(decoded).not.toBeNull();
    expect(decoded?.width).toBe(4);
    expect(decoded?.height).toBe(3);
  });

  it('reads a four-word header, which is what Android 13 and later send', () => {
    // Neither size is assumed: the length is arithmetic, and this is the half that would have
    // silently produced colours from the wrong offset.
    const decoded = decodeScreencap(screencapBytes(frame, 4));
    expect(decoded).not.toBeNull();
    expect(pixelAt(decoded as Frame, 0, 0)).toBe('#0E1116');
  });

  it('refuses a buffer whose length matches neither header', () => {
    const bytes = screencapBytes(frame, 3);
    expect(decodeScreencap(bytes.subarray(0, bytes.length - 1))).toBeNull();
  });

  it('refuses a pixel format it cannot read rather than reading it anyway', () => {
    expect(decodeScreencap(screencapBytes(frame, 3, 4))).toBeNull();
  });

  it('refuses something far too short to be a frame', () => {
    expect(decodeScreencap(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('refuses a header claiming no pixels', () => {
    expect(decodeScreencap(screencapBytes(frameOf(0, 0, '#000000'), 3))).toBeNull();
  });
});

describe('reading a pixel', () => {
  const frame = frameOf(2, 2, '#F7F9FB');

  it('answers in the form the tokens are written in', () => {
    expect(pixelAt(frame, 1, 1)).toBe('#F7F9FB');
  });

  it('answers null outside the frame rather than reading another row', () => {
    expect(pixelAt(frame, 2, 0)).toBeNull();
    expect(pixelAt(frame, 0, 2)).toBeNull();
    expect(pixelAt(frame, -1, 0)).toBeNull();
  });
});

describe('counting the colours on a screen', () => {
  it('puts the most common one first, with its share', () => {
    const frame = frameOf(100, 100, '#0E1116', [{ fromRow: 40, toRow: 60, colour: '#20262F' }]);
    const shares = colourShares(frame, { step: 1, verticalInset: 0 });
    expect(shares[0]?.colour).toBe('#0E1116');
    expect(shares[0]?.share).toBeCloseTo(0.8, 5);
    expect(shares[1]?.colour).toBe('#20262F');
    expect(shares[1]?.share).toBeCloseTo(0.2, 5);
  });

  it('skips the bands the system draws in, top and bottom', () => {
    // The status bar and the gesture bar are dark on a phone in dark mode whatever the app does,
    // so counting them would let a light-themed app borrow the system's answer.
    const frame = frameOf(50, 100, '#F7F9FB', [
      { fromRow: 0, toRow: 10, colour: '#000000' },
      { fromRow: 90, toRow: 100, colour: '#000000' },
    ]);
    const shares = colourShares(frame, { step: 1, verticalInset: 0.12 });
    expect(shares.map((entry) => entry.colour)).toEqual(['#F7F9FB']);
  });

  it('is empty for a frame there is nothing to sample in', () => {
    expect(colourShares(frameOf(4, 4, '#000000'), { step: 1, verticalInset: 0.5 })).toEqual([]);
  });

  it('samples something at the default step, on a screen the size of a real one', () => {
    // DEC-102: a default that sampled nothing would make every reading below trivially empty.
    expect(colourShares(frameOf(1080, 2400, '#0E1116'), DEFAULT_SAMPLE).length).toBeGreaterThan(0);
  });
});

describe('the palettes this reading depends on', () => {
  it('collects every surface, border and line colour of a theme', () => {
    const dark = coloursOf(DARK_THEME);
    expect(dark.has(DARK_THEME.canvas.background)).toBe(true);
    expect(dark.has(DARK_THEME.surface.border)).toBe(true);
    expect(dark.has(DARK_THEME.line.focus)).toBe(true);
    expect(dark.size).toBeGreaterThan(20);
  });

  it('shares no colour between the two themes, which is what makes a frame decidable', () => {
    // If a colour were in both, a screen painted in it would answer "either", and this check
    // would be reporting a coincidence as a theme.
    const light = coloursOf(LIGHT_THEME);
    const shared = [...coloursOf(DARK_THEME)].filter((colour) => light.has(colour));
    expect(shared).toEqual([]);
  });
});

describe('what the screen said', () => {
  const darkFrame = frameOf(200, 200, DARK_THEME.canvas.background, [
    { fromRow: 80, toRow: 120, colour: DARK_THEME.raised.background },
  ]);
  const lightFrame = frameOf(200, 200, LIGHT_THEME.canvas.background);

  it('names the theme the ground belongs to', () => {
    const reading = readTheme(colourShares(darkFrame, { step: 1, verticalInset: 0 }));
    expect(reading?.ground).toBe(DARK_THEME.canvas.background);
    expect(reading?.groundTheme).toBe('DARK');
    expect(reading?.darkShare).toBeCloseTo(1, 5);
    expect(reading?.lightShare).toBe(0);
  });

  it('names the other one when that is what was painted', () => {
    const reading = readTheme(colourShares(lightFrame, { step: 1, verticalInset: 0 }));
    expect(reading?.groundTheme).toBe('LIGHT');
  });

  it('says neither when the ground belongs to neither', () => {
    const reading = readTheme(
      colourShares(frameOf(20, 20, '#123456'), { step: 1, verticalInset: 0 }),
    );
    expect(reading?.groundTheme).toBeNull();
  });

  it('is null rather than a reading about nothing', () => {
    expect(readTheme([])).toBeNull();
  });

  it('keeps three colours for the report', () => {
    const frame = frameOf(60, 60, DARK_THEME.canvas.background, [
      { fromRow: 10, toRow: 25, colour: DARK_THEME.raised.background },
      { fromRow: 25, toRow: 35, colour: DARK_THEME.surface.background },
      { fromRow: 35, toRow: 40, colour: DARK_THEME.sunken.background },
    ]);
    expect(readTheme(colourShares(frame, { step: 1, verticalInset: 0 }))?.top).toHaveLength(3);
  });
});

describe('the verdict', () => {
  const reading = (frame: Frame) => readTheme(colourShares(frame, { step: 1, verticalInset: 0 }));

  it('passes a dark ground when the system is in dark mode', () => {
    const verdict = judgeTheme(reading(frameOf(50, 50, DARK_THEME.canvas.background)), 'DARK');
    expect(verdict.status).toBe('PASS');
    expect(verdict.detail).toContain(DARK_THEME.canvas.background);
  });

  it('fails a light ground under a dark system, and says whose shape that is', () => {
    // `DEV-077` exactly: every unit test green, both themes AA in Node, one of them unreachable.
    const verdict = judgeTheme(reading(frameOf(50, 50, LIGHT_THEME.canvas.background)), 'DARK');
    expect(verdict.status).toBe('FAIL');
    expect(verdict.detail).toContain('DEV-077');
    expect(verdict.detail).toContain(LIGHT_THEME.canvas.background);
  });

  it('fails a ground that belongs to neither theme, and says what it was', () => {
    const verdict = judgeTheme(reading(frameOf(50, 50, '#123456')), 'DARK');
    expect(verdict.status).toBe('FAIL');
    expect(verdict.detail).toContain('#123456');
    expect(verdict.detail).toContain('neither');
  });

  it('fails a right-looking ground with too much of the other theme beside it', () => {
    // A screen can be mostly right and still be wrong: half a light-themed sheet over a dark
    // ground would otherwise pass on the strength of the ground alone.
    const frame = frameOf(100, 100, DARK_THEME.canvas.background, [
      { fromRow: 0, toRow: 40, colour: LIGHT_THEME.surface.background },
    ]);
    const verdict = judgeTheme(reading(frame), 'DARK');
    expect(verdict.status).toBe('FAIL');
    expect(verdict.detail).toContain("other theme's colours");
  });

  it('tolerates a trace of the other theme, because a screenshot is not a paint program', () => {
    const rows = Math.floor(100 * OPPOSITE_THEME_TOLERANCE * 0.5);
    const frame = frameOf(100, 100, DARK_THEME.canvas.background, [
      { fromRow: 0, toRow: rows, colour: LIGHT_THEME.surface.background },
    ]);
    expect(judgeTheme(reading(frame), 'DARK').status).toBe('PASS');
  });

  it('reports a reading that could not be taken as inconclusive, never as a pass', () => {
    // DEC-102: "could not look" is never "looked and it was fine".
    const verdict = judgeTheme(null, 'DARK');
    expect(verdict.status).toBe('INCONCLUSIVE');
    expect(verdict.detail).toContain('nothing was read');
  });

  it('judges the light direction too, so the check is not dark-mode-only by construction', () => {
    expect(
      judgeTheme(reading(frameOf(50, 50, LIGHT_THEME.canvas.background)), 'LIGHT').status,
    ).toBe('PASS');
    expect(judgeTheme(reading(frameOf(50, 50, DARK_THEME.canvas.background)), 'LIGHT').status).toBe(
      'FAIL',
    );
  });
});
