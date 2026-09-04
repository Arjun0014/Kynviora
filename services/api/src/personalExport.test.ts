import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  PERSONAL_EXPORT_SECTIONS,
  instantFrom,
  noopLogger,
  unsafeId,
  type Instant,
  type PersonalExportManifest,
  type UserId,
} from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * A person's copy of what is held about them.
 *
 * Spec references: `16` (a person can get a copy; export requires intentional action, shows what
 * is included, re-authenticates, and audits without duplicating sensitive content), `14`, `13`,
 * `BLK-005`, DEC-117, `DEV-036`.
 *
 * THE FOUR THINGS WORTH MEASURING
 *
 * 1. **Is it complete?** `DEV-036` said a shell that exported "some of it" is worse than none,
 *    because a person checks a copy once. So the manifest lists every section including the
 *    empty ones, and a section that failed to read is `-1` rather than `[]` - the difference
 *    between "there was nothing" and "this did not arrive" is the whole point.
 * 2. **Does it stay inside row-level security?** The export reads fourteen tables through one
 *    session. If any read escaped RLS it would be the largest cross-household leak in the system,
 *    and it would look exactly like a working feature.
 * 3. **Does it redistribute source material?** `BLK-005` is open. Sources are referenced by
 *    identifier and publisher; their content must not be in the file.
 * 4. **Does it say what is missing?** Three sections are deliberately absent, and an artifact
 *    that omitted them silently would be the failure in (1) wearing a different hat.
 */

const OWNER = testUuid(1);
const CAREGIVER = testUuid(2);
const OUTSIDER = testUuid(3);

const HOUSEHOLD = testUuid(10);
const OTHER_HOUSEHOLD = testUuid(11);
const PROFILE = testUuid(20);
const OTHER_PROFILE = testUuid(21);

const MEDICINE = testUuid(30);
const SHAMPOO = testUuid(31);
const OTHER_MEDICINE = testUuid(32);

const NOW = instantFrom('2026-09-05T12:00:00.000Z');
const STEPPED_UP = instantFrom('2026-09-05T11:55:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;

function principalFor(userId: string, stepUpVerifiedAt: Instant | null = STEPPED_UP): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt };
}

interface ExportBody {
  readonly manifest: PersonalExportManifest;
  readonly data: Record<string, readonly Record<string, unknown>[]>;
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [CAREGIVER, 'caregiver@example.test'],
      [OUTSIDER, 'outsider@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }

    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`,
      [HOUSEHOLD, OWNER, OTHER_HOUSEHOLD, OUTSIDER],
    );
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent A (synthetic)'), ($4, $5, $6, 'Somebody Else (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER, OTHER_PROFILE, OTHER_HOUSEHOLD, OUTSIDER],
    );

    await db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4::text[], 'ACTIVE', now())`,
      [PROFILE, CAREGIVER, OWNER, ['VIEW_SHELF', 'VIEW_MEDICINES']],
    );

    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, brand, strength_text, dosage_form,
          directions_text, identity_verification)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet', 'Synthetic Brand', '500 mg', 'Tablet',
               'Take one twice a day.', 'PROBABLE')`,
      [MEDICINE, PROFILE],
    );
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, personal_care_category,
          ingredient_declaration_raw)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Synthetic Shampoo', 'HAIR_CARE', 'Aqua, Glycerin')`,
      [SHAMPOO, PROFILE],
    );
    // The other household's medicine. Nothing this account exports may name it.
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
       VALUES ($1, $2, 'MEDICINE', 'Unrelated Household Tablet')`,
      [OTHER_MEDICINE, OTHER_PROFILE],
    );

    await db.query(
      `INSERT INTO medicine_schedule (owned_item_id, schedule_kind, timezone, times_local)
       VALUES ($1, 'FIXED_TIMES', 'Asia/Kolkata', ARRAY['08:00','20:00'])`,
      [MEDICINE],
    );
    await db.query(
      `INSERT INTO dose_event (owned_item_id, event_kind, recorded_at, note, client_operation_id)
       VALUES ($1, 'TAKEN', now(), 'felt fine', gen_random_uuid())`,
      [MEDICINE],
    );
    await db.query(
      `INSERT INTO allergy_record (profile_id, record_kind, display_term, provenance, certainty)
       VALUES ($1, 'ALLERGY', 'penicillin', 'USER_REPORTED', 'SUSPECTED')`,
      [PROFILE],
    );
    await db.query(
      `INSERT INTO consent_receipt (user_id, profile_id, purpose, granted, policy_version)
       VALUES ($1, $2, 'PROFILE_DATA', true, 'v1')`,
      [OWNER, PROFILE],
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
    now: (): Instant => NOW,
    loadSources: () => Promise.resolve(sources),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

const exportFor = (as: Principal | null) => request(as, { method: 'GET', url: '/v1/export' });

async function bodyFor(as: Principal | null): Promise<ExportBody> {
  const res = await exportFor(as);
  expect(res.statusCode).toBe(200);
  return res.json<ExportBody>();
}

// ---------------------------------------------------------------------------

describe('who may take a copy', () => {
  it('refuses without fresh step-up', async () => {
    // `14`. This is the request that assembles the largest single collection of somebody's health
    // data this system can produce, so it is also the one where a merely-valid session matters
    // least.
    const res = await exportFor(principalFor(OWNER, null));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
  });

  it('refuses an anonymous request', async () => {
    expect((await exportFor(null)).statusCode).toBe(401);
  });
});

describe('completeness', () => {
  it('lists every section in the manifest, including the empty ones', async () => {
    // A section dropped because it had no rows is indistinguishable from one the assembler
    // forgot, and the person reading the file is the one person who cannot tell the difference.
    const body = await bodyFor(principalFor(OWNER));
    const listed = body.manifest.sections.map((s) => s.section);
    expect(listed).toEqual([...PERSONAL_EXPORT_SECTIONS]);
  });

  it('carries a data block for every section the manifest names', async () => {
    // The other direction. A manifest that promised a section the file does not have would be a
    // more convincing version of the same failure.
    const body = await bodyFor(principalFor(OWNER));
    for (const section of PERSONAL_EXPORT_SECTIONS) {
      expect(Object.keys(body.data)).toContain(section);
    }
  });

  it('counts match what is in the file', async () => {
    const body = await bodyFor(principalFor(OWNER));
    for (const { section, count } of body.manifest.sections) {
      expect(body.data[section]).toHaveLength(count);
    }
  });

  it('includes the records and the provenance, not only the names', async () => {
    // `16` asks for a copy of what is held. A copy of a medicine's name without how well Kynviora
    // believes it knows the product reads as more settled than the record actually is.
    const body = await bodyFor(principalFor(OWNER));
    const medicine = body.data['items']?.find((row) => row['id'] === MEDICINE);
    expect(medicine).toMatchObject({
      display_name: 'Synthetic Tablet',
      directions_text: 'Take one twice a day.',
      identity_verification: 'PROBABLE',
      formulation_verification: 'UNVERIFIED',
      batch_verification: 'UNVERIFIED',
    });
  });

  it('includes the children of an item and the profile-level records', async () => {
    const body = await bodyFor(principalFor(OWNER));
    expect(body.data['schedules']).toHaveLength(1);
    expect(body.data['doseEvents']).toHaveLength(1);
    expect(body.data['allergies']).toHaveLength(1);
    expect(body.data['consentReceipts']).toHaveLength(1);
    // The note a person wrote against a dose is theirs and is in their copy.
    expect(body.data['doseEvents']?.[0]).toMatchObject({ note: 'felt fine' });
  });
});

describe('row-level security decides what is in it', () => {
  it('does not carry another household’s medicine', async () => {
    // The failure this test exists for would look exactly like a working feature: fourteen reads
    // through one session, and any one of them escaping RLS is the largest cross-household leak
    // the system can produce.
    const body = await bodyFor(principalFor(OWNER));
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Unrelated Household Tablet');
    expect(serialized).not.toContain(OTHER_PROFILE);
    expect(serialized).not.toContain('Somebody Else (synthetic)');
  });

  it('gives an unrelated account a copy of its own household and nothing else', async () => {
    const body = await bodyFor(principalFor(OUTSIDER));
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('Unrelated Household Tablet');
    expect(serialized).not.toContain('Synthetic Tablet');
    expect(serialized).not.toContain('Parent A (synthetic)');
  });

  it('gives a caregiver what they can see, which is less than the owner’s copy', async () => {
    // Stated rather than filtered out. A caregiver's copy contains what is reachable by them,
    // because that is what "held about them" means for somebody who holds a grant; filtering to
    // owned profiles would give an owner a copy missing a profile they are the subject of.
    const owner = await bodyFor(principalFor(OWNER));
    const caregiver = await bodyFor(principalFor(CAREGIVER));

    expect(JSON.stringify(caregiver)).toContain('Synthetic Tablet');

    // The account row is self-only, so each copy carries exactly one and it is their own.
    expect(caregiver.data['account']?.map((row) => row['id'])).toEqual([CAREGIVER]);
    expect(owner.data['account']?.map((row) => row['id'])).toEqual([OWNER]);

    // A consent receipt belongs to the person who gave it. The owner's copy has theirs and the
    // caregiver's copy has none, because none exists - not because the export filtered it.
    expect(owner.data['consentReceipts']).toHaveLength(1);
    expect(caregiver.data['consentReceipts']).toHaveLength(0);

    // The allergy record **is** in the caregiver's copy, and that is correct rather than a leak.
    // `0004` scopes health context to `VIEW_MEDICINES` on purpose - "the most sensitive profile
    // data", separately granted - and this caregiver holds it. The export does not second-guess
    // that: a copy that hid a record the same caller can read on the health-context screen would
    // be the export inventing an access rule of its own, which is exactly what `13` puts in the
    // database instead.
    expect(caregiver.data['allergies']).toHaveLength(1);
    expect(owner.data['allergies']).toHaveLength(1);
  });
});

describe('external source material', () => {
  it('names every source and reproduces none of it', async () => {
    // `BLK-005`. An export that shipped the snapshots would be redistribution decided by an
    // engineer rather than by the licence review that has not happened.
    const body = await bodyFor(principalFor(OWNER));
    expect(body.manifest.sourcesReferenced.length).toBeGreaterThan(0);

    for (const reference of body.manifest.sourcesReferenced) {
      expect(reference.sourceId).not.toBe('');
      expect(reference.publisher).not.toBe('');
      // The reason travels with each row rather than being said once at the top, because a person
      // reading the file in three years has no other way to find out.
      expect(reference.reason).toMatch(/records where to find it rather than keeping a copy/);
    }
  });

  it('carries no regulatory rule text, opinion or document body', async () => {
    // The tables holding source material have no section in this file at all, so the check is
    // that none of them leaked in through another name.
    const body = await bodyFor(principalFor(OWNER));
    for (const forbidden of [
      'regulatory_rule_version',
      'source_document',
      'scientific_opinion_record',
      'sourceDocuments',
      'ruleVersions',
    ]) {
      expect(Object.keys(body.data)).not.toContain(forbidden);
    }
  });
});

describe('what is missing is said', () => {
  it('names the three omitted sections and why', async () => {
    const body = await bodyFor(principalFor(OWNER));
    const omitted = body.manifest.omitted.map((o) => o.section);
    expect(omitted).toEqual(['auditLog', 'sourceMaterial', 'sharedCatalog']);
    for (const entry of body.manifest.omitted) {
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });

  it('does not carry the audit log', async () => {
    // `14` gives the app role no grant on `audit_event` at all, and `20` keeps it free of health
    // content. Putting it in a user-facing artifact would be publishing a security log on request.
    const body = await bodyFor(principalFor(OWNER));
    expect(Object.keys(body.data)).not.toContain('auditLog');
    expect(Object.keys(body.data)).not.toContain('audit_event');
  });

  it('carries a format version, so a file kept for years can still be read', async () => {
    const body = await bodyFor(principalFor(OWNER));
    expect(body.manifest.formatVersion).toBe('1');
    expect(body.manifest.exportedAt).toBe(NOW);
  });
});

describe('the audit', () => {
  it('records that a copy was taken, with counts and no health content', async () => {
    await t.asOwner((db) => db.query('TRUNCATE audit_event'));
    await bodyFor(principalFor(OWNER));

    const rows = await t.asService((db) =>
      db.query<{ action: string; actor_user_id: string; detail: unknown }>(
        `SELECT action, actor_user_id, detail FROM audit_event`,
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      action: 'export.personal_data',
      actor_user_id: OWNER,
    });

    // `16`: an audit event without duplicating sensitive content into logs.
    const serialized = JSON.stringify(rows.rows[0]);
    expect(serialized).not.toContain('Synthetic Tablet');
    expect(serialized).not.toContain('penicillin');
    expect(serialized).not.toContain('felt fine');
    expect(rows.rows[0]?.detail).toMatchObject({ profile_count: 1, item_count: 2 });
  });
});

describe('a deleted item', () => {
  it('is not in the copy', async () => {
    // The export and the deletion have to agree. A copy that still carried a deleted medicine
    // would be the one place a revoked record came back.
    await t.asService((db) =>
      db.query(`SELECT kynviora.delete_owned_item($1, $2)`, [SHAMPOO, OWNER]),
    );
    const body = await bodyFor(principalFor(OWNER));
    expect(JSON.stringify(body)).not.toContain('Synthetic Shampoo');
    expect(body.data['items']).toHaveLength(1);
  });
});
