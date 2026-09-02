/**
 * Controlled vocabularies for Kynviora.
 *
 * Source of truth: `07_DOMAIN_MODEL.md` ("Controlled dimensions") and
 * `09_SAFETY_WATCH_AND_EVIDENCE_MODEL.md`.
 *
 * DESIGN RULE (DEC-006): each dimension below is a *separate* type. There is deliberately no
 * conversion function anywhere in this codebase between `EvidenceLevel` and `ActionUrgency`,
 * and no aggregate "safety score" of any kind. `02` and `23` (D-005) forbid collapsing these
 * into one number; `24` makes doing so release-blocking. Keeping them as distinct closed unions
 * makes the collapse unrepresentable rather than merely discouraged.
 *
 * Every vocabulary is exported both as a frozen runtime tuple (for validation, iteration and
 * database CHECK-constraint generation) and as a derived union type.
 */

/** Narrow a readonly tuple to a union of its members. */
type Member<T extends readonly unknown[]> = T[number];

/** Runtime membership test that also narrows the type. */
function makeGuard<const T extends readonly string[]>(
  values: T,
): (value: unknown) => value is Member<T> {
  const set: ReadonlySet<string> = new Set(values);
  return (value: unknown): value is Member<T> => typeof value === 'string' && set.has(value);
}

// ---------------------------------------------------------------------------
// Jurisdiction
// ---------------------------------------------------------------------------

/**
 * Supported regulatory jurisdictions (`09`, `23` D-012).
 *
 * There is intentionally **no `UK` member** (DEC-008). Great Britain retained EU cosmetics law
 * and may diverge from later EU amendments, while Northern Ireland continues to apply the EU
 * Cosmetics Regulation under the Windsor Framework. `23` D-013 and `24` make collapsing them a
 * defect, so the flattening is made impossible at the type level rather than policed by review.
 */
export const JURISDICTIONS = ['IN', 'EU', 'GB', 'NI', 'US', 'JP'] as const;
export type Jurisdiction = Member<typeof JURISDICTIONS>;
export const isJurisdiction = makeGuard(JURISDICTIONS);

/**
 * The market a package was sold into: an ISO 3166-1 alpha-2 country code.
 *
 * Deliberately **not** the same type as {@link Jurisdiction}. A market is where a physical
 * package was bought; a jurisdiction is a regulatory context Kynviora monitors. They overlap but
 * are not interchangeable - `EU` is a jurisdiction and not a market, while a package bought in a
 * country Kynviora does not yet monitor has a perfectly valid market and no jurisdiction at all.
 *
 * Conflating them would let an unmonitored market silently masquerade as a monitored
 * jurisdiction, which is exactly how a "no matched rule" result could be presented as though a
 * regulator had been consulted (`23` D-014).
 */
declare const marketBrand: unique symbol;
export type MarketCode = string & { readonly [marketBrand]: 'MarketCode' };

const MARKET_CODE_PATTERN = /^[A-Z]{2}$/;

export function marketCode(value: string): MarketCode {
  if (!MARKET_CODE_PATTERN.test(value)) {
    throw new TypeError(`Invalid market code (expected ISO 3166-1 alpha-2): ${value}`);
  }
  return value as MarketCode;
}

export function isMarketCode(value: unknown): value is MarketCode {
  return typeof value === 'string' && MARKET_CODE_PATTERN.test(value);
}

/**
 * The jurisdictions whose rules apply to a package sold in a given market.
 *
 * A market may map to more than one jurisdiction, and to none. Returning a list rather than a
 * single value keeps the GB/NI distinction representable and makes "not monitored" an explicit
 * empty result instead of a silent default.
 */
export function jurisdictionsForMarket(market: MarketCode): readonly Jurisdiction[] {
  switch (market) {
    case 'IN':
      return ['IN'];
    case 'US':
      return ['US'];
    case 'JP':
      return ['JP'];
    // Northern Ireland has no ISO 3166-1 alpha-2 code of its own; packages sold there carry GB.
    // Resolving GB to both jurisdictions is what surfaces the Windsor Framework divergence
    // instead of hiding it behind a single "UK" answer (`23` D-013).
    case 'GB':
      return ['GB', 'NI'];
    default:
      // EU member states. Listed explicitly rather than inferred, so adding a market is a
      // deliberate, reviewable change.
      return EU_MEMBER_MARKETS.has(market) ? ['EU'] : [];
  }
}

/** EU member state market codes, for jurisdiction resolution. */
const EU_MEMBER_MARKETS: ReadonlySet<string> = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
]);

/** Human-readable jurisdiction names. Never paired with a "strict"/"weak" ranking (`09`). */
export const JURISDICTION_NAMES: Readonly<Record<Jurisdiction, string>> = Object.freeze({
  IN: 'India',
  EU: 'European Union',
  GB: 'Great Britain',
  NI: 'Northern Ireland',
  US: 'United States',
  JP: 'Japan',
});

// ---------------------------------------------------------------------------
// Evidence level  (`09` "Evidence levels")
// ---------------------------------------------------------------------------

/**
 * How strong / how official the underlying evidence is.
 *
 * This says nothing about how urgently the user should act - that is {@link ActionUrgency},
 * a deliberately separate axis.
 */
export const EVIDENCE_LEVELS = ['A', 'B', 'C', 'D', 'E', 'U'] as const;
export type EvidenceLevel = Member<typeof EVIDENCE_LEVELS>;
export const isEvidenceLevel = makeGuard(EVIDENCE_LEVELS);

/**
 * Plain-language evidence labels (`18` "Evidence language").
 *
 * `18` requires users not to need a scientific grading system to act, and forbids percentage
 * confidence values that are not empirically calibrated.
 */
export const EVIDENCE_LEVEL_LABELS: Readonly<Record<EvidenceLevel, string>> = Object.freeze({
  A: 'Official action',
  B: 'Established guidance',
  C: 'Strong reviewed evidence',
  D: 'Limited evidence',
  E: 'Emerging signal',
  U: 'Insufficient information',
});

/**
 * Evidence level E ("emerging signal") is internal-monitoring only in the MVP (`09`).
 * Publication policy consults this; it is not a severity judgement.
 */
export const MVP_USER_VISIBLE_EVIDENCE_LEVELS: readonly EvidenceLevel[] = Object.freeze([
  'A',
  'B',
  'C',
  'D',
  'U',
]);

// ---------------------------------------------------------------------------
// Action urgency  (`09` "Action urgency")
// ---------------------------------------------------------------------------

/**
 * How time-sensitive the approved next action is.
 *
 * Independent of {@link EvidenceLevel}: a strong official batch recall (evidence A) can be
 * CRITICAL, while a foreign ingredient restriction backed by primary law (also strong evidence)
 * defaults to INFORMATIONAL because it is not a personal medical conclusion (`09`).
 */
export const ACTION_URGENCIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as const;
export type ActionUrgency = Member<typeof ACTION_URGENCIES>;
export const isActionUrgency = makeGuard(ACTION_URGENCIES);

/**
 * Default urgency for a regulatory difference observed in a jurisdiction other than the user's
 * own market.
 *
 * `09`: "A foreign ingredient restriction should normally default to INFORMATIONAL unless a
 * separate reviewed rule establishes a stronger action for the user's context."
 * `07`/`24`: a foreign status must never automatically set personalized alert urgency.
 */
export const FOREIGN_REGULATORY_DEFAULT_URGENCY: ActionUrgency = 'INFORMATIONAL';

// ---------------------------------------------------------------------------
// Match confidence  (`09` "Match confidence")
// ---------------------------------------------------------------------------

/** How exactly a record matched this specific item/person. */
export const MATCH_CONFIDENCES = ['EXACT', 'PROBABLE', 'UNCONFIRMED', 'NOT_MATCHED'] as const;
export type MatchConfidence = Member<typeof MATCH_CONFIDENCES>;
export const isMatchConfidence = makeGuard(MATCH_CONFIDENCES);

export const MATCH_CONFIDENCE_LABELS: Readonly<Record<MatchConfidence, string>> = Object.freeze({
  EXACT: 'Exact match',
  PROBABLE: 'Probable match',
  UNCONFIRMED: 'Unconfirmed match',
  NOT_MATCHED: 'No match',
});

// ---------------------------------------------------------------------------
// Item / formulation verification  (`07` "Item/formulation verification")
// ---------------------------------------------------------------------------

/**
 * How well Kynviora knows a given item facet.
 *
 * Tracked *separately* for identity, formulation and batch (`08` Product Trust Passport):
 * "Product identity confirmed" and "formula confirmed" are different states, and a barcode
 * match never proves the formulation.
 */
export const ITEM_VERIFICATIONS = [
  'CONFIRMED',
  'PROBABLE',
  'PARTIAL',
  'CONFLICTING',
  'UNVERIFIED',
] as const;
export type ItemVerification = Member<typeof ITEM_VERIFICATIONS>;
export const isItemVerification = makeGuard(ITEM_VERIFICATIONS);

// ---------------------------------------------------------------------------
// Catalog corroboration  (`07`, `08` "Living Catalog lifecycle")
// ---------------------------------------------------------------------------

/**
 * Shared-catalog confidence in what a *package says*.
 *
 * `08`: "Corroboration establishes package/formulation evidence quality, not medical safety."
 * Independent observations can raise this; they can never establish that a product is safe.
 */
export const CATALOG_CORROBORATIONS = [
  'CANDIDATE',
  'USER_CONFIRMED',
  'CORROBORATED',
  'EXTERNALLY_VERIFIED',
  'CONFLICTING',
  'RETIRED',
] as const;
export type CatalogCorroboration = Member<typeof CATALOG_CORROBORATIONS>;
export const isCatalogCorroboration = makeGuard(CATALOG_CORROBORATIONS);

// ---------------------------------------------------------------------------
// Regulatory status  (`07`, `09` "Global Regulatory Lens statuses")
// ---------------------------------------------------------------------------

/**
 * What a jurisdiction's monitored sources say about a substance/product.
 *
 * `07`: "A single jurisdiction may have multiple applicable records. Do not force one
 * oversimplified status if the legal conditions are multidimensional." Consumers therefore
 * always handle a *list* of statuses, never a single scalar.
 *
 * Two members carry release-gating semantics (`23` D-014):
 * - `NO_MATCHED_RULE_WITHIN_COVERAGE` must never render as approved / legal / safe.
 * - `UNKNOWN_OR_INSUFFICIENT` must never render as an absence of concern.
 */
export const REGULATORY_STATUSES = [
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
] as const;
export type RegulatoryStatus = Member<typeof REGULATORY_STATUSES>;
export const isRegulatoryStatus = makeGuard(REGULATORY_STATUSES);

/**
 * Statuses that are *not* legal prohibitions and must never be rendered as one.
 *
 * `09`: "'Restricted' is not 'banned'"; a scientific opinion "is not itself the legal status".
 * Guarded by test `must-not-conflate`.
 */
export const NON_PROHIBITION_STATUSES: readonly RegulatoryStatus[] = Object.freeze([
  'RESTRICTED',
  'CONCENTRATION_LIMIT',
  'USE_CONDITION',
  'AGE_OR_ROUTE_CONDITION',
  'WARNING_REQUIRED',
  'POSITIVE_LIST_ONLY',
  'SCIENTIFIC_OPINION',
  'NO_MATCHED_RULE_WITHIN_COVERAGE',
  'UNKNOWN_OR_INSUFFICIENT',
]);

/**
 * Statuses that carry no positive finding and must always be accompanied by a coverage
 * statement explaining what was and was not checked (`09` "Coverage disclosure").
 */
export const ABSENCE_STATUSES: readonly RegulatoryStatus[] = Object.freeze([
  'NO_MATCHED_RULE_WITHIN_COVERAGE',
  'UNKNOWN_OR_INSUFFICIENT',
]);

// ---------------------------------------------------------------------------
// Regulatory applicability  (DEC-007)
// ---------------------------------------------------------------------------

/**
 * Whether a regulatory rule can be determined to bite for *this* package.
 *
 * A second axis alongside {@link RegulatoryStatus}, because they answer different questions from
 * different sources: status comes from the regulation, applicability comes from what the package
 * evidence does and does not disclose.
 *
 * `09` requires a distinct state "when concentration/use details needed by the law are absent",
 * and `03`'s demo scenario requires reporting *"restriction exists"* plus *"compliance cannot be
 * determined from available package information"* rather than claiming a violation. Ingredient
 * declarations list order, not percentages, so `CONDITION_UNKNOWN` is the common case for any
 * concentration-limited rule.
 */
export const REGULATORY_APPLICABILITIES = [
  'APPLIES',
  'DOES_NOT_APPLY',
  'CONDITION_UNKNOWN',
  'IDENTITY_UNCERTAIN',
] as const;
export type RegulatoryApplicability = Member<typeof REGULATORY_APPLICABILITIES>;
export const isRegulatoryApplicability = makeGuard(REGULATORY_APPLICABILITIES);

// ---------------------------------------------------------------------------
// Review / publication state  (`07` "Review/publication state")
// ---------------------------------------------------------------------------

export const REVIEW_STATES = [
  'CANDIDATE',
  'IN_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'REJECTED',
  'SUPERSEDED',
  'WITHDRAWN',
] as const;
export type ReviewState = Member<typeof REVIEW_STATES>;
export const isReviewState = makeGuard(REVIEW_STATES);

/** States in which content may be shown to end users. */
export const USER_VISIBLE_REVIEW_STATES: readonly ReviewState[] = Object.freeze(['PUBLISHED']);

// ---------------------------------------------------------------------------
// Source class  (`25` "Source classes")
// ---------------------------------------------------------------------------

/**
 * The evidentiary role a source is permitted to play.
 *
 * `25`: "A source may support one [system] and be prohibited from influencing another."
 * Enforced at runtime by the authority-scope check in the resolver (DEC-014).
 */
export const SOURCE_CLASSES = [
  'PRIMARY_LEGAL',
  'OFFICIAL_ACTION_REGISTRY',
  'OFFICIAL_GUIDANCE',
  'OFFICIAL_SCIENTIFIC_OPINION',
  'IDENTITY_NORMALIZATION',
  'MANUFACTURER_EVIDENCE',
  'COMMUNITY_DISCOVERY',
  'SEARCH_OR_LLM_RESEARCH',
] as const;
export type SourceClass = Member<typeof SOURCE_CLASSES>;
export const isSourceClass = makeGuard(SOURCE_CLASSES);

/**
 * Source classes permitted to establish a *legal* regulatory status.
 *
 * `09` "Regulatory source hierarchy" and `25` "Legal-status authority hierarchy": an
 * informational ingredient database may help normalize names, but the binding annex/regulation
 * determines legal status. Scientific opinions are deliberately excluded - they get their own
 * `SCIENTIFIC_OPINION` status and never a prohibition.
 */
export const LEGAL_STATUS_SOURCE_CLASSES: readonly SourceClass[] = Object.freeze([
  'PRIMARY_LEGAL',
  'OFFICIAL_ACTION_REGISTRY',
]);

/**
 * Source classes that can never contribute a stored field value - only a candidate reference
 * that must be independently retrieved and validated (`17`, `25`, DEC-014).
 */
export const DISCOVERY_ONLY_SOURCE_CLASSES: readonly SourceClass[] = Object.freeze([
  'COMMUNITY_DISCOVERY',
  'SEARCH_OR_LLM_RESEARCH',
]);

/** Operational health of a registered source (`25` "Source status"). */
export const SOURCE_STATUSES = [
  'ACTIVE',
  'DEGRADED',
  'STALE',
  'DISABLED',
  'REVIEW_REQUIRED',
] as const;
export type SourceStatus = Member<typeof SOURCE_STATUSES>;
export const isSourceStatus = makeGuard(SOURCE_STATUSES);

// ---------------------------------------------------------------------------
// Assessment / product state  (`09` "Product states")
// ---------------------------------------------------------------------------

/**
 * The user-facing safety state of an item.
 *
 * `09`: "Avoid universal safe/unsafe." Note `NO_CURRENT_MATCHED_ALERT` deliberately does not
 * mean "safe" - it means no applicable reviewed alert was found *within current coverage*, and
 * the UI must always pair it with a coverage statement.
 */
export const PRODUCT_SAFETY_STATES = [
  'NO_CURRENT_MATCHED_ALERT',
  'INFORMATION',
  'REVIEW',
  'ACTION_REQUIRED',
  'INSUFFICIENT_DATA',
] as const;
export type ProductSafetyState = Member<typeof PRODUCT_SAFETY_STATES>;
export const isProductSafetyState = makeGuard(PRODUCT_SAFETY_STATES);

// ---------------------------------------------------------------------------
// Provenance  (`07` profile-context domain, `08` field-level provenance)
// ---------------------------------------------------------------------------

/**
 * How a fact came to be known.
 *
 * `01`/`04` Phase 1.3: "No OCR or inferred fact silently becomes a confirmed diagnosis", and
 * rules may explicitly require a minimum provenance level before using a fact.
 */
export const PROVENANCE_KINDS = [
  'USER_REPORTED',
  'CAREGIVER_ENTERED',
  'USER_CONFIRMED_FROM_PACKAGE',
  'PACKAGE_OCR',
  'PACKAGE_VISION_MODEL',
  'BARCODE_DECODE',
  'DETERMINISTIC_PARSER',
  'APPROVED_PROVIDER',
  'MANUFACTURER_EVIDENCE',
  'OFFICIAL_SOURCE',
  'REVIEWER_CONFIRMED',
  'IMPORTED',
] as const;
export type ProvenanceKind = Member<typeof PROVENANCE_KINDS>;
export const isProvenanceKind = makeGuard(PROVENANCE_KINDS);

/**
 * Provenance kinds that are *machine proposals* and can never by themselves make a
 * safety-relevant field trusted (`08`, `17`).
 *
 * `17`: "A model cannot fill a missing field merely because it is likely." A field whose only
 * provenance is in this set requires user or reviewer confirmation, or agreement with an
 * independent extraction mechanism, before a rule may rely on it.
 */
export const UNCONFIRMED_MACHINE_PROVENANCE: readonly ProvenanceKind[] = Object.freeze([
  'PACKAGE_OCR',
  'PACKAGE_VISION_MODEL',
]);

/** Item kinds supported by the MVP (`03`). */
export const ITEM_KINDS = ['MEDICINE', 'PERSONAL_CARE'] as const;
export type ItemKind = Member<typeof ITEM_KINDS>;
export const isItemKind = makeGuard(ITEM_KINDS);

/** Personal-care categories in initial MVP scope (`03`). */
export const PERSONAL_CARE_CATEGORIES = [
  'SKIN_CARE',
  'SUNSCREEN',
  'HAIR_CARE',
  'BODY_CLEANSER',
  'ORAL_CARE',
  'COSMETIC_TOPICAL',
] as const;
export type PersonalCareCategory = Member<typeof PERSONAL_CARE_CATEGORIES>;
export const isPersonalCareCategory = makeGuard(PERSONAL_CARE_CATEGORIES);

/**
 * Whether a product is rinsed off or left on the skin.
 *
 * Not cosmetic metadata - EU Annex III conditions are frequently expressed in exactly these
 * terms (e.g. salicylic acid at 3.0% in rinse-off hair products vs 2.0% in other products), so
 * this is a first-class input to regulatory applicability.
 */
export const PRODUCT_USE_TYPES = ['RINSE_OFF', 'LEAVE_ON', 'ORAL', 'UNKNOWN'] as const;
export type ProductUseType = Member<typeof PRODUCT_USE_TYPES>;
export const isProductUseType = makeGuard(PRODUCT_USE_TYPES);

/**
 * The age bands a profile may carry (`04` Phase 1.2, `16` data minimisation).
 *
 * A band rather than a date of birth, and the bands are the MVP rule set's, not a demographic
 * segmentation: `03` scopes the safety rules to paediatric dosing, pregnancy and older adults, and
 * these are the distinctions those rules actually draw. Storing an exact date where a band answers
 * the question is collecting a stronger identifier than the product needs, which `16` forbids -
 * `profile.birth_year` exists for the cases a rule needs the year and is separately optional.
 *
 * The same list, in the same order, is a CHECK constraint on `profile.age_band` in migration
 * `0002`. A test asserts the two agree: a band the domain offers and the database refuses is a
 * form somebody fills in and cannot submit.
 */
export const AGE_BANDS = [
  'UNDER_3',
  'CHILD_3_12',
  'TEEN_13_17',
  'ADULT_18_64',
  'OLDER_ADULT_65_PLUS',
] as const;
export type AgeBand = Member<typeof AGE_BANDS>;
export const isAgeBand = makeGuard(AGE_BANDS);

/** Caregiver capability grants (`07` CaregiverGrant). */
export const CAREGIVER_CAPABILITIES = [
  'VIEW_SAFETY',
  'VIEW_SHELF',
  'MANAGE_SHELF',
  'VIEW_MEDICINES',
  'MANAGE_MEDICINES',
  'VIEW_CARE',
  'MANAGE_CARE',
  'VIEW_DOCUMENTS',
  'EXPORT_SUMMARY',
  'RECEIVE_MISSED_DOSE',
  'MANAGE_CAREGIVERS',
] as const;
export type CaregiverCapability = Member<typeof CAREGIVER_CAPABILITIES>;
export const isCaregiverCapability = makeGuard(CAREGIVER_CAPABILITIES);

/** Dose event kinds (`04` Phase 4.3). Deliberately non-judgemental (`18`). */
export const DOSE_EVENT_KINDS = ['TAKEN', 'SKIPPED', 'SNOOZED', 'UNABLE_TO_TAKE'] as const;
export type DoseEventKind = Member<typeof DOSE_EVENT_KINDS>;
export const isDoseEventKind = makeGuard(DOSE_EVENT_KINDS);

// ---------------------------------------------------------------------------
// Why what Kynviora says changed (spec 04 Phase 7.4)
// ---------------------------------------------------------------------------

/**
 * Why a regulatory record or an assessment now says something different.
 *
 * `04` Phase 7.4's exit criterion is that users can distinguish a new regulator action from a
 * Kynviora correction. Four members rather than two, because there is a third case that is
 * neither - a source correcting its own publication - and a fourth that must not be silently
 * folded into any of them.
 *
 * `NOT_STATED` is a first-class member. A change nobody attributed is not a regulator action, and
 * defaulting it to one would hand Kynviora's mistakes to the regulator; defaulting it to a
 * correction would claim a mistake nobody found. The screen has to say that nobody recorded it.
 *
 * The vocabulary lives here rather than in `@kynviora/regulatory` so that the presentation layer
 * can name it without depending on the registry - the same reason every other closed vocabulary
 * is in this package.
 */
export const CHANGE_ATTRIBUTIONS = [
  'REGULATOR_ACTED',
  'SOURCE_CORRECTED_ITSELF',
  'KYNVIORA_CORRECTED_ITSELF',
  'NOT_STATED',
] as const;
export type ChangeAttribution = Member<typeof CHANGE_ATTRIBUTIONS>;
export const isChangeAttribution = makeGuard(CHANGE_ATTRIBUTIONS);

/**
 * Correction kinds, mirroring `assessment_correction.correction_kind`.
 *
 * `SOURCE_CORRECTED` is the regulator correcting itself and is a fact about the source. Every
 * other member is Kynviora having been wrong about something - its rule, the item's identity, the
 * formulation, or a fact on the profile - and `WITHDRAWN_NO_LONGER_APPLICABLE` belongs there
 * deliberately: withdrawing an alert because it no longer applies is Kynviora revising what it
 * said, whatever prompted it.
 */
export const CORRECTION_KINDS = [
  'SOURCE_CORRECTED',
  'RULE_CORRECTED',
  'ITEM_IDENTITY_CORRECTED',
  'FORMULATION_CORRECTED',
  'PROFILE_FACT_CORRECTED',
  'WITHDRAWN_NO_LONGER_APPLICABLE',
] as const;
export type CorrectionKind = Member<typeof CORRECTION_KINDS>;
export const isCorrectionKind = makeGuard(CORRECTION_KINDS);
