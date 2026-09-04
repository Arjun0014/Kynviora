import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Quiet hours, read in the recipient's own night (DEC-119, `DEV-030`).
 *
 * Spec references: `04` Phase 7.5 (quiet hours), `04` Phase 4.1 (a local wall clock plus a zone,
 * never an offset), `13` (a request never carries proof of whose it is), `14`, `16`.
 *
 * WHAT THIS FILE MEASURES THAT THE DOMAIN TESTS DO NOT
 * That the value actually arrives. `deliveryDecision` has taken a local minute since it was
 * written, every caller passed `null`, and every test of it passed - which is exactly the shape of
 * a feature that is complete and does nothing. `DEV-030` was that gap for eleven migrations.
 *
 * THE CASE THE WHOLE DECISION EXISTS FOR
 * Two recipients on one dispatch, in two places. A caregiver in London looking after somebody in
 * Kolkata must not be woken at four in the morning because the household's night is elsewhere -
 * and before this, one decision was computed for the whole dispatch, which could not express that
 * even in principle.
 */

const OWNER = testUuid(1);
const CAREGIVER = testUuid(2);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const KOLKATA = 'Asia/Kolkata';
const LONDON = 'Europe/London';

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
    now: (): Instant => instantFrom('2026-09-05T20:00:00.000Z'),
    loadSources: () => Promise.resolve(sources),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

beforeEach(async () => {
  await t.asService((db) => db.query(`UPDATE app_user SET time_zone = NULL`));
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

const setZone = (as: Principal | null, timeZone: string | null) =>
  request(as, { method: 'PUT', url: '/v1/me/time-zone', payload: { timeZone } });

async function storedZone(userId: string): Promise<string | null> {
  const res = await t.asService((db) =>
    db.query<{ time_zone: string | null }>(`SELECT time_zone FROM app_user WHERE id = $1`, [
      userId,
    ]),
  );
  return res.rows[0]?.time_zone ?? null;
}

// ---------------------------------------------------------------------------

describe('reporting where you are', () => {
  it('records a zone the runtime knows', async () => {
    const res = await setZone(principalFor(OWNER), KOLKATA);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      timeZone: KOLKATA,
      quietHoursNote: 'Quiet hours are read in this time zone.',
    });
    expect(await storedZone(OWNER)).toBe(KOLKATA);
  });

  it('refuses an offset written where a zone belongs', async () => {
    // ICU accepts `+05:30` as a time zone, which is precisely what makes this worth refusing at
    // the boundary: a stored offset is correct today and an hour wrong after the next transition.
    const res = await setZone(principalFor(OWNER), '+05:30');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(await storedZone(OWNER)).toBeNull();
  });

  it('refuses a zone nobody has heard of', async () => {
    expect((await setZone(principalFor(OWNER), 'Nowhere/Real')).statusCode).toBe(400);
  });

  it('accepts null as a real answer, and says what it means', async () => {
    // A device that cannot determine its zone says so, and the stored value returns to unknown
    // rather than staying at whatever was true last month - a stale zone deciding somebody's night
    // from a different continent is worse than no zone.
    await setZone(principalFor(OWNER), KOLKATA);
    const res = await setZone(principalFor(OWNER), null);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      timeZone: null,
      quietHoursNote:
        'Kynviora does not know what time it is where you are, so nothing is held back overnight.',
    });
    expect(await storedZone(OWNER)).toBeNull();
  });

  it('writes the caller’s own row and takes no user id', async () => {
    // `13`: a request never carries proof of whose it is. There is no identifier in the body to
    // validate, because there is no identifier in the body - row-level security decides which row
    // this reaches.
    await setZone(principalFor(OWNER), KOLKATA);
    await setZone(principalFor(CAREGIVER), LONDON);

    expect(await storedZone(OWNER)).toBe(KOLKATA);
    expect(await storedZone(CAREGIVER)).toBe(LONDON);
  });

  it('refuses an anonymous request', async () => {
    expect((await setZone(null, KOLKATA)).statusCode).toBe(401);
  });
});

describe('one person cannot read another’s zone', () => {
  it('is not on any household read', async () => {
    // A zone is coarse and it is still a fact about somebody's whereabouts. `app_user_self_select`
    // is self-only, and nothing added here widens it: the dispatcher reads it through the service
    // role, which is the only role that may.
    await setZone(principalFor(CAREGIVER), LONDON);

    const asOwner = await t.asUser(OWNER, (db) =>
      db.query<{ id: string; time_zone: string | null }>(`SELECT id, time_zone FROM app_user`),
    );
    expect(asOwner.rows.map((row) => row.id)).toEqual([OWNER]);
  });
});

describe('what a stored zone changes about a delivery', () => {
  /**
   * The decision the dispatcher would reach for one recipient, asked of the same functions it
   * uses. `dispatchAlert` needs a published alert and a reviewer nobody has staffed (`BLK-006`),
   * so the composition is exercised here and the wiring is exercised by `alertDelivery.test.ts`.
   */
  async function heldFor(userId: string): Promise<boolean> {
    const { deliveryDecision, recipientLocalMinute } = await import('@kynviora/domain');
    return deliveryDecision({
      urgency: 'HIGH',
      deliverable: true,
      alreadyDelivered: false,
      quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 },
      localMinuteOfDay: recipientLocalMinute({
        at: '2026-09-05T20:00:00.000Z',
        zone: await storedZone(userId),
      }),
    }).held;
  }

  it('holds for the recipient whose night it is, and not for the other', async () => {
    // The case DEC-119 exists for. 20:00 UTC is 01:30 in Kolkata and 21:00 in London: one
    // dispatch, two recipients, two answers - which a single decision for the whole dispatch
    // could not express even in principle.
    await setZone(principalFor(OWNER), KOLKATA);
    await setZone(principalFor(CAREGIVER), LONDON);

    expect(await heldFor(OWNER)).toBe(true);
    expect(await heldFor(CAREGIVER)).toBe(false);
  });

  it('does not hold for a recipient whose zone is unknown', async () => {
    // The approved rule. Not holding is the safe direction: the failure it avoids is an alert
    // waiting for a window that never ends.
    expect(await heldFor(OWNER)).toBe(false);
  });
});
