import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  AGE_BANDS,
  DEFAULT_LANGUAGE_TAG,
  instantFrom,
  noopLogger,
  unsafeId,
  type Instant,
  type UserId,
} from '@kynviora/domain';

/**
 * `04` Phase 1.2, against a real engine.
 *
 * `POST /v1/households` and `POST /v1/profiles` are the first way anything in this build makes a
 * person exist from a user surface. What is asserted here is what the database decides rather than
 * what the handler intends: that a household ID belonging to somebody else is refused by
 * `profile_insert` and answered as absence, that `self_user_id` can only ever be the caller, and
 * that a retried create makes one row.
 */

const OWNER = testUuid(1);
const OTHER = testUuid(2);
const STRANGER = testUuid(3);

const OTHER_HOUSEHOLD = testUuid(10);

const NOW = instantFrom('2026-09-02T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;

function principalFor(userId: string): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt: null };
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER, 'other@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
    // A household belonging to somebody else, which exists for the whole run: the interesting
    // refusal is "you may not put a profile in that", not "there is no such household".
    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'Not yours')`,
      [OTHER_HOUSEHOLD, OTHER],
    );
  });

  const pool: DatabasePool = {
    withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
    withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
  };

  app = createServer({
    surface: 'HOUSEHOLD',
    pool,
    logger: noopLogger(),
    authenticate: (_request: FastifyRequest) => Promise.resolve(currentPrincipal),
    now: (): Instant => NOW,
    // No source registry: nothing on these two routes reads one, and an empty map is the honest
    // fixture. A route that started needing sources would fail here rather than pass on fixtures
    // this suite never chose.
    loadSources: () => Promise.resolve(new Map()),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

beforeEach(async () => {
  // The database owner, because neither application role holds DELETE on these tables - the same
  // reason the manual-entry fixture cleans up as the owner (trap 105).
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM profile');
    await db.query(`DELETE FROM household WHERE id <> $1`, [OTHER_HOUSEHOLD]);
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

/** A key nobody has used before. Every create that is not testing a replay gets its own. */
function key(): Record<string, string> {
  return { 'idempotency-key': randomUUID() };
}

interface HouseholdBody {
  readonly id: string;
  readonly displayName: string;
  readonly replayed: boolean;
}

interface ProfileBody {
  readonly id: string;
  readonly householdId: string;
  readonly displayName: string;
  readonly ageBand: string | null;
  readonly birthYear: number | null;
  readonly isSelf: boolean;
  readonly isManaged: boolean;
  readonly replayed: boolean;
}

interface WireBody {
  readonly error: { readonly code: string; readonly detail?: Record<string, unknown> };
}

async function makeHousehold(as: Principal, name = 'The Nair household') {
  return request(as, {
    method: 'POST',
    url: '/v1/households',
    headers: key(),
    payload: { displayName: name },
  });
}

describe('creating a household', () => {
  it('creates one owned by the caller', async () => {
    const response = await makeHousehold(principalFor(OWNER));
    expect(response.statusCode).toBe(201);

    const body = response.json<HouseholdBody>();
    expect(body.displayName).toBe('The Nair household');
    expect(body.replayed).toBe(false);

    const stored = await t.asService((db) =>
      db.query<{ owner_user_id: string }>(`SELECT owner_user_id FROM household WHERE id = $1`, [
        body.id,
      ]),
    );
    // Decided by the request context and checked by `household_insert`, never read from a body.
    expect(stored.rows[0]?.owner_user_id).toBe(OWNER);
  });

  it('refuses a body naming an owner', async () => {
    // `.strict()`. A body that could name an owner would be an authorization statement arriving
    // from the client, which is `13`'s rule about profile IDs applied to the row that holds them.
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/households',
      headers: key(),
      payload: { displayName: 'Mine', ownerUserId: OTHER },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<WireBody>().error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a blank name, and names the field', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/households',
      headers: key(),
      payload: { displayName: '   ' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<WireBody>().error.detail?.['field']).toBe('displayName');
  });

  it('requires an idempotency key', async () => {
    // Required rather than optional, for the reason the item route requires it: two households
    // are not a duplicate row. Every later record hangs off one, so the copies collect separate
    // items and caregivers and nothing in this build merges them.
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/households',
      payload: { displayName: 'Mine' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<WireBody>().error.detail?.['reason_code']).toBe(
      'idempotency_key_required',
    );
  });

  it('makes one household when the same create arrives twice', async () => {
    const headers = key();
    const first = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/households',
      headers,
      payload: { displayName: 'Mine' },
    });
    const second = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/households',
      headers,
      payload: { displayName: 'Mine' },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json<HouseholdBody>().id).toBe(first.json<HouseholdBody>().id);
    expect(second.json<HouseholdBody>().replayed).toBe(true);

    const count = await t.asService((db) =>
      db.query<{ n: string }>(`SELECT count(*) AS n FROM household WHERE owner_user_id = $1`, [
        OWNER,
      ]),
    );
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('answers a replay with the row that exists, not with the body that was re-sent', async () => {
    // A retry carrying a changed name would otherwise be told what the second body implies, when
    // what exists is the first one.
    const headers = key();
    await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/households',
      headers,
      payload: { displayName: 'First name' },
    });
    const replay = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/households',
      headers,
      payload: { displayName: 'Second name' },
    });

    expect(replay.json<HouseholdBody>().displayName).toBe('First name');
  });

  it('does not let one user’s key refuse another user’s create', async () => {
    // DEC-079's failure, in the scope it applies to here. Under a globally unique key the second
    // create conflicts, the replay read finds nothing under RLS, and the caller is answered with
    // a success carrying no household.
    const headers = key();
    const mine = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/households',
      headers,
      payload: { displayName: 'Mine' },
    });
    const theirs = await request(principalFor(STRANGER), {
      method: 'POST',
      url: '/v1/households',
      headers,
      payload: { displayName: 'Theirs' },
    });

    expect(mine.statusCode).toBe(201);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json<HouseholdBody>().id).not.toBe(mine.json<HouseholdBody>().id);
  });

  it('tells an unauthenticated caller nothing', async () => {
    const response = await request(null, {
      method: 'POST',
      url: '/v1/households',
      headers: key(),
      payload: { displayName: 'Mine' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('creating a profile', () => {
  let household = '';

  beforeEach(async () => {
    household = (await makeHousehold(principalFor(OWNER))).json<HouseholdBody>().id;
  });

  async function makeProfile(as: Principal, payload: Record<string, unknown>) {
    return request(as, {
      method: 'POST',
      url: '/v1/profiles',
      headers: key(),
      payload: { householdId: household, ...payload },
    });
  }

  it('creates one from a name alone', async () => {
    const response = await makeProfile(principalFor(OWNER), { displayName: 'Amma' });
    expect(response.statusCode).toBe(201);

    const body = response.json<ProfileBody>();
    expect(body.displayName).toBe('Amma');
    expect(body.ageBand).toBeNull();
    expect(body.birthYear).toBeNull();
    // Somebody else's profile unless the caller said otherwise (`14`).
    expect(body.isSelf).toBe(false);
    expect(body.isManaged).toBe(true);
  });

  it('records the band and the year where they were given', async () => {
    const response = await makeProfile(principalFor(OWNER), {
      displayName: 'Amma',
      ageBand: 'OLDER_ADULT_65_PLUS',
      birthYear: '1958',
    });
    expect(response.statusCode).toBe(201);

    const stored = await t.asService((db) =>
      db.query<{ age_band: string | null; birth_year: number | null }>(
        `SELECT age_band, birth_year FROM profile WHERE id = $1`,
        [response.json<ProfileBody>().id],
      ),
    );
    expect(stored.rows[0]?.age_band).toBe('OLDER_ADULT_65_PLUS');
    expect(Number(stored.rows[0]?.birth_year)).toBe(1958);
  });

  it('accepts every band the domain offers, so no form field is unsubmittable', async () => {
    // The agreement the domain test asserts against a transcribed list, asserted here against the
    // constraint itself. A band the form offers and the database refuses is a 500 in front of
    // somebody setting up their family.
    for (const band of AGE_BANDS) {
      const response = await makeProfile(principalFor(OWNER), {
        displayName: `Person ${band}`,
        ageBand: band,
      });
      expect(response.statusCode, band).toBe(201);
    }
  });

  it('stores the language somebody chose, and the shared default otherwise', async () => {
    const chosen = await makeProfile(principalFor(OWNER), {
      displayName: 'Amma',
      languageTag: 'ml-IN',
    });
    const defaulted = await makeProfile(principalFor(OWNER), { displayName: 'Achan' });

    const rows = await t.asService((db) =>
      db.query<{ id: string; language_tag: string }>(
        `SELECT id, language_tag FROM profile WHERE id = ANY($1::uuid[])`,
        [[chosen.json<ProfileBody>().id, defaulted.json<ProfileBody>().id]],
      ),
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.language_tag]));
    expect(byId.get(chosen.json<ProfileBody>().id)).toBe('ml-IN');
    expect(byId.get(defaulted.json<ProfileBody>().id)).toBe(DEFAULT_LANGUAGE_TAG);
  });

  it('agrees with the column default the database would have applied', async () => {
    // The domain holds the default so the app and the database cannot render different languages
    // for one profile. Read out of the catalog rather than transcribed.
    const column = await t.asService((db) =>
      db.query<{ column_default: string | null }>(
        `SELECT column_default FROM information_schema.columns
          WHERE table_name = 'profile' AND column_name = 'language_tag'`,
      ),
    );
    expect(column.rows[0]?.column_default).toContain(DEFAULT_LANGUAGE_TAG);
  });
});

describe('who a profile can say it is for', () => {
  let household = '';

  beforeEach(async () => {
    household = (await makeHousehold(principalFor(OWNER))).json<HouseholdBody>().id;
  });

  it('sets the subject to the caller when they claim it', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers: key(),
      payload: { householdId: household, displayName: 'Me', isSelf: true },
    });
    expect(response.statusCode).toBe(201);

    const body = response.json<ProfileBody>();
    expect(body.isSelf).toBe(true);
    // The two columns say different things and are set from the same answer.
    expect(body.isManaged).toBe(false);

    const stored = await t.asService((db) =>
      db.query<{ self_user_id: string | null; is_managed: boolean }>(
        `SELECT self_user_id, is_managed FROM profile WHERE id = $1`,
        [body.id],
      ),
    );
    expect(stored.rows[0]?.self_user_id).toBe(OWNER);
    expect(stored.rows[0]?.is_managed).toBe(false);
  });

  it('refuses a second self-profile with a code a screen can act on', async () => {
    // `DEV-068`. `profile_self_user_unique` is right and the refusal was missing: the violation
    // reached the error handler as `INTERNAL`, so a 500 with no reason in it was what somebody
    // got for pressing a button twice.
    const first = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers: key(),
      payload: { householdId: household, displayName: 'Me', isSelf: true },
    });
    expect(first.statusCode).toBe(201);

    // A different idempotency key, so this is a second request rather than a replay - a replay is
    // answered by the stored row and never reaches the constraint at all.
    const second = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers: key(),
      payload: { householdId: household, displayName: 'Me again', isSelf: true },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<WireBody>().error.code).toBe('ALREADY_EXISTS');

    // And exactly one row, which is what the constraint was for.
    const stored = await t.asService((db) =>
      db.query<{ n: string }>(`SELECT count(*) AS n FROM profile WHERE self_user_id = $1`, [OWNER]),
    );
    expect(Number(stored.rows[0]?.n)).toBe(1);
  });

  it('names neither the rule that refused nor the row that already existed', async () => {
    // A unique index is enforced over every row in the table, including rows row-level security
    // hides from this caller, so the refusal must say nothing about what is already there. The
    // driver hands us both - `constraint` and a `detail` reading `Key (...)=(...) already exists`
    // - and neither may reach the wire (`19`, no enumeration oracle).
    await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers: key(),
      payload: { householdId: household, displayName: 'Me', isSelf: true },
    });
    const second = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers: key(),
      payload: { householdId: household, displayName: 'Me again', isSelf: true },
    });

    const raw = second.body;
    expect(raw).not.toContain('profile_self_user_unique');
    expect(raw).not.toContain('self_user_id');
    // The driver's own `detail` reads `Key (self_user_id)=(<uuid>) already exists.` and is the
    // one field that carries the value somebody submitted.
    expect(raw).not.toContain('Key (');
    expect(raw).not.toContain(OWNER);
    // No `detail` at all: there is no field a form could point at, and the only thing this
    // refusal could name is the row it must not describe.
    expect(second.json<WireBody>().error.detail).toBeUndefined();
    // And not retryable - retrying this one never succeeds, which is the whole reason it does not
    // share `VERSION_CONFLICT`'s code.
    expect(second.json<{ error: { retryable: boolean } }>().error.retryable).toBe(false);
  });

  it('has no way to name anybody else as the subject', async () => {
    // `.strict()` refuses the field, and there is no parameter it could reach if it did not. A
    // profile asserting that another user is its subject would be an authorization statement
    // written by the wrong person - and `self_user_id` is unique, so it would also take a name
    // that user can never claim.
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers: key(),
      payload: { householdId: household, displayName: 'Not me', selfUserId: OTHER },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<WireBody>().error.code).toBe('VALIDATION_FAILED');

    const none = await t.asService((db) =>
      db.query<{ n: string }>(`SELECT count(*) AS n FROM profile WHERE self_user_id = $1`, [OTHER]),
    );
    expect(Number(none.rows[0]?.n)).toBe(0);
  });

  it('leaves a managed profile claimable, with no subject at all', async () => {
    // A relative's profile has an owner and no `self_user_id` until they claim it. Null rather
    // than the owner, because "this is my mother's profile" and "this is mine" are different
    // facts and the second must not be produced by the first.
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers: key(),
      payload: { householdId: household, displayName: 'Amma' },
    });

    const stored = await t.asService((db) =>
      db.query<{ self_user_id: string | null; owner_user_id: string }>(
        `SELECT self_user_id, owner_user_id FROM profile WHERE id = $1`,
        [response.json<ProfileBody>().id],
      ),
    );
    expect(stored.rows[0]?.self_user_id).toBeNull();
    expect(stored.rows[0]?.owner_user_id).toBe(OWNER);
  });
});

describe('whose household a profile may go in', () => {
  it('refuses a household the caller does not own, as absence', async () => {
    // `profile_insert` decides this, not the handler. A household this caller may not write to
    // and one that does not exist are the same answer, so the route is not an oracle for either.
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers: key(),
      payload: { householdId: OTHER_HOUSEHOLD, displayName: 'Sneaky' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<WireBody>().error.code).toBe('NOT_FOUND');

    const none = await t.asService((db) =>
      db.query<{ n: string }>(`SELECT count(*) AS n FROM profile WHERE household_id = $1`, [
        OTHER_HOUSEHOLD,
      ]),
    );
    expect(Number(none.rows[0]?.n)).toBe(0);
  });

  it('answers a household that does not exist the same way', async () => {
    const missing = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers: key(),
      payload: { householdId: testUuid(99), displayName: 'Sneaky' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<WireBody>().error.code).toBe('NOT_FOUND');
  });
});

describe('a retried profile create', () => {
  it('makes one profile, and answers the second with the first', async () => {
    const household = (await makeHousehold(principalFor(OWNER))).json<HouseholdBody>().id;
    const headers = key();

    const first = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers,
      payload: { householdId: household, displayName: 'Amma' },
    });
    const second = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers,
      payload: { householdId: household, displayName: 'Amma' },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json<ProfileBody>().id).toBe(first.json<ProfileBody>().id);

    const count = await t.asService((db) =>
      db.query<{ n: string }>(`SELECT count(*) AS n FROM profile WHERE household_id = $1`, [
        household,
      ]),
    );
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('is scoped to the household, so another one is unaffected', async () => {
    // Two households owned by the same person. The same key in each is two creates, not one.
    const a = (await makeHousehold(principalFor(OWNER), 'A')).json<HouseholdBody>().id;
    const b = (await makeHousehold(principalFor(OWNER), 'B')).json<HouseholdBody>().id;
    const headers = key();

    const inA = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers,
      payload: { householdId: a, displayName: 'Amma' },
    });
    const inB = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers,
      payload: { householdId: b, displayName: 'Achan' },
    });

    expect(inA.statusCode).toBe(201);
    expect(inB.statusCode).toBe(201);
    expect(inB.json<ProfileBody>().id).not.toBe(inA.json<ProfileBody>().id);
  });
});

describe('what a new profile is visible to', () => {
  it('appears in the creator’s own listing and in nobody else’s', async () => {
    // Phase 1.2's second exit criterion, at the boundary that enforces it: `GET /v1/profiles`
    // accepts no profile ID, so the selectable set is the authorised set by construction.
    const household = (await makeHousehold(principalFor(OWNER))).json<HouseholdBody>().id;
    const created = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/profiles',
      headers: key(),
      payload: { householdId: household, displayName: 'Amma' },
    });

    const mine = await request(principalFor(OWNER), { method: 'GET', url: '/v1/profiles' });
    const theirs = await request(principalFor(STRANGER), { method: 'GET', url: '/v1/profiles' });

    interface ListBody {
      readonly profiles: readonly { readonly id: string; readonly isOwner: boolean }[];
    }
    const listed = mine.json<ListBody>().profiles;
    expect(listed.map((profile) => profile.id)).toContain(created.json<ProfileBody>().id);
    expect(listed.every((profile) => profile.isOwner)).toBe(true);
    expect(theirs.json<ListBody>().profiles).toEqual([]);
  });
});
