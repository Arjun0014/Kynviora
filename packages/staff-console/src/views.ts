/**
 * What the console shows, decided once and rendered somewhere else.
 *
 * Spec references: `04` Phase 6.6 (reviewer queue, source/evidence/legal-scope view, publish /
 * reject / return-for-correction, rule preview), `10` (separation of duties, the high-severity
 * checklist, governance audit artifacts), `20` (observability without a verdict), `DEV-016`,
 * `DEV-017`, DEC-031, DEC-032, DEC-036, DEC-059, DEC-060.
 *
 * THE QUEUE IS NOT RANKED, AND THAT IS A SECURITY PROPERTY HERE
 * `02` forbids alarm-optimised design on the household side. On this side the argument is
 * different and stronger: a publication request carries `maxUrgency` **stated by the requester**.
 * Sorting the reviewer's queue by it would let whoever opens a request decide how soon it is
 * looked at, by claiming an urgency. The queue is therefore in the order the API returned it -
 * oldest first, which is what `20` measures as queue age - and this module exports no function
 * that compares two requests. A test asserts that.
 *
 * THE TALLY IS PER JURISDICTION, NEVER SUMMED
 * `0012` requires each requested jurisdiction to reach the approval count on its own: approving
 * for GB does not publish for NI. A single "2 of 2" on the screen would hide a scope nobody
 * reviewed, so every view here carries the per-jurisdiction rows and the shortfall is stated as a
 * list of jurisdictions rather than as a number.
 *
 * THE CHECKLIST IS NEVER PRE-TICKED AND NEVER OFFERED IN BULK
 * `10` makes the second reviewer's value that they check independently. A pre-ticked box, a
 * "confirm all" control or a remembered previous answer each turn ten judgements into one click.
 * {@link checklistView} returns every item unconfirmed, always, and there is no parameter that
 * changes that.
 */

import {
  APPROVING_ROLES,
  JURISDICTIONS,
  PUBLICATION_CHECKLIST,
  PUBLISHABLE_KINDS,
  REVIEWER_ROLES,
  type ApprovalDecision,
  type ChecklistItem,
  type Instant,
  type Jurisdiction,
  type PublicationAction,
  type PublishableKind,
  type ReviewerRole,
} from '@kynviora/domain';
import type {
  ApprovalResponse,
  JurisdictionTallyResponse,
  MetricReadingResponse,
  OperationsResponse,
  QueueItemResponse,
  QueueResponse,
  RequestDetailResponse,
  ShadowRunResponse,
  SourceHealthResponse,
} from './client.js';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** One jurisdiction's standing, as a line a reviewer reads. */
export interface TallyLine {
  readonly jurisdiction: string;
  readonly approvals: number;
  readonly required: number;
  /** Whether this jurisdiction alone has enough distinct approvers. */
  readonly satisfied: boolean;
  /** "1 of 2 approvals for GB". Written out, because "1/2" beside "GB" reads as a date. */
  readonly text: string;
}

export function tallyLines(
  tally: readonly JurisdictionTallyResponse[],
  required: number,
): readonly TallyLine[] {
  return tally.map((row) => ({
    jurisdiction: row.jurisdiction,
    approvals: row.approvals,
    required,
    satisfied: row.approvals >= required,
    text: `${String(row.approvals)} of ${String(required)} approvals for ${row.jurisdiction}`,
  }));
}

/**
 * How long something has been waiting, in words.
 *
 * Whole units only, and never rounded up: "3 hours" for anything from three to four. A queue age
 * that rounds up reports work as older than it is, and `20` measures this number.
 */
export function ageText(from: string, now: Instant): string {
  const ms = Date.parse(now) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour' : `${String(hours)} hours`;

  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${String(days)} days`;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface QueueRowView {
  readonly requestId: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly action: string;
  /** The requester's claimed ceiling, shown as a fact about the request and never used to sort. */
  readonly maxUrgency: string | null;
  readonly evidenceLevel: string | null;
  readonly requiredApprovals: number;
  readonly waitingFor: string;
  readonly tally: readonly TallyLine[];
  /** Jurisdictions still short of the count. Named, because a number would not say which. */
  readonly shortOf: readonly string[];
  /**
   * Whether this caller may record a decision.
   *
   * Copied from the API rather than derived. `10`'s separation of duties is the API's decision
   * and a console that recomputed it would eventually disagree with the database - offering a
   * control that fails, or hiding one that would have worked.
   */
  readonly youMayApprove: boolean;
  /** Why the decision controls are absent, when they are. Absent, not disabled (DEC-045). */
  readonly mayNotApproveBecause: string | null;
}

export interface QueueView {
  readonly rows: readonly QueueRowView[];
  /** What an empty queue means here, which is not "everything is approved". */
  readonly emptyMessage: string;
  readonly at: Instant;
}

export function queueView(response: QueueResponse, now: Instant): QueueView {
  return {
    // `response.items` order is preserved exactly. See the module note: re-sorting this list by
    // anything the requester supplied would hand them control of the review order.
    rows: response.items.map((item) => queueRowView(item, now)),
    emptyMessage:
      'Nothing is waiting for a decision. That is not a statement that anything has been ' +
      'published: no shipped record passes the Citation Gate (BLK-004).',
    at: now,
  };
}

function queueRowView(item: QueueItemResponse, now: Instant): QueueRowView {
  const lines = tallyLines(item.tally, item.requiredApprovals);
  return {
    requestId: item.requestId,
    subjectKind: item.subjectKind,
    subjectId: item.subjectId,
    action: item.action,
    maxUrgency: item.maxUrgency,
    evidenceLevel: item.evidenceLevel,
    requiredApprovals: item.requiredApprovals,
    waitingFor: ageText(item.requestedAt, now),
    tally: lines,
    shortOf: lines.filter((line) => !line.satisfied).map((line) => line.jurisdiction),
    youMayApprove: item.youMayApprove,
    mayNotApproveBecause: item.youMayApprove
      ? null
      : 'You opened this request. Spec 10 keeps authoring and approving separate, so somebody ' +
        'else records the decision.',
  };
}

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

/** A description a reviewer can act on, per `10`'s ten-item high-severity checklist. */
const CHECKLIST_TEXT: Readonly<Record<ChecklistItem, string>> = Object.freeze({
  SOURCE_AUTHENTICITY: 'I retrieved the source document myself and it is the official one.',
  EXACT_JURISDICTION: 'The jurisdiction and legal scope match what the source actually covers.',
  AFFECTED_IDENTIFIERS: 'I checked which products, formulations and batches this reaches.',
  RULE_MATCHING_BEHAVIOUR: 'I looked at how the rule matches, not only at what it says.',
  USER_ACTION_WORDING:
    'The action wording is something a household can act on without a clinician.',
  MEDICATION_BOUNDARY: 'This does not tell anybody to start, stop or change a medicine.',
  EXPECTED_MATCH_VOLUME: 'I checked the shadow run, not an estimate, for how many this reaches.',
  NOTIFICATION_POLICY:
    'The notification this produces is right for its urgency and discloses no more than it must.',
  WITHDRAWAL_READINESS: 'I know how this is withdrawn and who does it.',
  INCIDENT_OWNER: 'Somebody is named as responsible if this turns out to be wrong.',
});

export interface ChecklistItemView {
  readonly item: ChecklistItem;
  readonly text: string;
  /**
   * Always `false`.
   *
   * A field rather than an omission so the type says what the rule is. `10`'s second reviewer is
   * worth something because they check independently, and a remembered tick is the first
   * reviewer's answer wearing the second one's name.
   */
  readonly confirmed: false;
}

export interface ChecklistView {
  readonly required: boolean;
  readonly items: readonly ChecklistItemView[];
  readonly note: string;
}

/**
 * The checklist for one request.
 *
 * Whether it is required follows `checklistRequired` exactly - publish, and two approvals - but
 * it is decided from the request's own `requiredApprovals`, which the API already computed from
 * the declared impact. Recomputing it here from the urgency and evidence level would be a second
 * implementation of a governance rule, and the two would eventually disagree about a request
 * nobody was watching.
 */
export function checklistView(action: PublicationAction, highImpact: boolean): ChecklistView {
  const required = action === 'PUBLISH' && highImpact;
  return {
    required,
    items: PUBLICATION_CHECKLIST.map((item) => ({
      item,
      text: CHECKLIST_TEXT[item],
      confirmed: false,
    })),
    note: required
      ? 'Every item is unticked and there is no control that ticks them together. Spec 10 asks ' +
        'the second reviewer to check independently.'
      : 'This request does not require the high-severity checklist. Recording items anyway is ' +
        'allowed and is kept with the approval.',
  };
}

// ---------------------------------------------------------------------------
// The request detail
// ---------------------------------------------------------------------------

export interface ApprovalLineView {
  readonly approvalId: string;
  readonly reviewerUserId: string;
  readonly role: string;
  readonly decision: string;
  readonly jurisdictions: readonly string[];
  readonly note: string | null;
  readonly decidedAt: string;
}

/**
 * What a shadow run says, joined into the request that names it.
 *
 * `DEV-017` closed with a presentational remainder: the request detail returns a `shadowRunId`
 * and a reviewer confirming `EXPECTED_MATCH_VOLUME` had to fetch the run separately. This is that
 * join. The counts are the run's own and nothing here recomputes them.
 */
export interface ShadowRunView {
  readonly shadowRunId: string;
  readonly datasetKind: string;
  readonly datasetLabel: string | null;
  readonly ranAt: string;
  readonly lines: readonly { readonly label: string; readonly value: string }[];
  readonly reasonCounts: readonly { readonly reason: string; readonly count: number }[];
  readonly sampleCount: number;
  /** What the samples deliberately do not contain. */
  readonly sampleNote: string;
}

export function shadowRunView(run: ShadowRunResponse): ShadowRunView {
  return {
    shadowRunId: run.shadowRunId,
    datasetKind: run.datasetKind,
    datasetLabel: run.datasetLabel,
    ranAt: run.runAt,
    lines: [
      { label: 'Items evaluated', value: String(run.datasetSize) },
      { label: 'Items matched', value: String(run.matchedItems) },
      { label: 'Products affected', value: String(run.affectedProducts) },
      { label: 'Formulations affected', value: String(run.affectedFormulations) },
      // The figure `EXPECTED_MATCH_VOLUME` is about. Named as the checklist names it, so a
      // reviewer is not matching two vocabularies in their head.
      { label: 'People this would reach', value: String(run.potentialUserMatches) },
    ],
    reasonCounts: Object.entries(run.reasonCounts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
    sampleCount: run.samples.length,
    sampleNote:
      'Samples name an item and the reasons it matched. They carry no person, and the run was ' +
      'written to shadow_run rather than to profile_assessment, so nothing here notified anybody ' +
      '(DEC-034).',
  };
}

export interface RequestDetailView {
  readonly requestId: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly action: string;
  readonly state: string;
  readonly requestedByUserId: string;
  readonly requestedAt: string;
  readonly waitingFor: string;
  readonly maxUrgency: string | null;
  readonly evidenceLevel: string | null;
  readonly withdrawalReason: string | null;
  readonly requiredApprovals: number;
  readonly tally: readonly TallyLine[];
  readonly shortOf: readonly string[];
  readonly approvals: readonly ApprovalLineView[];
  /** Roles that may judge this kind of content, per `10`'s clinical / regulatory split. */
  readonly rolesThatMayApprove: readonly ReviewerRole[];
  readonly checklist: ChecklistView;
  /** The joined shadow run, or why there is none to show. */
  readonly shadowRun: ShadowRunView | null;
  readonly shadowRunNote: string;
  /** Whether the console offers the execute control at all. */
  readonly mayExecute: boolean;
  readonly mayExecuteBecause: string;
}

export interface RequestDetailInput {
  readonly detail: RequestDetailResponse;
  readonly shadowRun: ShadowRunResponse | null;
  /** This console's own user, so the requester-is-not-the-executor rule can be shown, not guessed. */
  readonly viewerUserId: string;
  readonly now: Instant;
}

export function requestDetailView(input: RequestDetailInput): RequestDetailView {
  const { detail } = input;
  const lines = tallyLines(detail.tally, detail.requiredApprovals);
  const shortOf = lines.filter((line) => !line.satisfied).map((line) => line.jurisdiction);

  const highImpact = detail.requiredApprovals >= 2;
  const isRequester = detail.requestedByUserId === input.viewerUserId;
  const open = detail.state === 'OPEN';

  // Publication is refused to the requester; withdrawal is not. DEC-031: a wrongly-published
  // alert tells somebody to act, a wrongly-withdrawn one only removes information, so withdrawal
  // is deliberately the cheaper of the two. The console must not "fix" the asymmetry by hiding
  // the control.
  const executorBarred = isRequester && detail.action === 'PUBLISH';

  let mayExecuteBecause: string;
  if (!open) {
    mayExecuteBecause = `This request is ${detail.state.toLowerCase().replace(/_/g, ' ')}.`;
  } else if (executorBarred) {
    mayExecuteBecause =
      'You opened this request. Spec 10 keeps authoring and publishing separate, so somebody ' +
      'else executes it. Withdrawal is different and you could execute one.';
  } else if (shortOf.length > 0) {
    mayExecuteBecause =
      `Still short of the approval count for ${shortOf.join(', ')}. Every ` +
      'requested jurisdiction reaches the count on its own; approving for one does not publish ' +
      'for another.';
  } else {
    mayExecuteBecause =
      'Every requested jurisdiction has the approvals it needs. Executing asks you to confirm ' +
      'your identity again.';
  }

  return {
    requestId: detail.requestId,
    subjectKind: detail.subjectKind,
    subjectId: detail.subjectId,
    action: detail.action,
    state: detail.state,
    requestedByUserId: detail.requestedByUserId,
    requestedAt: detail.requestedAt,
    waitingFor: ageText(detail.requestedAt, input.now),
    maxUrgency: detail.maxUrgency,
    evidenceLevel: detail.evidenceLevel,
    withdrawalReason: detail.withdrawalReason,
    requiredApprovals: detail.requiredApprovals,
    tally: lines,
    shortOf,
    approvals: detail.approvals.map((approval) => approvalLineView(approval)),
    rolesThatMayApprove: rolesThatMayApprove(detail.subjectKind),
    checklist: checklistView(asAction(detail.action), highImpact),
    shadowRun: input.shadowRun === null ? null : shadowRunView(input.shadowRun),
    shadowRunNote: shadowRunNote(detail, input.shadowRun),
    mayExecute: open && !executorBarred && shortOf.length === 0,
    mayExecuteBecause,
  };
}

function approvalLineView(approval: ApprovalResponse): ApprovalLineView {
  return {
    approvalId: approval.approvalId,
    reviewerUserId: approval.reviewerUserId,
    role: approval.role,
    decision: approval.decision,
    jurisdictions: approval.jurisdictions,
    note: approval.note,
    decidedAt: approval.decidedAt,
  };
}

/**
 * An action from the wire, narrowed.
 *
 * An unrecognised value is treated as `PUBLISH`, which is the stricter of the two: it is the one
 * that requires the checklist. Guessing `WITHDRAW` would hide ten questions.
 */
function asAction(value: string): PublicationAction {
  return value === 'WITHDRAW' ? 'WITHDRAW' : 'PUBLISH';
}

/**
 * Which roles may approve this kind of content.
 *
 * `10` keeps regulatory interpretation separate from clinical safety, and a console that listed
 * every role would invite two people neither of whom is qualified to judge the thing in front of
 * them. An unrecognised kind lists nothing rather than everything.
 */
function rolesThatMayApprove(subjectKind: string): readonly ReviewerRole[] {
  const known = PUBLISHABLE_KINDS.find((kind): kind is PublishableKind => kind === subjectKind);
  if (known === undefined) return [];
  return APPROVING_ROLES[known];
}

function shadowRunNote(detail: RequestDetailResponse, run: ShadowRunResponse | null): string {
  if (run !== null) return 'The run this request names, fetched and shown here (DEV-017).';
  if (detail.shadowRunId === null) {
    return detail.requiredApprovals >= 2 && detail.subjectKind === 'assessment_rule_version'
      ? 'This request names no shadow run. Migration 0013 requires one for a two-person safety ' +
          'rule publication, so a request in this state cannot be executed.'
      : 'No shadow run is required for this request.';
  }
  return (
    'This request names a shadow run that could not be loaded. Do not confirm the expected ' +
    'match volume from memory.'
  );
}

// ---------------------------------------------------------------------------
// The decision form
// ---------------------------------------------------------------------------

export interface DecisionFormView {
  /** Approve, reject, return for correction - in that order, with none preselected. */
  readonly decisions: readonly { readonly value: ApprovalDecision; readonly text: string }[];
  readonly roles: readonly ReviewerRole[];
  readonly jurisdictions: readonly Jurisdiction[];
  readonly checklist: ChecklistView;
  readonly note: string;
}

const DECISION_TEXT: Readonly<Record<ApprovalDecision, string>> = Object.freeze({
  APPROVE: 'Approve, for the jurisdictions I select',
  REJECT: 'Reject',
  RETURN_FOR_CORRECTION: 'Return for correction',
});

/**
 * The decision controls.
 *
 * Nothing is preselected and no option carries a `recommended` or `default` field. The same rule
 * the reconciliation screen keeps for a household (DEC-030) applies here for a different reason:
 * a console that defaulted to Approve would collect approvals from people who pressed the button
 * that was already pressed.
 */
export function decisionFormView(detail: RequestDetailResponse): DecisionFormView {
  const highImpact = detail.requiredApprovals >= 2;
  return {
    decisions: (['APPROVE', 'REJECT', 'RETURN_FOR_CORRECTION'] as const).map((value) => ({
      value,
      text: DECISION_TEXT[value],
    })),
    // Only the roles that may judge this kind, and only ones this build defines.
    roles: rolesThatMayApprove(detail.subjectKind),
    jurisdictions: detail.jurisdictions.filter((value): value is Jurisdiction =>
      (JURISDICTIONS as readonly string[]).includes(value),
    ),
    checklist: checklistView(asAction(detail.action), highImpact),
    note:
      'Select the jurisdictions this decision covers. Approving for one does not approve for ' +
      'another, and the database counts each separately.',
  };
}

/** Every reviewer role this build defines. Exported so a test can assert the console shows a subset. */
export const ALL_REVIEWER_ROLES: readonly ReviewerRole[] = REVIEWER_ROLES;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface MetricRowView {
  readonly key: string;
  readonly value: string;
  readonly unit: string;
}

export interface SourceRowView {
  readonly sourceId: string;
  readonly organization: string;
  readonly sourceName: string;
  readonly jurisdiction: string | null;
  readonly status: string;
  readonly operationalOwner: string | null;
  readonly lastSuccessfulCheckAt: string | null;
  readonly consecutiveFailureCount: number;
  /** Facts, each stated separately, and none of them a health verdict. */
  readonly notes: readonly string[];
}

export interface OperationsView {
  readonly at: string;
  readonly metrics: readonly MetricRowView[];
  readonly sources: readonly SourceRowView[];
  /** Why there is no overall status on this page. */
  readonly noVerdictNote: string;
}

function metricValueText(reading: MetricReadingResponse): string {
  if (reading.unit === 'BOOLEAN') return reading.value === 0 ? 'no' : 'yes';
  if (reading.unit === 'MILLISECONDS') {
    const minutes = Math.floor(reading.value / 60_000);
    if (reading.value === 0) return 'nothing waiting';
    if (minutes < 60) return minutes <= 1 ? '1 minute' : `${String(minutes)} minutes`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours === 1 ? '1 hour' : `${String(hours)} hours`;
    const days = Math.floor(hours / 24);
    return days === 1 ? '1 day' : `${String(days)} days`;
  }
  return String(reading.value);
}

function sourceNotes(source: SourceHealthResponse): readonly string[] {
  const notes: string[] = [];
  if (source.neverSucceeded) notes.push('Never successfully checked.');
  if (source.overdueByMs !== null) {
    // The one comparison this page makes, and it is arithmetic rather than a judgement: the
    // source declared its own cadence and the clock has passed it (DEC-060).
    notes.push(`Past its own declared refresh interval by ${msText(source.overdueByMs)}.`);
  }
  if (source.unowned) notes.push('No operational owner is named.');
  if (source.consecutiveFailureCount > 0) {
    notes.push(`${String(source.consecutiveFailureCount)} consecutive failed checks.`);
  }
  return notes;
}

function msText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return minutes <= 1 ? '1 minute' : `${String(minutes)} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour' : `${String(hours)} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${String(days)} days`;
}

/**
 * The operational snapshot as a page.
 *
 * No status, no severity, no health score, no threshold breach - the projection has nowhere to
 * put them and this view adds none (DEC-060). `20` requires exact thresholds to be documented
 * before production and `BLK-008` records that none are; a "degraded" here would be an invented
 * answer somebody would act on.
 */
export function operationsView(response: OperationsResponse): OperationsView {
  return {
    at: response.at,
    metrics: response.metrics.map((reading) => ({
      key: reading.key,
      value: metricValueText(reading),
      unit: reading.unit,
    })),
    sources: response.sources.map((source) => ({
      sourceId: source.sourceId,
      organization: source.organization,
      sourceName: source.sourceName,
      jurisdiction: source.jurisdiction,
      status: source.status,
      operationalOwner: source.operationalOwner,
      lastSuccessfulCheckAt: source.lastSuccessfulCheckAt,
      consecutiveFailureCount: source.consecutiveFailureCount,
      notes: sourceNotes(source),
    })),
    noVerdictNote:
      'There is no overall status on this page. Spec 20 requires the thresholds to be set and ' +
      'documented before production, and none are (BLK-008). A "healthy" here would be invented.',
  };
}
