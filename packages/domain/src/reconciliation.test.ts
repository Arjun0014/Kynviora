import { describe, it, expect } from 'vitest';
import {
  DIFFERENCE_KINDS,
  FORBIDDEN_DIFFERENCE_FIELDS,
  FORBIDDEN_RESOLUTION_TOKENS,
  PROFESSIONALLY_CONFIRMED,
  RECONCILED_FIELDS,
  RECONCILIATION_RESOLUTIONS,
  canComplete,
  changesTheShelf,
  diffMedicationLists,
  evaluateResolution,
  isSettled,
  reconciliationAuditDetail,
  unresolvedDifferences,
  type Difference,
  type MedicationLine,
  type ResolutionRequest,
} from './reconciliation.js';
import { instantFrom } from './ports.js';
import { isErr, isOk } from './result.js';
import { unsafeId, type OwnedItemId, type UserId } from './ids.js';

/**
 * Medicine Reconciliation decisions.
 *
 * The Phase 8.5 exit criterion is a single sentence - "Kynviora never chooses which conflicting
 * instruction is medically correct" - and most of this file exists to make it a property of the
 * code rather than a promise about it. The negative assertions are the point: there is no field
 * to hold a winner, no vocabulary member that means the system decided, and no path from a
 * disagreement to a changed medicine that does not pass through a person.
 */

const USER = unsafeId<UserId>('11111111-1111-4111-8111-111111111111');
const ITEM = unsafeId<OwnedItemId>('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const NOW = instantFrom('2026-08-29T12:00:00.000Z');

const ACTOR = { userId: USER, now: NOW };

function line(overrides: Partial<MedicationLine> = {}): MedicationLine {
  return {
    ownedItemId: ITEM,
    matchKey: 'synthetic-tablet-a',
    displayName: 'Synthetic Tablet A',
    strengthText: '500 mg',
    dosageForm: 'tablet',
    directionsText: 'One tablet twice a day',
    ...overrides,
  };
}

function differing(): Difference {
  const [difference] = diffMedicationLists(
    [line()],
    [line({ ownedItemId: null, strengthText: '250 mg' })],
  );
  expect(difference?.kind).toBe('FIELD_DIFFERS');
  return difference as Difference;
}

function resolve(difference: Difference, request: Partial<ResolutionRequest> = {}) {
  return evaluateResolution(
    difference,
    {
      resolution: 'USER_ADOPTED_CURRENT',
      adopt: 'CURRENT',
      confirmedBy: null,
      note: null,
      ...request,
    },
    ACTOR,
  );
}

// ---------------------------------------------------------------------------

describe('Kynviora never chooses which value is correct', () => {
  it('gives a difference nowhere to hold a winner', () => {
    // The exit criterion as a type. There is no field to put the answer in, so no code path can
    // produce one.
    const [difference] = diffMedicationLists(
      [line()],
      [line({ ownedItemId: null, strengthText: '250 mg' })],
    );
    const fieldKeys = Object.keys(difference?.fields[0] ?? {});
    for (const forbidden of FORBIDDEN_DIFFERENCE_FIELDS) {
      expect(fieldKeys).not.toContain(forbidden);
      expect(Object.keys(difference ?? {})).not.toContain(forbidden);
    }
    expect(fieldKeys.sort()).toEqual(['currentValue', 'field', 'previousValue']);
  });

  it('has no resolution meaning the system decided', () => {
    // A vocabulary with such a member would make choosing sayable, which is the first step to it
    // being done.
    for (const resolution of RECONCILIATION_RESOLUTIONS) {
      for (const token of FORBIDDEN_RESOLUTION_TOKENS) {
        expect(resolution).not.toContain(token);
      }
    }
  });

  it('attributes every settled outcome to a person or a document', () => {
    const settled = RECONCILIATION_RESOLUTIONS.filter(isSettled);
    expect(settled.length).toBeGreaterThan(0);
    for (const resolution of settled) {
      expect(resolution).toMatch(/^(CONFIRMED_WITH_|CONFIRMED_FROM_|USER_)/);
    }
  });

  it('refuses to settle a difference without being told which version stands', () => {
    // Defaulting to the current list because it is newer would be Kynviora deciding which
    // instruction is correct. The person says instead.
    const result = resolve(differing(), {
      resolution: 'CONFIRMED_WITH_PHARMACIST',
      confirmedBy: 'Priya at the pharmacy',
      adopt: null,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.detail).toMatchObject({ reason_code: 'resolution_needs_a_side' });
    }
  });

  it('lets a professional confirmation land on the previous value', () => {
    // The case that makes the previous test necessary: a pharmacist may well confirm the older
    // dose. Inferring CURRENT because the new list is newer would get this exactly wrong.
    const result = resolve(differing(), {
      resolution: 'CONFIRMED_WITH_PRESCRIBER',
      confirmedBy: 'Dr Rao',
      adopt: 'PREVIOUS',
    });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      // Nothing to write: the shelf already holds the previous value.
      expect(result.value.adopt).toBeNull();
      expect(result.value.confirmedBy).toBe('Dr Rao');
    }
  });

  it('requires a professional confirmation to name the professional', () => {
    // "Confirmed with pharmacist" with nobody named is indistinguishable from a shrug, and the
    // name is what a later reader uses to weigh the record.
    for (const resolution of PROFESSIONALLY_CONFIRMED) {
      for (const confirmedBy of [null, '', '   ']) {
        const result = resolve(differing(), { resolution, confirmedBy, adopt: 'CURRENT' });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.detail).toMatchObject({
            reason_code: 'confirmation_needs_a_name',
          });
        }
      }
    }
  });

  it('refuses a resolution that contradicts the version it names', () => {
    // Otherwise the record could read "the user kept the previous value" while holding the
    // current one.
    const contradictions: readonly [ResolutionRequest['resolution'], 'PREVIOUS' | 'CURRENT'][] = [
      ['USER_KEPT_PREVIOUS', 'CURRENT'],
      ['USER_ADOPTED_CURRENT', 'PREVIOUS'],
    ];
    for (const [resolution, adopt] of contradictions) {
      const result = resolve(differing(), { resolution, adopt });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.detail).toMatchObject({
          reason_code: 'resolution_contradicts_side',
        });
      }
    }
  });

  it('does not let an unresolved difference settle on either value', () => {
    const result = resolve(differing(), { resolution: 'STILL_UNRESOLVED', adopt: 'CURRENT' });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.detail).toMatchObject({ reason_code: 'unresolved_cannot_adopt' });
    }
  });

  it('refuses to resolve a difference that does not exist', () => {
    const [same] = diffMedicationLists([line()], [line({ ownedItemId: null })]);
    expect(same?.kind).toBe('MATCHES');
    const result = resolve(same as Difference);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.detail).toMatchObject({ reason_code: 'nothing_to_resolve' });
    }
  });
});

describe('comparing two lists', () => {
  it('reports a medicine only on the previous list without saying it was stopped', () => {
    // The sharpest instance of the criterion. A medicine missing from a discharge summary may
    // have been stopped, or the summary may only cover the admission. Those have opposite
    // correct actions and the software cannot tell them apart.
    const [difference] = diffMedicationLists([line()], []);
    expect(difference?.kind).toBe('ONLY_IN_PREVIOUS');
    expect(DIFFERENCE_KINDS).not.toContain('REMOVED');
    expect(DIFFERENCE_KINDS).not.toContain('STOPPED');
    expect(DIFFERENCE_KINDS).not.toContain('DISCONTINUED');
  });

  it('reports a medicine only on the current list without calling it added', () => {
    const [difference] = diffMedicationLists([], [line({ ownedItemId: null })]);
    expect(difference?.kind).toBe('ONLY_IN_CURRENT');
    expect(DIFFERENCE_KINDS).not.toContain('ADDED');
  });

  it('reports every field that differs, and only those', () => {
    const [difference] = diffMedicationLists(
      [line()],
      [line({ ownedItemId: null, strengthText: '250 mg', directionsText: 'One tablet daily' })],
    );
    expect(difference?.kind).toBe('FIELD_DIFFERS');
    expect(difference?.fields.map((f) => f.field).sort()).toEqual(
      ['directionsText', 'strengthText'].sort(),
    );
  });

  it('carries both values for every differing field', () => {
    const [difference] = diffMedicationLists(
      [line()],
      [line({ ownedItemId: null, strengthText: '250 mg' })],
    );
    const field = difference?.fields[0];
    expect(field?.previousValue).toBe('500 mg');
    expect(field?.currentValue).toBe('250 mg');
  });

  it('reports matches rather than dropping them', () => {
    // "These fourteen are the same" is the most reassuring part of a reconciliation, and a list
    // showing only problems misrepresents the scale of what changed.
    const differences = diffMedicationLists([line()], [line({ ownedItemId: null })]);
    expect(differences).toHaveLength(1);
    expect(differences[0]?.kind).toBe('MATCHES');
    expect(differences[0]?.fields).toEqual([]);
  });

  it('treats a null and a value as a difference', () => {
    const [difference] = diffMedicationLists(
      [line({ directionsText: null })],
      [line({ ownedItemId: null, directionsText: 'One tablet daily' })],
    );
    expect(difference?.kind).toBe('FIELD_DIFFERS');
    expect(difference?.fields[0]?.previousValue).toBeNull();
  });

  it('compares directions verbatim rather than normalising them first', () => {
    // 04 Phase 4.1 forbids rewriting a prescription instruction. A reconciliation that
    // paraphrased before comparing would be comparing its own paraphrase.
    const [difference] = diffMedicationLists(
      [line({ directionsText: 'One tablet twice a day' })],
      [line({ ownedItemId: null, directionsText: 'one tablet twice a day' })],
    );
    expect(difference?.kind).toBe('FIELD_DIFFERS');
  });

  it('matches only on the supplied key, never by guessing at names', () => {
    // Deciding that two differently-named lines are the same medicine is an identity judgement
    // that belongs to the catalog layer, which has the normalization and the provenance for it.
    const differences = diffMedicationLists(
      [line({ matchKey: 'a', displayName: 'Paracetamol 500mg' })],
      [line({ ownedItemId: null, matchKey: 'b', displayName: 'Paracetamol 500 mg' })],
    );
    expect(differences.map((d) => d.kind).sort()).toEqual(
      ['ONLY_IN_CURRENT', 'ONLY_IN_PREVIOUS'].sort(),
    );
  });

  it('handles two empty lists', () => {
    expect(diffMedicationLists([], [])).toEqual([]);
  });

  it('lists every actionable difference and excludes matches', () => {
    const differences = diffMedicationLists(
      [line({ matchKey: 'a' }), line({ matchKey: 'b' })],
      [line({ ownedItemId: null, matchKey: 'a' }), line({ ownedItemId: null, matchKey: 'c' })],
    );
    expect(
      unresolvedDifferences(differences)
        .map((d) => d.kind)
        .sort(),
    ).toEqual(['ONLY_IN_CURRENT', 'ONLY_IN_PREVIOUS'].sort());
  });

  it('compares every field the vocabulary names', () => {
    // Guards against a field being added to the type and silently never compared.
    for (const field of RECONCILED_FIELDS) {
      const changed = { ...line({ ownedItemId: null }), [field]: 'something else' };
      const [difference] = diffMedicationLists([line()], [changed]);
      expect(difference?.fields.map((f) => f.field)).toContain(field);
    }
  });
});

describe('what a resolution does to the shelf', () => {
  it('changes nothing when the user keeps the previous value', () => {
    const result = resolve(differing(), { resolution: 'USER_KEPT_PREVIOUS', adopt: 'PREVIOUS' });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.adopt).toBeNull();
    expect(changesTheShelf('USER_KEPT_PREVIOUS')).toBe(false);
  });

  it('changes nothing while the difference is open', () => {
    const result = resolve(differing(), { resolution: 'STILL_UNRESOLVED', adopt: null });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.adopt).toBeNull();
    expect(changesTheShelf('STILL_UNRESOLVED')).toBe(false);
  });

  it('adopts the current value only when the person said so', () => {
    const result = resolve(differing(), { resolution: 'USER_ADOPTED_CURRENT', adopt: 'CURRENT' });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.adopt).toBe('CURRENT');
      expect(result.value.resolvedByUserId).toBe(USER);
      expect(result.value.resolvedAt).toBe(NOW);
    }
  });

  it('keeps the user note without generating one', () => {
    const result = resolve(differing(), { note: 'Pharmacist said to check at the next review.' });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.note).toBe('Pharmacist said to check at the next review.');
    }
  });
});

describe('completing a reconciliation', () => {
  it('refuses while a difference has not been looked at', () => {
    const result = canComplete([
      { kind: 'FIELD_DIFFERS', resolution: 'USER_ADOPTED_CURRENT' },
      { kind: 'ONLY_IN_PREVIOUS', resolution: null },
    ]);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.detail).toMatchObject({
        reason_code: 'differences_not_reviewed',
        remaining: 1,
      });
    }
  });

  it('allows completion with differences still unresolved, and counts them', () => {
    // 04 Phase 8.5 lists unresolved differences as expected output. Someone who cannot reach
    // their pharmacist today must be able to close the session without being pushed into a
    // decision - that is how a reconciliation produces a confidently wrong record.
    const result = canComplete([
      { kind: 'FIELD_DIFFERS', resolution: 'STILL_UNRESOLVED' },
      { kind: 'ONLY_IN_PREVIOUS', resolution: 'CONFIRMED_WITH_PHARMACIST' },
    ]);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.unresolvedCount).toBe(1);
  });

  it('ignores matches when deciding whether everything was looked at', () => {
    const result = canComplete([{ kind: 'MATCHES', resolution: null }]);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.unresolvedCount).toBe(0);
  });

  it('allows completion of a reconciliation with nothing to do', () => {
    expect(isOk(canComplete([]))).toBe(true);
  });
});

describe('audit detail', () => {
  it('records the resolution and field names but never the values', () => {
    // A medicine's directions are the most sensitive free text in the system.
    const detail = reconciliationAuditDetail({
      resolution: 'CONFIRMED_WITH_PHARMACIST',
      fields: ['directionsText', 'strengthText', 'directionsText'],
      professionallyConfirmed: true,
    });
    expect(detail.fields).toBe('directionsText,strengthText');
    expect(detail.professionally_confirmed).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('500 mg');
    expect(JSON.stringify(detail)).not.toContain('One tablet');
  });

  it('reports an unconfirmed resolution as unconfirmed', () => {
    const detail = reconciliationAuditDetail({
      resolution: 'USER_ADOPTED_CURRENT',
      fields: ['strengthText'],
      professionallyConfirmed: false,
    });
    expect(detail.professionally_confirmed).toBe(false);
  });
});
