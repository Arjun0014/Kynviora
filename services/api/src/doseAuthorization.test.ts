/**
 * Who may write into somebody else's dose history.
 *
 * Spec references: `11` and `12` (access control is server-authoritative; authorization loss
 * invalidates access), `07` (the caregiver capability vocabulary), `04` Phase 4.3, `13`, `19`
 * (integration coverage of API authorization), `DEV-048`.
 *
 * WHY THIS EXISTS NOW
 * A dose event became a thing a phone can queue while offline (`DEV-048`), which changes what a
 * revoked or narrowly-granted caregiver's journal can do: an operation written days earlier is
 * replayed later, by a drain, against whatever the grant says at the moment it lands. The client
 * stops its drain on authorization loss (DEC-109), and that is the wrong place to rest this on -
 * `11` puts the decision on the server and `12` requires losing access to invalidate it, so what
 * has to be true is that the **route** refuses.
 *
 * These run against the real database through PGlite with row-level security in force as the
 * non-superuser `kynviora_app` role, which is the only way to test a policy rather than a mock of
 * one.
 *
 * WHAT THIS FILE MEASURED BEFORE, AND WHAT IT MEASURES NOW
 * It used to pin a contradiction. `0004` gave `dose_event` a policy inheriting reachability from
 * the item and `0020` called that deliberate - "`dose_event` is a record of something that
 * happened and is reachability-scoped on purpose" - while the grant screen described
 * `VIEW_MEDICINES` as `allowsChanges: false` and listed it under "viewing". Both decisions were
 * made, in different places, and never reconciled (`DEV-049`, `BLK-011`), so the test recorded the
 * behaviour as it stood and said the day it changes, this file fails.
 *
 * It changed. DEC-116 resolves it the third way `DEV-049` set out: `VIEW_MEDICINES` stays strictly
 * read-only, `MANAGE_MEDICINES` keeps managing medicines and schedules, and writing into a dose
 * history is `RECORD_DOSES` - its own capability, which no existing grant acquired, because
 * migration `0021` widens the vocabulary and backfills nothing.
 *
 * So the file now measures three things that used to be one: that a view-only caregiver is
 * refused, that a caregiver granted the new capability is not, and that holding the *larger*
 * medicine capability is not a way in either - the capabilities are separate rather than nested,
 * and a grant carries exactly what its owner ticked.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

const OWNER = testUuid(1);
/** Granted `VIEW_MEDICINES` only: they can read the shelf and nothing else. */
const VIEWER = testUuid(2);
/** Granted `VIEW_MEDICINES` and then revoked. */
const REVOKED = testUuid(3);
const STRANGER = testUuid(4);
/** Granted `VIEW_MEDICINES` + `RECORD_DOSES`: the case the capability exists for (DEC-116). */
const RECORDER = testUuid(5);
/** Granted `VIEW_MEDICINES` + `MANAGE_MEDICINES`, and deliberately not `RECORD_DOSES`. */
const MANAGER = testUuid(6);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const MEDICINE = testUuid(30);

const NOW = instantFrom('2026-09-04T09:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;

function principalFor(userId: string): Principal {
  return {
    userId: unsafeId<UserId>(userId),
    stepUpVerifiedAt: null as Principal['stepUpVerifiedAt'],
  };
}

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

/** Record a dose as somebody, with a fresh key each time so nothing replays by accident. */
async function recordDose(as: string, key: number, note = 'synthetic') {
  return request(principalFor(as), {
    method: 'POST',
    url: '/v1/dose-events',
    headers: { 'idempotency-key': testUuid(key) },
    payload: { ownedItemId: MEDICINE, eventKind: 'TAKEN', note },
  });
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [VIEWER, 'viewer@example.test'],
      [REVOKED, 'revoked@example.test'],
      [STRANGER, 'stranger@example.test'],
      [RECORDER, 'recorder@example.test'],
      [MANAGER, 'manager@example.test'],
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
       VALUES ($1, $2, $3, 'Parent (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, strength_text, dosage_form)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet A', '500 mg', 'tablet')`,
      [MEDICINE, PROFILE],
    );

    await db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, ARRAY['VIEW_MEDICINES'], 'ACTIVE', now())`,
      [PROFILE, VIEWER, OWNER],
    );
    await db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, ARRAY['VIEW_MEDICINES', 'RECORD_DOSES'], 'ACTIVE', now())`,
      [PROFILE, RECORDER, OWNER],
    );
    await db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, ARRAY['VIEW_MEDICINES', 'MANAGE_MEDICINES'], 'ACTIVE', now())`,
      [PROFILE, MANAGER, OWNER],
    );
    await db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at,
          revoked_at, revoked_by_user_id)
       VALUES ($1, $2, $3, ARRAY['VIEW_MEDICINES'], 'REVOKED', now(), now(), $3)`,
      [PROFILE, REVOKED, OWNER],
    );
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
    now: () => NOW,
    loadSources: () => Promise.resolve(sources),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

describe('recording a dose against somebody else’s medicine', () => {
  it('lets the owner record one', async () => {
    // The positive control. Without it every refusal below could be a route that refuses
    // everybody, which is a different app and passes each of these tests.
    const response = await recordDose(OWNER, 100);
    expect(response.statusCode).toBe(201);
  });

  it('refuses a stranger, and says nothing about whether the item exists', async () => {
    const response = await recordDose(STRANGER, 101);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { message: 'Not found.' } });
  });

  it('refuses a caregiver whose grant was revoked', async () => {
    // The one `DEV-048` makes newly reachable. A queued dose is replayed by a drain days later,
    // and the grant it lands against is whatever stands then - so the refusal has to be the
    // server's, not the client's decision to stop draining (`11`, `12`).
    const response = await recordDose(REVOKED, 102);
    expect(response.statusCode).toBe(404);
  });

  it('refuses a revoked caregiver replaying an operation they recorded while granted', async () => {
    // The specific shape an offline journal produces. The key was minted while the grant stood;
    // the replay arrives after it ended. A route keyed only on the operation id would answer
    // `idempotent-replay` and hand back a row the caller may no longer see.
    const key = 103;
    const granted = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/dose-events',
      headers: { 'idempotency-key': testUuid(key) },
      payload: { ownedItemId: MEDICINE, eventKind: 'TAKEN', note: 'recorded while granted' },
    });
    expect(granted.statusCode).toBe(201);

    const replay = await recordDose(REVOKED, key, 'recorded while granted');
    expect(replay.statusCode).toBe(404);
  });
});

describe('what a view-only caregiver can do', () => {
  it('can read the dose history, which is what VIEW_MEDICINES is for', async () => {
    const response = await request(principalFor(VIEWER), {
      method: 'GET',
      url: `/v1/dose-events?ownedItemId=${MEDICINE}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ events: readonly unknown[] }>();
    expect(body.events.length).toBeGreaterThan(0);
  });

  it('cannot write one', async () => {
    // `DEV-049` closed. This used to answer 201 while the invitation screen called the same grant
    // read-only; migration `0021` makes the screen true. Refused as the same not-found every other
    // refusal gives, because there is deliberately no outcome in this API meaning "you are not
    // allowed" (trap 89) - the screen withholds the control instead, on `mayRecordDoses`.
    const response = await recordDose(VIEWER, 104, 'written by a view-only caregiver');
    expect(response.statusCode).toBe(404);
  });

  it('cannot reach a profile they were never granted', async () => {
    const response = await request(principalFor(VIEWER), { method: 'GET', url: '/v1/profiles' });
    const body = response.json<{ profiles: readonly { id: string }[] }>();
    expect(body.profiles.map((p) => p.id)).toEqual([PROFILE]);
  });
});

describe('what RECORD_DOSES is for (DEC-116)', () => {
  it('lets a caregiver granted it record a dose', async () => {
    // The whole reason the capability is a third one rather than a tightening onto
    // `MANAGE_MEDICINES`: the most ordinary act of caring for somebody must not require the grant
    // that can also delete their medicines and silence their reminders.
    const response = await recordDose(RECORDER, 105, 'recorded by a caregiver granted it');
    expect(response.statusCode).toBe(201);
  });

  it('does not let MANAGE_MEDICINES stand in for it', async () => {
    // The direction it would be easy to get wrong. `MANAGE_MEDICINES` is the larger permission in
    // every ordinary sense, and nesting it here would make the policy read a capability nobody
    // ticked - the same failure as `DEV-049` with the roles reversed. Capabilities are a set, not
    // a ladder.
    const response = await recordDose(MANAGER, 106, 'written by a medicine manager');
    expect(response.statusCode).toBe(404);
  });

  it('tells the screen which of the two it has, separately', async () => {
    // What stops a person filling in a form for nothing. The detail answers both questions with
    // the predicates the two policies apply, so this caller is offered the dose controls and not
    // the editing ones - and the screen cannot derive either from the other (DEC-045).
    const response = await request(principalFor(RECORDER), {
      method: 'GET',
      url: `/v1/items/${MEDICINE}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ mayEdit: boolean; mayRecordDoses: boolean }>();
    expect(body.mayRecordDoses).toBe(true);
    expect(body.mayEdit).toBe(false);
  });

  it('tells the shelf the same thing, for the row the control is drawn on', async () => {
    // The dose control lives on the shelf row rather than the detail, so the list has to carry the
    // answer too - or the screen would offer it to everybody who can see a medicine, which is the
    // state this whole change is undoing.
    const viewer = await request(principalFor(VIEWER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE}`,
    });
    expect(viewer.json<{ mayRecordDoses: boolean }>().mayRecordDoses).toBe(false);

    const recorder = await request(principalFor(RECORDER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE}`,
    });
    expect(recorder.json<{ mayRecordDoses: boolean }>().mayRecordDoses).toBe(true);
  });

  it('leaves the owner able to record on their own medicine', async () => {
    // `has_capability` short-circuits on ownership, so the person whose medicines these are never
    // needed a grant and still does not. Asserted through the detail as well as the write, because
    // a screen that stopped offering the control would be the same outage as a policy that
    // refused it.
    const detail = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items/${MEDICINE}`,
    });
    expect(detail.json<{ mayRecordDoses: boolean }>().mayRecordDoses).toBe(true);
    expect((await recordDose(OWNER, 107)).statusCode).toBe(201);
  });
});

describe('an idempotency key another household has already used (DEV-031)', () => {
  const NEIGHBOUR = testUuid(7);
  const NEIGHBOUR_HOUSEHOLD = testUuid(11);
  const NEIGHBOUR_PROFILE = testUuid(21);
  const NEIGHBOUR_MEDICINE = testUuid(31);
  /** One UUID, used by two households that have never heard of each other. */
  const SHARED_KEY = testUuid(900);

  beforeAll(async () => {
    await t.asService(async (db) => {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, 'neighbour@example.test', now())`,
        [NEIGHBOUR, `auth|${NEIGHBOUR}`],
      );
      await db.query(
        `INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'B')`,
        [NEIGHBOUR_HOUSEHOLD, NEIGHBOUR],
      );
      await db.query(
        `INSERT INTO profile (id, household_id, owner_user_id, display_name)
         VALUES ($1, $2, $3, 'Neighbour (synthetic)')`,
        [NEIGHBOUR_PROFILE, NEIGHBOUR_HOUSEHOLD, NEIGHBOUR],
      );
      await db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
         VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet B')`,
        [NEIGHBOUR_MEDICINE, NEIGHBOUR_PROFILE],
      );
    });
  });

  async function recordAgainst(as: string, itemId: string, keyUuid: string) {
    return request(principalFor(as), {
      method: 'POST',
      url: '/v1/dose-events',
      headers: { 'idempotency-key': keyUuid },
      payload: { ownedItemId: itemId, eventKind: 'TAKEN', note: 'synthetic' },
    });
  }

  it('does not stop the second household recording their own dose', async () => {
    // The defect, end to end. Under a globally unique key the second write conflicted, the route
    // read the conflict as a retry, the replay read found nothing under row-level security, and a
    // person was told their dose was recorded when nothing was recorded.
    const first = await recordAgainst(OWNER, MEDICINE, SHARED_KEY);
    expect(first.statusCode).toBe(201);

    const second = await recordAgainst(NEIGHBOUR, NEIGHBOUR_MEDICINE, SHARED_KEY);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replay']).toBeUndefined();

    const body = second.json<{ id: string | null }>();
    expect(body.id).not.toBeNull();

    // And it is genuinely a second row, on the neighbour's own medicine.
    const rows = await t.asService((db) =>
      db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM dose_event WHERE client_operation_id = $1`,
        [SHARED_KEY],
      ),
    );
    expect(rows.rows[0]?.n).toBe(2);
  });

  it('still commits a genuine retry exactly once', async () => {
    // The guarantee `13` actually asks for, unchanged: same item, same key, one row.
    const key = testUuid(901);
    const first = await recordAgainst(OWNER, MEDICINE, key);
    expect(first.statusCode).toBe(201);
    const firstId = first.json<{ id: string }>().id;

    const retry = await recordAgainst(OWNER, MEDICINE, key);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replay']).toBe('true');

    const body = retry.json<{ id: string | null; replayed: boolean }>();
    expect(body.replayed).toBe(true);
    // The real id, not null. Scoping the replay read to the item is what makes that reliable:
    // the row a conflict names is now unambiguously the caller's own.
    expect(body.id).toBe(firstId);

    const rows = await t.asService((db) =>
      db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM dose_event WHERE client_operation_id = $1`,
        [key],
      ),
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('treats the same key on a different medicine as a different write', async () => {
    // Within one household this time, so nothing about visibility is involved. A retry sends the
    // same body and therefore the same item; two items with one key are two writes, and recording
    // both is the answer that loses nothing.
    const key = testUuid(902);
    expect((await recordAgainst(OWNER, MEDICINE, key)).statusCode).toBe(201);

    await t.asService((db) =>
      db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
         VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet C')`,
        [testUuid(32), PROFILE],
      ),
    );
    expect((await recordAgainst(OWNER, testUuid(32), key)).statusCode).toBe(201);
  });
});

/**
 * The other side of the same question: what a surface may **offer**.
 *
 * Spec references: `11`, `13`, `14`, DEC-045 (withheld, never disabled), DEC-116, DEC-141,
 * `DEV-074`.
 *
 * It lives in this file because the fixtures above are exactly the situations it needs - a
 * view-only caregiver, one granted `RECORD_DOSES`, one granted `MANAGE_MEDICINES` and not the
 * other, one revoked, and a stranger - and because the two halves belong together. Every test
 * above asserts that the route refuses; every test here asserts that the report the screen reads
 * agrees with it. A report that disagreed would be a person filling in a form for nothing, which
 * is the failure DEC-116's screen half exists to prevent (trap 89).
 */
describe('what this caller may do on a profile', () => {
  async function capabilities(as: string): Promise<readonly string[]> {
    const response = await request(principalFor(as), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/capabilities`,
    });
    expect(response.statusCode).toBe(200);
    return [...response.json<{ capabilities: string[] }>().capabilities].sort();
  }

  it('tells an owner they hold everything, because ownership is not a grant', async () => {
    // The positive control, and it has to be first: every assertion below is that somebody holds
    // *less*, and a route answering nobody anything would satisfy all of them.
    const held = await capabilities(OWNER);
    expect(held).toContain('RECORD_DOSES');
    expect(held).toContain('MANAGE_MEDICINES');
    expect(held).toContain('MANAGE_CAREGIVERS');
  });

  it('reports exactly the capabilities a grant carries, and no neighbours', async () => {
    // A grant carries what its owner ticked. DEC-116's whole point is that the capabilities are a
    // set rather than a ladder, so a report that rounded `VIEW_MEDICINES` up to anything would be
    // the over-granting the split exists to avoid, arriving through the report instead of the
    // policy.
    expect(await capabilities(VIEWER)).toEqual(['VIEW_MEDICINES']);
    expect(await capabilities(RECORDER)).toEqual(['RECORD_DOSES', 'VIEW_MEDICINES']);
    expect(await capabilities(MANAGER)).toEqual(['MANAGE_MEDICINES', 'VIEW_MEDICINES']);
  });

  it('agrees with the route about who may record a dose', async () => {
    // The property this route exists for. `mayRecordDoses` and the report must not be able to
    // disagree, because both are asked with `has_capability` - and this is the test that would
    // fail the day one of them stops being.
    expect(await capabilities(RECORDER)).toContain('RECORD_DOSES');
    expect((await recordDose(RECORDER, 700)).statusCode).toBe(201);

    expect(await capabilities(VIEWER)).not.toContain('RECORD_DOSES');
    expect((await recordDose(VIEWER, 701)).statusCode).toBe(404);
  });

  it('reports nothing for a caregiver whose grant was revoked', async () => {
    // Evaluated per access, so revocation takes effect immediately (`15` A2). A report cached
    // anywhere would leave a revoked caregiver being offered controls for as long as it lived.
    expect(await capabilities(REVOKED)).toEqual([]);
  });

  it('reports nothing to a stranger, and does not confirm the profile exists', async () => {
    // 200 with an empty list rather than 404. `13` makes a profile ID narrow rather than grant,
    // and an unknown ID must be indistinguishable from one the caller simply has no grant on -
    // which a refusal would give away.
    expect(await capabilities(STRANGER)).toEqual([]);

    const unknown = await request(principalFor(STRANGER), {
      method: 'GET',
      url: `/v1/profiles/${testUuid(999)}/capabilities`,
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json<{ capabilities: string[] }>().capabilities).toEqual([]);
  });

  it('refuses a profile id that is not one', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: '/v1/profiles/not-a-uuid/capabilities',
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers nothing at all without a session', async () => {
    // The report is about the caller. There is no caller.
    const response = await request(null, {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/capabilities`,
    });
    expect(response.statusCode).toBe(401);
  });
});

/**
 * A profile the caller can no longer see reports nothing (DEC-141, `DEV-082`).
 *
 * Its own describe block because it needs a profile to destroy, and every test above depends on
 * `PROFILE` surviving.
 *
 * The asymmetry this is about: `has_capability` short-circuits on ownership through
 * `owns_profile`, which filters `deleted_at IS NULL` - but its **caregiver-grant** branch does
 * not, and migration `0025` soft-deletes a profile without revoking the grants hanging off it
 * (they are purged later, past `purge_floor()`). So a caregiver's grant outlives the profile's
 * visibility by the length of the retention window.
 *
 * Without the visibility read in the route, that caregiver got a populated list from this one
 * endpoint while every other route on the surface answered empty - and diffing the two would tell
 * them "this profile was deleted" apart from "your access was revoked". Nothing else on this
 * surface makes that distinction, and `13` is explicit that absence and refused access are
 * deliberately indistinguishable.
 */
describe('a profile that has been deleted', () => {
  const DOOMED = testUuid(40);
  const DOOMED_CAREGIVER = testUuid(41);

  async function capabilities(as: string): Promise<readonly string[]> {
    const response = await request(principalFor(as), {
      method: 'GET',
      url: `/v1/profiles/${DOOMED}/capabilities`,
    });
    expect(response.statusCode).toBe(200);
    return [...response.json<{ capabilities: string[] }>().capabilities].sort();
  }

  beforeAll(async () => {
    await t.asService(async (db) => {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [DOOMED_CAREGIVER, `auth|${DOOMED_CAREGIVER}`, 'doomed@example.test'],
      );
      await db.query(
        `INSERT INTO profile (id, household_id, owner_user_id, display_name)
         VALUES ($1, $2, $3, 'Doomed (synthetic)')`,
        [DOOMED, HOUSEHOLD, OWNER],
      );
      await db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, ARRAY['VIEW_MEDICINES', 'RECORD_DOSES'], 'ACTIVE', now())`,
        [DOOMED, DOOMED_CAREGIVER, OWNER],
      );
    });
  });

  it('reports the grant while the profile is still there', async () => {
    // The positive control, and this block needs one more than most: everything below is an
    // absence, and a route that answered nobody anything would satisfy all of it.
    expect(await capabilities(DOOMED_CAREGIVER)).toEqual(['RECORD_DOSES', 'VIEW_MEDICINES']);
  });

  it('reports nothing once the profile is deleted, though the grant is still on the row', async () => {
    await t.asService((db) => db.query(`SELECT kynviora.delete_profile($1, $2)`, [DOOMED, OWNER]));

    // The grant is untouched - that is the whole reason this check exists rather than being
    // implied by the grant going away.
    const grants = await t.asService((db) =>
      db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM caregiver_grant
          WHERE profile_id = $1 AND status = 'ACTIVE' AND revoked_at IS NULL`,
        [DOOMED],
      ),
    );
    expect(grants.rows[0]?.n).toBe(1);

    expect(await capabilities(DOOMED_CAREGIVER)).toEqual([]);
  });

  it('answers the owner and a stranger identically, which is the point', async () => {
    // The owner of a deleted profile and somebody who never had access get the same empty list, so
    // the response says nothing about which of the two the caller is.
    expect(await capabilities(OWNER)).toEqual([]);
    expect(await capabilities(STRANGER)).toEqual([]);
  });
});
