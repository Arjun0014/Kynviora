import { describe, it, expect } from 'vitest';
import {
  SYNC_ENTITY_TYPES,
  conflictPolicyFor,
  isOptimisticallyApplicable,
  isUploadable,
  needsUserAttention,
  recordUploadOutcome,
  uploadOrder,
  resolvePull,
  resolveConflict,
  dataClassesToClear,
  minutesSinceSync,
  MAX_UPLOAD_ATTEMPTS,
  type PendingOperation,
  type SyncCursor,
  type ChangeBatch,
  type SyncEntityType,
} from './sync.js';
import { instantFrom } from './ports.js';
import { domainError } from './result.js';
import { unsafeId, type OperationId } from './ids.js';

const T0 = instantFrom('2026-08-29T10:00:00.000Z');
const T1 = instantFrom('2026-08-29T11:00:00.000Z');

function operation(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    operationId: unsafeId<OperationId>('op-1'),
    entityType: 'dose_event',
    entityId: 'entity-1',
    mutation: 'CREATE',
    payload: {},
    baseVersion: null,
    createdAt: T0,
    state: 'PENDING',
    attemptCount: 0,
    lastError: null,
    ...overrides,
  };
}

describe('conflict policy is per entity type (spec 13)', () => {
  it('assigns a policy to every entity type', () => {
    // A missing policy would silently fall through to whatever the caller assumed.
    for (const entityType of SYNC_ENTITY_TYPES) {
      expect(conflictPolicyFor(entityType)).toBeTruthy();
    }
  });

  it('merges dose events by stable ID', () => {
    // Spec 13: "dose events: merge by event ID". This is what makes an offline retry safe.
    expect(conflictPolicyFor('dose_event')).toBe('MERGE_BY_ID');
  });

  it('gives the server authority over caregiver grants', () => {
    // Authorization truth. A client must never win here (spec 11, 12).
    expect(conflictPolicyFor('caregiver_grant')).toBe('SERVER_WINS');
  });

  it('gives the server authority over assessments and publications', () => {
    expect(conflictPolicyFor('profile_assessment')).toBe('SERVER_WINS');
    expect(conflictPolicyFor('alert_publication')).toBe('SERVER_WINS');
  });

  it('does not silently last-write-wins a clinically relevant profile fact', () => {
    // THE RULE THAT MATTERS MOST HERE. Spec 13: "profile facts: do not silently
    // last-write-wins if clinically relevant." A stale offline edit overwriting a recorded
    // allergy would make a later safety assessment wrong with no trace of why.
    expect(conflictPolicyFor('allergy_record')).toBe('ASK_USER');
    expect(conflictPolicyFor('condition_record')).toBe('ASK_USER');
  });

  it('creates a new version for append-only catalog entities', () => {
    // Spec 13: "product confirmation: create new assertion/version rather than overwriting
    // history"; "catalog formulation conflict: create separate candidate and preserve both".
    expect(conflictPolicyFor('field_assertion')).toBe('CREATE_NEW_VERSION');
    expect(conflictPolicyFor('marketed_formulation')).toBe('CREATE_NEW_VERSION');
  });
});

describe('optimistic application (spec 12)', () => {
  it('forbids optimistic application of caregiver grants', () => {
    // Spec 12: "Do not optimistically change caregiver grants or safety severity/publication
    // state." Showing a grant as active before the server agrees would display an authorization
    // outcome that does not exist.
    expect(isOptimisticallyApplicable('caregiver_grant')).toBe(false);
  });

  it('forbids optimistic application of safety state', () => {
    expect(isOptimisticallyApplicable('profile_assessment')).toBe(false);
    expect(isOptimisticallyApplicable('alert_publication')).toBe(false);
  });

  it('allows optimistic application of low-risk user-owned changes', () => {
    expect(isOptimisticallyApplicable('dose_event')).toBe(true);
    expect(isOptimisticallyApplicable('owned_item')).toBe(true);
  });
});

describe('pending operations (spec 13 idempotency, spec 12 pending journal)', () => {
  it('uploads a pending operation', () => {
    expect(isUploadable(operation())).toBe(true);
  });

  it('does not re-upload a committed operation', () => {
    expect(isUploadable(operation({ state: 'COMMITTED' }))).toBe(false);
  });

  it('does not retry a rejected operation', () => {
    // A rejection is a validation or authorization decision. Retrying cannot change it.
    expect(isUploadable(operation({ state: 'REJECTED' }))).toBe(false);
  });

  it('retries a retryable failure up to the attempt cap', () => {
    expect(isUploadable(operation({ state: 'FAILED_RETRYABLE', attemptCount: 1 }))).toBe(true);
    expect(
      isUploadable(operation({ state: 'FAILED_RETRYABLE', attemptCount: MAX_UPLOAD_ATTEMPTS })),
    ).toBe(false);
  });

  it('surfaces an exhausted operation to the user rather than discarding it', () => {
    // Spec 12 requires a "resolvable failure state", not silent loss of a user's edit.
    const exhausted = operation({ state: 'FAILED_RETRYABLE', attemptCount: MAX_UPLOAD_ATTEMPTS });
    expect(isUploadable(exhausted)).toBe(false);
    expect(needsUserAttention(exhausted)).toBe(true);
  });

  it('surfaces a conflicted operation to the user', () => {
    expect(needsUserAttention(operation({ state: 'CONFLICTED' }))).toBe(true);
  });

  it('does not surface a healthy pending operation', () => {
    expect(needsUserAttention(operation())).toBe(false);
    expect(needsUserAttention(operation({ state: 'COMMITTED' }))).toBe(false);
  });
});

describe('recordUploadOutcome', () => {
  it('marks a committed operation and clears its error', () => {
    const result = recordUploadOutcome(
      operation({ state: 'FAILED_RETRYABLE', lastError: domainError('RATE_LIMITED', 'x') }),
      { kind: 'COMMITTED' },
    );
    expect(result.state).toBe('COMMITTED');
    expect(result.lastError).toBeNull();
  });

  it('records a conflict with its error', () => {
    const error = domainError('VERSION_CONFLICT', 'record moved');
    const result = recordUploadOutcome(operation(), { kind: 'CONFLICT', error });
    expect(result.state).toBe('CONFLICTED');
    expect(result.lastError).toBe(error);
  });

  it('increments the attempt count on every outcome', () => {
    const error = domainError('PROVIDER_UNAVAILABLE', 'x', undefined, true);
    let current = operation();
    for (let i = 1; i <= 3; i += 1) {
      current = recordUploadOutcome(current, { kind: 'RETRYABLE', error });
      expect(current.attemptCount).toBe(i);
    }
  });

  it('returns a new operation rather than mutating the journal', () => {
    // An interrupted sync must not leave a half-updated record.
    const original = operation();
    const snapshot = structuredClone(original);
    recordUploadOutcome(original, { kind: 'COMMITTED' });
    expect(original).toEqual(snapshot);
  });
});

describe('uploadOrder', () => {
  it('uploads in creation order, so a create lands before its update', () => {
    // An update to an item created offline is meaningless if the create has not landed.
    const create = operation({
      operationId: unsafeId<OperationId>('op-create'),
      mutation: 'CREATE',
      createdAt: T0,
    });
    const update = operation({
      operationId: unsafeId<OperationId>('op-update'),
      mutation: 'UPDATE',
      createdAt: T1,
    });

    expect(uploadOrder([update, create]).map((o) => o.operationId)).toEqual([
      'op-create',
      'op-update',
    ]);
  });

  it('breaks ties on operation ID so the order is stable across runs', () => {
    const a = operation({ operationId: unsafeId<OperationId>('op-a'), createdAt: T0 });
    const b = operation({ operationId: unsafeId<OperationId>('op-b'), createdAt: T0 });
    expect(uploadOrder([b, a]).map((o) => o.operationId)).toEqual(['op-a', 'op-b']);
    expect(uploadOrder([a, b]).map((o) => o.operationId)).toEqual(['op-a', 'op-b']);
  });

  it('excludes operations that are not uploadable', () => {
    const ordered = uploadOrder([
      operation({ operationId: unsafeId<OperationId>('op-1'), state: 'PENDING' }),
      operation({ operationId: unsafeId<OperationId>('op-2'), state: 'COMMITTED' }),
      operation({ operationId: unsafeId<OperationId>('op-3'), state: 'REJECTED' }),
    ]);
    expect(ordered.map((o) => o.operationId)).toEqual(['op-1']);
  });
});

describe('pull cursor (spec 13)', () => {
  const cursor = (value: string): SyncCursor => ({ value, issuedAt: T0 });

  const batch: ChangeBatch = {
    changes: [{}, {}, {}],
    nextCursor: cursor('cursor-2'),
    hasMore: false,
    serverTime: T1,
  };

  it('advances the cursor only after the local commit succeeds', () => {
    // Spec 13: "Advance cursor only after local commit."
    const result = resolvePull(cursor('cursor-1'), batch, true);
    expect(result.outcome).toBe('APPLIED');
    expect(result.cursor.value).toBe('cursor-2');
    expect(result.appliedCount).toBe(3);
  });

  it('holds the cursor when the local commit failed', () => {
    // Re-applying an idempotent change is harmless; skipping one silently loses a safety update.
    const result = resolvePull(cursor('cursor-1'), batch, false);
    expect(result.outcome).toBe('DEFERRED');
    expect(result.cursor.value).toBe('cursor-1');
    expect(result.appliedCount).toBe(0);
  });

  it('holds the cursor and applies nothing when authorization was lost mid-sync', () => {
    // Spec 12: "Authorization loss invalidates local access." The batch may contain data this
    // session is no longer entitled to.
    const result = resolvePull(cursor('cursor-1'), batch, true, false);
    expect(result.outcome).toBe('AUTHORIZATION_LOST');
    expect(result.cursor.value).toBe('cursor-1');
    expect(result.appliedCount).toBe(0);
  });

  it('checks authorization before the commit result', () => {
    // Even a successful local commit must not advance the cursor if authorization is gone.
    const result = resolvePull(cursor('cursor-1'), batch, true, false);
    expect(result.outcome).toBe('AUTHORIZATION_LOST');
  });
});

describe('resolveConflict', () => {
  function conflict(entityType: SyncEntityType) {
    return {
      entityType,
      entityId: 'e-1',
      localValue: { v: 'local' },
      serverValue: { v: 'server' },
      localUpdatedAt: T1,
      serverUpdatedAt: T0,
    };
  }

  it('takes the server value for authorization truth', () => {
    const outcome = resolveConflict(conflict('caregiver_grant'));
    expect(outcome.resolution).toBe('TAKE_SERVER');
    expect(outcome.resolvedValue).toEqual({ v: 'server' });
    expect(outcome.requiresUserAction).toBe(false);
  });

  it('takes the server value even when the local edit is newer', () => {
    // The local value has the later timestamp here. Timestamp does not decide authorization.
    const outcome = resolveConflict(conflict('profile_assessment'));
    expect(outcome.resolution).toBe('TAKE_SERVER');
  });

  it('prompts the user for a clinically relevant fact rather than picking a winner', () => {
    // Spec 13. The local edit is newer, and it still does not win automatically - losing a
    // recorded allergy to a stale offline edit would make a later assessment wrong.
    const outcome = resolveConflict(conflict('allergy_record'));
    expect(outcome.resolution).toBe('PROMPT_USER');
    expect(outcome.requiresUserAction).toBe(true);
    expect(outcome.resolvedValue).toBeNull();
  });

  it('keeps both dose events rather than discarding one', () => {
    const outcome = resolveConflict(conflict('dose_event'));
    expect(outcome.resolution).toBe('KEEP_BOTH');
    expect(outcome.requiresUserAction).toBe(false);
  });

  it('creates a new version for append-only entities, discarding neither', () => {
    const outcome = resolveConflict(conflict('marketed_formulation'));
    expect(outcome.resolution).toBe('CREATE_VERSION');
    expect(outcome.resolvedValue).toBeNull();
  });

  it('gives every resolution a non-sensitive reason code', () => {
    for (const entityType of SYNC_ENTITY_TYPES) {
      const outcome = resolveConflict(conflict(entityType));
      expect(outcome.reasonCode).toMatch(/^[a-z_]+$/);
    }
  });

  it('never discards a local value without either taking the server or asking', () => {
    // The dangerous outcome would be silently dropping a user's edit. Every resolution either
    // explicitly takes the server value, keeps both, versions both, or asks.
    for (const entityType of SYNC_ENTITY_TYPES) {
      const outcome = resolveConflict(conflict(entityType));
      expect(['TAKE_SERVER', 'KEEP_BOTH', 'CREATE_VERSION', 'PROMPT_USER']).toContain(
        outcome.resolution,
      );
    }
  });
});

describe('sign-out and authorization loss (spec 12, 14)', () => {
  it('clears decrypted projections and session credentials on sign-out', () => {
    const cleared = dataClassesToClear('USER_SIGNED_OUT');
    expect(cleared).toContain('DECRYPTED_PROJECTIONS');
    expect(cleared).toContain('SESSION_CREDENTIALS');
    expect(cleared).toContain('CACHED_EVIDENCE_ASSETS');
    expect(cleared).toContain('TEMPORARY_CAPTURE_FILES');
  });

  it('preserves unsynced work on an ordinary sign-out', () => {
    // A user signing out on a train with unsynced dose events should not lose them.
    expect(dataClassesToClear('USER_SIGNED_OUT')).not.toContain('PENDING_OPERATIONS');
  });

  it('preserves unsynced work when a session merely expires', () => {
    expect(dataClassesToClear('AUTHORIZATION_LOST')).not.toContain('PENDING_OPERATIONS');
  });

  it('discards unsynced work when a grant is revoked', () => {
    // Retaining it would keep data the user is no longer entitled to hold.
    expect(dataClassesToClear('GRANT_REVOKED')).toContain('PENDING_OPERATIONS');
  });

  it('clears the database key and notification token on account deletion', () => {
    const cleared = dataClassesToClear('ACCOUNT_DELETED');
    expect(cleared).toContain('DATABASE_KEY');
    expect(cleared).toContain('NOTIFICATION_TOKEN');
    expect(cleared).toContain('PENDING_OPERATIONS');
  });

  it('always clears the sync cursor, so a re-signin does not skip changes', () => {
    for (const reason of [
      'USER_SIGNED_OUT',
      'AUTHORIZATION_LOST',
      'GRANT_REVOKED',
      'ACCOUNT_DELETED',
    ] as const) {
      expect(dataClassesToClear(reason)).toContain('SYNC_CURSORS');
    }
  });
});

describe('minutesSinceSync (spec 06 Journey 10 staleness banner)', () => {
  it('reports elapsed minutes', () => {
    expect(minutesSinceSync(T0, T1)).toBe(60);
  });

  it('returns null when never synced, rather than zero', () => {
    // Zero would read as "just synced", which is the opposite of the truth.
    expect(minutesSinceSync(null, T1)).toBeNull();
  });

  it('clamps a future timestamp to zero rather than reporting negative time', () => {
    expect(minutesSinceSync(T1, T0)).toBe(0);
  });
});

/**
 * The direction an unclassified entity type is answered in.
 *
 * `12` phrases this as a prohibition - "do not optimistically change caregiver grants or safety
 * severity/publication state" - and a prohibition has to fail closed. It did not:
 * `conflictPolicyFor` resolved an unrecognised type to `undefined`, and
 * `undefined !== 'SERVER_WINS'` is `true`, so the one gate that decides whether a change may be
 * queued at all answered "yes" for every input nobody had thought about.
 *
 * Not reachable from any call site today - every caller passes a literal - but the journal these
 * policies govern is persisted in the encrypted store, and `DEV-042` records that the store has no
 * schema migration. A row written by another build carries whatever type that build knew.
 */
describe('an entity type this build has no policy for (DEC-146)', () => {
  const UNCLASSIFIED = [
    'toString',
    'constructor',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    'something_a_newer_build_wrote',
  ] as const;

  it.each(UNCLASSIFIED)('has no policy: %s', (name) => {
    expect(conflictPolicyFor(name as never)).toBeNull();
  });

  it.each(UNCLASSIFIED)('is refused optimistic application: %s', (name) => {
    expect(isOptimisticallyApplicable(name as never)).toBe(false);
  });

  it('still admits and refuses the types it knows', () => {
    expect(isOptimisticallyApplicable('dose_event')).toBe(true);
    expect(isOptimisticallyApplicable('owned_item')).toBe(true);
    expect(isOptimisticallyApplicable('caregiver_grant')).toBe(false);
    expect(isOptimisticallyApplicable('alert_publication')).toBe(false);
  });

  /**
   * `resolveConflict` is typed to return a `ConflictOutcome` and returned `undefined` at runtime
   * for these, because the switch had no arm for them.
   */
  it.each(UNCLASSIFIED)('resolves to the server rather than to nothing: %s', (name) => {
    const outcome = resolveConflict({
      entityType: name as never,
      entityId: 'x',
      localValue: 'local',
      serverValue: 'server',
      localUpdatedAt: instantFrom('2026-01-01T00:00:00.000Z'),
      serverUpdatedAt: instantFrom('2026-01-02T00:00:00.000Z'),
    });
    expect(outcome).toBeDefined();
    expect(outcome.resolution).toBe('TAKE_SERVER');
    expect(outcome.resolvedValue).toBe('server');
    expect(outcome.requiresUserAction).toBe(true);
  });

  it('every classified type still has a policy', () => {
    for (const entityType of SYNC_ENTITY_TYPES) {
      expect(conflictPolicyFor(entityType)).not.toBeNull();
    }
  });
});
