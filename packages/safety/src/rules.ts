/**
 * Deterministic safety rule engine.
 *
 * Spec references: `04` Phase 6.5, `09` "Safety assessment pipeline", `10` (rule authoring),
 * `17` (AI may not set severity), `23` D-006, `24` (safety done criteria).
 *
 * THE CENTRAL GUARANTEE
 * `09`: "Replaying the same versions must reproduce the result."
 *
 * Every rule is a pure function of explicitly versioned inputs. There is no clock read, no
 * randomness, no network call, and no model invocation anywhere in evaluation. The engine takes
 * an `AssessmentInputs` bundle that names the exact version of every fact it used, and returns an
 * assessment that carries those versions forward - so an assessment produced months ago can be
 * recomputed byte-for-byte during an incident investigation.
 *
 * WHAT THIS ENGINE MAY NOT DO
 * `17` forbids AI from setting evidence level or action urgency. Those come from the **rule
 * definition**, which a human authored and reviewed (`10`), never from evaluation logic and never
 * from a model. The engine's job is to decide whether a rule *matches*; the rule itself already
 * carries its allowed evidence level, urgency ceiling and explanation template.
 */

import type {
  ActionUrgency,
  EvidenceLevel,
  Instant,
  ItemVerification,
  MatchConfidence,
  ProvenanceKind,
  ReviewState,
} from '@kynviora/domain';

/** Rule categories in MVP scope (`09` "MVP Safety Watch signal types"). */
export const RULE_KINDS = [
  'PRODUCT_ACTION_MATCH',
  'BATCH_ACTION_MATCH',
  'EXPIRY',
  'INGREDIENT_SENSITIVITY',
  'DUPLICATE_ACTIVE_INGREDIENT',
  'FORMULATION_CHANGE_REVIEW',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/**
 * An immutable, human-authored rule version.
 *
 * `10` requires every rule to declare its population, required provenance, matching criteria,
 * exclusions, evidence classification, allowed urgency, allowed action language, limitations,
 * reviewers and test fixtures. Those are fields here, not conventions.
 */
export interface AssessmentRuleVersion {
  readonly id: string;
  readonly kind: RuleKind;
  readonly version: string;

  /**
   * Evidence level this rule's conclusions carry.
   *
   * Set by the rule author and reviewer. Evaluation never computes or adjusts it (`23` D-005).
   */
  readonly evidenceLevel: EvidenceLevel;

  /**
   * The **maximum** urgency this rule may ever produce.
   *
   * A ceiling rather than a fixed value, so a rule can produce a lower urgency in a weaker match
   * but can never exceed what a reviewer approved. `12` forbids the client independently
   * upgrading severity; this enforces the same discipline server-side.
   */
  readonly maxUrgency: ActionUrgency;

  /**
   * Minimum item verification the rule requires before it may fire.
   *
   * `02`: "Low-confidence OCR, inferred ingredients, ambiguous barcodes, and uncertain medicine
   * matches must be confirmed before they drive high-impact personalization."
   */
  readonly requiredItemVerification: readonly ItemVerification[];

  /** Provenance levels a profile fact must have for this rule to rely on it (`04` Phase 1.3). */
  readonly requiredProfileProvenance: readonly ProvenanceKind[];

  /** Identifier of the approved wording template (`09`, `18`). */
  readonly explanationTemplateId: string;

  readonly reviewState: ReviewState;
  readonly approvedByReviewerId: string | null;
  readonly approvedAt: Instant | null;

  /**
   * Shadow mode: the rule evaluates and records results but produces no user-visible alert.
   *
   * `04` Phase 6.7 requires new high-impact rules to be evaluable without user notification.
   */
  readonly shadowMode: boolean;

  /** Operator kill switch (`10` emergency controls, `21` feature flags). */
  readonly enabled: boolean;
}

/** A profile fact the engine may consult. */
export interface ProfileFact {
  readonly id: string;
  readonly kind: 'ALLERGY' | 'SENSITIVITY' | 'CONDITION';
  /** Canonical substance key when normalized; null when only free text is recorded. */
  readonly substanceCanonicalKey: string | null;
  readonly displayTerm: string;
  readonly provenance: ProvenanceKind;
  readonly recordedAt: Instant;
  /** Version of this fact, carried into the assessment for replay. */
  readonly version: string;
}

/** The exact item state an assessment was computed against. */
export interface OwnedItemSnapshot {
  readonly ownedItemId: string;
  readonly profileId: string;
  readonly productIdentityId: string | null;
  readonly formulationId: string | null;
  readonly formulationVersion: string | null;
  readonly batchId: string | null;
  readonly lotCode: string | null;
  readonly gtin: string | null;
  readonly expiresOn: string | null;

  readonly identityVerification: ItemVerification;
  readonly formulationVerification: ItemVerification;
  readonly batchVerification: ItemVerification;

  /** Canonical substance keys in the confirmed declaration. */
  readonly substanceKeys: readonly string[];
  readonly isActive: boolean;
}

/** An official action the engine may match against. */
export interface ActionSignal {
  readonly id: string;
  readonly version: string;
  readonly gtin: string | null;
  readonly formulationId: string | null;
  readonly batchCodes: readonly string[];
  readonly summary: string;
}

/**
 * Everything an evaluation consumed, by exact version.
 *
 * `09` requires assessments to "Store exact references to profile facts, owned item,
 * product/formulation/batch, source/evidence, regulatory record, rule, normalization version".
 * Bundling them into one input object means replay is a matter of re-supplying this record.
 */
export interface AssessmentInputs {
  readonly rule: AssessmentRuleVersion;
  readonly item: OwnedItemSnapshot;
  readonly profileFacts: readonly ProfileFact[];
  readonly actionSignals: readonly ActionSignal[];
  readonly normalizationVersion: string;
  /**
   * The instant the assessment is *about*, supplied by the caller rather than read from a clock.
   *
   * Passing it in is what makes expiry evaluation replayable: recomputing a past assessment must
   * use the date it was computed for, not today.
   */
  readonly evaluationInstant: Instant;
}

/** Why a rule matched, or why it did not. Stable machine codes. */
export const MATCH_REASONS = [
  'BATCH_CODE_MATCHED',
  'GTIN_MATCHED_BATCH_UNKNOWN',
  'FORMULATION_MATCHED',
  'SUBSTANCE_IN_DECLARATION',
  'PRODUCT_EXPIRED',
  'PRODUCT_EXPIRING_SOON',
  'NO_SIGNAL_MATCHED',
  'ITEM_NOT_ACTIVE',
  'RULE_DISABLED',
  'RULE_NOT_APPROVED',
  'INSUFFICIENT_ITEM_VERIFICATION',
  'INSUFFICIENT_PROFILE_PROVENANCE',
  'NO_ELIGIBLE_PROFILE_FACT',
  'NO_EXPIRY_RECORDED',
  'MISSING_REQUIRED_IDENTIFIERS',
] as const;
export type MatchReason = (typeof MATCH_REASONS)[number];

/** The result of evaluating one rule against one item. */
export interface Assessment {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly ownedItemId: string;
  readonly profileId: string;

  readonly matched: boolean;
  readonly matchConfidence: MatchConfidence;
  readonly reasons: readonly MatchReason[];

  /** Copied from the rule. Never computed, never adjusted by evaluation (`23` D-005/D-006). */
  readonly evidenceLevel: EvidenceLevel;
  readonly urgency: ActionUrgency;

  readonly explanationTemplateId: string;

  /** Exact input versions, so this assessment can be reproduced (`09`). */
  readonly inputVersions: {
    readonly formulationVersion: string | null;
    readonly normalizationVersion: string;
    readonly profileFactVersions: readonly string[];
    readonly actionSignalVersions: readonly string[];
  };

  /** True when the rule ran in shadow mode and must not produce a user-visible alert. */
  readonly shadowOnly: boolean;

  readonly evaluatedAt: Instant;
}

/** Days before expiry at which the expiry rule begins to fire. */
export const EXPIRY_WARNING_WINDOW_DAYS = 30;

/**
 * Evaluate one rule against one item.
 *
 * Pure. Given identical `AssessmentInputs`, always returns an identical `Assessment`.
 */
export function evaluateRule(inputs: AssessmentInputs): Assessment {
  const { rule, item, profileFacts, actionSignals, normalizationVersion, evaluationInstant } =
    inputs;

  const base = {
    ruleId: rule.id,
    ruleVersion: rule.version,
    ownedItemId: item.ownedItemId,
    profileId: item.profileId,
    evidenceLevel: rule.evidenceLevel,
    explanationTemplateId: rule.explanationTemplateId,
    inputVersions: {
      formulationVersion: item.formulationVersion,
      normalizationVersion,
      profileFactVersions: profileFacts.map((f) => f.version),
      actionSignalVersions: actionSignals.map((s) => s.version),
    },
    shadowOnly: rule.shadowMode,
    evaluatedAt: evaluationInstant,
  };

  const noMatch = (reason: MatchReason): Assessment => ({
    ...base,
    matched: false,
    matchConfidence: 'NOT_MATCHED',
    reasons: [reason],
    // A non-match carries no urgency. Deliberately INFORMATIONAL rather than the rule's ceiling.
    urgency: 'INFORMATIONAL',
  });

  // --- Gates that apply to every rule -------------------------------------

  if (!rule.enabled) return noMatch('RULE_DISABLED');

  // `10` requires human approval before a rule influences users. An unapproved rule evaluating
  // to a match would be exactly the unauthorized publication path `15` A3 describes.
  if (rule.reviewState !== 'APPROVED' && rule.reviewState !== 'PUBLISHED') {
    return noMatch('RULE_NOT_APPROVED');
  }
  if (!rule.approvedByReviewerId) return noMatch('RULE_NOT_APPROVED');

  if (!item.isActive) return noMatch('ITEM_NOT_ACTIVE');

  // --- Rule-specific evaluation -------------------------------------------

  switch (rule.kind) {
    case 'BATCH_ACTION_MATCH':
      return evaluateBatchAction(base, rule, item, actionSignals);
    case 'PRODUCT_ACTION_MATCH':
      return evaluateProductAction(base, rule, item, actionSignals);
    case 'EXPIRY':
      return evaluateExpiry(base, rule, item, evaluationInstant);
    case 'INGREDIENT_SENSITIVITY':
      return evaluateIngredientSensitivity(base, rule, item, profileFacts);
    case 'DUPLICATE_ACTIVE_INGREDIENT':
    case 'FORMULATION_CHANGE_REVIEW':
      // Not yet implemented as reviewed rules. `09` requires the duplicate-active rule to have
      // validated reference data and clinical review before it may exist at all (`BLK-006`), so
      // returning a non-match is the correct conservative behaviour rather than a placeholder
      // that could fire.
      return noMatch('NO_SIGNAL_MATCHED');
  }
}

type AssessmentBase = Omit<Assessment, 'matched' | 'matchConfidence' | 'reasons' | 'urgency'>;

/**
 * Batch-scoped official action.
 *
 * The `31` fixture scenario: only matching batches are affected. A GTIN match with no recorded
 * lot code is `PROBABLE`, never `EXACT` - the user may well hold an unaffected batch, and
 * claiming certainty would produce exactly the false alarm `22` tracks as a guardrail.
 */
function evaluateBatchAction(
  base: AssessmentBase,
  rule: AssessmentRuleVersion,
  item: OwnedItemSnapshot,
  signals: readonly ActionSignal[],
): Assessment {
  if (!item.gtin && !item.formulationId) {
    return {
      ...base,
      matched: false,
      matchConfidence: 'NOT_MATCHED',
      reasons: ['MISSING_REQUIRED_IDENTIFIERS'],
      urgency: 'INFORMATIONAL',
    };
  }

  for (const signal of signals) {
    const productMatches =
      (signal.gtin !== null && item.gtin !== null && signal.gtin === item.gtin) ||
      (signal.formulationId !== null && signal.formulationId === item.formulationId);

    if (!productMatches) continue;

    if (item.lotCode !== null) {
      const lotMatches = signal.batchCodes.some(
        (code) => normalizeLot(code) === normalizeLot(item.lotCode!),
      );

      if (lotMatches) {
        // Exact: the user's recorded lot is named in the action.
        if (!rule.requiredItemVerification.includes(item.batchVerification)) {
          return {
            ...base,
            matched: false,
            matchConfidence: 'NOT_MATCHED',
            reasons: ['INSUFFICIENT_ITEM_VERIFICATION'],
            urgency: 'INFORMATIONAL',
          };
        }
        return {
          ...base,
          matched: true,
          matchConfidence: 'EXACT',
          reasons: ['BATCH_CODE_MATCHED'],
          urgency: rule.maxUrgency,
        };
      }

      // The lot is recorded and is NOT in the action's list, so this pack is not affected.
      // Reporting a match here would be a false positive on data we actually have.
      continue;
    }

    // Product matches but no lot is recorded: cannot confirm this specific pack.
    return {
      ...base,
      matched: true,
      matchConfidence: 'PROBABLE',
      reasons: ['GTIN_MATCHED_BATCH_UNKNOWN'],
      urgency: downgradeUrgency(rule.maxUrgency),
    };
  }

  return {
    ...base,
    matched: false,
    matchConfidence: 'NOT_MATCHED',
    reasons: ['NO_SIGNAL_MATCHED'],
    urgency: 'INFORMATIONAL',
  };
}

/** Product-level action with no batch scoping. */
function evaluateProductAction(
  base: AssessmentBase,
  rule: AssessmentRuleVersion,
  item: OwnedItemSnapshot,
  signals: readonly ActionSignal[],
): Assessment {
  if (!rule.requiredItemVerification.includes(item.identityVerification)) {
    return {
      ...base,
      matched: false,
      matchConfidence: 'NOT_MATCHED',
      reasons: ['INSUFFICIENT_ITEM_VERIFICATION'],
      urgency: 'INFORMATIONAL',
    };
  }

  for (const signal of signals) {
    if (signal.formulationId !== null && signal.formulationId === item.formulationId) {
      return {
        ...base,
        matched: true,
        matchConfidence: 'EXACT',
        reasons: ['FORMULATION_MATCHED'],
        urgency: rule.maxUrgency,
      };
    }
    if (signal.gtin !== null && item.gtin !== null && signal.gtin === item.gtin) {
      return {
        ...base,
        matched: true,
        matchConfidence: 'PROBABLE',
        reasons: ['GTIN_MATCHED_BATCH_UNKNOWN'],
        urgency: downgradeUrgency(rule.maxUrgency),
      };
    }
  }

  return {
    ...base,
    matched: false,
    matchConfidence: 'NOT_MATCHED',
    reasons: ['NO_SIGNAL_MATCHED'],
    urgency: 'INFORMATIONAL',
  };
}

/** Expiry, evaluated against the supplied instant so replay is stable. */
function evaluateExpiry(
  base: AssessmentBase,
  rule: AssessmentRuleVersion,
  item: OwnedItemSnapshot,
  evaluationInstant: Instant,
): Assessment {
  if (item.expiresOn === null) {
    return {
      ...base,
      matched: false,
      matchConfidence: 'NOT_MATCHED',
      reasons: ['NO_EXPIRY_RECORDED'],
      urgency: 'INFORMATIONAL',
    };
  }

  const expiryMs = Date.parse(`${item.expiresOn}T00:00:00.000Z`);
  const nowMs = Date.parse(evaluationInstant);
  const daysUntil = Math.floor((expiryMs - nowMs) / 86_400_000);

  if (daysUntil < 0) {
    return {
      ...base,
      matched: true,
      matchConfidence: 'EXACT',
      reasons: ['PRODUCT_EXPIRED'],
      urgency: rule.maxUrgency,
    };
  }

  if (daysUntil <= EXPIRY_WARNING_WINDOW_DAYS) {
    return {
      ...base,
      matched: true,
      matchConfidence: 'EXACT',
      reasons: ['PRODUCT_EXPIRING_SOON'],
      urgency: downgradeUrgency(rule.maxUrgency),
    };
  }

  return {
    ...base,
    matched: false,
    matchConfidence: 'NOT_MATCHED',
    reasons: ['NO_SIGNAL_MATCHED'],
    urgency: 'INFORMATIONAL',
  };
}

/**
 * Reviewed ingredient sensitivity.
 *
 * `06` Journey 4 requires the alert to identify the exact ingredient and why the rule applies,
 * and `09` requires the formulation to be sufficiently verified first - an unverified formula
 * driving an allergy alert is threat A5.
 */
function evaluateIngredientSensitivity(
  base: AssessmentBase,
  rule: AssessmentRuleVersion,
  item: OwnedItemSnapshot,
  profileFacts: readonly ProfileFact[],
): Assessment {
  if (!rule.requiredItemVerification.includes(item.formulationVerification)) {
    return {
      ...base,
      matched: false,
      matchConfidence: 'NOT_MATCHED',
      reasons: ['INSUFFICIENT_ITEM_VERIFICATION'],
      urgency: 'INFORMATIONAL',
    };
  }

  // Only normalized facts with adequate provenance may drive personalization.
  const eligible = profileFacts.filter(
    (f) =>
      (f.kind === 'ALLERGY' || f.kind === 'SENSITIVITY') &&
      f.substanceCanonicalKey !== null &&
      rule.requiredProfileProvenance.includes(f.provenance),
  );

  if (eligible.length === 0) {
    const anyRelevant = profileFacts.some((f) => f.kind === 'ALLERGY' || f.kind === 'SENSITIVITY');
    return {
      ...base,
      matched: false,
      matchConfidence: 'NOT_MATCHED',
      reasons: [anyRelevant ? 'INSUFFICIENT_PROFILE_PROVENANCE' : 'NO_ELIGIBLE_PROFILE_FACT'],
      urgency: 'INFORMATIONAL',
    };
  }

  const declared = new Set(item.substanceKeys);
  const hit = eligible.find((f) => declared.has(f.substanceCanonicalKey!));

  if (!hit) {
    return {
      ...base,
      matched: false,
      matchConfidence: 'NOT_MATCHED',
      reasons: ['NO_SIGNAL_MATCHED'],
      urgency: 'INFORMATIONAL',
    };
  }

  return {
    ...base,
    matched: true,
    matchConfidence: 'EXACT',
    reasons: ['SUBSTANCE_IN_DECLARATION'],
    urgency: rule.maxUrgency,
    inputVersions: { ...base.inputVersions, profileFactVersions: [hit.version] },
  };
}

/**
 * Reduce urgency by one step for a less certain match.
 *
 * Only ever lowers. There is deliberately no `upgradeUrgency`: `12` forbids the client
 * independently raising severity, and `17` forbids anything other than a reviewed rule setting
 * it. A rule's `maxUrgency` is a ceiling that evaluation can move away from but never exceed.
 */
export function downgradeUrgency(urgency: ActionUrgency): ActionUrgency {
  switch (urgency) {
    case 'CRITICAL':
      return 'HIGH';
    case 'HIGH':
      return 'MEDIUM';
    case 'MEDIUM':
      return 'LOW';
    case 'LOW':
    case 'INFORMATIONAL':
      return 'INFORMATIONAL';
  }
}

function normalizeLot(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Evaluate several rules against one item.
 *
 * Results are returned in rule order and are never aggregated into a combined score - `23` D-005
 * forbids collapsing separate dimensions, and each assessment stands on its own inputs.
 */
export function evaluateRules(
  rules: readonly AssessmentRuleVersion[],
  makeInputs: (rule: AssessmentRuleVersion) => AssessmentInputs,
): readonly Assessment[] {
  return rules.map((rule) => evaluateRule(makeInputs(rule)));
}

/**
 * Replay an assessment from its recorded inputs and confirm it reproduces.
 *
 * `09`: "Replaying the same versions must reproduce the result." `04` Phase 6.7 requires replay
 * after a source, rule or normalization change. This is the mechanism behind both.
 */
export function replayAssessment(
  original: Assessment,
  inputs: AssessmentInputs,
): { reproduced: boolean; recomputed: Assessment; differences: readonly string[] } {
  const recomputed = evaluateRule(inputs);
  const differences: string[] = [];

  if (recomputed.matched !== original.matched) differences.push('matched');
  if (recomputed.matchConfidence !== original.matchConfidence) differences.push('matchConfidence');
  if (recomputed.urgency !== original.urgency) differences.push('urgency');
  if (recomputed.evidenceLevel !== original.evidenceLevel) differences.push('evidenceLevel');
  if (recomputed.reasons.join(',') !== original.reasons.join(',')) differences.push('reasons');
  if (recomputed.explanationTemplateId !== original.explanationTemplateId) {
    differences.push('explanationTemplateId');
  }

  return { reproduced: differences.length === 0, recomputed, differences };
}
