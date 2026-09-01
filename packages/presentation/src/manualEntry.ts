/**
 * The manual-entry form, in words.
 *
 * Spec references: `04` Phase 2.2 (manual medicine entry - "a user can create a clinically useful
 * current medicine record entirely manually"; "missing fields remain explicitly unknown rather
 * than receiving defaults"), `04` Phase 2.3 (manual personal-care entry - "personal-care data is
 * not reduced to name + barcode"), `18` (familiar words first, one idea per sentence; a label is
 * always present), `10` (state the limits where you state the findings), `02`, `09`.
 *
 * ONE REQUIRED FIELD
 * A person holding a box in a kitchen has a name and may have nothing else to hand, and Phase
 * 2.2's first exit criterion says the record has to be creatable from that. Every other field is
 * optional and says so, and none of them is marked recommended: a form that scolded somebody for
 * leaving the batch code blank would collect guessed batch codes.
 *
 * THE HELP TEXT SAYS WHAT LEAVING IT BLANK COSTS
 * Not "required for full protection" - that is the completeness score `02` refuses, dressed as
 * advice. Each optional field says the specific thing Kynviora will not be able to do, so a
 * person can decide whether it is worth fetching the box back out of the cupboard.
 *
 * PERSONAL CARE IS NOT NAME PLUS BARCODE
 * Phase 2.3's second exit criterion, in the field list: category, manufacturer, market, label
 * version and the ingredient declaration are all offered, and the declaration has a field big
 * enough to paste a whole back-of-bottle paragraph into.
 */

import type { ItemKind, ManualEntryLimit, PersonalCareCategory } from '@kynviora/domain';
import { MANUAL_ENTRY_LIMITS, PERSONAL_CARE_CATEGORIES } from '@kynviora/domain';
import { PERSONAL_CARE_CATEGORY_LABELS } from './itemDetail.js';

export const MANUAL_FIELD_INPUTS = ['TEXT', 'LONG_TEXT', 'DATE', 'CHOICE'] as const;
export type ManualFieldInput = (typeof MANUAL_FIELD_INPUTS)[number];

export interface ManualFieldChoice {
  readonly value: string;
  readonly label: string;
}

export interface ManualField {
  /** The key on {@link import('@kynviora/domain').ManualEntry}. */
  readonly field: string;
  readonly label: string;
  /**
   * What it is for, and - where the field is optional - what leaving it blank costs.
   *
   * Never what to do about the medicine (`09`), and never a nudge to fill it in.
   */
  readonly help: string;
  readonly input: ManualFieldInput;
  readonly choices: readonly ManualFieldChoice[];
  /** Exactly one field is required, on both forms. */
  readonly required: boolean;
  /** Shown where a person leaves it blank. Never a default value - see the module note. */
  readonly absentNote: string;
}

const UNKNOWN = 'Left blank, this stays explicitly unknown. Kynviora will not guess it.';

function field(
  field_: string,
  label: string,
  help: string,
  input: ManualFieldInput = 'TEXT',
  choices: readonly ManualFieldChoice[] = [],
): ManualField {
  return { field: field_, label, help, input, choices, required: false, absentNote: UNKNOWN };
}

const NAME_FIELD: ManualField = {
  field: 'displayName',
  label: 'What is it called',
  help: 'Whatever you would call it when looking for it. You can change this later.',
  input: 'TEXT',
  choices: [],
  required: true,
  absentNote: '',
};

/** Fields both categories share, in the order a person reads a pack. */
const SHARED_FIELDS: readonly ManualField[] = Object.freeze([
  field('brand', 'Brand', 'The brand printed on the front, if there is one.'),
  field(
    'manufacturer',
    'Who makes it',
    'The manufacturer or the company that markets it, usually in small print on the back.',
  ),
  field(
    'market',
    'Where it was bought',
    'Two capital letters, like GB or IN. Kynviora watches different regulators in different places, so this decides which ones apply.',
  ),
  field(
    'recordedGtin',
    'Barcode number',
    'The digits under the barcode. Without it Kynviora cannot match this to a product record, so a recall about the product will not reach this item.',
  ),
  field(
    'recordedLotCode',
    'Batch or lot code',
    'Usually near the expiry date. Without it a recall can only be matched to the product, never to your particular pack.',
  ),
  field(
    'expiresOn',
    'Expiry date',
    'Without it Kynviora cannot tell you when this stops being in date.',
    'DATE',
  ),
  field('startedOn', 'When you started using it', 'Only if you want it on the record.', 'DATE'),
  field(
    'notes',
    'Your own notes',
    'Anything you want to remember about this pack. Kynviora keeps it as you wrote it and does not read it.',
    'LONG_TEXT',
  ),
]);

const MEDICINE_FIELDS: readonly ManualField[] = Object.freeze([
  field('strengthText', 'Strength', 'As printed - for example 500 mg.'),
  field('dosageForm', 'Form', 'Tablet, capsule, liquid, cream, and so on.'),
  field(
    'directionsText',
    'Directions as written',
    'Copy the directions exactly as they are printed or as they were prescribed. Kynviora keeps them word for word and never rewrites them.',
    'LONG_TEXT',
  ),
]);

const PERSONAL_CARE_FIELDS: readonly ManualField[] = Object.freeze([
  field(
    'personalCareCategory',
    'Kind of product',
    'What sort of thing it is.',
    'CHOICE',
    PERSONAL_CARE_CATEGORIES.map((value: PersonalCareCategory) => ({
      value,
      label: PERSONAL_CARE_CATEGORY_LABELS[value],
    })),
  ),
  field(
    'ingredientDeclarationRaw',
    'Ingredients as printed',
    'Copy the list off the back of the pack, in the order it is printed. Without it Kynviora cannot check this against anything recorded on a profile.',
    'LONG_TEXT',
  ),
  field(
    'labelVersionNote',
    'Anything on the label about the version',
    'Some packs say "new formula" or carry a revision date. Worth noting because manufacturers change formulas without changing the name.',
  ),
]);

export interface ManualEntryForm {
  readonly itemKind: ItemKind;
  readonly heading: string;
  readonly fields: readonly ManualField[];
  /** On the form, above the fields. What this record will and will not be. */
  readonly intro: string;
  /** On the form, at the end. Why nothing here is marked confirmed. */
  readonly verificationNote: string;
}

/**
 * The form for one category.
 *
 * The category's own fields come before the shared ones, because they are what a person is
 * looking at when they decide what this thing is. The name is first on both.
 */
export function manualEntryForm(itemKind: ItemKind): ManualEntryForm {
  const isMedicine = itemKind === 'MEDICINE';
  return {
    itemKind,
    heading: isMedicine ? 'Add a medicine' : 'Add a personal-care product',
    fields: [
      NAME_FIELD,
      ...(isMedicine ? MEDICINE_FIELDS : PERSONAL_CARE_FIELDS),
      ...SHARED_FIELDS,
    ],
    intro:
      'Only the name is needed. Everything else is optional, and anything you leave blank stays blank - Kynviora will not fill it in or guess.',
    verificationNote:
      'Nothing you type here is marked as confirmed, and that is not Kynviora doubting you. Confirming means something was read off the pack, so the item will show as not yet confirmed until that happens.',
  };
}

/** Every field either form offers, for the copy scans. */
export const ALL_MANUAL_ENTRY_STRINGS: readonly string[] = Object.freeze([
  ...[NAME_FIELD, ...SHARED_FIELDS, ...MEDICINE_FIELDS, ...PERSONAL_CARE_FIELDS].flatMap(
    (entry) => [entry.label, entry.help, ...entry.choices.map((choice) => choice.label)],
  ),
  manualEntryForm('MEDICINE').intro,
  manualEntryForm('MEDICINE').verificationNote,
]);

// ---------------------------------------------------------------------------
// What the record cannot do yet
// ---------------------------------------------------------------------------

/**
 * One sentence per limit. A total record over the domain vocabulary.
 *
 * Said after saving rather than while typing. During entry it would read as a scold; afterwards it
 * is `10`'s obligation met at the moment a person can still act on it, and before the first time
 * an alert fails to arrive and nobody knows why.
 */
export const MANUAL_ENTRY_LIMIT_TEXT: Readonly<Record<ManualEntryLimit, string>> = Object.freeze({
  NO_IDENTIFIER:
    'Without a barcode, Kynviora cannot match this to a product record, so a recall about the product will not reach this item.',
  NO_BATCH:
    'Without a batch or lot code, a recall can be matched to the product but never to your particular pack.',
  NO_INGREDIENTS:
    'Without the ingredient list, Kynviora cannot check this against anything recorded on a profile.',
  NO_EXPIRY: 'Without an expiry date, Kynviora cannot tell you when this stops being in date.',
});

export interface ManualEntryOutcomeView {
  readonly heading: string;
  /** What this record cannot support, in vocabulary order. Empty is a legitimate answer. */
  readonly limits: readonly string[];
  /** Said where nothing is missing. Never "all good" (`18`). */
  readonly completeNote: string | null;
  /** On screen either way: adding to the record later is expected, not a failure. */
  readonly note: string;
}

/**
 * What to say once the record exists.
 *
 * Deliberately has no count and no ordering by importance. A record somebody left sparse on
 * purpose is not a worse record, and ranking what is missing would be the completeness score `02`
 * refuses with the number left off.
 */
export function manualEntryOutcomeView(limits: readonly string[]): ManualEntryOutcomeView {
  const described = MANUAL_ENTRY_LIMITS.filter((limit) => limits.includes(limit));
  return {
    heading: 'Saved',
    limits: described.map((limit) => MANUAL_ENTRY_LIMIT_TEXT[limit]),
    completeNote:
      described.length > 0
        ? null
        : 'You entered everything Kynviora asks for. It has not checked any of it against a pack yet.',
    note: 'You can add anything missing later from the item itself. Nothing here has to be filled in all at once.',
  };
}
