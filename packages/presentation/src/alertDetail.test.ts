import { describe, it, expect } from 'vitest';
import {
  ALERT_ACTIONS,
  EXPLANATION_TEMPLATE_IDS,
  FACT_BASES,
  FACT_BASIS_TEXT,
  MATCH_REASON_TEXT,
  UNEXPLAINABLE,
  alertDetailView,
  explanationFor,
  isExplanationTemplateId,
  isInferred,
  matchReasonsView,
  sourceLineView,
  type AlertDetailInput,
  type SourceLineInput,
} from './alertDetail.js';
import { SAFETY_MESSAGE_PARTS, containsForbiddenClaim, validateSafetyMessage } from './copy.js';

/**
 * Phase 7.3, alert detail and explainability.
 *
 * The exit criterion this file can actually assert is the second one - "the UI reveals what is
 * known versus inferred" - and it is asserted as a property of the type rather than as the
 * presence of a sentence. The first criterion needs usability participants and is `BLK-008`
 * shaped: nobody here can run it.
 */

const SOURCE: SourceLineInput = {
  organization: 'Synthetic Authority',
  sourceName: 'Synthetic Register',
  jurisdiction: 'GB',
  legalReference: 'SI 2026/1',
  publicationDate: '2026-08-01',
  effectiveDate: '2026-08-15',
  licenseReviewState: 'APPROVED',
  requiredAttribution: 'Contains public sector information.',
};

function detail(overrides: Partial<AlertDetailInput> = {}): AlertDetailInput {
  return {
    alertPublicationId: '00000000-0000-4000-8000-0000000000aa',
    state: 'PUBLISHED',
    publishedAt: '2026-09-01T09:00:00.000Z',
    withdrawnAt: null,
    withdrawnReason: null,
    personName: 'Parent A',
    itemName: 'Synthetic Tablet',
    itemBrand: 'Synthetic Brand',
    matchConfidence: 'EXACT',
    evidenceLevel: 'A',
    urgency: 'HIGH',
    reasons: ['BATCH_CODE_MATCHED'],
    explanationTemplateId: 'tpl.batch',
    evaluatedAt: '2026-09-01T08:00:00.000Z',
    lotCode: 'LOT-9',
    lotFromLabel: false,
    expiresOn: null,
    hasExpired: false,
    ingredientName: null,
    recordedTerm: null,
    formulationConfirmedFromLabel: false,
    source: SOURCE,
    monitoredJurisdictions: ['GB', 'NI'],
    alreadyReportedIncorrect: false,
    ...overrides,
  };
}

describe('where a fact came from', () => {
  it('gives every basis a sentence', () => {
    for (const basis of FACT_BASES) {
      expect(FACT_BASIS_TEXT[basis].length).toBeGreaterThan(10);
    }
  });

  it('treats only the computed basis as inferred', () => {
    expect(isInferred('COMPUTED_BY_KYNVIORA')).toBe(true);
    for (const basis of FACT_BASES.filter((b) => b !== 'COMPUTED_BY_KYNVIORA')) {
      expect(isInferred(basis)).toBe(false);
    }
  });

  it('gives every fact on the page a basis, with no exception', () => {
    // The exit criterion as a property. There is no constructor that produces a fact without a
    // basis, so a new field cannot arrive on the screen unlabelled.
    const view = alertDetailView(detail());
    expect(view.facts.length).toBeGreaterThan(5);
    for (const entry of view.facts) {
      expect(FACT_BASES).toContain(entry.basis);
      expect(entry.basisText).toBe(FACT_BASIS_TEXT[entry.basis]);
    }
  });

  it('reports a value nobody has as not known, whatever the caller claimed', () => {
    const view = alertDetailView(detail({ lotCode: null, itemBrand: '   ' }));
    const lot = view.facts.find((f) => f.label === 'Batch or lot');
    const brand = view.facts.find((f) => f.label === 'Brand');
    // Otherwise a missing batch number reads as something a person entered, which is the
    // opposite of true and is the field a recall turns on.
    expect(lot?.basis).toBe('NOT_KNOWN');
    expect(lot?.value).toBeNull();
    expect(brand?.basis).toBe('NOT_KNOWN');
  });

  it('keeps a not-known fact on the page rather than dropping the row', () => {
    const view = alertDetailView(detail({ expiresOn: null }));
    expect(view.facts.map((f) => f.label)).toContain('Expiry date');
  });

  it('distinguishes a batch number read from the pack from one somebody typed', () => {
    const typed = alertDetailView(detail({ lotFromLabel: false }));
    const read = alertDetailView(detail({ lotFromLabel: true }));
    expect(typed.facts.find((f) => f.label === 'Batch or lot')?.basis).toBe('RECORDED_BY_A_PERSON');
    expect(read.facts.find((f) => f.label === 'Batch or lot')?.basis).toBe('READ_FROM_THE_PACK');
  });

  it('counts what it inferred, so the screen can say how much of this is its own opinion', () => {
    const view = alertDetailView(detail());
    expect(view.inferredCount).toBeGreaterThan(0);
    expect(view.inferredCount).toBe(view.facts.filter((f) => isInferred(f.basis)).length);
  });
});

describe('the explanation template', () => {
  it('recognises only the approved identifiers', () => {
    for (const id of EXPLANATION_TEMPLATE_IDS) expect(isExplanationTemplateId(id)).toBe(true);
    expect(isExplanationTemplateId('tpl.synthetic')).toBe(false);
    expect(isExplanationTemplateId('')).toBe(false);
  });

  it('renders no narrative at all for a template this build does not have', () => {
    // The rule froze a template identifier; this build has no approved wording for it. A generic
    // "a safety rule matched this item" would be a sentence about somebody's medicine that no
    // reviewer wrote.
    const view = alertDetailView(detail({ explanationTemplateId: 'tpl.synthetic' }));
    expect(view.message).toBeNull();
    expect(view.unexplainable).toEqual(UNEXPLAINABLE);
  });

  it('still shows every fact and state when it cannot explain', () => {
    const view = alertDetailView(detail({ explanationTemplateId: 'tpl.synthetic' }));
    expect(view.facts.length).toBeGreaterThan(5);
    expect(view.urgency.label.length).toBeGreaterThan(0);
    expect(view.evidence.label.length).toBeGreaterThan(0);
    expect(view.reasons.reasons.length).toBeGreaterThan(0);
  });

  it('renders no narrative when a template is known but its required context is missing', () => {
    // `batchRecallMessage` would produce "null published a notice" from an absent authority, and
    // a sourceless claim about a recall is worse than no narrative.
    const view = alertDetailView(
      detail({ source: { ...SOURCE, organization: null, publicationDate: null } }),
    );
    expect(view.message).toBeNull();
    expect(view.unexplainable).not.toBeNull();
  });

  it('produces all eight parts in the prescribed order when it can explain', () => {
    const view = alertDetailView(detail());
    expect(view.message).toHaveLength(SAFETY_MESSAGE_PARTS.length);
  });

  it('produces no forbidden claim from any template', () => {
    for (const templateId of EXPLANATION_TEMPLATE_IDS) {
      const message = explanationFor(templateId, {
        personName: 'Parent A',
        itemName: 'Synthetic Tablet',
        matchConfidence: 'EXACT',
        authority: 'Synthetic Authority',
        jurisdictionName: 'GB',
        publicationDate: '2026-08-01',
        lotCode: 'LOT-9',
        ingredientName: 'synthetic substance',
        recordedTerm: 'synthetic sensitivity',
        formulationConfirmedFromLabel: true,
        expiresOn: '2026-12-01',
        hasExpired: false,
      });
      expect(message).not.toBeNull();
      if (message !== null) expect(validateSafetyMessage(message)).toEqual([]);
    }
  });

  it('writes no forbidden claim in its own copy either', () => {
    expect(containsForbiddenClaim(UNEXPLAINABLE.body)).toBe(false);
  });
});

describe('the reason for the match', () => {
  it('turns a machine reason into a sentence', () => {
    const view = matchReasonsView(['BATCH_CODE_MATCHED']);
    expect(view.reasons).toEqual([MATCH_REASON_TEXT.BATCH_CODE_MATCHED]);
    expect(view.undescribedCount).toBe(0);
    expect(view.undescribedNote).toBeNull();
  });

  it('drops a reason it has no wording for, and counts it', () => {
    // A bare `DUPLICATE_ACTIVE_KEY` on a safety screen is worse than an omission the screen
    // admits to - the same choice the Lens makes for an undescribed regulatory status.
    const view = matchReasonsView(['BATCH_CODE_MATCHED', 'SOMETHING_NEW']);
    expect(view.reasons).toHaveLength(1);
    expect(view.undescribedCount).toBe(1);
    expect(view.undescribedNote).toContain('1 further reason');
  });

  it('never renders the machine code itself', () => {
    const view = matchReasonsView(['SOMETHING_NEW']);
    expect(JSON.stringify(view)).not.toContain('SOMETHING_NEW');
  });

  it('says nothing rather than "no reason" when the list is empty', () => {
    const view = matchReasonsView([]);
    expect(view.reasons).toEqual([]);
    expect(view.undescribedNote).toBeNull();
  });
});

describe('the source line', () => {
  it('shows the reference where the licence review approved it', () => {
    const view = sourceLineView(SOURCE);
    expect(view.reference).toBe('SI 2026/1');
    expect(view.referenceWithheldBecause).toBeNull();
    expect(view.attribution).toBe('Contains public sector information.');
  });

  it('withholds the reference where the licence review has not happened, and says so', () => {
    // `04` asks for the reference "where allowed"; `25` makes that a legal question, and
    // `BLK-005` records that no per-source review exists. A silent gap would read as "there is
    // no source".
    const view = sourceLineView({ ...SOURCE, licenseReviewState: 'NOT_REVIEWED' });
    expect(view.reference).toBeNull();
    expect(view.referenceWithheldBecause).toContain('BLK-005');
    // The publisher and the date are not restricted, so they stay.
    expect(view.organization).toBe('Synthetic Authority');
    expect(view.publishedOn).toBe('2026-08-01');
  });

  it('withholds the attribution with the reference, because attribution names the licence', () => {
    const view = sourceLineView({ ...SOURCE, licenseReviewState: 'RESTRICTED' });
    expect(view.attribution).toBeNull();
  });

  it('says plainly when an alert rests on no external source', () => {
    const view = sourceLineView({
      organization: null,
      sourceName: null,
      jurisdiction: null,
      legalReference: null,
      publicationDate: null,
      effectiveDate: null,
      licenseReviewState: null,
      requiredAttribution: null,
    });
    expect(view.summary).toContain('does not rest on an external published source');
  });
});

describe('urgency, evidence and confidence stay separate', () => {
  it('exposes three presentations and no combined one', () => {
    const view = alertDetailView(detail());
    expect(view.urgency.label).not.toBe(view.evidence.label);
    // `23` D-005. There is nowhere on this view to put a severity, and a test that only checked
    // the values would miss a field called `severity` holding a string.
    const keys = Object.keys(view);
    expect(keys).not.toContain('severity');
    expect(keys).not.toContain('score');
    expect(keys).not.toContain('riskLevel');
  });

  it('claims least on an unrecognised evidence level and match confidence', () => {
    const view = alertDetailView(
      detail({ evidenceLevel: 'SOMETHING', matchConfidence: 'SOMETHING' }),
    );
    expect(view.evidence.label).toBe('Insufficient information');
    expect(view.matchConfidence.label).toBe('No match');
  });

  it('falls back to informational on an unrecognised urgency, which is the safer direction', () => {
    // DEC-040's exception: a false alarm carrying a medicine's name is the worse failure.
    const view = alertDetailView(detail({ urgency: 'SOMETHING' }));
    expect(view.urgency.label).toBe('For information');
  });
});

describe('a withdrawn alert', () => {
  it('is readable and does not look live', () => {
    // `19` treats a withdrawn alert resurfacing as actionable as a release-blocking defect.
    const view = alertDetailView(
      detail({
        state: 'WITHDRAWN',
        withdrawnAt: '2026-09-02T09:00:00.000Z',
        withdrawnReason: 'Superseded by a correction.',
      }),
    );
    expect(view.isLive).toBe(false);
    expect(view.withdrawnNotice).toContain('Do not act on it');
    expect(view.withdrawnNotice).toContain('Superseded by a correction.');
  });

  it('says so even when no reason was recorded', () => {
    const view = alertDetailView(detail({ state: 'WITHDRAWN' }));
    expect(view.withdrawnNotice).toContain('No reason was recorded');
  });

  it('offers no correction action, because there is nothing live to correct', () => {
    const view = alertDetailView(detail({ state: 'WITHDRAWN' }));
    expect(view.actions).toEqual([]);
    expect(view.actionsUnavailableBecause).toContain('withdrawn');
  });
});

describe('the correction action', () => {
  it('offers exactly one, and it is about Kynviora being wrong', () => {
    const view = alertDetailView(detail());
    expect(view.actions).toHaveLength(1);
    expect(view.actions[0]?.action).toBe('REPORT_INCORRECT_MATCH');
    expect(ALERT_ACTIONS).toEqual(['REPORT_INCORRECT_MATCH']);
  });

  it('offers no resolution vocabulary, which belongs to Phase 7.6', () => {
    const view = alertDetailView(detail());
    const offered = view.actions.map((a) => a.action as string);
    for (const resolution of [
      'REVIEWED',
      'NOT_APPLICABLE',
      'RETURNED_OR_DISPOSED',
      'QUARANTINED',
    ]) {
      expect(offered).not.toContain(resolution);
    }
  });

  it('says the report does not delete anything', () => {
    const view = alertDetailView(detail());
    expect(view.actions[0]?.explanation).toContain('does not delete the alert');
  });

  it('stops offering it once it has been reported, and says why', () => {
    const view = alertDetailView(detail({ alreadyReportedIncorrect: true }));
    expect(view.actions).toEqual([]);
    expect(view.actionsUnavailableBecause).toContain('already told Kynviora');
  });
});

describe('a half this session may not see', () => {
  it('withholds the item and says so, rather than reporting it as not known', () => {
    // `03` group H: safety access and shelf access are separate permissions, so a caregiver can
    // hold one and not the other. "Kynviora does not have this" would be false, and a blank
    // would look like it.
    const view = alertDetailView(detail({ itemName: null }));
    const item = view.facts.find((f) => f.label === 'Item');
    expect(item?.basis).toBe('WITHHELD_FROM_THIS_SESSION');
    expect(item?.value).toBeNull();
    expect(item?.basisText).toContain('your access does not include it');
  });

  it('withholds the brand and the batch with the item, because all three are the shelf', () => {
    const view = alertDetailView(detail({ itemName: null }));
    for (const label of ['Brand', 'Batch or lot']) {
      expect(view.facts.find((f) => f.label === label)?.basis).toBe('WITHHELD_FROM_THIS_SESSION');
    }
  });

  it('renders no narrative, because every template names the person and the item', () => {
    const view = alertDetailView(detail({ itemName: null }));
    expect(view.message).toBeNull();
    // And it is not the "cannot explain" state: Kynviora can explain this perfectly well.
    expect(view.unexplainable).toBeNull();
    expect(view.withheldNotice).not.toBeNull();
  });

  it('names which half is missing', () => {
    expect(alertDetailView(detail({ itemName: null })).withheldNotice).toContain(
      'shelf it is about',
    );
    expect(alertDetailView(detail({ personName: null })).withheldNotice).toContain(
      'profile it is about',
    );
    expect(alertDetailView(detail({ personName: null, itemName: null })).withheldNotice).toContain(
      'shelf or the profile',
    );
  });

  it('keeps the urgency, the evidence level and the reasons, which are the alert itself', () => {
    const view = alertDetailView(detail({ itemName: null }));
    expect(view.urgency.label).toBe('Act soon');
    expect(view.evidence.label).toBe('Official action');
    expect(view.reasons.reasons.length).toBeGreaterThan(0);
  });

  it('says nothing about withholding when nothing is withheld', () => {
    expect(alertDetailView(detail()).withheldNotice).toBeNull();
  });

  it('distinguishes withheld from not known, which are opposite facts', () => {
    const view = alertDetailView(detail({ itemName: null, expiresOn: null }));
    expect(view.facts.find((f) => f.label === 'Item')?.basis).toBe('WITHHELD_FROM_THIS_SESSION');
    expect(view.facts.find((f) => f.label === 'Expiry date')?.basis).toBe('NOT_KNOWN');
  });
});

describe('the coverage statement', () => {
  it('appears on the detail as well as on the inbox', () => {
    const view = alertDetailView(detail());
    expect(view.coverageStatement).toContain('GB, NI');
    expect(view.coverageStatement).toContain('does not cover every source');
  });

  it('says so when nothing is monitored at all', () => {
    const view = alertDetailView(detail({ monitoredJurisdictions: [] }));
    expect(view.coverageStatement).toContain('not currently monitoring');
  });

  it('writes no forbidden claim', () => {
    for (const jurisdictions of [[], ['GB']]) {
      const view = alertDetailView(detail({ monitoredJurisdictions: jurisdictions }));
      expect(containsForbiddenClaim(view.coverageStatement)).toBe(false);
      expect(containsForbiddenClaim(view.basisNote)).toBe(false);
    }
  });
});
