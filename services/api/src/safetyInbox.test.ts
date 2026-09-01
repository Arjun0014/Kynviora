import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, InjectOptions } from 'fastify';
import { createServer } from './server.js';
import type { DatabaseConnection, DatabasePool, Principal } from './context.js';
import { createTestDb, testUuid, type TestDb } from '../../../db/harness/harness.js';
import { instantFrom, noopLogger, unsafeId, type Instant, type UserId } from '@kynviora/domain';

/**
 * The Safety Watch inbox against a real database.
 *
 * The derivation is unit-tested and pure. What only a database can prove is the query around it:
 * which alert joins to which item, and - the one that matters - that a withdrawn alert does not
 * leave an item showing "action needed". `19` treats a withdrawn alert resurfacing as a
 * release-blocking defect, and a `state = 'PUBLISHED'` in a join is exactly the kind of clause
 * that reads correct and is not.
 *
 * The seeded fixtures here are synthetic and never reach a user: they exist inside a test
 * database, which is the only place `BLK-006` permits a published safety rule at all.
 */

const OWNER = testUuid(1);
const HOUSEHOLD = testUuid(2);
const PROFILE = testUuid(3);

const ITEM_ALERTED = testUuid(10);
const ITEM_WITHDRAWN = testUuid(11);
const ITEM_ASSESSED_CLEAR = testUuid(12);
const ITEM_UNIDENTIFIED = testUuid(13);
const ITEM_NEVER = testUuid(14);
const ITEM_ARCHIVED = testUuid(15);

const RULE = testUuid(20);
const NOW = instantFrom('2026-08-29T12:00:00.000Z');
const EVALUATED = '2026-08-28T12:00:00.000Z';

let t: TestDb;
let app: FastifyInstance;
let currentPrincipal: Principal | null = null;

interface Line {
  ownedItemId: string;
  displayName: string;
  state: string;
  urgency: string | null;
  evidenceLevel: string | null;
  lastAssessedAt: string | null;
}

async function inbox(query = ''): Promise<{ lines: Line[]; totalItems: number }> {
  currentPrincipal = { userId: unsafeId<UserId>(OWNER), stepUpVerifiedAt: null };
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/profiles/${PROFILE}/safety-inbox${query}`,
    } as InjectOptions);
    expect(response.statusCode).toBe(200);
    return response.json<{ lines: Line[]; totalItems: number }>();
  } finally {
    currentPrincipal = null;
  }
}

function lineFor(lines: readonly Line[], itemId: string): Line | undefined {
  return lines.find((line) => line.ownedItemId === itemId);
}

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    await db.query(
      `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
       VALUES ($1, $2, 'owner@example.test', now())`,
      [OWNER, `auth|${OWNER}`],
    );
    await db.query(`INSERT INTO household (id, owner_user_id, display_name) VALUES ($1, $2, 'H')`, [
      HOUSEHOLD,
      OWNER,
    ]);
    await db.query(
      `INSERT INTO profile (id, household_id, owner_user_id, display_name) VALUES ($1, $2, $3, 'P')`,
      [PROFILE, HOUSEHOLD, OWNER],
    );

    for (const [id, name, lifecycle] of [
      [ITEM_ALERTED, 'A alerted', 'ACTIVE'],
      [ITEM_WITHDRAWN, 'B withdrawn', 'ACTIVE'],
      [ITEM_ASSESSED_CLEAR, 'C assessed clear', 'ACTIVE'],
      [ITEM_UNIDENTIFIED, 'D unidentified', 'ACTIVE'],
      [ITEM_NEVER, 'E never assessed', 'ACTIVE'],
      [ITEM_ARCHIVED, 'F archived', 'ARCHIVED'],
    ] as const) {
      await db.query(
        `INSERT INTO owned_item (id, profile_id, item_kind, display_name, lifecycle_state)
         VALUES ($1, $2, 'MEDICINE', $3, $4)`,
        [id, PROFILE, name, lifecycle],
      );
    }

    await db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id)
       VALUES ($1, 'synthetic.inbox', '1.0.0', 'EXPIRY', 'A', 'CRITICAL',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_CONFIRMED']::text[], 'tpl.expiry')`,
      [RULE],
    );

    /** One assessment. `matched` and the confidence are what the derivation reads. */
    async function assess(
      id: string,
      itemId: string,
      matched: boolean,
      confidence: string,
      urgency: string,
      evidence: string,
    ) {
      await db.query(
        `INSERT INTO profile_assessment
           (id, profile_id, owned_item_id, rule_version_id, matched, match_confidence,
            evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'tpl.expiry', '1.0.0', $9)`,
        [id, PROFILE, itemId, RULE, matched, confidence, evidence, urgency, EVALUATED],
      );
    }

    await assess(testUuid(30), ITEM_ALERTED, true, 'EXACT', 'CRITICAL', 'A');
    await assess(testUuid(31), ITEM_WITHDRAWN, true, 'EXACT', 'CRITICAL', 'A');
    await assess(testUuid(32), ITEM_ASSESSED_CLEAR, false, 'EXACT', 'INFORMATIONAL', 'U');
    await assess(testUuid(33), ITEM_UNIDENTIFIED, false, 'NOT_MATCHED', 'INFORMATIONAL', 'U');

    await db.query(
      `INSERT INTO alert_publication (id, assessment_id, profile_id, state, dedupe_key)
       VALUES ($1, $2, $3, 'PUBLISHED', 'k-alerted')`,
      [testUuid(40), testUuid(30), PROFILE],
    );
    // Withdrawn, with the reason its CHECK requires. The item behind it must fall back to what
    // its assessment says, not stay on "action needed".
    await db.query(
      `INSERT INTO alert_publication
         (id, assessment_id, profile_id, state, dedupe_key, withdrawn_at, withdrawn_reason)
       VALUES ($1, $2, $3, 'WITHDRAWN', 'k-withdrawn', now(), 'synthetic withdrawal')`,
      [testUuid(41), testUuid(31), PROFILE],
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

describe('what a live alert does to a line', () => {
  it('puts an item with a published critical alert on action needed', async () => {
    const line = lineFor((await inbox()).lines, ITEM_ALERTED);
    expect(line?.state).toBe('ACTION_REQUIRED');
    // Beside the state, never folded into it (`23` D-005).
    expect(line?.urgency).toBe('CRITICAL');
    expect(line?.evidenceLevel).toBe('A');
  });

  it('does not leave a withdrawn alert showing action needed', async () => {
    // `19`'s release-blocking defect class. The assessment behind it still says the rule matched,
    // so anything reading the assessment alone would still say ACTION_REQUIRED - which is why the
    // join filters on the publication state and why this test exists at all.
    const line = lineFor((await inbox()).lines, ITEM_WITHDRAWN);
    expect(line?.state).not.toBe('ACTION_REQUIRED');
    expect(line?.urgency).toBeNull();
    expect(line?.evidenceLevel).toBeNull();
  });

  it('reports the withdrawn item as what its assessment actually found', async () => {
    // Identified, and no live alert. That is "nothing matched", not "not enough information".
    expect(lineFor((await inbox()).lines, ITEM_WITHDRAWN)?.state).toBe('NO_CURRENT_MATCHED_ALERT');
  });
});

describe('what an item with no live alert says', () => {
  it('says nothing matched only where it was assessed and identified', async () => {
    expect(lineFor((await inbox()).lines, ITEM_ASSESSED_CLEAR)?.state).toBe(
      'NO_CURRENT_MATCHED_ALERT',
    );
  });

  it('says not enough information where the item could not be identified', async () => {
    expect(lineFor((await inbox()).lines, ITEM_UNIDENTIFIED)?.state).toBe('INSUFFICIENT_DATA');
  });

  it('never says nothing matched for an item nobody assessed', async () => {
    // `23` D-014, at the layer where the SQL decides it. An item with no assessment row must not
    // be indistinguishable from one that was checked and came back clear.
    const line = lineFor((await inbox()).lines, ITEM_NEVER);
    expect(line?.state).toBe('INSUFFICIENT_DATA');
    expect(line?.lastAssessedAt).toBeNull();
  });

  it('reports when an assessed item was last looked at', async () => {
    const line = lineFor((await inbox()).lines, ITEM_ASSESSED_CLEAR);
    expect(line?.lastAssessedAt?.slice(0, 10)).toBe('2026-08-28');
  });
});

describe('what the list contains', () => {
  it('has one line per active item and leaves archived ones out', async () => {
    // An archived item is off the shelf. Reporting it would put a line about something the person
    // has already removed beside the ones they still have.
    const { lines, totalItems } = await inbox();
    expect(totalItems).toBe(5);
    expect(lineFor(lines, ITEM_ARCHIVED)).toBeUndefined();
  });

  it('is ordered by the shelf, not by urgency', async () => {
    // `02` refuses "most urgent first": it is a judgement about which of two people's medicines
    // matters more. The critical item is first here only because its name sorts first.
    const names = (await inbox()).lines.map((line) => line.displayName);
    expect(names).toEqual([...names].sort());
  });

  it('filters by state without changing what it is a subset of', async () => {
    const filtered = await inbox('?state=ACTION_REQUIRED');
    expect(filtered.lines.map((line) => line.ownedItemId)).toEqual([ITEM_ALERTED]);
    expect(filtered.totalItems).toBe(5);
  });

  it('accepts more than one state', async () => {
    const filtered = await inbox('?state=ACTION_REQUIRED&state=NO_CURRENT_MATCHED_ALERT');
    expect(filtered.lines.map((line) => line.ownedItemId).sort()).toEqual(
      [ITEM_ALERTED, ITEM_WITHDRAWN, ITEM_ASSESSED_CLEAR].sort(),
    );
  });

  it('filters by urgency, and excludes every line that has none', async () => {
    const filtered = await inbox('?urgency=CRITICAL');
    expect(filtered.lines.map((line) => line.ownedItemId)).toEqual([ITEM_ALERTED]);
    expect((await inbox('?urgency=LOW')).lines).toEqual([]);
  });

  it('refuses a filter value it does not recognise', async () => {
    // A silently-dropped filter shows more than was asked for, which on this screen is the wrong
    // direction to fail in.
    currentPrincipal = { userId: unsafeId<UserId>(OWNER), stepUpVerifiedAt: null };
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/profiles/${PROFILE}/safety-inbox?state=DEFINITELY_FINE`,
      } as InjectOptions);
      expect(response.statusCode).toBe(400);
    } finally {
      currentPrincipal = null;
    }
  });

  it('carries no count of any state', async () => {
    // `02` refuses the alarm-optimising product a badge on this screen produces. `totalItems` is
    // the size of the shelf, which is a fact about the shelf.
    const body = await inbox();
    expect(Object.keys(body).sort()).toEqual(['lines', 'profileId', 'serverTime', 'totalItems']);
  });
});
