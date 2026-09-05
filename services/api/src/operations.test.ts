import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, expectDenied, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  OPERATIONAL_METRICS,
  instantFrom,
  noopLogger,
  unsafeId,
  type Instant,
  type MetricKey,
  type UserId,
} from '@kynviora/domain';

/**
 * The operational projection, against a real database.
 *
 * What is worth asserting here is not that a count is a count. It is that the route is staff-only
 * on the same terms as the console, that the numbers come from the tables they claim to, and that
 * nothing on the way out carries a profile, a user or a medicine - `20`'s rule is that operator
 * output measures system behaviour and not sensitive content, and a projection is exactly where
 * somebody would helpfully attach "which profile" to make a number actionable.
 */

const ADMIN = testUuid(1);
const OPS = testUuid(2);
const CLINICAL = testUuid(3);
const OUTSIDER = testUuid(4);

const OWNER = testUuid(10);
const HOUSEHOLD = testUuid(11);
const PROFILE = testUuid(12);
const ITEM = testUuid(13);

const SOURCE_FRESH = testUuid(50);
const SOURCE_STALE = testUuid(51);
const SOURCE_NEVER = testUuid(52);

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;

function principalFor(userId: string): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt: null };
}

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  try {
    return await app.inject(options);
  } finally {
    currentPrincipal = null;
  }
}

async function grantRole(userId: string, role: string) {
  await t.asService((db) =>
    db.query(
      `INSERT INTO reviewer (user_id, role, granted_by_user_id, granted_at)
       VALUES ($1, $2, $3, now())`,
      [userId, role, ADMIN],
    ),
  );
}

interface Snapshot {
  at: string;
  metrics: { key: MetricKey; value: number; unit: string }[];
  sources: {
    sourceId: string;
    organization: string;
    overdueByMs: number | null;
    neverSucceeded: boolean;
    unowned: boolean;
  }[];
}

async function snapshotAs(userId: string): Promise<Snapshot> {
  const response = await request(principalFor(userId), {
    method: 'GET',
    url: '/v1/reviewer/operations',
  });
  expect(response.statusCode).toBe(200);
  return response.json<Snapshot>();
}

function metric(snapshot: Snapshot, key: MetricKey): number {
  return snapshot.metrics.find((reading) => reading.key === key)?.value ?? -1;
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [ADMIN, 'admin@example.test'],
      [OPS, 'ops@example.test'],
      [CLINICAL, 'clinical@example.test'],
      [OUTSIDER, 'outsider@example.test'],
      [OWNER, 'owner@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }

    // A household with one open review task, so the inbox metric has something real behind it.
    await db.query(`INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'H')`, [
      HOUSEHOLD,
      OWNER,
    ]);
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name) VALUES ($1, $2, $3, 'P')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet')`,
      [ITEM, PROFILE],
    );
    await db.query(
      `INSERT INTO review_task
         (profile_id, task_kind, subject_kind, subject_id, owned_item_id, created_at)
       VALUES ($1, 'ITEM_NOT_REVIEWED_RECENTLY', 'owned_item', $2, $2,
               '2026-08-22T12:00:00.000Z')`,
      [PROFILE, ITEM],
    );

    // Three sources: one inside its declared cadence, one well past it, one never checked.
    const source = `INSERT INTO source_registry_entry
        (id, organization, source_name, source_class, jurisdiction, allowed_influence,
         license_review_state, expected_refresh_interval_ms, parser_version, status,
         coverage_statement, operational_owner, last_attempted_check_at, last_successful_check_at,
         consecutive_failure_count)
      VALUES ($1, $2, $3, 'PRIMARY_LEGAL', 'GB', ARRAY['REGULATORY_STATUS']::text[], 'APPROVED',
              86400000, '1.0.0', 'ACTIVE', 'Synthetic coverage.', $4, $5, $6, $7)`;

    await db.query(source, [
      SOURCE_FRESH,
      'Synthetic Authority',
      'Fresh register',
      'ops@example.test',
      '2026-08-29T11:00:00.000Z',
      '2026-08-29T11:00:00.000Z',
      0,
    ]);
    await db.query(source, [
      SOURCE_STALE,
      'Synthetic Authority',
      'Stale register',
      'ops@example.test',
      '2026-08-27T12:00:00.000Z',
      '2026-08-27T12:00:00.000Z',
      3,
    ]);
    // No operational owner: `20` says do not create alerts no one owns, and an unowned source is
    // a finding this projection can make with no threshold at all.
    await db.query(source, [
      SOURCE_NEVER,
      'Synthetic Authority',
      'Never checked',
      null,
      null,
      null,
      0,
    ]);
  });

  const pool: DatabasePool = {
    withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
    withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
  };

  app = createServer({
    surface: 'STAFF',
    pool,
    logger: noopLogger(),
    authenticate: (_request: FastifyRequest) => Promise.resolve(currentPrincipal),
    now: (): Instant => NOW,
    // No regulatory lens is exercised here, and an empty map is the honest input: this suite is
    // about counting what the database holds, not about what any source says.
    loadSources: () => Promise.resolve(new Map()),
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

beforeEach(async () => {
  await t.asOwner((db) => db.query('DELETE FROM reviewer'));
});

describe('who may read the operational projection', () => {
  it('refuses a caller holding no reviewer role, without saying the route exists', async () => {
    // `14`: staff roles come from a stored row, never from a client claim. The bare not-found is
    // the same answer the console gives, so this route is not an oracle for its own existence.
    const response = await request(principalFor(OUTSIDER), {
      method: 'GET',
      url: '/v1/reviewer/operations',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('PERMISSION_DENIED');
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await request(null, { method: 'GET', url: '/v1/reviewer/operations' });
    expect(response.statusCode).toBe(401);
  });

  it('admits any active reviewer, not one role', async () => {
    // `20` calls source freshness a safety metric, and a clinical safety lead deciding whether a
    // rule should stay published needs to know the source behind it has not been checked. The
    // snapshot carries no user content, so the usual reason to narrow a staff read does not apply.
    await grantRole(OPS, 'SOURCE_OPERATIONS_OWNER');
    await grantRole(CLINICAL, 'CLINICAL_SAFETY_LEAD');

    for (const user of [OPS, CLINICAL]) {
      const response = await request(principalFor(user), {
        method: 'GET',
        url: '/v1/reviewer/operations',
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('refuses a reviewer whose role has been suspended', async () => {
    await grantRole(OPS, 'SOURCE_OPERATIONS_OWNER');
    await t.asService((db) =>
      db.query(`UPDATE reviewer SET status = 'SUSPENDED' WHERE user_id = $1`, [OPS]),
    );
    const response = await request(principalFor(OPS), {
      method: 'GET',
      url: '/v1/reviewer/operations',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('what the projection reports', () => {
  beforeEach(async () => {
    await grantRole(OPS, 'SOURCE_OPERATIONS_OWNER');
  });

  it('reports every metric, including the zeroes', async () => {
    // A dashboard that only receives a metric when it is non-zero cannot tell "nothing happened"
    // from "the projection stopped running".
    const snapshot = await snapshotAs(OPS);
    expect(snapshot.metrics.map((reading) => reading.key)).toEqual([...OPERATIONAL_METRICS]);
  });

  it('counts source freshness against each source own declared cadence', async () => {
    const snapshot = await snapshotAs(OPS);
    expect(metric(snapshot, 'sources_registered')).toBe(3);
    expect(metric(snapshot, 'sources_overdue')).toBe(1);
    expect(metric(snapshot, 'sources_never_successfully_checked')).toBe(1);
    expect(metric(snapshot, 'sources_with_consecutive_failures')).toBe(1);

    const stale = snapshot.sources.find((row) => row.sourceId === SOURCE_STALE);
    // Checked two days ago against a one-day interval: one day past, exactly.
    expect(stale?.overdueByMs).toBe(24 * 60 * 60 * 1000);
    expect(snapshot.sources.find((row) => row.sourceId === SOURCE_NEVER)?.neverSucceeded).toBe(
      true,
    );
    expect(snapshot.sources.find((row) => row.sourceId === SOURCE_NEVER)?.unowned).toBe(true);
    expect(snapshot.sources.find((row) => row.sourceId === SOURCE_FRESH)?.overdueByMs).toBeNull();
  });

  it('reports the household inbox age without naming the household', async () => {
    // The task was created a week before the snapshot clock. Which profile it belongs to is a
    // fact about a person and is exactly what `20` keeps out of operator output.
    const snapshot = await snapshotAs(OPS);
    expect(metric(snapshot, 'review_tasks_open')).toBeGreaterThanOrEqual(1);
    expect(metric(snapshot, 'review_tasks_oldest_open_age_ms')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(JSON.stringify(snapshot.metrics)).not.toContain(PROFILE);
  });

  it('carries no profile, user, item or medicine anywhere in the response', async () => {
    // The assertion the module's types exist to make possible. A count is a health signal; the
    // subject behind it is a disclosure.
    const snapshot = await snapshotAs(OPS);
    const serialised = JSON.stringify(snapshot);
    for (const identifier of [PROFILE, OWNER, ITEM, HOUSEHOLD]) {
      expect(serialised).not.toContain(identifier);
    }
    expect(serialised).not.toContain('Synthetic Tablet');
  });

  it('carries no status, severity or threshold breach', async () => {
    // `20` requires exact thresholds to be documented before production and `BLK-008` records
    // that none are. A "degraded" here would be an invented answer an operator would act on.
    const snapshot = await snapshotAs(OPS);
    for (const reading of snapshot.metrics) {
      expect(Object.keys(reading).sort()).toEqual(['key', 'unit', 'value']);
    }
    const sourceKeys = new Set(snapshot.sources.flatMap((row) => Object.keys(row)));
    for (const forbidden of ['severity', 'alertLevel', 'degraded', 'critical', 'healthScore']) {
      expect([...sourceKeys]).not.toContain(forbidden);
    }
  });

  it('reports the global publication block as a number', async () => {
    expect(metric(await snapshotAs(OPS), 'publication_blocked')).toBe(0);

    await t.asService((db) =>
      db.query(
        `UPDATE publication_control
            SET publication_blocked = true, blocked_reason = 'test',
                blocked_by_user_id = $1, blocked_at = now()`,
        [ADMIN],
      ),
    );
    expect(metric(await snapshotAs(OPS), 'publication_blocked')).toBe(1);

    await t.asService((db) =>
      db.query(
        `UPDATE publication_control
            SET publication_blocked = false, blocked_reason = NULL,
                blocked_by_user_id = NULL, blocked_at = NULL`,
      ),
    );
  });

  it('keeps the reviewer queue apart from the household inbox', async () => {
    // Two different queues. Only one of them is staff workload, and reporting either as the other
    // would make an SLA meaningless.
    // A regulatory subject rather than a safety rule, because a two-person safety-rule
    // publication must name a shadow run of that rule (DEC-036) and none of that is what this
    // test is about.
    await t.asService((db) =>
      db.query(
        `INSERT INTO publication_request
           (subject_kind, subject_id, action, jurisdictions, max_urgency, evidence_level,
            required_approvals, requested_by_user_id, requested_at, requested_note)
         VALUES ('regulatory_rule_version', $1, 'PUBLISH', ARRAY['GB']::text[], 'HIGH', 'A', 2,
                 $2, '2026-08-28T12:00:00.000Z', 'synthetic')`,
        [testUuid(300), ADMIN],
      ),
    );

    const snapshot = await snapshotAs(OPS);
    expect(metric(snapshot, 'reviewer_queue_open_requests')).toBe(1);
    expect(metric(snapshot, 'reviewer_queue_oldest_open_age_ms')).toBe(24 * 60 * 60 * 1000);
    // The inbox is unaffected: a publication request is not a household review task.
    expect(metric(snapshot, 'review_tasks_open')).toBeGreaterThanOrEqual(1);
  });
});

describe('retention health on the operations snapshot', () => {
  // The top-level hook clears every reviewer row before each test, so the role is re-granted here
  // rather than once - the same shape the projection block above uses.
  beforeEach(async () => {
    await grantRole(OPS, 'SOURCE_OPERATIONS_OWNER');
  });

  /** Open a run as the retention role, which is the only role that may. */
  async function openRun(startedAt: string): Promise<string> {
    const res = await t.asRetention((db) =>
      db.query<{ id: string }>(
        `INSERT INTO retention_run (holder, started_at) VALUES ('test', ${startedAt})
         RETURNING id`,
      ),
    );
    return res.rows[0]?.id ?? '';
  }

  async function closeRun(runId: string, outcome: string, rowsPurged = 0): Promise<void> {
    await t.asRetention((db) =>
      db.query(
        `UPDATE retention_run
            SET finished_at = now(), outcome = $2, duration_ms = 10, rows_purged = $3,
                categories_attempted = 7, categories_failed = $4
          WHERE id = $1`,
        [runId, outcome, rowsPurged, outcome === 'SUCCEEDED' ? 0 : 1],
      ),
    );
  }

  async function recordCategory(
    runId: string,
    category: string,
    outcome: 'SUCCEEDED' | 'FAILED',
  ): Promise<void> {
    await t.asRetention((db) =>
      db.query(
        `INSERT INTO retention_run_category
           (run_id, category, outcome, rows_purged, duration_ms, failure_step, failure_sqlstate)
         VALUES ($1, $2, $3, 0, 1, $4, $5)`,
        [
          runId,
          category,
          outcome,
          outcome === 'FAILED' ? 'step' : null,
          outcome === 'FAILED' ? '42501' : null,
        ],
      ),
    );
  }

  it('says a sweep has never run rather than reporting an age of zero', async () => {
    // The trap the metric exists for. An operator alerting on the age alone would read a system
    // that has never purged anything as one that just did, because `null` and "just now" produce
    // the same number.
    const snapshot = await snapshotAs(OPS);
    expect(metric(snapshot, 'retention_never_swept')).toBe(1);
    expect(metric(snapshot, 'retention_last_successful_run_age_ms')).toBe(0);
  });

  it('reports how long ago a sweep last fully succeeded', async () => {
    const run = await openRun(`'2026-08-29T09:00:00.000Z'`);
    await closeRun(run, 'SUCCEEDED', 12);

    const snapshot = await snapshotAs(OPS);
    expect(metric(snapshot, 'retention_never_swept')).toBe(0);
    // `NOW` is 12:00 and the run started at 09:00.
    expect(metric(snapshot, 'retention_last_successful_run_age_ms')).toBe(3 * 60 * 60 * 1000);
    expect(metric(snapshot, 'retention_rows_purged_last_run')).toBe(12);
  });

  it('does not let a PARTIAL run count as the last successful sweep', async () => {
    // The assertion this whole surface is for. A sweep that skipped a category did not keep that
    // category's deadline, and an operator asking when retention last worked is asking about all
    // of it - so a later PARTIAL must not move the age back to zero and hide the earlier gap.
    const run = await openRun(`'2026-08-29T11:00:00.000Z'`);
    await recordCategory(run, 'CONSENT_RECEIPT', 'FAILED');
    await recordCategory(run, 'ITEM', 'SUCCEEDED');
    await closeRun(run, 'PARTIAL', 3);

    const snapshot = await snapshotAs(OPS);
    // Still three hours, from the 09:00 SUCCEEDED run - not one hour from this PARTIAL one.
    expect(metric(snapshot, 'retention_last_successful_run_age_ms')).toBe(3 * 60 * 60 * 1000);
    // And the detail is where an operator can act on it.
    expect(metric(snapshot, 'retention_categories_failing')).toBe(1);
    expect(metric(snapshot, 'retention_rows_purged_last_run')).toBe(3);
  });

  it('clears a failing category by itself when it next succeeds', async () => {
    // Self-clearing is what lets this be alertable with no window and no threshold - `BLK-008`
    // records that no threshold is approved, and this metric does not need one.
    const run = await openRun('now()');
    await recordCategory(run, 'CONSENT_RECEIPT', 'SUCCEEDED');
    await closeRun(run, 'SUCCEEDED', 0);

    expect(metric(await snapshotAs(OPS), 'retention_categories_failing')).toBe(0);
  });

  it('counts a run that was opened and never closed', async () => {
    // Normally zero, briefly one. Persistently above zero is a worker dying mid-sweep, which no
    // other metric here would show.
    expect(metric(await snapshotAs(OPS), 'retention_runs_unfinished')).toBe(0);
    const orphan = await openRun('now()');
    expect(metric(await snapshotAs(OPS), 'retention_runs_unfinished')).toBe(1);

    await closeRun(orphan, 'SUCCEEDED', 0);
    expect(metric(await snapshotAs(OPS), 'retention_runs_unfinished')).toBe(0);
  });

  it('gives the reader the numbers without giving them the rows', async () => {
    // `0027` answers through a SECURITY DEFINER function rather than a table grant, so the service
    // role that gathers the snapshot learns five aggregates and gains no read on the run history.
    // Without this the fix would have been a grant, and a grant with one consumer is still a grant.
    for (const table of ['retention_run', 'retention_run_category', 'retention_lease']) {
      expect(
        await expectDenied(() => t.asService((db) => db.query(`SELECT * FROM ${table}`))),
      ).toMatch(/permission denied/i);
    }
  });

  it('carries no run id, holder or failure message out to the reader', async () => {
    // A retention metric is a count. The failure step and SQLSTATE are diagnostic and stay in the
    // database; a holder is an opaque process identity and has no business on a dashboard.
    const snapshot = await snapshotAs(OPS);
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ['holder', 'run_id', 'runId', 'failure_step', 'sqlstate', '42501']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
