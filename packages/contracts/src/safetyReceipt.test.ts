import { describe, it, expect } from 'vitest';
import { SAFETY_RESOLUTIONS } from '@kynviora/domain';
import { safetyReceiptScreenView } from './views.js';
import type { SafetyReceiptResponse } from './client.js';

/**
 * The client half of Phase 7.6.
 *
 * The server composed every sentence, so almost everything here is a pass-through and the tests
 * are about the two things the client decides for itself: which control to withhold, and what to
 * do with a count the server sent and no wording for.
 */

const NOW = '2026-09-01T12:00:00.000Z';
const LATER = '2026-09-02T12:00:00.000Z';

function receipt(overrides: Partial<SafetyReceiptResponse> = {}): SafetyReceiptResponse {
  return {
    alertPublicationId: 'a1',
    assessmentId: 'as1',
    currentResolution: null,
    current: null,
    undescribedResolutionNote: null,
    history: [],
    undescribedHistoryCount: 0,
    basis: {
      heading: 'What this was based on',
      assessedOn: NOW,
      alertRaisedOn: NOW,
      rule: 'expiry.default version 1.2.0',
      ruleUnavailableNote: null,
      ruleVersionId: 'rv1',
      regulatoryRuleVersionId: null,
      evidenceLabel: 'Regulator published',
      evidenceDescription: 'A regulator published this.',
      urgencyLabel: 'Act soon',
      confidenceLabel: 'Exact match',
      confidenceDescription: 'This is your product.',
      normalizationVersion: 'norm-1',
      note: 'These do not change when you record what you did.',
    },
    source: {
      organization: null,
      sourceName: null,
      jurisdiction: null,
      reference: null,
      referenceWithheldBecause: null,
      publishedOn: null,
      effectiveFrom: null,
      attribution: null,
      summary: 'This alert does not rest on an external published source.',
    },
    corrections: [],
    correctedSinceNotice: null,
    uncertainties: [],
    uncertaintyCodes: [],
    emptyMessage: 'You have not recorded anything about this alert.',
    permanenceNote: 'Anything you record here is kept.',
    serverTime: NOW,
    ...overrides,
  };
}

describe('the controls the screen offers', () => {
  it('offers every resolution where nothing stands', () => {
    const view = safetyReceiptScreenView(receipt());
    const offered = [...view.actionOptions, ...view.feedbackOptions].map((o) => o.resolution);
    expect([...offered].sort()).toEqual([...SAFETY_RESOLUTIONS].sort());
  });

  it('splits actions from feedback rather than mixing them', () => {
    const view = safetyReceiptScreenView(receipt());
    // "I disposed of it" and "this is not my product" answer different questions, and a single
    // list implies they answer one.
    expect(view.actionOptions.map((o) => o.resolution)).toEqual([
      'REVIEWED',
      'NOT_APPLICABLE',
      'RETURNED_OR_DISPOSED',
      'QUARANTINED',
      'DISCUSSED_WITH_PROFESSIONAL',
    ]);
    expect(view.feedbackOptions.map((o) => o.resolution)).toEqual([
      'ITEM_IDENTITY_CORRECTED',
      'REPORTED_INCORRECT_MATCH',
    ]);
    expect(view.actionOptions.every((o) => !o.isFeedback)).toBe(true);
    expect(view.feedbackOptions.every((o) => o.isFeedback)).toBe(true);
  });

  it('withholds the one that currently stands, and nothing else', () => {
    const view = safetyReceiptScreenView(receipt({ currentResolution: 'QUARANTINED' }));
    const offered = [...view.actionOptions, ...view.feedbackOptions].map((o) => o.resolution);
    // Choosing it again writes nothing, and a control that does nothing reads as one that failed.
    expect(offered).not.toContain('QUARANTINED');
    expect(offered).toHaveLength(SAFETY_RESOLUTIONS.length - 1);
  });

  it('withholds nothing for a resolution code it does not recognise', () => {
    const view = safetyReceiptScreenView(receipt({ currentResolution: 'SOMETHING_NEW' }));
    const offered = [...view.actionOptions, ...view.feedbackOptions];
    // A build that guessed which control to hide from an unknown code could hide the wrong one,
    // and the server already said the record is kept. Offering all seven is the safe direction.
    expect(offered).toHaveLength(SAFETY_RESOLUTIONS.length);
  });

  it('marks no control as recommended, default or primary', () => {
    const view = safetyReceiptScreenView(receipt());
    for (const option of [...view.actionOptions, ...view.feedbackOptions]) {
      for (const forbidden of ['recommended', 'default', 'primary', 'selected']) {
        expect(Object.keys(option)).not.toContain(forbidden);
      }
    }
  });
});

describe('what the screen passes through', () => {
  it('does not rewrite a single sentence the server sent', () => {
    const response = receipt({
      currentResolution: 'REVIEWED',
      current: {
        label: 'I have read this',
        description: 'Records that you read the alert.',
        recordedAt: NOW,
        note: 'a sentence about a medicine',
      },
      correctedSinceNotice: 'Kynviora corrected something after you recorded what you did.',
      uncertainties: ['Kynviora was not certain this alert is about the exact pack you have.'],
      corrections: [
        {
          heading: 'Kynviora corrected the rule behind this',
          reason: 'The rule matched on the wrong identifier.',
          recordedAt: LATER,
          reviewerId: null,
        },
      ],
    });
    const view = safetyReceiptScreenView(response);
    // `11` puts safety composition on the server so approved wording is not carried in every
    // shipped build. A client that rewrote any of this would be carrying it.
    expect(view.current).toEqual(response.current);
    expect(view.correctedSinceNotice).toBe(response.correctedSinceNotice);
    expect(view.uncertainties).toEqual(response.uncertainties);
    expect(view.corrections).toEqual(response.corrections);
    expect(view.permanenceNote).toBe(response.permanenceNote);
    expect(view.emptyMessage).toBe(response.emptyMessage);
    expect(view.basis).toEqual(response.basis);
  });

  it('counts history rows the server had no wording for rather than hiding them', () => {
    const view = safetyReceiptScreenView(
      receipt({
        history: [{ label: 'I have read this', recordedAt: NOW, replacedPreviousNote: null }],
        undescribedHistoryCount: 2,
      }),
    );
    expect(view.history).toHaveLength(1);
    expect(view.undescribedHistoryNote).toContain('2 further records');
    expect(view.undescribedHistoryNote).toContain('still kept');
  });

  it('says nothing about undescribed history when there is none', () => {
    expect(safetyReceiptScreenView(receipt()).undescribedHistoryNote).toBeNull();
  });

  it('uses the singular for one', () => {
    const view = safetyReceiptScreenView(receipt({ undescribedHistoryCount: 1 }));
    expect(view.undescribedHistoryNote).toContain('1 further record ');
  });

  it('carries no user identifier anywhere', () => {
    const view = safetyReceiptScreenView(
      receipt({
        currentResolution: 'REVIEWED',
        history: [{ label: 'I have read this', recordedAt: NOW, replacedPreviousNote: null }],
      }),
    );
    // DEC-076. The server sends none; this asserts the client does not invent one.
    for (const forbidden of ['userId', 'actor', 'recordedBy', 'resolvedBy']) {
      expect(JSON.stringify(view)).not.toContain(forbidden);
    }
  });

  it('has no completion, progress or resolved state', () => {
    const view = safetyReceiptScreenView(receipt({ currentResolution: 'REVIEWED' }));
    for (const forbidden of ['resolved', 'complete', 'progress', 'score', 'handled', 'closed']) {
      expect(Object.keys(view)).not.toContain(forbidden);
    }
  });
});
