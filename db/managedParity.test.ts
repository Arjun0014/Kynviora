import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createManagedRuntimeDb,
  loadMigrations,
  APP_ROLE,
  SERVICE_ROLE,
  RETENTION_ROLE,
  readManagedDatabaseUrl,
  readMigrateDatabaseUrl,
  withManagedClient,
  type ManagedRuntimeDb,
  type RuntimeConnection,
} from './src/index.js';
import { PURGE_CATEGORY_NAMES } from './src/retention.js';
import { CHANNEL_REASONS, DELIVERY_CHANNELS, REVALIDATION_OUTCOMES } from '@kynviora/domain';
import { RETENTION_RUN_OUTCOMES } from '@kynviora/worker';

/**
 * The suite that runs against a **managed** Postgres, and only there.
 *
 * Spec references: `13`, `14` (deny by default, least privilege, RLS on every application table
 * with negative cases), `19` (release-gating authorization tests), `21` (environments),
 * `BLK-001`, DEC-005, DEC-037.
 *
 * WHAT THIS ADDS THAT 4,573 PASSING TESTS DID NOT
 * Every other database test here runs against PGlite, which is genuine PostgreSQL compiled to
 * WASM. That validates schema, constraints, triggers and policy logic, and `BLK-001` has always
 * said plainly what it does not validate: managed-platform behaviour. Three things exist only on
 * a platform.
 *
 * **1. Other roles exist.** PGlite has `postgres` and whatever the migrations create. A Supabase
 * project also has `anon`, `authenticated`, `service_role` and a PostgREST process that serves
 * any table those roles can reach. Supabase additionally ships default privileges granting `anon`
 * **all** privileges on every table created in `public` **by `postgres`** - so applying these
 * migrations with the platform's own credential would publish fifty-seven health tables to the
 * anonymous API key. Deny-by-default RLS would still refuse the rows; the bookkeeping table has
 * no RLS to refuse with. That is why the migration credential is a role of Kynviora's own, and
 * why the assertion below is about the outcome rather than the intent.
 *
 * **2. A role can be given BYPASSRLS.** One statement, invisible in every policy, and it makes
 * every negative authorization test in this repository pass while asserting nothing. Supabase
 * grants it to `postgres` by default, so this is not hypothetical.
 *
 * **3. Connections are pooled and reused.** Identity here is a session GUC and privilege is a
 * session role, so a connection returned to the pool carrying either hands the next request
 * somebody else's household. Nothing in a single-connection engine can fail that way, so nothing
 * in a single-connection engine can test it.
 *
 * WHY IT SKIPS WITHOUT A DATABASE
 * `npm run verify` has to pass on a machine with no managed Postgres, which is every machine this
 * project ran on before 2026-09-05. The guard is on the whole file, so there is no half-run.
 *
 * WHY THE FIXTURE IS FIXED RATHER THAN CLEANED UP
 * This is the one suite that does not get a fresh database, and it deliberately has **no
 * privileged teardown**. Nothing reachable from the runtime credential can delete these rows:
 * `kynviora_service` holds no `DELETE` on any of them (DEC-117 - removal is revocation then
 * purge, and only `kynviora_retention` deletes), and the retention policies admit only rows past
 * a thirty-day deadline. The available ways to clean up are all worse than not doing it - a
 * `BYPASSRLS` role for tests, a temporary `NO FORCE`, or the platform's own superuser-adjacent
 * credential - and each would weaken the exact boundary this file exists to prove.
 *
 * So the fixture is **idempotent instead**: fixed IDs in a namespace nothing else uses, inserted
 * with `ON CONFLICT DO NOTHING`. A second run reuses the first run's household rather than adding
 * one, so nothing accumulates. What is left behind is one synthetic household in a development
 * project, which is what `npm run dev` already seeds.
 */

const MANAGED_URL = readManagedDatabaseUrl();
const MIGRATE_URL = readMigrateDatabaseUrl();
const runIfManaged = MANAGED_URL === null ? describe.skip : describe;
const runIfMigrator = MIGRATE_URL === null ? describe.skip : describe;

/**
 * Fixture IDs, in their own namespace.
 *
 * Variant nibble `9` rather than the harness's `8`, so a parity fixture and a PGlite fixture can
 * never be the same UUID even by accident - which matters precisely because this database is not
 * thrown away between runs.
 */
function parityUuid(n: number): string {
  return `00000000-0000-4000-9000-${n.toString(16).padStart(12, '0')}`;
}

const OWNER = parityUuid(1);
const SHELF_CAREGIVER = parityUuid(2);
const REVOKED_CAREGIVER = parityUuid(3);
const STRANGER = parityUuid(4);
const HOUSEHOLD = parityUuid(10);
const PROFILE = parityUuid(20);
const SHAMPOO = parityUuid(30);
const MEDICINE = parityUuid(31);
const SHELF_GRANT = parityUuid(40);
const REVOKED_GRANT = parityUuid(41);

let db: ManagedRuntimeDb;

/** Every application table, i.e. everything but the migration bookkeeping. */
const APPLICATION_TABLES = `c.relkind = 'r' AND c.relname <> 'schema_migration'`;

async function expectDenied(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(
    'Expected the operation to be denied by authorization, but it succeeded. ' +
      'This is a deny-by-default failure (spec 14).',
  );
}

beforeAll(async () => {
  if (MANAGED_URL === null) return;
  db = await createManagedRuntimeDb({
    connectionString: MANAGED_URL,
    applicationName: 'kynviora-parity',
  });

  await db.withService(async (conn) => {
    for (const [id, email] of [
      [OWNER, 'parity-owner@example.test'],
      [SHELF_CAREGIVER, 'parity-shelf@example.test'],
      [REVOKED_CAREGIVER, 'parity-revoked@example.test'],
      [STRANGER, 'parity-stranger@example.test'],
    ] as const) {
      await conn.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
        [id, `auth|${id}`, email],
      );
    }
    await conn.query(
      `INSERT INTO household (id, owner_user_id, display_name)
       VALUES ($1, $2, 'Parity household') ON CONFLICT (id) DO NOTHING`,
      [HOUSEHOLD, OWNER],
    );
    await conn.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parity parent (synthetic)') ON CONFLICT (id) DO NOTHING`,
      [PROFILE, HOUSEHOLD, OWNER],
    );
    await conn.query(
      `INSERT INTO caregiver_grant
         (id, profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4, ARRAY['VIEW_SHELF']::text[], 'ACTIVE', now())
       ON CONFLICT (id) DO NOTHING`,
      [SHELF_GRANT, PROFILE, SHELF_CAREGIVER, OWNER],
    );
    await conn.query(
      `INSERT INTO caregiver_grant
         (id, profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at,
          revoked_at, revoked_by_user_id)
       VALUES ($1, $2, $3, $4, ARRAY['VIEW_SHELF','VIEW_MEDICINES']::text[], 'REVOKED', now(),
               now(), $4)
       ON CONFLICT (id) DO NOTHING`,
      [REVOKED_GRANT, PROFILE, REVOKED_CAREGIVER, OWNER],
    );
    await conn.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, personal_care_category)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Gentle Daily Shampoo (synthetic)', 'HAIR_CARE')
       ON CONFLICT (id) DO NOTHING`,
      [SHAMPOO, PROFILE],
    );
    await conn.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, strength_text, dosage_form)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet', '500 mg', 'tablet')
       ON CONFLICT (id) DO NOTHING`,
      [MEDICINE, PROFILE],
    );
  });
});

afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------

runIfMigrator('the schema, read with the credential that owns it (BLK-001)', () => {
  /**
   * The bookkeeping table is readable by nobody but its owner, which is correct and is why this
   * block uses the migration credential: `schema_migration` carries no personal data and also no
   * grant, so neither the app nor the service role can see whether the schema is current. That is
   * an operator's question and it is asked with an operator's credential.
   */
  async function appliedMigrations(): Promise<{ version: string; checksum: string }[]> {
    return withManagedClient(MIGRATE_URL ?? '', async (client) => {
      const res = await client.query<{ version: string; checksum: string }>(
        'SELECT version, checksum FROM schema_migration ORDER BY version',
      );
      return res.rows;
    });
  }

  it('holds every migration this repository has, with the checksum it has now', async () => {
    const repository = loadMigrations();
    const applied = await appliedMigrations();

    // Both directions. A missing migration is a schema that is behind; an extra one is a database
    // somebody else's branch has been migrating, which is worse because it looks fine.
    expect(applied.map((r) => r.version)).toEqual(repository.map((m) => m.version));
    expect(applied.map((r) => r.checksum)).toEqual(repository.map((m) => m.checksum));
  });

  it('has a great many of them, so the comparison above is not two empty lists', async () => {
    // The control the comparison needs, and deliberately a floor rather than a count: a run that
    // loaded nothing from disk would compare two empty lists and pass, and an exact number here
    // would have to be edited by every migration, which is how a control becomes a chore and then
    // a `.skip`.
    expect(loadMigrations().length).toBeGreaterThan(25);
    expect((await appliedMigrations()).length).toBeGreaterThan(25);
  });
});

runIfManaged('the schema on a managed Postgres (BLK-001)', () => {
  it('runs the PostgreSQL the platform provides, not the one the tests compile against', async () => {
    const res = await db.withService((conn) =>
      conn.query<{ v: string }>('SELECT current_setting($1) AS v', ['server_version']),
    );
    // The number is not the point; that it is a different engine from PGlite's is.
    expect(Number.parseInt(res.rows[0]?.v ?? '0', 10)).toBeGreaterThanOrEqual(15);
  });

  it('has row-level security enabled and FORCED on every application table', async () => {
    const res = await db.withService((conn) =>
      conn.query<{ relname: string; enabled: boolean; forced: boolean }>(
        `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND ${APPLICATION_TABLES}
          ORDER BY c.relname`,
      ),
    );
    expect(res.rows.length).toBeGreaterThan(50);
    // FORCE and not merely ENABLE. Without it the table's owner - which on this platform is the
    // role that ran the migrations - reads every row of every household.
    expect(res.rows.filter((r) => !r.enabled || !r.forced).map((r) => r.relname)).toEqual([]);
  });

  it('has at least one policy on every application table', async () => {
    const res = await db.withService((conn) =>
      conn.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND ${APPLICATION_TABLES}
            AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`,
      ),
    );
    // RLS with no policy denies everything, which is safe and is also indistinguishable from a
    // table nobody finished. Naming them is the point.
    expect(res.rows.map((r) => r.relname)).toEqual([]);
  });
});

runIfManaged('what the platform can reach (spec 14)', () => {
  it('grants Supabase’s PostgREST roles no privilege on any table in public', async () => {
    const res = await db.withService((conn) =>
      conn.query<{ relname: string; grantee: string }>(
        `SELECT c.relname, r.grantee
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) AS r(grantee)
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.grantee)
            AND (has_table_privilege(r.grantee, c.oid, 'SELECT')
              OR has_table_privilege(r.grantee, c.oid, 'INSERT')
              OR has_table_privilege(r.grantee, c.oid, 'UPDATE')
              OR has_table_privilege(r.grantee, c.oid, 'DELETE'))
          ORDER BY 1, 2`,
      ),
    );
    // The check that would have caught applying the migrations as `postgres`: Supabase's default
    // privileges grant `anon` ALL on every table `postgres` creates in `public`, and PostgREST
    // serves `public` to anyone holding the project's publishable key.
    expect(res.rows).toEqual([]);
  });

  it('gives no Kynviora role SUPERUSER or BYPASSRLS', async () => {
    const res = await db.withService((conn) =>
      conn.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
          WHERE rolname LIKE 'kynviora%' ORDER BY rolname`,
      ),
    );
    expect(res.rows.length).toBeGreaterThanOrEqual(3);
    expect(res.rows.filter((r) => r.rolsuper || r.rolbypassrls).map((r) => r.rolname)).toEqual([]);
  });

  it('logs in as a role that inherits nothing until it says which role it is', async () => {
    // NOINHERIT makes `SET ROLE` a decision rather than a formality: without it the login role
    // holds the union of app, service and retention on every connection, and a statement that
    // forgot to switch would run with all three.
    const res = await db.withService((conn) =>
      conn.query<{ rolinherit: boolean }>(
        'SELECT rolinherit FROM pg_roles WHERE rolname = session_user',
      ),
    );
    expect(res.rows[0]?.rolinherit).toBe(false);
  });

  it('lets the SECURITY DEFINER helpers see past the policies they answer for', async () => {
    // A managed-platform difference with real consequences, found by looking rather than by
    // failing. Nine helpers in the `kynviora` schema are `SECURITY DEFINER` - `owns_profile`,
    // `has_capability` and the purge-door predicates among them - and every RLS policy in the
    // system calls one. On PGlite they are owned by `postgres`, a superuser, so RLS never applied
    // inside them. Here they are owned by the migration role, which is not a superuser and does
    // not bypass RLS, and `FORCE ROW LEVEL SECURITY` applies to a table's owner.
    //
    // They work because that role is a **member of `kynviora_service`**, so `is_service()` is
    // true inside them and the service policies admit every row. That is load-bearing and was
    // implicit: revoking the membership would leave every caregiver in the system silently
    // unable to see anything, with no error anywhere.
    const facts = await db.withService((conn) =>
      conn.query<{ definers: number; owner: string; owner_is_service: boolean }>(
        `SELECT count(*)::int                                              AS definers,
                min(pg_get_userbyid(p.proowner))                           AS owner,
                bool_and(pg_has_role(pg_get_userbyid(p.proowner),
                                     'kynviora_service', 'MEMBER'))        AS owner_is_service
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'kynviora' AND p.prosecdef`,
      ),
    );
    expect(facts.rows[0]?.definers).toBeGreaterThanOrEqual(9);
    expect(facts.rows[0]?.owner_is_service).toBe(true);

    // And the behaviour, not only the arrangement. A **stranger** asks a definer helper whether
    // somebody else owns a profile the stranger cannot see, and gets `true` - because the helper
    // is not filtered by the asker's policies. A filtered helper would answer `false`, which is
    // exactly what every caregiver in the system losing access would look like from the inside:
    // no error, no refusal, just nothing.
    const answered = await db.withUser(STRANGER, (conn) =>
      conn.query<{ owned: boolean }>('SELECT kynviora.profile_owned_by($1, $2) AS owned', [
        PROFILE,
        OWNER,
      ]),
    );
    expect(answered.rows[0]?.owned).toBe(true);

    // The control: the same stranger cannot read that row directly. Without this the assertion
    // above would pass over a database with no row-level security at all.
    const directly = await db.withUser(STRANGER, (conn) =>
      conn.query('SELECT owner_user_id FROM profile WHERE id = $1', [PROFILE]),
    );
    expect(directly.rows).toHaveLength(0);
  });

  it('owns every table with a Kynviora role rather than the platform’s', async () => {
    const res = await db.withService((conn) =>
      conn.query<{ owner: string; n: number }>(
        `SELECT pg_get_userbyid(c.relowner) AS owner, count(*)::int AS n
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
          GROUP BY 1 ORDER BY 1`,
      ),
    );
    // Ownership is what decides which set of default privileges a future table inherits, so it is
    // a standing property rather than a detail of how the first migration happened to be run.
    expect(res.rows.map((r) => r.owner)).toEqual(['kynviora_migrate']);
  });
});

runIfManaged('the three roles, and what each one may not do', () => {
  it('refuses the app role a write to the shared catalog', async () => {
    const message = await expectDenied(() =>
      db.withUser(OWNER, (conn) =>
        conn.query(
          `INSERT INTO product_identity (id, item_kind, display_name)
           VALUES ($1, 'MEDICINE', 'Injected')`,
          [randomUUID()],
        ),
      ),
    );
    // `03` group K: shared catalog publication is server-authoritative and protected from direct
    // user writes, so a SQL-injection flaw on a user path cannot rewrite shared truth. The app
    // role holds `SELECT` here and nothing else.
    expect(message).toMatch(/permission denied/i);
  });

  it('shows the retention role no row of a live medicine, though it may delete a dead one', async () => {
    // The grant is real and has to be: `DELETE ... WHERE deleted_at < purge_floor()` reads the
    // column it filters on. What bounds the role is the **policy**, not the grant - so the thing
    // worth asserting is that a live item is invisible to it, which is the same question asked of
    // a stranger and answered by a different policy.
    const privileges = await db.withService((conn) =>
      conn.query<{ sel: boolean; del: boolean }>(
        `SELECT has_table_privilege($1,'owned_item','SELECT') AS sel,
                has_table_privilege($1,'owned_item','DELETE') AS del`,
        [RETENTION_ROLE],
      ),
    );
    expect(privileges.rows[0]).toEqual({ sel: true, del: true });

    const visible = await db.withRetention((conn) =>
      conn.query('SELECT id FROM owned_item WHERE id = ANY($1::uuid[])', [[SHAMPOO, MEDICINE]]),
    );
    expect(visible.rows).toHaveLength(0);

    const removed = await db.withRetention((conn) =>
      conn.query('DELETE FROM owned_item WHERE id = ANY($1::uuid[])', [[SHAMPOO, MEDICINE]]),
    );
    // Not an error - a policy makes the rows invisible, so the statement is legal and matches
    // nothing. That is the shape of every purge over a household that has deleted nothing.
    expect(removed.affectedRows ?? 0).toBe(0);
  });

  it('refuses the retention role any sight of what it is deleting', async () => {
    const message = await expectDenied(() =>
      db.withRetention((conn) => conn.query('SELECT display_name FROM health_fact')),
    );
    // `docs/RETENTION.md` 8.1: a retention job's output outlives the record it is about, so the
    // role that runs it has no reach into the health facts it removes by deadline.
    expect(message).toMatch(/permission denied|does not exist/i);
  });

  it('refuses the service role a delete from the audit log', async () => {
    const message = await expectDenied(() =>
      db.withService((conn) => conn.query('DELETE FROM audit_event WHERE true')),
    );
    // DEC-013 and `0022`: the one privilege an attacker who reached the service role would want
    // is the one it does not have.
    expect(message).toMatch(/permission denied|append-only/i);
  });

  it('refuses the app and service roles the retention worker’s own tables', async () => {
    for (const table of ['retention_run', 'retention_lease', 'retention_run_category']) {
      const asApp = await expectDenied(() =>
        db.withUser(OWNER, (conn) => conn.query(`SELECT 1 FROM ${table}`)),
      );
      expect(asApp, table).toMatch(/permission denied/i);
      const asService = await expectDenied(() =>
        db.withService((conn) => conn.query(`SELECT 1 FROM ${table}`)),
      );
      expect(asService, table).toMatch(/permission denied/i);
    }
  });
});

runIfManaged('row-level security, negative cases (spec 14, 19)', () => {
  it('shows the owner both of their items', async () => {
    const res = await db.withUser(OWNER, (conn) =>
      conn.query<{ id: string }>('SELECT id FROM owned_item WHERE profile_id = $1', [PROFILE]),
    );
    expect(res.rows).toHaveLength(2);
  });

  it('shows a stranger nothing', async () => {
    const res = await db.withUser(STRANGER, (conn) =>
      conn.query('SELECT id FROM owned_item WHERE profile_id = $1', [PROFILE]),
    );
    expect(res.rows).toHaveLength(0);
  });

  it('shows a request with no identity nothing', async () => {
    // The GUC is how a policy learns who is acting; an unset one yields NULL, which makes every
    // comparison NULL. Fail-closed by arithmetic rather than by a branch somebody wrote.
    const res = await db.withUser(null, (conn) =>
      conn.query('SELECT id FROM owned_item WHERE profile_id = $1', [PROFILE]),
    );
    expect(res.rows).toHaveLength(0);
  });

  it('shows a VIEW_SHELF caregiver the personal-care item and not the medicine', async () => {
    const res = await db.withUser(SHELF_CAREGIVER, (conn) =>
      conn.query<{ id: string }>('SELECT id FROM owned_item WHERE profile_id = $1', [PROFILE]),
    );
    // `08.2`: medicines carry their own capability. The sharpest case here, because both rows are
    // in one table and only the policy separates them.
    expect(res.rows.map((r) => r.id)).toEqual([SHAMPOO]);
  });

  it('shows a revoked caregiver nothing, though the grant row is still there', async () => {
    const res = await db.withUser(REVOKED_CAREGIVER, (conn) =>
      conn.query('SELECT id FROM owned_item WHERE profile_id = $1', [PROFILE]),
    );
    expect(res.rows).toHaveLength(0);
  });

  it('refuses a stranger an insert into somebody else’s shelf', async () => {
    const message = await expectDenied(() =>
      db.withUser(STRANGER, (conn) =>
        conn.query(
          `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
           VALUES ($1, $2, 'MEDICINE', 'Planted')`,
          [randomUUID(), PROFILE],
        ),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses a caregiver an update to an item they may only read', async () => {
    const res = await db.withUser(SHELF_CAREGIVER, (conn) =>
      conn.query(`UPDATE owned_item SET display_name = 'Renamed' WHERE id = $1`, [MEDICINE]),
    );
    // A blocked UPDATE is zero rows rather than an error: the row is invisible, so there is
    // nothing to refuse. Asserted separately from the read because it is a different policy.
    expect(res.affectedRows ?? 0).toBe(0);
  });
});

runIfManaged('the pool, and the state a connection must not carry out of a request', () => {
  it('does not leak an identity from one request into the next', async () => {
    await db.withUser(OWNER, (conn) => conn.query('SELECT 1'));
    const res = await db.withUser(null, (conn) =>
      conn.query<{ who: string | null }>(
        `SELECT nullif(current_setting('kynviora.user_id', true), '') AS who`,
      ),
    );
    expect(res.rows[0]?.who).toBeNull();
  });

  it('does not leak a role from one request into the next', async () => {
    await db.withService((conn) => conn.query('SELECT 1'));
    const res = await db.withUser(OWNER, (conn) =>
      conn.query<{ role: string }>('SELECT current_user AS role'),
    );
    expect(res.rows[0]?.role).toBe(APP_ROLE);
  });

  it('does not leak an identity out of a request that threw', async () => {
    await expect(
      db.withUser(OWNER, async (conn) => {
        await conn.query('SELECT 1');
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');

    const res = await db.withUser(null, (conn) =>
      conn.query<{ who: string | null; role: string }>(
        `SELECT nullif(current_setting('kynviora.user_id', true), '') AS who,
                current_user AS role`,
      ),
    );
    expect(res.rows[0]?.who).toBeNull();
    expect(res.rows[0]?.role).toBe(APP_ROLE);
  });

  it('does not leave an uncommitted transaction on a connection it hands back', async () => {
    const planted = randomUUID();
    await db.withService(async (conn) => {
      await conn.query('BEGIN');
      await conn.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
         VALUES ($1, $2, 'MEDICINE', 'Uncommitted')`,
        [planted, PROFILE],
      );
      // Deliberately no COMMIT and no ROLLBACK. A pooled connection returned mid-transaction
      // holds a server connection open until a timeout, and its work can be committed by whatever
      // runs next on it.
    });

    const res = await db.withUser(OWNER, (conn) =>
      conn.query('SELECT id FROM owned_item WHERE id = $1', [planted]),
    );
    expect(res.rows).toHaveLength(0);
  });

  it('keeps concurrent requests on separate identities', async () => {
    // The failure this rules out is the one pooling introduces and nothing else can: two requests
    // interleaved on one pool, each reading what the other set. Run wider than the pool, so
    // connections are genuinely reused mid-flight.
    const identities = [OWNER, STRANGER, SHELF_CAREGIVER, REVOKED_CAREGIVER];
    const reads = await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const who = identities[i % identities.length] as string;
        return db.withUser(who, async (conn: RuntimeConnection) => {
          const seen = await conn.query<{ who: string }>(
            `SELECT current_setting('kynviora.user_id', true) AS who`,
          );
          const items = await conn.query<{ id: string }>(
            'SELECT id FROM owned_item WHERE profile_id = $1 ORDER BY id',
            [PROFILE],
          );
          return { asked: who, saw: seen.rows[0]?.who, items: items.rows.length };
        });
      }),
    );

    for (const read of reads) {
      expect(read.saw).toBe(read.asked);
    }
    const byIdentity = new Map(reads.map((r) => [r.asked, r.items]));
    expect(byIdentity.get(OWNER)).toBe(2);
    expect(byIdentity.get(SHELF_CAREGIVER)).toBe(1);
    expect(byIdentity.get(REVOKED_CAREGIVER)).toBe(0);
    expect(byIdentity.get(STRANGER)).toBe(0);
  });

  it('reports a pool rather than a connection', () => {
    // Read after the concurrency test above, so the count is the pool the run actually opened
    // rather than the one it was configured for. One connection would mean the requests above
    // were serialised and had never in fact been concurrent.
    const stats = db.poolStats();
    expect(stats.total).toBeGreaterThan(1);
    expect(stats.waiting).toBe(0);
  });
});

runIfManaged('the closed vocabularies, on the engine that stores them', () => {
  async function acceptedBy(constraintName: string): Promise<string[]> {
    const result = await db.withService((conn) =>
      conn.query<{ def: string }>(
        'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1',
        [constraintName],
      ),
    );
    const definition = result.rows[0]?.def;
    expect(definition, `no constraint named ${constraintName}`).toBeDefined();
    return [...(definition ?? '').matchAll(/'([^']+)'::text/g)]
      .map((match) => match[1] as string)
      .sort();
  }

  const sorted = (values: readonly string[]): string[] => [...values].sort();

  it('accepts exactly the purge categories the plan runs', async () => {
    expect(await acceptedBy('retention_run_category_valid')).toEqual(sorted(PURGE_CATEGORY_NAMES));
  });

  it('accepts exactly the run outcomes the worker writes', async () => {
    expect(await acceptedBy('retention_run_open_or_closed')).toEqual(
      sorted(RETENTION_RUN_OUTCOMES),
    );
  });

  it('accepts exactly the delivery channels and channel reasons', async () => {
    expect(await acceptedBy('alert_delivery_channel_valid')).toEqual(sorted(DELIVERY_CHANNELS));
    expect(await acceptedBy('alert_delivery_channel_reason_valid')).toEqual(
      sorted(CHANNEL_REASONS),
    );
  });

  it('accepts exactly the digest revalidation outcomes', async () => {
    expect(await acceptedBy('notification_digest_entry_outcome_valid')).toEqual(
      sorted(REVALIDATION_OUTCOMES),
    );
  });
});

runIfManaged('the roles the migrations expect', () => {
  it('created all three, and the login role is a member of each', async () => {
    const res = await db.withService((conn) =>
      conn.query<{ role: string; member: boolean }>(
        `SELECT r AS role, pg_has_role(session_user, r, 'MEMBER') AS member
           FROM unnest(ARRAY[$1::text,$2::text,$3::text]) AS r`,
        [APP_ROLE, SERVICE_ROLE, RETENTION_ROLE],
      ),
    );
    expect(res.rows.filter((r) => !r.member).map((r) => r.role)).toEqual([]);
  });
});
