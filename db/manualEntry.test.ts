import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Database-level tests for manual entry (migrations `0015` and `0016`).
 *
 * `04` Phases 2.2 and 2.3 are decided in `@kynviora/domain` and enforced on the write path. What
 * the schema has to carry is narrower and is what these assert: that an absent field is stored as
 * an absence rather than as a default, that a transcribed barcode has the shape a barcode has,
 * and that one save arriving twice writes one row.
 *
 * Every assertion runs as the non-superuser `kynviora_app` or `kynviora_service` role (DEC-005).
 */

const OWNER = testUuid(1);
const OTHER = testUuid(2);
const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const OTHER_PROFILE = testUuid(21);

let t: TestDb;

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
    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'Household')`,
      [HOUSEHOLD, OWNER],
    );
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Other (synthetic)')`,
      [OTHER_PROFILE, HOUSEHOLD, OTHER],
    );
  });
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.asOwner((db) => db.query('DELETE FROM owned_item'));
});

/** The columns `0015` added, plus the ones `0004` already had that the form also collects. */
const MANUAL_COLUMNS = [
  'brand',
  'manufacturer',
  'market',
  'recorded_gtin',
  'recorded_lot_code',
  'expires_on',
  'started_on',
  'notes',
  'strength_text',
  'dosage_form',
  'directions_text',
  'personal_care_category',
  'ingredient_declaration_raw',
  'label_version_note',
] as const;

describe('exit criterion 2.2b - a missing field stays explicitly unknown', () => {
  it('gives no manual-entry column a DEFAULT and makes none of them NOT NULL', () => {
    // The exit criterion as a schema property rather than as a behaviour. A DEFAULT added later
    // would silently turn every absence into an answer, on every row, without a line of
    // application code changing - and nothing on the write path would notice.
    return t.asService(async (db) => {
      const result = await db.query<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'owned_item' AND column_name = ANY($1::text[])`,
        [[...MANUAL_COLUMNS]],
      );

      expect(result.rows.length).toBe(MANUAL_COLUMNS.length);
      for (const row of result.rows) {
        expect(row.is_nullable, row.column_name).toBe('YES');
        expect(row.column_default, row.column_name).toBeNull();
      }
    });
  });

  it('stores a row with nothing but a name', async () => {
    await t.asUser(OWNER, (db) =>
      db.query(
        `INSERT INTO owned_item (profile_id, item_kind, display_name)
         VALUES ($1, 'MEDICINE', 'Synthetic Tablet')`,
        [PROFILE],
      ),
    );

    const row = await t.asService((db) =>
      db.query<Record<string, unknown>>('SELECT * FROM owned_item'),
    );
    for (const column of MANUAL_COLUMNS) {
      if (column === 'brand') continue;
      expect(row.rows[0]?.[column], column).toBeNull();
    }
    // And the three axes are UNVERIFIED, which is the vocabulary's word for "nobody has checked"
    // rather than a default answer (`08`).
    expect(row.rows[0]?.['identity_verification']).toBe('UNVERIFIED');
  });

  it('refuses a row of spaces where an absence is meant', async () => {
    // A value a screen renders as an answer. `0015`'s CHECK is the last line of defence: the
    // domain turns blank into NULL, and this makes a bug that skipped it fail loudly.
    for (const column of [
      'manufacturer',
      'recorded_lot_code',
      'ingredient_declaration_raw',
      'label_version_note',
    ] as const) {
      const message = await expectDenied(() =>
        t.asUser(OWNER, (db) =>
          db.query(
            `INSERT INTO owned_item (profile_id, item_kind, display_name, ${column})
             VALUES ($1, 'MEDICINE', 'Synthetic Tablet', '   ')`,
            [PROFILE],
          ),
        ),
      );
      expect(message, column).toMatch(/owned_item_manual_text_not_blank/);
    }
  });
});

describe('a transcribed barcode has the shape a barcode has', () => {
  it('accepts the four GTIN lengths and refuses everything else', async () => {
    for (const gtin of ['12345678', '123456789012', '1234567890128', '12345678901231']) {
      await t.asUser(OWNER, (db) =>
        db.query(
          `INSERT INTO owned_item (profile_id, item_kind, display_name, recorded_gtin)
           VALUES ($1, 'MEDICINE', 'Synthetic Tablet', $2)`,
          [PROFILE, gtin],
        ),
      );
    }

    for (const bad of ['1234567', '12345 678', 'ABCDEFGH', '123456789012345']) {
      const message = await expectDenied(() =>
        t.asUser(OWNER, (db) =>
          db.query(
            `INSERT INTO owned_item (profile_id, item_kind, display_name, recorded_gtin)
             VALUES ($1, 'MEDICINE', 'Synthetic Tablet', $2)`,
            [PROFILE, bad],
          ),
        ),
      );
      expect(message, bad).toMatch(/owned_item_recorded_gtin_shape/);
    }
  });

  it('keeps the recorded barcode out of the catalog', async () => {
    // `15` A11 with the attacker replaced by an honest person mis-reading a label. The column is
    // on `owned_item` and writing it creates no `product_identity` - which is a property of where
    // the column lives, and this is the assertion that it still lives there.
    await t.asUser(OWNER, (db) =>
      db.query(
        `INSERT INTO owned_item (profile_id, item_kind, display_name, recorded_gtin)
         VALUES ($1, 'MEDICINE', 'Synthetic Tablet', '1234567890128')`,
        [PROFILE],
      ),
    );

    const catalog = await t.asService((db) =>
      db.query<{ n: string }>('SELECT count(*)::text AS n FROM product_identity'),
    );
    expect(catalog.rows[0]?.n).toBe('0');
  });
});

describe('migration 0016 - one save arriving twice writes one row', () => {
  const KEY = testUuid(900);

  const insert = (profileId: string, name: string, key: string | null) =>
    t.asUser(OWNER, (db) =>
      db.query(
        `INSERT INTO owned_item (profile_id, item_kind, display_name, client_operation_id)
         VALUES ($1, 'MEDICINE', $2, $3)`,
        [profileId, name, key],
      ),
    );

  it('refuses the same key twice on one profile', async () => {
    await insert(PROFILE, 'Synthetic Tablet', KEY);
    const message = await expectDenied(() => insert(PROFILE, 'Synthetic Tablet', KEY));
    expect(message).toMatch(/owned_item_idempotency|duplicate key/i);
  });

  it('allows the same key on two profiles', async () => {
    // Scoped to the profile, not global. A globally unique key lets one household's key refuse
    // another household's write, whose replay read then finds nothing under row-level security -
    // so their item is dropped and answered with a success carrying no ID (`DEV-031`).
    await insert(PROFILE, 'Mine', KEY);
    await t.asUser(OTHER, (db) =>
      db.query(
        `INSERT INTO owned_item (profile_id, item_kind, display_name, client_operation_id)
         VALUES ($1, 'MEDICINE', 'Theirs', $2)`,
        [OTHER_PROFILE, KEY],
      ),
    );

    const count = await t.asService((db) =>
      db.query<{ n: string }>('SELECT count(*)::text AS n FROM owned_item'),
    );
    expect(count.rows[0]?.n).toBe('2');
  });

  it('allows any number of rows with no key at all', async () => {
    // The index is partial, so every row this build already created - seeded, synced, fixtures -
    // is outside it. An absent key is not a key everybody shares.
    await insert(PROFILE, 'One', null);
    await insert(PROFILE, 'Two', null);
    await insert(PROFILE, 'Three', null);

    const count = await t.asService((db) =>
      db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM owned_item WHERE client_operation_id IS NULL',
      ),
    );
    expect(count.rows[0]?.n).toBe('3');
  });

  it('holds the guarantee in the index rather than in the route', async () => {
    // The index is what makes the retry safe, so its shape is asserted rather than assumed: a
    // future migration that dropped the predicate or widened the columns would pass every
    // application test and quietly change what a second tap does.
    const index = await t.asService((db) =>
      db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'owned_item' AND indexname = 'owned_item_idempotency'`,
      ),
    );

    const definition = index.rows[0]?.indexdef ?? '';
    expect(definition).toMatch(/UNIQUE/i);
    expect(definition).toMatch(/profile_id/);
    expect(definition).toMatch(/client_operation_id/);
    expect(definition).toMatch(/WHERE .*client_operation_id IS NOT NULL/i);
  });
});

describe('the version column an edit is conditional on', () => {
  /**
   * `13` sets `owned_item`'s conflict policy to `ASK_USER`, and `PATCH /v1/items/:itemId` writes
   * `version = version + 1` inside the same statement that tests it. That only works while
   * nothing else moves the column.
   */

  const insert = (name: string) =>
    t.asUser(OWNER, (db) =>
      db.query<{ id: string; version: number }>(
        `INSERT INTO owned_item (profile_id, item_kind, display_name)
         VALUES ($1, 'MEDICINE', $2)
         RETURNING id, version`,
        [PROFILE, name],
      ),
    );

  it('starts at 1', async () => {
    const inserted = await insert('Synthetic Tablet');
    expect(inserted.rows[0]?.version).toBe(1);
  });

  it('is not moved by the touch trigger', async () => {
    // `owned_item_touch` sets `updated_at` and nothing else. A trigger that also bumped the
    // version would double-count every conditional write, and the route would be reporting a
    // version no client had ever seen.
    const inserted = await insert('Synthetic Tablet');
    const id = inserted.rows[0]?.id ?? '';

    await t.asUser(OWNER, (db) =>
      db.query(`UPDATE owned_item SET notes = 'A note.' WHERE id = $1`, [id]),
    );

    const after = await t.asService((db) =>
      db.query<{ version: number; updated_at: Date }>(
        'SELECT version, updated_at FROM owned_item WHERE id = $1',
        [id],
      ),
    );
    expect(after.rows[0]?.version).toBe(1);
    expect(after.rows[0]?.updated_at).toBeDefined();
  });

  it('makes a conditional write on a stale version affect no rows', async () => {
    // The mechanism itself, at the layer that provides it. Two writers, one condition: the second
    // changes nothing rather than overwriting the first.
    const inserted = await insert('Synthetic Tablet');
    const id = inserted.rows[0]?.id ?? '';

    const first = await t.asUser(OWNER, (db) =>
      db.query(
        `UPDATE owned_item SET notes = 'First.', version = version + 1
          WHERE id = $1 AND version = $2 RETURNING version`,
        [id, 1],
      ),
    );
    expect(first.rows.length).toBe(1);

    const second = await t.asUser(OWNER, (db) =>
      db.query(
        `UPDATE owned_item SET notes = 'Second.', version = version + 1
          WHERE id = $1 AND version = $2 RETURNING version`,
        [id, 1],
      ),
    );
    expect(second.rows.length).toBe(0);

    const stored = await t.asService((db) =>
      db.query<{ notes: string; version: number }>(
        'SELECT notes, version FROM owned_item WHERE id = $1',
        [id],
      ),
    );
    expect(stored.rows[0]?.notes).toBe('First.');
    expect(stored.rows[0]?.version).toBe(2);
  });

  it('refuses a stopped date before the started date', async () => {
    // `owned_item_dates_ordered`. The domain refuses it first and names the field; this is what
    // makes that a second line of defence rather than the only one.
    const inserted = await insert('Synthetic Tablet');
    const id = inserted.rows[0]?.id ?? '';

    await t.asUser(OWNER, (db) =>
      db.query(`UPDATE owned_item SET started_on = '2026-08-01' WHERE id = $1`, [id]),
    );

    const message = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `UPDATE owned_item SET lifecycle_state = 'STOPPED', stopped_on = '2026-06-01'
            WHERE id = $1`,
          [id],
        ),
      ),
    );
    expect(message).toMatch(/owned_item_dates_ordered/);
  });
});
