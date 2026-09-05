import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from '../../../db/harness/harness.js';
import type { PurgeConnection } from '@kynviora/db';
import { instantFrom, type Instant, type LogFields, type Logger } from '@kynviora/domain';
import { runDigestAssembly, type DigestDb } from './digestRun.js';

/**
 * Assembling a digest, against the real policies as the real roles.
 *
 * Spec references: `04` Phase 7.5 (digest policy; revalidation before inclusion), `09` (a
 * withdrawn alert stops being actionable), `03` group H (safety access is its own capability),
 * `16`, `20`, DEC-119, `DEV-033`, migration `0029`.
 *
 * THE THREE CLAIMS
 *  1. **A withdrawn alert cannot reach a digest**, and neither can one a revoked caregiver was
 *     told about. Both are proved by revoking the real thing and re-running, not by stubbing a
 *     state - the read that decides is row-level security's, and a stub would measure the stub.
 *  2. **A delivery is considered exactly once, ever.** Not "not twice in a digest": once across
 *     all of them, so a dropped item is not re-examined every morning for the rest of time.
 *  3. **Nothing renderable is stored**, and no operator output names a person.
 */

const OWNER = testUuid(1);
const CAREGIVER = testUuid(2);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const ITEM = testUuid(30);
const RULE = testUuid(40);

const KOLKATA = 'Asia/Kolkata';

/** 04:00 UTC is 09:30 in Kolkata: past the digest hour, on 2026-09-05 there. */
const MORNING = instantFrom('2026-09-05T04:00:00.000Z');
/** 20:00 UTC is 01:30 in Kolkata the next day: well before it. */
const NIGHT = instantFrom('2026-09-05T20:00:00.000Z');

let t: TestDb;

interface Recorded {
  readonly code: string;
  readonly fields: LogFields;
}

function recordingLogger(): { logger: Logger; records: Recorded[] } {
  const records: Recorded[] = [];
  const emit =
    () =>
    (code: string, fields?: LogFields): void => {
      records.push({ code, fields: fields ?? {} });
    };
  return { records, logger: { debug: emit(), info: emit(), warn: emit(), error: emit() } };
}

function dbFor(handle: TestDb): DigestDb {
  return {
    withService: (fn) => handle.asService((db) => fn(db as unknown as PurgeConnection)),
    withUser: (userId, fn) => handle.asUser(userId, (db) => fn(db as unknown as PurgeConnection)),
  };
}

function assemble(now: Instant, logger?: Logger) {
  const recorder = recordingLogger();
  return runDigestAssembly(dbFor(t), {
    now,
    logger: logger ?? recorder.logger,
    correlationId: 'corr-digest',
  }).then((report) => ({ report, records: recorder.records }));
}

/**
 * One published alert, delivered to `recipient` on the digest channel.
 *
 * Returns both ids: the publication, so a test can withdraw it, and the delivery, so a test can
 * assert on the entry that references it.
 */
async function deliverDigestAlert(
  key: number,
  recipient: string,
  deliveredAt = '2026-09-04T10:00:00.000Z',
): Promise<{ alertId: string; deliveryId: string }> {
  return t.asService(async (db) => {
    const assessment = await db.query<{ id: string }>(
      `INSERT INTO profile_assessment
         (profile_id, owned_item_id, rule_version_id, matched, match_confidence, reasons,
          evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at)
       VALUES ($1, $2, $3, true, 'EXACT', ARRAY['PRODUCT_EXPIRED']::text[], 'A', 'LOW',
               'tpl.expiry', 'norm-1', $4)
       RETURNING id`,
      [PROFILE, ITEM, RULE, deliveredAt],
    );
    const assessmentId = assessment.rows[0]?.id ?? '';

    const alert = await db.query<{ id: string }>(
      `INSERT INTO alert_publication (assessment_id, profile_id, published_at, dedupe_key)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [assessmentId, PROFILE, deliveredAt, `digest-${String(key)}`],
    );
    const alertId = alert.rows[0]?.id ?? '';

    const delivery = await db.query<{ id: string }>(
      `INSERT INTO alert_delivery
         (profile_id, recipient_user_id, event_kind, alert_publication_id, detail_level,
          delivered_at, channel, channel_reason, held)
       VALUES ($1, $2, 'SAFETY_ALERT', $3, 'GENERIC', $4, 'DIGEST', 'URGENCY_CEILING', false)
       RETURNING id`,
      [PROFILE, recipient, alertId, deliveredAt],
    );

    return { alertId, deliveryId: delivery.rows[0]?.id ?? '' };
  });
}

async function setZone(userId: string, zone: string | null): Promise<void> {
  await t.asService((db) =>
    db.query(`UPDATE app_user SET time_zone = $2 WHERE id = $1`, [userId, zone]),
  );
}

async function countOf(table: string, where = 'true'): Promise<number> {
  const res = await t.asOwner((db) =>
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`),
  );
  return res.rows[0]?.n ?? 0;
}

beforeEach(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [CAREGIVER, 'caregiver@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
    await db.query(`INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'H')`, [
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
       VALUES ($1, $2, 'MEDICINE', 'Amoxicillin 500mg')`,
      [ITEM, PROFILE],
    );
    await db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id)
       VALUES ($1, 'synthetic.digest', '1.0.0', 'EXPIRY', 'A', 'LOW',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.expiry')`,
      [RULE],
    );
  });

  await setZone(OWNER, KOLKATA);
});

afterEach(async () => {
  await t?.close();
});

describe('a recipient whose morning has come round', () => {
  it('gets a digest holding what is still current', async () => {
    await deliverDigestAlert(100, OWNER);
    const { report } = await assemble(MORNING);

    expect(report.considered).toBe(1);
    expect(report.assembled).toBe(1);
    expect(report.included).toBe(1);
    expect(report.dropped).toBe(0);

    const digest = await t.asService((db) =>
      db.query<{ local_date: string; time_zone: string; included_count: number }>(
        `SELECT to_char(local_date, 'YYYY-MM-DD') AS local_date, time_zone, included_count
           FROM notification_digest WHERE recipient_user_id = $1`,
        [OWNER],
      ),
    );
    // Their own day, in their own zone: 04:00 UTC is 09:30 on the 5th in Kolkata.
    expect(digest.rows[0]?.local_date).toBe('2026-09-05');
    expect(digest.rows[0]?.time_zone).toBe(KOLKATA);
    expect(digest.rows[0]?.included_count).toBe(1);
  });

  it('is not given a second one the same day', async () => {
    await deliverDigestAlert(101, OWNER);
    await assemble(MORNING);
    await deliverDigestAlert(102, OWNER);

    const { report } = await assemble(MORNING);
    expect(report.skippedAlreadyAssembled).toBe(1);
    expect(report.assembled).toBe(0);
    expect(await countOf('notification_digest')).toBe(1);
  });

  it('gets the next one the following local day', async () => {
    await deliverDigestAlert(103, OWNER);
    await assemble(MORNING);
    await deliverDigestAlert(104, OWNER);

    const { report } = await assemble(instantFrom('2026-09-06T04:00:00.000Z'));
    expect(report.assembled).toBe(1);
    expect(await countOf('notification_digest')).toBe(2);
  });
});

describe('a recipient whose morning has not', () => {
  it('gets nothing, and the reason says which', async () => {
    await deliverDigestAlert(105, OWNER);
    const { report } = await assemble(NIGHT);
    expect(report.skippedBeforeLocalHour).toBe(1);
    expect(report.assembled).toBe(0);
    expect(await countOf('notification_digest')).toBe(0);
  });
});

describe('a recipient whose zone nobody knows', () => {
  it('gets no digest at all rather than one assembled at a guessed hour', async () => {
    // DEC-119 refuses to invent a zone for quiet hours; this is the same refusal. Their events are
    // still reachable in the app, which is why not assembling is the safe direction here.
    await setZone(OWNER, null);
    await deliverDigestAlert(106, OWNER);

    const { report } = await assemble(MORNING);
    expect(report.considered).toBe(1);
    expect(report.skippedZoneUnknown).toBe(1);
    expect(await countOf('notification_digest')).toBe(0);
  });

  it('is picked up as soon as they report one', async () => {
    await setZone(OWNER, null);
    await deliverDigestAlert(107, OWNER);
    await assemble(MORNING);

    await setZone(OWNER, KOLKATA);
    expect((await assemble(MORNING)).report.assembled).toBe(1);
  });
});

describe('revalidation at assembly time', () => {
  it('drops an alert withdrawn since the recipient was told', async () => {
    // `09` and Phase 7.5's second exit criterion. The alert is genuinely withdrawn and the read
    // that decides is the recipient's own, so this is row-level security answering rather than a
    // state this test handed the assembler.
    const { alertId } = await deliverDigestAlert(110, OWNER);
    await t.asService((db) =>
      db.query(
        `UPDATE alert_publication SET state = 'WITHDRAWN', withdrawn_at = now(),
                withdrawn_reason = 'synthetic' WHERE id = $1`,
        [alertId],
      ),
    );

    const { report } = await assemble(MORNING);
    expect(report.assembled).toBe(1);
    expect(report.included).toBe(0);
    expect(report.dropped).toBe(1);

    const entry = await t.asService((db) =>
      db.query<{ outcome: string; included: boolean }>(
        `SELECT outcome, included FROM notification_digest_entry`,
      ),
    );
    expect(entry.rows[0]?.outcome).toBe('NO_LONGER_VISIBLE');
    expect(entry.rows[0]?.included).toBe(false);
  });

  it('drops one whose reader lost their caregiver access', async () => {
    // The case `revalidate`'s null branch says is "real rather than defensive". A caregiver told
    // on Thursday and revoked on Friday must not receive a summary of it on Saturday.
    await t.asService((db) =>
      db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, ARRAY['VIEW_SAFETY']::text[], 'ACTIVE', now())`,
        [PROFILE, CAREGIVER, OWNER],
      ),
    );
    await setZone(CAREGIVER, KOLKATA);
    await deliverDigestAlert(111, CAREGIVER);

    // Still entitled: the alert would be included.
    expect((await assemble(MORNING)).report.included).toBe(1);

    // Now revoke, and do it for a second alert on the next local day.
    await t.asService((db) =>
      db.query(`UPDATE caregiver_grant SET status = 'REVOKED', revoked_at = now()`),
    );
    await deliverDigestAlert(112, CAREGIVER);

    const { report } = await assemble(instantFrom('2026-09-06T04:00:00.000Z'));
    expect(report.included).toBe(0);
    expect(report.dropped).toBe(1);
  });

  it('keeps an alert that is still published', async () => {
    await deliverDigestAlert(113, OWNER);
    const { report } = await assemble(MORNING);
    expect(report.included).toBe(1);
    expect(
      await countOf('notification_digest_entry', `outcome = 'STILL_CURRENT' AND included`),
    ).toBe(1);
  });
});

describe('a delivery already considered', () => {
  it('is not reconsidered, so a dropped item is settled rather than re-asked daily', async () => {
    const { alertId } = await deliverDigestAlert(114, OWNER);
    await t.asService((db) =>
      db.query(
        `UPDATE alert_publication SET state = 'WITHDRAWN', withdrawn_at = now(),
                withdrawn_reason = 'synthetic' WHERE id = $1`,
        [alertId],
      ),
    );
    await assemble(MORNING);
    expect(await countOf('notification_digest_entry')).toBe(1);

    // The next day, with nothing new. It is no longer a candidate at all, so this recipient is not
    // even considered - which is what stops the candidate set growing without bound.
    const { report } = await assemble(instantFrom('2026-09-06T04:00:00.000Z'));
    expect(report.considered).toBe(0);
    expect(await countOf('notification_digest_entry')).toBe(1);
  });

  it('cannot be entered into a second digest, by anybody', async () => {
    const { deliveryId } = await deliverDigestAlert(115, OWNER);
    await assemble(MORNING);

    const digestId = await t.asService((db) =>
      db
        .query<{ id: string }>(`SELECT id FROM notification_digest LIMIT 1`)
        .then((r) => r.rows[0]?.id ?? ''),
    );
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO notification_digest_entry (digest_id, alert_delivery_id, outcome, included)
           VALUES ($1, $2, 'STILL_CURRENT', true)`,
          [digestId, deliveryId],
        ),
      ),
    );
    expect(message).toMatch(/notification_digest_entry_once/);
  });
});

describe('what a digest holds and who may read it', () => {
  it('holds nothing renderable', async () => {
    // A reference plus what a re-read found, exactly as `alert_delivery` is a reference plus a
    // detail level. A digest can never disclose more than a live read would because it has nothing
    // to disclose.
    await deliverDigestAlert(116, OWNER);
    await assemble(MORNING);

    const dump = await t.asOwner((db) =>
      db.query<Record<string, unknown>>(
        `SELECT d.*, e.* FROM notification_digest d
           JOIN notification_digest_entry e ON e.digest_id = d.id`,
      ),
    );
    const serialized = JSON.stringify(dump.rows);
    expect(serialized).not.toContain('Amoxicillin');
    expect(serialized).not.toContain('Parent A');
  });

  it('is readable by its recipient and by nobody else', async () => {
    // Not the profile owner and not a caregiver. A digest is addressed to one person and spans
    // every profile they have access to, so "somebody who can see this profile" is the wrong
    // scope for it.
    await setZone(CAREGIVER, KOLKATA);
    await t.asService((db) =>
      db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, ARRAY['VIEW_SAFETY']::text[], 'ACTIVE', now())`,
        [PROFILE, CAREGIVER, OWNER],
      ),
    );
    await deliverDigestAlert(117, CAREGIVER);
    await assemble(MORNING);

    const asCaregiver = await t.asUser(CAREGIVER, (db) =>
      db.query<{ id: string }>(`SELECT id FROM notification_digest`),
    );
    expect(asCaregiver.rows).toHaveLength(1);

    // The profile owner cannot read the caregiver's digest, even though it is about their own
    // household.
    const asOwner = await t.asUser(OWNER, (db) =>
      db.query<{ id: string }>(`SELECT id FROM notification_digest`),
    );
    expect(asOwner.rows).toHaveLength(0);

    const entriesAsOwner = await t.asUser(OWNER, (db) =>
      db.query<{ id: string }>(`SELECT id FROM notification_digest_entry`),
    );
    expect(entriesAsOwner.rows).toHaveLength(0);
  });

  it('cannot be created or edited by a client', async () => {
    expect(
      await expectDenied(() =>
        t.asUser(OWNER, (db) =>
          db.query(
            `INSERT INTO notification_digest (recipient_user_id, local_date, time_zone,
                                              included_count, dropped_count)
             VALUES ($1, '2026-09-05', 'Asia/Kolkata', 1, 0)`,
            [OWNER],
          ),
        ),
      ),
    ).toMatch(/permission denied/i);
  });

  it('is never a summary of nothing', async () => {
    // The schema refuses it, because the purge removes a digest once it has no entries left - so
    // an empty one would be created and deleted on the same day for two unrelated reasons.
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO notification_digest (recipient_user_id, local_date, time_zone,
                                            included_count, dropped_count)
           VALUES ($1, '2026-09-05', 'Asia/Kolkata', 0, 0)`,
          [OWNER],
        ),
      ),
    );
    expect(message).toMatch(/notification_digest_not_empty/);
  });
});

describe('what the assembly reports', () => {
  it('logs counts and names nobody', async () => {
    await deliverDigestAlert(118, OWNER);
    const { records } = await assemble(MORNING);

    const finished = records.find((r) => r.code === 'digest.assembly.finished');
    expect(finished).toBeDefined();
    expect(finished?.fields.assembled).toBe(1);
    expect(finished?.fields.included).toBe(1);

    const serialized = JSON.stringify(finished?.fields);
    expect(serialized).not.toContain(OWNER);
    expect(serialized).not.toContain('Amoxicillin');
  });

  it('says nothing at all when there is nothing waiting', async () => {
    const { report, records } = await assemble(MORNING);
    expect(report.considered).toBe(0);
    expect(records).toEqual([]);
  });
});
