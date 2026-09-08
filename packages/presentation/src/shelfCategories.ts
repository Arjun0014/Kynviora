/**
 * How the shelf is grouped, and what each group is called.
 *
 * Spec references: `03` (the MVP's item kinds and personal-care categories), `06` (Shelf defines
 * every state), `02` (no ranking, no aggregate, no score), `18` (a group is named; an absence is
 * legible as an absence), `08` (a category is a property of the record, never a verdict about the
 * product), DEC-160.
 *
 * WHY THE TAXONOMY IS `item_kind` PLUS `personal_care_category` AND NOTHING NEW
 * V3 asks for "clearer category sections" on Shelf and its mock draws five: Medicines, Oral care,
 * Hair care, Sun care, Skin care. Every one of those already exists in the schema - `0004` has
 * `item_kind` and a six-member `personal_care_category` - so this adds no column and invents no
 * classification. What V3's mock leaves out (`BODY_CLEANSER`, `COSMETIC_TOPICAL`) is drawn here
 * anyway: they are values the database accepts, and a group that could not be rendered would be
 * items missing from a screen that claims to show a shelf.
 *
 * THE ORDER IS FIXED AND IT IS NOT A RANKING
 * `02` forbids ranking, and the temptation on a grouped list is to order by size - which reads as
 * "this is the important one" and, worse, reorders under somebody's feet as they add things. The
 * order here is a fixed taxonomy order: medicines first because they are the kind with a schedule
 * and a dose history behind them, then the personal-care categories in V3's own order, then the
 * two it does not draw, then the products whose category nobody has recorded.
 *
 * A GROUP WITH NOTHING IN IT IS NOT DRAWN, AND THAT IS NOT AN ABSENCE
 * `18` requires an absence to be legible, and an empty "Sun care" heading is not one: nothing is
 * missing, the person simply owns no sunscreen. What must be legible is a **filtered** list, which
 * is the screen's job and is why {@link shelfCategoryChips} always offers the way back to all of
 * them.
 *
 * A CATEGORY IS NEVER A VERDICT
 * `08` and `02`: "Oral care" says what a thing is, not what Kynviora thinks of it. Nothing in this
 * module composes a sentence about safety, and `shelfCategories.test.ts` asserts that over every
 * string it can produce rather than over the ones that looked risky.
 */

import {
  PERSONAL_CARE_CATEGORIES,
  type ItemKind,
  type PersonalCareCategory,
} from '@kynviora/domain';

/**
 * Every group the shelf can draw.
 *
 * `MEDICINE` is the item kind; the middle six are `personal_care_category`; `UNCATEGORISED` is the
 * group for a personal-care product whose category is `null`. That last one is not a defect: `04`
 * Phase 2.2 requires a clinically useful record to be creatable entirely manually with missing
 * fields staying explicitly unknown, so a product with no category is an ordinary record and needs
 * somewhere to be drawn.
 */
export const SHELF_CATEGORIES = [
  'MEDICINE',
  'ORAL_CARE',
  'HAIR_CARE',
  'SUNSCREEN',
  'SKIN_CARE',
  'BODY_CLEANSER',
  'COSMETIC_TOPICAL',
  'UNCATEGORISED',
] as const;
export type ShelfCategory = (typeof SHELF_CATEGORIES)[number];

const LABELS: Readonly<Record<ShelfCategory, string>> = Object.freeze({
  MEDICINE: 'Medicines',
  ORAL_CARE: 'Oral care',
  HAIR_CARE: 'Hair care',
  SUNSCREEN: 'Sun care',
  SKIN_CARE: 'Skin care',
  BODY_CLEANSER: 'Washing',
  COSMETIC_TOPICAL: 'Cosmetics',
  // Named for what is true of it rather than for what is missing. "Uncategorised" is a database
  // word and reads as a fault in the record; these are products somebody wrote down without
  // saying what kind they were, which is a thing `04` Phase 2.2 explicitly allows.
  UNCATEGORISED: 'Other products',
});

export function presentShelfCategory(category: ShelfCategory): string {
  return LABELS[category];
}

/** What a row belongs to. The two fields the schema already carries, and nothing else. */
export interface CategorisableItem {
  readonly itemKind: ItemKind;
  readonly personalCareCategory: string | null;
}

/**
 * Which group a row is drawn in.
 *
 * A medicine is a medicine whatever else is on the row - `owned_item_category_matches_kind` will
 * not let one carry a personal-care category, and reading the category first would put a row in a
 * group its own kind contradicts if that constraint were ever relaxed.
 */
export function shelfCategoryOf(item: CategorisableItem): ShelfCategory {
  if (item.itemKind === 'MEDICINE') return 'MEDICINE';
  const category = item.personalCareCategory;
  return category !== null && (PERSONAL_CARE_CATEGORIES as readonly string[]).includes(category)
    ? (category as PersonalCareCategory)
    : 'UNCATEGORISED';
}

export interface ShelfCategoryGroup<T> {
  readonly category: ShelfCategory;
  readonly label: string;
  /** How many rows are in it. A count of what is here, never a score and never an ordering key. */
  readonly count: number;
  readonly items: readonly T[];
}

/**
 * The rows, grouped, in taxonomy order, with empty groups left out.
 *
 * Rows keep their order within a group, which is the server's - `02` forbids this layer deciding
 * which of two people's medicines matters more, and sorting inside a group would be that decision
 * made quietly.
 */
export function shelfCategoryGroups<T extends CategorisableItem>(
  items: readonly T[],
): readonly ShelfCategoryGroup<T>[] {
  const groups: ShelfCategoryGroup<T>[] = [];
  for (const category of SHELF_CATEGORIES) {
    const inGroup = items.filter((item) => shelfCategoryOf(item) === category);
    if (inGroup.length === 0) continue;
    groups.push({
      category,
      label: LABELS[category],
      count: inGroup.length,
      items: inGroup,
    });
  }
  return groups;
}

export interface ShelfCategoryChip {
  /** `null` is the chip that shows everything, and it is always offered. */
  readonly category: ShelfCategory | null;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
  /** What a screen reader announces, which has to carry the state as a word (`18`). */
  readonly accessibilityLabel: string;
}

/**
 * The chips, over the collection in hand.
 *
 * "All" is first and is always present, including when a category is selected - `18` requires a
 * filtered list to be legible as one, and the way back to everything must not itself be filtered
 * away. A category with nothing in it gets no chip, because a chip that narrowed to nothing is a
 * control whose only outcome is an empty screen.
 *
 * The counts are of the rows passed in, which is the collection on screen. A count that spanned
 * both collections would be a number a person cannot check against what is in front of them.
 */
export function shelfCategoryChips(
  items: readonly CategorisableItem[],
  selected: ShelfCategory | null,
): readonly ShelfCategoryChip[] {
  const chips: ShelfCategoryChip[] = [
    {
      category: null,
      label: 'All',
      count: items.length,
      selected: selected === null,
      accessibilityLabel:
        selected === null
          ? `All, showing. ${String(items.length)} on this shelf.`
          : `All. ${String(items.length)} on this shelf. Press to stop filtering.`,
    },
  ];

  for (const group of shelfCategoryGroups(items)) {
    const isSelected = selected === group.category;
    chips.push({
      category: group.category,
      label: group.label,
      count: group.count,
      selected: isSelected,
      accessibilityLabel: isSelected
        ? `${group.label}, showing. ${String(group.count)} of them.`
        : `${group.label}. ${String(group.count)} of them.`,
    });
  }

  return chips;
}

/** Every string this module can put on a screen, for the copy rules to read. */
export const ALL_SHELF_CATEGORY_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(LABELS),
  'All',
]);
