import { describe, it, expect } from 'vitest';
import {
  assessCorroboration,
  DEFAULT_CORROBORATION_POLICY,
  type ObservationEvidence,
} from './corroboration.js';
import { instantFrom } from '@kynviora/domain';

const t = (iso: string) => instantFrom(iso);

let counter = 0;
function observation(overrides: Partial<ObservationEvidence> = {}): ObservationEvidence {
  counter += 1;
  return {
    observationId: `obs-${counter}`,
    contributionGroupHash: `group-${counter}`,
    assetSha256: `sha-${counter}`,
    assetPerceptualHash: `phash-${counter}`,
    observedAt: t(`2026-08-${String((counter % 27) + 1).padStart(2, '0')}T00:00:00.000Z`),
    market: 'IN',
    humanConfirmed: true,
    ...overrides,
  };
}

describe('lifecycle progression (spec 08)', () => {
  it('is CANDIDATE with no observations', () => {
    const result = assessCorroboration([]);
    expect(result.state).toBe('CANDIDATE');
    expect(result.reasonCode).toBe('no_observations');
  });

  it('is USER_CONFIRMED with one human-confirmed observation', () => {
    const result = assessCorroboration([observation()]);
    expect(result.state).toBe('USER_CONFIRMED');
    expect(result.independentGroupCount).toBe(1);
  });

  it('is CORROBORATED once the independent-group threshold is met', () => {
    const observations = [observation(), observation(), observation()];
    const result = assessCorroboration(observations);
    expect(result.state).toBe('CORROBORATED');
    expect(result.independentGroupCount).toBe(DEFAULT_CORROBORATION_POLICY.minIndependentGroups);
  });

  it('is EXTERNALLY_VERIFIED when approved external evidence exists', () => {
    // Spec 08 source progression: approved manufacturer/provider evidence outranks accumulated
    // observations.
    const result = assessCorroboration([observation()], {
      externalVerification: {
        sourceClass: 'MANUFACTURER_EVIDENCE',
        verifiedAt: t('2026-08-01T00:00:00.000Z'),
      },
    });
    expect(result.state).toBe('EXTERNALLY_VERIFIED');
  });

  it('is RETIRED when marked retired, regardless of observations', () => {
    const result = assessCorroboration([observation(), observation(), observation()], {
      isRetired: true,
    });
    expect(result.state).toBe('RETIRED');
  });
});

describe('conflict dominance (spec 08: no majority-vote overwrite)', () => {
  it('is CONFLICTING while a conflict is unresolved, whatever the observation count', () => {
    // "conflict state instead of majority-vote overwrite" - crowd volume must never resolve a
    // genuine disagreement.
    const many = Array.from({ length: 50 }, () => observation());
    const result = assessCorroboration(many, { hasUnresolvedConflict: true });
    expect(result.state).toBe('CONFLICTING');
    expect(result.reasonCode).toBe('unresolved_conflict');
  });

  it('outranks even external verification', () => {
    const result = assessCorroboration([observation()], {
      hasUnresolvedConflict: true,
      externalVerification: {
        sourceClass: 'APPROVED_PROVIDER',
        verifiedAt: t('2026-08-01T00:00:00.000Z'),
      },
    });
    expect(result.state).toBe('CONFLICTING');
  });
});

describe('A11 - catalog poisoning resistance (spec 15)', () => {
  it('rejects literal re-uploads of the same image', () => {
    // An attacker submitting one image many times must not reach the threshold.
    const shared = { assetSha256: 'identical-file', assetPerceptualHash: 'identical-phash' };
    const result = assessCorroboration([
      observation({ ...shared, contributionGroupHash: 'g1' }),
      observation({ ...shared, contributionGroupHash: 'g2' }),
      observation({ ...shared, contributionGroupHash: 'g3' }),
      observation({ ...shared, contributionGroupHash: 'g4' }),
    ]);
    expect(result.rejectedDuplicateCount).toBe(3);
    expect(result.independentGroupCount).toBe(1);
    expect(result.state).toBe('USER_CONFIRMED');
    expect(result.state).not.toBe('CORROBORATED');
  });

  it('rejects perceptually identical re-uploads even when the bytes differ', () => {
    // Recompressing or lightly editing an image changes its SHA-256 but not its perceptual hash.
    const result = assessCorroboration([
      observation({
        assetSha256: 'file-a',
        assetPerceptualHash: 'same-image',
        contributionGroupHash: 'g1',
      }),
      observation({
        assetSha256: 'file-b',
        assetPerceptualHash: 'same-image',
        contributionGroupHash: 'g2',
      }),
      observation({
        assetSha256: 'file-c',
        assetPerceptualHash: 'same-image',
        contributionGroupHash: 'g3',
      }),
    ]);
    expect(result.rejectedDuplicateCount).toBe(2);
    expect(result.state).not.toBe('CORROBORATED');
  });

  it('counts observations from one contributor group only once', () => {
    // Many submissions from the same account/device are not independent evidence.
    const result = assessCorroboration([
      observation({ contributionGroupHash: 'same-group' }),
      observation({ contributionGroupHash: 'same-group' }),
      observation({ contributionGroupHash: 'same-group' }),
      observation({ contributionGroupHash: 'same-group' }),
      observation({ contributionGroupHash: 'same-group' }),
    ]);
    expect(result.independentGroupCount).toBe(1);
    expect(result.state).toBe('USER_CONFIRMED');
  });

  it('requires three independent groups, so one duplicate account is not enough', () => {
    // Two groups would let a single attacker with one spare account reach the threshold.
    const twoGroups = assessCorroboration([
      observation({ contributionGroupHash: 'g1' }),
      observation({ contributionGroupHash: 'g2' }),
    ]);
    expect(twoGroups.state).toBe('USER_CONFIRMED');

    const threeGroups = assessCorroboration([
      observation({ contributionGroupHash: 'g1' }),
      observation({ contributionGroupHash: 'g2' }),
      observation({ contributionGroupHash: 'g3' }),
    ]);
    expect(threeGroups.state).toBe('CORROBORATED');
  });

  it('does not count machine-read observations nobody confirmed', () => {
    // Spec 17: an unconfirmed machine reading is not evidence a human ever checked the package.
    const result = assessCorroboration([
      observation({ contributionGroupHash: 'g1', humanConfirmed: false }),
      observation({ contributionGroupHash: 'g2', humanConfirmed: false }),
      observation({ contributionGroupHash: 'g3', humanConfirmed: false }),
    ]);
    expect(result.independentGroupCount).toBe(0);
    expect(result.state).toBe('CANDIDATE');
    expect(result.reasonCode).toBe('no_human_confirmed_independent_observation');
  });

  it('flags a suspicious pattern when duplicates dominate', () => {
    // Surfaced for the abuse dashboards required by spec 20; it does not itself change state.
    const shared = { assetSha256: 'dup', assetPerceptualHash: 'dup' };
    const result = assessCorroboration([
      observation({ ...shared, contributionGroupHash: 'g1' }),
      observation({ ...shared, contributionGroupHash: 'g2' }),
      observation({ ...shared, contributionGroupHash: 'g3' }),
      observation({ ...shared, contributionGroupHash: 'g4' }),
    ]);
    expect(result.suspiciousPattern).toBe(true);
  });

  it('does not flag ordinary independent contributions', () => {
    const result = assessCorroboration([observation(), observation(), observation()]);
    expect(result.suspiciousPattern).toBe(false);
  });

  it('keeps the earliest submission and rejects later copies', () => {
    const shared = { assetSha256: 'dup', assetPerceptualHash: 'dup' };
    const result = assessCorroboration([
      observation({ ...shared, observedAt: t('2026-08-10T00:00:00.000Z') }),
      observation({ ...shared, observedAt: t('2026-08-01T00:00:00.000Z') }),
    ]);
    expect(result.rejectedDuplicateCount).toBe(1);
    expect(result.totalObservationCount).toBe(2);
  });
});

describe('determinism and reproducibility', () => {
  it('produces the same assessment regardless of input order', () => {
    // A reviewer investigating a promotion must be able to reproduce the decision exactly.
    const a = observation({ contributionGroupHash: 'g1' });
    const b = observation({ contributionGroupHash: 'g2' });
    const c = observation({ contributionGroupHash: 'g3' });

    const forward = assessCorroboration([a, b, c]);
    const reversed = assessCorroboration([c, b, a]);

    expect(forward.state).toBe(reversed.state);
    expect(forward.independentGroupCount).toBe(reversed.independentGroupCount);
    expect(forward.rejectedDuplicateCount).toBe(reversed.rejectedDuplicateCount);
  });

  it('is a pure function with no side effects on its input', () => {
    const observations = [observation(), observation()];
    const snapshot = structuredClone(observations);
    assessCorroboration(observations);
    expect(observations).toEqual(snapshot);
  });
});

describe('corroboration never implies safety (spec 08)', () => {
  it('exposes no safety, risk or certainty score field', () => {
    // Spec 08 forbids "a fake mathematical certainty score simply because many users submitted
    // the same record", and corroboration establishes evidence quality, not medical safety.
    const result = assessCorroboration([observation(), observation(), observation()]);
    const keys = Object.keys(result);
    for (const forbidden of ['safety', 'risk', 'score', 'confidencePercent', 'certainty', 'safe']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('reports counts and a state, not a probability', () => {
    const result = assessCorroboration([observation(), observation(), observation()]);
    expect(typeof result.independentGroupCount).toBe('number');
    expect(typeof result.state).toBe('string');
    expect(result.state).toBe('CORROBORATED');
  });
});

describe('custom policy', () => {
  it('honours a stricter independent-group threshold', () => {
    const result = assessCorroboration([observation(), observation(), observation()], {
      policy: { minIndependentGroups: 5, minObservationSpacingMs: 60_000 },
    });
    expect(result.state).toBe('USER_CONFIRMED');
  });
});
