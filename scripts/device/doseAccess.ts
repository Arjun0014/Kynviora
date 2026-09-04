/**
 * What the dose-capability scenario's evidence means.
 *
 * Spec references: `19` ("Caregiver invite/revoke", "Record what happened"), `07` (the capability
 * vocabulary), `08.2` (capability scoping), `11` and `12` (access control is server-authoritative),
 * `18` (a person must understand what they are approving), `04` Phase 4.3, `DEV-049`, `BLK-011`,
 * DEC-116, migration `0021`.
 *
 * Kept apart from the runner so the judgements run in `npm run verify` with nothing attached
 * (DEC-102).
 *
 * WHAT THIS SCENARIO IS FOR
 * `RECORD_DOSES` exists because two shipped decisions contradicted each other: the policy scoped a
 * dose write by whether the caller could *reach* the medicine, and the invitation screen described
 * the grant that gave them that reach as allowing no changes at all. Somebody granted "Medicines"
 * could write into the history a doctor reads.
 *
 * Splitting it is therefore only half a fix. The other half is on a screen: the owner has to be
 * *offered* the choice, in words that say it is a change rather than a view - and a caregiver who
 * was not given it must not be shown a control whose write the server will refuse. Neither half is
 * visible from the API suite, and the second is not visible from the code at all.
 *
 * WHICH HALF IS DRIVEN WHERE, AND WHY
 * The **owner's** half is driven on the device, because that is where the consent happens: the
 * invitation form's checkbox, the review screen's grouping, and the dose control on the shelf row.
 * The **caregiver's** half is measured through the API from the host, as the second seeded
 * identity - the same division `verify:device:caregiver` makes and for the same reason. `11` puts
 * the decision on the server so that no client can be the thing that decides, which makes the
 * server the honest place to ask whether it holds.
 */

import type { Check } from './analysis.js';

/** The status a write attempt came back with, or `null` where the request could not be made. */
export type WriteOutcome = number | null;

// ---------------------------------------------------------------------------
// DOSE-0 - the control
// ---------------------------------------------------------------------------

export interface DoseControlEvidence {
  /** What the owner's own dose write answered. */
  readonly ownerWrite: WriteOutcome;
  /** Active grants the caregiver identity already held for this profile. */
  readonly grantsBefore: number | null;
}

/**
 * The owner can record a dose, and the caregiver starts with nothing.
 *
 * Both halves are needed and for different reasons. Every refusal below is only evidence if
 * somebody is *not* refused - a policy that refuses everybody passes each of the caregiver checks
 * and is a total outage of `04` Phase 4.3. And a grant left behind by an earlier run would make
 * "they can record after being granted it" true before the run began, because revoking is the only
 * way to end a grant and a crashed run does not revoke.
 */
export function doseControlCheck(evidence: DoseControlEvidence): Check {
  const title = 'The owner can record a dose, and the caregiver holds no grant yet';
  if (evidence.ownerWrite === null || evidence.grantsBefore === null) {
    return {
      id: 'DOSE-0',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The starting state could not be read.',
    };
  }
  if (evidence.grantsBefore > 0) {
    return {
      id: 'DOSE-0',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `${String(evidence.grantsBefore)} grant(s) were already active for this caregiver, so a ` +
        'later refusal would say nothing about the capability that was granted in this run.',
    };
  }
  if (evidence.ownerWrite !== 201) {
    return {
      id: 'DOSE-0',
      title,
      status: 'FAIL',
      detail:
        `The profile owner's own dose write answered ${String(evidence.ownerWrite)} rather than ` +
        '201. `has_capability` short-circuits on ownership, so migration 0021 must not have ' +
        'touched this path - and every refusal measured below would otherwise be a policy that ' +
        'refuses everybody.',
    };
  }
  return {
    id: 'DOSE-0',
    title,
    status: 'PASS',
    detail:
      'The owner recorded a dose (201) and the caregiver identity held no active grant, so the ' +
      'refusals below are about the capability rather than about the relationship.',
  };
}

// ---------------------------------------------------------------------------
// DOSE-1 - the choice is offered, as a change
// ---------------------------------------------------------------------------

export interface CapabilityOfferedEvidence {
  /** Whether the run reached the invitation form at all. */
  readonly reachedForm: boolean;
  /** Every capability label the form drew, as read off the screen. */
  readonly offeredLabels: readonly string[] | null;
}

/**
 * The invitation form offers recording a dose as its own choice.
 *
 * The screen half of `DEV-049`. An owner who can grant "Medicines" and "Edit medicines" and
 * nothing between them has no way to express the thing most caregivers actually do, so before this
 * change the only honest options were to over-grant or to leave somebody unable to help. The
 * checkbox existing is what makes the policy's refusal reasonable rather than merely correct.
 *
 * Read as a label on the form rather than as a capability code, because a code is not what
 * somebody approving access reads (`18`).
 */
export function capabilityOfferedCheck(evidence: CapabilityOfferedEvidence): Check {
  const title = 'The invitation form offers recording doses as a separate choice';
  if (!evidence.reachedForm || evidence.offeredLabels === null) {
    return {
      id: 'DOSE-1',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The invitation form was never reached, so nothing was read off it.',
    };
  }
  const hasRecord = evidence.offeredLabels.some((label) => /record doses/i.test(label));
  const hasMedicines = evidence.offeredLabels.some((label) => /^medicines$/i.test(label));
  if (!hasRecord) {
    return {
      id: 'DOSE-1',
      title,
      status: 'FAIL',
      detail:
        'The form drew no "Record doses" choice, so an owner can only grant the thing a ' +
        'caregiver most often needs by granting "Edit medicines" as well - which is the ' +
        'over-granting DEC-116 split the capability to avoid.',
    };
  }
  if (!hasMedicines) {
    return {
      id: 'DOSE-1',
      title,
      status: 'FAIL',
      detail:
        'The form offered "Record doses" but no longer offers "Medicines" on its own. Reading a ' +
        'dose history without being able to write to it is what VIEW_MEDICINES is for, and ' +
        'losing it would make the split pointless in the other direction.',
    };
  }
  return {
    id: 'DOSE-1',
    title,
    status: 'PASS',
    detail:
      'Both "Medicines" and "Record doses" were offered as separate choices, so the narrow grant ' +
      'is expressible without the wide one.',
  };
}

// ---------------------------------------------------------------------------
// DOSE-2 - and the review screen calls it a change
// ---------------------------------------------------------------------------

export interface ReviewGroupingEvidence {
  /** Whether the review step was reached with only "Record doses" ticked. */
  readonly reachedReview: boolean;
  /** Every line of the review screen, in the order it was drawn. */
  readonly lines: readonly string[] | null;
}

/**
 * With only that ticked, the review screen puts it under what they can **change**.
 *
 * The sentence `DEV-049` was actually about. The old screen said `VIEW_MEDICINES` allowed the
 * caregiver to "see" and listed nothing under changing, over a grant that carried a write into
 * somebody's dose history. A split that moved the write to a new capability and still filed it
 * under "see" would have reproduced the defect under a new name.
 *
 * Measured by where the heading falls relative to the sentence, not by the sentence alone: both
 * headings are on the same screen, and a check for the words would be answered by the wrong one.
 */
export function reviewGroupingCheck(evidence: ReviewGroupingEvidence): Check {
  const title = 'Recording doses is reviewed as something they can change, not see';
  if (!evidence.reachedReview || evidence.lines === null) {
    return {
      id: 'DOSE-2',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The review screen was never reached, so nothing was read off it.',
    };
  }

  const seeAt = evidence.lines.findIndex((line) => /able to see/i.test(line));
  const changeAt = evidence.lines.findIndex((line) => /able to change/i.test(line));
  const sentenceAt = evidence.lines.findIndex((line) =>
    /record that a medicine was taken/i.test(line),
  );

  if (sentenceAt === -1) {
    return {
      id: 'DOSE-2',
      title,
      status: 'FAIL',
      detail:
        'The review screen never described what was ticked. A confirmation step that does not ' +
        'say what is being granted is the consent `18` asks for, missing.',
    };
  }
  if (changeAt === -1) {
    return {
      id: 'DOSE-2',
      title,
      status: 'FAIL',
      detail:
        'The review screen described the grant but drew no "able to change" heading, so a write ' +
        "into somebody's dose history was presented as something other than a change.",
    };
  }
  if (changeAt > sentenceAt || (seeAt !== -1 && seeAt < sentenceAt && seeAt > changeAt)) {
    return {
      id: 'DOSE-2',
      title,
      status: 'FAIL',
      detail:
        `The sentence about recording doses was drawn at line ${String(sentenceAt)}, which is ` +
        `not under the "able to change" heading at line ${String(changeAt)}. That is DEV-049 ` +
        'reproduced under a new capability name.',
    };
  }
  return {
    id: 'DOSE-2',
    title,
    status: 'PASS',
    detail:
      'The review screen listed recording a dose under what the caregiver will be able to ' +
      'change, which is what it is.',
  };
}

// ---------------------------------------------------------------------------
// DOSE-3 - the grant carries only what was ticked
// ---------------------------------------------------------------------------

export interface GrantContentsEvidence {
  /** The capabilities the invitation actually carries, as the server stored them. */
  readonly capabilities: readonly string[] | null;
  /** What the form was asked to tick. */
  readonly ticked: readonly string[];
}

/**
 * The invitation carries exactly the capability that was chosen, and nothing beside it.
 *
 * DEC-116 says an owner has to grant `RECORD_DOSES` explicitly. The way that promise breaks in
 * practice is not a migration backfilling - that is a one-time event a test can pin - but a form
 * that quietly adds a companion capability because the feature "needs" it. An invitation that
 * widened between the checkbox and the row would be invisible from the screen that made it.
 */
export function grantContentsCheck(evidence: GrantContentsEvidence): Check {
  const title = 'The invitation carries only the capability that was ticked';
  if (evidence.capabilities === null) {
    return {
      id: 'DOSE-3',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The invitation could not be read back, so what it carries is unknown.',
    };
  }
  const got = [...evidence.capabilities].sort();
  const want = [...evidence.ticked].sort();
  if (got.length !== want.length || got.some((value, index) => value !== want[index])) {
    return {
      id: 'DOSE-3',
      title,
      status: 'FAIL',
      detail: `The invitation carries ${JSON.stringify(got)} where the form ticked ${JSON.stringify(want)}.`,
    };
  }
  return {
    id: 'DOSE-3',
    title,
    status: 'PASS',
    detail: `The invitation carries exactly ${JSON.stringify(got)}.`,
  };
}

// ---------------------------------------------------------------------------
// DOSE-4 - a view-only caregiver is refused, by the server
// ---------------------------------------------------------------------------

export interface ViewOnlyRefusedEvidence {
  /** What the caregiver's read of the dose history answered. */
  readonly historyRead: WriteOutcome;
  /** How many events that read returned. */
  readonly historyCount: number | null;
  /** What their dose write answered. */
  readonly write: WriteOutcome;
}

/**
 * Granted "Medicines" and nothing else, they can read the history and cannot write to it.
 *
 * `DEV-049` closed, measured against a running server rather than a policy file. Both halves are
 * asserted together on purpose: a change that also took the read away would have made the grant
 * useless to the person holding it, and the asymmetry between reading and writing is the entire
 * point of a capability model.
 *
 * The refusal is a 404 rather than a 403 because `13` does not let the API be an oracle - there is
 * deliberately no outcome meaning "you are not allowed" (trap 89). A 403 here would be a defect of
 * its own.
 */
export function viewOnlyRefusedCheck(evidence: ViewOnlyRefusedEvidence): Check {
  const title = 'A caregiver granted only "Medicines" may read the dose history, not write to it';
  if (evidence.historyRead === null || evidence.write === null || evidence.historyCount === null) {
    return {
      id: 'DOSE-4',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The caregiver identity could not be asked.',
    };
  }
  if (evidence.historyRead !== 200 || evidence.historyCount === 0) {
    return {
      id: 'DOSE-4',
      title,
      status: 'FAIL',
      detail:
        `Reading the dose history answered ${String(evidence.historyRead)} with ` +
        `${String(evidence.historyCount)} event(s). VIEW_MEDICINES is what lets a caregiver see ` +
        'when a medicine was taken, and 0021 was not supposed to touch the read path.',
    };
  }
  if (evidence.write === 201) {
    return {
      id: 'DOSE-4',
      title,
      status: 'FAIL',
      detail:
        "The caregiver wrote into the owner's dose history holding only VIEW_MEDICINES. That is " +
        'DEV-049 exactly, still open: the invitation screen calls this grant read-only, and a ' +
        'dose history is what somebody hands a doctor.',
    };
  }
  if (evidence.write !== 404) {
    return {
      id: 'DOSE-4',
      title,
      status: 'FAIL',
      detail:
        `The write was refused with ${String(evidence.write)} rather than 404. \`13\` forbids the ` +
        'API confirming what exists to somebody who may not reach it, so a refusal has to be the ' +
        'same answer an unknown item gives.',
    };
  }
  return {
    id: 'DOSE-4',
    title,
    status: 'PASS',
    detail:
      `The caregiver read ${String(evidence.historyCount)} event(s) and their write was refused ` +
      'with 404 - the same answer an item that does not exist gives.',
  };
}

// ---------------------------------------------------------------------------
// DOSE-5 - and is admitted once the capability is granted
// ---------------------------------------------------------------------------

export interface RecorderAdmittedEvidence {
  /** What the write answered before `RECORD_DOSES` was granted. */
  readonly before: WriteOutcome;
  /** What the same write answered after it was granted. */
  readonly after: WriteOutcome;
  /** Whether the second grant was created at all. */
  readonly granted: boolean;
}

/**
 * The same caregiver, the same request, admitted once the owner grants the capability.
 *
 * The positive half, and the one that makes DOSE-4 a statement about `RECORD_DOSES` rather than
 * about caregivers in general. Without it, a policy that refused every non-owner would pass DOSE-4
 * and would have removed the feature instead of scoping it.
 *
 * Same session, no sign-out, exactly as `CAR-4` measures revocation from the other direction:
 * `has_capability` re-evaluates the grant on every request, so a capability granted takes effect
 * on the next one.
 */
export function recorderAdmittedCheck(evidence: RecorderAdmittedEvidence): Check {
  const title = 'Granting "Record doses" admits the write it refused a moment ago';
  if (!evidence.granted || evidence.before === null || evidence.after === null) {
    return {
      id: 'DOSE-5',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The capability could not be granted, so nothing was compared.',
    };
  }
  if (evidence.before === 201) {
    return {
      id: 'DOSE-5',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The write already succeeded before the capability was granted, so granting it proves ' +
        'nothing about what admitted the write.',
    };
  }
  if (evidence.after !== 201) {
    return {
      id: 'DOSE-5',
      title,
      status: 'FAIL',
      detail:
        `With RECORD_DOSES granted, the write answered ${String(evidence.after)} rather than 201. ` +
        'The capability names a permission nothing acts on, which is a feature removed rather ' +
        'than scoped.',
    };
  }
  return {
    id: 'DOSE-5',
    title,
    status: 'PASS',
    detail:
      `The same request answered ${String(evidence.before)} without the capability and 201 with ` +
      'it, on the same session with no sign-out.',
  };
}

// ---------------------------------------------------------------------------
// DOSE-6 - the owner's own control still works, on the device
// ---------------------------------------------------------------------------

export interface OwnerRecordsEvidence {
  /** Whether the run drove the shelf at all. */
  readonly driven: boolean;
  /** Whether the dose control was found on the row. */
  readonly controlPresent: boolean;
  /** Dose events on the owner's medicine before the run, and after. */
  readonly before: number | null;
  readonly after: number | null;
}

/**
 * The person whose medicines these are can still record one, from the phone.
 *
 * The regression this change could most plausibly cause. The shelf row now withholds the control
 * on a flag the server sends, and every way of getting that wrong - a field the response does not
 * carry, a stale projection row written by the previous build, a view that reads it off the wrong
 * object - ends with the control missing for the owner, who was never the subject of the change.
 *
 * A count rather than a screen state, because "the screen said Recorded" is what a screen says.
 * `04` Phase 4.3 is about a record existing.
 */
export function ownerRecordsCheck(evidence: OwnerRecordsEvidence): Check {
  const title = 'The owner can still record a dose on the device';
  if (!evidence.driven || evidence.before === null || evidence.after === null) {
    return {
      id: 'DOSE-6',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The shelf was never driven, so nothing on the device was measured.',
    };
  }
  if (!evidence.controlPresent) {
    return {
      id: 'DOSE-6',
      title,
      status: 'FAIL',
      detail:
        "The dose control was not on the owner's own medicine row. The row now withholds it on " +
        '`mayRecordDoses`, and an absent or unreadable flag reads as "not allowed" by design - ' +
        'which for the owner is the feature gone.',
    };
  }
  if (evidence.after <= evidence.before) {
    return {
      id: 'DOSE-6',
      title,
      status: 'FAIL',
      detail:
        `The control was pressed and the history went from ${String(evidence.before)} to ` +
        `${String(evidence.after)} event(s). A control that is drawn and records nothing is ` +
        'worse than one that is withheld: the screen says it was recorded.',
    };
  }
  return {
    id: 'DOSE-6',
    title,
    status: 'PASS',
    detail:
      `The control was on the row and recording moved the history from ${String(evidence.before)} ` +
      `to ${String(evidence.after)} event(s).`,
  };
}
