/**
 * What somebody has agreed to, as a screen renders it.
 *
 * Spec references: `04` Phase 1.4 (consent categories, withdrawal flows - with the exit criteria
 * "revoking optional consent disables the associated behavior" and "consent state is auditable and
 * localizable"), `10`, `16`, `14`.
 *
 * WHAT THIS DECIDES
 * Every sentence arrives from `@kynviora/presentation`. What this layer decides is which control a
 * screen may offer and which sentence goes beside it - and the wrong answer is a person believing
 * they turned something off.
 *
 * A PURPOSE THIS BUILD CANNOT READ IS DROPPED
 * A later version could record a purpose this client has never heard of. Rendering it would put a
 * bare code on a consent screen with no description of what is being agreed to, which is worse
 * than not showing it: a switch whose meaning nobody can state is not a choice (trap 129).
 *
 * AN ENFORCEMENT THIS BUILD CANNOT READ IS TREATED AS "STOPS NOTHING"
 * The pessimistic reading is the safe one. Telling somebody a switch may not do anything when it
 * does costs a moment's confusion; the opposite lets them believe they stopped something.
 */

import { isConsentPurpose, type ConsentEnforcement } from '@kynviora/domain';
import { CONSENT_COPY, presentConsentPurpose } from '@kynviora/presentation';
import type { ConsentStandingLine, ConsentsResponse } from './client.js';

export interface ConsentRowView {
  readonly purpose: string;
  readonly label: string;
  readonly description: string;
  /** What withdrawing it stops, in this build. Never empty. */
  readonly withdrawalEffect: string;
  readonly granted: boolean;
  /** Whether a screen may offer a control at all. `false` for the required purpose. */
  readonly mayChoose: boolean;
  /** Whether withdrawing it stops anything here. `false` where this build cannot say. */
  readonly enforcesSomething: boolean;
  /**
   * The short phrase beside the label, or `null` for a switch that does something.
   *
   * Decided here rather than on the screen. `apps/**` is outside the test run (`BLK-002`), so a
   * screen picking between two constants is a decision nothing ever checks - and the wrong pick
   * is a person told a switch matters when it does not.
   */
  readonly statusLabel: string | null;
  /**
   * What the control says, or `null` where there is no control.
   *
   * "Agree" where nothing is in force and "Turn this off" where something is, so the button names
   * what pressing it does rather than naming the setting. `null` for the required purpose, which
   * has no control at all.
   */
  readonly actionLabel: string | null;
  /**
   * The note about a purpose that stops nothing yet, or `null`.
   *
   * Present whenever the purpose is optional and enforces nothing, so a person can tell the two
   * switches that do something from the five that do not.
   */
  readonly notYetNote: string | null;
  /** Said where nobody has answered. Deny by default, stated rather than left to be discovered. */
  readonly neverAnsweredNote: string | null;
  /** Said where the standing answer predates the current policy text. */
  readonly staleNote: string | null;
}

export interface ConsentView {
  readonly rows: readonly ConsentRowView[];
  readonly policyVersion: string;
  /**
   * How many optional purposes stop nothing in this build.
   *
   * Reported so a screen can be honest about the shape of the list without counting. Not a
   * warning: it is the answer to "why do so few of these matter yet".
   */
  readonly notYetCount: number;
}

function enforcementOf(raw: string): ConsentEnforcement {
  return raw === 'ENFORCED' || raw === 'REQUIRED' ? raw : 'NOTHING_TO_STOP';
}

/** One purpose, as a row. */
export function consentRowView(line: ConsentStandingLine): ConsentRowView | null {
  if (!isConsentPurpose(line.purpose)) return null;

  const presented = presentConsentPurpose(line.purpose);
  const enforcement = enforcementOf(line.enforcement);
  const mayChoose = enforcement !== 'REQUIRED';
  const enforcesSomething = enforcement === 'ENFORCED';

  return {
    purpose: line.purpose,
    label: presented.label,
    description: presented.description,
    withdrawalEffect: presented.withdrawalEffect,
    granted: line.granted === true,
    mayChoose,
    enforcesSomething,
    notYetNote: mayChoose && !enforcesSomething ? CONSENT_COPY.notYetNote : null,
    statusLabel: !mayChoose
      ? CONSENT_COPY.requiredLabel
      : enforcesSomething
        ? null
        : CONSENT_COPY.notYetLabel,
    // Never offered for the required purpose: a control whose only outcome is a refusal is a
    // control that should not be there (DEC-045), and the domain refuses the write besides.
    actionLabel: !mayChoose
      ? null
      : line.granted === true
        ? CONSENT_COPY.withdrawLabel
        : CONSENT_COPY.grantLabel,
    // Only where they have genuinely never answered. Somebody who answered "no" has answered.
    neverAnsweredNote: line.everAnswered === true ? null : CONSENT_COPY.neverAnsweredNote,
    // An unanswered purpose is not a stale one - saying otherwise would ask somebody to
    // re-confirm something they never confirmed.
    staleNote: line.stale === true && line.everAnswered === true ? CONSENT_COPY.staleNote : null,
  };
}

/** The whole list. */
export function consentView(response: ConsentsResponse): ConsentView {
  const rows = (response.consents ?? []).flatMap((line) => {
    const row = consentRowView(line);
    return row === null ? [] : [row];
  });

  return {
    rows,
    policyVersion: typeof response.policyVersion === 'string' ? response.policyVersion : '',
    notYetCount: rows.filter((row) => row.mayChoose && !row.enforcesSomething).length,
  };
}
