import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './harness/harness.js';
import { PURGE_CATEGORY_NAMES } from './src/retention.js';
import {
  CHANNEL_REASONS,
  DELIVERY_CHANNELS,
  EXTRACTION_STATES,
  HEALTH_METRICS,
  HEALTH_RECORD_KINDS,
  HEALTH_SOURCE_KINDS,
  HEALTH_SOURCE_STATES,
  REVALIDATION_OUTCOMES,
  SOURCE_FLAGS,
} from '@kynviora/domain';
import { RETENTION_RUN_OUTCOMES } from '@kynviora/worker';

/**
 * The closed vocabularies that exist twice, checked against each other.
 *
 * Spec references: `19` (a release-gating defect class is one nothing would catch), `07`
 * (vocabularies are closed sets), DEC-121, DEC-122, `0026`, `0028`, `0029`.
 *
 * WHY THIS FILE EXISTS
 * Several vocabularies here are declared in **two** places: a `const` array in TypeScript and a
 * `CHECK` constraint in SQL. That duplication is deliberate - the constraint is what makes the set
 * true of the data rather than true of the code that happens to write it - and it has one failure
 * mode, which is that the two stop agreeing.
 *
 * The direction that hurts is silent in a specific way. Adding a member to the TypeScript array
 * without adding it to the constraint produces code that compiles, passes every type check, and
 * raises `23514` at run time - in a background job, on the one category or outcome nobody exercised
 * in a test. Adding one to the constraint without adding it to the array is quieter still: nothing
 * fails at all, and a value the database accepts is one no reader knows about.
 *
 * `packages/domain/src/observability.test.ts` already does this for metric units, one file over,
 * with `Object.keys(METRIC_UNIT).sort()`. This is the same guard where the second declaration is in
 * SQL rather than in TypeScript.
 *
 * HOW THE CONSTRAINT IS READ
 * `pg_get_constraintdef` renders a membership test as
 * `column = ANY (ARRAY['A'::text, 'B'::text])`, so the accepted set is every quoted literal in it.
 * Reading it that way rather than by attempting an insert per value is what lets the test catch the
 * quiet direction too: an insert-based check can only find members the constraint refuses, never
 * members nobody declared.
 */

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t?.close();
});

/** Every string literal a CHECK constraint compares against. */
async function acceptedBy(constraintName: string): Promise<string[]> {
  const result = await t.asOwner((db) =>
    db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraintName],
    ),
  );
  const definition = result.rows[0]?.def;
  // A missing constraint must fail loudly rather than compare two empty sets and pass, which is
  // exactly what a renamed constraint would otherwise do.
  expect(definition, `no constraint named ${constraintName}`).toBeDefined();

  return [...(definition ?? '').matchAll(/'([^']+)'::text/g)]
    .map((match) => match[1] as string)
    .sort();
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('the retention sweep’s categories', () => {
  it('are the same set in the plan and in the schema', async () => {
    // The plan drives what the worker writes and the constraint decides what the database accepts.
    // A category added to one and not the other raises `23514` from a background job, on the one
    // category nothing happened to exercise.
    expect(await acceptedBy('retention_run_category_valid')).toEqual(sorted(PURGE_CATEGORY_NAMES));
  });

  it('are the categories the plan actually runs, not a superset', async () => {
    // The plan is the list of things that run; the names array is the vocabulary. A name with no
    // steps behind it would be a category that can be recorded and never attempted.
    const { PURGE_CATEGORIES } = await import('./src/retention.js');
    expect(sorted(PURGE_CATEGORIES.map((plan) => plan.category))).toEqual(
      sorted(PURGE_CATEGORY_NAMES),
    );
  });
});

describe('a retention run’s outcomes', () => {
  it('are the same four in the worker and in the schema', async () => {
    // Spread across the constraint's three legal shapes - ABANDONED in one branch, the other three
    // in another - so this reads every literal in it rather than one branch's.
    expect(await acceptedBy('retention_run_open_or_closed')).toEqual(
      sorted(RETENTION_RUN_OUTCOMES),
    );
  });

  it('include PARTIAL, which is the one a schema could quietly lose', async () => {
    // Stated separately because it is the member with a reason. A run where one category raised
    // has not kept that category's deadline, and a schema that accepted only SUCCEEDED and FAILED
    // would force every partial sweep to be recorded as one or the other.
    expect(await acceptedBy('retention_run_open_or_closed')).toContain('PARTIAL');
  });
});

describe('a delivery’s channel and its reason', () => {
  it('are the same set in the domain and in the schema', async () => {
    expect(await acceptedBy('alert_delivery_channel_valid')).toEqual(sorted(DELIVERY_CHANNELS));
    expect(await acceptedBy('alert_delivery_channel_reason_valid')).toEqual(
      sorted(CHANNEL_REASONS),
    );
  });
});

describe('a digest entry’s revalidation outcome', () => {
  it('is the same set as the domain’s', async () => {
    // `notification_digest_entry.outcome` stores what `revalidate` returned. If the domain gained a
    // sixth outcome, every digest containing one would fail to be written - and the assembly that
    // failed would be a background job nobody was watching.
    expect(await acceptedBy('notification_digest_entry_outcome_valid')).toEqual(
      sorted(REVALIDATION_OUTCOMES),
    );
  });
});

describe('the Health record’s five vocabularies', () => {
  // Five sets declared twice: a `const` array in `packages/domain/src/healthRecord.ts` and a
  // CHECK in `0032`. The quiet direction is the one that matters here - a member added to the
  // constraint and not to the domain is a value the database accepts and no screen can render,
  // and on a lab result that means a row appearing with no label beside it.

  it('agree about what kind a record may be', async () => {
    expect(await acceptedBy('health_record_kind_valid')).toEqual(sorted(HEALTH_RECORD_KINDS));
  });

  it('agree about how a record was extracted', async () => {
    expect(await acceptedBy('health_record_extraction_valid')).toEqual(sorted(EXTRACTION_STATES));
  });

  it('agree about what a source is and what state it is in', async () => {
    expect(await acceptedBy('health_source_kind_valid')).toEqual(sorted(HEALTH_SOURCE_KINDS));
    // The state list is spread across two constraints - one enumerates, the other excludes two
    // members - so this reads the enumerating one by name rather than whichever matched first.
    expect(await acceptedBy('health_source_state_valid')).toEqual(sorted(HEALTH_SOURCE_STATES));
  });

  it('agree about which words a report may have used', async () => {
    // The set a report is quoted from. A member added to the schema and not the domain would be
    // a flag stored with no sentence to render it, which on a lab result is a chip with no words.
    expect(await acceptedBy('health_observation_flag_valid')).toEqual(sorted(SOURCE_FLAGS));
  });

  it('agree about which metrics a trend may be drawn for', async () => {
    expect(await acceptedBy('health_measurement_metric_valid')).toEqual(sorted(HEALTH_METRICS));
  });
});
