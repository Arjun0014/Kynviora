/**
 * The Change Lens: what differs between two records, computed once for every surface that shows it.
 *
 * Spec references: `02` (no score, no ranking, evidence and urgency separate), `09` (evidence
 * model), `18` (meaning never carried by colour alone), DEC-153.
 *
 * WHY THIS IS ONE FUNCTION AND NOT SIX
 * V3 puts a "what changed" block on the lab comparison, the annual checkup, a formulation change,
 * a medicine record, a caregiver access change and a connected source. The design language states
 * the rule on screen - "the value moved by more than a tenth of the previous one for year-on-year
 * comparisons, or a twentieth for a short-interval repeat" - and then says the thing that makes it
 * a domain concern rather than a formatting one: *every count on every screen is derived from the
 * same rule, so no two surfaces can disagree*. A count computed in a component is a count that can
 * disagree with the list beside it, and a person reading "4 changed" above five rows has been told
 * something false by arithmetic nobody reviewed.
 *
 * WHAT IT REFUSES TO DECIDE
 * Whether a change is good, bad, expected or worth acting on. `02` forbids a score and forbids
 * ranking by risk; a comparison that sorted by "most concerning" would be both. The output is
 * four buckets in a fixed order and a magnitude, and the magnitude is arithmetic on two numbers
 * the source reported. Nothing here reads a reference interval, and nothing here decides that a
 * value is normal - a reference interval is a fact the *report* carries, presented beside the
 * change, never folded into it (DEC-155).
 *
 * A value that is absent now is `NOT_REPEATED`, which is deliberately not called "missing" and
 * deliberately not called "removed": an absence is not a result, and Kynviora does not know why a
 * test was not repeated.
 */

import { ownEntry } from './lookup.js';

/**
 * How two records are being compared, which is the only thing that moves the threshold.
 *
 * `PERIODIC` is a year-on-year comparison - two annual checkups, two formulations a season apart.
 * `REPEAT` is a short-interval re-test, where the same analyte is measured again within weeks
 * because somebody wanted to see it again.
 *
 * The distinction is not cosmetic. Biological and assay variation over twelve months swallows
 * small differences that are meaningful over three weeks, so one threshold across both would
 * either call ordinary annual drift a change or hide a real move in a deliberate repeat.
 */
export const CHANGE_INTERVALS = ['PERIODIC', 'REPEAT'] as const;
export type ChangeInterval = (typeof CHANGE_INTERVALS)[number];

/**
 * The fraction of the earlier value a difference must exceed to be called a change.
 *
 * A tenth and a twentieth, exactly as the design language states them on screen. Kept as data so
 * the sentence a screen prints and the arithmetic a count uses come from the same constant - the
 * failure mode otherwise is a screen that says "a tenth" beside counts computed from something
 * else, which is worse than no sentence at all.
 */
export const CHANGE_THRESHOLDS: Readonly<Record<ChangeInterval, number>> = Object.freeze({
  PERIODIC: 0.1,
  REPEAT: 0.05,
});

/** Plain-language statements of the rule, for the screen that must show it. */
export const CHANGE_THRESHOLD_STATEMENTS: Readonly<Record<ChangeInterval, string>> = Object.freeze({
  PERIODIC: 'Changed means the value moved by more than a tenth of the earlier one.',
  REPEAT: 'Changed means the value moved by more than a twentieth of the earlier one.',
});

/**
 * Which bucket a comparison fell into.
 *
 * Ordered as the design language orders the sections, because the order is part of the answer:
 * what moved, what is new, what was not repeated, and - collapsed - what did not move.
 */
export const CHANGE_CLASSES = ['CHANGED', 'NEW', 'NOT_REPEATED', 'SIMILAR'] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

/** Which way a numeric value moved. `NONE` covers both "did not move" and "not numeric". */
export const CHANGE_DIRECTIONS = ['UP', 'DOWN', 'NONE'] as const;
export type ChangeDirection = (typeof CHANGE_DIRECTIONS)[number];

/**
 * One thing being compared across two records.
 *
 * `current` and `previous` are `null` when that side did not carry the entry at all, which is the
 * difference between `NEW`/`NOT_REPEATED` and a value that happens to be zero. A numeric value is
 * `number | null`; a value the source gave as text (`'Not detected'`, `'Trace'`) carries `text`
 * instead, and text is compared by equality because no arithmetic is defensible on it.
 */
export interface ComparableValue {
  /** The measured number, or `null` where the source gave text rather than a quantity. */
  readonly value: number | null;
  /** The source's own rendering, used when `value` is `null` and for display. */
  readonly text?: string;
  /** Unit as the source stated it. A unit change makes a pair incomparable (see below). */
  readonly unit?: string;
}

export interface ComparableEntry {
  /** Stable identity of the thing measured - an analyte code, an ingredient, a capability. */
  readonly key: string;
  /** What to call it on screen. */
  readonly label: string;
  readonly current: ComparableValue | null;
  readonly previous: ComparableValue | null;
}

/**
 * The verdict on one entry.
 *
 * `delta` and `relative` are `null` whenever arithmetic was not possible or not defensible: a
 * text value, a missing side, a previous value of zero (every change from zero is infinite, which
 * is a fact about division rather than about the measurement), or two different units.
 */
export interface ChangeEntry {
  readonly key: string;
  readonly label: string;
  readonly classification: ChangeClass;
  readonly current: ComparableValue | null;
  readonly previous: ComparableValue | null;
  readonly delta: number | null;
  /** `delta` as a fraction of the previous value. What the threshold is applied to. */
  readonly relative: number | null;
  readonly direction: ChangeDirection;
  /**
   * Why arithmetic was not done, where it was not.
   *
   * Present so a screen can say "the unit changed" rather than silently showing no delta, which
   * reads as "nothing moved". `18`: an absence has to be legible as an absence.
   */
  readonly incomparableReason?: IncomparableReason;
}

export const INCOMPARABLE_REASONS = [
  'UNIT_CHANGED',
  'NOT_NUMERIC',
  'PREVIOUS_ZERO',
  'ONE_SIDE_ONLY',
] as const;
export type IncomparableReason = (typeof INCOMPARABLE_REASONS)[number];

/**
 * The whole comparison: every entry, and the counts a screen prints above them.
 *
 * The counts are derived here rather than by the caller. That is the entire point of the module -
 * a caller that filtered the list itself could produce a heading that disagrees with the rows
 * under it.
 */
export interface ChangeSummary {
  readonly interval: ChangeInterval;
  readonly thresholdStatement: string;
  readonly entries: readonly ChangeEntry[];
  readonly counts: Readonly<Record<ChangeClass, number>>;
  /** Entries present on both sides, whether or not they moved. The denominator on screen. */
  readonly comparedCount: number;
  /**
   * Entries whose pair could not be compared arithmetically but which are present on both sides.
   *
   * Surfaced separately because "we compared 20 and 4 moved" is a different claim from "we
   * compared 20, 4 moved, and 2 of the 20 could not be compared at all".
   */
  readonly incomparableCount: number;
}

function isBlank(value: ComparableValue | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return value.value === null && (value.text === undefined || value.text.trim() === '');
}

/**
 * Compare one pair.
 *
 * Exported because a detail screen shows one analyte and should not have to build a whole summary
 * to learn whether that one moved - and because doing it any other way is how two surfaces come
 * to disagree.
 */
export function classifyChange(entry: ComparableEntry, interval: ChangeInterval): ChangeEntry {
  const { key, label, current, previous } = entry;
  const base = { key, label, current, previous } as const;

  const hasCurrent = !isBlank(current);
  const hasPrevious = !isBlank(previous);

  if (hasCurrent && !hasPrevious) {
    return { ...base, classification: 'NEW', delta: null, relative: null, direction: 'NONE' };
  }
  if (!hasCurrent && hasPrevious) {
    return {
      ...base,
      classification: 'NOT_REPEATED',
      delta: null,
      relative: null,
      direction: 'NONE',
    };
  }
  if (!hasCurrent && !hasPrevious) {
    // Neither side carried it. Not a change, not new, not withheld - nothing at all. It is
    // reported as SIMILAR rather than dropped, because a caller that passed a key deserves an
    // entry back for it; silently shortening the list is how a count loses a row.
    return {
      ...base,
      classification: 'SIMILAR',
      delta: null,
      relative: null,
      direction: 'NONE',
      incomparableReason: 'ONE_SIDE_ONLY',
    };
  }

  // Both sides present. `current` and `previous` are non-null here, but the compiler does not
  // know that from `isBlank`, so they are read through locals rather than asserted.
  const now = current as ComparableValue;
  const before = previous as ComparableValue;

  if (now.unit !== before.unit) {
    // A change of unit is not a change of value, and dividing across one invents a number. mg/L
    // to µmol/L is the common case and the conversion needs a molar mass this package does not
    // have and must not guess.
    return {
      ...base,
      classification: 'CHANGED',
      delta: null,
      relative: null,
      direction: 'NONE',
      incomparableReason: 'UNIT_CHANGED',
    };
  }

  if (now.value === null || before.value === null) {
    // At least one side is text. Equality is the only defensible comparison.
    const same = (now.text ?? '') === (before.text ?? '') && now.value === before.value;
    return {
      ...base,
      classification: same ? 'SIMILAR' : 'CHANGED',
      delta: null,
      relative: null,
      direction: 'NONE',
      incomparableReason: 'NOT_NUMERIC',
    };
  }

  const delta = now.value - before.value;
  const direction: ChangeDirection = delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : 'NONE';

  if (before.value === 0) {
    // Every move away from zero is an infinite relative change, which says nothing. The absolute
    // delta is still real and is reported; the classification falls back to "did it move at all".
    return {
      ...base,
      classification: delta === 0 ? 'SIMILAR' : 'CHANGED',
      delta,
      relative: null,
      direction,
      incomparableReason: 'PREVIOUS_ZERO',
    };
  }

  const relative = delta / Math.abs(before.value);
  const threshold = ownEntry(CHANGE_THRESHOLDS, interval) ?? CHANGE_THRESHOLDS.PERIODIC;
  return {
    ...base,
    classification: Math.abs(relative) > threshold ? 'CHANGED' : 'SIMILAR',
    delta,
    relative,
    direction,
  };
}

/**
 * Compare two records and produce the counts a screen prints.
 *
 * Entry order is preserved from the input. Sorting by magnitude was considered and rejected: `02`
 * forbids ranking by risk, and "biggest mover first" is a ranking by risk wearing arithmetic.
 */
export function summarizeChange(
  entries: readonly ComparableEntry[],
  interval: ChangeInterval,
): ChangeSummary {
  const classified = entries.map((entry) => classifyChange(entry, interval));
  const counts: Record<ChangeClass, number> = {
    CHANGED: 0,
    NEW: 0,
    NOT_REPEATED: 0,
    SIMILAR: 0,
  };
  let comparedCount = 0;
  let incomparableCount = 0;
  for (const entry of classified) {
    counts[entry.classification] += 1;
    const bothSides = entry.classification === 'CHANGED' || entry.classification === 'SIMILAR';
    if (bothSides && entry.incomparableReason !== 'ONE_SIDE_ONLY') {
      comparedCount += 1;
      if (entry.relative === null) incomparableCount += 1;
    }
  }
  return {
    interval,
    thresholdStatement:
      ownEntry(CHANGE_THRESHOLD_STATEMENTS, interval) ?? CHANGE_THRESHOLD_STATEMENTS.PERIODIC,
    entries: classified,
    counts: Object.freeze(counts),
    comparedCount,
    incomparableCount,
  };
}

/**
 * Build comparable entries from two keyed sets, taking the union of their keys.
 *
 * The union rather than the intersection, because the intersection cannot express `NEW` or
 * `NOT_REPEATED` - and those two buckets are half of what the pattern exists to show. Key order
 * follows the current record first, then whatever only the previous one had, so a reader sees
 * this year's report in its own order with last year's leftovers after it.
 */
export function pairByKey(
  current: readonly {
    readonly key: string;
    readonly label: string;
    readonly value: ComparableValue;
  }[],
  previous: readonly {
    readonly key: string;
    readonly label: string;
    readonly value: ComparableValue;
  }[],
): readonly ComparableEntry[] {
  const previousByKey = new Map(previous.map((entry) => [entry.key, entry]));
  const seen = new Set<string>();
  const paired: ComparableEntry[] = [];

  for (const entry of current) {
    seen.add(entry.key);
    const before = previousByKey.get(entry.key);
    paired.push({
      key: entry.key,
      label: entry.label,
      current: entry.value,
      previous: before?.value ?? null,
    });
  }
  for (const entry of previous) {
    if (seen.has(entry.key)) continue;
    paired.push({ key: entry.key, label: entry.label, current: null, previous: entry.value });
  }
  return paired;
}
