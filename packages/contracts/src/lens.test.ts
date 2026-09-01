import { describe, it, expect } from 'vitest';
import * as lens from './lens.js';
import { LENS_NO_STATUS, asApplicability, lensView } from './lens.js';
import type { LensEntryResponse, LensSnapshotResponse } from './client.js';
import { REGULATORY_APPLICABILITIES, REGULATORY_STATUSES } from '@kynviora/domain';
import { UNRESOLVED_CONDITION_COPY, findForbiddenClaims } from '@kynviora/presentation';

/**
 * Phase 7.2's UI half.
 *
 * The projection and its four hard guarantees are tested in `@kynviora/regulatory`. What is worth
 * asserting here is what survives the trip to a screen: that several statuses stay several, that
 * an absence still carries its coverage statement, that a scientific opinion is not filed under
 * law, and that nothing anywhere ranks one jurisdiction against another.
 */

const entry = (over: Partial<LensEntryResponse> = {}): LensEntryResponse => ({
  jurisdiction: 'GB',
  statuses: ['RESTRICTED'],
  applicability: 'APPLIES',
  conditions: null,
  unresolvedConditions: [],
  authority: 'Synthetic Authority',
  legalInstrument: 'Synthetic Regulation',
  legalReference: 'Annex II entry 1',
  publicationDate: '2026-01-01',
  effectiveDate: '2026-02-01',
  lastVerifiedAt: '2026-08-30T00:00:00.000Z',
  coverageStatement: 'Synthetic coverage for tests.',
  limitations: ['This covers the listed uses only.'],
  scientificOpinions: [],
  productActions: [],
  ruleVersionId: 'r1',
  ...over,
});

const snapshot = (entries: readonly LensEntryResponse[]): LensSnapshotResponse => ({
  substanceCanonicalKey: 'substance.synthetic',
  entries,
  generatedAt: '2026-09-01T00:00:00.000Z',
  unmonitoredJurisdictions: [],
});

describe('several statuses stay several', () => {
  it('renders one presentation per status, never a combined verdict', () => {
    // `07` forbids collapsing several applicable statuses into one, and a screen handed a single
    // string could not have shown two.
    const view = lensView(
      snapshot([entry({ statuses: ['RESTRICTED', 'CONCENTRATION_LIMIT', 'WARNING_REQUIRED'] })]),
    );
    expect(view.cards[0]?.statuses).toHaveLength(3);
    const labels = view.cards[0]?.statuses.map((s) => s.label) ?? [];
    expect(new Set(labels).size).toBe(3);
  });

  it('gives every status a label and an icon, not a tone alone', () => {
    // `18` forbids meaning through colour alone, and a regulatory status is the worst place to
    // rely on one.
    for (const status of REGULATORY_STATUSES) {
      const view = lensView(snapshot([entry({ statuses: [status] })]));
      const presentation = view.cards[0]?.statuses[0];
      expect(presentation?.label.length).toBeGreaterThan(0);
      expect(presentation?.iconName.length).toBeGreaterThan(0);
    }
  });

  it('drops a status it cannot describe and counts it', () => {
    // The presentation layer holds one description per status and no default. Rendering an
    // unknown one would put a legal claim on screen that nobody wrote.
    const view = lensView(snapshot([entry({ statuses: ['RESTRICTED', 'NEWLY_INVENTED'] })]));
    expect(view.cards[0]?.statuses).toHaveLength(1);
    expect(view.cards[0]?.undescribedStatuses).toBe(1);
  });

  it('says so where it can describe none of them', () => {
    // `09`: an absence is not approval. An empty card reads as "fine here", which is `23` D-014
    // drawn as an empty box.
    const view = lensView(snapshot([entry({ statuses: [] })]));
    expect(view.cards[0]?.noStatusNote).toBe(LENS_NO_STATUS);
    expect(LENS_NO_STATUS).toMatch(/not the same as/i);
  });

  it('has no note where there is something to show', () => {
    expect(lensView(snapshot([entry()])).cards[0]?.noStatusNote).toBeNull();
  });
});

describe('status and applicability stay two axes', () => {
  it('carries an applicability presentation on every card', () => {
    // DEC-007. There is no EXCEEDS_LIMIT or NON_COMPLIANT outcome anywhere, and the way that
    // stays true is that "does the rule bite" is answered separately from "what does it say".
    const view = lensView(snapshot([entry({ applicability: 'CONDITION_UNKNOWN' })]));
    expect(view.cards[0]?.applicability.label.length).toBeGreaterThan(0);
  });

  it('reads an unknown applicability as identity uncertain, never as "does not apply"', () => {
    // Deny by default applied to a claim about the law: a value this client cannot read is not
    // evidence that the rule fails to bite.
    expect(asApplicability('SOMETHING_NEWER')).toBe('IDENTITY_UNCERTAIN');
    expect(asApplicability('')).toBe('IDENTITY_UNCERTAIN');
    for (const applicability of REGULATORY_APPLICABILITIES) {
      expect(asApplicability(applicability)).toBe(applicability);
    }
  });
});

describe('what the package did not say', () => {
  it('names the actual missing datum', () => {
    // `09`: a rule with both a concentration limit and an age condition must not report "the
    // concentration is not disclosed" when the concentration is printed and the age is unknown.
    const view = lensView(
      snapshot([
        entry({ applicability: 'CONDITION_UNKNOWN', unresolvedConditions: ['INTENDED_AGE'] }),
      ]),
    );
    expect(view.cards[0]?.unresolved).toEqual([
      { condition: 'INTENDED_AGE', explanation: UNRESOLVED_CONDITION_COPY['INTENDED_AGE'] },
    ]);
  });

  it('drops a condition it has no sentence for rather than showing a code', () => {
    // "CONCENTRATION" on a screen tells a person nothing, and a generic "some information is
    // missing" reads as a complete answer when it is not.
    const view = lensView(
      snapshot([entry({ unresolvedConditions: ['CONCENTRATION', 'SOMETHING_NEW'] })]),
    );
    expect(view.cards[0]?.unresolved.map((u) => u.condition)).toEqual(['CONCENTRATION']);
  });

  it('says nothing about a condition where every one resolved', () => {
    expect(lensView(snapshot([entry()])).cards[0]?.unresolved).toEqual([]);
  });
});

describe('what accompanies every card', () => {
  it('carries the coverage statement and the limitations through unchanged', () => {
    // `09` requires both. Neither is derived here, because a limitation a client paraphrased is a
    // limitation nobody approved.
    const view = lensView(
      snapshot([entry({ limitations: ['A', 'B'], coverageStatement: 'Covers X only.' })]),
    );
    expect(view.cards[0]?.limitations).toEqual(['A', 'B']);
    expect(view.cards[0]?.coverageStatement).toBe('Covers X only.');
  });

  it('keeps a scientific opinion out of the statuses', () => {
    // `09`: an opinion "is not itself the legal status". Filed under its own heading, with
    // whether any law implements it stated rather than implied.
    const view = lensView(
      snapshot([
        entry({
          statuses: [],
          scientificOpinions: [
            {
              committee: 'Synthetic Committee',
              reference: 'op-1',
              summary: 'A synthetic opinion.',
              publicationDate: '2026-03-01',
              hasImplementingLaw: false,
            },
          ],
        }),
      ]),
    );
    expect(view.cards[0]?.statuses).toEqual([]);
    expect(view.cards[0]?.scientificOpinions[0]?.hasImplementingLaw).toBe(false);
  });

  it('reports an unmonitored jurisdiction rather than omitting it', () => {
    // A jurisdiction silently missing from a list of six reads as "nothing to say there", which
    // is absence-as-approval with a map instead of a label.
    const view = lensView({ ...snapshot([entry()]), unmonitoredJurisdictions: ['JP', 'US'] });
    expect(view.unmonitoredJurisdictions).toEqual(['JP', 'US']);
  });
});

describe('no jurisdiction is ranked against another', () => {
  it('keeps the order the projection produced', () => {
    // `09` forbids "strict country" and "weak regulation" framing, and sorting by how prohibitive
    // each answer is would be that ranking expressed as a list.
    const view = lensView(
      snapshot([
        entry({ jurisdiction: 'GB', statuses: ['NO_MATCHED_RULE_WITHIN_COVERAGE'] }),
        entry({ jurisdiction: 'EU', statuses: ['PROHIBITED'] }),
        entry({ jurisdiction: 'IN', statuses: ['RESTRICTED'] }),
      ]),
    );
    expect(view.cards.map((c) => c.jurisdiction)).toEqual(['GB', 'EU', 'IN']);
  });

  it('exports nothing that would compare or rank two jurisdictions', () => {
    const functions = Object.entries(lens)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    expect(
      functions.filter((n) => /rank|compare|worst|strict|severity|score|sort/i.test(n)),
    ).toEqual([]);
  });

  it('puts no overall verdict on the view', () => {
    const view = lensView(snapshot([entry()]));
    expect(Object.keys(view).sort()).toEqual([
      'cards',
      'generatedAt',
      'substanceCanonicalKey',
      'unmonitoredJurisdictions',
    ]);
  });
});

describe('the words this module ships', () => {
  it('contains no forbidden claim', () => {
    for (const text of [LENS_NO_STATUS, ...Object.values(UNRESOLVED_CONDITION_COPY)]) {
      expect(findForbiddenClaims(text)).toEqual([]);
    }
  });

  it('never ranks a jurisdiction in its own copy', () => {
    // `09`: "avoid value judgments such as 'strict country' or 'weak regulation'".
    for (const text of [LENS_NO_STATUS, ...Object.values(UNRESOLVED_CONDITION_COPY)]) {
      expect(text).not.toMatch(/\b(strict|lenient|weak|lax|tough)\b/i);
    }
  });
});
