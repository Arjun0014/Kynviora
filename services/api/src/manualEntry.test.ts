import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  MANUAL_ENTRY_LIMITS,
  instantFrom,
  noopLogger,
  unsafeId,
  type Instant,
  type UserId,
} from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Phases 2.2 and 2.3, against a real engine.
 *
 * `POST /v1/items` is the only way anything in this build creates an `owned_item` from a user
 * surface. Both phases' exit criteria are asserted over the wire, and so are the two boundaries
 * that make the route safe: the capability split between shelf and medicines, and the fact that a
 * hand-typed record never reaches the shared catalog.
 */

const OWNER = testUuid(1);
const SHELF_ONLY = testUuid(2);
const MEDICINES_CAREGIVER = testUuid(3);
const READER = testUuid(4);
const STRANGER = testUuid(5);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const OTHER_PROFILE = testUuid(21);

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
      [SHELF_ONLY, 'shelf@example.test'],
      [MEDICINES_CAREGIVER, 'meds@example.test'],
      [READER, 'reader@example.test'],
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
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Nobody (synthetic)')`,
      [OTHER_PROFILE, HOUSEHOLD, STRANGER],
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
    await db.query('DELETE FROM caregiver_grant');
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
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

interface CreatedBody {
  readonly id: string;
  readonly heading: string;
  readonly limits: readonly string[];
  readonly limitCodes: readonly string[];
  readonly completeNote: string | null;
  readonly note: string;
}

/**
 * A key nobody has used before.
 *
 * Fresh per call by default, because these tests are about what one save does. The retry tests
 * pass the same key twice deliberately, and that is the whole difference between them.
 */
let nextKey = 1000;
function freshKey(): string {
  nextKey += 1;
  return testUuid(nextKey);
}

async function create(
  as: Principal | null,
  body: Record<string, unknown>,
  options: { readonly key?: string | null; readonly profileId?: string } = {},
) {
  const key = options.key === undefined ? freshKey() : options.key;
  return request(as, {
    method: 'POST',
    url: '/v1/items',
    payload: { profileId: options.profileId ?? PROFILE, ...body },
    ...(key === null ? {} : { headers: { 'idempotency-key': key } }),
  });
}

async function storedRow(id: string) {
  const result = await t.asService((db) =>
    db.query<Record<string, unknown>>('SELECT * FROM owned_item WHERE id = $1', [id]),
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------

describe('exit criterion 2.2a - a useful record, entirely by hand', () => {
  it('creates a medicine from a name and nothing else', async () => {
    const response = await create(principalFor(OWNER), {
      itemKind: 'MEDICINE',
      displayName: 'Synthetic Tablet',
    });
    expect(response.statusCode).toBe(201);

    const row = await storedRow(response.json<CreatedBody>().id);
    expect(row?.display_name).toBe('Synthetic Tablet');
    expect(row?.item_kind).toBe('MEDICINE');
    // It is on the shelf, and it is readable through the route Phase 2.1 built.
    const detail = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/items/${response.json<CreatedBody>().id}`,
    });
    expect(detail.statusCode).toBe(200);
  });

  it('creates a personal-care product with everything Phase 2.3 asks for', async () => {
    const response = await create(principalFor(OWNER), {
      itemKind: 'PERSONAL_CARE',
      displayName: 'Synthetic Shampoo',
      brand: 'Synthetic Brand',
      manufacturer: 'Synthetic Manufacturing Ltd',
      market: 'GB',
      recordedGtin: '1234567890123',
      recordedLotCode: 'LOT-1',
      personalCareCategory: 'HAIR_CARE',
      ingredientDeclarationRaw: 'Aqua, Sodium Laureth Sulfate, Glycerin',
      labelVersionNote: 'Says new formula on the front',
      expiresOn: '2027-01-31',
    });
    expect(response.statusCode).toBe(201);

    const row = await storedRow(response.json<CreatedBody>().id);
    // Exit criterion 2.3b: not reduced to name plus barcode.
    expect(row?.manufacturer).toBe('Synthetic Manufacturing Ltd');
    expect(row?.personal_care_category).toBe('HAIR_CARE');
    expect(row?.ingredient_declaration_raw).toBe('Aqua, Sodium Laureth Sulfate, Glycerin');
    expect(row?.label_version_note).toBe('Says new formula on the front');
    expect(row?.recorded_lot_code).toBe('LOT-1');
  });

  it('keeps a medicine directions exactly as typed', async () => {
    const written = 'Take ONE tablet at 8am and 8pm. Do not exceed two in 24 hours.';
    const response = await create(principalFor(OWNER), {
      itemKind: 'MEDICINE',
      displayName: 'Synthetic Tablet',
      directionsText: written,
    });
    const row = await storedRow(response.json<CreatedBody>().id);
    // `04` Phase 4.1 preserves the source text; `09` forbids Kynviora rewriting it.
    expect(row?.directions_text).toBe(written);
  });
});

describe('exit criterion 2.2b - missing fields stay explicitly unknown', () => {
  it('stores every unentered field as NULL rather than as a default', async () => {
    const response = await create(principalFor(OWNER), {
      itemKind: 'MEDICINE',
      displayName: 'Synthetic Tablet',
    });
    const row = await storedRow(response.json<CreatedBody>().id);
    for (const column of [
      'brand',
      'manufacturer',
      'market',
      'recorded_gtin',
      'recorded_lot_code',
      'expires_on',
      'started_on',
      'notes',
      'strength_text',
      'dosage_form',
      'directions_text',
      'personal_care_category',
      'ingredient_declaration_raw',
      'label_version_note',
    ]) {
      expect(row?.[column]).toBeNull();
    }
  });

  it('stores a field of spaces as an absence', async () => {
    const response = await create(principalFor(OWNER), {
      itemKind: 'MEDICINE',
      displayName: 'Synthetic Tablet',
      brand: '   ',
    });
    expect(response.statusCode).toBe(201);
    expect((await storedRow(response.json<CreatedBody>().id))?.brand).toBeNull();
  });

  it('leaves all three verification axes unverified', async () => {
    const response = await create(principalFor(OWNER), {
      itemKind: 'MEDICINE',
      displayName: 'Synthetic Tablet',
    });
    const row = await storedRow(response.json<CreatedBody>().id);
    // `08` reserves CONFIRMED for something read off the pack. UNVERIFIED is the vocabulary's
    // word for "nobody has checked" rather than a default answer.
    expect(row?.identity_verification).toBe('UNVERIFIED');
    expect(row?.formulation_verification).toBe('UNVERIFIED');
    expect(row?.batch_verification).toBe('UNVERIFIED');
  });

  it('refuses a submission that tries to claim one', async () => {
    // The body schema is `.strict()`, so a field that could carry a claim is a 400 rather than a
    // silently ignored key. Silently ignoring it would let a client believe it had set one.
    for (const extra of [
      { identityVerification: 'CONFIRMED' },
      { formulationVerification: 'CONFIRMED' },
      { productIdentityId: testUuid(99) },
      { formulationId: testUuid(99) },
      { batchId: testUuid(99) },
      { lifecycleState: 'ARCHIVED' },
    ]) {
      const response = await create(principalFor(OWNER), {
        itemKind: 'MEDICINE',
        displayName: 'Synthetic Tablet',
        ...extra,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('says what the record cannot do, without counting or scoring', async () => {
    const response = await create(principalFor(OWNER), {
      itemKind: 'MEDICINE',
      displayName: 'Synthetic Tablet',
    });
    const body = response.json<CreatedBody>();
    expect(body.limitCodes).toEqual([...MANUAL_ENTRY_LIMITS]);
    expect(body.limits.length).toBe(MANUAL_ENTRY_LIMITS.length);
    expect(body.completeNote).toBeNull();
    // `10` at the moment a person can still act on it, and `02`'s refusal of the aggregate.
    for (const forbidden of ['count', 'percent', 'complete', 'score']) {
      expect(Object.keys(body)).not.toContain(forbidden);
    }
  });
});

describe('nothing typed by hand reaches the catalog', () => {
  it('leaves every catalog link null', async () => {
    const response = await create(principalFor(OWNER), {
      itemKind: 'PERSONAL_CARE',
      displayName: 'Synthetic Shampoo',
      recordedGtin: '1234567890123',
      ingredientDeclarationRaw: 'Aqua, Glycerin',
    });
    const row = await storedRow(response.json<CreatedBody>().id);
    // `15` A11 with the attacker replaced by an honest person mis-reading a label. Promotion is
    // `04` Phase 3.5's corroborated path and stays separate.
    expect(row?.product_identity_id).toBeNull();
    expect(row?.formulation_id).toBeNull();
    expect(row?.batch_id).toBeNull();
  });

  it('creates no catalog row of any kind', async () => {
    await create(principalFor(OWNER), {
      itemKind: 'PERSONAL_CARE',
      displayName: 'Synthetic Shampoo',
      recordedGtin: '1234567890123',
      ingredientDeclarationRaw: 'Aqua, Glycerin',
      recordedLotCode: 'LOT-1',
    });
    for (const table of ['product_identity', 'marketed_formulation', 'batch_or_lot']) {
      const rows = await t.asService((db) =>
        db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`),
      );
      expect(Number(rows.rows[0]?.n)).toBe(0);
    }
  });
});

describe('what the route refuses', () => {
  it('refuses a submission with no name', async () => {
    const response = await create(principalFor(OWNER), {
      itemKind: 'MEDICINE',
      displayName: '   ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { detail: { field: string } } }>().error.detail.field).toBe(
      'displayName',
    );
  });

  it('names the field it refused, so a form can point at it', async () => {
    const response = await create(principalFor(OWNER), {
      itemKind: 'MEDICINE',
      displayName: 'Synthetic Tablet',
      recordedGtin: '123',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { detail: { field: string } } }>().error.detail.field).toBe(
      'recordedGtin',
    );
  });

  it('refuses a field belonging to the other category', async () => {
    expect(
      (
        await create(principalFor(OWNER), {
          itemKind: 'MEDICINE',
          displayName: 'Synthetic Tablet',
          personalCareCategory: 'HAIR_CARE',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await create(principalFor(OWNER), {
          itemKind: 'PERSONAL_CARE',
          displayName: 'Synthetic Shampoo',
          strengthText: '500 mg',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('writes nothing when it refuses', async () => {
    await create(principalFor(OWNER), {
      itemKind: 'MEDICINE',
      displayName: 'Synthetic Tablet',
      market: 'gb',
    });
    const rows = await t.asService((db) =>
      db.query<{ n: string }>('SELECT count(*) AS n FROM owned_item'),
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });
});

describe('who may add an item', () => {
  it('lets a caregiver with MANAGE_SHELF add a personal-care product', async () => {
    await grant(SHELF_ONLY, ['VIEW_SHELF', 'MANAGE_SHELF']);
    expect(
      (
        await create(principalFor(SHELF_ONLY), {
          itemKind: 'PERSONAL_CARE',
          displayName: 'Synthetic Shampoo',
        })
      ).statusCode,
    ).toBe(201);
  });

  it('does not let the same caregiver add a medicine', async () => {
    await grant(SHELF_ONLY, ['VIEW_SHELF', 'MANAGE_SHELF']);
    // `owned_item_insert` requires MANAGE_MEDICINES for a medicine, and `03` group H keeps the two
    // apart. Somebody trusted with the bathroom cabinet is not automatically trusted with the
    // medicine list.
    expect(
      (
        await create(principalFor(SHELF_ONLY), {
          itemKind: 'MEDICINE',
          displayName: 'Synthetic Tablet',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('lets a caregiver with MANAGE_MEDICINES add one', async () => {
    await grant(MEDICINES_CAREGIVER, ['VIEW_MEDICINES', 'MANAGE_MEDICINES']);
    expect(
      (
        await create(principalFor(MEDICINES_CAREGIVER), {
          itemKind: 'MEDICINE',
          displayName: 'Synthetic Tablet',
        })
      ).statusCode,
    ).toBe(201);
  });

  it('refuses a caregiver who may only read', async () => {
    await grant(READER, ['VIEW_SHELF', 'VIEW_MEDICINES']);
    expect(
      (
        await create(principalFor(READER), {
          itemKind: 'PERSONAL_CARE',
          displayName: 'Synthetic Shampoo',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('refuses a stranger and an unknown profile identically', async () => {
    const stranger = await create(principalFor(STRANGER), {
      itemKind: 'MEDICINE',
      displayName: 'Synthetic Tablet',
    });
    const unknown = await create(
      principalFor(OWNER),
      { itemKind: 'MEDICINE', displayName: 'Synthetic Tablet' },
      { profileId: testUuid(999) },
    );
    // A profile this caller cannot write to and one that does not exist are the same answer, so
    // the route is not an oracle for either.
    expect(stranger.statusCode).toBe(unknown.statusCode);
    expect(stranger.json<{ error: { code: string } }>().error.code).toBe(
      unknown.json<{ error: { code: string } }>().error.code,
    );
  });

  it('will not let anybody write to a profile in the same household they do not hold', async () => {
    const response = await create(
      principalFor(OWNER),
      { itemKind: 'MEDICINE', displayName: 'Synthetic Tablet' },
      { profileId: OTHER_PROFILE },
    );
    // Sharing a household is not a capability. `13`: a profile ID narrows a result set and never
    // grants access.
    expect(response.statusCode).toBe(404);
  });

  it('rejects an unauthenticated write', async () => {
    expect(
      (await create(null, { itemKind: 'MEDICINE', displayName: 'Synthetic Tablet' })).statusCode,
    ).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe('a save that arrives twice writes one item', () => {
  /**
   * `13`: "Idempotency key on mutations that can be retried"; "server commits exactly once".
   *
   * The screen is what makes this reachable. A person on a bad connection taps Save, sees
   * nothing, and taps again - and without a key that is a second medicine record. `04` Phase 8.5
   * reconciles this shelf against a list somebody was handed, where two identical rows read as
   * two medicines they are taking: a false statement about somebody's treatment, produced by a
   * dropped connection.
   */

  it('requires a key rather than accepting the write without one', async () => {
    const response = await create(
      principalFor(OWNER),
      { itemKind: 'MEDICINE', displayName: 'Synthetic Tablet' },
      { key: null },
    );

    expect(response.statusCode).toBe(400);
    expect(
      response.json<{ error: { detail?: { reason_code?: string } } }>().error.detail?.reason_code,
    ).toBe('idempotency_key_required');

    const count = await t.asService((db) =>
      db.query<{ n: string }>('SELECT count(*)::text AS n FROM owned_item'),
    );
    expect(count.rows[0]?.n).toBe('0');
  });

  it('writes one row and answers the retry with the same item', async () => {
    const key = freshKey();
    const body = { itemKind: 'MEDICINE', displayName: 'Synthetic Tablet', strengthText: '500 mg' };

    const first = await create(principalFor(OWNER), body, { key });
    const second = await create(principalFor(OWNER), body, { key });

    expect(first.statusCode).toBe(201);
    expect(first.json<{ replayed: boolean }>().replayed).toBe(false);

    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json<{ replayed: boolean }>().replayed).toBe(true);
    expect(second.json<CreatedBody>().id).toBe(first.json<CreatedBody>().id);

    const count = await t.asService((db) =>
      db.query<{ n: string }>('SELECT count(*)::text AS n FROM owned_item'),
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  it('describes the record that exists, not the body that arrived second', async () => {
    // A retry carrying a changed field is answered about the row that is actually there. On a
    // screen whose subject is what Kynviora does and does not hold about a pack, describing a
    // record nobody has is exactly the failure this route is meant to prevent.
    const key = freshKey();

    const first = await create(
      principalFor(OWNER),
      { itemKind: 'MEDICINE', displayName: 'Synthetic Tablet' },
      { key },
    );
    const second = await create(
      principalFor(OWNER),
      {
        itemKind: 'MEDICINE',
        displayName: 'Synthetic Tablet',
        recordedGtin: '1234567890123',
        expiresOn: '2027-01-31',
      },
      { key },
    );

    expect(second.statusCode).toBe(200);
    // The stored row has neither, so both limits still stand.
    expect(second.json<CreatedBody>().limitCodes).toContain('NO_IDENTIFIER');
    expect(second.json<CreatedBody>().limitCodes).toContain('NO_EXPIRY');
    expect(second.json<CreatedBody>().limitCodes).toEqual(first.json<CreatedBody>().limitCodes);

    const row = await storedRow(first.json<CreatedBody>().id);
    expect(row?.recorded_gtin).toBeNull();
    expect(row?.expires_on).toBeNull();
  });

  it('lets two different saves through', async () => {
    // The guarantee is about one intent arriving twice, not about a person adding two packs.
    await create(principalFor(OWNER), { itemKind: 'MEDICINE', displayName: 'One' });
    await create(principalFor(OWNER), { itemKind: 'MEDICINE', displayName: 'Two' });

    const count = await t.asService((db) =>
      db.query<{ n: string }>('SELECT count(*)::text AS n FROM owned_item'),
    );
    expect(count.rows[0]?.n).toBe('2');
  });

  it('scopes the key to the profile, so one household cannot refuse another household write', async () => {
    // dose_event's key is globally unique, and under that shape a key another household already
    // used makes this INSERT conflict - and the replay read then finds nothing under row-level
    // security, so the second household's item is dropped and answered with a success carrying no
    // ID. Scoped to the profile, the collision is unreachable.
    const key = freshKey();

    const mine = await create(
      principalFor(OWNER),
      { itemKind: 'MEDICINE', displayName: 'Synthetic Tablet' },
      { key },
    );
    expect(mine.statusCode).toBe(201);

    // The stranger owns OTHER_PROFILE and writes to it with the very same key.
    const theirs = await create(
      principalFor(STRANGER),
      { itemKind: 'MEDICINE', displayName: 'Their Tablet' },
      { key, profileId: OTHER_PROFILE },
    );

    expect(theirs.statusCode).toBe(201);
    expect(theirs.json<CreatedBody>().id).not.toBe(mine.json<CreatedBody>().id);

    const count = await t.asService((db) =>
      db.query<{ n: string }>('SELECT count(*)::text AS n FROM owned_item'),
    );
    expect(count.rows[0]?.n).toBe('2');
  });

  it('does not turn a retry into an oracle for somebody else profile', async () => {
    // The stranger writes with a key, then the owner replays that key against the stranger's
    // profile. The row exists and the owner may not read it, so the answer is the same not-found
    // a profile that does not exist gives.
    const key = freshKey();

    const theirs = await create(
      principalFor(STRANGER),
      { itemKind: 'MEDICINE', displayName: 'Their Tablet' },
      { key, profileId: OTHER_PROFILE },
    );
    expect(theirs.statusCode).toBe(201);

    const probe = await create(
      principalFor(OWNER),
      { itemKind: 'MEDICINE', displayName: 'Synthetic Tablet' },
      { key, profileId: OTHER_PROFILE },
    );

    expect(probe.statusCode).toBe(404);
  });

  it('refuses a malformed body before it can consume a key', async () => {
    // A refusal must be retryable with the same key. A body the domain rejected wrote nothing, so
    // the corrected submission has to be able to reuse the key the screen already generated -
    // otherwise every validation error would silently need a new one.
    const key = freshKey();

    const refused = await create(
      principalFor(OWNER),
      { itemKind: 'MEDICINE', displayName: '   ' },
      { key },
    );
    expect(refused.statusCode).toBe(400);

    const corrected = await create(
      principalFor(OWNER),
      { itemKind: 'MEDICINE', displayName: 'Synthetic Tablet' },
      { key },
    );
    expect(corrected.statusCode).toBe(201);
    expect(corrected.json<{ replayed: boolean }>().replayed).toBe(false);
  });
});
