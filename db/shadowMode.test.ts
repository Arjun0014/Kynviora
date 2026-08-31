import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Database-level tests for shadow mode and replay (migration `0013`).
 *
 * Exit criterion 1 - "New high-impact rules can be evaluated without user notification" - is
 * asserted against the schema rather than against a code path, because a flag checked before
 * notifying only holds until somebody adds a second notification path. What is asserted instead
 * is that the tables do not connect: a shadow result is not a `profile_assessment`, so it cannot
 * become an `alert_publication`, and a sample has no column naming a person.
 *
 * Every assertion runs as the non-superuser `kynviora_app` or `kynviora_service` role (DEC-005).
 */

const STAFF = testUuid(1);
const OUTSIDER = testUuid(2);

const NOW = '2026-08-29T12:00:00.000Z';

let t: TestDb;
let ruleCounter = 300;

beforeAll(async () => {
  t = await createTestDb();
  await t.asService(async (db) => {
    for (const [id, email] of [
      [STAFF, 'staff@example.test'],
      [OUTSIDER, 'outsider@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
  });
});

afterAll(async () => {
  await t.close();
});

/** A candidate rule. `shadow_run` and `replay_run` are append-only, so fixtures are never reused. */
async function candidateRule(): Promise<string> {
  ruleCounter += 1;
  const id = testUuid(ruleCounter);
  await t.asService((db) =>
    db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id,
          shadow_mode)
       VALUES ($1, $2, '1.0.0', 'BATCH_ACTION_MATCH', 'A', 'HIGH',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_REPORTED']::text[], 'tpl.batch', true)`,
      [id, `synthetic.${id.slice(-6)}`],
    ),
  );
  return id;
}

async function shadowRun(
  ruleId: string,
  overrides: {
    datasetKind?: string;
    label?: string;
    datasetSize?: number;
    matchedItems?: number;
    users?: number;
  } = {},
): Promise<string> {
  const res = await t.asService((db) =>
    db.query<{ id: string }>(
      `INSERT INTO shadow_run
         (rule_version_id, dataset_kind, dataset_label, dataset_size, matched_items,
          affected_products, affected_formulations, potential_user_matches,
          reason_counts, evaluation_instant, normalization_version, run_by_user_id, run_at)
       VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $7::jsonb, $8, 'norm-1', $9, $8)
       RETURNING id`,
      [
        ruleId,
        overrides.datasetKind ?? 'SYNTHETIC',
        overrides.label ?? 'synthetic fixture',
        overrides.datasetSize ?? 10,
        overrides.matchedItems ?? 2,
        overrides.users ?? 2,
        JSON.stringify({ BATCH_CODE_MATCHED: 2 }),
        NOW,
        STAFF,
      ],
    ),
  );
  return res.rows[0]?.id ?? '';
}

// ---------------------------------------------------------------------------

describe('a shadow run has nobody to notify', () => {
  it('records no person on a sample', async () => {
    // Exit criterion 1 asserted against the actual table. A reviewer investigating a suspected
    // false positive needs the item, the reasons and the rule version (spec 10); the person is
    // not part of that, and what does not exist cannot be sent to.
    const columns = await t.asService((db) =>
      db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'shadow_run_sample'`,
      ),
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toContain('owned_item_id');
    for (const forbidden of [
      'profile_id',
      'user_id',
      'household_id',
      'email',
      'device_token',
      'notified_at',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('records a count of potential user matches and no list', async () => {
    const columns = await t.asService((db) =>
      db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'shadow_run'`,
      ),
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toContain('potential_user_matches');
    for (const forbidden of ['matched_profile_ids', 'recipients', 'profile_ids']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('has no path from a shadow result to a published alert', async () => {
    // The structural half. alert_publication requires an assessment_id referencing
    // profile_assessment, and a shadow result is not a profile_assessment - so there is no
    // column anywhere that could carry a dry run into a notification.
    const references = await t.asService((db) =>
      db.query<{ referenced: string }>(
        `SELECT ccu.table_name AS referenced
           FROM information_schema.table_constraints tc
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name
          WHERE tc.table_name = 'alert_publication' AND tc.constraint_type = 'FOREIGN KEY'`,
      ),
    );
    const referenced = references.rows.map((row) => row.referenced);
    expect(referenced).not.toContain('shadow_run');
    expect(referenced).not.toContain('shadow_run_sample');
  });

  it('is not readable by the app role', async () => {
    for (const table of ['shadow_run', 'shadow_run_sample', 'replay_run']) {
      const message = await expectDenied(() =>
        t.asUser(OUTSIDER, (db) => db.query(`SELECT 1 FROM ${table}`)),
      );
      expect(message).toMatch(/permission denied/i);
    }
  });
});

describe('a run has to be internally consistent', () => {
  it('refuses more matches than rows', async () => {
    // A reviewer would be reading a blast radius that never happened.
    const rule = await candidateRule();
    const message = await expectDenied(() => shadowRun(rule, { datasetSize: 5, matchedItems: 6 }));
    expect(message).toMatch(/shadow_matches_within_dataset/);
  });

  it('refuses more affected users than matched items', async () => {
    const rule = await candidateRule();
    const message = await expectDenied(() =>
      shadowRun(rule, { datasetSize: 10, matchedItems: 2, users: 3 }),
    );
    expect(message).toMatch(/shadow_users_within_matches/);
  });

  it('refuses a dataset kind outside the vocabulary', async () => {
    const rule = await candidateRule();
    const message = await expectDenied(() => shadowRun(rule, { datasetKind: 'PRODUCTION' }));
    expect(message).toMatch(/shadow_dataset_kind_valid/);
  });

  it('refuses an unlabelled dataset', async () => {
    // A run nobody can identify the input of is a number without a provenance.
    const rule = await candidateRule();
    const message = await expectDenied(() => shadowRun(rule, { label: '   ' }));
    expect(message).toMatch(/shadow_dataset_label_not_blank/);
  });

  it('accepts a run that matched nothing', async () => {
    const rule = await candidateRule();
    const id = await shadowRun(rule, { datasetSize: 10, matchedItems: 0, users: 0 });
    const stored = await t.asService((db) =>
      db.query<{ dataset_size: number; matched_items: number }>(
        'SELECT dataset_size, matched_items FROM shadow_run WHERE id = $1',
        [id],
      ),
    );
    expect(stored.rows[0]).toMatchObject({ dataset_size: 10, matched_items: 0 });
  });

  it('cannot be deleted', async () => {
    const rule = await candidateRule();
    const id = await shadowRun(rule);
    const trigger = await expectDenied(() =>
      t.asOwner((db) => db.query('DELETE FROM shadow_run WHERE id = $1', [id])),
    );
    expect(trigger).toMatch(/append-only/i);
  });
});

describe('samples keep the order two reviewers would discuss', () => {
  async function sample(runId: string, order: number, itemId: string) {
    return t.asService((db) =>
      db.query(
        `INSERT INTO shadow_run_sample
           (shadow_run_id, owned_item_id, matched, match_confidence, reasons, evidence_level,
            urgency, sample_order)
         VALUES ($1, $2, true, 'EXACT', ARRAY['BATCH_CODE_MATCHED']::text[], 'A', 'HIGH', $3)`,
        [runId, itemId, order],
      ),
    );
  }

  it('refuses two samples claiming the same position', async () => {
    // Random sampling would show a reviewer different rows from their colleague. The order is
    // stored rather than implied by insertion, so it survives a re-read.
    const run = await shadowRun(await candidateRule());
    await sample(run, 0, testUuid(400));
    const message = await expectDenied(() => sample(run, 0, testUuid(401)));
    expect(message).toMatch(/sample_order_unique|duplicate key/i);
  });

  it('refuses a confidence from the wrong vocabulary', async () => {
    // MatchConfidence and ItemVerification both contain PROBABLE, which is how the wrong list
    // got into the constraint in the first place. CONFIRMED belongs to the other one.
    const run = await shadowRun(await candidateRule());
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO shadow_run_sample
             (shadow_run_id, owned_item_id, matched, match_confidence, reasons, evidence_level,
              urgency, sample_order)
           VALUES ($1, $2, true, 'CONFIRMED', ARRAY['BATCH_CODE_MATCHED']::text[], 'A', 'HIGH', 0)`,
          [run, testUuid(403)],
        ),
      ),
    );
    expect(message).toMatch(/sample_confidence_valid/);
  });

  it('refuses a sample with no reason', async () => {
    // A match with no reason is not reviewable, which is the only thing a sample is for.
    const run = await shadowRun(await candidateRule());
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO shadow_run_sample
             (shadow_run_id, owned_item_id, matched, match_confidence, reasons, evidence_level,
              urgency, sample_order)
           VALUES ($1, $2, true, 'EXACT', ARRAY[]::text[], 'A', 'HIGH', 0)`,
          [run, testUuid(402)],
        ),
      ),
    );
    expect(message).toMatch(/sample_reasons_not_empty/);
  });

  it('accepts a sample whose item does not exist in owned_item', async () => {
    // Deliberate: a synthetic dataset's identifiers need not correspond to real rows, and
    // requiring them to would make a dry run against invented data impossible.
    const run = await shadowRun(await candidateRule());
    await sample(run, 0, testUuid(999_999));
    const rows = await t.asService((db) =>
      db.query('SELECT id FROM shadow_run_sample WHERE shadow_run_id = $1', [run]),
    );
    expect(rows.rows).toHaveLength(1);
  });
});

describe('a replay accounts for every assessment', () => {
  async function replay(
    overrides: { replayed?: number; reproduced?: number; changed?: number } = {},
  ) {
    return t.asService((db) =>
      db.query(
        `INSERT INTO replay_run
           (change_kind, change_note, assessments_replayed, reproduced, changed,
            difference_counts, run_by_user_id, run_at)
         VALUES ('SOURCE_CORRECTION', 'Corrected batch list on a synthetic notice.',
                 $1, $2, $3, $4::jsonb, $5, $6)`,
        [
          overrides.replayed ?? 10,
          overrides.reproduced ?? 8,
          overrides.changed ?? 2,
          JSON.stringify({ matched: 2 }),
          STAFF,
          NOW,
        ],
      ),
    );
  }

  it('refuses numbers that do not add up', async () => {
    // A replay whose halves do not account for the whole is one somebody reads as "mostly fine".
    const message = await expectDenied(() => replay({ replayed: 10, reproduced: 8, changed: 3 }));
    expect(message).toMatch(/replay_counts_add_up/);
  });

  it('refuses a change nobody described', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO replay_run
             (change_kind, change_note, assessments_replayed, reproduced, changed,
              run_by_user_id, run_at)
           VALUES ('SOURCE_CORRECTION', '  ', 0, 0, 0, $1, $2)`,
          [STAFF, NOW],
        ),
      ),
    );
    expect(message).toMatch(/replay_change_note_not_blank/);
  });

  it('refuses a change kind outside the vocabulary', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO replay_run
             (change_kind, change_note, assessments_replayed, reproduced, changed,
              run_by_user_id, run_at)
           VALUES ('BECAUSE', 'x', 0, 0, 0, $1, $2)`,
          [STAFF, NOW],
        ),
      ),
    );
    expect(message).toMatch(/replay_change_kind_valid/);
  });

  it('accepts a replay in which nothing moved', async () => {
    // The common and reassuring case: the correction had no effect on what anybody was told.
    await replay({ replayed: 10, reproduced: 10, changed: 0 });
    const rows = await t.asService((db) =>
      db.query<{ changed: number }>('SELECT changed FROM replay_run WHERE reproduced = 10'),
    );
    expect(rows.rows[0]?.changed).toBe(0);
  });

  it('cannot be deleted', async () => {
    await replay();
    const message = await expectDenied(() => t.asOwner((db) => db.query('DELETE FROM replay_run')));
    expect(message).toMatch(/append-only/i);
  });
});

describe('the reviewer console asks for the shadow evidence', () => {
  async function publicationRequest(
    ruleId: string,
    overrides: { shadowRunId?: string | null; required?: number; kind?: string } = {},
  ) {
    return t.asService((db) =>
      db.query(
        `INSERT INTO publication_request
           (subject_kind, subject_id, action, jurisdictions, max_urgency, evidence_level,
            required_approvals, requested_by_user_id, requested_at, shadow_run_id)
         VALUES ($1, $2, 'PUBLISH', ARRAY['GB']::text[], 'HIGH', 'A', $3, $4, $5, $6)`,
        [
          overrides.kind ?? 'assessment_rule_version',
          ruleId,
          overrides.required ?? 2,
          STAFF,
          NOW,
          overrides.shadowRunId ?? null,
        ],
      ),
    );
  }

  it('refuses a two-person safety-rule publication with no shadow run', async () => {
    // Spec 10 lists "shadow-mode result where required" among what a rule needs, and the
    // high-severity checklist has a reviewer confirm the expected matched-user volume. Until this
    // migration that confirmation rested on a judgement.
    const rule = await candidateRule();
    const message = await expectDenied(() => publicationRequest(rule));
    expect(message).toMatch(/publication_request_needs_shadow_evidence/);
  });

  it('refuses a shadow run of a different rule', async () => {
    // The obvious way to satisfy a requirement like this without meeting it. The trigger checks
    // the pairing, not the presence.
    const rule = await candidateRule();
    const otherRule = await candidateRule();
    const otherRun = await shadowRun(otherRule);
    const message = await expectDenied(() => publicationRequest(rule, { shadowRunId: otherRun }));
    expect(message).toMatch(/publication_request_shadow_run_is_for_another_rule/);
  });

  it('accepts a request naming a run of the rule it publishes', async () => {
    const rule = await candidateRule();
    const run = await shadowRun(rule);
    await publicationRequest(rule, { shadowRunId: run });
    const rows = await t.asService((db) =>
      db.query<{ shadow_run_id: string }>(
        'SELECT shadow_run_id FROM publication_request WHERE subject_id = $1',
        [rule],
      ),
    );
    expect(rows.rows[0]?.shadow_run_id).toBe(run);
  });

  it('does not ask for one where a single reviewer suffices', async () => {
    // The threshold is the same one that requires two people, so "high-impact" keeps meaning one
    // thing across the console.
    const rule = await candidateRule();
    await publicationRequest(rule, { required: 1 });
    const rows = await t.asService((db) =>
      db.query('SELECT id FROM publication_request WHERE subject_id = $1', [rule]),
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('does not ask for one when publishing something that is not a rule', async () => {
    const subject = testUuid(500);
    await publicationRequest(subject, { kind: 'alert_publication' });
    const rows = await t.asService((db) =>
      db.query('SELECT id FROM publication_request WHERE subject_id = $1', [subject]),
    );
    expect(rows.rows).toHaveLength(1);
  });
});
