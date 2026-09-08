/**
 * Changing a record that already exists, and putting an item out of use.
 *
 * Spec references: `04` Stage 2 stage output ("users can create, view, update, archive, and
 * review medicine and personal-care items"), `04` Phase 2.1 ("common item lifecycle: active,
 * stopped, archived, deleted according to retention policy"; "first used, stopped, last reviewed
 * and last checked timestamps"), `13` (conflict policy per entity type), `12` (optimistic
 * updates only for low-risk user-owned changes), `08`, `02`, `09`.
 *
 * AN UPDATE IS VALIDATED AS THE RECORD IT WOULD PRODUCE
 * The patch is merged over the stored values and the whole thing goes through
 * {@link normalizeManualEntry}. There is deliberately no second set of rules: a field that could
 * not be entered on the form must not become enterable by editing, and two validators that agree
 * today are two validators that disagree later.
 *
 * ABSENT AND NULL ARE DIFFERENT ANSWERS
 * A field left out of the patch is unchanged. A field sent as `null` is cleared, and becomes an
 * absence rather than an empty string - the same rule creation follows (`04` Phase 2.2's second
 * exit criterion). Collapsing them would mean either that nothing can ever be un-entered, or that
 * every save wipes every field the screen did not happen to send.
 *
 * NOTHING HERE CAN CLAIM SOMETHING WAS CHECKED
 * There is no field for a verification state, a catalog identifier, a match confidence, or an
 * item's category - editing a record is not evidence about a pack, and `08` reserves those for
 * something read off it. `itemKind` is absent for a different reason: a medicine that became a
 * shampoo would take its strength and its written directions with it, and the schema's
 * `owned_item_category_matches_kind` would refuse the row anyway.
 *
 * AND NO TIMESTAMP THAT ASSERTS SOMEBODY DID SOMETHING
 * "Last looked at" is a request, not a value: {@link ItemUpdate.markReviewed} is a boolean and the
 * server stamps the time. A client-supplied `lastReviewedAt` would let a screen claim a person
 * reviewed a medicine at a moment they did not, on the timestamp the Shelf's "not yet looked at"
 * filter reads.
 *
 * THE CONFLICT POLICY IS `ASK_USER`, AND THAT IS WHY THE VERSION IS REQUIRED
 * `13` sets `owned_item` to `ASK_USER` (see `sync.ts`), so a stale edit must not silently win.
 * {@link ItemUpdate.expectedVersion} is required, the write is conditional on it, and a person
 * whose copy has moved is shown what the record says now rather than being told their save
 * worked.
 */

import { domainError, err, ok, type DomainError, type Result } from './result.js';
import {
  normalizeManualEntry,
  type ManualEntry,
  type NormalizedManualEntry,
} from './manualEntry.js';
import {
  isShelfCollection,
  mayBeInCollection,
  type ItemKind,
  type ShelfCollection,
} from './vocabulary.js';

/**
 * What an item's lifecycle can be.
 *
 * `04` Phase 2.1 lists four - active, stopped, archived, deleted - and deletion is not a state
 * here. It is a retention decision with its own rules (`01`, `16`), and `owned_item.deleted_at`
 * is a separate column for exactly that reason: a row a person asked to be forgotten is not a
 * fourth item on this list.
 */
export const ITEM_LIFECYCLE_STATES = ['ACTIVE', 'STOPPED', 'ARCHIVED'] as const;
export type ItemLifecycleState = (typeof ITEM_LIFECYCLE_STATES)[number];

export function isItemLifecycleState(value: string): value is ItemLifecycleState {
  return (ITEM_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/** The record as it stands, which is what a patch is applied to. */
export interface StoredItem extends NormalizedManualEntry {
  readonly version: number;
  readonly lifecycleState: ItemLifecycleState;
  readonly stoppedOn: string | null;
  readonly shelfCollection: ShelfCollection;
}

/**
 * What somebody asked to change.
 *
 * Every field is optional and every optional field distinguishes absent from `null`. See the
 * module note: absent means unchanged, `null` means cleared.
 */
export interface ItemUpdate {
  /** The version the editor was looking at. Required - see the module note. */
  readonly expectedVersion: number;

  /** The one field that cannot be cleared, because a record with no name cannot be found again. */
  readonly displayName?: string | undefined;
  readonly brand?: string | null | undefined;
  readonly manufacturer?: string | null | undefined;
  readonly market?: string | null | undefined;
  readonly recordedGtin?: string | null | undefined;
  readonly recordedLotCode?: string | null | undefined;
  readonly expiresOn?: string | null | undefined;
  readonly startedOn?: string | null | undefined;
  readonly notes?: string | null | undefined;

  readonly strengthText?: string | null | undefined;
  readonly dosageForm?: string | null | undefined;
  readonly directionsText?: string | null | undefined;

  readonly personalCareCategory?: string | null | undefined;
  readonly ingredientDeclarationRaw?: string | null | undefined;
  readonly labelVersionNote?: string | null | undefined;

  readonly lifecycleState?: string | undefined;
  readonly stoppedOn?: string | null | undefined;
  /**
   * Moving between the shelf's two collections (`0033`, DEC-160).
   *
   * A patch field rather than a route of its own: it is a change to the record, it takes the same
   * version precondition as every other change, and it belongs in the same audit row. `13` sets
   * `owned_item` to `ASK_USER`, and a move made against a copy somebody else has since edited is
   * the same stale write as any other.
   */
  readonly shelfCollection?: string | undefined;
  /** A request that the server stamp "last looked at" as now. Never a supplied timestamp. */
  readonly markReviewed?: boolean | undefined;
}

/** What the row should become. Every field is stated, so a caller cannot half-apply it. */
export interface ItemUpdateOutcome {
  readonly fields: NormalizedManualEntry;
  readonly lifecycleState: ItemLifecycleState;
  readonly stoppedOn: string | null;
  readonly shelfCollection: ShelfCollection;
  /** True where the server should stamp `last_reviewed_at`. */
  readonly stampReviewed: boolean;
  /**
   * What actually changes, for the audit row and for the response.
   *
   * Field names only, never values: `14` keeps the content of somebody's medicine record out of a
   * log, and "the strength changed" is what an access history needs to be useful.
   */
  readonly changedFields: readonly string[];
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(reason: string, field: string): DomainError {
  return domainError('VALIDATION_FAILED', reason, { reason_code: 'item_update', field });
}

/**
 * A patch value resolved against what is stored.
 *
 * `undefined` in, stored value out. Anything else in, that value out - including `null`, which is
 * how a field is emptied.
 */
function resolve(patched: string | null | undefined, stored: string | null): string | null {
  return patched === undefined ? stored : patched;
}

/** Every field a patch may carry, paired with where it lives on the two shapes. */
const PATCHABLE = [
  'brand',
  'manufacturer',
  'market',
  'recordedGtin',
  'recordedLotCode',
  'expiresOn',
  'startedOn',
  'notes',
  'strengthText',
  'dosageForm',
  'directionsText',
  'personalCareCategory',
  'ingredientDeclarationRaw',
  'labelVersionNote',
] as const;

/**
 * Check a change and say what the row becomes.
 *
 * Refuses rather than repairs, exactly as creation does, and for the same reason: a value
 * Kynviora quietly altered is one the person can no longer check against the pack in their hand.
 */
export function normalizeItemUpdate(
  stored: StoredItem,
  patch: ItemUpdate,
): Result<ItemUpdateOutcome, DomainError> {
  // The record the patch would produce, validated by the rules that govern creating one. A field
  // that cannot be entered on the form must not become enterable by editing.
  //
  // Written out rather than assembled from a loop and cast. The cast is what would let a field
  // added to `ManualEntry` later be silently absent here, which is the same silent-drop this
  // phase's other half spent a whole end-to-end suite catching.
  const itemKind: ItemKind = stored.itemKind;
  const merged: ManualEntry = {
    itemKind,
    displayName: patch.displayName === undefined ? stored.displayName : patch.displayName,
    brand: resolve(patch.brand, stored.brand),
    manufacturer: resolve(patch.manufacturer, stored.manufacturer),
    market: resolve(patch.market, stored.market),
    recordedGtin: resolve(patch.recordedGtin, stored.recordedGtin),
    recordedLotCode: resolve(patch.recordedLotCode, stored.recordedLotCode),
    expiresOn: resolve(patch.expiresOn, stored.expiresOn),
    startedOn: resolve(patch.startedOn, stored.startedOn),
    notes: resolve(patch.notes, stored.notes),
    strengthText: resolve(patch.strengthText, stored.strengthText),
    dosageForm: resolve(patch.dosageForm, stored.dosageForm),
    directionsText: resolve(patch.directionsText, stored.directionsText),
    personalCareCategory: resolve(patch.personalCareCategory, stored.personalCareCategory),
    ingredientDeclarationRaw: resolve(
      patch.ingredientDeclarationRaw,
      stored.ingredientDeclarationRaw,
    ),
    labelVersionNote: resolve(patch.labelVersionNote, stored.labelVersionNote),
  };

  const normalized = normalizeManualEntry(merged);
  if (!normalized.ok) return normalized;
  const fields = normalized.value;

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  let lifecycleState = stored.lifecycleState;
  if (patch.lifecycleState !== undefined) {
    if (!isItemLifecycleState(patch.lifecycleState)) {
      // A closed vocabulary. An unrecognised state stored as free text would be a value the shelf
      // has no rule for, and `shelfAttention` treats everything that is not `ACTIVE` as finished
      // with - so an invented state would quietly stop Kynviora asking about a live medicine.
      return err(invalid('That is not a state an item can be in.', 'lifecycleState'));
    }
    lifecycleState = patch.lifecycleState;
  }

  let stoppedOn = resolve(patch.stoppedOn, stored.stoppedOn);
  if (stoppedOn !== null && stoppedOn.trim() === '') stoppedOn = null;
  if (stoppedOn !== null && !DATE_SHAPE.test(stoppedOn)) {
    return err(invalid('A date looks like 2027-01-31.', 'stoppedOn'));
  }

  if (lifecycleState === 'ACTIVE') {
    // Cleared rather than kept. The column holds the current fact, not a history, and a date
    // sitting on an item somebody has started again would render as "Stopped 1 June" on a
    // medicine they are taking - a false statement on the screen a household reads most.
    // The history is in the audit log, which is append-only and cannot be rewritten.
    if (patch.stoppedOn !== undefined && patch.stoppedOn !== null) {
      return err(invalid('An item in use has no date it was stopped.', 'stoppedOn'));
    }
    stoppedOn = null;
  }

  if (stoppedOn !== null && fields.startedOn !== null && stoppedOn < fields.startedOn) {
    // The schema says the same thing (`owned_item_dates_ordered`), and without this the refusal
    // arrives as a 500 rather than as a sentence naming the field somebody has to correct. ISO
    // dates compare as strings, which is the whole reason the column is a date and not an
    // instant. Found by a test, not by review.
    return err(invalid('An item cannot be stopped before it was started.', 'stoppedOn'));
  }

  // ---------------------------------------------------------------------
  // Collection
  // ---------------------------------------------------------------------

  let shelfCollection = stored.shelfCollection;
  if (patch.shelfCollection !== undefined) {
    if (!isShelfCollection(patch.shelfCollection)) {
      // A closed vocabulary, for the reason the lifecycle is one: the shelf groups by this, and a
      // value nothing has a rule for would be an item in neither collection - which on a screen
      // that shows one at a time is an item that has disappeared.
      return err(invalid('That is not a collection the shelf has.', 'shelfCollection'));
    }
    if (!mayBeInCollection(itemKind, patch.shelfCollection)) {
      // The schema says the same thing (`owned_item_considering_is_personal_care`) and this is
      // what makes the refusal a sentence rather than a constraint violation. The reason is in
      // `0033`: everything this app does with a medicine presumes it is being taken.
      return err(
        invalid(
          'Considering is for products you are thinking about, not for medicines. Everything ' +
            'Kynviora does with a medicine - reminders, doses, what you have taken - assumes you ' +
            'are taking it.',
          'shelfCollection',
        ),
      );
    }
    shelfCollection = patch.shelfCollection;
  }

  if (lifecycleState === 'ARCHIVED' && patch.stoppedOn !== undefined && patch.stoppedOn !== null) {
    // Archiving is about the record; stopping is about the medicine. Somebody who stopped taking
    // something and then archived it does both, in that order, and the date belongs to the first.
    return err(invalid('Say when it was stopped before archiving it.', 'stoppedOn'));
  }

  // ---------------------------------------------------------------------
  // What actually changed
  // ---------------------------------------------------------------------

  const changedFields: string[] = [];
  if (fields.displayName !== stored.displayName) changedFields.push('displayName');
  for (const field of PATCHABLE) {
    if (fields[field] !== stored[field]) changedFields.push(field);
  }
  if (lifecycleState !== stored.lifecycleState) changedFields.push('lifecycleState');
  if (stoppedOn !== stored.stoppedOn) changedFields.push('stoppedOn');
  if (shelfCollection !== stored.shelfCollection) changedFields.push('shelfCollection');
  if (patch.markReviewed === true) changedFields.push('lastReviewedAt');

  if (changedFields.length === 0) {
    // Refused rather than accepted as a no-op. An empty save still moves the version, and a
    // version that moved for nothing is a conflict for whoever else has this item open - the
    // `ASK_USER` policy firing on a change nobody made.
    return err(
      domainError('VALIDATION_FAILED', 'Nothing to change.', { reason_code: 'no_change' }),
    );
  }

  return ok({
    fields,
    lifecycleState,
    stoppedOn,
    shelfCollection,
    stampReviewed: patch.markReviewed === true,
    changedFields,
  });
}
