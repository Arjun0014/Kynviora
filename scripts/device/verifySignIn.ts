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
  processId,
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
 * The domain the app's sign-up address is at, and the reason SIGN-10 has never produced an account.
 *
 * **This project refuses an address it cannot deliver to, before the account exists.** Measured in
 * the provider's own auth log on 2026-09-06: the app's sign-up to
 * `kynviora-signin-mtp2e532@kynviora.test` answered
 * `400 email_address_invalid`, "Email address ... is invalid", carrying an
 * `auth_event` of `user_confirmation_requested` - so GoTrue got as far as sending the
 * confirmation, could not, and rolled the user back. `kynviora.test` has no MX record at all;
 * `example.com` and `example.org` publish a null MX (RFC 7505), which is a domain saying in the
 * DNS that it accepts no mail.
 *
 * That is not the mailer quota, which is what four runs of this scenario recorded it as. The
 * quota is real - two messages an hour, spent by an attempt - but it never fired here: no
 * `over_email_send_rate_limit` appears in the provider's log for any of those runs, and a refusal
 * for an undeliverable address costs none of it, because nothing is sent.
 *
 * So creating an account through the app's own form needs an address at a domain that accepts
 * mail, which is a **mailbox** - `BLK-010`, the same blocker as confirmation and recovery, rather
 * than a separate one. Set this to a domain whose mail somebody can receive and SIGN-10 becomes
 * measurable; leave it and the run reports honestly that the provider refused the address.
 */
const SIGN_UP_DOMAIN = process.env.KYNVIORA_SIGNIN_SIGNUP_DOMAIN?.trim() ?? 'kynviora.test';

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
 *
 * `KYNVIORA_SIGNIN_PHASES=session` is the other side of the same constraint and exists so that the
 * half of this scenario which has nothing to do with email can be re-run while the quota is being
 * deliberately left alone. It runs SIGN-1 and SIGN-3 to SIGN-9 - signing in, the session at rest,
 * surviving a kill, renewal, signing out, revocation - and makes **no** email-triggering call at
 * all. Without it, measuring a renewal defect twice costs the hour that creating an account needs.
 */
type Phase = 'all' | 'signup' | 'session';

const PHASES: Phase = ((): Phase => {
  const asked = process.env.KYNVIORA_SIGNIN_PHASES?.trim();
  return asked === 'signup' || asked === 'session' ? asked : 'all';
})();

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

/** The two ports the phone reaches this machine through, and cannot work without. */
const METRO_PORT = 8081;
const API_PORT = 3000;

/**
 * Put back the `adb reverse` tunnels, and say whether they are there.
 *
 * `adb reverse` is idempotent, so re-establishing one that already exists costs a round trip and
 * nothing else. The listing is read back rather than the exit codes trusted: `adb reverse` returns
 * success for a mapping the device then does not hold, and the whole point of this function is
 * that a missing tunnel had been invisible.
 */
function reverseTunnelsRestored(): boolean {
  adb(['reverse', `tcp:${String(METRO_PORT)}`, `tcp:${String(METRO_PORT)}`]);
  adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(API_PORT)}`]);
  const listed = adb(['reverse', '--list']);
  if (!listed.ok) return false;
  return (
    listed.stdout.includes(`tcp:${String(METRO_PORT)}`) &&
    listed.stdout.includes(`tcp:${String(API_PORT)}`)
  );
}

/**
 * Move the device's clock forward.
 *
 * `auto_time` off first, or the next NTP sync puts it back mid-check and a due token silently
 * stops being due. `adb root` because `date` is not a thing an unprivileged shell may set.
 *
 * AND THE PART THAT COST TWO CHECKS
 * **`adb root` restarts adbd, and every `adb reverse` mapping dies with it.** They are held by the
 * device's own daemon, not by the host, so a restart takes them all - measured on 2026-09-06:
 * `adb reverse --list` names both ports before `adb root` and is empty after it.
 *
 * Every step of this scenario from here on is a phone that has been cut off from Metro *and* from
 * the API, and nothing said so. SIGN-8 and SIGN-9 - the renewal and the revocation, the only two
 * checks that run after the clock moves - were measuring an app with no route to anything, and
 * their failures were read as a defect in the renewal. It is also why the API log had no `401`s in
 * it for the whole run: no request reached the API to be refused (trap 208).
 *
 * `verifyReminders.ts` already knew this - `setDeviceTimeZone` puts both tunnels back after its
 * own `adb root` - which is what makes it a trap rather than a discovery: the lesson existed in
 * this directory and the newest harness in it did not have it.
 *
 * So they go back, and whether they came back is evidence the checks are given rather than an
 * assumption they make (DEC-102: a check that could not look must not report a pass **or** a
 * failure).
 */
function advanceDeviceClock(bySeconds: number): boolean {
  adb(['root']);
  sleep(3_000);
  adb(['wait-for-device']);
  adb(['shell', 'settings', 'put', 'global', 'auto_time', '0']);
  const now = deviceEpoch();
  if (now === null) return false;
  adb(['shell', `date @${String(now + bySeconds)}`]);
  sleep(2_000);
  const restored = reverseTunnelsRestored();
  process.stdout.write(`  the phone can reach this machine again: ${String(restored)}\n`);
  return restored;
}

/**
 * Back to the host's time. Runs on every exit path, including a thrown error.
 *
 * The tunnels go back too, because the next harness to run assumes they are there and the one
 * that broke them is the one that should put them back.
 */
function restoreDeviceClock(): void {
  adb(['shell', 'settings', 'put', 'global', 'auto_time', '1']);
  sleep(3_000);
  reverseTunnelsRestored();
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
  // Twenty seconds and then a patient wait, rather than a stopwatch. `pm clear` takes the app's
  // data with it, so this launch re-creates the encrypted store and asks the keystore for a key,
  // and on an emulator booted minutes earlier it is also the run that pays for dex optimisation
  // and the first bundle. Three minutes is far more than any of that needs and it costs nothing
  // when the screen is there in twenty seconds, because `waitForNamed` returns the moment it is
  // (trap 205, which SIGN-7 learned first and this did not).
  sleep(20_000);

  if (waitForNamed(SIGN_IN_COPY.submitLabel, 180_000) === null) {
    captureFailure('signin-no-screen');
  }

  // Whether the subject of this run is still there, asked before anything is concluded about what
  // it shows. A native crash on the first Fabric mount leaves the home screen up and every check
  // after it measuring an app that is not running - which happened on 2026-09-06 and produced six
  // failures and two inconclusive results, none of them about authentication.
  const running = processId() !== null;
  checks.push(
    signedOutCheck({
      names: names(),
      submitLabel: SIGN_IN_COPY.submitLabel,
      createLabel: SIGN_IN_COPY.createLabel,
      forgotLabel: SIGN_IN_COPY.forgotLabel,
      signedInOnlyName: EXPECTED_ITEM,
      appRunning: running,
    }),
  );
  if (!running) {
    // Stop. Every check below drives a screen, and a run that carried on would report each of them
    // as a defect in the app rather than as the one thing that is true: the app is not running.
    process.stdout.write(
      'The app is not running after launch - it crashed or would not start. Stopping here; ' +
        '`adb logcat -b crash` says why.\n',
    );
    return;
  }

  // -------------------------------------------------------------------------
  // SIGN-2 - creating an account, through the app's own form
  // -------------------------------------------------------------------------
  // The app goes first and the provider is asked afterwards, about this exact address. The
  // built-in mailer allows two messages an hour, so a probe made first could take the last of the
  // quota and hand the app the rate limit it then reported as the provider's usual behaviour.
  //
  // Skipped whole in the `session` phase, along with SIGN-10 and SIGN-11: those three are every
  // email-triggering call this scenario makes, and the point of that phase is to make none.
  if (PHASES !== 'session') await signUpPhase(checks, unconfirmed);
  if (PHASES === 'signup') return;

  await sessionPhase(checks, wrongCredentials);
}

/** SIGN-2 and SIGN-10: creating an account through the app's own form, and what it is worth. */
async function signUpPhase(checks: Check[], unconfirmed: { message: string }): Promise<void> {
  const appEmail = `kynviora-signin-${Date.now().toString(36)}@${SIGN_UP_DOMAIN}`;
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

  // The sign-up screen is still on top where SIGN-10 did not navigate away from it.
  if (!madeAnAccount) {
    scrollToAndTap(SIGN_UP_COPY.signInLabel);
    sleep(2_000);
  }
}

/**
 * SIGN-11 and SIGN-3 to SIGN-9: everything about a session, from the sign-in screen.
 *
 * SIGN-11 is here rather than in the sign-up phase because it is about the account this run signs
 * in as. It is the one email-triggering call in this half, and it is skipped in `session`.
 */
async function sessionPhase(checks: Check[], wrongCredentials: { message: string }): Promise<void> {
  // -------------------------------------------------------------------------
  // SIGN-11 - asking for a new password
  // -------------------------------------------------------------------------
  let recoveryScreen: readonly string[] | null = null;
  if (PHASES !== 'session' && scrollToAndTap(SIGN_IN_COPY.forgotLabel)) {
    sleep(2_000);
    retype(RECOVERY_COPY.emailLabel, EMAIL);
    scrollToAndTap(RECOVERY_COPY.submitLabel);
    sleep(10_000);
    recoveryScreen = names();
  } else if (PHASES !== 'session') {
    captureFailure('signin-no-forgot-control');
  }
  if (PHASES !== 'session') {
    // The probe is made **only where the app was refused**, and that is trap 206 applied to this
    // check rather than to SIGN-2's.
    //
    // `/recover` is an email-triggering call and the built-in mailer allows two an hour, spent by
    // an attempt rather than by a delivery. A full run already makes two - the app's sign-up and
    // the app's recovery - so a probe made unconditionally is the third, comes back rate-limited,
    // and this check then compares a refusal *the probe* received against a screen reporting what
    // *the app* was told. Those are two different requests, and reading one as the other is the
    // error that once made SIGN-2 report a rate limit as the provider's usual behaviour.
    //
    // Where the app showed the sent state there is nothing left to ask: it renders that only on a
    // 200 or a 204, so the provider accepted **the request the app made**, and asking again spends
    // a message to learn about a different one. Where the app showed a refusal the quota was not
    // spent by it, the address is in the same condition, and the repeat is both affordable and
    // about the same thing - which is exactly where the mapping is worth checking.
    const appWasRefused = recoveryScreen?.includes(AUTH_REFUSAL_HEADING) === true;
    const recovery = appWasRefused
      ? await recoveryOutcomeFor(EMAIL)
      : { outcome: 'ACCEPTED' as const, expectedMessage: null };
    process.stdout.write(
      `  the provider answers a recovery request with: ${recovery.outcome}` +
        `${appWasRefused ? '' : ' (not asked again - the app was not refused)'}\n`,
    );
    checks.push(
      recoveryCheck({
        names: recoveryScreen,
        providerOutcome: recovery.outcome,
        sentHeading: RECOVERY_COPY.sentHeading,
        refusalHeading: AUTH_REFUSAL_HEADING,
        expectedRefusalMessage: recovery.expectedMessage,
      }),
    );
  }

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
  const reachableAfterFirstMove = advanceDeviceClock(lifetime + CLOCK_OVERSHOOT_SECONDS);
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
      canReachHost: reachableAfterFirstMove,
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
  const reachableAfterSecondMove = advanceDeviceClock(lifetime + CLOCK_OVERSHOOT_SECONDS);
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
      canReachHost: reachableAfterSecondMove,
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
