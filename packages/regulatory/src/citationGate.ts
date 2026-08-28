/**
 * The Citation Gate.
 *
 * Spec references: `09` "Citation Gate", `25` "Citation Gate", `17`, `23` D-015, `24`.
 *
 * WHAT IT IS
 * The single choke point through which a candidate regulatory fact must pass before it can be
 * published as trusted, user-visible truth. `23` D-015: "Search/LLM extraction may produce
 * candidates, but shared regulatory publication requires source authority, exact scope/conditions,
 * traceable official evidence, dates/version, canonical mapping, validation, and required review."
 *
 * WHY IT IS A FUNCTION AND NOT A CHECKLIST
 * `17` gives models no publish authority, and `15` A12/A13 describe how a misread or fabricated
 * regulatory claim causes real harm. A documented checklist depends on a person remembering it; a
 * gate that returns `REJECTED` and is asserted by tests cannot be forgotten.
 *
 * FAIL CLOSED
 * `25`: "If any critical field is unresolved, publish `UNKNOWN_OR_INSUFFICIENT` or keep the
 * record internal rather than inventing a conclusion."
 */

import type { Instant } from '@kynviora/domain';
import { LEGAL_STATUS_SOURCE_CLASSES, DISCOVERY_ONLY_SOURCE_CLASSES } from '@kynviora/domain';
import type {
  RegulatoryRuleVersion,
  SourceDocument,
  SourceRegistryEntry,
} from './records.js';

/** Outcome of evaluating a candidate against the gate. */
export const GATE_DECISIONS = ['PASSED', 'REJECTED', 'REQUIRES_HUMAN_REVIEW'] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

/** A specific reason a candidate failed or was held. Stable machine codes for dashboards. */
export const GATE_FAILURE_CODES = [
  'MISSING_CANONICAL_IDENTITY',
  'MISSING_JURISDICTION',
  'MISSING_STATUS',
  'MISSING_SOURCE_REGISTRY_ENTRY',
  'SOURCE_NOT_AUTHORIZED_FOR_REGULATORY_STATUS',
  'SOURCE_CLASS_CANNOT_ESTABLISH_LEGAL_STATUS',
  'SOURCE_IS_DISCOVERY_ONLY',
  'SOURCE_LICENSE_NOT_REVIEWED',
  'SOURCE_DISABLED_OR_STALE',
  'MISSING_SOURCE_DOCUMENT',
  'MISSING_CONTENT_CHECKSUM',
  'MISSING_LEGAL_REFERENCE',
  'MISSING_EFFECTIVE_DATE',
  'MISSING_EXTRACTION_VERSION',
  'CONDITIONS_INCOMPLETE_FOR_STATUS',
  'NOT_VERIFIED_AGAINST_OFFICIAL_SOURCE',
  'REVIEW_NOT_COMPLETED',
  'REVIEWER_NOT_RECORDED',
  'SUPERSEDED',
] as const;
export type GateFailureCode = (typeof GATE_FAILURE_CODES)[number];

export interface CitationGateResult {
  readonly decision: GateDecision;
  readonly failures: readonly GateFailureCode[];
  /** Checks that passed, retained so a reviewer can see what was actually verified. */
  readonly satisfied: readonly string[];
  readonly evaluatedAt: Instant;
}

export interface CitationGateInput {
  readonly candidate: RegulatoryRuleVersion;
  readonly source: SourceRegistryEntry | null;
  readonly document: SourceDocument | null;
  readonly evaluatedAt: Instant;
}

/**
 * Statuses whose meaning depends on a condition that must therefore be present.
 *
 * Publishing `CONCENTRATION_LIMIT` with no threshold, or `AGE_OR_ROUTE_CONDITION` with no age or
 * route, would render as a bare restriction with no way for a user to understand what it
 * requires - the "restricted shown as banned" simplification `24` blocks release for.
 */
const CONDITION_DEPENDENT_STATUSES = {
  CONCENTRATION_LIMIT: (c: RegulatoryRuleVersion['conditions']): boolean =>
    c.maxConcentrationPercent !== undefined || c.minConcentrationPercent !== undefined,
  AGE_OR_ROUTE_CONDITION: (c: RegulatoryRuleVersion['conditions']): boolean =>
    c.minimumAgeYears !== undefined ||
    (c.prohibitedRoutes !== undefined && c.prohibitedRoutes.length > 0),
  USE_CONDITION: (c: RegulatoryRuleVersion['conditions']): boolean =>
    (c.productUseTypes !== undefined && c.productUseTypes.length > 0) ||
    (c.productCategories !== undefined && c.productCategories.length > 0),
  WARNING_REQUIRED: (c: RegulatoryRuleVersion['conditions']): boolean =>
    c.requiredWarningText !== undefined && c.requiredWarningText.trim().length > 0,
} as const;

/**
 * Evaluate a candidate regulatory rule against the Citation Gate.
 *
 * Pure and deterministic, so a rejection can be reproduced exactly during an incident review.
 */
export function evaluateCitationGate(input: CitationGateInput): CitationGateResult {
  const { candidate, source, document, evaluatedAt } = input;
  const failures: GateFailureCode[] = [];
  const satisfied: string[] = [];

  // --- Canonical identity -------------------------------------------------
  if (candidate.substanceCanonicalKey.trim().length === 0) {
    failures.push('MISSING_CANONICAL_IDENTITY');
  } else {
    satisfied.push('canonical_identity');
  }

  // --- Jurisdiction --------------------------------------------------------
  // Not merely presence: an absent jurisdiction would let a rule apply everywhere, which is how
  // a GB status could silently appear under NI (`23` D-013).
  if (!candidate.jurisdiction) {
    failures.push('MISSING_JURISDICTION');
  } else {
    satisfied.push('jurisdiction');
  }

  // --- Status --------------------------------------------------------------
  if (candidate.statuses.length === 0) {
    failures.push('MISSING_STATUS');
  } else {
    satisfied.push('status');
  }

  // --- Source authority ----------------------------------------------------
  if (!source) {
    failures.push('MISSING_SOURCE_REGISTRY_ENTRY');
  } else {
    if (!source.allowedInfluence.includes('REGULATORY_STATUS')) {
      failures.push('SOURCE_NOT_AUTHORIZED_FOR_REGULATORY_STATUS');
    } else {
      satisfied.push('source_authorized_for_regulatory_status');
    }

    if (DISCOVERY_ONLY_SOURCE_CLASSES.includes(source.sourceClass)) {
      // `17`: "Their answer text is not a Kynviora source." A search or LLM result can locate an
      // official document but can never itself be cited as one.
      failures.push('SOURCE_IS_DISCOVERY_ONLY');
    }

    if (!LEGAL_STATUS_SOURCE_CLASSES.includes(source.sourceClass)) {
      // `25`: an informational database may help normalize names, but the binding annex or
      // regulation determines legal status.
      failures.push('SOURCE_CLASS_CANNOT_ESTABLISH_LEGAL_STATUS');
    } else {
      satisfied.push('source_class_can_establish_legal_status');
    }

    if (source.licenseReviewState === 'NOT_REVIEWED' || source.licenseReviewState === 'PROHIBITED') {
      failures.push('SOURCE_LICENSE_NOT_REVIEWED');
    } else {
      satisfied.push('source_license_reviewed');
    }

    if (source.status === 'DISABLED' || source.status === 'STALE') {
      // `09` requires publication policy to define what happens when a source needed for a
      // current claim is stale. Publishing from a stale source would assert currency the source
      // cannot support.
      failures.push('SOURCE_DISABLED_OR_STALE');
    } else {
      satisfied.push('source_healthy');
    }
  }

  // --- Traceable source evidence -------------------------------------------
  if (!document) {
    failures.push('MISSING_SOURCE_DOCUMENT');
  } else {
    satisfied.push('source_document');
    if (!/^[0-9a-f]{64}$/.test(document.contentSha256)) {
      failures.push('MISSING_CONTENT_CHECKSUM');
    } else {
      satisfied.push('content_checksum');
    }
  }

  if (!candidate.legalReference || candidate.legalReference.trim().length === 0) {
    failures.push('MISSING_LEGAL_REFERENCE');
  } else {
    satisfied.push('legal_reference');
  }

  // --- Dates ---------------------------------------------------------------
  // An effective date is what makes supersession and the Regulatory Diff meaningful. Without it
  // there is no way to tell whether a rule is current.
  if (!candidate.effectiveDate && !candidate.publicationDate) {
    failures.push('MISSING_EFFECTIVE_DATE');
  } else {
    satisfied.push('effective_or_publication_date');
  }

  // --- Extraction provenance ------------------------------------------------
  if (candidate.extractionVersion.trim().length === 0) {
    failures.push('MISSING_EXTRACTION_VERSION');
  } else {
    satisfied.push('extraction_version');
  }

  // --- Condition completeness ------------------------------------------------
  for (const status of candidate.statuses) {
    const requiresCondition =
      CONDITION_DEPENDENT_STATUSES[status as keyof typeof CONDITION_DEPENDENT_STATUSES];
    if (requiresCondition && !requiresCondition(candidate.conditions)) {
      failures.push('CONDITIONS_INCOMPLETE_FOR_STATUS');
      break;
    }
  }
  if (!failures.includes('CONDITIONS_INCOMPLETE_FOR_STATUS')) {
    satisfied.push('conditions_complete_for_status');
  }

  // --- Verification against an actual official document ----------------------
  // DEC-016. A fact assembled from a search summary is not evidence, however accurate it may
  // turn out to be - that is precisely the standard this gate exists to enforce.
  if (candidate.verification !== 'VERIFIED_AGAINST_OFFICIAL_SOURCE') {
    failures.push('NOT_VERIFIED_AGAINST_OFFICIAL_SOURCE');
  } else {
    satisfied.push('verified_against_official_source');
  }

  // --- Human review ----------------------------------------------------------
  if (candidate.reviewState === 'SUPERSEDED' || candidate.reviewState === 'WITHDRAWN') {
    failures.push('SUPERSEDED');
  }

  if (candidate.reviewState !== 'APPROVED' && candidate.reviewState !== 'PUBLISHED') {
    failures.push('REVIEW_NOT_COMPLETED');
  } else if (!candidate.approvedByReviewerId || !candidate.approvedAt) {
    // `39` of the operating brief and `10` of the spec: engineering must never represent that a
    // qualified review occurred when it did not. An APPROVED state with no named reviewer is
    // exactly that misrepresentation.
    failures.push('REVIEWER_NOT_RECORDED');
  } else {
    satisfied.push('human_review_recorded');
  }

  const decision: GateDecision = failures.length === 0 ? 'PASSED' : 'REJECTED';

  return { decision, failures, satisfied, evaluatedAt };
}

/**
 * Whether a rule may be shown to users as trusted regulatory truth.
 *
 * The only sanctioned way to ask this question. Callers must not re-derive it from
 * `reviewState === 'PUBLISHED'` alone, because that skips source authority, checksum and
 * verification.
 */
export function isPublishable(input: CitationGateInput): boolean {
  return evaluateCitationGate(input).decision === 'PASSED';
}

/**
 * Human-readable explanation of a gate failure, for the reviewer console.
 *
 * Deliberately free of alarm language: a gate rejection is normal operating behaviour, not an
 * incident.
 */
export const GATE_FAILURE_EXPLANATIONS: Readonly<Record<GateFailureCode, string>> = Object.freeze({
  MISSING_CANONICAL_IDENTITY: 'No canonical substance was mapped for this rule.',
  MISSING_JURISDICTION: 'No jurisdiction was recorded.',
  MISSING_STATUS: 'No regulatory status was recorded.',
  MISSING_SOURCE_REGISTRY_ENTRY: 'The candidate is not linked to a registered source.',
  SOURCE_NOT_AUTHORIZED_FOR_REGULATORY_STATUS:
    'The registered source is not authorised to influence regulatory status.',
  SOURCE_CLASS_CANNOT_ESTABLISH_LEGAL_STATUS:
    'Legal status requires primary law or an official action registry. This source class may support identity or context only.',
  SOURCE_IS_DISCOVERY_ONLY:
    'Search and research results can locate official material but cannot be cited as the source.',
  SOURCE_LICENSE_NOT_REVIEWED:
    'Licence and redistribution review has not been completed for this source.',
  SOURCE_DISABLED_OR_STALE: 'The source is disabled or stale, so currency cannot be asserted.',
  MISSING_SOURCE_DOCUMENT: 'No retained source document or reference is linked.',
  MISSING_CONTENT_CHECKSUM: 'The linked source document has no valid content checksum.',
  MISSING_LEGAL_REFERENCE: 'No legal instrument section, annex or notice reference was recorded.',
  MISSING_EFFECTIVE_DATE: 'Neither an effective date nor a publication date was recorded.',
  MISSING_EXTRACTION_VERSION: 'No extraction or parser version was recorded.',
  CONDITIONS_INCOMPLETE_FOR_STATUS:
    'A status that depends on a condition was recorded without that condition, so the rule cannot be displayed accurately.',
  NOT_VERIFIED_AGAINST_OFFICIAL_SOURCE:
    'The candidate has not been verified against a retrieved official document.',
  REVIEW_NOT_COMPLETED: 'Required review has not been completed.',
  REVIEWER_NOT_RECORDED: 'The record is marked approved but no reviewer or approval time is recorded.',
  SUPERSEDED: 'This rule version has been superseded or withdrawn.',
});
