import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, type MainConfig, type StartedServer } from './main.js';
import { SEED } from '@kynviora/db';
import { noopLogger } from '@kynviora/domain';
import { DEV_USER_HEADER } from './devAuth.js';

/**
 * The API process, started for real.
 *
 * Every other suite drives `createServer` in memory, which proves the routes and proves nothing
 * about whether the thing can be run. This one boots a process against a persisted database on a
 * real port and asks it the questions a developer asks on their first afternoon: does it start,
 * does it refuse me when I am nobody, does it show me my own shelf, and does it show me somebody
 * else's.
 *
 * The last question is the one worth having a process test for. The in-memory suites inject a
 * pool; here the role switching, the request GUC and the row-level security policies are all doing
 * their real jobs against a real engine, and a mistake in the wiring between them would pass every
 * other test in the repository.
 */

const STRANGER = '00000000-0000-4000-8000-0000000009ff';

const started: StartedServer[] = [];
const dataDirs: string[] = [];

/**
 * Each server gets its own directory and port: PGlite is a single writer (see `db/src/seed.ts`),
 * and `port: 0` lets the OS pick so several can run at once.
 *
 * Starting one costs a PGlite instance and thirteen migrations, so the read-only tests share
 * {@link shared} and only the tests that need a different configuration start their own.
 */
async function startServer(overrides: Partial<MainConfig> = {}): Promise<StartedServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'kynviora-main-'));
  dataDirs.push(dataDir);
  const server = await start(
    {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      devAuth: true,
      seed: true,
      allowAnonymousStart: false,
      ...overrides,
    },
    { logger: noopLogger() },
  );
  started.push(server);
  return server;
}

/** One seeded server, shared by every test that only reads. */
let shared: StartedServer;

beforeAll(async () => {
  shared = await startServer();
});

afterAll(async () => {
  for (const server of started) await server.stop();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});

async function get(server: StartedServer, path: string, userId?: string) {
  const headers = userId === undefined ? {} : { [DEV_USER_HEADER]: userId };
  const response = await fetch(`${server.url}${path}`, { headers });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('the process starts and serves', () => {
  it('comes up, migrates and answers a health check', async () => {
    const response = await fetch(`${shared.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('refuses to start with no authenticator and no acknowledgement', async () => {
    // A server that authenticates nobody serves nobody, and it fails in a way that looks like a
    // bug in every route. Say which it is, at startup, once.
    await expect(startServer({ devAuth: false, allowAnonymousStart: false })).rejects.toThrow(
      /No authenticator is configured/,
    );
  });

  it('starts with no authenticator when that is stated explicitly', async () => {
    const server = await startServer({ devAuth: false, allowAnonymousStart: true, seed: false });
    // It comes up, and it rejects every authenticated request, which is what was asked for.
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
    expect((await get(server, '/v1/profiles')).status).toBe(401);
  });
});

describe('the authorization boundary, against a real engine', () => {
  it('rejects an unauthenticated request', async () => {
    expect((await get(shared, '/v1/profiles')).status).toBe(401);
  });

  it('shows the seeded owner their own profile and shelf', async () => {
    const profiles = await get(shared, '/v1/profiles', SEED.userId);
    expect(profiles.status).toBe(200);
    expect(profiles.body.profiles).toHaveLength(1);

    const items = await get(shared, `/v1/items?profileId=${SEED.profileId}`, SEED.userId);
    expect(items.status).toBe(200);
    expect(items.body.items).toHaveLength(3);
  });

  it('shows a stranger an empty page rather than a refusal', async () => {
    // Phase 8.1's exit criterion in terms: a caller without access "sees an empty page - not a
    // 403". 200-with-nothing is the designed answer, and it is row-level security producing it
    // rather than a check in a handler.
    const items = await get(shared, `/v1/items?profileId=${SEED.profileId}`, STRANGER);
    expect(items.status).toBe(200);
    expect(items.body.items).toEqual([]);

    const profiles = await get(shared, '/v1/profiles', STRANGER);
    expect(profiles.body.profiles).toEqual([]);
  });

  it('gives the seeded owner no staff access at all', async () => {
    // The property that makes the development authenticator acceptable. A header is a client
    // claim, `14` says reviewer roles are not inferred from one, and the reviewer console requires
    // a row in `reviewer` that the seed deliberately does not create.
    expect((await get(shared, '/v1/reviewer/queue', SEED.userId)).status).toBe(404);
    expect((await get(shared, '/v1/reviewer/queue', STRANGER)).status).toBe(404);
  });
});

describe('the development seed', () => {
  it('is idempotent across restarts of the same database', async () => {
    // PGlite is a single writer, so the seed runs inside the process. Restarting must not
    // duplicate the household or fail on the primary key.
    const dataDir = mkdtempSync(join(tmpdir(), 'kynviora-seed-'));
    dataDirs.push(dataDir);

    const config: MainConfig = {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      devAuth: true,
      seed: true,
      allowAnonymousStart: false,
    };

    const first = await start(config, { logger: noopLogger() });
    const before = await get(first, `/v1/items?profileId=${SEED.profileId}`, SEED.userId);
    expect(before.body.items).toHaveLength(3);
    await first.stop();

    const second = await start(config, { logger: noopLogger() });
    started.push(second);
    const after = await get(second, `/v1/items?profileId=${SEED.profileId}`, SEED.userId);
    expect(after.body.items).toHaveLength(3);
  });

  it('seeds no safety or regulatory content', async () => {
    // Publishing either needs a qualified reviewer (`BLK-006`) and retrieved official documents
    // (`BLK-004`). An empty Safety screen against this fixture is the correct result, and seeding
    // something to make the screen look populated would put exactly the content in front of a
    // developer that the governance layers exist to keep out.
    const alerts = await get(shared, `/v1/alerts?profileId=${SEED.profileId}`, SEED.userId);
    expect(alerts.status).toBe(200);
    expect(alerts.body.alerts).toEqual([]);
  });
});
