/**
 * What the sign-in screens say, and what each refusal offers to do next.
 *
 * Spec references: `18` (an older adult is a primary audience: familiar words first, one action
 * per screen, a refusal that says what to do about it, and meaning never carried by colour
 * alone), `16` (say why a field is asked for), `13` (clients branch on codes, never on message
 * text), `19`, DEC-118, DEC-125.
 *
 * WHY THE COPY IS HERE AND NOT ON THE SCREEN
 * `apps/**` is outside the server test run, so a sentence written in a component is the one family
 * of user-visible strings nothing ever scans. Every screen in this app composes its words from
 * this package for the same reason, and the wording of a refusal is the part that matters most:
 * it is read by somebody who has just failed to get into their own account.
 *
 * THE ONE RULE THE REFUSALS FOLLOW
 * Each says **what happened** and **what to do**, in that order, and never guesses. The provider
 * does not distinguish a wrong password from an unknown address and neither does this - a screen
 * that said "we don't know that email" would be telling anybody with a phone which of their
 * contacts uses a medicines app.
 */

import { AUTH_FAILURES, type AuthFailure } from '@kynviora/domain';

export const SIGN_IN_COPY = Object.freeze({
  heading: 'Sign in',
  intro: 'Your medicines and the people you look after are kept behind your account.',
  emailLabel: 'Email address',
  passwordLabel: 'Password',
  submitLabel: 'Sign in',
  createLabel: 'Create an account',
  forgotLabel: 'I have forgotten my password',
  working: 'Signing in…',
  /** `14`: nothing is stored on this device until somebody has signed in. Worth saying once. */
  privacyNote:
    'Nothing about your medicines is kept on this phone until you sign in, and signing out removes it again.',
});

export const SIGN_UP_COPY = Object.freeze({
  heading: 'Create an account',
  intro: 'You will need an email address you can open, so you can confirm it is yours.',
  emailLabel: 'Email address',
  emailHelp:
    'Used to sign in, to send you a link if you forget your password, and to let somebody invite you to help them. Nothing else.',
  passwordLabel: 'Choose a password',
  passwordHelp: 'At least eight characters. Longer is better than complicated.',
  submitLabel: 'Create account',
  signInLabel: 'I already have an account',
  working: 'Creating your account…',
  /**
   * The state the project is actually in: confirmation is required, so sign-up ends at a mailbox
   * rather than in the app. Saying "check your email" and stopping is the honest end of the flow -
   * a screen that carried on would be pretending somebody was signed in.
   */
  confirmationHeading: 'Check your email',
  confirmationBody:
    'We have sent a message to that address with a link in it. Open the link to confirm the address, then come back and sign in.',
  confirmationNote: 'If it does not arrive in a few minutes, look in your spam folder.',
});

export const RECOVERY_COPY = Object.freeze({
  heading: 'Forgotten password',
  intro: 'Give us the address you signed up with and we will send you a link to set a new one.',
  emailLabel: 'Email address',
  submitLabel: 'Send me a link',
  signInLabel: 'Back to signing in',
  working: 'Sending…',
  /**
   * The same answer whether or not the address has an account, and it says so - which is both
   * honest and the thing that stops the screen being a way to find out who has an account.
   */
  sentHeading: 'Check your email',
  sentBody:
    'If that address has a Kynviora account, a link is on its way. We do not say whether it does, so that nobody can use this page to find out who uses Kynviora.',
});

export const SIGN_OUT_COPY = Object.freeze({
  label: 'Sign out',
  /** `12`: sign-out removes decrypted projections and caches, so say it before it happens. */
  hint: 'Signs you out on every device, and removes the copy of your medicines kept on this phone.',
  working: 'Signing out…',
});

/**
 * Setting an account up, in the moment between signing in and seeing anything.
 *
 * A verified subject is not an account (DEC-124), so there is one request between the two - and it
 * can be refused for a reason the person can act on. Each sentence below is one of those reasons.
 */
export const ACCOUNT_SETUP_COPY = Object.freeze({
  working: 'Setting up your account…',
  heading: 'We could not finish setting up',
  /**
   * The refusal DEC-125 exists to make: an address nobody has confirmed does not become an
   * account. It is retryable because somebody can confirm it in another app and come back.
   */
  emailNotConfirmed:
    'Your email address has not been confirmed yet. Open the link in the message we sent, then try again.',
  /** DEC-117 keeps the record; nothing revives it. There is no retry, so none is offered. */
  closed:
    'This account has been closed. If you want to use Kynviora again, create a new account with this address.',
  unavailable: 'We could not reach Kynviora to finish setting up. Check your connection.',
  retryLabel: 'Try again',
  signOutLabel: 'Sign out',
});

/**
 * Closing an account, which is the one action in this app that cannot be undone (`DEV-062`).
 *
 * Spec references: `16` (a person may have their data removed, and the workflow enumerates what
 * goes: device local data, primary records, object storage, derived projections, queued jobs,
 * cached exports, notification tokens and backups), `14` (re-authentication for high-impact
 * actions), `18` (say what a control will do before it does it; a refusal says what to do next),
 * DEC-117, DEC-120, DEC-125.
 *
 * THE THREE THINGS THIS COPY HAS TO GET RIGHT
 *
 * **Say what goes, before it goes.** Not "are you sure" - a list. Somebody deleting an account
 * after a bereavement is entitled to know that the dose history goes with it.
 *
 * **Say what does not go, and why.** `16` retains the *record that a deletion happened* for
 * twenty-four months (DEC-117), and a screen claiming everything disappears would be untrue. It
 * carries no medicines and no names, and saying so is the difference between a retention notice
 * and a reason to distrust the whole screen.
 *
 * **Ask for the password, in the same breath.** `14` requires re-authentication and the honest
 * framing is not a second dialog: it is the last field on the same screen, so the action and the
 * proof arrive together.
 */
export const DELETE_ACCOUNT_COPY = Object.freeze({
  openLabel: 'Delete my account',
  heading: 'Delete your account',
  intro: 'This closes your Kynviora account and removes what it holds. It cannot be undone.',
  /** Rendered as a list. Each line is a thing `16`'s deletion workflow enumerates. */
  removes: Object.freeze([
    'Everyone you have set up, and their medicines and personal-care items',
    'Every dose you have recorded, and every reminder you have scheduled',
    'Anything you have shared with a caregiver, and their access to it',
    'The copy of all of it kept on this phone',
  ]),
  keptHeading: 'What is kept',
  keptBody:
    'A record that an account was closed, and when. It is kept for two years because we have to be able to show that a deletion was carried out, and it holds no medicines, no names and no email address.',
  passwordLabel: 'Your password',
  passwordHelp:
    'Asked for because this cannot be undone, and so that a borrowed phone cannot do it.',
  submitLabel: 'Delete my account',
  cancelLabel: 'Keep my account',
  working: 'Deleting your account…',
  doneHeading: 'Your account is closed',
  doneBody: 'You have been signed out on every device. Nothing else is needed from you.',
  refusalHeading: 'We could not delete your account',
  /** Nothing was changed. The refusal DEC-125 makes rather than performing half a deletion. */
  unavailable:
    'Deleting an account is not available on this build, and nothing has been changed. Ask support to close it for you.',
  wrongPassword: 'That password was not right. Nothing has been changed.',
  /** The recoverable half-deletion: the data is gone, the sign-in account is not. */
  partial:
    'Your data has been removed. Closing your sign-in account did not finish - press Delete my account again to complete it.',
  offline: 'We could not reach Kynviora. Nothing has been changed.',
});

/**
 * The one thing this build cannot do, said where somebody would look for it.
 *
 * `19`'s device scenario for sign-up and sign-in is what this unblocks; the account-deletion half
 * needs a credential nobody has (`BLK-010`), and a screen offering a control that always refuses
 * would be worse than a screen saying so.
 */
export const AUTH_UNCONFIGURED_COPY = Object.freeze({
  heading: 'Signing in is not set up',
  body: 'This build has no sign-in service configured, so there is no account to sign in to.',
});

/**
 * The heading over a refusal.
 *
 * A word as well as a colour, because `18` forbids meaning carried by colour alone and a tinted
 * box is exactly that to somebody who cannot see the tint.
 */
export const AUTH_REFUSAL_HEADING = 'Not signed in';

export interface AuthRefusal {
  /** What happened, in the fewest familiar words that are true. */
  readonly message: string;
  /** What to do about it. Absent where there is genuinely nothing the person can do. */
  readonly nextStep?: string;
  /**
   * Whether the same attempt is worth making again.
   *
   * Drives whether the screen keeps the form filled in and offers the same button, or sends
   * somebody somewhere else. `18`: an action that cannot succeed should not be offered twice.
   */
  readonly retryable: boolean;
}

const REFUSALS: Readonly<Record<AuthFailure, AuthRefusal>> = Object.freeze({
  WRONG_CREDENTIALS: {
    // Deliberately about the pair, not about either one. The provider does not distinguish them.
    message: 'That email address and password do not go together.',
    nextStep: 'Check both and try again, or ask for a link to set a new password.',
    retryable: true,
  },
  EMAIL_UNCONFIRMED: {
    message: 'That address has not been confirmed yet.',
    nextStep: 'Open the link in the email we sent when you created the account, then sign in.',
    retryable: false,
  },
  EMAIL_ALREADY_REGISTERED: {
    message: 'There is already an account for that address.',
    nextStep: 'Sign in instead, or ask for a link if you have forgotten the password.',
    retryable: false,
  },
  EMAIL_INVALID: {
    message: 'That does not look like an email address we can use.',
    nextStep: 'Check it for a typo.',
    retryable: true,
  },
  PASSWORD_TOO_WEAK: {
    message: 'That password is too easy to guess.',
    nextStep:
      'Try a longer one. A few ordinary words together is easier to remember and harder to guess.',
    retryable: true,
  },
  RATE_LIMITED: {
    message: 'Too many attempts in a short time.',
    nextStep: 'Wait a few minutes and try again.',
    retryable: true,
  },
  SECOND_FACTOR_REQUIRED: {
    message: 'This account needs a code from your authenticator app.',
    nextStep: 'Open the app you set up and enter the six-digit code.',
    retryable: true,
  },
  SESSION_EXPIRED: {
    message: 'You have been signed out.',
    nextStep: 'Sign in again to carry on.',
    retryable: false,
  },
  SIGNUP_DISABLED: {
    message: 'New accounts are not being created at the moment.',
    // No next step, because there genuinely is not one. Inventing "try later" would be a guess.
    retryable: false,
  },
  UNAVAILABLE: {
    // Not "wrong password". Telling somebody their password is wrong when their signal dropped is
    // how they change a password that was fine.
    message: 'We could not reach the sign-in service.',
    nextStep: 'Check your connection and try again.',
    retryable: true,
  },
});

/** What to show for a refusal. Total over the closed set, so a new failure cannot ship unworded. */
export function authRefusal(failure: AuthFailure): AuthRefusal {
  return REFUSALS[failure];
}

/** Every failure, in vocabulary order. For a test that asserts none of them is unworded. */
export const ALL_AUTH_FAILURES: readonly AuthFailure[] = AUTH_FAILURES;
