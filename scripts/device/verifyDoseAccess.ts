/**
 * Prove - or fail to prove - that writing into somebody's dose history is its own permission.
 *
 * Spec references: `19` ("Caregiver invite/revoke", "Record what happened"), `07`, `08.2`,
 * `11` and `12` (access control is server-authoritative), `18`, `04` Phase 4.3, `DEV-049`,
 * `BLK-011`, DEC-116, migration `0021`.
 *
 *   npm run verify:device:doseaccess
 *
 * WHY THIS SCENARIO EXISTS
 * `RECORD_DOSES` was added because two shipped decisions contradicted each other: `0004` scoped a
 * dose write by whether the caller could *reach* the medicine, and the invitation screen described
 * the grant that gave them that reach as allowing no changes at all. Somebody the owner had
 * granted "Medicines" could write entries into the record that person hands a doctor.
 *
 * Splitting the capability fixes the policy. It does not, on its own, fix the product: an owner
 * still has to be *offered* the narrower choice, in words that say it is a change rather than a
 * view, or the only way to let a caregiver record a dose is to grant them the permission that can
 * also delete the prescription. That half lives on a screen and is invisible from the API suite.
 *
 * WHAT IS DRIVEN ON THE DEVICE AND WHAT IS NOT
 * The **owner's** half is driven on the device, because that is where the consent happens: the
 * checkbox on the invitation form, the grouping on the review screen, and the dose control on the
 * shelf row. The **caregiver's** half is measured through the API from the host as the second
 * seeded identity - the same division `verify:device:caregiver` makes, and for the same reason.
 * `11` puts the decision on the server so that no client can be the thing that decides, which
 * makes the server the honest place to ask whether it holds.
 *
 * THE ORDER IS THE MEASUREMENT
 * One caregiver, one profile, and a unique index that refuses two live grants for the pair (trap
 * 10) - so the two states have to be reached in sequence. The caregiver is granted "Medicines"
 * alone, refused, then granted "Record doses" as well and admitted, with the same request and no
 * sign-out between them. A run that measured two different identities would be comparing two
 * people rather than one permission.
 *
 * WHAT IT NEEDS
 * The seeded API on `127.0.0.1:3000` (`KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev`), a
 * Metro bundler, an attached device with the app installed, and `EXPO_PUBLIC_DEV_STEP_UP=1` in
 * `apps/mobile/.env.local` - `14` requires re-authentication for caregiver administration, and
 * with the flag off the app correctly refuses to send and the run measures a refusal it asked for.
 *
 * WHAT IT LEAVES BEHIND
 * Dose events, which are append-only by design (`04` Phase 4.3) and are the record the scenario
 * is about - three of them on a synthetic medicine. No grant: the ones it creates are revoked at
 * the end, and any left over from an earlier run are revoked before it starts, so `DOSE-0` has
 * something true to say.
 *
 * The exit code is the result: 0 only when every check passed. An inconclusive run is a failure,
 * because "could not look" must never be recorded as "looked and it was fine" (DEC-102).
 */

import { randomUUID } from 'node:crypto';
import { PACKAGE, adb, isInstalled, sleep } from './adb.js';
import { formatReport, overallStatus, type Check } from './analysis.js';
import {
  capabilityOfferedCheck,
  doseControlCheck,
  grantContentsCheck,
  ownerRecordsCheck,
  recorderAdmittedCheck,
  reviewGroupingCheck,
  viewOnlyRefusedCheck,
} from './doseAccess.js';
import {
  captureFailure,
  coldStart,
  collectScreenText,
  currentNodes,
  nodeNamed,
  prepareDeviceForDriving,
  scrollToAndTap,
  scrollToAndTapBelow,
  suppressStylusHandwriting,
  tapNamed,
} from './ui.js';

const API_PORT = 3000;
/** Metro's port. The app cannot start without it, and `adb kill-server` takes the tunnel away. */
const METRO_PORT = 8081;
const OWNER_ID = '00000000-0000-4000-8000-00000000d001';
const CAREGIVER_ID = '00000000-0000-4000-8000-00000000d002';
const PROFILE_ID = '00000000-0000-4000-8000-00000000d020';
const MEDICINE_ID = '00000000-0000-4000-8000-00000000d030';

/**
 * The medicine the owner records against on the device.
 *
 * The seed's first one, and named here so the row can be found by its heading: a shelf draws one
 * identically-labelled control per row, so a plain lookup would press whichever row came first in
 * the hierarchy and the run would measure the wrong medicine while reporting the right name
 * (trap 192).
 */
const MEDICINE_NAME = 'Synthetic Tablet A';

/** What the second invitation ticks, and what the review screen therefore has to describe. */
const TICKED_LABELS = ['Medicines', 'Record doses'] as const;
const TICKED_CAPABILITIES = ['VIEW_MEDICINES', 'RECORD_DOSES'] as const;

/**
 * A grant as `GET /v1/caregiver-grants` sends it.
 *
 * `granteeUserId` is the field's real name, and both it and `revokedAt` are **required** here on
 * purpose. Declaring either optional is what let `verifyCaregiverAccess.ts` read a field the route
 * has never sent (`DEV-050`): the comparison then evaluated `undefined !== CAREGIVER_ID` for every
 * row, so the grant count was always zero, the precondition guarding against a grant left over
 * from a previous run could never fire, and the cleanup revoked nothing. A required field makes a
 * rename a compile error rather than a check that quietly stops looking.
 */
interface Grant {
  readonly id: string;
  readonly profileId: string;
  readonly granteeUserId: string;
  readonly revokedAt: string | null;
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
          'x-kynviora-dev-step-up': '1',
          // The harnesses block the event loop for tens of seconds at a time and Fastify closes an
          // idle keep-alive connection well before that, so a reused socket fails with ECONNRESET
          // for a reason that has nothing to do with the app (trap 188).
          connection: 'close',
          ...(options.body === undefined
            ? {}
            : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

/** Record a dose as `who`. Returns the status, or `null` where the request could not be made. */
async function recordDose(who: string, note: string): Promise<number | null> {
  const response = await api('/v1/dose-events', {
    as: who,
    method: 'POST',
    body: { ownedItemId: MEDICINE_ID, eventKind: 'TAKEN', note },
  });
  return response?.status ?? null;
}

/** How many events the medicine's history holds, as `who` sees it. */
async function historyCount(who: string): Promise<number | null> {
  const response = await api(`/v1/dose-events?ownedItemId=${MEDICINE_ID}`, { as: who });
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as { readonly events?: readonly unknown[] };
  return body.events?.length ?? 0;
}

/** The status that read answered with, so a refusal is distinguishable from an empty history. */
async function historyStatus(who: string): Promise<number | null> {
  const response = await api(`/v1/dose-events?ownedItemId=${MEDICINE_ID}`, { as: who });
  return response?.status ?? null;
}

async function activeGrantsFor(caregiver: string): Promise<number | null> {
  const response = await api(`/v1/caregiver-grants?profileId=${PROFILE_ID}`, { as: OWNER_ID });
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as { readonly grants?: readonly Grant[] };
  return (body.grants ?? []).filter(
    (grant) => grant.granteeUserId === caregiver && grant.revokedAt === null,
  ).length;
}

async function pendingInvitations(): Promise<
  readonly { readonly id: string; readonly capabilities: readonly string[] }[] | null
> {
  const response = await api(`/v1/caregiver-invitations?profileId=${PROFILE_ID}`, { as: OWNER_ID });
  if (response === null || !response.ok) return null;
  const body = (await response.json()) as {
    readonly invitations?: readonly {
      readonly id: string;
      readonly status: string;
      readonly capabilities: readonly string[];
    }[];
  };
  return (body.invitations ?? []).filter((invitation) => invitation.status === 'PENDING');
}

/**
 * Take the household back to a state `DOSE-0` can say something true about.
 *
 * A crashed run leaves a live grant, and a live grant makes the first refusal meaningless: it
 * would be measuring whatever the previous run happened to grant.
 */
async function clearPreviousRuns(): Promise<void> {
  const grants = await api(`/v1/caregiver-grants?profileId=${PROFILE_ID}`, { as: OWNER_ID });
  if (grants !== null && grants.ok) {
    const body = (await grants.json()) as { readonly grants?: readonly Grant[] };
    for (const grant of body.grants ?? []) {
      if (grant.granteeUserId !== CAREGIVER_ID || grant.revokedAt !== null) continue;
      await api(`/v1/caregiver-grants/${grant.id}/revoke`, {
        as: OWNER_ID,
        method: 'POST',
        body: {},
      });
    }
  }
  for (const invitation of (await pendingInvitations()) ?? []) {
    await api(`/v1/caregiver-invitations/${invitation.id}/revoke`, {
      as: OWNER_ID,
      method: 'POST',
      body: {},
    });
  }
}

/**
 * Grant a set of capabilities to the caregiver, through the real routes.
 *
 * Used for the first, view-only grant. The screen half is measured on the *second* one, which is
 * driven on the device - doing both there would double a twelve-minute run to measure the same
 * form twice.
 */
async function grantThroughApi(capabilities: readonly string[]): Promise<boolean> {
  const created = await api('/v1/caregiver-invitations', {
    as: OWNER_ID,
    method: 'POST',
    body: { profileId: PROFILE_ID, capabilities },
  });
  if (created === null || !created.ok) return false;
  const body = (await created.json()) as { readonly token?: string | null };
  const token = body.token ?? null;
  if (token === null) return false;

  const accepted = await api('/v1/caregiver-invitations/accept', {
    as: CAREGIVER_ID,
    method: 'POST',
    body: { token },
  });
  return accepted !== null && accepted.ok;
}

/**
 * Point the phone at the host, rather than assuming somebody already did.
 *
 * Both tunnels, and asserted rather than fired and forgotten. Without `tcp:3000` the app reaches
 * no API and every screen it draws says "No connection" - which reads, from a check looking for a
 * control, as an app that no longer offers it. That is not hypothetical: it is how this harness
 * first reported `DOSE-6` as the dose control having gone missing from the owner's own shelf row,
 * over a device that had simply lost its tunnel to `adb kill-server`.
 *
 * `adb reverse` is also idempotent and cheap, so re-establishing one that already exists costs
 * nothing and removes a precondition somebody has to remember.
 */
function pointPhoneAtHost(): boolean {
  const api = adb(['reverse', `tcp:${String(API_PORT)}`, `tcp:${String(API_PORT)}`]).ok;
  const metro = adb(['reverse', `tcp:${String(METRO_PORT)}`, `tcp:${String(METRO_PORT)}`]).ok;
  return api && metro;
}

/** Read the one-time link off the screen. Never printed, never logged (trap 11, DEC-018). */
function invitationToken(): string | null {
  const nodes = currentNodes();
  if (nodes === null) return null;
  const token = nodeNamed(nodes, 'Invitation link')?.text.trim() ?? '';
  return token === '' ? null : token;
}

async function main(): Promise<void> {
  if (!isInstalled()) {
    process.stdout.write(`${PACKAGE} is not installed on the attached device.\n`);
    process.exitCode = 1;
    return;
  }
  if ((await historyStatus(OWNER_ID)) === null) {
    process.stdout.write(
      `No seeded API on 127.0.0.1:${String(API_PORT)}:\n` +
        '  KYNVIORA_DEV_AUTH=1 KYNVIORA_DEV_SEED=1 npm run dev\n',
    );
    process.exitCode = 1;
    return;
  }
  if (!pointPhoneAtHost()) {
    process.stdout.write(
      `Could not establish \`adb reverse\` for tcp:${String(API_PORT)} and ` +
        `tcp:${String(METRO_PORT)}. The app would draw "No connection" on every screen, and a ` +
        'check looking for a control would read that as the control having been withheld.\n',
    );
    process.exitCode = 1;
    return;
  }

  const checks: Check[] = [];
  await clearPreviousRuns();

  // ---- DOSE-0, the control -------------------------------------------------
  checks.push(
    doseControlCheck({
      ownerWrite: await recordDose(OWNER_ID, 'synthetic - owner control'),
      grantsBefore: await activeGrantsFor(CAREGIVER_ID),
    }),
  );

  // ---- DOSE-4, granted "Medicines" and nothing else -------------------------
  process.stdout.write('Granting the caregiver "Medicines" alone...\n');
  const viewOnlyGranted = await grantThroughApi(['VIEW_MEDICINES']);
  const refusedWrite = viewOnlyGranted
    ? await recordDose(CAREGIVER_ID, 'synthetic - written by a view-only caregiver')
    : null;
  checks.push(
    viewOnlyRefusedCheck({
      historyRead: viewOnlyGranted ? await historyStatus(CAREGIVER_ID) : null,
      historyCount: viewOnlyGranted ? await historyCount(CAREGIVER_ID) : null,
      write: refusedWrite,
    }),
  );

  // The second grant needs the first gone: one live grant per pair (trap 10).
  await clearPreviousRuns();

  // ---- The owner grants it, on the device -----------------------------------
  process.stdout.write('Granting "Record doses", on the device...\n');
  prepareDeviceForDriving();
  suppressStylusHandwriting();

  const driven = coldStart('doseaccess-invite');
  let reachedForm = false;
  let offeredLabels: readonly string[] | null = null;
  let reachedReview = false;
  let reviewLines: readonly string[] | null = null;
  let token: string | null = null;

  if (driven && tapNamed('Care')) {
    sleep(6_000);
    if (scrollToAndTap('Invite someone')) {
      sleep(4_000);
      reachedForm = true;
      // Every label the form drew, before anything is ticked. `DOSE-1` is about what an owner is
      // offered, which is a fact about the empty form.
      offeredLabels = collectScreenText();

      let ticked = 0;
      for (const label of TICKED_LABELS) {
        if (scrollToAndTap(label)) {
          ticked += 1;
          sleep(1_500);
        } else {
          captureFailure(`doseaccess-tick-${label.replace(/[^a-z]+/gi, '-')}`);
        }
      }

      if (ticked === TICKED_LABELS.length) {
        if (scrollToAndTap({ startsWith: 'Review what you are sharing' })) {
          sleep(4_000);
          reachedReview = true;
          reviewLines = collectScreenText();
          if (scrollToAndTap({ startsWith: 'Confirm and create' })) {
            sleep(12_000);
            token = invitationToken();
          } else {
            captureFailure('doseaccess-confirm');
          }
        } else {
          captureFailure('doseaccess-review');
        }
      }
    } else {
      captureFailure('doseaccess-invite-form');
    }
  }

  checks.push(capabilityOfferedCheck({ reachedForm, offeredLabels }));
  checks.push(reviewGroupingCheck({ reachedReview, lines: reviewLines }));

  const pending = await pendingInvitations();
  checks.push(
    grantContentsCheck({
      capabilities: pending === null ? null : (pending[0]?.capabilities ?? []),
      ticked: [...TICKED_CAPABILITIES],
    }),
  );
  process.stdout.write(
    `Read a one-time link of ${String(token?.length ?? 0)} characters (never printed).\n`,
  );

  // ---- DOSE-5, the same request with the capability granted -----------------
  const accepted =
    token === null
      ? null
      : await api('/v1/caregiver-invitations/accept', {
          as: CAREGIVER_ID,
          method: 'POST',
          body: { token },
        });
  const admittedWrite =
    accepted !== null && accepted.ok
      ? await recordDose(CAREGIVER_ID, 'synthetic - written by a caregiver granted it')
      : null;
  checks.push(
    recorderAdmittedCheck({
      before: refusedWrite,
      after: admittedWrite,
      granted: accepted !== null && accepted.ok,
    }),
  );

  // ---- DOSE-6, the owner's own control, on the device ------------------------
  process.stdout.write('Recording a dose as the owner, on the device...\n');
  const before = await historyCount(OWNER_ID);
  let controlPresent = false;
  const drivenShelf = coldStart('doseaccess-shelf');

  if (drivenShelf && tapNamed('Shelf')) {
    sleep(8_000);
    // The control first, the row heading second: `scrollToAndTapBelow` takes what to press and
    // then what identifies the row it belongs to. Every shelf row carries an identically-named
    // control, so a plain lookup presses whichever comes first in the hierarchy and the run
    // measures the wrong medicine while reporting the right name (trap 192).
    controlPresent = scrollToAndTapBelow('Record what happened', MEDICINE_NAME);
    if (controlPresent) {
      sleep(6_000);
      if (!scrollToAndTap('I took it')) {
        captureFailure('doseaccess-took-it');
        controlPresent = false;
      }
      sleep(10_000);
    } else {
      captureFailure('doseaccess-record-control');
    }
  }

  checks.push(
    ownerRecordsCheck({
      driven: drivenShelf,
      controlPresent,
      before,
      after: drivenShelf ? await historyCount(OWNER_ID) : null,
    }),
  );

  // Leave no grant behind. The dose events stay: they are append-only by design and they are the
  // record this scenario is about.
  await clearPreviousRuns();
  adb(['shell', 'am', 'force-stop', PACKAGE]);

  process.stdout.write(`${formatReport(checks)}\n`);
  process.exitCode = overallStatus(checks) === 'PASS' ? 0 : 1;
}

void main();
