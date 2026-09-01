/**
 * Where the console's sessions live.
 *
 * Spec references: `13` (session expiration, no shared accounts, environment isolation),
 * `14` (reviewer/admin security: session timeout, step-up for publish and withdraw),
 * `DEV-016`, `DEV-027`.
 *
 * WHY THE COOKIE CARRIES A TOKEN AND NOT THE SESSION
 * A signed cookie holding the session would let the holder keep a session alive across a restart,
 * survive a sign-out the server thinks it performed, and - if the signing key ever leaked - mint
 * one. Here the cookie carries an opaque random token and nothing else: identity, when the session
 * began, when it was last used and when identity was last confirmed are all held server-side, so
 * the client cannot extend its own session or claim a step-up it did not perform.
 *
 * WHY IN MEMORY
 * A single process, and every session ends when it stops. That is the correct behaviour for a
 * console with no strong authentication behind it (`BLK-010`): a restart signing everybody out is
 * a feature while the sign-in step proves nothing. A shared store lands here when Phase 1.1
 * chooses a provider, and this interface is the seam.
 *
 * THE FORM TOKEN
 * Minted with the session, held beside it and never derived from it. Deriving it from the session
 * token would mean anything that leaked one leaked the other, and the point of having two is that
 * they fail independently.
 */

import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Instant } from '@kynviora/domain';
import {
  SIGNED_OUT,
  beginStaffSession,
  recordStepUp,
  staffSessionExpiry,
  touchStaffSession,
  type SessionExpiry,
  type StaffSession,
} from '@kynviora/staff-console';

/** Name of the cookie carrying the opaque session token. */
export const SESSION_COOKIE = 'kynviora_staff_session';

export interface StoredSession {
  readonly token: string;
  readonly formToken: string;
  readonly session: StaffSession;
}

export interface SessionLookup {
  readonly stored: StoredSession | null;
  /** Why there is no usable session, for a page that says which. */
  readonly expiry: SessionExpiry;
}

export interface StaffSessionStore {
  begin(userId: string, now: Instant): StoredSession;
  /** Look one up and move its idle window forward. */
  use(token: string | null, now: Instant): SessionLookup;
  /** Record that identity was confirmed again. Returns `null` if the session is gone. */
  stepUp(token: string, now: Instant): StoredSession | null;
  end(token: string): void;
  /** Drop every expired session. Called on each request, so the map does not grow forever. */
  sweep(now: Instant): void;
  size(): number;
}

/**
 * Compare two tokens without leaking their contents through timing.
 *
 * A form token check is a security check; a `===` on it is a length-and-prefix oracle. The cost of
 * doing it properly is one buffer allocation.
 */
export function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createSessionStore(): StaffSessionStore {
  const sessions = new Map<string, StoredSession>();

  function sweep(now: Instant): void {
    for (const [token, stored] of sessions) {
      if (staffSessionExpiry(stored.session, now) !== 'ACTIVE') sessions.delete(token);
    }
  }

  return {
    begin(userId, now) {
      // Throws for a malformed user ID, which the route turns into the sign-in page again.
      const session = beginStaffSession(userId, now);
      const stored: StoredSession = {
        // 256 bits from the platform CSPRNG. A UUID would be 122 bits of randomness and would
        // look like an identifier somebody might reasonably log.
        token: randomBytes(32).toString('base64url'),
        formToken: randomUUID(),
        session,
      };
      sessions.set(stored.token, stored);
      return stored;
    },

    use(token, now) {
      sweep(now);
      if (token === null) return { stored: null, expiry: 'SIGNED_OUT' };

      const found = sessions.get(token);
      if (found === undefined) return { stored: null, expiry: 'SIGNED_OUT' };

      const expiry = staffSessionExpiry(found.session, now);
      if (expiry !== 'ACTIVE') {
        sessions.delete(token);
        return { stored: null, expiry };
      }

      const refreshed: StoredSession = {
        ...found,
        session: touchStaffSession(found.session, now),
      };
      sessions.set(token, refreshed);
      return { stored: refreshed, expiry: 'ACTIVE' };
    },

    stepUp(token, now) {
      const found = sessions.get(token);
      if (found === undefined) return null;
      if (staffSessionExpiry(found.session, now) !== 'ACTIVE') {
        sessions.delete(token);
        return null;
      }
      const stepped: StoredSession = { ...found, session: recordStepUp(found.session, now) };
      sessions.set(token, stepped);
      return stepped;
    },

    end(token) {
      sessions.delete(token);
    },

    sweep,
    size: () => sessions.size,
  };
}

/** The signed-out session, for a page rendered with no store entry. */
export const NO_SESSION: StaffSession = SIGNED_OUT;
