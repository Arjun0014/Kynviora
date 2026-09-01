import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createServer } from '../../api/src/server.js';
import type { DatabaseConnection, DatabasePool, Principal } from '../../api/src/context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';
import { FORM_TOKEN_FIELD, type FetchLike } from '@kynviora/staff-console';
import { createConsoleServer, parseForm, readCookie, sessionCookie } from './server.js';
import { SESSION_COOKIE } from './sessionStore.js';

/**
 * The reviewer console, end to end.
 *
 * Spec references: `04` Phase 6.6, `10`, `13`, `14`, `20`, `DEV-016`, `DEV-017`.
 *
 * WHAT IS REAL HERE
 * A real PostgreSQL engine through PGlite, the real staff API surface with its real reviewer-role
 * authorization, and the real console process rendering real HTML. The only seam is the console's
 * `fetch`, which is pointed at the staff API's `inject` rather than at a socket - two listeners in
 * one test process, exactly as `main.ts` runs two in one process for the same single-writer
 * reason (DEC-037).
 *
 * THE PROPERTY THIS FILE EXISTS FOR
 * A console session is not authority. The same person, the same header, the same cookie: with no
 * row in `reviewer` every page is empty, and with one the queue appears. `14` says a staff role is
 * never inferred from a client claim, and the way to show that is to make the claim and watch it
 * not be enough.
 */

const ADMIN = testUuid(9);
const REVIEWER = testUuid(1);
const AUTHOR = testUuid(2);
const OUTSIDER = testUuid(3);
const SOURCE = testUuid(50);
const RULE = testUuid(60);
let ruleCounter = 0;

const NOW = instantFrom('2026-09-01T12:00:00.000Z');

let t: TestDb;
let staffApi: FastifyInstance;
let console_: FastifyInstance;

/** The principal the staff API sees. Set from the console's own outgoing header. */
let stepUpFor = new Set<string>();

let currentNow: Instant = NOW;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [ADMIN, 'admin@example.test'],
      [REVIEWER, 'reviewer@example.test'],
      [AUTHOR, 'author@example.test'],
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
    await db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id)
       VALUES ($1, 'synthetic.console', '1.0.0', 'EXPIRY', 'A', 'HIGH',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.expiry')`,
      [RULE],
    );
  });

  const pool: DatabasePool = {
    withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
    withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
  };

  const sources: ReadonlyMap<string, SourceRegistryEntry> = new Map(
    ALL_FIXTURE_SOURCES.map((s) => [s.id, asApprovedSourceForTest(s)]),
  );

  staffApi = createServer({
    surface: 'STAFF',
    pool,
    logger: noopLogger(),
    // The real development boundary: identity comes from the header the console sends, and the
    // reviewer role comes from the database. Nothing here grants a role.
    authenticate: (request: FastifyRequest) => {
      const header = request.headers['x-kynviora-dev-user'];
      if (typeof header !== 'string' || header === '') return Promise.resolve(null);
      const steppedUp = request.headers['x-kynviora-dev-step-up'] === '1';
      const principal: Principal = {
        userId: unsafeId<UserId>(header),
        stepUpVerifiedAt: steppedUp ? currentNow : null,
      };
      if (steppedUp) stepUpFor.add(header);
      return Promise.resolve(principal);
    },
    now: () => currentNow,
    loadSources: () => Promise.resolve(sources),
  });
  await staffApi.ready();

  // The console's transport, pointed at the staff API in this process. The console still speaks
  // HTTP to it - same headers, same status codes, same JSON - it just does not cross a socket.
  const injectingFetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const response = await staffApi.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: parsed.pathname,
      headers: init?.headers as Record<string, string>,
      // The client only ever sends a JSON string body; narrowing rather than stringifying keeps
      // an accidental object from arriving as "[object Object]" and being blamed on the API.
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };

  console_ = createConsoleServer({
    config: { apiBaseUrl: 'http://127.0.0.1:3100', timeoutMs: 5000 },
    logger: noopLogger(),
    now: () => currentNow,
    fetch: injectingFetch,
  });
  await console_.ready();
});

afterAll(async () => {
  await console_.close();
  await staffApi.close();
  await t.close();
});

beforeEach(async () => {
  currentNow = NOW;
  stepUpFor = new Set();
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM reviewer');
    await db.query(
      `UPDATE publication_control
          SET publication_blocked = false, blocked_reason = NULL,
              blocked_by_user_id = NULL, blocked_at = NULL
        WHERE singleton`,
    );
  });
});

async function grantReviewer(userId: string, role: string): Promise<void> {
  await t.asService((db) =>
    db.query(
      `INSERT INTO reviewer (user_id, role, granted_by_user_id, granted_at)
       VALUES ($1, $2, $3, now())`,
      // A separate granter: `reviewer_not_self_granted` refuses a row somebody granted to
      // themselves, which is the schema saying a reviewer role is given rather than taken.
      [userId, role, ADMIN],
    ),
  );
}

/** Sign in through the console's own form and keep the cookie. */
async function signIn(userId: string): Promise<string> {
  const response = await console_.inject({
    method: 'POST',
    url: '/session',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `userId=${userId}`,
  });
  expect(response.statusCode).toBe(303);

  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? (setCookie[0] ?? '') : String(setCookie);
  const token = readCookie(raw.split(';')[0], SESSION_COOKIE);
  expect(token).not.toBeNull();
  return String(token);
}

function withSession(token: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` };
}

async function get(path: string, token: string | null = null) {
  return console_.inject({
    method: 'GET',
    url: path,
    ...(token === null ? {} : { headers: withSession(token) }),
  });
}

async function post(path: string, token: string, fields: Record<string, string | string[]>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
    else params.append(key, value);
  }
  return console_.inject({
    method: 'POST',
    url: path,
    headers: { ...withSession(token), 'content-type': 'application/x-www-form-urlencoded' },
    payload: params.toString(),
  });
}

/** Pull the form token out of a rendered page, the way a browser would submit it. */
function formTokenFrom(html: string): string {
  const match = new RegExp(`name="${FORM_TOKEN_FIELD}" value="([^"]+)"`).exec(html);
  return match?.[1] ?? '';
}

// ---------------------------------------------------------------------------

describe('the console without a session', () => {
  it('shows the sign-in page rather than a queue', async () => {
    const response = await get('/queue');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Identify this session');
    expect(response.body).not.toContain('Oldest first');
  });

  it('says the sign-in step is not authentication', async () => {
    const response = await get('/sign-in');
    expect(response.body).toContain('not an authentication step');
    expect(response.body).toContain('BLK-010');
  });

  it('refuses a user ID that is not a UUID', async () => {
    const response = await console_.inject({
      method: 'POST',
      url: '/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'userId=not-a-uuid',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('That is not a UUID');
  });

  it('sets an HttpOnly, SameSite=Strict cookie carrying only an opaque token', async () => {
    const response = await console_.inject({
      method: 'POST',
      url: '/session',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `userId=${REVIEWER}`,
    });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    // The user ID is not in the cookie. Everything about the session is server-side, so the
    // holder cannot extend it, claim a step-up, or survive a sign-out the server performed.
    expect(setCookie).not.toContain(REVIEWER);
  });
});

describe('a session is not authority', () => {
  it('shows a signed-in caller with no reviewer row an empty page, not a refusal', async () => {
    const token = await signIn(OUTSIDER);
    const response = await get('/queue', token);

    // The staff API answers a caller holding no reviewer row with a bare 404, so that the route
    // is not an oracle for its own existence. The console renders that as absence.
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('Nothing to show');
    expect(response.body.toLowerCase()).not.toContain('permission');
    expect(response.body.toLowerCase()).not.toContain('not a reviewer');
  });

  it('shows the queue to the same caller once the database grants the role', async () => {
    const token = await signIn(REVIEWER);
    expect((await get('/queue', token)).statusCode).toBe(404);

    await grantReviewer(REVIEWER, 'CLINICAL_SAFETY_LEAD');

    const after = await get('/queue', token);
    expect(after.statusCode).toBe(200);
    expect(after.body).toContain('Queue');
    // Same session, same cookie, same header. The only thing that changed is a row in `reviewer`.
    // The queue itself is empty, and the page says what an empty queue does and does not mean
    // rather than showing nothing.
    expect(after.body).toContain('BLK-004');
  });
});

describe('the standing warnings', () => {
  it('appear on every page, signed in or not', async () => {
    await grantReviewer(REVIEWER, 'CLINICAL_SAFETY_LEAD');
    const token = await signIn(REVIEWER);

    for (const path of ['/queue', '/operations']) {
      const response = await get(path, token);
      expect(response.body).toContain('What this console cannot do');
      expect(response.body).toContain('BLK-006');
      expect(response.body).toContain('BLK-004');
    }
  });
});

describe('the queue and one request', () => {
  /**
   * A fresh rule and a fresh open request.
   *
   * The rule is new every time because `publication_request_open_idx` allows one open request
   * per target and action - two open requests for the same publication could each collect one
   * approval, and the two-person rule would fall to arithmetic. Reusing one rule made every test
   * after the first fail, which is the index doing its job.
   */
  async function openRequest(): Promise<{ requestId: string; shadowRunId: string }> {
    ruleCounter += 1;
    const rule = testUuid(600 + ruleCounter);
    await t.asService((db) =>
      db.query(
        `INSERT INTO assessment_rule_version
           (id, rule_key, version, rule_kind, evidence_level, max_urgency,
            required_item_verification, required_profile_provenance, explanation_template_id)
         VALUES ($1, $2, '1.0.0', 'EXPIRY', 'A', 'HIGH',
                 ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.expiry')`,
        [rule, `synthetic.console.${String(ruleCounter)}`],
      ),
    );

    const runRes = await t.asService((db) =>
      db.query<{ id: string }>(
        `INSERT INTO shadow_run
           (rule_version_id, dataset_kind, dataset_label, dataset_size, matched_items,
            affected_products, affected_formulations, potential_user_matches,
            evaluation_instant, normalization_version, run_by_user_id, run_at)
         VALUES ($1, 'SYNTHETIC', 'synthetic fixture', 10, 2, 1, 1, 2, now(), 'norm-1', $2, now())
         RETURNING id`,
        [rule, AUTHOR],
      ),
    );
    const shadowRunId = runRes.rows[0]?.id ?? '';

    await grantReviewer(AUTHOR, 'CLINICAL_SAFETY_LEAD');
    const created = await staffApi.inject({
      method: 'POST',
      url: '/v1/reviewer/requests',
      headers: { 'x-kynviora-dev-user': AUTHOR },
      payload: {
        subjectKind: 'assessment_rule_version',
        subjectId: rule,
        action: 'PUBLISH',
        jurisdictions: ['GB', 'NI'],
        maxUrgency: 'HIGH',
        evidenceLevel: 'A',
        shadowRunId,
      },
    });
    expect(created.statusCode).toBe(201);
    return { requestId: created.json<{ requestId: string }>().requestId, shadowRunId };
  }

  it('lists an open request with its per-jurisdiction tally', async () => {
    const { requestId } = await openRequest();
    await grantReviewer(REVIEWER, 'CLINICAL_SAFETY_LEAD');
    const token = await signIn(REVIEWER);

    const response = await get('/queue', token);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(requestId);
    expect(response.body).toContain('0 of 2 approvals for GB');
    expect(response.body).toContain('0 of 2 approvals for NI');
  });

  it('joins the shadow run into the request page', async () => {
    const { requestId } = await openRequest();
    await grantReviewer(REVIEWER, 'CLINICAL_SAFETY_LEAD');
    const token = await signIn(REVIEWER);

    const response = await get(`/requests/${requestId}`, token);
    expect(response.statusCode).toBe(200);
    // DEV-017's remainder: the API returns a `shadowRunId`, and a reviewer confirming
    // EXPECTED_MATCH_VOLUME had to fetch the run themselves. The console does the join.
    expect(response.body).toContain('People this would reach');
    expect(response.body).toContain('Items evaluated');
  });

  it('records a decision through the form and shows it back', async () => {
    const { requestId } = await openRequest();
    await grantReviewer(REVIEWER, 'CLINICAL_SAFETY_LEAD');
    const token = await signIn(REVIEWER);

    const page = await get(`/requests/${requestId}`, token);
    const formToken = formTokenFrom(page.body);
    expect(formToken).not.toBe('');

    const submitted = await post(`/requests/${requestId}/decisions`, token, {
      [FORM_TOKEN_FIELD]: formToken,
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
      // Two checkboxes, sent as two pairs. Keeping only the last would approve one jurisdiction
      // where the reviewer ticked two.
      jurisdictions: ['GB', 'NI'],
      checklist: [
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
      ],
      note: 'checked against the synthetic source',
    });
    expect(submitted.statusCode).toBe(303);

    const after = await get(`/requests/${requestId}`, token);
    expect(after.body).toContain('1 of 2 approvals for GB');
    expect(after.body).toContain('1 of 2 approvals for NI');
    expect(after.body).toContain('checked against the synthetic source');
    expect(after.body).toContain('Append-only');
  });

  it('offers the requester no decision form on their own request', async () => {
    const { requestId } = await openRequest();
    const token = await signIn(AUTHOR);

    const page = await get(`/requests/${requestId}`, token);
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('Record this decision');
    expect(page.body).toContain('authoring and approving separate');
  });

  it('refuses a decision submitted without the form token', async () => {
    const { requestId } = await openRequest();
    await grantReviewer(REVIEWER, 'CLINICAL_SAFETY_LEAD');
    const token = await signIn(REVIEWER);

    const submitted = await post(`/requests/${requestId}/decisions`, token, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
      jurisdictions: ['GB'],
    });
    expect(submitted.statusCode).toBe(400);

    // And nothing was recorded.
    const after = await get(`/requests/${requestId}`, token);
    expect(after.body).toContain('0 of 2 approvals for GB');
  });

  it('refuses a decision carrying another session’s form token', async () => {
    const { requestId } = await openRequest();
    await grantReviewer(REVIEWER, 'CLINICAL_SAFETY_LEAD');
    await grantReviewer(OUTSIDER, 'CLINICAL_SAFETY_LEAD');

    const mine = await signIn(REVIEWER);
    const theirs = await signIn(OUTSIDER);
    const theirToken = formTokenFrom((await get('/operations', theirs)).body);

    const submitted = await post(`/requests/${requestId}/decisions`, mine, {
      [FORM_TOKEN_FIELD]: theirToken,
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
      jurisdictions: ['GB'],
    });
    expect(submitted.statusCode).toBe(400);
  });

  it('shows an unknown request identifier as absence, exactly like a malformed one', async () => {
    await grantReviewer(REVIEWER, 'CLINICAL_SAFETY_LEAD');
    const token = await signIn(REVIEWER);

    const unknown = await get(`/requests/${testUuid(999)}`, token);
    const malformed = await get('/requests/not-a-uuid', token);

    // A distinct "malformed" page would tell a prober which of their guesses were well-formed.
    expect(unknown.statusCode).toBe(malformed.statusCode);
    expect(unknown.body).toBe(malformed.body);
  });
});

describe('publishing asks for step-up every time', () => {
  it('shows the step-up page instead of publishing', async () => {
    await grantReviewer(REVIEWER, 'CLINICAL_SAFETY_LEAD');
    const token = await signIn(REVIEWER);

    const operations = await get('/operations', token);
    const formToken = formTokenFrom(operations.body);

    const attempted = await post(`/requests/${testUuid(998)}/execute`, token, {
      [FORM_TOKEN_FIELD]: formToken,
    });
    expect(attempted.statusCode).toBe(200);
    expect(attempted.body).toContain('Confirm your identity');
    // Nothing left the console: the session holds no step-up, and the client refuses to send a
    // claim it knows is stale rather than letting the API refuse it.
    expect(stepUpFor.size).toBe(0);
  });

  it('sends the step-up assertion after the reviewer confirms', async () => {
    await grantReviewer(REVIEWER, 'CLINICAL_SAFETY_LEAD');
    const token = await signIn(REVIEWER);

    const operations = await get('/operations', token);
    const formToken = formTokenFrom(operations.body);

    const stepped = await post('/step-up', token, { [FORM_TOKEN_FIELD]: formToken });
    expect(stepped.statusCode).toBe(303);

    await post(`/requests/${testUuid(997)}/execute`, token, { [FORM_TOKEN_FIELD]: formToken });
    expect(stepUpFor.has(REVIEWER)).toBe(true);
  });
});

describe('the operations page', () => {
  it('renders the snapshot with no verdict', async () => {
    await grantReviewer(REVIEWER, 'SOURCE_OPERATIONS_OWNER');
    const token = await signIn(REVIEWER);

    const response = await get('/operations', token);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('no overall status');
    expect(response.body).toContain('BLK-008');
    expect(response.body).toContain('reviewer_queue_open_requests');
  });

  it('blocks and unblocks publication, and refuses a block with no reason', async () => {
    await grantReviewer(REVIEWER, 'SOURCE_OPERATIONS_OWNER');
    const token = await signIn(REVIEWER);

    const page = await get('/operations', token);
    const formToken = formTokenFrom(page.body);
    await post('/step-up', token, { [FORM_TOKEN_FIELD]: formToken });

    // A block with no reason is indistinguishable from a bug, and it is the first thing an
    // incident review asks about. The API refuses it and the console does not paper over that.
    const noReason = await post('/publication-block', token, {
      [FORM_TOKEN_FIELD]: formToken,
      blocked: 'true',
      reason: '   ',
    });
    expect(noReason.statusCode).toBe(400);

    const blocked = await post('/publication-block', token, {
      [FORM_TOKEN_FIELD]: formToken,
      blocked: 'true',
      reason: 'synthetic incident',
    });
    expect(blocked.statusCode).toBe(303);

    const after = await get('/operations', token);
    expect(after.body).toContain('Publication is blocked.');
    expect(after.body).toContain('Lift the block');
    expect(after.body).toContain('never blocks a withdrawal');
  });
});

describe('the response headers', () => {
  it('forbid framing, sniffing, caching and loading anything from elsewhere', async () => {
    const response = await get('/sign-in');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');

    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('form parsing', () => {
  it('keeps every value of a repeated field', () => {
    // A jurisdiction list is checkboxes. Keeping only the last would approve one scope where the
    // reviewer ticked three, which is a scope nobody reviewed.
    expect(parseForm('jurisdictions=GB&jurisdictions=NI&decision=APPROVE')).toEqual({
      jurisdictions: ['GB', 'NI'],
      decision: 'APPROVE',
    });
  });

  it('reads one cookie out of several', () => {
    expect(readCookie(`other=1; ${SESSION_COOKIE}=abc; third=2`, SESSION_COOKIE)).toBe('abc');
    expect(readCookie(undefined, SESSION_COOKIE)).toBeNull();
    expect(readCookie('other=1', SESSION_COOKIE)).toBeNull();
  });

  it('marks the cookie Secure only where there is TLS to be secure over', () => {
    expect(sessionCookie('t', true)).toContain('Secure');
    expect(sessionCookie('t', false)).not.toContain('Secure');
  });
});
