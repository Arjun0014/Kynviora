/**
 * Migration CLI.
 *
 * Applies every migration that has not run yet to the local development database, and reports
 * what it did. Safe to run repeatedly - {@link applyMigrations} is idempotent by version and
 * refuses to continue if an already-applied migration has been edited since, because a database
 * and a repository that disagree about the schema is worse than a failed command.
 *
 *   npm run migrate
 */

import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from './runtime.js';
import { resolveDataDir } from './migrations.js';

// Anchored at the workspace root, so this and `npm run dev` open the same database
// whichever directory the script happens to run from.
const dataDir = resolveDataDir(process.env.KYNVIORA_LOCAL_DB_DIR);

async function main(): Promise<void> {
  const db = await PGlite.create(dataDir);
  try {
    const result = await applyMigrations(db);
    if (result.applied.length === 0) {
      process.stdout.write(
        `Schema is up to date (${String(result.alreadyPresent.length)} migrations, ${dataDir}).\n`,
      );
      return;
    }
    for (const version of result.applied) {
      process.stdout.write(`applied ${version}\n`);
    }
    process.stdout.write(
      `${String(result.applied.length)} applied, ${String(result.alreadyPresent.length)} already present (${dataDir}).\n`,
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
