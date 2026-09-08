import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * The Health record surface, against the real policies (`0032`, DEC-151, DEC-154, DEC-155).
 *
 * Four things are decided here rather than in the domain:
 *
 *  1. **Reading a lab history is its own permission**, and every other capability - including
 *     `VIEW_DOCUMENTS`, the near miss - buys none of it.
 *  2. **Provenance is derived from who is writing**, so a client cannot claim a reviewer
 *     confirmed a document (`04` Phase 1.3).
 *  3. **The comparison picks what to compare against**, once, on the server - which is the
 *     decision that would otherwise drift between the lab screen and the checkup screen.
 *  4. **No response says whether a value is medically normal.** The one comparison field is named
 *     for the interval the report printed and answers only that.
 */

const OWNER = testUuid(1);
/** VIEW_HEALTH_RECORDS only. */
const HEALTH_READER = testUuid(2);
/** VIEW_ + MANAGE_HEALTH_RECORDS. */
const HEALTH_MANAGER = testUuid(3);
/** Every capability except the two health ones, `VIEW_DOCUMENTS` included. */
const EVERYTHING_ELSE = testUuid(4);
const STRANGER = testUuid(5);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const SOURCE = testUuid(30);
const REPORT_AUG = testUuid(31);
const REPORT_SEP = testUuid(32);
const CHECKUP_2025 = testUuid(33);
const CHECKUP_2026 = testUuid(34);
const UNRELATED = testUuid(35);

const NOW = instantFrom('2026-09-08T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;

function principalFor(userId: string): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt: null };
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [HEALTH_READER, 'reader@example.test'],
      [HEALTH_MANAGER, 'manager@example.test'],
      [EVERYTHING_ELSE, 'everything@example.test'],
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

    for (const [user, capabilities] of [
      [HEALTH_READER, ['VIEW_HEALTH_RECORDS']],
      [HEALTH_MANAGER, ['VIEW_HEALTH_RECORDS', 'MANAGE_HEALTH_RECORDS']],
      [
        EVERYTHING_ELSE,
        [
          'VIEW_SAFETY',
          'VIEW_SHELF',
          'MANAGE_SHELF',
          'VIEW_MEDICINES',
          'RECORD_DOSES',
          'MANAGE_MEDICINES',
          'VIEW_CARE',
          'MANAGE_CARE',
          'VIEW_DOCUMENTS',
          'EXPORT_SUMMARY',
          'RECEIVE_MISSED_DOSE',
          'MANAGE_CAREGIVERS',
        ],
      ],
    ] as const) {
      await db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, $4::text[], 'ACTIVE', now())`,
        [PROFILE, user, OWNER, capabilities],
      );
    }
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
    now: (): Instant => NOW,
    loadSources: () => Promise.resolve(sources),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

/** One structured result, written as the service role during fixture setup. */
interface Fixture {
  readonly code: string;
  readonly name: string;
  readonly value: number | null;
  readonly text?: string;
  readonly unit?: string;
  readonly low?: number;
  readonly high?: number;
  readonly flag?: string;
}

beforeEach(async () => {
  await t.asService(async (db) => {
    await db.query('DELETE FROM health_measurement');
    await db.query('DELETE FROM health_observation');
    await db.query('DELETE FROM health_record');
    await db.query('DELETE FROM health_source');

    await db.query(
      `INSERT INTO health_source
         (id, profile_id, source_kind, display_name, connection_state, last_received_at)
       VALUES ($1, $2, 'IMPORTED_DOCUMENT', 'Metropolis Diagnostics (synthetic)',
               'IMPORTED_ONCE', now())`,
      [SOURCE, PROFILE],
    );
    // A source that was designed and never built. `21` of the V3 brief: do not imply a real
    // integration that does not exist.
    await db.query(
      `INSERT INTO health_source (profile_id, source_kind, display_name, connection_state)
       VALUES ($1, 'HEALTH_KIT', 'Apple Health', 'DESIGNED_NOT_IMPLEMENTED')`,
      [PROFILE],
    );

    const record = async (
      id: string,
      kind: string,
      title: string,
      on: string,
      results: readonly Fixture[],
    ) => {
      await db.query(
        `INSERT INTO health_record
           (id, profile_id, record_kind, title, provider_name, recorded_on, source_id,
            extraction_state, provenance)
         VALUES ($1, $2, $3, $4, 'Metropolis Diagnostics (synthetic)', $5::date, $6,
                 'ENTERED_BY_HAND', 'USER_REPORTED')`,
        [id, PROFILE, kind, title, on, SOURCE],
      );
      let sequence = 0;
      for (const r of results) {
        await db.query(
          `INSERT INTO health_observation
             (record_id, profile_id, analyte_code, display_name, sequence, value_numeric,
              value_text, unit, decimals, reference_low, reference_high, source_flag)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11)`,
          [
            id,
            PROFILE,
            r.code,
            r.name,
            sequence,
            r.value,
            r.text ?? null,
            r.unit ?? 'mIU/L',
            r.low ?? null,
            r.high ?? null,
            r.flag ?? null,
          ],
        );
        sequence += 1;
      }
    };

    await record(REPORT_AUG, 'LAB_REPORT', 'Thyroid panel', '2026-08-12', [
      { code: 'tsh', name: 'TSH', value: 4.8, low: 0.4, high: 4.0, flag: 'HIGH' },
      { code: 'ft4', name: 'Free T4', value: 15.1, unit: 'pmol/L', low: 12, high: 22 },
      { code: 'b12', name: 'Vitamin B12', value: 410, unit: 'pg/mL' },
    ]);
    await record(REPORT_SEP, 'LAB_REPORT', 'Thyroid repeat', '2026-09-02', [
      { code: 'tsh', name: 'TSH', value: 5.2, low: 0.4, high: 4.0, flag: 'HIGH' },
      { code: 'ft4', name: 'Free T4', value: 15.4, unit: 'pmol/L', low: 12, high: 22 },
      { code: 'vitd', name: 'Vitamin D', value: 28, unit: 'ng/mL' },
    ]);
    await record(CHECKUP_2025, 'ANNUAL_CHECKUP', 'Annual Health Check 2025', '2025-09-01', [
      { code: 'tsh', name: 'TSH', value: 4.8, low: 0.4, high: 4.0 },
    ]);
    await record(CHECKUP_2026, 'ANNUAL_CHECKUP', 'Annual Health Check 2026', '2026-09-01', [
      { code: 'tsh', name: 'TSH', value: 5.2, low: 0.4, high: 4.0 },
    ]);
    // Shares no analyte with anything, so it must not be chosen as anybody's comparison.
    await record(UNRELATED, 'LAB_REPORT', 'Lipids', '2026-08-20', [
      { code: 'ldl', name: 'LDL', value: 3.2, unit: 'mmol/L' },
    ]);

    await db.query(
      `INSERT INTO health_measurement
         (profile_id, metric, measured_at, value_numeric, value_secondary, unit, source_id,
          device_name)
       VALUES ($1, 'BLOOD_PRESSURE', '2026-09-05T08:00:00Z', 128, 82, 'mmHg', $2, 'Home monitor'),
              ($1, 'BLOOD_PRESSURE', '2026-09-07T08:00:00Z', 132, 84, 'mmHg', $2, 'Home monitor'),
              ($1, 'BODY_WEIGHT', '2026-09-06T07:00:00Z', 71.4, NULL, 'kg', $2, 'Scale')`,
      [PROFILE, SOURCE],
    );
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

interface ObservationBody {
  readonly analyteCode: string;
  readonly displayName: string;
  readonly valueNumeric: number | null;
  readonly valueText: string | null;
  readonly unit: string | null;
  readonly decimals: number;
  readonly reference: { low: number | null; high: number | null; text: string | null } | null;
  readonly referenceComparison: string;
  readonly sourceFlag: string | null;
}

interface RecordBody {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly recordedOn: string | null;
  readonly extractionState: string;
  readonly provenance: string;
  readonly observationCount: number;
  readonly sourceFlaggedCount: number;
  readonly hasDocument: boolean;
}

// ---------------------------------------------------------------------------

describe('who may read the Health record', () => {
  const routes = (profileId: string) => [
    `/v1/profiles/${profileId}/health-sources`,
    `/v1/profiles/${profileId}/health-records`,
    `/v1/profiles/${profileId}/health-measurements`,
    `/v1/profiles/${profileId}/health-timeline`,
  ];

  it('answers the owner with data on every list route', async () => {
    for (const url of routes(PROFILE)) {
      const response = await request(principalFor(OWNER), { method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      const body = response.json<Record<string, unknown[]>>();
      const list = Object.values(body)[0] ?? [];
      expect(list.length, url).toBeGreaterThan(0);
    }
  });

  it('answers a caregiver holding VIEW_HEALTH_RECORDS with the same data', async () => {
    const response = await request(principalFor(HEALTH_READER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/health-records`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ records: RecordBody[] }>().records.length).toBeGreaterThan(0);
  });

  it('answers a caregiver holding every other capability with nothing', async () => {
    // DEC-154's claim at the API boundary. `VIEW_DOCUMENTS` is in this grant and buys nothing
    // here, which is the whole reason the capability was added rather than reused.
    for (const url of routes(PROFILE)) {
      const response = await request(principalFor(EVERYTHING_ELSE), { method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      const body = response.json<Record<string, unknown[]>>();
      expect(Object.values(body)[0], url).toEqual([]);
    }
  });

  it('answers a stranger with nothing rather than with a refusal', async () => {
    // `13`: a profile ID narrows rather than grants, so an ID that is not yours reads as absent.
    for (const url of routes(PROFILE)) {
      const response = await request(principalFor(STRANGER), { method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(Object.values(response.json<Record<string, unknown[]>>())[0], url).toEqual([]);
    }
  });

  it('gives an unknown record and an unreadable one the same 404', async () => {
    const mine = await request(principalFor(STRANGER), {
      method: 'GET',
      url: `/v1/health-records/${REPORT_SEP}`,
    });
    const nothing = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${testUuid(99)}`,
    });
    expect(mine.statusCode).toBe(404);
    expect(nothing.statusCode).toBe(404);
    expect(mine.json<{ error: { code: string } }>().error.code).toBe(
      nothing.json<{ error: { code: string } }>().error.code,
    );
  });

  it('answers a malformed identifier exactly as an unknown one', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: '/v1/health-records/not-a-uuid',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('a record and its results', () => {
  it('returns the structured results in the report’s own order', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${REPORT_SEP}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ record: RecordBody; observations: ObservationBody[] }>();
    expect(body.observations.map((o) => o.analyteCode)).toEqual(['tsh', 'ft4', 'vitd']);
    expect(body.record.observationCount).toBe(3);
  });

  it('counts only the results the report itself flagged', async () => {
    // `sourceFlaggedCount`, never `abnormalCount`. The count is of quotations.
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${REPORT_SEP}`,
    });
    expect(response.json<{ record: RecordBody }>().record.sourceFlaggedCount).toBe(1);
  });

  it('says where a value sits relative to the interval the report printed, and nothing more', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${REPORT_SEP}`,
    });
    const observations = response.json<{ observations: ObservationBody[] }>().observations;
    const tsh = observations.find((o) => o.analyteCode === 'tsh');
    const ft4 = observations.find((o) => o.analyteCode === 'ft4');
    const vitd = observations.find((o) => o.analyteCode === 'vitd');
    expect(tsh?.referenceComparison).toBe('OUTSIDE_ABOVE');
    expect(ft4?.referenceComparison).toBe('WITHIN');
    // No interval on the report, so no comparison. Not "fine", not "unknown risk".
    expect(vitd?.referenceComparison).toBe('NO_INTERVAL');
  });

  it('has no field anywhere in the response that states a clinical verdict', () => {
    // DEC-155's structural half at the wire. If somebody adds `isAbnormal`, `interpretation` or a
    // `normal` flag to a view, this fails.
    return request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${REPORT_SEP}`,
    }).then((response) => {
      const raw = response.body.toLowerCase();
      for (const forbidden of ['isabnormal', 'interpretation', '"severity"', '"normal"']) {
        expect(raw, forbidden).not.toContain(forbidden);
      }
      expect(raw).toContain('sourceflag');
      expect(raw).toContain('referencecomparison');
    });
  });

  it('reports whether a document exists without handing out a way to reach it', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${REPORT_SEP}`,
    });
    expect(response.json<{ record: RecordBody }>().record.hasDocument).toBe(false);
    expect(response.body).not.toContain('documentAssetId');
    expect(response.body).not.toContain('storage_key');
  });

  it('filters the list by kind', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/health-records?kind=ANNUAL_CHECKUP`,
    });
    const records = response.json<{ records: RecordBody[] }>().records;
    expect(records.map((r) => r.title)).toEqual([
      'Annual Health Check 2026',
      'Annual Health Check 2025',
    ]);
  });
});

describe('adding a record', () => {
  const body = {
    kind: 'LAB_REPORT',
    title: 'Typed in by hand',
    providerName: 'A clinic (synthetic)',
    recordedOn: '2026-09-08',
    sourceId: null,
    note: null,
    observations: [
      {
        analyteCode: 'na',
        displayName: 'Sodium',
        valueNumeric: 141,
        valueText: null,
        unit: 'mmol/L',
        decimals: 0,
        reference: { low: 135, high: 145, text: null },
        sourceFlag: null,
      },
    ],
  };

  it('lets the owner add a record with its results in one write', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/profiles/${PROFILE}/health-records`,
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    const created = response.json<{ record: RecordBody }>().record;
    expect(created.observationCount).toBe(1);

    const read = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${created.id}`,
    });
    expect(read.json<{ observations: ObservationBody[] }>().observations[0]?.valueNumeric).toBe(
      141,
    );
  });

  it('derives provenance from who wrote it rather than from the request', async () => {
    // `04` Phase 1.3, enforced by absence: there is no field a client could set.
    const byOwner = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/profiles/${PROFILE}/health-records`,
      payload: body,
    });
    const byCaregiver = await request(principalFor(HEALTH_MANAGER), {
      method: 'POST',
      url: `/v1/profiles/${PROFILE}/health-records`,
      payload: { ...body, title: 'Typed in by a caregiver' },
    });
    expect(byOwner.json<{ record: RecordBody }>().record.provenance).toBe('USER_REPORTED');
    expect(byCaregiver.json<{ record: RecordBody }>().record.provenance).toBe('CAREGIVER_ENTERED');
  });

  it('records a hand-typed record as hand-typed, never as extracted', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/profiles/${PROFILE}/health-records`,
      payload: body,
    });
    expect(response.json<{ record: RecordBody }>().record.extractionState).toBe('ENTERED_BY_HAND');
  });

  it('refuses a body that tries to set provenance or extraction state', async () => {
    // `.strict()`: an unknown key is a refusal rather than something silently dropped, so a
    // client that believed it had set one is told otherwise.
    for (const extra of [
      { provenance: 'REVIEWER_CONFIRMED' },
      { extractionState: 'EXTRACTED_CONFIRMED' },
    ]) {
      const response = await request(principalFor(OWNER), {
        method: 'POST',
        url: `/v1/profiles/${PROFILE}/health-records`,
        payload: { ...body, ...extra },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('refuses a write from a caregiver who may only read', async () => {
    const response = await request(principalFor(HEALTH_READER), {
      method: 'POST',
      url: `/v1/profiles/${PROFILE}/health-records`,
      payload: body,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a write from a caregiver holding every other capability', async () => {
    const response = await request(principalFor(EVERYTHING_ELSE), {
      method: 'POST',
      url: `/v1/profiles/${PROFILE}/health-records`,
      payload: body,
    });
    expect(response.statusCode).toBe(404);
  });

  it('names the field when a result has no value', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/profiles/${PROFILE}/health-records`,
      payload: {
        ...body,
        observations: [{ ...body.observations[0], valueNumeric: null, valueText: null }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a malformed date rather than storing today', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/profiles/${PROFILE}/health-records`,
      payload: { ...body, recordedOn: '8 September 2026' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_DATE');
  });
});

describe('comparing two records', () => {
  interface ComparisonBody {
    readonly current: RecordBody;
    readonly previous: RecordBody | null;
    readonly comparison: {
      readonly interval: string;
      readonly thresholdStatement: string;
      readonly counts: Record<string, number>;
      readonly comparedCount: number;
      readonly entries: readonly { readonly key: string; readonly classification: string }[];
    } | null;
  }

  it('compares a repeat panel against the earlier one that shares an analyte', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${REPORT_SEP}/comparison`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ComparisonBody>();
    expect(body.previous?.id).toBe(REPORT_AUG);
    expect(body.comparison?.interval).toBe('REPEAT');
    // tsh 4.8 -> 5.2 is +8.3%, past a twentieth. ft4 15.1 -> 15.4 is +2%, not past it.
    expect(body.comparison?.counts).toEqual({
      CHANGED: 1,
      NEW: 1,
      NOT_REPEATED: 1,
      SIMILAR: 1,
    });
    expect(body.comparison?.comparedCount).toBe(2);
  });

  it('never chooses a record that shares no analyte, even when it is more recent', async () => {
    // `Lipids` is dated between the two thyroid panels and has nothing in common with either. A
    // comparison against it would report everything as new and everything as not repeated, which
    // reads as a finding and is an artefact of the choice.
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${REPORT_SEP}/comparison`,
    });
    expect(response.json<ComparisonBody>().previous?.id).not.toBe(UNRELATED);
  });

  it('uses the year-on-year threshold for two annual checks', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${CHECKUP_2026}/comparison`,
    });
    const body = response.json<ComparisonBody>();
    expect(body.previous?.id).toBe(CHECKUP_2025);
    expect(body.comparison?.interval).toBe('PERIODIC');
    // The identical pair of values that counted as a change on a repeat does not, a year apart.
    expect(body.comparison?.counts.CHANGED).toBe(0);
    expect(body.comparison?.counts.SIMILAR).toBe(1);
  });

  it('never compares an annual check with a lab report', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${CHECKUP_2026}/comparison`,
    });
    expect(response.json<ComparisonBody>().previous?.kind).toBe('ANNUAL_CHECKUP');
  });

  it('carries the sentence the screen must print beside the counts', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${CHECKUP_2026}/comparison`,
    });
    expect(response.json<ComparisonBody>().comparison?.thresholdStatement).toMatch(/a tenth/);
  });

  it('says plainly that there is nothing to compare with, rather than returning an empty comparison', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/health-records/${REPORT_AUG}/comparison`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ComparisonBody>();
    expect(body.previous).toBeNull();
    expect(body.comparison).toBeNull();
  });

  it('refuses a comparison on a record the caller cannot read', async () => {
    const response = await request(principalFor(EVERYTHING_ELSE), {
      method: 'GET',
      url: `/v1/health-records/${REPORT_SEP}/comparison`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('measurements', () => {
  interface MeasurementBody {
    readonly metric: string;
    readonly measuredAt: string;
    readonly value: number;
    readonly secondary: number | null;
    readonly unit: string;
    readonly deviceName: string | null;
  }

  it('returns a blood pressure as one reading with both numbers', async () => {
    // Two rows could be re-paired wrongly by a filter or a page boundary, and a chart drawn from
    // that shows a systolic against somebody else's diastolic.
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/health-measurements?metric=BLOOD_PRESSURE`,
    });
    const measurements = response.json<{ measurements: MeasurementBody[] }>().measurements;
    expect(measurements).toHaveLength(2);
    expect(measurements[0]?.value).toBe(128);
    expect(measurements[0]?.secondary).toBe(82);
  });

  it('returns points in time order, so a chart reads the array as drawn', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/health-measurements?metric=BLOOD_PRESSURE`,
    });
    const at = response
      .json<{ measurements: MeasurementBody[] }>()
      .measurements.map((m) => m.measuredAt);
    expect([...at].sort()).toEqual(at);
  });

  it('leaves a single-valued metric with no second number', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/health-measurements?metric=BODY_WEIGHT`,
    });
    const measurements = response.json<{ measurements: MeasurementBody[] }>().measurements;
    expect(measurements[0]?.secondary).toBeNull();
    expect(measurements[0]?.value).toBeCloseTo(71.4, 5);
  });

  it('refuses an unknown metric rather than answering with everything', async () => {
    // The dangerous failure is the quiet one: an unrecognised filter silently ignored returns
    // every metric, and a chart labelled "blood pressure" then plots weights.
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/health-measurements?metric=MOOD`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('narrows by time without inventing anything in the gap', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/health-measurements?since=2026-09-06T00:00:00.000Z`,
    });
    const measurements = response.json<{ measurements: MeasurementBody[] }>().measurements;
    expect(measurements).toHaveLength(2);
  });
});

describe('the timeline', () => {
  interface TimelineBody {
    readonly entries: readonly {
      readonly entryKind: string;
      readonly title: string;
      readonly occurredAt: string;
    }[];
  }

  it('puts records and sources in one list, newest first', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/health-timeline`,
    });
    const entries = response.json<TimelineBody>().entries;
    expect(entries.length).toBeGreaterThan(0);
    const times = entries.map((e) => e.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(entries.map((e) => e.entryKind)).toContain('RECORD');
    expect(entries.map((e) => e.entryKind)).toContain('SOURCE');
  });
});

describe('sources say what they are honestly', () => {
  interface SourcesBody {
    readonly sources: readonly { readonly displayName: string; readonly connectionState: string }[];
  }

  it('reports an unbuilt integration as designed rather than as an empty connection', async () => {
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/health-sources`,
    });
    const sources = response.json<SourcesBody>().sources;
    const apple = sources.find((s) => s.displayName === 'Apple Health');
    expect(apple?.connectionState).toBe('DESIGNED_NOT_IMPLEMENTED');
    // And nothing in the list claims to be live, because nothing is.
    expect(sources.map((s) => s.connectionState)).not.toContain('CONNECTED');
  });
});
