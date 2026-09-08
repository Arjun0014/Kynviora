/**
 * The Health record: records, the results inside them, measurements, and where each came from.
 *
 * Spec references: `04` Phase 1.3 (no OCR or inferred fact silently becomes a confirmed record;
 * provenance is derived from who is writing, never sent), `09` (a source fact and a Kynviora
 * conclusion are different things), `10` (clinical governance), `02` (no score), `18` (an absence
 * is legible as an absence), migration `0032`, DEC-154, DEC-155.
 *
 * THE ONE RULE THIS MODULE IS ORGANISED AROUND
 * There is no function here that decides whether a value is normal, abnormal, healthy, concerning
 * or in range in any clinical sense. {@link referenceComparison} answers the only question that
 * is decidable from stored data - *is this number inside the interval the report printed* - and
 * its result type is named for that and says so in words. A screen renders "outside the interval
 * this report gave", never "high".
 *
 * The two are not the same claim and the distance between them is the whole of `10`. A value
 * outside a reference interval is a fact about arithmetic on two numbers a lab printed. "High" is
 * a clinical judgement about a person, it depends on their age, their medication, the time of
 * day, why the test was ordered, and Kynviora knows none of that.
 *
 * PROVENANCE IS DERIVED, NOT SENT
 * The same rule `healthContext.ts` states, for the same reason: {@link HealthRecordDraft} has no
 * `provenance` field and no route can carry one. It comes from `provenanceForRelationship`, which
 * can only return `USER_REPORTED` or `CAREGIVER_ENTERED`.
 */

import { ownEntry } from './lookup.js';
import { domainError, err, ok, type DomainError, type Result } from './result.js';
import {
  summarizeChange,
  pairByKey,
  type ChangeInterval,
  type ChangeSummary,
  type ComparableValue,
} from './changeLens.js';

// ---------------------------------------------------------------------------
// Vocabularies - each one transcribed from a CHECK in `0032`, asserted equal by test
// ---------------------------------------------------------------------------

/**
 * What kind of record this is.
 *
 * `ANNUAL_CHECKUP` is separate from `LAB_REPORT` because V3 gives it its own longitudinal
 * experience: a year-on-year comparison uses the `PERIODIC` threshold and a repeat panel uses
 * `REPEAT`, and the kind is what decides which - so folding the two together would silently
 * change what counts as a change.
 */
export const HEALTH_RECORD_KINDS = [
  'LAB_REPORT',
  'ANNUAL_CHECKUP',
  'CLINICAL_LETTER',
  'IMAGING_REPORT',
  'VACCINATION',
  'PROCEDURE',
  'PRESCRIPTION',
  'DISCHARGE_SUMMARY',
  'OTHER_DOCUMENT',
] as const;
export type HealthRecordKind = (typeof HEALTH_RECORD_KINDS)[number];
export function isHealthRecordKind(value: unknown): value is HealthRecordKind {
  return typeof value === 'string' && (HEALTH_RECORD_KINDS as readonly string[]).includes(value);
}

/**
 * How the structured results under a record came to exist.
 *
 * `EXTRACTED_UNCONFIRMED` is the state `04` Phase 1.3 requires to exist: something was read out
 * of a document and nobody has checked it. A screen showing one of these says so, and no rule
 * treats it as it treats a confirmed record.
 */
export const EXTRACTION_STATES = [
  'NOT_EXTRACTED',
  'EXTRACTION_PENDING',
  'EXTRACTED_UNCONFIRMED',
  'EXTRACTED_CONFIRMED',
  'EXTRACTION_FAILED',
  'ENTERED_BY_HAND',
] as const;
export type ExtractionState = (typeof EXTRACTION_STATES)[number];
export function isExtractionState(value: unknown): value is ExtractionState {
  return typeof value === 'string' && (EXTRACTION_STATES as readonly string[]).includes(value);
}

/** Whether a screen may present the structured results as settled. */
export function extractionIsConfirmed(state: ExtractionState): boolean {
  return state === 'EXTRACTED_CONFIRMED' || state === 'ENTERED_BY_HAND';
}

export const HEALTH_SOURCE_KINDS = [
  'MANUAL_ENTRY',
  'IMPORTED_DOCUMENT',
  'PROVIDER_IMPORT',
  'HEALTH_CONNECT',
  'HEALTH_KIT',
  'WEARABLE',
  'HOME_DEVICE',
] as const;
export type HealthSourceKind = (typeof HEALTH_SOURCE_KINDS)[number];
export function isHealthSourceKind(value: unknown): value is HealthSourceKind {
  return typeof value === 'string' && (HEALTH_SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * The honest states of an origin.
 *
 * `DESIGNED_NOT_IMPLEMENTED` exists because the alternative is worse: an integration that has not
 * been built rendered as an inviting empty state is a promise the app cannot keep, and a person
 * who taps it learns that by being ignored. Named, it renders as what it is.
 */
export const HEALTH_SOURCE_STATES = [
  'CONNECTED',
  'MANUAL',
  'IMPORTED_ONCE',
  'STALE',
  'NOT_CONNECTED',
  'PERMISSION_REMOVED',
  'DESIGNED_NOT_IMPLEMENTED',
] as const;
export type HealthSourceState = (typeof HEALTH_SOURCE_STATES)[number];
export function isHealthSourceState(value: unknown): value is HealthSourceState {
  return typeof value === 'string' && (HEALTH_SOURCE_STATES as readonly string[]).includes(value);
}

/**
 * The words a report may have used about one of its own results.
 *
 * Deliberately the vocabulary of *report flags* rather than of clinical severity. There is no
 * `DANGEROUS`, no `URGENT` and no `SEVERE`, because those are conclusions and this column holds a
 * quotation.
 */
export const SOURCE_FLAGS = [
  'HIGH',
  'LOW',
  'ABNORMAL',
  'CRITICAL',
  'BORDERLINE',
  'FLAGGED',
] as const;
export type SourceFlag = (typeof SOURCE_FLAGS)[number];
export function isSourceFlag(value: unknown): value is SourceFlag {
  return typeof value === 'string' && (SOURCE_FLAGS as readonly string[]).includes(value);
}

/**
 * The metrics a trend can be drawn for.
 *
 * `BLOOD_PRESSURE` is the only paired one, and {@link isPairedMetric} is the single place that
 * knows it - the schema's CHECK says the same thing, and `healthRecord.test.ts` asserts the two
 * agree, so a metric added to one and not the other fails rather than storing a half-reading.
 */
export const HEALTH_METRICS = [
  'HEART_RATE',
  'RESTING_HEART_RATE',
  'HEART_RATE_VARIABILITY',
  'BLOOD_PRESSURE',
  'OXYGEN_SATURATION',
  'BODY_TEMPERATURE',
  'BODY_WEIGHT',
  'BLOOD_GLUCOSE',
  'SLEEP_DURATION',
  'STEPS',
  'RESPIRATORY_RATE',
] as const;
export type HealthMetric = (typeof HEALTH_METRICS)[number];
export function isHealthMetric(value: unknown): value is HealthMetric {
  return typeof value === 'string' && (HEALTH_METRICS as readonly string[]).includes(value);
}

/** Whether a metric is a pair of numbers taken together. */
export function isPairedMetric(metric: HealthMetric): boolean {
  return metric === 'BLOOD_PRESSURE';
}

/**
 * Whether a metric is sampled often enough that a solid line between two points is honest.
 *
 * The design language states the rule and it belongs here rather than in a chart component:
 * "wearable trends get solid lines because they are sampled continuously; labs never do". A
 * connecting line asserts that the quantity took the intermediate values, and between a weight in
 * March and a weight in September it did not - or rather, nobody measured whether it did.
 */
export function metricIsContinuouslySampled(metric: HealthMetric): boolean {
  return (
    metric === 'HEART_RATE' ||
    metric === 'RESTING_HEART_RATE' ||
    metric === 'HEART_RATE_VARIABILITY' ||
    metric === 'STEPS' ||
    metric === 'SLEEP_DURATION'
  );
}

// ---------------------------------------------------------------------------
// The reference interval, and the sentence it licenses
// ---------------------------------------------------------------------------

/**
 * A reference interval exactly as a report gave it.
 *
 * All three fields optional and all three kept. A report that printed `< 5.0` gives `text` and no
 * bounds; parsing that string into `high: 5` would produce a number the lab did not report and a
 * lower bound of zero that it certainly did not.
 */
export interface ReferenceInterval {
  readonly low: number | null;
  readonly high: number | null;
  readonly text: string | null;
}

/**
 * Where a value sits relative to the interval the report gave.
 *
 * The names are the point. `OUTSIDE_ABOVE` and `OUTSIDE_BELOW` describe a position on a number
 * line; `HIGH` and `LOW` would describe a person. `NO_INTERVAL` is a first-class answer and is
 * the most common one for anything hand-entered.
 */
export const REFERENCE_COMPARISONS = [
  'WITHIN',
  'OUTSIDE_ABOVE',
  'OUTSIDE_BELOW',
  'NO_INTERVAL',
  'NOT_COMPARABLE',
] as const;
export type ReferenceComparison = (typeof REFERENCE_COMPARISONS)[number];

/**
 * Compare a value with the interval the report printed.
 *
 * Returns `NOT_COMPARABLE` for a text result or an interval that is only text: a report saying
 * `Negative` against a range of `Negative` is a match a person can see and not one arithmetic can
 * make, and guessing would be the first step towards Kynviora deciding what a result means.
 *
 * `NO_INTERVAL` when the report gave neither bound. That is not "fine" and not "unknown risk" -
 * it is the plain fact that this report did not print a range, and the screen says exactly that.
 */
export function referenceComparison(
  value: number | null,
  interval: ReferenceInterval | null,
): ReferenceComparison {
  if (interval === null) return 'NO_INTERVAL';
  if (interval.low === null && interval.high === null) {
    return interval.text === null || interval.text.trim() === '' ? 'NO_INTERVAL' : 'NOT_COMPARABLE';
  }
  if (value === null) return 'NOT_COMPARABLE';
  // Bounds are inclusive. A lab printing `0.4 - 4.0` means 4.0 is within it; treating the bound
  // as exclusive would place a value the report considers normal outside its own range.
  if (interval.high !== null && value > interval.high) return 'OUTSIDE_ABOVE';
  if (interval.low !== null && value < interval.low) return 'OUTSIDE_BELOW';
  return 'WITHIN';
}

// ---------------------------------------------------------------------------
// Freshness of a source
// ---------------------------------------------------------------------------

/**
 * Whether a source has gone quiet for longer than its own nature allows.
 *
 * Per-source rather than one global window, because "stale" means different things for a scale
 * and for an annual blood panel. A source with no `staleAfterMs` is one for which the question is
 * not meaningful - an imported document does not go stale, it simply is what it was.
 *
 * Returns `null` where the question does not apply, so a caller cannot read "false" as "fresh".
 */
export function sourceHasGoneQuiet(
  source: {
    readonly lastReceivedAt: string | null;
    readonly staleAfterMs: number | null;
  },
  nowMs: number,
): boolean | null {
  if (source.staleAfterMs === null) return null;
  if (source.lastReceivedAt === null) return null;
  const last = Date.parse(source.lastReceivedAt);
  if (Number.isNaN(last)) return null;
  return nowMs - last > source.staleAfterMs;
}

// ---------------------------------------------------------------------------
// Drafting a record
// ---------------------------------------------------------------------------

export const HEALTH_RECORD_TITLE_MAX = 200;
export const HEALTH_RECORD_PROVIDER_MAX = 200;
export const HEALTH_RECORD_NOTE_MAX = 2000;
export const ANALYTE_CODE_MAX = 64;
export const ANALYTE_NAME_MAX = 200;

/**
 * What a client may send when recording a health record.
 *
 * No `provenance` and no `extractionState`: the first is derived from who is writing, and the
 * second from how the record was made. A client that could send either could claim a document was
 * confirmed by a reviewer, which is the claim `04` Phase 1.3 exists to prevent.
 */
export interface HealthRecordDraft {
  readonly kind: HealthRecordKind;
  readonly title: string;
  readonly providerName: string | null;
  /** `YYYY-MM-DD`, or null where the record does not state one. */
  readonly recordedOn: string | null;
  readonly sourceId: string | null;
  readonly note: string | null;
  readonly observations: readonly HealthObservationDraft[];
}

export interface HealthObservationDraft {
  readonly analyteCode: string;
  readonly displayName: string;
  readonly valueNumeric: number | null;
  readonly valueText: string | null;
  readonly unit: string | null;
  readonly decimals: number | null;
  readonly reference: ReferenceInterval | null;
  readonly sourceFlag: SourceFlag | null;
}

function trimmedOrNull(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, max);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate and normalise a draft.
 *
 * Every refusal is a `DomainError` with a stable code rather than a thrown string, so the API can
 * map it to a status and the client can say which field to correct (`13`, `12`).
 */
export function normalizeHealthRecordDraft(
  draft: HealthRecordDraft,
): Result<HealthRecordDraft, DomainError> {
  if (!isHealthRecordKind(draft.kind)) {
    return err(domainError('VALIDATION_FAILED', 'Unknown record kind.', { field: 'kind' }));
  }
  const title = trimmedOrNull(draft.title, HEALTH_RECORD_TITLE_MAX);
  if (title === null) {
    return err(domainError('VALIDATION_FAILED', 'A record needs a title.', { field: 'title' }));
  }
  if (draft.recordedOn !== null && !ISO_DATE.test(draft.recordedOn)) {
    return err(
      domainError('INVALID_DATE', 'A recorded date must be YYYY-MM-DD.', { field: 'recordedOn' }),
    );
  }

  const seen = new Set<string>();
  const observations: HealthObservationDraft[] = [];
  for (const raw of draft.observations) {
    const normalized = normalizeObservationDraft(raw);
    if (!normalized.ok) return normalized;
    const observation = normalized.value;
    if (seen.has(observation.analyteCode)) {
      // The schema refuses this too. Refusing it here as well means the caller gets a field name
      // rather than a constraint name, and gets it before a partial write.
      return err(
        domainError('VALIDATION_FAILED', 'The same result appears twice in this record.', {
          field: 'observations',
          analyteCode: observation.analyteCode,
        }),
      );
    }
    seen.add(observation.analyteCode);
    observations.push(observation);
  }

  return ok({
    kind: draft.kind,
    title,
    providerName: trimmedOrNull(draft.providerName, HEALTH_RECORD_PROVIDER_MAX),
    recordedOn: draft.recordedOn,
    sourceId: draft.sourceId,
    note: trimmedOrNull(draft.note, HEALTH_RECORD_NOTE_MAX),
    observations,
  });
}

function normalizeObservationDraft(
  draft: HealthObservationDraft,
): Result<HealthObservationDraft, DomainError> {
  const analyteCode = trimmedOrNull(draft.analyteCode, ANALYTE_CODE_MAX);
  const displayName = trimmedOrNull(draft.displayName, ANALYTE_NAME_MAX);
  if (analyteCode === null || displayName === null) {
    return err(
      domainError('VALIDATION_FAILED', 'A result needs a code and a name.', {
        field: 'observations',
      }),
    );
  }
  const valueText = trimmedOrNull(draft.valueText, ANALYTE_NAME_MAX);
  const hasNumber = draft.valueNumeric !== null && Number.isFinite(draft.valueNumeric);
  if (!hasNumber && valueText === null) {
    // A row saying a test was done and carrying no result is an absence dressed as a measurement.
    return err(
      domainError('VALIDATION_FAILED', 'A result needs a value.', {
        field: 'observations',
        analyteCode,
      }),
    );
  }
  if (draft.sourceFlag !== null && !isSourceFlag(draft.sourceFlag)) {
    return err(
      domainError('VALIDATION_FAILED', 'Unknown source flag.', {
        field: 'observations',
        analyteCode,
      }),
    );
  }
  const reference = draft.reference;
  if (
    reference !== null &&
    reference.low !== null &&
    reference.high !== null &&
    reference.low > reference.high
  ) {
    return err(
      domainError('VALIDATION_FAILED', 'A reference interval must run low to high.', {
        field: 'observations',
        analyteCode,
      }),
    );
  }
  const decimals =
    draft.decimals === null || !Number.isInteger(draft.decimals)
      ? null
      : Math.max(0, Math.min(draft.decimals, 6));

  return ok({
    analyteCode,
    displayName,
    valueNumeric: hasNumber ? draft.valueNumeric : null,
    valueText,
    unit: trimmedOrNull(draft.unit, 32),
    decimals,
    reference,
    sourceFlag: draft.sourceFlag,
  });
}

// ---------------------------------------------------------------------------
// Comparing two records
// ---------------------------------------------------------------------------

/** One result as it is stored, which is what a comparison reads. */
export interface StoredObservation {
  readonly analyteCode: string;
  readonly displayName: string;
  readonly valueNumeric: number | null;
  readonly valueText: string | null;
  readonly unit: string | null;
  readonly decimals: number | null;
  readonly reference: ReferenceInterval | null;
  readonly sourceFlag: SourceFlag | null;
}

function toComparable(observation: StoredObservation): ComparableValue {
  const value: ComparableValue = {
    value: observation.valueNumeric,
    ...(observation.valueText === null ? {} : { text: observation.valueText }),
    ...(observation.unit === null ? {} : { unit: observation.unit }),
  };
  return value;
}

/**
 * Which threshold applies when comparing two records.
 *
 * An annual check against last year's is `PERIODIC`; anything else is a `REPEAT`. The rule is
 * here rather than at each call site so the lab comparison, the checkup comparison and the
 * analyte detail cannot each decide differently and print three different counts for the same
 * pair of reports - which is the failure DEC-153 exists to prevent, arriving one level up.
 */
export function comparisonInterval(
  current: HealthRecordKind,
  previous: HealthRecordKind,
): ChangeInterval {
  return current === 'ANNUAL_CHECKUP' && previous === 'ANNUAL_CHECKUP' ? 'PERIODIC' : 'REPEAT';
}

/**
 * Compare the results in two records.
 *
 * A thin arrangement over the Change Lens, and thin on purpose: the arithmetic must not be
 * duplicated here, or a lab comparison and a formulation comparison would drift apart.
 */
export function compareHealthRecords(input: {
  readonly current: {
    readonly kind: HealthRecordKind;
    readonly observations: readonly StoredObservation[];
  };
  readonly previous: {
    readonly kind: HealthRecordKind;
    readonly observations: readonly StoredObservation[];
  };
}): ChangeSummary {
  const interval = comparisonInterval(input.current.kind, input.previous.kind);
  const asEntries = (observations: readonly StoredObservation[]) =>
    observations.map((observation) => ({
      key: observation.analyteCode,
      label: observation.displayName,
      value: toComparable(observation),
    }));
  return summarizeChange(
    pairByKey(asEntries(input.current.observations), asEntries(input.previous.observations)),
    interval,
  );
}

/**
 * How many decimal places to print a value at, given what the report printed.
 *
 * Two places when the report did not say, and never more than the report said. Padding a value
 * claims precision a lab did not report, and a screen that renders 5.2 as 5.200 is making a
 * quieter version of the same false statement a fabricated number would be.
 */
export const DEFAULT_VALUE_DECIMALS = 2;
export function decimalsFor(observation: { readonly decimals: number | null }): number {
  return observation.decimals ?? DEFAULT_VALUE_DECIMALS;
}

/**
 * The plain sentence for a source flag.
 *
 * Read through `ownEntry` (DEC-147) and phrased so the subject of every sentence is the report.
 * "Flagged high by the source report" and "High" are different claims, and only the first is
 * one Kynviora is entitled to make.
 */
const SOURCE_FLAG_SENTENCE: Readonly<Record<SourceFlag, string>> = Object.freeze({
  HIGH: 'Flagged high by the source report',
  LOW: 'Flagged low by the source report',
  ABNORMAL: 'Flagged abnormal by the source report',
  CRITICAL: 'Flagged critical by the source report',
  BORDERLINE: 'Flagged borderline by the source report',
  FLAGGED: 'Flagged by the source report',
});

export function sourceFlagSentence(flag: SourceFlag): string {
  return ownEntry(SOURCE_FLAG_SENTENCE, flag) ?? SOURCE_FLAG_SENTENCE.FLAGGED;
}
