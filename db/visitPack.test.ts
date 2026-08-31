import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Database-level tests for the Visit Pack (migration `0008`).
 *
 * Spec 16 requires exports to expire, to be auditable, and not to duplicate sensitive content;
 * spec 13 makes export generation a privileged server-only operation; spec 03 group H requires
 * exports to be a permission separate from viewing the shelf or the medicines.
 *
 * Every assertion runs as the non-superuser `kynviora_app` or `kynviora_service` role (DEC-005).
 */

const OWNER = testUuid(1);
const OTHER_OWNER = testUuid(2);
const CAREGIVER = testUuid(3);
const EXPORT_CAREGIVER = testUuid(4);
const STRANGER = testUuid(5);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);
const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

const DIGEST = 'a'.repeat(64);
const FUTURE = '2099-01-01T00:00:00.000Z';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER_OWNER, 'other@example.test'],
      [CAREGIVER, 'caregiver@example.test'],
      [EXPORT_CAREGIVER, 'exporter@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`,
      [HOUSEHOLD_A, OWNER, HOUSEHOLD_B, OTHER_OWNER],
    );
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent A'), ($4, $5, $6, 'Parent B')`,
      [PROFILE_A, HOUSEHOLD_A, OWNER, PROFILE_B, HOUSEHOLD_B, OTHER_OWNER],
    );
  });
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM visit_pack');
    await db.query('DELETE FROM caregiver_grant');
  });
});

const MANIFEST = JSON.stringify([
  { section: 'CURRENT_MEDICINES', entityKind: 'owned_item', entityId: testUuid(30), version: 1 },
]);

async function pack(
  overrides: {
    profileId?: string;
    createdBy?: string;
    manifest?: string;
    digest?: string;
    notes?: string[];
    expiresAt?: string;
    operationId?: string | null;
  } = {},
): Promise<string> {
  const res = await t.asService((db) =>
    db.query<{ id: string }>(
      `INSERT INTO visit_pack
         (profile_id, created_by_user_id, manifest, content_digest, notes, expires_at,
          client_operation_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       RETURNING id`,
      [
        overrides.profileId ?? PROFILE_A,
        overrides.createdBy ?? OWNER,
        overrides.manifest ?? MANIFEST,
        overrides.digest ?? DIGEST,
        overrides.notes ?? [],
        overrides.expiresAt ?? FUTURE,
        overrides.operationId ?? null,
      ],
    ),
  );
  return res.rows[0]!.id;
}

async function grant(userId: string, capabilities: string[]): Promise<void> {
  await t.asService((db) =>
    db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
      [PROFILE_A, userId, OWNER, capabilities],
    ),
  );
}

// ---------------------------------------------------------------------------

describe('visit_pack schema', () => {
  it('has row-level security enabled and forced', async () => {
    const res = await t.asOwner((db) =>
      db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'visit_pack'`,
      ),
    );
    expect(res.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('gives the app role read access only', async () => {
    // Spec 13: export generation is a privileged server-only operation, and spec 16 requires
    // re-authentication first - which the database cannot check, so the write path must go
    // through the service role where the API has already established it.
    const res = await t.asOwner((db) =>
      db.query<{ privilege_type: string }>(
        `SELECT DISTINCT privilege_type FROM information_schema.table_privileges
         WHERE table_name = 'visit_pack' AND grantee = 'kynviora_app'`,
      ),
    );
    expect(res.rows.map((r) => r.privilege_type).sort()).toEqual(['SELECT']);
  });

  it('does not let an app-role user create or alter a pack', async () => {
    const id = await pack();

    const inserted = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `INSERT INTO visit_pack
             (profile_id, created_by_user_id, manifest, content_digest, expires_at)
           VALUES ($1, $2, $3::jsonb, $4, $5)`,
          [PROFILE_A, OWNER, MANIFEST, DIGEST, FUTURE],
        ),
      ),
    );
    expect(inserted).toMatch(/permission denied/i);

    // Extending your own export past its expiry would defeat the retention limit in spec 16.
    const updated = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(`UPDATE visit_pack SET expires_at = $1 WHERE id = $2`, [FUTURE, id]),
      ),
    );
    expect(updated).toMatch(/permission denied/i);
  });
});

describe('integrity constraints', () => {
  it('requires an expiry after generation', async () => {
    // Spec 16: temporary export objects expire. A pack with no future would be a permanent
    // shareable view of someone medicines.
    const message = await expectDenied(() => pack({ expiresAt: '2020-01-01T00:00:00.000Z' }));
    expect(message).toMatch(/visit_pack_expiry_after_generation/);
  });

  it('refuses a pack that contains nothing', async () => {
    // Phase 8.4: export never happens automatically. An empty pack would mean the export path is
    // reachable without the user having chosen anything.
    const message = await expectDenied(() => pack({ manifest: '[]', notes: [] }));
    expect(message).toMatch(/visit_pack_not_empty/);
  });

  it('accepts a pack of notes with no selected records', async () => {
    // The other side of the same constraint: questions alone are a legitimate handoff.
    const id = await pack({ manifest: '[]', notes: ['Is the dose still right?'] });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a manifest that is not an array', async () => {
    const message = await expectDenied(() => pack({ manifest: '{"selected":"all"}' }));
    expect(message).toMatch(/visit_pack_manifest_is_array|visit_pack_not_empty/);
  });

  it('refuses a digest that is not 64 lowercase hex characters', async () => {
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'not-a-digest', '']) {
      const message = await expectDenied(() => pack({ digest: bad }));
      expect(message).toMatch(/visit_pack_digest_shape/);
    }
  });

  it('refuses a second pack reusing an idempotency key', async () => {
    const operationId = testUuid(900);
    await pack({ operationId });
    const message = await expectDenied(() => pack({ operationId }));
    expect(message).toMatch(/visit_pack_operation_idx|duplicate key/i);
  });

  it('refuses a revocation with no recorded revoker', async () => {
    const id = await pack();
    const message = await expectDenied(() =>
      t.asService((db) => db.query('UPDATE visit_pack SET revoked_at = now() WHERE id = $1', [id])),
    );
    expect(message).toMatch(/visit_pack_revoked_complete/);
  });
});

describe('visibility (RLS)', () => {
  it('shows a pack to the profile owner', async () => {
    await pack();
    const res = await t.asUser(OWNER, (db) => db.query('SELECT id FROM visit_pack'));
    expect(res.rows).toHaveLength(1);
  });

  it('shows a pack to whoever created it', async () => {
    // A caregiver who generated a pack can still open it, even if their grant later narrows.
    await grant(EXPORT_CAREGIVER, ['EXPORT_SUMMARY']);
    await pack({ createdBy: EXPORT_CAREGIVER });
    await t.asOwner((db) => db.query('DELETE FROM caregiver_grant'));

    const res = await t.asUser(EXPORT_CAREGIVER, (db) => db.query('SELECT id FROM visit_pack'));
    expect(res.rows).toHaveLength(1);
  });

  it('shows a pack to a caregiver holding EXPORT_SUMMARY', async () => {
    await grant(EXPORT_CAREGIVER, ['EXPORT_SUMMARY']);
    await pack();
    const res = await t.asUser(EXPORT_CAREGIVER, (db) => db.query('SELECT id FROM visit_pack'));
    expect(res.rows).toHaveLength(1);
  });

  it('hides a pack from a caregiver who can read the medicines but not export', async () => {
    // Spec 03 group H requires a separate permission for exports. Being able to read the
    // medicines is not being able to see what was shared with a clinician.
    await grant(CAREGIVER, ['VIEW_MEDICINES', 'VIEW_SHELF', 'VIEW_SAFETY']);
    await pack();
    const res = await t.asUser(CAREGIVER, (db) => db.query('SELECT id FROM visit_pack'));
    expect(res.rows).toEqual([]);
  });

  it('loses visibility as soon as the EXPORT_SUMMARY grant is revoked', async () => {
    // Spec 15 A2, applied to exports: the policy re-evaluates the grant on every access.
    await grant(EXPORT_CAREGIVER, ['EXPORT_SUMMARY']);
    await pack();

    const before = await t.asUser(EXPORT_CAREGIVER, (db) => db.query('SELECT id FROM visit_pack'));
    expect(before.rows).toHaveLength(1);

    await t.asService((db) =>
      db.query(
        `UPDATE caregiver_grant SET status = 'REVOKED', revoked_at = now(), revoked_by_user_id = $1
         WHERE grantee_user_id = $2`,
        [OWNER, EXPORT_CAREGIVER],
      ),
    );

    const after = await t.asUser(EXPORT_CAREGIVER, (db) => db.query('SELECT id FROM visit_pack'));
    expect(after.rows).toEqual([]);
  });

  it('hides another household entirely', async () => {
    await pack({ profileId: PROFILE_B, createdBy: OTHER_OWNER });
    for (const user of [OWNER, CAREGIVER, STRANGER]) {
      const res = await t.asUser(user, (db) => db.query('SELECT id FROM visit_pack'));
      expect(res.rows).toEqual([]);
    }
  });

  it('fails closed when no user context is set', async () => {
    await pack();
    const res = await t.asUser(null, (db) => db.query('SELECT id FROM visit_pack'));
    expect(res.rows).toEqual([]);
  });
});

describe('what is stored', () => {
  it('keeps IDs and versions in the manifest, never content', async () => {
    // DEC-022. A stored copy would outlive the user correcting or deleting the original, and
    // would be a second store of exactly the data spec 16 classifies as most sensitive.
    const id = await pack();
    const res = await t.asUser(OWNER, (db) =>
      db.query<{ manifest: { entityId: string; version: number }[] }>(
        'SELECT manifest FROM visit_pack WHERE id = $1',
        [id],
      ),
    );
    const manifest = res.rows[0]?.manifest ?? [];
    expect(manifest).toHaveLength(1);
    for (const entry of manifest) {
      expect(Object.keys(entry).sort()).toEqual(['entityId', 'entityKind', 'section', 'version']);
    }
  });
});
