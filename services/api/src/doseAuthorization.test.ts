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
 * WHAT IS DELIBERATELY NOT ASSERTED HERE
 * That a dose write needs a capability marked as allowing changes. `0004` gives `dose_event` a
 * policy inheriting reachability from the item, and `0020` says that is deliberate - "`dose_event`
 * is a record of something that happened and is reachability-scoped on purpose". The grant screen
 * disagrees: `VIEW_MEDICINES` is described as `allowsChanges: false` and listed under "viewing"
 * when somebody approves access. Both decisions were made, in different places, and never
 * reconciled (`DEV-049`); which of them moves is a product question, not a change to make in
 * passing to a shipped policy.
 *
 * So what these tests pin is the behaviour as it stands. The day it changes, this file fails -
 * which is the moment the reasoning gets written down.
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

describe('what a view-only caregiver can currently do', () => {
  it('can read the dose history, which is what VIEW_MEDICINES is for', async () => {
    const response = await request(principalFor(VIEWER), {
      method: 'GET',
      url: `/v1/dose-events?ownedItemId=${MEDICINE}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ events: readonly unknown[] }>();
    expect(body.events.length).toBeGreaterThan(0);
  });

  it('can also write one, because the policy inherits reachability from the item', async () => {
    // Pinned, not endorsed. `0004` decided a dose event is reachable exactly when its item is and
    // `0020` restated that as deliberate, so a grant the screen lists under "viewing" carries a
    // write into somebody's dose history with it - the record a doctor reads. Which of the two
    // statements moves is `DEV-049`, and this test is what makes moving it deliberate.
    const response = await recordDose(VIEWER, 104, 'written by a view-only caregiver');
    expect(response.statusCode).toBe(201);
  });

  it('cannot reach a profile they were never granted', async () => {
    const response = await request(principalFor(VIEWER), { method: 'GET', url: '/v1/profiles' });
    const body = response.json<{ profiles: readonly { id: string }[] }>();
    expect(body.profiles.map((p) => p.id)).toEqual([PROFILE]);
  });
});
