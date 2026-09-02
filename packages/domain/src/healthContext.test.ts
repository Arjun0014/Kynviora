import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FACT_CERTAINTY,
  FACT_CERTAINTIES,
  HEALTH_FACT_KINDS,
  HEALTH_TERM_MAX,
  HOUSEHOLD_FACT_PROVENANCE,
  PROVENANCE_KINDS,
  isEmptyHealthFactChange,
  isFactCertainty,
  isHealthFactKind,
  normalizeHealthFactChange,
  normalizeHealthFactDraft,
  provenanceForRelationship,
} from './index.js';

/**
 * `04` Phase 1.3 - what a household records about a person.
 *
 * The rule everything here turns on is that provenance is never something a client sends. The
 * first exit criterion - "no OCR or inferred fact silently becomes a confirmed diagnosis" - is a
 * sentence about what cannot happen, and it is made true by the field not existing.
 */

describe('recording a reaction', () => {
  it('takes a kind and a term', () => {
    const result = normalizeHealthFactDraft({ kind: 'ALLERGY', displayTerm: '  Penicillin  ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('ALLERGY');
    expect(result.value.displayTerm).toBe('Penicillin');
    expect(result.value.notedOn).toBeNull();
  });

  it('refuses a kind rather than choosing one', () => {
    // "Allergy" and "sensitivity" are different sentences about somebody, and picking on their
    // behalf writes the wrong one onto their file.
    for (const kind of ['', '  ', 'allergy', 'INTOLERANCE', 'OTHER']) {
      const result = normalizeHealthFactDraft({ kind, displayTerm: 'Penicillin' });
      expect(result.ok, kind).toBe(false);
      if (!result.ok) {
        expect(result.error.detail?.['field'], kind).toBe('kind');
        expect(result.error.detail?.['reason_code'], kind).toBe('health_fact');
      }
    }
  });

  it('accepts every kind the vocabulary offers', () => {
    for (const kind of HEALTH_FACT_KINDS) {
      const result = normalizeHealthFactDraft({ kind, displayTerm: 'Penicillin' });
      expect(result.ok, kind).toBe(true);
    }
  });

  it('agrees with the constraint the database enforces', () => {
    // Migration `0004`'s `allergy_kind_valid` and `allergy_certainty_valid`, transcribed. A value
    // the domain offers and the database refuses is a form somebody fills in and cannot submit.
    expect([...HEALTH_FACT_KINDS]).toEqual(['ALLERGY', 'SENSITIVITY']);
    expect([...FACT_CERTAINTIES]).toEqual(['REPORTED', 'SUSPECTED', 'CONFIRMED']);
    for (const kind of ['ALLERGY', 'SENSITIVITY']) expect(isHealthFactKind(kind), kind).toBe(true);
    for (const c of ['REPORTED', 'SUSPECTED', 'CONFIRMED'])
      expect(isFactCertainty(c), c).toBe(true);
  });

  it('refuses a blank term, and names the field', () => {
    const result = normalizeHealthFactDraft({ kind: 'ALLERGY', displayTerm: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail?.['field']).toBe('displayTerm');
  });

  it('refuses a term longer than it will store', () => {
    const result = normalizeHealthFactDraft({
      kind: 'ALLERGY',
      displayTerm: 'x'.repeat(HEALTH_TERM_MAX + 1),
    });
    expect(result.ok).toBe(false);
  });

  it('keeps the term verbatim', () => {
    // `07`: what the user actually said, preserved. Kynviora does not correct a spelling, expand
    // an abbreviation or title-case anything - a term it altered is one they cannot check against
    // what they were told.
    for (const term of ['penicillin', 'PENICILLIN', 'co-codamol', 'nuts (not peanuts)']) {
      const result = normalizeHealthFactDraft({ kind: 'ALLERGY', displayTerm: term });
      expect(result.ok, term).toBe(true);
      if (result.ok) expect(result.value.displayTerm, term).toBe(term);
    }
  });

  it('refuses a date it would have to guess at, and keeps a missing one missing', () => {
    for (const date of ['June 2024', '2024-6-1', 'yesterday', '01/06/2024']) {
      const result = normalizeHealthFactDraft({
        kind: 'ALLERGY',
        displayTerm: 'Penicillin',
        notedOn: date,
      });
      expect(result.ok, date).toBe(false);
      if (!result.ok) expect(result.error.detail?.['field'], date).toBe('notedOn');
    }

    // A date somebody does not remember stays missing rather than becoming today.
    const absent = normalizeHealthFactDraft({
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
      notedOn: '   ',
    });
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value.notedOn).toBeNull();
  });
});

describe('how sure the person is', () => {
  it('defaults to the weakest of the three', () => {
    // The only safe direction. A record that defaulted to `CONFIRMED` would put a stronger claim
    // on somebody's file than they made.
    expect(DEFAULT_FACT_CERTAINTY).toBe('REPORTED');
    const result = normalizeHealthFactDraft({ kind: 'ALLERGY', displayTerm: 'Penicillin' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.certainty).toBe('REPORTED');
  });

  it('lets a person say they are certain', () => {
    // Refusing would throw away real information: somebody hospitalised for a penicillin reaction
    // knows something worth recording. What it does not do is claim a clinician said so.
    const result = normalizeHealthFactDraft({
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
      certainty: 'CONFIRMED',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.certainty).toBe('CONFIRMED');
  });

  it('refuses a certainty it does not record', () => {
    for (const certainty of ['DEFINITE', 'confirmed', 'CLINICIAN_CONFIRMED', 'MAYBE']) {
      const result = normalizeHealthFactDraft({
        kind: 'ALLERGY',
        displayTerm: 'Penicillin',
        certainty,
      });
      expect(result.ok, certainty).toBe(false);
      if (!result.ok) expect(result.error.detail?.['field'], certainty).toBe('certainty');
    }
  });
});

describe('where a fact came from', () => {
  it('is decided by who is writing, never by what they send', () => {
    // The first exit criterion as a function with two possible answers. There is no argument that
    // produces anything else, so no route has to remember to check.
    expect(provenanceForRelationship('OWNER')).toBe('USER_REPORTED');
    expect(provenanceForRelationship('CAREGIVER')).toBe('CAREGIVER_ENTERED');
  });

  it('gives an unrecognised relationship the weaker answer', () => {
    // Deny by default (`14`). `CAREGIVER_ENTERED` claims less about how directly the fact was
    // observed, and an unknown caller must not be treated as the person themselves.
    for (const relationship of ['', 'owner', 'ADMIN', 'SOMETHING_NEW', 'REVIEWER']) {
      expect(provenanceForRelationship(relationship), relationship).toBe('CAREGIVER_ENTERED');
    }
  });

  it('can never produce a claim a phone has no business making', () => {
    // `IMPORTED` needs an import path that does not exist; `REVIEWER_CONFIRMED` needs a reviewer,
    // and `BLK-006` records there is none.
    const reachable = new Set(
      ['OWNER', 'CAREGIVER', 'REVIEWER', 'IMPORTER', ''].map(provenanceForRelationship),
    );
    expect([...reachable].sort()).toEqual(['CAREGIVER_ENTERED', 'USER_REPORTED']);
    expect(reachable.has('REVIEWER_CONFIRMED')).toBe(false);
    expect(reachable.has('IMPORTED')).toBe(false);
  });

  it('is a strict subset of what the column permits', () => {
    // Widening the schema's vocabulary must not silently widen what a client can assert. The
    // column allows four; a household surface produces two.
    const inColumn = ['USER_REPORTED', 'CAREGIVER_ENTERED', 'IMPORTED', 'REVIEWER_CONFIRMED'];
    for (const provenance of HOUSEHOLD_FACT_PROVENANCE) {
      expect(inColumn, provenance).toContain(provenance);
      expect(PROVENANCE_KINDS, provenance).toContain(provenance);
    }
    expect(HOUSEHOLD_FACT_PROVENANCE.length).toBeLessThan(inColumn.length);
  });

  it('has no field on the draft that could carry one', () => {
    // The absence is the enforcement. A draft that could name its own provenance would be the
    // exit criterion defeated by a request body.
    const result = normalizeHealthFactDraft({
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
      provenance: 'REVIEWER_CONFIRMED',
      substanceId: 'some-substance',
    } as unknown as Parameters<typeof normalizeHealthFactDraft>[0]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).not.toContain('REVIEWER_CONFIRMED');
    expect(JSON.stringify(result.value)).not.toContain('some-substance');
    expect(Object.keys(result.value).sort()).toEqual([
      'certainty',
      'displayTerm',
      'kind',
      'notedOn',
    ]);
  });
});

describe('correcting a fact', () => {
  it('tells "leave it alone" apart from "empty it"', () => {
    const untouched = normalizeHealthFactChange({});
    expect(untouched.ok).toBe(true);
    if (untouched.ok) {
      expect(untouched.value.notedOn).toBeNull();
      expect(untouched.value.clearNotedOn).toBe(false);
      expect(isEmptyHealthFactChange(untouched.value)).toBe(true);
    }

    // "I do not actually remember when" is a correction somebody may need to make. Two fields
    // rather than a sentinel string, because a sentinel inside `string` is a value a person could
    // type into the date box.
    const cleared = normalizeHealthFactChange({ notedOn: '   ' });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.value.notedOn).toBeNull();
      expect(cleared.value.clearNotedOn).toBe(true);
      expect(isEmptyHealthFactChange(cleared.value)).toBe(false);
    }

    const set = normalizeHealthFactChange({ notedOn: '2024-06-01' });
    expect(set.ok).toBe(true);
    if (set.ok) {
      expect(set.value.notedOn).toBe('2024-06-01');
      expect(set.value.clearNotedOn).toBe(false);
    }
  });

  it('refuses to blank the term rather than reading it as a clearing', () => {
    // The column is `NOT NULL`, and a fact with no term is a row nobody can act on.
    const result = normalizeHealthFactChange({ displayTerm: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail?.['field']).toBe('displayTerm');
  });

  it('refuses a certainty it does not record', () => {
    const result = normalizeHealthFactChange({ certainty: 'DEFINITE' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail?.['field']).toBe('certainty');
  });

  it('refuses a date it would have to guess at', () => {
    const result = normalizeHealthFactChange({ notedOn: 'June 2024' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail?.['field']).toBe('notedOn');
  });

  it('does not treat an edit as a review unless somebody said so', () => {
    // Setting the review date on every edit would make correcting a typo look like a review, and
    // a review date Kynviora inferred is the "silently becomes" the exit criterion is about, one
    // level up from the fact itself.
    const typo = normalizeHealthFactChange({ displayTerm: 'Penicillin' });
    expect(typo.ok).toBe(true);
    if (typo.ok) expect(typo.value.markReviewed).toBe(false);

    const reviewed = normalizeHealthFactChange({ markReviewed: true });
    expect(reviewed.ok).toBe(true);
    if (reviewed.ok) {
      expect(reviewed.value.markReviewed).toBe(true);
      // A review on its own is a real change, so it is not an empty one.
      expect(isEmptyHealthFactChange(reviewed.value)).toBe(false);
    }
  });

  it('treats a review claim that is not the exact boolean as no claim', () => {
    const truthy = normalizeHealthFactChange({
      markReviewed: 'yes' as unknown as boolean,
    });
    expect(truthy.ok).toBe(true);
    if (truthy.ok) expect(truthy.value.markReviewed).toBe(false);
  });

  it('has no field that could change where a fact came from', () => {
    // Correcting the wording of a fact does not change its provenance. A person who could edit it
    // into `REVIEWER_CONFIRMED` would have found the way round the exit criterion the create path
    // closes.
    const result = normalizeHealthFactChange({
      displayTerm: 'Penicillin',
      provenance: 'REVIEWER_CONFIRMED',
    } as unknown as Parameters<typeof normalizeHealthFactChange>[0]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.value)).not.toContain('REVIEWER_CONFIRMED');
  });
});
