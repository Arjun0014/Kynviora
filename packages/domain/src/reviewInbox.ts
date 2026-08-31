/**
 * Household Review Inbox: the non-urgent work that keeps the data worth trusting.
 *
 * Spec references: `04` Phase 8.3, `03` group G (the alert experience this must not resemble),
 * `08` (Trust Passport verification facets), `09` (evidence and urgency belong to alerts), `18`
 * (calm, non-shaming language), `16` (a caregiver acts under the capability they were granted).
 *
 * THE TWO EXIT CRITERIA, AND WHY BOTH ARE STRUCTURAL
 *
 *  1. **Review tasks are clearly different from safety alerts.** Not a styling note. A review
 *     task has no urgency, no evidence level, no match confidence and no severity - the fields do
 *     not exist on {@link ReviewTask}, so a screen cannot render them and a future change cannot
 *     quietly add one without this module changing. `09` keeps evidence and urgency as properties
 *     of an *assessment*; a task saying "this pack has no batch number recorded" is not an
 *     assessment of anything and must not borrow the vocabulary of one.
 *
 *  2. **Completing a task updates the relevant authoritative record.** This is the harder one,
 *     because the obvious implementation - a `state` column and a Done button - satisfies it in
 *     appearance and violates it in fact. So closing is not expressible as a state change here:
 *     {@link evaluateCompletion} requires a non-empty list of changes, requires each one to target
 *     this task's own subject, and requires each field to be on the closed list of fields that
 *     this kind of task is actually about. A task that could be closed while writing nothing
 *     would make the inbox a to-do list, and a to-do list about someone's medicines is worse than
 *     nothing: it produces the feeling of having maintained the data without the fact.
 *
 * "Not applicable" is not an exception to that. Deciding a task does not apply is itself
 * information about the record - "I looked at this pack and the details are right" is exactly
 * what `last_reviewed_at` means - so both outcomes write, and neither can write nothing.
 */

import type { ProfileId, ReviewTaskId } from './ids.js';
import type { Instant } from './ports.js';
import type { DomainError, Result } from './result.js';
import { failure, ok } from './result.js';
import type { CaregiverCapability } from './vocabulary.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The task kinds, exactly as `04` Phase 8.3 lists them.
 *
 * Mirrors the `review_task_kind_valid` CHECK constraint. A test asserts the two agree, so a kind
 * added in one place and not the other fails the suite rather than producing rows the domain
 * cannot describe.
 */
export const REVIEW_TASK_KINDS = [
  'ITEM_NOT_REVIEWED_RECENTLY',
  'BATCH_MISSING',
  'FORMULA_NEEDS_CONFIRMATION',
  'OCR_FIELD_UNRESOLVED',
  'CAREGIVER_GRANT_EXPIRING',
  'SAFETY_ITEM_AWAITING_CONFIRMATION',
  'REFILL_ESTIMATE_NEEDS_REVIEW',
] as const;
export type ReviewTaskKind = (typeof REVIEW_TASK_KINDS)[number];

/** The record a task is about. Every kind has exactly one. */
export const REVIEW_SUBJECT_KINDS = [
  'owned_item',
  'caregiver_grant',
  'alert_publication',
  'refill_estimate',
] as const;
export type ReviewSubjectKind = (typeof REVIEW_SUBJECT_KINDS)[number];

export const SUBJECT_FOR_KIND: Readonly<Record<ReviewTaskKind, ReviewSubjectKind>> = Object.freeze({
  ITEM_NOT_REVIEWED_RECENTLY: 'owned_item',
  BATCH_MISSING: 'owned_item',
  FORMULA_NEEDS_CONFIRMATION: 'owned_item',
  OCR_FIELD_UNRESOLVED: 'owned_item',
  CAREGIVER_GRANT_EXPIRING: 'caregiver_grant',
  SAFETY_ITEM_AWAITING_CONFIRMATION: 'alert_publication',
  REFILL_ESTIMATE_NEEDS_REVIEW: 'refill_estimate',
});

/**
 * The capabilities that admit *completing* each kind. Holding any one of them is enough.
 *
 * Deliberately the capability of the underlying record rather than a single review-inbox
 * permission. `16` gives a caregiver exactly what they were granted, and a shared inbox
 * permission would be a side channel: someone with care access could change a medicine, or extend
 * their own grant, by going through the inbox instead of the screen that governs it.
 *
 * The owned-item kinds list **both** shelf and medicine management, because the binding decision
 * belongs to the database. `owned_item_update` narrows by `item_kind` - `MANAGE_SHELF` for a
 * personal-care product, `MANAGE_MEDICINES` for a medicine - and a task row names only the item's
 * ID, so the domain cannot tell which applies. Listing one of them here would make this function
 * disagree with the policy that actually decides: too strict for half the items, and misleadingly
 * permissive for the other half. It says "you hold a management capability at all", the database
 * says which, and a completion that writes nothing is refused rather than closing the task.
 *
 * `CAREGIVER_GRANT_EXPIRING` is the sharp case and stays singular. It maps to `MANAGE_CAREGIVERS`
 * alone, so a caregiver who merely helps with care cannot renew their own access from the inbox.
 */
export const COMPLETION_CAPABILITIES: Readonly<
  Record<ReviewTaskKind, readonly CaregiverCapability[]>
> = Object.freeze({
  ITEM_NOT_REVIEWED_RECENTLY: ['MANAGE_SHELF', 'MANAGE_MEDICINES'],
  BATCH_MISSING: ['MANAGE_SHELF', 'MANAGE_MEDICINES'],
  FORMULA_NEEDS_CONFIRMATION: ['MANAGE_SHELF', 'MANAGE_MEDICINES'],
  OCR_FIELD_UNRESOLVED: ['MANAGE_SHELF', 'MANAGE_MEDICINES'],
  CAREGIVER_GRANT_EXPIRING: ['MANAGE_CAREGIVERS'],
  SAFETY_ITEM_AWAITING_CONFIRMATION: ['VIEW_SAFETY'],
  REFILL_ESTIMATE_NEEDS_REVIEW: ['MANAGE_MEDICINES'],
});

/**
 * The fields each kind of task is permitted to change.
 *
 * This list is what makes exit criterion 2 say "the **relevant** authoritative record" rather than
 * "some record". Without it, a completion could satisfy the non-empty-change rule by touching an
 * unrelated field, and the inbox would become a general-purpose write endpoint that happens to
 * close a task.
 */
export const COMPLETABLE_FIELDS: Readonly<Record<ReviewTaskKind, readonly string[]>> =
  Object.freeze({
    ITEM_NOT_REVIEWED_RECENTLY: ['last_reviewed_at'],
    BATCH_MISSING: ['batch_id', 'batch_verification'],
    FORMULA_NEEDS_CONFIRMATION: ['formulation_id', 'formulation_verification'],
    // The user confirming or correcting what an extraction read off their own package.
    OCR_FIELD_UNRESOLVED: ['display_name', 'strength_text', 'dosage_form', 'directions_text'],
    CAREGIVER_GRANT_EXPIRING: ['expires_at', 'status'],
    SAFETY_ITEM_AWAITING_CONFIRMATION: ['resolution'],
    REFILL_ESTIMATE_NEEDS_REVIEW: ['quantity_remaining', 'doses_per_day'],
  });

/**
 * How a task was closed.
 *
 * Both outcomes write. `NOT_APPLICABLE` is not "close without doing anything" - it is the user
 * saying the record is already right, which is itself a fact about the record and the reason
 * `last_reviewed_at` exists.
 */
export const REVIEW_OUTCOMES = ['RESOLVED', 'NOT_APPLICABLE'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export const REVIEW_TASK_STATES = ['OPEN', 'COMPLETED', 'DISMISSED'] as const;
export type ReviewTaskState = (typeof REVIEW_TASK_STATES)[number];

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * An open piece of maintenance work.
 *
 * Note what is absent: no urgency, no evidence level, no match confidence, no severity, no score.
 * That absence is exit criterion 1, and a test asserts it over the type's own keys rather than
 * trusting this comment.
 */
export interface ReviewTask {
  readonly id: ReviewTaskId;
  readonly profileId: ProfileId;
  readonly kind: ReviewTaskKind;
  readonly subjectKind: ReviewSubjectKind;
  readonly subjectId: string;
  readonly state: ReviewTaskState;
  readonly createdAt: Instant;
}

/** Field names a review task must never carry. Asserted against the type in the test suite. */
export const FORBIDDEN_TASK_FIELDS: readonly string[] = Object.freeze([
  'urgency',
  'evidenceLevel',
  'severity',
  'matchConfidence',
  'score',
  'priority',
  'riskLevel',
]);

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * How long before a shelf item is worth looking at again, and how long before a grant expiring
 * is worth mentioning.
 *
 * Engineering defaults, not approved product thresholds (`DEV-012`). They are named constants
 * rather than literals in a query so the eventual product decision changes one line.
 */
export const ITEM_REVIEW_INTERVAL_DAYS = 180;
export const GRANT_EXPIRY_NOTICE_DAYS = 14;
export const REFILL_ESTIMATE_STALE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(from: Instant, to: Instant): number {
  return (Date.parse(to) - Date.parse(from)) / MS_PER_DAY;
}

/** The record state the inbox is derived from. Resolved by the caller under row-level security. */
export interface InboxSnapshot {
  readonly profileId: ProfileId;
  readonly items: readonly {
    readonly id: string;
    readonly itemKind: 'MEDICINE' | 'PERSONAL_CARE';
    readonly lifecycleState: string;
    readonly lastReviewedAt: Instant | null;
    readonly createdAt: Instant;
    readonly batchId: string | null;
    readonly batchVerification: string;
    readonly formulationVerification: string;
    /** True when an extraction produced a field the user has not confirmed or corrected. */
    readonly hasUnresolvedExtraction: boolean;
  }[];
  readonly grants: readonly {
    readonly id: string;
    readonly status: string;
    readonly expiresAt: Instant | null;
  }[];
  readonly alerts: readonly {
    readonly id: string;
    readonly state: string;
    readonly resolution: string | null;
  }[];
  readonly refillEstimates: readonly {
    readonly id: string;
    readonly computedAt: Instant;
    readonly estimatedDepletionOn: string | null;
  }[];
}

export interface DerivedTask {
  readonly kind: ReviewTaskKind;
  readonly subjectKind: ReviewSubjectKind;
  readonly subjectId: string;
}

/**
 * The tasks that *should* be open, given the current state of the records.
 *
 * Pure and deterministic, with the clock passed in. Derivation rather than accumulation means a
 * task cannot outlive the condition that produced it: fix the record and the task stops being
 * derived, which is the same guarantee exit criterion 2 asks for, arriving from the other side.
 *
 * An archived item produces nothing. Neither does a stopped one for review purposes - `18` and
 * `02` both push against manufacturing work, and asking someone to re-review a medicine they
 * stopped taking is work about the past.
 */
export function deriveTasks(snapshot: InboxSnapshot, now: Instant): readonly DerivedTask[] {
  const tasks: DerivedTask[] = [];

  for (const item of snapshot.items) {
    if (item.lifecycleState !== 'ACTIVE') continue;

    const since = item.lastReviewedAt ?? item.createdAt;
    if (daysBetween(since, now) >= ITEM_REVIEW_INTERVAL_DAYS) {
      tasks.push({
        kind: 'ITEM_NOT_REVIEWED_RECENTLY',
        subjectKind: 'owned_item',
        subjectId: item.id,
      });
    }

    // Batch identity only matters for medicines: `03` scopes batch-level recall matching to them,
    // and prompting for a lot number on a bottle of shampoo is noise.
    if (item.itemKind === 'MEDICINE' && item.batchId === null) {
      tasks.push({ kind: 'BATCH_MISSING', subjectKind: 'owned_item', subjectId: item.id });
    }

    // CONFLICTING and PARTIAL are the states where the catalog knows it does not know. UNVERIFIED
    // is deliberately excluded: a manually entered item with no formulation is a legitimate,
    // complete record (`04` Phase 2.2), not an outstanding task.
    if (
      item.formulationVerification === 'CONFLICTING' ||
      item.formulationVerification === 'PARTIAL'
    ) {
      tasks.push({
        kind: 'FORMULA_NEEDS_CONFIRMATION',
        subjectKind: 'owned_item',
        subjectId: item.id,
      });
    }

    if (item.hasUnresolvedExtraction) {
      tasks.push({ kind: 'OCR_FIELD_UNRESOLVED', subjectKind: 'owned_item', subjectId: item.id });
    }
  }

  for (const grant of snapshot.grants) {
    if (grant.status !== 'ACTIVE' || grant.expiresAt === null) continue;
    const daysLeft = daysBetween(now, grant.expiresAt);
    // Already expired produces nothing: there is no access left to renew from an inbox, and the
    // caregiver surface is where a lapsed grant belongs.
    if (daysLeft > 0 && daysLeft <= GRANT_EXPIRY_NOTICE_DAYS) {
      tasks.push({
        kind: 'CAREGIVER_GRANT_EXPIRING',
        subjectKind: 'caregiver_grant',
        subjectId: grant.id,
      });
    }
  }

  for (const alert of snapshot.alerts) {
    // Only a published alert. A withdrawn one must stop being actionable everywhere, and an inbox
    // row asking someone to confirm a retracted alert is exactly the stale-actionable defect `19`
    // treats as release-blocking.
    if (alert.state === 'PUBLISHED' && alert.resolution === null) {
      tasks.push({
        kind: 'SAFETY_ITEM_AWAITING_CONFIRMATION',
        subjectKind: 'alert_publication',
        subjectId: alert.id,
      });
    }
  }

  for (const estimate of snapshot.refillEstimates) {
    const stale = daysBetween(estimate.computedAt, now) >= REFILL_ESTIMATE_STALE_DAYS;
    const passed =
      estimate.estimatedDepletionOn !== null &&
      Date.parse(`${estimate.estimatedDepletionOn}T00:00:00.000Z`) <= Date.parse(now);
    if (stale || passed) {
      tasks.push({
        kind: 'REFILL_ESTIMATE_NEEDS_REVIEW',
        subjectKind: 'refill_estimate',
        subjectId: estimate.id,
      });
    }
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * One field written on the authoritative record.
 *
 * Deliberately named for the record and not for the task: the point of the exit criterion is that
 * something outside the inbox changes.
 */
export interface RecordChange {
  readonly recordKind: ReviewSubjectKind;
  readonly recordId: string;
  readonly field: string;
  readonly value: string | null;
}

export interface CompletionRequest {
  readonly outcome: ReviewOutcome;
  readonly changes: readonly RecordChange[];
}

export interface CompletionAuthority {
  /** True when the caller owns the profile, which admits every capability. */
  readonly isOwner: boolean;
  readonly capabilities: readonly CaregiverCapability[];
}

export interface CompletionPlan {
  readonly taskId: ReviewTaskId;
  readonly kind: ReviewTaskKind;
  readonly outcome: ReviewOutcome;
  readonly changes: readonly RecordChange[];
  /** `COMPLETED` for a resolution, `DISMISSED` for "does not apply" - both after a write. */
  readonly resultingState: ReviewTaskState;
  readonly completedAt: Instant;
}

/**
 * Decide whether a task may be closed, and with exactly what effect.
 *
 * The order of the checks is deliberate. Authorization first, because it is the cheapest refusal
 * and the one whose absence would be a security defect rather than a usability one. The
 * empty-change check comes before the field checks, because "you must change something" is the
 * exit criterion and deserves its own reason code rather than arriving as a confusing
 * consequence of an empty loop.
 */
export function evaluateCompletion(
  task: ReviewTask,
  request: CompletionRequest,
  authority: CompletionAuthority,
  now: Instant,
): Result<CompletionPlan, DomainError> {
  if (task.state !== 'OPEN') {
    return failure('VALIDATION_FAILED', 'This task is already closed.', {
      reason_code: 'task_not_open',
      state: task.state,
    });
  }

  const admitting = COMPLETION_CAPABILITIES[task.kind];
  if (!authority.isOwner && !admitting.some((c) => authority.capabilities.includes(c))) {
    return failure('PERMISSION_DENIED', 'You cannot complete this kind of task.');
  }

  if (request.changes.length === 0) {
    // Exit criterion 2. A task that could close without writing anything would make the inbox a
    // to-do list rather than a maintenance surface.
    return failure(
      'VALIDATION_FAILED',
      'Completing this task must change the record it is about.',
      {
        reason_code: 'completion_changes_nothing',
      },
    );
  }

  const allowed = COMPLETABLE_FIELDS[task.kind];
  for (const change of request.changes) {
    if (change.recordKind !== task.subjectKind || change.recordId !== task.subjectId) {
      return failure('VALIDATION_FAILED', 'That change is not about this task.', {
        reason_code: 'change_targets_other_record',
      });
    }
    if (!allowed.includes(change.field)) {
      return failure('VALIDATION_FAILED', 'That field is not part of this task.', {
        reason_code: 'field_not_completable',
        field: change.field,
      });
    }
  }

  return ok({
    taskId: task.id,
    kind: task.kind,
    outcome: request.outcome,
    changes: request.changes,
    resultingState: request.outcome === 'RESOLVED' ? 'COMPLETED' : 'DISMISSED',
    completedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const REVIEW_TASK_AUDIT_ACTIONS = [
  'review.task.completed',
  'review.task.dismissed',
] as const;
export type ReviewTaskAuditAction = (typeof REVIEW_TASK_AUDIT_ACTIONS)[number];

export function reviewTaskAuditAction(state: ReviewTaskState): ReviewTaskAuditAction {
  return state === 'COMPLETED' ? 'review.task.completed' : 'review.task.dismissed';
}

/**
 * Audit detail for a completion.
 *
 * Field *names* and counts, never field values. A corrected medicine strength is exactly the kind
 * of content `16` keeps out of the audit log, and knowing that `strength_text` changed is enough
 * to answer what the log exists to answer.
 */
export function reviewTaskAuditDetail(plan: {
  readonly kind: ReviewTaskKind;
  readonly outcome: ReviewOutcome;
  readonly changes: readonly RecordChange[];
}): Readonly<Record<string, string | number | boolean | null>> {
  return {
    task_kind: plan.kind,
    outcome: plan.outcome,
    change_count: plan.changes.length,
    fields: [...new Set(plan.changes.map((c) => c.field))].sort().join(','),
  };
}
