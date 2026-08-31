import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import { sha256ContentDigest } from './visitPack.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { assertNoSensitiveFields } from './errors.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import {
  digestSelection,
  instantFrom,
  noopLogger,
  unsafeId,
  type Instant,
  type UserId,
  type VisitPackEntry,
} from '@kynviora/domain';
import { ALL_FIXTURE_SOURCES, asApprovedSourceForTest } from '@kynviora/fixtures';
import type { SourceRegistryEntry } from '@kynviora/regulatory';

/**
 * Visit Pack flow, end to end (spec 04 Phase 8.4, 06 Journey 8).
 *
 * Run against the real database through PGlite with row-level security in force. The two exit
 * criteria are asserted directly:
 *
 *  - export never happens automatically - there is no request that produces a pack without an
 *    explicit selection, and none that skips the step-up gate;
 *  - a user can review exactly what will be shared - generation quotes the digest of the
 *    reviewed content and is refused if the live data no longer matches it.
 */

const OWNER = testUuid(1);
const OTHER_OWNER = testUuid(2);
const CAREGIVER = testUuid(3);
const EXPORT_CAREGIVER = testUuid(4);
const STRANGER = testUuid(5);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);
const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

const MEDICINE_A = testUuid(30);
const SHAMPOO_A = testUuid(31);
const MEDICINE_B = testUuid(32);
const ALLERGY_A = testUuid(40);

const NOW = instantFrom('2026-08-29T12:00:00.000Z');

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;
let currentNow: Instant = NOW;

const digest = sha256ContentDigest();

function principalFor(userId: string, steppedUp = false): Principal {
  return { userId: unsafeId<UserId>(userId), stepUpVerifiedAt: steppedUp ? currentNow : null };
}

const OWNER_STEPPED_UP = () => principalFor(OWNER, true);

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER_OWNER, 'other@example.test'],
      [CAREGIVER, 'caregiver@example.test'],
      [EXPORT_CAREGIVER, 'exporter@example.test'],
      [STRANGER, 'stranger@example.test'],
    ] as const) {
      await db.query(
        `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
         VALUES ($1, $2, $3, now())`,
        [id, `auth|${id}`, email],
      );
    }

    await db.query(
      `INSERT INTO household (id, owner_user_id, display_name)
       VALUES ($1, $2, 'A'), ($3, $4, 'B')`,
      [HOUSEHOLD_A, OWNER, HOUSEHOLD_B, OTHER_OWNER],
    );

    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name)
       VALUES ($1, $2, $3, 'Parent A (synthetic)'), ($4, $5, $6, 'Parent B (synthetic)')`,
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
  // audit_event is append-only (DEC-013), so it is never cleared. Assertions scope by target.
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM visit_pack');
    await db.query('DELETE FROM caregiver_grant');
    await db.query('DELETE FROM allergy_record');
    await db.query('DELETE FROM owned_item');
  });

  await t.asService(async (db) => {
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, strength_text, dosage_form, directions_text,
          identity_verification, lifecycle_state)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet A', '500 mg', 'tablet',
               'One tablet twice daily with food', 'UNVERIFIED', 'ACTIVE'),
              ($3, $4, 'MEDICINE', 'Synthetic Tablet B', '250 mg', 'tablet', NULL,
               'UNVERIFIED', 'ACTIVE')`,
      [MEDICINE_A, PROFILE_A, MEDICINE_B, PROFILE_B],
    );
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, personal_care_category, lifecycle_state)
       VALUES ($1, $2, 'PERSONAL_CARE', 'Synthetic Shampoo', 'HAIR_CARE', 'ACTIVE')`,
      [SHAMPOO_A, PROFILE_A],
    );
    await db.query(
      `INSERT INTO allergy_record
         (id, profile_id, record_kind, display_term, provenance, certainty)
       VALUES ($1, $2, 'ALLERGY', 'synthetic-substance', 'USER_REPORTED', 'SUSPECTED')`,
      [ALLERGY_A, PROFILE_A],
    );
  });
});

async function request(as: Principal | null, options: InjectOptions) {
  currentPrincipal = as;
  const response = await app.inject(options);
  currentPrincipal = null;
  return response;
}

function idempotent(key: string = randomUUID()): Record<string, string> {
  return { 'idempotency-key': key };
}

interface Candidate extends VisitPackEntry {
  entityId: string;
}

interface CandidatesResponse {
  candidates: Candidate[];
  availableDigest: string;
}

/** Fetch the proposal, exactly as the review screen would. */
async function candidates(
  as: Principal = principalFor(OWNER),
  profileId = PROFILE_A,
): Promise<CandidatesResponse> {
  const response = await request(as, {
    method: 'GET',
    url: `/v1/visit-packs/candidates?profileId=${profileId}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json<CandidatesResponse>();
}

/** Compute the digest a client would send after reviewing a chosen subset. */
function digestOf(entries: readonly VisitPackEntry[], notes: readonly string[] = []): string {
  const noteEntries: VisitPackEntry[] = notes.map((line, index) => ({
    section: 'QUESTIONS_AND_NOTES',
    entityKind: 'user_note',
    entityId: `note:${String(index).padStart(4, '0')}`,
    version: 1,
    lines: [line],
    caveat: 'Written by the person or their caregiver.',
  }));
  return digestSelection([...entries, ...noteEntries], digest);
}

async function generate(
  payload: Record<string, unknown>,
  as: Principal = OWNER_STEPPED_UP(),
  key?: string,
) {
  return request(as, {
    method: 'POST',
    url: '/v1/visit-packs',
    headers: idempotent(key),
    payload: { profileId: PROFILE_A, reviewedAt: NOW, ...payload },
  });
}

/** The common happy path: review everything on offer, then generate it. */
async function generateAll(as: Principal = OWNER_STEPPED_UP()) {
  const proposal = await candidates();
  const response = await generate(
    {
      selectedEntityIds: proposal.candidates.map((c) => c.entityId),
      reviewedDigest: proposal.availableDigest,
    },
    as,
  );
  expect(response.statusCode).toBe(201);
  return { proposal, id: response.json<{ id: string }>().id };
}

// ---------------------------------------------------------------------------

describe('proposing content', () => {
  it('offers current medicines, personal care, allergies and nothing selected', async () => {
    const proposal = await candidates();
    const sections = proposal.candidates.map((c) => c.section);

    expect(sections).toContain('CURRENT_MEDICINES');
    expect(sections).toContain('PERSONAL_CARE_ITEMS');
    expect(sections).toContain('ALLERGIES_AND_SENSITIVITIES');

    // `06` Journey 8 step 2 proposes; step 3 is where the user chooses. Nothing in the response
    // records a choice, so a client cannot mistake a proposal for one.
    for (const candidate of proposal.candidates) {
      expect(candidate).not.toHaveProperty('selected');
      expect(candidate).not.toHaveProperty('included');
    }
  });

  it('gives every candidate a caveat', async () => {
    // Spec 18 requires the limitation to be stated, and a printed line with no provenance is
    // indistinguishable from a verified record.
    const proposal = await candidates();
    for (const candidate of proposal.candidates) {
      expect(candidate.caveat.length).toBeGreaterThan(0);
    }
  });

  it('reproduces prescription directions verbatim', async () => {
    // Spec 04 Phase 4.1: Kynviora never rewrites a prescription instruction, and a paraphrase on
    // a page a clinician reads is worse than no line at all.
    const proposal = await candidates();
    const medicine = proposal.candidates.find((c) => c.entityId === MEDICINE_A);
    expect(medicine?.lines.join(' ')).toContain('One tablet twice daily with food');
  });

  it('offers nothing for a profile the caller cannot reach', async () => {
    const foreign = await candidates(principalFor(OWNER), PROFILE_B);
    // An empty list rather than a refusal - the same non-confirming behaviour as the shelf.
    expect(foreign.candidates).toEqual([]);

    const stranger = await candidates(principalFor(STRANGER), PROFILE_A);
    expect(stranger.candidates).toEqual([]);
  });

  it('returns a digest that is stable across identical calls', async () => {
    const first = await candidates();
    const second = await candidates();
    expect(first.availableDigest).toBe(second.availableDigest);
  });

  it('changes the digest when an underlying record changes', async () => {
    const before = await candidates();
    await t.asService((db) =>
      db.query(`UPDATE owned_item SET strength_text = '750 mg' WHERE id = $1`, [MEDICINE_A]),
    );
    const after = await candidates();
    expect(after.availableDigest).not.toBe(before.availableDigest);
  });
});

describe('export never happens automatically', () => {
  it('refuses without fresh step-up, before parsing anything', async () => {
    const response = await generate(
      { selectedEntityIds: [MEDICINE_A], reviewedDigest: 'a'.repeat(64) },
      principalFor(OWNER),
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
  });

  it('treats a stale step-up as no step-up', async () => {
    const stale = instantFrom('2026-08-29T11:00:00.000Z');
    const response = await generate(
      { selectedEntityIds: [MEDICINE_A] },
      {
        userId: unsafeId<UserId>(OWNER),
        stepUpVerifiedAt: stale,
      },
    );
    expect(response.statusCode).toBe(403);
  });

  it('refuses an empty selection', async () => {
    const response = await generate({ selectedEntityIds: [], reviewedDigest: digestOf([]) });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'empty_selection' } },
    });
  });

  it('requires an idempotency key', async () => {
    const proposal = await candidates();
    const response = await request(OWNER_STEPPED_UP(), {
      method: 'POST',
      url: '/v1/visit-packs',
      payload: {
        profileId: PROFILE_A,
        selectedEntityIds: [MEDICINE_A],
        reviewedDigest: proposal.availableDigest,
        reviewedAt: NOW,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'idempotency_key_required' } },
    });
  });

  it('refuses a record belonging to another profile', async () => {
    // RLS keeps it out of the candidate list, and the domain then refuses the ID outright, so
    // neither layer alone is load-bearing.
    const proposal = await candidates();
    const response = await generate({
      selectedEntityIds: [...proposal.candidates.map((c) => c.entityId), MEDICINE_B],
      reviewedDigest: proposal.availableDigest,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'unknown_selection' } },
    });

    const packs = await t.asService((db) => db.query('SELECT id FROM visit_pack'));
    expect(packs.rows).toEqual([]);
  });

  it('commits exactly once on a retry', async () => {
    const proposal = await candidates();
    const key = randomUUID();
    const payload = {
      selectedEntityIds: proposal.candidates.map((c) => c.entityId),
      reviewedDigest: proposal.availableDigest,
    };

    const first = await generate(payload, OWNER_STEPPED_UP(), key);
    expect(first.statusCode).toBe(201);

    const retry = await generate(payload, OWNER_STEPPED_UP(), key);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.json()).toMatchObject({ replayed: true, id: first.json<{ id: string }>().id });

    const packs = await t.asService((db) => db.query('SELECT id FROM visit_pack'));
    expect(packs.rows).toHaveLength(1);
  });
});

describe('a user can review exactly what will be shared', () => {
  it('generates a pack containing exactly the reviewed selection', async () => {
    const proposal = await candidates();
    const chosen = proposal.candidates.filter((c) => c.section === 'CURRENT_MEDICINES');

    const response = await generate({
      selectedEntityIds: chosen.map((c) => c.entityId),
      reviewedDigest: digestOf(chosen),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ entryCount: chosen.length });

    const pack = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/visit-packs/${response.json<{ id: string }>().id}`,
    });
    const body = pack.json<{ entries: VisitPackEntry[]; matchesGeneratedContent: boolean }>();
    expect(body.entries.map((e) => e.entityId)).toEqual(chosen.map((c) => c.entityId));
    expect(body.matchesGeneratedContent).toBe(true);
    // The shampoo was on offer and was not chosen, so it is not in the pack.
    expect(JSON.stringify(body.entries)).not.toContain('Shampoo');
  });

  it('refuses when a selected record changed between review and generate', async () => {
    // The exit criterion, against live data: a caregiver editing a medicine after the review
    // screen must not cause a pack to contain a line nobody read.
    const proposal = await candidates();
    const payload = {
      selectedEntityIds: proposal.candidates.map((c) => c.entityId),
      reviewedDigest: proposal.availableDigest,
    };

    await t.asService((db) =>
      db.query(`UPDATE owned_item SET strength_text = '750 mg' WHERE id = $1`, [MEDICINE_A]),
    );

    const response = await generate(payload);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'EXPORT_CONTENT_CHANGED' } });

    const packs = await t.asService((db) => db.query('SELECT id FROM visit_pack'));
    expect(packs.rows).toEqual([]);
  });

  it('refuses when a record was deleted between review and generate', async () => {
    const proposal = await candidates();
    const payload = {
      selectedEntityIds: proposal.candidates.map((c) => c.entityId),
      reviewedDigest: proposal.availableDigest,
    };

    await t.asService((db) =>
      db.query('UPDATE owned_item SET deleted_at = now() WHERE id = $1', [SHAMPOO_A]),
    );

    const response = await generate(payload);
    // Reported as a selection problem rather than a digest mismatch: the record is gone, which
    // is the more specific and more actionable fact.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { detail: { reason_code: 'unknown_selection' } },
    });
  });

  it('includes notes in what must have been reviewed', async () => {
    const proposal = await candidates();
    const chosen = proposal.candidates.filter((c) => c.section === 'CURRENT_MEDICINES');
    const notes = ['Is the dose still right?'];

    const withoutNotesInDigest = await generate({
      selectedEntityIds: chosen.map((c) => c.entityId),
      reviewedDigest: digestOf(chosen),
      notes,
    });
    expect(withoutNotesInDigest.statusCode).toBe(409);

    const withNotesInDigest = await generate({
      selectedEntityIds: chosen.map((c) => c.entityId),
      reviewedDigest: digestOf(chosen, notes),
      notes,
    });
    expect(withNotesInDigest.statusCode).toBe(201);
  });
});

describe('retrieving a pack', () => {
  it('always states what the pack is not', async () => {
    // Spec 03 group I: a communication aid, not a clinician-authenticated medical record.
    const { id } = await generateAll();
    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/visit-packs/${id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ limitation: string }>().limitation).toMatch(/not a medical record/i);
  });

  it('reports drift rather than silently rendering new data', async () => {
    // DEC-022: the pack stores a manifest, not a copy of the content. The honest consequence is
    // that a reader is told when the underlying records have moved on.
    const { id } = await generateAll();

    const before = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/visit-packs/${id}`,
    });
    expect(before.json<{ matchesGeneratedContent: boolean }>().matchesGeneratedContent).toBe(true);

    await t.asService((db) =>
      db.query(`UPDATE owned_item SET strength_text = '750 mg' WHERE id = $1`, [MEDICINE_A]),
    );

    const after = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/visit-packs/${id}`,
    });
    expect(after.json<{ matchesGeneratedContent: boolean }>().matchesGeneratedContent).toBe(false);
  });

  it('counts records that were removed after generation', async () => {
    const { id } = await generateAll();
    await t.asService((db) =>
      db.query('UPDATE owned_item SET deleted_at = now() WHERE id = $1', [SHAMPOO_A]),
    );

    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/visit-packs/${id}`,
    });
    expect(response.json<{ removedSinceGeneration: number }>().removedSinceGeneration).toBe(1);
  });

  it('expires without anything having to sweep it', async () => {
    // Spec 16 requires temporary export objects to expire. Evaluated against the clock on every
    // retrieval, so no job is load-bearing.
    const { id } = await generateAll();
    currentNow = instantFrom('2026-09-10T12:00:00.000Z');

    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/visit-packs/${id}`,
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'EXPORT_EXPIRED' } });
  });

  it('stops being retrievable once revoked', async () => {
    const { id } = await generateAll();

    const revoked = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/visit-packs/${id}/revoke`,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: 'REVOKED', alreadyRevoked: false });

    const response = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/visit-packs/${id}`,
    });
    expect(response.statusCode).toBe(410);
  });

  it('makes revocation idempotent, because doubting it worked is the worse failure', async () => {
    const { id } = await generateAll();
    await request(principalFor(OWNER), { method: 'POST', url: `/v1/visit-packs/${id}/revoke` });
    const second = await request(principalFor(OWNER), {
      method: 'POST',
      url: `/v1/visit-packs/${id}/revoke`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ alreadyRevoked: true });
  });
});

describe('who can see an export', () => {
  it('hides a pack from a stranger and from another household', async () => {
    const { id } = await generateAll();
    for (const user of [STRANGER, OTHER_OWNER]) {
      const response = await request(principalFor(user), {
        method: 'GET',
        url: `/v1/visit-packs/${id}`,
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('hides a pack from a caregiver who can read the medicines but not export', async () => {
    // Spec 03 group H: exports are a *separate* permission. A caregiver who can see the
    // medicines is deliberately not thereby able to see what has been shared with a clinician.
    const { id } = await generateAll();
    await t.asService((db) =>
      db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
        [PROFILE_A, CAREGIVER, OWNER, ['VIEW_MEDICINES', 'VIEW_SHELF']],
      ),
    );

    const response = await request(principalFor(CAREGIVER), {
      method: 'GET',
      url: `/v1/visit-packs/${id}`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('shows a pack to a caregiver holding EXPORT_SUMMARY', async () => {
    const { id } = await generateAll();
    await t.asService((db) =>
      db.query(
        `INSERT INTO caregiver_grant
           (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
        [PROFILE_A, EXPORT_CAREGIVER, OWNER, ['EXPORT_SUMMARY']],
      ),
    );

    const response = await request(principalFor(EXPORT_CAREGIVER), {
      method: 'GET',
      url: `/v1/visit-packs/${id}`,
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('audit', () => {
  it('records the generation with counts and no content', async () => {
    const { id } = await generateAll();

    const events = await t.asService((db) =>
      db.query<{ action: string; detail: Record<string, unknown> }>(
        `SELECT action, detail FROM audit_event WHERE target_id = $1 ORDER BY occurred_at`,
        [id],
      ),
    );
    const generated = events.rows.find((e) => e.action === 'visitpack.generated');
    expect(generated).toBeDefined();
    expect(generated?.detail['entry_count']).toBeGreaterThan(0);

    // Spec 16: an audit event without duplicating sensitive content into logs.
    const serialized = JSON.stringify(events.rows);
    expect(serialized).not.toContain('Synthetic Tablet');
    expect(serialized).not.toContain('synthetic-substance');
    expect(serialized).not.toContain('twice daily');
  });

  it('records that a pack was opened, not only that it was made', async () => {
    const { id } = await generateAll();
    await request(principalFor(OWNER), { method: 'GET', url: `/v1/visit-packs/${id}` });

    const events = await t.asService((db) =>
      db.query<{ action: string }>(
        `SELECT action FROM audit_event WHERE target_id = $1 AND action = 'visitpack.viewed'`,
        [id],
      ),
    );
    expect(events.rows).toHaveLength(1);
  });

  it('records a revocation', async () => {
    const { id } = await generateAll();
    await request(principalFor(OWNER), { method: 'POST', url: `/v1/visit-packs/${id}/revoke` });

    const events = await t.asService((db) =>
      db.query<{ action: string }>(
        `SELECT action FROM audit_event WHERE target_id = $1 AND action = 'visitpack.revoked'`,
        [id],
      ),
    );
    expect(events.rows).toHaveLength(1);
  });

  it('never stores the pack content in the database', async () => {
    // DEC-022. The manifest holds IDs and versions; the notes column holds text the user wrote
    // expressly to be shared. Nothing else about the content is duplicated at rest.
    await generateAll();
    const rows = await t.asService((db) =>
      db.query<Record<string, unknown>>('SELECT * FROM visit_pack'),
    );
    const serialized = JSON.stringify(rows.rows);
    expect(serialized).not.toContain('Synthetic Tablet');
    expect(serialized).not.toContain('synthetic-substance');
    expect(serialized).not.toContain('twice daily');
    expect(serialized).toContain(MEDICINE_A);
  });
});

describe('responses carry no sensitive field names', () => {
  it('holds across the flow', async () => {
    const { id } = await generateAll();
    const pack = await request(principalFor(OWNER), {
      method: 'GET',
      url: `/v1/visit-packs/${id}`,
    });
    // A Visit Pack legitimately contains medicine names in its entry lines - that is the point
    // of it - so the structural check is that no *field* named as sensitive is present.
    assertNoSensitiveFields(pack.json<{ entries: unknown[] }>().entries);
  });
});
