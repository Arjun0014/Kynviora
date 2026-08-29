/**
 * PGlite migration and authorization test harness (DEC-004, DEC-005).
 *
 * PGlite runs genuine PostgreSQL 18.3 compiled to WASM, so migrations, constraints, triggers and
 * row-level security policies execute for real rather than against a mock. This matters because
 * `14_SECURITY.md` and `19_TESTING_AND_QUALITY_STRATEGY.md` make deny-by-default RLS negative
 * tests release-gating, and a mocked database would test the mock.
 *
 * THE SUPERUSER TRAP
 * Superusers - and, under some configurations, table owners - bypass RLS entirely, *even with*
 * `FORCE ROW LEVEL SECURITY`. This was confirmed empirically before adopting PGlite: querying as
 * `postgres` returned every row of a policy-protected table. A test suite that forgets to switch
 * roles therefore passes while asserting nothing.
 *
 * {@link asUser} and {@link asService} guard against that by asserting the session is not a
 * superuser before running the callback, so a misconfigured test fails loudly instead of
 * vacuously passing.
 */

import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

/** Database roles used by the application (see `0001_foundation.sql`). */
export const APP_ROLE = 'kynviora_app';
export const SERVICE_ROLE = 'kynviora_service';

export interface Migration {
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
}

/** Read migrations in lexical order. Filenames are zero-padded so this is also numeric order. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return {
        version: file.replace(/\.sql$/, ''),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

export interface TestDb {
  readonly db: PGlite;
  /** Run a callback as the ordinary authenticated-user role, with RLS in force. */
  asUser<T>(userId: string | null, fn: (db: PGlite) => Promise<T>): Promise<T>;
  /** Run a callback as the privileged service role. */
  asService<T>(fn: (db: PGlite) => Promise<T>): Promise<T>;
  /** Run a callback with full owner privileges, for fixture setup only. */
  asOwner<T>(fn: (db: PGlite) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Create an in-memory database with all migrations applied.
 *
 * Each call produces an isolated database, so tests cannot leak state into one another.
 */
export async function createTestDb(dir: string = MIGRATIONS_DIR): Promise<TestDb> {
  const db = await PGlite.create();
  const migrations = loadMigrations(dir);

  for (const migration of migrations) {
    try {
      await db.exec(migration.sql);
    } catch (cause) {
      // Report position and a short excerpt rather than letting the driver serialize the whole
      // migration into the failure output, which buries the actual error.
      const message = cause instanceof Error ? cause.message : String(cause);
      const position = Number(
        (cause as { position?: string } | undefined)?.position ?? Number.NaN,
      );
      let excerpt = '';
      if (Number.isFinite(position) && position > 0) {
        const start = Math.max(0, position - 160);
        excerpt = `\n  near: ...${migration.sql.slice(start, position + 80).replace(/\s+/g, ' ')}...`;
      }
      throw new Error(`Migration ${migration.version} failed: ${message}${excerpt}`);
    }
    await db.query(
      'INSERT INTO schema_migration (version, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [migration.version, migration.checksum],
    );
  }

  /**
   * Assert the current session actually has RLS applied to it.
   *
   * Without this, a forgotten `SET ROLE` would silently make every authorization assertion
   * meaningless - the exact failure mode described in the module docstring.
   */
  async function assertRlsApplies(expectedRole: string): Promise<void> {
    const res = await db.query<{ current_role_name: string; is_superuser: boolean }>(
      `SELECT current_user AS current_role_name,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
    );
    const row = res.rows[0];
    if (!row) throw new Error('Harness could not determine the current role.');
    if (row.current_role_name !== expectedRole) {
      throw new Error(
        `Harness expected role ${expectedRole} but session is ${row.current_role_name}. ` +
          'Authorization assertions made in this session would not be exercising RLS.',
      );
    }
    if (row.is_superuser) {
      throw new Error(
        `Role ${expectedRole} is a superuser and bypasses row-level security entirely, even ` +
          'under FORCE ROW LEVEL SECURITY. Authorization tests in this session would pass ' +
          'vacuously. See DEC-005.',
      );
    }
  }

  async function runAs<T>(
    role: string,
    userId: string | null,
    fn: (db: PGlite) => Promise<T>,
  ): Promise<T> {
    await db.exec(`SET ROLE ${role};`);
    try {
      await assertRlsApplies(role);
      // `false` scopes the setting to the session rather than a transaction, which matches how
      // the API sets request context on a pooled connection.
      await db.query('SELECT set_config($1, $2, false)', ['kynviora.user_id', userId ?? '']);
      return await fn(db);
    } finally {
      await db.exec('RESET ROLE;');
      await db.query('SELECT set_config($1, $2, false)', ['kynviora.user_id', '']);
    }
  }

  return {
    db,
    asUser: (userId, fn) => runAs(APP_ROLE, userId, fn),
    asService: (fn) => runAs(SERVICE_ROLE, null, fn),
    asOwner: async (fn) => fn(db),
    close: () => db.close(),
  };
}

/**
 * Assert that an operation is refused by authorization.
 *
 * Postgres expresses RLS refusal in two different ways, and a test that checks only one of them
 * misses real regressions:
 *  - a blocked SELECT/UPDATE returns **zero rows** (the row is invisible, not an error);
 *  - a blocked INSERT/UPDATE target raises `42501` / "violates row-level security policy";
 *  - a missing GRANT raises "permission denied".
 *
 * Callers use {@link expectDenied} for write attempts and assert on row counts for reads.
 */
export async function expectDenied(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(
    'Expected the operation to be denied by authorization, but it succeeded. ' +
      'This is a deny-by-default failure (spec 14).',
  );
}

/** UUID helper for fixtures - deterministic so failures are reproducible. */
export function testUuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}
