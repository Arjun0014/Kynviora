import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_SAMPLE_FIELDS,
  SHADOW_DIFF_KINDS,
  SHADOW_EVALUATION_MARKER,
  compareShadowRuns,
  replayAll,
  runShadow,
  type ShadowDatasetRow,
  type ShadowRun,
  type ShadowRunRequest,
} from './shadow.js';
import {
  evaluateRule,
  type ActionSignal,
  type AssessmentInputs,
  type AssessmentRuleVersion,
  type OwnedItemSnapshot,
} from './rules.js';
import { instantFrom } from '@kynviora/domain';

/**
 * Shadow runs, replay, and before/after comparison.
 *
 * Exit criterion 1 - "New high-impact rules can be evaluated without user notification" - is
 * asserted structurally rather than behaviourally: the tests check that a shadow run has no field
 * a dispatcher could send from, because a boolean flag checked before notifying only holds until
 * somebody adds a second notification path.
 *
 * Exit criterion 2 - "Regulatory data corrections can recompute dependent product views and
 * assessments reproducibly" - is asserted by replaying with the same inputs and requiring exact
 * reproduction, and by replaying with a changed source and requiring the diff to name what moved.
 */

const NOW = instantFrom('2026-08-29T00:00:00.000Z');
const REVIEWER = 'synthetic-test-reviewer';

function rule(overrides: Partial<AssessmentRuleVersion> = {}): AssessmentRuleVersion {
  return {
    id: 'rule-1',
    kind: 'BATCH_ACTION_MATCH',
    version: 'v1',
    evidenceLevel: 'A',
    maxUrgency: 'HIGH',
    requiredItemVerification: ['CONFIRMED', 'PROBABLE'],
    requiredProfileProvenance: ['USER_REPORTED', 'REVIEWER_CONFIRMED'],
    explanationTemplateId: 'tpl-batch-recall-v1',
    reviewState: 'PUBLISHED',
    approvedByReviewerId: REVIEWER,
    approvedAt: NOW,
    // Shadow mode is the default here, because that is what this module is for.
    shadowMode: true,
    enabled: true,
    ...overrides,
  };
}

function item(overrides: Partial<OwnedItemSnapshot> = {}): OwnedItemSnapshot {
  return {
    ownedItemId: 'owned-1',
    profileId: 'profile-1',
    productIdentityId: 'prod-1',
    formulationId: 'form-1',
    formulationVersion: 'fv-1',
    batchId: 'batch-1',
    lotCode: 'A24X91',
    gtin: '8901234567890',
    expiresOn: null,
    identityVerification: 'CONFIRMED',
    formulationVerification: 'CONFIRMED',
    batchVerification: 'CONFIRMED',
    substanceKeys: [],
    isActive: true,
    ...overrides,
  };
}

function signal(overrides: Partial<ActionSignal> = {}): ActionSignal {
  return {
    id: 'signal-1',
    version: 'sv-1',
    gtin: '8901234567890',
    formulationId: null,
    batchCodes: ['A24X91', 'A24X92'],
    summary: 'SYNTHETIC batch recall fixture.',
    ...overrides,
  };
}

function row(overrides: Partial<ShadowDatasetRow> = {}): ShadowDatasetRow {
  return { item: item(), profileFacts: [], actionSignals: [signal()], ...overrides };
}

function request(overrides: Partial<ShadowRunRequest> = {}): ShadowRunRequest {
  return {
    rule: rule(),
    dataset: [row()],
    normalizationVersion: 'norm-1',
    evaluationInstant: NOW,
    sampleLimit: 10,
    ...overrides,
  };
}

/** Three households, two of them holding the recalled batch. */
function mixedDataset(): readonly ShadowDatasetRow[] {
  return [
    row({ item: item({ ownedItemId: 'owned-1', profileId: 'profile-1' }) }),
    row({ item: item({ ownedItemId: 'owned-2', profileId: 'profile-2' }) }),
    row({
      item: item({
        ownedItemId: 'owned-3',
        profileId: 'profile-3',
        lotCode: 'ZZZ999',
        productIdentityId: 'prod-2',
        formulationId: 'form-2',
      }),
    }),
  ];
}

// ---------------------------------------------------------------------------

describe('a shadow run has nobody to notify', () => {
  it('carries no field a dispatcher could send from', () => {
    // Exit criterion 1 as a shape. A flag checked before notifying holds until somebody adds a
    // second notification path; a value with no recipients in it does not have that failure mode.
    const run = runShadow(request({ dataset: mixedDataset() }));
    const keys = Object.keys(run);
    for (const forbidden of ['profileIds', 'recipients', 'notify', 'deviceTokens']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('projects a sample without the person it belongs to', () => {
    const run = runShadow(request({ dataset: mixedDataset() }));
    expect(run.samples.length).toBeGreaterThan(0);
    for (const sample of run.samples) {
      for (const forbidden of FORBIDDEN_SAMPLE_FIELDS) {
        expect(Object.keys(sample)).not.toContain(forbidden);
      }
    }
  });

  it('gives a reviewer enough to investigate a suspected false positive', () => {
    // Spec 10's false-positive procedure needs the item, the reasons and the rule version. It
    // does not need the person, and the sample is the difference between the two.
    const sample = runShadow(request({ dataset: mixedDataset() })).samples[0];
    expect(sample?.ownedItemId).toBe('owned-1');
    expect(sample?.reasons.length).toBeGreaterThan(0);
    expect(sample?.matchConfidence).toBeDefined();
  });

  it('refuses to evaluate a rule that is not in shadow mode', () => {
    // A function that would happily evaluate a live rule across the whole estate is one call away
    // from being used to do that, and its assessments would be indistinguishable from real ones.
    expect(() => runShadow(request({ rule: rule({ shadowMode: false }) }))).toThrow(/shadow mode/i);
  });
});

describe('what a shadow run counts', () => {
  it('counts distinct products and formulations, not rows', () => {
    // Ten packs of the same product is one product affected. A reviewer judging blast radius
    // needs that number, not the row count.
    const run = runShadow(request({ dataset: mixedDataset() }));
    expect(run.matchedItems).toBe(2);
    expect(run.affectedProducts).toBe(1);
    expect(run.affectedFormulations).toBe(1);
  });

  it('counts potential user matches without listing them', () => {
    const run = runShadow(request({ dataset: mixedDataset() }));
    expect(run.potentialUserMatches).toBe(2);
    expect(JSON.stringify(run)).not.toContain('profile-1');
  });

  it('counts one user once however many of their items match', () => {
    const run = runShadow(
      request({
        dataset: [
          row({ item: item({ ownedItemId: 'owned-1', profileId: 'profile-1' }) }),
          row({ item: item({ ownedItemId: 'owned-2', profileId: 'profile-1' }) }),
        ],
      }),
    );
    expect(run.matchedItems).toBe(2);
    expect(run.potentialUserMatches).toBe(1);
  });

  it('reports the dataset size, so no matches is distinguishable from no data', () => {
    const empty = runShadow(request({ dataset: [] }));
    expect(empty.datasetSize).toBe(0);
    expect(empty.matchedItems).toBe(0);

    const noMatches = runShadow(request({ dataset: [row({ item: item({ lotCode: 'ZZZ999' }) })] }));
    expect(noMatches.datasetSize).toBe(1);
    expect(noMatches.matchedItems).toBe(0);
  });

  it('breaks the results down by reason, matched or not', () => {
    const run = runShadow(request({ dataset: mixedDataset() }));
    expect(run.reasonCounts.BATCH_CODE_MATCHED).toBe(2);
    expect(run.reasonCounts.NO_SIGNAL_MATCHED).toBe(1);
  });

  it('takes the sample in dataset order, so two runs show the same rows', () => {
    // Random sampling would show a reviewer different rows from their colleague, and the two
    // would not be able to talk about the same case.
    const first = runShadow(request({ dataset: mixedDataset(), sampleLimit: 1 }));
    const second = runShadow(request({ dataset: mixedDataset(), sampleLimit: 1 }));
    expect(first.samples).toEqual(second.samples);
    expect(first.samples).toHaveLength(1);
  });

  it('is deterministic over the whole run', () => {
    expect(runShadow(request({ dataset: mixedDataset() }))).toEqual(
      runShadow(request({ dataset: mixedDataset() })),
    );
  });

  it('offers no verdict on whether the rule should ship', () => {
    // Spec 22 requires release thresholds to be set by leadership against a labelled dataset, and
    // BLK-008 records that none exists. A recommendation here would invent one, and a reviewer
    // would read it as an answer.
    const run = runShadow(request({ dataset: mixedDataset() })) as ShadowRun &
      Record<string, unknown>;
    for (const forbidden of ['recommendation', 'verdict', 'passed', 'score', 'safeToPublish']) {
      expect(Object.keys(run)).not.toContain(forbidden);
    }
  });
});

describe('before and after', () => {
  function runWith(signals: readonly ActionSignal[]): ShadowRun {
    return runShadow(
      request({
        dataset: mixedDataset().map((r) => ({ ...r, actionSignals: signals })),
        sampleLimit: 100,
      }),
    );
  }

  it('names the items that started matching', () => {
    const before = runWith([signal({ batchCodes: ['NOTHING'] })]);
    const after = runWith([signal()]);
    const comparison = compareShadowRuns(before, after);

    // `before` sampled no matches, so the newly-matched items appear as after-only rather than as
    // a diff - which is exactly what the reviewer needs to see.
    expect(comparison.onlyInAfter).toEqual(['owned-1', 'owned-2']);
    expect(comparison.onlyInBefore).toEqual([]);
  });

  it('reports an item that stopped matching', () => {
    const before = runWith([signal()]);
    const after = runWith([signal({ batchCodes: ['NOTHING'] })]);
    const comparison = compareShadowRuns(before, after);
    expect(comparison.onlyInBefore).toEqual(['owned-1', 'owned-2']);
  });

  it('says nothing changed when nothing changed', () => {
    const comparison = compareShadowRuns(runWith([signal()]), runWith([signal()]));
    expect(comparison.unchanged).toBe(2);
    expect(comparison.newlyMatched).toBe(0);
    expect(comparison.noLongerMatched).toBe(0);
    expect(comparison.entries.every((e) => e.kinds.includes('UNCHANGED'))).toBe(true);
  });

  it('keeps urgency and confidence as separate movements', () => {
    // Two axes. Collapsing them into "changed" would hide which one moved, and they mean
    // different things to a reviewer.
    expect(SHADOW_DIFF_KINDS).toContain('URGENCY_CHANGED');
    expect(SHADOW_DIFF_KINDS).toContain('CONFIDENCE_CHANGED');
    expect(SHADOW_DIFF_KINDS).not.toContain('CHANGED');
  });

  it('reports items present in only one run rather than quietly intersecting', () => {
    // A comparison over two different datasets is usually a mistake, and one that silently
    // compared the overlap would hide it.
    const before = runWith([signal()]);
    const after = runShadow(
      request({
        dataset: [row({ item: item({ ownedItemId: 'owned-1' }) })],
        sampleLimit: 100,
      }),
    );
    const comparison = compareShadowRuns(before, after);
    expect(comparison.onlyInBefore).toEqual(['owned-2']);
    expect(comparison.onlyInAfter).toEqual([]);
  });
});

describe('replay after a correction', () => {
  function inputsFor(overrides: Partial<AssessmentInputs> = {}): AssessmentInputs {
    return {
      rule: rule({ shadowMode: false }),
      item: item(),
      profileFacts: [],
      actionSignals: [signal()],
      normalizationVersion: 'norm-1',
      evaluationInstant: NOW,
      ...overrides,
    };
  }

  it('reproduces every assessment when nothing changed', () => {
    // Spec 09: "Replaying the same versions must reproduce the result." Stated as a test rather
    // than as a promise.
    const originals = [evaluateRule(inputsFor())];
    const report = replayAll(originals, () => inputsFor());
    expect(report.fullyReproduced).toBe(true);
    expect(report.reproduced).toBe(1);
    expect(report.changed).toBe(0);
  });

  it('names exactly which fields a correction moved', () => {
    // A regulatory correction is not "apply and hope" - it is a diff a person reads before
    // anything reaches a user.
    const originals = [evaluateRule(inputsFor())];
    const report = replayAll(originals, () =>
      inputsFor({ actionSignals: [signal({ batchCodes: ['NOTHING'] })] }),
    );
    expect(report.fullyReproduced).toBe(false);
    expect(report.entries[0]?.differences).toContain('matched');
    expect(report.entries[0]?.differences).toContain('reasons');
  });

  it('counts how often each field moved across the whole correction', () => {
    const originals = [
      evaluateRule(inputsFor({ item: item({ ownedItemId: 'owned-1' }) })),
      evaluateRule(inputsFor({ item: item({ ownedItemId: 'owned-2' }) })),
    ];
    const report = replayAll(originals, (original) =>
      inputsFor({
        item: item({ ownedItemId: original.ownedItemId }),
        actionSignals: [signal({ batchCodes: ['NOTHING'] })],
      }),
    );
    expect(report.total).toBe(2);
    expect(report.changed).toBe(2);
    expect(report.differenceCounts.matched).toBe(2);
  });

  it('reproduces an expiry assessment against the instant it was computed for', () => {
    // Recomputing a past assessment must use the date it was computed for, not today. Without
    // that, every expiry assessment would "change" on replay and a correction diff would be
    // unreadable.
    const expiryInputs = inputsFor({
      rule: rule({ kind: 'EXPIRY', shadowMode: false, maxUrgency: 'MEDIUM' }),
      item: item({ expiresOn: '2026-09-10' }),
    });
    const original = evaluateRule(expiryInputs);
    const report = replayAll([original], () => expiryInputs);
    expect(report.fullyReproduced).toBe(true);
  });

  it('reports an empty replay as fully reproduced', () => {
    const report = replayAll([], () => inputsFor());
    expect(report.total).toBe(0);
    expect(report.fullyReproduced).toBe(true);
  });
});

describe('a shadow run measures the rule nobody has approved yet', () => {
  it('reports real matches for a candidate rule', () => {
    // The whole point of the phase. Under the live approval gate a candidate would report zero
    // matches, which reads as "this rule affects nobody" - the worst wrong answer a blast-radius
    // number can give.
    const run = runShadow(
      request({
        rule: rule({ reviewState: 'CANDIDATE', approvedByReviewerId: null, enabled: false }),
        dataset: mixedDataset(),
      }),
    );
    expect(run.matchedItems).toBe(2);
  });

  it('measures a rule an operator has just disabled', () => {
    // Spec 10's emergency controls kill a rule version; the rule somebody then needs to measure
    // while working out what it did is exactly that one.
    const run = runShadow(request({ rule: rule({ enabled: false }), dataset: mixedDataset() }));
    expect(run.matchedItems).toBe(2);
  });

  it('leaves the caller rule untouched', () => {
    // The projection is local. A caller that passed a candidate rule in still holds a candidate
    // rule afterwards.
    const candidate = rule({ reviewState: 'CANDIDATE', approvedByReviewerId: null });
    runShadow(request({ rule: candidate, dataset: mixedDataset() }));
    expect(candidate.reviewState).toBe('CANDIDATE');
    expect(candidate.approvedByReviewerId).toBeNull();
  });

  it('names the stand-in as something that is not a reviewer', () => {
    // A shadow result that somehow reached a table would carry this string, which is not a user
    // ID and does not resemble one.
    expect(SHADOW_EVALUATION_MARKER).toMatch(/NOT_A_REVIEWER/);
  });

  it('still refuses to evaluate a live rule', () => {
    // The one gate the projection does not touch, and the reason the rest is safe.
    expect(() => runShadow(request({ rule: rule({ shadowMode: false, enabled: true }) }))).toThrow(
      /shadow mode/i,
    );
  });

  it('marks every assessment it produces as shadow-only', () => {
    // Belt and braces: even a result that escaped this module names itself.
    const shadowRule = rule();
    expect(shadowRule.shadowMode).toBe(true);
    expect(
      evaluateRule({
        rule: { ...shadowRule, reviewState: 'APPROVED', approvedByReviewerId: 'x', enabled: true },
        item: item(),
        profileFacts: [],
        actionSignals: [signal()],
        normalizationVersion: 'norm-1',
        evaluationInstant: NOW,
      }).shadowOnly,
    ).toBe(true);
  });
});
