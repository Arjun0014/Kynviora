/**
 * Writing down a pack somebody is holding.
 *
 * Spec references: `04` Phase 2.2 (manual medicine entry - "a user can create a clinically useful
 * current medicine record entirely manually"; "missing fields remain explicitly unknown rather
 * than receiving defaults"), `04` Phase 2.3 (manual personal-care entry - "product detail makes
 * identity versus formula confidence visible"; "personal-care data is not reduced to name +
 * barcode"), `07` (a user's own record is distinct from the shared catalog observation), `08`
 * (identity, formulation and batch verification are separate), `02` (unconfirmed input never
 * drives high-impact personalization), `15` A11 (catalog poisoning), `09`.
 *
 * NOTHING ENTERED BY HAND IS VERIFIED, AND THAT IS NOT A PENALTY
 * A submission has no field for a verification state, so a manual entry cannot arrive claiming
 * `CONFIRMED`. That is not Kynviora doubting the person: `08` keeps identity, formulation and
 * batch as separate statements about *evidence*, and typing a name is evidence of what somebody
 * believes rather than of what the pack says. Reading the ingredients off the pack raises the
 * formulation axis, and guided capture is where that happens (`04` Phase 3.2).
 *
 * WHAT IS NOT ENTERED IS ABSENT, NEVER DEFAULTED
 * Phase 2.2's second exit criterion, as a shape: every optional field is `string | null` with no
 * fallback anywhere in this module, and {@link normalizeManualEntry} turns blank and
 * whitespace-only input into `null` rather than storing a value that renders as one. There is no
 * "Unknown" string, no `"N/A"`, and no empty-string sentinel - a screen showing "Not recorded" is
 * telling the truth, and a screen showing "Unknown" is showing a value somebody stored.
 *
 * A MANUAL ENTRY NEVER TOUCHES THE CATALOG
 * The submission has no `productIdentityId`, `formulationId` or `batchId`, and no way to acquire
 * one. A household typing a barcode is not the catalog learning one - that is `15` A11 with the
 * attacker replaced by an honest person mis-reading a label - and `04` Phase 3.5's corroborated
 * candidate path is the only way in. Migration `0015` puts the recorded barcode, lot code and
 * declaration on `owned_item` for exactly this reason.
 */

import { domainError, err, ok, type DomainError, type Result } from './result.js';
import type { ItemKind, PersonalCareCategory } from './vocabulary.js';
import { isPersonalCareCategory } from './vocabulary.js';

/** How long a free-text field a person types may be. Generous, and bounded (`14`). */
export const MANUAL_TEXT_MAX = 200;
/** The ingredient declaration, which is a paragraph off a bottle rather than a field. */
export const DECLARATION_MAX = 4000;
/** The household's own note about the item. */
export const NOTES_MAX = 2000;

/**
 * What somebody typed.
 *
 * Every field but the name and the kind is optional, which is Phase 2.2's first exit criterion:
 * a clinically useful record has to be creatable from a name and nothing else, because a person
 * holding a box in a kitchen has a name and may have nothing else to hand.
 *
 * There is deliberately no field for a verification state, a confidence, a catalog identifier or
 * a corroboration - see the module note. Their absence is the enforcement.
 */
export interface ManualEntry {
  readonly itemKind: ItemKind;
  readonly displayName: string;
  readonly brand?: string | null | undefined;
  readonly manufacturer?: string | null | undefined;
  /** ISO 3166-1 alpha-2, where the person knows where the pack came from. */
  readonly market?: string | null | undefined;
  readonly recordedGtin?: string | null | undefined;
  readonly recordedLotCode?: string | null | undefined;
  readonly expiresOn?: string | null | undefined;
  readonly startedOn?: string | null | undefined;
  readonly notes?: string | null | undefined;

  /** Medicine only. */
  readonly strengthText?: string | null | undefined;
  readonly dosageForm?: string | null | undefined;
  readonly directionsText?: string | null | undefined;

  /** Personal care only. */
  readonly personalCareCategory?: string | null | undefined;
  readonly ingredientDeclarationRaw?: string | null | undefined;
  readonly labelVersionNote?: string | null | undefined;
}

/** The same shape, with every absence made explicit and every blank turned into one. */
export interface NormalizedManualEntry {
  readonly itemKind: ItemKind;
  readonly displayName: string;
  readonly brand: string | null;
  readonly manufacturer: string | null;
  readonly market: string | null;
  readonly recordedGtin: string | null;
  readonly recordedLotCode: string | null;
  readonly expiresOn: string | null;
  readonly startedOn: string | null;
  readonly notes: string | null;
  readonly strengthText: string | null;
  readonly dosageForm: string | null;
  readonly directionsText: string | null;
  readonly personalCareCategory: PersonalCareCategory | null;
  readonly ingredientDeclarationRaw: string | null;
  readonly labelVersionNote: string | null;
}

/** Trimmed, or `null`. A field of spaces is not an answer. */
function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function tooLong(value: string | null, max: number): boolean {
  return value !== null && value.length > max;
}

/** GTIN-8, 12, 13 or 14, as digits. The check digit is the catalog's business, not this one's. */
const GTIN_SHAPE = /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/;
/** ISO 3166-1 alpha-2, upper case. */
const MARKET_SHAPE = /^[A-Z]{2}$/;
/** A calendar date. Not an instant: an expiry printed on a box has no time of day. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(reason: string, field: string): DomainError {
  return domainError('VALIDATION_FAILED', reason, { reason_code: 'manual_entry', field });
}

/**
 * Check a submission and make its absences explicit.
 *
 * Refuses rather than repairs. A market of `gb` is not silently upper-cased and a barcode with a
 * space in it is not silently stripped: both are things the person typed, and a value Kynviora
 * quietly altered is one they can no longer check against the pack in their hand. The only
 * normalization is trimming, and that only ever turns something into an absence.
 */
export function normalizeManualEntry(
  entry: ManualEntry,
): Result<NormalizedManualEntry, DomainError> {
  const displayName = text(entry.displayName);
  if (displayName === null) {
    // The one required field. Phase 2.2's first exit criterion needs a record creatable from
    // almost nothing, and a record with no name is a row nobody can find again.
    return err(invalid('An item needs a name.', 'displayName'));
  }
  if (displayName.length > MANUAL_TEXT_MAX) {
    return err(invalid('That name is too long.', 'displayName'));
  }

  const isMedicine = entry.itemKind === 'MEDICINE';

  const brand = text(entry.brand);
  const manufacturer = text(entry.manufacturer);
  const market = text(entry.market);
  const recordedGtin = text(entry.recordedGtin);
  const recordedLotCode = text(entry.recordedLotCode);
  const expiresOn = text(entry.expiresOn);
  const startedOn = text(entry.startedOn);
  const notes = text(entry.notes);
  const strengthText = text(entry.strengthText);
  const dosageForm = text(entry.dosageForm);
  const directionsText = text(entry.directionsText);
  const categoryRaw = text(entry.personalCareCategory);
  const ingredientDeclarationRaw = text(entry.ingredientDeclarationRaw);
  const labelVersionNote = text(entry.labelVersionNote);

  for (const [field, value] of [
    ['brand', brand],
    ['manufacturer', manufacturer],
    ['recordedLotCode', recordedLotCode],
    ['strengthText', strengthText],
    ['dosageForm', dosageForm],
    ['labelVersionNote', labelVersionNote],
  ] as const) {
    if (tooLong(value, MANUAL_TEXT_MAX)) return err(invalid('That value is too long.', field));
  }
  if (tooLong(directionsText, DECLARATION_MAX)) {
    return err(invalid('Those directions are too long.', 'directionsText'));
  }
  if (tooLong(ingredientDeclarationRaw, DECLARATION_MAX)) {
    return err(invalid('That ingredient list is too long.', 'ingredientDeclarationRaw'));
  }
  if (tooLong(notes, NOTES_MAX)) return err(invalid('That note is too long.', 'notes'));

  if (market !== null && !MARKET_SHAPE.test(market)) {
    // Refused rather than upper-cased. `gb` and `GB` are the same to a reader and a value
    // Kynviora changed is one the person can no longer check against what they typed.
    return err(invalid('A market is two capital letters, like GB or IN.', 'market'));
  }
  if (recordedGtin !== null && !GTIN_SHAPE.test(recordedGtin)) {
    // A barcode of the wrong length is a typing mistake, and storing it would make a recall check
    // silently miss the pack it was about.
    return err(invalid('A barcode is 8, 12, 13 or 14 digits.', 'recordedGtin'));
  }
  for (const [field, value] of [
    ['expiresOn', expiresOn],
    ['startedOn', startedOn],
  ] as const) {
    if (value !== null && !DATE_SHAPE.test(value)) {
      return err(invalid('A date looks like 2027-01-31.', field));
    }
  }

  // The two category-specific groups, refused across the line rather than silently dropped. The
  // schema refuses the same shapes (`owned_item_category_matches_kind`), and a route that dropped
  // them would accept a submission and store something the person did not send.
  if (isMedicine) {
    if (categoryRaw !== null) {
      return err(
        invalid('A medicine does not have a personal-care category.', 'personalCareCategory'),
      );
    }
  } else {
    if (strengthText !== null) {
      return err(invalid('A personal-care product does not have a strength.', 'strengthText'));
    }
    if (dosageForm !== null) {
      return err(invalid('A personal-care product does not have a dosage form.', 'dosageForm'));
    }
  }

  let personalCareCategory: PersonalCareCategory | null = null;
  if (categoryRaw !== null) {
    if (!isPersonalCareCategory(categoryRaw)) {
      // A closed vocabulary. An unrecognised category stored as free text would be a value no
      // screen has a phrase for, which is how a code ends up rendered beside somebody's bottle.
      return err(invalid('That is not a kind of product Kynviora knows.', 'personalCareCategory'));
    }
    personalCareCategory = categoryRaw;
  }

  return ok({
    itemKind: entry.itemKind,
    displayName,
    brand,
    manufacturer,
    market,
    recordedGtin,
    recordedLotCode,
    expiresOn,
    startedOn,
    notes,
    strengthText,
    dosageForm,
    directionsText,
    personalCareCategory,
    ingredientDeclarationRaw,
    labelVersionNote,
  });
}

// ---------------------------------------------------------------------------
// What a record can and cannot do yet
// ---------------------------------------------------------------------------

/**
 * What a manually created record is still missing, in the order the fields are asked for.
 *
 * Not a completeness score and not a percentage. `02` forbids the aggregate, and a record a person
 * deliberately left sparse is not a worse record - it is an honest one. This exists so a screen
 * can say what Kynviora will not be able to do rather than how complete somebody has been.
 */
export const MANUAL_ENTRY_LIMITS = [
  /** No barcode, so nothing can be matched to a catalog product identity. */
  'NO_IDENTIFIER',
  /** No batch or lot, so a recall can only ever be matched to the product, not to this pack. */
  'NO_BATCH',
  /** No ingredient declaration, so nothing can be checked against a recorded sensitivity. */
  'NO_INGREDIENTS',
  /** No expiry date, so Kynviora cannot tell anybody when this stops being in date. */
  'NO_EXPIRY',
] as const;
export type ManualEntryLimit = (typeof MANUAL_ENTRY_LIMITS)[number];

/**
 * What this record cannot support, from what it does not contain.
 *
 * Every member is the absence of one field, stated as the capability it costs. `10` requires
 * Kynviora to state its limits where it states its findings, and the moment a person finishes
 * typing is when this is worth saying - not the first time an alert fails to arrive.
 */
export function manualEntryLimits(entry: NormalizedManualEntry): readonly ManualEntryLimit[] {
  const present = new Set<ManualEntryLimit>();
  if (entry.recordedGtin === null) present.add('NO_IDENTIFIER');
  if (entry.recordedLotCode === null) present.add('NO_BATCH');
  if (entry.ingredientDeclarationRaw === null) present.add('NO_INGREDIENTS');
  if (entry.expiresOn === null) present.add('NO_EXPIRY');
  return MANUAL_ENTRY_LIMITS.filter((limit) => present.has(limit));
}
