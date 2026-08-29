/**
 * Safety copy: structure, controlled language, and forbidden claims.
 *
 * Spec references: `18` (safety copy structure, controlled language examples, forbidden
 * phrasing), `09` (medication safety language), `02` (anti-features), `24` (safety done
 * criteria).
 *
 * TWO MECHANISMS
 *
 *  1. **Structure.** `18` prescribes an eight-part order for a material alert. `SafetyMessage`
 *     has a field per part, so a template that omits "what this does not mean" fails to compile
 *     rather than shipping.
 *
 *  2. **Forbidden claims.** `18` and `02` enumerate phrasing Kynviora must never use - "this
 *     product is safe", "this medicine is dangerous", "AI detected...", and any unsanctioned
 *     instruction to stop a prescription medicine. {@link findForbiddenClaims} detects them and
 *     is run over every shipped template by test, so a reviewer is not the only line of defence.
 */

import type { ActionUrgency, EvidenceLevel, MatchConfidence } from '@kynviora/domain';

/**
 * A material safety message, in the order `18` prescribes.
 *
 * Every field is required. An alert with no stated limitation is exactly the over-confident
 * output the spec exists to prevent, so it cannot be constructed.
 */
export interface SafetyMessage {
  /** 1. What happened. */
  readonly whatHappened: string;
  /** 2. Which person and item this applies to. */
  readonly whoAndWhat: string;
  /** 3. How exact the match is. */
  readonly matchExactness: string;
  /** 4. What Kynviora recommends, within its allowed role. */
  readonly recommendedNextStep: string;
  /** 5. Why it was flagged. */
  readonly whyFlagged: string;
  /** 6. Evidence, source and date. */
  readonly evidenceAndSource: string;
  /** 7. Important limitation, or what not to infer. */
  readonly limitation: string;
  /** 8. How to correct or report it. */
  readonly correctionAction: string;
}

/** Ordered parts, for rendering and for the completeness test. */
export const SAFETY_MESSAGE_PARTS: readonly (keyof SafetyMessage)[] = Object.freeze([
  'whatHappened',
  'whoAndWhat',
  'matchExactness',
  'recommendedNextStep',
  'whyFlagged',
  'evidenceAndSource',
  'limitation',
  'correctionAction',
]);

/** Render a message in the prescribed order. */
export function renderSafetyMessage(message: SafetyMessage): readonly string[] {
  return SAFETY_MESSAGE_PARTS.map((part) => message[part]);
}

// ---------------------------------------------------------------------------
// Forbidden claims
// ---------------------------------------------------------------------------

export interface ForbiddenClaim {
  readonly rule: string;
  readonly matched: string;
  readonly reason: string;
}

interface ForbiddenPattern {
  readonly rule: string;
  readonly pattern: RegExp;
  readonly reason: string;
  /**
   * Whether a preceding negation flips the meaning and should suppress the match.
   *
   * Set on `no-safety-guarantee` only, and deliberately so. "This product is safe" is forbidden,
   * while "This does not mean the product is safe for everyone" is copy `09` and `18` explicitly
   * *require* - a detector without this distinction would make the mandated limitation wording
   * unwritable.
   *
   * It is **not** set on `no-danger-claim`, because negating that one produces "this product is
   * not dangerous", which is itself the universal safety verdict `23` D-005 forbids. Both the
   * assertion and its negation are claims Kynviora may not make, so both stay flagged.
   */
  readonly negationSensitive?: boolean;
}

/**
 * Negation cues that invert an assertion.
 *
 * Matched within a window before the phrase rather than immediately adjacent, because the
 * negation is usually several words away: "does **not** mean the product is safe".
 */
const NEGATION_CUES = /\b(?:not|never|cannot|can't|doesn't|isn't|aren't|no|without|nor|neither)\b/i;

/** How far back to look for a negation cue. */
const NEGATION_WINDOW_CHARS = 60;

function isNegated(text: string, matchIndex: number): boolean {
  const start = Math.max(0, matchIndex - NEGATION_WINDOW_CHARS);
  return NEGATION_CUES.test(text.slice(start, matchIndex));
}

/**
 * Phrasing Kynviora must never publish.
 *
 * Each entry cites the requirement it enforces. The patterns are deliberately narrow: they must
 * catch the forbidden *claim*, not the many legitimate sentences that mention safety - a rule
 * that fired on "This does not mean the product is safe" would make the required limitation copy
 * unwritable.
 */
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = Object.freeze([
  {
    rule: 'no-safety-guarantee',
    pattern: /\b(?:this|the)\s+(?:product|medicine|item|formulation)\s+is\s+safe\b/i,
    negationSensitive: true,
    reason:
      'Spec 18 forbids "This product is safe". Kynviora cannot establish universal safety, and spec 23 D-005 forbids a universal safety verdict.',
  },
  {
    rule: 'no-danger-claim',
    // The optional `not` is deliberate and is why this rule is not negation-sensitive: both
    // "this product is dangerous" and "this product is not dangerous" are universal verdicts
    // Kynviora may not make (spec 18 and 23 D-005). The negated form asserts safety.
    pattern:
      /\b(?:this|the)\s+(?:product|medicine|item|formulation)\s+is\s+(?:not\s+)?(?:dangerous|harmful|toxic|unsafe)\b/i,
    reason:
      'Spec 18 forbids "This medicine is dangerous". Kynviora reports a reviewed concern about a specific item and person, not a universal verdict.',
  },
  {
    rule: 'no-ai-attribution',
    // Spec 17: "Do not say 'AI verified this product' or 'AI says this ingredient is banned.'"
    pattern:
      /\b(?:AI|artificial intelligence|the model|our model|machine learning)\s+(?:detected|found|verified|says|determined|concluded|identified)\b/i,
    reason:
      'Spec 17 forbids attributing a finding to AI. Attribute facts to package evidence, a regulator, a manufacturer, an approved provider, or reviewed Kynviora policy.',
  },
  {
    rule: 'no-stop-medicine-instruction',
    // Spec 09: never tell a user to stop, start, split or replace a prescription medicine.
    pattern:
      /\b(?:stop|discontinue|quit)\s+(?:taking\s+)?(?:this|your|the)\s+(?:medicine|medication|tablet|drug|prescription)\b/i,
    reason:
      'Spec 09 and 24 forbid instructing a user to stop a prescription medicine. Direct them to the appropriate professional or official channel instead.',
  },
  {
    rule: 'no-start-medicine-instruction',
    pattern:
      /\b(?:start|begin)\s+(?:taking\s+)?(?:a\s+)?(?:new\s+)?(?:medicine|medication|drug|prescription)\b/i,
    reason: 'Spec 09 forbids instructing a user to start a medicine.',
  },
  {
    rule: 'no-dose-change-instruction',
    pattern:
      /\b(?:double|halve|increase|decrease|reduce|split|skip)\s+(?:your|the|this)\s+(?:dose|dosage)\b/i,
    reason: 'Spec 09 forbids instructing a user to change a dose or split a medicine.',
  },
  {
    rule: 'no-substitution-advice',
    pattern:
      /\b(?:switch|replace|substitute)\s+(?:to|with)?\s*(?:a\s+)?(?:different|another)\s+(?:medicine|medication|brand|product)\b/i,
    reason: 'Spec 09 and 02 forbid prescription substitution and unverified replacement advice.',
  },
  {
    rule: 'no-approval-from-absence',
    // Spec 23 D-014: absence of a matched rule must never render as approval.
    pattern:
      /\b(?:approved|permitted|legal|cleared)\s+(?:by|in)\s+(?:the\s+)?(?:FDA|EU|regulator)\b/i,
    reason:
      'Spec 23 D-014: Kynviora must never present an absence of a matched rule as regulatory approval.',
  },
  {
    rule: 'no-natural-equals-safe',
    pattern: /\b(?:chemical[- ]free|all[- ]natural|toxin[- ]free|100%\s+safe)\b/i,
    reason: 'Spec 02 lists "natural equals safe" and "chemical-free" claims as anti-features.',
  },
  {
    rule: 'no-jurisdiction-ranking',
    // Spec 09: "Avoid value judgments such as 'strict country' or 'weak regulation'."
    pattern:
      /\b(?:stricter|strictest|weaker|weakest|laxer|more lenient)\s+(?:country|countries|jurisdiction|jurisdictions|regulation|regulations)\b/i,
    reason:
      'Spec 09 forbids ranking jurisdictions as strict or weak. Show the actual regulatory difference instead.',
  },
  {
    rule: 'no-shaming',
    // Spec 18: "Do not shame missed medicines."
    pattern: /\byou\s+(?:failed|forgot|missed)\s+(?:again|to take)\b/i,
    reason: 'Spec 18 forbids shaming copy about missed medicines.',
  },
  {
    rule: 'no-diagnosis',
    pattern: /\byou\s+(?:have|may have|might have)\s+(?:a\s+)?(?:condition|disease|allergy to)\b/i,
    reason: 'Spec 01 and 17 forbid Kynviora from diagnosing or asserting a condition.',
  },
]);

/**
 * Find forbidden claims in a piece of user-facing copy.
 *
 * Returns every match rather than the first, so a reviewer sees the full picture in one pass.
 */
export function findForbiddenClaims(text: string): readonly ForbiddenClaim[] {
  const found: ForbiddenClaim[] = [];

  for (const { rule, pattern, reason, negationSensitive } of FORBIDDEN_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;

    // A negated assertion is not the forbidden claim - it is usually the required limitation.
    if (negationSensitive === true && isNegated(text, match.index)) continue;

    found.push({ rule, matched: match[0], reason });
  }

  return found;
}

/** Convenience predicate. */
export function containsForbiddenClaim(text: string): boolean {
  return findForbiddenClaims(text).length > 0;
}

/**
 * Check every part of a safety message.
 *
 * Applied to all shipped templates by test, so forbidden phrasing cannot reach a user through a
 * template nobody re-read.
 */
export function validateSafetyMessage(message: SafetyMessage): readonly ForbiddenClaim[] {
  return SAFETY_MESSAGE_PARTS.flatMap((part) => findForbiddenClaims(message[part]));
}

// ---------------------------------------------------------------------------
// Approved templates
// ---------------------------------------------------------------------------

export interface BatchRecallContext {
  readonly personName: string;
  readonly itemName: string;
  readonly matchConfidence: MatchConfidence;
  readonly authority: string;
  readonly jurisdictionName: string;
  readonly publicationDate: string;
  readonly lotCode: string | null;
}

/**
 * Batch recall alert.
 *
 * The action language is bounded: it tells the user to contact the pharmacy or supplier, which
 * is a step within Kynviora's role. It never says to stop a medicine, because `09` forbids that
 * and because whether to stop is a clinical decision.
 */
export function batchRecallMessage(context: BatchRecallContext): SafetyMessage {
  const exactness =
    context.matchConfidence === 'EXACT'
      ? `The batch number you recorded${context.lotCode ? ` (${context.lotCode})` : ''} is named in the notice.`
      : 'Kynviora has not recorded a batch number for your pack, so it cannot tell whether your pack is one of those affected.';

  return {
    whatHappened: `${context.authority} published a notice about specific batches of this product.`,
    whoAndWhat: `This is about ${context.itemName}, on ${context.personName}'s shelf.`,
    matchExactness: exactness,
    recommendedNextStep:
      'Contact the pharmacy or supplier you bought it from, and ask what they advise about this notice. If it is a prescription medicine, speak to your pharmacist or doctor before changing anything.',
    whyFlagged:
      'Kynviora matched the product details you recorded against the notice published by the regulator.',
    evidenceAndSource: `Source: ${context.authority}, ${context.jurisdictionName}, published ${context.publicationDate}.`,
    limitation:
      context.matchConfidence === 'EXACT'
        ? 'This notice covers the listed batches only. It is not a statement about the product in general.'
        : 'Your pack may not be affected. Adding the batch number from the packaging would let Kynviora check.',
    correctionAction:
      'If this is not the product you have, you can correct the item details or report the match as incorrect.',
  };
}

export interface IngredientSensitivityContext {
  readonly personName: string;
  readonly itemName: string;
  readonly ingredientName: string;
  readonly recordedTerm: string;
  readonly formulationConfirmedFromLabel: boolean;
}

/**
 * Reviewed ingredient sensitivity alert.
 *
 * `09`: "Do not generalize an ingredient regulatory difference into 'this brand is dangerous' or
 * 'unsafe for everyone'." The copy therefore names the exact ingredient, the exact recorded
 * sensitivity, and confines itself to those.
 */
export function ingredientSensitivityMessage(context: IngredientSensitivityContext): SafetyMessage {
  return {
    whatHappened: `This product's ingredient list includes ${context.ingredientName}.`,
    whoAndWhat: `This is about ${context.itemName}, on ${context.personName}'s shelf.`,
    matchExactness: context.formulationConfirmedFromLabel
      ? 'The ingredient list was confirmed from the label on this pack.'
      : 'The ingredient list has not been confirmed from your pack, so it may be out of date.',
    recommendedNextStep: `${context.personName} has "${context.recordedTerm}" recorded as a sensitivity. It is worth checking the label before using this product, and mentioning it at the next pharmacy or doctor visit if you are unsure.`,
    whyFlagged: `Kynviora matched ${context.ingredientName} in the ingredient list against the sensitivity recorded on this profile.`,
    evidenceAndSource:
      'Source: the ingredient list captured from this product, and the sensitivity recorded on this profile.',
    limitation:
      'An ingredient being present does not mean a reaction will happen. Kynviora does not know how much is in the product, and this is not a diagnosis.',
    correctionAction:
      'If the ingredient list is wrong or out of date, you can capture the label again. You can also mark this as not applicable.',
  };
}

export interface ExpiryContext {
  readonly personName: string;
  readonly itemName: string;
  readonly expiresOn: string;
  readonly hasExpired: boolean;
}

export function expiryMessage(context: ExpiryContext): SafetyMessage {
  return {
    whatHappened: context.hasExpired
      ? `The expiry date recorded for this item has passed (${context.expiresOn}).`
      : `The expiry date recorded for this item is coming up (${context.expiresOn}).`,
    whoAndWhat: `This is about ${context.itemName}, on ${context.personName}'s shelf.`,
    matchExactness: 'This is based on the expiry date recorded for this item.',
    recommendedNextStep: context.hasExpired
      ? 'Check the date printed on the packaging. If it has passed, ask your pharmacy how to dispose of it and whether you need a replacement.'
      : 'Check whether you need a replacement before this date.',
    whyFlagged: 'Kynviora compared the recorded expiry date with today.',
    evidenceAndSource: 'Source: the expiry date recorded for this item.',
    limitation:
      'Kynviora only knows the date that was entered. If it was entered incorrectly, this may not be right.',
    correctionAction: 'You can update the expiry date on the item.',
  };
}

/** Every shipped template, so the test suite can validate all of them. */
export const ALL_TEMPLATES = Object.freeze({
  batchRecall: batchRecallMessage,
  ingredientSensitivity: ingredientSensitivityMessage,
  expiry: expiryMessage,
});

// ---------------------------------------------------------------------------
// Supporting copy
// ---------------------------------------------------------------------------

/**
 * Default lock-screen notification body.
 *
 * `18`: "Kynviora has an important update." Deliberately reveals no medicine, product, condition
 * or person - `15` A6 is a notification leaking health information to a lock screen.
 */
export const GENERIC_NOTIFICATION_BODY = 'Kynviora has an important update.';

/** Coverage statement shown alongside any absence result (`09`). */
export function coverageDisclosure(monitoredJurisdictions: readonly string[]): string {
  if (monitoredJurisdictions.length === 0) {
    return 'Kynviora is not currently monitoring regulatory sources for this product.';
  }
  return `Kynviora currently monitors sources for ${monitoredJurisdictions.join(', ')}. It does not cover every source, product, or country, and a result of "nothing matched" is not a guarantee of safety.`;
}

/** Evidence-level and urgency labels, presented separately in a detail view (`07.1`). */
export function evidenceAndUrgencySummary(
  evidenceLevel: EvidenceLevel,
  urgency: ActionUrgency,
): { readonly evidence: string; readonly urgency: string } {
  // Two independent strings, never concatenated into one severity phrase. The separation is the
  // requirement (spec 23 D-005).
  const evidenceLabels: Record<EvidenceLevel, string> = {
    A: 'Official action',
    B: 'Established guidance',
    C: 'Strong reviewed evidence',
    D: 'Limited evidence',
    E: 'Emerging signal',
    U: 'Insufficient information',
  };
  const urgencyLabels: Record<ActionUrgency, string> = {
    CRITICAL: 'Time-sensitive',
    HIGH: 'Act soon',
    MEDIUM: 'Review soon',
    LOW: 'When convenient',
    INFORMATIONAL: 'For information',
  };

  return { evidence: evidenceLabels[evidenceLevel], urgency: urgencyLabels[urgency] };
}
