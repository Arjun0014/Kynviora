import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  ACTION_URGENCIES,
  MAX_CHANNEL_FOR_URGENCY,
  instantFrom,
  noopLogger,
  unsafeId,
  type Instant,
  type UserId,
} from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Phase 7.5 over the wire.
 *
 * Exit criterion 2 is what only a live route can prove: that the read which renders the alert
 * performs the revalidation, so a stale notification arrives at a screen with no actions on it.
 * The domain suite proves the decision; this proves nothing can reach the screen around it.
 */

const OWNER = testUuid(1);
const CAREGIVER = testUuid(2);
const STRANGER = testUuid(3);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const ITEM = testUuid(30);
const RULE = testUuid(60);

const NOTIFIED = instantFrom('2026-09-01T12:00:00.000Z');
const NOW = instantFrom('2026-09-03T12:00:00.000Z');
const CORRECTED_AFTER = instantFrom('2026-09-02T12:00:00.000Z');
const CORRECTED_BEFORE = instantFrom('2026-08-31T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;
let currentNow: Instant = NOW;
let alertCounter = 0;

function principalFor(userId: string, stepUp = false): Principal {
  return {
    userId: unsafeId<UserId>(userId),
    stepUpVerifiedAt: stepUp ? currentNow : null,
  };
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [CAREGIVER, 'caregiver@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
    await db.query(`INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'A')`, [
      HOUSEHOLD,
      OWNER,
    ]);
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent A (synthetic)')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet')`,
      [ITEM, PROFILE],
    );
    await db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id)
       VALUES ($1, 'synthetic.notify', '1.0.0', 'EXPIRY', 'A', 'HIGH',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.expiry')`,
      [RULE],
    );
  });

  const pool: DatabasePool = {
    withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
    withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
  };

  const sources: ReadonlyMap<string, SourceRegistryEntry> = new Map(
    ALL_FIXTURE_SOURCES.map((s) => [s.id, asApprovedSourceForTest(s)]),
  );

  app = createServer({
    surface: 'HOUSEHOLD',
    pool,
    logger: noopLogger(),
    authenticate: (_request: FastifyRequest) => Promise.resolve(currentPrincipal),
    now: () => currentNow,
    loadSources: () => Promise.resolve(sources),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

beforeEach(async () => {
  currentNow = NOW;
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM profile_notification_policy');
    await db.query('DELETE FROM caregiver_grant');
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

async function publishAlert(): Promise<{ alertId: string; assessmentId: string }> {
  alertCounter += 1;
  return t.asService(async (db) => {
    const assessment = await db.query<{ id: string }>(
      `INSERT INTO profile_assessment
         (profile_id, owned_item_id, rule_version_id, matched, match_confidence, reasons,
          evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at)
       VALUES ($1, $2, $3, true, 'EXACT', ARRAY['PRODUCT_EXPIRED']::text[], 'A', 'HIGH',
               'tpl.expiry', 'norm-1', $4)
       RETURNING id`,
      [PROFILE, ITEM, RULE, NOTIFIED],
    );
    const assessmentId = assessment.rows[0]?.id ?? '';
    const alert = await db.query<{ id: string }>(
      `INSERT INTO alert_publication (assessment_id, profile_id, published_at, dedupe_key)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [assessmentId, PROFILE, NOTIFIED, `notify-${String(alertCounter)}`],
    );
    return { alertId: alert.rows[0]?.id ?? '', assessmentId };
  });
}

async function correct(assessmentId: string, at: Instant): Promise<void> {
  await t.asService((db) =>
    db.query(
      `INSERT INTO assessment_correction
         (original_assessment_id, correction_kind, reason, corrected_at)
       VALUES ($1, 'RULE_CORRECTED', 'The rule matched on the wrong identifier.', $2)`,
      [assessmentId, at],
    ),
  );
}

interface DetailBody {
  readonly actions: readonly { readonly action: string }[];
  readonly actionsUnavailableBecause: string | null;
  readonly revalidationNotice: { readonly heading: string; readonly body: string } | null;
}

async function openAlert(as: Principal, alertId: string, notifiedAt?: Instant) {
  const query = notifiedAt === undefined ? '' : `?notifiedAt=${encodeURIComponent(notifiedAt)}`;
  return request(as, { method: 'GET', url: `/v1/alerts/${alertId}${query}` });
}

async function revalidationRows(alertId: string) {
  return t.asService((db) =>
    db.query<{ outcome: string; opened_by_user_id: string }>(
      `SELECT outcome, opened_by_user_id FROM notification_revalidation
        WHERE alert_publication_id = $1 ORDER BY revalidated_at, id`,
      [alertId],
    ),
  );
}

// ---------------------------------------------------------------------------

describe('exit criterion 2 - a stale notification arrives at a screen with no actions', () => {
  it('offers the correction action on an alert nothing has changed about', async () => {
    const { alertId } = await publishAlert();
    const body = (await openAlert(principalFor(OWNER), alertId, NOTIFIED)).json<DetailBody>();
    expect(body.actions.map((a) => a.action)).toEqual(['REPORT_INCORRECT_MATCH']);
    expect(body.actionsUnavailableBecause).toBeNull();
    // And says nothing. A screen announcing "still current" every time would train people to skip
    // the notice on the one occasion it says something else.
    expect(body.revalidationNotice).toBeNull();
  });

  it('withdraws them where a correction landed after the notification', async () => {
    const { alertId, assessmentId } = await publishAlert();
    await correct(assessmentId, CORRECTED_AFTER);

    const body = (await openAlert(principalFor(OWNER), alertId, NOTIFIED)).json<DetailBody>();
    // The criterion, on the read that renders the screen. A client cannot skip this and still act.
    expect(body.actions).toEqual([]);
    expect(body.actionsUnavailableBecause).toContain('has changed since the notification');
    expect(body.revalidationNotice?.heading).toContain('corrected something after it notified you');
  });

  it('leaves them where the correction predates it', async () => {
    const { alertId, assessmentId } = await publishAlert();
    await correct(assessmentId, CORRECTED_BEFORE);

    const body = (await openAlert(principalFor(OWNER), alertId, NOTIFIED)).json<DetailBody>();
    expect(body.actions.map((a) => a.action)).toEqual(['REPORT_INCORRECT_MATCH']);
    expect(body.revalidationNotice).toBeNull();
  });

  it('claims no notification for an alert opened from inside the app', async () => {
    const { alertId, assessmentId } = await publishAlert();
    await correct(assessmentId, CORRECTED_AFTER);

    // Saying "this changed since you were notified" to somebody who was never notified would be
    // inventing an event. The correction is still on the receipt, where it belongs.
    const body = (await openAlert(principalFor(OWNER), alertId)).json<DetailBody>();
    expect(body.actions.map((a) => a.action)).toEqual(['REPORT_INCORRECT_MATCH']);
    expect(body.revalidationNotice).toBeNull();
    expect((await revalidationRows(alertId)).rows).toEqual([]);
  });

  it('answers a withdrawn alert as absence rather than as a stale notice', async () => {
    const { alertId } = await publishAlert();
    await t.asService((db) =>
      db.query(
        `UPDATE alert_publication SET state = 'WITHDRAWN', withdrawn_at = $2,
                withdrawn_reason = 'synthetic' WHERE id = $1`,
        [alertId, NOW],
      ),
    );
    // `alert_publication`'s policy admits PUBLISHED only, so the withdrawn half of the criterion
    // is enforced by the row never arriving. A caller cannot tell that from having lost access,
    // and the server is deliberately not willing to say (DEC-039).
    expect((await openAlert(principalFor(OWNER), alertId, NOTIFIED)).statusCode).toBe(404);
  });

  it('refuses a malformed notifiedAt rather than ignoring it', async () => {
    const { alertId } = await publishAlert();
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/alerts/${alertId}?notifiedAt=yesterday`,
    });
    // Ignoring it would silently downgrade a revalidating read into an ordinary one, which is the
    // one failure mode this criterion cannot have.
    expect(response.statusCode).toBe(400);
  });
});

describe('what the revalidation records', () => {
  it('records one row per open from a notification, and none otherwise', async () => {
    const { alertId } = await publishAlert();
    await openAlert(principalFor(OWNER), alertId);
    expect((await revalidationRows(alertId)).rows).toEqual([]);

    await openAlert(principalFor(OWNER), alertId, NOTIFIED);
    const rows = (await revalidationRows(alertId)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('STILL_CURRENT');
    expect(rows[0]?.opened_by_user_id).toBe(OWNER);
  });

  it('records the outcome that actually applied', async () => {
    const { alertId, assessmentId } = await publishAlert();
    await correct(assessmentId, CORRECTED_AFTER);
    await openAlert(principalFor(OWNER), alertId, NOTIFIED);
    expect((await revalidationRows(alertId)).rows[0]?.outcome).toBe('CORRECTED_SINCE_NOTIFICATION');
  });

  it('records nothing for a caller who could not read the alert', async () => {
    const { alertId } = await publishAlert();
    expect((await openAlert(principalFor(STRANGER), alertId, NOTIFIED)).statusCode).toBe(404);
    // The read under row-level security is the authorization; a refused read must leave no trace
    // that would confirm the alert exists.
    expect((await revalidationRows(alertId)).rows).toEqual([]);
  });

  it('does not let a caregiver disarm an owner controls by revalidating', async () => {
    await t.asService((db) =>
      db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, ARRAY['VIEW_SAFETY']::text[], 'ACTIVE', now())`,
        [PROFILE, CAREGIVER, OWNER],
      ),
    );
    const { alertId } = await publishAlert();

    // A revalidation is about one person's own notification. It writes a record and changes
    // nothing on the alert, so the owner's own read is unaffected by anybody else's.
    await openAlert(principalFor(CAREGIVER), alertId, NOTIFIED);
    const body = (await openAlert(principalFor(OWNER), alertId, NOTIFIED)).json<DetailBody>();
    expect(body.actions.map((a) => a.action)).toEqual(['REPORT_INCORRECT_MATCH']);
  });
});

describe('the notification settings a person can read', () => {
  interface SettingsBody {
    readonly quietHours: { readonly startMinute: number; readonly endMinute: number } | null;
    readonly quietHoursLabel: string | null;
    readonly quietHoursCopy: { readonly exception: string; readonly notSet: string };
    readonly urgencyChannels: readonly {
      readonly urgency: string;
      readonly channelLabel: string;
    }[];
  }

  async function settings(as: Principal) {
    return request(as, {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/notification-settings`,
    });
  }

  async function setPolicy(as: Principal, body: Record<string, unknown>) {
    return request(as, {
      method: 'PUT',
      url: `/v1/profiles/${PROFILE}/notification-policy`,
      payload: body,
    });
  }

  it('says no quiet hours are set, rather than showing a blank', async () => {
    const body = (await settings(principalFor(OWNER))).json<SettingsBody>();
    expect(body.quietHours).toBeNull();
    expect(body.quietHoursLabel).toBeNull();
    expect(body.quietHoursCopy.notSet).toContain('any time');
  });

  it('explains what every urgency does, from the domain ceiling', async () => {
    const body = (await settings(principalFor(OWNER))).json<SettingsBody>();
    expect(body.urgencyChannels.map((line) => line.urgency)).toEqual([...ACTION_URGENCIES]);
    // Read from the domain rather than restated, so a screen cannot describe a policy the server
    // does not have.
    for (const line of body.urgencyChannels) {
      expect(line.channelLabel.length).toBeGreaterThan(0);
    }
    const informational = body.urgencyChannels.find((l) => l.urgency === 'INFORMATIONAL');
    expect(informational?.channelLabel).toBe(
      // Exit criterion 1 as the sentence a person actually reads.
      'Kept in the app only',
    );
    expect(MAX_CHANNEL_FOR_URGENCY.INFORMATIONAL).toBe('IN_APP_ONLY');
  });

  it('says out loud that a critical alert still arrives', async () => {
    const body = (await settings(principalFor(OWNER))).json<SettingsBody>();
    // A person who believed quiet hours silenced everything would be relying on Kynviora for
    // something it will not do.
    expect(body.quietHoursCopy.exception).toContain('critical safety alert is still sent');
  });

  it('lets the owner set a window, with step-up', async () => {
    const response = await setPolicy(principalFor(OWNER, true), {
      maxCaregiverDetail: 'GENERIC',
      quietHoursStartMinute: 22 * 60,
      quietHoursEndMinute: 7 * 60,
    });
    expect(response.statusCode).toBe(200);

    const body = (await settings(principalFor(OWNER))).json<SettingsBody>();
    expect(body.quietHours).toEqual({ startMinute: 1320, endMinute: 420 });
    expect(body.quietHoursLabel).toBe('22:00 to 07:00');
  });

  it('refuses one bound alone', async () => {
    const response = await setPolicy(principalFor(OWNER, true), {
      maxCaregiverDetail: 'GENERIC',
      quietHoursStartMinute: 22 * 60,
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses equal bounds', async () => {
    const response = await setPolicy(principalFor(OWNER, true), {
      maxCaregiverDetail: 'GENERIC',
      quietHoursStartMinute: 600,
      quietHoursEndMinute: 600,
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a minute outside the day', async () => {
    for (const start of [-1, 1440]) {
      const response = await setPolicy(principalFor(OWNER, true), {
        maxCaregiverDetail: 'GENERIC',
        quietHoursStartMinute: start,
        quietHoursEndMinute: 60,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('still requires step-up and ownership', async () => {
    expect(
      (
        await setPolicy(principalFor(OWNER), {
          maxCaregiverDetail: 'GENERIC',
          quietHoursStartMinute: 0,
          quietHoursEndMinute: 60,
        })
      ).statusCode,
    ).not.toBe(200);

    await t.asService((db) =>
      db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, ARRAY['VIEW_SAFETY','MANAGE_CAREGIVERS']::text[], 'ACTIVE', now())`,
        [PROFILE, CAREGIVER, OWNER],
      ),
    );
    // MANAGE_CAREGIVERS deliberately does not carry this, and adding quiet hours to the same
    // route must not have quietly changed that.
    expect(
      (
        await setPolicy(principalFor(CAREGIVER, true), {
          maxCaregiverDetail: 'NAMED',
          quietHoursStartMinute: 0,
          quietHoursEndMinute: 60,
        })
      ).statusCode,
    ).not.toBe(200);
  });

  it('keeps no medicine or subject in the audit detail', async () => {
    await setPolicy(principalFor(OWNER, true), {
      maxCaregiverDetail: 'GENERIC',
      quietHoursStartMinute: 22 * 60,
      quietHoursEndMinute: 7 * 60,
    });
    const events = await t.asService((db) =>
      db.query<{ detail: unknown }>(
        `SELECT detail FROM audit_event WHERE action = 'notification.policy.changed'
          ORDER BY occurred_at DESC LIMIT 1`,
      ),
    );
    const detail = JSON.stringify(events.rows[0]?.detail);
    // Whether a window exists, not when it is: a person's sleeping hours are a fact about them,
    // and `14` keeps what it does not need out of a log.
    expect(detail).toContain('quiet_hours_set');
    expect(detail).not.toContain('1320');
  });
});
