/**
 * The pending-operation journal, on the encrypted store.
 *
 * Spec references: `12` ("Repository behavior" - a pending-operation journal, idempotency keys,
 * conflict status and sync metadata alongside local query/write; "Authorization loss invalidates
 * local access"), `13` (per-entity conflict policy; the operation ID is the idempotency key;
 * bounded retry), `03` group J ("pending user edits with deterministic sync handling"),
 * `DEV-038`.
 *
 * WHAT THIS ADDS AND WHAT IT REFUSES TO ADD
 * It is storage and nothing else: put a row, list the rows, replace a row, remove a row. Every
 * decision about those rows already exists and is tested without a device - which may be queued
 * (`isOptimisticallyApplicable`), which is next (`uploadOrder`), whether to send it again
 * (`isUploadable`), what an answer meant (`classifyUpload`), and what the answer does to the row
 * (`recordUploadOutcome`). Nothing in this file branches on an entity type, a state, or an error
 * code, because `apps/**` is outside the test run and a rule written here is a rule nothing
 * checks (trap 164).
 *
 * WHY IT IS A SECOND TABLE RATHER THAN A SECOND DATABASE
 * The journal holds the same health content the projection does - a schedule somebody typed is a
 * medicine time - so it belongs behind the same SQLCipher key rather than in a second store with
 * its own key handling to get wrong. It is a separate *table* because its rows have a lifecycle:
 * a projection row is replaced whenever the server answers, and a journal row survives until the
 * server has taken it or a person has dealt with it.
 *
 * WHY ROWS ARE SCOPED TO THE SESSION, LIKE THE PROJECTION
 * `12` requires authorization loss to invalidate local access, and an unsent write is local
 * access with a delayed effect. Two people on one device must not drain each other's edits, and
 * an identity change must not upload the previous person's queued change under the new person's
 * session. The session ID is a column rather than part of a composite key, so a drain can select
 * exactly one identity's work.
 *
 * WHY `clear` EXISTS AND `forget`-BY-KEY DOES NOT
 * Sign-out and identity change remove everything (`12`); an individual row leaves either because
 * the server committed it or because a person resolved it. There is no path that quietly drops one
 * unsent edit, because that is the outcome `12` calls unacceptable - a person's change disappearing
 * with nothing said.
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import { instantFrom, unsafeId } from '@kynviora/domain';
import type {
  OperationId,
  OperationState,
  PendingOperation,
  SyncEntityType,
} from '@kynviora/domain';

/**
 * Versioned by table name, exactly as the projection is - and with the same limitation, recorded
 * as `DEV-042`: a shape change starts a new table rather than migrating the old one.
 */
const TABLE = 'pending_operation_v1';

export interface PendingOperationStore {
  /** Everything queued for one identity, oldest first. Ordering for upload is `uploadOrder`. */
  list(sessionId: string): Promise<readonly PendingOperation[]>;
  /** Add or replace one operation, keyed by its operation ID. */
  put(sessionId: string, operation: PendingOperation): Promise<void>;
  /** Remove one operation. Used when the server has committed it, or a person has resolved it. */
  remove(sessionId: string, operationId: string): Promise<void>;
  /** Remove everything for one identity. Sign-out, and identity change (`12`). */
  clear(sessionId: string): Promise<void>;
}

async function ensureSchema(database: SQLiteDatabase): Promise<void> {
  await database.execAsync(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
      'operation_id TEXT PRIMARY KEY NOT NULL, ' +
      'session_id TEXT NOT NULL, ' +
      'entity_type TEXT NOT NULL, ' +
      'entity_id TEXT NOT NULL, ' +
      'mutation TEXT NOT NULL, ' +
      'payload TEXT NOT NULL, ' +
      // Nullable because a create has no version to be a precondition against (`13`).
      'base_version INTEGER, ' +
      'created_at TEXT NOT NULL, ' +
      'state TEXT NOT NULL, ' +
      'attempt_count INTEGER NOT NULL, ' +
      // The last error as sent, or NULL. Stored as JSON rather than as columns because it is
      // read back whole and handed to a screen; splitting it would be a second shape to maintain.
      'last_error TEXT' +
      ') STRICT;',
  );
  // The drain selects by identity every time it runs, on a table that grows with unsent edits.
  await database.execAsync(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_session ON ${TABLE} (session_id, created_at);`,
  );
}

interface Row {
  readonly operation_id: string;
  readonly session_id: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly mutation: string;
  readonly payload: string;
  readonly base_version: number | null;
  readonly created_at: string;
  readonly state: string;
  readonly attempt_count: number;
  readonly last_error: string | null;
}

/**
 * Turn a stored row back into an operation.
 *
 * Returns `null` for a row this build cannot make sense of rather than throwing, and the caller
 * drops it - the same choice the projection makes for a body that no longer parses. A row written
 * by a build with a different payload shape is not something a screen can be handed, and one
 * unreadable row must not stop every other queued edit from draining.
 *
 * The unions are cast rather than re-validated, which is the same unchecked cast the projection
 * documents: the row was written from a value this client had already accepted as that type, and
 * storing it did not move the trust boundary. `unsafeId` is used for the branded ID rather than a
 * bare cast so that grepping for it still finds this boundary.
 *
 * Two things are *not* cast. The JSON is parsed, so a payload from a build with a different shape
 * is a dropped row rather than an exception at the call site. And `createdAt` goes through
 * `instantFrom`, which validates - it is what `uploadOrder` sorts on, and an unparseable instant
 * would silently reorder the queue rather than fail, which for an update queued behind its own
 * create is the difference between an edit landing and an edit being refused.
 */
function toOperation(row: Row): PendingOperation | null {
  try {
    return {
      operationId: unsafeId<OperationId>(row.operation_id),
      entityType: row.entity_type as SyncEntityType,
      entityId: row.entity_id,
      mutation: row.mutation as PendingOperation['mutation'],
      payload: JSON.parse(row.payload) as unknown,
      baseVersion: row.base_version,
      createdAt: instantFrom(row.created_at),
      state: row.state as OperationState,
      attemptCount: row.attempt_count,
      lastError:
        row.last_error === null
          ? null
          : (JSON.parse(row.last_error) as PendingOperation['lastError']),
    };
  } catch {
    return null;
  }
}

export async function openPendingOperations(
  database: SQLiteDatabase,
): Promise<PendingOperationStore> {
  await ensureSchema(database);

  return {
    async list(sessionId: string): Promise<readonly PendingOperation[]> {
      const rows = await database.getAllAsync<Row>(
        `SELECT * FROM ${TABLE} WHERE session_id = ? ORDER BY created_at ASC, operation_id ASC;`,
        sessionId,
      );
      const operations: PendingOperation[] = [];
      for (const row of rows) {
        const operation = toOperation(row);
        if (operation !== null) operations.push(operation);
      }
      return operations;
    },

    async put(sessionId: string, operation: PendingOperation): Promise<void> {
      // Replace rather than insert-or-ignore: a row is rewritten on every attempt to record the
      // new state and attempt count, and the operation ID is stable across those attempts because
      // it is the idempotency key (`13`).
      await database.runAsync(
        `INSERT OR REPLACE INTO ${TABLE} ` +
          '(operation_id, session_id, entity_type, entity_id, mutation, payload, base_version, ' +
          ' created_at, state, attempt_count, last_error) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
        operation.operationId,
        sessionId,
        operation.entityType,
        operation.entityId,
        operation.mutation,
        JSON.stringify(operation.payload),
        operation.baseVersion,
        operation.createdAt,
        operation.state,
        operation.attemptCount,
        operation.lastError === null ? null : JSON.stringify(operation.lastError),
      );
    },

    async remove(sessionId: string, operationId: string): Promise<void> {
      // Scoped by session as well as by ID. An operation ID is a client-generated UUID and will
      // not collide, but a delete that ignores the identity is one identity able to act on
      // another's row, which is the shape `12` asks the session scoping to prevent.
      await database.runAsync(
        `DELETE FROM ${TABLE} WHERE session_id = ? AND operation_id = ?;`,
        sessionId,
        operationId,
      );
    },

    async clear(sessionId: string): Promise<void> {
      await database.runAsync(`DELETE FROM ${TABLE} WHERE session_id = ?;`, sessionId);
    },
  };
}
