import { describe, it, expect } from 'vitest';
import {
  computeFingerprint,
  canonicalizeForFingerprint,
  sameApparentFormulation,
  isCrossVersionComparison,
  FINGERPRINT_VERSION,
  type PersonalCareFingerprintInput,
  type MedicineFingerprintInput,
  type Fingerprint,
} from './fingerprint.js';
import { parseAndNormalize, aliasResolverFrom } from './ingredients.js';
import { marketCode } from '@kynviora/domain';

const resolver = aliasResolverFrom(
  new Map([
    ['aqua', [{ substanceId: 's-water', canonicalKey: 'WATER' }]],
    ['glycerin', [{ substanceId: 's-gly', canonicalKey: 'GLYCERIN' }]],
    ['salicylic acid', [{ substanceId: 's-sa', canonicalKey: 'SALICYLIC_ACID' }]],
    ['parfum', [{ substanceId: 's-parfum', canonicalKey: 'PARFUM' }]],
  ]),
);

function personalCare(
  declaration: string,
  overrides: Partial<PersonalCareFingerprintInput> = {},
): PersonalCareFingerprintInput {
  return {
    kind: 'PERSONAL_CARE',
    market: marketCode('IN'),
    manufacturerKey: 'acme-labs',
    productUseType: 'LEAVE_ON',
    ingredients: parseAndNormalize(declaration, resolver),
    ...overrides,
  };
}

function medicine(overrides: Partial<MedicineFingerprintInput> = {}): MedicineFingerprintInput {
  return {
    kind: 'MEDICINE',
    market: marketCode('IN'),
    manufacturerKey: 'acme-pharma',
    dosageForm: 'tablet',
    activeIngredients: [{ key: 'paracetamol', strengthValue: 500, strengthUnit: 'mg' }],
    ...overrides,
  };
}

describe('determinism', () => {
  it('produces the same hash for identical input', () => {
    const a = computeFingerprint(personalCare('Aqua, Glycerin, Salicylic Acid'));
    const b = computeFingerprint(personalCare('Aqua, Glycerin, Salicylic Acid'));
    expect(a.hash).toBe(b.hash);
  });

  it('is insensitive to label casing and spacing that carry no meaning', () => {
    const a = computeFingerprint(personalCare('Aqua, Glycerin'));
    const b = computeFingerprint(personalCare('AQUA,   glycerin'));
    expect(a.hash).toBe(b.hash);
  });

  it('records the algorithm version on every fingerprint', () => {
    // Spec 08 requires the version to be stored so the algorithm can evolve without rewriting
    // history.
    expect(computeFingerprint(personalCare('Aqua')).version).toBe(FINGERPRINT_VERSION);
  });

  it('exposes the exact canonical input for reviewer investigation', () => {
    // A reviewer investigating a false merge must be able to see what the algorithm considered
    // material, rather than reverse-engineering it from a digest.
    const fp = computeFingerprint(personalCare('Aqua, Glycerin'));
    expect(fp.canonicalInput).toContain('k:PERSONAL_CARE');
    expect(fp.canonicalInput).toContain('mk:in');
    expect(fp.canonicalInput).toContain('WATER');
    expect(fp.canonicalInput).toContain('GLYCERIN');
  });
});

describe('order sensitivity (spec 08: INCI order encodes concentration)', () => {
  it('produces a different hash when ingredients are reordered', () => {
    // A set-based hash would silently merge a reformulation that moved an active ingredient -
    // a false merge with direct safety consequences.
    const original = computeFingerprint(personalCare('Aqua, Glycerin, Salicylic Acid'));
    const reordered = computeFingerprint(personalCare('Aqua, Salicylic Acid, Glycerin'));
    expect(original.hash).not.toBe(reordered.hash);
    expect(sameApparentFormulation(original, reordered)).toBe(false);
  });

  it('does not reorder actives for medicines, where printed order is not meaningful', () => {
    // Unlike an INCI declaration, the printed order of actives on a medicine pack carries no
    // concentration meaning, so two packs listing the same actives differently are the same
    // formulation. Sorting prevents a false *split*.
    const a = computeFingerprint(
      medicine({
        activeIngredients: [
          { key: 'paracetamol', strengthValue: 500, strengthUnit: 'mg' },
          { key: 'caffeine', strengthValue: 30, strengthUnit: 'mg' },
        ],
      }),
    );
    const b = computeFingerprint(
      medicine({
        activeIngredients: [
          { key: 'caffeine', strengthValue: 30, strengthUnit: 'mg' },
          { key: 'paracetamol', strengthValue: 500, strengthUnit: 'mg' },
        ],
      }),
    );
    expect(sameApparentFormulation(a, b)).toBe(true);
  });
});

describe('false-merge safeguards (spec 19)', () => {
  it('distinguishes an added ingredient', () => {
    const without = computeFingerprint(personalCare('Aqua, Glycerin'));
    const withExtra = computeFingerprint(personalCare('Aqua, Glycerin, Parfum'));
    expect(without.hash).not.toBe(withExtra.hash);
  });

  it('distinguishes a removed ingredient', () => {
    const full = computeFingerprint(personalCare('Aqua, Glycerin, Parfum'));
    const reduced = computeFingerprint(personalCare('Aqua, Glycerin'));
    expect(full.hash).not.toBe(reduced.hash);
  });

  it('does not drop unresolved ingredients from the hash', () => {
    // If unmapped tokens were skipped, a formulation containing an unknown substance would hash
    // identically to one without it - a false merge that hides a real difference.
    const known = computeFingerprint(personalCare('Aqua, Glycerin'));
    const withUnknown = computeFingerprint(personalCare('Aqua, Glycerin, Zzzunknownium'));
    expect(known.hash).not.toBe(withUnknown.hash);
    expect(withUnknown.canonicalInput).toContain('raw:zzzunknownium');
  });

  it('distinguishes markets', () => {
    // The same barcode and formula can be a different marketed product in another jurisdiction.
    const india = computeFingerprint(personalCare('Aqua, Glycerin', { market: marketCode('IN') }));
    const france = computeFingerprint(personalCare('Aqua, Glycerin', { market: marketCode('FR') }));
    expect(india.hash).not.toBe(france.hash);
  });

  it('distinguishes rinse-off from leave-on', () => {
    // Materially relevant: EU Annex III conditions are frequently expressed in exactly these
    // terms, so the same declaration in a rinse-off vs leave-on product is a different subject.
    const leaveOn = computeFingerprint(personalCare('Aqua', { productUseType: 'LEAVE_ON' }));
    const rinseOff = computeFingerprint(personalCare('Aqua', { productUseType: 'RINSE_OFF' }));
    expect(leaveOn.hash).not.toBe(rinseOff.hash);
  });

  it('distinguishes manufacturers', () => {
    const a = computeFingerprint(personalCare('Aqua', { manufacturerKey: 'acme-labs' }));
    const b = computeFingerprint(personalCare('Aqua', { manufacturerKey: 'other-labs' }));
    expect(a.hash).not.toBe(b.hash);
  });

  it('distinguishes a disclosed concentration from an undisclosed one', () => {
    // "2% salicylic acid" and "salicylic acid" are materially different evidence, and the
    // difference is exactly what a concentration-limited rule turns on.
    const undisclosed = computeFingerprint(personalCare('Aqua, Salicylic Acid'));
    const disclosed = computeFingerprint(personalCare('Aqua, Salicylic Acid (2%)'));
    expect(undisclosed.hash).not.toBe(disclosed.hash);
    expect(undisclosed.canonicalInput).toContain('c:none');
    expect(disclosed.canonicalInput).toContain('c:2.000');
  });

  it('distinguishes medicine strengths', () => {
    const low = computeFingerprint(
      medicine({
        activeIngredients: [{ key: 'paracetamol', strengthValue: 500, strengthUnit: 'mg' }],
      }),
    );
    const high = computeFingerprint(
      medicine({
        activeIngredients: [{ key: 'paracetamol', strengthValue: 650, strengthUnit: 'mg' }],
      }),
    );
    expect(low.hash).not.toBe(high.hash);
  });

  it('distinguishes dosage forms', () => {
    const tablet = computeFingerprint(medicine({ dosageForm: 'tablet' }));
    const syrup = computeFingerprint(medicine({ dosageForm: 'syrup' }));
    expect(tablet.hash).not.toBe(syrup.hash);
  });

  it('prevents separator forgery from colliding two formulations', () => {
    // Without field escaping, an ingredient literally named `a|b` could serialize identically to
    // two ingredients `a` and `b`. Spec 04 Phase 5.3 requires collision safeguards.
    const forged = computeFingerprint(personalCare('a|b'));
    const genuine = computeFingerprint(personalCare('a, b'));
    expect(forged.hash).not.toBe(genuine.hash);
  });
});

describe('degraded fingerprints (spec 08: missing strength/form is not an exact match)', () => {
  it('marks a medicine with no stated strength as degraded', () => {
    const fp = computeFingerprint(
      medicine({
        activeIngredients: [{ key: 'paracetamol', strengthValue: null, strengthUnit: null }],
      }),
    );
    expect(fp.degraded).toBe(true);
  });

  it('marks a medicine with no dosage form as degraded', () => {
    expect(computeFingerprint(medicine({ dosageForm: null })).degraded).toBe(true);
  });

  it('marks a medicine with no actives as degraded', () => {
    expect(computeFingerprint(medicine({ activeIngredients: [] })).degraded).toBe(true);
  });

  it('does not mark a complete medicine as degraded', () => {
    expect(computeFingerprint(medicine()).degraded).toBe(false);
  });

  it('marks an empty personal-care declaration as degraded', () => {
    expect(computeFingerprint(personalCare('')).degraded).toBe(true);
  });

  it('does not mark a complete personal-care declaration as degraded', () => {
    expect(computeFingerprint(personalCare('Aqua, Glycerin')).degraded).toBe(false);
  });
});

describe('cross-version comparison', () => {
  const withVersion = (fp: Fingerprint, version: string): Fingerprint => ({ ...fp, version });

  it('refuses to treat different algorithm versions as comparable', () => {
    // A fp-1 hash and a fp-2 hash of the same product are unrelated values. Treating inequality
    // as a formulation change would create a spurious conflict for every product the moment the
    // algorithm is revised.
    const v1 = computeFingerprint(personalCare('Aqua, Glycerin'));
    const v2 = withVersion(v1, 'fp-2');
    expect(sameApparentFormulation(v1, v2)).toBe(false);
    expect(isCrossVersionComparison(v1, v2)).toBe(true);
  });

  it('reports same-version comparisons as comparable', () => {
    const a = computeFingerprint(personalCare('Aqua'));
    const b = computeFingerprint(personalCare('Aqua'));
    expect(isCrossVersionComparison(a, b)).toBe(false);
    expect(sameApparentFormulation(a, b)).toBe(true);
  });

  it('embeds the version in the canonical input', () => {
    const { canonical } = canonicalizeForFingerprint(personalCare('Aqua'));
    expect(canonical).toContain(`v:${FINGERPRINT_VERSION}`);
  });
});

describe('fingerprint is not an identity claim (spec 08, DEC-015)', () => {
  it('never equals a formulation identifier by construction', () => {
    // The branded type makes `fingerprint === formulationId` a compile error. At runtime the
    // hash is a 64-char hex digest, structurally distinct from a UUID.
    const fp = computeFingerprint(personalCare('Aqua'));
    expect(fp.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.hash).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('is named to signal that a match is a candidate, not proof', () => {
    // sameApparentFormulation, deliberately not `equals`: a match raises a candidate that
    // corroboration and evidence checks still have to confirm.
    const a = computeFingerprint(personalCare('Aqua'));
    expect(sameApparentFormulation(a, a)).toBe(true);
  });
});
