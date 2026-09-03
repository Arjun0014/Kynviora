/**
 * What the caregiver invite/revoke scenario's evidence means.
 *
 * Spec references: `19` ("Caregiver invite/revoke"), `04` Phase 8.1, `08.2` (capability scoping),
 * `12` ("authorization loss invalidates local access"; no client-side authorization), `14`
 * (caregiver administration needs step-up), `16` (a family relationship is not a licence to see
 * everything), DEC-018, `DEV-040`.
 *
 * Kept apart from the runner so the judgements run in `npm run verify` with nothing attached
 * (DEC-102).
 *
 * WHAT THE INTERESTING HALF IS
 * Not the invitation. Creating one is a form and a POST, and the API suite already covers what the
 * server does with it. The half worth a device is **revocation taking effect at once**: `12` says
 * authorization loss invalidates local access, and the sentence the app itself puts on the screen
 * is "This takes effect straight away." Somebody removing a person's access is doing it for a
 * reason, and "straight away" has to mean the next request rather than the next session.
 *
 * SO THE MEASUREMENT IS A COUNT, NOT A STATUS CODE
 * `13` forbids the API being an oracle: a profile ID in a request is never proof of access, and a
 * caller who may not read a profile gets the same answer as one asking about a profile that does
 * not exist. On a list route that answer is `200` with an empty list, not a refusal - so a check
 * written against status codes would pass identically before the invitation, after acceptance and
 * after revocation. What changes is how many rows come back.
 */

import type { Check } from './analysis.js';

/** What one identity could read at one moment, or `null` where the read itself failed. */
export type VisibleItems = number | null;

// ---------------------------------------------------------------------------
// CAR-0 - the control
// ---------------------------------------------------------------------------

export interface AccessPreconditionEvidence {
  /** What the caregiver identity could see before any invitation existed. */
  readonly beforeInvite: VisibleItems;
  /** Active grants the caregiver already held for this profile. */
  readonly grantsBefore: number | null;
}

/**
 * The caregiver could not already read this profile.
 *
 * Every later check is a difference, and a difference from an unknown starting point is not a
 * measurement. A grant left behind by an earlier run would make "they can read it after accepting"
 * true before the run began - and grants outlive runs, because revoking is the only way to end one
 * and a crashed run does not revoke.
 */
export function accessPreconditionCheck(evidence: AccessPreconditionEvidence): Check {
  const title = 'The caregiver could read nothing about this profile to begin with';
  if (evidence.beforeInvite === null || evidence.grantsBefore === null) {
    return {
      id: 'CAR-0',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The caregiver identity could not be asked what it could see.',
    };
  }
  if (evidence.grantsBefore > 0) {
    return {
      id: 'CAR-0',
      title,
      status: 'INCONCLUSIVE',
      detail:
        `${String(evidence.grantsBefore)} grant(s) were already active for this caregiver, so ` +
        'acceptance could not have changed anything and revocation would be about the wrong one.',
    };
  }
  if (evidence.beforeInvite !== 0) {
    return {
      id: 'CAR-0',
      title,
      status: 'FAIL',
      detail:
        `The caregiver could already see ${String(evidence.beforeInvite)} item(s) with no grant ` +
        'at all. That is a row-level security failure, and everything after it is beside the point.',
    };
  }
  return {
    id: 'CAR-0',
    title,
    status: 'PASS',
    detail:
      'With no grant, the caregiver identity saw no items - answered as an empty list rather ' +
      'than as a refusal, because `13` does not let the route say whether the profile exists.',
  };
}

// ---------------------------------------------------------------------------
// CAR-1 - the invitation was made on the device
// ---------------------------------------------------------------------------

export interface InvitationEvidence {
  /** Each step the run drove, and whether it happened. */
  readonly steps: readonly (readonly [string, boolean])[];
  /** Pending invitations the server holds for this profile, after the run drove the form. */
  readonly pending: readonly { readonly capabilities: readonly string[] }[] | null;
  /** The one capability the run chose in the form. */
  readonly chosenCapability: string;
}

/**
 * The app made an invitation, for what was actually ticked.
 *
 * The capability is checked rather than the count, because `08.2` scopes access to what was chosen
 * and `16` is explicit that being family is not a licence to see everything. An invitation for
 * more than was ticked is the failure worth catching here, and it is not visible from the screen
 * that made it.
 */
export function invitationCreatedCheck(evidence: InvitationEvidence): Check {
  const title = 'The app created an invitation for exactly what was ticked';
  const failed = evidence.steps.find(([, happened]) => !happened);
  if (failed !== undefined) {
    return {
      id: 'CAR-1',
      title,
      status: 'INCONCLUSIVE',
      detail: `Could not ${failed[0]}, so no invitation was ever made.`,
    };
  }
  if (evidence.pending === null) {
    return {
      id: 'CAR-1',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The invitation list could not be read.',
    };
  }
  if (evidence.pending.length !== 1) {
    return {
      id: 'CAR-1',
      title,
      status: 'FAIL',
      detail:
        `${String(evidence.pending.length)} pending invitation(s) exist where one was made. ` +
        'Each is a live credential somebody could redeem (DEC-018).',
    };
  }
  const capabilities = evidence.pending[0]?.capabilities ?? [];
  if (capabilities.length !== 1 || capabilities[0] !== evidence.chosenCapability) {
    return {
      id: 'CAR-1',
      title,
      status: 'FAIL',
      detail:
        `The invitation carries ${JSON.stringify(capabilities)} where the form ticked only ` +
        `${JSON.stringify(evidence.chosenCapability)}. ` +
        'Spec 08.2 scopes access to what was chosen.',
    };
  }
  return {
    id: 'CAR-1',
    title,
    status: 'PASS',
    detail:
      `One pending invitation exists, carrying ${JSON.stringify(evidence.chosenCapability)} and ` +
      'nothing else.',
  };
}

// ---------------------------------------------------------------------------
// CAR-2 - accepting it grants what it said
// ---------------------------------------------------------------------------

export interface AcceptanceEvidence {
  /** The HTTP status the accept returned. */
  readonly acceptStatus: number | null;
  /** What the caregiver could see afterwards. */
  readonly afterAccept: VisibleItems;
  /** What the owner can see, so "the caregiver sees nothing" is not read as "there is nothing". */
  readonly ownerSees: VisibleItems;
}

/**
 * Accepting turns the invitation into access somebody can actually use.
 *
 * The owner's own count is carried alongside deliberately. A caregiver who sees nothing and an
 * owner who also sees nothing is a run against an empty household, and it would report a working
 * grant with as much confidence as a broken one.
 */
export function acceptanceCheck(evidence: AcceptanceEvidence): Check {
  const title = 'Accepting the invitation gives the caregiver what was shared';
  if (evidence.acceptStatus === null || evidence.afterAccept === null) {
    return {
      id: 'CAR-2',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The acceptance could not be made or its result could not be read.',
    };
  }
  if (evidence.acceptStatus !== 201 && evidence.acceptStatus !== 200) {
    return {
      id: 'CAR-2',
      title,
      status: 'FAIL',
      detail: `The server answered ${String(evidence.acceptStatus)} to the acceptance.`,
    };
  }
  if (evidence.ownerSees === null || evidence.ownerSees === 0) {
    return {
      id: 'CAR-2',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The owner sees no items either, so this household has nothing for a grant to share and ' +
        'the caregiver seeing nothing would prove nothing.',
    };
  }
  if (evidence.afterAccept === 0) {
    return {
      id: 'CAR-2',
      title,
      status: 'FAIL',
      detail:
        `The grant was created and the caregiver still sees no items, while the owner sees ` +
        `${String(evidence.ownerSees)}. An accepted invitation that grants nothing is worse than ` +
        'a refused one: both people believe access was given.',
    };
  }
  return {
    id: 'CAR-2',
    title,
    status: 'PASS',
    detail:
      `The acceptance returned ${String(evidence.acceptStatus)} and the caregiver can now see ` +
      `${String(evidence.afterAccept)} of the owner's ${String(evidence.ownerSees)} item(s).`,
  };
}

// ---------------------------------------------------------------------------
// CAR-3 - revoking on the device ends the grant
// ---------------------------------------------------------------------------

export interface RevocationEvidence {
  readonly steps: readonly (readonly [string, boolean])[];
  /** Active grants for this caregiver after the revocation was driven. */
  readonly grantsAfter: number | null;
}

export function revocationCheck(evidence: RevocationEvidence): Check {
  const title = 'Removing access on the device ends the grant on the server';
  const failed = evidence.steps.find(([, happened]) => !happened);
  if (failed !== undefined) {
    return {
      id: 'CAR-3',
      title,
      status: 'INCONCLUSIVE',
      detail: `Could not ${failed[0]}, so nothing was revoked.`,
    };
  }
  if (evidence.grantsAfter === null) {
    return {
      id: 'CAR-3',
      title,
      status: 'INCONCLUSIVE',
      detail: 'The grant list could not be read after the removal.',
    };
  }
  if (evidence.grantsAfter !== 0) {
    return {
      id: 'CAR-3',
      title,
      status: 'FAIL',
      detail:
        `${String(evidence.grantsAfter)} grant(s) are still active. The screen said "Access ` +
        'removed" and the server disagrees, which is the worst version of this: the person who ' +
        'removed it has been told it is done.',
    };
  }
  return {
    id: 'CAR-3',
    title,
    status: 'PASS',
    detail: 'The removal was driven in the app and the server holds no active grant for them.',
  };
}

// ---------------------------------------------------------------------------
// CAR-4 - and it takes effect straight away
// ---------------------------------------------------------------------------

export interface AccessLossEvidence {
  /** What the caregiver could see after acceptance. */
  readonly whileGranted: VisibleItems;
  /** What the same read returns after the revocation, made with no new session. */
  readonly afterRevocation: VisibleItems;
}

/**
 * The next request the caregiver makes returns nothing.
 *
 * This is the check the scenario exists for. `12` requires authorization loss to invalidate access,
 * and the app tells the person removing it that it "takes effect straight away" - so the read is
 * made immediately, on the same session that was working a moment earlier, with no sign-out and no
 * waiting. A grant that expired only at the next sign-in would pass every other check here.
 *
 * A count, not a status code: `13` does not let the route distinguish "you may not" from "there is
 * nothing", so both before and after are `200` (see the module note).
 */
export function accessLossCheck(evidence: AccessLossEvidence): Check {
  const title = 'The caregiver’s next read returns nothing, with no new session';
  if (evidence.whileGranted === null || evidence.afterRevocation === null) {
    return {
      id: 'CAR-4',
      title,
      status: 'INCONCLUSIVE',
      detail: 'One of the two reads could not be made.',
    };
  }
  if (evidence.whileGranted === 0) {
    return {
      id: 'CAR-4',
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The caregiver saw nothing while the grant was active, so seeing nothing afterwards is ' +
        'not a change.',
    };
  }
  if (evidence.afterRevocation !== 0) {
    return {
      id: 'CAR-4',
      title,
      status: 'FAIL',
      detail:
        `The caregiver still sees ${String(evidence.afterRevocation)} item(s) after the grant was ` +
        'removed. "This takes effect straight away" is on the screen of the person who removed it.',
    };
  }
  return {
    id: 'CAR-4',
    title,
    status: 'PASS',
    detail:
      `The caregiver saw ${String(evidence.whileGranted)} item(s) while granted and 0 on the very ` +
      'next request after the removal, on the same session.',
  };
}
