import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  calendarDate,
  instantFrom,
  noopLogger,
  occurrencesBetween,
  unsafeId,
  type Instant,
  type MedicineSchedule,
  type UserId,
} from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * The medicine schedule write path, against a real engine (`04` Phase 4.1, `DEV-039`).
 *
 * Four things are decided here rather than in the domain, and each of them is a defect a person
 * would experience as a wrong or missing reminder rather than as an error:
 *
 *  1. **A retry does not become a second reminder.** Two schedules on one medicine means being
 *     told twice, at the same minute, to take the same tablet.
 *  2. **A stale edit does not silently win.** Two carers moving the same times is not a field
 *     where last-write-wins is harmless.
 *  3. **Reading a schedule and setting one are different permissions** (`08.2`, migration `0020`).
 *  4. **What the route stores is what the occurrence engine reads.** The end of this file joins
 *     the two halves that had never met: a row written through the API, handed to
 *     `@kynviora/safety`, producing the instants a reminder would fire at.
 */

const OWNER = testUuid(1);
/** VIEW_MEDICINES and no MANAGE_MEDICINES: may see when a medicine is taken, may not decide it. */
const READER = testUuid(2);
/** VIEW_MEDICINES + MANAGE_MEDICINES. */
const MEDICINE_MANAGER = testUuid(3);
/** The shelf capabilities and neither medicine one. */
const SHELF_MANAGER = testUuid(4);
const STRANGER = testUuid(5);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const MEDICINE = testUuid(30);
const SHAMPOO = testUuid(31);

const NOW = instantFrom('2026-09-02T12:00:00.000Z');

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
      [READER, 'reader@example.test'],
      [MEDICINE_MANAGER, 'meds@example.test'],
      [SHELF_MANAGER, 'shelf@example.test'],
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
      [READER, ['VIEW_MEDICINES', 'VIEW_SHELF']],
      [MEDICINE_MANAGER, ['VIEW_MEDICINES', 'VIEW_SHELF', 'MANAGE_MEDICINES']],
      // VIEW_MEDICINES as well, so a refusal here is about the capability split rather than about
      // the medicine being unreadable - which would prove nothing.
      [SHELF_MANAGER, ['VIEW_SHELF', 'VIEW_MEDICINES', 'MANAGE_SHELF']],
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

beforeEach(async () => {
  await t.asOwner(async (db) => {
    // The schedules go first: they reference the items by foreign key.
    await db.query('DELETE FROM medicine_schedule');
    await db.query('DELETE FROM owned_item');
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, strength_text, dosage_form, directions_text)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet', '500 mg', 'Tablet',
               'Take one twice a day.')`,
      [MEDICINE, PROFILE],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name, personal_care_category)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Synthetic Shampoo', 'HAIR_CARE')`,
      [SHAMPOO, PROFILE],
    );
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

interface ScheduleBody {
  readonly id: string;
  readonly ownedItemId: string;
  readonly scheduleKind: string;
  readonly timesLocal: readonly string[];
  readonly daysOfWeek: readonly number[] | null;
  readonly timeZone: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly active: boolean;
  readonly version: number;
}

interface CreatedBody {
  readonly schedule: ScheduleBody;
  readonly replayed?: boolean;
}

interface ListBody {
  readonly schedules: readonly ScheduleBody[];
}

interface WireError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail?: Record<string, unknown>;
  };
}

const FIXED: Record<string, unknown> = {
  scheduleKind: 'FIXED_TIMES',
  timesLocal: ['08:00', '20:00'],
  timeZone: 'Asia/Kolkata',
};

let keyCounter = 0;
/** A fresh idempotency key. A key regenerated on retry is not an idempotency key, so retries pass
 * the same one deliberately. */
function freshKey(): string {
  keyCounter += 1;
  return testUuid(600 + keyCounter);
}

const create = (
  as: Principal | null,
  itemId: string,
  payload: Record<string, unknown> = FIXED,
  // `null` means "send no key". An explicit `undefined` would select the default and quietly
  // send one, which is how the missing-key case passes while asserting nothing.
  key: string | null = freshKey(),
) =>
  request(as, {
    method: 'POST',
    url: `/v1/items/${itemId}/schedules`,
    payload,
    ...(key === null ? {} : { headers: { 'idempotency-key': key } }),
  });

const list = (as: Principal | null, itemId: string) =>
  request(as, { method: 'GET', url: `/v1/items/${itemId}/schedules` });

const patch = (as: Principal | null, scheduleId: string, payload: Record<string, unknown>) =>
  request(as, { method: 'PATCH', url: `/v1/schedules/${scheduleId}`, payload });

/** Create one as the owner and hand back what came out. */
async function seeded(payload: Record<string, unknown> = FIXED): Promise<ScheduleBody> {
  const response = await create(principalFor(OWNER), MEDICINE, payload);
  expect(response.statusCode).toBe(201);
  return response.json<CreatedBody>().schedule;
}

// ---------------------------------------------------------------------------

describe('writing down when a medicine is taken', () => {
  it('stores a fixed-time schedule and gives it back', async () => {
    const schedule = await seeded();
    expect(schedule.scheduleKind).toBe('FIXED_TIMES');
    expect(schedule.timesLocal).toEqual(['08:00', '20:00']);
    expect(schedule.timeZone).toBe('Asia/Kolkata');
    expect(schedule.active).toBe(true);
    expect(schedule.version).toBe(1);
    expect(schedule.ownedItemId).toBe(MEDICINE);
  });

  it('stores selected days in ISO order', async () => {
    const schedule = await seeded({
      scheduleKind: 'SELECTED_DAYS',
      timesLocal: ['09:00'],
      daysOfWeek: [7, 1, 3],
      timeZone: 'Europe/London',
    });
    expect(schedule.daysOfWeek).toEqual([1, 3, 7]);
  });

  it('stores an as-needed medicine with no time for a reminder to fire at', async () => {
    // `04` Phase 4.1 separates as-needed from fixed reminders. A time here is a reminder somebody
    // did not ask for, about something they take only when they need it - the shape `18` forbids.
    const schedule = await seeded({ scheduleKind: 'AS_NEEDED', timeZone: 'Asia/Kolkata' });
    expect(schedule.timesLocal).toEqual([]);
    expect(schedule.scheduleKind).toBe('AS_NEEDED');
  });

  it('keeps a start and end date as dates, not as instants', async () => {
    // A course of treatment starts on a day. Storing an instant would move it across a timezone.
    const schedule = await seeded({ ...FIXED, startsOn: '2026-09-10', endsOn: '2026-09-20' });
    expect(schedule.startsOn).toBe('2026-09-10');
    expect(schedule.endsOn).toBe('2026-09-20');
  });

  it('refuses a time that is not a 24-hour HH:MM, naming the field', async () => {
    const response = await create(principalFor(OWNER), MEDICINE, {
      ...FIXED,
      timesLocal: ['8am'],
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<WireError>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.detail?.field).toBe('timesLocal');
  });

  it('refuses a time zone the runtime cannot compute with', async () => {
    // A schedule in a zone nothing can resolve is one that can never produce a reminder, and the
    // failure would otherwise surface as silence on the phone rather than as a refusal here.
    const response = await create(principalFor(OWNER), MEDICINE, {
      ...FIXED,
      timeZone: 'Mars/Olympus',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<WireError>().error.detail?.field).toBe('timeZone');
  });

  it('refuses a body carrying a field this build does not know', async () => {
    // `.strict()`. A client that believed it had set a dose would be the worst version of this.
    const response = await create(principalFor(OWNER), MEDICINE, { ...FIXED, doseQuantity: '1' });
    expect(response.statusCode).toBe(400);
    expect(response.json<WireError>().error.code).toBe('VALIDATION_FAILED');
  });

  it('has no way to say how much, only when', async () => {
    // `09`: Kynviora does not reinterpret a prescription instruction. The written directions stay
    // on the item, in the prescriber's words; a structured quantity here would be Kynviora
    // restating a clinical instruction in its own form.
    const schedule = await seeded();
    expect(Object.keys(schedule)).not.toContain('dose');
    expect(Object.keys(schedule)).not.toContain('quantity');
    expect(Object.keys(schedule)).not.toContain('directionsText');
  });
});

describe('a retry is not a second reminder', () => {
  it('requires an idempotency key', async () => {
    const response = await create(principalFor(OWNER), MEDICINE, FIXED, null);
    expect(response.statusCode).toBe(400);
    expect(response.json<WireError>().error.detail?.reason_code).toBe('idempotency_key_required');
  });

  it('commits once when the same key arrives twice', async () => {
    const key = freshKey();
    const first = await create(principalFor(OWNER), MEDICINE, FIXED, key);
    const second = await create(principalFor(OWNER), MEDICINE, FIXED, key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json<CreatedBody>().replayed).toBe(true);
    expect(second.json<CreatedBody>().schedule.id).toBe(first.json<CreatedBody>().schedule.id);

    // The thing that matters is not the status code. It is that the reminder engine, reading
    // every active schedule for this medicine, finds one.
    const stored = await list(principalFor(OWNER), MEDICINE);
    expect(stored.json<ListBody>().schedules).toHaveLength(1);
  });

  it('answers a replay with what is stored, not with what the retry said', async () => {
    // A retry carrying changed times would otherwise be told what the body it sent implies, when
    // what exists - and what will actually fire - is the first one.
    const key = freshKey();
    await create(principalFor(OWNER), MEDICINE, FIXED, key);
    const second = await create(
      principalFor(OWNER),
      MEDICINE,
      { ...FIXED, timesLocal: ['06:00'] },
      key,
    );
    expect(second.json<CreatedBody>().schedule.timesLocal).toEqual(['08:00', '20:00']);
  });

  it('lets the same key be used on a different medicine', async () => {
    // DEC-079's reasoning. Scoped to the item so a key another household already used cannot make
    // this insert fail, whose replay read then finds nothing under RLS and drops the schedule.
    const other = testUuid(32);
    await t.asOwner((db) =>
      db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
         VALUES ($1, $2, 'MEDICINE', 'Second Synthetic Tablet')`,
        [other, PROFILE],
      ),
    );
    const key = freshKey();
    expect((await create(principalFor(OWNER), MEDICINE, FIXED, key)).statusCode).toBe(201);
    expect((await create(principalFor(OWNER), other, FIXED, key)).statusCode).toBe(201);
  });
});

describe('who may set when somebody takes a tablet', () => {
  it('lets a caregiver holding MANAGE_MEDICINES set one', async () => {
    const response = await create(principalFor(MEDICINE_MANAGER), MEDICINE);
    expect(response.statusCode).toBe(201);
  });

  it('refuses a caregiver who may only look, as absence', async () => {
    // The defect migration 0020 closes. Before it, `schedule_insert` asked only whether the caller
    // could see the item - so a read-only caregiver could have created this person's reminders.
    const response = await create(principalFor(READER), MEDICINE);
    expect(response.statusCode).toBe(404);
    expect(response.json<WireError>().error.code).toBe('NOT_FOUND');
  });

  it('refuses a caregiver scoped to the shelf', async () => {
    expect((await create(principalFor(SHELF_MANAGER), MEDICINE)).statusCode).toBe(404);
  });

  it('refuses a stranger with the same answer an unknown medicine gets', async () => {
    const stranger = await create(principalFor(STRANGER), MEDICINE);
    const unknown = await create(principalFor(OWNER), testUuid(999));
    expect(stranger.statusCode).toBe(unknown.statusCode);
    expect(stranger.json<WireError>().error.message).toBe(unknown.json<WireError>().error.message);
  });

  it('refuses a schedule on a personal-care item', async () => {
    // MANAGE_MEDICINES is the wrong capability for a shampoo, and MANAGE_SHELF is not a licence
    // to schedule a dose.
    expect((await create(principalFor(OWNER), SHAMPOO)).statusCode).toBe(404);
  });

  it('shows a viewing caregiver the times without letting them move them', async () => {
    // The asymmetry is the point of a capability model, and it is worth asserting as one test
    // rather than two: the same caller, reading and failing to write.
    const schedule = await seeded();
    const seen = await list(principalFor(READER), MEDICINE);
    expect(seen.json<ListBody>().schedules.map((s) => s.id)).toEqual([schedule.id]);

    const moved = await patch(principalFor(READER), schedule.id, {
      ...FIXED,
      expectedVersion: schedule.version,
      timesLocal: ['23:00'],
    });
    // 404, not 403. `errors.ts` maps PERMISSION_DENIED to not-found on purpose: telling somebody
    // "you are not allowed to change this" confirms it exists, which is the enumeration weakness
    // `19` requires a test for. The screen withholds the control; the route says nothing.
    expect(moved.statusCode).toBe(404);

    const after = await list(principalFor(OWNER), MEDICINE);
    expect(after.json<ListBody>().schedules[0]?.timesLocal).toEqual(['08:00', '20:00']);
  });

  it('shows nothing to a caller who cannot read the medicine', async () => {
    // An empty list rather than a refusal: the same answer a medicine with no schedule gives, so
    // the route is not an oracle for an item ID (`13`).
    await seeded();
    const response = await list(principalFor(STRANGER), MEDICINE);
    expect(response.statusCode).toBe(200);
    expect(response.json<ListBody>().schedules).toEqual([]);
  });
});

describe('changing a schedule', () => {
  it('moves a time and advances the version', async () => {
    const schedule = await seeded();
    const response = await patch(principalFor(OWNER), schedule.id, {
      ...FIXED,
      expectedVersion: schedule.version,
      timesLocal: ['09:00', '21:00'],
    });
    expect(response.statusCode).toBe(200);
    const updated = response.json<{ schedule: ScheduleBody }>().schedule;
    expect(updated.timesLocal).toEqual(['09:00', '21:00']);
    expect(updated.version).toBe(2);
  });

  it('refuses a stale edit and says what the current version is', async () => {
    const schedule = await seeded();
    await patch(principalFor(OWNER), schedule.id, {
      ...FIXED,
      expectedVersion: 1,
      timesLocal: ['09:00'],
    });

    // The second carer still holds version 1.
    const stale = await patch(principalFor(MEDICINE_MANAGER), schedule.id, {
      ...FIXED,
      expectedVersion: 1,
      timesLocal: ['22:00'],
    });
    expect(stale.statusCode).toBe(409);
    const body = stale.json<WireError>();
    expect(body.error.code).toBe('VERSION_CONFLICT');
    expect(body.error.detail?.currentVersion).toBe(2);

    // And the first carer's change is still what is stored.
    const stored = await list(principalFor(OWNER), MEDICINE);
    expect(stored.json<ListBody>().schedules[0]?.timesLocal).toEqual(['09:00']);
  });

  it('stops the reminders by deactivating rather than deleting', async () => {
    // `0004` grants the app role no DELETE on this table: a dose event references the schedule it
    // was recorded against, and deleting the row would leave a history nobody can read back.
    const schedule = await seeded();
    const response = await patch(principalFor(OWNER), schedule.id, {
      ...FIXED,
      expectedVersion: schedule.version,
      active: false,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ schedule: ScheduleBody }>().schedule.active).toBe(false);

    // Still listed, because a person deciding what to change needs to see the course they stopped.
    const stored = await list(principalFor(OWNER), MEDICINE);
    expect(stored.json<ListBody>().schedules).toHaveLength(1);
    expect(stored.json<ListBody>().schedules[0]?.active).toBe(false);
  });

  it('leaves the active flag alone when the body does not mention it', async () => {
    const schedule = await seeded();
    await patch(principalFor(OWNER), schedule.id, {
      ...FIXED,
      expectedVersion: 1,
      active: false,
    });
    const response = await patch(principalFor(OWNER), schedule.id, {
      ...FIXED,
      expectedVersion: 2,
      timesLocal: ['07:00'],
    });
    expect(response.json<{ schedule: ScheduleBody }>().schedule.active).toBe(false);
  });

  it('answers an unknown schedule and one on somebody elses medicine identically', async () => {
    const schedule = await seeded();
    const mine = await patch(principalFor(STRANGER), schedule.id, {
      ...FIXED,
      expectedVersion: 1,
    });
    const unknown = await patch(principalFor(STRANGER), testUuid(998), {
      ...FIXED,
      expectedVersion: 1,
    });
    expect(mine.statusCode).toBe(unknown.statusCode);
    expect(mine.json<WireError>().error.message).toBe(unknown.json<WireError>().error.message);
  });

  it('records the change in the audit log without recording the times', async () => {
    // `14` keeps the content of somebody's medicine record out of a log. "Two times became one"
    // is what an access history needs; "08:00 and 20:00" is a copy of their routine sitting
    // outside the encrypted store that holds the rest.
    const schedule = await seeded();
    await patch(principalFor(OWNER), schedule.id, {
      ...FIXED,
      expectedVersion: 1,
      timesLocal: ['09:00'],
    });

    const events = await t.asService((db) =>
      db.query<{ action: string; target_id: string; detail: Record<string, unknown> }>(
        `SELECT action, target_id, detail FROM audit_event
          WHERE target_kind = 'medicine_schedule' AND target_id = $1`,
        [schedule.id],
      ),
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.action).toBe('MEDICINE_SCHEDULE_UPDATED');
    expect(events.rows[0]?.detail).toMatchObject({ time_count: 1, active: true });
    expect(JSON.stringify(events.rows[0]?.detail)).not.toContain('09:00');
  });

  it('refuses to leave a selected-days schedule with no days', async () => {
    // Not the same as "every day": an empty selection is a schedule that never fires, which is a
    // medicine somebody believes they are being reminded about and is not.
    const schedule = await seeded();
    const response = await patch(principalFor(OWNER), schedule.id, {
      scheduleKind: 'SELECTED_DAYS',
      timesLocal: ['08:00'],
      daysOfWeek: [],
      timeZone: 'Asia/Kolkata',
      expectedVersion: 1,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<WireError>().error.detail?.field).toBe('daysOfWeek');
  });
});

describe('everything one device needs to plan its reminders', () => {
  interface ProfileListBody {
    readonly profileId: string;
    readonly profileDisplayName: string | null;
    readonly schedules: readonly (ScheduleBody & { readonly itemDisplayName: string })[];
    readonly serverTime: string;
  }

  const profileList = (as: Principal | null, profileId: string) =>
    request(as, { method: 'GET', url: `/v1/profiles/${profileId}/schedules` });

  it('returns every schedule on the profile with its medicine named', async () => {
    const other = testUuid(33);
    await t.asOwner((db) =>
      db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
         VALUES ($1, $2, 'MEDICINE', 'Another Synthetic Tablet')`,
        [other, PROFILE],
      ),
    );
    await seeded();
    await create(principalFor(OWNER), other, { ...FIXED, timesLocal: ['12:00'] });

    const response = await profileList(principalFor(OWNER), PROFILE);
    expect(response.statusCode).toBe(200);
    const body = response.json<ProfileListBody>();
    expect(body.schedules).toHaveLength(2);
    expect(body.schedules.map((s) => s.itemDisplayName).sort()).toEqual([
      'Another Synthetic Tablet',
      'Synthetic Tablet',
    ]);
    expect(body.profileDisplayName).toBe('Parent A (synthetic)');
  });

  it('is one response rather than one per medicine, so the plan is one moment', async () => {
    // The whole reason this route exists beside the per-item read. `12` keeps the offline copy as
    // whole responses; several rows that can each be separately stale is a plan assembled from
    // several different moments, and the medicine whose row failed gets no reminders at all.
    await seeded();
    const body = (await profileList(principalFor(OWNER), PROFILE)).json<ProfileListBody>();
    expect(body.serverTime ?? null).not.toBe(undefined);
    expect(body.profileId).toBe(PROFILE);
  });

  it('shows a viewing caregiver the schedules', async () => {
    await seeded();
    const body = (await profileList(principalFor(READER), PROFILE)).json<ProfileListBody>();
    expect(body.schedules).toHaveLength(1);
  });

  it('shows nothing to a caller who cannot read the medicines', async () => {
    // An empty list rather than a refusal: the same answer a profile with no schedules gives, so
    // a profile ID in a request is no proof of access (`13`).
    await seeded();
    const shelfOnly = testUuid(6);
    await t.asService(async (db) => {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`,
        [shelfOnly, `auth|${shelfOnly}`, 'shelfonly@example.test'],
      );
      await db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, ARRAY['VIEW_SHELF']::text[], 'ACTIVE', now())
         ON CONFLICT DO NOTHING`,
        [PROFILE, shelfOnly, OWNER],
      );
    });

    const response = await profileList(principalFor(shelfOnly), PROFILE);
    expect(response.statusCode).toBe(200);
    expect(response.json<ProfileListBody>().schedules).toEqual([]);
  });

  it('omits a schedule whose medicine was archived out of the shelf', async () => {
    // `deleted_at` is a soft delete and the join filters it, so a device does not keep firing
    // reminders for a medicine the shelf no longer shows.
    await seeded();
    await t.asOwner((db) =>
      db.query(`UPDATE owned_item SET deleted_at = now() WHERE id = $1`, [MEDICINE]),
    );
    const body = (await profileList(principalFor(OWNER), PROFILE)).json<ProfileListBody>();
    expect(body.schedules).toEqual([]);
  });
});

describe('what the route stores is what the occurrence engine reads', () => {
  it('produces the instants a reminder would fire at', async () => {
    // The join that had never existed. `@kynviora/safety` has computed occurrences since Stage 4
    // against hand-built objects; this is the first time one comes out of the database through
    // the API, which is what `DEV-039` said was missing.
    const stored = await seeded({
      scheduleKind: 'FIXED_TIMES',
      timesLocal: ['08:00', '20:00'],
      timeZone: 'Asia/Kolkata',
    });

    const schedule: MedicineSchedule = {
      id: stored.id,
      kind: 'FIXED_TIMES',
      timesLocal: stored.timesLocal,
      daysOfWeek: null,
      timeZone: stored.timeZone,
      startsOn: null,
      endsOn: null,
      active: stored.active,
      // The route never returns this and the engine never reads it into a time. It is on the item
      // in the prescriber's words, and the schedule carries a null in its place.
      directionsText: null,
    };

    const occurrences = occurrencesBetween(
      schedule,
      calendarDate('2026-09-02'),
      calendarDate('2026-09-02'),
    );

    // Asia/Kolkata is UTC+5:30, so 08:00 local is 02:30Z and 20:00 local is 14:30Z.
    expect(occurrences.map((o) => String(o.dueAt))).toEqual([
      '2026-09-02T02:30:00.000Z',
      '2026-09-02T14:30:00.000Z',
    ]);
    expect(occurrences.map((o) => o.localTime)).toEqual(['08:00', '20:00']);
  });

  it('produces nothing for an as-needed medicine', async () => {
    const stored = await seeded({ scheduleKind: 'AS_NEEDED', timeZone: 'Asia/Kolkata' });
    const schedule: MedicineSchedule = {
      id: stored.id,
      kind: 'AS_NEEDED',
      timesLocal: stored.timesLocal,
      daysOfWeek: null,
      timeZone: stored.timeZone,
      startsOn: null,
      endsOn: null,
      active: stored.active,
      directionsText: null,
    };
    expect(
      occurrencesBetween(schedule, calendarDate('2026-09-02'), calendarDate('2026-09-09')),
    ).toEqual([]);
  });
});
