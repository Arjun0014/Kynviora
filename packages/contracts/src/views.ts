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
  PRODUCT_SAFETY_STATES,
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
  type ProductSafetyState,
  type ReviewTaskKind,
} from '@kynviora/domain';
import {
  ICON_NAMES,
  describeAuditAction,
  presentEvidenceLevel,
  presentSafetyState,
  presentMatchConfidence,
  presentUrgency,
  presentVerification,
  resolutionOptions,
  attentionListView,
  manualEntryForm,
  type StatusPresentation,
} from '@kynviora/presentation';
import { isSafetyResolution } from '@kynviora/domain';
import type {
  AlertDetailResponse,
  StatusPresentationResponse,
  AlertSummary,
  CaregiverAuditEvent,
  CaregiverGrant,
  ItemDetailResponse,
  ManualEntryBody,
  SafetyInboxLineResponse,
  SafetyReceiptResponse,
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
  /**
   * What is not settled about this item, as sentences (`04` Phase 2.1).
   *
   * On the row rather than behind the filter, which is the exit criterion: a person has to be
   * able to see which items need something without knowing to filter for it. Not a count and not
   * an ordering - `02` forbids the aggregate, and which of two people's medicines matters more is
   * not a judgement this list makes (trap 77).
   */
  readonly attention: readonly string[];
  /** Reasons this build has no wording for. Dropped from the list above and counted here. */
  readonly undescribedAttentionCount: number;
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
    // Composed from the domain's reason codes rather than from the item's own fields, so the list
    // and the detail cannot disagree about what is outstanding.
    attention: attentionListView(item.attentionReasons).reasons.map((entry) => entry.label),
    undescribedAttentionCount: attentionListView(item.attentionReasons).undescribedCount,
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
    // Counts of what is on the shelf, by category. Not a score, not a rating, and deliberately
    // not a count of anything "needing attention" - `02` forbids the aggregate and Phase 8.3
    // forbids the badge. Phase 2.1 added a per-item reason list and did not add a total.
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
// The Safety Watch inbox
// ---------------------------------------------------------------------------

/**
 * Narrow a product safety state, defaulting to the one that claims least.
 *
 * `INSUFFICIENT_DATA` rather than `NO_CURRENT_MATCHED_ALERT`, and the difference is the whole
 * point: a state this client cannot read is not evidence that a check ran and came back clear.
 * `23` D-014 forbids an absence rendering as approval, and an unrecognised value is an absence of
 * a different kind.
 */
export function asProductSafetyState(raw: string): ProductSafetyState {
  return (PRODUCT_SAFETY_STATES as readonly string[]).includes(raw)
    ? (raw as ProductSafetyState)
    : 'INSUFFICIENT_DATA';
}

export interface SafetyInboxLineView {
  readonly ownedItemId: string;
  readonly displayName: string;
  /**
   * The alert this line can open, or `null`.
   *
   * `null` on every line whose state came from an assessment rather than a live publication. A
   * screen offers no "why did I get this?" control where it is absent, which is DEC-045 again:
   * a disabled control would state that an explanation exists and is being withheld.
   */
  readonly alertPublicationId: string | null;
  /**
   * Three separate presentations, never merged.
   *
   * `23` D-005 forbids combining evidence level and urgency, and Phase 7.1 requires them visibly
   * separate. `urgency` and `evidence` are `null` together on a line with no live alert, because
   * an item nobody has alerted on has neither - not `INFORMATIONAL` and not `U`.
   */
  readonly state: StatusPresentation;
  readonly urgency: StatusPresentation | null;
  readonly evidence: StatusPresentation | null;
  /** When Kynviora last assessed this item, or `null`. Rendered as an absence, not hidden. */
  readonly lastAssessedAt: string | null;
  /**
   * What the Lens can be asked about for this item.
   *
   * Empty for every item until guided capture lands, so a screen offers no control rather than
   * one that opens an empty answer - absent rather than disabled, as DEC-045 has it.
   */
  readonly substances: readonly {
    readonly substanceKey: string;
    readonly preferredName: string;
    readonly disclosedConcentrationPercent: number | null;
  }[];
}

export interface SafetyInboxView {
  readonly lines: readonly SafetyInboxLineView[];
  /** How many items the shelf holds before filtering. Never a count of anything urgent. */
  readonly totalItems: number;
  /** Whether the list on screen is a subset. Lets a screen say so without computing a count. */
  readonly filtered: boolean;
  /**
   * The coverage statement, on screen in every state.
   *
   * `09` requires it to accompany the result rather than being inferred from its absence, and an
   * inbox where every line reads "nothing matched" is exactly where somebody would conclude the
   * shelf had been cleared.
   */
  readonly coverageStatement: string;
}

/**
 * The inbox a person reads.
 *
 * The order is the server's - the shelf's own - and is not re-sorted here. "Most urgent first" is
 * a judgement about which of two people's medicines matters more, and `02` refuses the
 * alarm-optimising product that comes from making it.
 */
export function safetyInboxView(response: {
  readonly lines: readonly SafetyInboxLineResponse[];
  readonly totalItems: number;
}): SafetyInboxView {
  const lines = response.lines.map((line) => ({
    ownedItemId: line.ownedItemId,
    displayName: line.displayName,
    alertPublicationId: line.alertPublicationId,
    state: presentSafetyState(asProductSafetyState(line.state)),
    // Null together. A line with no live alert has no urgency and no evidence level, and
    // substituting a default for either would put a chip on screen that nobody assigned.
    urgency: line.urgency === null ? null : presentUrgency(asActionUrgency(line.urgency)),
    evidence:
      line.evidenceLevel === null
        ? null
        : presentEvidenceLevel(asEvidenceLevel(line.evidenceLevel)),
    lastAssessedAt: line.lastAssessedAt,
    substances: line.substances ?? [],
  }));

  return {
    lines,
    totalItems: response.totalItems,
    filtered: lines.length !== response.totalItems,
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
  /**
   * Which record this row is.
   *
   * The list shows grants and outstanding invitations together because they answer one question,
   * but they are two records with two revocation routes, and the ID alone does not say which. A
   * row carrying only an ID makes "remove this" undecidable at the point it is pressed - and the
   * wrong route answers 404, which the client correctly renders as absence, so the failure would
   * have looked like the row disappearing rather than like a bug.
   */
  readonly subject: 'GRANT' | 'INVITATION';
  readonly state: CaregiverAccessState;
  readonly capabilities: readonly CaregiverCapability[];
  readonly displayName: string;
  readonly expiresAt: string | null;
  /**
   * Whether this row is the caller's own access.
   *
   * From the server (`isSelf`), never inferred here. An administering caregiver sees their own
   * grant in the same list as the ones they administer, and "they will stop seeing this profile"
   * is the wrong sentence to put in front of someone removing their own.
   */
  readonly isSelf: boolean;
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
    subject: 'GRANT' as const,
    state: asCaregiverAccessState(grant.status),
    capabilities: grant.capabilities.filter(isCaregiverCapability),
    displayName: displayNames[grant.granteeUserId] ?? grant.granteeUserId,
    expiresAt: grant.expiresAt,
    // Absent means not the caller's. Deny by default applied to a claim about identity: an older
    // server that does not send the field must not produce "remove your own access" copy in
    // front of someone removing somebody else's.
    isSelf: grant.isSelf === true,
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
    subject: 'INVITATION' as const,
    state: 'INVITED' as const,
    capabilities: invitation.capabilities.filter(isCaregiverCapability),
    displayName: invitation.boundToAddress ? 'Invited by email' : 'Invitation link',
    expiresAt: invitation.grantExpiresAt,
    // An invitation is never the caller's own access: the route admits the owner and an
    // administering caregiver, and deliberately not the intended recipient before acceptance.
    isSelf: false,
  }));
}

// ---------------------------------------------------------------------------
// The access history
// ---------------------------------------------------------------------------

export interface AccessHistoryLineView {
  readonly id: string;
  readonly occurredAt: string;
  /** The sentence a person reads. Never the raw action code. */
  readonly description: string;
}

export interface AccessHistoryView {
  readonly lines: readonly AccessHistoryLineView[];
  /**
   * Events dropped because this build has no sentence for the action.
   *
   * Counted rather than hidden, for the same reason an unrecognised review task kind is: `03`
   * group H is about the owner being able to see what happened, and a history that silently
   * omitted rows would answer that question wrongly while looking complete.
   */
  readonly unreadableCount: number;
}

/**
 * Lines for the access history, newest first as the route returns them.
 *
 * The detail is deliberately not rendered. It carries capability codes, counts and booleans
 * (`20`, and the caregiver audit detail is scalars only), and turning those into prose on this
 * screen would be a second description of a grant that the access list already describes - three
 * screens describing one grant three ways is how a person ends up unsure what they approved.
 */
export function accessHistory(events: readonly CaregiverAuditEvent[]): AccessHistoryView {
  const lines: AccessHistoryLineView[] = [];
  let unreadableCount = 0;

  for (const event of events) {
    const description = describeAuditAction(event.action);
    if (description === null) {
      unreadableCount += 1;
      continue;
    }
    lines.push({ id: event.id, occurredAt: event.occurredAt, description });
  }

  return { lines, unreadableCount };
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

// ---------------------------------------------------------------------------
// Alert detail (spec 04 Phase 7.3)
// ---------------------------------------------------------------------------

/**
 * Bases this client knows how to label.
 *
 * Mirrors `@kynviora/presentation`'s `FACT_BASES`, and is checked against it by a test rather
 * than imported, so a server sending a basis this build has never heard of is a case with a
 * decision rather than a runtime surprise.
 */
export const KNOWN_FACT_BASES: readonly string[] = Object.freeze([
  'RECORDED_BY_A_PERSON',
  'READ_FROM_THE_PACK',
  'PUBLISHED_BY_A_SOURCE',
  'COMPUTED_BY_KYNVIORA',
  'NOT_KNOWN',
  'WITHHELD_FROM_THIS_SESSION',
]);

/**
 * Narrow a status presentation from the wire, or refuse it.
 *
 * `null` where any part is missing or blank. `18` makes the text label the primary carrier of
 * meaning and forbids colour carrying it alone, so a presentation with no label is one this
 * screen cannot render honestly - and a chip with an empty label beside a medicine reads as a
 * state somebody assigned rather than as a gap.
 */
export function asStatusPresentation(
  raw: StatusPresentationResponse | null | undefined,
): StatusPresentation | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw.label !== 'string' || raw.label.trim() === '') return null;
  if (typeof raw.description !== 'string' || raw.description.trim() === '') return null;
  if (typeof raw.accessibilityLabel !== 'string' || raw.accessibilityLabel.trim() === '') {
    return null;
  }
  if (!(ICON_NAMES as readonly string[]).includes(raw.iconName)) return null;
  return {
    label: raw.label,
    iconName: raw.iconName as StatusPresentation['iconName'],
    tone: raw.tone as StatusPresentation['tone'],
    description: raw.description,
    accessibilityLabel: raw.accessibilityLabel,
  };
}

export interface AlertFactView {
  readonly label: string;
  readonly value: string | null;
  readonly basis: string;
  readonly basisText: string;
}

export interface AlertDetailScreenView {
  readonly alertPublicationId: string;
  readonly ownedItemId: string;
  readonly isLive: boolean;
  readonly withdrawnNotice: string | null;
  readonly message: readonly string[] | null;
  readonly unexplainable: { readonly heading: string; readonly body: string } | null;
  readonly withheldNotice: string | null;
  readonly urgency: StatusPresentation | null;
  readonly evidence: StatusPresentation | null;
  readonly matchConfidence: StatusPresentation | null;
  readonly facts: readonly AlertFactView[];
  /** Facts dropped because this build could not label where they came from. */
  readonly unlabelledFactCount: number;
  readonly unlabelledFactNote: string | null;
  readonly reasons: readonly string[];
  readonly undescribedReasonNote: string | null;
  readonly source: {
    readonly summary: string;
    readonly reference: string | null;
    readonly referenceWithheldBecause: string | null;
    readonly attribution: string | null;
  };
  readonly coverageStatement: string;
  readonly basisNote: string;
  readonly inferredCount: number;
  readonly actions: readonly {
    readonly action: string;
    readonly label: string;
    readonly explanation: string;
  }[];
  readonly actionsUnavailableBecause: string | null;
}

/**
 * The detail, as a screen renders it.
 *
 * Almost a pass-through, because the server composed the message: `11` puts safety composition
 * server-side and a client that rebuilt any of it would carry approved wording in every shipped
 * build. What this function does decide is the one thing a client must - what to do with a value
 * it does not recognise.
 *
 * A fact whose basis this build cannot label is **dropped and counted**. The whole point of the
 * screen is that every line says where it came from, so a line with an unlabelled origin defeats
 * it more thoroughly than an omission the screen admits to - the same choice the Lens makes for
 * an undescribed regulatory status (DEC-065).
 */
export function alertDetailScreenView(response: AlertDetailResponse): AlertDetailScreenView {
  const labelled: AlertFactView[] = [];
  let unlabelled = 0;

  for (const entry of response.facts) {
    if (!KNOWN_FACT_BASES.includes(entry.basis)) {
      unlabelled += 1;
      continue;
    }
    labelled.push(entry);
  }

  return {
    alertPublicationId: response.alertPublicationId,
    ownedItemId: response.ownedItemId,
    isLive: response.isLive,
    withdrawnNotice: response.withdrawnNotice,
    message: response.message,
    unexplainable: response.unexplainable,
    withheldNotice: response.withheldNotice,
    // Presented separately and never combined (`23` D-005). Narrowed rather than trusted: a
    // half-formed presentation would render as a chip with a blank label, which on a safety
    // screen reads as a state nobody assigned.
    urgency: asStatusPresentation(response.urgency),
    evidence: asStatusPresentation(response.evidence),
    matchConfidence: asStatusPresentation(response.matchConfidence),
    facts: labelled,
    unlabelledFactCount: unlabelled,
    unlabelledFactNote:
      unlabelled === 0
        ? null
        : `Kynviora sent ${String(unlabelled)} further ${
            unlabelled === 1 ? 'detail' : 'details'
          } this version cannot say the origin of, so they are not shown.`,
    reasons: response.reasons.reasons,
    undescribedReasonNote: response.reasons.undescribedNote,
    source: {
      summary: response.source.summary,
      reference: response.source.reference,
      referenceWithheldBecause: response.source.referenceWithheldBecause,
      attribution: response.source.attribution,
    },
    coverageStatement: response.coverageStatement,
    basisNote: response.basisNote,
    inferredCount: response.inferredCount,
    actions: response.actions,
    actionsUnavailableBecause: response.actionsUnavailableBecause,
  };
}

// ---------------------------------------------------------------------------
// The Safety Receipt (`04` Phase 7.6)
// ---------------------------------------------------------------------------

export interface ReceiptOptionView {
  readonly resolution: string;
  readonly label: string;
  readonly description: string;
  readonly accessibilityLabel: string;
  readonly isFeedback: boolean;
}

export interface SafetyReceiptScreenView {
  readonly alertPublicationId: string;
  readonly current: SafetyReceiptResponse['current'];
  readonly undescribedResolutionNote: string | null;
  readonly history: SafetyReceiptResponse['history'];
  readonly undescribedHistoryNote: string | null;
  readonly basis: SafetyReceiptResponse['basis'];
  readonly source: {
    readonly summary: string;
    readonly reference: string | null;
    readonly referenceWithheldBecause: string | null;
    readonly attribution: string | null;
  };
  readonly corrections: SafetyReceiptResponse['corrections'];
  readonly correctedSinceNotice: string | null;
  readonly uncertainties: readonly string[];
  readonly emptyMessage: string;
  readonly permanenceNote: string;
  /**
   * What the person may record now, in the vocabulary's order.
   *
   * Two groups, actions first. The one that currently stands is not offered: choosing it again
   * writes nothing, and a control that does nothing reads as one that failed.
   */
  readonly actionOptions: readonly ReceiptOptionView[];
  readonly feedbackOptions: readonly ReceiptOptionView[];
}

/**
 * The receipt, as a screen renders it.
 *
 * Almost a pass-through, for the same reason the alert detail is: `11` puts safety composition on
 * the server, and a client that rebuilt any of this would carry approved wording in every shipped
 * build. The options are the exception - they are a control list rather than a statement about
 * this person's alert, so they come from `@kynviora/presentation` and never from the response.
 *
 * The server sends `currentResolution` as a code for exactly this: the client needs to know which
 * control to withhold without parsing the label it was sent.
 */
export function safetyReceiptScreenView(response: SafetyReceiptResponse): SafetyReceiptScreenView {
  const standing = isSafetyResolution(response.currentResolution)
    ? [response.currentResolution]
    : [];
  const options = resolutionOptions(standing).map((option) => ({
    resolution: option.resolution,
    label: option.presentation.label,
    description: option.presentation.description,
    accessibilityLabel: option.presentation.accessibilityLabel,
    isFeedback: option.presentation.isFeedback,
  }));

  return {
    alertPublicationId: response.alertPublicationId,
    current: response.current,
    undescribedResolutionNote: response.undescribedResolutionNote,
    history: response.history,
    // Counted rather than silent, the same choice made for an unlabelled fact on the detail.
    undescribedHistoryNote:
      response.undescribedHistoryCount === 0
        ? null
        : `Kynviora holds ${String(response.undescribedHistoryCount)} further ${
            response.undescribedHistoryCount === 1 ? 'record' : 'records'
          } about this alert that this version has no wording for. They are still kept.`,
    basis: response.basis,
    source: {
      summary: response.source.summary,
      reference: response.source.reference,
      referenceWithheldBecause: response.source.referenceWithheldBecause,
      attribution: response.source.attribution,
    },
    corrections: response.corrections,
    correctedSinceNotice: response.correctedSinceNotice,
    uncertainties: response.uncertainties,
    emptyMessage: response.emptyMessage,
    permanenceNote: response.permanenceNote,
    actionOptions: options.filter((option) => !option.isFeedback),
    feedbackOptions: options.filter((option) => option.isFeedback),
  };
}

// ---------------------------------------------------------------------------
// Item detail (`04` Phase 2.1)
// ---------------------------------------------------------------------------

export interface ItemDetailScreenView {
  readonly id: string;
  readonly displayName: string;
  readonly brand: string | null;
  readonly itemKind: ItemKind;
  readonly lifecycleNote: string | null;
  /** Narrowed. A presentation the client could not read is absent rather than rendered blank. */
  readonly identity: StatusPresentation | null;
  readonly formulation: StatusPresentation | null;
  readonly batch: StatusPresentation | null;
  readonly verificationNote: string;
  readonly categoryHeading: string;
  readonly categoryFields: ItemDetailResponse['categoryFields'];
  readonly sharedFields: ItemDetailResponse['sharedFields'];
  readonly attention: ItemDetailResponse['attention'];
}

/**
 * The item detail, as a screen renders it.
 *
 * A pass-through except for the three chips, which are narrowed rather than trusted: a
 * half-formed presentation would render as a chip with a blank label, and on a screen whose
 * subject is how well Kynviora knows something, a blank label reads as a state nobody assigned.
 * The same choice the alert detail makes.
 */
export function itemDetailScreenView(response: ItemDetailResponse): ItemDetailScreenView {
  return {
    id: response.id,
    displayName: response.displayName,
    brand: response.brand,
    itemKind: asItemKind(response.itemKind),
    lifecycleNote: response.lifecycleNote,
    identity: asStatusPresentation(response.identity),
    formulation: asStatusPresentation(response.formulation),
    batch: asStatusPresentation(response.batch),
    verificationNote: response.verificationNote,
    categoryHeading: response.categoryHeading,
    categoryFields: response.categoryFields,
    sharedFields: response.sharedFields,
    attention: response.attention,
  };
}

// ---------------------------------------------------------------------------
// Manual entry (`04` Phases 2.2 and 2.3)
// ---------------------------------------------------------------------------

/**
 * A field a submission may carry, as a value rather than only as a type.
 *
 * `profileId` and `itemKind` are excluded because they are not things somebody types into a
 * field: one narrows the write and the other decides which form is on the screen.
 */
export type ManualEntryField = Exclude<keyof ManualEntryBody, 'profileId' | 'itemKind'>;

/**
 * Every field name a submission may carry, checked in both directions by the compiler.
 *
 * `satisfies Record<ManualEntryField, true>` fails if a field is missing and fails if one is
 * invented, which is the point: the form lives in `@kynviora/presentation` and the body lives in
 * `client.ts`, and a typo in a form field's key would otherwise mean that field is silently never
 * sent. A barcode a person typed and Kynviora quietly dropped is worse than one they never
 * entered, because the screen would say it had been recorded.
 */
const MANUAL_ENTRY_FIELD_PRESENCE = {
  displayName: true,
  brand: true,
  manufacturer: true,
  market: true,
  recordedGtin: true,
  recordedLotCode: true,
  expiresOn: true,
  startedOn: true,
  notes: true,
  strengthText: true,
  dosageForm: true,
  directionsText: true,
  personalCareCategory: true,
  ingredientDeclarationRaw: true,
  labelVersionNote: true,
} as const satisfies Record<ManualEntryField, true>;

export const MANUAL_ENTRY_FIELDS: readonly ManualEntryField[] = Object.freeze(
  Object.keys(MANUAL_ENTRY_FIELD_PRESENCE) as ManualEntryField[],
);

export function isManualEntryField(value: string): value is ManualEntryField {
  return Object.prototype.hasOwnProperty.call(MANUAL_ENTRY_FIELD_PRESENCE, value);
}

/**
 * What somebody typed, as a body.
 *
 * WHICH FIELDS CAN BE SENT IS THE FORM'S DECISION, NOT A SCREEN'S
 * The fields come from {@link manualEntryForm}, so a value for a field the form for this category
 * does not offer cannot be submitted. That matters because the domain refuses a medicine carrying
 * a personal-care category outright: a draft left behind when somebody changed their mind about
 * what they were adding would otherwise be refused with a message about a field they never saw.
 *
 * A BLANK FIELD IS OMITTED, AND NOTHING ELSE IS TOUCHED
 * `04` Phase 2.2's second exit criterion is that a missing field stays explicitly unknown. A
 * field somebody left blank is not sent, so it is stored as an absence rather than as an empty
 * string that a screen would render as an answer. Every field that *is* sent is sent exactly as
 * typed - not trimmed, not upper-cased, not stripped of spaces. The domain refuses a malformed
 * value and names the field; a value this client had quietly repaired is one nobody can check
 * against the pack in their hand.
 *
 * The name is always sent, even blank. A missing key fails the body schema and comes back as a
 * generic "invalid request body"; an empty one reaches the domain, which refuses it naming
 * `displayName` - and only the second lets a form point at the field somebody has to fill in.
 */
export function manualEntryDraft(input: {
  readonly profileId: string;
  readonly itemKind: ItemKind;
  readonly values: Readonly<Record<string, string>>;
}): ManualEntryBody {
  const offered: Partial<Record<ManualEntryField, string>> = {};

  for (const field of manualEntryForm(input.itemKind).fields) {
    if (field.field === 'displayName') continue;
    if (!isManualEntryField(field.field)) continue;
    const typed = input.values[field.field];
    if (typed === undefined || typed.trim() === '') continue;
    offered[field.field] = typed;
  }

  return {
    profileId: input.profileId,
    itemKind: input.itemKind,
    displayName: input.values['displayName'] ?? '',
    ...offered,
  };
}
