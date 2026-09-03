import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Authorization for the medicine schedule write path (`04` Phase 4.1, `08.2`, migration `0020`).
 *
 * The property under test is that **deciding when somebody is told to take a tablet is a manage
 * capability, not a view one**. Until `0020` the schedule policies asked only whether the caller
 * could see the owned item, which reduces to `VIEW_MEDICINES` - so a caregiver granted read-only
 * access to a person's medicines could have created their reminders, moved them, or deactivated
 * the schedule so that no reminder ever arrived. Nothing caught it because no route wrote a row.
 *
 * `19` requires an automated case for "caregiver missing capability", and this is that case for
 * the table Phase 4.2's reminder engine reads.
 */

const OWNER = testUuid(1);
const VIEWER = testUuid(2); // VIEW_MEDICINES only - may look, must not schedule
const MANAGER = testUuid(3); // VIEW_MEDICINES + MANAGE_MEDICINES
const SHELF_CAREGIVER = testUuid(4); // the shelf capabilities, and neither medicine one
const STRANGER = testUuid(5);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const MEDICINE = testUuid(30);
const SHAMPOO = testUuid(31);

/** Written by the service role in setup, so the read tests have something to fail to see. */
const EXISTING = testUuid(40);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [VIEWER, 'viewer@example.test'],
      [MANAGER, 'manager@example.test'],
      [SHELF_CAREGIVER, 'shelf@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }

    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'Household')`,
      [HOUSEHOLD, OWNER],
    );
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );

    for (const [grantee, capabilities] of [
      [VIEWER, ['VIEW_MEDICINES']],
      [MANAGER, ['VIEW_MEDICINES', 'MANAGE_MEDICINES']],
      [SHELF_CAREGIVER, ['VIEW_SHELF', 'MANAGE_SHELF']],
    ] as const) {
      await db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
        [PROFILE, grantee, OWNER, capabilities],
      );
    }

    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, strength_text, dosage_form)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet', '500 mg', 'tablet')`,
      [MEDICINE, PROFILE],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, personal_care_category)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Gentle Daily Shampoo (synthetic)', 'HAIR_CARE')`,
      [SHAMPOO, PROFILE],
    );

    await db.query(
      `INSERT INTO medicine_schedule (id, owned_item_id, schedule_kind, times_local, timezone)
       VALUES ($1, $2, 'FIXED_TIMES', ARRAY['08:00','20:00'], 'Asia/Kolkata')`,
      [EXISTING, MEDICINE],
    );
  });
});

afterAll(async () => {
  await t.close();
});

/** Insert a schedule as `userId`, returning how many rows row-level security admitted. */
async function insertAs(userId: string, itemId: string = MEDICINE): Promise<number> {
  return t.asUser(userId, async (db) => {
    const res = await db.query(
      `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, times_local, timezone)
       VALUES ($1, 'FIXED_TIMES', ARRAY['09:00'], 'Asia/Kolkata')
       RETURNING id`,
      [itemId],
    );
    return res.rows.length;
  });
}

describe('creating a schedule needs MANAGE_MEDICINES', () => {
  it('lets the profile owner write one', async () => {
    expect(await insertAs(OWNER)).toBe(1);
  });

  it('lets a caregiver holding the capability write one', async () => {
    expect(await insertAs(MANAGER)).toBe(1);
  });

  it('refuses a caregiver who may only look', async () => {
    // The whole point. This caller can read the medicine and its schedule; deciding when a
    // reminder fires is a different thing from being allowed to see that one exists.
    const message = await expectDenied(() => insertAs(VIEWER));
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses a caregiver holding only the shelf capabilities', async () => {
    const message = await expectDenied(() => insertAs(SHELF_CAREGIVER));
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses somebody with no relationship to the profile', async () => {
    const message = await expectDenied(() => insertAs(STRANGER));
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses a schedule on a personal-care item, whoever is asking', async () => {
    // MANAGE_MEDICINES is the wrong capability for a shampoo and MANAGE_SHELF is not a licence to
    // schedule a dose. The table is called `medicine_schedule`; the policy now says so too.
    const message = await expectDenied(() => insertAs(OWNER, SHAMPOO));
    expect(message).toMatch(/row-level security/i);
  });
});

describe('editing a schedule needs MANAGE_MEDICINES', () => {
  /** Update the stored schedule as `userId`, returning how many rows the policy admitted. */
  async function updateAs(userId: string): Promise<number> {
    return t.asUser(userId, async (db) => {
      const res = await db.query(
        `UPDATE medicine_schedule SET times_local = ARRAY['21:00']
          WHERE id = $1 RETURNING id`,
        [EXISTING],
      );
      return res.rows.length;
    });
  }

  /** Deactivate the stored schedule as `userId` - the shape of "stop reminding me". */
  async function deactivateAs(userId: string): Promise<number> {
    return t.asUser(userId, async (db) => {
      const res = await db.query(
        `UPDATE medicine_schedule SET active = false WHERE id = $1 RETURNING id`,
        [EXISTING],
      );
      return res.rows.length;
    });
  }

  it('lets a caregiver holding the capability move a time', async () => {
    expect(await updateAs(MANAGER)).toBe(1);
  });

  it('changes nothing for a caregiver who may only look', async () => {
    // An UPDATE whose USING clause admits no row is zero rows, not an error - which is why the
    // route re-reads to tell this apart from a version conflict rather than reporting one.
    expect(await updateAs(VIEWER)).toBe(0);
  });

  it('does not let a viewer switch the reminders off', async () => {
    // The dangerous direction. Silently turning a schedule off is the failure a person would
    // never see: no error, no reminder, and a medicine they believe they are being told about.
    expect(await deactivateAs(VIEWER)).toBe(0);
    const stillActive = await t.asService((db) =>
      db.query<{ active: boolean }>(`SELECT active FROM medicine_schedule WHERE id = $1`, [
        EXISTING,
      ]),
    );
    expect(stillActive.rows[0]?.active).toBe(true);
  });
});

describe('reading a schedule needs only that the medicine is readable', () => {
  async function visibleTo(userId: string): Promise<number> {
    return t.asUser(userId, async (db) => {
      const res = await db.query(`SELECT id FROM medicine_schedule WHERE owned_item_id = $1`, [
        MEDICINE,
      ]);
      return res.rows.length;
    });
  }

  it('shows a viewing caregiver when the medicine is meant to be taken', async () => {
    // The asymmetry is deliberate: seeing a schedule and setting one are different permissions.
    expect(await visibleTo(VIEWER)).toBeGreaterThan(0);
  });

  it('shows nothing to a caregiver scoped to the shelf', async () => {
    expect(await visibleTo(SHELF_CAREGIVER)).toBe(0);
  });

  it('shows nothing to a stranger', async () => {
    expect(await visibleTo(STRANGER)).toBe(0);
  });
});

describe('the idempotency key is scoped to the item, not to the world', () => {
  const KEY = testUuid(50);

  it('refuses the same key twice on one medicine', async () => {
    await t.asService((db) =>
      db.query(
        `INSERT INTO medicine_schedule
           (owned_item_id, schedule_kind, times_local, timezone, client_operation_id)
         VALUES ($1, 'FIXED_TIMES', ARRAY['07:00'], 'Asia/Kolkata', $2)`,
        [MEDICINE, KEY],
      ),
    );

    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO medicine_schedule
             (owned_item_id, schedule_kind, times_local, timezone, client_operation_id)
           VALUES ($1, 'FIXED_TIMES', ARRAY['07:00'], 'Asia/Kolkata', $2)`,
          [MEDICINE, KEY],
        ),
      ),
    );
    expect(message).toMatch(/medicine_schedule_idempotency/i);
  });

  it('admits the same key on a different medicine', async () => {
    // DEC-079's reasoning. Under a global index, one household's key would make another
    // household's write fail, whose replay read then finds nothing under RLS - and the schedule
    // is dropped silently, which for this table means a reminder that never arrives.
    const other = testUuid(51);
    await t.asService((db) =>
      db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
         VALUES ($1, $2, 'MEDICINE', 'Second Synthetic Tablet')`,
        [other, PROFILE],
      ),
    );

    const res = await t.asService((db) =>
      db.query(
        `INSERT INTO medicine_schedule
           (owned_item_id, schedule_kind, times_local, timezone, client_operation_id)
         VALUES ($1, 'FIXED_TIMES', ARRAY['07:00'], 'Asia/Kolkata', $2)
         RETURNING id`,
        [other, KEY],
      ),
    );
    expect(res.rows).toHaveLength(1);
  });

  it('lets many rows carry no key at all', async () => {
    // The index is partial, so an absent key is not a key every row shares.
    const rows = await t.asService((db) =>
      db.query(`SELECT id FROM medicine_schedule WHERE client_operation_id IS NULL`),
    );
    expect(rows.rows.length).toBeGreaterThan(1);
  });
});

describe('a schedule starts at version 1', () => {
  it('gives every row a version the client can send back', async () => {
    const res = await t.asService((db) =>
      db.query<{ version: number }>(`SELECT version FROM medicine_schedule WHERE id = $1`, [
        EXISTING,
      ]),
    );
    expect(res.rows[0]?.version).toBe(1);
  });

  it('refuses a version below one', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(`UPDATE medicine_schedule SET version = 0 WHERE id = $1`, [EXISTING]),
      ),
    );
    expect(message).toMatch(/schedule_version_positive/i);
  });
});
