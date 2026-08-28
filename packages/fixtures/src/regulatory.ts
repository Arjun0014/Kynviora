/**
 * Synthetic and research-derived regulatory fixtures.
 *
 * ============================ HONESTY NOTICE (DEC-016) ============================
 * Every record in this file carries:
 *     verification: 'NEEDS_PRIMARY_VERIFICATION'
 *     reviewState:  'IN_REVIEW'
 *     approvedByReviewerId: null
 *
 * They are therefore **rejected by the Citation Gate** and cannot be displayed to a user as
 * trusted regulatory truth. A test asserts this.
 *
 * Why they exist in this state: the research behind them (see `docs/autonomy/RESEARCH.md` R-004
 * and R-005) produced regulatory facts from *search-result summaries*, not from retrieved
 * official documents. A direct fetch of the EU Annex III page returned no extractable content,
 * and the FDA URL listed in `26_EXTERNAL_REFERENCES.md` returned HTTP 404 on 2026-08-29.
 *
 * "Accurate to the best of current research" is precisely the standard the Citation Gate exists
 * to reject (`25`, `23` D-015). Promoting these to PUBLISHED would require a retained official
 * snapshot with a checksum and a named qualified reviewer - neither of which this build can
 * legitimately produce (`BLK-004`, `BLK-006`). Doing so anyway would be fabricating regulatory
 * approval.
 *
 * They are genuinely useful for exercising the engine end to end, which is exactly what a
 * fixture is for.
 * =================================================================================
 */

import { calendarDate, instantFrom } from '@kynviora/domain';
import type {
  ProductRegulatoryAction,
  RegulatoryRuleVersion,
  ScientificOpinionRecord,
  SourceDocument,
  SourceRegistryEntry,
} from '@kynviora/regulatory';

const FIXTURE_TIME = instantFrom('2026-08-29T00:00:00.000Z');

/** A 64-hex-character placeholder standing in for a real snapshot checksum. */
const PLACEHOLDER_CHECKSUM = 'f'.repeat(64);

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

export const SOURCE_EU_EURLEX: SourceRegistryEntry = {
  id: 'src-eu-eurlex-1223-2009',
  organization: 'European Union (EUR-Lex)',
  sourceName: 'Regulation (EC) No 1223/2009 on cosmetic products, consolidated text and Annexes',
  sourceClass: 'PRIMARY_LEGAL',
  jurisdiction: 'EU',
  allowedInfluence: ['REGULATORY_STATUS'],
  licenseReviewState: 'NOT_REVIEWED',
  snapshotRetentionAllowed: false,
  expectedRefreshIntervalMs: 7 * 24 * 60 * 60 * 1000,
  parserVersion: 'eurlex-annex-0.1',
  status: 'REVIEW_REQUIRED',
  lastSuccessfulCheckAt: FIXTURE_TIME,
  coverageStatement:
    'Kynviora monitors the consolidated text and Annexes of Regulation (EC) No 1223/2009 for EU cosmetic ingredient conditions. Coverage does not extend to national implementing measures.',
};

/**
 * CosIng.
 *
 * Present specifically to prove the authority hierarchy is enforced at runtime: the European
 * Commission states CosIng is informational and not legally binding, so it is registered with
 * `NORMALIZATION` influence only and the Citation Gate must refuse any regulatory status
 * sourced from it (`25`).
 */
export const SOURCE_EU_COSING: SourceRegistryEntry = {
  id: 'src-eu-cosing',
  organization: 'European Commission',
  sourceName: 'CosIng cosmetic ingredient database',
  sourceClass: 'IDENTITY_NORMALIZATION',
  jurisdiction: 'EU',
  allowedInfluence: ['IDENTITY', 'NORMALIZATION'],
  licenseReviewState: 'NOT_REVIEWED',
  snapshotRetentionAllowed: false,
  expectedRefreshIntervalMs: 30 * 24 * 60 * 60 * 1000,
  parserVersion: 'cosing-0.1',
  status: 'REVIEW_REQUIRED',
  lastSuccessfulCheckAt: FIXTURE_TIME,
  coverageStatement:
    'CosIng supports ingredient naming and identity only. The Commission states it is informational and has no legal value; Regulation 1223/2009 and its Annexes establish legal use conditions.',
};

export const SOURCE_GB_LEGISLATION: SourceRegistryEntry = {
  id: 'src-gb-legislation',
  organization: 'United Kingdom (legislation.gov.uk)',
  sourceName: 'Retained Regulation (EC) No 1223/2009 as it applies in Great Britain',
  sourceClass: 'PRIMARY_LEGAL',
  jurisdiction: 'GB',
  allowedInfluence: ['REGULATORY_STATUS'],
  licenseReviewState: 'NOT_REVIEWED',
  snapshotRetentionAllowed: false,
  expectedRefreshIntervalMs: 7 * 24 * 60 * 60 * 1000,
  parserVersion: 'gb-retained-0.1',
  status: 'REVIEW_REQUIRED',
  lastSuccessfulCheckAt: FIXTURE_TIME,
  coverageStatement:
    'Kynviora monitors the retained Great Britain version of the Cosmetics Regulation. Great Britain may diverge from later EU amendments.',
};

export const SOURCE_NI_GUIDANCE: SourceRegistryEntry = {
  id: 'src-ni-guidance',
  organization: 'United Kingdom (Northern Ireland guidance) / EU',
  sourceName: 'EU Cosmetics Regulation as applicable in Northern Ireland under the Windsor Framework',
  sourceClass: 'PRIMARY_LEGAL',
  jurisdiction: 'NI',
  allowedInfluence: ['REGULATORY_STATUS'],
  licenseReviewState: 'NOT_REVIEWED',
  snapshotRetentionAllowed: false,
  expectedRefreshIntervalMs: 7 * 24 * 60 * 60 * 1000,
  parserVersion: 'ni-windsor-0.1',
  status: 'REVIEW_REQUIRED',
  lastSuccessfulCheckAt: FIXTURE_TIME,
  coverageStatement:
    'Northern Ireland applies the EU Cosmetics Regulation in the areas covered by the Windsor Framework. Kynviora records NI separately from Great Britain.',
};

export const SOURCE_US_FDA: SourceRegistryEntry = {
  id: 'src-us-fda-cosmetics',
  organization: 'United States Food and Drug Administration',
  sourceName: 'FDA prohibited and restricted cosmetic ingredients (21 CFR Part 700)',
  sourceClass: 'PRIMARY_LEGAL',
  jurisdiction: 'US',
  allowedInfluence: ['REGULATORY_STATUS'],
  licenseReviewState: 'NOT_REVIEWED',
  snapshotRetentionAllowed: false,
  expectedRefreshIntervalMs: 7 * 24 * 60 * 60 * 1000,
  parserVersion: 'fda-cfr700-0.1',
  status: 'REVIEW_REQUIRED',
  lastSuccessfulCheckAt: FIXTURE_TIME,
  coverageStatement:
    'Kynviora monitors the FDA list of prohibited and restricted cosmetic ingredients. Most cosmetic ingredients are not FDA-approved before marketing, so absence from this list is not approval.',
};

export const SOURCE_IN_CDSCO: SourceRegistryEntry = {
  id: 'src-in-cdsco',
  organization: 'Central Drugs Standard Control Organisation (India)',
  sourceName: 'CDSCO Cosmetics Rules and product alerts',
  sourceClass: 'OFFICIAL_ACTION_REGISTRY',
  jurisdiction: 'IN',
  allowedInfluence: ['REGULATORY_STATUS', 'SAFETY_RULE'],
  licenseReviewState: 'NOT_REVIEWED',
  snapshotRetentionAllowed: false,
  expectedRefreshIntervalMs: 24 * 60 * 60 * 1000,
  parserVersion: 'cdsco-0.1',
  status: 'REVIEW_REQUIRED',
  lastSuccessfulCheckAt: FIXTURE_TIME,
  coverageStatement:
    'Kynviora monitors CDSCO cosmetics rules and published product actions for India. Source formats are fragmented and coverage is partial.',
};

export const SOURCE_JP_MHLW: SourceRegistryEntry = {
  id: 'src-jp-mhlw',
  organization: 'Ministry of Health, Labour and Welfare (Japan)',
  sourceName: 'Standards for Cosmetics and related notices',
  sourceClass: 'PRIMARY_LEGAL',
  jurisdiction: 'JP',
  allowedInfluence: ['REGULATORY_STATUS'],
  licenseReviewState: 'NOT_REVIEWED',
  snapshotRetentionAllowed: false,
  expectedRefreshIntervalMs: 30 * 24 * 60 * 60 * 1000,
  parserVersion: 'mhlw-0.1',
  status: 'REVIEW_REQUIRED',
  lastSuccessfulCheckAt: FIXTURE_TIME,
  coverageStatement:
    'Kynviora monitors the MHLW Standards for Cosmetics. Japanese-language primary material is authoritative; translations assist reviewers only.',
};

/** Search/LLM research, registered so the gate can prove it is refused as a citation. */
export const SOURCE_RESEARCH_AGENT: SourceRegistryEntry = {
  id: 'src-research-agent',
  organization: 'Kynviora research agent',
  sourceName: 'Search-grounded research discovery',
  sourceClass: 'SEARCH_OR_LLM_RESEARCH',
  jurisdiction: null,
  allowedInfluence: ['DISCOVERY_ONLY'],
  licenseReviewState: 'APPROVED',
  snapshotRetentionAllowed: true,
  expectedRefreshIntervalMs: 0,
  parserVersion: 'research-0.1',
  status: 'ACTIVE',
  lastSuccessfulCheckAt: FIXTURE_TIME,
  coverageStatement:
    'Research output locates official material. It is never itself a source of regulatory truth.',
};

export const ALL_FIXTURE_SOURCES: readonly SourceRegistryEntry[] = Object.freeze([
  SOURCE_EU_EURLEX,
  SOURCE_EU_COSING,
  SOURCE_GB_LEGISLATION,
  SOURCE_NI_GUIDANCE,
  SOURCE_US_FDA,
  SOURCE_IN_CDSCO,
  SOURCE_JP_MHLW,
  SOURCE_RESEARCH_AGENT,
]);

export const FIXTURE_SOURCE_MAP: ReadonlyMap<string, SourceRegistryEntry> = new Map(
  ALL_FIXTURE_SOURCES.map((s) => [s.id, s]),
);

// ---------------------------------------------------------------------------
// Source documents
// ---------------------------------------------------------------------------

export const DOC_EU_ANNEX_III: SourceDocument = {
  id: 'doc-eu-annex-iii',
  sourceRegistryEntryId: SOURCE_EU_EURLEX.id,
  canonicalUri: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32009R1223',
  retrievedAt: FIXTURE_TIME,
  // Placeholder, not a checksum of retrieved material - the document was not retrieved.
  contentSha256: PLACEHOLDER_CHECKSUM,
  snapshotStorageKey: null,
  sourceVersionLabel: null,
  supersedesDocumentId: null,
};

export const DOC_US_CFR_700: SourceDocument = {
  id: 'doc-us-cfr-700',
  sourceRegistryEntryId: SOURCE_US_FDA.id,
  canonicalUri: 'https://www.ecfr.gov/current/title-21/chapter-I/subchapter-G/part-700',
  retrievedAt: FIXTURE_TIME,
  contentSha256: PLACEHOLDER_CHECKSUM,
  snapshotStorageKey: null,
  sourceVersionLabel: null,
  supersedesDocumentId: null,
};

// ---------------------------------------------------------------------------
// Salicylic acid - the multi-condition cross-jurisdiction case
// ---------------------------------------------------------------------------
// Chosen because it exercises RESTRICTED + CONCENTRATION_LIMIT + USE_CONDITION +
// AGE_OR_ROUTE_CONDITION simultaneously in the EU, while the US has no matched cosmetic
// prohibition. That single substance therefore demonstrates both hard rules the Lens exists to
// enforce: "restricted is not banned" and "no matched rule is not approval".

export const SUBSTANCE_SALICYLIC_ACID = 'SALICYLIC_ACID';

/**
 * EU: Annex III entry 98.
 *
 * Research basis (R-004): permitted for non-preservative purposes up to 3.0% in rinse-off hair
 * products and 2.0% in other products; not in oral products; not where lung exposure by
 * inhalation may occur; not for children under 3 years.
 *
 * NEEDS_PRIMARY_VERIFICATION - assembled from a search summary, not a retrieved Annex.
 */
export const RULE_EU_SALICYLIC_ACID: RegulatoryRuleVersion = {
  id: 'rule-eu-sa-annex3-98',
  jurisdiction: 'EU',
  substanceCanonicalKey: SUBSTANCE_SALICYLIC_ACID,
  statuses: ['RESTRICTED', 'CONCENTRATION_LIMIT', 'USE_CONDITION', 'AGE_OR_ROUTE_CONDITION'],
  conditions: {
    maxConcentrationPercent: 2.0,
    productUseTypes: ['LEAVE_ON', 'RINSE_OFF'],
    productCategories: ['rinse-off hair products (3.0%)', 'other products (2.0%)'],
    minimumAgeYears: 3,
    prohibitedRoutes: ['oral', 'inhalation'],
    additionalConditions: [
      'Not to be used in preparations for children under 3 years of age, other than stated exceptions.',
      'Not for use in applications that may lead to exposure of the end-user lungs by inhalation.',
      'Purposes other than inhibiting the development of micro-organisms; a separate preservative entry applies at 0.5%.',
    ],
  },
  legalInstrument: 'Regulation (EC) No 1223/2009',
  legalReference: 'Annex III, entry 98',
  publicationDate: calendarDate('2009-12-22'),
  effectiveDate: calendarDate('2009-12-22'),
  sourceRegistryEntryId: SOURCE_EU_EURLEX.id,
  sourceDocumentId: DOC_EU_ANNEX_III.id,
  extractionVersion: 'manual-research-0.1',
  reviewState: 'IN_REVIEW',
  verification: 'NEEDS_PRIMARY_VERIFICATION',
  approvedByReviewerId: null,
  approvedAt: null,
  supersedesRuleVersionId: null,
  createdAt: FIXTURE_TIME,
};

/** Northern Ireland applies the EU rule under the Windsor Framework - recorded separately. */
export const RULE_NI_SALICYLIC_ACID: RegulatoryRuleVersion = {
  ...RULE_EU_SALICYLIC_ACID,
  id: 'rule-ni-sa-annex3-98',
  jurisdiction: 'NI',
  sourceRegistryEntryId: SOURCE_NI_GUIDANCE.id,
  legalInstrument: 'Regulation (EC) No 1223/2009 as applicable in Northern Ireland',
};

/**
 * Great Britain: retained version.
 *
 * Deliberately given an **earlier effective date** than the EU record, to model the divergence
 * that `23` D-013 exists for: GB retained the rule at exit and may not have adopted later EU
 * amendments. A test asserts GB and NI can display different results.
 */
export const RULE_GB_SALICYLIC_ACID: RegulatoryRuleVersion = {
  ...RULE_EU_SALICYLIC_ACID,
  id: 'rule-gb-sa-retained',
  jurisdiction: 'GB',
  sourceRegistryEntryId: SOURCE_GB_LEGISLATION.id,
  legalInstrument: 'Retained Regulation (EC) No 1223/2009 (Great Britain)',
  legalReference: 'Annex III, entry 98 (retained)',
  effectiveDate: calendarDate('2021-01-01'),
  publicationDate: calendarDate('2021-01-01'),
};

/**
 * A scientific opinion with **no implementing law**.
 *
 * Synthetic. Exists to prove the Lens labels an opinion as non-law and never converts it into a
 * prohibition (`09`, `16`).
 */
export const OPINION_EU_SYNTHETIC: ScientificOpinionRecord = {
  id: 'opinion-eu-synthetic-1',
  jurisdiction: 'EU',
  substanceCanonicalKey: SUBSTANCE_SALICYLIC_ACID,
  committee: 'Scientific Committee on Consumer Safety (synthetic fixture)',
  opinionReference: 'SCCS/SYNTHETIC/2026',
  summary:
    'SYNTHETIC FIXTURE. A committee opinion reviewing exposure for a substance. No corresponding legal instrument is recorded.',
  publicationDate: calendarDate('2026-03-01'),
  sourceRegistryEntryId: SOURCE_EU_EURLEX.id,
  sourceDocumentId: null,
  reviewState: 'IN_REVIEW',
  verification: 'UNVERIFIED',
  implementedByRuleVersionId: null,
  createdAt: FIXTURE_TIME,
};

/**
 * US mercury restriction (21 CFR 700.13).
 *
 * Research basis (R-005): prohibited except trace amounts below 1 ppm, and except as an
 * eye-area preservative up to 65 ppm. Included to give the US a genuine *restriction* alongside
 * its "no matched rule" answer for salicylic acid.
 */
export const SUBSTANCE_MERCURY = 'MERCURY';

export const RULE_US_MERCURY: RegulatoryRuleVersion = {
  id: 'rule-us-mercury-700-13',
  jurisdiction: 'US',
  substanceCanonicalKey: SUBSTANCE_MERCURY,
  statuses: ['RESTRICTED', 'CONCENTRATION_LIMIT', 'USE_CONDITION'],
  conditions: {
    maxConcentrationPercent: 0.0065,
    productCategories: ['eye-area cosmetics (preservative use, up to 65 ppm)'],
    productUseTypes: ['LEAVE_ON', 'RINSE_OFF'],
    additionalConditions: [
      'Prohibited except for trace amounts below 1 ppm where unavoidable under good manufacturing practice.',
      'Permitted as a preservative in eye-area cosmetics up to 65 ppm where no other effective preservative is available.',
    ],
  },
  legalInstrument: '21 CFR Part 700',
  legalReference: '21 CFR 700.13',
  publicationDate: calendarDate('1974-01-10'),
  effectiveDate: calendarDate('1974-01-10'),
  sourceRegistryEntryId: SOURCE_US_FDA.id,
  sourceDocumentId: DOC_US_CFR_700.id,
  extractionVersion: 'manual-research-0.1',
  reviewState: 'IN_REVIEW',
  verification: 'NEEDS_PRIMARY_VERIFICATION',
  approvedByReviewerId: null,
  approvedAt: null,
  supersedesRuleVersionId: null,
  createdAt: FIXTURE_TIME,
};

/**
 * A fully synthetic Indian batch recall.
 *
 * Explicitly labelled SYNTHETIC so it can never be mistaken for a real CDSCO action. Used to
 * exercise batch-scoped matching in the safety engine.
 */
export const ACTION_IN_SYNTHETIC_RECALL: ProductRegulatoryAction = {
  id: 'action-in-synthetic-recall-1',
  jurisdiction: 'IN',
  actionKind: 'RECALL',
  authority: 'CDSCO (SYNTHETIC FIXTURE - not a real action)',
  productIdentityId: null,
  formulationId: null,
  gtin: '08901234567892',
  batchCodes: ['SYN-BATCH-A24X91', 'SYN-BATCH-A24X92'],
  manufacturerName: 'Synthetic Test Labs Pvt Ltd',
  summary:
    'SYNTHETIC FIXTURE. A batch-scoped recall used to test batch matching. This does not describe any real product or regulatory action.',
  publicationDate: calendarDate('2026-08-15'),
  effectiveDate: calendarDate('2026-08-15'),
  sourceRegistryEntryId: SOURCE_IN_CDSCO.id,
  sourceDocumentId: null,
  reviewState: 'IN_REVIEW',
  verification: 'UNVERIFIED',
  createdAt: FIXTURE_TIME,
};

export const ALL_FIXTURE_RULES: readonly RegulatoryRuleVersion[] = Object.freeze([
  RULE_EU_SALICYLIC_ACID,
  RULE_NI_SALICYLIC_ACID,
  RULE_GB_SALICYLIC_ACID,
  RULE_US_MERCURY,
]);

export const ALL_FIXTURE_OPINIONS: readonly ScientificOpinionRecord[] = Object.freeze([
  OPINION_EU_SYNTHETIC,
]);

export const ALL_FIXTURE_ACTIONS: readonly ProductRegulatoryAction[] = Object.freeze([
  ACTION_IN_SYNTHETIC_RECALL,
]);

/**
 * Promote a fixture to a state that would pass the Citation Gate.
 *
 * **Test-only.** Used to exercise the *published* path without ever shipping a fixture in that
 * state. The reviewer ID is explicitly named `synthetic-test-reviewer` so it can never be
 * mistaken for a real clinical or regulatory approval (spec 10, operating brief section 39).
 */
export function asPublishedForTest(rule: RegulatoryRuleVersion): RegulatoryRuleVersion {
  return {
    ...rule,
    reviewState: 'PUBLISHED',
    verification: 'VERIFIED_AGAINST_OFFICIAL_SOURCE',
    approvedByReviewerId: 'synthetic-test-reviewer',
    approvedAt: FIXTURE_TIME,
  };
}

/** Test-only equivalent for a source entry, so gate checks on licence and health can pass. */
export function asApprovedSourceForTest(source: SourceRegistryEntry): SourceRegistryEntry {
  return { ...source, licenseReviewState: 'APPROVED', status: 'ACTIVE' };
}

/** Test-only equivalent for a source document with a real-shaped checksum. */
export function withChecksumForTest(doc: SourceDocument, checksum?: string): SourceDocument {
  return { ...doc, contentSha256: checksum ?? 'a'.repeat(64) };
}
