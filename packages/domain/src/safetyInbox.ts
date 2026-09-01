/**
 * The Safety Watch information architecture: what state an item is in, and why.
 *
 * Spec references: `04` Phase 7.1 (assessment states and inbox; "no state implies guaranteed
 * safety"; "evidence level and urgency are visibly separate"), `09` (product states, and their
 * definitions), `23` D-005 (evidence level and urgency are never combined) and D-014 (an absence
 * of a matched rule must never render as approval), `02` (no aggregate score).
 *
 * WHY THE STATE IS DERIVED HERE AND NOT STORED
 * `PRODUCT_SAFETY_STATES` has existed in the vocabulary since Stage 0 and has been presented since
 * the presentation layer was written. Nothing computed it: the Safety screen listed published
 * alerts, so an item with no alert was simply absent - and a person reading that screen could not
 * tell "checked, nothing matched" from "never checked". That is the exact failure `23` D-014 is
 * about, arriving by omission rather than by a wrong label.
 *
 * THE RULE, AND WHERE EACH LINE OF IT COMES FROM
 * `09` defines the five states, and the derivation is those definitions read literally:
 *
 *  - "Action required - approved action wording based on urgency". So a published alert whose
 *    urgency is CRITICAL or HIGH is `ACTION_REQUIRED`. The urgency is the assessment's own,
 *    frozen at evaluation time; nothing here recomputes it.
 *  - "Review - user should confirm item/context or discuss appropriately" - MEDIUM and LOW.
 *  - "Information - relevant update without immediate action" - INFORMATIONAL.
 *  - "Insufficient data - item/context cannot be matched reliably". An item whose assessment
 *    could not identify it (`UNCONFIRMED` or `NOT_MATCHED`), and an item never assessed at all.
 *  - "No current matched alert - no applicable reviewed Kynviora alert found within current
 *    coverage". Only for an item that **was** assessed, was identified, and matched nothing.
 *
 * THE ONE DECISION WORTH ARGUING ABOUT
 * An item that has never been assessed is `INSUFFICIENT_DATA`, not `NO_CURRENT_MATCHED_ALERT`.
 * The second claims a check happened and found nothing, which is a reassurance nobody earned;
 * `INSUFFICIENT_DATA` claims only that Kynviora cannot check it yet, which is true. The failure
 * directions are not symmetric here and the state that claims less is the safe one.
 *
 * WHAT THIS MODULE WILL NOT DO
 * It does not combine evidence level with urgency, produce a score, rank items, or count how many
 * are in any state. `23` D-005 forbids the first two; the count is the alarm-optimising product
 * `02` refuses to build. Evidence level is carried beside the state, never folded into it - a
 * line's state comes from urgency alone, and a test asserts that changing the evidence level
 * changes nothing.
 */

import type { ActionUrgency, MatchConfidence, ProductSafetyState } from './vocabulary.js';
import type { Instant } from './ports.js';

/**
 * Match confidences that mean the item itself was identified.
 *
 * `09`: insufficient data is "item/context cannot be matched reliably". `EXACT` and `PROBABLE` are
 * the two that were. `UNCONFIRMED` and `NOT_MATCHED` were not, whatever any rule then did.
 */
const IDENTIFIED: readonly MatchConfidence[] = ['EXACT', 'PROBABLE'];

/**
 * The state a published alert puts an item in, from its urgency alone.
 *
 * A total record: a new urgency fails to compile until somebody decides which state it belongs to,
 * which is a product decision and not one to make by falling through a default.
 */
export const STATE_FOR_URGENCY: Readonly<Record<ActionUrgency, ProductSafetyState>> = Object.freeze(
  {
    CRITICAL: 'ACTION_REQUIRED',
    HIGH: 'ACTION_REQUIRED',
    MEDIUM: 'REVIEW',
    LOW: 'REVIEW',
    INFORMATIONAL: 'INFORMATION',
  },
);

/** What is known about one item, as far as its safety state is concerned. */
export interface ItemSafetyInput {
  /**
   * The live published alert for this item, or `null`.
   *
   * "Live" means published and not withdrawn or superseded. A withdrawn alert must not leave an
   * item showing `ACTION_REQUIRED`: `19` treats a withdrawn alert resurfacing as a release-blocking
   * defect, and this is the same defect one layer up.
   */
  readonly publishedAlert: {
    readonly urgency: ActionUrgency;
    readonly evidenceLevel: string;
    readonly matchConfidence: MatchConfidence;
  } | null;
  /**
   * The most recent non-shadow assessment of this item, or `null` for never assessed.
   *
   * A shadow assessment is deliberately not eligible: DEC-034 puts a shadow run's results in
   * `shadow_run` precisely so nothing it produced can become user-visible, and letting one decide
   * a state here would be that boundary crossed by the back door.
   */
  readonly latestAssessment: {
    readonly matchConfidence: MatchConfidence;
    readonly evaluatedAt: Instant;
  } | null;
}

export interface ItemSafetyState {
  readonly state: ProductSafetyState;
  /**
   * The urgency of the live alert, or `null`.
   *
   * Carried beside the state rather than folded into it. `23` D-005 forbids combining urgency with
   * evidence level, and a screen that received only a state would have to reconstruct one of them.
   */
  readonly urgency: ActionUrgency | null;
  /** The evidence level of the live alert, or `null`. Never affects {@link ItemSafetyState.state}. */
  readonly evidenceLevel: string | null;
  /** When Kynviora last assessed this item, or `null`. Absence is the point, not a gap. */
  readonly lastAssessedAt: Instant | null;
}

/**
 * Derive one item's safety state.
 *
 * Deterministic and pure: the same inputs give the same state, which is what makes an assessment
 * replayable (`09`, DEC-024) and what makes this testable without a database.
 */
export function deriveItemSafetyState(input: ItemSafetyInput): ItemSafetyState {
  const lastAssessedAt = input.latestAssessment?.evaluatedAt ?? null;

  if (input.publishedAlert !== null) {
    return {
      state: STATE_FOR_URGENCY[input.publishedAlert.urgency],
      urgency: input.publishedAlert.urgency,
      evidenceLevel: input.publishedAlert.evidenceLevel,
      lastAssessedAt,
    };
  }

  const assessment = input.latestAssessment;
  const identified = assessment !== null && IDENTIFIED.includes(assessment.matchConfidence);

  return {
    // Never assessed, or assessed and not identified, both claim less than "nothing matched".
    state: identified ? 'NO_CURRENT_MATCHED_ALERT' : 'INSUFFICIENT_DATA',
    urgency: null,
    evidenceLevel: null,
    lastAssessedAt,
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * What the inbox may be filtered by.
 *
 * `04` Phase 7.1 names profile, urgency and status. Profile is the scope of the request rather
 * than a filter within it - `13` says a profile ID narrows a result set and never grants access,
 * and row-level security decides either way.
 *
 * There is no sort order here and no "most urgent first". Ranking is a judgement about which of
 * two people's medicines matters more, and `02` refuses the alarm-optimising product that comes
 * from making it.
 */
export interface SafetyInboxFilter {
  readonly states?: readonly ProductSafetyState[];
  readonly urgencies?: readonly ActionUrgency[];
}

export interface SafetyInboxLine extends ItemSafetyState {
  readonly ownedItemId: string;
  readonly displayName: string;
  /**
   * The live alert this line came from, or `null`.
   *
   * `null` on every line with no live alert, which is most of them, and on every line whose state
   * was derived from an assessment rather than from a publication. A screen opens the Phase 7.3
   * detail from this and offers no control where it is absent (DEC-045).
   */
  readonly alertPublicationId: string | null;
}

/**
 * Apply the filters.
 *
 * An empty or absent filter list means "no filter on this axis" rather than "match nothing",
 * because the two are indistinguishable in a query string and the harmless reading is the one a
 * screen actually wants.
 *
 * A line with no urgency - which is every line that is not carrying a live alert - is excluded by
 * an urgency filter rather than included by default. Filtering to CRITICAL and being shown items
 * with no alert at all would make the filter meaningless.
 */
export function filterSafetyInbox(
  lines: readonly SafetyInboxLine[],
  filter: SafetyInboxFilter = {},
): readonly SafetyInboxLine[] {
  const states = filter.states ?? [];
  const urgencies = filter.urgencies ?? [];

  return lines.filter((line) => {
    if (states.length > 0 && !states.includes(line.state)) return false;
    if (urgencies.length > 0 && (line.urgency === null || !urgencies.includes(line.urgency))) {
      return false;
    }
    return true;
  });
}
