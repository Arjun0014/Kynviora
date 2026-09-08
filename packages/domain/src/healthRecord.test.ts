import { describe, expect, it } from 'vitest';
import {
  compareHealthRecords,
  comparisonInterval,
  decimalsFor,
  extractionIsConfirmed,
  EXTRACTION_STATES,
  HEALTH_METRICS,
  HEALTH_RECORD_KINDS,
  HEALTH_SOURCE_STATES,
  isHealthMetric,
  isHealthRecordKind,
  isPairedMetric,
  metricIsContinuouslySampled,
  normalizeHealthRecordDraft,
  referenceComparison,
  REFERENCE_COMPARISONS,
  sourceFlagSentence,
  sourceHasGoneQuiet,
  SOURCE_FLAGS,
  type HealthObservationDraft,
  type HealthRecordDraft,
  type SourceFlag,
  type StoredObservation,
} from './healthRecord.js';
import { isErr, isOk } from './result.js';

function observation(over: Partial<HealthObservationDraft> = {}): HealthObservationDraft {
  return {
    analyteCode: 'tsh',
    displayName: 'TSH',
    valueNumeric: 5.2,
    valueText: null,
    unit: 'mIU/L',
    decimals: 1,
    reference: { low: 0.4, high: 4.0, text: null },
    sourceFlag: null,
    ...over,
  };
}

function draft(over: Partial<HealthRecordDraft> = {}): HealthRecordDraft {
  return {
    kind: 'LAB_REPORT',
    title: 'Thyroid panel',
    providerName: 'Metropolis Diagnostics',
    recordedOn: '2026-09-02',
    sourceId: null,
    note: null,
    observations: [observation()],
    ...over,
  };
}

describe('referenceComparison', () => {
  const within = { low: 0.4, high: 4.0, text: null };

  it('places a value relative to the interval the report printed', () => {
    expect(referenceComparison(2.1, within)).toBe('WITHIN');
    expect(referenceComparison(5.2, within)).toBe('OUTSIDE_ABOVE');
    expect(referenceComparison(0.1, within)).toBe('OUTSIDE_BELOW');
  });

  it('treats the printed bounds as inclusive', () => {
    // A lab printing `0.4 - 4.0` considers 4.0 normal. An exclusive bound would put a value the
    // report itself accepts outside its own range.
    expect(referenceComparison(4.0, within)).toBe('WITHIN');
    expect(referenceComparison(0.4, within)).toBe('WITHIN');
  });

  it('handles a one-sided interval', () => {
    expect(referenceComparison(9, { low: null, high: 5, text: null })).toBe('OUTSIDE_ABOVE');
    expect(referenceComparison(9, { low: 5, high: null, text: null })).toBe('WITHIN');
  });

  it('says there is no interval when the report gave none', () => {
    // Not "fine" and not "unknown risk". The plain fact that this report printed no range, which
    // is the most common case for anything hand-entered.
    expect(referenceComparison(5.2, null)).toBe('NO_INTERVAL');
    expect(referenceComparison(5.2, { low: null, high: null, text: null })).toBe('NO_INTERVAL');
    expect(referenceComparison(5.2, { low: null, high: null, text: '   ' })).toBe('NO_INTERVAL');
  });

  it('refuses to parse a text interval into numbers', () => {
    // `< 5.0` parsed into `high: 5` invents a bound the lab did not print, and a lower bound of
    // zero it certainly did not.
    expect(referenceComparison(4.2, { low: null, high: null, text: '< 5.0' })).toBe(
      'NOT_COMPARABLE',
    );
    expect(referenceComparison(null, { low: null, high: null, text: 'Negative' })).toBe(
      'NOT_COMPARABLE',
    );
  });

  it('refuses to compare a text result with a numeric interval', () => {
    expect(referenceComparison(null, within)).toBe('NOT_COMPARABLE');
  });

  it('has no member that states a clinical judgement', () => {
    // The names are the point of DEC-155: `OUTSIDE_ABOVE` describes a position on a number line,
    // `HIGH` would describe a person. If somebody adds the shorter word, this fails.
    for (const member of REFERENCE_COMPARISONS) {
      expect(member).not.toMatch(/^(HIGH|LOW|NORMAL|ABNORMAL|CONCERNING|HEALTHY)$/);
    }
  });
});

describe('sourceHasGoneQuiet', () => {
  const now = Date.parse('2026-09-08T00:00:00.000Z');

  it('reports a source past its own window as quiet', () => {
    expect(
      sourceHasGoneQuiet(
        { lastReceivedAt: '2026-08-01T00:00:00.000Z', staleAfterMs: 7 * 86_400_000 },
        now,
      ),
    ).toBe(true);
  });

  it('reports a source inside its own window as not quiet', () => {
    expect(
      sourceHasGoneQuiet(
        { lastReceivedAt: '2026-09-06T00:00:00.000Z', staleAfterMs: 7 * 86_400_000 },
        now,
      ),
    ).toBe(false);
  });

  it('answers null where the question does not apply, so false cannot be read as fresh', () => {
    // An imported document does not go stale; it is what it was. A source with no window and one
    // that has never sent anything both return null rather than false, because false would say
    // "checked, and it is fine".
    expect(
      sourceHasGoneQuiet({ lastReceivedAt: '2026-09-06T00:00:00.000Z', staleAfterMs: null }, now),
    ).toBeNull();
    expect(sourceHasGoneQuiet({ lastReceivedAt: null, staleAfterMs: 86_400_000 }, now)).toBeNull();
    expect(
      sourceHasGoneQuiet({ lastReceivedAt: 'not a date', staleAfterMs: 86_400_000 }, now),
    ).toBeNull();
  });

  it('scales the window per source rather than using one global answer', () => {
    // An annual blood panel is not stale in March. A scale with no entry in three weeks is.
    const lastMarch = '2026-03-01T00:00:00.000Z';
    expect(
      sourceHasGoneQuiet({ lastReceivedAt: lastMarch, staleAfterMs: 365 * 86_400_000 }, now),
    ).toBe(false);
    expect(
      sourceHasGoneQuiet({ lastReceivedAt: lastMarch, staleAfterMs: 21 * 86_400_000 }, now),
    ).toBe(true);
  });
});

describe('normalizeHealthRecordDraft', () => {
  it('accepts a well-formed record and trims what it keeps', () => {
    const result = normalizeHealthRecordDraft(
      draft({ title: '  Thyroid panel  ', providerName: '  Metropolis  ' }),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.title).toBe('Thyroid panel');
    expect(result.value.providerName).toBe('Metropolis');
  });

  it('refuses a record with no title', () => {
    const result = normalizeHealthRecordDraft(draft({ title: '   ' }));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(result.error.detail?.field).toBe('title');
  });

  it('refuses a malformed date rather than guessing today', () => {
    // `healthContext.ts`'s rule, applied here: what is not entered is absent, and a date somebody
    // does not remember stays missing rather than becoming now.
    const result = normalizeHealthRecordDraft(draft({ recordedOn: '2 September 2026' }));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('INVALID_DATE');
  });

  it('keeps an absent date absent', () => {
    const result = normalizeHealthRecordDraft(draft({ recordedOn: null }));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.recordedOn).toBeNull();
  });

  it('refuses a result with no value', () => {
    const result = normalizeHealthRecordDraft(
      draft({ observations: [observation({ valueNumeric: null, valueText: null })] }),
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.detail?.analyteCode).toBe('tsh');
  });

  it('accepts a measured zero', () => {
    const result = normalizeHealthRecordDraft(
      draft({ observations: [observation({ valueNumeric: 0 })] }),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.observations[0]?.valueNumeric).toBe(0);
  });

  it('accepts a text result as a real result', () => {
    const result = normalizeHealthRecordDraft(
      draft({
        observations: [
          observation({ analyteCode: 'hbsag', valueNumeric: null, valueText: 'Not detected' }),
        ],
      }),
    );
    expect(isOk(result)).toBe(true);
  });

  it('rejects a non-finite number rather than storing NaN', () => {
    const result = normalizeHealthRecordDraft(
      draft({ observations: [observation({ valueNumeric: Number.NaN, valueText: null })] }),
    );
    expect(isErr(result)).toBe(true);
  });

  it('refuses two results for the same analyte, with the field rather than a constraint name', () => {
    const result = normalizeHealthRecordDraft(
      draft({ observations: [observation(), observation({ displayName: 'TSH again' })] }),
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.detail?.field).toBe('observations');
  });

  it('refuses a reference interval that runs backwards', () => {
    const result = normalizeHealthRecordDraft(
      draft({ observations: [observation({ reference: { low: 9, high: 2, text: null } })] }),
    );
    expect(isErr(result)).toBe(true);
  });

  it('refuses a source flag outside the report-flag vocabulary', () => {
    const result = normalizeHealthRecordDraft(
      draft({ observations: [observation({ sourceFlag: 'DANGEROUS' as SourceFlag })] }),
    );
    expect(isErr(result)).toBe(true);
  });

  it('has no field through which a client could set provenance or extraction state', () => {
    // `04` Phase 1.3, enforced by absence rather than by validation. If either field appears on
    // the draft type, a client can claim a reviewer confirmed a document.
    const result = normalizeHealthRecordDraft(draft());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(Object.keys(result.value)).not.toContain('provenance');
    expect(Object.keys(result.value)).not.toContain('extractionState');
  });

  it('clamps decimals into the range the schema allows', () => {
    const result = normalizeHealthRecordDraft(
      draft({ observations: [observation({ decimals: 40 })] }),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.observations[0]?.decimals).toBe(6);
  });
});

describe('extraction state', () => {
  it('treats only a checked extraction and a hand entry as settled', () => {
    // `04` Phase 1.3: no OCR result silently becomes a confirmed record. Everything a machine
    // produced and nobody checked answers false here.
    expect(extractionIsConfirmed('EXTRACTED_CONFIRMED')).toBe(true);
    expect(extractionIsConfirmed('ENTERED_BY_HAND')).toBe(true);
    expect(extractionIsConfirmed('EXTRACTED_UNCONFIRMED')).toBe(false);
    expect(extractionIsConfirmed('EXTRACTION_PENDING')).toBe(false);
    expect(extractionIsConfirmed('EXTRACTION_FAILED')).toBe(false);
    expect(extractionIsConfirmed('NOT_EXTRACTED')).toBe(false);
  });

  it('carries a state for a document nobody has read yet', () => {
    expect(EXTRACTION_STATES).toContain('EXTRACTED_UNCONFIRMED');
  });
});

describe('metrics', () => {
  it('names exactly one paired metric, and the schema agrees', () => {
    const paired = HEALTH_METRICS.filter(isPairedMetric);
    expect(paired).toEqual(['BLOOD_PRESSURE']);
  });

  it('draws a solid line only where the quantity is sampled continuously', () => {
    // A connecting line asserts the quantity took the intermediate values. Between a weight in
    // March and a weight in September, nobody measured whether it did.
    expect(metricIsContinuouslySampled('RESTING_HEART_RATE')).toBe(true);
    expect(metricIsContinuouslySampled('BODY_WEIGHT')).toBe(false);
    expect(metricIsContinuouslySampled('BLOOD_PRESSURE')).toBe(false);
    expect(metricIsContinuouslySampled('BLOOD_GLUCOSE')).toBe(false);
  });

  it('narrows a string from outside', () => {
    expect(isHealthMetric('BLOOD_PRESSURE')).toBe(true);
    expect(isHealthMetric('constructor')).toBe(false);
    expect(isHealthMetric(null)).toBe(false);
  });
});

describe('comparisonInterval', () => {
  it('uses the year-on-year threshold only for two annual checks', () => {
    expect(comparisonInterval('ANNUAL_CHECKUP', 'ANNUAL_CHECKUP')).toBe('PERIODIC');
    expect(comparisonInterval('LAB_REPORT', 'LAB_REPORT')).toBe('REPEAT');
    // A repeat panel taken because somebody wanted to look again is not a year apart, even when
    // the earlier record happens to be an annual check.
    expect(comparisonInterval('LAB_REPORT', 'ANNUAL_CHECKUP')).toBe('REPEAT');
  });
});

describe('compareHealthRecords', () => {
  const stored = (
    over: Partial<StoredObservation> & { analyteCode: string },
  ): StoredObservation => ({
    displayName: over.analyteCode.toUpperCase(),
    valueNumeric: null,
    valueText: null,
    unit: null,
    decimals: null,
    reference: null,
    sourceFlag: null,
    ...over,
  });

  it('compares two annual checks against the year-on-year threshold', () => {
    const summary = compareHealthRecords({
      current: {
        kind: 'ANNUAL_CHECKUP',
        observations: [
          stored({ analyteCode: 'tsh', valueNumeric: 5.2, unit: 'mIU/L' }),
          stored({ analyteCode: 'vitd', valueNumeric: 28, unit: 'ng/mL' }),
        ],
      },
      previous: {
        kind: 'ANNUAL_CHECKUP',
        observations: [
          stored({ analyteCode: 'tsh', valueNumeric: 4.8, unit: 'mIU/L' }),
          stored({ analyteCode: 'b12', valueNumeric: 410, unit: 'pg/mL' }),
        ],
      },
    });
    expect(summary.interval).toBe('PERIODIC');
    // +8.3% does not cross a tenth.
    expect(summary.counts).toEqual({ CHANGED: 0, NEW: 1, NOT_REPEATED: 1, SIMILAR: 1 });
  });

  it('calls the same pair a change when it is a repeat rather than a year apart', () => {
    const observations = {
      current: [stored({ analyteCode: 'tsh', valueNumeric: 5.2, unit: 'mIU/L' })],
      previous: [stored({ analyteCode: 'tsh', valueNumeric: 4.8, unit: 'mIU/L' })],
    };
    const summary = compareHealthRecords({
      current: { kind: 'LAB_REPORT', observations: observations.current },
      previous: { kind: 'LAB_REPORT', observations: observations.previous },
    });
    expect(summary.interval).toBe('REPEAT');
    expect(summary.counts.CHANGED).toBe(1);
  });

  it('carries a text result through as a text comparison', () => {
    const summary = compareHealthRecords({
      current: {
        kind: 'LAB_REPORT',
        observations: [stored({ analyteCode: 'hbsag', valueText: 'Detected' })],
      },
      previous: {
        kind: 'LAB_REPORT',
        observations: [stored({ analyteCode: 'hbsag', valueText: 'Not detected' })],
      },
    });
    expect(summary.counts.CHANGED).toBe(1);
    expect(summary.entries[0]?.incomparableReason).toBe('NOT_NUMERIC');
  });

  it('does not read a reference interval into the comparison at all', () => {
    // DEC-155: a reference interval sits beside a change and is never folded into it. Two values
    // outside their interval that did not move are SIMILAR, and a screen that showed them as a
    // change would be reporting the interval rather than the difference.
    const outside = { low: 0.4, high: 4.0, text: null };
    const summary = compareHealthRecords({
      current: {
        kind: 'LAB_REPORT',
        observations: [stored({ analyteCode: 'tsh', valueNumeric: 9, reference: outside })],
      },
      previous: {
        kind: 'LAB_REPORT',
        observations: [stored({ analyteCode: 'tsh', valueNumeric: 9, reference: outside })],
      },
    });
    expect(summary.counts.CHANGED).toBe(0);
    expect(summary.counts.SIMILAR).toBe(1);
  });
});

describe('decimalsFor', () => {
  it('uses what the report printed, and two places when it said nothing', () => {
    expect(decimalsFor({ decimals: 1 })).toBe(1);
    expect(decimalsFor({ decimals: 0 })).toBe(0);
    expect(decimalsFor({ decimals: null })).toBe(2);
  });
});

describe('sourceFlagSentence', () => {
  it('makes the report the subject of every sentence', () => {
    for (const flag of SOURCE_FLAGS) {
      expect(sourceFlagSentence(flag)).toMatch(/source report$/);
    }
    expect(sourceFlagSentence('HIGH')).toBe('Flagged high by the source report');
  });

  it('resolves a flag from outside the vocabulary as an own property', () => {
    // DEC-147.
    expect(sourceFlagSentence('constructor' as SourceFlag)).toBe('Flagged by the source report');
  });
});

describe('the vocabularies', () => {
  it('has a state for an integration that was designed and not built', () => {
    // The V3 brief asks by name for future-ready states that do not imply a real integration.
    expect(HEALTH_SOURCE_STATES).toContain('DESIGNED_NOT_IMPLEMENTED');
  });

  it('keeps clinical severity and any all-clear out of the source-flag vocabulary', () => {
    // Anchored rather than a substring match, because `ABNORMAL` is a word labs genuinely print
    // and quoting it is the whole job of this column. What must not appear is a word that would
    // make Kynviora the author of a verdict - a severity it invented, or an all-clear, which
    // `02` forbids outright: a missing flag is not approval.
    for (const flag of SOURCE_FLAGS) {
      expect(flag).not.toMatch(/^(DANGEROUS|URGENT|SEVERE|SAFE|NORMAL|CLEAR|OK)$/);
    }
  });

  it('narrows a record kind from outside', () => {
    expect(HEALTH_RECORD_KINDS).toContain('ANNUAL_CHECKUP');
    expect(isHealthRecordKind('ANNUAL_CHECKUP')).toBe(true);
    expect(isHealthRecordKind('__proto__')).toBe(false);
  });
});
