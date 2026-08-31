import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Database-level tests for Medicine Reconciliation (migration `0011`).
 *
 * Spec 04 Phase 8.5's exit criterion - "Kynviora never chooses which conflicting instruction is
 * medically correct" - is asserted here against the schema rather than against the API, because
 * the API is not the only thing that can write these rows. The two mechanisms that carry it are
 * both structural: `reconciliation_difference` has two value columns and no third one for an
 * answer, and every settled member of the resolution vocabulary names a person or a document.
 * Neither can be worked around by a direct SQL statement, which is the point.
 *
 * Every assertion runs as the non-superuser `kynviora_app` or `kynviora_service` role (DEC-005).
 */

const OWNER = testUuid(1);
const OTHER_OWNER = testUuid(2);
const VIEW_CAREGIVER = testUuid(3);
const SHELF_CAREGIVER = testUuid(4);
const STRANGER = testUuid(5);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);
const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

const ITEM_A = testUuid(30);

const NOW = '2026-08-29T12:00:00.000Z';
const LATER = '2026-08-29T12:30:00.000Z';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER_OWNER, 'other@example.test'],
      [VIEW_CAREGIVER, 'viewer@example.test'],
      [SHELF_CAREGIVER, 'shelf@example.test'],
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
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, strength_text)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet A', '500 mg')`,
      [ITEM_A, PROFILE_A],
    );
  });
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM reconciliation_difference');
    await db.query('DELETE FROM reconciliation');
    await db.query('DELETE FROM caregiver_grant');
  });
});

async function grant(userId: string, capabilities: string[], profileId = PROFILE_A) {
  await t.asService((db) =>
    db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
      [profileId, userId, OWNER, capabilities],
    ),
  );
}

async function reconciliation(
  overrides: { profileId?: string; operationId?: string | null } = {},
): Promise<string> {
  const res = await t.asService((db) =>
    db.query<{ id: string }>(
      `INSERT INTO reconciliation
         (profile_id, started_by_user_id, state, source_kind, started_at, client_operation_id)
       VALUES ($1, $2, 'OPEN', 'DISCHARGE', $3, $4)
       RETURNING id`,
      [overrides.profileId ?? PROFILE_A, OWNER, NOW, overrides.operationId ?? null],
    ),
  );
  return res.rows[0]?.id ?? '';
}

/** A FIELD_DIFFERS row: the shelf says 500 mg, the new list says 250 mg. */
async function difference(
  reconciliationId: string,
  overrides: { kind?: string; field?: string | null; ownedItemId?: string | null } = {},
): Promise<string> {
  const kind = overrides.kind ?? 'FIELD_DIFFERS';
  const field = overrides.field === undefined ? 'strengthText' : overrides.field;
  const carriesValues = kind === 'FIELD_DIFFERS';
  const res = await t.asService((db) =>
    db.query<{ id: string }>(
      `INSERT INTO reconciliation_difference
         (reconciliation_id, difference_kind, match_key, display_name, owned_item_id,
          field_path, previous_value, current_value)
       VALUES ($1, $2, $3, 'Synthetic Tablet A', $4, $5, $6, $7)
       RETURNING id`,
      [
        reconciliationId,
        kind,
        ITEM_A,
        overrides.ownedItemId === undefined ? ITEM_A : overrides.ownedItemId,
        field,
        carriesValues ? '500 mg' : null,
        carriesValues ? '250 mg' : null,
      ],
    ),
  );
  return res.rows[0]?.id ?? '';
}

/** Settle a difference by direct statement, so the constraints are what is under test. */
async function settle(
  differenceId: string,
  values: {
    resolution: string;
    adoptedSide?: string | null;
    confirmedBy?: string | null;
    attributed?: boolean;
  },
) {
  const attributed = values.attributed ?? true;
  return t.asService((db) =>
    db.query(
      `UPDATE reconciliation_difference
          SET resolution = $1, adopted_side = $2, confirmed_by = $3,
              resolved_at = $4, resolved_by_user_id = $5
        WHERE id = $6`,
      [
        values.resolution,
        values.adoptedSide ?? null,
        values.confirmedBy ?? null,
        attributed ? LATER : null,
        attributed ? OWNER : null,
        differenceId,
      ],
    ),
  );
}

// ---------------------------------------------------------------------------

describe('the schema has nowhere to record an answer', () => {
  it('has two value columns and no third one naming a winner', async () => {
    // The exit criterion asserted against the table itself. A column named here would make
    // "Kynviora chose" writable, and everything above it would eventually write it.
    const columns = await t.asService((db) =>
      db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'reconciliation_difference'`,
      ),
    );
    const names = columns.rows.map((row) => row.column_name);

    expect(names).toContain('previous_value');
    expect(names).toContain('current_value');
    for (const forbidden of [
      'suggested_value',
      'preferred_value',
      'recommended_value',
      'correct_value',
      'chosen_value',
      'winner',
      'confidence',
      'score',
      'severity',
      'urgency',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('refuses a resolution that says the system decided', async () => {
    const id = await difference(await reconciliation());
    for (const invented of ['AUTO_RESOLVED', 'SYSTEM_CHOSE', 'RECOMMENDED', 'BEST_GUESS']) {
      const message = await expectDenied(() =>
        settle(id, { resolution: invented, adoptedSide: 'CURRENT' }),
      );
      // Two constraints refuse it, and either message is the right answer: the vocabulary does
      // not contain the value, and the side-agreement rule enumerates the members it does.
      expect(message).toMatch(/difference_resolution_valid|difference_resolution_matches_side/);
    }
  });

  it('has no member of the resolution vocabulary that names the software', async () => {
    // Asserted against the constraint text rather than by attempting a write, because the point
    // is that no such member exists - not merely that this one spelling is refused.
    const definitions = await t.asService((db) =>
      db.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'reconciliation_difference'::regclass
            AND conname = 'difference_resolution_valid'`,
      ),
    );
    const definition = definitions.rows[0]?.definition ?? '';
    expect(definition).toContain('CONFIRMED_WITH_PHARMACIST');
    for (const forbidden of ['AUTO', 'SYSTEM', 'RECOMMEND', 'SUGGEST', 'BEST_GUESS', 'KYNVIORA']) {
      expect(definition.toUpperCase()).not.toContain(forbidden);
    }
  });

  it('refuses a difference kind that names a change to the medicine', async () => {
    // ADDED / REMOVED / CHANGED are claims about the medicine. What Kynviora knows is a fact
    // about the two lists, and the vocabulary says only that (DEC-029).
    const reconciliationId = await reconciliation();
    for (const invented of ['ADDED', 'REMOVED', 'CHANGED', 'STOPPED']) {
      const message = await expectDenied(() =>
        difference(reconciliationId, { kind: invented, field: null }),
      );
      expect(message).toMatch(/difference_kind_valid/);
    }
  });
});

describe('a settled difference names a side, and a confirmation names a person', () => {
  it('refuses a professional confirmation with nobody named', async () => {
    const id = await difference(await reconciliation());
    const message = await expectDenied(() =>
      settle(id, { resolution: 'CONFIRMED_WITH_PHARMACIST', adoptedSide: 'CURRENT' }),
    );
    expect(message).toMatch(/difference_confirmation_names_someone/);
  });

  it('refuses a professional confirmation named only with whitespace', async () => {
    const id = await difference(await reconciliation());
    const message = await expectDenied(() =>
      settle(id, {
        resolution: 'CONFIRMED_WITH_PRESCRIBER',
        adoptedSide: 'CURRENT',
        confirmedBy: '   ',
      }),
    );
    expect(message).toMatch(/difference_confirmation_names_someone/);
  });

  it('refuses a settled difference that names neither value', async () => {
    // Defaulting to the newer list would be the software deciding which instruction is correct.
    const id = await difference(await reconciliation());
    const message = await expectDenied(() =>
      settle(id, {
        resolution: 'CONFIRMED_FROM_DOCUMENT',
        adoptedSide: null,
      }),
    );
    expect(message).toMatch(/difference_settled_has_side/);
  });

  it('refuses an unresolved difference that carries a side', async () => {
    const id = await difference(await reconciliation());
    const message = await expectDenied(() =>
      settle(id, { resolution: 'STILL_UNRESOLVED', adoptedSide: 'CURRENT' }),
    );
    expect(message).toMatch(/difference_settled_has_side|difference_resolution_matches_side/);
  });

  it('refuses a resolution that contradicts the side it names', async () => {
    const id = await difference(await reconciliation());
    for (const [resolution, side] of [
      ['USER_KEPT_PREVIOUS', 'CURRENT'],
      ['USER_ADOPTED_CURRENT', 'PREVIOUS'],
    ] as const) {
      const message = await expectDenied(() => settle(id, { resolution, adoptedSide: side }));
      expect(message).toMatch(/difference_resolution_matches_side/);
    }
  });

  it('refuses a resolution with no recorded actor or time', async () => {
    const id = await difference(await reconciliation());
    const message = await expectDenied(() =>
      settle(id, {
        resolution: 'USER_ADOPTED_CURRENT',
        adoptedSide: 'CURRENT',
        attributed: false,
      }),
    );
    expect(message).toMatch(/difference_resolved_is_attributed/);
  });

  it('accepts a professional confirming the previous value', async () => {
    // The case the whole design exists for: a pharmacist may well confirm the older dose, and a
    // schema that could not record that would be forcing the newer list to win.
    const id = await difference(await reconciliation());
    await settle(id, {
      resolution: 'CONFIRMED_WITH_PHARMACIST',
      adoptedSide: 'PREVIOUS',
      confirmedBy: 'Priya at the pharmacy',
    });

    const stored = await t.asService((db) =>
      db.query<{ adopted_side: string; previous_value: string; current_value: string }>(
        'SELECT adopted_side, previous_value, current_value FROM reconciliation_difference WHERE id = $1',
        [id],
      ),
    );
    expect(stored.rows[0]?.adopted_side).toBe('PREVIOUS');
    // Both sides survive the resolution. The record says what disagreed, not just what won.
    expect(stored.rows[0]?.previous_value).toBe('500 mg');
    expect(stored.rows[0]?.current_value).toBe('250 mg');
  });

  it('accepts a difference left open, with a note and no side', async () => {
    const id = await difference(await reconciliation());
    await settle(id, { resolution: 'STILL_UNRESOLVED', adoptedSide: null });

    const stored = await t.asService((db) =>
      db.query<{ resolution: string; adopted_side: string | null }>(
        'SELECT resolution, adopted_side FROM reconciliation_difference WHERE id = $1',
        [id],
      ),
    );
    expect(stored.rows[0]?.resolution).toBe('STILL_UNRESOLVED');
    expect(stored.rows[0]?.adopted_side).toBeNull();
  });
});

describe('only a real disagreement can be settled', () => {
  it('refuses a resolution on a medicine that matched', async () => {
    const id = await difference(await reconciliation(), { kind: 'MATCHES', field: null });
    const message = await expectDenied(() =>
      settle(id, { resolution: 'USER_ADOPTED_CURRENT', adoptedSide: 'CURRENT' }),
    );
    expect(message).toMatch(/difference_matches_is_not_resolvable/);
  });

  it('refuses a field difference that does not name a field', async () => {
    const reconciliationId = await reconciliation();
    const message = await expectDenied(() =>
      difference(reconciliationId, { kind: 'FIELD_DIFFERS', field: null }),
    );
    expect(message).toMatch(/difference_fields_match_kind/);
  });

  it('refuses a whole-medicine difference that carries field values', async () => {
    // ONLY_IN_PREVIOUS is a fact about the lists, not about a field. Values on such a row would
    // invite a screen to render a comparison that was never made.
    const reconciliationId = await reconciliation();
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO reconciliation_difference
             (reconciliation_id, difference_kind, match_key, display_name, field_path,
              previous_value, current_value)
           VALUES ($1, 'ONLY_IN_PREVIOUS', $2, 'Synthetic Tablet A', 'strengthText',
                   '500 mg', NULL)`,
          [reconciliationId, ITEM_A],
        ),
      ),
    );
    expect(message).toMatch(/difference_fields_match_kind/);
  });
});

describe('a reconciliation may end with open questions', () => {
  it('refuses a completed reconciliation that does not say how many are open', async () => {
    // 04 Phase 8.5 lists unresolved differences as expected output, so the count is part of the
    // result rather than an error state - and a completed row must carry it.
    const id = await reconciliation();
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(`UPDATE reconciliation SET state = 'COMPLETED', completed_at = $1 WHERE id = $2`, [
          LATER,
          id,
        ]),
      ),
    );
    expect(message).toMatch(/reconciliation_completed_complete/);
  });

  it('refuses an open reconciliation that claims to have finished', async () => {
    const id = await reconciliation();
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query('UPDATE reconciliation SET completed_at = $1 WHERE id = $2', [LATER, id]),
      ),
    );
    expect(message).toMatch(/reconciliation_open_is_unfinished/);
  });

  it('accepts a completion that leaves differences unresolved', async () => {
    const id = await reconciliation();
    await t.asService((db) =>
      db.query(
        `UPDATE reconciliation
            SET state = 'COMPLETED', completed_at = $1, unresolved_count = 2
          WHERE id = $2`,
        [LATER, id],
      ),
    );
    const stored = await t.asService((db) =>
      db.query<{ state: string; unresolved_count: number }>(
        'SELECT state, unresolved_count FROM reconciliation WHERE id = $1',
        [id],
      ),
    );
    expect(stored.rows[0]).toMatchObject({ state: 'COMPLETED', unresolved_count: 2 });
  });

  it('refuses a state or source kind outside the vocabulary', async () => {
    const id = await reconciliation();
    const state = await expectDenied(() =>
      t.asService((db) =>
        db.query(`UPDATE reconciliation SET state = 'RESOLVED_BY_APP' WHERE id = $1`, [id]),
      ),
    );
    expect(state).toMatch(/reconciliation_state_valid/);

    const source = await expectDenied(() =>
      t.asService((db) =>
        db.query(`UPDATE reconciliation SET source_kind = 'GUESSED' WHERE id = $1`, [id]),
      ),
    );
    expect(source).toMatch(/reconciliation_source_kind_valid/);
  });

  it('refuses a replayed client operation', async () => {
    const operationId = testUuid(80);
    await reconciliation({ operationId });
    const message = await expectDenied(() => reconciliation({ operationId }));
    expect(message).toMatch(/reconciliation_operation_idx|duplicate key/i);
  });
});

describe('the comparison outlives the shelf row it referred to', () => {
  it('keeps the difference when the medicine is deleted, and forgets the link', async () => {
    // ON DELETE SET NULL rather than CASCADE: what two lists said about a medicine is a fact
    // about a past reconciliation, and deleting the pack does not make it untrue.
    const temporary = testUuid(31);
    await t.asService((db) =>
      db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
         VALUES ($1, $2, 'MEDICINE', 'Temporary')`,
        [temporary, PROFILE_A],
      ),
    );
    const id = await difference(await reconciliation(), { ownedItemId: temporary });
    await t.asOwner((db) => db.query('DELETE FROM owned_item WHERE id = $1', [temporary]));

    const stored = await t.asService((db) =>
      db.query<{ owned_item_id: string | null; previous_value: string }>(
        'SELECT owned_item_id, previous_value FROM reconciliation_difference WHERE id = $1',
        [id],
      ),
    );
    expect(stored.rows[0]?.owned_item_id).toBeNull();
    expect(stored.rows[0]?.previous_value).toBe('500 mg');
  });

  it('removes the differences when the reconciliation itself is deleted', async () => {
    const reconciliationId = await reconciliation();
    await difference(reconciliationId);
    await t.asOwner((db) =>
      db.query('DELETE FROM reconciliation WHERE id = $1', [reconciliationId]),
    );

    const remaining = await t.asService((db) =>
      db.query('SELECT id FROM reconciliation_difference WHERE reconciliation_id = $1', [
        reconciliationId,
      ]),
    );
    expect(remaining.rows).toEqual([]);
  });
});

describe('privilege separation', () => {
  it('does not let the app role start a reconciliation', async () => {
    const message = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `INSERT INTO reconciliation (profile_id, started_by_user_id, started_at)
           VALUES ($1, $2, $3)`,
          [PROFILE_A, OWNER, NOW],
        ),
      ),
    );
    expect(message).toMatch(/permission denied|row-level security/i);
  });

  it('does not let the app role settle a difference by direct write', async () => {
    // Settling is a recorded decision with an actor and a time. A client that could write it
    // directly could record a decision nobody made, which is the exit criterion by another route.
    const id = await difference(await reconciliation());
    const message = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `UPDATE reconciliation_difference SET resolution = 'USER_ADOPTED_CURRENT' WHERE id = $1`,
          [id],
        ),
      ),
    );
    expect(message).toMatch(/permission denied|row-level security/i);
  });
});

describe('row level security', () => {
  it('shows a reconciliation to a caregiver holding VIEW_MEDICINES', async () => {
    const reconciliationId = await reconciliation();
    await difference(reconciliationId);
    await grant(VIEW_CAREGIVER, ['VIEW_MEDICINES']);

    const rows = await t.asUser(VIEW_CAREGIVER, (db) => db.query('SELECT id FROM reconciliation'));
    const differences = await t.asUser(VIEW_CAREGIVER, (db) =>
      db.query('SELECT id FROM reconciliation_difference'),
    );
    expect(rows.rows).toHaveLength(1);
    expect(differences.rows).toHaveLength(1);
  });

  it('shows nothing to a caregiver who may see the shelf but not medicines', async () => {
    // 03 group H keeps medicines behind their own capability, and a reconciliation shows every
    // direction line the household holds - it is among the most revealing screens in the product.
    const reconciliationId = await reconciliation();
    await difference(reconciliationId);
    await grant(SHELF_CAREGIVER, ['VIEW_SHELF', 'VIEW_CARE']);

    const rows = await t.asUser(SHELF_CAREGIVER, (db) => db.query('SELECT id FROM reconciliation'));
    const differences = await t.asUser(SHELF_CAREGIVER, (db) =>
      db.query('SELECT id FROM reconciliation_difference'),
    );
    expect(rows.rows).toEqual([]);
    expect(differences.rows).toEqual([]);
  });

  it('shows nothing to a stranger or another household', async () => {
    const reconciliationId = await reconciliation();
    await difference(reconciliationId);

    for (const user of [STRANGER, OTHER_OWNER]) {
      const rows = await t.asUser(user, (db) => db.query('SELECT id FROM reconciliation'));
      const differences = await t.asUser(user, (db) =>
        db.query('SELECT id FROM reconciliation_difference'),
      );
      expect(rows.rows).toEqual([]);
      expect(differences.rows).toEqual([]);
    }
  });

  it('scopes a difference by the reconciliation it belongs to, not by its own row', async () => {
    // The difference policy joins back to the parent. Without that, a row naming an owned_item
    // the caller cannot read would still be listed, and the values are the sensitive part.
    const mine = await reconciliation();
    const theirs = await reconciliation({ profileId: PROFILE_B });
    await difference(mine);
    await t.asService((db) =>
      db.query(
        `INSERT INTO reconciliation_difference
           (reconciliation_id, difference_kind, match_key, display_name, field_path,
            previous_value, current_value)
         VALUES ($1, 'FIELD_DIFFERS', 'other', 'Synthetic Tablet B', 'strengthText',
                 '10 mg', '20 mg')`,
        [theirs],
      ),
    );

    const visible = await t.asUser(OWNER, (db) =>
      db.query<{ display_name: string }>('SELECT display_name FROM reconciliation_difference'),
    );
    expect(visible.rows.map((row) => row.display_name)).toEqual(['Synthetic Tablet A']);
  });
});
