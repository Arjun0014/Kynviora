import { describe, it, expect } from 'vitest';
import { evaluateCitationGate, isPublishable, GATE_FAILURE_EXPLANATIONS } from './citationGate.js';
import type { RegulatoryRuleVersion, SourceDocument, SourceRegistryEntry } from './records.js';
import {
  RULE_EU_SALICYLIC_ACID,
  SOURCE_EU_EURLEX,
  SOURCE_EU_COSING,
  SOURCE_RESEARCH_AGENT,
  DOC_EU_ANNEX_III,
  asPublishedForTest,
  asApprovedSourceForTest,
  withChecksumForTest,
} from '@kynviora/fixtures';
import { instantFrom } from '@kynviora/domain';

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

/** A candidate that satisfies every gate condition, as the baseline to mutate from. */
function passingInput(
  overrides: {
    candidate?: Partial<RegulatoryRuleVersion>;
    source?: Partial<SourceRegistryEntry> | null;
    document?: Partial<SourceDocument> | null;
  } = {},
) {
  const candidate: RegulatoryRuleVersion = {
    ...asPublishedForTest(RULE_EU_SALICYLIC_ACID),
    ...overrides.candidate,
  };
  const source =
    overrides.source === null
      ? null
      : { ...asApprovedSourceForTest(SOURCE_EU_EURLEX), ...overrides.source };
  const document =
    overrides.document === null
      ? null
      : { ...withChecksumForTest(DOC_EU_ANNEX_III), ...overrides.document };

  return { candidate, source, document, evaluatedAt: NOW };
}

describe('the gate passes a fully evidenced candidate', () => {
  it('accepts when every requirement is met', () => {
    const result = evaluateCitationGate(passingInput());
    expect(result.decision).toBe('PASSED');
    expect(result.failures).toEqual([]);
  });

  it('records which checks were satisfied, for reviewer inspection', () => {
    const result = evaluateCitationGate(passingInput());
    expect(result.satisfied).toContain('canonical_identity');
    expect(result.satisfied).toContain('source_class_can_establish_legal_status');
    expect(result.satisfied).toContain('content_checksum');
    expect(result.satisfied).toContain('verified_against_official_source');
    expect(result.satisfied).toContain('human_review_recorded');
  });

  it('is deterministic', () => {
    const input = passingInput();
    expect(evaluateCitationGate(input)).toEqual(evaluateCitationGate(input));
  });
});

describe('shipped fixtures are refused (DEC-016)', () => {
  it('rejects the salicylic acid fixture exactly as shipped', () => {
    // THE HONESTY GUARANTEE. The fixture was assembled from a search summary, not a retrieved
    // official document. Publishing it would be fabricating regulatory approval.
    const result = evaluateCitationGate({
      candidate: RULE_EU_SALICYLIC_ACID,
      source: SOURCE_EU_EURLEX,
      document: DOC_EU_ANNEX_III,
      evaluatedAt: NOW,
    });

    expect(result.decision).toBe('REJECTED');
    expect(result.failures).toContain('NOT_VERIFIED_AGAINST_OFFICIAL_SOURCE');
    expect(result.failures).toContain('REVIEW_NOT_COMPLETED');
    expect(result.failures).toContain('SOURCE_LICENSE_NOT_REVIEWED');
  });

  it('refuses every shipped regulatory fixture without exception', async () => {
    const { ALL_FIXTURE_RULES, FIXTURE_SOURCE_MAP } = await import('@kynviora/fixtures');
    for (const rule of ALL_FIXTURE_RULES) {
      const result = evaluateCitationGate({
        candidate: rule,
        source: FIXTURE_SOURCE_MAP.get(rule.sourceRegistryEntryId) ?? null,
        document: rule.sourceDocumentId ? DOC_EU_ANNEX_III : null,
        evaluatedAt: NOW,
      });
      expect(result.decision).toBe('REJECTED');
    }
  });
});

describe('source authority hierarchy (spec 25)', () => {
  it('refuses a regulatory status sourced from an informational database', () => {
    // The European Commission states CosIng is informational and not legally binding; the
    // Regulation and its Annexes establish legal use conditions.
    const result = evaluateCitationGate(
      passingInput({ source: asApprovedSourceForTest(SOURCE_EU_COSING) }),
    );
    expect(result.decision).toBe('REJECTED');
    expect(result.failures).toContain('SOURCE_CLASS_CANNOT_ESTABLISH_LEGAL_STATUS');
    expect(result.failures).toContain('SOURCE_NOT_AUTHORIZED_FOR_REGULATORY_STATUS');
  });

  it('refuses a search or LLM research result as a citation', () => {
    // Spec 17: "Their answer text is not a Kynviora source." This is the structural enforcement
    // of threat A13 (agent fabricates or follows malicious source instructions).
    const result = evaluateCitationGate(
      passingInput({ source: asApprovedSourceForTest(SOURCE_RESEARCH_AGENT) }),
    );
    expect(result.decision).toBe('REJECTED');
    expect(result.failures).toContain('SOURCE_IS_DISCOVERY_ONLY');
    expect(result.failures).toContain('SOURCE_CLASS_CANNOT_ESTABLISH_LEGAL_STATUS');
  });

  it('refuses a candidate with no registered source at all', () => {
    const result = evaluateCitationGate(passingInput({ source: null }));
    expect(result.failures).toContain('MISSING_SOURCE_REGISTRY_ENTRY');
  });

  it('refuses a source whose licence review has not been completed', () => {
    const result = evaluateCitationGate(
      passingInput({ source: { licenseReviewState: 'NOT_REVIEWED' } }),
    );
    expect(result.failures).toContain('SOURCE_LICENSE_NOT_REVIEWED');
  });

  it('refuses publication from a stale or disabled source', () => {
    // Publishing from a stale source asserts a currency the source cannot support (spec 09).
    for (const status of ['STALE', 'DISABLED'] as const) {
      const result = evaluateCitationGate(passingInput({ source: { status } }));
      expect(result.failures).toContain('SOURCE_DISABLED_OR_STALE');
    }
  });
});

describe('traceable evidence', () => {
  it('refuses a candidate with no source document', () => {
    const result = evaluateCitationGate(passingInput({ document: null }));
    expect(result.failures).toContain('MISSING_SOURCE_DOCUMENT');
  });

  it('refuses a document with no valid content checksum', () => {
    // Spec 04 Phase 6.2: a reviewer must be able to reconstruct which official version produced
    // a record.
    for (const bad of ['', 'not-a-hash', 'ABC123', 'f'.repeat(63)]) {
      const result = evaluateCitationGate(passingInput({ document: { contentSha256: bad } }));
      expect(result.failures).toContain('MISSING_CONTENT_CHECKSUM');
    }
  });

  it('refuses a candidate with no legal reference', () => {
    for (const missing of [null, '', '   ']) {
      const result = evaluateCitationGate(passingInput({ candidate: { legalReference: missing } }));
      expect(result.failures).toContain('MISSING_LEGAL_REFERENCE');
    }
  });

  it('refuses a candidate with neither an effective nor a publication date', () => {
    const result = evaluateCitationGate(
      passingInput({ candidate: { effectiveDate: null, publicationDate: null } }),
    );
    expect(result.failures).toContain('MISSING_EFFECTIVE_DATE');
  });

  it('accepts a publication date when the effective date is absent', () => {
    const result = evaluateCitationGate(passingInput({ candidate: { effectiveDate: null } }));
    expect(result.failures).not.toContain('MISSING_EFFECTIVE_DATE');
  });

  it('refuses a candidate with no extraction version', () => {
    const result = evaluateCitationGate(passingInput({ candidate: { extractionVersion: '' } }));
    expect(result.failures).toContain('MISSING_EXTRACTION_VERSION');
  });
});

describe('condition completeness (spec 24: restricted must not render as banned)', () => {
  it('refuses a concentration limit with no threshold', () => {
    // A bare CONCENTRATION_LIMIT with no number renders as an unexplained restriction, which is
    // exactly the misleading simplification spec 22 tracks as a guardrail metric.
    const result = evaluateCitationGate(
      passingInput({
        candidate: { statuses: ['CONCENTRATION_LIMIT'], conditions: {} },
      }),
    );
    expect(result.failures).toContain('CONDITIONS_INCOMPLETE_FOR_STATUS');
  });

  it('refuses an age or route condition with neither an age nor a route', () => {
    const result = evaluateCitationGate(
      passingInput({
        candidate: { statuses: ['AGE_OR_ROUTE_CONDITION'], conditions: {} },
      }),
    );
    expect(result.failures).toContain('CONDITIONS_INCOMPLETE_FOR_STATUS');
  });

  it('refuses a use condition with no product scope', () => {
    const result = evaluateCitationGate(
      passingInput({ candidate: { statuses: ['USE_CONDITION'], conditions: {} } }),
    );
    expect(result.failures).toContain('CONDITIONS_INCOMPLETE_FOR_STATUS');
  });

  it('refuses a warning requirement with no warning text', () => {
    const result = evaluateCitationGate(
      passingInput({ candidate: { statuses: ['WARNING_REQUIRED'], conditions: {} } }),
    );
    expect(result.failures).toContain('CONDITIONS_INCOMPLETE_FOR_STATUS');
  });

  it('accepts an unconditional prohibition with no conditions', () => {
    // A flat ban genuinely needs no condition, so it must not be caught by the completeness rule.
    const result = evaluateCitationGate(
      passingInput({ candidate: { statuses: ['PROHIBITED'], conditions: {} } }),
    );
    expect(result.failures).not.toContain('CONDITIONS_INCOMPLETE_FOR_STATUS');
    expect(result.decision).toBe('PASSED');
  });

  it('accepts the multi-status salicylic acid rule, whose conditions are complete', () => {
    const result = evaluateCitationGate(passingInput());
    expect(result.failures).not.toContain('CONDITIONS_INCOMPLETE_FOR_STATUS');
  });
});

describe('human review is never assumed (spec 10, operating brief 39)', () => {
  it('refuses a candidate that has not completed review', () => {
    for (const state of ['CANDIDATE', 'IN_REVIEW', 'REJECTED'] as const) {
      const result = evaluateCitationGate(passingInput({ candidate: { reviewState: state } }));
      expect(result.failures).toContain('REVIEW_NOT_COMPLETED');
    }
  });

  it('refuses an APPROVED record with no named reviewer', () => {
    // Engineering must never represent that a qualified review occurred when it did not. An
    // APPROVED state with no reviewer is exactly that misrepresentation.
    const result = evaluateCitationGate(
      passingInput({ candidate: { approvedByReviewerId: null } }),
    );
    expect(result.failures).toContain('REVIEWER_NOT_RECORDED');
  });

  it('refuses an APPROVED record with no approval timestamp', () => {
    const result = evaluateCitationGate(passingInput({ candidate: { approvedAt: null } }));
    expect(result.failures).toContain('REVIEWER_NOT_RECORDED');
  });

  it('refuses a superseded or withdrawn rule', () => {
    for (const state of ['SUPERSEDED', 'WITHDRAWN'] as const) {
      const result = evaluateCitationGate(passingInput({ candidate: { reviewState: state } }));
      expect(result.failures).toContain('SUPERSEDED');
    }
  });
});

describe('identity and jurisdiction', () => {
  it('refuses a candidate with no canonical substance mapping', () => {
    const result = evaluateCitationGate(
      passingInput({ candidate: { substanceCanonicalKey: '  ' } }),
    );
    expect(result.failures).toContain('MISSING_CANONICAL_IDENTITY');
  });

  it('refuses a candidate with no status', () => {
    const result = evaluateCitationGate(passingInput({ candidate: { statuses: [] } }));
    expect(result.failures).toContain('MISSING_STATUS');
  });
});

describe('isPublishable', () => {
  it('mirrors the gate decision', () => {
    expect(isPublishable(passingInput())).toBe(true);
    expect(isPublishable(passingInput({ document: null }))).toBe(false);
  });

  it('does not accept PUBLISHED review state alone as sufficient', () => {
    // The trap this function exists to prevent: deriving publishability from reviewState only
    // would skip source authority, checksum and verification entirely.
    const publishedButUnverified = passingInput({
      candidate: { reviewState: 'PUBLISHED', verification: 'NEEDS_PRIMARY_VERIFICATION' },
    });
    expect(publishedButUnverified.candidate.reviewState).toBe('PUBLISHED');
    expect(isPublishable(publishedButUnverified)).toBe(false);
  });
});

describe('failure explanations', () => {
  it('provides a plain-language explanation for every failure code', () => {
    const result = evaluateCitationGate({
      candidate: RULE_EU_SALICYLIC_ACID,
      source: SOURCE_EU_EURLEX,
      document: DOC_EU_ANNEX_III,
      evaluatedAt: NOW,
    });
    for (const code of result.failures) {
      expect(GATE_FAILURE_EXPLANATIONS[code]).toBeTruthy();
      expect(GATE_FAILURE_EXPLANATIONS[code].length).toBeGreaterThan(10);
    }
  });

  it('avoids alarm language, since a rejection is normal operating behaviour', () => {
    for (const explanation of Object.values(GATE_FAILURE_EXPLANATIONS)) {
      expect(explanation.toLowerCase()).not.toMatch(/danger|unsafe|alarm|critical failure/);
    }
  });
});
