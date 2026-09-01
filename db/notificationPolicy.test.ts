import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';
import { ACTION_URGENCIES, REVALIDATION_OUTCOMES } from '@kynviora/domain';

/**
 * Database-level tests for notification policy and revalidation (migration `0014`).
 *
 * `04` Phase 7.5's two exit criteria are decided in `@kynviora/domain` and enforced on the read
 * path. What the schema has to carry is narrower and is what these assert: a quiet-hours window
 * that cannot be half-set or ambiguous, a revalidation record nobody can edit afterwards, and no
 * column anywhere that could hold what a notification said.
 *
 * Every assertion runs as the non-superuser `kynviora_app` or `kynviora_service` role (DEC-005).
 */

const OWNER = testUuid(1);
const OTHER = testUuid(2);
const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const ITEM = testUuid(30);
const RULE = testUuid(40);

const NOW = '2026-09-02T12:00:00.000Z';

let t: TestDb;
let alertId = '';

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER, 'other@example.test'],
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
       VALUES ($1, $2, $3, 'Parent A (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet')`,
      [ITEM, PROFILE],
    );
    await db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id)
       VALUES ($1, 'synthetic.notify', '1.0.0', 'EXPIRY', 'A', 'HIGH',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.expiry')`,
      [RULE],
    );
    const assessment = await db.query<{ id: string }>(
      `INSERT INTO profile_assessment
         (profile_id, owned_item_id, rule_version_id, matched, match_confidence, reasons,
          evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at)
       VALUES ($1, $2, $3, true, 'EXACT', ARRAY['PRODUCT_EXPIRED']::text[], 'A', 'HIGH',
               'tpl.expiry', 'norm-1', $4)
       RETURNING id`,
      [PROFILE, ITEM, RULE, NOW],
    );
    const alert = await db.query<{ id: string }>(
      `INSERT INTO alert_publication (assessment_id, profile_id, published_at, dedupe_key)
       VALUES ($1, $2, $3, 'notify-db') RETURNING id`,
      [assessment.rows[0]?.id ?? '', PROFILE, NOW],
    );
    alertId = alert.rows[0]?.id ?? '';

    await db.query(`INSERT INTO profile_notification_policy (profile_id) VALUES ($1)`, [PROFILE]);
  });
});

afterAll(async () => {
  await t.close();
});

async function setQuietHours(start: number | null, end: number | null): Promise<void> {
  await t.asService((db) =>
    db.query(
      `UPDATE profile_notification_policy
          SET quiet_hours_start_minute = $2, quiet_hours_end_minute = $3
        WHERE profile_id = $1`,
      [PROFILE, start, end],
    ),
  );
}

describe('quiet hours on the policy row', () => {
  it('starts unset, so Kynviora decides when nobody sleeps', async () => {
    const row = await t.asService((db) =>
      db.query<{ quiet_hours_start_minute: number | null }>(
        'SELECT quiet_hours_start_minute FROM profile_notification_policy WHERE profile_id = $1',
        [PROFILE],
      ),
    );
    expect(row.rows[0]?.quiet_hours_start_minute).toBeNull();
  });

  it('accepts a window that wraps past midnight', async () => {
    await setQuietHours(22 * 60, 7 * 60);
    const row = await t.asService((db) =>
      db.query<{ quiet_hours_start_minute: number; quiet_hours_end_minute: number }>(
        `SELECT quiet_hours_start_minute, quiet_hours_end_minute
           FROM profile_notification_policy WHERE profile_id = $1`,
        [PROFILE],
      ),
    );
    expect(row.rows[0]?.quiet_hours_start_minute).toBe(1320);
    expect(row.rows[0]?.quiet_hours_end_minute).toBe(420);
  });

  it('refuses one bound alone', async () => {
    // A window whose other end the reader has to invent, and the thing being invented is whether
    // somebody is woken up.
    await expectDenied(() => setQuietHours(22 * 60, null));
    await expectDenied(() => setQuietHours(null, 7 * 60));
  });

  it('refuses equal bounds', async () => {
    await expectDenied(() => setQuietHours(600, 600));
  });

  it('refuses a bound outside the day', async () => {
    await expectDenied(() => setQuietHours(-1, 60));
    await expectDenied(() => setQuietHours(0, 1440));
  });

  it('can be cleared', async () => {
    await setQuietHours(22 * 60, 7 * 60);
    await setQuietHours(null, null);
    const row = await t.asService((db) =>
      db.query<{ quiet_hours_end_minute: number | null }>(
        'SELECT quiet_hours_end_minute FROM profile_notification_policy WHERE profile_id = $1',
        [PROFILE],
      ),
    );
    expect(row.rows[0]?.quiet_hours_end_minute).toBeNull();
  });

  it('is not writable by the app role at all', async () => {
    // `16` gives the owner the say over how much of their health information leaves the app, and
    // 0009 already routes every policy write through the service role. Adding columns must not
    // have quietly added a grant.
    await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `UPDATE profile_notification_policy SET quiet_hours_start_minute = 0,
                  quiet_hours_end_minute = 60 WHERE profile_id = $1`,
          [PROFILE],
        ),
      ),
    );
  });
});

describe('the device-urgency floor', () => {
  it('admits exactly the urgency vocabulary', async () => {
    const definition = await t.asService((db) =>
      db.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint WHERE conname = 'notification_min_urgency_valid'`,
      ),
    );
    const def = definition.rows[0]?.def ?? '';
    expect(def).not.toBe('');
    const listed = [...def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(listed)].sort()).toEqual([...ACTION_URGENCIES].sort());
  });

  it('refuses a value from outside it', async () => {
    await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `UPDATE profile_notification_policy SET min_urgency_for_device = 'URGENT'
            WHERE profile_id = $1`,
          [PROFILE],
        ),
      ),
    );
  });
});

describe('the revalidation record', () => {
  it('admits exactly the domain outcome vocabulary', async () => {
    const definition = await t.asService((db) =>
      db.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint WHERE conname = 'revalidation_outcome_valid'`,
      ),
    );
    const listed = [...(definition.rows[0]?.def ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(listed)].sort()).toEqual([...REVALIDATION_OUTCOMES].sort());
  });

  it('cannot be edited or deleted once written', async () => {
    await t.asService((db) =>
      db.query(
        `INSERT INTO notification_revalidation
           (alert_publication_id, opened_by_user_id, notified_at, revalidated_at, outcome)
         VALUES ($1, $2, $3, $4, 'STILL_CURRENT')`,
        [alertId, OWNER, NOW, NOW],
      ),
    );
    // A table that could be edited afterwards is unable to answer the question it exists for.
    await expectDenied(() =>
      t.asService((db) => db.query(`UPDATE notification_revalidation SET outcome = 'WITHDRAWN'`)),
    );
    await expectDenied(() =>
      t.asService((db) => db.query('DELETE FROM notification_revalidation')),
    );
  });

  it('is readable by the person who opened it and by nobody else', async () => {
    const mine = await t.asUser(OWNER, (db) =>
      db.query('SELECT id FROM notification_revalidation WHERE alert_publication_id = $1', [
        alertId,
      ]),
    );
    expect(mine.rows.length).toBeGreaterThan(0);

    const theirs = await t.asUser(OTHER, (db) =>
      db.query('SELECT id FROM notification_revalidation WHERE alert_publication_id = $1', [
        alertId,
      ]),
    );
    // One person's notification history is not another's business (`16`), and this is not scoped
    // by the profile: a caregiver who never received the notification never opened it.
    expect(theirs.rows).toEqual([]);
  });

  it('gives the app role no way to write one', async () => {
    await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `INSERT INTO notification_revalidation
             (alert_publication_id, opened_by_user_id, notified_at, revalidated_at, outcome)
           VALUES ($1, $2, $3, $4, 'STILL_CURRENT')`,
          [alertId, OWNER, NOW, NOW],
        ),
      ),
    );
  });

  it('has no column that could hold what the notification said', async () => {
    const columns = await t.asService((db) =>
      db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'notification_revalidation'`,
      ),
    );
    const names = columns.rows.map((r) => r.column_name);
    // `15` A6 is about the exact string written to be readable on a lock screen. It is not stored
    // in `alert_delivery` and it is not stored here either, and `20` keeps the subject out too.
    for (const forbidden of ['body', 'title', 'message', 'profile_id', 'item_name', 'medicine']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
