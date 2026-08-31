/**
 * Medicine Reconciliation: comparing what the household has against what a new record says.
 *
 * Spec references: `04` Phase 8.5, `09` ("Never tell a user to stop/start/split/replace a
 * prescription medicine based solely on Kynviora"), `03` group D, `18` (no instruction, no
 * shaming, limitations stated), `07` (provenance), `16` (source attachment).
 *
 * THE EXIT CRITERION IS ONE SENTENCE AND IT SHAPES EVERYTHING
 * "Kynviora never chooses which conflicting instruction is medically correct."
 *
 * A reconciliation is exactly the feature where that is hardest to hold. The user arrives with two
 * lists that disagree - the discharge summary says 10 mg, the pack at home says 5 mg - and the
 * single most helpful-seeming thing the software could do is say which one to follow. It is also
 * the one thing it must never do, because it has no way to know, and because `09` forbids it in
 * terms.
 *
 * So the criterion is not a rule this module follows. It is a shape this module has:
 *
 *  - {@link FieldDifference} carries `previousValue` and `currentValue` and **nothing else**.
 *    There is no `suggestedValue`, no `preferred`, no `confidence`, no ordering that implies one
 *    is better. A test asserts no such field exists.
 *  - Every member of {@link RECONCILIATION_RESOLUTIONS} names a *human* or a *document*. There is
 *    no `AUTO_RESOLVED`, no `SYSTEM_CHOSE`, no `RECOMMENDED`. A test asserts the vocabulary
 *    contains no token of that sort, so one cannot be added quietly.
 *  - {@link evaluateResolution} refuses to let an unresolved difference change anything, and
 *    refuses a resolution that would alter a medicine without naming who confirmed it.
 *
 * WHY THE DIFFERENCE KINDS ARE NAMED THE WAY THEY ARE
 * `04` Phase 8.5 lists the output as "added/removed/changed". Those words are used on the screen,
 * but not in this vocabulary, because "removed" is a claim about the *medicine* - it implies
 * someone stopped it - while what Kynviora actually knows is a fact about the two *lists*. A
 * medicine on the old list and not the new one may have been stopped, or may have been omitted
 * from a discharge summary that only covered the admission. Those are different situations with
 * opposite correct actions, and the software cannot tell them apart, so it does not name one
 * (DEC-029).
 */

import type { OwnedItemId, ProfileId, ReconciliationId, UserId } from './ids.js';
import type { Instant } from './ports.js';
import type { DomainError, Result } from './result.js';
import { failure, ok } from './result.js';

// ---------------------------------------------------------------------------
// The two lists
// ---------------------------------------------------------------------------

/**
 * One medicine as it appears on a list.
 *
 * `directionsText` is reproduced exactly as written or printed. `04` Phase 4.1 forbids rewriting
 * a prescription instruction, and a reconciliation that paraphrased one before comparing it would
 * be doing exactly that - and would then be comparing its own paraphrase.
 */
export interface MedicationLine {
  /** Present for a line that came from the shelf; absent for one read off a new document. */
  readonly ownedItemId: OwnedItemId | null;
  /** Stable key for matching the two lists. Supplied by the caller, never inferred here. */
  readonly matchKey: string;
  readonly displayName: string;
  readonly strengthText: string | null;
  readonly dosageForm: string | null;
  readonly directionsText: string | null;
}

/** The comparable fields, in the order a person reads them. */
export const RECONCILED_FIELDS = [
  'displayName',
  'strengthText',
  'dosageForm',
  'directionsText',
] as const;
export type ReconciledField = (typeof RECONCILED_FIELDS)[number];

// ---------------------------------------------------------------------------
// Differences
// ---------------------------------------------------------------------------

/**
 * What the comparison found, stated as a fact about the lists.
 *
 * Deliberately not ADDED / REMOVED / CHANGED. See the module header: those name a change to the
 * medicine, which is a conclusion Kynviora is not entitled to draw.
 */
export const DIFFERENCE_KINDS = [
  'ONLY_IN_PREVIOUS',
  'ONLY_IN_CURRENT',
  'FIELD_DIFFERS',
  'MATCHES',
] as const;
export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number];

/**
 * A disagreement about one field of one medicine.
 *
 * Two values, symmetrically. The absence of a third field naming a winner is the exit criterion
 * expressed as a type: there is nowhere to put the answer, so no code path can produce one.
 */
export interface FieldDifference {
  readonly field: ReconciledField;
  readonly previousValue: string | null;
  readonly currentValue: string | null;
}

export interface Difference {
  readonly kind: DifferenceKind;
  readonly matchKey: string;
  readonly displayName: string;
  readonly ownedItemId: OwnedItemId | null;
  /** Empty unless `kind` is `FIELD_DIFFERS`. */
  readonly fields: readonly FieldDifference[];
}

/** Field names that must never appear on a difference. Asserted against the type in the tests. */
export const FORBIDDEN_DIFFERENCE_FIELDS: readonly string[] = Object.freeze([
  'suggestedValue',
  'preferredValue',
  'recommendedValue',
  'correctValue',
  'winner',
  'confidence',
  'score',
]);

function valueOf(line: MedicationLine, field: ReconciledField): string | null {
  switch (field) {
    case 'displayName':
      return line.displayName;
    case 'strengthText':
      return line.strengthText;
    case 'dosageForm':
      return line.dosageForm;
    case 'directionsText':
      return line.directionsText;
  }
}

/**
 * Compare two medication lists.
 *
 * Pure, total and symmetric in the sense that matters: it reports what differs without ranking
 * the sides. Matching is by the caller-supplied `matchKey` and nothing else - inferring that two
 * differently-named lines are the same medicine is an identity judgement that belongs to the
 * catalog layer, which has the normalization and the provenance to make it and to say how sure
 * it is.
 *
 * `MATCHES` entries are returned rather than dropped, because "these fourteen are the same" is
 * the most reassuring part of a reconciliation and a list showing only problems misrepresents the
 * scale of what changed.
 */
export function diffMedicationLists(
  previous: readonly MedicationLine[],
  current: readonly MedicationLine[],
): readonly Difference[] {
  const byKeyCurrent = new Map(current.map((line) => [line.matchKey, line]));
  const seen = new Set<string>();
  const differences: Difference[] = [];

  for (const before of previous) {
    const after = byKeyCurrent.get(before.matchKey);
    if (after === undefined) {
      differences.push({
        kind: 'ONLY_IN_PREVIOUS',
        matchKey: before.matchKey,
        displayName: before.displayName,
        ownedItemId: before.ownedItemId,
        fields: [],
      });
      continue;
    }
    seen.add(before.matchKey);

    const fields = RECONCILED_FIELDS.filter(
      (field) => valueOf(before, field) !== valueOf(after, field),
    ).map((field) => ({
      field,
      previousValue: valueOf(before, field),
      currentValue: valueOf(after, field),
    }));

    differences.push({
      kind: fields.length === 0 ? 'MATCHES' : 'FIELD_DIFFERS',
      matchKey: before.matchKey,
      displayName: before.displayName,
      ownedItemId: before.ownedItemId,
      fields,
    });
  }

  for (const after of current) {
    if (seen.has(after.matchKey)) continue;
    if (previous.some((line) => line.matchKey === after.matchKey)) continue;
    differences.push({
      kind: 'ONLY_IN_CURRENT',
      matchKey: after.matchKey,
      displayName: after.displayName,
      ownedItemId: after.ownedItemId,
      fields: [],
    });
  }

  return differences;
}

/** Differences a person still has to deal with. `MATCHES` is not one of them. */
export function unresolvedDifferences(differences: readonly Difference[]): readonly Difference[] {
  return differences.filter((d) => d.kind !== 'MATCHES');
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * How a difference was settled.
 *
 * Every member names a human or a document. There is deliberately no `AUTO_RESOLVED`,
 * `SYSTEM_CHOSE`, `RECOMMENDED` or `BEST_GUESS`: the exit criterion is that Kynviora never
 * chooses, and a vocabulary with such a member would make choosing *sayable*, which is the first
 * step to it being done.
 *
 * `STILL_UNRESOLVED` is a first-class outcome rather than the absence of one. `04` Phase 8.5 lists
 * "unresolved differences" as required output: a person who has not yet been able to reach their
 * pharmacist has a real state, and forcing them to pick something to clear the screen is how a
 * reconciliation produces a confidently wrong record.
 */
export const RECONCILIATION_RESOLUTIONS = [
  'CONFIRMED_WITH_PRESCRIBER',
  'CONFIRMED_WITH_PHARMACIST',
  'CONFIRMED_FROM_DOCUMENT',
  'USER_KEPT_PREVIOUS',
  'USER_ADOPTED_CURRENT',
  'STILL_UNRESOLVED',
] as const;
export type ReconciliationResolution = (typeof RECONCILIATION_RESOLUTIONS)[number];

/** Tokens that must never appear in the resolution vocabulary. Asserted by test. */
export const FORBIDDEN_RESOLUTION_TOKENS: readonly string[] = Object.freeze([
  'AUTO',
  'SYSTEM',
  'RECOMMENDED',
  'SUGGESTED',
  'BEST_GUESS',
  'KYNVIORA',
]);

/**
 * Resolutions that attribute the decision to a named professional.
 *
 * The distinction matters at the point a reconciliation changes the shelf. `09` forbids acting on
 * a medication change on Kynviora's authority alone, so a change to a medicine's directions is
 * only applied when a person recorded that a professional confirmed it, or when the user
 * explicitly chose - and in the latter case the record says the user chose, not that it was
 * verified.
 */
export const PROFESSIONALLY_CONFIRMED: readonly ReconciliationResolution[] = Object.freeze([
  'CONFIRMED_WITH_PRESCRIBER',
  'CONFIRMED_WITH_PHARMACIST',
]);

/** Resolutions that settle a difference, as opposed to recording that it is still open. */
export function isSettled(resolution: ReconciliationResolution): boolean {
  return resolution !== 'STILL_UNRESOLVED';
}

/**
 * Whether a resolution changes what the shelf says.
 *
 * `USER_KEPT_PREVIOUS` and `STILL_UNRESOLVED` change nothing - the shelf already holds the
 * previous value. The rest may.
 */
export function changesTheShelf(resolution: ReconciliationResolution): boolean {
  return resolution !== 'USER_KEPT_PREVIOUS' && resolution !== 'STILL_UNRESOLVED';
}

// ---------------------------------------------------------------------------
// Applying a resolution
// ---------------------------------------------------------------------------

export const RECONCILIATION_STATES = ['OPEN', 'COMPLETED', 'ABANDONED'] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export interface ReconciliationRecord {
  readonly id: ReconciliationId;
  readonly profileId: ProfileId;
  readonly state: ReconciliationState;
  readonly startedAt: Instant;
}

/** Which of the two values now stands. */
export const ADOPTABLE_SIDES = ['PREVIOUS', 'CURRENT'] as const;
export type AdoptableSide = (typeof ADOPTABLE_SIDES)[number];

export interface ResolutionRequest {
  readonly resolution: ReconciliationResolution;
  /**
   * Which value the person settled on, stated by them.
   *
   * Required for every resolution that settles a disagreement, including a professional
   * confirmation - and *especially* then. "Confirmed with pharmacist" does not say which value
   * was confirmed, and the pharmacist may well have confirmed the older one. Inferring `CURRENT`
   * because the current list is newer would be Kynviora deciding which instruction is correct,
   * which is the one thing Phase 8.5 forbids. So the person says.
   */
  readonly adopt: AdoptableSide | null;
  /** Who confirmed it, when a professional did. Free text, entered by the user. */
  readonly confirmedBy: string | null;
  /** The user's own note. Never generated. */
  readonly note: string | null;
}

export interface ResolutionPlan {
  readonly resolution: ReconciliationResolution;
  readonly confirmedBy: string | null;
  readonly note: string | null;
  /**
   * Which value the shelf should now hold, as the person stated it. Null when nothing changes -
   * either because they kept the previous value, which the shelf already holds, or because the
   * difference is still open.
   */
  readonly adopt: AdoptableSide | null;
  readonly resolvedAt: Instant;
  readonly resolvedByUserId: UserId;
}

/**
 * Decide whether a difference may be resolved, and with what effect on the shelf.
 *
 * The checks that carry the exit criterion:
 *
 *  - a professional confirmation must name the professional, because "confirmed with pharmacist"
 *    with nobody named is indistinguishable from a shrug, and it is the field a later reader uses
 *    to decide how much weight the record deserves;
 *  - a `MATCHES` difference cannot be resolved at all - there is nothing to settle, and allowing
 *    it would let a reconciliation record a decision about a medicine nobody disagreed about;
 *  - the adopted value is named by the *user's choice*, never computed. `USER_ADOPTED_CURRENT`
 *    adopts the current list because the user said so, and the plan records that attribution.
 */
export function evaluateResolution(
  difference: Difference,
  request: ResolutionRequest,
  actor: { readonly userId: UserId; readonly now: Instant },
): Result<ResolutionPlan, DomainError> {
  if (difference.kind === 'MATCHES') {
    return failure('VALIDATION_FAILED', 'There is nothing to resolve here.', {
      reason_code: 'nothing_to_resolve',
    });
  }

  if (
    PROFESSIONALLY_CONFIRMED.includes(request.resolution) &&
    (request.confirmedBy === null || request.confirmedBy.trim().length === 0)
  ) {
    return failure('VALIDATION_FAILED', 'Record who confirmed this.', {
      reason_code: 'confirmation_needs_a_name',
    });
  }

  if (request.resolution === 'STILL_UNRESOLVED') {
    if (request.adopt !== null) {
      // An open difference has not been settled on either value. Letting it carry one would put a
      // decision into the record that nobody made.
      return failure('VALIDATION_FAILED', 'An unresolved difference settles on neither value.', {
        reason_code: 'unresolved_cannot_adopt',
      });
    }
  } else if (request.adopt === null) {
    // Every settling resolution must say which value now stands. Defaulting to the current list
    // because it is newer would be Kynviora choosing which instruction is correct.
    return failure('VALIDATION_FAILED', 'Say which version you are going with.', {
      reason_code: 'resolution_needs_a_side',
    });
  }

  // The two self-describing resolutions must agree with the side they name, or the record would
  // read as "the user kept the previous value" while holding the current one.
  const implied =
    request.resolution === 'USER_KEPT_PREVIOUS'
      ? 'PREVIOUS'
      : request.resolution === 'USER_ADOPTED_CURRENT'
        ? 'CURRENT'
        : null;
  if (implied !== null && request.adopt !== implied) {
    return failure('VALIDATION_FAILED', 'That choice does not match the version selected.', {
      reason_code: 'resolution_contradicts_side',
    });
  }

  return ok({
    resolution: request.resolution,
    confirmedBy: request.confirmedBy,
    note: request.note,
    // `PREVIOUS` changes nothing: the shelf already holds it. Recorded as null so a caller cannot
    // write a no-op update and log it as a medication change.
    adopt: request.adopt === 'CURRENT' ? 'CURRENT' : null,
    resolvedAt: actor.now,
    resolvedByUserId: actor.userId,
  });
}

/**
 * Whether a reconciliation may be marked complete.
 *
 * Completion does **not** require every difference to be settled. `04` Phase 8.5 lists unresolved
 * differences as expected output, and someone who cannot reach their pharmacist today must be
 * able to close the session without either losing their work or being pushed into a decision. It
 * requires only that every difference has been *looked at* - which `STILL_UNRESOLVED` records
 * honestly.
 */
export function canComplete(
  differences: readonly { readonly kind: DifferenceKind; readonly resolution: string | null }[],
): Result<{ readonly unresolvedCount: number }, DomainError> {
  const actionable = differences.filter((d) => d.kind !== 'MATCHES');
  const untouched = actionable.filter((d) => d.resolution === null);
  if (untouched.length > 0) {
    return failure('VALIDATION_FAILED', 'Some differences have not been looked at yet.', {
      reason_code: 'differences_not_reviewed',
      remaining: untouched.length,
    });
  }
  return ok({
    unresolvedCount: actionable.filter((d) => d.resolution === 'STILL_UNRESOLVED').length,
  });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const RECONCILIATION_AUDIT_ACTIONS = [
  'reconciliation.started',
  'reconciliation.difference.resolved',
  'reconciliation.completed',
] as const;
export type ReconciliationAuditAction = (typeof RECONCILIATION_AUDIT_ACTIONS)[number];

/**
 * Audit detail for a resolution.
 *
 * The resolution and the field name, never the values. A medicine's directions are the most
 * sensitive free text in the system and `16` keeps content out of the log; knowing that
 * `directionsText` was settled as `CONFIRMED_WITH_PHARMACIST` answers what the log is for.
 */
export function reconciliationAuditDetail(plan: {
  readonly resolution: ReconciliationResolution;
  readonly fields: readonly ReconciledField[];
  readonly professionallyConfirmed: boolean;
}): Readonly<Record<string, string | number | boolean | null>> {
  return {
    resolution: plan.resolution,
    fields: [...new Set(plan.fields)].sort().join(','),
    professionally_confirmed: plan.professionallyConfirmed,
  };
}
