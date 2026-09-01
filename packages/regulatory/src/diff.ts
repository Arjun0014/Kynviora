/**
 * What changed between two regulatory versions, and who changed it.
 *
 * Spec references: `04` Phase 7.4 (prior and new assessment/regulatory version; changed
 * status/conditions/source scope; changed product/formulation/batch applicability; whether user
 * action changed; correction versus new evidence/regulation - and the exit criterion "users can
 * distinguish a new regulator action from a Kynviora correction"), `09` (Evidence and Regulatory
 * Diff; no jurisdiction ranking; statuses are a list), `07` (no oversimplified single status),
 * DEC-007, DEC-016.
 *
 * THE EXIT CRITERION IS AN ATTRIBUTION, AND IT IS NEVER INFERRED
 * "A new regulator action" and "a Kynviora correction" can produce byte-identical version pairs.
 * A regulator tightening a limit and Kynviora discovering it had mis-extracted the old limit both
 * look like: new version, superseding the old, different `maxConcentrationPercent`. There is no
 * arithmetic that separates them, and a heuristic - "the effective date moved, so the regulator
 * acted" - would be wrong exactly when a correction happens to carry a new date.
 *
 * So {@link attributeChange} does not guess. It reads what was **recorded**: an
 * `assessment_correction` row says a correction happened and names its kind, and its absence
 * beside a superseding version says a new regulatory version arrived with nobody calling it a
 * correction. Where neither is recorded the answer is `NOT_STATED`, which is a member of the union
 * rather than a fallback to either side - and a screen has to say it.
 *
 * This is DEC-030's shape on a different subject: which of two readings is right is stated, not
 * derived from recency.
 *
 * THE DIFF ITSELF REACHES NO VERDICT
 * No "more restrictive", no "relaxed", no severity delta. `09` forbids value judgements about
 * jurisdictions and the same reasoning applies to two versions of one: deciding that a change is
 * a tightening requires knowing what the reader is doing with the substance, which this function
 * does not and must not know. It reports what moved.
 */

import type { ChangeAttribution, RegulatoryStatus } from '@kynviora/domain';
import type { RegulatoryConditions, RegulatoryRuleVersion } from './records.js';

// ---------------------------------------------------------------------------
// Who changed it
// ---------------------------------------------------------------------------

/**
 * Decide why what Kynviora says changed.
 *
 * The vocabulary is `@kynviora/domain`'s `CHANGE_ATTRIBUTIONS`; this module decides which member
 * applies. Four members, not two: `04`'s exit criterion names a regulator action and a Kynviora
 * correction, and there is a third that is neither - a source correcting its own publication. A
 * reader deciding whether to act needs those apart, because "the law changed", "the regulator
 * published a correction to what it said" and "we read it wrong" call for different amounts of
 * trust in what they were told before.
 */
export interface ChangeAttributionInput {
  /** The recorded correction kind, or `null` where no correction was recorded. */
  readonly correctionKind: string | null;
  /** Whether the new regulatory version supersedes an earlier one. */
  readonly supersedesEarlierVersion: boolean;
}

/**
 * Attribute a change, or refuse to.
 *
 * `SOURCE_CORRECTED` is the regulator correcting its own publication - a fact about the source,
 * not about Kynviora - so it is its own answer. Every other correction kind is Kynviora having
 * been wrong about something: its rule, the item's identity, the formulation, or a fact on the
 * profile. `WITHDRAWN_NO_LONGER_APPLICABLE` is included there deliberately: withdrawing an alert
 * because it no longer applies is Kynviora revising what it said, whatever prompted it.
 *
 * An unrecognised correction kind attributes to Kynviora, not to the regulator. The whole point of
 * the criterion is that a reader can tell when the software was wrong, and guessing "the regulator
 * acted" for a value this build does not know would be the one wrong direction.
 */
export function attributeChange(input: ChangeAttributionInput): ChangeAttribution {
  if (input.correctionKind !== null && input.correctionKind.trim() !== '') {
    return input.correctionKind === 'SOURCE_CORRECTED'
      ? 'SOURCE_CORRECTED_ITSELF'
      : 'KYNVIORA_CORRECTED_ITSELF';
  }
  // A superseding version that nobody recorded a correction against is a new regulatory version.
  // That is a recorded fact - the supersession link - not a guess about intent.
  if (input.supersedesEarlierVersion) return 'REGULATOR_ACTED';
  return 'NOT_STATED';
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/** One condition that differs, with both values and no third. */
export interface ConditionChange {
  readonly key: keyof RegulatoryConditions;
  /** Rendered as text, because a condition may be a number, a list or a sentence. */
  readonly previousValue: string | null;
  readonly currentValue: string | null;
}

export interface RegulatoryDiff {
  readonly previousVersionId: string;
  readonly currentVersionId: string;

  /** Statuses the new version establishes and the old did not. */
  readonly statusesAdded: readonly RegulatoryStatus[];
  /** Statuses the old version established and the new does not. */
  readonly statusesRemoved: readonly RegulatoryStatus[];
  readonly conditionsChanged: readonly ConditionChange[];

  /** Whether the rule moved to a different jurisdiction. Should never happen; reported if it does. */
  readonly jurisdictionChanged: boolean;
  readonly substanceChanged: boolean;
  /** `04`: "changed source scope". */
  readonly sourceChanged: boolean;
  readonly legalReferenceChanged: boolean;
  readonly publicationDateChanged: boolean;
  readonly effectiveDateChanged: boolean;

  /** Whether anything at all differs. */
  readonly anyChange: boolean;
}

const CONDITION_KEYS: readonly (keyof RegulatoryConditions)[] = Object.freeze([
  'maxConcentrationPercent',
  'minConcentrationPercent',
  'productUseTypes',
  'productCategories',
  'minimumAgeYears',
  'prohibitedRoutes',
  'requiredWarningText',
  'additionalConditions',
]);

/**
 * Render one condition value as text.
 *
 * A list is joined in its stored order rather than sorted. `09` preserves source ordering because
 * a regulator's list of prohibited routes is not a set somebody may reorder, and a diff that
 * sorted both sides would report no change where a source had reordered its own text.
 */
function conditionText(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  if (Array.isArray(value)) {
    const parts = value.map((entry) => scalarText(entry)).filter((part) => part !== null);
    // A list whose entries this function cannot render becomes an absence rather than a list of
    // "[object Object]". A condition rendered as a JavaScript artefact on a safety screen is
    // worse than one the screen reports as missing.
    return parts.length === 0 ? null : parts.join(', ');
  }

  return scalarText(value);
}

/** A scalar condition value as text, or `null` for anything that is not one. */
function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return null;
}

/**
 * Compare two regulatory versions.
 *
 * Pure, total, and reaching no verdict. The caller supplies which is which; this function does not
 * decide from the dates, because a version with no publication date is ordinary and an ordering
 * derived from a null would be an ordering derived from nothing.
 */
export function diffRegulatoryVersions(
  previous: RegulatoryRuleVersion,
  current: RegulatoryRuleVersion,
): RegulatoryDiff {
  const previousStatuses = new Set<string>(previous.statuses);
  const currentStatuses = new Set<string>(current.statuses);

  const statusesAdded = current.statuses.filter((status) => !previousStatuses.has(status));
  const statusesRemoved = previous.statuses.filter((status) => !currentStatuses.has(status));

  const conditionsChanged: ConditionChange[] = [];
  for (const key of CONDITION_KEYS) {
    const before = conditionText(previous.conditions[key]);
    const after = conditionText(current.conditions[key]);
    if (before === after) continue;
    conditionsChanged.push({ key, previousValue: before, currentValue: after });
  }

  const jurisdictionChanged = previous.jurisdiction !== current.jurisdiction;
  const substanceChanged = previous.substanceCanonicalKey !== current.substanceCanonicalKey;
  const sourceChanged = previous.sourceRegistryEntryId !== current.sourceRegistryEntryId;
  const legalReferenceChanged = previous.legalReference !== current.legalReference;
  const publicationDateChanged = previous.publicationDate !== current.publicationDate;
  const effectiveDateChanged = previous.effectiveDate !== current.effectiveDate;

  return {
    previousVersionId: previous.id,
    currentVersionId: current.id,
    statusesAdded,
    statusesRemoved,
    conditionsChanged,
    jurisdictionChanged,
    substanceChanged,
    sourceChanged,
    legalReferenceChanged,
    publicationDateChanged,
    effectiveDateChanged,
    anyChange:
      statusesAdded.length > 0 ||
      statusesRemoved.length > 0 ||
      conditionsChanged.length > 0 ||
      jurisdictionChanged ||
      substanceChanged ||
      sourceChanged ||
      legalReferenceChanged ||
      publicationDateChanged ||
      effectiveDateChanged,
  };
}

// ---------------------------------------------------------------------------
// Whether the action changed
// ---------------------------------------------------------------------------

/**
 * Whether what a person is being asked to do has changed.
 *
 * `04` Phase 7.4 lists "whether user action changed" as its own output, separately from what
 * changed in the rule - and they are genuinely separate: a regulator can narrow a concentration
 * limit without altering what the household should do about a pack they already own.
 *
 * Deliberately **not** derived from the diff. Urgency is frozen onto each assessment at evaluation
 * time and the two assessments carry it; comparing them is reading two recorded values, whereas
 * inferring "the action changed because a status was added" would be the software deciding what a
 * regulatory change means for somebody.
 */
export interface ActionChangeInput {
  readonly previousUrgency: string | null;
  readonly currentUrgency: string | null;
  readonly previousTemplateId: string | null;
  readonly currentTemplateId: string | null;
}

export interface ActionChange {
  readonly urgencyChanged: boolean;
  /** A different approved template is different wording, which is a different instruction. */
  readonly wordingChanged: boolean;
  readonly changed: boolean;
  /** True where one side is missing, so a screen can say it rather than claim no change. */
  readonly comparable: boolean;
}

export function diffUserAction(input: ActionChangeInput): ActionChange {
  const comparable =
    input.previousUrgency !== null &&
    input.currentUrgency !== null &&
    input.previousTemplateId !== null &&
    input.currentTemplateId !== null;

  const urgencyChanged = comparable && input.previousUrgency !== input.currentUrgency;
  const wordingChanged = comparable && input.previousTemplateId !== input.currentTemplateId;

  return {
    urgencyChanged,
    wordingChanged,
    changed: urgencyChanged || wordingChanged,
    comparable,
  };
}
