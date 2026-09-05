/**
 * A persisted database the API process can actually run against.
 *
 * Spec references: `13` (every request runs under the caller's identity), `14` (RLS as defence in
 * depth, deny by default), DEC-004/005 (PGlite is the migration and RLS engine), `BLK-001`.
 *
 * WHY PGLITE RATHER THAN A CONNECTION STRING
 * `BLK-001` records that there is no managed Postgres and no Docker available here, and that
 * migrations have only ever run against PGlite in-memory. PGlite is genuine PostgreSQL 18.3
 * compiled to WASM and it can persist to a directory, so the same engine the authorization suite
 * runs against can back a running process with no external service at all. That turns "you cannot
 * test the app until somebody provisions a database" into "npm run dev".
 *
 * It is a **development** database and this module says so in one place: {@link RuntimeDbOptions}
 * has no host, port or password, because there is nothing to connect to. When `BLK-001` is
 * resolved this file grows a second implementation behind the same {@link RuntimeDb} interface and
 * the API does not change - which is the point of the interface existing.
 *
 * THE ROLE DISCIPLINE IS THE SAME AS THE TESTS'
 * `withUser` sets `kynviora_app` and the caller's ID in the request GUC; `withService` sets
 * `kynviora_service`. Both assert the session is not a superuser before running, for exactly the
 * reason the harness does: a superuser bypasses row-level security even under
 * `FORCE ROW LEVEL SECURITY`, so a process that forgot to switch roles would serve every row of
 * every household while looking like it worked.
 */

import { PGlite } from '@electric-sql/pglite';
import {
  APP_ROLE,
  RETENTION_ROLE,
  SERVICE_ROLE,
  loadMigrations,
  type Migration,
} from './migrations.js';

export interface RuntimeQueryResult<TRow> {
  readonly rows: TRow[];
  readonly affectedRows?: number;
}

export interface RuntimeConnection {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<RuntimeQueryResult<TRow>>;
}

export interface RuntimeDb {
  /** A connection as `kynviora_app`, with `kynviora.user_id` set. RLS applies in full. */
  withUser<T>(userId: string | null, fn: (db: RuntimeConnection) => Promise<T>): Promise<T>;
  /** A connection as `kynviora_service`. Privileged operations only (`13`). */
  withService<T>(fn: (db: RuntimeConnection) => Promise<T>): Promise<T>;
  /**
   * A connection as `kynviora_retention`. The purge sweep, and nothing else (DEC-117, `0026`).
   *
   * It is a third role rather than a mode of the service role for the reason `0022` gives: the
   * privilege being minimised is exactly the one an attacker who reached the service role would
   * use to cover their tracks. Every deadline the sweep relies on is a policy attached to this
   * role, so running the same statements as anybody else would delete far more - which is why
   * this is a separate method a caller has to ask for by name rather than a flag on `withService`.
   */
  withRetention<T>(fn: (db: RuntimeConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface RuntimeDbOptions {
  /**
   * Directory the database is stored in.
   *
   * Absent means in-memory, which is useful for a throwaway run and useless for anything you want
   * to look at twice.
   */
  readonly dataDir?: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyPresent: readonly string[];
}

/**
 * The little that applying a migration needs from a database.
 *
 * Two methods, so the same runner drives PGlite and a managed Postgres. It exists because the
 * alternative - a second migration runner for the managed path - would be two implementations of
 * "which migrations have run", and the failure mode of those disagreeing is a schema half
 * applied on one engine and fully applied on the other, discovered by a policy that is not there.
 */
export interface MigrationTarget {
  /** Run a script that may contain several statements. */
  exec(sql: string): Promise<void>;
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: TRow[] }>;
}

/** Adapt PGlite, whose `exec` returns results this runner does not want. */
export function pgliteTarget(db: PGlite): MigrationTarget {
  return {
    exec: async (sql) => {
      await db.exec(sql);
    },
    query: (sql, params) => db.query(sql, params as unknown[] | undefined),
  };
}

/**
 * Apply every migration that has not run yet.
 *
 * Idempotent by version, and it re-checks the checksum of migrations that already ran: a migration
 * edited after it was applied is a silent schema divergence, and the process refuses to start
 * rather than serve requests against a schema nobody has.
 */
export async function applyMigrations(
  db: MigrationTarget,
  migrations: readonly Migration[] = loadMigrations(),
): Promise<MigrationResult> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version   text PRIMARY KEY,
      checksum  text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const existing = await db.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migration',
  );
  const byVersion = new Map(existing.rows.map((row) => [row.version, row.checksum]));

  const applied: string[] = [];
  const alreadyPresent: string[] = [];

  for (const migration of migrations) {
    const seen = byVersion.get(migration.version);
    if (seen !== undefined) {
      if (seen !== migration.checksum) {
        throw new Error(
          `Migration ${migration.version} has changed since it was applied. The database and the ` +
            'repository now disagree about the schema. Recreate the data directory or add a new ' +
            'migration; do not edit an applied one.',
        );
      }
      alreadyPresent.push(migration.version);
      continue;
    }

    try {
      await db.exec(migration.sql);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Migration ${migration.version} failed: ${message}`);
    }
    await db.query('INSERT INTO schema_migration (version, checksum) VALUES ($1, $2)', [
      migration.version,
      migration.checksum,
    ]);
    applied.push(migration.version);
  }

  return { applied, alreadyPresent };
}

/**
 * Open the database and bring the schema up to date.
 *
 * PGlite is a single connection, so requests are serialised. That is fine for development and is
 * stated rather than discovered: it is the first thing that changes when `BLK-001` is resolved,
 * and it is why this is not a production adapter.
 */
export async function createRuntimeDb(options: RuntimeDbOptions = {}): Promise<RuntimeDb> {
  const db =
    options.dataDir === undefined ? await PGlite.create() : await PGlite.create(options.dataDir);

  await applyMigrations(pgliteTarget(db));

  async function assertNotSuperuser(expectedRole: string): Promise<void> {
    const res = await db.query<{ current_role_name: string; is_superuser: boolean }>(
      `SELECT current_user AS current_role_name,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
    );
    const row = res.rows[0];
    if (!row) throw new Error('Could not determine the current database role.');
    if (row.current_role_name !== expectedRole) {
      throw new Error(
        `Expected role ${expectedRole} but the session is ${row.current_role_name}. ` +
          'Row-level security would not be applying to this request.',
      );
    }
    if (row.is_superuser) {
      throw new Error(
        `Role ${expectedRole} is a superuser and bypasses row-level security entirely, even ` +
          'under FORCE ROW LEVEL SECURITY. Refusing to serve a request under it (DEC-005).',
      );
    }
  }

  async function runAs<T>(
    role: string,
    userId: string | null,
    fn: (db: RuntimeConnection) => Promise<T>,
  ): Promise<T> {
    await db.exec(`SET ROLE ${role};`);
    try {
      await assertNotSuperuser(role);
      await db.query('SELECT set_config($1, $2, false)', ['kynviora.user_id', userId ?? '']);
      return await fn(db);
    } finally {
      // Always, including on failure. A request that threw with the service role still set would
      // hand the next request privileges it never asked for.
      await db.exec('RESET ROLE;');
      await db.query('SELECT set_config($1, $2, false)', ['kynviora.user_id', '']);
    }
  }

  return {
    withUser: (userId, fn) => runAs(APP_ROLE, userId, fn),
    withService: (fn) => runAs(SERVICE_ROLE, null, fn),
    withRetention: (fn) => runAs(RETENTION_ROLE, null, fn),
    close: () => db.close(),
  };
}
