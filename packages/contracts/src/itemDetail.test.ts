import { describe, it, expect } from 'vitest';
import { itemDetailScreenView, shelfItemView } from './views.js';
import type { ItemDetailResponse, ShelfItem, StatusPresentationResponse } from './client.js';

/**
 * The client half of Phase 2.1's remainder.
 *
 * The server composed every sentence, so the tests are about the two things a client decides:
 * what to do with a presentation it cannot read, and what to show on a shelf row.
 */

const PRESENTATION: StatusPresentationResponse = {
  label: 'Product identity confirmed',
  iconName: 'check-circle',
  tone: 'positive',
  description: 'Kynviora matched this to a catalog record.',
  accessibilityLabel: 'Identity: confirmed.',
};

function detail(overrides: Partial<ItemDetailResponse> = {}): ItemDetailResponse {
  return {
    id: 'i1',
    displayName: 'Synthetic Tablet',
    brand: null,
    itemKind: 'MEDICINE',
    lifecycleState: 'ACTIVE',
    lifecycleNote: null,
    identity: PRESENTATION,
    formulation: PRESENTATION,
    batch: PRESENTATION,
    verificationNote: 'These three are tracked separately.',
    categoryHeading: 'About this medicine',
    categoryFields: [
      { label: 'Strength', value: '500 mg', absentNote: null, quoted: false },
      {
        label: 'Directions as written',
        value: 'Take one twice a day.',
        absentNote: null,
        quoted: true,
      },
    ],
    sharedFields: [{ label: 'Stopped', value: null, absentNote: 'Not recorded', quoted: false }],
    attention: {
      reasons: [],
      undescribedCount: 0,
      undescribedNote: null,
      settledNote: 'Everything Kynviora asks for has been entered.',
    },
    attentionReasonCodes: [],
    version: 1,
    mayEdit: true,
    mayRecordDoses: true,
    editableValues: { displayName: 'Synthetic Tablet', strengthText: '500 mg' },
    stoppedOn: null,
    serverTime: '2026-09-02T12:00:00.000Z',
    ...overrides,
  };
}

function item(overrides: Partial<ShelfItem> = {}): ShelfItem {
  return {
    id: 'i1',
    profileId: 'p1',
    itemKind: 'MEDICINE',
    displayName: 'Synthetic Tablet',
    brand: null,
    lifecycleState: 'ACTIVE',
    shelfCollection: 'IN_USE',
    personalCareCategory: null,
    identityVerification: 'CONFIRMED',
    formulationVerification: 'CONFIRMED',
    batchVerification: 'CONFIRMED',
    lastReviewedAt: null,
    lastSafetyCheckedAt: null,
    attentionReasons: [],
    ...overrides,
  };
}

describe('the item detail a screen renders', () => {
  it('does not rewrite a single field the server sent', () => {
    const response = detail();
    const view = itemDetailScreenView(response);
    // `11` puts composition on the server. A client that rewrote any of this would carry the copy
    // in every shipped build.
    expect(view.categoryFields).toEqual(response.categoryFields);
    expect(view.sharedFields).toEqual(response.sharedFields);
    expect(view.attention).toEqual(response.attention);
    expect(view.verificationNote).toBe(response.verificationNote);
    expect(view.categoryHeading).toBe(response.categoryHeading);
  });

  it('drops a presentation it cannot read rather than rendering a blank chip', () => {
    const view = itemDetailScreenView(
      detail({ identity: { ...PRESENTATION, iconName: 'not-an-icon' } }),
    );
    // On a screen whose subject is how well Kynviora knows something, a blank label reads as a
    // state nobody assigned.
    expect(view.identity).toBeNull();
    expect(view.formulation).not.toBeNull();
  });

  it('reads an unknown item kind without dropping the item', () => {
    const view = itemDetailScreenView(detail({ itemKind: 'SOMETHING' as 'MEDICINE' }));
    expect(view.itemKind).toBe('PERSONAL_CARE');
    expect(view.displayName).toBe('Synthetic Tablet');
  });

  it('has no aggregate anywhere', () => {
    const view = itemDetailScreenView(detail());
    for (const forbidden of ['verified', 'trustScore', 'overall', 'score', 'attentionCount']) {
      expect(Object.keys(view)).not.toContain(forbidden);
    }
  });
});

describe('the shelf row', () => {
  it('carries what is not settled, as sentences', () => {
    const view = shelfItemView(
      item({ batchVerification: 'UNVERIFIED', attentionReasons: ['BATCH_UNVERIFIED'] }),
    );
    expect(view.attention).toHaveLength(1);
    expect(view.attention[0]).toContain('batch');
    expect(JSON.stringify(view.attention)).not.toContain('BATCH_UNVERIFIED');
  });

  it('says nothing where nothing is outstanding', () => {
    expect(shelfItemView(item()).attention).toEqual([]);
  });

  it('counts a reason it has no wording for rather than showing its code', () => {
    const view = shelfItemView(item({ attentionReasons: ['SOMETHING_NEW'] }));
    expect(view.attention).toEqual([]);
    expect(view.undescribedAttentionCount).toBe(1);
    expect(JSON.stringify(view)).not.toContain('SOMETHING_NEW');
  });

  it('carries no count of how many things are outstanding', () => {
    const view = shelfItemView(item({ attentionReasons: ['BATCH_UNVERIFIED', 'NEVER_REVIEWED'] }));
    // `02` forbids the aggregate. The row says which, never how many - the undescribed count is
    // about this build's vocabulary, not about the item.
    for (const forbidden of ['attentionCount', 'needsAttention', 'total', 'score']) {
      expect(Object.keys(view)).not.toContain(forbidden);
    }
    expect(view.attention).toHaveLength(2);
  });
});

describe('what an editor is handed', () => {
  /**
   * The three fields an edit needs, narrowed rather than trusted.
   *
   * A screen that guessed any of them would guess wrong in the direction that costs something: it
   * would offer a control the write refuses, send a change against a version nobody has, or show
   * lifecycle controls for a state it could not read.
   */

  it('carries the version and the permission through', () => {
    const view = itemDetailScreenView(detail({ version: 7, mayEdit: true }));
    expect(view.version).toBe(7);
    expect(view.mayEdit).toBe(true);
  });

  it('withholds the controls where the server did not say', () => {
    // Deny by default (`14`), applied to a control. Withholding one a person could have used
    // costs a tap; offering one the write refuses costs them a form filled in for nothing.
    const missing = { ...detail() } as Record<string, unknown>;
    delete missing['mayEdit'];

    const view = itemDetailScreenView(missing as unknown as ItemDetailResponse);
    expect(view.mayEdit).toBe(false);
  });

  it('withholds them for a value that is not a boolean', () => {
    const view = itemDetailScreenView({
      ...detail(),
      mayEdit: 'yes',
    } as unknown as ItemDetailResponse);
    expect(view.mayEdit).toBe(false);
  });

  it('keeps recording a dose separate from editing the medicine', () => {
    // Migration `0021` made them separate capabilities, and this is the combination the capability
    // was added for: somebody who sits with a person at breakfast and notes that they took a
    // tablet, who has no business deleting the prescription (`DEV-049`). A view that derived one
    // from the other would withhold the dose controls from exactly them.
    const view = itemDetailScreenView(detail({ mayEdit: false, mayRecordDoses: true }));
    expect(view.mayEdit).toBe(false);
    expect(view.mayRecordDoses).toBe(true);
  });

  it('withholds the dose controls where the server did not say', () => {
    const missing = { ...detail() } as Record<string, unknown>;
    delete missing['mayRecordDoses'];

    const view = itemDetailScreenView(missing as unknown as ItemDetailResponse);
    // Deny by default again, and it matters more here than it does for an edit: an older server
    // sends nothing, and inferring "yes" from silence would draw a control whose write the policy
    // refuses - which is a person told a dose was recorded when nothing was.
    expect(view.mayRecordDoses).toBe(false);
  });

  it('falls back to a version no write can succeed against', () => {
    // Zero is not a version any row has, and the schema starts at 1. A response this client could
    // not read produces a conflict rather than a silent overwrite of somebody else's change.
    const view = itemDetailScreenView({
      ...detail(),
      version: 'three',
    } as unknown as ItemDetailResponse);
    expect(view.version).toBe(0);
  });

  it('offers no lifecycle controls for a state it cannot read', () => {
    const view = itemDetailScreenView(detail({ lifecycleState: 'PAUSED' }));
    expect(view.lifecycleState).toBeNull();
  });

  it('reads the three states it knows', () => {
    for (const state of ['ACTIVE', 'STOPPED', 'ARCHIVED'] as const) {
      expect(itemDetailScreenView(detail({ lifecycleState: state })).lifecycleState).toBe(state);
    }
  });
});
