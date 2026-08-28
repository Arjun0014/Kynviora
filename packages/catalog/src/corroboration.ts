/**
 * Catalog corroboration policy.
 *
 * Spec references: `08` "Independent corroboration" and "Living Catalog lifecycle",
 * `15` A11 (catalog poisoning), `19` (corroboration false-positive testing).
 *
 * WHAT CORROBORATION MEANS
 * `08`: "Repeated observations can verify **what labels/packages say**. They cannot determine
 * health safety." This module advances a formulation's evidence quality. Nothing here can, or
 * should, influence a safety conclusion - that lives entirely in `@kynviora/safety` behind
 * reviewed rules.
 *
 * THREAT MODEL (A11)
 * An attacker submitting many observations - through duplicate accounts, the same device, or
 * re-uploads of one image - must not be able to promote an incorrect formulation. The policy
 * therefore counts *independent groups*, not raw observations, and refuses to count duplicates
 * detected by content or perceptual hash.
 *
 * `08` also forbids exposing "a fake mathematical certainty score simply because many users
 * submitted the same record", so this returns a lifecycle state and the evidence behind it, not
 * a percentage.
 */

import type { CatalogCorroboration, Instant } from '@kynviora/domain';
import { compareInstants } from '@kynviora/domain';

/** One observation considered for corroboration. */
export interface ObservationEvidence {
  readonly observationId: string;
  /**
   * Opaque grouping key for judging independence - derived from contributor and device, hashed
   * by the caller. Two observations sharing a group are never independent of each other.
   */
  readonly contributionGroupHash: string | null;
  /** Exact content hash of the source image, for detecting literal re-uploads. */
  readonly assetSha256: string | null;
  /** Perceptual hash, for detecting a lightly-edited or recompressed re-upload. */
  readonly assetPerceptualHash: string | null;
  readonly observedAt: Instant;
  readonly market: string;
  /** Whether the contributing user confirmed the material fields on this observation. */
  readonly humanConfirmed: boolean;
}

/** Evidence from an approved external source, which outranks accumulated observations. */
export interface ExternalVerification {
  readonly sourceClass: 'MANUFACTURER_EVIDENCE' | 'APPROVED_PROVIDER' | 'OFFICIAL_SOURCE';
  readonly verifiedAt: Instant;
}

export interface CorroborationPolicy {
  /** Independent groups required before a candidate becomes CORROBORATED. */
  readonly minIndependentGroups: number;
  /** Minimum spacing between two observations for them to count as independent evidence. */
  readonly minObservationSpacingMs: number;
}

/**
 * Default policy.
 *
 * Three independent groups rather than two: with two, a single attacker operating one duplicate
 * account reaches the threshold. Three forces at least three separate contribution groups, which
 * combined with duplicate-asset rejection makes cheap promotion substantially harder.
 *
 * These are **engineering defaults, not approved product thresholds**. `23` lists corroboration
 * policy as a decision required before Stage 3 completion, and it needs product and data-safety
 * sign-off before any public claim rests on it.
 */
export const DEFAULT_CORROBORATION_POLICY: CorroborationPolicy = Object.freeze({
  minIndependentGroups: 3,
  minObservationSpacingMs: 60_000,
});

export interface CorroborationAssessment {
  readonly state: CatalogCorroboration;
  /** Observations remaining after duplicate and non-independence filtering. */
  readonly independentGroupCount: number;
  readonly totalObservationCount: number;
  readonly rejectedDuplicateCount: number;
  /** Non-sensitive machine reason, safe for operator dashboards (`20`). */
  readonly reasonCode: string;
  /**
   * Whether suspicious submission patterns were detected.
   *
   * Surfaced for operational alerting (`20`: "Alert on abnormal spikes that could indicate
   * parser/model regression, coordinated poisoning, provider change, or abuse-driven cost").
   */
  readonly suspiciousPattern: boolean;
}

/**
 * Assess a formulation's corroboration state from its observations.
 *
 * Pure and deterministic: the same observations always yield the same state, so a reviewer
 * investigating a promotion can reproduce the decision exactly.
 *
 * @param hasUnresolvedConflict - when a conflict is open, the formulation is CONFLICTING
 *        regardless of observation count. `08` requires "conflict state instead of majority-vote
 *        overwrite", so volume must never resolve a disagreement.
 */
export function assessCorroboration(
  observations: readonly ObservationEvidence[],
  options: {
    readonly policy?: CorroborationPolicy;
    readonly externalVerification?: ExternalVerification | null;
    readonly hasUnresolvedConflict?: boolean;
    readonly isRetired?: boolean;
  } = {},
): CorroborationAssessment {
  const policy = options.policy ?? DEFAULT_CORROBORATION_POLICY;

  if (options.isRetired === true) {
    return {
      state: 'RETIRED',
      independentGroupCount: 0,
      totalObservationCount: observations.length,
      rejectedDuplicateCount: 0,
      reasonCode: 'retired',
      suspiciousPattern: false,
    };
  }

  // An open conflict dominates. Crowd volume must not vote a disagreement away.
  if (options.hasUnresolvedConflict === true) {
    return {
      state: 'CONFLICTING',
      independentGroupCount: 0,
      totalObservationCount: observations.length,
      rejectedDuplicateCount: 0,
      reasonCode: 'unresolved_conflict',
      suspiciousPattern: false,
    };
  }

  if (observations.length === 0) {
    return {
      state: 'CANDIDATE',
      independentGroupCount: 0,
      totalObservationCount: 0,
      rejectedDuplicateCount: 0,
      reasonCode: 'no_observations',
      suspiciousPattern: false,
    };
  }

  // Reject duplicates: the same image re-uploaded, or a perceptually identical variant.
  const seenExactHashes = new Set<string>();
  const seenPerceptualHashes = new Set<string>();
  const deduplicated: ObservationEvidence[] = [];
  let rejectedDuplicateCount = 0;

  // Sort oldest-first so the earliest submission is kept and later copies are the rejects.
  const chronological = [...observations].sort((a, b) =>
    compareInstants(a.observedAt, b.observedAt),
  );

  for (const observation of chronological) {
    const exact = observation.assetSha256;
    const perceptual = observation.assetPerceptualHash;

    if (exact !== null && seenExactHashes.has(exact)) {
      rejectedDuplicateCount += 1;
      continue;
    }
    if (perceptual !== null && seenPerceptualHashes.has(perceptual)) {
      rejectedDuplicateCount += 1;
      continue;
    }

    if (exact !== null) seenExactHashes.add(exact);
    if (perceptual !== null) seenPerceptualHashes.add(perceptual);
    deduplicated.push(observation);
  }

  // Count independent contribution groups. An observation with no group hash cannot be shown to
  // be independent of anything, so it is counted conservatively as its own group only when it
  // was human-confirmed; otherwise it does not contribute to promotion.
  const groups = new Map<string, ObservationEvidence[]>();
  for (const observation of deduplicated) {
    const key = observation.contributionGroupHash ?? `anonymous:${observation.observationId}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(observation);
    else groups.set(key, [observation]);
  }

  const qualifyingGroups = [...groups.values()].filter((bucket) => {
    // A group qualifies if at least one of its observations was human-confirmed. An unconfirmed
    // machine reading is not evidence a human ever checked the package (`17`).
    if (!bucket.some((o) => o.humanConfirmed)) return false;

    // Rapid-fire submissions inside one group indicate scripted contribution, not independent
    // real-world observation.
    if (bucket.length > 1) {
      const sorted = [...bucket].sort((a, b) => compareInstants(a.observedAt, b.observedAt));
      for (let i = 1; i < sorted.length; i++) {
        const gap = Date.parse(sorted[i]!.observedAt) - Date.parse(sorted[i - 1]!.observedAt);
        if (gap < policy.minObservationSpacingMs) {
          // The group still counts once; the burst just does not multiply its weight.
          break;
        }
      }
    }
    return true;
  });

  const independentGroupCount = qualifyingGroups.length;

  // Flag patterns worth an operator's attention. This does not change the state - it is a signal
  // for the abuse dashboards required by `20`.
  const suspiciousPattern =
    rejectedDuplicateCount > 0 &&
    rejectedDuplicateCount >= Math.max(2, Math.floor(observations.length / 2));

  // Approved external evidence outranks accumulated observations (`08` source progression).
  if (options.externalVerification) {
    return {
      state: 'EXTERNALLY_VERIFIED',
      independentGroupCount,
      totalObservationCount: observations.length,
      rejectedDuplicateCount,
      reasonCode: `external_${options.externalVerification.sourceClass.toLowerCase()}`,
      suspiciousPattern,
    };
  }

  if (independentGroupCount >= policy.minIndependentGroups) {
    return {
      state: 'CORROBORATED',
      independentGroupCount,
      totalObservationCount: observations.length,
      rejectedDuplicateCount,
      reasonCode: 'independent_groups_threshold_met',
      suspiciousPattern,
    };
  }

  if (independentGroupCount >= 1) {
    return {
      state: 'USER_CONFIRMED',
      independentGroupCount,
      totalObservationCount: observations.length,
      rejectedDuplicateCount,
      reasonCode: 'human_confirmed_below_threshold',
      suspiciousPattern,
    };
  }

  return {
    state: 'CANDIDATE',
    independentGroupCount: 0,
    totalObservationCount: observations.length,
    rejectedDuplicateCount,
    reasonCode: 'no_human_confirmed_independent_observation',
    suspiciousPattern,
  };
}
