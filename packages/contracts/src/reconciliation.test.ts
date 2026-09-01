import { describe, it, expect } from 'vitest';
import {
  CONTRADICTS_SIDE_MESSAGE,
  NEEDS_A_NAME_MESSAGE,
  NEEDS_A_SIDE_MESSAGE,
  UNRESOLVED_CANNOT_ADOPT_MESSAGE,
  asResolution,
  buildResolution,
  canResolve,
  impliedSide,
} from './reconciliation.js';
import { RECONCILIATION_RESOLUTIONS } from '@kynviora/domain';
import { RESOLUTION_OPTIONS, findForbiddenClaims } from '@kynviora/presentation';

const PROFESSIONAL = [
  'CONFIRMED_WITH_PRESCRIBER',
  'CONFIRMED_WITH_PHARMACIST',
  'CONFIRMED_FROM_DOCUMENT',
] as const;

describe('which value stands is stated by a person', () => {
  it('refuses every settling resolution that names no side', () => {
    // DEC-030 and the exit criterion of Phase 8.5. Defaulting to the current list because it is
    // newer would be Kynviora choosing which medical instruction is correct.
    for (const option of RESOLUTION_OPTIONS.filter((o) => o.settles)) {
      const draft = buildResolution({
        resolution: option.resolution,
        confirmedBy: option.needsName ? 'A. Pharmacist' : null,
      });
      expect(draft.ok).toBe(false);
      if (draft.ok) continue;
      expect(draft.refusal.reason).toBe('NEEDS_A_SIDE');
    }
  });

  it('lets a professional confirmation settle on either side', () => {
    // The case the rule is really about: a pharmacist may confirm the older dose. If a
    // confirmation could only ever adopt the current list, the screen would be making the
    // judgement `04` Phase 8.5 forbids.
    for (const resolution of PROFESSIONAL) {
      for (const adopt of ['PREVIOUS', 'CURRENT'] as const) {
        const draft = buildResolution({
          resolution,
          adopt,
          confirmedBy: 'A. Pharmacist',
        });
        expect(draft.ok).toBe(true);
        if (!draft.ok) continue;
        expect(draft.body.adopt).toBe(adopt);
      }
    }
  });

  it('never implies a side for a confirmation', () => {
    // A screen using `impliedSide` to pre-select would be inventing the answer it exists to ask
    // for. Null is not an omission here - it is the statement that the choice is not knowable
    // from the resolution.
    for (const resolution of PROFESSIONAL) {
      expect(impliedSide(resolution)).toBeNull();
    }
    expect(impliedSide('USER_KEPT_PREVIOUS')).toBe('PREVIOUS');
    expect(impliedSide('USER_ADOPTED_CURRENT')).toBe('CURRENT');
  });

  it('refuses a self-describing resolution that contradicts its side', () => {
    // Otherwise the record reads as "the user kept the previous value" while holding the current
    // one.
    const draft = buildResolution({ resolution: 'USER_KEPT_PREVIOUS', adopt: 'CURRENT' });
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.refusal.reason).toBe('CONTRADICTS_SIDE');
    expect(CONTRADICTS_SIDE_MESSAGE).toMatch(/does not match/i);
  });
});

describe('a professional confirmation names who gave it', () => {
  it('refuses a confirmation with no name', () => {
    for (const resolution of ['CONFIRMED_WITH_PRESCRIBER', 'CONFIRMED_WITH_PHARMACIST'] as const) {
      const draft = buildResolution({ resolution, adopt: 'CURRENT' });
      expect(draft.ok).toBe(false);
      if (draft.ok) continue;
      expect(draft.refusal.reason).toBe('NEEDS_A_NAME');
    }
    expect(NEEDS_A_NAME_MESSAGE).toMatch(/who confirmed/i);
  });

  it('refuses whitespace as a name', () => {
    const draft = buildResolution({
      resolution: 'CONFIRMED_WITH_PHARMACIST',
      adopt: 'CURRENT',
      confirmedBy: '   ',
    });
    expect(draft.ok).toBe(false);
  });

  it('does not require a name for a document', () => {
    // A letter in front of you is not a person, and asking for one would be asking for something
    // the user does not have.
    expect(buildResolution({ resolution: 'CONFIRMED_FROM_DOCUMENT', adopt: 'PREVIOUS' }).ok).toBe(
      true,
    );
  });
});

describe('leaving a difference open', () => {
  it('settles on neither value', () => {
    // `04` Phase 8.5 lists unresolved differences as expected output. Someone who cannot reach
    // their pharmacist today has a real state.
    const draft = buildResolution({ resolution: 'STILL_UNRESOLVED' });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.body.adopt).toBeNull();
  });

  it('refuses to carry a side', () => {
    // Letting an open difference hold one would put a decision into the record that nobody made.
    const draft = buildResolution({ resolution: 'STILL_UNRESOLVED', adopt: 'CURRENT' });
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.refusal.reason).toBe('UNRESOLVED_CANNOT_ADOPT');
    expect(UNRESOLVED_CANNOT_ADOPT_MESSAGE).toMatch(/neither/i);
  });
});

describe('what the payload never carries', () => {
  it('has no field naming a preferred value', () => {
    // Trap 19: no suggestedValue, preferred, confidence or score on the difference, the payload
    // or the view.
    const draft = buildResolution({ resolution: 'USER_ADOPTED_CURRENT', adopt: 'CURRENT' });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(Object.keys(draft.body).sort()).toEqual(['adopt', 'confirmedBy', 'note', 'resolution']);
  });

  it('sends null rather than an empty string for an absent name or note', () => {
    // The server distinguishes "not recorded" from "recorded as nothing", and an empty string is
    // neither.
    const draft = buildResolution({
      resolution: 'USER_ADOPTED_CURRENT',
      adopt: 'CURRENT',
      note: '  ',
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.body.note).toBeNull();
    expect(draft.body.confirmedBy).toBeNull();
  });

  it('refuses a resolution it does not recognise', () => {
    // Deny by default. A newer server's vocabulary member has no option, no label and no rule
    // about whether it settles, and guessing any of those decides something about a medicine.
    expect(asResolution('SOMETHING_NEWER')).toBeNull();
    const draft = buildResolution({ resolution: 'SOMETHING_NEWER', adopt: 'CURRENT' });
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.refusal.reason).toBe('UNKNOWN_RESOLUTION');
  });

  it('covers every resolution the domain defines', () => {
    // A member added to the vocabulary without an option here would be a control nobody can use,
    // and the presentation layer's own test asserts the other direction.
    for (const resolution of RECONCILIATION_RESOLUTIONS) {
      expect(asResolution(resolution)).toBe(resolution);
    }
  });
});

describe('the control and the builder agree', () => {
  it('says yes exactly when a resolution can be built', () => {
    const cases = [
      { resolution: 'STILL_UNRESOLVED' },
      { resolution: 'USER_ADOPTED_CURRENT' },
      { resolution: 'USER_ADOPTED_CURRENT', adopt: 'CURRENT' as const },
      { resolution: 'CONFIRMED_WITH_PHARMACIST', adopt: 'PREVIOUS' as const },
      {
        resolution: 'CONFIRMED_WITH_PHARMACIST',
        adopt: 'PREVIOUS' as const,
        confirmedBy: 'A. Pharmacist',
      },
    ];
    for (const input of cases) {
      expect(canResolve(input)).toBe(buildResolution(input).ok);
    }
  });
});

describe('the words', () => {
  it('ask rather than instruct, and make no forbidden claim', () => {
    for (const text of [
      NEEDS_A_SIDE_MESSAGE,
      NEEDS_A_NAME_MESSAGE,
      UNRESOLVED_CANNOT_ADOPT_MESSAGE,
      CONTRADICTS_SIDE_MESSAGE,
    ]) {
      expect(findForbiddenClaims(text)).toEqual([]);
      // `09`: Kynviora never tells someone what to do about a medicine, and this is the screen
      // where that temptation is strongest.
      expect(text.toLowerCase()).not.toMatch(
        /you should|we recommend|the correct|the right (one|version)|take the/,
      );
    }
  });
});
