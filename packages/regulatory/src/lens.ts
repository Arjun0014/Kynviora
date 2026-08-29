/**
 * Global Regulatory Lens projection.
 *
 * Spec references: `09` "Global Regulatory Lens", `06` Journey 12, `07.2`, `24` (Lens done
 * criteria), `22` (misleading-simplification guardrail).
 *
 * WHAT THIS PRODUCES
 * A per-jurisdiction view of how monitored sources treat a substance in a specific product
 * context. It is **informational regulatory transparency**, explicitly not a personalized safety
 * conclusion - `09` keeps those on separate paths and `07.2` requires foreign status never to
 * set personal alert urgency.
 *
 * THE FOUR RULES THIS MODULE EXISTS TO ENFORCE
 *  1. `RESTRICTED` is never rendered as prohibited (`09`).
 *  2. Absence of a matched rule is never rendered as approval or safety (`23` D-014).
 *  3. When the law turns on a concentration or use the package does not disclose, the result is
 *     `CONDITION_UNKNOWN` - never an invented compliance verdict (`03` demo step 9, DEC-007).
 *  4. GB and NI are answered independently (`23` D-013).
 */

import type {
  CalendarDate,
  Instant,
  Jurisdiction,
  ProductUseType,
  RegulatoryApplicability,
  RegulatoryStatus,
} from '@kynviora/domain';
import { ABSENCE_STATUSES } from '@kynviora/domain';
import type {
  ProductRegulatoryAction,
  RegulatoryConditions,
  RegulatoryRuleVersion,
  ScientificOpinionRecord,
  SourceRegistryEntry,
} from './records.js';

/**
 * What the package actually tells us about the product being assessed.
 *
 * Every field that a rule might turn on is nullable, because the honest answer for most real
 * packages is "the label does not say".
 */
export interface ProductContext {
  readonly substanceCanonicalKey: string;
  /** Percent, only when the label explicitly discloses it. Almost always null. */
  readonly disclosedConcentrationPercent: number | null;
  readonly productUseType: ProductUseType;
  /** Free-text category from the label or catalog, when known. */
  readonly productCategory: string | null;
  /** Whether the product is presented for use on children under the relevant age. */
  readonly intendedForAgeYears: number | null;
  /** Whether the substance is present at all, per the confirmed declaration. */
  readonly substancePresent: boolean;
}

/** One jurisdiction's answer, with everything needed to render it honestly. */
export interface JurisdictionLensEntry {
  readonly jurisdiction: Jurisdiction;

  /** All applicable statuses. A list, never collapsed to one (`07`). */
  readonly statuses: readonly RegulatoryStatus[];

  /** Whether the rule can be determined to bite for this package (DEC-007). */
  readonly applicability: RegulatoryApplicability;

  readonly conditions: RegulatoryConditions | null;

  /**
   * Which specific conditions could not be evaluated from package evidence.
   *
   * Empty unless `applicability` is `CONDITION_UNKNOWN`. Exposed so a screen can prompt for the
   * exact missing datum rather than asking the user to re-photograph everything.
   */
  readonly unresolvedConditions: readonly UnresolvedCondition[];

  readonly authority: string | null;
  readonly legalInstrument: string | null;
  readonly legalReference: string | null;
  readonly publicationDate: CalendarDate | null;
  readonly effectiveDate: CalendarDate | null;

  /** When Kynviora last successfully checked the underlying source (`09`). */
  readonly lastVerifiedAt: Instant | null;

  /** Source coverage statement, always shown alongside an absence status (`09`). */
  readonly coverageStatement: string;

  /**
   * What this entry does **not** mean.
   *
   * `09` requires every displayed status to carry its limitations, and specifies the exact
   * shapes of the copy. Populated by {@link limitationsFor}, never left empty for an absence or
   * condition-unknown result.
   */
  readonly limitations: readonly string[];

  /** Scientific opinions, kept separate from law (`09`). */
  readonly scientificOpinions: readonly {
    readonly committee: string;
    readonly reference: string;
    readonly summary: string;
    readonly publicationDate: CalendarDate | null;
    readonly hasImplementingLaw: boolean;
  }[];

  /** Official actions targeting identified goods. */
  readonly productActions: readonly {
    readonly actionKind: ProductRegulatoryAction['actionKind'];
    readonly authority: string;
    readonly summary: string;
    readonly effectiveDate: CalendarDate | null;
  }[];

  /** Rule version this entry projects, for reproducibility and diffing. */
  readonly ruleVersionId: string | null;
}

export interface RegulatoryLensSnapshot {
  readonly substanceCanonicalKey: string;
  readonly entries: readonly JurisdictionLensEntry[];
  readonly generatedAt: Instant;
  /** Jurisdictions requested but for which Kynviora has no monitored coverage at all. */
  readonly unmonitoredJurisdictions: readonly Jurisdiction[];
}

export interface LensInput {
  readonly context: ProductContext;
  readonly jurisdictions: readonly Jurisdiction[];
  /** Published rules, already through the Citation Gate. */
  readonly rules: readonly RegulatoryRuleVersion[];
  readonly opinions: readonly ScientificOpinionRecord[];
  readonly actions: readonly ProductRegulatoryAction[];
  readonly sources: ReadonlyMap<string, SourceRegistryEntry>;
  readonly generatedAt: Instant;
}

/**
 * Which specific condition a rule turns on could not be evaluated from package evidence.
 *
 * Reported so the limitation copy can name the *actual* missing datum. Without this, a rule with
 * both a concentration limit and an age condition would report "the package does not disclose
 * the concentration" even when the concentration is printed and the intended age is what is
 * unknown - inaccurate copy on exactly the screen `09` requires to be precise.
 */
export const UNRESOLVED_CONDITIONS = [
  'CONCENTRATION',
  'PRODUCT_USE',
  'INTENDED_AGE',
  'ROUTE',
] as const;
export type UnresolvedCondition = (typeof UNRESOLVED_CONDITIONS)[number];

export interface ApplicabilityResult {
  readonly applicability: RegulatoryApplicability;
  /** Every condition that could not be evaluated, so the copy can name them all. */
  readonly unresolved: readonly UnresolvedCondition[];
}

/**
 * Determine whether a rule's conditions can be evaluated against what the package discloses.
 *
 * The heart of DEC-007 and of the `03` demo scenario. Three outcomes:
 *
 *  - `DOES_NOT_APPLY` - the rule is scoped to something this product is not.
 *  - `CONDITION_UNKNOWN` - at least one condition turns on a value the package does not
 *    disclose. The normal outcome for any concentration limit, because INCI declarations list
 *    order, not percentages.
 *  - `APPLIES` - every condition could be evaluated from disclosed data.
 *
 * There is deliberately no `EXCEEDS_LIMIT` or `COMPLIANT` outcome. Determining whether a
 * marketed product complies with law is a regulator's finding, not an app's.
 *
 * Conditions are evaluated exhaustively rather than short-circuiting, so every unresolved
 * condition is reported rather than only the first one encountered.
 */
export function determineApplicabilityDetailed(
  conditions: RegulatoryConditions,
  context: ProductContext,
): ApplicabilityResult {
  if (!context.substancePresent) {
    return { applicability: 'DOES_NOT_APPLY', unresolved: [] };
  }

  const unresolved: UnresolvedCondition[] = [];
  let scopedOut = false;

  // Product-use scoping. If the rule names use types and the package's use type is known and not
  // among them, the rule genuinely does not apply.
  if (conditions.productUseTypes && conditions.productUseTypes.length > 0) {
    if (context.productUseType === 'UNKNOWN') {
      unresolved.push('PRODUCT_USE');
    } else if (!conditions.productUseTypes.includes(context.productUseType)) {
      scopedOut = true;
    }
  }

  // Age scoping. A rule excluding children under 3 does not apply to a product not presented for
  // that group - but if we do not know the intended age, we cannot say.
  if (conditions.minimumAgeYears !== undefined) {
    if (context.intendedForAgeYears === null) {
      unresolved.push('INTENDED_AGE');
    } else if (context.intendedForAgeYears >= conditions.minimumAgeYears) {
      scopedOut = true;
    }
  }

  // Concentration limits. The package almost never discloses a percentage, so this is the
  // dominant path to CONDITION_UNKNOWN and the case the demo scenario turns on.
  if (
    conditions.maxConcentrationPercent !== undefined ||
    conditions.minConcentrationPercent !== undefined
  ) {
    if (context.disclosedConcentrationPercent === null) {
      unresolved.push('CONCENTRATION');
    }
    // A disclosed concentration lets us say the rule is engaged. It does NOT let us declare a
    // violation: the declared figure may be nominal, the rule may have exemptions, and
    // enforcement is a regulator's role.
  }

  // Prohibited routes are a property of the product's intended use, which the package may not
  // state explicitly.
  if (conditions.prohibitedRoutes && conditions.prohibitedRoutes.length > 0) {
    if (context.productUseType === 'UNKNOWN') {
      unresolved.push('ROUTE');
    }
  }

  // An unresolved condition dominates: we cannot claim the rule does not apply when we were
  // unable to evaluate part of it. Failing towards "we cannot tell" is the honest direction.
  if (unresolved.length > 0) {
    return { applicability: 'CONDITION_UNKNOWN', unresolved };
  }

  if (scopedOut) {
    return { applicability: 'DOES_NOT_APPLY', unresolved: [] };
  }

  return { applicability: 'APPLIES', unresolved: [] };
}

/** Applicability only, for callers that do not need the unresolved detail. */
export function determineApplicability(
  conditions: RegulatoryConditions,
  context: ProductContext,
): RegulatoryApplicability {
  return determineApplicabilityDetailed(conditions, context).applicability;
}

/**
 * Build the limitation statements that must accompany an entry.
 *
 * `09` gives the required copy patterns almost verbatim; they are reproduced here so the wording
 * is defined once and cannot drift between screens.
 */
export function limitationsFor(
  statuses: readonly RegulatoryStatus[],
  applicability: RegulatoryApplicability,
  jurisdiction: Jurisdiction,
  conditions: RegulatoryConditions | null,
  unresolved: readonly UnresolvedCondition[] = [],
): readonly string[] {
  const limitations: string[] = [];

  if (statuses.includes('NO_MATCHED_RULE_WITHIN_COVERAGE')) {
    // 23 D-014 and 09. The US case is called out explicitly because the absence of premarket
    // approval there makes "no match" especially easy to misread.
    limitations.push(
      'No matched restriction was found within the sources Kynviora currently monitors for this jurisdiction. This is not regulatory approval and does not mean the product is safe.',
    );
    if (jurisdiction === 'US') {
      limitations.push(
        'Most cosmetic ingredients are not reviewed or approved by the FDA before marketing, so an absence of a matched federal prohibition is not FDA approval.',
      );
    }
  }

  if (statuses.includes('UNKNOWN_OR_INSUFFICIENT')) {
    limitations.push(
      'Kynviora does not currently have enough source coverage to state a status for this jurisdiction. This is not evidence that no rule exists.',
    );
  }

  if (applicability === 'CONDITION_UNKNOWN') {
    // The exact case the 03 demo scenario requires: report that a restriction exists AND that
    // compliance cannot be determined, rather than claiming a violation.
    //
    // The copy names the specific missing datum. Saying "does not disclose the concentration"
    // when the concentration is printed and the intended age is what is unknown would be a
    // factually wrong statement about the user's own package.
    if (unresolved.includes('CONCENTRATION') && conditions?.maxConcentrationPercent !== undefined) {
      limitations.push(
        `A restriction applies under specified conditions, including a maximum concentration of ${conditions.maxConcentrationPercent}%. This package does not disclose the concentration, so Kynviora cannot determine whether that limit is exceeded.`,
      );
    }

    if (unresolved.includes('INTENDED_AGE') && conditions?.minimumAgeYears !== undefined) {
      limitations.push(
        `A condition applies to products for children under ${conditions.minimumAgeYears} years of age. Kynviora cannot tell from this package who it is intended for, so it cannot determine whether that condition applies.`,
      );
    }

    if (unresolved.includes('PRODUCT_USE')) {
      limitations.push(
        'This restriction depends on the type of product. Kynviora could not determine the product type from the available evidence.',
      );
    }

    if (unresolved.includes('ROUTE')) {
      limitations.push(
        'This restriction depends on how the product is used or applied, which Kynviora could not determine from the available evidence.',
      );
    }

    // Fallback so a CONDITION_UNKNOWN result is never left without an explanation.
    if (unresolved.length === 0) {
      limitations.push(
        'A restriction applies under specified conditions. This package does not disclose the information those conditions depend on, so Kynviora cannot determine whether they are met.',
      );
    }
  }

  if (statuses.includes('SCIENTIFIC_OPINION')) {
    limitations.push(
      'A scientific opinion is an expert assessment, not law. Kynviora has not identified a corresponding legal prohibition in the monitored sources as of the stated check date.',
    );
  }

  const isRestrictionNotProhibition =
    !statuses.includes('PROHIBITED') &&
    statuses.some((s) =>
      (
        ['RESTRICTED', 'CONCENTRATION_LIMIT', 'USE_CONDITION', 'AGE_OR_ROUTE_CONDITION'] as const
      ).includes(s as never),
    );

  if (isRestrictionNotProhibition) {
    // 09: "'Restricted' is not 'banned'."
    limitations.push(
      'This substance is permitted under conditions in this jurisdiction. It is not prohibited.',
    );
  }

  // Foreign status is informational unless a separately reviewed rule says otherwise (09, 07.2).
  limitations.push(
    'Regulatory status in one jurisdiction does not change the legal status in another, and does not by itself demonstrate harm.',
  );

  return limitations;
}

/**
 * Project the registry into a per-jurisdiction Lens snapshot.
 *
 * Pure and deterministic. `09` requires assessments and projections to be reproducible from
 * their versioned inputs.
 */
export function projectLens(input: LensInput): RegulatoryLensSnapshot {
  const { context, jurisdictions, rules, opinions, actions, sources, generatedAt } = input;

  const entries: JurisdictionLensEntry[] = [];
  const unmonitored: Jurisdiction[] = [];

  for (const jurisdiction of jurisdictions) {
    const jurisdictionRules = rules.filter(
      (r) =>
        r.jurisdiction === jurisdiction &&
        r.substanceCanonicalKey === context.substanceCanonicalKey &&
        r.reviewState === 'PUBLISHED',
    );

    const jurisdictionOpinions = opinions.filter(
      (o) =>
        o.jurisdiction === jurisdiction &&
        o.substanceCanonicalKey === context.substanceCanonicalKey &&
        o.reviewState === 'PUBLISHED',
    );

    const jurisdictionActions = actions.filter(
      (a) => a.jurisdiction === jurisdiction && a.reviewState === 'PUBLISHED',
    );

    // Does Kynviora monitor anything at all for this jurisdiction? Distinguishing "checked and
    // found nothing" from "never looked" is required by 09 coverage disclosure.
    const monitoringSources = [...sources.values()].filter(
      (s) =>
        s.jurisdiction === jurisdiction &&
        s.allowedInfluence.includes('REGULATORY_STATUS') &&
        s.status !== 'DISABLED',
    );

    if (monitoringSources.length === 0) {
      unmonitored.push(jurisdiction);
      entries.push(
        buildEntry({
          jurisdiction,
          statuses: ['UNKNOWN_OR_INSUFFICIENT'],
          applicability: 'CONDITION_UNKNOWN',
          conditions: null,
          rule: null,
          source: null,
          coverageStatement: `Kynviora does not currently monitor a regulatory source for ${jurisdiction}.`,
          opinions: jurisdictionOpinions,
          actions: jurisdictionActions,
        }),
      );
      continue;
    }

    const freshestSource = monitoringSources.reduce((best, s) =>
      (s.lastSuccessfulCheckAt ?? '') > (best.lastSuccessfulCheckAt ?? '') ? s : best,
    );

    if (jurisdictionRules.length === 0) {
      // Checked, nothing matched. This is emphatically not approval.
      const statuses: RegulatoryStatus[] =
        jurisdictionOpinions.length > 0
          ? ['NO_MATCHED_RULE_WITHIN_COVERAGE', 'SCIENTIFIC_OPINION']
          : ['NO_MATCHED_RULE_WITHIN_COVERAGE'];

      entries.push(
        buildEntry({
          jurisdiction,
          statuses,
          applicability: 'DOES_NOT_APPLY',
          conditions: null,
          rule: null,
          source: freshestSource,
          coverageStatement: freshestSource.coverageStatement,
          opinions: jurisdictionOpinions,
          actions: jurisdictionActions,
        }),
      );
      continue;
    }

    // Multiple rules may apply simultaneously; merge their statuses rather than picking one.
    const allStatuses = new Set<RegulatoryStatus>();
    for (const rule of jurisdictionRules) {
      for (const status of rule.statuses) allStatuses.add(status);
    }
    if (jurisdictionOpinions.length > 0) allStatuses.add('SCIENTIFIC_OPINION');
    if (jurisdictionActions.length > 0) allStatuses.add('PRODUCT_ACTION');

    // Pick the rule whose conditions are most specific for reporting detail, preferring the most
    // recently effective.
    const primaryRule = [...jurisdictionRules].sort((a, b) =>
      (b.effectiveDate ?? '') > (a.effectiveDate ?? '') ? 1 : -1,
    )[0]!;

    // Applicability is the *least* determined outcome across applicable rules: if any rule
    // depends on undisclosed data, the honest overall answer is CONDITION_UNKNOWN.
    const results = jurisdictionRules.map((r) =>
      determineApplicabilityDetailed(r.conditions, context),
    );
    const applicabilities = results.map((r) => r.applicability);
    const applicability: RegulatoryApplicability = applicabilities.includes('CONDITION_UNKNOWN')
      ? 'CONDITION_UNKNOWN'
      : applicabilities.includes('APPLIES')
        ? 'APPLIES'
        : 'DOES_NOT_APPLY';

    // Union of every unresolved condition across the applicable rules, so the copy can name all
    // of them rather than only those from the primary rule.
    const unresolved = [...new Set(results.flatMap((r) => r.unresolved))];

    entries.push(
      buildEntry({
        jurisdiction,
        statuses: [...allStatuses],
        applicability,
        unresolved,
        conditions: primaryRule.conditions,
        rule: primaryRule,
        source: sources.get(primaryRule.sourceRegistryEntryId) ?? freshestSource,
        coverageStatement: freshestSource.coverageStatement,
        opinions: jurisdictionOpinions,
        actions: jurisdictionActions,
      }),
    );
  }

  return {
    substanceCanonicalKey: context.substanceCanonicalKey,
    entries,
    generatedAt,
    unmonitoredJurisdictions: unmonitored,
  };
}

function buildEntry(args: {
  jurisdiction: Jurisdiction;
  statuses: readonly RegulatoryStatus[];
  applicability: RegulatoryApplicability;
  unresolved?: readonly UnresolvedCondition[];
  conditions: RegulatoryConditions | null;
  rule: RegulatoryRuleVersion | null;
  source: SourceRegistryEntry | null;
  coverageStatement: string;
  opinions: readonly ScientificOpinionRecord[];
  actions: readonly ProductRegulatoryAction[];
}): JurisdictionLensEntry {
  return {
    jurisdiction: args.jurisdiction,
    statuses: args.statuses,
    applicability: args.applicability,
    unresolvedConditions: args.unresolved ?? [],
    conditions: args.conditions,
    authority: args.source?.organization ?? null,
    legalInstrument: args.rule?.legalInstrument ?? null,
    legalReference: args.rule?.legalReference ?? null,
    publicationDate: args.rule?.publicationDate ?? null,
    effectiveDate: args.rule?.effectiveDate ?? null,
    lastVerifiedAt: args.source?.lastSuccessfulCheckAt ?? null,
    coverageStatement: args.coverageStatement,
    limitations: limitationsFor(
      args.statuses,
      args.applicability,
      args.jurisdiction,
      args.conditions,
      args.unresolved ?? [],
    ),
    scientificOpinions: args.opinions.map((o) => ({
      committee: o.committee,
      reference: o.opinionReference,
      summary: o.summary,
      publicationDate: o.publicationDate,
      hasImplementingLaw: o.implementedByRuleVersionId !== null,
    })),
    productActions: args.actions.map((a) => ({
      actionKind: a.actionKind,
      authority: a.authority,
      summary: a.summary,
      effectiveDate: a.effectiveDate,
    })),
    ruleVersionId: args.rule?.id ?? null,
  };
}

/**
 * Whether an entry represents an absence of findings rather than a positive clearance.
 *
 * Exposed so presentation layers can assert they are rendering absence honestly, rather than
 * each screen re-deriving the check.
 */
export function isAbsenceEntry(entry: JurisdictionLensEntry): boolean {
  return entry.statuses.some((s) => ABSENCE_STATUSES.includes(s));
}

/**
 * Whether an entry represents an actual prohibition.
 *
 * The only sanctioned way to ask. A screen must never infer "banned" from the presence of
 * `RESTRICTED` or from a non-empty conditions object.
 */
export function isProhibition(entry: JurisdictionLensEntry): boolean {
  return entry.statuses.includes('PROHIBITED');
}
