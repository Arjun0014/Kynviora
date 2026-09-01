/**
 * What a person did about an alert, and what stays true afterwards.
 *
 * Spec references: `04` Phase 7.6 (reviewed / not applicable; returned, disposed or quarantined
 * where relevant; discussed with a pharmacist or clinician; corrected item identity; report
 * incorrect match; a versioned Safety Receipt carrying the alert, the source and rule version, the
 * action and later corrections - with the exit criteria "resolution does not erase historical
 * assessment" and "corrections remain visible and auditable"), `09` (medication safety language),
 * `10`, `14` (append-only audit), `16` (records a person can account for).
 *
 * THE VOCABULARY HAS NO `STOPPED_MEDICINE`, AND THAT IS THE POINT
 * `09` forbids Kynviora telling anybody to start, stop or change a medicine, and a resolution
 * vocabulary is where that rule quietly fails: an outcome called "stopped taking it" would be
 * Kynviora recording that its alert produced that decision, and the next person to design a
 * screen would put it in a list beside "reviewed". Migration `0006`'s CHECK contains no such
 * member and neither does this. `RETURNED_OR_DISPOSED` and `QUARANTINED` are about a *pack* - a
 * physical object a household may deal with - and `DISCUSSED_WITH_PROFESSIONAL` is the member
 * that exists for everything clinical.
 *
 * A RESOLUTION IS A RECORD, NOT A STATE CHANGE
 * Recording one writes a `safety_receipt` row and touches nothing else. It does not withdraw the
 * alert, does not alter the assessment, and does not change what a rule concluded - those are a
 * reviewer's decisions through the staff console. That is exit criterion 1 as a shape rather than
 * as a rule somebody must remember: neither {@link SafetyReceipt} nor {@link ReceiptEntry} has a
 * field that could carry a change to either, and the API writes to neither table.
 */

/**
 * What a person can say they did.
 *
 * Mirrors `safety_receipt.resolution`'s CHECK exactly. The database is the authority and this is
 * the copy the code reads; a test in the database suite reads the constraint out of the catalog
 * and asserts the two lists are the same, so adding a member in one place fails rather than
 * silently producing a value the other refuses.
 */
export const SAFETY_RESOLUTIONS = [
  'REVIEWED',
  'NOT_APPLICABLE',
  'RETURNED_OR_DISPOSED',
  'QUARANTINED',
  'DISCUSSED_WITH_PROFESSIONAL',
  'ITEM_IDENTITY_CORRECTED',
  'REPORTED_INCORRECT_MATCH',
] as const;
export type SafetyResolution = (typeof SAFETY_RESOLUTIONS)[number];

export function isSafetyResolution(value: unknown): value is SafetyResolution {
  return typeof value === 'string' && (SAFETY_RESOLUTIONS as readonly string[]).includes(value);
}

/**
 * Resolutions that say something about Kynviora rather than about what the person did.
 *
 * `REPORTED_INCORRECT_MATCH` is feedback: it claims the alert is wrong. `ITEM_IDENTITY_CORRECTED`
 * says the person fixed what the item is, which is also a statement that Kynviora was matching
 * the wrong thing. Both are worth separating from the four that record an action, because a
 * screen that mixed them offers "I disposed of it" beside "this isn't my product" as though they
 * answered the same question.
 */
export const FEEDBACK_RESOLUTIONS: readonly SafetyResolution[] = Object.freeze([
  'REPORTED_INCORRECT_MATCH',
  'ITEM_IDENTITY_CORRECTED',
]);

export function isFeedbackResolution(resolution: SafetyResolution): boolean {
  return FEEDBACK_RESOLUTIONS.includes(resolution);
}

/**
 * ONE RECEIPT PER ALERT, AND WHERE THE SEQUENCE LIVES
 *
 * Migration `0006` puts a UNIQUE index on `safety_receipt (alert_publication_id)` and grants the
 * app role SELECT and UPDATE - not INSERT. That is a decision, and it says the receipt holds the
 * resolution that currently stands rather than a stack of them: a person who marked an alert
 * reviewed and later set the pack aside has one current answer, and the schema keeps one row for
 * it (DEC-075).
 *
 * The sequence is not lost and is not off the screen either. Every resolution written emits an
 * append-only `audit_event` that no role may update or delete, and the receipt read replays those
 * into {@link SafetyReceipt.history}. So `04`'s word "versioned" is satisfied by the log rather
 * than by the table: what stands is one row, what happened is a chain nobody can rewrite, and
 * both are on the receipt. `DEV-029` records what the table would have to become for the row
 * itself to carry the chain, and why that is not worth doing before a person can sign in.
 *
 * Recording the same resolution twice is idempotent rather than refused: the person did nothing
 * wrong and there is nothing new to write.
 */
export const ONE_RECEIPT_PER_ALERT = true;

// ---------------------------------------------------------------------------
// What the assessment was based on
// ---------------------------------------------------------------------------

/**
 * The versions and gradings the alert was assessed against.
 *
 * `04` Phase 7.6 asks the receipt to carry "the alert, the source and rule version, the action and
 * later corrections". This is the version half, and it sits on the receipt rather than on each
 * entry because one receipt names exactly one assessment: the versions are a fact about what was
 * assessed, not about when somebody got round to responding to it.
 *
 * Every field here is read off the frozen assessment row and never recomputed. `DEC-010` is the
 * reason: the assessment froze the confidence, the evidence level and the urgency at evaluation
 * time so a later rule revision cannot change what somebody was told, and a receipt that
 * re-derived any of them would be a second source of truth for the one record whose whole purpose
 * is to say what happened at the time.
 */
export interface ReceiptBasis {
  readonly assessedAt: string;
  readonly alertPublishedAt: string;
  readonly ruleVersionId: string;
  /**
   * The rule's key and version string, where this reader can see the rule row.
   *
   * `null` together, and not an error. `assessment_rule_read` admits PUBLISHED rules only, so a
   * rule Kynviora has since superseded is invisible while the alert it raised is still published -
   * and a receipt that vanished the day the rule behind it was revised would be exit criterion 1
   * failing by another route. The identifier below is on the assessment and always survives.
   */
  readonly ruleKey: string | null;
  readonly ruleVersion: string | null;
  /** The regulatory version, where the assessment rested on one. `null` where it did not. */
  readonly regulatoryRuleVersionId: string | null;
  readonly evidenceLevel: string;
  readonly urgency: string;
  readonly matchConfidence: string;
  /** The normalization version the match was computed under. */
  readonly normalizationVersion: string;
}

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

/**
 * The resolution that currently stands.
 *
 * No versions on it: see {@link ReceiptBasis}. An entry that carried its own rule version would
 * be claiming a receipt can span more than one assessment, which the unique index makes
 * impossible - and a field that can only ever repeat another one is a field that will eventually
 * disagree with it.
 */
export interface ReceiptEntry {
  readonly receiptId: string;
  readonly resolution: SafetyResolution;
  readonly note: string | null;
  readonly resolvedAt: string;
}

/**
 * One thing a person recorded, replayed out of the append-only audit log.
 *
 * This is the receipt's history, and it is deliberately thin. It carries no actor: the audit row
 * has one, and the caregiver-audit screen is where identity belongs (`03` group H). A household
 * receipt showing "your daughter marked this reviewed" would be a new disclosure invented by a
 * screen whose job is to say what was done about an alert, not who did it (DEC-076).
 */
export interface ReceiptHistoryEntry {
  readonly recordedAt: string;
  readonly resolution: SafetyResolution;
  /** Whether this replaced a resolution that already stood, rather than being the first. */
  readonly replacedPrevious: boolean;
}

/**
 * A correction recorded against the assessment behind this alert.
 *
 * Listed on the receipt whether it arrived before or after a resolution, and never merged into
 * one. Exit criterion 2 is "corrections remain visible and auditable", and a correction that
 * replaced what a person recorded rather than joining it would be the opposite.
 */
export interface ReceiptCorrection {
  readonly correctionId: string;
  readonly correctionKind: string;
  readonly reason: string;
  readonly correctedAt: string;
  /** The reviewer who recorded it, where one is named. */
  readonly reviewerId: string | null;
  /** The assessment that replaced this one, where the correction produced a replacement. */
  readonly replacementAssessmentId: string | null;
}

// ---------------------------------------------------------------------------
// What remains uncertain
// ---------------------------------------------------------------------------

/**
 * What a person reading their own receipt still does not know.
 *
 * `10` asks Kynviora to state its limits where it states its findings, and a receipt is where
 * that is easiest to skip: the record reads as settled precisely because somebody acted on it.
 * Each member below is derived from a fact on a row - never from a judgement about how worrying
 * the alert was - and the list is emitted in this order rather than sorted, because ordering by
 * severity is a ranking of one person's doubts against another's (trap 80's shape).
 */
export const RECEIPT_UNCERTAINTIES = [
  /** The assessment did not match the product exactly, so it may not be this pack. */
  'MATCH_NOT_EXACT',
  /** The source's legal reference cannot be shown here, so the claim cannot be looked up. */
  'SOURCE_REFERENCE_WITHHELD',
  /** Kynviora corrected something after the person recorded what they did. */
  'CORRECTED_SINCE_RESOLUTION',
  /** They said it is not their product and no correction has been recorded since. */
  'REPORTED_INCORRECT_AWAITING_REVIEW',
  /** A correction produced a replacement assessment, so this is not the latest reading. */
  'SUPERSEDED_BY_LATER_ASSESSMENT',
] as const;
export type ReceiptUncertainty = (typeof RECEIPT_UNCERTAINTIES)[number];

// ---------------------------------------------------------------------------

export interface SafetyReceipt {
  readonly alertPublicationId: string;
  readonly assessmentId: string;
  /** The versions and gradings this rested on. */
  readonly basis: ReceiptBasis;
  /** The resolution that currently stands, or `null` where the person has recorded nothing. */
  readonly current: ReceiptEntry | null;
  /** Everything recorded against this alert, oldest first, from the append-only log. */
  readonly history: readonly ReceiptHistoryEntry[];
  /** Every correction against the assessment, oldest first. */
  readonly corrections: readonly ReceiptCorrection[];
  /**
   * Whether a correction was recorded **after** the resolution that stands.
   *
   * The case exit criterion 2 exists for: somebody marked an alert reviewed, and Kynviora later
   * corrected the assessment behind it. Computed from two recorded timestamps rather than being a
   * flag somebody sets, so it cannot be forgotten.
   */
  readonly correctedSinceResolution: boolean;
  readonly uncertainties: readonly ReceiptUncertainty[];
}

export interface BuildReceiptInput {
  readonly alertPublicationId: string;
  readonly assessmentId: string;
  readonly basis: ReceiptBasis;
  readonly current: ReceiptEntry | null;
  readonly history: readonly ReceiptHistoryEntry[];
  readonly corrections: readonly ReceiptCorrection[];
  /**
   * Whether the source's legal reference is being withheld from this reader.
   *
   * Passed in rather than derived. Whether a licence permits a reference is a question about
   * `25` and `BLK-005`, and the domain has no business holding an opinion about either - it is
   * told, and it reports.
   */
  readonly sourceReferenceWithheld: boolean;
}

/**
 * Assemble a receipt.
 *
 * Pure. It orders two lists, answers one question about their timestamps, and states what remains
 * uncertain. There is nowhere in {@link SafetyReceipt} for a "handled", "closed" or "resolved"
 * flag: an alert somebody reviewed is not finished with, and a boolean saying otherwise would be
 * the software deciding that for them.
 */
export function buildReceipt(input: BuildReceiptInput): SafetyReceipt {
  const corrections = [...input.corrections].sort((a, b) => compare(a.correctedAt, b.correctedAt));
  const history = [...input.history].sort((a, b) => compare(a.recordedAt, b.recordedAt));

  const resolvedAt = input.current?.resolvedAt ?? null;
  const lastCorrectedAt = corrections.at(-1)?.correctedAt ?? null;

  const correctedSinceResolution =
    resolvedAt !== null &&
    lastCorrectedAt !== null &&
    Date.parse(lastCorrectedAt) > Date.parse(resolvedAt);

  return {
    alertPublicationId: input.alertPublicationId,
    assessmentId: input.assessmentId,
    basis: input.basis,
    current: input.current,
    history,
    corrections,
    correctedSinceResolution,
    uncertainties: receiptUncertainties({
      matchConfidence: input.basis.matchConfidence,
      currentResolution: input.current?.resolution ?? null,
      correctedSinceResolution,
      sourceReferenceWithheld: input.sourceReferenceWithheld,
      hasReplacementAssessment: corrections.some((c) => c.replacementAssessmentId !== null),
    }),
  };
}

export interface ReceiptUncertaintyInput {
  readonly matchConfidence: string;
  readonly currentResolution: SafetyResolution | null;
  readonly correctedSinceResolution: boolean;
  readonly sourceReferenceWithheld: boolean;
  readonly hasReplacementAssessment: boolean;
}

/**
 * What this receipt cannot settle, in vocabulary order.
 *
 * Exported separately from {@link buildReceipt} so the rule for each member is testable on its
 * own, and so a screen that wants the list without the rest of the receipt does not rebuild it.
 */
export function receiptUncertainties(
  input: ReceiptUncertaintyInput,
): readonly ReceiptUncertainty[] {
  const present = new Set<ReceiptUncertainty>();

  // Anything short of EXACT means the rule matched something that may not be this pack. `NOT_MATCHED`
  // reaches here too - an alert can be withdrawn and re-read - and it is the same statement.
  if (input.matchConfidence !== 'EXACT') present.add('MATCH_NOT_EXACT');
  if (input.sourceReferenceWithheld) present.add('SOURCE_REFERENCE_WITHHELD');
  if (input.correctedSinceResolution) present.add('CORRECTED_SINCE_RESOLUTION');

  // Said only while nothing has come back. A correction after the report is Kynviora answering,
  // and `CORRECTED_SINCE_RESOLUTION` is already saying so - repeating it as "still waiting" would
  // be the screen contradicting itself on the same two rows.
  if (input.currentResolution === 'REPORTED_INCORRECT_MATCH' && !input.correctedSinceResolution) {
    present.add('REPORTED_INCORRECT_AWAITING_REVIEW');
  }

  if (input.hasReplacementAssessment) present.add('SUPERSEDED_BY_LATER_ASSESSMENT');

  return RECEIPT_UNCERTAINTIES.filter((u) => present.has(u));
}

/** Stable ordering by timestamp. Ties keep their input order, which the caller ordered by ID. */
function compare(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return 0;
  return left - right;
}
