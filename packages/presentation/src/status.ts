/**
 * Status presentation.
 *
 * Spec references: `18` (never communicate meaning through colour alone; verification and
 * evidence language), `09` (product states, Lens statuses), `07.1` (evidence level and urgency
 * visibly separate), `24` (Lens done criteria).
 *
 * WHY THIS IS A PACKAGE AND NOT A COMPONENT
 * `12`: "Critical accessibility behavior belongs in component APIs so each feature does not
 * reinvent it." Every status a user sees is rendered from a `StatusPresentation` produced here,
 * so the rules that matter - a text label always present, an icon that is not a colour, a
 * screen-reader description, and no forbidden wording - hold everywhere by construction.
 *
 * The type deliberately makes colour optional and label required. A presentation with no label
 * is unrepresentable.
 */

import type {
  ActionUrgency,
  CatalogCorroboration,
  EvidenceLevel,
  ItemVerification,
  MatchConfidence,
  ProductSafetyState,
  RegulatoryApplicability,
  RegulatoryStatus,
} from '@kynviora/domain';
import { ownEntry } from '@kynviora/domain';
import type { ThemeToneToken } from './tokens.js';

/**
 * How one status is presented.
 *
 * `label` and `iconName` are required, `tone` is only a supporting signal. `18`: "Never
 * communicate evidence, urgency, verification, or success through color alone. Pair color with
 * text label and icon where useful."
 */
export interface StatusPresentation {
  /** Short visible text. Always rendered - it is the primary carrier of meaning. */
  readonly label: string;
  /**
   * Icon identifier, chosen for shape rather than colour so it reads in greyscale.
   *
   * Names are semantic, not visual, so a future icon set swap does not change meaning.
   */
  readonly iconName: IconName;
  /** Supporting colour tone. Never the sole carrier of meaning. */
  readonly tone: ThemeToneToken;
  /**
   * Longer plain-language description for the detail view and screen readers.
   *
   * `18` requires familiar words first and one idea per sentence for safety-critical content.
   */
  readonly description: string;
  /**
   * What a screen reader announces.
   *
   * Separate from `label` because `18` requires severity, evidence and match status to be
   * announced in a logical order, which needs more words than a compact chip can show.
   */
  readonly accessibilityLabel: string;
}

/** Semantic icon names. Distinguishable by shape alone. */
export const ICON_NAMES = [
  'check-circle',
  'info-circle',
  'question-circle',
  'alert-triangle',
  'alert-octagon',
  'clock',
  'shield',
  'shield-question',
  'document',
  'scales',
  'ban',
  'eye-off',
  // Change (DEC-153). Shapes for a *difference between two records*, which is a different subject
  // from a state: `diff` for a value that moved, `plus-circle`/`minus-circle` for one side only,
  // `equals` for one that did not move. They are in the same vocabulary as the rest because an
  // icon is shape and shape carries no safety meaning; what is kept apart is the *colour*, and
  // that separation lives in `ThemeToneToken` rather than here.
  'diff',
  'plus-circle',
  'minus-circle',
  'equals',
] as const;
export type IconName = (typeof ICON_NAMES)[number];

// ---------------------------------------------------------------------------
// Product safety state
// ---------------------------------------------------------------------------

/**
 * Present the user-facing safety state of an item.
 *
 * The wording of `NO_CURRENT_MATCHED_ALERT` is the most carefully chosen string in the codebase.
 * `23` open questions asks "What is the best label for 'no current matched alert' that users do
 * not misread as 'safe'?" - the answer used here names what was checked rather than making a
 * claim, and the description states the limitation explicitly.
 */
export function presentSafetyState(state: ProductSafetyState): StatusPresentation {
  switch (state) {
    case 'NO_CURRENT_MATCHED_ALERT':
      return {
        label: 'Nothing matched',
        iconName: 'shield',
        // Deliberately neutral, not positive. A green tick here would communicate "safe", which
        // is precisely what this state does not mean (spec 23 D-014).
        tone: 'neutral',
        description:
          'Kynviora found no current alert for this item in the sources it monitors. This does not mean the product is safe for everyone.',
        accessibilityLabel:
          'Nothing matched. Kynviora found no current alert for this item in the sources it monitors. This does not mean the product is safe.',
      };

    case 'INFORMATION':
      return {
        label: 'Information',
        iconName: 'info-circle',
        tone: 'informational',
        description: 'There is an update about this item. No action is needed right now.',
        accessibilityLabel:
          'Information. There is an update about this item. No action needed now.',
      };

    case 'REVIEW':
      return {
        label: 'Needs review',
        iconName: 'question-circle',
        tone: 'attention',
        description: 'Please check something about this item, or discuss it when convenient.',
        accessibilityLabel: 'Needs review. Please check something about this item.',
      };

    case 'ACTION_REQUIRED':
      return {
        label: 'Action needed',
        iconName: 'alert-triangle',
        tone: 'action',
        description: 'There is a step to take for this item. Open it to see what and why.',
        accessibilityLabel: 'Action needed. There is a step to take for this item.',
      };

    case 'INSUFFICIENT_DATA':
      return {
        label: 'Not enough information',
        iconName: 'shield-question',
        tone: 'neutral',
        description:
          'Kynviora does not know enough about this item to check it. Adding the label or batch details would help.',
        accessibilityLabel:
          'Not enough information. Kynviora cannot check this item yet. Adding label or batch details would help.',
      };
  }
}

// ---------------------------------------------------------------------------
// Evidence level and urgency - presented independently
// ---------------------------------------------------------------------------

/**
 * Present evidence strength.
 *
 * `18`: users should not need to understand a scientific grading system, and a percentage that
 * is not empirically calibrated must not be shown. So this returns plain labels and no number.
 *
 * Note the tone values: evidence strength is **not** urgency, so a strong-evidence item is not
 * rendered in an alarming tone. That separation is the whole point of `23` D-005.
 */
export function presentEvidenceLevel(level: EvidenceLevel): StatusPresentation {
  switch (level) {
    case 'A':
      return {
        label: 'Official action',
        iconName: 'document',
        tone: 'informational',
        description: 'This comes from an official regulator action.',
        accessibilityLabel: 'Evidence: official action from a regulator.',
      };
    case 'B':
      return {
        label: 'Established guidance',
        iconName: 'document',
        tone: 'informational',
        description: 'This comes from established guidance or an approved product label.',
        accessibilityLabel: 'Evidence: established guidance.',
      };
    case 'C':
      return {
        label: 'Strong reviewed evidence',
        iconName: 'document',
        tone: 'informational',
        description: 'This is supported by strong evidence that Kynviora reviewers checked.',
        accessibilityLabel: 'Evidence: strong reviewed evidence.',
      };
    case 'D':
      return {
        label: 'Limited evidence',
        iconName: 'info-circle',
        tone: 'neutral',
        description: 'The evidence here is limited. It is worth knowing, not worth alarm.',
        accessibilityLabel: 'Evidence: limited.',
      };
    case 'E':
      return {
        label: 'Emerging signal',
        iconName: 'info-circle',
        tone: 'neutral',
        description: 'This is an early signal that Kynviora is monitoring internally.',
        accessibilityLabel: 'Evidence: emerging signal, monitored internally.',
      };
    case 'U':
      return {
        label: 'Insufficient information',
        iconName: 'question-circle',
        tone: 'neutral',
        description: 'There is not enough information to say how strong this is.',
        accessibilityLabel: 'Evidence: insufficient information.',
      };
  }
}

/**
 * Present action urgency.
 *
 * Separate function, separate vocabulary, separate icons. There is deliberately no function
 * anywhere that takes an evidence level and returns an urgency, or that combines the two into
 * a single badge.
 */
export function presentUrgency(urgency: ActionUrgency): StatusPresentation {
  switch (urgency) {
    case 'CRITICAL':
      return {
        label: 'Time-sensitive',
        iconName: 'alert-octagon',
        tone: 'action',
        description: 'This needs attention soon. Open it to see the recommended step.',
        accessibilityLabel: 'Time-sensitive. This needs attention soon.',
      };
    case 'HIGH':
      return {
        label: 'Act soon',
        iconName: 'alert-triangle',
        tone: 'action',
        description: 'Please take the recommended step soon.',
        accessibilityLabel: 'Act soon. Please take the recommended step.',
      };
    case 'MEDIUM':
      return {
        label: 'Review soon',
        iconName: 'question-circle',
        tone: 'attention',
        description: 'Have a look at this when you can.',
        accessibilityLabel: 'Review soon.',
      };
    case 'LOW':
      return {
        label: 'When convenient',
        iconName: 'clock',
        tone: 'neutral',
        description: 'No hurry. Worth a look at some point.',
        accessibilityLabel: 'When convenient. No hurry.',
      };
    case 'INFORMATIONAL':
      return {
        label: 'For information',
        iconName: 'info-circle',
        tone: 'informational',
        description: 'Nothing to do. This is here so you know about it.',
        accessibilityLabel: 'For information. Nothing to do.',
      };
  }
}

// ---------------------------------------------------------------------------
// Verification and match confidence
// ---------------------------------------------------------------------------

/**
 * Present a verification facet.
 *
 * `facet` is required because `18` demands identity, formula and batch certainty stay distinct:
 * "Product identity confirmed", "Formula confirmed from this label", "Batch not entered" are
 * different statements and must not share one label.
 */
export function presentVerification(
  verification: ItemVerification,
  facet: 'identity' | 'formulation' | 'batch',
): StatusPresentation {
  const noun = facet === 'identity' ? 'Product' : facet === 'formulation' ? 'Formula' : 'Batch';

  switch (verification) {
    case 'CONFIRMED':
      return {
        label: `${noun} confirmed`,
        iconName: 'check-circle',
        tone: 'positive',
        description:
          facet === 'formulation'
            ? 'The ingredient list was confirmed from this label.'
            : `The ${facet} was confirmed.`,
        accessibilityLabel: `${noun} confirmed.`,
      };
    case 'PROBABLE':
      return {
        label: `${noun} probable`,
        iconName: 'question-circle',
        tone: 'attention',
        description: `Kynviora thinks it has the right ${facet}, but it is not confirmed.`,
        accessibilityLabel: `${noun} probable, not confirmed.`,
      };
    case 'PARTIAL':
      return {
        label: `${noun} partly known`,
        iconName: 'question-circle',
        tone: 'attention',
        description: `Some of the ${facet} details are known and some are missing.`,
        accessibilityLabel: `${noun} partly known.`,
      };
    case 'CONFLICTING':
      return {
        label: `${noun} conflicting`,
        iconName: 'alert-triangle',
        tone: 'attention',
        description: `Kynviora has two different records for this ${facet} and cannot tell which is current.`,
        accessibilityLabel: `${noun} conflicting. Two different records exist.`,
      };
    case 'UNVERIFIED':
      return {
        label: facet === 'batch' ? 'Batch not entered' : `${noun} not verified`,
        iconName: 'shield-question',
        tone: 'neutral',
        description:
          facet === 'batch'
            ? 'No batch or lot number has been recorded for this item.'
            : `Kynviora has not verified the ${facet} for this item.`,
        accessibilityLabel: facet === 'batch' ? 'Batch not entered.' : `${noun} not verified.`,
      };
  }
}

/** Present how exactly a record matched this specific item and person. */
export function presentMatchConfidence(confidence: MatchConfidence): StatusPresentation {
  switch (confidence) {
    case 'EXACT':
      return {
        label: 'Exact match',
        iconName: 'check-circle',
        tone: 'informational',
        description: 'The details Kynviora has match this notice exactly.',
        accessibilityLabel: 'Exact match to this notice.',
      };
    case 'PROBABLE':
      return {
        label: 'Probable match',
        iconName: 'question-circle',
        tone: 'attention',
        description:
          'This looks like the same product, but Kynviora could not confirm every detail. Your pack may not be affected.',
        accessibilityLabel:
          'Probable match. Kynviora could not confirm every detail, so your pack may not be affected.',
      };
    case 'UNCONFIRMED':
      return {
        label: 'Unconfirmed match',
        iconName: 'shield-question',
        tone: 'neutral',
        description: 'Kynviora cannot confirm whether this applies to your item.',
        accessibilityLabel: 'Unconfirmed match.',
      };
    case 'NOT_MATCHED':
      return {
        label: 'No match',
        iconName: 'eye-off',
        tone: 'neutral',
        description: 'This does not apply to your item.',
        accessibilityLabel: 'No match. This does not apply to your item.',
      };
  }
}

/** Present the shared catalog's confidence in what a package says. */
export function presentCorroboration(state: CatalogCorroboration): StatusPresentation {
  switch (state) {
    case 'CANDIDATE':
      return {
        label: 'New record',
        iconName: 'document',
        tone: 'neutral',
        description: 'Kynviora has seen this product once and has not confirmed it yet.',
        accessibilityLabel: 'New record, seen once.',
      };
    case 'USER_CONFIRMED':
      return {
        label: 'Confirmed from one package',
        iconName: 'check-circle',
        tone: 'neutral',
        description: 'Someone confirmed these details from one package.',
        accessibilityLabel: 'Confirmed from one package.',
      };
    case 'CORROBORATED':
      return {
        label: 'Seen on several packages',
        iconName: 'check-circle',
        tone: 'positive',
        // Deliberately says what it means: several packages agreed on the label. It says nothing
        // about safety, because corroboration establishes evidence quality only (spec 08).
        description:
          'Several separate packages showed the same details. This is about what the label says, not about safety.',
        accessibilityLabel:
          'Seen on several packages. This is about what the label says, not about safety.',
      };
    case 'EXTERNALLY_VERIFIED':
      return {
        label: 'Verified with the manufacturer or an approved source',
        iconName: 'shield',
        tone: 'positive',
        description: 'These details were confirmed against an approved external source.',
        accessibilityLabel: 'Verified against an approved external source.',
      };
    case 'CONFLICTING':
      return {
        label: 'Records disagree',
        iconName: 'alert-triangle',
        tone: 'attention',
        description:
          'Different packages showed different details. Kynviora is not assuming either is right.',
        accessibilityLabel: 'Records disagree. Kynviora is not assuming either is right.',
      };
    case 'RETIRED':
      return {
        label: 'Older version',
        iconName: 'clock',
        tone: 'neutral',
        description: 'This is a previous version of the product details.',
        accessibilityLabel: 'Older version of the product details.',
      };
  }
}

// ---------------------------------------------------------------------------
// Regulatory status
// ---------------------------------------------------------------------------

/**
 * Present one regulatory status.
 *
 * The two release-gating cases:
 *  - `RESTRICTED` reads "Allowed with conditions", never "Banned" (`09`, `24`).
 *  - `NO_MATCHED_RULE_WITHIN_COVERAGE` reads "No rule found", never "Approved" or "Permitted",
 *    and its tone is neutral rather than positive (`23` D-014).
 */
export function presentRegulatoryStatus(status: RegulatoryStatus): StatusPresentation {
  switch (status) {
    case 'PROHIBITED':
      return {
        label: 'Not allowed',
        iconName: 'ban',
        tone: 'action',
        description: 'This substance is not allowed in this jurisdiction for the relevant use.',
        accessibilityLabel: 'Not allowed in this jurisdiction.',
      };
    case 'RESTRICTED':
      return {
        label: 'Allowed with conditions',
        iconName: 'scales',
        tone: 'attention',
        description: 'This substance is allowed, but only under specific conditions.',
        accessibilityLabel: 'Allowed with conditions. Not banned.',
      };
    case 'CONCENTRATION_LIMIT':
      return {
        label: 'Concentration limit applies',
        iconName: 'scales',
        tone: 'attention',
        description: 'There is a maximum amount allowed for this substance.',
        accessibilityLabel: 'A concentration limit applies.',
      };
    case 'USE_CONDITION':
      return {
        label: 'Depends on product type',
        iconName: 'scales',
        tone: 'attention',
        description: 'The rule depends on what kind of product this is and how it is used.',
        accessibilityLabel: 'The rule depends on the product type and how it is used.',
      };
    case 'AGE_OR_ROUTE_CONDITION':
      return {
        label: 'Depends on age or how it is used',
        iconName: 'scales',
        tone: 'attention',
        description: 'The rule depends on who uses the product or how it is applied.',
        accessibilityLabel: 'The rule depends on age or how the product is used.',
      };
    case 'WARNING_REQUIRED':
      return {
        label: 'Warning required on the label',
        iconName: 'info-circle',
        tone: 'informational',
        description: 'Products containing this must carry a specific warning.',
        accessibilityLabel: 'A warning is required on the label.',
      };
    case 'POSITIVE_LIST_ONLY':
      return {
        label: 'Only if specifically listed',
        iconName: 'scales',
        tone: 'attention',
        description: 'This may only be used if it appears on an approved list for that purpose.',
        accessibilityLabel: 'Only allowed if specifically listed.',
      };
    case 'PRODUCT_ACTION':
      return {
        label: 'Official action on a product',
        iconName: 'alert-triangle',
        tone: 'action',
        description: 'A regulator has taken action on a specific product or batch.',
        accessibilityLabel: 'A regulator has taken action on a specific product or batch.',
      };
    case 'SCIENTIFIC_OPINION':
      return {
        label: 'Scientific opinion, not law',
        iconName: 'document',
        tone: 'informational',
        description:
          'An expert committee published an assessment. That is not the same as a legal rule.',
        accessibilityLabel: 'A scientific opinion exists. This is not a legal rule.',
      };
    case 'NO_MATCHED_RULE_WITHIN_COVERAGE':
      return {
        label: 'No rule found',
        iconName: 'shield-question',
        // Neutral, never positive. A green tick would read as approval (spec 23 D-014).
        tone: 'neutral',
        description:
          'Kynviora checked the sources it monitors for this jurisdiction and found no rule about this substance. That is not approval.',
        accessibilityLabel:
          'No rule found in the sources Kynviora monitors. That is not approval and does not mean it is safe.',
      };
    case 'UNKNOWN_OR_INSUFFICIENT':
      return {
        label: 'Not covered yet',
        iconName: 'question-circle',
        tone: 'neutral',
        description:
          'Kynviora does not monitor enough sources for this jurisdiction to say anything yet.',
        accessibilityLabel:
          'Not covered yet. Kynviora cannot say anything about this jurisdiction.',
      };
  }
}

/** Present whether a rule could be evaluated for this package (DEC-007). */
export function presentApplicability(applicability: RegulatoryApplicability): StatusPresentation {
  switch (applicability) {
    case 'APPLIES':
      return {
        label: 'Applies to this product',
        iconName: 'check-circle',
        tone: 'informational',
        description: 'The conditions in this rule are relevant to this product.',
        accessibilityLabel: 'This rule applies to this product.',
      };
    case 'DOES_NOT_APPLY':
      return {
        label: 'Does not apply',
        iconName: 'eye-off',
        tone: 'neutral',
        description: 'This rule covers something other than this product.',
        accessibilityLabel: 'This rule does not apply to this product.',
      };
    case 'CONDITION_UNKNOWN':
      return {
        label: 'Cannot tell from this label',
        iconName: 'shield-question',
        tone: 'attention',
        description:
          'The rule depends on information this label does not give, so Kynviora cannot work out whether it is met.',
        accessibilityLabel:
          'Cannot tell from this label. The rule depends on information the label does not give.',
      };
    case 'IDENTITY_UNCERTAIN':
      return {
        label: 'Product not identified well enough',
        iconName: 'shield-question',
        tone: 'neutral',
        description: 'Kynviora is not sure enough about this product to apply the rule.',
        accessibilityLabel: 'Product not identified well enough to apply this rule.',
      };
  }
}

// ---------------------------------------------------------------------------
// What the package did not say
// ---------------------------------------------------------------------------

/**
 * The datum a `CONDITION_UNKNOWN` result is missing, in a sentence.
 *
 * `09` requires the limitation copy to name the *actual* missing thing: a rule with both a
 * concentration limit and an age condition must not report "the concentration is not disclosed"
 * when the concentration is printed and the intended age is what nobody knows.
 *
 * A total record over the vocabulary, so a new unresolved condition fails to compile here until
 * somebody writes the sentence. Each says what is missing and, where there is one, what would
 * resolve it - because "we could not tell" without a next step is a dead end on the one screen
 * `09` requires to be precise.
 */
export const UNRESOLVED_CONDITION_COPY: Readonly<Record<string, string>> = Object.freeze({
  CONCENTRATION:
    'The pack does not state how much of this substance it contains, and the rule depends on that.',
  PRODUCT_USE:
    'The rule depends on how the product is used, and that is not recorded for this item.',
  INTENDED_AGE:
    'The rule depends on who the product is intended for, and no age range is recorded.',
  ROUTE: 'The rule depends on how the product is applied or taken, and that is not recorded.',
});

/**
 * Describe an unresolved condition, or refuse it.
 *
 * `null` rather than a fallback sentence: an unresolved condition this build cannot name has no
 * words anybody wrote, and a generic "some information is missing" would be worse than saying
 * nothing - it reads as a complete answer.
 *
 * Resolved as an **own** property (DEC-146), because the key arrives on
 * `LensEntryResponse.unresolvedConditions` - parsed JSON off the network - and a plain index
 * answers every name on `Object.prototype`. `UNRESOLVED_CONDITION_COPY['toString']` is not
 * `undefined`, so `?? null` did not fire and `lens.ts` did not drop it: the Lens rendered
 * `"function toString() { [native code] }"` as its explanation of why a regulatory rule could not
 * be resolved. The sentence above is the whole reason the fallback exists, and an inherited
 * property was the one input that walked past it.
 */
export function describeUnresolvedCondition(condition: string): string | null {
  return ownEntry(UNRESOLVED_CONDITION_COPY, condition);
}

/**
 * Fixed copy for the Global Regulatory Lens screen.
 *
 * `18` keeps user-visible words out of components, and the Lens is where that rule earns most:
 * every sentence here is about the law in a place, and a phrase drifting between two screens is
 * how "restricted" quietly becomes "banned".
 */
export const LENS_COPY = Object.freeze({
  heading: 'How this is treated elsewhere',
  unmonitoredPrefix: 'Kynviora does not monitor',
  opinionHeading: 'Scientific opinion, not law',
  opinionImplemented: 'A law implements this opinion.',
  opinionNotImplemented: 'No law implements this opinion.',
  actionsHeading: 'Official actions',
  backLabel: 'Back',
});

/**
 * How many statuses this build cannot describe, in a sentence.
 *
 * `null` where there are none. Counted rather than hidden: a jurisdiction card that quietly
 * dropped a published status would understate what a regulator has said, which is the one
 * direction `09` cannot tolerate on this screen.
 */
export function undescribedStatusNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? 'One further status was published. This version of the app cannot describe it.'
    : `${count} further statuses were published. This version of the app cannot describe them.`;
}
