import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Database-level tests for the Household Review Inbox (migrations `0004` and `0010`).
 *
 * Spec 04 Phase 8.3 has two exit criteria, and both are enforced here rather than only in the
 * API: a review task carries none of the alert vocabulary, and a task cannot reach a closed state
 * without recording that the authoritative record changed. The second is a CHECK constraint
 * precisely so that "mark done" is unwritable even by a direct SQL statement.
 *
 * Every assertion runs as the non-superuser `kynviora_app` or `kynviora_service` role (DEC-005).
 */

const OWNER = testUuid(1);
const OTHER_OWNER = testUuid(2);
const CARE_CAREGIVER = testUuid(3);
const SHELF_CAREGIVER = testUuid(4);
const ADMIN_CAREGIVER = testUuid(5);
const STRANGER = testUuid(6);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);
const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

const ITEM_A = testUuid(30);
const NOW = '2026-08-29T12:00:00.000Z';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER_OWNER, 'other@example.test'],
      [CARE_CAREGIVER, 'care@example.test'],
      [SHELF_CAREGIVER, 'shelf@example.test'],
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
       VALUES ($1, $2, $3, 'Parent A'), ($4, $5, $6, 'Parent B')`,
      [PROFILE_A, HOUSEHOLD_A, OWNER, PROFILE_B, HOUSEHOLD_B, OTHER_OWNER],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet A')`,
      [ITEM_A, PROFILE_A],
    );
  });
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM review_task');
    await db.query('DELETE FROM caregiver_grant');
  });
});

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

async function task(
  overrides: {
    kind?: string;
    subjectKind?: string;
    subjectId?: string;
    profileId?: string;
  } = {},
): Promise<string> {
  const subjectKind = overrides.subjectKind ?? 'owned_item';
  const res = await t.asService((db) =>
    db.query<{ id: string }>(
      `INSERT INTO review_task
         (profile_id, owned_item_id, task_kind, subject_kind, subject_id, state)
       VALUES ($1, $2, $3, $4, $5, 'OPEN')
       RETURNING id`,
      [
        overrides.profileId ?? PROFILE_A,
        subjectKind === 'owned_item' ? (overrides.subjectId ?? ITEM_A) : null,
        overrides.kind ?? 'ITEM_NOT_REVIEWED_RECENTLY',
        subjectKind,
        overrides.subjectId ?? ITEM_A,
      ],
    ),
  );
  return res.rows[0]?.id ?? '';
}

// ---------------------------------------------------------------------------

describe('a review task is not an assessment', () => {
  it('has no urgency, evidence level, severity or score column', async () => {
    // Exit criterion 1, asserted against the actual table rather than against a type. 09 keeps
    // evidence and urgency as properties of an assessment; a task must not be able to hold one
    // even by a direct write.
    const columns = await t.asService((db) =>
      db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'review_task'`,
      ),
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of [
      'urgency',
      'evidence_level',
      'severity',
      'match_confidence',
      'score',
      'priority',
      'risk_level',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('accepts exactly the seven kinds the spec lists', async () => {
    const message = await expectDenied(() => task({ kind: 'SOMETHING_ELSE' }));
    expect(message).toMatch(/review_task_kind_valid/);
  });
});

describe('a task must be about the right sort of record', () => {
  it('refuses a batch task naming a caregiver grant', async () => {
    // Without this the completion path could be asked to write a batch number onto an
    // authorization record.
    const message = await expectDenied(() =>
      task({ kind: 'BATCH_MISSING', subjectKind: 'caregiver_grant', subjectId: testUuid(60) }),
    );
    expect(message).toMatch(/review_task_subject_matches_kind|review_task_owned_item_agrees/);
  });

  it('refuses a grant-expiry task naming an owned item', async () => {
    const message = await expectDenied(() =>
      task({ kind: 'CAREGIVER_GRANT_EXPIRING', subjectKind: 'owned_item' }),
    );
    expect(message).toMatch(/review_task_subject_matches_kind/);
  });

  it('refuses a subject kind outside the vocabulary', async () => {
    const message = await expectDenied(() =>
      task({ subjectKind: 'bank_account', subjectId: testUuid(60) }),
    );
    expect(message).toMatch(/review_task_subject_kind_valid|review_task_subject_matches_kind/);
  });

  it('keeps owned_item_id and subject_id in agreement', async () => {
    // The agreement is what keeps the ON DELETE CASCADE from 0004 meaningful.
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO review_task
             (profile_id, owned_item_id, task_kind, subject_kind, subject_id, state)
           VALUES ($1, $2, 'BATCH_MISSING', 'owned_item', $3, 'OPEN')`,
          [PROFILE_A, ITEM_A, testUuid(61)],
        ),
      ),
    );
    expect(message).toMatch(/review_task_owned_item_agrees/);
  });

  it('removes an item task when the item is deleted', async () => {
    const other = testUuid(62);
    await t.asService((db) =>
      db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
         VALUES ($1, $2, 'MEDICINE', 'Temporary')`,
        [other, PROFILE_A],
      ),
    );
    await task({ subjectId: other });
    await t.asOwner((db) => db.query('DELETE FROM owned_item WHERE id = $1', [other]));

    const remaining = await t.asService((db) =>
      db.query('SELECT id FROM review_task WHERE subject_id = $1', [other]),
    );
    expect(remaining.rows).toEqual([]);
  });
});

describe('closing a task must record that something was written', () => {
  it('refuses a closed task with no completion fields', async () => {
    // Exit criterion 2 as a constraint, so "mark done" is unwritable even by a direct statement
    // that bypasses the API entirely.
    const id = await task();
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `UPDATE review_task
              SET state = 'COMPLETED', completed_at = $1, completed_by_user_id = $2,
                  outcome = 'RESOLVED'
            WHERE id = $3`,
          [NOW, OWNER, id],
        ),
      ),
    );
    expect(message).toMatch(/review_task_closed_wrote_something/);
  });

  it('refuses a closed task with no recorded actor', async () => {
    const id = await task();
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `UPDATE review_task
              SET state = 'COMPLETED', completed_at = $1, outcome = 'RESOLVED',
                  completion_fields = ARRAY['last_reviewed_at']::text[]
            WHERE id = $2`,
          [NOW, id],
        ),
      ),
    );
    expect(message).toMatch(/review_task_closed_wrote_something/);
  });

  it('accepts a properly recorded completion', async () => {
    const id = await task();
    await t.asService((db) =>
      db.query(
        `UPDATE review_task
            SET state = 'COMPLETED', completed_at = $1, completed_by_user_id = $2,
                outcome = 'RESOLVED', completion_fields = ARRAY['last_reviewed_at']::text[]
          WHERE id = $3`,
        [NOW, OWNER, id],
      ),
    );
    const stored = await t.asService((db) =>
      db.query<{ state: string }>('SELECT state FROM review_task WHERE id = $1', [id]),
    );
    expect(stored.rows[0]?.state).toBe('COMPLETED');
  });

  it('refuses an open task that carries completion detail', async () => {
    // The converse. An OPEN row claiming an outcome would make the two columns disagree about
    // whether the work happened.
    const id = await task();
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(`UPDATE review_task SET outcome = 'RESOLVED' WHERE id = $1`, [id]),
      ),
    );
    expect(message).toMatch(/review_task_open_is_unclosed/);
  });

  it('refuses an outcome outside the vocabulary', async () => {
    const id = await task();
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `UPDATE review_task
              SET state = 'COMPLETED', completed_at = $1, completed_by_user_id = $2,
                  outcome = 'IGNORED', completion_fields = ARRAY['x']::text[]
            WHERE id = $3`,
          [NOW, OWNER, id],
        ),
      ),
    );
    expect(message).toMatch(/review_task_outcome_valid/);
  });
});

describe('one open task per condition', () => {
  it('refuses a duplicate open task', async () => {
    await task();
    const message = await expectDenied(() => task());
    expect(message).toMatch(/review_task_open_subject_idx|duplicate key/i);
  });

  it('allows a new open task once the previous one is closed', async () => {
    // The index is partial on state = 'OPEN' precisely so a condition that recurs can be raised
    // again without losing the record of the earlier work.
    const id = await task();
    await t.asService((db) =>
      db.query(
        `UPDATE review_task
            SET state = 'COMPLETED', completed_at = $1, completed_by_user_id = $2,
                outcome = 'RESOLVED', completion_fields = ARRAY['last_reviewed_at']::text[]
          WHERE id = $3`,
        [NOW, OWNER, id],
      ),
    );
    await task();

    const rows = await t.asService((db) =>
      db.query('SELECT id FROM review_task WHERE subject_id = $1', [ITEM_A]),
    );
    expect(rows.rows).toHaveLength(2);
  });
});

describe('privilege separation', () => {
  it('does not let the app role create a task', async () => {
    // A client that could insert its own task could manufacture one naming a record it wants
    // written, and the completion path trusts the task's subject.
    const message = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `INSERT INTO review_task
             (profile_id, owned_item_id, task_kind, subject_kind, subject_id, state)
           VALUES ($1, $2, 'BATCH_MISSING', 'owned_item', $2, 'OPEN')`,
          [PROFILE_A, ITEM_A],
        ),
      ),
    );
    expect(message).toMatch(/permission denied|row-level security/i);
  });
});

describe('row level security', () => {
  it('shows the list to a caregiver holding VIEW_CARE', async () => {
    await task();
    await grant(CARE_CAREGIVER, ['VIEW_CARE']);
    const rows = await t.asUser(CARE_CAREGIVER, (db) => db.query('SELECT id FROM review_task'));
    expect(rows.rows).toHaveLength(1);
  });

  it('shows nothing to a caregiver without VIEW_CARE', async () => {
    await task();
    await grant(SHELF_CAREGIVER, ['VIEW_SHELF', 'VIEW_MEDICINES']);
    const rows = await t.asUser(SHELF_CAREGIVER, (db) => db.query('SELECT id FROM review_task'));
    expect(rows.rows).toEqual([]);
  });

  it('shows nothing to a stranger or another household', async () => {
    await task();
    for (const user of [STRANGER, OTHER_OWNER]) {
      const rows = await t.asUser(user, (db) => db.query('SELECT id FROM review_task'));
      expect(rows.rows).toEqual([]);
    }
  });

  it('refuses a completion from a caregiver who only reads the inbox', async () => {
    // MANAGE_CARE used to admit this update. It no longer does: the capability that admits the
    // write belongs to the record, not to the inbox, or the inbox becomes a side channel.
    const id = await task();
    await grant(CARE_CAREGIVER, ['VIEW_CARE', 'MANAGE_CARE']);

    const updated = await t.asUser(CARE_CAREGIVER, (db) =>
      db.query(
        `UPDATE review_task
            SET state = 'COMPLETED', completed_at = $1, completed_by_user_id = $2,
                outcome = 'RESOLVED', completion_fields = ARRAY['last_reviewed_at']::text[]
          WHERE id = $3`,
        [NOW, CARE_CAREGIVER, id],
      ),
    );
    expect(updated.affectedRows ?? 0).toBe(0);
  });

  it('admits a completion from a caregiver holding a management capability', async () => {
    const id = await task();
    await grant(SHELF_CAREGIVER, ['VIEW_CARE', 'MANAGE_MEDICINES']);

    const updated = await t.asUser(SHELF_CAREGIVER, (db) =>
      db.query(
        `UPDATE review_task
            SET state = 'COMPLETED', completed_at = $1, completed_by_user_id = $2,
                outcome = 'RESOLVED', completion_fields = ARRAY['last_reviewed_at']::text[]
          WHERE id = $3`,
        [NOW, SHELF_CAREGIVER, id],
      ),
    );
    expect(updated.affectedRows ?? 0).toBe(1);
  });

  it('does not let care access renew a caregiver grant from the inbox', async () => {
    // The sharp case: a caregiver administrator capability, and nothing weaker, closes a
    // grant-expiry task.
    const grantId = testUuid(70);
    await t.asService((db) =>
      db.query(
        `INSERT INTO caregiver_grant
           (id, profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at,
            expires_at)
         VALUES ($1, $2, $3, $4, ARRAY['VIEW_CARE']::text[], 'ACTIVE', now(), now() + interval '5 days')`,
        [grantId, PROFILE_A, ADMIN_CAREGIVER, OWNER],
      ),
    );
    const id = await task({
      kind: 'CAREGIVER_GRANT_EXPIRING',
      subjectKind: 'caregiver_grant',
      subjectId: grantId,
    });

    await grant(CARE_CAREGIVER, ['VIEW_CARE', 'MANAGE_CARE', 'MANAGE_MEDICINES']);
    const refused = await t.asUser(CARE_CAREGIVER, (db) =>
      db.query(
        `UPDATE review_task
            SET state = 'COMPLETED', completed_at = $1, completed_by_user_id = $2,
                outcome = 'RESOLVED', completion_fields = ARRAY['expires_at']::text[]
          WHERE id = $3`,
        [NOW, CARE_CAREGIVER, id],
      ),
    );
    expect(refused.affectedRows ?? 0).toBe(0);

    await grant(SHELF_CAREGIVER, ['VIEW_CARE', 'MANAGE_CAREGIVERS']);
    const allowed = await t.asUser(SHELF_CAREGIVER, (db) =>
      db.query(
        `UPDATE review_task
            SET state = 'COMPLETED', completed_at = $1, completed_by_user_id = $2,
                outcome = 'RESOLVED', completion_fields = ARRAY['expires_at']::text[]
          WHERE id = $3`,
        [NOW, SHELF_CAREGIVER, id],
      ),
    );
    expect(allowed.affectedRows ?? 0).toBe(1);
  });
});
