/**
 * Global Regulatory Registry record types.
 *
 * Spec references: `07` (Global Regulatory Registry domain), `09` (Lens statuses), `25`
 * (source registry, Citation Gate).
 *
 * These types describe **what a regulator says**, kept entirely separate from what Kynviora
 * concludes about a person (`@kynviora/safety`). `09` is explicit that law, official action,
 * guidance, scientific opinion and personalized assessment each carry their own authority and
 * must never be collapsed.
 */

import type {
  CalendarDate,
  Instant,
  Jurisdiction,
  ProductUseType,
  RegulatoryStatus,
  ReviewState,
  SourceClass,
  SourceStatus,
} from '@kynviora/domain';

/**
 * A registered source Kynviora monitors.
 *
 * `25` requires each source to declare the evidentiary role it is allowed to play, because "A
 * source may support one [system] and be prohibited from influencing another".
 */
export interface SourceRegistryEntry {
  readonly id: string;
  readonly organization: string;
  readonly sourceName: string;
  readonly sourceClass: SourceClass;
  readonly jurisdiction: Jurisdiction | null;

  /**
   * What this source is permitted to influence.
   *
   * Enforced at runtime by the Citation Gate and the resolver (DEC-014), not merely documented.
   */
  readonly allowedInfluence: readonly AllowedInfluence[];

  /** Whether legal/licence review has been completed for storage and redistribution. */
  readonly licenseReviewState: 'NOT_REVIEWED' | 'APPROVED' | 'RESTRICTED' | 'PROHIBITED';
  /** Whether a raw snapshot may be retained, which affects Citation Gate evidence. */
  readonly snapshotRetentionAllowed: boolean;

  readonly expectedRefreshIntervalMs: number;
  readonly parserVersion: string;
  readonly status: SourceStatus;
  readonly lastSuccessfulCheckAt: Instant | null;

  /** User-facing statement of what this source does and does not cover (`25`). */
  readonly coverageStatement: string;
}

export const ALLOWED_INFLUENCES = [
  'IDENTITY',
  'NORMALIZATION',
  'REGULATORY_STATUS',
  'SAFETY_RULE',
  'DISCOVERY_ONLY',
] as const;
export type AllowedInfluence = (typeof ALLOWED_INFLUENCES)[number];

/**
 * A preserved version of source material.
 *
 * `04` Phase 6.2: "A later reviewer can reconstruct which official version produced a record."
 * When licensing forbids retaining a snapshot, `contentSha256` may still be recorded against a
 * reference so change detection works without storing the material.
 */
export interface SourceDocument {
  readonly id: string;
  readonly sourceRegistryEntryId: string;
  readonly canonicalUri: string;
  readonly retrievedAt: Instant;
  readonly contentSha256: string;
  /** Storage key when retention is permitted; null when only a reference is kept. */
  readonly snapshotStorageKey: string | null;
  /** Publisher's own version or amendment identifier, when the source exposes one. */
  readonly sourceVersionLabel: string | null;
  readonly supersedesDocumentId: string | null;
}

/**
 * Conditions attached to a regulatory rule.
 *
 * Every field is optional because real rules are multidimensional and partially specified.
 * `07`: "Do not force one oversimplified status if the legal conditions are multidimensional."
 *
 * The salicylic acid case exercises nearly all of these at once: a maximum concentration that
 * differs by product type, plus a route exclusion, plus an age exclusion.
 */
export interface RegulatoryConditions {
  /** Maximum permitted concentration, percent. */
  readonly maxConcentrationPercent?: number;
  /** Minimum required concentration, where a rule sets a floor. */
  readonly minConcentrationPercent?: number;
  /** Product use types the rule applies to. Empty/absent means unrestricted by use type. */
  readonly productUseTypes?: readonly ProductUseType[];
  /** Free-text product categories from the source, e.g. `rinse-off hair products`. */
  readonly productCategories?: readonly string[];
  /** Minimum age in years, e.g. 3 for "not for children under 3 years". */
  readonly minimumAgeYears?: number;
  /** Routes or exposures the rule prohibits, e.g. `inhalation`, `oral`, `mucosal`. */
  readonly prohibitedRoutes?: readonly string[];
  /** Wording the label must carry when the rule is a warning requirement. */
  readonly requiredWarningText?: string;
  /** Any further condition text preserved verbatim from the source. */
  readonly additionalConditions?: readonly string[];
}

/**
 * Whether a fixture or record has been verified against a retrieved official document.
 *
 * DEC-016: research conducted for this build produced regulatory facts from search summaries
 * rather than retrieved official documents. Those are useful for exercising the engine and are
 * honestly labelled here, and the Citation Gate refuses to publish them.
 */
export const VERIFICATION_STATES = [
  'VERIFIED_AGAINST_OFFICIAL_SOURCE',
  'NEEDS_PRIMARY_VERIFICATION',
  'UNVERIFIED',
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

/**
 * A versioned regulatory rule tied to official source evidence.
 *
 * Immutable. An amendment creates a new version and sets `supersedesRuleVersionId`, so the
 * timeline stays reconstructable (`09` Evidence and Regulatory Diff).
 */
export interface RegulatoryRuleVersion {
  readonly id: string;
  readonly jurisdiction: Jurisdiction;

  /** Canonical substance this rule governs. */
  readonly substanceCanonicalKey: string;

  /**
   * The statuses this rule establishes.
   *
   * A list, not a scalar: the salicylic acid rule is simultaneously `RESTRICTED`,
   * `CONCENTRATION_LIMIT`, `USE_CONDITION` and `AGE_OR_ROUTE_CONDITION`. Forcing one value would
   * be the "restricted rendered as banned" defect that `24` treats as release-blocking.
   */
  readonly statuses: readonly RegulatoryStatus[];

  readonly conditions: RegulatoryConditions;

  /** Legal instrument, e.g. `Regulation (EC) No 1223/2009`. */
  readonly legalInstrument: string | null;
  /** Precise location, e.g. `Annex III, entry 98`. */
  readonly legalReference: string | null;

  readonly publicationDate: CalendarDate | null;
  readonly effectiveDate: CalendarDate | null;

  readonly sourceRegistryEntryId: string;
  readonly sourceDocumentId: string | null;

  readonly extractionVersion: string;
  readonly reviewState: ReviewState;
  readonly verification: VerificationState;

  /** Reviewer who approved this record. Null until a named human has actually approved it. */
  readonly approvedByReviewerId: string | null;
  readonly approvedAt: Instant | null;

  readonly supersedesRuleVersionId: string | null;
  readonly createdAt: Instant;
}

/**
 * An official action targeting a specific product, batch or manufacturer.
 *
 * Distinct from a substance rule: a recall applies to identified goods, not to an ingredient in
 * general, and `09` keeps `PRODUCT_ACTION` as its own status for exactly that reason.
 */
export interface ProductRegulatoryAction {
  readonly id: string;
  readonly jurisdiction: Jurisdiction;
  readonly actionKind:
    'RECALL' | 'WITHDRAWAL' | 'MARKETING_PROHIBITION' | 'QUALITY_ALERT' | 'WARNING';
  readonly authority: string;

  /** Scope. At least one must be present, or the action cannot be matched to anything. */
  readonly productIdentityId: string | null;
  readonly formulationId: string | null;
  readonly gtin: string | null;
  readonly batchCodes: readonly string[];
  readonly manufacturerName: string | null;

  readonly summary: string;
  readonly publicationDate: CalendarDate | null;
  readonly effectiveDate: CalendarDate | null;

  readonly sourceRegistryEntryId: string;
  readonly sourceDocumentId: string | null;
  readonly reviewState: ReviewState;
  readonly verification: VerificationState;
  readonly createdAt: Instant;
}

/**
 * A scientific committee opinion.
 *
 * Deliberately a separate type from {@link RegulatoryRuleVersion}. `09`: a scientific opinion
 * "is not itself the legal status", and `16` warns that a research finding must never become an
 * automated safety warning. Keeping it structurally distinct means an opinion cannot accidentally
 * be read as a prohibition.
 */
export interface ScientificOpinionRecord {
  readonly id: string;
  readonly jurisdiction: Jurisdiction;
  readonly substanceCanonicalKey: string;
  readonly committee: string;
  readonly opinionReference: string;
  readonly summary: string;
  readonly publicationDate: CalendarDate | null;
  readonly sourceRegistryEntryId: string;
  readonly sourceDocumentId: string | null;
  readonly reviewState: ReviewState;
  readonly verification: VerificationState;
  /**
   * A corresponding legal instrument, when one exists.
   *
   * Null is the normal case and is meaningful: an opinion with no implementing law has not
   * changed the legal status of anything.
   */
  readonly implementedByRuleVersionId: string | null;
  readonly createdAt: Instant;
}
