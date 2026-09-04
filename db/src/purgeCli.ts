/**
 * Purge CLI (DEC-117, `docs/RETENTION.md`).
 *
 *   npm run purge
 *
 * Runs one sweep against the local development database and reports what it removed. Safe to run
 * repeatedly: every deadline is evaluated by the database, so a second run in the same minute
 * finds nothing and says so.
 *
 * WHAT THIS IS NOT
 * A scheduler. There is no worker process in this build and no deployment to run one in, so the
 * thirty-day deadline is a commitment the code can keep and the operation cannot yet - which
 * `docs/RETENTION.md` says in place of a claim, and which this file does not pretend otherwise
 * about by printing a next-run time.
 *
 * IT SWITCHES ROLE AND WILL NOT PROCEED WITHOUT DOING SO
 * `runPurgeSweep`'s safety is entirely in the policies attached to `kynviora_retention`. Run as
 * anybody else, the same statements would delete far more - as the table owner they would delete
 * everything - so the role switch is asserted rather than assumed, on the same reasoning DEC-005
 * gives for the test harness.
 */

import { PGlite } from '@electric-sql/pglite';
import { RETENTION_ROLE, resolveDataDir } from './migrations.js';
import { runPurgeSweep, purgeReportIsEmpty } from './retention.js';

const dataDir = resolveDataDir(process.env.KYNVIORA_LOCAL_DB_DIR);

async function main(): Promise<void> {
  const db = await PGlite.create(dataDir);
  try {
    await db.exec(`SET ROLE ${RETENTION_ROLE};`);

    const check = await db.query<{ role_name: string }>(`SELECT current_user AS role_name`);
    if (check.rows[0]?.role_name !== RETENTION_ROLE) {
      throw new Error(
        `Refusing to sweep as ${String(check.rows[0]?.role_name)}. Every deadline in this sweep ` +
          `is enforced by ${RETENTION_ROLE}'s policies, and another role would not be bounded ` +
          'by them (DEC-005, DEC-117).',
      );
    }

    const report = await runPurgeSweep(db);

    if (purgeReportIsEmpty(report)) {
      process.stdout.write(`Nothing was due (${dataDir}).\n`);
      return;
    }

    // Counts only, on the same rule the report itself follows: `20` keeps operational output free
    // of health content, and a sweep that named what it purged would be the one place a deleted
    // record came back - into a terminal, and from there into whatever captured it.
    for (const [section, removed] of Object.entries(report)) {
      if (removed > 0) process.stdout.write(`${section}: ${String(removed)}\n`);
    }
  } finally {
    await db.exec('RESET ROLE;');
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
