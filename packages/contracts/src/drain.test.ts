import { describe, it, expect } from 'vitest';
import {
  MAX_UPLOAD_ATTEMPTS,
  instantFrom,
  isUploadable,
  needsUserAttention,
  unsafeId,
  type OperationId,
  type PendingOperation,
} from '@kynviora/domain';
import { drainPendingOperations } from './drain.js';
import type { ApiOutcome } from './outcome.js';

/**
 * Sending the queue, and knowing when to stop (`12`, `13`, `DEV-038`).
 *
 * The loop is not what these test. What they test is the one decision the loop owns: which
 * failures are about a single edit and which are about the whole queue, because getting that
 * wrong spends five people's attempt budget on one dropped tunnel.
 */

const at = (minute: number) =>
  instantFrom(`2026-09-03T10:${String(minute).padStart(2, '0')}:00.000Z`);

function operation(id: string, minute: number): PendingOperation {
  return {
    operationId: unsafeId<OperationId>(`00000000-0000-4000-8000-0000000000${id}`),
    entityType: 'medicine_schedule',
    entityId: '00000000-0000-4000-8000-0000000000b1',
    mutation: 'UPDATE',
    payload: { timesLocal: ['08:00'] },
    baseVersion: 2,
    createdAt: at(minute),
    state: 'PENDING',
    attemptCount: 0,
    lastError: null,
  };
}

const ok: ApiOutcome<unknown> = { kind: 'OK', value: {}, correlationId: null };
const offline: ApiOutcome<unknown> = { kind: 'OFFLINE' };
const serverError: ApiOutcome<unknown> = {
  kind: 'SERVER_ERROR',
  retryable: true,
  correlationId: 'c',
};
const lost: ApiOutcome<unknown> = { kind: 'AUTHORIZATION_LOST' };
const refused: ApiOutcome<unknown> = {
  kind: 'REFUSED',
  code: 'VALIDATION_FAILED',
  message: 'A time is needed.',
  retryable: false,
  correlationId: 'c',
};

describe('draining the queue', () => {
  it('sends in creation order, not in the order it was handed', async () => {
    // An update to something created offline is meaningless if the create has not landed.
    const sent: string[] = [];
    const three = operation('c3', 30);
    const one = operation('c1', 10);
    const two = operation('c2', 20);

    await drainPendingOperations([three, one, two], (op) => {
      sent.push(op.operationId);
      return Promise.resolve(ok);
    });

    expect(sent).toEqual([one.operationId, two.operationId, three.operationId]);
  });

  it('reports committed operations so the journal can delete them', async () => {
    const result = await drainPendingOperations([operation('a1', 1), operation('a2', 2)], () =>
      Promise.resolve(ok),
    );
    expect(result.committed).toHaveLength(2);
    expect(result.updated).toEqual([]);
    expect(result.stoppedEarly).toBeNull();
  });

  it('stops the whole drain when the device goes offline, and touches nothing after it', async () => {
    // The rule this module exists for. Without it, one dropped tunnel spends an attempt on every
    // queued edit, and a person who reconnects finds them all marked as needing attention rather
    // than simply sent.
    const queue = [operation('b1', 1), operation('b2', 2), operation('b3', 3)];
    let calls = 0;

    const result = await drainPendingOperations(queue, () => {
      calls += 1;
      return Promise.resolve(offline);
    });

    expect(calls).toBe(1);
    expect(result.stoppedEarly).toBe('OFFLINE');
    expect(result.untouched).toHaveLength(2);
    // Untouched means untouched: still PENDING, still no attempts spent.
    expect(result.untouched.every((op) => op.state === 'PENDING' && op.attemptCount === 0)).toBe(
      true,
    );
    expect(result.untouched.every(isUploadable)).toBe(true);
  });

  it('stops the drain when authorization ends', async () => {
    // `12` requires authorization loss to invalidate local access. Continuing is a revoked
    // caregiver's remaining edits arriving one after another - each refused, all of them sent.
    const queue = [operation('d1', 1), operation('d2', 2)];
    let calls = 0;

    const result = await drainPendingOperations(queue, () => {
      calls += 1;
      return Promise.resolve(lost);
    });

    expect(calls).toBe(1);
    expect(result.stoppedEarly).toBe('AUTHORIZATION');
    expect(result.untouched).toHaveLength(1);
  });

  it('still records the operation that ended the drain', async () => {
    // It was genuinely attempted, and its attempt count should say so. Only what comes after is
    // left alone.
    const result = await drainPendingOperations([operation('e1', 1), operation('e2', 2)], () =>
      Promise.resolve(offline),
    );
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.attemptCount).toBe(1);
    expect(result.updated[0]?.state).toBe('FAILED_RETRYABLE');
  });

  it('keeps going after a refusal, because that was about one edit', async () => {
    // A validation refusal says nothing about the next operation. Stopping here would let one
    // malformed edit block every other queued change indefinitely.
    const queue = [operation('f1', 1), operation('f2', 2), operation('f3', 3)];
    const answers: ApiOutcome<unknown>[] = [refused, ok, ok];
    let index = 0;

    const result = await drainPendingOperations(queue, () => Promise.resolve(answers[index++]!));

    expect(result.stoppedEarly).toBeNull();
    expect(result.committed).toHaveLength(2);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.state).toBe('REJECTED');
    expect(needsUserAttention(result.updated[0]!)).toBe(true);
  });

  it('keeps going after a server error, unlike an offline', async () => {
    // The asymmetry is deliberate: a 500 is about the request that caused it, and one endpoint
    // failing is not evidence the next will. The operation stays retryable and keeps its place.
    const queue = [operation('g1', 1), operation('g2', 2)];
    const answers: ApiOutcome<unknown>[] = [serverError, ok];
    let index = 0;

    const result = await drainPendingOperations(queue, () => Promise.resolve(answers[index++]!));

    expect(result.stoppedEarly).toBeNull();
    expect(result.committed).toHaveLength(1);
    expect(result.updated[0]?.state).toBe('FAILED_RETRYABLE');
    expect(isUploadable(result.updated[0]!)).toBe(true);
  });

  it('never sends an operation that is not uploadable', async () => {
    // A conflicted operation is waiting on a person, not on a retry. Sending it again would
    // overwrite the decision they are being asked to make.
    const conflicted: PendingOperation = {
      ...operation('h1', 1),
      state: 'CONFLICTED',
      attemptCount: 1,
    };
    const exhausted: PendingOperation = {
      ...operation('h2', 2),
      state: 'FAILED_RETRYABLE',
      attemptCount: MAX_UPLOAD_ATTEMPTS,
    };
    let calls = 0;

    const result = await drainPendingOperations([conflicted, exhausted], () => {
      calls += 1;
      return Promise.resolve(ok);
    });

    expect(calls).toBe(0);
    expect(result.committed).toEqual([]);
    expect(result.updated).toEqual([]);
  });

  it('does nothing and reports nothing on an empty queue', async () => {
    const result = await drainPendingOperations([], () => Promise.resolve(ok));
    expect(result).toEqual({ committed: [], updated: [], untouched: [], stoppedEarly: null });
  });

  it('drains what it can before the network goes', async () => {
    // The realistic case: two edits land, the third finds no connection, the fourth is left for
    // next time with a full attempt budget.
    const queue = [operation('i1', 1), operation('i2', 2), operation('i3', 3), operation('i4', 4)];
    const answers: ApiOutcome<unknown>[] = [ok, ok, offline, ok];
    let index = 0;

    const result = await drainPendingOperations(queue, () => Promise.resolve(answers[index++]!));

    expect(result.committed).toHaveLength(2);
    expect(result.updated).toHaveLength(1);
    expect(result.untouched).toHaveLength(1);
    expect(result.untouched[0]?.attemptCount).toBe(0);
    expect(result.stoppedEarly).toBe('OFFLINE');
  });
});
