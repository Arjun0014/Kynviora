import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  SAFETY_RESOLUTIONS,
  instantFrom,
  noopLogger,
  unsafeId,
  type Instant,
  type UserId,
} from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Phase 7.6, against a real engine.
 *
 * Both exit criteria are asserted as properties of the database after the flow rather than as
 * claims about the code. "Resolution does not erase historical assessment" is checked by reading
 * the assessment and the alert back afterwards; "corrections remain visible and auditable" is
 * checked by recording a correction after a resolution and finding both on the receipt.
 *
 * The receipt is one row per alert (DEC-075), so the sequence of what somebody recorded is
 * asserted against the append-only audit log the read replays - which is the whole reason the
 * one-row schema is not a loss of history.
 */

const OWNER = testUuid(1);
const CAREGIVER_SAFETY = testUuid(2);
const CAREGIVER_NO_SAFETY = testUuid(3);
const STRANGER = testUuid(4);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const ITEM = testUuid(30);
const RULE = testUuid(60);
const SUPERSEDED_RULE = testUuid(61);

const NOW = instantFrom('2026-09-01T12:00:00.000Z');
const LATER = instantFrom('2026-09-02T12:00:00.000Z');
const LATER_STILL = instantFrom('2026-09-03T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;
let currentNow: Instant = NOW;
let alertCounter = 0;

function principalFor(userId: string): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt: null };
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [CAREGIVER_SAFETY, 'safety@example.test'],
      [CAREGIVER_NO_SAFETY, 'nosafety@example.test'],
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
          required_item_verification, required_profile_provenance, explanation_template_id,
          review_state, approved_by_reviewer_id, approved_at, approved_jurisdictions)
       VALUES ($1, 'synthetic.receipt', '1.0.0', 'EXPIRY', 'A', 'HIGH',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.expiry',
               'PUBLISHED', 'synthetic-reviewer', $2, ARRAY['GB']::text[])`,
      [RULE, NOW],
    );
    // A rule Kynviora no longer publishes. The assessment_rule_read policy admits PUBLISHED only,
    // so this one is invisible to the app role while an alert it raised stays published - the case
    // the receipt's LEFT join exists for.
    await db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id,
          review_state)
       VALUES ($1, 'synthetic.superseded', '0.9.0', 'EXPIRY', 'A', 'HIGH',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.expiry',
               'SUPERSEDED')`,
      [SUPERSEDED_RULE],
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
    await db.query('DELETE FROM safety_receipt');
    await db.query('DELETE FROM caregiver_grant');
    // Not the audit log: it is append-only and a trigger refuses even the owner role. Every test
    // publishes its own alert, so audit assertions are scoped by target rather than by cleanup.
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

async function publishAlert(
  options: { readonly matchConfidence?: string; readonly ruleId?: string } = {},
): Promise<{ alertId: string; assessmentId: string }> {
  alertCounter += 1;
  const confidence = options.matchConfidence ?? 'EXACT';
  const ruleId = options.ruleId ?? RULE;
  return t.asService(async (db) => {
    const assessment = await db.query<{ id: string }>(
      `INSERT INTO profile_assessment
         (profile_id, owned_item_id, rule_version_id, matched, match_confidence, reasons,
          evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at)
       VALUES ($1, $2, $3, true, $5, ARRAY['PRODUCT_EXPIRED']::text[], 'A', 'HIGH',
               'tpl.expiry', 'norm-1', $4)
       RETURNING id`,
      [PROFILE, ITEM, ruleId, NOW, confidence],
    );
    const assessmentId = assessment.rows[0]?.id ?? '';
    const alert = await db.query<{ id: string }>(
      `INSERT INTO alert_publication (assessment_id, profile_id, published_at, dedupe_key)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [assessmentId, PROFILE, NOW, `receipt-${String(alertCounter)}`],
    );
    return { alertId: alert.rows[0]?.id ?? '', assessmentId };
  });
}

async function grant(userId: string, capabilities: readonly string[]): Promise<void> {
  await t.asService((db) =>
    db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4::text[], 'ACTIVE', now())`,
      [PROFILE, userId, OWNER, capabilities],
    ),
  );
}

async function record(as: Principal, alertId: string, resolution: string, note?: string) {
  return request(as, {
    method: 'POST',
    url: `/v1/alerts/${alertId}/resolutions`,
    payload: note === undefined ? { resolution } : { resolution, note },
  });
}

async function reportIncorrect(as: Principal, alertId: string, note?: string) {
  return request(as, {
    method: 'POST',
    url: `/v1/alerts/${alertId}/report-incorrect`,
    payload: note === undefined ? {} : { note },
  });
}

interface ReceiptBody {
  readonly alertPublicationId: string;
  readonly assessmentId: string;
  readonly currentResolution: string | null;
  readonly current: {
    readonly label: string;
    readonly description: string;
    readonly recordedAt: string;
    readonly note: string | null;
  } | null;
  readonly history: readonly {
    readonly label: string;
    readonly recordedAt: string;
    readonly replacedPreviousNote: string | null;
  }[];
  readonly undescribedHistoryCount: number;
  readonly basis: {
    readonly rule: string | null;
    readonly ruleUnavailableNote: string | null;
    readonly ruleVersionId: string;
    readonly regulatoryRuleVersionId: string | null;
    readonly evidenceLabel: string;
    readonly urgencyLabel: string;
    readonly confidenceLabel: string;
    readonly normalizationVersion: string;
    readonly assessedOn: string;
    readonly alertRaisedOn: string;
    readonly note: string;
  };
  readonly source: { readonly summary: string; readonly reference: string | null };
  readonly corrections: readonly {
    readonly heading: string;
    readonly reason: string;
    readonly recordedAt: string;
  }[];
  readonly correctedSinceNotice: string | null;
  readonly uncertainties: readonly string[];
  readonly uncertaintyCodes: readonly string[];
  readonly emptyMessage: string;
  readonly permanenceNote: string;
}

async function receipt(as: Principal | null, alertId: string) {
  return request(as, { method: 'GET', url: `/v1/alerts/${alertId}/receipt` });
}

async function receiptBody(as: Principal, alertId: string): Promise<ReceiptBody> {
  const response = await receipt(as, alertId);
  expect(response.statusCode).toBe(200);
  return response.json<ReceiptBody>();
}

async function auditActions(alertId: string): Promise<readonly string[]> {
  const events = await t.asService((db) =>
    db.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE target_id = $1 ORDER BY occurred_at, id`,
      [alertId],
    ),
  );
  return events.rows.map((row) => row.action);
}

// ---------------------------------------------------------------------------

describe('recording what a person did', () => {
  it('accepts every member of the vocabulary, one at a time', async () => {
    for (const resolution of SAFETY_RESOLUTIONS) {
      const { alertId } = await publishAlert();
      const response = await record(principalFor(OWNER), alertId, resolution);
      expect(response.statusCode).toBe(201);
      expect((await receiptBody(principalFor(OWNER), alertId)).currentResolution).toBe(resolution);
    }
  });

  it('refuses a resolution outside the vocabulary', async () => {
    const { alertId } = await publishAlert();
    const response = await record(principalFor(OWNER), alertId, 'STOPPED_MEDICINE');
    // `09` forbids Kynviora telling anybody to stop a medicine, and a resolution vocabulary is
    // where that rule quietly fails. Neither the schema nor the CHECK admits such a member.
    expect(response.statusCode).toBe(400);
  });

  it('keeps one row per alert and replaces what stood', async () => {
    const { alertId } = await publishAlert();
    await record(principalFor(OWNER), alertId, 'REVIEWED');
    currentNow = LATER;
    const second = await record(principalFor(OWNER), alertId, 'DISCUSSED_WITH_PROFESSIONAL');
    expect(second.statusCode).toBe(201);
    expect(second.json<{ replaced: boolean }>().replaced).toBe(true);

    // `receipt_publication_idx` is UNIQUE on the publication, so this is the schema's shape rather
    // than a choice this route makes (DEC-075).
    const rows = await t.asService((db) =>
      db.query<{ n: string }>(
        'SELECT count(*) AS n FROM safety_receipt WHERE alert_publication_id = $1',
        [alertId],
      ),
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);

    const body = await receiptBody(principalFor(OWNER), alertId);
    expect(body.currentResolution).toBe('DISCUSSED_WITH_PROFESSIONAL');
  });

  it('keeps the sequence on the receipt even though the row was overwritten', async () => {
    const { alertId } = await publishAlert();
    await record(principalFor(OWNER), alertId, 'REVIEWED');
    currentNow = LATER;
    await record(principalFor(OWNER), alertId, 'QUARANTINED');
    currentNow = LATER_STILL;
    await record(principalFor(OWNER), alertId, 'DISCUSSED_WITH_PROFESSIONAL');

    const body = await receiptBody(principalFor(OWNER), alertId);
    // This is what makes one-row-per-alert not a loss of history: the chain is replayed out of
    // the append-only log, which no role may update or delete. The times are the database's own
    // occurred_at rather than the request clock - an audit log whose timestamps came from the
    // caller would be one the caller could shape.
    const times = body.history.map((h) => Date.parse(h.recordedAt));
    expect(times).toHaveLength(3);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(body.history[0]?.replacedPreviousNote).toBeNull();
    expect(body.history[1]?.replacedPreviousNote).toContain('replaced what you had recorded');
    expect(body.history[2]?.replacedPreviousNote).toContain('replaced what you had recorded');
    expect(body.undescribedHistoryCount).toBe(0);
  });

  it('cannot have its history rewritten by anybody, including the service role', async () => {
    const { alertId } = await publishAlert();
    await record(principalFor(OWNER), alertId, 'REVIEWED');

    // `14`: the audit log is append-only and a trigger enforces it. If this ever succeeded, the
    // receipt's history would be editable and the one-row schema would be a real loss.
    await expect(
      t.asService((db) =>
        db.query(`UPDATE audit_event SET detail = '{}'::jsonb WHERE target_id = $1`, [alertId]),
      ),
    ).rejects.toThrow();
    await expect(
      t.asService((db) => db.query(`DELETE FROM audit_event WHERE target_id = $1`, [alertId])),
    ).rejects.toThrow();
  });

  it('is idempotent for the same resolution, and says so', async () => {
    const { alertId } = await publishAlert();
    expect((await record(principalFor(OWNER), alertId, 'REVIEWED')).statusCode).toBe(201);

    const again = await record(principalFor(OWNER), alertId, 'REVIEWED');
    expect(again.statusCode).toBe(200);
    expect(again.json<{ alreadyRecorded: boolean }>().alreadyRecorded).toBe(true);

    // Nothing written means nothing logged - a second history line would read as a second review.
    expect(await auditActions(alertId)).toEqual(['alert.resolution_recorded']);
    expect((await receiptBody(principalFor(OWNER), alertId)).history).toHaveLength(1);
  });

  it('keeps the note on the receipt and out of the audit detail', async () => {
    const { alertId } = await publishAlert();
    await record(principalFor(OWNER), alertId, 'REVIEWED', 'a sentence about a medicine');

    const body = await receiptBody(principalFor(OWNER), alertId);
    expect(body.current?.note).toBe('a sentence about a medicine');

    const events = await t.asService((db) =>
      db.query<{ detail: unknown }>(
        `SELECT detail FROM audit_event
          WHERE action = 'alert.resolution_recorded' AND target_id = $1`,
        [alertId],
      ),
    );
    const detail = JSON.stringify(events.rows[0]?.detail);
    expect(detail).not.toContain('a sentence about a medicine');
    // The resolution is a closed vocabulary and safe to record; the note is not.
    expect(detail).toContain('REVIEWED');
    expect(detail).toContain('note_recorded');
  });
});

describe('the two routes that write a receipt', () => {
  it('lets report-incorrect follow a resolution without meeting the unique index', async () => {
    const { alertId } = await publishAlert();
    expect((await record(principalFor(OWNER), alertId, 'REVIEWED')).statusCode).toBe(201);

    // Before both routes shared one writer this was a 500: `alertDetail` did its own INSERT and
    // `receipt_publication_idx` refused the second row.
    const reported = await reportIncorrect(principalFor(OWNER), alertId);
    expect(reported.statusCode).toBe(201);

    const body = await receiptBody(principalFor(OWNER), alertId);
    expect(body.currentResolution).toBe('REPORTED_INCORRECT_MATCH');
    expect(body.history.map((h) => h.label)).toHaveLength(2);
  });

  it('lets a resolution follow report-incorrect', async () => {
    const { alertId } = await publishAlert();
    expect((await reportIncorrect(principalFor(OWNER), alertId)).statusCode).toBe(201);
    currentNow = LATER;
    expect((await record(principalFor(OWNER), alertId, 'QUARANTINED')).statusCode).toBe(201);

    const body = await receiptBody(principalFor(OWNER), alertId);
    expect(body.currentResolution).toBe('QUARANTINED');
    expect(await auditActions(alertId)).toEqual([
      'alert.reported_incorrect',
      'alert.resolution_recorded',
    ]);
  });

  it('treats report-incorrect twice as one report', async () => {
    const { alertId } = await publishAlert();
    expect((await reportIncorrect(principalFor(OWNER), alertId)).statusCode).toBe(201);
    const again = await reportIncorrect(principalFor(OWNER), alertId);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ alreadyReported: boolean }>().alreadyReported).toBe(true);
    expect(await auditActions(alertId)).toEqual(['alert.reported_incorrect']);
  });

  it('records the same resolution through either route', async () => {
    const { alertId } = await publishAlert();
    expect((await reportIncorrect(principalFor(OWNER), alertId)).statusCode).toBe(201);
    // The resolutions route naming the same member is the same fact, so it is idempotent too.
    const viaResolutions = await record(principalFor(OWNER), alertId, 'REPORTED_INCORRECT_MATCH');
    expect(viaResolutions.statusCode).toBe(200);
    expect(viaResolutions.json<{ alreadyRecorded: boolean }>().alreadyRecorded).toBe(true);
  });
});

describe('exit criterion 1 - resolution does not erase historical assessment', () => {
  it('leaves the assessment exactly as it was', async () => {
    const { alertId, assessmentId } = await publishAlert();

    const before = await t.asService((db) =>
      db.query('SELECT * FROM profile_assessment WHERE id = $1', [assessmentId]),
    );

    for (const resolution of ['NOT_APPLICABLE', 'RETURNED_OR_DISPOSED'] as const) {
      await record(principalFor(OWNER), alertId, resolution);
    }

    const after = await t.asService((db) =>
      db.query('SELECT * FROM profile_assessment WHERE id = $1', [assessmentId]),
    );
    // Whole row, not a chosen field. "Not applicable" is the resolution a person most reasonably
    // expects to make something go away, and it is the one this must hold for.
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('leaves the alert published', async () => {
    const { alertId } = await publishAlert();
    await record(principalFor(OWNER), alertId, 'NOT_APPLICABLE');

    const alert = await t.asService((db) =>
      db.query<{ state: string; withdrawn_at: unknown }>(
        'SELECT state, withdrawn_at FROM alert_publication WHERE id = $1',
        [alertId],
      ),
    );
    // Withdrawing an alert is a reviewer's decision through the staff console, not a household's.
    expect(alert.rows[0]?.state).toBe('PUBLISHED');
    expect(alert.rows[0]?.withdrawn_at).toBeNull();
  });

  it('holds the versions and gradings steady across every resolution', async () => {
    const { alertId } = await publishAlert();
    const before = await receiptBody(principalFor(OWNER), alertId);

    for (const resolution of SAFETY_RESOLUTIONS) {
      expect([200, 201]).toContain(
        (await record(principalFor(OWNER), alertId, resolution)).statusCode,
      );
    }

    const after = await receiptBody(principalFor(OWNER), alertId);
    // What the alert was based on is a fact about the assessment, so recording seven different
    // things about it must not move any of it. DEC-010: the assessment froze these.
    expect(after.basis).toEqual(before.basis);
  });

  it('gives the app role no way to change the assessment or the alert', async () => {
    const { alertId, assessmentId } = await publishAlert();
    await grant(CAREGIVER_SAFETY, ['VIEW_SAFETY']);

    await expect(
      t.asUser(CAREGIVER_SAFETY, (db) =>
        db.query(`UPDATE profile_assessment SET urgency = 'INFORMATIONAL' WHERE id = $1`, [
          assessmentId,
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      t.asUser(CAREGIVER_SAFETY, (db) =>
        db.query(`UPDATE alert_publication SET state = 'WITHDRAWN' WHERE id = $1`, [alertId]),
      ),
    ).rejects.toThrow();
  });
});

describe('exit criterion 2 - corrections remain visible and auditable', () => {
  it('shows a correction that arrived after the person recorded something', async () => {
    const { alertId, assessmentId } = await publishAlert();
    await record(principalFor(OWNER), alertId, 'REVIEWED');

    currentNow = LATER;
    await t.asService((db) =>
      db.query(
        `INSERT INTO assessment_correction
           (original_assessment_id, correction_kind, reason, reviewer_id, corrected_at)
         VALUES ($1, 'RULE_CORRECTED', 'The rule matched on the wrong identifier.',
                 'synthetic-test-reviewer', $2)`,
        [assessmentId, LATER],
      ),
    );

    const body = await receiptBody(principalFor(OWNER), alertId);
    // Beside what the person recorded, never instead of it.
    expect(body.current?.label).toBe('I have read this');
    expect(body.corrections).toHaveLength(1);
    expect(body.corrections[0]?.heading).toBe('Kynviora corrected the rule behind this');
    expect(body.corrections[0]?.reason).toContain('wrong identifier');
    // The case this criterion exists for: they marked it reviewed and Kynviora later corrected it.
    expect(body.correctedSinceNotice).toContain('after you recorded');
    expect(body.uncertaintyCodes).toContain('CORRECTED_SINCE_RESOLUTION');
  });

  it('does not claim a later correction when the person recorded something afterwards', async () => {
    const { alertId, assessmentId } = await publishAlert();
    await t.asService((db) =>
      db.query(
        `INSERT INTO assessment_correction
           (original_assessment_id, correction_kind, reason, corrected_at)
         VALUES ($1, 'SOURCE_CORRECTED', 'The source republished.', $2)`,
        [assessmentId, NOW],
      ),
    );

    currentNow = LATER;
    await record(principalFor(OWNER), alertId, 'REVIEWED');

    const body = await receiptBody(principalFor(OWNER), alertId);
    expect(body.corrections).toHaveLength(1);
    expect(body.correctedSinceNotice).toBeNull();
    expect(body.uncertaintyCodes).not.toContain('CORRECTED_SINCE_RESOLUTION');
  });

  it('shows corrections even where the person recorded nothing', async () => {
    const { alertId, assessmentId } = await publishAlert();
    await t.asService((db) =>
      db.query(
        `INSERT INTO assessment_correction
           (original_assessment_id, correction_kind, reason, corrected_at)
         VALUES ($1, 'FORMULATION_CORRECTED', 'The ingredient list was re-read.', $2)`,
        [assessmentId, NOW],
      ),
    );
    const body = await receiptBody(principalFor(OWNER), alertId);
    expect(body.current).toBeNull();
    expect(body.history).toEqual([]);
    expect(body.corrections).toHaveLength(1);
    // No resolution to be "since", so no claim either way.
    expect(body.correctedSinceNotice).toBeNull();
    expect(body.emptyMessage).toContain('not recorded anything');
  });

  it('says a later assessment replaced this one', async () => {
    const { alertId, assessmentId } = await publishAlert();
    const replacement = await publishAlert();

    await t.asService((db) =>
      db.query(
        `INSERT INTO assessment_correction
           (original_assessment_id, corrected_assessment_id, correction_kind, reason, corrected_at)
         VALUES ($1, $2, 'RULE_CORRECTED', 'Re-assessed under a corrected rule.', $3)`,
        [assessmentId, replacement.assessmentId, NOW],
      ),
    );

    const body = await receiptBody(principalFor(OWNER), alertId);
    expect(body.uncertaintyCodes).toContain('SUPERSEDED_BY_LATER_ASSESSMENT');
    expect(body.uncertainties.join(' ')).toContain('later assessment has replaced');

    // And the replacement's own receipt does not claim to be superseded by itself.
    const later = await receiptBody(principalFor(OWNER), replacement.alertId);
    expect(later.uncertaintyCodes).not.toContain('SUPERSEDED_BY_LATER_ASSESSMENT');
  });
});

describe('what the receipt says the alert rested on', () => {
  it('carries the rule identity, the versions and the gradings', async () => {
    const { alertId } = await publishAlert();
    const body = await receiptBody(principalFor(OWNER), alertId);

    // `04` Phase 7.6: the receipt carries "alert, source/rule version, action".
    expect(body.basis.rule).toBe('synthetic.receipt version 1.0.0');
    expect(body.basis.ruleVersionId).toBe(RULE);
    expect(body.basis.normalizationVersion).toBe('norm-1');
    expect(body.basis.assessedOn).toBe(NOW);
    expect(body.basis.alertRaisedOn).toBe(NOW);
    expect(body.basis.evidenceLabel.length).toBeGreaterThan(0);
    expect(body.basis.urgencyLabel.length).toBeGreaterThan(0);
    expect(body.basis.confidenceLabel.length).toBeGreaterThan(0);
    expect(body.basis.note).toContain('do not change');
  });

  it('keeps a receipt readable after the rule behind it stopped being published', async () => {
    const { alertId } = await publishAlert({ ruleId: SUPERSEDED_RULE });
    await record(principalFor(OWNER), alertId, 'REVIEWED');

    const body = await receiptBody(principalFor(OWNER), alertId);
    // A receipt that vanished the day Kynviora revised the rule behind it would be exit criterion
    // 1 failing by another route - the record erased, rather than the assessment.
    expect(body.currentResolution).toBe('REVIEWED');
    expect(body.basis.ruleVersionId).toBe(SUPERSEDED_RULE);
    // The identifier survives; the name does not, and the receipt says which of the two happened
    // rather than leaving a gap that reads as "there was no rule".
    expect(body.basis.rule).toBeNull();
    expect(body.basis.ruleUnavailableNote).toContain('no longer publishes');
    expect(JSON.stringify(body)).not.toContain('synthetic.superseded');
  });

  it('says plainly that an alert resting on no external source rests on none', async () => {
    const { alertId } = await publishAlert();
    const body = await receiptBody(principalFor(OWNER), alertId);
    expect(body.basis.regulatoryRuleVersionId).toBeNull();
    expect(body.source.summary).toContain('does not rest on an external published source');
    expect(body.source.reference).toBeNull();
  });

  it('names an inexact match as something it could not settle', async () => {
    const { alertId } = await publishAlert({ matchConfidence: 'PROBABLE' });
    const body = await receiptBody(principalFor(OWNER), alertId);
    // `10`: state the limit where you state the finding. A receipt reads as settled precisely
    // because somebody acted on it, which is why this has to be said here as well as on 7.3.
    expect(body.uncertaintyCodes).toContain('MATCH_NOT_EXACT');
    expect(body.uncertainties.join(' ')).toContain('not certain');
  });

  it('says nothing came back after a person reported the match as wrong', async () => {
    const { alertId } = await publishAlert();
    await reportIncorrect(principalFor(OWNER), alertId);
    const body = await receiptBody(principalFor(OWNER), alertId);
    expect(body.uncertaintyCodes).toContain('REPORTED_INCORRECT_AWAITING_REVIEW');
    // And it does not promise anybody is looking. `10` prefers an honest absence to a queue this
    // build has no staffing model for.
    expect(body.uncertainties.join(' ')).not.toMatch(/we will|looking into|shortly|soon/i);
  });

  it('stops saying so once a correction lands', async () => {
    const { alertId, assessmentId } = await publishAlert();
    await reportIncorrect(principalFor(OWNER), alertId);
    currentNow = LATER;
    await t.asService((db) =>
      db.query(
        `INSERT INTO assessment_correction
           (original_assessment_id, correction_kind, reason, corrected_at)
         VALUES ($1, 'ITEM_IDENTITY_CORRECTED', 'The product was re-identified.', $2)`,
        [assessmentId, LATER],
      ),
    );
    const body = await receiptBody(principalFor(OWNER), alertId);
    expect(body.uncertaintyCodes).toContain('CORRECTED_SINCE_RESOLUTION');
    // Both at once would have the screen saying "nothing has come back" beside the thing that did.
    expect(body.uncertaintyCodes).not.toContain('REPORTED_INCORRECT_AWAITING_REVIEW');
  });

  it('has no completion, progress or resolved state anywhere in the response', async () => {
    const { alertId } = await publishAlert();
    await record(principalFor(OWNER), alertId, 'REVIEWED');
    const body = await receiptBody(principalFor(OWNER), alertId);
    // `02` names alarm-optimised design as an anti-feature; a completion meter is the cheerful
    // version of the same thing, and it would decide which of a person's actions counted.
    for (const forbidden of ['resolved', 'complete', 'progress', 'score', 'handled', 'closed']) {
      expect(Object.keys(body)).not.toContain(forbidden);
    }
  });
});

describe('who may resolve and read', () => {
  it('lets a caregiver with VIEW_SAFETY record and read, without shelf access', async () => {
    // Resolving does not require seeing the shelf. Requiring it would make these controls depend
    // on a permission `03` group H keeps separate from safety.
    await grant(CAREGIVER_SAFETY, ['VIEW_SAFETY']);
    const { alertId } = await publishAlert();
    expect((await record(principalFor(CAREGIVER_SAFETY), alertId, 'REVIEWED')).statusCode).toBe(
      201,
    );
    const body = await receiptBody(principalFor(CAREGIVER_SAFETY), alertId);
    expect(body.currentResolution).toBe('REVIEWED');
  });

  it('does not name who recorded what, to anybody', async () => {
    await grant(CAREGIVER_SAFETY, ['VIEW_SAFETY']);
    const { alertId } = await publishAlert();
    await record(principalFor(CAREGIVER_SAFETY), alertId, 'REVIEWED');

    for (const reader of [OWNER, CAREGIVER_SAFETY]) {
      const raw = JSON.stringify(await receiptBody(principalFor(reader), alertId));
      // DEC-076: identity belongs on the caregiver-audit screen. A receipt saying which member of
      // a household acted would be a new disclosure invented by a screen about an alert.
      expect(raw).not.toContain(CAREGIVER_SAFETY);
      expect(raw).not.toContain(OWNER);
    }
  });

  it('refuses a caregiver without VIEW_SAFETY, as absence, and writes nothing', async () => {
    await grant(CAREGIVER_NO_SAFETY, ['VIEW_MEDICINES']);
    const { alertId } = await publishAlert();
    expect((await record(principalFor(CAREGIVER_NO_SAFETY), alertId, 'REVIEWED')).statusCode).toBe(
      404,
    );
    expect((await receipt(principalFor(CAREGIVER_NO_SAFETY), alertId)).statusCode).toBe(404);

    const rows = await t.asService((db) =>
      db.query<{ n: string }>(
        'SELECT count(*) AS n FROM safety_receipt WHERE alert_publication_id = $1',
        [alertId],
      ),
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
    expect(await auditActions(alertId)).toEqual([]);
  });

  it('will not let a caregiver without VIEW_SAFETY update a receipt directly', async () => {
    await grant(CAREGIVER_NO_SAFETY, ['VIEW_MEDICINES']);
    const { alertId } = await publishAlert();
    await record(principalFor(OWNER), alertId, 'REVIEWED');

    // Straight at the table, under the app role. `receipt_resolve` requires `VIEW_SAFETY` in both
    // USING and WITH CHECK, so this updates nothing rather than being refused - the row is not
    // visible to this caller at all.
    const updated = await t.asUser(CAREGIVER_NO_SAFETY, (db) =>
      db.query<{ id: string }>(
        `UPDATE safety_receipt SET resolution = 'NOT_APPLICABLE'
          WHERE alert_publication_id = $1 RETURNING id`,
        [alertId],
      ),
    );
    expect(updated.rows).toEqual([]);

    const still = await t.asService((db) =>
      db.query<{ resolution: string }>(
        'SELECT resolution FROM safety_receipt WHERE alert_publication_id = $1',
        [alertId],
      ),
    );
    expect(still.rows[0]?.resolution).toBe('REVIEWED');
  });

  it('gives the app role no INSERT on the receipt at all', async () => {
    await grant(CAREGIVER_SAFETY, ['VIEW_SAFETY']);
    const { alertId, assessmentId } = await publishAlert();
    // `0006` grants SELECT and UPDATE only: a person may resolve a receipt that exists, not create
    // rows naming whichever alert and assessment they like.
    await expect(
      t.asUser(CAREGIVER_SAFETY, (db) =>
        db.query(
          `INSERT INTO safety_receipt (profile_id, alert_publication_id, assessment_id)
           VALUES ($1, $2, $3)`,
          [PROFILE, alertId, assessmentId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('refuses a stranger and an unknown alert identically', async () => {
    const { alertId } = await publishAlert();
    const stranger = await receipt(principalFor(STRANGER), alertId);
    const unknown = await receipt(principalFor(OWNER), testUuid(999));
    expect(stranger.statusCode).toBe(unknown.statusCode);
    expect(stranger.json<{ error: { code: string } }>().error.code).toBe(
      unknown.json<{ error: { code: string } }>().error.code,
    );
  });

  it('answers a malformed identifier exactly as an unknown one', async () => {
    const malformed = await receipt(principalFor(OWNER), 'not-a-uuid');
    const unknown = await receipt(principalFor(OWNER), testUuid(998));
    expect(malformed.statusCode).toBe(unknown.statusCode);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe(
      unknown.json<{ error: { code: string } }>().error.code,
    );
  });

  it('treats a withdrawn alert as not found, on both routes', async () => {
    const { alertId } = await publishAlert();
    await t.asService((db) =>
      db.query(
        `UPDATE alert_publication
            SET state = 'WITHDRAWN', withdrawn_at = $2, withdrawn_reason = 'synthetic'
          WHERE id = $1`,
        [alertId, LATER],
      ),
    );
    // `19`'s release-blocking defect class: a withdrawn alert must stop being actionable, and the
    // policy is what enforces it rather than this handler remembering to filter.
    expect((await receipt(principalFor(OWNER), alertId)).statusCode).toBe(404);
    expect((await record(principalFor(OWNER), alertId, 'REVIEWED')).statusCode).toBe(404);
  });

  it('rejects an unauthenticated request on both routes', async () => {
    const { alertId } = await publishAlert();
    expect((await receipt(null, alertId)).statusCode).toBe(401);
    expect(
      (
        await request(null, {
          method: 'POST',
          url: `/v1/alerts/${alertId}/resolutions`,
          payload: { resolution: 'REVIEWED' },
        })
      ).statusCode,
    ).toBe(401);
  });
});
