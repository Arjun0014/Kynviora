/**
 * One alert, explained.
 *
 * Spec references: `04` Phase 7.3 (affected person and exact item, match confidence, reason for
 * match, evidence level, urgency, jurisdiction/source/date, source reference where allowed, next
 * action, limitations, report-incorrect - and the exit criterion "the UI reveals what is known
 * versus inferred"), `09` (evidence model; coverage statements; no generalisation from an
 * ingredient difference to "this brand is dangerous"), `18` (the eight-part message order),
 * `23` D-005 (evidence level and urgency are never combined), `25` (source licensing),
 * `19` (a withdrawn alert must never read as live).
 *
 * KNOWN VERSUS INFERRED IS A TYPE, NOT A PARAGRAPH
 * The exit criterion asks the UI to reveal what is known versus inferred. A sentence saying so
 * would be a claim about the screen rather than a property of it, and it would go stale the first
 * time a field moved. Instead every fact on this screen is an {@link AlertFact} carrying a
 * {@link FactBasis}, there is no way to construct one without a basis, and the four bases are the
 * four honest answers: a person recorded it, it was read off the pack, a source published it, or
 * Kynviora worked it out. A fact nobody has is `NOT_KNOWN` and stays on the screen saying so,
 * because a missing row reads as "not relevant" rather than as "not known".
 *
 * AN EXPLANATION TEMPLATE THIS BUILD DOES NOT HAVE IS NOT IMPROVISED
 * `assessment_rule_version.explanation_template_id` is a free-text column and the assessment
 * freezes whatever the rule named. If that identifier is not one of the approved templates here,
 * the detail renders {@link UNEXPLAINABLE} - the facts, the states and the correction actions,
 * and no narrative. A generic "a safety rule matched this item" would be a sentence about
 * somebody's medicine that no reviewer wrote, which is what `10`'s content review exists to
 * prevent. `23` D-014's rule applied to prose.
 */

import {
  isActionUrgency,
  isEvidenceLevel,
  isMatchConfidence,
  type ActionUrgency,
  type EvidenceLevel,
  type MatchConfidence,
} from '@kynviora/domain';
import {
  batchRecallMessage,
  expiryMessage,
  ingredientSensitivityMessage,
  renderSafetyMessage,
  type SafetyMessage,
} from './copy.js';
import {
  presentEvidenceLevel,
  presentMatchConfidence,
  presentUrgency,
  type StatusPresentation,
} from './status.js';

// ---------------------------------------------------------------------------
// Where a fact came from
// ---------------------------------------------------------------------------

/**
 * How Kynviora came to hold one fact.
 *
 * Closed, and deliberately four rather than two. "Known versus inferred" is the criterion, but
 * splitting *known* into what a person typed, what was read off the pack, and what a regulator
 * published is what lets a reader judge the alert: a batch number somebody typed and a batch
 * number read from the label are different kinds of evidence for the same claim.
 */
export const FACT_BASES = [
  'RECORDED_BY_A_PERSON',
  'READ_FROM_THE_PACK',
  'PUBLISHED_BY_A_SOURCE',
  'COMPUTED_BY_KYNVIORA',
  'NOT_KNOWN',
  // Kynviora holds it and this session may not see it. Distinct from `NOT_KNOWN` because the
  // two are opposite facts: one says the data is missing, the other says it exists and is being
  // kept back. A caregiver holding VIEW_SAFETY and not VIEW_MEDICINES reads an alert about a
  // medicine whose name they may not have (`03` group H), and DEC-026 already settled that the
  // withholding is reported rather than shown as a blank.
  'WITHHELD_FROM_THIS_SESSION',
] as const;
export type FactBasis = (typeof FACT_BASES)[number];

/**
 * What each basis says, in words a household reads.
 *
 * A total record, so a new basis is a sentence somebody writes rather than a blank on the screen.
 */
export const FACT_BASIS_TEXT: Readonly<Record<FactBasis, string>> = Object.freeze({
  RECORDED_BY_A_PERSON: 'You or a caregiver entered this.',
  READ_FROM_THE_PACK: 'This was read from the packaging.',
  PUBLISHED_BY_A_SOURCE: 'A regulator or official source published this.',
  COMPUTED_BY_KYNVIORA: 'Kynviora worked this out from the rest.',
  NOT_KNOWN: 'Kynviora does not have this.',
  WITHHELD_FROM_THIS_SESSION: 'Kynviora has this and your access does not include it.',
});

/** Whether a basis is something Kynviora derived rather than something it was told. */
export function isInferred(basis: FactBasis): boolean {
  return basis === 'COMPUTED_BY_KYNVIORA';
}

export interface AlertFact {
  readonly label: string;
  /** The value, or `null` where there is none. `null` is rendered, not hidden. */
  readonly value: string | null;
  readonly basis: FactBasis;
  readonly basisText: string;
}

function fact(label: string, value: string | null, basis: FactBasis): AlertFact {
  // A value nobody has is `NOT_KNOWN` whatever the caller claimed. Otherwise a missing batch
  // number would be presented as something a person recorded, which is the opposite of true.
  // `WITHHELD_FROM_THIS_SESSION` is passed explicitly and is never inferred from an absent
  // value, because the caller is the only thing that knows which of the two happened.
  const missing = value === null || value.trim() === '';
  const resolved: FactBasis =
    basis === 'WITHHELD_FROM_THIS_SESSION' ? basis : missing ? 'NOT_KNOWN' : basis;
  return {
    label,
    value: resolved === 'NOT_KNOWN' || resolved === 'WITHHELD_FROM_THIS_SESSION' ? null : value,
    basis: resolved,
    basisText: FACT_BASIS_TEXT[resolved],
  };
}

// ---------------------------------------------------------------------------
// The approved explanation templates
// ---------------------------------------------------------------------------

/**
 * The template identifiers this build can render.
 *
 * A closed list checked against the identifier frozen on the assessment. The column is free text
 * because a rule names its own template, and this is the boundary where an unrecognised name
 * becomes an absence of prose rather than an improvised sentence.
 */
export const EXPLANATION_TEMPLATE_IDS = [
  'tpl.batch',
  'tpl.ingredient_sensitivity',
  'tpl.expiry',
] as const;
export type ExplanationTemplateId = (typeof EXPLANATION_TEMPLATE_IDS)[number];

export function isExplanationTemplateId(raw: string): raw is ExplanationTemplateId {
  return (EXPLANATION_TEMPLATE_IDS as readonly string[]).includes(raw);
}

/**
 * Everything a template might need, gathered by the caller.
 *
 * One shape for all three rather than a discriminated union per template, because the route
 * assembles one row and does not know which template the assessment froze. A field a template
 * does not use is ignored; a field it needs and does not get produces the honest branch of that
 * template's own copy, which each one already has.
 */
export interface ExplanationContext {
  readonly personName: string;
  readonly itemName: string;
  readonly matchConfidence: MatchConfidence;
  /** Recall context. */
  readonly authority: string | null;
  readonly jurisdictionName: string | null;
  readonly publicationDate: string | null;
  readonly lotCode: string | null;
  /** Sensitivity context. */
  readonly ingredientName: string | null;
  readonly recordedTerm: string | null;
  readonly formulationConfirmedFromLabel: boolean;
  /** Expiry context. */
  readonly expiresOn: string | null;
  readonly hasExpired: boolean;
}

/**
 * Render the approved message for a template, or `null`.
 *
 * `null` where the identifier is unknown **or** where the template's own required context is
 * missing. The second case matters as much as the first: `batchRecallMessage` would happily
 * produce "null published a notice" from an absent authority, and a sourceless claim about a
 * recall is worse than no narrative at all.
 */
export function explanationFor(
  templateId: string,
  context: ExplanationContext,
): SafetyMessage | null {
  if (!isExplanationTemplateId(templateId)) return null;

  switch (templateId) {
    case 'tpl.batch': {
      if (
        context.authority === null ||
        context.jurisdictionName === null ||
        context.publicationDate === null
      ) {
        return null;
      }
      return batchRecallMessage({
        personName: context.personName,
        itemName: context.itemName,
        matchConfidence: context.matchConfidence,
        authority: context.authority,
        jurisdictionName: context.jurisdictionName,
        publicationDate: context.publicationDate,
        lotCode: context.lotCode,
      });
    }
    case 'tpl.ingredient_sensitivity': {
      if (context.ingredientName === null || context.recordedTerm === null) return null;
      return ingredientSensitivityMessage({
        personName: context.personName,
        itemName: context.itemName,
        ingredientName: context.ingredientName,
        recordedTerm: context.recordedTerm,
        formulationConfirmedFromLabel: context.formulationConfirmedFromLabel,
      });
    }
    case 'tpl.expiry': {
      if (context.expiresOn === null) return null;
      return expiryMessage({
        personName: context.personName,
        itemName: context.itemName,
        expiresOn: context.expiresOn,
        hasExpired: context.hasExpired,
      });
    }
  }
}

/** What a screen says where no approved template applies. */
export const UNEXPLAINABLE = Object.freeze({
  heading: 'Kynviora cannot explain this one in full',
  body:
    'This alert was produced by a rule whose approved wording is not part of this build, so ' +
    'Kynviora will not write an explanation of its own. Everything it does know is listed below. ' +
    'If this concerns you, take it to a pharmacist with the details on this page.',
});

// ---------------------------------------------------------------------------
// The source line
// ---------------------------------------------------------------------------

/**
 * Whether a source reference may be shown.
 *
 * `04` Phase 7.3 asks for a "source link/retained reference **where allowed**", and `25` makes
 * that a licensing question rather than a technical one: `BLK-005` records that no per-source
 * legal review has been performed, and `license_review_state` defaults to `NOT_REVIEWED`. So the
 * reference is withheld unless the review says otherwise, and the screen says it is withheld
 * rather than leaving a gap that reads as "there is no source".
 */
export const LICENSE_STATES_ALLOWING_REFERENCE: readonly string[] = Object.freeze(['APPROVED']);

export interface SourceLineInput {
  readonly organization: string | null;
  readonly sourceName: string | null;
  readonly jurisdiction: string | null;
  readonly legalReference: string | null;
  readonly publicationDate: string | null;
  readonly effectiveDate: string | null;
  readonly licenseReviewState: string | null;
  readonly requiredAttribution: string | null;
}

export interface SourceLineView {
  /** Who published it, or `null` where the alert rests on no external source at all. */
  readonly organization: string | null;
  readonly sourceName: string | null;
  readonly jurisdiction: string | null;
  /** The legal reference, shown only where licence review permits it. */
  readonly reference: string | null;
  /** Why the reference is absent, when it is. */
  readonly referenceWithheldBecause: string | null;
  readonly publishedOn: string | null;
  readonly effectiveFrom: string | null;
  /** `25`: attribution the licence requires, rendered wherever the reference is. */
  readonly attribution: string | null;
  /** A single sentence, for a screen that wants one line. */
  readonly summary: string;
}

export function sourceLineView(input: SourceLineInput): SourceLineView {
  const hasSource = input.organization !== null && input.organization.trim() !== '';

  const allowed =
    input.licenseReviewState !== null &&
    LICENSE_STATES_ALLOWING_REFERENCE.includes(input.licenseReviewState);

  const reference = allowed ? input.legalReference : null;

  let withheld: string | null = null;
  if (hasSource && input.legalReference !== null && !allowed) {
    withheld =
      'The exact legal reference is withheld until the licence review for this source is ' +
      'complete (BLK-005). The publisher and the date are not restricted.';
  }

  const summary = hasSource
    ? [
        input.organization,
        input.sourceName,
        input.jurisdiction,
        input.publicationDate === null ? null : `published ${input.publicationDate}`,
      ]
        .filter((part): part is string => part !== null && part.trim() !== '')
        .join(', ')
    : 'This alert does not rest on an external published source. It comes from what is recorded ' +
      'on this item and this profile.';

  return {
    organization: hasSource ? input.organization : null,
    sourceName: input.sourceName,
    jurisdiction: input.jurisdiction,
    reference,
    referenceWithheldBecause: withheld,
    publishedOn: input.publicationDate,
    effectiveFrom: input.effectiveDate,
    attribution: allowed ? input.requiredAttribution : null,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Match reasons
// ---------------------------------------------------------------------------

/**
 * What each recorded match reason means, in words.
 *
 * `04` Phase 7.3 lists "reason for match" as required output, and `profile_assessment.reasons` is
 * a machine vocabulary. A reason this build has no sentence for is **dropped and counted**, for
 * the same reason an undescribed regulatory status is (DEC-065): a bare `DUPLICATE_ACTIVE_KEY` on
 * a safety screen is worse than an omission the screen admits to.
 */
export const MATCH_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  BATCH_CODE_MATCHED: 'The batch or lot number recorded for this pack is named in the notice.',
  GTIN_MATCHED_BATCH_UNKNOWN:
    'The product barcode matches the one named, but no batch number is recorded for this pack, so Kynviora cannot tell whether yours is one of the batches affected.',
  FORMULATION_MATCHED: 'The exact formulation recorded for this item is the one named.',
  SUBSTANCE_IN_DECLARATION:
    'A substance this rule is about appears in the ingredient list recorded for this product.',
  PRODUCT_EXPIRED: 'The expiry date recorded for this item has passed.',
  PRODUCT_EXPIRING_SOON: 'The expiry date recorded for this item is close.',
});

/**
 * Keyed by string rather than by the engine's `MatchReason` union, on purpose.
 *
 * The union lives in `@kynviora/safety`, which is the server-side rule engine, and DEC-010 says
 * the mobile client must never gain a rule-evaluation code path. Importing the type would pull
 * the engine into a bundle that ships to a phone. The completeness check lives in the API suite
 * instead, where both packages are already present - so a new match reason without approved
 * wording fails a test rather than reaching a screen as a code.
 */

export interface MatchReasonsView {
  readonly reasons: readonly string[];
  /** Reasons this build has no wording for. Counted rather than shown as codes. */
  readonly undescribedCount: number;
  readonly undescribedNote: string | null;
}

export function matchReasonsView(reasons: readonly string[]): MatchReasonsView {
  const described: string[] = [];
  let undescribed = 0;

  for (const reason of reasons) {
    const text = MATCH_REASON_TEXT[reason];
    if (text === undefined) undescribed += 1;
    else described.push(text);
  }

  return {
    reasons: described,
    undescribedCount: undescribed,
    undescribedNote:
      undescribed === 0
        ? null
        : `Kynviora recorded ${String(undescribed)} further ${
            undescribed === 1 ? 'reason' : 'reasons'
          } for this match that this version has no plain wording for. A pharmacist can be shown the alert reference below.`,
  };
}

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------

/** What a person may do about an alert from the detail screen. */
export const ALERT_ACTIONS = ['REPORT_INCORRECT_MATCH'] as const;
export type AlertAction = (typeof ALERT_ACTIONS)[number];

export interface AlertActionView {
  readonly action: AlertAction;
  readonly label: string;
  readonly explanation: string;
}

/**
 * The correction action `04` Phase 7.3 requires.
 *
 * One action, not a resolution menu: Phase 7.6 owns the resolution vocabulary, and offering
 * "reviewed" or "disposed of" here would be that phase built early and in the wrong place. What
 * 7.3 owes the reader is a way to say the alert is *wrong*, which is feedback about Kynviora
 * rather than a record of what they did.
 */
export const REPORT_INCORRECT_ACTION: AlertActionView = Object.freeze({
  action: 'REPORT_INCORRECT_MATCH',
  label: 'This does not match my product',
  explanation:
    'Telling Kynviora the match is wrong records that on this alert. It does not delete the ' +
    'alert or the assessment behind it, and it does not change anything a regulator published.',
});

export interface AlertDetailInput {
  readonly alertPublicationId: string;
  readonly state: string;
  readonly publishedAt: string;
  readonly withdrawnAt: string | null;
  readonly withdrawnReason: string | null;

  /**
   * The affected person, or `null` where this session may not see the profile.
   *
   * `04` Phase 7.3 requires the person and the item to be named. `03` group H requires safety
   * access and shelf access to be separate permissions, and both are true at once for a
   * caregiver holding one and not the other - so the field is nullable and the absence is
   * reported rather than papered over.
   */
  readonly personName: string | null;
  readonly itemName: string | null;
  readonly itemBrand: string | null;

  readonly matchConfidence: string;
  readonly evidenceLevel: string;
  readonly urgency: string;
  readonly reasons: readonly string[];
  readonly explanationTemplateId: string;
  readonly evaluatedAt: string;

  readonly lotCode: string | null;
  readonly lotFromLabel: boolean;
  readonly expiresOn: string | null;
  readonly hasExpired: boolean;
  readonly ingredientName: string | null;
  readonly recordedTerm: string | null;
  readonly formulationConfirmedFromLabel: boolean;

  readonly source: SourceLineInput;
  /** Jurisdictions Kynviora monitors, for the coverage statement `09` requires. */
  readonly monitoredJurisdictions: readonly string[];
  /** Whether this alert already carries a reported-incorrect record. */
  readonly alreadyReportedIncorrect: boolean;
}

export interface AlertDetailView {
  readonly alertPublicationId: string;
  /** Whether this alert is still live. A withdrawn one is readable and must not look live. */
  readonly isLive: boolean;
  readonly withdrawnNotice: string | null;

  /** The approved eight-part message, in `18`'s order, or `null`. */
  readonly message: readonly string[] | null;
  readonly unexplainable: { readonly heading: string; readonly body: string } | null;
  /** Set where part of this alert is being kept from this session, and says which part. */
  readonly withheldNotice: string | null;

  /** Separate presentations. Never merged, never scored. */
  readonly urgency: StatusPresentation;
  readonly evidence: StatusPresentation;
  readonly matchConfidence: StatusPresentation;

  readonly facts: readonly AlertFact[];
  readonly reasons: MatchReasonsView;
  readonly source: SourceLineView;
  readonly coverageStatement: string;

  /** What the screen says about known versus inferred, derived from the facts themselves. */
  readonly inferredCount: number;
  readonly basisNote: string;

  /** The correction action, or why it is not offered. */
  readonly actions: readonly AlertActionView[];
  readonly actionsUnavailableBecause: string | null;
}

/**
 * Narrow a match confidence, claiming least on an unrecognised value.
 *
 * `NOT_MATCHED` rather than `EXACT`, exactly as the household client narrows every other facet
 * (DEC-040). An alert whose confidence this build cannot read is not a confident one.
 */
function asMatchConfidence(raw: string): MatchConfidence {
  return isMatchConfidence(raw) ? raw : 'NOT_MATCHED';
}

function asEvidenceLevel(raw: string): EvidenceLevel {
  return isEvidenceLevel(raw) ? raw : 'U';
}

/**
 * Narrow an urgency.
 *
 * `INFORMATIONAL` on an unrecognised value, which is the exception to claiming least: a false
 * alarm carrying a medicine's name is the worse failure, and the same choice is already made in
 * the household client (DEC-040).
 */
function asActionUrgency(raw: string): ActionUrgency {
  return isActionUrgency(raw) ? raw : 'INFORMATIONAL';
}

/** Coverage statement, per `09`. Stated on the detail as well as on the inbox. */
function coverageFor(jurisdictions: readonly string[]): string {
  if (jurisdictions.length === 0) {
    return 'Kynviora is not currently monitoring regulatory sources for this product, so this alert is not a complete picture.';
  }
  return `Kynviora currently monitors sources for ${jurisdictions.join(
    ', ',
  )}. It does not cover every source, product or country, and this alert reflects only what it monitors.`;
}

export function alertDetailView(input: AlertDetailInput): AlertDetailView {
  const matchConfidence = asMatchConfidence(input.matchConfidence);
  const evidenceLevel = asEvidenceLevel(input.evidenceLevel);
  const urgency = asActionUrgency(input.urgency);

  const personWithheld = input.personName === null;
  const itemWithheld = input.itemName === null;
  const anythingWithheld = personWithheld || itemWithheld;

  // Every approved template names the person and the item in its first two sentences. Rendering
  // one with a placeholder would put a phrase nobody reviewed into approved copy, so a withheld
  // half means no narrative rather than a narrative with a hole in it.
  const message = anythingWithheld
    ? null
    : explanationFor(input.explanationTemplateId, {
        personName: input.personName ?? '',
        itemName: input.itemName ?? '',
        matchConfidence,
        authority: input.source.organization,
        jurisdictionName: input.source.jurisdiction,
        publicationDate: input.source.publicationDate,
        lotCode: input.lotCode,
        ingredientName: input.ingredientName,
        recordedTerm: input.recordedTerm,
        formulationConfirmedFromLabel: input.formulationConfirmedFromLabel,
        expiresOn: input.expiresOn,
        hasExpired: input.hasExpired,
      });

  const facts: readonly AlertFact[] = [
    // `04` Phase 7.3's first requirement: the affected person and the exact item, named.
    fact(
      'Person',
      input.personName,
      personWithheld ? 'WITHHELD_FROM_THIS_SESSION' : 'RECORDED_BY_A_PERSON',
    ),
    fact(
      'Item',
      input.itemName,
      itemWithheld ? 'WITHHELD_FROM_THIS_SESSION' : 'RECORDED_BY_A_PERSON',
    ),
    fact(
      'Brand',
      input.itemBrand,
      itemWithheld ? 'WITHHELD_FROM_THIS_SESSION' : 'RECORDED_BY_A_PERSON',
    ),
    fact(
      'Batch or lot',
      input.lotCode,
      itemWithheld
        ? 'WITHHELD_FROM_THIS_SESSION'
        : input.lotFromLabel
          ? 'READ_FROM_THE_PACK'
          : 'RECORDED_BY_A_PERSON',
    ),
    fact('Expiry date', input.expiresOn, 'RECORDED_BY_A_PERSON'),
    fact(
      'Ingredient involved',
      input.ingredientName,
      input.formulationConfirmedFromLabel ? 'READ_FROM_THE_PACK' : 'RECORDED_BY_A_PERSON',
    ),
    fact('Sensitivity recorded on this profile', input.recordedTerm, 'RECORDED_BY_A_PERSON'),
    fact('Published by', input.source.organization, 'PUBLISHED_BY_A_SOURCE'),
    fact('Source published on', input.source.publicationDate, 'PUBLISHED_BY_A_SOURCE'),
    // The three Kynviora worked out. Grouped last and labelled as such, so a reader can see at a
    // glance which part of this page is the software's opinion.
    fact(
      'How exact the match is',
      presentMatchConfidence(matchConfidence).label,
      'COMPUTED_BY_KYNVIORA',
    ),
    fact('When Kynviora checked', input.evaluatedAt, 'COMPUTED_BY_KYNVIORA'),
    fact('Alert reference', input.alertPublicationId, 'COMPUTED_BY_KYNVIORA'),
  ];

  const isLive = input.state === 'PUBLISHED';

  return {
    alertPublicationId: input.alertPublicationId,
    isLive,
    withdrawnNotice: isLive
      ? null
      : 'This alert has been withdrawn and is kept here as a record. Do not act on it. ' +
        (input.withdrawnReason === null
          ? 'No reason was recorded.'
          : `Reason given: ${input.withdrawnReason}`),
    message: message === null ? null : renderSafetyMessage(message),
    // A withheld half is not an unexplainable alert - Kynviora can explain it perfectly well and
    // is not showing this session all of it. Saying "cannot explain" here would blame the build
    // for an access decision.
    unexplainable: message === null && !anythingWithheld ? UNEXPLAINABLE : null,
    withheldNotice: !anythingWithheld
      ? null
      : 'Part of this alert is not shown here. Your access covers safety updates and not the ' +
        (itemWithheld && personWithheld
          ? 'shelf or the profile it is about'
          : itemWithheld
            ? 'shelf it is about'
            : 'profile it is about') +
        ', so Kynviora is withholding those details rather than leaving them blank. The person ' +
        'who owns this profile sees the whole alert.',
    urgency: presentUrgency(urgency),
    evidence: presentEvidenceLevel(evidenceLevel),
    matchConfidence: presentMatchConfidence(matchConfidence),
    facts,
    reasons: matchReasonsView(input.reasons),
    source: sourceLineView(input.source),
    coverageStatement: coverageFor(input.monitoredJurisdictions),
    inferredCount: facts.filter((entry) => isInferred(entry.basis)).length,
    basisNote:
      'Every line above says where it came from. The ones marked as worked out by Kynviora are ' +
      'the ones it decided rather than was told.',
    // A withdrawn alert takes no feedback: there is nothing live to correct, and a report against
    // it would be recorded as though it were.
    actions: !isLive || input.alreadyReportedIncorrect ? [] : [REPORT_INCORRECT_ACTION],
    actionsUnavailableBecause: !isLive
      ? 'This alert has been withdrawn, so there is nothing to report about it.'
      : input.alreadyReportedIncorrect
        ? 'You have already told Kynviora this match is wrong. That is recorded on this alert.'
        : null,
  };
}
