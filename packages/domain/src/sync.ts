/**
 * Offline sync protocol: pending operations, cursors and conflict policy.
 *
 * Spec references: `13` ("Sync protocol", "Conflict policy"), `12` (repository behaviour, sync
 * behaviour), `06` Journey 10, `03` group J (offline essentials).
 *
 * THE SHAPE OF THE PROTOCOL
 *  - Every client mutation becomes a `PendingOperation` with a stable client-generated ID, which
 *    is also its idempotency key, so a retry commits exactly once (`13`).
 *  - Pull is cursor-based over a household- or profile-scoped change sequence. The cursor
 *    advances only after the local transaction commits, so an interrupted sync re-reads rather
 *    than skipping (`13`).
 *  - Conflict policy is **per entity type**, not global. `13` enumerates the cases, and a single
 *    last-write-wins rule would be wrong for most of them - dangerously so for profile facts and
 *    safety assessments.
 *
 * WHAT OPTIMISTIC APPLICATION IS ALLOWED FOR
 * `12`: "Optimistic updates are allowed only for low-risk user-owned changes. Do not
 * optimistically change caregiver grants or safety severity/publication state." That rule is
 * encoded in {@link isOptimisticallyApplicable} rather than left to each call site.
 */

import type { Instant } from './ports.js';
import type { OperationId } from './ids.js';
import type { DomainError } from './result.js';
import { compareInstants } from './ports.js';
import { ownEntry } from './lookup.js';

/** Entity types that participate in sync. */
export const SYNC_ENTITY_TYPES = [
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
] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

/**
 * Who wins when client and server disagree.
 *
 * `13` "Conflict policy" enumerates these by entity type. The values are deliberately verbs
 * describing *what happens*, not a priority number - "server wins" and "create a new version"
 * are different outcomes, not different rankings.
 */
export const CONFLICT_POLICIES = [
  /** Both versions are kept and merged by stable event ID. Dose events (`13`). */
  'MERGE_BY_ID',
  /** The server's version is authoritative. Grants, assessments, publications (`13`). */
  'SERVER_WINS',
  /** A new version is created; neither is discarded. Product confirmation, formulations (`13`). */
  'CREATE_NEW_VERSION',
  /** The user is asked. Notes, and anything clinically relevant (`13`). */
  'ASK_USER',
] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

/**
 * Conflict policy per entity type.
 *
 * `13` is explicit that profile facts must not be silently last-write-wins "if clinically
 * relevant", which is why allergy and condition records resolve to `ASK_USER` rather than to a
 * timestamp comparison. Losing a recorded allergy to a stale offline edit is exactly the kind of
 * silent data loss that would make a later safety assessment wrong.
 */
export const CONFLICT_POLICY_BY_ENTITY: Readonly<Record<SyncEntityType, ConflictPolicy>> =
  Object.freeze({
    owned_item: 'ASK_USER',
    medicine_schedule: 'ASK_USER',
    // Offline-created events with stable IDs. Merging by ID is what makes an offline retry safe.
    dose_event: 'MERGE_BY_ID',
    allergy_record: 'ASK_USER',
    condition_record: 'ASK_USER',
    review_task: 'SERVER_WINS',
    profile: 'ASK_USER',
    // Authorization truth. A client must never win here (spec 11, 12).
    caregiver_grant: 'SERVER_WINS',
    profile_assessment: 'SERVER_WINS',
    alert_publication: 'SERVER_WINS',
    // Append-only by design: a disagreement creates a new assertion (DEC-013).
    field_assertion: 'CREATE_NEW_VERSION',
    marketed_formulation: 'CREATE_NEW_VERSION',
  });

/**
 * The policy for an entity type, or `null` where this build has none for it.
 *
 * `null` rather than an index (DEC-146), and the direction is the point rather than the
 * prototype. `SyncEntityType` is a compile-time narrowing and every caller today passes a literal,
 * so an unrecognised value is not reachable now - but the queue these policies govern is
 * **persisted in the encrypted local store**, and `DEV-042` records that the store has no schema
 * migration. A journal row written by a different build carries whatever entity type that build
 * knew, and the type system has nothing to say about a string that was on disk before this binary
 * existed.
 */
export function conflictPolicyFor(entityType: SyncEntityType): ConflictPolicy | null {
  return ownEntry(CONFLICT_POLICY_BY_ENTITY, entityType);
}

/**
 * Whether a change of this type may be applied optimistically on the client.
 *
 * `12`: only low-risk user-owned changes. A client that optimistically showed a caregiver grant
 * as active, or a safety alert as resolved, would be displaying an authorization or safety
 * outcome the server has not agreed to.
 *
 * **Deny is the answer for a type this build does not know**, and it used to be admit. The old
 * form was `conflictPolicyFor(entityType) !== 'SERVER_WINS'`, and an unrecognised type resolved to
 * `undefined`, which is not `'SERVER_WINS'` - so the one question `12` phrases as a prohibition
 * was answered "yes" for every input nobody had thought about. `PendingSyncProvider.queue` is the
 * live caller and treats `true` as permission to write a change into the journal and show it as
 * kept.
 *
 * A rule stated as a prohibition has to fail closed, for the same reason `holdsCapability` reads
 * `OWNER_ONLY` from `isOwner` rather than from the capability set: the safe direction for an
 * unknown is the one that refuses.
 */
export function isOptimisticallyApplicable(entityType: SyncEntityType): boolean {
  const policy = conflictPolicyFor(entityType);
  return policy !== null && policy !== 'SERVER_WINS';
}

// ---------------------------------------------------------------------------
// Pending operations
// ---------------------------------------------------------------------------

export const OPERATION_STATES = [
  'PENDING',
  'IN_FLIGHT',
  'COMMITTED',
  'CONFLICTED',
  'REJECTED',
  'FAILED_RETRYABLE',
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export interface PendingOperation<TPayload = unknown> {
  /** Client-generated, stable across retries. Doubles as the idempotency key (`13`). */
  readonly operationId: OperationId;
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly mutation: 'CREATE' | 'UPDATE' | 'DELETE';
  readonly payload: TPayload;
  /**
   * Version the client had when it made the change.
   *
   * Sent as a precondition so the server can detect that the record moved underneath the client
   * (`13`: "Version/ETag/precondition for mutable records").
   */
  readonly baseVersion: number | null;
  readonly createdAt: Instant;
  readonly state: OperationState;
  readonly attemptCount: number;
  readonly lastError: DomainError | null;
}

/**
 * Maximum upload attempts before an operation stops retrying on its own.
 *
 * Bounded because an operation failing repeatedly is usually a validation or authorization
 * problem that retrying cannot fix, and `13` requires bounded backoff rather than an unbounded
 * retry loop. After this the operation surfaces to the user rather than retrying silently.
 */
export const MAX_UPLOAD_ATTEMPTS = 5;

/** Whether an operation should be uploaded on the next sync. */
export function isUploadable(operation: PendingOperation): boolean {
  if (operation.state === 'PENDING') return true;
  // A retryable failure is retried until the attempt cap.
  return operation.state === 'FAILED_RETRYABLE' && operation.attemptCount < MAX_UPLOAD_ATTEMPTS;
}

/**
 * Whether an operation needs the user's attention.
 *
 * A conflicted or rejected operation, or one that exhausted its retries, is surfaced rather than
 * discarded - `12` requires a "resolvable failure state", not silent loss of a user's edit.
 */
export function needsUserAttention(operation: PendingOperation): boolean {
  if (operation.state === 'CONFLICTED' || operation.state === 'REJECTED') return true;
  return operation.state === 'FAILED_RETRYABLE' && operation.attemptCount >= MAX_UPLOAD_ATTEMPTS;
}

/**
 * Record the outcome of an upload attempt.
 *
 * Returns a new operation; the journal is treated as immutable so an interrupted sync cannot
 * leave a half-updated record.
 */
export function recordUploadOutcome(
  operation: PendingOperation,
  outcome:
    | { readonly kind: 'COMMITTED' }
    | { readonly kind: 'CONFLICT'; readonly error: DomainError }
    | { readonly kind: 'REJECTED'; readonly error: DomainError }
    | { readonly kind: 'RETRYABLE'; readonly error: DomainError },
): PendingOperation {
  const attemptCount = operation.attemptCount + 1;

  switch (outcome.kind) {
    case 'COMMITTED':
      return { ...operation, state: 'COMMITTED', attemptCount, lastError: null };
    case 'CONFLICT':
      return { ...operation, state: 'CONFLICTED', attemptCount, lastError: outcome.error };
    case 'REJECTED':
      return { ...operation, state: 'REJECTED', attemptCount, lastError: outcome.error };
    case 'RETRYABLE':
      return { ...operation, state: 'FAILED_RETRYABLE', attemptCount, lastError: outcome.error };
  }
}

/**
 * Order operations for upload.
 *
 * Creation order, because a later operation may depend on an earlier one - an update to an item
 * created offline is meaningless if the create has not landed. The operation ID breaks ties so
 * the order is stable across runs.
 */
export function uploadOrder(operations: readonly PendingOperation[]): readonly PendingOperation[] {
  return [...operations].filter(isUploadable).sort((a, b) => {
    const byTime = compareInstants(a.createdAt, b.createdAt);
    return byTime !== 0 ? byTime : a.operationId < b.operationId ? -1 : 1;
  });
}

// ---------------------------------------------------------------------------
// Pull cursor
// ---------------------------------------------------------------------------

export interface SyncCursor {
  /** Opaque server-issued position in the change sequence. */
  readonly value: string;
  /** Server time when this cursor was issued, for staleness display (`06` Journey 10). */
  readonly issuedAt: Instant;
}

export interface ChangeBatch<TChange = unknown> {
  readonly changes: readonly TChange[];
  readonly nextCursor: SyncCursor;
  /** Whether more changes are waiting after this batch. */
  readonly hasMore: boolean;
  readonly serverTime: Instant;
}

export const PULL_OUTCOMES = ['APPLIED', 'DEFERRED', 'AUTHORIZATION_LOST'] as const;
export type PullOutcome = (typeof PULL_OUTCOMES)[number];

export interface PullResult {
  readonly outcome: PullOutcome;
  /** Advanced only on APPLIED. `13`: "Advance cursor only after local commit." */
  readonly cursor: SyncCursor;
  readonly appliedCount: number;
}

/**
 * Decide what to do with a pulled batch.
 *
 * The cursor advances **only** when the local transaction committed. If the commit failed, the
 * old cursor is returned so the same batch is re-read - re-applying an idempotent change is
 * harmless, whereas skipping one silently loses a safety update.
 */
export function resolvePull(
  currentCursor: SyncCursor,
  batch: ChangeBatch,
  localCommitSucceeded: boolean,
  authorizationStillValid = true,
): PullResult {
  if (!authorizationStillValid) {
    // `12`: "Authorization loss invalidates local access." The cursor does not advance, because
    // the batch may contain data this session is no longer entitled to.
    return { outcome: 'AUTHORIZATION_LOST', cursor: currentCursor, appliedCount: 0 };
  }

  if (!localCommitSucceeded) {
    return { outcome: 'DEFERRED', cursor: currentCursor, appliedCount: 0 };
  }

  return {
    outcome: 'APPLIED',
    cursor: batch.nextCursor,
    appliedCount: batch.changes.length,
  };
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

export interface ConflictInput<TValue> {
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly localValue: TValue;
  readonly serverValue: TValue;
  readonly localUpdatedAt: Instant;
  readonly serverUpdatedAt: Instant;
}

export const CONFLICT_RESOLUTIONS = [
  'TAKE_SERVER',
  'KEEP_BOTH',
  'CREATE_VERSION',
  'PROMPT_USER',
] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

export interface ConflictOutcome<TValue> {
  readonly resolution: ConflictResolution;
  /** The value to store locally, when the resolution determines one. */
  readonly resolvedValue: TValue | null;
  /** Non-sensitive machine reason, safe for telemetry (`20`). */
  readonly reasonCode: string;
  /** Whether the user must be shown this conflict. */
  readonly requiresUserAction: boolean;
}

/**
 * Resolve a sync conflict according to the entity's policy.
 *
 * Deliberately does **not** compare timestamps to pick a winner for anything clinically
 * relevant. `13`: "profile facts: do not silently last-write-wins if clinically relevant." A
 * stale offline edit overwriting a recorded allergy would make a later safety assessment wrong
 * with no trace of why.
 */
export function resolveConflict<TValue>(input: ConflictInput<TValue>): ConflictOutcome<TValue> {
  const policy = conflictPolicyFor(input.entityType);

  switch (policy) {
    case 'SERVER_WINS':
      // Authorization and safety truth. The client's version is discarded, not merged.
      return {
        resolution: 'TAKE_SERVER',
        resolvedValue: input.serverValue,
        reasonCode: 'server_authoritative',
        requiresUserAction: false,
      };

    case 'MERGE_BY_ID':
      // Both exist and are distinct records; neither is a conflict in the usual sense. The
      // caller keeps both, keyed by their stable IDs.
      return {
        resolution: 'KEEP_BOTH',
        resolvedValue: null,
        reasonCode: 'merged_by_stable_id',
        requiresUserAction: false,
      };

    case 'CREATE_NEW_VERSION':
      // Append-only entities. Neither value is discarded; the disagreement becomes history.
      return {
        resolution: 'CREATE_VERSION',
        resolvedValue: null,
        reasonCode: 'new_version_created',
        requiresUserAction: false,
      };

    case 'ASK_USER':
      return {
        resolution: 'PROMPT_USER',
        resolvedValue: null,
        reasonCode: 'user_resolution_required',
        requiresUserAction: true,
      };

    case null:
      // An entity type this build has no policy for. The switch used to have no such arm and
      // `conflictPolicyFor` used to return whatever an index gave it, so this function - typed to
      // return a `ConflictOutcome` - returned `undefined` at runtime and the caller dereferenced
      // it.
      //
      // The server's value, because the client must not win a disagreement about something
      // nobody has classified: `12` forbids optimistically applying an authorization or safety
      // outcome, and an unknown type cannot be shown not to be one. `requiresUserAction` is true
      // even so - discarding somebody's change is not something to do quietly, and this arm can
      // only be reached by a journal row written by a build that knew a type this one does not
      // (`DEV-042`).
      return {
        resolution: 'TAKE_SERVER',
        resolvedValue: input.serverValue,
        reasonCode: 'unclassified_entity_type',
        requiresUserAction: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Sign-out and authorization loss
// ---------------------------------------------------------------------------

/**
 * What must be cleared when a session ends or authorization is lost.
 *
 * `12` and `14`: "Sign-out removes decrypted projections and caches", and "Authorization loss
 * invalidates local access." Returning a list rather than performing the deletion keeps this
 * package pure while still defining the contract in one place, so a client cannot forget an item.
 */
export const LOCAL_DATA_CLASSES = [
  'DECRYPTED_PROJECTIONS',
  'PENDING_OPERATIONS',
  'SYNC_CURSORS',
  'CACHED_EVIDENCE_ASSETS',
  'TEMPORARY_CAPTURE_FILES',
  'SESSION_CREDENTIALS',
  'DATABASE_KEY',
  'NOTIFICATION_TOKEN',
] as const;
export type LocalDataClass = (typeof LOCAL_DATA_CLASSES)[number];

export const SIGN_OUT_REASONS = [
  'USER_SIGNED_OUT',
  'AUTHORIZATION_LOST',
  'ACCOUNT_DELETED',
  'GRANT_REVOKED',
] as const;
export type SignOutReason = (typeof SIGN_OUT_REASONS)[number];

/**
 * Which local data classes to clear for a given reason.
 *
 * Pending operations survive an ordinary sign-out, because a user signing out on a train with
 * unsynced dose events should not lose them. They do **not** survive account deletion or a
 * revoked grant, where retaining them would keep data the user is no longer entitled to hold.
 */
export function dataClassesToClear(reason: SignOutReason): readonly LocalDataClass[] {
  const always: LocalDataClass[] = [
    'DECRYPTED_PROJECTIONS',
    'SYNC_CURSORS',
    'CACHED_EVIDENCE_ASSETS',
    'TEMPORARY_CAPTURE_FILES',
    'SESSION_CREDENTIALS',
  ];

  switch (reason) {
    case 'USER_SIGNED_OUT':
      return always;
    case 'AUTHORIZATION_LOST':
      // The session is invalid but the account still exists, so unsynced work is preserved for
      // the user to retry after signing in again.
      return always;
    case 'GRANT_REVOKED':
      return [...always, 'PENDING_OPERATIONS'];
    case 'ACCOUNT_DELETED':
      return [...always, 'PENDING_OPERATIONS', 'DATABASE_KEY', 'NOTIFICATION_TOKEN'];
  }
}

/**
 * How stale the local view is, for the offline banner `06` Journey 10 requires.
 *
 * Returns minutes rather than a formatted string so the presentation layer chooses the wording.
 */
export function minutesSinceSync(lastSyncedAt: Instant | null, now: Instant): number | null {
  if (lastSyncedAt === null) return null;
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(lastSyncedAt)) / 60_000));
}
