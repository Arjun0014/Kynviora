import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Deleting a person from a household (DEC-120, `DEV-036`).
 *
 * Spec references: `16` (a person can have their data removed), `14` (re-authentication for
 * high-impact actions), `13` (the API is not an oracle; a profile ID is never proof of access),
 * `docs/RETENTION.md`.
 *
 * WHAT IS DIFFERENT FROM DELETING AN ITEM
 * Three things, and each is a way this could be right about the profile and wrong about everything
 * under it.
 *
 *  1. **The shelf has to go too**, and go *at the same instant*. Not eventually, and not by the
 *     purge working it out: every child of an item reaches its purge door through the item's own
 *     stamp, so a profile-only deletion leaves dose events the sweep can see and cannot remove.
 *  2. **Caregivers lose access to a profile that no longer exists**, on their very next request,
 *     which is the same guarantee revocation makes everywhere and is easiest to break here because
 *     the grant row is not what was deleted.
 *  3. **The last profile may go.** Refusing would make "have my data removed" conditional on
 *     keeping some of it.
 */

const OWNER = testUuid(1);
const CAREGIVER = testUuid(2);
const STRANGER = testUuid(3);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const OTHER_PROFILE = testUuid(21);

const MEDICINE = testUuid(30);
const SHAMPOO = testUuid(31);
const OTHER_MEDICINE = testUuid(32);

const NOW = instantFrom('2026-09-05T12:00:00.000Z');
const STEPPED_UP = instantFrom('2026-09-05T11:55:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;

function principalFor(userId: string, stepUpVerifiedAt: Instant | null = STEPPED_UP): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt };
}

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
    await db.query(`INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'A')`, [
      HOUSEHOLD,
      OWNER,
    ]);
  });

  const pool: DatabasePool = {
    withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
    withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
  };

  const sources: ReadonlyMap<string, SourceRegistryEntry> = new Map(
    ALL_FIXTURE_SOURCES.map((s) => [s.id, asApprovedSourceForTest(s)]),
  );

  app = createServer({
    surface: 'HOUSEHOLD',
    pool,
    logger: noopLogger(),
    authenticate: (_request: FastifyRequest) => Promise.resolve(currentPrincipal),
    now: (): Instant => NOW,
    loadSources: () => Promise.resolve(sources),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

beforeEach(async () => {
  await t.asOwner(async (db) => {
    await db.query('TRUNCATE audit_event');
    await db.query('DELETE FROM dose_event');
    await db.query('DELETE FROM medicine_schedule');
    await db.query('DELETE FROM owned_item');
    await db.query('DELETE FROM caregiver_grant');
    await db.query('DELETE FROM profile');

    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent A (synthetic)'), ($4, $2, $3, 'Parent B (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER, OTHER_PROFILE],
    );
    await db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4::text[], 'ACTIVE', now())`,
      [PROFILE, CAREGIVER, OWNER, ['VIEW_SHELF', 'VIEW_MEDICINES', 'MANAGE_MEDICINES']],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet'),
              ($3, $2, 'PERSONAL_CARE', 'Synthetic Shampoo'),
              ($4, $5, 'MEDICINE', 'The Other Profile Tablet')`,
      [MEDICINE, PROFILE, SHAMPOO, OTHER_MEDICINE, OTHER_PROFILE],
    );
    await db.query(
      `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, timezone, times_local)
       VALUES ($1, 'FIXED_TIMES', 'Asia/Kolkata', ARRAY['08:00'])`,
      [MEDICINE],
    );
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

const remove = (as: Principal | null, profileId: string) =>
  request(as, { method: 'DELETE', url: `/v1/profiles/${profileId}` });

async function visibleProfiles(as: Principal | null): Promise<readonly string[]> {
  const res = await request(as, { method: 'GET', url: '/v1/profiles' });
  const body = res.json<{ profiles?: readonly { id: string }[] }>();
  return (body.profiles ?? []).map((profile) => profile.id);
}

async function liveItems(profileId: string): Promise<number> {
  const res = await t.asService((db) =>
    db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM owned_item WHERE profile_id = $1 AND deleted_at IS NULL`,
      [profileId],
    ),
  );
  return res.rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------

describe('who may delete a profile', () => {
  it('lets the owner, and answers 204', async () => {
    const res = await remove(principalFor(OWNER), PROFILE);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('refuses a caregiver holding MANAGE_MEDICINES, as absence', async () => {
    // No capability authorises deletion. A caregiver may change what a record says and may never
    // make a person stop existing.
    const res = await remove(principalFor(CAREGIVER), PROFILE);
    expect(res.statusCode).toBe(404);
    expect(await visibleProfiles(principalFor(OWNER))).toContain(PROFILE);
  });

  it('refuses a stranger identically', async () => {
    expect((await remove(principalFor(STRANGER), PROFILE)).statusCode).toBe(404);
  });

  it('requires fresh step-up, checked before the profile is looked at', async () => {
    const res = await remove(principalFor(OWNER, null), PROFILE);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });

    // And for an id that does not exist, so a stale session learns nothing by probing.
    const unknown = await remove(principalFor(OWNER, null), testUuid(999));
    expect(unknown.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
  });
});

describe('what goes with the person', () => {
  it('takes them off the switcher immediately', async () => {
    expect(await visibleProfiles(principalFor(OWNER))).toEqual([PROFILE, OTHER_PROFILE]);
    await remove(principalFor(OWNER), PROFILE);
    expect(await visibleProfiles(principalFor(OWNER))).toEqual([OTHER_PROFILE]);
  });

  it('takes the whole shelf with it, at the same instant', async () => {
    // Not eventually and not by the purge working it out. Every child of an item reaches its purge
    // door through the item's own stamp, so a profile-only deletion would leave dose events the
    // sweep can see and cannot remove.
    expect(await liveItems(PROFILE)).toBe(2);
    await remove(principalFor(OWNER), PROFILE);
    expect(await liveItems(PROFILE)).toBe(0);

    // And the two stamps are the same instant, so the household becomes due for purge together.
    const stamps = await t.asService((db) =>
      db.query<{ profile_at: string; item_at: string }>(
        `SELECT p.deleted_at AS profile_at, i.deleted_at AS item_at
           FROM profile p JOIN owned_item i ON i.profile_id = p.id
          WHERE p.id = $1 LIMIT 1`,
        [PROFILE],
      ),
    );
    expect(stamps.rows[0]?.item_at).toEqual(stamps.rows[0]?.profile_at);
  });

  it('leaves the other profile’s shelf untouched', async () => {
    // The failure this guards is a `WHERE` clause that named the household rather than the person.
    await remove(principalFor(OWNER), PROFILE);
    expect(await liveItems(OTHER_PROFILE)).toBe(1);
    expect(await visibleProfiles(principalFor(OWNER))).toEqual([OTHER_PROFILE]);
  });

  it('stops the reminders', async () => {
    const before = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/schedules`,
    });
    expect(before.json<{ schedules: unknown[] }>().schedules).toHaveLength(1);

    await remove(principalFor(OWNER), PROFILE);

    const after = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/schedules`,
    });
    expect(after.json<{ schedules: unknown[] }>().schedules).toHaveLength(0);
  });

  it('ends a caregiver’s access on their very next request', async () => {
    // The same guarantee revocation makes everywhere, and easiest to break here because the grant
    // row is not what was deleted - `has_capability` reads through `profile`, which is.
    expect(await visibleProfiles(principalFor(CAREGIVER))).toContain(PROFILE);
    await remove(principalFor(OWNER), PROFILE);
    expect(await visibleProfiles(principalFor(CAREGIVER))).not.toContain(PROFILE);

    const shelf = await request(principalFor(CAREGIVER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE}`,
    });
    expect(shelf.json<{ items: unknown[] }>().items).toHaveLength(0);
  });
});

describe('deleting the last profile', () => {
  it('is allowed, and leaves a household with none', async () => {
    // Refusing would make "have my data removed" conditional on keeping some of it, and would tell
    // somebody the last person on their list is special for a reason nobody agreed to.
    await remove(principalFor(OWNER), PROFILE);
    await remove(principalFor(OWNER), OTHER_PROFILE);
    expect(await visibleProfiles(principalFor(OWNER))).toEqual([]);
  });
});

describe('the audit', () => {
  it('records the deletion with a count and no health content', async () => {
    await remove(principalFor(OWNER), PROFILE);

    const rows = await t.asService((db) =>
      db.query<{ action: string; target_id: string; actor_user_id: string; detail: unknown }>(
        `SELECT action, target_id, actor_user_id, detail FROM audit_event`,
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      action: 'profile.deleted',
      target_id: PROFILE,
      actor_user_id: OWNER,
    });

    // How many medicines a household held is the kind of number an investigation needs; a name is
    // not (`20`).
    expect(rows.rows[0]?.detail).toMatchObject({ item_count: 2 });
    const serialized = JSON.stringify(rows.rows[0]);
    expect(serialized).not.toContain('Parent A');
    expect(serialized).not.toContain('Synthetic Tablet');
  });

  it('writes nothing when the deletion is refused', async () => {
    await remove(principalFor(CAREGIVER), PROFILE);
    const rows = await t.asService((db) => db.query(`SELECT action FROM audit_event`));
    expect(rows.rows).toHaveLength(0);
  });
});

describe('deleting twice', () => {
  it('answers not-found the second time', async () => {
    expect((await remove(principalFor(OWNER), PROFILE)).statusCode).toBe(204);
    expect((await remove(principalFor(OWNER), PROFILE)).statusCode).toBe(404);
  });
});
