/**
 * The reviewer console process.
 *
 * Spec references: `04` Phase 6.6 (the reviewer queue and the source/evidence/legal-scope view),
 * `10` (separation of duties, emergency controls, governance audit artifacts), `13` (internal
 * APIs are not user APIs; reviewer console backend controls), `14` (reviewer/admin security),
 * `20` (the operational snapshot), `DEV-016`, `DEV-017`.
 *
 * WHAT THIS PROCESS CANNOT DO
 * It holds no database connection, no database credential and no `DatabasePool`. Everything it
 * knows it learned from the staff API over HTTP, as a caller holding a reviewer's session - which
 * is `13`'s least privilege applied to the console rather than described in it. A compromise here
 * gets what that reviewer could have got by using the console, and nothing else. It also means
 * the authorization that matters is enforced once, in the API, rather than twice with a chance of
 * disagreeing.
 *
 * WHY IT IS UNDER `services/` AND NOT `apps/`
 * `apps/` in this repository means a client that runs on somebody's device, and it is excluded
 * from the root typecheck, the lint config and the test run because the Expo toolchain needs its
 * own. This is a server process, and staff software is the last thing that should sit outside the
 * checks. `DEV-016` asks for a separate application on its own origin, and it is one: its own
 * package, its own process, its own port and its own session.
 *
 * WHY IT IS NOT ON THE STAFF API'S ORIGIN
 * Three origins, not two: the phone's API, the staff API, and this. A console served from the
 * staff API's origin could be reached by anything that could reach the API, and its session
 * cookie would be sent to the API on every call - so an XSS anywhere in the console would carry
 * publication authority directly. Separate origins is what makes the cookie unreachable from the
 * API's origin and the API unreachable from a page hosted anywhere else.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Instant, Logger } from '@kynviora/domain';
import {
  FORM_TOKEN_FIELD,
  assertStaffSessionAllowed,
  createStaffApiClient,
  decisionFormView,
  operationsPage,
  operationsView,
  outcomePage,
  queuePage,
  queueView,
  requestDetailView,
  requestPage,
  signInPage,
  staffSessionWarnings,
  type FetchLike,
  type RequestDetailResponse,
  type ShadowRunResponse,
  type StaffApiClient,
  type StaffConsoleConfig,
  type StaffOutcome,
  type StaffSession,
} from '@kynviora/staff-console';
import {
  NO_SESSION,
  SESSION_COOKIE,
  createSessionStore,
  tokensMatch,
  type StaffSessionStore,
  type StoredSession,
} from './sessionStore.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ConsoleServerOptions {
  readonly config: StaffConsoleConfig;
  readonly logger: Logger;
  now(): Instant;
  /** Injected so a test can drive the console against an in-memory staff API. */
  readonly fetch?: FetchLike;
  /** Whether to mark the session cookie `Secure`. Off on loopback, where there is no TLS. */
  readonly secureCookie?: boolean;
  readonly store?: StaffSessionStore;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Read one cookie.
 *
 * Hand-rolled rather than a plugin, because the console sets exactly one cookie and a parser is
 * six lines. `14`'s supply-chain section asks for dependency scanning, and this is one fewer
 * dependency on the surface that can publish safety content.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

/**
 * The session cookie.
 *
 * `HttpOnly` so script cannot read it, `SameSite=Strict` so a cross-site form post carries no
 * session, `Path=/` because every page needs it, and `Secure` wherever there is TLS to be secure
 * over. There is deliberately no `Max-Age`: the session's lifetime is the server's to decide, and
 * a cookie that outlived it would only mean the browser kept sending a token the store has
 * already dropped.
 */
export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createConsoleServer(options: ConsoleServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: false });
  const store = options.store ?? createSessionStore();
  const secure = options.secureCookie ?? false;
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  // Form posts, not JSON. A console with no script has nothing to send JSON with, and accepting
  // it anyway would widen what a cross-site request could do.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, parseForm(typeof body === 'string' ? body : ''));
    },
  );

  app.addHook('onRequest', (_request, reply, done) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('cache-control', 'no-store');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    // The page loads nothing from anywhere, runs no script and submits only to itself. Saying so
    // in a header means a value that somehow escaped the escaper still has nothing to run.
    void reply.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    done();
  });

  function html(reply: FastifyReply, status: number, body: string): FastifyReply {
    return reply.status(status).header('content-type', 'text/html; charset=utf-8').send(body);
  }

  function shellFor(stored: StoredSession | null) {
    const session: StaffSession = stored?.session ?? NO_SESSION;
    return {
      warnings: staffSessionWarnings(session).map((warning) => warning.text),
      userId: session.kind === 'ACTIVE' ? session.userId : null,
    };
  }

  function clientFor(stored: StoredSession, now: Instant): StaffApiClient {
    return createStaffApiClient({
      config: options.config,
      session: stored.session,
      now,
      fetch: fetchImpl,
    });
  }

  function tokenFrom(request: FastifyRequest): string | null {
    return readCookie(request.headers.cookie, SESSION_COOKIE);
  }

  /**
   * Resolve the session, or render the sign-in page.
   *
   * The sign-in page names which expiry happened. `12` separates "you are not signed in" from
   * "you were, and now you are not" because only the second is worth an apology, and on a console
   * an idle expiry means the reviewer walked away rather than that anything went wrong.
   */
  async function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<StoredSession | null> {
    const now = options.now();
    const lookup = store.use(tokenFrom(request), now);
    if (lookup.stored !== null) return lookup.stored;

    const message =
      lookup.expiry === 'EXPIRED_IDLE'
        ? 'This session was closed because it sat unused. Nothing was lost.'
        : lookup.expiry === 'EXPIRED_MAX_AGE'
          ? 'This session reached its maximum age and was closed.'
          : null;

    await html(
      reply.header('set-cookie', clearedSessionCookie(secure)),
      200,
      signInPage({ message }),
    );
    return null;
  }

  /**
   * Check the form token, or refuse.
   *
   * Every state-changing route calls this before doing anything else. `SameSite=Strict` is the
   * first lock and this is the second; see `pages.ts` for why a console that can publish safety
   * content gets two.
   */
  function formTokenOk(stored: StoredSession, body: unknown): boolean {
    if (typeof body !== 'object' || body === null) return false;
    const given = (body as Record<string, unknown>)[FORM_TOKEN_FIELD];
    if (typeof given !== 'string') return false;
    return tokensMatch(stored.formToken, given);
  }

  function refuseForm(reply: FastifyReply, stored: StoredSession): FastifyReply {
    // Deliberately the ordinary refusal page and not a description of the check. A page naming
    // the token would be a page telling an attacker what to look for.
    return html(
      reply,
      400,
      outcomePage(
        'REFUSED',
        {
          message: 'This form could not be accepted. Open the page again and retry.',
          correlationId: null,
          formToken: stored.formToken,
        },
        shellFor(stored),
      ),
    );
  }

  /**
   * Render whatever a non-`OK` outcome should look like.
   *
   * One place, so no page invents its own wording for a refusal - and in particular so no page
   * turns `UNAVAILABLE` into an explanation. The API answers "no such request", "not yours" and
   * "you hold no reviewer role" identically on purpose.
   */
  function renderOutcome(
    reply: FastifyReply,
    outcome: Exclude<StaffOutcome<unknown>, { kind: 'OK' }>,
    stored: StoredSession,
  ): FastifyReply {
    if (outcome.kind === 'UNAUTHENTICATED') {
      store.end(stored.token);
      return html(
        reply.header('set-cookie', clearedSessionCookie(secure)),
        200,
        signInPage({ message: 'The staff API did not accept this session.' }),
      );
    }

    const shell = shellFor(stored);
    const detail = { formToken: stored.formToken };

    switch (outcome.kind) {
      case 'STEP_UP_REQUIRED':
        return html(
          reply,
          200,
          outcomePage('STEP_UP_REQUIRED', { message: null, correlationId: null, ...detail }, shell),
        );
      case 'UNAVAILABLE':
        return html(
          reply,
          404,
          outcomePage('UNAVAILABLE', { message: null, correlationId: null, ...detail }, shell),
        );
      case 'OFFLINE':
        return html(
          reply,
          502,
          outcomePage('OFFLINE', { message: null, correlationId: null, ...detail }, shell),
        );
      case 'REFUSED':
        return html(
          reply,
          400,
          outcomePage(
            'REFUSED',
            { message: outcome.message, correlationId: outcome.correlationId, ...detail },
            shell,
          ),
        );
      case 'SERVER_ERROR':
        return html(
          reply,
          502,
          outcomePage(
            'SERVER_ERROR',
            { message: null, correlationId: outcome.correlationId, ...detail },
            shell,
          ),
        );
    }
  }

  // -------------------------------------------------------------------------
  // Health and the entry point
  // -------------------------------------------------------------------------

  app.get('/health', (_request, reply) => reply.send({ status: 'ok' }));

  app.get('/', (_request, reply) => reply.redirect('/queue', 303));

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  app.get('/sign-in', (request, reply) => {
    const token = tokenFrom(request);
    if (token !== null) store.end(token);
    return html(
      reply.header('set-cookie', clearedSessionCookie(secure)),
      200,
      signInPage({ message: null }),
    );
  });

  app.post('/session', (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';

    if (!UUID.test(userId)) {
      return html(
        reply,
        400,
        signInPage({ message: 'That is not a UUID. The API would answer 401 for it.' }),
      );
    }

    const stored = store.begin(userId, options.now());

    // Refuses a development identity over anything but loopback. The console will not send a
    // header carrying publication authority to a remote origin (BLK-010).
    try {
      assertStaffSessionAllowed(stored.session, options.config.apiBaseUrl);
    } catch {
      store.end(stored.token);
      return html(
        reply,
        400,
        signInPage({
          message:
            'This build can only use a development identity against a loopback staff API. Spec ' +
            '13 requires a passkey or MFA for a reviewer account (BLK-010).',
        }),
      );
    }

    options.logger.info('staff_console.session_started', {});
    return reply.header('set-cookie', sessionCookie(stored.token, secure)).redirect('/queue', 303);
  });

  app.post('/sign-out', (request, reply) => {
    const token = tokenFrom(request);
    if (token !== null) store.end(token);
    return reply.header('set-cookie', clearedSessionCookie(secure)).redirect('/sign-in', 303);
  });

  app.post('/step-up', async (request, reply) => {
    const stored = await requireSession(request, reply);
    if (stored === null) return reply;
    if (!formTokenOk(stored, request.body)) return refuseForm(reply, stored);

    // There is no challenge to perform. `13` and `14` require one and none exists (BLK-010), so
    // this records the confirmation the API's development authenticator will accept and the page
    // says plainly that nothing was verified.
    const stepped = store.stepUp(stored.token, options.now());
    if (stepped === null) return reply.redirect('/sign-in', 303);

    options.logger.info('staff_console.step_up_recorded', {});
    return reply.redirect('/queue', 303);
  });

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  app.get('/queue', async (request, reply) => {
    const stored = await requireSession(request, reply);
    if (stored === null) return reply;

    const now = options.now();
    const outcome = await clientFor(stored, now).queue();
    if (outcome.kind !== 'OK') return renderOutcome(reply, outcome, stored);

    return html(reply, 200, queuePage(queueView(outcome.value, now), shellFor(stored)));
  });

  // -------------------------------------------------------------------------
  // One request
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/requests/:id', async (request, reply) => {
    const stored = await requireSession(request, reply);
    if (stored === null) return reply;

    if (!UUID.test(request.params.id)) {
      // The same page a real absence produces. A distinct "malformed" page would tell a prober
      // which of their guesses were well-formed.
      return html(
        reply,
        404,
        outcomePage(
          'UNAVAILABLE',
          { message: null, correlationId: null, formToken: stored.formToken },
          shellFor(stored),
        ),
      );
    }

    const now = options.now();
    const client = clientFor(stored, now);

    const detailOutcome = await client.request(request.params.id);
    if (detailOutcome.kind !== 'OK') return renderOutcome(reply, detailOutcome, stored);

    const detail: RequestDetailResponse = detailOutcome.value;

    // The join `DEV-017` left outstanding. A failure to load the run is not a failure of the
    // page: the request is still worth looking at, and the view says the run could not be
    // fetched rather than pretending there was none.
    let run: ShadowRunResponse | null = null;
    if (detail.shadowRunId !== null && UUID.test(detail.shadowRunId)) {
      const runOutcome = await client.shadowRun(detail.shadowRunId);
      if (runOutcome.kind === 'OK') run = runOutcome.value;
    }

    const viewerUserId = stored.session.kind === 'ACTIVE' ? stored.session.userId : '';
    const view = requestDetailView({ detail, shadowRun: run, viewerUserId, now });

    return html(
      reply,
      200,
      requestPage(view, decisionFormView(detail), shellFor(stored), {
        // Separation of duties as the API decided it, not as this process guessed it.
        canDecide: detail.requestedByUserId !== viewerUserId || detail.action === 'WITHDRAW',
        message: null,
        formToken: stored.formToken,
      }),
    );
  });

  app.post<{ Params: { id: string } }>('/requests/:id/decisions', async (request, reply) => {
    const stored = await requireSession(request, reply);
    if (stored === null) return reply;
    if (!formTokenOk(stored, request.body)) return refuseForm(reply, stored);
    if (!UUID.test(request.params.id)) return reply.redirect('/queue', 303);

    const body = request.body as Record<string, unknown>;
    const outcome = await clientFor(stored, options.now()).decide(request.params.id, {
      decision: asString(body.decision),
      role: asString(body.role),
      jurisdictions: asStringList(body.jurisdictions),
      checklist: asStringList(body.checklist),
      note: asString(body.note) === '' ? null : asString(body.note),
    });

    if (outcome.kind !== 'OK') return renderOutcome(reply, outcome, stored);

    options.logger.info('staff_console.decision_submitted', {});
    return reply.redirect(`/requests/${request.params.id}`, 303);
  });

  app.post<{ Params: { id: string } }>('/requests/:id/execute', async (request, reply) => {
    const stored = await requireSession(request, reply);
    if (stored === null) return reply;
    if (!formTokenOk(stored, request.body)) return refuseForm(reply, stored);
    if (!UUID.test(request.params.id)) return reply.redirect('/queue', 303);

    const outcome = await clientFor(stored, options.now()).execute(request.params.id);
    if (outcome.kind !== 'OK') return renderOutcome(reply, outcome, stored);

    options.logger.info('staff_console.execution_submitted', {});
    return reply.redirect(`/requests/${request.params.id}`, 303);
  });

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  app.get('/operations', async (request, reply) => {
    const stored = await requireSession(request, reply);
    if (stored === null) return reply;

    const outcome = await clientFor(stored, options.now()).operations();
    if (outcome.kind !== 'OK') return renderOutcome(reply, outcome, stored);

    const view = operationsView(outcome.value);
    const blocked = outcome.value.metrics.some(
      (metric) => metric.key === 'publication_blocked' && metric.value === 1,
    );

    return html(
      reply,
      200,
      operationsPage(view, shellFor(stored), {
        publicationBlocked: blocked,
        message: null,
        formToken: stored.formToken,
      }),
    );
  });

  app.post('/publication-block', async (request, reply) => {
    const stored = await requireSession(request, reply);
    if (stored === null) return reply;
    if (!formTokenOk(stored, request.body)) return refuseForm(reply, stored);

    const body = request.body as Record<string, unknown>;
    const blocked = asString(body.blocked) === 'true';
    const reason = asString(body.reason);

    const outcome = await clientFor(stored, options.now()).setPublicationBlock(
      blocked,
      // The API refuses a block with no reason. Sending an empty string rather than null would
      // pass that check with nothing in it.
      blocked && reason.trim() !== '' ? reason : null,
    );

    if (outcome.kind !== 'OK') return renderOutcome(reply, outcome, stored);

    options.logger.info(blocked ? 'staff_console.block_set' : 'staff_console.block_lifted', {});
    return reply.redirect('/operations', 303);
  });

  // -------------------------------------------------------------------------
  // Fallbacks
  // -------------------------------------------------------------------------

  app.setNotFoundHandler((request, reply) => {
    const lookup = store.use(tokenFrom(request), options.now());
    return html(
      reply,
      404,
      outcomePage(
        'UNAVAILABLE',
        {
          message: null,
          correlationId: null,
          formToken: lookup.stored?.formToken ?? '',
        },
        shellFor(lookup.stored),
      ),
    );
  });

  app.setErrorHandler((_error, _request, reply) => {
    // Never the message: it could carry a URL, a header value or a fragment of a session.
    options.logger.error('staff_console.unhandled_error', {});
    return html(
      reply,
      500,
      outcomePage(
        'SERVER_ERROR',
        { message: null, correlationId: null, formToken: '' },
        { warnings: [], userId: null },
      ),
    );
  });

  return app;
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

/**
 * Parse an urlencoded body.
 *
 * A repeated field becomes an array, because the jurisdiction and checklist controls are
 * checkboxes and a browser sends one pair per ticked box. Keeping only the last would silently
 * approve one jurisdiction where the reviewer ticked three, which is a scope nobody reviewed.
 */
export function parseForm(body: string): Record<string, string | string[]> {
  const params = new URLSearchParams(body);
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }
  return out;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringList(value: unknown): readonly string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}
