/**
 * Removing a caregiver's access.
 *
 * Spec references: `04` Phase 8.1, `14` (caregiver administration needs re-authentication),
 * `15` A2 (a revoked caregiver must lose access on their very next authenticated access),
 * `12` (no client-side authorization, and no optimistic change to a grant), `03` group H,
 * DEC-039 (a refusal arrives as absence), trap 14.
 *
 * WHY THERE IS A MODULE HERE AT ALL
 * The access list deliberately shows grants and outstanding invitations together, because they
 * answer one question: who can read this profile. They are two records with two routes, and a
 * control handed only a row ID cannot tell which. Choosing the route is therefore a decision, and
 * a decision made inside a React component is one nothing can check (`DEV-021`).
 *
 * WHAT THIS MODULE WILL NOT DO
 * It does not decide whether the caller may revoke anything. `evaluateGrantRevocation` in the
 * domain is the authority and it runs server-side, per request, against the grant as it actually
 * is. What is refused here is only what the *screen* would be wrong to offer - a row that already
 * carries no access - and refusing it is a copy decision, not a security one: pressing "remove
 * access" on a revoked row and being told it worked teaches that the button does nothing.
 *
 * NOTHING HERE APPLIES A CHANGE LOCALLY
 * There is no function that removes a row, marks one revoked, or filters a list. `12` forbids the
 * client holding authorization logic, and a row that disappears before the server agreed is a
 * false statement about who can read a person's health data - in the direction that reassures.
 */

import type { CaregiverCapability } from '@kynviora/domain';
import { REVOCATION_COPY } from '@kynviora/presentation';
import { messageForFailure, type ApiOutcome } from './outcome.js';
import type { CaregiverAccessRowView } from './views.js';

/** Which record is being withdrawn, and so which route answers. */
export type RevocationSubject = 'GRANT' | 'INVITATION';

/**
 * Everything the confirmation needs and nothing it does not.
 *
 * No profile ID, no user ID and no address. The routes take the record's own ID and derive the
 * rest from it server-side; a profile ID in this shape would be a client-supplied claim about
 * scope, which `13` says is never proof of access.
 */
export interface RevocationTarget {
  readonly subject: RevocationSubject;
  readonly id: string;
  /** Whether the caller is removing their own access. From the server, never inferred. */
  readonly isSelf: boolean;
  /** What this row currently carries, so the confirmation can say what stops. */
  readonly capabilities: readonly CaregiverCapability[];
  readonly displayName: string;
}

export type RevocationRefusal = {
  readonly reason: 'NOTHING_TO_REMOVE';
  readonly message: string;
};

export const NOTHING_TO_REMOVE_MESSAGE =
  'This access has already ended. There is nothing to remove.';

export interface RevocationDraftResult {
  readonly ok: boolean;
  readonly refusal: RevocationRefusal | null;
  /** The target, or `null`. Never carries a row the screen should not have offered. */
  readonly target: RevocationTarget | null;
}

/**
 * States that still carry access, and so are the only ones worth removing.
 *
 * `INVITED` is here even though an invitation grants nothing yet: the token is live, and
 * withdrawing it is the only way to stop it being redeemed (DEC-018 - it cannot be re-issued, so
 * it also cannot be cancelled by replacing it).
 */
const REMOVABLE_STATES = ['ACTIVE', 'INVITED'] as const;

/**
 * Build the revocation, or say why the row offers none.
 *
 * Takes the row the screen is actually displaying rather than an ID, so the subject and the state
 * come from the same place the user is looking at. A list that has moved on since it loaded
 * produces a refusal here instead of a request the server would answer with 404 - which the
 * client renders as absence (DEC-039), and "the row vanished" is not an explanation.
 */
export function buildRevocation(row: CaregiverAccessRowView): RevocationDraftResult {
  if (!(REMOVABLE_STATES as readonly string[]).includes(row.state)) {
    return {
      ok: false,
      refusal: { reason: 'NOTHING_TO_REMOVE', message: NOTHING_TO_REMOVE_MESSAGE },
      target: null,
    };
  }

  return {
    ok: true,
    refusal: null,
    target: {
      subject: row.subject,
      id: row.id,
      isSelf: row.isSelf,
      capabilities: row.capabilities,
      displayName: row.displayName,
    },
  };
}

/**
 * Whether a row offers a remove control at all.
 *
 * The same predicate {@link buildRevocation} applies, exported so the list and the confirmation
 * cannot disagree about which rows are removable. Two independent conditions is how a control
 * appears on a row whose builder then refuses it.
 */
export function isRemovable(row: CaregiverAccessRowView): boolean {
  return buildRevocation(row).ok;
}

/**
 * The reason an accepted invitation cannot be withdrawn.
 *
 * The server answers `INVITATION_ALREADY_RESOLVED` with `reason_code: already_accepted`, because
 * the access has moved into a grant and closing the invitation would leave it in place while
 * saying it had been removed. The screen has to reload rather than retry: the row it was looking
 * at is no longer the row that carries the access.
 */
export const ALREADY_ACCEPTED_CODE = 'INVITATION_ALREADY_RESOLVED';

/**
 * The words to put on a failed removal.
 *
 * Ordinarily the server's own message, which `errors.ts` has already made client-safe - this
 * client never invents a reason for a refusal the server declined to explain.
 *
 * One exception, and it is not an invention. `INVITATION_ALREADY_RESOLVED` is shared with the
 * acceptance path, so its client-safe message is the generic "this invitation has already been
 * used" - true, and useless to an owner who is looking at the list and wants the access gone. The
 * server's own detail says `already_accepted` and its internal message names the thing to do
 * instead; what is missing on the wire is only the wording. Supplying it here contradicts nothing
 * the server said and turns a dead end into the next step.
 */
export function revocationMessage(
  outcome: Exclude<ApiOutcome<unknown>, { kind: 'OK' }>,
): string | null {
  if (outcome.kind === 'REFUSED' && outcome.code === ALREADY_ACCEPTED_CODE) {
    return REVOCATION_COPY.alreadyAccepted;
  }
  return messageForFailure(outcome);
}
