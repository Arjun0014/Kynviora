import { describe, it, expect } from 'vitest';
import {
  resolveFormulationObservation,
  diffIngredients,
  type ExistingFormulationSnapshot,
  type ObservedFormulationCandidate,
} from './conflict.js';
import { computeFingerprint, type PersonalCareFingerprintInput } from './fingerprint.js';
import { parseAndNormalize, aliasResolverFrom } from './ingredients.js';
import { instantFrom, marketCode } from '@kynviora/domain';

const resolver = aliasResolverFrom(
  new Map([
    ['aqua', [{ substanceId: 's-water', canonicalKey: 'WATER' }]],
    ['glycerin', [{ substanceId: 's-gly', canonicalKey: 'GLYCERIN' }]],
    ['salicylic acid', [{ substanceId: 's-sa', canonicalKey: 'SALICYLIC_ACID' }]],
    ['parfum', [{ substanceId: 's-parfum', canonicalKey: 'PARFUM' }]],
    ['niacinamide', [{ substanceId: 's-nia', canonicalKey: 'NIACINAMIDE' }]],
  ]),
);

const t = (iso: string) => instantFrom(iso);

function input(declaration: string): PersonalCareFingerprintInput {
  return {
    kind: 'PERSONAL_CARE',
    market: marketCode('IN'),
    manufacturerKey: 'acme-labs',
    productUseType: 'LEAVE_ON',
    ingredients: parseAndNormalize(declaration, resolver),
  };
}

function existing(
  declaration: string,
  overrides: Partial<ExistingFormulationSnapshot> = {},
): ExistingFormulationSnapshot {
  return {
    formulationId: 'formulation-1',
    fingerprint: computeFingerprint(input(declaration)),
    ingredients: parseAndNormalize(declaration, resolver),
    manufacturerKey: 'acme-labs',
    strengthText: null,
    dosageForm: null,
    firstObservedAt: t('2026-01-01T00:00:00.000Z'),
    lastObservedAt: t('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function candidate(
  declaration: string,
  overrides: Partial<ObservedFormulationCandidate> = {},
): ObservedFormulationCandidate {
  return {
    fingerprint: computeFingerprint(input(declaration)),
    ingredients: parseAndNormalize(declaration, resolver),
    manufacturerKey: 'acme-labs',
    strengthText: null,
    dosageForm: null,
    observedAt: t('2026-08-01T00:00:00.000Z'),
    extractionAgreed: true,
    humanConfirmed: true,
    ...overrides,
  };
}

describe('diffIngredients', () => {
  it('reports no changes for an identical declaration', () => {
    const a = parseAndNormalize('Aqua, Glycerin', resolver);
    const diff = diffIngredients(a, a);
    expect(diff.hasChanges).toBe(false);
    expect(diff.isMaterial).toBe(false);
    expect(diff.entries).toEqual([]);
  });

  it('detects an added ingredient', () => {
    const diff = diffIngredients(
      parseAndNormalize('Aqua, Glycerin', resolver),
      parseAndNormalize('Aqua, Glycerin, Parfum', resolver),
    );
    expect(diff.added).toEqual(['Parfum']);
    expect(diff.removed).toEqual([]);
    expect(diff.isMaterial).toBe(true);
  });

  it('detects a removed ingredient', () => {
    const diff = diffIngredients(
      parseAndNormalize('Aqua, Glycerin, Parfum', resolver),
      parseAndNormalize('Aqua, Glycerin', resolver),
    );
    expect(diff.removed).toEqual(['Parfum']);
    expect(diff.added).toEqual([]);
  });

  it('detects a reordering as a material change', () => {
    // INCI order encodes relative concentration, so moving an ingredient is a genuine
    // formulation difference, not a labelling tidy-up.
    const diff = diffIngredients(
      parseAndNormalize('Aqua, Glycerin, Salicylic Acid', resolver),
      parseAndNormalize('Aqua, Salicylic Acid, Glycerin', resolver),
    );
    expect([...diff.reordered].sort()).toEqual(['Glycerin', 'Salicylic Acid']);
    expect(diff.isMaterial).toBe(true);
  });

  it('detects a disclosed concentration change', () => {
    const diff = diffIngredients(
      parseAndNormalize('Salicylic Acid (1%)', resolver),
      parseAndNormalize('Salicylic Acid (2%)', resolver),
    );
    const entry = diff.entries.find((e) => e.changeKind === 'CONCENTRATION_CHANGED');
    expect(entry?.previousConcentrationPercent).toBe(1);
    expect(entry?.newConcentrationPercent).toBe(2);
  });

  it('makes no judgement about whether a change is good or bad', () => {
    // Spec 05 (Formula Change Watch) requires highlighting changes "without declaring the change
    // good or bad". The diff carries no severity, risk or safety field at all.
    const diff = diffIngredients(
      parseAndNormalize('Aqua', resolver),
      parseAndNormalize('Aqua, Salicylic Acid', resolver),
    );
    const keys = Object.keys(diff);
    for (const forbidden of ['severity', 'risk', 'safe', 'urgency', 'score']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('resolveFormulationObservation', () => {
  describe('scenario: unknown product (spec 31 fixture)', () => {
    it('creates a first candidate when nothing is known', () => {
      const decision = resolveFormulationObservation([], candidate('Aqua, Glycerin'));
      expect(decision.action).toBe('CREATE_FIRST_CANDIDATE');
      expect(decision.conflictKinds).toEqual([]);
      expect(decision.reasonCode).toBe('no_existing_formulation');
    });
  });

  describe('scenario: existing formulation reuse (spec 31 fixture)', () => {
    it('reuses the existing record when the fingerprint matches', () => {
      // The cache-hit path that makes the catalog economical: spec 03 group K requires database
      // hits to avoid unnecessary model/research calls.
      const decision = resolveFormulationObservation(
        [existing('Aqua, Glycerin, Salicylic Acid')],
        candidate('Aqua, Glycerin, Salicylic Acid'),
      );
      expect(decision.action).toBe('REUSE_EXISTING');
      expect(decision.reasonCode).toBe('fingerprint_match');
      expect(decision.conflictKinds).toEqual([]);
    });

    it('advances last-observed only on a genuine reuse', () => {
      const reuse = resolveFormulationObservation(
        [existing('Aqua, Glycerin')],
        candidate('Aqua, Glycerin'),
      );
      expect(reuse.advancesLastObserved).toBe(true);

      // A conflicting observation must not touch the existing record: doing so would make a
      // superseded formula look freshly confirmed.
      const conflict = resolveFormulationObservation(
        [existing('Aqua, Glycerin')],
        candidate('Aqua, Glycerin, Parfum'),
      );
      expect(conflict.advancesLastObserved).toBe(false);
    });

    it('reuses when the match is against any known formulation, not just the newest', () => {
      const older = existing('Aqua, Glycerin', {
        formulationId: 'f-old',
        lastObservedAt: t('2026-02-01T00:00:00.000Z'),
      });
      const newer = existing('Aqua, Glycerin, Parfum', {
        formulationId: 'f-new',
        lastObservedAt: t('2026-07-01T00:00:00.000Z'),
      });
      const decision = resolveFormulationObservation([older, newer], candidate('Aqua, Glycerin'));
      expect(decision.action).toBe('REUSE_EXISTING');
    });
  });

  describe('scenario: reformulation (spec 31 fixture)', () => {
    it('creates a conflict rather than overwriting when the formula changes', () => {
      // THE CORE GUARANTEE. Spec 24: "Same-barcode/different-formula creates conflict/new
      // formulation, not overwrite." Spec 08: "do not overwrite the old formulation."
      const previous = existing('Aqua, Glycerin, Salicylic Acid');
      const decision = resolveFormulationObservation(
        [previous],
        candidate('Aqua, Glycerin, Niacinamide'),
      );

      expect(decision.action).toBe('CREATE_CONFLICT');
      expect(decision.conflictKinds).toContain('INGREDIENT_DECLARATION_CHANGED');
      expect(decision.advancesLastObserved).toBe(false);
    });

    it('exposes a visible diff of what changed', () => {
      // Spec 06 Journey 5: "Evidence Diff shows what changed."
      const decision = resolveFormulationObservation(
        [existing('Aqua, Glycerin, Salicylic Acid')],
        candidate('Aqua, Glycerin, Niacinamide'),
      );
      expect(decision.ingredientDiff?.removed).toEqual(['Salicylic Acid']);
      expect(decision.ingredientDiff?.added).toEqual(['Niacinamide']);
    });

    it('leaves the existing snapshot untouched', () => {
      // The function is pure: it returns a decision and mutates nothing. There is no code path
      // here capable of overwriting a formulation.
      const previous = existing('Aqua, Glycerin, Salicylic Acid');
      const snapshot = structuredClone(previous);
      resolveFormulationObservation([previous], candidate('Aqua, Niacinamide'));
      expect(previous).toEqual(snapshot);
    });

    it('treats a pure reordering as a conflict, not a reuse', () => {
      const decision = resolveFormulationObservation(
        [existing('Aqua, Glycerin, Salicylic Acid')],
        candidate('Aqua, Salicylic Acid, Glycerin'),
      );
      expect(decision.action).toBe('CREATE_CONFLICT');
      expect(decision.conflictKinds).toContain('INGREDIENT_DECLARATION_CHANGED');
    });

    it('detects a strength change for medicines', () => {
      const decision = resolveFormulationObservation(
        [existing('Aqua', { strengthText: '500 mg' })],
        candidate('Aqua', { strengthText: '650 mg' }),
      );
      expect(decision.conflictKinds).toContain('STRENGTH_CHANGED');
      expect(decision.affectedFields).toContain('formulation.strength');
    });

    it('detects a dosage-form change', () => {
      const decision = resolveFormulationObservation(
        [existing('Aqua', { dosageForm: 'tablet' })],
        candidate('Aqua', { dosageForm: 'capsule' }),
      );
      expect(decision.conflictKinds).toContain('DOSAGE_FORM_CHANGED');
    });

    it('detects a manufacturer change', () => {
      const decision = resolveFormulationObservation(
        [existing('Aqua', { manufacturerKey: 'acme-labs' })],
        candidate('Aqua', { manufacturerKey: 'other-labs' }),
      );
      expect(decision.conflictKinds).toContain('MANUFACTURER_CHANGED');
    });

    it('ignores cosmetic whitespace and casing differences in scalar fields', () => {
      const decision = resolveFormulationObservation(
        [existing('Aqua, Glycerin', { dosageForm: 'Tablet' })],
        candidate('Aqua, Glycerin', { dosageForm: '  tablet  ' }),
      );
      // Fingerprints match on the declaration, so this is a reuse - the scalar normalization
      // prevents a spurious conflict from a formatting difference.
      expect(decision.action).toBe('REUSE_EXISTING');
    });
  });

  describe('extraction disagreement (spec 17)', () => {
    it('requires reverification when extractions disagree and no human confirmed', () => {
      // Spec 17: disagreement must trigger re-extraction or user confirmation, not "model
      // arbitration by confidence alone".
      const decision = resolveFormulationObservation(
        [existing('Aqua, Glycerin')],
        candidate('Aqua, Glycerin', { extractionAgreed: false, humanConfirmed: false }),
      );
      expect(decision.action).toBe('REQUIRE_REVERIFICATION');
      expect(decision.conflictKinds).toEqual(['EXTRACTION_DISAGREEMENT']);
    });

    it('checks disagreement before any comparison, even on an exact fingerprint match', () => {
      // Comparing an unreliable reading against the catalog could produce a false reuse, which
      // is the more dangerous direction: it would silently attach a user to the wrong formula.
      const decision = resolveFormulationObservation(
        [existing('Aqua, Glycerin')],
        candidate('Aqua, Glycerin', { extractionAgreed: false, humanConfirmed: false }),
      );
      expect(decision.action).not.toBe('REUSE_EXISTING');
    });

    it('proceeds when a human confirmed the fields despite extractor disagreement', () => {
      const decision = resolveFormulationObservation(
        [existing('Aqua, Glycerin')],
        candidate('Aqua, Glycerin', { extractionAgreed: false, humanConfirmed: true }),
      );
      expect(decision.action).toBe('REUSE_EXISTING');
    });

    it('requires reverification even with no existing formulation', () => {
      const decision = resolveFormulationObservation(
        [],
        candidate('Aqua', { extractionAgreed: false, humanConfirmed: false }),
      );
      expect(decision.action).toBe('REQUIRE_REVERIFICATION');
    });
  });

  describe('fingerprint algorithm version changes', () => {
    it('requires reverification rather than manufacturing a conflict for every product', () => {
      // When the algorithm is revised, every stored hash differs from a freshly computed one.
      // Treating that as a formulation change would flood the review queue with false conflicts.
      const stale = existing('Aqua, Glycerin');
      const staleV0: ExistingFormulationSnapshot = {
        ...stale,
        fingerprint: { ...stale.fingerprint, version: 'fp-0' },
      };
      const decision = resolveFormulationObservation([staleV0], candidate('Aqua, Glycerin'));
      expect(decision.action).toBe('REQUIRE_REVERIFICATION');
      expect(decision.reasonCode).toBe('fingerprint_version_mismatch');
    });

    it('still compares when at least one existing record shares the current version', () => {
      const stale = existing('Aqua, Glycerin', { formulationId: 'f-stale' });
      const staleV0: ExistingFormulationSnapshot = {
        ...stale,
        fingerprint: { ...stale.fingerprint, version: 'fp-0' },
      };
      const current = existing('Aqua, Glycerin', { formulationId: 'f-current' });
      const decision = resolveFormulationObservation(
        [staleV0, current],
        candidate('Aqua, Glycerin'),
      );
      expect(decision.action).toBe('REUSE_EXISTING');
    });
  });

  describe('degraded fingerprint cross-check (regression)', () => {
    it('does not reuse when the fingerprint matches but a scalar field differs', () => {
      // Regression for a real false-merge risk: when structured strength could not be extracted,
      // the fingerprint is degraded and two packs of different strengths can produce the same
      // hash. Spec 08: "A result missing material strength/form information is not an exact
      // medicine match." A blind reuse here would silently attach a user to the wrong formula.
      const decision = resolveFormulationObservation(
        [existing('Aqua', { strengthText: '500 mg' })],
        candidate('Aqua', { strengthText: '650 mg' }),
      );
      expect(decision.action).toBe('CREATE_CONFLICT');
      expect(decision.conflictKinds).toContain('STRENGTH_CHANGED');
      expect(decision.reasonCode).toBe('fingerprint_match_but_scalar_fields_differ');
      expect(decision.advancesLastObserved).toBe(false);
    });

    it('reuses when the fingerprint matches and all scalar fields agree', () => {
      const decision = resolveFormulationObservation(
        [existing('Aqua', { strengthText: '500 mg', dosageForm: 'tablet' })],
        candidate('Aqua', { strengthText: '500 mg', dosageForm: 'tablet' }),
      );
      expect(decision.action).toBe('REUSE_EXISTING');
    });
  });

  describe('defensive behaviour', () => {
    it('flags a fingerprint difference it cannot attribute to a named field', () => {
      // Fingerprints differ, so something material differs by construction. Silently reusing
      // here would be exactly the overwrite the spec forbids, so it becomes a review item.
      const previous = existing('Aqua, Glycerin');
      const differentUseType: ObservedFormulationCandidate = {
        ...candidate('Aqua, Glycerin'),
        fingerprint: computeFingerprint({
          ...input('Aqua, Glycerin'),
          productUseType: 'RINSE_OFF',
        }),
      };
      const decision = resolveFormulationObservation([previous], differentUseType);
      expect(decision.action).toBe('CREATE_CONFLICT');
      expect(decision.reasonCode).toBe('fingerprint_differs_without_identified_field');
    });

    it('never returns an action that implies overwriting', () => {
      // There is deliberately no OVERWRITE or REPLACE action in the vocabulary.
      const decision = resolveFormulationObservation([existing('Aqua')], candidate('Aqua, Parfum'));
      expect([
        'REUSE_EXISTING',
        'CREATE_FIRST_CANDIDATE',
        'CREATE_CONFLICT',
        'REQUIRE_REVERIFICATION',
      ]).toContain(decision.action);
    });
  });
});
