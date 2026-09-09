import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Who may keep a comparison, who may read one, and what happens to it when its subject is deleted.
 *
 * Spec references: `08.2` (capabilities are separately scoped), `13`, `14` (least privilege), `16`
 * (retention), `docs/RETENTION.md`, `0034`, DEC-163.
 *
 * THE RULE THIS FILE EXISTS FOR
 * A saved comparison holds product names and ingredient terms frozen at the moment somebody read
 * them. So it is shelf content that outlives the read - and the failure that would matter is a
 * report describing a product its owner asked to be forgotten. That is not a policy question, it
 * is a sweep question, and the last test is the one that answers it.
 */

const OWNER = testUuid(1);
const SHELF_CAREGIVER = testUuid(2); // VIEW_SHELF only
const MEDICINE_CAREGIVER = testUuid(3); // VIEW_MEDICINES only
const STRANGER = testUuid(4);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const SHAMPOO = testUuid(30);
const CONDITIONER = testUuid(31);
const COMPARISON = testUuid(40);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [SHELF_CAREGIVER, 'shelf@example.test'],
      [MEDICINE_CAREGIVER, 'medicine@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
    await db.query(`INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'H')`, [
      HOUSEHOLD,
      OWNER,
    ]);
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );
    for (const [grantee, capabilities] of [
      [SHELF_CAREGIVER, ['VIEW_SHELF']],
      [MEDICINE_CAREGIVER, ['VIEW_MEDICINES']],
    ] as const) {
      await db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, $4::text[], 'ACTIVE', now())`,
        [PROFILE, grantee, OWNER, capabilities],
      );
    }
    for (const [id, name] of [
      [SHAMPOO, 'Synthetic Shampoo'],
      [CONDITIONER, 'Synthetic Conditioner'],
    ] as const) {
      await db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name, personal_care_category)
         VALUES ($1, $2, 'PERSONAL_CARE', $3, 'HAIR_CARE')`,
        [id, PROFILE, name],
      );
    }
  });
});

afterAll(async () => {
  await t.close();
});

/** A saved comparison of the two products, taken by whoever is asked to take it. */
async function save(id: string, takenBy: string): Promise<void> {
  await t.asUser(takenBy, async (db) => {
    await db.query(
      `INSERT INTO saved_comparison (id, profile_id, taken_by_user_id, title, report)
       VALUES ($1, $2, $3, 'Two shampoos', $4::jsonb)`,
      [id, PROFILE, takenBy, JSON.stringify({ shared: [], differing: [] })],
    );
    for (const [position, item] of [SHAMPOO, CONDITIONER].entries()) {
      await db.query(
        `INSERT INTO saved_comparison_item (comparison_id, owned_item_id, position)
         VALUES ($1, $2, $3)`,
        [id, item, position],
      );
    }
  });
}

describe('keeping a comparison', () => {
  it('lets the owner take one', async () => {
    await save(COMPARISON, OWNER);
    const rows = await t.asUser(OWNER, (db) =>
      db.query<{ id: string }>('SELECT id FROM saved_comparison'),
    );
    expect(rows.rows.map((row) => row.id)).toEqual([COMPARISON]);
  });

  it('lets a caregiver who may read the shelf take and read one', async () => {
    // Reading and keeping what you read are the same act. Gating this on `MANAGE_SHELF` would be
    // a write capability standing in for a read one, which is the `DEV-049` shape.
    const theirs = testUuid(41);
    await save(theirs, SHELF_CAREGIVER);
    const rows = await t.asUser(SHELF_CAREGIVER, (db) =>
      db.query<{ id: string }>('SELECT id FROM saved_comparison ORDER BY id'),
    );
    expect(rows.rows.map((row) => row.id)).toContain(theirs);
    expect(rows.rows.map((row) => row.id)).toContain(COMPARISON);
  });

  it('shows nothing to a caregiver scoped to medicines', async () => {
    // `08.2`: a grant for somebody's medicines is not a grant for their bathroom cabinet, and a
    // saved comparison is shelf content whatever it happens to be about.
    const rows = await t.asUser(MEDICINE_CAREGIVER, (db) =>
      db.query('SELECT id FROM saved_comparison'),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('shows nothing to a stranger', async () => {
    const rows = await t.asUser(STRANGER, (db) => db.query('SELECT id FROM saved_comparison'));
    expect(rows.rows).toHaveLength(0);
  });

  it('refuses a report that claims somebody else took it', async () => {
    // An access history that recorded who the writer *said* acted would be a record of a claim.
    const message = await expectDenied(() =>
      t.asUser(SHELF_CAREGIVER, (db) =>
        db.query(
          `INSERT INTO saved_comparison (profile_id, taken_by_user_id, report)
           VALUES ($1, $2, '{}'::jsonb)`,
          [PROFILE, OWNER],
        ),
      ),
    );
    expect(message).toMatch(/row-level security|policy/i);
  });

  it('refuses a body that is not an object', async () => {
    // The last place a shape no reader can render can be refused rather than crash a screen.
    const message = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `INSERT INTO saved_comparison (profile_id, taken_by_user_id, report)
           VALUES ($1, $2, '[]'::jsonb)`,
          [PROFILE, OWNER],
        ),
      ),
    );
    expect(message).toMatch(/report_is_object/i);
  });

  it('refuses a fifth column', async () => {
    const message = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `INSERT INTO saved_comparison_item (comparison_id, owned_item_id, position)
           VALUES ($1, $2, 4)`,
          [COMPARISON, SHAMPOO],
        ),
      ),
    );
    expect(message).toMatch(/position_valid|duplicate key/i);
  });
});

describe('what happens when a product it is about is deleted', () => {
  it('the sweep takes the whole report, not just the link row', async () => {
    // A report describing a product somebody asked to be forgotten is that product surviving in a
    // different table - and the frozen body carries its name, so a report with a dangling column
    // would be worse than one that is gone.
    const { runPurgeSweep } = await import('./src/retention.js');

    // As the service role: `owned_item_update`'s WITH CHECK does not admit a row a person has just
    // marked deleted, which is `0004` keeping the app out of the retention clock rather than a
    // gap. What matters here is the state, not who wrote it.
    await t.asService((db) =>
      db.query(`UPDATE owned_item SET deleted_at = now() - interval '400 days' WHERE id = $1`, [
        SHAMPOO,
      ]),
    );

    const report = await t.asRetention((db) => runPurgeSweep(db));
    expect(report.savedComparisons).toBeGreaterThanOrEqual(1);

    const left = await t.asUser(OWNER, (db) => db.query('SELECT id FROM saved_comparison'));
    expect(left.rows).toHaveLength(0);
  });
});
