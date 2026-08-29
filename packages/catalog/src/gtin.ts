/**
 * GTIN / UPC / EAN validation and normalization.
 *
 * Spec references: `04` Phase 3.1, `08` "Barcode rules".
 *
 * `08` is explicit that a dedicated decoder must be used rather than an LLM, that check digits
 * and lengths must be validated, and - critically - that a barcode "never [proves] formula,
 * batch, expiry, or current label". This module therefore returns a *validated identifier*, not
 * an identity claim. Everything it produces still has to pass through the resolver and the
 * corroboration policy before it means anything.
 */

import { failure, ok, type Result, type DomainError } from '@kynviora/domain';

/** Supported symbologies, keyed by digit length. */
export const GTIN_LENGTHS = [8, 12, 13, 14] as const;
export type GtinLength = (typeof GTIN_LENGTHS)[number];

/** A GTIN that has passed length and check-digit validation. */
declare const gtinBrand: unique symbol;
export type ValidatedGtin = string & { readonly [gtinBrand]: 'ValidatedGtin' };

export interface GtinInfo {
  /** Zero-padded to 14 digits, the canonical form for cross-symbology comparison. */
  readonly gtin14: ValidatedGtin;
  /** The identifier as supplied, after whitespace and separator stripping. */
  readonly normalized: ValidatedGtin;
  readonly length: GtinLength;
  readonly symbology: 'GTIN-8' | 'UPC-A' | 'EAN-13' | 'GTIN-14';
}

/**
 * Compute the GS1 mod-10 check digit for a body of digits (the code without its check digit).
 *
 * GS1 weights alternate 3 and 1 from the **rightmost** body digit leftwards, which is why this
 * iterates in reverse rather than keying off absolute position - the latter silently breaks when
 * the same routine is reused across GTIN-8/12/13/14.
 */
export function computeCheckDigit(body: string): number {
  let sum = 0;
  for (let i = body.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(body[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/** Strip separators people naturally type or that appear in scanned payloads. */
function stripSeparators(raw: string): string {
  return raw.replace(/[\s\-_]/g, '');
}

/**
 * Validate and normalize a barcode identifier.
 *
 * Returns a `Result` rather than throwing because an invalid scan is an expected outcome that
 * the capture flow must handle by offering manual entry (`04` Phase 3.1: "Invalid scans cannot
 * create trusted item records" and "Camera denial does not block manual entry").
 */
export function parseGtin(raw: string): Result<GtinInfo, DomainError> {
  const cleaned = stripSeparators(raw);

  if (cleaned.length === 0) {
    return failure('INVALID_BARCODE', 'Barcode is empty.', { reason_code: 'empty' });
  }

  if (!/^\d+$/.test(cleaned)) {
    return failure('INVALID_BARCODE', 'Barcode contains non-digit characters.', {
      reason_code: 'non_numeric',
      length: cleaned.length,
    });
  }

  if (!(GTIN_LENGTHS as readonly number[]).includes(cleaned.length)) {
    return failure('INVALID_BARCODE', 'Barcode length is not a supported GTIN-8/12/13/14 length.', {
      reason_code: 'unsupported_length',
      length: cleaned.length,
    });
  }

  const length = cleaned.length as GtinLength;
  const body = cleaned.slice(0, -1);
  const supplied = Number(cleaned[cleaned.length - 1]);
  const expected = computeCheckDigit(body);

  if (supplied !== expected) {
    // A check-digit failure is the single most common sign of a misread scan or a typo. It must
    // never be waved through: spec 08 requires deterministic validation to reject the candidate.
    return failure('INVALID_BARCODE', 'Barcode check digit does not validate.', {
      reason_code: 'check_digit_mismatch',
      length,
    });
  }

  const symbology =
    length === 8 ? 'GTIN-8' : length === 12 ? 'UPC-A' : length === 13 ? 'EAN-13' : 'GTIN-14';

  return ok({
    gtin14: cleaned.padStart(14, '0') as ValidatedGtin,
    normalized: cleaned as ValidatedGtin,
    length,
    symbology,
  });
}

/**
 * Whether two barcode identifiers denote the same trade item.
 *
 * Compared in GTIN-14 space so a UPC-A and its EAN-13 representation of the same item match.
 * This answers "same trade item identifier", **not** "same product formulation" - spec 08
 * requires those to stay distinct, and the resolver treats a GTIN match as one signal among
 * several rather than as proof.
 */
export function sameTradeItem(a: GtinInfo, b: GtinInfo): boolean {
  return a.gtin14 === b.gtin14;
}
