import { describe, it, expect } from 'vitest';
import { normalizeItemUpdate, type ItemUpdate, type StoredItem } from './itemUpdate.js';

/**
 * Changing a record that already exists.
 *
 * Stage 2's expected output is "create, view, update, archive, and review". Creation is Phases
 * 2.2 and 2.3; this is the rest of the sentence, and the two things it must not do are let an
 * edit claim evidence about a pack, and let a stale copy overwrite a newer one silently.
 */

const MEDICINE: StoredItem = {
  version: 3,
  lifecycleState: 'ACTIVE',
  stoppedOn: null,
  shelfCollection: 'IN_USE',
  itemKind: 'MEDICINE',
  displayName: 'Synthetic Tablet',
  brand: 'Synthetic Brand',
  manufacturer: null,
  market: 'GB',
  recordedGtin: null,
  recordedLotCode: null,
  expiresOn: null,
  startedOn: '2026-08-01',
  notes: null,
  strengthText: '500 mg',
  dosageForm: 'Tablet',
  directionsText: 'Take one twice a day.',
  personalCareCategory: null,
  ingredientDeclarationRaw: null,
  labelVersionNote: null,
};

const SHAMPOO: StoredItem = {
  ...MEDICINE,
  itemKind: 'PERSONAL_CARE',
  displayName: 'Synthetic Shampoo',
  strengthText: null,
  dosageForm: null,
  directionsText: null,
  personalCareCategory: 'HAIR_CARE',
};

const patch = (overrides: Omit<ItemUpdate, 'expectedVersion'>): ItemUpdate => ({
  expectedVersion: 3,
  ...overrides,
});

describe('absent and null are different answers', () => {
  it('leaves a field the patch does not mention', () => {
    const result = normalizeItemUpdate(MEDICINE, patch({ notes: 'The blue box.' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.fields.strengthText).toBe('500 mg');
    expect(result.value.fields.brand).toBe('Synthetic Brand');
    expect(result.value.changedFields).toEqual(['notes']);
  });

  it('clears a field the patch sends as null', () => {
    // The only way to un-enter something. Stored as an absence, not as an empty string - the
    // same rule creation follows (`04` Phase 2.2's second exit criterion).
    const result = normalizeItemUpdate(MEDICINE, patch({ brand: null }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.fields.brand).toBeNull();
    expect(result.value.changedFields).toEqual(['brand']);
  });

  it('treats a field of spaces as clearing it', () => {
    const result = normalizeItemUpdate(MEDICINE, patch({ brand: '   ' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fields.brand).toBeNull();
  });
});

describe('an update is validated as the record it would produce', () => {
  it('refuses a malformed value with the same message creating one gives', () => {
    const result = normalizeItemUpdate(MEDICINE, patch({ market: 'gb' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['field']).toBe('market');
  });

  it('refuses a barcode of the wrong length', () => {
    const result = normalizeItemUpdate(MEDICINE, patch({ recordedGtin: '1234567' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['field']).toBe('recordedGtin');
  });

  it('refuses emptying the name', () => {
    // A record with no name is a row nobody can find again, and the field is the one thing
    // creation requires.
    const result = normalizeItemUpdate(MEDICINE, patch({ displayName: '   ' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['field']).toBe('displayName');
  });

  it('refuses giving a medicine a personal-care category', () => {
    // A field that cannot be entered on the form must not become enterable by editing. The
    // schema's `owned_item_category_matches_kind` refuses the same shape.
    const result = normalizeItemUpdate(MEDICINE, patch({ personalCareCategory: 'HAIR_CARE' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['field']).toBe('personalCareCategory');
  });

  it('refuses giving a personal-care product a strength', () => {
    const result = normalizeItemUpdate(SHAMPOO, patch({ strengthText: '500 mg' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['field']).toBe('strengthText');
  });

  it('refuses a category outside the closed vocabulary', () => {
    const result = normalizeItemUpdate(SHAMPOO, patch({ personalCareCategory: 'SOMETHING_NEW' }));
    expect(result.ok).toBe(false);
  });
});

describe('nothing here can claim something was checked', () => {
  it('carries no field for a verification state, a catalog identifier or a kind', () => {
    // The enforcement is the absence, so this asserts the absence: a caller cannot even construct
    // the request. Written as a value the compiler checks rather than as prose.
    const forbidden = [
      'identityVerification',
      'formulationVerification',
      'batchVerification',
      'productIdentityId',
      'formulationId',
      'batchId',
      'itemKind',
      'lastReviewedAt',
      'lastSafetyCheckedAt',
      'version',
    ];

    const sent: Record<string, unknown> = { expectedVersion: 3, notes: 'A note.' };
    for (const field of forbidden) sent[field] = 'CONFIRMED';

    // Through `unknown`, because the whole point is that these keys have nowhere to land: a
    // direct assertion is refused by the compiler, which is the enforcement being asserted.
    const result = normalizeItemUpdate(MEDICINE, sent as unknown as ItemUpdate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Every one of them is ignored, because the shape has nowhere to put it.
    expect(result.value.changedFields).toEqual(['notes']);
    expect(result.value.fields.itemKind).toBe('MEDICINE');
  });

  it('stamps "last looked at" on request rather than accepting a time', () => {
    // A client-supplied timestamp would let a screen claim a person reviewed a medicine at a
    // moment they did not - on the value the Shelf's "not yet looked at" filter reads.
    const result = normalizeItemUpdate(MEDICINE, patch({ markReviewed: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.stampReviewed).toBe(true);
    expect(result.value.changedFields).toEqual(['lastReviewedAt']);
  });

  it('does not stamp it when nobody asked', () => {
    const result = normalizeItemUpdate(MEDICINE, patch({ notes: 'A note.' }));
    if (!result.ok) return;
    expect(result.value.stampReviewed).toBe(false);
  });
});

describe('the lifecycle', () => {
  it('stops an item, with the date the person gives', () => {
    const result = normalizeItemUpdate(
      MEDICINE,
      patch({ lifecycleState: 'STOPPED', stoppedOn: '2026-08-20' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.lifecycleState).toBe('STOPPED');
    expect(result.value.stoppedOn).toBe('2026-08-20');
    expect(result.value.changedFields).toEqual(['lifecycleState', 'stoppedOn']);
  });

  it('stops an item without inventing a date', () => {
    // "Missing fields remain explicitly unknown rather than receiving defaults." Somebody who
    // stopped a medicine months ago and does not remember when should not have today recorded.
    const result = normalizeItemUpdate(MEDICINE, patch({ lifecycleState: 'STOPPED' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.lifecycleState).toBe('STOPPED');
    expect(result.value.stoppedOn).toBeNull();
  });

  it('clears the stopped date when an item is started again', () => {
    // The column holds the current fact, not a history. "Stopped 1 June" on a medicine somebody
    // is taking is a false statement on the screen a household reads most; the history is in the
    // audit log, which nobody can rewrite.
    const stopped: StoredItem = {
      ...MEDICINE,
      lifecycleState: 'STOPPED',
      stoppedOn: '2026-08-20',
    };

    const result = normalizeItemUpdate(stopped, patch({ lifecycleState: 'ACTIVE' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.lifecycleState).toBe('ACTIVE');
    expect(result.value.stoppedOn).toBeNull();
    expect(result.value.changedFields).toEqual(['lifecycleState', 'stoppedOn']);
  });

  it('refuses a stopped date on an item in use', () => {
    const result = normalizeItemUpdate(MEDICINE, patch({ stoppedOn: '2026-08-20' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['field']).toBe('stoppedOn');
  });

  it('refuses a stopped date given at the moment of archiving', () => {
    // Archiving is about the record and stopping is about the medicine. Somebody who did both
    // does them in that order, and the date belongs to the first.
    const result = normalizeItemUpdate(
      MEDICINE,
      patch({ lifecycleState: 'ARCHIVED', stoppedOn: '2026-08-20' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['field']).toBe('stoppedOn');
  });

  it('keeps a stopped date through archiving', () => {
    const stopped: StoredItem = {
      ...MEDICINE,
      lifecycleState: 'STOPPED',
      stoppedOn: '2026-08-20',
    };

    const result = normalizeItemUpdate(stopped, patch({ lifecycleState: 'ARCHIVED' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stoppedOn).toBe('2026-08-20');
  });

  it('lets an archived item come back', () => {
    // Nothing here is one-way. A person who archived something by mistake and could not undo it
    // would have lost a record Kynviora is meant to be keeping for them.
    const archived: StoredItem = { ...MEDICINE, lifecycleState: 'ARCHIVED' };

    const result = normalizeItemUpdate(archived, patch({ lifecycleState: 'ACTIVE' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lifecycleState).toBe('ACTIVE');
  });

  it('refuses a state nobody defined', () => {
    // `shelfAttention` treats everything that is not `ACTIVE` as finished with, so an invented
    // state would quietly stop Kynviora asking about a live medicine.
    const result = normalizeItemUpdate(MEDICINE, patch({ lifecycleState: 'PAUSED' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['field']).toBe('lifecycleState');
  });

  it('refuses a stopped date before the started date', () => {
    // `owned_item_dates_ordered` says the same thing, and without this the refusal arrives from
    // the engine as a 500 rather than as a sentence naming the field somebody has to correct.
    // An API test found it; the domain had no rule at all.
    const result = normalizeItemUpdate(
      MEDICINE,
      patch({ lifecycleState: 'STOPPED', stoppedOn: '2026-07-31' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['field']).toBe('stoppedOn');
  });

  it('accepts a stopped date on the day it was started', () => {
    // The constraint is `>=`, so the same day is a real answer - somebody who took one dose and
    // stopped has a record worth keeping.
    const result = normalizeItemUpdate(
      MEDICINE,
      patch({ lifecycleState: 'STOPPED', stoppedOn: '2026-08-01' }),
    );
    expect(result.ok).toBe(true);
  });

  it('allows a stopped date where nothing says when it was started', () => {
    const noStart = { ...MEDICINE, startedOn: null };
    const result = normalizeItemUpdate(
      noStart,
      patch({ lifecycleState: 'STOPPED', stoppedOn: '2020-01-01' }),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a malformed stopped date', () => {
    const result = normalizeItemUpdate(
      MEDICINE,
      patch({ lifecycleState: 'STOPPED', stoppedOn: 'last June' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['field']).toBe('stoppedOn');
  });
});

describe('what changed', () => {
  it('refuses a save that changes nothing', () => {
    // An empty save still moves the version, and a version that moved for nothing is a conflict
    // for whoever else has this item open - the `ASK_USER` policy firing on a change nobody made.
    const result = normalizeItemUpdate(
      MEDICINE,
      patch({ displayName: 'Synthetic Tablet', brand: 'Synthetic Brand' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['reason_code']).toBe('no_change');
  });

  it('reports field names and never values', () => {
    // `14` keeps the content of somebody's medicine record out of a log, and "the strength
    // changed" is what an access history needs to be useful.
    const result = normalizeItemUpdate(
      MEDICINE,
      patch({ strengthText: '250 mg', notes: 'Half the dose now.' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.changedFields).toEqual(['notes', 'strengthText']);
    expect(JSON.stringify(result.value.changedFields)).not.toContain('250 mg');
    expect(JSON.stringify(result.value.changedFields)).not.toContain('Half the dose');
  });

  it('does not report a field re-sent unchanged', () => {
    const result = normalizeItemUpdate(
      MEDICINE,
      patch({ strengthText: '500 mg', dosageForm: 'Capsule' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changedFields).toEqual(['dosageForm']);
  });
});
