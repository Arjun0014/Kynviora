import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  PUBLICATION_CHECKLIST,
  instantFrom,
  noopLogger,
  unsafeId,
  type Instant,
  type UserId,
} from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Reviewer console, end to end (spec 04 Phase 6.6).
 *
 * The two exit criteria are asserted against the live flow. "High-impact content cannot be
 * published by an unauthorized single path" appears here as four separate refusals - not a
 * reviewer, not that role, not enough people, not a second pair of hands - because each one is a
 * different way the single path comes back. "Publication is attributable, reversible, and scoped
 * to the intended jurisdiction" is asserted by publishing for GB and checking NI did not come
 * with it, and by withdrawing while publication is globally blocked.
 */

const ADMIN = testUuid(1);
const AUTHOR = testUuid(2);
const CLINICAL_ONE = testUuid(3);
const CLINICAL_TWO = testUuid(4);
const LEGAL_ONE = testUuid(5);
const LEGAL_TWO = testUuid(6);
const OUTSIDER = testUuid(7);

const SOURCE = testUuid(50);

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;
let currentNow: Instant = NOW;

/** A reviewer session that has completed step-up, which publish and withdraw both require. */
function verified(userId: string): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt: NOW };
}

function stale(userId: string): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt: null };
}

let subjectCounter = 200;
function nextSubject(): string {
  subjectCounter += 1;
  return testUuid(subjectCounter);
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [ADMIN, 'admin@example.test'],
      [AUTHOR, 'author@example.test'],
      [CLINICAL_ONE, 'clinical1@example.test'],
      [CLINICAL_TWO, 'clinical2@example.test'],
      [LEGAL_ONE, 'legal1@example.test'],
      [LEGAL_TWO, 'legal2@example.test'],
      [OUTSIDER, 'outsider@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
    await db.query(
      `INSERT INTO source_registry_entry
         (id, organization, source_name, source_class, jurisdiction, allowed_influence,
          license_review_state, expected_refresh_interval_ms, parser_version, status,
          coverage_statement)
       VALUES ($1, 'Synthetic Authority', 'Synthetic Register', 'PRIMARY_LEGAL', 'GB',
               ARRAY['REGULATORY_STATUS']::text[], 'APPROVED', 86400000, '1.0.0', 'ACTIVE',
               'Synthetic coverage for tests.')`,
      [SOURCE],
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
    surface: 'STAFF',
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

beforeEach(async () => {
  currentNow = NOW;
  // `publication_request`, `publication_approval` and the target tables are all append-only, so
  // fixtures are scoped by target rather than cleared - the same reason trap 9 gives for
  // `audit_event`. Only the reviewer roles and the global block reset between tests.
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM reviewer');
    await db.query(
      `UPDATE publication_control
          SET publication_blocked = false, blocked_reason = NULL,
              blocked_by_user_id = NULL, blocked_at = NULL`,
    );
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  try {
    return await app.inject(options);
  } finally {
    currentPrincipal = null;
  }
}

async function grantRole(userId: string, role: string) {
  await t.asService((db) =>
    db.query(
      `INSERT INTO reviewer (user_id, role, granted_by_user_id, granted_at)
       VALUES ($1, $2, $3, now())`,
      [userId, role, ADMIN],
    ),
  );
}

/** A candidate safety rule, ready to be published. */
async function candidateRule(id: string) {
  await t.asService((db) =>
    db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id)
       VALUES ($1, $2, '1.0.0', 'EXPIRY', 'A', 'HIGH',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.expiry')`,
      [id, `synthetic.${id.slice(-6)}`],
    ),
  );
}

/**
 * A regulatory record that the Citation Gate will refuse.
 *
 * No source document, no legal reference, and unverified - exactly the record the gate exists to
 * stop, and the point of the test that uses it is that two approvals do not override it.
 */
async function ungatedRegulatoryRecord(id: string) {
  await t.asService((db) =>
    db.query(
      `INSERT INTO regulatory_rule_version
         (id, jurisdiction, substance_canonical_key, statuses, source_registry_entry_id,
          extraction_version)
       VALUES ($1, 'GB', $2, ARRAY['RESTRICTED']::text[], $3, '1.0.0')`,
      [id, `substance.${id.slice(-6)}`, SOURCE],
    ),
  );
}

/**
 * A shadow run of a rule, so a two-person publication request can name its evidence.
 *
 * Migration 0013 requires it, and requires the run to be a run of that rule.
 */
async function shadowRunFor(ruleId: string): Promise<string> {
  const res = await t.asService((db) =>
    db.query<{ id: string }>(
      `INSERT INTO shadow_run
         (rule_version_id, dataset_kind, dataset_label, dataset_size, matched_items,
          affected_products, affected_formulations, potential_user_matches,
          evaluation_instant, normalization_version, run_by_user_id, run_at)
       VALUES ($1, 'SYNTHETIC', 'synthetic fixture', 10, 2, 1, 1, 2, now(), 'norm-1', $2, now())
       RETURNING id`,
      [ruleId, AUTHOR],
    ),
  );
  return res.rows[0]?.id ?? '';
}

interface CreatedBody {
  readonly requestId: string;
  readonly requiredApprovals: number;
}

async function openRequest(
  as: Principal,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: CreatedBody }> {
  const response = await request(as, {
    method: 'POST',
    url: '/v1/reviewer/requests',
    payload,
  });
  return { status: response.statusCode, body: response.json<CreatedBody>() };
}

/**
 * Record a decision.
 *
 * The checklist defaults to complete because most tests are about something else; the tests that
 * are about the checklist pass their own.
 */
async function decide(as: Principal, requestId: string, payload: Record<string, unknown>) {
  return request(as, {
    method: 'POST',
    url: `/v1/reviewer/requests/${requestId}/decisions`,
    payload: { checklist: [...PUBLICATION_CHECKLIST], ...payload },
  });
}

async function execute(as: Principal, requestId: string) {
  return request(as, { method: 'POST', url: `/v1/reviewer/requests/${requestId}/execute` });
}

function publishRulePayload(
  subjectId: string,
  jurisdictions: string[] = ['GB'],
  shadowRunId?: string,
) {
  return {
    subjectKind: 'assessment_rule_version',
    subjectId,
    action: 'PUBLISH',
    jurisdictions,
    maxUrgency: 'HIGH',
    evidenceLevel: 'A',
    ...(shadowRunId === undefined ? {} : { shadowRunId }),
  };
}

/** A candidate rule plus the shadow run a two-person publication of it must name. */
async function ruleWithEvidence(): Promise<{ subjectId: string; shadowRunId: string }> {
  const subjectId = nextSubject();
  await candidateRule(subjectId);
  return { subjectId, shadowRunId: await shadowRunFor(subjectId) };
}

// ---------------------------------------------------------------------------

describe('the console is closed to everyone but reviewers', () => {
  it('does not admit someone with no reviewer role, on any route', async () => {
    // 404 rather than 403: the console must not be an oracle for whether a queue item exists.
    // 403 belongs to step-up alone.
    const queue = await request(stale(OUTSIDER), { method: 'GET', url: '/v1/reviewer/queue' });
    expect(queue.statusCode).toBe(404);

    const created = await openRequest(stale(OUTSIDER), publishRulePayload(nextSubject()));
    expect(created.status).toBe(404);

    const one = await request(stale(OUTSIDER), {
      method: 'GET',
      url: `/v1/reviewer/requests/${testUuid(999)}`,
    });
    expect(one.statusCode).toBe(404);
  });

  it('does not admit an unauthenticated caller', async () => {
    const response = await request(null, { method: 'GET', url: '/v1/reviewer/queue' });
    expect(response.statusCode).toBe(401);
  });
});

describe('opening a request', () => {
  beforeEach(async () => {
    await grantRole(AUTHOR, 'CLINICAL_SAFETY_LEAD');
  });

  it('needs two approvals for high-urgency content', async () => {
    const { subjectId, shadowRunId } = await ruleWithEvidence();
    const created = await openRequest(
      stale(AUTHOR),
      publishRulePayload(subjectId, ['GB'], shadowRunId),
    );
    expect(created.status).toBe(201);
    expect(created.body.requiredApprovals).toBe(2);
  });

  it('needs one for low-urgency content', async () => {
    const created = await openRequest(stale(AUTHOR), {
      ...publishRulePayload(nextSubject()),
      maxUrgency: 'INFORMATIONAL',
    });
    expect(created.body.requiredApprovals).toBe(1);
  });

  it('refuses a publication that does not say what the content is', async () => {
    const response = await request(stale(AUTHOR), {
      method: 'POST',
      url: '/v1/reviewer/requests',
      payload: {
        subjectKind: 'assessment_rule_version',
        subjectId: nextSubject(),
        action: 'PUBLISH',
        jurisdictions: ['GB'],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'publish_needs_declared_impact' } },
    });
  });

  it('refuses a jurisdiction Kynviora does not monitor', async () => {
    // GB and NI are separate by design, and there is no UK.
    const response = await request(stale(AUTHOR), {
      method: 'POST',
      url: '/v1/reviewer/requests',
      payload: { ...publishRulePayload(nextSubject()), jurisdictions: ['UK'] },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('recording a decision', () => {
  let subjectId: string;
  let requestId: string;

  beforeEach(async () => {
    await grantRole(AUTHOR, 'CLINICAL_SAFETY_LEAD');
    await grantRole(CLINICAL_ONE, 'CLINICAL_SAFETY_LEAD');
    await grantRole(CLINICAL_TWO, 'MEDICATION_SAFETY_REVIEWER');
    await grantRole(LEGAL_ONE, 'REGULATORY_LEGAL_REVIEWER');
    const fixture = await ruleWithEvidence();
    subjectId = fixture.subjectId;
    requestId = (
      await openRequest(stale(AUTHOR), publishRulePayload(subjectId, ['GB'], fixture.shadowRunId))
    ).body.requestId;
  });

  it('refuses a role the caller does not hold', async () => {
    // Spec 14: the role in the body is a claim, and a claim is not authorization.
    const response = await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'PRODUCT_SAFETY_REVIEWER',
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a role that cannot judge this kind of content', async () => {
    // 400 rather than 404: the caller is an established reviewer who can already see this
    // request in their queue, so there is nothing left to hide and the reason is useful. A bare
    // 404 is for callers whose standing to look at all is in question.
    const response = await decide(stale(LEGAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'REGULATORY_LEGAL_REVIEWER',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'role_not_permitted_for_kind' } },
    });
  });

  it('refuses the requester approving their own publication', async () => {
    const response = await decide(stale(AUTHOR), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'separation_of_duties' } },
    });
  });

  it('reviews the whole request when no narrower scope is given', async () => {
    const response = await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tally: [{ jurisdiction: 'GB', approvals: 1 }] });
  });

  it('closes the request when a reviewer rejects it', async () => {
    const rejected = await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'REJECT',
      role: 'CLINICAL_SAFETY_LEAD',
      note: 'The matching criteria are too broad.',
    });
    expect(rejected.statusCode).toBe(200);

    // Leaving it open would let a later approval accumulate against an objection nobody withdrew.
    const later = await decide(stale(CLINICAL_TWO), requestId, {
      decision: 'APPROVE',
      role: 'MEDICATION_SAFETY_REVIEWER',
    });
    expect(later.statusCode).toBe(400);
    expect(later.json()).toMatchObject({
      error: { detail: { reason_code: 'request_not_open' } },
    });
  });

  it('records who reviewed, in which role, and over what scope', async () => {
    await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
      note: 'Checked against the source register.',
    });
    const view = await request(stale(CLINICAL_TWO), {
      method: 'GET',
      url: `/v1/reviewer/requests/${requestId}`,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      approvals: [
        {
          reviewerUserId: CLINICAL_ONE,
          role: 'CLINICAL_SAFETY_LEAD',
          decision: 'APPROVE',
          jurisdictions: ['GB'],
        },
      ],
    });
  });
});

describe('executing a publication', () => {
  let subjectId: string;
  let requestId: string;

  beforeEach(async () => {
    await grantRole(AUTHOR, 'CLINICAL_SAFETY_LEAD');
    await grantRole(CLINICAL_ONE, 'CLINICAL_SAFETY_LEAD');
    await grantRole(CLINICAL_TWO, 'MEDICATION_SAFETY_REVIEWER');
    const fixture = await ruleWithEvidence();
    subjectId = fixture.subjectId;
    requestId = (
      await openRequest(stale(AUTHOR), publishRulePayload(subjectId, ['GB'], fixture.shadowRunId))
    ).body.requestId;
  });

  it('requires step-up', async () => {
    // Spec 13 and 14: step-up for high-impact publish/withdraw. 403 belongs to this and nothing
    // else in the API.
    const response = await execute(stale(CLINICAL_ONE), requestId);
    expect(response.statusCode).toBe(403);
  });

  it('refuses one approval where two are required', async () => {
    await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
    });
    const response = await execute(verified(CLINICAL_TWO), requestId);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'insufficient_approvals', required: 2 } },
    });
  });

  it('publishes on two approvals and writes the approved scope onto the rule', async () => {
    await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
    });
    await decide(stale(CLINICAL_TWO), requestId, {
      decision: 'APPROVE',
      role: 'MEDICATION_SAFETY_REVIEWER',
    });

    const response = await execute(verified(CLINICAL_TWO), requestId);
    expect(response.statusCode).toBe(200);

    const stored = await t.asService((db) =>
      db.query<{
        review_state: string;
        approved_jurisdictions: string[];
        approved_by_reviewer_id: string;
      }>(
        `SELECT review_state, approved_jurisdictions, approved_by_reviewer_id
           FROM assessment_rule_version WHERE id = $1`,
        [subjectId],
      ),
    );
    expect(stored.rows[0]?.review_state).toBe('PUBLISHED');
    // A safety rule has no jurisdiction of its own, so without this it would run everywhere the
    // moment it was published.
    expect(stored.rows[0]?.approved_jurisdictions).toEqual(['GB']);
    // The reviewer column used to hold free text. It now names a real user (spec 13, no shared
    // accounts).
    expect(stored.rows[0]?.approved_by_reviewer_id).toBe(CLINICAL_TWO);
  });

  it('does not publish for a jurisdiction nobody reviewed', async () => {
    const wideFixture = await ruleWithEvidence();
    const wideSubject = wideFixture.subjectId;
    const wide = (
      await openRequest(
        stale(AUTHOR),
        publishRulePayload(wideSubject, ['GB', 'NI'], wideFixture.shadowRunId),
      )
    ).body.requestId;

    await decide(stale(CLINICAL_ONE), wide, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
      jurisdictions: ['GB', 'NI'],
    });
    await decide(stale(CLINICAL_TWO), wide, {
      decision: 'APPROVE',
      role: 'MEDICATION_SAFETY_REVIEWER',
      jurisdictions: ['GB'],
    });

    const response = await execute(verified(CLINICAL_TWO), wide);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { short_jurisdictions: 'NI' } },
    });

    const stored = await t.asService((db) =>
      db.query<{ review_state: string }>(
        'SELECT review_state FROM assessment_rule_version WHERE id = $1',
        [wideSubject],
      ),
    );
    expect(stored.rows[0]?.review_state).toBe('CANDIDATE');
  });

  it('refuses the requester publishing their own request', async () => {
    await grantRole(LEGAL_ONE, 'PRODUCT_SAFETY_REVIEWER');
    await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
    });
    await decide(stale(CLINICAL_TWO), requestId, {
      decision: 'APPROVE',
      role: 'MEDICATION_SAFETY_REVIEWER',
    });

    const response = await execute(verified(AUTHOR), requestId);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'separation_of_duties' } },
    });
  });

  it('records the publication in the audit log without the content', async () => {
    await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
    });
    await decide(stale(CLINICAL_TWO), requestId, {
      decision: 'APPROVE',
      role: 'MEDICATION_SAFETY_REVIEWER',
    });
    await execute(verified(CLINICAL_TWO), requestId);

    const events = await t.asService((db) =>
      db.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_event
          WHERE action = 'publication.executed' AND target_id = $1`,
        [requestId],
      ),
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.detail).toMatchObject({
      action: 'PUBLISH',
      jurisdictions: 'GB',
      required_approvals: 2,
      approver_count: 2,
    });
  });
});

describe('the Citation Gate is not overridden by approvals', () => {
  it('refuses to publish a regulatory record that lacks its evidence', async () => {
    // The shape of the whole design: the reviewer console is one governance layer and the gate is
    // another, and satisfying one does not satisfy the other. Two qualified people approved this
    // and the storage layer still refuses, because the record has no source document, no legal
    // reference and no verification.
    await grantRole(AUTHOR, 'REGULATORY_LEGAL_REVIEWER');
    await grantRole(LEGAL_ONE, 'REGULATORY_LEGAL_REVIEWER');
    await grantRole(LEGAL_TWO, 'REGULATORY_LEGAL_REVIEWER');

    const subjectId = nextSubject();
    await ungatedRegulatoryRecord(subjectId);

    const requestId = (
      await openRequest(stale(AUTHOR), {
        subjectKind: 'regulatory_rule_version',
        subjectId,
        action: 'PUBLISH',
        jurisdictions: ['GB'],
        maxUrgency: 'HIGH',
        evidenceLevel: 'A',
      })
    ).body.requestId;

    await decide(stale(LEGAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'REGULATORY_LEGAL_REVIEWER',
    });
    await decide(stale(LEGAL_TWO), requestId, {
      decision: 'APPROVE',
      role: 'REGULATORY_LEGAL_REVIEWER',
    });

    const response = await execute(verified(LEGAL_TWO), requestId);
    expect(response.statusCode).toBe(500);

    // The request stays open rather than recording a publication that did not happen.
    const stored = await t.asService((db) =>
      db.query<{ state: string }>('SELECT state FROM publication_request WHERE id = $1', [
        requestId,
      ]),
    );
    expect(stored.rows[0]?.state).toBe('OPEN');

    const target = await t.asService((db) =>
      db.query<{ review_state: string }>(
        'SELECT review_state FROM regulatory_rule_version WHERE id = $1',
        [subjectId],
      ),
    );
    expect(target.rows[0]?.review_state).toBe('CANDIDATE');
  });
});

describe('emergency controls', () => {
  beforeEach(async () => {
    await grantRole(AUTHOR, 'CLINICAL_SAFETY_LEAD');
    await grantRole(CLINICAL_ONE, 'CLINICAL_SAFETY_LEAD');
    await grantRole(CLINICAL_TWO, 'MEDICATION_SAFETY_REVIEWER');
  });

  async function blockPublication(as: Parameters<typeof request>[0], reason: string | null) {
    return request(as, {
      method: 'POST',
      url: '/v1/reviewer/publication-block',
      payload: { blocked: true, reason },
    });
  }

  it('requires step-up to block publication', async () => {
    const response = await blockPublication(stale(CLINICAL_ONE), 'Source parser corruption.');
    expect(response.statusCode).toBe(403);
  });

  it('refuses a block with no reason', async () => {
    // The first thing an incident review asks about.
    const response = await blockPublication(verified(CLINICAL_ONE), null);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'block_needs_a_reason' } },
    });
  });

  it('stops a publication that would otherwise be ready', async () => {
    const subjectId = nextSubject();
    await candidateRule(subjectId);
    const requestId = (
      await openRequest(stale(AUTHOR), {
        ...publishRulePayload(subjectId),
        maxUrgency: 'INFORMATIONAL',
      })
    ).body.requestId;
    await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
    });

    expect(
      (await blockPublication(verified(CLINICAL_TWO), 'Incident in progress.')).statusCode,
    ).toBe(200);

    const response = await execute(verified(CLINICAL_TWO), requestId);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'publication_blocked' } },
    });
  });

  it('still withdraws a live alert while publication is blocked', async () => {
    // One of spec 10's emergency controls exists to undo the other. A block that also stopped
    // withdrawals would leave a wrong alert live with no way to stop it.
    const subjectId = nextSubject();
    await candidateRule(subjectId);
    await t.asService((db) =>
      db.query(
        `UPDATE assessment_rule_version
            SET review_state = 'PUBLISHED', approved_by_reviewer_id = $1, approved_at = now(),
                approved_jurisdictions = ARRAY['GB']::text[]
          WHERE id = $2`,
        [CLINICAL_ONE, subjectId],
      ),
    );

    await blockPublication(verified(CLINICAL_TWO), 'Incident in progress.');

    const requestId = (
      await openRequest(stale(AUTHOR), {
        subjectKind: 'assessment_rule_version',
        subjectId,
        action: 'WITHDRAW',
        jurisdictions: ['GB'],
        withdrawalReason: 'The matching criteria were too broad.',
      })
    ).body.requestId;

    // One person, and the requester may be that person. Requiring a second before a live wrong
    // rule can be stopped would make the safe direction the slow one.
    await decide(stale(AUTHOR), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
    });
    const response = await execute(verified(AUTHOR), requestId);
    expect(response.statusCode).toBe(200);

    const stored = await t.asService((db) =>
      db.query<{ review_state: string; enabled: boolean }>(
        'SELECT review_state, enabled FROM assessment_rule_version WHERE id = $1',
        [subjectId],
      ),
    );
    expect(stored.rows[0]?.review_state).toBe('WITHDRAWN');
    expect(stored.rows[0]?.enabled).toBe(false);
  });

  it('says that withdrawal remains available when it blocks publication', async () => {
    const response = await blockPublication(verified(CLINICAL_ONE), 'Source parser corruption.');
    expect(response.json()).toMatchObject({
      publicationBlocked: true,
      withdrawalStillAvailable: true,
    });
  });
});

describe('the queue', () => {
  it('shows what is open, with a tally per jurisdiction', async () => {
    await grantRole(AUTHOR, 'CLINICAL_SAFETY_LEAD');
    await grantRole(CLINICAL_ONE, 'CLINICAL_SAFETY_LEAD');

    const { subjectId, shadowRunId } = await ruleWithEvidence();
    const requestId = (
      await openRequest(stale(AUTHOR), publishRulePayload(subjectId, ['GB', 'NI'], shadowRunId))
    ).body.requestId;
    await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
      jurisdictions: ['GB'],
    });

    const queue = await request(stale(CLINICAL_ONE), { method: 'GET', url: '/v1/reviewer/queue' });
    expect(queue.statusCode).toBe(200);
    const item = queue
      .json<{ items: { requestId: string; tally: unknown; youMayApprove: boolean }[] }>()
      .items.find((i) => i.requestId === requestId);
    // A single "1 of 2" would hide the scope nobody has reviewed.
    expect(item?.tally).toEqual([
      { jurisdiction: 'GB', approvals: 1 },
      { jurisdiction: 'NI', approvals: 0 },
    ]);
  });

  it('tells the requester they may not approve their own publication', async () => {
    await grantRole(AUTHOR, 'CLINICAL_SAFETY_LEAD');
    const { subjectId, shadowRunId } = await ruleWithEvidence();
    const requestId = (
      await openRequest(stale(AUTHOR), publishRulePayload(subjectId, ['GB'], shadowRunId))
    ).body.requestId;

    const queue = await request(stale(AUTHOR), { method: 'GET', url: '/v1/reviewer/queue' });
    const item = queue
      .json<{ items: { requestId: string; youMayApprove: boolean }[] }>()
      .items.find((i) => i.requestId === requestId);
    expect(item?.youMayApprove).toBe(false);
  });
});

describe("spec 10's publication checklist", () => {
  beforeEach(async () => {
    await grantRole(AUTHOR, 'CLINICAL_SAFETY_LEAD');
    await grantRole(CLINICAL_ONE, 'CLINICAL_SAFETY_LEAD');
  });

  it('tells the requester up front whether the checks will be needed', async () => {
    const { subjectId, shadowRunId } = await ruleWithEvidence();
    const high = await openRequest(
      stale(AUTHOR),
      publishRulePayload(subjectId, ['GB'], shadowRunId),
    );
    expect(high.body).toMatchObject({ checklistRequired: true });

    const low = await openRequest(stale(AUTHOR), {
      ...publishRulePayload(nextSubject()),
      maxUrgency: 'INFORMATIONAL',
    });
    expect(low.body).toMatchObject({ checklistRequired: false });
  });

  it('refuses a high-severity approval that skipped a check', async () => {
    const { subjectId, shadowRunId } = await ruleWithEvidence();
    const requestId = (
      await openRequest(stale(AUTHOR), publishRulePayload(subjectId, ['GB'], shadowRunId))
    ).body.requestId;

    const response = await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
      checklist: PUBLICATION_CHECKLIST.filter((i) => i !== 'INCIDENT_OWNER'),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'checklist_incomplete', missing: 'INCIDENT_OWNER' } },
    });
  });

  it('records what each reviewer confirmed, separately', async () => {
    // Per approval, not per request: the point of a second reviewer is that they check
    // independently.
    const { subjectId, shadowRunId } = await ruleWithEvidence();
    const requestId = (
      await openRequest(stale(AUTHOR), publishRulePayload(subjectId, ['GB'], shadowRunId))
    ).body.requestId;
    await decide(stale(CLINICAL_ONE), requestId, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
    });

    const stored = await t.asService((db) =>
      db.query<{ checklist_confirmed: string[] }>(
        'SELECT checklist_confirmed FROM publication_approval WHERE request_id = $1',
        [requestId],
      ),
    );
    expect(stored.rows[0]?.checklist_confirmed).toHaveLength(PUBLICATION_CHECKLIST.length);
  });
});
