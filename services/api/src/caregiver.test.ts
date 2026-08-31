import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { assertNoSensitiveFields } from './errors.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Caregiver invitation flow, end to end (spec 04 Phase 8.1, 06 Journey 6).
 *
 * These run against the real database through PGlite with row-level security in force as the
 * non-superuser `kynviora_app` role. Spec 19 requires integration coverage of API authorization
 * and of the caregiver permission cases; a mocked database would test the mock rather than the
 * policy that actually decides.
 *
 * The two exit criteria for the phase are asserted directly:
 *  - revocation takes effect on the next authenticated access (`revocation` block);
 *  - unauthorized profiles never leak through list or cache behaviour (`profile scoping` block).
 */

const OWNER = testUuid(1);
const OTHER_OWNER = testUuid(2);
const CAREGIVER = testUuid(3);
const ADMIN_CAREGIVER = testUuid(4);
const STRANGER = testUuid(5);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);
const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

const ITEM_A = testUuid(30);
const ITEM_B = testUuid(31);

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;
/** Mutable so a test can move the server clock past an invitation expiry. */
let currentNow: Instant = NOW;

function principalFor(userId: string, steppedUp = false): Principal {
  return {
    userId: unsafeId<UserId>(userId),
    stepUpVerifiedAt: steppedUp ? currentNow : null,
  };
}

const OWNER_STEPPED_UP = () => principalFor(OWNER, true);

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email, verified] of [
      [OWNER, 'owner@example.test', true],
      [OTHER_OWNER, 'other@example.test', true],
      [CAREGIVER, 'caregiver@example.test', true],
      [ADMIN_CAREGIVER, 'admin@example.test', true],
      // Deliberately unverified: an unverified address must not satisfy an email binding.
      [STRANGER, 'stranger@example.test', false],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, ${verified ? 'now()' : 'NULL'})`,
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
      [ITEM_A, PROFILE_A, ITEM_B, PROFILE_B],
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
    pool,
    logger: noopLogger(),
    authenticate: (_request: FastifyRequest) => Promise.resolve(currentPrincipal),
    now: () => currentNow,
    loadSources: () => Promise.resolve(sources),
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

beforeEach(async () => {
  currentNow = NOW;
  // audit_event is deliberately *not* cleared: the append-only trigger refuses a DELETE, which is
  // the behaviour DEC-013 requires. Audit assertions scope themselves by target instead, and the
  // audit route already joins back to live invitation and grant rows, so events whose target was
  // removed between tests drop out on their own.
  await t.asOwner(async (db) => {
    await db.query('UPDATE caregiver_invitation SET accepted_grant_id = NULL');
    await db.query('DELETE FROM caregiver_grant');
    await db.query('DELETE FROM caregiver_invitation');
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

/** Every mutation route requires an idempotency key, so give each call a fresh one by default. */
function idempotent(key: string = randomUUID()): Record<string, string> {
  return { 'idempotency-key': key };
}

interface CreatedInvitation {
  invitationId: string;
  token: string;
}

/** Create an invitation as the owner and return the one-time token. */
async function createInvitation(
  payload: Record<string, unknown> = {},
  as: Principal = OWNER_STEPPED_UP(),
): Promise<CreatedInvitation> {
  const response = await request(as, {
    method: 'POST',
    url: '/v1/caregiver-invitations',
    headers: idempotent(),
    payload: { profileId: PROFILE_A, capabilities: ['VIEW_SAFETY', 'VIEW_SHELF'], ...payload },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<CreatedInvitation>();
  return body;
}

async function acceptAs(userId: string, token: string, key?: string) {
  return request(principalFor(userId), {
    method: 'POST',
    url: '/v1/caregiver-invitations/accept',
    headers: idempotent(key),
    payload: { token },
  });
}

/** Give a user an active grant directly, for tests about what a caregiver may then do. */
async function grantDirect(userId: string, capabilities: string[], profileId = PROFILE_A) {
  await t.asService((db) =>
    db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
      [profileId, userId, profileId === PROFILE_A ? OWNER : OTHER_OWNER, capabilities],
    ),
  );
}

// ---------------------------------------------------------------------------

describe('creating an invitation', () => {
  it('returns a one-time token and stores only its hash', async () => {
    const { invitationId, token } = await createInvitation();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await t.asService((db) =>
      db.query<{ token_hash: string; capabilities: string[]; status: string }>(
        'SELECT token_hash, capabilities, status FROM caregiver_invitation WHERE id = $1',
        [invitationId],
      ),
    );
    const row = stored.rows[0];
    expect(row?.status).toBe('PENDING');
    expect(row?.capabilities).toEqual(['VIEW_SAFETY', 'VIEW_SHELF']);
    // DEC-018: the token is unrecoverable from the database.
    expect(row?.token_hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(row?.token_hash).not.toBe(token);
  });

  it('never writes the plaintext token into any column', async () => {
    const { token } = await createInvitation();
    const dump = await t.asService((db) =>
      db.query<Record<string, unknown>>('SELECT * FROM caregiver_invitation'),
    );
    expect(JSON.stringify(dump.rows)).not.toContain(token);
  });

  it('requires step-up authentication', async () => {
    // Spec 14: caregiver administration is a step-up action. A valid session is not sufficient.
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      headers: idempotent(),
      payload: { profileId: PROFILE_A, capabilities: ['VIEW_SAFETY'] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
  });

  it('treats a stale step-up as no step-up', async () => {
    const stale = instantFrom('2026-08-29T11:00:00.000Z'); // an hour before `now`
    const response = await request(
      { userId: unsafeId<UserId>(OWNER), stepUpVerifiedAt: stale },
      {
        method: 'POST',
        url: '/v1/caregiver-invitations',
        headers: idempotent(),
        payload: { profileId: PROFILE_A, capabilities: ['VIEW_SAFETY'] },
      },
    );
    expect(response.statusCode).toBe(403);
  });

  it('requires an idempotency key', async () => {
    // Without one, a retry after a dropped response mints a second live credential.
    const response = await request(OWNER_STEPPED_UP(), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      payload: { profileId: PROFILE_A, capabilities: ['VIEW_SAFETY'] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', detail: { reason_code: 'idempotency_key_required' } },
    });
  });

  it('commits exactly once on a retry, and cannot re-issue the token', async () => {
    const key = randomUUID();
    const payload = { profileId: PROFILE_A, capabilities: ['VIEW_SAFETY'] };

    const first = await request(OWNER_STEPPED_UP(), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      headers: idempotent(key),
      payload,
    });
    expect(first.statusCode).toBe(201);

    const retry = await request(OWNER_STEPPED_UP(), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      headers: idempotent(key),
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replay']).toBe('true');
    // The honest consequence of hash-only storage: the first token cannot be produced again.
    expect(retry.json()).toMatchObject({
      replayed: true,
      token: null,
      tokenRecoverable: false,
      invitationId: first.json<CreatedInvitation>().invitationId,
    });

    const count = await t.asService((db) =>
      db.query('SELECT id FROM caregiver_invitation WHERE client_operation_id = $1', [key]),
    );
    expect(count.rows).toHaveLength(1);
  });

  it('refuses a stranger, without confirming the profile exists', async () => {
    const unknownProfile = testUuid(999);

    const foreign = await request(principalFor(STRANGER, true), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      headers: idempotent(),
      payload: { profileId: PROFILE_A, capabilities: ['VIEW_SAFETY'] },
    });
    const missing = await request(principalFor(STRANGER, true), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      headers: idempotent(),
      payload: { profileId: unknownProfile, capabilities: ['VIEW_SAFETY'] },
    });

    expect(foreign.statusCode).toBe(404);
    // Byte-identical apart from the correlation ID: a real profile and an imaginary one are
    // indistinguishable to someone with no access (spec 19 enumeration weakness).
    const strip = (body: string) => body.replace(/"correlationId":"[^"]+"/, '');
    expect(strip(foreign.body)).toBe(strip(missing.body));
  });

  it('refuses a caregiver who does not administer the profile', async () => {
    await grantDirect(CAREGIVER, ['VIEW_SAFETY', 'VIEW_MEDICINES']);
    const response = await request(principalFor(CAREGIVER, true), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      headers: idempotent(),
      payload: { profileId: PROFILE_A, capabilities: ['VIEW_SAFETY'] },
    });
    expect(response.statusCode).toBe(404);
  });

  it('lets a delegated administrator invite within their own capabilities', async () => {
    await grantDirect(ADMIN_CAREGIVER, ['MANAGE_CAREGIVERS', 'VIEW_SAFETY', 'VIEW_SHELF']);
    const response = await request(principalFor(ADMIN_CAREGIVER, true), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      headers: idempotent(),
      payload: { profileId: PROFILE_A, capabilities: ['VIEW_SAFETY'] },
    });
    expect(response.statusCode).toBe(201);
  });

  it('refuses a delegated administrator granting beyond their own capabilities', async () => {
    await grantDirect(ADMIN_CAREGIVER, ['MANAGE_CAREGIVERS', 'VIEW_SAFETY']);
    const response = await request(principalFor(ADMIN_CAREGIVER, true), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      headers: idempotent(),
      payload: { profileId: PROFILE_A, capabilities: ['EXPORT_SUMMARY'] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'CAPABILITY_ESCALATION' } });
  });

  it('refuses a delegated administrator minting another administrator', async () => {
    await grantDirect(ADMIN_CAREGIVER, ['MANAGE_CAREGIVERS']);
    const response = await request(principalFor(ADMIN_CAREGIVER, true), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      headers: idempotent(),
      payload: { profileId: PROFILE_A, capabilities: ['MANAGE_CAREGIVERS'] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'CAPABILITY_ESCALATION' } });
  });

  it('rejects an unknown capability and an empty capability list', async () => {
    for (const capabilities of [['ROOT'], []]) {
      const response = await request(OWNER_STEPPED_UP(), {
        method: 'POST',
        url: '/v1/caregiver-invitations',
        headers: idempotent(),
        payload: { profileId: PROFILE_A, capabilities },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('rejects an invitation lifetime beyond the permitted maximum', async () => {
    const response = await request(OWNER_STEPPED_UP(), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      headers: idempotent(),
      payload: { profileId: PROFILE_A, capabilities: ['VIEW_SAFETY'], invitationTtlDays: 365 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('anchors created_at to the injected clock, not the database wall clock', async () => {
    // Both sides of `caregiver_invitation_expiry_after_creation` must come from the same clock.
    // When `created_at` was left to its `DEFAULT now()`, an expiry derived from a fixed injected
    // clock was compared against real time, so the shortest permitted lifetime became
    // unsatisfiable the moment the wall clock passed it - the row was refused by the schema and
    // surfaced as a 500. Reading the column back proves which clock actually wrote it.
    const { invitationId } = await createInvitation({ invitationTtlDays: 1 });

    const stored = await t.asService((db) =>
      db.query<{ created_at: Date; expires_at: Date }>(
        'SELECT created_at, expires_at FROM caregiver_invitation WHERE id = $1',
        [invitationId],
      ),
    );
    const row = stored.rows[0];
    expect(row).toBeDefined();
    expect(row?.created_at.toISOString()).toBe(NOW);
    expect(row?.expires_at.toISOString()).toBe('2026-08-30T12:00:00.000Z');
  });
});

describe('accepting an invitation', () => {
  it('creates an active grant carrying exactly the invited capabilities', async () => {
    const { token, invitationId } = await createInvitation();
    const response = await acceptAs(CAREGIVER, token);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      profileId: PROFILE_A,
      capabilities: ['VIEW_SAFETY', 'VIEW_SHELF'],
    });

    const stored = await t.asService((db) =>
      db.query<{ status: string; capabilities: string[]; invitation_id: string | null }>(
        'SELECT status, capabilities, invitation_id FROM caregiver_grant',
      ),
    );
    expect(stored.rows[0]).toMatchObject({
      status: 'ACTIVE',
      capabilities: ['VIEW_SAFETY', 'VIEW_SHELF'],
      invitation_id: invitationId,
    });

    const invitation = await t.asService((db) =>
      db.query<{ status: string; accepted_by_user_id: string | null }>(
        'SELECT status, accepted_by_user_id FROM caregiver_invitation WHERE id = $1',
        [invitationId],
      ),
    );
    expect(invitation.rows[0]).toMatchObject({
      status: 'ACCEPTED',
      accepted_by_user_id: CAREGIVER,
    });
  });

  it('gives the caregiver access to exactly the granted profile', async () => {
    const { token } = await createInvitation();
    await acceptAs(CAREGIVER, token);

    const profiles = await request(principalFor(CAREGIVER), {
      method: 'GET',
      url: '/v1/profiles',
    });
    expect(profiles.statusCode).toBe(200);
    const listed = profiles.json<{ profiles: { id: string }[] }>().profiles;
    expect(listed.map((p) => p.id)).toEqual([PROFILE_A]);
  });

  it('replays an identical retry rather than creating a second grant', async () => {
    const { token } = await createInvitation();
    const key = randomUUID();

    const first = await acceptAs(CAREGIVER, token, key);
    expect(first.statusCode).toBe(201);

    const retry = await acceptAs(CAREGIVER, token, key);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.json()).toMatchObject({ replayed: true });

    const grants = await t.asService((db) => db.query('SELECT id FROM caregiver_grant'));
    expect(grants.rows).toHaveLength(1);
  });

  it('replays a retry under a different idempotency key too', async () => {
    // The invitation, not the header, is the thing that has already been spent.
    const { token } = await createInvitation();
    expect((await acceptAs(CAREGIVER, token)).statusCode).toBe(201);

    const again = await acceptAs(CAREGIVER, token);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true });

    const grants = await t.asService((db) => db.query('SELECT id FROM caregiver_grant'));
    expect(grants.rows).toHaveLength(1);
  });

  it('requires an idempotency key', async () => {
    const { token } = await createInvitation();
    const response = await request(principalFor(CAREGIVER), {
      method: 'POST',
      url: '/v1/caregiver-invitations/accept',
      payload: { token },
    });
    expect(response.statusCode).toBe(400);
  });

  it('reports an unknown and a malformed token identically', async () => {
    const unknown = await acceptAs(CAREGIVER, 'a'.repeat(43));
    const malformed = await acceptAs(CAREGIVER, 'not-a-token');

    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'INVITATION_INVALID' } });
    // Identical, so the endpoint is not an oracle for token shape.
    const strip = (body: string) => body.replace(/"correlationId":"[^"]+"/, '');
    expect(strip(unknown.body)).toBe(strip(malformed.body));
  });

  it('refuses an expired invitation', async () => {
    const { token } = await createInvitation({ invitationTtlDays: 1 });
    currentNow = instantFrom('2026-09-10T12:00:00.000Z');

    const response = await acceptAs(CAREGIVER, token);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'INVITATION_EXPIRED' } });

    const grants = await t.asService((db) => db.query('SELECT id FROM caregiver_grant'));
    expect(grants.rows).toEqual([]);
  });

  it('refuses the sender accepting their own invitation', async () => {
    const { token } = await createInvitation();
    const response = await acceptAs(OWNER, token);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', detail: { reason_code: 'self_grant' } },
    });
  });

  it('binds an addressed invitation to the matching verified account', async () => {
    const { token } = await createInvitation({ invitedEmail: 'Caregiver@Example.test' });
    // Normalisation is case-folding, so the mixed-case address still matches.
    const response = await acceptAs(CAREGIVER, token);
    expect(response.statusCode).toBe(201);
  });

  it('refuses an addressed invitation presented by another account, and says nothing about whom', async () => {
    const { token } = await createInvitation({ invitedEmail: 'caregiver@example.test' });
    const response = await acceptAs(ADMIN_CAREGIVER, token);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'INVITATION_INVALID' } });
    // A link that reached the wrong person must not confirm the intended recipient.
    expect(response.body).not.toContain('caregiver@example.test');
    expect(response.body).not.toContain('recipient_mismatch');
  });

  it('refuses an addressed invitation when the account email is unverified', async () => {
    const { token } = await createInvitation({ invitedEmail: 'stranger@example.test' });
    const response = await acceptAs(STRANGER, token);
    expect(response.statusCode).toBe(404);
  });

  it('refuses a second person redeeming an already-accepted invitation', async () => {
    const { token } = await createInvitation();
    expect((await acceptAs(CAREGIVER, token)).statusCode).toBe(201);

    const second = await acceptAs(ADMIN_CAREGIVER, token);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: {
        code: 'INVITATION_ALREADY_RESOLVED',
        detail: { reason_code: 'accepted_by_another_user' },
      },
    });
  });

  it('refuses to widen an existing active grant by redeeming a second invitation', async () => {
    await grantDirect(CAREGIVER, ['VIEW_SAFETY']);
    const { token } = await createInvitation({ capabilities: ['MANAGE_MEDICINES'] });

    const response = await acceptAs(CAREGIVER, token);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'active_grant_exists' } },
    });

    // The existing grant is untouched: no silent privilege change.
    const grants = await t.asService((db) =>
      db.query<{ capabilities: string[] }>('SELECT capabilities FROM caregiver_grant'),
    );
    expect(grants.rows).toHaveLength(1);
    expect(grants.rows[0]?.capabilities).toEqual(['VIEW_SAFETY']);
  });

  it('records a refused acceptance in the audit trail', async () => {
    // Repeated failures against a valid token are how a leaked link becomes visible (spec 20).
    const { token, invitationId } = await createInvitation({
      invitedEmail: 'caregiver@example.test',
    });
    await acceptAs(ADMIN_CAREGIVER, token);

    const events = await t.asService((db) =>
      db.query<{ action: string; target_id: string }>(
        `SELECT action, target_id FROM audit_event
         WHERE action = 'caregiver.invitation.rejected' AND target_id = $1`,
        [invitationId],
      ),
    );
    expect(events.rows).toHaveLength(1);
  });
});

describe('profile scoping', () => {
  it('does not leak an unauthorized profile through the shelf list', async () => {
    // Phase 8.1 exit criterion: unauthorized profiles never leak through list behaviour.
    const { token } = await createInvitation({
      capabilities: ['VIEW_SAFETY', 'VIEW_SHELF', 'VIEW_MEDICINES'],
    });
    await acceptAs(CAREGIVER, token);

    const own = await request(principalFor(CAREGIVER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_A}`,
    });
    expect(own.json<{ items: unknown[] }>().items).toHaveLength(1);

    const foreign = await request(principalFor(CAREGIVER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_B}`,
    });
    // Not a 403: an empty page is indistinguishable from a profile with no items, so the
    // response does not confirm that PROFILE_B exists.
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('keeps shelf access separate from medicine access', async () => {
    // Spec 03 group H requires a separate permission for safety alerts, shelf, medicines and
    // exports. A caregiver invited to the shelf must not thereby see the medicines on it, and
    // the seeded item for PROFILE_A is a medicine.
    const { token } = await createInvitation({ capabilities: ['VIEW_SAFETY', 'VIEW_SHELF'] });
    await acceptAs(CAREGIVER, token);

    const items = await request(principalFor(CAREGIVER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_A}`,
    });
    expect(items.json<{ items: unknown[] }>().items).toEqual([]);

    // The profile itself is still visible - the caregiver was invited to it - which is what
    // makes this a capability boundary rather than a profile boundary.
    const profiles = await request(principalFor(CAREGIVER), {
      method: 'GET',
      url: '/v1/profiles',
    });
    expect(profiles.json<{ profiles: unknown[] }>().profiles).toHaveLength(1);
  });

  it('confines a caregiver to the capabilities they were granted', async () => {
    const { token } = await createInvitation({ capabilities: ['VIEW_SAFETY'] });
    await acceptAs(CAREGIVER, token);

    const capabilities = await t.asUser(CAREGIVER, async (db) => {
      const rows: Record<string, boolean> = {};
      for (const capability of ['VIEW_SAFETY', 'MANAGE_MEDICINES', 'EXPORT_SUMMARY']) {
        const res = await db.query<{ ok: boolean }>(
          'SELECT kynviora.has_capability($1, $2) AS ok',
          [PROFILE_A, capability],
        );
        rows[capability] = res.rows[0]?.ok ?? false;
      }
      return rows;
    });

    expect(capabilities).toEqual({
      VIEW_SAFETY: true,
      MANAGE_MEDICINES: false,
      EXPORT_SUMMARY: false,
    });
  });
});

describe('declining an invitation', () => {
  it('closes the invitation so the token stops working', async () => {
    const { token } = await createInvitation();

    const declined = await request(principalFor(CAREGIVER), {
      method: 'POST',
      url: '/v1/caregiver-invitations/decline',
      payload: { token },
    });
    expect(declined.statusCode).toBe(200);

    const accept = await acceptAs(CAREGIVER, token);
    expect(accept.statusCode).toBe(409);
    expect(accept.json()).toMatchObject({ error: { detail: { reason_code: 'declined' } } });
  });

  it('does not require step-up, because it only removes access', async () => {
    const { token } = await createInvitation();
    const response = await request(principalFor(CAREGIVER), {
      method: 'POST',
      url: '/v1/caregiver-invitations/decline',
      payload: { token },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('revoking an invitation', () => {
  it('stops a pending invitation from being redeemed', async () => {
    const { token, invitationId } = await createInvitation();

    const revoked = await request(OWNER_STEPPED_UP(), {
      method: 'POST',
      url: `/v1/caregiver-invitations/${invitationId}/revoke`,
    });
    expect(revoked.statusCode).toBe(200);

    const accept = await acceptAs(CAREGIVER, token);
    expect(accept.statusCode).toBe(409);
    expect(accept.json()).toMatchObject({ error: { detail: { reason_code: 'revoked' } } });
  });

  it('requires step-up', async () => {
    const { invitationId } = await createInvitation();
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/caregiver-invitations/${invitationId}/revoke`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a caller with no authority over the profile', async () => {
    const { invitationId } = await createInvitation();
    const response = await request(principalFor(STRANGER, true), {
      method: 'POST',
      url: `/v1/caregiver-invitations/${invitationId}/revoke`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('does not let the accepting caregiver withdraw the record of their own grant', async () => {
    // The acceptor can see the invitation under the policy. Visibility is not authority.
    const { token, invitationId } = await createInvitation();
    await acceptAs(CAREGIVER, token);

    const response = await request(principalFor(CAREGIVER, true), {
      method: 'POST',
      url: `/v1/caregiver-invitations/${invitationId}/revoke`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to revoke an invitation that was already accepted', async () => {
    const { token, invitationId } = await createInvitation();
    await acceptAs(CAREGIVER, token);

    const response = await request(OWNER_STEPPED_UP(), {
      method: 'POST',
      url: `/v1/caregiver-invitations/${invitationId}/revoke`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'already_accepted' } },
    });
  });
});

describe('revoking a grant', () => {
  async function activeGrantId(): Promise<string> {
    const { token } = await createInvitation();
    const accepted = await acceptAs(CAREGIVER, token);
    return accepted.json<{ grantId: string }>().grantId;
  }

  it('takes effect on the caregiver next authenticated access', async () => {
    // Phase 8.1 exit criterion, and spec 15 A2. No sync, no token refresh, no cache purge is
    // required for the access to stop: the policy re-evaluates the grant on every request.
    const grantId = await activeGrantId();

    const before = await request(principalFor(CAREGIVER), {
      method: 'GET',
      url: '/v1/profiles',
    });
    expect(before.json<{ profiles: unknown[] }>().profiles).toHaveLength(1);

    const revoked = await request(OWNER_STEPPED_UP(), {
      method: 'POST',
      url: `/v1/caregiver-grants/${grantId}/revoke`,
    });
    expect(revoked.statusCode).toBe(200);

    const after = await request(principalFor(CAREGIVER), {
      method: 'GET',
      url: '/v1/profiles',
    });
    expect(after.json<{ profiles: unknown[] }>().profiles).toEqual([]);

    const items = await request(principalFor(CAREGIVER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE_A}`,
    });
    expect(items.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('requires step-up', async () => {
    const grantId = await activeGrantId();
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/caregiver-grants/${grantId}/revoke`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('is idempotent', async () => {
    // Someone removing another person's access who receives an error has been given a reason to
    // doubt whether it worked.
    const grantId = await activeGrantId();

    const first = await request(OWNER_STEPPED_UP(), {
      method: 'POST',
      url: `/v1/caregiver-grants/${grantId}/revoke`,
    });
    expect(first.json()).toMatchObject({ status: 'REVOKED', alreadyRevoked: false });

    const second = await request(OWNER_STEPPED_UP(), {
      method: 'POST',
      url: `/v1/caregiver-grants/${grantId}/revoke`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'REVOKED', alreadyRevoked: true });
  });

  it('lets a caregiver renounce their own access', async () => {
    const grantId = await activeGrantId();
    const response = await request(principalFor(CAREGIVER, true), {
      method: 'POST',
      url: `/v1/caregiver-grants/${grantId}/revoke`,
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses an unrelated user, without confirming the grant exists', async () => {
    const grantId = await activeGrantId();
    const response = await request(principalFor(STRANGER, true), {
      method: 'POST',
      url: `/v1/caregiver-grants/${grantId}/revoke`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('listing grants', () => {
  it('shows a grant to the profile owner and to the caregiver, and to nobody else', async () => {
    const { token } = await createInvitation();
    await acceptAs(CAREGIVER, token);

    for (const user of [OWNER, CAREGIVER]) {
      const response = await request(principalFor(user), {
        method: 'GET',
        url: '/v1/caregiver-grants',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ grants: unknown[] }>().grants).toHaveLength(1);
    }

    for (const user of [STRANGER, OTHER_OWNER]) {
      const response = await request(principalFor(user), {
        method: 'GET',
        url: '/v1/caregiver-grants',
      });
      expect(response.json<{ grants: unknown[] }>().grants).toEqual([]);
    }
  });

  it('treats a profile filter as a narrowing, not an authorization', async () => {
    const { token } = await createInvitation();
    await acceptAs(CAREGIVER, token);

    const response = await request(principalFor(CAREGIVER), {
      method: 'GET',
      url: `/v1/caregiver-grants?profileId=${PROFILE_B}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ grants: unknown[] }>().grants).toEqual([]);
  });
});

describe('audit history', () => {
  it('shows the owner the invitation and grant lifecycle', async () => {
    // Spec 03 group H and 06 Journey 6 step 5: the grant becoming active is visible to the owner.
    const { token } = await createInvitation();
    await acceptAs(CAREGIVER, token);

    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/caregiver-audit`,
    });
    expect(response.statusCode).toBe(200);

    const actions = response.json<{ events: { action: string }[] }>().events.map((e) => e.action);
    expect(actions).toContain('caregiver.invitation.created');
    expect(actions).toContain('caregiver.invitation.accepted');
    expect(actions).toContain('caregiver.grant.created');
  });

  it('records which capabilities were granted, and nothing personal', async () => {
    await createInvitation({
      capabilities: ['VIEW_SHELF', 'VIEW_SAFETY'],
      invitedEmail: 'caregiver@example.test',
    });

    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/caregiver-audit`,
    });
    const events = response.json<{ events: { detail: Record<string, unknown> }[] }>().events;
    expect(events[0]?.detail).toMatchObject({
      capabilities: 'VIEW_SAFETY,VIEW_SHELF',
      capability_count: 2,
      email_bound: true,
    });
    // Spec 20: audit records who acted and what changed, never a copy of personal content.
    expect(response.body).not.toContain('caregiver@example.test');
    assertNoSensitiveFields(response.json());
  });

  it('refuses a caller with no authority over the profile', async () => {
    await createInvitation();
    for (const user of [STRANGER, OTHER_OWNER, CAREGIVER]) {
      const response = await request(principalFor(user), {
        method: 'GET',
        url: `/v1/profiles/${PROFILE_A}/caregiver-audit`,
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('does not include audit events from another household', async () => {
    await createInvitation();
    await request(principalFor(OTHER_OWNER, true), {
      method: 'POST',
      url: '/v1/caregiver-invitations',
      headers: idempotent(),
      payload: { profileId: PROFILE_B, capabilities: ['VIEW_SAFETY'] },
    });

    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/caregiver-audit`,
    });
    const events = response.json<{ events: unknown[] }>().events;
    expect(events).toHaveLength(1);
  });
});

describe('responses carry no sensitive fields', () => {
  it('holds across the whole flow', async () => {
    const { token, invitationId } = await createInvitation();
    const accepted = await acceptAs(CAREGIVER, token);
    const grants = await request(principalFor(OWNER), {
      method: 'GET',
      url: '/v1/caregiver-grants',
    });
    const audit = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/caregiver-audit`,
    });

    for (const response of [accepted, grants, audit]) {
      assertNoSensitiveFields(response.json());
      // The token appears exactly once in the whole flow: the create response.
      expect(response.body).not.toContain(token);
    }
    expect(invitationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
