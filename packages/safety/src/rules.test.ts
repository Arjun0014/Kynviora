import { describe, it, expect } from 'vitest';
import {
  evaluateRule,
  evaluateRules,
  replayAssessment,
  downgradeUrgency,
  EXPIRY_WARNING_WINDOW_DAYS,
  type AssessmentInputs,
  type AssessmentRuleVersion,
  type OwnedItemSnapshot,
  type ProfileFact,
  type ActionSignal,
} from './rules.js';
import { instantFrom, type ActionUrgency } from '@kynviora/domain';

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
    shadowMode: false,
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

function inputs(overrides: Partial<AssessmentInputs> = {}): AssessmentInputs {
  return {
    rule: rule(),
    item: item(),
    profileFacts: [],
    actionSignals: [signal()],
    normalizationVersion: 'norm-1',
    evaluationInstant: NOW,
    ...overrides,
  };
}

describe('universal gates', () => {
  it('does not fire a disabled rule', () => {
    // Spec 10 emergency controls: an operator must be able to disable one rule version.
    const result = evaluateRule(inputs({ rule: rule({ enabled: false }) }));
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('RULE_DISABLED');
  });

  it('does not fire an unapproved rule', () => {
    // An unapproved rule producing a match would be the unauthorized publication path of
    // threat A3 (fake high-severity safety alert).
    for (const state of ['CANDIDATE', 'IN_REVIEW', 'REJECTED'] as const) {
      const result = evaluateRule(inputs({ rule: rule({ reviewState: state }) }));
      expect(result.matched).toBe(false);
      expect(result.reasons).toContain('RULE_NOT_APPROVED');
    }
  });

  it('does not fire an approved rule with no named reviewer', () => {
    // Spec 10 and operating brief 39: engineering must never represent that review occurred.
    const result = evaluateRule(
      inputs({ rule: rule({ reviewState: 'PUBLISHED', approvedByReviewerId: null }) }),
    );
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('RULE_NOT_APPROVED');
  });

  it('does not fire for an inactive item', () => {
    const result = evaluateRule(inputs({ item: item({ isActive: false }) }));
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('ITEM_NOT_ACTIVE');
  });

  it('gives a non-match no urgency', () => {
    const result = evaluateRule(inputs({ item: item({ isActive: false }) }));
    expect(result.urgency).toBe('INFORMATIONAL');
    expect(result.matchConfidence).toBe('NOT_MATCHED');
  });
});

describe('batch action matching (spec 31 fixture: only matching batches affected)', () => {
  it('matches EXACTLY when the recorded lot is named in the action', () => {
    const result = evaluateRule(inputs());
    expect(result.matched).toBe(true);
    expect(result.matchConfidence).toBe('EXACT');
    expect(result.reasons).toContain('BATCH_CODE_MATCHED');
    expect(result.urgency).toBe('HIGH');
  });

  it('does NOT match when the recorded lot is not in the action', () => {
    // The core of the fixture scenario. We know this user's lot, and it is not affected.
    // Alerting anyway would be a false positive on data we actually hold.
    const result = evaluateRule(inputs({ item: item({ lotCode: 'B99Z00' }) }));
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('NO_SIGNAL_MATCHED');
  });

  it('matches PROBABLE with reduced urgency when no lot is recorded', () => {
    // The user may well hold an unaffected batch. Claiming EXACT would overstate certainty.
    const result = evaluateRule(inputs({ item: item({ lotCode: null }) }));
    expect(result.matched).toBe(true);
    expect(result.matchConfidence).toBe('PROBABLE');
    expect(result.reasons).toContain('GTIN_MATCHED_BATCH_UNKNOWN');
    expect(result.urgency).toBe('MEDIUM'); // downgraded from HIGH
  });

  it('normalizes lot codes when comparing', () => {
    const result = evaluateRule(inputs({ item: item({ lotCode: 'a24-x91' }) }));
    expect(result.matched).toBe(true);
    expect(result.matchConfidence).toBe('EXACT');
  });

  it('does not match a different product', () => {
    const result = evaluateRule(inputs({ item: item({ gtin: '00000000000000' }) }));
    expect(result.matched).toBe(false);
  });

  it('reports missing identifiers rather than guessing', () => {
    const result = evaluateRule(inputs({ item: item({ gtin: null, formulationId: null }) }));
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('MISSING_REQUIRED_IDENTIFIERS');
  });

  it('refuses to fire when batch verification is below the rule requirement', () => {
    const result = evaluateRule(
      inputs({
        rule: rule({ requiredItemVerification: ['CONFIRMED'] }),
        item: item({ batchVerification: 'UNVERIFIED' }),
      }),
    );
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('INSUFFICIENT_ITEM_VERIFICATION');
  });
});

describe('ingredient sensitivity (spec 06 Journey 4, threat A5)', () => {
  const sensitivityRule = rule({
    kind: 'INGREDIENT_SENSITIVITY',
    maxUrgency: 'MEDIUM',
    evidenceLevel: 'B',
    explanationTemplateId: 'tpl-sensitivity-v1',
    requiredItemVerification: ['CONFIRMED'],
    requiredProfileProvenance: ['USER_REPORTED', 'REVIEWER_CONFIRMED'],
  });

  function fact(overrides: Partial<ProfileFact> = {}): ProfileFact {
    return {
      id: 'fact-1',
      kind: 'ALLERGY',
      substanceCanonicalKey: 'SALICYLIC_ACID',
      displayTerm: 'salicylates',
      provenance: 'USER_REPORTED',
      recordedAt: NOW,
      version: 'pf-1',
      ...overrides,
    };
  }

  it('matches when a recorded sensitivity appears in the confirmed declaration', () => {
    const result = evaluateRule(
      inputs({
        rule: sensitivityRule,
        item: item({ substanceKeys: ['WATER', 'SALICYLIC_ACID'] }),
        profileFacts: [fact()],
      }),
    );
    expect(result.matched).toBe(true);
    expect(result.matchConfidence).toBe('EXACT');
    expect(result.reasons).toContain('SUBSTANCE_IN_DECLARATION');
    expect(result.urgency).toBe('MEDIUM');
  });

  it('does not fire when the formulation is unverified', () => {
    // Threat A5: a wrong formula causing a false allergy alert. Spec 09 requires the rule to
    // demand eligible formula provenance before it may rely on the declaration.
    const result = evaluateRule(
      inputs({
        rule: sensitivityRule,
        item: item({ formulationVerification: 'UNVERIFIED', substanceKeys: ['SALICYLIC_ACID'] }),
        profileFacts: [fact()],
      }),
    );
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('INSUFFICIENT_ITEM_VERIFICATION');
  });

  it('does not fire on a profile fact with inadequate provenance', () => {
    // Spec 04 Phase 1.3: rules can require a provenance level before using a fact, and no OCR or
    // inferred fact silently becomes a confirmed diagnosis.
    const result = evaluateRule(
      inputs({
        rule: sensitivityRule,
        item: item({ substanceKeys: ['SALICYLIC_ACID'] }),
        profileFacts: [fact({ provenance: 'PACKAGE_OCR' })],
      }),
    );
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('INSUFFICIENT_PROFILE_PROVENANCE');
  });

  it('does not fire on an un-normalized free-text fact', () => {
    // An unmapped term cannot be matched against a canonical declaration without guessing.
    const result = evaluateRule(
      inputs({
        rule: sensitivityRule,
        item: item({ substanceKeys: ['SALICYLIC_ACID'] }),
        profileFacts: [fact({ substanceCanonicalKey: null })],
      }),
    );
    expect(result.matched).toBe(false);
  });

  it('does not fire when the substance is absent from the declaration', () => {
    const result = evaluateRule(
      inputs({
        rule: sensitivityRule,
        item: item({ substanceKeys: ['WATER', 'GLYCERIN'] }),
        profileFacts: [fact()],
      }),
    );
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('NO_SIGNAL_MATCHED');
  });

  it('reports no eligible fact when the profile has none', () => {
    const result = evaluateRule(
      inputs({ rule: sensitivityRule, item: item({ substanceKeys: ['SALICYLIC_ACID'] }) }),
    );
    expect(result.reasons).toContain('NO_ELIGIBLE_PROFILE_FACT');
  });

  it('records exactly which profile fact version drove the match', () => {
    // Spec 06 Journey 4 requires the alert to identify why the rule applied; spec 09 requires
    // the exact versions to be stored for replay.
    const result = evaluateRule(
      inputs({
        rule: sensitivityRule,
        item: item({ substanceKeys: ['SALICYLIC_ACID'] }),
        profileFacts: [
          fact({ version: 'pf-7' }),
          fact({ id: 'f2', substanceCanonicalKey: 'X', version: 'pf-8' }),
        ],
      }),
    );
    expect(result.inputVersions.profileFactVersions).toEqual(['pf-7']);
  });
});

describe('expiry', () => {
  const expiryRule = rule({
    kind: 'EXPIRY',
    maxUrgency: 'MEDIUM',
    evidenceLevel: 'B',
    explanationTemplateId: 'tpl-expiry-v1',
  });

  it('matches an expired product', () => {
    const result = evaluateRule(
      inputs({ rule: expiryRule, item: item({ expiresOn: '2026-01-01' }) }),
    );
    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('PRODUCT_EXPIRED');
    expect(result.urgency).toBe('MEDIUM');
  });

  it('matches a product expiring inside the warning window with lower urgency', () => {
    const result = evaluateRule(
      inputs({ rule: expiryRule, item: item({ expiresOn: '2026-09-10' }) }),
    );
    expect(result.matched).toBe(true);
    expect(result.reasons).toContain('PRODUCT_EXPIRING_SOON');
    expect(result.urgency).toBe('LOW');
  });

  it('does not match a product expiring beyond the window', () => {
    const result = evaluateRule(
      inputs({ rule: expiryRule, item: item({ expiresOn: '2027-01-01' }) }),
    );
    expect(result.matched).toBe(false);
  });

  it('reports no expiry recorded rather than assuming one', () => {
    const result = evaluateRule(inputs({ rule: expiryRule, item: item({ expiresOn: null }) }));
    expect(result.matched).toBe(false);
    expect(result.reasons).toContain('NO_EXPIRY_RECORDED');
  });

  it('uses the supplied instant, not ambient time, so replay is stable', () => {
    // The same item evaluated for two different instants gives different answers - which is the
    // point: recomputing a past assessment must use the date it was computed for.
    const expiring = item({ expiresOn: '2026-09-10' });
    const inWindow = evaluateRule(inputs({ rule: expiryRule, item: expiring }));
    const longBefore = evaluateRule(
      inputs({
        rule: expiryRule,
        item: expiring,
        evaluationInstant: instantFrom('2026-01-01T00:00:00.000Z'),
      }),
    );
    expect(inWindow.matched).toBe(true);
    expect(longBefore.matched).toBe(false);
  });

  it('uses a 30-day warning window', () => {
    expect(EXPIRY_WARNING_WINDOW_DAYS).toBe(30);
  });
});

describe('urgency can only be lowered (spec 12, 17)', () => {
  it('downgrades one step at a time', () => {
    expect(downgradeUrgency('CRITICAL')).toBe('HIGH');
    expect(downgradeUrgency('HIGH')).toBe('MEDIUM');
    expect(downgradeUrgency('MEDIUM')).toBe('LOW');
    expect(downgradeUrgency('LOW')).toBe('INFORMATIONAL');
    expect(downgradeUrgency('INFORMATIONAL')).toBe('INFORMATIONAL');
  });

  it('never exceeds the rule ceiling', () => {
    // maxUrgency is what a reviewer approved. Evaluation may move below it but never above.
    const urgencies: ActionUrgency[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'];
    const order = (u: ActionUrgency) => urgencies.indexOf(u);

    for (const ceiling of urgencies) {
      const exact = evaluateRule(inputs({ rule: rule({ maxUrgency: ceiling }) }));
      const probable = evaluateRule(
        inputs({ rule: rule({ maxUrgency: ceiling }), item: item({ lotCode: null }) }),
      );
      expect(order(exact.urgency)).toBeGreaterThanOrEqual(order(ceiling));
      expect(order(probable.urgency)).toBeGreaterThanOrEqual(order(ceiling));
    }
  });

  it('exports no function that raises urgency', async () => {
    const module = await import('./rules.js');
    const names = Object.keys(module);
    expect(names).toContain('downgradeUrgency');
    for (const forbidden of ['upgradeUrgency', 'escalateUrgency', 'raiseUrgency']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('evidence level is never computed (spec 23 D-005/D-006)', () => {
  it('copies the evidence level from the rule verbatim', () => {
    for (const level of ['A', 'B', 'C', 'D', 'U'] as const) {
      const result = evaluateRule(inputs({ rule: rule({ evidenceLevel: level }) }));
      expect(result.evidenceLevel).toBe(level);
    }
  });

  it('keeps evidence level independent of match outcome', () => {
    // A non-match still reports the rule's evidence level; only urgency responds to matching.
    const matched = evaluateRule(inputs({ rule: rule({ evidenceLevel: 'A' }) }));
    const unmatched = evaluateRule(
      inputs({ rule: rule({ evidenceLevel: 'A' }), item: item({ gtin: '00000000000000' }) }),
    );
    expect(matched.evidenceLevel).toBe('A');
    expect(unmatched.evidenceLevel).toBe('A');
    expect(matched.urgency).not.toBe(unmatched.urgency);
  });

  it('produces no combined score field', () => {
    const result = evaluateRule(inputs());
    const keys = Object.keys(result);
    for (const forbidden of ['score', 'safetyScore', 'riskScore', 'severity', 'rating']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('shadow mode (spec 04 Phase 6.7)', () => {
  it('marks a shadow assessment so it produces no user-visible alert', () => {
    const result = evaluateRule(inputs({ rule: rule({ shadowMode: true }) }));
    expect(result.matched).toBe(true);
    expect(result.shadowOnly).toBe(true);
  });

  it('still evaluates fully in shadow mode, so match volume can be measured', () => {
    const shadow = evaluateRule(inputs({ rule: rule({ shadowMode: true }) }));
    const live = evaluateRule(inputs({ rule: rule({ shadowMode: false }) }));
    expect(shadow.matched).toBe(live.matched);
    expect(shadow.matchConfidence).toBe(live.matchConfidence);
    expect(shadow.urgency).toBe(live.urgency);
  });
});

describe('reproducibility (spec 09: replaying the same versions reproduces the result)', () => {
  it('produces identical output for identical inputs', () => {
    expect(evaluateRule(inputs())).toEqual(evaluateRule(inputs()));
  });

  it('records every input version needed to replay', () => {
    const result = evaluateRule(
      inputs({
        item: item({ formulationVersion: 'fv-9' }),
        actionSignals: [signal({ version: 'sv-3' })],
        normalizationVersion: 'norm-4',
      }),
    );
    expect(result.inputVersions.formulationVersion).toBe('fv-9');
    expect(result.inputVersions.normalizationVersion).toBe('norm-4');
    expect(result.inputVersions.actionSignalVersions).toEqual(['sv-3']);
    expect(result.ruleVersion).toBe('v1');
  });

  it('confirms reproduction when replayed with the same inputs', () => {
    const original = evaluateRule(inputs());
    const replay = replayAssessment(original, inputs());
    expect(replay.reproduced).toBe(true);
    expect(replay.differences).toEqual([]);
  });

  it('reports exactly what changed when an input version changes', () => {
    // The mechanism behind spec 07.4 Evidence Diff: distinguishing a regulator change from a
    // Kynviora correction requires knowing which field moved.
    const original = evaluateRule(inputs());
    const replay = replayAssessment(original, inputs({ item: item({ lotCode: 'B99Z00' }) }));
    expect(replay.reproduced).toBe(false);
    expect(replay.differences).toContain('matched');
    expect(replay.differences).toContain('matchConfidence');
  });

  it('detects an urgency change after a rule version is revised', () => {
    const original = evaluateRule(inputs());
    const replay = replayAssessment(
      original,
      inputs({ rule: rule({ maxUrgency: 'CRITICAL', version: 'v2' }) }),
    );
    expect(replay.reproduced).toBe(false);
    expect(replay.differences).toContain('urgency');
  });

  it('performs no I/O and reads no ambient clock', () => {
    // Verified structurally: evaluateRule takes evaluationInstant as an argument, and the eslint
    // no-restricted-syntax rule bans bare new Date() in production code. This test pins the
    // observable consequence - two evaluations separated in wall-clock time are identical.
    const first = evaluateRule(inputs());
    const second = evaluateRule(inputs());
    expect(first.evaluatedAt).toBe(second.evaluatedAt);
    expect(first.evaluatedAt).toBe(NOW);
  });
});

describe('unimplemented rule kinds fail closed', () => {
  it('does not fire the duplicate-active-ingredient rule', () => {
    // Spec 09 requires validated reference data and clinical review before this rule may exist
    // at all (BLK-006). A non-match is the correct conservative behaviour; a placeholder that
    // could fire would be worse than nothing.
    const result = evaluateRule(inputs({ rule: rule({ kind: 'DUPLICATE_ACTIVE_INGREDIENT' }) }));
    expect(result.matched).toBe(false);
  });

  it('does not fire the formulation-change review rule', () => {
    const result = evaluateRule(inputs({ rule: rule({ kind: 'FORMULATION_CHANGE_REVIEW' }) }));
    expect(result.matched).toBe(false);
  });
});

describe('evaluateRules', () => {
  it('returns one independent assessment per rule, never an aggregate', () => {
    const rules = [
      rule({ id: 'r1', kind: 'BATCH_ACTION_MATCH' }),
      rule({ id: 'r2', kind: 'EXPIRY', maxUrgency: 'LOW' }),
    ];
    const results = evaluateRules(rules, (r) => inputs({ rule: r }));

    expect(results).toHaveLength(2);
    expect(results[0]?.ruleId).toBe('r1');
    expect(results[1]?.ruleId).toBe('r2');
    // Each stands on its own inputs; nothing is combined into a single verdict.
    expect(results[0]?.matched).toBe(true);
    expect(results[1]?.matched).toBe(false);
  });
});
