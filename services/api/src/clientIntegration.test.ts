import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, type StartedServer } from './main.js';
import { SEED } from '@kynviora/db';
import { noopLogger } from '@kynviora/domain';
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
  contentChanged,
  accessHistory,
  accessList,
  buildRevocation,
  heldCapabilities,
  inviterAuthority,
  mayInvite,
  refreshedResource,
  revocationMessage,
  reviewInboxView,
  safetyView,
  selectableCapabilities,
  shelfView,
  type DigestFn,
  type KynvioraClient,
} from '@kynviora/contracts';
import { REVOCATION_COPY, SCREEN_STATE_PRESENTATION } from '@kynviora/presentation';

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

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'kynviora-client-'));
  server = await start(
    {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      devAuth: true,
      seed: true,
      allowAnonymousStart: false,
    },
    { logger: noopLogger() },
  );

  const config = { baseUrl: server.url, timeoutMs: 10_000 };
  owner = createClient({ config, session: developmentSession(SEED.userId) });
  stranger = createClient({ config, session: developmentSession(STRANGER) });
  anonymous = createClient({ config, session: ANONYMOUS });
});

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

    const field = read.value.differences.find((entry) => entry.kind === 'FIELD_DIFFERS');
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
