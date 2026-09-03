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

  it('offers both on a conflict, because the person decides', () => {
    // `13`'s per-entity policy exists so that one person's change is not silently overwritten by
    // another's. Offering only "remove" here would do exactly that, with an extra tap.
    const [row] = pendingQueueView([input({ state: 'CONFLICTED' })]).rows;
    expect(row?.kind).toBe('CONFLICTED');
    expect(row?.actions).toEqual(['RETRY', 'DISCARD']);
    expect(row?.needsDecision).toBe(true);
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
