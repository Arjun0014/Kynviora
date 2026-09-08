/**
 * What the item detail says about which collection an item is in, and what it offers.
 *
 * Spec references: `03`, `06`, `18` (a state is a word; an absence is legible as an absence),
 * DEC-045 (a control that would be refused is withheld rather than disabled), `0033`, DEC-160.
 *
 * WHY THE COLLECTION IS ASSERTED AS A SENTENCE RATHER THAN AS A CONTROL
 * An item in Considering that said so only by the absence of a "Move to Considering" button would
 * be an absence nobody can read. The card names the collection in both of them.
 */

import { describe, it, expect } from 'vitest';
import type { ItemDetailScreenView } from '@kynviora/contracts';
import { ItemDetail } from './ItemDetail';
import { allNodes, accessibleNameOf, findByName, renderScreen } from '../../../test/render.js';

const BASE: ItemDetailScreenView = {
  id: 'item-1',
  displayName: 'Gentle Daily Shampoo (synthetic)',
  brand: null,
  itemKind: 'PERSONAL_CARE',
  lifecycleNote: null,
  identity: null,
  formulation: null,
  batch: null,
  verificationNote: 'Nothing about this has been confirmed yet.',
  categoryHeading: 'About this product',
  categoryFields: [],
  sharedFields: [],
  attention: { reasons: [], undescribedCount: 0, undescribedNote: null, settledNote: 'Nothing.' },
  lifecycleState: 'ACTIVE',
  shelfCollection: 'IN_USE',
  mayBeConsidered: true,
  version: 3,
  mayEdit: true,
  mayRecordDoses: false,
  mayDelete: true,
  editableValues: {},
  stoppedOn: null,
};

function render(overrides: Partial<ItemDetailScreenView> = {}, onMove?: () => void) {
  return renderScreen(
    <ItemDetail
      view={{ ...BASE, ...overrides }}
      state="READY"
      onClose={() => undefined}
      {...(onMove === undefined ? {} : { onMove })}
    />,
  );
}

function screenText(rendered: ReturnType<typeof render>): string {
  return allNodes(rendered)
    .map((node) => accessibleNameOf(node))
    .join(' ~ ');
}

describe('which collection an item is in', () => {
  it('names the collection on screen in both of them', () => {
    expect(screenText(render({ shelfCollection: 'IN_USE' }))).toContain('My Shelf');
    expect(screenText(render({ shelfCollection: 'CONSIDERING' }))).toContain('Considering');
  });

  it('offers the move to the other one, named by its destination', () => {
    expect(
      findByName(
        render({}, () => undefined),
        'Move to Considering',
      ),
    ).not.toBeNull();
    expect(
      findByName(
        render({ shelfCollection: 'CONSIDERING' }, () => undefined),
        'Move to My Shelf',
      ),
    ).not.toBeNull();
  });

  it('offers no move on a medicine, rather than one that would be refused', () => {
    // DEC-045 applied to a rule instead of to a capability. `0033` forbids a medicine in
    // Considering, and the schema refuses it too.
    const rendered = render({ itemKind: 'MEDICINE', mayBeConsidered: false }, () => undefined);
    expect(findByName(rendered, 'Move to Considering')).toBeNull();
    // And it still says where the item is, because that is a fact about it either way.
    expect(screenText(rendered)).toContain('My Shelf');
  });

  it('offers no move to a caller who may not change the item', () => {
    const rendered = render({ mayEdit: false }, () => undefined);
    expect(findByName(rendered, 'Move to Considering')).toBeNull();
  });

  it('offers no move where the screen wired no handler', () => {
    expect(findByName(render(), 'Move to Considering')).toBeNull();
  });

  it('draws what the last move said beside the control that produced it', () => {
    const rendered = renderScreen(
      <ItemDetail
        view={BASE}
        state="READY"
        onClose={() => undefined}
        onMove={() => undefined}
        moveNote="This move is on this phone and will be sent when Kynviora can reach the server."
      />,
    );
    expect(screenText(rendered)).toContain('will be sent when Kynviora can reach the server');
  });
});
