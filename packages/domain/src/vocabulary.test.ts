import { describe, it, expect } from 'vitest';
import {
  JURISDICTIONS,
  JURISDICTION_NAMES,
  EVIDENCE_LEVELS,
  ACTION_URGENCIES,
  MATCH_CONFIDENCES,
  REGULATORY_STATUSES,
  REGULATORY_APPLICABILITIES,
  NON_PROHIBITION_STATUSES,
  ABSENCE_STATUSES,
  LEGAL_STATUS_SOURCE_CLASSES,
  DISCOVERY_ONLY_SOURCE_CLASSES,
  SOURCE_CLASSES,
  FOREIGN_REGULATORY_DEFAULT_URGENCY,
  MVP_USER_VISIBLE_EVIDENCE_LEVELS,
  UNCONFIRMED_MACHINE_PROVENANCE,
  CATALOG_CORROBORATIONS,
  ITEM_VERIFICATIONS,
  PRODUCT_SAFETY_STATES,
  isJurisdiction,
  isRegulatoryStatus,
  isEvidenceLevel,
  isMarketCode,
  marketCode,
  jurisdictionsForMarket,
} from './vocabulary.js';

describe('jurisdictions (DEC-008, spec 23 D-013)', () => {
  it('contains exactly the six MVP adapter targets', () => {
    expect([...JURISDICTIONS]).toEqual(['IN', 'EU', 'GB', 'NI', 'US', 'JP']);
  });

  it('models GB and NI separately', () => {
    // 23 D-013: "Do not store one generic UK cosmetics status when applicable legal
    // frameworks can diverge." GB retained EU law and may diverge; NI follows EU rules
    // under the Windsor Framework.
    expect(JURISDICTIONS).toContain('GB');
    expect(JURISDICTIONS).toContain('NI');
  });

  it('has no UK member, so the GB/NI collapse is unrepresentable', () => {
    expect(JURISDICTIONS).not.toContain('UK');
    expect(isJurisdiction('UK')).toBe(false);
  });

  it('names every jurisdiction without ranking language', () => {
    for (const j of JURISDICTIONS) {
      const name = JURISDICTION_NAMES[j];
      expect(name).toBeTruthy();
      // 09: "Avoid value judgments such as 'strict country' or 'weak regulation'."
      expect(name.toLowerCase()).not.toMatch(/strict|weak|lenient|safe|dangerous/);
    }
  });
});

describe('evidence level and action urgency are separate dimensions (23 D-005)', () => {
  it('defines the six evidence levels from spec 09', () => {
    expect([...EVIDENCE_LEVELS]).toEqual(['A', 'B', 'C', 'D', 'E', 'U']);
  });

  it('defines the five urgency levels from spec 09', () => {
    expect([...ACTION_URGENCIES]).toEqual([
      'CRITICAL',
      'HIGH',
      'MEDIUM',
      'LOW',
      'INFORMATIONAL',
    ]);
  });

  it('shares no member between the two vocabularies', () => {
    // If a value were valid in both, code could conflate them without a type error.
    const overlap = EVIDENCE_LEVELS.filter((e) => (ACTION_URGENCIES as readonly string[]).includes(e));
    expect(overlap).toEqual([]);
  });

  it('keeps emerging signals (E) out of MVP user-visible evidence', () => {
    // 09: level E is "normally internal monitoring in MVP".
    expect(MVP_USER_VISIBLE_EVIDENCE_LEVELS).not.toContain('E');
    expect(MVP_USER_VISIBLE_EVIDENCE_LEVELS).toContain('A');
    expect(MVP_USER_VISIBLE_EVIDENCE_LEVELS).toContain('U');
  });

  it('defaults foreign regulatory differences to INFORMATIONAL', () => {
    // 09: a foreign restriction "should normally default to INFORMATIONAL unless a separate
    // reviewed rule establishes a stronger action". This is the guard against a foreign
    // ingredient rule becoming a red personal alert (threat A12).
    expect(FOREIGN_REGULATORY_DEFAULT_URGENCY).toBe('INFORMATIONAL');
  });
});

describe('regulatory status family (spec 09)', () => {
  it('covers all eleven statuses', () => {
    expect(REGULATORY_STATUSES).toHaveLength(11);
    for (const expected of [
      'PROHIBITED',
      'RESTRICTED',
      'CONCENTRATION_LIMIT',
      'USE_CONDITION',
      'AGE_OR_ROUTE_CONDITION',
      'WARNING_REQUIRED',
      'POSITIVE_LIST_ONLY',
      'PRODUCT_ACTION',
      'SCIENTIFIC_OPINION',
      'NO_MATCHED_RULE_WITHIN_COVERAGE',
      'UNKNOWN_OR_INSUFFICIENT',
    ]) {
      expect(REGULATORY_STATUSES).toContain(expected);
    }
  });

  it('has no APPROVED, LEGAL, SAFE or PERMITTED status', () => {
    // 23 D-014: absence is not approval. There is deliberately no positive-clearance status,
    // because Kynviora's monitored sources cannot establish one.
    for (const forbidden of ['APPROVED', 'LEGAL', 'SAFE', 'PERMITTED', 'CLEARED', 'OK']) {
      expect(REGULATORY_STATUSES).not.toContain(forbidden);
    }
  });

  it('classifies RESTRICTED as a non-prohibition', () => {
    // 09: "'Restricted' is not 'banned'." Rendering a restriction as a ban is a
    // release-blocking misleading-simplification defect (24, 22 guardrail metric).
    expect(NON_PROHIBITION_STATUSES).toContain('RESTRICTED');
    expect(NON_PROHIBITION_STATUSES).toContain('CONCENTRATION_LIMIT');
    expect(NON_PROHIBITION_STATUSES).not.toContain('PROHIBITED');
  });

  it('classifies SCIENTIFIC_OPINION as a non-prohibition', () => {
    // 09: a scientific committee opinion "is not itself the legal status".
    expect(NON_PROHIBITION_STATUSES).toContain('SCIENTIFIC_OPINION');
  });

  it('treats both absence states as absence, not clearance', () => {
    expect([...ABSENCE_STATUSES]).toEqual([
      'NO_MATCHED_RULE_WITHIN_COVERAGE',
      'UNKNOWN_OR_INSUFFICIENT',
    ]);
    for (const s of ABSENCE_STATUSES) {
      expect(NON_PROHIBITION_STATUSES).toContain(s);
    }
  });

  it('rejects unknown status strings', () => {
    expect(isRegulatoryStatus('BANNED')).toBe(false);
    expect(isRegulatoryStatus('APPROVED')).toBe(false);
    expect(isRegulatoryStatus('PROHIBITED')).toBe(true);
  });
});

describe('regulatory applicability is a second axis (DEC-007)', () => {
  it('provides CONDITION_UNKNOWN for undisclosed concentration/use', () => {
    // 03 demo step: report "restriction exists" plus "compliance cannot be determined from
    // available package information" rather than claiming a violation.
    expect(REGULATORY_APPLICABILITIES).toContain('CONDITION_UNKNOWN');
    expect(REGULATORY_APPLICABILITIES).toContain('IDENTITY_UNCERTAIN');
  });

  it('shares no member with the status vocabulary', () => {
    const overlap = REGULATORY_APPLICABILITIES.filter((a) =>
      (REGULATORY_STATUSES as readonly string[]).includes(a),
    );
    expect(overlap).toEqual([]);
  });

  it('has no COMPLIANT or VIOLATION member', () => {
    // Kynviora determines whether a rule *can be evaluated*, never whether a marketed product
    // complies with law. That is a regulator's finding, not an app's.
    for (const forbidden of ['COMPLIANT', 'NON_COMPLIANT', 'VIOLATION', 'BREACH']) {
      expect(REGULATORY_APPLICABILITIES).not.toContain(forbidden);
    }
  });
});

describe('source authority hierarchy (spec 25)', () => {
  it('permits only primary law and official action registries to set legal status', () => {
    expect([...LEGAL_STATUS_SOURCE_CLASSES]).toEqual([
      'PRIMARY_LEGAL',
      'OFFICIAL_ACTION_REGISTRY',
    ]);
  });

  it('excludes identity/normalization databases from establishing legal status', () => {
    // 25: CosIng is informational; Regulation 1223/2009 and its Annexes establish legal use
    // conditions. PubChem normalizes chemistry and is explicitly not a legal-status source.
    expect(LEGAL_STATUS_SOURCE_CLASSES).not.toContain('IDENTITY_NORMALIZATION');
  });

  it('excludes scientific opinions from establishing legal status', () => {
    // 09: scientific opinion is a distinct status, never an automatic prohibition.
    expect(LEGAL_STATUS_SOURCE_CLASSES).not.toContain('OFFICIAL_SCIENTIFIC_OPINION');
  });

  it('treats search and LLM research as discovery only', () => {
    // 17: "Their answer text is not a Kynviora source."
    expect(DISCOVERY_ONLY_SOURCE_CLASSES).toContain('SEARCH_OR_LLM_RESEARCH');
    expect(DISCOVERY_ONLY_SOURCE_CLASSES).toContain('COMMUNITY_DISCOVERY');
    expect(LEGAL_STATUS_SOURCE_CLASSES).not.toContain('SEARCH_OR_LLM_RESEARCH');
  });

  it('keeps legal-status and discovery-only classes disjoint', () => {
    const overlap = LEGAL_STATUS_SOURCE_CLASSES.filter((c) =>
      DISCOVERY_ONLY_SOURCE_CLASSES.includes(c),
    );
    expect(overlap).toEqual([]);
  });

  it('every source class is accounted for in the vocabulary', () => {
    for (const c of [...LEGAL_STATUS_SOURCE_CLASSES, ...DISCOVERY_ONLY_SOURCE_CLASSES]) {
      expect(SOURCE_CLASSES).toContain(c);
    }
  });
});

describe('catalog and verification vocabularies', () => {
  it('models the Living Catalog lifecycle from spec 08', () => {
    expect([...CATALOG_CORROBORATIONS]).toEqual([
      'CANDIDATE',
      'USER_CONFIRMED',
      'CORROBORATED',
      'EXTERNALLY_VERIFIED',
      'CONFLICTING',
      'RETIRED',
    ]);
  });

  it('has no SAFE or VERIFIED_SAFE corroboration state', () => {
    // 08: "Corroboration establishes package/formulation evidence quality, not medical safety."
    for (const forbidden of ['SAFE', 'VERIFIED_SAFE', 'APPROVED']) {
      expect(CATALOG_CORROBORATIONS).not.toContain(forbidden);
    }
  });

  it('keeps CONFLICTING as a first-class verification state', () => {
    // Required so a formulation disagreement can be represented without overwriting history.
    expect(ITEM_VERIFICATIONS).toContain('CONFLICTING');
    expect(ITEM_VERIFICATIONS).toContain('UNVERIFIED');
  });
});

describe('product safety states (spec 09)', () => {
  it('offers no universally safe state', () => {
    // 23 D-005 and 09: "Avoid universal safe/unsafe."
    for (const forbidden of ['SAFE', 'UNSAFE', 'DANGEROUS', 'CLEARED', 'PASS', 'FAIL']) {
      expect(PRODUCT_SAFETY_STATES).not.toContain(forbidden);
    }
  });

  it('names the no-alert state so it cannot be misread as safety', () => {
    // The identifier itself carries the qualification: no *current matched alert*, which the
    // UI must pair with a coverage statement.
    expect(PRODUCT_SAFETY_STATES).toContain('NO_CURRENT_MATCHED_ALERT');
    expect(PRODUCT_SAFETY_STATES).toContain('INSUFFICIENT_DATA');
  });
});

describe('provenance', () => {
  it('marks raw OCR and vision output as unconfirmed machine provenance', () => {
    // 17: "A model cannot fill a missing field merely because it is likely."
    expect(UNCONFIRMED_MACHINE_PROVENANCE).toContain('PACKAGE_OCR');
    expect(UNCONFIRMED_MACHINE_PROVENANCE).toContain('PACKAGE_VISION_MODEL');
  });

  it('does not mark deterministic or human sources as unconfirmed', () => {
    expect(UNCONFIRMED_MACHINE_PROVENANCE).not.toContain('BARCODE_DECODE');
    expect(UNCONFIRMED_MACHINE_PROVENANCE).not.toContain('USER_CONFIRMED_FROM_PACKAGE');
    expect(UNCONFIRMED_MACHINE_PROVENANCE).not.toContain('OFFICIAL_SOURCE');
  });
});

describe('type guards', () => {
  it('reject non-string and unknown values', () => {
    expect(isEvidenceLevel('A')).toBe(true);
    expect(isEvidenceLevel('Z')).toBe(false);
    expect(isEvidenceLevel(1)).toBe(false);
    expect(isEvidenceLevel(null)).toBe(false);
    expect(isEvidenceLevel(undefined)).toBe(false);
    expect(isMatchConfidenceLike('EXACT')).toBe(true);
  });
});

function isMatchConfidenceLike(v: string): boolean {
  return (MATCH_CONFIDENCES as readonly string[]).includes(v);
}

describe('market codes are distinct from jurisdictions (spec 23 D-013/D-014)', () => {
  it('accepts ISO 3166-1 alpha-2 codes', () => {
    expect(isMarketCode('IN')).toBe(true);
    expect(isMarketCode('FR')).toBe(true);
    expect(marketCode('GB')).toBe('GB');
  });

  it('rejects malformed codes', () => {
    expect(isMarketCode('in')).toBe(false);
    expect(isMarketCode('IND')).toBe(false);
    expect(isMarketCode('')).toBe(false);
    expect(() => marketCode('india')).toThrow(TypeError);
  });

  it('resolves a GB market to BOTH the GB and NI jurisdictions', () => {
    // Northern Ireland has no ISO alpha-2 code of its own, so a package bought there carries GB.
    // Returning both is what surfaces the Windsor Framework divergence rather than hiding it
    // behind a single "UK" answer.
    expect([...jurisdictionsForMarket(marketCode('GB'))]).toEqual(['GB', 'NI']);
  });

  it('resolves an EU member state to the EU jurisdiction', () => {
    expect([...jurisdictionsForMarket(marketCode('FR'))]).toEqual(['EU']);
    expect([...jurisdictionsForMarket(marketCode('DE'))]).toEqual(['EU']);
  });

  it('resolves single-jurisdiction markets directly', () => {
    expect([...jurisdictionsForMarket(marketCode('IN'))]).toEqual(['IN']);
    expect([...jurisdictionsForMarket(marketCode('US'))]).toEqual(['US']);
    expect([...jurisdictionsForMarket(marketCode('JP'))]).toEqual(['JP']);
  });

  it('returns an empty list for an unmonitored market rather than guessing', () => {
    // A package bought in a market Kynviora does not monitor has no jurisdiction. Returning
    // empty makes "not monitored" explicit; defaulting to any jurisdiction would let an
    // unchecked market masquerade as a consulted regulator (spec 23 D-014).
    expect(jurisdictionsForMarket(marketCode('BR'))).toEqual([]);
    expect(jurisdictionsForMarket(marketCode('AU'))).toEqual([]);
  });
});
