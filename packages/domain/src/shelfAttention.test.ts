import { describe, it, expect } from 'vitest';
import { ITEM_VERIFICATIONS, type ItemVerification } from './vocabulary.js';
import {
  ATTENTION_KINDS,
  ATTENTION_KIND_FOR_REASON,
  ATTENTION_REASONS,
  UNSETTLED_VERIFICATIONS,
  attentionReasons,
  isUnsettled,
  needsAttention,
  type AttentionInput,
} from './shelfAttention.js';

function item(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return {
    identityVerification: 'CONFIRMED',
    formulationVerification: 'CONFIRMED',
    batchVerification: 'CONFIRMED',
    lastReviewedAt: '2026-09-01T12:00:00.000Z',
    lastSafetyCheckedAt: '2026-09-01T12:00:00.000Z',
    lifecycleState: 'ACTIVE',
    ...overrides,
  };
}

describe('which verification states are unsettled', () => {
  it('counts nobody having looked and two sources disagreeing, and nothing else', () => {
    expect([...UNSETTLED_VERIFICATIONS].sort()).toEqual(['CONFLICTING', 'UNVERIFIED']);
  });

  it('does not count progress somebody already made', () => {
    // Flagging PARTIAL or PROBABLE asks a person to re-do work they have done.
    for (const verification of ['CONFIRMED', 'PROBABLE', 'PARTIAL'] as const) {
      expect(isUnsettled(verification)).toBe(false);
    }
  });

  it('classifies every member of the verification vocabulary', () => {
    for (const verification of ITEM_VERIFICATIONS) {
      expect(typeof isUnsettled(verification)).toBe('boolean');
    }
  });
});

describe('what is not settled about an item', () => {
  it('says nothing about an item where everything has been entered', () => {
    expect(attentionReasons(item())).toEqual([]);
  });

  it('names each facet separately rather than merging them', () => {
    // `08` keeps the three axes separate and `02` forbids the aggregate. One
    // `NEEDS_VERIFICATION` covering all three would be that aggregate with the number left off.
    const reasons = attentionReasons(
      item({
        identityVerification: 'UNVERIFIED',
        formulationVerification: 'UNVERIFIED',
        batchVerification: 'UNVERIFIED',
      }),
    );
    expect(reasons).toEqual(['IDENTITY_UNVERIFIED', 'FORMULATION_UNVERIFIED', 'BATCH_UNVERIFIED']);
  });

  it('separates a disagreement from an absence', () => {
    // "Two sources disagreed about what this is" and "nobody has checked" call for different
    // actions from the person reading it.
    expect(attentionReasons(item({ identityVerification: 'CONFLICTING' }))).toEqual([
      'IDENTITY_CONFLICTING',
    ]);
    expect(attentionReasons(item({ identityVerification: 'UNVERIFIED' }))).toEqual([
      'IDENTITY_UNVERIFIED',
    ]);
  });

  it('names an absent timestamp and never its age', () => {
    // `BLK-008`: every numeric threshold in this build is unset. An invented ninety days would be
    // a threshold arriving by the back door on the screen a household reads most.
    expect(attentionReasons(item({ lastReviewedAt: null }))).toEqual(['NEVER_REVIEWED']);
    expect(attentionReasons(item({ lastSafetyCheckedAt: null }))).toEqual(['NEVER_SAFETY_CHECKED']);
    // An old timestamp is still a timestamp.
    expect(attentionReasons(item({ lastReviewedAt: '2001-01-01T00:00:00.000Z' }))).toEqual([]);
  });

  it('asks nothing of an item somebody has finished with', () => {
    // A shelf that kept nagging about stopped packs is the alarm-optimised design `02` refuses,
    // and it teaches people to ignore the list that matters.
    for (const lifecycleState of ['STOPPED', 'ARCHIVED']) {
      expect(
        attentionReasons(
          item({
            lifecycleState,
            identityVerification: 'UNVERIFIED',
            lastReviewedAt: null,
            lastSafetyCheckedAt: null,
          }),
        ),
      ).toEqual([]);
    }
  });

  it('emits in vocabulary order rather than by how much each ought to worry somebody', () => {
    const reasons = attentionReasons(
      item({
        batchVerification: 'CONFLICTING',
        identityVerification: 'UNVERIFIED',
        lastReviewedAt: null,
      }),
    );
    const positions = reasons.map((r) => ATTENTION_REASONS.indexOf(r));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('never repeats a reason and never invents one', () => {
    const reasons = attentionReasons(
      item({
        identityVerification: 'CONFLICTING',
        formulationVerification: 'UNVERIFIED',
        batchVerification: 'CONFLICTING',
        lastReviewedAt: null,
        lastSafetyCheckedAt: null,
      }),
    );
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) expect(ATTENTION_REASONS).toContain(reason);
  });

  it('reports at most one reason per facet', () => {
    for (const verification of ITEM_VERIFICATIONS) {
      const reasons = attentionReasons(item({ identityVerification: verification }));
      expect(reasons.filter((r) => r.startsWith('IDENTITY_'))).toHaveLength(
        isUnsettled(verification) ? 1 : 0,
      );
    }
  });
});

describe('the two kinds a filter may ask for', () => {
  it('classifies every reason into exactly one kind', () => {
    for (const reason of ATTENTION_REASONS) {
      expect(ATTENTION_KINDS).toContain(ATTENTION_KIND_FOR_REASON[reason]);
    }
  });

  it('separates what Kynviora knows about the product from whether anybody looked', () => {
    const verification = attentionReasons(item({ identityVerification: 'UNVERIFIED' }));
    expect(needsAttention(verification, 'NEEDS_VERIFICATION')).toBe(true);
    expect(needsAttention(verification, 'NEEDS_REVIEW')).toBe(false);

    const review = attentionReasons(item({ lastReviewedAt: null }));
    expect(needsAttention(review, 'NEEDS_REVIEW')).toBe(true);
    expect(needsAttention(review, 'NEEDS_VERIFICATION')).toBe(false);
  });

  it('answers the unfiltered question too', () => {
    expect(needsAttention(attentionReasons(item()))).toBe(false);
    expect(needsAttention(attentionReasons(item({ lastReviewedAt: null })))).toBe(true);
  });
});

describe('what this module refuses to be', () => {
  it('returns a list rather than a count or a score', () => {
    const reasons = attentionReasons(
      item({ identityVerification: 'UNVERIFIED', lastReviewedAt: null }),
    );
    // `02` forbids an aggregate Trust Passport score, and "needs attention: 2" is that score with
    // the word left off. The reasons are named so a screen can say which, not how many.
    expect(Array.isArray(reasons)).toBe(true);
    for (const reason of reasons) expect(typeof reason).toBe('string');
  });

  it('has no reason whose name is a judgement about the product', () => {
    for (const reason of ATTENTION_REASONS) {
      // Each member is one stored value being one of a stated set. "RISKY" or "UNSAFE" would be a
      // conclusion this module has no basis for.
      expect(reason).not.toMatch(/RISK|UNSAFE|DANGER|URGENT|EXPIRED|RECALL/);
    }
  });

  it('depends on nothing but the fields it is given', () => {
    // Same input, same answer, whatever the item is called or which category it is in.
    const a = attentionReasons(item({ identityVerification: 'UNVERIFIED' as ItemVerification }));
    const b = attentionReasons(item({ identityVerification: 'UNVERIFIED' as ItemVerification }));
    expect(a).toEqual(b);
  });
});
