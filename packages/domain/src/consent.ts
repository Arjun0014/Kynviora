/**
 * Consent as a product state, and what withdrawing one actually stops.
 *
 * Spec references: `04` Phase 1.4 (versioned consent receipts; separate consent categories for
 * profile data, notifications, caregiver sharing, diagnostics/analytics and future connected-health
 * data; withdrawal flows; export/deletion shell - with the exit criteria "revoking optional consent
 * disables the associated behavior" and "consent state is auditable and localizable"), `16`
 * (consent, data minimisation), `14`, `10`, `09`, `18`.
 *
 * THE EXIT CRITERION IS ABOUT BEHAVIOUR, NOT ABOUT A RECORD
 * "Revoking optional consent disables the associated behavior" is not satisfied by writing a row.
 * `consent_receipt` has existed since migration `0002`, append-only with supersession, and nothing
 * had ever read it - which is a consent *log*, not a consent *state*. What makes it a state is
 * {@link CONSENT_ENFORCEMENT}: a total record over the vocabulary saying, for each purpose,
 * whether this build actually stops anything when it is withdrawn.
 *
 * TWO OF EIGHT ENFORCE SOMETHING, AND THE SCREEN SAYS WHICH
 * `NOTIFICATIONS` and `CAREGIVER_SHARING` change what `selectRecipients` does. The other five
 * optional purposes gate behaviour this build does not have - there is no analytics, no OCR
 * (`BLK-007`), no connected-health integration, no research programme, and manual entry
 * deliberately never reaches the shared catalog. Offering a person a switch that stops nothing and
 * saying nothing about it would be the `10` failure this codebase spends the most care avoiding:
 * they would believe they had turned something off. `DEV-036` records it and the copy states it.
 *
 * WITHDRAWING NOTIFICATIONS STOPS EVERY NOTIFICATION, INCLUDING A CRITICAL ONE
 * This is the one that could reasonably have gone the other way, and it did not. Quiet hours are a
 * timing preference and a `CRITICAL` alert pierces them (DEC-078); consent is the basis on which
 * Kynviora may contact somebody at all, and continuing to send to a person who said stop is not a
 * safety feature, it is sending without consent. So the withdrawal is absolute, and the sentence
 * above the control says so before it is pressed - the same rule DEC-084 keeps for archiving an
 * item, which turns the safety watch off.
 *
 * A RECEIPT IS NEVER EDITED
 * `consent_receipt` is append-only by trigger and refuses UPDATE and DELETE to every role.
 * Withdrawing writes a **new** row with `granted = false` that supersedes the previous one, so the
 * history of what somebody agreed to and when is not something a later version of this product can
 * quietly rewrite. That is the "auditable" half of the second exit criterion, and it is the
 * database's property rather than this module's promise.
 */

import { domainError, err, ok, type DomainError, type Result } from './result.js';

/**
 * The purposes a person may be asked about.
 *
 * Migration `0002`'s `consent_purpose_valid`, transcribed, and a test asserts they agree. A purpose
 * the domain offers and the database refuses is a switch somebody flips that cannot be saved.
 */
export const CONSENT_PURPOSES = [
  'PROFILE_DATA',
  'CAREGIVER_SHARING',
  'NOTIFICATIONS',
  'DIAGNOSTICS_ANALYTICS',
  'DOCUMENT_IMAGE_PROCESSING',
  'CATALOG_CONTRIBUTION',
  'CONNECTED_HEALTH_DATA',
  'RESEARCH_PROGRAMME',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export function isConsentPurpose(value: unknown): value is ConsentPurpose {
  return typeof value === 'string' && (CONSENT_PURPOSES as readonly string[]).includes(value);
}

/**
 * What withdrawing a purpose actually stops in **this** build.
 *
 *  - `ENFORCED` - something in the code path checks it and behaves differently.
 *  - `NOTHING_TO_STOP` - the behaviour it would govern does not exist here, so withdrawing it
 *    changes nothing. Recorded rather than hidden: a switch that stops nothing while the screen
 *    implies otherwise is worse than no switch.
 *  - `REQUIRED` - the product cannot run without it, so it is not offered as a choice at all
 *    rather than offered and refused.
 */
export const CONSENT_ENFORCEMENT = Object.freeze({
  // Everything Kynviora holds about a person hangs off this. Withdrawing it is deletion, which is
  // a retention decision this build has not made (`DEV-032`, `DEV-034`) - so it is not offered as
  // a switch that would have to refuse, which is DEC-045's rule for a control with one outcome.
  PROFILE_DATA: 'REQUIRED',
  // `selectRecipients` excludes every caregiver recipient. It does not stop a caregiver *reading*
  // what they already have access to - removing that is revoking the grant, which is a different
  // control - and the copy says exactly that rather than implying more.
  CAREGIVER_SHARING: 'ENFORCED',
  // `selectRecipients` excludes this person entirely, owner included. See the module note.
  NOTIFICATIONS: 'ENFORCED',
  // There is no analytics or telemetry in this build. Nothing is collected, so nothing stops.
  DIAGNOSTICS_ANALYTICS: 'NOTHING_TO_STOP',
  // `BLK-007`: no OCR or multimodal extraction provider. No image is ever processed.
  DOCUMENT_IMAGE_PROCESSING: 'NOTHING_TO_STOP',
  // A manual entry never reaches the shared catalog by construction (`15` A11), consent or not.
  CATALOG_CONTRIBUTION: 'NOTHING_TO_STOP',
  CONNECTED_HEALTH_DATA: 'NOTHING_TO_STOP',
  RESEARCH_PROGRAMME: 'NOTHING_TO_STOP',
} as const) satisfies Readonly<Record<ConsentPurpose, ConsentEnforcement>>;

export type ConsentEnforcement = 'ENFORCED' | 'NOTHING_TO_STOP' | 'REQUIRED';

/** Whether a person may choose about this purpose at all. */
export function isOptionalConsent(purpose: ConsentPurpose): boolean {
  return CONSENT_ENFORCEMENT[purpose] !== 'REQUIRED';
}

/** Whether withdrawing it stops anything in this build. */
export function consentEnforcement(purpose: ConsentPurpose): ConsentEnforcement {
  return CONSENT_ENFORCEMENT[purpose];
}

/**
 * The version of the policy text a receipt was recorded against.
 *
 * Stored on every row, because "auditable" means being able to say *what* somebody agreed to and
 * not only that they did. It is a constant rather than a lookup because there is one policy text
 * in this build; when there are two, this becomes the key that says which one a receipt is about
 * and the old receipts keep pointing at the old one.
 */
export const CONSENT_POLICY_VERSION = '2026-09-02.1';

/** One recorded decision, as it comes off the table. */
export interface ConsentReceipt {
  readonly purpose: string;
  readonly granted: boolean;
  readonly policyVersion: string;
  readonly locale: string;
  readonly recordedAt: string;
}

/** What is in force for one purpose. */
export interface ConsentStanding {
  readonly purpose: ConsentPurpose;
  /**
   * Whether it is granted right now.
   *
   * `false` where nobody has ever answered. Deny by default (`14`): an absent receipt is not
   * agreement, and treating silence as consent is the single failure `16` exists to prevent.
   */
  readonly granted: boolean;
  /** Whether anybody has ever answered. Distinct from having answered "no". */
  readonly everAnswered: boolean;
  /** The policy version the standing answer was recorded against, or `null`. */
  readonly policyVersion: string | null;
  readonly recordedAt: string | null;
  readonly enforcement: ConsentEnforcement;
  /**
   * Whether the standing answer predates the current policy text.
   *
   * `false` where nobody has answered - an unanswered purpose is not a stale one, and saying
   * otherwise would ask somebody to re-confirm something they never confirmed.
   */
  readonly stale: boolean;
}

/**
 * What is in force, for every purpose.
 *
 * The latest receipt per purpose wins, by `recordedAt`. Supersession is recorded in the table as
 * well (`supersedes_id`), and this deliberately does not follow that chain: a chain with a broken
 * link would produce no answer at all, and "no answer" here means "not granted" - the safe
 * direction, but the wrong reason. Reading the newest row is the answer that stays correct when
 * the chain does not.
 *
 * Ties go to neither: two receipts at the same instant for the same purpose is a state nothing
 * writes, and picking one would be inventing an order. The **withdrawal** wins, because a person
 * who both granted and withdrew at the same moment has said something Kynviora must not resolve
 * in its own favour.
 */
export function consentStateFrom(
  receipts: readonly ConsentReceipt[],
  policyVersion: string = CONSENT_POLICY_VERSION,
): readonly ConsentStanding[] {
  const latest = new Map<ConsentPurpose, ConsentReceipt>();

  for (const receipt of receipts) {
    if (!isConsentPurpose(receipt.purpose)) continue;
    const current = latest.get(receipt.purpose);
    if (current === undefined) {
      latest.set(receipt.purpose, receipt);
      continue;
    }
    const newer = Date.parse(receipt.recordedAt) - Date.parse(current.recordedAt);
    if (newer > 0 || (newer === 0 && !receipt.granted)) {
      latest.set(receipt.purpose, receipt);
    }
  }

  return CONSENT_PURPOSES.map((purpose) => {
    const receipt = latest.get(purpose);
    const enforcement = CONSENT_ENFORCEMENT[purpose];

    if (receipt === undefined) {
      return {
        purpose,
        // Never granted, because nobody said so. `PROFILE_DATA` is not exempt: it is required to
        // use the product, and "required" is a statement about what the product needs rather than
        // a licence to assume an answer.
        granted: false,
        everAnswered: false,
        policyVersion: null,
        recordedAt: null,
        enforcement,
        stale: false,
      };
    }

    return {
      purpose,
      granted: receipt.granted === true,
      everAnswered: true,
      policyVersion: receipt.policyVersion,
      recordedAt: receipt.recordedAt,
      enforcement,
      stale: receipt.policyVersion !== policyVersion,
    };
  });
}

/** Whether one purpose is granted, from a computed state. */
export function isGranted(state: readonly ConsentStanding[], purpose: ConsentPurpose): boolean {
  return state.find((standing) => standing.purpose === purpose)?.granted === true;
}

// ---------------------------------------------------------------------------
// Recording a decision
// ---------------------------------------------------------------------------

/**
 * What somebody chose.
 *
 * There is deliberately no `policyVersion` and no `recordedAt`. Both are the server's: a client
 * that could name the policy version it agreed to could record agreement to a text nobody showed
 * them, and a client-set timestamp is an audit trail written by the thing being audited.
 */
export interface ConsentDecision {
  readonly purpose: string;
  readonly granted: boolean;
  /** The language the policy was read in. `16` asks for consent state to be localizable. */
  readonly locale?: string | null | undefined;
}

export interface NormalizedConsentDecision {
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly locale: string;
}

/** The locale a receipt records when the client did not say. Matches the column default. */
export const DEFAULT_CONSENT_LOCALE = 'en-IN';

/** A BCP 47 tag, loosely. The same shape the profile draft accepts, for the same reason. */
const LOCALE_SHAPE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

function invalid(reason: string, field: string): DomainError {
  return domainError('VALIDATION_FAILED', reason, { reason_code: 'consent', field });
}

/**
 * Check a decision.
 *
 * Refuses a purpose this build does not know rather than storing it: a receipt naming a purpose
 * nothing can enforce is a record of agreement to something undefined, which is worse than no
 * record. And refuses to withdraw a `REQUIRED` purpose, because there is no code path that would
 * honour it - a switch whose only outcome is a refusal is a control that should not be offered
 * (DEC-045), and a route that accepted it would be writing a receipt that says something untrue.
 */
export function normalizeConsentDecision(
  decision: ConsentDecision,
): Result<NormalizedConsentDecision, DomainError> {
  const purpose = typeof decision.purpose === 'string' ? decision.purpose.trim() : '';
  if (!isConsentPurpose(purpose)) {
    return err(invalid('That is not something Kynviora asks consent for.', 'purpose'));
  }

  if (typeof decision.granted !== 'boolean') {
    // Not coerced. "Yes" and "on" are not answers to a consent question, and a truthy value
    // arriving over the wire must not become agreement.
    return err(invalid('Say whether this is agreed to or not.', 'granted'));
  }

  if (!decision.granted && !isOptionalConsent(purpose)) {
    return err(
      domainError(
        'VALIDATION_FAILED',
        'Kynviora cannot keep your records without this. Removing your data is a separate thing, and it is not built yet.',
        { reason_code: 'consent_required', field: 'purpose', purpose },
      ),
    );
  }

  const locale =
    typeof decision.locale === 'string' && decision.locale.trim() !== ''
      ? decision.locale.trim()
      : DEFAULT_CONSENT_LOCALE;

  if (!LOCALE_SHAPE.test(locale)) {
    return err(invalid('A language looks like en-IN.', 'locale'));
  }

  return ok({ purpose, granted: decision.granted, locale });
}
