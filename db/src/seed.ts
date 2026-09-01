/**
 * Development seed data: one household, one profile, a few shelf items.
 *
 * Spec references: `19` (synthetic fixtures only), `02` (no invented product claims),
 * `BLK-004`, `BLK-006`.
 *
 * WHY THIS IS A FUNCTION AND NOT A SCRIPT
 * It was a script first, and the script was wrong. PGlite is a **single writer**: a standalone
 * seed process opening the same data directory as a running server does not share its state, and
 * whichever process exits last writes its own snapshot over the other's. The symptom was a seed
 * that reported success against a database that stayed empty, which is the kind of failure that
 * costs an hour before anyone suspects the tool rather than the code.
 *
 * So seeding happens inside the API process, on the connection it already holds, behind
 * `KYNVIORA_DEV_SEED=1`. One writer, one path, and the race cannot be reintroduced by running two
 * commands in the wrong order.
 *
 * WHAT IT DELIBERATELY DOES NOT SEED
 * No safety rule, no regulatory record, no alert. Publishing any of those needs a qualified
 * reviewer (`BLK-006`) and retrieved official documents (`BLK-004`), and seeding them would put
 * exactly the content in front of a developer that the governance layers exist to keep out. The
 * Safety and Regulatory Lens screens are empty against this seed, and that is the correct result
 * rather than a gap in the fixture.
 *
 * Every product name begins with "Synthetic" and no GTIN, batch code, strength or direction
 * corresponds to a real product, so a screenshot of this can never be mistaken for a real medicine
 * record.
 */

export interface SeedConnection {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: TRow[] }>;
}

/** Stable IDs, so a developer can paste one into a header and it keeps working across restarts. */
export const SEED = Object.freeze({
  userId: '00000000-0000-4000-8000-00000000d001',
  caregiverUserId: '00000000-0000-4000-8000-00000000d002',
  householdId: '00000000-0000-4000-8000-00000000d010',
  profileId: '00000000-0000-4000-8000-00000000d020',
});

/**
 * How long ago the oldest seeded item was added.
 *
 * Past `ITEM_REVIEW_INTERVAL_DAYS` (180) on purpose. Without it every derived review task is a
 * `BATCH_MISSING`, which needs guided capture and so cannot be completed from the inbox - a
 * developer opening Today would see only work the app cannot yet do, and would reasonably
 * conclude the screen was broken. One item added two hundred days ago is ordinary synthetic
 * household data and it makes the completion path reachable by hand.
 */
const AGED_ITEM_DAYS = 200;

const ITEMS = [
  {
    id: '00000000-0000-4000-8000-00000000d030',
    kind: 'MEDICINE',
    name: 'Synthetic Tablet A',
    strength: '500 mg',
    form: 'tablet',
    directions: 'One tablet twice a day',
    ageDays: 0,
  },
  {
    id: '00000000-0000-4000-8000-00000000d031',
    kind: 'MEDICINE',
    name: 'Synthetic Capsule B',
    strength: '20 mg',
    form: 'capsule',
    directions: 'One capsule each morning',
    ageDays: 0,
  },
  {
    id: '00000000-0000-4000-8000-00000000d032',
    kind: 'PERSONAL_CARE',
    name: 'Synthetic Moisturiser C',
    strength: null,
    form: null,
    directions: null,
    ageDays: AGED_ITEM_DAYS,
  },
] as const;

export interface SeedResult {
  readonly seeded: boolean;
  readonly userId: string;
  readonly profileId: string;
  readonly itemCount: number;
}

/**
 * Insert the development fixture, once.
 *
 * Idempotent by the seeded user's ID, so a restart does not duplicate anything and does not fail.
 * Must be called on a **service-role** connection: it writes across households, which is precisely
 * what row-level security exists to stop an ordinary connection doing.
 *
 * `now` is passed in rather than left to `DEFAULT now()`, because one item is deliberately older
 * than the review interval and its age has to be relative to the same clock everything else uses
 * (DEC-024).
 */
export async function seedDevelopmentData(db: SeedConnection, now: string): Promise<SeedResult> {
  const existing = await db.query<{ id: string }>('SELECT id FROM app_user WHERE id = $1', [
    SEED.userId,
  ]);
  if (existing.rows.length > 0) {
    return {
      seeded: false,
      userId: SEED.userId,
      profileId: SEED.profileId,
      itemCount: ITEMS.length,
    };
  }

  for (const [id, email] of [
    [SEED.userId, 'you@example.test'],
    [SEED.caregiverUserId, 'caregiver@example.test'],
  ] as const) {
    await db.query(
      `INSERT INTO app_user (id, external_auth_id, email_normalized, email_verified_at)
       VALUES ($1, $2, $3, now())`,
      [id, `dev|${id}`, email],
    );
  }

  await db.query(
    `INSERT INTO household (id, owner_user_id, display_name)
     VALUES ($1, $2, 'Development household')`,
    [SEED.householdId, SEED.userId],
  );
  await db.query(
    `INSERT INTO profile (id, household_id, owner_user_id, display_name)
     VALUES ($1, $2, $3, 'Development profile')`,
    [SEED.profileId, SEED.householdId, SEED.userId],
  );

  const nowMs = Date.parse(now);
  for (const item of ITEMS) {
    const createdAt = new Date(nowMs - item.ageDays * 24 * 60 * 60 * 1000).toISOString();
    await db.query(
      `INSERT INTO owned_item
         (id, profile_id, item_kind, display_name, strength_text, dosage_form, directions_text,
          lifecycle_state, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)`,
      [
        item.id,
        SEED.profileId,
        item.kind,
        item.name,
        item.strength,
        item.form,
        item.directions,
        createdAt,
      ],
    );
  }

  return { seeded: true, userId: SEED.userId, profileId: SEED.profileId, itemCount: ITEMS.length };
}
