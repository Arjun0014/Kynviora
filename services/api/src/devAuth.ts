/**
 * A development-only authenticator.
 *
 * Spec references: `14` (deny by default; reviewer/admin roles are not inferred from client
 * claims), `13` (every request derives authority from an authenticated session), `04` Phase 1.1
 * (authentication, `NOT_STARTED` and deliberately blocked on a provider decision).
 *
 * WHY THIS EXISTS AT ALL
 * Phase 1.1 is unstarted on purpose: the schema holds no password hash because which auth provider
 * Kynviora uses is an unmade product decision. That is the right call and it has one bad
 * consequence - nothing produces a `Principal`, so no route can be exercised by hand and the app
 * cannot be run at all. This closes that gap for development without pre-empting the decision.
 *
 * WHY IT IS SAFE
 * It fails closed at three separate points, and all three are tested:
 *
 *  1. it is only constructed when `KYNVIORA_DEV_AUTH=1` is set explicitly;
 *  2. {@link createDevAuthenticator} throws if `NODE_ENV` is `production`, so the flag cannot be
 *     carried into a deployment by a copied `.env`;
 *  3. with no header, it returns `null` - which every route already treats as unauthenticated.
 *
 * It grants **no reviewer role**. `14` says reviewer roles are not inferred from client claims,
 * and a header is a client claim: a dev principal is an ordinary user, and the reviewer console
 * still requires a row in `reviewer`. Handing out staff access through a header is exactly the
 * shape of the thing this codebase spent two phases refusing.
 */

import type { FastifyRequest } from 'fastify';
import { unsafeId, type Instant, type UserId } from '@kynviora/domain';
import type { Principal } from './context.js';

/** The header a development client presents. Never read outside this module. */
export const DEV_USER_HEADER = 'x-kynviora-dev-user';

/**
 * Header asserting the session has completed step-up.
 *
 * Separate from the identity header so a developer has to opt into it, and so the step-up-required
 * paths can be exercised in both directions rather than being permanently satisfied.
 */
export const DEV_STEP_UP_HEADER = 'x-kynviora-dev-step-up';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DevAuthOptions {
  /** Injected so the caller's clock is the one the rest of the request uses (DEC-003). */
  now(): Instant;
  readonly nodeEnv?: string | undefined;
  readonly enabled?: string | undefined;
}

export class DevAuthRefused extends Error {}

/**
 * Build the development authenticator, or refuse.
 *
 * Returns `null` when the flag is absent, which the caller turns into "every request is
 * unauthenticated" rather than into an error - a server with no auth configured should still
 * start, serve its health endpoint, and reject everything else.
 */
export function createDevAuthenticator(
  options: DevAuthOptions,
): ((request: FastifyRequest) => Promise<Principal | null>) | null {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const enabled = options.enabled ?? process.env.KYNVIORA_DEV_AUTH;

  if (enabled !== '1') return null;

  if (nodeEnv === 'production') {
    // Not a warning. A copied `.env` is the ordinary way a development flag reaches a deployment,
    // and the failure has to be loud enough to stop the process.
    throw new DevAuthRefused(
      'KYNVIORA_DEV_AUTH=1 with NODE_ENV=production. Header-based identity is a development ' +
        'convenience and must never run where real people have accounts (spec 14).',
    );
  }

  return (request: FastifyRequest): Promise<Principal | null> => {
    const headers = request.headers as Record<string, string | string[] | undefined>;
    const raw = headers[DEV_USER_HEADER];
    const userId = Array.isArray(raw) ? raw[0] : raw;

    // Deny by default: no header is not "some default user", it is nobody.
    if (typeof userId !== 'string' || !UUID.test(userId)) return Promise.resolve(null);

    const stepUpRaw = headers[DEV_STEP_UP_HEADER];
    const stepUp = Array.isArray(stepUpRaw) ? stepUpRaw[0] : stepUpRaw;

    return Promise.resolve({
      userId: unsafeId<UserId>(userId),
      stepUpVerifiedAt: stepUp === '1' ? options.now() : null,
    });
  };
}
