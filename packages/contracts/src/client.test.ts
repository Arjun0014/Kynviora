import { describe, it, expect } from 'vitest';
import { createClient, type KynvioraClient } from './client.js';
import { ANONYMOUS, DEV_USER_HEADER, developmentSession, type ApiConfig } from './config.js';
import type { FetchLike } from './http.js';

const CONFIG: ApiConfig = { baseUrl: 'http://127.0.0.1:3000', timeoutMs: 100 };
const USER = '00000000-0000-4000-8000-00000000d001';
const PROFILE = '00000000-0000-4000-8000-00000000d020';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function recordingClient(
  status = 200,
  body: unknown = {},
): { client: KynvioraClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchLike: FetchLike = (url, init) => {
    calls.push({
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : null,
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return {
    client: createClient({ config: CONFIG, session: developmentSession(USER), fetch: fetchLike }),
    calls,
  };
}

describe('what the client asks for', () => {
  it('sends no profile ID on the shelf listing beyond the filter', async () => {
    const { client, calls } = recordingClient(200, { items: [], nextCursor: null });
    await client.listItems({ profileId: PROFILE, itemKind: 'MEDICINE' });
    // The profile ID narrows the result set; it does not grant access. `13`: never trust a
    // profile ID in the request as proof of access - which is why the server applies RLS and a
    // profile the caller cannot see comes back as an empty page.
    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:3000/v1/items?profileId=${PROFILE}&itemKind=MEDICINE`,
    );
  });

  it('asks for alerts with no profile at all', async () => {
    // The route returns exactly what row-level security admits. Adding a profile parameter here
    // would invite a reader to think it was doing the filtering.
    const { client, calls } = recordingClient(200, { alerts: [] });
    await client.listAlerts();
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/v1/alerts');
  });

  it('escapes an identifier into a path', async () => {
    const { client, calls } = recordingClient(200, {});
    await client.reconciliation('a/../b');
    expect(calls[0]?.url).not.toContain('/../');
  });

  it('carries the identity on every call', async () => {
    const { client, calls } = recordingClient(200, { profiles: [] });
    await client.listProfiles();
    await client.reviewTasks(PROFILE);
    for (const call of calls) expect(call.headers[DEV_USER_HEADER]).toBe(USER);
  });

  it('requires the caller to supply the idempotency key for a dose event', async () => {
    const { client, calls } = recordingClient(201, { id: 'x' });
    await client.recordDoseEvent({ ownedItemId: 'i', eventKind: 'TAKEN' }, 'op-1');
    expect(calls[0]?.headers['idempotency-key']).toBe('op-1');
  });

  it('switches identity without rebuilding the configuration', () => {
    const { client } = recordingClient(200, { profiles: [] });
    const anonymous = client.withSession(ANONYMOUS);
    expect(anonymous.session).toEqual(ANONYMOUS);
    expect(client.session.kind).toBe('DEVELOPMENT');
  });
});

describe('what the client cannot do', () => {
  const client = createClient({ config: CONFIG, session: ANONYMOUS });
  const methods = Object.keys(client);

  it('has no method that evaluates a safety rule', () => {
    // DEC-010 puts the rule engine server-side and says the mobile client must never gain a
    // rule-evaluation code path. A client that could compute an assessment would be a second
    // source of truth on a phone, updated whenever the app store says so rather than whenever a
    // reviewer approves something.
    for (const name of methods) {
      expect(name.toLowerCase()).not.toMatch(/evaluate|assess|matchrule|runrule|computerisk/);
    }
  });

  it('has no method producing a score, a severity or a ranking', () => {
    // `23` D-005 forbids collapsing evidence level and urgency into one number, and there is no
    // aggregate Trust Passport score anywhere in the product.
    for (const name of methods) {
      expect(name.toLowerCase()).not.toMatch(/score|severity|rank|rating|grade/);
    }
  });

  it('has no method for publishing anything', () => {
    // Publication is the reviewer console's, on its own origin and session policy (`14`,
    // DEV-016). It is deliberately not reachable from the app's client at all.
    for (const name of methods) {
      expect(name.toLowerCase()).not.toMatch(/publish|approve|withdraw|reviewerqueue|shadowrun/);
    }
  });

  it('exposes no reviewer console route', async () => {
    const { client, calls } = recordingClient(404, { error: { code: 'NOT_FOUND', message: 'x' } });
    await client.listProfiles();
    expect(calls.every((call) => !call.url.includes('/reviewer/'))).toBe(true);
  });
});

describe('the reconciliation surface never names a right answer', () => {
  it('sends only what a person stated', async () => {
    // DEC-030: which value stands is stated by a person, never inferred from recency. The client
    // has no way to express "the newer one" because it is not the client's to decide.
    const { client, calls } = recordingClient(200, {});
    await client.resolveDifference('r1', 'd1', {
      resolution: 'CONFIRMED_BY_PROFESSIONAL',
      adopt: 'PREVIOUS',
      confirmedBy: 'Pharmacist',
    });

    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      resolution: 'CONFIRMED_BY_PROFESSIONAL',
      adopt: 'PREVIOUS',
      confirmedBy: 'Pharmacist',
    });
    // Trap 19: no suggested value, no preference, no confidence, no score.
    for (const forbidden of ['suggestedValue', 'preferred', 'confidence', 'score', 'recommended']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('lets a professional confirmation take either side', async () => {
    // A pharmacist may confirm the older dose. If the client could only ever adopt the current
    // list, the screen would be making the judgement `04` Phase 8.5 forbids.
    const { client, calls } = recordingClient(200, {});
    await client.resolveDifference('r1', 'd1', {
      resolution: 'CONFIRMED_BY_PROFESSIONAL',
      adopt: 'CURRENT',
    });
    await client.resolveDifference('r1', 'd2', {
      resolution: 'CONFIRMED_BY_PROFESSIONAL',
      adopt: 'PREVIOUS',
    });
    const sides = calls.map((call) => (JSON.parse(call.body ?? '{}') as { adopt?: string }).adopt);
    expect(sides).toEqual(['CURRENT', 'PREVIOUS']);
  });
});

describe('completing a review task writes to the record', () => {
  it('sends the field changes, because there is no mark-done path', async () => {
    // DEC-027 and trap 16: a task is closed by writing to the authoritative record. The client
    // has no method that closes one without changes to send.
    const { client, calls } = recordingClient(200, {});
    await client.completeReviewTask('t1', {
      outcome: 'UPDATED',
      changes: [
        { recordKind: 'OWNED_ITEM', recordId: 'i1', field: 'directions_text', value: 'One daily' },
      ],
    });
    const body = JSON.parse(calls[0]?.body ?? '{}') as { changes?: unknown[] };
    expect(body.changes).toHaveLength(1);
  });
});

describe('removing access', () => {
  it('sends no idempotency key, because a repeat is the same request', async () => {
    // The difference from creating an invitation. Creation mints a credential and a key
    // regenerated on retry would mint a second; revocation has one destination state, and
    // arriving at it twice is arriving at it once.
    const { client, calls } = recordingClient(200, {
      status: 'REVOKED',
      alreadyRevoked: false,
      serverTime: '2026-09-01T00:00:00.000Z',
    });
    await client.revokeGrant('grant-1');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/v1/caregiver-grants/grant-1/revoke');
    expect(Object.keys(calls[0]?.headers ?? {})).not.toContain('Idempotency-Key');
  });

  it('uses a different route for an invitation than for a grant', async () => {
    // Two records. The wrong route is a 404, which the client renders as absence - so the bug
    // would look like the row disappearing rather than like a bug.
    const { client, calls } = recordingClient(200, {
      status: 'REVOKED',
      serverTime: '2026-09-01T00:00:00.000Z',
    });
    await client.revokeInvitation('inv-1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/v1/caregiver-invitations/inv-1/revoke');
  });

  it('escapes an identifier rather than pasting it into the path', async () => {
    const { client, calls } = recordingClient(200, { status: 'REVOKED' });
    await client.revokeGrant('a/../b');
    expect(calls[0]?.url).toContain('a%2F..%2Fb');
  });

  it('reports an already-removed grant as done rather than as a failure', async () => {
    // Someone removing another person's access who is answered with an error has been given a
    // reason to doubt whether it worked.
    const { client } = recordingClient(200, {
      status: 'REVOKED',
      alreadyRevoked: true,
      serverTime: '2026-09-01T00:00:00.000Z',
    });
    const outcome = await client.revokeGrant('grant-1');
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.value.alreadyRevoked).toBe(true);
  });

  it('turns a missing grant into absence, never into a refusal', async () => {
    // Trap 14 and DEC-039: PERMISSION_DENIED is answered with 404 so the API is not an existence
    // oracle, and there is no client outcome meaning "you are not allowed".
    const { client } = recordingClient(404, {
      error: {
        code: 'PERMISSION_DENIED',
        message: 'No such grant.',
        retryable: false,
        correlationId: 'c',
      },
    });
    const outcome = await client.revokeGrant('grant-1');
    expect(outcome.kind).toBe('UNAVAILABLE');
  });

  it('surfaces the step-up requirement as its own outcome', async () => {
    // 403 belongs to STEP_UP_REQUIRED alone (trap 14), and the screen has a state for it.
    const { client } = recordingClient(403, {
      error: {
        code: 'STEP_UP_REQUIRED',
        message: 'Confirm it is you.',
        retryable: false,
        correlationId: 'c',
      },
    });
    expect((await client.revokeGrant('grant-1')).kind).toBe('STEP_UP_REQUIRED');
  });

  it('keeps the accepted-invitation refusal actionable', async () => {
    // The access has moved into a grant. The server says so with a message the screen shows,
    // because "not found" here would be wrong: the record exists and the owner can act on it.
    const { client } = recordingClient(409, {
      error: {
        code: 'INVITATION_ALREADY_RESOLVED',
        message: 'This invitation was accepted. Revoke the caregiver access instead.',
        detail: { reason_code: 'already_accepted' },
        retryable: false,
        correlationId: 'c',
      },
    });
    const outcome = await client.revokeInvitation('inv-1');
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind !== 'REFUSED') return;
    expect(outcome.code).toBe('INVITATION_ALREADY_RESOLVED');
  });

  it('reads the access history without asking for a body of health content', async () => {
    // `20`: an audit log answers who did what, and must not become a verbose copy of health
    // content. The route is a plain GET on the profile.
    const { client, calls } = recordingClient(200, { events: [], serverTime: 't' });
    await client.caregiverAudit(PROFILE);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`http://127.0.0.1:3000/v1/profiles/${PROFILE}/caregiver-audit`);
  });
});
