/**
 * How a comparison is read out loud, and the one cell that must not be misread.
 *
 * Spec references: `09` (a fact about a label is not a claim about a product), `23` D-014 (an
 * absence must never render as approval), `18` (meaning is never carried by a mark alone; an
 * absence is legible as an absence), `02` (no score, no ranking), `BLK-003`, DEC-162.
 *
 * WHY THE CELL COPY IS HERE AND NOT ON THE SCREEN
 * A matrix draws a mark per cell, and a mark is exactly the kind of thing `18` forbids carrying
 * meaning on its own. Every cell therefore needs a word a screen reader announces, and every
 * legend needs a sentence a person can read - and both must be the same statement, composed once.
 * A screen that wrote its own would be free to say "does not contain".
 */

import type { DeclarationCell } from '@kynviora/domain';

export interface ComparisonCellPresentation {
  /** The mark drawn in the cell. Never the only carrier of meaning (`18`). */
  readonly mark: string;
  /** The word beside or behind the mark, and what a screen reader announces. */
  readonly label: string;
  /** The legend's sentence for this cell. What the mark actually means. */
  readonly meaning: string;
}

/**
 * The three cells, as words.
 *
 * `NOT_DECLARED` says "not on this label" and never "does not contain". `09` keeps a source fact
 * and a conclusion apart: what a declaration omits is a fact about the printing, and whether the
 * product contains it is a claim only the manufacturer can make.
 *
 * `NO_DECLARATION` says nothing about the product at all, and its mark is deliberately not a
 * blank: an empty cell beside a cell that says "not on this label" reads as agreement between
 * them, which is `23` D-014 in a table.
 */
const CELLS: Readonly<Record<DeclarationCell, ComparisonCellPresentation>> = Object.freeze({
  DECLARED: {
    mark: '●',
    label: 'On this label',
    meaning: 'This product’s ingredient list includes it.',
  },
  NOT_DECLARED: {
    mark: '○',
    label: 'Not on this label',
    // Worded to avoid the phrase it is refusing. "Not a statement that the product does not
    // contain it" says the right thing and puts the wrong sentence on the screen for a reader
    // skimming it - and it would be the one exception in a rule the whole file is stronger for
    // having none of.
    meaning:
      'This product has an ingredient list and this is not on it. That is what the label says, ' +
      'not a statement about what the product contains.',
  },
  NO_DECLARATION: {
    mark: '?',
    label: 'Not recorded',
    meaning:
      'No ingredient list has been recorded for this product, so Kynviora cannot say either way.',
  },
});

export function presentComparisonCell(cell: DeclarationCell): ComparisonCellPresentation {
  return CELLS[cell];
}

/**
 * What the whole report says about itself, above the matrix.
 *
 * Three sentences at most, and each is a limitation rather than a summary - `02` forbids the
 * summary and `09` requires the limitation to travel with the thing it qualifies, which on this
 * screen means above the table rather than under it.
 *
 * `productCount` and `declaringCount` are counts of what is in the report. Neither is a score.
 */
export function comparisonQualifications(input: {
  readonly productCount: number;
  readonly declaringCount: number;
  readonly notAvailableCount: number;
  readonly matchedByPrintedTermOnly: boolean;
}): readonly string[] {
  const lines: string[] = [];

  if (input.notAvailableCount > 0) {
    // Said first, because it changes what the rest of the screen is about.
    lines.push(
      input.notAvailableCount === 1
        ? 'One of the products you chose is not in this comparison. Kynviora could not open it.'
        : `${String(input.notAvailableCount)} of the products you chose are not in this ` +
            'comparison. Kynviora could not open them.',
    );
  }

  const missing = input.productCount - input.declaringCount;
  if (missing > 0) {
    lines.push(
      missing === 1
        ? 'One of these has no ingredient list recorded, so its column says what is not known ' +
            'rather than what is not in it.'
        : `${String(missing)} of these have no ingredient list recorded, so their columns say ` +
            'what is not known rather than what is not in them.',
    );
  }

  if (input.matchedByPrintedTermOnly) {
    lines.push(
      'Ingredients are matched by how they are printed. Two labels that spell the same ' +
        'ingredient differently will show as two rows.',
    );
  }

  return lines;
}

/**
 * What to say where nothing is shared, which is two different findings.
 *
 * `null` where there is something shared and the list speaks for itself. The distinction is the
 * whole reason `declaringCount` is on the response: "they have nothing in common" is a finding,
 * and "one of them could not be asked" is the absence of one.
 */
export function nothingSharedNote(input: {
  readonly sharedCount: number;
  readonly productCount: number;
  readonly declaringCount: number;
}): string | null {
  if (input.sharedCount > 0) return null;
  if (input.declaringCount < input.productCount) {
    return 'Kynviora cannot say what these have in common while one of them has no ingredient list recorded.';
  }
  return 'These labels have no ingredient in common.';
}

/** Every string this module can put on a screen, for the copy rules to read. */
export const ALL_COMPARISON_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(CELLS).flatMap((cell) => [cell.mark, cell.label, cell.meaning]),
  ...comparisonQualifications({
    productCount: 3,
    declaringCount: 1,
    notAvailableCount: 1,
    matchedByPrintedTermOnly: true,
  }),
  ...comparisonQualifications({
    productCount: 4,
    declaringCount: 2,
    notAvailableCount: 2,
    matchedByPrintedTermOnly: true,
  }),
  nothingSharedNote({ sharedCount: 0, productCount: 2, declaringCount: 2 }) ?? '',
  nothingSharedNote({ sharedCount: 0, productCount: 2, declaringCount: 1 }) ?? '',
]);
