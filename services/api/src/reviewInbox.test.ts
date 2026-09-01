import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Household Review Inbox, end to end (spec 04 Phase 8.3).
 *
 * Both exit criteria are asserted against the live flow, not only against the decision function:
 * a task cannot be closed without the authoritative record changing, and the payload the inbox
 * returns carries none of the alert vocabulary. Everything runs against the real database through
 * PGlite with row-level security in force as the non-superuser `kynviora_app` role.
 */

const OWNER = testUuid(1);
const OTHER_OWNER = testUuid(2);
const SHELF_CAREGIVER = testUuid(3);
const CARE_CAREGIVER = testUuid(4);
const ADMIN_CAREGIVER = testUuid(5);
const STRANGER = testUuid(6);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);
const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

const ITEM_A = testUuid(30);
const ITEM_B = testUuid(31);

const NOW = instantFrom('2026-08-29T12:00:00.000Z');
const LONG_AGO = '2025-01-01T00:00:00.000Z';

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;
let currentNow: Instant = NOW;

function principalFor(userId: string, steppedUp = false): Principal {
  return {
    userId: unsafeId<UserId>(userId),
    stepUpVerifiedAt: steppedUp ? currentNow : null,
  };
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER_OWNER, 'other@example.test'],
      [SHELF_CAREGIVER, 'shelf@example.test'],
      [CARE_CAREGIVER, 'care@example.test'],
      [ADMIN_CAREGIVER, 'admin@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`,
      [HOUSEHOLD_A, OWNER, HOUSEHOLD_B, OTHER_OWNER],
    );
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent A (synthetic)'), ($4, $5, $6, 'Parent B (synthetic)')`,
      [PROFILE_A, HOUSEHOLD_A, OWNER, PROFILE_B, HOUSEHOLD_B, OTHER_OWNER],
    );
  });

  const pool: DatabasePool = {
    withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
    withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
  };

  const sources: ReadonlyMap<string, SourceRegistryEntry> = new Map(
    ALL_FIXTURE_SOURCES.map((s) => [s.id, asApprovedSourceForTest(s)]),
  );

  app = createServer({
    surface: 'HOUSEHOLD',
    pool,
    logger: noopLogger(),
    authenticate: (_request: FastifyRequest) => Promise.resolve(currentPrincipal),
    now: () => currentNow,
    loadSources: () => Promise.resolve(sources),
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

beforeEach(async () => {
  currentNow = NOW;
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM review_task');
    await db.query('DELETE FROM caregiver_grant');
    await db.query('DELETE FROM owned_item');
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  try {
    return await app.inject(options);
  } finally {
    currentPrincipal = null;
  }
}

/** An item overdue for review, which is the simplest condition to reproduce. */
async function staleItem(id = ITEM_A, profileId = PROFILE_A, name = 'Synthetic Tablet A') {
  await t.asService((db) =>
    db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, batch_id, last_reviewed_at, created_at)
       VALUES ($1, $2, 'MEDICINE', $3, NULL, $4, $4)`,
      [id, profileId, name, LONG_AGO],
    ),
  );
}

async function grant(userId: string, capabilities: string[], profileId = PROFILE_A) {
  await t.asService((db) =>
    db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
      [profileId, userId, OWNER, capabilities],
    ),
  );
}

interface TaskListBody {
  readonly tasks: {
    readonly taskId: string;
    readonly kind: string;
    readonly subjectKind: string;
    readonly subjectId: string;
    readonly subjectLabel: string | null;
  }[];
}

async function listTasks(as: Principal, profileId = PROFILE_A) {
  return request(as, { method: 'GET', url: `/v1/profiles/${profileId}/review-tasks` });
}

async function completeTask(as: Principal, taskId: string, payload: Record<string, unknown>) {
  return request(as, {
    method: 'POST',
    url: `/v1/review-tasks/${taskId}/complete`,
    payload,
  });
}

async function firstTaskOfKind(as: Principal, kind: string): Promise<string> {
  const response = await listTasks(as);
  expect(response.statusCode).toBe(200);
  const found = response.json<TaskListBody>().tasks.find((task) => task.kind === kind);
  expect(found, `expected a ${kind} task`).toBeDefined();
  return found?.taskId ?? '';
}

// ---------------------------------------------------------------------------

describe('derivation through the live flow', () => {
  it('raises the expected tasks for a stale medicine with no batch', async () => {
    await staleItem();
    const response = await listTasks(principalFor(OWNER));
    expect(response.statusCode).toBe(200);
    const kinds = response.json<TaskListBody>().tasks.map((task) => task.kind);
    expect(kinds).toContain('ITEM_NOT_REVIEWED_RECENTLY');
    expect(kinds).toContain('BATCH_MISSING');
  });

  it('is idempotent across repeated opens', async () => {
    // The partial unique index over open tasks, not a read-then-write, is what guarantees this.
    await staleItem();
    await listTasks(principalFor(OWNER));
    await listTasks(principalFor(OWNER));
    const third = await listTasks(principalFor(OWNER));

    const tasks = third.json<TaskListBody>().tasks;
    const keys = tasks.map((task) => `${task.kind}:${task.subjectId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not leak tasks across profiles', async () => {
    await staleItem(ITEM_A, PROFILE_A);
    await staleItem(ITEM_B, PROFILE_B, 'Synthetic Tablet B');

    await listTasks(principalFor(OTHER_OWNER), PROFILE_B);
    const mine = await listTasks(principalFor(OWNER));
    for (const task of mine.json<TaskListBody>().tasks) {
      expect(task.subjectId).not.toBe(ITEM_B);
    }
  });

  it('refuses a profile the caller has nothing to do with', async () => {
    await staleItem();
    const response = await listTasks(principalFor(STRANGER));
    // PERMISSION_DENIED renders as 404 so the endpoint is not an existence oracle.
    expect(response.statusCode).toBe(404);
  });

  it('does not run derivation for an unreachable profile', async () => {
    await staleItem();
    await listTasks(principalFor(STRANGER));
    const rows = await t.asService((db) => db.query('SELECT id FROM review_task'));
    expect(rows.rows).toEqual([]);
  });
});

describe('a caregiver sees only tasks about records they may read', () => {
  it('hides a task whose subject row-level security conceals', async () => {
    // The listing joins the subject through the RLS-scoped connection. A caregiver with care
    // access but no shelf access can reach the inbox but must not learn which medicines exist.
    await staleItem();
    await grant(CARE_CAREGIVER, ['VIEW_CARE']);

    // The owner opens it first, so the tasks exist for both to see or not see.
    await listTasks(principalFor(OWNER));

    const response = await listTasks(principalFor(CARE_CAREGIVER));
    expect(response.statusCode).toBe(200);
    const body = response.json<TaskListBody>();
    expect(body.tasks).toEqual([]);
    expect(response.body).not.toContain('Synthetic Tablet A');
  });

  it('shows the task once the caregiver can read the record', async () => {
    await staleItem();
    // A medicine needs VIEW_MEDICINES: owned_item_select narrows by item_kind, and VIEW_SHELF
    // deliberately does not reach medicines.
    await grant(SHELF_CAREGIVER, ['VIEW_CARE', 'VIEW_MEDICINES']);

    const response = await listTasks(principalFor(SHELF_CAREGIVER));
    const kinds = response.json<TaskListBody>().tasks.map((task) => task.kind);
    expect(kinds).toContain('ITEM_NOT_REVIEWED_RECENTLY');
  });

  it('does not let a caregiver opening the inbox shrink the owner list', async () => {
    // Derivation is privileged for exactly this reason: if it ran under the caller's view, the
    // stored task set would depend on who last looked.
    await staleItem();
    await grant(CARE_CAREGIVER, ['VIEW_CARE']);

    await listTasks(principalFor(CARE_CAREGIVER));
    const ownerView = await listTasks(principalFor(OWNER));
    const kinds = ownerView.json<TaskListBody>().tasks.map((task) => task.kind);
    expect(kinds).toContain('ITEM_NOT_REVIEWED_RECENTLY');
  });
});

describe('the payload is not an alert', () => {
  it('carries no urgency, evidence level, severity or score anywhere', async () => {
    // Exit criterion 1 as a property of the response, not only of the screen that renders it.
    await staleItem();
    const response = await listTasks(principalFor(OWNER));
    const body = response.body.toLowerCase();
    for (const forbidden of [
      'urgency',
      'evidencelevel',
      'severity',
      'matchconfidence',
      'critical',
      'riskscore',
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });
});

describe('completing a task must change the record', () => {
  it('refuses a completion that changes nothing', async () => {
    await staleItem();
    const taskId = await firstTaskOfKind(principalFor(OWNER), 'ITEM_NOT_REVIEWED_RECENTLY');

    const response = await completeTask(principalFor(OWNER), taskId, {
      outcome: 'RESOLVED',
      changes: [],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'completion_changes_nothing' } },
    });

    const stored = await t.asService((db) =>
      db.query<{ state: string }>('SELECT state FROM review_task WHERE id = $1', [taskId]),
    );
    expect(stored.rows[0]?.state).toBe('OPEN');
  });

  it('writes the authoritative record and closes the task together', async () => {
    await staleItem();
    const taskId = await firstTaskOfKind(principalFor(OWNER), 'ITEM_NOT_REVIEWED_RECENTLY');

    const response = await completeTask(principalFor(OWNER), taskId, {
      outcome: 'RESOLVED',
      changes: [
        { recordKind: 'owned_item', recordId: ITEM_A, field: 'last_reviewed_at', value: NOW },
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: 'COMPLETED',
      changedFields: ['last_reviewed_at'],
    });

    const item = await t.asService((db) =>
      db.query<{ last_reviewed_at: Date }>(
        'SELECT last_reviewed_at FROM owned_item WHERE id = $1',
        [ITEM_A],
      ),
    );
    expect(item.rows[0]?.last_reviewed_at.toISOString()).toBe(NOW);

    const task = await t.asService((db) =>
      db.query<{ state: string; completion_fields: string[]; completed_by_user_id: string }>(
        'SELECT state, completion_fields, completed_by_user_id FROM review_task WHERE id = $1',
        [taskId],
      ),
    );
    expect(task.rows[0]?.state).toBe('COMPLETED');
    expect(task.rows[0]?.completion_fields).toEqual(['last_reviewed_at']);
    expect(task.rows[0]?.completed_by_user_id).toBe(OWNER);
  });

  it('requires a change for "not applicable" as well', async () => {
    await staleItem();
    const taskId = await firstTaskOfKind(principalFor(OWNER), 'ITEM_NOT_REVIEWED_RECENTLY');

    const empty = await completeTask(principalFor(OWNER), taskId, {
      outcome: 'NOT_APPLICABLE',
      changes: [],
    });
    expect(empty.statusCode).toBe(400);

    const withChange = await completeTask(principalFor(OWNER), taskId, {
      outcome: 'NOT_APPLICABLE',
      changes: [
        { recordKind: 'owned_item', recordId: ITEM_A, field: 'last_reviewed_at', value: NOW },
      ],
    });
    expect(withChange.statusCode).toBe(200);
    expect(withChange.json()).toMatchObject({ state: 'DISMISSED' });
  });

  it('refuses a field that is not what this task is about', async () => {
    // Without the allow-list the inbox would be a general-purpose write endpoint that happens to
    // close a task.
    await staleItem();
    const taskId = await firstTaskOfKind(principalFor(OWNER), 'ITEM_NOT_REVIEWED_RECENTLY');

    const response = await completeTask(principalFor(OWNER), taskId, {
      outcome: 'RESOLVED',
      changes: [
        { recordKind: 'owned_item', recordId: ITEM_A, field: 'display_name', value: 'Renamed' },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'field_not_completable' } },
    });

    const item = await t.asService((db) =>
      db.query<{ display_name: string }>('SELECT display_name FROM owned_item WHERE id = $1', [
        ITEM_A,
      ]),
    );
    expect(item.rows[0]?.display_name).toBe('Synthetic Tablet A');
  });

  it('refuses a change aimed at another record', async () => {
    await staleItem(ITEM_A, PROFILE_A);
    await staleItem(ITEM_B, PROFILE_A, 'Synthetic Tablet B');
    const response0 = await listTasks(principalFor(OWNER));
    const task = response0
      .json<TaskListBody>()
      .tasks.find((x) => x.kind === 'ITEM_NOT_REVIEWED_RECENTLY' && x.subjectId === ITEM_A);
    expect(task).toBeDefined();

    const response = await completeTask(principalFor(OWNER), task?.taskId ?? '', {
      outcome: 'RESOLVED',
      changes: [
        { recordKind: 'owned_item', recordId: ITEM_B, field: 'last_reviewed_at', value: NOW },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'change_targets_other_record' } },
    });
  });

  it('refuses to close an already-closed task', async () => {
    await staleItem();
    const taskId = await firstTaskOfKind(principalFor(OWNER), 'ITEM_NOT_REVIEWED_RECENTLY');
    const change = {
      outcome: 'RESOLVED',
      changes: [
        { recordKind: 'owned_item', recordId: ITEM_A, field: 'last_reviewed_at', value: NOW },
      ],
    };

    expect((await completeTask(principalFor(OWNER), taskId, change)).statusCode).toBe(200);
    const second = await completeTask(principalFor(OWNER), taskId, change);
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ error: { detail: { reason_code: 'task_not_open' } } });
  });

  it('records the completion in the audit log without the value written', async () => {
    await staleItem();
    const taskId = await firstTaskOfKind(principalFor(OWNER), 'BATCH_MISSING');

    await completeTask(principalFor(OWNER), taskId, {
      outcome: 'RESOLVED',
      changes: [
        {
          recordKind: 'owned_item',
          recordId: ITEM_A,
          field: 'batch_verification',
          value: 'CONFIRMED',
        },
      ],
    });

    const events = await t.asService((db) =>
      db.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_event WHERE target_id = $1 AND action = 'review.task.completed'`,
        [taskId],
      ),
    );
    expect(events.rows.length).toBe(1);
    const detail = JSON.stringify(events.rows[0]?.detail);
    expect(detail).toContain('batch_verification');
    expect(detail).toContain('BATCH_MISSING');
  });
});

describe('authorization follows the record, not the inbox', () => {
  it('refuses a caregiver who can see the task but not change the record', async () => {
    // VIEW_CARE reaches the inbox and VIEW_MEDICINES reads the item, but neither permits the write.
    await staleItem();
    await grant(SHELF_CAREGIVER, ['VIEW_CARE', 'VIEW_MEDICINES']);
    const taskId = await firstTaskOfKind(
      principalFor(SHELF_CAREGIVER),
      'ITEM_NOT_REVIEWED_RECENTLY',
    );

    const response = await completeTask(principalFor(SHELF_CAREGIVER), taskId, {
      outcome: 'RESOLVED',
      changes: [
        { recordKind: 'owned_item', recordId: ITEM_A, field: 'last_reviewed_at', value: NOW },
      ],
    });
    expect(response.statusCode).toBe(404);

    const item = await t.asService((db) =>
      db.query<{ last_reviewed_at: Date }>(
        'SELECT last_reviewed_at FROM owned_item WHERE id = $1',
        [ITEM_A],
      ),
    );
    expect(item.rows[0]?.last_reviewed_at.toISOString()).toBe(LONG_AGO);
  });

  it('admits a caregiver holding the capability the record requires', async () => {
    await staleItem();
    await grant(SHELF_CAREGIVER, ['VIEW_CARE', 'VIEW_MEDICINES', 'MANAGE_MEDICINES']);
    const taskId = await firstTaskOfKind(
      principalFor(SHELF_CAREGIVER),
      'ITEM_NOT_REVIEWED_RECENTLY',
    );

    const response = await completeTask(principalFor(SHELF_CAREGIVER), taskId, {
      outcome: 'RESOLVED',
      changes: [
        { recordKind: 'owned_item', recordId: ITEM_A, field: 'last_reviewed_at', value: NOW },
      ],
    });
    expect(response.statusCode).toBe(200);
  });

  it('lets the database narrow shelf management away from a medicine', async () => {
    // The case that produced COMPLETION_CAPABILITIES. A task row names only the item ID, so the
    // domain cannot tell a medicine from a shampoo and admits either management capability.
    // `owned_item_update` knows the item kind and refuses - and because the record write is
    // attempted first and wrote nothing, the task stays open rather than closing over a change
    // that never happened.
    await staleItem();
    await grant(SHELF_CAREGIVER, ['VIEW_CARE', 'VIEW_MEDICINES', 'MANAGE_SHELF']);
    const taskId = await firstTaskOfKind(
      principalFor(SHELF_CAREGIVER),
      'ITEM_NOT_REVIEWED_RECENTLY',
    );

    const response = await completeTask(principalFor(SHELF_CAREGIVER), taskId, {
      outcome: 'RESOLVED',
      changes: [
        { recordKind: 'owned_item', recordId: ITEM_A, field: 'last_reviewed_at', value: NOW },
      ],
    });
    expect(response.statusCode).toBe(404);

    const stored = await t.asService((db) =>
      db.query<{ state: string }>('SELECT state FROM review_task WHERE id = $1', [taskId]),
    );
    expect(stored.rows[0]?.state).toBe('OPEN');
  });

  it('does not let a stranger complete a task', async () => {
    await staleItem();
    const taskId = await firstTaskOfKind(principalFor(OWNER), 'ITEM_NOT_REVIEWED_RECENTLY');

    const response = await completeTask(principalFor(STRANGER), taskId, {
      outcome: 'RESOLVED',
      changes: [
        { recordKind: 'owned_item', recordId: ITEM_A, field: 'last_reviewed_at', value: NOW },
      ],
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires step-up to renew a caregiver grant from the inbox', async () => {
    // 14 puts caregiver administration behind re-authentication, and renewing a grant is
    // caregiver administration whichever surface it is reached from.
    await t.asService((db) =>
      db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at,
            expires_at)
         VALUES ($1, $2, $3, ARRAY['VIEW_CARE']::text[], 'ACTIVE', now(), $4)`,
        [PROFILE_A, ADMIN_CAREGIVER, OWNER, '2026-09-05T12:00:00.000Z'],
      ),
    );

    const taskId = await firstTaskOfKind(principalFor(OWNER), 'CAREGIVER_GRANT_EXPIRING');
    const grantRow = await t.asService((db) =>
      db.query<{ id: string }>('SELECT id FROM caregiver_grant WHERE grantee_user_id = $1', [
        ADMIN_CAREGIVER,
      ]),
    );
    const grantId = grantRow.rows[0]?.id ?? '';

    const payload = {
      outcome: 'RESOLVED',
      changes: [
        {
          recordKind: 'caregiver_grant',
          recordId: grantId,
          field: 'expires_at',
          value: '2027-01-01T00:00:00.000Z',
        },
      ],
    };

    const without = await completeTask(principalFor(OWNER), taskId, payload);
    expect(without.statusCode).toBe(403);
    expect(without.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });

    const with_ = await completeTask(principalFor(OWNER, true), taskId, payload);
    expect(with_.statusCode).toBe(200);

    const renewed = await t.asService((db) =>
      db.query<{ expires_at: Date }>('SELECT expires_at FROM caregiver_grant WHERE id = $1', [
        grantId,
      ]),
    );
    expect(renewed.rows[0]?.expires_at.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
