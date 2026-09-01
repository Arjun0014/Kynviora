import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';
import { SAFETY_RESOLUTIONS } from '@kynviora/domain';

/**
 * Database-level tests for the Safety Receipt (migration `0006`).
 *
 * The schema is the authority for what a person may record and how many times, and Phase 7.6's
 * code reads a copy of that vocabulary. These tests read the constraint out of the catalog rather
 * than trusting either, so adding a member in one place fails loudly instead of producing a value
 * the other refuses.
 *
 * They also pin the two schema facts the API design rests on: one receipt per alert, and no
 * INSERT for the app role. Both are load-bearing - the first is why a resolution replaces rather
 * than appends (DEC-075), and the second is why creating a receipt is privileged.
 *
 * Every assertion runs as the non-superuser `kynviora_app` or `kynviora_service` role (DEC-005).
 */

const OWNER = testUuid(1);
const OTHER = testUuid(2);
const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const ITEM = testUuid(30);
const RULE = testUuid(40);

const NOW = '2026-09-01T12:00:00.000Z';

let t: TestDb;
let alertId = '';
let assessmentId = '';

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER, 'other@example.test'],
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
       VALUES ($1, $2, $3, 'Parent A (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet')`,
      [ITEM, PROFILE],
    );
    await db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id)
       VALUES ($1, 'synthetic.receipt', '1.0.0', 'EXPIRY', 'A', 'HIGH',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.expiry')`,
      [RULE],
    );

    const assessment = await db.query<{ id: string }>(
      `INSERT INTO profile_assessment
         (profile_id, owned_item_id, rule_version_id, matched, match_confidence, reasons,
          evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at)
       VALUES ($1, $2, $3, true, 'EXACT', ARRAY['PRODUCT_EXPIRED']::text[], 'A', 'HIGH',
               'tpl.expiry', 'norm-1', $4)
       RETURNING id`,
      [PROFILE, ITEM, RULE, NOW],
    );
    assessmentId = assessment.rows[0]?.id ?? '';

    const alert = await db.query<{ id: string }>(
      `INSERT INTO alert_publication (assessment_id, profile_id, published_at, dedupe_key)
       VALUES ($1, $2, $3, 'receipt-db') RETURNING id`,
      [assessmentId, PROFILE, NOW],
    );
    alertId = alert.rows[0]?.id ?? '';

    await db.query(
      `INSERT INTO safety_receipt (profile_id, alert_publication_id, assessment_id)
       VALUES ($1, $2, $3)`,
      [PROFILE, alertId, assessmentId],
    );
  });
});

afterAll(async () => {
  await t.close();
});

describe('the resolution vocabulary', () => {
  it('is exactly what the CHECK constraint admits', async () => {
    const definition = await t.asService((db) =>
      db.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conname = 'receipt_resolution_valid'`,
      ),
    );
    const def = definition.rows[0]?.def ?? '';
    expect(def).not.toBe('');

    // Read out of the catalog rather than out of the migration file, so a later ALTER cannot
    // drift from the code either.
    const inConstraint = [...def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(inConstraint)].sort()).toEqual([...SAFETY_RESOLUTIONS].sort());
  });

  it('refuses a member the domain does not have', async () => {
    // `09` forbids Kynviora recording that it told somebody to stop a medicine. The database is
    // the last line of that, not the first.
    await expectDenied(() =>
      t.asService((db) =>
        db.query(`UPDATE safety_receipt SET resolution = 'STOPPED_MEDICINE' WHERE id IS NOT NULL`),
      ),
    );
  });

  it('refuses a resolution with no time against it', async () => {
    await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `UPDATE safety_receipt SET resolution = 'REVIEWED', resolved_at = NULL
            WHERE alert_publication_id = $1`,
          [alertId],
        ),
      ),
    );
  });
});

describe('one receipt per alert', () => {
  it('refuses a second row for the same publication', async () => {
    // This is why a resolution replaces rather than appends (DEC-075), and why both routes that
    // write a receipt have to share one writer.
    await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO safety_receipt (profile_id, alert_publication_id, assessment_id)
           VALUES ($1, $2, $3)`,
          [PROFILE, alertId, assessmentId],
        ),
      ),
    );
  });

  it('is a unique index on the publication rather than on the pair', async () => {
    const indexes = await t.asService((db) =>
      db.query<{ def: string }>(
        `SELECT indexdef AS def FROM pg_indexes
          WHERE tablename = 'safety_receipt' AND indexname = 'receipt_publication_idx'`,
      ),
    );
    const def = indexes.rows[0]?.def ?? '';
    expect(def).toContain('UNIQUE');
    expect(def).toContain('alert_publication_id');
    // A unique index on (publication, resolution) would quietly turn the table append-only per
    // resolution and change what "what currently stands" means.
    expect(def).not.toContain('resolution');
  });
});

describe('what the app role may do to a receipt', () => {
  it('may not create one', async () => {
    // A person may resolve a receipt that exists, not create rows naming whichever alert and
    // assessment they like. That is why the first write is privileged.
    await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `INSERT INTO safety_receipt (profile_id, alert_publication_id, assessment_id)
           VALUES ($1, $2, $3)`,
          [PROFILE, alertId, assessmentId],
        ),
      ),
    );
  });

  it('may not delete one', async () => {
    await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query('DELETE FROM safety_receipt WHERE alert_publication_id = $1', [alertId]),
      ),
    );
  });

  it('may resolve one on a profile it holds VIEW_SAFETY on', async () => {
    const updated = await t.asUser(OWNER, (db) =>
      db.query<{ id: string }>(
        `UPDATE safety_receipt SET resolution = 'REVIEWED', resolved_at = $2
          WHERE alert_publication_id = $1 RETURNING id`,
        [alertId, NOW],
      ),
    );
    expect(updated.rows).toHaveLength(1);
  });

  it('sees nothing to resolve on a profile it holds nothing on', async () => {
    const updated = await t.asUser(OTHER, (db) =>
      db.query<{ id: string }>(
        `UPDATE safety_receipt SET resolution = 'NOT_APPLICABLE', resolved_at = $2
          WHERE alert_publication_id = $1 RETURNING id`,
        [alertId, NOW],
      ),
    );
    expect(updated.rows).toEqual([]);

    const readable = await t.asUser(OTHER, (db) =>
      db.query('SELECT id FROM safety_receipt WHERE alert_publication_id = $1', [alertId]),
    );
    expect(readable.rows).toEqual([]);
  });
});

describe('what a receipt cannot reach', () => {
  it('has no column naming a replacement for the assessment', async () => {
    const columns = await t.asService((db) =>
      db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'safety_receipt'`,
      ),
    );
    const names = columns.rows.map((r) => r.column_name);
    // Exit criterion 1 as a shape: there is nowhere on this row to record a change to the
    // assessment or to the alert, so a resolution cannot erase either even by direct SQL.
    for (const forbidden of [
      'assessment_state',
      'alert_state',
      'withdrawn',
      'corrected_assessment_id',
      'urgency',
      'evidence_level',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('leaves the app role no write on the assessment or the alert at all', async () => {
    await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(`UPDATE profile_assessment SET urgency = 'INFORMATIONAL' WHERE id = $1`, [
          assessmentId,
        ]),
      ),
    );
    await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(`UPDATE alert_publication SET state = 'WITHDRAWN' WHERE id = $1`, [alertId]),
      ),
    );
  });
});
