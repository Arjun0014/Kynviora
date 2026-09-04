/**
 * The personal-care scenario's judgements, tested with no device attached (DEC-102).
 *
 * Two of these rules were wrong in their first draft and both wrongnesses looked like findings
 * about the app: a limits check that only asked whether the sentences were present passed a screen
 * printing all four regardless of what was typed, and a "not confirmed" check reading only the
 * screen would have passed a screen still saying "not verified" over a record the server had
 * already marked verified.
 */

import { describe, expect, it } from 'vitest';
import { MANUAL_ENTRY_LIMIT_TEXT } from '@kynviora/presentation';
import {
  LIMITS_OF_BLANK_FIELDS,
  LIMIT_OF_NO_DECLARATION,
  limitsStatedCheck,
  notConfirmedCheck,
  personalCareCreatedCheck,
  personalCareFormCheck,
  shelfPreconditionCheck,
  storedFieldsCheck,
  type IntendedEntry,
  type ServerItem,
} from './personalCareEntry.js';

const PROFILE = '00000000-0000-4000-8000-00000000d020';

const INTENDED: IntendedEntry = {
  displayName: 'Synthetic Lotion QQ1',
  categoryLabel: 'Skin care',
  categoryValue: 'SKIN_CARE',
  ingredientDeclaration: 'AQUA, GLYCERIN, PARFUM',
};

function item(overrides: Partial<ServerItem> = {}): ServerItem {
  return {
    id: 'i1',
    profileId: PROFILE,
    itemKind: 'PERSONAL_CARE',
    displayName: INTENDED.displayName,
    identityVerification: 'UNVERIFIED',
    formulationVerification: 'UNVERIFIED',
    ...overrides,
  };
}

describe('PC-0, the control', () => {
  it('passes when nothing on the shelf carries the name yet', () => {
    const check = shelfPreconditionCheck({
      before: [item({ displayName: 'Synthetic Tablet A', itemKind: 'MEDICINE' })],
      intended: INTENDED,
    });
    expect(check.status).toBe('PASS');
  });

  it('refuses to run when a previous run already left that name behind', () => {
    // Items are archived rather than deleted, so previous runs are always still on the shelf. A
    // fixed name would make every run after the first answer this run's question with last week's.
    const check = shelfPreconditionCheck({ before: [item()], intended: INTENDED });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('is inconclusive rather than passing when the shelf could not be read', () => {
    expect(shelfPreconditionCheck({ before: null, intended: INTENDED }).status).toBe(
      'INCONCLUSIVE',
    );
  });
});

describe('PC-1, the form', () => {
  const good = {
    steps: [['open the Shelf tab', true] as const],
    intended: INTENDED,
    nameHeld: INTENDED.displayName,
    declarationHeld: INTENDED.ingredientDeclaration,
    categoryChosen: true,
  };

  it('passes when the name, the category and the declaration all landed', () => {
    expect(personalCareFormCheck(good).status).toBe('PASS');
  });

  it('names the step that did not happen', () => {
    const check = personalCareFormCheck({
      ...good,
      steps: [
        ['open the Shelf tab', true],
        ['open the personal-care form', false],
      ],
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('open the personal-care form');
  });

  it('is inconclusive when the typing never reached the field', () => {
    // Not a FAIL. `input text` going to the stylus tutorial instead of the app is a fact about
    // this emulator, and reporting it as a defect sends somebody to read app code.
    expect(personalCareFormCheck({ ...good, nameHeld: 'Synthetic' }).status).toBe('INCONCLUSIVE');
    expect(personalCareFormCheck({ ...good, declarationHeld: null }).status).toBe('INCONCLUSIVE');
  });

  it('separates a category that was never offered from one whose tap did not land', () => {
    expect(personalCareFormCheck({ ...good, categoryChosen: null }).status).toBe('INCONCLUSIVE');
    expect(personalCareFormCheck({ ...good, categoryChosen: false }).status).toBe('FAIL');
  });
});

describe('PC-2, what reached the server', () => {
  const before = [item({ id: 'other', displayName: 'Synthetic Tablet A', itemKind: 'MEDICINE' })];

  it('passes on exactly one personal-care item by that name', () => {
    const check = personalCareCreatedCheck({
      before,
      after: [...before, item()],
      intended: INTENDED,
      profileId: PROFILE,
    });
    expect(check.status).toBe('PASS');
  });

  it('fails when one save became two products', () => {
    const check = personalCareCreatedCheck({
      before,
      after: [...before, item({ id: 'a' }), item({ id: 'b' })],
      intended: INTENDED,
      profileId: PROFILE,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('idempotency key');
  });

  it('fails when the shelf sent the wrong kind for the button that was pressed', () => {
    // The two add buttons differ only in which one was pressed, so this is a wiring mistake with
    // no other symptom: a medicine record carrying an ingredient list.
    const check = personalCareCreatedCheck({
      before,
      after: [...before, item({ itemKind: 'MEDICINE' })],
      intended: INTENDED,
      profileId: PROFILE,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('PERSONAL_CARE');
  });

  it('does not count an item on another profile as this shelf growing', () => {
    const check = personalCareCreatedCheck({
      before,
      after: [...before, item({ profileId: 'someone-else' })],
      intended: INTENDED,
      profileId: PROFILE,
    });
    expect(check.status).toBe('FAIL');
  });
});

describe('PC-3, stored exactly as typed', () => {
  const fields = [
    { label: 'Kind of product', value: INTENDED.categoryLabel },
    { label: 'Ingredients as printed', value: INTENDED.ingredientDeclaration },
  ];

  it('passes when both came back character for character', () => {
    expect(storedFieldsCheck({ categoryFields: fields, intended: INTENDED }).status).toBe('PASS');
  });

  it('fails on a declaration the system tidied', () => {
    // `09` reads a declaration in printed order. A list this app reordered or re-cased is a
    // different list, and the person can no longer check it against the pack in their hand.
    const check = storedFieldsCheck({
      categoryFields: [
        { label: 'Kind of product', value: INTENDED.categoryLabel },
        { label: 'Ingredients as printed', value: 'Aqua, Glycerin, Parfum' },
      ],
      intended: INTENDED,
    });
    expect(check.status).toBe('FAIL');
  });

  it('fails when the category was not recorded at all', () => {
    const check = storedFieldsCheck({
      categoryFields: [
        { label: 'Kind of product', value: null },
        { label: 'Ingredients as printed', value: INTENDED.ingredientDeclaration },
      ],
      intended: INTENDED,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('not recorded');
  });
});

describe('the sentences this harness looks for are the app’s own', () => {
  it('matches what the presentation layer says each blank field costs', () => {
    // Written out in `personalCareEntry.ts` rather than imported, so a rewording that removed the
    // meaning would not be silently agreed with. This is what keeps the copy honest: it has to
    // keep matching, and updating it is a deliberate act.
    expect(LIMITS_OF_BLANK_FIELDS).toEqual([
      MANUAL_ENTRY_LIMIT_TEXT.NO_IDENTIFIER,
      MANUAL_ENTRY_LIMIT_TEXT.NO_BATCH,
      MANUAL_ENTRY_LIMIT_TEXT.NO_EXPIRY,
    ]);
    expect(LIMIT_OF_NO_DECLARATION).toBe(MANUAL_ENTRY_LIMIT_TEXT.NO_INGREDIENTS);
  });
});

describe('PC-4, the limits are a subtraction', () => {
  const expected = LIMITS_OF_BLANK_FIELDS;
  const refused = LIMIT_OF_NO_DECLARATION;

  it('passes when the three blank fields are stated and the filled one is not', () => {
    expect(limitsStatedCheck({ screenText: [...expected], expected, refused }).status).toBe('PASS');
  });

  it('fails a screen printing the same four sentences whatever was typed', () => {
    // The whole point of the check. Every other reading of "the limits are stated" passes this
    // screen, and it is telling somebody their ingredient list is missing while it is on file.
    const check = limitsStatedCheck({
      screenText: [...expected, refused],
      expected,
      refused,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('fixed list');
  });

  it('fails when a limit the blank field costs was never said', () => {
    const check = limitsStatedCheck({ screenText: expected.slice(1), expected, refused });
    expect(check.status).toBe('FAIL');
  });

  it('is inconclusive rather than passing when the screen could not be read', () => {
    expect(limitsStatedCheck({ screenText: null, expected, refused }).status).toBe('INCONCLUSIVE');
  });
});

describe('PC-5, nothing typed is presented as confirmed', () => {
  const screen = ['Product not verified', 'Formula not verified', 'Synthetic Lotion QQ1'];

  it('passes when the record is unverified and the screen says so', () => {
    expect(notConfirmedCheck({ screenText: screen, stored: item() }).status).toBe('PASS');
  });

  it('fails when a typed record was stored as verified', () => {
    // Confirming means something was read off the pack. With no extraction provider (`BLK-007`)
    // nothing ever was, so this can only come from a route marking its own input as checked.
    const check = notConfirmedCheck({
      screenText: screen,
      stored: item({ identityVerification: 'VERIFIED' }),
    });
    expect(check.status).toBe('FAIL');
  });

  it('fails when the record is unverified and the screen does not say so', () => {
    const check = notConfirmedCheck({
      screenText: ['Synthetic Lotion QQ1'],
      stored: item(),
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('0 of the two');
  });

  it('is inconclusive rather than passing when either half is unreadable', () => {
    expect(notConfirmedCheck({ screenText: null, stored: item() }).status).toBe('INCONCLUSIVE');
    expect(notConfirmedCheck({ screenText: screen, stored: null }).status).toBe('INCONCLUSIVE');
  });
});
