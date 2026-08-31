import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VISIT_PACK_TTL_HOURS,
  MAX_VISIT_PACK_ENTRIES,
  MAX_VISIT_PACK_TTL_HOURS,
  VISIT_PACK_LIMITATION,
  VISIT_PACK_SECTIONS,
  canonicalizeSelection,
  digestSelection,
  evaluateGeneration,
  factCaveat,
  isVisitPackRetrievable,
  itemCaveat,
  ownedItemIdsIn,
  renderVisitPack,
  visitPackAuditDetail,
  visitPackExpiryFor,
  type ContentDigest,
  type GenerationRequest,
  type VisitPackEntry,
} from './visitPack.js';
import { instantFrom, type Instant } from './ports.js';
import { isErr, isOk } from './result.js';
import { unsafeId, type ProfileId, type UserId, type VisitPackId } from './ids.js';
import { ITEM_VERIFICATIONS, PROVENANCE_KINDS } from './vocabulary.js';

/**
 * Visit Pack generation decisions.
 *
 * The two Phase 8.4 exit criteria are properties of this module: export never happens
 * automatically, and a user can review exactly what will be shared. Both are asserted here
 * against the decision function, and again in the API suite against the live flow.
 */

const PROFILE = unsafeId<ProfileId>('44444444-4444-4444-8444-444444444444');
const USER = unsafeId<UserId>('11111111-1111-4111-8111-111111111111');
const PACK = unsafeId<VisitPackId>('77777777-7777-4777-8777-777777777777');

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

/**
 * A deterministic stand-in for SHA-256.
 *
 * Injected rather than imported so the domain stays free of a crypto dependency, and so these
 * tests assert the *decision*, not the hash. Collision behaviour is not under test here; the API
 * suite exercises the real digest.
 */
function testDigest(): ContentDigest {
  return {
    of: (canonical: string) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < canonical.length; i += 1) {
        h ^= canonical.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16).padStart(64, '0');
    },
  };
}

const digest = testDigest();

function entry(overrides: Partial<VisitPackEntry> = {}): VisitPackEntry {
  return {
    section: 'CURRENT_MEDICINES',
    entityKind: 'owned_item',
    entityId: 'item-a',
    version: 1,
    lines: ['Synthetic Tablet, 500 mg'],
    caveat: 'Entered by hand and not checked against the package.',
    ...overrides,
  };
}

const ITEM_A = entry({ entityId: 'item-a' });
const ITEM_B = entry({ entityId: 'item-b', lines: ['Other Tablet, 250 mg'] });
const ALLERGY = entry({
  section: 'ALLERGIES_AND_SENSITIVITIES',
  entityKind: 'allergy_record',
  entityId: 'allergy-a',
  lines: ['Allergy: synthetic-substance (reported)'],
  caveat: 'Reported by the person or their caregiver. Not clinically confirmed.',
});

const AVAILABLE = [ITEM_A, ITEM_B, ALLERGY];

function generationRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    profileId: PROFILE,
    requestedByUserId: USER,
    selectedEntityIds: ['item-a'],
    reviewedDigest: digestSelection([ITEM_A], digest),
    reviewedAt: NOW,
    notes: [],
    ttlHours: DEFAULT_VISIT_PACK_TTL_HOURS,
    ...overrides,
  };
}

function generate(
  requestOverrides: Partial<GenerationRequest> = {},
  extra: { available?: readonly VisitPackEntry[]; stepUpFresh?: boolean; now?: Instant } = {},
) {
  return evaluateGeneration({
    request: generationRequest(requestOverrides),
    available: extra.available ?? AVAILABLE,
    stepUpFresh: extra.stepUpFresh ?? true,
    now: extra.now ?? NOW,
    digest,
  });
}

// ---------------------------------------------------------------------------

describe('canonical form', () => {
  it('is stable under reordering', () => {
    // The digest compares content, not the order a client happened to send it in.
    expect(canonicalizeSelection([ITEM_A, ITEM_B])).toBe(canonicalizeSelection([ITEM_B, ITEM_A]));
  });

  it('changes when any rendered field changes', () => {
    const base = canonicalizeSelection([ITEM_A]);
    for (const changed of [
      entry({ lines: ['Synthetic Tablet, 250 mg'] }),
      entry({ caveat: 'Checked against the package by the person who entered it.' }),
      entry({ version: 2 }),
      entry({ section: 'RECENT_ITEM_CHANGES' }),
      entry({ entityId: 'item-z' }),
    ]) {
      expect(canonicalizeSelection([changed])).not.toBe(base);
    }
  });

  it('does not let content forge a field boundary', () => {
    // The separators are control characters, which cannot survive the untrusted-input
    // sanitiser. Without this property, a crafted display name could make two different
    // selections canonicalize identically.
    const sneaky = entry({ entityId: 'item-a', lines: ['x\u001Fitem-b\u001Ey'] });
    expect(canonicalizeSelection([sneaky])).not.toBe(canonicalizeSelection([ITEM_A, ITEM_B]));
  });

  it('orders sections as the spec lists them, not alphabetically', () => {
    const canonical = canonicalizeSelection([ALLERGY, ITEM_A]);
    expect(canonical.indexOf('CURRENT_MEDICINES')).toBeLessThan(
      canonical.indexOf('ALLERGIES_AND_SENSITIVITIES'),
    );
  });
});

describe('expiry', () => {
  it('produces an instant the configured hours ahead', () => {
    const result = visitPackExpiryFor(NOW, 72);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe('2026-09-01T12:00:00.000Z');
  });

  it('refuses a lifetime outside the permitted range', () => {
    for (const hours of [0, -1, MAX_VISIT_PACK_TTL_HOURS + 1, 1.5, Number.NaN]) {
      const result = visitPackExpiryFor(NOW, hours);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error.detail?.['reason_code']).toBe('visit_pack_ttl_range');
    }
  });

  it('treats a pack as unavailable once expired or revoked', () => {
    const expiresAt = instantFrom('2026-08-30T12:00:00.000Z');
    expect(isVisitPackRetrievable({ expiresAt, revokedAt: null }, NOW)).toBe(true);
    // Evaluated against the clock, so no sweep is needed for expiry to take effect.
    expect(
      isVisitPackRetrievable({ expiresAt, revokedAt: null }, instantFrom('2026-09-02T00:00:00Z')),
    ).toBe(false);
    // Revocation wins even while the pack is otherwise live.
    expect(isVisitPackRetrievable({ expiresAt, revokedAt: NOW }, NOW)).toBe(false);
  });
});

/** Any phrasing that would assert clinical confirmation. */
const CLINICAL_CLAIM = /clinical(ly)?[- ]?(confirmed|diagnos\w*)|diagnos(is|ed)/i;

/** A negation in the same sentence, immediately before the claim. */
const NEGATION_BEFORE = /\b(not|never|no)\b[^.]*$/i;

describe('caveats', () => {
  it('gives every verification state a caveat that says what not to assume', () => {
    for (const verification of ITEM_VERIFICATIONS) {
      const caveat = itemCaveat(verification);
      expect(caveat.length).toBeGreaterThan(0);
      expect(caveat.endsWith('.')).toBe(true);
    }
  });

  it('never describes an unverified item as checked', () => {
    expect(itemCaveat('UNVERIFIED')).toMatch(/not checked/i);
    expect(itemCaveat('CONFLICTING')).toMatch(/unconfirmed/i);
  });

  it('never lets a profile fact read as a clinical confirmation', () => {
    // Spec 04 Phase 1.3: no inferred fact silently becomes a confirmed diagnosis, and a printed
    // page handed to a clinician is exactly where that would happen. A caveat may mention
    // clinical confirmation only in order to deny it, so every such mention must be negated.
    for (const provenance of PROVENANCE_KINDS) {
      const caveat = factCaveat(provenance);
      const match = CLINICAL_CLAIM.exec(caveat);
      if (match !== null) {
        expect(caveat.slice(0, match.index)).toMatch(NEGATION_BEFORE);
      }
    }
    expect(factCaveat('USER_REPORTED')).toMatch(/not clinically confirmed/i);
    expect(factCaveat('REVIEWER_CONFIRMED')).toMatch(/not a clinical diagnosis/i);
  });

  it('would catch an affirming caveat if one were ever written', () => {
    // Guards the test above. Without it, a pattern that quietly stopped matching would make the
    // property vacuous rather than failing.
    const affirming = 'Clinically confirmed by the prescriber.';
    const match = CLINICAL_CLAIM.exec(affirming);
    expect(match).not.toBeNull();
    expect(affirming.slice(0, match?.index ?? 0)).not.toMatch(NEGATION_BEFORE);
  });
});

describe('generation refuses without step-up', () => {
  it('refuses before anything else is considered', () => {
    // Even a request that is wrong in every other way is reported as needing step-up: spec 14
    // treats an export without re-authentication as the failure.
    const result = generate(
      { selectedEntityIds: [], reviewedDigest: 'x'.repeat(64) },
      { stepUpFresh: false },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('STEP_UP_REQUIRED');
  });
});

describe('export never happens automatically', () => {
  it('refuses a request that selects nothing', () => {
    const result = generate({ selectedEntityIds: [], notes: [] });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.detail?.['reason_code']).toBe('empty_selection');
    }
  });

  it('has no way to express "include everything"', () => {
    // The property this asserts is structural: the only route to content is an explicit ID list,
    // so a caller that omits it gets nothing rather than a default.
    const request = generationRequest();
    expect(Object.keys(request)).not.toContain('includeAll');
    expect(Array.isArray(request.selectedEntityIds)).toBe(true);
  });

  it('includes exactly the selected records and no others', () => {
    const result = generate();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.entries.map((e) => e.entityId)).toEqual(['item-a']);
    }
  });

  it('refuses a selection naming something not on offer', () => {
    const result = generate({
      selectedEntityIds: ['item-a', 'item-from-another-profile'],
      reviewedDigest: digestSelection([ITEM_A, ITEM_B], digest),
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.detail?.['reason_code']).toBe('unknown_selection');
  });

  it('refuses the same record selected twice', () => {
    const result = generate({ selectedEntityIds: ['item-a', 'item-a'] });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.detail?.['reason_code']).toBe('duplicate_selection');
  });

  it('refuses a selection larger than the readable limit', () => {
    const many = Array.from({ length: MAX_VISIT_PACK_ENTRIES + 1 }, (_, i) => `item-${i}`);
    const result = generate({ selectedEntityIds: many });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.detail?.['reason_code']).toBe('selection_too_large');
  });
});

describe('a user can review exactly what will be shared', () => {
  it('accepts when the reviewed digest still describes the live content', () => {
    const result = generate();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.contentDigest).toBe(digestSelection([ITEM_A], digest));
    }
  });

  it('refuses when a selected record changed after the review screen', () => {
    // The exit criterion. A caregiver editing a medicine between review and Generate must not
    // cause a pack to contain a line nobody read.
    const changed = entry({ entityId: 'item-a', lines: ['Synthetic Tablet, 250 mg'] });
    const result = generate({}, { available: [changed, ITEM_B, ALLERGY] });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('EXPORT_CONTENT_CHANGED');
      expect(result.error.detail?.['reason_code']).toBe('digest_mismatch');
    }
  });

  it('refuses when the caveat changed, not only the content', () => {
    // An item that became confirmed since review is still a change to the printed page.
    const reverified = entry({
      entityId: 'item-a',
      caveat: 'Checked against the package by the person who entered it.',
    });
    const result = generate({}, { available: [reverified, ITEM_B, ALLERGY] });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('EXPORT_CONTENT_CHANGED');
  });

  it('refuses when notes were added after the review', () => {
    // Notes are part of the reviewed content, not metadata attached afterwards.
    const result = generate({ notes: ['Is the dose still right?'] });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('EXPORT_CONTENT_CHANGED');
  });

  it('accepts a pack of notes alone when they were what was reviewed', () => {
    const notes = ['Is the dose still right?', 'Any interaction with the new cream?'];
    const noteEntries: VisitPackEntry[] = notes.map((line, index) => ({
      section: 'QUESTIONS_AND_NOTES',
      entityKind: 'user_note',
      entityId: `note:${String(index).padStart(4, '0')}`,
      version: 1,
      lines: [line],
      caveat: 'Written by the person or their caregiver.',
    }));

    const result = generate({
      selectedEntityIds: [],
      notes,
      reviewedDigest: digestSelection(noteEntries, digest),
    });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.entries).toHaveLength(2);
  });

  it('refuses a review time in the future', () => {
    const result = generate({ reviewedAt: instantFrom('2026-09-30T00:00:00.000Z') });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.detail?.['reason_code']).toBe('review_time_invalid');
  });

  it('does not care how long ago the review happened, only that content matches', () => {
    // A stale review of unchanged content is still a review of exactly this content.
    const result = generate({ reviewedAt: instantFrom('2026-01-01T00:00:00.000Z') });
    expect(isOk(result)).toBe(true);
  });
});

describe('the generated plan', () => {
  it('records generation time and an expiry', () => {
    const result = generate();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.generatedAt).toBe(NOW);
      expect(Date.parse(result.value.expiresAt)).toBeGreaterThan(Date.parse(NOW));
    }
  });

  it('counts every section, including the ones that are empty', () => {
    const result = generate();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(Object.keys(result.value.sectionCounts).sort()).toEqual(
        [...VISIT_PACK_SECTIONS].sort(),
      );
      expect(result.value.sectionCounts['CURRENT_MEDICINES']).toBe(1);
      expect(result.value.sectionCounts['ALLERGIES_AND_SENSITIVITIES']).toBe(0);
    }
  });
});

describe('rendering a stored pack', () => {
  const base = {
    id: PACK,
    profileId: PROFILE,
    generatedAt: NOW,
    expiresAt: instantFrom('2026-09-01T12:00:00.000Z'),
    digest,
  };

  it('always carries the limitation', () => {
    // Spec 03 group I: a pack is a communication aid, not a clinician-authenticated record. The
    // field is required by the type, and this asserts the text is not silently emptied.
    const pack = renderVisitPack({
      ...base,
      storedDigest: digestSelection([ITEM_A], digest),
      entries: [ITEM_A],
    });
    expect(pack.limitation).toBe(VISIT_PACK_LIMITATION);
    expect(pack.limitation).toMatch(/not a medical record/i);
    expect(pack.limitation).toMatch(/no health professional has checked it/i);
  });

  it('reports a match when the live records still agree with what was generated', () => {
    const pack = renderVisitPack({
      ...base,
      storedDigest: digestSelection([ITEM_A], digest),
      entries: [ITEM_A],
    });
    expect(pack.matchesGeneratedContent).toBe(true);
  });

  it('reports a mismatch rather than silently showing different data', () => {
    // DEC-022: the pack stores a manifest, not a copy. The honest consequence of that choice is
    // that drift has to be visible to the reader.
    const pack = renderVisitPack({
      ...base,
      storedDigest: digestSelection([ITEM_A], digest),
      entries: [entry({ lines: ['Synthetic Tablet, 250 mg'] })],
    });
    expect(pack.matchesGeneratedContent).toBe(false);
  });
});

describe('audit detail', () => {
  it('records counts and section names, never content', () => {
    const result = generate();
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const detail = visitPackAuditDetail(result.value);
    expect(detail['entry_count']).toBe(1);
    expect(detail['sections']).toBe('CURRENT_MEDICINES');
    expect(detail['count_current_medicines']).toBe(1);

    // Spec 16: an audit event without duplicating sensitive content into logs.
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('Synthetic Tablet');
    expect(serialized).not.toContain('500 mg');
  });

  it('omits sections that contributed nothing', () => {
    const result = generate();
    if (!isOk(result)) throw new Error('expected a plan');
    const detail = visitPackAuditDetail(result.value);
    expect(detail['count_allergies_and_sensitivities']).toBeUndefined();
  });

  it('records that notes were attached without recording the notes', () => {
    const notes = ['Please check the dose of the blue tablet.'];
    const noteEntries: VisitPackEntry[] = notes.map((line, index) => ({
      section: 'QUESTIONS_AND_NOTES',
      entityKind: 'user_note',
      entityId: `note:${String(index).padStart(4, '0')}`,
      version: 1,
      lines: [line],
      caveat: 'Written by the person or their caregiver.',
    }));
    const result = generate({
      selectedEntityIds: [],
      notes,
      reviewedDigest: digestSelection(noteEntries, digest),
    });
    if (!isOk(result)) throw new Error('expected a plan');

    const detail = visitPackAuditDetail(result.value);
    expect(detail['note_count']).toBe(1);
    expect(JSON.stringify(detail)).not.toContain('blue tablet');
  });
});

describe('helpers', () => {
  it('lists only the owned items in a selection', () => {
    expect(ownedItemIdsIn([ITEM_A, ALLERGY, ITEM_B])).toEqual(['item-a', 'item-b']);
  });
});
