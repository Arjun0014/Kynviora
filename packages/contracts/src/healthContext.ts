/**
 * A person's recorded reactions, as a screen renders them.
 *
 * Spec references: `04` Phase 1.3 (allergy/sensitivity records; provenance; last reviewed date -
 * with the exit criteria "no OCR or inferred fact silently becomes a confirmed diagnosis" and
 * "rules can explicitly require a provenance level before using a fact"), `10`, `16`, `13`, `09`.
 *
 * WHAT THIS DECIDES, AND WHAT IT REFUSES TO
 * Every sentence arrives from `@kynviora/presentation`. What this layer decides is narrower and is
 * what a screen must not get wrong: whether a record can actually drive a safety check, and what
 * to do with a value this build cannot read.
 *
 * A VALUE IT CANNOT READ IS DROPPED, NOT RENDERED
 * A kind, a certainty or a provenance the client does not recognise loses a line of detail. A
 * rendered one puts `REVIEWER_CONFIRMED` beside somebody's allergy, which reads as a system state
 * nobody can interpret (trap 129). The **term** is never dropped - it is the one field the person
 * wrote, and a row without it would be a record they could not find again.
 *
 * "NOT MATCHED" IS A SENTENCE, NOT A MISSING FIELD
 * `matchesCanonicalSubstance` decides which of two sentences a record carries. A person typing
 * "penicillin" has every reason to assume Kynviora checks it against everything they own, and
 * until the catalog maps the term it does not. Left to a null, that becomes a fact discovered
 * through an alert that never arrives (`10`).
 */

import { isFactCertainty, isHealthFactKind, type FactCertainty } from '@kynviora/domain';
import {
  HEALTH_CONTEXT_COPY,
  presentCertainty,
  presentHealthFactKind,
  presentProvenance,
} from '@kynviora/presentation';
import type { HealthFactLine, HealthFactsResponse } from './client.js';

export interface HealthFactRowView {
  readonly id: string;
  readonly version: number;
  /** What the person wrote. Never dropped, never altered. */
  readonly displayTerm: string;
  /** The kind as a phrase, or `null` where this build cannot read it. */
  readonly kindLabel: string | null;
  /** How sure they said they are, as a phrase, or `null`. */
  readonly certaintyLabel: string | null;
  /** Who put the record there, as a phrase, or `null`. Never a judgement of its worth. */
  readonly provenanceLabel: string | null;
  readonly notedOn: string | null;
  /**
   * What Kynviora can do with this record today.
   *
   * Always a sentence, never an empty string: the "not matched" case is the one a person most
   * needs and is also the common one, because nothing in this build maps a typed term.
   */
  readonly matchNote: string;
  readonly matchesCanonicalSubstance: boolean;
  /** Said where nobody has looked at the record since it was added. `null` once somebody has. */
  readonly reviewNote: string | null;
  readonly lastReviewedAt: string | null;
}

export interface HealthContextView {
  readonly rows: readonly HealthFactRowView[];
  readonly isEmpty: boolean;
  /**
   * How many rows Kynviora cannot yet check anything against.
   *
   * A count, not a warning. `02` forbids alarm optimisation and this is not one: it is the answer
   * to "why have I not heard anything", which a person is entitled to without counting rows.
   */
  readonly unmatchedCount: number;
}

/** One recorded reaction, as a row. */
export function healthFactRowView(line: HealthFactLine): HealthFactRowView {
  const matched = line.matchesCanonicalSubstance === true;
  const certainty: FactCertainty | null = isFactCertainty(line.certainty) ? line.certainty : null;

  return {
    id: line.id,
    version: typeof line.version === 'number' ? line.version : 0,
    displayTerm: line.displayTerm,
    kindLabel: isHealthFactKind(line.kind) ? presentHealthFactKind(line.kind).label : null,
    certaintyLabel: certainty === null ? null : presentCertainty(certainty).label,
    provenanceLabel:
      typeof line.provenance === 'string' ? presentProvenance(line.provenance) : null,
    notedOn: typeof line.notedOn === 'string' ? line.notedOn : null,
    matchNote: matched ? HEALTH_CONTEXT_COPY.matchedNote : HEALTH_CONTEXT_COPY.notMatchedNote,
    matchesCanonicalSubstance: matched,
    // A fact, not a nag. `02`: no overdue badge and no count of things to do.
    reviewNote: line.lastReviewedAt === null ? HEALTH_CONTEXT_COPY.neverReviewedNote : null,
    lastReviewedAt: typeof line.lastReviewedAt === 'string' ? line.lastReviewedAt : null,
  };
}

/**
 * The whole list.
 *
 * A row with no term is dropped: the term is the one thing the person wrote, and a row without it
 * is a control that opens an editor for a record they cannot identify.
 */
export function healthContextView(response: HealthFactsResponse): HealthContextView {
  const rows = (response.facts ?? [])
    .filter((line) => typeof line?.displayTerm === 'string' && line.displayTerm.trim() !== '')
    .map(healthFactRowView);

  return {
    rows,
    isEmpty: rows.length === 0,
    unmatchedCount: rows.filter((row) => !row.matchesCanonicalSubstance).length,
  };
}
