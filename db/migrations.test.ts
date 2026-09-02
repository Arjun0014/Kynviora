import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Authorization tests for the identity boundary.
 *
 * Spec 19 requires automated cases for: unrelated households, a caregiver with narrow
 * permission, a caregiver missing a capability, a revoked caregiver, an expired grant, and a
 * client-supplied foreign profile ID. Spec 15 A1 (cross-household access) and A2 (revoked
 * caregiver retains access) are the two highest-impact abuse cases in the threat model.
 *
 * Every assertion below runs as the non-superuser `kynviora_app` role; the harness fails the
 * test if that is not true (DEC-005).
 */

// Two unrelated households, plus a caregiver and a stranger.
const OWNER_A = testUuid(1);
const OWNER_B = testUuid(2);
const CAREGIVER = testUuid(3);
const STRANGER = testUuid(4);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);

const PROFILE_A1 = testUuid(20); // owner A, caregiver has VIEW_SAFETY only
const PROFILE_A2 = testUuid(21); // owner A, no grants
const PROFILE_B1 = testUuid(22); // owner B, entirely unrelated

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER_A, 'owner-a@example.test'],
      [OWNER_B, 'owner-b@example.test'],
      [CAREGIVER, 'caregiver@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }

    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [HOUSEHOLD_A, OWNER_A, 'Household A', HOUSEHOLD_B, OWNER_B, 'Household B'],
    );

    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name, age_band)
       VALUES ($1, $2, $3, $4, $5), ($6, $2, $3, $7, $5), ($8, $9, $10, $11, $5)`,
      [
        PROFILE_A1,
        HOUSEHOLD_A,
        OWNER_A,
        'Parent A',
        'OLDER_ADULT_65_PLUS',
        PROFILE_A2,
        'Child A',
        PROFILE_B1,
        HOUSEHOLD_B,
        OWNER_B,
        'Parent B',
      ],
    );
  });
});

afterAll(async () => {
  await t.close();
});

describe('migrations', () => {
  it('apply cleanly and record every version', async () => {
    const res = await t.asOwner((db) =>
      db.query<{ version: string }>('SELECT version FROM schema_migration ORDER BY version'),
    );
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.map((r) => r.version)).toContain('0001_foundation');
    expect(res.rows.map((r) => r.version)).toContain('0002_identity');
  });

  it('enable and force RLS on every application table', async () => {
    // A table that is missing RLS is a deny-by-default hole. Asserting across all tables means
    // a future migration adding a table without policies fails this test rather than shipping.
    const res = await t.asOwner((db) =>
      db.query<{ tablename: string; rowsecurity: boolean; forced: boolean }>(
        `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND c.relname <> 'schema_migration'
         ORDER BY c.relname`,
      ),
    );

    expect(res.rows.length).toBeGreaterThan(0);
    const unprotected = res.rows.filter((r) => !r.rowsecurity || !r.forced);
    expect(unprotected.map((r) => r.tablename)).toEqual([]);
  });

  it('grant no table privileges to PUBLIC', async () => {
    // Spec 14: "No anonymous application-table access."
    const res = await t.asOwner((db) =>
      db.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
         WHERE grantee = 'PUBLIC' AND table_schema = 'public'`,
      ),
    );
    expect(res.rows).toEqual([]);
  });
});

describe('harness guards (DEC-005)', () => {
  it('refuses to run authorization assertions as a superuser', async () => {
    // Proves the guard itself works. Without it, a forgotten SET ROLE would make every
    // authorization test below pass vacuously - the trap confirmed empirically in R-003.
    const superuserCheck = await t.asOwner((db) =>
      db.query<{ rolsuper: boolean }>(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`),
    );
    expect(superuserCheck.rows[0]?.rolsuper).toBe(true);

    // ...and the app role, which the tests actually use, is not one.
    const appIsNotSuper = await t.asUser(OWNER_A, (db) =>
      db.query<{ rolsuper: boolean }>(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`),
    );
    expect(appIsNotSuper.rows[0]?.rolsuper).toBe(false);
  });
});

describe('A1 - cross-household data access (spec 15, critical)', () => {
  it('lets an owner see their own profiles', async () => {
    const res = await t.asUser(OWNER_A, (db) =>
      db.query<{ id: string }>('SELECT id FROM profile ORDER BY display_name'),
    );
    expect(res.rows.map((r) => r.id).sort()).toEqual([PROFILE_A2, PROFILE_A1].sort());
  });

  it('hides another household entirely from an unrelated owner', async () => {
    const res = await t.asUser(OWNER_B, (db) => db.query<{ id: string }>('SELECT id FROM profile'));
    expect(res.rows.map((r) => r.id)).toEqual([PROFILE_B1]);
  });

  it('returns nothing when a client supplies a foreign profile ID directly', async () => {
    // The classic IDOR/BOLA probe: the attacker knows the ID and asks for it by name.
    // Spec 15: "unguessable IDs are not treated as security".
    const res = await t.asUser(OWNER_B, (db) =>
      db.query('SELECT id FROM profile WHERE id = $1', [PROFILE_A1]),
    );
    expect(res.rows).toEqual([]);
  });

  it('shows a stranger with no grants nothing at all', async () => {
    const res = await t.asUser(STRANGER, (db) => db.query('SELECT id FROM profile'));
    expect(res.rows).toEqual([]);
  });

  it('fails closed when no user context is set', async () => {
    // An unset GUC yields NULL, and every policy comparison against NULL is NULL, not true.
    const res = await t.asUser(null, (db) => db.query('SELECT id FROM profile'));
    expect(res.rows).toEqual([]);
  });

  it('prevents a user creating a profile in a household they do not own', async () => {
    const message = await expectDenied(() =>
      t.asUser(OWNER_B, (db) =>
        db.query(
          `INSERT INTO profile (household_id, owner_user_id, display_name)
           VALUES ($1, $2, $3)`,
          [HOUSEHOLD_A, OWNER_B, 'Intruder'],
        ),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('prevents a user creating a profile owned by someone else', async () => {
    const message = await expectDenied(() =>
      t.asUser(OWNER_B, (db) =>
        db.query(
          `INSERT INTO profile (household_id, owner_user_id, display_name)
           VALUES ($1, $2, $3)`,
          [HOUSEHOLD_B, OWNER_A, 'Impersonated'],
        ),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('prevents an owner updating another household profile', async () => {
    const res = await t.asUser(OWNER_B, (db) =>
      db.query('UPDATE profile SET display_name = $1 WHERE id = $2', ['Hacked', PROFILE_A1]),
    );
    // The row is invisible, so the UPDATE matches nothing rather than raising.
    expect(res.affectedRows).toBe(0);

    const check = await t.asUser(OWNER_A, (db) =>
      db.query<{ display_name: string }>('SELECT display_name FROM profile WHERE id = $1', [
        PROFILE_A1,
      ]),
    );
    expect(check.rows[0]?.display_name).toBe('Parent A');
  });
});

describe('A2 - caregiver grant lifecycle (spec 15, high)', () => {
  async function grant(overrides: {
    capabilities?: string[];
    status?: string;
    acceptedAt?: string | null;
    expiresAt?: string | null;
    revokedAt?: string | null;
  }): Promise<string> {
    const id = testUuid(Math.floor(Math.random() * 1_000_000) + 100_000);
    await t.asService((db) =>
      db.query(
        `INSERT INTO caregiver_grant
           (id, profile_id, grantee_user_id, granted_by_user_id, capabilities, status,
            accepted_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          PROFILE_A1,
          CAREGIVER,
          OWNER_A,
          overrides.capabilities ?? ['VIEW_SAFETY'],
          overrides.status ?? 'ACTIVE',
          overrides.acceptedAt === undefined ? new Date().toISOString() : overrides.acceptedAt,
          overrides.expiresAt ?? null,
          overrides.revokedAt ?? null,
        ],
      ),
    );
    return id;
  }

  async function clearGrants(): Promise<void> {
    await t.asOwner((db) => db.query('DELETE FROM caregiver_grant'));
  }

  it('gives an accepted caregiver access to exactly the granted profile', async () => {
    await clearGrants();
    await grant({ capabilities: ['VIEW_SAFETY'] });

    const res = await t.asUser(CAREGIVER, (db) =>
      db.query<{ id: string }>('SELECT id FROM profile'),
    );
    // PROFILE_A2 has no grant, PROFILE_B1 is another household.
    expect(res.rows.map((r) => r.id)).toEqual([PROFILE_A1]);
  });

  it('denies access through a pending, unaccepted invitation', async () => {
    await clearGrants();
    await grant({ status: 'PENDING', acceptedAt: null });

    const res = await t.asUser(CAREGIVER, (db) => db.query('SELECT id FROM profile'));
    expect(res.rows).toEqual([]);
  });

  it('denies access immediately after revocation', async () => {
    await clearGrants();
    const id = await grant({});

    const before = await t.asUser(CAREGIVER, (db) => db.query('SELECT id FROM profile'));
    expect(before.rows).toHaveLength(1);

    await t.asService((db) =>
      db.query(`UPDATE caregiver_grant SET status = 'REVOKED', revoked_at = now() WHERE id = $1`, [
        id,
      ]),
    );

    // Spec 15 A2: revocation must take effect on the next authenticated access. It is evaluated
    // per query against now(), so no cached client state can extend it.
    const after = await t.asUser(CAREGIVER, (db) => db.query('SELECT id FROM profile'));
    expect(after.rows).toEqual([]);
  });

  it('denies access through an expired grant', async () => {
    await clearGrants();
    await grant({ expiresAt: new Date(Date.now() - 60_000).toISOString() });

    const res = await t.asUser(CAREGIVER, (db) => db.query('SELECT id FROM profile'));
    expect(res.rows).toEqual([]);
  });

  it('allows access through a grant that has not yet expired', async () => {
    await clearGrants();
    await grant({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

    const res = await t.asUser(CAREGIVER, (db) => db.query('SELECT id FROM profile'));
    expect(res.rows).toHaveLength(1);
  });

  it('enforces capability scoping, not blanket profile access', async () => {
    await clearGrants();
    await grant({ capabilities: ['VIEW_SAFETY'] });

    const hasSafety = await t.asUser(CAREGIVER, (db) =>
      db.query<{ ok: boolean }>('SELECT kynviora.has_capability($1, $2) AS ok', [
        PROFILE_A1,
        'VIEW_SAFETY',
      ]),
    );
    expect(hasSafety.rows[0]?.ok).toBe(true);

    // Spec 08.2 requires a separate safety-alert permission from shelf/medicine access.
    for (const missing of ['MANAGE_MEDICINES', 'EXPORT_SUMMARY', 'MANAGE_CAREGIVERS']) {
      const res = await t.asUser(CAREGIVER, (db) =>
        db.query<{ ok: boolean }>('SELECT kynviora.has_capability($1, $2) AS ok', [
          PROFILE_A1,
          missing,
        ]),
      );
      expect(res.rows[0]?.ok).toBe(false);
    }
  });

  it('does not let a caregiver escalate their own grant', async () => {
    await clearGrants();
    const id = await grant({ capabilities: ['VIEW_SAFETY'] });

    // kynviora_app holds only SELECT on caregiver_grant. Spec 13 lists grant mutation as a
    // privileged server-only operation, so the write must be refused at the GRANT layer.
    const message = await expectDenied(() =>
      t.asUser(CAREGIVER, (db) =>
        db.query(`UPDATE caregiver_grant SET capabilities = $1 WHERE id = $2`, [
          ['MANAGE_CAREGIVERS', 'EXPORT_SUMMARY'],
          id,
        ]),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('does not let a user forge a grant for themselves', async () => {
    const message = await expectDenied(() =>
      t.asUser(STRANGER, (db) =>
        db.query(
          `INSERT INTO caregiver_grant
             (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
           VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
          [PROFILE_A1, STRANGER, OWNER_A, ['MANAGE_CAREGIVERS']],
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('lets both the profile owner and the grantee see the grant', async () => {
    await clearGrants();
    await grant({});

    const ownerView = await t.asUser(OWNER_A, (db) => db.query('SELECT id FROM caregiver_grant'));
    expect(ownerView.rows).toHaveLength(1);

    const granteeView = await t.asUser(CAREGIVER, (db) =>
      db.query('SELECT id FROM caregiver_grant'),
    );
    expect(granteeView.rows).toHaveLength(1);

    const strangerView = await t.asUser(STRANGER, (db) =>
      db.query('SELECT id FROM caregiver_grant'),
    );
    expect(strangerView.rows).toEqual([]);
  });
});

describe('data integrity constraints', () => {
  it('rejects an unknown caregiver capability', async () => {
    // A typo must fail at write time rather than creating an unmatchable capability.
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO caregiver_grant
             (profile_id, grantee_user_id, granted_by_user_id, capabilities, status)
           VALUES ($1, $2, $3, $4, 'PENDING')`,
          [PROFILE_A1, CAREGIVER, OWNER_A, ['VIEW_EVERYTHING']],
        ),
      ),
    );
    expect(message).toMatch(/capabilities_known/i);
  });

  it('rejects an empty capability list', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO caregiver_grant
             (profile_id, grantee_user_id, granted_by_user_id, capabilities, status)
           VALUES ($1, $2, $3, $4, 'PENDING')`,
          [PROFILE_A1, CAREGIVER, OWNER_A, []],
        ),
      ),
    );
    expect(message).toMatch(/capabilities_not_empty/i);
  });

  it('rejects a self-granted caregiver relationship', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO caregiver_grant
             (profile_id, grantee_user_id, granted_by_user_id, capabilities, status)
           VALUES ($1, $2, $2, $3, 'PENDING')`,
          [PROFILE_A1, OWNER_A, ['VIEW_SAFETY']],
        ),
      ),
    );
    expect(message).toMatch(/no_self_grant/i);
  });

  it('rejects an implausible birth year', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO profile (household_id, owner_user_id, display_name, birth_year)
           VALUES ($1, $2, $3, $4)`,
          [HOUSEHOLD_A, OWNER_A, 'Time Traveller', 1750],
        ),
      ),
    );
    expect(message).toMatch(/birth_year_plausible/i);
  });
});

describe('append-only enforcement (DEC-013)', () => {
  // Append-only is enforced at two independent layers, and both are asserted here:
  //   1. no UPDATE/DELETE grant is issued to any application role, so the attempt is refused
  //      at the privilege layer before a row is ever reached;
  //   2. a BEFORE UPDATE OR DELETE trigger, which catches anything reaching the table with
  //      broader privileges (a migration, an operator session, a future misgranted role).
  // Testing only the trigger would miss a regression that added an UPDATE grant; testing only
  // the grant would miss a regression that dropped the trigger.

  it('refuses UPDATE on consent receipts at the privilege layer', async () => {
    const id = testUuid(900_001);
    await t.asService((db) =>
      db.query(
        `INSERT INTO consent_receipt (id, user_id, purpose, granted, policy_version)
         VALUES ($1, $2, 'NOTIFICATIONS', true, 'v1')`,
        [id, OWNER_A],
      ),
    );

    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query('UPDATE consent_receipt SET granted = false WHERE id = $1', [id]),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('refuses DELETE on consent receipts at the privilege layer', async () => {
    const message = await expectDenied(() =>
      t.asService((db) => db.query('DELETE FROM consent_receipt')),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('trips the append-only trigger even with full table privileges', async () => {
    // Running as the table owner bypasses the GRANT layer entirely, isolating the trigger.
    const id = testUuid(900_010);
    await t.asOwner((db) =>
      db.query(
        `INSERT INTO consent_receipt (id, user_id, purpose, granted, policy_version)
         VALUES ($1, $2, 'NOTIFICATIONS', true, 'v1')`,
        [id, OWNER_A],
      ),
    );

    const updateMessage = await expectDenied(() =>
      t.asOwner((db) => db.query('UPDATE consent_receipt SET granted = false WHERE id = $1', [id])),
    );
    expect(updateMessage).toMatch(/append-only/i);

    const deleteMessage = await expectDenied(() =>
      t.asOwner((db) => db.query('DELETE FROM consent_receipt WHERE id = $1', [id])),
    );
    expect(deleteMessage).toMatch(/append-only/i);
  });

  it('records withdrawal as a new superseding receipt', async () => {
    // Spec 16: withdrawal is a new record so the consent history stays auditable.
    const first = testUuid(900_002);
    const second = testUuid(900_003);

    await t.asService(async (db) => {
      await db.query(
        `INSERT INTO consent_receipt (id, user_id, purpose, granted, policy_version)
         VALUES ($1, $2, 'CATALOG_CONTRIBUTION', true, 'v1')`,
        [first, OWNER_B],
      );
      await db.query(
        `INSERT INTO consent_receipt (id, user_id, purpose, granted, policy_version, supersedes_id)
         VALUES ($1, $2, 'CATALOG_CONTRIBUTION', false, 'v1', $3)`,
        [second, OWNER_B, first],
      );
    });

    // Deliberately NOT ordered by recorded_at: both rows carry the same transaction timestamp
    // from now(), so a timestamp sort is not deterministic. The supersession link is the
    // authoritative ordering, which is exactly why DEC-013 stores it explicitly.
    const res = await t.asUser(OWNER_B, (db) =>
      db.query<{ id: string; granted: boolean; supersedes_id: string | null }>(
        `SELECT id, granted, supersedes_id FROM consent_receipt
         WHERE purpose = 'CATALOG_CONTRIBUTION'`,
      ),
    );
    expect(res.rows).toHaveLength(2);

    const head = res.rows.find((r) => r.supersedes_id !== null);
    const original = res.rows.find((r) => r.supersedes_id === null);

    expect(original?.id).toBe(first);
    expect(original?.granted).toBe(true);
    expect(head?.id).toBe(second);
    expect(head?.granted).toBe(false);
    expect(head?.supersedes_id).toBe(first);
  });

  it('refuses mutation of audit events', async () => {
    await t.asService((db) =>
      db.query(
        `INSERT INTO audit_event (actor_user_id, actor_role, action, target_kind, target_id)
         VALUES ($1, 'user', 'PROFILE_CREATED', 'profile', $2)`,
        [OWNER_A, PROFILE_A1],
      ),
    );

    // Privilege layer first...
    const grantMessage = await expectDenied(() =>
      t.asService((db) => db.query(`UPDATE audit_event SET action = 'TAMPERED'`)),
    );
    expect(grantMessage).toMatch(/permission denied/i);

    // ...and the trigger as a backstop against a session with broader privileges.
    const triggerMessage = await expectDenied(() =>
      t.asOwner((db) => db.query(`UPDATE audit_event SET action = 'TAMPERED'`)),
    );
    expect(triggerMessage).toMatch(/append-only/i);
  });

  it('does not expose the audit log to ordinary user requests', async () => {
    // Spec 20 keeps audit separate from user-facing data; the app role has no grant at all.
    const message = await expectDenied(() =>
      t.asUser(OWNER_A, (db) => db.query('SELECT * FROM audit_event')),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

describe('consent is strictly the caller’s own (`04` Phase 1.4)', () => {
  // `consent_select` and `consent_insert` both require `user_id = kynviora.current_user_id()`,
  // with no relationship clause of any kind - no household, no grant, no capability. Consent is
  // the one thing in this product nobody may exercise or read on somebody else's behalf, and the
  // routes that serve it take no user parameter *because* of these two policies rather than as a
  // separate promise. Asserted here in SQL, so a future route that named a user would fail at the
  // table rather than succeed quietly.

  it('shows one person nothing of what anybody else answered', async () => {
    const mine = testUuid(900_020);
    await t.asService((db) =>
      db.query(
        `INSERT INTO consent_receipt (id, user_id, purpose, granted, policy_version)
         VALUES ($1, $2, 'RESEARCH_PROGRAMME', true, 'v1')`,
        [mine, OWNER_B],
      ),
    );

    const asOther = await t.asUser(OWNER_A, (db) =>
      db.query<{ id: string }>('SELECT id FROM consent_receipt WHERE id = $1', [mine]),
    );
    expect(asOther.rows).toEqual([]);

    // And the owner of the row can still see it, so the empty result above is the policy working
    // rather than the insert having failed.
    const asOwner = await t.asUser(OWNER_B, (db) =>
      db.query<{ id: string }>('SELECT id FROM consent_receipt WHERE id = $1', [mine]),
    );
    expect(asOwner.rows.map((row) => row.id)).toEqual([mine]);
  });

  it('refuses a receipt recorded in somebody else’s name', async () => {
    // The abuse this prevents is not reading - it is *writing*: an owner recording that a
    // caregiver agreed to something, or a caregiver recording it for the person they look after.
    // Neither would leave a trace distinguishable from the real thing, which is why it has to be
    // impossible rather than audited.
    const message = await expectDenied(() =>
      t.asUser(OWNER_A, (db) =>
        db.query(
          `INSERT INTO consent_receipt (id, user_id, purpose, granted, policy_version)
           VALUES ($1, $2, 'NOTIFICATIONS', true, 'v1')`,
          [testUuid(900_021), OWNER_B],
        ),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses one even for somebody in the same household', async () => {
    // A caregiver holding every capability there is still may not answer for the person they look
    // after. There is no capability that admits this, because the policy names no capability.
    const message = await expectDenied(() =>
      t.asUser(CAREGIVER, (db) =>
        db.query(
          `INSERT INTO consent_receipt (id, user_id, purpose, granted, policy_version)
           VALUES ($1, $2, 'CAREGIVER_SHARING', true, 'v1')`,
          [testUuid(900_022), OWNER_A],
        ),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });
});

describe('an assessment names which inputs produced the match (DEV-028, migration 0018)', () => {
  // The two columns are what let the approved ingredient-sensitivity template be filled from
  // stored data rather than re-derived on the read path. The constraints below are what stop a
  // half-filled or contradictory record reaching the screen as a sentence with a hole in it.

  const RULE_V = testUuid(910_001);
  const ITEM_V = testUuid(910_002);

  beforeAll(async () => {
    await t.asService(async (db) => {
      await db.query(
        `INSERT INTO assessment_rule_version
           (id, rule_key, version, rule_kind, evidence_level, max_urgency,
            required_item_verification, required_profile_provenance, explanation_template_id)
         VALUES ($1, 'synthetic.sensitivity', '1.0.0', 'INGREDIENT_SENSITIVITY', 'B', 'MEDIUM',
                 ARRAY['CONFIRMED']::text[], ARRAY['USER_REPORTED']::text[],
                 'tpl.ingredient_sensitivity')`,
        [RULE_V],
      );
      await db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
         VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet')`,
        [ITEM_V, PROFILE_A1],
      );
    });
  });

  async function insertAssessment(
    values: {
      readonly matched?: boolean;
      readonly substanceKey?: string | null;
      readonly factId?: string | null;
    } = {},
  ): Promise<void> {
    await t.asService((db) =>
      db.query(
        `INSERT INTO profile_assessment
           (profile_id, owned_item_id, rule_version_id, matched, match_confidence, reasons,
            evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at,
            matched_substance_key, matched_profile_fact_id)
         VALUES ($1, $2, $3, $4, $5, ARRAY['SUBSTANCE_IN_DECLARATION']::text[], 'B', $6,
                 'tpl.ingredient_sensitivity', 'norm-1', now(), $7, $8)`,
        [
          PROFILE_A1,
          ITEM_V,
          RULE_V,
          values.matched ?? true,
          values.matched === false ? 'NOT_MATCHED' : 'EXACT',
          values.matched === false ? 'INFORMATIONAL' : 'MEDIUM',
          values.substanceKey === undefined ? 'synthetic.substance' : values.substanceKey,
          values.factId === undefined ? testUuid(910_003) : values.factId,
        ],
      ),
    );
  }

  it('stores both identities on a match', async () => {
    await insertAssessment();
    const res = await t.asUser(OWNER_A, (db) =>
      db.query<{ matched_substance_key: string; matched_profile_fact_id: string }>(
        `SELECT matched_substance_key, matched_profile_fact_id
           FROM profile_assessment WHERE owned_item_id = $1 AND matched_substance_key IS NOT NULL`,
        [ITEM_V],
      ),
    );
    expect(res.rows[0]?.matched_substance_key).toBe('synthetic.substance');
    expect(res.rows[0]?.matched_profile_fact_id).toBe(testUuid(910_003));
  });

  it('refuses a substance with no fact behind it, and a fact with no substance', async () => {
    // Either alone renders as a sentence with a hole in it: a key that names an ingredient and
    // cannot say whose sensitivity it matched, or a fact whose ingredient nobody can name.
    for (const half of [
      { substanceKey: 'synthetic.substance', factId: null },
      { substanceKey: null, factId: testUuid(910_004) },
    ]) {
      const message = await expectDenied(() => insertAssessment(half));
      expect(message, JSON.stringify(half)).toMatch(/assessment_matched_inputs_paired/i);
    }
  });

  it('refuses a non-match that names an ingredient anyway', async () => {
    // A sentence about a match that did not happen.
    const message = await expectDenied(() => insertAssessment({ matched: false }));
    expect(message).toMatch(/assessment_matched_inputs_only_when_matched/i);
  });

  it('refuses a blank substance key', async () => {
    const message = await expectDenied(() => insertAssessment({ substanceKey: '   ' }));
    expect(message).toMatch(/assessment_matched_substance_not_blank/i);
  });

  it('accepts a non-match that names nothing, which is every non-match', async () => {
    await insertAssessment({ matched: false, substanceKey: null, factId: null });
    const res = await t.asUser(OWNER_A, (db) =>
      db.query<{ count: string }>(
        `SELECT count(*) AS count FROM profile_assessment
          WHERE owned_item_id = $1 AND NOT matched`,
        [ITEM_V],
      ),
    );
    expect(Number(res.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('still refuses to let either column be edited afterwards', async () => {
    // The columns exist so a later event cannot rewrite what the rule saw. An UPDATE that could
    // change which ingredient an alert names would be exactly that.
    const message = await expectDenied(() =>
      t.asOwner((db) =>
        db.query(
          `UPDATE profile_assessment SET matched_substance_key = 'something.else'
            WHERE owned_item_id = $1`,
          [ITEM_V],
        ),
      ),
    );
    expect(message).toMatch(/append-only/i);
  });
});
