/**
 * `19`'s fourteenth scenario: sign-up, sign-in, recovery, renewal and losing authorization, on a
 * phone, against a real provider.
 *
 *   npm run verify:device:signin
 *
 * Spec references: `19` (device E2E scenario 14), `13`, `14`, `12`, `18`, DEC-118, DEC-124,
 * DEC-125, `BLK-010`, `DEV-040`.
 *
 * WHAT HAS TO BE RUNNING, AND WHY EACH ONE
 * Three things, and this refuses rather than guessing if any is missing - a harness that drove a
 * development build would report on a screen that is not the one under test.
 *
 *   1. **Metro, bundled with the provider.** `EXPO_PUBLIC_SUPABASE_AUTH_URL` and
 *      `EXPO_PUBLIC_SUPABASE_ANON_KEY` are inlined at build time, so Metro has to have been
 *      started with them. Without them the app is `UNCONFIGURED`, shows no sign-in screen, and
 *      falls through to the development identity.
 *   2. **The API, verifying tokens.** `KYNVIORA_SUPABASE_ISSUER` set and `KYNVIORA_DEV_AUTH`
 *      unset - the two are mutually exclusive by construction (DEC-118 part 5), so this is one
 *      switch rather than two.
 *   3. **A confirmed account.** `KYNVIORA_SUPABASE_TEST_EMAIL` and `..._PASSWORD`, the same pair
 *      `services/api/src/supabaseLive.test.ts` uses.
 *
 * WHY THIS MOVES THE DEVICE'S CLOCK
 * Two of the eleven checks are about a session that has run out of access token, and the provider
 * issues them with an hour's life. Waiting is not a test strategy, so the run moves the emulator's
 * clock past the token's lifetime and restarts the app: the renewal rule reads `Date.now()` on the
 * phone, so a phone whose clock says the hour is up behaves exactly as one where it is. The clock
 * is restored to `auto_time` at the end, whatever happened.
 *
 * That trick is also what found the defect it now guards: dating a session by the provider's
 * absolute `expires_at` and renewing against the device's clock made a device an hour fast renew
 * in a loop. `readTokens` measures a duration from the receiving device's own clock instead.
 *
 * WHAT IS NOT COVERED, IN ONE SENTENCE
 * The email round trip: opening a mailbox is not something a harness can do, so no confirmation
 * link and no recovery link is ever followed (`BLK-010`).
 *
 * WHAT IT LEAVES BEHIND
 * The app signed **out**, the device clock back on automatic time, and every session for the test
 * account revoked at the provider. The `app_user` row it registers stays, as every other account
 * does; so does the unconfirmed account `SIGN-2` creates, which can never be signed in to.
 */

import { PACKAGE, adb, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
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
  type RecoveryProviderOutcome,
  type SignUpProviderOutcome,
} from './signIn.js';
import { authFailureFor } from '@kynviora/contracts';
import {
  AUTH_REFUSAL_HEADING,
  RECOVERY_COPY,
  SIGN_IN_COPY,
  SIGN_OUT_COPY,
  SIGN_UP_COPY,
  authRefusal,
} from '@kynviora/presentation';
import {
  captureFailure,
  centreOf,
  collectScreenText,
  dismissKeyboard,
  killApp,
  launch,
  prepareDeviceForDriving,
  scrollToAndTap,
  suppressStylusHandwriting,
  tapAt,
  tapNamed,
  typeInto,
  waitForNamed,
} from './ui.js';

const ISSUER = process.env.KYNVIORA_SUPABASE_ISSUER?.trim() ?? '';
const ANON_KEY = process.env.KYNVIORA_SUPABASE_ANON_KEY?.trim() ?? '';
const EMAIL = process.env.KYNVIORA_SUPABASE_TEST_EMAIL?.trim() ?? '';
const PASSWORD = process.env.KYNVIORA_SUPABASE_TEST_PASSWORD ?? '';

/** Something only this account's own shelf produces. Seeded synthetic content. */
const EXPECTED_ITEM = process.env.KYNVIORA_SIGNIN_EXPECTED_ITEM?.trim() ?? 'Synthetic Tablet A';

/** A synthetic password for the account the app creates. Never reused and never a real one. */
const NEW_PASSWORD = 'a-long-enough-synthetic-password';

/**
 * How far past the token's lifetime to move the clock.
 *
 * Five minutes, so a slow step between moving the clock and restarting the app cannot land inside
 * the lifetime and make a due renewal look undue.
 */
const CLOCK_OVERSHOOT_SECONDS = 300;

/**
 * Which half of the scenario to run. `all` unless told otherwise.
 *
 * `signup` exists for one reason, and it is a property of the provider rather than of this code.
 * `kynviora-dev` uses Supabase's built-in mailer, which allows two messages an hour - and the
 * limit is spent by an **attempt**, not by a delivery, so every probe that comes back
 * `over_email_send_rate_limit` pushes the window out again. A full run makes three such calls (the
 * app's sign-up, the repeat that reads the refusal code, and the recovery request), so running it
 * repeatedly is a way to guarantee the quota is never free when the app reaches for it.
 *
 * `KYNVIORA_SIGNIN_PHASES=signup` runs SIGN-1, SIGN-2 and SIGN-10 and makes **exactly one**
 * email-triggering call: the app's own. That is what a real account creation needs - an hour of
 * asking for nothing, then one attempt, made by the app rather than by the harness.
 */
const PHASES = process.env.KYNVIORA_SIGNIN_PHASES?.trim() === 'signup' ? 'signup' : 'all';

// ---------------------------------------------------------------------------
// The provider, asked directly
// ---------------------------------------------------------------------------

/**
 * Ask the provider something, across a run that blocks its own event loop for minutes at a time.
 *
 * `connection: close` and a retry, which is trap 187 and was learned on this suite before this
 * file existed: the scenario `sleep`s synchronously for forty-five seconds at a stretch, the
 * keep-alive socket is long dead by the next call, and the reused corpse throws. Without this it
 * cost three checks at once - SIGN-5, SIGN-6 and SIGN-9 all depend on one direct sign-in, and all
 * three reported `INCONCLUSIVE` for a reason that had nothing to do with authentication.
 */
async function providerFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${ISSUER}${path}`, {
        ...init,
        headers: {
          apikey: ANON_KEY,
          'content-type': 'application/json',
          connection: 'close',
          ...((init.headers as Record<string, string>) ?? {}),
        },
      });
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try {
        body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        body = {};
      }
      return { status: response.status, body };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

function errorCodeOf(body: Record<string, unknown>): string {
  return typeof body['error_code'] === 'string' ? body['error_code'] : '';
}

/**
 * What became of an address, asked of the provider with a password sign-in.
 *
 * The three answers are distinguishable and none needs a privilege - see `signIn.ts` for why this
 * asks about the address the **app** submitted rather than making a sign-up of its own.
 */
async function accountStateFor(email: string, password: string): Promise<SignUpProviderOutcome> {
  const answer = await providerFetch('/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (answer === null) return 'UNREADABLE';
  if (answer.status === 200) return 'CREATED_CONFIRMED';
  const code = errorCodeOf(answer.body);
  if (code === 'email_not_confirmed') return 'CREATED_UNCONFIRMED';
  if (code === 'invalid_credentials') return 'NOT_CREATED';
  return 'UNREADABLE';
}

/**
 * The sentence the **app's own** mapping produces for what the provider refuses this address with.
 *
 * Asked by repeating the sign-up the app just made, with the same address: if the app's attempt
 * created nothing, the address is still free and the same conditions still hold. `null` where the
 * repeat *succeeded* - which means the quota lifted in between, the two observations disagree, and
 * saying so beats reporting either one.
 */
async function signUpRefusalFor(email: string): Promise<string | null> {
  const answer = await providerFetch('/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password: NEW_PASSWORD }),
  });
  if (answer === null || answer.status === 200) return null;
  return authRefusal(authFailureFor(answer.status, errorCodeOf(answer.body))).message;
}

async function recoveryOutcomeFor(
  email: string,
): Promise<{ outcome: RecoveryProviderOutcome; expectedMessage: string | null }> {
  const answer = await providerFetch('/recover', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  if (answer === null) return { outcome: 'UNREADABLE', expectedMessage: null };
  if (answer.status === 200 || answer.status === 204) {
    return { outcome: 'ACCEPTED', expectedMessage: null };
  }
  return {
    outcome: 'REFUSED',
    expectedMessage: authRefusal(authFailureFor(answer.status, errorCodeOf(answer.body))).message,
  };
}

interface DirectSession {
  readonly access: string;
  readonly refresh: string;
  /** The provider's own `expires_in`, so "past its lifetime" is the provider's number. */
  readonly lifetimeSeconds: number;
}

/**
 * A session for the test account, used to read the provider's own view of it.
 *
 * Says why it failed. Three checks depend on this one call - SIGN-5's token fragment, SIGN-6's
 * revocation and SIGN-9's - so a silent `null` turns into three inconclusive results with no
 * indication that they share a cause, which is how a rate limit reads as three separate mysteries.
 */
async function signInDirectly(): Promise<DirectSession | null> {
  const answer = await providerFetch('/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (answer === null) {
    process.stdout.write('  the provider could not be reached for a direct sign-in\n');
    return null;
  }
  if (answer.status !== 200) {
    process.stdout.write(
      `  a direct sign-in was refused: HTTP ${String(answer.status)} ` +
        `${errorCodeOf(answer.body) || '(no code)'}\n`,
    );
    return null;
  }
  const access = answer.body['access_token'];
  const refresh = answer.body['refresh_token'];
  const expiresIn = answer.body['expires_in'];
  if (typeof access !== 'string' || typeof refresh !== 'string') return null;
  return {
    access,
    refresh,
    lifetimeSeconds: typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600,
  };
}

/** Whether the provider still honours a refresh token. `null` where it could not be asked. */
async function refreshStillWorks(refreshToken: string): Promise<boolean | null> {
  const answer = await providerFetch('/token?grant_type=refresh_token', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (answer === null) return null;
  return answer.status === 200;
}

/**
 * End every session this account holds anywhere, authenticated by one of them.
 *
 * Needs no privilege - it is the caller's own token - and it is what a person means by "sign out
 * everywhere". Here it stands in for the phone losing its authorization while nobody touches the
 * phone.
 */
async function revokeEverySession(bearer: string): Promise<boolean | null> {
  const answer = await providerFetch('/logout?scope=global', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: '{}',
  });
  if (answer === null) return null;
  return answer.status === 204 || answer.status === 200;
}

// ---------------------------------------------------------------------------
// The device's clock
// ---------------------------------------------------------------------------

function deviceEpoch(): number | null {
  const read = adb(['shell', 'date', '+%s']);
  if (!read.ok) return null;
  const value = Number.parseInt(read.stdout.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

/** How far ahead of real time the device's clock currently reads. Measured, never assumed. */
function clockSkewSeconds(): number | null {
  const device = deviceEpoch();
  if (device === null) return null;
  return device - Math.floor(Date.now() / 1000);
}

/**
 * Move the device's clock forward.
 *
 * `auto_time` off first, or the next NTP sync puts it back mid-check and a due token silently
 * stops being due. `adb root` because `date` is not a thing an unprivileged shell may set.
 */
function advanceDeviceClock(bySeconds: number): void {
  adb(['root']);
  sleep(3_000);
  adb(['shell', 'settings', 'put', 'global', 'auto_time', '0']);
  const now = deviceEpoch();
  if (now === null) return;
  adb(['shell', `date @${String(now + bySeconds)}`]);
  sleep(2_000);
}

/** Back to the host's time. Runs on every exit path, including a thrown error. */
function restoreDeviceClock(): void {
  adb(['shell', 'settings', 'put', 'global', 'auto_time', '1']);
  sleep(3_000);
}

// ---------------------------------------------------------------------------
// Reading the device
// ---------------------------------------------------------------------------

/** Readable files in the app's own sandbox, excluding the encrypted database itself. */
function sandboxFiles(): readonly { path: string; content: string }[] | null {
  const listing = adb(['shell', 'run-as', PACKAGE, 'find', '.', '-type', 'f']);
  if (!listing.ok) return null;
  const paths = listing.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.includes('kynviora.db'));

  const files: { path: string; content: string }[] = [];
  for (const path of paths.slice(0, 200)) {
    const read = adb(['shell', 'run-as', PACKAGE, 'cat', path]);
    if (read.ok) files.push({ path, content: read.stdout });
  }
  return files;
}

/**
 * How big the encrypted store is, or `null` where it could not be read.
 *
 * `stat`, and deliberately **no redirect**. `adb shell` joins its arguments back into one
 * string and hands it to the device's own shell without re-quoting, so a `<` inside
 * `sh -c '...'` is consumed by the *outer* shell - whose working directory is not the app's.
 * The read then fails with `can't open files/SQLite/kynviora.db` over a file that is sitting
 * there, and SIGN-5 reports "no encrypted database was found" about a device that has one
 * (trap 204). An argument cannot be redirected by the wrong shell.
 */
function encryptedStoreBytes(): number | null {
  const read = adb(['shell', 'run-as', PACKAGE, 'stat', '-c', '%s', 'files/SQLite/kynviora.db']);
  if (!read.ok) return null;
  const value = Number.parseInt(read.stdout.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function names(): readonly string[] | null {
  return collectScreenText();
}

/**
 * Kill the app, start it again, and wait for it to reach a state that is one of the two answers.
 *
 * A fixed sleep is a stopwatch, and this is the check it gets wrong: a cold start rebundles and
 * then fetches a shelf, and thirty-five seconds was a few short of it - so the app was signed in
 * with its data still arriving, and SIGN-7 reported "came back signed in and showed none of this
 * account's data", which reads exactly like a session that lost its contents. The same restart at
 * forty-five seconds passed. That is a stopwatch, not a finding (trap 205).
 *
 * So this waits for something **determinate** instead: either this account's data is on screen or
 * the sign-in control is, and both are answers. The reading it settles on is the one returned, so
 * waiting and looking are one operation rather than two that can disagree.
 */
function settledAfterRestart(deadlineMs = 90_000): readonly string[] | null {
  killApp();
  sleep(3_000);
  launch();
  sleep(15_000);

  const deadline = Date.now() + deadlineMs;
  let last: readonly string[] | null = null;
  for (;;) {
    last = collectScreenText();
    if (last !== null) {
      if (last.includes(EXPECTED_ITEM) || last.includes(SIGN_IN_COPY.submitLabel)) return last;
    }
    if (Date.now() >= deadline) return last;
    sleep(5_000);
  }
}

/**
 * Replace what is in a field, rather than adding to it.
 *
 * `typeInto` inserts at the cursor, which is right for an empty form and wrong here: this
 * scenario fills the same two fields five times, and a wrong password left in place would make
 * the next attempt fail for a reason the run then reports as a defect. The email field is the one
 * that bites - it is correct after the refused attempt, and typing it again would produce it
 * twice.
 *
 * `MOVE_END` then a run of deletes, because there is no "clear" key: `input text` has no way to
 * replace a selection and `KEYCODE_CLEAR` is not delivered to a React Native text input.
 */
function retype(name: string, value: string, existing = 96): { readonly typed: boolean } {
  const field = waitForNamed(name);
  if (field === null) return { typed: false };
  tapAt(centreOf(field));
  sleep(1_500);
  adb(['shell', 'input', 'keyevent', '123']);
  // One batch rather than one call per character: each `adb shell` is a round trip, and ninety-six
  // of them is a minute of nothing happening.
  adb(['shell', 'input', 'keyevent', ...Array.from({ length: existing }, () => '67')]);
  sleep(1_000);
  dismissKeyboard();
  return { typed: typeInto(name, value).typed };
}

function requireConfiguration(): string | null {
  if (!isInstalled()) {
    return `${PACKAGE} is not installed. Build it first:\n  cd apps/mobile && npx expo run:android`;
  }
  if (ISSUER === '' || ANON_KEY === '') {
    return (
      'KYNVIORA_SUPABASE_ISSUER and KYNVIORA_SUPABASE_ANON_KEY must be set, and Metro must have\n' +
      'been started with EXPO_PUBLIC_SUPABASE_AUTH_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY - Expo\n' +
      'inlines those at build time, so a Metro already running without them serves a bundle with\n' +
      'no sign-in screen in it.'
    );
  }
  if (EMAIL === '' || PASSWORD === '') {
    return 'KYNVIORA_SUPABASE_TEST_EMAIL and KYNVIORA_SUPABASE_TEST_PASSWORD must be set.';
  }
  return null;
}

async function run(checks: Check[]): Promise<void> {
  const wrongCredentials = authRefusal('WRONG_CREDENTIALS');
  const unconfirmed = authRefusal('EMAIL_UNCONFIRMED');

  prepareDeviceForDriving();
  suppressStylusHandwriting();

  // -------------------------------------------------------------------------
  // SIGN-1 - a clean start
  // -------------------------------------------------------------------------
  // Clearing app data is what makes "signed out" the starting state rather than whatever the last
  // run left, and it is the only way to reach SIGN-1 twice.
  adb(['shell', 'pm', 'clear', PACKAGE]);
  // `pm clear` revokes runtime permissions along with the data, so the app asks for notifications
  // on the next launch - and that dialog is a full-screen `permissioncontroller` window that eats
  // every tap this scenario makes. Granting it here is not a shortcut past a check: what
  // `verify:device:camera` measures is that the app does **not** ask for the camera, and this run
  // is about signing in (trap 201).
  adb(['shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS']);
  launch();
  sleep(45_000);

  if (waitForNamed(SIGN_IN_COPY.submitLabel, 60_000) === null) {
    captureFailure('signin-no-screen');
  }

  checks.push(
    signedOutCheck({
      names: names(),
      submitLabel: SIGN_IN_COPY.submitLabel,
      createLabel: SIGN_IN_COPY.createLabel,
      forgotLabel: SIGN_IN_COPY.forgotLabel,
      signedInOnlyName: EXPECTED_ITEM,
    }),
  );

  // -------------------------------------------------------------------------
  // SIGN-2 - creating an account, through the app's own form
  // -------------------------------------------------------------------------
  // The app goes first and the provider is asked afterwards, about this exact address. The
  // built-in mailer allows two messages an hour, so a probe made first could take the last of the
  // quota and hand the app the rate limit it then reported as the provider's usual behaviour.
  const appEmail = `kynviora-signin-${Date.now().toString(36)}@kynviora.test`;
  process.stdout.write(`Creating an account through the app: ${appEmail}\n`);

  if (scrollToAndTap(SIGN_IN_COPY.createLabel)) {
    sleep(2_000);
    typeInto(SIGN_UP_COPY.emailLabel, appEmail);
    typeInto(SIGN_UP_COPY.passwordLabel, NEW_PASSWORD);
    scrollToAndTap(SIGN_UP_COPY.submitLabel);
    sleep(10_000);
  } else {
    captureFailure('signin-no-create-control');
  }
  const signUpScreen = names();

  const signUpOutcome = await accountStateFor(appEmail, NEW_PASSWORD);
  process.stdout.write(`  the provider now says that address is: ${signUpOutcome}\n`);
  // The repeat that reads the refusal code is itself an email-triggering call, so in the phase
  // whose whole point is to spend the quota on the app's attempt, it is not made. SIGN-2 then
  // answers INCONCLUSIVE on a refusal rather than PASS, which is the correct trade: this phase is
  // run to find out whether an account can be created, not to grade a refusal.
  const signUpRefusal =
    signUpOutcome === 'NOT_CREATED' && PHASES === 'all' ? await signUpRefusalFor(appEmail) : null;

  checks.push(
    signUpCheck({
      names: signUpScreen,
      providerOutcome: signUpOutcome,
      confirmationHeading: SIGN_UP_COPY.confirmationHeading,
      refusalHeading: AUTH_REFUSAL_HEADING,
      expectedRefusalMessage: signUpRefusal,
    }),
  );

  // -------------------------------------------------------------------------
  // SIGN-10 - and it cannot be used until somebody confirms it
  // -------------------------------------------------------------------------
  const madeAnAccount = signUpOutcome === 'CREATED_UNCONFIRMED';
  if (madeAnAccount) {
    scrollToAndTap(SIGN_UP_COPY.signInLabel);
    sleep(2_000);
    retype(SIGN_IN_COPY.emailLabel, appEmail);
    retype(SIGN_IN_COPY.passwordLabel, NEW_PASSWORD);
    scrollToAndTap(SIGN_IN_COPY.submitLabel);
    sleep(8_000);
  }
  checks.push(
    unconfirmedSignInCheck({
      names: madeAnAccount ? names() : null,
      refusalHeading: AUTH_REFUSAL_HEADING,
      refusalMessage: unconfirmed.message,
      signedInOnlyName: EXPECTED_ITEM,
      accountExists: madeAnAccount,
    }),
  );

  // Everything below needs the account this run signs in as, and none of it is about sign-up.
  if (PHASES === 'signup') return;

  // -------------------------------------------------------------------------
  // SIGN-11 - asking for a new password
  // -------------------------------------------------------------------------
  if (!madeAnAccount) {
    // The sign-up screen is still on top where SIGN-10 did not navigate away from it.
    scrollToAndTap(SIGN_UP_COPY.signInLabel);
    sleep(2_000);
  }
  let recoveryScreen: readonly string[] | null = null;
  if (scrollToAndTap(SIGN_IN_COPY.forgotLabel)) {
    sleep(2_000);
    retype(RECOVERY_COPY.emailLabel, EMAIL);
    scrollToAndTap(RECOVERY_COPY.submitLabel);
    sleep(10_000);
    recoveryScreen = names();
  } else {
    captureFailure('signin-no-forgot-control');
  }
  const recovery = await recoveryOutcomeFor(EMAIL);
  process.stdout.write(`  the provider answers a recovery request with: ${recovery.outcome}\n`);
  checks.push(
    recoveryCheck({
      names: recoveryScreen,
      providerOutcome: recovery.outcome,
      sentHeading: RECOVERY_COPY.sentHeading,
      refusalHeading: AUTH_REFUSAL_HEADING,
      expectedRefusalMessage: recovery.expectedMessage,
    }),
  );

  // -------------------------------------------------------------------------
  // SIGN-3 - a wrong password
  // -------------------------------------------------------------------------
  // Back to the sign-in form from wherever recovery left the screen: the "sent" state offers the
  // way back, and the form itself offers it under a different label.
  if (!scrollToAndTap(RECOVERY_COPY.signInLabel)) scrollToAndTap(SIGN_UP_COPY.signInLabel);
  sleep(2_000);
  retype(SIGN_IN_COPY.emailLabel, EMAIL);
  retype(SIGN_IN_COPY.passwordLabel, 'definitely-not-the-password');
  scrollToAndTap(SIGN_IN_COPY.submitLabel);
  sleep(8_000);

  checks.push(
    wrongPasswordCheck({
      names: names(),
      refusalHeading: AUTH_REFUSAL_HEADING,
      refusalMessage: wrongCredentials.message,
      signedInOnlyName: EXPECTED_ITEM,
    }),
  );

  // -------------------------------------------------------------------------
  // SIGN-4 - the real one
  // -------------------------------------------------------------------------
  retype(SIGN_IN_COPY.emailLabel, EMAIL);
  retype(SIGN_IN_COPY.passwordLabel, PASSWORD);
  scrollToAndTap(SIGN_IN_COPY.submitLabel);
  sleep(25_000);

  const signedInNames = names();
  checks.push(
    signedInCheck({
      names: signedInNames,
      expectedItemName: EXPECTED_ITEM,
      submitLabel: SIGN_IN_COPY.submitLabel,
    }),
  );
  if (signedInNames !== null && !signedInNames.includes(EXPECTED_ITEM)) {
    captureFailure('signin-signed-in');
  }

  // -------------------------------------------------------------------------
  // SIGN-5 - where the token is
  // -------------------------------------------------------------------------
  // The fragment comes from a session this script obtained itself, not from the app's. Tokens are
  // per-session, so the app's own bytes are not on disk in a readable file either way - and what
  // is being measured is that the app's sandbox has no *JWT-shaped* plaintext in it at all, which
  // a distinctive fragment of a genuine token from the same issuer answers.
  const direct = await signInDirectly();
  const lifetime = direct?.lifetimeSeconds ?? 3600;
  checks.push(
    tokenAtRestCheck({
      plaintextFiles: sandboxFiles(),
      // The signature segment: high-entropy, per-session, and long enough that a match is not a
      // coincidence.
      tokenFragment: (direct?.access ?? '').split('.').at(2) ?? '',
      encryptedStoreBytes: encryptedStoreBytes(),
    }),
  );

  // -------------------------------------------------------------------------
  // SIGN-7 - it survives being killed
  // -------------------------------------------------------------------------
  // `am kill` after backgrounding, never `force-stop`: the reminders harness records why, and the
  // question here is whether the session was persisted rather than whether it was held in memory.
  const afterKill = settledAfterRestart();
  checks.push(
    persistedSessionCheck({
      names: afterKill,
      expectedItemName: EXPECTED_ITEM,
      submitLabel: SIGN_IN_COPY.submitLabel,
    }),
  );

  // -------------------------------------------------------------------------
  // SIGN-8 - it survives its access token running out
  // -------------------------------------------------------------------------
  process.stdout.write(
    `Moving the device clock past the token's ${String(lifetime)}s lifetime...\n`,
  );
  advanceDeviceClock(lifetime + CLOCK_OVERSHOOT_SECONDS);
  const skewAfterFirstMove = clockSkewSeconds();
  process.stdout.write(`  the device is now ${String(skewAfterFirstMove)}s ahead of real time\n`);
  const afterRenewal = settledAfterRestart();
  checks.push(
    renewedSessionCheck({
      names: afterRenewal,
      expectedItemName: EXPECTED_ITEM,
      submitLabel: SIGN_IN_COPY.submitLabel,
      clockAdvancedBySeconds: skewAfterFirstMove,
      accessTokenLifetimeSeconds: lifetime,
    }),
  );

  // -------------------------------------------------------------------------
  // SIGN-6 - signing out
  // -------------------------------------------------------------------------
  tapNamed('You');
  sleep(4_000);
  const pressed = scrollToAndTap(SIGN_OUT_COPY.label);
  if (!pressed) captureFailure('signin-no-signout-control');
  sleep(12_000);

  checks.push(
    signOutCheck({
      names: names(),
      submitLabel: SIGN_IN_COPY.submitLabel,
      expectedItemName: EXPECTED_ITEM,
      // The session this script holds was minted separately, so a *global* sign-out from the app
      // is what would revoke it. That is exactly what the app asks for, and it is the half a
      // screen cannot show.
      refreshStillWorks: direct === null ? null : await refreshStillWorks(direct.refresh),
    }),
  );

  // -------------------------------------------------------------------------
  // SIGN-9 - a session revoked elsewhere, while nobody touches the phone
  // -------------------------------------------------------------------------
  retype(SIGN_IN_COPY.emailLabel, EMAIL);
  retype(SIGN_IN_COPY.passwordLabel, PASSWORD);
  scrollToAndTap(SIGN_IN_COPY.submitLabel);
  sleep(25_000);
  const signedInAgain = names()?.includes(EXPECTED_ITEM) === true;

  // A second session of this harness's own - the first was revoked by the app's global sign-out,
  // which is SIGN-6 passing.
  const second = await signInDirectly();
  const revoked = signedInAgain && second !== null ? await revokeEverySession(second.access) : null;
  process.stdout.write(`  every session revoked at the provider: ${String(revoked)}\n`);

  // The phone is told nothing. It finds out when its token comes due and it asks.
  advanceDeviceClock(lifetime + CLOCK_OVERSHOOT_SECONDS);
  const skewAfterSecondMove = clockSkewSeconds();
  const afterRevocation = settledAfterRestart();

  checks.push(
    revokedSessionCheck({
      names: afterRevocation,
      submitLabel: SIGN_IN_COPY.submitLabel,
      expectedItemName: EXPECTED_ITEM,
      revoked,
      clockAdvancedBySeconds:
        skewAfterSecondMove === null || skewAfterFirstMove === null
          ? null
          : skewAfterSecondMove - skewAfterFirstMove,
      accessTokenLifetimeSeconds: lifetime,
    }),
  );
}

async function main(): Promise<void> {
  const refusal = requireConfiguration();
  if (refusal !== null) {
    process.stdout.write(`${refusal}\n`);
    process.exitCode = 1;
    return;
  }

  const checks: Check[] = [];
  try {
    await run(checks);
  } finally {
    // A device left an hour into the future is a device every later harness measures wrongly, so
    // this runs whatever happened - including after a throw.
    restoreDeviceClock();
    process.stdout.write(`Device clock restored; skew is now ${String(clockSkewSeconds())}s.\n`);
  }

  process.stdout.write(`\n${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  restoreDeviceClock();
  process.exitCode = 1;
});
