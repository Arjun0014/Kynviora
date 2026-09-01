import { describe, it, expect } from 'vitest';
import { MANUAL_ENTRY_LIMITS, PERSONAL_CARE_CATEGORIES } from '@kynviora/domain';
import {
  ALL_MANUAL_ENTRY_STRINGS,
  MANUAL_ENTRY_LIMIT_TEXT,
  MANUAL_FIELD_INPUTS,
  manualEntryForm,
  manualEntryOutcomeView,
} from './manualEntry.js';
import { findForbiddenClaims } from './copy.js';

describe('the form a person fills in', () => {
  it('asks for exactly one thing', () => {
    for (const kind of ['MEDICINE', 'PERSONAL_CARE'] as const) {
      const required = manualEntryForm(kind).fields.filter((f) => f.required);
      // A person holding a box in a kitchen has a name and may have nothing else to hand, and
      // Phase 2.2's first exit criterion says the record has to be creatable from that.
      expect(required.map((f) => f.field)).toEqual(['displayName']);
    }
  });

  it('says so at the top rather than leaving somebody to discover it', () => {
    const form = manualEntryForm('MEDICINE');
    expect(form.intro).toContain('Only the name is needed');
    expect(form.intro).toContain('will not fill it in or guess');
  });

  it('gives every field a label, a reason and a known input kind', () => {
    for (const kind of ['MEDICINE', 'PERSONAL_CARE'] as const) {
      for (const entry of manualEntryForm(kind).fields) {
        expect(entry.label.length).toBeGreaterThan(0);
        expect(entry.help.length).toBeGreaterThan(0);
        expect(MANUAL_FIELD_INPUTS).toContain(entry.input);
      }
    }
  });

  it('marks no optional field as recommended or expected', () => {
    for (const kind of ['MEDICINE', 'PERSONAL_CARE'] as const) {
      for (const entry of manualEntryForm(kind).fields) {
        // A form that scolded somebody for leaving the batch code blank would collect guessed
        // batch codes.
        for (const forbidden of ['recommended', 'suggested', 'primary', 'important']) {
          expect(Object.keys(entry)).not.toContain(forbidden);
        }
        expect(entry.help).not.toMatch(/you should|make sure you|please (enter|fill)/i);
      }
    }
  });

  it('says what leaving a field blank costs, not how complete somebody has been', () => {
    const fields = manualEntryForm('MEDICINE').fields;
    const barcode = fields.find((f) => f.field === 'recordedGtin');
    const batch = fields.find((f) => f.field === 'recordedLotCode');
    // The specific thing Kynviora will not be able to do, rather than "required for full
    // protection" - which is the completeness score `02` refuses, dressed as advice.
    expect(barcode?.help).toContain('recall about the product will not reach this item');
    expect(batch?.help).toContain('never to your particular pack');
    for (const entry of fields) {
      expect(entry.help).not.toMatch(/full protection|complete your|100%|score/i);
    }
  });

  it('says an absent field stays unknown, on every optional field', () => {
    for (const kind of ['MEDICINE', 'PERSONAL_CARE'] as const) {
      for (const entry of manualEntryForm(kind).fields) {
        if (entry.required) continue;
        expect(entry.absentNote).toContain('explicitly unknown');
        expect(entry.absentNote).toContain('will not guess');
      }
    }
  });

  it('explains why nothing typed here is confirmed', () => {
    const note = manualEntryForm('MEDICINE').verificationNote;
    // `08` reserves CONFIRMED for something read off the pack, and a person who read "not
    // confirmed" with no explanation would reasonably think Kynviora doubted them.
    expect(note).toContain('not Kynviora doubting you');
    expect(note).toContain('read off the pack');
  });
});

describe('exit criterion - personal care is not name plus barcode', () => {
  it('offers category, ingredients and label version', () => {
    const fields = manualEntryForm('PERSONAL_CARE').fields.map((f) => f.field);
    for (const expected of [
      'personalCareCategory',
      'ingredientDeclarationRaw',
      'labelVersionNote',
      'manufacturer',
      'market',
    ]) {
      expect(fields).toContain(expected);
    }
  });

  it('gives the ingredient list room for a whole paragraph', () => {
    const declaration = manualEntryForm('PERSONAL_CARE').fields.find(
      (f) => f.field === 'ingredientDeclarationRaw',
    );
    expect(declaration?.input).toBe('LONG_TEXT');
    expect(declaration?.help).toContain('in the order it is printed');
  });

  it('offers every category as a phrase rather than as a code', () => {
    const category = manualEntryForm('PERSONAL_CARE').fields.find(
      (f) => f.field === 'personalCareCategory',
    );
    expect(category?.input).toBe('CHOICE');
    expect(category?.choices.map((c) => c.value)).toEqual([...PERSONAL_CARE_CATEGORIES]);
    for (const choice of category?.choices ?? []) {
      expect(choice.label).not.toBe(choice.value);
      expect(choice.label).not.toMatch(/_/);
    }
  });
});

describe('the two forms do not borrow each other fields', () => {
  it('offers a medicine its own and not the other', () => {
    const fields = manualEntryForm('MEDICINE').fields.map((f) => f.field);
    expect(fields).toContain('strengthText');
    expect(fields).toContain('directionsText');
    expect(fields).not.toContain('personalCareCategory');
    expect(fields).not.toContain('ingredientDeclarationRaw');
  });

  it('offers a personal-care product its own and not the other', () => {
    const fields = manualEntryForm('PERSONAL_CARE').fields.map((f) => f.field);
    expect(fields).not.toContain('strengthText');
    expect(fields).not.toContain('dosageForm');
  });

  it('puts the category own fields before the shared ones', () => {
    const fields = manualEntryForm('MEDICINE').fields.map((f) => f.field);
    // They are what a person is looking at when they decide what this thing is.
    expect(fields.indexOf('strengthText')).toBeLessThan(fields.indexOf('brand'));
    expect(fields[0]).toBe('displayName');
  });

  it('says directions are kept word for word', () => {
    const directions = manualEntryForm('MEDICINE').fields.find((f) => f.field === 'directionsText');
    // `04` Phase 4.1 preserves the source text and `09` forbids Kynviora rewriting it.
    expect(directions?.help).toContain('never rewrites them');
  });
});

describe('what is said once the record exists', () => {
  it('has a sentence for every limit in the vocabulary', () => {
    for (const limit of MANUAL_ENTRY_LIMITS) {
      expect(MANUAL_ENTRY_LIMIT_TEXT[limit].length).toBeGreaterThan(20);
    }
  });

  it('renders limits as sentences rather than as codes', () => {
    const view = manualEntryOutcomeView([...MANUAL_ENTRY_LIMITS]);
    expect(view.limits).toHaveLength(MANUAL_ENTRY_LIMITS.length);
    for (const limit of MANUAL_ENTRY_LIMITS) {
      expect(JSON.stringify(view.limits)).not.toContain(limit);
    }
  });

  it('drops a limit it has no sentence for', () => {
    const view = manualEntryOutcomeView(['SOMETHING_NEW', 'NO_EXPIRY']);
    expect(view.limits).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain('SOMETHING_NEW');
  });

  it('does not present a complete record as reassurance about the product', () => {
    const view = manualEntryOutcomeView([]);
    // `18` forbids presenting an absence of findings as reassurance.
    expect(view.completeNote).toContain('has not checked any of it against a pack');
    expect(view.completeNote).not.toMatch(/all good|you are covered|fully protected/i);
  });

  it('says adding more later is expected rather than a failure', () => {
    expect(manualEntryOutcomeView([]).note).toContain('has to be filled in all at once');
    expect(manualEntryOutcomeView([]).note).toContain('add anything missing later');
  });

  it('carries no count and no completeness figure', () => {
    const view = manualEntryOutcomeView([...MANUAL_ENTRY_LIMITS]);
    for (const forbidden of ['count', 'percent', 'complete', 'score', 'total']) {
      expect(Object.keys(view)).not.toContain(forbidden);
    }
  });
});

describe('the copy scan', () => {
  it('makes no forbidden claim anywhere on either form', () => {
    for (const line of ALL_MANUAL_ENTRY_STRINGS) {
      expect(findForbiddenClaims(line)).toEqual([]);
    }
  });

  it('never tells anybody what to do about a medicine', () => {
    for (const line of ALL_MANUAL_ENTRY_STRINGS) {
      expect(line).not.toMatch(/stop taking|start taking|do not take|change your dose/i);
    }
  });
});
