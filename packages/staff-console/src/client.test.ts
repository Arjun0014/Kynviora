import { describe, it, expect } from 'vitest';
import { instantFrom } from '@kynviora/domain';
import {
  UnsafeStaffRequest,
  buildStaffUrl,
  classifyStaffError,
  createStaffApiClient,
  staffPathId,
  staffRequest,
  type FetchLike,
} from './client.js';
import {
  SIGNED_OUT,
  STAFF_IDEMPOTENCY_HEADER,
  STAFF_SESSION_MAX_AGE_MS,
  STAFF_STEP_UP_HEADER,
  STAFF_USER_HEADER,
  beginStaffSession,
  recordStepUp,
  type StaffConsoleConfig,
} from './session.js';

const REVIEWER = '00000000-0000-4000-8000-000000000001';
const REQUEST_ID = '00000000-0000-4000-8000-0000000000aa';
const RUN_ID = '00000000-0000-4000-8000-0000000000bb';
const NOW = instantFrom('2026-09-01T09:00:00.000Z');

const CONFIG: StaffConsoleConfig = { apiBaseUrl: 'http://127.0.0.1:3100', timeoutMs: 1000 };

interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetch that records what it was asked for and answers with a fixed response. */
function recordingFetch(
  status: number,
  body: unknown,
  into: Recorded[],
  headers: Readonly<Record<string, string>> = {},
): FetchLike {
  return (url, init) => {
    into.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
  };
}

function clientFor(fetchImpl: FetchLike, options: { readonly steppedUp?: boolean } = {}) {
  const base = beginStaffSession(REVIEWER, NOW);
  return createStaffApiClient({
    config: CONFIG,
    session: options.steppedUp === true ? recordStepUp(base, NOW) : base,
    now: NOW,
    fetch: fetchImpl,
  });
}

describe('URLs', () => {
  it('refuses a path that does not start with a slash', () => {
    expect(() => buildStaffUrl(CONFIG.apiBaseUrl, 'v1/reviewer/queue')).toThrow(UnsafeStaffRequest);
  });

  it('refuses a query string outright', () => {
    // Stronger than the household rule, which forbids credential-looking names. No staff route
    // takes a query, so there is no exception to carve out - and a rule with no exceptions
    // cannot be applied inconsistently later.
    expect(() => buildStaffUrl(CONFIG.apiBaseUrl, '/v1/reviewer/queue?state=OPEN')).toThrow(
      UnsafeStaffRequest,
    );
  });

  it('refuses a fragment', () => {
    expect(() => buildStaffUrl(CONFIG.apiBaseUrl, '/v1/reviewer/queue#x')).toThrow(
      UnsafeStaffRequest,
    );
  });

  it('refuses a non-UUID in a path segment', () => {
    expect(() => staffPathId('../../etc/passwd')).toThrow(UnsafeStaffRequest);
    expect(() => staffPathId('aa?x=1')).toThrow(UnsafeStaffRequest);
    expect(staffPathId(REQUEST_ID)).toBe(REQUEST_ID);
  });
});

describe('classifying a failure', () => {
  const wire = (code: string) => ({ code, message: 'm', retryable: false, correlationId: 'c' });

  it('maps a step-up refusal to its own state, not to an error', () => {
    expect(classifyStaffError(403, wire('STEP_UP_REQUIRED'))).toEqual({ kind: 'STEP_UP_REQUIRED' });
  });

  it('maps a refused read and a genuine absence to the same state', () => {
    // The API answers PERMISSION_DENIED with 404 so a caller cannot learn a request exists by
    // being refused it. A client that distinguished them would hand that fact back on the screen.
    expect(classifyStaffError(404, wire('PERMISSION_DENIED')).kind).toBe('UNAVAILABLE');
    expect(classifyStaffError(404, wire('NOT_FOUND')).kind).toBe('UNAVAILABLE');
    expect(classifyStaffError(404, null).kind).toBe('UNAVAILABLE');
  });

  it('has no outcome that means "you are not a reviewer"', () => {
    // There must be nowhere for the console to put it, because the API refuses to say it.
    const kinds = [
      classifyStaffError(404, wire('PERMISSION_DENIED')).kind,
      classifyStaffError(401, null).kind,
      classifyStaffError(400, wire('VALIDATION_FAILED')).kind,
      classifyStaffError(500, null).kind,
    ];
    expect(kinds).not.toContain('NOT_A_REVIEWER');
    expect(kinds).not.toContain('FORBIDDEN');
  });

  it('keeps a well-formed refusal so the reviewer can act on it', () => {
    const outcome = classifyStaffError(400, wire('VALIDATION_FAILED'));
    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'VALIDATION_FAILED' });
  });

  it('treats a 4xx with no parseable body as a server problem, not as the user being wrong', () => {
    expect(classifyStaffError(418, null).kind).toBe('SERVER_ERROR');
  });
});

describe('the transport', () => {
  it('sends the identity header and no step-up on a read', async () => {
    const calls: Recorded[] = [];
    const client = clientFor(recordingFetch(200, { items: [], serverTime: NOW }, calls), {
      steppedUp: true,
    });

    const outcome = await client.queue();
    expect(outcome.kind).toBe('OK');
    expect(calls).toHaveLength(1);

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers[STAFF_USER_HEADER]).toBe(REVIEWER);
    expect(headers).not.toHaveProperty(STAFF_STEP_UP_HEADER);
    expect(calls[0]?.url).toBe('http://127.0.0.1:3100/v1/reviewer/queue');
  });

  it('sends step-up on execute and on the publication block, and on nothing else', async () => {
    const calls: Recorded[] = [];
    const client = clientFor(recordingFetch(200, { serverTime: NOW }, calls), { steppedUp: true });

    await client.execute(REQUEST_ID);
    await client.setPublicationBlock(true, 'incident');
    await client.decide(REQUEST_ID, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
      jurisdictions: ['GB'],
      checklist: [],
      note: null,
    });
    await client.operations();

    const stepUpFlags = calls.map(
      (call) => (call.init?.headers as Record<string, string>)[STAFF_STEP_UP_HEADER] ?? null,
    );
    // Recording an opinion does not need step-up. Requiring it would train reviewers to keep one
    // warm, which is the control worn down by use.
    expect(stepUpFlags).toEqual(['1', '1', null, null]);
  });

  it('reports STEP_UP_REQUIRED without sending anything when the step-up is stale', async () => {
    const calls: Recorded[] = [];
    const client = clientFor(recordingFetch(200, {}, calls));

    const outcome = await client.execute(REQUEST_ID);
    expect(outcome.kind).toBe('STEP_UP_REQUIRED');
    // The console declines to send a claim it already knows is false, so the reviewer is told to
    // re-confirm rather than shown a refusal.
    expect(calls).toHaveLength(0);
  });

  it('reports an expired session without sending anything, and says which expiry', async () => {
    const calls: Recorded[] = [];
    const outcome = await staffRequest(
      {
        config: CONFIG,
        session: beginStaffSession(REVIEWER, NOW),
        now: instantFrom(new Date(Date.parse(NOW) + STAFF_SESSION_MAX_AGE_MS).toISOString()),
        fetch: recordingFetch(200, {}, calls),
      },
      { method: 'GET', path: '/v1/reviewer/queue' },
    );

    expect(outcome).toEqual({ kind: 'UNAUTHENTICATED', expiry: 'EXPIRED_MAX_AGE' });
    expect(calls).toHaveLength(0);
  });

  it('reports a signed-out session without sending anything', async () => {
    const calls: Recorded[] = [];
    const outcome = await staffRequest(
      { config: CONFIG, session: SIGNED_OUT, now: NOW, fetch: recordingFetch(200, {}, calls) },
      { method: 'GET', path: '/v1/reviewer/queue' },
    );
    expect(outcome.kind).toBe('UNAUTHENTICATED');
    expect(calls).toHaveLength(0);
  });

  it('turns a network failure into an outcome rather than an exception', async () => {
    const client = clientFor(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(client.queue()).resolves.toEqual({ kind: 'OFFLINE' });
  });

  it('turns an unparseable success body into a server error rather than into OK', async () => {
    const client = clientFor(() =>
      Promise.resolve(new Response('<html>not json</html>', { status: 500 })),
    );
    const outcome = await client.queue();
    expect(outcome.kind).toBe('SERVER_ERROR');
  });

  it('carries the correlation ID back for an operator to quote', async () => {
    const calls: Recorded[] = [];
    const client = clientFor(
      recordingFetch(200, { items: [], serverTime: NOW }, calls, { 'x-correlation-id': 'abc' }),
    );
    const outcome = await client.queue();
    expect(outcome.kind === 'OK' ? outcome.correlationId : null).toBe('abc');
  });

  it('refuses an idempotency key that is not a UUID', async () => {
    await expect(
      staffRequest(
        {
          config: CONFIG,
          session: beginStaffSession(REVIEWER, NOW),
          now: NOW,
          fetch: recordingFetch(200, {}, []),
        },
        { method: 'POST', path: '/v1/reviewer/requests', body: {}, idempotencyKey: 'nope' },
      ),
    ).rejects.toThrow(UnsafeStaffRequest);
  });

  it('sends an idempotency key when one is given', async () => {
    const calls: Recorded[] = [];
    await staffRequest(
      {
        config: CONFIG,
        session: beginStaffSession(REVIEWER, NOW),
        now: NOW,
        fetch: recordingFetch(200, {}, calls),
      },
      { method: 'POST', path: '/v1/reviewer/requests', body: {}, idempotencyKey: RUN_ID },
    );
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers[STAFF_IDEMPOTENCY_HEADER]).toBe(RUN_ID);
  });
});

describe('the routes the client can reach', () => {
  it('builds the paths the staff API actually serves', async () => {
    const calls: Recorded[] = [];
    const client = clientFor(recordingFetch(200, {}, calls), { steppedUp: true });

    await client.queue();
    await client.request(REQUEST_ID);
    await client.shadowRun(RUN_ID);
    await client.decide(REQUEST_ID, {
      decision: 'APPROVE',
      role: 'CLINICAL_SAFETY_LEAD',
      jurisdictions: ['GB'],
      checklist: [],
      note: null,
    });
    await client.execute(REQUEST_ID);
    await client.setPublicationBlock(false, null);
    await client.operations();

    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:3100/v1/reviewer/queue',
      `http://127.0.0.1:3100/v1/reviewer/requests/${REQUEST_ID}`,
      `http://127.0.0.1:3100/v1/reviewer/shadow-runs/${RUN_ID}`,
      `http://127.0.0.1:3100/v1/reviewer/requests/${REQUEST_ID}/decisions`,
      `http://127.0.0.1:3100/v1/reviewer/requests/${REQUEST_ID}/execute`,
      'http://127.0.0.1:3100/v1/reviewer/publication-block',
      'http://127.0.0.1:3100/v1/reviewer/operations',
    ]);

    // Every path is under the staff prefix. The console has no route to a household one, so a
    // misconfigured base URL cannot make it read somebody's shelf.
    for (const call of calls) {
      expect(new URL(call.url).pathname.startsWith('/v1/reviewer/')).toBe(true);
    }
  });

  it('offers no way to open a publication request', () => {
    // Authoring and reviewing are the two halves of a separation-of-duties rule, and this console
    // is the reviewer's half. A create method here would put both behind one set of controls.
    const client = clientFor(recordingFetch(200, {}, []));
    expect(Object.keys(client).sort()).toEqual([
      'decide',
      'execute',
      'operations',
      'queue',
      'request',
      'setPublicationBlock',
      'shadowRun',
    ]);
  });
});
