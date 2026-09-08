import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import { parseComparedIds } from './compare.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Comparing products, over the wire.
 *
 * Spec references: `09`, `02`, `23` D-014, `13` (a profile ID narrows and never grants), `11`,
 * DEC-162.
 *
 * `packages/catalog/src/compare.test.ts` measures the comparison itself. This measures the three
 * things only the route decides: who may see which columns, that a product the caller cannot see
 * is *counted* rather than silently dropped, and that a request nobody could answer is a refusal
 * rather than an empty report.
 */

const OWNER = testUuid(1);
const SHELF_CAREGIVER = testUuid(2);
const STRANGER = testUuid(3);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);
const OTHER_PROFILE = testUuid(21);

const TOOTHPASTE_A = testUuid(30);
const TOOTHPASTE_B = testUuid(31);
const NO_DECLARATION = testUuid(32);
const MEDICINE = testUuid(33);
const ELSEWHERE = testUuid(34);

const NOW = instantFrom('2026-09-09T12:00:00.000Z');

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
      [SHELF_CAREGIVER, 'shelf@example.test'],
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
    for (const [id, name] of [
      [PROFILE, 'Parent A (synthetic)'],
      [OTHER_PROFILE, 'Parent B (synthetic)'],
    ] as const) {
      await db.query(
        `INSERT INTO profile (id, household_id, owner_user_id, display_name)
         VALUES ($1, $2, $3, $4)`,
        [id, HOUSEHOLD, OWNER, name],
      );
    }

    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, personal_care_category,
          ingredient_declaration_raw)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Synthetic Toothpaste A', 'ORAL_CARE',
               'Aqua, Sodium fluoride, Sorbitol, Aroma')`,
      [TOOTHPASTE_A, PROFILE],
    );
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, personal_care_category,
          ingredient_declaration_raw)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Synthetic Toothpaste B', 'ORAL_CARE',
               'Aqua, Sorbitol, Sodium lauryl sulfate')`,
      [TOOTHPASTE_B, PROFILE],
    );
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, personal_care_category)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Synthetic Toothpaste C', 'ORAL_CARE')`,
      [NO_DECLARATION, PROFILE],
    );
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet')`,
      [MEDICINE, PROFILE],
    );
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, personal_care_category,
          ingredient_declaration_raw)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Somebody else''s toothpaste', 'ORAL_CARE', 'Aqua')`,
      [ELSEWHERE, OTHER_PROFILE],
    );

    await db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, ARRAY['VIEW_SHELF']::text[], 'ACTIVE', now())`,
      [PROFILE, SHELF_CAREGIVER, OWNER],
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

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

interface CompareBody {
  readonly products: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly hasDeclaration: boolean;
    readonly declaredTermCount: number;
    readonly identity: { readonly label: string };
  }[];
  readonly shared: readonly { readonly term: string; readonly cells: readonly string[] }[];
  readonly differing: readonly { readonly term: string; readonly cells: readonly string[] }[];
  readonly declaringCount: number;
  readonly matchedByPrintedTermOnly: boolean;
  readonly notAvailableCount: number;
}

const compare = (as: Principal | null, ids: readonly string[]) =>
  request(as, {
    method: 'GET',
    url: `/v1/compare?profileId=${PROFILE}&itemIds=${ids.join(',')}`,
  });

// ---------------------------------------------------------------------------

describe('which identifiers a comparison will take', () => {
  it('needs at least two', () => {
    expect(parseComparedIds(testUuid(30)).ok).toBe(false);
  });

  it('takes at most four, because a fifth column stops being readable before it stops computing', () => {
    const five = [30, 31, 32, 33, 34].map((n) => testUuid(n)).join(',');
    expect(parseComparedIds(five).ok).toBe(false);
  });

  it('refuses the same product twice', () => {
    // Two identical columns read as two products that agree about everything.
    expect(parseComparedIds(`${TOOTHPASTE_A},${TOOTHPASTE_A}`).ok).toBe(false);
  });

  it('takes two to four distinct identifiers', () => {
    const outcome = parseComparedIds(`${TOOTHPASTE_A}, ${TOOTHPASTE_B}`);
    expect(outcome.ok ? outcome.value : null).toEqual([TOOTHPASTE_A, TOOTHPASTE_B]);
  });
});

describe('comparing what two products declare', () => {
  it('answers for the owner, in the order they chose', () => {
    // Not the order the database returned: the columns of a comparison are the columns somebody
    // picked, and reordering them would be the route deciding which product goes first (`02`).
    return compare(principalFor(OWNER), [TOOTHPASTE_B, TOOTHPASTE_A]).then((response) => {
      expect(response.statusCode).toBe(200);
      const body = response.json<CompareBody>();
      expect(body.products.map((product) => product.id)).toEqual([TOOTHPASTE_B, TOOTHPASTE_A]);
      expect(body.shared.map((row) => row.term)).toEqual(['Aqua', 'Sorbitol']);
      expect(body.declaringCount).toBe(2);
      expect(body.notAvailableCount).toBe(0);
    });
  });

  it('keeps the three verification axes apart on every column', async () => {
    const body = (
      await compare(principalFor(OWNER), [TOOTHPASTE_A, TOOTHPASTE_B])
    ).json<CompareBody>();
    for (const product of body.products) {
      expect(product.identity.label.length).toBeGreaterThan(0);
    }
    // And there is no combined verdict anywhere on the response (`02`).
    expect(JSON.stringify(body)).not.toMatch(/"verified"|"score"|"best"|"rank"/i);
  });

  it('never says a product without a declaration does not list something', async () => {
    // `23` D-014 in a table. Every cell for a product nobody entered anything for reads
    // NO_DECLARATION, including the terms the others do not list either.
    const body = (
      await compare(principalFor(OWNER), [TOOTHPASTE_A, NO_DECLARATION])
    ).json<CompareBody>();
    expect(body.declaringCount).toBe(1);
    expect(body.shared).toEqual([]);
    for (const row of body.differing) expect(row.cells[1]).toBe('NO_DECLARATION');
  });

  it('says the matching was on the printed term', async () => {
    // `BLK-003`: the substance vocabulary is empty, so the report says what it did rather than
    // letting a reader assume synonyms were resolved.
    const body = (
      await compare(principalFor(OWNER), [TOOTHPASTE_A, TOOTHPASTE_B])
    ).json<CompareBody>();
    expect(body.matchedByPrintedTermOnly).toBe(true);
  });
});

describe('what a comparison refuses', () => {
  it('refuses to compare a medicine with a product', async () => {
    const response = await compare(principalFor(OWNER), [TOOTHPASTE_A, MEDICINE]);
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /medicines with medicines/i,
    );
  });

  it('counts a product this caller cannot see rather than dropping it silently', async () => {
    // The caregiver can see the shelf, so all three columns are theirs. What is not theirs is the
    // other profile's product - and a table of two where three were chosen is a different report.
    const body = (
      await compare(principalFor(SHELF_CAREGIVER), [TOOTHPASTE_A, TOOTHPASTE_B, ELSEWHERE])
    ).json<CompareBody>();
    expect(body.products).toHaveLength(2);
    expect(body.notAvailableCount).toBe(1);
  });

  it('refuses rather than drawing an empty comparison when almost nothing is visible', async () => {
    // "We could not find them" and "they have nothing in common" are different sentences, and a
    // stranger must read the first.
    const response = await compare(principalFor(STRANGER), [TOOTHPASTE_A, TOOTHPASTE_B]);
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /could not find enough/i,
    );
  });

  it('refuses an unauthenticated request', async () => {
    expect((await compare(null, [TOOTHPASTE_A, TOOTHPASTE_B])).statusCode).toBe(401);
  });

  it('is not an oracle for a product on another profile', async () => {
    // The profile ID narrows; it does not grant. Asking about somebody else's product under this
    // profile answers exactly as asking about one that does not exist.
    const response = await compare(principalFor(OWNER), [TOOTHPASTE_A, ELSEWHERE]);
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /could not find enough/i,
    );
  });
});
