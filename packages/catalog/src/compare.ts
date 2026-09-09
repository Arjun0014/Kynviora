/**
 * Comparing what two or more products **declare**, and never what they contain.
 *
 * Spec references: `09` (a source fact and a Kynviora conclusion are different things; a
 * limitation travels with the fact it qualifies), `02` (no score, no ranking, no aggregate),
 * `23` D-014 (an absence of a matched rule must never render as approval), `17` (a declaration is
 * untrusted input), `18`, `08`, `BLK-003`, DEC-162.
 *
 * WHAT V3 ASKS FOR AND WHAT THIS IS
 * V3's Compare is infographic-first: a matrix of ingredients against products with `y`, `n` and
 * `u` cells, a list of what they share, and a strip saying how complete each declaration is. The
 * matrix is the whole of it - the rest of that screen is drawn from things this build already
 * composes - and the matrix is where a comparison can lie.
 *
 * THE THREE CELLS, AND WHY THERE ARE THREE
 * `y` and `n` alone would be a two-state answer to a three-state question, and the missing state
 * is the one that matters:
 *
 *   `DECLARED`        this product's declaration lists this term
 *   `NOT_DECLARED`    this product has a declaration and this term is not on it
 *   `NO_DECLARATION`  nothing has been recorded for this product, so nothing can be said
 *
 * The third is not "no" and must never render as one. A product nobody has entered a declaration
 * for is a product Kynviora knows nothing about, and drawing that as an empty cell beside a
 * product that genuinely does not list an ingredient is `23` D-014 arriving through a table.
 *
 * AND WHY THE SECOND IS NOT "DOES NOT CONTAIN"
 * A declaration is what a label printed. `09` keeps a source fact and a conclusion apart, and
 * "this label does not list sodium lauryl sulfate" is a fact about the label; "this product does
 * not contain sodium lauryl sulfate" is a claim about the product that only the manufacturer can
 * make. The cell is named for the first, and the copy that renders it says so.
 *
 * MATCHING IS ON THE PRINTED TERM, NOT THROUGH A SUBSTANCE VOCABULARY
 * {@link ingredientLookupKey} casefolds, strips punctuation and folds accents, so `Aloé Vera` and
 * `aloe vera` are one row. It does **not** resolve synonyms: `Aqua` and `Water` are two rows. That
 * is a limitation of this build rather than a design choice - the substance vocabulary is empty
 * (`BLK-003`), and resolving through an empty one would silently match nothing while looking like
 * it had matched. {@link DeclarationComparison.matchedByPrintedTermOnly} says so, always, so the
 * screen can state it rather than a reader having to know.
 *
 * NOTHING HERE RANKS AND NOTHING HERE SCORES
 * `02`. There is no "best", no count of criteria met and no ordering by how much two products have
 * in common. V3's mock draws a "best" chip; it is not built here, and the reason is in DEC-162:
 * choosing criteria is a feature of its own, and a "best" computed over cells that are partly
 * unknown ranks products by how much has been entered about them.
 */

import { markUntrusted, type DeclarationCell } from '@kynviora/domain';
import { ingredientLookupKey, parseIngredientDeclaration } from './ingredients.js';

/** One product, as this comparison needs it. Identifiers and a declaration; no names, no verdicts. */
export interface ComparableProduct {
  readonly id: string;
  /** Exactly what was recorded, or `null` where nothing was. Never a placeholder. */
  readonly ingredientDeclarationRaw: string | null;
}

export interface ComparisonRow {
  /**
   * The term as printed, taken from the first product in order that declared it.
   *
   * Printed rather than normalised, because `09` keeps somebody else's words as their words. Two
   * products that spell it differently share a row only where the spellings fold together.
   */
  readonly term: string;
  readonly lookupKey: string;
  /** One cell per product, in the order the products were given. */
  readonly cells: readonly DeclarationCell[];
}

export interface ComparedDeclaration {
  readonly productId: string;
  /** Whether anything at all has been recorded for this product. */
  readonly hasDeclaration: boolean;
  /** How many terms were parsed out of it. A count of what is recorded, never a completeness. */
  readonly declaredTermCount: number;
}

export interface DeclarationComparison {
  readonly products: readonly ComparedDeclaration[];
  /**
   * Terms every product declared.
   *
   * Empty whenever any product has no declaration at all: "they all list this" is a claim about
   * all of them, and one that cannot answer makes the claim unavailable rather than weaker.
   */
  readonly shared: readonly ComparisonRow[];
  /** Every other term, in first-appearance order across the products as given. */
  readonly differing: readonly ComparisonRow[];
  /**
   * How many of the products have a declaration at all.
   *
   * On the report rather than derived by a reader, because it is the number that decides whether
   * {@link shared} being empty means "they have nothing in common" or "one of them could not be
   * asked" - two readings a screen must not let a person confuse.
   */
  readonly declaringCount: number;
  /** Always `true` in this build. See the module note and `BLK-003`. */
  readonly matchedByPrintedTermOnly: true;
}

/**
 * Compare what a set of products declare.
 *
 * The order of `products` is the order of the cells, and it is the caller's - this function does
 * not sort, because sorting products in a comparison is a ranking (`02`).
 */
export function compareDeclarations(products: readonly ComparableProduct[]): DeclarationComparison {
  const parsed = products.map((product) => {
    const raw = product.ingredientDeclarationRaw;
    // `17`: a declaration is untrusted input wherever it came from - OCR, a vision model, or
    // somebody typing what is on a bottle.
    const tokens =
      raw === null || raw.trim() === '' ? [] : parseIngredientDeclaration(markUntrusted(raw));
    const byKey = new Map<string, string>();
    for (const token of tokens) {
      const key = ingredientLookupKey(token.rawTerm);
      if (key === '') continue;
      if (!byKey.has(key)) byKey.set(key, token.rawTerm);
    }
    return {
      id: product.id,
      // A declaration that parsed to nothing is not a declaration. Somebody who typed a space
      // has recorded nothing, and reporting that as "declares no ingredients" would turn an
      // empty field into a statement about a product.
      hasDeclaration: byKey.size > 0,
      byKey,
    };
  });

  // First-appearance order across the products as given. Deterministic, reproducible, and not a
  // ranking: it is the order somebody reading the products in the order they chose would meet
  // the terms in.
  const order: string[] = [];
  const printed = new Map<string, string>();
  for (const product of parsed) {
    for (const [key, term] of product.byKey) {
      if (printed.has(key)) continue;
      printed.set(key, term);
      order.push(key);
    }
  }

  const everyProductDeclares = parsed.every((product) => product.hasDeclaration);

  const shared: ComparisonRow[] = [];
  const differing: ComparisonRow[] = [];

  for (const key of order) {
    const cells = parsed.map((product): DeclarationCell => {
      if (!product.hasDeclaration) return 'NO_DECLARATION';
      return product.byKey.has(key) ? 'DECLARED' : 'NOT_DECLARED';
    });
    const row: ComparisonRow = {
      term: printed.get(key) ?? key,
      lookupKey: key,
      cells,
    };
    const inEvery = cells.every((cell) => cell === 'DECLARED');
    if (everyProductDeclares && inEvery) shared.push(row);
    else differing.push(row);
  }

  return {
    products: parsed.map((product) => ({
      productId: product.id,
      hasDeclaration: product.hasDeclaration,
      declaredTermCount: product.byKey.size,
    })),
    shared,
    differing,
    declaringCount: parsed.filter((product) => product.hasDeclaration).length,
    matchedByPrintedTermOnly: true,
  };
}
