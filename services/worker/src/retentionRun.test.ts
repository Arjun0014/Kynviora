import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { PURGE_CATEGORIES, type PurgeConnection } from '@kynviora/db';
import { systemClock, type LogFields, type Logger } from '@kynviora/domain';
import {
  acquireRetentionLease,
  executeRetentionRun,
  readLastRetentionRun,
  reapAbandonedRuns,
  releaseRetentionLease,
  retentionRunOutcome,
  sqlstateOf,
  type RetentionCategoryOutcome,
  type RetentionRunDeps,
} from './retentionRun.js';

/**
 * A retention run, against the real policies as the real role.
 *
 * Spec references: `16` (retention deadlines), `14` (least privilege, deny by default), `20`
 * (a job reports what it did, without content), DEC-121, migrations `0022`, `0023` and `0026`.
 *
 * THE THREE CLAIMS THIS FILE IS FOR
 *  1. **Two workers cannot sweep at once**, and the one that loses says so rather than pretending
 *     to have swept.
 *  2. **A failure in one category is not the whole run's**, and - the assertion this file exists
 *     for - **is not recorded as a success**. Everything else here is scaffolding for that one.
 *  3. **Nothing a person wrote reaches the run history or the log.** A retention job is the last
 *     place a deleted medicine could come back, because its output outlives the record.
 *
 * WHY THE FAILURE IS INJECTED BY REVOKING A GRANT
 * Because it is a failure the database can actually have. A stubbed connection that throws would
 * measure the `try` block; revoking `DELETE ON consent_receipt` produces a genuine `42501` from a
 * genuine statement, through the same transaction handling a real outage would go through.
 */

const OWNER = testUuid(1);
const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

/** Deleted 31 days ago: due. */
const DUE_ITEM = testUuid(30);
/** Never deleted. It has to survive every sweep in this file. */
const LIVE_ITEM = testUuid(32);
/** Created for the isolation test, so it has something to purge. */
const SECOND_DUE_ITEM = testUuid(33);

const HOLDER = 'holder-a';
const OTHER_HOLDER = 'holder-b';

let t: TestDb;

interface Recorded {
  readonly level: string;
  readonly code: string;
  readonly fields: LogFields;
}

function recordingLogger(): { logger: Logger; records: Recorded[] } {
  const records: Recorded[] = [];
  const emit =
    (level: string) =>
    (code: string, fields?: LogFields): void => {
      records.push({ level, code, fields: fields ?? {} });
    };
  return {
    records,
    logger: { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') },
  };
}

function depsFor(holder: string, logger: Logger, leaseMs = 900_000): RetentionRunDeps {
  return { holder, leaseMs, clock: systemClock(), logger, correlationId: `corr-${holder}` };
}

/** A run, as the retention role - which is the only way it can happen. */
function runAs(holder: string, logger: Logger, leaseMs?: number) {
  return t.asRetention((db) =>
    executeRetentionRun(
      db as unknown as PurgeConnection,
      depsFor(holder, logger, leaseMs ?? 900_000),
    ),
  );
}

async function countOf(table: string, where = 'true'): Promise<number> {
  const res = await t.asOwner((db) =>
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`),
  );
  return res.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    await db.query(
      `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
       VALUES ($1, $2, $3, now())`,
      [OWNER, `auth|${OWNER}`, 'owner@example.test'],
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

  // Fixtures as the owner: several need timestamps in the past, which no route can write.
  await t.asOwner(async (db) => {
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
       VALUES ($1, $2, 'MEDICINE', 'Amoxicillin 500mg', now() - interval '31 days'),
              ($3, $2, 'MEDICINE', 'Live Tablet', NULL)`,
      [DUE_ITEM, PROFILE, LIVE_ITEM],
    );

    for (const item of [DUE_ITEM, LIVE_ITEM]) {
      await db.query(
        `INSERT INTO dose_event (owned_item_id, event_kind, recorded_at, client_operation_id)
         VALUES ($1, 'TAKEN', now(), gen_random_uuid())`,
        [item],
      );
      await db.query(
        `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, timezone, times_local)
         VALUES ($1, 'FIXED_TIMES', 'Asia/Kolkata', ARRAY['08:00'])`,
        [item],
      );
    }

    // The two retained tables, one old enough and one not.
    await db.query(
      `INSERT INTO audit_event (occurred_at, actor_user_id, actor_role, action, target_kind)
       VALUES (now() - interval '25 months', $1, 'user', 'item.deleted', 'owned_item'),
              (now() - interval '1 month', $1, 'user', 'item.deleted', 'owned_item')`,
      [OWNER],
    );
    await db.query(
      `INSERT INTO consent_receipt (user_id, purpose, granted, policy_version, recorded_at)
       VALUES ($1, 'PROFILE_DATA', true, 'v1', now() - interval '25 months'),
              ($1, 'NOTIFICATIONS', true, 'v1', now() - interval '1 month')`,
      [OWNER],
    );
  });
});

afterAll(async () => {
  await t?.close();
});

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

describe('the lease', () => {
  it('is free before anybody takes it', async () => {
    const held = await t.asRetention((db) =>
      db.query<{ holder: string | null }>(`SELECT holder FROM retention_lease`),
    );
    expect(held.rows[0]?.holder).toBeNull();
  });

  it('admits one holder and refuses a second', async () => {
    await t.asRetention(async (db) => {
      const conn = db as unknown as PurgeConnection;
      expect(await acquireRetentionLease(conn, HOLDER, 900_000)).toBe(true);
      // The whole point. A second worker asking the same question gets a different answer.
      expect(await acquireRetentionLease(conn, OTHER_HOLDER, 900_000)).toBe(false);
    });
  });

  it('is released only by the holder that took it', async () => {
    await t.asRetention(async (db) => {
      const conn = db as unknown as PurgeConnection;
      expect(await releaseRetentionLease(conn, OTHER_HOLDER)).toBe(false);
      expect(await releaseRetentionLease(conn, HOLDER)).toBe(true);
    });
  });

  it('can be taken again once it has expired, which is how a killed worker recovers', async () => {
    await t.asRetention(async (db) => {
      const conn = db as unknown as PurgeConnection;
      // A worker that died holding it. Nothing released this.
      await db.query(
        `UPDATE retention_lease
            SET holder = $1, acquired_at = now() - interval '2 hours',
                expires_at = now() - interval '1 hour'`,
        [OTHER_HOLDER],
      );
      expect(await acquireRetentionLease(conn, HOLDER, 900_000)).toBe(true);
      expect(await releaseRetentionLease(conn, HOLDER)).toBe(true);
    });
  });
});

describe('a run whose lease is held elsewhere', () => {
  it('does not sweep, does not record a run, and says which it was', async () => {
    const { logger, records } = recordingLogger();

    await t.asRetention(async (db) => {
      await db.query(
        `UPDATE retention_lease
            SET holder = $1, acquired_at = now(), expires_at = now() + interval '1 hour'`,
        [OTHER_HOLDER],
      );
    });

    const before = await countOf('owned_item');
    const result = await runAs(HOLDER, logger);

    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.skipped).toBe('LEASE_HELD');

    // Nothing purged, and - just as important - no run row. An operator counting runs per day is
    // counting sweeps, and a row here would be indistinguishable from a sweep that found nothing.
    expect(await countOf('owned_item')).toBe(before);
    expect(await countOf('retention_run')).toBe(0);

    expect(records.map((r) => r.code)).toContain('retention.run.skipped');

    // And it did not steal the lease it could not take.
    const held = await t.asRetention((db) =>
      db.query<{ holder: string }>(`SELECT holder FROM retention_lease`),
    );
    expect(held.rows[0]?.holder).toBe(OTHER_HOLDER);

    await t.asRetention((db) =>
      releaseRetentionLease(db as unknown as PurgeConnection, OTHER_HOLDER),
    );
  });
});

// ---------------------------------------------------------------------------
// A run that works
// ---------------------------------------------------------------------------

describe('a successful run', () => {
  it('purges what is due, leaves what is not, and records both facts', async () => {
    const { logger, records } = recordingLogger();
    const result = await runAs(HOLDER, logger);

    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');

    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.categories).toHaveLength(PURGE_CATEGORIES.length);
    expect(result.categories.every((c) => c.outcome === 'SUCCEEDED')).toBe(true);

    // The item that was deleted thirty-one days ago is gone; the live one is untouched.
    expect(await countOf('owned_item')).toBe(1);
    expect(await countOf('owned_item', `id = '${LIVE_ITEM}'`)).toBe(1);
    expect(await countOf('dose_event')).toBe(1);

    // The two retained tables lost their 25-month rows and kept their 1-month rows.
    expect(await countOf('audit_event')).toBe(1);
    expect(await countOf('consent_receipt')).toBe(1);

    expect(records.map((r) => r.code)).toEqual(
      expect.arrayContaining(['retention.run.started', 'retention.run.finished']),
    );
  });

  it('closes the run row with an outcome, a duration and counts that match the categories', async () => {
    const run = await t.asRetention((db) =>
      db.query<{
        outcome: string;
        duration_ms: number;
        categories_attempted: number;
        categories_failed: number;
        rows_purged: number;
        finished_at: Date | null;
      }>(
        `SELECT outcome, duration_ms, categories_attempted, categories_failed, rows_purged,
                finished_at
           FROM retention_run ORDER BY started_at DESC LIMIT 1`,
      ),
    );
    const row = run.rows[0];
    expect(row).toBeDefined();
    expect(row?.outcome).toBe('SUCCEEDED');
    expect(row?.finished_at).not.toBeNull();
    expect(row?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row?.categories_attempted).toBe(PURGE_CATEGORIES.length);
    expect(row?.categories_failed).toBe(0);
    // Derived in SQL from the category rows, so this is a check that the two agree rather than a
    // restatement of one of them.
    expect(row?.rows_purged).toBeGreaterThan(0);
  });

  it('writes one category row per category, each naming what it did', async () => {
    const rows = await t.asRetention((db) =>
      db.query<{ category: string; outcome: string; rows_purged: number; duration_ms: number }>(
        `SELECT c.category, c.outcome, c.rows_purged, c.duration_ms
           FROM retention_run_category c
           JOIN retention_run r ON r.id = c.run_id
          ORDER BY r.started_at DESC, c.category`,
      ),
    );
    expect(new Set(rows.rows.map((r) => r.category))).toEqual(
      new Set(PURGE_CATEGORIES.map((c) => c.category)),
    );
    expect(rows.rows.every((r) => r.duration_ms >= 0)).toBe(true);
    expect(rows.rows.find((r) => r.category === 'ITEM')?.rows_purged).toBeGreaterThan(0);
  });

  it('gives the lease back, so the next run can take it', async () => {
    const held = await t.asRetention((db) =>
      db.query<{ holder: string | null }>(`SELECT holder FROM retention_lease`),
    );
    expect(held.rows[0]?.holder).toBeNull();
  });

  it('is the run the schedule reads back', async () => {
    const last = await t.asRetention((db) =>
      readLastRetentionRun(db as unknown as PurgeConnection),
    );
    expect(last?.outcome).toBe('SUCCEEDED');
    expect(Date.parse(last?.startedAt ?? '')).not.toBeNaN();
  });
});

describe('a second run immediately afterwards', () => {
  it('purges nothing and still succeeds, because a sweep nobody can repeat is unschedulable', async () => {
    const { logger } = recordingLogger();
    const result = await runAs(HOLDER, logger);

    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error('unreachable');
    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.rowsPurged).toBe(0);
    expect(await countOf('owned_item')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// One category failing
// ---------------------------------------------------------------------------

describe('a run in which one category fails', () => {
  let outcomes: readonly RetentionCategoryOutcome[] = [];
  let records: Recorded[] = [];

  beforeAll(async () => {
    // Something for the surviving categories to actually purge, so "the others still ran" is a
    // claim about work rather than about zeroes.
    await t.asOwner(async (db) => {
      await db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
         VALUES ($1, $2, 'MEDICINE', 'Ibuprofen 200mg', now() - interval '31 days')`,
        [SECOND_DUE_ITEM, PROFILE],
      );
      await db.query(
        `INSERT INTO consent_receipt (user_id, purpose, granted, policy_version, recorded_at)
         VALUES ($1, 'PROFILE_DATA', false, 'v1', now() - interval '30 months')`,
        [OWNER],
      );
      // The injected outage: the retention role loses its way through the append-only door on one
      // table and keeps everything else.
      await db.query(`REVOKE DELETE ON consent_receipt FROM kynviora_retention`);
    });

    const recorder = recordingLogger();
    records = recorder.records;
    const result = await runAs(HOLDER, recorder.logger);
    if (!result.ran) throw new Error('the run was skipped, which this test cannot interpret');
    outcomes = result.categories;

    await t.asOwner((db) => db.query(`GRANT DELETE ON consent_receipt TO kynviora_retention`));
  });

  it('records the run as PARTIAL, which is not SUCCEEDED', async () => {
    // The assertion this whole file is for. A run that skipped a table has not kept the deadline
    // for it, and a green dashboard over one is how a table stops being purged for a year.
    const row = await t.asRetention((db) =>
      db.query<{ outcome: string; categories_attempted: number; categories_failed: number }>(
        `SELECT outcome, categories_attempted, categories_failed
           FROM retention_run ORDER BY started_at DESC LIMIT 1`,
      ),
    );
    expect(row.rows[0]?.outcome).toBe('PARTIAL');
    expect(row.rows[0]?.outcome).not.toBe('SUCCEEDED');
    expect(row.rows[0]?.categories_attempted).toBe(PURGE_CATEGORIES.length);
    expect(row.rows[0]?.categories_failed).toBe(1);
  });

  it('attempts every category, not just the ones before the failure', () => {
    expect(outcomes).toHaveLength(PURGE_CATEGORIES.length);
    // CONSENT_RECEIPT is last in the plan, so this also proves the run did not stop at it - but
    // the claim that matters is that the count is complete either way.
    expect(outcomes.filter((c) => c.outcome === 'FAILED').map((c) => c.category)).toEqual([
      'CONSENT_RECEIPT',
    ]);
  });

  it('lets the other categories purge what was due', async () => {
    // The second due item went, despite a different category raising.
    expect(await countOf('owned_item', `id = '${SECOND_DUE_ITEM}'`)).toBe(0);
    expect(outcomes.find((c) => c.category === 'ITEM')?.rowsPurged).toBeGreaterThan(0);
  });

  it('names the step and a SQLSTATE, and nothing a driver wrote', async () => {
    const row = await t.asRetention((db) =>
      db.query<{ failure_step: string; failure_sqlstate: string; rows_purged: number }>(
        `SELECT c.failure_step, c.failure_sqlstate, c.rows_purged
           FROM retention_run_category c
           JOIN retention_run r ON r.id = c.run_id
          WHERE c.category = 'CONSENT_RECEIPT' AND c.outcome = 'FAILED'
          ORDER BY r.started_at DESC LIMIT 1`,
      ),
    );
    expect(row.rows[0]?.failure_step).toBe('consent_receipt');
    // 42501: insufficient privilege. Five characters, from the closed alphabet the column checks.
    expect(row.rows[0]?.failure_sqlstate).toBe('42501');
    // The transaction rolled back, so the count is zero rather than "however far it got".
    expect(row.rows[0]?.rows_purged).toBe(0);
  });

  it('logs the failure with the same two fields and no message', () => {
    const failure = records.find((r) => r.code === 'retention.category.failed');
    expect(failure?.level).toBe('error');
    expect(failure?.fields).toEqual({
      correlation_id: `corr-${HOLDER}`,
      category: 'CONSENT_RECEIPT',
      step: 'consent_receipt',
      sqlstate: '42501',
    });
  });

  it('gives the lease back even though it failed', async () => {
    const held = await t.asRetention((db) =>
      db.query<{ holder: string | null }>(`SELECT holder FROM retention_lease`),
    );
    expect(held.rows[0]?.holder).toBeNull();
  });

  it('left the row it could not purge exactly where it was', async () => {
    // A rolled-back category purges nothing. The 30-month receipt is still there and is still due,
    // which is what makes the next run a retry rather than a loss.
    expect(await countOf('consent_receipt', `recorded_at <= now() - interval '24 months'`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A worker that died
// ---------------------------------------------------------------------------

describe('a run left open by a worker that died', () => {
  it('is recorded as ABANDONED once no lease could still cover it', async () => {
    const ghostId = await t.asRetention(async (db) => {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO retention_run (holder, started_at)
         VALUES ('ghost', now() - interval '2 hours') RETURNING id`,
      );
      return inserted.rows[0]?.id ?? '';
    });

    const closed = await t.asRetention((db) =>
      reapAbandonedRuns(db as unknown as PurgeConnection, 900_000),
    );
    expect(closed).toBe(1);

    const row = await t.asRetention((db) =>
      db.query<{ outcome: string; duration_ms: number | null }>(
        `SELECT outcome, duration_ms FROM retention_run WHERE id = $1`,
        [ghostId],
      ),
    );
    expect(row.rows[0]?.outcome).toBe('ABANDONED');
    // No duration, because nobody measured one. An invented number here would be the length of
    // time the row sat open, which is a different quantity wearing the same name.
    expect(row.rows[0]?.duration_ms).toBeNull();
  });

  it('leaves a run that is merely recent alone', async () => {
    await t.asRetention((db) =>
      db.query(`INSERT INTO retention_run (holder, started_at) VALUES ('busy', now())`),
    );
    expect(
      await t.asRetention((db) => reapAbandonedRuns(db as unknown as PurgeConnection, 900_000)),
    ).toBe(0);
    expect(await countOf('retention_run', `holder = 'busy' AND finished_at IS NULL`)).toBe(1);
  });

  it('is closed by the next run before it takes the lease', async () => {
    const { logger, records } = recordingLogger();
    // The 'busy' row above, aged past any lease it could have been covered by.
    await t.asOwner((db) =>
      db.query(
        `UPDATE retention_run SET started_at = now() - interval '2 hours'
          WHERE holder = 'busy' AND finished_at IS NULL`,
      ),
    );

    const result = await runAs(HOLDER, logger);
    expect(result.ran).toBe(true);
    expect(await countOf('retention_run', `holder = 'busy' AND outcome = 'ABANDONED'`)).toBe(1);
    expect(records.map((r) => r.code)).toContain('retention.run.abandoned');
  });
});

// ---------------------------------------------------------------------------
// What history may say, and who may say it
// ---------------------------------------------------------------------------

describe('the run history', () => {
  it('contains nothing anybody wrote about a medicine', async () => {
    // Two medicines were purged over this file, both with real-looking names. If either appears
    // anywhere in the history, a deleted record has come back into a table that outlives it.
    const dump = await t.asOwner((db) =>
      db.query<{ blob: string }>(
        `SELECT coalesce(string_agg(t::text, ' '), '') AS blob FROM (
           SELECT r.* FROM retention_run r
         ) t`,
      ),
    );
    const categories = await t.asOwner((db) =>
      db.query<{ blob: string }>(
        `SELECT coalesce(string_agg(t::text, ' '), '') AS blob FROM (
           SELECT c.* FROM retention_run_category c
         ) t`,
      ),
    );
    const all = `${dump.rows[0]?.blob ?? ''} ${categories.rows[0]?.blob ?? ''}`;
    for (const forbidden of ['Amoxicillin', 'Ibuprofen', 'Live Tablet', OWNER, PROFILE]) {
      expect(all).not.toContain(forbidden);
    }
  });

  it('cannot be rewritten once a run is closed', async () => {
    // Not an error - a **miss**. The UPDATE policy admits only an open row, so a closed run is
    // invisible to the statement and Postgres reports zero rows changed rather than a refusal
    // (the distinction the harness's own docstring makes). Asserting on the error would pass over
    // a policy that had been dropped entirely, so this asserts on the row instead.
    const changed = await t.asRetention((db) =>
      db.query(
        `UPDATE retention_run SET finished_at = now(), outcome = 'SUCCEEDED', duration_ms = 0
          WHERE outcome = 'PARTIAL'`,
      ),
    );
    expect(changed.affectedRows).toBe(0);
    expect(await countOf('retention_run', `outcome = 'PARTIAL'`)).toBe(1);
    expect(await countOf('retention_run', `outcome = 'SUCCEEDED'`)).toBe(3);
  });

  it('cannot be closed twice, so a run has one recorded ending', async () => {
    // The same protection from the other side: an open run accepts exactly one close. This one is
    // the row the reaper left as ABANDONED, and re-closing it would rewrite that judgement.
    const changed = await t.asRetention((db) =>
      db.query(
        `UPDATE retention_run SET finished_at = now(), outcome = 'FAILED', duration_ms = 1
          WHERE outcome = 'ABANDONED'`,
      ),
    );
    expect(changed.affectedRows).toBe(0);
    expect(await countOf('retention_run', `outcome = 'ABANDONED'`)).toBe(2);
  });

  it('keeps its category rows immutable, because there is no grant to change them', async () => {
    expect(
      await expectDenied(() =>
        t.asRetention((db) => db.query(`UPDATE retention_run_category SET outcome = 'SUCCEEDED'`)),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await expectDenied(() =>
        t.asRetention((db) => db.query(`DELETE FROM retention_run_category`)),
      ),
    ).toMatch(/permission denied/i);
  });

  it('is not readable or writable by the app or service role', async () => {
    // Deny by default (`14`). Neither role has a grant, so neither can look at any of the three.
    for (const table of ['retention_lease', 'retention_run', 'retention_run_category']) {
      expect(
        await expectDenied(() => t.asUser(OWNER, (db) => db.query(`SELECT * FROM ${table}`))),
      ).toMatch(/permission denied/i);
      expect(
        await expectDenied(() => t.asService((db) => db.query(`SELECT * FROM ${table}`))),
      ).toMatch(/permission denied/i);
    }
  });

  it('refuses a run dated in the future, which would push the schedule out', async () => {
    expect(
      await expectDenied(() =>
        t.asRetention((db) =>
          db.query(
            `INSERT INTO retention_run (holder, started_at) VALUES ('liar', now() + interval '1 day')`,
          ),
        ),
      ),
    ).toMatch(/row-level security/i);
  });
});

// ---------------------------------------------------------------------------
// The two pure decisions
// ---------------------------------------------------------------------------

function outcome(category: string, failed: boolean): RetentionCategoryOutcome {
  return {
    category: category as RetentionCategoryOutcome['category'],
    outcome: failed ? 'FAILED' : 'SUCCEEDED',
    rowsPurged: 0,
    durationMs: 0,
    failureStep: failed ? 'x' : null,
    failureSqlstate: failed ? '42501' : null,
  };
}

describe('what a set of category outcomes means', () => {
  it('is SUCCEEDED only when none failed', () => {
    expect(retentionRunOutcome([outcome('ITEM', false), outcome('PROFILE', false)])).toBe(
      'SUCCEEDED',
    );
  });

  it('is PARTIAL when some failed', () => {
    expect(retentionRunOutcome([outcome('ITEM', true), outcome('PROFILE', false)])).toBe('PARTIAL');
  });

  it('is FAILED only when every one of them did', () => {
    expect(retentionRunOutcome([outcome('ITEM', true), outcome('PROFILE', true)])).toBe('FAILED');
  });
});

describe('reading a SQLSTATE off an error', () => {
  it('takes a five-character code when the driver gives one', () => {
    expect(sqlstateOf({ code: '42501' })).toBe('42501');
  });

  it.each([
    ['no code at all', {}],
    ['a number', { code: 42501 }],
    ['something longer than a SQLSTATE', { code: 'permission denied for table x' }],
    ['null', null],
    ['undefined', undefined],
  ])('falls back to XX000 for %s', (_label, error) => {
    // Never the message. A Postgres error's `detail` quotes the row that caused it, and this is
    // the function standing between that and a database column.
    expect(sqlstateOf(error)).toBe('XX000');
  });
});
