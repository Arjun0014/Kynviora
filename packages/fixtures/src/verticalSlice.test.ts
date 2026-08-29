/**
 * End-to-end vertical slice.
 *
 * Operating brief section 47: prove the architecture with one complete slice -
 *   profile -> capture -> observation -> formulation resolution -> normalized ingredients
 *   -> evidence/regulatory lookup -> structured assessment -> user-facing result
 *
 * This file also implements the fixture scenarios required by operating brief section 31:
 *   1. Unknown personal-care product
 *   2. Existing formulation (cheap reuse)
 *   3. Reformulation (new version, never an overwrite)
 *   4. Regulatory difference between jurisdictions
 *   5. Concentration limitation (restriction exists, compliance undeterminable)
 *   6. Product/batch recall (only matching batches affected)
 *   7. Evidence correction (recompute, history auditable)
 *
 * Everything here runs against synthetic data. Regulatory records are promoted to a publishable
 * state only through the explicitly-named test helpers, so nothing in the shipped fixture set is
 * ever in an approved state (DEC-016).
 */

import { describe, it, expect } from 'vitest';
import {
  parseGtin,
  parseAndNormalize,
  computeFingerprint,
  resolveFormulationObservation,
  assessCorroboration,
  diffIngredients,
  type ExistingFormulationSnapshot,
  type ObservedFormulationCandidate,
  type PersonalCareFingerprintInput,
  type NormalizedIngredient,
} from '@kynviora/catalog';
import {
  projectLens,
  evaluateCitationGate,
  type LensInput,
  type SourceRegistryEntry,
} from '@kynviora/regulatory';
import {
  evaluateRule,
  replayAssessment,
  type AssessmentInputs,
  type AssessmentRuleVersion,
  type OwnedItemSnapshot,
} from '@kynviora/safety';
import { instantFrom, unwrap, isOk, JURISDICTIONS } from '@kynviora/domain';
import {
  FIXTURE_ALIAS_RESOLVER,
  MARKET_IN,
  PRODUCT_CLARIFYING_SERUM,
  PRODUCT_GENTLE_SHAMPOO,
  DECLARATION_SERUM_V1,
  DECLARATION_SERUM_V2,
  DECLARATION_SERUM_WITH_CONCENTRATION,
  DECLARATION_SHAMPOO,
  PROFILE_PRIYA,
  FACT_PRIYA_SALICYLATE_SENSITIVITY,
  BATCH_AFFECTED,
  BATCH_UNAFFECTED,
  SUBSTANCES,
} from './catalog.js';
import {
  ALL_FIXTURE_SOURCES,
  RULE_EU_SALICYLIC_ACID,
  RULE_GB_SALICYLIC_ACID,
  RULE_NI_SALICYLIC_ACID,
  SUBSTANCE_SALICYLIC_ACID,
  ACTION_IN_SYNTHETIC_RECALL,
  DOC_EU_ANNEX_III,
  SOURCE_EU_EURLEX,
  asPublishedForTest,
  asApprovedSourceForTest,
  withChecksumForTest,
} from './regulatory.js';

const T0 = instantFrom('2026-08-01T00:00:00.000Z');
const T1 = instantFrom('2026-08-15T00:00:00.000Z');
const T2 = instantFrom('2026-08-29T00:00:00.000Z');
const REVIEWER = 'synthetic-test-reviewer';

const PUBLISHED_SOURCES: ReadonlyMap<string, SourceRegistryEntry> = new Map(
  ALL_FIXTURE_SOURCES.map((s) => [s.id, asApprovedSourceForTest(s)]),
);

const PUBLISHED_RULES = [
  asPublishedForTest(RULE_EU_SALICYLIC_ACID),
  asPublishedForTest(RULE_GB_SALICYLIC_ACID),
  asPublishedForTest(RULE_NI_SALICYLIC_ACID),
];

/** Build the fingerprint input for a personal-care package observation. */
function serumInput(declaration: string): PersonalCareFingerprintInput {
  return {
    kind: 'PERSONAL_CARE',
    market: MARKET_IN,
    manufacturerKey: PRODUCT_CLARIFYING_SERUM.manufacturerKey,
    productUseType: PRODUCT_CLARIFYING_SERUM.productUseType,
    ingredients: parseAndNormalize(declaration, FIXTURE_ALIAS_RESOLVER),
  };
}

function snapshotOf(
  declaration: string,
  formulationId: string,
  observedAt = T0,
): ExistingFormulationSnapshot {
  return {
    formulationId,
    fingerprint: computeFingerprint(serumInput(declaration)),
    ingredients: parseAndNormalize(declaration, FIXTURE_ALIAS_RESOLVER),
    manufacturerKey: PRODUCT_CLARIFYING_SERUM.manufacturerKey,
    strengthText: null,
    dosageForm: null,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
  };
}

function candidateOf(declaration: string, observedAt = T1): ObservedFormulationCandidate {
  return {
    fingerprint: computeFingerprint(serumInput(declaration)),
    ingredients: parseAndNormalize(declaration, FIXTURE_ALIAS_RESOLVER),
    manufacturerKey: PRODUCT_CLARIFYING_SERUM.manufacturerKey,
    strengthText: null,
    dosageForm: null,
    observedAt,
    extractionAgreed: true,
    humanConfirmed: true,
  };
}

// ===========================================================================
// SCENARIO 1 - Unknown personal-care product
// ===========================================================================

describe('Scenario 1: an unknown personal-care product enters the Living Catalog', () => {
  it('validates the barcode before anything else', () => {
    const result = parseGtin(PRODUCT_CLARIFYING_SERUM.gtin);
    expect(isOk(result)).toBe(true);
    expect(unwrap(result).symbology).toBe('EAN-13');
  });

  it('refuses to create a record from an invalid scan', () => {
    // Spec 04 Phase 3.1: "Invalid scans cannot create trusted item records."
    const bad = parseGtin('08901234567891');
    expect(isOk(bad)).toBe(false);
  });

  it('extracts an ordered ingredient declaration and normalizes what it can', () => {
    const ingredients = parseAndNormalize(DECLARATION_SERUM_V1, FIXTURE_ALIAS_RESOLVER);

    expect(ingredients.map((i) => i.rawTerm)).toEqual([
      'Aqua',
      'Glycerin',
      'Salicylic Acid',
      'Niacinamide',
      'Citric Acid',
      'Parfum',
    ]);
    expect(ingredients.every((i) => i.mappingState === 'EXACT')).toBe(true);
    // Concentration is not disclosed - the normal case, and the one the Lens must handle.
    expect(ingredients.every((i) => i.disclosedConcentrationPercent === null)).toBe(true);
  });

  it('creates a first candidate when the catalog has never seen this formulation', () => {
    const decision = resolveFormulationObservation([], candidateOf(DECLARATION_SERUM_V1));
    expect(decision.action).toBe('CREATE_FIRST_CANDIDATE');
  });

  it('starts the new formulation at USER_CONFIRMED, not CORROBORATED', () => {
    // One person's confirmation is not independent corroboration (spec 08).
    const corroboration = assessCorroboration([
      {
        observationId: 'obs-1',
        contributionGroupHash: 'group-priya',
        assetSha256: 'sha-1',
        assetPerceptualHash: 'phash-1',
        observedAt: T0,
        market: 'IN',
        humanConfirmed: true,
      },
    ]);
    expect(corroboration.state).toBe('USER_CONFIRMED');
    expect(corroboration.independentGroupCount).toBe(1);
  });
});

// ===========================================================================
// SCENARIO 2 - Existing formulation reuse
// ===========================================================================

describe('Scenario 2: the same formulation is recognised without new research', () => {
  it('reuses the existing catalog record on an exact fingerprint match', () => {
    // Spec 03 group K: "database hits avoid unnecessary model/research calls".
    const existing = [snapshotOf(DECLARATION_SERUM_V1, 'form-v1')];
    const decision = resolveFormulationObservation(existing, candidateOf(DECLARATION_SERUM_V1));

    expect(decision.action).toBe('REUSE_EXISTING');
    expect(decision.reasonCode).toBe('fingerprint_match');
    expect(decision.advancesLastObserved).toBe(true);
  });

  it('reaches CORROBORATED once three independent groups have confirmed it', () => {
    const observations = ['priya', 'arjun', 'meera'].map((who, i) => ({
      observationId: `obs-${who}`,
      contributionGroupHash: `group-${who}`,
      assetSha256: `sha-${i}`,
      assetPerceptualHash: `phash-${i}`,
      observedAt: instantFrom(`2026-08-0${i + 1}T00:00:00.000Z`),
      market: 'IN',
      humanConfirmed: true,
    }));

    const corroboration = assessCorroboration(observations);
    expect(corroboration.state).toBe('CORROBORATED');
    expect(corroboration.independentGroupCount).toBe(3);
  });

  it('does not let one person reach CORROBORATED by resubmitting', () => {
    // Threat A11. Same contributor group and same image, three times.
    const observations = [0, 1, 2].map((i) => ({
      observationId: `obs-${i}`,
      contributionGroupHash: 'group-priya',
      assetSha256: 'identical-file',
      assetPerceptualHash: 'identical-image',
      observedAt: instantFrom(`2026-08-0${i + 1}T00:00:00.000Z`),
      market: 'IN',
      humanConfirmed: true,
    }));

    const corroboration = assessCorroboration(observations);
    expect(corroboration.state).toBe('USER_CONFIRMED');
    expect(corroboration.rejectedDuplicateCount).toBe(2);
  });
});

// ===========================================================================
// SCENARIO 3 - Reformulation
// ===========================================================================

describe('Scenario 3: a reformulation creates a new version and never overwrites', () => {
  const existing = [snapshotOf(DECLARATION_SERUM_V1, 'form-v1')];
  const reformulated = candidateOf(DECLARATION_SERUM_V2);

  it('detects the change as a conflict rather than a reuse', () => {
    const decision = resolveFormulationObservation(existing, reformulated);
    expect(decision.action).toBe('CREATE_CONFLICT');
    expect(decision.conflictKinds).toContain('INGREDIENT_DECLARATION_CHANGED');
  });

  it('does not advance the previous formulation last-observed timestamp', () => {
    // A superseded formula must not look freshly confirmed.
    const decision = resolveFormulationObservation(existing, reformulated);
    expect(decision.advancesLastObserved).toBe(false);
  });

  it('leaves the previous formulation completely untouched', () => {
    const before = structuredClone(existing);
    resolveFormulationObservation(existing, reformulated);
    expect(existing).toEqual(before);
  });

  it('shows exactly what changed, without judging the change', () => {
    // Spec 05 Formula Change Watch: highlight the difference without calling it good or bad.
    const decision = resolveFormulationObservation(existing, reformulated);
    expect(decision.ingredientDiff?.removed).toContain('Salicylic Acid');
    expect(decision.ingredientDiff?.reordered).toContain('Niacinamide');
  });

  it('keeps both formulations resolvable under one product identity', () => {
    // Spec 05.3: "Two label versions can coexist under one commercial product identity."
    const both = [
      snapshotOf(DECLARATION_SERUM_V1, 'form-v1', T0),
      snapshotOf(DECLARATION_SERUM_V2, 'form-v2', T1),
    ];

    expect(resolveFormulationObservation(both, candidateOf(DECLARATION_SERUM_V1)).action).toBe(
      'REUSE_EXISTING',
    );
    expect(resolveFormulationObservation(both, candidateOf(DECLARATION_SERUM_V2)).action).toBe(
      'REUSE_EXISTING',
    );
  });
});

// ===========================================================================
// SCENARIO 4 - Regulatory difference between jurisdictions
// ===========================================================================

describe('Scenario 4: the Lens shows genuinely different jurisdictional treatment', () => {
  function lensFor(ingredients: readonly NormalizedIngredient[], useType: 'LEAVE_ON' | 'RINSE_OFF'): LensInput {
    const salicylic = ingredients.find(
      (i) => i.canonicalKey === SUBSTANCES.SALICYLIC_ACID.canonicalKey,
    );
    return {
      context: {
        substanceCanonicalKey: SUBSTANCE_SALICYLIC_ACID,
        disclosedConcentrationPercent: salicylic?.disclosedConcentrationPercent ?? null,
        productUseType: useType,
        productCategory: 'face serum',
        intendedForAgeYears: null,
        substancePresent: salicylic !== undefined,
      },
      jurisdictions: [...JURISDICTIONS],
      rules: PUBLISHED_RULES,
      opinions: [],
      actions: [],
      sources: PUBLISHED_SOURCES,
      generatedAt: T2,
    };
  }

  const snapshot = projectLens(
    lensFor(parseAndNormalize(DECLARATION_SERUM_V1, FIXTURE_ALIAS_RESOLVER), 'LEAVE_ON'),
  );
  const entry = (j: string) => snapshot.entries.find((e) => e.jurisdiction === j)!;

  it('reports a restriction in the EU and no matched rule in the US', () => {
    // The headline demonstration: the same ingredient, two materially different answers.
    expect(entry('EU').statuses).toContain('RESTRICTED');
    expect(entry('US').statuses).toContain('NO_MATCHED_RULE_WITHIN_COVERAGE');
  });

  it('never renders the EU restriction as a prohibition', () => {
    expect(entry('EU').statuses).not.toContain('PROHIBITED');
    expect(entry('EU').limitations.join(' ')).toMatch(/permitted under conditions/i);
  });

  it('never renders the US absence as approval', () => {
    const text = entry('US').limitations.join(' ');
    expect(text).toMatch(/not regulatory approval/i);
    expect(text).toMatch(/not FDA approval/i);
  });

  it('answers GB and NI separately, with different effective dates', () => {
    expect(entry('GB').effectiveDate).not.toBe(entry('NI').effectiveDate);
    expect(entry('GB').legalInstrument).toContain('Great Britain');
    expect(entry('NI').legalInstrument).toContain('Northern Ireland');
  });

  it('cites the exact legal reference for the EU entry', () => {
    expect(entry('EU').legalInstrument).toBe('Regulation (EC) No 1223/2009');
    expect(entry('EU').legalReference).toBe('Annex III, entry 98');
    expect(entry('EU').lastVerifiedAt).toBeTruthy();
  });

  it('carries no urgency or severity anywhere in the Lens', () => {
    // Spec 07.2: a foreign status must never set personalized alert urgency.
    for (const e of snapshot.entries) {
      expect(Object.keys(e)).not.toContain('urgency');
      expect(Object.keys(e)).not.toContain('severity');
    }
  });

  it('scopes a rinse-off product differently from a leave-on one', () => {
    const shampooIngredients = parseAndNormalize(DECLARATION_SHAMPOO, FIXTURE_ALIAS_RESOLVER);
    const rinseOff = projectLens(lensFor(shampooIngredients, 'RINSE_OFF'));
    const euEntry = rinseOff.entries.find((e) => e.jurisdiction === 'EU')!;
    // The rule covers both use types, so it still applies - but the use type is recorded and
    // carried, which is what lets the 3.0% vs 2.0% distinction be surfaced.
    expect(euEntry.statuses).toContain('USE_CONDITION');
    expect(euEntry.conditions?.productCategories).toContain('rinse-off hair products (3.0%)');
  });
});

// ===========================================================================
// SCENARIO 5 - Concentration limitation
// ===========================================================================

describe('Scenario 5: a concentration limit with an undisclosed concentration', () => {
  function lensWith(declaration: string) {
    const ingredients = parseAndNormalize(declaration, FIXTURE_ALIAS_RESOLVER);
    const salicylic = ingredients.find(
      (i) => i.canonicalKey === SUBSTANCES.SALICYLIC_ACID.canonicalKey,
    );
    return projectLens({
      context: {
        substanceCanonicalKey: SUBSTANCE_SALICYLIC_ACID,
        disclosedConcentrationPercent: salicylic?.disclosedConcentrationPercent ?? null,
        productUseType: 'LEAVE_ON',
        productCategory: 'face serum',
        intendedForAgeYears: null,
        substancePresent: salicylic !== undefined,
      },
      jurisdictions: ['EU'],
      rules: PUBLISHED_RULES,
      opinions: [],
      actions: [],
      sources: PUBLISHED_SOURCES,
      generatedAt: T2,
    });
  }

  it('reports CONDITION_UNKNOWN when the package does not disclose a concentration', () => {
    const eu = lensWith(DECLARATION_SERUM_V1).entries[0]!;
    expect(eu.applicability).toBe('CONDITION_UNKNOWN');
  });

  it('states that a restriction exists AND that compliance cannot be determined', () => {
    // The exact output the MVP demo requires - never a violation claim.
    const text = lensWith(DECLARATION_SERUM_V1).entries[0]!.limitations.join(' ');
    expect(text).toMatch(/maximum concentration of 2%/i);
    expect(text).toMatch(/does not disclose the concentration/i);
    expect(text).toMatch(/cannot determine whether that limit is exceeded/i);
  });

  it('names the age condition, not the concentration, once the concentration is printed', () => {
    const eu = lensWith(DECLARATION_SERUM_WITH_CONCENTRATION).entries[0]!;
    // Still CONDITION_UNKNOWN, but now for a different and correctly-named reason: the EU rule
    // also carries an age condition, and the package does not say who it is intended for.
    expect(eu.applicability).toBe('CONDITION_UNKNOWN');
    expect(eu.unresolvedConditions).toContain('INTENDED_AGE');
    expect(eu.unresolvedConditions).not.toContain('CONCENTRATION');
    // The copy must NOT claim the concentration is undisclosed - it is printed on this package.
    expect(eu.limitations.join(' ')).not.toMatch(/does not disclose the concentration/i);
    expect(eu.limitations.join(' ')).toMatch(/children under 3 years/i);
  });

  it('still never claims a violation even with a disclosed figure', () => {
    const text = lensWith(DECLARATION_SERUM_WITH_CONCENTRATION)
      .entries[0]!.limitations.join(' ')
      .toLowerCase();
    expect(text).not.toMatch(/violat|non-compliant|illegal|breach/);
  });
});

// ===========================================================================
// SCENARIO 6 - Product/batch recall
// ===========================================================================

describe('Scenario 6: a batch recall affects only matching batches', () => {
  const recallRule: AssessmentRuleVersion = {
    id: 'rule-batch-recall',
    kind: 'BATCH_ACTION_MATCH',
    version: 'v1',
    evidenceLevel: 'A',
    maxUrgency: 'HIGH',
    requiredItemVerification: ['CONFIRMED', 'PROBABLE'],
    requiredProfileProvenance: ['USER_REPORTED'],
    explanationTemplateId: 'tpl-batch-recall-v1',
    reviewState: 'PUBLISHED',
    approvedByReviewerId: REVIEWER,
    approvedAt: T0,
    shadowMode: false,
    enabled: true,
  };

  function ownedItem(lotCode: string | null): OwnedItemSnapshot {
    return {
      ownedItemId: 'owned-serum',
      profileId: PROFILE_PRIYA.profileId,
      productIdentityId: PRODUCT_CLARIFYING_SERUM.productIdentityId,
      formulationId: 'form-v1',
      formulationVersion: 'fv-1',
      batchId: lotCode ? 'batch-1' : null,
      lotCode,
      gtin: PRODUCT_CLARIFYING_SERUM.gtin,
      expiresOn: null,
      identityVerification: 'CONFIRMED',
      formulationVerification: 'CONFIRMED',
      batchVerification: 'CONFIRMED',
      substanceKeys: [SUBSTANCES.SALICYLIC_ACID.canonicalKey],
      isActive: true,
    };
  }

  function assessmentFor(lotCode: string | null): AssessmentInputs {
    return {
      rule: recallRule,
      item: ownedItem(lotCode),
      profileFacts: [],
      actionSignals: [
        {
          id: ACTION_IN_SYNTHETIC_RECALL.id,
          version: 'av-1',
          gtin: ACTION_IN_SYNTHETIC_RECALL.gtin,
          formulationId: null,
          batchCodes: ACTION_IN_SYNTHETIC_RECALL.batchCodes,
          summary: ACTION_IN_SYNTHETIC_RECALL.summary,
        },
      ],
      normalizationVersion: 'norm-1',
      evaluationInstant: T2,
    };
  }

  it('raises an EXACT match for an affected batch', () => {
    const result = evaluateRule(assessmentFor(BATCH_AFFECTED));
    expect(result.matched).toBe(true);
    expect(result.matchConfidence).toBe('EXACT');
    expect(result.urgency).toBe('HIGH');
  });

  it('does not alert a user holding an unaffected batch', () => {
    // The whole point of batch scoping. We know this lot, and it is not in the recall.
    const result = evaluateRule(assessmentFor(BATCH_UNAFFECTED));
    expect(result.matched).toBe(false);
  });

  it('raises a PROBABLE match with lower urgency when the batch is unknown', () => {
    const result = evaluateRule(assessmentFor(null));
    expect(result.matched).toBe(true);
    expect(result.matchConfidence).toBe('PROBABLE');
    expect(result.urgency).toBe('MEDIUM');
  });

  it('keeps evidence level constant across all three outcomes', () => {
    // Evidence strength describes the source, not how well it matched this user (spec 23 D-005).
    for (const lot of [BATCH_AFFECTED, BATCH_UNAFFECTED, null]) {
      expect(evaluateRule(assessmentFor(lot)).evidenceLevel).toBe('A');
    }
  });
});

// ===========================================================================
// SCENARIO 7 - Evidence correction and replay
// ===========================================================================

describe('Scenario 7: a correction recomputes assessments and history stays auditable', () => {
  const sensitivityRule: AssessmentRuleVersion = {
    id: 'rule-sensitivity',
    kind: 'INGREDIENT_SENSITIVITY',
    version: 'v1',
    evidenceLevel: 'B',
    maxUrgency: 'MEDIUM',
    requiredItemVerification: ['CONFIRMED'],
    requiredProfileProvenance: ['USER_REPORTED', 'REVIEWER_CONFIRMED'],
    explanationTemplateId: 'tpl-sensitivity-v1',
    reviewState: 'PUBLISHED',
    approvedByReviewerId: REVIEWER,
    approvedAt: T0,
    shadowMode: false,
    enabled: true,
  };

  function itemOnFormulation(
    declaration: string,
    formulationVersion: string,
  ): OwnedItemSnapshot {
    const ingredients = parseAndNormalize(declaration, FIXTURE_ALIAS_RESOLVER);
    return {
      ownedItemId: 'owned-serum',
      profileId: PROFILE_PRIYA.profileId,
      productIdentityId: PRODUCT_CLARIFYING_SERUM.productIdentityId,
      formulationId: `form-${formulationVersion}`,
      formulationVersion,
      batchId: null,
      lotCode: null,
      gtin: PRODUCT_CLARIFYING_SERUM.gtin,
      expiresOn: null,
      identityVerification: 'CONFIRMED',
      formulationVerification: 'CONFIRMED',
      batchVerification: 'UNVERIFIED',
      substanceKeys: ingredients.flatMap((i) => (i.canonicalKey ? [i.canonicalKey] : [])),
      isActive: true,
    };
  }

  function inputsFor(declaration: string, version: string): AssessmentInputs {
    return {
      rule: sensitivityRule,
      item: itemOnFormulation(declaration, version),
      profileFacts: [FACT_PRIYA_SALICYLATE_SENSITIVITY],
      actionSignals: [],
      normalizationVersion: 'norm-1',
      evaluationInstant: T2,
    };
  }

  it('matches Priya against the original salicylic-acid formulation', () => {
    const result = evaluateRule(inputsFor(DECLARATION_SERUM_V1, 'fv-1'));
    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('SUBSTANCE_IN_DECLARATION');
    expect(result.inputVersions.profileFactVersions).toEqual([
      FACT_PRIYA_SALICYLATE_SENSITIVITY.version,
    ]);
  });

  it('does not match against the reformulated version', () => {
    const result = evaluateRule(inputsFor(DECLARATION_SERUM_V2, 'fv-2'));
    expect(result.matched).toBe(false);
  });

  it('reproduces the original assessment exactly when replayed', () => {
    // Spec 09: "Replaying the same versions must reproduce the result."
    const original = evaluateRule(inputsFor(DECLARATION_SERUM_V1, 'fv-1'));
    const replay = replayAssessment(original, inputsFor(DECLARATION_SERUM_V1, 'fv-1'));
    expect(replay.reproduced).toBe(true);
  });

  it('reports precisely what changed when the formulation is corrected', () => {
    const original = evaluateRule(inputsFor(DECLARATION_SERUM_V1, 'fv-1'));
    const replay = replayAssessment(original, inputsFor(DECLARATION_SERUM_V2, 'fv-2'));

    expect(replay.reproduced).toBe(false);
    expect(replay.differences).toContain('matched');
    // The original assessment object is untouched, so the history remains inspectable.
    expect(original.matched).toBe(true);
    expect(replay.recomputed.matched).toBe(false);
  });

  it('preserves both formulation versions for audit', () => {
    const original = evaluateRule(inputsFor(DECLARATION_SERUM_V1, 'fv-1'));
    const corrected = evaluateRule(inputsFor(DECLARATION_SERUM_V2, 'fv-2'));

    expect(original.inputVersions.formulationVersion).toBe('fv-1');
    expect(corrected.inputVersions.formulationVersion).toBe('fv-2');
  });

  it('produces a human-readable diff of the correction', () => {
    const diff = diffIngredients(
      parseAndNormalize(DECLARATION_SERUM_V1, FIXTURE_ALIAS_RESOLVER),
      parseAndNormalize(DECLARATION_SERUM_V2, FIXTURE_ALIAS_RESOLVER),
    );
    expect(diff.removed).toContain('Salicylic Acid');
    expect(diff.isMaterial).toBe(true);
  });
});

// ===========================================================================
// Cross-cutting guarantees
// ===========================================================================

describe('cross-cutting: the Lens and Safety Watch stay separate', () => {
  it('a foreign restriction alone produces no personal safety match', () => {
    // Spec 09: a foreign prohibition is evidence/context, not a personalized conclusion. The EU
    // restriction exists, but with no reviewed Kynviora rule tied to it, Safety Watch is silent.
    const noRuleTiedToRegulation: AssessmentRuleVersion = {
      id: 'rule-none',
      kind: 'INGREDIENT_SENSITIVITY',
      version: 'v1',
      evidenceLevel: 'B',
      maxUrgency: 'MEDIUM',
      requiredItemVerification: ['CONFIRMED'],
      requiredProfileProvenance: ['USER_REPORTED'],
      explanationTemplateId: 'tpl-sensitivity-v1',
      reviewState: 'PUBLISHED',
      approvedByReviewerId: REVIEWER,
      approvedAt: T0,
      shadowMode: false,
      enabled: true,
    };

    const result = evaluateRule({
      rule: noRuleTiedToRegulation,
      item: {
        ownedItemId: 'owned-1',
        profileId: PROFILE_PRIYA.profileId,
        productIdentityId: PRODUCT_GENTLE_SHAMPOO.productIdentityId,
        formulationId: 'form-shampoo',
        formulationVersion: 'fv-1',
        batchId: null,
        lotCode: null,
        gtin: PRODUCT_GENTLE_SHAMPOO.gtin,
        expiresOn: null,
        identityVerification: 'CONFIRMED',
        formulationVerification: 'CONFIRMED',
        batchVerification: 'UNVERIFIED',
        substanceKeys: [SUBSTANCES.SALICYLIC_ACID.canonicalKey],
        isActive: true,
      },
      // No profile fact for this user, so no personal relevance is established.
      profileFacts: [],
      actionSignals: [],
      normalizationVersion: 'norm-1',
      evaluationInstant: T2,
    });

    expect(result.matched).toBe(false);
    expect(result.urgency).toBe('INFORMATIONAL');
  });

  it('shipped regulatory fixtures cannot reach the user without passing the gate', () => {
    // DEC-016 end to end: the fixture as shipped is refused; only the explicit test helper
    // promotes it, and that helper names its reviewer 'synthetic-test-reviewer'.
    const shipped = evaluateCitationGate({
      candidate: RULE_EU_SALICYLIC_ACID,
      source: SOURCE_EU_EURLEX,
      document: DOC_EU_ANNEX_III,
      evaluatedAt: T2,
    });
    expect(shipped.decision).toBe('REJECTED');

    const promoted = evaluateCitationGate({
      candidate: asPublishedForTest(RULE_EU_SALICYLIC_ACID),
      source: asApprovedSourceForTest(SOURCE_EU_EURLEX),
      document: withChecksumForTest(DOC_EU_ANNEX_III),
      evaluatedAt: T2,
    });
    expect(promoted.decision).toBe('PASSED');
    expect(asPublishedForTest(RULE_EU_SALICYLIC_ACID).approvedByReviewerId).toBe(
      'synthetic-test-reviewer',
    );
  });
});
