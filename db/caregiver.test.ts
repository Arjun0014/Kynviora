import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';
import { CAREGIVER_CAPABILITIES } from '@kynviora/domain';

/**
 * Database-level tests for the caregiver invitation flow (migration `0007`).
 *
 * Spec 19 requires automated authorization cases for caregiver permission scenarios; spec 14
 * requires column-level or service-layer controls over sensitive fields; spec 13 lists caregiver
 * grant creation and revocation finalisation as privileged server-only operations.
 *
 * Every assertion runs as the non-superuser `kynviora_app` or `kynviora_service` role. The
 * harness fails the test if that is not true (DEC-005), because a superuser bypasses row-level
 * security entirely and the assertions would pass vacuously.
 */

const OWNER_A = testUuid(1);
const OWNER_B = testUuid(2);
const CAREGIVER = testUuid(3);
const ADMIN_CAREGIVER = testUuid(4);
const STRANGER = testUuid(5);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);

const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

/** A well-formed token hash. Any 64 lowercase hex characters satisfy the shape constraint. */
function hashOf(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

const FUTURE = '2099-01-01T00:00:00.000Z';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER_A, 'owner-a@example.test'],
      [OWNER_B, 'owner-b@example.test'],
      [CAREGIVER, 'caregiver@example.test'],
      [ADMIN_CAREGIVER, 'admin-caregiver@example.test'],
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
      [HOUSEHOLD_A, OWNER_A, HOUSEHOLD_B, OWNER_B],
    );

    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent A (synthetic)'), ($4, $5, $6, 'Parent B (synthetic)')`,
      [PROFILE_A, HOUSEHOLD_A, OWNER_A, PROFILE_B, HOUSEHOLD_B, OWNER_B],
    );
  });
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  // Order matters: a grant may be referenced by an invitation and vice versa.
  await t.asOwner(async (db) => {
    await db.query('UPDATE caregiver_invitation SET accepted_grant_id = NULL');
    await db.query('DELETE FROM caregiver_grant');
    await db.query('DELETE FROM caregiver_invitation');
  });
});

/** Insert an invitation as the service role, the only role permitted to. */
async function invite(
  overrides: {
    profileId?: string;
    invitedBy?: string;
    email?: string | null;
    capabilities?: string[];
    tokenHash?: string;
    status?: string;
    expiresAt?: string;
    operationId?: string | null;
  } = {},
): Promise<string> {
  const res = await t.asService((db) =>
    db.query<{ id: string }>(
      `INSERT INTO caregiver_invitation
         (profile_id, invited_by_user_id, invited_email_normalized, capabilities, token_hash,
          status, expires_at, client_operation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        overrides.profileId ?? PROFILE_A,
        overrides.invitedBy ?? OWNER_A,
        overrides.email ?? null,
        overrides.capabilities ?? ['VIEW_SAFETY'],
        overrides.tokenHash ?? hashOf(Math.floor(Math.random() * 1e15) + 1),
        overrides.status ?? 'PENDING',
        overrides.expiresAt ?? FUTURE,
        overrides.operationId ?? null,
      ],
    ),
  );
  return res.rows[0]!.id;
}

/** Insert an active grant as the service role. */
async function grant(
  granteeUserId: string,
  capabilities: string[],
  profileId: string = PROFILE_A,
): Promise<string> {
  const res = await t.asService((db) =>
    db.query<{ id: string }>(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now())
       RETURNING id`,
      [profileId, granteeUserId, profileId === PROFILE_A ? OWNER_A : OWNER_B, capabilities],
    ),
  );
  return res.rows[0]!.id;
}

// ---------------------------------------------------------------------------

describe('caregiver_invitation schema', () => {
  it('has row-level security enabled and forced', async () => {
    const res = await t.asOwner((db) =>
      db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relname = 'caregiver_invitation'`,
      ),
    );
    expect(res.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('grants the app role no write privilege of any kind', async () => {
    // Spec 13: caregiver grant creation and revocation finalisation are privileged server-only
    // operations, and an invitation is the act that creates a grant.
    const res = await t.asOwner((db) =>
      db.query<{ privilege_type: string }>(
        `SELECT DISTINCT privilege_type FROM information_schema.table_privileges
         WHERE table_name = 'caregiver_invitation' AND grantee = 'kynviora_app'`,
      ),
    );
    expect(res.rows.map((r) => r.privilege_type)).toEqual([]);
  });

  it('keeps the capability vocabulary identical to the grant table and the domain', async () => {
    // The CHECK lists are duplicated because Postgres forbids a subquery in a CHECK. This test is
    // what stops them drifting - an invitation carrying a capability no grant can hold would be
    // unredeemable, and the failure would only surface at acceptance time.
    const res = await t.asOwner((db) =>
      db.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname IN ('caregiver_grant_capabilities_known',
                           'caregiver_invitation_capabilities_known')`,
      ),
    );
    expect(res.rows).toHaveLength(2);

    const listed = res.rows.map((row) =>
      [...row.def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]!).sort(),
    );
    const domain = [...CAREGIVER_CAPABILITIES].sort();
    expect(listed[0]).toEqual(domain);
    expect(listed[1]).toEqual(domain);
  });
});

describe('token secrecy (DEC-018)', () => {
  it('does not let the app role read the token hash at all', async () => {
    // Row-level security cannot hide a column. The column-level GRANT is what makes this a
    // database fact rather than a promise about how queries are written (spec 14).
    await invite();
    const message = await expectDenied(() =>
      t.asUser(OWNER_A, (db) => db.query('SELECT token_hash FROM caregiver_invitation')),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('still lets the profile owner read every other column', async () => {
    await invite();
    const res = await t.asUser(OWNER_A, (db) =>
      db.query<{ id: string; status: string; capabilities: string[] }>(
        'SELECT id, status, capabilities FROM caregiver_invitation',
      ),
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.status).toBe('PENDING');
  });

  it('refuses a value that is not 64 lowercase hex characters', async () => {
    for (const bad of [
      // The most plausible mistake: the plaintext token itself, which is 43 base64url chars.
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      '',
    ]) {
      const message = await expectDenied(() => invite({ tokenHash: bad }));
      expect(message).toMatch(/caregiver_invitation_token_hash_shape/);
    }
  });

  it('refuses two invitations sharing a token hash', async () => {
    const shared = hashOf(0xabc);
    await invite({ tokenHash: shared });
    const message = await expectDenied(() => invite({ tokenHash: shared }));
    expect(message).toMatch(/caregiver_invitation_token_hash_idx|duplicate key/i);
  });
});

describe('invitation integrity constraints', () => {
  it('rejects an unknown capability', async () => {
    const message = await expectDenied(() => invite({ capabilities: ['ROOT'] }));
    expect(message).toMatch(/caregiver_invitation_capabilities_known/);
  });

  it('rejects an empty capability list', async () => {
    const message = await expectDenied(() => invite({ capabilities: [] }));
    expect(message).toMatch(/caregiver_invitation_capabilities_not_empty/);
  });

  it('rejects an invitation that expires before it was created', async () => {
    // An invitation with no future is either a clock bug or an attempt to backdate one.
    const message = await expectDenied(() => invite({ expiresAt: '2020-01-01T00:00:00.000Z' }));
    expect(message).toMatch(/caregiver_invitation_expiry_after_creation/);
  });

  it('rejects an ACCEPTED invitation with no recorded acceptor', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO caregiver_invitation
             (profile_id, invited_by_user_id, capabilities, token_hash, status, expires_at)
           VALUES ($1, $2, $3, $4, 'ACCEPTED', $5)`,
          [PROFILE_A, OWNER_A, ['VIEW_SAFETY'], hashOf(0xd1), FUTURE],
        ),
      ),
    );
    expect(message).toMatch(/caregiver_invitation_accepted_complete/);
  });

  it('rejects the sender accepting their own invitation', async () => {
    const id = await invite({ invitedBy: OWNER_A });
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `UPDATE caregiver_invitation
           SET status = 'ACCEPTED', accepted_at = now(), accepted_by_user_id = $1
           WHERE id = $2`,
          [OWNER_A, id],
        ),
      ),
    );
    expect(message).toMatch(/caregiver_invitation_no_self_accept/);
  });

  it('rejects a REVOKED invitation with no recorded revoker', async () => {
    const id = await invite();
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `UPDATE caregiver_invitation SET status = 'REVOKED', revoked_at = now() WHERE id = $1`,
          [id],
        ),
      ),
    );
    expect(message).toMatch(/caregiver_invitation_revoked_complete/);
  });

  it('rejects a second invitation reusing an idempotency key', async () => {
    // Spec 13: the server commits exactly once. A retry must not mint a second live credential.
    const operationId = testUuid(900);
    await invite({ operationId });
    const message = await expectDenied(() => invite({ operationId }));
    expect(message).toMatch(/caregiver_invitation_operation_idx|duplicate key/i);
  });

  it('allows many invitations with no idempotency key', async () => {
    // The uniqueness is partial: NULL keys must not collide with one another.
    await invite({ operationId: null });
    await invite({ operationId: null });
    const res = await t.asService((db) => db.query('SELECT id FROM caregiver_invitation'));
    expect(res.rows).toHaveLength(2);
  });
});

describe('invitation visibility (RLS)', () => {
  it('shows an invitation to the profile owner', async () => {
    await invite();
    const res = await t.asUser(OWNER_A, (db) => db.query('SELECT id FROM caregiver_invitation'));
    expect(res.rows).toHaveLength(1);
  });

  it('shows an invitation to a caregiver who administers the profile', async () => {
    await grant(ADMIN_CAREGIVER, ['MANAGE_CAREGIVERS']);
    await invite();
    const res = await t.asUser(ADMIN_CAREGIVER, (db) =>
      db.query('SELECT id FROM caregiver_invitation'),
    );
    expect(res.rows).toHaveLength(1);
  });

  it('hides an invitation from a caregiver without MANAGE_CAREGIVERS', async () => {
    await grant(CAREGIVER, ['VIEW_SAFETY', 'VIEW_MEDICINES']);
    await invite();
    const res = await t.asUser(CAREGIVER, (db) => db.query('SELECT id FROM caregiver_invitation'));
    expect(res.rows).toEqual([]);
  });

  it('hides an invitation from the intended recipient until they accept it', async () => {
    // The recipient holds the token, not a row. Matching an invitation to an email address the
    // caller has not proven they control would disclose that the profile exists.
    await invite({ email: 'caregiver@example.test' });
    const res = await t.asUser(CAREGIVER, (db) => db.query('SELECT id FROM caregiver_invitation'));
    expect(res.rows).toEqual([]);
  });

  it('shows the invitation to the account that accepted it', async () => {
    const id = await invite();
    await t.asService((db) =>
      db.query(
        `UPDATE caregiver_invitation
         SET status = 'ACCEPTED', accepted_at = now(), accepted_by_user_id = $1 WHERE id = $2`,
        [CAREGIVER, id],
      ),
    );
    const res = await t.asUser(CAREGIVER, (db) => db.query('SELECT id FROM caregiver_invitation'));
    expect(res.rows).toHaveLength(1);
  });

  it('hides another household entirely (spec 15 A1)', async () => {
    await invite({ profileId: PROFILE_B, invitedBy: OWNER_B });
    for (const user of [OWNER_A, CAREGIVER, STRANGER]) {
      const res = await t.asUser(user, (db) => db.query('SELECT id FROM caregiver_invitation'));
      expect(res.rows).toEqual([]);
    }
  });

  it('fails closed when no user context is set', async () => {
    await invite();
    const res = await t.asUser(null, (db) => db.query('SELECT id FROM caregiver_invitation'));
    expect(res.rows).toEqual([]);
  });

  it('does not let an app-role user create, alter or delete an invitation', async () => {
    const id = await invite();

    const inserted = await expectDenied(() =>
      t.asUser(STRANGER, (db) =>
        db.query(
          `INSERT INTO caregiver_invitation
             (profile_id, invited_by_user_id, capabilities, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [PROFILE_A, OWNER_A, ['MANAGE_CAREGIVERS'], hashOf(0xbad), FUTURE],
        ),
      ),
    );
    expect(inserted).toMatch(/permission denied/i);

    const updated = await expectDenied(() =>
      t.asUser(OWNER_A, (db) =>
        db.query(`UPDATE caregiver_invitation SET status = 'ACCEPTED' WHERE id = $1`, [id]),
      ),
    );
    expect(updated).toMatch(/permission denied/i);

    const deleted = await expectDenied(() =>
      t.asUser(OWNER_A, (db) => db.query('DELETE FROM caregiver_invitation WHERE id = $1', [id])),
    );
    expect(deleted).toMatch(/permission denied/i);
  });

  it('does not let a caregiver escalate an invitation into an administrator grant', async () => {
    await grant(CAREGIVER, ['VIEW_SAFETY']);
    const id = await invite({ capabilities: ['VIEW_SAFETY'] });
    const message = await expectDenied(() =>
      t.asUser(CAREGIVER, (db) =>
        db.query(`UPDATE caregiver_invitation SET capabilities = $1 WHERE id = $2`, [
          ['MANAGE_CAREGIVERS'],
          id,
        ]),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

describe('one active grant per caregiver and profile', () => {
  it('refuses a second active grant for the same pair', async () => {
    // Two active grants would be unioned by kynviora.has_capability into a permission set nobody
    // approved. The database refuses to represent it.
    await grant(CAREGIVER, ['VIEW_SAFETY']);
    const message = await expectDenied(() => grant(CAREGIVER, ['MANAGE_MEDICINES']));
    expect(message).toMatch(/caregiver_grant_active_unique|duplicate key/i);
  });

  it('allows a fresh grant after the previous one is revoked', async () => {
    // The index is partial on status = 'ACTIVE', so history is preserved rather than blocking
    // re-invitation.
    const first = await grant(CAREGIVER, ['VIEW_SAFETY']);
    await t.asService((db) =>
      db.query(
        `UPDATE caregiver_grant SET status = 'REVOKED', revoked_at = now(), revoked_by_user_id = $1
         WHERE id = $2`,
        [OWNER_A, first],
      ),
    );
    const second = await grant(CAREGIVER, ['VIEW_SHELF']);
    expect(second).not.toBe(first);

    const rows = await t.asService((db) =>
      db.query<{ status: string }>('SELECT status FROM caregiver_grant ORDER BY created_at'),
    );
    expect(rows.rows.map((r) => r.status)).toEqual(['REVOKED', 'ACTIVE']);
  });

  it('allows the same caregiver an active grant on two different profiles', async () => {
    await grant(CAREGIVER, ['VIEW_SAFETY'], PROFILE_A);
    await grant(CAREGIVER, ['VIEW_SAFETY'], PROFILE_B);
    const rows = await t.asService((db) => db.query('SELECT id FROM caregiver_grant'));
    expect(rows.rows).toHaveLength(2);
  });

  it('revokes access on the next access check, not on the next sync', async () => {
    // Spec 15 A2. `has_capability` re-evaluates status and revocation per call, so a client that
    // cached "I am a caregiver" gains nothing.
    const id = await grant(CAREGIVER, ['VIEW_SAFETY']);
    const before = await t.asUser(CAREGIVER, (db) =>
      db.query<{ ok: boolean }>('SELECT kynviora.has_capability($1, $2) AS ok', [
        PROFILE_A,
        'VIEW_SAFETY',
      ]),
    );
    expect(before.rows[0]?.ok).toBe(true);

    await t.asService((db) =>
      db.query(
        `UPDATE caregiver_grant SET status = 'REVOKED', revoked_at = now(), revoked_by_user_id = $1
         WHERE id = $2`,
        [OWNER_A, id],
      ),
    );

    const after = await t.asUser(CAREGIVER, (db) =>
      db.query<{ ok: boolean }>('SELECT kynviora.has_capability($1, $2) AS ok', [
        PROFILE_A,
        'VIEW_SAFETY',
      ]),
    );
    expect(after.rows[0]?.ok).toBe(false);
  });
});

describe('grant linkage and idempotency', () => {
  it('links a grant back to the invitation that created it', async () => {
    const invitationId = await invite();
    const grantId = await t.asService(async (db) => {
      const res = await db.query<{ id: string }>(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at,
            invitation_id)
         VALUES ($1, $2, $3, $4, 'ACTIVE', now(), $5)
         RETURNING id`,
        [PROFILE_A, CAREGIVER, OWNER_A, ['VIEW_SAFETY'], invitationId],
      );
      return res.rows[0]!.id;
    });

    await t.asService((db) =>
      db.query(
        `UPDATE caregiver_invitation
         SET status = 'ACCEPTED', accepted_at = now(), accepted_by_user_id = $1,
             accepted_grant_id = $2
         WHERE id = $3`,
        [CAREGIVER, grantId, invitationId],
      ),
    );

    const res = await t.asUser(OWNER_A, (db) =>
      db.query<{ invitation_id: string | null }>(
        'SELECT invitation_id FROM caregiver_grant WHERE id = $1',
        [grantId],
      ),
    );
    expect(res.rows[0]?.invitation_id).toBe(invitationId);
  });

  it('refuses a second grant reusing an idempotency key', async () => {
    const operationId = testUuid(901);
    await t.asService((db) =>
      db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at,
            client_operation_id)
         VALUES ($1, $2, $3, $4, 'ACTIVE', now(), $5)`,
        [PROFILE_A, CAREGIVER, OWNER_A, ['VIEW_SAFETY'], operationId],
      ),
    );

    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO caregiver_grant
             (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at,
              client_operation_id)
           VALUES ($1, $2, $3, $4, 'ACTIVE', now(), $5)`,
          [PROFILE_B, CAREGIVER, OWNER_B, ['VIEW_SAFETY'], operationId],
        ),
      ),
    );
    expect(message).toMatch(/caregiver_grant_operation_idx|duplicate key/i);
  });
});
