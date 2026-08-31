import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Authorization tests for the Unified Health Shelf and medicine care records.
 *
 * The property under test is **capability scoping**, not merely profile access. Spec 08.2
 * requires a caregiver's safety-alert permission to be separate from shelf, medicine and export
 * access, and spec 19 requires an automated case for "caregiver missing capability".
 *
 * The sharpest case here: a caregiver granted VIEW_SHELF can see personal-care items but must
 * NOT see the medicine list, because medicines carry a separate capability.
 */

const OWNER = testUuid(1);
const SHELF_CAREGIVER = testUuid(2); // VIEW_SHELF only
const MEDICINE_CAREGIVER = testUuid(3); // VIEW_MEDICINES only
const SAFETY_CAREGIVER = testUuid(4); // VIEW_SAFETY only
const STRANGER = testUuid(5);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const SHAMPOO = testUuid(30);
const MEDICINE = testUuid(31);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [SHELF_CAREGIVER, 'shelf@example.test'],
      [MEDICINE_CAREGIVER, 'medicine@example.test'],
      [SAFETY_CAREGIVER, 'safety@example.test'],
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
      [SHELF_CAREGIVER, ['VIEW_SHELF', 'MANAGE_SHELF']],
      [MEDICINE_CAREGIVER, ['VIEW_MEDICINES']],
      [SAFETY_CAREGIVER, ['VIEW_SAFETY']],
    ] as const) {
      await db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
        [PROFILE, grantee, OWNER, capabilities],
      );
    }

    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, personal_care_category)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Gentle Daily Shampoo (synthetic)', 'HAIR_CARE')`,
      [SHAMPOO, PROFILE],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, strength_text, dosage_form)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet', '500 mg', 'tablet')`,
      [MEDICINE, PROFILE],
    );
  });
});

afterAll(async () => {
  await t.close();
});

describe('capability scoping on the Shelf (spec 08.2, 19)', () => {
  it('lets the owner see both item kinds', async () => {
    const res = await t.asUser(OWNER, (db) =>
      db.query<{ id: string }>('SELECT id FROM owned_item ORDER BY item_kind'),
    );
    expect(res.rows.map((r) => r.id).sort()).toEqual([SHAMPOO, MEDICINE].sort());
  });

  it('shows a VIEW_SHELF caregiver personal care but NOT medicines', async () => {
    // The sharpest capability boundary: shelf access is not medicine access.
    const res = await t.asUser(SHELF_CAREGIVER, (db) =>
      db.query<{ id: string; item_kind: string }>('SELECT id, item_kind FROM owned_item'),
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.id).toBe(SHAMPOO);
    expect(res.rows[0]?.item_kind).toBe('PERSONAL_CARE');
  });

  it('shows a VIEW_MEDICINES caregiver medicines but NOT personal care', async () => {
    const res = await t.asUser(MEDICINE_CAREGIVER, (db) =>
      db.query<{ id: string }>('SELECT id FROM owned_item'),
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.id).toBe(MEDICINE);
  });

  it('shows a VIEW_SAFETY-only caregiver no shelf items at all', async () => {
    // A caregiver permitted to receive safety alerts has no business reading the inventory.
    const res = await t.asUser(SAFETY_CAREGIVER, (db) => db.query('SELECT id FROM owned_item'));
    expect(res.rows).toEqual([]);
  });

  it('shows a stranger nothing', async () => {
    const res = await t.asUser(STRANGER, (db) => db.query('SELECT id FROM owned_item'));
    expect(res.rows).toEqual([]);
  });

  it('prevents a VIEW_MEDICINES caregiver writing, since they lack MANAGE_MEDICINES', async () => {
    const res = await t.asUser(MEDICINE_CAREGIVER, (db) =>
      db.query(`UPDATE owned_item SET display_name = 'Renamed' WHERE id = $1`, [MEDICINE]),
    );
    expect(res.affectedRows).toBe(0);
  });

  it('prevents a MANAGE_SHELF caregiver creating a medicine', async () => {
    // Shelf management does not confer medicine management.
    const message = await expectDenied(() =>
      t.asUser(SHELF_CAREGIVER, (db) =>
        db.query(
          `INSERT INTO owned_item (profile_id, item_kind, display_name)
           VALUES ($1, 'MEDICINE', 'Smuggled Medicine')`,
          [PROFILE],
        ),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('allows a MANAGE_SHELF caregiver to create a personal-care item', async () => {
    const res = await t.asUser(SHELF_CAREGIVER, (db) =>
      db.query(
        `INSERT INTO owned_item (profile_id, item_kind, display_name, personal_care_category)
         VALUES ($1, 'PERSONAL_CARE', 'Added By Caregiver', 'SKIN_CARE') RETURNING id`,
        [PROFILE],
      ),
    );
    expect(res.rows).toHaveLength(1);

    await t.asOwner((db) =>
      db.query(`DELETE FROM owned_item WHERE display_name = 'Added By Caregiver'`),
    );
  });
});

describe('health context requires the medicines capability', () => {
  const ALLERGY = testUuid(40);

  beforeEach(async () => {
    await t.asOwner((db) => db.query('DELETE FROM allergy_record'));
    await t.asService((db) =>
      db.query(
        `INSERT INTO allergy_record (id, profile_id, record_kind, display_term, provenance)
         VALUES ($1, $2, 'SENSITIVITY', 'salicylates', 'USER_REPORTED')`,
        [ALLERGY, PROFILE],
      ),
    );
  });

  it('is visible to the owner', async () => {
    const res = await t.asUser(OWNER, (db) => db.query('SELECT id FROM allergy_record'));
    expect(res.rows).toHaveLength(1);
  });

  it('is visible to a VIEW_MEDICINES caregiver', async () => {
    const res = await t.asUser(MEDICINE_CAREGIVER, (db) =>
      db.query('SELECT id FROM allergy_record'),
    );
    expect(res.rows).toHaveLength(1);
  });

  it('is NOT visible to a shelf-only caregiver', async () => {
    // Health context is the most sensitive profile data; shelf access must not reach it.
    const res = await t.asUser(SHELF_CAREGIVER, (db) => db.query('SELECT id FROM allergy_record'));
    expect(res.rows).toEqual([]);
  });

  it('is NOT visible to a safety-only caregiver', async () => {
    const res = await t.asUser(SAFETY_CAREGIVER, (db) => db.query('SELECT id FROM allergy_record'));
    expect(res.rows).toEqual([]);
  });

  it('does not allow a provenance implying clinician confirmation', async () => {
    // Spec 04 Phase 1.3: no fact silently becomes a confirmed diagnosis. CLINICIAN_CONFIRMED is
    // deliberately absent from the vocabulary until a verified source exists.
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO allergy_record (profile_id, record_kind, display_term, provenance)
           VALUES ($1, 'ALLERGY', 'penicillin', 'CLINICIAN_CONFIRMED')`,
          [PROFILE],
        ),
      ),
    );
    expect(message).toMatch(/provenance_valid/i);
  });
});

describe('dose event idempotency (spec 13)', () => {
  const OP = testUuid(50);

  it('commits a retried upload exactly once', async () => {
    await t.asService((db) =>
      db.query(
        `INSERT INTO dose_event (owned_item_id, event_kind, client_operation_id)
         VALUES ($1, 'TAKEN', $2)`,
        [MEDICINE, OP],
      ),
    );

    // The offline client retries the same operation.
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO dose_event (owned_item_id, event_kind, client_operation_id)
           VALUES ($1, 'TAKEN', $2)`,
          [MEDICINE, OP],
        ),
      ),
    );
    expect(message).toMatch(/duplicate key|dose_event_idempotency/i);

    const count = await t.asService((db) =>
      db.query<{ c: number }>(
        'SELECT count(*)::int AS c FROM dose_event WHERE client_operation_id = $1',
        [OP],
      ),
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('keeps dose events append-only', async () => {
    const message = await expectDenied(() =>
      t.asOwner((db) => db.query(`UPDATE dose_event SET event_kind = 'SKIPPED'`)),
    );
    expect(message).toMatch(/append-only/i);
  });
});

describe('schedule integrity (spec 04 Phase 4.1)', () => {
  it('rejects an as-needed schedule carrying fixed times', async () => {
    // As-needed must be separated from fixed reminders, or a reminder engine would fire on it.
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, times_local)
           VALUES ($1, 'AS_NEEDED', ARRAY['08:00'])`,
          [MEDICINE],
        ),
      ),
    );
    expect(message).toMatch(/as_needed_has_no_times/i);
  });

  it('rejects a fixed schedule with no times', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, times_local)
           VALUES ($1, 'FIXED_TIMES', ARRAY[]::text[])`,
          [MEDICINE],
        ),
      ),
    );
    expect(message).toMatch(/fixed_has_times/i);
  });

  it('rejects a malformed time', async () => {
    for (const bad of ['25:00', '8:00', '08:60', 'morning']) {
      const message = await expectDenied(() =>
        t.asService((db) =>
          db.query(
            `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, times_local)
             VALUES ($1, 'FIXED_TIMES', ARRAY[$2])`,
            [MEDICINE, bad],
          ),
        ),
      );
      expect(message).toMatch(/times_well_formed/i);
    }
  });

  it('accepts well-formed times', async () => {
    const res = await t.asService((db) =>
      db.query(
        `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, times_local)
         VALUES ($1, 'FIXED_TIMES', ARRAY['00:00','08:30','23:59']) RETURNING id`,
        [MEDICINE],
      ),
    );
    expect(res.rows).toHaveLength(1);
  });

  it('rejects an invalid weekday', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, times_local, days_of_week)
           VALUES ($1, 'SELECTED_DAYS', ARRAY['08:00'], ARRAY[0,8])`,
          [MEDICINE],
        ),
      ),
    );
    expect(message).toMatch(/days_valid/i);
  });
});

describe('item kind integrity', () => {
  it('rejects a personal-care item carrying a dosage form', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO owned_item (profile_id, item_kind, display_name, dosage_form)
           VALUES ($1, 'PERSONAL_CARE', 'Confused Item', 'tablet')`,
          [PROFILE],
        ),
      ),
    );
    expect(message).toMatch(/category_matches_kind/i);
  });

  it('rejects a medicine carrying a personal-care category', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO owned_item (profile_id, item_kind, display_name, personal_care_category)
           VALUES ($1, 'MEDICINE', 'Confused Medicine', 'SKIN_CARE')`,
          [PROFILE],
        ),
      ),
    );
    expect(message).toMatch(/category_matches_kind/i);
  });

  it('keeps the three verification facets independent', async () => {
    // Spec 08 Product Trust Passport: identity, formulation and batch confidence are separate.
    const id = testUuid(60);
    await t.asService((db) =>
      db.query(
        `INSERT INTO owned_item
           (id, profile_id, item_kind, display_name, personal_care_category,
            identity_verification, formulation_verification, batch_verification)
         VALUES ($1, $2, 'PERSONAL_CARE', 'Mixed Confidence', 'SKIN_CARE',
                 'CONFIRMED', 'UNVERIFIED', 'CONFLICTING')`,
        [id, PROFILE],
      ),
    );

    const res = await t.asUser(OWNER, (db) =>
      db.query<{
        identity_verification: string;
        formulation_verification: string;
        batch_verification: string;
      }>(
        `SELECT identity_verification, formulation_verification, batch_verification
         FROM owned_item WHERE id = $1`,
        [id],
      ),
    );

    expect(res.rows[0]?.identity_verification).toBe('CONFIRMED');
    expect(res.rows[0]?.formulation_verification).toBe('UNVERIFIED');
    expect(res.rows[0]?.batch_verification).toBe('CONFLICTING');
  });
});

describe('review tasks are separate from safety alerts (spec 04 Phase 8.3)', () => {
  it('carries no urgency or evidence column', async () => {
    const res = await t.asOwner((db) =>
      db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'review_task'`,
      ),
    );
    const columns = res.rows.map((r) => r.column_name);
    for (const forbidden of ['urgency', 'severity', 'evidence_level', 'match_confidence']) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('requires the care capability, not the shelf capability', async () => {
    await t.asService((db) =>
      db.query(
        // `0010` generalised the subject so a task can be about a grant or an alert as well as an
        // item, and made it NOT NULL. For an owned-item task the two columns hold the same value,
        // which is what keeps the ON DELETE CASCADE from this migration meaningful.
        `INSERT INTO review_task
           (profile_id, owned_item_id, task_kind, subject_kind, subject_id)
         VALUES ($1, $2, 'BATCH_MISSING', 'owned_item', $2)`,
        [PROFILE, SHAMPOO],
      ),
    );

    const owner = await t.asUser(OWNER, (db) => db.query('SELECT id FROM review_task'));
    expect(owner.rows.length).toBeGreaterThan(0);

    const shelfOnly = await t.asUser(SHELF_CAREGIVER, (db) =>
      db.query('SELECT id FROM review_task'),
    );
    expect(shelfOnly.rows).toEqual([]);
  });
});
