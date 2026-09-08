import { describe, it, expect } from 'vitest';
import { SHELF_COLLECTIONS } from '@kynviora/domain';
import {
  ALL_SHELF_COLLECTION_STRINGS,
  SHELF_COLLECTION_ORDER,
  presentShelfCollection,
  shelfMoveControl,
} from './shelfCollections.js';
import { findForbiddenClaims } from './copy.js';

/**
 * What the shelf's two collections are allowed to say.
 *
 * Spec references: `03`, `06`, `18`, `02`, `0033`, DEC-160.
 *
 * The rule with teeth here is the last one. "Considering" records what a person intends and
 * nothing else: a product being considered has been checked exactly as much as one in use, which
 * for most of them is "not enough information". Copy that let the word read as a safety state
 * would be `23` D-014 arriving through a filter name.
 */
describe('the shelf’s two collections, as words', () => {
  it('offers My Shelf first, because it is what you have', () => {
    expect(SHELF_COLLECTION_ORDER).toEqual(['IN_USE', 'CONSIDERING']);
  });

  it('has a presentation for every collection the vocabulary has', () => {
    for (const collection of SHELF_COLLECTIONS) {
      const presented = presentShelfCollection(collection);
      expect(presented.label.length).toBeGreaterThan(0);
      expect(presented.meaning.length).toBeGreaterThan(0);
      expect(presented.emptyNote.length).toBeGreaterThan(0);
    }
  });

  it('says something different about each empty collection', () => {
    // `18`: an absence is legible as an absence. One sentence for both would be describing a
    // person who has recorded nothing and a person who is evaluating nothing as the same thing.
    expect(presentShelfCollection('IN_USE').emptyNote).not.toBe(
      presentShelfCollection('CONSIDERING').emptyNote,
    );
  });

  it('never lets Considering read as a safety state', () => {
    for (const text of ALL_SHELF_COLLECTION_STRINGS) {
      expect(findForbiddenClaims(text)).toEqual([]);
      expect(text).not.toMatch(/\b(safe|unsafe|risky|approved|checked by kynviora)\b/i);
    }
  });
});

describe('the control that moves an item', () => {
  it('names the destination rather than the act', () => {
    expect(shelfMoveControl('IN_USE', true)?.label).toBe('Move to Considering');
    expect(shelfMoveControl('CONSIDERING', true)?.label).toBe('Move to My Shelf');
  });

  it('offers nothing at all where the move is not possible', () => {
    // DEC-045 applied to a rule rather than to a capability. A medicine cannot be considered
    // (`0033`), and a greyed-out control would tell somebody the app has a place for it that it
    // is not letting them use.
    expect(shelfMoveControl('IN_USE', false)).toBeNull();
  });

  it('still offers the way back out, whatever the kind rule says', () => {
    // The rule constrains what may go in, not what may come out. An item that somehow reached
    // Considering must never be stuck there - which is the same shape as `12`'s rule that a
    // failure state has to be resolvable.
    expect(shelfMoveControl('CONSIDERING', false)).not.toBeNull();
    expect(shelfMoveControl('CONSIDERING', false)?.to).toBe('IN_USE');
  });

  it('says what happens to the item, not what happens to a score', () => {
    for (const from of SHELF_COLLECTIONS) {
      const control = shelfMoveControl(from, true);
      expect(control?.note).not.toMatch(/score|rating|rank/i);
    }
  });
});
