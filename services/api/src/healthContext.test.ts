import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  FACT_CERTAINTIES,
  HEALTH_FACT_KINDS,
  instantFrom,
  noopLogger,
  unsafeId,
  type Instant,
  type UserId,
} from '@kynviora/domain';

/**
 * `04` Phase 1.3, against a real engine.
 *
 * The two exit criteria are what this suite is for. The first - "no OCR or inferred fact silently
 * becomes a confirmed diagnosis" - is asserted at the boundary that makes it true: no request body
 * can name a provenance, and the value that reaches the column is derived from who is asking. The
 * second is already the engine's (`requiredProfileProvenance`); what is checked here is that this
 * route can never produce a provenance a rule would treat as reviewer-confirmed.
 */

const OWNER = testUuid(1);
const MEDICINES_CAREGIVER = testUuid(2);
const READER = testUuid(3);
const SHELF_ONLY = testUuid(4);
const STRANGER = testUuid(5);

const HOUSEHOLD = testUuid(10);
const PROFILE = testUuid(20);

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
      [MEDICINES_CAREGIVER, 'meds@example.test'],
      [READER, 'reader@example.test'],
      [SHELF_ONLY, 'shelf@example.test'],
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
  });

  const pool: DatabasePool = {
    withUser: (userId, fn) => t.asUser(userId, (db) => fn(db as unknown as DatabaseConnection)),
    withService: (fn) => t.asService((db) => fn(db as unknown as DatabaseConnection)),
  };

  app = createServer({
    surface: 'HOUSEHOLD',
    pool,
    logger: noopLogger(),
    authenticate: (_request: FastifyRequest) => Promise.resolve(currentPrincipal),
    now: (): Instant => NOW,
    loadSources: () => Promise.resolve(new Map()),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.close();
});

beforeEach(async () => {
  // The database owner: neither application role holds DELETE on these tables (trap 105).
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM allergy_record');
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

interface FactBody {
  readonly id: string;
  readonly version: number;
  readonly kind: string;
  readonly displayTerm: string;
  readonly certainty: string;
  readonly provenance: string;
  readonly notedOn: string | null;
  readonly lastReviewedAt: string | null;
}

interface ListBody {
  readonly facts: readonly (FactBody & { readonly matchesCanonicalSubstance: boolean })[];
}

interface WireBody {
  readonly error: { readonly code: string; readonly detail?: Record<string, unknown> };
}

const add = (as: Principal, payload: Record<string, unknown>) =>
  request(as, {
    method: 'POST',
    url: `/v1/profiles/${PROFILE}/health-facts`,
    payload,
  });

const list = (as: Principal) =>
  request(as, { method: 'GET', url: `/v1/profiles/${PROFILE}/health-facts` });

const patch = (as: Principal, factId: string, payload: Record<string, unknown>) =>
  request(as, { method: 'PATCH', url: `/v1/health-facts/${factId}`, payload });

describe('recording a reaction', () => {
  it('stores what the person said, verbatim', async () => {
    const response = await add(principalFor(OWNER), {
      kind: 'ALLERGY',
      displayTerm: 'penicillin',
      certainty: 'CONFIRMED',
      notedOn: '2019-04-02',
    });
    expect(response.statusCode).toBe(201);

    const body = response.json<FactBody>();
    expect(body.kind).toBe('ALLERGY');
    // Not title-cased, not corrected, not expanded. `07`: what the user actually said.
    expect(body.displayTerm).toBe('penicillin');
    expect(body.certainty).toBe('CONFIRMED');
    expect(body.notedOn).toBe('2019-04-02');
    // Nobody has reviewed it, and Kynviora does not pretend otherwise by stamping the create.
    expect(body.lastReviewedAt).toBeNull();
  });

  it('takes a term and a kind and nothing else', async () => {
    const response = await add(principalFor(OWNER), {
      kind: 'SENSITIVITY',
      displayTerm: 'Fragrance',
    });
    expect(response.statusCode).toBe(201);
    // The weakest certainty, which is the only safe default.
    expect(response.json<FactBody>().certainty).toBe('REPORTED');
    expect(response.json<FactBody>().notedOn).toBeNull();
  });

  it('accepts every kind and certainty the domain offers', async () => {
    // A value the form offers and the database refuses is a 500 in front of somebody recording an
    // allergy. Checked against the constraints themselves rather than against a transcription.
    for (const kind of HEALTH_FACT_KINDS) {
      for (const certainty of FACT_CERTAINTIES) {
        const response = await add(principalFor(OWNER), {
          kind,
          displayTerm: `${kind}-${certainty}`,
          certainty,
        });
        expect(response.statusCode, `${kind}/${certainty}`).toBe(201);
      }
    }
  });

  it('refuses a kind rather than choosing one, and names the field', async () => {
    const response = await add(principalFor(OWNER), {
      kind: 'INTOLERANCE',
      displayTerm: 'Penicillin',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<WireBody>().error.detail?.['field']).toBe('kind');
  });

  it('does not link the fact to a catalog substance', async () => {
    // A household typing "penicillin" is not the catalog learning a substance (`15` A11). The
    // unmapped state is reported rather than hidden, because it decides whether a rule that
    // matches on canonical substances can use the fact at all.
    const created = await add(principalFor(OWNER), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
    });

    const stored = await t.asService((db) =>
      db.query<{ substance_id: string | null }>(
        `SELECT substance_id FROM allergy_record WHERE id = $1`,
        [created.json<FactBody>().id],
      ),
    );
    expect(stored.rows[0]?.substance_id).toBeNull();

    const listed = (await list(principalFor(OWNER))).json<ListBody>();
    expect(listed.facts[0]?.matchesCanonicalSubstance).toBe(false);
  });
});

describe('where the fact is recorded as coming from', () => {
  it('is USER_REPORTED when the profile owner writes it', async () => {
    const response = await add(principalFor(OWNER), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
    });
    expect(response.json<FactBody>().provenance).toBe('USER_REPORTED');
  });

  it('is CAREGIVER_ENTERED when somebody else does', async () => {
    await grant(MEDICINES_CAREGIVER, ['VIEW_MEDICINES', 'MANAGE_MEDICINES']);
    const response = await add(principalFor(MEDICINES_CAREGIVER), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<FactBody>().provenance).toBe('CAREGIVER_ENTERED');
  });

  it('ignores a provenance in the body, by refusing the body', async () => {
    // Phase 1.3's first exit criterion at the boundary that makes it true. `.strict()` refuses the
    // key, and there is no parameter it could reach if it did not.
    const response = await add(principalFor(OWNER), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
      provenance: 'REVIEWER_CONFIRMED',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<WireBody>().error.code).toBe('VALIDATION_FAILED');

    const none = await t.asService((db) =>
      db.query<{ n: string }>(
        `SELECT count(*) AS n FROM allergy_record WHERE provenance = 'REVIEWER_CONFIRMED'`,
      ),
    );
    expect(Number(none.rows[0]?.n)).toBe(0);
  });

  it('refuses a substance link in the body too', async () => {
    const response = await add(principalFor(OWNER), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
      substanceId: testUuid(77),
    });
    expect(response.statusCode).toBe(400);
  });

  it('never writes a provenance a rule would treat as reviewer-confirmed', async () => {
    // The two exit criteria meeting. A rule filters on `requiredProfileProvenance`; this route can
    // only ever produce the two weakest values, so nothing typed into a phone can satisfy a rule
    // that asks for a reviewed fact.
    await grant(MEDICINES_CAREGIVER, ['VIEW_MEDICINES', 'MANAGE_MEDICINES']);
    await add(principalFor(OWNER), { kind: 'ALLERGY', displayTerm: 'A' });
    await add(principalFor(MEDICINES_CAREGIVER), { kind: 'SENSITIVITY', displayTerm: 'B' });

    const written = await t.asService((db) =>
      db.query<{ provenance: string }>(`SELECT DISTINCT provenance FROM allergy_record`),
    );
    expect(written.rows.map((row) => row.provenance).sort()).toEqual([
      'CAREGIVER_ENTERED',
      'USER_REPORTED',
    ]);
  });

  it('records that a fact was added, and where it was said to come from', async () => {
    // `04` Phase 1.3 asks for an edit history. Field names and the derived provenance only - `14`
    // keeps the content of somebody's health record out of a log.
    const created = await add(principalFor(OWNER), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
    });

    const audit = await t.asService((db) =>
      db.query<{ action: string; detail: Record<string, unknown> }>(
        `SELECT action, detail FROM audit_event WHERE target_id = $1`,
        [created.json<FactBody>().id],
      ),
    );
    expect(audit.rows[0]?.action).toBe('HEALTH_FACT_ADDED');
    expect(audit.rows[0]?.detail['provenance']).toBe('USER_REPORTED');
    expect(JSON.stringify(audit.rows[0]?.detail)).not.toContain('Penicillin');
  });
});

describe('who may read and write health context', () => {
  it('needs MANAGE_MEDICINES to write, not MANAGE_SHELF', async () => {
    // `08.2` keeps a caregiver's safety-alert permission separate from data access, and health
    // context is the most sensitive profile data there is. Somebody who may add a shampoo must not
    // thereby be able to record what a person is allergic to.
    await grant(SHELF_ONLY, ['VIEW_SHELF', 'MANAGE_SHELF']);
    const response = await add(principalFor(SHELF_ONLY), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<WireBody>().error.code).toBe('NOT_FOUND');
  });

  it('needs VIEW_MEDICINES to read', async () => {
    await add(principalFor(OWNER), { kind: 'ALLERGY', displayTerm: 'Penicillin' });
    await grant(SHELF_ONLY, ['VIEW_SHELF']);

    // An empty list rather than a refusal, which is what a profile with no records looks like -
    // so the route is not an oracle for either.
    expect((await list(principalFor(SHELF_ONLY))).json<ListBody>().facts).toEqual([]);
    expect((await list(principalFor(STRANGER))).json<ListBody>().facts).toEqual([]);
    expect((await list(principalFor(OWNER))).json<ListBody>().facts).toHaveLength(1);
  });

  it('lets a reader read and not change', async () => {
    const created = await add(principalFor(OWNER), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
    });
    await grant(READER, ['VIEW_MEDICINES']);

    expect((await list(principalFor(READER))).json<ListBody>().facts).toHaveLength(1);

    const refused = await patch(principalFor(READER), created.json<FactBody>().id, {
      expectedVersion: 1,
      displayTerm: 'Something else',
    });
    // The same absence every other refusal gives (trap 89) - there is deliberately no outcome in
    // this API meaning "you are not allowed".
    expect(refused.statusCode).toBe(404);

    const unchanged = await t.asService((db) =>
      db.query<{ display_term: string }>(`SELECT display_term FROM allergy_record WHERE id = $1`, [
        created.json<FactBody>().id,
      ]),
    );
    expect(unchanged.rows[0]?.display_term).toBe('Penicillin');
  });

  it('tells an unauthenticated caller nothing', async () => {
    const written = await request(null, {
      method: 'POST',
      url: `/v1/profiles/${PROFILE}/health-facts`,
      payload: { kind: 'ALLERGY', displayTerm: 'x' },
    });
    const read = await request(null, {
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/health-facts`,
    });
    expect(written.statusCode).toBe(401);
    expect(read.statusCode).toBe(401);
  });
});

describe('correcting a fact', () => {
  let factId = '';

  beforeEach(async () => {
    const created = await add(principalFor(OWNER), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
      notedOn: '2019-04-02',
    });
    factId = created.json<FactBody>().id;
  });

  it('changes only what was named', async () => {
    const response = await patch(principalFor(OWNER), factId, {
      expectedVersion: 1,
      certainty: 'CONFIRMED',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ changedFields: string[] }>().changedFields).toEqual(['certainty']);

    const stored = await t.asService((db) =>
      db.query<{ display_term: string; certainty: string; noted_on: Date | string | null }>(
        `SELECT display_term, certainty, noted_on FROM allergy_record WHERE id = $1`,
        [factId],
      ),
    );
    expect(stored.rows[0]?.certainty).toBe('CONFIRMED');
    expect(stored.rows[0]?.display_term).toBe('Penicillin');
    expect(stored.rows[0]?.noted_on).not.toBeNull();
  });

  it('clears a date somebody turned out not to remember', async () => {
    const response = await patch(principalFor(OWNER), factId, {
      expectedVersion: 1,
      notedOn: null,
    });
    expect(response.statusCode).toBe(200);

    const stored = await t.asService((db) =>
      db.query<{ noted_on: Date | string | null }>(
        `SELECT noted_on FROM allergy_record WHERE id = $1`,
        [factId],
      ),
    );
    expect(stored.rows[0]?.noted_on).toBeNull();
  });

  it('refuses a save that changes nothing, and says which kind of refusal it is', async () => {
    // An ordinary thing to do. Told apart by its reason code rather than by message text (`13`),
    // so a screen shows a plain note instead of the panel a malformed date gets - and refused
    // rather than committed, because an empty save moves the version and becomes a conflict for
    // whoever else has the record open.
    const response = await patch(principalFor(OWNER), factId, { expectedVersion: 1 });
    expect(response.statusCode).toBe(400);
    expect(response.json<WireBody>().error.detail?.['reason_code']).toBe('empty_change');
  });

  it('refuses a stale edit rather than letting it win', async () => {
    // `sync.ts` sets `allergy_record`'s conflict policy to `ASK_USER`, and losing a recorded
    // allergy to a stale offline edit is the case that policy exists for.
    await patch(principalFor(OWNER), factId, { expectedVersion: 1, certainty: 'CONFIRMED' });

    const stale = await patch(principalFor(OWNER), factId, {
      expectedVersion: 1,
      displayTerm: 'Amoxicillin',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<WireBody>().error.code).toBe('VERSION_CONFLICT');
    expect(stale.json<WireBody>().error.detail?.['currentVersion']).toBe(2);

    const stored = await t.asService((db) =>
      db.query<{ display_term: string }>(`SELECT display_term FROM allergy_record WHERE id = $1`, [
        factId,
      ]),
    );
    expect(stored.rows[0]?.display_term).toBe('Penicillin');
  });

  it('says nothing about who changed it', async () => {
    // `14`, DEC-076. The conflict tells somebody their copy has moved, not who moved it.
    await patch(principalFor(OWNER), factId, { expectedVersion: 1, certainty: 'CONFIRMED' });
    const stale = await patch(principalFor(OWNER), factId, {
      expectedVersion: 1,
      certainty: 'SUSPECTED',
    });
    expect(JSON.stringify(stale.json())).not.toContain(OWNER);
  });

  it('cannot change where the fact came from', async () => {
    const response = await patch(principalFor(OWNER), factId, {
      expectedVersion: 1,
      provenance: 'REVIEWER_CONFIRMED',
    });
    expect(response.statusCode).toBe(400);

    const stored = await t.asService((db) =>
      db.query<{ provenance: string }>(`SELECT provenance FROM allergy_record WHERE id = $1`, [
        factId,
      ]),
    );
    expect(stored.rows[0]?.provenance).toBe('USER_REPORTED');
  });
});

describe('saying somebody looked at a record', () => {
  it('stamps the review date only when asked', async () => {
    const created = await add(principalFor(OWNER), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
    });
    const factId = created.json<FactBody>().id;

    // Correcting a typo is not a review. A review date Kynviora inferred would make a stale record
    // look checked - the "silently becomes" of the exit criterion, one level up from the fact.
    const typo = await patch(principalFor(OWNER), factId, {
      expectedVersion: 1,
      displayTerm: 'Penicillin V',
    });
    expect(typo.json<{ lastReviewedAt: string | null }>().lastReviewedAt).toBeNull();

    const reviewed = await patch(principalFor(OWNER), factId, {
      expectedVersion: 2,
      markReviewed: true,
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json<{ lastReviewedAt: string | null }>().lastReviewedAt).not.toBeNull();
  });

  it('is stamped by the server, never supplied', async () => {
    // A client-set timestamp would let a screen claim somebody checked an allergy at a moment
    // they did not.
    const created = await add(principalFor(OWNER), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
    });
    const response = await patch(principalFor(OWNER), created.json<FactBody>().id, {
      expectedVersion: 1,
      lastReviewedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(400);
  });

  it('records the review in the audit log', async () => {
    const created = await add(principalFor(OWNER), {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
    });
    const factId = created.json<FactBody>().id;
    await patch(principalFor(OWNER), factId, { expectedVersion: 1, markReviewed: true });

    const audit = await t.asService((db) =>
      db.query<{ action: string; detail: Record<string, unknown> }>(
        `SELECT action, detail FROM audit_event
          WHERE target_id = $1 AND action = 'HEALTH_FACT_UPDATED'`,
        [factId],
      ),
    );
    expect(audit.rows[0]?.detail['reviewed']).toBe(true);
  });
});
