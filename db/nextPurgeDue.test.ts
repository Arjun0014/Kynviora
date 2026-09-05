import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, testUuid, type TestDb } from './harness/harness.js';

/**
 * When the next row becomes purgeable, which is now what schedules the sweep.
 *
 * Spec references: `16` (personal data purged **within** 30 days; Visit Pack content within 24
 * hours of expiry; unattached capture artifacts within 7 days), `14` (least privilege),
 * `docs/RETENTION.md` 3.1, 3.2, 8.3, DEC-117, DEC-121, DEC-123, `DEV-063`, `DEV-065`,
 * migration `0031`.
 *
 * WHAT IS ACTUALLY BEING CHECKED
 * That `kynviora.next_purge_due()` agrees with the **policies**, not with the arithmetic in its
 * own body. Those are two different claims and only the first one matters: a function returning
 * `deleted_at + 30 days` is right only for as long as `purge_floor()` is thirty days, and the
 * whole hazard of scheduling from a second declaration of a deadline is that the two drift.
 *
 * So the sharp test is the last one in each block: at the instant the function names, the row is
 * visible to `kynviora_retention` - and one microsecond earlier it is not. That is asked of the
 * policy, in one transaction where `now()` is constant, which is the same technique
 * `purgeDeadline.test.ts` uses for the boundaries themselves.
 */

const OWNER = testUuid(1);
const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const ITEM = testUuid(30);
const OTHER_ITEM = testUuid(31);
const PACK = testUuid(40);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await t.asService(async (db) => {
    await db.query(
      `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
       VALUES ($1, $2, 'owner@example.test', now())`,
      [OWNER, `auth|${OWNER}`],
    );
    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'Household')`,
      [HOUSEHOLD, OWNER],
    );
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );
  });
});

afterAll(async () => {
  await t?.close();
});

/** The function's answer, as milliseconds since the epoch, or `null`. */
async function nextDue(): Promise<number | null> {
  const res = await t.asRetention((db) =>
    db.query<{ due: Date | string | null }>('SELECT kynviora.next_purge_due() AS due'),
  );
  const due = res.rows[0]?.due ?? null;
  if (due === null) return null;
  return due instanceof Date ? due.getTime() : Date.parse(due);
}

describe('nothing pending', () => {
  it('answers null rather than a date nobody meant', async () => {
    // The fresh-deployment case, and the common one. A function that answered `now()` here would
    // make the worker sweep continuously over an empty matrix; one that answered a far-future
    // date would suppress the heartbeat.
    expect(await nextDue()).toBeNull();
  });
});

describe('a deleted item', () => {
  it('is due exactly thirty days after it was stamped', async () => {
    await t.asOwner((db) =>
      db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
         VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet', now() - interval '10 days')`,
        [ITEM, PROFILE],
      ),
    );

    const stamped = await t.asOwner((db) =>
      db.query<{ at: Date }>('SELECT deleted_at AS at FROM owned_item WHERE id = $1', [ITEM]),
    );
    const deletedAt = stamped.rows[0]?.at.getTime() ?? 0;
    const due = await nextDue();

    expect(due).not.toBeNull();
    // Thirty days to the millisecond. Compared against the stored stamp rather than against a
    // literal computed here, so the test cannot pass by making the same off-by-one twice.
    expect((due ?? 0) - deletedAt).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('names the earliest of several rather than the most recent', async () => {
    // `min`, and it matters: a sweep scheduled at the newest deadline would miss every older one
    // by the difference between them.
    await t.asOwner((db) =>
      db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
         VALUES ($1, $2, 'MEDICINE', 'Synthetic Capsule', now() - interval '1 day')`,
        [OTHER_ITEM, PROFILE],
      ),
    );
    const stamped = await t.asOwner((db) =>
      db.query<{ at: Date }>('SELECT deleted_at AS at FROM owned_item WHERE id = $1', [ITEM]),
    );
    expect((await nextDue()) ?? 0).toBe(
      (stamped.rows[0]?.at.getTime() ?? 0) + 30 * 24 * 60 * 60 * 1000,
    );
  });

  it('agrees with the policy, at the microsecond, in both directions', async () => {
    // The test the others exist to set up. In one transaction `now()` is constant, so a row
    // stamped exactly at `purge_floor()` is exactly on the line - and `next_purge_due()` computed
    // in the same transaction must be exactly `now()` for it.
    await t.asOwner(async (db) => {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE kynviora_service');
        await db.query(
          `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
           VALUES ($1, $2, 'MEDICINE', 'On the line', kynviora.purge_floor())`,
          [testUuid(32), PROFILE],
        );
        await db.query(
          `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
           VALUES ($1, $2, 'MEDICINE', 'A microsecond inside',
                   kynviora.purge_floor() + interval '1 microsecond')`,
          [testUuid(33), PROFILE],
        );

        await db.query('SET LOCAL ROLE kynviora_retention');

        // The one on the line is due; the one a microsecond later is not, and the function says
        // when it will be - `now()` plus that same microsecond.
        const visible = await db.query<{ id: string }>(
          'SELECT id FROM owned_item WHERE id = ANY($1::uuid[])',
          [[testUuid(32), testUuid(33)]],
        );
        expect(visible.rows.map((r) => r.id)).toEqual([testUuid(32)]);

        const answer = await db.query<{ diff: string }>(
          `SELECT extract(epoch from (kynviora.next_purge_due() - now()))::text AS diff`,
        );
        // A microsecond, expressed in seconds. Not zero: the row already on the line is invisible
        // to this function's window predicate by construction, because it is no longer in the
        // future.
        expect(Number(answer.rows[0]?.diff)).toBeCloseTo(0.000001, 9);
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });
});

describe('a Visit Pack, the shortest deadline in the matrix', () => {
  it('is due twenty-four hours after it expires, and beats a thirty-day item', async () => {
    await t.asService((db) =>
      db.query(
        `INSERT INTO visit_pack
           (id, profile_id, created_by_user_id, manifest, content_digest, notes,
            generated_at, expires_at)
         VALUES ($1, $2, $3, '[]'::jsonb, repeat('a', 64), ARRAY['note'],
                 now(), now() + interval '1 hour')`,
        [PACK, PROFILE, OWNER],
      ),
    );

    const expiry = await t.asService((db) =>
      db.query<{ at: Date }>('SELECT expires_at AS at FROM visit_pack WHERE id = $1', [PACK]),
    );
    const due = await nextDue();
    // 24 hours after expiry, and earlier than the items above, which are 20 and 29 days out. This
    // is the case `DEV-063` was worst for: an hour of overshoot on a 24-hour promise is four per
    // cent of the whole deadline.
    expect((due ?? 0) - (expiry.rows[0]?.at.getTime() ?? 0)).toBe(24 * 60 * 60 * 1000);
  });

  it('stops counting once its content has been emptied', async () => {
    // The predicate is `content_purged_at IS NULL`, same as the policy's. Without it a pack that
    // had already been emptied would keep naming a deadline nothing would act on, and the worker
    // would wake for it forever.
    // Stamped as fixture setup rather than by the sweep, because the sweep could not reach it: a
    // pack that expires in an hour is not yet due, so the retention role cannot see it - which is
    // the state this test needs to exist in. A pack already past its deadline would be excluded
    // by the function's own window and would prove nothing about the `content_purged_at` half.
    await t.asOwner((db) =>
      db.query(
        `UPDATE visit_pack SET manifest = '[]'::jsonb, notes = ARRAY[]::text[],
                               content_purged_at = now()
          WHERE id = $1`,
        [PACK],
      ),
    );
    const due = await nextDue();
    const item = await t.asOwner((db) =>
      db.query<{ at: Date }>('SELECT deleted_at AS at FROM owned_item WHERE id = $1', [ITEM]),
    );
    expect((due ?? 0) - (item.rows[0]?.at.getTime() ?? 0)).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('who may ask', () => {
  it('is the retention role and nobody else', async () => {
    // A SECURITY DEFINER function inherits the definer's rights, so an over-broad grant on one is
    // a way around a policy. `kynviora_service` has no business knowing when somebody's deleted
    // medicine stops existing, and PUBLIC least of all.
    const grants = await t.asOwner((db) =>
      db.query<{ acl: string | null }>(
        `SELECT proacl::text AS acl FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'kynviora' AND p.proname = 'next_purge_due'`,
      ),
    );
    const acl = grants.rows[0]?.acl ?? '';
    expect(acl).toContain('kynviora_retention=X');
    expect(acl).not.toContain('kynviora_app=X');
    expect(acl).not.toContain('kynviora_service=X');
    // `=X/` with nothing before the `=` is the PUBLIC grant, which `REVOKE ALL ... FROM PUBLIC`
    // removes. Checked as a substring because that is exactly how it renders.
    expect(acl).not.toMatch(/[{,]=X/);
  });
});
