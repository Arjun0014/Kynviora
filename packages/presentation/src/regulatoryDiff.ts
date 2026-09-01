/**
 * What changed, said in words a household reads.
 *
 * Spec references: `04` Phase 7.4 (prior and new version; changed status, conditions and source
 * scope; whether user action changed; correction versus new evidence or regulation - and the exit
 * criterion "users can distinguish a new regulator action from a Kynviora correction"), `09`
 * (Evidence and Regulatory Diff; no value judgements between jurisdictions or versions), `18`
 * (familiar words first; one idea per sentence), `23` D-005.
 *
 * THE SENTENCE THE EXIT CRITERION TURNS ON
 * A person must be able to tell "the law changed" from "we were wrong". Those get different
 * sentences here, and a third case gets its own: the regulator publishing a correction to what it
 * had said. `NOT_STATED` gets a fourth, which says nobody recorded which of the three it was -
 * because a change with no attribution is not a regulator action, and defaulting it to one would
 * hand Kynviora's mistakes to the regulator.
 *
 * NO VERDICT ON THE DIRECTION OF A CHANGE
 * Nothing here says "stricter", "relaxed", "worse" or "better". `09` forbids value judgements
 * between jurisdictions and the same reasoning holds between two versions of one rule: whether a
 * narrowed concentration limit matters depends on what the reader is doing with the substance,
 * which this module does not know. It says what moved and leaves the meaning to the reader and
 * their pharmacist.
 */

import { isRegulatoryStatus, type ChangeAttribution } from '@kynviora/domain';
import { presentRegulatoryStatus } from './status.js';

// ---------------------------------------------------------------------------
// What this module is handed
// ---------------------------------------------------------------------------
// Declared structurally rather than imported from `@kynviora/regulatory`. This package is carried
// in the Expo bundle and the registry is not: `contracts` and `presentation` between them hold
// what a household surface renders, and neither has ever imported the registry. The shapes below
// are the parts of `RegulatoryDiff` and `ActionChange` a screen reads, and a test in the
// regulatory suite - where both packages are present - asserts they still line up.

export interface ConditionChangeInput {
  readonly key: string;
  readonly previousValue: string | null;
  readonly currentValue: string | null;
}

export interface RegulatoryDiffInput {
  readonly previousVersionId: string;
  readonly currentVersionId: string;
  readonly statusesAdded: readonly string[];
  readonly statusesRemoved: readonly string[];
  readonly conditionsChanged: readonly ConditionChangeInput[];
  readonly jurisdictionChanged: boolean;
  readonly substanceChanged: boolean;
  readonly sourceChanged: boolean;
  readonly legalReferenceChanged: boolean;
  readonly publicationDateChanged: boolean;
  readonly effectiveDateChanged: boolean;
  readonly anyChange: boolean;
}

export interface ActionChangeInput {
  readonly urgencyChanged: boolean;
  readonly wordingChanged: boolean;
  readonly changed: boolean;
  readonly comparable: boolean;
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export interface AttributionPresentation {
  readonly label: string;
  readonly description: string;
  readonly accessibilityLabel: string;
  /** Whether this attribution says Kynviora itself got something wrong. */
  readonly kynvioraWasWrong: boolean;
}

/**
 * One presentation per attribution. A total record, so a new member is a sentence somebody writes.
 *
 * The wording is deliberately blunt about Kynviora being wrong. `02` names trustworthiness as the
 * product, and a correction phrased as "this alert has been updated" is the kind of sentence that
 * makes a person distrust everything else on the screen when they work out what it meant.
 */
export const ATTRIBUTION_PRESENTATION: Readonly<
  Record<ChangeAttribution, AttributionPresentation>
> = Object.freeze({
  REGULATOR_ACTED: {
    label: 'A regulator published something new',
    description:
      'This changed because a regulator published a new or amended rule. What Kynviora told you before was right at the time.',
    accessibilityLabel: 'Reason for the change: a regulator published something new.',
    kynvioraWasWrong: false,
  },
  SOURCE_CORRECTED_ITSELF: {
    label: 'The regulator corrected its own publication',
    description:
      'This changed because the source corrected what it had published. The earlier version was what the regulator said at the time, and the regulator has since said something different about the same rule.',
    accessibilityLabel: 'Reason for the change: the regulator corrected its own publication.',
    kynvioraWasWrong: false,
  },
  KYNVIORA_CORRECTED_ITSELF: {
    label: 'Kynviora corrected itself',
    description:
      'This changed because Kynviora had something wrong - the rule it applied, the product it matched, or a detail recorded on this profile. No regulator changed anything. If you acted on the earlier version, it is worth mentioning at your next pharmacy visit.',
    accessibilityLabel: 'Reason for the change: Kynviora corrected its own mistake.',
    kynvioraWasWrong: true,
  },
  NOT_STATED: {
    label: 'Nobody recorded why this changed',
    description:
      'Kynviora can show what is different and cannot say who changed it. Treat this as an open question rather than as either a new rule or a correction.',
    accessibilityLabel: 'Reason for the change: not recorded.',
    kynvioraWasWrong: false,
  },
});

export function presentAttribution(attribution: ChangeAttribution): AttributionPresentation {
  return ATTRIBUTION_PRESENTATION[attribution];
}

// ---------------------------------------------------------------------------
// Condition wording
// ---------------------------------------------------------------------------

/**
 * A label per condition key.
 *
 * A key with no label is dropped and counted, for the reason an undescribed regulatory status is
 * (DEC-065): `additionalConditions` on a safety screen is a field name, not a sentence.
 */
export const CONDITION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  maxConcentrationPercent: 'Highest permitted concentration',
  minConcentrationPercent: 'Lowest required concentration',
  productUseTypes: 'Product types it applies to',
  productCategories: 'Product categories named',
  minimumAgeYears: 'Minimum age',
  prohibitedRoutes: 'Uses that are not allowed',
  requiredWarningText: 'Wording the label must carry',
  additionalConditions: 'Further conditions from the source',
});

export interface ConditionChangeView {
  readonly label: string;
  /** Both sides, and no third naming a preferred one. */
  readonly previousValue: string;
  readonly currentValue: string;
}

/** What a condition with no value reads as. Not blank, because blank reads as "no condition". */
export const NO_VALUE_TEXT = 'not set';

// ---------------------------------------------------------------------------
// The diff, as a screen renders it
// ---------------------------------------------------------------------------

export interface RegulatoryDiffView {
  readonly attribution: AttributionPresentation;
  /** The two versions, named so a person can quote them to a pharmacist. */
  readonly previousVersionId: string;
  readonly currentVersionId: string;

  readonly statusesAdded: readonly { readonly label: string; readonly description: string }[];
  readonly statusesRemoved: readonly { readonly label: string; readonly description: string }[];
  /** Statuses this build has no wording for, counted rather than shown as codes. */
  readonly undescribedStatusCount: number;

  readonly conditionsChanged: readonly ConditionChangeView[];
  readonly undescribedConditionCount: number;

  readonly scopeChanges: readonly string[];

  /** Whether what the person is asked to do changed. Separate from what changed in the rule. */
  readonly actionChanged: boolean;
  readonly actionNote: string;

  readonly anyChange: boolean;
  readonly emptyMessage: string;
  /** On screen in every state: this diff is about one rule, not about the product overall. */
  readonly limitation: string;
}

export interface RegulatoryDiffViewInput {
  readonly diff: RegulatoryDiffInput;
  readonly attribution: ChangeAttribution;
  readonly action: ActionChangeInput;
}

export function regulatoryDiffView(input: RegulatoryDiffViewInput): RegulatoryDiffView {
  const { diff } = input;

  let undescribedStatuses = 0;
  const describeStatus = (status: string) => {
    // Guarded rather than cast. A status this build has never heard of has no sentence anybody
    // wrote about what it permits or forbids, and a bare `POSITIVE_LIST_ONLY` on a diff is worse
    // than an omission the screen admits to - DEC-065, on a different screen.
    if (!isRegulatoryStatus(status)) {
      undescribedStatuses += 1;
      return null;
    }
    const presentation = presentRegulatoryStatus(status);
    return { label: presentation.label, description: presentation.description };
  };

  const statusesAdded = diff.statusesAdded
    .map((status) => describeStatus(status))
    .filter((entry): entry is { label: string; description: string } => entry !== null);
  const statusesRemoved = diff.statusesRemoved
    .map((status) => describeStatus(status))
    .filter((entry): entry is { label: string; description: string } => entry !== null);

  let undescribedConditions = 0;
  const conditionsChanged: ConditionChangeView[] = [];
  for (const change of diff.conditionsChanged) {
    const label = CONDITION_LABELS[change.key];
    if (label === undefined) {
      undescribedConditions += 1;
      continue;
    }
    conditionsChanged.push({
      label,
      previousValue: change.previousValue ?? NO_VALUE_TEXT,
      currentValue: change.currentValue ?? NO_VALUE_TEXT,
    });
  }

  // `04`: "changed source scope". Stated as separate sentences rather than as one "scope changed"
  // flag, because a different publisher and a different legal reference are different facts and a
  // reader deciding whether to trust the earlier version needs to know which.
  const scopeChanges: string[] = [];
  if (diff.jurisdictionChanged) {
    scopeChanges.push('The jurisdiction this rule belongs to is recorded differently.');
  }
  if (diff.substanceChanged) {
    scopeChanges.push('The substance this rule is about is recorded differently.');
  }
  if (diff.sourceChanged) scopeChanges.push('It now comes from a different source.');
  if (diff.legalReferenceChanged) scopeChanges.push('The legal reference is different.');
  if (diff.publicationDateChanged) scopeChanges.push('The publication date is different.');
  if (diff.effectiveDateChanged) scopeChanges.push('The date it takes effect is different.');

  return {
    attribution: presentAttribution(input.attribution),
    previousVersionId: diff.previousVersionId,
    currentVersionId: diff.currentVersionId,
    statusesAdded,
    statusesRemoved,
    undescribedStatusCount: undescribedStatuses,
    conditionsChanged,
    undescribedConditionCount: undescribedConditions,
    scopeChanges,
    actionChanged: input.action.changed,
    actionNote: !input.action.comparable
      ? 'Kynviora cannot compare what you were asked to do, because one of the two assessments is missing a part of it.'
      : input.action.changed
        ? 'What Kynviora asks you to do has changed. Read the alert again rather than relying on what you remember.'
        : 'What Kynviora asks you to do has not changed.',
    anyChange: diff.anyChange,
    emptyMessage:
      'Nothing Kynviora records about this rule is different between these two versions. That is not a statement that nothing happened - only that nothing it holds changed.',
    limitation:
      'This compares two versions of one rule. It is not a comparison of the product overall, and it says nothing about rules in other jurisdictions or about anything Kynviora does not monitor.',
  };
}
