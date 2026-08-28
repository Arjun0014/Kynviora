/**
 * Deterministic formulation fingerprinting (DEC-015).
 *
 * Spec references: `08` "Formulation fingerprint", `04` Phase 5.3, `19` (false-merge and
 * false-split testing).
 *
 * WHAT A FINGERPRINT IS
 * A fast, deterministic signal that two observations *appear to describe the same formulation*,
 * so a repeat scan can reuse an existing catalog record instead of triggering expensive
 * extraction and research (`08` cost model, `03` group K).
 *
 * WHAT A FINGERPRINT IS NOT
 * `08` is explicit: "The fingerprint is not a cryptographic proof that two physical products are
 * identical." A match raises a *candidate*; corroboration and evidence checks still decide.
 * The return type is branded (`FingerprintHash`) precisely so it cannot be compared against, or
 * substituted for, an entity identifier.
 *
 * ORDER SENSITIVITY
 * INCI declarations are ordered by decreasing concentration, so reordering is a material
 * difference and the fingerprint preserves order. A set-based hash would silently merge a
 * reformulation that moved an active ingredient from second to eighth place - a false merge with
 * direct safety consequences.
 *
 * VERSIONING
 * Every fingerprint is stored with its algorithm version so the algorithm can evolve without
 * rewriting history (`08`). Comparing across versions is meaningless and is refused.
 */

import { createHash } from 'node:crypto';
import type { FingerprintHash, ItemKind, MarketCode, ProductUseType } from '@kynviora/domain';
import { unsafeId } from '@kynviora/domain';
import type { NormalizedIngredient } from './ingredients.js';

/**
 * Current fingerprint algorithm version.
 *
 * Bump on any change to the canonical serialization. Existing rows keep their old version and
 * remain comparable among themselves.
 */
export const FINGERPRINT_VERSION = 'fp-1' as const;
export type FingerprintVersion = string;

/** An active ingredient with its strength, for medicine fingerprinting. */
export interface ActiveIngredientInput {
  /** Canonical substance key when resolved, otherwise the normalized label term. */
  readonly key: string;
  /** Numeric strength value, e.g. 500 for "500 mg". Null when the label does not state one. */
  readonly strengthValue: number | null;
  /** Normalized unit, e.g. `mg`, `mcg`, `ml`. Null when absent. */
  readonly strengthUnit: string | null;
}

export interface PersonalCareFingerprintInput {
  readonly kind: 'PERSONAL_CARE';
  readonly market: MarketCode;
  readonly manufacturerKey: string | null;
  readonly productUseType: ProductUseType;
  /** Ordered, as declared. Order is preserved in the hash. */
  readonly ingredients: readonly NormalizedIngredient[];
}

export interface MedicineFingerprintInput {
  readonly kind: 'MEDICINE';
  readonly market: MarketCode;
  readonly manufacturerKey: string | null;
  /**
   * Active ingredients. Sorted by canonical key before hashing, because - unlike an INCI
   * declaration - the printed order of actives on a medicine pack carries no concentration
   * meaning, so two packs listing the same actives in a different order are the same formulation.
   */
  readonly activeIngredients: readonly ActiveIngredientInput[];
  readonly dosageForm: string | null;
}

export type FingerprintInput = PersonalCareFingerprintInput | MedicineFingerprintInput;

export interface Fingerprint {
  readonly hash: FingerprintHash;
  readonly version: FingerprintVersion;
  /**
   * The exact string that was hashed.
   *
   * Retained so a reviewer investigating a false merge or false split can see precisely what the
   * algorithm considered material, rather than having to reverse-engineer it from a hash.
   */
  readonly canonicalInput: string;
  /**
   * True when the input lacked fields the algorithm considers material - for example a medicine
   * with no stated strength.
   *
   * Spec 08: "A result missing material strength/form information is not an exact medicine
   * match." A degraded fingerprint may still be computed for grouping, but callers must not
   * treat a match on one as an exact-identity signal.
   */
  readonly degraded: boolean;
}

/** Normalize a free-text key: casefold, collapse whitespace, strip punctuation. */
function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Escape a field so that separators inside a value cannot forge a field boundary.
 *
 * Without this, an ingredient literally named `a|b` could produce the same canonical string as
 * two ingredients `a` and `b` - a fingerprint collision reachable by a hostile or merely odd
 * label. This is the "collision/conflict safeguard" required by `04` Phase 5.3.
 */
function escapeField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/;/g, '\\;');
}

/**
 * Serialize one ingredient for hashing.
 *
 * An unresolved token contributes its normalized label term rather than being skipped. Dropping
 * unmapped ingredients would make a formulation containing an unknown substance hash identically
 * to one without it.
 */
function serializeIngredient(ingredient: NormalizedIngredient): string {
  const key = ingredient.canonicalKey ?? `raw:${ingredient.lookupKey}`;
  // A disclosed concentration is material when present, and its absence is equally material -
  // encoded explicitly rather than by omission so the two cases cannot collide.
  const concentration =
    ingredient.disclosedConcentrationPercent === null
      ? 'c:none'
      : `c:${ingredient.disclosedConcentrationPercent.toFixed(3)}`;
  return `${escapeField(key)};${concentration}`;
}

function serializeActive(active: ActiveIngredientInput): string {
  const key = escapeField(normalizeKey(active.key));
  const strength =
    active.strengthValue === null || active.strengthUnit === null
      ? 's:none'
      : `s:${active.strengthValue}${escapeField(normalizeKey(active.strengthUnit))}`;
  return `${key};${strength}`;
}

/**
 * Build the canonical string that will be hashed.
 *
 * Exported so tests and reviewers can assert on the exact material content rather than on an
 * opaque digest.
 */
export function canonicalizeForFingerprint(input: FingerprintInput): {
  canonical: string;
  degraded: boolean;
} {
  const market = escapeField(normalizeKey(input.market));
  const manufacturer =
    input.manufacturerKey === null ? 'm:none' : `m:${escapeField(normalizeKey(input.manufacturerKey))}`;

  if (input.kind === 'PERSONAL_CARE') {
    // Order preserved: position is material for INCI declarations.
    const ingredients = input.ingredients.map(serializeIngredient).join('|');
    const degraded = input.ingredients.length === 0;
    const canonical = [
      `v:${FINGERPRINT_VERSION}`,
      'k:PERSONAL_CARE',
      `mk:${market}`,
      manufacturer,
      `u:${input.productUseType}`,
      `i:${ingredients}`,
    ].join('||');
    return { canonical, degraded };
  }

  // Medicines: sort actives by key so printed order does not create a false split.
  const actives = [...input.activeIngredients]
    .map(serializeActive)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join('|');

  const form = input.dosageForm === null ? 'f:none' : `f:${escapeField(normalizeKey(input.dosageForm))}`;

  // Spec 08: missing strength or form means this is not an exact medicine match.
  const degraded =
    input.activeIngredients.length === 0 ||
    input.dosageForm === null ||
    input.activeIngredients.some((a) => a.strengthValue === null || a.strengthUnit === null);

  const canonical = [
    `v:${FINGERPRINT_VERSION}`,
    'k:MEDICINE',
    `mk:${market}`,
    manufacturer,
    form,
    `a:${actives}`,
  ].join('||');

  return { canonical, degraded };
}

/** Compute a formulation fingerprint. Pure and deterministic. */
export function computeFingerprint(input: FingerprintInput): Fingerprint {
  const { canonical, degraded } = canonicalizeForFingerprint(input);
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return {
    hash: unsafeId<FingerprintHash>(hash),
    version: FINGERPRINT_VERSION,
    canonicalInput: canonical,
    degraded,
  };
}

/**
 * Whether two fingerprints indicate the same apparent formulation.
 *
 * Refuses to compare across algorithm versions: a `fp-1` hash and a `fp-2` hash of the same
 * product are unrelated values, and treating inequality as a formulation change would produce a
 * spurious conflict for every product the moment the algorithm is revised.
 *
 * Named `sameApparentFormulation`, not `equals`, because a match is a candidate signal and never
 * proof of product identity (`08`).
 */
export function sameApparentFormulation(a: Fingerprint, b: Fingerprint): boolean {
  if (a.version !== b.version) return false;
  return a.hash === b.hash;
}

/** True when two fingerprints were produced by different algorithm versions. */
export function isCrossVersionComparison(a: Fingerprint, b: Fingerprint): boolean {
  return a.version !== b.version;
}

/** Item kind a fingerprint input describes, for storage alongside the hash. */
export function fingerprintItemKind(input: FingerprintInput): ItemKind {
  return input.kind;
}
