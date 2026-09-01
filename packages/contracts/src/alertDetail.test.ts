import { describe, it, expect } from 'vitest';
import { FACT_BASES } from '@kynviora/presentation';
import {
  KNOWN_FACT_BASES,
  alertDetailScreenView,
  asStatusPresentation,
  safetyInboxView,
} from './views.js';
import type { AlertDetailResponse, StatusPresentationResponse } from './client.js';

/**
 * The client half of Phase 7.3.
 *
 * The server composed the message, so almost everything here is a pass-through and the tests are
 * about the one thing a client must decide for itself: what to do with a value it does not
 * recognise. On this screen that question has teeth, because the screen's whole claim is that
 * every line says where it came from.
 */

const PRESENTATION: StatusPresentationResponse = {
  label: 'Act soon',
  iconName: 'alert-triangle',
  tone: 'warning',
  description: 'Something to deal with in the next day or so.',
  accessibilityLabel: 'Urgency: act soon.',
};

function detail(overrides: Partial<AlertDetailResponse> = {}): AlertDetailResponse {
  return {
    alertPublicationId: 'a1',
    profileId: 'p1',
    ownedItemId: 'i1',
    isLive: true,
    withdrawnNotice: null,
    message: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'],
    unexplainable: null,
    withheldNotice: null,
    urgency: PRESENTATION,
    evidence: PRESENTATION,
    matchConfidence: PRESENTATION,
    facts: [
      { label: 'Person', value: 'Parent A', basis: 'RECORDED_BY_A_PERSON', basisText: 'You did.' },
      {
        label: 'How exact the match is',
        value: 'Exact',
        basis: 'COMPUTED_BY_KYNVIORA',
        basisText: 'Kynviora worked this out.',
      },
    ],
    reasons: { reasons: ['a reason'], undescribedCount: 0, undescribedNote: null },
    source: {
      organization: 'Synthetic Authority',
      sourceName: 'Register',
      jurisdiction: 'GB',
      reference: null,
      referenceWithheldBecause: 'Licence review is incomplete (BLK-005).',
      publishedOn: '2026-08-01',
      effectiveFrom: null,
      attribution: null,
      summary: 'Synthetic Authority, Register, GB, published 2026-08-01',
    },
    coverageStatement: 'Kynviora currently monitors sources for GB.',
    inferredCount: 1,
    basisNote: 'Every line above says where it came from.',
    actions: [{ action: 'REPORT_INCORRECT_MATCH', label: 'Not my product', explanation: 'x' }],
    actionsUnavailableBecause: null,
    publishedAt: '2026-09-01T09:00:00.000Z',
    serverTime: '2026-09-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('the bases this client knows', () => {
  it('matches the presentation layer exactly', () => {
    // Mirrored rather than imported so a wire value is a case with a decision. Mirrored lists
    // drift, which is what this test is for.
    expect([...KNOWN_FACT_BASES].sort()).toEqual([...FACT_BASES].sort());
  });
});

describe('a fact this build cannot label', () => {
  it('is dropped and counted rather than shown without an origin', () => {
    // The screen's whole claim is that every line says where it came from. A line with an
    // unlabelled origin defeats that more thoroughly than an omission the screen admits to.
    const view = alertDetailScreenView(
      detail({
        facts: [
          { label: 'Person', value: 'Parent A', basis: 'RECORDED_BY_A_PERSON', basisText: 'x' },
          { label: 'Something', value: 'v', basis: 'SOMETHING_NEW', basisText: 'y' },
        ],
      }),
    );
    expect(view.facts).toHaveLength(1);
    expect(view.unlabelledFactCount).toBe(1);
    expect(view.unlabelledFactNote).toContain('1 further detail');
  });

  it('says nothing when every fact is labelled', () => {
    const view = alertDetailScreenView(detail());
    expect(view.unlabelledFactCount).toBe(0);
    expect(view.unlabelledFactNote).toBeNull();
  });
});

describe('a status presentation from the wire', () => {
  it('passes a complete one through', () => {
    expect(asStatusPresentation(PRESENTATION)?.label).toBe('Act soon');
  });

  it('refuses one with no label', () => {
    // `18` makes the text label the primary carrier of meaning. A chip with a blank label beside
    // a medicine reads as a state somebody assigned rather than as a gap.
    expect(asStatusPresentation({ ...PRESENTATION, label: '' })).toBeNull();
    expect(asStatusPresentation({ ...PRESENTATION, label: '   ' })).toBeNull();
  });

  it('refuses one with no description or no accessibility label', () => {
    expect(asStatusPresentation({ ...PRESENTATION, description: '' })).toBeNull();
    expect(asStatusPresentation({ ...PRESENTATION, accessibilityLabel: '' })).toBeNull();
  });

  it('refuses an icon name this build does not have', () => {
    // Meaning must not rest on colour alone, so an unknown icon leaves the chip unrenderable.
    expect(asStatusPresentation({ ...PRESENTATION, iconName: 'nonesuch' })).toBeNull();
  });

  it('refuses an absent one rather than inventing a default', () => {
    expect(asStatusPresentation(null)).toBeNull();
    expect(asStatusPresentation(undefined)).toBeNull();
  });
});

describe('the detail a screen renders', () => {
  it('keeps urgency, evidence and confidence separate', () => {
    const view = alertDetailScreenView(detail());
    expect(view.urgency).not.toBeNull();
    expect(view.evidence).not.toBeNull();
    expect(view.matchConfidence).not.toBeNull();
    const keys = Object.keys(view);
    expect(keys).not.toContain('severity');
    expect(keys).not.toContain('score');
  });

  it('carries the withheld-reference explanation rather than dropping the source', () => {
    const view = alertDetailScreenView(detail());
    expect(view.source.reference).toBeNull();
    expect(view.source.referenceWithheldBecause).toContain('BLK-005');
    expect(view.source.summary).toContain('Synthetic Authority');
  });

  it('passes the eight approved parts through untouched', () => {
    // The client composes nothing: `11` puts safety composition on the server, and rebuilding any
    // of it here would carry approved wording in every shipped build.
    const view = alertDetailScreenView(detail());
    expect(view.message).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
  });

  it('carries the withdrawn notice when the server sent one', () => {
    const view = alertDetailScreenView(
      detail({ isLive: false, withdrawnNotice: 'Withdrawn. Do not act on it.', actions: [] }),
    );
    expect(view.isLive).toBe(false);
    expect(view.withdrawnNotice).toContain('Do not act on it');
    expect(view.actions).toEqual([]);
  });
});

describe('the inbox line that opens it', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    ownedItemId: 'i1',
    displayName: 'Synthetic Tablet A',
    alertPublicationId: null,
    state: 'INSUFFICIENT_DATA',
    urgency: null,
    evidenceLevel: null,
    lastAssessedAt: null,
    substances: [],
    ...over,
  });

  it('carries the alert identifier where there is a live alert', () => {
    const view = safetyInboxView({ lines: [line({ alertPublicationId: 'a1' })], totalItems: 1 });
    expect(view.lines[0]?.alertPublicationId).toBe('a1');
  });

  it('carries null where there is not, so the control is absent rather than disabled', () => {
    // DEC-045: a disabled control states that an explanation exists and is being withheld.
    const view = safetyInboxView({ lines: [line()], totalItems: 1 });
    expect(view.lines[0]?.alertPublicationId).toBeNull();
  });
});
