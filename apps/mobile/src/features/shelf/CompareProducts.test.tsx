/**
 * What a comparison draws, and the cell it must never draw as an absence.
 *
 * Spec references: `09`, `23` D-014, `18`, `02`, DEC-162.
 *
 * The rule this file exists for: a product with no ingredient list recorded must not read as one
 * whose label omits an ingredient. On a screen that is a mark, and a mark is exactly the thing
 * `18` forbids carrying meaning on its own - so every cell is asserted as the sentence a screen
 * reader announces rather than as the glyph.
 */

import { describe, it, expect } from 'vitest';
import type { CompareView } from '@kynviora/contracts';
import { CompareProducts } from './CompareProducts';
import { allNodes, accessibleNameOf, renderScreen } from '../../../test/render.js';

const CHIP = {
  label: 'Product not verified',
  iconName: 'question-circle' as const,
  tone: 'neutral' as const,
  description: 'Kynviora has not confirmed what this product is.',
  accessibilityLabel: 'Product not verified.',
};

const TWO: CompareView = {
  products: [
    {
      id: 'a',
      displayName: 'Synthetic Toothpaste A',
      brand: null,
      identity: CHIP,
      formulation: CHIP,
      batch: CHIP,
      hasDeclaration: true,
      declaredTermCount: 4,
    },
    {
      id: 'b',
      displayName: 'Synthetic Toothpaste B',
      brand: null,
      identity: CHIP,
      formulation: CHIP,
      batch: CHIP,
      hasDeclaration: false,
      declaredTermCount: 0,
    },
  ],
  shared: [],
  differing: [{ term: 'Sodium fluoride', cells: ['DECLARED', 'NO_DECLARATION'] }],
  declaringCount: 1,
  matchedByPrintedTermOnly: true,
  notAvailableCount: 0,
};

function render(comparison: CompareView | null) {
  return renderScreen(
    <CompareProducts comparison={comparison} state="READY" onClose={() => undefined} />,
  );
}

function screenText(comparison: CompareView | null): string {
  return allNodes(render(comparison))
    .map((node) => accessibleNameOf(node))
    .join(' ~ ');
}

describe('the cell that means nothing is known', () => {
  it('announces it as not recorded, not as an absence', () => {
    const text = screenText(TWO);
    expect(text).toContain('2. Synthetic Toothpaste B: Not recorded.');
    expect(text).toContain('1. Synthetic Toothpaste A: On this label.');
  });

  it('never says a product does not contain anything', () => {
    expect(screenText(TWO)).not.toMatch(/does not contain|free from|free of/i);
  });

  it('draws the legend for all three cells', () => {
    const text = screenText(TWO);
    expect(text).toContain('On this label');
    expect(text).toContain('Not on this label');
    expect(text).toContain('Not recorded');
  });
});

describe('what the screen says about itself, before the table', () => {
  it('states the unknown column and how terms were matched', () => {
    const text = screenText(TWO);
    expect(text).toMatch(/no ingredient list recorded/i);
    expect(text).toMatch(/matched by how they are printed/i);
  });

  it('tells "nothing in common" from "one could not be asked"', () => {
    expect(screenText(TWO)).toMatch(/cannot say what these have in common/i);
    const bothDeclare: CompareView = {
      ...TWO,
      products: TWO.products.map((product) => ({
        ...product,
        hasDeclaration: true,
        declaredTermCount: 3,
      })),
      declaringCount: 2,
      differing: [{ term: 'Sodium fluoride', cells: ['DECLARED', 'NOT_DECLARED'] }],
    };
    expect(screenText(bothDeclare)).toMatch(/no ingredient in common/i);
  });

  it('says a chosen product is missing rather than drawing a shorter table in silence', () => {
    expect(screenText({ ...TWO, notAvailableCount: 1 })).toMatch(/not in this comparison/i);
  });

  it('carries no combined verdict anywhere', () => {
    // `02`: three axes, never merged, and no score on the screen that most invites one.
    expect(screenText(TWO)).not.toMatch(/\bbest\b|\bscore\b|\branked?\b|\bwinner\b/i);
  });
});

describe('the state banner', () => {
  it('says nothing at all on a successful read', () => {
    // It drew "Up to date. This is what Kynviora has right now." above the qualifications, which
    // are the thing a person has to read before the marks. Found on a device.
    expect(screenText(TWO)).not.toMatch(/up to date|what kynviora has right now/i);
  });

  it('still says what went wrong when something did', () => {
    const rendered = renderScreen(
      <CompareProducts
        comparison={null}
        state="OFFLINE"
        message="Kynviora could not reach the server."
        onClose={() => undefined}
      />,
    );
    const text = allNodes(rendered)
      .map((node) => accessibleNameOf(node))
      .join(' ~ ');
    expect(text).toContain('Kynviora could not reach the server.');
  });
});

describe('before there is anything to draw', () => {
  it('offers the way back and nothing else', () => {
    const text = screenText(null);
    expect(text).toContain('Back to the shelf');
    expect(text).not.toContain('What the marks mean');
  });
});
