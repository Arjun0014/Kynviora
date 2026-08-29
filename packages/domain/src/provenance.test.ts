import { describe, it, expect } from 'vitest';
import {
  isTrustedForSafetyUse,
  currentAssertion,
  currentAssertionsByField,
  compareExtractions,
  type FieldAssertion,
} from './provenance.js';
import { instantFrom } from './ports.js';
import { unsafeId, type FieldAssertionId } from './ids.js';
import type { ProvenanceKind } from './vocabulary.js';
import type { ConfirmationState, ValidationOutcome } from './provenance.js';

const t = (iso: string) => instantFrom(iso);

function assertion(overrides: Partial<FieldAssertion<string>> = {}): FieldAssertion<string> {
  return {
    id: unsafeId<FieldAssertionId>('a1'),
    fieldPath: 'formulation.ingredientDeclaration',
    rawValue: 'Aqua, Glycerin',
    normalizedValue: 'aqua,glycerin',
    provenance: 'USER_CONFIRMED_FROM_PACKAGE',
    validation: { outcome: 'PASSED', validator: 'ingredients.parse', validatorVersion: '1' },
    confirmation: 'USER_CONFIRMED',
    extractorVersion: 'manual-1',
    assertedAt: t('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('isTrustedForSafetyUse (spec 17: a model may not fill a field because it is likely)', () => {
  it('rejects an assertion with no normalized value', () => {
    expect(isTrustedForSafetyUse(assertion({ normalizedValue: null }))).toBe(false);
  });

  it('rejects a rejected assertion', () => {
    expect(isTrustedForSafetyUse(assertion({ confirmation: 'REJECTED' }))).toBe(false);
  });

  it('rejects an assertion whose deterministic validator failed', () => {
    expect(
      isTrustedForSafetyUse(
        assertion({
          validation: {
            outcome: 'FAILED',
            validator: 'gtin.checkDigit',
            validatorVersion: '1',
            reason: 'check_digit_mismatch',
          },
        }),
      ),
    ).toBe(false);
  });

  const machineProvenances: ProvenanceKind[] = ['PACKAGE_OCR', 'PACKAGE_VISION_MODEL'];

  it.each(machineProvenances)(
    'rejects unconfirmed %s output however high its confidence claims to be',
    (provenance) => {
      const a = assertion({
        provenance,
        confirmation: 'UNCONFIRMED',
        confidence: 0.999,
        validation: { outcome: 'PASSED', validator: 'noop', validatorVersion: '1' },
      });
      // This is the concrete enforcement of spec 17. A vision model claiming 99.9% certainty
      // about an ingredient list still cannot make that list trusted for a safety rule.
      expect(isTrustedForSafetyUse(a)).toBe(false);
    },
  );

  it.each(machineProvenances)('accepts %s output once a human confirms it', (provenance) => {
    const a = assertion({ provenance, confirmation: 'USER_CONFIRMED' });
    expect(isTrustedForSafetyUse(a)).toBe(true);
  });

  const humanConfirmations: ConfirmationState[] = [
    'USER_CONFIRMED',
    'USER_CORRECTED',
    'REVIEWER_CONFIRMED',
  ];

  it.each(humanConfirmations)('accepts human confirmation state %s', (confirmation) => {
    expect(isTrustedForSafetyUse(assertion({ confirmation }))).toBe(true);
  });

  it('accepts a deterministic barcode decode whose validator passed', () => {
    const a = assertion({
      fieldPath: 'identity.gtin',
      provenance: 'BARCODE_DECODE',
      confirmation: 'AUTO_VALIDATED',
      validation: { outcome: 'PASSED', validator: 'gtin.checkDigit', validatorVersion: '1' },
    });
    expect(isTrustedForSafetyUse(a)).toBe(true);
  });

  it('rejects a deterministic source whose validator never ran', () => {
    // Abstaining is correct when certainty is insufficient (spec 19).
    const outcomes: ValidationOutcome[] = ['NOT_RUN', 'NOT_APPLICABLE'];
    for (const outcome of outcomes) {
      const a = assertion({
        provenance: 'APPROVED_PROVIDER',
        confirmation: 'AUTO_VALIDATED',
        validation: { outcome, validator: 'x', validatorVersion: '1' },
      });
      expect(isTrustedForSafetyUse(a)).toBe(false);
    }
  });
});

describe('currentAssertion supersession (DEC-013: append-only, never mutated)', () => {
  it('returns undefined for an empty set', () => {
    expect(currentAssertion([])).toBeUndefined();
  });

  it('returns the sole assertion when nothing supersedes it', () => {
    const a = assertion({ id: unsafeId<FieldAssertionId>('a1') });
    expect(currentAssertion([a])?.id).toBe('a1');
  });

  it('returns the successor, not the superseded predecessor', () => {
    const first = assertion({
      id: unsafeId<FieldAssertionId>('a1'),
      normalizedValue: 'old',
      assertedAt: t('2026-08-01T00:00:00.000Z'),
    });
    const correction = assertion({
      id: unsafeId<FieldAssertionId>('a2'),
      normalizedValue: 'corrected',
      assertedAt: t('2026-08-02T00:00:00.000Z'),
      supersedesId: unsafeId<FieldAssertionId>('a1'),
    });

    const head = currentAssertion([first, correction]);
    expect(head?.id).toBe('a2');
    expect(head?.normalizedValue).toBe('corrected');
  });

  it('preserves the superseded assertion in the input set', () => {
    // Spec 09 requires replay to reproduce a past assessment, which is only possible if the
    // exact input version that assessment consumed remains retrievable.
    const first = assertion({ id: unsafeId<FieldAssertionId>('a1'), normalizedValue: 'old' });
    const correction = assertion({
      id: unsafeId<FieldAssertionId>('a2'),
      supersedesId: unsafeId<FieldAssertionId>('a1'),
      assertedAt: t('2026-08-02T00:00:00.000Z'),
    });
    const all = [first, correction];
    currentAssertion(all);
    expect(all).toHaveLength(2);
    expect(all.find((a) => a.id === 'a1')?.normalizedValue).toBe('old');
  });

  it('follows a multi-step correction chain to the final head', () => {
    const chain = [
      assertion({
        id: unsafeId<FieldAssertionId>('a1'),
        assertedAt: t('2026-08-01T00:00:00.000Z'),
      }),
      assertion({
        id: unsafeId<FieldAssertionId>('a2'),
        supersedesId: unsafeId<FieldAssertionId>('a1'),
        assertedAt: t('2026-08-02T00:00:00.000Z'),
      }),
      assertion({
        id: unsafeId<FieldAssertionId>('a3'),
        normalizedValue: 'final',
        supersedesId: unsafeId<FieldAssertionId>('a2'),
        assertedAt: t('2026-08-03T00:00:00.000Z'),
      }),
    ];
    expect(currentAssertion(chain)?.normalizedValue).toBe('final');
  });

  it('is order-independent', () => {
    const a1 = assertion({ id: unsafeId<FieldAssertionId>('a1') });
    const a2 = assertion({
      id: unsafeId<FieldAssertionId>('a2'),
      supersedesId: unsafeId<FieldAssertionId>('a1'),
      assertedAt: t('2026-08-02T00:00:00.000Z'),
    });
    expect(currentAssertion([a1, a2])?.id).toBe('a2');
    expect(currentAssertion([a2, a1])?.id).toBe('a2');
  });

  it('resolves concurrent heads deterministically by time then id', () => {
    // Two independent corrections of the same predecessor. The projection must be stable
    // across processes, otherwise replay is not reproducible.
    const base = assertion({ id: unsafeId<FieldAssertionId>('a1') });
    const branchA = assertion({
      id: unsafeId<FieldAssertionId>('aaa'),
      supersedesId: unsafeId<FieldAssertionId>('a1'),
      assertedAt: t('2026-08-05T00:00:00.000Z'),
    });
    const branchB = assertion({
      id: unsafeId<FieldAssertionId>('bbb'),
      supersedesId: unsafeId<FieldAssertionId>('a1'),
      assertedAt: t('2026-08-05T00:00:00.000Z'),
    });

    const forward = currentAssertion([base, branchA, branchB])?.id;
    const reversed = currentAssertion([base, branchB, branchA])?.id;
    expect(forward).toBe(reversed);
    expect(forward).toBe('bbb'); // equal timestamps, higher id wins
  });

  it('prefers the later assertion when timestamps differ', () => {
    const base = assertion({ id: unsafeId<FieldAssertionId>('a1') });
    const earlier = assertion({
      id: unsafeId<FieldAssertionId>('zzz'),
      supersedesId: unsafeId<FieldAssertionId>('a1'),
      assertedAt: t('2026-08-04T00:00:00.000Z'),
    });
    const later = assertion({
      id: unsafeId<FieldAssertionId>('aaa'),
      supersedesId: unsafeId<FieldAssertionId>('a1'),
      assertedAt: t('2026-08-06T00:00:00.000Z'),
    });
    expect(currentAssertion([base, earlier, later])?.id).toBe('aaa');
  });
});

describe('currentAssertionsByField', () => {
  it('resolves each field path independently', () => {
    const assertions: FieldAssertion[] = [
      assertion({
        id: unsafeId<FieldAssertionId>('i1'),
        fieldPath: 'identity.brand',
        normalizedValue: 'BrandA',
      }),
      assertion({
        id: unsafeId<FieldAssertionId>('i2'),
        fieldPath: 'identity.brand',
        normalizedValue: 'BrandB',
        supersedesId: unsafeId<FieldAssertionId>('i1'),
        assertedAt: t('2026-08-09T00:00:00.000Z'),
      }),
      assertion({
        id: unsafeId<FieldAssertionId>('b1'),
        fieldPath: 'batch.lot',
        normalizedValue: 'LOT9',
      }),
    ];

    const heads = currentAssertionsByField(assertions);
    expect(heads.size).toBe(2);
    expect(heads.get('identity.brand')?.normalizedValue).toBe('BrandB');
    expect(heads.get('batch.lot')?.normalizedValue).toBe('LOT9');
  });

  it('returns an empty map for no assertions', () => {
    expect(currentAssertionsByField([]).size).toBe(0);
  });
});

describe('compareExtractions (spec 17 dual-extraction requirement)', () => {
  it('reports agreement between identical values', () => {
    expect(compareExtractions('10mg', '10mg')).toBe('AGREE');
  });

  it('reports disagreement between different values', () => {
    expect(compareExtractions('10mg', '100mg')).toBe('DISAGREE');
  });

  it('reports a single source when only one mechanism produced a value', () => {
    expect(compareExtractions('10mg', null)).toBe('SINGLE_SOURCE');
    expect(compareExtractions(null, '10mg')).toBe('SINGLE_SOURCE');
  });

  it('reports mutual abstention', () => {
    expect(compareExtractions(null, null)).toBe('BOTH_ABSTAINED');
  });

  it('uses a caller-supplied normalizer for field-specific equivalence', () => {
    const foldStrength = (v: string) => v.toLowerCase().replace(/\s+/g, '');
    expect(compareExtractions('10 MG', '10mg', foldStrength)).toBe('AGREE');
  });

  it('treats reordered ingredient declarations as disagreement', () => {
    // INCI declarations are ordered by decreasing concentration, so order is material (spec 08).
    // A set-based comparison here would silently merge two genuinely different formulations.
    const a = ['aqua', 'glycerin', 'salicylic acid'];
    const b = ['aqua', 'salicylic acid', 'glycerin'];
    expect(compareExtractions(a, b, (v) => v.join('|'))).toBe('DISAGREE');
  });
});
