import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createManagedRuntimeDb,
  readManagedDatabaseUrl,
  type ManagedRuntimeDb,
  type PurgeConnection,
} from './src/index.js';
import {
  acquireRetentionLease,
  executeRetentionRun,
  readLastRetentionRun,
  releaseRetentionLease,
  reapAbandonedRuns,
  startRetentionLoop,
  DEFAULT_RETENTION_WORKER_CONFIG,
} from '@kynviora/worker';
import type { Clock, Instant, Logger } from '@kynviora/domain';

/**
 * The retention worker against a database more than one process can hold.
 *
 * Spec references: `16` (retention deadlines), `20` (a job says what it did, in counts), `21`,
 * DEC-121, DEC-037, `DEV-063`, `BLK-001`, `docs/RETENTION.md` sections 8.1 and 8.2.
 *
 * WHY THIS COULD NOT EXIST UNTIL NOW
 * `retention_lease` was written for two workers and has never had two. PGlite is a single writer
 * (DEC-037), so the only arrangement that could sweep the development database was the loop
 * running **inside** the API process - and a lease protecting one process from itself is a lease
 * nothing has contended. `docs/RETENTION.md` 8.2 says so in a table: "its own process ... when
 * `BLK-001` clears".
 *
 * So the tests here are the ones whose whole content is concurrency: two holders on one lease, a
 * killed worker's lease expiring, a run left open being closed by whoever comes next, and two
 * real loops on one database producing one sweep between them rather than two.
 *
 * WHY THE PURGE IS EXERCISED WITH A BACKDATED DELETION
 * The sweep removes what is past its deadline and nothing else, so a fixture deleted *now* proves
 * only that the sweep declined to remove it. This one is stamped forty days ago - past the thirty
 * day floor in `purge_floor()` - which makes it the only eligible row in the database and turns
 * `rows_purged` into a number that means something.
 *
 * It is also this suite's cleanup, which is the one honest way to have one: the fixture is
 * removed by the mechanism the product uses to remove it, rather than by a privileged path
 * invented for tests (see `managedParity.test.ts` on why there is no such path).
 */

const MANAGED_URL = readManagedDatabaseUrl();
const runIfManaged = MANAGED_URL === null ? describe.skip : describe;

/** Distinct from the parity suite's namespace, so the two can run at the same time. */
function workerUuid(n: number): string {
  return `00000000-0000-4000-a000-${n.toString(16).padStart(12, '0')}`;
}

const OWNER = workerUuid(1);
const HOUSEHOLD = workerUuid(10);
const PROFILE = workerUuid(20);

let db: ManagedRuntimeDb;

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const realClock: Clock = { now: () => new Date().toISOString() as Instant };

/** A holder name that cannot collide with a real worker's or another test's. */
const holder = (label: string): string => `test-${label}-${randomUUID().slice(0, 8)}`;

async function withRetention<T>(fn: (conn: PurgeConnection) => Promise<T>): Promise<T> {
  return db.withRetention(fn);
}

/** Leave the lease free whatever a test did to it. */
async function freeLease(): Promise<void> {
  await withRetention((conn) =>
    conn.query(
      `UPDATE retention_lease SET holder = NULL, acquired_at = NULL, expires_at = NULL
        WHERE singleton`,
    ),
  );
}

beforeAll(async () => {
  if (MANAGED_URL === null) return;
  db = await createManagedRuntimeDb({
    connectionString: MANAGED_URL,
    applicationName: 'kynviora-worker-test',
    maxConnections: 4,
  });
  await freeLease();
});

afterAll(async () => {
  if (MANAGED_URL === null || db === undefined) return;
  await freeLease();
  await db.close();
});

runIfManaged('the lease, contended for the first time', () => {
  it('is taken by one holder and refused to the other', async () => {
    const a = holder('a');
    const b = holder('b');
    await freeLease();

    expect(await withRetention((c) => acquireRetentionLease(c, a, 60_000))).toBe(true);
    // Not an error and not a queue. A worker that cannot take the lease has nothing to do and
    // says so; DEC-121 chose a row over an advisory lock precisely so this is a value an
    // operator can read rather than a wait nobody can see.
    expect(await withRetention((c) => acquireRetentionLease(c, b, 60_000))).toBe(false);

    expect(await withRetention((c) => releaseRetentionLease(c, b))).toBe(false);
    expect(await withRetention((c) => releaseRetentionLease(c, a))).toBe(true);
    expect(await withRetention((c) => acquireRetentionLease(c, b, 60_000))).toBe(true);
    await withRetention((c) => releaseRetentionLease(c, b));
  });

  it('is taken by exactly one of twelve workers racing for it', async () => {
    // The property is atomicity of the conditional UPDATE, and it is only a property under real
    // concurrency on a real server. Twelve at once, one winner.
    await freeLease();
    const holders = Array.from({ length: 12 }, (_, i) => holder(`race${String(i)}`));
    const results = await Promise.all(
      holders.map((h) => withRetention((c) => acquireRetentionLease(c, h, 60_000))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    await freeLease();
  });

  it('becomes claimable again on its own after the holder stops existing', async () => {
    // The recovery path. A worker killed mid-sweep releases nothing, so nothing may depend on a
    // release ever happening - which is why the lease carries an expiry rather than a flag.
    const dead = holder('killed');
    const next = holder('next');
    await freeLease();

    expect(await withRetention((c) => acquireRetentionLease(c, dead, 1_000))).toBe(true);
    expect(await withRetention((c) => acquireRetentionLease(c, next, 60_000))).toBe(false);

    await withRetention((c) =>
      // Expiring the lease rather than sleeping: the behaviour under test is "an expired lease is
      // claimable", and a test that waits a real second is a test that waits a real second. Both
      // timestamps move, because `retention_lease_expiry_after_acquisition` is a real constraint
      // and a lease that expired before it was taken is not a state a worker can produce.
      c.query(
        `UPDATE retention_lease
            SET acquired_at = now() - interval '2 seconds',
                expires_at  = now() - interval '1 second'
          WHERE singleton`,
      ),
    );

    expect(await withRetention((c) => acquireRetentionLease(c, next, 60_000))).toBe(true);
    await freeLease();
  });
});

runIfManaged('a run nobody closed', () => {
  it('is reaped as ABANDONED by whoever comes next, with the counts it did write', async () => {
    const dead = holder('abandoned');
    const runId = await withRetention(async (c) => {
      const res = await c.query<{ id: string }>(
        `INSERT INTO retention_run (holder, started_at) VALUES ($1, now() - interval '1 hour')
         RETURNING id`,
        [dead],
      );
      return res.rows[0]?.id as string;
    });

    const reaped = await withRetention((c) => reapAbandonedRuns(c, 60_000));
    expect(reaped).toBeGreaterThanOrEqual(1);

    const row = await withRetention((c) =>
      c.query<{ outcome: string; duration_ms: number | null; finished_at: Date | null }>(
        'SELECT outcome, duration_ms, finished_at FROM retention_run WHERE id = $1',
        [runId],
      ),
    );
    expect(row.rows[0]?.outcome).toBe('ABANDONED');
    expect(row.rows[0]?.finished_at).not.toBeNull();
    // No duration, because nobody measured one. A reaper inventing `now() - started_at` would be
    // reporting how long the run was *open*, which is a different number wearing the same name.
    expect(row.rows[0]?.duration_ms).toBeNull();
  });
});

runIfManaged('two workers sweeping one database', () => {
  it('records one run between them, not two', async () => {
    await freeLease();
    const before = await withRetention((c) =>
      c.query<{ n: string }>('SELECT count(*) AS n FROM retention_run'),
    );
    const countBefore = Number(before.rows[0]?.n ?? '0');

    const [first, second] = await Promise.all([
      withRetention((c) =>
        executeRetentionRun(c, {
          holder: holder('w1'),
          leaseMs: 60_000,
          clock: realClock,
          logger: silentLogger,
          correlationId: randomUUID(),
        }),
      ),
      withRetention((c) =>
        executeRetentionRun(c, {
          holder: holder('w2'),
          leaseMs: 60_000,
          clock: realClock,
          logger: silentLogger,
          correlationId: randomUUID(),
        }),
      ),
    ]);

    const ran = [first, second].filter((r) => r.ran);
    const skipped = [first, second].filter((r) => !r.ran);
    expect(ran).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toEqual({ ran: false, skipped: 'LEASE_HELD' });

    const after = await withRetention((c) =>
      c.query<{ n: string }>('SELECT count(*) AS n FROM retention_run'),
    );
    // The skipped attempt writes no row. An operator counting runs per day is counting sweeps,
    // and "another worker had it" would be indistinguishable from a sweep that purged nothing.
    expect(Number(after.rows[0]?.n ?? '0')).toBe(countBefore + 1);
    await freeLease();
  });

  it('records what the sweep did, in counts and nothing else', async () => {
    const last = await withRetention((c) =>
      c.query<{
        id: string;
        outcome: string;
        duration_ms: number;
        categories_attempted: number;
        categories_failed: number;
        rows_purged: number;
      }>(
        `SELECT id, outcome, duration_ms, categories_attempted, categories_failed, rows_purged
           FROM retention_run WHERE finished_at IS NOT NULL
          ORDER BY started_at DESC, id DESC LIMIT 1`,
      ),
    );
    const run = last.rows[0];
    expect(run).toBeDefined();
    expect(run?.outcome).toBe('SUCCEEDED');
    expect(run?.categories_failed).toBe(0);
    expect(run?.categories_attempted).toBeGreaterThan(0);
    expect(run?.duration_ms).toBeGreaterThanOrEqual(0);

    const categories = await withRetention((c) =>
      c.query<{ category: string; outcome: string }>(
        'SELECT category, outcome FROM retention_run_category WHERE run_id = $1 ORDER BY category',
        [run?.id],
      ),
    );
    expect(categories.rows.length).toBe(run?.categories_attempted);
    expect(categories.rows.every((r) => r.outcome === 'SUCCEEDED')).toBe(true);
  });

  it('has never let two executed sweeps overlap, in the whole history', async () => {
    // The lease's actual claim, asked of everything that has ever run against this database
    // rather than only of the pair this file just started. That covers the two standalone
    // `npm run worker` processes as well, which is where the property matters and where nothing
    // in a test file is watching.
    //
    // `ABANDONED` runs are excluded and the exclusion is not a convenience: a reaped run's
    // `finished_at` is when somebody *noticed* it was dead, not when it stopped, so its recorded
    // span deliberately overstates - and this suite's own fixture inserts one an hour wide.
    const overlaps = await withRetention((c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM retention_run a
           JOIN retention_run b
             ON a.id < b.id
            AND a.started_at < b.finished_at
            AND b.started_at < a.finished_at
          WHERE a.outcome IN ('SUCCEEDED','PARTIAL','FAILED')
            AND b.outcome IN ('SUCCEEDED','PARTIAL','FAILED')`,
      ),
    );
    expect(overlaps.rows[0]?.n).toBe(0);
  });

  it('has been swept by more than one holder', async () => {
    // The control the check above needs. "No two runs overlapped" is trivially true of a history
    // written by one worker, which is every history this project had before a managed database
    // existed.
    const holders = await withRetention((c) =>
      c.query<{ n: number }>(
        `SELECT count(DISTINCT holder)::int AS n FROM retention_run
          WHERE outcome IN ('SUCCEEDED','PARTIAL','FAILED')`,
      ),
    );
    expect(holders.rows[0]?.n).toBeGreaterThan(1);
  });
});

runIfManaged('the schedule the database keeps', () => {
  it('reads the last run rather than remembering one', async () => {
    const last = await withRetention((c) => readLastRetentionRun(c));
    expect(last).not.toBeNull();
    expect(last?.outcome).toBe('SUCCEEDED');
    // Parsed rather than passed through: `pg` hands back a Date and PGlite hands back a Date too,
    // but the reader accepts either and must produce an instant a comparison can use.
    expect(Number.isNaN(Date.parse(last?.startedAt ?? ''))).toBe(false);
  });

  /**
   * The history cannot be rewritten, which is the schema working and cost this test a rewrite.
   *
   * The obvious way to reach "the last sweep was three hours ago" is to backdate the run rows, and
   * `0026` refuses: `retention_run_close` admits only `USING (finished_at IS NULL)`, so a finished
   * run cannot be re-dated, re-outcomed or quietly recounted, and there is no DELETE policy at
   * all. A worker cannot write history for a sweep it did not perform when it claims to have
   * performed it - which is the property that makes the schedule trustworthy in the first place.
   *
   * So the interval moves instead of the clock. "Overdue" is `elapsed > interval`, and both tests
   * below reach it from the same real history by asking for a different interval - which is the
   * same arithmetic the loop does and needs nothing fabricated.
   *
   * Sleeping is injected in both, so a wait is **recorded rather than taken**: a loop that decided
   * to wait an hour would otherwise be indistinguishable from one still working, and the test
   * would hang rather than say what went wrong. That is exactly how the first version of this
   * failed.
   */
  async function onePass(intervalMs: number): Promise<{ slept: number[]; lastStartedAt: number }> {
    await freeLease();
    const slept: number[] = [];
    const loop = startRetentionLoop({
      db,
      config: { ...DEFAULT_RETENTION_WORKER_CONFIG, intervalMs, retryIntervalMs: 1_000 },
      clock: realClock,
      logger: silentLogger,
      ids: { next: () => randomUUID() },
      maxPasses: 1,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    // `done`, not `stop`. `stop` aborts first and awaits second, and the abort can land before the
    // loop's first iteration has checked the signal - which cancels the pass instead of waiting
    // for it, and would measure how fast a loop can decline to start.
    await loop.done;
    await loop.stop();
    const last = await withRetention((c) => readLastRetentionRun(c));
    await freeLease();
    return { slept, lastStartedAt: Date.parse(last?.startedAt ?? '') };
  }

  // A whole pass over a network: seven categories, each its own transaction, plus the digest
  // assembly that shares the pass. Thirty seconds is the suite default and is a local-database
  // number; this is round trips to another continent.
  it('sweeps at once when the history says a sweep is overdue', { timeout: 180_000 }, async () => {
    const startedAt = Date.now();
    const { slept, lastStartedAt } = await onePass(1_000);

    // Not one millisecond of waiting. A worker that scheduled from its own uptime would sleep the
    // interval before its first sweep however old the history was, so an empty list is what
    // separates the two - and it is why this asserts `[]` rather than "something small".
    expect(slept).toEqual([]);
    expect(lastStartedAt).toBeGreaterThan(startedAt - 5_000);
  });

  it(
    'waits instead when the history says one has just happened',
    { timeout: 180_000 },
    async () => {
      // The other half, on the same history seconds later. Without it, a worker that swept on every
      // pass forever would pass the test above.
      const sweptAt = Date.now();
      const { slept, lastStartedAt } = await onePass(3_600_000);

      expect(slept).toHaveLength(1);
      // Close to a full interval, because the run it is counting from is seconds old.
      expect(slept[0]).toBeGreaterThan(3_500_000);
      // And no new run: the pass slept and returned.
      expect(lastStartedAt).toBeLessThan(sweptAt);
    },
  );
});

runIfManaged('a purge that actually removes something', () => {
  it('removes an item deleted past its deadline and counts it', async () => {
    const item = workerUuid(30);

    await db.withService(async (conn) => {
      await conn.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, 'worker-owner@example.test', now()) ON CONFLICT (id) DO NOTHING`,
        [OWNER, `auth|${OWNER}`],
      );
      await conn.query(
        `INSERT INTO household (id, owner_user_id, display_name)
         VALUES ($1, $2, 'Worker household') ON CONFLICT (id) DO NOTHING`,
        [HOUSEHOLD, OWNER],
      );
      await conn.query(
        `INSERT INTO profile (id, household_id, owner_user_id, display_name)
         VALUES ($1, $2, $3, 'Worker parent (synthetic)') ON CONFLICT (id) DO NOTHING`,
        [PROFILE, HOUSEHOLD, OWNER],
      );
      await conn.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
         VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet (to be purged)',
                 now() - interval '40 days')
         ON CONFLICT (id) DO UPDATE SET deleted_at = now() - interval '40 days'`,
        [item, PROFILE],
      );
    });

    // Visible to the sweep precisely because it is past the floor - the same row would be
    // invisible to this role on the day it was deleted.
    const eligible = await withRetention((c) =>
      c.query('SELECT id FROM owned_item WHERE id = $1', [item]),
    );
    expect(eligible.rows).toHaveLength(1);

    await freeLease();
    const result = await withRetention((c) =>
      executeRetentionRun(c, {
        holder: holder('purge'),
        leaseMs: 60_000,
        clock: realClock,
        logger: silentLogger,
        correlationId: randomUUID(),
      }),
    );

    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.outcome).toBe('SUCCEEDED');
      expect(result.rowsPurged).toBeGreaterThanOrEqual(1);
    }

    // Gone from the owner's view because it is gone, not because a policy hides it.
    const remains = await db.withUser(OWNER, (conn) =>
      conn.query('SELECT id FROM owned_item WHERE id = $1', [item]),
    );
    expect(remains.rows).toHaveLength(0);
    await freeLease();
  });

  it('purges nothing on the very next sweep', async () => {
    // Idempotence, and the reason the previous test's count is trustworthy: a sweep that reported
    // rows purged and then reported them again would be counting matches rather than deletions.
    await freeLease();
    const result = await withRetention((c) =>
      executeRetentionRun(c, {
        holder: holder('again'),
        leaseMs: 60_000,
        clock: realClock,
        logger: silentLogger,
        correlationId: randomUUID(),
      }),
    );
    expect(result.ran).toBe(true);
    if (result.ran) expect(result.rowsPurged).toBe(0);
    await freeLease();
  });
});
