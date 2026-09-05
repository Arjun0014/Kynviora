import { describe, it, expect } from 'vitest';
import {
  persistedSessionCheck,
  recoveryCheck,
  renewedSessionCheck,
  revokedSessionCheck,
  signedInCheck,
  signedOutCheck,
  signOutCheck,
  signUpCheck,
  tokenAtRestCheck,
  unconfirmedSignInCheck,
  wrongPasswordCheck,
} from './signIn.js';
import { overallStatus } from './analysis.js';

/**
 * The sign-in scenario's judgements, with no device attached.
 *
 * Spec references: `19` (device E2E scenario 14), `13`, `14`, `12`, DEC-102, DEC-118, DEC-124.
 *
 * WHY THESE ARE TESTED SEPARATELY FROM THE RUN
 * DEC-102's rule, and it earns its keep on this scenario more than most: nearly every check here
 * is an **absence** - no household content behind the gate, no token in a readable file, nothing
 * on screen after a sign-out - and an absence test that could not look passes trivially. Each of
 * them is therefore driven here with its evidence missing, and each has to answer `INCONCLUSIVE`
 * rather than `PASS`.
 */

const SUBMIT = 'Sign in';
const CREATE = 'Create an account';
const FORGOT = 'I have forgotten my password';
const REFUSAL = 'Not signed in';
const ITEM = 'Synthetic Tablet A';

describe('SIGN-1 - a signed-out app', () => {
  const base = {
    submitLabel: SUBMIT,
    createLabel: CREATE,
    forgotLabel: FORGOT,
    signedInOnlyName: ITEM,
  };

  it('passes with all three ways out and nothing behind them', () => {
    expect(signedOutCheck({ ...base, names: [SUBMIT, CREATE, FORGOT] }).status).toBe('PASS');
  });

  it('fails when a way out is missing, and says which', () => {
    const check = signedOutCheck({ ...base, names: [SUBMIT, CREATE] });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain(FORGOT);
  });

  it('fails when the app is reachable behind the gate', () => {
    // The half that matters more. A gate that renders the form *and* the app has gated nothing.
    const check = signedOutCheck({ ...base, names: [SUBMIT, CREATE, FORGOT, ITEM] });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain(ITEM);
  });

  it('is inconclusive when the screen could not be read', () => {
    expect(signedOutCheck({ ...base, names: null }).status).toBe('INCONCLUSIVE');
  });

  it('is inconclusive, not failing, when there is no sign-in screen at all', () => {
    // The distinction that cost a run. All three controls absent is not a gate with holes in it -
    // it is a build with no provider, where the app is `UNCONFIGURED` and every check after this
    // one is measuring something else. It happened for a mundane reason: Metro declined to start
    // on a port already in use and the device kept serving the previous bundle.
    const check = signedOutCheck({ ...base, names: ['Today', 'Shelf', ITEM] });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('EXPO_PUBLIC_SUPABASE_AUTH_URL');
  });
});

describe('SIGN-2 - creating an account through the app’s own form', () => {
  const base = {
    confirmationHeading: 'Check your email',
    refusalHeading: REFUSAL,
    expectedRefusalMessage: null,
  };

  const RATE_LIMITED = 'Too many attempts in a short time.';

  it('passes when an account now exists, unconfirmed, and the app pointed at a mailbox', () => {
    // The outcome this scenario is built to reach. `email_not_confirmed` for an address the app
    // submitted a moment ago is an account that exists at a real provider and cannot be used
    // until somebody opens a message - which is the user-facing sign-up flow, less the mailbox.
    expect(
      signUpCheck({ ...base, providerOutcome: 'CREATED_UNCONFIRMED', names: ['Check your email'] })
        .status,
    ).toBe('PASS');
  });

  it('fails when an account was created and the app showed a refusal', () => {
    // The defect worth having a check for: a project requiring confirmation returns a user and no
    // session, and an app rendering that as an error sends somebody to try again at an account
    // they made one second ago.
    expect(
      signUpCheck({ ...base, providerOutcome: 'CREATED_UNCONFIRMED', names: [REFUSAL] }).status,
    ).toBe('FAIL');
  });

  it('fails when an account was created and the app showed neither state', () => {
    expect(
      signUpCheck({ ...base, providerOutcome: 'CREATED_UNCONFIRMED', names: ['Create an account'] })
        .status,
    ).toBe('FAIL');
  });

  it('is inconclusive when the address came back already confirmed', () => {
    // Not a judgement about the app. `kynviora-dev` has `mailer_autoconfirm: false`; an address
    // confirmed the instant it is created means the project's configuration changed underneath
    // the run, and a scenario about confirmation cannot be run against a project without it.
    const check = signUpCheck({
      ...base,
      providerOutcome: 'CREATED_CONFIRMED',
      names: ['Check your email'],
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('no longer requires');
  });

  it('passes when nothing was created and the app said exactly what the provider refuses with', () => {
    // The usual answer against `kynviora-dev`, whose built-in mailer allows two messages an hour
    // - and a stronger measurement than the happy path, because a real provider code drives the
    // copy rather than a stub.
    expect(
      signUpCheck({
        ...base,
        providerOutcome: 'NOT_CREATED',
        expectedRefusalMessage: RATE_LIMITED,
        names: [REFUSAL, RATE_LIMITED],
      }).status,
    ).toBe('PASS');
  });

  it('fails when nothing was created and the app showed some other refusal', () => {
    expect(
      signUpCheck({
        ...base,
        providerOutcome: 'NOT_CREATED',
        expectedRefusalMessage: RATE_LIMITED,
        names: [REFUSAL, 'That email address and password do not go together.'],
      }).status,
    ).toBe('FAIL');
  });

  it('fails when nothing was created and the screen said nothing', () => {
    expect(
      signUpCheck({ ...base, providerOutcome: 'NOT_CREATED', names: ['Create an account'] }).status,
    ).toBe('FAIL');
  });

  it('is inconclusive when the two observations of the provider disagree', () => {
    // The repeat sign-up succeeded where the app's did not, which means the quota lifted in
    // between. Neither observation describes what the app was answered, so neither is reported.
    const check = signUpCheck({
      ...base,
      providerOutcome: 'NOT_CREATED',
      expectedRefusalMessage: null,
      names: [REFUSAL, RATE_LIMITED],
    });
    expect(check.status).toBe('INCONCLUSIVE');
  });

  it('is inconclusive when the provider could not be read', () => {
    expect(signUpCheck({ ...base, providerOutcome: 'UNREADABLE', names: [] }).status).toBe(
      'INCONCLUSIVE',
    );
  });

  it('is inconclusive when the screen could not be read', () => {
    expect(
      signUpCheck({ ...base, providerOutcome: 'CREATED_UNCONFIRMED', names: null }).status,
    ).toBe('INCONCLUSIVE');
  });
});

describe('SIGN-3 - a wrong password', () => {
  const base = {
    refusalHeading: REFUSAL,
    refusalMessage: 'That email address and password do not go together.',
    signedInOnlyName: ITEM,
  };

  it('passes when the refusal and its sentence are both on screen', () => {
    expect(wrongPasswordCheck({ ...base, names: [REFUSAL, base.refusalMessage] }).status).toBe(
      'PASS',
    );
  });

  it('fails when a wrong password signed somebody in', () => {
    expect(wrongPasswordCheck({ ...base, names: [ITEM] }).status).toBe('FAIL');
  });

  it('fails when the refusal was silent', () => {
    // A refusal the screen does not show is a person pressing the same button again, wondering
    // whether they mistyped it.
    expect(wrongPasswordCheck({ ...base, names: [SUBMIT] }).status).toBe('FAIL');
  });

  it('fails when some other refusal was shown', () => {
    expect(wrongPasswordCheck({ ...base, names: [REFUSAL, 'Something went wrong.'] }).status).toBe(
      'FAIL',
    );
  });
});

describe('SIGN-4 - signing in reaches this account’s data', () => {
  const base = { expectedItemName: ITEM, submitLabel: SUBMIT };

  it('passes when the household content is on screen and the gate is gone', () => {
    expect(signedInCheck({ ...base, names: [ITEM, 'Today'] }).status).toBe('PASS');
  });

  it('fails when the sign-in control is still there', () => {
    expect(signedInCheck({ ...base, names: [ITEM, SUBMIT] }).status).toBe('FAIL');
  });

  it('fails when signed in with nothing to show', () => {
    // The interesting failure: a token the API verified and refused to produce rows for is
    // indistinguishable, on a screen, from an empty account.
    expect(signedInCheck({ ...base, names: ['Today'] }).status).toBe('FAIL');
  });
});

describe('SIGN-5 - where the token is', () => {
  const fragment = 'a-long-distinctive-signature-segment';

  it('passes when no readable file holds it and the encrypted store exists', () => {
    const check = tokenAtRestCheck({
      plaintextFiles: [{ path: './shared_prefs/x.xml', content: '<map/>' }],
      tokenFragment: fragment,
      encryptedStoreBytes: 53_248,
    });
    expect(check.status).toBe('PASS');
  });

  it('fails when a readable file holds it, and names the file', () => {
    const check = tokenAtRestCheck({
      plaintextFiles: [{ path: './shared_prefs/leak.xml', content: `token=${fragment}` }],
      tokenFragment: fragment,
      encryptedStoreBytes: 53_248,
    });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('leak.xml');
  });

  it('is inconclusive with no encrypted store, because the absence would prove nothing', () => {
    // The positive control this check needs. An app that never signed in has no token anywhere,
    // and would pass an absence test while proving nothing at all.
    expect(
      tokenAtRestCheck({ plaintextFiles: [], tokenFragment: fragment, encryptedStoreBytes: 0 })
        .status,
    ).toBe('INCONCLUSIVE');
  });

  it('is inconclusive with no fragment to search for', () => {
    expect(
      tokenAtRestCheck({ plaintextFiles: [], tokenFragment: '', encryptedStoreBytes: 53_248 })
        .status,
    ).toBe('INCONCLUSIVE');
  });

  it('is inconclusive when the sandbox could not be listed', () => {
    expect(
      tokenAtRestCheck({
        plaintextFiles: null,
        tokenFragment: fragment,
        encryptedStoreBytes: 53_248,
      }).status,
    ).toBe('INCONCLUSIVE');
  });
});

describe('SIGN-6 - signing out', () => {
  const base = { submitLabel: SUBMIT, expectedItemName: ITEM };

  it('passes when the app is back at sign-in and the provider refuses the refresh token', () => {
    expect(signOutCheck({ ...base, names: [SUBMIT], refreshStillWorks: false }).status).toBe(
      'PASS',
    );
  });

  it('fails when household content is still on screen', () => {
    // `12`: sign-out removes decrypted projections and caches. A shelf still on screen is one the
    // next person to pick the phone up can read.
    expect(signOutCheck({ ...base, names: [SUBMIT, ITEM], refreshStillWorks: false }).status).toBe(
      'FAIL',
    );
  });

  it('fails when the session was forgotten here and left live at the provider', () => {
    // The half a screen cannot show, and the one that matters for a lost phone: a token somebody
    // copied would still work.
    const check = signOutCheck({ ...base, names: [SUBMIT], refreshStillWorks: true });
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('refresh token still works');
  });

  it('is inconclusive when the provider could not be asked', () => {
    expect(signOutCheck({ ...base, names: [SUBMIT], refreshStillWorks: null }).status).toBe(
      'INCONCLUSIVE',
    );
  });
});

describe('SIGN-7 - a session survives a restart', () => {
  const base = { expectedItemName: ITEM, submitLabel: SUBMIT };

  it('passes when the app comes back signed in', () => {
    expect(persistedSessionCheck({ ...base, names: [ITEM] }).status).toBe('PASS');
  });

  it('fails when the app asks for a sign-in again', () => {
    expect(persistedSessionCheck({ ...base, names: [SUBMIT] }).status).toBe('FAIL');
  });
});

describe('the run as a whole', () => {
  it('is not a pass with an inconclusive check in it (DEC-102)', () => {
    // The rule the whole scenario depends on: "could not look" must never be recorded as "looked
    // and it was fine", and almost every check here is an absence.
    const checks = [
      signedOutCheck({
        names: [SUBMIT, CREATE, FORGOT],
        submitLabel: SUBMIT,
        createLabel: CREATE,
        forgotLabel: FORGOT,
        signedInOnlyName: ITEM,
      }),
      tokenAtRestCheck({
        plaintextFiles: null,
        tokenFragment: 'x'.repeat(20),
        encryptedStoreBytes: 1,
      }),
    ];
    expect(overallStatus(checks)).not.toBe('PASS');
  });
});

describe('SIGN-8 - a session outliving its access token', () => {
  const base = {
    expectedItemName: ITEM,
    submitLabel: SUBMIT,
    accessTokenLifetimeSeconds: 3600,
  };

  it('passes when the clock passed the lifetime and the app came back with the account’s data', () => {
    expect(
      renewedSessionCheck({ ...base, clockAdvancedBySeconds: 3900, names: [ITEM] }).status,
    ).toBe('PASS');
  });

  it('is inconclusive when the clock did not move past the lifetime', () => {
    // The control this check cannot do without. A token that was never due was never renewed, so
    // "still signed in" is a sentence about a session that never expired - it would pass while
    // measuring nothing at all.
    const check = renewedSessionCheck({ ...base, clockAdvancedBySeconds: 120, names: [ITEM] });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.detail).toContain('proves nothing');
  });

  it('is inconclusive when the clock could not be read', () => {
    expect(
      renewedSessionCheck({ ...base, clockAdvancedBySeconds: null, names: [ITEM] }).status,
    ).toBe('INCONCLUSIVE');
  });

  it('fails when the app asked for a sign-in instead of renewing', () => {
    expect(
      renewedSessionCheck({ ...base, clockAdvancedBySeconds: 3900, names: [SUBMIT] }).status,
    ).toBe('FAIL');
  });

  it('fails when the app stayed signed in and showed none of the account’s data', () => {
    expect(
      renewedSessionCheck({ ...base, clockAdvancedBySeconds: 3900, names: ['Today'] }).status,
    ).toBe('FAIL');
  });

  it('is inconclusive when the screen could not be read', () => {
    expect(renewedSessionCheck({ ...base, clockAdvancedBySeconds: 3900, names: null }).status).toBe(
      'INCONCLUSIVE',
    );
  });
});

describe('SIGN-9 - a session revoked elsewhere', () => {
  const base = {
    submitLabel: SUBMIT,
    expectedItemName: ITEM,
    revoked: true,
    clockAdvancedBySeconds: 3900,
    accessTokenLifetimeSeconds: 3600,
  };

  it('passes when the phone was told nothing and returned to the sign-in screen anyway', () => {
    expect(revokedSessionCheck({ ...base, names: [SUBMIT] }).status).toBe('PASS');
  });

  it('fails when a withdrawn authorization leaves the phone working', () => {
    // `12`: losing authorization has to invalidate local access. A token that keeps verifying
    // against a published key set after the session behind it ended is exactly why this cannot be
    // inferred locally, and why the phone has to ask.
    expect(revokedSessionCheck({ ...base, names: [ITEM] }).status).toBe('FAIL');
  });

  it('fails when the sign-in screen is back but household content is still on it', () => {
    expect(revokedSessionCheck({ ...base, names: [SUBMIT, ITEM] }).status).toBe('FAIL');
  });

  it('is inconclusive when the revocation did not happen', () => {
    // Nothing was withdrawn, so a phone that still works has discovered nothing wrong.
    expect(revokedSessionCheck({ ...base, revoked: false, names: [ITEM] }).status).toBe(
      'INCONCLUSIVE',
    );
    expect(revokedSessionCheck({ ...base, revoked: null, names: [ITEM] }).status).toBe(
      'INCONCLUSIVE',
    );
  });

  it('is inconclusive when the token was not yet due, so nothing had asked the provider', () => {
    expect(revokedSessionCheck({ ...base, clockAdvancedBySeconds: 60, names: [ITEM] }).status).toBe(
      'INCONCLUSIVE',
    );
    expect(
      revokedSessionCheck({ ...base, clockAdvancedBySeconds: null, names: [ITEM] }).status,
    ).toBe('INCONCLUSIVE');
  });

  it('is inconclusive when the screen could not be read', () => {
    expect(revokedSessionCheck({ ...base, names: null }).status).toBe('INCONCLUSIVE');
  });
});

describe('SIGN-10 - an address nobody confirmed', () => {
  const UNCONFIRMED = 'Confirm your email address first.';
  const base = {
    refusalHeading: REFUSAL,
    refusalMessage: UNCONFIRMED,
    signedInOnlyName: ITEM,
    accountExists: true,
  };

  it('passes when the provider refused it and the app said what to do', () => {
    expect(unconfirmedSignInCheck({ ...base, names: [REFUSAL, UNCONFIRMED] }).status).toBe('PASS');
  });

  it('fails when an unconfirmed address reached the household’s data', () => {
    // The whole reason DEC-118 asked for a verified address. If this passes, confirming an
    // address is not required for anything and the confirmation flow is decoration.
    expect(unconfirmedSignInCheck({ ...base, names: [ITEM] }).status).toBe('FAIL');
  });

  it('fails when it was refused and the screen said nothing', () => {
    expect(unconfirmedSignInCheck({ ...base, names: ['Sign in'] }).status).toBe('FAIL');
  });

  it('fails when the refusal shown is not the one for an unconfirmed address', () => {
    expect(
      unconfirmedSignInCheck({
        ...base,
        names: [REFUSAL, 'That email address and password do not go together.'],
      }).status,
    ).toBe('FAIL');
  });

  it('is inconclusive when no account was created to be refused', () => {
    expect(unconfirmedSignInCheck({ ...base, accountExists: false, names: null }).status).toBe(
      'INCONCLUSIVE',
    );
  });

  it('is inconclusive when the screen could not be read', () => {
    expect(unconfirmedSignInCheck({ ...base, names: null }).status).toBe('INCONCLUSIVE');
  });
});

describe('SIGN-11 - asking for a new password', () => {
  const SENT = 'Check your email';
  const RATE_LIMITED = 'Too many attempts in a short time.';
  const base = {
    sentHeading: SENT,
    refusalHeading: REFUSAL,
    expectedRefusalMessage: null,
  };

  it('passes when the provider accepted it and the app said a link is on its way', () => {
    expect(recoveryCheck({ ...base, providerOutcome: 'ACCEPTED', names: [SENT] }).status).toBe(
      'PASS',
    );
  });

  it('fails when the provider accepted it and the app showed a refusal', () => {
    expect(recoveryCheck({ ...base, providerOutcome: 'ACCEPTED', names: [REFUSAL] }).status).toBe(
      'FAIL',
    );
  });

  it('fails when the provider accepted it and the app showed neither state', () => {
    expect(
      recoveryCheck({ ...base, providerOutcome: 'ACCEPTED', names: ['Forgotten password'] }).status,
    ).toBe('FAIL');
  });

  it('fails when the provider refused and the app claimed a message had been sent', () => {
    // The failure worth naming: somebody waits for a message that is not coming, and the screen
    // told them it was.
    expect(
      recoveryCheck({
        ...base,
        providerOutcome: 'REFUSED',
        expectedRefusalMessage: RATE_LIMITED,
        names: [SENT],
      }).status,
    ).toBe('FAIL');
  });

  it('passes when the provider refused and the app said exactly that', () => {
    expect(
      recoveryCheck({
        ...base,
        providerOutcome: 'REFUSED',
        expectedRefusalMessage: RATE_LIMITED,
        names: [REFUSAL, RATE_LIMITED],
      }).status,
    ).toBe('PASS');
  });

  it('fails when the refusal shown is not the one for the code returned', () => {
    expect(
      recoveryCheck({
        ...base,
        providerOutcome: 'REFUSED',
        expectedRefusalMessage: RATE_LIMITED,
        names: [REFUSAL, 'That does not look like an email address we can use.'],
      }).status,
    ).toBe('FAIL');
  });

  it('is inconclusive when the provider or the screen could not be read', () => {
    expect(recoveryCheck({ ...base, providerOutcome: 'UNREADABLE', names: [SENT] }).status).toBe(
      'INCONCLUSIVE',
    );
    expect(recoveryCheck({ ...base, providerOutcome: 'ACCEPTED', names: null }).status).toBe(
      'INCONCLUSIVE',
    );
  });
});
