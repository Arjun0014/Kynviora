import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Deleting an item, end to end, against the real engine and the real policy.
 *
 * `16` requires that a person can have their data removed and that the workflow enumerates what
 * goes; `docs/RETENTION.md` section 1 makes revocation a synchronous promise rather than a job
 * that will get round to it. Those are the two things measured here, plus the one that could most
 * plausibly have gone wrong: that "removed" reaches everybody, not only the person who asked.
 *
 * WHAT THIS FILE ADDS OVER `db/retention.test.ts`
 * That file asks the database what the policy permits. This one asks the route what a person
 * experiences, which is a different question in three places: step-up is a route decision and has
 * no policy behind it; a refusal has to arrive as the same not-found an unknown item gives,
 * because `13` will not let the API be an oracle; and the audit event has to exist afterwards,
 * which no policy requires and `14` does.
 */

const OWNER = testUuid(1);
/** MANAGE_MEDICINES and MANAGE_SHELF: everything short of ownership. */
const MANAGER = testUuid(2);
/** VIEW_MEDICINES and VIEW_SHELF: may look. */
const READER = testUuid(3);
const STRANGER = testUuid(4);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const MEDICINE = testUuid(30);
const SHAMPOO = testUuid(31);

const NOW = instantFrom('2026-09-05T12:00:00.000Z');
/** Inside `STEP_UP_VALIDITY_MS` of `NOW`. */
const STEPPED_UP = instantFrom('2026-09-05T11:55:00.000Z');
/** Outside it - a session that was stepped up an hour ago is not stepped up now. */
const STALE_STEP_UP = instantFrom('2026-09-05T11:00:00.000Z');

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
      [MANAGER, 'manager@example.test'],
      [READER, 'reader@example.test'],
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
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent A (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );

    for (const [user, capabilities] of [
      // Everything a caregiver can hold that touches an item. If deletion were reachable through
      // any capability, this grant would find it.
      [
        MANAGER,
        [
          'VIEW_SHELF',
          'MANAGE_SHELF',
          'VIEW_MEDICINES',
          'MANAGE_MEDICINES',
          'RECORD_DOSES',
          'MANAGE_CAREGIVERS',
        ],
      ],
      [READER, ['VIEW_SHELF', 'VIEW_MEDICINES']],
    ] as const) {
      await db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, $4::text[], 'ACTIVE', now())`,
        [PROFILE, user, OWNER, capabilities],
      );
    }
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
    // TRUNCATE rather than DELETE, and not for speed: `audit_event` is append-only and since
    // `0022` its trigger answers a DELETE of a recent row with "within the retention period"
    // (DEC-117). That is the trigger working, and it applies to a test fixture exactly as it
    // applies to anything else. TRUNCATE does not fire row-level triggers, which makes it the one
    // way to reset the table without weakening the thing under test.
    await db.query('TRUNCATE audit_event');
    await db.query('DELETE FROM medicine_schedule');
    await db.query('DELETE FROM owned_item');
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, brand, market, strength_text, dosage_form)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet', 'Synthetic Brand', 'GB', '500 mg', 'Tablet')`,
      [MEDICINE, PROFILE],
    );
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, personal_care_category,
          ingredient_declaration_raw)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Synthetic Shampoo', 'HAIR_CARE', 'Aqua, Glycerin')`,
      [SHAMPOO, PROFILE],
    );
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

const remove = (as: Principal | null, itemId: string) =>
  request(as, { method: 'DELETE', url: `/v1/items/${itemId}` });

const shelf = (as: Principal | null) =>
  request(as, { method: 'GET', url: `/v1/items?profileId=${PROFILE}` });

/**
 * The item IDs on a shelf page.
 *
 * A reader rather than a shape repeated at each call site. `json<T>()` is the typed form the
 * other route tests use; a response that stopped carrying `items` then fails here rather than
 * somewhere less obvious.
 */
async function shelfIds(as: Principal | null): Promise<readonly string[]> {
  const res = await shelf(as);
  const body = res.json<{ items?: readonly { id: string }[] }>();
  return (body.items ?? []).map((item) => item.id);
}

async function storedRow(id: string) {
  const result = await t.asService((db) =>
    db.query<{ deleted_at: unknown }>('SELECT deleted_at FROM owned_item WHERE id = $1', [id]),
  );
  return result.rows[0];
}

async function auditRows() {
  return t.asService((db) =>
    db.query<{ action: string; target_id: string; actor_user_id: string; detail: unknown }>(
      `SELECT action, target_id, actor_user_id, detail FROM audit_event ORDER BY occurred_at`,
    ),
  );
}

// ---------------------------------------------------------------------------

describe('who may delete', () => {
  it('lets the profile owner, and answers 204 with no body', async () => {
    const res = await remove(principalFor(OWNER), MEDICINE);
    expect(res.statusCode).toBe(204);
    // Nothing described. A body naming what was removed would be the one place in this API that
    // hands back health content after being asked to destroy it.
    expect(res.body).toBe('');
  });

  it('refuses a caregiver holding every item capability, as absence', async () => {
    const res = await remove(principalFor(MANAGER), MEDICINE);
    // 404, not 403. `13` does not let this route confirm that an item ID belongs to somebody, and
    // a deletion endpoint that did would be the most useful oracle in the system.
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect((await storedRow(MEDICINE))?.deleted_at).toBeNull();
  });

  it('refuses that caregiver on a personal-care item too', async () => {
    // `owned_item_update` branches on item kind, so a rule written for medicines alone would
    // leave shampoo deletable by `MANAGE_SHELF`.
    const res = await remove(principalFor(MANAGER), SHAMPOO);
    expect(res.statusCode).toBe(404);
    expect((await storedRow(SHAMPOO))?.deleted_at).toBeNull();
  });

  it('refuses a reader and a stranger identically', async () => {
    for (const who of [READER, STRANGER]) {
      const res = await remove(principalFor(who), MEDICINE);
      expect(res.statusCode).toBe(404);
    }
    expect((await storedRow(MEDICINE))?.deleted_at).toBeNull();
  });

  it('refuses an anonymous request before it reads anything', async () => {
    const res = await remove(null, MEDICINE);
    expect(res.statusCode).toBe(401);
  });
});

describe('step-up', () => {
  it('is required, and is checked before the item is looked at', async () => {
    const res = await remove(principalFor(OWNER, null), MEDICINE);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
    expect((await storedRow(MEDICINE))?.deleted_at).toBeNull();
  });

  it('expires', async () => {
    // `14` asks for re-authentication, not for having authenticated once. An hour-old step-up on
    // an unattended device is the case the validity window exists for.
    const res = await remove(principalFor(OWNER, STALE_STEP_UP), MEDICINE);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
  });

  it('is answered before an unknown item is, so a stale session learns nothing', async () => {
    // The ordering matters for more than tidiness: if the parameter were checked first, an
    // un-stepped-up caller could probe item IDs and read 404 against 403.
    const res = await remove(principalFor(OWNER, null), testUuid(999));
    expect(res.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
  });
});

describe('what a deletion has already done by the time it answers', () => {
  it('takes the item off the owner’s shelf', async () => {
    expect(await shelfIds(principalFor(OWNER))).toEqual([MEDICINE, SHAMPOO]);

    await remove(principalFor(OWNER), MEDICINE);

    // No job ran in between. Revocation is the promise `docs/RETENTION.md` makes, and it is made
    // by the same predicate every read already carries.
    expect(await shelfIds(principalFor(OWNER))).toEqual([SHAMPOO]);
  });

  it('takes it off every caregiver’s shelf in the same instant', async () => {
    // The failure worth guarding: a deletion that only the deleter can see is a product telling
    // somebody their data is gone while everyone they ever granted access to still reads it.
    await remove(principalFor(OWNER), MEDICINE);

    for (const who of [MANAGER, READER]) {
      expect(await shelfIds(principalFor(who))).toEqual([SHAMPOO]);
    }
  });

  it('makes the detail unreachable, for the owner as much as anybody', async () => {
    await remove(principalFor(OWNER), MEDICINE);
    const res = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items/${MEDICINE}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('stops the reminders', async () => {
    // The one consequence of a deleted item that reaches a person after the fact. A schedule that
    // outlived its medicine is a phone telling somebody to take a tablet they have deleted.
    await t.asService((db) =>
      db.query(
        `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, timezone, times_local)
         VALUES ($1, 'FIXED_TIMES', 'Asia/Kolkata', ARRAY['08:00'])`,
        [MEDICINE],
      ),
    );

    const before = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/schedules`,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().schedules).toHaveLength(1);

    await remove(principalFor(OWNER), MEDICINE);

    const after = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/schedules`,
    });
    expect(after.json().schedules).toHaveLength(0);
  });

  it('takes it out of the Visit Pack candidates', async () => {
    // An export assembled from a deleted item would put it back in front of a clinician, which is
    // the opposite of what was asked for.
    const before = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/visit-packs/candidates?profileId=${PROFILE}`,
    });
    expect(before.statusCode).toBe(200);
    const beforeIds = JSON.stringify(before.json());
    expect(beforeIds).toContain(MEDICINE);

    await remove(principalFor(OWNER), MEDICINE);

    const after = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/visit-packs/candidates?profileId=${PROFILE}`,
    });
    expect(JSON.stringify(after.json())).not.toContain(MEDICINE);
  });
});

describe('the audit', () => {
  it('records the deletion, naming the actor and the item and no health content', async () => {
    await remove(principalFor(OWNER), MEDICINE);

    const rows = (await auditRows()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'item.deleted',
      target_id: MEDICINE,
      actor_user_id: OWNER,
    });

    // `20` forbids the audit becoming a copy of health content. The item kind is here because it
    // makes the row usable for an investigation without naming a medicine; the display name and
    // the brand are not, and a serialized row must not contain them.
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain('Synthetic Tablet');
    expect(serialized).not.toContain('Synthetic Brand');
    expect(rows[0]?.detail).toMatchObject({ profile_id: PROFILE, item_kind: 'MEDICINE' });
  });

  it('writes nothing when the deletion is refused', async () => {
    // A refused attempt is not an event about an item; it is a caregiver being told no, which the
    // response already says. An audit row here would attach a caregiver's user ID to a household
    // item they were never permitted to touch.
    await remove(principalFor(MANAGER), MEDICINE);
    expect((await auditRows()).rows).toHaveLength(0);
  });

  it('survives the deletion it describes', async () => {
    // The point of `audit_event` being retained rather than cascaded (DEC-117). The item row is
    // still present here because purge is asynchronous, so what this measures is the weaker and
    // sufficient thing: nothing in the deletion path removes the audit row.
    await remove(principalFor(OWNER), MEDICINE);
    expect((await auditRows()).rows).toHaveLength(1);
  });
});

describe('deleting twice', () => {
  it('answers not-found the second time and does not move the purge deadline', async () => {
    const first = await remove(principalFor(OWNER), MEDICINE);
    expect(first.statusCode).toBe(204);
    const stampedAt = (await storedRow(MEDICINE))?.deleted_at;

    const second = await remove(principalFor(OWNER), MEDICINE);
    expect(second.statusCode).toBe(404);
    // An item that could be re-stamped could be kept past its purge deadline indefinitely by
    // deleting it again.
    expect((await storedRow(MEDICINE))?.deleted_at).toEqual(stampedAt);
  });

  it('writes one audit event, not two', async () => {
    await remove(principalFor(OWNER), MEDICINE);
    await remove(principalFor(OWNER), MEDICINE);
    expect((await auditRows()).rows).toHaveLength(1);
  });
});

describe('a malformed or unknown id', () => {
  it('answers exactly as a forbidden one does', async () => {
    const unknown = await remove(principalFor(OWNER), testUuid(998));
    const malformed = await remove(principalFor(OWNER), 'not-a-uuid');
    const forbidden = await remove(principalFor(STRANGER), MEDICINE);

    for (const res of [unknown, malformed, forbidden]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    // And the three are indistinguishable in the body as well as the status, because a message
    // that differed would be the oracle the status code refuses to be. `errors.ts` replaces the
    // route's own wording with a generic one on the way out, so what reaches a caller is the same
    // sentence whichever of the three happened - which is stronger than the route being careful,
    // because it holds for a route that is not.
    const bodies = [unknown, malformed, forbidden].map((res) => {
      const body = res.json<{ error: Record<string, unknown> }>();
      // The correlation ID is per-request by design and is the only field that may differ.
      const { correlationId: _ignored, ...rest } = body.error;
      return rest;
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ code: 'NOT_FOUND', message: 'Not found.' });
  });
});
