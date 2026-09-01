import { describe, it, expect } from 'vitest';
import { RECEIPT_UNCERTAINTIES, SAFETY_RESOLUTIONS } from '@kynviora/domain';
import {
  RECEIPT_UNCERTAINTY_TEXT,
  RESOLUTION_PRESENTATION,
  presentResolution,
  resolutionOptions,
  safetyReceiptView,
  type SafetyReceiptViewInput,
} from './safetyReceipt.js';
import { taskForm } from './reviewTaskEditor.js';

const NOW = '2026-09-01T12:00:00.000Z';
const LATER = '2026-09-02T12:00:00.000Z';

const BASIS: SafetyReceiptViewInput['basis'] = {
  assessedAt: NOW,
  alertPublishedAt: NOW,
  ruleKey: 'expiry.default',
  ruleVersion: '1.2.0',
  ruleVersionId: 'rule-version-1',
  regulatoryRuleVersionId: null,
  evidenceLevel: 'A',
  urgency: 'HIGH',
  matchConfidence: 'EXACT',
  normalizationVersion: 'norm-1',
};

const NO_SOURCE: SafetyReceiptViewInput['source'] = {
  organization: null,
  sourceName: null,
  jurisdiction: null,
  legalReference: null,
  publicationDate: null,
  effectiveDate: null,
  licenseReviewState: null,
  requiredAttribution: null,
};

function view(overrides: Partial<SafetyReceiptViewInput> = {}) {
  return safetyReceiptView({
    basis: BASIS,
    current: null,
    history: [],
    corrections: [],
    correctedSinceResolution: false,
    uncertainties: [],
    source: NO_SOURCE,
    ...overrides,
  });
}

describe('the resolution options', () => {
  it('gives every resolution a description saying what it does not do', () => {
    for (const resolution of SAFETY_RESOLUTIONS) {
      const presentation = presentResolution(resolution);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.accessibilityLabel.length).toBeGreaterThan(0);
      // `04` Phase 7.6's first exit criterion is that resolution never erases historical
      // assessment, and a person marking something "not applicable" reasonably expects it to go
      // away. The copy is where that expectation is corrected before they act on it.
      expect(presentation.description).toMatch(/does not|Kynviora keeps|nothing here replaces/i);
    }
  });

  it('never tells anybody what to do about a medicine', () => {
    // `09`. The one description that mentions going without a prescription medicine points at a
    // pharmacist rather than making the decision, which is the permitted direction.
    for (const resolution of SAFETY_RESOLUTIONS) {
      const { label, description } = RESOLUTION_PRESENTATION[resolution];
      expect(`${label} ${description}`).not.toMatch(
        /you should (stop|start|take|reduce|increase)|stop taking|do not take/i,
      );
    }
  });

  it('marks no option as recommended, default or primary', () => {
    for (const resolution of SAFETY_RESOLUTIONS) {
      const keys = Object.keys(RESOLUTION_PRESENTATION[resolution]);
      for (const forbidden of ['recommended', 'default', 'primary', 'suggested']) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });

  it('orders actions before feedback, and does not rank within either', () => {
    const order = resolutionOptions().map((o) => o.resolution);
    expect(order).toEqual([
      'REVIEWED',
      'NOT_APPLICABLE',
      'RETURNED_OR_DISPOSED',
      'QUARANTINED',
      'DISCUSSED_WITH_PROFESSIONAL',
      'ITEM_IDENTITY_CORRECTED',
      'REPORTED_INCORRECT_MATCH',
    ]);
    expect(order.filter((r) => RESOLUTION_PRESENTATION[r].isFeedback)).toEqual([
      'ITEM_IDENTITY_CORRECTED',
      'REPORTED_INCORRECT_MATCH',
    ]);
  });

  it('withholds only what currently stands, and offers everything else', () => {
    const offered = resolutionOptions(['REVIEWED']).map((o) => o.resolution);
    expect(offered).not.toContain('REVIEWED');
    // A person who marked an alert reviewed and has now spoken to a pharmacist is saying
    // something new, so one recorded answer must not empty the list.
    expect(offered).toHaveLength(SAFETY_RESOLUTIONS.length - 1);
  });

  it('agrees with the Review Inbox editor about which resolutions exist', () => {
    // Two surfaces, one CHECK constraint. The copy differs on purpose; the values may not, and
    // nothing but this test would notice one list gaining a member the other refuses.
    const field = taskForm('SAFETY_ITEM_AWAITING_CONFIRMATION').fields.find(
      (f) => f.field === 'resolution',
    );
    expect(field).toBeDefined();
    expect([...(field?.choices ?? [])].map((c) => c.value).sort()).toEqual(
      [...SAFETY_RESOLUTIONS].sort(),
    );
  });
});

describe('what remains uncertain', () => {
  it('has a sentence for every member of the domain vocabulary', () => {
    for (const code of RECEIPT_UNCERTAINTIES) {
      expect(RECEIPT_UNCERTAINTY_TEXT[code]).toBeDefined();
      expect(RECEIPT_UNCERTAINTY_TEXT[code]?.length).toBeGreaterThan(20);
    }
  });

  it('renders them as sentences rather than as codes', () => {
    const rendered = view({ uncertainties: [...RECEIPT_UNCERTAINTIES] });
    expect(rendered.uncertainties).toHaveLength(RECEIPT_UNCERTAINTIES.length);
    for (const code of RECEIPT_UNCERTAINTIES) {
      expect(JSON.stringify(rendered.uncertainties)).not.toContain(code);
    }
  });

  it('drops a code it has no sentence for rather than showing it', () => {
    const rendered = view({ uncertainties: ['SOMETHING_NEW', 'MATCH_NOT_EXACT'] });
    expect(rendered.uncertainties).toHaveLength(1);
    expect(JSON.stringify(rendered)).not.toContain('SOMETHING_NEW');
  });

  it('promises nobody is working on anything', () => {
    // `10` prefers an honest absence to a queue this build has no staffing model for.
    for (const code of RECEIPT_UNCERTAINTIES) {
      expect(RECEIPT_UNCERTAINTY_TEXT[code]).not.toMatch(
        /we will|we are|looking into|shortly|soon|as soon as/i,
      );
    }
  });
});

describe('the receipt a screen renders', () => {
  it('says what recording something does not do, in every state', () => {
    const empty = view();
    expect(empty.permanenceNote).toContain('does not remove the alert');
    expect(empty.emptyMessage).toContain('not recorded anything');
    expect(empty.current).toBeNull();

    const filled = view({ current: { resolution: 'REVIEWED', note: null, resolvedAt: NOW } });
    expect(filled.permanenceNote).toBe(empty.permanenceNote);
  });

  it('has no completion, progress or resolved state anywhere', () => {
    const rendered = view({ current: { resolution: 'REVIEWED', note: null, resolvedAt: NOW } });
    // `02` names alarm-optimised design as an anti-feature; a completion meter is the cheerful
    // version of the same thing, and it would decide which of a person's actions counted.
    for (const forbidden of ['resolved', 'complete', 'progress', 'score', 'status', 'handled']) {
      expect(Object.keys(rendered)).not.toContain(forbidden);
    }
  });

  it('says out loud that it holds a resolution it has no wording for', () => {
    const rendered = view({
      current: { resolution: 'QUARANTINED_PENDING_REVIEW', note: null, resolvedAt: NOW },
    });
    // Unlike a dropped row in a list, this one is said out loud: it is the only thing standing,
    // and showing nothing would read as "you have recorded nothing".
    expect(rendered.current).toBeNull();
    expect(rendered.undescribedResolutionNote).toContain('no wording for');
    expect(rendered.undescribedResolutionNote).toContain('still recorded');
    expect(JSON.stringify(rendered)).not.toContain('QUARANTINED_PENDING_REVIEW');
  });

  it('drops a history row it has no wording for and counts it', () => {
    const rendered = view({
      history: [
        { resolution: 'REVIEWED', recordedAt: NOW, replacedPrevious: false },
        { resolution: 'SOMETHING_NEW', recordedAt: LATER, replacedPrevious: true },
      ],
    });
    expect(rendered.history).toHaveLength(1);
    expect(rendered.undescribedHistoryCount).toBe(1);
    expect(JSON.stringify(rendered)).not.toContain('SOMETHING_NEW');
  });

  it('says on the row that replaced one that it replaced one', () => {
    const rendered = view({
      history: [
        { resolution: 'REVIEWED', recordedAt: NOW, replacedPrevious: false },
        { resolution: 'QUARANTINED', recordedAt: LATER, replacedPrevious: true },
      ],
    });
    // The one thing a single-row receipt could quietly lose.
    expect(rendered.history[0]?.replacedPreviousNote).toBeNull();
    expect(rendered.history[1]?.replacedPreviousNote).toContain('replaced what you had recorded');
  });

  it('names no actor on any row', () => {
    const rendered = view({
      current: { resolution: 'REVIEWED', note: null, resolvedAt: NOW },
      history: [{ resolution: 'REVIEWED', recordedAt: NOW, replacedPrevious: false }],
    });
    // DEC-076: identity belongs on the caregiver-audit screen, not on a receipt about an alert.
    for (const forbidden of ['userId', 'actor', 'recordedBy', 'resolvedBy']) {
      expect(JSON.stringify(rendered)).not.toContain(forbidden);
    }
  });

  it('still shows a correction whose kind it does not recognise', () => {
    // The opposite choice from a resolution, deliberately. A correction Kynviora made is a thing
    // that happened to this person's alert, and omitting it is the one direction exit criterion 2
    // forbids. The neutral heading says less rather than nothing.
    const rendered = view({
      corrections: [
        {
          correctionKind: 'SOMETHING_NEW',
          reason: 'A reason somebody wrote.',
          correctedAt: NOW,
          reviewerId: null,
        },
      ],
    });
    expect(rendered.corrections).toHaveLength(1);
    expect(rendered.corrections[0]?.heading).toBe('Kynviora recorded a correction');
    expect(rendered.corrections[0]?.reason).toBe('A reason somebody wrote.');
  });

  it('says out loud when a correction landed after what stands', () => {
    const rendered = view({ correctedSinceResolution: true });
    expect(rendered.correctedSinceNotice).toContain('after you recorded');
    expect(rendered.correctedSinceNotice).toContain('still here');
  });
});

describe('what the alert rested on', () => {
  it('renders the rule identity and the versions a person can quote', () => {
    const rendered = view();
    expect(rendered.basis.rule).toBe('expiry.default version 1.2.0');
    expect(rendered.basis.ruleVersionId).toBe('rule-version-1');
    expect(rendered.basis.normalizationVersion).toBe('norm-1');
    expect(rendered.basis.note).toContain('do not change');
  });

  it('renders the gradings as words rather than as letters', () => {
    const rendered = view();
    expect(rendered.basis.evidenceLabel).not.toBe('A');
    expect(rendered.basis.confidenceLabel).not.toBe('EXACT');
    expect(rendered.basis.evidenceDescription.length).toBeGreaterThan(0);
    expect(rendered.basis.confidenceDescription.length).toBeGreaterThan(0);
  });

  it('reads an unrecognised grading as the least reassuring member rather than dropping it', () => {
    const rendered = view({
      basis: { ...BASIS, evidenceLevel: 'Z', urgency: 'SOMETHING', matchConfidence: 'SOMETHING' },
    });
    // A missing evidence chip on a receipt reads as "no concerns recorded", which is the one
    // wrong direction. Falling to the weakest member overstates nothing.
    expect(rendered.basis.evidenceLabel.length).toBeGreaterThan(0);
    expect(rendered.basis.urgencyLabel.length).toBeGreaterThan(0);
    expect(rendered.basis.confidenceLabel.length).toBeGreaterThan(0);
    expect(JSON.stringify(rendered.basis)).not.toContain('SOMETHING');
  });

  it('says plainly where there is no external source', () => {
    expect(view().source.summary).toContain('does not rest on an external published source');
  });

  it('withholds a legal reference whose licence review has not cleared', () => {
    const rendered = view({
      source: {
        ...NO_SOURCE,
        organization: 'A Regulator',
        legalReference: 'REF/2026/1',
        licenseReviewState: 'NOT_REVIEWED',
      },
    });
    // DEC-073 and `BLK-005`: the reference is withheld unless the review says otherwise, and the
    // screen says it is withheld rather than leaving a gap that reads as "there is no source".
    expect(rendered.source.reference).toBeNull();
    expect(rendered.source.referenceWithheldBecause).toContain('licence review');
    expect(JSON.stringify(rendered)).not.toContain('REF/2026/1');
  });
});
