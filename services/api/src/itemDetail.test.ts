import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  attentionReasons,
  instantFrom,
  noopLogger,
  unsafeId,
  type Instant,
  type UserId,
} from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Phase 2.1's remainder, against a real engine.
 *
 * The item detail route and the verification / attention filters. Both exit criteria are asserted
 * over the wire: that neither category is reduced to a generic note, and that a person can see
 * which items need verification or review - the second on the list itself rather than only for
 * somebody who already knew to filter for it.
 */

const OWNER = testUuid(1);
const CAREGIVER_MEDICINES = testUuid(2);
const CAREGIVER_SAFETY_ONLY = testUuid(3);
const STRANGER = testUuid(4);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

const MEDICINE = testUuid(30);
const PERSONAL_CARE = testUuid(31);
const SETTLED = testUuid(32);
const CONFLICTED = testUuid(33);
const STOPPED = testUuid(34);

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
      [CAREGIVER_MEDICINES, 'meds@example.test'],
      [CAREGIVER_SAFETY_ONLY, 'safety@example.test'],
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

    // A medicine with everything a medicine has, nothing confirmed but its identity.
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, brand, market, strength_text, dosage_form,
          directions_text, identity_verification, started_on, expires_on)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet', 'Synthetic Brand', 'GB', '500 mg',
               'Tablet', 'Take one twice a day with food.', 'CONFIRMED', '2026-08-01',
               '2027-01-01')`,
      [MEDICINE, PROFILE],
    );
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, personal_care_category)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Synthetic Shampoo', 'HAIR_CARE')`,
      [PERSONAL_CARE, PROFILE],
    );
    // Nothing outstanding: every axis confirmed and both timestamps set.
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, identity_verification,
          formulation_verification, batch_verification, last_reviewed_at, last_safety_checked_at)
       VALUES ($1, $2, 'MEDICINE', 'Settled Tablet', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED',
               $3, $3)`,
      [SETTLED, PROFILE, NOW],
    );
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, formulation_verification,
          identity_verification, batch_verification, last_reviewed_at, last_safety_checked_at)
       VALUES ($1, $2, 'MEDICINE', 'Conflicted Tablet', 'CONFLICTING', 'CONFIRMED', 'CONFIRMED',
               $3, $3)`,
      [CONFLICTED, PROFILE, NOW],
    );
    // Finished with, and unverified in every way. Must be asked about by nothing.
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, lifecycle_state)
       VALUES ($1, $2, 'MEDICINE', 'Stopped Tablet', 'STOPPED')`,
      [STOPPED, PROFILE],
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
  await t.asOwner((db) => db.query('DELETE FROM caregiver_grant'));
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

interface DetailBody {
  readonly id: string;
  readonly displayName: string;
  readonly itemKind: string;
  readonly categoryHeading: string;
  readonly categoryFields: readonly {
    readonly label: string;
    readonly value: string | null;
    readonly absentNote: string | null;
    readonly quoted: boolean;
  }[];
  readonly sharedFields: readonly { readonly label: string; readonly value: string | null }[];
  readonly identity: { readonly label: string };
  readonly formulation: { readonly label: string };
  readonly batch: { readonly label: string };
  readonly verificationNote: string;
  readonly lifecycleNote: string | null;
  readonly attention: {
    readonly reasons: readonly { readonly reason: string; readonly nextStep: string }[];
    readonly settledNote: string | null;
  };
  readonly attentionReasonCodes: readonly string[];
}

interface ShelfBody {
  readonly items: readonly {
    readonly id: string;
    readonly attentionReasons: readonly string[];
  }[];
}

async function detail(as: Principal | null, itemId: string) {
  return request(as, { method: 'GET', url: `/v1/items/${itemId}` });
}

async function shelf(as: Principal, query = '') {
  return request(as, {
    method: 'GET',
    url: `/v1/items?profileId=${PROFILE}${query}`,
  });
}

// ---------------------------------------------------------------------------

describe('exit criterion 1 - neither category is a generic note, over the wire', () => {
  it('gives a medicine its own fields, quoting the directions', async () => {
    const body = (await detail(principalFor(OWNER), MEDICINE)).json<DetailBody>();
    expect(body.categoryHeading).toBe('About this medicine');
    expect(body.categoryFields.map((f) => f.label)).toEqual([
      'Strength',
      'Form',
      'Directions as written',
    ]);
    const directions = body.categoryFields.find((f) => f.label === 'Directions as written');
    // Preserved as source text (`04` Phase 4.1) and marked as somebody else's words (`09`).
    expect(directions?.value).toBe('Take one twice a day with food.');
    expect(directions?.quoted).toBe(true);
  });

  it('gives a personal-care item its own, and none of the medicine ones', async () => {
    const body = (await detail(principalFor(OWNER), PERSONAL_CARE)).json<DetailBody>();
    expect(body.categoryHeading).toBe('About this product');
    expect(body.categoryFields.map((f) => f.label)).toEqual([
      'Kind of product',
      'Ingredients as printed',
      'Note about the label version',
    ]);
    expect(body.categoryFields[0]?.value).toBe('Hair care');
  });

  it('keeps a field nobody filled in as a row that says so', async () => {
    const body = (await detail(principalFor(OWNER), PERSONAL_CARE)).json<DetailBody>();
    const stopped = body.sharedFields.find((f) => f.label === 'Stopped');
    expect(stopped).toBeDefined();
    expect(stopped?.value).toBeNull();
  });

  it('presents the three verification axes separately and says why', async () => {
    const body = (await detail(principalFor(OWNER), MEDICINE)).json<DetailBody>();
    expect(body.identity.label.length).toBeGreaterThan(0);
    expect(body.formulation.label.length).toBeGreaterThan(0);
    expect(body.batch.label.length).toBeGreaterThan(0);
    expect(body.verificationNote).toContain('tracked separately');
    // `02` forbids the aggregate. One badge over three axes is that score with the number gone.
    for (const forbidden of ['verified', 'trustScore', 'overall', 'score']) {
      expect(Object.keys(body)).not.toContain(forbidden);
    }
  });
});

describe('exit criterion 2 - which items need verification or review', () => {
  it('says on the list itself, without anybody filtering for it', async () => {
    const body = (await shelf(principalFor(OWNER))).json<ShelfBody>();
    const medicine = body.items.find((i) => i.id === MEDICINE);
    // The criterion is that a person *can understand* which items need something. A list where
    // that is visible only to somebody who already knew to filter does not meet it.
    expect(medicine?.attentionReasons).toContain('FORMULATION_UNVERIFIED');
    expect(medicine?.attentionReasons).toContain('BATCH_UNVERIFIED');
    expect(medicine?.attentionReasons).toContain('NEVER_REVIEWED');
  });

  it('agrees with the domain on every row it returns', async () => {
    const body = (await shelf(principalFor(OWNER))).json<ShelfBody>();
    const rows = await t.asService((db) =>
      db.query<{
        id: string;
        identity_verification: string;
        formulation_verification: string;
        batch_verification: string;
        last_reviewed_at: Date | string | null;
        last_safety_checked_at: Date | string | null;
        lifecycle_state: string;
      }>(`SELECT * FROM owned_item WHERE profile_id = $1`, [PROFILE]),
    );

    for (const item of body.items) {
      const row = rows.rows.find((r) => r.id === item.id);
      expect(row).toBeDefined();
      if (row === undefined) continue;
      const expected = attentionReasons({
        identityVerification: row.identity_verification as never,
        formulationVerification: row.formulation_verification as never,
        batchVerification: row.batch_verification as never,
        lastReviewedAt:
          row.last_reviewed_at === null
            ? null
            : row.last_reviewed_at instanceof Date
              ? row.last_reviewed_at.toISOString()
              : row.last_reviewed_at,
        lastSafetyCheckedAt:
          row.last_safety_checked_at === null
            ? null
            : row.last_safety_checked_at instanceof Date
              ? row.last_safety_checked_at.toISOString()
              : row.last_safety_checked_at,
        lifecycleState: row.lifecycle_state,
      });
      expect(item.attentionReasons).toEqual([...expected]);
    }
  });

  it('says nothing outstanding about an item where everything is entered', async () => {
    const body = (await detail(principalFor(OWNER), SETTLED)).json<DetailBody>();
    expect(body.attentionReasonCodes).toEqual([]);
    // And does not present that as reassurance about the product (`18`).
    expect(body.attention.settledNote).toContain('about the record, not about the product');
  });

  it('gives every outstanding reason a next step about the record', async () => {
    const body = (await detail(principalFor(OWNER), MEDICINE)).json<DetailBody>();
    expect(body.attention.reasons.length).toBeGreaterThan(0);
    for (const reason of body.attention.reasons) {
      expect(reason.nextStep.length).toBeGreaterThan(0);
      expect(reason.nextStep).not.toMatch(/stop taking|do not take/i);
    }
  });

  it('asks nothing of an item somebody has finished with', async () => {
    const body = (await detail(principalFor(OWNER), STOPPED)).json<DetailBody>();
    // Unverified in every way and never reviewed, and still asked about by nothing.
    expect(body.attentionReasonCodes).toEqual([]);
    expect(body.lifecycleNote).toContain('does not ask you to check it any further');
  });
});

describe('the filters', () => {
  async function ids(query: string): Promise<readonly string[]> {
    const response = await shelf(principalFor(OWNER), query);
    expect(response.statusCode).toBe(200);
    return response.json<ShelfBody>().items.map((i) => i.id);
  }

  it('narrows by category', async () => {
    expect(await ids('&itemKind=PERSONAL_CARE')).toEqual([PERSONAL_CARE]);
  });

  it('narrows by lifecycle', async () => {
    expect(await ids('&lifecycleState=STOPPED')).toEqual([STOPPED]);
  });

  it('narrows by a verification state on any axis', async () => {
    // `08` keeps the three separate and this does not merge them: it asks "is any facet in this
    // state", which is what a person filtering for CONFLICTING is actually asking.
    expect(await ids('&verification=CONFLICTING')).toEqual([CONFLICTED]);
  });

  it('narrows by what needs verification', async () => {
    const found = await ids('&attention=NEEDS_VERIFICATION');
    expect(found).toContain(MEDICINE);
    expect(found).toContain(CONFLICTED);
    expect(found).not.toContain(SETTLED);
    // A stopped item is never asked to be verified, in the route as in the domain.
    expect(found).not.toContain(STOPPED);
  });

  it('narrows by what needs review', async () => {
    const found = await ids('&attention=NEEDS_REVIEW');
    expect(found).toContain(MEDICINE);
    expect(found).toContain(PERSONAL_CARE);
    expect(found).not.toContain(CONFLICTED);
    expect(found).not.toContain(SETTLED);
  });

  it('narrows by either', async () => {
    const found = await ids('&attention=ANY');
    expect(found).toContain(CONFLICTED);
    expect(found).toContain(MEDICINE);
    expect(found).not.toContain(SETTLED);
    expect(found).not.toContain(STOPPED);
  });

  it('refuses an unrecognised filter value rather than ignoring it', async () => {
    // Trap 79: a silently ignored filter widens the result set, and a silently dropped one
    // narrows it. Both are the failure a list about somebody's medicines cannot have.
    expect((await shelf(principalFor(OWNER), '&attention=SOMETHING')).statusCode).toBe(400);
    expect((await shelf(principalFor(OWNER), '&verification=SOMETHING')).statusCode).toBe(400);
  });

  it('composes with the others rather than replacing them', async () => {
    const found = await ids('&attention=NEEDS_REVIEW&itemKind=PERSONAL_CARE');
    expect(found).toEqual([PERSONAL_CARE]);
  });
});

describe('who may read an item', () => {
  it('lets a caregiver holding VIEW_MEDICINES read one', async () => {
    await grant(CAREGIVER_MEDICINES, ['VIEW_MEDICINES']);
    const response = await detail(principalFor(CAREGIVER_MEDICINES), MEDICINE);
    expect(response.statusCode).toBe(200);
  });

  it('refuses a caregiver holding only VIEW_SAFETY, as absence', async () => {
    await grant(CAREGIVER_SAFETY_ONLY, ['VIEW_SAFETY']);
    // `03` group H keeps safety access separate from shelf access. Somebody who may read an alert
    // about a medicine may not read the medicine.
    expect((await detail(principalFor(CAREGIVER_SAFETY_ONLY), MEDICINE)).statusCode).toBe(404);
  });

  it('refuses a stranger and an unknown item identically', async () => {
    const stranger = await detail(principalFor(STRANGER), MEDICINE);
    const unknown = await detail(principalFor(OWNER), testUuid(999));
    expect(stranger.statusCode).toBe(unknown.statusCode);
    expect(stranger.json<{ error: { code: string } }>().error.code).toBe(
      unknown.json<{ error: { code: string } }>().error.code,
    );
  });

  it('answers a malformed identifier the same way', async () => {
    const malformed = await detail(principalFor(OWNER), 'not-a-uuid');
    const unknown = await detail(principalFor(OWNER), testUuid(998));
    expect(malformed.statusCode).toBe(unknown.statusCode);
  });

  it('rejects an unauthenticated read', async () => {
    expect((await detail(null, MEDICINE)).statusCode).toBe(401);
  });

  it('shows a shelf-less caregiver an empty list rather than a refusal', async () => {
    await grant(CAREGIVER_SAFETY_ONLY, ['VIEW_SAFETY']);
    const response = await shelf(principalFor(CAREGIVER_SAFETY_ONLY));
    // The profile ID narrows; it does not grant. An empty page is the same answer a profile with
    // no items gives, which avoids confirming the profile exists.
    expect(response.statusCode).toBe(200);
    expect(response.json<ShelfBody>().items).toEqual([]);
  });
});
