/**
 * What a household records about a person, so a rule can be about them.
 *
 * Spec references: `04` Phase 1.3 (allergy/sensitivity records; limited user-reported conditions
 * only where approved rules require them; provenance - user-reported, caregiver-entered, imported,
 * or future verified source; last reviewed date; edit history - with the exit criteria "no OCR or
 * inferred fact silently becomes a confirmed diagnosis" and "rules can explicitly require a
 * provenance level before using a fact"), `16` (data minimisation), `15` A5 (an unverified fact
 * driving an allergy alert), `17` (a model cannot fill a field merely because it is likely), `13`,
 * `09`, `18`.
 *
 * PROVENANCE IS NEVER SOMETHING A CLIENT SENDS
 * The first exit criterion is a sentence about what cannot happen, and the way to make it true is
 * to leave out the field. {@link HealthFactDraft} has no `provenance`, and there is no route
 * parameter that could carry one: it is derived from **who is writing** by
 * {@link provenanceForRelationship}, which can only ever return `USER_REPORTED` or
 * `CAREGIVER_ENTERED`. `IMPORTED` and `REVIEWER_CONFIRMED` are members of the schema's vocabulary
 * and are unreachable from a household surface, so nothing a person or an extraction can do makes
 * a fact look like one a reviewer confirmed. A rule then filters on provenance
 * (`requiredProfileProvenance` in the engine), which is the second exit criterion, and the two fit
 * together only because the first is enforced by absence rather than by validation.
 *
 * CERTAINTY AND PROVENANCE ARE DIFFERENT AXES
 * Certainty is how sure the **person** is: "I came out in a rash once" is `SUSPECTED` and "I was
 * admitted to hospital for it" is `CONFIRMED`. Provenance is where the fact came from, and for
 * anything typed into this app that is `USER_REPORTED` however sure they are. Neither implies the
 * other, there is no function here that derives one from the other, and no rule reads certainty -
 * the same separation DEC-007 keeps between regulatory status and applicability, for the same
 * reason: collapsing two axes into one number is how a confident sentence gets built out of thin
 * evidence.
 *
 * SO A PERSON MAY SAY "CONFIRMED", AND IT STILL DOES NOT SAY A CLINICIAN DID
 * Refusing `CONFIRMED` from a household surface would throw away real information - somebody who
 * has been hospitalised for a penicillin reaction knows something worth recording. What the exit
 * criterion forbids is that becoming a *confirmed diagnosis* on its own, and it does not: the
 * provenance still reads `USER_REPORTED`, the schema has no `CLINICIAN_CONFIRMED` provenance at
 * all, and a rule that wanted one could not name it.
 *
 * WHAT IS NOT ENTERED IS ABSENT
 * Every optional field is `string | null` with no fallback. A date somebody does not remember stays
 * missing rather than becoming today, and `lastReviewedAt` is null until somebody actually looks -
 * a review date Kynviora invented would make a stale record look checked.
 */

import { domainError, err, ok, type DomainError, type Result } from './result.js';
import type { ProvenanceKind } from './vocabulary.js';

/**
 * What kind of reaction a record is about.
 *
 * The schema's `allergy_kind_valid`, transcribed, and a test asserts they agree. Two members and
 * not one: `09` and `18` both matter here - "I get a rash from this" and "this puts me in
 * hospital" are different sentences, and a screen that offered only "allergy" would collect the
 * first under the second's name.
 */
export const HEALTH_FACT_KINDS = ['ALLERGY', 'SENSITIVITY'] as const;
export type HealthFactKind = (typeof HEALTH_FACT_KINDS)[number];
export function isHealthFactKind(value: unknown): value is HealthFactKind {
  return typeof value === 'string' && (HEALTH_FACT_KINDS as readonly string[]).includes(value);
}

/**
 * How sure the person is. Not where the fact came from - see the module note.
 *
 * The schema's `allergy_certainty_valid`, transcribed.
 */
export const FACT_CERTAINTIES = ['REPORTED', 'SUSPECTED', 'CONFIRMED'] as const;
export type FactCertainty = (typeof FACT_CERTAINTIES)[number];
export function isFactCertainty(value: unknown): value is FactCertainty {
  return typeof value === 'string' && (FACT_CERTAINTIES as readonly string[]).includes(value);
}

/**
 * Every provenance a household surface can produce.
 *
 * Two of the four the schema allows. `IMPORTED` needs an import path that does not exist and
 * `REVIEWER_CONFIRMED` needs a reviewer, which `BLK-006` records there is none of - and both are
 * stronger claims than anything a phone can make. A test asserts this list is a strict subset of
 * what the column permits, so widening the column never silently widens what a client can assert.
 */
export const HOUSEHOLD_FACT_PROVENANCE: readonly ProvenanceKind[] = Object.freeze([
  'USER_REPORTED',
  'CAREGIVER_ENTERED',
]);

/** How long a term somebody types may be. Generous, and bounded (`14`). */
export const HEALTH_TERM_MAX = 200;

/**
 * What somebody typed.
 *
 * There is deliberately no `provenance`, no `substanceId`, and no `profileId`. The first is decided
 * by who is asking; the second is the catalog's business and a household typing "penicillin" is not
 * the catalog learning a substance (the same rule manual entry keeps, `15` A11); the third is a
 * path parameter the database checks rather than a value this shape carries.
 */
export interface HealthFactDraft {
  readonly kind: string;
  /** What the person actually said, preserved verbatim. */
  readonly displayTerm: string;
  readonly certainty?: string | null | undefined;
  /** When they first noticed it, if they remember. A calendar date, not an instant. */
  readonly notedOn?: string | null | undefined;
}

/** The same, checked, with every absence made explicit. */
export interface NormalizedHealthFactDraft {
  readonly kind: HealthFactKind;
  readonly displayTerm: string;
  readonly certainty: FactCertainty;
  readonly notedOn: string | null;
}

/** Trimmed, or `null`. A field of spaces is not an answer. */
function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function invalid(reason: string, field: string): DomainError {
  return domainError('VALIDATION_FAILED', reason, { reason_code: 'health_fact', field });
}

/** A calendar date. Not an instant: nobody remembers the time of day they reacted to something. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The certainty a record gets when nobody chose one.
 *
 * `REPORTED` - the weakest of the three, which is the only safe direction. A record that defaulted
 * to `CONFIRMED` would put a stronger claim on somebody's file than they made, and the column
 * default in migration `0004` is the same value for the same reason.
 */
export const DEFAULT_FACT_CERTAINTY: FactCertainty = 'REPORTED';

/**
 * Check a draft and make its absences explicit.
 *
 * Refuses rather than repairs. A kind that is not a kind is not dropped and a date that is not a
 * date is not guessed at: both are things the person entered, and a value Kynviora quietly altered
 * is one they can no longer check against what they meant.
 */
export function normalizeHealthFactDraft(
  draft: HealthFactDraft,
): Result<NormalizedHealthFactDraft, DomainError> {
  const kindRaw = text(draft.kind);
  if (kindRaw === null || !isHealthFactKind(kindRaw)) {
    // Refused rather than defaulted to one of them. "Allergy" and "sensitivity" are different
    // sentences about somebody, and picking on their behalf writes the wrong one onto their file.
    return err(invalid('Say whether this is an allergy or a sensitivity.', 'kind'));
  }

  const displayTerm = text(draft.displayTerm);
  if (displayTerm === null) {
    return err(invalid('Say what the reaction is to.', 'displayTerm'));
  }
  if (displayTerm.length > HEALTH_TERM_MAX) {
    return err(invalid('That is too long.', 'displayTerm'));
  }

  const certaintyRaw = text(draft.certainty);
  if (certaintyRaw !== null && !isFactCertainty(certaintyRaw)) {
    return err(invalid('That is not a level of certainty Kynviora records.', 'certainty'));
  }

  const notedOn = text(draft.notedOn);
  if (notedOn !== null && !DATE_SHAPE.test(notedOn)) {
    return err(invalid('A date looks like 2024-06-01.', 'notedOn'));
  }

  return ok({
    kind: kindRaw,
    displayTerm,
    certainty: certaintyRaw ?? DEFAULT_FACT_CERTAINTY,
    notedOn,
  });
}

/**
 * Where a fact came from, decided by who is writing it.
 *
 * The whole of the first exit criterion, as a function with two possible answers. It takes a
 * relationship rather than a claim, so there is no argument a caller could pass that produces
 * `IMPORTED` or `REVIEWER_CONFIRMED` - and no route needs to remember to check, because there is
 * no field to check.
 *
 * A relationship this build does not recognise gets the **weaker** of the two. Deny by default
 * (`14`): `CAREGIVER_ENTERED` is the answer that claims less about how directly the fact was
 * observed, and an unknown caller must not be treated as the person themselves.
 */
export function provenanceForRelationship(relationship: string): ProvenanceKind {
  return relationship === 'OWNER' ? 'USER_REPORTED' : 'CAREGIVER_ENTERED';
}

// ---------------------------------------------------------------------------
// Reviewing one
// ---------------------------------------------------------------------------

/**
 * A change to a fact that already exists.
 *
 * Absent means unchanged and `null` means cleared, the same distinction the item edit keeps -
 * collapsing them would mean either that a form cannot clear a date, or that omitting a field
 * erases it. There is no `provenance` here either: correcting the wording of a fact does not
 * change where it came from, and a person who could edit it into `REVIEWER_CONFIRMED` would have
 * found the way round the exit criterion that the create path closes.
 */
export interface HealthFactChange {
  readonly displayTerm?: string | null | undefined;
  readonly certainty?: string | null | undefined;
  readonly notedOn?: string | null | undefined;
  /**
   * Whether this edit also counts as looking at the record.
   *
   * `04` Phase 1.3 asks for a last-reviewed date, and it is set only when somebody says they
   * checked. Setting it on every edit would make correcting a typo look like a review, and a
   * review date Kynviora inferred is exactly the "silently becomes" the exit criterion is about -
   * one level up from the fact itself.
   */
  readonly markReviewed?: boolean | undefined;
}

export interface NormalizedHealthFactChange {
  readonly displayTerm: string | null;
  readonly certainty: FactCertainty | null;
  /**
   * A new date, or `null` for "leave it alone".
   *
   * Two fields rather than a sentinel string, because a sentinel inside `string` is a value a
   * person could type. `notedOn: null` and `clearNotedOn: true` are the two different absences,
   * and the SQL takes them as two parameters for the same reason.
   */
  readonly notedOn: string | null;
  /** Empty the date. Distinct from leaving it alone. */
  readonly clearNotedOn: boolean;
  readonly markReviewed: boolean;
}

/** Whether a change asks for anything at all. */
export function isEmptyHealthFactChange(change: NormalizedHealthFactChange): boolean {
  return (
    change.displayTerm === null &&
    change.certainty === null &&
    change.notedOn === null &&
    !change.clearNotedOn &&
    !change.markReviewed
  );
}

/**
 * Check a change and keep "leave it alone" apart from "empty it".
 *
 * A blank `displayTerm` is refused rather than read as a clearing: the column is `NOT NULL` and a
 * fact with no term is a row nobody can act on. A blank `notedOn` clears, because "I do not
 * actually remember when" is a correction somebody may need to make.
 */
export function normalizeHealthFactChange(
  change: HealthFactChange,
): Result<NormalizedHealthFactChange, DomainError> {
  let displayTerm: string | null = null;
  if (change.displayTerm !== undefined) {
    const trimmed = text(change.displayTerm);
    if (trimmed === null) {
      return err(invalid('Say what the reaction is to.', 'displayTerm'));
    }
    if (trimmed.length > HEALTH_TERM_MAX) {
      return err(invalid('That is too long.', 'displayTerm'));
    }
    displayTerm = trimmed;
  }

  let certainty: FactCertainty | null = null;
  if (change.certainty !== undefined && change.certainty !== null) {
    const trimmed = text(change.certainty);
    if (trimmed === null || !isFactCertainty(trimmed)) {
      return err(invalid('That is not a level of certainty Kynviora records.', 'certainty'));
    }
    certainty = trimmed;
  }

  let notedOn: string | null = null;
  let clearNotedOn = false;
  if (change.notedOn !== undefined) {
    const trimmed = text(change.notedOn);
    if (trimmed === null) {
      clearNotedOn = true;
    } else if (!DATE_SHAPE.test(trimmed)) {
      return err(invalid('A date looks like 2024-06-01.', 'notedOn'));
    } else {
      notedOn = trimmed;
    }
  }

  return ok({
    displayTerm,
    certainty,
    notedOn,
    clearNotedOn,
    markReviewed: change.markReviewed === true,
  });
}
