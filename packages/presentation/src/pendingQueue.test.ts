/**
 * What a person is told about a change that has not been saved, and what they may do about it.
 *
 * `12` asks for a **resolvable** failure state. These tests are about the resolvable half: which
 * actions a row offers, and which it must not.
 */

import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_ATTEMPTS, type SyncEntityType } from '@kynviora/domain';
import {
  QUEUE_COPY,
  describeChange,
  pendingQueueView,
  summaryFor,
  type QueueInput,
} from './pendingQueue.js';

function input(overrides: Partial<QueueInput> = {}): QueueInput {
  return {
    operationId: '00000000-0000-4000-8000-000000000001',
    entityType: 'medicine_schedule',
    mutation: 'UPDATE',
    state: 'PENDING',
    attemptCount: 0,
    maxAttempts: MAX_UPLOAD_ATTEMPTS,
    ...overrides,
  };
}

describe('describeChange', () => {
  it('says what a person changed, not what table it is in', () => {
    expect(describeChange(input())).toBe('A change to when a medicine is taken');
    expect(describeChange(input({ mutation: 'CREATE', entityType: 'allergy_record' }))).toBe(
      'Adding an allergy or sensitivity',
    );
    expect(describeChange(input({ mutation: 'DELETE', entityType: 'owned_item' }))).toBe(
      'Removing a medicine or product',
    );
  });

  it('has words for every entity type the protocol has', () => {
    // The map is exhaustive by its type, and this is the test that says why that matters: a type
    // added without a sentence would otherwise reach somebody's screen as `field_assertion`.
    const types: readonly SyncEntityType[] = [
      'owned_item',
      'medicine_schedule',
      'dose_event',
      'allergy_record',
      'condition_record',
      'review_task',
      'profile',
      'caregiver_grant',
      'profile_assessment',
      'alert_publication',
      'field_assertion',
      'marketed_formulation',
    ];
    for (const entityType of types) {
      const described = describeChange(input({ entityType }));
      expect(described).not.toContain('_');
      expect(described.length).toBeGreaterThan('A change to '.length);
    }
  });
});

describe('what a row offers', () => {
  it('offers nothing on a change that is simply waiting', () => {
    // Not even "remove": a change about to be sent is not a question, and offering to discard it
    // invites somebody to throw away an edit that was seconds from being saved.
    const [row] = pendingQueueView([input({ state: 'PENDING' })]).rows;
    expect(row?.kind).toBe('WAITING');
    expect(row?.actions).toEqual([]);
    expect(row?.needsDecision).toBe(false);
  });

  it('offers nothing while a change is being sent', () => {
    const [row] = pendingQueueView([input({ state: 'IN_FLIGHT' })]).rows;
    expect(row?.kind).toBe('SENDING');
    expect(row?.actions).toEqual([]);
  });

  /**
   * This used to assert `['RETRY', 'DISCARD']`, on the reasoning that offering only "remove" would
   * discard somebody's change with an extra tap. The intent was right and the mechanism was not.
   *
   * `RETRY` does not preserve the change either. `PendingSyncProvider.retry` puts the operation
   * back as `PENDING` with the payload **unchanged**, and every conflict this build can produce is
   * a conditional write: `VERSION_CONFLICT` is answered by comparing the stored version against
   * the `expectedVersion` the payload carries, so the identical request gets the identical 409. It
   * delayed the loss rather than avoiding it - and because retry resets the attempt count, there
   * was no cap to end the loop (`DEV-092`).
   *
   * Rebasing onto whatever version stands now is not the answer either: that applies a change on
   * top of content the person has not seen, which for a medicine schedule is the overwrite `13`
   * resolves this type `ASK_USER` to prevent. So the change stays in the journal until the person
   * acts, the copy says the record moved and to make the change again where the record is, and the
   * only control offered is the one that does what it says.
   */
  it('never offers to retry a conflict, because the precondition is what was refused', () => {
    const [row] = pendingQueueView([input({ state: 'CONFLICTED' })]).rows;
    expect(row?.kind).toBe('CONFLICTED');
    expect(row?.actions).toEqual(['DISCARD']);
    // Still a decision. It is not resolved, and the badge must go on saying so.
    expect(row?.needsDecision).toBe(true);
    expect(row?.why).toBe(QUEUE_COPY.conflictHelp);
  });

  it('says a conflicted change was not saved, and where to make it again', () => {
    // `18`: the person has to know two things and the old copy said neither. Their change is not
    // on the server - "Kynviora will not choose between the two" left that open - and the way to
    // apply it is to make it again against what is there now.
    expect(QUEUE_COPY.conflictHelp).toContain('was not saved');
    expect(QUEUE_COPY.conflictHelp).toContain('again');
    // Never blame, never a code, never a correlation ID.
    expect(QUEUE_COPY.conflictHelp).not.toMatch(/error|failed|invalid/i);
  });

  /**
   * The rule the two arms above share, stated over the whole vocabulary rather than one member.
   *
   * `RETRY` may only be offered where the same bytes could produce a different answer. That is
   * true of a run of retries that gave up - a connection may have come back - and false of both
   * states where the server has already read the change and answered about its content.
   */
  it('offers a retry only where the identical request could succeed later', () => {
    for (const state of ['CONFLICTED', 'REJECTED'] as const) {
      const [row] = pendingQueueView([input({ state })]).rows;
      expect(row?.actions, `${state} offers a retry that cannot succeed`).not.toContain('RETRY');
    }
    const [gaveUp] = pendingQueueView([
      input({ state: 'FAILED_RETRYABLE', attemptCount: MAX_UPLOAD_ATTEMPTS }),
    ]).rows;
    expect(gaveUp?.actions).toContain('RETRY');
  });

  it('never offers to retry a rejection', () => {
    // The server has read the change and will not take it as written. A "try again" here produces
    // the same refusal and teaches a person that the buttons on this screen do nothing.
    const [row] = pendingQueueView([input({ state: 'REJECTED' })]).rows;
    expect(row?.kind).toBe('REJECTED');
    expect(row?.actions).toEqual(['DISCARD']);
    expect(row?.why).toBe(QUEUE_COPY.rejectedHelp);
  });

  it('offers to retry one that gave up, because a connection may have come back', () => {
    const [row] = pendingQueueView([
      input({ state: 'FAILED_RETRYABLE', attemptCount: MAX_UPLOAD_ATTEMPTS }),
    ]).rows;
    expect(row?.kind).toBe('GAVE_UP');
    expect(row?.actions).toEqual(['RETRY', 'DISCARD']);
  });

  it('treats a retryable failure below the cap as waiting, not as a failure', () => {
    // `18`: a queued edit is not something the person did wrong, and it is still being retried on
    // its own. Calling it failed would ask them to act on something already in hand.
    const [row] = pendingQueueView([input({ state: 'FAILED_RETRYABLE', attemptCount: 1 })]).rows;
    expect(row?.kind).toBe('WAITING');
    expect(row?.needsDecision).toBe(false);
  });
});

describe('the summary', () => {
  it('says nothing is outstanding when nothing is', () => {
    expect(pendingQueueView([]).summary).toBe(QUEUE_COPY.empty);
  });

  it('leads with the count the person has to act on', () => {
    expect(summaryFor(3, 1)).toMatch(/^1 change needs you to decide\./);
  });

  it('reads as English for one and for many', () => {
    expect(summaryFor(1, 0)).toBe('1 change is waiting to be sent.');
    expect(summaryFor(2, 0)).toBe('2 changes are waiting to be sent.');
    expect(summaryFor(0, 1)).toBe('1 change needs you to decide.');
    expect(summaryFor(0, 2)).toBe('2 changes need you to decide.');
  });

  it('counts a decision separately from a wait', () => {
    const view = pendingQueueView([
      input({ operationId: 'a', state: 'PENDING' }),
      input({ operationId: 'b', state: 'CONFLICTED' }),
      input({ operationId: 'c', state: 'REJECTED' }),
    ]);
    expect(view.waiting).toBe(1);
    expect(view.needsAttention).toBe(2);
  });
});

describe('the order of the list', () => {
  it('is the order things were queued, not by severity', () => {
    // A person opening this screen is looking for the change they made. Hoisting by severity moves
    // it somewhere they did not put it.
    const view = pendingQueueView([
      input({ operationId: 'a', state: 'PENDING' }),
      input({ operationId: 'b', state: 'CONFLICTED' }),
      input({ operationId: 'c', state: 'PENDING' }),
    ]);
    expect(view.rows.map((row) => row.operationId)).toEqual(['a', 'b', 'c']);
  });
});

describe('the copy', () => {
  it('promises that nothing was lost, before the list', () => {
    expect(QUEUE_COPY.intro).toMatch(/kept on this phone/i);
  });

  it('says what removing a change costs, on the control rather than in a dialog', () => {
    expect(QUEUE_COPY.discardWarning).toMatch(/gone/i);
    expect(QUEUE_COPY.discardWarning).toMatch(/nothing on the server changes/i);
  });

  it('never blames the person', () => {
    const everything = Object.values(QUEUE_COPY).join(' ');
    expect(everything).not.toMatch(/\byou failed\b|\byour fault\b|\berror\b/i);
  });
});
