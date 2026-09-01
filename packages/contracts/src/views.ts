/**
 * View models: the shape a screen renders, derived from a response.
 *
 * Spec references: `18` (identity, formula and batch certainty stay distinct; never colour
 * alone), `23` D-005 (evidence level and urgency are never combined), `02` (no aggregate score),
 * `14` (deny by default), `12` (untrusted input is narrowed, not cast).
 *
 * WHY THIS IS NOT IN THE EXPO APP
 * `apps/**` is excluded from the test run and there is no renderer available (`BLK-002`), so
 * anything decided inside a component is decided where nothing can check it. The decisions that
 * matter here are exactly the ones worth checking: what an unrecognised verification value means,
 * and whether two safety facets ever get combined. Both live here, under test, and the components
 * render what they are handed.
 *
 * AN UNRECOGNISED VALUE IS NEVER GOOD NEWS
 * A response carrying a verification state this client does not know about could be a newer
 * server, a proxy rewriting a body, or a bug. Every narrowing here falls back to the value that
 * claims **least**: `UNVERIFIED` rather than `CONFIRMED`, `NOT_MATCHED` rather than `EXACT`,
 * evidence `U` rather than `A`. Deny by default (`14`) applies to claims about a medicine exactly
 * as it applies to access.
 */

import {
  NOTIFICATION_DETAIL_LEVELS,
  REVIEW_TASK_KINDS,
  isActionUrgency,
  isCaregiverCapability,
  isEvidenceLevel,
  isItemKind,
  isItemVerification,
  isMatchConfidence,
  type ActionUrgency,
  type EvidenceLevel,
  type ItemKind,
  type ItemVerification,
  type CaregiverCapability,
  type MatchConfidence,
  type NotificationDetailLevel,
  type ReviewTaskKind,
} from '@kynviora/domain';
import {
  presentEvidenceLevel,
  presentMatchConfidence,
  presentUrgency,
  presentVerification,
  type StatusPresentation,
} from '@kynviora/presentation';
import type {
  AlertSummary,
  CaregiverGrant,
  PendingInvitation,
  ReviewTask,
  ShelfItem,
} from './client.js';
import type { CaregiverAccessState } from '@kynviora/presentation';

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

/** Unknown means unverified. Never `CONFIRMED`. */
export function asItemVerification(raw: string): ItemVerification {
  return isItemVerification(raw) ? raw : 'UNVERIFIED';
}

/** Unknown means no match. Never `EXACT`. */
export function asMatchConfidence(raw: string): MatchConfidence {
  return isMatchConfidence(raw) ? raw : 'NOT_MATCHED';
}

/** Unknown means unclassified evidence - `U`, the level that asserts nothing. */
export function asEvidenceLevel(raw: string): EvidenceLevel {
  return isEvidenceLevel(raw) ? raw : 'U';
}

/**
 * Unknown means informational.
 *
 * The one narrowing here that falls back to the *quietest* value rather than the most cautious,
 * and deliberately: `02` and `18` require a product that does not optimise for alarm, and telling
 * someone a medicine needs urgent action because a string did not parse is a false alarm with a
 * medicine's name on it. `09` sets the same default for a foreign regulatory difference.
 */
export function asActionUrgency(raw: string): ActionUrgency {
  return isActionUrgency(raw) ? raw : 'INFORMATIONAL';
}

/** Unknown means personal care: the kind with no medicine-specific workflow attached. */
export function asItemKind(raw: string): ItemKind {
  return isItemKind(raw) ? raw : 'PERSONAL_CARE';
}

// ---------------------------------------------------------------------------
// Shelf
// ---------------------------------------------------------------------------

export interface ShelfItemView {
  readonly id: string;
  readonly displayName: string;
  readonly brand: string | null;
  readonly itemKind: ItemKind;
  readonly lifecycleState: string;
  /**
   * Three separate presentations, in a fixed order, and never merged.
   *
   * `18`: "Product identity confirmed", "Formula confirmed from this label" and "Batch not
   * entered" are different statements and must not share one label. There is no combined
   * `verified` field here and there must not be - `02` forbids an aggregate Trust Passport score,
   * and one badge summarising three axes is that score with the number left off.
   */
  readonly identity: StatusPresentation;
  readonly formulation: StatusPresentation;
  readonly batch: StatusPresentation;
}

export function shelfItemView(item: ShelfItem): ShelfItemView {
  return {
    id: item.id,
    displayName: item.displayName,
    brand: item.brand,
    itemKind: asItemKind(item.itemKind),
    lifecycleState: item.lifecycleState,
    identity: presentVerification(asItemVerification(item.identityVerification), 'identity'),
    formulation: presentVerification(
      asItemVerification(item.formulationVerification),
      'formulation',
    ),
    batch: presentVerification(asItemVerification(item.batchVerification), 'batch'),
  };
}

export interface ShelfView {
  readonly items: readonly ShelfItemView[];
  readonly medicineCount: number;
  readonly personalCareCount: number;
  /** `true` when the server said there is another page. */
  readonly hasMore: boolean;
}

export function shelfView(items: readonly ShelfItem[], nextCursor: string | null): ShelfView {
  const views = items.map(shelfItemView);
  return {
    items: views,
    // Counts of what is on the shelf. Not a score, not a rating, and not a count of anything
    // "needing attention" - `02` forbids the aggregate and Phase 8.3 forbids the badge.
    medicineCount: views.filter((view) => view.itemKind === 'MEDICINE').length,
    personalCareCount: views.filter((view) => view.itemKind === 'PERSONAL_CARE').length,
    hasMore: nextCursor !== null,
  };
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

export interface AlertView {
  readonly id: string;
  readonly ownedItemId: string;
  readonly publishedAt: string;
  /**
   * Three separate presentations again, and for the harder reason.
   *
   * `23` D-005 forbids combining an evidence level with an urgency into a single severity, and
   * several tests across this codebase assert that no conversion between the two types exists
   * anywhere. Keeping them as three fields is what makes "how sure is this" and "what should I
   * do" answerable separately, which is the whole point of the distinction.
   */
  readonly urgency: StatusPresentation;
  readonly evidence: StatusPresentation;
  readonly match: StatusPresentation;
  readonly explanationTemplateId: string;
}

export function alertView(alert: AlertSummary): AlertView {
  return {
    id: alert.id,
    ownedItemId: alert.ownedItemId,
    publishedAt: alert.publishedAt,
    urgency: presentUrgency(asActionUrgency(alert.urgency)),
    evidence: presentEvidenceLevel(asEvidenceLevel(alert.evidenceLevel)),
    match: presentMatchConfidence(asMatchConfidence(alert.matchConfidence)),
    explanationTemplateId: alert.explanationTemplateId,
  };
}

/**
 * What the Safety screen says when it has no alerts.
 *
 * Not "you are safe". An empty safety screen means Kynviora has published nothing for this
 * profile, which - given `BLK-006` and DEC-016 - is currently true of every profile and says
 * nothing at all about the products on the shelf. `09` requires the coverage statement to
 * accompany the result rather than being inferred from its absence, and `18` forbids presenting
 * an absence of findings as reassurance.
 */
export const SAFETY_EMPTY_COVERAGE =
  'Kynviora has no reviewed safety information to show for this profile. That is not the same ' +
  'as saying there is nothing to find.';

export interface SafetyView {
  readonly alerts: readonly AlertView[];
  readonly coverageStatement: string;
}

export function safetyView(alerts: readonly AlertSummary[]): SafetyView {
  return {
    alerts: alerts.map(alertView),
    // Shown whether or not there are alerts. An absence of findings is not a finding of absence,
    // and the sentence saying so has to be on screen in both cases.
    coverageStatement: SAFETY_EMPTY_COVERAGE,
  };
}

// ---------------------------------------------------------------------------
// Review inbox
// ---------------------------------------------------------------------------

/**
 * Narrow a task kind, or refuse it.
 *
 * `null` rather than a fallback kind, because the presentation layer holds one description per
 * kind and has no default. A task whose kind this client does not recognise has no label, no
 * meaning sentence and no action label that anyone wrote, and inventing them would put words
 * next to somebody's medicine record that no reviewer approved. Dropping the row is the smaller
 * harm, and {@link reviewTaskViews} reports how many it dropped so the screen can say so.
 */
export function asReviewTaskKind(raw: string): ReviewTaskKind | null {
  return (REVIEW_TASK_KINDS as readonly string[]).includes(raw) ? (raw as ReviewTaskKind) : null;
}

export interface ReviewTaskView {
  readonly taskId: string;
  readonly kind: ReviewTaskKind;
  /**
   * The record this task is about.
   *
   * Carried because completing a task writes to that record and the change has to name it
   * (DEC-027). `evaluateCompletion` refuses a change targeting anything else, so a view without
   * this could show a task nobody can complete.
   */
  readonly subjectId: string;
  readonly subjectLabel: string | null;
}

export interface ReviewInboxView {
  readonly tasks: readonly ReviewTaskView[];
  /**
   * How many rows this client could not describe.
   *
   * Surfaced rather than swallowed. `06` requires a partial state distinct from success, and a
   * silently shorter list is exactly the failure that state exists to make visible.
   */
  readonly unrecognisedCount: number;
}

export function reviewInboxView(tasks: readonly ReviewTask[]): ReviewInboxView {
  const views: ReviewTaskView[] = [];
  let unrecognised = 0;

  for (const task of tasks) {
    const kind = asReviewTaskKind(task.kind);
    if (kind === null) {
      unrecognised += 1;
      continue;
    }
    views.push({
      taskId: task.taskId,
      kind,
      subjectId: task.subjectId,
      subjectLabel: task.subjectLabel,
    });
  }

  return { tasks: views, unrecognisedCount: unrecognised };
}

// ---------------------------------------------------------------------------
// Caregiver access
// ---------------------------------------------------------------------------

/**
 * Map a stored grant status onto the state a person reads.
 *
 * `PENDING` becomes `INVITED` because the presentation layer deliberately speaks about people
 * rather than about rows: "they have been invited and have not accepted yet" is the sentence, and
 * the reader does not need the difference between a pending grant and an outstanding invitation.
 *
 * An unrecognised status becomes `REVOKED` - the state that claims **no** access. On this screen
 * the failure directions are not symmetric: showing "has access" for a status this client cannot
 * read would state, in words, that somebody can see a person's health data when nobody knows
 * whether they can.
 */
export function asCaregiverAccessState(status: string): CaregiverAccessState {
  switch (status) {
    case 'PENDING':
      return 'INVITED';
    case 'ACTIVE':
      return 'ACTIVE';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'DECLINED':
      return 'DECLINED';
    case 'REVOKED':
      return 'REVOKED';
    default:
      return 'REVOKED';
  }
}

export interface CaregiverAccessRowView {
  readonly id: string;
  readonly state: CaregiverAccessState;
  readonly capabilities: readonly CaregiverCapability[];
  readonly displayName: string;
  readonly expiresAt: string | null;
}

/**
 * Rows for the caregiver access list.
 *
 * Capabilities this client does not recognise are dropped rather than shown as an unlabelled
 * chip, for the same reason as a review task kind: the presentation layer holds one description
 * per capability and no default, so an unknown one has no sentence anyone wrote about what it
 * permits.
 *
 * The grantee is identified by their user ID until the profile owner has given them a name.
 * `14` treats an email address as personal data and this screen may be read over someone's
 * shoulder, so an address is never substituted in.
 */
export function caregiverAccessRows(
  grants: readonly CaregiverGrant[],
  displayNames: Readonly<Record<string, string>> = {},
): readonly CaregiverAccessRowView[] {
  return grants.map((grant) => ({
    id: grant.id,
    state: asCaregiverAccessState(grant.status),
    capabilities: grant.capabilities.filter(isCaregiverCapability),
    displayName: displayNames[grant.granteeUserId] ?? grant.granteeUserId,
    expiresAt: grant.expiresAt,
  }));
}

// ---------------------------------------------------------------------------
// Notification detail
// ---------------------------------------------------------------------------

/**
 * Narrow a notification detail level, defaulting to the quietest.
 *
 * `GENERIC` reveals least, and DEC-025 makes both dials default to it precisely so that a missing
 * row is never permission. A value this client cannot read is the same situation: it is not
 * evidence that somebody chose to have a medicine's name appear on a locked screen.
 */
export function asNotificationDetailLevel(raw: string | null): NotificationDetailLevel {
  return raw !== null && (NOTIFICATION_DETAIL_LEVELS as readonly string[]).includes(raw)
    ? (raw as NotificationDetailLevel)
    : 'GENERIC';
}

/**
 * A level the user actually chose, or `null`.
 *
 * Distinct from {@link asNotificationDetailLevel} because "never chosen" and "chose GENERIC" are
 * different facts and the settings screen says which one it is. Collapsing them would show the
 * default as though it were a decision somebody made.
 */
export function asChosenDetailLevel(raw: string | null): NotificationDetailLevel | null {
  return raw !== null && (NOTIFICATION_DETAIL_LEVELS as readonly string[]).includes(raw)
    ? (raw as NotificationDetailLevel)
    : null;
}

/**
 * Rows for an invitation nobody has accepted yet.
 *
 * `INVITED` rather than `ACTIVE`, which is the distinction that matters when the question is who
 * can read this profile: the presentation says "they have been invited and have not accepted yet.
 * They have no access."
 *
 * The person is identified as an address-bound invitation or an open link, never by the address.
 * `14` treats an address as personal data and this list may be read over somebody's shoulder;
 * whether the link is open to anyone holding it is the fact the owner actually needs.
 */
export function invitationAccessRows(
  invitations: readonly PendingInvitation[],
): readonly CaregiverAccessRowView[] {
  return invitations.map((invitation) => ({
    id: invitation.id,
    state: 'INVITED' as const,
    capabilities: invitation.capabilities.filter(isCaregiverCapability),
    displayName: invitation.boundToAddress ? 'Invited by email' : 'Invitation link',
    expiresAt: invitation.grantExpiresAt,
  }));
}

/**
 * The access list a person reads: accepted grants and outstanding invitations together.
 *
 * Invitations first, because they are the thing that just changed and the thing an owner is
 * looking for after sending one. Not a ranking - there is no urgency on either.
 */
export function accessList(
  grants: readonly CaregiverGrant[],
  invitations: readonly PendingInvitation[] = [],
  displayNames: Readonly<Record<string, string>> = {},
): readonly CaregiverAccessRowView[] {
  return [...invitationAccessRows(invitations), ...caregiverAccessRows(grants, displayNames)];
}
