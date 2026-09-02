import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { MATCH_REASONS } from '@kynviora/safety';
import { MATCH_REASON_TEXT, UNEXPLAINABLE } from '@kynviora/presentation';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Phase 7.3, against a real engine.
 *
 * The route composes the message server-side and the policies decide what a caller may see. Both
 * are the point: `11` puts safety composition on the server, and `19` makes a withdrawn alert
 * that is still readable a release-blocking defect - which here is `alert_publication`'s policy
 * rather than a filter this handler has to remember.
 */

const OWNER = testUuid(1);
const CAREGIVER_SAFETY = testUuid(2);
const CAREGIVER_NO_SAFETY = testUuid(3);
const STRANGER = testUuid(4);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const ITEM = testUuid(30);
const IDENTITY = testUuid(40);
const BATCH = testUuid(41);
const SOURCE = testUuid(50);
const RULE = testUuid(60);
const REG_RULE = testUuid(61);
const DOCUMENT = testUuid(62);
/** `DEV-028`. The substance the rule matched, and the record it matched against. */
const SUBSTANCE = testUuid(70);
const SUBSTANCE_KEY = 'synthetic.salicylic_acid';
const ALLERGY_FACT = testUuid(71);

const NOW = instantFrom('2026-09-01T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;
let currentNow: Instant = NOW;

function principalFor(userId: string): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt: null };
}

let alertCounter = 0;

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
      `INSERT INTO product_identity (id, item_kind, display_name, corroboration)
       VALUES ($1, 'MEDICINE', 'Synthetic Tablet', 'USER_CONFIRMED')`,
      [IDENTITY],
    );
    await db.query(
      `INSERT INTO batch_or_lot (id, product_identity_id, lot_code, lot_code_normalized)
       VALUES ($1, $2, 'LOT-9', 'LOT9')`,
      [BATCH, IDENTITY],
    );

    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, brand, product_identity_id, batch_id,
          batch_verification, formulation_verification, expires_on)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet', 'Synthetic Brand', $3, $4,
               'CONFIRMED', 'UNVERIFIED', DATE '2027-01-01')`,
      [ITEM, PROFILE, IDENTITY, BATCH],
    );

    await db.query(
      `INSERT INTO source_registry_entry
         (id, organization, source_name, source_class, jurisdiction, allowed_influence,
          license_review_state, expected_refresh_interval_ms, parser_version, status,
          coverage_statement, required_attribution)
       VALUES ($1, 'Synthetic Authority', 'Synthetic Register', 'PRIMARY_LEGAL', 'GB',
               ARRAY['REGULATORY_STATUS']::text[], 'NOT_REVIEWED', 86400000, '1.0.0', 'ACTIVE',
               'Synthetic coverage for tests.', 'Contains synthetic information.')`,
      [SOURCE],
    );
    // The Citation Gate refuses a PUBLISHED regulatory record with no retrieved document behind
    // it, and `regulatory_rule_version`'s policy shows the app role PUBLISHED records only. So a
    // source line on an alert detail is only reachable for a record that passed the gate - which
    // is the point, and which is why nothing shipped produces one (DEC-016, BLK-004).
    await db.query(
      `INSERT INTO source_document
         (id, source_registry_entry_id, canonical_uri, content_sha256)
       VALUES ($1, $2, 'https://example.test/synthetic-register',
               '0000000000000000000000000000000000000000000000000000000000000002')`,
      [DOCUMENT, SOURCE],
    );
    await db.query(
      `INSERT INTO regulatory_rule_version
         (id, jurisdiction, substance_canonical_key, statuses, legal_reference, publication_date,
          effective_date, source_registry_entry_id, source_document_id, extraction_version,
          review_state, verification, approved_by_reviewer_id, approved_at)
       VALUES ($1, 'GB', 'synthetic.substance', ARRAY['PRODUCT_ACTION']::text[], 'SI 2026/1',
               DATE '2026-08-01', DATE '2026-08-15', $2, $3, '1.0.0', 'PUBLISHED',
               'VERIFIED_AGAINST_OFFICIAL_SOURCE', 'synthetic-test-reviewer', now())`,
      [REG_RULE, SOURCE, DOCUMENT],
    );

    // `DEV-028`. A catalog substance and one recorded sensitivity on this profile, so an
    // ingredient-sensitivity alert has something real to name on both sides.
    await db.query(
      `INSERT INTO normalized_substance
         (id, canonical_key, preferred_name, substance_kind, vocabulary_version, review_state)
       VALUES ($1, $2, 'Salicylic acid', 'ACTIVE_PHARMACEUTICAL', 'norm-1', 'PUBLISHED')`,
      [SUBSTANCE, SUBSTANCE_KEY],
    );
    await db.query(
      // `substance_mapping_state` is written with the substance, not after it: migration `0019`
      // refuses the pair if they disagree, which is how a fixture that set one and forgot the
      // other fails here rather than shipping a record claiming a rule can see it.
      `INSERT INTO allergy_record
         (id, profile_id, record_kind, display_term, substance_id, substance_mapping_state,
          provenance, certainty)
       VALUES ($1, $2, 'SENSITIVITY', 'salicylates', $3, 'EXACT', 'USER_REPORTED', 'REPORTED')`,
      [ALLERGY_FACT, PROFILE, SUBSTANCE],
    );

    await db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id)
       VALUES ($1, 'synthetic.batch', '1.0.0', 'BATCH_ACTION_MATCH', 'A', 'HIGH',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.batch')`,
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
    await db.query('DELETE FROM safety_receipt');
    await db.query('DELETE FROM caregiver_grant');
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

/**
 * A published alert and the assessment behind it.
 *
 * A fresh assessment per call: `profile_assessment` is append-only and every test wants its own,
 * so nothing here depends on the order the tests happen to run in.
 */
async function publishAlert(
  overrides: {
    readonly templateId?: string;
    readonly reasons?: readonly string[];
    readonly withdrawn?: boolean;
    readonly regulatory?: boolean;
    readonly evidenceLevel?: string;
    readonly urgency?: string;
    readonly matchConfidence?: string;
    /** `DEV-028`. Both or neither - the schema refuses the pair half-filled. */
    readonly matchedSubstanceKey?: string;
    readonly matchedProfileFactId?: string;
    readonly profileFactVersions?: readonly string[];
  } = {},
): Promise<{ alertId: string; assessmentId: string }> {
  alertCounter += 1;
  return t.asService(async (db) => {
    const assessment = await db.query<{ id: string }>(
      `INSERT INTO profile_assessment
         (profile_id, owned_item_id, rule_version_id, matched, match_confidence, reasons,
          evidence_level, urgency, explanation_template_id, normalization_version,
          regulatory_rule_version_id, evaluated_at,
          matched_substance_key, matched_profile_fact_id, profile_fact_versions)
       VALUES ($1, $2, $3, true, $4, $5::text[], $6, $7, $8, 'norm-1', $9, $10,
               $11, $12, $13::text[])
       RETURNING id`,
      [
        PROFILE,
        ITEM,
        RULE,
        overrides.matchConfidence ?? 'EXACT',
        overrides.reasons ?? ['BATCH_CODE_MATCHED'],
        overrides.evidenceLevel ?? 'A',
        overrides.urgency ?? 'HIGH',
        overrides.templateId ?? 'tpl.batch',
        overrides.regulatory === false ? null : REG_RULE,
        NOW,
        overrides.matchedSubstanceKey ?? null,
        overrides.matchedProfileFactId ?? null,
        overrides.profileFactVersions ?? [],
      ],
    );
    const assessmentId = assessment.rows[0]?.id ?? '';

    const alert = await db.query<{ id: string }>(
      `INSERT INTO alert_publication
         (assessment_id, profile_id, state, published_at, dedupe_key, withdrawn_at,
          withdrawn_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        assessmentId,
        PROFILE,
        overrides.withdrawn === true ? 'WITHDRAWN' : 'PUBLISHED',
        NOW,
        `dedupe-${String(alertCounter)}`,
        overrides.withdrawn === true ? NOW : null,
        overrides.withdrawn === true ? 'Superseded by a correction.' : null,
      ],
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

interface DetailBody {
  readonly alertPublicationId: string;
  readonly isLive: boolean;
  readonly message: readonly string[] | null;
  readonly unexplainable: { readonly heading: string } | null;
  readonly withheldNotice: string | null;
  readonly urgency: { readonly label: string };
  readonly evidence: { readonly label: string };
  readonly matchConfidence: { readonly label: string };
  readonly facts: readonly {
    readonly label: string;
    readonly value: string | null;
    readonly basis: string;
    readonly basisText: string;
  }[];
  readonly reasons: { readonly reasons: readonly string[]; readonly undescribedCount: number };
  readonly source: {
    readonly organization: string | null;
    readonly reference: string | null;
    readonly referenceWithheldBecause: string | null;
    readonly attribution: string | null;
  };
  readonly coverageStatement: string;
  readonly actions: readonly { readonly action: string }[];
  readonly actionsUnavailableBecause: string | null;
  readonly inferredCount: number;
}

async function getDetail(as: Principal | null, alertId: string) {
  return request(as, { method: 'GET', url: `/v1/alerts/${alertId}` });
}

// ---------------------------------------------------------------------------

describe('reading one alert', () => {
  it('assembles the approved message, the facts and the states', async () => {
    const { alertId } = await publishAlert();
    const response = await getDetail(principalFor(OWNER), alertId);
    expect(response.statusCode).toBe(200);

    const body = response.json<DetailBody>();
    expect(body.alertPublicationId).toBe(alertId);
    expect(body.isLive).toBe(true);
    // The eight parts `18` prescribes, composed on the server.
    expect(body.message).toHaveLength(8);
    expect(body.facts.length).toBeGreaterThan(5);
  });

  it('names the affected person and the exact item', async () => {
    const { alertId } = await publishAlert();
    const body = (await getDetail(principalFor(OWNER), alertId)).json<DetailBody>();

    const person = body.facts.find((f) => f.label === 'Person');
    const item = body.facts.find((f) => f.label === 'Item');
    expect(person?.value).toBe('Parent A (synthetic)');
    expect(item?.value).toBe('Synthetic Tablet');
  });

  it('labels every fact with where it came from', async () => {
    const { alertId } = await publishAlert();
    const body = (await getDetail(principalFor(OWNER), alertId)).json<DetailBody>();

    // Phase 7.3's second exit criterion, asserted over what the route actually sends rather than
    // over what a component might render.
    for (const entry of body.facts) {
      expect(entry.basis).not.toBe('');
      expect(entry.basisText.length).toBeGreaterThan(10);
    }
    expect(body.inferredCount).toBeGreaterThan(0);
  });

  it('says a confirmed batch number was read from the pack', async () => {
    // `owned_item.batch_verification` is CONFIRMED for this fixture, and `18` keeps the three
    // verification axes apart. A batch number is the field a recall turns on, so where it came
    // from is the difference between two quite different alerts.
    const { alertId } = await publishAlert();
    const body = (await getDetail(principalFor(OWNER), alertId)).json<DetailBody>();
    const lot = body.facts.find((f) => f.label === 'Batch or lot');
    expect(lot?.value).toBe('LOT-9');
    expect(lot?.basis).toBe('READ_FROM_THE_PACK');
  });

  it('turns the recorded match reasons into sentences', async () => {
    const { alertId } = await publishAlert({ reasons: ['BATCH_CODE_MATCHED'] });
    const body = (await getDetail(principalFor(OWNER), alertId)).json<DetailBody>();
    expect(body.reasons.reasons).toEqual([MATCH_REASON_TEXT.BATCH_CODE_MATCHED]);
    expect(body.reasons.undescribedCount).toBe(0);
  });

  it('keeps urgency, evidence and confidence as three separate things', async () => {
    const { alertId } = await publishAlert({ evidenceLevel: 'A', urgency: 'HIGH' });
    const body = (await getDetail(principalFor(OWNER), alertId)).json<DetailBody>();

    expect(body.urgency.label).toBe('Act soon');
    expect(body.evidence.label).toBe('Official action');
    // `23` D-005. The response has nowhere to put a combined severity.
    const keys = Object.keys(body);
    expect(keys).not.toContain('severity');
    expect(keys).not.toContain('score');
  });

  it('carries the coverage statement, so absence is never read as safety', async () => {
    const { alertId } = await publishAlert();
    const body = (await getDetail(principalFor(OWNER), alertId)).json<DetailBody>();
    expect(body.coverageStatement).toContain('does not cover every source');
  });
});

describe('the source line', () => {
  it('withholds the legal reference while the licence review is incomplete', async () => {
    // The fixture source is `NOT_REVIEWED`, which is the default and what `BLK-005` records for
    // every real source too. `04` asks for the reference "where allowed" and `25` makes that a
    // legal question.
    const { alertId } = await publishAlert();
    const body = (await getDetail(principalFor(OWNER), alertId)).json<DetailBody>();

    expect(body.source.organization).toBe('Synthetic Authority');
    expect(body.source.reference).toBeNull();
    expect(body.source.referenceWithheldBecause).toContain('BLK-005');
    expect(body.source.attribution).toBeNull();
  });

  it('shows it once the licence review approves the source', async () => {
    await t.asService((db) =>
      db.query(`UPDATE source_registry_entry SET license_review_state = 'APPROVED' WHERE id = $1`, [
        SOURCE,
      ]),
    );
    const { alertId } = await publishAlert();
    const body = (await getDetail(principalFor(OWNER), alertId)).json<DetailBody>();

    expect(body.source.reference).toBe('SI 2026/1');
    expect(body.source.attribution).toBe('Contains synthetic information.');

    await t.asService((db) =>
      db.query(
        `UPDATE source_registry_entry SET license_review_state = 'NOT_REVIEWED' WHERE id = $1`,
        [SOURCE],
      ),
    );
  });

  it('reads an alert that rests on no regulatory record at all', async () => {
    const { alertId } = await publishAlert({ regulatory: false, templateId: 'tpl.expiry' });
    const response = await getDetail(principalFor(OWNER), alertId);
    // The regulatory join is LEFT: requiring it would turn "Kynviora knows less than usual" into
    // "not found".
    expect(response.statusCode).toBe(200);
    expect(response.json<DetailBody>().source.organization).toBeNull();
  });
});

describe('an explanation this build cannot write', () => {
  it('renders no narrative for an unapproved template identifier', async () => {
    const { alertId } = await publishAlert({ templateId: 'tpl.synthetic' });
    const body = (await getDetail(principalFor(OWNER), alertId)).json<DetailBody>();

    expect(body.message).toBeNull();
    expect(body.unexplainable?.heading).toBe(UNEXPLAINABLE.heading);
    // And still every fact, so the alert is not simply blank.
    expect(body.facts.length).toBeGreaterThan(5);
  });

  it('has approved wording for every reason the engine can produce on a match', () => {
    // The completeness check lives here rather than in the presentation package, because
    // `@kynviora/safety` is the server-side rule engine and DEC-010 keeps it out of anything that
    // ships to a phone. A new match reason without wording fails here rather than reaching a
    // screen as a code.
    const matchReasons = [
      'BATCH_CODE_MATCHED',
      'GTIN_MATCHED_BATCH_UNKNOWN',
      'FORMULATION_MATCHED',
      'SUBSTANCE_IN_DECLARATION',
      'PRODUCT_EXPIRED',
      'PRODUCT_EXPIRING_SOON',
    ] as const;

    for (const reason of matchReasons) {
      expect(MATCH_REASONS).toContain(reason);
      expect(MATCH_REASON_TEXT[reason]).toBeDefined();
    }
  });
});

describe('who may read an alert', () => {
  it('shows the owner their own', async () => {
    const { alertId } = await publishAlert();
    expect((await getDetail(principalFor(OWNER), alertId)).statusCode).toBe(200);
  });

  it('shows a caregiver holding both safety and medicine access the whole alert', async () => {
    await grant(CAREGIVER_SAFETY, ['VIEW_SAFETY', 'VIEW_MEDICINES']);
    const { alertId } = await publishAlert();
    const response = await getDetail(principalFor(CAREGIVER_SAFETY), alertId);
    expect(response.statusCode).toBe(200);
    expect(response.json<DetailBody>().withheldNotice).toBeNull();
    expect(response.json<DetailBody>().message).toHaveLength(8);
  });

  it('shows a caregiver holding only VIEW_SAFETY the alert, with the item withheld', async () => {
    // `03` group H keeps safety access separate from shelf access, and both facts are true at
    // once here: they are entitled to the alert and not to the medicine it is about. A 404 would
    // report an alert they may read as though it did not exist; a blank would look like Kynviora
    // not knowing. DEC-026 already settled that the withholding is reported.
    await grant(CAREGIVER_SAFETY, ['VIEW_SAFETY']);
    const { alertId } = await publishAlert();
    const response = await getDetail(principalFor(CAREGIVER_SAFETY), alertId);
    expect(response.statusCode).toBe(200);

    const body = response.json<DetailBody>();
    const item = body.facts.find((f) => f.label === 'Item');
    expect(item?.value).toBeNull();
    expect(item?.basis).toBe('WITHHELD_FROM_THIS_SESSION');
    expect(item?.basisText).toContain('your access does not include it');

    // The withheld half is not "Kynviora cannot explain this": it can, and is not showing all of
    // it to this session. Blaming the build for an access decision would be the wrong sentence.
    expect(body.message).toBeNull();
    expect(body.unexplainable).toBeNull();
    expect(body.withheldNotice).toContain('not shown here');

    // Everything the alert is actually about is still there.
    expect(body.urgency.label).toBe('Act soon');
    expect(body.evidence.label).toBe('Official action');
    expect(body.reasons.reasons.length).toBeGreaterThan(0);
  });

  it('refuses a caregiver holding only VIEW_MEDICINES, as absence', async () => {
    // The other direction, and it really is a not-found: without VIEW_SAFETY the alert row
    // itself is invisible, so there is nothing to withhold half of.
    await grant(CAREGIVER_NO_SAFETY, ['VIEW_MEDICINES']);
    const { alertId } = await publishAlert();
    const response = await getDetail(principalFor(CAREGIVER_NO_SAFETY), alertId);
    expect(response.statusCode).toBe(404);
  });

  it('refuses a stranger the same way', async () => {
    const { alertId } = await publishAlert();
    const stranger = await getDetail(principalFor(STRANGER), alertId);
    const missing = await getDetail(principalFor(OWNER), testUuid(999));
    expect(stranger.statusCode).toBe(missing.statusCode);
    expect(stranger.json<{ error: { code: string } }>().error.code).toBe(
      missing.json<{ error: { code: string } }>().error.code,
    );
  });

  it('answers a malformed identifier exactly as it answers an unknown one', async () => {
    const malformed = await getDetail(principalFor(OWNER), 'not-a-uuid');
    const unknown = await getDetail(principalFor(OWNER), testUuid(998));
    expect(malformed.statusCode).toBe(unknown.statusCode);

    // Everything but the correlation ID, which is per-request by design. A prober must not be
    // able to learn which of their guesses were well-formed.
    const strip = (raw: string) => {
      const body = JSON.parse(raw) as { error: Record<string, unknown> };
      const { correlationId: _drop, ...rest } = body.error;
      return rest;
    };
    expect(strip(malformed.body)).toEqual(strip(unknown.body));
  });

  it('rejects an unauthenticated request', async () => {
    const { alertId } = await publishAlert();
    expect((await getDetail(null, alertId)).statusCode).toBe(401);
  });
});

describe('a withdrawn alert', () => {
  it('is not readable at all, not readable-and-labelled', async () => {
    // `19` treats a stale withdrawn alert that is still actionable as a release-blocking defect.
    // `alert_publication`'s policy admits PUBLISHED only, so this is the database refusing rather
    // than the handler remembering.
    const { alertId } = await publishAlert({ withdrawn: true });
    const response = await getDetail(principalFor(OWNER), alertId);
    expect(response.statusCode).toBe(404);
  });

  it('is refused for the report-incorrect action too', async () => {
    const { alertId } = await publishAlert({ withdrawn: true });
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/alerts/${alertId}/report-incorrect`,
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('reporting a match as incorrect', () => {
  it('records a receipt and stops offering the action', async () => {
    const { alertId, assessmentId } = await publishAlert();

    const before = (await getDetail(principalFor(OWNER), alertId)).json<DetailBody>();
    expect(before.actions.map((a) => a.action)).toEqual(['REPORT_INCORRECT_MATCH']);

    const reported = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/alerts/${alertId}/report-incorrect`,
      payload: { note: 'This is not the product I have.' },
    });
    expect(reported.statusCode).toBe(201);
    expect(reported.json<{ alreadyReported: boolean }>().alreadyReported).toBe(false);

    const after = (await getDetail(principalFor(OWNER), alertId)).json<DetailBody>();
    expect(after.actions).toEqual([]);
    expect(after.actionsUnavailableBecause).toContain('already told Kynviora');

    const receipts = await t.asService((db) =>
      db.query<{ resolution: string; assessment_id: string; resolution_note: string }>(
        `SELECT resolution, assessment_id, resolution_note FROM safety_receipt
          WHERE alert_publication_id = $1`,
        [alertId],
      ),
    );
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]?.resolution).toBe('REPORTED_INCORRECT_MATCH');
    // The receipt references the assessment as well as the alert, so the record survives
    // whatever happens to either (`04` Phase 7.6: resolution never erases assessment).
    expect(receipts.rows[0]?.assessment_id).toBe(assessmentId);
  });

  it('changes nothing about the alert or the assessment', async () => {
    const { alertId, assessmentId } = await publishAlert();
    await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/alerts/${alertId}/report-incorrect`,
      payload: {},
    });

    const alert = await t.asService((db) =>
      db.query<{ state: string }>('SELECT state FROM alert_publication WHERE id = $1', [alertId]),
    );
    const assessment = await t.asService((db) =>
      db.query<{ matched: boolean; urgency: string }>(
        'SELECT matched, urgency FROM profile_assessment WHERE id = $1',
        [assessmentId],
      ),
    );
    // Feedback is not a correction. A person saying the match is wrong does not withdraw the
    // alert - that is a reviewer's decision through the console.
    expect(alert.rows[0]?.state).toBe('PUBLISHED');
    expect(assessment.rows[0]?.matched).toBe(true);
    expect(assessment.rows[0]?.urgency).toBe('HIGH');
  });

  it('is idempotent, and writes one receipt however many times it is called', async () => {
    const { alertId } = await publishAlert();
    for (const _ of [1, 2, 3]) {
      await request(principalFor(OWNER), {
        method: 'POST',
        url: `/v1/alerts/${alertId}/report-incorrect`,
        payload: {},
      });
    }
    const receipts = await t.asService((db) =>
      db.query<{ n: string }>(
        'SELECT count(*) AS n FROM safety_receipt WHERE alert_publication_id = $1',
        [alertId],
      ),
    );
    expect(Number(receipts.rows[0]?.n)).toBe(1);
  });

  it('says so on a repeat rather than pretending it was the first', async () => {
    const { alertId } = await publishAlert();
    await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/alerts/${alertId}/report-incorrect`,
      payload: {},
    });
    const again = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/alerts/${alertId}/report-incorrect`,
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ alreadyReported: boolean }>().alreadyReported).toBe(true);
  });

  it('refuses a caregiver who cannot see the alert', async () => {
    await grant(CAREGIVER_NO_SAFETY, ['VIEW_MEDICINES']);
    const { alertId } = await publishAlert();
    const response = await request(principalFor(CAREGIVER_NO_SAFETY), {
      method: 'POST',
      url: `/v1/alerts/${alertId}/report-incorrect`,
      payload: {},
    });
    expect(response.statusCode).toBe(404);

    const receipts = await t.asService((db) =>
      db.query<{ n: string }>(
        'SELECT count(*) AS n FROM safety_receipt WHERE alert_publication_id = $1',
        [alertId],
      ),
    );
    expect(Number(receipts.rows[0]?.n)).toBe(0);
  });

  it('keeps the note out of the audit detail', async () => {
    const { alertId } = await publishAlert();
    await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/alerts/${alertId}/report-incorrect`,
      payload: { note: 'a sentence about a medicine' },
    });

    const events = await t.asService((db) =>
      db.query<{ detail: unknown }>(
        `SELECT detail FROM audit_event
          WHERE action = 'alert.reported_incorrect' AND target_id = $1`,
        [alertId],
      ),
    );
    expect(events.rows).toHaveLength(1);
    // `14` forbids sensitive content in a log, and a free-text note about somebody's medicine is
    // exactly that. The audit records that a note exists, not what it says.
    expect(JSON.stringify(events.rows[0]?.detail)).not.toContain('a sentence about a medicine');
    expect(JSON.stringify(events.rows[0]?.detail)).toContain('note_recorded');
  });
});

describe('which ingredient matched which recorded sensitivity (DEV-028)', () => {
  /**
   * Until migration `0018` the assessment stored versions and reason codes but not identities, so
   * the alert detail could say *that* a substance in the declaration matched a recorded fact and
   * not *which* - and `explanationFor` refused to render `tpl.ingredient_sensitivity` rather than
   * name a substance it was guessing at.
   *
   * The route now resolves both by the identity the rule froze. It still never re-derives them:
   * intersecting the declaration with the profile's facts afresh is a different computation over
   * state that may have moved, and naming the wrong ingredient confidently is worse than naming
   * none (DEC-064, DEC-097).
   */

  it('names both in the approved wording', async () => {
    const { alertId } = await publishAlert({
      templateId: 'tpl.ingredient_sensitivity',
      reasons: ['SUBSTANCE_IN_DECLARATION'],
      matchedSubstanceKey: SUBSTANCE_KEY,
      matchedProfileFactId: ALLERGY_FACT,
      profileFactVersions: ['1'],
    });

    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/alerts/${alertId}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<DetailBody>();

    expect(body.message).not.toBeNull();
    const message = (body.message ?? []).join(' ');
    // The catalog's preferred name, not the canonical key: a key beside somebody's medicine is a
    // field value, not a phrase (trap 129).
    expect(message).toContain('Salicylic acid');
    expect(message).not.toContain(SUBSTANCE_KEY);
    // And the person's own words, quoted as theirs.
    expect(message).toContain('salicylates');
    expect(body.unexplainable).toBeNull();
  });

  it('says nothing about the sensitivity to a caregiver who may not read it', async () => {
    // `03` group H keeps safety access separate from medicine access, and `allergy_select`
    // requires VIEW_MEDICINES. A caregiver holding VIEW_SAFETY alone is entitled to the alert and
    // not to what the person is allergic to, so the narrative declines rather than the route
    // refusing - the same shape the withheld person and item names already have.
    await grant(CAREGIVER_SAFETY, ['VIEW_SAFETY']);
    const { alertId } = await publishAlert({
      templateId: 'tpl.ingredient_sensitivity',
      reasons: ['SUBSTANCE_IN_DECLARATION'],
      matchedSubstanceKey: SUBSTANCE_KEY,
      matchedProfileFactId: ALLERGY_FACT,
      profileFactVersions: ['1'],
    });

    const response = await request(principalFor(CAREGIVER_SAFETY), {
      method: 'GET',
      url: `/v1/alerts/${alertId}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<DetailBody>();

    // The alert is readable and the narrative is not rendered. `unexplainable` is deliberately
    // not asserted here: this caller cannot read the item either, so the view reports a withheld
    // half rather than an unrenderable template - two different absences with different notices,
    // and conflating them is how a caregiver would be told the rule was unknown.
    expect(body.alertPublicationId).toBe(alertId);
    expect(body.message).toBeNull();
    expect(body.withheldNotice).not.toBeNull();
    expect(JSON.stringify(body)).not.toContain('salicylates');
  });

  it('stops quoting a recorded term the person has since changed', async () => {
    // The identity is frozen; the words are not. `display_term` is the person's own account and
    // they may edit it, so quoting today's wording as what the rule matched would be a statement
    // about what happened that is not true.
    const { alertId } = await publishAlert({
      templateId: 'tpl.ingredient_sensitivity',
      reasons: ['SUBSTANCE_IN_DECLARATION'],
      matchedSubstanceKey: SUBSTANCE_KEY,
      matchedProfileFactId: ALLERGY_FACT,
      // The version the rule saw. The record below moves past it.
      profileFactVersions: ['1'],
    });

    await t.asService((db) =>
      db.query(
        `UPDATE allergy_record SET display_term = 'aspirin', version = version + 1 WHERE id = $1`,
        [ALLERGY_FACT],
      ),
    );

    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/alerts/${alertId}`,
    });
    const body = response.json<DetailBody>();
    expect(body.message).toBeNull();
    // Neither the old wording nor the new one: the point is that Kynviora cannot say which the
    // rule matched, not that it should show the newer guess.
    expect(JSON.stringify(body)).not.toContain('salicylates');
    expect(JSON.stringify(body)).not.toContain('aspirin');

    await t.asService((db) =>
      db.query(
        `UPDATE allergy_record SET display_term = 'salicylates', version = 1 WHERE id = $1`,
        [ALLERGY_FACT],
      ),
    );
  });

  it('renders nothing for an assessment written before the columns existed', async () => {
    // Every row from before migration `0018` carries NULL in both, and a route that filled the gap
    // by deriving it would be exactly the read-path computation `DEV-028` refused.
    const { alertId } = await publishAlert({
      templateId: 'tpl.ingredient_sensitivity',
      reasons: ['SUBSTANCE_IN_DECLARATION'],
    });

    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/alerts/${alertId}`,
    });
    const body = response.json<DetailBody>();
    expect(body.message).toBeNull();
    expect(body.unexplainable).not.toBeNull();
  });

  it('renders nothing when the catalog does not know the key', async () => {
    // A key from a vocabulary this build no longer carries resolves to no name, and a sentence
    // reading "This product's ingredient list includes null" is the failure the template's own
    // refusal exists to prevent.
    const { alertId } = await publishAlert({
      templateId: 'tpl.ingredient_sensitivity',
      reasons: ['SUBSTANCE_IN_DECLARATION'],
      matchedSubstanceKey: 'nothing.knows.this',
      matchedProfileFactId: ALLERGY_FACT,
      profileFactVersions: ['1'],
    });

    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/alerts/${alertId}`,
    });
    const body = response.json<DetailBody>();
    expect(body.message).toBeNull();
    expect(JSON.stringify(body)).not.toContain('nothing.knows.this');
  });
});
