/**
 * Shadow runs, replay, and before/after comparison.
 *
 * Spec references: `04` Phase 6.7, `09` ("Replaying the same versions must reproduce the result"),
 * `10` (shadow-mode result where required; false-positive investigation), `22` (measured
 * validation), `23` D-005/D-006 (no aggregate scoring), `20` (audit without content).
 *
 * EXIT CRITERION 1, AS A SHAPE RATHER THAN A RULE
 * "New high-impact rules can be evaluated without user notification."
 *
 * The tempting implementation is a boolean: run the rule, then check a flag before notifying.
 * That works until the day somebody adds a second notification path, which is how every "we
 * meant not to send that" incident happens. So a shadow run instead produces a value that
 * **nothing can notify from**:
 *
 *  - {@link ShadowRun} carries counts and samples, never a list of people. There is no field
 *    holding profile IDs, so a dispatcher handed a shadow run has nobody to send to.
 *  - {@link ShadowSample} is a projection of an assessment with the profile deliberately removed.
 *    A sample exists so a reviewer can investigate a suspected false positive (`10`), and the
 *    item plus the run is enough for that; the person is not.
 *  - {@link runShadow} refuses a rule that is not in shadow mode, so the function cannot be used
 *    to evaluate a live rule "just to see".
 *
 * A test asserts the absence of a profile-shaped field over the sample's own keys, because the
 * guarantee has to survive somebody adding a field for a good reason.
 *
 * EXIT CRITERION 2
 * "Regulatory data corrections can recompute dependent product views and assessments
 * reproducibly." That is {@link replayAll}: it re-evaluates recorded assessments against
 * re-supplied inputs and reports, per assessment, whether the result reproduced and exactly which
 * fields moved. A correction is not "apply and hope" - it is a diff a person can read before
 * anything reaches a user.
 */

import type { EvidenceLevel, ActionUrgency, Instant, MatchConfidence } from '@kynviora/domain';
import type {
  Assessment,
  AssessmentInputs,
  AssessmentRuleVersion,
  MatchReason,
  OwnedItemSnapshot,
} from './rules.js';
import { evaluateRule } from './rules.js';

// ---------------------------------------------------------------------------
// The dataset a shadow run is evaluated against
// ---------------------------------------------------------------------------

/**
 * One row of the dataset: an item, and everything needed to evaluate a rule against it.
 *
 * The caller assembles this. `04` Phase 6.7 names synthetic and historical datasets, and the
 * difference between them is entirely in who builds the rows - the run itself cannot tell, which
 * is the point: a synthetic dry run and a historical one are the same computation.
 */
export interface ShadowDatasetRow {
  readonly item: OwnedItemSnapshot;
  readonly profileFacts: AssessmentInputs['profileFacts'];
  readonly actionSignals: AssessmentInputs['actionSignals'];
}

export interface ShadowRunRequest {
  readonly rule: AssessmentRuleVersion;
  readonly dataset: readonly ShadowDatasetRow[];
  readonly normalizationVersion: string;
  /** The instant the run is *about*. Supplied, never read from a clock, so a run is replayable. */
  readonly evaluationInstant: Instant;
  /** How many matches to keep for human review. See {@link ShadowRun.samples}. */
  readonly sampleLimit: number;
}

// ---------------------------------------------------------------------------
// What a shadow run produces
// ---------------------------------------------------------------------------

/**
 * One match, projected for human review.
 *
 * Deliberately **not** an {@link Assessment}: an assessment carries `profileId`, and copying it
 * here would put a list of people into the one artefact that must never become a send list. A
 * reviewer investigating a suspected false positive needs the item, the reasons and the rule
 * version (`10`'s false-positive procedure), all of which are here.
 */
export interface ShadowSample {
  readonly ownedItemId: string;
  readonly matched: boolean;
  readonly matchConfidence: MatchConfidence;
  readonly reasons: readonly MatchReason[];
  readonly evidenceLevel: EvidenceLevel;
  readonly urgency: ActionUrgency;
}

/** Field names that must never appear on a sample. Asserted against the type in the tests. */
export const FORBIDDEN_SAMPLE_FIELDS: readonly string[] = Object.freeze([
  'profileId',
  'userId',
  'householdId',
  'email',
  'deviceToken',
  'notify',
]);

export interface ShadowRun {
  readonly ruleId: string;
  readonly ruleVersion: string;

  /** Rows evaluated. Reported so a count of zero matches can be told from an empty dataset. */
  readonly datasetSize: number;
  readonly matchedItems: number;

  /**
   * `04` Phase 6.7's "affected product/formulation counts".
   *
   * Distinct identities and formulations, not rows: ten packs of the same product is one product
   * affected, and a reviewer asked to judge blast radius needs the first number, not the second.
   */
  readonly affectedProducts: number;
  readonly affectedFormulations: number;

  /**
   * `04` Phase 6.7's "potential-user-match counts".
   *
   * A **count**, and the only place in this module where a profile is looked at. The identities
   * are counted and dropped in the same expression, so there is no point at which the run holds a
   * list of people (exit criterion 1).
   */
  readonly potentialUserMatches: number;

  /** How often each reason fired, matched or not. `10`'s false-positive review starts here. */
  readonly reasonCounts: Readonly<Record<string, number>>;

  /**
   * A bounded sample of matches, for human review.
   *
   * Taken in dataset order rather than at random, so two runs over the same dataset produce the
   * same sample and a reviewer can be shown the same rows as their colleague.
   */
  readonly samples: readonly ShadowSample[];

  readonly evaluationInstant: Instant;
  readonly normalizationVersion: string;
}

/**
 * Stands in for an approving reviewer during a shadow evaluation, and names itself as one.
 *
 * Never written to `assessment_rule_version`. A shadow result that somehow reached a table would
 * carry this string, which is not a user ID and does not resemble one.
 */
export const SHADOW_EVALUATION_MARKER = 'SHADOW_RUN_NOT_A_REVIEWER';

/**
 * Evaluate a candidate rule across a dataset without touching anybody.
 *
 * Refuses a rule that is not in shadow mode. That refusal is not defensive coding: a function
 * that would happily evaluate a live rule across the whole estate is one call away from being
 * used to do exactly that, and the assessments it produced would be indistinguishable from real
 * ones.
 */
export function runShadow(request: ShadowRunRequest): ShadowRun {
  const { rule, dataset, normalizationVersion, evaluationInstant, sampleLimit } = request;

  if (!rule.shadowMode) {
    throw new Error(
      'runShadow requires a rule in shadow mode. A live rule evaluated here would produce ' +
        'assessments indistinguishable from real ones (spec 04 Phase 6.7).',
    );
  }

  // WHY THE APPROVAL GATE IS SATISFIED HERE
  // `evaluateRule` refuses an unapproved rule, and it is right to: an unapproved rule producing a
  // match is threat A3's unauthorized publication path. But the rule a shadow run exists to
  // measure is precisely one nobody has approved yet - `04` Phase 6.7 is what a reviewer looks at
  // *before* approving - so evaluating it under the live gate would report zero matches for every
  // candidate. That is the worst possible wrong answer: it reads as "this rule affects nobody".
  //
  // So the projection below satisfies the gate for this evaluation only. It is safe because it is
  // unreachable except through a function that has already refused a non-shadow rule, and because
  // nothing it produces can become user-visible: the results are written to `shadow_run`, which
  // is not `profile_assessment`, and every assessment it yields carries `shadowOnly: true` from
  // the rule's own shadow flag. The marker is deliberately not a real reviewer ID, so a row that
  // somehow escaped would name its own provenance.
  // `enabled` is satisfied for the same reason, and it is the more surprising of the two. A
  // candidate rule has never been enabled, and a rule an operator has just killed under `10`'s
  // emergency controls is exactly the one somebody needs to measure while they work out what it
  // did. Refusing to shadow-run a disabled rule would take the investigation tool away at the
  // moment it is needed, and a shadow run notifies nobody whatever the switch says.
  const forShadowEvaluation: AssessmentRuleVersion = {
    ...rule,
    reviewState: 'APPROVED',
    approvedByReviewerId: SHADOW_EVALUATION_MARKER,
    enabled: true,
  };

  const reasonCounts: Record<string, number> = {};
  const products = new Set<string>();
  const formulations = new Set<string>();
  const profiles = new Set<string>();
  const samples: ShadowSample[] = [];
  let matchedItems = 0;

  for (const row of dataset) {
    const assessment: Assessment = evaluateRule({
      rule: forShadowEvaluation,
      item: row.item,
      profileFacts: row.profileFacts,
      actionSignals: row.actionSignals,
      normalizationVersion,
      evaluationInstant,
    });

    for (const reason of assessment.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }

    if (!assessment.matched) continue;

    matchedItems += 1;
    if (row.item.productIdentityId !== null) products.add(row.item.productIdentityId);
    if (row.item.formulationId !== null) formulations.add(row.item.formulationId);
    // Counted and dropped in one place. The set is local, never returned, and nothing downstream
    // can recover the identities from the number.
    profiles.add(row.item.profileId);

    if (samples.length < sampleLimit) {
      samples.push({
        ownedItemId: assessment.ownedItemId,
        matched: assessment.matched,
        matchConfidence: assessment.matchConfidence,
        reasons: assessment.reasons,
        evidenceLevel: assessment.evidenceLevel,
        urgency: assessment.urgency,
      });
    }
  }

  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    datasetSize: dataset.length,
    matchedItems,
    affectedProducts: products.size,
    affectedFormulations: formulations.size,
    potentialUserMatches: profiles.size,
    reasonCounts: Object.freeze({ ...reasonCounts }),
    samples,
    evaluationInstant,
    normalizationVersion,
  };
}

// ---------------------------------------------------------------------------
// Before / after
// ---------------------------------------------------------------------------

/**
 * How one item's match changed between two runs.
 *
 * `NEWLY_MATCHED` and `NO_LONGER_MATCHED` are the two a reviewer reads first. `URGENCY_CHANGED`
 * is separate from `CONFIDENCE_CHANGED` deliberately: they are different axes and collapsing them
 * into "changed" would hide which one moved.
 */
export const SHADOW_DIFF_KINDS = [
  'NEWLY_MATCHED',
  'NO_LONGER_MATCHED',
  'URGENCY_CHANGED',
  'CONFIDENCE_CHANGED',
  'REASONS_CHANGED',
  'UNCHANGED',
] as const;
export type ShadowDiffKind = (typeof SHADOW_DIFF_KINDS)[number];

export interface ShadowDiffEntry {
  readonly ownedItemId: string;
  readonly kinds: readonly ShadowDiffKind[];
}

export interface ShadowComparison {
  readonly entries: readonly ShadowDiffEntry[];
  readonly newlyMatched: number;
  readonly noLongerMatched: number;
  readonly changed: number;
  readonly unchanged: number;
  /**
   * Items present in one run's samples and not the other.
   *
   * Reported rather than silently skipped: a comparison over two different datasets is usually a
   * mistake, and one that quietly compared the intersection would hide it.
   */
  readonly onlyInBefore: readonly string[];
  readonly onlyInAfter: readonly string[];
}

/**
 * Compare two shadow runs, sample by sample.
 *
 * `04` Phase 6.7's "before/after comparison". Works over the samples rather than the counts,
 * because "twelve more matches" does not tell a reviewer whether the twelve are the ones they
 * were worried about.
 */
export function compareShadowRuns(before: ShadowRun, after: ShadowRun): ShadowComparison {
  const beforeByItem = new Map(before.samples.map((s) => [s.ownedItemId, s]));
  const afterByItem = new Map(after.samples.map((s) => [s.ownedItemId, s]));

  const entries: ShadowDiffEntry[] = [];
  let newlyMatched = 0;
  let noLongerMatched = 0;
  let changed = 0;
  let unchanged = 0;

  for (const [ownedItemId, afterSample] of afterByItem) {
    const beforeSample = beforeByItem.get(ownedItemId);
    if (beforeSample === undefined) continue;

    const kinds: ShadowDiffKind[] = [];
    if (!beforeSample.matched && afterSample.matched) kinds.push('NEWLY_MATCHED');
    if (beforeSample.matched && !afterSample.matched) kinds.push('NO_LONGER_MATCHED');
    if (beforeSample.urgency !== afterSample.urgency) kinds.push('URGENCY_CHANGED');
    if (beforeSample.matchConfidence !== afterSample.matchConfidence) {
      kinds.push('CONFIDENCE_CHANGED');
    }
    if (beforeSample.reasons.join(',') !== afterSample.reasons.join(',')) {
      kinds.push('REASONS_CHANGED');
    }

    if (kinds.length === 0) {
      unchanged += 1;
      entries.push({ ownedItemId, kinds: ['UNCHANGED'] });
      continue;
    }

    if (kinds.includes('NEWLY_MATCHED')) newlyMatched += 1;
    else if (kinds.includes('NO_LONGER_MATCHED')) noLongerMatched += 1;
    else changed += 1;

    entries.push({ ownedItemId, kinds });
  }

  return {
    entries,
    newlyMatched,
    noLongerMatched,
    changed,
    unchanged,
    onlyInBefore: [...beforeByItem.keys()].filter((id) => !afterByItem.has(id)),
    onlyInAfter: [...afterByItem.keys()].filter((id) => !beforeByItem.has(id)),
  };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayEntry {
  readonly ownedItemId: string;
  readonly reproduced: boolean;
  /** Which fields moved. Empty when the assessment reproduced exactly. */
  readonly differences: readonly string[];
}

export interface ReplayReport {
  readonly entries: readonly ReplayEntry[];
  readonly total: number;
  readonly reproduced: number;
  readonly changed: number;
  /**
   * Whether every assessment reproduced.
   *
   * The question `09` actually asks. A recomputation where nothing moved means the correction
   * had no effect on what anybody was told, which is the common and reassuring case.
   */
  readonly fullyReproduced: boolean;
  /** How often each field moved, so a correction's shape is visible at a glance. */
  readonly differenceCounts: Readonly<Record<string, number>>;
}

/**
 * Re-evaluate recorded assessments against re-supplied inputs.
 *
 * `04` Phase 6.7: "replay after source/rule/normalization change" and "Regulatory data
 * corrections can recompute dependent product views and assessments reproducibly."
 *
 * The caller supplies the inputs, because what changed - a source document, a rule version, a
 * normalization table - determines what the new inputs are, and this function must not guess.
 * Passing the same inputs back reproduces every assessment, which is `09`'s requirement stated as
 * a test rather than a promise.
 */
export function replayAll(
  originals: readonly Assessment[],
  makeInputs: (original: Assessment) => AssessmentInputs,
): ReplayReport {
  const entries: ReplayEntry[] = [];
  const differenceCounts: Record<string, number> = {};
  let reproduced = 0;

  for (const original of originals) {
    const recomputed = evaluateRule(makeInputs(original));
    const differences: string[] = [];

    if (recomputed.matched !== original.matched) differences.push('matched');
    if (recomputed.matchConfidence !== original.matchConfidence) {
      differences.push('matchConfidence');
    }
    if (recomputed.urgency !== original.urgency) differences.push('urgency');
    if (recomputed.evidenceLevel !== original.evidenceLevel) differences.push('evidenceLevel');
    if (recomputed.reasons.join(',') !== original.reasons.join(',')) differences.push('reasons');
    if (recomputed.explanationTemplateId !== original.explanationTemplateId) {
      differences.push('explanationTemplateId');
    }

    for (const field of differences) {
      differenceCounts[field] = (differenceCounts[field] ?? 0) + 1;
    }
    if (differences.length === 0) reproduced += 1;

    entries.push({
      ownedItemId: original.ownedItemId,
      reproduced: differences.length === 0,
      differences,
    });
  }

  return {
    entries,
    total: originals.length,
    reproduced,
    changed: originals.length - reproduced,
    fullyReproduced: reproduced === originals.length,
    differenceCounts: Object.freeze({ ...differenceCounts }),
  };
}

// ---------------------------------------------------------------------------
// What a shadow run is allowed to conclude
// ---------------------------------------------------------------------------

/**
 * A shadow run measures; it does not decide.
 *
 * There is deliberately no `recommendPublication`, no pass/fail threshold and no score. `22`
 * requires release thresholds to be defined by leadership against a labelled dataset, and
 * `BLK-008` records that none exists. A function here returning "safe to publish" would be
 * inventing the threshold that document says nobody has set, and a reviewer would read it as an
 * answer.
 *
 * The run's numbers go to a person. That is the whole design.
 */
export const SHADOW_RUN_DOES_NOT_RECOMMEND = true;
