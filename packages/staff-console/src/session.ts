/**
 * The staff session, which is not the household session.
 *
 * Spec references: `13` (reviewer console backend: MFA/passkey or approved strong authentication,
 * role-based least privilege, step-up for high-impact publish/withdraw, no shared accounts,
 * session expiration, environment isolation), `14` (reviewer/admin security: strong MFA, session
 * timeout, staff roles never inferred from a client claim), `DEV-016`, DEC-038.
 *
 * WHY THIS IS A SEPARATE TYPE AND NOT A MEMBER OF `ClientSession`
 * `@kynviora/contracts` holds the household session, and the Expo bundle carries it. Adding a
 * staff member there would ship reviewer session code to a phone and would make one union the
 * place where two trust boundaries meet. `13` asks for environment isolation; a shared type is
 * the opposite of it in the only place the compiler could have helped.
 *
 * WHAT THIS MODULE CANNOT DO, AND SAYS SO
 * `13` and `14` both require MFA or passkeys for a reviewer account. Phase 1.1 has not chosen an
 * auth provider, so there is nothing here that could perform one. The response is not to pretend:
 * {@link StaffSession} carries an {@link AuthenticationStrength} that is a closed union with one
 * member today, every page renders what it says, and {@link staffSessionWarnings} returns the
 * standing gap so a console cannot quietly stop mentioning it. The strength is **not** used to
 * grant anything - authority is the stored `reviewer` row and always was.
 *
 * WHY EXPIRY LIVES HERE RATHER THAN IN A COOKIE
 * A session that expires only because a cookie did is one that survives a cookie the browser
 * decided to keep. {@link staffAuthHeaders} refuses an expired session outright, so the transport
 * cannot send a request the policy would not have allowed - which is the same shape as the
 * household client refusing a development identity over a remote origin.
 */

import type { Instant } from '@kynviora/domain';

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * Identity header. Deliberately the same name the API's development authenticator reads.
 *
 * It is tempting to invent a staff-only header name so the two sessions "cannot be confused".
 * That would be decoration: `devAuth.ts` is the only authenticator that exists, it reads this
 * name, and a second name would either be ignored or would need the API to accept both - which is
 * one more way in. What separates the sessions is the origin, which is what a browser actually
 * enforces, plus the fact that this module never reads the household configuration.
 */
export const STAFF_USER_HEADER = 'x-kynviora-dev-user';

/** Step-up assertion header. Sent only for the actions that require it, never by default. */
export const STAFF_STEP_UP_HEADER = 'x-kynviora-dev-step-up';

export const STAFF_CORRELATION_HEADER = 'x-correlation-id';
export const STAFF_IDEMPOTENCY_HEADER = 'idempotency-key';

// ---------------------------------------------------------------------------
// Strength
// ---------------------------------------------------------------------------

/**
 * How the person at the console proved who they are.
 *
 * A closed union with one member, which is the point. When a passkey provider lands it becomes a
 * second member and every page that renders the standing warning stops rendering it *because the
 * value changed*, not because somebody deleted the banner.
 */
export const AUTHENTICATION_STRENGTHS = ['DEVELOPMENT_HEADER'] as const;
export type AuthenticationStrength = (typeof AUTHENTICATION_STRENGTHS)[number];

// ---------------------------------------------------------------------------
// Lifetimes
// ---------------------------------------------------------------------------

/**
 * How long a staff session may live at most.
 *
 * `13` requires session expiration and `14` requires a session timeout; neither states a number,
 * and no product decision has set one, so these are engineering defaults recorded as `DEV-027`.
 * Eight hours is a working day: long enough that a reviewer is not re-authenticating through a
 * publication, short enough that a session does not survive a night on an unlocked machine.
 */
export const STAFF_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/**
 * How long a session may sit idle.
 *
 * Shorter than the absolute lifetime and separately enforced, because the risk they cover is not
 * the same one: the absolute age bounds a stolen session, the idle window bounds an abandoned
 * desk.
 */
export const STAFF_SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * How long a step-up confirmation stays fresh.
 *
 * Much shorter than the session, because `14` asks for step-up *at* the publish or withdraw. A
 * step-up that lasted the session would mean confirming identity once in the morning and
 * publishing all afternoon, which is the control deleted and its name kept.
 *
 * The API has its own window and is the authority; this one exists so the console does not send a
 * step-up assertion it already knows to be stale.
 */
export const STAFF_STEP_UP_MAX_AGE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/**
 * Who the console is acting as.
 *
 * `SIGNED_OUT` is a member rather than `null` so a page has to say what it renders for it.
 */
export type StaffSession =
  | { readonly kind: 'SIGNED_OUT' }
  | {
      readonly kind: 'ACTIVE';
      readonly userId: string;
      readonly strength: AuthenticationStrength;
      /** When this session began. Bounds its absolute age. */
      readonly establishedAt: Instant;
      /** When it was last used. Bounds its idle age. */
      readonly lastUsedAt: Instant;
      /** When identity was last re-confirmed, or `null` for never. */
      readonly steppedUpAt: Instant | null;
    };

export const SIGNED_OUT: StaffSession = Object.freeze({ kind: 'SIGNED_OUT' });

export class StaffSessionRefused extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Begin a staff session, or refuse.
 *
 * Refuses a user ID that is not a UUID, for the same reason the household client does: a header
 * the API rejects produces a 401 that reads like a broken deployment rather than like a typo.
 *
 * There is no `displayName`, no team and no role. `14` says a staff role is never inferred from a
 * client claim, and a role held in the session is exactly such a claim - the console reads what
 * the API tells it about this caller and renders that.
 */
export function beginStaffSession(userId: string, at: Instant): StaffSession {
  const trimmed = userId.trim();
  if (!UUID.test(trimmed)) {
    throw new StaffSessionRefused(
      'A staff user ID must be a UUID. The API validates the header and would answer 401, which ' +
        'reads as a broken console rather than as a mistyped ID.',
    );
  }
  return {
    kind: 'ACTIVE',
    userId: trimmed,
    strength: 'DEVELOPMENT_HEADER',
    establishedAt: at,
    lastUsedAt: at,
    steppedUpAt: null,
  };
}

/** Record that the session was used, moving its idle window forward. */
export function touchStaffSession(session: StaffSession, at: Instant): StaffSession {
  if (session.kind === 'SIGNED_OUT') return session;
  return { ...session, lastUsedAt: at };
}

/**
 * Record a step-up confirmation.
 *
 * Also moves the idle window, because confirming identity is using the session.
 */
export function recordStepUp(session: StaffSession, at: Instant): StaffSession {
  if (session.kind === 'SIGNED_OUT') return session;
  return { ...session, lastUsedAt: at, steppedUpAt: at };
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * Why a session is no longer usable.
 *
 * Two reasons rather than one boolean, because the console tells the reviewer which happened and
 * they are different events: an absolute expiry is expected, an idle expiry means they walked
 * away.
 */
export type SessionExpiry = 'ACTIVE' | 'EXPIRED_MAX_AGE' | 'EXPIRED_IDLE' | 'SIGNED_OUT';

export function staffSessionExpiry(session: StaffSession, now: Instant): SessionExpiry {
  if (session.kind === 'SIGNED_OUT') return 'SIGNED_OUT';

  const at = Date.parse(now);
  if (at - Date.parse(session.establishedAt) >= STAFF_SESSION_MAX_AGE_MS) return 'EXPIRED_MAX_AGE';
  if (at - Date.parse(session.lastUsedAt) >= STAFF_SESSION_IDLE_MS) return 'EXPIRED_IDLE';
  return 'ACTIVE';
}

/** Whether a step-up confirmation is fresh enough to assert. */
export function hasFreshStepUp(session: StaffSession, now: Instant): boolean {
  if (session.kind === 'SIGNED_OUT') return false;
  if (session.steppedUpAt === null) return false;
  if (staffSessionExpiry(session, now) !== 'ACTIVE') return false;
  return Date.parse(now) - Date.parse(session.steppedUpAt) < STAFF_STEP_UP_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

function isLoopback(url: URL): boolean {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1'
  );
}

export class StaffConfigRefused extends Error {}

export interface StaffConsoleConfig {
  /** Origin of the **staff** API surface, with no trailing slash. */
  readonly apiBaseUrl: string;
  /** How long a request may take before the console treats the API as unreachable. */
  readonly timeoutMs: number;
}

/** Ten seconds, matching the household client. Long enough for a slow link, short enough to fail. */
export const DEFAULT_STAFF_TIMEOUT_MS = 10_000;

/**
 * Validate the staff API origin, or refuse.
 *
 * `13` requires HTTPS and loopback is the only exception, exactly as in the household client.
 * There is one extra refusal here and it is the point of the module: the staff API origin may not
 * be the household API origin. A console configured against the phone's origin would be a console
 * whose requests travel the user API - and after the surface split those requests would 404,
 * which reads as "the console is broken" rather than as "this is misconfigured in a way that
 * matters".
 */
export function resolveStaffApiBaseUrl(raw: string, householdBaseUrl?: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StaffConfigRefused(`Staff API base URL is not a URL: ${JSON.stringify(raw)}.`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new StaffConfigRefused(`Staff API base URL must be http or https, not ${url.protocol}.`);
  }
  if (url.protocol === 'http:' && !isLoopback(url)) {
    throw new StaffConfigRefused(
      `Refusing a plaintext staff API base URL that is not loopback: ${url.origin}. Spec 13 ` +
        'requires HTTPS, and this origin carries publication authority.',
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new StaffConfigRefused('Staff API base URL must not carry credentials.');
  }

  if (householdBaseUrl !== undefined && householdBaseUrl.trim() !== '') {
    let household: URL;
    try {
      household = new URL(householdBaseUrl);
    } catch {
      throw new StaffConfigRefused(
        `Household API base URL is not a URL: ${JSON.stringify(householdBaseUrl)}.`,
      );
    }
    if (household.origin === url.origin) {
      throw new StaffConfigRefused(
        `Refusing to run the reviewer console against the household API origin ${url.origin}. ` +
          'Spec 13 requires internal APIs not to be exposed as user APIs, and a console sharing ' +
          "the phone's origin shares its cookies, its CORS policy and its session.",
      );
    }
  }

  return url.origin;
}

/**
 * Refuse a session that has no business reaching this origin.
 *
 * The mirror of the household client's rule, and stricter for the same reason `14` is stricter
 * about reviewers: a development identity is a claim with no proof behind it, and here the claim
 * is to publication authority.
 */
export function assertStaffSessionAllowed(session: StaffSession, apiBaseUrl: string): void {
  if (session.kind === 'SIGNED_OUT') return;

  const url = new URL(apiBaseUrl);
  if (session.strength === 'DEVELOPMENT_HEADER' && !isLoopback(url)) {
    throw new StaffSessionRefused(
      `Refusing to send a development staff identity to ${url.origin}. A header carries no proof ` +
        'and this origin can publish safety content. Spec 13 requires MFA or passkeys for a ' +
        'reviewer account (BLK-010).',
    );
  }
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

export interface StaffHeaderOptions {
  /** Whether this request asserts step-up. Only the actions that need it should pass `true`. */
  readonly stepUp?: boolean;
}

/**
 * Request headers for a staff session, or a refusal.
 *
 * Returns `null` rather than throwing when the session cannot be used, because "signed out" and
 * "expired" are ordinary states of a console page, not exceptions. The caller renders the sign-in
 * page; the transport never sends the request.
 *
 * A step-up assertion is refused when it is stale. That is not the API's job being duplicated -
 * the API checks it too and is the authority - it is the console declining to send a claim it
 * already knows is false, so a reviewer is told to re-confirm rather than shown a 403.
 */
export function staffAuthHeaders(
  session: StaffSession,
  now: Instant,
  options: StaffHeaderOptions = {},
): Readonly<Record<string, string>> | null {
  if (staffSessionExpiry(session, now) !== 'ACTIVE') return null;
  if (session.kind !== 'ACTIVE') return null;

  const headers: Record<string, string> = { [STAFF_USER_HEADER]: session.userId };

  if (options.stepUp === true) {
    if (!hasFreshStepUp(session, now)) return null;
    headers[STAFF_STEP_UP_HEADER] = '1';
  }

  return Object.freeze(headers);
}

// ---------------------------------------------------------------------------
// What the console must keep saying
// ---------------------------------------------------------------------------

/**
 * A standing gap between what the specs require of this console and what it has.
 *
 * Returned as data rather than written into a template, so a page cannot drop one by being
 * redesigned and a test can assert the list is non-empty for as long as the blockers are open.
 */
export interface StaffWarning {
  readonly code: 'NO_STRONG_AUTHENTICATION' | 'NOTHING_IS_PUBLISHABLE' | 'NO_QUALIFIED_REVIEWER';
  readonly text: string;
}

/**
 * The gaps this console must state on every page.
 *
 * `39` of the operating brief forbids pretending a control exists. All three of these are true of
 * every build in this repository, and the console is the one surface where a person could
 * reasonably assume otherwise - it looks like the tool that publishes safety content, and it is,
 * and nothing it can reach is publishable.
 */
export function staffSessionWarnings(session: StaffSession): readonly StaffWarning[] {
  const warnings: StaffWarning[] = [];

  if (session.kind === 'ACTIVE' && session.strength === 'DEVELOPMENT_HEADER') {
    warnings.push({
      code: 'NO_STRONG_AUTHENTICATION',
      text:
        'This session is a development header, not a passkey or an MFA challenge. Spec 13 and 14 ' +
        'require strong authentication for a reviewer account and no provider is configured ' +
        '(BLK-010). Treat every action here as unattributed.',
    });
  }

  warnings.push({
    code: 'NO_QUALIFIED_REVIEWER',
    text:
      'No qualified clinical, pharmacist or regulatory reviewer is appointed for this build ' +
      '(BLK-006). A reviewer role in this database is a synthetic one.',
  });

  warnings.push({
    code: 'NOTHING_IS_PUBLISHABLE',
    text:
      'Every shipped regulatory record is refused by the Citation Gate, because the research ' +
      'behind it came from search summaries rather than retrieved official documents (BLK-004, ' +
      'DEC-016). An approval here does not make anything visible to a household.',
  });

  return warnings;
}
