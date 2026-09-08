import { describe, expect, it } from 'vitest';
import {
  CHANGE_THRESHOLDS,
  CHANGE_THRESHOLD_STATEMENTS,
  classifyChange,
  pairByKey,
  summarizeChange,
  type ChangeInterval,
  type ComparableEntry,
  type ComparableValue,
} from './changeLens.js';

const n = (value: number, unit = 'mIU/L'): ComparableValue => ({ value, unit });
const t = (text: string): ComparableValue => ({ value: null, text });

function entry(
  key: string,
  current: ComparableValue | null,
  previous: ComparableValue | null,
): ComparableEntry {
  return { key, label: key.toUpperCase(), current, previous };
}

describe('classifyChange', () => {
  it('calls a move past the interval threshold a change and one under it similar', () => {
    // 4.0 -> 4.5 is +12.5%: over a tenth, under nothing.
    expect(classifyChange(entry('tsh', n(4.5), n(4.0)), 'PERIODIC').classification).toBe('CHANGED');
    // 4.0 -> 4.3 is +7.5%: under a tenth for a year-on-year comparison...
    expect(classifyChange(entry('tsh', n(4.3), n(4.0)), 'PERIODIC').classification).toBe('SIMILAR');
    // ...and over a twentieth for a deliberate repeat, which is the whole reason there are two.
    expect(classifyChange(entry('tsh', n(4.3), n(4.0)), 'REPEAT').classification).toBe('CHANGED');
  });

  it('treats the threshold as exclusive, so exactly a tenth is not yet a change', () => {
    // Written as a test because "more than a tenth" is what the screen says, and a `>=` here
    // would make the sentence on screen false for exactly one value.
    const exactly = classifyChange(entry('x', n(11), n(10)), 'PERIODIC');
    expect(exactly.relative).toBeCloseTo(0.1, 10);
    expect(exactly.classification).toBe('SIMILAR');
  });

  it('reports direction and both magnitudes', () => {
    const down = classifyChange(entry('ldl', n(2.4, 'mmol/L'), n(3.2, 'mmol/L')), 'PERIODIC');
    expect(down.direction).toBe('DOWN');
    expect(down.delta).toBeCloseTo(-0.8, 10);
    expect(down.relative).toBeCloseTo(-0.25, 10);
    expect(down.classification).toBe('CHANGED');
  });

  it('measures the move against the size of the earlier value, not its sign', () => {
    // A base that is negative would otherwise flip the sign of `relative` and turn a fall into a
    // rise. Rare in labs, ordinary in a temperature or a delta-derived measure.
    const rising = classifyChange(entry('x', n(-4), n(-8)), 'PERIODIC');
    expect(rising.direction).toBe('UP');
    expect(rising.relative).toBeCloseTo(0.5, 10);
  });

  it('calls a value present now and absent before NEW, and the reverse NOT_REPEATED', () => {
    expect(classifyChange(entry('vitd', n(28), null), 'PERIODIC').classification).toBe('NEW');
    expect(classifyChange(entry('vitd', null, n(28)), 'PERIODIC').classification).toBe(
      'NOT_REPEATED',
    );
  });

  it('does not confuse a value of zero with an absent one', () => {
    // The bug this guards: a truthiness check on `value` reads 0 as "not there", which turns a
    // measured zero into NEW or NOT_REPEATED - a report claiming a test was not done when it was.
    const zeroNow = classifyChange(entry('x', n(0), n(0)), 'PERIODIC');
    expect(zeroNow.classification).toBe('SIMILAR');
    expect(classifyChange(entry('x', n(0), null), 'PERIODIC').classification).toBe('NEW');
  });

  it('refuses to divide by a previous value of zero and says why', () => {
    const fromZero = classifyChange(entry('x', n(2), n(0)), 'PERIODIC');
    expect(fromZero.classification).toBe('CHANGED');
    expect(fromZero.delta).toBe(2);
    expect(fromZero.relative).toBeNull();
    expect(fromZero.incomparableReason).toBe('PREVIOUS_ZERO');

    const stayedZero = classifyChange(entry('x', n(0), n(0)), 'PERIODIC');
    expect(stayedZero.classification).toBe('SIMILAR');
    expect(stayedZero.relative).toBeNull();
  });

  it('refuses arithmetic across a unit change rather than inventing a conversion', () => {
    // mg/L to µmol/L needs a molar mass this package does not have. Calling it CHANGED with a
    // stated reason is honest; computing 12 -> 0.9 as a 92% fall is not.
    const converted = classifyChange(
      entry('crp', { value: 0.9, unit: 'mg/dL' }, { value: 9, unit: 'mg/L' }),
      'PERIODIC',
    );
    expect(converted.classification).toBe('CHANGED');
    expect(converted.delta).toBeNull();
    expect(converted.relative).toBeNull();
    expect(converted.incomparableReason).toBe('UNIT_CHANGED');
  });

  it('compares text values by equality and marks them as not numeric', () => {
    const same = classifyChange(entry('hbsag', t('Not detected'), t('Not detected')), 'PERIODIC');
    expect(same.classification).toBe('SIMILAR');
    expect(same.incomparableReason).toBe('NOT_NUMERIC');

    const moved = classifyChange(entry('hbsag', t('Detected'), t('Not detected')), 'PERIODIC');
    expect(moved.classification).toBe('CHANGED');
    expect(moved.delta).toBeNull();
  });

  it('treats an empty text value as an absence rather than as a value', () => {
    expect(classifyChange(entry('x', t('   '), n(4)), 'PERIODIC').classification).toBe(
      'NOT_REPEATED',
    );
  });
});

describe('summarizeChange', () => {
  const report: readonly ComparableEntry[] = [
    entry('tsh', n(5.2), n(4.8)), // +8.3% - similar year-on-year, changed on repeat
    entry('ft4', n(19.4, 'pmol/L'), n(15.1, 'pmol/L')), // +28% - changed
    entry('tpo', n(12, 'IU/mL'), n(11, 'IU/mL')), // +9.1% - similar
    entry('vitd', n(28, 'ng/mL'), null), // new
    entry('b12', null, n(410, 'pg/mL')), // not repeated
    entry('crp', { value: 0.9, unit: 'mg/dL' }, { value: 9, unit: 'mg/L' }), // incomparable
  ];

  it('derives every count from the classified list, so a heading cannot disagree with its rows', () => {
    const summary = summarizeChange(report, 'PERIODIC');
    expect(summary.counts.CHANGED).toBe(2); // ft4, crp
    expect(summary.counts.NEW).toBe(1);
    expect(summary.counts.NOT_REPEATED).toBe(1);
    expect(summary.counts.SIMILAR).toBe(2); // tsh, tpo

    const tallied = summary.entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.classification] = (acc[e.classification] ?? 0) + 1;
      return acc;
    }, {});
    expect(tallied).toEqual({ CHANGED: 2, NEW: 1, NOT_REPEATED: 1, SIMILAR: 2 });
  });

  it('counts what was measured in both records, and says how much of that could not be compared', () => {
    const summary = summarizeChange(report, 'PERIODIC');
    // tsh, ft4, tpo, crp are on both sides. vitd and b12 are on one.
    expect(summary.comparedCount).toBe(4);
    // Of those four, only crp could not be compared arithmetically.
    expect(summary.incomparableCount).toBe(1);
  });

  it('moves counts when the interval changes, because the threshold is the interval', () => {
    const periodic = summarizeChange(report, 'PERIODIC');
    const repeat = summarizeChange(report, 'REPEAT');
    expect(periodic.counts.CHANGED).toBe(2);
    // tsh at +8.3% and tpo at +9.1% both cross a twentieth and neither crosses a tenth, so the
    // same two reports read as two changes or four depending only on why the second was taken.
    expect(repeat.counts.CHANGED).toBe(4);
    expect(repeat.counts.SIMILAR).toBe(0);
  });

  it('carries the sentence a screen must print, from the same constant the arithmetic uses', () => {
    // The failure this prevents: a screen saying "a tenth" beside counts computed from something
    // else. The statement and the number are read from tables keyed by the same interval.
    for (const interval of ['PERIODIC', 'REPEAT'] as const) {
      expect(summarizeChange([], interval).thresholdStatement).toBe(
        CHANGE_THRESHOLD_STATEMENTS[interval],
      );
    }
    expect(CHANGE_THRESHOLDS.PERIODIC).toBe(0.1);
    expect(CHANGE_THRESHOLDS.REPEAT).toBe(0.05);
  });

  it('preserves input order rather than ranking by how much something moved', () => {
    // `02` forbids ranking by risk, and "biggest mover first" is that ranking wearing arithmetic.
    const summary = summarizeChange(report, 'PERIODIC');
    expect(summary.entries.map((e) => e.key)).toEqual(['tsh', 'ft4', 'tpo', 'vitd', 'b12', 'crp']);
  });

  it('falls back to the periodic rule for an interval outside the vocabulary', () => {
    // DEC-147: a key from outside is resolved as an own property. A model or a stored row that
    // said `constructor` would otherwise reach a function through the prototype and be printed.
    const summary = summarizeChange(report, 'constructor' as ChangeInterval);
    expect(summary.thresholdStatement).toBe(CHANGE_THRESHOLD_STATEMENTS.PERIODIC);
    expect(summary.counts.CHANGED).toBe(2);
  });

  it('reports an empty comparison as empty rather than as no change', () => {
    const summary = summarizeChange([], 'PERIODIC');
    expect(summary.counts).toEqual({ CHANGED: 0, NEW: 0, NOT_REPEATED: 0, SIMILAR: 0 });
    expect(summary.comparedCount).toBe(0);
  });
});

describe('pairByKey', () => {
  const now = [
    { key: 'tsh', label: 'TSH', value: n(5.2) },
    { key: 'vitd', label: 'Vitamin D', value: n(28, 'ng/mL') },
  ];
  const before = [
    { key: 'tsh', label: 'TSH', value: n(4.8) },
    { key: 'b12', label: 'Vitamin B12', value: n(410, 'pg/mL') },
  ];

  it('takes the union, because the intersection cannot express new or not-repeated', () => {
    const paired = pairByKey(now, before);
    expect(paired.map((e) => e.key)).toEqual(['tsh', 'vitd', 'b12']);
    expect(paired[2]?.current).toBeNull();
    expect(paired[2]?.label).toBe('Vitamin B12');
  });

  it('reads this record in its own order, then what only the earlier one had', () => {
    const summary = summarizeChange(pairByKey(now, before), 'PERIODIC');
    expect(summary.counts).toEqual({ CHANGED: 0, NEW: 1, NOT_REPEATED: 1, SIMILAR: 1 });
  });

  it('keeps the label from the record that has the value', () => {
    // A test not repeated this year has to be shown with last year's name for it; there is no
    // current row to take a label from.
    const paired = pairByKey([], before);
    expect(paired.map((e) => e.label)).toEqual(['TSH', 'Vitamin B12']);
  });
});
