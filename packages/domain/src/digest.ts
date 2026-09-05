/**
 * The digest: what `MEDIUM` and `LOW` events become instead of a phone lighting up.
 *
 * Spec references: `04` Phase 7.5 (digest policy for lower urgency; a stale or corrected
 * notification cannot remain actionable without revalidation), `09` (a withdrawn alert must stop
 * being actionable), `16` (a notification reveals minimal information), `02` (not interrupting is
 * the default rather than a degradation), DEC-119, `DEV-033`.
 *
 * WHAT A DIGEST IS AND WHAT IT IS NOT
 * It is a **record of what accumulated**, assembled once per recipient-local day and revalidated
 * at the moment of assembly. It is not a delivery: nothing sends it (`BLK-009`), and the events
 * in it were already reachable in the app through the Safety Inbox and the Shelf - which is what
 * `DIGEST` and `IN_APP_ONLY` both mean today. What assembling adds is the thing `04` Phase 7.5
 * actually asks for: a summary that has been checked against reality at the time it is presented,
 * rather than a list of notifications that were true when they were classified.
 *
 * REVALIDATION IS THE POINT, NOT A PRECAUTION
 * The gap between an event being classified for a digest and the digest being assembled is up to a
 * day. In that day an alert can be withdrawn, superseded, corrected, or become unreadable because
 * a caregiver's grant was revoked. A summary that reported any of those as current would breach
 * Phase 7.5's own second exit criterion - and it would do it in the one format nobody re-reads,
 * because a digest looks like a settled account of what happened.
 *
 * SO THE ASSEMBLY IS A FILTER, AND EVERY DROP IS RECORDED
 * {@link assembleDigest} keeps only `STILL_CURRENT`, and writes down the outcome for everything it
 * dropped. "Why is this not in my digest" and "why did that one disappear" are the two questions a
 * digest generates, and neither is answerable from a list of what survived.
 *
 * WHY A DROPPED ITEM IS NOT RECONSIDERED TOMORROW
 * Because it was considered. An alert withdrawn on Tuesday is still withdrawn on Wednesday, and a
 * candidate set that re-examined it every morning would grow without bound and re-answer a settled
 * question daily. Recording the outcome is what closes it - which is why the record has a row per
 * candidate rather than a row per included item.
 */

import type { Instant } from './ports.js';
import { revalidate, type RevalidationOutcome } from './notificationPolicy.js';
import { recipientLocalDate, recipientLocalMinute } from './timeZone.js';

// ---------------------------------------------------------------------------
// The cadence
// ---------------------------------------------------------------------------

/**
 * 09:00, in the recipient's own morning.
 *
 * The approved cadence (`04` Phase 7.5, DEC-119). Recipient-local rather than server-local for
 * exactly the reason quiet hours are: a caregiver in London looking after somebody in Kolkata has
 * their own morning, and a digest that arrived in the middle of somebody's night would be the
 * interruption the digest exists to avoid.
 */
export const DIGEST_LOCAL_HOUR = 9;
export const DIGEST_LOCAL_MINUTE_OF_DAY = DIGEST_LOCAL_HOUR * 60;

/** Why a recipient is not due for a digest right now. */
export const DIGEST_NOT_DUE_REASONS = [
  /**
   * Nobody knows what time it is where they are.
   *
   * No digest is assembled, deliberately. DEC-119 refuses to invent a zone for quiet hours and
   * this is the same refusal at the other end: assembling at a guessed hour would mean telling
   * somebody "here is your morning" at four in the morning. Their events stay exactly where they
   * already are - reachable in the app - which is why not assembling is the safe direction here,
   * even though "do not hold" is the safe direction for a quiet-hours decision.
   */
  'ZONE_UNKNOWN',
  /** Their morning has not come round yet today. */
  'BEFORE_LOCAL_HOUR',
  /** They already have one for this local date. One digest per day is what a digest is. */
  'ALREADY_ASSEMBLED',
] as const;
export type DigestNotDueReason = (typeof DIGEST_NOT_DUE_REASONS)[number];

export interface DigestDueInput {
  readonly at: Instant;
  /** The recipient's IANA zone, or anything at all - it is validated, not trusted. */
  readonly zone: unknown;
  /** The local date of this recipient's most recent digest, `YYYY-MM-DD`, or `null` for none. */
  readonly lastLocalDate: string | null;
}

export type DigestDue =
  | { readonly due: false; readonly reason: DigestNotDueReason }
  | { readonly due: true; readonly localDate: string };

/**
 * Whether this recipient's digest is due, and for which local date.
 *
 * Pure and total. Note what it does **not** take: whether they have anything to put in one. A
 * recipient with nothing accumulated is still due, and assembling an empty digest for them is the
 * caller's decision rather than this function's - a digest that said "nothing happened" is a
 * legitimate product answer and a digest that was skipped is a different fact, and only the caller
 * knows which one it wants.
 */
export function digestDue(input: DigestDueInput): DigestDue {
  const localDate = recipientLocalDate({ at: input.at, zone: input.zone });
  const localMinute = recipientLocalMinute({ at: input.at, zone: input.zone });

  if (localDate === null || localMinute === null) {
    return { due: false, reason: 'ZONE_UNKNOWN' };
  }
  if (input.lastLocalDate === localDate) {
    // Checked before the hour, so a second pass on the same afternoon is `ALREADY_ASSEMBLED`
    // rather than something that reads like a clock problem.
    return { due: false, reason: 'ALREADY_ASSEMBLED' };
  }
  if (localMinute < DIGEST_LOCAL_MINUTE_OF_DAY) {
    return { due: false, reason: 'BEFORE_LOCAL_HOUR' };
  }
  return { due: true, localDate };
}

// ---------------------------------------------------------------------------
// The assembly
// ---------------------------------------------------------------------------

/**
 * One delivery being considered for a digest, as it stands **now**.
 *
 * `currentState` is the alert's state read **as the recipient**, which is what makes `null`
 * meaningful: under row-level security a withdrawn alert, a superseded one and one whose caregiver
 * grant was revoked all produce no row at all. The three are indistinguishable from here, and that
 * is deliberate rather than a limitation to work around - a digest that said "this was withdrawn"
 * about an alert the reader is no longer entitled to see would be answering from a position they
 * do not occupy.
 */
export interface DigestCandidate {
  readonly alertDeliveryId: string;
  /** When they were told. Always present: a candidate is a delivery that happened. */
  readonly notifiedAt: Instant;
  readonly currentState: string | null;
  readonly lastCorrectedAt: Instant | null;
}

export interface DigestEntry {
  readonly alertDeliveryId: string;
  readonly outcome: RevalidationOutcome;
  /** True only for `STILL_CURRENT`. Derived, so the two can never disagree. */
  readonly included: boolean;
}

export interface AssembledDigest {
  /** Every candidate, in the order given, whether it survived or not. */
  readonly entries: readonly DigestEntry[];
  readonly includedCount: number;
  readonly droppedCount: number;
}

/**
 * Revalidate every candidate and keep the ones that are still true.
 *
 * Pure: the re-read happened before this was called, because reading is the caller's job and
 * deciding what a read means is this module's. That split is what lets the rule be tested without
 * a database and the queries be tested without the rule.
 */
export function assembleDigest(candidates: readonly DigestCandidate[]): AssembledDigest {
  const entries = candidates.map((candidate): DigestEntry => {
    const outcome = revalidate({
      notifiedAt: candidate.notifiedAt,
      currentState: candidate.currentState,
      lastCorrectedAt: candidate.lastCorrectedAt,
    });
    return {
      alertDeliveryId: candidate.alertDeliveryId,
      outcome: outcome.outcome,
      // `actionable` is `revalidate`'s own answer to "may this still be offered", and a digest
      // line is an offer. Reading it rather than re-deriving `outcome === 'STILL_CURRENT'` means
      // there is one definition of "still true" in this codebase rather than two that agree today.
      included: outcome.actionable,
    };
  });

  const includedCount = entries.filter((entry) => entry.included).length;
  return { entries, includedCount, droppedCount: entries.length - includedCount };
}
