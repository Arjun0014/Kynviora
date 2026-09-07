/**
 * What a household records about a person, in words.
 *
 * Spec references: `04` Phase 1.3 (allergy/sensitivity records; provenance; last reviewed date -
 * with the exit criteria "no OCR or inferred fact silently becomes a confirmed diagnosis" and
 * "rules can explicitly require a provenance level before using a fact"), `16` (data minimisation),
 * `18` (familiar words first, one idea per sentence, a label always present), `10` (state the
 * limits where you state the findings), `09` (never advice about a medicine), `02`.
 *
 * THE SCREEN SAYS WHAT KYNVIORA WILL AND WILL NOT DO WITH THIS
 * A person typing "penicillin" into a health app has every reason to assume it will be checked
 * against everything they own. It will not, and the reason is boring and important: nothing has
 * mapped that word to a substance the catalog knows, so a rule that matches on canonical
 * substances cannot see it. That is stated on the record itself rather than left to be discovered
 * by an alert that never arrives (`10`).
 *
 * CERTAINTY IS THEIRS; PROVENANCE IS KYNVIORA'S
 * The two are shown as separate sentences and never combined into one word. "You told Kynviora
 * this" is a fact about the record; "you are sure" is a fact about the person's own knowledge.
 * A screen that merged them into "confirmed" would be claiming a clinician had said so.
 *
 * NOTHING HERE IS ADVICE
 * A recorded allergy is a thing somebody told Kynviora. The copy never says what to do about a
 * medicine, never says a product is safe or unsafe, and never suggests seeing anybody (`09`).
 */

import type { FactCertainty, HealthFactKind } from '@kynviora/domain';
import { FACT_CERTAINTIES, HEALTH_FACT_KINDS, ownEntry } from '@kynviora/domain';

// ---------------------------------------------------------------------------
// The two kinds
// ---------------------------------------------------------------------------

export interface HealthFactKindPresentation {
  readonly kind: HealthFactKind;
  readonly label: string;
  /** What choosing it means, in the words a person would use. */
  readonly description: string;
}

/**
 * One entry per kind. A total record, so a kind added later is copy somebody writes.
 *
 * Two and not one: "I get a rash from this" and "this puts me in hospital" are different sentences,
 * and a screen offering only "allergy" would collect the first under the second's name.
 */
export const HEALTH_FACT_KIND_PRESENTATION: Readonly<
  Record<HealthFactKind, HealthFactKindPresentation>
> = Object.freeze({
  ALLERGY: {
    kind: 'ALLERGY',
    label: 'Allergy',
    description: 'A reaction that has been serious, or that you have been told to avoid.',
  },
  SENSITIVITY: {
    kind: 'SENSITIVITY',
    label: 'Sensitivity',
    description: 'Something that disagrees with you - a rash, a headache, an upset stomach.',
  },
});

export function presentHealthFactKind(kind: HealthFactKind): HealthFactKindPresentation {
  return HEALTH_FACT_KIND_PRESENTATION[kind];
}

export function healthFactKindOptions(): readonly HealthFactKindPresentation[] {
  return HEALTH_FACT_KINDS.map((kind) => HEALTH_FACT_KIND_PRESENTATION[kind]);
}

// ---------------------------------------------------------------------------
// How sure the person is
// ---------------------------------------------------------------------------

export interface CertaintyPresentation {
  readonly certainty: FactCertainty;
  readonly label: string;
  readonly description: string;
}

/**
 * One entry per certainty, phrased as the person's own knowledge.
 *
 * "Confirmed" says a person is sure, and the copy is careful that it never reads as a clinician
 * having said so - which is why the description names how they know rather than who told them.
 */
export const CERTAINTY_PRESENTATION: Readonly<Record<FactCertainty, CertaintyPresentation>> =
  Object.freeze({
    REPORTED: {
      certainty: 'REPORTED',
      label: 'I have been told this',
      description: 'Somebody told you, or you have always been told to avoid it.',
    },
    SUSPECTED: {
      certainty: 'SUSPECTED',
      label: 'I think so',
      description: 'It happened once or twice and you are not certain it was this.',
    },
    CONFIRMED: {
      certainty: 'CONFIRMED',
      label: 'I am sure',
      description: 'It has happened clearly enough that you have no doubt.',
    },
  });

export function presentCertainty(certainty: FactCertainty): CertaintyPresentation {
  return CERTAINTY_PRESENTATION[certainty];
}

export function certaintyOptions(): readonly CertaintyPresentation[] {
  return FACT_CERTAINTIES.map((certainty) => CERTAINTY_PRESENTATION[certainty]);
}

// ---------------------------------------------------------------------------
// Where a fact came from
// ---------------------------------------------------------------------------

/**
 * How a record's provenance reads on a screen.
 *
 * Only the two a household surface can produce, plus the two it cannot - because a record could
 * arrive from a future import path and a screen that could not describe it would show a blank.
 * None of these is a judgement about the record's worth; they say who put it there.
 */
export const PROVENANCE_PRESENTATION: Readonly<Record<string, string>> = Object.freeze({
  USER_REPORTED: 'You recorded this',
  CAREGIVER_ENTERED: 'Someone helping you recorded this',
  IMPORTED: 'This came from a record that was brought in',
  REVIEWER_CONFIRMED: 'A Kynviora reviewer checked this',
});

/**
 * The sentence for a provenance, or `null` where this build does not have one.
 *
 * `null` rather than the code. A provenance beside somebody's allergy is a field value, not a
 * phrase, and `REVIEWER_CONFIRMED` rendered raw would read as a system state nobody can interpret
 * (trap 129).
 *
 * An **own** property (DEC-146). The key reaches here as `line.provenance` off a health-context
 * response, guarded only by `typeof === 'string'`, so a plain index answered every name on
 * `Object.prototype` and put a function where the label goes - beside somebody's allergy, on the
 * screen whose whole job is saying who recorded a fact and how far it can be trusted.
 */
export function presentProvenance(provenance: string): string | null {
  return ownEntry(PROVENANCE_PRESENTATION, provenance);
}

// ---------------------------------------------------------------------------
// The words on the screen
// ---------------------------------------------------------------------------

export const HEALTH_CONTEXT_COPY = Object.freeze({
  heading: 'Allergies and sensitivities',
  intro:
    'Kynviora keeps this so it can point out when something you own contains one of them. It is the only health information Kynviora asks for.',

  emptyNote: 'Nothing is recorded yet.',

  kindLabel: 'Which is it?',
  termLabel: 'What is the reaction to?',
  termHelp:
    'Write it however you know it - a medicine name, an ingredient, or something like “nuts”.',
  certaintyLabel: 'How sure are you?',
  certaintyHelp: 'Kynviora records this as your own account either way.',
  notedOnLabel: 'When did you first notice?',
  notedOnHelp: 'Only if you know. A date looks like 2024-06-01.',
  saveLabel: 'Add this',

  /**
   * The limit that matters, said on the record rather than in a footnote.
   *
   * A person typing "penicillin" has every reason to assume it will be checked against everything
   * they own. `04` Phase 5.2 makes the mapping the catalog's business, and until a term is mapped
   * a rule that matches on canonical substances cannot see it. Discovering that through an alert
   * that never arrives is the `10` failure this sentence exists to prevent.
   */
  notMatchedNote:
    'Kynviora has not matched this to an ingredient it knows, so it cannot check your products against it yet. It is recorded and it is not lost.',
  matchedNote: 'Kynviora can check what you own against this.',

  /**
   * `04` Phase 5.2. A term that means more than one thing in the vocabulary.
   *
   * Kept apart from `notMatchedNote` because the two are different things to be told. Not knowing
   * a word is a gap in the vocabulary and nothing the person can act on; a word meaning two things
   * is something they can fix in ten seconds by being more specific. Merging them would hide the
   * one of the two that has a next step, which is the failure `10` is about.
   *
   * It does not say which substances, and it will not: listing them would be Kynviora suggesting
   * what somebody is allergic to, and a person picking from a list Kynviora offered is a different
   * record from one they wrote themselves.
   */
  ambiguousNote:
    'That word means more than one thing here, so Kynviora has not matched it to any of them and cannot check your products against it. Writing it more precisely may help. It is recorded either way and it is not lost.',

  /** `04` Phase 1.3's last-reviewed date, said as a fact rather than as a prompt. */
  neverReviewedNote: 'Nobody has checked this since it was added.',
  reviewLabel: 'This is still right',
  reviewedNote: 'Marked as checked.',

  /** `ASK_USER` on a screen (`13`, `sync.ts`). */
  conflictNote:
    'This record changed somewhere else while you had it open. Nothing you typed has been saved. Load the saved version to see what it says now.',
  loadSavedLabel: 'Load the saved version',
  unchangedNote: 'Nothing was changed, so nothing was saved.',
});

/** Every sentence this module can put on a screen, for the copy scans. */
export const ALL_HEALTH_CONTEXT_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(HEALTH_CONTEXT_COPY),
  ...Object.values(PROVENANCE_PRESENTATION),
  ...healthFactKindOptions().flatMap((option) => [option.label, option.description]),
  ...certaintyOptions().flatMap((option) => [option.label, option.description]),
]);
