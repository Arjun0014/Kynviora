/**
 * The staff API client.
 *
 * Spec references: `13` (stable machine-readable error codes, idempotency keys on retryable
 * mutations, no sensitive data in a query string, HTTPS), `14` (deny by default; nothing
 * sensitive in a log), `10` (governance audit artifacts), `DEV-016`.
 *
 * WHY THIS IS NOT `@kynviora/contracts`
 * That package is the household client and the Expo bundle carries it. Its session type, its
 * configuration reader and its view models are all about what a phone does. Reusing its transport
 * would mean either shipping staff code to a phone or widening its session union to cover a trust
 * boundary it has no business knowing about. `13` asks for environment isolation between the two,
 * and two packages is what that looks like in a monorepo.
 *
 * THE QUERY-STRING RULE IS STRONGER HERE
 * The household transport refuses query parameters whose names look like credentials. This client
 * refuses query strings **entirely**: no staff route takes one, so the rule has no exception to
 * carve out, and a rule with no exceptions cannot be applied inconsistently. Every identifier
 * travels as a path segment and is checked as a UUID first, so a caller cannot smuggle a query
 * onto the end of an ID.
 *
 * EVERY FAILURE IS AN OUTCOME
 * Nothing here throws for a failed request. A console page renders a union it must destructure,
 * for the same reason the household screens do - and `STEP_UP_REQUIRED` in particular is a state
 * a reviewer sees regularly rather than an error, because publishing asks for it every time.
 */

import type { Instant } from '@kynviora/domain';
import {
  STAFF_CORRELATION_HEADER,
  STAFF_IDEMPOTENCY_HEADER,
  assertStaffSessionAllowed,
  staffAuthHeaders,
  staffSessionExpiry,
  type SessionExpiry,
  type StaffConsoleConfig,
  type StaffSession,
} from './session.js';

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** The wire shape of an error body. Mirrors `services/api/src/errors.ts`. */
export interface StaffWireError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlationId: string;
}

/**
 * The result of one staff request.
 *
 * `UNAVAILABLE` covers a 404, which on this surface means one of three things the API refuses to
 * distinguish: no such request, a request this reviewer may not see, and a caller who holds no
 * reviewer row at all. `NOT_A_REVIEWER` is deliberately **not** a member - the API answers the
 * last case with a bare not-found precisely so the console cannot report it, and a member here
 * would put it back on the screen.
 */
export type StaffOutcome<T> =
  | { readonly kind: 'OK'; readonly value: T; readonly correlationId: string | null }
  /** No session, an expired one, or one the API does not accept. */
  | { readonly kind: 'UNAUTHENTICATED'; readonly expiry: SessionExpiry }
  /** `14`: publish and withdraw need a fresh identity confirmation. Routine, not an error. */
  | { readonly kind: 'STEP_UP_REQUIRED' }
  /** 404. Absence and refusal, deliberately indistinguishable. */
  | { readonly kind: 'UNAVAILABLE' }
  | {
      readonly kind: 'REFUSED';
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly correlationId: string | null;
    }
  | { readonly kind: 'OFFLINE' }
  | {
      readonly kind: 'SERVER_ERROR';
      readonly retryable: boolean;
      readonly correlationId: string | null;
    };

function parseWireError(body: unknown): StaffWireError | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = (body as { error?: unknown }).error;
  if (typeof envelope !== 'object' || envelope === null) return null;
  const error = envelope as Record<string, unknown>;
  if (typeof error.code !== 'string' || typeof error.message !== 'string') return null;
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable === true,
    correlationId: typeof error.correlationId === 'string' ? error.correlationId : '',
  };
}

/**
 * Turn a status and a parsed error body into an outcome.
 *
 * Branches on `code` before status, so an unrecognised code from a newer server degrades to
 * something sensible rather than to `OK`.
 */
export function classifyStaffError(
  status: number,
  error: StaffWireError | null,
): StaffOutcome<never> {
  const code = error?.code;
  const correlationId = error?.correlationId ?? null;

  if (code === 'STEP_UP_REQUIRED') return { kind: 'STEP_UP_REQUIRED' };
  if (code === 'UNAUTHENTICATED' || code === 'AUTHORIZATION_LOST') {
    return { kind: 'UNAUTHENTICATED', expiry: 'SIGNED_OUT' };
  }
  // Together, and before the status fallbacks: the API answers both with 404 so that a caller
  // cannot learn a request exists by being refused it.
  if (code === 'PERMISSION_DENIED' || code === 'NOT_FOUND') return { kind: 'UNAVAILABLE' };

  if (status === 401) return { kind: 'UNAUTHENTICATED', expiry: 'SIGNED_OUT' };
  if (status === 404) return { kind: 'UNAVAILABLE' };
  if (status >= 500) {
    return { kind: 'SERVER_ERROR', retryable: error?.retryable ?? true, correlationId };
  }
  if (error !== null) {
    return {
      kind: 'REFUSED',
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId,
    };
  }
  return { kind: 'SERVER_ERROR', retryable: false, correlationId };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class UnsafeStaffRequest extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Check an identifier before it becomes part of a URL.
 *
 * Refusing here rather than letting the API refuse means a malformed ID never reaches the wire,
 * and - more to the point - a value containing `?`, `#` or a path separator cannot change which
 * route is called. That is a smaller hole than it sounds only because every ID on this surface
 * happens to be a UUID; the check is what keeps it that way.
 */
export function staffPathId(value: string): string {
  if (!UUID.test(value)) {
    throw new UnsafeStaffRequest(
      `Refusing to put a non-UUID in a staff API path: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * Build a staff API URL.
 *
 * Refuses any path carrying a query string or a fragment. No staff route takes one, and a rule
 * without exceptions is one that cannot be applied inconsistently later.
 */
export function buildStaffUrl(baseUrl: string, path: string): string {
  if (!path.startsWith('/')) {
    throw new UnsafeStaffRequest(`Staff path must start with "/": ${JSON.stringify(path)}.`);
  }
  if (path.includes('?') || path.includes('#')) {
    throw new UnsafeStaffRequest(
      `Refusing a query string or fragment on a staff path: ${JSON.stringify(path)}. No staff ` +
        'route takes one, and spec 13 forbids sensitive values in a URL.',
    );
  }
  return new URL(baseUrl + path).toString();
}

export interface StaffRequestOptions {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  /** Whether this request asserts step-up. Only publish, withdraw and the block do. */
  readonly stepUp?: boolean;
  /** `13`: idempotency key on a retryable mutation. */
  readonly idempotencyKey?: string;
}

export interface StaffTransportDeps {
  readonly config: StaffConsoleConfig;
  readonly session: StaffSession;
  readonly now: Instant;
  readonly fetch: FetchLike;
}

/**
 * Perform one staff API request.
 *
 * The session is checked before the origin is touched: an expired session produces
 * `UNAUTHENTICATED` carrying *why*, so the console can say "you were signed out because the
 * window was idle" rather than "something went wrong".
 */
export async function staffRequest<T>(
  deps: StaffTransportDeps,
  options: StaffRequestOptions,
): Promise<StaffOutcome<T>> {
  const expiry = staffSessionExpiry(deps.session, deps.now);
  if (expiry !== 'ACTIVE') return { kind: 'UNAUTHENTICATED', expiry };

  assertStaffSessionAllowed(deps.session, deps.config.apiBaseUrl);

  const auth = staffAuthHeaders(
    deps.session,
    deps.now,
    options.stepUp === true ? { stepUp: true } : {},
  );
  if (auth === null) {
    // The only way to get here with an active session is a step-up that has gone stale. Reported
    // as the state the API would report, so one page handles both.
    return options.stepUp === true
      ? { kind: 'STEP_UP_REQUIRED' }
      : { kind: 'UNAUTHENTICATED', expiry };
  }

  const url = buildStaffUrl(deps.config.apiBaseUrl, options.path);

  const headers: Record<string, string> = { ...auth, accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey !== undefined) {
    headers[STAFF_IDEMPOTENCY_HEADER] = staffPathId(options.idempotencyKey);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.config.timeoutMs);

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: options.method,
      headers,
      signal: controller.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    // A network failure, a DNS failure or the timeout above. Not distinguished, because the thing
    // the reviewer can do about each is the same and guessing which would sometimes be wrong.
    return { kind: 'OFFLINE' };
  } finally {
    clearTimeout(timer);
  }

  const correlationId = response.headers.get(STAFF_CORRELATION_HEADER);

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (!response.ok) return classifyStaffError(response.status, parseWireError(parsed));
  return { kind: 'OK', value: parsed as T, correlationId };
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------
// Declared rather than imported from the API. `13` requires a stable contract, and a shape
// imported from the server would make a breaking change to it invisible until runtime.

export interface JurisdictionTallyResponse {
  readonly jurisdiction: string;
  readonly approvals: number;
}

export interface QueueItemResponse {
  readonly requestId: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly action: string;
  readonly jurisdictions: readonly string[];
  readonly maxUrgency: string | null;
  readonly evidenceLevel: string | null;
  readonly requiredApprovals: number;
  readonly requestedAt: string;
  readonly tally: readonly JurisdictionTallyResponse[];
  /** What this caller may do, decided by the API so the console offers no control it will refuse. */
  readonly youMayApprove: boolean;
}

export interface QueueResponse {
  readonly items: readonly QueueItemResponse[];
  readonly serverTime: string;
}

export interface ApprovalResponse {
  readonly approvalId: string;
  readonly reviewerUserId: string;
  readonly role: string;
  readonly decision: string;
  readonly jurisdictions: readonly string[];
  readonly note: string | null;
  readonly decidedAt: string;
}

export interface RequestDetailResponse {
  readonly requestId: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly action: string;
  readonly jurisdictions: readonly string[];
  readonly maxUrgency: string | null;
  readonly evidenceLevel: string | null;
  readonly requiredApprovals: number;
  readonly state: string;
  readonly requestedByUserId: string;
  readonly requestedAt: string;
  readonly withdrawalReason: string | null;
  readonly shadowRunId: string | null;
  readonly decidedAt: string | null;
  readonly approvals: readonly ApprovalResponse[];
  readonly tally: readonly JurisdictionTallyResponse[];
  readonly serverTime: string;
}

export interface ShadowSampleResponse {
  readonly ownedItemId: string;
  readonly matched: boolean;
  readonly matchConfidence: string | null;
  readonly reasons: readonly string[];
  readonly evidenceLevel: string | null;
  readonly urgency: string | null;
}

export interface ShadowRunResponse {
  readonly shadowRunId: string;
  readonly ruleVersionId: string;
  readonly datasetKind: string;
  readonly datasetLabel: string | null;
  readonly datasetSize: number;
  readonly matchedItems: number;
  readonly affectedProducts: number;
  readonly affectedFormulations: number;
  readonly potentialUserMatches: number;
  readonly reasonCounts: Readonly<Record<string, number>>;
  readonly runAt: string;
  readonly samples: readonly ShadowSampleResponse[];
  readonly serverTime: string;
}

export interface DecisionResponse {
  readonly requestId: string;
  readonly decision: string;
  readonly jurisdictions: readonly string[];
  readonly tally: readonly JurisdictionTallyResponse[];
  readonly serverTime: string;
}

export interface ExecuteResponse {
  readonly requestId: string;
  readonly action: string;
  readonly approvedJurisdictions: readonly string[];
  readonly serverTime: string;
}

export interface BlockResponse {
  readonly publicationBlocked: boolean;
  readonly withdrawalStillAvailable: boolean;
  readonly serverTime: string;
}

export interface MetricReadingResponse {
  readonly key: string;
  readonly value: number;
  readonly unit: string;
}

export interface SourceHealthResponse {
  readonly sourceId: string;
  readonly organization: string;
  readonly sourceName: string;
  readonly jurisdiction: string | null;
  readonly status: string;
  readonly parserVersion: string;
  readonly operationalOwner: string | null;
  readonly expectedRefreshIntervalMs: number;
  readonly lastAttemptedCheckAt: string | null;
  readonly lastSuccessfulCheckAt: string | null;
  readonly lastNewRecordAt: string | null;
  readonly consecutiveFailureCount: number;
  readonly overdueByMs: number | null;
  readonly neverSucceeded: boolean;
  readonly unowned: boolean;
}

export interface OperationsResponse {
  readonly at: string;
  readonly metrics: readonly MetricReadingResponse[];
  readonly sources: readonly SourceHealthResponse[];
  readonly serverTime: string;
}

export interface DecisionBody {
  readonly decision: string;
  readonly role: string;
  readonly jurisdictions: readonly string[];
  readonly checklist: readonly string[];
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * What the console can ask the staff API to do.
 *
 * There is no `createRequest` here, and that is deliberate for now: opening a publication request
 * is authoring, and the console this phase builds is the surface a *reviewer* uses to look at
 * what somebody else asked for and decide. Adding an author's screen would put both halves of a
 * separation-of-duties rule behind one set of controls, which is the thing `10` is about.
 */
export interface StaffApiClient {
  queue(): Promise<StaffOutcome<QueueResponse>>;
  request(requestId: string): Promise<StaffOutcome<RequestDetailResponse>>;
  shadowRun(shadowRunId: string): Promise<StaffOutcome<ShadowRunResponse>>;
  decide(requestId: string, body: DecisionBody): Promise<StaffOutcome<DecisionResponse>>;
  execute(requestId: string): Promise<StaffOutcome<ExecuteResponse>>;
  setPublicationBlock(
    blocked: boolean,
    reason: string | null,
  ): Promise<StaffOutcome<BlockResponse>>;
  operations(): Promise<StaffOutcome<OperationsResponse>>;
}

export function createStaffApiClient(deps: StaffTransportDeps): StaffApiClient {
  return {
    queue: () => staffRequest<QueueResponse>(deps, { method: 'GET', path: '/v1/reviewer/queue' }),

    request: (requestId) =>
      staffRequest<RequestDetailResponse>(deps, {
        method: 'GET',
        path: `/v1/reviewer/requests/${staffPathId(requestId)}`,
      }),

    // The join `DEV-017` said a console would do. The request detail returns a `shadowRunId` and
    // a reviewer confirming EXPECTED_MATCH_VOLUME needs the run itself, not its identifier.
    shadowRun: (shadowRunId) =>
      staffRequest<ShadowRunResponse>(deps, {
        method: 'GET',
        path: `/v1/reviewer/shadow-runs/${staffPathId(shadowRunId)}`,
      }),

    // No step-up. `14` asks for it at publish and withdraw; requiring it to record an opinion
    // would train reviewers to keep a step-up warm, which is the control worn down by use.
    decide: (requestId, body) =>
      staffRequest<DecisionResponse>(deps, {
        method: 'POST',
        path: `/v1/reviewer/requests/${staffPathId(requestId)}/decisions`,
        body,
      }),

    execute: (requestId) =>
      staffRequest<ExecuteResponse>(deps, {
        method: 'POST',
        path: `/v1/reviewer/requests/${staffPathId(requestId)}/execute`,
        body: {},
        stepUp: true,
      }),

    setPublicationBlock: (blocked, reason) =>
      staffRequest<BlockResponse>(deps, {
        method: 'POST',
        path: '/v1/reviewer/publication-block',
        body: { blocked, reason },
        stepUp: true,
      }),

    operations: () =>
      staffRequest<OperationsResponse>(deps, {
        method: 'GET',
        path: '/v1/reviewer/operations',
      }),
  };
}
