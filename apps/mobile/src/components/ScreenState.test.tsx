/**
 * What a screen says when there is nothing on it.
 *
 * Spec references: `18` (an absence is legible as an absence, and two different absences must not
 * read the same), `06` (a screen with only a success path is incomplete), DEC-102, DEC-160.
 *
 * WHY THE OVERRIDE EXISTS AT ALL
 * The generic sentence - "Nothing here yet. There is nothing to show on this screen at the moment."
 * - is right for a screen with one list. Shelf shows one of two collections, and over Considering
 * that sentence says exactly what it says over My Shelf while the two absences mean different
 * things: one is a person who has recorded nothing, the other a person who is not evaluating
 * anything.
 *
 * The rule the second half of this file is about is the one that would be easy to get wrong: an
 * override that also applied to a **failure** would render a permission problem as an empty shelf,
 * which is the conflation `resourceFor` exists to prevent.
 */

import { describe, it, expect } from 'vitest';
import type { Resource } from '@kynviora/contracts';
import { ResourceState } from './ScreenState';
import { allNodes, accessibleNameOf, renderScreen } from '../../test/render.js';

const GENERIC = 'There is nothing to show on this screen at the moment.';
const OWN = 'Nothing here. Considering is for products you are thinking about.';

function resource(state: Resource<unknown>['state'], message: string | null = null) {
  return { state, value: null, message, correlationId: null } as Resource<unknown>;
}

function textOfScreen(element: Parameters<typeof renderScreen>[0]): string {
  const rendered = renderScreen(element);
  return allNodes(rendered)
    .map((node) => accessibleNameOf(node))
    .join(' ~ ');
}

describe('an empty screen', () => {
  it('says the generic sentence where the screen offered none of its own', () => {
    expect(textOfScreen(<ResourceState resource={resource('EMPTY')} />)).toContain(GENERIC);
  });

  it('says the screen’s own sentence instead where it offered one', () => {
    const text = textOfScreen(<ResourceState resource={resource('EMPTY')} emptyMessage={OWN} />);
    expect(text).toContain(OWN);
    // Instead of, not as well as. Two sentences about the same absence is worse than either.
    expect(text).not.toContain(GENERIC);
  });

  it('ignores an override of null, which is how a screen says "not this time"', () => {
    expect(
      textOfScreen(<ResourceState resource={resource('EMPTY')} emptyMessage={null} />),
    ).toContain(GENERIC);
  });
});

describe('a screen that is not empty but not ready either', () => {
  it('never renders a failure as the screen’s empty sentence', () => {
    // The conflation `resourceFor` exists to prevent: a permission problem must not look like an
    // empty shelf. The override is consulted on EMPTY and on nothing else.
    for (const state of ['AUTHORIZATION_LOST', 'OFFLINE', 'UNAVAILABLE'] as const) {
      const text = textOfScreen(
        <ResourceState resource={resource(state, 'The server refused.')} emptyMessage={OWN} />,
      );
      expect(text).not.toContain(OWN);
      expect(text).toContain('The server refused.');
    }
  });

  it('draws nothing at all when the resource is ready', () => {
    expect(
      textOfScreen(<ResourceState resource={resource('READY')} emptyMessage={OWN} />).trim(),
    ).toBe('');
  });
});
