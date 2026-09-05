import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';
import { runPurgeSweep, type PurgeConnection } from './src/retention.js';

/**
 * The purge sweep, against the real policies as the real role.
 *
 * Spec references: `16` (retention deadlines), `14` (least privilege), DEC-013, DEC-117,
 * migrations `0022` and `0023`, `docs/RETENTION.md`.
 *
 * THE ASYMMETRY THIS FILE IS ABOUT
 * A purge has two ways to be wrong and they are not equally bad. Purging too little misses a
 * deadline; purging too much destroys somebody's health record with no way back. So the design
 * puts the deadline in the **policy** rather than in the sweep, and the question this file asks
 * most often is not "did it delete the right rows" but "what happens when it is asked to delete
 * the wrong ones".
 *
 * Which is why several tests below issue the widest statement the role can express -
 * `DELETE FROM owned_item` with no predicate at all - and check that a live item survives it.
 *
 * WHAT ONLY A TEST CAN ANSWER HERE
 * That the append-only children can be purged at all. `dose_event` and `product_usage_evidence`
 * refuse every DELETE by trigger and cascade from `owned_item`, so before `0023` a purgeable item
 * could not be removed: the statement raised "append-only" from a table nobody was asking about,
 * and the thirty-day deadline was unmeetable by construction (`DEV-058`). Nothing in the types
 * says so and no other test deletes anything.
 */

const OWNER = testUuid(1);
const CAREGIVER = testUuid(2);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

/** Deleted 31 days ago: due. */
const DUE_ITEM = testUuid(30);
/** Deleted 3 days ago: revoked, not yet due. */
const RECENT_ITEM = testUuid(31);
/** Never deleted. */
const LIVE_ITEM = testUuid(32);

const DUE_PACK = testUuid(40);
const LIVE_PACK = testUuid(41);

const OLD_ASSET = testUuid(50);
const REFERENCED_ASSET = testUuid(51);
const NEW_ASSET = testUuid(52);

let t: TestDb;

/** The sweep, as the retention role - which is the only way it can be run. */
function sweep() {
  return t.asRetention((db) => runPurgeSweep(db as unknown as PurgeConnection));
}

async function countOf(table: string, where = 'true'): Promise<number> {
  const res = await t.asOwner((db) =>
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`),
  );
  return res.rows[0]?.n ?? 0;
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

  // Fixtures as the owner: several of these need timestamps in the past, which no route can
  // write, and `dose_event` refuses an UPDATE afterwards.
  await t.asOwner(async (db) => {
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
       VALUES ($1, $2, 'MEDICINE', 'Due Tablet', now() - interval '31 days'),
              ($3, $2, 'MEDICINE', 'Recently Deleted Tablet', now() - interval '3 days'),
              ($4, $2, 'MEDICINE', 'Live Tablet', NULL)`,
      [DUE_ITEM, PROFILE, RECENT_ITEM, LIVE_ITEM],
    );

    // One of each child on all three items, so every assertion below has both a row that must go
    // and a row that must stay.
    for (const item of [DUE_ITEM, RECENT_ITEM, LIVE_ITEM]) {
      await db.query(
        `INSERT INTO dose_event (owned_item_id, event_kind, recorded_at, client_operation_id)
         VALUES ($1, 'TAKEN', now(), gen_random_uuid())`,
        [item],
      );
      await db.query(
        `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, timezone, times_local)
         VALUES ($1, 'FIXED_TIMES', 'Asia/Kolkata', ARRAY['08:00'])`,
        [item],
      );
      await db.query(
        `INSERT INTO refill_estimate (owned_item_id, quantity_remaining, doses_per_day, computed_at)
         VALUES ($1, 10, 2, now())`,
        [item],
      );
      await db.query(
        `INSERT INTO review_task
           (profile_id, owned_item_id, task_kind, state, subject_kind, subject_id)
         VALUES ($1, $2, 'ITEM_NOT_REVIEWED_RECENTLY', 'OPEN', 'owned_item', $2)`,
        [PROFILE, item],
      );
    }

    // Visit Packs: one expired more than 24 hours ago, one still live.
    await db.query(
      `INSERT INTO visit_pack
         (id, profile_id, created_by_user_id, manifest, content_digest, notes,
          generated_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, repeat('a', 64), ARRAY['a question I wanted to ask'],
               now() - interval '10 days', now() - interval '9 days')`,
      [
        DUE_PACK,
        PROFILE,
        OWNER,
        JSON.stringify([{ section: 's', entityKind: 'k', entityId: 'e' }]),
      ],
    );
    await db.query(
      `INSERT INTO visit_pack
         (id, profile_id, created_by_user_id, manifest, content_digest, notes,
          generated_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, repeat('b', 64), ARRAY['still current'],
               now(), now() + interval '2 days')`,
      [
        LIVE_PACK,
        PROFILE,
        OWNER,
        JSON.stringify([{ section: 's', entityKind: 'k', entityId: 'e' }]),
      ],
    );

    // Invitations: one long expired, one still open.
    await db.query(
      `INSERT INTO caregiver_invitation
         (profile_id, invited_by_user_id, capabilities, token_hash, expires_at, created_at)
       VALUES ($1, $2, ARRAY['VIEW_SHELF'], repeat('c', 64),
               now() - interval '40 days', now() - interval '47 days'),
              ($1, $2, ARRAY['VIEW_SHELF'], repeat('d', 64), now() + interval '5 days', now())`,
      [PROFILE, OWNER],
    );

    // Evidence: old and unattached, old but referenced, and new.
    for (const [id, age] of [
      [OLD_ASSET, '10 days'],
      [REFERENCED_ASSET, '10 days'],
      [NEW_ASSET, '1 day'],
    ] as const) {
      await db.query(
        `INSERT INTO evidence_asset
           (id, owner_user_id, panel_kind, storage_key, content_type, byte_size, sha256, created_at)
         VALUES ($1, $2, 'FRONT_PANEL', $3, 'image/jpeg', 1024, repeat('e', 64),
                 now() - interval '${age}')`,
        [id, OWNER, `key-${id}`],
      );
    }
    // The reference that must keep `REFERENCED_ASSET` alive, on a **live** item - which is the
    // case a policy-level subquery gets wrong.
    await db.query(
      `INSERT INTO product_usage_evidence (owned_item_id, evidence_asset_id, confirmed_at)
       VALUES ($1, $2, now())`,
      [LIVE_ITEM, REFERENCED_ASSET],
    );

    // Audit and consent, one old and one recent of each.
    await db.query(
      `INSERT INTO audit_event (occurred_at, actor_user_id, actor_role, action, target_kind)
       VALUES (now() - interval '25 months', $1, 'user', 'item.deleted', 'owned_item'),
              (now() - interval '1 month', $1, 'user', 'item.deleted', 'owned_item')`,
      [OWNER],
    );
    await db.query(
      `INSERT INTO consent_receipt (user_id, purpose, granted, policy_version, recorded_at)
       VALUES ($1, 'PROFILE_DATA', true, 'v1', now() - interval '25 months'),
              ($1, 'NOTIFICATIONS', true, 'v1', now() - interval '1 month')`,
      [OWNER],
    );
  });
});

afterAll(async () => {
  await t?.close();
});

// ---------------------------------------------------------------------------
// The widest statement the role can issue
// ---------------------------------------------------------------------------

describe('what the retention role can do when it tries to do everything', () => {
  it('cannot see a live item, a recently deleted one, or their children', async () => {
    // The policy is the guarantee, not the sweep's WHERE clause. If this is wrong, every
    // assertion below is measuring a predicate rather than a protection.
    const items = await t.asRetention((db) =>
      db.query<{ id: string }>(`SELECT id FROM owned_item`),
    );
    expect(items.rows.map((r) => r.id)).toEqual([DUE_ITEM]);

    const doses = await t.asRetention((db) =>
      db.query<{ owned_item_id: string }>(`SELECT owned_item_id FROM dose_event`),
    );
    expect(doses.rows.map((r) => r.owned_item_id)).toEqual([DUE_ITEM]);
  });

  it('deletes nothing extra when given no predicate at all', async () => {
    // The widest statement expressible by this role. A person's live shelf has to survive it,
    // because the day somebody writes this by accident is the day the design is tested.
    await t.asRetention(async (db) => {
      await db.query(`DELETE FROM dose_event`);
      await db.query(`DELETE FROM medicine_schedule`);
      await db.query(`DELETE FROM refill_estimate`);
      await db.query(`DELETE FROM review_task`);
      await db.query(`DELETE FROM owned_item`);
    });

    expect(await countOf('owned_item')).toBe(2);
    expect(await countOf('owned_item', `id = '${LIVE_ITEM}'`)).toBe(1);
    expect(await countOf('owned_item', `id = '${RECENT_ITEM}'`)).toBe(1);
    // And the due item's children went with it, which is the same statement doing its job.
    expect(await countOf('dose_event')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The sweep itself
// ---------------------------------------------------------------------------

describe('a sweep', () => {
  it('reports zero for what it has already purged', async () => {
    // The previous describe removed the item rows, so this run has nothing left to do on them.
    // Running twice must be safe: a sweep that is not idempotent is one nobody can schedule.
    const report = await sweep();
    expect(report.items).toBe(0);
    expect(report.doseEvents).toBe(0);
  });

  it('purges an expired Visit Pack’s content and leaves the row', async () => {
    // `docs/RETENTION.md` section 3.2: the content is the pack; the row stays so that "a pack was
    // created and has expired" remains answerable without the pack being readable.
    const before = await sweep();
    expect(before.visitPackContents).toBeGreaterThanOrEqual(0);

    const rows = await t.asOwner((db) =>
      db.query<{
        id: string;
        manifest: unknown;
        notes: string[];
        content_purged_at: unknown;
      }>(`SELECT id, manifest, notes, content_purged_at FROM visit_pack ORDER BY generated_at`),
    );
    expect(rows.rows).toHaveLength(2);

    const purged = rows.rows.find((r) => r.id === DUE_PACK);
    expect(purged?.manifest).toEqual([]);
    expect(purged?.notes).toEqual([]);
    expect(purged?.content_purged_at).not.toBeNull();

    // The live pack is untouched, notes included - a person's question they meant to ask.
    const live = rows.rows.find((r) => r.id === LIVE_PACK);
    expect(live?.notes).toEqual(['still current']);
    expect(live?.content_purged_at).toBeNull();
  });

  it('does not purge the same pack twice', async () => {
    const again = await sweep();
    expect(again.visitPackContents).toBe(0);
  });

  it('purges an expired invitation and leaves an open one', async () => {
    // The operational row goes; the access history stays in `audit_event`, which is the point of
    // the split.
    expect(await countOf('caregiver_invitation')).toBe(1);
    const remaining = await t.asOwner((db) =>
      db.query<{ expires_at: string }>(`SELECT expires_at FROM caregiver_invitation`),
    );
    expect(new Date(String(remaining.rows[0]?.expires_at)).getTime()).toBeGreaterThan(Date.now());
  });

  it('purges an old unattached asset and keeps a referenced one', async () => {
    // The case a policy-level subquery gets wrong: `REFERENCED_ASSET` is cited by evidence for a
    // **live** item, which the retention role cannot see. Answering "unreferenced" there would
    // delete an asset a Trust Passport still points at.
    const ids = await t.asOwner((db) =>
      db.query<{ id: string }>(`SELECT id FROM evidence_asset ORDER BY created_at`),
    );
    expect(ids.rows.map((r) => r.id).sort()).toEqual([REFERENCED_ASSET, NEW_ASSET].sort());
  });

  it('purges the two retained tables at 24 months and not before', async () => {
    expect(await countOf('audit_event')).toBe(1);
    expect(await countOf('consent_receipt')).toBe(1);

    const audit = await t.asOwner((db) =>
      db.query<{ occurred_at: string }>(`SELECT occurred_at FROM audit_event`),
    );
    const age = Date.now() - new Date(String(audit.rows[0]?.occurred_at)).getTime();
    // Roughly a month, and comfortably inside 24 months. The point is which row survived.
    expect(age).toBeLessThan(1000 * 60 * 60 * 24 * 400);
  });
});

// ---------------------------------------------------------------------------
// The append-only children, which is why `0023` exists
// ---------------------------------------------------------------------------

describe('the append-only children of a purged item', () => {
  const SECOND_DUE = testUuid(60);

  beforeAll(async () => {
    await t.asOwner(async (db) => {
      await db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
         VALUES ($1, $2, 'MEDICINE', 'Second Due Tablet', now() - interval '31 days')`,
        [SECOND_DUE, PROFILE],
      );
      await db.query(
        `INSERT INTO dose_event (owned_item_id, event_kind, recorded_at, client_operation_id)
         VALUES ($1, 'TAKEN', now(), gen_random_uuid())`,
        [SECOND_DUE],
      );
      await db.query(
        `INSERT INTO product_usage_evidence (owned_item_id, evidence_asset_id, confirmed_at)
         VALUES ($1, NULL, now())`,
        [SECOND_DUE],
      );
    });
  });

  it('still refuses every UPDATE, to every role', async () => {
    // What `0023` widened is a DELETE by one role of a row whose parent is thirty days gone.
    // Correcting a dose is still a further event, never a rewrite, and no door changes that.
    for (const run of [
      () => t.asService((db) => db.query(`UPDATE dose_event SET note = 'x'`)),
      () => t.asRetention((db) => db.query(`UPDATE dose_event SET note = 'x'`)),
      () => t.asOwner((db) => db.query(`UPDATE dose_event SET note = 'x'`)),
    ]) {
      const message = await expectDenied(run);
      expect(message).toMatch(/append-only|permission denied/i);
    }
  });

  it('refuses a DELETE by the service role, which writes them', async () => {
    const message = await expectDenied(() =>
      t.asService((db) => db.query(`DELETE FROM dose_event`)),
    );
    expect(message).toMatch(/append-only|permission denied/i);
  });

  it('refuses a DELETE of a child whose item is not due, at the trigger', async () => {
    // RLS filters, so the retention role's own attempt affects zero rows rather than raising -
    // which is right for a sweep and is not, on its own, evidence of a gate. The trigger is
    // measured where RLS cannot reach: as the owner, where the row is genuinely visible.
    const message = await expectDenied(() =>
      t.asOwner((db) => db.query(`DELETE FROM dose_event WHERE owned_item_id = $1`, [LIVE_ITEM])),
    );
    expect(message).toMatch(/not due for purge|append-only/i);
  });

  it('lets the sweep remove them, and the item with them', async () => {
    // The positive control this file needs most: every assertion above is that something is
    // refused, and a door that opened for nobody would satisfy all of them.
    const report = await sweep();

    expect(report.items).toBe(1);
    expect(report.doseEvents).toBe(1);
    expect(report.usageEvidence).toBe(1);

    expect(await countOf('owned_item', `id = '${SECOND_DUE}'`)).toBe(0);
    expect(await countOf('dose_event', `owned_item_id = '${SECOND_DUE}'`)).toBe(0);
    // And the live item's dose history is untouched.
    expect(await countOf('dose_event', `owned_item_id = '${LIVE_ITEM}'`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A purged profile
// ---------------------------------------------------------------------------

describe('a profile thirty days deleted', () => {
  const DUE_PROFILE = testUuid(70);
  const DUE_PROFILE_ITEM = testUuid(71);
  const LIVE_PROFILE = testUuid(72);
  const LIVE_PROFILE_ITEM = testUuid(73);

  beforeAll(async () => {
    await t.asOwner(async (db) => {
      await db.query(
        `INSERT INTO profile (id, household_id, owner_user_id, display_name, deleted_at)
         VALUES ($1, $2, $3, 'Gone', now() - interval '31 days'),
                ($4, $2, $3, 'Still Here', NULL)`,
        [DUE_PROFILE, HOUSEHOLD, OWNER, LIVE_PROFILE],
      );

      // `delete_profile` stamps the items with the profile, so a purgeable profile's items carry
      // their own stamp. Reproduced here rather than assumed, because the sweep's correctness
      // depends on it and a fixture that skipped it would test a state the route cannot produce.
      await db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name, deleted_at)
         VALUES ($1, $2, 'MEDICINE', 'Gone Tablet', now() - interval '31 days'),
                ($3, $4, 'MEDICINE', 'Still Here Tablet', NULL)`,
        [DUE_PROFILE_ITEM, DUE_PROFILE, LIVE_PROFILE_ITEM, LIVE_PROFILE],
      );
      await db.query(
        `INSERT INTO dose_event (owned_item_id, event_kind, recorded_at, client_operation_id)
         VALUES ($1, 'TAKEN', now(), gen_random_uuid()),
                ($2, 'TAKEN', now(), gen_random_uuid())`,
        [DUE_PROFILE_ITEM, LIVE_PROFILE_ITEM],
      );

      for (const profile of [DUE_PROFILE, LIVE_PROFILE]) {
        await db.query(
          `INSERT INTO allergy_record (profile_id, record_kind, display_term, provenance, certainty)
           VALUES ($1, 'ALLERGY', 'penicillin', 'USER_REPORTED', 'SUSPECTED')`,
          [profile],
        );
        await db.query(
          `INSERT INTO caregiver_grant
             (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
           VALUES ($1, $2, $3, ARRAY['VIEW_SHELF'], 'ACTIVE', now())`,
          [profile, CAREGIVER, OWNER],
        );
        await db.query(
          `INSERT INTO review_task (profile_id, task_kind, state, subject_kind, subject_id)
           VALUES ($1, 'CAREGIVER_GRANT_EXPIRING', 'OPEN', 'caregiver_grant', $1)`,
          [profile],
        );
      }
    });
  });

  it('cannot be seen by the retention role while it is live', async () => {
    const rows = await t.asRetention((db) => db.query<{ id: string }>(`SELECT id FROM profile`));
    expect(rows.rows.map((r) => r.id)).toEqual([DUE_PROFILE]);
  });

  it('is purged with everything about it, and nothing about the other one', async () => {
    const report = await sweep();

    expect(report.profiles).toBe(1);
    expect(report.allergies).toBe(1);
    expect(report.caregiverGrants).toBe(1);
    // The task that names a grant rather than an item - the half the item purge cannot reach.
    expect(report.reviewTasksByProfile).toBe(1);
    // The item and its dose went through the item path, because `delete_profile` stamped them.
    expect(report.items).toBe(1);
    expect(report.doseEvents).toBe(1);

    expect(await countOf('profile', `id = '${DUE_PROFILE}'`)).toBe(0);
    expect(await countOf('owned_item', `profile_id = '${DUE_PROFILE}'`)).toBe(0);
    expect(await countOf('allergy_record', `profile_id = '${DUE_PROFILE}'`)).toBe(0);

    // The other profile is untouched, all of it.
    expect(await countOf('profile', `id = '${LIVE_PROFILE}'`)).toBe(1);
    expect(await countOf('owned_item', `profile_id = '${LIVE_PROFILE}'`)).toBe(1);
    expect(await countOf('allergy_record', `profile_id = '${LIVE_PROFILE}'`)).toBe(1);
    expect(await countOf('dose_event', `owned_item_id = '${LIVE_PROFILE_ITEM}'`)).toBe(1);
  });

  it('leaves nothing for a second sweep', async () => {
    const again = await sweep();
    expect(again.profiles).toBe(0);
    expect(again.allergies).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Digests, which inherit their deadline rather than having one
// ---------------------------------------------------------------------------

describe('a digest whose events were purged', () => {
  const DIGEST_PROFILE = testUuid(80);
  const LIVE_DIGEST_PROFILE = testUuid(81);
  const DUE_DIGEST = testUuid(82);
  const LIVE_DIGEST = testUuid(83);

  beforeAll(async () => {
    await t.asOwner(async (db) => {
      await db.query(
        `INSERT INTO profile (id, household_id, owner_user_id, display_name, deleted_at)
         VALUES ($1, $2, $3, 'Gone Again', now() - interval '31 days'),
                ($4, $2, $3, 'Still Here Too', NULL)`,
        [DIGEST_PROFILE, HOUSEHOLD, OWNER, LIVE_DIGEST_PROFILE],
      );

      // One digest per recipient, so the two are distinguishable - a digest is keyed on the person
      // it is addressed to, not on the profile its events came from.
      for (const [digestId, profile, recipient, day] of [
        [DUE_DIGEST, DIGEST_PROFILE, OWNER, '2026-09-01'],
        [LIVE_DIGEST, LIVE_DIGEST_PROFILE, CAREGIVER, '2026-09-02'],
      ] as const) {
        await db.query(
          `INSERT INTO notification_digest
             (id, recipient_user_id, local_date, time_zone, included_count, dropped_count)
           VALUES ($1, $2, $3::date, 'Asia/Kolkata', 1, 0)`,
          [digestId, recipient, day],
        );
        const delivery = await db.query<{ id: string }>(
          `INSERT INTO alert_delivery
             (profile_id, recipient_user_id, event_kind, dose_occurrence_key, detail_level,
              delivered_at, channel, channel_reason, held)
           VALUES ($1, $2, 'MISSED_DOSE', $3, 'GENERIC', now(), 'DIGEST', 'URGENCY_CEILING', false)
           RETURNING id`,
          [profile, recipient, `digest-purge-${digestId}`],
        );
        await db.query(
          `INSERT INTO notification_digest_entry
             (digest_id, alert_delivery_id, outcome, included)
           VALUES ($1, $2, 'STILL_CURRENT', true)`,
          [digestId, delivery.rows[0]?.id],
        );
      }
    });
  });

  it('is invisible to the retention role while it still summarises something', async () => {
    // The policy, not the sweep's predicate. `digest_is_empty` is what admits a row, so the widest
    // statement this role can issue removes only digests that summarise nothing.
    const rows = await t.asRetention((db) =>
      db.query<{ id: string }>(`SELECT id FROM notification_digest`),
    );
    expect(rows.rows).toEqual([]);
  });

  it('survives a DELETE with no predicate at all while its entries remain', async () => {
    await t.asRetention((db) => db.query(`DELETE FROM notification_digest`));
    expect(await countOf('notification_digest')).toBe(2);
  });

  it('loses its entries with the deliveries they reference, and then goes itself', async () => {
    const report = await sweep();

    expect(report.digestEntries).toBe(1);
    expect(report.digests).toBe(1);

    // The deleted profile's digest and its entry are gone; the live profile's are untouched.
    expect(await countOf('notification_digest', `id = '${DUE_DIGEST}'`)).toBe(0);
    expect(await countOf('notification_digest', `id = '${LIVE_DIGEST}'`)).toBe(1);
    expect(await countOf('notification_digest_entry')).toBe(1);
  });

  it('leaves nothing for a second sweep', async () => {
    const again = await sweep();
    expect(again.digestEntries).toBe(0);
    expect(again.digests).toBe(0);
  });
});
