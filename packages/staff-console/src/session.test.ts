import { describe, it, expect } from 'vitest';
import { instantFrom } from '@kynviora/domain';
import {
  DEFAULT_STAFF_TIMEOUT_MS,
  SIGNED_OUT,
  STAFF_SESSION_IDLE_MS,
  STAFF_SESSION_MAX_AGE_MS,
  STAFF_STEP_UP_HEADER,
  STAFF_STEP_UP_MAX_AGE_MS,
  STAFF_USER_HEADER,
  StaffConfigRefused,
  StaffSessionRefused,
  assertStaffSessionAllowed,
  beginStaffSession,
  hasFreshStepUp,
  recordStepUp,
  resolveStaffApiBaseUrl,
  staffAuthHeaders,
  staffSessionExpiry,
  staffSessionWarnings,
  touchStaffSession,
} from './session.js';

const REVIEWER = '00000000-0000-4000-8000-000000000001';
const START = instantFrom('2026-09-01T09:00:00.000Z');

function at(msFromStart: number) {
  return instantFrom(new Date(Date.parse(START) + msFromStart).toISOString());
}

describe('beginning a session', () => {
  it('refuses a user ID that is not a UUID', () => {
    expect(() => beginStaffSession('not-a-uuid', START)).toThrow(StaffSessionRefused);
  });

  it('records when it began and carries no role', () => {
    const session = beginStaffSession(REVIEWER, START);
    expect(session.kind).toBe('ACTIVE');
    // `14`: a staff role is never inferred from a client claim, and a role held in the session
    // would be exactly that. The console reads what the API says about this caller.
    expect(Object.keys(session)).not.toContain('role');
    expect(Object.keys(session)).not.toContain('roles');
  });

  it('starts with no step-up', () => {
    const session = beginStaffSession(REVIEWER, START);
    expect(hasFreshStepUp(session, START)).toBe(false);
  });

  it('names its authentication strength honestly', () => {
    const session = beginStaffSession(REVIEWER, START);
    if (session.kind !== 'ACTIVE') throw new Error('unreachable');
    expect(session.strength).toBe('DEVELOPMENT_HEADER');
  });
});

describe('expiry', () => {
  it('is active while it is young and recently used', () => {
    const session = beginStaffSession(REVIEWER, START);
    expect(staffSessionExpiry(session, at(60_000))).toBe('ACTIVE');
  });

  it('expires on absolute age even when it has just been used', () => {
    let session = beginStaffSession(REVIEWER, START);
    // Used continuously, so idle never triggers. The absolute bound is what stops a stolen
    // session living forever, and it has to be enforced independently to do that.
    session = touchStaffSession(session, at(STAFF_SESSION_MAX_AGE_MS));
    expect(staffSessionExpiry(session, at(STAFF_SESSION_MAX_AGE_MS))).toBe('EXPIRED_MAX_AGE');
  });

  it('expires on idle even when it is young', () => {
    const session = beginStaffSession(REVIEWER, START);
    expect(staffSessionExpiry(session, at(STAFF_SESSION_IDLE_MS))).toBe('EXPIRED_IDLE');
  });

  it('reports the two expiries separately, because they are different events', () => {
    expect(STAFF_SESSION_IDLE_MS).toBeLessThan(STAFF_SESSION_MAX_AGE_MS);
    const idle = staffSessionExpiry(beginStaffSession(REVIEWER, START), at(STAFF_SESSION_IDLE_MS));
    const old = staffSessionExpiry(
      touchStaffSession(beginStaffSession(REVIEWER, START), at(STAFF_SESSION_MAX_AGE_MS)),
      at(STAFF_SESSION_MAX_AGE_MS),
    );
    expect(idle).not.toBe(old);
  });

  it('moves the idle window when the session is used', () => {
    let session = beginStaffSession(REVIEWER, START);
    session = touchStaffSession(session, at(STAFF_SESSION_IDLE_MS - 1000));
    expect(staffSessionExpiry(session, at(STAFF_SESSION_IDLE_MS + 1000))).toBe('ACTIVE');
  });

  it('reports a signed-out session as signed out, not as expired', () => {
    expect(staffSessionExpiry(SIGNED_OUT, START)).toBe('SIGNED_OUT');
  });
});

describe('step-up', () => {
  it('is fresh immediately after it is recorded', () => {
    const session = recordStepUp(beginStaffSession(REVIEWER, START), START);
    expect(hasFreshStepUp(session, START)).toBe(true);
  });

  it('goes stale much sooner than the session does', () => {
    const session = recordStepUp(beginStaffSession(REVIEWER, START), START);
    expect(STAFF_STEP_UP_MAX_AGE_MS).toBeLessThan(STAFF_SESSION_IDLE_MS);
    expect(hasFreshStepUp(session, at(STAFF_STEP_UP_MAX_AGE_MS))).toBe(false);
    // The session itself is still perfectly usable. `14` asks for step-up *at* the publish, and a
    // step-up that lasted the session would be the control deleted and its name kept.
    expect(staffSessionExpiry(session, at(STAFF_STEP_UP_MAX_AGE_MS))).toBe('ACTIVE');
  });

  it('is never fresh on an expired session', () => {
    const session = recordStepUp(beginStaffSession(REVIEWER, START), START);
    expect(hasFreshStepUp(session, at(STAFF_SESSION_MAX_AGE_MS))).toBe(false);
  });
});

describe('headers', () => {
  it('carries the identity and no step-up by default', () => {
    const session = recordStepUp(beginStaffSession(REVIEWER, START), START);
    const headers = staffAuthHeaders(session, START);
    expect(headers).toEqual({ [STAFF_USER_HEADER]: REVIEWER });
    // Even with a fresh step-up available. Asserting it on every request would turn the gate into
    // decoration, exactly as the household client's comment says.
    expect(headers).not.toHaveProperty(STAFF_STEP_UP_HEADER);
  });

  it('carries step-up only when asked and only when fresh', () => {
    const session = recordStepUp(beginStaffSession(REVIEWER, START), START);
    expect(staffAuthHeaders(session, START, { stepUp: true })).toEqual({
      [STAFF_USER_HEADER]: REVIEWER,
      [STAFF_STEP_UP_HEADER]: '1',
    });
    expect(staffAuthHeaders(session, at(STAFF_STEP_UP_MAX_AGE_MS), { stepUp: true })).toBeNull();
  });

  it('produces nothing at all for an expired session', () => {
    const session = beginStaffSession(REVIEWER, START);
    expect(staffAuthHeaders(session, at(STAFF_SESSION_MAX_AGE_MS))).toBeNull();
  });

  it('produces nothing at all when signed out', () => {
    expect(staffAuthHeaders(SIGNED_OUT, START)).toBeNull();
  });
});

describe('the API origin', () => {
  it('accepts https anywhere', () => {
    expect(resolveStaffApiBaseUrl('https://reviewers.example.test/')).toBe(
      'https://reviewers.example.test',
    );
  });

  it('accepts plaintext only on loopback', () => {
    expect(resolveStaffApiBaseUrl('http://127.0.0.1:3100')).toBe('http://127.0.0.1:3100');
    expect(() => resolveStaffApiBaseUrl('http://reviewers.example.test')).toThrow(
      StaffConfigRefused,
    );
  });

  it('refuses credentials in the URL', () => {
    expect(() => resolveStaffApiBaseUrl('https://who:what@reviewers.example.test')).toThrow(
      StaffConfigRefused,
    );
  });

  it('refuses to run against the household API origin', () => {
    // The refusal this module exists for. A console on the phone's origin shares its cookies,
    // its CORS policy and its session, which is the opposite of what `13` asks for - and after
    // the surface split its requests would 404 in a way that reads as "the console is broken".
    expect(() => resolveStaffApiBaseUrl('http://127.0.0.1:3000', 'http://127.0.0.1:3000')).toThrow(
      /household API origin/,
    );
  });

  it('accepts a different port on the same host', () => {
    expect(resolveStaffApiBaseUrl('http://127.0.0.1:3100', 'http://127.0.0.1:3000')).toBe(
      'http://127.0.0.1:3100',
    );
  });

  it('refuses a development identity over a remote origin', () => {
    const session = beginStaffSession(REVIEWER, START);
    expect(() => {
      assertStaffSessionAllowed(session, 'https://reviewers.example.test');
    }).toThrow(StaffSessionRefused);
  });

  it('allows a development identity on loopback', () => {
    const session = beginStaffSession(REVIEWER, START);
    expect(() => {
      assertStaffSessionAllowed(session, 'http://127.0.0.1:3100');
    }).not.toThrow();
  });

  it('has a timeout that is a number of milliseconds', () => {
    expect(DEFAULT_STAFF_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('what the console must keep saying', () => {
  it('names the missing strong authentication for an active development session', () => {
    const codes = staffSessionWarnings(beginStaffSession(REVIEWER, START)).map((w) => w.code);
    expect(codes).toContain('NO_STRONG_AUTHENTICATION');
  });

  it('names the two blockers on every session, signed in or not', () => {
    for (const session of [SIGNED_OUT, beginStaffSession(REVIEWER, START)]) {
      const codes = staffSessionWarnings(session).map((w) => w.code);
      expect(codes).toContain('NO_QUALIFIED_REVIEWER');
      expect(codes).toContain('NOTHING_IS_PUBLISHABLE');
    }
  });

  it('never returns an empty list while the blockers are open', () => {
    // The point of returning these as data. A page cannot drop one by being redesigned, and this
    // test fails the day somebody makes the list conditional.
    expect(staffSessionWarnings(SIGNED_OUT).length).toBeGreaterThan(0);
    expect(staffSessionWarnings(beginStaffSession(REVIEWER, START)).length).toBeGreaterThan(0);
  });

  it('says the blocker identifiers, so the warning can be traced to a document', () => {
    const text = staffSessionWarnings(beginStaffSession(REVIEWER, START))
      .map((w) => w.text)
      .join(' ');
    expect(text).toContain('BLK-006');
    expect(text).toContain('BLK-004');
    expect(text).toContain('BLK-010');
  });
});
