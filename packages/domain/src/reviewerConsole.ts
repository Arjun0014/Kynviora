/**
 * Reviewer queue and publication controls.
 *
 * Spec references: `04` Phase 6.6, `10` (required roles, separation of duties, review states,
 * emergency controls, governance audit artifacts), `13` (reviewer console backend), `14`
 * (reviewer/admin security), `15` (reviewer compromise), `23` (approval requirements).
 *
 * THE TWO EXIT CRITERIA, AND WHAT THEY ACTUALLY DEMAND
 *
 * 1. "High-impact content cannot be published by an unauthorized single path."
 *    Two words carry it. *Unauthorized*: the right to approve comes from a stored reviewer role,
 *    never from a claim in a request - `14` says admin/reviewer roles are not inferred from
 *    client claims. *Single*: for high-impact content, two **different** people must approve, and
 *    neither may be the person who asked. `10`'s separation of duties lists source ingestion,
 *    rule authoring, clinical approval, publication and correction approval as things one person
 *    should not do all of.
 *
 * 2. "Publication is attributable, reversible, and scoped to the intended jurisdiction."
 *    *Attributable*: every approval names a person and the role they used. *Reversible*:
 *    withdrawal exists, and deliberately costs less than publication - see
 *    {@link requiredApprovals}. *Scoped*: an approval records which jurisdictions the reviewer
 *    actually reviewed, and {@link evaluatePublication} requires every requested jurisdiction to
 *    reach the approval count **on its own**. Approving for GB does not publish for NI.
 *
 * WHY THE ROLE MATTERS AND NOT JUST THE COUNT
 * `10` states that regulatory comparison is a separate publication responsibility from clinical
 * safety assessment. So two approvals are not interchangeable: a legal-scope reviewer cannot
 * approve a safety rule, and a medication safety reviewer cannot approve a legal status. Without
 * that, "two-person approval" degrades into two people who both lack the standing to judge -
 * which reads as governance and is not.
 *
 * WHAT THIS MODULE DOES NOT DECIDE
 * It does not decide whether the content is correct. Nothing here inspects a rule's matching
 * criteria or a regulatory record's statuses; that judgement belongs to the reviewer, and
 * `BLK-006` is exactly the fact that no qualified reviewer has made it yet. This module builds
 * the workflow such a person would use, and makes publishing without them unrepresentable.
 */

import type { EvidenceLevel, ActionUrgency, Jurisdiction } from './vocabulary.js';
import type { Instant } from './ports.js';
import type { UserId } from './ids.js';
import type { DomainError, Result } from './result.js';
import { failure, ok } from './result.js';

// ---------------------------------------------------------------------------
// Reviewer roles
// ---------------------------------------------------------------------------

/**
 * The named roles `10` requires before public Safety Watch alerts.
 *
 * A closed list, and a reviewer holds one by having a stored row - not by presenting a claim.
 * `14`: "Admin/reviewer roles are not inferred from client claims", and `13` forbids shared
 * accounts, which is why a role is held by a user ID rather than by a name string. The columns
 * `assessment_rule_version.approved_by_reviewer_id` and its regulatory equivalents were free text
 * before this phase; they now record a real user.
 */
export const REVIEWER_ROLES = [
  'CLINICAL_SAFETY_LEAD',
  'MEDICATION_SAFETY_REVIEWER',
  'PRODUCT_SAFETY_REVIEWER',
  'REGULATORY_LEGAL_REVIEWER',
  'SOURCE_OPERATIONS_OWNER',
  'CONTENT_PLAIN_LANGUAGE_OWNER',
] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export const REVIEWER_STATUSES = ['ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export type ReviewerStatus = (typeof REVIEWER_STATUSES)[number];

export interface ReviewerGrant {
  readonly userId: UserId;
  readonly role: ReviewerRole;
  readonly status: ReviewerStatus;
}

// ---------------------------------------------------------------------------
// What can be published
// ---------------------------------------------------------------------------

/**
 * The kinds of content that pass through this queue.
 *
 * Named after the tables they live in, as the Review Inbox subjects are, so a request row can
 * only ever point at something the publication step knows how to write.
 */
export const PUBLISHABLE_KINDS = [
  'assessment_rule_version',
  'regulatory_rule_version',
  'product_regulatory_action',
  'alert_publication',
] as const;
export type PublishableKind = (typeof PUBLISHABLE_KINDS)[number];

/**
 * Which roles may approve which kind of content.
 *
 * The clinical / regulatory split is `10`'s, in terms: "Regulatory comparison is a separate
 * publication responsibility from clinical safety assessment." A single "reviewer" role would
 * make the two-person rule satisfiable by two people neither of whom is qualified to judge the
 * thing in front of them.
 *
 * `CONTENT_PLAIN_LANGUAGE_OWNER` may approve an alert publication and nothing else: `10`'s review
 * states list content review as its own step, and an alert is the only one of these that puts
 * sentences in front of a user. It cannot approve a rule or a legal status, because reviewing the
 * wording is not reviewing the finding.
 */
export const APPROVING_ROLES: Readonly<Record<PublishableKind, readonly ReviewerRole[]>> =
  Object.freeze({
    assessment_rule_version: [
      'CLINICAL_SAFETY_LEAD',
      'MEDICATION_SAFETY_REVIEWER',
      'PRODUCT_SAFETY_REVIEWER',
    ],
    regulatory_rule_version: ['REGULATORY_LEGAL_REVIEWER'],
    product_regulatory_action: ['REGULATORY_LEGAL_REVIEWER', 'SOURCE_OPERATIONS_OWNER'],
    alert_publication: [
      'CLINICAL_SAFETY_LEAD',
      'MEDICATION_SAFETY_REVIEWER',
      'PRODUCT_SAFETY_REVIEWER',
      'CONTENT_PLAIN_LANGUAGE_OWNER',
    ],
  });

export function mayApprove(kind: PublishableKind, role: ReviewerRole): boolean {
  return APPROVING_ROLES[kind].includes(role);
}

// ---------------------------------------------------------------------------
// Actions and decisions
// ---------------------------------------------------------------------------

export const PUBLICATION_ACTIONS = ['PUBLISH', 'WITHDRAW'] as const;
export type PublicationAction = (typeof PUBLICATION_ACTIONS)[number];

/** `04` Phase 6.6: "publish/reject/return-for-correction". */
export const APPROVAL_DECISIONS = ['APPROVE', 'REJECT', 'RETURN_FOR_CORRECTION'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const REQUEST_STATES = [
  'OPEN',
  'EXECUTED',
  'REJECTED',
  'RETURNED_FOR_CORRECTION',
  'CANCELLED',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

// ---------------------------------------------------------------------------
// How many people
// ---------------------------------------------------------------------------

/** The declared impact of the content, as its author and reviewers classify it. */
export interface DeclaredImpact {
  /** The ceiling on what the content may tell a user to do. Set by a person, never computed. */
  readonly maxUrgency: ActionUrgency;
  readonly evidenceLevel: EvidenceLevel;
}

/**
 * How many distinct approvers a request needs, per jurisdiction.
 *
 * `10`: "Define which urgency/evidence classes require two-person approval." This is that
 * definition.
 *
 * It is **not** a conversion between evidence level and urgency, and not an aggregate score -
 * both of which the codebase forbids and tests for. It returns a number of *people*, which is a
 * governance quantity, and it reads the two fields independently rather than combining them into
 * a rating of the content. Nothing here can be used to derive an urgency from an evidence level
 * or the reverse.
 *
 * The rules:
 *  - `CRITICAL` or `HIGH` urgency needs two. This is the "high-impact content" of the exit
 *    criterion: content that tells someone to act now.
 *  - `MEDIUM` urgency on `D` or `U` evidence needs two. A confidently-worded next step resting on
 *    limited or insufficient information is exactly the combination one person should not be able
 *    to publish alone, and it is the shape a false positive takes.
 *  - Everything else needs one, reviewed and attributable but not blocking.
 *  - **Withdrawal always needs one.** See {@link WITHDRAWAL_IS_CHEAPER_BY_DESIGN}.
 */
export function requiredApprovals(action: PublicationAction, impact: DeclaredImpact | null): 1 | 2 {
  if (action === 'WITHDRAW') return 1;
  if (impact === null) return 2;
  if (impact.maxUrgency === 'CRITICAL' || impact.maxUrgency === 'HIGH') return 2;
  if (
    impact.maxUrgency === 'MEDIUM' &&
    (impact.evidenceLevel === 'D' || impact.evidenceLevel === 'U')
  ) {
    return 2;
  }
  return 1;
}

/**
 * Why withdrawal is deliberately easier than publication.
 *
 * The two failure modes are not symmetric, and treating them symmetrically would make the safe
 * direction the slow one. A wrongly-published alert tells a real person to do something on
 * Kynviora's authority; a wrongly-withdrawn one removes information, which is the state the
 * product is in for every item it does not cover anyway. `15`'s reviewer-compromise threat is
 * about creating false publications, not about removing them.
 *
 * So `10`'s emergency controls - "withdraw one alert publication", "block publication globally" -
 * are single-person operations, and the separation-of-duties rule that forbids the requester from
 * approving their own request applies to `PUBLISH` alone. Requiring a second person before a live
 * wrong alert can be stopped would mean the alert stays up while somebody is found.
 */
export const WITHDRAWAL_IS_CHEAPER_BY_DESIGN = true;

// ---------------------------------------------------------------------------
// The high-severity publication checklist
// ---------------------------------------------------------------------------

/**
 * What `10` requires a reviewer to verify before high-severity publication.
 *
 * Transcribed from `10`'s checklist, one member per line of it. Encoded here rather than left as
 * prose because a checklist nobody records is a checklist nobody performs: two people clicking
 * approve is not the same as two people confirming these ten things, and only the second is what
 * the governance model actually asks for.
 *
 * Recorded per approval rather than per request, deliberately. The point of a second reviewer is
 * that they check independently; letting the first one's confirmations stand for both would make
 * the second signature ceremonial.
 */
export const PUBLICATION_CHECKLIST = [
  'SOURCE_AUTHENTICITY',
  'EXACT_JURISDICTION',
  'AFFECTED_IDENTIFIERS',
  'RULE_MATCHING_BEHAVIOUR',
  'USER_ACTION_WORDING',
  'MEDICATION_BOUNDARY',
  'EXPECTED_MATCH_VOLUME',
  'NOTIFICATION_POLICY',
  'WITHDRAWAL_READINESS',
  'INCIDENT_OWNER',
] as const;
export type ChecklistItem = (typeof PUBLICATION_CHECKLIST)[number];

/** Which checklist items a reviewer has not confirmed. */
export function missingChecklistItems(
  confirmed: readonly ChecklistItem[],
): readonly ChecklistItem[] {
  const seen = new Set(confirmed);
  return PUBLICATION_CHECKLIST.filter((item) => !seen.has(item));
}

/**
 * Whether this request's approvals must carry the checklist.
 *
 * Tied to the two-person threshold rather than to a separate setting, so "high-impact" means one
 * thing in this module. Content that needs a second pair of hands is content that needs the ten
 * checks; content that needs one is not high-severity by `10`'s own definition.
 *
 * A withdrawal never does. The checklist is about what publishing something will do to people,
 * and stopping something does none of it.
 */
export function checklistRequired(
  action: PublicationAction,
  impact: DeclaredImpact | null,
): boolean {
  return action === 'PUBLISH' && requiredApprovals(action, impact) === 2;
}

// ---------------------------------------------------------------------------
// Requests and approvals
// ---------------------------------------------------------------------------

export interface PublicationRequest {
  readonly subjectKind: PublishableKind;
  readonly subjectId: string;
  readonly action: PublicationAction;
  /** The scope the publication is intended to cover. Never empty. */
  readonly jurisdictions: readonly Jurisdiction[];
  readonly impact: DeclaredImpact | null;
  readonly requestedByUserId: UserId;
  readonly state: RequestState;
  /** Required for a withdrawal. `10` retains the correction/withdrawal reason. */
  readonly withdrawalReason: string | null;
}

export interface RecordedApproval {
  readonly reviewerUserId: UserId;
  readonly role: ReviewerRole;
  readonly decision: ApprovalDecision;
  /** What this reviewer actually reviewed. May be narrower than the request. */
  readonly jurisdictions: readonly Jurisdiction[];
}

// ---------------------------------------------------------------------------
// Recording one approval
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  readonly decision: ApprovalDecision;
  readonly jurisdictions: readonly Jurisdiction[];
  readonly note: string | null;
  /** Which of `10`'s checks this reviewer performed. Required for high-severity publication. */
  readonly checklistConfirmed: readonly ChecklistItem[];
}

export interface ApprovalPlan {
  readonly decision: ApprovalDecision;
  readonly role: ReviewerRole;
  readonly jurisdictions: readonly Jurisdiction[];
  readonly checklistConfirmed: readonly ChecklistItem[];
  readonly note: string | null;
  readonly decidedAt: Instant;
  readonly reviewerUserId: UserId;
}

/**
 * Decide whether one reviewer may record one decision on one request.
 *
 * The checks, and which requirement each one is:
 *
 *  - the reviewer holds an **active** stored role (`14`: not inferred from a claim);
 *  - the role may approve **this kind** of content (`10`: regulatory is a separate
 *    responsibility from clinical);
 *  - the reviewer is not the person who asked, for a publication (`10`: separation of duties);
 *  - the reviewer reviewed at least one jurisdiction the request actually covers, and none it
 *    does not - approving `NI` on a `GB` request records a review nobody performed;
 *  - the request is still open.
 */
export function evaluateApproval(
  request: PublicationRequest,
  reviewer: ReviewerGrant,
  approval: ApprovalRequest,
  actor: { readonly now: Instant },
): Result<ApprovalPlan, DomainError> {
  if (request.state !== 'OPEN') {
    return failure('VALIDATION_FAILED', 'This request has already been decided.', {
      reason_code: 'request_not_open',
    });
  }

  if (reviewer.status !== 'ACTIVE') {
    return failure('PERMISSION_DENIED', 'That reviewer role is not active.', {
      reason_code: 'reviewer_not_active',
    });
  }

  // The next two are VALIDATION_FAILED rather than PERMISSION_DENIED, and the distinction is
  // deliberate. `PERMISSION_DENIED` maps to a bare 404 so the API is not an existence oracle -
  // but this caller is an established reviewer who can already see the request in their queue, so
  // there is nothing left to hide and a silent 404 would only cost them the reason. What is wrong
  // here is the *pairing* of this reviewer with this request, not their standing to be looking at
  // it at all. Not holding a reviewer role stays PERMISSION_DENIED, because that is about
  // standing.
  if (!mayApprove(request.subjectKind, reviewer.role)) {
    // `10`: regulatory comparison is a separate publication responsibility from clinical safety
    // assessment. Two approvals from people who cannot judge the content are not governance.
    return failure('VALIDATION_FAILED', 'That role does not review this kind of content.', {
      reason_code: 'role_not_permitted_for_kind',
    });
  }

  if (request.action === 'PUBLISH' && reviewer.userId === request.requestedByUserId) {
    return failure('VALIDATION_FAILED', 'You cannot approve your own publication request.', {
      reason_code: 'separation_of_duties',
    });
  }

  if (approval.jurisdictions.length === 0) {
    return failure('VALIDATION_FAILED', 'Say which jurisdictions you reviewed.', {
      reason_code: 'approval_needs_a_scope',
    });
  }

  const outsideScope = approval.jurisdictions.filter((j) => !request.jurisdictions.includes(j));
  if (outsideScope.length > 0) {
    return failure('VALIDATION_FAILED', 'That is outside what this request covers.', {
      reason_code: 'approval_scope_exceeds_request',
      outside: outsideScope.join(','),
    });
  }

  // Only an approval carries the checklist. A rejection or a return-for-correction is the
  // reviewer saying the content is not ready, and demanding they first confirm ten things about
  // it would be asking them to vouch for what they are refusing.
  if (approval.decision === 'APPROVE' && checklistRequired(request.action, request.impact)) {
    const missing = missingChecklistItems(approval.checklistConfirmed);
    if (missing.length > 0) {
      return failure('VALIDATION_FAILED', 'Some of the pre-publication checks are outstanding.', {
        reason_code: 'checklist_incomplete',
        missing: missing.join(','),
      });
    }
  }

  return ok({
    decision: approval.decision,
    role: reviewer.role,
    jurisdictions: [...approval.jurisdictions],
    checklistConfirmed: approval.decision === 'APPROVE' ? [...approval.checklistConfirmed] : [],
    note: approval.note,
    decidedAt: actor.now,
    reviewerUserId: reviewer.userId,
  });
}

// ---------------------------------------------------------------------------
// Deciding whether it may be published
// ---------------------------------------------------------------------------

export interface PublicationOutcome {
  readonly action: PublicationAction;
  /** Exactly the jurisdictions that reached the approval count. Written to the target record. */
  readonly approvedJurisdictions: readonly Jurisdiction[];
  readonly requiredApprovals: 1 | 2;
  readonly executedAt: Instant;
  readonly executedByUserId: UserId;
}

/** Per-jurisdiction approval tally, so a refusal can say which scope fell short. */
export interface JurisdictionTally {
  readonly jurisdiction: Jurisdiction;
  readonly approvals: number;
}

export function tallyByJurisdiction(
  request: PublicationRequest,
  approvals: readonly RecordedApproval[],
): readonly JurisdictionTally[] {
  return request.jurisdictions.map((jurisdiction) => ({
    jurisdiction,
    // Distinct people, not distinct approval rows. Counting rows would let one reviewer satisfy
    // a two-person rule by recording the same decision twice.
    approvals: new Set(
      approvals
        .filter((a) => a.decision === 'APPROVE' && a.jurisdictions.includes(jurisdiction))
        .map((a) => a.reviewerUserId),
    ).size,
  }));
}

/**
 * Decide whether a request may be executed.
 *
 * This is exit criterion 1 as a function. Every path to changing a target's `review_state` runs
 * through it, and it refuses unless:
 *
 *  - the request is open and nobody has rejected or returned it;
 *  - publication is not globally blocked (`10`'s emergency control) - withdrawal still is
 *    allowed, because blocking publication must never block stopping something;
 *  - **every** requested jurisdiction independently has the required number of distinct
 *    approvers. GB and NI are separate by design, and an approval covering one is not an approval
 *    covering the other.
 *
 * The executor is checked too. A publication is performed by a reviewer, not by whoever holds a
 * session - and for a publication they may not be the requester, so authoring and publishing are
 * different hands as `10` requires.
 */
export function evaluatePublication(
  request: PublicationRequest,
  approvals: readonly RecordedApproval[],
  executor: { readonly userId: UserId; readonly now: Instant; readonly isReviewer: boolean },
  environment: { readonly publicationBlocked: boolean },
): Result<PublicationOutcome, DomainError> {
  if (request.state !== 'OPEN') {
    return failure('VALIDATION_FAILED', 'This request has already been decided.', {
      reason_code: 'request_not_open',
    });
  }

  if (!executor.isReviewer) {
    return failure('PERMISSION_DENIED', 'Only a reviewer can do this.', {
      reason_code: 'executor_not_a_reviewer',
    });
  }

  const blocking = approvals.find((a) => a.decision !== 'APPROVE');
  if (blocking !== undefined) {
    // A rejection or a return-for-correction is not outvoted by later approvals. Someone said the
    // content was not ready, and clearing that takes a new request, not more signatures.
    return failure('VALIDATION_FAILED', 'A reviewer has asked for changes.', {
      reason_code: 'outstanding_objection',
      decision: blocking.decision,
    });
  }

  if (request.action === 'PUBLISH' && environment.publicationBlocked) {
    return failure('VALIDATION_FAILED', 'Publication is currently blocked.', {
      reason_code: 'publication_blocked',
    });
  }

  if (request.action === 'PUBLISH' && executor.userId === request.requestedByUserId) {
    // Same reasoning as in {@link evaluateApproval}: the caller is a reviewer, the request is
    // theirs, and the only thing wrong is that authoring and publishing must be different hands.
    return failure('VALIDATION_FAILED', 'You cannot publish your own request.', {
      reason_code: 'separation_of_duties',
    });
  }

  if (request.action === 'WITHDRAW') {
    if (request.withdrawalReason === null || request.withdrawalReason.trim().length === 0) {
      return failure('VALIDATION_FAILED', 'Record why this is being withdrawn.', {
        reason_code: 'withdrawal_needs_a_reason',
      });
    }
  }

  const needed = requiredApprovals(request.action, request.impact);
  const tally = tallyByJurisdiction(request, approvals);
  const short = tally.filter((entry) => entry.approvals < needed);
  if (short.length > 0) {
    return failure('VALIDATION_FAILED', 'This still needs review.', {
      reason_code: 'insufficient_approvals',
      required: needed,
      short_jurisdictions: short.map((entry) => entry.jurisdiction).join(','),
    });
  }

  return ok({
    action: request.action,
    approvedJurisdictions: tally.map((entry) => entry.jurisdiction),
    requiredApprovals: needed,
    executedAt: executor.now,
    executedByUserId: executor.userId,
  });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const REVIEWER_AUDIT_ACTIONS = [
  'publication.requested',
  'publication.approved',
  'publication.rejected',
  'publication.returned',
  'publication.executed',
  'publication.blocked',
  'publication.unblocked',
  'reviewer.role.granted',
  'reviewer.role.revoked',
] as const;
export type ReviewerAuditAction = (typeof REVIEWER_AUDIT_ACTIONS)[number];

/**
 * Audit detail for a publication decision.
 *
 * `10`'s governance audit artifacts: who reviewed, the approval count, the publication target and
 * jurisdiction, and the withdrawal reason where there is one. Deliberately no content: `20` says
 * the audit log must not become a verbose copy of health material, and the target ID plus the
 * version is enough to reconstruct what was published.
 */
export function publicationAuditDetail(input: {
  readonly action: PublicationAction;
  readonly subjectKind: PublishableKind;
  readonly jurisdictions: readonly Jurisdiction[];
  readonly requiredApprovals: number;
  readonly approverCount: number;
  readonly hadWithdrawalReason: boolean;
}): Readonly<Record<string, string | number | boolean | null>> {
  return {
    action: input.action,
    subject_kind: input.subjectKind,
    jurisdictions: [...input.jurisdictions].sort().join(','),
    required_approvals: input.requiredApprovals,
    approver_count: input.approverCount,
    withdrawal_reason_recorded: input.hadWithdrawalReason,
  };
}
