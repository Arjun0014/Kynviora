import { describe, it, expect } from 'vitest';
import {
  DOMAIN_ERROR_CODES,
  MAX_UPLOAD_ATTEMPTS,
  instantFrom,
  isUploadable,
  needsUserAttention,
  recordUploadOutcome,
  unsafeId,
  type OperationId,
  type PendingOperation,
} from '@kynviora/domain';
import {
  CONFLICT_REFUSAL_CODES,
  classifyUpload,
  isConflictRefusal,
  type UploadOutcome,
} from './pendingUpload.js';
import type { ApiOutcome } from './outcome.js';

/**
 * How one upload attempt is read (`13`, `12`, `DEV-038`).
 *
 * Every case below is a decision about somebody's unsent edit. The three that matter most are the
 * ones that look like working software when they are wrong: retrying a refusal, not retrying a
 * transient failure, and retrying an authorization failure.
 */

const refused = (code: string, message = 'No.', retryable = false): ApiOutcome<unknown> => ({
  kind: 'REFUSED',
  code,
  message,
  retryable,
  correlationId: 'c-1',
});

describe('classifying an upload attempt', () => {
  it('commits an OK', () => {
    expect(classifyUpload({ kind: 'OK', value: {}, correlationId: null })).toEqual({
      kind: 'COMMITTED',
    });
  });

  it('retries the two failures that say nothing about access', () => {
    // The same pair `retainsPreviousContent` singles out, reached from the other direction: a
    // tunnel dropping is not a statement about the edit.
    expect(classifyUpload({ kind: 'OFFLINE' }).kind).toBe('RETRYABLE');
    expect(classifyUpload({ kind: 'SERVER_ERROR', retryable: true, correlationId: 'c' }).kind).toBe(
      'RETRYABLE',
    );
  });

  it('marks a retryable failure as retryable on the error too', () => {
    const outcome = classifyUpload({ kind: 'OFFLINE' });
    expect(outcome.kind === 'RETRYABLE' && outcome.error.retryable).toBe(true);
  });

  it('never retries an authorization failure', () => {
    // `12` requires authorization loss to invalidate local access. An edit that keeps re-sending
    // is the opposite of invalidating it - a revoked caregiver's write, four more times.
    expect(classifyUpload({ kind: 'UNAUTHENTICATED' }).kind).toBe('REJECTED');
    expect(classifyUpload({ kind: 'AUTHORIZATION_LOST' }).kind).toBe('REJECTED');
    expect(classifyUpload({ kind: 'STEP_UP_REQUIRED' }).kind).toBe('REJECTED');
  });

  it('rejects an UNAVAILABLE rather than retrying it', () => {
    // 404 is genuine absence and refused access, deliberately indistinguishable. Either way
    // sending it again changes nothing.
    const outcome = classifyUpload({ kind: 'UNAVAILABLE' });
    expect(outcome.kind).toBe('REJECTED');
    // The code the API itself answers 404 with, so the client invents no second meaning for it.
    expect(outcome.kind === 'REJECTED' && outcome.error.code).toBe('PERMISSION_DENIED');
  });

  it('separates a conflict from a rejection by code, not by status', () => {
    // All three conflict codes are 409, and so are `INVITATION_ALREADY_RESOLVED` and
    // `EXPORT_CONTENT_CHANGED`, which are not conflicts at all. Branching on the status would put
    // an already-accepted invitation in front of somebody as a version they must choose between.
    for (const code of CONFLICT_REFUSAL_CODES) {
      expect(classifyUpload(refused(code)).kind).toBe('CONFLICT');
    }
    expect(classifyUpload(refused('INVITATION_ALREADY_RESOLVED')).kind).toBe('REJECTED');
    expect(classifyUpload(refused('EXPORT_CONTENT_CHANGED')).kind).toBe('REJECTED');
    expect(classifyUpload(refused('VALIDATION_FAILED')).kind).toBe('REJECTED');
  });

  it("keeps the server's own message rather than writing one", () => {
    // The server has already made it client-safe, and it is the only thing that tells the person
    // what to do. A message of our own would be a guess printed as a fact.
    const outcome = classifyUpload(refused('VALIDATION_FAILED', 'A time is needed.'));
    expect(outcome.kind === 'REJECTED' && outcome.error.reason).toBe('A time is needed.');
  });

  it("uses the server's code as sent when this build knows it", () => {
    const outcome = classifyUpload(refused('VERSION_CONFLICT', 'It moved.'));
    expect(outcome.kind === 'CONFLICT' && outcome.error.code).toBe('VERSION_CONFLICT');
    expect(outcome.kind === 'CONFLICT' && outcome.error.detail).toBeUndefined();
  });

  it('keeps an unrecognised code as data instead of asserting it is something else', () => {
    // Narrowed, never cast. A newer server's code must not be forced into this build's closed
    // vocabulary, and it must not be discarded either - it is what a developer would need.
    const outcome = classifyUpload(refused('SOMETHING_LATER', 'Not yet a thing.'));
    expect(outcome.kind).toBe('REJECTED');
    expect(outcome.kind === 'REJECTED' && outcome.error.detail).toEqual({
      serverCode: 'SOMETHING_LATER',
    });
    expect(outcome.kind === 'REJECTED' && outcome.error.reason).toBe('Not yet a thing.');
  });

  it('classifies an unrecognised conflict code as a conflict all the same', () => {
    // `isConflictRefusal` decides the class; the vocabulary decides only how the code is recorded.
    expect(isConflictRefusal('SYNC_CONFLICT')).toBe(true);
    expect(isConflictRefusal('VALIDATION_FAILED')).toBe(false);
  });

  it('recognises every conflict code it lists as one this build knows', () => {
    // The unrecognised branch above is unreachable against this build's own server, and this is
    // what keeps that true: if a conflict code were ever renamed out of the domain vocabulary, it
    // would start arriving as `VALIDATION_FAILED` with the truth buried in `detail`.
    for (const code of CONFLICT_REFUSAL_CODES) {
      expect(DOMAIN_ERROR_CODES as readonly string[]).toContain(code);
    }
  });
});

/**
 * The classification and the journal's state machine, driven together.
 *
 * Each function is tested on its own elsewhere. What these assert is the property that only
 * appears when they are composed: an edit is retried exactly when retrying could help, and
 * surfaces to a person exactly when it cannot.
 */
describe('what the classification does to a queued operation', () => {
  const operation: PendingOperation = {
    operationId: unsafeId<OperationId>('00000000-0000-4000-8000-0000000000a1'),
    entityType: 'medicine_schedule',
    entityId: '00000000-0000-4000-8000-0000000000b1',
    mutation: 'UPDATE',
    payload: {},
    baseVersion: 3,
    createdAt: instantFrom('2026-09-03T10:00:00.000Z'),
    state: 'PENDING',
    attemptCount: 0,
    lastError: null,
  };

  const apply = (op: PendingOperation, outcome: UploadOutcome): PendingOperation =>
    recordUploadOutcome(op, outcome);

  it('stops retrying once the server has refused', () => {
    // The failure this guards against: four more attempts, then "could not save" - for an edit
    // that was never going to save, with the message that named the problem never shown.
    const after = apply(
      operation,
      classifyUpload(refused('VALIDATION_FAILED', 'A time is needed.')),
    );
    expect(after.state).toBe('REJECTED');
    expect(isUploadable(after)).toBe(false);
    expect(needsUserAttention(after)).toBe(true);
  });

  it('keeps retrying while the network is the problem, up to the cap', () => {
    let current = operation;
    for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      expect(isUploadable(current)).toBe(true);
      current = apply(current, classifyUpload({ kind: 'OFFLINE' }));
    }
    // Bounded, per `13`. After the cap it surfaces rather than retrying silently forever.
    expect(isUploadable(current)).toBe(false);
    expect(needsUserAttention(current)).toBe(true);
  });

  it('surfaces a version conflict to the person rather than resending', () => {
    // `medicine_schedule` resolves `ASK_USER` under `13`'s per-entity policy, so a conflict is a
    // choice somebody makes, not something a retry can settle.
    const after = apply(operation, classifyUpload(refused('VERSION_CONFLICT', 'It moved.')));
    expect(after.state).toBe('CONFLICTED');
    expect(isUploadable(after)).toBe(false);
    expect(needsUserAttention(after)).toBe(true);
  });

  it('does not resend after authorization ends', () => {
    const after = apply(operation, classifyUpload({ kind: 'AUTHORIZATION_LOST' }));
    expect(after.state).toBe('REJECTED');
    expect(isUploadable(after)).toBe(false);
  });

  it('commits and stops being uploadable', () => {
    const after = apply(operation, classifyUpload({ kind: 'OK', value: {}, correlationId: null }));
    expect(after.state).toBe('COMMITTED');
    expect(isUploadable(after)).toBe(false);
    expect(needsUserAttention(after)).toBe(false);
  });
});

/**
 * Where the classification defers to the server instead of deciding for it.
 *
 * `13` puts `retryable` on the wire precisely so a client does not have to guess, and both
 * directions of getting this wrong cost somebody an edit.
 */
describe('honouring what the server said about retrying', () => {
  it('does not retry a 500 the server marked final', () => {
    // Four more attempts against a server that has already said they cannot succeed is the
    // attempt budget spent on the server's behalf.
    const outcome = classifyUpload({ kind: 'SERVER_ERROR', retryable: false, correlationId: 'c' });
    expect(outcome.kind).toBe('REJECTED');
  });

  it('retries a refusal the server marked retryable', () => {
    // `RATE_LIMITED` is the case that matters: a 429 asks for a pause, not a verdict on the edit.
    // Reading every refusal as final fails somebody's schedule change permanently because they
    // happened to save it during a burst.
    const outcome = classifyUpload(refused('RATE_LIMITED', 'Too many just now.', true));
    expect(outcome.kind).toBe('RETRYABLE');
    expect(outcome.kind === 'RETRYABLE' && outcome.error.retryable).toBe(true);
    expect(outcome.kind === 'RETRYABLE' && outcome.error.code).toBe('RATE_LIMITED');
  });

  it('still treats a retryable conflict as a conflict', () => {
    // A conflict is resolved by a person under `13`'s per-entity policy. Retrying it would
    // overwrite the choice they are being asked to make, whatever the flag says.
    expect(classifyUpload(refused('VERSION_CONFLICT', 'It moved.', true)).kind).toBe('CONFLICT');
  });
});
