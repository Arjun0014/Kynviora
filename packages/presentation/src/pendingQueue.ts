/**
 * What a person is told about changes that have not reached the server, and what they may do.
 *
 * Spec references: `12` ("Repository behavior" - a pending-operation journal and a **resolvable**
 * failure state), `13` (per-entity conflict policy; bounded retry), `03` group J, `18` (say what
 * is happening in the words a person uses; never blame them), `06` (a screen state is a state,
 * not an empty list), `DEV-038`, `DEV-044`.
 *
 * WHY THIS EXISTS AT ALL
 * `12` asks for two things and the app had one of them. A change made with no signal is kept and
 * sent later - that works and is measured on a device. What was missing is the half in the same
 * sentence: a person being able to **see** it, and to act on one that came back as a conflict.
 * Until now `needsUserAttention` counted them and nothing showed them, so a schedule edit that the
 * server refused was held safely and invisibly, which from the outside is indistinguishable from an
 * edit that was saved.
 *
 * THE DECISION THIS FILE OWNS
 * Which of three sentences an operation gets, and which actions it may offer. Both are wrong in
 * ways nobody could see from `apps/**`, which is outside the test run and the lint run (trap 164,
 * `DEV-043`):
 *
 *   - **Offering "try again" on something that cannot succeed** teaches a person that the button
 *     does nothing. A rejection is an edit the server will not accept as written; retrying it is
 *     the same refusal at a later time.
 *   - **Offering only "discard" on a conflict** throws away somebody's change because somebody
 *     else got there first, which is the outcome `13`'s per-entity policy exists to avoid.
 *   - **Saying "failed"** about a change that is simply waiting for a connection. `18` forbids
 *     making a person feel they have done something wrong, and a queued edit is not an error.
 */

import type { OperationState, SyncEntityType } from '@kynviora/domain';

/** What the person is being asked to do about one change, if anything. */
export const QUEUE_ROW_KINDS = [
  /** Waiting for a connection. Nothing to do. */
  'WAITING',
  /** Being sent now. */
  'SENDING',
  /** The record moved underneath this change. A person chooses (`13`). */
  'CONFLICTED',
  /** The server will not accept it as written. Retrying is the same answer later. */
  'REJECTED',
  /** It has stopped trying on its own. */
  'GAVE_UP',
] as const;
export type QueueRowKind = (typeof QUEUE_ROW_KINDS)[number];

/** What a row may offer. `RETRY` is never offered where it could only fail again. */
export const QUEUE_ACTIONS = ['RETRY', 'DISCARD'] as const;
export type QueueAction = (typeof QUEUE_ACTIONS)[number];

export interface QueueRow {
  readonly operationId: string;
  readonly kind: QueueRowKind;
  /** What the change was, in the words a person would use. */
  readonly what: string;
  /** Why it is here. Never blame, never a code, never a correlation ID (`18`, `14`). */
  readonly why: string;
  readonly actions: readonly QueueAction[];
  /** Whether this row is one the person has to decide about. */
  readonly needsDecision: boolean;
}

export interface PendingQueueView {
  readonly rows: readonly QueueRow[];
  /** The one sentence at the top. */
  readonly summary: string;
  /** How many are waiting on a connection rather than on the person. */
  readonly waiting: number;
  /** How many need a decision. */
  readonly needsAttention: number;
}

/**
 * What each entity type is called on this screen.
 *
 * A person's words, not the schema's. "medicine_schedule" is a table; "when a medicine is taken" is
 * what they changed. Every member is listed so a type added later is a compile error here rather
 * than a row reading "owned_item" on somebody's screen.
 */
const ENTITY_WORDS: Readonly<Record<SyncEntityType, string>> = {
  owned_item: 'a medicine or product',
  medicine_schedule: 'when a medicine is taken',
  dose_event: 'a dose you recorded',
  allergy_record: 'an allergy or sensitivity',
  condition_record: 'a health condition',
  review_task: 'something to check',
  profile: 'a person in this household',
  caregiver_grant: 'who can see this profile',
  profile_assessment: 'a safety check',
  alert_publication: 'a safety update',
  field_assertion: 'a product detail',
  marketed_formulation: 'a product record',
};

export const QUEUE_COPY = Object.freeze({
  heading: 'Changes waiting to be saved',
  /**
   * Said before the list, because the thing a person most needs to know is that nothing was lost.
   * `12` requires that a change is never discarded silently, and this is where that promise is
   * made to the person rather than to the code.
   */
  intro:
    'These are changes you made while Kynviora could not reach the internet. They are kept on this phone and sent when it can.',
  empty: 'Everything you have changed has been saved.',
  /** `18`: what a person can do about it, before they wonder. */
  conflictHelp:
    'Somebody else changed this after you did, so your change was not saved. Kynviora will not put it on top of a version nobody has looked at. Open the record and make the change again against what is there now.',
  rejectedHelp:
    'Kynviora could not save this as it was written. Trying again would give the same answer, so the only thing to do is remove it and make the change again.',
  gaveUpHelp: 'Kynviora stopped trying after several attempts. You can try again now.',
  retryLabel: 'Try again',
  discardLabel: 'Remove this change',
  /**
   * Said on the discard control rather than in a dialog nobody reads. Removing a queued change is
   * the one action on this screen that loses something, and it is not undoable.
   */
  discardWarning: 'What you typed will be gone. Nothing on the server changes.',
});

/** One journal row, reduced to what this screen needs. */
export interface QueueInput {
  readonly operationId: string;
  readonly entityType: SyncEntityType;
  readonly mutation: 'CREATE' | 'UPDATE' | 'DELETE';
  readonly state: OperationState;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

function kindOf(input: QueueInput): QueueRowKind {
  switch (input.state) {
    case 'CONFLICTED':
      return 'CONFLICTED';
    case 'REJECTED':
      return 'REJECTED';
    case 'IN_FLIGHT':
      return 'SENDING';
    case 'FAILED_RETRYABLE':
      return input.attemptCount >= input.maxAttempts ? 'GAVE_UP' : 'WAITING';
    case 'PENDING':
    case 'COMMITTED':
      return 'WAITING';
  }
}

/**
 * What a row may offer, given what happened to it.
 *
 * The asymmetry is the point, and it used to be drawn in the wrong place. An **exhausted retry**
 * can be sent again, because what stopped it may have gone - a connection, a burst of load. A
 * **rejection** cannot: the server has already read the change and will not take it, so a "try
 * again" there is a button that produces the same refusal and teaches a person to distrust every
 * other one.
 *
 * A **conflict** was on the first side of that line and belongs on the second. Every conflict this
 * build produces is a conditional write whose precondition the server has just refused, and
 * re-sending it unchanged asks the same question and gets the same answer - for ever, because
 * unlike a rejection there is no attempt cap to stop it (`DEV-092`).
 */
function actionsFor(kind: QueueRowKind): readonly QueueAction[] {
  switch (kind) {
    // No `RETRY`, and it used to have one. Every conflict this build can produce is a **conditional
    // write** - `VERSION_CONFLICT` is answered by comparing the stored version against the
    // `expectedVersion` the operation carries - and retrying re-sends that same number, so the
    // answer is the same 409 for ever. Worse than the rejection case below, because retrying a
    // conflict resets the attempt budget: there is no cap to end it, and the row sits under "needs
    // you to decide" while the only control that looks like a decision does nothing (`DEV-092`).
    //
    // Rebasing onto whatever version now stands is not the fix. That applies somebody's change on
    // top of content they have not seen, which for a medicine schedule is the silent overwrite
    // `13` resolves this type `ASK_USER` to prevent. The resolution is a person looking at the
    // record - so the copy says that, and the only action here is the one that costs nothing to
    // offer.
    case 'CONFLICTED':
      return ['DISCARD'];
    case 'GAVE_UP':
      return ['RETRY', 'DISCARD'];
    case 'REJECTED':
      return ['DISCARD'];
    case 'WAITING':
    case 'SENDING':
      // Nothing to decide. A change that is simply waiting is not a question, and offering to
      // discard it invites somebody to throw away an edit that was about to be saved.
      return [];
  }
}

function whyOf(kind: QueueRowKind): string {
  switch (kind) {
    case 'CONFLICTED':
      return QUEUE_COPY.conflictHelp;
    case 'REJECTED':
      return QUEUE_COPY.rejectedHelp;
    case 'GAVE_UP':
      return QUEUE_COPY.gaveUpHelp;
    case 'SENDING':
      return 'Being sent now.';
    case 'WAITING':
      return 'Waiting until Kynviora can reach the internet.';
  }
}

/** What the change was, as a sentence rather than a table name. */
export function describeChange(input: QueueInput): string {
  const thing = ENTITY_WORDS[input.entityType];
  switch (input.mutation) {
    case 'CREATE':
      return `Adding ${thing}`;
    case 'UPDATE':
      return `A change to ${thing}`;
    case 'DELETE':
      return `Removing ${thing}`;
  }
}

/**
 * Build the screen.
 *
 * Order is the order things were queued, which is the order they will be sent (`uploadOrder`), so
 * the list reads the way the queue behaves. Rows needing a decision are **not** hoisted to the top:
 * a person looking at this screen is looking for their own change, and reordering by severity would
 * move it somewhere they did not put it.
 */
export function pendingQueueView(inputs: readonly QueueInput[]): PendingQueueView {
  const rows = inputs.map((input): QueueRow => {
    const kind = kindOf(input);
    return {
      operationId: input.operationId,
      kind,
      what: describeChange(input),
      why: whyOf(kind),
      actions: actionsFor(kind),
      needsDecision: kind === 'CONFLICTED' || kind === 'REJECTED' || kind === 'GAVE_UP',
    };
  });

  const needsAttention = rows.filter((row) => row.needsDecision).length;
  const waiting = rows.length - needsAttention;

  return { rows, summary: summaryFor(waiting, needsAttention), waiting, needsAttention };
}

/**
 * The sentence at the top.
 *
 * The count that needs a person comes first when there is one, because it is the only part of this
 * screen that is asking them for anything. `18`: a number a person cannot act on is noise.
 */
export function summaryFor(waiting: number, needsAttention: number): string {
  if (needsAttention > 0 && waiting > 0) {
    return `${String(needsAttention)} ${needsAttention === 1 ? 'change needs' : 'changes need'} you to decide. ${String(waiting)} ${waiting === 1 ? 'is' : 'are'} waiting to be sent.`;
  }
  if (needsAttention > 0) {
    return `${String(needsAttention)} ${needsAttention === 1 ? 'change needs' : 'changes need'} you to decide.`;
  }
  if (waiting > 0) {
    return `${String(waiting)} ${waiting === 1 ? 'change is' : 'changes are'} waiting to be sent.`;
  }
  return QUEUE_COPY.empty;
}
