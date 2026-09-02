import { describe, it, expect } from 'vitest';
import { ITEM_KINDS, normalizeManualEntry } from '@kynviora/domain';
import { manualEntryForm } from '@kynviora/presentation';
import { MANUAL_ENTRY_FIELDS, isManualEntryField, manualEntryDraft } from './views.js';

/**
 * The client half of Phases 2.2 and 2.3.
 *
 * The server composes every sentence a person reads, so the only thing this layer decides is
 * which typed value reaches which field - and that is exactly where a manual-entry form fails
 * quietly. A dropped barcode is worse than one nobody entered, because the screen says it was
 * recorded either way.
 */

describe('the form and the body agree', () => {
  it('offers no field the body cannot carry', () => {
    // The form is in `@kynviora/presentation` and the body is in `client.ts`. A typo in a form
    // field's key would mean that field is silently never sent, and nothing else would notice.
    for (const itemKind of ITEM_KINDS) {
      for (const field of manualEntryForm(itemKind).fields) {
        expect(isManualEntryField(field.field), `${itemKind}: ${field.field}`).toBe(true);
      }
    }
  });

  it('offers every field the body carries, across the two forms together', () => {
    // The other direction. A field on the body that no form asks for is a value only a test can
    // ever set, which is `DEV-026`'s failure in miniature: correct, and reachable by nobody.
    const offered = new Set(
      ITEM_KINDS.flatMap((itemKind) => manualEntryForm(itemKind).fields.map((f) => f.field)),
    );
    for (const field of MANUAL_ENTRY_FIELDS) {
      expect(offered.has(field), field).toBe(true);
    }
  });

  it('keeps each category to its own fields', () => {
    const medicine = manualEntryForm('MEDICINE').fields.map((f) => f.field);
    const personalCare = manualEntryForm('PERSONAL_CARE').fields.map((f) => f.field);

    expect(medicine).toContain('strengthText');
    expect(medicine).not.toContain('personalCareCategory');
    expect(personalCare).toContain('personalCareCategory');
    expect(personalCare).not.toContain('strengthText');
  });
});

describe('manualEntryDraft', () => {
  it('creates a record from a name and nothing else', () => {
    // Phase 2.2's first exit criterion, at the layer that builds the request.
    const body = manualEntryDraft({
      profileId: 'p1',
      itemKind: 'MEDICINE',
      values: { displayName: 'Blue box from the chemist' },
    });

    expect(body).toEqual({
      profileId: 'p1',
      itemKind: 'MEDICINE',
      displayName: 'Blue box from the chemist',
    });
  });

  it('omits a blank field rather than sending an empty string', () => {
    // Phase 2.2's second exit criterion. An empty string stored is a value a screen renders as an
    // answer; an omission is stored as an absence and renders as "not recorded".
    const body = manualEntryDraft({
      profileId: 'p1',
      itemKind: 'MEDICINE',
      values: { displayName: 'Tablets', brand: '', manufacturer: '   ', strengthText: '500 mg' },
    });

    expect('brand' in body).toBe(false);
    expect('manufacturer' in body).toBe(false);
    expect(body.strengthText).toBe('500 mg');
  });

  it('sends what was typed, exactly', () => {
    // Not trimmed, not upper-cased, not stripped. A value quietly repaired here is one the person
    // can no longer check against the pack in their hand - the domain refuses and names the field.
    const body = manualEntryDraft({
      profileId: 'p1',
      itemKind: 'MEDICINE',
      values: { displayName: '  Tablets  ', market: 'gb', recordedGtin: '5012345 678900' },
    });

    expect(body.displayName).toBe('  Tablets  ');
    expect(body.market).toBe('gb');
    expect(body.recordedGtin).toBe('5012345 678900');

    // And the domain is what refuses it, naming the field a form can point at.
    const refused = normalizeManualEntry(body);
    expect(refused.ok).toBe(false);
  });

  it('sends the name even when it is blank', () => {
    // A missing key fails the body schema and comes back as a generic "invalid request body". An
    // empty one reaches the domain, which names `displayName` - and only that lets a form point.
    const body = manualEntryDraft({ profileId: 'p1', itemKind: 'MEDICINE', values: {} });

    expect(body.displayName).toBe('');

    const refused = normalizeManualEntry(body);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.detail?.['field']).toBe('displayName');
  });

  it('will not send a field the other category owns', () => {
    // Somebody who fills in a personal-care form, changes their mind and switches to a medicine
    // would otherwise submit a category the domain refuses outright, and be shown a message about
    // a field that is no longer on their screen.
    const body = manualEntryDraft({
      profileId: 'p1',
      itemKind: 'MEDICINE',
      values: {
        displayName: 'Tablets',
        personalCareCategory: 'SKIN_CARE',
        ingredientDeclarationRaw: 'Aqua, Glycerin',
        strengthText: '500 mg',
      },
    });

    expect('personalCareCategory' in body).toBe(false);
    expect('ingredientDeclarationRaw' in body).toBe(false);
    expect(body.strengthText).toBe('500 mg');
    expect(normalizeManualEntry(body).ok).toBe(true);
  });

  it('will not send a medicine field on a personal-care entry', () => {
    const body = manualEntryDraft({
      profileId: 'p1',
      itemKind: 'PERSONAL_CARE',
      values: {
        displayName: 'Shower gel',
        strengthText: '500 mg',
        dosageForm: 'TABLET',
        personalCareCategory: 'BODY_CLEANSER',
      },
    });

    expect('strengthText' in body).toBe(false);
    expect('dosageForm' in body).toBe(false);
    expect(body.personalCareCategory).toBe('BODY_CLEANSER');
    expect(normalizeManualEntry(body).ok).toBe(true);
  });

  it('carries a whole back-of-bottle paragraph unchanged', () => {
    // Phase 2.3's second exit criterion: personal care is not name plus barcode, and the
    // declaration is a paragraph rather than a field.
    const declaration =
      'Aqua, Sodium Laureth Sulfate, Cocamidopropyl Betaine, Parfum, Sodium Chloride, ' +
      'Glycerin, Citric Acid, Sodium Benzoate, Limonene, Linalool';

    const body = manualEntryDraft({
      profileId: 'p1',
      itemKind: 'PERSONAL_CARE',
      values: { displayName: 'Shower gel', ingredientDeclarationRaw: declaration },
    });

    expect(body.ingredientDeclarationRaw).toBe(declaration);
  });

  it('carries no field for a verification state, a confidence or a catalog identifier', () => {
    // The enforcement is the absence, so this asserts the absence. `15` A11: a household typing a
    // barcode is not the catalog learning one.
    for (const forbidden of [
      'identityVerification',
      'formulationVerification',
      'batchVerification',
      'productIdentityId',
      'formulationId',
      'batchId',
      'matchConfidence',
    ]) {
      expect(MANUAL_ENTRY_FIELDS).not.toContain(forbidden);
    }

    const body = manualEntryDraft({
      profileId: 'p1',
      itemKind: 'MEDICINE',
      values: { displayName: 'Tablets', identityVerification: 'CONFIRMED', batchId: 'b1' },
    });

    expect('identityVerification' in body).toBe(false);
    expect('batchId' in body).toBe(false);
  });
});
