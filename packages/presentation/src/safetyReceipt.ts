/**
 * The Safety Receipt, in words.
 *
 * Spec references: `04` Phase 7.6 (the resolution vocabulary and a versioned receipt carrying the
 * alert, the source and rule version, the action and later corrections; "resolution does not erase
 * historical assessment"; "corrections remain visible and auditable"), `09` (medication safety
 * language - Kynviora never tells anybody to start, stop or change a medicine), `10` (state the
 * limits where you state the findings), `18` (familiar words first, one idea per sentence), `02`
 * (no scorecard), `25` (attribution and licence).
 *
 * WHAT THE RECEIPT HAS TO ANSWER
 * Four questions, and the view has a section for each rather than a paragraph covering all of
 * them: what happened and what it rested on ({@link SafetyReceiptView.basis} and `source`), what
 * the person did ({@link SafetyReceiptView.current} and `history`), what changed afterwards
 * (`corrections` and `correctedSinceNotice`), and what is still not settled (`uncertainties`).
 * The fourth is the one a receipt loses first, because a record of somebody having acted reads as
 * a record of the matter being closed.
 *
 * NO OPTION IS RECOMMENDED AND NONE IS DEFAULT
 * The same rule the reconciliation screen keeps (DEC-030) and the reviewer console keeps
 * (DEC-069), for the same reason: which of these a person did is a fact about them, and a
 * preselected control collects answers from people who pressed the one already pressed. No entry
 * here carries a `recommended`, `default` or `primary` field.
 *
 * THE LIST IS NOT A CHECKLIST AND HAS NO COMPLETION
 * There is no "resolved" state, no progress and no count of how far through anything a household
 * is. An alert somebody reviewed and later discussed with a pharmacist has a history and no
 * single answer, and a screen that reported one would be deciding which of a person's actions
 * counted. `02` names alarm-optimised design as an anti-feature; a completion meter is the
 * cheerful version of the same thing.
 */

import type { SafetyResolution } from '@kynviora/domain';
import { FEEDBACK_RESOLUTIONS, SAFETY_RESOLUTIONS } from '@kynviora/domain';
import { sourceLineView, type SourceLineInput, type SourceLineView } from './alertDetail.js';
import { presentEvidenceLevel, presentMatchConfidence, presentUrgency } from './status.js';
import { isEvidenceLevel, isMatchConfidence, isActionUrgency } from '@kynviora/domain';

export interface ResolutionPresentation {
  /** The control's text, written as something the person did. */
  readonly label: string;
  /** What recording it means, and what it does not. */
  readonly description: string;
  readonly accessibilityLabel: string;
  /**
   * Whether this says something about Kynviora rather than about what the person did.
   *
   * A screen groups by this rather than mixing the two, because "I disposed of it" and "this is
   * not my product" answer different questions and a single list implies they answer one.
   */
  readonly isFeedback: boolean;
}

/**
 * One presentation per resolution. A total record, so a new member is a sentence somebody writes.
 *
 * Every description says what recording it does **not** do. `04` Phase 7.6's first exit criterion
 * is that resolution never erases historical assessment, and a person marking something "not
 * applicable" reasonably expects it to go away - the copy is where that expectation is corrected
 * before they act on it rather than after.
 */
export const RESOLUTION_PRESENTATION: Readonly<Record<SafetyResolution, ResolutionPresentation>> =
  Object.freeze({
    REVIEWED: {
      label: 'I have read this',
      description:
        'Records that you read the alert. It does not remove the alert and does not tell Kynviora you agree with it.',
      accessibilityLabel: 'Record that you have read this alert.',
      isFeedback: false,
    },
    NOT_APPLICABLE: {
      label: 'This does not apply to us',
      description:
        'Records that the alert is not relevant to this household. Kynviora keeps the alert and what it was based on, so you can see later why it was raised.',
      accessibilityLabel: 'Record that this alert does not apply.',
      isFeedback: false,
    },
    RETURNED_OR_DISPOSED: {
      label: 'The pack has been returned or thrown away',
      description:
        'Records what happened to the pack. It does not order a replacement or tell anybody. If this is a prescription medicine, speak to your pharmacist or doctor before you go without it.',
      accessibilityLabel: 'Record that the pack was returned or disposed of.',
      isFeedback: false,
    },
    QUARANTINED: {
      label: 'The pack has been set aside',
      description:
        'Records that the pack is being kept but not used for now, for example until a pharmacist has looked at it. It does not remove the alert, and Kynviora will not ask you about it again or decide when setting it aside should end.',
      accessibilityLabel: 'Record that the pack has been set aside.',
      isFeedback: false,
    },
    DISCUSSED_WITH_PROFESSIONAL: {
      label: 'I have spoken to a pharmacist or doctor',
      description:
        'Records that you took this to somebody qualified. Kynviora does not record what they said, and nothing here replaces their advice.',
      accessibilityLabel: 'Record that you discussed this with a pharmacist or doctor.',
      isFeedback: false,
    },
    ITEM_IDENTITY_CORRECTED: {
      label: 'I have corrected what this product is',
      description:
        'Records that the item details were wrong and you fixed them. Kynviora keeps the earlier assessment, because it explains why you were told this in the first place.',
      accessibilityLabel: 'Record that you corrected the product details.',
      isFeedback: true,
    },
    REPORTED_INCORRECT_MATCH: {
      label: 'This does not match my product',
      description:
        'Tells Kynviora the match is wrong. It does not delete the alert or the assessment behind it, and it does not change anything a regulator published.',
      accessibilityLabel: 'Report that this alert does not match your product.',
      isFeedback: true,
    },
  });

export function presentResolution(resolution: SafetyResolution): ResolutionPresentation {
  return RESOLUTION_PRESENTATION[resolution];
}

/**
 * The options a screen offers, in a stable order.
 *
 * Actions first, feedback after, and within each group the vocabulary's own order. Not sorted by
 * anything a person did or is likely to do: a "most common first" ordering is a nudge, and the
 * thing being nudged is a record of somebody's own behaviour.
 *
 * `alreadyRecorded` takes what currently stands, which under one-receipt-per-alert is at most one
 * value. The option that stands is left out because choosing it again writes nothing, and a
 * control that does nothing reads as one that failed. Everything else stays on offer: a person
 * who marked an alert reviewed and has now spoken to a pharmacist is saying something new.
 */
export function resolutionOptions(alreadyRecorded: readonly SafetyResolution[] = []): readonly {
  readonly resolution: SafetyResolution;
  readonly presentation: ResolutionPresentation;
}[] {
  const recorded = new Set<string>(alreadyRecorded);
  const inOrder = [
    ...SAFETY_RESOLUTIONS.filter((r) => !FEEDBACK_RESOLUTIONS.includes(r)),
    ...SAFETY_RESOLUTIONS.filter((r) => FEEDBACK_RESOLUTIONS.includes(r)),
  ];
  return inOrder
    .filter((resolution) => !recorded.has(resolution))
    .map((resolution) => ({ resolution, presentation: presentResolution(resolution) }));
}

// ---------------------------------------------------------------------------
// What remains uncertain
// ---------------------------------------------------------------------------

/**
 * A sentence per uncertainty. A total record over the domain vocabulary.
 *
 * Each says what is not known and what a person can do about it, and none of them says what to do
 * about the medicine - `09` forbids that here as everywhere. The two that follow a person's own
 * report deliberately do not apologise: "we are looking into it" is a promise about a queue this
 * build has no staffing model for, and `10` prefers an honest absence.
 */
export const RECEIPT_UNCERTAINTY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  MATCH_NOT_EXACT:
    'Kynviora was not certain this alert is about the exact pack you have. It matched on what is recorded for this item, which may not be enough to be sure.',
  SOURCE_REFERENCE_WITHHELD:
    'The exact reference for what the source published is not shown here, so you cannot look this up from this page. The publisher and the date are above.',
  CORRECTED_SINCE_RESOLUTION:
    'Kynviora corrected something about this alert after you recorded what you did. Read the correction before relying on what you recorded.',
  REPORTED_INCORRECT_AWAITING_REVIEW:
    'You have told Kynviora this is not your product. Nothing has been corrected since, so the alert and the assessment behind it still say what they said.',
  SUPERSEDED_BY_LATER_ASSESSMENT:
    'A later assessment has replaced the one on this receipt. This page shows what was true when the alert was raised, not the most recent reading.',
});

// ---------------------------------------------------------------------------
// The receipt as a screen reads it
// ---------------------------------------------------------------------------

export interface ReceiptEntryView {
  readonly label: string;
  readonly description: string;
  readonly recordedAt: string;
  readonly note: string | null;
}

export interface ReceiptHistoryView {
  readonly label: string;
  readonly recordedAt: string;
  /** Said out loud, because a replaced answer is the case a one-row receipt could hide. */
  readonly replacedPreviousNote: string | null;
}

/**
 * The versions a person can quote to a pharmacist.
 *
 * Identifiers are rendered as identifiers, not translated into prose. `16` asks for records a
 * person can account for, and a rule version is the thing somebody reads out over a counter; the
 * gradings beside it are what tell them how much weight it carries.
 */
export interface ReceiptBasisView {
  readonly heading: string;
  readonly assessedOn: string;
  readonly alertRaisedOn: string;
  /** Human-readable rule identity, e.g. `expiry.default version 1.2.0`, or `null`. */
  readonly rule: string | null;
  /** Why the rule has no name here, when it has none. The identifier below is still shown. */
  readonly ruleUnavailableNote: string | null;
  readonly ruleVersionId: string;
  readonly regulatoryRuleVersionId: string | null;
  readonly evidenceLabel: string;
  readonly evidenceDescription: string;
  readonly urgencyLabel: string;
  readonly confidenceLabel: string;
  readonly confidenceDescription: string;
  readonly normalizationVersion: string;
  /** Why these do not move when somebody records something. */
  readonly note: string;
}

export interface ReceiptCorrectionView {
  readonly heading: string;
  readonly reason: string;
  readonly recordedAt: string;
  readonly reviewerId: string | null;
}

export interface SafetyReceiptView {
  /** What currently stands, or `null` where the person has recorded nothing. */
  readonly current: ReceiptEntryView | null;
  /** Set where a resolution is recorded whose wording this build does not have. */
  readonly undescribedResolutionNote: string | null;
  /** Everything recorded against this alert, oldest first. */
  readonly history: readonly ReceiptHistoryView[];
  /** History rows whose resolution this build has no wording for. Dropped, and counted. */
  readonly undescribedHistoryCount: number;
  readonly basis: ReceiptBasisView;
  readonly source: SourceLineView;
  readonly corrections: readonly ReceiptCorrectionView[];
  /** Said out loud where a correction landed after the resolution that stands. */
  readonly correctedSinceNotice: string | null;
  /** What this receipt does not settle. Empty is a legitimate answer, and rendered as absent. */
  readonly uncertainties: readonly string[];
  readonly emptyMessage: string;
  /** On screen in every state: what recording something here does not do. */
  readonly permanenceNote: string;
}

export interface SafetyReceiptViewInput {
  readonly basis: {
    readonly assessedAt: string;
    readonly alertPublishedAt: string;
    readonly ruleKey: string | null;
    readonly ruleVersion: string | null;
    readonly ruleVersionId: string;
    readonly regulatoryRuleVersionId: string | null;
    readonly evidenceLevel: string;
    readonly urgency: string;
    readonly matchConfidence: string;
    readonly normalizationVersion: string;
  };
  readonly current: {
    readonly resolution: string;
    readonly note: string | null;
    readonly resolvedAt: string;
  } | null;
  readonly history: readonly {
    readonly resolution: string;
    readonly recordedAt: string;
    readonly replacedPrevious: boolean;
  }[];
  readonly corrections: readonly {
    readonly correctionKind: string;
    readonly reason: string;
    readonly correctedAt: string;
    readonly reviewerId: string | null;
  }[];
  readonly correctedSinceResolution: boolean;
  readonly uncertainties: readonly string[];
  readonly source: SourceLineInput;
}

/** Headings for the correction kinds a household can be shown. Unknown kinds get a neutral one. */
const CORRECTION_HEADINGS: Readonly<Record<string, string>> = Object.freeze({
  SOURCE_CORRECTED: 'The source corrected what it had published',
  RULE_CORRECTED: 'Kynviora corrected the rule behind this',
  ITEM_IDENTITY_CORRECTED: 'The product this was matched to was corrected',
  FORMULATION_CORRECTED: 'The ingredient list this rested on was corrected',
  PROFILE_FACT_CORRECTED: 'A detail recorded on this profile was corrected',
  WITHDRAWN_NO_LONGER_APPLICABLE: 'This was withdrawn because it no longer applies',
});

const UNKNOWN_CORRECTION_HEADING = 'Kynviora recorded a correction';

/** The gradings, where the stored value is one this build knows. Unknown falls to the safe end. */
function basisView(input: SafetyReceiptViewInput['basis']): ReceiptBasisView {
  // An unrecognised grading is read as the least reassuring member rather than dropped. A missing
  // evidence chip on a receipt reads as "no concerns recorded", which is the one wrong direction.
  const evidence = presentEvidenceLevel(
    isEvidenceLevel(input.evidenceLevel) ? input.evidenceLevel : 'D',
  );
  const urgency = presentUrgency(isActionUrgency(input.urgency) ? input.urgency : 'INFORMATIONAL');
  const confidence = presentMatchConfidence(
    isMatchConfidence(input.matchConfidence) ? input.matchConfidence : 'NOT_MATCHED',
  );

  const named = input.ruleKey !== null && input.ruleVersion !== null;

  return {
    heading: 'What this was based on',
    assessedOn: input.assessedAt,
    alertRaisedOn: input.alertPublishedAt,
    rule: named ? `${input.ruleKey} version ${input.ruleVersion}` : null,
    ruleUnavailableNote: named
      ? null
      : 'Kynviora no longer publishes the rule that raised this alert, so its name is not shown here. The version identifier below is the one it used, and it has not changed.',
    ruleVersionId: input.ruleVersionId,
    regulatoryRuleVersionId: input.regulatoryRuleVersionId,
    evidenceLabel: evidence.label,
    evidenceDescription: evidence.description,
    urgencyLabel: urgency.label,
    confidenceLabel: confidence.label,
    confidenceDescription: confidence.description,
    normalizationVersion: input.normalizationVersion,
    note: 'These are the versions Kynviora used when it raised this alert. They do not change when you record what you did, and they do not change if the rule is updated later.',
  };
}

export function safetyReceiptView(input: SafetyReceiptViewInput): SafetyReceiptView {
  const entry = input.current;
  const presentation =
    entry === null
      ? undefined
      : (RESOLUTION_PRESENTATION[entry.resolution as SafetyResolution] as
          ResolutionPresentation | undefined);

  // A resolution this build has no wording for is not rendered as its code - a bare
  // `QUARANTINED_PENDING_REVIEW` in somebody's own record is a field value, not a sentence. Unlike
  // a dropped row in a list, this one is said out loud, because it is the only thing standing and
  // showing nothing would read as "you have recorded nothing".
  const undescribed = entry !== null && presentation === undefined;

  const describedHistory = input.history.filter(
    (row) => RESOLUTION_PRESENTATION[row.resolution as SafetyResolution] !== undefined,
  );

  return {
    current:
      entry === null || presentation === undefined
        ? null
        : {
            label: presentation.label,
            description: presentation.description,
            recordedAt: entry.resolvedAt,
            note: entry.note,
          },
    undescribedResolutionNote: undescribed
      ? 'You have recorded something about this alert that this version of Kynviora has no wording for. It is still recorded.'
      : null,
    history: describedHistory.map((row) => ({
      label: RESOLUTION_PRESENTATION[row.resolution as SafetyResolution].label,
      recordedAt: row.recordedAt,
      // The one thing a single-row receipt could quietly lose: that an earlier answer stood and
      // was replaced. It is said on the row that replaced it rather than inferred from ordering.
      replacedPreviousNote: row.replacedPrevious
        ? 'This replaced what you had recorded before. The earlier record is above.'
        : null,
    })),
    undescribedHistoryCount: input.history.length - describedHistory.length,
    basis: basisView(input.basis),
    source: sourceLineView(input.source),
    corrections: input.corrections.map((correction) => ({
      // An unknown kind still gets a heading, unlike a resolution: a correction Kynviora made is
      // a thing that happened to this person's alert, and omitting it would be the one direction
      // exit criterion 2 forbids. The neutral heading says less rather than nothing.
      heading: CORRECTION_HEADINGS[correction.correctionKind] ?? UNKNOWN_CORRECTION_HEADING,
      reason: correction.reason,
      recordedAt: correction.correctedAt,
      reviewerId: correction.reviewerId,
    })),
    correctedSinceNotice: input.correctedSinceResolution
      ? 'Kynviora corrected something about this alert after you recorded what you did. What you recorded is still here; read the correction below before relying on it.'
      : null,
    // An uncertainty this build has no sentence for is dropped rather than shown as its code, the
    // same choice made for a match reason and a regulatory status. The list is domain-generated,
    // so a gap here is a missing sentence rather than untrusted input.
    uncertainties: input.uncertainties
      .map((code) => RECEIPT_UNCERTAINTY_TEXT[code])
      .filter((text): text is string => text !== undefined),
    emptyMessage: 'You have not recorded anything about this alert.',
    permanenceNote:
      'Anything you record here is kept. It does not remove the alert, change what Kynviora assessed, or alter anything a regulator published - those stay so you can see later why you were told this.',
  };
}
