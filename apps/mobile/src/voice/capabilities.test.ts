/**
 * What the agent is offered, and how it comes to know.
 *
 * Spec references: `11`, `13`, `14` (deny by default), DEC-116, DEC-132, DEC-141, `DEV-074`.
 *
 * The rule this file exists to hold: **voice offers exactly what the server says the caller holds,
 * no more and no less.** More is a person completing a spoken form the route will refuse; less is
 * what `DEV-074` was - a caregiver told to use the screen for a change they were entitled to make,
 * because the app had never asked.
 */

import { describe, it, expect } from 'vitest';
import { capabilitiesFor } from './capabilities';

describe('an owner', () => {
  it('holds every capability, because ownership is not a grant', () => {
    const held = capabilitiesFor({ isOwner: true });
    for (const capability of [
      'VIEW_MEDICINES',
      'VIEW_PERSONAL_CARE',
      'RECORD_DOSES',
      'MANAGE_MEDICINES',
      'MANAGE_PERSONAL_CARE',
      'VIEW_ALERTS',
    ] as const) {
      expect(held.has(capability)).toBe(true);
    }
  });

  it('does not hold `OWNER_ONLY`, which is not a capability at all', () => {
    // It is the absence of every caregiver path, answered from `isOwner` in the dispatcher. A set
    // that contained it would let a future caregiver capability of that name satisfy it - the
    // shape of mistake DEC-116 was about.
    expect(capabilitiesFor({ isOwner: true }).has('OWNER_ONLY')).toBe(false);
  });

  it('is unaffected by a grant, because a grant cannot limit ownership', () => {
    // An owner is not a caregiver with every box ticked. If the report were ever empty for an
    // owner - an unreachable profile, a failed request - reading it would take their own app away
    // from them, so it is not read at all.
    expect(capabilitiesFor({ isOwner: true, granted: [] }).has('MANAGE_MEDICINES')).toBe(true);
  });
});

describe('a caregiver', () => {
  it('is offered the reads and nothing that writes, before the server has answered', () => {
    // `14` is deny by default, and an absent answer is not permission. The cost of the safe
    // direction is a caregiver being told to use the screen - where the control is.
    const held = capabilitiesFor({ isOwner: false });
    expect(held.has('VIEW_MEDICINES')).toBe(true);
    expect(held.has('VIEW_ALERTS')).toBe(true);
    expect(held.has('RECORD_DOSES')).toBe(false);
    expect(held.has('MANAGE_MEDICINES')).toBe(false);
  });

  it('reads no differently from an empty report than from no report', () => {
    // "The server has not answered" and "the server says you hold nothing" are different facts and
    // must not become different offers: neither is permission.
    const absent = capabilitiesFor({ isOwner: false });
    const empty = capabilitiesFor({ isOwner: false, granted: [] });
    expect([...empty].sort()).toEqual([...absent].sort());
  });

  it('records a dose when the grant carries `RECORD_DOSES`', () => {
    // DEC-116, and the half `DEV-074` was costing. No existing grant acquired this capability and
    // `VIEW_MEDICINES` is not a way in - so an owner who granted it meant to, and voice must not
    // second-guess that by withholding the tool.
    expect(capabilitiesFor({ isOwner: false, granted: ['RECORD_DOSES'] }).has('RECORD_DOSES')).toBe(
      true,
    );
  });

  it('does not record a dose on `VIEW_MEDICINES` alone', () => {
    // The capabilities are a set, not a ladder (DEC-116). Reading a medicine has never been a way
    // to write into its history.
    expect(
      capabilitiesFor({ isOwner: false, granted: ['VIEW_MEDICINES'] }).has('RECORD_DOSES'),
    ).toBe(false);
  });

  it('keeps the two management capabilities separate, because the grant does', () => {
    // `MANAGE_MEDICINES` and `MANAGE_SHELF` are two grants and two policies - `owned_item_update`
    // asks for one or the other by item kind. Collapsing them here would let somebody trusted with
    // a shampoo edit a prescription, which is precisely the over-granting the split prevents.
    const medicines = capabilitiesFor({ isOwner: false, granted: ['MANAGE_MEDICINES'] });
    expect(medicines.has('MANAGE_MEDICINES')).toBe(true);
    expect(medicines.has('MANAGE_PERSONAL_CARE')).toBe(false);

    const shelf = capabilitiesFor({ isOwner: false, granted: ['MANAGE_SHELF'] });
    expect(shelf.has('MANAGE_PERSONAL_CARE')).toBe(true);
    expect(shelf.has('MANAGE_MEDICINES')).toBe(false);
  });

  it('maps the safety grant onto the alert tools', () => {
    expect(capabilitiesFor({ isOwner: false, granted: ['VIEW_SAFETY'] }).has('VIEW_ALERTS')).toBe(
      true,
    );
  });

  it('gains nothing from a grant capability no tool is behind', () => {
    // `VIEW_CARE`, `EXPORT_SUMMARY`, `MANAGE_CAREGIVERS` and the rest govern things that are
    // `OWNER_ONLY` or `TOUCH_ONLY` in the registry. The mapping is a lookup with no default, so
    // they contribute nothing rather than being mapped to something adjacent.
    const held = capabilitiesFor({
      isOwner: false,
      granted: [
        'VIEW_CARE',
        'MANAGE_CARE',
        'EXPORT_SUMMARY',
        'MANAGE_CAREGIVERS',
        'VIEW_DOCUMENTS',
      ],
    });
    expect([...held].sort()).toEqual(['VIEW_ALERTS', 'VIEW_MEDICINES', 'VIEW_PERSONAL_CARE']);
  });

  it('ignores a capability this build has never heard of', () => {
    // The vocabulary belongs to the database. A newer server reporting something new is not an
    // error, and a mapping that threw would take a caregiver's whole conversation away over a
    // string it did not recognise.
    const held = capabilitiesFor({
      isOwner: false,
      granted: ['RECORD_DOSES', 'SOMETHING_NOBODY_HAS_WRITTEN_YET'],
    });
    expect(held.has('RECORD_DOSES')).toBe(true);
    expect(held.has('MANAGE_MEDICINES')).toBe(false);
  });

  it('is offered everything a fully granted caregiver may do', () => {
    // The parity check `DEV-074` was about. A caregiver holding every grant that maps to a tool is
    // offered every tool those grants govern - no less than touch, which offers each of them from
    // the screen the capability belongs to.
    const held = capabilitiesFor({
      isOwner: false,
      granted: [
        'VIEW_MEDICINES',
        'VIEW_SHELF',
        'VIEW_SAFETY',
        'RECORD_DOSES',
        'MANAGE_MEDICINES',
        'MANAGE_SHELF',
      ],
    });
    expect([...held].sort()).toEqual([
      'MANAGE_MEDICINES',
      'MANAGE_PERSONAL_CARE',
      'RECORD_DOSES',
      'VIEW_ALERTS',
      'VIEW_MEDICINES',
      'VIEW_PERSONAL_CARE',
    ]);
  });

  it('never acquires `OWNER_ONLY`, whatever the server reports', () => {
    // The one thing no grant can carry. Deleting an item, closing an account, administering
    // caregivers and exporting are answered from ownership in the dispatcher and consult no set,
    // so this asserts the shape rather than the policy - but a set that could contain it is the
    // shape a mistake would need.
    const held = capabilitiesFor({
      isOwner: false,
      granted: ['OWNER_ONLY', 'MANAGE_CAREGIVERS', 'MANAGE_MEDICINES'],
    });
    expect(held.has('OWNER_ONLY')).toBe(false);
  });
});
