/**
 * Migration CLI.
 *
 * Applies every migration that has not run yet, and reports what it did. Safe to run repeatedly -
 * {@link applyMigrations} is idempotent by version and refuses to continue if an already-applied
 * migration has been edited since, because a database and a repository that disagree about the
 * schema is worse than a failed command.
 *
 *   npm run migrate
 *
 * TWO TARGETS, AND THE CREDENTIAL IS THE SWITCH
 *
 *  - `KYNVIORA_MIGRATE_DATABASE_URL` set: a managed Postgres, over TLS with a pinned CA.
 *  - otherwise: the local PGlite directory, which is what this repository has run against since
 *    Stage 0 (`BLK-001`, DEC-004).
 *
 * The managed target deliberately uses a **different** credential from the one the API runs as.
 * `KYNVIORA_DATABASE_URL` names a role that holds no DDL privilege at all and cannot create a
 * table even if something asked it to; this one can, and is used by exactly one command. There is
 * no fallback from one to the other, because a fallback collapses the two into a single
 * credential holding both powers - which is the arrangement the split exists to avoid.
 */

import { PGlite } from '@electric-sql/pglite';
import {
  applyMigrations,
  pgliteTarget,
  type MigrationResult,
  type MigrationTarget,
} from './runtime.js';
import { readMigrateDatabaseUrl, withManagedClient } from './managed.js';
import { resolveDataDir } from './migrations.js';

function report(result: MigrationResult, target: string): void {
  if (result.applied.length === 0) {
    process.stdout.write(
      `Schema is up to date (${String(result.alreadyPresent.length)} migrations, ${target}).\n`,
    );
    return;
  }
  for (const version of result.applied) {
    process.stdout.write(`applied ${version}\n`);
  }
  process.stdout.write(
    `${String(result.applied.length)} applied, ` +
      `${String(result.alreadyPresent.length)} already present (${target}).\n`,
  );
}

/** The host and database, with the credential removed. Safe to print; the URL is not. */
function describe(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port}${url.pathname}`;
  } catch {
    return 'managed database';
  }
}

async function migrateManaged(connectionString: string): Promise<void> {
  // No statement timeout, and it is the only caller that asks for none: DDL over a table that is
  // not small is legitimately slower than any bound worth setting, and a migration cancelled
  // halfway is worse than one that takes its time.
  const result = await withManagedClient(
    connectionString,
    async (client) => {
      const target: MigrationTarget = {
        exec: async (sql: string): Promise<void> => {
          await client.query(sql);
        },
        query: async (sql: string, params?: readonly unknown[]) => {
          const res =
            params === undefined ? await client.query(sql) : await client.query(sql, [...params]);
          return { rows: res.rows as never[] };
        },
      };
      return applyMigrations(target);
    },
    undefined,
    0,
  );
  report(result, describe(connectionString));
}

async function migrateLocal(): Promise<void> {
  // Anchored at the workspace root, so this and `npm run dev` open the same database
  // whichever directory the script happens to run from.
  const dataDir = resolveDataDir(process.env.KYNVIORA_LOCAL_DB_DIR);
  const db = await PGlite.create(dataDir);
  try {
    report(await applyMigrations(pgliteTarget(db)), dataDir);
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const managed = readMigrateDatabaseUrl();
  if (managed !== null) {
    await migrateManaged(managed);
    return;
  }
  await migrateLocal();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
