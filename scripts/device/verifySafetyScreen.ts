/**
 * Measure, on a phone, what Kynviora says about a shelf it has nothing to say about.
 *
 * Spec references: `19` ("safety alert open/resolution"), `04` Phase 7.1, `09`, `18`, `23` D-014,
 * `02`, DEC-016, DEC-045, `BLK-006`, `DEV-040`.
 *
 *   npm run verify:device:safety
 *
 * WHY THIS RUN EXISTS AND WHAT IT DELIBERATELY DOES NOT DO
 * `19` asks for "safety alert open/resolution". Opening a published alert and recording what
 * somebody did about it cannot be driven here and should not be: publishing needs a qualified
 * clinical or regulatory reviewer (`BLK-006`), every shipped regulatory fixture is deliberately
 * refused by the Citation Gate (DEC-016), and manufacturing an approval to make a test go green is
 * the exact failure the governance chapter exists to prevent. So this run does not seed one.
 *
 * What it drives instead is the state every profile in this build is in, and that most items in
 * any build will be in: Kynviora has nothing to say, and has to say so without that reading as an
 * all-clear. `23` D-014 - an absence of a matched rule must never render as approval - is a safety
 * requirement in its own right, and it is the one a person is actually exposed to today.
 *
 * WHAT IS ACTUALLY DONE TO THE DEVICE
 * The Safety tab is opened and read, top to bottom. Then one filter is turned on - a state nothing
 * on this shelf is in - and it is read again. Nothing is created, nothing is written, and the run
 * leaves the app on a filtered screen and nothing else behind.
 *
 * WHY THE SECOND READING IS WORTH A CHECK OF ITS OWN
 * A filtered screen with no rows is the easiest place in this app to conclude that the shelf has
 * been cleared: a person asked to see what needs action and got a page with nothing on it. `09`'s
 * coverage statement does not lapse because a filter is on, and the screen has to say it is
 * showing none of three rather than looking like a shelf with nothing on it.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { PACKAGE, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import {
  coverageStatedCheck,
  everyItemHasALineCheck,
  filteredEmptyCheck,
  inboxPreconditionCheck,
  noOrphanExplanationCheck,
  nothingCountedCheck,
  stateIsStatedCheck,
  type InboxResponse,
} from './safetyInbox.js';
import {
  captureFailure,
  coldStart,
  collectScreenText,
  prepareDeviceForDriving,
  scrollToAndTap,
  tapNamed,
} from './ui.js';

const API_PORT = 3000;
const USER_ID = '00000000-0000-4000-8000-00000000d001';
const PROFILE_ID = '00000000-0000-4000-8000-00000000d020';

/**
 * The filter this run turns on.
 *
 * "Action needed" on purpose: it is the state a worried person would reach for, and the one
 * nothing on this shelf can be in while nothing is publishable. Asking for it is therefore the
 * shortest route to an empty page that still has to say the right things.
 */
const EMPTYING_FILTER = 'Action needed';

async function apiFetch(path: string): Promise<Response | null> {
  // `sleep` blocks the event loop for most of a run, so a pooled connection is dead by the time
  // the next call uses it (trap 188).
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

/** `null` where the inbox could not be read, which is not the same as "there is nothing in it". */
async function safetyInbox(): Promise<InboxResponse | null> {
  const response = await apiFetch(`/v1/profiles/${encodeURIComponent(PROFILE_ID)}/safety-inbox`);
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as Partial<InboxResponse>;
  if (body.lines === undefined || body.totalItems === undefined) return null;
  return { lines: body.lines, totalItems: body.totalItems };
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

  const inbox = await safetyInbox();
  if (inbox === null) {
    process.stdout.write(
      `No seeded API on 127.0.0.1:${String(API_PORT)}. This scenario reads the screen against\n` +
        'what the server says, so there has to be one:\n' +
        '  KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev\n',
    );
    process.exitCode = 1;
    return;
  }

  const checks: Check[] = [inboxPreconditionCheck({ inbox })];

  prepareDeviceForDriving();
  const ready = coldStart('safety');

  let screenText: readonly string[] | null = null;
  if (ready && tapNamed('Safety')) {
    // The lines fill from the API, and a screen read while the request is in flight has no lines
    // on it at all - which every check below would report as an omission.
    sleep(10_000);
    screenText = collectScreenText();
  } else {
    captureFailure('safety-open-the-Safety-tab');
  }

  checks.push(everyItemHasALineCheck({ inbox, screenText }));
  checks.push(stateIsStatedCheck({ inbox, screenText }));
  checks.push(coverageStatedCheck({ inbox, screenText }));
  checks.push(noOrphanExplanationCheck({ inbox, screenText }));
  checks.push(nothingCountedCheck({ inbox, screenText }));

  let filteredText: readonly string[] | null = null;
  if (screenText !== null && scrollToAndTap(EMPTYING_FILTER)) {
    sleep(8_000);
    filteredText = collectScreenText();
  } else if (screenText !== null) {
    captureFailure('safety-turn-on-the-filter');
  }

  checks.push(
    filteredEmptyCheck({
      screenText: filteredText,
      totalItems: inbox.totalItems,
      excludedNames: inbox.lines.map((line) => line.displayName),
    }),
  );

  process.stdout.write(`${formatReport(checks)}\n`);
  process.stdout.write(
    'Not covered by this run, and not coverable in this build: opening a published alert and\n' +
      'recording what somebody did about it. Publishing needs a reviewer nobody has staffed\n' +
      '(`BLK-006`) and every shipped regulatory fixture is refused by the Citation Gate\n' +
      '(DEC-016). Seeding an approval to exercise the screen would be the failure the\n' +
      'governance chapter exists to prevent, so it is named rather than worked around.\n',
  );
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

void main();
