import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Shadow runs and replay, end to end (spec 04 Phase 6.7).
 *
 * Exit criterion 1 - "New high-impact rules can be evaluated without user notification" - is
 * asserted here against the live flow: a historical run over a real shelf reports counts, writes
 * nothing to `profile_assessment`, publishes no alert, and returns a body containing no profile.
 *
 * Exit criterion 2 - "Regulatory data corrections can recompute dependent product views and
 * assessments reproducibly" - is asserted by replaying with the world unchanged and requiring
 * everything to reproduce, then withdrawing the recall notice and requiring the diff to name what
 * moved.
 */

const ADMIN = testUuid(1);
const STAFF = testUuid(2);
const OUTSIDER = testUuid(3);
const OWNER = testUuid(4);

const HOUSEHOLD = testUuid(10);
const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

const IDENTITY = testUuid(30);
const BATCH = testUuid(31);
const ITEM_A = testUuid(40);
const ITEM_B = testUuid(41);
const ITEM_C = testUuid(42);

const SOURCE = testUuid(50);
const DOCUMENT = testUuid(52);
const ACTION = testUuid(51);

const NOW = instantFrom('2026-08-29T12:00:00.000Z');
const GTIN = '8901234567890';

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;
let currentNow: Instant = NOW;
let ruleCounter = 100;

function staff(userId: string): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt: NOW };
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [ADMIN, 'admin@example.test'],
      [STAFF, 'staff@example.test'],
      [OUTSIDER, 'outsider@example.test'],
      [OWNER, 'owner@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
    await db.query(`INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'H')`, [
      HOUSEHOLD,
      OWNER,
    ]);
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'A'), ($4, $2, $3, 'B')`,
      [PROFILE_A, HOUSEHOLD, OWNER, PROFILE_B],
    );
    await db.query(
      `INSERT INTO product_identity (id, item_kind, display_name, gtin)
       VALUES ($1, 'MEDICINE', 'Synthetic Tablet', $2)`,
      [IDENTITY, GTIN],
    );
    await db.query(
      `INSERT INTO batch_or_lot (id, product_identity_id, lot_code, lot_code_normalized)
       VALUES ($1, $2, 'A24X91', 'A24X91')`,
      [BATCH, IDENTITY],
    );
    // Two households hold the recalled batch. The third item is a hand-entered pack with no
    // catalog link at all, so the rule cannot identify it - which is a non-match for a reason
    // worth seeing in the breakdown rather than an absence.
    for (const [id, profileId, identityId, batchId] of [
      [ITEM_A, PROFILE_A, IDENTITY, BATCH],
      [ITEM_B, PROFILE_B, IDENTITY, BATCH],
      [ITEM_C, PROFILE_A, null, null],
    ] as const) {
      await db.query(
        `INSERT INTO owned_item
           (id, profile_id, item_kind, product_identity_id, batch_id, display_name,
            identity_verification, formulation_verification, batch_verification, lifecycle_state)
         VALUES ($1, $2, 'MEDICINE', $3, $4, 'Synthetic Tablet',
                 'CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'ACTIVE')`,
        [id, profileId, identityId, batchId],
      );
    }
    await db.query(
      `INSERT INTO source_registry_entry
         (id, organization, source_name, source_class, jurisdiction, allowed_influence,
          license_review_state, expected_refresh_interval_ms, parser_version, status,
          coverage_statement)
       VALUES ($1, 'Synthetic Authority', 'Synthetic Register', 'OFFICIAL_ACTION_REGISTRY', 'GB',
               ARRAY['SAFETY_RULE']::text[], 'APPROVED', 86400000, '1.0.0', 'ACTIVE',
               'Synthetic coverage for tests.')`,
      [SOURCE],
    );
    // The Citation Gate refuses a PUBLISHED action with no retrieved document behind it, so the
    // fixture has one - the two governance layers are independent and both apply here.
    await db.query(
      `INSERT INTO source_document
         (id, source_registry_entry_id, canonical_uri, content_sha256)
       VALUES ($1, $2, 'https://example.test/synthetic-recall',
               '0000000000000000000000000000000000000000000000000000000000000001')`,
      [DOCUMENT, SOURCE],
    );
    await db.query(
      `INSERT INTO product_regulatory_action
         (id, jurisdiction, action_kind, authority, product_identity_id, gtin, batch_codes,
          summary, source_registry_entry_id, source_document_id, review_state, verification)
       VALUES ($1, 'GB', 'RECALL', 'Synthetic Authority', $2, $3, ARRAY['A24X91']::text[],
               'SYNTHETIC batch recall fixture.', $4, $5, 'PUBLISHED',
               'VERIFIED_AGAINST_OFFICIAL_SOURCE')`,
      [ACTION, IDENTITY, GTIN, SOURCE, DOCUMENT],
    );
    await db.query(
      `INSERT INTO reviewer (user_id, role, granted_by_user_id, granted_at)
       VALUES ($1, 'CLINICAL_SAFETY_LEAD', $2, now())`,
      [STAFF, ADMIN],
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
    pool,
    logger: noopLogger(),
    authenticate: (_request: FastifyRequest) => Promise.resolve(currentPrincipal),
    now: () => currentNow,
    loadSources: () => Promise.resolve(sources),
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

beforeEach(() => {
  currentNow = NOW;
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  try {
    return await app.inject(options);
  } finally {
    currentPrincipal = null;
  }
}

/**
 * A candidate rule in shadow mode. Rules are append-only, so each test gets its own.
 *
 * `live` produces the approved, enabled rule a replay is about: a recorded `profile_assessment`
 * implies the rule was live when it ran, and replaying it under the candidate gates would report
 * every assessment as changed for a reason that has nothing to do with the correction.
 */
async function candidateRule(
  overrides: { kind?: string; shadowMode?: boolean; live?: boolean } = {},
): Promise<string> {
  ruleCounter += 1;
  const id = testUuid(ruleCounter);
  const live = overrides.live ?? false;
  await t.asService((db) =>
    db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id,
          shadow_mode, review_state, approved_by_reviewer_id, approved_at, enabled)
       VALUES ($1, $2, '1.0.0', $3, 'A', 'HIGH',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_REPORTED']::text[], 'tpl.batch', $4,
               $5, $6, $7, $8)`,
      [
        id,
        `synthetic.${id.slice(-6)}`,
        overrides.kind ?? 'BATCH_ACTION_MATCH',
        overrides.shadowMode ?? true,
        live ? 'APPROVED' : 'CANDIDATE',
        live ? STAFF : null,
        live ? NOW : null,
        live,
      ],
    ),
  );
  return id;
}

interface RunBody {
  readonly shadowRunId: string;
  readonly datasetSize: number;
  readonly matchedItems: number;
  readonly affectedProducts: number;
  readonly potentialUserMatches: number;
  readonly reasonCounts: Record<string, number>;
}

async function startRun(payload: Record<string, unknown>) {
  return request(staff(STAFF), {
    method: 'POST',
    url: '/v1/reviewer/shadow-runs',
    payload,
  });
}

async function historicalRun(ruleVersionId: string, label = 'shelf snapshot') {
  return startRun({ ruleVersionId, datasetKind: 'HISTORICAL', datasetLabel: label });
}

// ---------------------------------------------------------------------------

describe('a shadow run touches nobody', () => {
  it('reports the blast radius over the real shelf', async () => {
    const ruleId = await candidateRule();
    const response = await historicalRun(ruleId);
    expect(response.statusCode).toBe(201);

    const body = response.json<RunBody>();
    expect(body.datasetSize).toBe(3);
    expect(body.matchedItems).toBe(2);
    // Two packs of one product held by two households.
    expect(body.affectedProducts).toBe(1);
    expect(body.potentialUserMatches).toBe(2);
    expect(body.reasonCounts.BATCH_CODE_MATCHED).toBe(2);
  });

  it('returns no profile in the response body', async () => {
    // The exit criterion at the boundary: a client handed this has nobody to notify.
    const ruleId = await candidateRule();
    const response = await historicalRun(ruleId);
    for (const profileId of [PROFILE_A, PROFILE_B]) {
      expect(response.body).not.toContain(profileId);
    }
  });

  it('writes no assessment and publishes no alert', async () => {
    // The structural half. A shadow result is not a profile_assessment, and alert_publication
    // requires one, so there is no route from a dry run to a notification.
    const ruleId = await candidateRule();
    await historicalRun(ruleId);

    const assessments = await t.asService((db) =>
      db.query('SELECT id FROM profile_assessment WHERE rule_version_id = $1', [ruleId]),
    );
    const alerts = await t.asService((db) => db.query('SELECT id FROM alert_publication'));
    expect(assessments.rows).toEqual([]);
    expect(alerts.rows).toEqual([]);
  });

  it('refuses a rule that is not in shadow mode', async () => {
    // A function that would evaluate a live rule across the whole estate is one call away from
    // being used to do that.
    const ruleId = await candidateRule({ shadowMode: false });
    const response = await historicalRun(ruleId);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'rule_not_in_shadow_mode' } },
    });
  });

  it('is closed to anyone who is not a reviewer', async () => {
    const ruleId = await candidateRule();
    const response = await request(staff(OUTSIDER), {
      method: 'POST',
      url: '/v1/reviewer/shadow-runs',
      payload: { ruleVersionId: ruleId, datasetKind: 'HISTORICAL', datasetLabel: 'x' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('records the run in the audit log as counts, never as content', async () => {
    const ruleId = await candidateRule();
    const runId = (await historicalRun(ruleId)).json<RunBody>().shadowRunId;

    const events = await t.asService((db) =>
      db.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_event WHERE action = 'shadow.run' AND target_id = $1`,
        [runId],
      ),
    );
    expect(events.rows[0]?.detail).toMatchObject({
      dataset_kind: 'HISTORICAL',
      matched_items: 2,
      potential_user_matches: 2,
    });
    expect(JSON.stringify(events.rows[0]?.detail)).not.toContain(PROFILE_A);
  });
});

describe('a historical run refuses what it cannot measure', () => {
  it('will not run a substance-matching rule against the shelf', async () => {
    // The shelf join here does not carry the confirmed ingredient declaration, so the run would
    // report fewer matches than the rule really produces - and an under-count reads as "this
    // affects nobody", which is the most dangerous wrong answer a blast radius can give.
    for (const kind of ['INGREDIENT_SENSITIVITY', 'DUPLICATE_ACTIVE_INGREDIENT']) {
      const ruleId = await candidateRule({ kind });
      const response = await historicalRun(ruleId);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { detail: { reason_code: 'historical_dataset_incomplete_for_rule' } },
      });
    }
  });

  it('runs the same rule kind against a synthetic dataset the caller supplied', async () => {
    // The caller supplies the substance keys there, so nothing is being inferred from data the
    // server does not have.
    const ruleId = await candidateRule({ kind: 'INGREDIENT_SENSITIVITY' });
    const response = await startRun({
      ruleVersionId: ruleId,
      datasetKind: 'SYNTHETIC',
      datasetLabel: 'invented rows',
      dataset: [
        {
          ownedItemId: testUuid(900),
          profileId: testUuid(901),
          identityVerification: 'CONFIRMED',
          formulationVerification: 'CONFIRMED',
          batchVerification: 'CONFIRMED',
          substanceKeys: ['synthetic.substance'],
        },
      ],
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<RunBody>().datasetSize).toBe(1);
  });
});

describe('the report a reviewer reads', () => {
  it('shows the samples with the item and the reasons, and no person', async () => {
    const ruleId = await candidateRule();
    const runId = (await historicalRun(ruleId)).json<RunBody>().shadowRunId;

    const response = await request(staff(STAFF), {
      method: 'GET',
      url: `/v1/reviewer/shadow-runs/${runId}`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      samples: { ownedItemId: string; reasons: string[] }[];
      datasetLabel: string;
    }>();
    expect(body.samples.map((s) => s.ownedItemId).sort()).toEqual([ITEM_A, ITEM_B].sort());
    expect(body.samples[0]?.reasons).toContain('BATCH_CODE_MATCHED');
    expect(body.datasetLabel).toBe('shelf snapshot');
    for (const profileId of [PROFILE_A, PROFILE_B]) {
      expect(response.body).not.toContain(profileId);
    }
  });

  it('offers no verdict on whether the rule should ship', async () => {
    // Spec 22 requires release thresholds to be set against a labelled dataset, and BLK-008
    // records that none exists. The numbers go to a person.
    const ruleId = await candidateRule();
    const runId = (await historicalRun(ruleId)).json<RunBody>().shadowRunId;
    const response = await request(staff(STAFF), {
      method: 'GET',
      url: `/v1/reviewer/shadow-runs/${runId}`,
    });
    const keys = Object.keys(response.json<Record<string, unknown>>());
    for (const forbidden of ['recommendation', 'verdict', 'passed', 'score', 'safeToPublish']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('before and after', () => {
  it('shows what changed when the notice was withdrawn', async () => {
    const ruleId = await candidateRule();
    const before = (await historicalRun(ruleId, 'before')).json<RunBody>();

    await t.asService((db) =>
      db.query(`UPDATE product_regulatory_action SET review_state = 'WITHDRAWN' WHERE id = $1`, [
        ACTION,
      ]),
    );
    const after = (await historicalRun(ruleId, 'after')).json<RunBody>();

    const response = await request(staff(STAFF), {
      method: 'POST',
      url: `/v1/reviewer/shadow-runs/${after.shadowRunId}/compare`,
      payload: { againstRunId: before.shadowRunId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      // The two matches are gone, so they appear as before-only rather than as a diff.
      onlyInAfter: [],
      countDeltas: { matchedItems: -2, potentialUserMatches: -2 },
    });
    expect(response.json<{ onlyInBefore: string[] }>().onlyInBefore.sort()).toEqual(
      [ITEM_A, ITEM_B].sort(),
    );

    // Restore, so the replay suite sees the recall in force.
    await t.asService((db) =>
      db.query(`UPDATE product_regulatory_action SET review_state = 'PUBLISHED' WHERE id = $1`, [
        ACTION,
      ]),
    );
  });
});

describe('replay after a correction', () => {
  async function recordAssessments(ruleId: string, matched: boolean) {
    for (const [itemId, profileId] of [
      [ITEM_A, PROFILE_A],
      [ITEM_B, PROFILE_B],
    ] as const) {
      await t.asService((db) =>
        db.query(
          `INSERT INTO profile_assessment
             (profile_id, owned_item_id, rule_version_id, matched, match_confidence, reasons,
              evidence_level, urgency, explanation_template_id, normalization_version,
              evaluated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'A', $7, 'tpl.batch', 'norm-1', $8)`,
          [
            profileId,
            itemId,
            ruleId,
            matched,
            matched ? 'EXACT' : 'NOT_MATCHED',
            matched ? ['BATCH_CODE_MATCHED'] : ['NO_SIGNAL_MATCHED'],
            matched ? 'HIGH' : 'INFORMATIONAL',
            NOW,
          ],
        ),
      );
    }
  }

  async function replay(ruleVersionId: string, changeNote = 'Synthetic correction.') {
    return request(staff(STAFF), {
      method: 'POST',
      url: '/v1/reviewer/replays',
      payload: { ruleVersionId, changeKind: 'SOURCE_CORRECTION', changeNote },
    });
  }

  it('reproduces every assessment when nothing moved', async () => {
    // Spec 09: "Replaying the same versions must reproduce the result." The reassuring case, and
    // the one a correction usually produces.
    const ruleId = await candidateRule({ live: true });
    await recordAssessments(ruleId, true);

    const response = await replay(ruleId);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      replayed: 2,
      reproduced: 2,
      changed: 0,
      fullyReproduced: true,
    });
  });

  it('names exactly which assessments a correction moved', async () => {
    // The recorded assessments say the batch matched. Withdrawing the notice makes it not match,
    // and the replay has to say so per item rather than as a headline.
    const ruleId = await candidateRule({ live: true });
    await recordAssessments(ruleId, true);
    await t.asService((db) =>
      db.query(`UPDATE product_regulatory_action SET review_state = 'WITHDRAWN' WHERE id = $1`, [
        ACTION,
      ]),
    );

    const response = await replay(ruleId, 'The notice was withdrawn by the authority.');
    const body = response.json<{
      fullyReproduced: boolean;
      changed: number;
      differenceCounts: Record<string, number>;
      changedItems: { ownedItemId: string; differences: string[] }[];
    }>();
    expect(body.fullyReproduced).toBe(false);
    expect(body.changed).toBe(2);
    expect(body.differenceCounts.matched).toBe(2);
    expect(body.changedItems.map((i) => i.ownedItemId).sort()).toEqual([ITEM_A, ITEM_B].sort());
    expect(body.changedItems[0]?.differences).toContain('matched');

    await t.asService((db) =>
      db.query(`UPDATE product_regulatory_action SET review_state = 'PUBLISHED' WHERE id = $1`, [
        ACTION,
      ]),
    );
  });

  it('records the replay so a correction has a governance artefact', async () => {
    const ruleId = await candidateRule({ live: true });
    await recordAssessments(ruleId, true);
    const response = await replay(ruleId, 'Routine verification of a synthetic notice.');
    const replayRunId = response.json<{ replayRunId: string }>().replayRunId;

    const stored = await t.asService((db) =>
      db.query<{ change_note: string; reproduced: number }>(
        'SELECT change_note, reproduced FROM replay_run WHERE id = $1',
        [replayRunId],
      ),
    );
    expect(stored.rows[0]?.change_note).toBe('Routine verification of a synthetic notice.');
    expect(stored.rows[0]?.reproduced).toBe(2);
  });

  it('changes nothing a user was told', async () => {
    // A replay is a diff somebody reads, not an apply. The recorded assessments are append-only
    // and the replay must not have rewritten them.
    const ruleId = await candidateRule({ live: true });
    await recordAssessments(ruleId, true);
    await replay(ruleId);

    const stored = await t.asService((db) =>
      db.query<{ matched: boolean }>(
        'SELECT matched FROM profile_assessment WHERE rule_version_id = $1',
        [ruleId],
      ),
    );
    expect(stored.rows.every((row) => row.matched)).toBe(true);
  });

  it('is closed to anyone who is not a reviewer', async () => {
    const ruleId = await candidateRule();
    const response = await request(staff(OUTSIDER), {
      method: 'POST',
      url: '/v1/reviewer/replays',
      payload: { ruleVersionId: ruleId, changeKind: 'SOURCE_CORRECTION', changeNote: 'x' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a change nobody described', async () => {
    const ruleId = await candidateRule();
    const response = await request(staff(STAFF), {
      method: 'POST',
      url: '/v1/reviewer/replays',
      payload: { ruleVersionId: ruleId, changeKind: 'SOURCE_CORRECTION', changeNote: '' },
    });
    expect(response.statusCode).toBe(400);
  });
});
