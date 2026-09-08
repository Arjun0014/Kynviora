import { describe, it, expect } from 'vitest';
import { ITEM_KINDS, PERSONAL_CARE_CATEGORIES, type ItemKind } from '@kynviora/domain';
import {
  ALL_SHELF_CATEGORY_STRINGS,
  SHELF_CATEGORIES,
  presentShelfCategory,
  shelfCategoryChips,
  shelfCategoryGroups,
  shelfCategoryOf,
  type ShelfCategory,
} from './shelfCategories.js';
import { findForbiddenClaims } from './copy.js';

/**
 * How the shelf is grouped.
 *
 * Spec references: `03`, `06`, `02` (no ranking, no aggregate), `18`, `08`, DEC-161.
 *
 * The two rules with teeth are the ordering and the counts. A grouped list ordered by size reads
 * as "this is the important one" and reorders under somebody's feet as they add things; a chip
 * whose count shrank when it was pressed would tell somebody there is one thing in a group its own
 * label just said had four.
 */

function item(kind: ItemKind, category: string | null) {
  return { itemKind: kind, personalCareCategory: category };
}

describe('which group a row is drawn in', () => {
  it('puts a medicine in Medicines whatever else is on the row', () => {
    // Reading the category first would put a row in a group its own kind contradicts if
    // `owned_item_category_matches_kind` were ever relaxed.
    expect(shelfCategoryOf(item('MEDICINE', null))).toBe('MEDICINE');
    expect(shelfCategoryOf(item('MEDICINE', 'ORAL_CARE'))).toBe('MEDICINE');
  });

  it('puts every personal-care category in its own group', () => {
    for (const category of PERSONAL_CARE_CATEGORIES) {
      expect(shelfCategoryOf(item('PERSONAL_CARE', category))).toBe(category);
    }
  });

  it('puts a product with no category somewhere rather than nowhere', () => {
    // `04` Phase 2.2 allows a record with missing fields, so this is an ordinary product and not a
    // defect. A row that fell out of every group would be an item missing from the shelf.
    expect(shelfCategoryOf(item('PERSONAL_CARE', null))).toBe('UNCATEGORISED');
  });

  it('puts a category this build does not know about there too', () => {
    expect(shelfCategoryOf(item('PERSONAL_CARE', 'PERFUME'))).toBe('UNCATEGORISED');
  });

  it('has a label for every group it can produce', () => {
    for (const category of SHELF_CATEGORIES) {
      expect(presentShelfCategory(category).length).toBeGreaterThan(0);
    }
  });
});

describe('grouping', () => {
  const SHELF = [
    item('PERSONAL_CARE', 'SKIN_CARE'),
    item('MEDICINE', null),
    item('PERSONAL_CARE', 'ORAL_CARE'),
    item('PERSONAL_CARE', 'ORAL_CARE'),
    item('MEDICINE', null),
    item('PERSONAL_CARE', null),
  ];

  it('is in taxonomy order and not in size order', () => {
    // Oral care has two and Skin care one, so a size ordering would put Oral care first among the
    // personal-care groups. It does not: the order is fixed.
    expect(shelfCategoryGroups(SHELF).map((group) => group.category)).toEqual([
      'MEDICINE',
      'ORAL_CARE',
      'SKIN_CARE',
      'UNCATEGORISED',
    ]);
  });

  it('leaves out the groups with nothing in them', () => {
    // Not an absence `18` needs labelled: nothing is missing, the person owns no sunscreen.
    expect(shelfCategoryGroups(SHELF).map((group) => group.category)).not.toContain('SUNSCREEN');
  });

  it('counts what is in each group and drops nothing', () => {
    const groups = shelfCategoryGroups(SHELF);
    expect(groups.reduce((total, group) => total + group.count, 0)).toBe(SHELF.length);
    for (const group of groups) expect(group.items).toHaveLength(group.count);
  });

  it('keeps the server’s order inside a group', () => {
    // `02` forbids this layer deciding which of two people's medicines matters more, and sorting
    // inside a group would be that decision made quietly.
    const rows = [
      { ...item('PERSONAL_CARE', 'ORAL_CARE'), id: 'b' },
      { ...item('PERSONAL_CARE', 'ORAL_CARE'), id: 'a' },
    ];
    expect(shelfCategoryGroups(rows)[0]?.items.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('groups an empty shelf into nothing at all', () => {
    expect(shelfCategoryGroups([])).toEqual([]);
  });
});

describe('the chips', () => {
  const SHELF = [
    item('MEDICINE', null),
    item('PERSONAL_CARE', 'ORAL_CARE'),
    item('PERSONAL_CARE', 'ORAL_CARE'),
  ];

  it('always offers the way back to everything, including while filtered', () => {
    // `18`: a filtered list has to be legible as one, and the control that unfilters it must not
    // itself be filtered away.
    for (const selected of [null, 'ORAL_CARE'] as const) {
      const chips = shelfCategoryChips(SHELF, selected);
      expect(chips[0]?.category).toBeNull();
      expect(chips[0]?.label).toBe('All');
    }
  });

  it('keeps a chip’s count while that chip’s own filter is on', () => {
    // The count is of the collection, not of the filtered view. A count that dropped to the size
    // of the filtered list would say "Oral care (2)" and then "Oral care (2)" of a two-row screen
    // while "All" said 2 as well - three numbers that agree and describe nothing.
    const filtered = shelfCategoryChips(SHELF, 'ORAL_CARE');
    expect(filtered.find((chip) => chip.category === 'ORAL_CARE')?.count).toBe(2);
    expect(filtered[0]?.count).toBe(3);
  });

  it('marks exactly one chip as showing', () => {
    for (const selected of [null, 'MEDICINE', 'ORAL_CARE'] as const) {
      expect(shelfCategoryChips(SHELF, selected).filter((chip) => chip.selected)).toHaveLength(1);
    }
  });

  it('offers no chip for a category with nothing in it', () => {
    const chips = shelfCategoryChips(SHELF, null);
    expect(chips.map((chip) => chip.category)).not.toContain('SUNSCREEN');
  });

  it('says the state as a word, because a tint is not a state (`18`)', () => {
    const chips = shelfCategoryChips(SHELF, 'MEDICINE');
    const medicines = chips.find((chip) => chip.category === 'MEDICINE');
    expect(medicines?.accessibilityLabel).toMatch(/showing/i);
    expect(chips.find((chip) => chip.category === 'ORAL_CARE')?.accessibilityLabel).not.toMatch(
      /showing/i,
    );
  });

  it('offers only the All chip for an empty shelf', () => {
    // Which the screen then does not draw at all: one chip beside itself is two controls that do
    // the same thing.
    expect(shelfCategoryChips([], null)).toHaveLength(1);
  });
});

describe('what a category is allowed to say', () => {
  it('never composes a claim about safety', () => {
    // `08` and `02`: "Oral care" says what a thing is, not what Kynviora thinks of it.
    for (const text of ALL_SHELF_CATEGORY_STRINGS) {
      expect(findForbiddenClaims(text)).toEqual([]);
      expect(text).not.toMatch(/\b(safe|unsafe|risk|approved|verified)\b/i);
    }
  });

  it('names the group with no category for what it is, not for what is missing', () => {
    // "Uncategorised" is a database word and reads as a fault in the record.
    expect(presentShelfCategory('UNCATEGORISED')).not.toMatch(/uncategor/i);
    expect(presentShelfCategory('UNCATEGORISED')).not.toMatch(/unknown|missing|none/i);
  });

  it('covers every kind and category the domain has', () => {
    // The failure this catches is a category added to `03`'s vocabulary and not to this one, which
    // would silently draw those products under "Other products" for ever.
    const reachable = new Set<ShelfCategory>();
    for (const kind of ITEM_KINDS) reachable.add(shelfCategoryOf(item(kind, null)));
    for (const category of PERSONAL_CARE_CATEGORIES) {
      reachable.add(shelfCategoryOf(item('PERSONAL_CARE', category)));
    }
    expect([...reachable].sort()).toEqual([...SHELF_CATEGORIES].sort());
  });
});
