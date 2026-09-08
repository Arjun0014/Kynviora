import { describe, expect, it } from 'vitest';
import {
  classifyChange,
  summarizeChange,
  type ChangeClass,
  type ChangeEntry,
} from '@kynviora/domain';
import {
  CHANGE_COUNTS_DISCLAIMER,
  changeClassPresentation,
  changeCountSentence,
  changeRowPresentation,
  directionGlyph,
  directionWord,
} from './changeLens.js';
import { ICON_NAMES } from './status.js';
import { THEME_PAIR_TOKENS, THEME_TONE_TOKENS, THEMES, type ThemeName } from './tokens.js';

const CLASSES: readonly ChangeClass[] = ['CHANGED', 'NEW', 'NOT_REPEATED', 'SIMILAR'];

describe('the change tone', () => {
  it('is a pair on every theme, so it is contrast-tested like the rest', () => {
    expect(THEME_PAIR_TOKENS).toContain('change');
    for (const name of Object.keys(THEMES) as readonly ThemeName[]) {
      expect(THEMES[name].change.background).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('is NOT a tone a safety status can resolve to', () => {
    // The structural half of DEC-153. `ThemeToneToken` is the codomain of `status.ts`, so keeping
    // `change` out of it makes "a safety status painted as a change" unrepresentable rather than
    // merely discouraged. If somebody adds it to the tone list to save a union, this fails.
    expect(THEME_TONE_TOKENS as readonly string[]).not.toContain('change');
  });

  it('is visibly a different colour from informational in both themes', () => {
    // The reason the tone exists: a change drawn in informational blue reads as a footnote. If a
    // future palette edit converged the two, every change on every screen would quietly stop
    // being distinguishable from a fact.
    for (const name of Object.keys(THEMES) as readonly ThemeName[]) {
      const theme = THEMES[name];
      expect(theme.change.foreground).not.toBe(theme.informational.foreground);
      expect(theme.change.background).not.toBe(theme.informational.background);
      expect(theme.change.foreground).not.toBe(theme.action.foreground);
      expect(theme.change.foreground).not.toBe(theme.selection.foreground);
    }
  });
});

describe('changeClassPresentation', () => {
  it('gives every class a label, a shape and a sentence', () => {
    for (const classification of CLASSES) {
      const p = changeClassPresentation(classification);
      expect(p.label.length).toBeGreaterThan(0);
      expect(ICON_NAMES as readonly string[]).toContain(p.iconName);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.accessibilityLabel.length).toBeGreaterThan(0);
    }
  });

  it('draws only what actually differs in the change tone', () => {
    // A section of results that did not move must not carry the colour that means "this moved".
    expect(changeClassPresentation('CHANGED').tone).toBe('change');
    expect(changeClassPresentation('NEW').tone).toBe('change');
    expect(changeClassPresentation('SIMILAR').tone).not.toBe('change');
    expect(changeClassPresentation('NOT_REPEATED').tone).not.toBe('change');
  });

  it('never draws a change in the action tone', () => {
    // `action` is reserved for a reviewed concern with a next step. A formula change or a moved
    // lab value is not that, and painting it red is the thing DEC-153 exists to stop.
    for (const classification of CLASSES) {
      expect(changeClassPresentation(classification).tone).not.toBe('action');
    }
  });

  it('collapses only the section that did not change', () => {
    expect(changeClassPresentation('SIMILAR').collapsedByDefault).toBe(true);
    expect(changeClassPresentation('CHANGED').collapsedByDefault).toBe(false);
    expect(changeClassPresentation('NEW').collapsedByDefault).toBe(false);
    expect(changeClassPresentation('NOT_REPEATED').collapsedByDefault).toBe(false);
  });

  it('says "not repeated" rather than asserting a reason nobody knows', () => {
    const p = changeClassPresentation('NOT_REPEATED');
    expect(p.label).toBe('Not repeated');
    expect(p.description).toMatch(/does not know why/i);
    expect(p.label.toLowerCase()).not.toMatch(/removed|missing|stopped/);
  });

  it('resolves a class from outside the vocabulary as an own property', () => {
    // DEC-147.
    const rogue = changeClassPresentation('constructor' as ChangeClass);
    expect(rogue.label).toBe('Similar');
    expect(typeof rogue.label).toBe('string');
  });
});

describe('changeRowPresentation', () => {
  const row = (entry: ChangeEntry, decimals?: number) => changeRowPresentation(entry, decimals);

  it('renders both values, the delta and the proportion', () => {
    const entry = classifyChange(
      {
        key: 'tsh',
        label: 'TSH',
        current: { value: 5.2, unit: 'mIU/L' },
        previous: { value: 4.8, unit: 'mIU/L' },
      },
      'REPEAT',
    );
    const p = row(entry, 1);
    expect(p.previousText).toBe('4.8 mIU/L');
    expect(p.currentText).toBe('5.2 mIU/L');
    expect(p.deltaText).toBe('+0.4');
    expect(p.relativeText).toBe('8.3%');
    expect(p.directionGlyph).toBe('▲');
    expect(p.tone).toBe('change');
  });

  it('does not pad a delta with precision the source never reported', () => {
    // `toFixed(2)` would render this as "+0.40", which claims a hundredth the report did not give.
    const entry = classifyChange(
      { key: 'x', label: 'X', current: { value: 5.2 }, previous: { value: 4.8 } },
      'REPEAT',
    );
    expect(row(entry, 2).deltaText).toBe('+0.4');
  });

  it('uses a minus sign rather than a hyphen for a fall', () => {
    const entry = classifyChange(
      { key: 'x', label: 'X', current: { value: 2.4 }, previous: { value: 3.2 } },
      'PERIODIC',
    );
    expect(row(entry, 1).deltaText).toBe('−0.8');
    expect(row(entry, 1).directionGlyph).toBe('▼');
  });

  it('says why there is no delta instead of leaving a blank that reads as "unchanged"', () => {
    const entry = classifyChange(
      {
        key: 'crp',
        label: 'CRP',
        current: { value: 0.9, unit: 'mg/dL' },
        previous: { value: 9, unit: 'mg/L' },
      },
      'PERIODIC',
    );
    const p = row(entry);
    expect(p.deltaText).toBeNull();
    expect(p.incomparableNote).toMatch(/unit changed/i);
    expect(p.accessibilityLabel).toMatch(/unit changed/i);
  });

  it('announces the conclusion before the arithmetic', () => {
    const entry = classifyChange(
      { key: 'ft4', label: 'Free T4', current: { value: 19.4 }, previous: { value: 15.1 } },
      'PERIODIC',
    );
    const said = row(entry, 1).accessibilityLabel;
    expect(said.indexOf('Changed')).toBeLessThan(said.indexOf('15.1'));
    expect(said).toContain('Free T4');
    expect(said).toContain('up by');
  });

  it('announces a not-repeated result with the value the earlier record had', () => {
    const entry = classifyChange(
      { key: 'b12', label: 'Vitamin B12', current: null, previous: { value: 410, unit: 'pg/mL' } },
      'PERIODIC',
    );
    const p = row(entry, 0);
    expect(p.currentText).toBeNull();
    expect(p.previousText).toBe('410 pg/mL');
    expect(p.accessibilityLabel).toMatch(/Was 410 pg\/mL\. Not measured in this record\./);
  });

  it('renders a text result as the source wrote it', () => {
    const entry = classifyChange(
      {
        key: 'hbsag',
        label: 'HBsAg',
        current: { value: null, text: 'Detected' },
        previous: { value: null, text: 'Not detected' },
      },
      'PERIODIC',
    );
    const p = row(entry);
    expect(p.currentText).toBe('Detected');
    expect(p.deltaText).toBeNull();
    expect(p.incomparableNote).toMatch(/word for word/i);
  });

  it('renders a value with no unit without a trailing space', () => {
    const entry = classifyChange(
      { key: 'x', label: 'X', current: { value: 7 }, previous: { value: 7 } },
      'PERIODIC',
    );
    expect(row(entry, 0).currentText).toBe('7');
  });
});

describe('directions', () => {
  it('has a shape and a word for each, so nothing rests on the arrow', () => {
    expect(directionGlyph('UP')).toBe('▲');
    expect(directionGlyph('DOWN')).toBe('▼');
    expect(directionWord('UP')).toBe('up');
    expect(directionWord('NONE')).toBe('unchanged');
  });
});

describe('changeCountSentence', () => {
  const entries = [
    { key: 'a', label: 'A', current: { value: 5 }, previous: { value: 4 } },
    { key: 'b', label: 'B', current: { value: 4 }, previous: { value: 4 } },
    { key: 'c', label: 'C', current: { value: 9 }, previous: null },
    { key: 'd', label: 'D', current: null, previous: { value: 2 } },
  ];

  it('states the denominator before the counts', () => {
    const summary = summarizeChange(entries, 'PERIODIC');
    const sentence = changeCountSentence(summary.counts, summary.comparedCount);
    expect(sentence).toBe('2 results measured in both records. 1 changed, 1 new, 1 not repeated.');
  });

  it('says plainly when nothing moved rather than printing a row of zeros', () => {
    const summary = summarizeChange(
      [{ key: 'a', label: 'A', current: { value: 4 }, previous: { value: 4 } }],
      'PERIODIC',
    );
    expect(changeCountSentence(summary.counts, summary.comparedCount)).toBe(
      '1 result measured in both records. Nothing changed, and nothing was added or dropped.',
    );
  });

  it('carries a disclaimer that a count is not a verdict, as a constant no screen can soften', () => {
    expect(CHANGE_COUNTS_DISCLAIMER).toMatch(/not a judgement about health/i);
  });
});
