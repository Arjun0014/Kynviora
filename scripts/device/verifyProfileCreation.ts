/**
 * Prove - or fail to prove - that somebody can add a person to their household on a phone.
 *
 * Spec references: `19` ("Profile creation"), `04` Phase 1.2 (a household and the people in it,
 * with a clear distinction between the account holder and somebody they look after), `13`, `16`,
 * `DEV-040`, `DEV-043`.
 *
 *   npm run verify:device:profile
 *
 * WHY THIS IS NOT A FORMALITY
 * `DEV-040` listed this as "built and untested on device", which read like a queue of easy work.
 * It was not: both idempotency keys in `SetUpHousehold.tsx` came from `crypto.randomUUID()`, and
 * Hermes has no `crypto`, so "Add this person" threw before it reached the network. The flow had
 * never worked on a phone and no gate in this project could have said so (`DEV-043`). This run is
 * what turns "built" into "works".
 *
 * WHAT IS ACTUALLY DONE TO THE DEVICE
 * The You tab is opened, "Add someone" is tapped, a name is typed into the form and saved. Nothing
 * is written into the app by this script: the profile is created by the app's own code path, and
 * the API is read from the host only to see what arrived.
 *
 * WHAT IT LEAVES BEHIND
 * A profile, permanently - `04` Phase 1.2 has no removal path and the schema grants the app role
 * none. Each run therefore adds one person to the development household, under a name carrying
 * this run's own suffix so that runs can be told apart. It belongs on the synthetic seed and
 * nowhere near a household somebody uses.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { PACKAGE, adb, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import {
  profileCreatedCheck,
  profileFormCheck,
  profilePreconditionCheck,
  profileVisibleCheck,
  type ServerProfile,
} from './profileCreation.js';
import {
  captureFailure,
  currentNodes,
  launch,
  scrollToAndTap,
  suppressStylusHandwriting,
  tapNamed,
  typeInto,
  waitForNamed,
} from './ui.js';

const API_PORT = 3000;
const USER_ID = '00000000-0000-4000-8000-00000000d001';
const HOUSEHOLD_ID = '00000000-0000-4000-8000-00000000d010';

/**
 * The name this run creates.
 *
 * Suffixed, because profiles cannot be deleted and a fixed name would make the second run of this
 * harness inconclusive for ever. Synthetic on purpose: no real name is ever written into a
 * committed check or into a development database.
 */
const INTENDED_NAME = `Synthetic Relative ${Date.now().toString(36).slice(-4).toUpperCase()}`;

async function apiFetch(path: string): Promise<Response | null> {
  // The same retry the offline harness needs, for the same reason: `sleep` blocks the event loop
  // for most of a run, so a pooled connection is dead by the time the next call uses it (trap 187).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(`http://127.0.0.1:${String(API_PORT)}${path}`, {
        headers: { 'x-kynviora-dev-user': USER_ID, connection: 'close' },
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

/** `null` where the server could not be read, which is not the same as "there are none". */
async function serverProfiles(): Promise<readonly ServerProfile[] | null> {
  const response = await apiFetch('/v1/profiles');
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as { readonly profiles?: readonly ServerProfile[] };
  return body.profiles ?? null;
}

async function main(): Promise<void> {
  if (!isInstalled()) {
    process.stdout.write(
      `${PACKAGE} is not installed on the attached device.\n` +
        '  cd apps/mobile && npx expo run:android\n',
    );
    process.exitCode = 1;
    return;
  }

  const before = await serverProfiles();
  if (before === null) {
    process.stdout.write(
      `No seeded API on 127.0.0.1:${String(API_PORT)}. This scenario creates a profile through\n` +
        'the real route, so there has to be one:\n' +
        '  KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev\n',
    );
    process.exitCode = 1;
    return;
  }

  const checks: Check[] = [];
  checks.push(profilePreconditionCheck({ before, intendedName: INTENDED_NAME }));

  suppressStylusHandwriting();
  adb(['shell', 'am', 'force-stop', PACKAGE]);
  launch();
  sleep(45_000);

  process.stdout.write(`Adding ${INTENDED_NAME}...\n`);
  const steps: (readonly [string, boolean])[] = [];
  const step = (what: string, run: () => boolean): boolean => {
    const happened = run();
    steps.push([what, happened]);
    if (!happened) captureFailure(`profile-${what.replace(/[^a-z]+/gi, '-')}`);
    return happened;
  };

  let nameHeld: string | null = null;
  if (step('open the You tab', () => tapNamed('You'))) {
    sleep(5_000);
    if (step('open the add-a-person form', () => scrollToAndTap('Add someone'))) {
      sleep(3_000);
      // By prefix: the field announces its label and then its own help sentence, and pinning the
      // whole string would make this fail on a wording change that broke nothing.
      const typed = typeInto({ startsWith: 'Name.' }, INTENDED_NAME);
      nameHeld = typed.held;
      steps.push(['type the name', typed.typed]);
      if (typed.typed) step('save the person', () => scrollToAndTap('Add this person'));
    }
  }
  sleep(10_000);

  checks.push(profileFormCheck({ steps, nameHeld, intendedName: INTENDED_NAME }));

  // Scrolled for, not glanced at: the form returns to a long settings page and the switcher is at
  // the top of it.
  const readable = currentNodes() !== null;
  const shown = readable ? waitForNamed({ startsWith: INTENDED_NAME }, 20_000) !== null : null;
  const after = await serverProfiles();
  checks.push(
    profileCreatedCheck({
      before,
      after,
      intendedName: INTENDED_NAME,
      householdId: HOUSEHOLD_ID,
    }),
  );
  checks.push(profileVisibleCheck({ foundOnScreen: shown, intendedName: INTENDED_NAME }));

  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

void main();
