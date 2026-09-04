import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Retention and deletion, measured against the real policy as the real roles (DEC-117,
 * `DEV-036`, `DEV-056`, `docs/RETENTION.md`).
 *
 * Spec 16 requires a retention matrix and an enumerated deletion behaviour; spec 14 requires
 * least privilege and an append-only audit; spec 19 makes deny-by-default RLS negative tests
 * release-gating.
 *
 * THREE QUESTIONS THIS FILE EXISTS TO ANSWER, AND WHY NONE OF THEM COULD BE ANSWERED BEFORE
 *
 * 1. **Can a caregiver delete?** `docs/RETENTION.md` section 2 says no capability authorizes
 *    deletion, `MANAGE_MEDICINES` named. Until `0022` there was nothing to measure, because
 *    nothing wrote `deleted_at` - and the answer would have been **yes**, through the table-wide
 *    UPDATE grant `0004` gives `kynviora_app`. A deletion route shipped without `0022`'s
 *    restrictive policy would have carried that.
 *
 * 2. **Does the audit survive a deletion, and does it eventually stop surviving?** Both halves
 *    matter. An audit log that a deletion erases cannot be investigated; one that is never
 *    purged is an indefinite retention nobody approved.
 *
 * 3. **Is the door exactly one door?** The retention role must be able to purge an old row and
 *    nothing else - not a recent row, not an UPDATE, not another table. A role with a `DELETE`
 *    grant and a policy nobody tested is a role that has whatever the policy actually says.
 *
 * Every assertion runs as a non-superuser role; the harness fails the test if that is not true
 * (DEC-005). `asOwner` is used only where the point is specifically to *bypass* RLS and show
 * that the trigger still refuses.
 */

const OWNER = testUuid(1);
const CAREGIVER = testUuid(2);
const STRANGER = testUuid(3);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const MEDICINE = testUuid(30);
const PERSONAL_CARE = testUuid(31);
const SECOND_MEDICINE = testUuid(32);

let t: TestDb;

/** Twenty-five months ago - past the 24-month gate. */
const OLD = `now() - interval '25 months'`;
/** One month ago - inside it. */
const RECENT = `now() - interval '1 month'`;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [CAREGIVER, 'caregiver@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }

    await db.query(`INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, $3)`, [
      HOUSEHOLD,
      OWNER,
      'Household',
    ]);
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, $4)`,
      [PROFILE, HOUSEHOLD, OWNER, 'Person'],
    );

    // A caregiver holding the two capabilities that come closest to permitting a delete. If
    // either of them can, the restrictive policy is not doing its job.
    await db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
      [
        PROFILE,
        CAREGIVER,
        OWNER,
        ['VIEW_SHELF', 'MANAGE_SHELF', 'VIEW_MEDICINES', 'MANAGE_MEDICINES'],
      ],
    );

    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
       VALUES ($1, $2, 'MEDICINE', 'Tablet A'),
              ($3, $2, 'PERSONAL_CARE', 'Shampoo B'),
              ($4, $2, 'MEDICINE', 'Tablet C')`,
      [MEDICINE, PROFILE, PERSONAL_CARE, SECOND_MEDICINE],
    );
  });
});

afterAll(async () => {
  await t?.close();
});

// ---------------------------------------------------------------------------
// The retention role holds one privilege
// ---------------------------------------------------------------------------

describe('the retention role', () => {
  it('is not a superuser and cannot log in', async () => {
    const res = await t.asOwner((db) =>
      db.query<{ rolsuper: boolean; rolcanlogin: boolean }>(
        `SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = 'kynviora_retention'`,
      ),
    );
    expect(res.rows[0]).toEqual({ rolsuper: false, rolcanlogin: false });
  });

  it('is a member of neither other role', async () => {
    // The whole point of a third role is that reaching it does not reach the other two. If it
    // inherited `kynviora_service` it would carry every service grant and this file would be
    // measuring a synonym.
    const res = await t.asOwner((db) =>
      db.query<{ app: boolean; service: boolean }>(
        `SELECT pg_has_role('kynviora_retention', 'kynviora_app', 'MEMBER') AS app,
                pg_has_role('kynviora_retention', 'kynviora_service', 'MEMBER') AS service`,
      ),
    );
    expect(res.rows[0]).toEqual({ app: false, service: false });
  });

  it('holds a grant on exactly the two retained tables and nothing else', async () => {
    const res = await t.asOwner((db) =>
      db.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type
           FROM information_schema.table_privileges
          WHERE grantee = 'kynviora_retention'
          ORDER BY table_name, privilege_type`,
      ),
    );
    const byTable = new Map<string, string[]>();
    for (const row of res.rows) {
      byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.privilege_type]);
    }
    expect([...byTable.keys()].sort()).toEqual(['audit_event', 'consent_receipt']);
    expect(byTable.get('audit_event')?.sort()).toEqual(['DELETE', 'SELECT']);
    expect(byTable.get('consent_receipt')?.sort()).toEqual(['DELETE', 'SELECT']);
  });

  it('cannot read a medicine', async () => {
    // The specific thing a purge role must never be able to do. A missing GRANT raises rather
    // than filtering, so this is an error rather than an empty result.
    const message = await expectDenied(() =>
      t.asRetention((db) => db.query(`SELECT display_name FROM owned_item`)),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('cannot write an audit event', async () => {
    // It may delete old history and may not manufacture history. Those are different privileges
    // and it holds only the first.
    const message = await expectDenied(() =>
      t.asRetention((db) =>
        db.query(
          `INSERT INTO audit_event (actor_role, action, target_kind) VALUES ('x', 'y', 'z')`,
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// audit_event: 24 months, and the two gates
// ---------------------------------------------------------------------------

describe('audit_event retention', () => {
  const OLD_EVENT = testUuid(100);
  const RECENT_EVENT = testUuid(101);

  beforeAll(async () => {
    await t.asService(async (db) => {
      await db.query(
        `INSERT INTO audit_event (id, occurred_at, actor_user_id, actor_role, action, target_kind)
         VALUES ($1, ${OLD}, $2, 'user', 'ITEM_DELETED', 'owned_item')`,
        [OLD_EVENT, OWNER],
      );
      await db.query(
        `INSERT INTO audit_event (id, occurred_at, actor_user_id, actor_role, action, target_kind)
         VALUES ($1, ${RECENT}, $2, 'user', 'ITEM_DELETED', 'owned_item')`,
        [RECENT_EVENT, OWNER],
      );
    });
  });

  it('is unreadable and undeletable by the ordinary app role', async () => {
    // Unchanged from `0001`, restated because `0022` touched this table's grants and a
    // regression here is the whole audit log becoming reachable from a user request path.
    const read = await expectDenied(() =>
      t.asUser(OWNER, (db) => db.query(`SELECT * FROM audit_event`)),
    );
    expect(read).toMatch(/permission denied/i);

    const del = await expectDenied(() =>
      t.asUser(OWNER, (db) => db.query(`DELETE FROM audit_event WHERE id = $1`, [OLD_EVENT])),
    );
    expect(del).toMatch(/permission denied/i);
  });

  it('refuses DELETE to the service role, which writes it', async () => {
    // The privilege being withheld: a compromised service role cannot erase what it did.
    const message = await expectDenied(() =>
      t.asService((db) => db.query(`DELETE FROM audit_event WHERE id = $1`, [OLD_EVENT])),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('refuses UPDATE to everyone, including the retention role', async () => {
    // Retention deletes whole rows past an age. It does not edit history, and there is no role
    // for which that is different.
    for (const run of [
      () => t.asService((db) => db.query(`UPDATE audit_event SET action = 'x'`)),
      () => t.asRetention((db) => db.query(`UPDATE audit_event SET action = 'x'`)),
    ]) {
      const message = await expectDenied(run);
      expect(message).toMatch(/permission denied/i);
    }

    // And as the owner, which bypasses both the grant and RLS - so what refuses here is the
    // trigger alone.
    const message = await expectDenied(() =>
      t.asOwner((db) => db.query(`UPDATE audit_event SET action = 'x' WHERE id = $1`, [OLD_EVENT])),
    );
    expect(message).toMatch(/append-only/i);
  });

  it('shows the retention role only rows past the gate', async () => {
    const res = await t.asRetention((db) =>
      db.query<{ id: string }>(`SELECT id FROM audit_event ORDER BY occurred_at`),
    );
    expect(res.rows.map((r) => r.id)).toEqual([OLD_EVENT]);
  });

  it('purges a row past the gate and leaves a recent one', async () => {
    // The positive control this whole file needs. Every other assertion here is that something
    // is refused, and a role that could do nothing at all would satisfy all of them.
    const deleted = await t.asRetention((db) =>
      db.query(`DELETE FROM audit_event WHERE occurred_at <= kynviora.retention_floor()`),
    );
    expect(deleted.affectedRows).toBe(1);

    const left = await t.asService((db) =>
      db.query<{ id: string }>(`SELECT id FROM audit_event ORDER BY occurred_at`),
    );
    expect(left.rows.map((r) => r.id)).toEqual([RECENT_EVENT]);
  });

  it('refuses an in-window row even to the retention role, at the trigger', async () => {
    // RLS filters, so a targeted DELETE of a recent row affects zero rows rather than raising.
    // That is the correct behaviour for a sweep and it is not, on its own, evidence of a gate:
    // an empty result is what a missing row looks like too.
    const filtered = await t.asRetention((db) =>
      db.query(`DELETE FROM audit_event WHERE id = $1`, [RECENT_EVENT]),
    );
    expect(filtered.affectedRows).toBe(0);

    const stillThere = await t.asService((db) =>
      db.query<{ id: string }>(`SELECT id FROM audit_event WHERE id = $1`, [RECENT_EVENT]),
    );
    expect(stillThere.rows).toHaveLength(1);

    // The second gate, measured where the first cannot reach: as the owner, RLS is bypassed
    // entirely and the row is genuinely visible to the DELETE. What stops it is the trigger.
    // This is the case DEC-005 says a superuser reaches, and the reason both gates exist.
    const message = await expectDenied(() =>
      t.asOwner((db) => db.query(`DELETE FROM audit_event WHERE id = $1`, [RECENT_EVENT])),
    );
    expect(message).toMatch(/append-only|retention period/i);
  });
});

// ---------------------------------------------------------------------------
// consent_receipt: it outlives its subject
// ---------------------------------------------------------------------------

describe('consent_receipt retention', () => {
  const OLD_RECEIPT = testUuid(110);
  const RECENT_RECEIPT = testUuid(111);

  beforeAll(async () => {
    await t.asService(async (db) => {
      await db.query(
        `INSERT INTO consent_receipt
           (id, user_id, profile_id, purpose, granted, policy_version, recorded_at)
         VALUES ($1, $2, $3, 'PROFILE_DATA', true, 'v1', ${OLD})`,
        [OLD_RECEIPT, STRANGER, null],
      );
      await db.query(
        `INSERT INTO consent_receipt
           (id, user_id, profile_id, purpose, granted, policy_version, recorded_at)
         VALUES ($1, $2, $3, 'CAREGIVER_SHARING', false, 'v2', ${RECENT})`,
        [RECENT_RECEIPT, OWNER, PROFILE],
      );
    });
  });

  it('survives the deletion of the user it is about, de-linked rather than cascaded', async () => {
    // `DEV-056` (1). Before `0022` this was `ON DELETE CASCADE` on both references, so the
    // receipt proving somebody withdrew consent was destroyed by the purge that withdrawing it
    // led to - silently, by a foreign key, at the moment it is most likely to be asked for.
    // The purge itself, performed as the owner: no application role holds DELETE on \n    // and none should. What is being measured is the foreign key's behaviour, not who may fire it.
    await t.asOwner((db) => db.query(`DELETE FROM app_user WHERE id = $1`, [STRANGER]));

    const res = await t.asService((db) =>
      db.query<{
        user_id: string | null;
        purpose: string;
        granted: boolean;
        policy_version: string;
      }>(`SELECT user_id, purpose, granted, policy_version FROM consent_receipt WHERE id = $1`, [
        OLD_RECEIPT,
      ]),
    );
    // What it keeps is what it is retained for; what it loses is the pointer to a subject that
    // no longer exists.
    expect(res.rows[0]).toEqual({
      user_id: null,
      purpose: 'PROFILE_DATA',
      granted: true,
      policy_version: 'v1',
    });
  });

  it('does not become everybody’s receipt once de-linked', async () => {
    // A NULL `user_id` compared to a caller is NULL, which is already not true - but a policy
    // that relies on that is one edit away from `user_id = current_user_id() OR user_id IS NULL`
    // looking reasonable. `0022` states it.
    const res = await t.asUser(OWNER, (db) =>
      db.query<{ id: string }>(`SELECT id FROM consent_receipt ORDER BY recorded_at`),
    );
    expect(res.rows.map((r) => r.id)).toEqual([RECENT_RECEIPT]);
  });

  it('refuses UPDATE and DELETE to the app and service roles', async () => {
    for (const run of [
      () => t.asUser(OWNER, (db) => db.query(`DELETE FROM consent_receipt`)),
      () => t.asService((db) => db.query(`DELETE FROM consent_receipt`)),
      () => t.asService((db) => db.query(`UPDATE consent_receipt SET granted = true`)),
    ]) {
      const message = await expectDenied(run);
      expect(message).toMatch(/permission denied|append-only/i);
    }
  });

  it('permits a de-link and nothing else under cover of one', async () => {
    // The de-link door exists because `ON DELETE SET NULL` performs an UPDATE, and an
    // append-only trigger that refused it would make the purge fail on the very row it is meant
    // to preserve - keeping the receipt whole, linkage included, which is worse than either
    // intended outcome.
    //
    // The door has to be exactly the shape of that action and no wider. These are the three ways
    // it could be wider, asked as the owner so that no grant or policy answers first and the
    // trigger is the only thing under test.
    await t.asOwner(async (db) => {
      // (a) A complete, well-formed de-link with one other field moved under cover of it. Both
      // declared columns are cleared, so the statement gets all the way past the per-column
      // check and is caught by the whole-row comparison - which is the check that has to be
      // exact, because it is the only thing standing between a de-link and an edit.
      const smuggled = await expectDenied(() =>
        db.query(
          `UPDATE consent_receipt
              SET user_id = NULL, profile_id = NULL, granted = NOT granted
            WHERE id = $1`,
          [RECENT_RECEIPT],
        ),
      );
      expect(smuggled).toMatch(/append-only/i);

      // (b) Re-pointing a declared column at a different subject rather than clearing it.
      const repointed = await expectDenied(() =>
        db.query(`UPDATE consent_receipt SET user_id = $2 WHERE id = $1`, [
          RECENT_RECEIPT,
          CAREGIVER,
        ]),
      );
      expect(repointed).toMatch(/append-only/i);

      // (c) An ordinary edit of a field that is not declared at all.
      const edited = await expectDenied(() =>
        db.query(`UPDATE consent_receipt SET policy_version = 'v9' WHERE id = $1`, [
          RECENT_RECEIPT,
        ]),
      );
      expect(edited).toMatch(/append-only/i);
    });

    // And the receipt is untouched by all three attempts.
    const after = await t.asService((db) =>
      db.query<{ user_id: string | null; granted: boolean; policy_version: string }>(
        `SELECT user_id, granted, policy_version FROM consent_receipt WHERE id = $1`,
        [RECENT_RECEIPT],
      ),
    );
    expect(after.rows[0]).toEqual({ user_id: OWNER, granted: false, policy_version: 'v2' });
  });

  it('purges past the gate and holds inside it', async () => {
    const deleted = await t.asRetention((db) =>
      db.query(`DELETE FROM consent_receipt WHERE recorded_at <= kynviora.retention_floor()`),
    );
    expect(deleted.affectedRows).toBe(1);

    const left = await t.asService((db) =>
      db.query<{ id: string }>(`SELECT id FROM consent_receipt`),
    );
    expect(left.rows.map((r) => r.id)).toEqual([RECENT_RECEIPT]);
  });
});

// ---------------------------------------------------------------------------
// Item deletion: who may, and through what
// ---------------------------------------------------------------------------

/** The stamp, as the route performs it: the service role calling the one function. */
function deleteItem(itemId: string, actingUserId: string): Promise<boolean> {
  return t.asService(async (db) => {
    const res = await db.query<{ deleted: boolean }>(
      `SELECT kynviora.delete_owned_item($1, $2) AS deleted`,
      [itemId, actingUserId],
    );
    return res.rows[0]?.deleted ?? false;
  });
}

describe('deleting an owned item', () => {
  it('refuses a caregiver holding MANAGE_MEDICINES and MANAGE_SHELF', async () => {
    // The capabilities that come closest to permitting a delete, on both item kinds, because
    // `owned_item_update` branches on kind and a rule written for one would leave the other open.
    expect(await deleteItem(MEDICINE, CAREGIVER)).toBe(false);
    expect(await deleteItem(PERSONAL_CARE, CAREGIVER)).toBe(false);

    const still = await t.asUser(OWNER, (db) =>
      db.query<{ id: string }>(`SELECT id FROM owned_item WHERE id = ANY($1)`, [
        [MEDICINE, PERSONAL_CARE],
      ]),
    );
    expect(still.rows).toHaveLength(2);
  });

  it('refuses a stranger', async () => {
    expect(await deleteItem(MEDICINE, STRANGER)).toBe(false);
  });

  it('answers the same false for an item that does not exist', async () => {
    // `13` does not let the API distinguish "not yours" from "no such thing", and a function
    // with three answers is one a route will eventually surface as three.
    expect(await deleteItem(testUuid(999), OWNER)).toBe(false);
  });

  it('lets the owner delete, and the item stops being readable immediately', async () => {
    expect(await deleteItem(MEDICINE, OWNER)).toBe(true);

    // Revocation is the promise: no job runs between the stamp and the row being gone from every
    // read - the owner's and the caregiver's alike.
    for (const who of [OWNER, CAREGIVER]) {
      const seen = await t.asUser(who, (db) =>
        db.query<{ id: string }>(`SELECT id FROM owned_item WHERE id = $1`, [MEDICINE]),
      );
      expect(seen.rows).toHaveLength(0);
    }
  });

  it('takes the medicine schedules with it', async () => {
    // A reminder is the one consequence of a deleted item that reaches a person after the fact,
    // and `medicine_schedule` has its own SELECT policy rather than inheriting one.
    await t.asService((db) =>
      db.query(
        `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, timezone, times_local)
         VALUES ($1, 'FIXED_TIMES', 'Asia/Kolkata', ARRAY['08:00'])`,
        [SECOND_MEDICINE],
      ),
    );

    const before = await t.asUser(OWNER, (db) =>
      db.query(`SELECT id FROM medicine_schedule WHERE owned_item_id = $1`, [SECOND_MEDICINE]),
    );
    expect(before.rows).toHaveLength(1);

    expect(await deleteItem(SECOND_MEDICINE, OWNER)).toBe(true);

    const after = await t.asUser(OWNER, (db) =>
      db.query(`SELECT id FROM medicine_schedule WHERE owned_item_id = $1`, [SECOND_MEDICINE]),
    );
    expect(after.rows).toHaveLength(0);
  });

  it('is a no-op the second time, so the purge deadline cannot be pushed back', async () => {
    const stampedAt = await t.asService((db) =>
      db.query<{ deleted_at: string }>(`SELECT deleted_at FROM owned_item WHERE id = $1`, [
        MEDICINE,
      ]),
    );
    expect(await deleteItem(MEDICINE, OWNER)).toBe(false);

    const after = await t.asService((db) =>
      db.query<{ deleted_at: string }>(`SELECT deleted_at FROM owned_item WHERE id = $1`, [
        MEDICINE,
      ]),
    );
    expect(after.rows[0]?.deleted_at).toEqual(stampedAt.rows[0]?.deleted_at);
  });

  it('is unreachable from the app role at all', async () => {
    // The function is granted to the service role only, so a route that forgot `privileged()`
    // fails rather than quietly running under the caller's own connection.
    const message = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(`SELECT kynviora.delete_owned_item($1, $2)`, [PERSONAL_CARE, OWNER]),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// `DEV-057`: what actually refuses a direct write today, and what will tomorrow
// ---------------------------------------------------------------------------

describe('the direct UPDATE path', () => {
  it('refuses everyone, including the owner, because of the SELECT policy', async () => {
    // The finding `DEV-057` records. Postgres applies the SELECT policies to the **new** row of
    // an UPDATE whose WHERE clause reads the table, so a soft delete produces a row the caller
    // may not see and the statement fails - for the owner, not only for a caregiver.
    //
    // This is why the delete goes through a function and the service role. It is also why the
    // restrictive policy below cannot be measured here: something else refuses first.
    for (const who of [OWNER, CAREGIVER]) {
      const message = await expectDenied(() =>
        t.asUser(who, (db) =>
          db.query(`UPDATE owned_item SET deleted_at = now() WHERE id = $1`, [PERSONAL_CARE]),
        ),
      );
      expect(message).toMatch(/row-level security/i);
    }
  });

  it('still lets a caregiver make an ordinary edit', async () => {
    // The restriction must subtract deletion and nothing else. A policy that refused every
    // caregiver update would satisfy every assertion above and break the feature the capability
    // exists for.
    const res = await t.asUser(CAREGIVER, (db) =>
      db.query(`UPDATE owned_item SET notes = 'seen' WHERE id = $1`, [PERSONAL_CARE]),
    );
    expect(res.affectedRows).toBe(1);
  });

  it('refuses a caregiver even once the SELECT policy stops hiding deleted rows', async () => {
    // The measurement that makes `owned_item_delete_is_owner_only` a guard rather than a
    // decoration. The likeliest future that reopens the direct path is an ordinary product one -
    // a "recently deleted" list, or an undo - so this test builds exactly that future and asks
    // the question again.
    //
    // A guard tested only where something else already refuses is a guard nobody has seen fire.
    await t.asOwner(async (db) => {
      await db.query(`DROP POLICY owned_item_select ON owned_item`);
      await db.query(
        `CREATE POLICY owned_item_select ON owned_item FOR SELECT TO kynviora_app
           USING ((item_kind = 'PERSONAL_CARE' AND kynviora.has_capability(profile_id, 'VIEW_SHELF'))
               OR (item_kind = 'MEDICINE' AND kynviora.has_capability(profile_id, 'VIEW_MEDICINES')))`,
      );
    });

    try {
      const message = await expectDenied(() =>
        t.asUser(CAREGIVER, (db) =>
          db.query(`UPDATE owned_item SET deleted_at = now() WHERE id = $1`, [PERSONAL_CARE]),
        ),
      );
      // Named, because a restrictive policy is reported by name where the permissive set is not.
      // That is the evidence this refusal came from the new policy and not from the old accident.
      expect(message).toMatch(/owned_item_delete_is_owner_only/);

      // And the owner is not refused, so the policy subtracts the caregiver rather than the act.
      const owner = await t.asUser(OWNER, (db) =>
        db.query(`UPDATE owned_item SET deleted_at = now() WHERE id = $1`, [PERSONAL_CARE]),
      );
      expect(owner.affectedRows).toBe(1);
    } finally {
      await t.asOwner(async (db) => {
        await db.query(`DROP POLICY owned_item_select ON owned_item`);
        await db.query(
          `CREATE POLICY owned_item_select ON owned_item FOR SELECT TO kynviora_app
             USING (deleted_at IS NULL
                AND ((item_kind = 'PERSONAL_CARE' AND kynviora.has_capability(profile_id, 'VIEW_SHELF'))
                  OR (item_kind = 'MEDICINE' AND kynviora.has_capability(profile_id, 'VIEW_MEDICINES'))))`,
        );
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The two purge-blocking shapes
// ---------------------------------------------------------------------------

describe('purge is not blocked by staff-operational rows', () => {
  it('lets a shadow run sample be de-linked from a purged item', async () => {
    // `DEV-056` (2). `owned_item_id` is a bare uuid with no foreign key, in a staff-readable
    // table, so a purged household item's identifier stayed behind indefinitely.
    const res = await t.asOwner((db) =>
      db.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'shadow_run_sample' AND column_name = 'owned_item_id'`,
      ),
    );
    expect(res.rows[0]?.is_nullable).toBe('YES');
  });

  it('lets an assessment be purged with a correction standing against it', async () => {
    // `DEV-056` (3). Both references were ON DELETE RESTRICT, so a corrected assessment could
    // not be purged at all while the correction stood - staff-operational data holding
    // somebody's health record past its deadline.
    const res = await t.asOwner((db) =>
      db.query<{ confdeltype: string; conname: string }>(
        `SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint
          WHERE conrelid = 'assessment_correction'::regclass AND contype = 'f'
          ORDER BY conname`,
      ),
    );
    expect(res.rows).toHaveLength(2);
    // 'n' is SET NULL; 'r' is RESTRICT.
    for (const row of res.rows) expect(row.confdeltype).toBe('n');
  });
});
