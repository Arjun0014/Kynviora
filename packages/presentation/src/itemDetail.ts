/**
 * One item on the shelf, and what is not settled about it.
 *
 * Spec references: `04` Phase 2.1 (item detail; the verification and attention filters; "a user
 * can understand which items need verification or review"; "medicines and personal-care items
 * coexist without either being reduced to a generic note"), `08` (the Product Trust Passport keeps
 * identity, formulation and batch separate), `02` (no aggregate score), `18` (a label is always
 * present; meaning is never carried by colour), `10`.
 *
 * TWO CATEGORIES, TWO SETS OF FIELDS, ONE SCREEN
 * Exit criterion 1 says neither category may be reduced to a generic note. The detail carries a
 * medicine's strength, dosage form and written directions, and a personal-care item's category,
 * as separate typed groups - and a field the other category does not have is **absent** rather
 * than rendered empty, because a medicine with a blank "personal care category" row reads as a
 * medicine somebody failed to fill in.
 *
 * DIRECTIONS ARE QUOTED, NEVER REWRITTEN
 * `04` Phase 4.1 requires written directions preserved as source text, and `09` forbids Kynviora
 * telling anybody how to take a medicine. The detail passes `directionsText` through untouched
 * and marks it as somebody else's words, so a screen renders it as a quotation rather than as
 * Kynviora's instruction.
 *
 * WHAT IS MISSING IS A ROW, NOT A GAP
 * Every field a person might expect keeps its place with an explicit "not recorded" rather than
 * disappearing. A dropped row reads as "not relevant to this item"; an empty one reads as "nobody
 * has entered it", and only the second is true.
 */

import type {
  AttentionReason,
  ItemKind,
  ItemVerification,
  PersonalCareCategory,
} from '@kynviora/domain';
import { ATTENTION_REASONS, isItemVerification, isPersonalCareCategory } from '@kynviora/domain';
import { presentVerification, type StatusPresentation } from './status.js';

// ---------------------------------------------------------------------------
// What is not settled
// ---------------------------------------------------------------------------

export interface AttentionPresentation {
  /** What is not settled, as a statement of fact. */
  readonly label: string;
  /** What would settle it. Never what to do about the medicine (`09`). */
  readonly nextStep: string;
}

/**
 * One entry per reason. A total record, so a new reason is a sentence somebody writes.
 *
 * Every `nextStep` is something a person can do to the *record*: read a label, enter a number,
 * confirm a detail. None of them is about the product itself, because "check with your pharmacist
 * before taking this" would be Kynviora deciding an unverified batch is a medical concern, which
 * it has no basis to decide.
 */
export const ATTENTION_PRESENTATION: Readonly<Record<AttentionReason, AttentionPresentation>> =
  Object.freeze({
    IDENTITY_UNVERIFIED: {
      label: 'Nobody has confirmed which product this is',
      nextStep: 'Scan the barcode or check the name and brand against the pack.',
    },
    IDENTITY_CONFLICTING: {
      label: 'Two sources disagree about which product this is',
      nextStep: 'Check the pack and correct the name or brand, so Kynviora has one answer.',
    },
    FORMULATION_UNVERIFIED: {
      label: 'The ingredient list has not been confirmed from this pack',
      nextStep:
        'Read the ingredients printed on the pack you have. Manufacturers change formulas without changing the name.',
    },
    FORMULATION_CONFLICTING: {
      label: 'Two sources disagree about the ingredients',
      nextStep: 'Read the list on the pack you have, which is the only one that describes it.',
    },
    BATCH_UNVERIFIED: {
      label: 'The batch or lot number is not recorded',
      nextStep:
        'It is printed on the pack, often near the expiry date. Without it Kynviora can only tell you whether a recall covers the product, not your pack.',
    },
    BATCH_CONFLICTING: {
      label: 'Two sources disagree about the batch',
      nextStep: 'Check the code printed on the pack and correct it.',
    },
    NEVER_REVIEWED: {
      label: 'Nobody has looked at this record since it was created',
      nextStep: 'Open it and check the details still describe what is in the cupboard.',
    },
    NEVER_SAFETY_CHECKED: {
      label: 'Kynviora has not checked this against anything yet',
      nextStep:
        'Nothing needs doing. This says what Kynviora has not done, not that anything is wrong.',
    },
  });

export function presentAttention(reason: AttentionReason): AttentionPresentation {
  return ATTENTION_PRESENTATION[reason];
}

/**
 * Reasons as a screen renders them, in vocabulary order.
 *
 * A reason this build has no wording for is **dropped and counted**, the same choice made for a
 * match reason and a regulatory status: a bare `IDENTITY_SUPERSEDED` beside somebody's medicine is
 * a field value, not a sentence.
 */
export interface AttentionListView {
  readonly reasons: readonly (AttentionPresentation & { readonly reason: string })[];
  readonly undescribedCount: number;
  readonly undescribedNote: string | null;
  /** Said where nothing is outstanding. Never "all good" - see below. */
  readonly settledNote: string | null;
}

export function attentionListView(reasons: readonly string[]): AttentionListView {
  const described = ATTENTION_REASONS.filter((reason) => reasons.includes(reason));
  const undescribed = reasons.length - described.length;

  return {
    reasons: described.map((reason) => ({ reason, ...presentAttention(reason) })),
    undescribedCount: undescribed,
    undescribedNote:
      undescribed === 0
        ? null
        : `Kynviora has ${String(undescribed)} further ${
            undescribed === 1 ? 'note' : 'notes'
          } about this item that this version has no wording for.`,
    // Not "everything looks good". `18` forbids presenting an absence of findings as
    // reassurance, and this list is about what has been *entered*, not about whether the medicine
    // is safe - which is the Safety screen's question and a different one.
    settledNote:
      reasons.length > 0
        ? null
        : 'Everything Kynviora asks for about this item has been entered. That is about the record, not about the product.',
  };
}

// ---------------------------------------------------------------------------
// The item itself
// ---------------------------------------------------------------------------

/** A labelled fact, kept in place when there is nothing to show. */
export interface ItemField {
  readonly label: string;
  readonly value: string | null;
  /** Said instead of the value where there is none. */
  readonly absentNote: string | null;
  /**
   * Whether this is somebody else's words, quoted.
   *
   * True for written directions. A screen renders those as a quotation rather than as Kynviora's
   * instruction, because `09` forbids Kynviora telling anybody how to take a medicine and `04`
   * Phase 4.1 requires the source text preserved.
   */
  readonly quoted: boolean;
}

function field(label: string, value: string | null, quoted = false): ItemField {
  const missing = value === null || value.trim() === '';
  return {
    label,
    value: missing ? null : value,
    absentNote: missing ? 'Not recorded' : null,
    quoted,
  };
}

export interface ItemDetailInput {
  readonly id: string;
  readonly itemKind: string;
  readonly displayName: string;
  readonly brand: string | null;
  readonly market: string | null;
  readonly lifecycleState: string;

  readonly identityVerification: string;
  readonly formulationVerification: string;
  readonly batchVerification: string;

  readonly strengthText: string | null;
  readonly dosageForm: string | null;
  readonly directionsText: string | null;
  readonly personalCareCategory: string | null;

  readonly startedOn: string | null;
  readonly stoppedOn: string | null;
  readonly expiresOn: string | null;
  readonly lastReviewedAt: string | null;
  readonly lastSafetyCheckedAt: string | null;

  readonly notes: string | null;
  readonly attentionReasons: readonly string[];
}

export interface ItemDetailView {
  readonly id: string;
  readonly displayName: string;
  readonly brand: string | null;
  readonly itemKind: ItemKind;
  readonly lifecycleState: string;
  readonly lifecycleNote: string | null;

  /** Three separate presentations, never merged. `02` forbids the aggregate (`08`). */
  readonly identity: StatusPresentation;
  readonly formulation: StatusPresentation;
  readonly batch: StatusPresentation;
  /** On screen beside them, so three chips are not read as a score. */
  readonly verificationNote: string;

  /** The fields this category has. A field the other category has is absent, not blank. */
  readonly categoryHeading: string;
  readonly categoryFields: readonly ItemField[];
  readonly sharedFields: readonly ItemField[];

  readonly attention: AttentionListView;
}

const LIFECYCLE_NOTES: Readonly<Record<string, string>> = Object.freeze({
  STOPPED:
    'This item is marked as stopped. Kynviora keeps it and what it knew about it, and does not ask you to check it any further.',
  ARCHIVED:
    'This item is archived. It stays on the record and is not part of what Kynviora watches.',
});

/**
 * What each personal-care category is called on a screen.
 *
 * A closed vocabulary in the schema, so it arrives as a code and must not be rendered as one. A
 * total record, so a new category is a phrase somebody writes rather than `BODY_CLEANSER` beside
 * a bottle in somebody's bathroom.
 */
export const PERSONAL_CARE_CATEGORY_LABELS: Readonly<Record<PersonalCareCategory, string>> =
  Object.freeze({
    SKIN_CARE: 'Skin care',
    SUNSCREEN: 'Sunscreen',
    HAIR_CARE: 'Hair care',
    BODY_CLEANSER: 'Soap or body wash',
    ORAL_CARE: 'Oral care',
    COSMETIC_TOPICAL: 'Make-up or other topical cosmetic',
  });

/**
 * The category as a phrase, or `null`.
 *
 * `null` where the value is absent **or** where this build has no phrase for it. A code shown raw
 * would be worse than the honest "Not recorded" the field falls back to, which is the same choice
 * an undescribed regulatory status gets (DEC-065).
 */
export function personalCareCategoryLabel(raw: string | null): string | null {
  if (raw === null) return null;
  return isPersonalCareCategory(raw) ? PERSONAL_CARE_CATEGORY_LABELS[raw] : null;
}

function asItemVerification(raw: string): ItemVerification {
  // Unknown means unverified. Never `CONFIRMED` - a value this build cannot read must never
  // become the most reassuring member of the vocabulary.
  return isItemVerification(raw) ? raw : 'UNVERIFIED';
}

export function itemDetailView(input: ItemDetailInput): ItemDetailView {
  const isMedicine = input.itemKind === 'MEDICINE';

  // Exit criterion 1. Two typed groups, and the group a category does not have is not rendered
  // at all - a medicine with an empty "personal care category" row reads as one somebody failed
  // to fill in, which is exactly the reduction to a generic note the criterion forbids.
  const categoryFields = isMedicine
    ? [
        field('Strength', input.strengthText),
        field('Form', input.dosageForm),
        // Quoted, never rewritten and never summarised (`04` Phase 4.1, `09`).
        field('Directions as written', input.directionsText, true),
      ]
    : [field('Kind of product', personalCareCategoryLabel(input.personalCareCategory))];

  return {
    id: input.id,
    displayName: input.displayName,
    brand: input.brand,
    itemKind: isMedicine ? 'MEDICINE' : 'PERSONAL_CARE',
    lifecycleState: input.lifecycleState,
    lifecycleNote: LIFECYCLE_NOTES[input.lifecycleState] ?? null,

    identity: presentVerification(asItemVerification(input.identityVerification), 'identity'),
    formulation: presentVerification(
      asItemVerification(input.formulationVerification),
      'formulation',
    ),
    batch: presentVerification(asItemVerification(input.batchVerification), 'batch'),
    verificationNote:
      'These three are tracked separately. Knowing which product this is does not mean the ' +
      'ingredients have been read from your pack, and neither means the batch number is recorded.',

    categoryHeading: isMedicine ? 'About this medicine' : 'About this product',
    categoryFields,
    sharedFields: [
      field('Where it was bought', input.market),
      field('Started', input.startedOn),
      field('Stopped', input.stoppedOn),
      field('Expires', input.expiresOn),
      field('Last looked at', input.lastReviewedAt),
      field('Last checked by Kynviora', input.lastSafetyCheckedAt),
      field('Your notes', input.notes, true),
    ],

    attention: attentionListView(input.attentionReasons),
  };
}
