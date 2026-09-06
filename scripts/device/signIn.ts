/**
 * What the sign-in scenario's evidence means (`19`'s fourteenth scenario).
 *
 * Spec references: `19` ("Sign-up, sign-in, recovery" - the last of the fourteen device E2E
 * scenarios), `13` (identity from an authenticated session; no oracle), `14` (session data in the
 * encrypted store; no secret in a bundle), `18` (a refusal says what to do next), `12`
 * (authorization loss invalidates local access), DEC-118, DEC-124, DEC-125, `BLK-010`, `DEV-040`.
 *
 * Kept apart from the runner so every judgement below runs in `npm run verify` with nothing
 * attached (DEC-102). The runner supplies the evidence; this decides what it means.
 *
 * WHY THIS SCENARIO WAS THE LAST ONE
 * Not because it is hard to drive - it is two fields and a button. Because until 2026-09-05 there
 * was nothing to sign in **to**: Phase 1.1 had no provider, so the only identity the app had was a
 * user ID inlined into a bundle at build time. `BLK-010` is what changed, and this is the run that
 * turns "a verifier that has never seen a real token" into "a person signed in on a phone".
 *
 * THE FOUR THINGS ONLY A DEVICE CAN ANSWER
 *
 * **SIGN-1.** That a signed-out app shows a sign-in screen at all. Every provider in the tree was
 * rearranged for this - the encrypted store moved above the API client so the session could be
 * read before the client is built - and a mistake there is a blank screen rather than a failing
 * assertion.
 *
 * **SIGN-3.** That a wrong password is refused **by the provider** and rendered as a refusal
 * rather than as a crash or a silent nothing. The unit tests drive a stub; this is the real
 * `invalid_credentials` arriving over a real network on a real phone.
 *
 * **SIGN-4.** That signing in reaches the household's own data - which means the token was minted
 * by Supabase, carried by the app, verified by the API against a published key set, resolved to an
 * `app_user` row, and used by row-level security to choose rows. Six components, one assertion.
 *
 * **SIGN-6.** That signing out leaves nothing readable on the device. `12` requires it and the
 * encrypted store is where a session now lives, so a token surviving a sign-out is a token
 * somebody with the phone could use for the rest of its hour.
 *
 * WHAT NO HARNESS CAN ANSWER HERE, AND IT IS NOT A SMALL ONE
 * The email round trip. Confirming an address means opening a mailbox, and the account this runs
 * against was confirmed by an operator - which is what Supabase's own admin API does with
 * `email_confirm: true` and is not evidence that anybody received a message. `SIGN-2` measures the
 * half that is reachable: the app **asks** the provider to create an account and renders the
 * "check your email" state rather than an error, which is the honest end of a sign-up against a
 * project that requires confirmation.
 */

import type { Check } from './analysis.js';

// ---------------------------------------------------------------------------
// SIGN-1 - a signed-out app shows a way in
// ---------------------------------------------------------------------------

export interface SignedOutEvidence {
  /** Every name on screen after a cold start with no stored session, or `null` if unreadable. */
  readonly names: readonly string[] | null;
  /** The submit control the sign-in screen is required to offer. */
  readonly submitLabel: string;
  /** The two other ways out, both of which have to be present at once. */
  readonly createLabel: string;
  readonly forgotLabel: string;
  /** A name that only appears once somebody is signed in. Must be absent. */
  readonly signedInOnlyName: string;
  /**
   * Whether the app was still running when the screen was read.
   *
   * Asked because the answer to "no sign-in screen" used to be a guess, and the guess was wrong.
   * A native crash on the first mount leaves the home screen up, `uiautomator` reports no control
   * of the three, and this check said the app had been built without a provider - which sent a
   * session looking at Metro's environment over an app that had segfaulted. A process that is not
   * there is a fact, and it is cheaper to read than to infer.
   */
  readonly appRunning: boolean | null;
}

export function signedOutCheck(evidence: SignedOutEvidence): Check {
  const id = 'SIGN-1';
  const title = 'A signed-out app offers a way in, and nothing behind it';
  if (evidence.appRunning === false) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The app is not running. It either crashed or never started, so nothing on screen is ' +
        'about signing in and nothing below this line is either. `adb logcat -b crash` says why.',
    };
  }
  const onScreen = evidence.names;
  if (onScreen === null) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'The screen could not be read, so it is not known what a signed-out person sees.',
    };
  }

  const missing = [evidence.submitLabel, evidence.createLabel, evidence.forgotLabel].filter(
    (label) => !onScreen.includes(label),
  );

  // **All three absent is not a failing gate; it is no gate at all.** An app bundled without a
  // provider is `UNCONFIGURED`, shows no sign-in screen and falls through to the development
  // identity - so every check after this one is measuring a different build. That happened: Metro
  // declined to start on a port already in use, the device kept serving the previous bundle, and
  // this check reported three missing controls as though the app had lost them.
  //
  // DEC-102's rule, and it is the direction that matters: "could not look" must never be recorded
  // as "looked and found something".
  if (missing.length === 3) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'No sign-in screen at all - not one control of the three. This app was built without a ' +
        'provider (`EXPO_PUBLIC_SUPABASE_AUTH_URL`), so nothing below this line is evidence ' +
        'about signing in. Restart Metro with it set; Expo inlines it at build time.',
    };
  }
  // All three at once. A person who cannot sign in needs the one they were not offered, and
  // putting the other two behind a navigation step is the moment somebody gives up (`18`).
  if (missing.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: `The sign-in screen is missing ${String(missing.length)} control(s): ${missing.join(', ')}.`,
    };
  }

  // The half that matters more. A gate that renders the form *and* the app behind it has gated
  // nothing.
  if (onScreen.includes(evidence.signedInOnlyName)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `"${evidence.signedInOnlyName}" is on screen while signed out, so the app is reachable ` +
        'without a session.',
    };
  }

  return {
    id,
    title,
    status: 'PASS',
    detail:
      'The sign-in screen offers signing in, creating an account and recovering a password, and ' +
      'nothing from the signed-in app is on screen behind it.',
  };
}

// ---------------------------------------------------------------------------
// SIGN-2 - sign-up ends at a mailbox
// ---------------------------------------------------------------------------

/**
 * What became of the address the app submitted, asked of the provider afterwards.
 *
 * NOT "what a sign-up does right now", WHICH IS WHAT THIS USED TO ASK
 * The first version made its **own** sign-up call to a second address and inferred that the app's
 * attempt had gone the same way. Two things are wrong with that. It reasons about a different
 * request - the outcome that matters is the one the app's own submission produced - and the
 * built-in mailer allows two messages an hour, so the probe could consume the last of the quota
 * and hand the app the rate limit it then reported as the provider's usual answer.
 *
 * So the app goes first and the provider is asked about **that address**, with a password sign-in.
 * The three answers are distinguishable and none of them needs a privilege:
 *
 * | Provider answers                | Means                                                     |
 * | ------------------------------- | --------------------------------------------------------- |
 * | `400 email_not_confirmed`       | the account exists and nobody has confirmed the address    |
 * | `400 invalid_credentials`       | no such account - the sign-up did not create one           |
 * | `200`                           | the account exists and is confirmed already                |
 *
 * `email_not_confirmed` is the one this run is looking for, and it is worth being clear about
 * what it proves: the app really created an account at a real provider, and that account really
 * cannot be used until somebody opens a mailbox. That is the whole of the user-facing sign-up
 * flow except the message itself.
 */
export type SignUpProviderOutcome =
  'CREATED_UNCONFIRMED' | 'CREATED_CONFIRMED' | 'NOT_CREATED' | 'UNREADABLE';

export interface SignUpEvidence {
  /** Names on screen after submitting the create-account form, or `null` if unreadable. */
  readonly names: readonly string[] | null;
  /** What became of the address the app submitted, asked of the provider afterwards. */
  readonly providerOutcome: SignUpProviderOutcome;
  /** The heading the "check your email" state shows. */
  readonly confirmationHeading: string;
  /** The heading a refusal shows. */
  readonly refusalHeading: string;
  /**
   * The sentence the **app's own** mapping produces for the code the provider returns for this
   * address, or `null` where the provider created the account and refused nothing.
   *
   * Supplied by the runner from `authFailureFor`, which is the function the app calls. Asking the
   * same table is the point: a harness with its own copy would pass while the two disagreed,
   * which is the only interesting way this can be wrong.
   */
  readonly expectedRefusalMessage: string | null;
}

export function signUpCheck(evidence: SignUpEvidence): Check {
  const id = 'SIGN-2';
  const title = 'Creating an account really creates one, and the app says what happened';
  const onScreen = evidence.names;
  if (onScreen === null || evidence.providerOutcome === 'UNREADABLE') {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'Either the screen or the provider could not be read, so what the app did with the ' +
        'sign-up is not known.',
    };
  }

  if (evidence.providerOutcome === 'CREATED_CONFIRMED') {
    // Not a judgement about the app. `kynviora-dev` has `mailer_autoconfirm: false`, so an
    // address confirmed the instant it was created means the project's configuration changed
    // underneath this run - and a scenario about confirmation cannot be run against a project
    // that does not require it. Saying so beats reporting a pass that means something else.
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The address was confirmed as soon as it was created, so this project no longer requires ' +
        'confirmation and this run says nothing about the confirmation flow.',
    };
  }

  if (evidence.providerOutcome === 'CREATED_UNCONFIRMED') {
    if (onScreen.includes(evidence.refusalHeading)) {
      // The defect this branch exists for. A project requiring confirmation returns a user and no
      // session, and an app rendering that as a failure sends somebody to try again at an account
      // they made one second ago - where the next attempt says the address is already registered.
      return {
        id,
        title,
        status: 'FAIL',
        detail: 'The account was created and the app showed a refusal, which is the wrong state.',
      };
    }
    if (!onScreen.includes(evidence.confirmationHeading)) {
      return {
        id,
        title,
        status: 'FAIL',
        detail: `The account was created and the app did not show "${evidence.confirmationHeading}".`,
      };
    }
    return {
      id,
      title,
      status: 'PASS',
      detail:
        'The app created an account at the provider - the provider answers `email_not_confirmed` ' +
        'for that address, which is an account that exists and cannot be used yet - and showed ' +
        'the confirmation state. The message itself is not covered: opening it needs a mailbox ' +
        '(BLK-010).',
    };
  }

  // No account was created. What must be true is that the app said so, in the sentence its own
  // mapping produces for the code the provider gives this address - not a generic failure.
  if (!onScreen.includes(evidence.refusalHeading)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'The sign-up created no account and the screen said nothing about it.',
    };
  }
  const expected = evidence.expectedRefusalMessage;
  if (expected === null) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The app showed a refusal and the provider could not be asked what it refuses this ' +
        'address with, so the two cannot be compared.',
    };
  }
  if (!onScreen.includes(expected)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'The app showed a refusal, but not the one its own mapping produces for the code the ' +
        'provider returns for this address - so a real provider code does not reach the screen ' +
        'as the sentence somebody can act on.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      'No account was created and the app rendered the sentence its own mapping produces for ' +
      'the code the provider gives this address. The account-creation half is not covered by ' +
      'this run.',
  };
}

// ---------------------------------------------------------------------------
// SIGN-3 - a wrong password is refused, and said so
// ---------------------------------------------------------------------------

export interface WrongPasswordEvidence {
  readonly names: readonly string[] | null;
  readonly refusalHeading: string;
  /** The exact sentence the copy table produces for a wrong credential. */
  readonly refusalMessage: string;
  /** A name that only appears once signed in. Must be absent. */
  readonly signedInOnlyName: string;
}

export function wrongPasswordCheck(evidence: WrongPasswordEvidence): Check {
  const id = 'SIGN-3';
  const title = 'A wrong password is refused by the provider and said on the screen';
  const onScreen = evidence.names;
  if (onScreen === null) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The screen could not be read.' };
  }
  if (onScreen.includes(evidence.signedInOnlyName)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'A wrong password signed somebody in, which is the failure everything else assumes.',
    };
  }
  if (!onScreen.includes(evidence.refusalHeading)) {
    // Silence is the failure mode worth naming: a refusal the screen does not show is a person
    // pressing the same button again, wondering whether they mistyped it.
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'The sign-in was refused and the screen said nothing about it.',
    };
  }
  if (!onScreen.includes(evidence.refusalMessage)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'A refusal is shown, but not the sentence the copy table produces for this failure.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail: 'The provider refused it and the screen showed the refusal with its next step.',
  };
}

// ---------------------------------------------------------------------------
// SIGN-4 - signing in reaches this household's own data
// ---------------------------------------------------------------------------

export interface SignedInEvidence {
  readonly names: readonly string[] | null;
  /** Something only this account's own data produces. */
  readonly expectedItemName: string;
  /** The sign-in submit control. Must be gone: the gate has to have closed behind them. */
  readonly submitLabel: string;
}

export function signedInCheck(evidence: SignedInEvidence): Check {
  const id = 'SIGN-4';
  const title = 'Signing in reaches this account’s own data, end to end';
  if (evidence.names === null) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The screen could not be read.' };
  }
  if (evidence.names.includes(evidence.submitLabel)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'The sign-in control is still on screen, so the session was not adopted.',
    };
  }
  if (!evidence.names.includes(evidence.expectedItemName)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `Signed in, and "${evidence.expectedItemName}" is not on screen - so the token reached ` +
        'the API and produced no rows, or the app never asked.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      'A Supabase-issued token was carried by the app, verified by the API against the published ' +
      'key set, resolved to an app_user row, and used by row-level security to choose rows.',
  };
}

// ---------------------------------------------------------------------------
// SIGN-5 - the token is in the encrypted store and nowhere else
// ---------------------------------------------------------------------------

export interface TokenAtRestEvidence {
  /** Files under the app's own sandbox that are **not** the encrypted database. */
  readonly plaintextFiles: readonly { readonly path: string; readonly content: string }[] | null;
  /** A distinctive fragment of the access token the app is holding. */
  readonly tokenFragment: string;
  /** Whether the encrypted database was found at all, which is the control this needs. */
  readonly encryptedStoreBytes: number | null;
}

export function tokenAtRestCheck(evidence: TokenAtRestEvidence): Check {
  const id = 'SIGN-5';
  const title = 'The session is in the encrypted store and in no readable file';
  if (evidence.plaintextFiles === null || evidence.encryptedStoreBytes === null) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'The app sandbox could not be listed, so an absence here would prove nothing.',
    };
  }
  // The positive control. An absence test over a device that stored nothing passes trivially, and
  // this one would pass over an app that never signed in at all.
  if (evidence.encryptedStoreBytes <= 0) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'No encrypted database was found, so there is nothing for the token to be inside.',
    };
  }
  if (evidence.tokenFragment.length < 16) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'No token fragment was supplied to search for.',
    };
  }

  const leaking = evidence.plaintextFiles.filter((file) =>
    file.content.includes(evidence.tokenFragment),
  );
  if (leaking.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        `The access token appears in ${String(leaking.length)} readable file(s): ` +
        `${leaking.map((file) => file.path).join(', ')}.`,
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      `Searched ${String(evidence.plaintextFiles.length)} readable file(s) in the app's sandbox ` +
      `for the access token; none contains it, and the encrypted store holds ` +
      `${String(evidence.encryptedStoreBytes)} bytes.`,
  };
}

// ---------------------------------------------------------------------------
// SIGN-6 - signing out leaves nothing
// ---------------------------------------------------------------------------

export interface SignOutEvidence {
  /** Names on screen after signing out, or `null` if unreadable. */
  readonly names: readonly string[] | null;
  readonly submitLabel: string;
  /** Something only this account's own data produces. Must be gone. */
  readonly expectedItemName: string;
  /**
   * Whether the provider still accepts the refresh token the app was holding.
   *
   * The half a screen cannot show. A sign-out that only forgot the token locally would leave a
   * session live for anybody who had copied it.
   */
  readonly refreshStillWorks: boolean | null;
}

export function signOutCheck(evidence: SignOutEvidence): Check {
  const id = 'SIGN-6';
  const title = 'Signing out ends the session here and at the provider';
  if (evidence.names === null || evidence.refreshStillWorks === null) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'Either the screen or the provider could not be read after signing out.',
    };
  }
  if (!evidence.names.includes(evidence.submitLabel)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'The app did not return to the sign-in screen.',
    };
  }
  if (evidence.names.includes(evidence.expectedItemName)) {
    // `12`: sign-out removes decrypted projections and caches. A shelf still on screen is one
    // the next person to pick the phone up can read.
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'Household content is still on screen after signing out.',
    };
  }
  if (evidence.refreshStillWorks) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'The refresh token still works, so the session was forgotten here and not revoked at the ' +
        'provider - anybody holding a copy could carry on.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      'The app returned to the sign-in screen with no household content on it, and the provider ' +
      'refuses the refresh token it was holding.',
  };
}

// ---------------------------------------------------------------------------
// SIGN-7 - a session survives a restart
// ---------------------------------------------------------------------------

export interface PersistedSessionEvidence {
  /** Names on screen after the app's process was killed and it was launched again. */
  readonly names: readonly string[] | null;
  readonly expectedItemName: string;
  readonly submitLabel: string;
}

export function persistedSessionCheck(evidence: PersistedSessionEvidence): Check {
  const id = 'SIGN-7';
  const title = 'A signed-in session survives the app being killed';
  if (evidence.names === null) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The screen could not be read.' };
  }
  if (evidence.names.includes(evidence.submitLabel)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'The app asked for a sign-in after a restart, so the session was not kept - which means ' +
        'signing in on every launch, for an audience `01` names as a primary one.',
    };
  }
  if (!evidence.names.includes(evidence.expectedItemName)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'The app came back signed in and showed none of this account’s data.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail: 'The app came back signed in, from the session in its encrypted store.',
  };
}

// ---------------------------------------------------------------------------
// SIGN-8 - a session outlives its access token
// ---------------------------------------------------------------------------

export interface RenewedSessionEvidence {
  /** Names on screen after the clock passed the access token's lifetime and the app restarted. */
  readonly names: readonly string[] | null;
  readonly expectedItemName: string;
  readonly submitLabel: string;
  /**
   * Seconds the device's clock actually moved forward by, measured on the device rather than
   * assumed from what it was asked to do.
   *
   * The control this check cannot do without. If the clock did not move, the access token was
   * never due for renewal, the app had no reason to renew, and "still signed in" is a sentence
   * about a session that never expired - which would pass while measuring nothing.
   */
  readonly clockAdvancedBySeconds: number | null;
  /** How long the provider's access tokens last, so "past its lifetime" is checkable. */
  readonly accessTokenLifetimeSeconds: number;
  /**
   * Whether the phone could still reach this machine when the reading was taken.
   *
   * `adb root` - which moving the device's clock requires - restarts adbd, and every `adb reverse`
   * mapping dies with it. An app that cannot reach Metro or the API is an app measured with no
   * route to anything, and both possible readings are then meaningless: signed out proves nothing
   * about renewal, and signed in proves nothing about a session still being honoured. DEC-102's
   * rule for a check that could not look, applied to the tunnels rather than to the screen.
   */
  readonly canReachHost: boolean | null;
}

export function renewedSessionCheck(evidence: RenewedSessionEvidence): Check {
  const id = 'SIGN-8';
  const title = 'A session outlives its access token, renewed against the provider';
  if (evidence.canReachHost !== true) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The `adb reverse` tunnels were not in place after the clock moved, so the app could ' +
        'reach neither Metro nor the API and whatever it showed is not about renewal.',
    };
  }
  const advanced = evidence.clockAdvancedBySeconds;
  if (advanced === null) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'The device clock could not be read, so it is not known whether the token was due.',
    };
  }
  if (advanced < evidence.accessTokenLifetimeSeconds) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        `The clock moved ${String(advanced)}s, which is inside the token's ` +
        `${String(evidence.accessTokenLifetimeSeconds)}s lifetime - so nothing was due for ` +
        'renewal and staying signed in proves nothing.',
    };
  }
  if (evidence.names === null) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The screen could not be read.' };
  }
  if (evidence.names.includes(evidence.submitLabel)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'The app asked for a sign-in once its access token came due, so the session was not ' +
        'renewed - which is signing in every hour, for the audience `01` names as a primary one.',
    };
  }
  if (!evidence.names.includes(evidence.expectedItemName)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'The app did not ask for a sign-in and did not reach this account’s data either. ' +
        `On screen: ${JSON.stringify(evidence.names.slice(0, 12))}`,
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      `The device's clock moved ${String(advanced)}s - past the token's ` +
      `${String(evidence.accessTokenLifetimeSeconds)}s lifetime - and the app came back signed ` +
      'in with this account’s data. SIGN-9 is what makes that a renewal rather than a stale ' +
      'token still being honoured: under the same conditions with the session revoked, the app ' +
      'signs out, which it could only learn by asking the provider.',
  };
}

// ---------------------------------------------------------------------------
// SIGN-9 - a session revoked elsewhere signs this phone out
// ---------------------------------------------------------------------------

/**
 * Authorization loss, which is the half of a session no screen offers a button for.
 *
 * `12` requires that losing authorization invalidates local access, and `supabaseLive.test.ts`
 * measured why a phone cannot work this out for itself: after a revocation the provider refuses
 * the token immediately and that same token goes on verifying against the published key set until
 * it expires. So the phone finds out by **asking**, and this is the check that it does.
 *
 * The revocation is performed from outside the app - a global sign-out authenticated by a session
 * this harness obtained separately, which ends every session the account holds anywhere. Nothing
 * on the phone is touched and it is told nothing. It is the "signed out from another device"
 * case, and it is also what an account deletion does.
 */
export interface RevokedSessionEvidence {
  /** Names on screen after the revocation and a restart, or `null` if unreadable. */
  readonly names: readonly string[] | null;
  readonly submitLabel: string;
  readonly expectedItemName: string;
  /** Whether the revocation this check depends on actually succeeded. */
  readonly revoked: boolean | null;
  /** Seconds the clock moved by, so the renewal the app makes was genuinely due. */
  readonly clockAdvancedBySeconds: number | null;
  readonly accessTokenLifetimeSeconds: number;
  /**
   * Whether the phone could still reach this machine when the reading was taken.
   *
   * `adb root` - which moving the device's clock requires - restarts adbd, and every `adb reverse`
   * mapping dies with it. An app that cannot reach Metro or the API is an app measured with no
   * route to anything, and both possible readings are then meaningless: signed out proves nothing
   * about renewal, and signed in proves nothing about a session still being honoured. DEC-102's
   * rule for a check that could not look, applied to the tunnels rather than to the screen.
   */
  readonly canReachHost: boolean | null;
}

export function revokedSessionCheck(evidence: RevokedSessionEvidence): Check {
  const id = 'SIGN-9';
  const title = 'A session revoked elsewhere signs this phone out';
  if (evidence.canReachHost !== true) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The `adb reverse` tunnels were not in place after the clock moved, so the app could ' +
        'reach neither Metro nor the API and whatever it showed is not about the revocation.',
    };
  }
  if (evidence.revoked !== true) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The session could not be revoked at the provider, so nothing was withdrawn and the app ' +
        'was never in a position to discover anything.',
    };
  }
  const advanced = evidence.clockAdvancedBySeconds;
  if (advanced === null || advanced < evidence.accessTokenLifetimeSeconds) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The access token was not past its lifetime on the device clock, so the app had no ' +
        'reason to renew and would not yet have discovered the revocation.',
    };
  }
  if (evidence.names === null) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The screen could not be read.' };
  }
  // The order is deliberate, and it used to be the other way round. "Not the sign-in screen"
  // was being reported as "a withdrawn authorization leaves a phone still working" - which is a
  // claim about household content being readable, over a screen that may have had none on it. An
  // app sitting on a spinner or on an account-setup refusal is neither signed out nor working,
  // and calling that a security failure sends the next session looking for a defect in the
  // renewal when the run could not see one either way (DEC-102's rule, applied to a third state
  // rather than to an unreadable screen).
  if (evidence.names.includes(evidence.expectedItemName)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'Household content is still on screen after the session was revoked.',
    };
  }
  if (!evidence.names.includes(evidence.submitLabel)) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail:
        'The app showed neither the sign-in screen nor this account’s data, so what it did ' +
        'with the revocation is not readable from this run. ' +
        `On screen: ${JSON.stringify(evidence.names.slice(0, 12))}`,
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      'The session was ended at the provider from another session entirely, and the phone - ' +
      'which was told nothing - renewed, was refused, and returned to the sign-in screen with ' +
      'no household content on it.',
  };
}

// ---------------------------------------------------------------------------
// SIGN-10 - an address nobody confirmed cannot be signed in to
// ---------------------------------------------------------------------------

/**
 * The enforcement half of email confirmation, which is the half that can be measured here.
 *
 * The account is the one SIGN-2 created through the app's own form moments earlier. Nobody has
 * opened a mailbox, so the provider refuses it - and that refusal is the whole reason `13` and
 * DEC-118 asked for a verified address. What is not covered stays uncovered: no message was read
 * and no link was clicked.
 */
export interface UnconfirmedSignInEvidence {
  readonly names: readonly string[] | null;
  readonly refusalHeading: string;
  /** The sentence the app's own mapping produces for `email_not_confirmed`. */
  readonly refusalMessage: string;
  readonly signedInOnlyName: string;
  /** Whether an unconfirmed account existed to try. */
  readonly accountExists: boolean;
}

export function unconfirmedSignInCheck(evidence: UnconfirmedSignInEvidence): Check {
  const id = 'SIGN-10';
  const title = 'An address nobody has confirmed cannot be signed in to';
  if (!evidence.accountExists) {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'No unconfirmed account was created, so there was nothing to be refused.',
    };
  }
  if (evidence.names === null) {
    return { id, title, status: 'INCONCLUSIVE', detail: 'The screen could not be read.' };
  }
  if (evidence.names.includes(evidence.signedInOnlyName)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'An account whose address nobody confirmed reached this household’s data, so ' +
        'confirming an address is not in fact required for anything.',
    };
  }
  if (!evidence.names.includes(evidence.refusalHeading)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: 'The sign-in was refused and the screen said nothing about it.',
    };
  }
  if (!evidence.names.includes(evidence.refusalMessage)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'A refusal is shown, but not the one the app’s own mapping produces for an ' +
        'unconfirmed address - so the person is not told the thing they can act on.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      'The provider refused the account created moments earlier with `email_not_confirmed`, and ' +
      'the app said so in the sentence naming the next step. The link itself was never opened: ' +
      'that needs a mailbox (BLK-010).',
  };
}

// ---------------------------------------------------------------------------
// SIGN-11 - asking for a new password
// ---------------------------------------------------------------------------

/**
 * What the provider does with a recovery request, and whether the app renders it.
 *
 * `ACCEPTED` is the same answer for an address with an account and one without, deliberately, at
 * both ends: the provider answers 200 either way and the screen says so in as many words. A
 * recovery screen that distinguished them would be a way to find out who uses a medicines app.
 */
export type RecoveryProviderOutcome = 'ACCEPTED' | 'REFUSED' | 'UNREADABLE';

export interface RecoveryEvidence {
  readonly names: readonly string[] | null;
  readonly providerOutcome: RecoveryProviderOutcome;
  /** The heading the "a link is on its way, if that address has an account" state shows. */
  readonly sentHeading: string;
  readonly refusalHeading: string;
  /** The sentence the app's own mapping produces for the code the provider returned. */
  readonly expectedRefusalMessage: string | null;
}

export function recoveryCheck(evidence: RecoveryEvidence): Check {
  const id = 'SIGN-11';
  const title = 'Asking for a new password reaches the provider and is reported honestly';
  if (evidence.names === null || evidence.providerOutcome === 'UNREADABLE') {
    return {
      id,
      title,
      status: 'INCONCLUSIVE',
      detail: 'Either the screen or the provider could not be read.',
    };
  }

  if (evidence.providerOutcome === 'ACCEPTED') {
    if (evidence.names.includes(evidence.refusalHeading)) {
      return {
        id,
        title,
        status: 'FAIL',
        detail: 'The provider accepted the request and the app showed a refusal.',
      };
    }
    if (!evidence.names.includes(evidence.sentHeading)) {
      return {
        id,
        title,
        status: 'FAIL',
        detail: `The provider accepted the request and the app did not show "${evidence.sentHeading}".`,
      };
    }
    return {
      id,
      title,
      status: 'PASS',
      detail:
        'The provider accepted the recovery request and the app showed the state saying a link ' +
        'is on its way without saying whether the address has an account. Setting a new password ' +
        'from that link is not covered: it needs a mailbox (BLK-010).',
    };
  }

  if (!evidence.names.includes(evidence.refusalHeading)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'The provider refused the recovery request and the app said nothing about it - which ' +
        'leaves somebody waiting for a message that is not coming.',
    };
  }
  const expected = evidence.expectedRefusalMessage;
  if (expected !== null && !evidence.names.includes(expected)) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        'The app showed a refusal, but not the one its own mapping produces for the code the ' +
        'provider returned.',
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail:
      'The provider refused the recovery request and the app rendered the sentence its own ' +
      'mapping produces for that code, rather than claiming a message had been sent.',
  };
}
