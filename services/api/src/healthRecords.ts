/**
 * The Health record surface.
 *
 *   GET  /v1/profiles/:profileId/health-sources        - where this person's health data comes from
 *   GET  /v1/profiles/:profileId/health-records        - the Records layer, newest first
 *   POST /v1/profiles/:profileId/health-records        - add a record and its results in one write
 *   GET  /v1/health-records/:recordId                  - one record with its structured results
 *   GET  /v1/health-records/:recordId/comparison       - this record against the comparable one before it
 *   GET  /v1/profiles/:profileId/health-measurements   - the Trends layer, for one metric
 *   GET  /v1/profiles/:profileId/health-timeline       - the History layer, across all four kinds
 *
 * Spec references: `13` (runtime validation both directions, stable error codes, an ID in a
 * request is never proof of access, idempotency on retriable mutations), `14` (deny by default),
 * `09`/`10` (a source fact and a Kynviora conclusion are different things), `04` Phase 1.3
 * (provenance is derived from who is writing), migration `0032`, DEC-154, DEC-155.
 *
 * AUTHORIZATION IS ROW-LEVEL SECURITY AND THERE IS NO CAPABILITY CHECK IN THIS FILE
 * `0032` requires `VIEW_HEALTH_RECORDS` to read and `MANAGE_HEALTH_RECORDS` to write, and the
 * policies are evaluated per access so a revoked grant takes effect immediately. A handler that
 * re-checked would be a second opinion that can disagree with the first, which is worse than no
 * opinion at all. A profile ID that is not the caller's produces zero rows, and zero rows is a
 * 404 - the same answer an unknown ID gets, because `13` says an ID must narrow rather than grant.
 *
 * THE COMPARISON ENDPOINT IS WHY THIS IS A ROUTE AND NOT FOUR QUERIES ON THE CLIENT
 * "What changed" has to be computed once. `packages/domain/src/changeLens.ts` is that rule, and
 * running it on the server means the phone, a future web surface and an export all get the same
 * counts. It also means the *choice of what to compare against* is made in one place, which is
 * the part that would otherwise drift: the previous comparable record is the most recent earlier
 * record of the same kind that has at least one analyte in common, and "in common" is a query.
 *
 * WHAT NO RESPONSE HERE CONTAINS
 * Any field saying whether a value is normal, healthy, concerning or in range in a clinical
 * sense. `referenceComparison` answers where a number sits relative to the interval the report
 * printed and the field is called `referenceComparison` for that reason. The report's own flag
 * travels as `sourceFlag` beside a sentence whose subject is the report.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  compareHealthRecords,
  decimalsFor,
  domainError,
  isErr,
  isHealthMetric,
  normalizeHealthRecordDraft,
  referenceComparison,
  type ChangeSummary,
  type DomainError,
  type HealthMetric,
  type HealthRecordKind,
  type ExtractionState,
  type ReferenceComparison,
  type ReferenceInterval,
  type SourceFlag,
  type StoredObservation,
} from '@kynviora/domain';
import type { RequestContext } from './context.js';

export interface HealthRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
}

const uuidSchema = z.string().uuid();
const profileParamsSchema = z.object({ profileId: uuidSchema });
const recordParamsSchema = z.object({ recordId: uuidSchema });

/**
 * A record somebody is adding, with its results.
 *
 * `.strict()` for the reason every other body schema here is strict: a key this build does not
 * know about is a refusal rather than something silently dropped. There is deliberately no
 * `provenance` and no `extractionState` - both are derived, and a client that could send either
 * could claim a reviewer confirmed a document (`04` Phase 1.3).
 */
const referenceSchema = z
  .object({
    low: z.number().finite().nullable().default(null),
    high: z.number().finite().nullable().default(null),
    text: z.string().max(200).nullable().default(null),
  })
  .strict();

const observationSchema = z
  .object({
    analyteCode: z.string().min(1).max(64),
    displayName: z.string().min(1).max(200),
    valueNumeric: z.number().finite().nullable().default(null),
    valueText: z.string().max(200).nullable().default(null),
    unit: z.string().max(32).nullable().default(null),
    decimals: z.number().int().min(0).max(6).nullable().default(null),
    reference: referenceSchema.nullable().default(null),
    sourceFlag: z
      .enum(['HIGH', 'LOW', 'ABNORMAL', 'CRITICAL', 'BORDERLINE', 'FLAGGED'])
      .nullable()
      .default(null),
  })
  .strict();

const createRecordSchema = z
  .object({
    kind: z.enum([
      'LAB_REPORT',
      'ANNUAL_CHECKUP',
      'CLINICAL_LETTER',
      'IMAGING_REPORT',
      'VACCINATION',
      'PROCEDURE',
      'PRESCRIPTION',
      'DISCHARGE_SUMMARY',
      'OTHER_DOCUMENT',
    ]),
    title: z.string().min(1).max(200),
    providerName: z.string().max(200).nullable().default(null),
    recordedOn: z.string().nullable().default(null),
    sourceId: uuidSchema.nullable().default(null),
    note: z.string().max(2000).nullable().default(null),
    // At most fifty results per record. A panel with more than that is a document to attach
    // rather than a body to post, and an unbounded array is a body-size limit `13` asks for.
    observations: z.array(observationSchema).max(50).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Row shapes and views
// ---------------------------------------------------------------------------

interface SourceRow {
  readonly id: string;
  readonly source_kind: string;
  readonly display_name: string;
  readonly connection_state: string;
  readonly last_received_at: Date | string | null;
  readonly updated_at: Date | string | null;
}

interface RecordRow {
  readonly id: string;
  readonly profile_id: string;
  readonly record_kind: string;
  readonly title: string;
  readonly provider_name: string | null;
  readonly recorded_on: Date | string | null;
  readonly source_id: string | null;
  readonly document_asset_id: string | null;
  readonly extraction_state: string;
  readonly provenance: string;
  readonly note: string | null;
  readonly version: number;
  readonly updated_at: Date | string | null;
  readonly observation_count?: string | number;
  readonly flagged_count?: string | number;
}

interface ObservationRow {
  readonly id: string;
  readonly record_id: string;
  readonly analyte_code: string;
  readonly display_name: string;
  readonly sequence: number;
  readonly value_numeric: string | number | null;
  readonly value_text: string | null;
  readonly unit: string | null;
  readonly decimals: number | null;
  readonly reference_low: string | number | null;
  readonly reference_high: string | number | null;
  readonly reference_text: string | null;
  readonly source_flag: string | null;
}

interface MeasurementRow {
  readonly id: string;
  readonly metric: string;
  readonly measured_at: Date | string;
  readonly value_numeric: string | number;
  readonly value_secondary: string | number | null;
  readonly unit: string;
  readonly source_id: string | null;
  readonly device_name: string | null;
}

/** Trap 45: a `Date` from the driver must not reach a `z.string()` response schema. */
function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function dateOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

/**
 * `numeric` arrives as a string from the driver, because a Postgres `numeric` does not fit a
 * JavaScript number in general.
 *
 * Converted here rather than left as a string, because every consumer wants arithmetic - and
 * converted with `Number` rather than `parseFloat`, so `'12abc'` becomes `NaN` and is caught
 * rather than silently becoming 12. A lab value that lost its tail would be a wrong measurement
 * rendered confidently.
 */
function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface HealthSourceView {
  readonly id: string;
  readonly sourceKind: string;
  readonly displayName: string;
  readonly connectionState: string;
  readonly lastReceivedAt: string | null;
}

function sourceView(row: SourceRow): HealthSourceView {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    displayName: row.display_name,
    connectionState: row.connection_state,
    lastReceivedAt: isoOrNull(row.last_received_at),
  };
}

export interface HealthObservationView {
  readonly id: string;
  readonly analyteCode: string;
  readonly displayName: string;
  readonly sequence: number;
  readonly valueNumeric: number | null;
  readonly valueText: string | null;
  readonly unit: string | null;
  readonly decimals: number;
  readonly reference: ReferenceInterval | null;
  /**
   * Where the number sits relative to the interval **the report printed**.
   *
   * Named for exactly that. It is not a clinical judgement and the vocabulary has no member that
   * could be read as one (DEC-155).
   */
  readonly referenceComparison: ReferenceComparison;
  readonly sourceFlag: SourceFlag | null;
}

function observationView(row: ObservationRow): HealthObservationView {
  const low = numberOrNull(row.reference_low);
  const high = numberOrNull(row.reference_high);
  const reference: ReferenceInterval | null =
    low === null && high === null && row.reference_text === null
      ? null
      : { low, high, text: row.reference_text };
  const valueNumeric = numberOrNull(row.value_numeric);
  return {
    id: row.id,
    analyteCode: row.analyte_code,
    displayName: row.display_name,
    sequence: row.sequence,
    valueNumeric,
    valueText: row.value_text,
    unit: row.unit,
    decimals: decimalsFor({ decimals: row.decimals }),
    reference,
    referenceComparison: referenceComparison(valueNumeric, reference),
    sourceFlag: row.source_flag as SourceFlag | null,
  };
}

function toStored(row: ObservationRow): StoredObservation {
  const view = observationView(row);
  return {
    analyteCode: view.analyteCode,
    displayName: view.displayName,
    valueNumeric: view.valueNumeric,
    valueText: view.valueText,
    unit: view.unit,
    decimals: row.decimals,
    reference: view.reference,
    sourceFlag: view.sourceFlag,
  };
}

export interface HealthRecordView {
  readonly id: string;
  readonly profileId: string;
  readonly kind: HealthRecordKind;
  readonly title: string;
  readonly providerName: string | null;
  readonly recordedOn: string | null;
  readonly sourceId: string | null;
  readonly hasDocument: boolean;
  readonly extractionState: ExtractionState;
  readonly provenance: string;
  readonly note: string | null;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly observationCount: number;
  /** How many results **the report itself** flagged. Never a count Kynviora produced. */
  readonly sourceFlaggedCount: number;
}

function countOf(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordView(row: RecordRow): HealthRecordView {
  return {
    id: row.id,
    profileId: row.profile_id,
    kind: row.record_kind as HealthRecordKind,
    title: row.title,
    providerName: row.provider_name,
    recordedOn: dateOrNull(row.recorded_on),
    sourceId: row.source_id,
    // Whether a document exists, not where it is. A storage key on a list response would be a
    // way to reach an asset without going through the route that checks whether you may.
    hasDocument: row.document_asset_id !== null,
    extractionState: row.extraction_state as ExtractionState,
    provenance: row.provenance,
    note: row.note,
    version: row.version,
    updatedAt: isoOrNull(row.updated_at),
    observationCount: countOf(row.observation_count),
    sourceFlaggedCount: countOf(row.flagged_count),
  };
}

export interface HealthMeasurementView {
  readonly id: string;
  readonly metric: HealthMetric;
  readonly measuredAt: string;
  readonly value: number;
  /** The second half of a paired reading - diastolic, on a blood pressure. Null otherwise. */
  readonly secondary: number | null;
  readonly unit: string;
  readonly sourceId: string | null;
  readonly deviceName: string | null;
}

function measurementView(row: MeasurementRow): HealthMeasurementView {
  return {
    id: row.id,
    metric: row.metric as HealthMetric,
    measuredAt: isoOrNull(row.measured_at) ?? '',
    value: numberOrNull(row.value_numeric) ?? 0,
    secondary: numberOrNull(row.value_secondary),
    unit: row.unit,
    sourceId: row.source_id,
    deviceName: row.device_name,
  };
}

const RECORD_COLUMNS = `id, profile_id, record_kind, title, provider_name, recorded_on, source_id,
                        document_asset_id, extraction_state, provenance, note, version, updated_at`;

/**
 * The same columns aliased for the list query, written out rather than derived from the string
 * above. Deriving them by splitting on commas worked and was one refactor away from producing
 * `r.reference_low` for a column that is not on that table - a query that fails at run time, in a
 * route, for a reason nobody reading either constant would see.
 */
const RECORD_COLUMNS_PREFIXED = `r.id, r.profile_id, r.record_kind, r.title, r.provider_name,
                                 r.recorded_on, r.source_id, r.document_asset_id,
                                 r.extraction_state, r.provenance, r.note, r.version, r.updated_at`;

const OBSERVATION_COLUMNS = `id, record_id, analyte_code, display_name, sequence, value_numeric,
                             value_text, unit, decimals, reference_low, reference_high,
                             reference_text, source_flag`;

/**
 * Run a write that row-level security may refuse, and report the refusal as an absence.
 *
 * The same shape the rest of this service uses. Only the insufficient-privilege code is mapped:
 * anything else is a real failure and must not be disguised as a missing profile.
 */
async function writeOrRefusal<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown }).code;
    if (code === '42501' || /row-level security|permission denied/i.test(message)) return null;
    throw error;
  }
}

export function registerHealthRecordRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  const { contextFor, fail } = deps;

  // A profile the caller may not read and a profile that does not exist give the same answer.
  const noSuchProfile = () => domainError('NOT_FOUND', 'No such profile.');
  const noSuchRecord = () => domainError('NOT_FOUND', 'No such health record.');

  // -------------------------------------------------------------------------
  // GET /v1/profiles/:profileId/health-sources
  // -------------------------------------------------------------------------
  app.get<{ Params: { profileId: string } }>(
    '/v1/profiles/:profileId/health-sources',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;
      const params = profileParamsSchema.safeParse(request.params);
      if (!params.success) return fail(reply, noSuchProfile(), ctx.correlationId);

      const result = await ctx.db((db) =>
        db.query<SourceRow>(
          `SELECT id, source_kind, display_name, connection_state, last_received_at, updated_at
             FROM health_source
            WHERE profile_id = $1 AND deleted_at IS NULL
            ORDER BY display_name`,
          [params.data.profileId],
        ),
      );
      return reply.send({ sources: result.rows.map(sourceView) });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/profiles/:profileId/health-records
  // -------------------------------------------------------------------------
  app.get<{ Params: { profileId: string }; Querystring: { kind?: string; limit?: string } }>(
    '/v1/profiles/:profileId/health-records',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;
      const params = profileParamsSchema.safeParse(request.params);
      if (!params.success) return fail(reply, noSuchProfile(), ctx.correlationId);

      const query = z
        .object({
          kind: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .safeParse(request.query ?? {});
      if (!query.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid query.', { reason_code: 'query_schema' }),
          ctx.correlationId,
        );
      }

      // The counts come from the database rather than from a second round trip, so a list of
      // forty records is one query and the count beside each row cannot disagree with the rows
      // the detail route would return.
      const result = await ctx.db((db) =>
        db.query<RecordRow>(
          `SELECT ${RECORD_COLUMNS_PREFIXED},
                  (SELECT count(*) FROM health_observation o
                    WHERE o.record_id = r.id AND o.deleted_at IS NULL) AS observation_count,
                  (SELECT count(*) FROM health_observation o
                    WHERE o.record_id = r.id AND o.deleted_at IS NULL
                      AND o.source_flag IS NOT NULL) AS flagged_count
             FROM health_record r
            WHERE r.profile_id = $1 AND r.deleted_at IS NULL
              AND ($2::text IS NULL OR r.record_kind = $2)
            ORDER BY r.recorded_on DESC NULLS LAST, r.created_at DESC
            LIMIT $3`,
          [params.data.profileId, query.data.kind ?? null, query.data.limit],
        ),
      );
      return reply.send({ records: result.rows.map(recordView) });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/profiles/:profileId/health-records
  // -------------------------------------------------------------------------
  app.post<{ Params: { profileId: string } }>(
    '/v1/profiles/:profileId/health-records',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;
      const params = profileParamsSchema.safeParse(request.params);
      if (!params.success) return fail(reply, noSuchProfile(), ctx.correlationId);

      const body = createRecordSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
          ctx.correlationId,
        );
      }

      const normalized = normalizeHealthRecordDraft({
        kind: body.data.kind,
        title: body.data.title,
        providerName: body.data.providerName,
        recordedOn: body.data.recordedOn,
        sourceId: body.data.sourceId,
        note: body.data.note,
        observations: body.data.observations,
      });
      if (isErr(normalized)) return fail(reply, normalized.error, ctx.correlationId);
      const draft = normalized.value;

      // `04` Phase 1.3: provenance is derived from who is writing, never sent. A record typed by
      // the profile's owner is USER_REPORTED; one typed by a caregiver is CAREGIVER_ENTERED.
      // `IMPORTED` and `REVIEWER_CONFIRMED` are unreachable from this surface, which is what
      // makes "no OCR result silently becomes a confirmed record" true by absence.
      const owns = await ctx.db((db) =>
        db.query<{ owns: boolean }>('SELECT kynviora.owns_profile($1) AS owns', [
          params.data.profileId,
        ]),
      );
      const provenance = owns.rows[0]?.owns === true ? 'USER_REPORTED' : 'CAREGIVER_ENTERED';

      const inserted = await writeOrRefusal(() =>
        ctx.db(async (db) => {
          const record = await db.query<RecordRow>(
            `INSERT INTO health_record
               (profile_id, record_kind, title, provider_name, recorded_on, source_id,
                extraction_state, provenance, note)
             VALUES ($1, $2, $3, $4, $5::date, $6, 'ENTERED_BY_HAND', $7, $8)
             RETURNING ${RECORD_COLUMNS}`,
            [
              params.data.profileId,
              draft.kind,
              draft.title,
              draft.providerName,
              draft.recordedOn,
              draft.sourceId,
              provenance,
              draft.note,
            ],
          );
          const row = record.rows[0];
          if (row === undefined) return null;

          let sequence = 0;
          for (const observation of draft.observations) {
            await db.query(
              `INSERT INTO health_observation
                 (record_id, profile_id, analyte_code, display_name, sequence, value_numeric,
                  value_text, unit, decimals, reference_low, reference_high, reference_text,
                  source_flag)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [
                row.id,
                params.data.profileId,
                observation.analyteCode,
                observation.displayName,
                sequence,
                observation.valueNumeric,
                observation.valueText,
                observation.unit,
                observation.decimals,
                observation.reference?.low ?? null,
                observation.reference?.high ?? null,
                observation.reference?.text ?? null,
                observation.sourceFlag,
              ],
            );
            sequence += 1;
          }
          return { ...row, observation_count: draft.observations.length };
        }),
      );

      if (inserted === null) return fail(reply, noSuchProfile(), ctx.correlationId);
      return reply.code(201).send({ record: recordView(inserted) });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/health-records/:recordId
  // -------------------------------------------------------------------------
  app.get<{ Params: { recordId: string } }>(
    '/v1/health-records/:recordId',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;
      const params = recordParamsSchema.safeParse(request.params);
      if (!params.success) return fail(reply, noSuchRecord(), ctx.correlationId);

      const found = await readRecord(ctx, params.data.recordId);
      if (found === null) return fail(reply, noSuchRecord(), ctx.correlationId);

      return reply.send({
        record: recordView({
          ...found.row,
          observation_count: found.observations.length,
          flagged_count: found.observations.filter((o) => o.source_flag !== null).length,
        }),
        observations: found.observations.map(observationView),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/health-records/:recordId/comparison
  // -------------------------------------------------------------------------
  // The one endpoint here that computes rather than reads, and the reason it is on the server:
  // the Change Lens has to produce the same counts for every surface, and the *choice* of what to
  // compare against has to be made once.
  app.get<{ Params: { recordId: string } }>(
    '/v1/health-records/:recordId/comparison',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;
      const params = recordParamsSchema.safeParse(request.params);
      if (!params.success) return fail(reply, noSuchRecord(), ctx.correlationId);

      const current = await readRecord(ctx, params.data.recordId);
      if (current === null) return fail(reply, noSuchRecord(), ctx.correlationId);

      // The previous comparable record: the most recent earlier record of the same kind that
      // shares at least one analyte. "Same kind" because comparing a lab panel with a discharge
      // summary is not a comparison, and "shares an analyte" because a report with nothing in
      // common produces a comparison of all-new and all-not-repeated, which tells nobody
      // anything and looks like a finding.
      const previousRow = await ctx.db((db) =>
        db.query<RecordRow>(
          `SELECT ${RECORD_COLUMNS}
             FROM health_record r
            WHERE r.profile_id = $1
              AND r.id <> $2
              AND r.record_kind = $3
              AND r.deleted_at IS NULL
              AND coalesce(r.recorded_on, r.created_at::date)
                  <= coalesce($4::date, r.created_at::date)
              AND EXISTS (
                SELECT 1 FROM health_observation o
                 WHERE o.record_id = r.id AND o.deleted_at IS NULL
                   AND o.analyte_code = ANY ($5::text[])
              )
            ORDER BY r.recorded_on DESC NULLS LAST, r.created_at DESC
            LIMIT 1`,
          [
            current.row.profile_id,
            current.row.id,
            current.row.record_kind,
            dateOrNull(current.row.recorded_on),
            current.observations.map((o) => o.analyte_code),
          ],
        ),
      );

      const previous = previousRow.rows[0];
      if (previous === undefined) {
        // No comparable record is a real answer and is not an error. A screen says "there is
        // nothing to compare this with yet", which is different from an empty comparison.
        return reply.send({
          current: recordView({ ...current.row, observation_count: current.observations.length }),
          previous: null,
          comparison: null,
        });
      }

      const previousObservations = await readObservations(ctx, previous.id);
      const comparison: ChangeSummary = compareHealthRecords({
        current: {
          kind: current.row.record_kind as HealthRecordKind,
          observations: current.observations.map(toStored),
        },
        previous: {
          kind: previous.record_kind as HealthRecordKind,
          observations: previousObservations.map(toStored),
        },
      });

      return reply.send({
        current: recordView({ ...current.row, observation_count: current.observations.length }),
        previous: recordView({ ...previous, observation_count: previousObservations.length }),
        comparison: {
          interval: comparison.interval,
          thresholdStatement: comparison.thresholdStatement,
          counts: comparison.counts,
          comparedCount: comparison.comparedCount,
          incomparableCount: comparison.incomparableCount,
          entries: comparison.entries,
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/profiles/:profileId/health-measurements
  // -------------------------------------------------------------------------
  app.get<{
    Params: { profileId: string };
    Querystring: { metric?: string; since?: string; limit?: string };
  }>('/v1/profiles/:profileId/health-measurements', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;
    const params = profileParamsSchema.safeParse(request.params);
    if (!params.success) return fail(reply, noSuchProfile(), ctx.correlationId);

    const query = z
      .object({
        metric: z.string().optional(),
        since: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(400),
      })
      .safeParse(request.query ?? {});
    if (!query.success) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Invalid query.', { reason_code: 'query_schema' }),
        ctx.correlationId,
      );
    }
    if (query.data.metric !== undefined && !isHealthMetric(query.data.metric)) {
      return fail(
        reply,
        domainError('VALIDATION_FAILED', 'Unknown metric.', { reason_code: 'unknown_metric' }),
        ctx.correlationId,
      );
    }

    const result = await ctx.db((db) =>
      db.query<MeasurementRow>(
        `SELECT id, metric, measured_at, value_numeric, value_secondary, unit, source_id,
                device_name
           FROM health_measurement
          WHERE profile_id = $1 AND deleted_at IS NULL
            AND ($2::text IS NULL OR metric = $2)
            AND ($3::timestamptz IS NULL OR measured_at >= $3)
          ORDER BY measured_at ASC
          LIMIT $4`,
        [
          params.data.profileId,
          query.data.metric ?? null,
          query.data.since ?? null,
          query.data.limit,
        ],
      ),
    );
    // Ascending, so a chart reads the array as drawn. A gap between two adjacent entries is a gap
    // in the data and stays one: nothing here fills it in.
    return reply.send({ measurements: result.rows.map(measurementView) });
  });

  // -------------------------------------------------------------------------
  // GET /v1/profiles/:profileId/health-timeline
  // -------------------------------------------------------------------------
  // The History layer. One list across records, allergies, conditions and connected sources,
  // because a person asking "what has changed about my health record" is not asking per table.
  app.get<{ Params: { profileId: string }; Querystring: { limit?: string } }>(
    '/v1/profiles/:profileId/health-timeline',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;
      const params = profileParamsSchema.safeParse(request.params);
      if (!params.success) return fail(reply, noSuchProfile(), ctx.correlationId);

      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(200).default(60) })
        .safeParse(request.query ?? {});
      if (!query.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid query.', { reason_code: 'query_schema' }),
          ctx.correlationId,
        );
      }

      // A UNION rather than four requests, so the ordering is the database's and a client cannot
      // produce a timeline whose order depends on which response arrived first.
      //
      // Allergies and conditions are included even though they live in `0004` and are read under
      // a different capability: RLS decides, per table, whether each row is visible, so a
      // caregiver with health records but not medicines gets the records and not the allergies -
      // and the timeline is correspondingly shorter rather than refused. That is the truthful
      // behaviour and it is a property of the policies rather than of this query.
      const result = await ctx.db((db) =>
        db.query<{
          entry_kind: string;
          entry_id: string;
          occurred_at: Date | string;
          title: string;
          detail: string | null;
        }>(
          `SELECT 'RECORD' AS entry_kind, r.id AS entry_id,
                  coalesce(r.recorded_on::timestamptz, r.created_at) AS occurred_at,
                  r.title, r.provider_name AS detail
             FROM health_record r
            WHERE r.profile_id = $1 AND r.deleted_at IS NULL
           UNION ALL
           SELECT 'ALLERGY', a.id, coalesce(a.noted_on::timestamptz, a.created_at),
                  a.display_term, a.record_kind
             FROM allergy_record a
            WHERE a.profile_id = $1 AND a.deleted_at IS NULL
           UNION ALL
           SELECT 'CONDITION', c.id, coalesce(c.noted_on::timestamptz, c.created_at),
                  c.display_term, NULL
             FROM condition_record c
            WHERE c.profile_id = $1 AND c.deleted_at IS NULL
           UNION ALL
           SELECT 'SOURCE', s.id, s.created_at, s.display_name, s.connection_state
             FROM health_source s
            WHERE s.profile_id = $1 AND s.deleted_at IS NULL
            ORDER BY occurred_at DESC
            LIMIT $2`,
          [params.data.profileId, query.data.limit],
        ),
      );

      return reply.send({
        entries: result.rows.map((row) => ({
          entryKind: row.entry_kind,
          entryId: row.entry_id,
          occurredAt: isoOrNull(row.occurred_at) ?? '',
          title: row.title,
          detail: row.detail,
        })),
      });
    },
  );

  async function readObservations(
    ctx: RequestContext,
    recordId: string,
  ): Promise<readonly ObservationRow[]> {
    const result = await ctx.db((db) =>
      db.query<ObservationRow>(
        `SELECT ${OBSERVATION_COLUMNS}
           FROM health_observation
          WHERE record_id = $1 AND deleted_at IS NULL
          ORDER BY sequence, display_name`,
        [recordId],
      ),
    );
    return result.rows;
  }

  async function readRecord(
    ctx: RequestContext,
    recordId: string,
  ): Promise<{ row: RecordRow; observations: readonly ObservationRow[] } | null> {
    const result = await ctx.db((db) =>
      db.query<RecordRow>(
        `SELECT ${RECORD_COLUMNS} FROM health_record WHERE id = $1 AND deleted_at IS NULL`,
        [recordId],
      ),
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { row, observations: await readObservations(ctx, recordId) };
  }
}
