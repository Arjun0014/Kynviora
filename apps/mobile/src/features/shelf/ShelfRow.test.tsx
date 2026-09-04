/**
 * Which controls one shelf row offers, and to whom.
 *
 * Spec references: `07` and `08.2` (capabilities are separately scoped), `11` (access control is
 * server-authoritative), `14` (deny by default), `18`, DEC-045 (withheld, never disabled),
 * DEC-116, `04` Phase 2.1 and 4.1, migrations `0020` and `0021`, `19`.
 *
 * WHY A ROW HAS ITS OWN TEST
 * Two capability rules meet here and they are not the same rule. A dose control is withheld from a
 * personal-care item because a dose is a medicine's idea; it is withheld from a caregiver without
 * `RECORD_DOSES` because the write would be refused. Both are absences, they look identical on
 * screen, and a single condition covering both would be one of them silently doing the other's
 * job.
 *
 * `verify:device:doseaccess` `DOSE-6` measures the capability half on hardware and costs twelve
 * minutes. This asks the same question in milliseconds, and asks the combinations a device run
 * cannot reach without a second seeded household.
 *
 * WHY THIS FILE IS NOT NEXT TO THE COMPONENT IT TESTS
 * Because `src/app` is Expo Router's route directory and it is enumerated with `require.context`,
 * so **every** file under it is treated as a route and bundled. A `.test.tsx` there is bundled
 * too, it imports `react-test-renderer`, that is not a dependency of the app, and the bundle
 * fails - the phone shows Metro's red error overlay and nothing runs (`DEV-054`). The route
 * directory holds routes; a test of something that lives there lives here.
 */

import { describe, it, expect } from 'vitest';
import { shelfItemView, type ShelfItem } from '@kynviora/contracts';
import { hasName, press, renderScreen, screenNames } from '../../../test/render.js';
import { ShelfRow } from '@/app/(tabs)/shelf';

const MEDICINE: ShelfItem = {
  id: 'item-1',
  profileId: 'profile-1',
  itemKind: 'MEDICINE',
  displayName: 'Synthetic Tablet A',
  brand: null,
  lifecycleState: 'ACTIVE',
  identityVerification: 'UNVERIFIED',
  formulationVerification: 'UNVERIFIED',
  batchVerification: 'UNVERIFIED',
  lastReviewedAt: null,
  lastSafetyCheckedAt: null,
  attentionReasons: [],
} as unknown as ShelfItem;

const SHAMPOO: ShelfItem = { ...MEDICINE, id: 'item-2', itemKind: 'PERSONAL_CARE' };

function row(item: ShelfItem, mayRecordDoses: boolean) {
  const pressed: string[] = [];
  const rendered = renderScreen(
    <ShelfRow
      item={shelfItemView(item)}
      mayRecordDoses={mayRecordDoses}
      onOpen={() => pressed.push('open')}
      onRecord={() => pressed.push('record')}
      onSchedule={() => pressed.push('schedule')}
    />,
  );
  return { rendered, pressed };
}

describe('a medicine', () => {
  it('offers the dose control to somebody who may record one', () => {
    expect(hasName(row(MEDICINE, true).rendered, 'Record what happened')).toBe(true);
  });

  it('withholds it from somebody who may not', () => {
    // DEC-116. Withheld rather than drawn and disabled (DEC-045): a greyed-out control on somebody
    // else's medicine tells a caregiver what they are not trusted with, which is a fact about the
    // permission model they did not need. Asserted as absence from the whole row, because a
    // disabled control still announces itself to a screen reader.
    expect(hasName(row(MEDICINE, false).rendered, 'Record what happened')).toBe(false);
  });

  it('still offers everything the dose capability does not govern', () => {
    // The half that must not move with it. `RECORD_DOSES` is about writing into a dose history and
    // nothing else, so opening the item and setting its times are unaffected - and a change that
    // gated all three on one flag would be a caregiver losing the shelf.
    const { rendered } = row(MEDICINE, false);
    expect(hasName(rendered, 'Open this item')).toBe(true);
    expect(hasName(rendered, 'When do you take this?')).toBe(true);
  });

  it('calls the right handler for each control', () => {
    const { rendered, pressed } = row(MEDICINE, true);
    press(rendered, 'Record what happened');
    press(rendered, 'When do you take this?');
    press(rendered, 'Open this item');
    expect(pressed).toEqual(['record', 'schedule', 'open']);
  });
});

describe('a personal-care product', () => {
  it('offers no dose control even to somebody who may record doses', () => {
    // A different absence for a different reason, and this is the case that tells the two apart: a
    // dose is a medicine's idea, so the control is wrong on a shampoo whoever is asking.
    // `buildDoseRecord` refuses to build one for this kind on the same ground.
    expect(hasName(row(SHAMPOO, true).rendered, 'Record what happened')).toBe(false);
  });

  it('offers no schedule control either', () => {
    // Migration `0020` refuses a schedule on a personal-care item outright, so offering the
    // control would be a form somebody fills in for a write the database will not take.
    expect(hasName(row(SHAMPOO, true).rendered, 'When do you take this?')).toBe(false);
  });

  it('is still openable', () => {
    expect(hasName(row(SHAMPOO, false).rendered, 'Open this item')).toBe(true);
  });
});

describe('what the row says about the item itself', () => {
  it('draws all three verification chips, never one merged state', () => {
    // `18`: "Product identity confirmed", "Formula confirmed from this label" and "Batch not
    // entered" are three different statements about three different things, and `08` keeps the
    // axes separate. A row that merged them into one badge would be asserting something nobody
    // checked.
    const { rendered } = row(MEDICINE, true);
    expect(hasName(rendered, { contains: 'Product not verified' })).toBe(true);
    expect(hasName(rendered, { contains: 'Formula not verified' })).toBe(true);
    expect(hasName(rendered, { contains: 'Batch not entered' })).toBe(true);
  });

  it('names the item', () => {
    expect(hasName(row(MEDICINE, true).rendered, 'Synthetic Tablet A')).toBe(true);
  });

  it('shows what needs attention on the row rather than only behind a filter', () => {
    // `04` Phase 2.1's second exit criterion: a person has to be able to see which items need
    // something without knowing to filter for it.
    const withReasons = { ...MEDICINE, attentionReasons: ['IDENTITY_UNVERIFIED'] } as ShelfItem;
    const { rendered } = row(withReasons, true);
    expect(hasName(rendered, { contains: 'Nobody has confirmed which product this is' })).toBe(
      true,
    );
  });

  it('draws no count or badge of what needs attention', () => {
    // `02` forbids the aggregate and `04` Phase 8.3 forbids the badge. The reasons are a list of
    // separate statements; a total would be a score of how well somebody is keeping up, which is
    // the anti-feature stated in the strongest terms the specification uses.
    //
    // Two reasons on purpose, so a "2" appearing anywhere is a number that could only be a count
    // of them.
    const withReasons = {
      ...MEDICINE,
      attentionReasons: ['IDENTITY_UNVERIFIED', 'FORMULATION_UNVERIFIED'],
    } as ShelfItem;
    const { rendered } = row(withReasons, true);

    for (const name of screenNames(rendered)) {
      expect(name).not.toMatch(/\b\d+\s*(items?|things?|reasons?)\b/i);
      expect(name).not.toMatch(/\b\d+\s*(of|\/)\s*\d+\b/);
      expect(name).not.toMatch(/\b\d+%/);
    }
  });
});
