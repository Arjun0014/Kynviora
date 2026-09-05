import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, expectDenied, testUuid, type TestDb } from './harness/harness.js';

/**
 * Database-level tests for caregiver alert delivery (migration `0009`).
 *
 * Spec 03 group H requires safety alerts to be a permission separate from the shelf, the
 * medicines and exports, and requires generic notification content by default. Spec 16 requires
 * caregiver notifications to reveal minimal information and forbids using "family" to justify
 * broad hidden access. Spec 13 makes notification dispatch a privileged server-only operation.
 *
 * Every assertion runs as the non-superuser `kynviora_app` or `kynviora_service` role (DEC-005).
 * An authorization test that ran as `postgres` would pass vacuously, because a superuser bypasses
 * row-level security even under `FORCE ROW LEVEL SECURITY`.
 */

const OWNER = testUuid(1);
const OTHER_OWNER = testUuid(2);
const SAFETY_CAREGIVER = testUuid(3);
const DOSE_CAREGIVER = testUuid(4);
const SHELF_CAREGIVER = testUuid(5);
const STRANGER = testUuid(6);

const HOUSEHOLD_A = testUuid(10);
const HOUSEHOLD_B = testUuid(11);
const PROFILE_A = testUuid(20);
const PROFILE_B = testUuid(21);

const ITEM_A = testUuid(30);
const RULE_V = testUuid(40);
const ASSESSMENT = testUuid(41);
const ALERT = testUuid(42);

const NOW = '2026-08-29T12:00:00.000Z';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();

  await t.asService(async (db) => {
    for (const [id, email] of [
      [OWNER, 'owner@example.test'],
      [OTHER_OWNER, 'other@example.test'],
      [SAFETY_CAREGIVER, 'safety@example.test'],
      [DOSE_CAREGIVER, 'dose@example.test'],
      [SHELF_CAREGIVER, 'shelf@example.test'],
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
    await db.query(
      `INSERT INTO owned_item (id, profile_id, item_kind, display_name)
       VALUES ($1, $2, 'MEDICINE', 'Synthetic Tablet A')`,
      [ITEM_A, PROFILE_A],
    );
    await db.query(
      `INSERT INTO assessment_rule_version
         (id, rule_key, version, rule_kind, evidence_level, max_urgency,
          required_item_verification, required_profile_provenance, explanation_template_id)
       VALUES ($1, 'synthetic.test', '1.0.0', 'EXPIRY', 'C', 'MEDIUM',
               ARRAY['CONFIRMED']::text[], ARRAY['USER_REPORTED']::text[], 'tpl.synthetic')`,
      [RULE_V],
    );
    await db.query(
      `INSERT INTO profile_assessment
         (id, profile_id, owned_item_id, rule_version_id, matched, match_confidence,
          evidence_level, urgency, explanation_template_id, normalization_version, evaluated_at)
       VALUES ($1, $2, $3, $4, true, 'EXACT', 'C', 'MEDIUM', 'tpl.synthetic', '1.0.0', $5)`,
      [ASSESSMENT, PROFILE_A, ITEM_A, RULE_V, NOW],
    );
    await db.query(
      `INSERT INTO alert_publication (id, assessment_id, profile_id, state, dedupe_key)
       VALUES ($1, $2, $3, 'PUBLISHED', 'dedupe-a')`,
      [ALERT, ASSESSMENT, PROFILE_A],
    );
  });
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  // The owner role, not the service role: kynviora_service holds no DELETE on caregiver_grant
  // because a grant is revoked rather than deleted, and alert_delivery is append-only.
  await t.asOwner(async (db) => {
    await db.query('DELETE FROM caregiver_grant');
    await db.query('DELETE FROM notification_preference');
    await db.query('DELETE FROM profile_notification_policy');
    await db.query('TRUNCATE alert_delivery');
  });
});

async function grant(userId: string, capabilities: string[], profileId = PROFILE_A) {
  await t.asService((db) =>
    db.query(
      `INSERT INTO caregiver_grant
         (profile_id, grantee_user_id, granted_by_user_id, capabilities, status, accepted_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now())`,
      [profileId, userId, OWNER, capabilities],
    ),
  );
}

async function deliver(
  recipient: string,
  overrides: {
    kind?: string;
    publicationId?: string | null;
    occurrenceKey?: string | null;
    detail?: string;
    profileId?: string;
  } = {},
) {
  const kind = overrides.kind ?? 'SAFETY_ALERT';
  return t.asService((db) =>
    db.query(
      `INSERT INTO alert_delivery
         (profile_id, recipient_user_id, event_kind, alert_publication_id, dose_occurrence_key,
          detail_level, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        overrides.profileId ?? PROFILE_A,
        recipient,
        kind,
        overrides.publicationId === undefined
          ? kind === 'SAFETY_ALERT'
            ? ALERT
            : null
          : overrides.publicationId,
        overrides.occurrenceKey === undefined
          ? kind === 'MISSED_DOSE'
            ? 'occurrence-1'
            : null
          : overrides.occurrenceKey,
        overrides.detail ?? 'GENERIC',
        NOW,
      ],
    ),
  );
}

// ---------------------------------------------------------------------------

describe('constraints', () => {
  it('refuses a detail level outside the vocabulary', async () => {
    const message = await expectDenied(() => deliver(OWNER, { detail: 'EVERYTHING' }));
    expect(message).toMatch(/alert_delivery_detail_valid/);
  });

  it('refuses an event kind outside the vocabulary', async () => {
    const message = await expectDenied(() =>
      deliver(OWNER, { kind: 'GOSSIP', publicationId: ALERT, occurrenceKey: null }),
    );
    expect(message).toMatch(/alert_delivery_event_kind_valid/);
  });

  it('refuses a safety-alert delivery with no publication', async () => {
    const message = await expectDenied(() =>
      deliver(OWNER, { kind: 'SAFETY_ALERT', publicationId: null, occurrenceKey: null }),
    );
    expect(message).toMatch(/alert_delivery_reference_matches_kind/);
  });

  it('refuses a missed-dose delivery that borrows a publication', async () => {
    // Without this, a missed-dose row could appear in the safety history of an alert it has
    // nothing to do with.
    const message = await expectDenied(() =>
      deliver(OWNER, {
        kind: 'MISSED_DOSE',
        publicationId: ALERT,
        occurrenceKey: 'occurrence-1',
      }),
    );
    expect(message).toMatch(/alert_delivery_reference_matches_kind/);
  });

  it('refuses a missed-dose delivery with no occurrence key', async () => {
    const message = await expectDenied(() =>
      deliver(OWNER, { kind: 'MISSED_DOSE', publicationId: null, occurrenceKey: null }),
    );
    expect(message).toMatch(/alert_delivery_reference_matches_kind/);
  });

  it('refuses a policy detail level outside the vocabulary', async () => {
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO profile_notification_policy (profile_id, max_caregiver_detail)
           VALUES ($1, 'EVERYTHING')`,
          [PROFILE_A],
        ),
      ),
    );
    expect(message).toMatch(/notification_policy_caregiver_detail_valid/);
  });

  it('defaults a new policy row to the most private setting', async () => {
    // 03 group H: generic notification content by default. A row created without an explicit
    // level must not land on the most permissive one.
    await t.asService((db) =>
      db.query('INSERT INTO profile_notification_policy (profile_id) VALUES ($1)', [PROFILE_A]),
    );
    const res = await t.asService((db) =>
      db.query<{ max_caregiver_detail: string }>(
        'SELECT max_caregiver_detail FROM profile_notification_policy WHERE profile_id = $1',
        [PROFILE_A],
      ),
    );
    expect(res.rows[0]?.max_caregiver_detail).toBe('GENERIC');
  });

  it('defaults a new preference row to the most private setting', async () => {
    await t.asService((db) =>
      db.query('INSERT INTO notification_preference (user_id, profile_id) VALUES ($1, $2)', [
        OWNER,
        PROFILE_A,
      ]),
    );
    const res = await t.asService((db) =>
      db.query<{ detail_level: string }>(
        'SELECT detail_level FROM notification_preference WHERE user_id = $1',
        [OWNER],
      ),
    );
    expect(res.rows[0]?.detail_level).toBe('GENERIC');
  });

  it('refuses two preferences for the same person and profile', async () => {
    // Two rows would be two answers to a question that has one, and whichever the query read
    // would decide what appeared on a lock screen.
    await t.asService((db) =>
      db.query(
        `INSERT INTO notification_preference (user_id, profile_id, detail_level)
         VALUES ($1, $2, 'NAMED')`,
        [OWNER, PROFILE_A],
      ),
    );
    const message = await expectDenied(() =>
      t.asService((db) =>
        db.query(
          `INSERT INTO notification_preference (user_id, profile_id, detail_level)
           VALUES ($1, $2, 'GENERIC')`,
          [OWNER, PROFILE_A],
        ),
      ),
    );
    expect(message).toMatch(/notification_preference_user_profile_idx|duplicate key/i);
  });
});

describe('deduplication', () => {
  it('refuses a second delivery of the same alert to the same person', async () => {
    await deliver(SAFETY_CAREGIVER);
    const message = await expectDenied(() => deliver(SAFETY_CAREGIVER));
    expect(message).toMatch(/alert_delivery_publication_recipient_idx|duplicate key/i);
  });

  it('allows the same alert to a different person', async () => {
    await deliver(SAFETY_CAREGIVER);
    await deliver(OWNER);
    const res = await t.asService((db) =>
      db.query('SELECT id FROM alert_delivery WHERE alert_publication_id = $1', [ALERT]),
    );
    expect(res.rows).toHaveLength(2);
  });

  it('refuses a second delivery of the same dose occurrence to the same person', async () => {
    await deliver(DOSE_CAREGIVER, { kind: 'MISSED_DOSE' });
    const message = await expectDenied(() => deliver(DOSE_CAREGIVER, { kind: 'MISSED_DOSE' }));
    expect(message).toMatch(/alert_delivery_dose_recipient_idx|duplicate key/i);
  });

  it('allows a different dose occurrence to the same person', async () => {
    await deliver(DOSE_CAREGIVER, { kind: 'MISSED_DOSE', occurrenceKey: 'occurrence-1' });
    await deliver(DOSE_CAREGIVER, { kind: 'MISSED_DOSE', occurrenceKey: 'occurrence-2' });
    const res = await t.asService((db) =>
      db.query(`SELECT id FROM alert_delivery WHERE event_kind = 'MISSED_DOSE'`),
    );
    expect(res.rows).toHaveLength(2);
  });
});

describe('a delivery cannot be un-happened', () => {
  // Two independent mechanisms refuse this, and the tests assert both rather than whichever
  // happens to fire first. The GRANT stops the roles the application actually uses; the trigger
  // stops anyone who reaches the table with wider rights, which is the case the GRANT cannot
  // cover. Asserting only the outer layer would let the inner one be dropped unnoticed.

  it('gives the service role no rights to update or delete', async () => {
    await deliver(OWNER);
    for (const sql of [
      `UPDATE alert_delivery SET detail_level = 'NAMED'`,
      'DELETE FROM alert_delivery',
    ]) {
      const message = await expectDenied(() => t.asService((db) => db.query(sql)));
      expect(message).toMatch(/permission denied/i);
    }
  });

  it('refuses an update even from a role that holds the privilege', async () => {
    await deliver(OWNER);
    const message = await expectDenied(() =>
      t.asOwner((db) => db.query(`UPDATE alert_delivery SET detail_level = 'NAMED'`)),
    );
    expect(message).toMatch(/append|immutable|not allowed|forbid/i);
  });

  it('refuses a delete even from a role that holds the privilege', async () => {
    await deliver(OWNER);
    // Since `0025` the refusal names the more specific reason. This table carries a purge door
    // keyed on `profile_id` (DEC-120), and its condition is
    // `pg_has_role(current_user, 'kynviora_retention', 'MEMBER')` - true for a superuser, because
    // a superuser is a member of every role. So this session reaches the door and is turned back
    // by the **profile** gate rather than by the blanket one: no profile here is thirty days
    // deleted.
    //
    // The refusal is what this test is for and it is unchanged. What the message now says is that
    // a delivery goes when the person it was about goes, and not before.
    const message = await expectDenied(() =>
      t.asOwner((db) => db.query('DELETE FROM alert_delivery')),
    );
    expect(message).toMatch(/not due for purge/i);
  });
});

describe('privilege separation', () => {
  it('does not let the app role write a delivery', async () => {
    // 13 lists notification dispatch among the privileged server-only operations. A client that
    // could insert a delivery row could suppress a real notification by pre-claiming its
    // deduplication key.
    const message = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `INSERT INTO alert_delivery
             (profile_id, recipient_user_id, event_kind, alert_publication_id, detail_level,
              delivered_at)
           VALUES ($1, $2, 'SAFETY_ALERT', $3, 'GENERIC', now())`,
          [PROFILE_A, OWNER, ALERT],
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('does not let the app role write the owner ceiling directly', async () => {
    // The ceiling changes what every caregiver receives. It goes through the service role so the
    // API can require step-up and owner identity first - neither of which the database can check.
    const message = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `INSERT INTO profile_notification_policy (profile_id, max_caregiver_detail)
           VALUES ($1, 'NAMED')`,
          [PROFILE_A],
        ),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

describe('row level security: deliveries', () => {
  beforeEach(async () => {
    await deliver(OWNER);
    await deliver(SAFETY_CAREGIVER);
  });

  it('shows the owner every delivery for their profile', async () => {
    const res = await t.asUser(OWNER, (db) =>
      db.query<{ recipient_user_id: string }>(
        'SELECT recipient_user_id FROM alert_delivery ORDER BY recipient_user_id',
      ),
    );
    expect(res.rows.map((r) => r.recipient_user_id).sort()).toEqual(
      [OWNER, SAFETY_CAREGIVER].sort(),
    );
  });

  it('shows a caregiver only their own delivery', async () => {
    // 16 forbids using "family" to justify broad hidden access. One relative's notification
    // history is not another's business.
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    const res = await t.asUser(SAFETY_CAREGIVER, (db) =>
      db.query<{ recipient_user_id: string }>('SELECT recipient_user_id FROM alert_delivery'),
    );
    expect(res.rows.map((r) => r.recipient_user_id)).toEqual([SAFETY_CAREGIVER]);
  });

  it('shows a stranger nothing', async () => {
    const res = await t.asUser(STRANGER, (db) =>
      db.query('SELECT recipient_user_id FROM alert_delivery'),
    );
    expect(res.rows).toEqual([]);
  });

  it('shows another household nothing', async () => {
    const res = await t.asUser(OTHER_OWNER, (db) =>
      db.query('SELECT recipient_user_id FROM alert_delivery'),
    );
    expect(res.rows).toEqual([]);
  });

  it('stops showing a revoked caregiver their history on the next access', async () => {
    // 15 A2: revocation takes effect immediately. The delivery row itself names them, so this is
    // the one place a revoked caregiver could still read something about the profile.
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    const before = await t.asUser(SAFETY_CAREGIVER, (db) =>
      db.query('SELECT id FROM alert_delivery'),
    );
    expect(before.rows).toHaveLength(1);

    // The recipient predicate is identity-based, not capability-based, so revocation does not
    // hide a notification they already received - which is correct: it was sent to them, and
    // pretending otherwise would not un-send it. What revocation must stop is *new* delivery,
    // asserted in the domain and API suites.
    await t.asService((db) =>
      db.query(
        `UPDATE caregiver_grant SET status = 'REVOKED', revoked_at = now(),
           revoked_by_user_id = $1 WHERE grantee_user_id = $2`,
        [OWNER, SAFETY_CAREGIVER],
      ),
    );
    const after = await t.asUser(SAFETY_CAREGIVER, (db) =>
      db.query('SELECT id FROM alert_delivery'),
    );
    expect(after.rows).toHaveLength(1);
  });
});

describe('row level security: preferences', () => {
  it('lets a person read only their own preference', async () => {
    await t.asService(async (db) => {
      await db.query(
        `INSERT INTO notification_preference (user_id, profile_id, detail_level)
         VALUES ($1, $2, 'NAMED'), ($3, $2, 'CATEGORY')`,
        [OWNER, PROFILE_A, SAFETY_CAREGIVER],
      );
    });

    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    const res = await t.asUser(SAFETY_CAREGIVER, (db) =>
      db.query<{ detail_level: string }>('SELECT detail_level FROM notification_preference'),
    );
    expect(res.rows).toEqual([{ detail_level: 'CATEGORY' }]);
  });

  it('refuses a preference row written on behalf of someone else', async () => {
    const message = await expectDenied(() =>
      t.asUser(OWNER, (db) =>
        db.query(
          `INSERT INTO notification_preference (user_id, profile_id, detail_level)
           VALUES ($1, $2, 'NAMED')`,
          [SAFETY_CAREGIVER, PROFILE_A],
        ),
      ),
    );
    expect(message).toMatch(/row-level security|violates/i);
  });

  it('refuses a preference for a profile the writer has no relationship to', async () => {
    const message = await expectDenied(() =>
      t.asUser(STRANGER, (db) =>
        db.query(
          `INSERT INTO notification_preference (user_id, profile_id, detail_level)
           VALUES ($1, $2, 'NAMED')`,
          [STRANGER, PROFILE_A],
        ),
      ),
    );
    expect(message).toMatch(/row-level security|violates/i);
  });

  it('refuses a preference from a caregiver holding no notification-bearing capability', async () => {
    // Shelf access is not a reason to hold a notification setting for someone's safety alerts.
    await grant(SHELF_CAREGIVER, ['VIEW_SHELF', 'VIEW_MEDICINES']);
    const message = await expectDenied(() =>
      t.asUser(SHELF_CAREGIVER, (db) =>
        db.query(
          `INSERT INTO notification_preference (user_id, profile_id, detail_level)
           VALUES ($1, $2, 'NAMED')`,
          [SHELF_CAREGIVER, PROFILE_A],
        ),
      ),
    );
    expect(message).toMatch(/row-level security|violates/i);
  });

  it('admits a caregiver holding only the missed-dose capability', async () => {
    // The missed-dose permission is a notification-bearing capability in its own right, so its
    // holder must be able to set how much their own device shows.
    await grant(DOSE_CAREGIVER, ['RECEIVE_MISSED_DOSE']);
    await t.asUser(DOSE_CAREGIVER, (db) =>
      db.query(
        `INSERT INTO notification_preference (user_id, profile_id, detail_level)
         VALUES ($1, $2, 'CATEGORY')`,
        [DOSE_CAREGIVER, PROFILE_A],
      ),
    );
    const res = await t.asUser(DOSE_CAREGIVER, (db) =>
      db.query('SELECT id FROM notification_preference'),
    );
    expect(res.rows).toHaveLength(1);
  });
});

describe('row level security: the ceiling', () => {
  beforeEach(async () => {
    await t.asService((db) =>
      db.query(
        `INSERT INTO profile_notification_policy (profile_id, max_caregiver_detail)
         VALUES ($1, 'CATEGORY')`,
        [PROFILE_A],
      ),
    );
  });

  it('is readable by the owner', async () => {
    const res = await t.asUser(OWNER, (db) =>
      db.query('SELECT profile_id FROM profile_notification_policy'),
    );
    expect(res.rows).toHaveLength(1);
  });

  it('is readable by a caregiver it applies to, so their own setting is explicable', async () => {
    await grant(SAFETY_CAREGIVER, ['VIEW_SAFETY']);
    const res = await t.asUser(SAFETY_CAREGIVER, (db) =>
      db.query('SELECT profile_id FROM profile_notification_policy'),
    );
    expect(res.rows).toHaveLength(1);
  });

  it('is not readable by a caregiver who receives no notifications', async () => {
    await grant(SHELF_CAREGIVER, ['VIEW_SHELF']);
    const res = await t.asUser(SHELF_CAREGIVER, (db) =>
      db.query('SELECT profile_id FROM profile_notification_policy'),
    );
    expect(res.rows).toEqual([]);
  });

  it('is not readable by a stranger', async () => {
    const res = await t.asUser(STRANGER, (db) =>
      db.query('SELECT profile_id FROM profile_notification_policy'),
    );
    expect(res.rows).toEqual([]);
  });
});

describe('the channel columns', () => {
  /** A delivery carrying an explicit channel triple, so each constraint has something to refuse. */
  function deliverWithChannel(
    recipient: string,
    channel: string | null,
    reason: string | null,
    held: boolean | null,
    occurrenceKey = 'channel-1',
  ) {
    return t.asService((db) =>
      db.query(
        `INSERT INTO alert_delivery
           (profile_id, recipient_user_id, event_kind, alert_publication_id, dose_occurrence_key,
            detail_level, delivered_at, channel, channel_reason, held)
         VALUES ($1, $2, 'MISSED_DOSE', NULL, $3, 'GENERIC', $4, $5, $6, $7)`,
        [PROFILE_A, recipient, occurrenceKey, NOW, channel, reason, held],
      ),
    );
  }

  it('accepts a complete triple', async () => {
    await expect(
      deliverWithChannel(OWNER, 'DIGEST', 'URGENCY_CEILING', false, 'channel-ok'),
    ).resolves.toBeDefined();
  });

  it('accepts a row that has none of them, because rows predate the columns', async () => {
    // NULL means "written before migration 0028", which is a fact rather than a missing value.
    // A default would have been a guess that reads as a fact.
    await expect(
      deliverWithChannel(OWNER, null, null, null, 'channel-none'),
    ).resolves.toBeDefined();
  });

  it('refuses a channel outside the vocabulary', async () => {
    const message = await expectDenied(() =>
      deliverWithChannel(OWNER, 'SHOUT', 'URGENCY_CEILING', false, 'channel-bad'),
    );
    expect(message).toMatch(/alert_delivery_channel_valid/);
  });

  it('refuses a reason outside the vocabulary', async () => {
    const message = await expectDenied(() =>
      deliverWithChannel(OWNER, 'DIGEST', 'BECAUSE', false, 'channel-bad-reason'),
    );
    expect(message).toMatch(/alert_delivery_channel_reason_valid/);
  });

  it('refuses a channel with no reason beside it', async () => {
    // The half an operator actually reads. A row saying DIGEST and not why is a row that recorded
    // the decision and lost its explanation.
    const message = await expectDenied(() =>
      deliverWithChannel(OWNER, 'DIGEST', null, false, 'channel-half'),
    );
    expect(message).toMatch(/alert_delivery_channel_together/);
  });

  it('refuses a held digest, because only an interrupt has a time it would have arrived', async () => {
    // The invariant that lived only in `deliveryDecision`'s control flow until `0028`. Holding a
    // digest line is meaningless - there is no moment it was going to appear - and a held digest
    // would be a lower urgency wearing the language of a deferred alert.
    const message = await expectDenied(() =>
      deliverWithChannel(OWNER, 'DIGEST', 'HELD_FOR_QUIET_HOURS', true, 'channel-held-digest'),
    );
    expect(message).toMatch(/alert_delivery_held_is_an_interrupt/);
  });

  it('refuses a hold claiming any reason but quiet hours', async () => {
    const message = await expectDenied(() =>
      deliverWithChannel(OWNER, 'INTERRUPT', 'URGENCY_CEILING', true, 'channel-held-why'),
    );
    expect(message).toMatch(/alert_delivery_held_has_one_reason/);
  });

  it('accepts an interrupt held for quiet hours, which is the case that exists', async () => {
    await expect(
      deliverWithChannel(OWNER, 'INTERRUPT', 'HELD_FOR_QUIET_HOURS', true, 'channel-held-ok'),
    ).resolves.toBeDefined();
  });
});
