import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, testUuid, type TestDb } from './harness/harness.js';
import { runPurgeSweep, type PurgeConnection } from './src/retention.js';

/**
 * The deadlines themselves, at the microsecond.
 *
 * Spec references: `16` (retention deadlines and the deletion enumeration), `14` (RLS is the
 * boundary), DEC-117, DEC-121, migrations `0022`, `0023`, `0026`, `docs/RETENTION.md`.
 *
 * WHAT THIS FILE ADDS THAT `purge.test.ts` DOES NOT
 * That file proves the sweep purges what is due and leaves what is not, with fixtures at 31 days
 * and 3 days - comfortably either side. This one asks where the line actually is, because "within
 * 30 days" is a number somebody will be held to and `<=` versus `<` is the whole of it.
 *
 * HOW AN EXACT BOUNDARY IS TESTABLE AT ALL
 * `now()` is constant within a transaction. So a fixture inserted at `kynviora.purge_floor()` and
 * read back in the **same** transaction is exactly on the line rather than a few milliseconds past
 * it, and a sibling one microsecond later is exactly off it. Every boundary test below is one
 * transaction that rolls back, which is also why they leave no state for each other.
 *
 * `SET LOCAL ROLE` inside that transaction is what makes the answer come from the **policy**
 * rather than from a predicate this file wrote. That distinction is the entire point: the sweep's
 * `WHERE` clauses are belt, the policies are braces, and a test that checked the belt would pass
 * over a dropped policy.
 */

const OWNER = testUuid(1);
const CAREGIVER = testUuid(2);
const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const AT_FLOOR = testUuid(60);
const JUST_INSIDE = testUuid(61);

let t: TestDb;

/** A distinct 64-character hex string derived from a fixture id. */
function hexOf(id: string): string {
  return id.replace(/-/g, '').padEnd(64, '0');
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [CAREGIVER, 'caregiver@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
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
});

afterAll(async () => {
  await t?.close();
});

/**
 * Insert two rows either side of a deadline and ask the retention role which it can see.
 *
 * One transaction, so `now()` - and therefore the deadline - is a single fixed instant for the
 * insert and for the read. Rolled back, so nothing survives into the next test.
 *
 * `deadline` is the SQL expression a row's timestamp is compared against. The "inside" row is one
 * microsecond newer, which is the smallest difference Postgres can represent in a `timestamptz`
 * and therefore the tightest this claim can be made.
 */
async function eitherSideOf(
  deadline: string,
  insert: (column: string, id: string) => { sql: string; params: readonly unknown[] },
  read: string,
): Promise<{ atBoundary: boolean; justInside: boolean; role: string; superuser: boolean }> {
  return t.asOwner(async (db) => {
    await db.query('BEGIN');
    try {
      const at = insert(deadline, AT_FLOOR);
      await db.query(at.sql, [...at.params]);
      const inside = insert(`${deadline} + interval '1 microsecond'`, JUST_INSIDE);
      await db.query(inside.sql, [...inside.params]);

      await db.query('SET LOCAL ROLE kynviora_retention');

      // Without this the whole file could pass vacuously: a superuser bypasses row-level security
      // even under FORCE ROW LEVEL SECURITY, so every row would be visible and every boundary
      // would read as inclusive (DEC-005).
      const who = await db.query<{ role_name: string; is_superuser: boolean }>(
        `SELECT current_user AS role_name,
                (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
      );

      const seen = await db.query<{ id: string }>(read, [AT_FLOOR, JUST_INSIDE]);
      const ids = new Set(seen.rows.map((r) => r.id));

      return {
        atBoundary: ids.has(AT_FLOOR),
        justInside: ids.has(JUST_INSIDE),
        role: who.rows[0]?.role_name ?? '',
        superuser: who.rows[0]?.is_superuser ?? true,
      };
    } finally {
      await db.query('ROLLBACK');
    }
  });
}

function expectExactBoundary(result: {
  atBoundary: boolean;
  justInside: boolean;
  role: string;
  superuser: boolean;
}): void {
  expect(result.role).toBe('kynviora_retention');
  expect(result.superuser).toBe(false);
  // At the deadline: due. `docs/RETENTION.md` says "within", and a row that has reached its
  // deadline has reached it.
  expect(result.atBoundary).toBe(true);
  // One microsecond short of it: not due, and not by rounding.
  expect(result.justInside).toBe(false);
}

describe('the thirty-day purge floor', () => {
  it('admits an item at the floor and refuses one a microsecond inside it', async () => {
    expectExactBoundary(
      await eitherSideOf(
        'kynviora.purge_floor()',
        (column, id) => ({
          sql: `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
                VALUES ($1, $2, 'MEDICINE', 'Boundary', ${column})`,
          params: [id, PROFILE],
        }),
        `SELECT id FROM owned_item WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
      ),
    );
  });

  it('admits a profile at the floor and refuses one a microsecond inside it', async () => {
    expectExactBoundary(
      await eitherSideOf(
        'kynviora.purge_floor()',
        (column, id) => ({
          sql: `INSERT INTO profile (id, household_id, owner_user_id, display_name, deleted_at)
                VALUES ($1, $2, $3, 'Boundary', ${column})`,
          params: [id, HOUSEHOLD, OWNER],
        }),
        `SELECT id FROM profile WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
      ),
    );
  });
});

describe('the twenty-four month retention floor', () => {
  it('admits an audit event at the floor and refuses one a microsecond inside it', async () => {
    expectExactBoundary(
      await eitherSideOf(
        'kynviora.retention_floor()',
        (column, id) => ({
          sql: `INSERT INTO audit_event (id, occurred_at, actor_user_id, actor_role, action, target_kind)
                VALUES ($1, ${column}, $2, 'user', 'item.deleted', 'owned_item')`,
          params: [id, OWNER],
        }),
        `SELECT id FROM audit_event WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
      ),
    );
  });

  it('admits a consent receipt at the floor and refuses one a microsecond inside it', async () => {
    // The receipt is evidence of a withdrawal (`DEV-056`), so its floor being right is the
    // difference between keeping evidence for two years and losing it early.
    expectExactBoundary(
      await eitherSideOf(
        'kynviora.retention_floor()',
        (column, id) => ({
          sql: `INSERT INTO consent_receipt (id, user_id, purpose, granted, policy_version, recorded_at)
                VALUES ($1, $2, 'PROFILE_DATA', true, 'v1', ${column})`,
          params: [id, OWNER],
        }),
        `SELECT id FROM consent_receipt WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
      ),
    );
  });
});

describe('the shorter deadlines, which are the ones an interval can overshoot most', () => {
  it('admits a Visit Pack twenty-four hours past expiry, and not a microsecond before', async () => {
    expectExactBoundary(
      await eitherSideOf(
        `now() - interval '24 hours'`,
        (column, id) => ({
          sql: `INSERT INTO visit_pack
                  (id, profile_id, created_by_user_id, manifest, content_digest, notes,
                   generated_at, expires_at)
                VALUES ($1, $2, $3, $4::jsonb, repeat('a', 64), ARRAY['note'],
                        now() - interval '40 days', ${column})`,
          params: [
            id,
            PROFILE,
            OWNER,
            JSON.stringify([{ section: 's', entityKind: 'k', entityId: 'e' }]),
          ],
        }),
        `SELECT id FROM visit_pack WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
      ),
    );
  });

  it('admits an invitation thirty days past expiry, and not a microsecond before', async () => {
    expectExactBoundary(
      await eitherSideOf(
        `now() - interval '30 days'`,
        (column, id) => ({
          sql: `INSERT INTO caregiver_invitation
                  (id, profile_id, invited_by_user_id, capabilities, token_hash, expires_at, created_at)
                VALUES ($1, $2, $3, ARRAY['VIEW_SHELF'], $4, ${column}, now() - interval '90 days')`,
          // A distinct 64-character hash per row, built here rather than in SQL: reusing the id
          // parameter as both a uuid and text leaves Postgres unable to deduce its type.
          params: [id, PROFILE, OWNER, hexOf(id)],
        }),
        `SELECT id FROM caregiver_invitation WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
      ),
    );
  });

  it('admits an unattached capture artifact at seven days, and not a microsecond before', async () => {
    expectExactBoundary(
      await eitherSideOf(
        `now() - interval '7 days'`,
        (column, id) => ({
          sql: `INSERT INTO evidence_asset
                  (id, owner_user_id, panel_kind, storage_key, content_type, byte_size, sha256, created_at)
                VALUES ($1, $2, 'FRONT_PANEL', $3, 'image/jpeg', 1024, repeat('e', 64), ${column})`,
          params: [id, OWNER, `key-${id}`],
        }),
        `SELECT id FROM evidence_asset WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// The two halves of a deletion, in order
// ---------------------------------------------------------------------------

describe('deleting a medicine', () => {
  const ITEM = testUuid(70);

  beforeAll(async () => {
    await t.asOwner(async (db) => {
      await db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
         VALUES ($1, $2, 'MEDICINE', 'Amoxicillin 500mg')`,
        [ITEM, PROFILE],
      );
      await db.query(
        `INSERT INTO dose_event (owned_item_id, event_kind, recorded_at, client_operation_id)
         VALUES ($1, 'TAKEN', now(), gen_random_uuid())`,
        [ITEM],
      );
    });

    await t.asService((db) =>
      db.query(`SELECT kynviora.delete_owned_item($1, $2) AS stamped`, [ITEM, OWNER]),
    );
  });

  it('stops the owner seeing it in the same request that accepted the deletion', async () => {
    // Revocation is the promise, and it is synchronous. Nobody waits for a background job before
    // the thing stops affecting them (`docs/RETENTION.md` section 1).
    const seen = await t.asUser(OWNER, (db) =>
      db.query<{ id: string }>(`SELECT id FROM owned_item WHERE id = $1`, [ITEM]),
    );
    expect(seen.rows).toHaveLength(0);
  });

  it('stops its dose history being readable too', async () => {
    const doses = await t.asUser(OWNER, (db) =>
      db.query<{ id: string }>(`SELECT id FROM dose_event WHERE owned_item_id = $1`, [ITEM]),
    );
    expect(doses.rows).toHaveLength(0);
  });

  it('and yet the bytes are still there, which is what the deadline is a deadline for', async () => {
    // The distinction this file is built around. Inaccessible is not gone; the matrix promises
    // both, at different times, and conflating them is how a product tells somebody their data is
    // deleted while it is still on disk with no stated end date.
    const rows = await t.asOwner((db) =>
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM owned_item WHERE id = $1`, [ITEM]),
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('is not touched by a sweep on the day it was deleted', async () => {
    const report = await t.asRetention((db) => runPurgeSweep(db as unknown as PurgeConnection));
    expect(report.items).toBe(0);
    expect(report.doseEvents).toBe(0);

    const rows = await t.asOwner((db) =>
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM owned_item WHERE id = $1`, [ITEM]),
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('is purged, with its dose history, once it reaches the floor', async () => {
    // Thirty days later, said the only way a test can say it.
    await t.asOwner((db) =>
      db.query(`UPDATE owned_item SET deleted_at = kynviora.purge_floor() WHERE id = $1`, [ITEM]),
    );

    const report = await t.asRetention((db) => runPurgeSweep(db as unknown as PurgeConnection));
    expect(report.items).toBe(1);
    expect(report.doseEvents).toBe(1);

    const rows = await t.asOwner((db) =>
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM owned_item WHERE id = $1`, [ITEM]),
    );
    expect(rows.rows[0]?.n).toBe(0);
    const doses = await t.asOwner((db) =>
      db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM dose_event WHERE owned_item_id = $1`,
        [ITEM],
      ),
    );
    expect(doses.rows[0]?.n).toBe(0);
  });
});
