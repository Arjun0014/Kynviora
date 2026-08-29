import { describe, it, expect } from 'vitest';
import {
  projectLens,
  determineApplicability,
  limitationsFor,
  isAbsenceEntry,
  isProhibition,
  type ProductContext,
  type LensInput,
} from './lens.js';
import type { RegulatoryConditions, SourceRegistryEntry } from './records.js';
import {
  RULE_EU_SALICYLIC_ACID,
  RULE_GB_SALICYLIC_ACID,
  RULE_NI_SALICYLIC_ACID,
  OPINION_EU_SYNTHETIC,
  SUBSTANCE_SALICYLIC_ACID,
  ALL_FIXTURE_SOURCES,
  asPublishedForTest,
  asApprovedSourceForTest,
} from '@kynviora/fixtures';
import { instantFrom, JURISDICTIONS } from '@kynviora/domain';

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

const SOURCES: ReadonlyMap<string, SourceRegistryEntry> = new Map(
  ALL_FIXTURE_SOURCES.map((s) => [s.id, asApprovedSourceForTest(s)]),
);

/** A typical leave-on skincare package: ingredient present, concentration not disclosed. */
function context(overrides: Partial<ProductContext> = {}): ProductContext {
  return {
    substanceCanonicalKey: SUBSTANCE_SALICYLIC_ACID,
    disclosedConcentrationPercent: null,
    productUseType: 'LEAVE_ON',
    productCategory: 'face serum',
    intendedForAgeYears: null,
    substancePresent: true,
    ...overrides,
  };
}

function lensInput(overrides: Partial<LensInput> = {}): LensInput {
  return {
    context: context(),
    jurisdictions: [...JURISDICTIONS],
    rules: [
      asPublishedForTest(RULE_EU_SALICYLIC_ACID),
      asPublishedForTest(RULE_GB_SALICYLIC_ACID),
      asPublishedForTest(RULE_NI_SALICYLIC_ACID),
    ],
    opinions: [],
    actions: [],
    sources: SOURCES,
    generatedAt: NOW,
    ...overrides,
  };
}

const entryFor = (snapshot: ReturnType<typeof projectLens>, j: string) =>
  snapshot.entries.find((e) => e.jurisdiction === j);

describe('determineApplicability (DEC-007)', () => {
  it('returns CONDITION_UNKNOWN when a concentration limit meets an undisclosed concentration', () => {
    // THE DOMINANT REAL-WORLD CASE. INCI declarations list order, not percentages, so a
    // concentration-limited rule almost always lands here. Spec 03 demo step 9 requires
    // reporting that a restriction exists AND that compliance cannot be determined.
    const conditions: RegulatoryConditions = { maxConcentrationPercent: 2.0 };
    expect(determineApplicability(conditions, context())).toBe('CONDITION_UNKNOWN');
  });

  it('returns APPLIES when the concentration is disclosed', () => {
    const conditions: RegulatoryConditions = { maxConcentrationPercent: 2.0 };
    expect(
      determineApplicability(conditions, context({ disclosedConcentrationPercent: 1.5 })),
    ).toBe('APPLIES');
  });

  it('still returns APPLIES, not a violation, when a disclosed value exceeds the limit', () => {
    // Determining whether a marketed product complies with law is a regulator's finding, not an
    // app's. The vocabulary deliberately has no EXCEEDS_LIMIT or NON_COMPLIANT outcome.
    const conditions: RegulatoryConditions = { maxConcentrationPercent: 2.0 };
    const result = determineApplicability(
      conditions,
      context({ disclosedConcentrationPercent: 5.0 }),
    );
    expect(result).toBe('APPLIES');
    expect(result).not.toBe('EXCEEDS_LIMIT');
  });

  it('returns DOES_NOT_APPLY when the substance is absent', () => {
    expect(
      determineApplicability({ maxConcentrationPercent: 2 }, context({ substancePresent: false })),
    ).toBe('DOES_NOT_APPLY');
  });

  it('returns DOES_NOT_APPLY when the rule is scoped to a different product use type', () => {
    const conditions: RegulatoryConditions = { productUseTypes: ['ORAL'] };
    expect(determineApplicability(conditions, context({ productUseType: 'LEAVE_ON' }))).toBe(
      'DOES_NOT_APPLY',
    );
  });

  it('returns CONDITION_UNKNOWN when the rule is use-scoped and the use type is unknown', () => {
    const conditions: RegulatoryConditions = { productUseTypes: ['RINSE_OFF'] };
    expect(determineApplicability(conditions, context({ productUseType: 'UNKNOWN' }))).toBe(
      'CONDITION_UNKNOWN',
    );
  });

  it('returns CONDITION_UNKNOWN when an age condition meets an unknown intended age', () => {
    const conditions: RegulatoryConditions = { minimumAgeYears: 3 };
    expect(determineApplicability(conditions, context({ intendedForAgeYears: null }))).toBe(
      'CONDITION_UNKNOWN',
    );
  });

  it('applies an age condition when the product targets a younger group', () => {
    const conditions: RegulatoryConditions = { minimumAgeYears: 3 };
    expect(determineApplicability(conditions, context({ intendedForAgeYears: 1 }))).toBe('APPLIES');
    expect(determineApplicability(conditions, context({ intendedForAgeYears: 30 }))).toBe(
      'DOES_NOT_APPLY',
    );
  });

  it('applies an unconditional prohibition whenever the substance is present', () => {
    expect(determineApplicability({}, context())).toBe('APPLIES');
  });
});

describe('GB and NI are answered independently (spec 23 D-013)', () => {
  it('produces separate entries for GB and NI', () => {
    const snapshot = projectLens(lensInput());
    expect(entryFor(snapshot, 'GB')).toBeDefined();
    expect(entryFor(snapshot, 'NI')).toBeDefined();
  });

  it('can show different effective dates for the same substance', () => {
    // The divergence the separation exists for: GB retained the rule at exit and may not have
    // adopted later EU amendments.
    const snapshot = projectLens(lensInput());
    const gb = entryFor(snapshot, 'GB');
    const ni = entryFor(snapshot, 'NI');
    expect(gb?.effectiveDate).toBe('2021-01-01');
    expect(ni?.effectiveDate).toBe('2009-12-22');
    expect(gb?.effectiveDate).not.toBe(ni?.effectiveDate);
  });

  it('cites different legal instruments for GB and NI', () => {
    const snapshot = projectLens(lensInput());
    expect(entryFor(snapshot, 'GB')?.legalInstrument).toContain('Great Britain');
    expect(entryFor(snapshot, 'NI')?.legalInstrument).toContain('Northern Ireland');
  });

  it('never emits a combined UK entry', () => {
    const snapshot = projectLens(lensInput());
    expect(snapshot.entries.map((e) => e.jurisdiction)).not.toContain('UK');
  });
});

describe('restricted is never rendered as prohibited (spec 09, 24)', () => {
  it('reports the EU salicylic acid rule as restricted, not prohibited', () => {
    const snapshot = projectLens(lensInput());
    const eu = entryFor(snapshot, 'EU');

    expect(eu?.statuses).toContain('RESTRICTED');
    expect(eu?.statuses).not.toContain('PROHIBITED');
    expect(isProhibition(eu!)).toBe(false);
  });

  it('preserves every simultaneously applicable status', () => {
    // Spec 07: "Do not force one oversimplified status if the legal conditions are
    // multidimensional."
    const snapshot = projectLens(lensInput());
    const eu = entryFor(snapshot, 'EU');
    expect(eu?.statuses).toContain('RESTRICTED');
    expect(eu?.statuses).toContain('CONCENTRATION_LIMIT');
    expect(eu?.statuses).toContain('USE_CONDITION');
    expect(eu?.statuses).toContain('AGE_OR_ROUTE_CONDITION');
  });

  it('states explicitly that the substance is permitted under conditions', () => {
    const snapshot = projectLens(lensInput());
    const eu = entryFor(snapshot, 'EU');
    expect(eu?.limitations.join(' ')).toMatch(/permitted under conditions.*not prohibited/i);
  });

  it('exposes the exact conditions so the restriction can be explained', () => {
    const snapshot = projectLens(lensInput());
    const eu = entryFor(snapshot, 'EU');
    expect(eu?.conditions?.maxConcentrationPercent).toBe(2.0);
    expect(eu?.conditions?.minimumAgeYears).toBe(3);
    expect(eu?.conditions?.prohibitedRoutes).toContain('inhalation');
    expect(eu?.legalReference).toBe('Annex III, entry 98');
  });
});

describe('absence is never rendered as approval (spec 23 D-014)', () => {
  it('reports NO_MATCHED_RULE_WITHIN_COVERAGE for the US, which has no salicylic acid rule', () => {
    const snapshot = projectLens(lensInput());
    const us = entryFor(snapshot, 'US');

    expect(us?.statuses).toContain('NO_MATCHED_RULE_WITHIN_COVERAGE');
    expect(isAbsenceEntry(us!)).toBe(true);
  });

  it('never emits an APPROVED, SAFE or PERMITTED status', () => {
    const snapshot = projectLens(lensInput());
    for (const entry of snapshot.entries) {
      for (const forbidden of ['APPROVED', 'SAFE', 'LEGAL', 'PERMITTED', 'CLEARED']) {
        expect(entry.statuses).not.toContain(forbidden);
      }
    }
  });

  it('attaches the explicit not-approval limitation to an absence result', () => {
    const snapshot = projectLens(lensInput());
    const us = entryFor(snapshot, 'US');
    const text = us!.limitations.join(' ');
    expect(text).toMatch(/not regulatory approval/i);
    expect(text).toMatch(/does not mean the product is safe/i);
  });

  it('adds the FDA-specific caveat for the United States', () => {
    // Spec 09 requires exactly this: "No matched federal prohibition found ... This is not FDA
    // approval or a guarantee of safety." The US framework makes absence especially easy to
    // misread, since most cosmetic ingredients get no premarket review at all.
    const snapshot = projectLens(lensInput());
    const us = entryFor(snapshot, 'US');
    expect(us!.limitations.join(' ')).toMatch(/not FDA approval/i);
  });

  it('always attaches a coverage statement to an absence result', () => {
    const snapshot = projectLens(lensInput());
    const us = entryFor(snapshot, 'US');
    expect(us?.coverageStatement).toBeTruthy();
    expect(us!.coverageStatement.length).toBeGreaterThan(20);
  });

  it('distinguishes "checked and found nothing" from "never looked"', () => {
    // Spec 09 coverage disclosure requires separate unknown and stale states. A jurisdiction
    // with no monitored source must not report NO_MATCHED_RULE, which would imply a check.
    const noJapanSource = new Map(
      [...SOURCES.entries()].filter(([, s]) => s.jurisdiction !== 'JP'),
    );
    const snapshot = projectLens(lensInput({ sources: noJapanSource }));
    const jp = entryFor(snapshot, 'JP');

    expect(jp?.statuses).toContain('UNKNOWN_OR_INSUFFICIENT');
    expect(jp?.statuses).not.toContain('NO_MATCHED_RULE_WITHIN_COVERAGE');
    expect(snapshot.unmonitoredJurisdictions).toContain('JP');
    expect(jp!.limitations.join(' ')).toMatch(/not evidence that no rule exists/i);
  });
});

describe('condition-unknown reporting (spec 03 demo step 9)', () => {
  it('reports CONDITION_UNKNOWN for a concentration limit with no disclosed concentration', () => {
    const snapshot = projectLens(lensInput());
    const eu = entryFor(snapshot, 'EU');
    expect(eu?.applicability).toBe('CONDITION_UNKNOWN');
  });

  it('states the limit and that compliance cannot be determined', () => {
    // The exact required output: "restriction exists" plus "compliance cannot be determined from
    // available package information" - never a violation claim.
    const snapshot = projectLens(lensInput());
    const text = entryFor(snapshot, 'EU')!.limitations.join(' ');
    expect(text).toMatch(/maximum concentration of 2%/i);
    expect(text).toMatch(/does not disclose the concentration/i);
    expect(text).toMatch(/cannot determine whether that limit is exceeded/i);
  });

  it('never claims a violation, an exceedance or non-compliance', () => {
    const snapshot = projectLens(
      lensInput({ context: context({ disclosedConcentrationPercent: 5 }) }),
    );
    for (const entry of snapshot.entries) {
      const text = entry.limitations.join(' ').toLowerCase();
      expect(text).not.toMatch(/violat|non-compliant|breach|illegal|exceeds the limit/);
    }
  });
});

describe('scientific opinions are not law (spec 09)', () => {
  it('labels an opinion separately from a legal status', () => {
    const snapshot = projectLens(
      lensInput({ rules: [], opinions: [{ ...OPINION_EU_SYNTHETIC, reviewState: 'PUBLISHED' }] }),
    );
    const eu = entryFor(snapshot, 'EU');

    expect(eu?.statuses).toContain('SCIENTIFIC_OPINION');
    expect(eu?.statuses).not.toContain('PROHIBITED');
    expect(eu?.scientificOpinions).toHaveLength(1);
  });

  it('records that an opinion has no implementing law', () => {
    const snapshot = projectLens(
      lensInput({ rules: [], opinions: [{ ...OPINION_EU_SYNTHETIC, reviewState: 'PUBLISHED' }] }),
    );
    expect(entryFor(snapshot, 'EU')?.scientificOpinions[0]?.hasImplementingLaw).toBe(false);
  });

  it('states plainly that an opinion is not law', () => {
    const snapshot = projectLens(
      lensInput({ rules: [], opinions: [{ ...OPINION_EU_SYNTHETIC, reviewState: 'PUBLISHED' }] }),
    );
    const text = entryFor(snapshot, 'EU')!.limitations.join(' ');
    expect(text).toMatch(/not law/i);
    expect(text).toMatch(/has not identified a corresponding legal prohibition/i);
  });

  it('still reports no matched rule alongside an opinion', () => {
    // An opinion existing does not mean a rule exists. Both facts are shown.
    const snapshot = projectLens(
      lensInput({ rules: [], opinions: [{ ...OPINION_EU_SYNTHETIC, reviewState: 'PUBLISHED' }] }),
    );
    expect(entryFor(snapshot, 'EU')?.statuses).toContain('NO_MATCHED_RULE_WITHIN_COVERAGE');
  });
});

describe('unpublished records never reach the Lens', () => {
  it('ignores rules that have not been published', () => {
    // The fixtures ship as IN_REVIEW, so passing them unmodified must yield no matched rule.
    const snapshot = projectLens(
      lensInput({ rules: [RULE_EU_SALICYLIC_ACID, RULE_GB_SALICYLIC_ACID] }),
    );
    expect(entryFor(snapshot, 'EU')?.statuses).toContain('NO_MATCHED_RULE_WITHIN_COVERAGE');
    expect(entryFor(snapshot, 'EU')?.statuses).not.toContain('RESTRICTED');
  });

  it('ignores unpublished scientific opinions', () => {
    const snapshot = projectLens(lensInput({ rules: [], opinions: [OPINION_EU_SYNTHETIC] }));
    expect(entryFor(snapshot, 'EU')?.scientificOpinions).toEqual([]);
  });
});

describe('foreign status is informational (spec 09, threat A12)', () => {
  it('attaches the cross-jurisdiction limitation to every entry', () => {
    const snapshot = projectLens(lensInput());
    for (const entry of snapshot.entries) {
      expect(entry.limitations.join(' ')).toMatch(
        /does not change the legal status in another.*does not by itself demonstrate harm/i,
      );
    }
  });

  it('carries no urgency or severity field at all', () => {
    // The Lens is regulatory transparency, not a personalized assessment. Spec 07.2 requires a
    // foreign status never to set personal alert urgency, so the type carries no such field.
    const snapshot = projectLens(lensInput());
    for (const entry of snapshot.entries) {
      const keys = Object.keys(entry);
      for (const forbidden of [
        'urgency',
        'severity',
        'evidenceLevel',
        'riskScore',
        'safetyState',
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });
});

describe('snapshot integrity', () => {
  it('returns one entry per requested jurisdiction', () => {
    const snapshot = projectLens(lensInput());
    expect(snapshot.entries).toHaveLength(JURISDICTIONS.length);
    expect(snapshot.entries.map((e) => e.jurisdiction).sort()).toEqual([...JURISDICTIONS].sort());
  });

  it('is deterministic', () => {
    expect(projectLens(lensInput())).toEqual(projectLens(lensInput()));
  });

  it('records the rule version behind each entry, for diffing and replay', () => {
    const snapshot = projectLens(lensInput());
    expect(entryFor(snapshot, 'EU')?.ruleVersionId).toBe(RULE_EU_SALICYLIC_ACID.id);
    expect(entryFor(snapshot, 'US')?.ruleVersionId).toBeNull();
  });

  it('never leaves limitations empty', () => {
    // Every displayed status must carry its limitations (spec 09).
    const snapshot = projectLens(lensInput());
    for (const entry of snapshot.entries) {
      expect(entry.limitations.length).toBeGreaterThan(0);
    }
  });
});

describe('limitationsFor', () => {
  it('does not add the permitted-under-conditions line to an actual prohibition', () => {
    const limitations = limitationsFor(['PROHIBITED'], 'APPLIES', 'EU', {});
    expect(limitations.join(' ')).not.toMatch(/permitted under conditions/i);
  });

  it('adds it when the status set is a restriction without a prohibition', () => {
    const limitations = limitationsFor(['RESTRICTED'], 'APPLIES', 'EU', {});
    expect(limitations.join(' ')).toMatch(/permitted under conditions/i);
  });
});
