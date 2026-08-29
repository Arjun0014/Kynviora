/**
 * Product Trust Passport.
 *
 * Spec references: `04` Phase 2.4, `08` ("Product Trust Passport"), `05` idea 1, `02`
 * (differentiation pillar 1), `24`.
 *
 * WHAT IT IS
 * `05`: "Most apps hide data uncertainty. Making it visible is both useful and differentiating."
 * The Passport is Kynviora's answer to "how well do you actually know this item?" - and the
 * answer is deliberately several separate answers, not one.
 *
 * THE RULE THAT SHAPES THE TYPE
 * `08`: "Do not turn these into one universal safety score." So `TrustPassport` has no aggregate
 * field, no percentage and no grade. Every facet is reported independently, and a test asserts
 * no scalar summary exists.
 *
 * A user must be able to see why two items of the same brand have different trust states (`04`
 * Phase 2.4 exit criterion), which is only possible if the facets stay separate.
 */

import type {
  CatalogCorroboration,
  Instant,
  ItemVerification,
  Jurisdiction,
  MarketCode,
} from '@kynviora/domain';

/** One facet of what Kynviora knows, with the reason behind it. */
export interface TrustFacet {
  readonly verification: ItemVerification;
  /**
   * Why the facet is in this state.
   *
   * `02` differentiation pillar 7 requires every material state to answer "why". A facet showing
   * `UNVERIFIED` with no reason gives a user nothing to act on, and `04` Phase 2.4 requires
   * "unverified" to stay "useful and actionable rather than becoming an error dead end".
   */
  readonly reasonCode: TrustReasonCode;
  /** What the user can do to improve this facet, when there is something. */
  readonly userAction: TrustUserAction | null;
}

export const TRUST_REASON_CODES = [
  'CONFIRMED_FROM_PACKAGE',
  'CONFIRMED_BY_PROVIDER',
  'MATCHED_BY_BARCODE_ONLY',
  'MATCHED_BY_NAME_ONLY',
  'NOT_CAPTURED',
  'EXTRACTION_UNCONFIRMED',
  'RECORDS_DISAGREE',
  'NOT_APPLICABLE',
] as const;
export type TrustReasonCode = (typeof TRUST_REASON_CODES)[number];

export const TRUST_USER_ACTIONS = [
  'CAPTURE_FRONT_PANEL',
  'CAPTURE_INGREDIENT_PANEL',
  'ENTER_BATCH_AND_EXPIRY',
  'CONFIRM_EXTRACTED_FIELDS',
  'RESOLVE_CONFLICT',
  'RESCAN_CURRENT_LABEL',
] as const;
export type TrustUserAction = (typeof TRUST_USER_ACTIONS)[number];

/**
 * The complete Passport.
 *
 * Note what is absent: no `overallTrust`, no `score`, no `grade`. That absence is the design.
 */
export interface TrustPassport {
  /** Is this the right product? */
  readonly identity: TrustFacet;
  /** Do we know what is actually in it? Separate from identity (`08`, `02` pillar 1). */
  readonly formulation: TrustFacet;
  /** Do we know which pack this is? */
  readonly batch: TrustFacet;

  /** How well the shared catalog knows this formulation, distinct from this user's own item. */
  readonly catalogCorroboration: CatalogCorroboration;

  readonly market: MarketCode | null;
  readonly formulationVersion: string | null;
  readonly firstObservedAt: Instant | null;
  readonly lastObservedAt: Instant | null;
  readonly lastReviewedAt: Instant | null;
  readonly lastSafetyCheckedAt: Instant | null;

  /**
   * What Kynviora monitors for this item, and what it does not.
   *
   * `09` requires a coverage statement wherever an absence of findings is shown, so that silence
   * is never read as reassurance.
   */
  readonly coverage: CoverageSummary;
}

export interface CoverageSummary {
  readonly monitoredJurisdictions: readonly Jurisdiction[];
  /** Jurisdictions with no monitored regulatory source at all. */
  readonly unmonitoredJurisdictions: readonly Jurisdiction[];
  /** True when any monitored source relevant to this item is stale. */
  readonly hasStaleSource: boolean;
  readonly statement: string;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export interface TrustPassportInput {
  readonly identityVerification: ItemVerification;
  readonly formulationVerification: ItemVerification;
  readonly batchVerification: ItemVerification;
  readonly catalogCorroboration: CatalogCorroboration;

  /** Whether the user actually captured each panel. Drives the reason and the suggested action. */
  readonly hasFrontPanelEvidence: boolean;
  readonly hasIngredientPanelEvidence: boolean;
  readonly hasBatchRecorded: boolean;
  /** True when identity came from a barcode lookup with no package capture. */
  readonly identityFromBarcodeOnly: boolean;
  /** True when extracted fields are still awaiting user confirmation. */
  readonly hasUnconfirmedFields: boolean;
  /** True when an unresolved formulation conflict exists. */
  readonly hasOpenConflict: boolean;
  /** Whether a batch is meaningful for this item at all. */
  readonly batchApplicable: boolean;

  readonly market: MarketCode | null;
  readonly formulationVersion: string | null;
  readonly firstObservedAt: Instant | null;
  readonly lastObservedAt: Instant | null;
  readonly lastReviewedAt: Instant | null;
  readonly lastSafetyCheckedAt: Instant | null;

  readonly monitoredJurisdictions: readonly Jurisdiction[];
  readonly unmonitoredJurisdictions: readonly Jurisdiction[];
  readonly hasStaleSource: boolean;
}

function identityFacet(input: TrustPassportInput): TrustFacet {
  if (input.hasOpenConflict && input.identityVerification === 'CONFLICTING') {
    return {
      verification: 'CONFLICTING',
      reasonCode: 'RECORDS_DISAGREE',
      userAction: 'RESOLVE_CONFLICT',
    };
  }

  if (input.identityVerification === 'CONFIRMED') {
    return {
      verification: 'CONFIRMED',
      reasonCode: input.hasFrontPanelEvidence ? 'CONFIRMED_FROM_PACKAGE' : 'CONFIRMED_BY_PROVIDER',
      userAction: null,
    };
  }

  // A barcode match is identity evidence, never formulation evidence (`08`). Reporting the
  // reason lets the UI say so rather than leaving the user to wonder why it is only probable.
  if (input.identityFromBarcodeOnly) {
    return {
      verification: input.identityVerification,
      reasonCode: 'MATCHED_BY_BARCODE_ONLY',
      userAction: 'CAPTURE_FRONT_PANEL',
    };
  }

  if (!input.hasFrontPanelEvidence) {
    return {
      verification: input.identityVerification,
      reasonCode: 'NOT_CAPTURED',
      userAction: 'CAPTURE_FRONT_PANEL',
    };
  }

  return {
    verification: input.identityVerification,
    reasonCode: input.hasUnconfirmedFields ? 'EXTRACTION_UNCONFIRMED' : 'MATCHED_BY_NAME_ONLY',
    userAction: input.hasUnconfirmedFields ? 'CONFIRM_EXTRACTED_FIELDS' : 'CAPTURE_FRONT_PANEL',
  };
}

function formulationFacet(input: TrustPassportInput): TrustFacet {
  if (input.hasOpenConflict) {
    return {
      verification: 'CONFLICTING',
      reasonCode: 'RECORDS_DISAGREE',
      userAction: 'RESCAN_CURRENT_LABEL',
    };
  }

  if (input.formulationVerification === 'CONFIRMED') {
    return {
      verification: 'CONFIRMED',
      reasonCode: input.hasIngredientPanelEvidence
        ? 'CONFIRMED_FROM_PACKAGE'
        : 'CONFIRMED_BY_PROVIDER',
      userAction: null,
    };
  }

  if (!input.hasIngredientPanelEvidence) {
    // The state spec 05.5 names explicitly: "identity found, formula not verified".
    return {
      verification: input.formulationVerification,
      reasonCode: 'NOT_CAPTURED',
      userAction: 'CAPTURE_INGREDIENT_PANEL',
    };
  }

  return {
    verification: input.formulationVerification,
    reasonCode: 'EXTRACTION_UNCONFIRMED',
    userAction: 'CONFIRM_EXTRACTED_FIELDS',
  };
}

function batchFacet(input: TrustPassportInput): TrustFacet {
  if (!input.batchApplicable) {
    // Not every item has a meaningful batch. Reporting NOT_APPLICABLE rather than UNVERIFIED
    // avoids nagging a user to enter something that does not exist.
    return { verification: 'UNVERIFIED', reasonCode: 'NOT_APPLICABLE', userAction: null };
  }

  if (input.batchVerification === 'CONFIRMED') {
    return { verification: 'CONFIRMED', reasonCode: 'CONFIRMED_FROM_PACKAGE', userAction: null };
  }

  if (!input.hasBatchRecorded) {
    return {
      verification: 'UNVERIFIED',
      reasonCode: 'NOT_CAPTURED',
      userAction: 'ENTER_BATCH_AND_EXPIRY',
    };
  }

  return {
    verification: input.batchVerification,
    reasonCode: 'EXTRACTION_UNCONFIRMED',
    userAction: 'CONFIRM_EXTRACTED_FIELDS',
  };
}

/**
 * Build the coverage statement.
 *
 * Deliberately states what is *not* covered as prominently as what is. `09`: absence of a matched
 * concern must never read as reassurance, and a coverage line that lists only what is monitored
 * invites exactly that reading.
 */
export function buildCoverageSummary(input: TrustPassportInput): CoverageSummary {
  const monitored = input.monitoredJurisdictions;
  const unmonitored = input.unmonitoredJurisdictions;

  const parts: string[] = [];

  parts.push(
    monitored.length === 0
      ? 'Kynviora is not currently monitoring a regulatory source for this item.'
      : `Kynviora monitors sources for ${monitored.join(', ')}.`,
  );

  if (unmonitored.length > 0) {
    parts.push(`It does not currently monitor ${unmonitored.join(', ')}.`);
  }

  if (input.hasStaleSource) {
    parts.push('At least one source has not been checked recently, so results may be out of date.');
  }

  parts.push('Finding nothing is not a guarantee that a product is safe.');

  return {
    monitoredJurisdictions: monitored,
    unmonitoredJurisdictions: unmonitored,
    hasStaleSource: input.hasStaleSource,
    statement: parts.join(' '),
  };
}

/**
 * Derive the Passport.
 *
 * Pure and deterministic, so the same item state always produces the same Passport - which is
 * what lets a support conversation reproduce exactly what a user was shown.
 */
export function buildTrustPassport(input: TrustPassportInput): TrustPassport {
  return {
    identity: identityFacet(input),
    formulation: formulationFacet(input),
    batch: batchFacet(input),
    catalogCorroboration: input.catalogCorroboration,
    market: input.market,
    formulationVersion: input.formulationVersion,
    firstObservedAt: input.firstObservedAt,
    lastObservedAt: input.lastObservedAt,
    lastReviewedAt: input.lastReviewedAt,
    lastSafetyCheckedAt: input.lastSafetyCheckedAt,
    coverage: buildCoverageSummary(input),
  };
}

/**
 * The single most useful next action across all facets, or null.
 *
 * `18` requires one clear primary action on high-impact screens, so the Passport surfaces one
 * suggestion rather than three competing ones. Ordering is by what unblocks the most: resolving a
 * conflict first (it invalidates other facets), then confirming what was already captured (cheap
 * for the user), then capturing what is missing.
 *
 * This is a **presentation** convenience. It is not a score, and it does not rank the facets by
 * importance - all three remain individually visible.
 */
export function primaryTrustAction(passport: TrustPassport): TrustUserAction | null {
  const ordered: TrustUserAction[] = [
    'RESOLVE_CONFLICT',
    'CONFIRM_EXTRACTED_FIELDS',
    'CAPTURE_INGREDIENT_PANEL',
    'CAPTURE_FRONT_PANEL',
    'RESCAN_CURRENT_LABEL',
    'ENTER_BATCH_AND_EXPIRY',
  ];

  const present = new Set(
    [
      passport.identity.userAction,
      passport.formulation.userAction,
      passport.batch.userAction,
    ].filter((a): a is TrustUserAction => a !== null),
  );

  return ordered.find((action) => present.has(action)) ?? null;
}
