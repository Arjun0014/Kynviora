import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import type { PurgeConnection } from '@kynviora/db';
import { sequentialIdGenerator, systemClock, type LogFields, type Logger } from '@kynviora/domain';
import { startRetentionLoop, timerSleep, type RetentionDb, type Sleep } from './loop.js';
import type { RetentionWorkerConfig } from './config.js';

/**
 * The loop, against a real database.
 *
 * Spec references: `16` (retention deadlines), `20` (a job's schedule is observable), DEC-121.
 *
 * WHAT IS FAKED AND WHY ONLY THAT
 * Sleeping. Everything else - the role, the policies, the lease, the run history, the sweep - is
 * real, because the questions this file asks are about how the loop behaves against real answers.
 * A fake database would let the loop's decisions be tested against whatever the fake believed,
 * and the two most important behaviours here are reactions to states a fake would have to invent:
 * a lease somebody else holds, and a schedule that cannot be read.
 *
 * THE ONE THAT WOULD BE EASY TO GET WRONG
 * Not spinning. Three things leave a sweep un-run with the clock still saying "due now", and each
 * of them is a `while` loop over a condition nothing inside the loop can change. A worker that
 * spins is not obviously broken - it works, it just burns a core and fills a log - so it gets an
 * explicit test rather than a comment.
 */

const OWNER = testUuid(1);
const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const DUE_ITEM = testUuid(30);

const CONFIG: RetentionWorkerConfig = {
  intervalMs: 3_600_000,
  retryIntervalMs: 300_000,
  leaseMs: 900_000,
};

let t: TestDb;

interface Recorded {
  readonly code: string;
  readonly fields: LogFields;
}

function recordingLogger(): { logger: Logger; records: Recorded[] } {
  const records: Recorded[] = [];
  const emit =
    () =>
    (code: string, fields?: LogFields): void => {
      records.push({ code, fields: fields ?? {} });
    };
  return { records, logger: { debug: emit(), info: emit(), warn: emit(), error: emit() } };
}

function dbFor(handle: TestDb): RetentionDb {
  return {
    withRetention: (fn) => handle.asRetention((db) => fn(db as unknown as PurgeConnection)),
    withService: (fn) => handle.asService((db) => fn(db as unknown as PurgeConnection)),
    withUser: (userId, fn) => handle.asUser(userId, (db) => fn(db as unknown as PurgeConnection)),
  };
}

/** A sleep that records how long it was asked for and returns at once. */
function recordingSleep(): { sleep: Sleep; slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

async function countOf(table: string, where = 'true'): Promise<number> {
  const res = await t.asOwner((db) =>
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`),
  );
  return res.rows[0]?.n ?? 0;
}

beforeEach(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    await db.query(
      `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
       VALUES ($1, $2, 'owner@example.test', now())`,
      [OWNER, `auth|${OWNER}`],
    );
    await db.query(`INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'A')`, [
      HOUSEHOLD,
      OWNER,
    ]);
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Person')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );
  });

  await t.asOwner((db) =>
    db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
       VALUES ($1, $2, 'MEDICINE', 'Due Tablet', now() - interval '31 days')`,
      [DUE_ITEM, PROFILE],
    ),
  );
});

afterEach(async () => {
  await t?.close();
});

function loopWith(sleep: Sleep, logger: Logger, maxPasses: number) {
  return startRetentionLoop({
    db: dbFor(t),
    config: CONFIG,
    clock: systemClock(),
    logger,
    ids: sequentialIdGenerator(),
    sleep,
    maxPasses,
  });
}

describe('a loop with nothing in its history', () => {
  it('sweeps on its first pass rather than waiting an interval', async () => {
    const { sleep, slept } = recordingSleep();
    const { logger, records } = recordingLogger();

    await loopWith(sleep, logger, 1).done;

    expect(slept).toEqual([]);
    expect(await countOf('retention_run', `outcome = 'SUCCEEDED'`)).toBe(1);
    // The item that was thirty-one days deleted is gone, which is the whole reason the loop exists.
    expect(await countOf('owned_item')).toBe(0);
    expect(records.map((r) => r.code)).toEqual(
      expect.arrayContaining(['retention.loop.started', 'retention.run.finished']),
    );
  });

  it('waits out the interval on the pass after a successful sweep', async () => {
    const { sleep, slept } = recordingSleep();
    const { logger } = recordingLogger();

    await loopWith(sleep, logger, 2).done;

    // One sweep, then a wait of very nearly the whole interval - measured from the run's own
    // timestamp in the database, not from when this process started.
    expect(await countOf('retention_run')).toBe(1);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(CONFIG.intervalMs - 60_000);
    expect(slept[0]).toBeLessThanOrEqual(CONFIG.intervalMs);
  });

  it('picks the schedule up from the database rather than from its own uptime', async () => {
    const { logger } = recordingLogger();

    // One loop sweeps and exits, as a deployment being replaced would.
    await loopWith(recordingSleep().sleep, logger, 1).done;

    // A second loop - a new process, a new holder, no memory - must not sweep again.
    const second = recordingSleep();
    await loopWith(second.sleep, logger, 1).done;

    expect(await countOf('retention_run')).toBe(1);
    expect(second.slept).toHaveLength(1);
    expect(second.slept[0]).toBeGreaterThan(CONFIG.intervalMs - 60_000);
  });
});

describe('a loop whose lease is held by another worker', () => {
  it('waits the retry interval each pass instead of spinning', async () => {
    await t.asRetention((db) =>
      db.query(
        `UPDATE retention_lease
            SET holder = 'somebody-else', acquired_at = now(),
                expires_at = now() + interval '1 hour'`,
      ),
    );

    const { sleep, slept } = recordingSleep();
    const { logger, records } = recordingLogger();

    await loopWith(sleep, logger, 3).done;

    // Three passes, three waits. Without the wait after a skipped attempt, the schedule would
    // still read "due now" on the next pass and this would be a busy loop.
    expect(slept).toEqual([CONFIG.retryIntervalMs, CONFIG.retryIntervalMs, CONFIG.retryIntervalMs]);
    expect(await countOf('retention_run')).toBe(0);
    expect(await countOf('owned_item')).toBe(1);
    expect(records.filter((r) => r.code === 'retention.run.skipped')).toHaveLength(3);
  });
});

describe('a loop that cannot read its own schedule', () => {
  it('retries rather than sweeping blind', async () => {
    // The database is there and the role cannot read run history: a half-applied migration, or a
    // grant somebody removed. Sweeping anyway would fail in every category and fill the history
    // with the consequences of a problem that is not retention's.
    await t.asOwner((db) => db.query(`REVOKE SELECT ON retention_run FROM kynviora_retention`));

    const { sleep, slept } = recordingSleep();
    const { logger, records } = recordingLogger();

    await loopWith(sleep, logger, 2).done;

    expect(slept).toEqual([CONFIG.retryIntervalMs, CONFIG.retryIntervalMs]);
    expect(await countOf('owned_item')).toBe(1);

    const failure = records.find((r) => r.code === 'retention.loop.schedule_unreadable');
    expect(failure).toBeDefined();
    expect(failure?.fields.sqlstate).toBe('42501');

    await t.asOwner((db) => db.query(`GRANT SELECT ON retention_run TO kynviora_retention`));
  });
});

describe('stopping a loop', () => {
  it('interrupts the sleep rather than waiting it out', async () => {
    const { logger, records } = recordingLogger();
    // The real sleep. The second pass asks for an hour; `stop` has to make that not be an hour.
    const loop = startRetentionLoop({
      db: dbFor(t),
      config: CONFIG,
      clock: systemClock(),
      logger,
      ids: sequentialIdGenerator(),
    });

    await loop.stop();

    expect(records.map((r) => r.code)).toContain('retention.loop.stopped');
    // Whatever it managed before being stopped, it did not leave the lease behind: a lease held
    // by a process that has exited blocks every sweep until it expires.
    const held = await t.asRetention((db) =>
      db.query<{ holder: string | null }>(`SELECT holder FROM retention_lease`),
    );
    expect(held.rows[0]?.holder).toBeNull();
  });

  it('is safe to stop twice', async () => {
    const { logger } = recordingLogger();
    const loop = loopWith(recordingSleep().sleep, logger, 1);
    await loop.stop();
    await expect(loop.stop()).resolves.toBeUndefined();
  });
});

describe('the sleep the loop uses in production', () => {
  it('returns early when the signal aborts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = timerSleep(60_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(timerSleep(60_000, controller.signal)).resolves.toBeUndefined();
  });
});
