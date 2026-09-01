/**
 * The Global Regulatory Lens, as a screen renders it.
 *
 * Spec references: `04` Phase 7.2 (jurisdiction cards; status label plus icon and text, never
 * colour alone; prohibited versus restricted versus condition; product and batch official
 * actions), `09` (statuses are a list; limitations accompany every status; coverage accompanies
 * every absence; scientific opinion is not law; no jurisdiction ranking), `07` (several
 * applicable statuses are never collapsed into one), DEC-007 (status and applicability are
 * separate axes and there is no `NON_COMPLIANT` outcome), DEC-016, `BLK-004`.
 *
 * WHAT THIS MODULE REFUSES TO DO
 * It does not rank jurisdictions, compute an overall verdict, or reduce several statuses to the
 * worst one. `09` explicitly forbids "strict country" and "weak regulation" framing, and the
 * shortest path to it is a screen that sorts by severity - so the entries stay in the order the
 * projection produced and there is no comparison between them anywhere.
 *
 * It also does not turn an absence into an answer. An entry with no rule carries a coverage
 * statement and its limitations, and both travel with it into the view. `23` D-014 is the rule
 * and `09`'s "absence is not approval" is the sentence.
 *
 * WHY UNRESOLVED CONDITIONS ARE CARRIED THROUGH
 * `CONDITION_UNKNOWN` means the law's own condition could not be evaluated from what is on the
 * package - a concentration, a use type, an age. Carrying which one is missing lets a screen ask
 * for that datum instead of asking somebody to photograph the pack again, and it is the
 * difference between a dead end and a next step.
 */

import {
  isRegulatoryApplicability,
  isRegulatoryStatus,
  type RegulatoryApplicability,
} from '@kynviora/domain';
import {
  describeUnresolvedCondition,
  presentApplicability,
  presentRegulatoryStatus,
  type StatusPresentation,
} from '@kynviora/presentation';
import type { LensEntryResponse, LensSnapshotResponse } from './client.js';

/**
 * Narrow an applicability, defaulting to the one that asserts least.
 *
 * `IDENTITY_UNCERTAIN` rather than `DOES_NOT_APPLY`: an applicability this client cannot read is
 * not evidence that the rule fails to bite. DEC-007 keeps this axis separate from status precisely
 * so that "we could not tell" stays sayable, and a fallback to "does not apply" is where it would
 * be lost - quietly, and in the reassuring direction.
 */
export function asApplicability(raw: string): RegulatoryApplicability {
  return isRegulatoryApplicability(raw) ? raw : 'IDENTITY_UNCERTAIN';
}

export interface LensConditionView {
  /** The vocabulary code, kept so a screen can offer the control that resolves it. */
  readonly condition: string;
  /** The sentence a person reads. Never invented - an unnamed condition is dropped. */
  readonly explanation: string;
}

export interface LensJurisdictionCardView {
  /**
   * The jurisdiction code, as the server sent it.
   *
   * A `string` rather than the `Jurisdiction` union, because narrowing it here would need a
   * fallback and there is no honest one: a jurisdiction this build does not recognise is not "EU"
   * and it is not absent either. The card renders the code, which a person can act on, and the
   * copy around it never claims to know the law there.
   */
  readonly jurisdiction: string;
  /**
   * Every applicable status, each with its own label and icon.
   *
   * A list, never one. `07` forbids collapsing several applicable statuses into a verdict, and
   * `18` requires the label and icon rather than tone alone - both come from
   * `presentRegulatoryStatus`, which the screen renders and does not reinterpret.
   */
  readonly statuses: readonly StatusPresentation[];
  /** How many statuses this build could not describe. Counted, never rendered wordlessly. */
  readonly undescribedStatuses: number;
  /** The second axis, always present. DEC-007. */
  readonly applicability: StatusPresentation;
  /**
   * The sentence for a jurisdiction carrying no status this build can describe, or `null`.
   *
   * `09`: an absence is not approval. A card with nothing on it would read as "fine here", which
   * is `23` D-014 drawn as an empty box.
   */
  readonly noStatusNote: string | null;
  /** Which conditions could not be evaluated. Empty unless applicability is CONDITION_UNKNOWN. */
  readonly unresolved: readonly LensConditionView[];
  readonly authority: string | null;
  readonly legalInstrument: string | null;
  readonly legalReference: string | null;
  readonly publicationDate: string | null;
  readonly lastVerifiedAt: string | null;
  /** `09`: shown alongside an absence, and shown anyway. */
  readonly coverageStatement: string;
  /** `09`: every displayed status carries what it does not mean. */
  readonly limitations: readonly string[];
  /** Kept under their own heading. An opinion is not a legal status, however authoritative. */
  readonly scientificOpinions: readonly {
    readonly committee: string;
    readonly reference: string;
    readonly summary: string;
    readonly publicationDate: string | null;
    /** Whether any law implements it. `09` requires the distinction to be visible. */
    readonly hasImplementingLaw: boolean;
  }[];
  readonly productActions: readonly {
    readonly actionKind: string;
    readonly authority: string;
    readonly summary: string;
    readonly effectiveDate: string | null;
  }[];
}

export interface LensView {
  readonly substanceCanonicalKey: string;
  readonly cards: readonly LensJurisdictionCardView[];
  /**
   * Requested jurisdictions Kynviora does not monitor at all.
   *
   * Reported rather than omitted. A jurisdiction silently missing from a list of six reads as
   * "nothing to say there", which is the absence-as-approval failure with a map instead of a
   * label.
   */
  readonly unmonitoredJurisdictions: readonly string[];
  readonly generatedAt: string;
}

/** The words for an entry carrying no status at all. */
export const LENS_NO_STATUS =
  'Kynviora has no published position for this jurisdiction. That is not the same as saying the ' +
  'substance is permitted there.';

function cardFor(entry: LensEntryResponse): LensJurisdictionCardView {
  // An unrecognised status is dropped and counted rather than rendered without words, for the
  // same reason a review task kind is: the presentation layer holds one description per status
  // and no default, so an unknown one has no sentence anybody wrote about what it permits or
  // forbids. Inventing one would put a legal claim on screen that no reviewer approved.
  const known = entry.statuses.filter(isRegulatoryStatus);

  return {
    jurisdiction: entry.jurisdiction,
    statuses: known.map(presentRegulatoryStatus),
    undescribedStatuses: entry.statuses.length - known.length,
    applicability: presentApplicability(asApplicability(entry.applicability)),
    noStatusNote: known.length === 0 ? LENS_NO_STATUS : null,
    // A condition this build has no sentence for is dropped rather than shown as a bare code.
    // "CONCENTRATION" on a screen tells a person nothing, and a generic "some information is
    // missing" reads as a complete answer when it is not.
    unresolved: entry.unresolvedConditions.flatMap((condition) => {
      const explanation = describeUnresolvedCondition(condition);
      return explanation === null ? [] : [{ condition, explanation }];
    }),
    authority: entry.authority,
    legalInstrument: entry.legalInstrument,
    legalReference: entry.legalReference,
    publicationDate: entry.publicationDate,
    lastVerifiedAt: entry.lastVerifiedAt,
    coverageStatement: entry.coverageStatement,
    limitations: entry.limitations,
    scientificOpinions: entry.scientificOpinions,
    productActions: entry.productActions,
  };
}

/**
 * Build the view.
 *
 * The card order is the projection's own - the requested jurisdiction order - and is not sorted
 * here. `09` forbids ranking jurisdictions as strict or weak, and sorting by how prohibitive each
 * answer is would be that ranking expressed as a list.
 */
export function lensView(snapshot: LensSnapshotResponse): LensView {
  return {
    substanceCanonicalKey: snapshot.substanceCanonicalKey,
    cards: snapshot.entries.map(cardFor),
    unmonitoredJurisdictions: snapshot.unmonitoredJurisdictions,
    generatedAt: snapshot.generatedAt,
  };
}
