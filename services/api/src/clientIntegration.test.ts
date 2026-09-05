import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, type StartedServer } from './main.js';
import { SEED } from '@kynviora/db';
import {
  bandMatchesBirthYear,
  consentEnforcement,
  isConsentPurpose,
  noopLogger,
  quietHoursFromClock,
  CONSENT_POLICY_VERSION,
  CONSENT_PURPOSES,
} from '@kynviora/domain';
import {
  ALREADY_ACCEPTED_CODE,
  ANONYMOUS,
  createClient,
  developmentSession,
  resourceFor,
  buildCompletion,
  buildInvitation,
  buildResolution,
  buildUrl,
  buildVisitPack,
  medicationLine,
  consentView,
  contentChanged,
  accessHistory,
  accessList,
  buildDoseRecord,
  buildRevocation,
  doseHistory,
  heldCapabilities,
  inviterAuthority,
  itemDetailScreenView,
  lensView,
  manualEntryDraft,
  notificationPolicyView,
  healthContextView,
  emptyProfileForm,
  profileBodyFrom,
  profileFormRefusal,
  profileSwitcherView,
  mayInvite,
  refreshedResource,
  revocationMessage,
  screenStateForFailure,
  MAX_DOSE_NOTE_LENGTH,
  reviewInboxView,
  safetyInboxView,
  safetyView,
  SAFETY_EMPTY_COVERAGE,
  selectableCapabilities,
  shelfView,
  type DigestFn,
  type KynvioraClient,
} from '@kynviora/contracts';
import { CONSENT_COPY, REVOCATION_COPY, SCREEN_STATE_PRESENTATION } from '@kynviora/presentation';

/**
 * The client the app ships, driven against the server the app talks to.
 *
 * Every other suite tests one side of this. `main.test.ts` proves the process serves the right
 * bytes; the contracts suites prove the client turns bytes into states. Neither proves that the
 * two agree - and "the screen says nothing is here" versus "the screen says you are not allowed"
 * is decided by their agreement, not by either one alone.
 *
 * So these tests use exactly the code path the Expo screens use: the same `createClient`, the
 * same view models, the same `resourceFor`. What is asserted is what a person would see.
 */

const STRANGER = '00000000-0000-4000-8000-0000000009ff';

/** Only used where the builder is expected to refuse before the value could matter. */
const NOW_UNUSED = '2026-09-01T00:00:00.000Z';

/** The transport guard, exercised against this server's own origin. */
const buildUrlForTest = (path: string, query: Record<string, string>): string =>
  buildUrl(server.url, path, query);

let server: StartedServer;
let dataDir: string;

/** The client as the seeded owner: the identity the app is configured with in development. */
let owner: KynvioraClient;
/** A real account with no relationship to the seeded profile. */
let stranger: KynvioraClient;
/** No session at all. */
let anonymous: KynvioraClient;

/**
 * How long booting the process for this suite is allowed.
 *
 * The global `hookTimeout` is 60s and this crossed it: one run of `npm run verify` failed here with
 * "Hook timed out in 60000ms" and the same suite passed in 17s on its own with nothing changed.
 * That is trap 159 a second time, in a second file - a PGlite instance plus every migration plus
 * the seed takes most of a minute alone, and under the full suite several files hold their own
 * engine at once.
 *
 * The number is chosen against the machine this actually runs on, which has an Android emulator
 * attached for the device harnesses. That is not an unusual condition to be generous about: it is
 * the condition `npm run verify` runs in whenever somebody is also working on the device tests, and
 * a suite that only passes on an idle machine is a suite that fails for reasons unrelated to the
 * code. The migration count only grows.
 */
const PROCESS_BOOT_TIMEOUT_MS = 180_000;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'kynviora-client-'));
  server = await start(
    {
      port: 0,
      staffPort: null,
      host: '127.0.0.1',
      dataDir,
      // Never the managed database. A test that reached a real project would write synthetic
      // households into it and read another test run's rows back.
      databaseUrl: null,
      devAuth: true,
      seed: true,
      allowAnonymousStart: false,
      supabase: null,
      retention: { mode: 'none', acknowledgedUnswept: false },
      production: false,
    },
    { logger: noopLogger() },
  );

  const config = { baseUrl: server.url, timeoutMs: 10_000 };
  owner = createClient({ config, session: developmentSession(SEED.userId) });
  stranger = createClient({ config, session: developmentSession(STRANGER) });
  anonymous = createClient({ config, session: ANONYMOUS });
}, PROCESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the shelf, end to end', () => {
  it('shows the owner their own products, with three separate verification statements', async () => {
    const outcome = await owner.listItems({ profileId: SEED.profileId });
    expect(outcome.kind).toBe('OK');

    const resource = resourceFor(outcome, { isEmpty: (value) => value.items.length === 0 });
    expect(resource.state).toBe('READY');
    expect(resource.value).not.toBeNull();

    const view = shelfView(resource.value!.items, resource.value!.nextCursor);
    expect(view.items).toHaveLength(3);
    expect(view.medicineCount).toBe(2);
    expect(view.personalCareCount).toBe(1);

    // `18`: identity, formula and batch certainty are three statements, never one badge.
    const first = view.items[0]!;
    expect(new Set([first.identity.label, first.formulation.label, first.batch.label]).size).toBe(
      3,
    );
  });

  it('shows a stranger an empty shelf, not a refusal', async () => {
    // Phase 8.1's exit criterion, all the way through to what is rendered: "an empty page - not
    // a 403". Row-level security produces the empty list, the client turns it into EMPTY, and
    // the screen shows the same words it would for a shelf with nothing on it.
    const outcome = await stranger.listItems({ profileId: SEED.profileId });
    expect(outcome.kind).toBe('OK');

    const resource = resourceFor(outcome, { isEmpty: (value) => value.items.length === 0 });
    expect(resource.state).toBe('EMPTY');
    expect(resource.value).toBeNull();
    expect(resource.message).toBeNull();
  });

  it('is not an existence oracle anywhere along the path', async () => {
    // A profile that exists but is not the caller's, and a profile that does not exist at all,
    // must be indistinguishable to whoever is holding the phone. The status code decision
    // (`errors.ts`, trap 14) is only worth something if the client and the screen honour it.
    const real = resourceFor(await stranger.listItems({ profileId: SEED.profileId }), {
      isEmpty: (value) => value.items.length === 0,
    });
    const invented = resourceFor(
      await stranger.listItems({ profileId: '00000000-0000-4000-8000-0000000000ff' }),
      { isEmpty: (value) => value.items.length === 0 },
    );

    expect(real.state).toBe(invented.state);
    expect(real.message).toBe(invented.message);
    expect(SCREEN_STATE_PRESENTATION[real.state]).toEqual(
      SCREEN_STATE_PRESENTATION[invented.state],
    );
  });
});

describe('the session boundary, end to end', () => {
  it('shows an unauthenticated caller the signed-out state', async () => {
    const resource = resourceFor(await anonymous.listProfiles());
    expect(resource.state).toBe('UNAUTHENTICATED');
    expect(SCREEN_STATE_PRESENTATION.UNAUTHENTICATED.showsContent).toBe(false);
    expect(resource.value).toBeNull();
  });

  it('gives the owner their profile and the stranger nothing', async () => {
    const ownerProfiles = resourceFor(await owner.listProfiles(), {
      isEmpty: (value) => value.profiles.length === 0,
    });
    expect(ownerProfiles.state).toBe('READY');
    expect(ownerProfiles.value?.profiles).toHaveLength(1);

    const strangerProfiles = resourceFor(await stranger.listProfiles(), {
      isEmpty: (value) => value.profiles.length === 0,
    });
    expect(strangerProfiles.state).toBe('EMPTY');
  });

  it('never lets a header grant a staff role', async () => {
    // DEC-038: a header is a client claim and `14` says reviewer roles are not inferred from one.
    // The client has no reviewer method at all, so this asserts the property at the layer that
    // could still reach it - the transport.
    expect(Object.keys(owner)).not.toContain('reviewerQueue');

    const response = await fetch(`${server.url}/v1/reviewer/queue`, {
      headers: { 'x-kynviora-dev-user': SEED.userId },
    });
    expect(response.status).toBe(404);
  });
});

describe('safety, end to end', () => {
  it('shows no alerts and says what that does not mean', async () => {
    // Nothing is publishable: `BLK-006` needs a qualified reviewer and DEC-016 keeps every
    // shipped regulatory fixture rejected by the Citation Gate. So the screen is empty against
    // any profile, and the sentence explaining that emptiness is on screen either way.
    const outcome = await owner.listAlerts();
    expect(outcome.kind).toBe('OK');

    const resource = resourceFor(outcome, { isEmpty: (value) => value.alerts.length === 0 });
    expect(resource.state).toBe('EMPTY');

    const view = safetyView([]);
    expect(view.alerts).toEqual([]);
    expect(view.coverageStatement).toMatch(/not the same as/i);
  });
});

describe('the review inbox, end to end', () => {
  it('reaches the owner and carries no urgency of any kind', async () => {
    const outcome = await owner.reviewTasks(SEED.profileId);
    expect(outcome.kind).toBe('OK');

    if (outcome.kind !== 'OK') return;

    // Phase 8.3's exit criterion as a property of the payload, checked on the wire rather than
    // only in a unit test of the presenter: no urgency, no evidence level, no severity, no
    // count of "critical" anything.
    for (const task of outcome.value.tasks) {
      for (const key of Object.keys(task)) {
        expect(key.toLowerCase()).not.toMatch(/urgen|severity|evidence|priority|score|critical/);
      }
    }

    const view = reviewInboxView(outcome.value.tasks);
    expect(view.unrecognisedCount).toBe(0);
  });

  it('shows a stranger nothing', async () => {
    const outcome = await stranger.reviewTasks(SEED.profileId);
    // Either an empty list under RLS or an unavailable resource - both render as absence, and
    // neither confirms the profile exists.
    if (outcome.kind === 'OK') {
      expect(outcome.value.tasks).toEqual([]);
    } else {
      expect(outcome.kind).toBe('UNAVAILABLE');
    }
  });
});

describe('notification settings, end to end', () => {
  it('defaults both dials to the quietest level', async () => {
    // DEC-025: a missing row is never permission. Nothing in the seed writes a preference, so
    // this is the absence case rather than a stored value.
    const outcome = await owner.notificationSettings(SEED.profileId);
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;

    expect(outcome.value.maxCaregiverDetail).toBe('GENERIC');
    expect(outcome.value.myPreference).toBeNull();
    expect(outcome.value.effectiveDetail).toBe('GENERIC');
  });

  it('records a choice the owner makes and reads it back', async () => {
    // The write goes through row-level security, so this also proves the settings screen cannot
    // leave a preference row behind for a profile the caller has no relationship with.
    const written = await owner.setNotificationPreference(SEED.profileId, 'NAMED');
    expect(written.kind).toBe('OK');

    const after = await owner.notificationSettings(SEED.profileId);
    expect(after.kind).toBe('OK');
    if (after.kind !== 'OK') return;
    expect(after.value.myPreference).toBe('NAMED');
  });

  it('refuses a stranger without confirming the profile exists', async () => {
    const outcome = await stranger.setNotificationPreference(SEED.profileId, 'NAMED');
    // Whatever the reason, the client must not learn that this profile is real.
    expect(outcome.kind).not.toBe('OK');
    if (outcome.kind === 'UNAVAILABLE') {
      expect(Object.keys(outcome)).toEqual(['kind']);
    }
  });
});

describe('what the transport refuses to do against a real server', () => {
  it('will not put a credential in a URL', () => {
    // `13` and trap 11. The refusal happens before the request leaves, so there is no version of
    // this that reaches a server log.
    const client = createClient({
      config: { baseUrl: server.url, timeoutMs: 1000 },
      session: developmentSession(SEED.userId),
    });
    // `listCaregiverGrants` takes a profile ID; there is deliberately no client method that
    // accepts a token as a query parameter, so the guard is asserted at its own level.
    expect(typeof client.listCaregiverGrants).toBe('function');

    expect(() => buildUrl(server.url, '/v1/x', { inviteToken: 'abc' })).toThrow();
  });

  it('turns an unreachable server into the offline state rather than an exception', async () => {
    // A port nothing is listening on. The screen must reach OFFLINE, not crash and not hang.
    const dead = createClient({
      config: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 },
      session: developmentSession(SEED.userId),
    });
    const resource = resourceFor(await dead.listProfiles());
    expect(resource.state).toBe('OFFLINE');
    // And it does not claim to be showing something saved, because there is nothing saved.
    expect(SCREEN_STATE_PRESENTATION.OFFLINE.showsContent).toBe(false);
  });
});

describe('completing a review task writes to the record, end to end', () => {
  /**
   * Phase 8.3's exit criterion, exercised through the code the app actually runs.
   *
   * The interesting part is not that the request succeeds - `reviewInbox.test.ts` proves that.
   * It is that the form the screen renders produces a payload the server accepts, and that the
   * record it names actually changes. A form built from the wrong field list, or naming the
   * wrong record, would fail here and nowhere else.
   */
  it('turns a filled-in form into a change the server applies', async () => {
    const tasks = await owner.reviewTasks(SEED.profileId);
    expect(tasks.kind).toBe('OK');
    if (tasks.kind !== 'OK') return;

    const view = reviewInboxView(tasks.value.tasks);
    // The seed's items have never been reviewed, so the derivation produces these.
    const task = view.tasks.find((entry) => entry.kind === 'ITEM_NOT_REVIEWED_RECENTLY');
    expect(task).toBeDefined();
    if (task === undefined) return;

    const built = buildCompletion(
      { kind: task.kind, subjectId: task.subjectId },
      { last_reviewed_at: '' },
      tasks.value.serverTime,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const completed = await owner.completeReviewTask(task.taskId, built.completion);
    expect(completed.kind).toBe('OK');

    // The record actually changed. This is the exit criterion: the task closed as a consequence
    // of a write, not because anything marked it done (DEC-027, trap 16).
    //
    // It is also a regression test for a real defect this sequence found. The driver returns
    // `timestamptz` as a `Date`, `13` validates the response *before* serialisation, and
    // `shelfItemSchema` requires a string - so once `last_reviewed_at` was non-null the shelf
    // answered 500. Every fixture had it null, so nothing before this read a shelf after a
    // write. Any user who had ever reviewed an item would have hit it.
    const items = await owner.listItems({ profileId: SEED.profileId });
    expect(items.kind).toBe('OK');
    if (items.kind !== 'OK') return;
    const item = items.value.items.find((entry) => entry.id === task.subjectId);
    expect(item?.lastReviewedAt).not.toBeNull();

    const after = await owner.reviewTasks(SEED.profileId);
    expect(after.kind).toBe('OK');
    if (after.kind !== 'OK') return;
    const stillThere = reviewInboxView(after.value.tasks).tasks.some(
      (entry) => entry.taskId === task.taskId,
    );
    expect(stillThere).toBe(false);
  });

  it('refuses a completion the form would not have produced', async () => {
    const tasks = await owner.reviewTasks(SEED.profileId);
    if (tasks.kind !== 'OK') return;
    const task = reviewInboxView(tasks.value.tasks).tasks[0];
    if (task === undefined) return;

    // An empty change set. The client refuses to build one, so this is the server's own rule
    // being checked independently - the two exist for different reasons and both must hold.
    expect(buildCompletion({ kind: task.kind, subjectId: task.subjectId }, {}, NOW_UNUSED).ok).toBe(
      false,
    );

    const outcome = await owner.completeReviewTask(task.taskId, {
      outcome: 'RESOLVED',
      changes: [],
    });
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind !== 'REFUSED') return;
    expect(outcome.code).toBe('VALIDATION_FAILED');
  });

  it('shows a stranger nothing to complete', async () => {
    const tasks = await stranger.reviewTasks(SEED.profileId);
    if (tasks.kind === 'OK') {
      expect(tasks.value.tasks).toEqual([]);
    } else {
      expect(tasks.kind).toBe('UNAVAILABLE');
    }
  });
});

describe('inviting a caregiver, end to end', () => {
  /**
   * The write flow with a real security shape.
   *
   * What is worth asserting here is not that a row appears. It is that step-up actually gates the
   * request, that the token comes back exactly once and never again, and that the client cannot
   * put it anywhere a credential must not go.
   */
  const elevated = () =>
    createClient({
      config: { baseUrl: server.url, timeoutMs: 10_000 },
      session: developmentSession(SEED.userId, { stepUp: true }),
    });

  it('refuses without step-up', async () => {
    // `14`: caregiver administration needs re-authentication, and a merely-valid session is
    // explicitly not sufficient. 403 maps to STEP_UP_REQUIRED and to nothing else (trap 14).
    const draft = buildInvitation({
      profileId: SEED.profileId,
      authority: { kind: 'OWNER' },
      selected: ['VIEW_SHELF'],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok || draft.body === null) return;

    const outcome = await owner.createInvitation(draft.body, crypto.randomUUID());
    expect(outcome.kind).toBe('STEP_UP_REQUIRED');
  });

  it('creates one, and returns the token exactly once', async () => {
    const draft = buildInvitation({
      profileId: SEED.profileId,
      authority: { kind: 'OWNER' },
      selected: ['VIEW_SHELF', 'VIEW_SAFETY'],
      invitedEmail: 'helper@example.test',
    });
    if (!draft.ok || draft.body === null) return;

    const key = crypto.randomUUID();
    const created = await elevated().createInvitation(draft.body, key);
    expect(created.kind).toBe('OK');
    if (created.kind !== 'OK') return;

    expect(created.value.token.length).toBeGreaterThan(20);
    expect(created.value.capabilities.slice().sort()).toEqual(['VIEW_SAFETY', 'VIEW_SHELF']);

    // It now shows on the list the Care screen renders, as an invitation nobody has accepted -
    // "invited" rather than "has access", which is the distinction that matters when the question
    // is who can read this profile. Without the invitations route the screen showed nothing after
    // sending, and an owner would reasonably have sent a second one - a second live credential
    // for one intent.
    const [grants, invitations] = await Promise.all([
      owner.listCaregiverGrants({ profileId: SEED.profileId }),
      owner.listInvitations({ profileId: SEED.profileId }),
    ]);
    expect(grants.kind).toBe('OK');
    expect(invitations.kind).toBe('OK');
    if (grants.kind !== 'OK' || invitations.kind !== 'OK') return;

    const rows = accessList(grants.value.grants, invitations.value.invitations);
    expect(rows.some((row) => row.state === 'INVITED')).toBe(true);

    // `14`: an address is personal data and this list may be read over someone's shoulder. The
    // response says whether the link is bound, never to whom.
    const pending = invitations.value.invitations[0];
    expect(pending?.boundToAddress).toBe(true);
    expect(JSON.stringify(invitations.value)).not.toContain('helper@example.test');
    expect(JSON.stringify(invitations.value).toLowerCase()).not.toContain('token');

    // DEC-018: the server stores only a SHA-256 hash, so an idempotent retry cannot re-issue the
    // token and says so rather than minting a second live credential for one intent.
    const replay = await elevated().createInvitation(draft.body, key);
    if (replay.kind === 'OK') {
      expect(replay.value.token).not.toBe(created.value.token);
    } else {
      expect(replay.kind).toBe('REFUSED');
    }
  });

  it('never lets the token reach a URL', () => {
    // Trap 11. The guard is at the transport, so no client method can route around it.
    expect(() => buildUrlForTest('/v1/caregiver-invitations', { token: 'abc' })).toThrow();
    expect(() => buildUrlForTest('/v1/caregiver-invitations', { inviteToken: 'abc' })).toThrow();
  });

  it('shows a stranger no grants and no invitations for the profile', async () => {
    // `caregiver_invitation_select` admits the owner, an administering caregiver and the account
    // that accepted. Deliberately not the intended recipient before acceptance - they hold the
    // token, and matching an invitation to an address they have not proven they control would
    // leak that the profile exists.
    const grants = await stranger.listCaregiverGrants({ profileId: SEED.profileId });
    if (grants.kind === 'OK') expect(grants.value.grants).toEqual([]);

    const invitations = await stranger.listInvitations({ profileId: SEED.profileId });
    if (invitations.kind === 'OK') expect(invitations.value.invitations).toEqual([]);
  });

  it('tells the owner they own the profile, rather than making the screen guess', async () => {
    // `isManaged` is about the person the profile is for and says nothing about who administers
    // it. Reading one as the other produced an invite screen offering the wrong capabilities.
    const profiles = await owner.listProfiles();
    expect(profiles.kind).toBe('OK');
    if (profiles.kind !== 'OK') return;
    expect(profiles.value.profiles[0]?.isOwner).toBe(true);
  });
});

describe('the Visit Pack, end to end', () => {
  /**
   * The exit criterion of Phase 8.4, exercised through the code the app runs.
   *
   * "A user can review exactly what will be shared" is a property of the system rather than a
   * claim about the client, and DEC-023 is what makes it one: the server rebuilds the selection
   * from live records, recomputes the digest, and refuses if it differs from the one quoted. That
   * only works if both sides hash the same thing - which no unit test on either side can prove
   * alone.
   */
  const sha256: DigestFn = (canonical) =>
    Promise.resolve(createHash('sha256').update(canonical).digest('hex'));

  const elevated = () =>
    createClient({
      config: { baseUrl: server.url, timeoutMs: 10_000 },
      session: developmentSession(SEED.userId, { stepUp: true }),
    });

  it('accepts a digest the client computed from what it displayed', async () => {
    const candidates = await owner.visitPackCandidates(SEED.profileId);
    expect(candidates.kind).toBe('OK');
    if (candidates.kind !== 'OK') return;
    expect(candidates.value.candidates.length).toBeGreaterThan(0);

    const draft = await buildVisitPack(
      {
        profileId: SEED.profileId,
        candidates: candidates.value.candidates,
        selectedEntityIds: candidates.value.candidates.map((entry) => entry.entityId),
        notes: ['Is the rash related?'],
        reviewedAt: candidates.value.serverTime,
      },
      sha256,
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const created = await elevated().createVisitPack(draft.body, crypto.randomUUID());
    // If the two sides disagreed about the canonical form this would be
    // EXPORT_CONTENT_CHANGED - which is exactly the failure the digest exists to report, and
    // exactly the false alarm a mismatched client would produce.
    expect(created.kind).toBe('OK');
  });

  it('refuses a digest of content the user did not see', async () => {
    // DEC-023 in the direction that matters. A client quoting a digest for anything other than
    // what it displayed is refused, whether that is a bug or an attempt to widen an export.
    const candidates = await owner.visitPackCandidates(SEED.profileId);
    if (candidates.kind !== 'OK') return;

    const draft = await buildVisitPack(
      {
        profileId: SEED.profileId,
        candidates: candidates.value.candidates,
        selectedEntityIds: candidates.value.candidates.slice(0, 1).map((e) => e.entityId),
        reviewedAt: candidates.value.serverTime,
      },
      // A hash of something else entirely.
      () => Promise.resolve(createHash('sha256').update('not what was shown').digest('hex')),
    );
    if (!draft.ok) return;

    const created = await elevated().createVisitPack(draft.body, crypto.randomUUID());
    expect(created.kind).toBe('REFUSED');
    if (created.kind !== 'REFUSED') return;
    expect(created.code).toBe('EXPORT_CONTENT_CHANGED');
    expect(contentChanged(created)).toBe(true);
  });

  it('refuses an export without step-up', async () => {
    // `14` treats an export without re-authentication as the failure, whatever else is wrong -
    // the route checks it before it parses the body.
    const candidates = await owner.visitPackCandidates(SEED.profileId);
    if (candidates.kind !== 'OK') return;

    const draft = await buildVisitPack(
      {
        profileId: SEED.profileId,
        candidates: candidates.value.candidates,
        selectedEntityIds: candidates.value.candidates.slice(0, 1).map((e) => e.entityId),
        reviewedAt: candidates.value.serverTime,
      },
      sha256,
    );
    if (!draft.ok) return;

    expect((await owner.createVisitPack(draft.body, crypto.randomUUID())).kind).toBe(
      'STEP_UP_REQUIRED',
    );
  });

  it('offers a stranger nothing to export', async () => {
    // RLS-scoped, so a profile the caller cannot reach yields an empty candidate list rather than
    // a refusal - the same non-confirming behaviour as the shelf.
    const candidates = await stranger.visitPackCandidates(SEED.profileId);
    if (candidates.kind === 'OK') {
      expect(candidates.value.candidates).toEqual([]);
    } else {
      expect(candidates.kind).toBe('UNAVAILABLE');
    }
  });
});

describe('reconciliation, end to end', () => {
  /**
   * Phase 8.5's exit criterion: Kynviora never chooses which conflicting instruction is medically
   * correct. Checked here as a property of the round trip - what the client can send, what the
   * server refuses, and what comes back on the difference.
   */
  it('finds a difference and shows both values without naming one', async () => {
    const start = await owner.startReconciliation({
      profileId: SEED.profileId,
      sourceKind: 'DISCHARGE',
      currentList: [
        {
          matchKey: 'typed:0',
          displayName: 'Synthetic Tablet A',
          strengthText: '250 mg',
          directionsText: 'One tablet each morning',
        },
      ],
    });
    expect(start.kind).toBe('OK');
    if (start.kind !== 'OK') return;

    const read = await owner.reconciliation(start.value.reconciliationId);
    expect(read.kind).toBe('OK');
    if (read.kind !== 'OK') return;

    const difference = read.value.differences[0];
    expect(difference).toBeDefined();
    if (difference === undefined) return;

    // Both sides, and no field naming a preferred one. Trap 19: the absence is the exit
    // criterion, not a gap somebody forgot to fill.
    expect(Object.keys(difference)).toEqual(
      expect.not.arrayContaining(['suggestedValue', 'preferred', 'confidence', 'score']),
    );
    // And the difference vocabulary names a fact about the two lists, never a change to the
    // medicine - there is no ADDED, REMOVED or CHANGED (DEC-029).
    expect(difference.kind).not.toMatch(/^(ADDED|REMOVED|CHANGED)$/);
  });

  it('refuses a settling resolution that names no side', async () => {
    const start = await owner.startReconciliation({
      profileId: SEED.profileId,
      currentList: [
        { matchKey: 'typed:0', displayName: 'Synthetic Capsule B', strengthText: '40 mg' },
      ],
    });
    if (start.kind !== 'OK') return;
    const read = await owner.reconciliation(start.value.reconciliationId);
    if (read.kind !== 'OK') return;
    const difference = read.value.differences[0];
    if (difference === undefined) return;

    // The client refuses to build one, so this checks the server's own rule independently. The
    // two exist for different reasons and both must hold (DEC-030).
    expect(
      buildResolution({ resolution: 'CONFIRMED_WITH_PHARMACIST', confirmedBy: 'A. Pharmacist' }).ok,
    ).toBe(false);

    const outcome = await owner.resolveDifference(
      start.value.reconciliationId,
      difference.differenceId,
      { resolution: 'CONFIRMED_WITH_PHARMACIST', adopt: null, confirmedBy: 'A. Pharmacist' },
    );
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind !== 'REFUSED') return;
    expect(outcome.code).toBe('VALIDATION_FAILED');
  });

  it('records the side a person stated, on either side', async () => {
    // The case the rule is about: a pharmacist may confirm the older dose. If the server only
    // accepted the current list, the screen would be making the judgement Phase 8.5 forbids.
    const start = await owner.startReconciliation({
      profileId: SEED.profileId,
      currentList: [
        {
          matchKey: 'typed:0',
          displayName: 'Synthetic Tablet A',
          strengthText: '750 mg',
          directionsText: 'Two tablets at night',
        },
      ],
    });
    if (start.kind !== 'OK') return;
    const read = await owner.reconciliation(start.value.reconciliationId);
    if (read.kind !== 'OK') return;
    const difference = read.value.differences[0];
    if (difference === undefined) return;

    const draft = buildResolution({
      resolution: 'CONFIRMED_WITH_PHARMACIST',
      // The older value. The one a system inferring from recency would never pick.
      adopt: 'PREVIOUS',
      confirmedBy: 'A. Pharmacist',
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const recorded = await owner.resolveDifference(
      start.value.reconciliationId,
      difference.differenceId,
      draft.body,
    );
    expect(recorded.kind).toBe('OK');

    const after = await owner.reconciliation(start.value.reconciliationId);
    expect(after.kind).toBe('OK');
    if (after.kind !== 'OK') return;
    const settled = after.value.differences.find(
      (entry) => entry.differenceId === difference.differenceId,
    );
    expect(settled?.resolution).toBe('CONFIRMED_WITH_PHARMACIST');
    expect(settled?.confirmedBy).toBe('A. Pharmacist');
  });

  it('shows a stranger nothing', async () => {
    const start = await stranger.startReconciliation({
      profileId: SEED.profileId,
      currentList: [{ matchKey: 'typed:0', displayName: 'Synthetic Tablet A' }],
    });
    // Either refused, or started against nothing the stranger can see - and neither answer
    // confirms the profile exists.
    if (start.kind === 'OK') {
      const read = await stranger.reconciliation(start.value.reconciliationId);
      if (read.kind === 'OK') expect(read.value.differences).toEqual([]);
    } else {
      expect(['UNAVAILABLE', 'REFUSED']).toContain(start.kind);
    }
  });
});

describe('naming the shelf medicine is what makes a comparison useful', () => {
  /**
   * Found by running the flow end to end.
   *
   * With a positional match key nothing on the typed list can ever correspond to a shelf item, so
   * every difference comes back as `ONLY_IN_PREVIOUS` or `ONLY_IN_CURRENT` - the reconciliation
   * reports that the two lists differ, which is the one thing the person already knew. A field
   * difference is the whole point of the feature and it is only reachable when the person says
   * which medicine a line is.
   */
  it('produces a field difference when the line names a shelf item', async () => {
    const items = await owner.listItems({ profileId: SEED.profileId, itemKind: 'MEDICINE' });
    expect(items.kind).toBe('OK');
    if (items.kind !== 'OK') return;
    const shelfItem = items.value.items[0];
    expect(shelfItem).toBeDefined();
    if (shelfItem === undefined) return;

    const start = await owner.startReconciliation({
      profileId: SEED.profileId,
      sourceKind: 'DISCHARGE',
      currentList: [
        medicationLine({
          index: 0,
          displayName: shelfItem.displayName,
          // A different strength from the one on the shelf.
          strengthText: '999 mg',
          matchedItemId: shelfItem.id,
        }),
      ],
    });
    expect(start.kind).toBe('OK');
    if (start.kind !== 'OK') return;

    const read = await owner.reconciliation(start.value.reconciliationId);
    expect(read.kind).toBe('OK');
    if (read.kind !== 'OK') return;

    // The strength difference specifically, not the first FIELD_DIFFERS. A named line with no
    // dosage form produces a second field difference whose current value is null, and `.find()`
    // over an unordered list picked whichever the database returned first - a test that failed
    // about one in five runs and named the wrong cause when it did.
    const field = read.value.differences.find(
      (entry) => entry.kind === 'FIELD_DIFFERS' && entry.field === 'strengthText',
    );
    expect(field).toBeDefined();
    if (field === undefined) return;

    // Both values on the row, and no field naming a preferred one.
    expect(field.previousValue).not.toBe(field.currentValue);
    expect(field.currentValue).toBe('999 mg');
    expect(Object.keys(field)).toEqual(
      expect.not.arrayContaining(['suggestedValue', 'preferred', 'confidence', 'score']),
    );
  });

  it('reports an unmatched line as present in one list only', async () => {
    // Not a failure: a medicine genuinely new to the shelf belongs in exactly that state.
    const start = await owner.startReconciliation({
      profileId: SEED.profileId,
      currentList: [medicationLine({ index: 0, displayName: 'Synthetic Syrup D' })],
    });
    if (start.kind !== 'OK') return;
    const read = await owner.reconciliation(start.value.reconciliationId);
    if (read.kind !== 'OK') return;
    expect(read.value.differences.some((entry) => entry.kind === 'ONLY_IN_CURRENT')).toBe(true);
  });
});

describe('removing access, end to end', () => {
  /**
   * The exit criterion of `15` A2, exercised through the code the app runs.
   *
   * "Revocation takes effect on the next authenticated access" is a property of the whole path,
   * not of the database policy alone. The policy is already tested; what no test on either side
   * proves is that the client the app ships stops showing the content afterwards. A screen that
   * kept the medicine list up under a "not up to date" label would satisfy every server-side
   * assertion and still leave the removed person reading it.
   */
  const stepUp = (userId: string) =>
    createClient({
      config: { baseUrl: server.url, timeoutMs: 10_000 },
      session: developmentSession(userId, { stepUp: true }),
    });

  /** The seeded second account, which has a verified address the invitation can bind to. */
  const CAREGIVER = SEED.caregiverUserId;
  const caregiver = () =>
    createClient({
      config: { baseUrl: server.url, timeoutMs: 10_000 },
      session: developmentSession(CAREGIVER),
    });

  /**
   * Acceptance is the caregiver's own onboarding rather than a Care screen action, so it has no
   * client method. Driven with a plain request here, which is honest about what is being set up.
   */
  async function accept(token: string): Promise<string> {
    const response = await fetch(`${server.url}/v1/caregiver-invitations/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kynviora-dev-user': CAREGIVER,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ token }),
    });
    const body = (await response.json()) as { grantId?: string };
    return body.grantId ?? '';
  }

  async function inviteAndAccept(
    capabilities: readonly string[] = ['VIEW_SHELF', 'VIEW_MEDICINES'],
  ): Promise<string> {
    const draft = buildInvitation({
      profileId: SEED.profileId,
      authority: { kind: 'OWNER' },
      selected: capabilities,
      invitedEmail: 'caregiver@example.test',
    });
    if (!draft.ok || draft.body === null) throw new Error('the invitation draft was refused');
    const created = await stepUp(SEED.userId).createInvitation(draft.body, crypto.randomUUID());
    if (created.kind !== 'OK') throw new Error(`the invitation failed: ${created.kind}`);
    const grantId = await accept(created.value.token);
    if (grantId === '') throw new Error('the invitation was not accepted');
    return grantId;
  }

  it('refuses without step-up', async () => {
    // `14`: caregiver administration needs re-authentication, and a merely-valid session is
    // explicitly not sufficient. 403 maps to STEP_UP_REQUIRED and to nothing else (trap 14).
    const grantId = await inviteAndAccept();
    const outcome = await owner.revokeGrant(grantId);
    expect(outcome.kind).toBe('STEP_UP_REQUIRED');

    // And it genuinely did not happen. A refusal that had already applied the change would be
    // the worst of both.
    const grants = await owner.listCaregiverGrants({ profileId: SEED.profileId });
    if (grants.kind !== 'OK') return;
    expect(grants.value.grants.some((g) => g.id === grantId && g.status === 'ACTIVE')).toBe(true);

    await stepUp(SEED.userId).revokeGrant(grantId);
  });

  it('stops the caregiver seeing anything, on their very next request', async () => {
    // Phase 8.1's exit criterion and `15` A2, through the client rather than through SQL. No
    // sync, no token refresh and no cache purge happens between these two reads.
    const grantId = await inviteAndAccept();

    const before = await caregiver().listProfiles();
    expect(before.kind).toBe('OK');
    if (before.kind !== 'OK') return;
    expect(before.value.profiles.some((p) => p.id === SEED.profileId)).toBe(true);

    const revoked = await stepUp(SEED.userId).revokeGrant(grantId);
    expect(revoked.kind).toBe('OK');
    if (revoked.kind !== 'OK') return;
    expect(revoked.value.alreadyRevoked).toBe(false);

    const after = await caregiver().listProfiles();
    if (after.kind !== 'OK') return;
    expect(after.value.profiles.some((p) => p.id === SEED.profileId)).toBe(false);
  });

  it('takes the content off the screen rather than labelling it', async () => {
    // The client half of A2, and the reason `refreshedResource` exists. The caregiver's screen
    // had a medicine list; after revocation the same call must leave nothing on it.
    const grantId = await inviteAndAccept();
    const isEmpty = (value: { readonly items: readonly unknown[] }) => value.items.length === 0;

    const loaded = await caregiver().listItems({ profileId: SEED.profileId });
    const displayed = refreshedResource(loaded, null, { isEmpty });
    expect(displayed.value?.items.length ?? 0).toBeGreaterThan(0);

    await stepUp(SEED.userId).revokeGrant(grantId);

    const refreshed = await caregiver().listItems({ profileId: SEED.profileId });
    const after = refreshedResource(refreshed, displayed.value, { isEmpty });
    expect(after.value).toBeNull();
    expect(after.state).not.toBe('STALE');
  });

  it('clears a profile-scoped screen too, where the answer is a 404 rather than an empty list', async () => {
    // Which shape a screen meets is a routing detail, and both have to clear it. The shelf is
    // filtered by row-level security and comes back empty; the notification settings route
    // refuses outright and comes back as absence (DEC-039). A rule that only handled the first
    // would leave the caregiver's settings screen showing the profile's dials.
    const grantId = await inviteAndAccept(['VIEW_SHELF', 'VIEW_SAFETY']);

    const loaded = await caregiver().notificationSettings(SEED.profileId);
    expect(loaded.kind).toBe('OK');
    if (loaded.kind !== 'OK') return;

    await stepUp(SEED.userId).revokeGrant(grantId);

    const refreshed = await caregiver().notificationSettings(SEED.profileId);
    expect(refreshed.kind).toBe('UNAVAILABLE');
    expect(refreshedResource(refreshed, loaded.value).value).toBeNull();
    expect(refreshedResource(refreshed, loaded.value).state).not.toBe('STALE');
  });

  it('reports a repeat as done rather than as a failure', async () => {
    // Someone removing another person's access who is answered with an error has been given a
    // reason to doubt whether it worked. The second call says there was nothing left to do.
    const grantId = await inviteAndAccept();
    const first = await stepUp(SEED.userId).revokeGrant(grantId);
    const second = await stepUp(SEED.userId).revokeGrant(grantId);

    expect(first.kind).toBe('OK');
    expect(second.kind).toBe('OK');
    if (first.kind !== 'OK' || second.kind !== 'OK') return;
    expect(first.value.alreadyRevoked).toBe(false);
    expect(second.value.alreadyRevoked).toBe(true);
  });

  it('is not an existence oracle for a grant somebody else holds', async () => {
    // Trap 14 and DEC-039. A stranger gets the same answer for a real grant as for an invented
    // one, and the client has no outcome meaning "you are not allowed".
    const grantId = await inviteAndAccept();
    const real = await stepUp(STRANGER).revokeGrant(grantId);
    const invented = await stepUp(STRANGER).revokeGrant('00000000-0000-4000-8000-0000000000ff');
    expect(real.kind).toBe('UNAVAILABLE');
    expect(invented.kind).toBe(real.kind);

    // And it did not happen.
    const grants = await owner.listCaregiverGrants({ profileId: SEED.profileId });
    if (grants.kind !== 'OK') return;
    expect(grants.value.grants.some((g) => g.id === grantId && g.status === 'ACTIVE')).toBe(true);
    await stepUp(SEED.userId).revokeGrant(grantId);
  });

  it('lets a caregiver renounce their own access without administering anything', async () => {
    // Access someone no longer wants is retained access, which is the A2 failure in a slower
    // form. This grant carries no MANAGE_CAREGIVERS and the caregiver still removes it.
    const grantId = await inviteAndAccept(['VIEW_SHELF']);

    const own = await caregiver().listCaregiverGrants({ profileId: SEED.profileId });
    expect(own.kind).toBe('OK');
    if (own.kind !== 'OK') return;

    // The server says whose grant it is, so the confirmation does not have to work it out from
    // an identity read back off the session (DEC-047's reasoning, applied to a grant).
    expect(own.value.grants.find((g) => g.id === grantId)?.isSelf).toBe(true);

    const row = accessList(own.value.grants, []).find((candidate) => candidate.id === grantId);
    expect(row).toBeDefined();
    if (row === undefined) return;
    const draft = buildRevocation(row);
    expect(draft.target?.isSelf).toBe(true);
    expect(draft.target?.subject).toBe('GRANT');

    expect((await stepUp(CAREGIVER).revokeGrant(grantId)).kind).toBe('OK');

    const after = await caregiver().listProfiles();
    if (after.kind !== 'OK') return;
    expect(after.value.profiles.some((p) => p.id === SEED.profileId)).toBe(false);
  });

  it('tells the owner a grant is not theirs, on the same list', async () => {
    // The other half of `isSelf`. An administering caregiver sees both kinds of row at once, and
    // "they will stop seeing this profile" is the wrong sentence for one of them.
    const grantId = await inviteAndAccept(['VIEW_SHELF']);
    const grants = await owner.listCaregiverGrants({ profileId: SEED.profileId });
    if (grants.kind !== 'OK') return;
    expect(grants.value.grants.find((g) => g.id === grantId)?.isSelf).toBe(false);
    await stepUp(SEED.userId).revokeGrant(grantId);
  });

  it('withdraws an invitation through its own route, and the token stops working', async () => {
    // Two records and two routes. Withdrawing the invitation is the only way to stop a live
    // token being redeemed: it was stored as a hash and cannot be reissued (DEC-018), so it
    // cannot be cancelled by replacing it either.
    const draft = buildInvitation({
      profileId: SEED.profileId,
      authority: { kind: 'OWNER' },
      selected: ['VIEW_SHELF'],
      invitedEmail: 'caregiver@example.test',
    });
    if (!draft.ok || draft.body === null) return;
    const created = await stepUp(SEED.userId).createInvitation(draft.body, crypto.randomUUID());
    if (created.kind !== 'OK') return;

    const invitations = await owner.listInvitations({ profileId: SEED.profileId });
    if (invitations.kind !== 'OK') return;
    const row = accessList([], invitations.value.invitations).find(
      (candidate) => candidate.id === created.value.invitationId,
    );
    // The row the screen would offer, tagged with the record it came from. Without the tag the
    // remove control would reach the grant route, which answers 404 - and the client renders a
    // 404 as absence, so the bug would have looked like the row quietly vanishing.
    expect(row?.subject).toBe('INVITATION');
    expect(row?.state).toBe('INVITED');

    const withdrawn = await stepUp(SEED.userId).revokeInvitation(created.value.invitationId);
    expect(withdrawn.kind).toBe('OK');

    // The live credential is dead. This is the assertion the whole flow exists for.
    expect(await accept(created.value.token)).toBe('');

    const after = await owner.listInvitations({ profileId: SEED.profileId });
    if (after.kind !== 'OK') return;
    expect(after.value.invitations.some((i) => i.id === created.value.invitationId)).toBe(false);
  });

  it('sends the owner to the grant when the invitation has already been accepted', async () => {
    // Closing the invitation here would be theatre: the access lives in the grant, and a screen
    // reporting success would say the access was removed while leaving it in place.
    const draft = buildInvitation({
      profileId: SEED.profileId,
      authority: { kind: 'OWNER' },
      selected: ['VIEW_SHELF'],
      invitedEmail: 'caregiver@example.test',
    });
    if (!draft.ok || draft.body === null) return;
    const created = await stepUp(SEED.userId).createInvitation(draft.body, crypto.randomUUID());
    if (created.kind !== 'OK') return;
    const grantId = await accept(created.value.token);
    expect(grantId).not.toBe('');

    const outcome = await stepUp(SEED.userId).revokeInvitation(created.value.invitationId);
    expect(outcome.kind).toBe('REFUSED');
    if (outcome.kind !== 'REFUSED') return;
    expect(outcome.code).toBe(ALREADY_ACCEPTED_CODE);

    // What the screen actually shows. The wire message for this code is shared with the
    // acceptance path and so says only "this invitation has already been used" - true, and a
    // dead end for an owner who is looking at the list and wants the access gone.
    expect(revocationMessage(outcome)).toBe(REVOCATION_COPY.alreadyAccepted);
    expect(revocationMessage(outcome)).toMatch(/instead/i);

    await stepUp(SEED.userId).revokeGrant(grantId);
  });

  it('records who removed what, in words the owner can read', async () => {
    // `03` group H requires audit event visibility, and `06` Journey 6 step 5 requires the owner
    // to see that access changed. After a removal the list is one row shorter and nothing else
    // on the screen says it happened.
    const grantId = await inviteAndAccept(['VIEW_SHELF']);
    await stepUp(SEED.userId).revokeGrant(grantId);

    const audit = await owner.caregiverAudit(SEED.profileId);
    expect(audit.kind).toBe('OK');
    if (audit.kind !== 'OK') return;

    const removal = audit.value.events.find(
      (event) => event.action === 'caregiver.grant.revoked' && event.targetId === grantId,
    );
    expect(removal).toBeDefined();
    expect(removal?.actorUserId).toBe(SEED.userId);
    // `20`: the detail is scalars, and it records who acted rather than what they could see.
    expect(removal?.detail['reason_code']).toBe('administrator');
    // And *what* was removed. Found by running the flow: the removal event recorded an empty
    // capability list, which on the history screen reads as "a grant with no capabilities was
    // removed" rather than as "nobody wrote them down" - and it is the one entry an owner has
    // nothing else to check against.
    expect(removal?.detail['capability_count']).toBe(1);
    expect(removal?.detail['capabilities']).toBe('VIEW_SHELF');

    const history = accessHistory(audit.value.events);
    expect(history.lines.some((line) => line.description === 'Access was removed.')).toBe(true);
    expect(history.unreadableCount).toBe(0);
    // No health content reaches this screen. `20` forbids the log becoming a copy of it.
    expect(JSON.stringify(history)).not.toContain('Synthetic');
  });

  it('records a self-removal as a different reason from an administrator one', async () => {
    // Not decoration: `15` treats a caregiver renouncing access and an owner withdrawing it as
    // different events, and an audit trail that could not tell them apart would answer "who
    // removed this" with a guess.
    const grantId = await inviteAndAccept(['VIEW_SHELF']);
    await stepUp(CAREGIVER).revokeGrant(grantId);

    const audit = await owner.caregiverAudit(SEED.profileId);
    if (audit.kind !== 'OK') return;
    const removal = audit.value.events.find(
      (event) => event.action === 'caregiver.grant.revoked' && event.targetId === grantId,
    );
    expect(removal?.detail['reason_code']).toBe('self');
    expect(removal?.actorUserId).toBe(CAREGIVER);
  });

  it('shows a stranger no access history at all', async () => {
    // Scoped by the same authority as the rest of the surface, and a refusal arrives as absence
    // rather than as a statement that the profile exists.
    expect((await stranger.caregiverAudit(SEED.profileId)).kind).toBe('UNAVAILABLE');
  });
});

describe('a caregiver delegating what they hold, end to end', () => {
  /**
   * `DEV-026` closed, exercised through the code the app runs.
   *
   * The rule itself - a caregiver may pass on only what they hold, and never caregiver
   * administration - has been implemented and tested since Phase 8.1. What it had never been
   * given is its input: the Care screen passed an empty list, so a caregiver holding
   * `MANAGE_CAREGIVERS` was offered nothing and could invite nobody. Only a real grants response
   * proves the derivation and the server's own check agree about what this person holds.
   */
  const stepUp = (userId: string) =>
    createClient({
      config: { baseUrl: server.url, timeoutMs: 10_000 },
      session: developmentSession(userId, { stepUp: true }),
    });

  const CAREGIVER = SEED.caregiverUserId;
  const caregiver = () =>
    createClient({
      config: { baseUrl: server.url, timeoutMs: 10_000 },
      session: developmentSession(CAREGIVER),
    });

  async function acceptAs(userId: string, token: string): Promise<string> {
    const response = await fetch(`${server.url}/v1/caregiver-invitations/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kynviora-dev-user': userId,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ token }),
    });
    const body = (await response.json()) as { grantId?: string };
    return body.grantId ?? '';
  }

  /** Give the seeded caregiver administration plus one thing to pass on, and accept it. */
  async function makeAdministrator(): Promise<string> {
    const draft = buildInvitation({
      profileId: SEED.profileId,
      authority: { kind: 'OWNER' },
      selected: ['MANAGE_CAREGIVERS', 'VIEW_SHELF'],
      invitedEmail: 'caregiver@example.test',
    });
    if (!draft.ok || draft.body === null) throw new Error('the invitation draft was refused');
    const created = await stepUp(SEED.userId).createInvitation(draft.body, crypto.randomUUID());
    if (created.kind !== 'OK') throw new Error(`the invitation failed: ${created.kind}`);
    const grantId = await acceptAs(CAREGIVER, created.value.token);
    if (grantId === '') throw new Error('the invitation was not accepted');
    return grantId;
  }

  it('offers exactly what they hold, minus administration itself', async () => {
    const grantId = await makeAdministrator();

    const grants = await caregiver().listCaregiverGrants({ profileId: SEED.profileId });
    expect(grants.kind).toBe('OK');
    if (grants.kind !== 'OK') return;

    const held = heldCapabilities(grants.value.grants, grants.value.serverTime);
    expect(held.slice().sort()).toEqual(['MANAGE_CAREGIVERS', 'VIEW_SHELF']);

    const authority = inviterAuthority({ isOwner: false, ownCapabilities: held });
    // DEC-020: never caregiver administration, whatever they hold themselves.
    expect(selectableCapabilities(authority)).toEqual(['VIEW_SHELF']);
    expect(mayInvite(authority)).toBe(true);

    await stepUp(SEED.userId).revokeGrant(grantId);
  });

  it('sends an invitation the server accepts, for what the screen offered', async () => {
    // The assertion that matters: the client's derivation and the server's own delegation check
    // agree. Before this, the screen offered nothing and the flow could not be reached at all.
    const grantId = await makeAdministrator();

    const grants = await caregiver().listCaregiverGrants({ profileId: SEED.profileId });
    if (grants.kind !== 'OK') return;
    const authority = inviterAuthority({
      isOwner: false,
      ownCapabilities: heldCapabilities(grants.value.grants, grants.value.serverTime),
    });

    const draft = buildInvitation({
      profileId: SEED.profileId,
      authority,
      selected: [...selectableCapabilities(authority)],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok || draft.body === null) return;

    const created = await stepUp(CAREGIVER).createInvitation(draft.body, crypto.randomUUID());
    expect(created.kind).toBe('OK');
    if (created.kind !== 'OK') return;
    expect(created.value.capabilities).toEqual(['VIEW_SHELF']);

    await stepUp(CAREGIVER).revokeInvitation(created.value.invitationId);
    await stepUp(SEED.userId).revokeGrant(grantId);
  });

  it('is refused by the server if the screen is bypassed', async () => {
    // The client's rule is a usability decision, not the security boundary. `canDelegateCapabilities`
    // runs server-side on every request and answers CAPABILITY_ESCALATION regardless of what any
    // screen offered (DEC-020).
    const grantId = await makeAdministrator();

    const escalation = await stepUp(CAREGIVER).createInvitation(
      { profileId: SEED.profileId, capabilities: ['MANAGE_CAREGIVERS'] },
      crypto.randomUUID(),
    );
    expect(escalation.kind).toBe('REFUSED');
    if (escalation.kind === 'REFUSED') expect(escalation.code).toBe('CAPABILITY_ESCALATION');

    const beyond = await stepUp(CAREGIVER).createInvitation(
      { profileId: SEED.profileId, capabilities: ['MANAGE_MEDICINES'] },
      crypto.randomUUID(),
    );
    expect(beyond.kind).toBe('REFUSED');

    await stepUp(SEED.userId).revokeGrant(grantId);
  });

  it('offers a caregiver who does not administer access no invite control at all', async () => {
    // Not a greyed-out button. The only reachable outcome would be a 404, after they had filled
    // in a form (DEC-045 one level up).
    const draft = buildInvitation({
      profileId: SEED.profileId,
      authority: { kind: 'OWNER' },
      selected: ['VIEW_SHELF'],
      invitedEmail: 'caregiver@example.test',
    });
    if (!draft.ok || draft.body === null) return;
    const created = await stepUp(SEED.userId).createInvitation(draft.body, crypto.randomUUID());
    if (created.kind !== 'OK') return;
    const grantId = await acceptAs(CAREGIVER, created.value.token);

    const grants = await caregiver().listCaregiverGrants({ profileId: SEED.profileId });
    if (grants.kind !== 'OK') return;
    const authority = inviterAuthority({
      isOwner: false,
      ownCapabilities: heldCapabilities(grants.value.grants, grants.value.serverTime),
    });
    expect(mayInvite(authority)).toBe(false);

    // And the server agrees, which is what makes withholding the control honest rather than
    // merely tidy.
    const attempt = await stepUp(CAREGIVER).createInvitation(
      { profileId: SEED.profileId, capabilities: ['VIEW_SHELF'] },
      crypto.randomUUID(),
    );
    expect(attempt.kind).toBe('UNAVAILABLE');

    await stepUp(SEED.userId).revokeGrant(grantId);
  });

  it('stops offering anything the moment the grant is removed', async () => {
    // The delegation input is derived from live grants rather than held, so it follows `15` A2
    // with nothing extra to remember.
    const grantId = await makeAdministrator();
    await stepUp(SEED.userId).revokeGrant(grantId);

    const grants = await caregiver().listCaregiverGrants({ profileId: SEED.profileId });
    if (grants.kind !== 'OK') return;
    const held = heldCapabilities(grants.value.grants, grants.value.serverTime);
    expect(held).toEqual([]);
    expect(mayInvite(inviterAuthority({ isOwner: false, ownCapabilities: held }))).toBe(false);
  });
});

describe('recording what happened, end to end', () => {
  /**
   * Phase 4.3 through the code the app runs.
   *
   * Its two exit criteria are a copy rule and an idempotency rule. The copy is asserted where the
   * copy lives; the idempotency rule can only be shown against a real server, because "a duplicate
   * sync does not create a duplicate dose event" is a claim about what the database ends up
   * holding after the same intent arrives twice.
   */
  let itemId: string;

  beforeAll(async () => {
    const items = await owner.listItems({ profileId: SEED.profileId, itemKind: 'MEDICINE' });
    if (items.kind !== 'OK') throw new Error(`the shelf did not load: ${items.kind}`);
    const first = items.value.items[0];
    if (first === undefined) throw new Error('the seed has no medicine to record against');
    itemId = first.id;
  });

  it('records what the screen built, and reads it back', async () => {
    const draft = buildDoseRecord({
      ownedItemId: itemId,
      itemKind: 'MEDICINE',
      eventKind: 'SKIPPED',
      note: 'felt sick after breakfast',
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok || draft.body === null) return;

    const recorded = await owner.recordDoseEvent(draft.body, crypto.randomUUID());
    expect(recorded.kind).toBe('OK');

    const events = await owner.doseEvents({ ownedItemId: itemId });
    expect(events.kind).toBe('OK');
    if (events.kind !== 'OK') return;

    const history = doseHistory(events.value.events);
    expect(history.lines[0]?.presentation.label).toBe('Skipped');
    // Verbatim. It is the person's own account of what happened to them.
    expect(history.lines[0]?.note).toBe('felt sick after breakfast');
    expect(history.unreadableCount).toBe(0);
  });

  it('does not record a second event for one intent', async () => {
    // Phase 4.3's second exit criterion, and the reason the idempotency key is a parameter rather
    // than generated inside the client: an event created offline may be uploaded more than once,
    // and a duplicated history is a false record of what somebody did.
    const before = await owner.doseEvents({ ownedItemId: itemId });
    if (before.kind !== 'OK') return;
    const countBefore = before.value.events.length;

    const key = crypto.randomUUID();
    const body = { ownedItemId: itemId, eventKind: 'TAKEN' as const };

    const first = await owner.recordDoseEvent(body, key);
    const replay = await owner.recordDoseEvent(body, key);
    expect(first.kind).toBe('OK');
    expect(replay.kind).toBe('OK');
    if (first.kind !== 'OK' || replay.kind !== 'OK') return;
    // The same row, not a second one.
    expect(replay.value.id).toBe(first.value.id);

    const after = await owner.doseEvents({ ownedItemId: itemId });
    if (after.kind !== 'OK') return;
    expect(after.value.events.length).toBe(countBefore + 1);
  });

  it('returns nothing a screen could turn into a score', async () => {
    // `02` lists gamified adherence scoring as an anti-feature and `23` D-005 forbids the
    // aggregate. A `takenCount` on this response would hand a screen everything it needs, which
    // is where nobody would notice it had appeared.
    const events = await owner.doseEvents({ ownedItemId: itemId });
    expect(events.kind).toBe('OK');
    if (events.kind !== 'OK') return;

    expect(Object.keys(events.value).sort()).toEqual(['events', 'ownedItemId', 'serverTime']);
    const names = Object.keys(events.value.events[0] ?? {});
    expect(names.filter((n) => /count|rate|streak|score|percent|total|adherence/i.test(n))).toEqual(
      [],
    );
  });

  it('keeps the newest first', async () => {
    const events = await owner.doseEvents({ ownedItemId: itemId });
    if (events.kind !== 'OK') return;
    const times = events.value.events.map((event) => event.recordedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('shows a stranger nothing, without confirming the item exists', async () => {
    // The item ID narrows; `dose_event_select` decides. An item this caller cannot reach comes
    // back as an empty list rather than a refusal, exactly as the shelf does - so the route is
    // not an existence oracle for an owned item ID.
    const real = await stranger.doseEvents({ ownedItemId: itemId });
    const invented = await stranger.doseEvents({
      ownedItemId: '00000000-0000-4000-8000-0000000000fe',
    });
    expect(real.kind).toBe('OK');
    expect(invented.kind).toBe(real.kind);
    if (real.kind !== 'OK' || invented.kind !== 'OK') return;
    expect(real.value.events).toEqual([]);
    expect(invented.value.events).toEqual([]);
  });

  it('refuses to record against an item the caller cannot reach', async () => {
    // The write side is not filtered, it is refused - and reported as absence rather than as a
    // refusal, so the response does not confirm the item exists (DEC-039).
    const outcome = await stranger.recordDoseEvent(
      { ownedItemId: itemId, eventKind: 'TAKEN' },
      crypto.randomUUID(),
    );
    expect(outcome.kind).toBe('UNAVAILABLE');
  });

  it('refuses a note longer than the column will take, before sending it', async () => {
    const draft = buildDoseRecord({
      ownedItemId: itemId,
      itemKind: 'MEDICINE',
      eventKind: 'TAKEN',
      note: 'x'.repeat(MAX_DOSE_NOTE_LENGTH + 1),
    });
    expect(draft.ok).toBe(false);

    // And the server agrees, which is what makes refusing it on the client a convenience rather
    // than a rule only the screen knows.
    const outcome = await owner.recordDoseEvent(
      {
        ownedItemId: itemId,
        eventKind: 'TAKEN',
        note: 'x'.repeat(MAX_DOSE_NOTE_LENGTH + 1),
      },
      crypto.randomUUID(),
    );
    expect(outcome.kind).toBe('REFUSED');
  });

  it('lets a caregiver read the history their grant admits', async () => {
    // `16`: a caregiver gets exactly what they were granted. VIEW_MEDICINES reaches the item, and
    // `dose_event_select` follows the item rather than carrying a rule of its own.
    const draft = buildInvitation({
      profileId: SEED.profileId,
      authority: { kind: 'OWNER' },
      selected: ['VIEW_MEDICINES'],
      invitedEmail: 'caregiver@example.test',
    });
    if (!draft.ok || draft.body === null) return;
    const elevated = createClient({
      config: { baseUrl: server.url, timeoutMs: 10_000 },
      session: developmentSession(SEED.userId, { stepUp: true }),
    });
    const created = await elevated.createInvitation(draft.body, crypto.randomUUID());
    if (created.kind !== 'OK') return;

    const response = await fetch(`${server.url}/v1/caregiver-invitations/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kynviora-dev-user': SEED.caregiverUserId,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ token: created.value.token }),
    });
    const grantId = ((await response.json()) as { grantId?: string }).grantId ?? '';
    expect(grantId).not.toBe('');

    const asCaregiver = createClient({
      config: { baseUrl: server.url, timeoutMs: 10_000 },
      session: developmentSession(SEED.caregiverUserId),
    });
    const events = await asCaregiver.doseEvents({ ownedItemId: itemId });
    expect(events.kind).toBe('OK');
    if (events.kind !== 'OK') return;
    expect(events.value.events.length).toBeGreaterThan(0);

    // And it stops on the next request after the grant is removed (`15` A2).
    await createClient({
      config: { baseUrl: server.url, timeoutMs: 10_000 },
      session: developmentSession(SEED.userId, { stepUp: true }),
    }).revokeGrant(grantId);

    const after = await asCaregiver.doseEvents({ ownedItemId: itemId });
    if (after.kind !== 'OK') return;
    expect(after.value.events).toEqual([]);
  });
});

describe('the Safety Watch inbox, end to end', () => {
  /**
   * Phase 7.1's first exit criterion, exercised through the code the app runs.
   *
   * "No state implies guaranteed safety" is not a wording rule - it is what the screen does with
   * an item nobody has checked. The seed publishes no safety content at all (`BLK-006`, DEC-016),
   * so every line here comes back as the state that claims least, and that is the assertion: not
   * that the screen is empty, but that it is full of honest lines.
   */
  it('gives every item on the shelf a line, not only the ones with alerts', async () => {
    // The reason this route exists. `GET /v1/alerts` returns nothing for this profile, and a
    // screen built on it would show an empty page that a person reads as "all clear".
    const [alerts, inbox, items] = await Promise.all([
      owner.listAlerts(),
      owner.safetyInbox(SEED.profileId),
      owner.listItems({ profileId: SEED.profileId }),
    ]);
    expect(alerts.kind).toBe('OK');
    expect(inbox.kind).toBe('OK');
    expect(items.kind).toBe('OK');
    if (alerts.kind !== 'OK' || inbox.kind !== 'OK' || items.kind !== 'OK') return;

    expect(alerts.value.alerts).toEqual([]);
    expect(inbox.value.lines.length).toBe(items.value.items.length);
    expect(inbox.value.lines.length).toBeGreaterThan(0);
  });

  it('never reads an unassessed item as one that came back clear', async () => {
    // `23` D-014. Nothing has been assessed against this seed, so "nothing matched" would be a
    // reassurance nobody earned.
    const inbox = await owner.safetyInbox(SEED.profileId);
    if (inbox.kind !== 'OK') return;

    for (const line of inbox.value.lines) {
      expect(line.state).toBe('INSUFFICIENT_DATA');
      expect(line.lastAssessedAt).toBeNull();
    }

    const view = safetyInboxView(inbox.value);
    for (const rendered of view.lines) {
      expect(rendered.state.label).not.toMatch(/nothing matched|safe|clear/i);
      // And no urgency or evidence chip, because there is no alert to have either.
      expect(rendered.urgency).toBeNull();
      expect(rendered.evidence).toBeNull();
    }
  });

  it('puts the coverage statement on screen even with a full list', async () => {
    // `09` requires it to accompany the result. An inbox of "not enough information" lines is
    // exactly where somebody would conclude Kynviora had checked and found nothing.
    const inbox = await owner.safetyInbox(SEED.profileId);
    if (inbox.kind !== 'OK') return;
    const view = safetyInboxView(inbox.value);
    expect(view.lines.length).toBeGreaterThan(0);
    expect(view.coverageStatement).toBe(SAFETY_EMPTY_COVERAGE);
  });

  it('filters by state, and says the list is a subset', async () => {
    // Phase 7.1 names filters by profile, urgency and status. Profile is the scope; these two
    // narrow within it.
    const all = await owner.safetyInbox(SEED.profileId);
    const matching = await owner.safetyInbox(SEED.profileId, { states: ['INSUFFICIENT_DATA'] });
    const none = await owner.safetyInbox(SEED.profileId, { states: ['ACTION_REQUIRED'] });
    if (all.kind !== 'OK' || matching.kind !== 'OK' || none.kind !== 'OK') return;

    expect(matching.value.lines.length).toBe(all.value.lines.length);
    expect(none.value.lines).toEqual([]);
    // The shelf size is unchanged by the filter, which is what lets a screen say what it is a
    // subset of without counting anything urgent.
    expect(none.value.totalItems).toBe(all.value.totalItems);
    expect(safetyInboxView(none.value).filtered).toBe(true);
  });

  it('excludes lines with no alert from an urgency filter', async () => {
    // Asking for CRITICAL and being shown items with no alert at all would make the filter
    // meaningless.
    const outcome = await owner.safetyInbox(SEED.profileId, { urgencies: ['CRITICAL'] });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.value.lines).toEqual([]);
  });

  it('refuses a filter value it does not recognise, rather than ignoring it', async () => {
    // A silently-dropped filter shows more than was asked for, which on this screen is the wrong
    // direction to fail in.
    const outcome = await owner.safetyInbox(SEED.profileId, { states: ['DEFINITELY_FINE'] });
    expect(outcome.kind).toBe('REFUSED');
  });

  it('shows a stranger nothing, without confirming the profile exists', async () => {
    // Row-level security decides; the profile ID narrows. An empty list rather than a refusal is
    // the same answer the shelf gives (`13`, DEC-039).
    const outcome = await stranger.safetyInbox(SEED.profileId);
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.value.lines).toEqual([]);
    expect(outcome.value.totalItems).toBe(0);
  });

  it('shows a caregiver what their grant admits and stops when it is removed', async () => {
    // `16`: a caregiver gets exactly what they were granted, and `15` A2 makes the removal
    // immediate. The inbox follows `owned_item`, so it inherits both rather than restating them.
    const draft = buildInvitation({
      profileId: SEED.profileId,
      authority: { kind: 'OWNER' },
      selected: ['VIEW_MEDICINES', 'VIEW_SHELF'],
      invitedEmail: 'caregiver@example.test',
    });
    if (!draft.ok || draft.body === null) return;

    const elevated = createClient({
      config: { baseUrl: server.url, timeoutMs: 10_000 },
      session: developmentSession(SEED.userId, { stepUp: true }),
    });
    const created = await elevated.createInvitation(draft.body, crypto.randomUUID());
    if (created.kind !== 'OK') return;

    const accepted = await fetch(`${server.url}/v1/caregiver-invitations/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kynviora-dev-user': SEED.caregiverUserId,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ token: created.value.token }),
    });
    const grantId = ((await accepted.json()) as { grantId?: string }).grantId ?? '';
    expect(grantId).not.toBe('');

    const asCaregiver = createClient({
      config: { baseUrl: server.url, timeoutMs: 10_000 },
      session: developmentSession(SEED.caregiverUserId),
    });

    const before = await asCaregiver.safetyInbox(SEED.profileId);
    if (before.kind !== 'OK') return;
    expect(before.value.lines.length).toBeGreaterThan(0);

    await elevated.revokeGrant(grantId);

    const after = await asCaregiver.safetyInbox(SEED.profileId);
    if (after.kind !== 'OK') return;
    expect(after.value.lines).toEqual([]);
  });
});

describe('the alert detail, end to end', () => {
  it('offers no explanation control on a line with no live alert', async () => {
    // The seed publishes nothing (BLK-006, DEC-016), so every line has a null alert identifier
    // and the screen offers no "why am I seeing this?" control anywhere. Absent rather than
    // disabled, which is the same rule the Lens control follows on this screen (DEC-045).
    const outcome = await owner.safetyInbox(SEED.profileId);
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;

    const view = safetyInboxView(outcome.value);
    expect(view.lines.length).toBeGreaterThan(0);
    for (const line of view.lines) expect(line.alertPublicationId).toBeNull();
  });

  it('answers an alert nobody may see as absence, over a real connection', async () => {
    const outcome = await owner.alertDetail('00000000-0000-4000-8000-0000000000aa');
    // The API answers PERMISSION_DENIED and NOT_FOUND identically with 404, and the client has no
    // outcome meaning "you are not allowed" (DEC-039). This is that all the way through.
    expect(outcome.kind).toBe('UNAVAILABLE');
  });

  it('answers a malformed alert identifier the same way', async () => {
    const outcome = await owner.alertDetail('not-a-uuid');
    expect(outcome.kind).toBe('UNAVAILABLE');
  });

  it('shows a stranger the same absence, without confirming anything exists', async () => {
    const outcome = await stranger.alertDetail('00000000-0000-4000-8000-0000000000aa');
    expect(outcome.kind).toBe('UNAVAILABLE');
  });

  it('refuses an unauthenticated read', async () => {
    const outcome = await anonymous.alertDetail('00000000-0000-4000-8000-0000000000aa');
    expect(outcome.kind).toBe('UNAUTHENTICATED');
  });

  it('will not record a report against an alert the caller cannot reach', async () => {
    const outcome = await owner.reportIncorrectMatch('00000000-0000-4000-8000-0000000000aa');
    expect(outcome.kind).toBe('UNAVAILABLE');
  });
});

describe('the Safety Receipt, end to end', () => {
  /**
   * Phase 7.6 over a real connection.
   *
   * The seed publishes no alert (`BLK-006`, DEC-016), so what a live server can prove here is the
   * boundary rather than the happy path: a receipt is reachable only through an alert the caller
   * can already see, and the refusal is indistinguishable from absence all the way to the client.
   */
  const UNREACHABLE = '00000000-0000-4000-8000-0000000000aa';

  it('answers a receipt nobody may see as absence', async () => {
    const outcome = await owner.safetyReceipt(UNREACHABLE);
    // The client has no outcome meaning "you are not allowed" (DEC-039), and the API answers
    // PERMISSION_DENIED and NOT_FOUND identically. This is that all the way through.
    expect(outcome.kind).toBe('UNAVAILABLE');
  });

  it('answers a malformed alert identifier the same way', async () => {
    const outcome = await owner.safetyReceipt('not-a-uuid');
    expect(outcome.kind).toBe('UNAVAILABLE');
  });

  it('shows a stranger the same absence', async () => {
    const outcome = await stranger.safetyReceipt(UNREACHABLE);
    expect(outcome.kind).toBe('UNAVAILABLE');
  });

  it('refuses an unauthenticated read', async () => {
    const outcome = await anonymous.safetyReceipt(UNREACHABLE);
    expect(outcome.kind).toBe('UNAUTHENTICATED');
  });

  it('will not record a resolution against an alert the caller cannot reach', async () => {
    const outcome = await owner.recordResolution(UNREACHABLE, { resolution: 'REVIEWED' });
    expect(outcome.kind).toBe('UNAVAILABLE');
  });

  it('refuses a resolution outside the vocabulary before it reaches the receipt', async () => {
    // `09` has no word for stopping a medicine, so neither has the schema, the domain, or the
    // route's body schema. Over the wire that is a validation refusal rather than a not-found.
    const outcome = await owner.recordResolution(UNREACHABLE, {
      resolution: 'STOPPED_MEDICINE',
    });
    expect(outcome.kind).not.toBe('OK');
  });

  it('refuses an unauthenticated write', async () => {
    const outcome = await anonymous.recordResolution(UNREACHABLE, { resolution: 'REVIEWED' });
    expect(outcome.kind).toBe('UNAUTHENTICATED');
  });
});

describe('the Global Regulatory Lens, end to end', () => {
  /**
   * Phase 7.2's UI half, against the server the app talks to.
   *
   * The projection and its four hard guarantees are tested in `@kynviora/regulatory`. What only a
   * live server proves is that they survive the wire: DEC-016 rejects every shipped fixture at the
   * Citation Gate, so the answer is an absence - and an absence is exactly the answer this screen
   * has to get right.
   */
  it('answers with an absence that says what it is not', async () => {
    // `09`: "no matched rule within coverage" is not approval, and the coverage statement travels
    // with it. `23` D-014 is the rule this asserts.
    const outcome = await owner.regulatoryLens({ substanceKey: 'substance.nothing.published' });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;

    const view = lensView(outcome.value.lens);
    expect(view.cards.length).toBeGreaterThan(0);

    for (const card of view.cards) {
      // Every card carries its own coverage statement and its own limitations, on the card
      // rather than once at the foot of the screen.
      expect(card.coverageStatement.length).toBeGreaterThan(0);
      expect(card.limitations.length).toBeGreaterThan(0);
      // And nothing on it reads as permission.
      const rendered = [
        ...card.statuses.map((s) => s.label),
        ...card.statuses.map((s) => s.description),
        card.noStatusNote ?? '',
      ].join(' ');
      expect(rendered).not.toMatch(/\ballowed\b|\bpermitted\b|\bsafe\b|\bapproved\b/i);
    }
  });

  it('gives GB and NI separate cards', async () => {
    // Trap 2: they are separate jurisdictions by design, and a single "UK" card would answer one
    // question with the other's law.
    const outcome = await owner.regulatoryLens({ substanceKey: 'substance.nothing.published' });
    if (outcome.kind !== 'OK') return;
    const jurisdictions = lensView(outcome.value.lens).cards.map((card) => card.jurisdiction);
    expect(jurisdictions).toContain('GB');
    expect(jurisdictions).toContain('NI');
    expect(jurisdictions).not.toContain('UK');
  });

  it('keeps the requested jurisdiction order rather than ranking them', async () => {
    // `09` forbids "strict country" framing, and a list sorted by how prohibitive each answer is
    // would be that framing with the words left out.
    const outcome = await owner.regulatoryLens({ substanceKey: 'substance.nothing.published' });
    if (outcome.kind !== 'OK') return;
    const view = lensView(outcome.value.lens);
    expect(view.cards.map((card) => card.jurisdiction)).toEqual(
      outcome.value.lens.entries.map((entry) => entry.jurisdiction),
    );
  });

  it('carries an applicability on every card, separate from the statuses', async () => {
    // DEC-007. The two axes stay two on the wire as well as in the projection, and there is no
    // combined verdict field anywhere in the response.
    const outcome = await owner.regulatoryLens({ substanceKey: 'substance.nothing.published' });
    if (outcome.kind !== 'OK') return;
    for (const entry of outcome.value.lens.entries) {
      expect(typeof entry.applicability).toBe('string');
      expect(Object.keys(entry)).toEqual(
        expect.not.arrayContaining(['compliant', 'verdict', 'severity', 'score', 'rank']),
      );
    }
    for (const card of lensView(outcome.value.lens).cards) {
      expect(card.applicability.label.length).toBeGreaterThan(0);
    }
  });

  it('offers the shelf no substance to ask about yet, rather than a wrong one', async () => {
    // The control on a safety line appears per confirmed substance. Nothing in the seed has an
    // exact ingredient mapping, so nothing is offered - `DEV-024` and `BLK-007`, visible on the
    // screen as an absent control rather than one that opens an answer about the wrong substance.
    const inbox = await owner.safetyInbox(SEED.profileId);
    if (inbox.kind !== 'OK') return;
    for (const line of inbox.value.lines) expect(line.substances).toEqual([]);
  });

  it('refuses to put a substance key where a credential must not go', () => {
    // The transport guard applies to the repeated query shape as well as the single-valued one,
    // which is the whole reason the guard was extended rather than duplicated.
    expect(() => buildUrlForTest('/v1/regulatory-lens', { token: 'abc' })).toThrow();
  });
});

describe('writing down a pack, end to end', () => {
  /**
   * `04` Phases 2.2 and 2.3, through the code path the Expo screens use.
   *
   * Every other suite tests one side. The API suite proves the route stores an absence as an
   * absence; the contracts suite proves the draft builder sends what was typed. Neither proves
   * the form's field names and the body's field names agree over a real connection, and that is
   * the failure that would look like nothing at all: a barcode somebody entered, accepted by a
   * screen, and never stored.
   */

  it('creates a medicine from a name and nothing else, and puts it on the shelf', async () => {
    const before = await owner.listItems({ profileId: SEED.profileId });
    if (before.kind !== 'OK') throw new Error('expected the shelf to load');

    const body = manualEntryDraft({
      profileId: SEED.profileId,
      itemKind: 'MEDICINE',
      values: { displayName: 'End-to-end Tablet (synthetic)' },
    });
    const created = await owner.createItem(body, randomUUID());

    expect(created.kind).toBe('OK');
    if (created.kind !== 'OK') return;
    expect(created.value.replayed).toBe(false);

    const after = await owner.listItems({ profileId: SEED.profileId, limit: 100 });
    if (after.kind !== 'OK') throw new Error('expected the shelf to load');
    expect(
      shelfView(after.value.items, after.value.nextCursor).items.map((i) => i.displayName),
    ).toContain('End-to-end Tablet (synthetic)');
  });

  it('stores every field the personal-care form offers', async () => {
    // Phase 2.3's second exit criterion, over the wire and read back through Phase 2.1's detail.
    // This is the test that would fail on a typo in a form field's key.
    const values: Record<string, string> = {
      displayName: 'End-to-end Shampoo (synthetic)',
      brand: 'Synthetic Brand',
      manufacturer: 'Synthetic Manufacturing Ltd',
      market: 'GB',
      recordedGtin: '1234567890128',
      recordedLotCode: 'LOT-E2E',
      personalCareCategory: 'HAIR_CARE',
      ingredientDeclarationRaw: 'Aqua, Sodium Laureth Sulfate, Glycerin, Parfum',
      labelVersionNote: 'Says new formula on the front',
      expiresOn: '2027-01-31',
      startedOn: '2026-09-01',
      notes: 'The one in the blue bottle.',
    };

    const created = await owner.createItem(
      manualEntryDraft({ profileId: SEED.profileId, itemKind: 'PERSONAL_CARE', values }),
      randomUUID(),
    );
    expect(created.kind).toBe('OK');
    if (created.kind !== 'OK') return;

    const detail = await owner.itemDetail(created.value.id);
    expect(detail.kind).toBe('OK');
    if (detail.kind !== 'OK') return;

    const view = itemDetailScreenView(detail.value);
    const rendered = [...view.categoryFields, ...view.sharedFields]
      .map((field) => field.value)
      .filter((value): value is string => value !== null);

    // Every typed value survives, except the category - which is a closed vocabulary rendered as
    // a phrase rather than as `HAIR_CARE` (trap 129) - and the two the header already carries.
    for (const [field, typed] of Object.entries(values)) {
      if (field === 'personalCareCategory' || field === 'displayName' || field === 'brand') {
        continue;
      }
      expect(rendered, field).toContain(typed);
    }
    expect(rendered).not.toContain('HAIR_CARE');
    expect(view.displayName).toBe('End-to-end Shampoo (synthetic)');
    expect(view.brand).toBe('Synthetic Brand');
  });

  it('stores a blank field as an absence, not as an answer', async () => {
    // Phase 2.2's second exit criterion, end to end. The detail renders "not recorded" for a
    // field nobody filled in, and never an empty value that reads as one somebody did.
    const created = await owner.createItem(
      manualEntryDraft({
        profileId: SEED.profileId,
        itemKind: 'MEDICINE',
        values: { displayName: 'Sparse Tablet (synthetic)', brand: '   ', strengthText: '' },
      }),
      randomUUID(),
    );
    if (created.kind !== 'OK') throw new Error('expected the item to be created');

    // What the record cannot do, said at the moment a person can still act on it (`10`).
    expect(created.value.limitCodes).toContain('NO_IDENTIFIER');
    expect(created.value.limits.length).toBe(created.value.limitCodes.length);
    expect(created.value.completeNote).toBeNull();

    const detail = await owner.itemDetail(created.value.id);
    if (detail.kind !== 'OK') throw new Error('expected the detail to load');

    const view = itemDetailScreenView(detail.value);
    expect(view.brand).toBeNull();
    for (const field of [...view.categoryFields, ...view.sharedFields]) {
      if (field.value === null) expect(field.absentNote).not.toBeNull();
      else expect(field.value.trim()).not.toBe('');
    }
  });

  it('writes one item when the same save arrives twice', async () => {
    // `13`, and the reason the key belongs to the draft rather than to the press: a person on a
    // bad connection tapping Save twice must not end up with two of the same medicine, which
    // `04` Phase 8.5 would later reconcile as two medicines they are taking.
    const key = randomUUID();
    const body = manualEntryDraft({
      profileId: SEED.profileId,
      itemKind: 'MEDICINE',
      values: { displayName: 'Retried Tablet (synthetic)' },
    });

    const first = await owner.createItem(body, key);
    const second = await owner.createItem(body, key);

    expect(first.kind).toBe('OK');
    expect(second.kind).toBe('OK');
    if (first.kind !== 'OK' || second.kind !== 'OK') return;

    expect(first.value.replayed).toBe(false);
    expect(second.value.replayed).toBe(true);
    expect(second.value.id).toBe(first.value.id);

    const shelf = await owner.listItems({ profileId: SEED.profileId, limit: 100 });
    if (shelf.kind !== 'OK') throw new Error('expected the shelf to load');
    const named = shelf.value.items.filter(
      (item) => item.displayName === 'Retried Tablet (synthetic)',
    );
    expect(named.length).toBe(1);
  });

  it('refuses a malformed value and names the field the form should point at', async () => {
    // The refusal has to arrive as a field name rather than as prose. `13`: clients branch on
    // codes, never on message text - and a form with eleven fields that cannot point is one where
    // the person has to find it themselves.
    const refused = await owner.createItem(
      manualEntryDraft({
        profileId: SEED.profileId,
        itemKind: 'MEDICINE',
        values: { displayName: 'Bad Market Tablet (synthetic)', market: 'gb' },
      }),
      randomUUID(),
    );

    expect(refused.kind).toBe('REFUSED');
    if (refused.kind !== 'REFUSED') return;
    expect(refused.detail?.['field']).toBe('market');
    expect(screenStateForFailure(refused)).toBe('RECOVERABLE_ERROR');
  });

  it('tells a stranger nothing about the profile they cannot write to', async () => {
    // The same absence the shelf gives. `13`: a profile ID narrows a write and never grants one.
    const refused = await stranger.createItem(
      manualEntryDraft({
        profileId: SEED.profileId,
        itemKind: 'MEDICINE',
        values: { displayName: 'Intruder Tablet (synthetic)' },
      }),
      randomUUID(),
    );

    expect(refused.kind).toBe('UNAVAILABLE');
  });

  it('rejects an unauthenticated write', async () => {
    const refused = await anonymous.createItem(
      manualEntryDraft({
        profileId: SEED.profileId,
        itemKind: 'MEDICINE',
        values: { displayName: 'Anonymous Tablet (synthetic)' },
      }),
      randomUUID(),
    );
    expect(refused.kind).toBe('UNAUTHENTICATED');
  });

  it('cannot be used to put anything into the shared catalog', async () => {
    // `15` A11 with the attacker replaced by an honest person mis-reading a label. The body has
    // no field for a catalog identifier, and the server's schema is strict - so an attempt is a
    // refusal rather than a key that is quietly ignored.
    const outcome = await owner.createItem(
      {
        profileId: SEED.profileId,
        itemKind: 'MEDICINE',
        displayName: 'Catalog Tablet (synthetic)',
        // A field no form offers and the body does not declare, sent deliberately.
        ...{ productIdentityId: '00000000-0000-4000-8000-000000000001' },
      },
      randomUUID(),
    );

    expect(outcome.kind).toBe('REFUSED');
  });
});

describe('changing an item, end to end', () => {
  /**
   * Stage 2's "update, archive, and review", through the code path the Expo screens use.
   *
   * The property worth proving over a real connection is the round trip: what the detail hands an
   * editor, sent back unchanged, is not a change. A prefill that got one field wrong would clear
   * a value the person never touched, the write would succeed, and nothing else would notice.
   */

  const freshMedicine = async (name: string): Promise<string> => {
    const created = await owner.createItem(
      manualEntryDraft({
        profileId: SEED.profileId,
        itemKind: 'MEDICINE',
        values: {
          displayName: name,
          brand: 'Synthetic Brand',
          strengthText: '500 mg',
          dosageForm: 'Tablet',
          market: 'GB',
          recordedGtin: '1234567890128',
          notes: 'The blue box.',
        },
      }),
      randomUUID(),
    );
    if (created.kind !== 'OK') throw new Error('expected the item to be created');
    return created.value.id;
  };

  it('hands an editor a prefill that saving back unchanged is not a change', async () => {
    const id = await freshMedicine('Editable Tablet (synthetic)');

    const detail = await owner.itemDetail(id);
    if (detail.kind !== 'OK') throw new Error('expected the detail to load');
    const view = itemDetailScreenView(detail.value);

    expect(view.mayEdit).toBe(true);
    expect(view.version).toBe(1);

    const unchanged = await owner.updateItem(id, {
      expectedVersion: view.version,
      ...detail.value.editableValues,
    });

    expect(unchanged.kind).toBe('REFUSED');
    if (unchanged.kind !== 'REFUSED') return;
    expect(unchanged.detail?.['reason_code']).toBe('no_change');
  });

  it('changes a field and shows it back', async () => {
    const id = await freshMedicine('Changed Tablet (synthetic)');

    const updated = await owner.updateItem(id, { expectedVersion: 1, strengthText: '250 mg' });
    expect(updated.kind).toBe('OK');
    if (updated.kind !== 'OK') return;
    expect(updated.value.version).toBe(2);
    expect(updated.value.changedFields).toEqual(['strengthText']);

    const detail = await owner.itemDetail(id);
    if (detail.kind !== 'OK') return;
    expect(itemDetailScreenView(detail.value).categoryFields.map((f) => f.value)).toContain(
      '250 mg',
    );
  });

  it('empties a field on request, and the detail says nobody entered it', async () => {
    // On an edit a blank field is "empty this", which is the only way to remove a value somebody
    // typed by mistake. Stored as an absence, so the detail reads "Not recorded".
    const id = await freshMedicine('Emptied Tablet (synthetic)');

    const updated = await owner.updateItem(id, { expectedVersion: 1, notes: null });
    expect(updated.kind).toBe('OK');

    const detail = await owner.itemDetail(id);
    if (detail.kind !== 'OK') return;
    const notes = itemDetailScreenView(detail.value).sharedFields.find(
      (field) => field.label === 'Your notes',
    );
    expect(notes?.value).toBeNull();
    expect(notes?.absentNote).not.toBeNull();
  });

  it('refuses a stale change and hands back the version to use', async () => {
    // `13` sets this entity's conflict policy to `ASK_USER`. A second editor is told rather than
    // overwritten, and the screen re-reads instead of retrying the same body.
    const id = await freshMedicine('Contested Tablet (synthetic)');

    const first = await owner.updateItem(id, { expectedVersion: 1, strengthText: '250 mg' });
    expect(first.kind).toBe('OK');

    const stale = await owner.updateItem(id, { expectedVersion: 1, strengthText: '100 mg' });
    expect(stale.kind).toBe('REFUSED');
    if (stale.kind !== 'REFUSED') return;

    expect(stale.code).toBe('VERSION_CONFLICT');
    expect(stale.detail?.['currentVersion']).toBe(2);
    expect(screenStateForFailure(stale)).toBe('RECOVERABLE_ERROR');

    // The first change stands.
    const detail = await owner.itemDetail(id);
    if (detail.kind !== 'OK') return;
    expect(detail.value.categoryFields.map((f) => f.value)).toContain('250 mg');
  });

  it('stops an item, and the shelf stops asking about it', async () => {
    // A shelf that kept nagging about packs somebody has finished with is the alarm optimisation
    // `02` refuses, and worse, it teaches people to ignore the list that matters.
    const id = await freshMedicine('Finished Tablet (synthetic)');

    const before = await owner.listItems({
      profileId: SEED.profileId,
      attention: 'NEEDS_VERIFICATION',
      limit: 100,
    });
    if (before.kind !== 'OK') throw new Error('expected the shelf to load');
    expect(before.value.items.map((item) => item.id)).toContain(id);

    const stopped = await owner.updateItem(id, {
      expectedVersion: 1,
      lifecycleState: 'STOPPED',
    });
    expect(stopped.kind).toBe('OK');

    const after = await owner.listItems({
      profileId: SEED.profileId,
      attention: 'NEEDS_VERIFICATION',
      limit: 100,
    });
    if (after.kind !== 'OK') throw new Error('expected the shelf to load');
    expect(after.value.items.map((item) => item.id)).not.toContain(id);
  });

  it('marks an item looked at without confirming anything about the product', async () => {
    // `08` reserves confirmation for something read off the pack. Looking at a record is not that,
    // and the copy on the control says so.
    const id = await freshMedicine('Checked Tablet (synthetic)');

    const reviewed = await owner.updateItem(id, { expectedVersion: 1, markReviewed: true });
    expect(reviewed.kind).toBe('OK');
    if (reviewed.kind !== 'OK') return;
    expect(reviewed.value.lastReviewedAt).not.toBeNull();

    const detail = await owner.itemDetail(id);
    if (detail.kind !== 'OK') return;
    expect(detail.value.attentionReasonCodes).not.toContain('NEVER_REVIEWED');
    // Three chips, all still unconfirmed.
    const view = itemDetailScreenView(detail.value);
    for (const chip of [view.identity, view.formulation, view.batch]) {
      expect(chip?.label).not.toMatch(/confirmed/i);
    }
  });

  it('tells a stranger nothing about an item they cannot reach', async () => {
    const id = await freshMedicine('Private Tablet (synthetic)');

    const refused = await stranger.updateItem(id, { expectedVersion: 1, strengthText: '250 mg' });
    expect(refused.kind).toBe('UNAVAILABLE');
  });

  it('rejects an unauthenticated change', async () => {
    const id = await freshMedicine('Anonymous Edit Tablet (synthetic)');

    const refused = await anonymous.updateItem(id, { expectedVersion: 1, strengthText: '250 mg' });
    expect(refused.kind).toBe('UNAUTHENTICATED');
  });

  it('cannot be used to claim a verification state', async () => {
    // `08`, and the same boundary creation keeps. The body has no field for it and the schema is
    // strict, so an attempt is a refusal rather than a key that is quietly ignored.
    const id = await freshMedicine('Unverifiable Tablet (synthetic)');

    const outcome = await owner.updateItem(id, {
      expectedVersion: 1,
      ...{ identityVerification: 'CONFIRMED' },
    });

    expect(outcome.kind).toBe('REFUSED');

    const detail = await owner.itemDetail(id);
    if (detail.kind !== 'OK') return;
    expect(itemDetailScreenView(detail.value).identity?.label).not.toMatch(/confirmed/i);
  });
});

describe('when Kynviora may interrupt somebody, end to end', () => {
  /**
   * `04` Phase 7.5's client half, through the code path the Expo screen uses.
   *
   * The domain, the route and the copy have all been tested since Phase 7.5. What had never been
   * exercised is the round trip a person actually makes: type a time, have it become minutes,
   * store it, and read it back as the same window. `setNotificationPolicy` had been on the client
   * since 7.5 with no caller anywhere, so nothing had ever run it against a real server.
   */

  /** The same client with step-up asserted. `14` puts this change behind confirming who you are. */
  const elevated = () => owner.withSession(developmentSession(SEED.userId, { stepUp: true }));

  it('turns a typed time into a stored window and reads it back the same', async () => {
    const window = quietHoursFromClock('22:00', '07:00');
    expect(window.ok).toBe(true);
    if (!window.ok || window.value === null) return;

    const saved = await elevated().setNotificationPolicy(SEED.profileId, {
      maxCaregiverDetail: 'GENERIC',
      quietHoursStartMinute: window.value.startMinute,
      quietHoursEndMinute: window.value.endMinute,
    });
    expect(saved.kind).toBe('OK');

    const read = await owner.notificationSettings(SEED.profileId);
    if (read.kind !== 'OK') throw new Error('expected the settings to load');

    const view = notificationPolicyView(read.value);
    expect(view.quietHours).toEqual(window.value);
    expect(view.quietHoursLabel).toBe('22:00 to 07:00');
    expect(view.quietHoursUnreadable).toBe(false);
    expect(view.mayChangePolicy).toBe(true);
  });

  it('says the window is not being applied yet', async () => {
    // `DEV-030` and `BLK-009`, on the screen where somebody sets it. Telling them nothing would
    // be letting them believe it works.
    const read = await owner.notificationSettings(SEED.profileId);
    if (read.kind !== 'OK') throw new Error('expected the settings to load');

    const view = notificationPolicyView(read.value);
    expect(view.quietHoursApplied).toBe(false);
    expect(read.value.quietHoursCopy['unknownLocalTime']).toContain('Nothing is being held back');
    // And the view hands the screen the sentence rather than leaving it to compose one.
    expect(view.limitationNote).toBe(read.value.quietHoursCopy['unknownLocalTime']);
  });

  it('clears the window when both fields are emptied', async () => {
    // Turning quiet hours off is emptying both fields, which the domain reads as no window and
    // the route stores as two nulls. There is no separate "off" state to get out of step.
    const cleared = quietHoursFromClock('', '');
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value).toBeNull();

    const saved = await elevated().setNotificationPolicy(SEED.profileId, {
      maxCaregiverDetail: 'GENERIC',
      quietHoursStartMinute: null,
      quietHoursEndMinute: null,
    });
    expect(saved.kind).toBe('OK');

    const read = await owner.notificationSettings(SEED.profileId);
    if (read.kind !== 'OK') throw new Error('expected the settings to load');

    const view = notificationPolicyView(read.value);
    expect(view.quietHours).toBeNull();
    expect(view.quietHoursLabel).toBeNull();
    expect(view.quietHoursUnreadable).toBe(false);
    expect(read.value.quietHoursCopy['notSet']).toContain('any time');
    // Still said with nothing set. Somebody about to set their first window is the person who
    // most needs to know it will not hold anything yet.
    expect(view.limitationNote).toContain('Nothing is being held back');
  });

  it('refuses the change without step-up', async () => {
    // `14`. The unelevated session is the one the app holds by default, so this is the path a
    // screen takes if it forgets to elevate - and it fails loudly rather than silently.
    const refused = await owner.setNotificationPolicy(SEED.profileId, {
      maxCaregiverDetail: 'GENERIC',
      quietHoursStartMinute: 22 * 60,
      quietHoursEndMinute: 7 * 60,
    });

    expect(refused.kind).toBe('STEP_UP_REQUIRED');
    expect(screenStateForFailure(refused as Exclude<typeof refused, { kind: 'OK' }>)).toBe(
      'STEP_UP_REQUIRED',
    );
  });

  it('tells a stranger nothing about the profile', async () => {
    const refused = await stranger.notificationSettings(SEED.profileId);
    expect(refused.kind).toBe('UNAVAILABLE');
  });

  it('reports what every urgency does, as phrases rather than codes', async () => {
    // Exit criterion 1 as the sentence a person reads: a foreign regulatory difference is
    // `INFORMATIONAL`, and `INFORMATIONAL` reaches no device at all.
    const read = await owner.notificationSettings(SEED.profileId);
    if (read.kind !== 'OK') throw new Error('expected the settings to load');

    const view = notificationPolicyView(read.value);
    expect(view.urgencyChannels.length).toBeGreaterThan(0);

    const informational = view.urgencyChannels.find((line) => line.urgency === 'INFORMATIONAL');
    expect(informational?.channelLabel).toBe('Kept in the app only');

    // No raw vocabulary member reaches a screen through this view.
    for (const line of view.urgencyChannels) {
      expect(line.channelLabel).not.toBe(line.urgency);
      expect(line.channelDescription.length).toBeGreaterThan(0);
    }
  });

  it('refuses a window the domain would not accept, before it reaches the server', () => {
    // The refusal names the field, so a form can point at it. Checked here because this is the
    // only layer that sees what somebody typed - the route takes minutes.
    for (const [start, end, field] of [
      ['22:00', '22:00', 'quietHoursEnd'],
      ['9:5', '07:00', 'quietHoursStart'],
      ['22:00', '', 'quietHoursEnd'],
      ['24:00', '07:00', 'quietHoursStart'],
    ] as const) {
      const result = quietHoursFromClock(start, end);
      expect(result.ok, `${start}-${end}`).toBe(false);
      if (!result.ok) expect(result.error.detail?.['field'], `${start}-${end}`).toBe(field);
    }
  });
});

describe('making a person, end to end', () => {
  /**
   * `04` Phase 1.2, through the code path the Expo screen uses.
   *
   * Until this phase nothing in the build could make a household or a profile - every one that
   * existed was seeded. What is exercised here is the round trip a person actually makes on their
   * first launch: name a household, name the first person in it, and find them in the list the
   * switcher renders from.
   */

  /** A key nobody has used before. One per create, except where a replay is the point. */
  const key = (): string => randomUUID();

  it('creates a household and the first person in it', async () => {
    const household = await owner.createHousehold({ displayName: 'The Nair household' }, key());
    if (household.kind !== 'OK') throw new Error('expected the household to be created');
    expect(household.value.displayName).toBe('The Nair household');

    const profile = await owner.createProfile(
      profileBodyFrom(household.value.id, {
        ...emptyProfileForm(),
        displayName: 'Amma',
        ageBand: 'OLDER_ADULT_65_PLUS',
        birthYear: '1958',
      }),
      key(),
    );
    if (profile.kind !== 'OK') throw new Error('expected the profile to be created');

    expect(profile.value.displayName).toBe('Amma');
    expect(profile.value.ageBand).toBe('OLDER_ADULT_65_PLUS');
    expect(profile.value.birthYear).toBe(1958);
    // Somebody they look after, because they did not say it was them.
    expect(profile.value.isSelf).toBe(false);
    expect(profile.value.isManaged).toBe(true);
  });

  it('offers the new person in the switcher, under their own name', async () => {
    // Phase 1.2's second exit criterion, through the view that decides it. The list is the
    // server's answer, and the switcher renders it rather than anything the client posted.
    const listed = await owner.listProfiles();
    if (listed.kind !== 'OK') throw new Error('expected the profiles to load');

    const amma = listed.value.profiles.find((profile) => profile.displayName === 'Amma');
    expect(amma).toBeDefined();
    if (amma === undefined) return;

    const view = profileSwitcherView(listed.value.profiles, amma.id);
    expect(view.activeId).toBe(amma.id);
    expect(view.activeName).toBe('Amma');
    expect(view.selectionDropped).toBe(false);
    // The band as a phrase. Never `OLDER_ADULT_65_PLUS` beside somebody's name (trap 129).
    expect(view.lines.find((line) => line.id === amma.id)?.ageLabel).toBe('65 or older');
  });

  it('adds a second person to the same household', async () => {
    // The switcher hands the screen a household rather than letting it make one. A family split
    // across two households would collect separate items and caregivers, and nothing merges them.
    const listed = await owner.listProfiles();
    if (listed.kind !== 'OK') throw new Error('expected the profiles to load');

    const view = profileSwitcherView(listed.value.profiles, null);
    expect(view.addToHouseholdId).not.toBeNull();
    if (view.addToHouseholdId === null) return;

    const second = await owner.createProfile(
      profileBodyFrom(view.addToHouseholdId, {
        ...emptyProfileForm(),
        displayName: 'Me',
        isSelf: true,
      }),
      key(),
    );
    if (second.kind !== 'OK') throw new Error('expected the second profile to be created');

    expect(second.value.householdId).toBe(view.addToHouseholdId);
    expect(second.value.isSelf).toBe(true);
    expect(second.value.isManaged).toBe(false);

    const after = await owner.listProfiles();
    if (after.kind !== 'OK') throw new Error('expected the profiles to load');
    const households = new Set(after.value.profiles.map((profile) => profile.householdId));
    expect(households.has(view.addToHouseholdId)).toBe(true);
  });

  it('makes one person when the same create arrives twice', async () => {
    const listed = await owner.listProfiles();
    if (listed.kind !== 'OK') throw new Error('expected the profiles to load');
    const household = profileSwitcherView(listed.value.profiles, null).addToHouseholdId;
    if (household === null) throw new Error('expected a household');

    const same = key();
    const body = profileBodyFrom(household, { ...emptyProfileForm(), displayName: 'Twice' });

    const first = await owner.createProfile(body, same);
    const second = await owner.createProfile(body, same);
    if (first.kind !== 'OK' || second.kind !== 'OK') throw new Error('expected both to succeed');

    expect(second.value.id).toBe(first.value.id);
    expect(second.value.replayed).toBe(true);

    const after = await owner.listProfiles();
    if (after.kind !== 'OK') throw new Error('expected the profiles to load');
    expect(after.value.profiles.filter((profile) => profile.displayName === 'Twice')).toHaveLength(
      1,
    );
  });

  it('refuses a household the caller does not own, and says nothing about it', async () => {
    // `profile_insert` decides this. A household this caller may not write to and one that does
    // not exist are the same answer, so the route is not an oracle for either.
    const refused = await stranger.createProfile(
      profileBodyFrom(SEED.householdId, { ...emptyProfileForm(), displayName: 'Sneaky' }),
      key(),
    );
    expect(refused.kind).toBe('UNAVAILABLE');
  });

  it('refuses what the domain would refuse, before it reaches the server', () => {
    // The refusal names the field, so the form can point at the control. Checked here because
    // this is the only layer that sees what somebody typed.
    for (const [values, field] of [
      [{ displayName: '   ' }, 'displayName'],
      [{ displayName: 'Amma', birthYear: '58' }, 'birthYear'],
      [{ displayName: 'Amma', ageBand: 'SENIOR' }, 'ageBand'],
      [{ displayName: 'Amma', languageTag: 'English' }, 'languageTag'],
    ] as const) {
      const refusal = profileFormRefusal({ ...emptyProfileForm(), ...values });
      expect(refusal?.field, JSON.stringify(values)).toBe(field);
    }
  });

  it('does not refuse an age range that disagrees with the year', () => {
    // A correctable mistake, and refusing would throw away the rest of what somebody typed. The
    // screen asks; the record accepts what they confirm.
    expect(
      profileFormRefusal({
        ...emptyProfileForm(),
        displayName: 'Amma',
        ageBand: 'UNDER_3',
        birthYear: '1958',
      }),
    ).toBeNull();
    expect(bandMatchesBirthYear('UNDER_3', 1958, 2026)).toBe(false);
  });

  it('tells a stranger nothing about anybody else’s people', async () => {
    const listed = await stranger.listProfiles();
    if (listed.kind !== 'OK') throw new Error('expected the profiles to load');
    expect(listed.value.profiles).toEqual([]);
    expect(profileSwitcherView(listed.value.profiles, SEED.profileId).selectionDropped).toBe(true);
  });
});

describe('what a household records about a person, end to end', () => {
  /**
   * `04` Phase 1.3, through the code path the Expo screen uses.
   *
   * Both exit criteria are asserted here as properties of the round trip rather than of a unit:
   * no client can name a provenance, and what comes back is a phrase a screen can render rather
   * than a code.
   */

  it('records a reaction and reads it back as sentences', async () => {
    const created = await owner.addHealthFact(SEED.profileId, {
      kind: 'ALLERGY',
      displayTerm: 'Penicillin',
      certainty: 'CONFIRMED',
      notedOn: '2019-04-02',
    });
    if (created.kind !== 'OK') throw new Error('expected the fact to be recorded');

    // Derived by the server from who is asking. There is no field on the body for it.
    expect(created.value.provenance).toBe('USER_REPORTED');

    const listed = await owner.healthFacts(SEED.profileId);
    if (listed.kind !== 'OK') throw new Error('expected the facts to load');

    const view = healthContextView(listed.value);
    const row = view.rows.find((line) => line.displayTerm === 'Penicillin');
    expect(row).toBeDefined();
    if (row === undefined) return;

    expect(row.kindLabel).toBe('Allergy');
    expect(row.certaintyLabel).toBe('I am sure');
    expect(row.provenanceLabel).toBe('You recorded this');
    // No raw vocabulary member reaches a screen through this view (trap 129).
    expect(JSON.stringify(row)).not.toContain('USER_REPORTED');
    expect(JSON.stringify(row)).not.toContain('ALLERGY');
  });

  it('reports why a term is unmatched, and it is the same reason for everything here', async () => {
    // `04` Phase 5.2. The mapping now happens at write time against the seeded vocabulary, and
    // this build seeds none - `08` makes a substance vocabulary a licensed artifact and `BLK-003`
    // says nobody has licensed one. So every record is `UNRESOLVED`, which is a gap with a name
    // rather than a feature that quietly does nothing.
    const listed = await owner.healthFacts(SEED.profileId);
    if (listed.kind !== 'OK') throw new Error('expected the facts to load');
    expect(listed.value.facts.length).toBeGreaterThan(0);

    for (const line of listed.value.facts) {
      expect(line.substanceMappingState, line.displayTerm).toBe('UNRESOLVED');
      expect(line.matchesCanonicalSubstance, line.displayTerm).toBe(false);
    }

    // And the row carries the sentence for a term nothing knows, not the one for an ambiguous
    // term - two different things to be told, and only one of them has a next step.
    for (const row of healthContextView(listed.value).rows) {
      expect(row.isAmbiguous, row.displayTerm).toBe(false);
      expect(row.matchNote, row.displayTerm).toMatch(/has not matched/i);
      expect(row.matchNote, row.displayTerm).not.toMatch(/more than one thing/i);
    }
  });

  it('re-resolves the mapping when somebody corrects the term', async () => {
    // A record whose wording changed while keeping the mapping the old wording earned would drive
    // a rule on a substance nobody typed. Both spellings are unmapped in this build, so what is
    // asserted here is that the round trip reports a state at all and that correcting a term does
    // not leave the field behind.
    const listed = await owner.healthFacts(SEED.profileId);
    if (listed.kind !== 'OK') throw new Error('expected the facts to load');
    const row = healthContextView(listed.value).rows[0];
    if (row === undefined) throw new Error('expected a record');

    const edited = await owner.updateHealthFact(row.id, {
      expectedVersion: row.version,
      displayTerm: `${row.displayTerm} (corrected)`,
    });
    if (edited.kind !== 'OK') throw new Error('expected the correction to be recorded');

    const after = await owner.healthFacts(SEED.profileId);
    if (after.kind !== 'OK') throw new Error('expected the facts to load');
    const refreshed = after.value.facts.find((line) => line.id === row.id);
    expect(refreshed?.substanceMappingState).toBe('UNRESOLVED');
    expect(refreshed?.matchesCanonicalSubstance).toBe(false);
  });

  it('says on the record that Kynviora cannot check anything against it yet', async () => {
    // `10`, and the common case: nothing in this build maps a typed term to a substance the
    // catalog knows, so a rule that matches on canonical substances cannot see it. Discovering
    // that through an alert that never arrives is the failure the sentence prevents.
    const listed = await owner.healthFacts(SEED.profileId);
    if (listed.kind !== 'OK') throw new Error('expected the facts to load');

    const view = healthContextView(listed.value);
    expect(view.unmatchedCount).toBeGreaterThan(0);
    for (const row of view.rows) {
      if (!row.matchesCanonicalSubstance) {
        expect(row.matchNote).toMatch(/cannot check/i);
        expect(row.matchNote).toMatch(/not lost/i);
      }
    }
  });

  it('has no way for a client to say where a fact came from', async () => {
    // Phase 1.3's first exit criterion, at the boundary. The body schema is `.strict()` and there
    // is no parameter the value could reach if it were not.
    const refused = await owner.addHealthFact(SEED.profileId, {
      kind: 'ALLERGY',
      displayTerm: 'Amoxicillin',
      provenance: 'REVIEWER_CONFIRMED',
    } as unknown as Parameters<typeof owner.addHealthFact>[1]);
    expect(refused.kind).toBe('REFUSED');

    const listed = await owner.healthFacts(SEED.profileId);
    if (listed.kind !== 'OK') throw new Error('expected the facts to load');
    for (const line of listed.value.facts) {
      expect(line.provenance).not.toBe('REVIEWER_CONFIRMED');
      expect(line.provenance).not.toBe('IMPORTED');
    }
  });

  it('refuses a kind rather than choosing one, and names the field', async () => {
    const refused = await owner.addHealthFact(SEED.profileId, {
      kind: 'INTOLERANCE',
      displayTerm: 'Latex',
    });
    expect(refused.kind).toBe('REFUSED');
    if (refused.kind !== 'REFUSED') return;
    expect(refused.detail?.['field']).toBe('kind');
  });

  it('marks a record as checked, and says so only after somebody did', async () => {
    const listed = await owner.healthFacts(SEED.profileId);
    if (listed.kind !== 'OK') throw new Error('expected the facts to load');

    const row = healthContextView(listed.value).rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    // A fact, not a nag (`02`).
    expect(row.reviewNote).toMatch(/nobody has checked/i);

    const reviewed = await owner.updateHealthFact(row.id, {
      expectedVersion: row.version,
      markReviewed: true,
    });
    if (reviewed.kind !== 'OK') throw new Error('expected the review to be recorded');
    expect(reviewed.value.lastReviewedAt).not.toBeNull();

    const after = await owner.healthFacts(SEED.profileId);
    if (after.kind !== 'OK') throw new Error('expected the facts to load');
    const refreshed = healthContextView(after.value).rows.find((line) => line.id === row.id);
    expect(refreshed?.reviewNote).toBeNull();
  });

  it('refuses a stale edit rather than letting it win', async () => {
    // `sync.ts` sets `allergy_record`'s conflict policy to `ASK_USER`. Losing a recorded allergy
    // to a stale offline edit is the case that policy exists for.
    const listed = await owner.healthFacts(SEED.profileId);
    if (listed.kind !== 'OK') throw new Error('expected the facts to load');
    const row = healthContextView(listed.value).rows[0];
    if (row === undefined) throw new Error('expected a record');

    const stale = await owner.updateHealthFact(row.id, {
      expectedVersion: row.version - 1,
      certainty: 'SUSPECTED',
    });
    expect(stale.kind).toBe('REFUSED');
    if (stale.kind !== 'REFUSED') return;
    expect(stale.detail?.['reason_code']).toBe('health_fact_version');
  });

  it('refuses a save that changed nothing, and says which refusal it is', async () => {
    const listed = await owner.healthFacts(SEED.profileId);
    if (listed.kind !== 'OK') throw new Error('expected the facts to load');
    const row = healthContextView(listed.value).rows[0];
    if (row === undefined) throw new Error('expected a record');

    const empty = await owner.updateHealthFact(row.id, { expectedVersion: row.version });
    expect(empty.kind).toBe('REFUSED');
    if (empty.kind !== 'REFUSED') return;
    // Told apart by the reason code rather than by message text (`13`), so a screen can show the
    // plain note instead of the panel a malformed date gets.
    expect(empty.detail?.['reason_code']).toBe('empty_change');
  });

  it('tells a stranger nothing about anybody’s health context', async () => {
    // An empty list rather than a refusal, which is what a profile with no records looks like -
    // so the route is not an oracle for either.
    const listed = await stranger.healthFacts(SEED.profileId);
    if (listed.kind !== 'OK') throw new Error('expected the facts to load');
    expect(listed.value.facts).toEqual([]);
    expect(healthContextView(listed.value).isEmpty).toBe(true);

    const refused = await stranger.addHealthFact(SEED.profileId, {
      kind: 'ALLERGY',
      displayTerm: 'Sneaky',
    });
    expect(refused.kind).toBe('UNAVAILABLE');
  });
});

describe('when a medicine is meant to be taken, end to end', () => {
  /**
   * `04` Phase 4.1's write path, through the code path the Expo screens use (`DEV-039`).
   *
   * The property worth proving over a real connection is the one no unit test on either side can:
   * that a schedule written by the client is a schedule the server stores, reads back and will
   * hand to Phase 4.2's reminder engine - and that a person who taps Save twice on a bad
   * connection ends up being reminded once.
   */

  const freshMedicine = async (name: string): Promise<string> => {
    const created = await owner.createItem(
      manualEntryDraft({
        profileId: SEED.profileId,
        itemKind: 'MEDICINE',
        values: { displayName: name, strengthText: '500 mg', dosageForm: 'Tablet' },
      }),
      randomUUID(),
    );
    if (created.kind !== 'OK') throw new Error('expected the item to be created');
    return created.value.id;
  };

  it('writes a twice-daily schedule and reads it back', async () => {
    const id = await freshMedicine('Scheduled Tablet (synthetic)');

    const created = await owner.createSchedule(
      id,
      { scheduleKind: 'FIXED_TIMES', timesLocal: ['20:00', '08:00'], timeZone: 'Asia/Kolkata' },
      randomUUID(),
    );
    expect(created.kind).toBe('OK');
    if (created.kind !== 'OK') return;

    // Ordered by the domain, so two ways of writing one schedule are one schedule.
    expect(created.value.schedule.timesLocal).toEqual(['08:00', '20:00']);
    expect(created.value.schedule.version).toBe(1);

    const listed = await owner.schedules(id);
    expect(listed.kind).toBe('OK');
    if (listed.kind !== 'OK') return;
    expect(listed.value.schedules.map((entry) => entry.id)).toEqual([created.value.schedule.id]);
  });

  it('gives one reminder to somebody who tapped Save twice', async () => {
    // The key is the caller's and is deliberately not regenerated, because a key regenerated on
    // retry is not an idempotency key. Two schedules here is not a duplicate row on a list - it
    // is being told twice, at the same minute, to take the same tablet.
    const id = await freshMedicine('Twice-Saved Tablet (synthetic)');
    const key = randomUUID();
    const body = {
      scheduleKind: 'FIXED_TIMES' as const,
      timesLocal: ['09:00'],
      timeZone: 'Asia/Kolkata',
    };

    const first = await owner.createSchedule(id, body, key);
    const second = await owner.createSchedule(id, body, key);
    expect(first.kind).toBe('OK');
    expect(second.kind).toBe('OK');

    const listed = await owner.schedules(id);
    if (listed.kind !== 'OK') return;
    expect(listed.value.schedules).toHaveLength(1);
  });

  it('refuses a stale edit rather than letting one carer overwrite another', async () => {
    const id = await freshMedicine('Contested Tablet (synthetic)');
    const created = await owner.createSchedule(
      id,
      { scheduleKind: 'FIXED_TIMES', timesLocal: ['08:00'], timeZone: 'Asia/Kolkata' },
      randomUUID(),
    );
    if (created.kind !== 'OK') return;
    const scheduleId = created.value.schedule.id;

    const moved = await owner.updateSchedule(scheduleId, {
      expectedVersion: 1,
      scheduleKind: 'FIXED_TIMES',
      timesLocal: ['09:00'],
      timeZone: 'Asia/Kolkata',
    });
    expect(moved.kind).toBe('OK');

    const stale = await owner.updateSchedule(scheduleId, {
      expectedVersion: 1,
      scheduleKind: 'FIXED_TIMES',
      timesLocal: ['22:00'],
      timeZone: 'Asia/Kolkata',
    });
    expect(stale.kind).toBe('REFUSED');
    if (stale.kind !== 'REFUSED') return;
    expect(stale.code).toBe('VERSION_CONFLICT');

    const listed = await owner.schedules(id);
    if (listed.kind !== 'OK') return;
    expect(listed.value.schedules[0]?.timesLocal).toEqual(['09:00']);
  });

  it('stops the reminders without losing the row a dose event points at', async () => {
    const id = await freshMedicine('Stopped Tablet (synthetic)');
    const created = await owner.createSchedule(
      id,
      { scheduleKind: 'FIXED_TIMES', timesLocal: ['08:00'], timeZone: 'Asia/Kolkata' },
      randomUUID(),
    );
    if (created.kind !== 'OK') return;

    const stopped = await owner.updateSchedule(created.value.schedule.id, {
      expectedVersion: 1,
      scheduleKind: 'FIXED_TIMES',
      timesLocal: ['08:00'],
      timeZone: 'Asia/Kolkata',
      active: false,
    });
    expect(stopped.kind).toBe('OK');

    // Still there and still listed, because a dose event references the schedule it was recorded
    // against and a person deciding what to change needs to see the course they stopped.
    const listed = await owner.schedules(id);
    if (listed.kind !== 'OK') return;
    expect(listed.value.schedules).toHaveLength(1);
    expect(listed.value.schedules[0]?.active).toBe(false);
  });

  it('says nothing about a medicine belonging to somebody else', async () => {
    const id = await freshMedicine('Private Tablet (synthetic)');
    await owner.createSchedule(
      id,
      { scheduleKind: 'FIXED_TIMES', timesLocal: ['08:00'], timeZone: 'Asia/Kolkata' },
      randomUUID(),
    );

    // An empty list rather than a refusal - the same answer a medicine with no schedule gives.
    const seen = await stranger.schedules(id);
    expect(seen.kind).toBe('OK');
    if (seen.kind !== 'OK') return;
    expect(seen.value.schedules).toEqual([]);

    // `UNAVAILABLE`, not `REFUSED`. There is deliberately no outcome in this API meaning "you are
    // not allowed" (trap 89): a 404 reaches the client as the same absence an unknown medicine
    // gives, so a screen cannot accidentally confirm that somebody else's medicine exists.
    const written = await stranger.createSchedule(
      id,
      { scheduleKind: 'FIXED_TIMES', timesLocal: ['08:00'], timeZone: 'Asia/Kolkata' },
      randomUUID(),
    );
    expect(written.kind).toBe('UNAVAILABLE');
  });

  it('refuses an as-needed medicine a time to be reminded at', async () => {
    // `04` Phase 4.1 separates as-needed from fixed reminders, and `18` is why: a reminder about
    // something taken only when needed is nagging somebody about a decision they have not made.
    const id = await freshMedicine('As-Needed Tablet (synthetic)');
    const refused = await owner.createSchedule(
      id,
      { scheduleKind: 'AS_NEEDED', timesLocal: ['08:00'], timeZone: 'Asia/Kolkata' },
      randomUUID(),
    );
    expect(refused.kind).toBe('REFUSED');
    if (refused.kind !== 'REFUSED') return;
    expect(refused.detail?.['field']).toBe('timesLocal');
  });
});

describe('what you have agreed to, end to end', () => {
  /**
   * `04` Phase 1.4, through the code path the Expo screen uses.
   *
   * The enforcement half - a withdrawal actually stopping a notification - is asserted in
   * `consent.test.ts`, because `dispatchAlert` is a function rather than a route (`BLK-009`) and
   * driving it needs the database rather than the client. What is asserted **here** is everything
   * that reaches a person: that the screen renders sentences rather than codes, that a withdrawal
   * is a new receipt rather than an edited one, and that nobody sees or answers for anybody else.
   */

  it('renders every purpose as a sentence, never as a code', async () => {
    const listed = await owner.consents();
    if (listed.kind !== 'OK') throw new Error('expected the consents to load');

    const view = consentView(listed.value);
    expect(view.rows).toHaveLength(CONSENT_PURPOSES.length);
    expect(view.policyVersion).toBe(CONSENT_POLICY_VERSION);

    for (const row of view.rows) {
      expect(row.label, row.purpose).not.toMatch(/_/);
      expect(row.description.length, row.purpose).toBeGreaterThan(0);
      // The sentence a person reads before pressing. Never empty, on any row (trap 109).
      expect(row.withdrawalEffect.length, row.purpose).toBeGreaterThan(0);
    }
  });

  it('says which switches actually stop something, and the server is what says it', async () => {
    // The screen does not infer this. A purpose that becomes enforceable is described correctly
    // without anybody remembering to edit a client - and until then nobody is offered a switch
    // they believe does something (`10`).
    const listed = await owner.consents();
    if (listed.kind !== 'OK') throw new Error('expected the consents to load');

    for (const line of listed.value.consents) {
      if (!isConsentPurpose(line.purpose)) throw new Error('unknown purpose on the wire');
      expect(line.enforcement, line.purpose).toBe(consentEnforcement(line.purpose));
    }

    const view = consentView(listed.value);
    const enforcing = view.rows.filter((row) => row.enforcesSomething).map((row) => row.purpose);
    expect([...enforcing].sort()).toEqual(['CAREGIVER_SHARING', 'NOTIFICATIONS']);
    // And the other five say so on their own row rather than in a footnote.
    expect(view.notYetCount).toBe(5);
    for (const row of view.rows) {
      if (row.mayChoose && !row.enforcesSomething) {
        expect(row.notYetNote, row.purpose).toBe(CONSENT_COPY.notYetNote);
      }
    }
  });

  it('treats never having answered as not agreed, and says so', async () => {
    // Deny by default (`14`). A stranger has never answered anything, which is the state every
    // account starts in - and silence must never read as agreement.
    const listed = await stranger.consents();
    if (listed.kind !== 'OK') throw new Error('expected the consents to load');

    for (const row of consentView(listed.value).rows) {
      expect(row.granted, row.purpose).toBe(false);
      expect(row.neverAnsweredNote, row.purpose).toBe(CONSENT_COPY.neverAnsweredNote);
    }
  });

  it('records a decision and reads it back as what is in force', async () => {
    const recorded = await owner.recordConsent({ purpose: 'NOTIFICATIONS', granted: true });
    if (recorded.kind !== 'OK') throw new Error('expected the decision to be recorded');

    // The policy version is the server's. There is no field for it on the body.
    expect(recorded.value.policyVersion).toBe(CONSENT_POLICY_VERSION);
    expect(recorded.value.enforcement).toBe('ENFORCED');

    const listed = await owner.consents();
    if (listed.kind !== 'OK') throw new Error('expected the consents to load');
    const row = consentView(listed.value).rows.find((line) => line.purpose === 'NOTIFICATIONS');
    expect(row?.granted).toBe(true);
    // Having answered is not the same as never having answered, whichever way they answered.
    expect(row?.neverAnsweredNote).toBeNull();
    // The control now names what pressing it would do next.
    expect(row?.actionLabel).toBe(CONSENT_COPY.withdrawLabel);
  });

  it('withdraws by writing a new receipt, never by changing the old one', async () => {
    const granted = await owner.recordConsent({ purpose: 'CAREGIVER_SHARING', granted: true });
    if (granted.kind !== 'OK') throw new Error('expected the grant to be recorded');

    const withdrawn = await owner.recordConsent({ purpose: 'CAREGIVER_SHARING', granted: false });
    if (withdrawn.kind !== 'OK') throw new Error('expected the withdrawal to be recorded');
    expect(withdrawn.value.granted).toBe(false);

    // The two are separate rows recorded at separate moments, which is what makes the history
    // auditable rather than a single mutable flag. `consent_receipt` refuses UPDATE and DELETE to
    // every role including the owner, so nothing here could have rewritten the first.
    expect(withdrawn.value.recordedAt).not.toBe(granted.value.recordedAt);

    const listed = await owner.consents();
    if (listed.kind !== 'OK') throw new Error('expected the consents to load');
    const row = consentView(listed.value).rows.find((line) => line.purpose === 'CAREGIVER_SHARING');
    // The newest answer stands, and it is the withdrawal.
    expect(row?.granted).toBe(false);
    expect(row?.actionLabel).toBe(CONSENT_COPY.grantLabel);
  });

  it('lets somebody change their mind back', async () => {
    const again = await owner.recordConsent({ purpose: 'CAREGIVER_SHARING', granted: true });
    if (again.kind !== 'OK') throw new Error('expected the grant to be recorded');

    const listed = await owner.consents();
    if (listed.kind !== 'OK') throw new Error('expected the consents to load');
    const row = consentView(listed.value).rows.find((line) => line.purpose === 'CAREGIVER_SHARING');
    expect(row?.granted).toBe(true);
  });

  it('offers no control for the one the product cannot run without, and refuses it besides', async () => {
    const listed = await owner.consents();
    if (listed.kind !== 'OK') throw new Error('expected the consents to load');
    const row = consentView(listed.value).rows.find((line) => line.purpose === 'PROFILE_DATA');

    // No button on the screen, and no route behind one either. A control whose only outcome is a
    // refusal is a control that should not be offered (DEC-045), and both halves say the same.
    expect(row?.mayChoose).toBe(false);
    expect(row?.actionLabel).toBeNull();
    expect(row?.statusLabel).toBe(CONSENT_COPY.requiredLabel);

    const refused = await owner.recordConsent({ purpose: 'PROFILE_DATA', granted: false });
    expect(refused.kind).toBe('REFUSED');
    if (refused.kind !== 'REFUSED') return;
    expect(refused.detail?.['reason_code']).toBe('consent_required');
  });

  it('refuses a purpose it does not know rather than storing it', async () => {
    // A receipt naming a purpose nothing can enforce is a record of agreement to something
    // undefined, which is worse than no record.
    const refused = await owner.recordConsent({ purpose: 'SELL_MY_DATA', granted: true });
    expect(refused.kind).toBe('REFUSED');
    if (refused.kind !== 'REFUSED') return;
    expect(refused.detail?.['field']).toBe('purpose');

    const listed = await owner.consents();
    if (listed.kind !== 'OK') throw new Error('expected the consents to load');
    expect(JSON.stringify(listed.value)).not.toContain('SELL_MY_DATA');
  });

  it('has no field for a user, a policy version or a time', async () => {
    // The audit trail must not be written by the thing being audited. The body schema is
    // `.strict()` and there is no parameter any of these could reach if it were not.
    for (const extra of [
      { userId: STRANGER },
      { policyVersion: '1999-01-01.1' },
      { recordedAt: '1999-01-01T00:00:00.000Z' },
    ]) {
      // No cast: a spread is not excess-property checked, so this is exactly the body a client
      // could send by accident. The server refuses it because the schema is `.strict()`.
      const refused = await owner.recordConsent({
        purpose: 'RESEARCH_PROGRAMME',
        granted: true,
        ...extra,
      });
      expect(refused.kind, JSON.stringify(extra)).toBe('REFUSED');
    }

    const listed = await owner.consents();
    if (listed.kind !== 'OK') throw new Error('expected the consents to load');
    const row = listed.value.consents.find((line) => line.purpose === 'RESEARCH_PROGRAMME');
    // Nothing was written by any of those attempts.
    expect(row?.everAnswered).toBe(false);
    expect(row?.policyVersion).toBeNull();
  });

  it('shows one person nothing of what anybody else answered', async () => {
    // `consent_select` requires the row to be the caller's own, so consent is the one thing in
    // this product nobody may read on somebody else's behalf - not even a profile owner for a
    // caregiver, and not the seeded owner for a stranger.
    const mine = await owner.consents();
    const theirs = await stranger.consents();
    if (mine.kind !== 'OK' || theirs.kind !== 'OK') throw new Error('expected both to load');

    const answered = (response: typeof mine.value) =>
      response.consents.filter((line) => line.everAnswered).map((line) => line.purpose);

    expect(answered(mine.value).length).toBeGreaterThan(0);
    // The stranger has answered nothing, and the owner's answers do not appear under their name.
    expect(answered(theirs.value)).toEqual([]);
  });

  it('tells a caller with no session nothing at all', async () => {
    // `UNAUTHENTICATED` rather than a refusal naming a purpose. Nothing about consent is readable
    // or answerable without a session, and the answer does not vary by what was asked for.
    expect((await anonymous.consents()).kind).toBe('UNAUTHENTICATED');
    const refused = await anonymous.recordConsent({ purpose: 'NOTIFICATIONS', granted: true });
    expect(refused.kind).toBe('UNAUTHENTICATED');
  });

  it('never puts a code where a sentence belongs, anywhere in the rendered view', async () => {
    const listed = await owner.consents();
    if (listed.kind !== 'OK') throw new Error('expected the consents to load');

    const rendered = JSON.stringify(
      consentView(listed.value).rows.map((row) => ({
        label: row.label,
        description: row.description,
        withdrawalEffect: row.withdrawalEffect,
        statusLabel: row.statusLabel,
        actionLabel: row.actionLabel,
        notYetNote: row.notYetNote,
        neverAnsweredNote: row.neverAnsweredNote,
        staleNote: row.staleNote,
      })),
    );
    for (const purpose of CONSENT_PURPOSES) {
      expect(rendered, purpose).not.toContain(purpose);
    }
  });
});
