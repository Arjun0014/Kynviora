import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Storage-layer tests for the regulatory registry and the safety publication boundary.
 *
 * The Citation Gate is implemented as a pure function in `@kynviora/regulatory` so its decisions
 * are testable and explainable. These tests cover the **second layer**: CHECK constraints that
 * hold even for a direct database write - an operator session, a mistaken migration, a future
 * service bug. Spec 14 defence in depth.
 */

const USER = testUuid(1);
const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const ITEM = testUuid(30);

const SRC_LEGAL = testUuid(100);
const SRC_NORMALIZATION = testUuid(101);
const SRC_RESEARCH = testUuid(102);
const DOC = testUuid(110);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    await db.query(
      `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
       VALUES ($1, $2, 'user@example.test', now())`,
      [USER, `auth|${USER}`],
    );
    await db.query(`INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'H')`, [
      HOUSEHOLD,
      USER,
    ]);
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent (synthetic)')`,
      [PROFILE, HOUSEHOLD, USER],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, personal_care_category)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Synthetic Serum', 'SKIN_CARE')`,
      [ITEM, PROFILE],
    );

    await db.query(
      `INSERT INTO source_registry_entry
         (id, organization, source_name, source_class, jurisdiction, allowed_influence,
          license_review_state, expected_refresh_interval_ms, parser_version, status,
          coverage_statement)
       VALUES ($1, 'EU', 'Regulation 1223/2009', 'PRIMARY_LEGAL', 'EU',
               ARRAY['REGULATORY_STATUS'], 'APPROVED', 604800000, 'p1', 'ACTIVE',
               'Monitors the consolidated text and Annexes.')`,
      [SRC_LEGAL],
    );
    await db.query(
      `INSERT INTO source_registry_entry
         (id, organization, source_name, source_class, jurisdiction, allowed_influence,
          license_review_state, expected_refresh_interval_ms, parser_version, status,
          coverage_statement)
       VALUES ($1, 'EC', 'CosIng', 'IDENTITY_NORMALIZATION', 'EU',
               ARRAY['IDENTITY','NORMALIZATION'], 'APPROVED', 2592000000, 'p1', 'ACTIVE',
               'Ingredient naming only; informational, no legal value.')`,
      [SRC_NORMALIZATION],
    );
    await db.query(
      `INSERT INTO source_registry_entry
         (id, organization, source_name, source_class, allowed_influence,
          license_review_state, expected_refresh_interval_ms, parser_version, status,
          coverage_statement)
       VALUES ($1, 'Kynviora', 'Research agent', 'SEARCH_OR_LLM_RESEARCH',
               ARRAY['DISCOVERY_ONLY'], 'APPROVED', 0, 'r1', 'ACTIVE',
               'Locates official material; never a source of truth.')`,
      [SRC_RESEARCH],
    );

    await db.query(
      `INSERT INTO source_document
         (id, source_registry_entry_id, canonical_uri, content_sha256)
       VALUES ($1, $2, 'https://example.test/annex', $3)`,
      [DOC, SRC_LEGAL, 'a'.repeat(64)],
    );
  });
});

afterAll(async () => {
  await t.close();
});

/** Insert a rule, returning the error message when the write is refused. */
async function insertRule(overrides: Record<string, unknown> = {}): Promise<string | null> {
  const row = {
    jurisdiction: 'EU',
    substance_canonical_key: 'SALICYLIC_ACID',
    statuses: ['RESTRICTED'],
    conditions: {},
    legal_instrument: 'Regulation (EC) No 1223/2009',
    legal_reference: 'Annex III, entry 98',
    publication_date: '2009-12-22',
    effective_date: '2009-12-22',
    source_registry_entry_id: SRC_LEGAL,
    source_document_id: DOC,
    extraction_version: 'v1',
    review_state: 'PUBLISHED',
    verification: 'VERIFIED_AGAINST_OFFICIAL_SOURCE',
    approved_by_reviewer_id: 'synthetic-test-reviewer',
    approved_at: new Date().toISOString(),
    ...overrides,
  };

  try {
    await t.asService((db) =>
      db.query(
        `INSERT INTO regulatory_rule_version
           (jurisdiction, substance_canonical_key, statuses, conditions, legal_instrument,
            legal_reference, publication_date, effective_date, source_registry_entry_id,
            source_document_id, extraction_version, review_state, verification,
            approved_by_reviewer_id, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          row.jurisdiction,
          row.substance_canonical_key,
          row.statuses,
          JSON.stringify(row.conditions),
          row.legal_instrument,
          row.legal_reference,
          row.publication_date,
          row.effective_date,
          row.source_registry_entry_id,
          row.source_document_id,
          row.extraction_version,
          row.review_state,
          row.verification,
          row.approved_by_reviewer_id,
          row.approved_at,
        ],
      ),
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('source registry authority hierarchy, enforced at the storage layer', () => {
  it('refuses REGULATORY_STATUS influence on a normalization source', async () => {
    // Spec 25: CosIng is informational; the Annexes are the law. A migration or admin edit that
    // widened its influence would be refused.
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO source_registry_entry
             (organization, source_name, source_class, allowed_influence, license_review_state,
              expected_refresh_interval_ms, parser_version, coverage_statement)
           VALUES ('EC', 'CosIng Widened', 'IDENTITY_NORMALIZATION',
                   ARRAY['REGULATORY_STATUS'], 'APPROVED', 1000, 'p', 'x')`,
        ),
      ),
    );
    expect(message).toMatch(/legal_status_requires_legal_class/i);
  });

  it('refuses any influence beyond DISCOVERY_ONLY on a research source', async () => {
    // Threat A13: a research agent must hold no write authority. Encoding it here means the
    // mistake cannot be made by a future migration.
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO source_registry_entry
             (organization, source_name, source_class, allowed_influence, license_review_state,
              expected_refresh_interval_ms, parser_version, coverage_statement)
           VALUES ('Kynviora', 'Agent Widened', 'SEARCH_OR_LLM_RESEARCH',
                   ARRAY['DISCOVERY_ONLY','NORMALIZATION'], 'APPROVED', 0, 'r', 'x')`,
        ),
      ),
    );
    expect(message).toMatch(/research_is_discovery_only/i);
  });

  it('accepts REGULATORY_STATUS on a primary legal source', async () => {
    const res = await t.asService((db) =>
      db.query(
        `INSERT INTO source_registry_entry
           (organization, source_name, source_class, jurisdiction, allowed_influence,
            license_review_state, expected_refresh_interval_ms, parser_version, coverage_statement)
         VALUES ('UK', 'GB retained', 'PRIMARY_LEGAL', 'GB', ARRAY['REGULATORY_STATUS'],
                 'APPROVED', 1000, 'p', 'GB coverage') RETURNING id`,
      ),
    );
    expect(res.rows).toHaveLength(1);
  });

  it('has no UK jurisdiction in the permitted set', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO source_registry_entry
             (organization, source_name, source_class, jurisdiction, allowed_influence,
              license_review_state, expected_refresh_interval_ms, parser_version,
              coverage_statement)
           VALUES ('UK', 'Combined', 'PRIMARY_LEGAL', 'UK', ARRAY['REGULATORY_STATUS'],
                   'APPROVED', 1000, 'p', 'x')`,
        ),
      ),
    );
    expect(message).toMatch(/jurisdiction_valid/i);
  });
});

describe('Citation Gate as a storage constraint (spec 14 defence in depth)', () => {
  it('accepts a fully evidenced published rule', async () => {
    expect(await insertRule()).toBeNull();
  });

  it('refuses a published rule with no source document', async () => {
    const message = await insertRule({ source_document_id: null });
    expect(message).toMatch(/published_requires_citation/i);
  });

  it('refuses a published rule with no legal reference', async () => {
    expect(await insertRule({ legal_reference: null })).toMatch(/published_requires_citation/i);
    expect(await insertRule({ legal_reference: '   ' })).toMatch(/published_requires_citation/i);
  });

  it('refuses a published rule with no dates', async () => {
    const message = await insertRule({ publication_date: null, effective_date: null });
    expect(message).toMatch(/published_requires_citation/i);
  });

  it('refuses a published rule not verified against an official source', async () => {
    // DEC-016. The database refuses what the gate function refuses.
    for (const verification of ['NEEDS_PRIMARY_VERIFICATION', 'UNVERIFIED']) {
      expect(await insertRule({ verification })).toMatch(/published_requires_citation/i);
    }
  });

  it('refuses a published rule with no named reviewer', async () => {
    expect(await insertRule({ approved_by_reviewer_id: null })).toMatch(
      /published_requires_citation/i,
    );
    expect(await insertRule({ approved_at: null })).toMatch(/published_requires_citation/i);
  });

  it('refuses a published concentration limit with no threshold', async () => {
    // Spec 22 misleading-simplification guardrail: a bare CONCENTRATION_LIMIT renders as an
    // unexplained restriction.
    const message = await insertRule({
      statuses: ['RESTRICTED', 'CONCENTRATION_LIMIT'],
      conditions: {},
    });
    expect(message).toMatch(/concentration_limit_has_threshold/i);
  });

  it('accepts a published concentration limit that states its threshold', async () => {
    const message = await insertRule({
      statuses: ['RESTRICTED', 'CONCENTRATION_LIMIT'],
      conditions: { maxConcentrationPercent: 2.0 },
    });
    expect(message).toBeNull();
  });

  it('allows an unverified rule to exist as a candidate', async () => {
    // Candidates are the normal state for shipped fixtures; only publication is gated.
    const message = await insertRule({
      review_state: 'IN_REVIEW',
      verification: 'NEEDS_PRIMARY_VERIFICATION',
      approved_by_reviewer_id: null,
      approved_at: null,
      source_document_id: null,
    });
    expect(message).toBeNull();
  });

  it('refuses an unknown regulatory status', async () => {
    expect(await insertRule({ statuses: ['BANNED'] })).toMatch(/statuses_known/i);
    expect(await insertRule({ statuses: ['APPROVED'] })).toMatch(/statuses_known/i);
  });
});

describe('discovery candidates are not evidence (spec 07, threat A13)', () => {
  it('refuses to mark a candidate validated without a retrieved document', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO source_discovery_candidate
             (discovered_uri, discovered_by, state)
           VALUES ('https://example.test/found', 'RESEARCH_AGENT', 'VALIDATED')`,
        ),
      ),
    );
    expect(message).toMatch(/validated_requires_document/i);
  });

  it('accepts an unvalidated candidate', async () => {
    const res = await t.asService((db) =>
      db.query(
        `INSERT INTO source_discovery_candidate (discovered_uri, discovered_by)
         VALUES ('https://example.test/lead', 'RESEARCH_AGENT') RETURNING id, state`,
      ),
    );
    expect(res.rows[0]).toMatchObject({ state: 'UNVALIDATED' });
  });

  it('is not readable by the app role at all', async () => {
    const message = await expectDenied(() =>
      t.asUser(USER, (db) => db.query('SELECT id FROM source_discovery_candidate')),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

describe('users see only published regulatory facts', () => {
  // Rules are append-only by design, so these tests scope their queries by a substance key
  // unique to each case rather than clearing the table between runs.
  it('hides candidate rules from the app role', async () => {
    const key = 'VISIBILITY_CANDIDATE_ONLY';
    await insertRule({
      substance_canonical_key: key,
      review_state: 'IN_REVIEW',
      verification: 'NEEDS_PRIMARY_VERIFICATION',
      approved_by_reviewer_id: null,
      approved_at: null,
      source_document_id: null,
    });

    const asService = await t.asService((db) =>
      db.query('SELECT id FROM regulatory_rule_version WHERE substance_canonical_key = $1', [key]),
    );
    expect(asService.rows).toHaveLength(1);

    const asUser = await t.asUser(USER, (db) =>
      db.query('SELECT id FROM regulatory_rule_version WHERE substance_canonical_key = $1', [key]),
    );
    expect(asUser.rows).toEqual([]);
  });

  it('shows published rules to the app role', async () => {
    const key = 'VISIBILITY_PUBLISHED_ONLY';
    await insertRule({ substance_canonical_key: key });

    const res = await t.asUser(USER, (db) =>
      db.query('SELECT id FROM regulatory_rule_version WHERE substance_canonical_key = $1', [key]),
    );
    expect(res.rows).toHaveLength(1);
  });

  it('keeps rule versions append-only, so a superseded rule stays inspectable', async () => {
    // Spec 04 Phase 6.2: a source change cannot silently mutate previous facts.
    const message = await expectDenied(() =>
      t.asOwner((db) => db.query('DELETE FROM regulatory_rule_version')),
    );
    expect(message).toMatch(/append-only/i);
  });

  it('gives the app role no write grant on the registry', async () => {
    const message = await expectDenied(() =>
      t.asUser(USER, (db) =>
        db.query(
          `INSERT INTO regulatory_rule_version
             (jurisdiction, substance_canonical_key, statuses, source_registry_entry_id,
              extraction_version)
           VALUES ('EU', 'X', ARRAY['PROHIBITED'], $1, 'v1')`,
          [SRC_LEGAL],
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('keeps preserved source documents entirely internal', async () => {
    // Licensing frequently forbids redistribution (spec 25, BLK-005).
    const message = await expectDenied(() =>
      t.asUser(USER, (db) => db.query('SELECT id FROM source_document')),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

describe('source change detection', () => {
  it('treats an unchanged re-fetch as idempotent', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO source_document (source_registry_entry_id, canonical_uri, content_sha256)
           VALUES ($1, 'https://example.test/annex', $2)`,
          [SRC_LEGAL, 'a'.repeat(64)],
        ),
      ),
    );
    expect(message).toMatch(/duplicate key|content_unique/i);
  });

  it('accepts changed content as a new version', async () => {
    const res = await t.asService((db) =>
      db.query(
        `INSERT INTO source_document
           (source_registry_entry_id, canonical_uri, content_sha256, supersedes_document_id)
         VALUES ($1, 'https://example.test/annex', $2, $3) RETURNING id`,
        [SRC_LEGAL, 'b'.repeat(64), DOC],
      ),
    );
    expect(res.rows).toHaveLength(1);
  });

  it('keeps source documents append-only', async () => {
    const message = await expectDenied(() =>
      t.asOwner((db) =>
        db.query(`UPDATE source_document SET content_sha256 = $1`, ['c'.repeat(64)]),
      ),
    );
    expect(message).toMatch(/append-only/i);
  });

  it('reports staleness from the declared refresh interval', async () => {
    await t.asService((db) =>
      db.query(
        `UPDATE source_registry_entry
         SET last_successful_check_at = now() - interval '30 days' WHERE id = $1`,
        [SRC_LEGAL],
      ),
    );
    const res = await t.asService((db) =>
      db.query<{ is_stale: boolean }>('SELECT is_stale FROM source_health WHERE id = $1', [
        SRC_LEGAL,
      ]),
    );
    expect(res.rows[0]?.is_stale).toBe(true);

    await t.asService((db) =>
      db.query(`UPDATE source_registry_entry SET last_successful_check_at = now() WHERE id = $1`, [
        SRC_LEGAL,
      ]),
    );
    const fresh = await t.asService((db) =>
      db.query<{ is_stale: boolean }>('SELECT is_stale FROM source_health WHERE id = $1', [
        SRC_LEGAL,
      ]),
    );
    expect(fresh.rows[0]?.is_stale).toBe(false);
  });

  it('treats a never-checked source as stale', async () => {
    const res = await t.asService((db) =>
      db.query<{ is_stale: boolean }>('SELECT is_stale FROM source_health WHERE id = $1', [
        SRC_RESEARCH,
      ]),
    );
    expect(res.rows[0]?.is_stale).toBe(true);
  });
});

describe('safety publication boundary (threat A3)', () => {
  let ruleId: string;

  beforeAll(async () => {
    const res = await t.asService((db) =>
      db.query<{ id: string }>(
        `INSERT INTO assessment_rule_version
           (rule_key, version, rule_kind, evidence_level, max_urgency,
            required_item_verification, required_profile_provenance, explanation_template_id,
            review_state, approved_by_reviewer_id, approved_at, shadow_mode, enabled,
            approved_jurisdictions)
         VALUES ('batch-recall', 'v1', 'BATCH_ACTION_MATCH', 'A', 'HIGH',
                 ARRAY['CONFIRMED'], ARRAY['USER_REPORTED'], 'tpl-v1',
                 'PUBLISHED', 'synthetic-test-reviewer', now(), false, true,
                 ARRAY['GB']::text[])
         RETURNING id`,
      ),
    );
    ruleId = res.rows[0]!.id;
  });

  it('refuses a published rule with no named reviewer', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          // The approved scope is supplied so that migration 0012's constraint is satisfied and
          // the missing reviewer is the only thing wrong with this row - otherwise the test would
          // be asserting whichever constraint Postgres happens to evaluate first.
          `INSERT INTO assessment_rule_version
             (rule_key, version, rule_kind, evidence_level, max_urgency,
              required_item_verification, required_profile_provenance, explanation_template_id,
              review_state, approved_jurisdictions)
           VALUES ('x', 'v1', 'EXPIRY', 'B', 'LOW', ARRAY['CONFIRMED'], ARRAY['USER_REPORTED'],
                   'tpl', 'PUBLISHED', ARRAY['GB']::text[])`,
        ),
      ),
    );
    expect(message).toMatch(/published_requires_reviewer/i);
  });

  it('refuses to run a rule live outside shadow mode unless it is published', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO assessment_rule_version
             (rule_key, version, rule_kind, evidence_level, max_urgency,
              required_item_verification, required_profile_provenance, explanation_template_id,
              review_state, shadow_mode, enabled)
           VALUES ('y', 'v1', 'EXPIRY', 'B', 'LOW', ARRAY['CONFIRMED'], ARRAY['USER_REPORTED'],
                   'tpl', 'IN_REVIEW', false, true)`,
        ),
      ),
    );
    expect(message).toMatch(/live_requires_published/i);
  });

  it('keeps an emerging-evidence rule in shadow mode', async () => {
    // Spec 09: evidence level E is internal monitoring only in the MVP.
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO assessment_rule_version
             (rule_key, version, rule_kind, evidence_level, max_urgency,
              required_item_verification, required_profile_provenance, explanation_template_id,
              review_state, approved_by_reviewer_id, approved_at, shadow_mode)
           VALUES ('z', 'v1', 'EXPIRY', 'E', 'LOW', ARRAY['CONFIRMED'], ARRAY['USER_REPORTED'],
                   'tpl', 'PUBLISHED', 'r', now(), false)`,
        ),
      ),
    );
    expect(message).toMatch(/emerging_evidence_stays_shadow/i);
  });

  it('refuses an unmatched assessment carrying actionable urgency', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO profile_assessment
             (profile_id, owned_item_id, rule_version_id, matched, match_confidence,
              evidence_level, urgency, explanation_template_id, normalization_version,
              evaluated_at)
           VALUES ($1, $2, $3, false, 'NOT_MATCHED', 'A', 'CRITICAL', 'tpl', 'n1', now())`,
          [PROFILE, ITEM, ruleId],
        ),
      ),
    );
    expect(message).toMatch(/unmatched_is_informational/i);
  });

  it('gives the app role no way to create an assessment', async () => {
    // Spec 11/12: the server is authoritative for severity. Threat A3 is a client-authored alert.
    const message = await expectDenied(() =>
      t.asUser(USER, (db) =>
        db.query(
          `INSERT INTO profile_assessment
             (profile_id, owned_item_id, rule_version_id, matched, match_confidence,
              evidence_level, urgency, explanation_template_id, normalization_version,
              evaluated_at)
           VALUES ($1, $2, $3, true, 'EXACT', 'A', 'CRITICAL', 'tpl', 'n1', now())`,
          [PROFILE, ITEM, ruleId],
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('gives the app role no way to publish an alert', async () => {
    const message = await expectDenied(() =>
      t.asUser(USER, (db) =>
        db.query(
          `INSERT INTO alert_publication (assessment_id, profile_id, dedupe_key)
           VALUES ($1, $2, 'k')`,
          [testUuid(999), PROFILE],
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('hides shadow-mode assessments from users', async () => {
    await t.asService((db) =>
      db.query(
        `INSERT INTO profile_assessment
           (profile_id, owned_item_id, rule_version_id, matched, match_confidence,
            evidence_level, urgency, explanation_template_id, normalization_version,
            evaluated_at, shadow_only)
         VALUES ($1, $2, $3, true, 'EXACT', 'A', 'HIGH', 'tpl', 'n1', now(), true)`,
        [PROFILE, ITEM, ruleId],
      ),
    );

    const res = await t.asUser(USER, (db) =>
      db.query('SELECT id FROM profile_assessment WHERE shadow_only'),
    );
    expect(res.rows).toEqual([]);
  });

  it('shows a live assessment to a user with the safety capability', async () => {
    await t.asService((db) =>
      db.query(
        `INSERT INTO profile_assessment
           (profile_id, owned_item_id, rule_version_id, matched, match_confidence,
            evidence_level, urgency, explanation_template_id, normalization_version,
            evaluated_at, shadow_only)
         VALUES ($1, $2, $3, true, 'EXACT', 'A', 'HIGH', 'tpl', 'n1', now(), false)`,
        [PROFILE, ITEM, ruleId],
      ),
    );

    const res = await t.asUser(USER, (db) =>
      db.query('SELECT id FROM profile_assessment WHERE NOT shadow_only'),
    );
    expect(res.rows).toHaveLength(1);
  });

  it('keeps assessments append-only so history survives correction', async () => {
    const message = await expectDenied(() =>
      t.asOwner((db) => db.query(`UPDATE profile_assessment SET urgency = 'CRITICAL'`)),
    );
    expect(message).toMatch(/append-only/i);
  });

  it('stops a withdrawn alert being visible', async () => {
    // Spec 19 release-blocking defect class: "stale withdrawn alert still actionable".
    const assessment = await t.asService((db) =>
      db.query<{ id: string }>(
        `INSERT INTO profile_assessment
           (profile_id, owned_item_id, rule_version_id, matched, match_confidence,
            evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at)
         VALUES ($1, $2, $3, true, 'EXACT', 'A', 'HIGH', 'tpl', 'n1', now()) RETURNING id`,
        [PROFILE, ITEM, ruleId],
      ),
    );
    const assessmentId = assessment.rows[0]!.id;

    const publication = await t.asService((db) =>
      db.query<{ id: string }>(
        `INSERT INTO alert_publication (assessment_id, profile_id, dedupe_key)
         VALUES ($1, $2, 'dedupe-withdraw-test') RETURNING id`,
        [assessmentId, PROFILE],
      ),
    );

    const before = await t.asUser(USER, (db) =>
      db.query('SELECT id FROM alert_publication WHERE dedupe_key = $1', ['dedupe-withdraw-test']),
    );
    expect(before.rows).toHaveLength(1);

    await t.asService((db) =>
      db.query(
        `UPDATE alert_publication
         SET state = 'WITHDRAWN', withdrawn_at = now(), withdrawn_reason = 'source corrected'
         WHERE id = $1`,
        [publication.rows[0]!.id],
      ),
    );

    const after = await t.asUser(USER, (db) =>
      db.query('SELECT id FROM alert_publication WHERE dedupe_key = $1', ['dedupe-withdraw-test']),
    );
    expect(after.rows).toEqual([]);
  });

  it('requires a reason when withdrawing', async () => {
    // Spec 10 governance audit artifacts require the correction/withdrawal reason to be
    // recorded, so a withdrawal with no reason must be refused rather than silently accepted.
    const publicationId = await t.asService(async (db) => {
      const assessment = await db.query<{ id: string }>(
        `INSERT INTO profile_assessment
           (profile_id, owned_item_id, rule_version_id, matched, match_confidence,
            evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at)
         VALUES ($1, $2, $3, true, 'EXACT', 'A', 'HIGH', 'tpl', 'n1', now()) RETURNING id`,
        [PROFILE, ITEM, ruleId],
      );
      const publication = await db.query<{ id: string }>(
        `INSERT INTO alert_publication (assessment_id, profile_id, dedupe_key)
         VALUES ($1, $2, 'dedupe-reason-test') RETURNING id`,
        [assessment.rows[0]!.id, PROFILE],
      );
      return publication.rows[0]!.id;
    });

    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(`UPDATE alert_publication SET state = 'WITHDRAWN' WHERE id = $1`, [publicationId]),
      ),
    );
    expect(message).toMatch(/withdrawn_has_reason/i);

    // With a reason, the same withdrawal is accepted.
    const ok = await t.asService((db) =>
      db.query(
        `UPDATE alert_publication
         SET state = 'WITHDRAWN', withdrawn_at = now(), withdrawn_reason = 'source corrected'
         WHERE id = $1`,
        [publicationId],
      ),
    );
    expect(ok.affectedRows).toBe(1);
  });

  it('deduplicates published alerts per profile', async () => {
    const assessment = await t.asService((db) =>
      db.query<{ id: string }>(
        `INSERT INTO profile_assessment
           (profile_id, owned_item_id, rule_version_id, matched, match_confidence,
            evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at)
         VALUES ($1, $2, $3, true, 'EXACT', 'A', 'HIGH', 'tpl', 'n1', now()) RETURNING id`,
        [PROFILE, ITEM, ruleId],
      ),
    );

    await t.asService((db) =>
      db.query(
        `INSERT INTO alert_publication (assessment_id, profile_id, dedupe_key)
         VALUES ($1, $2, 'dupe-key')`,
        [assessment.rows[0]!.id, PROFILE],
      ),
    );

    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO alert_publication (assessment_id, profile_id, dedupe_key)
           VALUES ($1, $2, 'dupe-key')`,
          [assessment.rows[0]!.id, PROFILE],
        ),
      ),
    );
    expect(message).toMatch(/duplicate key|alert_dedupe/i);
  });
});

describe('safety receipt vocabulary (spec 09 medication safety language)', () => {
  it('has no resolution meaning the user stopped a prescription medicine', async () => {
    // Kynviora is never permitted to tell a user to stop a prescription medicine, so it never
    // records having done so. The vocabulary contains no such outcome.
    const message = await expectDenied(() =>
      t.asService(async (db) => {
        const a = await db.query<{ id: string }>(`SELECT id FROM profile_assessment LIMIT 1`);
        const p = await db.query<{ id: string }>(
          `SELECT id FROM alert_publication WHERE state = 'PUBLISHED' LIMIT 1`,
        );
        return db.query(
          `INSERT INTO safety_receipt
             (profile_id, alert_publication_id, assessment_id, resolution, resolved_at)
           VALUES ($1, $2, $3, 'STOPPED_MEDICINE', now())`,
          [PROFILE, p.rows[0]!.id, a.rows[0]!.id],
        );
      }),
    );
    expect(message).toMatch(/resolution_valid/i);
  });
});
