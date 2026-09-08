import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Database-level tests for the Health record (migration `0032`).
 *
 * Spec 19 makes deny-by-default RLS negative tests release-gating; spec 14 requires least
 * privilege; DEC-154 says a health record is its own capability and that migration `0032`
 * backfills nothing.
 *
 * The most important assertions in this file are the ones that fail if somebody widens a policy:
 * a caregiver holding every *other* capability - including `VIEW_DOCUMENTS`, the near miss - can
 * read nothing here. Every assertion runs as the non-superuser `kynviora_app` role.
 */

const OWNER = testUuid(1);
const CAREGIVER_HEALTH = testUuid(2); // VIEW_HEALTH_RECORDS only
const CAREGIVER_EVERYTHING_ELSE = testUuid(3); // every capability except the two health ones
const CAREGIVER_MANAGE = testUuid(4); // VIEW_ + MANAGE_HEALTH_RECORDS
const STRANGER = testUuid(5);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const SOURCE = testUuid(30);
const RECORD = testUuid(31);
const OBSERVATION = testUuid(32);
const MEASUREMENT = testUuid(33);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [CAREGIVER_HEALTH, 'health@example.test'],
      [CAREGIVER_EVERYTHING_ELSE, 'other@example.test'],
      [CAREGIVER_MANAGE, 'manage@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
    await db.query(`INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, $3)`, [
      HOUSEHOLD,
      OWNER,
      'Household',
    ]);
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, $4)`,
      [PROFILE, HOUSEHOLD, OWNER, 'Rukmini (synthetic)'],
    );

    const grant = async (userId: string, capabilities: readonly string[]) => {
      await db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, $4::text[], 'ACTIVE', now())`,
        [PROFILE, userId, OWNER, capabilities],
      );
    };
    await grant(CAREGIVER_HEALTH, ['VIEW_HEALTH_RECORDS']);
    await grant(CAREGIVER_MANAGE, ['VIEW_HEALTH_RECORDS', 'MANAGE_HEALTH_RECORDS']);
    // Everything the vocabulary offers except the two this migration added. This is the grant
    // that must see nothing, and it is deliberately generous so the test cannot pass by accident.
    await grant(CAREGIVER_EVERYTHING_ELSE, [
      'VIEW_SAFETY',
      'VIEW_SHELF',
      'MANAGE_SHELF',
      'VIEW_MEDICINES',
      'RECORD_DOSES',
      'MANAGE_MEDICINES',
      'VIEW_CARE',
      'MANAGE_CARE',
      'VIEW_DOCUMENTS',
      'EXPORT_SUMMARY',
      'RECEIVE_MISSED_DOSE',
      'MANAGE_CAREGIVERS',
    ]);
  });
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.asService(async (db) => {
    await db.query('DELETE FROM health_measurement');
    await db.query('DELETE FROM health_observation');
    await db.query('DELETE FROM health_record');
    await db.query('DELETE FROM health_source');

    await db.query(
      `INSERT INTO health_source
         (id, profile_id, source_kind, display_name, connection_state, last_received_at)
       VALUES ($1, $2, 'IMPORTED_DOCUMENT', 'Metropolis Diagnostics', 'IMPORTED_ONCE', now())`,
      [SOURCE, PROFILE],
    );
    await db.query(
      `INSERT INTO health_record
         (id, profile_id, record_kind, title, provider_name, recorded_on, source_id,
          extraction_state, provenance)
       VALUES ($1, $2, 'LAB_REPORT', 'Thyroid panel', 'Metropolis Diagnostics', DATE '2026-09-02',
               $3, 'ENTERED_BY_HAND', 'USER_REPORTED')`,
      [RECORD, PROFILE, SOURCE],
    );
    await db.query(
      `INSERT INTO health_observation
         (id, record_id, profile_id, analyte_code, display_name, sequence,
          value_numeric, unit, decimals, reference_low, reference_high, source_flag)
       VALUES ($1, $2, $3, 'tsh', 'TSH', 0, 5.2, 'mIU/L', 1, 0.4, 4.0, 'HIGH')`,
      [OBSERVATION, RECORD, PROFILE],
    );
    await db.query(
      `INSERT INTO health_measurement
         (id, profile_id, metric, measured_at, value_numeric, value_secondary, unit, source_id)
       VALUES ($1, $2, 'BLOOD_PRESSURE', now(), 128, 82, 'mmHg', $3)`,
      [MEASUREMENT, PROFILE, SOURCE],
    );
  });
});

const TABLES = [
  'health_source',
  'health_record',
  'health_observation',
  'health_measurement',
] as const;

describe('who may read a health record', () => {
  it('lets the profile owner read all four tables', async () => {
    for (const table of TABLES) {
      const res = await t.asUser(OWNER, (db) => db.query(`SELECT id FROM ${table}`));
      expect(res.rows, table).toHaveLength(1);
    }
  });

  it('lets a caregiver holding VIEW_HEALTH_RECORDS read all four', async () => {
    for (const table of TABLES) {
      const res = await t.asUser(CAREGIVER_HEALTH, (db) => db.query(`SELECT id FROM ${table}`));
      expect(res.rows, table).toHaveLength(1);
    }
  });

  it('shows nothing to a caregiver holding every other capability, VIEW_DOCUMENTS included', async () => {
    // DEC-154's whole claim, measured. `VIEW_DOCUMENTS` is the near miss: it is granted so
    // somebody can open a package label at a pharmacy, and if it also opened a lab history the
    // capability would mean two things - which is the failure `DEV-049` was.
    for (const table of TABLES) {
      const res = await t.asUser(CAREGIVER_EVERYTHING_ELSE, (db) =>
        db.query(`SELECT id FROM ${table}`),
      );
      expect(res.rows, table).toHaveLength(0);
    }
  });

  it('shows nothing to a stranger', async () => {
    for (const table of TABLES) {
      const res = await t.asUser(STRANGER, (db) => db.query(`SELECT id FROM ${table}`));
      expect(res.rows, table).toHaveLength(0);
    }
  });

  it('shows nothing to an unauthenticated session', async () => {
    for (const table of TABLES) {
      const res = await t.asUser(null, (db) => db.query(`SELECT id FROM ${table}`));
      expect(res.rows, table).toHaveLength(0);
    }
  });

  it('stops showing rows the moment a grant is revoked', async () => {
    // `15` A2. `has_capability` is evaluated per access, so this needs no cache invalidation -
    // which is exactly the property worth asserting rather than assuming.
    await t.asService((db) =>
      db.query(
        `UPDATE caregiver_grant SET revoked_at = now(), status = 'REVOKED'
                 WHERE grantee_user_id = $1`,
        [CAREGIVER_HEALTH],
      ),
    );
    const res = await t.asUser(CAREGIVER_HEALTH, (db) => db.query('SELECT id FROM health_record'));
    expect(res.rows).toHaveLength(0);
    await t.asService((db) =>
      db.query(
        `UPDATE caregiver_grant SET revoked_at = NULL, status = 'ACTIVE'
                 WHERE grantee_user_id = $1`,
        [CAREGIVER_HEALTH],
      ),
    );
  });

  it('hides a soft-deleted record from the app role entirely', async () => {
    await t.asService((db) =>
      db.query('UPDATE health_record SET deleted_at = now() WHERE id = $1', [RECORD]),
    );
    const res = await t.asUser(OWNER, (db) => db.query('SELECT id FROM health_record'));
    expect(res.rows).toHaveLength(0);
  });
});

describe('who may write a health record', () => {
  const insertRecord = (userId: string) =>
    t.asUser(userId, (db) =>
      db.query(
        `INSERT INTO health_record (profile_id, record_kind, title, provenance)
         VALUES ($1, 'CLINICAL_LETTER', 'Referral', 'USER_REPORTED')`,
        [PROFILE],
      ),
    );

  it('lets the owner and a MANAGE_HEALTH_RECORDS caregiver write', async () => {
    await expect(insertRecord(OWNER)).resolves.toBeDefined();
    await expect(insertRecord(CAREGIVER_MANAGE)).resolves.toBeDefined();
  });

  it('refuses a write from a caregiver who may only read', async () => {
    // The pairing that matters: reading a lab history and correcting one are different acts, and
    // a grant that allowed the second because it allowed the first would be `DEV-049` again.
    const message = await expectDenied(() => insertRecord(CAREGIVER_HEALTH));
    expect(message).toMatch(/row-level security|permission denied/i);
  });

  it('refuses a write from a caregiver holding every other capability', async () => {
    const message = await expectDenied(() => insertRecord(CAREGIVER_EVERYTHING_ELSE));
    expect(message).toMatch(/row-level security|permission denied/i);
  });

  it('gives the app role no way to hard-delete anything', async () => {
    // No DELETE policy and no DELETE grant, matching every other user-facing table: removal is a
    // soft delete and then the retention sweep, which runs as a different role.
    for (const table of TABLES) {
      const message = await expectDenied(() =>
        t.asUser(OWNER, (db) => db.query(`DELETE FROM ${table}`)),
      );
      expect(message, table).toMatch(/permission denied/i);
    }
  });
});

describe('what the schema refuses to store', () => {
  const insertObservation = (columns: string, values: string, params: readonly unknown[]) =>
    t.asService((db) =>
      db.query(
        `INSERT INTO health_observation (record_id, profile_id, analyte_code, display_name, ${columns})
         VALUES ($1, $2, 'x', 'X', ${values})`,
        [RECORD, PROFILE, ...params],
      ),
    );

  it('refuses an observation with no value at all', async () => {
    // A row saying a test was done and carrying no result is an absence dressed as a measurement.
    const message = await expectDenied(() => insertObservation('unit', `'mIU/L'`, []));
    expect(message).toMatch(/health_observation_has_a_value/);
  });

  it('accepts a text result as a real result', async () => {
    await expect(insertObservation('value_text', `'Not detected'`, [])).resolves.toBeDefined();
  });

  it('accepts a measured zero, which is a value and not an absence', async () => {
    await expect(insertObservation('value_numeric', '0', [])).resolves.toBeDefined();
  });

  it('refuses a reference interval whose bounds are the wrong way round', async () => {
    const message = await expectDenied(() =>
      insertObservation('value_numeric, reference_low, reference_high', '1, 9, 2', []),
    );
    expect(message).toMatch(/health_observation_interval_ordered/);
  });

  it('refuses a source flag outside the report-flag vocabulary', async () => {
    // The vocabulary is deliberately the vocabulary of report flags rather than of clinical
    // severity, so a word like 'DANGEROUS' cannot enter through this column.
    const message = await expectDenied(() =>
      insertObservation('value_numeric, source_flag', `1, 'DANGEROUS'`, []),
    );
    expect(message).toMatch(/health_observation_flag_valid/);
  });

  it('has no column at all in which Kynviora could record a verdict about a value', async () => {
    // The structural half of DEC-154. If somebody adds `is_abnormal`, `interpretation`,
    // `severity` or a `normal` flag, this fails and says why.
    const res = await t.asOwner((db) =>
      db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'health_observation'`,
      ),
    );
    const columns = res.rows.map((r) => r.column_name);
    for (const forbidden of ['is_abnormal', 'interpretation', 'severity', 'normal', 'verdict']) {
      expect(columns, forbidden).not.toContain(forbidden);
    }
    // The only judgement-shaped column is the source's own word, and its name says whose it is.
    expect(columns).toContain('source_flag');
  });

  it('refuses two results for the same analyte in one report', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO health_observation
             (record_id, profile_id, analyte_code, display_name, value_numeric)
           VALUES ($1, $2, 'tsh', 'TSH again', 9)`,
          [RECORD, PROFILE],
        ),
      ),
    );
    expect(message).toMatch(/health_observation_record_id_analyte_code_key|duplicate key/i);
  });
});

describe('a blood pressure is one reading', () => {
  const insertMeasurement = (metric: string, primary: number, secondary: number | null) =>
    t.asService((db) =>
      db.query(
        `INSERT INTO health_measurement
           (profile_id, metric, measured_at, value_numeric, value_secondary, unit)
         VALUES ($1, $2, now() - interval '1 day', $3, $4, 'x')`,
        [PROFILE, metric, primary, secondary],
      ),
    );

  it('refuses a blood pressure with only one number', async () => {
    // A systolic with no diastolic is not a blood pressure. Stored as two rows they could be
    // separated by a filter or a partial import and re-paired wrongly by a join, which is a
    // fabricated measurement.
    const message = await expectDenied(() => insertMeasurement('BLOOD_PRESSURE', 128, null));
    expect(message).toMatch(/health_measurement_pairing/);
  });

  it('refuses a second number on a metric that does not have one', async () => {
    const message = await expectDenied(() => insertMeasurement('BODY_WEIGHT', 71, 70));
    expect(message).toMatch(/health_measurement_pairing/);
  });

  it('refuses a diastolic above its systolic', async () => {
    // A transcription error that would otherwise draw a bar pointing the wrong way.
    const message = await expectDenied(() => insertMeasurement('BLOOD_PRESSURE', 82, 128));
    expect(message).toMatch(/health_measurement_pair_ordered/);
  });

  it('accepts a well-formed pair', async () => {
    await expect(insertMeasurement('BLOOD_PRESSURE', 132, 84)).resolves.toBeDefined();
  });
});

describe('a source states its own honesty', () => {
  const insertSource = (state: string, lastReceived: string | null) =>
    t.asService((db) =>
      db.query(
        `INSERT INTO health_source
           (profile_id, source_kind, display_name, connection_state, last_received_at)
         VALUES ($1, 'WEARABLE', 'A watch', $2, $3)`,
        [PROFILE, state, lastReceived],
      ),
    );

  it('refuses to call a source stale when it has never sent anything', async () => {
    // "Stale" claims a history. A source with no history is NOT_CONNECTED, which is a different
    // sentence and a different screen.
    const message = await expectDenied(() => insertSource('STALE', null));
    expect(message).toMatch(/health_source_state_needs_history/);
  });

  it('refuses to call a source imported-once when nothing was ever imported', async () => {
    const message = await expectDenied(() => insertSource('IMPORTED_ONCE', null));
    expect(message).toMatch(/health_source_state_needs_history/);
  });

  it('allows a designed-but-unimplemented integration to exist with no data', async () => {
    // The state the V3 brief asks for by name: do not visually imply a real integration that has
    // not been implemented. A row in this state renders as exactly that and offers no connect
    // button.
    await expect(insertSource('DESIGNED_NOT_IMPLEMENTED', null)).resolves.toBeDefined();
  });
});

describe('extraction never silently confirms', () => {
  it('refuses to claim a document was extracted when no document is attached', async () => {
    // `04` Phase 1.3: no OCR result silently becomes a confirmed record. A record claiming
    // EXTRACTED_CONFIRMED with nothing to have extracted from is that claim with no evidence.
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO health_record
             (profile_id, record_kind, title, extraction_state, provenance)
           VALUES ($1, 'LAB_REPORT', 'Panel', 'EXTRACTED_CONFIRMED', 'IMPORTED')`,
          [PROFILE],
        ),
      ),
    );
    expect(message).toMatch(/health_record_extraction_needs_document/);
  });

  it('lets a hand-entered record exist with no document', async () => {
    await expect(
      t.asService((db) =>
        db.query(
          `INSERT INTO health_record
             (profile_id, record_kind, title, extraction_state, provenance)
           VALUES ($1, 'LAB_REPORT', 'Typed in', 'ENTERED_BY_HAND', 'USER_REPORTED')`,
          [PROFILE],
        ),
      ),
    ).resolves.toBeDefined();
  });
});

describe('retention reaches every health table', () => {
  it('shows the retention role nothing while the profile is live', async () => {
    // Deny by default for the sweeping role too: it sees only rows already past the floor, so a
    // sweep with a bug in its WHERE clause removes nothing rather than removing a live record.
    for (const table of TABLES) {
      const res = await t.asRetention((db) => db.query(`SELECT id FROM ${table}`));
      expect(res.rows, table).toHaveLength(0);
    }
  });

  it('lets the retention role delete once the profile is past the purge floor', async () => {
    // `16` promises personal data physically gone within thirty days. These four tables hold the
    // most sensitive data in the product, so a missing grant here would be a promise quietly
    // broken for exactly the data it matters most for.
    await t.asService((db) =>
      db.query(`UPDATE profile SET deleted_at = now() - interval '40 days' WHERE id = $1`, [
        PROFILE,
      ]),
    );
    // Children first, which is the order `db/src/retention.ts` sweeps in and the reason it is
    // written out there rather than left to the foreign keys: deleting `health_record` first
    // cascades into `health_observation`, and a sweep that let a cascade do its work would be
    // issuing that delete as the table's owner rather than as this role.
    const PURGE_ORDER = [
      'health_observation',
      'health_record',
      'health_measurement',
      'health_source',
    ] as const;
    try {
      for (const table of PURGE_ORDER) {
        const before = await t.asRetention((db) => db.query(`SELECT id FROM ${table}`));
        expect(before.rows.length, table).toBeGreaterThan(0);
        await expect(
          t.asRetention((db) => db.query(`DELETE FROM ${table}`)),
        ).resolves.toBeDefined();
        const after = await t.asRetention((db) => db.query(`SELECT id FROM ${table}`));
        expect(after.rows, table).toHaveLength(0);
      }
    } finally {
      await t.asService((db) =>
        db.query('UPDATE profile SET deleted_at = NULL WHERE id = $1', [PROFILE]),
      );
    }
  });
});
