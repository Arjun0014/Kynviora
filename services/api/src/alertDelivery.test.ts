import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import { createRequestContext } from './context.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { dispatchAlert, recordingTransport } from './alertDelivery.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Caregiver alert delivery, end to end (spec 04 Phase 8.2).
 *
 * The phase exit criterion is that caregiver access is testable through deny-by-default
 * authorization cases, so the bulk of this file is negative and runs against the real database
 * with row-level security in force as the non-superuser `kynviora_app` role. The domain suite
 * already covers the decision logic; what is asserted here is that the live flow - RLS, the
 * privileged dispatch, and the column-level narrowing of a resolution - agrees with it.
 */

const OWNER = testUuid(1);
const OTHER_OWNER = testUuid(2);
const SAFETY_CAREGIVER = testUuid(3);
const DOSE_CAREGIVER = testUuid(4);
const SHELF_CAREGIVER = testUuid(5);
const STRANGER = testUuid(6);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);
const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

const ITEM_A = testUuid(30);
const RULE_V = testUuid(40);
const ASSESSMENT = testUuid(41);
const ALERT = testUuid(42);
const WITHDRAWN_ALERT = testUuid(43);
const ASSESSMENT_2 = testUuid(44);

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

const PERSON = 'Parent A (synthetic)';
const MEDICINE = 'Synthetic Tablet A';

let t: TestDb;
let app: FastifyInstance;
let pool: DatabasePool;
let currentPrincipal: Principal | null = null;
let currentNow: Instant = NOW;

function principalFor(userId: string, steppedUp = false): Principal {
  return {
    userId: unsafeId<UserId>(userId),
    stepUpVerifiedAt: steppedUp ? currentNow : null,
  };
}

const OWNER_STEPPED_UP = () => principalFor(OWNER, true);

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER_OWNER, 'other@example.test'],
      [SAFETY_CAREGIVER, 'safety@example.test'],
      [DOSE_CAREGIVER, 'dose@example.test'],
      [SHELF_CAREGIVER, 'shelf@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }

    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name)
       VALUES ($1, $2, 'A'), ($3, $4, 'B')`,
      [HOUSEHOLD_A, OWNER, HOUSEHOLD_B, OTHER_OWNER],
    );

    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, $4), ($5, $6, $7, 'Parent B (synthetic)')`,
      [PROFILE_A, HOUSEHOLD_A, OWNER, PERSON, PROFILE_B, HOUSEHOLD_B, OTHER_OWNER],
    );

    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, strength_text, dosage_form)
       VALUES ($1, $2, 'MEDICINE', $3, '500 mg', 'tablet')`,
      [ITEM_A, PROFILE_A, MEDICINE],
    );

    // A published alert needs a rule version and an assessment behind it. These are synthetic and
    // deliberately shadow-free; nothing here publishes a real safety rule (BLK-006).
    await db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id)
       VALUES ($1, 'synthetic.test', '1.0.0', 'EXPIRY', 'C', 'MEDIUM',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_REPORTED']::text[], 'tpl.synthetic')`,
      [RULE_V],
    );

    for (const [assessmentId, alertId, state] of [
      [ASSESSMENT, ALERT, 'PUBLISHED'],
      [ASSESSMENT_2, WITHDRAWN_ALERT, 'WITHDRAWN'],
    ] as const) {
      await db.query(
        `INSERT INTO profile_assessment
           (id, profile_id, owned_item_id, rule_version_id, matched, match_confidence,
            evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at)
         VALUES ($1, $2, $3, $4, true, 'EXACT', 'C', 'MEDIUM', 'tpl.synthetic', '1.0.0', $5)`,
        [assessmentId, PROFILE_A, ITEM_A, RULE_V, NOW],
      );
      await db.query(
        `INSERT INTO alert_publication
           (id, assessment_id, profile_id, state, published_at, dedupe_key, withdrawn_at,
            withdrawn_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          alertId,
          assessmentId,
          PROFILE_A,
          state,
          NOW,
          `dedupe-${alertId}`,
          state === 'WITHDRAWN' ? NOW : null,
          state === 'WITHDRAWN' ? 'synthetic withdrawal for test' : null,
        ],
      );
    }
  });

  pool = {
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
  // audit_event is deliberately not cleared: the append-only trigger refuses a DELETE (DEC-013).
  // alert_delivery is append-only for the same reason, so it is cleared by the service role only
  // where a test needs a clean dispatch - see resetDeliveries.
  // Cleared as the database owner, not the service role: kynviora_service deliberately holds no
  // DELETE on caregiver_grant, because a grant is revoked rather than deleted.
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM caregiver_grant');
    await db.query('DELETE FROM notification_preference');
    await db.query('DELETE FROM profile_notification_policy');
    await db.query('DELETE FROM safety_receipt');
  });
});

/** alert_delivery has an append-only trigger; the service role drops the trigger's guard by
 *  truncating instead, which is permitted because TRUNCATE is not an UPDATE or DELETE. */
async function resetDeliveries() {
  await t.asOwner((db) => db.query('TRUNCATE alert_delivery'));
}

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  try {
    return await app.inject(options);
  } finally {
    currentPrincipal = null;
  }
}

async function grant(
  userId: string,
  capabilities: string[],
  overrides: { profileId?: string; accepted?: boolean; expiresAt?: string | null } = {},
) {
  await t.asService((db) =>
    db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at,
          expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        overrides.profileId ?? PROFILE_A,
        userId,
        OWNER,
        capabilities,
        (overrides.accepted ?? true) ? 'ACTIVE' : 'PENDING',
        (overrides.accepted ?? true) ? NOW : null,
        overrides.expiresAt ?? null,
      ],
    ),
  );
}

/** Build a context for the dispatch function, which deliberately has no route. */
function contextFor(userId: string) {
  return createRequestContext({
    pool,
    principal: principalFor(userId),
    correlationId: 'test-correlation',
    now: currentNow,
    logger: noopLogger(),
  });
}

async function dispatchSafety(alertId: string = ALERT) {
  const transport = recordingTransport();
  const result = await dispatchAlert(
    contextFor(OWNER),
    {
      profileId: PROFILE_A,
      eventKind: 'SAFETY_ALERT',
      alertPublicationId: alertId,
      subject: { kind: 'SAFETY_ALERT', profileDisplayName: PERSON, itemDisplayName: MEDICINE },
    },
    transport,
  );
  return { result, transport };
}

async function setPolicy(level: string) {
  const response = await request(OWNER_STEPPED_UP(), {
    method: 'PUT',
    url: `/v1/profiles/${PROFILE_A}/notification-policy`,
    payload: { maxCaregiverDetail: level },
  });
  expect(response.statusCode).toBe(200);
}

async function setPreference(userId: string, level: string) {
  return request(principalFor(userId), {
    method: 'PUT',
    url: `/v1/profiles/${PROFILE_A}/notification-preference`,
    payload: { detailLevel: level },
  });
}

// ---------------------------------------------------------------------------

describe('dispatch: who is told', () => {
  it('tells the owner and a caregiver holding VIEW_SAFETY', async () => {
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);

    const { result } = await dispatchSafety();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(result.value.plan.recipients.map((r) => r.userId))).toEqual(
      new Set([OWNER, SAFETY_CAREGIVER]),
    );
  });

  it('does not tell a caregiver who holds only shelf and medicine access', async () => {
    // 03 group H: safety alerts are a separate permission from the shelf and the medicines.
    await resetDeliveries();
    await grant(SHELF_CAREGIVER, ['VIEW_SHELF', 'VIEW_MEDICINES']);

    const { result } = await dispatchSafety();
    if (!result.ok) throw new Error('expected dispatch to succeed');
    expect(result.value.plan.recipients.map((r) => r.userId)).not.toContain(SHELF_CAREGIVER);
    expect(result.value.plan.excluded).toContainEqual({
      userId: SHELF_CAREGIVER,
      reason: 'CAPABILITY_MISSING',
    });
  });

  it('does not tell a caregiver whose grant is still pending', async () => {
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY'], { accepted: false });

    const { result } = await dispatchSafety();
    if (!result.ok) throw new Error('expected dispatch to succeed');
    expect(result.value.plan.excluded).toContainEqual({
      userId: SAFETY_CAREGIVER,
      reason: 'GRANT_NOT_ACCEPTED',
    });
  });

  it('does not tell a caregiver whose grant has expired', async () => {
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY'], { expiresAt: '2026-08-29T11:00:00.000Z' });

    const { result } = await dispatchSafety();
    if (!result.ok) throw new Error('expected dispatch to succeed');
    expect(result.value.plan.excluded).toContainEqual({
      userId: SAFETY_CAREGIVER,
      reason: 'GRANT_EXPIRED',
    });
  });

  it('does not tell a caregiver of another household', async () => {
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY'], { profileId: PROFILE_B });

    const { result } = await dispatchSafety();
    if (!result.ok) throw new Error('expected dispatch to succeed');
    expect(result.value.plan.recipients.map((r) => r.userId)).toEqual([OWNER]);
    expect(result.value.plan.excluded).toEqual([]);
  });

  it('refuses to deliver a withdrawn alert', async () => {
    // 19 lists "stale withdrawn alert still actionable" as a release-blocking defect class, and a
    // notification is the least revocable form of actionable.
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);

    const { result, transport } = await dispatchSafety(WITHDRAWN_ALERT);
    expect(result.ok).toBe(false);
    expect(transport.sent).toEqual([]);

    const rows = await t.asService((db) => db.query('SELECT id FROM alert_delivery'));
    expect(rows.rows).toEqual([]);
  });

  it('refuses when the alert belongs to a different profile than the one named', async () => {
    await resetDeliveries();
    const transport = recordingTransport();
    const result = await dispatchAlert(
      contextFor(OWNER),
      {
        profileId: PROFILE_B,
        eventKind: 'SAFETY_ALERT',
        alertPublicationId: ALERT,
        subject: { kind: 'SAFETY_ALERT', profileDisplayName: PERSON, itemDisplayName: MEDICINE },
      },
      transport,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toMatchObject({ reason_code: 'alert_profile_mismatch' });
    }
    expect(transport.sent).toEqual([]);
  });
});

describe('dispatch: missed dose is a separate permission', () => {
  async function dispatchMissedDose(key = 'occurrence-1') {
    const transport = recordingTransport();
    const result = await dispatchAlert(
      contextFor(OWNER),
      {
        profileId: PROFILE_A,
        eventKind: 'MISSED_DOSE',
        doseOccurrenceKey: key,
        subject: { kind: 'MISSED_DOSE', profileDisplayName: PERSON, itemDisplayName: MEDICINE },
      },
      transport,
    );
    return { result, transport };
  }

  it('tells a caregiver holding RECEIVE_MISSED_DOSE', async () => {
    await resetDeliveries();
    await grant(DOSE_CAREGIVER, ['RECEIVE_MISSED_DOSE']);

    const { result } = await dispatchMissedDose();
    if (!result.ok) throw new Error('expected dispatch to succeed');
    expect(result.value.plan.recipients.map((r) => r.userId)).toContain(DOSE_CAREGIVER);
  });

  it('does not tell a caregiver who holds only VIEW_SAFETY', async () => {
    // A caregiver watching for a recall is not entitled to adherence information.
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);

    const { result } = await dispatchMissedDose();
    if (!result.ok) throw new Error('expected dispatch to succeed');
    expect(result.value.plan.recipients.map((r) => r.userId)).not.toContain(SAFETY_CAREGIVER);
    expect(result.value.plan.excluded).toContainEqual({
      userId: SAFETY_CAREGIVER,
      reason: 'CAPABILITY_MISSING',
    });
  });

  it('requires an occurrence key, so a repeat cannot silently re-notify', async () => {
    const transport = recordingTransport();
    const result = await dispatchAlert(
      contextFor(OWNER),
      {
        profileId: PROFILE_A,
        eventKind: 'MISSED_DOSE',
        subject: { kind: 'MISSED_DOSE', profileDisplayName: PERSON, itemDisplayName: MEDICINE },
      },
      transport,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toMatchObject({ reason_code: 'occurrence_key_required' });
    }
  });
});

describe('dispatch: deduplication', () => {
  it('does not notify the same person twice for the same alert', async () => {
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);

    const first = await dispatchSafety();
    expect(first.transport.sent).toHaveLength(2);

    const second = await dispatchSafety();
    expect(second.transport.sent).toEqual([]);
    if (!second.result.ok) throw new Error('expected dispatch to succeed');
    expect(new Set(second.result.value.alreadyDelivered)).toEqual(
      new Set([OWNER, SAFETY_CAREGIVER]),
    );
  });

  it('still notifies a caregiver added after the first dispatch', async () => {
    // Deduplication is per recipient, not per alert: a grant accepted after the first send must
    // not be silently skipped because somebody else was already told.
    await resetDeliveries();
    await dispatchSafety();

    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    const second = await dispatchSafety();
    expect(second.transport.sent.map((n) => n.userId)).toEqual([SAFETY_CAREGIVER]);
  });
});

describe('dispatch: what is written down', () => {
  it('records the level but never the notification body', async () => {
    // 15 A6 is about the exact string a locked device shows. Storing it would put that string in
    // a durable table with a different access path from the alert it describes.
    await resetDeliveries();
    await setPolicy('NAMED');
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    await setPreference(SAFETY_CAREGIVER, 'NAMED');

    const { transport } = await dispatchSafety();
    expect(transport.sent.some((n) => n.body.includes(MEDICINE))).toBe(true);

    const dump = await t.asService((db) =>
      db.query<Record<string, unknown>>('SELECT * FROM alert_delivery'),
    );
    const serialized = JSON.stringify(dump.rows);
    expect(serialized).not.toContain(MEDICINE);
    expect(serialized).not.toContain(PERSON);
    expect(serialized).toContain('NAMED');
  });

  it('writes an audit event carrying counts but no recipient identity', async () => {
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    await dispatchSafety();

    const events = await t.asService((db) =>
      db.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_event
          WHERE action = 'alert.delivery.dispatched' AND target_id = $1`,
        [ALERT],
      ),
    );
    expect(events.rows.length).toBeGreaterThan(0);
    const detail = JSON.stringify(events.rows[0]?.detail);
    expect(detail).toContain('recipient_count');
    expect(detail).not.toContain(SAFETY_CAREGIVER);
    expect(detail).not.toContain(MEDICINE);
  });

  it('records the delivery before handing it to the transport', async () => {
    // A transport that throws must leave a recorded delivery, not an un-recorded arrival. The
    // opposite ordering re-notifies on the next run.
    await resetDeliveries();
    const throwing = {
      send: () => Promise.reject(new Error('transport unavailable')),
    };
    await expect(
      dispatchAlert(
        contextFor(OWNER),
        {
          profileId: PROFILE_A,
          eventKind: 'SAFETY_ALERT',
          alertPublicationId: ALERT,
          subject: { kind: 'SAFETY_ALERT', profileDisplayName: PERSON, itemDisplayName: MEDICINE },
        },
        throwing,
      ),
    ).rejects.toThrow();

    const rows = await t.asService((db) =>
      db.query('SELECT id FROM alert_delivery WHERE alert_publication_id = $1', [ALERT]),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
  });
});

describe('disclosure level through the live flow', () => {
  it('is generic by default, with no policy and no preference', async () => {
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);

    const { transport } = await dispatchSafety();
    for (const notification of transport.sent) {
      expect(notification.revealsSubject).toBe(false);
      expect(notification.body).not.toContain(MEDICINE);
      expect(notification.body).not.toContain(PERSON);
    }
  });

  it('caps a caregiver preference at the owner ceiling', async () => {
    await resetDeliveries();
    await setPolicy('CATEGORY');
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    expect((await setPreference(SAFETY_CAREGIVER, 'NAMED')).statusCode).toBe(200);

    const { transport } = await dispatchSafety();
    const toCaregiver = transport.sent.find((n) => n.userId === SAFETY_CAREGIVER);
    expect(toCaregiver?.detailLevel).toBe('CATEGORY');
    expect(toCaregiver?.body).not.toContain(MEDICINE);
  });

  it('does not cap the owner at the caregiver ceiling', async () => {
    await resetDeliveries();
    await setPolicy('GENERIC');
    expect((await setPreference(OWNER, 'NAMED')).statusCode).toBe(200);

    const { transport } = await dispatchSafety();
    const toOwner = transport.sent.find((n) => n.userId === OWNER);
    expect(toOwner?.detailLevel).toBe('NAMED');
  });
});

describe('notification settings endpoint', () => {
  it('explains that the owner ceiling is what reduced the level', async () => {
    // 16 requires grant capabilities to be human-readable; a setting whose effect the holder
    // cannot see is the same problem.
    await setPolicy('GENERIC');
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    await setPreference(SAFETY_CAREGIVER, 'NAMED');

    const response = await request(principalFor(SAFETY_CAREGIVER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/notification-settings`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      relationship: 'CAREGIVER',
      maxCaregiverDetail: 'GENERIC',
      myPreference: 'NAMED',
      effectiveDetail: 'GENERIC',
      cappedByOwner: true,
    });
  });

  it('distinguishes never having chosen from having chosen generic', async () => {
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);

    const before = await request(principalFor(SAFETY_CAREGIVER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/notification-settings`,
    });
    expect(before.json()).toMatchObject({ myPreference: null, effectiveDetail: 'GENERIC' });

    await setPreference(SAFETY_CAREGIVER, 'GENERIC');
    const after = await request(principalFor(SAFETY_CAREGIVER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/notification-settings`,
    });
    expect(after.json()).toMatchObject({ myPreference: 'GENERIC' });
  });

  it('refuses a stranger, and does not confirm the profile exists', async () => {
    // PERMISSION_DENIED renders as 404 by design, so the endpoint is not an existence oracle for
    // profile IDs. A real profile and an invented one must be indistinguishable.
    const real = await request(principalFor(STRANGER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/notification-settings`,
    });
    const invented = await request(principalFor(STRANGER), {
      method: 'GET',
      url: `/v1/profiles/${testUuid(99)}/notification-settings`,
    });

    expect(real.statusCode).toBe(404);
    expect(invented.statusCode).toBe(404);
    const strip = (body: string) => body.replace(/"correlationId":"[^"]+"/, '');
    expect(strip(real.body)).toBe(strip(invented.body));
  });
});

describe('setting your own preference', () => {
  it('refuses someone with no relationship to the profile', async () => {
    // The INSERT policy requires both that the row is yours and that you receive notifications
    // for this profile, so a stranger cannot leave a preference row behind.
    const response = await setPreference(STRANGER, 'NAMED');
    // 404 rather than 403: PERMISSION_DENIED renders as "not found" so the endpoint cannot be
    // used to enumerate profile IDs.
    expect(response.statusCode).toBe(404);

    const rows = await t.asService((db) =>
      db.query('SELECT id FROM notification_preference WHERE user_id = $1', [STRANGER]),
    );
    expect(rows.rows).toEqual([]);
  });

  it('refuses a caregiver holding no notification-bearing capability', async () => {
    await grant(SHELF_CAREGIVER, ['VIEW_SHELF']);
    const response = await setPreference(SHELF_CAREGIVER, 'NAMED');
    expect(response.statusCode).toBe(404);
  });

  it('is idempotent and updates in place rather than accumulating rows', async () => {
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    expect((await setPreference(SAFETY_CAREGIVER, 'NAMED')).statusCode).toBe(200);
    expect((await setPreference(SAFETY_CAREGIVER, 'CATEGORY')).statusCode).toBe(200);

    const rows = await t.asService((db) =>
      db.query<{ detail_level: string }>(
        'SELECT detail_level FROM notification_preference WHERE user_id = $1',
        [SAFETY_CAREGIVER],
      ),
    );
    expect(rows.rows).toEqual([{ detail_level: 'CATEGORY' }]);
  });

  it('rejects a level outside the vocabulary', async () => {
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    const response = await setPreference(SAFETY_CAREGIVER, 'EVERYTHING');
    expect(response.statusCode).toBe(400);
  });
});

describe('setting the owner ceiling', () => {
  it('requires step-up', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'PUT',
      url: `/v1/profiles/${PROFILE_A}/notification-policy`,
      payload: { maxCaregiverDetail: 'NAMED' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
  });

  it('refuses a caregiver, even one who can manage caregivers', async () => {
    // A caregiver administrator who could raise the ceiling would change what every other
    // caregiver receives without the owner observing it - the escalation DEC-020 refuses for
    // delegation.
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY', 'MANAGE_CAREGIVERS']);

    const response = await request(principalFor(SAFETY_CAREGIVER, true), {
      method: 'PUT',
      url: `/v1/profiles/${PROFILE_A}/notification-policy`,
      payload: { maxCaregiverDetail: 'NAMED' },
    });
    expect(response.statusCode).toBe(404);

    const rows = await t.asService((db) =>
      db.query('SELECT profile_id FROM profile_notification_policy'),
    );
    expect(rows.rows).toEqual([]);
  });

  it('lets the owner raise and lower it, taking effect on the next dispatch', async () => {
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    await setPreference(SAFETY_CAREGIVER, 'NAMED');

    await setPolicy('NAMED');
    const raised = await dispatchSafety();
    expect(raised.transport.sent.find((n) => n.userId === SAFETY_CAREGIVER)?.detailLevel).toBe(
      'NAMED',
    );

    await resetDeliveries();
    await setPolicy('GENERIC');
    const lowered = await dispatchSafety();
    expect(lowered.transport.sent.find((n) => n.userId === SAFETY_CAREGIVER)?.detailLevel).toBe(
      'GENERIC',
    );
  });
});

describe('caregiver view of resolution state', () => {
  async function resolve(note: string) {
    await t.asService((db) =>
      db.query(
        `INSERT INTO safety_receipt
           (profile_id, alert_publication_id, assessment_id, resolution, resolution_note,
            resolved_at, resolved_by_user_id)
         VALUES ($1, $2, $3, 'REVIEWED', $4, $5, $6)`,
        [PROFILE_A, ALERT, ASSESSMENT, note, NOW, OWNER],
      ),
    );
  }

  it('shows the owner the resolution note', async () => {
    await resolve('Spoke to the pharmacist about this one.');
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/alerts`,
    });
    expect(response.statusCode).toBe(200);
    const alert = response
      .json<{ alerts: { alertId: string; resolutionNote: string | null }[] }>()
      .alerts.find((a) => a.alertId === ALERT);
    expect(alert?.resolutionNote).toBe('Spoke to the pharmacist about this one.');
  });

  it('shows a caregiver the outcome but withholds the note, and says it withheld it', async () => {
    await resolve('Spoke to the pharmacist about this one.');
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);

    const response = await request(principalFor(SAFETY_CAREGIVER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/alerts`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      alerts: {
        alertId: string;
        resolution: string | null;
        resolutionNote: string | null;
        resolutionNoteWithheld: boolean;
      }[];
    }>();
    const alert = body.alerts.find((a) => a.alertId === ALERT);
    expect(alert?.resolution).toBe('REVIEWED');
    expect(alert?.resolutionNote).toBeNull();
    expect(alert?.resolutionNoteWithheld).toBe(true);
    expect(response.body).not.toContain('pharmacist');
  });

  it('never lists a withdrawn alert to a caregiver', async () => {
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    const response = await request(principalFor(SAFETY_CAREGIVER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/alerts`,
    });
    const ids = response.json<{ alerts: { alertId: string }[] }>().alerts.map((a) => a.alertId);
    expect(ids).toContain(ALERT);
    expect(ids).not.toContain(WITHDRAWN_ALERT);
  });

  it('shows nothing to a caregiver without VIEW_SAFETY', async () => {
    await grant(SHELF_CAREGIVER, ['VIEW_SHELF', 'VIEW_MEDICINES']);
    const response = await request(principalFor(SHELF_CAREGIVER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/alerts`,
    });
    expect(response.json<{ alerts: unknown[] }>().alerts).toEqual([]);
  });

  it('shows nothing to a stranger', async () => {
    const response = await request(principalFor(STRANGER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/alerts`,
    });
    expect(response.json<{ alerts: unknown[] }>().alerts).toEqual([]);
  });
});

describe('delivery history', () => {
  it('shows the owner every delivery for their profile', async () => {
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    await dispatchSafety();

    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/alert-deliveries`,
    });
    const recipients = response
      .json<{ deliveries: { recipientUserId: string }[] }>()
      .deliveries.map((d) => d.recipientUserId);
    expect(new Set(recipients)).toEqual(new Set([OWNER, SAFETY_CAREGIVER]));
  });

  it('shows a caregiver only their own, never another caregiver’s', async () => {
    // 16 forbids using "family" to justify broad hidden access. One relative's notification
    // history is not another's business.
    await resetDeliveries();
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    await dispatchSafety();

    const response = await request(principalFor(SAFETY_CAREGIVER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/alert-deliveries`,
    });
    const recipients = response
      .json<{ deliveries: { recipientUserId: string }[] }>()
      .deliveries.map((d) => d.recipientUserId);
    expect(recipients).toEqual([SAFETY_CAREGIVER]);
  });

  it('shows a stranger nothing', async () => {
    await resetDeliveries();
    await dispatchSafety();
    const response = await request(principalFor(STRANGER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE_A}/alert-deliveries`,
    });
    expect(response.json<{ deliveries: unknown[] }>().deliveries).toEqual([]);
  });
});
