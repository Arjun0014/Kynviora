/**
 * Which items need verification or review, and why.
 *
 * Spec references: `04` Phase 2.1 (the Unified Health Shelf; profile / category / verification /
 * attention filters; item detail - with the exit criteria "medicines and personal-care items
 * coexist without either being reduced to a generic note" and "a user can understand which items
 * need verification or review"), `08` (the Product Trust Passport keeps identity, formulation and
 * batch separate), `02` (no aggregate score, no alarm-optimised design), `18`, `10`.
 *
 * A REASON LIST, NOT A SCORE
 * This module answers "what is not settled about this item" with a list of named facts. It does
 * not answer "how bad is this item", and there is no number, rank or ordering anywhere in it.
 * `02` forbids an aggregate Trust Passport score, and a single "needs attention: 3" is that score
 * with the word left off - as is a list sorted by how much each entry ought to worry somebody.
 *
 * EVERY REASON IS A COLUMN, NOT A JUDGEMENT
 * Each member below is decided by one stored value being one of a stated set. Nothing here is
 * derived from how long ago something happened, how many axes are unconfirmed, or what kind of
 * item it is. `10` requires Kynviora to state its limits where it states its findings, and a
 * reason a person cannot trace back to a field on their own record is not a limit, it is an
 * opinion.
 *
 * WHY THERE IS NO "STALE REVIEW" MEMBER
 * "Reviewed too long ago" needs an interval, and nobody has set one. `BLK-008` records that every
 * numeric threshold in this build is unset pending real data, and an invented 90 days would be a
 * threshold arriving through the back door on the screen a household reads most.
 * `NEVER_REVIEWED` is a different statement - it is the absence of a timestamp, not a judgement
 * about its age - and that is the one this build can make honestly.
 */

import type { ItemVerification } from './vocabulary.js';

/**
 * Verification states that leave a facet unsettled.
 *
 * `CONFLICTING` and `UNVERIFIED` are different problems and both are unsettled: one means two
 * sources disagreed, the other means nobody has looked. `PARTIAL` and `PROBABLE` are deliberately
 * not here - they are progress a person made, and flagging them would ask somebody to re-do work
 * they have already done.
 */
export const UNSETTLED_VERIFICATIONS: readonly ItemVerification[] = Object.freeze([
  'CONFLICTING',
  'UNVERIFIED',
]);

export function isUnsettled(verification: ItemVerification): boolean {
  return UNSETTLED_VERIFICATIONS.includes(verification);
}

/**
 * Why an item is not settled.
 *
 * One member per facet rather than a single `NEEDS_VERIFICATION`, because `08` keeps the three
 * axes separate and a merged reason would be the aggregate this module refuses. `CONFLICTING`
 * gets its own members for the same reason: "two sources disagreed about what this is" and
 * "nobody has checked what this is" call for different actions from the person reading it.
 */
export const ATTENTION_REASONS = [
  'IDENTITY_UNVERIFIED',
  'IDENTITY_CONFLICTING',
  'FORMULATION_UNVERIFIED',
  'FORMULATION_CONFLICTING',
  'BATCH_UNVERIFIED',
  'BATCH_CONFLICTING',
  'NEVER_REVIEWED',
  'NEVER_SAFETY_CHECKED',
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/**
 * The two kinds a filter may ask for.
 *
 * `04` Phase 2.1 lists a "verification" filter and an "attention" filter as separate expected
 * output, and they are separate questions: one is about what Kynviora knows about the product,
 * the other about whether anybody has looked at the record.
 */
export const ATTENTION_KINDS = ['NEEDS_VERIFICATION', 'NEEDS_REVIEW'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** Which kind each reason belongs to. A total record, so a new reason is classified explicitly. */
export const ATTENTION_KIND_FOR_REASON: Readonly<Record<AttentionReason, AttentionKind>> =
  Object.freeze({
    IDENTITY_UNVERIFIED: 'NEEDS_VERIFICATION',
    IDENTITY_CONFLICTING: 'NEEDS_VERIFICATION',
    FORMULATION_UNVERIFIED: 'NEEDS_VERIFICATION',
    FORMULATION_CONFLICTING: 'NEEDS_VERIFICATION',
    BATCH_UNVERIFIED: 'NEEDS_VERIFICATION',
    BATCH_CONFLICTING: 'NEEDS_VERIFICATION',
    NEVER_REVIEWED: 'NEEDS_REVIEW',
    NEVER_SAFETY_CHECKED: 'NEEDS_REVIEW',
  });

export interface AttentionInput {
  readonly identityVerification: ItemVerification;
  readonly formulationVerification: ItemVerification;
  readonly batchVerification: ItemVerification;
  readonly lastReviewedAt: string | null;
  readonly lastSafetyCheckedAt: string | null;
  /**
   * The item's lifecycle state.
   *
   * A stopped or archived item is not asked to be verified. Nothing about it is going to be used,
   * and a shelf that kept nagging about packs somebody has finished with is the alarm-optimised
   * design `02` refuses - it also teaches people to ignore the list that matters.
   */
  readonly lifecycleState: string;
}

/**
 * Everything unsettled about one item, in vocabulary order.
 *
 * Not sorted by severity. Whether an unconfirmed batch matters more than an unconfirmed
 * formulation depends on what the person is doing with the pack, which this code does not know -
 * the same reason DEC-065 refuses to order the Lens cards.
 */
export function attentionReasons(input: AttentionInput): readonly AttentionReason[] {
  if (input.lifecycleState !== 'ACTIVE') return [];

  const present = new Set<AttentionReason>();

  const axes = [
    ['IDENTITY', input.identityVerification],
    ['FORMULATION', input.formulationVerification],
    ['BATCH', input.batchVerification],
  ] as const;

  for (const [facet, verification] of axes) {
    if (verification === 'CONFLICTING') present.add(`${facet}_CONFLICTING` as AttentionReason);
    else if (verification === 'UNVERIFIED') present.add(`${facet}_UNVERIFIED` as AttentionReason);
  }

  // The absence of a timestamp, not a judgement about its age. See the module note on `BLK-008`.
  if (input.lastReviewedAt === null) present.add('NEVER_REVIEWED');
  if (input.lastSafetyCheckedAt === null) present.add('NEVER_SAFETY_CHECKED');

  return ATTENTION_REASONS.filter((reason) => present.has(reason));
}

/** Whether an item has anything unsettled of the given kind. */
export function needsAttention(
  reasons: readonly AttentionReason[],
  kind: AttentionKind | null = null,
): boolean {
  if (kind === null) return reasons.length > 0;
  return reasons.some((reason) => ATTENTION_KIND_FOR_REASON[reason] === kind);
}
