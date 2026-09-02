import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import { createRequestContext } from './context.js';
import { dispatchAlert, recordingTransport } from './alertDelivery.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  CONSENT_POLICY_VERSION,
  CONSENT_PURPOSES,
  instantFrom,
  noopLogger,
  unsafeId,
  type Instant,
  type UserId,
} from '@kynviora/domain';

/**
 * `04` Phase 1.4, against a real engine.
 *
 * The exit criterion is "revoking optional consent disables the associated behavior", and it is
 * not satisfied by writing a row. What is asserted here is the behaviour: a person who withdraws
 * `NOTIFICATIONS` stops being a recipient, and an owner who withdraws `CAREGIVER_SHARING` stops
 * their caregivers being recipients - through the real dispatcher, against real rows.
 *
 * `consent_receipt` is append-only by trigger and refuses DELETE to **every** role, the database
 * owner included, so nothing here cleans up between tests. Each case uses its own user, which is
 * the honest way to test a table whose whole point is that history survives.
 */

const NOW = instantFrom('2026-09-02T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;

function principalFor(userId: string): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt: null };
}

/** A user nobody else in this file uses, so append-only history cannot leak between cases. */
let nextUser = 100;
async function freshUser(): Promise<string> {
  const id = testUuid((nextUser += 1));
  await t.asService((db) =>
    db.query(
      `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
       VALUES ($1, $2, $3, now())`,
      [id, `auth|${id}`, `${id}@example.test`],
    ),
  );
  return id;
}

beforeAll(async () => {
  t = await createTestDb();

  const pool: DatabasePool = {
    withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
    withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
  };

  app = createServer({
    surface: 'HOUSEHOLD',
    pool,
    logger: noopLogger(),
    authenticate: (_request: FastifyRequest) => Promise.resolve(currentPrincipal),
    now: (): Instant => NOW,
    loadSources: () => Promise.resolve(new Map()),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

interface StandingBody {
  readonly purpose: string;
  readonly granted: boolean;
  readonly everAnswered: boolean;
  readonly enforcement: string;
  readonly optional: boolean;
  readonly stale: boolean;
  readonly policyVersion: string | null;
}

interface ConsentsBody {
  readonly policyVersion: string;
  readonly consents: readonly StandingBody[];
}

interface WireBody {
  readonly error: { readonly code: string; readonly detail?: Record<string, unknown> };
}

const read = (as: Principal) => request(as, { method: 'GET', url: '/v1/consents' });

const decide = (as: Principal, payload: Record<string, unknown>) =>
  request(as, { method: 'PUT', url: '/v1/consents', payload });

describe('reading what is in force', () => {
  it('reports every purpose, unanswered, for somebody who has never chosen', async () => {
    const user = await freshUser();
    const body = (await read(principalFor(user))).json<ConsentsBody>();

    expect(body.policyVersion).toBe(CONSENT_POLICY_VERSION);
    expect(body.consents.map((c) => c.purpose)).toEqual([...CONSENT_PURPOSES]);
    for (const standing of body.consents) {
      // Deny by default (`14`). Silence is not agreement.
      expect(standing.granted, standing.purpose).toBe(false);
      expect(standing.everAnswered, standing.purpose).toBe(false);
      expect(standing.stale, standing.purpose).toBe(false);
    }
  });

  it('says which purposes actually stop something in this build', async () => {
    // `10`. A switch that stops nothing while the screen implies otherwise is worse than no
    // switch, so the server reports it rather than leaving a client to assume.
    const user = await freshUser();
    const body = (await read(principalFor(user))).json<ConsentsBody>();
    const by = new Map(body.consents.map((c) => [c.purpose, c]));

    expect(by.get('NOTIFICATIONS')?.enforcement).toBe('ENFORCED');
    expect(by.get('CAREGIVER_SHARING')?.enforcement).toBe('ENFORCED');
    expect(by.get('DIAGNOSTICS_ANALYTICS')?.enforcement).toBe('NOTHING_TO_STOP');
    expect(by.get('PROFILE_DATA')?.enforcement).toBe('REQUIRED');
    expect(by.get('PROFILE_DATA')?.optional).toBe(false);
  });

  it('shows only the caller’s own answers', async () => {
    // `consent_select` requires `user_id = current_user_id()`. Consent is the one thing nobody may
    // exercise or read on somebody else's behalf, which is why the route takes no user at all.
    const mine = await freshUser();
    const theirs = await freshUser();
    await decide(principalFor(mine), { purpose: 'NOTIFICATIONS', granted: true });

    const otherView = (await read(principalFor(theirs))).json<ConsentsBody>();
    expect(otherView.consents.find((c) => c.purpose === 'NOTIFICATIONS')?.everAnswered).toBe(false);
  });

  it('tells an unauthenticated caller nothing', async () => {
    expect((await request(null, { method: 'GET', url: '/v1/consents' })).statusCode).toBe(401);
  });
});

describe('recording a decision', () => {
  it('writes a receipt and reads it back as the standing answer', async () => {
    const user = await freshUser();
    const written = await decide(principalFor(user), {
      purpose: 'NOTIFICATIONS',
      granted: true,
      locale: 'ml-IN',
    });
    expect(written.statusCode).toBe(200);

    const standing = (await read(principalFor(user)))
      .json<ConsentsBody>()
      .consents.find((c) => c.purpose === 'NOTIFICATIONS');
    expect(standing?.granted).toBe(true);
    expect(standing?.everAnswered).toBe(true);
    expect(standing?.policyVersion).toBe(CONSENT_POLICY_VERSION);
  });

  it('withdraws by writing a new receipt, never by changing one', async () => {
    // `consent_receipt` is append-only by trigger. The history of what somebody agreed to and when
    // is not something a later version of this product can quietly rewrite.
    const user = await freshUser();
    await decide(principalFor(user), { purpose: 'NOTIFICATIONS', granted: true });
    await decide(principalFor(user), { purpose: 'NOTIFICATIONS', granted: false });

    const rows = await t.asService((db) =>
      db.query<{ granted: boolean; supersedes_id: string | null }>(
        `SELECT granted, supersedes_id FROM consent_receipt
          WHERE user_id = $1 AND purpose = 'NOTIFICATIONS'
          ORDER BY recorded_at`,
        [user],
      ),
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.granted).toBe(true);
    expect(rows.rows[1]?.granted).toBe(false);
    // The withdrawal points at what it replaced.
    expect(rows.rows[1]?.supersedes_id).not.toBeNull();

    const standing = (await read(principalFor(user)))
      .json<ConsentsBody>()
      .consents.find((c) => c.purpose === 'NOTIFICATIONS');
    expect(standing?.granted).toBe(false);
  });

  it('refuses to withdraw the purpose the product cannot run without', async () => {
    const user = await freshUser();
    const response = await decide(principalFor(user), {
      purpose: 'PROFILE_DATA',
      granted: false,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<WireBody>().error.detail?.['reason_code']).toBe('consent_required');
  });

  it('refuses a body naming a user, a policy version or a time', async () => {
    // `.strict()`. A client that could name the policy version could record agreement to a text
    // nobody showed them, and a client-set timestamp is an audit trail written by the audited.
    const user = await freshUser();
    for (const extra of [
      { userId: testUuid(1) },
      { policyVersion: '1999-01-01.1' },
      { recordedAt: '1999-01-01T00:00:00.000Z' },
    ]) {
      const response = await decide(principalFor(user), {
        purpose: 'NOTIFICATIONS',
        granted: true,
        ...extra,
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
  });

  it('records the decision in the audit log, and nothing about anybody’s health', async () => {
    const user = await freshUser();
    await decide(principalFor(user), { purpose: 'NOTIFICATIONS', granted: false });

    const audit = await t.asService((db) =>
      db.query<{ action: string; detail: Record<string, unknown> }>(
        `SELECT action, detail FROM audit_event
          WHERE actor_user_id = $1 AND target_kind = 'consent_receipt'`,
        [user],
      ),
    );
    expect(audit.rows[0]?.action).toBe('CONSENT_WITHDRAWN');
    expect(audit.rows[0]?.detail['purpose']).toBe('NOTIFICATIONS');
    expect(audit.rows[0]?.detail['policy_version']).toBe(CONSENT_POLICY_VERSION);
  });
});

describe('revoking consent disables the behaviour', () => {
  /**
   * The exit criterion, through the real dispatcher.
   *
   * Each case builds its own household so the append-only consent history of one cannot decide
   * another's outcome.
   */

  interface Household {
    readonly owner: string;
    readonly caregiver: string;
    readonly profileId: string;
  }

  async function household(): Promise<Household> {
    const owner = await freshUser();
    const caregiver = await freshUser();
    const householdId = testUuid((nextUser += 1));
    const profileId = testUuid((nextUser += 1));

    await t.asService(async (db) => {
      await db.query(
        `INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'H')`,
        [householdId, owner],
      );
      await db.query(
        `INSERT INTO profile (id, household_id, owner_user_id, display_name)
         VALUES ($1, $2, $3, 'Parent (synthetic)')`,
        [profileId, householdId, owner],
      );
      await db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, ARRAY['VIEW_SAFETY']::text[], 'ACTIVE', now())`,
        [profileId, caregiver, owner],
      );
    });

    return { owner, caregiver, profileId };
  }

  /** Everybody agrees, so the case can withdraw exactly one thing and see what changes. */
  async function grantAll(home: Household): Promise<void> {
    await t.asService(async (db) => {
      for (const userId of [home.owner, home.caregiver]) {
        for (const purpose of ['NOTIFICATIONS', 'CAREGIVER_SHARING']) {
          await db.query(
            `INSERT INTO consent_receipt (user_id, purpose, granted, policy_version)
             VALUES ($1, $2, true, $3)`,
            [userId, purpose, CONSENT_POLICY_VERSION],
          );
        }
      }
    });
  }

  async function dispatchFor(home: Household) {
    const transport = recordingTransport();
    const ctx = createRequestContext({
      principal: principalFor(home.owner),
      correlationId: 'consent-test',
      now: NOW,
      logger: noopLogger(),
      pool: {
        withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
        withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
      },
    });

    const result = await dispatchAlert(
      ctx,
      {
        profileId: home.profileId,
        eventKind: 'MISSED_DOSE',
        doseOccurrenceKey: `dose-${home.profileId}`,
        subject: { kind: 'MISSED_DOSE', profileDisplayName: 'Parent', itemDisplayName: 'Tablet' },
        // A missed dose is not a recall. `HIGH` would be the alarm optimisation `02` refuses.
        urgency: 'MEDIUM',
      },
      transport,
    );
    return { result, transport };
  }

  it('selects both people while both have agreed', async () => {
    const home = await household();
    await grantAll(home);
    // The caregiver needs the missed-dose capability to be a candidate at all.
    await t.asService((db) =>
      db.query(
        `UPDATE caregiver_grant SET capabilities = ARRAY['VIEW_SAFETY','RECEIVE_MISSED_DOSE']::text[]
          WHERE profile_id = $1`,
        [home.profileId],
      ),
    );

    const { result } = await dispatchFor(home);
    if (!result.ok) throw new Error('expected dispatch to succeed');
    expect(result.value.plan.recipients.map((r) => r.userId as string).sort()).toEqual(
      [home.owner, home.caregiver].sort(),
    );
  });

  it('stops notifications to the person who withdrew, owner included', async () => {
    // The owner is admitted by no capability and cannot be excluded by one - but consent is not a
    // capability. It is the basis on which Kynviora may contact them at all, so it applies to
    // them exactly as it applies to a caregiver.
    const home = await household();
    await grantAll(home);
    await decide(principalFor(home.owner), { purpose: 'NOTIFICATIONS', granted: false });

    const { result, transport } = await dispatchFor(home);
    if (!result.ok) throw new Error('expected dispatch to succeed');

    expect(result.value.plan.recipients.map((r) => r.userId as string)).not.toContain(home.owner);
    expect(
      result.value.plan.excluded.find((e) => (e.userId as string) === home.owner)?.reason,
    ).toBe('CONSENT_WITHDRAWN');
    expect(transport.sent.map((n) => n.userId as string)).not.toContain(home.owner);
  });

  it('stops caregivers when the owner withdraws sharing, and keeps telling the owner', async () => {
    // "Stop telling other people about me" is not "stop telling me".
    const home = await household();
    await grantAll(home);
    await t.asService((db) =>
      db.query(
        `UPDATE caregiver_grant SET capabilities = ARRAY['VIEW_SAFETY','RECEIVE_MISSED_DOSE']::text[]
          WHERE profile_id = $1`,
        [home.profileId],
      ),
    );
    await decide(principalFor(home.owner), { purpose: 'CAREGIVER_SHARING', granted: false });

    const { result } = await dispatchFor(home);
    if (!result.ok) throw new Error('expected dispatch to succeed');

    expect(result.value.plan.recipients.map((r) => r.userId as string)).toEqual([home.owner]);
    expect(
      result.value.plan.excluded.find((e) => (e.userId as string) === home.caregiver)?.reason,
    ).toBe('CAREGIVER_SHARING_WITHDRAWN');
  });

  it('reports withdrawal as its own reason, not as a missing capability', async () => {
    // The distinction is the point: the other reasons say a grant does not admit somebody, and
    // this says they asked not to be contacted. Putting a person who exercised a right into the
    // same audit bucket as one whose access was never wide enough would lose that.
    const home = await household();
    await grantAll(home);
    await decide(principalFor(home.caregiver), { purpose: 'NOTIFICATIONS', granted: false });

    const { result } = await dispatchFor(home);
    if (!result.ok) throw new Error('expected dispatch to succeed');
    const reason = result.value.plan.excluded.find(
      (e) => (e.userId as string) === home.caregiver,
    )?.reason;
    expect(reason).toBe('CONSENT_WITHDRAWN');
    expect(reason).not.toBe('CAPABILITY_MISSING');
  });

  it('sends to nobody who never answered at all', async () => {
    // No receipt is not consent. A household that has never been asked is not one Kynviora may
    // notify, which is the same rule the empty state reports.
    const home = await household();
    const { result, transport } = await dispatchFor(home);
    if (!result.ok) throw new Error('expected dispatch to succeed');
    expect(result.value.plan.recipients).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it('lets somebody change their mind back', async () => {
    const home = await household();
    await grantAll(home);
    await decide(principalFor(home.owner), { purpose: 'NOTIFICATIONS', granted: false });
    await decide(principalFor(home.owner), { purpose: 'NOTIFICATIONS', granted: true });

    const { result } = await dispatchFor(home);
    if (!result.ok) throw new Error('expected dispatch to succeed');
    expect(result.value.plan.recipients.map((r) => r.userId as string)).toContain(home.owner);
  });
});
