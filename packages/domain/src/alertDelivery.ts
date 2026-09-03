/**
 * Caregiver alert delivery: who is told, and how much they are told.
 *
 * Spec references: `04` Phase 8.2, `03` group H (separate permission for safety alerts, shelf,
 * medicines and exports; generic notification content by default), `16` (caregiver notifications
 * reveal minimal information by default; the product must not use "family" as justification for
 * broad hidden access), `15` A6 (a notification leaking health information to a lock screen),
 * `09` (a withdrawn alert must stop being actionable), `18` (non-judgemental language).
 *
 * TWO SEPARATE QUESTIONS
 * Delivery is two decisions, and conflating them is how caregiver features leak. **Who** may be
 * told is an authorization question, answered by capabilities and nothing else. **How much** the
 * notification itself says is a disclosure question, answered by preferences - and bounded by the
 * answer to the first, so a preference can never widen access.
 *
 * {@link selectRecipients} answers the first. {@link notificationFor} answers the second. Neither
 * can answer the other's question: a recipient the first function excluded has no notification to
 * render, and the second cannot add a recipient.
 *
 * DENY BY DEFAULT
 * Phase 8.2's exit criterion is that caregiver access is testable through deny-by-default
 * authorization cases. So the shape here is a filter over candidates, never a lookup that
 * accumulates permissions: a candidate is dropped unless something affirmatively admits it, and
 * every reason for dropping one is reported rather than silently applied.
 */

import type { ProfileId, UserId } from './ids.js';
import type { Instant } from './ports.js';
import type { DomainError, Result } from './result.js';
import { failure, ok } from './result.js';
import type { CaregiverCapability } from './vocabulary.js';

// ---------------------------------------------------------------------------
// What can be delivered
// ---------------------------------------------------------------------------

/**
 * The event kinds a caregiver can be notified about.
 *
 * A closed set. `03` group H requires safety alerts to be a *separate* permission from the shelf,
 * the medicines and exports, and the cleanest way to keep that true is to make every deliverable
 * event name the single capability that admits it - see {@link CAPABILITY_FOR_EVENT}.
 */
export const DELIVERABLE_EVENT_KINDS = ['SAFETY_ALERT', 'MISSED_DOSE'] as const;
export type DeliverableEventKind = (typeof DELIVERABLE_EVENT_KINDS)[number];

/**
 * The capability that admits each event kind. Total by construction.
 *
 * `MISSED_DOSE` maps to `RECEIVE_MISSED_DOSE` and deliberately **not** to `VIEW_SAFETY`. `04`
 * Phase 8.2 calls the missed-dose permission optional and separate, and a caregiver watching for
 * a recall is not thereby entitled to know whether someone took their tablets this morning.
 */
export const CAPABILITY_FOR_EVENT: Readonly<Record<DeliverableEventKind, CaregiverCapability>> =
  Object.freeze({
    SAFETY_ALERT: 'VIEW_SAFETY',
    MISSED_DOSE: 'RECEIVE_MISSED_DOSE',
  });

/**
 * How much a notification may say.
 *
 * Ordered least to most disclosing, and compared by index in {@link narrowerOf}. The ordering is
 * load-bearing, not cosmetic: the whole disclosure rule is "take the smaller index".
 *
 * - `GENERIC` - reveals nothing at all. The default (`03` group H).
 * - `CATEGORY` - names the kind of update and nothing else. No person, no product.
 * - `NAMED` - may name the person and the item.
 */
export const NOTIFICATION_DETAIL_LEVELS = ['GENERIC', 'CATEGORY', 'NAMED'] as const;
export type NotificationDetailLevel = (typeof NOTIFICATION_DETAIL_LEVELS)[number];

/**
 * Whether a string is a level this build knows.
 *
 * The wire type is deliberately `string` in `@kynviora/contracts`, so that a level a later server
 * adds does not fail a client's parse. That leaves somebody with the narrowing, and the narrowing
 * has one safe direction: an unrecognised level must fall back to `GENERIC` and never be cast.
 * Casting it would let a future `FULL` arrive at a client that renders the widest branch it has,
 * which on this vocabulary means putting a medicine name on a lock screen because the server said
 * a word the client did not understand.
 */
export function isNotificationDetailLevel(value: string): value is NotificationDetailLevel {
  return (NOTIFICATION_DETAIL_LEVELS as readonly string[]).includes(value);
}

/**
 * The default, and the value assumed whenever a preference is missing.
 *
 * `03` group H: "generic notification content by default". A missing row must therefore mean the
 * most private setting, never the most convenient one - so no code path here treats absence as
 * permission.
 */
export const DEFAULT_NOTIFICATION_DETAIL: NotificationDetailLevel = 'GENERIC';

/** The more private of two levels. */
export function narrowerOf(
  a: NotificationDetailLevel,
  b: NotificationDetailLevel,
): NotificationDetailLevel {
  const ai = NOTIFICATION_DETAIL_LEVELS.indexOf(a);
  const bi = NOTIFICATION_DETAIL_LEVELS.indexOf(b);
  return ai <= bi ? a : b;
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/** How a candidate is related to the profile. The owner is not a caregiver and has no grant. */
export const RECIPIENT_RELATIONSHIPS = ['OWNER', 'CAREGIVER'] as const;
export type RecipientRelationship = (typeof RECIPIENT_RELATIONSHIPS)[number];

/**
 * Someone who might be told, before any decision has been made about them.
 *
 * Resolved by the caller from live rows. Deliberately carries the raw grant state rather than a
 * pre-computed "is active" boolean, so the reason for an exclusion is decided here - in one
 * place, with a test per reason - instead of in whichever query happened to build the list.
 */
export interface DeliveryCandidate {
  readonly userId: UserId;
  readonly relationship: RecipientRelationship;
  readonly capabilities: readonly CaregiverCapability[];
  /** False until the invitation has been accepted. A pending grant conveys nothing. */
  readonly grantAccepted: boolean;
  readonly grantRevokedAt: Instant | null;
  readonly grantExpiresAt: Instant | null;
  /** This recipient's own setting for their own device. Absent means the default. */
  readonly detailPreference: NotificationDetailLevel | null;
  /**
   * Whether **this person** has agreed to be sent notifications (`04` Phase 1.4).
   *
   * Their own consent about their own device, so it applies to the owner as well as to a
   * caregiver - it is not a grant-shaped check. Absent is treated as not granted by the caller
   * that builds these; deny by default (`14`), because silence is not agreement.
   */
  readonly notificationsConsented: boolean;
  /**
   * Whether the **profile owner** has agreed to their information reaching caregivers.
   *
   * A property of the profile rather than of this candidate, carried on each candidate because
   * that is where the decision is made. It excludes caregivers and never the owner: withdrawing
   * it is "stop telling other people about me", not "stop telling me".
   */
  readonly caregiverSharingConsented: boolean;
}

/** Why a candidate was not told. Reported, never silent. */
export const EXCLUSION_REASONS = [
  'GRANT_NOT_ACCEPTED',
  'GRANT_REVOKED',
  'GRANT_EXPIRED',
  'CAPABILITY_MISSING',
  'ALERT_NOT_DELIVERABLE',
  /**
   * This person has not agreed to be sent notifications (`04` Phase 1.4).
   *
   * Distinct from every reason above, and the distinction is the point: the others say a grant
   * does not admit them, and this says they asked not to be contacted. Reporting it as
   * `CAPABILITY_MISSING` would put a person who exercised a right into the same audit bucket as
   * one whose access was never wide enough.
   */
  'CONSENT_WITHDRAWN',
  /** The profile owner has not agreed to their information reaching caregivers. */
  'CAREGIVER_SHARING_WITHDRAWN',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface ExcludedCandidate {
  readonly userId: UserId;
  readonly reason: ExclusionReason;
}

export interface Recipient {
  readonly userId: UserId;
  readonly relationship: RecipientRelationship;
  /** The level this recipient's notification will actually use. */
  readonly detailLevel: NotificationDetailLevel;
}

export interface DeliveryPlan {
  readonly profileId: ProfileId;
  readonly eventKind: DeliverableEventKind;
  readonly recipients: readonly Recipient[];
  readonly excluded: readonly ExcludedCandidate[];
  readonly decidedAt: Instant;
}

/**
 * The publication state of the alert being delivered.
 *
 * Mirrors `alert_publication.state`. Only `PUBLISHED` is deliverable: `09` and the `19`
 * release-blocking defect list both treat a withdrawn alert that remains actionable as a defect,
 * and a notification already sent is the least revocable form of "still actionable".
 */
export const DELIVERABLE_ALERT_STATES = ['PUBLISHED', 'WITHDRAWN', 'SUPERSEDED'] as const;
export type DeliverableAlertState = (typeof DELIVERABLE_ALERT_STATES)[number];

export interface DeliverableEvent {
  readonly kind: DeliverableEventKind;
  readonly profileId: ProfileId;
  /**
   * Publication state, for a `SAFETY_ALERT`. A `MISSED_DOSE` has no publication and passes
   * `null`; it is not "published" in the `09` sense and must not borrow that vocabulary.
   */
  readonly alertState: DeliverableAlertState | null;
}

/**
 * The owner-set ceiling on what a *caregiver* notification for this profile may reveal.
 *
 * Exactly one thing, deliberately. Every recipient - the owner included - already has a personal
 * preference for their own device, so a second owner-level dial for the owner's own notifications
 * would be a duplicate answer to a question that has one, and the two could disagree. The policy
 * therefore says nothing about the owner's notifications: it is a limit on how much of their
 * health information may leave the app onto somebody else's lock screen, which is the say `16`
 * gives them.
 */
export interface ProfileNotificationPolicy {
  readonly profileId: ProfileId;
  readonly maxCaregiverDetail: NotificationDetailLevel;
}

/** The policy assumed when a profile has never configured one. Generic, per `03` group H. */
export function defaultNotificationPolicy(profileId: ProfileId): ProfileNotificationPolicy {
  return { profileId, maxCaregiverDetail: DEFAULT_NOTIFICATION_DETAIL };
}

/**
 * Decide who is told about an event, and at what disclosure level.
 *
 * Deny by default: the result contains only candidates that something affirmatively admitted.
 * The checks run in a fixed order so an excluded candidate has exactly one reported reason, and
 * that reason is the most fundamental one that applies - a revoked grant reports `GRANT_REVOKED`
 * rather than whichever capability it also happened to lack.
 */
export function selectRecipients(
  event: DeliverableEvent,
  candidates: readonly DeliveryCandidate[],
  policy: ProfileNotificationPolicy,
  now: Instant,
): Result<DeliveryPlan, DomainError> {
  if (event.kind === 'SAFETY_ALERT' && event.alertState !== 'PUBLISHED') {
    // Not an exclusion of any particular person: there is nothing deliverable at all. Returning
    // an empty plan rather than an error would let a caller record a "delivery" of a withdrawn
    // alert to nobody, which reads in the audit trail as though the alert were live.
    return failure('VALIDATION_FAILED', 'Only a published alert can be delivered.', {
      reason_code: 'alert_not_deliverable',
      alert_state: event.alertState ?? 'NONE',
    });
  }
  if (event.kind === 'MISSED_DOSE' && event.alertState !== null) {
    return failure('VALIDATION_FAILED', 'A missed-dose event has no publication state.', {
      reason_code: 'missed_dose_has_no_publication',
    });
  }

  const required = CAPABILITY_FOR_EVENT[event.kind];
  const recipients: Recipient[] = [];
  const excluded: ExcludedCandidate[] = [];

  for (const candidate of candidates) {
    // `04` Phase 1.4's exit criterion, checked before anything else and before the owner
    // short-circuit. Consent is the basis on which Kynviora may contact this person at all, so it
    // is not a grant-shaped check and the owner is not exempt from their own answer.
    //
    // There is deliberately no urgency that pierces this. A `CRITICAL` alert pierces quiet hours
    // (DEC-078) because those are a timing preference; continuing to send to somebody who
    // withdrew consent is not a safety feature, it is sending without consent. The settings copy
    // says so above the control rather than after it.
    if (!candidate.notificationsConsented) {
      excluded.push({ userId: candidate.userId, reason: 'CONSENT_WITHDRAWN' });
      continue;
    }

    if (candidate.relationship === 'OWNER') {
      // The owner is not admitted by a capability and cannot be excluded by one. They hold no
      // grant, so every grant-shaped check below would be vacuous for them. Their own preference
      // is the only dial that applies: the caregiver ceiling limits what leaves the profile onto
      // someone else's device, and is not a restriction the owner places on themselves.
      recipients.push({
        userId: candidate.userId,
        relationship: 'OWNER',
        detailLevel: candidate.detailPreference ?? DEFAULT_NOTIFICATION_DETAIL,
      });
      continue;
    }

    // The owner's answer about their information leaving the profile. Checked before the grant
    // state, because "I have stopped sharing" is a stronger statement than "your grant expired"
    // and reporting the weaker one would describe the wrong thing in the audit trail.
    if (!candidate.caregiverSharingConsented) {
      excluded.push({ userId: candidate.userId, reason: 'CAREGIVER_SHARING_WITHDRAWN' });
      continue;
    }

    if (!candidate.grantAccepted) {
      excluded.push({ userId: candidate.userId, reason: 'GRANT_NOT_ACCEPTED' });
      continue;
    }
    if (candidate.grantRevokedAt !== null) {
      excluded.push({ userId: candidate.userId, reason: 'GRANT_REVOKED' });
      continue;
    }
    if (
      candidate.grantExpiresAt !== null &&
      Date.parse(candidate.grantExpiresAt) <= Date.parse(now)
    ) {
      excluded.push({ userId: candidate.userId, reason: 'GRANT_EXPIRED' });
      continue;
    }
    if (!candidate.capabilities.includes(required)) {
      excluded.push({ userId: candidate.userId, reason: 'CAPABILITY_MISSING' });
      continue;
    }

    // Two dials, narrower wins: the owner's ceiling and this recipient's own preference, with the
    // default standing in when they have never chosen. A preference can only ever reduce.
    recipients.push({
      userId: candidate.userId,
      relationship: 'CAREGIVER',
      detailLevel: narrowerOf(
        policy.maxCaregiverDetail,
        candidate.detailPreference ?? DEFAULT_NOTIFICATION_DETAIL,
      ),
    });
  }

  return ok({
    profileId: event.profileId,
    eventKind: event.kind,
    recipients,
    excluded,
    decidedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Notification content
// ---------------------------------------------------------------------------

/**
 * The facts a notification could draw on, if the level permitted.
 *
 * Supplied by the caller from records the *profile* holds - not records the recipient may read.
 * The level decides what is used; passing a name here is not permission to print it.
 */
export interface NotificationSubject {
  readonly kind: DeliverableEventKind;
  readonly profileDisplayName: string;
  readonly itemDisplayName: string | null;
}

export interface Notification {
  readonly userId: UserId;
  readonly detailLevel: NotificationDetailLevel;
  readonly title: string;
  readonly body: string;
  /**
   * Whether this text names a person or a product.
   *
   * Carried explicitly so a test can assert the negative directly, rather than by grepping the
   * body for strings it hopes are absent.
   */
  readonly revealsSubject: boolean;
}

/**
 * `18`: "Kynviora has an important update." Reveals no medicine, product, condition or person.
 * `15` A6 is a notification leaking health information to a lock screen, and this is the string
 * that makes the default case safe.
 */
export const GENERIC_NOTIFICATION_TITLE = 'Kynviora';
export const GENERIC_NOTIFICATION_BODY = 'Kynviora has an important update.';

/**
 * Category-level bodies: the *kind* of update, still naming nobody and nothing.
 *
 * A missed dose is described without judgement (`18`): a dose that was not recorded is a fact
 * about the record, not about the person, and the copy says so.
 */
const CATEGORY_BODY: Readonly<Record<DeliverableEventKind, string>> = Object.freeze({
  SAFETY_ALERT: 'There is a safety update to review in Kynviora.',
  MISSED_DOSE: 'A scheduled dose has not been recorded yet.',
});

/**
 * Render the notification for one recipient.
 *
 * Total over the level, and the exhaustiveness is checked: a level added later must state its own
 * disclosure rule here rather than inheriting whichever branch happened to be last.
 */
export function notificationFor(recipient: Recipient, subject: NotificationSubject): Notification {
  switch (recipient.detailLevel) {
    case 'GENERIC':
      return {
        userId: recipient.userId,
        detailLevel: 'GENERIC',
        title: GENERIC_NOTIFICATION_TITLE,
        body: GENERIC_NOTIFICATION_BODY,
        revealsSubject: false,
      };
    case 'CATEGORY':
      return {
        userId: recipient.userId,
        detailLevel: 'CATEGORY',
        title: GENERIC_NOTIFICATION_TITLE,
        body: CATEGORY_BODY[subject.kind],
        revealsSubject: false,
      };
    case 'NAMED':
      return {
        userId: recipient.userId,
        detailLevel: 'NAMED',
        title: GENERIC_NOTIFICATION_TITLE,
        body: namedBody(subject),
        revealsSubject: true,
      };
  }
}

function namedBody(subject: NotificationSubject): string {
  const who = subject.profileDisplayName;
  switch (subject.kind) {
    case 'SAFETY_ALERT':
      return subject.itemDisplayName === null
        ? `There is a safety update to review for ${who}.`
        : `There is a safety update to review for ${who}: ${subject.itemDisplayName}.`;
    case 'MISSED_DOSE':
      return subject.itemDisplayName === null
        ? `A scheduled dose for ${who} has not been recorded yet.`
        : `A scheduled dose of ${subject.itemDisplayName} for ${who} has not been recorded yet.`;
  }
}

// ---------------------------------------------------------------------------
// Resolution visibility
// ---------------------------------------------------------------------------

/**
 * What a caregiver may see of an alert's resolution state (`04` Phase 8.2: "caregiver view of
 * resolution state according to grant").
 *
 * `VIEW_SAFETY` admits the resolution outcome and when it happened. It does **not** admit the
 * free-text resolution note, which is the one field a user can put anything into - including
 * something they wrote for themselves and would not have written to be read by the relative who
 * can see their alerts. Nothing in `03` group H implies a safety-alert grant carries someone's
 * private note, and the narrower reading is the one that cannot surprise them.
 */
export interface ResolutionView {
  readonly resolution: string | null;
  readonly resolvedAt: Instant | null;
  readonly note: string | null;
  readonly noteWithheld: boolean;
}

export function resolutionViewFor(
  receipt: {
    readonly resolution: string | null;
    readonly resolvedAt: Instant | null;
    readonly note: string | null;
  },
  viewer: { readonly relationship: RecipientRelationship },
): ResolutionView {
  if (viewer.relationship === 'OWNER') {
    return {
      resolution: receipt.resolution,
      resolvedAt: receipt.resolvedAt,
      note: receipt.note,
      noteWithheld: false,
    };
  }
  return {
    resolution: receipt.resolution,
    resolvedAt: receipt.resolvedAt,
    note: null,
    // Reported rather than merely absent, so a caregiver surface can say "the note is private"
    // instead of showing a blank that reads as "there is no note".
    noteWithheld: receipt.note !== null,
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const ALERT_DELIVERY_AUDIT_ACTIONS = [
  'alert.delivery.dispatched',
  'alert.delivery.suppressed',
  'notification.preference.changed',
  'notification.policy.changed',
] as const;
export type AlertDeliveryAuditAction = (typeof ALERT_DELIVERY_AUDIT_ACTIONS)[number];

/**
 * Audit detail for a dispatch.
 *
 * Counts and levels, never the notification body and never a recipient's name. The same rule as
 * DEC-022: an audit trail exists to answer "did this happen, and to how many people", not to
 * become a second copy of the thing it is recording.
 */
export function deliveryAuditDetail(plan: {
  readonly eventKind: DeliverableEventKind;
  readonly recipients: readonly Recipient[];
  readonly excluded: readonly ExcludedCandidate[];
}): Readonly<Record<string, string | number | boolean | null>> {
  const byLevel: Record<string, number> = {};
  for (const r of plan.recipients) {
    byLevel[r.detailLevel] = (byLevel[r.detailLevel] ?? 0) + 1;
  }
  const detail: Record<string, string | number | boolean | null> = {
    event_kind: plan.eventKind,
    recipient_count: plan.recipients.length,
    excluded_count: plan.excluded.length,
  };
  for (const level of NOTIFICATION_DETAIL_LEVELS) {
    detail[`count_${level.toLowerCase()}`] = byLevel[level] ?? 0;
  }
  for (const reason of EXCLUSION_REASONS) {
    const n = plan.excluded.filter((e) => e.reason === reason).length;
    if (n > 0) detail[`excluded_${reason.toLowerCase()}`] = n;
  }
  return detail;
}
