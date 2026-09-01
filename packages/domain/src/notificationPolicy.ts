/**
 * When a notification is sent, whether it interrupts, and whether it may still be acted on.
 *
 * Spec references: `04` Phase 7.5 (generic lock-screen notifications by default; urgency-based
 * delivery policy; foreign-regulatory informational update policy; deduplication identifiers;
 * digest policy for lower urgency; quiet hours; current-state revalidation when opened - with the
 * exit criteria "a new foreign restriction does not automatically produce a red/high-severity
 * personal alert" and "stale/corrected notifications cannot remain actionable without
 * revalidation"), `09` (a foreign ingredient restriction defaults to INFORMATIONAL), `02` (alarm
 * optimisation is an anti-feature), `15` A6 (a notification leaking health information to a lock
 * screen), `19` (a withdrawn alert that remains actionable is a release-blocking defect).
 *
 * WHAT THIS MODULE DOES NOT DO
 * It does not decide **who** is told or **how much** they are told. `alertDelivery` owns that
 * (Phase 8.2) and owns it alone: two modules answering "may this person see the medicine's name"
 * is two answers to a question that has one. This module answers three different questions - when,
 * through which channel, and whether what somebody was told still holds.
 *
 * THE TWO ARE COMPOSED, NOT MERGED
 * A delivery is `selectRecipients` deciding the audience and the level, then
 * {@link deliveryDecision} deciding the channel and the timing. Neither can widen the other: a
 * quiet-hours deferral cannot add a recipient, and an urgency cannot raise a detail level.
 */

import type { ActionUrgency, Jurisdiction } from './vocabulary.js';
import { FOREIGN_REGULATORY_DEFAULT_URGENCY } from './vocabulary.js';
import type { Instant } from './ports.js';

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * How an event reaches somebody, if it reaches them at all.
 *
 * Three, and the third is the one that matters. `IN_APP_ONLY` means Kynviora records the thing and
 * says nothing on anybody's device: no push, no digest line, nothing until the person opens the
 * app of their own accord. `04` asks for a "digest policy for lower urgency" and `02` names
 * alarm-optimised design as an anti-feature; between those two there has to be a floor below which
 * Kynviora does not speak at all, and this is it.
 */
export const DELIVERY_CHANNELS = ['INTERRUPT', 'DIGEST', 'IN_APP_ONLY'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

/**
 * The channel each urgency may use at most.
 *
 * A ceiling read from the urgency a reviewer approved on the rule, never computed from anything
 * observed at delivery time. `12` forbids the client upgrading severity and `23` D-005 forbids
 * evaluation adjusting evidence; this is the same discipline applied to the channel, which is the
 * loudest thing Kynviora controls.
 *
 * `INFORMATIONAL` is `IN_APP_ONLY`, and that single row is exit criterion 1. A foreign regulatory
 * difference defaults to `INFORMATIONAL` (`09`), so it can produce no push and no digest line -
 * not merely a quieter one. There is no configuration that raises it, because the criterion says
 * "does not automatically", and a default somebody can flip is a default.
 */
export const MAX_CHANNEL_FOR_URGENCY: Readonly<Record<ActionUrgency, DeliveryChannel>> =
  Object.freeze({
    CRITICAL: 'INTERRUPT',
    HIGH: 'INTERRUPT',
    MEDIUM: 'DIGEST',
    LOW: 'DIGEST',
    INFORMATIONAL: 'IN_APP_ONLY',
  });

/**
 * Urgencies that may interrupt quiet hours.
 *
 * One member. A recall on a medicine somebody is taking tonight is the case quiet hours must not
 * swallow; everything below it waits, because a phone lighting up at 3am about a pack that expires
 * in three weeks is exactly the alarm optimisation `02` refuses. `HIGH` waits despite being an
 * interrupt urgency: the difference between the two vocabularies is deliberate and is the whole
 * content of this constant.
 */
export const URGENCIES_PIERCING_QUIET_HOURS: readonly ActionUrgency[] = Object.freeze(['CRITICAL']);

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

export const MINUTES_PER_DAY = 24 * 60;

/**
 * A window in the recipient's own day, as minutes from local midnight.
 *
 * Local minutes rather than an instant and a timezone, because this module is told the recipient's
 * current local minute rather than computing it. Kynviora holds no timezone for anybody: there is
 * no column for one and no device has ever reported one (`BLK-002`), so a domain function that
 * converted an instant would be converting it with a number somebody invented. `DEV-030` records
 * the gap and where the value has to come from.
 *
 * `start` may exceed `end`, and usually does: 22:00 to 07:00 is the window people mean.
 */
export interface QuietHours {
  readonly startMinute: number;
  readonly endMinute: number;
}

export function isValidQuietHours(window: QuietHours): boolean {
  return (
    Number.isInteger(window.startMinute) &&
    Number.isInteger(window.endMinute) &&
    window.startMinute >= 0 &&
    window.startMinute < MINUTES_PER_DAY &&
    window.endMinute >= 0 &&
    window.endMinute < MINUTES_PER_DAY &&
    // Equal bounds would be a zero-length window or a whole-day one depending on which way it was
    // read, and a rule whose meaning depends on the reader has no place deciding whether somebody
    // is woken up.
    window.startMinute !== window.endMinute
  );
}

/**
 * Whether a local minute falls inside the window.
 *
 * Half-open: the start minute is inside and the end minute is outside, so 22:00-07:00 and
 * 07:00-22:00 partition the day rather than overlapping at both ends.
 */
export function withinQuietHours(localMinuteOfDay: number, window: QuietHours): boolean {
  if (!isValidQuietHours(window)) return false;
  const minute = ((localMinuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return window.startMinute < window.endMinute
    ? minute >= window.startMinute && minute < window.endMinute
    : // Wrapped past midnight, which is the ordinary case.
      minute >= window.startMinute || minute < window.endMinute;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Why a decision came out as it did. Reported on every decision, never only on refusals. */
export const CHANNEL_REASONS = [
  'URGENCY_CEILING',
  'HELD_FOR_QUIET_HOURS',
  'PIERCED_QUIET_HOURS',
  'ALERT_NOT_DELIVERABLE',
  'ALREADY_DELIVERED',
] as const;
export type ChannelReason = (typeof CHANNEL_REASONS)[number];

export interface DeliveryTimingInput {
  /** The urgency frozen on the assessment. Never recomputed here. */
  readonly urgency: ActionUrgency;
  /** False for a withdrawn or superseded alert. */
  readonly deliverable: boolean;
  /**
   * Whether this recipient already has a delivery for this deduplication key.
   *
   * `04` Phase 7.5 asks for deduplication identifiers and `07.5` for one notification per
   * concern. The identifiers live on `alert_publication.dedupe_key` and on the two unique indexes
   * over `alert_delivery`; this flag is the caller reporting what they found, so the decision and
   * the constraint agree rather than one of them being the only guard.
   */
  readonly alreadyDelivered: boolean;
  readonly quietHours: QuietHours | null;
  /** The recipient's current minute from local midnight, or `null` where nobody knows it. */
  readonly localMinuteOfDay: number | null;
}

export interface DeliveryTiming {
  readonly channel: DeliveryChannel;
  readonly reason: ChannelReason;
  /**
   * Whether this is being held rather than sent now.
   *
   * Held is not the same as downgraded: a `HIGH` alert held for quiet hours is still a `HIGH`
   * alert and is still an interrupt when the window ends. A screen that reported it as a digest
   * item would be reporting a lower urgency than a reviewer approved.
   */
  readonly held: boolean;
}

/**
 * Decide the channel and whether to hold.
 *
 * Pure, total, and deliberately unable to raise anything. Every branch either returns the
 * urgency's ceiling or something quieter, so no combination of quiet hours, deduplication and
 * deliverability can make an event louder than the urgency a reviewer approved.
 */
export function deliveryDecision(input: DeliveryTimingInput): DeliveryTiming {
  const ceiling = MAX_CHANNEL_FOR_URGENCY[input.urgency];

  // A withdrawn alert is not delivered at all. `19` treats a withdrawn alert that stays
  // actionable as release-blocking, and a notification already on a device is the least revocable
  // form of that - so the check is here, before anything else can decide to send.
  if (!input.deliverable) {
    return { channel: 'IN_APP_ONLY', reason: 'ALERT_NOT_DELIVERABLE', held: false };
  }

  if (input.alreadyDelivered) {
    return { channel: 'IN_APP_ONLY', reason: 'ALREADY_DELIVERED', held: false };
  }

  // Nothing that does not interrupt can be held: a digest line has no time it would have arrived,
  // and an in-app record was never going to appear on a device.
  if (ceiling !== 'INTERRUPT') {
    return { channel: ceiling, reason: 'URGENCY_CEILING', held: false };
  }

  const quiet =
    input.quietHours !== null &&
    input.localMinuteOfDay !== null &&
    withinQuietHours(input.localMinuteOfDay, input.quietHours);

  if (!quiet) {
    return { channel: 'INTERRUPT', reason: 'URGENCY_CEILING', held: false };
  }

  if (URGENCIES_PIERCING_QUIET_HOURS.includes(input.urgency)) {
    return { channel: 'INTERRUPT', reason: 'PIERCED_QUIET_HOURS', held: false };
  }

  return { channel: 'INTERRUPT', reason: 'HELD_FOR_QUIET_HOURS', held: true };
}

// ---------------------------------------------------------------------------
// Exit criterion 1 - a foreign restriction is not a personal alarm
// ---------------------------------------------------------------------------

export interface RegulatoryDifferenceUrgencyInput {
  /** Where the regulator published it. */
  readonly observedIn: Jurisdiction;
  /** The markets this profile's own care actually happens in. */
  readonly profileMarkets: readonly Jurisdiction[];
  /**
   * The urgency a **reviewed rule** established for this profile's context, where one exists.
   *
   * `09` allows a stronger action only when "a separate reviewed rule establishes" it. Nothing
   * derived, nothing observed at read time: a value here means a human approved a rule that says
   * so for this context, which is what makes it admissible.
   */
  readonly reviewedUrgencyForContext: ActionUrgency | null;
}

export interface RegulatoryDifferenceUrgency {
  readonly urgency: ActionUrgency;
  readonly isForeign: boolean;
  /** True where a reviewed rule, and only a reviewed rule, set this above the foreign default. */
  readonly raisedByReviewedRule: boolean;
}

/**
 * What urgency a regulatory difference may carry for this profile.
 *
 * Exit criterion 1 as a function rather than as a rule somebody has to remember. A difference
 * published in a market this profile's care does not happen in is `INFORMATIONAL` - which
 * {@link MAX_CHANNEL_FOR_URGENCY} maps to `IN_APP_ONLY`, so it produces no push and no digest
 * line, not merely a quieter one.
 *
 * The only escape is a reviewed rule that named this context, and the result says so out loud, so
 * a caller cannot later mistake a reviewed decision for a computed one.
 *
 * A profile with no market recorded is treated as having none in common with anywhere: everything
 * is foreign until somebody says where care happens. That is the safe direction - the failure it
 * avoids is telling a person their own regulator has acted when in fact a different one has.
 */
export function regulatoryDifferenceUrgency(
  input: RegulatoryDifferenceUrgencyInput,
): RegulatoryDifferenceUrgency {
  const isForeign = !input.profileMarkets.includes(input.observedIn);

  if (!isForeign) {
    return {
      urgency: input.reviewedUrgencyForContext ?? FOREIGN_REGULATORY_DEFAULT_URGENCY,
      isForeign: false,
      raisedByReviewedRule: input.reviewedUrgencyForContext !== null,
    };
  }

  if (input.reviewedUrgencyForContext !== null) {
    return {
      urgency: input.reviewedUrgencyForContext,
      isForeign: true,
      raisedByReviewedRule: true,
    };
  }

  return {
    urgency: FOREIGN_REGULATORY_DEFAULT_URGENCY,
    isForeign: true,
    raisedByReviewedRule: false,
  };
}

// ---------------------------------------------------------------------------
// Exit criterion 2 - nothing stale stays actionable
// ---------------------------------------------------------------------------

/**
 * What a re-read found, compared with what somebody was told.
 *
 * `STILL_CURRENT` is one member of five rather than the absence of the other four, so a caller
 * has to handle it explicitly and cannot reach "still fine" by forgetting to check.
 */
export const REVALIDATION_OUTCOMES = [
  'STILL_CURRENT',
  'WITHDRAWN',
  'SUPERSEDED',
  'CORRECTED_SINCE_NOTIFICATION',
  'NO_LONGER_VISIBLE',
] as const;
export type RevalidationOutcome = (typeof REVALIDATION_OUTCOMES)[number];

export interface RevalidationInput {
  /** When the notification was issued. `null` where the alert was opened from inside the app. */
  readonly notifiedAt: Instant | null;
  /**
   * The alert's state as read **now**, or `null` where this session can no longer see it at all.
   *
   * The `null` case is real rather than defensive: a caregiver grant can be revoked between the
   * notification and the tap, and that must read as "no longer visible" rather than as "fine".
   */
  readonly currentState: string | null;
  /** When the most recent correction against this assessment was recorded, if there is one. */
  readonly lastCorrectedAt: Instant | null;
}

export interface Revalidation {
  readonly outcome: RevalidationOutcome;
  /**
   * Whether the actions on this alert may still be offered.
   *
   * `false` for every outcome but `STILL_CURRENT`. Exit criterion 2 is "stale/corrected
   * notifications cannot remain actionable without revalidation", and the way this build makes
   * that true is that the read which renders the screen performs the revalidation - so a client
   * cannot skip it and still act. A caller that ignores this flag renders controls the server
   * will refuse anyway, because the same state is what row-level security filters on.
   */
  readonly actionable: boolean;
  /** True where this was opened from a notification rather than from inside the app. */
  readonly fromNotification: boolean;
}

/**
 * Compare what somebody was told with what is true now.
 *
 * Ordered so the most fundamental answer wins: an alert this session can no longer see is not
 * reported as "corrected", and a withdrawn one is not reported as "still current" because a
 * correction happened to predate the notification.
 *
 * A correction is only reported against a notification. Opening an alert from inside the app with
 * no `notifiedAt` is not a stale notification, and the receipt is where a correction is read in
 * that case - saying "this changed since you were notified" to somebody who was never notified
 * would be Kynviora inventing an event.
 */
export function revalidate(input: RevalidationInput): Revalidation {
  const fromNotification = input.notifiedAt !== null;

  if (input.currentState === null) {
    return { outcome: 'NO_LONGER_VISIBLE', actionable: false, fromNotification };
  }
  if (input.currentState === 'WITHDRAWN') {
    return { outcome: 'WITHDRAWN', actionable: false, fromNotification };
  }
  if (input.currentState === 'SUPERSEDED') {
    return { outcome: 'SUPERSEDED', actionable: false, fromNotification };
  }

  if (
    input.notifiedAt !== null &&
    input.lastCorrectedAt !== null &&
    Date.parse(input.lastCorrectedAt) > Date.parse(input.notifiedAt)
  ) {
    return { outcome: 'CORRECTED_SINCE_NOTIFICATION', actionable: false, fromNotification };
  }

  return { outcome: 'STILL_CURRENT', actionable: true, fromNotification };
}
