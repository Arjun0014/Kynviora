import { describe, it, expect } from 'vitest';
import {
  buildTrustPassport,
  buildCoverageSummary,
  primaryTrustAction,
  type TrustPassportInput,
} from './trustPassport.js';
import { instantFrom, marketCode } from '@kynviora/domain';

const NOW = instantFrom('2026-08-29T00:00:00.000Z');

/** A fully verified item, as the baseline to degrade from. */
function input(overrides: Partial<TrustPassportInput> = {}): TrustPassportInput {
  return {
    identityVerification: 'CONFIRMED',
    formulationVerification: 'CONFIRMED',
    batchVerification: 'CONFIRMED',
    catalogCorroboration: 'CORROBORATED',
    hasFrontPanelEvidence: true,
    hasIngredientPanelEvidence: true,
    hasBatchRecorded: true,
    identityFromBarcodeOnly: false,
    hasUnconfirmedFields: false,
    hasOpenConflict: false,
    batchApplicable: true,
    market: marketCode('IN'),
    formulationVersion: 'v1',
    firstObservedAt: NOW,
    lastObservedAt: NOW,
    lastReviewedAt: NOW,
    lastSafetyCheckedAt: NOW,
    monitoredJurisdictions: ['IN', 'EU'],
    unmonitoredJurisdictions: ['JP'],
    hasStaleSource: false,
    ...overrides,
  };
}

describe('no aggregate score (spec 08, 23 D-005)', () => {
  it('exposes no overall trust, score or grade field', () => {
    // Spec 08: "Do not turn these into one universal safety score." The absence is the design.
    const passport = buildTrustPassport(input());
    const keys = Object.keys(passport);
    for (const forbidden of [
      'overallTrust',
      'score',
      'trustScore',
      'grade',
      'rating',
      'percentage',
      'confidence',
      'safety',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('reports the three facets independently', () => {
    const passport = buildTrustPassport(input());
    expect(passport.identity.verification).toBe('CONFIRMED');
    expect(passport.formulation.verification).toBe('CONFIRMED');
    expect(passport.batch.verification).toBe('CONFIRMED');
  });

  it('keeps catalog corroboration separate from this user own verification', () => {
    // Spec 08 layer separation: what the shared catalog knows is not the same as what this
    // user's own package evidence establishes.
    const passport = buildTrustPassport(
      input({ catalogCorroboration: 'CANDIDATE', formulationVerification: 'CONFIRMED' }),
    );
    expect(passport.catalogCorroboration).toBe('CANDIDATE');
    expect(passport.formulation.verification).toBe('CONFIRMED');
  });
});

describe('identity and formulation stay distinct (spec 02 pillar 1, spec 08)', () => {
  it('can have confirmed identity with unverified formula', () => {
    // The exact state spec 05.5 names: "identity found, formula not verified".
    const passport = buildTrustPassport(
      input({
        identityVerification: 'CONFIRMED',
        formulationVerification: 'UNVERIFIED',
        hasIngredientPanelEvidence: false,
      }),
    );
    expect(passport.identity.verification).toBe('CONFIRMED');
    expect(passport.formulation.verification).toBe('UNVERIFIED');
    expect(passport.formulation.userAction).toBe('CAPTURE_INGREDIENT_PANEL');
  });

  it('reports a barcode-only match as identity evidence, not formula evidence', () => {
    // Spec 08: a barcode never proves the formulation.
    const passport = buildTrustPassport(
      input({
        identityVerification: 'PROBABLE',
        identityFromBarcodeOnly: true,
        hasFrontPanelEvidence: false,
        formulationVerification: 'UNVERIFIED',
        hasIngredientPanelEvidence: false,
      }),
    );
    expect(passport.identity.reasonCode).toBe('MATCHED_BY_BARCODE_ONLY');
    expect(passport.formulation.verification).toBe('UNVERIFIED');
  });

  it('lets two items of the same brand differ', () => {
    // Spec 04 Phase 2.4 exit criterion: a user can tell why two items with the same brand have
    // different trust states.
    const captured = buildTrustPassport(input());
    const barcodeOnly = buildTrustPassport(
      input({
        identityVerification: 'PROBABLE',
        identityFromBarcodeOnly: true,
        hasFrontPanelEvidence: false,
        formulationVerification: 'UNVERIFIED',
        hasIngredientPanelEvidence: false,
        batchVerification: 'UNVERIFIED',
        hasBatchRecorded: false,
      }),
    );

    expect(captured.identity.reasonCode).not.toBe(barcodeOnly.identity.reasonCode);
    expect(captured.formulation.verification).not.toBe(barcodeOnly.formulation.verification);
  });
});

describe('unverified stays actionable, not a dead end (spec 04 Phase 2.4)', () => {
  it('suggests capturing the front panel when identity is uncaptured', () => {
    const passport = buildTrustPassport(
      input({ identityVerification: 'UNVERIFIED', hasFrontPanelEvidence: false }),
    );
    expect(passport.identity.reasonCode).toBe('NOT_CAPTURED');
    expect(passport.identity.userAction).toBe('CAPTURE_FRONT_PANEL');
  });

  it('suggests confirming fields when extraction is unconfirmed', () => {
    const passport = buildTrustPassport(
      input({ formulationVerification: 'PARTIAL', hasUnconfirmedFields: true }),
    );
    expect(passport.formulation.reasonCode).toBe('EXTRACTION_UNCONFIRMED');
    expect(passport.formulation.userAction).toBe('CONFIRM_EXTRACTED_FIELDS');
  });

  it('gives every non-confirmed facet a reason', () => {
    const passport = buildTrustPassport(
      input({
        identityVerification: 'UNVERIFIED',
        formulationVerification: 'UNVERIFIED',
        batchVerification: 'UNVERIFIED',
        hasFrontPanelEvidence: false,
        hasIngredientPanelEvidence: false,
        hasBatchRecorded: false,
      }),
    );
    for (const facet of [passport.identity, passport.formulation, passport.batch]) {
      expect(facet.reasonCode).toBeTruthy();
      expect(facet.userAction).toBeTruthy();
    }
  });

  it('offers no action for a confirmed facet', () => {
    const passport = buildTrustPassport(input());
    expect(passport.identity.userAction).toBeNull();
    expect(passport.formulation.userAction).toBeNull();
    expect(passport.batch.userAction).toBeNull();
  });

  it('does not nag for a batch that does not exist', () => {
    // Prompting for something not printed on the pack would be a dead end of a different kind.
    const passport = buildTrustPassport(
      input({ batchApplicable: false, hasBatchRecorded: false, batchVerification: 'UNVERIFIED' }),
    );
    expect(passport.batch.reasonCode).toBe('NOT_APPLICABLE');
    expect(passport.batch.userAction).toBeNull();
  });
});

describe('conflict handling', () => {
  it('reports formulation as conflicting when a conflict is open', () => {
    const passport = buildTrustPassport(input({ hasOpenConflict: true }));
    expect(passport.formulation.verification).toBe('CONFLICTING');
    expect(passport.formulation.reasonCode).toBe('RECORDS_DISAGREE');
    expect(passport.formulation.userAction).toBe('RESCAN_CURRENT_LABEL');
  });

  it('does not silently show a confirmed formula while a conflict is open', () => {
    // Spec 05.5: "The app does not silently reuse an old formula when the user's current label
    // conflicts or is uncertain."
    const passport = buildTrustPassport(
      input({ formulationVerification: 'CONFIRMED', hasOpenConflict: true }),
    );
    expect(passport.formulation.verification).not.toBe('CONFIRMED');
  });
});

describe('coverage statement (spec 09)', () => {
  it('names what is monitored and what is not', () => {
    const coverage = buildCoverageSummary(input());
    expect(coverage.statement).toContain('IN');
    expect(coverage.statement).toContain('EU');
    expect(coverage.statement).toMatch(/does not currently monitor.*JP/);
  });

  it('always states that finding nothing is not a guarantee', () => {
    // A coverage line listing only what is monitored invites reading silence as reassurance.
    const coverage = buildCoverageSummary(input());
    expect(coverage.statement).toMatch(/not a guarantee that a product is safe/i);
  });

  it('is explicit when nothing is monitored', () => {
    const coverage = buildCoverageSummary(
      input({ monitoredJurisdictions: [], unmonitoredJurisdictions: ['IN', 'EU'] }),
    );
    expect(coverage.statement).toMatch(/not currently monitoring/i);
  });

  it('warns when a source is stale', () => {
    const coverage = buildCoverageSummary(input({ hasStaleSource: true }));
    expect(coverage.statement).toMatch(/not been checked recently/i);
    expect(coverage.hasStaleSource).toBe(true);
  });

  it('omits the stale warning when every source is fresh', () => {
    expect(buildCoverageSummary(input()).statement).not.toMatch(/not been checked recently/i);
  });
});

describe('primaryTrustAction (spec 18: one clear primary action)', () => {
  it('returns null when nothing needs doing', () => {
    expect(primaryTrustAction(buildTrustPassport(input()))).toBeNull();
  });

  it('prioritises resolving a conflict above everything else', () => {
    // A conflict invalidates the other facets, so resolving it first unblocks the most.
    const passport = buildTrustPassport(
      input({
        hasOpenConflict: true,
        identityVerification: 'CONFLICTING',
        hasBatchRecorded: false,
        batchVerification: 'UNVERIFIED',
      }),
    );
    expect(primaryTrustAction(passport)).toBe('RESOLVE_CONFLICT');
  });

  it('prefers confirming what is captured over capturing more', () => {
    // Cheaper for the user, and it may resolve the facet outright.
    const passport = buildTrustPassport(
      input({
        formulationVerification: 'PARTIAL',
        hasUnconfirmedFields: true,
        hasBatchRecorded: false,
        batchVerification: 'UNVERIFIED',
      }),
    );
    expect(primaryTrustAction(passport)).toBe('CONFIRM_EXTRACTED_FIELDS');
  });

  it('suggests the ingredient panel before the batch', () => {
    const passport = buildTrustPassport(
      input({
        formulationVerification: 'UNVERIFIED',
        hasIngredientPanelEvidence: false,
        batchVerification: 'UNVERIFIED',
        hasBatchRecorded: false,
      }),
    );
    expect(primaryTrustAction(passport)).toBe('CAPTURE_INGREDIENT_PANEL');
  });

  it('does not hide the other facets behind the primary action', () => {
    // The suggestion is a presentation convenience, not a ranking that suppresses information.
    const passport = buildTrustPassport(
      input({
        formulationVerification: 'UNVERIFIED',
        hasIngredientPanelEvidence: false,
        batchVerification: 'UNVERIFIED',
        hasBatchRecorded: false,
      }),
    );
    expect(primaryTrustAction(passport)).toBe('CAPTURE_INGREDIENT_PANEL');
    // Both facets remain individually visible with their own actions.
    expect(passport.formulation.userAction).toBe('CAPTURE_INGREDIENT_PANEL');
    expect(passport.batch.userAction).toBe('ENTER_BATCH_AND_EXPIRY');
  });
});

describe('determinism', () => {
  it('produces the same passport for the same input', () => {
    // A support conversation must be able to reproduce exactly what a user was shown.
    expect(buildTrustPassport(input())).toEqual(buildTrustPassport(input()));
  });

  it('carries the observation timestamps through', () => {
    const passport = buildTrustPassport(input());
    expect(passport.firstObservedAt).toBe(NOW);
    expect(passport.lastSafetyCheckedAt).toBe(NOW);
    expect(passport.formulationVersion).toBe('v1');
    expect(passport.market).toBe('IN');
  });

  it('represents never-checked as null rather than a fabricated date', () => {
    const passport = buildTrustPassport(input({ lastSafetyCheckedAt: null, lastReviewedAt: null }));
    expect(passport.lastSafetyCheckedAt).toBeNull();
    expect(passport.lastReviewedAt).toBeNull();
  });
});
