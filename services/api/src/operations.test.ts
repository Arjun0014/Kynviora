import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
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
