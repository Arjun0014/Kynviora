import { describe, it, expect } from 'vitest';
import { PERSONAL_CARE_CATEGORIES } from './vocabulary.js';
import {
  DECLARATION_MAX,
  MANUAL_ENTRY_LIMITS,
  MANUAL_TEXT_MAX,
  manualEntryLimits,
  normalizeManualEntry,
  type ManualEntry,
} from './manualEntry.js';

function entry(overrides: Partial<ManualEntry> = {}): ManualEntry {
  return { itemKind: 'MEDICINE', displayName: 'Synthetic Tablet', ...overrides };
}

function accepted(input: ManualEntry) {
  const result = normalizeManualEntry(input);
  if (!result.ok) throw new Error(`expected acceptance, got ${result.error.code}`);
  return result.value;
}

function refusedField(input: ManualEntry): string {
  const result = normalizeManualEntry(input);
  if (result.ok) throw new Error('expected a refusal');
  return String(result.error.detail?.field ?? '');
}

describe('exit criterion 1 - a record creatable from almost nothing', () => {
  it('accepts a name and a kind, and nothing else', () => {
    const value = accepted(entry());
    expect(value.displayName).toBe('Synthetic Tablet');
    expect(value.itemKind).toBe('MEDICINE');
  });

  it('accepts a personal-care item the same way', () => {
    expect(accepted(entry({ itemKind: 'PERSONAL_CARE' })).itemKind).toBe('PERSONAL_CARE');
  });

  it('needs a name', () => {
    expect(refusedField(entry({ displayName: '' }))).toBe('displayName');
    expect(refusedField(entry({ displayName: '   ' }))).toBe('displayName');
  });
});

describe('exit criterion 2 - missing fields stay explicitly unknown', () => {
  it('stores an absence as an absence, never as a default', () => {
    const value = accepted(entry());
    // No "Unknown" string, no "N/A", no empty-string sentinel. A screen showing "Not recorded" is
    // telling the truth; one showing "Unknown" is showing a value somebody stored.
    for (const [key, stored] of Object.entries(value)) {
      if (key === 'itemKind' || key === 'displayName') continue;
      expect(stored).toBeNull();
    }
  });

  it('turns a field of spaces into an absence rather than storing it', () => {
    expect(accepted(entry({ brand: '   ' })).brand).toBeNull();
    expect(accepted(entry({ notes: '\n\t ' })).notes).toBeNull();
  });

  it('trims a value rather than storing the whitespace around it', () => {
    expect(accepted(entry({ brand: '  Synthetic Brand  ' })).brand).toBe('Synthetic Brand');
  });

  it('has no field anywhere for a verification, a confidence or a catalog identifier', () => {
    const keys = Object.keys(accepted(entry()));
    // Their absence is what stops a hand-typed record claiming CONFIRMED or reaching the shared
    // catalog (`15` A11). A field added here would be a way in.
    for (const forbidden of [
      'identityVerification',
      'formulationVerification',
      'batchVerification',
      'confidence',
      'productIdentityId',
      'formulationId',
      'batchId',
      'corroboration',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('what it refuses rather than repairs', () => {
  it('refuses a market it would otherwise have to change', () => {
    // A value Kynviora quietly altered is one the person can no longer check against the pack.
    expect(refusedField(entry({ market: 'gb' }))).toBe('market');
    expect(refusedField(entry({ market: 'GBR' }))).toBe('market');
    expect(accepted(entry({ market: 'GB' })).market).toBe('GB');
  });

  it('refuses a barcode of the wrong length', () => {
    // Storing it would make a recall check silently miss the pack it was about.
    for (const gtin of ['123', '1234567', '12345678901', 'abcdefgh']) {
      expect(refusedField(entry({ recordedGtin: gtin }))).toBe('recordedGtin');
    }
    for (const gtin of ['12345678', '123456789012', '1234567890123', '12345678901234']) {
      expect(accepted(entry({ recordedGtin: gtin })).recordedGtin).toBe(gtin);
    }
  });

  it('refuses a date that is not one', () => {
    expect(refusedField(entry({ expiresOn: 'January 2027' }))).toBe('expiresOn');
    expect(refusedField(entry({ startedOn: '01/08/2026' }))).toBe('startedOn');
    expect(accepted(entry({ expiresOn: '2027-01-31' })).expiresOn).toBe('2027-01-31');
  });

  it('refuses a value longer than it will store', () => {
    expect(refusedField(entry({ brand: 'x'.repeat(MANUAL_TEXT_MAX + 1) }))).toBe('brand');
    expect(refusedField(entry({ displayName: 'x'.repeat(MANUAL_TEXT_MAX + 1) }))).toBe(
      'displayName',
    );
    expect(
      refusedField(
        entry({
          itemKind: 'PERSONAL_CARE',
          ingredientDeclarationRaw: 'x'.repeat(DECLARATION_MAX + 1),
        }),
      ),
    ).toBe('ingredientDeclarationRaw');
  });
});

describe('the two categories cannot borrow each other fields', () => {
  it('refuses a personal-care category on a medicine', () => {
    expect(refusedField(entry({ personalCareCategory: 'HAIR_CARE' }))).toBe('personalCareCategory');
  });

  it('refuses a strength or a dosage form on a personal-care product', () => {
    expect(refusedField(entry({ itemKind: 'PERSONAL_CARE', strengthText: '500 mg' }))).toBe(
      'strengthText',
    );
    expect(refusedField(entry({ itemKind: 'PERSONAL_CARE', dosageForm: 'Tablet' }))).toBe(
      'dosageForm',
    );
  });

  it('refuses rather than silently dropping them', () => {
    // A route that dropped them would accept a submission and store something the person did not
    // send, which is worse than a refusal that names the field.
    const result = normalizeManualEntry(entry({ personalCareCategory: 'HAIR_CARE' }));
    expect(result.ok).toBe(false);
  });

  it('accepts every category in the vocabulary and no other', () => {
    for (const category of PERSONAL_CARE_CATEGORIES) {
      expect(
        accepted(entry({ itemKind: 'PERSONAL_CARE', personalCareCategory: category }))
          .personalCareCategory,
      ).toBe(category);
    }
    expect(
      refusedField(entry({ itemKind: 'PERSONAL_CARE', personalCareCategory: 'SHAMPOO' })),
    ).toBe('personalCareCategory');
  });

  it('keeps a medicine directions and a personal-care declaration', () => {
    expect(accepted(entry({ directionsText: 'Take one twice a day.' })).directionsText).toBe(
      'Take one twice a day.',
    );
    expect(
      accepted(entry({ itemKind: 'PERSONAL_CARE', ingredientDeclarationRaw: 'Aqua, Glycerin' }))
        .ingredientDeclarationRaw,
    ).toBe('Aqua, Glycerin');
  });
});

describe('what the record cannot do yet', () => {
  it('names every absence as the capability it costs', () => {
    expect(manualEntryLimits(accepted(entry()))).toEqual([...MANUAL_ENTRY_LIMITS]);
  });

  it('says nothing where everything is there', () => {
    const value = accepted(
      entry({
        itemKind: 'PERSONAL_CARE',
        recordedGtin: '1234567890123',
        recordedLotCode: 'L1',
        ingredientDeclarationRaw: 'Aqua',
        expiresOn: '2027-01-31',
      }),
    );
    expect(manualEntryLimits(value)).toEqual([]);
  });

  it('drops one member at a time as each field arrives', () => {
    const withGtin = accepted(entry({ recordedGtin: '1234567890123' }));
    expect(manualEntryLimits(withGtin)).not.toContain('NO_IDENTIFIER');
    expect(manualEntryLimits(withGtin)).toContain('NO_BATCH');
  });

  it('emits in vocabulary order rather than by importance', () => {
    const limits = manualEntryLimits(accepted(entry({ recordedLotCode: 'L1' })));
    const positions = limits.map((l) => MANUAL_ENTRY_LIMITS.indexOf(l));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('is a list rather than a completeness score', () => {
    // A record somebody left sparse on purpose is not a worse record. `02` forbids the aggregate.
    const limits = manualEntryLimits(accepted(entry()));
    expect(Array.isArray(limits)).toBe(true);
    for (const limit of limits) expect(typeof limit).toBe('string');
  });
});
