/**
 * The transport.
 *
 * Spec references: `13` (HTTPS, idempotency keys on retryable mutations, no sensitive data in
 * query strings, stable error codes), `14` (nothing sensitive in a log; deny by default),
 * `12` (offline is a first-class outcome, not an exception).
 *
 * NO SENSITIVE DATA IN A QUERY STRING, ENFORCED RATHER THAN REMEMBERED
 * `13` forbids it and `STATUS.md` trap 11 records the specific case: an invitation token is a
 * live credential and belongs in a POST body only, never in a URL, a log line or an exception
 * message. {@link buildUrl} refuses a query parameter whose name looks like a credential, so the
 * rule is a compile-and-run failure rather than a code review someone has to remember to do.
 *
 * EVERY FAILURE IS AN OUTCOME, NOT AN EXCEPTION
 * `request` does not throw for a network failure, a timeout, a 404 or a 500. `06` requires every
 * critical route to define its offline and error states, and a transport that throws makes those
 * states something each caller has to remember to write a `catch` for. One closed union means the
 * compiler asks instead.
 */

import {
  CORRELATION_HEADER,
  IDEMPOTENCY_HEADER,
  assertSessionAllowed,
  authHeaders,
  type ApiConfig,
  type ClientSession,
} from './config.js';
import { classifyError, parseWireError, type ApiOutcome } from './outcome.js';

/**
 * Query parameter names that must never appear in a URL.
 *
 * Matched as substrings, case-insensitively, because the mistake is `inviteToken`, `access_token`
 * or `packToken` rather than a bare `token`.
 */
export const FORBIDDEN_QUERY_FIELDS: readonly string[] = Object.freeze([
  'token',
  'password',
  'secret',
  'credential',
  'authorization',
  'apikey',
  'api_key',
]);

export class UnsafeRequest extends Error {}

export type QueryValue = string | number | boolean | undefined;

/**
 * Build a request URL, refusing anything that would put a credential in it.
 *
 * `undefined` values are dropped rather than serialised as the string "undefined", which is the
 * usual way an optional filter turns into a query the server rejects.
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> = {},
): string {
  if (!path.startsWith('/')) {
    throw new UnsafeRequest(`Path must start with "/": ${JSON.stringify(path)}.`);
  }

  const url = new URL(baseUrl + path);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;

    const lowered = key.toLowerCase();
    const offending = FORBIDDEN_QUERY_FIELDS.find((field) => lowered.includes(field));
    if (offending !== undefined) {
      throw new UnsafeRequest(
        `Refusing to put "${key}" in a query string. Spec 13 forbids sensitive data in a URL, ` +
          'and a URL reaches server logs, proxy logs, browser history and screenshots. Send it ' +
          'in a POST body.',
      );
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

/** Injected so a test can drive the client without a network, and Expo can supply its own. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  readonly config: ApiConfig;
  readonly session: ClientSession;
  /** Defaults to the ambient `fetch`. */
  readonly fetch?: FetchLike;
}

export interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  /**
   * `13`: "Idempotency key on mutations that can be retried."
   *
   * Required by the server on some routes. Passed explicitly rather than generated per request,
   * because a key regenerated on retry is not an idempotency key - it is a second write.
   */
  readonly idempotencyKey?: string;
}

/**
 * Perform one request.
 *
 * Returns an outcome for every path including failure. The only thing that can throw is a
 * programming error caught before the request leaves: an unsafe URL or a refused session.
 */
export async function request<T>(
  transport: TransportOptions,
  options: RequestOptions,
): Promise<ApiOutcome<T>> {
  const { config, session } = transport;

  // Both throw. They are mistakes in the calling code, not conditions a screen renders.
  assertSessionAllowed(session, config.baseUrl);
  const url = buildUrl(config.baseUrl, options.path, options.query);

  const doFetch = transport.fetch ?? ((input, init) => fetch(input, init));

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...authHeaders(session),
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey !== undefined) headers[IDEMPOTENCY_HEADER] = options.idempotencyKey;

  // A request that never completes is indistinguishable to a user from one that failed, and it
  // leaves the screen on `LOADING` forever. `12` requires the offline state to be reachable.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, config.timeoutMs);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: options.method,
      headers,
      signal: controller.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    // Deliberately not inspecting the error. A DNS failure, a refused connection, a TLS error and
    // an abort are one thing to the person holding the phone: it did not reach Kynviora. The
    // reason is also the kind of detail `14` keeps out of anything user-facing.
    return { kind: 'OFFLINE' };
  } finally {
    clearTimeout(timer);
  }

  const correlationId = response.headers.get(CORRELATION_HEADER);
  const payload = await readJson(response);

  if (!response.ok) {
    return classifyError(response.status, parseWireError(payload));
  }

  if (payload === undefined) {
    // A 2xx whose body is not JSON is a contract violation, not an empty result. Reported as a
    // server error so it is visible, rather than as an empty screen that looks correct.
    return { kind: 'SERVER_ERROR', retryable: false, correlationId };
  }

  return { kind: 'OK', value: payload as T, correlationId };
}

/** Parse a JSON body, or `undefined` if there is not one. Never throws. */
async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text.trim() === '') return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
