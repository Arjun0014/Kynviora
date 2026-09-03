/**
 * Prove - or fail to prove - that access given on a phone can be taken back on it, at once.
 *
 * Spec references: `19` ("Caregiver invite/revoke"), `04` Phase 8.1, `08.2` (capability scoping),
 * `12` (authorization loss invalidates local access), `14` (step-up for caregiver administration),
 * `16`, DEC-018, `DEV-040`, `DEV-046`.
 *
 *   npm run verify:device:caregiver
 *
 * WHAT IS DRIVEN ON THE DEVICE AND WHAT IS NOT, SAID PLAINLY
 * The **owner's** half is driven on the device: the Care tab, the capability the invitation
 * carries, the review step, the confirmation, and later the removal. That is the half the app
 * owns and the half nothing had ever exercised.
 *
 * The **caregiver's** half is driven through the API from the host, as the second seeded identity.
 * It is not a shortcut: `EXPO_PUBLIC_DEV_USER_ID` is inlined into the bundle at build time, so a
 * second identity on the same device means a second Metro and a second bundle - and the thing
 * being measured is not which screen a caregiver looks at, it is whether the server still answers
 * them. `12` puts authorization at the server precisely so that no client can be the thing that
 * decides, which is why measuring it at the server is the honest place.
 *
 * THE ONE-TIME LINK IS A CREDENTIAL AND IS TREATED AS ONE
 * The invitation token is read off the screen - which is what the person holding the phone does
 * with it - and then goes into a POST body and nowhere else. It is never printed, never logged and
 * never put in a URL (trap 11, DEC-018). The report says how long it was, not what it was.
 *
 * WHAT IT NEEDS
 * The seeded API on `127.0.0.1:3000`, a Metro bundler, an attached device with the app installed,
 * and `EXPO_PUBLIC_DEV_STEP_UP=1` in `apps/mobile/.env.local` - `14` requires re-authentication for
 * caregiver administration, and with the flag off the app correctly refuses to send and the run
 * measures a refusal it asked for.
 *
 * WHAT IT LEAVES BEHIND
 * Nothing that grants anybody anything: the grant it creates is the grant it revokes, and any
 * grant or invitation left over from an earlier run is revoked before the run starts, so that
 * `CAR-0` has something true to say. A revoked grant row remains, because that is the audit trail
 * `08.2` wants.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure
 * (DEC-102).
 */

import { PACKAGE, adb, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import {
  acceptanceCheck,
  accessLossCheck,
  accessPreconditionCheck,
  invitationCreatedCheck,
  revocationCheck,
} from './caregiverAccess.js';
import {
  captureFailure,
  currentNodes,
  launch,
  nodeNamed,
  scrollToAndTap,
  suppressStylusHandwriting,
  tapNamed,
} from './ui.js';

const API_PORT = 3000;
const OWNER_ID = '00000000-0000-4000-8000-00000000d001';
const CAREGIVER_ID = '00000000-0000-4000-8000-00000000d002';
const PROFILE_ID = '00000000-0000-4000-8000-00000000d020';

/**
 * The one capability this run shares.
 *
 * One, and the narrowest useful one, because `CAR-1` is about the invitation carrying **only** what
 * was ticked - `16` is explicit that being family is not a licence to see everything, and an
 * invitation that quietly widened would be invisible from the screen that made it.
 */
const CHOSEN_CAPABILITY = 'VIEW_MEDICINES';
const CHOSEN_CHECKBOX = 'Medicines';

interface Grant {
  readonly id: string;
  readonly profileId: string;
  readonly caregiverUserId?: string;
  readonly active?: boolean;
  readonly revokedAt?: string | null;
}

async function api(
  path: string,
  options: { readonly as: string; readonly method?: string; readonly body?: unknown },
): Promise<Response | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(`http://127.0.0.1:${String(API_PORT)}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          'x-kynviora-dev-user': options.as,
          // `14`: caregiver administration is an elevated operation. The header is the development
          // stand-in for the step-up the app performs (`devAuth.ts`).
          'x-kynviora-dev-step-up': '1',
          connection: 'close',
          ...(options.body === undefined
            ? {}
            : { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

/** How many of the profile's items an identity can see. `null` where the read failed. */
async function visibleItems(as: string): Promise<number | null> {
  const response = await api(`/v1/items?profileId=${PROFILE_ID}`, { as });
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as { readonly items?: readonly unknown[] };
  return body.items?.length ?? 0;
}

async function activeGrantsFor(caregiver: string): Promise<number | null> {
  const response = await api(`/v1/caregiver-grants?profileId=${PROFILE_ID}`, { as: OWNER_ID });
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as { readonly grants?: readonly Grant[] };
  return (body.grants ?? []).filter(
    (grant) => grant.caregiverUserId === caregiver && (grant.revokedAt ?? null) === null,
  ).length;
}

async function pendingInvitations(): Promise<
  readonly { readonly capabilities: readonly string[] }[] | null
> {
  const response = await api(`/v1/caregiver-invitations?profileId=${PROFILE_ID}`, { as: OWNER_ID });
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as {
    readonly invitations?: readonly {
      readonly capabilities: readonly string[];
      readonly status: string;
    }[];
  };
  return (body.invitations ?? []).filter((invitation) => invitation.status === 'PENDING');
}

/**
 * Take the household back to a state `CAR-0` can say something true about.
 *
 * Owner actions through the owner's own routes - nothing here reaches past authorization, it just
 * undoes what a previous run left. A crashed run leaves a live grant, and a live grant makes the
 * whole scenario measure nothing.
 */
async function clearPreviousRuns(): Promise<void> {
  const grants = await api(`/v1/caregiver-grants?profileId=${PROFILE_ID}`, { as: OWNER_ID });
  if (grants !== null && grants.ok) {
    const body = (await grants.json()) as { readonly grants?: readonly Grant[] };
    for (const grant of body.grants ?? []) {
      if (grant.caregiverUserId !== CAREGIVER_ID || (grant.revokedAt ?? null) !== null) continue;
      await api(`/v1/caregiver-grants/${grant.id}/revoke`, {
        as: OWNER_ID,
        method: 'POST',
        body: {},
      });
    }
  }
  for (const invitation of (await pendingInvitationRows()) ?? []) {
    await api(`/v1/caregiver-invitations/${invitation.id}/revoke`, {
      as: OWNER_ID,
      method: 'POST',
      body: {},
    });
  }
}

async function pendingInvitationRows(): Promise<readonly { readonly id: string }[] | null> {
  const response = await api(`/v1/caregiver-invitations?profileId=${PROFILE_ID}`, { as: OWNER_ID });
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as {
    readonly invitations?: readonly { readonly id: string; readonly status: string }[];
  };
  return (body.invitations ?? []).filter((invitation) => invitation.status === 'PENDING');
}

/** Read the one-time link off the screen. Never printed, never logged (trap 11). */
function invitationToken(): string | null {
  const nodes = currentNodes();
  if (nodes === null) return null;
  const node = nodeNamed(nodes, 'Invitation link');
  const token = node?.text.trim() ?? '';
  return token === '' ? null : token;
}

function coldStart(): void {
  adb(['shell', 'am', 'force-stop', PACKAGE]);
  launch();
  sleep(50_000);
}

async function main(): Promise<void> {
  if (!isInstalled()) {
    process.stdout.write(`${PACKAGE} is not installed on the attached device.\n`);
    process.exitCode = 1;
    return;
  }
  if ((await visibleItems(OWNER_ID)) === null) {
    process.stdout.write(
      `No seeded API on 127.0.0.1:${String(API_PORT)}:\n` +
        '  KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev\n',
    );
    process.exitCode = 1;
    return;
  }

  const checks: Check[] = [];
  await clearPreviousRuns();

  checks.push(
    accessPreconditionCheck({
      beforeInvite: await visibleItems(CAREGIVER_ID),
      grantsBefore: await activeGrantsFor(CAREGIVER_ID),
    }),
  );

  suppressStylusHandwriting();
  coldStart();

  // ---- The owner invites, on the device ------------------------------------
  process.stdout.write('Inviting, on the device...\n');
  const inviteSteps: (readonly [string, boolean])[] = [];
  const step = (what: string, run: () => boolean): boolean => {
    const happened = run();
    inviteSteps.push([what, happened]);
    if (!happened) captureFailure(`caregiver-${what.replace(/[^a-z]+/gi, '-')}`);
    return happened;
  };

  let token: string | null = null;
  if (step('open the Care tab', () => tapNamed('Care'))) {
    sleep(6_000);
    if (step('open the invitation form', () => scrollToAndTap('Invite someone'))) {
      sleep(4_000);
      if (step(`tick ${CHOSEN_CHECKBOX}`, () => scrollToAndTap(CHOSEN_CHECKBOX))) {
        sleep(2_000);
        if (
          step('reach the review step', () =>
            scrollToAndTap({ startsWith: 'Review what you are sharing' }),
          )
        ) {
          sleep(4_000);
          if (
            step('confirm and create the link', () =>
              scrollToAndTap({ startsWith: 'Confirm and create' }),
            )
          ) {
            sleep(12_000);
            token = invitationToken();
            inviteSteps.push(['read the one-time link off the screen', token !== null]);
          }
        }
      }
    }
  }

  checks.push(
    invitationCreatedCheck({
      steps: inviteSteps,
      pending: await pendingInvitations(),
      chosenCapability: CHOSEN_CAPABILITY,
    }),
  );
  process.stdout.write(
    `Read a one-time link of ${String(token?.length ?? 0)} characters (never printed).\n`,
  );

  // ---- The caregiver accepts, at the server --------------------------------
  const accept =
    token === null
      ? null
      : await api('/v1/caregiver-invitations/accept', {
          as: CAREGIVER_ID,
          method: 'POST',
          body: { token },
        });
  const afterAccept = accept === null ? null : await visibleItems(CAREGIVER_ID);
  checks.push(
    acceptanceCheck({
      acceptStatus: accept?.status ?? null,
      afterAccept,
      ownerSees: await visibleItems(OWNER_ID),
    }),
  );

  // ---- The owner removes it, on the device --------------------------------
  process.stdout.write('Removing access, on the device...\n');
  const removeSteps: (readonly [string, boolean])[] = [];
  const removeStep = (what: string, run: () => boolean): boolean => {
    const happened = run();
    removeSteps.push([what, happened]);
    if (!happened) captureFailure(`caregiver-${what.replace(/[^a-z]+/gi, '-')}`);
    return happened;
  };

  coldStart();
  if (removeStep('open the Care tab', () => tapNamed('Care'))) {
    sleep(8_000);
    if (
      removeStep('open the removal sheet', () => scrollToAndTap({ startsWith: 'Remove access' }))
    ) {
      sleep(5_000);
      removeStep('confirm the removal', () => scrollToAndTap('Remove access'));
      sleep(12_000);
    }
  }

  checks.push(
    revocationCheck({ steps: removeSteps, grantsAfter: await activeGrantsFor(CAREGIVER_ID) }),
  );

  // The very next request, on the session that was working a moment ago.
  checks.push(
    accessLossCheck({
      whileGranted: afterAccept,
      afterRevocation: await visibleItems(CAREGIVER_ID),
    }),
  );

  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

void main();
