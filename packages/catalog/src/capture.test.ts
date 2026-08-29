import { describe, it, expect } from 'vitest';
import {
  evaluateImageQuality,
  reconcileExtractions,
  buildFieldAssertion,
  confirmFieldAssertion,
  acceptPanel,
  isCaptureComplete,
  requiredPanelsFor,
  DEFAULT_QUALITY_THRESHOLDS,
  type ImageQualityMetrics,
  type ExtractionResult,
  type FieldValidator,
  type CaptureSessionState,
} from './capture.js';
import {
  instantFrom,
  sequentialIdGenerator,
  isTrustedForSafetyUse,
  isOk,
  isErr,
  ok,
  failure,
  unsafeId,
  type EvidenceAssetId,
  type ExtractionRunId,
} from '@kynviora/domain';

const NOW = instantFrom('2026-08-29T00:00:00.000Z');
const ASSET = unsafeId<EvidenceAssetId>('asset-1');
const RUN = unsafeId<ExtractionRunId>('run-1');

function metrics(overrides: Partial<ImageQualityMetrics> = {}): ImageQualityMetrics {
  return {
    sharpness: 250,
    overexposedFraction: 0.02,
    underexposedFraction: 0.05,
    edgesWithinFrame: true,
    rotationDegrees: 2,
    shortestSidePixels: 1080,
    perceptualHash: 'phash-a',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

describe('quality gate (spec 08, 04 Phase 3.2)', () => {
  it('accepts a good capture', () => {
    const result = evaluateImageQuality(metrics());
    expect(result.accepted).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('rejects a blurry image', () => {
    const result = evaluateImageQuality(metrics({ sharpness: 20 }));
    expect(result.accepted).toBe(false);
    expect(result.failures).toContain('TOO_BLURRY');
  });

  it('rejects glare', () => {
    const result = evaluateImageQuality(metrics({ overexposedFraction: 0.5 }));
    expect(result.failures).toContain('GLARE_OR_OVEREXPOSED');
  });

  it('rejects a very dark image', () => {
    expect(evaluateImageQuality(metrics({ underexposedFraction: 0.8 })).failures).toContain(
      'TOO_DARK',
    );
  });

  it('rejects a cropped panel', () => {
    expect(evaluateImageQuality(metrics({ edgesWithinFrame: false })).failures).toContain(
      'EDGES_CROPPED',
    );
  });

  it('rejects excessive rotation in either direction', () => {
    expect(evaluateImageQuality(metrics({ rotationDegrees: 40 })).failures).toContain(
      'TOO_ROTATED',
    );
    expect(evaluateImageQuality(metrics({ rotationDegrees: -40 })).failures).toContain(
      'TOO_ROTATED',
    );
  });

  it('rejects a low-resolution capture', () => {
    expect(evaluateImageQuality(metrics({ shortestSidePixels: 240 })).failures).toContain(
      'RESOLUTION_TOO_LOW',
    );
  });

  it('reports every failing check, not only the first', () => {
    // A user gets complete guidance in one retake rather than discovering problems one at a time.
    const result = evaluateImageQuality(
      metrics({ sharpness: 10, edgesWithinFrame: false, shortestSidePixels: 200 }),
    );
    expect(result.failures.length).toBe(3);
    expect(result.retakeGuidance).toHaveLength(3);
  });

  it('gives plain-language retake guidance for every failure', () => {
    const result = evaluateImageQuality(metrics({ sharpness: 10 }));
    expect(result.retakeGuidance[0]).toMatch(/steady|focus/i);
    // Spec 18: familiar words first, no jargon in the first layer.
    expect(result.retakeGuidance[0]).not.toMatch(/laplacian|variance|threshold/i);
  });

  it('detects a duplicate of an earlier capture in the session', () => {
    const result = evaluateImageQuality(metrics({ perceptualHash: 'phash-a' }), {
      previousHashes: ['phash-a'],
    });
    expect(result.failures).toContain('DUPLICATE_OF_PREVIOUS');
  });

  it('does not flag a different image as a duplicate', () => {
    const result = evaluateImageQuality(metrics({ perceptualHash: 'phash-b' }), {
      previousHashes: ['phash-a'],
    });
    expect(result.accepted).toBe(true);
  });

  it('honours custom thresholds', () => {
    const strict = { ...DEFAULT_QUALITY_THRESHOLDS, minSharpness: 500 };
    expect(evaluateImageQuality(metrics({ sharpness: 250 }), { thresholds: strict }).accepted).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Dual extraction reconciliation
// ---------------------------------------------------------------------------

function extraction(
  engine: ExtractionResult['engine'],
  fields: Record<string, string | null>,
): ExtractionResult {
  return {
    engine,
    engineVersion: 'v1',
    fields: Object.entries(fields).map(([fieldPath, rawValue]) => ({
      fieldPath,
      rawValue,
      confidence: 0.9,
    })),
  };
}

describe('dual extraction (spec 17)', () => {
  it('marks agreeing fields as agreed', () => {
    const reconciled = reconcileExtractions(
      extraction('OCR', { 'identity.brand': 'Fictional Labs' }),
      extraction('VISION_MODEL', { 'identity.brand': 'Fictional Labs' }),
    );
    expect(reconciled[0]?.agreement).toBe('AGREE');
    expect(reconciled[0]?.requiresConfirmation).toBe(false);
    expect(reconciled[0]?.agreedRawValue).toBe('Fictional Labs');
  });

  it('ignores casing and spacing differences that carry no meaning', () => {
    const reconciled = reconcileExtractions(
      extraction('OCR', { 'identity.brand': 'FICTIONAL  LABS' }),
      extraction('VISION_MODEL', { 'identity.brand': 'Fictional Labs' }),
    );
    expect(reconciled[0]?.agreement).toBe('AGREE');
  });

  it('requires confirmation when the mechanisms disagree', () => {
    // THE CORE RULE. Spec 17: disagreement must trigger confirmation, never arbitration by
    // confidence. There is no code path here that picks a winner.
    const reconciled = reconcileExtractions(
      extraction('OCR', { 'batch.lotCode': 'A24X91' }),
      extraction('VISION_MODEL', { 'batch.lotCode': 'A24X9I' }),
    );
    expect(reconciled[0]?.agreement).toBe('DISAGREE');
    expect(reconciled[0]?.requiresConfirmation).toBe(true);
    expect(reconciled[0]?.agreedRawValue).toBeNull();
  });

  it('preserves both readings so a reviewer can see what each produced', () => {
    const reconciled = reconcileExtractions(
      extraction('OCR', { 'batch.lotCode': 'A24X91' }),
      extraction('VISION_MODEL', { 'batch.lotCode': 'A24X9I' }),
    );
    expect(reconciled[0]?.ocrValue).toBe('A24X91');
    expect(reconciled[0]?.visionValue).toBe('A24X9I');
  });

  it('requires confirmation when only one mechanism produced a value', () => {
    // A single source is not corroborated. Spec 17 treats agreement as the signal, so its
    // absence means a human still has to look.
    const reconciled = reconcileExtractions(
      extraction('OCR', { 'identity.brand': 'Fictional Labs' }),
      extraction('VISION_MODEL', { 'identity.brand': null }),
    );
    expect(reconciled[0]?.agreement).toBe('SINGLE_SOURCE');
    expect(reconciled[0]?.requiresConfirmation).toBe(true);
  });

  it('records mutual abstention rather than inventing a value', () => {
    const reconciled = reconcileExtractions(
      extraction('OCR', { 'batch.lotCode': null }),
      extraction('VISION_MODEL', { 'batch.lotCode': null }),
    );
    expect(reconciled[0]?.agreement).toBe('BOTH_ABSTAINED');
    expect(reconciled[0]?.agreedRawValue).toBeNull();
  });

  it('covers fields only one mechanism reported', () => {
    const reconciled = reconcileExtractions(
      extraction('OCR', { 'identity.brand': 'X' }),
      extraction('VISION_MODEL', { 'batch.lotCode': 'Y' }),
    );
    expect(reconciled.map((r) => r.fieldPath)).toEqual(['batch.lotCode', 'identity.brand']);
    expect(reconciled.every((r) => r.requiresConfirmation)).toBe(true);
  });

  it('uses a field-specific normalizer where equivalence differs', () => {
    // Ingredient order is material, so its normalizer must not sort or collapse.
    const reconciled = reconcileExtractions(
      extraction('OCR', { 'formulation.declaration': 'Aqua, Glycerin' }),
      extraction('VISION_MODEL', { 'formulation.declaration': 'Glycerin, Aqua' }),
      { 'formulation.declaration': (v) => v },
    );
    expect(reconciled[0]?.agreement).toBe('DISAGREE');
  });
});

// ---------------------------------------------------------------------------
// Assertion building
// ---------------------------------------------------------------------------

const gtinValidator: FieldValidator = {
  fieldPath: 'identity.gtin',
  validator: 'gtin.checkDigit',
  validatorVersion: '1',
  validate: (raw) =>
    /^\d{13}$/.test(raw)
      ? ok(raw)
      : failure('INVALID_BARCODE', 'bad gtin', { reason_code: 'shape' }),
};

describe('field assertion building (spec 08, DEC-013)', () => {
  function build(ocrValue: string | null, visionValue: string | null, validator?: FieldValidator) {
    const reconciled = reconcileExtractions(
      extraction('OCR', { 'identity.gtin': ocrValue }),
      extraction('VISION_MODEL', { 'identity.gtin': visionValue }),
    )[0]!;

    return buildFieldAssertion({
      reconciled,
      evidenceAssetId: ASSET,
      extractionRunId: RUN,
      extractorVersion: 'ocr-1',
      ...(validator ? { validator } : {}),
      assertedAt: NOW,
      ids: sequentialIdGenerator(),
    });
  }

  it('creates every machine assertion in an unconfirmed state', () => {
    const assertion = build('8901234567890', '8901234567890', gtinValidator);
    expect(assertion.confirmation).toBe('UNCONFIRMED');
    expect(assertion.provenance).toBe('PACKAGE_OCR');
  });

  it('refuses to make an unconfirmed machine reading trusted, even when both agree', () => {
    // THE GUARANTEE. Spec 17: "A model cannot fill a missing field merely because it is likely."
    // Agreement plus a passing validator is still not enough without a human.
    const assertion = build('8901234567890', '8901234567890', gtinValidator);
    expect(assertion.validation.outcome).toBe('PASSED');
    expect(isTrustedForSafetyUse(assertion)).toBe(false);
  });

  it('records a validator failure rather than dropping the value', () => {
    const assertion = build('not-a-gtin', 'not-a-gtin', gtinValidator);
    expect(assertion.validation.outcome).toBe('FAILED');
    expect(assertion.validation.reason).toBe('shape');
    // The raw value is preserved so a reviewer can see what was read.
    expect(assertion.rawValue).toBe('not-a-gtin');
    expect(isTrustedForSafetyUse(assertion)).toBe(false);
  });

  it('validates a single-source value too', () => {
    // A malformed date should be rejected regardless of how many mechanisms saw it.
    const assertion = build('not-a-gtin', null, gtinValidator);
    expect(assertion.validation.outcome).toBe('FAILED');
  });

  it('marks a field with no validator as NOT_RUN, so it cannot become trusted', () => {
    const assertion = build('anything', 'anything');
    expect(assertion.validation.outcome).toBe('NOT_RUN');
    expect(isTrustedForSafetyUse(assertion)).toBe(false);
  });

  it('records the evidence asset and extraction run for provenance', () => {
    const assertion = build('8901234567890', '8901234567890', gtinValidator);
    expect(assertion.sourceAssetId).toBe(ASSET);
    expect(assertion.extractionRunId).toBe(RUN);
    expect(assertion.extractorVersion).toBe('ocr-1');
  });
});

describe('confirmation supersedes rather than mutating (DEC-013)', () => {
  const original = buildFieldAssertion({
    reconciled: reconcileExtractions(
      extraction('OCR', { 'batch.lotCode': 'A24X91' }),
      extraction('VISION_MODEL', { 'batch.lotCode': 'A24X9I' }),
    )[0]!,
    evidenceAssetId: ASSET,
    extractionRunId: RUN,
    extractorVersion: 'ocr-1',
    assertedAt: NOW,
    ids: sequentialIdGenerator('11111111'),
  });

  it('makes a confirmed field usable by a safety rule', () => {
    const confirmed = confirmFieldAssertion(
      original,
      { kind: 'CONFIRMED' },
      {
        assertedAt: NOW,
        ids: sequentialIdGenerator('22222222'),
      },
    );
    expect(confirmed.confirmation).toBe('USER_CONFIRMED');
    expect(confirmed.provenance).toBe('USER_CONFIRMED_FROM_PACKAGE');
    expect(isTrustedForSafetyUse(confirmed)).toBe(true);
  });

  it('links to the assertion it supersedes', () => {
    const confirmed = confirmFieldAssertion(
      original,
      { kind: 'CONFIRMED' },
      {
        assertedAt: NOW,
        ids: sequentialIdGenerator('22222222'),
      },
    );
    expect(confirmed.supersedesId).toBe(original.id);
    expect(confirmed.id).not.toBe(original.id);
  });

  it('leaves the original assertion untouched', () => {
    // Investigating a wrong match needs the machine's original reading: it is the difference
    // between an extraction bug and a user error.
    const snapshot = structuredClone(original);
    confirmFieldAssertion(
      original,
      { kind: 'CONFIRMED' },
      {
        assertedAt: NOW,
        ids: sequentialIdGenerator('33333333'),
      },
    );
    expect(original).toEqual(snapshot);
    expect(original.confirmation).toBe('UNCONFIRMED');
  });

  it('records a correction with the user value', () => {
    const corrected = confirmFieldAssertion(
      original,
      { kind: 'CORRECTED', rawValue: 'A24X91', normalizedValue: 'A24X91' },
      { assertedAt: NOW, ids: sequentialIdGenerator('44444444') },
    );
    expect(corrected.confirmation).toBe('USER_CORRECTED');
    expect(corrected.rawValue).toBe('A24X91');
    expect(isTrustedForSafetyUse(corrected)).toBe(true);
  });

  it('records a rejection without making it trusted', () => {
    const rejected = confirmFieldAssertion(
      original,
      { kind: 'REJECTED' },
      {
        assertedAt: NOW,
        ids: sequentialIdGenerator('55555555'),
      },
    );
    expect(rejected.confirmation).toBe('REJECTED');
    expect(rejected.normalizedValue).toBeNull();
    expect(isTrustedForSafetyUse(rejected)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session orchestration
// ---------------------------------------------------------------------------

describe('capture session (spec 06 Journey 2)', () => {
  function session(overrides: Partial<CaptureSessionState> = {}): CaptureSessionState {
    return {
      requestedPanels: ['FRONT_PANEL', 'INGREDIENT_PANEL'],
      acceptedPanels: [],
      acceptedHashes: [],
      ...overrides,
    };
  }

  it('requests front and ingredient panels at minimum', () => {
    const panels = requiredPanelsFor('PERSONAL_CARE', {
      hasBarcode: false,
      hasPrintedBatch: false,
    });
    expect(panels).toEqual(['FRONT_PANEL', 'INGREDIENT_PANEL']);
  });

  it('adds barcode and batch panels when present on the pack', () => {
    const panels = requiredPanelsFor('PERSONAL_CARE', { hasBarcode: true, hasPrintedBatch: true });
    expect(panels).toEqual([
      'FRONT_PANEL',
      'INGREDIENT_PANEL',
      'BARCODE_PANEL',
      'BATCH_DATE_PANEL',
    ]);
  });

  it('accepts a good panel into the session', () => {
    const result = acceptPanel(session(), 'FRONT_PANEL', metrics());
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.acceptedPanels).toEqual(['FRONT_PANEL']);
      expect(result.value.acceptedHashes).toEqual(['phash-a']);
    }
  });

  it('rejects a poor panel with a specific reason', () => {
    // Spec 08: unreadable evidence triggers a retake, never a guess.
    const result = acceptPanel(session(), 'FRONT_PANEL', metrics({ sharpness: 5 }));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('QUALITY_GATE_FAILED');
      expect(result.error.detail?.reason_code).toBe('TOO_BLURRY');
    }
  });

  it('rejects the same image submitted for a second panel', () => {
    const first = acceptPanel(session(), 'FRONT_PANEL', metrics({ perceptualHash: 'same' }));
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;

    const second = acceptPanel(
      first.value,
      'INGREDIENT_PANEL',
      metrics({ perceptualHash: 'same' }),
    );
    expect(isErr(second)).toBe(true);
    if (isErr(second)) {
      expect(second.error.detail?.reason_code).toBe('DUPLICATE_OF_PREVIOUS');
    }
  });

  it('does not double-count a re-accepted panel', () => {
    const first = acceptPanel(session(), 'FRONT_PANEL', metrics({ perceptualHash: 'a' }));
    if (!isOk(first)) throw new Error('expected acceptance');
    const again = acceptPanel(first.value, 'FRONT_PANEL', metrics({ perceptualHash: 'b' }));
    if (!isOk(again)) throw new Error('expected acceptance');
    expect(again.value.acceptedPanels).toEqual(['FRONT_PANEL']);
  });

  it('reports completion only when every requested panel is accepted', () => {
    expect(isCaptureComplete(session({ acceptedPanels: ['FRONT_PANEL'] }))).toBe(false);
    expect(
      isCaptureComplete(session({ acceptedPanels: ['FRONT_PANEL', 'INGREDIENT_PANEL'] })),
    ).toBe(true);
  });

  it('leaves the previous session state untouched', () => {
    const before = session();
    const snapshot = structuredClone(before);
    acceptPanel(before, 'FRONT_PANEL', metrics());
    expect(before).toEqual(snapshot);
  });
});
