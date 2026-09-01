import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Medicine Reconciliation, end to end (spec 04 Phase 8.5).
 *
 * The exit criterion - "Kynviora never chooses which conflicting instruction is medically
 * correct" - is asserted against the live flow here, not only against the decision function: the
 * response has nowhere to render an answer, no request can settle a difference without a person
 * naming which version stands, and the only write to a medicine is the one a person asked for.
 */

const OWNER = testUuid(1);
const OTHER_OWNER = testUuid(2);
const VIEW_CAREGIVER = testUuid(3);
const MANAGE_CAREGIVER = testUuid(4);
const STRANGER = testUuid(5);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);
const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

const ITEM_A = testUuid(30);
const ITEM_B = testUuid(31);

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;
let currentNow: Instant = NOW;

function principalFor(userId: string): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt: null };
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER_OWNER, 'other@example.test'],
      [VIEW_CAREGIVER, 'viewer@example.test'],
      [MANAGE_CAREGIVER, 'manager@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }
    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`,
      [HOUSEHOLD_A, OWNER, HOUSEHOLD_B, OTHER_OWNER],
    );
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent A'), ($4, $5, $6, 'Parent B')`,
      [PROFILE_A, HOUSEHOLD_A, OWNER, PROFILE_B, HOUSEHOLD_B, OTHER_OWNER],
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
    await db.query('DELETE FROM reconciliation_difference');
    await db.query('DELETE FROM reconciliation');
    await db.query('DELETE FROM caregiver_grant');
    await db.query('DELETE FROM owned_item');
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  try {
    return await app.inject(options);
  } finally {
    currentPrincipal = null;
  }
}

async function shelfMedicine(
  id: string,
  overrides: { strength?: string; directions?: string; profileId?: string } = {},
) {
  await t.asService((db) =>
    db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, strength_text, dosage_form, directions_text,
          lifecycle_state)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet A', $3, 'tablet', $4, 'ACTIVE')`,
      [
        id,
        overrides.profileId ?? PROFILE_A,
        overrides.strength ?? '500 mg',
        overrides.directions ?? 'One tablet twice a day',
      ],
    ),
  );
}

async function grant(userId: string, capabilities: string[]) {
  await t.asService((db) =>
    db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
      [PROFILE_A, userId, OWNER, capabilities],
    ),
  );
}

interface StartBody {
  readonly reconciliationId: string;
}

interface DifferenceView {
  readonly differenceId: string;
  readonly kind: string;
  readonly field: string | null;
  readonly previousValue: string | null;
  readonly currentValue: string | null;
  readonly resolution: string | null;
  readonly adoptedSide: string | null;
}

interface GetBody {
  readonly state: string;
  readonly unresolvedCount: number | null;
  readonly differences: DifferenceView[];
}

async function start(as: Principal, currentList: Record<string, unknown>[], profileId = PROFILE_A) {
  return request(as, {
    method: 'POST',
    url: '/v1/reconciliations',
    payload: { profileId, sourceKind: 'DISCHARGE', currentList },
  });
}

async function startAsOwner(currentList: Record<string, unknown>[]): Promise<string> {
  const response = await start(principalFor(OWNER), currentList);
  expect(response.statusCode).toBe(201);
  return response.json<StartBody>().reconciliationId;
}

async function view(as: Principal, id: string) {
  return request(as, { method: 'GET', url: `/v1/reconciliations/${id}` });
}

async function resolveDifference(
  as: Principal,
  id: string,
  diffId: string,
  payload: Record<string, unknown>,
) {
  return request(as, {
    method: 'POST',
    url: `/v1/reconciliations/${id}/differences/${diffId}`,
    payload,
  });
}

/** The shelf line keys on the item's own ID, so a "same medicine" current line reuses it. */
function currentLine(overrides: Record<string, unknown> = {}) {
  return {
    matchKey: ITEM_A,
    displayName: 'Synthetic Tablet A',
    strengthText: '500 mg',
    dosageForm: 'tablet',
    directionsText: 'One tablet twice a day',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('the response has nowhere to put an answer', () => {
  it('carries both values and nothing naming a preferred one', async () => {
    await shelfMedicine(ITEM_A);
    const id = await startAsOwner([currentLine({ strengthText: '250 mg' })]);

    const response = await view(principalFor(OWNER), id);
    expect(response.statusCode).toBe(200);
    const difference = response.json<GetBody>().differences.find((d) => d.kind === 'FIELD_DIFFERS');

    expect(difference?.previousValue).toBe('500 mg');
    expect(difference?.currentValue).toBe('250 mg');

    const body = response.body.toLowerCase();
    for (const forbidden of [
      'suggestedvalue',
      'preferredvalue',
      'recommendedvalue',
      'correctvalue',
      'winner',
      'confidence',
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('does not describe a medicine missing from the new list as stopped', async () => {
    // The sharpest instance: a medicine absent from a discharge summary may have been stopped, or
    // the summary may only cover the admission. Those have opposite correct actions.
    await shelfMedicine(ITEM_A);
    const id = await startAsOwner([]);

    const response = await view(principalFor(OWNER), id);
    const kinds = response.json<GetBody>().differences.map((d) => d.kind);
    expect(kinds).toContain('ONLY_IN_PREVIOUS');

    const body = response.body.toLowerCase();
    for (const forbidden of ['stopped', 'discontinued', 'removed', 'no longer take']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('reports one row per differing field, not one per medicine', async () => {
    // Two facts with potentially different answers - a pharmacist might confirm the new strength
    // and the old directions. Collapsing them forces one decision onto two questions.
    await shelfMedicine(ITEM_A);
    const id = await startAsOwner([
      currentLine({ strengthText: '250 mg', directionsText: 'One tablet daily' }),
    ]);

    const differences = (await view(principalFor(OWNER), id))
      .json<GetBody>()
      .differences.filter((d) => d.kind === 'FIELD_DIFFERS');
    expect(differences.map((d) => d.field).sort()).toEqual(
      ['directionsText', 'strengthText'].sort(),
    );
  });

  it('reports matches so the scale of the change is visible', async () => {
    await shelfMedicine(ITEM_A);
    const id = await startAsOwner([currentLine()]);
    const kinds = (await view(principalFor(OWNER), id))
      .json<GetBody>()
      .differences.map((d) => d.kind);
    expect(kinds).toEqual(['MATCHES']);
  });
});

describe('settling a difference requires a person to decide', () => {
  async function differingReconciliation() {
    await shelfMedicine(ITEM_A);
    const id = await startAsOwner([currentLine({ strengthText: '250 mg' })]);
    const diff = (await view(principalFor(OWNER), id))
      .json<GetBody>()
      .differences.find((d) => d.kind === 'FIELD_DIFFERS');
    return { id, diffId: diff?.differenceId ?? '' };
  }

  it('refuses a resolution that does not say which version stands', async () => {
    const { id, diffId } = await differingReconciliation();
    const response = await resolveDifference(principalFor(OWNER), id, diffId, {
      resolution: 'CONFIRMED_WITH_PHARMACIST',
      confirmedBy: 'Priya at the pharmacy',
      adopt: null,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'resolution_needs_a_side' } },
    });
  });

  it('requires a professional confirmation to name the professional', async () => {
    const { id, diffId } = await differingReconciliation();
    const response = await resolveDifference(principalFor(OWNER), id, diffId, {
      resolution: 'CONFIRMED_WITH_PRESCRIBER',
      adopt: 'CURRENT',
      confirmedBy: null,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'confirmation_needs_a_name' } },
    });
  });

  it('lets a professional confirmation land on the previous value, changing nothing', async () => {
    const { id, diffId } = await differingReconciliation();
    const response = await resolveDifference(principalFor(OWNER), id, diffId, {
      resolution: 'CONFIRMED_WITH_PRESCRIBER',
      adopt: 'PREVIOUS',
      confirmedBy: 'Dr Rao',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ shelfUpdated: false });

    const item = await t.asService((db) =>
      db.query<{ strength_text: string }>('SELECT strength_text FROM owned_item WHERE id = $1', [
        ITEM_A,
      ]),
    );
    expect(item.rows[0]?.strength_text).toBe('500 mg');
  });

  it('writes the current value to the shelf only when a person adopted it', async () => {
    const { id, diffId } = await differingReconciliation();
    const response = await resolveDifference(principalFor(OWNER), id, diffId, {
      resolution: 'USER_ADOPTED_CURRENT',
      adopt: 'CURRENT',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ shelfUpdated: true });

    const item = await t.asService((db) =>
      db.query<{ strength_text: string }>('SELECT strength_text FROM owned_item WHERE id = $1', [
        ITEM_A,
      ]),
    );
    expect(item.rows[0]?.strength_text).toBe('250 mg');
  });

  it('refuses a resolution that contradicts the version it names', async () => {
    const { id, diffId } = await differingReconciliation();
    const response = await resolveDifference(principalFor(OWNER), id, diffId, {
      resolution: 'USER_KEPT_PREVIOUS',
      adopt: 'CURRENT',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'resolution_contradicts_side' } },
    });
  });

  it('records an unresolved difference without touching the shelf', async () => {
    const { id, diffId } = await differingReconciliation();
    const response = await resolveDifference(principalFor(OWNER), id, diffId, {
      resolution: 'STILL_UNRESOLVED',
      adopt: null,
      note: 'Waiting to hear back from the surgery.',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ shelfUpdated: false });

    const item = await t.asService((db) =>
      db.query<{ strength_text: string }>('SELECT strength_text FROM owned_item WHERE id = $1', [
        ITEM_A,
      ]),
    );
    expect(item.rows[0]?.strength_text).toBe('500 mg');
  });

  it('refuses to resolve a difference on a medicine that matched', async () => {
    await shelfMedicine(ITEM_A);
    const id = await startAsOwner([currentLine()]);
    const match = (await view(principalFor(OWNER), id)).json<GetBody>().differences[0];

    const response = await resolveDifference(principalFor(OWNER), id, match?.differenceId ?? '', {
      resolution: 'USER_ADOPTED_CURRENT',
      adopt: 'CURRENT',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'nothing_to_resolve' } },
    });
  });

  it('records the resolution in the audit log without the values', async () => {
    const { id, diffId } = await differingReconciliation();
    await resolveDifference(principalFor(OWNER), id, diffId, {
      resolution: 'CONFIRMED_WITH_PHARMACIST',
      adopt: 'CURRENT',
      confirmedBy: 'Priya at the pharmacy',
    });

    const events = await t.asService((db) =>
      db.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_event
          WHERE action = 'reconciliation.difference.resolved' AND target_id = $1`,
        [id],
      ),
    );
    const detail = JSON.stringify(events.rows[0]?.detail);
    expect(detail).toContain('strengthText');
    expect(detail).toContain('CONFIRMED_WITH_PHARMACIST');
    expect(detail).not.toContain('250 mg');
    expect(detail).not.toContain('Priya');
  });
});

describe('completing a reconciliation', () => {
  it('refuses while a difference has not been looked at', async () => {
    await shelfMedicine(ITEM_A);
    const id = await startAsOwner([currentLine({ strengthText: '250 mg' })]);

    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/reconciliations/${id}/complete`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'differences_not_reviewed' } },
    });
  });

  it('completes with unresolved differences and reports how many', async () => {
    // 04 Phase 8.5 lists unresolved differences as expected output. Someone who cannot reach
    // their pharmacist must be able to close the session without being pushed into a decision.
    await shelfMedicine(ITEM_A);
    const id = await startAsOwner([currentLine({ strengthText: '250 mg' })]);
    const diff = (await view(principalFor(OWNER), id))
      .json<GetBody>()
      .differences.find((d) => d.kind === 'FIELD_DIFFERS');

    await resolveDifference(principalFor(OWNER), id, diff?.differenceId ?? '', {
      resolution: 'STILL_UNRESOLVED',
      adopt: null,
    });

    const response = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/reconciliations/${id}/complete`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'COMPLETED', unresolvedCount: 1 });
  });

  it('refuses to resolve anything once it is closed', async () => {
    await shelfMedicine(ITEM_A);
    const id = await startAsOwner([currentLine()]);
    expect(
      (
        await request(principalFor(OWNER), {
          method: 'POST',
          url: `/v1/reconciliations/${id}/complete`,
        })
      ).statusCode,
    ).toBe(200);

    const match = (await view(principalFor(OWNER), id)).json<GetBody>().differences[0];
    const response = await resolveDifference(principalFor(OWNER), id, match?.differenceId ?? '', {
      resolution: 'USER_ADOPTED_CURRENT',
      adopt: 'CURRENT',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'reconciliation_closed' } },
    });
  });
});

describe('authorization', () => {
  it('refuses a caregiver who can read medicines but not manage them', async () => {
    await shelfMedicine(ITEM_A);
    await grant(VIEW_CAREGIVER, ['VIEW_MEDICINES']);

    const response = await start(principalFor(VIEW_CAREGIVER), [currentLine()]);
    expect(response.statusCode).toBe(404);
  });

  it('admits a caregiver holding MANAGE_MEDICINES', async () => {
    await shelfMedicine(ITEM_A);
    await grant(MANAGE_CAREGIVER, ['VIEW_MEDICINES', 'MANAGE_MEDICINES']);

    const response = await start(principalFor(MANAGE_CAREGIVER), [currentLine()]);
    expect(response.statusCode).toBe(201);
  });

  it('refuses a stranger, and does not confirm the profile exists', async () => {
    await shelfMedicine(ITEM_A);
    const real = await start(principalFor(STRANGER), [currentLine()]);
    const invented = await start(principalFor(STRANGER), [currentLine()], testUuid(99));

    expect(real.statusCode).toBe(404);
    expect(invented.statusCode).toBe(404);
    const strip = (body: string) => body.replace(/"correlationId":"[^"]+"/, '');
    expect(strip(real.body)).toBe(strip(invented.body));
  });

  it('does not show a reconciliation to another household', async () => {
    await shelfMedicine(ITEM_A);
    const id = await startAsOwner([currentLine()]);

    const response = await view(principalFor(OTHER_OWNER), id);
    expect(response.statusCode).toBe(404);
  });

  it('compares only the medicines the caller can already see', async () => {
    // The previous side is read under row-level security, so a reconciliation cannot become a way
    // to enumerate a profile's medicines.
    await shelfMedicine(ITEM_A);
    await shelfMedicine(ITEM_B, { profileId: PROFILE_B });

    const id = await startAsOwner([]);
    const differences = (await view(principalFor(OWNER), id)).json<GetBody>().differences;
    expect(differences).toHaveLength(1);
    expect(differences[0]?.kind).toBe('ONLY_IN_PREVIOUS');
  });
});
