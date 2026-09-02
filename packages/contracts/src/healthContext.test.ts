import { describe, it, expect } from 'vitest';
import { healthContextView, healthFactRowView } from './healthContext.js';
import type { HealthFactLine, HealthFactsResponse } from './client.js';

/**
 * `04` Phase 1.3's client half.
 *
 * Every sentence arrives composed. What this layer decides is whether a record can drive a safety
 * check - and the wrong answer there is a person believing Kynviora is watching something it
 * cannot see.
 */

function line(overrides: Partial<HealthFactLine> = {}): HealthFactLine {
  return {
    id: 'f1',
    kind: 'ALLERGY',
    displayTerm: 'Penicillin',
    provenance: 'USER_REPORTED',
    certainty: 'CONFIRMED',
    notedOn: '2019-04-02',
    lastReviewedAt: null,
    version: 1,
    matchesCanonicalSubstance: false,
    ...overrides,
  };
}

function response(facts: readonly HealthFactLine[]): HealthFactsResponse {
  return { profileId: 'p1', facts, serverTime: '2026-09-02T12:00:00.000Z' };
}

describe('one recorded reaction', () => {
  it('renders every value as a phrase', () => {
    const row = healthFactRowView(line());
    expect(row.displayTerm).toBe('Penicillin');
    expect(row.kindLabel).toBe('Allergy');
    expect(row.certaintyLabel).toBe('I am sure');
    expect(row.provenanceLabel).toBe('You recorded this');
  });

  it('drops a value it cannot read rather than rendering its code', () => {
    // Trap 129: a code beside somebody's allergy is a field value, not a phrase.
    const row = healthFactRowView(
      line({ kind: 'INTOLERANCE', certainty: 'DEFINITE', provenance: 'PACKAGE_OCR' }),
    );
    expect(row.kindLabel).toBeNull();
    expect(row.certaintyLabel).toBeNull();
    expect(row.provenanceLabel).toBeNull();
    expect(JSON.stringify(row)).not.toContain('INTOLERANCE');
    expect(JSON.stringify(row)).not.toContain('PACKAGE_OCR');
  });

  it('never drops the term', () => {
    // The one field the person wrote. A row without it is a record they cannot find again.
    const row = healthFactRowView(line({ kind: 'INTOLERANCE', provenance: 'SOMETHING_NEW' }));
    expect(row.displayTerm).toBe('Penicillin');
  });

  it('says Kynviora cannot check an unmatched term, and that it is not lost', () => {
    // `10`, and the common case: nothing in this build maps a typed term to a substance, so this
    // is the sentence most records carry.
    const row = healthFactRowView(line({ matchesCanonicalSubstance: false }));
    expect(row.matchNote).toMatch(/cannot check/i);
    expect(row.matchNote).toMatch(/not lost/i);
  });

  it('says plainly when it can', () => {
    const row = healthFactRowView(line({ matchesCanonicalSubstance: true }));
    expect(row.matchNote).toMatch(/can check/i);
  });

  it('assumes it cannot where the server did not say', () => {
    // The pessimistic reading is the safe one: telling somebody a record is not being checked when
    // it is costs a moment's confusion, and the opposite is a promise the build does not keep.
    for (const value of [undefined, null, 'yes', 1]) {
      const row = healthFactRowView(
        line({
          matchesCanonicalSubstance:
            value as unknown as HealthFactLine['matchesCanonicalSubstance'],
        }),
      );
      expect(row.matchesCanonicalSubstance, String(value)).toBe(false);
      expect(row.matchNote, String(value)).toMatch(/cannot check/i);
    }
  });

  it('says nobody has checked a record, until somebody has', () => {
    // A fact, not a nag (`02`).
    expect(healthFactRowView(line({ lastReviewedAt: null })).reviewNote).toMatch(
      /nobody has checked/i,
    );
    expect(
      healthFactRowView(line({ lastReviewedAt: '2026-09-02T12:00:00.000Z' })).reviewNote,
    ).toBeNull();
  });

  it('carries the version, so an edit can be conditional on it', () => {
    expect(healthFactRowView(line({ version: 4 })).version).toBe(4);
    // A version this build cannot read becomes 0, which the server will refuse as a conflict
    // rather than accept as an edit against an unknown state.
    expect(healthFactRowView(line({ version: 'four' as unknown as number })).version).toBe(0);
  });
});

describe('the whole list', () => {
  it('tells an empty list from a full one', () => {
    expect(healthContextView(response([])).isEmpty).toBe(true);
    expect(healthContextView(response([line()])).isEmpty).toBe(false);
  });

  it('drops a row with no term rather than rendering it', () => {
    // A row without a term is a control that opens an editor for a record nobody can identify.
    const view = healthContextView(
      response([
        line(),
        line({ id: 'f2', displayTerm: '   ' }),
        line({ id: 'f3', displayTerm: 42 as unknown as string }),
      ]),
    );
    expect(view.rows).toHaveLength(1);
  });

  it('counts what Kynviora cannot check anything against', () => {
    // The answer to "why have I not heard anything", which a person should not have to get by
    // counting rows. Not a warning and not a badge (`02`).
    const view = healthContextView(
      response([
        line({ id: 'f1', matchesCanonicalSubstance: false }),
        line({ id: 'f2', matchesCanonicalSubstance: true }),
        line({ id: 'f3', matchesCanonicalSubstance: false }),
      ]),
    );
    expect(view.unmatchedCount).toBe(2);
  });

  it('survives a response that carries no facts at all', () => {
    const view = healthContextView({
      profileId: 'p1',
      facts: undefined as unknown as readonly HealthFactLine[],
      serverTime: '2026-09-02T12:00:00.000Z',
    });
    expect(view.rows).toEqual([]);
    expect(view.isEmpty).toBe(true);
    expect(view.unmatchedCount).toBe(0);
  });
});

describe('which of the three sentences a row carries (04 Phase 5.2)', () => {
  it('says Kynviora can check a matched record', () => {
    const row = healthFactRowView(
      line({ matchesCanonicalSubstance: true, substanceMappingState: 'EXACT' }),
    );
    expect(row.matchNote).toMatch(/can check/i);
    expect(row.isAmbiguous).toBe(false);
  });

  it('says a term meaning several things was deliberately not matched to any', () => {
    const row = healthFactRowView(
      line({ matchesCanonicalSubstance: false, substanceMappingState: 'AMBIGUOUS' }),
    );
    expect(row.isAmbiguous).toBe(true);
    expect(row.matchNote).toMatch(/more than one thing/i);
    expect(row.matchNote).toMatch(/more precisely/i);
  });

  it('keeps the plain unmatched sentence for a term nothing knows', () => {
    const row = healthFactRowView(
      line({ matchesCanonicalSubstance: false, substanceMappingState: 'UNRESOLVED' }),
    );
    expect(row.isAmbiguous).toBe(false);
    expect(row.matchNote).toMatch(/has not matched/i);
  });

  it('falls to the sentence that promises least where the server said nothing it can read', () => {
    for (const state of [undefined, null, '', 'SOMETHING_NEW', 'ambiguous']) {
      const row = healthFactRowView(
        line({
          matchesCanonicalSubstance: false,
          substanceMappingState: state as unknown as string,
        }),
      );
      expect(row.isAmbiguous, String(state)).toBe(false);
      expect(row.matchNote, String(state)).toMatch(/has not matched/i);
    }
  });

  it('never calls a matched record ambiguous, whatever the state says', () => {
    // A row carrying both would be describing a substance it also says it could not choose
    // between. The boolean is what decides whether a rule can see it, and it wins.
    const row = healthFactRowView(
      line({ matchesCanonicalSubstance: true, substanceMappingState: 'AMBIGUOUS' }),
    );
    expect(row.isAmbiguous).toBe(false);
    expect(row.matchNote).toMatch(/can check/i);
  });
});
