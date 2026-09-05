/**
 * The managed-Postgres runtime: a real server, a real pool, and the same role discipline.
 *
 * Spec references: `13` (every request runs under the caller's identity), `14` (RLS as defence in
 * depth, deny by default, least privilege, TLS in transit), `21` (environments), DEC-005,
 * DEC-037, `BLK-001`.
 *
 * WHAT THIS IS AND WHAT IT REPLACES
 * `runtime.ts` opens PGlite, which is genuine PostgreSQL and a single writer in one process. This
 * opens a connection pool onto a managed Postgres and satisfies the same {@link RuntimeDb}
 * interface, which is the whole reason that interface exists: the API, the worker and the tests
 * change nothing. What changes is that more than one process can now have the database open, so
 * the API and the retention worker can be two deployments rather than one process with a flag.
 *
 * THREE THINGS A POOL BREAKS THAT A SINGLE CONNECTION DID NOT
 *
 * **1. Session state outlives a request.** This adapter's whole authorization model is
 * `SET ROLE` plus a session GUC, and both belong to a *connection*. A pooled connection returned
 * with `kynviora_service` still set would hand the next request privileges it never asked for,
 * and one returned with `kynviora.user_id` still set would hand it somebody else's household. So
 * a connection is reset in a `finally`, and **a connection whose reset failed is destroyed rather
 * than returned** - a connection that cannot be proven clean is not a connection to reuse.
 *
 * **2. Transaction pooling silently discards that state.** Supavisor's transaction mode (port
 * 6543) hands a different server connection to each *transaction*, so `SET ROLE` on one statement
 * is simply gone by the next - which would make every policy evaluate against the login role
 * instead of the app role. That does not fail loudly; it fails as a query returning nothing,
 * which reads like an empty household. {@link assertSessionScoped} proves the pool is
 * session-scoped before a single row is served, by setting a role in one round trip and reading
 * it back in another.
 *
 * **3. A leaked transaction pins a server connection.** The callbacks here open their own
 * transactions (`caregiver.ts`, `retentionRun.ts`), so this adapter deliberately does **not**
 * wrap them in one - a nested `BEGIN` would be a warning and the inner `COMMIT` would commit the
 * outer scope. What it does instead is `ROLLBACK` unconditionally on the way out, which is a
 * harmless no-op after a callback that committed and the only correct answer after one that did
 * not.
 *
 * TLS IS PINNED, NOT DISABLED
 * Supabase's pooler presents a certificate from *Supabase Root 2021 CA*, a private root, so the
 * platform's own instructions in the wild frequently amount to `rejectUnauthorized: false` -
 * which turns TLS into encryption without authentication and makes an interception indetectable.
 * `db/certs/supabase-prod-ca-2021.crt` is that root, fetched over a publicly-trusted channel and
 * checked against the chain the pooler actually presents (both SHA-256
 * `8070:25AD:...:72E6:CAFA`). Verification stays on.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { APP_ROLE, RETENTION_ROLE, SERVICE_ROLE } from './migrations.js';
import type { RuntimeConnection, RuntimeDb, RuntimeQueryResult } from './runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The pinned trust anchor for Supabase's managed Postgres and its pooler. */
export const SUPABASE_CA_PATH = join(HERE, '..', 'certs', 'supabase-prod-ca-2021.crt');

/**
 * Roles a unit of work may run as.
 *
 * A closed set, and the reason it is closed is that the role name is the one value interpolated
 * into SQL rather than bound - `SET ROLE` takes an identifier, which the extended protocol cannot
 * parameterise. Membership of this array is therefore the injection boundary.
 */
export const RUNNABLE_ROLES = [APP_ROLE, SERVICE_ROLE, RETENTION_ROLE] as const;
export type RunnableRole = (typeof RUNNABLE_ROLES)[number];

export interface ManagedDbOptions {
  /** `postgresql://user:password@host:port/database`. Never logged, never committed. */
  readonly connectionString: string;
  /**
   * Client-side pool size.
   *
   * Small on purpose. Supavisor imposes its own per-project ceiling, and a client pool larger
   * than that queues at the pooler instead of here - where the wait is invisible and untimed.
   */
  readonly maxConnections?: number;
  /** PEM. Defaults to the pinned Supabase root; supply another for a different platform. */
  readonly caCertificate?: string;
  /**
   * Ceiling on a single statement.
   *
   * A runaway query on a pooled connection is not one slow request, it is one connection fewer
   * for everybody, so this is a availability control rather than a nicety.
   */
  readonly statementTimeoutMs?: number;
  /** Ceiling on an open transaction that has stopped doing anything. Same reasoning. */
  readonly idleInTransactionTimeoutMs?: number;
  /** Shows up in `pg_stat_activity`, which is how an operator tells two deployments apart. */
  readonly applicationName?: string;
  /** How long to wait for a connection before giving up rather than hanging a request. */
  readonly connectionTimeoutMs?: number;
}

export const DEFAULT_MAX_CONNECTIONS = 8;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;

function readCa(options: ManagedDbOptions): string {
  if (options.caCertificate !== undefined) return options.caCertificate;
  return readFileSync(SUPABASE_CA_PATH, 'utf8');
}

/**
 * Whether a connection string points at something reachable over a network.
 *
 * Used to refuse a plaintext target rather than to guess at one: `14` requires transport
 * encryption, and a URL naming a remote host with `sslmode=disable` is a configuration that
 * should not start.
 */
export function assertTransportIsEncrypted(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('KYNVIORA_DATABASE_URL must be a postgresql:// URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`Unsupported database URL scheme ${url.protocol}; expected postgresql:.`);
  }
  const sslmode = url.searchParams.get('sslmode');
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (sslmode !== null && (sslmode === 'disable' || sslmode === 'allow') && !loopback) {
    throw new Error(
      `sslmode=${sslmode} on a remote database. Credentials and health data would cross the ` +
        'network in plaintext (spec 14). Remove it, or point at loopback for a local stack.',
    );
  }
}

interface RoleFacts {
  readonly current_role_name: string;
  readonly is_superuser: boolean;
  readonly bypasses_rls: boolean;
}

/**
 * Set the request identity and read back what the session actually is, in one round trip.
 *
 * The two belong together: what makes the facts worth having is that they describe the session
 * the very next statement will run in, and a separate assertion query is a separate session's
 * worth of assumption on a pooled connection.
 */
const SET_CONTEXT_AND_READ_ROLE = `
  SELECT set_config('kynviora.user_id', $1, false)                        AS request_user,
         current_user                                                     AS current_role_name,
         (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS is_superuser,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls`;

/**
 * Refuse a session that row-level security would not apply to.
 *
 * Two attributes, not one. `rolsuper` is the check `runtime.ts` and the test harness already
 * make; `rolbypassrls` is the one a managed platform adds, because it is an attribute an operator
 * can grant to an ordinary role with a single statement and it has exactly the effect a superuser
 * has - every policy is skipped, and every negative authorization test passes while asserting
 * nothing. Supabase grants it to `postgres` by default, so this is not hypothetical: connecting
 * with the platform's own credential would produce precisely that.
 */
function assertRlsApplies(facts: RoleFacts | undefined, expectedRole: string): void {
  if (facts === undefined) throw new Error('Could not determine the current database role.');
  if (facts.current_role_name !== expectedRole) {
    throw new Error(
      `Expected role ${expectedRole} but the session is ${facts.current_role_name}. ` +
        'Row-level security would not be applying to this request.',
    );
  }
  if (facts.is_superuser) {
    throw new Error(
      `Role ${expectedRole} is a superuser and bypasses row-level security entirely, even under ` +
        'FORCE ROW LEVEL SECURITY. Refusing to serve a request under it (DEC-005).',
    );
  }
  if (facts.bypasses_rls) {
    throw new Error(
      `Role ${expectedRole} carries BYPASSRLS. Every policy would be skipped and every negative ` +
        'authorization test would pass vacuously. Refusing to serve a request under it.',
    );
  }
}

/**
 * Prove the pool hands out sessions rather than transactions.
 *
 * Two round trips on purpose, because that is the thing being measured: under transaction
 * pooling the second statement may land on a different server connection, where the role set by
 * the first was never set. One combined statement would pass under both arrangements and
 * establish nothing.
 */
export async function assertSessionScoped(client: pg.PoolClient): Promise<void> {
  await client.query(`SET ROLE ${APP_ROLE}`);
  let seen: string;
  try {
    const result = await client.query<{ role: string }>('SELECT current_user AS role');
    seen = result.rows[0]?.role ?? '(none)';
  } finally {
    await client.query('RESET ROLE');
  }
  if (seen !== APP_ROLE) {
    throw new Error(
      `This connection is not session-scoped: SET ROLE ${APP_ROLE} was not visible to the next ` +
        `statement, which saw ${seen}. Kynviora carries the caller's identity in a session GUC ` +
        'and its privileges in the session role, so a transaction-mode pooler (Supavisor port ' +
        '6543) discards both between statements and every policy evaluates against the wrong ' +
        'role. Use the session-mode port (5432).',
    );
  }
}

/** Escape a Postgres string literal. Only reached for the application name. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface ManagedRuntimeDb extends RuntimeDb {
  /** Live pool statistics, for the operations snapshot and for tests about pooling itself. */
  poolStats(): { readonly total: number; readonly idle: number; readonly waiting: number };
}

/**
 * Open a pool onto a managed Postgres.
 *
 * **Migrations are not applied here**, unlike {@link createRuntimeDb}. Two reasons, and the
 * second is the one that matters: the runtime credential has no DDL privilege at all by design,
 * and a shared database migrated by whichever application process happened to boot first is a
 * schema change racing N replicas. `npm run migrate` owns that, with its own credential.
 */
export async function createManagedRuntimeDb(options: ManagedDbOptions): Promise<ManagedRuntimeDb> {
  assertTransportIsEncrypted(options.connectionString);

  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const idleInTransactionTimeoutMs =
    options.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS;
  const applicationName = options.applicationName ?? 'kynviora';

  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    ssl: { ca: readCa(options), rejectUnauthorized: true },
  });

  // Per physical connection, once. Both timeouts are set here rather than per checkout so a
  // connection that escapes the checkout path is still bounded.
  pool.on('connect', (client: pg.PoolClient) => {
    void client.query(
      `SET statement_timeout = ${String(statementTimeoutMs)};
       SET idle_in_transaction_session_timeout = ${String(idleInTransactionTimeoutMs)};
       SET application_name = ${quoteLiteral(applicationName)};`,
    );
  });

  // A pooled connection can be killed by the server between checkouts. Without a listener the
  // process exits on the resulting 'error' event, which is a database restart taking the API
  // down with it.
  pool.on('error', () => {
    /* Handled by the checkout path, which will fail and be retried by the caller. */
  });

  // Before a single row is served.
  const probe = await pool.connect();
  try {
    await assertSessionScoped(probe);
  } finally {
    probe.release();
  }

  async function runAs<T>(
    role: RunnableRole,
    userId: string | null,
    fn: (db: RuntimeConnection) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      // Two round trips: the role, then the identity and the proof. `SET ROLE` takes an
      // identifier, which cannot be a bind parameter - which is why `role` comes from a closed
      // union and never from a caller.
      await client.query(`SET ROLE ${role}`);
      const facts = await client.query<RoleFacts>(SET_CONTEXT_AND_READ_ROLE, [userId ?? '']);
      assertRlsApplies(facts.rows[0], role);

      const connection: RuntimeConnection = {
        async query<TRow = Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[],
        ): Promise<RuntimeQueryResult<TRow>> {
          // `pg` constrains its row generic to an index signature; `RuntimeConnection` does not,
          // because callers name concrete row shapes. Widened here rather than pushing the
          // constraint out into every caller of the interface both adapters implement.
          const result = await (params === undefined
            ? client.query(sql)
            : client.query(sql, params as unknown[]));
          const rows = result.rows as TRow[];
          // `exactOptionalPropertyTypes`: an absent count and a count of `undefined` are
          // different things, and `pg` reports `null` for a statement that has no row count.
          return result.rowCount === null ? { rows } : { rows, affectedRows: result.rowCount };
        },
      };

      return await fn(connection);
    } finally {
      // Unconditional. A callback that committed leaves no transaction and this is a warning; one
      // that threw mid-transaction leaves an open one, and returning that to the pool would pin a
      // server connection until `idle_in_transaction_session_timeout` fires.
      let clean = true;
      try {
        await client.query('ROLLBACK');
        await client.query(`RESET ROLE; SELECT set_config('kynviora.user_id', '', false)`);
      } catch {
        clean = false;
      }
      // A connection that may still carry a role or an identity is destroyed rather than
      // returned. Whether the *callback* failed is not consulted: a failed callback on a
      // resettable connection is ordinary, and a failed reset never is.
      client.release(clean ? undefined : true);
    }
  }

  return {
    withUser: (userId, fn) => runAs(APP_ROLE, userId, fn),
    withService: (fn) => runAs(SERVICE_ROLE, null, fn),
    withRetention: (fn) => runAs(RETENTION_ROLE, null, fn),
    poolStats: () => ({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    }),
    close: () => pool.end(),
  };
}

/**
 * Read the managed connection string, or `null` when this deployment has no managed database.
 *
 * `null` rather than a default. There is no sensible default for "which Postgres", and a fallback
 * to a local one is how a process that was meant to talk to production quietly serves an empty
 * development database instead.
 */
export function readManagedDatabaseUrl(
  env: Readonly<Partial<Record<string, string>>> = process.env,
): string | null {
  const raw = env.KYNVIORA_DATABASE_URL?.trim();
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * Read the migration credential.
 *
 * A **separate** credential from the runtime one, and the separation is the point. The runtime
 * role holds no DDL privilege and cannot create a table even if something asked it to; the
 * migration role can, and is used by exactly one command. Falling back from one to the other
 * would collapse that into a single credential with both powers, which is the arrangement the
 * split exists to avoid.
 */
export function readMigrateDatabaseUrl(
  env: Readonly<Partial<Record<string, string>>> = process.env,
): string | null {
  const raw = env.KYNVIORA_MIGRATE_DATABASE_URL?.trim();
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * Run something against a managed database on one dedicated connection.
 *
 * For migrations and for provisioning: both are one-shot, both need the whole thing to be one
 * session, and neither wants a pool.
 */
export async function withManagedClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
  caCertificate?: string,
): Promise<T> {
  assertTransportIsEncrypted(connectionString);
  const client = new pg.Client({
    connectionString,
    ssl: {
      ca: caCertificate ?? readFileSync(SUPABASE_CA_PATH, 'utf8'),
      rejectUnauthorized: true,
    },
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
