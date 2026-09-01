import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_RESOLUTIONS,
  RECEIPT_UNCERTAINTIES,
  SAFETY_RESOLUTIONS,
  buildReceipt,
  isFeedbackResolution,
  isSafetyResolution,
  receiptUncertainties,
  type ReceiptBasis,
  type ReceiptCorrection,
  type ReceiptEntry,
  type ReceiptHistoryEntry,
  type SafetyResolution,
} from './safetyReceipt.js';

const BASIS: ReceiptBasis = {
  assessedAt: '2026-09-01T12:00:00.000Z',
  alertPublishedAt: '2026-09-01T12:00:00.000Z',
  ruleVersionId: 'rule-version-1',
  ruleKey: 'expiry.default',
  ruleVersion: '1.2.0',
  regulatoryRuleVersionId: null,
  evidenceLevel: 'A',
  urgency: 'HIGH',
  matchConfidence: 'EXACT',
  normalizationVersion: 'norm-1',
};

function entry(resolvedAt: string, resolution: SafetyResolution = 'REVIEWED'): ReceiptEntry {
  return { receiptId: 'receipt-1', resolution, note: null, resolvedAt };
}

function correction(
  correctedAt: string,
  overrides: Partial<ReceiptCorrection> = {},
): ReceiptCorrection {
  return {
    correctionId: `c-${correctedAt}`,
    correctionKind: 'RULE_CORRECTED',
    reason: 'A reason.',
    correctedAt,
    reviewerId: null,
    replacementAssessmentId: null,
    ...overrides,
  };
}

function history(recordedAt: string, replacedPrevious = false): ReceiptHistoryEntry {
  return { recordedAt, resolution: 'REVIEWED', replacedPrevious };
}

function build(input: {
  current?: ReceiptEntry | null;
  corrections?: readonly ReceiptCorrection[];
  history?: readonly ReceiptHistoryEntry[];
  basis?: ReceiptBasis;
  sourceReferenceWithheld?: boolean;
}) {
  return buildReceipt({
    alertPublicationId: 'alert-1',
    assessmentId: 'assessment-1',
    basis: input.basis ?? BASIS,
    current: input.current ?? null,
    history: input.history ?? [],
    corrections: input.corrections ?? [],
    sourceReferenceWithheld: input.sourceReferenceWithheld ?? false,
  });
}

describe('the resolution vocabulary', () => {
  it('has no member that records Kynviora telling somebody to stop a medicine', () => {
    // `09` forbids it, and a resolution vocabulary is where that rule quietly fails: an outcome
    // called "stopped taking it" would be Kynviora recording that its alert produced that
    // decision. Migration `0006`'s CHECK contains no such member either.
    const forbidden = /stop|start|change|dose|reduce|increase|switch/i;
    for (const resolution of SAFETY_RESOLUTIONS) {
      expect(resolution).not.toMatch(forbidden);
    }
  });

  it('separates feedback about Kynviora from what a person did', () => {
    expect(FEEDBACK_RESOLUTIONS).toEqual(['REPORTED_INCORRECT_MATCH', 'ITEM_IDENTITY_CORRECTED']);
    expect(isFeedbackResolution('REPORTED_INCORRECT_MATCH')).toBe(true);
    expect(isFeedbackResolution('QUARANTINED')).toBe(false);
  });

  it('guards against a value from outside it', () => {
    expect(isSafetyResolution('REVIEWED')).toBe(true);
    expect(isSafetyResolution('STOPPED_MEDICINE')).toBe(false);
    expect(isSafetyResolution(null)).toBe(false);
    expect(isSafetyResolution(7)).toBe(false);
  });
});

describe('assembling a receipt', () => {
  it('has nowhere to say an alert is finished with', () => {
    const receipt = build({ current: entry('2026-09-01T12:00:00.000Z') });
    // An alert somebody reviewed is not finished with, and a boolean saying otherwise would be
    // the software deciding that for them.
    for (const forbidden of ['handled', 'closed', 'resolved', 'complete', 'progress', 'score']) {
      expect(Object.keys(receipt)).not.toContain(forbidden);
    }
  });

  it('orders corrections and history oldest first regardless of input order', () => {
    const receipt = build({
      corrections: [correction('2026-09-03T00:00:00.000Z'), correction('2026-09-01T00:00:00.000Z')],
      history: [history('2026-09-03T00:00:00.000Z'), history('2026-09-01T00:00:00.000Z')],
    });
    expect(receipt.corrections.map((c) => c.correctedAt)).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-09-03T00:00:00.000Z',
    ]);
    expect(receipt.history.map((h) => h.recordedAt)).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-09-03T00:00:00.000Z',
    ]);
  });

  it('reports a correction that post-dates the resolution that stands', () => {
    const receipt = build({
      current: entry('2026-09-01T12:00:00.000Z'),
      corrections: [correction('2026-09-02T12:00:00.000Z')],
    });
    expect(receipt.correctedSinceResolution).toBe(true);
  });

  it('does not report one that predates it', () => {
    const receipt = build({
      current: entry('2026-09-02T12:00:00.000Z'),
      corrections: [correction('2026-09-01T12:00:00.000Z')],
    });
    expect(receipt.correctedSinceResolution).toBe(false);
  });

  it('makes no claim either way where nothing was recorded', () => {
    const receipt = build({ corrections: [correction('2026-09-02T12:00:00.000Z')] });
    // There is no resolution for a correction to be "since", and a `true` here would read as an
    // accusation that somebody ignored something.
    expect(receipt.correctedSinceResolution).toBe(false);
    expect(receipt.corrections).toHaveLength(1);
  });

  it('does not lose a correction whose timestamp cannot be parsed', () => {
    const receipt = build({
      current: entry('2026-09-01T12:00:00.000Z'),
      corrections: [correction('not a date')],
    });
    // Exit criterion 2 is that corrections stay visible. An unparseable timestamp makes the
    // ordering arbitrary; dropping the row would make the correction invisible, which is worse.
    expect(receipt.corrections).toHaveLength(1);
  });
});

describe('what remains uncertain', () => {
  it('says nothing where there is nothing to say', () => {
    expect(build({ current: entry('2026-09-01T12:00:00.000Z') }).uncertainties).toEqual([]);
  });

  it('names an inexact match, whatever the confidence was', () => {
    for (const confidence of ['PROBABLE', 'POSSIBLE', 'AMBIGUOUS', 'NOT_MATCHED']) {
      const receipt = build({ basis: { ...BASIS, matchConfidence: confidence } });
      expect(receipt.uncertainties).toContain('MATCH_NOT_EXACT');
    }
    expect(build({ basis: BASIS }).uncertainties).not.toContain('MATCH_NOT_EXACT');
  });

  it('names a withheld reference when it is told about one', () => {
    expect(build({ sourceReferenceWithheld: true }).uncertainties).toContain(
      'SOURCE_REFERENCE_WITHHELD',
    );
  });

  it('names a correction that landed after the resolution', () => {
    const receipt = build({
      current: entry('2026-09-01T12:00:00.000Z'),
      corrections: [correction('2026-09-02T12:00:00.000Z')],
    });
    expect(receipt.uncertainties).toContain('CORRECTED_SINCE_RESOLUTION');
  });

  it('says nothing has come back after a report, until something does', () => {
    const reported = build({
      current: entry('2026-09-01T12:00:00.000Z', 'REPORTED_INCORRECT_MATCH'),
    });
    expect(reported.uncertainties).toContain('REPORTED_INCORRECT_AWAITING_REVIEW');

    const answered = build({
      current: entry('2026-09-01T12:00:00.000Z', 'REPORTED_INCORRECT_MATCH'),
      corrections: [correction('2026-09-02T12:00:00.000Z')],
    });
    // Both at once would have the screen saying "nothing has come back" beside the thing that did.
    expect(answered.uncertainties).toContain('CORRECTED_SINCE_RESOLUTION');
    expect(answered.uncertainties).not.toContain('REPORTED_INCORRECT_AWAITING_REVIEW');
  });

  it('names a replacement assessment only where a correction produced one', () => {
    expect(
      build({ corrections: [correction('2026-09-02T12:00:00.000Z')] }).uncertainties,
    ).not.toContain('SUPERSEDED_BY_LATER_ASSESSMENT');
    expect(
      build({
        corrections: [
          correction('2026-09-02T12:00:00.000Z', { replacementAssessmentId: 'assessment-2' }),
        ],
      }).uncertainties,
    ).toContain('SUPERSEDED_BY_LATER_ASSESSMENT');
  });

  it('emits in vocabulary order rather than by how alarming each one is', () => {
    const all = receiptUncertainties({
      matchConfidence: 'POSSIBLE',
      currentResolution: 'REPORTED_INCORRECT_MATCH',
      correctedSinceResolution: false,
      sourceReferenceWithheld: true,
      hasReplacementAssessment: true,
    });
    // Ordering by severity would be a ranking of one person's doubts against another's.
    expect(all).toEqual(RECEIPT_UNCERTAINTIES.filter((u) => u !== 'CORRECTED_SINCE_RESOLUTION'));
  });

  it('never repeats a member', () => {
    const all = receiptUncertainties({
      matchConfidence: 'POSSIBLE',
      currentResolution: 'REPORTED_INCORRECT_MATCH',
      correctedSinceResolution: true,
      sourceReferenceWithheld: true,
      hasReplacementAssessment: true,
    });
    expect(new Set(all).size).toBe(all.length);
  });
});
