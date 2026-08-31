import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Database-level tests for the reviewer console (migration `0012`).
 *
 * Spec 14 requires that direct editing of publication state is not a normal workflow. These tests
 * establish that it is not an abnormal one either: the approval count, the separation of duties,
 * the requirement that an approver holds an active stored role, and the per-jurisdiction scope
 * are all triggers, so a direct SQL statement is refused exactly as an API call would be.
 *
 * Every assertion runs as the non-superuser `kynviora_app` or `kynviora_service` role (DEC-005).
 */

const ADMIN = testUuid(1);
const AUTHOR = testUuid(2);
const CLINICAL_ONE = testUuid(3);
const CLINICAL_TWO = testUuid(4);
const LEGAL = testUuid(5);
const OUTSIDER = testUuid(6);
const SUSPENDED = testUuid(7);

const NOW = '2026-08-29T12:00:00.000Z';
const LATER = '2026-08-29T12:30:00.000Z';

const RULE = testUuid(40);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [ADMIN, 'admin@example.test'],
      [AUTHOR, 'author@example.test'],
      [CLINICAL_ONE, 'clinical1@example.test'],
      [CLINICAL_TWO, 'clinical2@example.test'],
      [LEGAL, 'legal@example.test'],
      [OUTSIDER, 'outsider@example.test'],
      [SUSPENDED, 'suspended@example.test'],
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

/**
 * A fresh subject per test.
 *
 * `publication_request`, `publication_approval` and `assessment_rule_version` are all
 * append-only, and the DELETE their teardown would need is refused - correctly, and for the same
 * reason trap 9 says not to clear `audit_event`. So fixtures are scoped by target instead of
 * cleared, and each test gets its own subject ID so the partial unique index over open requests
 * does not collide across tests.
 */
let subjectCounter = 100;
function nextSubject(): string {
  subjectCounter += 1;
  return testUuid(subjectCounter);
}

beforeEach(async () => {
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM reviewer');
    await db.query(
      `UPDATE publication_control
          SET publication_blocked = false, blocked_reason = NULL,
              blocked_by_user_id = NULL, blocked_at = NULL`,
    );
  });
});

async function grantRole(userId: string, role: string, status = 'ACTIVE') {
  await t.asService((db) =>
    db.query(
      `INSERT INTO reviewer (user_id, role, status, granted_by_user_id, granted_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, role, status, ADMIN, NOW, status === 'REVOKED' ? LATER : null],
    ),
  );
}

async function makeRequest(
  overrides: {
    kind?: string;
    action?: string;
    jurisdictions?: string[];
    required?: number;
    maxUrgency?: string | null;
    evidenceLevel?: string | null;
    withdrawalReason?: string | null;
    requestedBy?: string;
    subjectId?: string;
  } = {},
): Promise<string> {
  const action = overrides.action ?? 'PUBLISH';
  const res = await t.asService((db) =>
    db.query<{ id: string }>(
      `INSERT INTO publication_request
         (subject_kind, subject_id, action, jurisdictions, max_urgency, evidence_level,
          required_approvals, requested_by_user_id, requested_at, withdrawal_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        overrides.kind ?? 'alert_publication',
        overrides.subjectId ?? nextSubject(),
        action,
        overrides.jurisdictions ?? ['GB'],
        overrides.maxUrgency === undefined
          ? action === 'PUBLISH'
            ? 'HIGH'
            : null
          : overrides.maxUrgency,
        overrides.evidenceLevel === undefined
          ? action === 'PUBLISH'
            ? 'A'
            : null
          : overrides.evidenceLevel,
        overrides.required ?? 2,
        overrides.requestedBy ?? AUTHOR,
        NOW,
        overrides.withdrawalReason === undefined
          ? action === 'WITHDRAW'
            ? 'The batch number was wrong.'
            : null
          : overrides.withdrawalReason,
      ],
    ),
  );
  return res.rows[0]?.id ?? '';
}

/** Spec 10's high-severity publication checklist, in full. */
const FULL_CHECKLIST = [
  'SOURCE_AUTHENTICITY',
  'EXACT_JURISDICTION',
  'AFFECTED_IDENTIFIERS',
  'RULE_MATCHING_BEHAVIOUR',
  'USER_ACTION_WORDING',
  'MEDICATION_BOUNDARY',
  'EXPECTED_MATCH_VOLUME',
  'NOTIFICATION_POLICY',
  'WITHDRAWAL_READINESS',
  'INCIDENT_OWNER',
];

async function approve(
  requestId: string,
  userId: string,
  overrides: {
    role?: string;
    decision?: string;
    jurisdictions?: string[];
    checklist?: string[];
  } = {},
) {
  return t.asService((db) =>
    db.query(
      `INSERT INTO publication_approval
         (request_id, reviewer_user_id, reviewer_role, decision, jurisdictions,
          checklist_confirmed, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        requestId,
        userId,
        overrides.role ?? 'CLINICAL_SAFETY_LEAD',
        overrides.decision ?? 'APPROVE',
        overrides.jurisdictions ?? ['GB'],
        overrides.checklist ?? FULL_CHECKLIST,
        LATER,
      ],
    ),
  );
}

async function execute(requestId: string, executor: string) {
  return t.asService((db) =>
    db.query(
      `UPDATE publication_request
          SET state = 'EXECUTED', decided_at = $1, decided_by_user_id = $2
        WHERE id = $3`,
      [LATER, executor, requestId],
    ),
  );
}

// ---------------------------------------------------------------------------

describe('a reviewer role is a stored fact, not a claim', () => {
  it('refuses a role outside the vocabulary', async () => {
    const message = await expectDenied(() => grantRole(CLINICAL_ONE, 'SUPER_APPROVER'));
    expect(message).toMatch(/reviewer_role_valid/);
  });

  it('refuses a self-granted role', async () => {
    // The ability to create an approver is itself privileged. Self-granting would make the
    // two-person rule something one compromised account could satisfy alone.
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO reviewer (user_id, role, granted_by_user_id, granted_at)
           VALUES ($1, 'CLINICAL_SAFETY_LEAD', $1, $2)`,
          [CLINICAL_ONE, NOW],
        ),
      ),
    );
    expect(message).toMatch(/reviewer_not_self_granted/);
  });

  it('refuses a second active grant of the same role to the same person', async () => {
    await grantRole(CLINICAL_ONE, 'CLINICAL_SAFETY_LEAD');
    const message = await expectDenied(() => grantRole(CLINICAL_ONE, 'CLINICAL_SAFETY_LEAD'));
    expect(message).toMatch(/reviewer_active_role_idx|duplicate key/i);
  });

  it('lets a person hold two different roles', async () => {
    await grantRole(CLINICAL_ONE, 'CLINICAL_SAFETY_LEAD');
    await grantRole(CLINICAL_ONE, 'CONTENT_PLAIN_LANGUAGE_OWNER');
    const rows = await t.asService((db) =>
      db.query('SELECT id FROM reviewer WHERE user_id = $1', [CLINICAL_ONE]),
    );
    expect(rows.rows).toHaveLength(2);
  });

  it('requires a revocation to be dated and an active grant not to be', async () => {
    const undated = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO reviewer (user_id, role, status, granted_by_user_id, granted_at)
           VALUES ($1, 'CLINICAL_SAFETY_LEAD', 'REVOKED', $2, $3)`,
          [CLINICAL_ONE, ADMIN, NOW],
        ),
      ),
    );
    expect(undated).toMatch(/reviewer_revoked_is_dated/);

    const dated = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO reviewer (user_id, role, status, granted_by_user_id, granted_at, revoked_at)
           VALUES ($1, 'CLINICAL_SAFETY_LEAD', 'ACTIVE', $2, $3, $4)`,
          [CLINICAL_ONE, ADMIN, NOW, LATER],
        ),
      ),
    );
    expect(dated).toMatch(/reviewer_active_is_undated/);
  });
});

describe('who may record an approval', () => {
  beforeEach(async () => {
    await grantRole(CLINICAL_ONE, 'CLINICAL_SAFETY_LEAD');
    await grantRole(CLINICAL_TWO, 'MEDICATION_SAFETY_REVIEWER');
    await grantRole(LEGAL, 'REGULATORY_LEGAL_REVIEWER');
    await grantRole(SUSPENDED, 'CLINICAL_SAFETY_LEAD', 'SUSPENDED');
  });

  it('refuses someone who holds no reviewer role at all', async () => {
    // Spec 14: reviewer roles are not inferred from client claims. The claim here is the
    // reviewer_role column, and the trigger checks it against the stored grant.
    const request = await makeRequest();
    const message = await expectDenied(() => approve(request, OUTSIDER));
    expect(message).toMatch(/publication_approval_role_not_held/);
  });

  it('refuses someone whose role is suspended', async () => {
    const request = await makeRequest();
    const message = await expectDenied(() => approve(request, SUSPENDED));
    expect(message).toMatch(/publication_approval_role_not_held/);
  });

  it('refuses a role that cannot judge this kind of content', async () => {
    // Spec 10: regulatory comparison is a separate publication responsibility from clinical
    // safety assessment.
    const request = await makeRequest();
    const message = await expectDenied(() =>
      approve(request, LEGAL, { role: 'REGULATORY_LEGAL_REVIEWER' }),
    );
    expect(message).toMatch(/publication_approval_role_not_permitted_for_kind/);
  });

  it('refuses a role the reviewer does not actually hold, even a permitted one', async () => {
    const request = await makeRequest();
    const message = await expectDenied(() =>
      approve(request, CLINICAL_ONE, { role: 'PRODUCT_SAFETY_REVIEWER' }),
    );
    expect(message).toMatch(/publication_approval_role_not_held/);
  });

  it('refuses the requester approving their own publication', async () => {
    await grantRole(AUTHOR, 'CLINICAL_SAFETY_LEAD');
    const request = await makeRequest({ requestedBy: AUTHOR });
    const message = await expectDenied(() => approve(request, AUTHOR));
    expect(message).toMatch(/publication_approval_separation_of_duties/);
  });

  it('lets the requester approve their own withdrawal', async () => {
    // Deliberately asymmetric. Requiring a second person before a live wrong alert can be stopped
    // would make the safe direction the slow one.
    await grantRole(AUTHOR, 'CLINICAL_SAFETY_LEAD');
    const request = await makeRequest({ action: 'WITHDRAW', required: 1 });
    await approve(request, AUTHOR);
    const rows = await t.asService((db) =>
      db.query('SELECT id FROM publication_approval WHERE request_id = $1', [request]),
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('refuses a second decision from the same person', async () => {
    // One person, one vote. Counting rows rather than people is the obvious way to satisfy a
    // two-person rule with one person.
    const request = await makeRequest();
    await approve(request, CLINICAL_ONE);
    const message = await expectDenied(() => approve(request, CLINICAL_ONE));
    expect(message).toMatch(/approval_one_per_reviewer|duplicate key/i);
  });

  it('refuses an approval covering a jurisdiction the request does not', async () => {
    const request = await makeRequest({ jurisdictions: ['GB'] });
    const message = await expectDenied(() =>
      approve(request, CLINICAL_ONE, { jurisdictions: ['GB', 'NI'] }),
    );
    expect(message).toMatch(/publication_approval_scope_exceeds_request/);
  });

  it('refuses a decision on a request that is already closed', async () => {
    const request = await makeRequest();
    await t.asService((db) =>
      db.query(
        `UPDATE publication_request
            SET state = 'REJECTED', decided_at = $1, decided_by_user_id = $2 WHERE id = $3`,
        [LATER, CLINICAL_ONE, request],
      ),
    );
    const message = await expectDenied(() => approve(request, CLINICAL_ONE));
    expect(message).toMatch(/publication_approval_request_not_open/);
  });

  it('keeps an approval unchangeable once recorded', async () => {
    // Spec 13 and 14 both require immutable audit around publication. An editable approval is a
    // record of the current story, not of a decision.
    const request = await makeRequest();
    await approve(request, CLINICAL_ONE);

    // Two independent layers refuse it, and the test asserts both rather than whichever
    // Postgres reports first: the service role holds no UPDATE or DELETE grant, and the
    // append-only trigger refuses even the table owner.
    const noGrant = await expectDenied(() =>
      t.asService((db) =>
        db.query(`UPDATE publication_approval SET decision = 'REJECT' WHERE request_id = $1`, [
          request,
        ]),
      ),
    );
    expect(noGrant).toMatch(/permission denied/i);

    const updated = await expectDenied(() =>
      t.asOwner((db) =>
        db.query(`UPDATE publication_approval SET decision = 'REJECT' WHERE request_id = $1`, [
          request,
        ]),
      ),
    );
    expect(updated).toMatch(/append-only/i);

    const deleted = await expectDenied(() =>
      t.asOwner((db) =>
        db.query('DELETE FROM publication_approval WHERE request_id = $1', [request]),
      ),
    );
    expect(deleted).toMatch(/append-only/i);
  });
});

describe('the execution gate', () => {
  beforeEach(async () => {
    await grantRole(CLINICAL_ONE, 'CLINICAL_SAFETY_LEAD');
    await grantRole(CLINICAL_TWO, 'MEDICATION_SAFETY_REVIEWER');
  });

  it('refuses one approval where two are required', async () => {
    const request = await makeRequest({ required: 2 });
    await approve(request, CLINICAL_ONE);
    const message = await expectDenied(() => execute(request, CLINICAL_TWO));
    expect(message).toMatch(/publication_execution_insufficient_approvals/);
  });

  it('publishes on two distinct approvals', async () => {
    const request = await makeRequest({ required: 2 });
    await approve(request, CLINICAL_ONE);
    await approve(request, CLINICAL_TWO, { role: 'MEDICATION_SAFETY_REVIEWER' });
    await execute(request, CLINICAL_TWO);

    const stored = await t.asService((db) =>
      db.query<{ state: string }>('SELECT state FROM publication_request WHERE id = $1', [request]),
    );
    expect(stored.rows[0]?.state).toBe('EXECUTED');
  });

  it('refuses when one jurisdiction is short and the other is satisfied', async () => {
    // The quiet failure: the count looks met overall, and one of the two scopes was reviewed by
    // nobody. Spec 10 requires Great Britain and Northern Ireland to be reviewed separately.
    const request = await makeRequest({ jurisdictions: ['GB', 'NI'], required: 2 });
    await approve(request, CLINICAL_ONE, { jurisdictions: ['GB', 'NI'] });
    await approve(request, CLINICAL_TWO, {
      role: 'MEDICATION_SAFETY_REVIEWER',
      jurisdictions: ['GB'],
    });
    const message = await expectDenied(() => execute(request, CLINICAL_TWO));
    expect(message).toMatch(/publication_execution_insufficient_approvals \(NI\)/);
  });

  it('refuses after somebody asked for changes, however many approvals follow', async () => {
    const request = await makeRequest({ required: 1 });
    await approve(request, CLINICAL_ONE, { decision: 'RETURN_FOR_CORRECTION' });
    await approve(request, CLINICAL_TWO, { role: 'MEDICATION_SAFETY_REVIEWER' });
    const message = await expectDenied(() => execute(request, CLINICAL_TWO));
    expect(message).toMatch(/publication_execution_outstanding_objection/);
  });

  it('refuses the requester publishing their own request', async () => {
    await grantRole(AUTHOR, 'PRODUCT_SAFETY_REVIEWER');
    const request = await makeRequest({ required: 1, requestedBy: AUTHOR });
    await approve(request, CLINICAL_ONE);
    const message = await expectDenied(() => execute(request, AUTHOR));
    expect(message).toMatch(/publication_execution_separation_of_duties/);
  });

  it('refuses an executor who is not a reviewer', async () => {
    const request = await makeRequest({ required: 1 });
    await approve(request, CLINICAL_ONE);
    const message = await expectDenied(() => execute(request, OUTSIDER));
    expect(message).toMatch(/publication_execution_executor_not_a_reviewer/);
  });

  it('refuses to publish while publication is globally blocked', async () => {
    await t.asService((db) =>
      db.query(
        `UPDATE publication_control
            SET publication_blocked = true, blocked_reason = 'Source parser corruption',
                blocked_by_user_id = $1, blocked_at = $2`,
        [ADMIN, NOW],
      ),
    );
    const request = await makeRequest({ required: 1 });
    await approve(request, CLINICAL_ONE);
    const message = await expectDenied(() => execute(request, CLINICAL_TWO));
    expect(message).toMatch(/publication_execution_globally_blocked/);
  });

  it('still withdraws while publication is blocked', async () => {
    // One of spec 10's emergency controls exists to undo the other. A global block that also
    // stopped withdrawals would leave a wrong alert live with no way to stop it.
    await t.asService((db) =>
      db.query(
        `UPDATE publication_control
            SET publication_blocked = true, blocked_reason = 'Incident in progress',
                blocked_by_user_id = $1, blocked_at = $2`,
        [ADMIN, NOW],
      ),
    );
    const request = await makeRequest({ action: 'WITHDRAW', required: 1 });
    await approve(request, CLINICAL_ONE);
    await execute(request, CLINICAL_ONE);

    const stored = await t.asService((db) =>
      db.query<{ state: string }>('SELECT state FROM publication_request WHERE id = $1', [request]),
    );
    expect(stored.rows[0]?.state).toBe('EXECUTED');
  });

  it('refuses any further write once a request has been decided', async () => {
    const request = await makeRequest({ required: 1 });
    await approve(request, CLINICAL_ONE);
    await execute(request, CLINICAL_TWO);
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `UPDATE publication_request SET state = 'EXECUTED', decided_at = $1,
                  decided_by_user_id = $2 WHERE id = $3`,
          [LATER, CLINICAL_ONE, request],
        ),
      ),
    );
    expect(message).toMatch(/publication_execution_request_not_open/);
  });
});

describe('a request declares what it is', () => {
  it('refuses a publication that declares no impact', async () => {
    const message = await expectDenied(() =>
      makeRequest({ maxUrgency: null, evidenceLevel: null }),
    );
    expect(message).toMatch(/request_publish_declares_impact/);
  });

  it('refuses a withdrawal that does not say why', async () => {
    for (const withdrawalReason of [null, '   ']) {
      const message = await expectDenied(() =>
        makeRequest({ action: 'WITHDRAW', withdrawalReason }),
      );
      expect(message).toMatch(/request_withdrawal_states_reason/);
    }
  });

  it('refuses an unknown or empty scope', async () => {
    const unknown = await expectDenied(() => makeRequest({ jurisdictions: ['UK'] }));
    expect(unknown).toMatch(/request_jurisdictions_known/);

    const empty = await expectDenied(() => makeRequest({ jurisdictions: [] }));
    expect(empty).toMatch(/request_jurisdictions_not_empty/);
  });

  it('refuses an approval count outside one or two', async () => {
    for (const required of [0, 3]) {
      const message = await expectDenied(() => makeRequest({ required }));
      expect(message).toMatch(/request_required_approvals_range/);
    }
  });

  it('refuses two open requests for the same target and action', async () => {
    // Without this, two requests could each collect one approval and the second be executed on a
    // count neither of them reached - the two-person rule defeated by arithmetic.
    const subjectId = nextSubject();
    await makeRequest({ subjectId });
    const message = await expectDenied(() => makeRequest({ subjectId }));
    expect(message).toMatch(/publication_request_open_idx|duplicate key/i);
  });

  it('allows a new request once the previous one is closed', async () => {
    const subjectId = nextSubject();
    const first = await makeRequest({ subjectId });
    await t.asService((db) =>
      db.query(
        `UPDATE publication_request SET state = 'REJECTED', decided_at = $1,
                decided_by_user_id = $2 WHERE id = $3`,
        [LATER, ADMIN, first],
      ),
    );
    await makeRequest({ subjectId });
    const rows = await t.asService((db) =>
      db.query('SELECT id FROM publication_request WHERE subject_id = $1', [subjectId]),
    );
    expect(rows.rows).toHaveLength(2);
  });

  it('requires a decided request to name who decided it', async () => {
    const request = await makeRequest();
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(`UPDATE publication_request SET state = 'REJECTED' WHERE id = $1`, [request]),
      ),
    );
    expect(message).toMatch(/request_decided_is_attributed/);
  });

  it('cannot be deleted', async () => {
    const request = await makeRequest();
    const noGrant = await expectDenied(() =>
      t.asService((db) => db.query('DELETE FROM publication_request WHERE id = $1', [request])),
    );
    expect(noGrant).toMatch(/permission denied/i);

    const trigger = await expectDenied(() =>
      t.asOwner((db) => db.query('DELETE FROM publication_request WHERE id = $1', [request])),
    );
    expect(trigger).toMatch(/append-only/i);
  });
});

describe('the global publication block', () => {
  it('is a single row', async () => {
    // The service role has no INSERT grant here at all - the row is created by the migration -
    // and the primary key refuses a second one even to the table owner.
    const noGrant = await expectDenied(() =>
      t.asService((db) => db.query('INSERT INTO publication_control (singleton) VALUES (true)')),
    );
    expect(noGrant).toMatch(/permission denied/i);

    const duplicate = await expectDenied(() =>
      t.asOwner((db) => db.query('INSERT INTO publication_control (singleton) VALUES (true)')),
    );
    expect(duplicate).toMatch(/publication_control_pkey|duplicate key/i);
  });

  it('refuses a block with no reason or no author', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query('UPDATE publication_control SET publication_blocked = true WHERE singleton'),
      ),
    );
    expect(message).toMatch(/publication_control_block_is_explained/);
  });
});

describe('a published rule carries the scope it was approved for', () => {
  let ruleId = RULE;
  beforeEach(() => {
    ruleId = nextSubject();
  });

  async function rule(overrides: { state?: string; jurisdictions?: string[] } = {}) {
    return t.asService((db) =>
      db.query(
        `INSERT INTO assessment_rule_version
           (id, rule_key, version, rule_kind, evidence_level, max_urgency,
            required_item_verification, required_profile_provenance, explanation_template_id,
            review_state, approved_by_reviewer_id, approved_at, approved_jurisdictions)
         VALUES ($1, 'synthetic.rule', $6, 'EXPIRY', 'A', 'MEDIUM',
                 ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.expiry',
                 $2, $3, $4, $5)`,
        [
          ruleId,
          overrides.state ?? 'PUBLISHED',
          CLINICAL_ONE,
          LATER,
          overrides.jurisdictions ?? ['GB'],
          `1.0.${ruleId.slice(-4)}`,
        ],
      ),
    );
  }

  it('refuses a published rule with no approved scope', async () => {
    // A safety rule has no jurisdiction of its own, so without this it would run everywhere the
    // moment it was published - the opposite of "scoped to the intended jurisdiction".
    const message = await expectDenied(() => rule({ jurisdictions: [] }));
    expect(message).toMatch(/rule_published_has_approved_scope/);
  });

  it('refuses an unknown jurisdiction in the approved scope', async () => {
    const message = await expectDenied(() => rule({ jurisdictions: ['UK'] }));
    expect(message).toMatch(/rule_approved_jurisdictions_known/);
  });

  it('accepts a published rule scoped to the jurisdictions that were reviewed', async () => {
    await rule({ jurisdictions: ['GB', 'NI'] });
    const stored = await t.asService((db) =>
      db.query<{ approved_jurisdictions: string[] }>(
        'SELECT approved_jurisdictions FROM assessment_rule_version WHERE id = $1',
        [ruleId],
      ),
    );
    expect(stored.rows[0]?.approved_jurisdictions).toEqual(['GB', 'NI']);
  });

  it('leaves an unpublished rule unscoped', async () => {
    await rule({ state: 'CANDIDATE', jurisdictions: [] });
    const stored = await t.asService((db) =>
      db.query<{ approved_jurisdictions: string[] }>(
        'SELECT approved_jurisdictions FROM assessment_rule_version WHERE id = $1',
        [ruleId],
      ),
    );
    expect(stored.rows[0]?.approved_jurisdictions).toEqual([]);
  });
});

describe('the reviewer console is not a user surface', () => {
  it('gives the app role no access to any of these tables', async () => {
    // The same treatment audit_event gets in 0001: no grant at all, so there is no row a
    // household member could read even if a route asked for one.
    for (const table of [
      'reviewer',
      'publication_request',
      'publication_approval',
      'publication_control',
    ]) {
      const message = await expectDenied(() =>
        t.asUser(OUTSIDER, (db) => db.query(`SELECT 1 FROM ${table}`)),
      );
      expect(message).toMatch(/permission denied/i);
    }
  });
});

describe("spec 10's publication checklist, at the storage layer", () => {
  beforeEach(async () => {
    await grantRole(CLINICAL_ONE, 'CLINICAL_SAFETY_LEAD');
  });

  it('refuses a high-severity approval that skipped a check', async () => {
    // Spec 10: before high-severity publication the reviewer must verify ten named things. Two
    // people clicking approve is not the same as two people performing the checks.
    const request = await makeRequest({ required: 2 });
    const message = await expectDenied(() =>
      approve(request, CLINICAL_ONE, {
        checklist: FULL_CHECKLIST.filter((i) => i !== 'MEDICATION_BOUNDARY'),
      }),
    );
    expect(message).toMatch(/publication_approval_checklist_incomplete/);
  });

  it('refuses an invented checklist item', async () => {
    const request = await makeRequest({ required: 2 });
    const message = await expectDenied(() =>
      approve(request, CLINICAL_ONE, { checklist: [...FULL_CHECKLIST, 'LOOKS_FINE'] }),
    );
    expect(message).toMatch(/approval_checklist_known/);
  });

  it('does not ask for the checklist on a low-impact publication', async () => {
    const request = await makeRequest({ required: 1, maxUrgency: 'INFORMATIONAL' });
    await approve(request, CLINICAL_ONE, { checklist: [] });
    const rows = await t.asService((db) =>
      db.query('SELECT id FROM publication_approval WHERE request_id = $1', [request]),
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('does not ask for the checklist to withdraw something', async () => {
    // A ten-item form in front of an emergency stop is a reason the emergency stop does not get
    // used.
    const request = await makeRequest({ action: 'WITHDRAW', required: 1 });
    await approve(request, CLINICAL_ONE, { checklist: [] });
    const rows = await t.asService((db) =>
      db.query('SELECT id FROM publication_approval WHERE request_id = $1', [request]),
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('does not ask a reviewer to vouch for content they are rejecting', async () => {
    const request = await makeRequest({ required: 2 });
    await approve(request, CLINICAL_ONE, { decision: 'REJECT', checklist: [] });
    const rows = await t.asService((db) =>
      db.query('SELECT id FROM publication_approval WHERE request_id = $1', [request]),
    );
    expect(rows.rows).toHaveLength(1);
  });
});
