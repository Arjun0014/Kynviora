import { describe, it, expect } from 'vitest';
import { UnsafeRequest, buildUrl, request, type FetchLike } from './http.js';
import { ANONYMOUS, DEV_USER_HEADER, developmentSession, type ApiConfig } from './config.js';

const CONFIG: ApiConfig = { baseUrl: 'http://127.0.0.1:3000', timeoutMs: 50 };
const USER = '00000000-0000-4000-8000-00000000d001';

interface Captured {
  url: string;
  init: RequestInit;
}

/** A fetch that records what it was asked for and answers with a fixed response. */
function stubFetch(
  response: { status: number; body?: unknown; headers?: Record<string, string> },
  captured: Captured[] = [],
): { fetch: FetchLike; captured: Captured[] } {
  const fetchLike: FetchLike = (url, init) => {
    captured.push({ url, init });
    return Promise.resolve(
      new Response(response.body === undefined ? '' : JSON.stringify(response.body), {
        status: response.status,
        headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
      }),
    );
  };
  return { fetch: fetchLike, captured };
}

describe('no sensitive data in a query string', () => {
  it('refuses a parameter whose name looks like a credential', () => {
    // `13` forbids it and trap 11 records the specific case: an invitation token is a live
    // credential and belongs in a POST body only. A URL reaches server logs, proxy logs, browser
    // history and screenshots.
    for (const key of [
      'token',
      'inviteToken',
      'access_token',
      'packToken',
      'password',
      'apiKey',
      'clientSecret',
      'Authorization',
    ]) {
      expect(() => buildUrl(CONFIG.baseUrl, '/v1/x', { [key]: 'value' })).toThrow(UnsafeRequest);
    }
  });

  it('names the offending parameter and says where it belongs', () => {
    expect(() => buildUrl(CONFIG.baseUrl, '/v1/x', { inviteToken: 'v' })).toThrow(/POST body/);
  });

  it('allows ordinary filters', () => {
    const url = buildUrl(CONFIG.baseUrl, '/v1/items', { profileId: 'p1', limit: 20 });
    expect(url).toBe('http://127.0.0.1:3000/v1/items?profileId=p1&limit=20');
  });

  it('drops undefined instead of serialising the string "undefined"', () => {
    // The usual way an optional filter turns into a query the server rejects.
    expect(buildUrl(CONFIG.baseUrl, '/v1/items', { profileId: 'p', itemKind: undefined })).toBe(
      'http://127.0.0.1:3000/v1/items?profileId=p',
    );
  });

  it('refuses a path that is not rooted', () => {
    expect(() => buildUrl(CONFIG.baseUrl, 'v1/items')).toThrow(UnsafeRequest);
  });
});

describe('headers', () => {
  it('sends the session identity and nothing when anonymous', async () => {
    const anon = stubFetch({ status: 200, body: { ok: true } });
    await request(
      { config: CONFIG, session: ANONYMOUS, fetch: anon.fetch },
      { method: 'GET', path: '/v1/profiles' },
    );
    const anonHeaders = anon.captured[0]?.init.headers as Record<string, string>;
    expect(anonHeaders[DEV_USER_HEADER]).toBeUndefined();

    const dev = stubFetch({ status: 200, body: { ok: true } });
    await request(
      { config: CONFIG, session: developmentSession(USER), fetch: dev.fetch },
      { method: 'GET', path: '/v1/profiles' },
    );
    const devHeaders = dev.captured[0]?.init.headers as Record<string, string>;
    expect(devHeaders[DEV_USER_HEADER]).toBe(USER);
  });

  it('sends an idempotency key only when one is given', async () => {
    // `13`: idempotency key on mutations that can be retried. Not generated per request, because
    // a key regenerated on retry is a second write rather than a replay.
    const without = stubFetch({ status: 201, body: {} });
    await request(
      { config: CONFIG, session: ANONYMOUS, fetch: without.fetch },
      { method: 'POST', path: '/v1/dose-events', body: {} },
    );
    expect((without.captured[0]?.init.headers as Record<string, string>)['idempotency-key']).toBe(
      undefined,
    );

    const withKey = stubFetch({ status: 201, body: {} });
    await request(
      { config: CONFIG, session: ANONYMOUS, fetch: withKey.fetch },
      { method: 'POST', path: '/v1/dose-events', body: {}, idempotencyKey: 'op-1' },
    );
    expect((withKey.captured[0]?.init.headers as Record<string, string>)['idempotency-key']).toBe(
      'op-1',
    );
  });

  it('sets a JSON content type only when there is a body', async () => {
    const stub = stubFetch({ status: 200, body: {} });
    await request(
      { config: CONFIG, session: ANONYMOUS, fetch: stub.fetch },
      { method: 'GET', path: '/v1/profiles' },
    );
    expect((stub.captured[0]?.init.headers as Record<string, string>)['content-type']).toBe(
      undefined,
    );
  });
});

describe('every failure is an outcome, not an exception', () => {
  it('turns an unreachable server into OFFLINE', async () => {
    // A DNS failure, a refused connection, a TLS error and an abort are one thing to the person
    // holding the phone: it did not reach Kynviora.
    const failing: FetchLike = () => Promise.reject(new TypeError('network error'));
    const outcome = await request(
      { config: CONFIG, session: ANONYMOUS, fetch: failing },
      { method: 'GET', path: '/v1/profiles' },
    );
    expect(outcome).toEqual({ kind: 'OFFLINE' });
  });

  it('turns a request that never answers into OFFLINE rather than hanging the screen', async () => {
    // Without the timeout the screen stays on LOADING forever, which `12` and `06` both treat as
    // a state that must not exist.
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });

    const outcome = await request(
      { config: { ...CONFIG, timeoutMs: 20 }, session: ANONYMOUS, fetch: hanging },
      { method: 'GET', path: '/v1/profiles' },
    );
    expect(outcome).toEqual({ kind: 'OFFLINE' });
  });

  it('does not throw for a 404, a 401 or a 500', async () => {
    for (const status of [401, 404, 500]) {
      const stub = stubFetch({ status, body: { error: { code: 'X', message: 'm' } } });
      const outcome = await request(
        { config: CONFIG, session: ANONYMOUS, fetch: stub.fetch },
        { method: 'GET', path: '/v1/profiles' },
      );
      expect(outcome.kind).not.toBe('OK');
    }
  });

  it('reports a 2xx with a non-JSON body as a server error, not as empty', async () => {
    // An empty screen that looks correct is worse than a visible failure.
    const bad: FetchLike = () => Promise.resolve(new Response('<html>', { status: 200 }));
    const outcome = await request(
      { config: CONFIG, session: ANONYMOUS, fetch: bad },
      { method: 'GET', path: '/v1/profiles' },
    );
    expect(outcome.kind).toBe('SERVER_ERROR');
  });

  it('returns the parsed body and the correlation ID on success', async () => {
    const stub = stubFetch({
      status: 200,
      body: { profiles: [] },
      headers: { 'x-correlation-id': 'corr-9' },
    });
    const outcome = await request<{ profiles: unknown[] }>(
      { config: CONFIG, session: ANONYMOUS, fetch: stub.fetch },
      { method: 'GET', path: '/v1/profiles' },
    );
    expect(outcome).toEqual({ kind: 'OK', value: { profiles: [] }, correlationId: 'corr-9' });
  });
});

describe('a mistake in the calling code still throws', () => {
  it('refuses to send a development identity to a remote origin', async () => {
    // Not an outcome a screen renders. It is a configuration error, and failing loudly is the
    // point: the alternative is quietly asserting an identity to a server that may accept it.
    await expect(
      request(
        {
          config: { baseUrl: 'https://api.kynviora.example', timeoutMs: 50 },
          session: developmentSession(USER),
          fetch: stubFetch({ status: 200, body: {} }).fetch,
        },
        { method: 'GET', path: '/v1/profiles' },
      ),
    ).rejects.toThrow(/development identity/);
  });
});
