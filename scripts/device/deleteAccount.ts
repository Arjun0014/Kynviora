/**
 * What the account-deletion scenario's evidence means (`DEV-062`).
 *
 * Spec references: `16` (a person may have their data removed; the deletion workflow enumerates
 * device local data, primary records, derived projections, queued jobs, cached exports and
 * notification tokens; the *record that a deletion happened* is retained), `14`
 * (re-authentication for high-impact actions; no oracle), `12` (authorization loss invalidates
 * local access), `18` (say what a control will do before it does it), `13`, DEC-117, DEC-120,
 * DEC-124, DEC-125, `BLK-010`.
 *
 * Kept apart from the runner so every judgement below runs in `npm run verify` with nothing
 * attached (DEC-102). The runner supplies the evidence; this decides what it means.
 *
 * WHY THIS SCENARIO IS DIFFERENT FROM EVERY OTHER ONE
 * It is the only irreversible thing in the app, and it is the only check in this suite that
 * **must not** be able to pass by halves. Three failures are worse than a refusal:
 *
 *   - the screen deletes without saying what goes, so somebody loses a dose history they did not
 *     know was in scope;
 *   - the deletion runs on a wrong password, so a borrowed phone can close somebody's account;
 *   - the data is stamped and the sign-in identity is not, so the person cannot get back in *and*
 *     cannot ask again - the half-deletion DEC-120 refused to allow.
 *
 * Each has a check, and two of them are checks that **nothing changed**, which is why the run
 * reads the database either side rather than only the screen.
 *
 * WHAT THE ACCOUNT USED HERE IS, SAID PLAINLY
 * A synthetic account created and confirmed by an operator, because confirming an address needs a
 * mailbox and this environment has none (`BLK-010`). That is a statement about how the account
 * came to exist and is **not** evidence about the sign-up or confirmation flow - `19`'s
 * fourteenth scenario measures what can be measured there. What this scenario measures is the
 * deletion, which is driven entirely through the app by a person signed in for real.
 */

import type { Check } from './analysis.js';

/** How the account's rows look, read with a credential that can see them whatever RLS says. */
export interface AccountRows {
  /** `null` where no `app_user` row exists at all. */
  readonly accountStamped: boolean | null;
  /** Profiles under the account, and whether each is stamped deleted. */
  readonly profilesLive: number;
  readonly profilesStamped: number;
}

// ---------------------------------------------------------------------------
// DEL-1 - the screen says what goes, before it goes
// ---------------------------------------------------------------------------

export interface DeletionWarningEvidence {
  /** Names on screen once the deletion screen is open, or `null` if unreadable. */
  readonly names: readonly string[] | null;
  /** Every line `16`'s workflow requires be named. All of them, not most. */
  readonly mustName: readonly string[];
  /** The sentence saying what is kept and for how long (DEC-117). */
  readonly retentionSentence: string;
  /** The control that would carry the deletion out. Must be present, or nothing was opened. */
  readonly submitLabel: string;
}

export function deletionWarningCheck(evidence: DeletionWarningEvidence): Check {
  const id = 'DEL-1';
  const title = 'The deletion screen says what goes, and what is kept, before anything happens';
  const onScreen = evidence.names;
  if (onScreen === null) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The screen could not be read.' };
  }
  if (!onScreen.includes(evidence.submitLabel)) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The deletion screen was not open - its own control is not on screen - so what it says ' +
        'was not read.',
    };
  }

  const missing = evidence.mustName.filter((line) => !onScreen.includes(line));
  if (missing.length > 0) {
    // `18`, and it is the reason this check is first. A confirmation that only asks "are you
    // sure" leaves somebody to discover afterwards that the dose history went with it.
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `The screen offers to delete the account without naming ${String(missing.length)} of the ` +
        `things that go: ${missing.join(' | ')}.`,
    };
  }
  if (!onScreen.includes(evidence.retentionSentence)) {
    // `16` keeps the record that a deletion happened for twenty-four months (DEC-117). A screen
    // claiming everything disappears would be untrue, and a retention notice discovered later is
    // worse than one given now.
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'The screen does not say what is kept after a deletion, or for how long.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      `The screen names all ${String(evidence.mustName.length)} things the deletion removes, and ` +
      'says what is kept afterwards and why, before offering the control that does it.',
  };
}

// ---------------------------------------------------------------------------
// DEL-2 - a wrong password changes nothing
// ---------------------------------------------------------------------------

export interface WrongPasswordDeletionEvidence {
  /** Names on screen after submitting the deletion with a wrong password. */
  readonly names: readonly string[] | null;
  readonly refusalHeading: string;
  /** The account's rows, read **after** the attempt. */
  readonly rowsAfter: AccountRows | null;
  /** A name only the signed-in app produces, to show the person is still signed in. */
  readonly signedInOnlyName: string;
}

export function wrongPasswordDeletionCheck(evidence: WrongPasswordDeletionEvidence): Check {
  const id = 'DEL-2';
  const title = 'A wrong password deletes nothing, and says so';
  const rows = evidence.rowsAfter;
  if (rows === null || evidence.names === null) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'Either the screen or the account rows could not be read after the attempt.',
    };
  }

  // The half that matters most, and it is a database question rather than a screen one. A screen
  // showing a refusal over an account that was in fact closed is the worst possible outcome here.
  if (rows.accountStamped !== false) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        rows.accountStamped === null
          ? 'The account row is gone after an attempt with a wrong password.'
          : 'The account was closed by an attempt with a wrong password.',
    };
  }
  if (rows.profilesStamped > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: `${String(rows.profilesStamped)} profile(s) were stamped by a refused attempt.`,
    };
  }
  if (!evidence.names.includes(evidence.refusalHeading)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'Nothing was deleted and the screen said nothing about it, so the person cannot tell ' +
        'whether their account still exists.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      `The attempt was refused, the screen said so, and the account and its ` +
      `${String(rows.profilesLive)} profile(s) are untouched. \`14\` asks for re-authentication ` +
      'on this action and this is it being asked for.',
  };
}

// ---------------------------------------------------------------------------
// DEL-3 - the deletion completes and the phone is signed out
// ---------------------------------------------------------------------------

export interface DeletionCompletedEvidence {
  /** Names on screen once the deletion has run. */
  readonly names: readonly string[] | null;
  /** The sign-in control, which has to be back. */
  readonly submitLabel: string;
  /** A name only the signed-in app produces. Must be gone (`12`). */
  readonly signedInOnlyName: string;
  /** The heading a refusal would show, so a refusal is not read as a success. */
  readonly refusalHeading: string;
}

export function deletionCompletedCheck(evidence: DeletionCompletedEvidence): Check {
  const id = 'DEL-3';
  const title = 'Deleting the account signs the phone out and leaves nothing on it';
  if (evidence.names === null) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The screen could not be read.' };
  }
  if (evidence.names.includes(evidence.refusalHeading)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'The deletion was refused. Whether anything changed is DEL-5’s question.',
    };
  }
  if (!evidence.names.includes(evidence.submitLabel)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'The account was deleted and the app did not return to the sign-in screen, so it is ' +
        'still showing an account that no longer exists.',
    };
  }
  if (evidence.names.includes(evidence.signedInOnlyName)) {
    // `12`: sign-out removes decrypted projections and caches, and a deletion is the strongest
    // form of that. Content still on screen is content the next person to pick the phone up reads.
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'Household content is still on screen after the account was deleted.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail: 'The app returned to the sign-in screen with none of the account’s content on it.',
  };
}

// ---------------------------------------------------------------------------
// DEL-4 - the sign-in identity is gone
// ---------------------------------------------------------------------------

/**
 * What the provider says about the address afterwards.
 *
 * `invalid_credentials` is the answer for an address it has never heard of, which is what a
 * removed identity becomes. It is deliberately the same answer a wrong password gets - the
 * provider does not distinguish them and neither does this - so the credentials used here are the
 * ones that worked five seconds earlier, which is what makes the change in answer mean something.
 */
export type IdentityState = 'GONE' | 'STILL_THERE' | 'UNREADABLE';

export interface IdentityRemovedEvidence {
  readonly identity: IdentityState;
  /** Whether those same credentials worked before the deletion. The control. */
  readonly workedBefore: boolean | null;
}

export function identityRemovedCheck(evidence: IdentityRemovedEvidence): Check {
  const id = 'DEL-4';
  const title = 'The sign-in identity behind the account is gone';
  if (evidence.workedBefore !== true) {
    // Without the positive control this is an absence test over credentials that may never have
    // worked, which passes trivially.
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'These credentials were not shown to work before the deletion, so their not working ' +
        'afterwards says nothing.',
    };
  }
  if (evidence.identity === 'UNREADABLE') {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The provider could not be asked.' };
  }
  if (evidence.identity === 'STILL_THERE') {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'The account was deleted and its sign-in identity still works, so somebody can still ' +
        'authenticate as a person this system has removed.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      'Credentials that signed in moments earlier are now refused as unknown: the identity was ' +
      'removed at the provider, not merely signed out.',
  };
}

// ---------------------------------------------------------------------------
// DEL-5 - and so is everything under the account
// ---------------------------------------------------------------------------

export interface DataRemovedEvidence {
  readonly rowsBefore: AccountRows | null;
  readonly rowsAfter: AccountRows | null;
}

export function dataRemovedCheck(evidence: DataRemovedEvidence): Check {
  const id = 'DEL-5';
  const title = 'The account and everything under it are stamped for removal';
  const before = evidence.rowsBefore;
  const after = evidence.rowsAfter;
  if (before === null || after === null) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'The account’s rows could not be read on both sides of the deletion.',
    };
  }
  // The positive control. Stamping "everything" is trivially true over an account that owned
  // nothing, and this scenario seeds a profile precisely so it is not.
  if (before.profilesLive < 1) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'The account owned nothing before the deletion, so nothing had to be removed.',
    };
  }
  if (after.accountStamped !== true) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        after.accountStamped === null
          ? 'The account row was hard-deleted rather than stamped, so the record `16` retains is ' +
            'gone with it.'
          : 'The account is not stamped as deleted.',
    };
  }
  if (after.profilesLive > 0) {
    // DEC-120's failure. A profile left live under a closed account is a row the sweep can still
    // see and nobody can still reach.
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `${String(after.profilesLive)} profile(s) are still live under a closed account, so the ` +
        'deletion stopped part-way and what is left cannot be reached or removed.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      `All ${String(before.profilesLive)} profile(s) under the account are stamped, and so is ` +
      'the account. Nothing is hard-deleted: the retention rules decide when rows go, and the ' +
      'purge is what takes them (DEC-117).',
  };
}

// ---------------------------------------------------------------------------
// DEL-6 - the record that it happened survives, and names nobody
// ---------------------------------------------------------------------------

export interface DeletionRecordEvidence {
  /** Audit actions recorded against the account, or `null` where they could not be read. */
  readonly actions: readonly string[] | null;
  /** The serialised detail of those rows, so it can be checked for what it must not contain. */
  readonly details: readonly string[] | null;
  /** The address the account had. Must appear in none of the details. */
  readonly email: string;
}

export function deletionRecordCheck(evidence: DeletionRecordEvidence): Check {
  const id = 'DEL-6';
  const title = 'The record that a deletion happened is kept, and describes nobody';
  if (evidence.actions === null || evidence.details === null) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The audit rows could not be read.' };
  }
  if (!evidence.actions.includes('account.deleted')) {
    // `16` retains the record **that** a deletion was carried out for twenty-four months. Without
    // it there is no way to show one happened, which is the thing the retention exists for.
    return {
      id,
      title,
      status: 'FAIL',
      detail: `No 'account.deleted' record was written. Recorded: ${evidence.actions.join(', ')}.`,
    };
  }
  const leaking = evidence.details.filter((detail) =>
    detail.toLowerCase().includes(evidence.email.toLowerCase()),
  );
  if (leaking.length > 0) {
    // The audit log is the one place a purged identifier could come back from, so the record of a
    // deletion must not become a description of who was deleted.
    return {
      id,
      title,
      status: 'FAIL',
      detail: `The address appears in ${String(leaking.length)} audit row(s) that outlive it.`,
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      `The deletion is recorded (${evidence.actions.join(', ')}) and no row carries the address, ` +
      'so the retained record shows that a deletion happened without describing whose.',
  };
}
