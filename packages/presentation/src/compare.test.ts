import { describe, it, expect } from 'vitest';
import { DECLARATION_CELLS } from '@kynviora/domain';
import {
  ALL_COMPARISON_STRINGS,
  comparisonQualifications,
  nothingSharedNote,
  presentComparisonCell,
} from './compare.js';
import { findForbiddenClaims } from './copy.js';

/**
 * What a comparison is allowed to say out loud.
 *
 * Spec references: `09`, `23` D-014, `18`, `02`, DEC-162.
 *
 * The rule this file exists for is one sentence long: nothing on this screen may say a product
 * does not **contain** something. A declaration is what a label printed, and the difference
 * between "not on this label" and "does not contain it" is the difference between a fact and a
 * claim only a manufacturer can make.
 */

describe('the three cells, as words', () => {
  it('gives every cell a mark and a word, because a mark alone is not a state (`18`)', () => {
    for (const cell of DECLARATION_CELLS) {
      const presented = presentComparisonCell(cell);
      expect(presented.mark.length).toBeGreaterThan(0);
      expect(presented.label.length).toBeGreaterThan(0);
      expect(presented.meaning.length).toBeGreaterThan(0);
    }
  });

  it('gives the unknown cell a mark of its own rather than a blank', () => {
    // An empty cell beside one that says "not on this label" reads as agreement between them,
    // which is `23` D-014 in a table.
    const unknown = presentComparisonCell('NO_DECLARATION');
    expect(unknown.mark.trim()).not.toBe('');
    expect(unknown.mark).not.toBe(presentComparisonCell('NOT_DECLARED').mark);
    expect(unknown.label).not.toBe(presentComparisonCell('NOT_DECLARED').label);
  });

  it('never says a product does not contain something', () => {
    for (const text of ALL_COMPARISON_STRINGS) {
      expect(text).not.toMatch(/does not contain|free from|free of|contains no\b/i);
    }
  });

  it('says what the omission actually is', () => {
    expect(presentComparisonCell('NOT_DECLARED').meaning).toMatch(/what the label says/i);
    expect(presentComparisonCell('NO_DECLARATION').meaning).toMatch(/cannot say either way/i);
  });

  it('contains no forbidden claim anywhere', () => {
    for (const text of ALL_COMPARISON_STRINGS) {
      expect(findForbiddenClaims(text)).toEqual([]);
    }
  });
});

describe('what the report says about itself', () => {
  it('says nothing where there is nothing to qualify', () => {
    expect(
      comparisonQualifications({
        productCount: 2,
        declaringCount: 2,
        notAvailableCount: 0,
        matchedByPrintedTermOnly: false,
      }),
    ).toEqual([]);
  });

  it('says a product is missing before anything else, because it changes the subject', () => {
    const lines = comparisonQualifications({
      productCount: 3,
      declaringCount: 3,
      notAvailableCount: 1,
      matchedByPrintedTermOnly: true,
    });
    expect(lines[0]).toMatch(/not in this comparison/i);
  });

  it('says a column is unknown rather than empty', () => {
    const lines = comparisonQualifications({
      productCount: 3,
      declaringCount: 2,
      notAvailableCount: 0,
      matchedByPrintedTermOnly: false,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/what is not known rather than what is not in it/i);
  });

  it('reads naturally for one and for several', () => {
    const one = comparisonQualifications({
      productCount: 2,
      declaringCount: 1,
      notAvailableCount: 1,
      matchedByPrintedTermOnly: false,
    });
    expect(one[0]).toMatch(/^One of the products/);
    const several = comparisonQualifications({
      productCount: 4,
      declaringCount: 2,
      notAvailableCount: 2,
      matchedByPrintedTermOnly: false,
    });
    expect(several[0]).toMatch(/^2 of the products/);
  });

  it('always states how the matching was done when it was by printed term', () => {
    // `BLK-003`. The screen can only say it because the response does.
    const lines = comparisonQualifications({
      productCount: 2,
      declaringCount: 2,
      notAvailableCount: 0,
      matchedByPrintedTermOnly: true,
    });
    expect(lines.join(' ')).toMatch(/matched by how they are printed/i);
  });
});

describe('nothing in common', () => {
  it('says nothing at all where something is shared', () => {
    expect(nothingSharedNote({ sharedCount: 2, productCount: 2, declaringCount: 2 })).toBeNull();
  });

  it('tells a finding from an absence of one', () => {
    // The whole reason `declaringCount` is on the response.
    expect(nothingSharedNote({ sharedCount: 0, productCount: 2, declaringCount: 2 })).toMatch(
      /no ingredient in common/i,
    );
    expect(nothingSharedNote({ sharedCount: 0, productCount: 2, declaringCount: 1 })).toMatch(
      /cannot say/i,
    );
  });
});
