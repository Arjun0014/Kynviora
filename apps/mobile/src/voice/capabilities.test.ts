/**
 * What the agent is offered, and why a caregiver is offered less than they can do.
 *
 * Spec references: `11`, `13`, `14` (deny by default), DEC-116, DEC-132, `DEV-074`.
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
});

describe('a caregiver', () => {
  it('is offered the reads and nothing that writes', () => {
    const held = capabilitiesFor({ isOwner: false });
    expect(held.has('VIEW_MEDICINES')).toBe(true);
    expect(held.has('VIEW_ALERTS')).toBe(true);
    expect(held.has('RECORD_DOSES')).toBe(false);
    expect(held.has('MANAGE_MEDICINES')).toBe(false);
  });

  it('gains recording only when the server said so', () => {
    // DEC-116. No existing grant acquired `RECORD_DOSES`, and `VIEW_MEDICINES` is not a way in.
    expect(capabilitiesFor({ isOwner: false, mayRecordDoses: true }).has('RECORD_DOSES')).toBe(true);
    expect(capabilitiesFor({ isOwner: false, mayRecordDoses: false }).has('RECORD_DOSES')).toBe(
      false,
    );
  });

  it('narrows an absent answer to no, rather than to yes', () => {
    // An older server sends nothing here. `14` is deny by default, and the cost of the safe
    // direction is a caregiver being told to use the screen - where the control is.
    expect(capabilitiesFor({ isOwner: false }).has('RECORD_DOSES')).toBe(false);
    expect(capabilitiesFor({ isOwner: false }).has('MANAGE_MEDICINES')).toBe(false);
  });

  it('gains both management capabilities together, because one item answers for the item', () => {
    // `mayEdit` on an item detail is about that item; there is no per-category answer. Granting
    // both is the honest reading of "the server said this caller may change things here".
    const held = capabilitiesFor({ isOwner: false, mayEditItems: true });
    expect(held.has('MANAGE_MEDICINES')).toBe(true);
    expect(held.has('MANAGE_PERSONAL_CARE')).toBe(true);
  });
});
