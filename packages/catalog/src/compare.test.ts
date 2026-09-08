import { describe, it, expect } from 'vitest';
import { compareDeclarations } from './compare.js';

/**
 * What a comparison of two declarations is allowed to say.
 *
 * Spec references: `09`, `02`, `23` D-014, `17`, `BLK-003`, DEC-162.
 *
 * The rule with teeth is the third cell. A product nobody has entered a declaration for must never
 * read as one that does not list an ingredient, and a two-state matrix has nowhere to put the
 * difference - which is `23` D-014 arriving through a table rather than through a sentence.
 */

const A = {
  id: 'a',
  ingredientDeclarationRaw: 'Aqua, Sodium fluoride, Sorbitol, Aroma',
};
const B = {
  id: 'b',
  ingredientDeclarationRaw: 'Aqua, Sorbitol, Sodium lauryl sulfate',
};
const NOTHING = { id: 'c', ingredientDeclarationRaw: null };

describe('what every product declared', () => {
  it('lists the terms on all of them', () => {
    const comparison = compareDeclarations([A, B]);
    expect(comparison.shared.map((row) => row.term)).toEqual(['Aqua', 'Sorbitol']);
  });

  it('keeps the term as printed rather than as normalised', () => {
    // `09`: somebody else's words stay their words. The key is what matches; the term is what a
    // person reads back against the bottle in their hand.
    const comparison = compareDeclarations([
      { id: 'a', ingredientDeclarationRaw: 'Aloé Vera' },
      { id: 'b', ingredientDeclarationRaw: 'aloe vera' },
    ]);
    expect(comparison.shared[0]?.term).toBe('Aloé Vera');
    expect(comparison.shared[0]?.lookupKey).toBe('aloe vera');
  });

  it('says nothing is shared where one product cannot be asked', () => {
    // "They all list this" is a claim about all of them. One that has no declaration makes the
    // claim unavailable rather than weaker, so `shared` is empty and `declaringCount` is what a
    // screen reads to say why.
    const comparison = compareDeclarations([A, B, NOTHING]);
    expect(comparison.shared).toEqual([]);
    expect(comparison.declaringCount).toBe(2);
  });
});

describe('the three cells', () => {
  it('marks a term the product declared', () => {
    const row = compareDeclarations([A, B]).differing.find(
      (entry) => entry.lookupKey === 'sodium fluoride',
    );
    expect(row?.cells).toEqual(['DECLARED', 'NOT_DECLARED']);
  });

  it('never says NOT_DECLARED about a product with no declaration', () => {
    // The whole point. Every cell for a product nobody entered anything for is NO_DECLARATION,
    // including the terms the others do not list either.
    const comparison = compareDeclarations([A, NOTHING]);
    for (const row of [...comparison.shared, ...comparison.differing]) {
      expect(row.cells[1]).toBe('NO_DECLARATION');
    }
  });

  it('treats a declaration that parses to nothing as no declaration at all', () => {
    // Somebody who typed a space has recorded nothing, and reporting that as "declares no
    // ingredients" would turn an empty field into a statement about a product.
    for (const raw of ['', '   ', '\n', 'Ingredients:']) {
      const comparison = compareDeclarations([A, { id: 'blank', ingredientDeclarationRaw: raw }]);
      expect(comparison.products[1]?.hasDeclaration).toBe(false);
      expect(comparison.declaringCount).toBe(1);
    }
  });

  it('gives every row one cell per product, in the order they were given', () => {
    const comparison = compareDeclarations([A, B, NOTHING]);
    for (const row of comparison.differing) expect(row.cells).toHaveLength(3);
    expect(comparison.products.map((product) => product.productId)).toEqual(['a', 'b', 'c']);
  });
});

describe('what the report says about itself', () => {
  it('always says the matching was on the printed term', () => {
    // `BLK-003`: the substance vocabulary is empty, so `Aqua` and `Water` are two rows. Resolving
    // through an empty vocabulary would match nothing while looking like it had.
    expect(compareDeclarations([A, B]).matchedByPrintedTermOnly).toBe(true);
    const separate = compareDeclarations([
      { id: 'a', ingredientDeclarationRaw: 'Aqua' },
      { id: 'b', ingredientDeclarationRaw: 'Water' },
    ]);
    expect(separate.shared).toEqual([]);
    expect(separate.differing).toHaveLength(2);
  });

  it('counts the terms on each declaration and calls it nothing else', () => {
    // A count of what is recorded. Not a completeness, which would need to know how long the real
    // list is - and nothing in this build does.
    const comparison = compareDeclarations([A, B, NOTHING]);
    expect(comparison.products.map((product) => product.declaredTermCount)).toEqual([4, 3, 0]);
  });

  it('does not reorder the products', () => {
    // `02`: sorting products in a comparison is a ranking. The order is the caller's.
    expect(compareDeclarations([B, A]).products.map((p) => p.productId)).toEqual(['b', 'a']);
  });

  it('meets a term in the order somebody reading the products would', () => {
    // Deterministic and reproducible, and not a ranking: first appearance scanning the products in
    // the order they were chosen.
    const comparison = compareDeclarations([A, B]);
    expect(comparison.differing.map((row) => row.lookupKey)).toEqual([
      'sodium fluoride',
      'aroma',
      'sodium lauryl sulfate',
    ]);
  });

  it('compares one product with itself without inventing a difference', () => {
    const comparison = compareDeclarations([A, { ...A, id: 'a2' }]);
    expect(comparison.differing).toEqual([]);
    expect(comparison.shared).toHaveLength(4);
  });

  it('compares nothing at all without throwing', () => {
    const comparison = compareDeclarations([]);
    expect(comparison.shared).toEqual([]);
    expect(comparison.differing).toEqual([]);
    expect(comparison.declaringCount).toBe(0);
  });
});
