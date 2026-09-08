import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { manualEntryForm } from '@kynviora/presentation';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Changing an item, against a real engine.
 *
 * Stage 2's expected output is "create, view, update, archive, and review". The two things this
 * route must get right are decided here rather than in the domain: that a stale edit does not
 * silently win (`13` sets `owned_item` to `ASK_USER`), and that the capability split between
 * reading and changing is row-level security's decision rather than a check somebody remembered.
 */

const OWNER = testUuid(1);
/** VIEW_MEDICINES and no MANAGE_MEDICINES: may look, may not change. */
const READER = testUuid(2);
/** MANAGE_MEDICINES: may change a medicine and not a personal-care item. */
const MEDICINE_MANAGER = testUuid(3);
/** MANAGE_SHELF: the other half of the split. */
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
      // VIEW_SHELF as well, so the shampoo is readable. The case under test is "may look and
      // may not change", and a caregiver who cannot even read it would be a 404 for a different
      // reason and would prove nothing about the capability split.
      [MEDICINE_MANAGER, ['VIEW_MEDICINES', 'VIEW_SHELF', 'MANAGE_MEDICINES']],
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
    await db.query('DELETE FROM owned_item');
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, brand, market, strength_text, dosage_form,
          directions_text, started_on)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet', 'Synthetic Brand', 'GB', '500 mg',
               'Tablet', 'Take one twice a day.', '2026-08-01')`,
      [MEDICINE, PROFILE],
    );
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, personal_care_category,
          ingredient_declaration_raw)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Synthetic Shampoo', 'HAIR_CARE', 'Aqua, Glycerin')`,
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

interface DetailBody {
  readonly version: number;
  readonly mayEdit: boolean;
  readonly displayName: string;
  readonly categoryFields: readonly { label: string; value: string | null }[];
  readonly sharedFields: readonly { label: string; value: string | null }[];
  readonly lifecycleNote: string | null;
}

interface UpdatedBody {
  readonly id: string;
  readonly version: number;
  readonly lifecycleState: string;
  readonly changedFields: readonly string[];
  readonly lastReviewedAt: string | null;
}

const detail = (as: Principal | null, itemId: string) =>
  request(as, { method: 'GET', url: `/v1/items/${itemId}` });

const patch = (as: Principal | null, itemId: string, payload: Record<string, unknown>) =>
  request(as, { method: 'PATCH', url: `/v1/items/${itemId}`, payload });

async function storedRow(id: string) {
  const result = await t.asService((db) =>
    db.query<Record<string, unknown>>('SELECT * FROM owned_item WHERE id = $1', [id]),
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------

describe('the detail carries what an edit needs', () => {
  it('reports the version and that the owner may change it', async () => {
    const body = (await detail(principalFor(OWNER), MEDICINE)).json<DetailBody>();
    expect(body.version).toBe(1);
    expect(body.mayEdit).toBe(true);
  });

  it('tells a reader they may not change it, rather than letting the screen guess', async () => {
    // The control is withheld by identity rather than by a screen inferring it from a capability
    // list it would have to assemble itself. Evaluated with the same expression the update policy
    // uses, so the screen and the policy cannot disagree.
    const body = (await detail(principalFor(READER), MEDICINE)).json<DetailBody>();
    expect(body.mayEdit).toBe(false);
    expect(body.version).toBe(1);
  });

  it('splits the answer by category, as the capabilities do', async () => {
    // `MANAGE_MEDICINES` is not `MANAGE_SHELF`. A caregiver trusted with somebody's medicines is
    // not thereby trusted with their bathroom cabinet, and the reverse holds too.
    const medicines = principalFor(MEDICINE_MANAGER);
    expect((await detail(medicines, MEDICINE)).json<DetailBody>().mayEdit).toBe(true);
    expect((await detail(medicines, SHAMPOO)).json<DetailBody>().mayEdit).toBe(false);

    const shelf = principalFor(SHELF_MANAGER);
    expect((await detail(shelf, SHAMPOO)).json<DetailBody>().mayEdit).toBe(true);
    expect((await detail(shelf, MEDICINE)).json<DetailBody>().mayEdit).toBe(false);
  });
});

describe('changing what is recorded', () => {
  it('changes a field and moves the version', async () => {
    const response = await patch(principalFor(OWNER), MEDICINE, {
      expectedVersion: 1,
      strengthText: '250 mg',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<UpdatedBody>();
    expect(body.version).toBe(2);
    expect(body.changedFields).toEqual(['strengthText']);

    const row = await storedRow(MEDICINE);
    expect(row?.strength_text).toBe('250 mg');
    // Everything not mentioned is untouched.
    expect(row?.dosage_form).toBe('Tablet');
    expect(row?.display_name).toBe('Synthetic Tablet');
  });

  it('clears a field sent as null, and stores the absence', async () => {
    await patch(principalFor(OWNER), MEDICINE, { expectedVersion: 1, brand: null });

    const row = await storedRow(MEDICINE);
    expect(row?.brand).toBeNull();

    // And the detail says nobody entered it rather than showing an empty value.
    const body = (await detail(principalFor(OWNER), MEDICINE)).json<DetailBody>();
    for (const field of [...body.categoryFields, ...body.sharedFields]) {
      if (field.value !== null) expect(field.value.trim()).not.toBe('');
    }
  });

  it('refuses a malformed value and names the field', async () => {
    const response = await patch(principalFor(OWNER), MEDICINE, {
      expectedVersion: 1,
      market: 'gb',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { detail?: { field?: string } } }>().error.detail?.field).toBe(
      'market',
    );

    // Nothing was written, and the version did not move.
    const row = await storedRow(MEDICINE);
    expect(row?.market).toBe('GB');
    expect(row?.version).toBe(1);
  });

  it('refuses a key it does not know rather than ignoring it', async () => {
    // `.strict()`. A client that believed it had set a verification state would be the worst
    // version of a silently ignored key (`08`, `15` A11).
    for (const forbidden of [
      { identityVerification: 'CONFIRMED' },
      { itemKind: 'PERSONAL_CARE' },
      { productIdentityId: testUuid(900) },
      { lastReviewedAt: '2026-09-02T12:00:00.000Z' },
      { version: 9 },
    ]) {
      const response = await patch(principalFor(OWNER), MEDICINE, {
        expectedVersion: 1,
        ...forbidden,
      });
      expect(response.statusCode, JSON.stringify(forbidden)).toBe(400);
    }

    const row = await storedRow(MEDICINE);
    expect(row?.identity_verification).toBe('UNVERIFIED');
    expect(row?.version).toBe(1);
  });

  it('refuses a save that changes nothing', async () => {
    // An empty save still moves the version, and a version that moved for nothing is a conflict
    // for whoever else has this item open.
    const response = await patch(principalFor(OWNER), MEDICINE, {
      expectedVersion: 1,
      strengthText: '500 mg',
    });

    expect(response.statusCode).toBe(400);
    expect((await storedRow(MEDICINE))?.version).toBe(1);
  });
});

describe('a stale edit does not win', () => {
  it('refuses a change against a version that has moved, and says what to use', async () => {
    // `13` sets this entity's conflict policy to `ASK_USER`. Somebody whose copy is out of date
    // is told, and told what the record says now - never silently overwritten.
    await patch(principalFor(OWNER), MEDICINE, { expectedVersion: 1, strengthText: '250 mg' });

    const stale = await patch(principalFor(OWNER), MEDICINE, {
      expectedVersion: 1,
      strengthText: '100 mg',
    });

    expect(stale.statusCode).toBe(409);
    const error = stale.json<{ error: { code: string; detail?: { currentVersion?: number } } }>();
    expect(error.error.code).toBe('VERSION_CONFLICT');
    expect(error.error.detail?.currentVersion).toBe(2);

    // The first change stands. The second wrote nothing.
    expect((await storedRow(MEDICINE))?.strength_text).toBe('250 mg');
  });

  it('does not say who changed it', async () => {
    // DEC-076's rule, on a different screen: a caregiver's identity belongs on the caregiver-audit
    // page, not attached to a record somebody is editing.
    await patch(principalFor(OWNER), MEDICINE, { expectedVersion: 1, strengthText: '250 mg' });
    const stale = await patch(principalFor(READER), MEDICINE, {
      expectedVersion: 1,
      strengthText: '100 mg',
    });

    expect(JSON.stringify(stale.json())).not.toContain(OWNER);
  });

  it('lets the second attempt succeed against the version it was told', async () => {
    await patch(principalFor(OWNER), MEDICINE, { expectedVersion: 1, strengthText: '250 mg' });
    const retried = await patch(principalFor(OWNER), MEDICINE, {
      expectedVersion: 2,
      strengthText: '100 mg',
    });

    expect(retried.statusCode).toBe(200);
    expect(retried.json<UpdatedBody>().version).toBe(3);
  });
});

describe('who may change what', () => {
  it('refuses a caregiver who may read and not change', async () => {
    // Row-level security is the whole authorization. `owned_item_update` filters rather than
    // raising, so this is the case that has to be told apart from a version conflict - a refusal
    // reported as a conflict would send somebody round a retry loop they can never win.
    const response = await patch(principalFor(READER), MEDICINE, {
      expectedVersion: 1,
      strengthText: '250 mg',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).not.toBe('VERSION_CONFLICT');
    expect((await storedRow(MEDICINE))?.strength_text).toBe('500 mg');
  });

  it('keeps the medicine and shelf capabilities apart', async () => {
    const medicines = principalFor(MEDICINE_MANAGER);
    expect(
      (await patch(medicines, MEDICINE, { expectedVersion: 1, strengthText: '250 mg' })).statusCode,
    ).toBe(200);
    expect(
      (await patch(medicines, SHAMPOO, { expectedVersion: 1, labelVersionNote: 'New' })).statusCode,
    ).toBe(404);

    const shelf = principalFor(SHELF_MANAGER);
    expect(
      (await patch(shelf, SHAMPOO, { expectedVersion: 1, labelVersionNote: 'New' })).statusCode,
    ).toBe(200);
    expect(
      (await patch(shelf, MEDICINE, { expectedVersion: 2, strengthText: '100 mg' })).statusCode,
    ).toBe(404);
  });

  it('answers a stranger and an unknown item identically', async () => {
    const stranger = await patch(principalFor(STRANGER), MEDICINE, {
      expectedVersion: 1,
      strengthText: '250 mg',
    });
    const unknown = await patch(principalFor(OWNER), testUuid(999), {
      expectedVersion: 1,
      strengthText: '250 mg',
    });

    expect(stranger.statusCode).toBe(unknown.statusCode);
    expect(stranger.json<{ error: { code: string } }>().error.code).toBe(
      unknown.json<{ error: { code: string } }>().error.code,
    );
  });

  it('rejects an unauthenticated change', async () => {
    expect(
      (await patch(null, MEDICINE, { expectedVersion: 1, strengthText: '250 mg' })).statusCode,
    ).toBe(401);
  });
});

describe('the lifecycle', () => {
  it('stops an item and says so on the detail', async () => {
    const response = await patch(principalFor(OWNER), MEDICINE, {
      expectedVersion: 1,
      lifecycleState: 'STOPPED',
      stoppedOn: '2026-08-20',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<UpdatedBody>().lifecycleState).toBe('STOPPED');

    const body = (await detail(principalFor(OWNER), MEDICINE)).json<DetailBody>();
    expect(body.lifecycleNote).not.toBeNull();
    expect(body.sharedFields.find((field) => field.label === 'Stopped')?.value).toBe('2026-08-20');
  });

  it('takes an item off the shelf attention list once it is stopped', async () => {
    // A shelf that kept nagging about packs somebody has finished with is the alarm optimisation
    // `02` refuses, and worse, it teaches people to ignore the list that matters.
    const before = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE}&attention=NEEDS_VERIFICATION`,
    });
    expect(before.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toContain(
      MEDICINE,
    );

    await patch(principalFor(OWNER), MEDICINE, { expectedVersion: 1, lifecycleState: 'STOPPED' });

    const after = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items?profileId=${PROFILE}&attention=NEEDS_VERIFICATION`,
    });
    expect(after.json<{ items: { id: string }[] }>().items.map((item) => item.id)).not.toContain(
      MEDICINE,
    );
  });

  it('clears the stopped date when an item is put back into use', async () => {
    await patch(principalFor(OWNER), MEDICINE, {
      expectedVersion: 1,
      lifecycleState: 'STOPPED',
      stoppedOn: '2026-08-20',
    });
    await patch(principalFor(OWNER), MEDICINE, { expectedVersion: 2, lifecycleState: 'ACTIVE' });

    const row = await storedRow(MEDICINE);
    expect(row?.lifecycle_state).toBe('ACTIVE');
    // "Stopped 1 June" on a medicine somebody is taking is a false statement on the screen a
    // household reads most. The history is in the audit log, which nobody can rewrite.
    expect(row?.stopped_on).toBeNull();
  });

  it('refuses a state nobody defined', async () => {
    const response = await patch(principalFor(OWNER), MEDICINE, {
      expectedVersion: 1,
      lifecycleState: 'PAUSED',
    });
    expect(response.statusCode).toBe(400);
    expect((await storedRow(MEDICINE))?.lifecycle_state).toBe('ACTIVE');
  });
});

describe('marking something looked at', () => {
  it('stamps the time on the server rather than taking one', async () => {
    const response = await patch(principalFor(OWNER), MEDICINE, {
      expectedVersion: 1,
      markReviewed: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<UpdatedBody>().lastReviewedAt).not.toBeNull();
    expect(response.json<UpdatedBody>().changedFields).toEqual(['lastReviewedAt']);

    expect((await storedRow(MEDICINE))?.last_reviewed_at).not.toBeNull();
  });

  it('stops the item being listed as never looked at', async () => {
    await patch(principalFor(OWNER), MEDICINE, { expectedVersion: 1, markReviewed: true });

    const body = (await detail(principalFor(OWNER), MEDICINE)).json<{
      attentionReasonCodes: readonly string[];
    }>();
    expect(body.attentionReasonCodes).not.toContain('NEVER_REVIEWED');
  });

  it('confirms nothing about the product', async () => {
    // `08` reserves confirmation for something read off the pack. Looking at a record is not that.
    await patch(principalFor(OWNER), MEDICINE, { expectedVersion: 1, markReviewed: true });

    const row = await storedRow(MEDICINE);
    expect(row?.identity_verification).toBe('UNVERIFIED');
    expect(row?.formulation_verification).toBe('UNVERIFIED');
    expect(row?.batch_verification).toBe('UNVERIFIED');
  });
});

describe('the audit trail', () => {
  /**
   * Each test writes to its own item.
   *
   * `audit_event` is append-only by trigger and refuses DELETE to every role, the owner role
   * included (trap 105), so rows from one test are still there for the next. Scoping by target is
   * the only way to assert a count.
   */
  let target = 0;
  const freshItem = async (): Promise<string> => {
    target += 1;
    const id = testUuid(700 + target);
    await t.asOwner((db) =>
      db.query(
        `INSERT INTO owned_item
           (id, profile_id, item_kind, display_name, strength_text, market)
         VALUES ($1, $2, 'MEDICINE', 'Audited Tablet', '500 mg', 'GB')`,
        [id, PROFILE],
      ),
    );
    return id;
  };

  it('records what changed, and no value', async () => {
    const item = await freshItem();
    // `owned_item` holds one row and an update overwrites it, so `audit_event` is the only place
    // the sequence lives. `14` keeps the content of somebody's medicine record out of a log.
    await patch(principalFor(OWNER), item, {
      expectedVersion: 1,
      strengthText: '250 mg',
      notes: 'Half the dose now.',
    });

    const events = await t.asService((db) =>
      db.query<{ action: string; detail: Record<string, unknown>; target_version: string | null }>(
        `SELECT action, detail, target_version FROM audit_event
          WHERE target_kind = 'owned_item' AND target_id = $1`,
        [item],
      ),
    );

    expect(events.rows.length).toBe(1);
    const event = events.rows[0];
    expect(event?.action).toBe('OWNED_ITEM_UPDATED');
    expect(event?.target_version).toBe('2');
    expect(event?.detail['changed_fields']).toEqual(['notes', 'strengthText']);

    const serialized = JSON.stringify(event?.detail);
    expect(serialized).not.toContain('250 mg');
    expect(serialized).not.toContain('Half the dose');
  });

  it('writes nothing when the change was refused', async () => {
    const item = await freshItem();

    await patch(principalFor(READER), item, { expectedVersion: 1, strengthText: '250 mg' });
    await patch(principalFor(OWNER), item, { expectedVersion: 99, strengthText: '250 mg' });
    await patch(principalFor(OWNER), item, { expectedVersion: 1, market: 'gb' });

    const events = await t.asService((db) =>
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_event
          WHERE target_kind = 'owned_item' AND target_id = $1`,
        [item],
      ),
    );
    expect(events.rows[0]?.n).toBe('0');
  });
});

describe('the prefill the edit form reads', () => {
  /**
   * `editableValues` is a second representation of the same row, keyed as the form keys it.
   *
   * The failure it prevents is silent: a form field with no entry opens blank, the person saves,
   * and a value they never touched is cleared. Nothing else would notice - the write succeeded,
   * the version moved, and the field is legitimately nullable.
   */

  it('has an entry for every field the form for that category offers', async () => {
    for (const [itemId, itemKind] of [
      [MEDICINE, 'MEDICINE'],
      [SHAMPOO, 'PERSONAL_CARE'],
    ] as const) {
      const body = (await detail(principalFor(OWNER), itemId)).json<{
        editableValues: Record<string, string | null>;
      }>();

      for (const field of manualEntryForm(itemKind).fields) {
        expect(Object.keys(body.editableValues), `${itemKind}: ${field.field}`).toContain(
          field.field,
        );
      }
    }
  });

  it('carries the stored value rather than the rendered one', async () => {
    // The category is a code here and a phrase on `categoryFields`. A form prefilled with "Hair
    // care" would send a category the domain refuses, naming a field the person never edited.
    const body = (await detail(principalFor(OWNER), SHAMPOO)).json<{
      editableValues: Record<string, string | null>;
      categoryFields: readonly { label: string; value: string | null }[];
    }>();

    expect(body.editableValues['personalCareCategory']).toBe('HAIR_CARE');
    expect(body.categoryFields.find((f) => f.label === 'Kind of product')?.value).toBe('Hair care');
  });

  it('says an absent field is absent rather than empty', async () => {
    const body = (await detail(principalFor(OWNER), MEDICINE)).json<{
      editableValues: Record<string, string | null>;
    }>();

    expect(body.editableValues['manufacturer']).toBeNull();
    expect(body.editableValues['recordedGtin']).toBeNull();
  });

  it('round-trips: what the form was given is what saving it back stores', async () => {
    // The whole prefill sent back unchanged must be a no-op, and the route refuses a save that
    // changes nothing - which is what makes this an assertion rather than a tautology. A field the
    // prefill got wrong would show up here as a change nobody made.
    const body = (await detail(principalFor(OWNER), MEDICINE)).json<{
      version: number;
      editableValues: Record<string, string | null>;
    }>();

    const response = await patch(principalFor(OWNER), MEDICINE, {
      expectedVersion: body.version,
      ...body.editableValues,
    });

    expect(response.statusCode).toBe(400);
    expect(
      response.json<{ error: { detail?: { reason_code?: string } } }>().error.detail?.reason_code,
    ).toBe('no_change');
  });
});

describe('moving between the shelf’s two collections (`0033`, DEC-160)', () => {
  it('starts everything in IN_USE, including rows created before the column', async () => {
    const row = await storedRow(SHAMPOO);
    expect(row?.['shelf_collection']).toBe('IN_USE');
  });

  it('moves a personal-care product to Considering, and says that is what changed', async () => {
    const before = (await detail(principalFor(OWNER), SHAMPOO)).json<DetailBody>();
    const response = await patch(principalFor(OWNER), SHAMPOO, {
      expectedVersion: before.version,
      shelfCollection: 'CONSIDERING',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<UpdatedBody>().changedFields).toEqual(['shelfCollection']);
    expect((await storedRow(SHAMPOO))?.['shelf_collection']).toBe('CONSIDERING');

    // And back, so the rest of this file sees the shelf it expects.
    const moved = (await detail(principalFor(OWNER), SHAMPOO)).json<DetailBody>();
    await patch(principalFor(OWNER), SHAMPOO, {
      expectedVersion: moved.version,
      shelfCollection: 'IN_USE',
    });
  });

  it('refuses a medicine, with the reason rather than with a constraint violation', async () => {
    // The schema refuses it too (`owned_item_considering_is_personal_care`), and this is the half
    // a person reads. Everything this app does with a medicine presumes it is being taken.
    const before = (await detail(principalFor(OWNER), MEDICINE)).json<DetailBody>();
    const response = await patch(principalFor(OWNER), MEDICINE, {
      expectedVersion: before.version,
      shelfCollection: 'CONSIDERING',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /Considering is for products/i,
    );
    expect((await storedRow(MEDICINE))?.['shelf_collection']).toBe('IN_USE');
  });

  it('refuses a collection nobody declared', async () => {
    const before = (await detail(principalFor(OWNER), SHAMPOO)).json<DetailBody>();
    const response = await patch(principalFor(OWNER), SHAMPOO, {
      expectedVersion: before.version,
      shelfCollection: 'WISHLIST',
    });
    expect(response.statusCode).toBe(400);
    expect((await storedRow(SHAMPOO))?.['shelf_collection']).toBe('IN_USE');
  });

  it('takes the same version precondition as every other change', async () => {
    // `13` sets `owned_item` to ASK_USER. A move is a change to the record, so a stale one is the
    // same stale write as any other and must not silently win.
    //
    // The stale version is produced rather than assumed: this file shares one row across its
    // describes, so a hard-coded 1 would be measuring whichever test happened to run first.
    const stale = (await detail(principalFor(OWNER), SHAMPOO)).json<DetailBody>().version;
    const moved = await patch(principalFor(OWNER), SHAMPOO, {
      expectedVersion: stale,
      shelfCollection: 'CONSIDERING',
    });
    expect(moved.statusCode).toBe(200);

    const again = await patch(principalFor(OWNER), SHAMPOO, {
      expectedVersion: stale,
      shelfCollection: 'IN_USE',
    });
    expect(again.statusCode).toBe(409);
    expect((await storedRow(SHAMPOO))?.['shelf_collection']).toBe('CONSIDERING');

    const now = (await detail(principalFor(OWNER), SHAMPOO)).json<DetailBody>().version;
    await patch(principalFor(OWNER), SHAMPOO, {
      expectedVersion: now,
      shelfCollection: 'IN_USE',
    });
  });
});
