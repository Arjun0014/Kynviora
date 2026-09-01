import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, type StartedServer } from './main.js';
import { SEED } from '@kynviora/db';
import { noopLogger } from '@kynviora/domain';
import {
  ANONYMOUS,
  createClient,
  developmentSession,
  resourceFor,
  reviewInboxView,
  safetyView,
  shelfView,
  type KynvioraClient,
} from '@kynviora/contracts';
import { SCREEN_STATE_PRESENTATION } from '@kynviora/presentation';

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
  it('will not put a credential in a URL', async () => {
    // `13` and trap 11. The refusal happens before the request leaves, so there is no version of
    // this that reaches a server log.
    const client = createClient({
      config: { baseUrl: server.url, timeoutMs: 1000 },
      session: developmentSession(SEED.userId),
    });
    // `listCaregiverGrants` takes a profile ID; there is deliberately no client method that
    // accepts a token as a query parameter, so the guard is asserted at its own level.
    expect(typeof client.listCaregiverGrants).toBe('function');

    const { buildUrl } = await import('@kynviora/contracts');
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
