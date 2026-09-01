import { describe, it, expect } from 'vitest';
import { ATTENTION_REASONS } from '@kynviora/domain';
import {
  ATTENTION_PRESENTATION,
  attentionListView,
  itemDetailView,
  type ItemDetailInput,
} from './itemDetail.js';

function detail(overrides: Partial<ItemDetailInput> = {}): ItemDetailInput {
  return {
    id: 'i1',
    itemKind: 'MEDICINE',
    displayName: 'Synthetic Tablet',
    brand: 'Synthetic Brand',
    market: 'GB',
    lifecycleState: 'ACTIVE',
    identityVerification: 'CONFIRMED',
    formulationVerification: 'UNVERIFIED',
    batchVerification: 'UNVERIFIED',
    strengthText: '500 mg',
    dosageForm: 'Tablet',
    directionsText: 'Take one twice a day with food.',
    personalCareCategory: null,
    startedOn: '2026-08-01',
    stoppedOn: null,
    expiresOn: '2027-01-01',
    lastReviewedAt: null,
    lastSafetyCheckedAt: null,
    notes: null,
    attentionReasons: [],
    ...overrides,
  };
}

describe('exit criterion 1 - neither category is reduced to a generic note', () => {
  it('gives a medicine its own fields', () => {
    const view = itemDetailView(detail());
    expect(view.categoryHeading).toBe('About this medicine');
    expect(view.categoryFields.map((f) => f.label)).toEqual([
      'Strength',
      'Form',
      'Directions as written',
    ]);
  });

  it('gives a personal-care item its own', () => {
    const view = itemDetailView(
      detail({ itemKind: 'PERSONAL_CARE', personalCareCategory: 'HAIR_CARE' }),
    );
    expect(view.categoryHeading).toBe('About this product');
    expect(view.categoryFields.map((f) => f.label)).toEqual(['Kind of product']);
    // Rendered as a phrase. The column holds a closed vocabulary and `HAIR_CARE` beside a bottle
    // in somebody's bathroom is a field value, not a sentence.
    expect(view.categoryFields[0]?.value).toBe('Hair care');
  });

  it('renders a category it has no phrase for as absent rather than as its code', () => {
    const view = itemDetailView(
      detail({ itemKind: 'PERSONAL_CARE', personalCareCategory: 'SOMETHING_NEW' }),
    );
    expect(view.categoryFields[0]?.value).toBeNull();
    expect(view.categoryFields[0]?.absentNote).toBe('Not recorded');
    expect(JSON.stringify(view)).not.toContain('SOMETHING_NEW');
  });

  it('omits the other category fields entirely rather than rendering them blank', () => {
    // A medicine with an empty "kind of product" row reads as a medicine somebody failed to fill
    // in, which is the reduction to a generic note the criterion forbids.
    const medicine = itemDetailView(detail());
    expect(medicine.categoryFields.map((f) => f.label)).not.toContain('Kind of product');

    const personalCare = itemDetailView(detail({ itemKind: 'PERSONAL_CARE' }));
    for (const label of ['Strength', 'Form', 'Directions as written']) {
      expect(personalCare.categoryFields.map((f) => f.label)).not.toContain(label);
    }
  });

  it('reads an unknown item kind as personal care rather than dropping the fields', () => {
    const view = itemDetailView(detail({ itemKind: 'SOMETHING_NEW' }));
    expect(view.itemKind).toBe('PERSONAL_CARE');
    expect(view.categoryFields.length).toBeGreaterThan(0);
  });
});

describe('the fields a screen renders', () => {
  it('keeps a missing value as a row that says so', () => {
    const view = itemDetailView(detail({ stoppedOn: null }));
    const stopped = view.sharedFields.find((f) => f.label === 'Stopped');
    // A dropped row reads as "not relevant to this item"; an empty one reads as "nobody entered
    // it", and only the second is true.
    expect(stopped).toBeDefined();
    expect(stopped?.value).toBeNull();
    expect(stopped?.absentNote).toBe('Not recorded');
  });

  it('treats a blank string as absent', () => {
    const view = itemDetailView(detail({ strengthText: '   ' }));
    expect(view.categoryFields.find((f) => f.label === 'Strength')?.value).toBeNull();
  });

  it('marks written directions as somebody else words', () => {
    const view = itemDetailView(detail());
    const directions = view.categoryFields.find((f) => f.label === 'Directions as written');
    // `04` Phase 4.1 preserves the source text and `09` forbids Kynviora saying how to take a
    // medicine, so a screen renders this as a quotation rather than as an instruction.
    expect(directions?.quoted).toBe(true);
    expect(directions?.value).toBe('Take one twice a day with food.');
  });

  it('does not rewrite or summarise the directions', () => {
    const written = 'Take ONE tablet at 8am and 8pm. Do not exceed two in 24 hours.';
    const view = itemDetailView(detail({ directionsText: written }));
    expect(view.categoryFields.find((f) => f.label === 'Directions as written')?.value).toBe(
      written,
    );
  });
});

describe('the three verification axes', () => {
  it('presents them separately and never as one', () => {
    const view = itemDetailView(detail());
    expect(view.identity.label.length).toBeGreaterThan(0);
    expect(view.formulation.label.length).toBeGreaterThan(0);
    expect(view.batch.label.length).toBeGreaterThan(0);
    // `02` forbids an aggregate Trust Passport score, and one badge over three axes is that score
    // with the number left off.
    for (const forbidden of ['verified', 'trustScore', 'overall', 'score']) {
      expect(Object.keys(view)).not.toContain(forbidden);
    }
  });

  it('says beside them why there are three', () => {
    expect(itemDetailView(detail()).verificationNote).toContain('tracked separately');
  });

  it('reads an unrecognised verification as unverified, never as confirmed', () => {
    const view = itemDetailView(detail({ identityVerification: 'SOMETHING_NEW' }));
    expect(view.identity.label).toBe(
      itemDetailView(detail({ identityVerification: 'UNVERIFIED' })).identity.label,
    );
  });
});

describe('exit criterion 2 - what needs verification or review', () => {
  it('has a sentence and a next step for every reason', () => {
    for (const reason of ATTENTION_REASONS) {
      const presentation = ATTENTION_PRESENTATION[reason];
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.nextStep.length).toBeGreaterThan(0);
    }
  });

  it('never tells anybody what to do about the medicine', () => {
    for (const reason of ATTENTION_REASONS) {
      const { label, nextStep } = ATTENTION_PRESENTATION[reason];
      // Every next step is something a person does to the *record*. "Check with your pharmacist
      // before taking this" would be Kynviora deciding an unverified batch is a medical concern.
      expect(`${label} ${nextStep}`).not.toMatch(
        /stop taking|do not take|see (a|your) (doctor|pharmacist) before|speak to your doctor/i,
      );
    }
  });

  it('renders reasons in vocabulary order', () => {
    const view = attentionListView(['NEVER_REVIEWED', 'IDENTITY_UNVERIFIED']);
    expect(view.reasons.map((r) => r.reason)).toEqual(['IDENTITY_UNVERIFIED', 'NEVER_REVIEWED']);
  });

  it('drops a reason it has no wording for and counts it', () => {
    const view = attentionListView(['IDENTITY_UNVERIFIED', 'SOMETHING_NEW']);
    expect(view.reasons).toHaveLength(1);
    expect(view.undescribedCount).toBe(1);
    expect(view.undescribedNote).toContain('1 further note');
    expect(JSON.stringify(view)).not.toContain('SOMETHING_NEW');
  });

  it('uses the plural for more than one', () => {
    const view = attentionListView(['SOMETHING_NEW', 'SOMETHING_ELSE']);
    expect(view.undescribedNote).toContain('2 further notes');
  });

  it('does not present an empty list as reassurance about the product', () => {
    const view = attentionListView([]);
    // `18` forbids presenting an absence of findings as reassurance. This list is about what has
    // been entered, not about whether the medicine is safe - a different question, on a different
    // screen.
    expect(view.settledNote).toContain('about the record, not about the product');
    expect(view.settledNote).not.toMatch(/all good|looks good|you are safe|no problems/i);
  });

  it('says nothing settled where something is outstanding', () => {
    expect(attentionListView(['NEVER_REVIEWED']).settledNote).toBeNull();
  });

  it('carries no count of how many items need something', () => {
    const view = itemDetailView(detail({ attentionReasons: ['NEVER_REVIEWED'] }));
    // The per-item list is named reasons. There is no total anywhere - `02` forbids the aggregate
    // and Phase 8.3 forbids the badge.
    for (const forbidden of ['attentionCount', 'needsAttentionCount', 'total', 'score']) {
      expect(Object.keys(view)).not.toContain(forbidden);
    }
  });
});

describe('an item somebody has finished with', () => {
  it('says why it is not being asked about', () => {
    const view = itemDetailView(detail({ lifecycleState: 'STOPPED' }));
    expect(view.lifecycleNote).toContain('does not ask you to check it any further');
  });

  it('says nothing extra about an active one', () => {
    expect(itemDetailView(detail()).lifecycleNote).toBeNull();
  });

  it('says nothing for a lifecycle state it does not recognise', () => {
    expect(itemDetailView(detail({ lifecycleState: 'SOMETHING_NEW' })).lifecycleNote).toBeNull();
  });
});
