/**
 * The medicine schedule write path (`04` Phase 4.1).
 *
 *   POST  /v1/items/:itemId/schedules   - say when a medicine is meant to be taken
 *   GET   /v1/items/:itemId/schedules   - what is currently set, and what a reminder would use
 *   PATCH /v1/schedules/:scheduleId     - move a time, end a course, or stop the reminders
 *   GET   /v1/profiles/:profileId/schedules
 *                                       - everything one device needs to plan its reminders
 *
 * Spec references: `04` Phase 4.1 (fixed-time and selected-day patterns, start and end dates,
 * as-needed separated from fixed reminders, time-zone handling, directions preserved as entered),
 * `04` Phase 4.2 (the engine that reads this), `09` (Kynviora does not reinterpret a prescription
 * instruction), `13` (idempotency key on retriable mutations, per-entity conflict policy, a
 * profile or item ID in a request is never proof of access), `08.2` (capability scoping),
 * `18` (no nagging), `DEV-039`.
 *
 * WHY THIS EXISTS SIXTEEN MIGRATIONS AFTER THE TABLE
 * `medicine_schedule` has had its columns, constraints and policies since `0004`, and
 * `@kynviora/safety/schedule.ts` has computed occurrences from it since Stage 4 with deterministic
 * tests. Nothing had ever written a row, because there was no route - so Phase 4.1's model was
 * complete and its surface was not, and Phase 4.2's reminder engine had nothing to remind anybody
 * about. `DEV-039` is that gap; this file closes it.
 *
 * A SCHEDULE SAYS WHEN, NEVER HOW MUCH
 * There is no dose, quantity or instruction field anywhere in this file, and there must not be
 * one. `09` forbids Kynviora reinterpreting a prescriber's instruction and `04` Phase 4.1 requires
 * written directions to be preserved as entered - they live on the item as `directions_text`, in
 * the prescriber's words. A structured quantity here would be Kynviora restating a clinical
 * instruction in its own form, which is the same mistake as parsing it.
 *
 * TIMES ARE LOCAL WALL-CLOCK PLUS A ZONE
 * `04` Phase 4.1's time-zone handling rule, and the reason `0004` stores `times_local` and
 * `timezone` separately. "08:00" survives a daylight-saving transition and a flight; an instant
 * computed once at save time does not, and would move a dose by an hour twice a year without
 * anybody touching it. The occurrence computation is `@kynviora/safety`'s, which is server-side
 * only (DEC-010); the vocabulary a person enters a schedule in is `@kynviora/domain`'s, which the
 * phone may read.
 *
 * AUTHORIZATION IS ROW-LEVEL SECURITY, AS EVERYWHERE ELSE
 * There is no capability check in this file. Migration `0020` requires `MANAGE_MEDICINES` to
 * insert or update a schedule and leaves reading at item reachability, so a caregiver who may only
 * look reads the times and cannot move them. `13` says an item ID in a request is never proof of
 * access, and every refusal here is answered as the same not-found an unknown item gets.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  domainError,
  isErr,
  normalizeScheduleEntry,
  type DomainError,
  type IsoWeekday,
  type ScheduleKind,
} from '@kynviora/domain';
import type { RequestContext } from './context.js';

export interface ScheduleRouteDeps {
  readonly contextFor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<RequestContext | null>;
  readonly fail: (reply: FastifyReply, error: DomainError, correlationId: string) => FastifyReply;
}

const uuidSchema = z.string().uuid();
const itemParamsSchema = z.object({ itemId: uuidSchema });
const scheduleParamsSchema = z.object({ scheduleId: uuidSchema });
const profileParamsSchema = z.object({ profileId: uuidSchema });

/**
 * A schedule somebody is creating.
 *
 * `.strict()`, so a key this build does not know about is a refusal rather than one silently
 * ignored - a client that believed it had set an end date would be the worst version of that.
 * Every value is passed to the domain untouched: this schema decides only that the JSON has the
 * right shape, and `normalizeScheduleEntry` decides whether it means anything.
 *
 * There is deliberately no `active`, no `version` and no `id`. A schedule is created active, its
 * version starts at 1 in the database, and a client-supplied ID would let a caller address a row
 * before it exists.
 */
const createBodySchema = z
  .object({
    scheduleKind: z.string(),
    timesLocal: z.array(z.string()).optional(),
    daysOfWeek: z.array(z.number()).nullish(),
    timeZone: z.string(),
    startsOn: z.string().nullish(),
    endsOn: z.string().nullish(),
  })
  .strict();

/**
 * A change to a schedule that already exists.
 *
 * `expectedVersion` is required for the reason it is required on an item update: `13` sets a
 * per-entity conflict policy and this is user-owned durable state, so an edit that did not say
 * what it was editing could only be last-write-wins. Two carers moving the same medicine's times
 * must not have one silently overwrite the other - when a reminder fires is not a field where the
 * last writer is obviously right.
 *
 * The pattern fields are whole-document rather than partial, which is why this body carries the
 * kind as well as the times. A schedule's kind, times and days are one statement: "twice a day"
 * with the times omitted is not a partial edit, it is an incomplete sentence, and patching them
 * independently is how a `SELECTED_DAYS` row ends up with no days.
 */
const updateBodySchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    scheduleKind: z.string(),
    timesLocal: z.array(z.string()).optional(),
    daysOfWeek: z.array(z.number()).nullish(),
    timeZone: z.string(),
    startsOn: z.string().nullish(),
    endsOn: z.string().nullish(),
    /**
     * Whether reminders are still wanted. Absent leaves it alone.
     *
     * This is how a schedule ends, because `0004` grants the app role no DELETE on this table: a
     * dose event references the schedule it was recorded against, and deleting the row would
     * leave a history nobody can read back (the reason `DEV-032` archives an item).
     */
    active: z.boolean().optional(),
  })
  .strict();

interface ScheduleRow {
  readonly id: string;
  readonly owned_item_id: string;
  readonly schedule_kind: string;
  readonly times_local: readonly string[] | null;
  readonly days_of_week: readonly number[] | null;
  readonly timezone: string;
  readonly starts_on: Date | string | null;
  readonly ends_on: Date | string | null;
  readonly active: boolean;
  readonly version: number;
  readonly updated_at: Date | string | null;
}

/** What one schedule looks like on the wire. */
export interface ScheduleView {
  readonly id: string;
  readonly ownedItemId: string;
  readonly scheduleKind: ScheduleKind;
  readonly timesLocal: readonly string[];
  readonly daysOfWeek: readonly IsoWeekday[] | null;
  readonly timeZone: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly active: boolean;
  readonly version: number;
  readonly updatedAt: string | null;
}

/** Trap 45: the driver hands back a `Date`, and a date column must not become an instant. */
function dateOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function scheduleView(row: ScheduleRow): ScheduleView {
  return {
    id: row.id,
    ownedItemId: row.owned_item_id,
    scheduleKind: row.schedule_kind as ScheduleKind,
    timesLocal: row.times_local ?? [],
    daysOfWeek: (row.days_of_week as readonly IsoWeekday[] | null) ?? null,
    timeZone: row.timezone,
    startsOn: dateOrNull(row.starts_on),
    endsOn: dateOrNull(row.ends_on),
    active: row.active,
    version: row.version,
    updatedAt: isoOrNull(row.updated_at),
  };
}

const SELECT_COLUMNS = `id, owned_item_id, schedule_kind, times_local, days_of_week, timezone,
                        starts_on, ends_on, active, version, updated_at`;

/**
 * Run a write and report a row-level-security refusal as absence rather than as a failure.
 *
 * `schedule_insert` refuses by raising, not by returning no rows, so the refusal has to be caught.
 * Only the insufficient-privilege code is mapped: anything else is a real failure and must not be
 * disguised as a missing medicine, which would hide a bug behind a plausible answer. The same
 * shape `POST /v1/items` uses, and for the same reason.
 */
async function writeOrRefusal<T>(run: () => Promise<T>): Promise<T | null | 'duplicate'> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/medicine_schedule_idempotency|duplicate key/i.test(message)) return 'duplicate';
    if (/row-level security|permission denied/i.test(message)) return null;
    throw error;
  }
}

export function registerScheduleRoutes(app: FastifyInstance, deps: ScheduleRouteDeps): void {
  const { contextFor, fail } = deps;

  const noSuchItem = () => domainError('NOT_FOUND', 'No such medicine.');
  const noSuchSchedule = () => domainError('NOT_FOUND', 'No such schedule.');

  // -------------------------------------------------------------------------
  // POST /v1/items/:itemId/schedules
  // -------------------------------------------------------------------------
  app.post<{ Params: { itemId: string } }>(
    '/v1/items/:itemId/schedules',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const params = itemParamsSchema.safeParse(request.params);
      // A malformed identifier answers exactly as an unknown one does.
      if (!params.success) return fail(reply, noSuchItem(), ctx.correlationId);
      const itemId = params.data.itemId;

      // `13`: "Idempotency key on mutations that can be retried." Required rather than optional,
      // for the reason `POST /v1/items` requires it, with a sharper edge: a person who taps Save,
      // sees nothing and taps again would otherwise get two schedules on one medicine - and the
      // reminder engine reads every active schedule for an item, so the visible symptom is not a
      // duplicate row on a list. It is being told twice, at the same minute, to take the same
      // tablet, which is how somebody takes two.
      if (!ctx.operationId) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Idempotency-Key header is required.', {
            reason_code: 'idempotency_key_required',
          }),
          ctx.correlationId,
        );
      }

      const body = createBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
          ctx.correlationId,
        );
      }

      // The domain decides what the values may be, so a refusal names the field and the reason
      // rather than arriving as a constraint violation nobody can read.
      const normalized = normalizeScheduleEntry(body.data);
      if (isErr(normalized)) return fail(reply, normalized.error, ctx.correlationId);
      const entry = normalized.value;

      const inserted = await writeOrRefusal(() =>
        ctx.db((db) =>
          db.query<ScheduleRow>(
            `INSERT INTO medicine_schedule
               (owned_item_id, schedule_kind, times_local, days_of_week, timezone,
                starts_on, ends_on, client_operation_id)
             VALUES ($1, $2, $3::text[], $4::integer[], $5, $6::date, $7::date, $8)
             RETURNING ${SELECT_COLUMNS}`,
            [
              itemId,
              entry.scheduleKind,
              entry.timesLocal,
              entry.daysOfWeek,
              entry.timeZone,
              entry.startsOn,
              entry.endsOn,
              ctx.operationId,
            ],
          ),
        ),
      );

      if (inserted === null) {
        // Row-level security refused. A medicine this caller may only look at, one belonging to
        // somebody else, and one that does not exist are the same answer, so the route is not an
        // oracle for any of them - and the item detail's own view is what stops a screen offering
        // the control in the first place.
        return fail(reply, noSuchItem(), ctx.correlationId);
      }

      if (inserted !== 'duplicate') {
        const row = inserted.rows[0];
        if (row === undefined) return fail(reply, noSuchItem(), ctx.correlationId);
        return reply.status(201).send({ schedule: scheduleView(row), serverTime: ctx.now });
      }

      // The key has been used on this medicine before, so this is the same save arriving twice.
      // `13`: the server commits exactly once.
      //
      // The stored row is read back rather than the submission echoed. A retry carrying changed
      // times would otherwise be told what the body it sent implies, when what exists - and what
      // the reminder engine will actually fire on - is the first one.
      const existing = await ctx.db((db) =>
        db.query<ScheduleRow>(
          `SELECT ${SELECT_COLUMNS}
             FROM medicine_schedule
            WHERE owned_item_id = $1 AND client_operation_id = $2`,
          [itemId, ctx.operationId],
        ),
      );

      const stored = existing.rows[0];
      if (stored === undefined) {
        // The conflicting row belongs to a medicine this caller cannot read. Answered as the same
        // absence, because this route says nothing about what exists elsewhere.
        return fail(reply, noSuchItem(), ctx.correlationId);
      }

      return reply
        .status(200)
        .header('idempotent-replay', 'true')
        .send({ schedule: scheduleView(stored), replayed: true, serverTime: ctx.now });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/items/:itemId/schedules
  // -------------------------------------------------------------------------
  // Every schedule on the medicine, active or not, because a person looking at this screen is
  // deciding what to change and a stopped course they set last month is part of that. The reminder
  // engine filters on `active` itself; a route that hid them would make "why is there no reminder"
  // unanswerable from the screen that sets them.
  app.get<{ Params: { itemId: string } }>('/v1/items/:itemId/schedules', async (request, reply) => {
    const ctx = await contextFor(request, reply);
    if (!ctx) return;

    const params = itemParamsSchema.safeParse(request.params);
    if (!params.success) return fail(reply, noSuchItem(), ctx.correlationId);

    // No capability check. `schedule_select` requires the medicine to be readable, so a caller
    // without `VIEW_MEDICINES` reads an empty list - the same answer a medicine with no schedule
    // gives, which is what `13` requires of an ID that is not proof of access.
    const result = await ctx.db((db) =>
      db.query<ScheduleRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM medicine_schedule
          WHERE owned_item_id = $1
          ORDER BY active DESC, created_at ASC`,
        [params.data.itemId],
      ),
    );

    return reply.status(200).send({
      schedules: result.rows.map(scheduleView),
      serverTime: ctx.now,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/profiles/:profileId/schedules
  // -------------------------------------------------------------------------
  // Everything a device needs to plan its reminders, in one request.
  //
  // WHY THIS EXISTS ALONGSIDE THE PER-ITEM READ
  // A phone planning reminders needs every schedule on the profile at once, and per-item it would
  // be one request per medicine - on the launch path, on a connection that may be about to fail.
  // Worse, `12` keeps the offline copy as whole responses: N rows that can be individually stale
  // is a plan assembled from several different moments, and the medicine whose row failed simply
  // has no reminders. One response is one moment.
  //
  // WHY IT CARRIES THE MEDICINE'S NAME
  // Because the alternative is the device joining this against a separate shelf read, which is the
  // same several-moments problem with an extra way to go wrong: a schedule whose item is missing
  // from the other response would be planned with no name, and at `NAMED` the person would get a
  // reminder that could not say what it was for. The name is already readable to this caller -
  // `schedule_select` requires it - so nothing is disclosed that a shelf read would not disclose.
  app.get<{ Params: { profileId: string } }>(
    '/v1/profiles/:profileId/schedules',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const params = profileParamsSchema.safeParse(request.params);
      if (!params.success) {
        return fail(reply, domainError('NOT_FOUND', 'No such profile.'), ctx.correlationId);
      }
      const profileId = params.data.profileId;

      // No capability check. Row-level security decides: a caller without `VIEW_MEDICINES` reads
      // an empty list, which is the same answer a profile with no schedules gives, and `13`
      // requires a profile ID in a request to be no proof of access.
      const result = await ctx.db((db) =>
        db.query<ScheduleRow & { item_display_name: string }>(
          `SELECT s.id, s.owned_item_id, s.schedule_kind, s.times_local, s.days_of_week,
                  s.timezone, s.starts_on, s.ends_on, s.active, s.version, s.updated_at,
                  i.display_name AS item_display_name
             FROM medicine_schedule s
             -- An inner join, and the policy on owned_item is what makes it an authorization
             -- boundary: a schedule whose medicine this caller cannot read has no row to join to
             -- and disappears, rather than arriving with a blank name. (No backtick in a SQL
             -- comment inside a template literal - it closes the string, trap 155.)
             JOIN owned_item i ON i.id = s.owned_item_id
            WHERE i.profile_id = $1 AND i.deleted_at IS NULL
            ORDER BY s.active DESC, i.display_name ASC, s.created_at ASC`,
          [profileId],
        ),
      );

      // The profile's own name, for the disclosure level that may show it. Read separately rather
      // than joined onto every row, and null where the caller cannot see the profile - which is
      // the same state a device gets before it has ever loaded one.
      const profile = await ctx.db((db) =>
        db.query<{ display_name: string }>(`SELECT display_name FROM profile WHERE id = $1`, [
          profileId,
        ]),
      );

      return reply.status(200).send({
        profileId,
        profileDisplayName: profile.rows[0]?.display_name ?? null,
        schedules: result.rows.map((row) => ({
          ...scheduleView(row),
          itemDisplayName: row.item_display_name,
        })),
        serverTime: ctx.now,
      });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /v1/schedules/:scheduleId
  // -------------------------------------------------------------------------
  app.patch<{ Params: { scheduleId: string } }>(
    '/v1/schedules/:scheduleId',
    async (request, reply) => {
      const ctx = await contextFor(request, reply);
      if (!ctx) return;

      const params = scheduleParamsSchema.safeParse(request.params);
      if (!params.success) return fail(reply, noSuchSchedule(), ctx.correlationId);
      const scheduleId = params.data.scheduleId;

      const body = updateBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return fail(
          reply,
          domainError('VALIDATION_FAILED', 'Invalid request body.', { reason_code: 'body_schema' }),
          ctx.correlationId,
        );
      }

      const normalized = normalizeScheduleEntry(body.data);
      if (isErr(normalized)) return fail(reply, normalized.error, ctx.correlationId);
      const entry = normalized.value;

      const readStored = () =>
        ctx.db((db) =>
          db.query<ScheduleRow>(`SELECT ${SELECT_COLUMNS} FROM medicine_schedule WHERE id = $1`, [
            scheduleId,
          ]),
        );

      const before = (await readStored()).rows[0];
      // A schedule on somebody else's medicine and one that does not exist are the same answer.
      if (before === undefined) return fail(reply, noSuchSchedule(), ctx.correlationId);

      // The write, conditional on the version. `version` is bumped here rather than by a trigger
      // because the condition and the increment have to be one statement: two would be a race that
      // the whole point of this route is to close.
      const written = await ctx.db((db) =>
        db.query<ScheduleRow>(
          `UPDATE medicine_schedule
              SET schedule_kind = $3,
                  times_local = $4::text[],
                  days_of_week = $5::integer[],
                  timezone = $6,
                  starts_on = $7::date,
                  ends_on = $8::date,
                  active = COALESCE($9, active),
                  version = version + 1
            WHERE id = $1 AND version = $2
        RETURNING ${SELECT_COLUMNS}`,
          [
            scheduleId,
            body.data.expectedVersion,
            entry.scheduleKind,
            entry.timesLocal,
            entry.daysOfWeek,
            entry.timeZone,
            entry.startsOn,
            entry.endsOn,
            body.data.active ?? null,
          ],
        ),
      );

      const committed = written.rows[0];
      if (committed === undefined) {
        // Zero rows is three different facts. Re-read to say which, because a refusal reported as
        // a conflict sends somebody round a retry loop they can never win, and a conflict reported
        // as absence tells them their own schedule is gone.
        const after = (await readStored()).rows[0];
        if (after === undefined) return fail(reply, noSuchSchedule(), ctx.correlationId);

        if (after.version !== body.data.expectedVersion) {
          return fail(
            reply,
            domainError('VERSION_CONFLICT', 'This schedule changed while you had it open.', {
              reason_code: 'schedule_version',
              // The current version, so the client can re-read and try again against it. Never a
              // value from the row and never who changed it (`14`, DEC-076).
              currentVersion: after.version,
            }),
            ctx.correlationId,
          );
        }

        // Readable, unchanged, and `schedule_update` admitted nothing: this caller may look at
        // when the medicine is taken and not decide it. Answered as the same absence every other
        // refusal gives - there is deliberately no outcome in this API meaning "you are not
        // allowed" (trap 89).
        return fail(
          reply,
          domainError('PERMISSION_DENIED', 'No such schedule.'),
          ctx.correlationId,
        );
      }

      // Append-only, and the only place the sequence of changes lives: `medicine_schedule` holds
      // one row and this update overwrote the previous values. Field names and the active flag
      // only - `14` keeps the content of somebody's medicine record out of a log, and "the times
      // changed" is what an access history needs to be useful.
      await ctx.privileged('AUDIT_WRITE', (db) =>
        db.query(
          `INSERT INTO audit_event
             (actor_user_id, actor_role, action, target_kind, target_id, target_version,
              correlation_id, detail)
           VALUES ($1, 'kynviora_app', 'MEDICINE_SCHEDULE_UPDATED', 'medicine_schedule', $2, $3,
                   $4, $5::jsonb)`,
          [
            ctx.principal.userId,
            scheduleId,
            String(committed.version),
            ctx.correlationId,
            JSON.stringify({
              schedule_kind: committed.schedule_kind,
              active: committed.active,
              // How many times, never which. A log that recorded "08:00, 20:00" would be a record
              // of somebody's routine sitting outside the encrypted store that holds the rest.
              time_count: (committed.times_local ?? []).length,
            }),
          ],
        ),
      );

      return reply.status(200).send({ schedule: scheduleView(committed), serverTime: ctx.now });
    },
  );
}
