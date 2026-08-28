/**
 * Field-level provenance and assertion model (`07`, `08`, DEC-013).
 *
 * `08_PRODUCT_IDENTITY_AND_CATALOG.md`: "The user-facing structured UI is generated from these
 * fields. Do not store an LLM paragraph as the hidden product record."
 *
 * A `FieldAssertion` is an immutable, provenance-bearing claim about **one** field. Correction
 * inserts a new assertion that supersedes its predecessor; nothing is ever mutated in place,
 * because `09` requires that replaying an assessment reproduce its result, which is only
 * possible if the exact input version an assessment consumed remains retrievable.
 */

import type { Instant } from './ports.js';
import type {
  EvidenceAssetId,
  ExtractionRunId,
  FieldAssertionId,
  SourceRegistryEntryId,
} from './ids.js';
import type { ProvenanceKind } from './vocabulary.js';
import { UNCONFIRMED_MACHINE_PROVENANCE } from './vocabulary.js';

/**
 * Where in the source evidence a value was found.
 *
 * `08` requires "source image region/text location when available" so a reviewer or user can see
 * *where on the package* a claim came from. Optional because manual entry and provider responses
 * have no image region.
 */
export interface SourceRegion {
  /** Normalised bounding box, 0..1 relative to the asset, origin top-left. */
  readonly boundingBox?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Character offsets into the extracted text, for document sources. */
  readonly textSpan?: { readonly start: number; readonly end: number };
  /** Page number for multi-page documents, 1-based. */
  readonly page?: number;
}

/** Outcome of running a deterministic validator over a candidate value (`08`). */
export const VALIDATION_OUTCOMES = ['PASSED', 'FAILED', 'NOT_APPLICABLE', 'NOT_RUN'] as const;
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];

export interface DeterministicValidation {
  readonly outcome: ValidationOutcome;
  /** Identifier of the validator, e.g. `gtin.checkDigit`, `date.expiry`, `strength.parse`. */
  readonly validator: string;
  readonly validatorVersion: string;
  /** Non-sensitive machine reason when the outcome is FAILED. */
  readonly reason?: string;
}

/** Confirmation lifecycle of an assertion (`08`). */
export const CONFIRMATION_STATES = [
  'UNCONFIRMED',
  'USER_CONFIRMED',
  'USER_CORRECTED',
  'REVIEWER_CONFIRMED',
  'AUTO_VALIDATED',
  'REJECTED',
] as const;
export type ConfirmationState = (typeof CONFIRMATION_STATES)[number];

/**
 * An immutable, provenance-bearing claim about a single field.
 *
 * @typeParam TValue - the normalized value type for this field path.
 */
export interface FieldAssertion<TValue = unknown> {
  readonly id: FieldAssertionId;

  /** Dotted path identifying the field, e.g. `formulation.ingredientDeclaration`. */
  readonly fieldPath: string;

  /** Exactly as it appeared in the source, before normalization. Never overwritten (`05.1`). */
  readonly rawValue: string | null;

  /** The normalized value a rule or projection may consume. */
  readonly normalizedValue: TValue | null;

  readonly provenance: ProvenanceKind;

  /** Evidence asset this claim was read from, when applicable. */
  readonly sourceAssetId?: EvidenceAssetId;
  /** External source that asserted this, when applicable. */
  readonly sourceRegistryEntryId?: SourceRegistryEntryId;
  /** The extraction run that produced this candidate, when machine-extracted. */
  readonly extractionRunId?: ExtractionRunId;

  readonly sourceRegion?: SourceRegion;

  /**
   * Extractor-reported confidence, 0..1.
   *
   * `18` forbids showing an uncalibrated percentage to users, so this is an internal signal
   * only. It is never the sole basis for trusting a safety-relevant field (`17`: disagreement
   * must not be resolved by "model arbitration by confidence alone").
   */
  readonly confidence?: number;

  readonly validation: DeterministicValidation;
  readonly confirmation: ConfirmationState;

  /** Version of the extractor/parser/model that produced this (`08`). */
  readonly extractorVersion: string;

  readonly assertedAt: Instant;

  /** Predecessor this assertion replaces. Append-only supersession (DEC-013). */
  readonly supersedesId?: FieldAssertionId;
}

/**
 * Whether a field may be relied upon by a safety rule.
 *
 * `17`: for safety-relevant fields, agreement between independent mechanisms is evidence of
 * extraction consistency; disagreement must trigger re-extraction or user confirmation. `08`:
 * "Every trusted field can be traced to package evidence, approved external evidence, or
 * explicit user confirmation."
 *
 * The predicate is deliberately conservative - abstaining is the correct behaviour when
 * certainty is insufficient (`19`: "The system should be rewarded for abstaining").
 */
export function isTrustedForSafetyUse(assertion: FieldAssertion): boolean {
  if (assertion.normalizedValue === null) return false;
  if (assertion.confirmation === 'REJECTED') return false;
  if (assertion.validation.outcome === 'FAILED') return false;

  // Explicit human confirmation always qualifies.
  if (
    assertion.confirmation === 'USER_CONFIRMED' ||
    assertion.confirmation === 'USER_CORRECTED' ||
    assertion.confirmation === 'REVIEWER_CONFIRMED'
  ) {
    return true;
  }

  // An unconfirmed machine proposal never qualifies on its own, however confident it claims to
  // be. This is the concrete enforcement of "a model cannot fill a missing field merely because
  // it is likely" (`17`).
  if (UNCONFIRMED_MACHINE_PROVENANCE.includes(assertion.provenance)) {
    return false;
  }

  // Deterministic sources (barcode decode, validated parser, official source, approved provider)
  // qualify once their validator has actually passed.
  return assertion.validation.outcome === 'PASSED';
}

/**
 * Reduce a set of assertions for one field to the current head.
 *
 * The head is the assertion that nothing else supersedes. Where several remain (concurrent
 * corrections), the most recently asserted wins, with the assertion ID as a deterministic
 * tie-break so the projection is stable across processes - important because `09` requires
 * reproducible replay.
 */
export function currentAssertion<TValue>(
  assertions: readonly FieldAssertion<TValue>[],
): FieldAssertion<TValue> | undefined {
  if (assertions.length === 0) return undefined;

  const superseded = new Set<string>();
  for (const a of assertions) {
    if (a.supersedesId !== undefined) superseded.add(a.supersedesId);
  }

  const heads = assertions.filter((a) => !superseded.has(a.id));
  if (heads.length === 0) return undefined;

  return heads.reduce((best, candidate) => {
    if (candidate.assertedAt > best.assertedAt) return candidate;
    if (candidate.assertedAt < best.assertedAt) return best;
    return candidate.id > best.id ? candidate : best;
  });
}

/** Group assertions by field path and return the current head of each. */
export function currentAssertionsByField(
  assertions: readonly FieldAssertion[],
): ReadonlyMap<string, FieldAssertion> {
  const byField = new Map<string, FieldAssertion[]>();
  for (const a of assertions) {
    const list = byField.get(a.fieldPath);
    if (list) list.push(a);
    else byField.set(a.fieldPath, [a]);
  }

  const heads = new Map<string, FieldAssertion>();
  for (const [fieldPath, list] of byField) {
    const head = currentAssertion(list);
    if (head) heads.set(fieldPath, head);
  }
  return heads;
}

/**
 * Agreement state between two independent extraction mechanisms (`08`, `17`).
 *
 * `AGREE` is *not* a guarantee of truth - `17` calls it "evidence of extraction consistency, not
 * absolute truth". `DISAGREE` must route to re-extraction or user confirmation.
 */
export const EXTRACTION_AGREEMENT = [
  'AGREE',
  'DISAGREE',
  'SINGLE_SOURCE',
  'BOTH_ABSTAINED',
] as const;
export type ExtractionAgreement = (typeof EXTRACTION_AGREEMENT)[number];

/**
 * Compare two independent extractions of the same field.
 *
 * @param normalize - field-specific comparison normalizer (e.g. case-folding, whitespace
 *        collapsing). Supplied by the caller because what counts as "the same value" is
 *        field-dependent: `10 MG` and `10mg` are the same strength, but two ingredient
 *        declarations differing in order are genuinely different (`08`).
 */
export function compareExtractions<TValue>(
  a: TValue | null,
  b: TValue | null,
  normalize: (v: TValue) => string = (v) => JSON.stringify(v),
): ExtractionAgreement {
  if (a === null && b === null) return 'BOTH_ABSTAINED';
  if (a === null || b === null) return 'SINGLE_SOURCE';
  return normalize(a) === normalize(b) ? 'AGREE' : 'DISAGREE';
}
