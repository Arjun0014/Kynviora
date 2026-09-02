/**
 * Ingredient declaration parsing and normalization.
 *
 * Spec references: `04` Phase 5.1 and 5.2, `08` "Ingredient/substance normalization".
 *
 * Two rules govern everything here:
 *
 *  1. **The raw declaration is evidence and is never overwritten** (`04` Phase 5.1: "Raw label
 *     evidence is never overwritten by normalization"). Parsing produces a *parallel* structure;
 *     the original string is retained verbatim on the formulation row.
 *
 *  2. **Unknown stays unknown** (`04` Phase 5.1: "Unknown ingredients remain unknown rather than
 *     guessed"). A token that does not map to a canonical substance is recorded as `UNRESOLVED`.
 *     It is never dropped, never guessed at, and never silently excluded from the fingerprint -
 *     dropping it would make two genuinely different formulations look identical.
 *
 * Order is material. INCI declarations are ordered by decreasing concentration, so position
 * carries real information and a reordering is a genuine formulation difference.
 */

import { markUntrusted, type Untrusted, exposeUntrusted } from '@kynviora/domain';

/** A single parsed token from a declaration, retaining its position and original text. */
export interface IngredientToken {
  /** Zero-based position in the declaration. Material data, not presentation. */
  readonly position: number;
  /** Exactly as printed, after only whitespace trimming. */
  readonly rawTerm: string;
  /** Casefolded/punctuation-stripped form used for alias lookup. */
  readonly lookupKey: string;
  /**
   * Concentration if - and only if - the label explicitly discloses one.
   *
   * Almost always `null`. Spec 09 requires `CONDITION_UNKNOWN` rather than an invented
   * compliance judgement when a concentration-limited rule meets a package that does not
   * disclose the concentration, and this field is where that determination bottoms out.
   */
  readonly disclosedConcentrationPercent: number | null;
  /** Parenthetical/qualifier text kept separately so it cannot pollute the lookup key. */
  readonly qualifier: string | null;
}

/**
 * Separators used in real ingredient declarations.
 *
 * Commas dominate, but bullet characters and middots appear on Indian and East Asian packaging,
 * and a semicolon is occasionally used to group. Newlines are treated as separators because OCR
 * of a multi-line panel frequently yields them.
 */
const SEPARATOR_PATTERN = /[,;•·・\n\r]+/;

/**
 * Phrases that introduce a declaration rather than being an ingredient.
 *
 * Stripping these prevents "Ingredients" being recorded as an unresolved substance, which would
 * both pollute the catalog and shift every real ingredient's position by one - corrupting the
 * order-sensitive fingerprint.
 */
const DECLARATION_PREFIXES = [
  'ingredients',
  'ingredient',
  'inci',
  'composition',
  'contains',
  'active ingredients',
  'inactive ingredients',
  'other ingredients',
];

/** Matches an explicitly disclosed concentration such as `(2%)`, `2.0 %`, `w/w 1.5%`. */
const CONCENTRATION_PATTERN = /(\d+(?:[.,]\d+)?)\s*%/;

/**
 * Placeholder protecting a decimal comma from the list-separator split.
 *
 * European and Indian packaging writes `1,5%` where other markets write `1.5%`, but the comma is
 * also the dominant ingredient separator. Splitting first would turn `Salicylic Acid 1,5%` into
 * `Salicylic Acid 1` and `5%` - producing a phantom ingredient *and* losing the concentration,
 * which is precisely the datum a concentration-limited regulatory rule needs.
 *
 * The disambiguating rule is deterministic: a comma sitting directly between two digits with no
 * surrounding space is a decimal separator; every other comma is a list separator. `Aqua,Glycerin`
 * is unaffected because neither neighbour is a digit.
 *
 * U+241F (SYMBOL FOR UNIT SEPARATOR) is used as the placeholder because it is a printable symbol
 * character that does not occur in ingredient text and is not stripped by prompt sanitisation.
 */
const DECIMAL_COMMA_PLACEHOLDER = '\u241F';
const DECIMAL_COMMA_PATTERN = /(\d),(\d)/g;

/** Trailing parenthetical or bracketed qualifier, e.g. `Aqua (Water)`, `CI 77491 [nano]`. */
const QUALIFIER_PATTERN = /[([{]([^)\]}]*)[)\]}]\s*$/;

/**
 * Build the alias lookup key for a term.
 *
 * Casefolds, removes punctuation and collapses whitespace. Unicode NFKD normalization plus
 * combining-mark removal means accented forms found on European labels (e.g. `Aloé`) key the
 * same as their unaccented spelling.
 */
export function ingredientLookupKey(term: string): string {
  return term
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Parse an ingredient declaration into ordered tokens.
 *
 * The input is `Untrusted` because declarations arrive from OCR, vision models or user free
 * text, all of which `17` requires be treated as potentially hostile data (DEC-017).
 */
export function parseIngredientDeclaration(
  declaration: Untrusted<string>,
): readonly IngredientToken[] {
  const raw = exposeUntrusted(declaration);

  // Strip a leading "Ingredients:" style prefix before splitting, so positions stay correct.
  let body = raw.trim();
  for (const prefix of DECLARATION_PREFIXES) {
    const pattern = new RegExp(`^${prefix}\\s*[:\\-–—]\\s*`, 'i');
    if (pattern.test(body)) {
      body = body.replace(pattern, '');
      break;
    }
  }

  // Protect decimal commas before splitting on list separators (see DECIMAL_COMMA_PLACEHOLDER).
  // Applied repeatedly so runs like `1,5,7` are fully protected: a single pass leaves the second
  // comma unhandled because the regex consumes the digit it would need to match again.
  let previous: string;
  do {
    previous = body;
    body = body.replace(DECIMAL_COMMA_PATTERN, `$1${DECIMAL_COMMA_PLACEHOLDER}$2`);
  } while (body !== previous);

  const tokens: IngredientToken[] = [];
  let position = 0;

  for (const rawSegment of body.split(SEPARATOR_PATTERN)) {
    // Restore decimal commas so raw terms are reported exactly as printed.
    const segment = rawSegment.split(DECIMAL_COMMA_PLACEHOLDER).join(',');
    const trimmed = segment.trim().replace(/\.$/, '').trim();
    if (trimmed.length === 0) continue;

    // A fragment with no letters at all (stray punctuation, an orphaned number from OCR) is not
    // an ingredient. Retaining it would shift every subsequent position.
    if (!/[a-z]/i.test(trimmed)) continue;

    const concentrationMatch = CONCENTRATION_PATTERN.exec(trimmed);
    const disclosedConcentrationPercent = concentrationMatch?.[1]
      ? Number.parseFloat(concentrationMatch[1].replace(',', '.'))
      : null;

    // Remove the concentration before extracting the qualifier so `(2%)` does not become one.
    const withoutConcentration = trimmed.replace(CONCENTRATION_PATTERN, '').trim();

    const qualifierMatch = QUALIFIER_PATTERN.exec(withoutConcentration);
    const qualifier = qualifierMatch?.[1]?.trim() ?? null;
    const nameOnly = withoutConcentration.replace(QUALIFIER_PATTERN, '').trim();

    // Guard against a segment that was *only* a qualifier or concentration.
    const effectiveName = nameOnly.length > 0 ? nameOnly : withoutConcentration.trim();
    if (effectiveName.length === 0) continue;

    tokens.push({
      position,
      rawTerm: trimmed,
      lookupKey: ingredientLookupKey(effectiveName),
      disclosedConcentrationPercent:
        disclosedConcentrationPercent !== null && Number.isFinite(disclosedConcentrationPercent)
          ? disclosedConcentrationPercent
          : null,
      qualifier: qualifier && qualifier.length > 0 ? qualifier : null,
    });
    position += 1;
  }

  return tokens;
}

/** Outcome of mapping one parsed token onto a canonical substance. */
export const MAPPING_STATES = ['EXACT', 'AMBIGUOUS', 'UNRESOLVED'] as const;
export type MappingState = (typeof MAPPING_STATES)[number];

export interface NormalizedIngredient extends IngredientToken {
  readonly substanceId: string | null;
  readonly canonicalKey: string | null;
  readonly mappingState: MappingState;
}

/**
 * A lookup from an alias key to canonical substances.
 *
 * A key mapping to more than one substance is genuine ambiguity and resolves to `AMBIGUOUS`,
 * never to an arbitrary pick.
 */
export interface AliasResolver {
  resolve(lookupKey: string): readonly { substanceId: string; canonicalKey: string }[];
}

/** Build a resolver from a plain map, for seeding and tests. */
export function aliasResolverFrom(
  entries: ReadonlyMap<string, readonly { substanceId: string; canonicalKey: string }[]>,
): AliasResolver {
  return { resolve: (key) => entries.get(key) ?? [] };
}

/** One resolution outcome, with no token attached. */
export interface SubstanceResolution {
  readonly substanceId: string | null;
  readonly canonicalKey: string | null;
  readonly mappingState: MappingState;
}

/**
 * Resolve one already-computed lookup key.
 *
 * The single place the three-way decision is made, so an ingredient on a label and a term somebody
 * typed about their own body cannot be resolved by two rules that agree today. A match only means
 * anything if both sides went through the same vocabulary and the same key function - two
 * resolvers that drifted would produce a rule that fires on one spelling and not the other.
 */
export function resolveLookupKey(lookupKey: string, resolver: AliasResolver): SubstanceResolution {
  const matches = resolver.resolve(lookupKey);

  if (matches.length === 1) {
    const match = matches[0]!;
    return {
      substanceId: match.substanceId,
      canonicalKey: match.canonicalKey,
      mappingState: 'EXACT',
    };
  }

  if (matches.length > 1) {
    // Spec 04 Phase 5.2 requires a human review queue for material unresolved mappings.
    // Picking the first match here would be exactly the silent guess the spec forbids.
    return { substanceId: null, canonicalKey: null, mappingState: 'AMBIGUOUS' };
  }

  return { substanceId: null, canonicalKey: null, mappingState: 'UNRESOLVED' };
}

/**
 * Resolve a term a person typed about themselves (`04` Phase 5.2, `04` Phase 1.3).
 *
 * The same function as the one behind an ingredient label, deliberately: `evaluateIngredientSensitivity`
 * intersects a declaration's canonical keys with a profile fact's, so a term resolved by a different
 * rule would produce a rule that matches on one spelling of a substance and not another.
 *
 * `Untrusted` because it is free text a person typed. Nothing here writes to the vocabulary: an
 * unrecognised term stays unrecognised, because a household typing a word is not the catalog
 * learning a substance (`08`, `15` A11).
 */
export function resolveRecordedTerm(
  term: Untrusted<string>,
  resolver: AliasResolver,
): SubstanceResolution {
  return resolveLookupKey(ingredientLookupKey(exposeUntrusted(term)), resolver);
}

/**
 * Map parsed tokens onto canonical substances.
 *
 * Deterministic and side-effect free: no network call, no model, no inference. A token that does
 * not resolve stays `UNRESOLVED` and keeps its position, so downstream fingerprinting still sees
 * a complete declaration.
 */
export function normalizeIngredients(
  tokens: readonly IngredientToken[],
  resolver: AliasResolver,
): readonly NormalizedIngredient[] {
  return tokens.map((token) => ({ ...token, ...resolveLookupKey(token.lookupKey, resolver) }));
}

/**
 * Proportion of tokens that mapped exactly.
 *
 * Used to decide whether a formulation has enough normalization coverage for a rule that needs
 * it. Reported alongside results rather than being folded into any score.
 */
export function normalizationCoverage(ingredients: readonly NormalizedIngredient[]): number {
  if (ingredients.length === 0) return 0;
  const exact = ingredients.filter((i) => i.mappingState === 'EXACT').length;
  return exact / ingredients.length;
}

/** Convenience wrapper for the common parse-then-normalize path. */
export function parseAndNormalize(
  declaration: string,
  resolver: AliasResolver,
): readonly NormalizedIngredient[] {
  return normalizeIngredients(parseIngredientDeclaration(markUntrusted(declaration)), resolver);
}
