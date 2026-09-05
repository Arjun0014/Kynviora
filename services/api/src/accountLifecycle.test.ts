import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';
import type { AuthProvider, IdentityRemoval, ProviderIdentity } from './accountLifecycle.js';

/**
 * The account lifecycle: register, read, remove (DEC-124, DEC-125, `DEV-062`).
 *
 * Spec references: `16` (a person can have their data removed), `14` (re-authentication for
 * high-impact actions; no oracle), `13`, `04` Phase 1.4, DEC-117, DEC-118, DEC-120.
 *
 * WHAT IS REAL HERE AND WHAT IS A STAND-IN
 * The database, the policies, the routes and the audit trail are real - the same engine every
 * other suite uses. The **identity provider** is a stand-in, because the thing being measured is
 * what this API does with each answer a provider can give, and standing up an identity provider
 * to find out would be measuring the provider.
 *
 * What a real provider does is measured separately and against a real project, in
 * `supabaseLive.test.ts`: ES256, the claim shapes, AAL2 from a genuinely enrolled TOTP factor,
 * refresh, and the finding that drives DEC-124 - a signed-out access token keeps verifying
 * locally until it expires.
 *
 * THE SHARP CASES
 * Three, and none of them is the happy path. A deployment that **cannot** remove the identity
 * must change nothing at all rather than perform the half it can. A deletion that got part-way
 * must be finishable by the person it belongs to. And an account that has been removed must stop
 * working on the very next request, without waiting for a token to expire.
 */

const OWNER = testUuid(1);
const OTHER = testUuid(2);
const NEWCOMER = testUuid(3);
const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const OTHER_PROFILE = testUuid(21);
const MEDICINE = testUuid(30);

const NOW = instantFrom('2026-09-05T12:00:00.000Z');
const STEPPED_UP = instantFrom('2026-09-05T11:55:00.000Z');
const STALE_STEP_UP = instantFrom('2026-09-05T11:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;
let currentToken: string | null = 'synthetic-bearer-token';

/** What the stand-in provider will say, and what it was asked. */
const provider = {
  identity: null as ProviderIdentity | null,
  removal: 'REMOVED' as IdentityRemoval,
  canRemove: true,
  signOutOk: true,
  signedOut: [] as string[],
  removed: [] as string[],
};

const stubProvider: AuthProvider = {
  directory: {
    read: (token: string) => Promise.resolve(token === '' ? null : provider.identity),
  },
  admin: {
    get canRemoveIdentity() {
      return provider.canRemove;
    },
    signOutEverywhere: (token: string) => {
      provider.signedOut.push(token);
      return Promise.resolve(provider.signOutOk);
    },
    removeIdentity: (subject: string) => {
      provider.removed.push(subject);
      return Promise.resolve(provider.removal);
    },
  },
};

function principalFor(userId: string, stepUpVerifiedAt: Instant | null = STEPPED_UP): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt };
}

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method,
    url,
    // Content-type only where there is a body: Fastify answers 400 to a JSON content-type with
    // an empty payload, which would make every DELETE here fail before reaching a route.
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(currentToken === null ? {} : { authorization: `Bearer ${currentToken}` }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return {
    status: response.statusCode,
    body: response.body === '' ? {} : (JSON.parse(response.body) as Record<string, unknown>),
  };
}

beforeAll(async () => {
  t = await createTestDb();

  const pool: DatabasePool = {
    withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
    withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
  };
  const sources: ReadonlyMap<string, SourceRegistryEntry> = new Map(
    ALL_FIXTURE_SOURCES.map((s) => [s.id, s]),
  );

  app = createServer({
    surface: 'HOUSEHOLD',
    pool,
    logger: noopLogger(),
    authenticate: (_request: FastifyRequest) => Promise.resolve(currentPrincipal),
    now: (): Instant => NOW,
    loadSources: () => Promise.resolve(sources),
    authProvider: stubProvider,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

beforeEach(async () => {
  provider.identity = {
    email: 'Newcomer@Example.Test',
    emailVerifiedAt: instantFrom('2026-09-01T00:00:00.000Z'),
  };
  provider.removal = 'REMOVED';
  provider.canRemove = true;
  provider.signOutOk = true;
  provider.signedOut = [];
  provider.removed = [];
  currentToken = 'synthetic-bearer-token';
  currentPrincipal = principalFor(OWNER);

  await t.asOwner(async (db) => {
    // `audit_event` is append-only and its trigger refuses a DELETE of a recent row, which is the
    // trigger working. TRUNCATE does not fire row triggers and is the one way to reset it.
    await db.query('TRUNCATE audit_event');
    await db.query('DELETE FROM owned_item');
    await db.query('DELETE FROM profile');
    await db.query('DELETE FROM household');
    await db.query('DELETE FROM app_user');
  });

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
       VALUES ($1, $2, $3, 'Parent (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Second parent (synthetic)')`,
      [OTHER_PROFILE, HOUSEHOLD, OWNER],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, strength_text, dosage_form)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet', '500 mg', 'tablet')`,
      [MEDICINE, PROFILE],
    );
  });
});

// ---------------------------------------------------------------------------

describe('a subject the server does not recognise (DEC-124)', () => {
  it('has no session, on every route', async () => {
    currentPrincipal = principalFor(NEWCOMER);
    for (const url of ['/v1/profiles', '/v1/consents', `/v1/items?profileId=${PROFILE}`]) {
      const response = await call('GET', url);
      expect(response.status, url).toBe(401);
    }
  });

  it('is refused in exactly the words an unauthenticated request gets', async () => {
    currentPrincipal = principalFor(NEWCOMER);
    const unknown = await call('GET', '/v1/profiles');
    currentPrincipal = null;
    const anonymous = await call('GET', '/v1/profiles');
    // `13` does not let this API be an oracle. A caller able to tell "no account" from "no token"
    // learns whether a subject they hold a token for has an account here - and the difference
    // between "deleted" and "never existed" is precisely what a deletion is supposed to remove.
    expect(unknown.status).toBe(anonymous.status);
    // The correlation ID differs per request and is meant to; everything a caller could compare
    // between two requests must not.
    const shape = (r: { body: Record<string, unknown> }) => {
      const { correlationId: _ignored, ...rest } = r.body.error as Record<string, unknown>;
      return rest;
    };
    expect(shape(unknown)).toEqual(shape(anonymous));
  });

  it('cannot reach `GET /v1/me` either', async () => {
    // The read is not exempt. There is nothing to say to somebody with no account that `POST`
    // does not say better, and a `GET` answering "you have no account" is the oracle again.
    currentPrincipal = principalFor(NEWCOMER);
    expect((await call('GET', '/v1/me')).status).toBe(401);
  });
});

describe('registering', () => {
  it('turns a verified subject into an account', async () => {
    currentPrincipal = principalFor(NEWCOMER);
    const created = await call('POST', '/v1/me', {});
    expect(created.status).toBe(201);
    const account = created.body.account as Record<string, unknown>;
    expect(account.userId).toBe(NEWCOMER);
    // Normalised on the way in. The provider said `Newcomer@Example.Test`; an invitation bound to
    // an address has to match one typed in any case.
    expect(account.email).toBe('newcomer@example.test');
    expect(account.emailVerified).toBe(true);
  });

  it('lets the new account reach the rest of the API immediately', async () => {
    currentPrincipal = principalFor(NEWCOMER);
    expect((await call('GET', '/v1/profiles')).status).toBe(401);
    await call('POST', '/v1/me', {});
    const after = await call('GET', '/v1/profiles');
    expect(after.status).toBe(200);
    // A new account with nothing in it, not somebody else's household.
    expect(after.body.profiles).toEqual([]);
  });

  it('is idempotent, because the subject is the identity', async () => {
    currentPrincipal = principalFor(NEWCOMER);
    const first = await call('POST', '/v1/me', {});
    const second = await call('POST', '/v1/me', {});
    expect(first.status).toBe(201);
    // 200 rather than 201, and the same row. No idempotency key: there is nothing a caller could
    // vary between two calls, so there is nothing for a key to scope.
    expect(second.status).toBe(200);
    expect((second.body.account as { userId: string }).userId).toBe(NEWCOMER);
  });

  it('refuses an address the provider has not confirmed', async () => {
    // DEC-118 chose verified email and password. An unverified address is somebody who has not
    // finished signing up, and this is the check that makes "verified" mean something - the
    // access token carries no such claim, which is why the provider is asked.
    provider.identity = { email: 'unconfirmed@example.test', emailVerifiedAt: null };
    currentPrincipal = principalFor(NEWCOMER);
    const refused = await call('POST', '/v1/me', {});
    expect(refused.status).toBe(403);
    expect((refused.body.error as { code: string }).code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('takes no fields, and says so', async () => {
    // A body with an email in it would be a caller describing themselves, which is the whole
    // thing `13` forbids. `.strict()` makes it a refusal rather than a field silently ignored.
    currentPrincipal = principalFor(NEWCOMER);
    const refused = await call('POST', '/v1/me', { email: 'someone-else@example.test' });
    expect(refused.status).toBe(400);
  });

  it('refuses when the provider cannot be reached, rather than guessing', async () => {
    provider.identity = null;
    currentPrincipal = principalFor(NEWCOMER);
    const refused = await call('POST', '/v1/me', {});
    expect((refused.body.error as { code: string }).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('will not revive a closed account', async () => {
    currentPrincipal = principalFor(NEWCOMER);
    await call('POST', '/v1/me', {});
    await call('DELETE', '/v1/me');

    const again = await call('POST', '/v1/me', {});
    // The row is retained on an approved basis until the purge takes it (DEC-117), and reviving
    // it would resurrect everything that hung off it. A person who wants to come back gets a new
    // account, which is what the deletion promised them.
    expect(again.status).toBe(409);
    expect((again.body.error as { code: string }).code).toBe('ACCOUNT_CLOSED');
  });
});

describe('reading the account', () => {
  it('says who the caller is, and nothing about anybody else', async () => {
    const mine = await call('GET', '/v1/me');
    expect(mine.status).toBe(200);
    expect((mine.body.account as { userId: string }).userId).toBe(OWNER);
    expect((mine.body.account as { email: string }).email).toBe('owner@example.test');

    currentPrincipal = principalFor(OTHER);
    const theirs = await call('GET', '/v1/me');
    expect((theirs.body.account as { userId: string }).userId).toBe(OTHER);
  });
});

describe('deleting the account (DEV-062)', () => {
  it('needs a fresh step-up', async () => {
    // `14` names account deletion among the actions that require re-authentication, and this is
    // the most one-way of them.
    currentPrincipal = principalFor(OWNER, STALE_STEP_UP);
    const refused = await call('DELETE', '/v1/me');
    expect(refused.status).toBe(403);
    expect((refused.body.error as { code: string }).code).toBe('STEP_UP_REQUIRED');
    expect(provider.removed).toEqual([]);
  });

  it('changes nothing at all when the identity cannot be removed', async () => {
    // The half-measure DEC-120 refused, made impossible rather than merely discouraged: the
    // capability is checked **before** anything is written. A deployment with no service-role
    // credential does not stamp the data and then discover it cannot finish.
    provider.canRemove = false;
    const refused = await call('DELETE', '/v1/me');
    expect(refused.status).toBe(503);
    expect((refused.body.error as { code: string }).code).toBe('PROVIDER_UNAVAILABLE');

    const still = await call('GET', '/v1/profiles');
    expect(still.status).toBe(200);
    expect((still.body.profiles as unknown[]).length).toBe(2);
    expect(provider.signedOut).toEqual([]);
    expect(provider.removed).toEqual([]);
  });

  it('removes the account, its profiles and its items, and signs every session out', async () => {
    const before = await call('GET', `/v1/items?profileId=${PROFILE}`);
    expect((before.body.items as unknown[]).length).toBe(1);

    const gone = await call('DELETE', '/v1/me');
    expect(gone.status).toBe(204);

    // Every session, everywhere, at the provider - and the identity itself.
    expect(provider.signedOut).toEqual(['synthetic-bearer-token']);
    expect(provider.removed).toEqual([OWNER]);

    // Stamped, not yet purged: `docs/RETENTION.md` gives the bytes thirty days and revocation is
    // synchronous, so what has to be true now is that nothing can reach them.
    const rows = await t.asOwner((db) =>
      db.query<{ profiles: string; items: string; account: string }>(
        `SELECT (SELECT count(*)::text FROM profile WHERE owner_user_id = $1 AND deleted_at IS NULL)
                  AS profiles,
                (SELECT count(*)::text FROM owned_item WHERE deleted_at IS NULL) AS items,
                (SELECT count(*)::text FROM app_user WHERE id = $1 AND deleted_at IS NULL)
                  AS account`,
        [OWNER],
      ),
    );
    expect(rows.rows[0]).toEqual({ profiles: '0', items: '0', account: '0' });
  });

  it('ends the caller’s access on the very next request', async () => {
    // The reason DEC-124 exists. A Supabase access token is verified locally against a published
    // key set, so nothing here can know its session was signed out - it keeps verifying until
    // `exp`, up to an hour later. This is what makes "immediately" true anyway.
    await call('DELETE', '/v1/me');
    expect((await call('GET', '/v1/profiles')).status).toBe(401);
    expect((await call('GET', '/v1/me')).status).toBe(401);
    expect((await call('GET', `/v1/items?profileId=${PROFILE}`)).status).toBe(401);
  });

  it('records that it happened, in counts and nothing else', async () => {
    await call('DELETE', '/v1/me');
    const audit = await t.asOwner((db) =>
      db.query<{ action: string; detail: Record<string, unknown> }>(
        `SELECT action, detail FROM audit_event ORDER BY occurred_at, action`,
      ),
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('account.deleted');
    expect(actions).toContain('account.identity_removed');

    const deleted = audit.rows.find((r) => r.action === 'account.deleted');
    // `20` forbids the audit log becoming a copy of health content, and `16` retains the record
    // **that** a deletion happened for 24 months - so it must not become a description of what
    // was deleted. A count of profiles is what an investigation needs; a medicine name is not.
    expect(deleted?.detail).toEqual({ profile_count: 2 });
    expect(JSON.stringify(audit.rows)).not.toContain('Synthetic Tablet');
    expect(JSON.stringify(audit.rows)).not.toContain('owner@example.test');
  });

  it('is idempotent and finishes a deletion that got part-way', async () => {
    // The recoverable partial failure: the data is stamped, the sessions are gone, and the
    // identity removal did not complete. The person keeps a token that still verifies, so they
    // can ask again - which is the whole reason this route is exempt from the account check.
    provider.removal = 'FAILED';
    const partial = await call('DELETE', '/v1/me');
    expect(partial.status).toBe(503);

    const pending = await t.asOwner((db) =>
      db.query<{ action: string }>(
        `SELECT action FROM audit_event WHERE action = 'account.identity_removal_pending'`,
      ),
    );
    expect(pending.rows).toHaveLength(1);

    // Everything local is already done, and the retry must not fail on it.
    provider.removal = 'ALREADY_ABSENT';
    const finished = await call('DELETE', '/v1/me');
    expect(finished.status).toBe(204);

    const closed = await t.asOwner((db) =>
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_event WHERE action = 'account.deleted'`,
      ),
    );
    // One deletion, not two. The stamp is conditional on `deleted_at IS NULL`, so the second call
    // stamps nothing and writes no second record of an event that happened once.
    expect(closed.rows[0]?.n).toBe('1');
  });

  it('does not remove anybody else', async () => {
    await call('DELETE', '/v1/me');
    currentPrincipal = principalFor(OTHER);
    expect((await call('GET', '/v1/me')).status).toBe(200);
    expect(provider.removed).toEqual([OWNER]);
  });
});

describe('a deployment with no identity provider', () => {
  it('refuses to register or delete rather than inventing an address', async () => {
    // The development authenticator has no provider to ask. An `app_user` row provisioned without
    // one would carry an email nobody confirmed, which is exactly what DEC-118 asked registration
    // to refuse - so the route says what is missing instead. The seed makes development accounts.
    const noProvider = createServer({
      surface: 'HOUSEHOLD',
      pool: {
        withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
        withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
      },
      logger: noopLogger(),
      authenticate: () => Promise.resolve(principalFor(NEWCOMER)),
      now: (): Instant => NOW,
      loadSources: () => Promise.resolve(new Map<string, SourceRegistryEntry>()),
      authProvider: null,
    });
    await noProvider.ready();
    try {
      const registered = await noProvider.inject({
        method: 'POST',
        url: '/v1/me',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(registered.statusCode).toBe(503);
      const deleted = await noProvider.inject({ method: 'DELETE', url: '/v1/me' });
      expect(deleted.statusCode).toBe(503);
    } finally {
      await noProvider.close();
    }
  });
});
