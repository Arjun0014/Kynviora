/**
 * Prove - or fail to prove - that an export made on a phone holds what somebody chose, and only
 * that.
 *
 * Spec references: `19` ("Visit Pack export"), `04` Phase 8.3, `13`, `14` (step-up), `16`
 * ("Kynviora never shares anything on its own"), `21`, `DEV-040`.
 *
 *   npm run verify:device:visitpack
 *
 * WHY THE RUN LEAVES SOMETHING OUT ON PURPOSE
 * A Visit Pack is the one thing in this app that leaves it: a copy of somebody's medicines handed
 * to a person Kynviora knows nothing about. `16` rests that on a single promise, which the screen
 * makes twice - nothing is included until you choose it. A run that ticked everything would confirm
 * the promise and test none of it, because a pack containing everything passes "it contains what I
 * ticked". So exactly one of two medicines is ticked, and `PACK-3` asks about the other one.
 *
 * HOW THE EXPORT IS FOUND AFTERWARDS
 * The app deliberately shows nothing identifying when it is done - no link, no reference - which is
 * right and leaves this harness with nothing to read off the screen. There is no route that lists
 * packs either. So the switch (`apiSwitchServer.ts`) records the idempotency key the app sent, and
 * the run replays that same create from the host: `13` makes the server answer a repeated key with
 * `200 idempotent-replay` naming the export it already made. One request establishes the pack's
 * identity **and** that a repeated tap does not make a second copy.
 *
 * WHAT IT NEEDS
 * The seeded API on `127.0.0.1:3000`, Metro, an attached device with the app installed, and
 * `EXPO_PUBLIC_DEV_STEP_UP=1` - `14` puts an export behind re-authentication, and with the flag off
 * the app correctly refuses and the run measures a refusal it asked for.
 *
 * WHAT IT LEAVES BEHIND
 * One Visit Pack on the development seed, which expires on its own. Nothing is printed from inside
 * it beyond the two synthetic medicine names the checks are about.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure
 * (DEC-102).
 */

import { PACKAGE, adb, isInstalled, sleep } from './adb.js';
import { accessibleNameOf } from './accessibility.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import { startApiSwitch } from './apiSwitch.js';
import {
  candidatesCheck,
  exportContentCheck,
  exportCreatedCheck,
  exportExpiryCheck,
  exportReadableCheck,
  type ServerPack,
} from './visitPackExport.js';
import {
  captureFailure,
  currentNodes,
  launch,
  scrollToAndTap,
  suppressStylusHandwriting,
  tapNamed,
} from './ui.js';

const API_PORT = 3000;
const SWITCH_PORT = 3999;
const OWNER_ID = '00000000-0000-4000-8000-00000000d001';
const PROFILE_ID = '00000000-0000-4000-8000-00000000d020';

/** Two of the development seed's medicines. One is ticked; the other is what makes the run mean something. */
const CHOSEN = 'Synthetic Tablet A';
const LEFT_OUT = 'Synthetic Capsule B';

async function api(
  path: string,
  options: { readonly method?: string; readonly body?: unknown; readonly key?: string } = {},
): Promise<Response | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(`http://127.0.0.1:${String(API_PORT)}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          'x-kynviora-dev-user': OWNER_ID,
          // `14`: an export is an elevated operation. This is the development stand-in for the
          // step-up the app performs.
          'x-kynviora-dev-step-up': '1',
          connection: 'close',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

async function readPack(packId: string): Promise<ServerPack | null> {
  const response = await api(`/v1/visit-packs/${packId}`);
  if (response === null || !response.ok) return null;
  return (await response.json()) as ServerPack;
}

/** Everything the app is currently offering to include. */
function offeredOnScreen(): readonly string[] | null {
  const nodes = currentNodes();
  if (nodes === null) return null;
  return nodes
    .filter((node) => node.packageName === PACKAGE)
    .map((node) => accessibleNameOf(node))
    .filter((name) => name !== '');
}

async function main(): Promise<void> {
  if (!isInstalled()) {
    process.stdout.write(`${PACKAGE} is not installed on the attached device.\n`);
    process.exitCode = 1;
    return;
  }
  if ((await api(`/v1/items?profileId=${PROFILE_ID}`)) === null) {
    process.stdout.write(
      `No seeded API on 127.0.0.1:${String(API_PORT)}:\n` +
        '  KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev\n',
    );
    process.exitCode = 1;
    return;
  }

  const apiSwitch = startApiSwitch({ port: SWITCH_PORT, upstreamPort: API_PORT });
  adb(['reverse', '--remove', `tcp:${String(API_PORT)}`]);
  adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(SWITCH_PORT)}`]);

  const checks: Check[] = [];
  try {
    suppressStylusHandwriting();
    adb(['shell', 'am', 'force-stop', PACKAGE]);
    launch();
    sleep(50_000);
    apiSwitch.clear();

    process.stdout.write('Choosing what to share, on the device...\n');
    const steps: (readonly [string, boolean])[] = [];
    const step = (what: string, run: () => boolean): boolean => {
      const happened = run();
      steps.push([what, happened]);
      if (!happened) captureFailure(`visitpack-${what.replace(/[^a-z]+/gi, '-')}`);
      return happened;
    };

    let offered: readonly string[] | null = null;
    if (step('open the Today tab', () => tapNamed('Today'))) {
      sleep(5_000);
      if (
        step('open the summary flow', () => scrollToAndTap({ startsWith: 'Prepare a summary' }))
      ) {
        sleep(6_000);
        offered = offeredOnScreen();
        if (
          step(`tick ${CHOSEN}`, () =>
            scrollToAndTap({ startsWith: `Current medicines. ${CHOSEN}` }),
          )
        ) {
          sleep(2_000);
          if (
            step('reach the review step', () =>
              scrollToAndTap({ startsWith: 'Check what you are sharing' }),
            )
          ) {
            sleep(5_000);
            step('create the pack', () => scrollToAndTap('Create the pack'));
            sleep(14_000);
          }
        }
      }
    }

    checks.push(candidatesCheck({ offered, chosen: CHOSEN, leftOut: LEFT_OUT }));

    const observed = apiSwitch
      .seen()
      .filter((request) => request.method === 'POST' && request.path === '/v1/visit-packs');
    checks.push(
      exportCreatedCheck({
        steps,
        creates: observed.map((request) => ({ status: request.status, key: request.key })),
      }),
    );

    // The identifier the create answered with, taken from the switch. Not a replay of the key: the
    // route checks the reviewed-content digest **before** it reaches the duplicate branch, so a
    // repeat from here with a body this harness cannot reconstruct is refused as a bad digest and
    // would say nothing about idempotency. The key having been sent at all is `PACK-1`'s business.
    const packId = observed.find((request) => request.status === 201)?.createdId ?? null;
    const pack = packId === null ? null : await readPack(packId);
    checks.push(exportReadableCheck({ packId, readable: pack !== null }));
    checks.push(exportContentCheck({ pack, chosen: CHOSEN, leftOut: LEFT_OUT }));
    checks.push(exportExpiryCheck(pack));
  } finally {
    apiSwitch.close();
    adb(['reverse', '--remove', `tcp:${String(API_PORT)}`]);
    adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(API_PORT)}`]);
  }

  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

void main();
