/**
 * Guided capture pipeline: quality gate, dual extraction, field assertions.
 *
 * Spec references: `04` Phase 3.2 and 3.3, `08` (extraction architecture, quality gate),
 * `17` (dual extraction requirement), `06` Journey 2, `24` (capture done criteria).
 *
 * THE PIPELINE
 *   guided images -> quality gate -> barcode decode -> OCR -> vision extraction ->
 *   agreement check -> deterministic validation -> field assertions -> user confirmation
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE
 *
 *  1. **Expensive processing runs only on readable evidence.** `08`: check for blur, glare,
 *     crop loss, orientation and minimum text readability *before* extraction. `17` adds a cost
 *     rationale: a model call on an unreadable image is spend with no possible return.
 *
 *  2. **Disagreement is a signal, not something to arbitrate.** `17`: "Disagreement should
 *     trigger re-extraction/user confirmation, not model arbitration by confidence alone." So
 *     when OCR and the vision model differ, this produces a field needing confirmation - never a
 *     winner picked by confidence.
 */

import type {
  DomainError,
  ExtractionAgreement,
  FieldAssertion,
  IdGenerator,
  Instant,
  ProvenanceKind,
  Result,
  Untrusted,
} from '@kynviora/domain';
import {
  compareExtractions,
  failure,
  ok,
  unsafeId,
  type FieldAssertionId,
  type EvidenceAssetId,
  type ExtractionRunId,
} from '@kynviora/domain';

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

/** Panels a guided capture may request (`08`). */
export const CAPTURE_PANELS = [
  'FRONT_PANEL',
  'INGREDIENT_PANEL',
  'BARCODE_PANEL',
  'BATCH_DATE_PANEL',
] as const;
export type CapturePanel = (typeof CAPTURE_PANELS)[number];

/**
 * Measurements a client reports about a captured image.
 *
 * Supplied by the capture surface rather than computed here, because the measurement needs the
 * pixels and this package is pure. The thresholds and the decision live here so they are
 * testable and consistent across clients.
 */
export interface ImageQualityMetrics {
  /** Variance-of-Laplacian style sharpness score. Higher is sharper. */
  readonly sharpness: number;
  /** Fraction of pixels blown out to white, 0..1. */
  readonly overexposedFraction: number;
  /** Fraction of pixels crushed to black, 0..1. */
  readonly underexposedFraction: number;
  /** Whether the detected document edges fall inside the frame. */
  readonly edgesWithinFrame: boolean;
  /** Estimated rotation from upright, in degrees. */
  readonly rotationDegrees: number;
  /** Shortest image side in pixels. */
  readonly shortestSidePixels: number;
  /** Perceptual hash, for duplicate detection across a capture session. */
  readonly perceptualHash: string | null;
}

/** Why a capture was rejected. Stable codes so the UI can give specific retake guidance. */
export const QUALITY_FAILURES = [
  'TOO_BLURRY',
  'GLARE_OR_OVEREXPOSED',
  'TOO_DARK',
  'EDGES_CROPPED',
  'TOO_ROTATED',
  'RESOLUTION_TOO_LOW',
  'DUPLICATE_OF_PREVIOUS',
] as const;
export type QualityFailure = (typeof QUALITY_FAILURES)[number];

export interface QualityThresholds {
  readonly minSharpness: number;
  readonly maxOverexposedFraction: number;
  readonly maxUnderexposedFraction: number;
  readonly maxRotationDegrees: number;
  readonly minShortestSidePixels: number;
}

/**
 * Default thresholds.
 *
 * **Engineering defaults, not validated against a labelled dataset** (`BLK-008`). They are
 * deliberately permissive: rejecting a readable image costs a user a retake and erodes trust in
 * the capture flow, while accepting a marginal one costs a wasted extraction that the
 * agreement check and user confirmation will still catch. Spec 09.1 requires these to be
 * measured and approved before release.
 */
export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = Object.freeze({
  minSharpness: 100,
  maxOverexposedFraction: 0.15,
  maxUnderexposedFraction: 0.4,
  maxRotationDegrees: 15,
  minShortestSidePixels: 720,
});

export interface QualityGateResult {
  readonly accepted: boolean;
  readonly failures: readonly QualityFailure[];
  /** Plain-language retake guidance, in the order most likely to help. */
  readonly retakeGuidance: readonly string[];
}

const RETAKE_GUIDANCE: Readonly<Record<QualityFailure, string>> = Object.freeze({
  TOO_BLURRY: 'Hold the phone steady and let it focus before taking the photo.',
  GLARE_OR_OVEREXPOSED: 'Move away from direct light, or tilt the pack to avoid the reflection.',
  TOO_DARK: 'Move somewhere brighter, or turn on a light.',
  EDGES_CROPPED: 'Move back a little so the whole panel fits in the frame.',
  TOO_ROTATED: 'Line the pack up with the edges of the screen.',
  RESOLUTION_TOO_LOW: 'Move closer to the pack so the text is larger.',
  DUPLICATE_OF_PREVIOUS: 'This looks like the photo you just took. Capture the other panel.',
});

/**
 * Decide whether an image is good enough to process.
 *
 * Every failing check is reported rather than just the first, so a user gets complete guidance
 * in one retake instead of discovering problems one at a time.
 */
export function evaluateImageQuality(
  metrics: ImageQualityMetrics,
  options: {
    readonly thresholds?: QualityThresholds;
    /** Perceptual hashes already accepted in this session, for duplicate detection. */
    readonly previousHashes?: readonly string[];
  } = {},
): QualityGateResult {
  const thresholds = options.thresholds ?? DEFAULT_QUALITY_THRESHOLDS;
  const failures: QualityFailure[] = [];

  if (metrics.sharpness < thresholds.minSharpness) failures.push('TOO_BLURRY');
  if (metrics.overexposedFraction > thresholds.maxOverexposedFraction) {
    failures.push('GLARE_OR_OVEREXPOSED');
  }
  if (metrics.underexposedFraction > thresholds.maxUnderexposedFraction) failures.push('TOO_DARK');
  if (!metrics.edgesWithinFrame) failures.push('EDGES_CROPPED');
  if (Math.abs(metrics.rotationDegrees) > thresholds.maxRotationDegrees) {
    failures.push('TOO_ROTATED');
  }
  if (metrics.shortestSidePixels < thresholds.minShortestSidePixels) {
    failures.push('RESOLUTION_TOO_LOW');
  }

  // Duplicate detection serves two purposes: it stops a user accidentally submitting the same
  // panel twice, and it is one input to the corroboration independence checks (`08`, threat A11).
  if (
    metrics.perceptualHash !== null &&
    (options.previousHashes ?? []).includes(metrics.perceptualHash)
  ) {
    failures.push('DUPLICATE_OF_PREVIOUS');
  }

  return {
    accepted: failures.length === 0,
    failures,
    retakeGuidance: failures.map((f) => RETAKE_GUIDANCE[f]),
  };
}

// ---------------------------------------------------------------------------
// Extraction ports
// ---------------------------------------------------------------------------

/** One field an extractor produced, before validation or confirmation. */
export interface ExtractedField {
  readonly fieldPath: string;
  /** Exactly as read. Null when the extractor abstained. */
  readonly rawValue: string | null;
  /** Extractor-reported confidence, 0..1. Never the sole basis for trust (`17`). */
  readonly confidence: number;
  readonly sourceRegion?: FieldAssertion['sourceRegion'];
}

export interface ExtractionResult {
  readonly engine: 'BARCODE_DECODER' | 'OCR' | 'VISION_MODEL' | 'DETERMINISTIC_PARSER';
  readonly engineVersion: string;
  readonly fields: readonly ExtractedField[];
}

/**
 * An extraction engine.
 *
 * Takes `Untrusted` content, because an image and any text derived from it may carry instructions
 * aimed at a model (`17`, DEC-017). Returns candidates only - there is no path from an extractor
 * to a trusted field.
 */
export interface Extractor {
  readonly engine: ExtractionResult['engine'];
  readonly engineVersion: string;
  extract(
    content: Untrusted<string>,
    panel: CapturePanel,
  ): Promise<Result<ExtractionResult, DomainError>>;
}

/** A deterministic validator for one field. */
export interface FieldValidator {
  readonly fieldPath: string;
  readonly validator: string;
  readonly validatorVersion: string;
  /** Returns the normalized value, or a failure. Pure and deterministic. */
  validate(rawValue: string): Result<unknown, DomainError>;
}

// ---------------------------------------------------------------------------
// Dual extraction reconciliation
// ---------------------------------------------------------------------------

export interface ReconciledField {
  readonly fieldPath: string;
  readonly agreement: ExtractionAgreement;
  /** The value both mechanisms agreed on, or null when they did not. */
  readonly agreedRawValue: string | null;
  readonly ocrValue: string | null;
  readonly visionValue: string | null;
  /**
   * Whether a human must confirm this field before a rule may rely on it.
   *
   * True whenever the mechanisms disagreed, or only one produced a value. `17` forbids resolving
   * a disagreement by picking the higher confidence, so there is no path where a disagreement
   * silently becomes a trusted value.
   */
  readonly requiresConfirmation: boolean;
}

/** Field-specific comparison rules, so equivalent readings are not treated as disagreement. */
export type FieldNormalizer = (value: string) => string;

const DEFAULT_NORMALIZER: FieldNormalizer = (value) =>
  value.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Reconcile two independent extractions of the same panel.
 *
 * `17`: agreement is "evidence of extraction consistency, not absolute truth", so even an
 * agreeing field still goes through deterministic validation before it can be trusted.
 */
export function reconcileExtractions(
  ocr: ExtractionResult,
  vision: ExtractionResult,
  normalizers: Readonly<Record<string, FieldNormalizer>> = {},
): readonly ReconciledField[] {
  const fieldPaths = new Set([
    ...ocr.fields.map((f) => f.fieldPath),
    ...vision.fields.map((f) => f.fieldPath),
  ]);

  return [...fieldPaths].sort().map((fieldPath) => {
    const ocrValue = ocr.fields.find((f) => f.fieldPath === fieldPath)?.rawValue ?? null;
    const visionValue = vision.fields.find((f) => f.fieldPath === fieldPath)?.rawValue ?? null;
    const normalize = normalizers[fieldPath] ?? DEFAULT_NORMALIZER;

    const agreement = compareExtractions(ocrValue, visionValue, normalize);

    return {
      fieldPath,
      agreement,
      agreedRawValue: agreement === 'AGREE' ? ocrValue : null,
      ocrValue,
      visionValue,
      // Only mutual agreement avoids confirmation. A single source is not corroborated, and a
      // disagreement must never be arbitrated by confidence.
      requiresConfirmation: agreement !== 'AGREE',
    };
  });
}

// ---------------------------------------------------------------------------
// Assertion building
// ---------------------------------------------------------------------------

export interface BuildAssertionInput {
  readonly reconciled: ReconciledField;
  readonly evidenceAssetId: EvidenceAssetId;
  readonly extractionRunId: ExtractionRunId;
  readonly extractorVersion: string;
  readonly validator?: FieldValidator;
  readonly assertedAt: Instant;
  readonly ids: IdGenerator;
  /**
   * Provenance to record.
   *
   * Defaults to `PACKAGE_OCR`, which `isTrustedForSafetyUse` treats as unconfirmed machine
   * output - so a field built here cannot drive a safety rule until a human confirms it.
   */
  readonly provenance?: ProvenanceKind;
}

/**
 * Build a field assertion from a reconciled extraction.
 *
 * The assertion is created in an **unconfirmed** state whenever the mechanisms disagreed or only
 * one produced a value. `08`: "Every trusted field can be traced to package evidence, approved
 * external evidence, or explicit user confirmation."
 */
export function buildFieldAssertion(input: BuildAssertionInput): FieldAssertion {
  const { reconciled, validator, assertedAt, ids } = input;

  const rawValue = reconciled.agreedRawValue ?? reconciled.ocrValue ?? reconciled.visionValue;

  // Validation runs on whatever value exists, including a single-source one - a malformed date
  // should be rejected regardless of how many mechanisms saw it.
  let normalizedValue: unknown = null;
  let validation: FieldAssertion['validation'] = {
    outcome: 'NOT_RUN',
    validator: 'none',
    validatorVersion: '0',
  };

  if (validator && rawValue !== null) {
    const result = validator.validate(rawValue);
    if (result.ok) {
      normalizedValue = result.value;
      validation = {
        outcome: 'PASSED',
        validator: validator.validator,
        validatorVersion: validator.validatorVersion,
      };
    } else {
      validation = {
        outcome: 'FAILED',
        validator: validator.validator,
        validatorVersion: validator.validatorVersion,
        reason: String(result.error.detail?.reason_code ?? result.error.code),
      };
    }
  } else if (rawValue !== null) {
    // No validator for this field: the raw value is carried through, but with NOT_RUN it can
    // never satisfy isTrustedForSafetyUse without human confirmation.
    normalizedValue = rawValue;
  }

  return {
    id: unsafeId<FieldAssertionId>(ids.next()),
    fieldPath: reconciled.fieldPath,
    rawValue,
    normalizedValue,
    provenance: input.provenance ?? 'PACKAGE_OCR',
    sourceAssetId: input.evidenceAssetId,
    extractionRunId: input.extractionRunId,
    validation,
    // Every machine-built assertion starts unconfirmed. Confirmation is a separate, explicit act.
    confirmation: 'UNCONFIRMED',
    extractorVersion: input.extractorVersion,
    assertedAt,
  };
}

/**
 * Record a user's confirmation or correction of a field.
 *
 * Append-only (DEC-013): this returns a **new** assertion superseding the original, so the
 * machine's original reading remains inspectable. That matters when investigating a wrong match -
 * knowing what OCR actually read is the difference between an extraction bug and a user error.
 */
export function confirmFieldAssertion(
  original: FieldAssertion,
  outcome:
    | { readonly kind: 'CONFIRMED' }
    | { readonly kind: 'CORRECTED'; readonly rawValue: string; readonly normalizedValue: unknown }
    | { readonly kind: 'REJECTED' },
  context: { readonly assertedAt: Instant; readonly ids: IdGenerator },
): FieldAssertion {
  const base = {
    ...original,
    id: unsafeId<FieldAssertionId>(context.ids.next()),
    assertedAt: context.assertedAt,
    supersedesId: original.id,
    // The provenance changes to reflect that a human looked at the package, which is what makes
    // the field usable by a safety rule.
    provenance: 'USER_CONFIRMED_FROM_PACKAGE' as ProvenanceKind,
  };

  switch (outcome.kind) {
    case 'CONFIRMED':
      return { ...base, confirmation: 'USER_CONFIRMED' };
    case 'CORRECTED':
      return {
        ...base,
        confirmation: 'USER_CORRECTED',
        rawValue: outcome.rawValue,
        normalizedValue: outcome.normalizedValue,
      };
    case 'REJECTED':
      return { ...base, confirmation: 'REJECTED', normalizedValue: null };
  }
}

// ---------------------------------------------------------------------------
// Capture session orchestration
// ---------------------------------------------------------------------------

export interface CaptureSessionState {
  readonly requestedPanels: readonly CapturePanel[];
  readonly acceptedPanels: readonly CapturePanel[];
  readonly acceptedHashes: readonly string[];
}

/** Which panels a guided capture should request for an item kind (`08`). */
export function requiredPanelsFor(
  itemKind: 'MEDICINE' | 'PERSONAL_CARE',
  options: { readonly hasBarcode: boolean; readonly hasPrintedBatch: boolean },
): readonly CapturePanel[] {
  const panels: CapturePanel[] = ['FRONT_PANEL', 'INGREDIENT_PANEL'];
  if (options.hasBarcode) panels.push('BARCODE_PANEL');
  if (options.hasPrintedBatch) panels.push('BATCH_DATE_PANEL');

  // Medicines and personal care request the same panel set; the difference is what the
  // "ingredient" panel means - an active-ingredient/strength panel versus an INCI declaration.
  return itemKind === 'MEDICINE' ? panels : panels;
}

/** Whether the session has everything it needs to attempt resolution. */
export function isCaptureComplete(state: CaptureSessionState): boolean {
  return state.requestedPanels.every((panel) => state.acceptedPanels.includes(panel));
}

/**
 * Accept a captured panel into the session, or reject it with guidance.
 *
 * Returns a `Result` rather than throwing because a rejected capture is the expected path, not
 * an error: `08` requires unreadable evidence to trigger a retake rather than a guess.
 */
export function acceptPanel(
  state: CaptureSessionState,
  panel: CapturePanel,
  metrics: ImageQualityMetrics,
  thresholds?: QualityThresholds,
): Result<CaptureSessionState, DomainError> {
  const options: Parameters<typeof evaluateImageQuality>[1] = thresholds
    ? { thresholds, previousHashes: state.acceptedHashes }
    : { previousHashes: state.acceptedHashes };

  const quality = evaluateImageQuality(metrics, options);

  if (!quality.accepted) {
    return failure('QUALITY_GATE_FAILED', 'Image did not pass the quality gate.', {
      reason_code: quality.failures[0] ?? 'unknown',
      failure_count: quality.failures.length,
    });
  }

  return ok({
    requestedPanels: state.requestedPanels,
    acceptedPanels: state.acceptedPanels.includes(panel)
      ? state.acceptedPanels
      : [...state.acceptedPanels, panel],
    acceptedHashes:
      metrics.perceptualHash === null
        ? state.acceptedHashes
        : [...state.acceptedHashes, metrics.perceptualHash],
  });
}
