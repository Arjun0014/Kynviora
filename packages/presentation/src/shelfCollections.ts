/**
 * The shelf's two collections, as a person reads them.
 *
 * Spec references: `03` (the Unified Health Shelf), `06` (Shelf is a primary destination and
 * defines every state), `18` (a state is a word, never a tint alone; an absence is legible as an
 * absence), `02` (no ranking, no aggregate), `0033`, DEC-160.
 *
 * WHY THE COPY IS HERE AND NOT ON THE SCREEN
 * Three surfaces say something about the collection - the switcher on Shelf, the control that
 * moves an item, and the empty state of a collection with nothing in it - and they are the same
 * three statements about the same two values. Composed once, they cannot drift into describing
 * the same shelf differently.
 *
 * WHAT "CONSIDERING" IS ALLOWED TO IMPLY
 * Nothing about safety. A product being considered has been checked exactly as much as one in use
 * - which for most of them is "not enough information" - and the word must not read as a state
 * Kynviora has assessed. So the wording is about the person's own intent, which is the only thing
 * this column records: something they have, or something they are thinking about.
 */

import type { ShelfCollection } from '@kynviora/domain';

export interface ShelfCollectionPresentation {
  /** The switcher's label, and the word the collection is called everywhere. */
  readonly label: string;
  /** What this collection is, for the switcher's accessible description. */
  readonly meaning: string;
  /**
   * What a collection with nothing in it says.
   *
   * `18`: an absence is legible as an absence. "Nothing here yet" on `IN_USE` and on
   * `CONSIDERING` would be the same sentence about two different situations - one of them a
   * person who has recorded nothing, the other a person who is not evaluating anything.
   */
  readonly emptyNote: string;
}

const PRESENTATION: Readonly<Record<ShelfCollection, ShelfCollectionPresentation>> = Object.freeze({
  IN_USE: {
    label: 'My Shelf',
    meaning: 'The medicines and products you have.',
    emptyNote:
      'Nothing on this shelf yet. Adding a medicine or a product is how Kynviora knows what to ' +
      'watch.',
  },
  CONSIDERING: {
    label: 'Considering',
    meaning: 'Products you are thinking about, kept apart from the ones you use.',
    emptyNote:
      'Nothing here. Considering is for products you are thinking about - move one here from its ' +
      'own screen and it stays off your shelf until you decide.',
  },
});

export function presentShelfCollection(collection: ShelfCollection): ShelfCollectionPresentation {
  return PRESENTATION[collection];
}

/** The switcher's two entries, in the order they are offered. My Shelf first: it is what you have. */
export const SHELF_COLLECTION_ORDER: readonly ShelfCollection[] = Object.freeze([
  'IN_USE',
  'CONSIDERING',
]);

/**
 * What the control that moves an item says, or `null` where there is no move to offer.
 *
 * `null` rather than a disabled control, which is DEC-045 applied to a rule instead of to a
 * capability: a medicine cannot be considered, and a greyed-out "Move to Considering" on a
 * medicine would tell somebody the app has a place for it that it is not letting them use.
 *
 * The label names the destination rather than the act. "Move" alone does not say where, and on a
 * screen where the current collection is also written down, the destination is the half a person
 * has to read.
 */
export function shelfMoveControl(
  from: ShelfCollection,
  mayBeConsidered: boolean,
): { readonly label: string; readonly to: ShelfCollection; readonly note: string } | null {
  if (from === 'CONSIDERING') {
    return {
      label: `Move to ${PRESENTATION.IN_USE.label}`,
      to: 'IN_USE',
      note: 'It joins the products you have.',
    };
  }
  if (!mayBeConsidered) return null;
  return {
    label: `Move to ${PRESENTATION.CONSIDERING.label}`,
    to: 'CONSIDERING',
    note: 'It stays recorded and comes off the shelf of things you use.',
  };
}

/** Every string this module can put on a screen, for the copy rules to read. */
export const ALL_SHELF_COLLECTION_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(PRESENTATION).flatMap((entry) => [entry.label, entry.meaning, entry.emptyNote]),
  ...(['IN_USE', 'CONSIDERING'] as const).flatMap((from) => {
    const control = shelfMoveControl(from, true);
    return control === null ? [] : [control.label, control.note];
  }),
]);
