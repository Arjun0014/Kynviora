/**
 * Presentation for Medicine Reconciliation.
 *
 * Spec references: `04` Phase 8.5, `09` (never instruct a stop/start/split/replace), `18` (plain
 * language, one idea per sentence, no shaming, limitations stated), `02` (a calm product), `16`
 * (source attachment).
 *
 * THE EXIT CRITERION, AS A RENDERING RULE
 * "Kynviora never chooses which conflicting instruction is medically correct." The domain has
 * nowhere to store an answer and the schema has no column for one, so by the time a difference
 * reaches a screen the only way left to choose is *visually* - and it is the easiest of the three
 * to do by accident. A screen that puts the new value in bold, or greys the old one out, or
 * pre-selects "go with the new list", has told the user which one to follow without a single
 * sentence saying so.
 *
 * So the two sides are symmetric here by construction:
 *
 *  - {@link presentSide} gives both sides the same tone and the same emphasis, and a test asserts
 *    they are equal rather than trusting each call site to keep them so;
 *  - each side is labelled by *where it came from*, never by age or authority - "what the new list
 *    says" is a provenance statement, "the correct dose" is a verdict;
 *  - no resolution option is marked recommended or default, and the three professional
 *    confirmations carry no side at all, so the screen has to ask which value was confirmed. A
 *    pharmacist may well have confirmed the older one.
 *
 * The user-facing sentence that states all of this is {@link RECONCILIATION_COPY.neitherIsChosen}.
 * Saying it out loud matters: a person looking at two doses expects the app to know, and the most
 * dangerous version of this screen is the one that lets them keep assuming it does.
 */

import type { AdoptableSide, DifferenceKind, ReconciliationResolution } from '@kynviora/domain';
import { DIFFERENCE_KINDS, RECONCILIATION_RESOLUTIONS } from '@kynviora/domain';
import type { ThemeToneToken } from './tokens.js';

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------

/**
 * The only tones a reconciliation may use.
 *
 * `action` and `attention` are absent for the same reason they are absent from the review inbox:
 * they are the tones an alert uses for actionable urgency, and a list difference is not a hazard.
 * `positive` is absent too, which is less obvious - "the two lists agree" is a fact about two
 * documents, and rendering it as good news would make its opposite read as bad news, which is a
 * verdict on a medicine.
 */
export const RECONCILIATION_TONES = ['neutral', 'informational'] as const;
export type ReconciliationTone = (typeof RECONCILIATION_TONES)[number];

/** Compile-time proof that every reconciliation tone is a real theme tone. */
const _toneCheck: readonly ThemeToneToken[] = RECONCILIATION_TONES;
void _toneCheck;

// ---------------------------------------------------------------------------
// The two sides
// ---------------------------------------------------------------------------

export interface SideView {
  readonly side: AdoptableSide;
  /** Names where the value came from. Never its age, its authority, or its correctness. */
  readonly label: string;
  readonly tone: ReconciliationTone;
  /**
   * Whether the side is drawn more prominently than the other.
   *
   * Always `false`, for both sides, and present as a field so that a future change which
   * emphasises one has to say so and fail a test - rather than happening in a stylesheet where
   * nothing is watching.
   */
  readonly emphasised: boolean;
}

const SIDE_LABELS: Readonly<Record<AdoptableSide, string>> = Object.freeze({
  PREVIOUS: 'What Kynviora had',
  CURRENT: 'What the new list says',
});

/**
 * Present one side of a disagreement.
 *
 * Both sides get the same tone and the same emphasis. That symmetry is the exit criterion
 * expressed in pixels, and it is asserted by a test comparing the two results field by field.
 */
export function presentSide(
  side: AdoptableSide,
  value: string | null,
): SideView & {
  readonly value: string;
} {
  return {
    side,
    label: SIDE_LABELS[side],
    tone: 'neutral',
    emphasised: false,
    // A blank on one side is a real answer - the new list may simply not say - and rendering it
    // as an empty cell reads as "nothing", which is a different claim.
    value: value === null || value.trim().length === 0 ? 'Not stated' : value,
  };
}

// ---------------------------------------------------------------------------
// Difference kinds
// ---------------------------------------------------------------------------

export interface DifferenceDescription {
  readonly heading: string;
  /** What the difference means, and - where it matters - what it does not mean. */
  readonly meaning: string;
  readonly tone: ReconciliationTone;
}

export const DIFFERENCE_DESCRIPTIONS: Readonly<Record<DifferenceKind, DifferenceDescription>> =
  Object.freeze({
    ONLY_IN_PREVIOUS: {
      heading: 'On your shelf, not on the new list',
      // The sharpest sentence on the screen. A medicine absent from a discharge summary may have
      // been changed, or the summary may only cover the admission, and those have opposite
      // correct actions. Kynviora says it cannot tell, because it cannot.
      meaning:
        'The new list does not mention this one. That might be deliberate, or the list might only cover part of the picture. Kynviora cannot tell which.',
      tone: 'informational',
    },
    ONLY_IN_CURRENT: {
      heading: 'On the new list, not on your shelf',
      meaning:
        'Kynviora has no record of this one yet. You can add it once you know it belongs there.',
      tone: 'informational',
    },
    FIELD_DIFFERS: {
      heading: 'The two lists say different things',
      meaning: 'Both versions are shown below, exactly as they were written.',
      tone: 'informational',
    },
    MATCHES: {
      heading: 'The two lists agree',
      meaning: 'Nothing to sort out here.',
      tone: 'neutral',
    },
  });

export function describeDifference(kind: DifferenceKind): DifferenceDescription {
  return DIFFERENCE_DESCRIPTIONS[kind];
}

// ---------------------------------------------------------------------------
// Resolution options
// ---------------------------------------------------------------------------

export interface ResolutionOption {
  readonly resolution: ReconciliationResolution;
  /**
   * The label on the control.
   *
   * The user's own resolutions are written in the first person - "I'm going with the new list" -
   * rather than as an imperative. An imperative on a button is Kynviora telling someone what to
   * do with a medicine; the first person makes it their statement, which is what it is.
   */
  readonly label: string;
  readonly meaning: string;
  /** Whether the screen must collect a name before this may be recorded. */
  readonly needsName: boolean;
  /**
   * The side this option settles on, when the option itself says.
   *
   * Null for the three confirmations, and that is the point: "the pharmacist confirmed it" does
   * not say *which value* they confirmed, and assuming the newer one would be Kynviora choosing.
   * The screen has to ask.
   */
  readonly fixedSide: AdoptableSide | null;
  /** Whether recording this option settles the difference at all. */
  readonly settles: boolean;
}

/**
 * Every way a person may settle a difference, in a fixed order.
 *
 * Deliberately carries no `recommended`, `default` or `primary` field. A pre-selected option is a
 * recommendation whatever it is called, and a test asserts that no such field exists rather than
 * that none is currently set.
 */
export const RESOLUTION_OPTIONS: readonly ResolutionOption[] = Object.freeze([
  {
    resolution: 'CONFIRMED_WITH_PRESCRIBER',
    label: 'A prescriber confirmed it',
    meaning: 'Record who you spoke to, and which version they confirmed.',
    needsName: true,
    fixedSide: null,
    settles: true,
  },
  {
    resolution: 'CONFIRMED_WITH_PHARMACIST',
    label: 'A pharmacist confirmed it',
    meaning: 'Record who you spoke to, and which version they confirmed.',
    needsName: true,
    fixedSide: null,
    settles: true,
  },
  {
    resolution: 'CONFIRMED_FROM_DOCUMENT',
    label: 'A document settles it',
    meaning: 'A letter, label or printed list you have in front of you.',
    needsName: false,
    fixedSide: null,
    settles: true,
  },
  {
    resolution: 'USER_KEPT_PREVIOUS',
    label: "I'm keeping what was here before",
    meaning: 'Nothing on your shelf changes.',
    needsName: false,
    fixedSide: 'PREVIOUS',
    settles: true,
  },
  {
    resolution: 'USER_ADOPTED_CURRENT',
    label: "I'm going with the new list",
    meaning: 'Kynviora will update this detail on your shelf.',
    needsName: false,
    fixedSide: 'CURRENT',
    settles: true,
  },
  {
    resolution: 'STILL_UNRESOLVED',
    label: 'I still need to check this',
    // 04 Phase 8.5 lists unresolved differences as expected output. Someone who cannot reach
    // their pharmacist today has a real state, and being pushed into a choice to clear the
    // screen is how a reconciliation produces a confidently wrong record.
    meaning: 'Kynviora will keep it on the list. Nothing changes until you say so.',
    needsName: false,
    fixedSide: null,
    settles: false,
  },
]);

/** Field names that must never appear on a resolution option. Asserted against the values. */
export const FORBIDDEN_OPTION_FIELDS: readonly string[] = Object.freeze([
  'recommended',
  'default',
  'primary',
  'preferred',
  'suggested',
  'confidence',
]);

export function resolutionOption(resolution: ReconciliationResolution): ResolutionOption {
  const found = RESOLUTION_OPTIONS.find((option) => option.resolution === resolution);
  if (found === undefined) {
    throw new Error(`No option for resolution ${resolution}.`);
  }
  return found;
}

/** The options for which the screen must ask which value now stands. */
export function optionsNeedingASide(): readonly ReconciliationResolution[] {
  return RESOLUTION_OPTIONS.filter((option) => option.settles && option.fixedSide === null).map(
    (option) => option.resolution,
  );
}

// ---------------------------------------------------------------------------
// Framing copy
// ---------------------------------------------------------------------------

export const RECONCILIATION_COPY = Object.freeze({
  heading: 'Comparing two lists',
  intro: 'One list is what Kynviora had. The other is the one you have just been given.',
  // The exit criterion, said out loud. A person looking at two doses expects the app to know
  // which is right, and the most dangerous version of this screen is the one that lets them
  // carry on assuming it does.
  neitherIsChosen:
    'Kynviora does not know which version is right for you, and it will not pick one. It shows you both so you can ask someone who does.',
  // 04 Phase 8.5 "confirm with clinician/pharmacist" workflow, phrased as a route rather than an
  // instruction about the medicine itself.
  whoToAsk: 'Your prescriber or your pharmacist can tell you which version to follow.',
  askPrompt: 'Bring both versions with you. It is quicker than describing them.',
  sourcePrompt: 'You can attach the letter or list this came from, so it is here next time.',
  // 18: the limitation is stated, not implied.
  limitation:
    'This compares what is written on two lists. It is not a check of whether either one suits you.',
  unresolvedIsFine: 'You can leave anything you are unsure about for later.',
  verbatimNote: 'Directions are shown exactly as they were written on each list.',
});

/** Copy shown once a reconciliation has been closed. */
export function completionMessage(unresolvedCount: number): string {
  if (unresolvedCount === 0) return 'All done. Every difference has an answer recorded.';
  if (unresolvedCount === 1) return 'Saved. One difference is still waiting on someone to check.';
  return `Saved. ${unresolvedCount} differences are still waiting on someone to check.`;
}

// ---------------------------------------------------------------------------
// The comparison as a whole
// ---------------------------------------------------------------------------

export interface ComparisonLine {
  readonly differenceId: string;
  readonly kind: DifferenceKind;
  readonly displayName: string;
  readonly heading: string;
  readonly meaning: string;
  readonly tone: ReconciliationTone;
  readonly fieldLabel: string | null;
  readonly sides: readonly (SideView & { readonly value: string })[];
  readonly resolution: ReconciliationResolution | null;
}

export interface ComparisonSummary {
  readonly lines: readonly ComparisonLine[];
  /** How many lines the two documents agreed on. Reported, never celebrated. */
  readonly agreeingCount: number;
  /** How many need a person to look. Not a badge, and not ranked. */
  readonly differingCount: number;
  readonly settledCount: number;
  readonly emptyMessage: string | null;
  readonly limitation: string;
}

/** Human labels for the comparable fields. */
const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  displayName: 'Name',
  strengthText: 'Strength',
  dosageForm: 'Form',
  directionsText: 'Directions',
});

export const COMPARISON_EMPTY = 'There is nothing to compare yet.';

/**
 * Build the whole comparison view.
 *
 * Takes the order it is given and keeps it. Sorting differences by "importance" would require
 * ranking one medicine's disagreement above another's, which is a clinical judgement and not one
 * Kynviora is entitled to make.
 */
export function summarizeComparison(
  differences: readonly {
    readonly differenceId: string;
    readonly kind: DifferenceKind;
    readonly displayName: string;
    readonly field: string | null;
    readonly previousValue: string | null;
    readonly currentValue: string | null;
    readonly resolution: ReconciliationResolution | null;
  }[],
): ComparisonSummary {
  const lines = differences.map((difference) => {
    const description = DIFFERENCE_DESCRIPTIONS[difference.kind];
    return {
      differenceId: difference.differenceId,
      kind: difference.kind,
      displayName: difference.displayName,
      heading: description.heading,
      meaning: description.meaning,
      tone: description.tone,
      fieldLabel: difference.field === null ? null : (FIELD_LABELS[difference.field] ?? null),
      // Both sides, always, and in a fixed order that is a reading order rather than a ranking.
      sides:
        difference.kind === 'FIELD_DIFFERS'
          ? [
              presentSide('PREVIOUS', difference.previousValue),
              presentSide('CURRENT', difference.currentValue),
            ]
          : [],
      resolution: difference.resolution,
    };
  });

  const differing = lines.filter((line) => line.kind !== 'MATCHES');

  return {
    lines,
    agreeingCount: lines.length - differing.length,
    differingCount: differing.length,
    settledCount: differing.filter(
      (line) => line.resolution !== null && line.resolution !== 'STILL_UNRESOLVED',
    ).length,
    emptyMessage: lines.length === 0 ? COMPARISON_EMPTY : null,
    limitation: RECONCILIATION_COPY.limitation,
  };
}

// ---------------------------------------------------------------------------
// Coverage and scanning
// ---------------------------------------------------------------------------

/** Every fixed string in this module, for the forbidden-claim scan. */
export const ALL_RECONCILIATION_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(RECONCILIATION_COPY),
  ...Object.values(DIFFERENCE_DESCRIPTIONS).flatMap((d) => [d.heading, d.meaning]),
  ...RESOLUTION_OPTIONS.flatMap((o) => [o.label, o.meaning]),
  ...Object.values(SIDE_LABELS),
  ...Object.values(FIELD_LABELS),
  COMPARISON_EMPTY,
  completionMessage(0),
  completionMessage(1),
  completionMessage(4),
]);

/**
 * The strings Kynviora says in its own voice.
 *
 * Separate from {@link ALL_RECONCILIATION_STRINGS} because the resolution labels are written in
 * the *user's* voice - "I'm going with the new list" is their statement, not Kynviora's advice -
 * and scanning both with a rule about instructions would make the user's own choices unsayable.
 */
export const KYNVIORA_VOICE_STRINGS: readonly string[] = Object.freeze([
  ...Object.values(RECONCILIATION_COPY),
  ...Object.values(DIFFERENCE_DESCRIPTIONS).flatMap((d) => [d.heading, d.meaning]),
  ...Object.values(SIDE_LABELS),
  COMPARISON_EMPTY,
]);

/** Every difference kind has words. Guards against one reaching a screen unnamed. */
export function everyDifferenceKindDescribed(): boolean {
  return DIFFERENCE_KINDS.every((kind) => DIFFERENCE_DESCRIPTIONS[kind] !== undefined);
}

/** Every resolution has an option. Guards against one being recordable but unofferable. */
export function everyResolutionOffered(): boolean {
  return RECONCILIATION_RESOLUTIONS.every((resolution) =>
    RESOLUTION_OPTIONS.some((option) => option.resolution === resolution),
  );
}
