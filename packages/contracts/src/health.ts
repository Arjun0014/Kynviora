/**
 * The Health record on the wire, and what a screen reads from it.
 *
 * Spec references: `13` (a client validates what it receives), `09`/`10` (a source fact and a
 * Kynviora conclusion are different things), `18` (an absence is legible as an absence), `02` (no
 * score, no ranking), DEC-153, DEC-154, DEC-155.
 *
 * WHY THE VIEWS ARE HERE AND NOT IN THE SCREEN
 * The same reason every other view in this package is: a screen that formats its own numbers is a
 * screen whose formatting can disagree with the next one's. Two surfaces showing the same lab
 * value with different precision is a small thing; two surfaces disagreeing about whether a
 * result was flagged is not, and both come from the same habit.
 *
 * WHAT A VIEW HERE WILL NOT DO
 * Sort by anything but what the server sent. `02` forbids ranking by risk, and "flagged results
 * first" is that ranking - it would put the report's own emphasis in a place the report did not,
 * and a person comparing the screen against their paper copy would find the order different.
 */

import {
  isHealthMetric,
  isHealthRecordKind,
  isSourceFlag,
  metricIsContinuouslySampled,
  sourceFlagSentence,
  type ChangeClass,
  type ChangeEntry,
  type HealthMetric,
  type HealthRecordKind,
  type ReferenceComparison,
  type SourceFlag,
} from '@kynviora/domain';

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface HealthSourceResponse {
  readonly id: string;
  readonly sourceKind: string;
  readonly displayName: string;
  readonly connectionState: string;
  readonly lastReceivedAt: string | null;
}

export interface HealthSourcesResponse {
  readonly sources: readonly HealthSourceResponse[];
}

export interface HealthRecordResponse {
  readonly id: string;
  readonly profileId: string;
  readonly kind: string;
  readonly title: string;
  readonly providerName: string | null;
  readonly recordedOn: string | null;
  readonly sourceId: string | null;
  readonly hasDocument: boolean;
  readonly extractionState: string;
  readonly provenance: string;
  readonly note: string | null;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly observationCount: number;
  readonly sourceFlaggedCount: number;
}

export interface HealthRecordsResponse {
  readonly records: readonly HealthRecordResponse[];
}

export interface HealthObservationResponse {
  readonly id: string;
  readonly analyteCode: string;
  readonly displayName: string;
  readonly sequence: number;
  readonly valueNumeric: number | null;
  readonly valueText: string | null;
  readonly unit: string | null;
  readonly decimals: number;
  readonly reference: {
    readonly low: number | null;
    readonly high: number | null;
    readonly text: string | null;
  } | null;
  readonly referenceComparison: string;
  readonly sourceFlag: string | null;
}

export interface HealthRecordDetailResponse {
  readonly record: HealthRecordResponse;
  readonly observations: readonly HealthObservationResponse[];
}

export interface HealthComparisonResponse {
  readonly current: HealthRecordResponse;
  readonly previous: HealthRecordResponse | null;
  readonly comparison: {
    readonly interval: string;
    readonly thresholdStatement: string;
    readonly counts: Readonly<Record<string, number>>;
    readonly comparedCount: number;
    readonly incomparableCount: number;
    readonly entries: readonly ChangeEntry[];
  } | null;
}

export interface HealthMeasurementResponse {
  readonly id: string;
  readonly metric: string;
  readonly measuredAt: string;
  readonly value: number;
  readonly secondary: number | null;
  readonly unit: string;
  readonly sourceId: string | null;
  readonly deviceName: string | null;
}

export interface HealthMeasurementsResponse {
  readonly measurements: readonly HealthMeasurementResponse[];
}

export interface HealthTimelineEntryResponse {
  readonly entryKind: string;
  readonly entryId: string;
  readonly occurredAt: string;
  readonly title: string;
  readonly detail: string | null;
}

export interface HealthTimelineResponse {
  readonly entries: readonly HealthTimelineEntryResponse[];
}

// ---------------------------------------------------------------------------
// Narrowing what arrived
// ---------------------------------------------------------------------------

/**
 * The reference comparisons, narrowed.
 *
 * A value this build does not recognise becomes `NOT_COMPARABLE` rather than being rendered as
 * itself. That is the only safe fallback: a screen printing an unknown enum member beside a lab
 * value would be showing a person a word nobody wrote.
 */
const KNOWN_COMPARISONS: readonly ReferenceComparison[] = [
  'WITHIN',
  'OUTSIDE_ABOVE',
  'OUTSIDE_BELOW',
  'NO_INTERVAL',
  'NOT_COMPARABLE',
];

function asReferenceComparison(value: string): ReferenceComparison {
  return (KNOWN_COMPARISONS as readonly string[]).includes(value)
    ? (value as ReferenceComparison)
    : 'NOT_COMPARABLE';
}

// ---------------------------------------------------------------------------
// The Records layer
// ---------------------------------------------------------------------------

/**
 * What a screen renders per record.
 *
 * `kind` may be `null` where the server sent a kind this build does not know: the record is still
 * shown, because hiding a person's record because a client is out of date is worse than showing
 * it without a category. `kindLabel` then falls back to the record's own title context.
 */
export interface HealthRecordLineView {
  readonly id: string;
  readonly kind: HealthRecordKind | null;
  readonly kindLabel: string;
  readonly title: string;
  readonly providerName: string | null;
  readonly recordedOn: string | null;
  readonly observationCount: number;
  readonly sourceFlaggedCount: number;
  readonly hasDocument: boolean;
  /**
   * Whether the structured results have been checked by a person.
   *
   * `04` Phase 1.3. When false, a screen says so beside the results rather than presenting them
   * as settled.
   */
  readonly resultsAreConfirmed: boolean;
  /** One sentence about how this record came to exist. Always rendered. */
  readonly provenanceSentence: string;
  readonly accessibilityLabel: string;
}

const RECORD_KIND_LABELS: Readonly<Record<HealthRecordKind, string>> = Object.freeze({
  LAB_REPORT: 'Lab report',
  ANNUAL_CHECKUP: 'Annual health check',
  CLINICAL_LETTER: 'Clinical letter',
  IMAGING_REPORT: 'Imaging report',
  VACCINATION: 'Vaccination',
  PROCEDURE: 'Procedure',
  PRESCRIPTION: 'Prescription',
  DISCHARGE_SUMMARY: 'Discharge summary',
  OTHER_DOCUMENT: 'Document',
});

/**
 * How this record got here, in one sentence.
 *
 * The extraction state and the provenance are two different facts and the sentence carries both,
 * because "read from a photograph and not yet checked" and "typed in by a caregiver" are the two
 * halves of what a person needs to know before trusting a number on this screen.
 */
const EXTRACTION_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  NOT_EXTRACTED: 'The document is on file. Nothing has been read out of it.',
  EXTRACTION_PENDING: 'The document is on file. Reading it has not finished.',
  EXTRACTED_UNCONFIRMED: 'Read from the document and not yet checked by anyone.',
  EXTRACTED_CONFIRMED: 'Read from the document and checked.',
  EXTRACTION_FAILED: 'The document is on file. It could not be read.',
  ENTERED_BY_HAND: 'Typed in by hand.',
});

const PROVENANCE_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  USER_REPORTED: 'Recorded by the person this record is about.',
  CAREGIVER_ENTERED: 'Recorded by a caregiver.',
  IMPORTED: 'Imported from a source.',
  REVIEWER_CONFIRMED: 'Confirmed by a Kynviora reviewer.',
});

function ownSentence(table: Readonly<Record<string, string>>, key: string): string | null {
  // DEC-147: an own-property read, so a value that arrived over the wire and happens to spell
  // `constructor` cannot come back as a function and be printed beside somebody's lab result.
  return Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}

export function healthRecordLineView(record: HealthRecordResponse): HealthRecordLineView {
  const kind = isHealthRecordKind(record.kind) ? record.kind : null;
  const kindLabel = kind === null ? 'Record' : RECORD_KIND_LABELS[kind];
  const extraction = ownSentence(EXTRACTION_SENTENCES, record.extractionState);
  const provenance = ownSentence(PROVENANCE_SENTENCES, record.provenance);

  // Both sentences where both are known, and an honest admission where neither is. An empty
  // provenance line would read as "no need to ask", which is the opposite of what it means.
  const provenanceSentence =
    extraction === null && provenance === null
      ? 'How this record was added is not recorded.'
      : [extraction, provenance].filter((s): s is string => s !== null).join(' ');

  const resultsAreConfirmed =
    record.extractionState === 'EXTRACTED_CONFIRMED' ||
    record.extractionState === 'ENTERED_BY_HAND';

  const counted = record.observationCount === 1 ? '1 result' : `${record.observationCount} results`;
  const flagged =
    record.sourceFlaggedCount === 0
      ? ''
      : ` ${record.sourceFlaggedCount} flagged by the source report.`;

  return {
    id: record.id,
    kind,
    kindLabel,
    title: record.title,
    providerName: record.providerName,
    recordedOn: record.recordedOn,
    observationCount: record.observationCount,
    sourceFlaggedCount: record.sourceFlaggedCount,
    hasDocument: record.hasDocument,
    resultsAreConfirmed,
    provenanceSentence,
    accessibilityLabel:
      `${kindLabel}. ${record.title}.` +
      `${record.recordedOn === null ? ' No date recorded.' : ` ${record.recordedOn}.`}` +
      ` ${counted}.${flagged}`,
  };
}

// ---------------------------------------------------------------------------
// One result
// ---------------------------------------------------------------------------

export interface HealthObservationView {
  readonly id: string;
  readonly analyteCode: string;
  readonly displayName: string;
  /** The value as the report printed it, unit included. Never padded. */
  readonly valueText: string;
  /**
   * The number itself, for a component that has to place a mark on a band.
   *
   * Beside `valueText` rather than instead of it: the string is what a person reads and the number
   * is what a chart positions, and deriving one from the other at the drawing site is how a
   * rendered value comes to differ from the one announced.
   */
  readonly valueNumeric: number | null;
  readonly unit: string | null;
  readonly reference: {
    readonly low: number | null;
    readonly high: number | null;
    readonly text: string | null;
  } | null;
  /** The interval the report gave, as one line, or null where it gave none. */
  readonly referenceText: string | null;
  readonly referenceComparison: ReferenceComparison;
  /** Whether the value sits outside the interval **the report printed**. Never "abnormal". */
  readonly outsideReportedInterval: boolean;
  readonly sourceFlag: SourceFlag | null;
  /** "Flagged high by the source report", or null. The subject is always the report. */
  readonly sourceFlagSentence: string | null;
  readonly accessibilityLabel: string;
}

/**
 * Print a number the **report** printed, at exactly the precision it printed it.
 *
 * `decimals` is how many places the source used, so a lab that printed `4.0` gets `4.0` back.
 * Trimming the trailing zero would misquote the report - which is a different mistake from the
 * one `trim` in `@kynviora/presentation` avoids, and the two rules point opposite ways for a
 * reason worth stating:
 *
 *   a **quoted** number is printed at the source's own precision, because it is a quotation;
 *   a **computed** number is printed without padding, because Kynviora has no precision to claim.
 *
 * So a value and a reference bound are padded here, and a delta is not padded there.
 */
function quote(value: number, decimals: number): string {
  return value.toFixed(Math.max(0, Math.min(decimals, 6)));
}

function referenceLine(
  reference: HealthObservationResponse['reference'],
  unit: string | null,
  decimals: number,
): string | null {
  if (reference === null) return null;
  if (reference.text !== null && reference.text.trim() !== '') return reference.text;
  const suffix = unit === null || unit === '' ? '' : ` ${unit}`;
  if (reference.low !== null && reference.high !== null) {
    return `${quote(reference.low, decimals)} – ${quote(reference.high, decimals)}${suffix}`;
  }
  if (reference.high !== null) return `Up to ${quote(reference.high, decimals)}${suffix}`;
  if (reference.low !== null) return `From ${quote(reference.low, decimals)}${suffix}`;
  return null;
}

export function healthObservationView(
  observation: HealthObservationResponse,
): HealthObservationView {
  const comparison = asReferenceComparison(observation.referenceComparison);
  const unitSuffix =
    observation.unit === null || observation.unit === '' ? '' : ` ${observation.unit}`;
  const valueText =
    observation.valueNumeric === null
      ? (observation.valueText ?? '—')
      : `${quote(observation.valueNumeric, observation.decimals)}${unitSuffix}`;

  const flag = isSourceFlag(observation.sourceFlag) ? observation.sourceFlag : null;
  const referenceText = referenceLine(
    observation.reference,
    observation.unit,
    observation.decimals,
  );

  // Announced in the order `18` asks for. The interval is described as the report's, in words, so
  // a screen-reader user hears whose statement it is rather than a bare range.
  const parts = [`${observation.displayName}. ${valueText}.`];
  if (referenceText !== null) parts.push(`This report gives a range of ${referenceText}.`);
  else parts.push('This report gave no range.');
  if (comparison === 'OUTSIDE_ABOVE') parts.push('Above the range this report gave.');
  if (comparison === 'OUTSIDE_BELOW') parts.push('Below the range this report gave.');
  if (flag !== null) parts.push(`${sourceFlagSentence(flag)}.`);

  return {
    id: observation.id,
    analyteCode: observation.analyteCode,
    displayName: observation.displayName,
    valueText,
    valueNumeric: observation.valueNumeric,
    unit: observation.unit,
    reference: observation.reference,
    referenceText,
    referenceComparison: comparison,
    outsideReportedInterval: comparison === 'OUTSIDE_ABOVE' || comparison === 'OUTSIDE_BELOW',
    sourceFlag: flag,
    sourceFlagSentence: flag === null ? null : sourceFlagSentence(flag),
    accessibilityLabel: parts.join(' '),
  };
}

// ---------------------------------------------------------------------------
// The Trends layer
// ---------------------------------------------------------------------------

export interface HealthTrendPointView {
  readonly id: string;
  readonly measuredAt: string;
  readonly value: number;
  readonly secondary: number | null;
  readonly deviceName: string | null;
}

export interface HealthTrendView {
  readonly metric: HealthMetric | null;
  readonly label: string;
  readonly unit: string;
  readonly points: readonly HealthTrendPointView[];
  /**
   * Whether a line between two points is honest for this metric.
   *
   * A connecting line asserts the quantity took the intermediate values. Between a weight in March
   * and a weight in September nobody measured whether it did, so the chart draws points.
   */
  readonly connectPoints: boolean;
  readonly latestText: string | null;
  /**
   * The largest gap between two consecutive readings, in days, or null where there are fewer
   * than two.
   *
   * On screen so a gap is *stated* as well as drawn: "the line breaks, the span is hatched, and
   * the legend says what happened". A gap nobody names is one somebody reads over.
   */
  readonly largestGapDays: number | null;
  readonly accessibilityLabel: string;
}

const METRIC_LABELS: Readonly<Record<HealthMetric, string>> = Object.freeze({
  HEART_RATE: 'Heart rate',
  RESTING_HEART_RATE: 'Resting heart rate',
  HEART_RATE_VARIABILITY: 'Heart rate variability',
  BLOOD_PRESSURE: 'Blood pressure',
  OXYGEN_SATURATION: 'Blood oxygen',
  BODY_TEMPERATURE: 'Temperature',
  BODY_WEIGHT: 'Weight',
  BLOOD_GLUCOSE: 'Blood glucose',
  SLEEP_DURATION: 'Sleep',
  STEPS: 'Steps',
  RESPIRATORY_RATE: 'Breathing rate',
});

const DAY_MS = 86_400_000;

export function healthTrendView(
  metricName: string,
  measurements: readonly HealthMeasurementResponse[],
): HealthTrendView {
  const metric = isHealthMetric(metricName) ? metricName : null;
  const label = metric === null ? 'Measurement' : METRIC_LABELS[metric];
  const points = measurements.map((m) => ({
    id: m.id,
    measuredAt: m.measuredAt,
    value: m.value,
    secondary: m.secondary,
    deviceName: m.deviceName,
  }));

  const unit = measurements[0]?.unit ?? '';
  const latest = points[points.length - 1];
  const latestText =
    latest === undefined
      ? null
      : latest.secondary === null
        ? `${String(Math.round(latest.value * 10) / 10)} ${unit}`.trim()
        : `${String(Math.round(latest.value))}/${String(Math.round(latest.secondary))} ${unit}`.trim();

  let largestGapDays: number | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const before = Date.parse(points[i - 1]?.measuredAt ?? '');
    const after = Date.parse(points[i]?.measuredAt ?? '');
    if (Number.isNaN(before) || Number.isNaN(after)) continue;
    const gap = Math.round((after - before) / DAY_MS);
    largestGapDays = largestGapDays === null ? gap : Math.max(largestGapDays, gap);
  }

  return {
    metric,
    label,
    unit,
    points,
    connectPoints: metric !== null && metricIsContinuouslySampled(metric),
    latestText,
    largestGapDays,
    accessibilityLabel:
      points.length === 0
        ? `${label}. No readings recorded.`
        : `${label}. ${points.length} ${points.length === 1 ? 'reading' : 'readings'}. Most recent ${latestText ?? ''}.`,
  };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

export interface HealthComparisonView {
  readonly currentTitle: string;
  readonly previousTitle: string | null;
  /** The sentence stating what "changed" means here, from the server's own rule. */
  readonly thresholdStatement: string;
  readonly counts: Readonly<Record<ChangeClass, number>>;
  readonly comparedCount: number;
  readonly incomparableCount: number;
  readonly entries: readonly ChangeEntry[];
  /**
   * Why there is no comparison, where there is none.
   *
   * A sentence rather than an absence, because an empty comparison screen reads as "nothing
   * changed" and the truth is "there is nothing to compare this with".
   */
  readonly unavailableReason: string | null;
}

const EMPTY_COUNTS: Readonly<Record<ChangeClass, number>> = Object.freeze({
  CHANGED: 0,
  NEW: 0,
  NOT_REPEATED: 0,
  SIMILAR: 0,
});

export function healthComparisonView(response: HealthComparisonResponse): HealthComparisonView {
  if (response.comparison === null || response.previous === null) {
    return {
      currentTitle: response.current.title,
      previousTitle: null,
      thresholdStatement: '',
      counts: EMPTY_COUNTS,
      comparedCount: 0,
      incomparableCount: 0,
      entries: [],
      unavailableReason:
        'There is no earlier record of this kind sharing any of these results, so there is nothing to compare this with yet.',
    };
  }

  const counts: Record<ChangeClass, number> = { ...EMPTY_COUNTS };
  for (const key of ['CHANGED', 'NEW', 'NOT_REPEATED', 'SIMILAR'] as const) {
    counts[key] = response.comparison.counts[key] ?? 0;
  }

  return {
    currentTitle: response.current.title,
    previousTitle: response.previous.title,
    thresholdStatement: response.comparison.thresholdStatement,
    counts,
    comparedCount: response.comparison.comparedCount,
    incomparableCount: response.comparison.incomparableCount,
    // The server's order, unchanged. `02` forbids ranking, and "biggest mover first" is one.
    entries: response.comparison.entries,
    unavailableReason: null,
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface HealthSourceView {
  readonly id: string;
  readonly displayName: string;
  readonly stateLabel: string;
  readonly stateSentence: string;
  /** Whether this source is offering anything at all. False for every honest empty state. */
  readonly isLive: boolean;
  readonly lastReceivedAt: string | null;
  readonly accessibilityLabel: string;
}

/**
 * Six honest states, each with a word and a sentence.
 *
 * `DESIGNED_NOT_IMPLEMENTED` is the one the V3 brief asks for by name, and its sentence says
 * plainly that the integration does not exist rather than inviting a connection nothing would
 * answer.
 */
const SOURCE_STATE_COPY: Readonly<
  Record<string, { readonly label: string; readonly sentence: string; readonly live: boolean }>
> = Object.freeze({
  CONNECTED: {
    label: 'Connected',
    sentence: 'This source is sending data to Kynviora.',
    live: true,
  },
  MANUAL: {
    label: 'By hand',
    sentence: 'Readings from this source are entered by hand.',
    live: true,
  },
  IMPORTED_ONCE: {
    label: 'Imported once',
    sentence: 'This was imported once. It is not a live connection and will not update itself.',
    live: false,
  },
  STALE: {
    label: 'Nothing recently',
    sentence:
      'Nothing has arrived from this source for a while. That is not the same as nothing having happened.',
    live: false,
  },
  NOT_CONNECTED: {
    label: 'Not connected',
    sentence: 'Nothing is connected here.',
    live: false,
  },
  PERMISSION_REMOVED: {
    label: 'Permission removed',
    sentence: 'Permission for this source was removed, so nothing new can arrive.',
    live: false,
  },
  DESIGNED_NOT_IMPLEMENTED: {
    label: 'Designed, not built',
    sentence: 'Kynviora has designed this connection and has not built it. Nothing connects yet.',
    live: false,
  },
});

export function healthSourceView(source: HealthSourceResponse): HealthSourceView {
  const copy = Object.hasOwn(SOURCE_STATE_COPY, source.connectionState)
    ? SOURCE_STATE_COPY[source.connectionState]
    : undefined;
  const label = copy?.label ?? 'Unknown';
  const sentence = copy?.sentence ?? 'Kynviora does not recognise the state of this source.';
  return {
    id: source.id,
    displayName: source.displayName,
    stateLabel: label,
    stateSentence: sentence,
    // An unrecognised state is never live. Anything else would render an unknown as a connection.
    isLive: copy?.live ?? false,
    lastReceivedAt: source.lastReceivedAt,
    accessibilityLabel: `${source.displayName}. ${label}. ${sentence}`,
  };
}

// ---------------------------------------------------------------------------
// The History layer
// ---------------------------------------------------------------------------

export interface HealthTimelineEntryView {
  readonly entryKind: string;
  readonly entryId: string;
  readonly occurredAt: string;
  readonly title: string;
  readonly kindLabel: string;
  readonly detail: string | null;
  readonly accessibilityLabel: string;
}

const TIMELINE_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  RECORD: 'Record',
  ALLERGY: 'Allergy or sensitivity',
  CONDITION: 'Condition',
  SOURCE: 'Source',
});

export function healthTimelineEntryView(
  entry: HealthTimelineEntryResponse,
): HealthTimelineEntryView {
  const kindLabel = Object.hasOwn(TIMELINE_KIND_LABELS, entry.entryKind)
    ? (TIMELINE_KIND_LABELS[entry.entryKind] ?? 'Entry')
    : 'Entry';
  return {
    entryKind: entry.entryKind,
    entryId: entry.entryId,
    occurredAt: entry.occurredAt,
    title: entry.title,
    kindLabel,
    detail: entry.detail,
    accessibilityLabel: `${kindLabel}. ${entry.title}.${entry.detail === null ? '' : ` ${entry.detail}.`}`,
  };
}

/**
 * The sentence Health prints about what it does and does not hold.
 *
 * The Health equivalent of the Safety screen's coverage statement, and it is on screen in every
 * state for the same reason (DEC-138): a Health screen with three records on it and nothing else
 * invites the conclusion that three records is all there is to know, and `18` will not let an
 * absence render as completeness.
 */
export const HEALTH_COVERAGE_STATEMENT =
  'Kynviora shows what has been recorded here. It is not a complete medical record, and nothing ' +
  'is added automatically from a clinic or a device.';
