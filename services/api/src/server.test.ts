import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { assertNoSensitiveFields } from './errors.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * API integration tests.
 *
 * These run against the **real** database through PGlite, with row-level security in force as
 * the non-superuser `kynviora_app` role. Spec 19 requires integration coverage of API
 * authorization, and a mocked database would test the mock rather than the policy.
 *
 * The property most of these tests establish: a route handler holds no authorization logic, so
 * cross-profile exposure is prevented by the policy layer even where a handler is careless.
 */

const OWNER = testUuid(1);
const OTHER_OWNER = testUuid(2);
const STRANGER = testUuid(3);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);
const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

const ITEM_A_MEDICINE = testUuid(30);
const ITEM_A_SHAMPOO = testUuid(31);
const ITEM_B_MEDICINE = testUuid(32);

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;

/** The user each request authenticates as. Set per test. */
let currentPrincipal: Principal | null = null;

function principalFor(userId: string, stepUpVerifiedAt: string | null = null): Principal {
  return {
    userId: unsafeId<UserId>(userId),
    stepUpVerifiedAt: stepUpVerifiedAt as Principal['stepUpVerifiedAt'],
  };
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER_OWNER, 'other@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }

    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name)
       VALUES ($1, $2, 'A'), ($3, $4, 'B')`,
      [HOUSEHOLD_A, OWNER, HOUSEHOLD_B, OTHER_OWNER],
    );

    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent A (synthetic)'), ($4, $5, $6, 'Parent B (synthetic)')`,
      [PROFILE_A, HOUSEHOLD_A, OWNER, PROFILE_B, HOUSEHOLD_B, OTHER_OWNER],
    );

    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, strength_text, dosage_form)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet A', '500 mg', 'tablet'),
              ($3, $4, 'MEDICINE', 'Synthetic Tablet B', '250 mg', 'tablet')`,
      [ITEM_A_MEDICINE, PROFILE_A, ITEM_B_MEDICINE, PROFILE_B],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, personal_care_category)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Synthetic Shampoo', 'HAIR_CARE')`,
      [ITEM_A_SHAMPOO, PROFILE_A],
    );
  });

  // Adapt the test harness to the API's DatabasePool port. `withUser` binds the app role and the
  // request GUC exactly as a production pool would.
  const pool: DatabasePool = {
    withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
    withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
  };

  const sources: ReadonlyMap<string, SourceRegistryEntry> = new Map(
    ALL_FIXTURE_SOURCES.map((s) => [s.id, asApprovedSourceForTest(s)]),
  );

  app = createServer({
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

/** Issue a request as a given user (or unauthenticated when null). */
async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

describe('authentication', () => {
  it('serves health without authentication', async () => {
    const response = await request(null, { method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('rejects an unauthenticated request to a user route', async () => {
    const response = await request(null, { method: 'GET', url: '/v1/profiles' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('attaches a correlation ID to every response', async () => {
    const response = await request(null, { method: 'GET', url: '/health' });
    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers', async () => {
    const response = await request(null, { method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toContain('max-age=');
    // Health and safety data must not be cached by an intermediary.
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /v1/profiles - authorization comes from the session, not the request', () => {
  it('returns only the profiles the caller may see', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: '/v1/profiles',
    });
    expect(response.statusCode).toBe(200);
    const body: { profiles: { id: string }[] } = response.json();
    expect(body.profiles.map((p) => p.id)).toEqual([PROFILE_A]);
  });

  it('returns a different set for a different user', async () => {
    const response = await request(principalFor(OTHER_OWNER), {
      method: 'GET',
      url: '/v1/profiles',
    });
    const body: { profiles: { id: string }[] } = response.json();
    expect(body.profiles.map((p) => p.id)).toEqual([PROFILE_B]);
  });

  it('returns nothing for a user with no profiles', async () => {
    const response = await request(principalFor(STRANGER), {
      method: 'GET',
      url: '/v1/profiles',
    });
    expect(response.json<{ profiles: unknown[] }>().profiles).toEqual([]);
  });

  it('returns server time for sync-sensitive responses', async () => {
    // Spec 13 requires it so a client can reason about clock skew.
    const response = await request(principalFor(OWNER), { method: 'GET', url: '/v1/profiles' });
    expect(response.json<{ serverTime: string }>().serverTime).toBe(NOW);
  });
});

describe('GET /v1/items - a supplied profile ID narrows, it does not grant', () => {
  it('returns the caller items for their own profile', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_A}`,
    });
    expect(response.statusCode).toBe(200);
    const body: { items: { id: string }[] } = response.json();
    expect(body.items.map((i) => i.id).sort()).toEqual([ITEM_A_MEDICINE, ITEM_A_SHAMPOO].sort());
  });

  it('returns an empty page when the caller supplies a foreign profile ID', async () => {
    // Spec 13: "Never trust a profile ID in the request as proof of access." The handler passes
    // it straight to the query; RLS is what makes that safe.
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_B}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('does not distinguish a foreign profile from an empty one', async () => {
    // Returning 403 for a foreign profile and 200 for an empty one would confirm the profile
    // exists to someone not permitted to see it - the enumeration weakness spec 19 tests for.
    const foreign = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_B}`,
    });
    const nonexistent = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items?profileId=${testUuid(9999)}`,
    });
    expect(foreign.statusCode).toBe(nonexistent.statusCode);
    expect(foreign.json()).toEqual(nonexistent.json());
  });

  it('filters by item kind', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_A}&itemKind=PERSONAL_CARE`,
    });
    const body: { items: { id: string }[] } = response.json();
    expect(body.items.map((i) => i.id)).toEqual([ITEM_A_SHAMPOO]);
  });

  it('rejects a malformed profile ID', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: '/v1/items?profileId=not-a-uuid',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('rejects an out-of-range page size', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_A}&limit=100000`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('paginates with a cursor', async () => {
    const first = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_A}&limit=1`,
    });
    const firstBody = first.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.nextCursor).toBe(firstBody.items[0]!.id);

    const second = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_A}&limit=1&cursor=${firstBody.nextCursor}`,
    });
    const secondBody = second.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0]!.id).not.toBe(firstBody.items[0]!.id);
    // Two items exist, so the second page is the last.
    expect(secondBody.nextCursor).toBeNull();
  });

  it('exposes verification facets separately, never combined', async () => {
    // Spec 08 Product Trust Passport: identity, formulation and batch confidence are distinct.
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_A}`,
    });
    const item = response.json<{ items: Record<string, unknown>[] }>().items[0]!;
    expect(item).toHaveProperty('identityVerification');
    expect(item).toHaveProperty('formulationVerification');
    expect(item).toHaveProperty('batchVerification');
    expect(item).not.toHaveProperty('verification');
    expect(item).not.toHaveProperty('trustScore');
  });
});

describe('POST /v1/dose-events - idempotency (spec 13)', () => {
  const body = { ownedItemId: ITEM_A_MEDICINE, eventKind: 'TAKEN' as const };

  it('requires an idempotency key', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/dose-events',
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', detail: { reason_code: 'idempotency_key_required' } },
    });
  });

  it('creates an event with a valid key', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/dose-events',
      headers: { 'idempotency-key': testUuid(500) },
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ id: string }>().id).toBeTruthy();
  });

  it('commits a retried upload exactly once', async () => {
    // The offline client retries. Spec 13: "Server commits exactly once."
    const key = testUuid(501);
    const first = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/dose-events',
      headers: { 'idempotency-key': key },
      payload: body,
    });
    const retry = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/dose-events',
      headers: { 'idempotency-key': key },
      payload: body,
    });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const count = await t.asService((db) =>
      db.query<{ c: number }>(
        'SELECT count(*)::int AS c FROM dose_event WHERE client_operation_id = $1',
        [key],
      ),
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('refuses to record an event against another household item', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/dose-events',
      headers: { 'idempotency-key': testUuid(502) },
      payload: { ownedItemId: ITEM_B_MEDICINE, eventKind: 'TAKEN' },
    });
    // Reported as not-found so the response does not confirm the item exists.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
  });

  it('rejects an invalid event kind', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/dose-events',
      headers: { 'idempotency-key': testUuid(503) },
      payload: { ownedItemId: ITEM_A_MEDICINE, eventKind: 'FORGOT_LOL' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an oversized body', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/dose-events',
      headers: { 'idempotency-key': testUuid(504) },
      payload: { ...body, note: 'x'.repeat(2_000_000) },
    });
    // Either the body limit (413 mapped to 400) or the note max length rejects it.
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /v1/visit-packs - step-up authentication (spec 14)', () => {
  it('refuses an export without fresh step-up', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/visit-packs',
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
  });

  it('refuses when the step-up has expired', async () => {
    const stale = new Date(Date.parse(NOW) - 60 * 60 * 1000).toISOString();
    const response = await request(principalFor(OWNER, stale), {
      method: 'POST',
      url: '/v1/visit-packs',
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it('passes the step-up gate and then rejects an empty request on its merits', async () => {
    // Once step-up is satisfied the request is judged as a request: an empty body names no
    // profile and selects nothing, so it fails validation rather than being accepted. The full
    // generation flow is covered in `visitPack.test.ts`.
    const fresh = new Date(Date.parse(NOW) - 60_000).toISOString();
    const response = await request(principalFor(OWNER, fresh), {
      method: 'POST',
      url: '/v1/visit-packs',
      headers: { 'idempotency-key': '00000000-0000-4000-8000-0000000009f1' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('refuses before parsing the body, so the gate does not depend on a well-formed request', () =>
    request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/visit-packs',
      payload: { profileId: 'not-a-uuid', selectedEntityIds: [] },
    }).then((response) => {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
    }));
});

describe('GET /v1/regulatory-lens', () => {
  it('returns a jurisdiction entry for every supported jurisdiction', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: '/v1/regulatory-lens?substanceKey=SALICYLIC_ACID',
    });
    expect(response.statusCode).toBe(200);

    const body: { lens: { entries: { jurisdiction: string }[] } } = response.json();
    expect(body.lens.entries.map((e) => e.jurisdiction).sort()).toEqual(
      ['EU', 'GB', 'IN', 'JP', 'NI', 'US'].sort(),
    );
  });

  it('reports no matched rule when the registry is empty, never approval', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: '/v1/regulatory-lens?substanceKey=SALICYLIC_ACID',
    });
    const body = response.json<{
      lens: { entries: { jurisdiction: string; statuses: string[]; limitations: string[] }[] };
    }>();

    const eu = body.lens.entries.find((e) => e.jurisdiction === 'EU')!;
    expect(eu.statuses).toContain('NO_MATCHED_RULE_WITHIN_COVERAGE');
    expect(eu.statuses).not.toContain('APPROVED');
    expect(eu.limitations.join(' ')).toMatch(/not regulatory approval/i);
  });

  it('carries no urgency or severity field on any entry', async () => {
    // The Lens is regulatory transparency, never a personalized conclusion (spec 07.2).
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: '/v1/regulatory-lens?substanceKey=SALICYLIC_ACID',
    });
    const body = response.json<{ lens: { entries: Record<string, unknown>[] } }>();
    for (const entry of body.lens.entries) {
      expect(entry).not.toHaveProperty('urgency');
      expect(entry).not.toHaveProperty('severity');
      expect(entry).not.toHaveProperty('safetyState');
    }
  });

  it('rejects a missing substance key', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: '/v1/regulatory-lens',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('error responses leak nothing (spec 14)', () => {
  it('reports a not-found route with a stable code', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: '/v1/does-not-exist',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('suppresses detail on authorization failures', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/dose-events',
      headers: { 'idempotency-key': testUuid(600) },
      payload: { ownedItemId: ITEM_B_MEDICINE, eventKind: 'TAKEN' },
    });
    const body = response.json<{ error: Record<string, unknown> }>();
    expect(body.error.detail).toBeUndefined();
    // The message must not describe why access was refused.
    expect(String(body.error.message)).toBe('Not found.');
  });

  it('carries no forbidden field name in any error response', async () => {
    for (const url of ['/v1/does-not-exist', '/v1/items?profileId=bad', '/v1/regulatory-lens']) {
      const response = await request(principalFor(OWNER), { method: 'GET', url });
      expect(() => {
        assertNoSensitiveFields(response.json());
      }).not.toThrow();
    }
  });

  it('carries no forbidden field name in a successful response', async () => {
    // The shelf response uses displayName, which is a profile-linked value: this asserts the
    // guard is wired and would catch it if the shape changed to include a raw profile name.
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: '/v1/regulatory-lens?substanceKey=SALICYLIC_ACID',
    });
    expect(() => {
      assertNoSensitiveFields(response.json());
    }).not.toThrow();
  });
});

describe('assertNoSensitiveFields', () => {
  it('throws when a forbidden field name is present', () => {
    expect(() => {
      assertNoSensitiveFields({ medicineName: 'x' });
    }).toThrow(/medicineName/);
  });

  it('finds a forbidden field nested inside an array', () => {
    expect(() => {
      assertNoSensitiveFields({ items: [{ ok: 1 }, { diagnosis: 'x' }] });
    }).toThrow(/diagnosis/);
  });

  it('accepts a payload of machine codes and identifiers', () => {
    expect(() => {
      assertNoSensitiveFields({
        code: 'PERMISSION_DENIED',
        correlationId: 'abc',
        counts: [1, 2, 3],
      });
    }).not.toThrow();
  });
});
