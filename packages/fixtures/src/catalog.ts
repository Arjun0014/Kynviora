/**
 * Synthetic catalog fixtures: profiles, products and package observations.
 *
 * SPEC 21 / OPERATING BRIEF: every person, product, brand, barcode and batch code here is
 * invented. No real patient or family health information appears anywhere in this package.
 *
 * Brand names use an obviously fictional prefix so a fixture can never be mistaken for a real
 * marketed product, and GTINs use a test prefix that is not an allocated GS1 company prefix.
 */

import { aliasResolverFrom, type AliasResolver } from '@kynviora/catalog';
import { instantFrom, marketCode, type MarketCode } from '@kynviora/domain';

export const FIXTURE_NOW = instantFrom('2026-08-29T00:00:00.000Z');
export const MARKET_IN: MarketCode = marketCode('IN');

// ---------------------------------------------------------------------------
// Canonical substances
// ---------------------------------------------------------------------------

export const SUBSTANCES = {
  WATER: { substanceId: 'sub-water', canonicalKey: 'WATER' },
  GLYCERIN: { substanceId: 'sub-glycerin', canonicalKey: 'GLYCERIN' },
  SALICYLIC_ACID: { substanceId: 'sub-salicylic-acid', canonicalKey: 'SALICYLIC_ACID' },
  NIACINAMIDE: { substanceId: 'sub-niacinamide', canonicalKey: 'NIACINAMIDE' },
  PARFUM: { substanceId: 'sub-parfum', canonicalKey: 'PARFUM' },
  SODIUM_LAURETH_SULFATE: { substanceId: 'sub-sls', canonicalKey: 'SODIUM_LAURETH_SULFATE' },
  CITRIC_ACID: { substanceId: 'sub-citric-acid', canonicalKey: 'CITRIC_ACID' },
} as const;

/**
 * Seeded alias vocabulary.
 *
 * Deliberately incomplete: `tocopherol` maps to two concepts so ambiguity is representable, and
 * several plausible ingredients are absent so the `UNRESOLVED` path is exercised. A vocabulary
 * that resolved everything would hide exactly the behaviour that matters.
 */
export const FIXTURE_ALIAS_RESOLVER: AliasResolver = aliasResolverFrom(
  new Map([
    ['aqua', [SUBSTANCES.WATER]],
    ['water', [SUBSTANCES.WATER]],
    ['glycerin', [SUBSTANCES.GLYCERIN]],
    ['glycerine', [SUBSTANCES.GLYCERIN]],
    ['salicylic acid', [SUBSTANCES.SALICYLIC_ACID]],
    ['2 hydroxybenzoic acid', [SUBSTANCES.SALICYLIC_ACID]],
    ['niacinamide', [SUBSTANCES.NIACINAMIDE]],
    ['parfum', [SUBSTANCES.PARFUM]],
    ['fragrance', [SUBSTANCES.PARFUM]],
    ['sodium laureth sulfate', [SUBSTANCES.SODIUM_LAURETH_SULFATE]],
    ['citric acid', [SUBSTANCES.CITRIC_ACID]],
    // Genuinely ambiguous: two distinct concepts share this label term.
    [
      'tocopherol',
      [
        { substanceId: 'sub-alpha-tocopherol', canonicalKey: 'ALPHA_TOCOPHEROL' },
        { substanceId: 'sub-mixed-tocopherols', canonicalKey: 'MIXED_TOCOPHEROLS' },
      ],
    ],
  ]),
);

// ---------------------------------------------------------------------------
// Synthetic people
// ---------------------------------------------------------------------------

export const PROFILE_PRIYA = {
  profileId: 'profile-priya',
  displayName: 'Priya (synthetic)',
  ageBand: 'OLDER_ADULT_65_PLUS' as const,
} as const;

export const PROFILE_ARJUN = {
  profileId: 'profile-arjun',
  displayName: 'Arjun (synthetic)',
  ageBand: 'ADULT_18_64' as const,
} as const;

/** A recorded, user-reported salicylate sensitivity for Priya. */
export const FACT_PRIYA_SALICYLATE_SENSITIVITY = {
  id: 'fact-priya-salicylate',
  kind: 'SENSITIVITY' as const,
  substanceCanonicalKey: SUBSTANCES.SALICYLIC_ACID.canonicalKey,
  displayTerm: 'salicylates',
  provenance: 'USER_REPORTED' as const,
  recordedAt: FIXTURE_NOW,
  version: 'pf-priya-salicylate-1',
};

// ---------------------------------------------------------------------------
// Synthetic products
// ---------------------------------------------------------------------------

/**
 * A face serum whose original formulation contains salicylic acid.
 *
 * The GTIN uses the `0890123456789x` test range. It is check-digit valid so the barcode
 * validator accepts it, while not being an allocated company prefix.
 */
export const PRODUCT_CLARIFYING_SERUM = {
  productIdentityId: 'prod-clarifying-serum',
  brand: 'Fictional Labs',
  displayName: 'Clarifying Face Serum (synthetic)',
  manufacturerKey: 'fictional-labs',
  gtin: '8901234567890',
  category: 'SKIN_CARE' as const,
  productUseType: 'LEAVE_ON' as const,
} as const;

/** Original declaration: contains salicylic acid, concentration NOT disclosed. */
export const DECLARATION_SERUM_V1 =
  'Ingredients: Aqua, Glycerin, Salicylic Acid, Niacinamide, Citric Acid, Parfum';

/**
 * Reformulated declaration: salicylic acid removed, niacinamide promoted.
 *
 * Same barcode, materially different formula - the spec 31 reformulation scenario.
 */
export const DECLARATION_SERUM_V2 = 'Ingredients: Aqua, Niacinamide, Glycerin, Citric Acid, Parfum';

/** A declaration that DOES disclose a concentration, to exercise the APPLIES path. */
export const DECLARATION_SERUM_WITH_CONCENTRATION =
  'Ingredients: Aqua, Glycerin, Salicylic Acid (2%), Niacinamide, Citric Acid, Parfum';

/** A shampoo, used to prove a rinse-off product is scoped differently from a leave-on one. */
export const PRODUCT_GENTLE_SHAMPOO = {
  productIdentityId: 'prod-gentle-shampoo',
  brand: 'Fictional Labs',
  displayName: 'Gentle Daily Shampoo (synthetic)',
  manufacturerKey: 'fictional-labs',
  gtin: '8901234567906',
  category: 'HAIR_CARE' as const,
  productUseType: 'RINSE_OFF' as const,
} as const;

export const DECLARATION_SHAMPOO =
  'Aqua, Sodium Laureth Sulfate, Glycerin, Salicylic Acid, Citric Acid, Parfum';

/** Batch codes matching the synthetic CDSCO recall fixture. */
export const BATCH_AFFECTED = 'SYN-BATCH-A24X91';
export const BATCH_UNAFFECTED = 'SYN-BATCH-Z99999';
