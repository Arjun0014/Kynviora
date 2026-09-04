import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';
import { CAREGIVER_CAPABILITIES } from '@kynviora/domain';

/**
 * Authorization for writing into a dose history (`04` Phase 4.3, `08.2`, migration `0021`).
 *
 * The property under test is that **writing into somebody's dose history is its own permission**.
 * Until `0021` the insert policy asked only whether the caller could reach the owned item, which
 * reduces to `VIEW_MEDICINES` - so a caregiver granted read-only access to a person's medicines
 * could write entries into the record that person hands a doctor, while the invitation screen
 * described that same grant as allowing no changes at all (`DEV-049`, `BLK-011`).
 *
 * `19` requires an automated case for "caregiver missing capability". This is that case for the
 * one table a phone can write to while offline, which is what made the gap urgent: a queued
 * operation is replayed by a drain days later, against whatever the grant says when it lands.
 *
 * The API-level half is `services/api/src/doseAuthorization.test.ts`. This file is the policy on
 * its own, as the non-superuser role, because a route can only be as strict as what is underneath
 * it and a mock of a policy tests nothing.
 */

const OWNER = testUuid(1);
const VIEWER = testUuid(2); // VIEW_MEDICINES only - may read the history, must not write to it
const RECORDER = testUuid(3); // VIEW_MEDICINES + RECORD_DOSES - the case the capability exists for
const MANAGER = testUuid(4); // VIEW_MEDICINES + MANAGE_MEDICINES, and *not* RECORD_DOSES
const BLIND_RECORDER = testUuid(5); // RECORD_DOSES with no way to see the item
const STRANGER = testUuid(6);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const MEDICINE = testUuid(30);

/** Written by the service role in setup, so the read tests have something to see. */
const EXISTING = testUuid(40);

let t: TestDb;
let nextKey = 100;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [VIEWER, 'viewer@example.test'],
      [RECORDER, 'recorder@example.test'],
      [MANAGER, 'manager@example.test'],
      [BLIND_RECORDER, 'blind@example.test'],
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
      [RECORDER, ['VIEW_MEDICINES', 'RECORD_DOSES']],
      [MANAGER, ['VIEW_MEDICINES', 'MANAGE_MEDICINES']],
      // No viewing capability at all. `has_capability` will say yes and the EXISTS subquery will
      // still find nothing, which is the safe direction and worth pinning rather than assuming.
      [BLIND_RECORDER, ['RECORD_DOSES']],
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
      `INSERT INTO dose_event (id, owned_item_id, event_kind, client_operation_id)
       VALUES ($1, $2, 'TAKEN', $3)`,
      [EXISTING, MEDICINE, testUuid(90)],
    );
  });
});

afterAll(async () => {
  await t.close();
});

/**
 * Record a dose as `userId`, returning how many rows row-level security admitted.
 *
 * A fresh operation key every time, so a refusal is never the idempotency index answering a
 * question about authorization.
 */
async function recordAs(userId: string, itemId: string = MEDICINE): Promise<number> {
  nextKey += 1;
  const key = testUuid(nextKey);
  return t.asUser(userId, async (db) => {
    const res = await db.query(
      `INSERT INTO dose_event (owned_item_id, event_kind, client_operation_id)
       VALUES ($1, 'TAKEN', $2)
       RETURNING id`,
      [itemId, key],
    );
    return res.rows.length;
  });
}

describe('recording a dose needs RECORD_DOSES (migration 0021)', () => {
  it('lets the profile owner record one', async () => {
    // The positive control, and the one that must not have moved. `has_capability` short-circuits
    // on ownership before it looks at a grant, so the person whose medicines these are is
    // unaffected by the whole change. Without this, every refusal below could be a policy that
    // refuses everybody - which is a different bug and passes each of the other tests.
    expect(await recordAs(OWNER)).toBe(1);
  });

  it('lets a caregiver who was granted it record one', async () => {
    // The case the capability was added for: somebody sitting with a person at breakfast, noting
    // that they took a tablet, who has no business editing the prescription.
    expect(await recordAs(RECORDER)).toBe(1);
  });

  it('refuses a caregiver granted only VIEW_MEDICINES', async () => {
    // `DEV-049` itself. This caller can read the medicine and its whole dose history; adding an
    // entry to the record a doctor reads is a different thing from being allowed to see it, and
    // the invitation screen has always said so.
    const message = await expectDenied(() => recordAs(VIEWER));
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses a caregiver granted MANAGE_MEDICINES but not RECORD_DOSES', async () => {
    // The direction it would be easy to get wrong. `MANAGE_MEDICINES` is the larger permission in
    // every ordinary sense - it can delete the medicine outright - but the capabilities are
    // separate rather than nested, and a grant carries exactly what it names. Nesting them here
    // would make this policy read a capability the owner did not tick, which is the same failure
    // as the one being fixed with the roles reversed.
    const message = await expectDenied(() => recordAs(MANAGER));
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses a caregiver holding RECORD_DOSES over an item they cannot see', async () => {
    // The EXISTS subquery reads `owned_item` under its own SELECT policy, so a capability without
    // a way to see the medicine writes nothing. That is the same property `0020` left in place
    // and the same safe direction: it refuses a write, it does not admit one.
    const message = await expectDenied(() => recordAs(BLIND_RECORDER));
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses somebody with no relationship to the profile', async () => {
    const message = await expectDenied(() => recordAs(STRANGER));
    expect(message).toMatch(/row-level security/i);
  });
});

describe('what did not change', () => {
  it('still lets a view-only caregiver read the history', async () => {
    // The asymmetry between reading and writing is the point of a capability model, and this is
    // the half `VIEW_MEDICINES` is for. A fix that also took the read away would have made the
    // grant useless to the person holding it.
    const res = await t.asUser(VIEWER, (db) =>
      db.query('SELECT id FROM dose_event WHERE owned_item_id = $1', [MEDICINE]),
    );
    expect(res.rows.length).toBeGreaterThan(0);
  });

  it('still refuses to let anybody edit or delete a recorded dose', async () => {
    // `RECORD_DOSES` covers correcting a record by covering the only way this schema permits one
    // to be corrected: a further event. The trigger refuses the alternative to every role,
    // including the owner, so "add a correction" cannot quietly become "rewrite the history".
    const updated = await expectDenied(() =>
      t.asUser(OWNER, (db) => db.query(`UPDATE dose_event SET event_kind = 'SKIPPED'`)),
    );
    expect(updated).toMatch(/append-only|permission denied|not permitted/i);

    const deleted = await expectDenied(() =>
      t.asUser(OWNER, (db) => db.query('DELETE FROM dose_event')),
    );
    expect(deleted).toMatch(/append-only|permission denied|not permitted/i);
  });
});

describe('the grants that existed before the capability did', () => {
  it('gained nothing from the migration', async () => {
    // The product decision this implements says an owner has to grant `RECORD_DOSES` explicitly,
    // and the way a migration breaks that promise is by backfilling to keep existing caregivers
    // working. `0021` widens the vocabulary and writes to no row of `caregiver_grant`, so every
    // grant in this database holds exactly the capabilities its setup named - and the assertion
    // is over `capabilities` itself rather than over behaviour, because behaviour would also pass
    // if a policy were quietly widened somewhere else instead.
    const res = await t.asService((db) =>
      db.query<{ grantee_user_id: string; capabilities: string[] }>(
        'SELECT grantee_user_id, capabilities FROM caregiver_grant WHERE grantee_user_id = ANY($1)',
        [[VIEWER, MANAGER, RECORDER, BLIND_RECORDER]],
      ),
    );

    const held = new Map(
      res.rows.map((row) => [row.grantee_user_id, [...row.capabilities].sort()]),
    );
    // Each grant, whole, rather than a count of who holds the new capability - a count would also
    // pass if a migration had taken a capability away from somebody instead of adding one.
    expect(held.get(VIEWER)).toEqual(['VIEW_MEDICINES']);
    expect(held.get(MANAGER)).toEqual(['MANAGE_MEDICINES', 'VIEW_MEDICINES']);
    expect(held.get(RECORDER)).toEqual(['RECORD_DOSES', 'VIEW_MEDICINES']);
    expect(held.get(BLIND_RECORDER)).toEqual(['RECORD_DOSES']);
  });

  it('keeps the constraint a superset of nothing the domain does not name', async () => {
    // `db/caregiver.test.ts` asserts the two CHECK constraints and the domain vocabulary agree.
    // This is the half that matters after a vocabulary change: the value the policy now reads has
    // to be one a grant is actually allowed to hold, or the capability could never be granted and
    // the feature would fail closed for everybody including the people it was written for.
    expect(CAREGIVER_CAPABILITIES).toContain('RECORD_DOSES');

    const granted = await t.asService((db) =>
      db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, ARRAY['RECORD_DOSES'], 'ACTIVE', now())
         RETURNING id`,
        [PROFILE, STRANGER, OWNER],
      ),
    );
    expect(granted.rows).toHaveLength(1);
  });
});
