/**
 * Deleting an account, on a phone, against the real provider and the real database (`DEV-062`).
 *
 *   npm run verify:device:delete
 *
 * Spec references: `16` (removal workflow; the record that a deletion happened is retained),
 * `14` (re-authentication for high-impact actions), `12`, `18`, `13`, DEC-117, DEC-120, DEC-124,
 * DEC-125, `BLK-010`, `19`.
 *
 * WHAT HAS TO BE RUNNING
 * The same real stack `verify:device:signin` needs - Metro bundled with the provider, and the API
 * on `KYNVIORA_SUPABASE_ISSUER` with `KYNVIORA_DEV_AUTH` unset - plus one thing that scenario does
 * not need: a way to remove an identity. `KYNVIORA_SUPABASE_DELETION_FUNCTION_URL` (the
 * `close-identity` Edge Function) or `KYNVIORA_SUPABASE_SERVICE_KEY`. Without either, the route
 * refuses and changes nothing, which is correct and is not what this scenario is for.
 *
 * THE ACCOUNT THIS DELETES, SAID PLAINLY
 * `KYNVIORA_DELETE_TEST_EMAIL` - a synthetic account created and confirmed by an operator,
 * because confirming an address needs a mailbox and this environment has none (`BLK-010`). How it
 * came to exist is **not** evidence about sign-up or confirmation; `19`'s fourteenth scenario
 * measures what can be measured there. What is measured here is the deletion, and every step of
 * that is driven through the app by somebody signed in for real.
 *
 * The account is recreated by `scripts/device/provisionDeleteAccount.sql` - it has to be, because
 * a scenario that deletes its own subject cannot run twice without one.
 *
 * WHY IT SEEDS A PROFILE THROUGH THE API RATHER THAN THE SCREEN
 * DEL-5 asks whether everything under the account went with it, and over an account that owned
 * nothing that question answers itself. So the run creates a person first - through the real
 * route, with the account's own token, which is the same request the screen makes. Driving the
 * household form as well would add four minutes to prove something `verify:device:profile`
 * already proves.
 */

import { PACKAGE, adb, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import {
  dataRemovedCheck,
  deletionCompletedCheck,
  deletionRecordCheck,
  deletionWarningCheck,
  identityRemovedCheck,
  wrongPasswordDeletionCheck,
  type AccountRows,
  type IdentityState,
} from './deleteAccount.js';
import { withManagedClient, readMigrateDatabaseUrl } from '@kynviora/db';
import {
  DELETE_ACCOUNT_COPY,
  SIGN_IN_COPY,
} from '@kynviora/presentation';
import {
  captureFailure,
  centreOf,
  collectScreenText,
  dismissKeyboard,
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
const EMAIL = process.env.KYNVIORA_DELETE_TEST_EMAIL?.trim() ?? '';
const PASSWORD = process.env.KYNVIORA_DELETE_TEST_PASSWORD ?? '';
const API = 'http://127.0.0.1:3000';

/** Synthetic, and never a real person's name. */
const PROFILE_NAME = `Synthetic Deletion Subject ${Date.now().toString(36).slice(-4).toUpperCase()}`;

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

interface Session {
  readonly access: string;
  readonly userId: string;
}

/**
 * Ask the provider something, across a run that blocks its own event loop for minutes at a time.
 *
 * `connection: close` and a retry, which is trap 187: this scenario `sleep`s synchronously for
 * forty-five seconds at a stretch, the keep-alive socket is dead by the next call, and the reused
 * corpse throws. It cost `verify:device:signin` three checks at once before it was applied here.
 */
async function providerFetch(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${ISSUER}${path}`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

/** Sign in as the account under test. `null` where the provider refuses. */
async function signIn(): Promise<Session | null> {
  const answer = await providerFetch('/token?grant_type=password', {
    email: EMAIL,
    password: PASSWORD,
  });
  if (answer === null || answer.status !== 200) return null;
  const access = typeof answer.body['access_token'] === 'string' ? answer.body['access_token'] : '';
  const user = answer.body['user'] as { id?: unknown } | undefined;
  const userId = typeof user?.id === 'string' ? user.id : '';
  return access === '' || userId === '' ? null : { access, userId };
}

/**
 * Whether the identity still exists, from the only answer available without a privilege.
 *
 * `invalid_credentials` is what an address the provider has never heard of gets, and it is
 * deliberately what a wrong password gets too - so this only means anything about credentials
 * that worked a moment earlier, which is why DEL-4 requires that control.
 */
async function identityState(): Promise<IdentityState> {
  const answer = await providerFetch('/token?grant_type=password', {
    email: EMAIL,
    password: PASSWORD,
  });
  if (answer === null) return 'UNREADABLE';
  if (answer.status === 200) return 'STILL_THERE';
  return answer.body['error_code'] === 'invalid_credentials' ? 'GONE' : 'UNREADABLE';
}

// ---------------------------------------------------------------------------
// The API, as the account itself
// ---------------------------------------------------------------------------

async function apiCall(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  // The retry trap 187 records: `sleep` blocks the event loop for most of a run, so a pooled
  // connection is dead by the time the next call uses it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          connection: 'close',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

/** Register the account and give it one person to own, through the routes the screens use. */
async function seedSomethingToLose(token: string): Promise<boolean> {
  const registered = await apiCall('POST', '/v1/me', token, {});
  if (registered === null || (registered.status !== 200 && registered.status !== 201)) return false;

  const household = await apiCall('POST', '/v1/households', token, {
    displayName: 'Synthetic Deletion Household',
    idempotencyKey: `del-${Date.now().toString(36)}`,
  });
  if (household === null || (household.status !== 200 && household.status !== 201)) {
    // A household may already exist from an earlier run of this scenario against a recreated
    // account; a profile can still be added to it.
    process.stdout.write(`  (household: ${String(household?.status ?? 'unreachable')})\n`);
  }

  const profile = await apiCall('POST', '/v1/profiles', token, {
    displayName: PROFILE_NAME,
    relationship: 'SELF',
    idempotencyKey: `delp-${Date.now().toString(36)}`,
  });
  return profile !== null && (profile.status === 200 || profile.status === 201);
}

// ---------------------------------------------------------------------------
// The database, read with a credential that can see rows RLS would hide
// ---------------------------------------------------------------------------

async function accountRows(userId: string): Promise<AccountRows | null> {
  const url = readMigrateDatabaseUrl();
  if (url === null) return null;
  try {
    return await withManagedClient(url, async (client) => {
      const account = await client.query<{ stamped: boolean }>(
        'SELECT deleted_at IS NOT NULL AS stamped FROM app_user WHERE id = $1',
        [userId],
      );
      const profiles = await client.query<{ live: string; stamped: string }>(
        `SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS live,
                count(*) FILTER (WHERE deleted_at IS NOT NULL) AS stamped
           FROM profile WHERE owner_user_id = $1`,
        [userId],
      );
      const row = profiles.rows[0];
      return {
        accountStamped: account.rows[0]?.stamped ?? null,
        profilesLive: Number.parseInt(row?.live ?? '0', 10),
        profilesStamped: Number.parseInt(row?.stamped ?? '0', 10),
      };
    });
  } catch {
    return null;
  }
}

async function auditRows(
  userId: string,
): Promise<{ actions: string[]; details: string[] } | null> {
  const url = readMigrateDatabaseUrl();
  if (url === null) return null;
  try {
    return await withManagedClient(url, async (client) => {
      const found = await client.query<{ action: string; detail: string }>(
        `SELECT action, coalesce(detail::text, '') AS detail
           FROM audit_event WHERE target_id = $1 ORDER BY occurred_at`,
        [userId],
      );
      return {
        actions: found.rows.map((row) => row.action),
        details: found.rows.map((row) => row.detail),
      };
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------

function names(): readonly string[] | null {
  return collectScreenText();
}

/** Replace a field's contents rather than adding to them. The reason is in `verifySignIn.ts`. */
function retype(name: string, value: string, existing = 96): boolean {
  const field = waitForNamed(name);
  if (field === null) return false;
  tapAt(centreOf(field));
  sleep(1_500);
  adb(['shell', 'input', 'keyevent', '123']);
  adb(['shell', 'input', 'keyevent', ...Array.from({ length: existing }, () => '67')]);
  sleep(1_000);
  dismissKeyboard();
  return typeInto(name, value).typed;
}

/** Open You, then the deletion screen. */
function openDeletionScreen(): boolean {
  tapNamed('You');
  sleep(4_000);
  return scrollToAndTap(DELETE_ACCOUNT_COPY.openLabel);
}

function requireConfiguration(): string | null {
  if (!isInstalled()) {
    return `${PACKAGE} is not installed. Build it first:\n  cd apps/mobile && npx expo run:android`;
  }
  if (ISSUER === '' || ANON_KEY === '') {
    return 'KYNVIORA_SUPABASE_ISSUER and KYNVIORA_SUPABASE_ANON_KEY must be set.';
  }
  if (EMAIL === '' || PASSWORD === '') {
    return (
      'KYNVIORA_DELETE_TEST_EMAIL and KYNVIORA_DELETE_TEST_PASSWORD must be set. This scenario\n' +
      'deletes the account it signs in as, so it must never be the one `verify:device:signin`\n' +
      'uses. Recreate it with scripts/device/provisionDeleteAccount.sql.'
    );
  }
  if (EMAIL === (process.env.KYNVIORA_SUPABASE_TEST_EMAIL?.trim() ?? ' ')) {
    return (
      'KYNVIORA_DELETE_TEST_EMAIL is the same account as KYNVIORA_SUPABASE_TEST_EMAIL. This run\n' +
      'would delete the account every other scenario signs in as.'
    );
  }
  if (readMigrateDatabaseUrl() === null) {
    return 'KYNVIORA_MIGRATE_DATABASE_URL must be set: three of the six checks read the database.';
  }
  return null;
}

async function run(checks: Check[]): Promise<void> {
  // ---------------------------------------------------------------------------
  // Setting up: an account with something to lose
  // ---------------------------------------------------------------------------
  const session = await signIn();
  if (session === null) {
    process.stdout.write(
      `Could not sign in as ${EMAIL}. Recreate it first:\n` +
        '  scripts/device/provisionDeleteAccount.sql\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Signed in as the account under test (${session.userId}).\n`);

  const seeded = await seedSomethingToLose(session.access);
  process.stdout.write(`  seeded a profile to be removed with it: ${String(seeded)}\n`);
  const rowsBefore = await accountRows(session.userId);
  process.stdout.write(
    `  before: account stamped=${String(rowsBefore?.accountStamped)}, ` +
      `profiles live=${String(rowsBefore?.profilesLive)}\n`,
  );

  prepareDeviceForDriving();
  suppressStylusHandwriting();

  adb(['shell', 'pm', 'clear', PACKAGE]);
  // `pm clear` revokes runtime permissions with the data, and the notification dialog that then
  // appears is a full-screen window that eats every tap (trap 201).
  adb(['shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS']);
  launch();
  sleep(45_000);

  if (waitForNamed(SIGN_IN_COPY.submitLabel, 60_000) === null) {
    captureFailure('delete-no-signin-screen');
  }
  retype(SIGN_IN_COPY.emailLabel, EMAIL);
  retype(SIGN_IN_COPY.passwordLabel, PASSWORD);
  scrollToAndTap(SIGN_IN_COPY.submitLabel);
  sleep(25_000);

  // ---------------------------------------------------------------------------
  // DEL-1 - what it says before it does anything
  // ---------------------------------------------------------------------------
  if (!openDeletionScreen()) captureFailure('delete-no-open-control');
  sleep(3_000);
  checks.push(
    deletionWarningCheck({
      names: names(),
      mustName: DELETE_ACCOUNT_COPY.removes,
      retentionSentence: DELETE_ACCOUNT_COPY.keptBody,
      submitLabel: DELETE_ACCOUNT_COPY.submitLabel,
    }),
  );

  // ---------------------------------------------------------------------------
  // DEL-2 - a wrong password changes nothing
  // ---------------------------------------------------------------------------
  retype(DELETE_ACCOUNT_COPY.passwordLabel, 'definitely-not-the-password');
  scrollToAndTap(DELETE_ACCOUNT_COPY.submitLabel);
  sleep(12_000);
  const afterWrong = names();
  const rowsAfterWrong = await accountRows(session.userId);
  checks.push(
    wrongPasswordDeletionCheck({
      names: afterWrong,
      refusalHeading: DELETE_ACCOUNT_COPY.refusalHeading,
      rowsAfter: rowsAfterWrong,
      signedInOnlyName: PROFILE_NAME,
    }),
  );

  // ---------------------------------------------------------------------------
  // DEL-3 - and the right one does
  // ---------------------------------------------------------------------------
  // The control DEL-4 needs, taken while the account still exists: these exact credentials work.
  const workedBefore = (await signIn()) !== null;

  retype(DELETE_ACCOUNT_COPY.passwordLabel, PASSWORD);
  scrollToAndTap(DELETE_ACCOUNT_COPY.submitLabel);
  sleep(20_000);

  const afterDelete = names();
  checks.push(
    deletionCompletedCheck({
      names: afterDelete,
      submitLabel: SIGN_IN_COPY.submitLabel,
      signedInOnlyName: PROFILE_NAME,
      refusalHeading: DELETE_ACCOUNT_COPY.refusalHeading,
    }),
  );
  if (afterDelete !== null && !afterDelete.includes(SIGN_IN_COPY.submitLabel)) {
    captureFailure('delete-after');
  }

  // ---------------------------------------------------------------------------
  // DEL-4, DEL-5, DEL-6 - what is left, at the provider and in the database
  // ---------------------------------------------------------------------------
  const identity = await identityState();
  process.stdout.write(`  the provider now says the identity is: ${identity}\n`);
  checks.push(identityRemovedCheck({ identity, workedBefore }));

  const rowsAfter = await accountRows(session.userId);
  process.stdout.write(
    `  after: account stamped=${String(rowsAfter?.accountStamped)}, ` +
      `profiles live=${String(rowsAfter?.profilesLive)}, ` +
      `stamped=${String(rowsAfter?.profilesStamped)}\n`,
  );
  checks.push(dataRemovedCheck({ rowsBefore, rowsAfter }));

  const audit = await auditRows(session.userId);
  checks.push(
    deletionRecordCheck({
      actions: audit?.actions ?? null,
      details: audit?.details ?? null,
      email: EMAIL,
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
  await run(checks);
  if (checks.length === 0) return;

  process.stdout.write(`\n${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
